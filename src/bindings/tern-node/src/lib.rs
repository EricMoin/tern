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
//!   methods (`add_child` / `remove` / `set_props` / `set_prop`) mutate the
//!   shared scene tree that `TuiRenderer::render` paints.
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
use std::io;
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
use tern_core::cell::CellUpdate;
use tern_core::rect::Rect;
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

/// Sentinel for [`RendererInner::last_viewport`]: no render has painted yet.
/// A real terminal is never 0 columns by 0 rows, so this doubles as the
/// "a viewport was already recorded" guard that keeps a fresh renderer from
/// taking the no-op fast path before its first paint.
const NO_VIEWPORT: (u16, u16) = (0, 0);

/// The backend surface [`TuiRenderer`] talks to, split out so unit tests can
/// inject a counting mock and prove the no-op render fast path performs zero
/// terminal writes. [`Backend`] implements this with real terminal I/O; the
/// tests substitute a mock whose counters record every call.
trait RenderBackend: Send + Sync {
    /// The terminal size as `(columns, rows)`.
    fn size(&self) -> io::Result<(u16, u16)>;
    /// Flush a diff of cell updates to the terminal, recording the park
    /// position so an empty no-op frame can skip the flush entirely. Returns
    /// the number of bytes queued to the terminal (the frame's ANSI
    /// escape-sequence stream; 0 for a fully suppressed frame).
    fn flush_diff(&mut self, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> io::Result<usize>;
    /// Set the terminal window title (OSC 0).
    fn set_title(&self, title: &str) -> io::Result<()>;
    /// Copy `text` to the system clipboard (OSC 52).
    fn set_clipboard(&self, text: &str) -> io::Result<()>;
    /// Stop mouse / focus-change / bracketed-paste event reporting.
    fn disable_event_listening(&self) -> io::Result<()>;
    /// Leave the alternate screen.
    fn exit_alt_screen(&self) -> io::Result<()>;
    /// Leave raw mode.
    fn exit_raw_mode(&self) -> io::Result<()>;
}

impl RenderBackend for Backend {
    fn size(&self) -> io::Result<(u16, u16)> {
        Backend::size(self)
    }

    fn flush_diff(&mut self, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> io::Result<usize> {
        Backend::flush_diff(self, updates, cursor_pos)
    }

    fn set_title(&self, title: &str) -> io::Result<()> {
        Backend::set_title(self, title)
    }

    fn set_clipboard(&self, text: &str) -> io::Result<()> {
        Backend::set_clipboard(self, text)
    }

    fn disable_event_listening(&self) -> io::Result<()> {
        Backend::disable_event_listening(self)
    }

    fn exit_alt_screen(&self) -> io::Result<()> {
        Backend::exit_alt_screen(self)
    }

    fn exit_raw_mode(&self) -> io::Result<()> {
        Backend::exit_raw_mode(self)
    }
}

/// An in-memory [`RenderBackend`] for headless renderers: `size()` reports
/// the configured virtual size (default 80x24) and every terminal operation
/// is a no-op. A [`TuiRenderer`] constructed with `headless: true` uses this
/// so it never touches a real terminal — no raw mode, alternate screen, event
/// listening, or title — which lets rendering and snapshots run under plain
/// `cargo test`, in CI, and in snapshot tooling with no TTY present.
struct HeadlessBackend {
    size: (u16, u16),
}

impl HeadlessBackend {
    fn new(width: u32, height: u32) -> Self {
        // Clamp into the u16 cell range and floor at 1x1: a zero-sized
        // virtual terminal would make every paint a degenerate viewport.
        let w = width.clamp(1, u16::MAX as u32) as u16;
        let h = height.clamp(1, u16::MAX as u32) as u16;
        Self { size: (w, h) }
    }
}

impl RenderBackend for HeadlessBackend {
    fn size(&self) -> io::Result<(u16, u16)> {
        Ok(self.size)
    }

    fn flush_diff(
        &mut self,
        _updates: &[CellUpdate],
        _cursor_pos: (u16, u16),
    ) -> io::Result<usize> {
        // Headless frames are never flushed to a terminal; report 0 bytes so
        // `last_flush_bytes` stays honest about the absent I/O.
        Ok(0)
    }

    fn set_title(&self, _title: &str) -> io::Result<()> {
        Ok(())
    }

    fn set_clipboard(&self, _text: &str) -> io::Result<()> {
        Ok(())
    }

    fn disable_event_listening(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_alt_screen(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_raw_mode(&self) -> io::Result<()> {
        Ok(())
    }
}

/// Convert a painted buffer to one string per row, mapping masked
/// continuation cells (the zero-width right halves of wide glyphs) to spaces
/// so every row has exactly `buffer.width` display columns. Multi-width
/// aware by construction: a 2-column glyph (a wide character or a grapheme
/// cluster) occupies its lead cell plus the masked neighbor, so the row string
/// keeps the buffer's true display width. A multi-char cluster (a ZWJ emoji,
/// a combining sequence) contributes its full symbol string, so the row
/// reconstructs the cluster as it renders.
fn buffer_rows(buffer: &Buffer) -> Vec<String> {
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| {
                    buffer.cell(x, y).map_or_else(
                        || " ".to_string(),
                        |cell| {
                            if cell.is_masked() {
                                " ".to_string()
                            } else {
                                cell.symbol_str().into_owned()
                            }
                        },
                    )
                })
                .collect()
        })
        .collect()
}

/// The exposed style of a painted cell — the fields [`StyleRunJs`] carries:
/// fg, bg, and the six surfaced modifiers. Two adjacent cells merge into one
/// run exactly when their `RunStyle` keys are equal; border style and the
/// unsurfaced blink/hidden modifiers do not split runs, so an uncolored
/// box's border cells stay one run with its surrounding default-styled
/// blanks. A set `border_color` paints the border glyphs with that color as
/// their foreground (see `paint_box`), so a colored border surfaces as its
/// own `fg`-carrying run — the styled snapshot reports it through `fg`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RunStyle {
    fg: Color,
    bg: Color,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    reversed: bool,
    strikethrough: bool,
}

impl RunStyle {
    /// The exposed style of a painted cell's [`Style`].
    fn of(style: Style) -> Self {
        Self {
            fg: style.fg,
            bg: style.bg,
            bold: style.modifiers.contains(Modifiers::BOLD),
            dim: style.modifiers.contains(Modifiers::DIM),
            italic: style.modifiers.contains(Modifiers::ITALIC),
            underline: style.modifiers.contains(Modifiers::UNDERLINE),
            reversed: style.modifiers.contains(Modifiers::REVERSED),
            strikethrough: style.modifiers.contains(Modifiers::STRIKETHROUGH),
        }
    }

    /// Materialize a [`StyleRunJs`] carrying `text` in this style: colors as
    /// strings, modifier keys present only when set.
    fn to_run(self, text: String) -> StyleRunJs {
        StyleRunJs {
            text,
            fg: color_to_string(self.fg),
            bg: color_to_string(self.bg),
            bold: self.bold.then_some(true),
            dim: self.dim.then_some(true),
            italic: self.italic.then_some(true),
            underline: self.underline.then_some(true),
            reversed: self.reversed.then_some(true),
            strikethrough: self.strikethrough.then_some(true),
        }
    }
}

/// The JS-facing string form of a color: `"#rrggbb"` for truecolor,
/// `"indexed:<n>"` for ANSI palette entries, `None` for the terminal default
/// — the inverse of [`parse_color`].
fn color_to_string(c: Color) -> Option<String> {
    match c {
        Color::Default => None,
        Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
        Color::Indexed(n) => Some(format!("indexed:{n}")),
    }
}

/// Convert a painted buffer to one vector of styled runs per row: adjacent
/// cells with identical exposed style (see [`RunStyle`]) merge into a single
/// run. Masked continuation cells map to spaces exactly like [`buffer_rows`],
/// so concatenating each row's run texts reconstructs the row string
/// [`buffer_rows`] produces — the styled snapshot is the styled counterpart
/// of the plain one, never a different text.
fn buffer_runs(buffer: &Buffer) -> Vec<Vec<StyleRunJs>> {
    (0..buffer.height)
        .map(|y| {
            let mut runs: Vec<(RunStyle, String)> = Vec::new();
            for x in 0..buffer.width {
                let cell = buffer.cell(x, y).expect("cell in bounds");
                let text = if cell.is_masked() {
                    " ".to_string()
                } else {
                    cell.symbol_str().into_owned()
                };
                let style = RunStyle::of(cell.style);
                if let Some((last_style, last_text)) = runs.last_mut() {
                    if *last_style == style {
                        last_text.push_str(&text);
                        continue;
                    }
                }
                runs.push((style, text));
            }
            runs.into_iter()
                .map(|(style, text)| style.to_run(text))
                .collect()
        })
        .collect()
}

