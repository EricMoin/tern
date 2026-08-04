//! tern-node — napi binding between Deno/Node.js and tern-core.
//!
//! This is the layer the JS reconciler (`packages/core`) talks to. It exposes
//! two surfaces:
//!
//! * **`TuiRenderer`** — owns the terminal lifecycle (raw mode + alternate
//!   screen via tern-terminal, skippable with `use_alt_screen` for inline
//!   rendering), the scene, and the render loop: `root()` returns a handle to
//!   the scene root, `start_event_stream(callback)` pushes terminal events
//!   (keys, resizes, focus changes, mouse, and paste) to the JS thread
//!   through a napi `ThreadsafeFunction` fed by tern-terminal's background
//!   event loop, `render()` paints the scene to the terminal,
//!   `set_title(title)` sets the terminal window title, `capabilities`
//!   reports the detected color support, and `destroy()` tears the terminal
//!   state back down. The pull-based `poll_events` fallback remains
//!   available behind the `poll-fallback` cargo feature (default build ships
//!   push delivery).
//! * **Scene construction** — `create_node(type, props)` builds a node
//!   handle (backed by the tern-components node model), and `NodeHandle`
//!   methods (`add_child` / `remove` / `set_props`) mutate the shared scene
//!   tree that `TuiRenderer::render` paints.
//!
//! ## Scene ownership
//!
//! The binding keeps **one module-global scene** (`shared_scene()`): both
//! `create_node` (module-level) and every `TuiRenderer` operate on the same
//! tree. This mirrors the architecture doc — `tern-node` is the single bridge
//! into the tern-core scene tree, and the MVP JS reconciler drives exactly one
//! renderer. Multiple renderers would render the same scene; creating more
//! than one is documented as out of scope for the MVP.
//!
//! All shared state lives behind `Arc<Mutex<_>>`, which keeps the napi class
//! instances `Send + Sync` (required by napi-rs) and makes every method safe
//! to call from the JS thread.
//!
//! ## Event delivery
//!
//! With the default `push-events` feature, [`TuiRenderer::start_event_stream`]
//! builds a `ThreadsafeFunction<TernEventJs>` from the JS callback and spawns
//! tern-terminal's event loop thread, which pushes every normalized event to
//! the JS thread (unbounded queue — no event loss, no polling loop in the JS
//! hot path). The loop stops when the renderer is destroyed, when a ctrl+c
//! teardown is requested (`exit_on_ctrl_c`), or when the JS side releases the
//! stream. With `exit_on_ctrl_c`, a Ctrl+C press is still delivered to JS so
//! push-mode consumers observe it, and the renderer is torn down + marked
//! destroyed right after. With the `poll-fallback` feature instead,
//! `poll_events(timeout_ms)` returns event batches on demand (the pre-Phase-3
//! pull path, for hosts that cannot host a napi JS thread).

use std::collections::HashMap;
#[cfg(feature = "push-events")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(feature = "poll-fallback")]
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[cfg(feature = "push-events")]
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

use tern_components::Compositor;
use tern_core::buffer::{diff, Buffer};
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene, Span};
use tern_core::style::{BorderStyle, Modifiers, Style};
use tern_core::{Color, Size};
use tern_terminal::backend::Backend;
#[cfg(feature = "poll-fallback")]
use tern_terminal::event as event_module;
use tern_terminal::event::KeyName;
#[cfg(feature = "push-events")]
use tern_terminal::event::{spawn_event_loop, EventLoopHandle};
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
use tern_terminal::event::{MouseButton, MouseEventKind, TernEvent, TernKey, TernMouse};

/// The one module-global scene tree. Both node construction and rendering
/// operate on it (see module docs for the ownership rationale).
fn shared_scene() -> &'static Arc<Mutex<Scene>> {
    static SCENE: OnceLock<Arc<Mutex<Scene>>> = OnceLock::new();
    SCENE.get_or_init(|| Arc::new(Mutex::new(Scene::new())))
}

/// The last viewport the shared scene was laid out at — the terminal size the
/// most recent [`TuiRenderer::render`] used. `NodeHandle::content_size` lays
/// the scene out at this viewport so its geometry matches what is on screen;
/// before any render it defaults to 80x24.
fn shared_viewport_ref() -> &'static Mutex<(u32, u32)> {
    static VIEWPORT: OnceLock<Mutex<(u32, u32)>> = OnceLock::new();
    VIEWPORT.get_or_init(|| Mutex::new((80, 24)))
}

/// Convert a painted buffer to one string per row, mapping masked
/// continuation cells (the zero-width right halves of wide glyphs) to spaces
/// so every row has exactly `buffer.width` display columns. Multi-width
/// aware by construction: a wide character occupies its lead cell plus the
/// masked neighbor, so the row string keeps the buffer's true display
/// width.
fn buffer_rows(buffer: &Buffer) -> Vec<String> {
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| {
                    buffer
                        .cell(x, y)
                        .map(|cell| if cell.is_masked() { ' ' } else { cell.ch })
                        .unwrap_or(' ')
                })
                .collect()
        })
        .collect()
}

/// Paint `scene` at `viewport` and return the frame as one string per row
/// (see [`buffer_rows`]). Performs no terminal I/O — the pure snapshot both
/// [`TuiRenderer::render_to_buffer`] and its unit test use, so the tested
/// path is the shipped path.
fn paint_scene_rows(scene: &Scene, viewport: Size) -> Vec<String> {
    let buffer = Compositor::new().paint_scene(scene, viewport);
    buffer_rows(&buffer)
}

/// The laid-out content size of a scene node, in cells.
#[napi(object)]
pub struct ContentSize {
    /// The content width in cells.
    pub width: u32,
    /// The content height in cells.
    pub height: u32,
}

/// One token-highlighted span: the chunk's text plus the style keys lifted
/// from the highlight style (`fg` as a `"#rrggbb"` hex string, and the boolean
/// modifiers). The shape mirrors `Span` (the `append_span` style-key
/// convention), so a JS consumer can feed a highlighted span straight into a
/// `streaming_text` node.
#[napi(object)]
#[derive(Debug)]
pub struct HighlightSpanJs {
    /// The span's text content.
    pub text: String,
    /// The foreground color as `"#rrggbb"`, when the token carries one.
    pub fg: Option<String>,
    /// Whether the token is bold.
    pub bold: bool,
    /// Whether the token is italic.
    pub italic: bool,
    /// Whether the token is dim.
    pub dim: bool,
    /// Whether the token is underlined.
    pub underline: bool,
}

