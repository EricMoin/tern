//! The paint path: full frames, headless buffer snapshots, hit testing,
//! and the semantics / accessibility annotations that ride along.

use super::*;

#[napi]
impl TuiRenderer {

/// Paint the shared scene into a fresh buffer at the current terminal
/// size and flush the minimal diff (vs the previous frame) to the
/// terminal — a single DECSTBM + SU/SD scroll command plus the newly
/// exposed rows when the diff is exactly a vertical scroll of a
/// full-width row band and the terminal supports scroll-region painting
/// (the M2.1 fast path, opt-in via `scroll_optimization`).
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
    // the new selection must be painted. A cursor edit (`set_cursor` /
    // `clear_cursor`) falls through for the same reason: the terminal
    // shows the previous frame's caret, so the new cursor must flush.
    if inner.last_viewport != NO_VIEWPORT
        && inner.cached_size.is_some()
        && inner.last_painted_epoch == scene_epoch
        && inner.last_viewport == (cached_w as u16, cached_h as u16)
        && inner.last_painted_selection == inner.selection
        && inner.last_painted_cursor == inner.cursor
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
    // The scroll-region fast path (roadmap M2.1): when the frame diff is
    // exactly a vertical scroll of a full-width row band, flush one
    // DECSTBM + SU/SD scroll command plus the newly exposed rows instead
    // of repainting every changed cell. `detect_vertical_scroll` returns
    // Some only when every row of the band's overlap matches the previous
    // frame `rows` away cell-for-cell — the guarantee that the terminal's
    // own scroll reproduces those rows exactly (the diff's updates there
    // are the moved content, already correct once the scroll lands) — so
    // the exposed band, together with the scroll, covers ALL updates:
    // nothing outside it needs repainting. The diff still lands in
    // `inner.last` in full (below), so post-scroll frames diff against
    // the correct retained frame. Gated on the caller's opt-in
    // (`scroll_optimization`, default on) and the terminal's
    // probe-derived scroll-region capability, both folded into
    // `inner.scroll_region` at construction; a set caret override
    // bypasses the path (the scroll flush parks the cursor without
    // shape/visibility control).
    let scroll_flush = match &inner.last {
        Some(prev) if inner.scroll_region && inner.cursor.is_none() && !updates.is_empty() => {
            let min_y = updates.iter().map(|u| u.y).min().expect("non-empty updates");
            let max_y = updates.iter().map(|u| u.y).max().expect("non-empty updates");
            // The changed row band: min/max of the update rows, expanded
            // to the full viewport width (DECSTBM scrolls whole rows).
            let band = Rect::new(0, min_y as i32, w as u32, (max_y - min_y) as u32 + 1);
            detect_vertical_scroll(prev, &buffer, band, w).and_then(|shift| {
                let exposed = exposed_band_updates(&updates, &shift);
                if exposed.is_empty() {
                    // Nothing new to repaint — keep the diff flush.
                    return None;
                }
                Some((
                    ScrollOp {
                        top: shift.region.y as u16,
                        bottom: (shift.region.bottom() - 1) as u16,
                        rows: shift.rows as u16,
                        up: shift.up,
                    },
                    exposed,
                ))
            })
        }
        _ => None,
    };
    // A set cursor flushes through the cursor-aware path — the frame's
    // diff, then MoveTo + SetCursorStyle + Show/Hide for the caret — so
    // the hardware caret tracks the model. With no cursor set, a detected
    // scroll takes the scroll-region flush (one scroll command + the
    // exposed band); otherwise the legacy position-only flush (parking at
    // the top-left, no visibility or shape control) is used, byte-
    // identical to before the feature.
    let flushed = match (inner.cursor.clone(), scroll_flush) {
        (None, Some((op, exposed))) => inner
            .backend
            .flush_scroll(&op, &exposed, (0, 0))
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?,
        (Some(cursor), _) => inner
            .backend
            .flush_diff_with_cursor(&updates, cursor)
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?,
        (None, None) => inner
            .backend
            .flush_diff(&updates, (0, 0))
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?,
    };
    inner.last_flush_bytes = flushed as u64;
    inner.last = Some(buffer);
    inner.last_painted_epoch = painted_epoch;
    inner.last_viewport = (w, h);
    inner.last_painted_viewport = (w, h);
    inner.last_painted_selection = inner.selection;
    inner.last_painted_cursor = inner.cursor.clone();
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

/// Flatten the scene's accessibility-semantics store into a flat vector
/// — one [`SceneSemanticsJs`] entry per node with a semantics entry, in
/// scene pre-order (the ids mirror the scene tree and `parent` links
/// each entry back into it, `null` for the root), so a consumer can
/// reconstruct the accessibility tree from the flat dump. Nodes whose
/// semantics were cleared are omitted.
///
/// Pure read for tests, debugging, and a11y bridges: it never touches
/// layout or painted content (the store is a parallel bookkeeping map
/// — see the core `semantics` module), and it is not gated by the
/// store's enable flag (entries written while enabled stay readable
/// after disabling). State flags are sorted for a stable dump. Errors
/// on a destroyed renderer.
#[napi(js_name = "semantics")]
pub fn semantics(&self) -> Result<Vec<SceneSemanticsJs>> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    let scene = inner.scene.clone();
    let scene_guard = scene.lock().expect("scene poisoned");
    // Walk the scene tree pre-order, emitting the semantics of every
    // populated node; pushing children in reverse makes the pop order
    // the tree order.
    let mut dump = Vec::new();
    let mut stack = vec![scene_guard.root_id()];
    while let Some(id) = stack.pop() {
        if let Some(node) = scene_guard.semantics(id) {
            let mut state: Vec<String> = node
                .state
                .iter()
                .map(|s| semantics_state_str(*s).to_string())
                .collect();
            state.sort();
            dump.push(SceneSemanticsJs {
                id: id.0,
                parent: scene_guard
                    .node(id)
                    .and_then(|n| n.parent)
                    .map(|p| p.0),
                role: node.role.as_str().to_string(),
                label: node.label.clone(),
                state,
                enabled: node.enabled,
                selected: node.selected,
            });
        }
        if let Some(children) = scene_guard.children(id) {
            for child in children.iter().rev() {
                stack.push(*child);
            }
        }
    }
    Ok(dump)
}

