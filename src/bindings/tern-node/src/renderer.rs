//! The `TuiRenderer` napi class: terminal lifecycle, render loop, and
//! event-stream plumbing.

use super::*;
use napi_derive::napi;

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
    /// Whether the kitty keyboard protocol enhancement was pushed — `destroy`
    /// pops it so the terminal returns to its previous state.
    pub(crate) keyboard_enhancement: bool,
    pub(crate) destroyed: bool,
    /// The background push event loop (`push-events` feature): stopped when
    /// the renderer is destroyed so the loop thread exits and releases the
    /// threadsafe function.
    #[cfg(feature = "push-events")]
    pub(crate) event_loop: Option<EventLoopHandle>,
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
        let keyboard_enhancement = options.keyboard_enhancement.unwrap_or(true) && !headless;
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
            if keyboard_enhancement {
                // Best-effort: terminals without the kitty keyboard protocol
                // ignore the sequence; a failed write here must not fail the
                // constructor (the renderer works identically without it —
                // only the Shift-modified key reporting degrades).
                let _ = backend.enter_keyboard_enhancement();
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
                keyboard_enhancement,
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
            if inner.keyboard_enhancement {
                let _ = inner.backend.exit_keyboard_enhancement();
            }
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

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
/// Whether a key event is a Ctrl+C press (the `exit_on_ctrl_c` trigger).
pub(crate) fn is_ctrl_c(event: &TernEvent) -> bool {
    matches!(event, TernEvent::Key(key) if key.ctrl && key.char == Some('c'))
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
