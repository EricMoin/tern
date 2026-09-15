//! The `TuiRenderer` napi class: terminal lifecycle, render loop, and
//! event-stream plumbing.

use super::*;
use crossterm::tty::IsTty;
use napi_derive::napi;
use tern_terminal::backend::A11yAnnotation;
use tern_terminal::probe::TerminalCapabilities;

// The renderer types stay here; the large impl block is split by concern
// across renderer/*.rs, and the glob re-exports keep every method on
// TuiRenderer exactly where it was.

/// The terminal-facing renderer: owns raw mode + alternate screen, pushes
/// input to the JS thread via a threadsafe event stream (or polls it with the
/// `poll-fallback` feature), and paints the shared scene to the terminal.
#[napi]
pub struct TuiRenderer {
    pub(crate) inner: Arc<Mutex<RendererInner>>,
}

pub(crate) struct RendererInner {
    pub(crate) backend: Box<dyn RenderBackend>,
    /// The stateful compositor, held across frames: it owns the layout
    /// engine, which owns the cached taffy tree and the last layout results
    /// (structural preparation — every frame still recomputes this phase).
    pub(crate) compositor: Compositor,
    pub(crate) scene: Arc<Mutex<Scene>>,
    pub(crate) last: Option<Buffer>,
    /// The scene epoch at the most recent successful paint. A render whose
    /// scene epoch still matches — and whose viewport is unchanged — has
    /// nothing new to draw and returns without touching the terminal.
    pub(crate) last_painted_epoch: u64,
    /// The viewport the last successful render painted at; [`NO_VIEWPORT`]
    /// before any render. Doubles as the "a viewport was already recorded"
    /// guard: a fresh renderer must not take the no-op fast path before its
    /// first paint.
    pub(crate) last_viewport: (u16, u16),
    /// The viewport the most recent paint — a [`TuiRenderer::render`] or a
    /// [`TuiRenderer::render_to_buffer`] snapshot — painted at; [`NO_VIEWPORT`]
    /// before any paint. The surface behind [`TuiRenderer::size`]: before the
    /// first paint the size getter seeds it from the terminal through the
    /// cached-size machinery instead of reporting the synthetic 80x24
    /// fallback. Kept per-renderer (unlike the shared scene viewport) so a
    /// snapshot's viewport never leaks into another renderer's state.
    pub(crate) last_painted_viewport: (u16, u16),
    /// The renderer's selection overlay: the inclusive cell rect
    /// (`x1`, `y1`, `x2`, `y2`) in viewport coordinates, or `None` when no
    /// selection is set. Per-renderer state (like `last_painted_viewport`) —
    /// deliberately NOT on the shared module-global scene, so one renderer's
    /// selection never leaks into another's paint. Synced into the compositor
    /// before every paint and snapshot.
    pub(crate) selection: Option<(u16, u16, u16, u16)>,
    /// The selection the last successful render painted at. A different
    /// selection now invalidates the render fast path: the next render must
    /// repaint so the overlay reaches the terminal.
    pub(crate) last_painted_selection: Option<(u16, u16, u16, u16)>,
    /// The renderer's caret override: position, shape, blinking, and
    /// visibility to apply to the terminal when the frame flushes, or `None`
    /// when the legacy position-only flush ([`RenderBackend::flush_diff`]
    /// parking the caret at the top-left) is used. Per-renderer state like
    /// `selection`; `set_cursor` / `clear_cursor` own it.
    pub(crate) cursor: Option<Cursor>,
    /// The cursor the last successful render flushed with. A different cursor
    /// now invalidates the render fast path — exactly like `selection` vs
    /// `last_painted_selection` — so a `set_cursor` / `clear_cursor` between
    /// renders always reaches the terminal, even when the scene is
    /// unchanged.
    pub(crate) last_painted_cursor: Option<Cursor>,
    /// The terminal size as last probed, cached so the hot render path skips
    /// the per-frame `backend.size()` ioctl. `None` before the first probe or
    /// after a resize event invalidated it; [`TuiRenderer::render`] and
    /// [`TuiRenderer::hit_test`] re-query the backend only when it is `None`
    /// (first use or post-invalidation), and refresh it from the probe.
    pub(crate) cached_size: Option<(u16, u16)>,
    /// The number of bytes the most recent [`TuiRenderer::render`] flush
    /// queued to the terminal (the frame's ANSI escape-sequence stream; 0 for
    /// a fully suppressed frame). Fed by the backend queue via the flush
    /// return value; unchanged by a no-op fast-path render (which never
    /// flushes), so the counter always describes the last real flush.
    pub(crate) last_flush_bytes: u64,
    #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
    pub(crate) exit_on_ctrl_c: bool,
    /// Whether the alternate screen was entered: `false` renders inline in
    /// the main screen, so teardown must skip `exit_alt_screen` to match.
    pub(crate) use_alt_screen: bool,
    /// Whether this is a headless renderer: it never entered raw mode, the
    /// alternate screen, event listening, or a window title (its backend is
    /// an in-memory no-op), so `destroy` must skip terminal teardown.
    pub(crate) headless: bool,
    /// Whether the scroll-region (DECSTBM) fast path may be used: the
    /// caller's opt-in (`scroll_optimization`, default on) AND the
    /// terminal's probe-derived scroll-region capability — `false` for a
    /// headless renderer (nothing to scroll), tmux/screen (DECSTBM quirks),
    /// and unknown terminals (see
    /// [`should_scroll_optimize`](crate::should_scroll_optimize) and the
    /// `scroll_region` capability on [`TuiRenderer::capabilities`]). The
    /// render path gates vertical-scroll detection on this.
    pub(crate) scroll_region: bool,
    /// Whether the kitty keyboard protocol enhancement was pushed — `destroy`
    /// pops it so the terminal returns to its previous state.
    pub(crate) keyboard_enhancement: bool,
    /// Whether any-event mouse tracking (`?1003h`) is enabled — `destroy`
    /// turns it off (`?1003l`) before the general event-listening teardown,
    /// so the terminal closes its capture modes in enable order.
    pub(crate) any_event_mouse: bool,
    pub(crate) destroyed: bool,
    /// The background push event loop (`push-events` feature): stopped when
    /// the renderer is destroyed so the loop thread exits and releases the
    /// threadsafe function.
    #[cfg(feature = "push-events")]
    pub(crate) event_loop: Option<EventLoopHandle>,
    /// The unix signal-lifecycle handles (the `tern-signals` thread + its
    /// registrations): SIGINT/SIGTERM/SIGHUP clean exit, SIGTSTP suspend,
    /// SIGCONT resume. `None` for a headless renderer (it never touches a
    /// terminal, so no signals are taken over) and on non-unix builds.
    #[cfg(unix)]
    pub(crate) signals: Option<SignalHandles>,
    /// The push-channel tsfn, handed over by `start_event_stream` so the
    /// signal thread can deliver SIGTSTP/SIGCONT lifecycle events to JS.
    /// `None` before the stream starts (and always under `poll-fallback`).
    #[cfg(all(unix, feature = "push-events"))]
    pub(crate) signal_tsfn: Option<Arc<ThreadsafeFunction<TernEventJs>>>,
}