/// A key event surfaced to JS as a plain object: `{ name, char, ctrl, alt,
/// shift }`. `char` is the printable character for `"char"`-named keys
/// (single-character string), `undefined` for named keys.
#[napi(object)]
pub struct KeyEvent {
    /// The key's name: `char`, `enter`, `escape`, `backspace`, `tab`,
    /// `backtab`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`,
    /// `up`, `down`, `left`, `right`, `f<n>`, `null`, `unknown`.
    pub name: String,
    /// The printable character for `"char"` keys.
    pub char: Option<String>,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl KeyEvent {
    fn from_tern(key: TernKey) -> Self {
        Self {
            name: key_name_str(key.name),
            char: key.char.map(|c| c.to_string()),
            ctrl: key.ctrl,
            alt: key.alt,
            shift: key.shift,
        }
    }
}

/// A mouse event surfaced to JS as a plain object.
///
/// `kind` encodes both the action and — where relevant — the button, so no
/// button information is lost: `"down_left"`, `"up_right"`,
/// `"drag_middle"`, `"moved"`, `"scroll_up"`, `"scroll_down"`,
/// `"scroll_left"`, `"scroll_right"`. `column` / `row` are the cell the
/// event occurred on (0-based); `ctrl` / `alt` / `shift` are the held
/// modifiers.
#[napi(object)]
pub struct MouseEventJs {
    /// The action + button, e.g. `"down_left"`, `"up_right"`,
    /// `"drag_middle"`, `"moved"`, `"scroll_up"`.
    pub kind: String,
    /// The column the event occurred on (0-based).
    pub column: u16,
    /// The row the event occurred on (0-based).
    pub row: u16,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl MouseEventJs {
    fn from_tern(mouse: TernMouse) -> Self {
        let kind = match mouse.kind {
            MouseEventKind::Down(button) => format!("down_{}", mouse_button_str(button)),
            MouseEventKind::Up(button) => format!("up_{}", mouse_button_str(button)),
            MouseEventKind::Drag(button) => format!("drag_{}", mouse_button_str(button)),
            MouseEventKind::Moved => "moved".to_string(),
            MouseEventKind::ScrollDown => "scroll_down".to_string(),
            MouseEventKind::ScrollUp => "scroll_up".to_string(),
            MouseEventKind::ScrollLeft => "scroll_left".to_string(),
            MouseEventKind::ScrollRight => "scroll_right".to_string(),
        };
        Self {
            kind,
            column: mouse.column,
            row: mouse.row,
            ctrl: mouse.ctrl,
            alt: mouse.alt,
            shift: mouse.shift,
        }
    }
}

/// The JS-facing name of a mouse button.
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
fn mouse_button_str(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// A terminal event surfaced to JS as a tagged-union plain object: `type`
/// discriminates (`"key"`, `"resize"`, `"focus"`, `"mouse"`, `"paste"`) and
/// exactly one of `key` / `width`+`height` / `focus_gained` / `mouse` /
/// `paste` is set. For `"focus"`, `focus_gained` is `true` on gained and
/// `false` on lost.
#[napi(object)]
pub struct TernEventJs {
    /// The event kind: `"key"`, `"resize"`, `"focus"`, `"mouse"`, or
    /// `"paste"`.
    #[napi(js_name = "type")]
    pub r#type: String,
    /// The key event, when `type` is `"key"`.
    pub key: Option<KeyEvent>,
    /// The new width in columns, when `type` is `"resize"`.
    pub width: Option<u16>,
    /// The new height in rows, when `type` is `"resize"`.
    pub height: Option<u16>,
    /// Whether focus was gained (`true`) or lost (`false`), when `type` is
    /// `"focus"`.
    #[napi(js_name = "focus_gained")]
    pub focus_gained: Option<bool>,
    /// The mouse event, when `type` is `"mouse"`.
    pub mouse: Option<MouseEventJs>,
    /// The pasted text, when `type` is `"paste"`.
    pub paste: Option<String>,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl TernEventJs {
    fn from_tern(ev: TernEvent) -> Self {
        match ev {
            TernEvent::Key(key) => Self {
                r#type: "key".to_string(),
                key: Some(KeyEvent::from_tern(key)),
                width: None,
                height: None,
                focus_gained: None,
                mouse: None,
                paste: None,
            },
            TernEvent::Resize { w, h } => Self {
                r#type: "resize".to_string(),
                key: None,
                width: Some(w),
                height: Some(h),
                focus_gained: None,
                mouse: None,
                paste: None,
            },
            TernEvent::FocusGained => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(true),
                mouse: None,
                paste: None,
            },
            TernEvent::FocusLost => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(false),
                mouse: None,
                paste: None,
            },
            TernEvent::Mouse(mouse) => Self {
                r#type: "mouse".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: None,
                mouse: Some(MouseEventJs::from_tern(mouse)),
                paste: None,
            },
            TernEvent::Paste(text) => Self {
                r#type: "paste".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: None,
                mouse: None,
                paste: Some(text),
            },
        }
    }
}

/// Constructor options for [`TuiRenderer`].
#[napi(object)]
pub struct TuiRendererOptions {
    /// When `true`, a Ctrl+C key press tears the terminal down (raw mode +
    /// alternate screen exited) and marks the renderer destroyed instead of
    /// being surfaced as an event.
    #[napi(js_name = "exit_on_ctrl_c")]
    pub exit_on_ctrl_c: Option<bool>,
    /// When `false`, the renderer skips the alternate screen: it renders
    /// inline in the terminal's main screen (and never emits the alternate-
    /// screen enter/leave escapes). Default `true`.
    #[napi(js_name = "use_alt_screen")]
    pub use_alt_screen: Option<bool>,
    /// The terminal window title, applied on construction (OSC 0). `None`
    /// leaves the title untouched.
    #[napi(js_name = "title")]
    pub title: Option<String>,
}

/// The terminal's color capabilities, detected by the backend.
#[napi(object)]
pub struct RendererCapabilities {
    /// Whether 24-bit (16M) RGB truecolor is supported.
    pub truecolor: bool,
    /// The terminal's color palette size: 16_777_216 for truecolor, 256 for
    /// a 256-color palette, 16 for basic ANSI, 0 when none.
    pub colors: u32,
}

/// The terminal-facing renderer: owns raw mode + alternate screen, pushes
/// input to the JS thread via a threadsafe event stream (or polls it with the
/// `poll-fallback` feature), and paints the shared scene to the terminal.
#[napi]
pub struct TuiRenderer {
    inner: Arc<Mutex<RendererInner>>,
}

struct RendererInner {
    backend: Backend,
    compositor: Compositor,
    scene: Arc<Mutex<Scene>>,
    last: Option<Buffer>,
    #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
    exit_on_ctrl_c: bool,
    /// Whether the alternate screen was entered: `false` renders inline in
    /// the main screen, so teardown must skip `exit_alt_screen` to match.
    use_alt_screen: bool,
    destroyed: bool,
    /// The background push event loop (`push-events` feature): stopped when
    /// the renderer is destroyed so the loop thread exits and releases the
    /// threadsafe function.
    #[cfg(feature = "push-events")]
    event_loop: Option<EventLoopHandle>,
}

#[napi]
impl TuiRenderer {
    /// Enter raw mode + the alternate screen (unless `use_alt_screen` is
    /// `false`), apply the window title, and enable mouse / focus-change /
    /// bracketed-paste event delivery, ready to render.
    ///
    /// If any terminal transition fails the already-entered states are rolled
    /// back before the error is returned, so a failed constructor never leaves
    /// the terminal in raw mode.
    #[napi(constructor, js_name = "TuiRenderer")]
    pub fn new(options: TuiRendererOptions) -> Result<Self> {
        let use_alt_screen = options.use_alt_screen.unwrap_or(true);
        let title = options.title.clone();
        let backend = Backend::new();
        backend
            .enter_raw_mode()
            .map_err(|e| Error::from_reason(format!("enter raw mode: {e}")))?;
        if let Err(e) = backend.startup(use_alt_screen, title.as_deref()) {
            let _ = backend.exit_raw_mode();
            if use_alt_screen {
                let _ = backend.exit_alt_screen();
            }
            return Err(Error::from_reason(format!("enter alternate screen: {e}")));
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(RendererInner {
                backend,
                compositor: Compositor::new(),
                scene: shared_scene().clone(),
                last: None,
                #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
                exit_on_ctrl_c: options.exit_on_ctrl_c.unwrap_or(false),
                use_alt_screen,
                destroyed: false,
                #[cfg(feature = "push-events")]
                event_loop: None,
            })),
        })
    }

    /// A handle to the scene root, to attach content under.
    #[napi(js_name = "root")]
    pub fn root(&self) -> NodeHandle {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        let scene = inner.scene.clone();
        let id = scene.lock().expect("scene poisoned").root_id();
        NodeHandle::materialized(scene, id, NodeKind::Root, Style::new(), PropMap::new())
    }