/// Paint `scene` at `viewport` through a fresh compositor with `selection`
/// synced — the renderer's current selection overlay — and return the frame
/// buffer. `Some((anchor, active))` applies the overlay (the compositor
/// normalizes the endpoints); `None` paints without one (the default, so
/// unselected snapshots are byte-identical to before the overlay existed).
/// Both snapshot conversions — [`buffer_rows`] (plain strings) and
/// [`buffer_runs`] (styled runs) — feed from this single paint path, so the
/// styled snapshot and the plain one always agree on what was painted.
fn paint_scene_buffer(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Buffer {
    let mut compositor = Compositor::new();
    match selection {
        Some((anchor, active)) => compositor.set_selection(anchor, active),
        None => compositor.clear_selection(),
    }
    compositor.paint_scene(scene, viewport)
}

/// Paint `scene` at `viewport` with `selection` synced and return the frame
/// as one string per row. The overlay is style-only, so the returned rows
/// carry the same text with or without it — the snapshot is where a styled
/// consumer would observe the selection. Performs no terminal I/O; the pure
/// snapshot both [`TuiRenderer::render_to_buffer`] and its unit tests use,
/// so the tested path is the shipped path.
fn paint_scene_rows_with_selection(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Vec<String> {
    buffer_rows(&paint_scene_buffer(scene, viewport, selection))
}

/// Paint `scene` at `viewport` with `selection` synced and return the frame
/// as one vector of styled runs per row — the styled counterpart of
/// [`paint_scene_rows_with_selection`], sharing its paint path and viewport
/// semantics.
fn paint_scene_runs_with_selection(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Vec<Vec<StyleRunJs>> {
    buffer_runs(&paint_scene_buffer(scene, viewport, selection))
}

/// The laid-out content size of a scene node, in cells.
#[napi(object)]
pub struct ContentSize {
    /// The content width in cells.
    pub width: u32,
    /// The content height in cells.
    pub height: u32,
}

/// The terminal size reported by a [`TuiRenderer`]: `{ width, height }` in
/// cells.
#[napi(object)]
#[derive(Debug)]
pub struct RendererSize {
    /// The width in columns.
    pub width: u32,
    /// The height in rows.
    pub height: u32,
}

/// An inclusive cell range, in viewport coordinates: the rectangle spanned
/// by (`col1`, `row1`) and (`col2`, `row2`). Either endpoint may be the
/// top-left; consumers normalize with `min`/`max`.
#[napi(object)]
#[derive(Debug)]
pub struct SelectionRange {
    /// The column of one endpoint (inclusive).
    pub col1: u32,
    /// The row of one endpoint (inclusive).
    pub row1: u32,
    /// The column of the other endpoint (inclusive).
    pub col2: u32,
    /// The row of the other endpoint (inclusive).
    pub row2: u32,
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

/// One styled run in a [`TuiRenderer::render_to_buffer_styled`] snapshot row:
/// the run's text plus the style keys its cells share. Adjacent cells with
/// identical style merge into one run, so concatenating a row's run texts
/// reconstructs the whole row (masked continuation cells as spaces, exactly
/// like the plain [`TuiRenderer::render_to_buffer`]).
///
/// Colors surface as `"#rrggbb"` (truecolor) or `"indexed:<n>"` (ANSI
/// palette) strings; every modifier key is present only when set, so an
/// unstyled run carries just `text`.
#[napi(object)]
#[derive(Debug, PartialEq, Eq)]
pub struct StyleRunJs {
    /// The run's text content.
    pub text: String,
    /// The foreground color, when the cells carry one.
    pub fg: Option<String>,
    /// The background color, when the cells carry one.
    pub bg: Option<String>,
    /// Whether the run is bold.
    pub bold: Option<bool>,
    /// Whether the run is dim.
    pub dim: Option<bool>,
    /// Whether the run is italic.
    pub italic: Option<bool>,
    /// Whether the run is underlined.
    pub underline: Option<bool>,
    /// Whether the run is reversed (fg/bg swapped).
    pub reversed: Option<bool>,
    /// Whether the run is struck through.
    pub strikethrough: Option<bool>,
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
    /// When `true`, the renderer never touches a terminal: no raw mode, no
    /// alternate screen, no event listening, no title. Rendering and
    /// snapshots run against an in-memory buffer of the configured `width` x
    /// `height` (default 80x24), so construction and rendering succeed
    /// without a TTY (plain `cargo test`, CI, snapshot tooling). Default
    /// `false`.
    #[napi(js_name = "headless")]
    pub headless: Option<bool>,
    /// The virtual width in cells for `headless` mode (default 80). Ignored
    /// when `headless` is `false`.
    #[napi(js_name = "width")]
    pub width: Option<u32>,
    /// The virtual height in cells for `headless` mode (default 24). Ignored
    /// when `headless` is `false`.
    #[napi(js_name = "height")]
    pub height: Option<u32>,
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
    backend: Box<dyn RenderBackend>,
    /// The stateful compositor, held across frames: it owns the layout
    /// engine, which owns the cached taffy tree and the last layout results
    /// (structural preparation — every frame still recomputes this phase).
    compositor: Compositor,
    scene: Arc<Mutex<Scene>>,
    last: Option<Buffer>,
    /// The scene epoch at the most recent successful paint. A render whose
    /// scene epoch still matches — and whose viewport is unchanged — has
    /// nothing new to draw and returns without touching the terminal.
    last_painted_epoch: u64,
    /// The viewport the last successful render painted at; [`NO_VIEWPORT`]
    /// before any render. Doubles as the "a viewport was already recorded"
    /// guard: a fresh renderer must not take the no-op fast path before its
    /// first paint.
    last_viewport: (u16, u16),
    /// The viewport the most recent paint — a [`TuiRenderer::render`] or a
    /// [`TuiRenderer::render_to_buffer`] snapshot — painted at; [`NO_VIEWPORT`]
    /// before any paint. The surface behind [`TuiRenderer::size`]: before the
    /// first paint the size getter seeds it from the terminal through the
    /// cached-size machinery instead of reporting the synthetic 80x24
    /// fallback. Kept per-renderer (unlike the shared scene viewport) so a
    /// snapshot's viewport never leaks into another renderer's state.
    last_painted_viewport: (u16, u16),
    /// The renderer's selection overlay: the inclusive cell rect
    /// (`x1`, `y1`, `x2`, `y2`) in viewport coordinates, or `None` when no
    /// selection is set. Per-renderer state (like `last_painted_viewport`) —
    /// deliberately NOT on the shared module-global scene, so one renderer's
    /// selection never leaks into another's paint. Synced into the compositor
    /// before every paint and snapshot.
    selection: Option<(u16, u16, u16, u16)>,
    /// The selection the last successful render painted at. A different
    /// selection now invalidates the render fast path: the next render must
    /// repaint so the overlay reaches the terminal.
    last_painted_selection: Option<(u16, u16, u16, u16)>,
    /// The terminal size as last probed, cached so the hot render path skips
    /// the per-frame `backend.size()` ioctl. `None` before the first probe or
    /// after a resize event invalidated it; [`TuiRenderer::render`] and
    /// [`TuiRenderer::hit_test`] re-query the backend only when it is `None`
    /// (first use or post-invalidation), and refresh it from the probe.
    cached_size: Option<(u16, u16)>,
    /// The number of bytes the most recent [`TuiRenderer::render`] flush
    /// queued to the terminal (the frame's ANSI escape-sequence stream; 0 for
    /// a fully suppressed frame). Fed by the backend queue via the flush
    /// return value; unchanged by a no-op fast-path render (which never
    /// flushes), so the counter always describes the last real flush.
    last_flush_bytes: u64,
    #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
    exit_on_ctrl_c: bool,
    /// Whether the alternate screen was entered: `false` renders inline in
    /// the main screen, so teardown must skip `exit_alt_screen` to match.
    use_alt_screen: bool,
    /// Whether this is a headless renderer: it never entered raw mode, the
    /// alternate screen, event listening, or a window title (its backend is
    /// an in-memory no-op), so `destroy` must skip terminal teardown.
    headless: bool,
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
        let headless = options.headless.unwrap_or(false);
        // A headless renderer never touches a terminal: no raw mode, no
        // alternate screen, no event listening, no title. Its in-memory
        // backend reports the configured virtual size (default 80x24) and
        // no-ops every terminal operation, so construction succeeds without a
        // TTY. `use_alt_screen` is forced off so `destroy` skips the
        // alternate-screen teardown to match (the no-op backend would swallow
        // it either way).
        let (backend, use_alt_screen) = if headless {
            (
                Box::new(HeadlessBackend::new(
                    options.width.unwrap_or(80),
                    options.height.unwrap_or(24),
                )) as Box<dyn RenderBackend>,
                false,
            )
        } else {
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
            (
                Box::new(Backend::new()) as Box<dyn RenderBackend>,
                use_alt_screen,
            )
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(RendererInner {
                backend,
                compositor: Compositor::new(),
                scene: shared_scene().clone(),
                last: None,
                last_painted_epoch: 0,
                last_viewport: NO_VIEWPORT,
                last_painted_viewport: NO_VIEWPORT,
                selection: None,
                last_painted_selection: None,
                cached_size: None,
                last_flush_bytes: 0,
                #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
        exit_on_ctrl_c: options.exit_on_ctrl_c.unwrap_or(false),
                use_alt_screen,
                headless,
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
        // Serve the terminal size from the cache when it is still valid;
        // re-query the backend only when the cache is empty (first use or a
        // resize event invalidated it), and refresh the cache from the probe
        // so the next render skips the ioctl too.
        let (w, h) = match inner.cached_size {
            Some((w, h)) => (w, h),
            None => inner
                .backend
                .size()
                .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?,
        };
        inner.cached_size = Some((w, h));
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
    ///
    /// No-op fast path: when the scene has not mutated since the last paint
    /// and the viewport is unchanged, the previous frame is still on screen,
    /// so the render returns `Ok(())` without the size probe, paint, diff,
    /// flush, or buffer storage — zero terminal writes for an unchanged
    /// frame (the high-frame-rate path: JS re-renders every animation tick,
    /// but only real changes pay for I/O).
    #[napi(js_name = "render")]
    pub fn render(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let scene_epoch = inner.scene.lock().expect("scene poisoned").epoch();
        let (cached_w, cached_h) = *shared_viewport_ref().lock().expect("viewport poisoned");
        // The fast path additionally requires a valid size cache: a resize
        // event invalidates it (sets `None`), so the next render falls
        // through and repaints at the re-queried terminal size instead of
        // skipping a frame whose viewport changed. A selection edit also
        // falls through: the terminal shows the previous frame's overlay, so
        // the new selection must be painted.
        if inner.last_viewport != NO_VIEWPORT
            && inner.cached_size.is_some()
            && inner.last_painted_epoch == scene_epoch
            && inner.last_viewport == (cached_w as u16, cached_h as u16)
            && inner.last_painted_selection == inner.selection
        {
            return Ok(());
        }
        // Serve the terminal size from the cache when it is still valid;
        // re-query the backend only on the first probe or after a resize
        // event invalidated the cache, and refresh the cache from the probe.
        let (w, h) = match inner.cached_size {
            Some((w, h)) => (w, h),
            None => inner
                .backend
                .size()
                .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?,
        };
        inner.cached_size = Some((w, h));
        // Remember the viewport for `NodeHandle.content_size`, so its layout
        // matches the geometry that was just painted.
        *shared_viewport_ref().lock().expect("viewport poisoned") = (w as u32, h as u32);
        let viewport = Size::new(w, h);
        // Sync the renderer's per-renderer selection into the compositor so
        // the painted frame carries the overlay. The compositor treats a
        // selection change as a full-repaint invalidation, so the retained
        // frame can never keep a stale overlay.
        match inner.selection {
            Some((x1, y1, x2, y2)) => inner.compositor.set_selection((x1, y1), (x2, y2)),
            None => inner.compositor.clear_selection(),
        }
        let scene = inner.scene.clone();
        let (buffer, painted_epoch) = {
            let scene_guard = scene.lock().expect("scene poisoned");
            let buffer = inner.compositor.paint_scene(&scene_guard, viewport);
            // Record the epoch under the same lock that painted the frame, so
            // the cached value always describes the painted state.
            let painted_epoch = scene_guard.epoch();
            (buffer, painted_epoch)
        };
        let updates = match &inner.last {
            Some(prev) => buffer.diff_from(prev),
            None => diff(&Buffer::new(w, h), &buffer),
        };
        let flushed = inner
            .backend
            .flush_diff(&updates, (0, 0))
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?;
        inner.last_flush_bytes = flushed as u64;
        inner.last = Some(buffer);
        inner.last_painted_epoch = painted_epoch;
        inner.last_viewport = (w, h);
        inner.last_painted_viewport = (w, h);
        inner.last_painted_selection = inner.selection;
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
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (vw, vh) = *shared_viewport_ref().lock().expect("viewport poisoned");
        let w = width.map(|w| w as u16).unwrap_or(vw as u16);
        let h = height.map(|h| h as u16).unwrap_or(vh as u16);
        // Record the snapshot's viewport as the renderer's last painted
        // viewport, so a later `size()` reports what the most recent render
        // or snapshotFrame painted at (per-renderer state — the shared scene
        // viewport stays on the last real render, which is what the
        // no-argument snapshot and `content_size` default to).
        inner.last_painted_viewport = (w, h);
        let viewport = Size::new(w, h);
        let selection = inner
            .selection
            .map(|(x1, y1, x2, y2)| ((x1, y1), (x2, y2)));
        let scene = inner.scene.clone();
        let rows = {
            let scene_guard = scene.lock().expect("scene poisoned");
            paint_scene_rows_with_selection(&scene_guard, viewport, selection)
        };
        Ok(rows)
    }

    /// Paint the shared scene into a fresh buffer at the given viewport —
    /// `width`/`height` in cells, each defaulting to the most recent
    /// [`render`](Self::render) terminal size — and return the frame as one
    /// vector of styled runs per row. Each run is `{ text, fg?, bg?, bold?,
    /// dim?, italic?, underline?, reversed?, strikethrough? }`; adjacent cells
    /// with identical style merge into one run, and concatenating a row's run
    /// texts reconstructs the [`render_to_buffer`](Self::render_to_buffer)
    /// row string exactly (masked/continuation cells are spaces, multi-width
    /// aware). Colors surface as `"#rrggbb"` (truecolor) or `"indexed:<n>"`
    /// (palette) strings; modifier keys are present only when set. Shares
    /// [`render_to_buffer`](Self::render_to_buffer)'s paint path and viewport
    /// recording semantics (and its destroyed-renderer error); performs no
    /// terminal I/O, so the result is a pure styled snapshot for JS-side
    /// testing and golden comparisons.
    #[napi(js_name = "render_to_buffer_styled")]
    pub fn render_to_buffer_styled(
        &self,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<Vec<Vec<StyleRunJs>>> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (vw, vh) = *shared_viewport_ref().lock().expect("viewport poisoned");
        let w = width.map(|w| w as u16).unwrap_or(vw as u16);
        let h = height.map(|h| h as u16).unwrap_or(vh as u16);
        // Record the snapshot's viewport as the renderer's last painted
        // viewport — identical to `render_to_buffer`, so a later `size()`
        // reports the most recent render or snapshot viewport either way.
        inner.last_painted_viewport = (w, h);
        let viewport = Size::new(w, h);
        let selection = inner
            .selection
            .map(|(x1, y1, x2, y2)| ((x1, y1), (x2, y2)));
        let scene = inner.scene.clone();
        let rows = {
            let scene_guard = scene.lock().expect("scene poisoned");
            paint_scene_runs_with_selection(&scene_guard, viewport, selection)
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
        // A headless renderer never entered raw mode, the alternate screen,
        // event listening, or a title — there is nothing to tear down (its
        // in-memory backend would no-op these anyway).
        if !inner.headless {
            let _ = inner.backend.disable_event_listening();
            if inner.use_alt_screen {
                let _ = inner.backend.exit_alt_screen();
            }
            let _ = inner.backend.exit_raw_mode();
        }
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

    /// The number of bytes the most recent `render()` flush queued to the
    /// terminal: the ANSI escape-sequence stream for that frame's diff (0 for
    /// a fully suppressed empty-diff frame). Fed by the backend queue via the
    /// flush return value; a no-op fast-path render (scene unchanged) never
    /// flushes, so the counter keeps the previous flush's value until the next
    /// real flush. The byte-cost measure behind the bench's
    /// flushed-bytes-per-frame numbers.
    #[napi(getter, js_name = "last_flush_bytes")]
    pub fn last_flush_bytes(&self) -> u64 {
        self.inner
            .lock()
            .expect("renderer inner poisoned")
            .last_flush_bytes
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

    /// The terminal size as `{ width, height }` in cells: the viewport the
    /// most recent [`render`](Self::render) or
    /// [`render_to_buffer`](Self::render_to_buffer) painted at (80x24 before
    /// any paint).
    ///
    /// Before the first paint no real viewport exists yet, so the first
    /// access seeds the default from the terminal through the cached-size
    /// machinery — the cache when it is still valid, otherwise a
    /// [`RenderBackend::size`] probe (refreshing the cache) — and records the
    /// probed size as the shared scene viewport: a fresh renderer reports the
    /// current terminal size instead of the synthetic 80x24 fallback, and its
    /// snapshot/content-size defaults match. After any paint the last painted
    /// viewport is authoritative and no probe happens. Errors on a destroyed
    /// renderer.
    #[napi(getter, js_name = "size")]
    pub fn size(&self) -> Result<RendererSize> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (w, h) = if inner.last_painted_viewport != NO_VIEWPORT {
            inner.last_painted_viewport
        } else {
            // No paint yet: surface the current terminal size through the
            // cached-size machinery (cache when valid, otherwise a probe that
            // refreshes the cache), and record it as the shared scene
            // viewport so the renderer's defaults match.
            let (pw, ph) = match inner.cached_size {
                Some((w, h)) => (w, h),
                None => inner
                    .backend
                    .size()
                    .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?,
            };
            inner.cached_size = Some((pw, ph));
            *shared_viewport_ref().lock().expect("viewport poisoned") = (pw as u32, ph as u32);
            (pw, ph)
        };
        Ok(RendererSize {
            width: w as u32,
            height: h as u32,
        })
    }

    /// Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
    /// BEL`, the payload being the text's UTF-8 bytes base64-encoded). Errors
    /// on a destroyed renderer.
    #[napi(js_name = "set_clipboard")]
    pub fn set_clipboard(&self, text: String) -> Result<()> {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        inner
            .backend
            .set_clipboard(&text)
            .map_err(|e| Error::from_reason(format!("set clipboard: {e}")))
    }

    /// Set the selection overlay to the inclusive rectangle spanned by
    /// (`col1`, `row1`) and (`col2`, `row2`) in viewport cells. The endpoints
    /// are normalized by the compositor, so either may be the top-left. The
    /// overlay is applied at the next [`render`](Self::render) (which the
    /// selection edit forces) and to the next
    /// [`render_to_buffer`](Self::render_to_buffer) snapshot. Per-renderer
    /// state — the shared scene never carries the selection. Errors on a
    /// destroyed renderer.
    #[napi(js_name = "set_selection")]
    pub fn set_selection(&self, col1: u32, row1: u32, col2: u32, row2: u32) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        inner.selection = Some((col1 as u16, row1 as u16, col2 as u16, row2 as u16));
        Ok(())
    }

    /// Clear the selection overlay: the next render paints without any
    /// reversed selection cells (and the next snapshot omits the overlay).
    /// Errors on a destroyed renderer.
    #[napi(js_name = "clear_selection")]
    pub fn clear_selection(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        inner.selection = None;
        Ok(())
    }

    /// The text of the renderer's current selection, extracted from the last
    /// painted frame (the frame the most recent [`render`](Self::render)
    /// produced): row-major and cluster/mask-aware — a multi-char cluster
    /// (ZWJ emoji, combining sequence, flag) contributes its whole symbol, a
    /// masked continuation cell contributes nothing, and rows are joined
    /// with `'\n'`. An empty string when no selection is set or nothing has
    /// been rendered yet. Errors on a destroyed renderer.
    #[napi(js_name = "selection_text")]
    pub fn selection_text(&self) -> Result<String> {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let Some((x1, y1, x2, y2)) = inner.selection else {
            return Ok(String::new());
        };
        let Some(last) = &inner.last else {
            return Ok(String::new());
        };
        let (ax, ay) = (x1.min(x2), y1.min(y2));
        let (bx, by) = (x1.max(x2), y1.max(y2));
        let rect = Rect::new(ax as i32, ay as i32, (bx - ax) as u32 + 1, (by - ay) as u32 + 1);
        Ok(last.text_in(rect))
    }

    /// The inclusive cell range of the contiguous non-whitespace run (word)
    /// containing (`col`, `row`) in the last painted frame, or `null` when
    /// the cell is blank/whitespace (or out of bounds, or nothing has been
    /// rendered yet).
    ///
    /// Cluster-aware: a masked continuation cell (the right half of a wide
    /// glyph) is treated as part of its glyph's run — never as whitespace —
    /// so a click on a wide character's second column still returns the word
    /// that contains the glyph. Errors on a destroyed renderer.
    #[napi(js_name = "selection_word_range")]
    pub fn selection_word_range(&self, col: u32, row: u32) -> Result<Option<SelectionRange>> {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let Some(last) = &inner.last else {
            return Ok(None);
        };
        if col >= last.width as u32 || row >= last.height as u32 {
            return Ok(None);
        }
        let col = col as u16;
        let row = row as u16;
        // A word cell is any non-whitespace symbol; a masked continuation
        // cell's symbol is NUL (never whitespace), so the run extends across
        // wide glyphs' right halves to cover the whole glyph.
        let is_word = |x: u16| -> bool {
            let Some(cell) = last.cell(x, row) else {
                return false;
            };
            !cell.symbol_str().chars().all(|c| c.is_whitespace())
        };
        if !is_word(col) {
            return Ok(None);
        }
        let mut left = col;
        while left > 0 && is_word(left - 1) {
            left -= 1;
        }
        let mut right = col;
        while right + 1 < last.width && is_word(right + 1) {
            right += 1;
        }
        Ok(Some(SelectionRange {
            col1: left as u32,
            row1: row as u32,
            col2: right as u32,
            row2: row as u32,
        }))
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
            if inner.headless {
                // A headless renderer has no terminal to read events from.
                return Err(Error::from_reason(
                    "headless renderer does not support event streaming",
                ));
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
            // A resize event invalidates the cached terminal size so the next
            // render re-queries the backend instead of painting at the stale
            // viewport (see `invalidate_size_on_resize`).
            invalidate_size_on_resize(&inner_for_loop, &event);
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
        if inner.headless {
            // A headless renderer has no terminal to poll events from.
            return Err(Error::from_reason(
                "headless renderer does not support event polling",
            ));
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
            // A resize event invalidates the cached terminal size so the next
            // render re-queries the backend (the guard is already held here,
            // mirroring `invalidate_size_on_resize`).
            if matches!(ev, TernEvent::Resize { .. }) {
                inner.cached_size = None;
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
    /// Recognized style keys are lifted out of the props object: `fg`, `bg`,
    /// `border_color` (color strings), `border_style`
    /// (`none|plain|rounded|double|thick`), and the boolean modifiers
    /// (`bold`, `dim`, `italic`, `underline`, `blink`, `reversed`, `hidden`,
    /// `strikethrough`). Every other key lands in the node's property map
    /// (`text`, layout keywords, ...).
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

    /// Set a single property (or style key) on this node — the incremental
    /// counterpart of [`set_props`](Self::set_props): one key instead of the
    /// whole object.
    ///
    /// Recognized style keys (`fg`, `bg`, `border_color`, `border_style`, the
    /// boolean modifiers) are merged into the node's existing style; every
    /// other scalar key lands in the node's property map. Non-scalar values
    /// (null, arrays, objects) are dropped, exactly like `set_props`.
    ///
    /// An equal-value write is a no-op: the scene is not mutated and its
    /// epoch is not bumped, so a renderer's cached frame stays valid.
    #[napi(js_name = "set_prop")]
    pub fn set_prop(&self, key: String, value: serde_json::Value) -> Result<()> {
        let mut inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            // Detached template: record the single-key change for
            // materialization (`add_child` snapshots `kind`/`style`/`props`).
            if let Some(style) = apply_style_key(inner.style, &key, &value) {
                inner.style = style;
            } else if let Some(pv) = json_to_prop_value(value) {
                inner.props.insert(key, pv);
            }
            return Ok(());
        };
        // Clone the scene handle so the lock below does not hold `inner`
        // borrowed while the handle's own fields are mutated.
        let scene_arc = inner.scene.clone();
        let mut scene = scene_arc.lock().expect("scene poisoned");
        if let Some(style) = apply_style_key(inner.style, &key, &value) {
            if style != inner.style {
                inner.style = style;
                scene.set_style(id, style);
            }
            return Ok(());
        }
        let Some(pv) = json_to_prop_value(value) else {
            return Ok(()); // non-scalar values are dropped, like set_props
        };
        if scene.prop(id, &key) != Some(&pv) {
            inner.props.insert(key.clone(), pv.clone());
            scene.set_prop(id, &key, pv);
        }
        Ok(())
    }

    /// Append a styled span of text to a `streaming_text` node's stream.
    ///
    /// `style` follows the same style-key convention as `set_props` (`fg`,
    /// `bg`, `border_color`, `border_style`, and the boolean modifiers are
    /// lifted into the span's style; every other key is ignored). The span is
    /// appended to the node's accumulated stream in the shared scene, in call
    /// order. Errors when the node is detached from the scene or is not a
    /// `streaming_text` node.
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

/// Invalidate the cached terminal size when a resize event arrives: the next
/// [`TuiRenderer::render`] / [`TuiRenderer::hit_test`] re-queries the backend
/// instead of painting or hit-testing at the stale viewport. Called from the
/// event delivery paths (the push event loop's callback and the poll
/// fallback) for every delivered event; a no-op for non-resize events.
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
fn invalidate_size_on_resize(inner: &Mutex<RendererInner>, event: &TernEvent) {
    if matches!(event, TernEvent::Resize { .. }) {
        if let Ok(mut inner) = inner.lock() {
            inner.cached_size = None;
        }
    }
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
/// map (everything else). The style is built from scratch over the recognized
/// style keys — a full-map replacement (see [`apply_style_key`] for the
/// single-key merge variant).
fn props_to_style_map(props: HashMap<String, serde_json::Value>) -> (Style, PropMap) {
    let mut style = Style::new();
    let mut map = PropMap::new();
    for (key, value) in props {
        match apply_style_key(style, &key, &value) {
            Some(updated) => style = updated,
            None => {
                let Some(pv) = json_to_prop_value(value) else {
                    continue;
                };
                map.insert(key, pv);
            }
        }
    }
    (style, map)
}

/// Apply a single style key to `style` (merge semantics), mirroring
/// `props_to_style_map`'s per-key handling. Returns `Some` when `key` is a
/// recognized style key, `None` when it is a regular prop key.
///
/// Unlike the full-map path — which rebuilds the style from scratch over the
/// given keys — this merges `key`'s effect into the existing style, so the
/// single-key `set_prop` path leaves every other style field untouched. A
/// boolean modifier key with a `false` (or non-true) value clears the
/// modifier, matching what the full-map path produces for the same key (a
/// freshly rebuilt style simply lacks it).
fn apply_style_key(mut style: Style, key: &str, value: &serde_json::Value) -> Option<Style> {
    match key {
        "border_style" => {
            if let serde_json::Value::String(s) = value {
                style = style.border_style(parse_border_style(s));
            }
        }
        "border_color" => {
            if let serde_json::Value::String(s) = value {
                style = style.border_color(parse_color(s));
            }
        }
        "fg" => {
            if let serde_json::Value::String(s) = value {
                style = style.fg(parse_color(s));
            }
        }
        "bg" => {
            if let serde_json::Value::String(s) = value {
                style = style.bg(parse_color(s));
            }
        }
        "bold" => style = apply_modifier(style, value, Modifiers::BOLD),
        "dim" => style = apply_modifier(style, value, Modifiers::DIM),
        "italic" => style = apply_modifier(style, value, Modifiers::ITALIC),
        "underline" => style = apply_modifier(style, value, Modifiers::UNDERLINE),
        "blink" => style = apply_modifier(style, value, Modifiers::BLINK),
        "reversed" => style = apply_modifier(style, value, Modifiers::REVERSED),
        "hidden" => style = apply_modifier(style, value, Modifiers::HIDDEN),
        "strikethrough" => style = apply_modifier(style, value, Modifiers::STRIKETHROUGH),
        _ => return None,
    }
    Some(style)
}

/// Set or clear `modifier` on `style` from a JSON value: `true` adds it,
/// anything else removes it (the full-map path builds a fresh style where a
/// non-true modifier is simply absent, so the single-key path must clear the
/// modifier to stay equivalent).
fn apply_modifier(style: Style, value: &serde_json::Value, modifier: Modifiers) -> Style {
    if value.as_bool() == Some(true) {
        style.add_modifier(modifier)
    } else {
        style.modifier(style.modifiers.remove(modifier))
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
    use std::sync::atomic::{AtomicUsize, Ordering};
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
            ("border_color".to_string(), serde_json::json!("#00ff00")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
            ("hidden".to_string(), serde_json::json!(true)),
            ("nested".to_string(), serde_json::json!({"a": 1})), // dropped
        ]);
        let (style, map) = props_to_style_map(props);
        assert_eq!(style.border_style, BorderStyle::Rounded);
        assert_eq!(style.border_color, _Color::Rgb(0, 255, 0));
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

    /// A root handle materialized over a fresh scene, for handle tests.
    fn root_handle(scene: &Arc<Mutex<Scene>>) -> NodeHandle {
        let root_id = scene.lock().expect("scene poisoned").root_id();
        NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        )
    }

    #[test]
    fn set_prop_updates_a_single_key_on_an_attached_node() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let text = root.add_child(&text_template()).expect("add text");

        text.set_prop("text".to_string(), serde_json::json!("hi"))
            .expect("set_prop succeeds");
        let s = scene.lock().expect("scene poisoned");
        assert_eq!(
            s.prop(attached_id(&text), "text"),
            Some(&PropValue::Str("hi".to_string()))
        );
        // The handle's prop mirror stays in sync (the materialization source).
        assert_eq!(
            text.inner
                .lock()
                .expect("node inner poisoned")
                .props
                .get("text"),
            Some(&PropValue::Str("hi".to_string()))
        );
    }

    #[test]
    fn set_prop_style_key_merges_into_the_existing_style() {
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let text = root.add_child(&text_template()).expect("add text");

        text.set_props(HashMap::from([(
            "fg".to_string(),
            serde_json::json!("#ff0000"),
        )]))
        .expect("set_props succeeds");
        text.set_prop("bold".to_string(), serde_json::json!(true))
            .expect("set_prop succeeds");

        let s = scene.lock().expect("scene poisoned");
        let node = s.node(attached_id(&text)).expect("node in scene");
        assert_eq!(
            node.style.fg,
            _Color::Rgb(255, 0, 0),
            "fg survives the merge"
        );
        assert!(node.style.modifiers.contains(Modifiers::BOLD));
    }

    #[test]
    fn set_prop_false_modifier_clears_the_modifier_like_the_full_path() {
        // The full-map path rebuilds the style from the given keys, so
        // `bold: false` yields a style without bold; the single-key path must
        // produce the same result by clearing the modifier.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let text = root.add_child(&text_template()).expect("add text");

        text.set_props(HashMap::from([
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
        ]))
        .expect("set_props succeeds");
        text.set_prop("bold".to_string(), serde_json::json!(false))
            .expect("set_prop succeeds");

        let s = scene.lock().expect("scene poisoned");
        let node = s.node(attached_id(&text)).expect("node in scene");
        assert!(
            !node.style.modifiers.contains(Modifiers::BOLD),
            "bold must be cleared"
        );
        assert_eq!(node.style.fg, _Color::Rgb(255, 0, 0), "fg stays untouched");
    }

    #[test]
    fn equal_value_set_prop_and_set_props_do_not_bump_the_epoch() {
        // The incremental-sync contract at the binding layer: an equal-value
        // single-key or whole-map write leaves the scene epoch untouched, so
        // the renderer's no-op fast path still applies.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let text = root.add_child(&text_template()).expect("add text");
        text.set_props(HashMap::from([
            ("text".to_string(), serde_json::json!("hi")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
        ]))
        .expect("initial set_props succeeds");
        let epoch = scene.lock().expect("scene poisoned").epoch();

        text.set_prop("text".to_string(), serde_json::json!("hi"))
            .expect("equal set_prop succeeds");
        text.set_prop("fg".to_string(), serde_json::json!("#ff0000"))
            .expect("equal style set_prop succeeds");
        text.set_props(HashMap::from([
            ("text".to_string(), serde_json::json!("hi")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
        ]))
        .expect("equal set_props succeeds");

        assert_eq!(
            scene.lock().expect("scene poisoned").epoch(),
            epoch,
            "equal-value writes must not bump the scene epoch"
        );

        // A changed value does bump.
        text.set_prop("text".to_string(), serde_json::json!("bye"))
            .expect("changed set_prop succeeds");
        assert_eq!(
            scene.lock().expect("scene poisoned").epoch(),
            epoch + 1,
            "a changed set_prop must bump the scene epoch"
        );
    }

    #[test]
    fn set_prop_on_a_detached_template_materializes_with_the_change() {
        // `set_prop` on a detached `create_node` template records the change
        // on the handle; `add_child` materializes it into the scene.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let child = create_node("text".to_string(), None).expect("create text template");
        child
            .set_prop("text".to_string(), serde_json::json!("hi"))
            .expect("set_prop on detached succeeds");
        child
            .set_prop("bold".to_string(), serde_json::json!(true))
            .expect("style set_prop on detached succeeds");

        let bound = root.add_child(&child).expect("add child");
        let s = scene.lock().expect("scene poisoned");
        assert_eq!(
            s.prop(attached_id(&bound), "text"),
            Some(&PropValue::Str("hi".to_string()))
        );
        assert!(
            s.node(attached_id(&bound))
                .expect("node in scene")
                .style
                .modifiers
                .contains(Modifiers::BOLD),
            "the detached style-key write must materialize"
        );
    }

    #[test]
    fn set_prop_drops_non_scalar_values_like_the_full_path() {
        // The full-map path silently drops null/array/object values; the
        // single-key path must too, without touching the scene.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let root = root_handle(&scene);
        let text = root.add_child(&text_template()).expect("add text");
        let epoch = scene.lock().expect("scene poisoned").epoch();

        text.set_prop("nested".to_string(), serde_json::json!({"a": 1}))
            .expect("set_prop with an object value succeeds");
        text.set_prop("missing".to_string(), serde_json::Value::Null)
            .expect("set_prop with null succeeds");

        assert_eq!(
            scene.lock().expect("scene poisoned").epoch(),
            epoch,
            "dropped values must not bump the scene epoch"
        );
        let s = scene.lock().expect("scene poisoned");
        assert!(s.prop(attached_id(&text), "nested").is_none());
        assert!(s.prop(attached_id(&text), "missing").is_none());
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

        let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(rows, vec!["┌──┐  ", "│Hi│  ", "└──┘  "]);
    }

    #[test]
    fn render_to_buffer_styled_snapshots_styled_scene_into_runs() {
        // The styled counterpart of the golden `render_to_buffer` scene: the
        // same rounded-border box, but the inner text is bold red. The frame
        // is still
        //   ┌──┐
        //   │Hi│
        //   └──┘
        // and the runs merge adjacent same-style cells: the border and the
        // trailing blanks share the default style, so row 0 and row 2 are
        // single runs, while row 1 splits into border / bold-red "Hi" /
        // border+blanks.
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
            .add_text(
                box_id,
                "Hi",
                Style::new()
                    .fg(_Color::Rgb(255, 0, 0))
                    .add_modifier(Modifiers::BOLD),
            )
            .expect("add styled text");

        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(
            runs,
            vec![
                vec![plain_run("┌──┐  ")],
                vec![plain_run("│"), bold_red_run("Hi"), plain_run("│  ")],
                vec![plain_run("└──┘  ")],
            ]
        );
    }

    #[test]
    fn render_to_buffer_styled_border_color_paints_border_runs_in_color() {
        // A box with a `border_color` paints its border glyphs with that color
        // as their foreground, so the styled snapshot reports it through the
        // border runs' `fg`: the colored border splits from the default-styled
        // blanks into its own `fg: "#ff0000"` run per row, while the glyphs
        // and the inner text stay unchanged.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new()
                    .border_style(BorderStyle::Rounded)
                    .border_color(_Color::Rgb(255, 0, 0)),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(box_id, "Hi", Style::new())
            .expect("add text");

        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(
            runs,
            vec![
                vec![red_border_run("┌──┐"), plain_run("  ")],
                vec![
                    red_border_run("│"),
                    plain_run("Hi"),
                    red_border_run("│"),
                    plain_run("  "),
                ],
                vec![red_border_run("└──┘"), plain_run("  ")],
            ]
        );
    }

    #[test]
    fn render_to_buffer_styled_text_reconstructs_plain_rows() {
        // The styled snapshot must never change the painted text:
        // concatenating each row's run texts reproduces the
        // `render_to_buffer` row string for the same scene, byte for byte —
        // the two snapshot flavors share one paint path.
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
            .add_text(
                box_id,
                "Hi",
                Style::new()
                    .fg(_Color::Rgb(255, 0, 0))
                    .add_modifier(Modifiers::BOLD),
            )
            .expect("add styled text");

        let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        let reconstructed: Vec<String> = runs
            .iter()
            .map(|row| row.iter().map(|run| run.text.as_str()).collect())
            .collect();
        assert_eq!(reconstructed, rows);
    }

    #[test]
    fn render_to_buffer_styled_masks_and_merges_wide_char_cells() {
        // A wide glyph's masked continuation cell maps to a space and merges
        // into the lead cell's run — the mask carries the lead's style — so a
        // styled コ followed by a default-styled `a` collapses into two runs:
        // "コ " bold-red, then "a " default. Concatenating the run texts
        // reconstructs the plain row.
        let mut buffer = Buffer::new(4, 1);
        buffer.set_string(
            0,
            0,
            "コ",
            Style::new()
                .fg(_Color::Rgb(255, 0, 0))
                .add_modifier(Modifiers::BOLD),
        );
        buffer.set_string(2, 0, "a", Style::new());
        assert_eq!(
            buffer_runs(&buffer),
            vec![vec![bold_red_run("コ "), plain_run("a ")]]
        );
    }

    #[test]
    fn render_to_buffer_styled_errors_when_destroyed() {
        // The napi method guards on the destroyed flag like `render_to_buffer`
        // and `render`, so a torn-down renderer cannot snapshot.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let inner = RendererInner {
            backend: Box::new(Backend::new()),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
            destroyed: true,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        let renderer = TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        };
        let err = renderer
            .render_to_buffer_styled(None, None)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    /// A run carrying no style keys — `{ text }`.
    fn plain_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: None,
            bg: None,
            bold: None,
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
    }

    /// A run carrying `fg: "#ff0000"` and `bold` — the style keys the styled
    /// golden text uses.
    fn bold_red_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: Some("#ff0000".to_string()),
            bg: None,
            bold: Some(true),
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
    }

    /// A run carrying `fg: "#ff0000"` — the border color the styled border
    /// golden paints its border cells with.
    fn red_border_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: Some("#ff0000".to_string()),
            bg: None,
            bold: None,
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
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
    fn render_to_buffer_zwj_family_emoji_is_single_2_column_glyph() {
        // A ZWJ family emoji is ONE grapheme cluster rendered as a single
        // 2-column glyph: the snapshot row reconstructs the full cluster
        // string in its lead cell, with the masked continuation cell as a
        // space — never the lead char alone, never a re-split sequence.
        let mut scene = Scene::new();
        let root = scene.root_id();
        scene
            .add_text(root, "👨‍👩‍👧‍👦", Style::new())
            .expect("add text");
        let rows = paint_scene_rows_with_selection(&scene, Size::new(4, 1), None);
        // Cells: [👨‍👩‍👧‍👦][mask→space][space][space].
        assert_eq!(rows, vec!["👨‍👩‍👧‍👦   "], "got: {rows:?}");
    }

    #[test]
    fn render_to_buffer_flag_is_single_2_column_glyph() {
        // A regional-indicator flag is ONE grapheme cluster rendered as a
        // single 2-column glyph in the snapshot row.
        let mut scene = Scene::new();
        let root = scene.root_id();
        scene.add_text(root, "🇷🇺", Style::new()).expect("add text");
        let rows = paint_scene_rows_with_selection(&scene, Size::new(3, 1), None);
        assert_eq!(rows, vec!["🇷🇺  "], "got: {rows:?}");
    }

    #[test]
    fn render_to_buffer_errors_when_destroyed() {
        // The napi method guards on the destroyed flag, so a torn-down
        // renderer cannot snapshot (mirrors `render`).
        let scene = Arc::new(Mutex::new(Scene::new()));
        let inner = RendererInner {
            backend: Box::new(Backend::new()),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
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

    /// A fresh headless renderer with default options (virtual 80x24),
    /// constructed through the real [`TuiRenderer::new`] path so the tests
    /// prove headless construction never touches a terminal.
    fn headless_renderer() -> TuiRenderer {
        TuiRenderer::new(TuiRendererOptions {
            exit_on_ctrl_c: None,
            use_alt_screen: None,
            title: None,
            headless: Some(true),
            width: None,
            height: None,
        })
        .expect("headless renderer constructs without a terminal")
    }

    #[test]
    fn headless_renderer_constructs_without_a_terminal() {
        // Construction with `headless: true` must not touch a real terminal
        // (no raw mode, no alternate screen, no event listening, no title):
        // it succeeds under plain `cargo test` with no TTY and reports the
        // default 80x24 virtual size.
        let renderer = headless_renderer();
        assert!(!renderer.destroyed());
        let size = renderer.size().expect("size works headlessly");
        assert_eq!((size.width, size.height), (80, 24), "got: {size:?}");
    }

    #[test]
    fn headless_renderer_renders_and_snapshots_without_a_terminal() {
        // `render`, `render_to_buffer`, and `render_to_buffer_styled` all
        // work against the in-memory backend: the frame paints at the
        // virtual size and both snapshot flavors return one row per
        // configured height cell, each row the configured width.
        let renderer = headless_renderer();
        renderer.render().expect("render works headlessly");
        let rows = renderer
            .render_to_buffer(None, None)
            .expect("plain snapshot works headlessly");
        assert_eq!(rows.len(), 24, "snapshot defaults to the virtual height");
        assert!(
            rows.iter().all(|row| row.len() == 80),
            "snapshot rows must be the virtual width"
        );
        let runs = renderer
            .render_to_buffer_styled(None, None)
            .expect("styled snapshot works headlessly");
        assert_eq!(
            runs.len(),
            24,
            "styled snapshot defaults to the virtual height"
        );
    }

    #[test]
    fn headless_renderer_destroy_skips_teardown_and_is_idempotent() {
        // `destroy` must not attempt terminal teardown (the in-memory
        // backend no-ops it anyway), must be safe to call twice, and must
        // leave the renderer unusable — exactly like a real renderer.
        let renderer = headless_renderer();
        renderer.destroy().expect("first destroy succeeds");
        renderer.destroy().expect("second destroy is a no-op");
        assert!(renderer.destroyed());
        let err = renderer
            .render()
            .expect_err("a destroyed headless renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .size()
            .expect_err("size must error on a destroyed renderer");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn headless_renderer_custom_size_is_reported_and_painted() {
        // A custom virtual size (120x30) drives the size getter and the
        // snapshot viewport with no TTY involved. The snapshot is painted at
        // an explicit size first (recording `last_painted_viewport` without
        // touching the shared scene viewport), then `size` reports the custom
        // viewport — the suite's shared-viewport default of 80x24 is never
        // mutated, keeping the parallel tests deterministic.
        let renderer = TuiRenderer::new(TuiRendererOptions {
            exit_on_ctrl_c: None,
            use_alt_screen: None,
            title: None,
            headless: Some(true),
            width: Some(120),
            height: Some(30),
        })
        .expect("headless renderer with a custom size constructs");
        let rows = renderer
            .render_to_buffer(Some(120), Some(30))
            .expect("custom-size snapshot works headlessly");
        assert_eq!(rows.len(), 30, "snapshot height matches the custom size");
        assert!(
            rows.iter().all(|row| row.len() == 120),
            "snapshot rows are the custom width"
        );
        let runs = renderer
            .render_to_buffer_styled(Some(120), Some(30))
            .expect("custom-size styled snapshot works headlessly");
        assert_eq!(
            runs.len(),
            30,
            "styled snapshot height matches the custom size"
        );
        let size = renderer.size().expect("size reports the custom viewport");
        assert_eq!((size.width, size.height), (120, 30), "got: {size:?}");
    }

    /// A backend that counts every terminal operation instead of performing
    /// it, so tests can assert exactly which renders touched the terminal.
    ///
    /// Counters are `Arc`-shared so the test keeps reading them after the
    /// backend is moved into the renderer. `size()` reports a fixed 80x24
    /// viewport, keeping the viewport cache stable across renders.
    /// `set_clipboard` captures the text it received into `clipboard` (the
    /// injected sink: the byte-level escape emission is covered by
    /// tern-terminal's `set_clipboard_to` tests, this mock proves the
    /// renderer forwards the text).
    #[derive(Clone, Default)]
    struct CountingBackend {
        size_calls: Arc<AtomicUsize>,
        flush_calls: Arc<AtomicUsize>,
        clipboard: Arc<Mutex<Option<String>>>,
    }

    impl CountingBackend {
        /// Total terminal operations so far (size probes + flushes).
        fn ops(&self) -> usize {
            self.size_calls.load(Ordering::Relaxed) + self.flush_calls.load(Ordering::Relaxed)
        }

        /// The text most recently passed to `set_clipboard`, or `None`.
        fn clipboard(&self) -> Option<String> {
            self.clipboard.lock().expect("clipboard poisoned").clone()
        }
    }

    impl RenderBackend for CountingBackend {
        fn size(&self) -> io::Result<(u16, u16)> {
            self.size_calls.fetch_add(1, Ordering::Relaxed);
            Ok((80, 24))
        }

        fn flush_diff(
            &mut self,
            updates: &[CellUpdate],
            _cursor_pos: (u16, u16),
        ) -> io::Result<usize> {
            self.flush_calls.fetch_add(1, Ordering::Relaxed);
            // Report a nominal byte count per flushed cell so the renderer's
            // `last_flush_bytes` counter is exercised; the tests only assert
            // on the call counters, never on this value.
            Ok(updates.len())
        }

        fn set_title(&self, _title: &str) -> io::Result<()> {
            Ok(())
        }

        fn set_clipboard(&self, text: &str) -> io::Result<()> {
            *self.clipboard.lock().expect("clipboard poisoned") = Some(text.to_string());
            Ok(())
        }

        fn disable_event_listening(&self) -> io::Result<()> {
            Ok(())
        }

        fn exit_alt_screen(&self) -> io::Result<()> {
            Ok(())
        }

        fn exit_raw_mode(&self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A renderer wired to a [`CountingBackend`] over a scene with one Text
    /// child, so the no-op fast path can be exercised end to end.
    fn counting_renderer(backend: CountingBackend) -> (TuiRenderer, Arc<Mutex<Scene>>) {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::Text, Style::new())
                .expect("add text node");
        }
        let renderer = renderer_with_scene(backend, scene.clone());
        (renderer, scene)
    }

    /// A renderer wired to `backend` over `scene` (the caller owns the
    /// scene's content).
    fn renderer_with_scene(backend: CountingBackend, scene: Arc<Mutex<Scene>>) -> TuiRenderer {
        let inner = RendererInner {
            backend: Box::new(backend),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
            destroyed: false,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// A fresh scene holding one `Text` leaf sized `w` x `h` at the origin
    /// with `text` content, for selection tests.
    fn scene_with_text(text: &str, w: u32, h: u32) -> Arc<Mutex<Scene>> {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            let t = s
                .add_child(root, NodeKind::Text, Style::new())
                .expect("add text");
            s.set_prop(t, "text", PropValue::Str(text.into()));
            s.set_prop(t, "width", PropValue::Int(w as i64));
            s.set_prop(t, "height", PropValue::Int(h as i64));
        }
        scene
    }

    /// A fresh scene with two `Text` leaves stacked in a column at rows 0 and
    /// 1, for multi-row selection tests.
    fn two_row_scene() -> Arc<Mutex<Scene>> {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.set_prop(root, "flex_direction", PropValue::Str("column".into()));
            for text in ["hello", "world"] {
                let t = s
                    .add_child(root, NodeKind::Text, Style::new())
                    .expect("add text");
                s.set_prop(t, "text", PropValue::Str(text.into()));
                s.set_prop(t, "width", PropValue::Int(11));
                s.set_prop(t, "height", PropValue::Int(1));
            }
        }
        scene
    }

    #[test]
    fn unchanged_scene_renders_perform_zero_terminal_writes() {
        // Two consecutive renders with no intervening mutation: the first
        // paints (a size probe plus a flush), the second must hit the no-op
        // fast path and perform zero terminal writes — no size probe, no
        // paint, no diff, no flush.
        let backend = CountingBackend::default();
        let probe = backend.clone(); // keeps the counters after the move
        let (renderer, _scene) = counting_renderer(backend);

        renderer.render().expect("first render paints the scene");
        let after_first = probe.ops();
        assert!(after_first > 0, "first render must touch the backend");

        renderer.render().expect("second render succeeds");
        assert_eq!(
            probe.ops(),
            after_first,
            "an unchanged-scene render must perform zero terminal writes"
        );
    }

    #[test]
    fn mutated_scene_renders_repaint() {
        // A mutation between renders invalidates the scene cache: the next
        // render must repaint (paying for a flush again). The terminal size
        // is served from the size cache — a mutation does not invalidate it,
        // so no second `size()` probe happens.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, scene) = counting_renderer(backend);

        renderer.render().expect("first render paints the scene");
        let after_first = probe.ops();
        assert!(after_first > 0);

        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::Box, Style::new())
                .expect("mutate the scene");
        }
        renderer.render().expect("render after mutation succeeds");
        assert!(
            probe.ops() > after_first,
            "a mutated scene must repaint (flush; the size probe is served from the cache)"
        );
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "a mutation repaint must not re-probe the terminal size"
        );
    }

    #[test]
    fn fresh_renderer_never_fast_paths_before_first_paint() {
        // The (0,0) viewport sentinel must force a first paint even when the
        // scene epoch already matches `last_painted_epoch` (0 == 0): a
        // renderer that never painted has nothing cached to skip to.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);

        renderer.render().expect("first render paints");
        assert!(
            probe.ops() > 0,
            "the first render must paint, not fast-path"
        );
    }

    #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
    #[test]
    fn size_cache_serves_n_unchanged_renders_with_one_probe_and_resize_invalidates() {
        // The high-frame-rate contract: N consecutive renders of an unchanged
        // scene must perform exactly one `backend.size()` call. The first
        // render probes and caches the terminal size; every later render
        // either hits the no-op fast path (zero calls) or repaints from the
        // cache — no per-frame ioctl.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);

        let n = 5;
        for _ in 0..n {
            renderer.render().expect("render succeeds");
        }
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "{n} unchanged renders must perform exactly one size() call"
        );

        // A delivered resize event invalidates the cache — this is exactly
        // what the event delivery callback does for every resize event — so
        // the next render must re-query the backend size instead of painting
        // at the stale viewport.
        let probed_before = probe.size_calls.load(Ordering::Relaxed);
        invalidate_size_on_resize(&renderer.inner, &TernEvent::Resize { w: 100, h: 30 });
        renderer.render().expect("render after resize succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "a delivered resize event must cause the next render to re-query size"
        );

        // The re-queried size is cached again: the render after that probes
        // nothing more.
        renderer.render().expect("render after re-probe succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "the re-queried size is cached again for subsequent renders"
        );

        // Only resize events invalidate: a focus event leaves the cache
        // intact, so the next render still probes nothing.
        invalidate_size_on_resize(&renderer.inner, &TernEvent::FocusGained);
        renderer
            .render()
            .expect("render after focus event succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "a non-resize event must not invalidate the size cache"
        );
    }

    /// Run `f` with the shared viewport pinned to the render-path default
    /// (80x24), restoring it afterwards. `size`'s pre-paint seed writes the
    /// shared viewport (a static shared across parallel test threads); the
    /// probe always reports 80x24 here, so pinning it before and after keeps
    /// the render-path tests that read the shared viewport from ever
    /// observing a stale value.
    fn with_render_viewport<T>(f: impl FnOnce() -> T) -> T {
        *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
        let result = f();
        *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
        result
    }

    #[test]
    fn size_before_any_paint_probes_the_terminal_and_seeds_the_viewport() {
        // A fresh renderer has painted nothing, so `size` surfaces the
        // current terminal size: one probe through the cached-size machinery,
        // recorded as the viewport default (a fresh renderer never reports
        // the synthetic 80x24 fallback when the terminal is a different
        // size).
        with_render_viewport(|| {
            let backend = CountingBackend::default();
            let probe = backend.clone();
            let (renderer, _scene) = counting_renderer(backend);
            let size = renderer.size().expect("size before any paint succeeds");
            assert_eq!(size.width, 80, "reports the probed terminal width");
            assert_eq!(size.height, 24, "reports the probed terminal height");
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the first size access must probe exactly once"
            );
            // The probed size was cached: a second access probes nothing.
            let again = renderer.size().expect("second size succeeds");
            assert_eq!((again.width, again.height), (80, 24));
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the cached size must serve subsequent accesses"
            );
        });
    }

    #[test]
    fn size_reports_the_viewport_of_the_last_render() {
        // After a render, `size` reports the viewport that render painted at
        // (the terminal size it probed and cached) — no re-probe.
        with_render_viewport(|| {
            let backend = CountingBackend::default();
            let probe = backend.clone();
            let (renderer, _scene) = counting_renderer(backend);
            renderer.render().expect("render paints the scene");
            let size = renderer.size().expect("size after render succeeds");
            assert_eq!((size.width, size.height), (80, 24));
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the render's own probe serves the size access"
            );
        });
    }

    #[test]
    fn size_reports_the_viewport_of_the_last_snapshot() {
        // `render_to_buffer` records its viewport as the renderer's last
        // painted viewport, so `size` reports what the most recent
        // snapshotFrame painted at — even before any real render.
        let backend = CountingBackend::default();
        let (renderer, _scene) = counting_renderer(backend);
        renderer
            .render_to_buffer(Some(6), Some(3))
            .expect("snapshot paints");
        let size = renderer.size().expect("size after snapshot succeeds");
        assert_eq!((size.width, size.height), (6, 3), "got: {size:?}");
        // A bare snapshot defaults to the shared scene viewport (80x24 here:
        // no real render has established it), and that paint becomes the last
        // painted viewport.
        renderer
            .render_to_buffer(None, None)
            .expect("defaulted snapshot succeeds");
        let again = renderer.size().expect("size tracks the defaulted paint");
        assert_eq!((again.width, again.height), (80, 24), "got: {again:?}");
    }

    #[test]
    fn size_errors_on_a_destroyed_renderer() {
        let (renderer, _scene) = counting_renderer(CountingBackend::default());
        renderer.destroy().expect("destroy succeeds");
        let err = renderer.size().expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn set_clipboard_forwards_text_to_the_injected_backend() {
        // The renderer forwards the clipboard text verbatim to the injected
        // backend sink; the byte-level OSC 52 emission (ESC ] 52 ; c ; <base64>
        // BEL) is asserted by tern-terminal's `set_clipboard_to` tests.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);
        renderer
            .set_clipboard("hello".to_string())
            .expect("set_clipboard succeeds");
        assert_eq!(
            probe.clipboard().as_deref(),
            Some("hello"),
            "the text must reach the backend verbatim"
        );

        // A destroyed renderer refuses.
        renderer.destroy().expect("destroy succeeds");
        let err = renderer
            .set_clipboard("nope".to_string())
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn selection_change_invalidates_the_render_fast_path() {
        // A selection edit must force the next render to repaint (the
        // terminal shows the previous frame's overlay); an unchanged
        // selection keeps the zero-write no-op fast path.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let renderer = renderer_with_scene(backend, scene_with_text("hello", 5, 1));

        renderer.render().expect("first render paints");
        let after_first = probe.ops();
        assert!(after_first > 0);

        // Unchanged selection (None): no-op fast path, zero terminal writes.
        renderer.render().expect("unchanged render");
        assert_eq!(probe.ops(), after_first, "unchanged render must fast-path");

        // A selection edit invalidates the fast path: the next render
        // repaints (and reaches the flush).
        renderer.set_selection(1, 0, 3, 0).expect("set selection");
        renderer.render().expect("render after selection edit");
        assert!(
            probe.ops() > after_first,
            "a selection edit must force a repaint"
        );

        // The selection is now painted: an unchanged render fast-paths again.
        let after_selected = probe.ops();
        renderer.render().expect("render with unchanged selection");
        assert_eq!(probe.ops(), after_selected);

        // Clearing the selection invalidates the fast path once more.
        renderer.clear_selection().expect("clear selection");
        renderer.render().expect("render after clear");
        assert!(
            probe.ops() > after_selected,
            "a cleared selection must force a repaint"
        );
    }

    #[test]
    fn selection_text_extracts_the_selected_region_from_the_last_painted_frame() {
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello world", 11, 1),
        );
        renderer.render().expect("render paints the frame");

        renderer.set_selection(6, 0, 10, 0).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "world",
            "selection_text reads the last painted buffer"
        );

        // Reversed endpoints normalize identically.
        renderer.set_selection(10, 0, 6, 0).expect("set selection reversed");
        assert_eq!(renderer.selection_text().expect("selection text"), "world");

        // A selection spanning the trailing blank cells extracts the exact
        // cell content (trailing spaces preserved).
        renderer.set_selection(8, 0, 10, 0).expect("set selection tail");
        assert_eq!(renderer.selection_text().expect("selection text"), "rld");

        // Clearing the selection empties the extraction.
        renderer.clear_selection().expect("clear selection");
        assert_eq!(renderer.selection_text().expect("selection text"), "");
    }

    #[test]
    fn selection_text_joins_rows_with_newlines() {
        // A multi-row selection joins the rows with '\n'.
        let renderer = renderer_with_scene(CountingBackend::default(), two_row_scene());
        renderer.render().expect("render paints the frame");

        renderer.set_selection(0, 0, 4, 1).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "hello\nworld"
        );

        // A single-row window extracts only that row.
        renderer.set_selection(0, 1, 4, 1).expect("set selection row 1");
        assert_eq!(renderer.selection_text().expect("selection text"), "world");
    }

    #[test]
    fn selection_text_is_cluster_aware_across_wide_glyphs() {
        // A wide char's masked continuation cell contributes nothing: the
        // extraction yields the full cluster once.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("コa", 3, 1),
        );
        renderer.render().expect("render paints the frame");

        // コ at cols 0-1 (lead + mask), 'a' at col 2.
        renderer.set_selection(0, 0, 2, 0).expect("set selection");
        assert_eq!(renderer.selection_text().expect("selection text"), "コa");

        // A ZWJ family emoji stays one 2-column glyph in the extraction.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("👨‍👩‍👧‍👦x", 3, 1),
        );
        renderer.render().expect("render paints the frame");
        renderer.set_selection(0, 0, 2, 0).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "👨‍👩‍👧‍👦x"
        );
    }

    #[test]
    fn selection_text_is_empty_without_a_selection_or_paint() {
        // No paint yet: nothing to extract from.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello", 5, 1),
        );
        assert_eq!(renderer.selection_text().expect("selection text"), "");

        // Painted but no selection set.
        renderer.render().expect("render paints the frame");
        assert_eq!(renderer.selection_text().expect("selection text"), "");
    }

    #[test]
    fn selection_word_range_finds_words_and_rejects_whitespace() {
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("foo bar baz", 11, 1),
        );
        renderer.render().expect("render paints the frame");

        let word_at = |col: u32, row: u32| {
            renderer
                .selection_word_range(col, row)
                .expect("word range query")
        };

        // "foo" at cols 0-2, "bar" at 4-6, "baz" at 8-10.
        assert_eq!(word_at(1, 0).unwrap().col1, 0);
        assert_eq!(word_at(1, 0).unwrap().col2, 2);
        assert_eq!(word_at(5, 0).unwrap().col1, 4);
        assert_eq!(word_at(5, 0).unwrap().col2, 6);
        assert_eq!(word_at(10, 0).unwrap().col1, 8);
        assert_eq!(word_at(10, 0).unwrap().col2, 10);

        // Whitespace and out-of-bounds cells start no word.
        assert!(word_at(3, 0).is_none(), "a space starts no word");
        assert!(word_at(7, 0).is_none(), "a space starts no word");
        assert!(word_at(0, 5).is_none(), "a row outside the buffer starts no word");
        assert!(word_at(20, 0).is_none(), "a column outside the buffer starts no word");
        assert!(word_at(11, 0).is_none(), "the right edge starts no word");
    }

    #[test]
    fn selection_word_range_is_cluster_aware_across_wide_glyphs() {
        // "コab": コ at cols 0-1 (lead + masked continuation), 'a' at 2, 'b'
        // at 3. Clicking the mask column still resolves the word containing
        // the whole glyph.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("コab", 4, 1),
        );
        renderer.render().expect("render paints the frame");

        let word_at = |col: u32| {
            renderer
                .selection_word_range(col, 0)
                .expect("word range query")
        };

        // The run is the whole non-whitespace line: 0..=3.
        let r = word_at(0).expect("lead cell");
        assert_eq!((r.col1, r.col2), (0, 3));
        let r = word_at(1).expect("mask cell");
        assert_eq!((r.col1, r.col2), (0, 3), "the mask is part of the glyph's run");
        let r = word_at(2).expect("a cell");
        assert_eq!((r.col1, r.col2), (0, 3));
    }

    #[test]
    fn render_to_buffer_snapshot_applies_the_selection_overlay_without_corrupting_text() {
        // The snapshot paints through the renderer's selection: the overlay
        // is style-only, so the returned rows are byte-identical with and
        // without a selection — the snapshot is where a styled consumer would
        // observe the reversed cells, and the text must never be corrupted.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello", 5, 1),
        );
        let plain = renderer
            .render_to_buffer(Some(5), Some(1))
            .expect("snapshot without selection");
        assert_eq!(plain, vec!["hello"]);

        renderer.set_selection(1, 0, 3, 0).expect("set selection");
        let selected = renderer
            .render_to_buffer(Some(5), Some(1))
            .expect("snapshot with selection");
        assert_eq!(selected, plain, "the overlay must not change the text");

        // The snapshot's viewport still tracks (per-renderer state).
        let size = renderer.size().expect("size");
        assert_eq!((size.width, size.height), (5, 1));
    }

    #[test]
    fn selection_api_guards_on_a_destroyed_renderer() {
        let (renderer, _scene) = counting_renderer(CountingBackend::default());
        renderer.destroy().expect("destroy succeeds");
        let err = renderer
            .set_selection(0, 0, 1, 1)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .clear_selection()
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .selection_text()
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .selection_word_range(0, 0)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }
}
