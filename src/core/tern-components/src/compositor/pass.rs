//! The paint-pass machinery: full paint, dirty-region repaint, frame
//! retention, selection overlay, and paint-order/region bookkeeping.

use super::*;

impl Compositor {
    /// Paint the whole scene into a fresh buffer — the correctness baseline
    /// every dirty repaint is tested against — and retain the frame state.
    ///
    /// Computes the frame's scene-absolute rects, then delegates to
    /// [`paint_full_with_rects`](Compositor::paint_full_with_rects).
    pub(super) fn paint_full(&mut self, scene: &Scene, viewport: Size, scene_epoch: u64) -> Buffer {
        let rects = self.layout_rects(scene, viewport);
        self.paint_full_with_rects(scene, viewport, scene_epoch, rects)
    }

    /// The body of a full repaint, given the frame's already-computed
    /// scene-absolute rects. Separated so the dirty path can fall through to
    /// a full repaint with the rects it already computed — a large-dirty
    /// frame must not run the layout reconcile walk twice.
    fn paint_full_with_rects(
        &mut self,
        scene: &Scene,
        viewport: Size,
        scene_epoch: u64,
        rects: HashMap<NodeId, Rect>,
    ) -> Buffer {
        // Consume the mutation-site pushed dirty set (and the force flag): a
        // full paint rebuilds every painted cell anyway, so the hint is only
        // drained to keep the set consistent for the next dirty pass.
        //
        // The retained paint signatures are rebuilt ONLY for the pushed ids
        // (or every id when a raw `node_mut` forced the full scan): a full
        // paint is taken precisely when the dirty region is large, and the
        // signature comparison only runs on the NEXT dirty pass, where a
        // missing baseline is treated conservatively as a change (the node
        // gets repainted — extra work, never a missed repaint). Skipping the
        // whole-tree walk here removes the per-frame full-scene signature
        // build (a `PaintSig` text clone per text leaf) from the large-dirty
        // path; the all-node old-vs-new RECT comparison remains the repaint
        // region's correctness backbone.
        //
        // Note: when the fallback came from the dirty path, the pushed set
        // was already drained there, so the retained signatures are (near)
        // empty — a later dirty pass then treats every pushed id without a
        // baseline as changed and repaints it, which is conservative and
        // correct.
        let (pushed, force_full_scan) = scene.take_dirty();
        let painted = self.build_paint_order(scene, &rects);
        // Reuse the retained buffer as the paint target: a full paint
        // overwrites (or blanks) every cell, so clearing it and painting in
        // place reuses its capacity instead of allocating a fresh
        // viewport-sized buffer per frame. One clone produces the caller's
        // copy; the compositor keeps the painted buffer as the next frame's
        // retained base.
        let mut buffer = self
            .last_buffer
            .take()
            .unwrap_or_else(|| Buffer::new(viewport.width, viewport.height));
        if buffer.width != viewport.width || buffer.height != viewport.height {
            buffer.resize(viewport.width, viewport.height);
        }
        buffer.clear();
        for &id in &self.order_scratch {
            if let Some(node) = scene.node(id) {
                if let Some(&rect) = rects.get(&id) {
                    // A node's frame (box background/border) is drawn through
                    // its ancestors' regions only; its content (text, stream,
                    // children) also applies its own scroll offset, so a pane
                    // scrolls its content inside its own fixed frame.
                    let frame = effective_region(scene, id, viewport, false);
                    let content = effective_region(scene, id, viewport, true);
                    let pcr = parent_clip_right(scene, node, &rects);
                    paint_node(node, rect, frame, content, &mut buffer, pcr);
                }
            }
        }
        let sigs = if force_full_scan {
            collect_paint_sigs(scene, &rects)
        } else {
            collect_paint_sigs_for(scene, &rects, &pushed)
        };
        // A full paint rebuilds every cell, so the retained region state is
        // refreshed for every node with geometry — the old painted bounds of
        // the next dirty pass must be reconstructible for any changed node.
        self.refresh_region_state(scene, &rects, None);
        // The selection overlay is applied at the final-buffer stage: on top
        // of the freshly painted frame and BEFORE the buffer is cloned for
        // the caller and retained for the next frame, so the returned buffer,
        // the retained frame and the renderer's diff all see the overlay.
        self.apply_selection_overlay(&mut buffer);
        let out = buffer.clone();
        self.retain_frame(
            viewport,
            scene_epoch,
            FrameState {
                rects,
                sigs,
                buffer,
            },
            PaintMode::Full,
            0,
            painted,
        );
        out
    }