    /// The scene node ids covering the cell at (`col`, `row`), innermost
    /// (topmost) first, then each ancestor that also covers the cell. The
    /// scene root is never reported; a cell no node covers yields `[]`.
    ///
    /// Z-order and clip/scroll regions match what [`render`](Self::render)
    /// paints at the current terminal size, so a click at a mouse event's
    /// `column`/`row` routes to the node that is visually on top.
    #[napi(js_name = "hit_test")]
    pub fn hit_test(&self, col: u32, row: u32) -> Result<Vec<u64>> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (w, h) = inner
            .backend
            .size()
            .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?;
        let scene = inner.scene.clone();
        let path = {
            let scene_guard = scene.lock().expect("scene poisoned");
            inner
                .compositor
                .hit_test(&scene_guard, col as i32, row as i32, Size::new(w, h))
        };
        Ok(path.into_iter().map(|id| id.0).collect())
    }

    /// Paint the shared scene into a fresh buffer at the current terminal
    /// size and flush the minimal diff (vs the previous frame) to the
    /// terminal.
    #[napi(js_name = "render")]
    pub fn render(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (w, h) = inner
            .backend
            .size()
            .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?;
        // Remember the viewport for `NodeHandle.content_size`, so its layout
        // matches the geometry that was just painted.
        *shared_viewport_ref().lock().expect("viewport poisoned") = (w as u32, h as u32);
        let viewport = Size::new(w, h);
        let scene = inner.scene.clone();
        let buffer = {
            let scene_guard = scene.lock().expect("scene poisoned");
            inner.compositor.paint_scene(&scene_guard, viewport)
        };
        let updates = match &inner.last {
            Some(prev) => buffer.diff_from(prev),
            None => diff(&Buffer::new(w, h), &buffer),
        };
        inner
            .backend
            .flush_diff(&updates, (0, 0))
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?;
        inner.last = Some(buffer);
        Ok(())
    }

    /// Paint the shared scene into a fresh buffer at the given viewport —
    /// `width`/`height` in cells, each defaulting to the most recent
    /// [`render`](Self::render) terminal size — and return the frame as one
    /// string per row. Masked/continuation cells (the zero-width right
    /// halves of wide glyphs) are spaces, so every row has exactly `width`
    /// display columns (multi-width aware). Performs no terminal I/O; the
    /// result is a pure snapshot for JS-side testing and golden
    /// comparisons.
    #[napi(js_name = "render_to_buffer")]
    pub fn render_to_buffer(&self, width: Option<u32>, height: Option<u32>) -> Result<Vec<String>> {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (vw, vh) = *shared_viewport_ref().lock().expect("viewport poisoned");
        let viewport = Size::new(
            width.map(|w| w as u16).unwrap_or(vw as u16),
            height.map(|h| h as u16).unwrap_or(vh as u16),
        );
        let scene = inner.scene.clone();
        let rows = {
            let scene_guard = scene.lock().expect("scene poisoned");
            paint_scene_rows(&scene_guard, viewport)
        };
        Ok(rows)
    }

    /// Leave the alternate screen and raw mode and stop event listening,
    /// restoring the terminal. Also stops the push event loop (with the
    /// default `push-events` feature) so the loop thread exits. Safe to call
    /// more than once; a destroyed renderer cannot render or poll.
    #[napi(js_name = "destroy")]
    pub fn destroy(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Ok(());
        }
        #[cfg(feature = "push-events")]
        if let Some(event_loop) = &inner.event_loop {
            event_loop.stop();
        }
        let _ = inner.backend.disable_event_listening();
        if inner.use_alt_screen {
            let _ = inner.backend.exit_alt_screen();
        }
        let _ = inner.backend.exit_raw_mode();
        inner.destroyed = true;
        Ok(())
    }

    /// Whether the renderer has been destroyed (explicitly or via Ctrl+C with
    /// `exit_on_ctrl_c`).
    #[napi(getter, js_name = "destroyed")]
    pub fn destroyed(&self) -> bool {
        self.inner
            .lock()
            .expect("renderer inner poisoned")
            .destroyed
    }

    /// The terminal's color capabilities (`{ truecolor, colors }`), detected
    /// once by the backend (see `tern-terminal`'s `Backend::capabilities`).
    #[napi(getter, js_name = "capabilities")]
    pub fn capabilities(&self) -> RendererCapabilities {
        let caps = tern_terminal::backend::capabilities();
        RendererCapabilities {
            truecolor: caps.truecolor,
            colors: caps.colors,
        }
    }

    /// Set the terminal window title (OSC 0). Errors on a destroyed
    /// renderer.
    #[napi(js_name = "set_title")]
    pub fn set_title(&self, title: String) -> Result<()> {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        inner
            .backend
            .set_title(&title)
            .map_err(|e| Error::from_reason(format!("set title: {e}")))
    }
}

/// The push-based event path (default `push-events` feature): a threadsafe
/// event stream fed by tern-terminal's background loop.
#[cfg(feature = "push-events")]
#[napi]
impl TuiRenderer {
    /// Start push-based event delivery: spawn tern-terminal's background
    /// event loop and deliver every normalized terminal event to `callback`
    /// on the JS thread through a threadsafe function.
    ///
    /// Events arrive in arrival order and none are dropped (the threadsafe
    /// queue is unbounded), so the JS renderer subscribes instead of polling.
    /// Key, resize, focus, mouse, and paste events are all delivered (mouse,
    /// focus, and bracketed-paste delivery is enabled in the constructor).
    /// With `exit_on_ctrl_c` enabled, a Ctrl+C press is delivered and then
    /// tears the renderer down (marked destroyed; the loop stops). Destroying
    /// the renderer also stops the loop. Errors if the renderer is already
    /// destroyed or a stream was already started.
    #[napi(js_name = "start_event_stream")]
    pub fn start_event_stream(&self, callback: ThreadsafeFunction<TernEventJs>) -> Result<()> {
        let tsfn = Arc::new(callback);
        let inner_for_loop = self.inner.clone();
        let exit_on_ctrl_c = {
            let inner = self.inner.lock().expect("renderer inner poisoned");
            if inner.destroyed {
                return Err(Error::from_reason("renderer is destroyed"));
            }
            if inner.event_loop.is_some() {
                return Err(Error::from_reason("event stream already started"));
            }
            inner.exit_on_ctrl_c
        };
        let stop = Arc::new(AtomicBool::new(false));
        let loop_stop = stop.clone();
        let sink = tsfn.clone();
        let handle = spawn_event_loop(stop, move |event: TernEvent| {
            let mut push = |js: TernEventJs| {
                let status = sink.call(Ok(js), ThreadsafeFunctionCallMode::NonBlocking);
                if status == Status::Closing {
                    // The JS side released the stream: stop pushing.
                    loop_stop.store(true, Ordering::Relaxed);
                }
            };
            let teardown =
                push_event_batch(std::slice::from_ref(&event), exit_on_ctrl_c, &mut push);
            if teardown {
                // Ctrl+C with exit_on_ctrl_c: restore the terminal and mark
                // the renderer destroyed, exactly like the pull path did.
                if let Ok(mut inner) = inner_for_loop.lock() {
                    let _ = inner.backend.disable_event_listening();
                    if inner.use_alt_screen {
                        let _ = inner.backend.exit_alt_screen();
                    }
                    let _ = inner.backend.exit_raw_mode();
                    inner.destroyed = true;
                }
                loop_stop.store(true, Ordering::Relaxed);
            }
        })
        .map_err(|e| Error::from_reason(format!("spawn event loop: {e}")))?;
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        inner.event_loop = Some(handle);
        Ok(())
    }
}

/// The pull-based event path (`poll-fallback` feature): `poll_events` returns
/// event batches on demand for hosts that cannot host a napi JS thread to
/// push into (the pre-Phase-3 behavior).
#[cfg(feature = "poll-fallback")]
#[napi]
impl TuiRenderer {
    /// Block up to `timeout_ms` for input, returning every event that arrived
    /// in that window (a burst of events comes back as one batch).
    ///
    /// Key, resize, focus, mouse, and paste events are all surfaced (mouse,
    /// focus, and bracketed-paste delivery is enabled in the constructor).
    /// With `exit_on_ctrl_c` enabled, a Ctrl+C press tears the renderer down
    /// instead of being returned; subsequent calls error until a new renderer
    /// is constructed.
    #[napi(js_name = "poll_events")]
    pub fn poll_events(&self, timeout_ms: u32) -> Result<Vec<TernEventJs>> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let events = event_module::poll_events(Duration::from_millis(timeout_ms as u64))
            .map_err(|e| Error::from_reason(format!("poll events: {e}")))?;
        let mut out = Vec::new();
        for ev in events {
            let ctrl_c = is_ctrl_c(&ev);
            if inner.exit_on_ctrl_c && ctrl_c {
                let _ = inner.backend.disable_event_listening();
                if inner.use_alt_screen {
                    let _ = inner.backend.exit_alt_screen();
                }
                let _ = inner.backend.exit_raw_mode();
                inner.destroyed = true;
                return Ok(out);
            }
            out.push(TernEventJs::from_tern(ev));
        }
        Ok(out)
    }
}