/// Write iTerm2 hidden accessibility annotations for the scene's
/// semantics store: one `OSC 1337 AddHiddenAnnotation` per entry, so
/// VoiceOver can read the store's nodes in iTerm2's accessibility
/// mode. Each entry's summary is `[role][: label][, state...]` — e.g.
/// `"button"`, `"textbox: Search, focused"` — and the state order is
/// kept as given (the [`semantics`](Self::semantics) dump sorts it).
///
/// The write is a strict no-op unless the renderer was constructed
/// with the `a11y_annotations` option AND the interactive probe
/// reports the terminal self-identifies as iTerm2 — the only terminal
/// that understands the sequence (see the core
/// `tern_terminal::backend::flush_a11y_annotations_gated_to`).
/// iTerm2's `AddHiddenAnnotation` does not reveal the annotation
/// window on receipt, so the write never disturbs the visible screen.
/// Errors on a destroyed renderer.
#[napi(js_name = "set_a11y_annotations")]
pub fn set_a11y_annotations(&self, entries: Vec<A11yAnnotationJs>) -> Result<()> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    let annotations: Vec<A11yAnnotation> = entries
        .iter()
        .map(|entry| A11yAnnotation::new(a11y_annotation_summary(entry)))
        .collect();
    inner
        .backend
        .set_a11y_annotations(&annotations)
        .map_err(|e| Error::from_reason(format!("set a11y annotations: {e}")))
}

}