    /// Repaint only the regions whose content changed since the last paint,
    /// copying the clean cells from the retained buffer. The result is
    /// cell-for-cell identical to [`paint_full`](Compositor::paint_full) (the
    /// tests enforce this), so the renderer's diff against the previous frame
    /// is unchanged.
    pub(super) fn paint_dirty(&mut self, scene: &Scene, viewport: Size, scene_epoch: u64) -> Buffer {
        let rects = self.layout_rects(scene, viewport);
        // Consume the mutation-site pushed dirty set: the ids of the nodes
        // mutated since the last drain, plus the force-full-scan flag a raw
        // `node_mut` borrow sets (the scene cannot introspect a raw
        // mutation). Paint signatures are collected — and compared — ONLY for
        // the pushed ids, replacing the per-frame whole-tree signature walk
        // with an O(mutated) one; the force flag falls back to the full walk.
        // The all-node old-vs-new RECT comparison below stays: geometry,
        // structural and overflow changes move rects, and the union of the
        // changed nodes' OLD ∪ NEW bounds is the repaint region's correctness
        // backbone, so a missed signature can never lose a repaint it was
        // responsible for.
        let (pushed, force_full_scan) = scene.take_dirty();
        let sigs = if force_full_scan {
            collect_paint_sigs(scene, &rects)
        } else {
            collect_paint_sigs_for(scene, &rects, &pushed)
        };

        // The dirty union: over every changed node, the OLD ∪ NEW cells it
        // can paint — its layout rect MAPPED through its effective region
        // (clip + scroll) in both frames — never the raw new bounds alone,
        // so moves, shrinks, removals, clip/scroll shifts and display:none
        // toggles leave no stale cells. A node's painted cells are bounded by
        // its rect drawn through the region: a glyph at content column `c`
        // lands at buffer column `c - scroll`, so the union covers the rect
        // shifted by the region's scroll AND the unshifted rect (a wrapped
        // streaming leaf's rows stay inside the rect), each clipped to the
        // region's clip. When a node's effective region changed (a
        // clip/scroll edit — the paint-only pushed path), its whole subtree's
        // painted cells move with it: descendants can sit anywhere inside the
        // ancestor's effective clip (absolute positioning, overflow, scroll),
        // so the effective content clip rects of both frames are unioned in
        // as well — the clip, never the ancestor's own rect, bounds the
        // subtree's painted cells.
        //
        // The ids are walked in two passes over the retained and current
        // rect maps (ids that had geometry last frame, then ids that gained
        // geometry this frame) — no per-frame id-list allocation, sort or
        // dedup; the union is order-independent, so the walk order does not
        // matter.
        let viewport_rect = Rect::new(0, 0, viewport.width as u32, viewport.height as u32);
        let mut dirty: Option<Rect> = None;
        // Paint signatures are compared only for the pushed ids (or for
        // every id when a raw `node_mut` forced the full scan): an id the
        // scene did not report as mutated cannot have changed its
        // paint-relevant state, so its old signature is still current.
        let sig_changed = |id: NodeId| {
            if force_full_scan || pushed.contains(&id) {
                match (self.last_paint_sig.get(&id), sigs.get(&id)) {
                    (Some(a), Some(b)) => a != b,
                    (None, Some(_)) | (Some(_), None) => true,
                    (None, None) => false,
                }
            } else {
                false
            }
        };
        for (&id, &old) in self.last_rects.iter() {
            let new = rects.get(&id).copied();
            if Some(old) == new && !sig_changed(id) {
                continue;
            }
            let new_content = new.map(|_| effective_region(scene, id, viewport, true));
            let new_frame = new.map(|_| effective_region(scene, id, viewport, false));
            if let (Some(n), Some(nc), Some(nf)) = (new, new_content, new_frame) {
                union_add_mapped(&mut dirty, scene, id, n, nc, viewport);
                union_add_mapped(&mut dirty, scene, id, n, nf, viewport);
            }
            match (
                self.old_effective_region(id, viewport, true),
                self.old_effective_region(id, viewport, false),
            ) {
                (Some(oc), Some(of)) => {
                    union_add_mapped(&mut dirty, scene, id, old, oc, viewport);
                    union_add_mapped(&mut dirty, scene, id, old, of, viewport);
                    // The node's effective region changed -> its whole
                    // subtree's painted cells moved with it; the subtree is
                    // bounded by the effective content clip, never by the
                    // node's own rect.
                    let region_changed = match new_content {
                        Some(nc) => {
                            nc.clip != oc.clip
                                || nc.scroll_x != oc.scroll_x
                                || nc.scroll_y != oc.scroll_y
                        }
                        None => true,
                    };
                    if region_changed {
                        union_add(&mut dirty, oc.clip, viewport_rect);
                        if let Some(nc) = new_content {
                            union_add(&mut dirty, nc.clip, viewport_rect);
                        }
                    }
                }
                // Retained region state missing (cannot happen after the
                // first full paint, but stay sound): the old painted cells
                // are unbounded, so cover the whole viewport.
                _ => union_add(&mut dirty, viewport_rect, viewport_rect),
            }
        }
        for (&id, &new) in rects.iter() {
            if self.last_rects.contains_key(&id) {
                continue;
            }
            // A node with geometry this frame but none last frame is always
            // a change (`old == new` is false), regardless of its signature.
            let nc = effective_region(scene, id, viewport, true);
            let nf = effective_region(scene, id, viewport, false);
            union_add_mapped(&mut dirty, scene, id, new, nc, viewport);
            union_add_mapped(&mut dirty, scene, id, new, nf, viewport);
        }

        let Some(union) = dirty else {
            // Defensive: nothing changed (cannot normally happen when the
            // scene epoch advanced). Return the retained frame unchanged.
            self.last_paint_mode = PaintMode::NoPaint;
            return self.last_buffer.clone().expect("retained buffer present");
        };

        // Coverage fallback (perf knob): more than half the viewport is
        // dirty, so a full repaint is cheaper and equally correct. The rects
        // computed above are passed through, so the large-dirty frame does
        // not run the layout reconcile walk twice.
        if union.area() * 2 > viewport_rect.area() {
            return self.paint_full_with_rects(scene, viewport, scene_epoch, rects);
        }

        // Repaint every z-ordered node whose painted bounds intersect the
        // dirty union — the changed nodes themselves and any overlay or
        // sibling that shares cells with them — into a blank scratch frame,
        // then copy just the union's cells back over the retained buffer.
        //
        // Painting into a scratch frame (rather than painting in place, or
        // narrowing each node's clip to the union) is what makes the dirty
        // result identical to a full paint:
        //   * in place, a node paints its WHOLE rect — a bg-filled or bordered
        //     box extends far beyond the union and would clobber retained
        //     cells belonging to nodes that are not in the repaint set;
        //   * narrowing each node's clip would change what it paints, because
        //     text/stream wrapping is computed against the node's own clip
        //     bounds — the glyph layout inside the union would differ.
        // With a scratch frame every node paints exactly as it would in a full
        // paint, and only the union's cells are taken. Cells outside the union
        // are provably unchanged: any cell whose value could differ is covered
        // by some changed node's OLD ∪ NEW painted bounds — its rect mapped
        // through its effective regions, or the effective clip when a region
        // edit moved a whole subtree — i.e. by the union itself.
        //
        // The scratch frame is pooled across frames (sized on demand, grown
        // when the viewport grows) and only its union region is cleared — a
        // cheap clear instead of blanking the whole viewport, and no per-frame
        // viewport-sized allocation.
        let painted = self.build_paint_order(scene, &rects);

        let repainted = {
            // Field-level borrow of the pooled scratch (sized on demand), so
            // the paint-order list (`self.order_scratch`) stays readable at
            // the same time.
            let scratch = self.scratch.get_or_insert_with(|| Buffer::new(0, 0));
            if scratch.width != viewport.width || scratch.height != viewport.height {
                scratch.resize(viewport.width, viewport.height);
            }
            scratch.clear_rect(union);
            let mut repainted = 0usize;
            for &id in &self.order_scratch {
                let Some(&rect) = rects.get(&id) else {
                    continue;
                };
                // Repaint a node when its painted bounds — its rect mapped
                // through its effective regions (which can extend beyond the
                // raw rect via clip/scroll), not the raw rect alone — touch
                // the union, or when its caret cell does.
                let frame = effective_region(scene, id, viewport, false);
                let content = effective_region(scene, id, viewport, true);
                let touches = painted_bounds_touch(rect, frame, &union)
                    || painted_bounds_touch(rect, content, &union)
                    || caret_cell_in(scene, id, rect, &content, &union);
                if !touches {
                    continue;
                }
                if let Some(node) = scene.node(id) {
                    let pcr = parent_clip_right(scene, node, &rects);
                    paint_node(node, rect, frame, content, scratch, pcr);
                    repainted += 1;
                }
            }
            repainted
        };
        // Reuse the retained buffer as the output: move it out, patch the
        // dirty union's cells from the freshly painted scratch (row-major
        // slice copies), and clone once for the new retained frame — one
        // copy per dirty frame instead of the previous fresh scratch
        // allocation + two full clones of the retained buffer.
        let mut buffer = self.last_buffer.take().expect("retained buffer present");
        buffer.copy_region(self.scratch.as_ref().expect("scratch present"), union);
        // The selection overlay at the final-buffer stage, BEFORE the retained
        // clone: the copied clean cells already carry the previous frame's
        // overlay (it was painted at the same selection — `selection_changed`
        // would have routed this frame to a full repaint), and the freshly
        // repainted union cells get the overlay added here. Adding REVERSED is
        // idempotent, so re-applying over already-reversed cells is a no-op.
        self.apply_selection_overlay(&mut buffer);
        let retained = buffer.clone();

        // Refresh the retained region state (own clip/scroll/parent) for the
        // ids this frame mutated (or every id when a raw `node_mut` forced
        // the full scan), AFTER the old painted bounds were reconstructed:
        // `last_regions` must keep reflecting the state the retained buffer
        // was painted at, so the refresh happens at the end of the paint,
        // from the current (already-mutated) scene, never before the union.
        self.refresh_region_state(
            scene,
            &rects,
            if force_full_scan { None } else { Some(&pushed) },
        );

        self.retain_frame(
            viewport,
            scene_epoch,
            FrameState {
                rects,
                sigs,
                buffer: retained,
            },
            PaintMode::Dirty(repainted),
            repainted,
            painted,
        );
        buffer
    }