impl RendererInner {
    /// Restore the terminal to its pre-renderer state: pop the kitty
    /// keyboard enhancement if it was pushed, disable any-event mouse and
    /// the general event listening, leave the alternate screen, and exit
    /// raw mode — the same teardown tail as [`teardown`](Self::teardown).
    ///
    /// Deliberately NOT the full teardown: no event-loop stop and no
    /// destroyed marking. The SIGTSTP suspend path uses it — the event loop
    /// stays running (the stopped process pauses it; SIGCONT resumes it) and
    /// the renderer stays alive, so the SIGCONT resume can re-enter the
    /// terminal under the same renderer.
    pub(crate) fn restore_terminal(&mut self) {
        if self.destroyed || self.headless {
            return;
        }
        if self.keyboard_enhancement {
            let _ = self.backend.exit_keyboard_enhancement();
        }
        if self.any_event_mouse {
            let _ = self.backend.disable_any_event_mouse();
        }
        let _ = self.backend.disable_event_listening();
        if self.use_alt_screen {
            let _ = self.backend.exit_alt_screen();
        }
        let _ = self.backend.exit_raw_mode();
    }

    /// Re-enter the terminal after a suspend/continue cycle: raw mode, the
    /// alternate screen, event listening, the kitty keyboard enhancement
    /// (re-pushed only if it was pushed), and any-event mouse (re-enabled
    /// only if it was on), then invalidate the cached size and drop the
    /// retained frame so the next render repaints everything.
    ///
    /// The terminal shows the pre-TUI (primary) screen while the process was
    /// suspended; re-entering the alternate screen does not restore the
    /// previous frame, so a full repaint is mandatory — clearing
    /// `cached_size` (defeating the no-op fast path) plus `last` /
    /// `last_painted_epoch` (forcing a full-buffer diff) makes the next
    /// `render()` paint every cell. Errors are ignored, best-effort like the
    /// teardown: a terminal closed while suspended just leaves a broken
    /// renderer, which the next render reports.
    pub(crate) fn resume_terminal(&mut self) {
        if self.headless {
            return;
        }
        let _ = self.backend.enter_raw_mode();
        if self.use_alt_screen {
            let _ = self.backend.enter_alt_screen();
        }
        let _ = self.backend.enable_event_listening();
        if self.keyboard_enhancement {
            let _ = self.backend.enter_keyboard_enhancement();
        }
        if self.any_event_mouse {
            let _ = self.backend.enable_any_event_mouse();
        }
        // The screen is stale and the terminal size may have changed while
        // suspended: force the next render off the no-op fast path and into
        // a full repaint.
        self.cached_size = None;
        self.last = None;
        self.last_painted_epoch = 0;
    }