/// A handle to a scene node: either bound into the shared scene (`id` set) or
/// a detached template built by `create_node` that `add_child` materializes.
///
/// `kind` / `style` / `props` are kept on the handle as the source of truth
/// for materialization and `set_props`.
#[napi]
pub struct NodeHandle {
    inner: Arc<Mutex<NodeInner>>,
}

struct NodeInner {
    scene: Arc<Mutex<Scene>>,
    id: Option<NodeId>,
    kind: NodeKind,
    style: Style,
    props: PropMap,
}

impl NodeHandle {
    fn materialized(
        scene: Arc<Mutex<Scene>>,
        id: NodeId,
        kind: NodeKind,
        style: Style,
        props: PropMap,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NodeInner {
                scene,
                id: Some(id),
                kind,
                style,
                props,
            })),
        }
    }
}

#[napi]
impl NodeHandle {
    /// Materialize `child` (a detached `create_node` template) into the scene
    /// under this node and return the bound child handle, so calls can chain
    /// (`root.add_child(create_node(...))`). Errors when `self` is detached
    /// or `child` already has a parent.
    #[napi(js_name = "add_child")]
    pub fn add_child(&self, child: &NodeHandle) -> Result<NodeHandle> {
        let (parent_id, parent_scene) = {
            let parent = self.inner.lock().expect("node inner poisoned");
            let id = parent
                .id
                .ok_or_else(|| Error::from_reason("parent node is not attached to a scene"))?;
            (id, parent.scene.clone())
        };
        let mut child_inner = child.inner.lock().expect("node inner poisoned");
        if child_inner.id.is_some() {
            return Err(Error::from_reason("child node already has a parent"));
        }
        let mut scene = parent_scene.lock().expect("scene poisoned");
        let id = scene
            .add_child(parent_id, child_inner.kind, child_inner.style)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?;
        scene.set_props(id, child_inner.props.clone());
        drop(scene);
        child_inner.id = Some(id);
        child_inner.scene = parent_scene.clone();
        drop(child_inner);
        Ok(NodeHandle {
            inner: child.inner.clone(),
        })
    }

    /// Materialize `child` (a detached `create_node` template) into the scene
    /// under this node, positioned immediately before `anchor` in this node's
    /// children, and return the bound child handle so calls can chain
    /// (`parent.insert_before(create_node(...), existing_child)`).
    ///
    /// `anchor` must be an already-attached child of this node (in this node's
    /// scene); `child` must still be detached. Errors when `self` is detached,
    /// `child` already has a parent, or `anchor` is detached / not a child of
    /// this node.
    #[napi(js_name = "insert_before")]
    pub fn insert_before(&self, child: &NodeHandle, anchor: &NodeHandle) -> Result<NodeHandle> {
        let (parent_id, parent_scene) = {
            let parent = self.inner.lock().expect("node inner poisoned");
            let id = parent
                .id
                .ok_or_else(|| Error::from_reason("parent node is not attached to a scene"))?;
            (id, parent.scene.clone())
        };
        // Snapshot the detached child's materialization data before touching
        // the anchor: `child` and `anchor` may alias the same handle, and no
        // two handle mutexes are ever held at once.
        let (kind, style, props) = {
            let child_inner = child.inner.lock().expect("node inner poisoned");
            if child_inner.id.is_some() {
                return Err(Error::from_reason("child node already has a parent"));
            }
            (
                child_inner.kind,
                child_inner.style,
                child_inner.props.clone(),
            )
        };
        let anchor_id = {
            let anchor_inner = anchor.inner.lock().expect("node inner poisoned");
            let id = anchor_inner
                .id
                .ok_or_else(|| Error::from_reason("anchor node is not attached to a scene"))?;
            if !Arc::ptr_eq(&anchor_inner.scene, &parent_scene) {
                return Err(Error::from_reason(
                    "anchor node is not a child of this node",
                ));
            }
            id
        };
        let mut scene = parent_scene.lock().expect("scene poisoned");
        let index = scene
            .children(parent_id)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?
            .iter()
            .position(|c| *c == anchor_id)
            .ok_or_else(|| Error::from_reason("anchor node is not a child of this node"))?;
        let id = scene
            .insert_child(parent_id, index, kind, style)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?;
        scene.set_props(id, props);
        drop(scene);
        // Bind the child handle into the scene, mirroring `add_child`.
        {
            let mut child_inner = child.inner.lock().expect("node inner poisoned");
            child_inner.id = Some(id);
            child_inner.scene = parent_scene.clone();
        }
        Ok(NodeHandle {
            inner: child.inner.clone(),
        })
    }

    /// Detach this node (and its whole subtree) from the scene. Returns
    /// `false` when the node was already detached (or is the scene root).
    #[napi(js_name = "remove")]
    pub fn remove(&self) -> Result<bool> {
        let mut inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Ok(false);
        };
        let removed = {
            let mut scene = inner.scene.lock().expect("scene poisoned");
            scene.remove(id)
        };
        inner.id = None;
        Ok(removed)
    }

    /// Replace this node's props (and style keys) in the scene.
    ///
    /// Recognized style keys are lifted out of the props object: `fg`, `bg`
    /// (color strings), `border_style` (`none|plain|rounded|double|thick`),
    /// and the boolean modifiers (`bold`, `dim`, `italic`, `underline`,
    /// `blink`, `reversed`, `hidden`, `strikethrough`). Every other key lands
    /// in the node's property map (`text`, layout keywords, ...).
    #[napi(js_name = "set_props")]
    pub fn set_props(&self, props: HashMap<String, serde_json::Value>) -> Result<()> {
        let (style, map) = props_to_style_map(props);
        let mut inner = self.inner.lock().expect("node inner poisoned");
        inner.style = style;
        inner.props = map.clone();
        if let Some(id) = inner.id {
            let mut scene = inner.scene.lock().expect("scene poisoned");
            scene.set_style(id, style);
            scene.set_props(id, map);
        }
        Ok(())
    }

    /// Append a styled span of text to a `streaming_text` node's stream.
    ///
    /// `style` follows the same style-key convention as `set_props` (`fg`,
    /// `bg`, `border_style`, and the boolean modifiers are lifted into the
    /// span's style; every other key is ignored). The span is appended to the
    /// node's accumulated stream in the shared scene, in call order. Errors
    /// when the node is detached from the scene or is not a `streaming_text`
    /// node.
    #[napi(js_name = "append_span")]
    pub fn append_span(
        &self,
        text: String,
        style: Option<HashMap<String, serde_json::Value>>,
    ) -> Result<()> {
        let (style, _) = props_to_style_map(style.unwrap_or_default());
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        if inner.kind != NodeKind::StreamingText {
            return Err(Error::from_reason(
                "append_span requires a streaming_text node",
            ));
        }
        let mut scene = inner.scene.lock().expect("scene poisoned");
        if !scene.append_span(id, Span { text, style }) {
            return Err(Error::from_reason("node not found in scene"));
        }
        Ok(())
    }

    /// The laid-out content size of this node: `{ width, height }` in cells.
    ///
    /// For `text` / `streaming_text` nodes this is the wrapped content size
    /// (the display width of the widest wrapped line and the wrapped line
    /// count at the node's laid-out width); for containers it is the laid-out
    /// rect size. The layout runs at the viewport of the most recent
    /// [`TuiRenderer::render`], so the geometry matches what is on screen. A
    /// node with no geometry (`display: none`) reports `(0, 0)`; a detached
    /// handle errors.
    #[napi(js_name = "content_size")]
    pub fn content_size(&self) -> Result<ContentSize> {
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        let (w, h) = *shared_viewport_ref().lock().expect("viewport poisoned");
        let mut compositor = Compositor::new();
        let size = {
            let scene = inner.scene.lock().expect("scene poisoned");
            compositor.content_size(&scene, id, Size::new(w as u16, h as u16))
        };
        Ok(match size {
            Some((width, height)) => ContentSize { width, height },
            None => ContentSize {
                width: 0,
                height: 0,
            },
        })
    }
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
/// Whether a key event is a Ctrl+C press (the `exit_on_ctrl_c` trigger).
fn is_ctrl_c(event: &TernEvent) -> bool {
    matches!(event, TernEvent::Key(key) if key.ctrl && key.char == Some('c'))
}