    /// Record the frame state after a full or dirty paint.
    fn retain_frame(
        &mut self,
        viewport: Size,
        scene_epoch: u64,
        state: FrameState,
        mode: PaintMode,
        repainted: usize,
        painted: usize,
    ) {
        self.last_buffer = Some(state.buffer);
        self.last_rects = state.rects;
        self.last_paint_sig = state.sigs;
        self.last_viewport = Some(viewport);
        self.last_scene_epoch = scene_epoch;
        self.last_paint_mode = mode;
        self.last_painted_node_count = painted;
        self.last_repainted_node_count = repainted;
        self.last_selection = self.selection;
    }

    /// Apply the selection overlay (when set) to `buffer`: every non-masked
    /// cell inside the rectangle spanned by the anchor and active endpoints
    /// has [`Modifiers::REVERSED`] composed onto its **own** style — the
    /// cell's character and colors are untouched, only the modifier is added,
    /// mirroring [`Buffer::render_caret`]'s style merge. The endpoints are
    /// inclusive and normalized, so either may be the top-left corner.
    ///
    /// Masked continuation cells (the zero-width right halves of wide glyphs)
    /// are skipped, exactly like the caret: reversing a mask would corrupt
    /// the wide glyph's neighbor. The lead cell's reversal covers the whole
    /// glyph visually.
    ///
    /// A strict no-op when no selection is set — the frame is left untouched,
    /// which is what keeps an unselected compositor's output byte-identical
    /// to one without the overlay.
    fn apply_selection_overlay(&self, buffer: &mut Buffer) {
        let Some(sel) = &self.selection else {
            return;
        };
        let (ax, ay) = sel.anchor;
        let (bx, by) = sel.active;
        let x0 = ax.min(bx);
        let y0 = ay.min(by);
        let x1 = ax.max(bx);
        let y1 = ay.max(by);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let Some(cell) = buffer.cell_mut(x, y) else {
                    continue;
                };
                if cell.is_masked() {
                    continue;
                }
                cell.style = cell.style.clone().add_modifier(Modifiers::REVERSED);
            }
        }
    }

    /// Rebuild the pooled z-ordered paint list for `rects` and return its
    /// length: every laid-out node in pre-order, sorted by ascending
    /// effective z-index (stable, so equal indexes keep pre-order). The list
    /// is reused across frames — no per-frame paint-order allocation.
    fn build_paint_order(&mut self, scene: &Scene, rects: &HashMap<NodeId, Rect>) -> usize {
        self.order_scratch.clear();
        collect_paint_order(scene, scene.root_id(), rects, &mut self.order_scratch);
        self.order_scratch.sort_by(|&a, &b| z_index(scene, a).cmp(&z_index(scene, b)));
        self.order_scratch.len()
    }

    /// Refresh the retained per-node region state (own clip/scroll/parent)
    /// from the scene. With `Some(ids)` only those ids are refreshed — the
    /// incremental variant for the dirty path, sound because a node's
    /// clip/scroll/parent can only change through a mutation that pushes its
    /// id (a raw `node_mut` borrow sets the force flag, which routes to the
    /// full variant). With `None` the whole map is rebuilt from `rects` — the
    /// full-paint variant (a full paint walks every node anyway).
    ///
    /// A removed id keeps its retained entry: that entry IS the old state the
    /// removal frame must reconstruct to clear the removed subtree's cells.
    fn refresh_region_state(
        &mut self,
        scene: &Scene,
        rects: &HashMap<NodeId, Rect>,
        ids: Option<&HashSet<NodeId>>,
    ) {
        let state_of = |id: NodeId| -> Option<RegionState> {
            let node = scene.node(id)?;
            let (scroll_x, scroll_y) = scene.scroll_offset(id);
            Some(RegionState {
                parent: node.parent,
                clip: scene.clip_rect(id),
                scroll_x,
                scroll_y,
            })
        };
        match ids {
            Some(ids) => {
                for &id in ids {
                    if let Some(st) = state_of(id) {
                        self.last_regions.insert(id, st);
                    }
                }
            }
            None => {
                self.last_regions = rects.keys().filter_map(|&id| state_of(id).map(|st| (id, st))).collect();
            }
        }
    }

    /// The effective region `id` drew through at the last paint, rebuilt from
    /// the retained per-node region state (own clip/scroll/parent chain).
    /// `None` when any chain member's retained state is missing — the caller
    /// must then fall back to a conservative bound for the old painted cells.
    fn old_effective_region(&self, id: NodeId, viewport: Size, include_own: bool) -> Option<Region> {
        let mut clip = Rect::new(0, 0, viewport.width as u32, viewport.height as u32);
        let mut scroll_x = 0i32;
        let mut scroll_y = 0i32;
        let mut cur = Some(id);
        while let Some(nid) = cur {
            let st = self.last_regions.get(&nid)?;
            if include_own || nid != id {
                if let Some(c) = st.clip {
                    clip = clip.intersection(&c).unwrap_or(Rect::zero());
                }
                scroll_x += st.scroll_x;
                scroll_y += st.scroll_y;
            }
            cur = st.parent;
        }
        Some(Region::new(clip, scroll_x, scroll_y))
    }
}