    /// The idempotent full teardown every restore path funnels through:
    /// stop the push event loop, restore the terminal, mark the renderer
    /// destroyed. A destroyed renderer is a no-op. Used by
    /// [`TuiRenderer::destroy`], the Ctrl+C teardown paths, and the signal
    /// exit handlers.
    pub(crate) fn teardown(&mut self) {
        if self.destroyed {
            return;
        }
        #[cfg(feature = "push-events")]
        if let Some(event_loop) = &self.event_loop {
            event_loop.stop();
        }
        self.restore_terminal();
        self.destroyed = true;
    }
}

/// Whether the kitty keyboard protocol enhancement flags should be pushed
/// to the terminal.
///
/// The pure decision behind the constructor's keyboard-enhancement gate:
/// the flags are pushed only when the caller opted in (`option`), the
/// renderer is not `headless` (a headless renderer never touches a
/// terminal), and the interactive probe reports the terminal supports the
/// kitty keyboard protocol (`caps.kitty_keyboard`). A terminal that cannot
/// answer the probe — or a probe skipped for a non-TTY — reports
/// conservative defaults, so this stays `false` for unknown terminals:
/// the legacy fallback (an unsupported terminal silently ignoring the
/// push) never runs, because the push itself is gated.
pub(crate) fn should_push_keyboard_enhancement(
    option: bool,
    headless: bool,
    caps: &TerminalCapabilities,
) -> bool {
    option && !headless && caps.kitty_keyboard
}

/// Whether the scroll-region (DECSTBM) fast path is enabled for this
/// renderer.
///
/// The pure decision behind the constructor's scroll gate (mirroring
/// [`should_push_keyboard_enhancement`]): the path is enabled only when the
/// caller opted in (`scroll_optimization`, default on), the renderer is not
/// `headless` (nothing to scroll; a headless flush is a no-op either way),
/// and the interactive probe reports the terminal supports scroll-region
/// painting (`caps.scroll_region` — `false` for tmux/screen, whose DECSTBM
/// quirks make scroll-region painting unsafe, and for an unknown or silent
/// terminal, which keeps the full-redraw fallback).
pub(crate) fn should_scroll_optimize(
    option: bool,
    headless: bool,
    caps: &TerminalCapabilities,
) -> bool {
    option && !headless && caps.scroll_region
}