/// Deliver a batch of normalized terminal events to the JS thread through
/// `push`, in arrival order, converting each to its JS form. Returns `true`
/// when the batch contained a Ctrl+C press and `exit_on_ctrl_c` is enabled —
/// the caller then tears the terminal down and stops the event loop.
///
/// The ctrl-c press itself is still delivered (push-mode consumers observe
/// it; the renderer's `destroyed` flag reports the teardown that follows).
#[cfg(feature = "push-events")]
fn push_event_batch(
    events: &[TernEvent],
    exit_on_ctrl_c: bool,
    push: &mut impl FnMut(TernEventJs),
) -> bool {
    let mut teardown = false;
    for event in events {
        if exit_on_ctrl_c && is_ctrl_c(event) {
            teardown = true;
        }
        push(TernEventJs::from_tern(event.clone()));
    }
    teardown
}

/// Create a detached node template of `type` (`"box"`, `"text"`, or
/// `"streaming_text"`) with `props`. The handle is materialized into the scene
/// when it is added to a bound parent via `NodeHandle.add_child`. See
/// `set_props` for the style-key convention.
#[napi(js_name = "create_node")]
pub fn create_node(
    r#type: String,
    props: Option<HashMap<String, serde_json::Value>>,
) -> Result<NodeHandle> {
    let kind = match r#type.as_str() {
        "box" => NodeKind::Box,
        "text" => NodeKind::Text,
        "streaming_text" => NodeKind::StreamingText,
        other => {
            return Err(Error::from_reason(format!(
                "unknown node type {other:?} (expected \"box\", \"text\", or \"streaming_text\")"
            )))
        }
    };
    let (style, props) = props_to_style_map(props.unwrap_or_default());
    Ok(NodeHandle {
        inner: Arc::new(Mutex::new(NodeInner {
            scene: shared_scene().clone(),
            id: None,
            kind,
            style,
            props,
        })),
    })
}

/// Token-highlight `source` in `language` (a Markdown fence info string:
/// `"rust"` / `"typescript"` / `"ts"` / `"tsx"` / `"javascript"` / `"js"` /
/// `"json"` / `"bash"` / `"shell"` / `"sh"` / `"zsh"`) into a complete span
/// stream for a code fence or a `streaming_text` node.
///
/// The returned spans cover every byte of `source` (gaps carry no style) and
/// merge adjacent same-style runs, so concatenating their `text` reconstructs
/// the source exactly — the compositor paints them in order. Unknown
/// languages error; tree-sitter is error-tolerant, so half-open streaming
/// input still highlights.
#[napi(js_name = "highlight")]
pub fn highlight(language: String, source: String) -> Result<Vec<HighlightSpanJs>> {
    let Some(lang) = tern_highlight::Language::from_fence_name(&language) else {
        return Err(Error::from_reason(format!(
            "unknown highlight language {language:?}"
        )));
    };
    Ok(tern_highlight::highlight(lang, &source)
        .into_iter()
        .map(|span| HighlightSpanJs {
            text: span.text,
            fg: span
                .style
                .fg
                .rgb()
                .map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}")),
            bold: span.style.modifiers.contains(Modifiers::BOLD),
            italic: span.style.modifiers.contains(Modifiers::ITALIC),
            dim: span.style.modifiers.contains(Modifiers::DIM),
            underline: span.style.modifiers.contains(Modifiers::UNDERLINE),
        })
        .collect())
}

/// Split a JS props object into a tern style (style keys) and a tern property
/// map (everything else).
fn props_to_style_map(props: HashMap<String, serde_json::Value>) -> (Style, PropMap) {
    let mut style = Style::new();
    let mut map = PropMap::new();
    for (key, value) in props {
        match key.as_str() {
            "border_style" => {
                if let serde_json::Value::String(s) = value {
                    style = style.border_style(parse_border_style(&s));
                }
            }
            "fg" => {
                if let serde_json::Value::String(s) = value {
                    style = style.fg(parse_color(&s));
                }
            }
            "bg" => {
                if let serde_json::Value::String(s) = value {
                    style = style.bg(parse_color(&s));
                }
            }
            "bold" => style = add_modifier_if(style, value, Modifiers::BOLD),
            "dim" => style = add_modifier_if(style, value, Modifiers::DIM),
            "italic" => style = add_modifier_if(style, value, Modifiers::ITALIC),
            "underline" => style = add_modifier_if(style, value, Modifiers::UNDERLINE),
            "blink" => style = add_modifier_if(style, value, Modifiers::BLINK),
            "reversed" => style = add_modifier_if(style, value, Modifiers::REVERSED),
            "hidden" => style = add_modifier_if(style, value, Modifiers::HIDDEN),
            "strikethrough" => style = add_modifier_if(style, value, Modifiers::STRIKETHROUGH),
            _ => {
                let Some(pv) = json_to_prop_value(value) else {
                    continue;
                };
                map.insert(key, pv);
            }
        }
    }
    (style, map)
}

/// Add `modifier` to `style` when the JSON value is `true`.
fn add_modifier_if(style: Style, value: serde_json::Value, modifier: Modifiers) -> Style {
    if value.as_bool() == Some(true) {
        style.add_modifier(modifier)
    } else {
        style
    }
}

/// Convert a JSON scalar into a tern property value; `None` for values that
/// have no prop representation (null, arrays, objects).
fn json_to_prop_value(value: serde_json::Value) -> Option<PropValue> {
    match value {
        serde_json::Value::String(s) => Some(PropValue::Str(s)),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => Some(PropValue::Int(i)),
            None => Some(PropValue::Float(n.as_f64().unwrap_or(0.0))),
        },
        serde_json::Value::Bool(b) => Some(PropValue::Bool(b)),
        _ => None,
    }
}

/// Parse a color string: `"#rrggbb"` → truecolor, `"indexed:<n>"` → ANSI
/// palette, `"default"` → terminal default, anything else → default.
fn parse_color(s: &str) -> Color {
    if s == "default" {
        return Color::Default;
    }
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            let ok = (|r: &str, g: &str, b: &str| {
                Some((
                    u8::from_str_radix(r, 16).ok()?,
                    u8::from_str_radix(g, 16).ok()?,
                    u8::from_str_radix(b, 16).ok()?,
                ))
            })(&hex[0..2], &hex[2..4], &hex[4..6]);
            if let Some((r, g, b)) = ok {
                return Color::Rgb(r, g, b);
            }
        }
    }
    if let Some(idx) = s.strip_prefix("indexed:") {
        if let Ok(n) = idx.parse::<u8>() {
            return Color::Indexed(n);
        }
    }
    Color::Default
}

/// Parse a border style keyword; anything unrecognized → no border.
fn parse_border_style(s: &str) -> BorderStyle {
    match s {
        "plain" => BorderStyle::Plain,
        "rounded" => BorderStyle::Rounded,
        "double" => BorderStyle::Double,
        "thick" => BorderStyle::Thick,
        _ => BorderStyle::None,
    }
}

