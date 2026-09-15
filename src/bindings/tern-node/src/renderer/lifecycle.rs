//! Renderer lifecycle and introspection: construction, the scene root,
//! teardown, capability reporting, and the flushed-byte counter.

use super::*;

#[napi]
impl TuiRenderer {

/// Enter raw mode + the alternate screen (unless `use_alt_screen` is
/// `false`), apply the window title, and enable mouse / focus-change /
/// bracketed-paste event delivery, ready to render. The kitty keyboard
/// protocol enhancement is pushed only when opted in (default) and the
/// interactive probe reports the terminal supports it.
///
/// If any terminal transition fails the already-entered states are rolled
/// back before the error is returned, so a failed constructor never leaves
/// the terminal in raw mode.
#[napi(constructor, js_name = "TuiRenderer")]
pub fn new(options: TuiRendererOptions) -> Result<Self> {
    let use_alt_screen = options.use_alt_screen.unwrap_or(true);
    let title = options.title.clone();
    let headless = options.headless.unwrap_or(false);
    // The caller's opt-in for the kitty keyboard protocol (default on).
    // Whether the enhancement flags are actually pushed additionally
    // requires a non-headless renderer and the interactive probe
    // reporting kitty keyboard support — see
    // `should_push_keyboard_enhancement`.
    let keyboard_enhancement = options.keyboard_enhancement.unwrap_or(true);
    // The caller's opt-in for the scroll-region (DECSTBM) fast path
    // (default on). Whether the path is actually enabled additionally
    // requires a non-headless renderer and the interactive probe
    // reporting scroll-region support — see `should_scroll_optimize`.
    let scroll_optimization = options.scroll_optimization.unwrap_or(true);
    // The caller's opt-in for iTerm2 hidden accessibility annotations
    // (default off). Whether annotations are actually emitted
    // additionally requires a non-headless renderer and the interactive
    // probe reporting an iTerm2 terminal — the gating lives in the
    // core `Backend::set_a11y_annotations` (see
    // `tern_terminal::backend::flush_a11y_annotations_gated_to`).
    let a11y_annotations = options.a11y_annotations.unwrap_or(false);
    // A headless renderer never touches a terminal: no raw mode, no
    // alternate screen, no event listening, no title. Its in-memory
    // backend reports the configured virtual size (default 80x24) and
    // no-ops every terminal operation, so construction succeeds without a
    // TTY. `use_alt_screen` is forced off so `destroy` skips the
    // alternate-screen teardown to match (the no-op backend would swallow
    // it either way).
    let (backend, use_alt_screen, keyboard_enhancement_pushed) = if headless {
        (
            Box::new(HeadlessBackend::new(
                options.width.unwrap_or(80),
                options.height.unwrap_or(24),
            )) as Box<dyn RenderBackend>,
            false,
            // A headless renderer never touches a terminal: nothing is
            // pushed, so `destroy` pops nothing.
            false,
        )
    } else {
        // A non-headless renderer needs an interactive terminal: refuse
        // to construct on TERM=dumb or a non-TTY stdout BEFORE any
        // terminal I/O (raw mode on a pipe would succeed — crossterm
        // does not check — but the renderer would then paint into a
        // non-terminal and never receive events). The decision is pure
        // and unit-tested via `interactive_terminal_error`; the ambient
        // check here runs only in the non-headless branch, so headless
        // construction is completely unaffected.
        let term_dumb = std::env::var("TERM").is_ok_and(|term| term == "dumb");
        let stdout_tty = std::io::stdout().is_tty();
        if let Some(message) = interactive_terminal_error(term_dumb, stdout_tty) {
            return Err(Error::from_reason(message));
        }
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
        // The kitty keyboard protocol enhancement flags reach the
        // terminal only when the interactive probe (cached by
        // tern-terminal) reports the terminal supports the protocol.
        // A terminal without it previously swallowed the sequence
        // silently; the probe now gates the push itself, so `destroy`
        // pops exactly what was pushed.
        let keyboard_enhancement_pushed =
            should_push_keyboard_enhancement(keyboard_enhancement, headless, tern_terminal::probe());
        if keyboard_enhancement_pushed {
            // Best-effort: a failed write here must not fail the
            // constructor (the renderer works identically without it —
            // only the Shift-modified key reporting degrades).
            let _ = backend.enter_keyboard_enhancement();
        }
        (
            Box::new(Backend::new().with_a11y_annotations(a11y_annotations))
                as Box<dyn RenderBackend>,
            use_alt_screen,
            keyboard_enhancement_pushed,
        )
    };
    let inner = Arc::new(Mutex::new(RendererInner {
        backend,
        compositor: Compositor::new(),
        scene: shared_scene().clone(),
        last: None,
        last_painted_epoch: 0,
        last_viewport: NO_VIEWPORT,
        last_painted_viewport: NO_VIEWPORT,
        selection: None,
        last_painted_selection: None,
        cursor: None,
        last_painted_cursor: None,
        cached_size: None,
        last_flush_bytes: 0,
        #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
        exit_on_ctrl_c: options.exit_on_ctrl_c.unwrap_or(false),
        use_alt_screen,
        headless,
        scroll_region: should_scroll_optimize(
            scroll_optimization,
            headless,
            tern_terminal::probe(),
        ),
        keyboard_enhancement: keyboard_enhancement_pushed,
        any_event_mouse: false,
        destroyed: false,
        #[cfg(feature = "push-events")]
        event_loop: None,
        #[cfg(unix)]
        signals: None,
        #[cfg(all(unix, feature = "push-events"))]
        signal_tsfn: None,
    }));
    // The accessibility-semantics store gate (M4.1): writes through
    // `NodeHandle::set_semantics` are rejected while the store is off
    // (the default). Opting in flips the shared scene's flag so writes
    // land; the store is a pure-bookkeeping parallel map that never
    // changes painted content (see the core `semantics` module). The
    // scene is shared module-globally (see the crate docs), so this
    // enables the shared store — consistent with the single-renderer
    // ownership model.
    if options.semantics.unwrap_or(false) {
        inner
            .lock()
            .expect("renderer inner poisoned")
            .scene
            .lock()
            .expect("scene poisoned")
            .set_semantics_enabled(true);
    }
    // Take over the process's signals for every non-headless renderer:
    // SIGINT/SIGTERM/SIGHUP tear the terminal down and exit with the
    // conventional code, SIGTSTP/SIGCONT suspend and resume it. A
    // headless renderer never touches a terminal, so it leaves the
    // process's signal dispositions alone.
    #[cfg(unix)]
    if !headless {
        match register_signals(inner.clone()) {
            Ok(handles) => {
                inner.lock().expect("renderer inner poisoned").signals = Some(handles);
            }
            Err(e) => {
                // Roll the already-entered terminal states back through
                // the shared teardown (mirroring the startup-failure
                // path above), so a failed constructor never leaves the
                // terminal in raw mode with no one to restore it.
                let mut guard = inner.lock().expect("renderer inner poisoned");
                guard.teardown();
                drop(guard);
                return Err(Error::from_reason(format!("register signals: {e}")));
            }
        }
    }
    Ok(Self { inner })
}

/// A handle to the scene root, to attach content under.
#[napi(js_name = "root")]
pub fn root(&self) -> NodeHandle {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    let scene = inner.scene.clone();
    let id = scene.lock().expect("scene poisoned").root_id();
    NodeHandle::materialized(scene, id, NodeKind::Root, Style::new(), PropMap::new())
}

/// Leave the alternate screen and raw mode and stop event listening,
/// restoring the terminal. Any-event mouse tracking is turned off
/// (`?1003l`) before the general event-listening disable, so the
/// terminal closes its capture modes in enable order. Also stops the
/// push event loop (with the default `push-events` feature) so the
/// loop thread exits, and stops the signal thread so the process's
/// signal dispositions are restored. Safe to call more than once; a
/// destroyed renderer cannot render or poll.
#[napi(js_name = "destroy")]
pub fn destroy(&self) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    // Take the signal handles OUT of the lock before stopping the
    // thread: the signal thread may be waiting on this very lock, and
    // joining it while we hold the lock would deadlock.
    #[cfg(unix)]
    let signals = inner.signals.take();
    inner.teardown();
    drop(inner);
    #[cfg(unix)]
    if let Some(mut signals) = signals {
        signals.stop();
    }
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

/// The terminal's capabilities: the color report detected once by the
/// backend (`{ truecolor, colors }` — see `tern-terminal`'s
/// `Backend::capabilities`) merged with the interactive probe report
/// (`terminalIdentity`, `kittyKeyboard`, `kittyUnderline`, `osc52`,
/// `bracketedPaste`, `focusEvents`, `scrollRegion`, `probed` — see
/// `tern-terminal`'s `probe::TerminalCapabilities`). The probe result is
/// cached per process; a probe skipped for a non-TTY or `TERM=dumb`
/// reports conservative defaults with `probed: false`.
#[napi(getter, js_name = "capabilities")]
pub fn capabilities(&self) -> RendererCapabilities {
    let caps = tern_terminal::backend::capabilities();
    let probe = tern_terminal::probe();
    RendererCapabilities {
        truecolor: caps.truecolor,
        colors: caps.colors,
        terminal_identity: probe.terminal_identity.clone(),
        kitty_keyboard: probe.kitty_keyboard,
        kitty_underline: probe.kitty_underline,
        osc52: probe.osc52,
        bracketed_paste: probe.bracketed_paste,
        focus_events: probe.focus_events,
        scroll_region: probe.scroll_region,
        probed: probe.probed,
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

}