/// Whether a non-headless renderer must refuse to construct on this
/// terminal: `Some(message)` when construction must error, `None` when the
/// terminal is interactive.
///
/// The pure decision behind the constructor's interactive-terminal guard:
/// a non-headless renderer drives a real terminal — raw mode, the alternate
/// screen, and event delivery all write to stdout — so it needs one.
/// `TERM=dumb` marks a terminal that deliberately disables escape-sequence
/// interpretation (and the interactive probe skips it, leaving every
/// capability-driven feature on conservative defaults), and a non-TTY
/// stdout means there is no terminal at all. The check runs BEFORE any
/// terminal I/O in the constructor, so a failed construction never leaves a
/// pipe or file descriptor in raw mode.
///
/// `pub(crate)` and parameterized so the full truth table is unit-testable
/// without touching process env or stdio (mirroring
/// [`should_push_keyboard_enhancement`]); the ambient constructor-level
/// check is covered by the PTY smoke case.
pub(crate) fn interactive_terminal_error(term_dumb: bool, stdout_tty: bool) -> Option<&'static str> {
    if term_dumb || !stdout_tty {
        Some("tern requires an interactive terminal (TERM=dumb or non-TTY)")
    } else {
        None
    }
}

/// The hidden-annotation text for one [`A11yAnnotationJs`] entry:
/// `[role][: label][, state...]` — e.g. `"button"`,
/// `"textbox: Search, focused"`, `"checkbox: mute, checked, focused"`.
/// The state order is kept as given (the
/// [`semantics`](TuiRenderer::semantics) dump sorts it, so the JS side
/// passes it sorted).
fn a11y_annotation_summary(entry: &A11yAnnotationJs) -> String {
    let mut summary = entry.role.clone();
    if let Some(label) = &entry.label {
        summary.push_str(": ");
        summary.push_str(label);
    }
    for state in &entry.state {
        summary.push_str(", ");
        summary.push_str(state);
    }
    summary
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
                // the renderer destroyed through the shared idempotent
                // teardown, exactly like `destroy` (stopping the loop is a
                // no-op here — the loop is stopping itself via the stop
                // flag below).
                if let Ok(mut inner) = inner_for_loop.lock() {
                    inner.teardown();
                }
                loop_stop.store(true, Ordering::Relaxed);
            }
        })
        .map_err(|e| Error::from_reason(format!("spawn event loop: {e}")))?;
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        inner.event_loop = Some(handle);
        // Hand the push-channel tsfn to the signal thread: SIGTSTP/SIGCONT
        // lifecycle events reach JS through it.
        #[cfg(all(unix, feature = "push-events"))]
        {
            inner.signal_tsfn = Some(tsfn);
        }
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
                inner.teardown();
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

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
/// Whether a key event is a Ctrl+C press (the `exit_on_ctrl_c` trigger).
/// Gated on [`KeyKind::Press`]: on a kitty-enabled terminal a held Ctrl+C
/// reports release/repeat events too, and only the press must tear the
/// renderer down.
pub(crate) fn is_ctrl_c(event: &TernEvent) -> bool {
    matches!(
        event,
        TernEvent::Key(key) if key.kind == KeyKind::Press && key.ctrl && key.char == Some('c')
    )
}

/// Invalidate the cached terminal size when a resize event arrives: the next
/// [`TuiRenderer::render`] / [`TuiRenderer::hit_test`] re-queries the backend
/// instead of painting or hit-testing at the stale viewport. Called from the
/// event delivery paths (the push event loop's callback and the poll
/// fallback) for every delivered event; a no-op for non-resize events.
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
pub(crate) fn invalidate_size_on_resize(inner: &Mutex<RendererInner>, event: &TernEvent) {
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
pub(crate) fn push_event_batch(
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

mod lifecycle;
mod render;
mod terminal;
mod selection;