/// The JS-facing name of a tern key.
fn key_name_str(name: KeyName) -> String {
    match name {
        KeyName::Char => "char",
        KeyName::Enter => "enter",
        KeyName::Escape => "escape",
        KeyName::Backspace => "backspace",
        KeyName::Tab => "tab",
        KeyName::BackTab => "backtab",
        KeyName::Delete => "delete",
        KeyName::Insert => "insert",
        KeyName::Home => "home",
        KeyName::End => "end",
        KeyName::PageUp => "pageup",
        KeyName::PageDown => "pagedown",
        KeyName::Up => "up",
        KeyName::Down => "down",
        KeyName::Left => "left",
        KeyName::Right => "right",
        KeyName::F(n) => return format!("f{n}"),
        KeyName::Null => "null",
        KeyName::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::color::Color as _Color;

    #[test]
    fn key_name_str_maps_all_names() {
        assert_eq!(key_name_str(KeyName::Char), "char");
        assert_eq!(key_name_str(KeyName::Enter), "enter");
        assert_eq!(key_name_str(KeyName::Escape), "escape");
        assert_eq!(key_name_str(KeyName::Backspace), "backspace");
        assert_eq!(key_name_str(KeyName::Tab), "tab");
        assert_eq!(key_name_str(KeyName::BackTab), "backtab");
        assert_eq!(key_name_str(KeyName::Delete), "delete");
        assert_eq!(key_name_str(KeyName::Home), "home");
        assert_eq!(key_name_str(KeyName::End), "end");
        assert_eq!(key_name_str(KeyName::PageUp), "pageup");
        assert_eq!(key_name_str(KeyName::PageDown), "pagedown");
        assert_eq!(key_name_str(KeyName::Up), "up");
        assert_eq!(key_name_str(KeyName::Down), "down");
        assert_eq!(key_name_str(KeyName::Left), "left");
        assert_eq!(key_name_str(KeyName::Right), "right");
        assert_eq!(key_name_str(KeyName::F(12)), "f12");
        assert_eq!(key_name_str(KeyName::Null), "null");
        assert_eq!(key_name_str(KeyName::Unknown), "unknown");
    }

    #[test]
    fn key_event_carries_char_and_modifiers() {
        let key = TernKey::new(KeyName::Char, Some('q'), true, false, true);
        let ev = KeyEvent::from_tern(key);
        assert_eq!(ev.name, "char");
        assert_eq!(ev.char.as_deref(), Some("q"));
        assert!(ev.ctrl);
        assert!(!ev.alt);
        assert!(ev.shift);

        let enter = KeyEvent::from_tern(TernKey::new(KeyName::Enter, None, false, false, false));
        assert_eq!(enter.name, "enter");
        assert!(enter.char.is_none());
    }

    #[test]
    fn tern_event_js_resize_maps() {
        let ev = TernEventJs::from_tern(TernEvent::Resize { w: 120, h: 40 });
        assert_eq!(ev.r#type, "resize");
        assert_eq!(ev.width, Some(120));
        assert_eq!(ev.height, Some(40));
        assert!(ev.key.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn tern_event_js_focus_maps() {
        let gained = TernEventJs::from_tern(TernEvent::FocusGained);
        assert_eq!(gained.r#type, "focus");
        assert_eq!(gained.focus_gained, Some(true));
        assert!(gained.key.is_none());
        assert!(gained.width.is_none());
        assert!(gained.height.is_none());
        assert!(gained.mouse.is_none());
        assert!(gained.paste.is_none());

        let lost = TernEventJs::from_tern(TernEvent::FocusLost);
        assert_eq!(lost.r#type, "focus");
        assert_eq!(lost.focus_gained, Some(false));
    }

    #[test]
    fn tern_event_js_mouse_maps_with_modifiers() {
        let mouse = TernMouse {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 3,
            row: 4,
            ctrl: true,
            alt: false,
            shift: true,
        };
        let ev = TernEventJs::from_tern(TernEvent::Mouse(mouse));
        assert_eq!(ev.r#type, "mouse");
        let js = ev.mouse.expect("mouse payload present");
        assert_eq!(js.kind, "down_left");
        assert_eq!(js.column, 3);
        assert_eq!(js.row, 4);
        assert!(js.ctrl);
        assert!(!js.alt);
        assert!(js.shift);
        assert!(ev.key.is_none());
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn tern_event_js_paste_maps() {
        let ev = TernEventJs::from_tern(TernEvent::Paste("pasted".to_string()));
        assert_eq!(ev.r#type, "paste");
        assert_eq!(ev.paste.as_deref(), Some("pasted"));
        assert!(ev.key.is_none());
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
    }

    #[test]
    fn mouse_kind_encoding_is_lossless() {
        // Every tern mouse kind must map to a distinct, button-preserving
        // `kind` string.
        let encode = |kind: MouseEventKind| {
            MouseEventJs::from_tern(TernMouse {
                kind,
                column: 0,
                row: 0,
                ctrl: false,
                alt: false,
                shift: false,
            })
            .kind
        };
        assert_eq!(encode(MouseEventKind::Down(MouseButton::Left)), "down_left");
        assert_eq!(
            encode(MouseEventKind::Down(MouseButton::Right)),
            "down_right"
        );
        assert_eq!(
            encode(MouseEventKind::Down(MouseButton::Middle)),
            "down_middle"
        );
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Left)), "up_left");
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Right)), "up_right");
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Middle)), "up_middle");
        assert_eq!(encode(MouseEventKind::Drag(MouseButton::Left)), "drag_left");
        assert_eq!(
            encode(MouseEventKind::Drag(MouseButton::Right)),
            "drag_right"
        );
        assert_eq!(
            encode(MouseEventKind::Drag(MouseButton::Middle)),
            "drag_middle"
        );
        assert_eq!(encode(MouseEventKind::Moved), "moved");
        assert_eq!(encode(MouseEventKind::ScrollUp), "scroll_up");
        assert_eq!(encode(MouseEventKind::ScrollDown), "scroll_down");
        assert_eq!(encode(MouseEventKind::ScrollLeft), "scroll_left");
        assert_eq!(encode(MouseEventKind::ScrollRight), "scroll_right");
    }

    #[test]
    fn tern_event_js_key_maps() {
        let key = TernKey::new(KeyName::Char, Some('q'), true, false, true);
        let ev = TernEventJs::from_tern(TernEvent::Key(key));
        assert_eq!(ev.r#type, "key");
        let js = ev.key.expect("key payload present");
        assert_eq!(js.name, "char");
        assert_eq!(js.char.as_deref(), Some("q"));
        assert!(js.ctrl);
        assert!(js.shift);
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn parse_color_handles_hex_indexed_and_default() {
        assert_eq!(parse_color("#ff8000"), _Color::Rgb(255, 128, 0));
        assert_eq!(parse_color("indexed:5"), _Color::Indexed(5));
        assert_eq!(parse_color("default"), _Color::Default);
        assert_eq!(parse_color("garbage"), _Color::Default);
        assert_eq!(parse_color("#12"), _Color::Default); // too short
    }

    #[test]
    fn highlight_returns_styled_spans_for_rust() {
        // The full source is reconstructed by the span stream, with the token
        // styles surfaced as hex fg + modifiers (the JS span style keys).
        let spans = highlight(
            "rust".to_string(),
            "fn main() {\n    let x = 42; // hi\n}\n".to_string(),
        )
        .expect("rust highlight succeeds");
        let joined: String = spans.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, "fn main() {\n    let x = 42; // hi\n}\n");

        let keyword = spans.iter().find(|s| s.text == "fn").expect("fn span");
        assert_eq!(keyword.fg.as_deref(), Some("#c678dd"));
        assert!(!keyword.italic);
        let number = spans.iter().find(|s| s.text == "42").expect("42 span");
        assert_eq!(number.fg.as_deref(), Some("#d19a66"));
        let comment = spans
            .iter()
            .find(|s| s.text == "// hi")
            .expect("comment span");
        assert_eq!(comment.fg.as_deref(), Some("#7f848e"));
        assert!(comment.italic);
    }

    #[test]
    fn highlight_errors_on_unknown_language() {
        let err =
            highlight("ruby".to_string(), "x".to_string()).expect_err("unknown language errors");
        assert!(err.to_string().contains("unknown highlight language"));
    }

    #[test]
    fn parse_border_style_keywords() {
        assert_eq!(parse_border_style("plain"), BorderStyle::Plain);
        assert_eq!(parse_border_style("rounded"), BorderStyle::Rounded);
        assert_eq!(parse_border_style("double"), BorderStyle::Double);
        assert_eq!(parse_border_style("thick"), BorderStyle::Thick);
        assert_eq!(parse_border_style("nope"), BorderStyle::None);
    }

    #[test]
    fn props_split_into_style_and_prop_map() {
        let props = HashMap::from([
            ("text".to_string(), serde_json::json!("Hi")),
            ("padding".to_string(), serde_json::json!(1)),
            ("width".to_string(), serde_json::json!(10)),
            ("flex_direction".to_string(), serde_json::json!("column")),
            ("border_style".to_string(), serde_json::json!("rounded")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
            ("hidden".to_string(), serde_json::json!(true)),
            ("nested".to_string(), serde_json::json!({"a": 1})), // dropped
        ]);
        let (style, map) = props_to_style_map(props);
        assert_eq!(style.border_style, BorderStyle::Rounded);
        assert_eq!(style.fg, _Color::Rgb(255, 0, 0));
        assert!(style.modifiers.contains(Modifiers::BOLD));
        assert!(style.modifiers.contains(Modifiers::HIDDEN));
        assert!(!style.modifiers.contains(Modifiers::ITALIC));
        assert_eq!(map.get("text"), Some(&PropValue::Str("Hi".to_string())));
        assert_eq!(map.get("padding"), Some(&PropValue::Int(1)));
        assert_eq!(map.get("width"), Some(&PropValue::Int(10)));
        assert_eq!(
            map.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        assert_eq!(map.len(), 4); // nested object dropped
    }

    #[test]
    fn json_prop_values_convert_scalars_only() {
        assert_eq!(
            json_to_prop_value(serde_json::json!("x")),
            Some(PropValue::Str("x".to_string()))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(7)),
            Some(PropValue::Int(7))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(1.5)),
            Some(PropValue::Float(1.5))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(true)),
            Some(PropValue::Bool(true))
        );
        assert_eq!(json_to_prop_value(serde_json::json!(null)), None);
        assert_eq!(json_to_prop_value(serde_json::json!([1, 2])), None);
    }

    #[test]
    fn create_node_accepts_streaming_text_type() {
        let node = create_node("streaming_text".to_string(), None).expect("create streaming node");
        assert_eq!(
            node.inner.lock().expect("node inner poisoned").kind,
            NodeKind::StreamingText
        );
    }

    #[test]
    fn create_node_rejects_unknown_type() {
        let err = match create_node("marquee".to_string(), None) {
            Ok(_) => panic!("unknown type must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("streaming_text"), "{err}");
    }

    #[test]
    fn render_to_buffer_paints_known_scene_into_expected_rows() {
        // The canonical golden scene (mirrored by the JS fake-addon golden
        // test): a rounded-border box with 1-cell padding around Text('Hi'),
        // attached to the scene root, painted at a 6x3 viewport. The box
        // sizes to its content (2 text columns + 2 padding = 4 wide, 1 + 2
        // padding = 3 tall) at the origin, so the frame is
        //   ┌──┐
        //   │Hi│
        //   └──┘
        // with trailing blanks padded to the 6-column viewport width.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Rounded),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(box_id, "Hi", Style::new())
            .expect("add text");

        let rows = paint_scene_rows(&scene, Size::new(6, 3));
        assert_eq!(rows, vec!["┌──┐  ", "│Hi│  ", "└──┘  "]);
    }

    #[test]
    fn render_to_buffer_masks_wide_char_continuation_cells() {
        // A wide glyph occupies two columns: the lead cell carries the glyph
        // and the continuation cell is masked (NUL). `buffer_rows` maps the
        // mask to a space so the row string keeps the buffer's full display
        // width — the wide character is never dropped nor doubled.
        let mut buffer = Buffer::new(4, 1);
        buffer.set_string(0, 0, "コa", Style::new());
        assert_eq!(buffer_rows(&buffer), vec!["コ a "]);
    }

    #[test]
    fn render_to_buffer_errors_when_destroyed() {
        // The napi method guards on the destroyed flag, so a torn-down
        // renderer cannot snapshot (mirrors `render`).
        let scene = Arc::new(Mutex::new(Scene::new()));
        let inner = RendererInner {
            backend: Backend::new(),
            compositor: Compositor::new(),
            scene,
            last: None,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            destroyed: true,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        let renderer = TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        };
        let err = renderer
            .render_to_buffer(None, None)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn append_span_lands_span_in_scene_stream() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let id = {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::StreamingText, Style::new())
                .expect("add streaming node")
        };
        let node = NodeHandle::materialized(
            scene.clone(),
            id,
            NodeKind::StreamingText,
            Style::new(),
            PropMap::new(),
        );
        let style = HashMap::from([
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
            // A non-style key is ignored by the style-lifting convention.
            ("padding".to_string(), serde_json::json!(2)),
        ]);
        node.append_span("hello".to_string(), Some(style))
            .expect("append_span succeeds");
        let s = scene.lock().expect("scene poisoned");
        let stream = s.stream(id).expect("stream exists");
        assert_eq!(stream.len(), 1);
        assert_eq!(stream[0].text, "hello");
        assert_eq!(stream[0].style.fg, _Color::Rgb(255, 0, 0));
        assert!(stream[0].style.modifiers.contains(Modifiers::BOLD));
    }

    #[test]
    fn append_span_accumulates_spans_in_call_order() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let id = {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::StreamingText, Style::new())
                .expect("add streaming node")
        };
        let node = NodeHandle::materialized(
            scene.clone(),
            id,
            NodeKind::StreamingText,
            Style::new(),
            PropMap::new(),
        );
        node.append_span("a".to_string(), None).expect("first span");
        node.append_span("b".to_string(), None)
            .expect("second span");
        let s = scene.lock().expect("scene poisoned");
        let texts: Vec<&str> = s
            .stream(id)
            .expect("stream exists")
            .iter()
            .map(|sp| sp.text.as_str())
            .collect();
        assert_eq!(texts, vec!["a", "b"]);
    }

    #[test]
    fn append_span_errors_when_node_is_detached() {
        let node = create_node("streaming_text".to_string(), None).expect("create streaming node");
        let err = node
            .append_span("hi".to_string(), None)
            .expect_err("detached node must error");
        assert!(err.to_string().contains("not attached"), "{err}");
    }

    #[test]
    fn append_span_errors_on_non_streaming_node() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let id = {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::Text, Style::new())
                .expect("add text node")
        };
        let node = NodeHandle::materialized(
            scene.clone(),
            id,
            NodeKind::Text,
            Style::new(),
            PropMap::new(),
        );
        let err = node
            .append_span("hi".to_string(), None)
            .expect_err("non-streaming node must error");
        assert!(err.to_string().contains("streaming_text"), "{err}");
    }

    /// The scene id of an attached handle.
    fn attached_id(handle: &NodeHandle) -> NodeId {
        handle
            .inner
            .lock()
            .expect("node inner poisoned")
            .id
            .expect("handle is attached")
    }

    /// The ordered scene ids of `parent`'s children.
    fn child_ids(scene: &Arc<Mutex<Scene>>, parent: &NodeHandle) -> Vec<NodeId> {
        let parent_id = attached_id(parent);
        let s = scene.lock().expect("scene poisoned");
        s.children(parent_id).expect("parent in scene").to_vec()
    }

    /// A detached `text` template for insertion tests.
    fn text_template() -> NodeHandle {
        create_node("text".to_string(), None).expect("create text template")
    }

    #[test]
    fn insert_before_lands_at_anchor_index() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        let a = root.add_child(&text_template()).expect("add a");
        let b = root.add_child(&text_template()).expect("add b");
        let c = root.add_child(&text_template()).expect("add c");
        assert_eq!(
            child_ids(&scene, &root),
            vec![attached_id(&a), attached_id(&b), attached_id(&c)]
        );

        // Before the first child.
        let x = root
            .insert_before(&text_template(), &a)
            .expect("insert before first");
        assert_eq!(
            child_ids(&scene, &root),
            vec![
                attached_id(&x),
                attached_id(&a),
                attached_id(&b),
                attached_id(&c)
            ]
        );

        // Before the middle child.
        let y = root
            .insert_before(&text_template(), &b)
            .expect("insert before middle");
        assert_eq!(
            child_ids(&scene, &root),
            vec![
                attached_id(&x),
                attached_id(&a),
                attached_id(&y),
                attached_id(&b),
                attached_id(&c)
            ]
        );

        // Before the last child (c sits at index 4 of [x, a, y, b, c]).
        let z = root
            .insert_before(&text_template(), &c)
            .expect("insert before last");
        assert_eq!(
            child_ids(&scene, &root),
            vec![
                attached_id(&x),
                attached_id(&a),
                attached_id(&y),
                attached_id(&b),
                attached_id(&z),
                attached_id(&c),
            ]
        );

        // Every inserted node is a child of `root` in scene order.
        let s = scene.lock().expect("scene poisoned");
        for handle in [&x, &a, &y, &z, &b, &c] {
            let n = s.node(attached_id(handle)).expect("node in scene");
            assert_eq!(n.parent, Some(root_id));
        }
    }

    #[test]
    fn insert_before_binds_child_like_add_child() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        let anchor = root.add_child(&text_template()).expect("add anchor");
        let child = create_node(
            "box".to_string(),
            Some(HashMap::from([(
                "text".to_string(),
                serde_json::json!("hi"),
            )])),
        )
        .expect("create child with props");
        let bound = root.insert_before(&child, &anchor).expect("insert before");

        // The returned handle shares the child's inner state and is attached.
        assert!(Arc::ptr_eq(&child.inner, &bound.inner));
        assert_ne!(attached_id(&bound), attached_id(&anchor));
        // Scoped so the scene guard is dropped before `bound` is used as a
        // parent below (a MutexGuard is not released by NLL early).
        {
            let s = scene.lock().expect("scene poisoned");
            assert_eq!(
                s.prop(attached_id(&bound), "text"),
                Some(&PropValue::Str("hi".to_string()))
            );
        }

        // The bound handle can itself be a parent.
        let grandchild = bound.add_child(&text_template()).expect("add grandchild");
        {
            let s = scene.lock().expect("scene poisoned");
            assert_eq!(
                s.node(attached_id(&grandchild)).unwrap().parent,
                Some(attached_id(&bound))
            );
            assert_eq!(
                s.children(attached_id(&bound)).unwrap(),
                &[attached_id(&grandchild)]
            );
        }
    }

    #[test]
    fn insert_before_rejects_child_with_parent() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        let a = root.add_child(&text_template()).expect("add a");
        let b = root.add_child(&text_template()).expect("add b");

        let err = match root.insert_before(&a, &b) {
            Ok(_) => panic!("attached child must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("already has a parent"), "{err}");
        // Nothing was inserted.
        assert_eq!(
            child_ids(&scene, &root),
            vec![attached_id(&a), attached_id(&b)]
        );
    }

    #[test]
    fn insert_before_rejects_detached_anchor() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        let a = root.add_child(&text_template()).expect("add a");
        let detached = text_template();

        let err = match root.insert_before(&text_template(), &detached) {
            Ok(_) => panic!("detached anchor must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("anchor"), "{err}");
        assert_eq!(child_ids(&scene, &root), vec![attached_id(&a)]);
    }

    #[test]
    fn insert_before_rejects_foreign_anchor() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        // `parent` is a box under root; the anchor is attached under root as
        // a sibling of `parent`, so it is not one of `parent`'s children.
        let parent = root
            .add_child(&create_node("box".to_string(), None).expect("create box"))
            .expect("add box");
        let _a = parent.add_child(&text_template()).expect("add a");
        let foreign = root.add_child(&text_template()).expect("add foreign");

        let err = match parent.insert_before(&text_template(), &foreign) {
            Ok(_) => panic!("foreign anchor must error"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("not a child of this node"),
            "{err}"
        );
        // The foreign sibling's sibling order is untouched.
        assert_eq!(
            child_ids(&scene, &root),
            vec![attached_id(&parent), attached_id(&foreign)]
        );
    }

    #[test]
    fn insert_before_rejects_detached_parent() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root_id = scene.lock().expect("scene poisoned").root_id();
        let root = NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        );

        let a = root.add_child(&text_template()).expect("add a");
        let detached = create_node("box".to_string(), None).expect("create detached parent");

        let err = match detached.insert_before(&text_template(), &a) {
            Ok(_) => panic!("detached parent must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("not attached"), "{err}");
        assert_eq!(child_ids(&scene, &root), vec![attached_id(&a)]);
    }

    /// A synthetic tern event of the given index, cycling the event kinds so
    /// every payload shape is exercised.
    fn synthetic_event(i: usize) -> TernEvent {
        match i % 5 {
            0 => TernEvent::Key(TernKey::new(KeyName::Char, Some('a'), false, false, false)),
            1 => TernEvent::Resize {
                w: 80,
                h: (i + 1) as u16,
            },
            2 => TernEvent::FocusGained,
            3 => TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Moved,
                column: (i % 100) as u16,
                row: 0,
                ctrl: false,
                alt: false,
                shift: false,
            }),
            _ => TernEvent::Paste(format!("pasted-{i}")),
        }
    }

    #[cfg(feature = "push-events")]
    #[test]
    fn push_event_batch_delivers_all_synthetic_events_without_loss() {
        // The push path's batch converter: N synthetic events in, N JS events
        // out, in order, each mapping to the right tagged union shape.
        let n = 40;
        let events: Vec<TernEvent> = (0..n).map(synthetic_event).collect();
        let mut delivered: Vec<TernEventJs> = Vec::new();
        let teardown = push_event_batch(&events, false, &mut |js| delivered.push(js));
        assert!(!teardown, "no ctrl+c in the batch");
        assert_eq!(delivered.len(), n, "all {n} events delivered, none lost");
        for (i, (event, js)) in events.iter().zip(&delivered).enumerate() {
            match event {
                TernEvent::Key(_key) => {
                    assert_eq!(js.r#type, "key", "event {i} tagged key");
                    let js_key = js.key.as_ref().expect("key payload present");
                    assert_eq!(js_key.name, "char");
                    assert_eq!(js_key.char.as_deref(), Some("a"));
                }
                TernEvent::Resize { w, h } => {
                    assert_eq!(js.r#type, "resize", "event {i} tagged resize");
                    assert_eq!(js.width, Some(*w));
                    assert_eq!(js.height, Some(*h));
                }
                TernEvent::FocusGained => {
                    assert_eq!(js.r#type, "focus", "event {i} tagged focus");
                    assert_eq!(js.focus_gained, Some(true));
                }
                TernEvent::FocusLost => unreachable!("synthetic events never focus-lost"),
                TernEvent::Mouse(_) => {
                    assert_eq!(js.r#type, "mouse", "event {i} tagged mouse");
                    assert_eq!(
                        js.mouse.as_ref().expect("mouse payload present").kind,
                        "moved"
                    );
                }
                TernEvent::Paste(text) => {
                    assert_eq!(js.r#type, "paste", "event {i} tagged paste");
                    assert_eq!(
                        js.paste.as_deref(),
                        Some(text.as_str()),
                        "event {i} payload"
                    );
                }
            }
        }
    }

    #[cfg(feature = "push-events")]
    #[test]
    fn push_event_batch_flags_ctrl_c_teardown_and_still_delivers() {
        // Ctrl+C with exit_on_ctrl_c: the batch reports a teardown (the caller
        // restores the terminal and stops the loop) and the press is still
        // delivered so push-mode consumers observe it.
        let events = vec![
            TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false)),
            TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), false, false, false)),
        ];
        let mut delivered: Vec<TernEventJs> = Vec::new();
        let teardown = push_event_batch(&events, true, &mut |js| delivered.push(js));
        assert!(teardown, "ctrl+c with exit_on_ctrl_c must request teardown");
        assert_eq!(delivered.len(), 2, "both events still delivered");
        assert_eq!(delivered[0].r#type, "key");
        assert_eq!(
            delivered[0].key.as_ref().expect("key").char.as_deref(),
            Some("c")
        );
    }

    #[test]
    fn is_ctrl_c_matches_ctrl_char_c_only() {
        let ctrl_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false));
        assert!(is_ctrl_c(&ctrl_c));
        // Not ctrl: a plain 'c'.
        let plain_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), false, false, false));
        assert!(!is_ctrl_c(&plain_c));
        // Ctrl but not 'c'.
        let ctrl_q = TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), true, false, false));
        assert!(!is_ctrl_c(&ctrl_q));
        // Non-key events are never ctrl+c.
        assert!(!is_ctrl_c(&TernEvent::Resize { w: 80, h: 24 }));
        assert!(!is_ctrl_c(&TernEvent::FocusGained));
    }
}
