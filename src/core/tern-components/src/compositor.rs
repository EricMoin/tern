//! The compositor: runs the layout engine over a scene tree and paints the
//! laid-out nodes into a tern-core [`Buffer`].
//!
//! Painting rules (per node kind):
//!
//! * **Box** — paints its background (when a non-default `bg` is set), an
//!   optional border ring at the edges of its laid-out rect, and then lets
//!   its children paint on top. The padding inset is applied by the layout
//!   engine (children land inside `rect + border + padding`).
//! * **Text** — paints its `text` prop content starting at the rect origin,
//!   clipped to the rect (multi-width aware: a wide character never gets
//!   truncated mid-glyph at the right edge). Text leaves are multi-row: a
//!   `wrap: true` (default) leaf paints one row per wrapped soft line (`\n`
//!   forces a row break; long content soft-wraps at word boundaries, the same
//!   token-aware model `StreamingText` uses — layout sizes the leaf to the
//!   same wrapped rows), while a `wrap: false` leaf paints a single row
//!   trimmed at the right edge. A `caret` Int prop (a display column) paints
//!   the block caret over the cell under the cursor, using the node's style
//!   reversed.
//! * **StreamingText** — paints its accumulated stream spans starting at the
//!   rect origin, one row per wrapped soft line, honoring each span's style
//!   (fg/bg/modifiers), clipping to the rect bottom and right. A `wrap: false`
//!   Bool prop paints the whole stream as one single-row line instead,
//!   trimmed at the right edge (multi-width aware, never mid-glyph); `wrap:
//!   true` (or unset) keeps the word-boundary soft-wrap.
//! * **Root** — a plain container; paints nothing itself.
//!
//! The roadmap components ([`Input`](crate::Input),
//! [`Textarea`](crate::Textarea), [`Spinner`](crate::Spinner),
//! [`Panels`](crate::Panels), [`StatusBar`](crate::StatusBar)) materialize as
//! `Box`/`Text` subtrees and need no special paint handling; when one is
//! painted as the tree root, its frame is promoted to the scene root so it
//! fills the viewport (and a `StatusBar`/`Input`/`Textarea` root is given the
//! viewport row width for overflow trimming / horizontal scroll / soft wrap).
//!
//! ## Reserved status row
//!
//! A `StatusBar` in the tree owns the bottom viewport row: the layout
//! viewport handed to the engine is one row shorter, so panels and scroll
//! regions lay out entirely above it, and the strip frame — stamped
//! `status_bar: true` by [`StatusBar`](crate::StatusBar) — is pinned to that
//! row (docs/components.md "StatusBar — Reserved row"). A top-level
//! `StatusBar` therefore spans the whole bottom row, not the whole viewport.
//!
//! ## Clip and scroll regions
//!
//! Any node may declare a clip rect (the `clip_x` / `clip_y` / `clip_width` /
//! `clip_height` props) and a scroll offset (`scroll_x` / `scroll_y`). The
//! region is inherited: a node's effective region intersects its ancestors'
//! clips and sums their scroll offsets, so a scrollable pane is a box with
//! `clip_*` + `scroll_*` props whose overflowing children paint inside the
//! clipped, panned viewport. Every cell a node draws (background, border,
//! text, stream spans) is mapped through its effective region: the position
//! is shifted by the scroll offset and rejected when it lands outside the
//! clip rect (or the buffer).
//!
//! ## Paint order (z-order stacking)
//!
//! Every laid-out node (one with a rect in the layout result) is collected
//! into a flat list in pre-order (parent before children), then painted in
//! ascending order of its effective z-index — the `z_index` integer prop,
//! default 0. The sort is stable, so equal z-indexes keep pre-order: a child
//! paints after its parent, and a later sibling after an earlier one. Higher
//! z-index paints later and therefore covers lower ones, which is what lets
//! an absolutely positioned overlay with a higher `z_index` paint on top of
//! in-flow content beneath it. With no `z_index` set anywhere, the order is
//! exactly the historical pre-order, so all existing behavior is preserved.
//! Geometry comes from the layout engine ([`LayoutEngine`]); cells outside
//! the viewport are ignored.

use std::collections::{HashMap, HashSet};

use tern_core::buffer::{Buffer, Region};
use tern_core::cell::{clusters, strip_escapes, Cell};
use tern_core::color::Color;
use tern_core::cursor::Cursor;
use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropValue, Scene, SceneNode, Span};
use tern_core::style::{BorderStyle, Modifiers, Style};
use tern_layout::TaffyLayoutEngine;

use crate::renderable::Renderable;

/// Paints a scene (or a single renderable tree) into a [`Buffer`].
///
/// Stateful and incremental: the compositor owns the layout engine (which
/// owns the cached, incrementally-mutated taffy tree) plus the retained paint
/// state — the last buffer, the last scene-absolute rects and the last
/// per-node paint signatures. A frame whose scene changed repaints only the
/// regions whose content changed (dirty-region repaint): the retained buffer
/// is copied, the dirty rects (the union over changed nodes of their OLD ∪
/// NEW painted bounds) are blanked, and every z-ordered node whose painted
/// bounds intersect the dirty union is repainted. The result is cell-for-cell
/// identical to a full fresh paint (the tests enforce this), so the renderer
/// diff against the previous frame is unchanged.
///
/// The dirty set is detected from two sources. The scene itself pushes the id
/// of every node it mutates ([`Scene::take_dirty`]) — a mutation-site pushed
/// set that replaces the per-frame whole-tree paint-signature scan with an
/// O(mutated) one: paint signatures are collected and compared only for the
/// pushed ids, with the whole-tree walk kept as the fallback when a raw
/// [`Scene::node_mut`] borrow (which the scene cannot introspect) set the
/// force-full-scan flag. The all-node old-vs-new RECT comparison is retained
/// as the correctness backbone: geometry, structural and overflow changes
/// move rects, and the union of the changed nodes' OLD ∪ NEW bounds is what
/// the repaint region is built from, so the pushed set only ever narrows the
/// signature work — it never gates the repaint decision.
///
/// Full repaint (discard the retained state) happens only on explicit
/// invalidation: a cold cache, a viewport change, a different (fresh) scene
/// instance, or when the dirty region covers more than half the viewport
/// (cheaper than a patchwork of small repaints). It never falls back to full
/// repaint on "the scene epoch changed" alone — every successful mutation
/// bumps the epoch, which would bypass dirty repaint on all relevant updates.
///
/// Snapshot/test paths that only ever paint once create a fresh compositor
/// per call, which is exactly the stateful pattern for them (a fresh
/// instance, never reused across frames).
#[derive(Debug, Clone, Default)]
pub struct Compositor {
    layout: TaffyLayoutEngine,
    /// The retained frame from the last paint, copied and patched by the
    /// dirty path.
    last_buffer: Option<Buffer>,
    /// The scene-absolute rects (post status-bar pinning) of the last paint.
    last_rects: HashMap<NodeId, Rect>,
    /// The per-node paint signatures of the last paint (change detection).
    last_paint_sig: HashMap<NodeId, PaintSig>,
    /// The viewport the last paint ran at.
    last_viewport: Option<Size>,
    /// The scene epoch at the last paint; a lower epoch means a different
    /// (fresh) scene instance.
    last_scene_epoch: u64,
    /// A pooled scratch frame reused across dirty repaints (and by the full
    /// paint path). Sized to the viewport on demand and grown when the
    /// viewport grows — never a per-frame viewport-sized allocation: the
    /// previous frame's buffer capacity is reused. The dirty path clears only
    /// the union region that will be read back before repainting into it.
    scratch: Option<Buffer>,
    /// A pooled z-ordered paint list, rebuilt and reused every frame (no
    /// per-frame paint-order allocation or sort scratch).
    order_scratch: Vec<NodeId>,
    /// The per-node region-relevant state (own clip/scroll/parent) of the
    /// last paint, retained so a changed node's OLD painted bounds — which
    /// can extend beyond its layout rect through its effective region — can
    /// be reconstructed on the next dirty pass, even when the node was
    /// removed from the scene since.
    last_regions: HashMap<NodeId, RegionState>,
    /// Instrumentation: how the last frame was painted.
    last_paint_mode: PaintMode,
    /// Instrumentation: nodes in the paint order of the last frame.
    last_painted_node_count: usize,
    /// Instrumentation: nodes repainted by the last dirty pass.
    last_repainted_node_count: usize,
    /// The current selection overlay (anchor + active endpoints, inclusive
    /// buffer cells), or `None` when no selection is set (the default).
    selection: Option<Selection>,
    /// The selection the retained buffer was painted at. A change forces a
    /// full repaint: the overlay is applied to a freshly painted frame, so
    /// cells of a shrunk/moved/cleared selection can never keep a stale
    /// REVERSED from a retained frame.
    last_selection: Option<Selection>,
}

/// How the last [`paint_scene`](Compositor::paint_scene) produced its frame.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
enum PaintMode {
    /// The scene was unchanged since the last paint: the retained buffer was
    /// returned as-is.
    #[default]
    NoPaint,
    /// The whole scene was painted into a fresh buffer.
    Full,
    /// Only the dirty regions were repainted; the payload is the number of
    /// nodes repainted.
    Dirty(usize),
}

/// The compositor's selection overlay: the two inclusive cell endpoints
/// (anchor + active) in buffer space that span the selected rectangle.
///
/// The overlay is a post-pass over the painted frame — every non-masked cell
/// inside the rect has [`Modifiers::REVERSED`] composed onto its own style,
/// mirroring the block-caret machinery. It is a **no-op when unset**: a
/// compositor that never calls [`Compositor::set_selection`] produces frames
/// byte-identical to one without the overlay (the dirty-parity fuzz relies on
/// this).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Selection {
    anchor: (u16, u16),
    active: (u16, u16),
}

/// The paint-relevant state of a scene node — everything that can change what
/// its painted cells look like. Compared per frame to detect the dirty set
/// (the layout engine separately tracks the layout-relevant state).
#[derive(Debug, Clone, PartialEq)]
struct PaintSig {
    /// The node's cell style (fg/bg/modifiers/border) — paint, not layout.
    style: Style,
    /// `display: none` hides the node (and removes its geometry).
    display_none: bool,
    /// A `Text` leaf's content.
    text: Option<String>,
    /// The `caret` display column (painted by the input component).
    caret: Option<i64>,
    /// The node's clip rect (`clip_*` props), if declared.
    clip: Option<Rect>,
    /// The node's scroll offset (`scroll_*` props).
    scroll: (i32, i32),
    /// The paint z-index.
    z_index: i32,
    /// The `wrap` prop (single-row vs soft-wrap painting).
    wrap: Option<bool>,
    /// The `status_bar` marker (reserved bottom row).
    status_bar: bool,
    /// A cheap signature of a streaming leaf's content: `(span count, hash of
    /// the last span)` — the scene API only appends spans, so the length
    /// catches every append without copying the stream each frame.
    stream: Option<(usize, u64)>,
}

/// The region-relevant state of a node at a paint: its own clip rect, scroll
/// offset and parent. Retained per frame ([`Compositor::last_regions`]) so a
/// changed node's OLD painted bounds can be reconstructed on the next dirty
/// pass: the effective region a node drew through is a function of its
/// clip/scroll/parent chain, and covering the cells it painted through the
/// OLD region — not just its layout rect — is what prevents stale cells when
/// a clip or scroll edit shifts a subtree's painted output.
#[derive(Debug, Clone, Copy)]
struct RegionState {
    parent: Option<NodeId>,
    clip: Option<Rect>,
    scroll_x: i32,
    scroll_y: i32,
}

/// The frame state retained after a paint: the painted buffer, the
/// scene-absolute rects, and the per-node paint signatures. The paint order
/// is not retained (only its count) — it is rebuilt into a pooled list each
/// frame.
struct FrameState {
    rects: HashMap<NodeId, Rect>,
    sigs: HashMap<NodeId, PaintSig>,
    buffer: Buffer,
}

impl Compositor {
    /// A compositor with a fresh taffy-backed layout engine.
    pub fn new() -> Self {
        Self {
            layout: TaffyLayoutEngine::new(),
            last_buffer: None,
            last_rects: HashMap::new(),
            last_paint_sig: HashMap::new(),
            last_viewport: None,
            last_scene_epoch: 0,
            scratch: None,
            order_scratch: Vec::new(),
            last_regions: HashMap::new(),
            last_paint_mode: PaintMode::NoPaint,
            last_painted_node_count: 0,
            last_repainted_node_count: 0,
            selection: None,
            last_selection: None,
        }
    }

    /// Set the selection overlay: every non-masked cell inside the rectangle
    /// spanned by `anchor` and `active` (both inclusive, buffer space) is
    /// painted with [`Modifiers::REVERSED`] composed onto its own style from
    /// the next paint on. The endpoints are normalized at overlay time, so
    /// either may be the top-left.
    pub fn set_selection(&mut self, anchor: (u16, u16), active: (u16, u16)) {
        self.selection = Some(Selection { anchor, active });
    }

    /// Clear the selection overlay. The next paint produces a frame without
    /// any reversed selection cells.
    pub fn clear_selection(&mut self) {
        self.selection = None;
    }

    /// How the last frame was painted (test instrumentation: a localized
    /// mutation must take the dirty path, a resize the full path).
    #[cfg(test)]
    fn last_paint_mode(&self) -> &PaintMode {
        &self.last_paint_mode
    }

    /// The number of nodes in the paint order of the last frame (test
    /// instrumentation).
    #[cfg(test)]
    fn last_painted_node_count(&self) -> usize {
        self.last_painted_node_count
    }

    /// The number of nodes repainted by the last dirty pass (test
    /// instrumentation).
    #[cfg(test)]
    fn last_repainted_node_count(&self) -> usize {
        self.last_repainted_node_count
    }

    /// Paint a single renderable tree into a fresh `viewport`-sized buffer.
    ///
    /// Accepts a [`Renderable`], [`Box`](crate::Box), [`Text`](crate::Text),
    /// or any roadmap component ([`Input`](crate::Input),
    /// [`Textarea`](crate::Textarea), [`Spinner`](crate::Spinner),
    /// [`Panels`](crate::Panels), [`StatusBar`](crate::StatusBar)) root. A
    /// container root's frame is promoted to the scene root, so it fills the
    /// viewport: a top-level [`Box`](crate::Box) therefore puts its border
    /// glyphs at the edges of the buffer, and a top-level
    /// [`StatusBar`](crate::StatusBar) spans the whole bottom row.
    pub fn paint(&mut self, root: impl Into<Renderable>, viewport: Size) -> Buffer {
        let mut root: Renderable = root.into();
        let mut scene = Scene::new();
        let scene_root = scene.root_id();

        // Strip/field components painted as the tree root span the viewport
        // row: give them the real row width so overflow trimming and
        // horizontal scroll have something to work against. A root Textarea
        // wraps its lines at (and scrolls its window over) the viewport's
        // content area.
        match &mut root {
            Renderable::StatusBar(sb) => {
                sb.width = Some(viewport.width as usize);
            }
            Renderable::Input(inp) => {
                inp.width = Some(
                    (viewport.width as usize)
                        .saturating_sub(2 * (inp.padding as usize + inp.border as usize)),
                );
            }
            Renderable::Textarea(ta) => {
                let inset = 2 * (ta.padding as usize + ta.border as usize);
                ta.width = Some((viewport.width as usize).saturating_sub(inset));
                ta.height = Some((viewport.height as usize).saturating_sub(inset));
            }
            _ => {}
        }

        // A root StatusBar is a single-row strip that spans the whole bottom
        // row: its frame carries an explicit height of 1 (see
        // `StatusBar::frame`), which disables the "root fills the viewport"
        // rule, so the compositor stamps the viewport width back onto the
        // promoted frame — the strip must span the full row it pins to.
        let root_is_status_bar = matches!(root, Renderable::StatusBar(_));

        match root {
            Renderable::Text(t) => {
                scene.add_text(scene_root, &t.content, t.style);
            }
            other => {
                // Container root: promote its frame to the scene root (which
                // the layout engine sizes to the viewport), then materialize
                // its content under the root.
                let frame = other.root_box().expect("non-text roots carry a root frame");
                assert!(
                    scene.update(
                        scene_root,
                        Some(NodeKind::Box),
                        Some(frame.style),
                        Some(frame.to_props())
                    ),
                    "scene root always exists"
                );
                if root_is_status_bar {
                    scene.set_prop(scene_root, "width", PropValue::Int(viewport.width as i64));
                }
                other.materialize_under(&mut scene, scene_root);
            }
        }
        self.paint_scene(&scene, viewport)
    }

    /// Paint a whole scene into a fresh `viewport`-sized buffer.
    ///
    /// Full repaint when the retained state is invalid (cold cache, viewport
    /// change, different scene instance); otherwise, when the scene mutated,
    /// a dirty-region repaint that copies the clean cells from the retained
    /// buffer; when the scene is unchanged, the retained buffer is returned
    /// as-is.
    pub fn paint_scene(&mut self, scene: &Scene, viewport: Size) -> Buffer {
        let scene_epoch = scene.epoch();
        let cold = self.last_buffer.is_none() || self.last_rects.is_empty();
        let viewport_changed = self.last_viewport != Some(viewport);
        // A fresh scene instance resets its epoch below the last one this
        // compositor saw; its retained buffer is meaningless, so repaint
        // everything.
        let fresh_scene = self.last_scene_epoch > scene_epoch;
        // A selection edit is compositor state, not scene state: the retained
        // frame was painted at `last_selection`, so a different selection now
        // would leave the old overlay's reversed cells behind. Any selection
        // change forces a full repaint — the overlay is then applied to a
        // freshly painted frame. When the selection is unchanged, the normal
        // (no-paint / dirty / full) flow applies, with the overlay re-applied
        // on top of whatever the path produced.
        let selection_changed = self.last_selection != self.selection;
        if cold || viewport_changed || fresh_scene || selection_changed {
            return self.paint_full(scene, viewport, scene_epoch);
        }
        if scene_epoch == self.last_scene_epoch {
            // No mutation since the last paint: the retained frame is current.
            self.last_paint_mode = PaintMode::NoPaint;
            return self.last_buffer.clone().expect("retained buffer present");
        }
        self.paint_dirty(scene, viewport, scene_epoch)
    }

    /// Paint the whole scene into a fresh buffer — the correctness baseline
    /// every dirty repaint is tested against — and retain the frame state.
    ///
    /// Computes the frame's scene-absolute rects, then delegates to
    /// [`paint_full_with_rects`](Compositor::paint_full_with_rects).
    fn paint_full(&mut self, scene: &Scene, viewport: Size, scene_epoch: u64) -> Buffer {
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
    fn paint_dirty(&mut self, scene: &Scene, viewport: Size, scene_epoch: u64) -> Buffer {
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
                cell.style = cell.style.add_modifier(Modifiers::REVERSED);
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

    /// The ids of the nodes covering the cell at (`col`, `row`), ordered
    /// innermost (topmost) first, then each ancestor that also covers the
    /// cell — the "topmost z-ordered path" of hits. The scene root is never
    /// reported (it fills the viewport and would make every on-viewport cell
    /// a hit); a cell no node covers yields an empty path.
    ///
    /// A node covers a cell when the cell maps into its laid-out rect
    /// through the node's effective region (clip + scroll), matching exactly
    /// what [`paint_scene`](Compositor::paint_scene) draws: the topmost
    /// painted node at a cell is the one painted last in the z-ordered paint
    /// order, so a click at a mouse event's `column`/`row` routes to the node
    /// that is visually on top. A node's own frame (background/border) is
    /// tested through its inherited region; its content also through its own
    /// clip and scroll, so a scrollable pane's border stays hittable while
    /// scrolled-out content is not.
    pub fn hit_test(&mut self, scene: &Scene, col: i32, row: i32, viewport: Size) -> Vec<NodeId> {
        let rects = self.layout_rects(scene, viewport);
        let mut order: Vec<NodeId> = Vec::new();
        collect_paint_order(scene, scene.root_id(), &rects, &mut order);
        order.sort_by(|&a, &b| z_index(scene, a).cmp(&z_index(scene, b)));
        let root = scene.root_id();
        // Walk the paint order backwards: the first node covering the cell is
        // the one painted last, i.e. the topmost.
        for &id in order.iter().rev() {
            if id == root {
                continue;
            }
            let Some(&rect) = rects.get(&id) else {
                continue;
            };
            if node_covers(scene, id, rect, col, row, viewport) {
                // The path: the hit node, then each ancestor that also covers
                // the cell (an overflowing child's cells are owned by the
                // child alone), stopping before the root.
                let mut path = vec![id];
                let mut cur = scene.node(id).and_then(|n| n.parent);
                while let Some(pid) = cur {
                    if pid == root {
                        break;
                    }
                    if let (Some(&prect), Some(_)) = (rects.get(&pid), scene.node(pid)) {
                        if node_covers(scene, pid, prect, col, row, viewport) {
                            path.push(pid);
                        }
                    }
                    cur = scene.node(pid).and_then(|n| n.parent);
                }
                return path;
            }
        }
        Vec::new()
    }

    /// The laid-out content size of `id`: `(width, height)` in cells.
    ///
    /// For `Text` and `StreamingText` leaves the size is the *wrapped content*
    /// size: the display width of the widest wrapped line and the wrapped line
    /// count at the node's laid-out width (the same token-aware wrapping the
    /// paint pass uses, so a node's height is how many rows its content would
    /// occupy when displayed — and since the layout engine sizes wrap-enabled
    /// leaves to those same wrapped rows, this agrees with the laid-out rect
    /// too). A leaf declaring `wrap: false` paints a single row trimmed at the
    /// rect's right edge, so its content size is the rect width by one row.
    /// For every other node kind the size is the laid-out rect size from the
    /// layout engine.
    ///
    /// Returns `None` when the node is missing or has no geometry (`display:
    /// none`).
    pub fn content_size(
        &mut self,
        scene: &Scene,
        id: NodeId,
        viewport: Size,
    ) -> Option<(u32, u32)> {
        let raw = self.layout.compute(scene, viewport);
        let rects = scene_absolute_rects(scene, raw);
        let node = scene.node(id)?;
        let rect = *rects.get(&id)?;
        match node.kind {
            NodeKind::Text => {
                if !wrap_enabled(node) {
                    return Some((rect.width, 1));
                }
                let content = match node.props.get("text") {
                    Some(PropValue::Str(s)) => s.as_str(),
                    _ => "",
                };
                Some(measure_wrapped(content, rect.width))
            }
            NodeKind::StreamingText => {
                if !wrap_enabled(node) {
                    return Some((rect.width, 1));
                }
                let content: String = scene
                    .stream(id)
                    .map(|spans| spans.iter().map(|span| span.text.as_str()).collect())
                    .unwrap_or_default();
                Some(measure_wrapped(&content, rect.width))
            }
            _ => Some((rect.width, rect.height)),
        }
    }

    /// Compute scene-absolute rects for `scene` under `viewport`, reserving
    /// the bottom viewport row for the scene's `StatusBar` (when it has one).
    ///
    /// taffy 0.7 reports each node's `Layout.location` relative to its parent
    /// (verified against taffy's `round_layout` in `taffy/src/compute/mod.rs`:
    /// `layout.location = round(unrounded location)` with no parent-origin
    /// accumulation), so the raw layout result is accumulated into
    /// scene-absolute rects here. For trees where every nested parent sits at
    /// the origin (all pre-existing golden tests) this is an exact no-op; it
    /// is what makes depth-2+ subtrees — nested boxes, and the roadmap
    /// components' group/panel -> text leaves — land at their real scene
    /// positions.
    ///
    /// A `StatusBar` owns the reserved row (docs/components.md "StatusBar —
    /// Reserved row"): the layout viewport handed to the engine is one row
    /// shorter, so every panel and scroll region lays out entirely above the
    /// row; the strip frame — and with it the whole strip subtree — is then
    /// pinned to that row, so no panel/scroll region overlaps it. A scene
    /// without a `StatusBar` is laid out against the full viewport exactly as
    /// before.
    fn layout_rects(&mut self, scene: &Scene, viewport: Size) -> HashMap<NodeId, Rect> {
        let Some(sb) = find_status_bar(scene) else {
            return scene_absolute_rects(scene, self.layout.compute(scene, viewport));
        };
        // One row shorter for the panels; never below one row so a
        // degenerate 1-row viewport still lays out (it is the strip's own
        // row — a root `StatusBar` keeps working there).
        let layout_viewport = Size::new(viewport.width, viewport.height.saturating_sub(1).max(1));
        let mut rects = scene_absolute_rects(scene, self.layout.compute(scene, layout_viewport));
        // Pin the strip frame to the reserved row and shift its whole subtree
        // by the same delta, so the segments keep their internal geometry.
        let Some(&frame) = rects.get(&sb) else {
            return rects;
        };
        let dy = viewport.height as i32 - 1 - frame.y;
        if dy != 0 {
            let mut stack: Vec<NodeId> = vec![sb];
            while let Some(id) = stack.pop() {
                if let Some(rect) = rects.get_mut(&id) {
                    rect.y += dy;
                }
                if let Some(node) = scene.node(id) {
                    stack.extend(node.children.iter().copied());
                }
            }
        }
        rects
    }
}

/// Whether `id` (with laid-out rect `rect`) covers the cell (`col`, `row`)
/// under the given viewport: the cell maps into the rect through the node's
/// effective region, and the mapped position lands inside the region's clip.
///
/// Both the frame region (own clip/scroll excluded — the box's background and
/// border) and the content region (own clip/scroll included — its text, stream
/// and children) are tested, so a scrollable pane's frame stays hittable where
/// its own clip would reject content, while scrolled-out content is not.
fn node_covers(scene: &Scene, id: NodeId, rect: Rect, col: i32, row: i32, viewport: Size) -> bool {
    hits_region(scene, id, rect, col, row, viewport, false)
        || hits_region(scene, id, rect, col, row, viewport, true)
}

/// The half of [`node_covers`] that tests one effective region variant. A
/// content cell at scene origin (`col + scroll`, `row + scroll`) maps to
/// buffer cell (`col`, `row`); the node covers the buffer cell iff that origin
/// lies in the rect and the mapped cell lies in the region's clip.
fn hits_region(
    scene: &Scene,
    id: NodeId,
    rect: Rect,
    col: i32,
    row: i32,
    viewport: Size,
    include_own: bool,
) -> bool {
    let region = effective_region(scene, id, viewport, include_own);
    let ox = col + region.scroll_x;
    let oy = row + region.scroll_y;
    rect.contains(ox, oy) && region.contains(ox, oy)
}

/// The id of the scene's `StatusBar` strip frame, if any: the node stamped
/// `status_bar: true` by [`StatusBar::materialize_content`](crate::StatusBar)
/// when it materializes. The compositor uses the marker to reserve the bottom
/// viewport row for the strip (docs/components.md "StatusBar — Reserved row");
/// like `z_index` / `wrap` it is compositor-consumed, never a layout keyword.
fn find_status_bar(scene: &Scene) -> Option<NodeId> {
    fn walk(scene: &Scene, id: NodeId) -> Option<NodeId> {
        let node = scene.node(id)?;
        if matches!(node.props.get("status_bar"), Some(PropValue::Bool(true))) {
            return Some(id);
        }
        node.children.iter().find_map(|&child| walk(scene, child))
    }
    walk(scene, scene.root_id())
}

/// Convert taffy's parent-relative layout rects into scene-absolute rects by
/// walking the tree pre-order and adding each parent's scene origin. The
/// scene root has no parent, so its rect is already absolute; a descendant's
/// scene rect is its relative rect translated by its parent's scene origin.
/// A node without geometry (e.g. `display: none`) contributes no offset.
fn scene_absolute_rects(scene: &Scene, relative: Vec<(NodeId, Rect)>) -> HashMap<NodeId, Rect> {
    let rel: HashMap<NodeId, Rect> = relative.into_iter().collect();
    let mut abs: HashMap<NodeId, Rect> = HashMap::new();
    fn walk(
        scene: &Scene,
        id: NodeId,
        rel: &HashMap<NodeId, Rect>,
        abs: &mut HashMap<NodeId, Rect>,
        parent_origin: (i32, i32),
    ) {
        let Some(node) = scene.node(id) else {
            return;
        };
        let origin = match rel.get(&id) {
            Some(r) => {
                let scene_rect = Rect::new(
                    r.x + parent_origin.0,
                    r.y + parent_origin.1,
                    r.width,
                    r.height,
                );
                abs.insert(id, scene_rect);
                (scene_rect.x, scene_rect.y)
            }
            None => parent_origin,
        };
        for &child in &node.children {
            walk(scene, child, rel, abs, origin);
        }
    }
    walk(scene, scene.root_id(), &rel, &mut abs, (0, 0));
    abs
}

/// The effective region a node draws through: the intersection of the clip
/// rects declared on the node's ancestors (plus the node itself when
/// `include_own`), and the sum of the same scroll offsets. The region is in
/// scene coordinates; drawing is shifted by the scroll and rejected when the
/// mapped cell lands outside the clip.
///
/// `include_own` selects whether the node's *own* clip rect and scroll offset
/// participate: `false` for a box's frame (its background/border draw through
/// the inherited region only, so a pane's border stays put while its content
/// pans), `true` for content (text, stream spans, children), where the node's
/// own clip bounds its subtree and its own scroll pans it inside the clip.
fn effective_region(scene: &Scene, id: NodeId, viewport: Size, include_own: bool) -> Region {
    let mut clip = Rect::new(0, 0, viewport.width as u32, viewport.height as u32);
    let mut scroll_x = 0i32;
    let mut scroll_y = 0i32;
    let mut cur = Some(id);
    while let Some(nid) = cur {
        if include_own || nid != id {
            if let Some(c) = scene.clip_rect(nid) {
                clip = clip.intersection(&c).unwrap_or(Rect::zero());
            }
        }
        if include_own || nid != id {
            let (sx, sy) = scene.scroll_offset(nid);
            scroll_x += sx;
            scroll_y += sy;
        }
        cur = scene.node(nid).and_then(|n| n.parent);
    }
    Region::new(clip, scroll_x, scroll_y)
}

/// Collect every laid-out node in the subtree rooted at `id` into `out`, in
/// pre-order (parent before children). Nodes without geometry (e.g.
/// `display: none`) are skipped.
fn collect_paint_order(
    scene: &Scene,
    id: NodeId,
    rects: &HashMap<NodeId, Rect>,
    out: &mut Vec<NodeId>,
) {
    let Some(node) = scene.node(id) else {
        return;
    };
    if rects.contains_key(&id) {
        out.push(id);
    }
    for &child in &node.children {
        collect_paint_order(scene, child, rects, out);
    }
}

/// The effective paint z-index of a node: its `z_index` integer prop, or 0
/// when unset. Higher values paint later (on top).
fn z_index(scene: &Scene, id: NodeId) -> i32 {
    match scene.prop(id, "z_index") {
        Some(PropValue::Int(i)) => *i as i32,
        _ => 0,
    }
}

/// Per-node paint signatures for every node with geometry this frame — the
/// whole-tree walk, used by [`Compositor::paint_full`] and as the
/// force-full-scan fallback of [`Compositor::paint_dirty`].
fn collect_paint_sigs(scene: &Scene, rects: &HashMap<NodeId, Rect>) -> HashMap<NodeId, PaintSig> {
    let mut sigs = HashMap::new();
    let mut stack = vec![scene.root_id()];
    while let Some(id) = stack.pop() {
        if rects.contains_key(&id) {
            if let Some(sig) = paint_sig_of(scene, id) {
                sigs.insert(id, sig);
            }
        }
        if let Some(node) = scene.node(id) {
            stack.extend(node.children.iter().copied());
        }
    }
    sigs
}

/// Per-node paint signatures for exactly the given ids (each with geometry
/// this frame). The pushed-id counterpart of [`collect_paint_sigs`]: O(|ids|)
/// instead of O(nodes). The mutation-site pushed dirty set
/// ([`Scene::take_dirty`]) names precisely the nodes that could have changed
/// since the last drain, so their signatures are the only ones that need
/// re-collecting and comparing.
fn collect_paint_sigs_for(
    scene: &Scene,
    rects: &HashMap<NodeId, Rect>,
    ids: &HashSet<NodeId>,
) -> HashMap<NodeId, PaintSig> {
    let mut sigs = HashMap::new();
    for &id in ids {
        if rects.contains_key(&id) {
            if let Some(sig) = paint_sig_of(scene, id) {
                sigs.insert(id, sig);
            }
        }
    }
    sigs
}

/// The paint-relevant state of a node: everything that can change what its
/// painted cells look like.
fn paint_sig_of(scene: &Scene, id: NodeId) -> Option<PaintSig> {
    let node = scene.node(id)?;
    let stream = if matches!(node.kind, NodeKind::StreamingText) {
        scene.stream(id).map(stream_paint_signature)
    } else {
        None
    };
    Some(PaintSig {
        style: node.style,
        display_none: matches!(prop_str_scene(scene, id, "display"), Some("none")),
        text: match node.props.get("text") {
            Some(PropValue::Str(s)) => Some(s.clone()),
            _ => None,
        },
        caret: match node.props.get("caret") {
            Some(PropValue::Int(i)) => Some(*i),
            _ => None,
        },
        clip: scene.clip_rect(id),
        scroll: scene.scroll_offset(id),
        z_index: z_index(scene, id),
        wrap: match node.props.get("wrap") {
            Some(PropValue::Bool(b)) => Some(*b),
            _ => None,
        },
        status_bar: matches!(node.props.get("status_bar"), Some(PropValue::Bool(true))),
        stream,
    })
}

/// Read a string property from a scene node (local helper so the paint
/// signature does not borrow the node past the map access).
fn prop_str_scene<'a>(scene: &'a Scene, id: NodeId, key: &str) -> Option<&'a str> {
    match scene.prop(id, key) {
        Some(PropValue::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// A cheap change signature for a streaming leaf's content: the span count
/// and a hash of the last span's text + style. The scene API only appends
/// spans (no in-place stream mutation), so the length catches every append;
/// the last-span hash additionally catches in-place mutation of the final
/// span — without copying the whole stream each frame.
fn stream_paint_signature(spans: &[Span]) -> (usize, u64) {
    let len = spans.len();
    let hash = match spans.last() {
        Some(last) => {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            last.text.hash(&mut h);
            last.style.hash(&mut h);
            h.finish()
        }
        None => 0,
    };
    (len, hash)
}

/// The smallest rect containing both `a` and `b`.
fn rect_union(a: Rect, b: Rect) -> Rect {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = a.right().max(b.right());
    let y1 = a.bottom().max(b.bottom());
    Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
}

/// Whether `id`'s caret cell (rect origin + its `caret` display column) falls
/// inside `r` — a text/streaming leaf with a caret paints that cell even
/// outside its own rect, so it must be repainted when the dirty region
/// touches it.
fn caret_cell_in(scene: &Scene, id: NodeId, rect: Rect, content: &Region, r: &Rect) -> bool {
    let col = match scene.prop(id, "caret") {
        Some(PropValue::Int(i)) => *i,
        _ => return false,
    };
    // The caret cell, mapped through the content region like any other cell.
    let cx = rect.x + col as i32 - content.scroll_x;
    let cy = rect.y - content.scroll_y;
    r.contains(cx, cy)
}

/// Fold one region into the dirty union (clipped to the viewport).
fn union_add(dirty: &mut Option<Rect>, region: Rect, viewport_rect: Rect) {
    if let Some(r) = region.intersection(&viewport_rect) {
        if r.width > 0 && r.height > 0 {
            *dirty = Some(match *dirty {
                Some(d) => rect_union(d, r),
                None => r,
            });
        }
    }
}

/// Fold the painted bounds of `rect` drawn through `region` into the dirty
/// union: the rect shifted by the region's scroll, plus the unshifted rect (a
/// wrapped streaming leaf's rows stay inside the rect), each clipped to the
/// region's clip. Every cell the node can paint through `region` lies inside
/// these bounds. A caret-bearing text/streaming leaf additionally covers its
/// whole mapped row — the caret column can lie beyond the rect.
fn union_add_mapped(
    dirty: &mut Option<Rect>,
    scene: &Scene,
    id: NodeId,
    rect: Rect,
    region: Region,
    viewport: Size,
) {
    if let Some(m) = region
        .clip
        .intersection(&rect.offset(-region.scroll_x, -region.scroll_y))
    {
        union_add(dirty, m, Rect::new(0, 0, viewport.width as u32, viewport.height as u32));
    }
    if let Some(m) = region.clip.intersection(&rect) {
        union_add(dirty, m, Rect::new(0, 0, viewport.width as u32, viewport.height as u32));
    }
    let is_caret_leaf = matches!(
        scene.node(id).map(|n| n.kind),
        Some(NodeKind::Text | NodeKind::StreamingText)
    ) && matches!(scene.prop(id, "caret"), Some(PropValue::Int(_)));
    if is_caret_leaf {
        let row = Rect::new(0, rect.y - region.scroll_y, viewport.width as u32, 1);
        if let Some(m) = region.clip.intersection(&row) {
            union_add(dirty, m, Rect::new(0, 0, viewport.width as u32, viewport.height as u32));
        }
    }
}

/// Whether `rect` drawn through `region` can paint any cell inside `u` — the
/// repaint-selection counterpart of the dirty union's painted bounds: the
/// rect shifted by the region's scroll, plus the unshifted rect (a wrapped
/// streaming leaf's rows stay inside the rect), each clipped to the region's
/// clip. A node whose painted cells fall inside the union is repainted; a
/// node whose cells all fall outside it paints nothing the union needs.
fn painted_bounds_touch(rect: Rect, region: Region, u: &Rect) -> bool {
    let shifted = rect.offset(-region.scroll_x, -region.scroll_y);
    [shifted, rect].iter().any(|r| {
        region
            .clip
            .intersection(r)
            .and_then(|m| m.intersection(u))
            .is_some()
    })
}

/// Paint a single node into its laid-out rect, drawing its frame through
/// `frame` (box background/border) and its content through `content` (text,
/// stream spans).
fn paint_node(
    node: &SceneNode,
    rect: Rect,
    frame: Region,
    content: Region,
    buffer: &mut Buffer,
    parent_clip_right: Option<i32>,
) {
    match node.kind {
        NodeKind::Root => {}
        NodeKind::Box => paint_box(node, rect, frame, buffer),
        NodeKind::Text => paint_text(node, rect, content, buffer, parent_clip_right),
        NodeKind::StreamingText => {
            paint_streaming_text(node, rect, content, buffer, parent_clip_right)
        }
    }
}

/// The right edge a `wrap: false` single-row leaf must not paint past: the
/// tightest padding-box right edge (border box minus the border width) along
/// its ancestor chain. A single-row text is intrinsic-width (never
/// flex-shrunk), so it — and any intermediate auto-width container — can
/// overflow the enclosing frame; clipping at the tightest ancestor bound
/// keeps every ancestor's border ring visible (the status-bar ellipsis case:
/// the `…` lands on the last CONTENT cell of the frame instead of
/// overwriting its border glyph). `None` when no ancestor has a laid-out
/// rect — the region clip then bounds the paint as before.
fn parent_clip_right(scene: &Scene, node: &SceneNode, rects: &HashMap<NodeId, Rect>) -> Option<i32> {
    let mut tightest: Option<i32> = None;
    let mut cur = node.parent;
    while let Some(parent_id) = cur {
        let Some(parent) = scene.node(parent_id) else {
            break;
        };
        if parent.kind == NodeKind::Root {
            break;
        }
        if let Some(prect) = rects.get(&parent_id) {
            // The effective border width: the explicit `border` prop, else 1
            // when the style declares a visible border ring (the ring is
            // painted from the style alone, so it must inset children even
            // without the prop — the binding injects `border: 1` for styled
            // boxes, and raw Rust scenes get the same rule here).
            let border = match parent.props.get("border") {
                Some(PropValue::Int(b)) => *b as i32,
                Some(PropValue::Float(f)) => *f as i32,
                _ if parent.style.border_style != BorderStyle::None => 1,
                _ => 0,
            };
            let edge = prect.right() - border.max(0);
            tightest = Some(tightest.map_or(edge, |t| t.min(edge)));
        }
        cur = parent.parent;
    }
    tightest
}

/// Paint a box: background fill, optional border ring, then children (painted
/// by the traversal) on top. The padding inset is baked into the children's
/// layout rects. The frame is drawn through `region` (the node's own scroll
/// excluded), so a scrollable pane's background and border stay put while its
/// content pans inside them.
fn paint_box(node: &SceneNode, rect: Rect, region: Region, buffer: &mut Buffer) {
    // The mapped extent of the rect through the region, clamped to the
    // region's clip and the buffer. Computed in i32: a mapped edge can land
    // outside the buffer (a scroll can push the rect's far edge negative),
    // and casting a negative end coordinate to u16 would underflow to a huge
    // value — painting a ring that spans the whole buffer. When either
    // extent is empty the box is fully invisible through the region and
    // paints nothing (the dirty-union coverage proof relies on this: a
    // node's painted cells never exceed its rect mapped through its
    // regions, so the union — built from those mapped rects — always covers
    // them).
    let x0 = region.map_x(rect.x).max(region.clip.x).max(0);
    let y0 = region.map_y(rect.y).max(region.clip.y).max(0);
    let x1 = region
        .map_x(rect.right())
        .min(region.clip.right())
        .min(buffer.width as i32);
    let y1 = region
        .map_y(rect.bottom())
        .min(region.clip.bottom())
        .min(buffer.height as i32);
    if x1 <= x0 || y1 <= y0 {
        return;
    }

    // Background: fill the rect only when a non-default background is set, so
    // default boxes stay transparent over whatever is beneath them.
    if node.style.bg != Color::Default {
        let x0 = x0 as u16;
        let y0 = y0 as u16;
        let x1 = x1 as u16;
        let y1 = y1 as u16;
        for y in y0..y1 {
            for x in x0..x1 {
                buffer.set_cell(x, y, Cell::styled(' ', node.style));
            }
        }
    }

    // Border ring: concrete glyphs are chosen here (tern-core carries only the
    // style choice); the ring is clipped to the region (and the buffer). A
    // `border_color` set on the style replaces the glyphs' foreground — the
    // ring then paints in that color while the rest of the style (background,
    // modifiers) is unchanged; unset (`Color::Default`) the glyphs paint with
    // the style's own `fg` exactly as before the field existed.
    let Some((tl, tr, bl, br, h, v)) = border_glyphs(node.style.border_style) else {
        return;
    };
    let border_style = if node.style.border_color != Color::Default {
        node.style.fg(node.style.border_color)
    } else {
        node.style
    };
    let x0 = x0 as u16;
    let y0 = y0 as u16;
    let x1 = x1 as u16;
    let y1 = y1 as u16;
    let last_x = x1 - 1;
    let last_y = y1 - 1;
    for x in x0..x1 {
        buffer.set_char(x, y0, h, border_style); // top edge
        buffer.set_char(x, last_y, h, border_style); // bottom edge
    }
    for y in y0..y1 {
        buffer.set_char(x0, y, v, border_style); // left edge
        buffer.set_char(last_x, y, v, border_style); // right edge
    }
    // Corners (overwrite the edge glyphs).
    buffer.set_char(x0, y0, tl, border_style);
    buffer.set_char(last_x, y0, tr, border_style);
    buffer.set_char(x0, last_y, bl, border_style);
    buffer.set_char(last_x, last_y, br, border_style);
}

/// Paint a text leaf's content starting at its rect origin, through `region`
/// (the content is shifted by the region's scroll offset and clipped to its
/// clip rect — and to the buffer).
///
/// A wrap-enabled leaf (wrap unset or `true`) paints **one row per wrapped
/// soft line**: a `\n`/`\r\n` forces a row break and long content soft-wraps
/// at word boundaries exactly like `paint_streaming_text` (the same
/// `paint_word` token-aware model), so layout, `content_size`, and paint all
/// agree on the same rows. A `wrap: false` leaf paints its content as one
/// single row trimmed at the right edge. Text advances grapheme cluster by
/// cluster: a cluster that would straddle the right edge wraps whole to the
/// next row — or is dropped whole when it cannot fit a fresh row either (a
/// ZWJ emoji or a combining sequence stays whole, never split mid-cluster).
/// ANSI/OSC/CSI escape sequences are stripped at ingestion
/// ([`strip_escapes`](tern_core::cell::strip_escapes)): they occupy no
/// columns and never reach the buffer.
///
/// When the node carries a `caret` Int prop (a display-column offset — the
/// [`Input`](crate::Input) component stamps it), the block caret is painted
/// over the cell under the cursor using the node's own style reversed, via
/// tern-core's [`Buffer::render_caret`] (subtask 3's caret machinery). The
/// caret is painted even over the placeholder when the text is empty, and it
/// always rides the leaf's first row — display rows below it wrap, the caret
/// stays on row 1. The caret position is mapped through the region like any
/// other cell, so a scrolled/clipped text leaf scrolls its caret along with
/// its content.
fn paint_text(
    node: &SceneNode,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    parent_clip_right: Option<i32>,
) {
    // A rect with no interior rows (zero height) has no painted extent — its
    // cells are bounded by the rect mapped through the region, and the dirty
    // union is built from exactly those mapped rects, so a node must never
    // paint outside them (mirrors `paint_streaming_text`'s `bottom <= rect.y`
    // guard). Without this, a zero-height text leaf would still paint its row
    // in a full paint while the incremental path — whose union can prove
    // nothing about a zero-height rect — would skip it.
    if rect.bottom() <= rect.y {
        return;
    }
    if let Some(PropValue::Str(content)) = node.props.get("text") {
        let content = strip_escapes(content);
        if wrap_enabled(node) {
            paint_text_wrapped(&content, node.style, rect, region, buffer);
        } else {
            let ellipsis = matches!(node.props.get("ellipsis"), Some(PropValue::Bool(true)));
            paint_text_single_row(&content, node.style, rect, region, buffer, ellipsis, parent_clip_right);
        }
    }

    if let Some(PropValue::Int(caret_col)) = node.props.get("caret") {
        let cx = rect.x + *caret_col as i32;
        let cy = rect.y;
        if region.contains(cx, cy) {
            let bx = region.map_x(cx);
            let by = region.map_y(cy);
            if bx >= 0 && by >= 0 {
                let caret_style = node.style.add_modifier(Modifiers::REVERSED);
                let cursor = Cursor::new(bx as u16, by as u16).styled(caret_style);
                buffer.render_caret(cursor);
            }
        }
    }
}

/// Paint a wrap-enabled text leaf's content at the rect origin, one row per
/// wrapped soft line, through `region` — the `Text` counterpart of
/// `paint_streaming_text`'s wrap pass. A `\n`/`\r\n` forces a row break; a
/// token (a whitespace-free run) that does not fit the current row wraps
/// whole to the next row when it fits a fresh one; a token wider than the
/// whole row is hard-broken across rows; a trailing space at a row's end is
/// dropped. A wide glyph that would straddle the right edge — or that is
/// wider than the row itself — wraps to the next row, or is dropped whole
/// when it cannot fit a fresh row either; a cluster is never split
/// mid-glyph. Painting stops at the rect's bottom edge; rows whose mapped
/// position falls outside the node's own frame are skipped, so scrolled
/// content stays inside the pane (see [`row_inside_frame`]).
fn paint_text_wrapped(content: &str, style: Style, rect: Rect, region: Region, buffer: &mut Buffer) {
    let right = rect.right().min(region.clip.right() + region.scroll_x);
    // Content rows pan inside the node's own frame: the last content row that
    // can map into the frame is `rect.bottom() + scroll_y - 1`, so the layout
    // runs rows up to (exclusive) that bound. Rows whose mapped position
    // falls outside the frame are skipped at paint time.
    let bottom = rect.bottom() + region.scroll_y;
    if right <= rect.x || bottom <= rect.y {
        return;
    }

    let mut cursor = WrapCursor {
        row: rect.y,
        col: rect.x,
    };
    let mut word = String::new();
    for cluster in clusters(content) {
        match cluster.text {
            // Hard break: flush the pending word, then start a new row.
            // CRLF is a single grapheme cluster and breaks like LF.
            "\n" | "\r\n" => {
                paint_word(&word, style, rect, &mut cursor, region, buffer, false);
                word.clear();
                cursor.row += 1;
                cursor.col = rect.x;
                if cursor.row >= bottom {
                    return;
                }
            }
            // Soft break: flush the pending word, then place the space only
            // when it fits; a trailing space at a row's end is dropped (the
            // wrap would collapse it anyway).
            " " => {
                paint_word(&word, style, rect, &mut cursor, region, buffer, false);
                word.clear();
                if cursor.row < bottom && cursor.col < right {
                    buffer.set_char_region(cursor.col, cursor.row, ' ', style, region);
                    cursor.col += 1;
                }
            }
            _ => word.push_str(cluster.text),
        }
    }
    paint_word(&word, style, rect, &mut cursor, region, buffer, false);
}

/// Paint a `wrap: false` text leaf as a single row at the rect origin: the
/// content paints left-to-right on `rect.y`, and the line is trimmed at the
/// right edge (`right`), dropping any glyph that would straddle it — never
/// split mid-glyph, multi-width aware. A hard `\n` ends the line (there is no
/// next row in single-row mode). The row is drawn through `region` like any
/// other cell.
///
/// When `ellipsis` is true and the content is trimmed (or would run past the
/// right edge), the last visible cell paints the `…` glyph instead — the
/// single-row truncation affordance (status bars, headers). The ellipsis is
/// only drawn when something was actually cut off; content that fits exactly
/// paints unchanged.
fn paint_text_single_row(
    content: &str,
    style: Style,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    ellipsis: bool,
    clip_right: Option<i32>,
) {
    // The single row must land inside the clip (mirrors the pre-wrap guard).
    let y = rect.y;
    if region.map_y(y) < region.clip.y
        || region.map_y(y) >= region.clip.bottom()
        || region.clip.bottom() <= region.clip.y
    {
        return;
    }
    let right = rect
        .right()
        .min(region.clip.right() + region.scroll_x)
        .min(clip_right.unwrap_or(i32::MAX));
    if right <= rect.x {
        return;
    }
    let mut cx = rect.x;
    let mut truncated = false;
    for cluster in clusters(content) {
        // single-row: a hard newline ends the line — the content up to it
        // was painted in full, so no ellipsis.
        if cluster.text == "\n" || cluster.text == "\r\n" {
            return;
        }
        let w = cluster.width;
        if w == 0 {
            continue;
        }
        // Trim: a glyph at (or past) the right edge, or one that would
        // straddle it, is dropped whole (never mid-cluster); nothing after
        // it fits either.
        if cx >= right || cx + w as i32 > right {
            truncated = true;
            break;
        }
        if cx >= 0 {
            buffer.set_cluster_region(cx, y, &cluster, style, region);
        }
        cx += w as i32;
    }
    // The truncation affordance: content was cut off, so the last visible
    // cell reports it with `…` (overwriting whatever glyph it held).
    if truncated && ellipsis && right - 1 >= rect.x {
        buffer.set_char_region(right - 1, y, '…', style, region);
    }
}

/// The cursor for a streaming-text paint pass: the next row and column to
/// paint at, in scene coordinates.
struct WrapCursor {
    row: i32,
    col: i32,
}

/// Whether a text/streaming node soft-wraps its content: false only when the
/// node explicitly declares `wrap: false`. Absent or `wrap: true` keeps the
/// word-boundary soft-wrap (the default behavior).
fn wrap_enabled(node: &SceneNode) -> bool {
    !matches!(node.props.get("wrap"), Some(PropValue::Bool(false)))
}

/// Paint a `StreamingText` leaf: its accumulated stream spans are
/// concatenated in order and painted into the rect starting at its origin,
/// one row per wrapped soft line, through `region` (shifted by the region's
/// scroll offset, clipped to its clip rect and the buffer).
///
/// Wrapping is greedy and token-aware: a token (a whitespace-free run) that
/// does not fit on the current row wraps whole to the next row; a token wider
/// than the whole rect is hard-broken across rows. Each span paints with its
/// own style (fg/bg/modifiers); span boundaries are flush points so one span's
/// style never bleeds into the next. A wide character that would straddle the
/// right edge — or that is wider than the row itself — is dropped, never split
/// mid-glyph. Painting stops at the rect's bottom edge; both edges are clipped
/// to the region and the buffer. ANSI/OSC/CSI escape sequences are stripped
/// at ingestion ([`strip_escapes`](tern_core::cell::strip_escapes)): they
/// occupy no columns and never reach the buffer, so measurement and painting
/// agree by construction.
///
/// A node with `wrap: false` instead paints its whole stream as one
/// single-row line, trimmed at the right edge (see
/// [`paint_streaming_text_single_row`]).
fn paint_streaming_text(
    node: &SceneNode,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    parent_clip_right: Option<i32>,
) {
    let Some(stream) = node.stream.as_deref() else {
        return;
    };
    if stream.is_empty() {
        return;
    }
    if !wrap_enabled(node) {
        let ellipsis = matches!(node.props.get("ellipsis"), Some(PropValue::Bool(true)));
        return paint_streaming_text_single_row(stream, rect, region, buffer, ellipsis, parent_clip_right);
    }
    let right = rect.right().min(region.clip.right() + region.scroll_x);
    // Content rows pan inside the node's own frame: the last content row that
    // can map into the frame is `rect.bottom() + scroll_y - 1`, so the layout
    // runs rows up to (exclusive) that bound. Rows whose mapped position
    // falls outside the frame are skipped at paint time (see
    // [`row_inside_frame`]).
    let bottom = rect.bottom() + region.scroll_y;
    if right <= rect.x || bottom <= rect.y {
        return;
    }

    let mut cursor = WrapCursor {
        row: rect.y,
        col: rect.x,
    };
    let mut word = String::new();
    let mut word_style = Style::new();

    for span in stream {
        let text = strip_escapes(&span.text);
        for cluster in clusters(&text) {
            match cluster.text {
                // Hard break: flush the pending word, then start a new row.
                // CRLF is a single grapheme cluster and breaks like LF.
                "\n" | "\r\n" => {
                    paint_word(&word, word_style, rect, &mut cursor, region, buffer, true);
                    word.clear();
                    cursor.row += 1;
                    cursor.col = rect.x;
                    if cursor.row >= bottom {
                        return;
                    }
                }
                // Soft break: flush the pending word, then place the space
                // only when it fits; a trailing space at a row's end is
                // dropped (the wrap would collapse it anyway).
                " " => {
                    paint_word(&word, word_style, rect, &mut cursor, region, buffer, true);
                    word.clear();
                    if cursor.row < bottom
                        && cursor.col < right
                        && row_inside_frame(rect, region, cursor.row)
                    {
                        buffer.set_char_region(cursor.col, cursor.row, ' ', span.style, region);
                        cursor.col += 1;
                    }
                }
                _ => {
                    if word.is_empty() {
                        word_style = span.style;
                    }
                    word.push_str(cluster.text);
                }
            }
        }
        // Span boundary: flush so per-span styles stay exact across spans.
        paint_word(&word, word_style, rect, &mut cursor, region, buffer, true);
        word.clear();
        if cursor.row >= bottom {
            return;
        }
    }
}

/// Paint a `wrap: false` stream as a single row at the rect's origin: the
/// concatenated spans paint left-to-right on `rect.y`, and the line is
/// trimmed at the right edge (`right`), dropping any glyph that would straddle
/// it — never split mid-glyph, multi-width aware. A hard `\n` ends the line
/// (there is no next row in single-row mode). Each span paints with its own
/// style; the row is drawn through `region` like any other cell.
fn paint_streaming_text_single_row(
    stream: &[Span],
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    ellipsis: bool,
    clip_right: Option<i32>,
) {
    // A zero-height rect has no painted extent (see the `paint_text` guard).
    if rect.bottom() <= rect.y {
        return;
    }
    let right = rect
        .right()
        .min(region.clip.right() + region.scroll_x)
        .min(clip_right.unwrap_or(i32::MAX));
    if right <= rect.x {
        return;
    }
    // The single row must land inside the clip (mirrors paint_text's guard).
    if region.map_y(rect.y) < region.clip.y
        || region.map_y(rect.y) >= region.clip.bottom()
        || region.clip.bottom() <= region.clip.y
    {
        return;
    }
    let mut cx = rect.x;
    let mut truncated = false;
    // The style of the span whose content was cut off — the ellipsis paints
    // with it.
    let mut trim_style = Style::new();
    for span in stream {
        let text = strip_escapes(&span.text);
        for cluster in clusters(&text) {
            if cluster.text == "\n" || cluster.text == "\r\n" {
                return; // single-row: the line ends here
            }
            let w = cluster.width;
            if w == 0 {
                continue;
            }
            // Trim: a glyph at (or past) the right edge, or one that would
            // straddle it, is dropped whole (never mid-cluster); nothing
            // after it fits either.
            if cx >= right || cx + w as i32 > right {
                truncated = true;
                trim_style = span.style;
                break;
            }
            buffer.set_cluster_region(cx, rect.y, &cluster, span.style, region);
            cx += w as i32;
        }
        if truncated {
            break;
        }
    }
    if truncated && ellipsis && right - 1 >= rect.x {
        buffer.set_char_region(right - 1, rect.y, '…', trim_style, region);
    }
}

/// Whether a content row at scene row `row` is visible inside the node's own
/// frame after the region's scroll: its mapped position must land within the
/// frame's vertical extent `[rect.y, rect.bottom())`. Rows that pan above or
/// below the frame are skipped (the frame's background/border are painted by
/// the box itself, through a scroll-free region).
fn row_inside_frame(rect: Rect, region: Region, row: i32) -> bool {
    let mapped = region.map_y(row);
    mapped >= rect.y && mapped < rect.bottom()
}

/// The display width of a string in terminal cells: the sum of its grapheme
/// clusters' widths (multi-width aware, cluster-indivisible). ANSI/OSC/CSI
/// escape sequences are stripped first ([`strip_escapes`]), so they occupy
/// no columns — measurement and the paint pass agree by construction.
fn display_width(content: &str) -> u32 {
    clusters(&strip_escapes(content)).map(|c| c.width as u32).sum()
}

/// The wrapped content size of `content` laid out at `width` cells: the
/// display width of the widest wrapped line and the wrapped line count.
///
/// Wrapping mirrors the streaming-text paint pass (`paint_word`): a token (a
/// whitespace-free run) that does not fit on the current row wraps whole to
/// the next row when it fits a fresh row; a token wider than the whole row is
/// hard-broken across rows; a `\n` forces a break; a trailing space at a row's
/// end is dropped. The reported width can therefore be narrower than the
/// content's total display width (wrapped rows), and an empty content reports
/// `(0, 0)` — no content, no size. Breaking is grapheme-cluster aware: a
/// cluster never splits across rows.
fn measure_wrapped(content: &str, width: u32) -> (u32, u32) {
    if content.is_empty() {
        // An empty text leaf still occupies ONE row — the layout counterpart
        // of a blank terminal line (and the reason an empty `<Text>` spacer
        // keeps its row instead of collapsing the column layout).
        return (0, 1);
    }
    let width = width.max(1);
    let mut lines: u32 = 1;
    let mut max_col: u32 = 0;
    let mut col: u32 = 0;
    let mut word = String::new();
    let content = strip_escapes(content);
    for cluster in clusters(&content) {
        match cluster.text {
            "\n" | "\r\n" => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                lines += 1;
                col = 0;
            }
            " " => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                // A trailing space at a row's end is dropped (the wrap would
                // collapse it anyway), mirroring paint_streaming_text.
                if col < width {
                    col += 1;
                    max_col = max_col.max(col);
                }
            }
            _ => word.push_str(cluster.text),
        }
    }
    flush_word(&word, width, &mut col, &mut lines, &mut max_col);
    (max_col, lines)
}

/// Place one pending token onto the wrapped measurement, applying the same
/// wrap rule as [`paint_word`]: whole-token wrap when it does not fit the
/// current row but fits a fresh one, hard cluster-by-cluster break when the
/// token is wider than the whole row.
fn flush_word(word: &str, width: u32, col: &mut u32, lines: &mut u32, max_col: &mut u32) {
    if word.is_empty() {
        return;
    }
    let tw = display_width(word);
    if tw <= width {
        if *col > 0 && *col + tw > width {
            *lines += 1;
            *col = 0;
        }
        *col += tw;
        *max_col = (*max_col).max(*col);
        return;
    }
    for cluster in clusters(&strip_escapes(word)) {
        let w = cluster.width as u32;
        if w == 0 {
            continue;
        }
        if *col + w > width {
            *lines += 1;
            *col = 0;
        }
        *col += w;
        *max_col = (*max_col).max(*col);
    }
}

/// Paint one whitespace-free token with `style` at the cursor, soft-wrapping
/// at `right` (column, exclusive) and clipping below `bottom` (row,
/// exclusive), through `region`.
///
/// A token that does not fit on the current row (which already holds content)
/// moves whole to the next row; a token wider than the whole row is
/// hard-broken across rows. Text advances grapheme cluster by cluster: a
/// cluster that would straddle `right` — or that is wider than the row itself
/// — wraps whole to the next row, or is dropped whole when it cannot fit a
/// fresh row either; a cluster is never split mid-cluster (a ZWJ emoji stays
/// a single 2-column glyph). The cursor advances past every token glyph,
/// including dropped ones. Each glyph is drawn via
/// [`Buffer::set_cluster_region`], so it is also shifted by the region's
/// scroll and clipped to its clip rect.
///
/// `frame_check` gates the [`row_inside_frame`] test: a streaming leaf's
/// content rows pan inside its own frame, so its rows are skipped when their
/// mapped position falls outside the frame (scrolled content stays inside the
/// pane). A text leaf paints its wrapped rows at its own rect rows (bounded
/// by `bottom` and the region clip, exactly like the single-row painter), so
/// its rows never frame-check.
fn paint_word(
    word: &str,
    style: Style,
    frame: Rect,
    cursor: &mut WrapCursor,
    region: Region,
    buffer: &mut Buffer,
    frame_check: bool,
) {
    let line_start = frame.x;
    if word.is_empty() {
        return;
    }
    // Paint bounds derived from frame + region exactly as the caller does:
    // right clips at the region's right edge (plus horizontal scroll), and
    // the content pan bound runs to the frame's bottom plus vertical scroll.
    let right = frame.right().min(region.clip.right() + region.scroll_x);
    let bottom = frame.bottom() + region.scroll_y;
    let width: i32 = display_width(word) as i32;
    // Wrap the whole token when it does not fit on the current row and can fit
    // on a fresh row; a token wider than the row itself is hard-broken below.
    if cursor.col > line_start && cursor.col + width > right && width <= right - line_start {
        cursor.row += 1;
        cursor.col = line_start;
        if cursor.row >= bottom {
            return;
        }
    }
    for cluster in clusters(&strip_escapes(word)) {
        let w = cluster.width;
        if w == 0 {
            continue;
        }
        if cursor.col + w as i32 > right {
            // Does not fit on this row: wrap. A wide glyph that still cannot
            // fit on a fresh row (wider than the row) is dropped whole.
            cursor.row += 1;
            cursor.col = line_start;
            if cursor.row >= bottom {
                return;
            }
            if cursor.col + w as i32 > right {
                return;
            }
        }
        if !frame_check || row_inside_frame(frame, region, cursor.row) {
            buffer.set_cluster_region(cursor.col, cursor.row, &cluster, style, region);
        }
        cursor.col += w as i32;
    }
}

/// The concrete glyph set for a border style: top-left, top-right,
/// bottom-left, bottom-right corners, horizontal edge, vertical edge.
///
/// `Rounded` maps to the light box-drawing set `┌┐└┘─│` — the exact glyphs
/// pinned by the tern-components MVP acceptance (golden buffer test).
fn border_glyphs(style: BorderStyle) -> Option<(char, char, char, char, char, char)> {
    match style {
        BorderStyle::None => None,
        BorderStyle::Plain => Some(('+', '+', '+', '+', '-', '|')),
        BorderStyle::Rounded => Some(('┌', '┐', '└', '┘', '─', '│')),
        BorderStyle::Double => Some(('╔', '╗', '╚', '╝', '═', '║')),
        BorderStyle::Thick => Some(('┏', '┓', '┗', '┛', '━', '┃')),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Input;
    use crate::panels::{Panel, Panels};
    use crate::renderable::{Box, Text};
    use crate::spinner::Spinner;
    use crate::statusbar::{Segment, SegmentAlign, StatusBar};
    use tern_core::scene::Span;
    use tern_core::style::{Modifiers, Style};

    /// Paint a renderable tree and return it as a `Vec<String>` grid for
    /// debugging and golden comparisons.
    fn render_rows(root: impl Into<Renderable>, viewport: Size) -> Vec<String> {
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(root, viewport);
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                    .collect()
            })
            .collect()
    }

    /// Reconstruct rows with FULL cluster symbols from a buffer (masked
    /// continuation cells as spaces), mirroring tern-node's `buffer_rows` —
    /// for grapheme-cluster golden comparisons.
    fn buffer_rows_clusters(buffer: &Buffer) -> Vec<String> {
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| {
                        buffer.cell(x, y).map_or_else(
                            || " ".to_string(),
                            |c| {
                                if c.is_masked() {
                                    " ".to_string()
                                } else {
                                    c.symbol_str().into_owned()
                                }
                            },
                        )
                    })
                    .collect()
            })
            .collect()
    }

    /// Paint a raw scene and return it as a `Vec<String>` grid for golden
    /// comparisons.
    fn render_scene_rows(scene: &Scene, viewport: Size) -> Vec<String> {
        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(scene, viewport);
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                    .collect()
            })
            .collect()
    }

    /// The character at (`x`, `y`) in a buffer, or a space outside it.
    fn cell_char(buffer: &Buffer, x: i32, y: i32) -> char {
        if x < 0 || y < 0 || x >= buffer.width as i32 || y >= buffer.height as i32 {
            return ' ';
        }
        buffer.cell(x as u16, y as u16).map(|c| c.ch).unwrap_or(' ')
    }

    /// A scene with a `StreamingText` child sized to `width` x `height` at the
    /// origin of a same-sized viewport.
    fn streaming_scene(width: i64, height: i64) -> Scene {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .expect("add streaming text");
        scene.set_prop(s, "width", PropValue::Int(width));
        scene.set_prop(s, "height", PropValue::Int(height));
        scene
    }

    #[test]
    fn streaming_text_zwj_emoji_at_right_edge_wraps_whole() {
        // A 2-column ZWJ family emoji inside a token that does not fit the
        // 3-cell row: the hard break moves the cluster to the next row WHOLE —
        // the emoji is never split across rows.
        let mut scene = streaming_scene(3, 2);
        let root = scene.root_id();
        let s = scene
            .children(root)
            .and_then(|ids| ids.first().copied())
            .expect("streaming node");
        scene.append_span(
            s,
            Span {
                text: "ab👨‍👩‍👧‍👦c".into(),
                style: Style::new(),
            },
        );
        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(3, 2));
        // Row 0 holds "ab"; the cluster wrapped whole to row 1 (lead at col 0,
        // masked neighbor at col 1) with 'c' after it.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'a');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'b');
        let lead = buffer.cell(0, 1).expect("cluster lead");
        assert_eq!(lead.ch, '👨');
        assert_eq!(lead.symbol.as_deref(), Some("👨‍👩‍👧‍👦"));
        assert_eq!(lead.width, 2);
        assert!(buffer.cell(1, 1).expect("mask").is_masked());
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'c');
        // Full-symbol row reconstruction shows the complete cluster on row 1.
        assert_eq!(buffer_rows_clusters(&buffer), vec!["ab ", "👨‍👩‍👧‍👦 c"]);
    }

    #[test]
    fn text_truncation_drops_cluster_whole() {
        // A 2-cell rect cannot hold the 2-column ZWJ emoji after "ab": the
        // cluster is dropped WHOLE at the right edge — never split into a
        // lone '👨' cell.
        let tree = Text::new("ab👨‍👩‍👧‍👦", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(2, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'a');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'b');
        // No trace of the emoji: neither cell holds a partial glyph.
        assert_eq!(buffer.cell(0, 0).unwrap().symbol, None);
        assert_eq!(buffer.cell(1, 0).unwrap().symbol, None);
    }

    #[test]
    fn text_truncation_drops_oversized_cluster_whole() {
        // A cluster wider than the whole row is dropped whole, not split: a
        // 1-cell rect cannot hold a 2-column emoji, so the cell stays blank —
        // a split would have left '👨' behind.
        let tree = Text::new("👨‍👩‍👧‍👦", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(1, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, ' ');
        assert_eq!(buffer.cell(0, 0).unwrap().symbol, None);
    }

    #[test]
    fn text_combining_sequence_occupies_one_cell() {
        // A base + combining mark is ONE cluster in ONE cell: the lead cell
        // carries the full "e\u{301}" symbol at width 1, and the next glyph
        // lands in the following column — no masked neighbor.
        let tree = Text::new("e\u{301}x", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(3, 1));
        let c0 = buffer.cell(0, 0).unwrap();
        assert_eq!(c0.ch, 'e');
        assert_eq!(c0.symbol.as_deref(), Some("e\u{301}"));
        assert_eq!(c0.width, 1);
        assert!(!c0.is_masked());
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'x');
        assert_eq!(buffer.cell(2, 0).unwrap(), &Cell::default());
    }

    #[test]
    fn golden_rounded_box_padding_hi_in_10x4() {
        // A rounded-border box with 1-cell padding around Text('Hi'), painted
        // into a 10x4 buffer: the box fills the viewport, so the border glyphs
        // (┌┐└┘│─) sit at the edges of the buffer.
        let box_style = Style::new().border_style(BorderStyle::Rounded);
        let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree.clone(), Size::new(10, 4));

        // Expected cell grid:
        //   ┌────────┐
        //   │Hi      │
        //   │        │
        //   └────────┘
        let rows = ["┌────────┐", "│Hi      │", "│        │", "└────────┘"];
        let mut expected = Buffer::new(10, 4);
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                let style = if "┌┐└┘│─".contains(ch) {
                    box_style
                } else {
                    Style::new()
                };
                expected.set_char(x as u16, y as u16, ch, style);
            }
        }

        assert_eq!(buffer, expected);
        assert_eq!(render_rows(tree, Size::new(10, 4)), rows);
    }

    #[test]
    fn golden_rounded_box_border_color_paints_border_cells_in_color() {
        // A rounded-border box with a `border_color`: the border glyphs paint
        // with that color as their foreground while every other cell keeps its
        // own style — and the glyphs themselves are unchanged (the plain rows
        // are identical to the uncolored golden).
        let box_style = Style::new()
            .border_style(BorderStyle::Rounded)
            .border_color(Color::Rgb(255, 0, 0));
        let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree.clone(), Size::new(6, 3));

        // Every border cell carries the border color as its fg.
        for (x, y) in [
            (0, 0),
            (5, 0),
            (2, 0), // top edge
            (0, 1),
            (5, 1), // left/right edges
            (0, 2),
            (5, 2),
            (2, 2), // bottom edge
        ] {
            let cell = buffer.cell(x, y).expect("border cell in bounds");
            assert_eq!(
                cell.style.fg, Color::Rgb(255, 0, 0),
                "border cell ({x},{y}) must carry the border color"
            );
        }
        // Interior and content cells are untouched by the border color.
        assert_eq!(buffer.cell(1, 1).unwrap().style.fg, Color::Default);
        assert_eq!(buffer.cell(2, 1).unwrap().style.fg, Color::Default);
        // The glyph grid is byte-identical to an uncolored border: a root
        // box stretches to the viewport, so the ring fills the 6x3 buffer
        // (matching the `golden_rounded_box_padding_hi_in_10x4` geometry).
        assert_eq!(
            render_rows(tree, Size::new(6, 3)),
            vec!["┌────┐", "│Hi  │", "└────┘"]
        );
    }

    #[test]
    fn text_paints_content_clipped_to_rect() {
        // A bare text root paints its content from the top-left, clipped to
        // the buffer.
        let tree = Text::new("Hello", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(3, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'H');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'e');
        assert_eq!(buffer.cell(2, 0).unwrap().ch, 'l');
    }

    #[test]
    fn text_wider_than_content_area_overflows() {
        // A 5x3 box with 1-cell padding has a 3-wide content area, but taffy
        // cannot shrink a text leaf below its min-content width, so 'Hello'
        // overflows the box's right edge (no child clipping in the MVP) and
        // is painted up to the buffer edge.
        let tree = Box::new(Style::new(), vec![Text::new("Hello", Style::new()).into()])
            .width(5)
            .height(3)
            .padding(1);

        let rows = render_rows(tree, Size::new(10, 4));
        assert_eq!(rows[0], "          "); // padding row, blank
        assert_eq!(rows[1], " Hello    "); // content row, 'Hello' overflows to col 5
        assert_eq!(rows[2], "          "); // bottom padding row, blank
        assert_eq!(rows[3], "          "); // outside the box rect
    }

    #[test]
    fn box_background_fills_its_rect() {
        let tree = Box::new(Style::new().bg(Color::Indexed(1)), vec![])
            .width(3)
            .height(2);

        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(5, 3));
        for y in 0..2 {
            for x in 0..3 {
                let c = buffer.cell(x, y).unwrap();
                assert_eq!(c.ch, ' ');
                assert_eq!(c.style.bg, Color::Indexed(1));
            }
        }
        // Cells outside the box stay blank (default bg).
        assert_eq!(buffer.cell(3, 0).unwrap().style.bg, Color::Default);
        assert_eq!(buffer.cell(0, 2).unwrap().style.bg, Color::Default);
    }

    #[test]
    fn box_without_border_style_paints_no_border() {
        let tree = Box::new(
            Style::new().border_style(BorderStyle::None),
            vec![Text::new("Hi", Style::new()).into()],
        );

        let rows = render_rows(tree, Size::new(4, 1));
        // No border glyphs: just the text at the origin.
        assert_eq!(rows, vec!["Hi  "]);
    }

    #[test]
    fn paint_scene_handles_a_raw_scene() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Plain),
            )
            .unwrap();
        scene.set_prop(b, "padding", PropValue::Int(1));
        scene.add_text(b, "ok", Style::new()).unwrap();

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(6, 3));
        // A non-root box sizes to its content: 4x3 (2 + 2 padding), at the
        // origin of the 6x3 viewport.
        //   +--+
        //   |ok|
        //   +--+
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '+');
        assert_eq!(buffer.cell(3, 0).unwrap().ch, '+'); // box top-right corner
        assert_eq!(buffer.cell(0, 1).unwrap().ch, '|');
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'o');
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'k');
        assert_eq!(buffer.cell(3, 2).unwrap().ch, '+'); // box bottom-right corner
        assert_eq!(buffer.cell(5, 0).unwrap().ch, ' '); // outside the box
    }

    #[test]
    fn single_row_text_ellipsis_trims_at_parent_content_box() {
        // The status-bar scenario: a `wrap: false` text whose intrinsic
        // width overflows its parent box (it is never flex-shrunk). The
        // paint must clip at the tightest ancestor padding-box edge — the
        // frame's border ring stays visible and the `…` lands on the LAST
        // content cell, not over the border glyph.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let frame = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Rounded),
            )
            .unwrap();
        scene.set_prop(frame, "padding", PropValue::Int(1));
        scene.set_prop(frame, "flex_direction", PropValue::Str("column".into()));
        scene.set_prop(frame, "width", PropValue::Str("100%".into()));
        scene.set_prop(frame, "height", PropValue::Int(4));
        let sb = scene.add_child(frame, NodeKind::Box, Style::new()).unwrap();
        let text = scene.add_child(sb, NodeKind::Text, Style::new()).unwrap();
        scene.set_prop(text, "text", PropValue::Str("x".repeat(80)));
        scene.set_prop(text, "wrap", PropValue::Bool(false));
        scene.set_prop(text, "ellipsis", PropValue::Bool(true));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(30, 4));
        // Frame spans the full 30-column viewport; its content box is
        // columns 1..=28 (border + padding), so the single-row text paints
        // x's at 1..=27 with the ellipsis at 28 and the border at 29.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '┌');
        assert_eq!(buffer.cell(29, 0).unwrap().ch, '┐');
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'x');
        assert_eq!(buffer.cell(27, 1).unwrap().ch, 'x');
        assert_eq!(buffer.cell(28, 1).unwrap().ch, '…');
        assert_eq!(buffer.cell(29, 1).unwrap().ch, '│'); // border survives
        assert_eq!(buffer.cell(29, 3).unwrap().ch, '┘');
    }

    #[test]
    fn single_row_text_ellipsis_only_when_truncated() {
        // Content that fits paints unchanged: no ellipsis stamped.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let text = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
        scene.set_prop(text, "text", PropValue::Str("short".into()));
        scene.set_prop(text, "wrap", PropValue::Bool(false));
        scene.set_prop(text, "ellipsis", PropValue::Bool(true));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(10, 2));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 's');
        assert_eq!(buffer.cell(4, 0).unwrap().ch, 't');
        assert_eq!(buffer.cell(5, 0).unwrap().ch, ' '); // nothing past the text
    }

    #[test]
    fn single_row_text_clips_without_ellipsis_flag() {
        // `wrap: false` alone trims at the parent box edge with a hard cut —
        // no ellipsis glyph without the flag.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_ = scene
            .add_child(root, NodeKind::Box, Style::new().border_style(BorderStyle::Plain))
            .unwrap();
        scene.set_prop(box_, "width", PropValue::Int(6));
        scene.set_prop(box_, "padding", PropValue::Int(1));
        let text = scene.add_child(box_, NodeKind::Text, Style::new()).unwrap();
        scene.set_prop(text, "text", PropValue::Str("abcdefgh".into()));
        scene.set_prop(text, "wrap", PropValue::Bool(false));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(12, 4));
        // Box spans 0..=5 with a plain border + 1 padding: the content box is
        // columns 1..=4. The intrinsic-width text (8 cells) is clipped at the
        // box's padding-box edge — 'a'..='d' paint, the border survives.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '+');
        assert_eq!(buffer.cell(5, 0).unwrap().ch, '+');
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
        assert_eq!(buffer.cell(4, 1).unwrap().ch, 'd');
        assert_eq!(buffer.cell(5, 1).unwrap().ch, '|'); // border survives
        assert_eq!(buffer.cell(6, 1).unwrap().ch, ' '); // nothing past the box
    }

    #[test]
    fn border_glyph_sets_match_style() {
        assert_eq!(
            border_glyphs(BorderStyle::Rounded),
            Some(('┌', '┐', '└', '┘', '─', '│'))
        );
        assert_eq!(border_glyphs(BorderStyle::None), None);
    }

    #[test]
    fn input_caret_paints_reversed_block_over_caret_cell() {
        // A root Input fills the viewport with its 1-cell padding frame; the
        // text leaf lands at (1,1), and the caret prop (display col 2) paints
        // the reversed block caret over the blank cell at (3,1).
        let input = Input::with_value("ab");
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(input, Size::new(6, 3));

        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'b');
        let caret = buffer.cell(3, 1).unwrap();
        assert_eq!(caret.ch, ' ');
        assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
        // Neighbors are untouched.
        assert!(!buffer
            .cell(2, 1)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
        assert!(!buffer
            .cell(4, 1)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
    }

    #[test]
    fn input_placeholder_paints_dimmed_with_caret_at_head() {
        // An empty input shows the dimmed placeholder; the caret sits at
        // display col 0, adding REVERSED over the placeholder's DIM.
        let input = Input::new().placeholder("ask");
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(input, Size::new(6, 3));

        let c = buffer.cell(1, 1).unwrap();
        assert_eq!(c.ch, 'a');
        assert!(c.style.modifiers.contains(Modifiers::DIM));
        assert!(c.style.modifiers.contains(Modifiers::REVERSED));
        // The rest of the placeholder stays dimmed but not reversed.
        let second = buffer.cell(2, 1).unwrap();
        assert_eq!(second.ch, 's');
        assert!(second.style.modifiers.contains(Modifiers::DIM));
        assert!(!second.style.modifiers.contains(Modifiers::REVERSED));
    }

    #[test]
    fn input_hidden_caret_paints_no_block() {
        let input = Input::with_value("ab").hide_caret();
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(input, Size::new(6, 3));
        for x in 0..6 {
            let c = buffer.cell(x, 1).unwrap();
            assert!(!c.style.modifiers.contains(Modifiers::REVERSED));
        }
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
    }

    /// A raw scene with a single `Text` leaf sized to `width` x `height` at
    /// the origin (a root text fills the viewport's first row).
    fn selection_text_scene(text: &str, width: i64, height: i64) -> Scene {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str(text.into()));
        scene.set_prop(t, "width", PropValue::Int(width));
        scene.set_prop(t, "height", PropValue::Int(height));
        scene
    }

    #[test]
    fn selection_overlay_reverses_selected_cells_and_preserves_content() {
        // A selection spanning cols 1-3 of the text row: those cells gain
        // REVERSED on top of their own style; the character content and the
        // cells outside the selection are untouched.
        let scene = selection_text_scene("hello", 5, 1);
        let mut compositor = Compositor::new();
        compositor.set_selection((1, 0), (3, 0));
        let buffer = compositor.paint_scene(&scene, Size::new(5, 1));

        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'h');
        assert!(!buffer
            .cell(0, 0)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
        for x in 1..=3 {
            let c = buffer.cell(x, 0).unwrap();
            assert_eq!(c.ch, "hello".chars().nth(x as usize).unwrap());
            assert!(
                c.style.modifiers.contains(Modifiers::REVERSED),
                "cell {x} must be reversed"
            );
        }
        assert!(!buffer
            .cell(4, 0)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
    }

    #[test]
    fn selection_overlay_endpoints_are_normalized() {
        // The active endpoint may sit above/left of the anchor: the spanned
        // rectangle is the same either way.
        let scene = selection_text_scene("hello", 5, 1);
        let mut a = Compositor::new();
        a.set_selection((3, 0), (1, 0));
        let buf_a = a.paint_scene(&scene, Size::new(5, 1));
        let mut b = Compositor::new();
        b.set_selection((1, 0), (3, 0));
        let buf_b = b.paint_scene(&scene, Size::new(5, 1));
        assert_eq!(buf_a, buf_b);
        for x in 1..=3 {
            assert!(buf_a.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        }
    }

    #[test]
    fn selection_overlay_is_a_noop_when_unset() {
        // The default compositor (no selection) must produce a frame without
        // any reversed cells — the overlay is a strict no-op when unset.
        let scene = selection_text_scene("hello", 5, 1);
        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(5, 1));
        for x in 0..5 {
            assert!(
                !buffer.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED),
                "cell {x} must not be reversed without a selection"
            );
        }
    }

    #[test]
    fn selection_overlay_skips_masked_continuation_cells() {
        // A wide char inside the selection: its lead cell is reversed (the
        // glyph is covered), its masked continuation cell is left untouched —
        // never a reversed NUL that would corrupt the glyph's neighbor.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("コab".into()));
        scene.set_prop(t, "width", PropValue::Int(4));
        scene.set_prop(t, "height", PropValue::Int(1));

        let mut compositor = Compositor::new();
        compositor.set_selection((0, 0), (3, 0)); // the whole row
        let buffer = compositor.paint_scene(&scene, Size::new(4, 1));
        // コ at cols 0-1 (lead + mask), 'a' at 2, 'b' at 3.
        let lead = buffer.cell(0, 0).unwrap();
        assert_eq!(lead.ch, 'コ');
        assert!(lead.style.modifiers.contains(Modifiers::REVERSED));
        let mask = buffer.cell(1, 0).unwrap();
        assert!(mask.is_masked());
        assert!(!mask.style.modifiers.contains(Modifiers::REVERSED));
        assert!(buffer.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        assert!(buffer.cell(3, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    }

    #[test]
    fn selection_overlay_change_and_clear_leave_no_stale_reversal() {
        // Moving or clearing the selection must never leave REVERSED on cells
        // that are no longer selected: a selection change forces a full
        // repaint, so the frame is rebuilt fresh before the overlay applies.
        let scene = selection_text_scene("hello", 5, 1);
        let mut compositor = Compositor::new();
        compositor.set_selection((1, 0), (3, 0));
        let first = compositor.paint_scene(&scene, Size::new(5, 1));
        assert!(first.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

        // Shrink the selection: the old cell 3 must lose REVERSED.
        compositor.set_selection((1, 0), (2, 0));
        let shrunk = compositor.paint_scene(&scene, Size::new(5, 1));
        assert!(shrunk.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        assert!(shrunk.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        assert!(!shrunk.cell(3, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

        // Clear it: no reversed cells remain.
        compositor.clear_selection();
        let cleared = compositor.paint_scene(&scene, Size::new(5, 1));
        for x in 0..5 {
            assert!(!cleared.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        }
    }

    #[test]
    fn selection_overlay_applied_identically_on_warm_and_fresh_paths() {
        // The mandatory dirty-parity property with a selection SET: a warm
        // compositor (dirty repaints + retained frames) with a selection must
        // produce cell-for-cell identical frames to a fresh compositor (full
        // recompute) with the same selection, across mutations. This pins
        // that the overlay is applied identically on warm and fresh paths.
        let scene = selection_text_scene("hello", 5, 1);
        let mut warm = Compositor::new();
        warm.set_selection((1, 0), (3, 0));
        let mut fresh = Compositor::new();
        fresh.set_selection((1, 0), (3, 0));

        // Frame 0 (cold full paint on both).
        let warm0 = warm.paint_scene(&scene, Size::new(5, 1));
        let fresh0 = fresh.paint_scene(&scene, Size::new(5, 1));
        assert_eq!(warm0, fresh0);

        // Mutate the scene (dirty path on the warm compositor), repaint.
        let mut scene = scene;
        let root = scene.root_id();
        scene.set_prop(root, "padding", PropValue::Int(0));
        // (re-fetch the text id — it is the root's only child)
        let t = scene.children(root).unwrap()[0];
        scene.set_prop(t, "text", PropValue::Str("world".into()));
        let warm1 = warm.paint_scene(&scene, Size::new(5, 1));
        let fresh1 = {
            let mut f = Compositor::new();
            f.set_selection((1, 0), (3, 0));
            f.paint_scene(&scene, Size::new(5, 1))
        };
        assert_eq!(warm1, fresh1);
        assert!(warm1.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

        // The dirty buffer's diff vs the previous frame matches the fresh
        // path's diff (the renderer's terminal output is identical).
        assert_eq!(warm1.diff_from(&warm0), fresh1.diff_from(&fresh0));
    }

    #[test]
    fn selection_overlay_unchanged_selection_keeps_dirty_path() {
        // With a fixed selection, a localized scene mutation takes the dirty
        // path (not a forced full repaint): the overlay is re-applied on top
        // of the dirty result and parity holds. The retained buffer must keep
        // its reversed cells across the dirty pass.
        let scene = selection_text_scene("hello", 5, 1);
        let mut compositor = Compositor::new();
        compositor.set_selection((1, 0), (3, 0));
        compositor.paint_scene(&scene, Size::new(5, 1));

        let mut scene = scene;
        let root = scene.root_id();
        let t = scene.children(root).unwrap()[0];
        scene.set_prop(t, "text", PropValue::Str("hexxo".into()));
        let buffer = compositor.paint_scene(&scene, Size::new(5, 1));
        // The dirty pass repainted the text cell; the overlay still applies.
        assert_eq!(buffer.cell(2, 0).unwrap().ch, 'x');
        assert!(buffer.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        // And it matches a fresh full recompute with the same selection.
        let mut fresh = Compositor::new();
        fresh.set_selection((1, 0), (3, 0));
        let full = fresh.paint_scene(&scene, Size::new(5, 1));
        assert_eq!(buffer, full);
    }

    #[test]
    fn spinner_bar_paints_filled_and_empty_cells() {
        // A determinate spinner painted as the root: 4-wide bar, 1 of 4 done
        // -> '▓' + 3 '░' + " 25%".
        let mut spinner = Spinner::determinate(4).bar_width(4);
        spinner.set_progress(1);
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(spinner, Size::new(8, 1));
        let row: String = (0..8).map(|x| buffer.cell(x, 0).unwrap().ch).collect();
        assert_eq!(row, "▓░░░ 25%");
    }

    #[test]
    fn spinner_indeterminate_paints_current_frame() {
        let spinner = Spinner::with_frames(&["⠋", "⠙"]);
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(spinner, Size::new(4, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '⠋');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, ' ');
    }

    #[test]
    fn status_bar_narrow_viewport_drops_low_priority_segments() {
        // Row width 12; total content 13 > 12, so the lowest-priority segment
        // ("ab") is dropped. The survivors lay out with space-between: the
        // left group "cde" (cols 0-2), the right group "fg hijk" pushed to
        // the right edge (f at col 5, h at col 8 — the free cell plus the
        // strip gap sit between the groups).
        let bar = StatusBar::new(Style::new())
            .segment(Segment::new("ab", Style::new()).priority(0))
            .segment(Segment::new("cde", Style::new()).priority(1))
            .segment(
                Segment::new("fg", Style::new())
                    .align(SegmentAlign::Right)
                    .priority(2),
            )
            .segment(
                Segment::new("hijk", Style::new())
                    .align(SegmentAlign::Right)
                    .priority(3),
            );
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(bar, Size::new(12, 1));
        let row: String = (0..12).map(|x| buffer.cell(x, 0).unwrap().ch).collect();

        assert!(row.starts_with("cde"), "row = {row:?}");
        assert_eq!(row.chars().nth(5), Some('f'));
        assert_eq!(row.chars().nth(8), Some('h'));
        assert!(!row.contains('a'), "dropped segment still painted: {row:?}");
    }

    #[test]
    fn status_bar_pins_left_and_right_segments_to_the_edges() {
        let bar = StatusBar::new(Style::new())
            .left("L", Style::new())
            .right("R", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(bar, Size::new(20, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'L');
        assert_eq!(buffer.cell(19, 0).unwrap().ch, 'R');
    }

    #[test]
    fn status_bar_root_pins_to_the_bottom_row() {
        // A root StatusBar is a single-row strip, not a viewport-filling box:
        // it pins to the bottom row of a 20x3 viewport, leaving rows 0-1
        // empty (docs/components.md "StatusBar — Reserved row").
        let bar = StatusBar::new(Style::new())
            .left("L", Style::new())
            .right("R", Style::new());
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(bar, Size::new(20, 3));
        assert_eq!(buffer.cell(0, 2).unwrap().ch, 'L');
        assert_eq!(buffer.cell(19, 2).unwrap().ch, 'R');
        for y in 0..2 {
            for x in 0..20 {
                assert_eq!(
                    buffer.cell(x, y).unwrap(),
                    &Cell::default(),
                    "({x},{y}) not empty"
                );
            }
        }
    }

    #[test]
    fn golden_panels_and_status_bar_reserve_bottom_row() {
        // A column app layout of an expanded Panels strip plus a StatusBar,
        // painted into a 20x8 viewport: the compositor subtracts the bottom
        // row from the layout viewport, so the panels lay out entirely above
        // it and the strip — which flex would have placed at row 5 — pins to
        // the last row (row 7). The last row belongs to the status bar; no
        // panel content and no segment leak across the boundary.
        let tree = Box::new(
            Style::new(),
            vec![
                Panels::new(vec![
                    Panel::new("one", Text::new("body-a", Style::new())),
                    Panel::new("two", Text::new("body-b", Style::new())),
                ])
                .into(),
                StatusBar::new(Style::new())
                    .left("L", Style::new())
                    .right("R", Style::new())
                    .into(),
            ],
        )
        .column();

        let mut compositor = Compositor::new();
        let buffer = compositor.paint(tree, Size::new(20, 8));
        let rows: Vec<String> = (0..8)
            .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
            .collect();

        // Panels fill the rows above the reserved one: header + body per
        // panel, with the 1-cell inter-panel gap.
        assert!(rows[0].starts_with("▾ one"), "row0 = {:?}", rows[0]);
        assert!(rows[1].starts_with("body-a"), "row1 = {:?}", rows[1]);
        assert!(rows[2].trim().is_empty(), "row2 = {:?}", rows[2]);
        assert!(rows[3].starts_with("▾ two"), "row3 = {:?}", rows[3]);
        assert!(rows[4].starts_with("body-b"), "row4 = {:?}", rows[4]);
        // The in-flow slot the strip would have occupied (row 5) is vacated
        // and stays empty: the strip pinned to the reserved last row.
        assert!(rows[5].trim().is_empty(), "row5 = {:?}", rows[5]);
        assert!(rows[6].trim().is_empty(), "row6 = {:?}", rows[6]);
        // The reserved row belongs to the status bar: its left/right segments
        // pin to the strip's edges.
        assert_eq!(rows[7].chars().next(), Some('L'), "row7 = {:?}", rows[7]);
        assert_eq!(rows[7].chars().nth(19), Some('R'), "row7 = {:?}", rows[7]);
        // No segment leaked above the reserved row, and no panel content
        // leaked onto it.
        assert!(
            !rows[..7].iter().any(|r| r.contains('L') || r.contains('R')),
            "segments leaked above the reserved row"
        );
        assert!(
            !rows[7].contains('▾') && !rows[7].contains("body"),
            "row7 = {:?}",
            rows[7]
        );
    }

    #[test]
    fn panels_collapsed_hides_body_in_painted_buffer() {
        let panels = Panels::new(vec![
            Panel::new("one", Text::new("body-a", Style::new())).collapsed(),
            Panel::new("two", Text::new("body-b", Style::new())),
        ]);
        let mut compositor = Compositor::new();
        let buffer = compositor.paint(panels, Size::new(20, 5));
        let rows: Vec<String> = (0..5)
            .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
            .collect();

        // Row 0: the collapsed panel's header (toggle + title), body omitted.
        assert!(rows[0].starts_with("▸ one"), "row0 = {:?}", rows[0]);
        // Row 1: the inter-panel gap.
        assert!(rows[1].trim().is_empty());
        // Rows 2-3: the expanded panel's header then its body.
        assert!(rows[2].starts_with("▾ two"), "row2 = {:?}", rows[2]);
        assert!(rows[3].starts_with("body-b"), "row3 = {:?}", rows[3]);
        // The collapsed panel's body never painted.
        assert!(!rows.iter().any(|r| r.contains("body-a")));
    }

    #[test]
    fn golden_streaming_text_spans_styles_in_12x3() {
        // A 12x3 StreamingText rect holding spans 'abc' (fg red) + 'def'
        // (bold): the concatenated content paints on the first row, each span
        // keeping its own style; rows 1-2 stay blank (the node is one content
        // line tall inside its 3-row rect).
        let mut scene = streaming_scene(12, 3);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        let red = Style::new().fg(Color::Rgb(255, 0, 0));
        let bold = Style::new().add_modifier(Modifiers::BOLD);
        assert!(scene.append_span(
            s,
            Span {
                text: "abc".to_string(),
                style: red,
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "def".to_string(),
                style: bold,
            }
        ));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(12, 3));

        // Expected cell grid:
        //   abcdef
        //   (blank row)
        //   (blank row)
        let mut expected = Buffer::new(12, 3);
        for (x, ch) in "abc".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, red);
        }
        for (x, ch) in "def".chars().enumerate() {
            expected.set_char(x as u16 + 3, 0, ch, bold);
        }

        assert_eq!(buffer, expected);
        let rows = render_scene_rows(&scene, Size::new(12, 3));
        assert_eq!(rows, ["abcdef      ", "            ", "            "]);
    }

    #[test]
    fn streaming_text_wraps_long_span_onto_two_lines() {
        // A 4x2 rect holding the single span 'abcdef': the token is wider than
        // the rect, so it hard-wraps onto two rows: 'abcd' then 'ef'.
        let mut scene = streaming_scene(4, 2);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        assert!(scene.append_span(
            s,
            Span {
                text: "abcdef".to_string(),
                style: Style::new(),
            }
        ));

        let rows = render_scene_rows(&scene, Size::new(4, 2));
        assert_eq!(rows, ["abcd", "ef  "]);
    }

    #[test]
    fn streaming_text_drops_wide_char_at_rect_edge() {
        // A wide char (コ) that would straddle the right edge of the 3-wide
        // rect is dropped whole — never truncated mid-glyph. It rides in the
        // same token as 'ab', so no wrap separates it: it simply does not fit.
        let mut scene = streaming_scene(3, 1);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        assert!(scene.append_span(
            s,
            Span {
                text: "abコ".to_string(),
                style: Style::new(),
            }
        ));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(3, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'a');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'b');
        // Column 2 stays blank: コ was dropped, not truncated to a half-glyph
        // (no masked continuation cell either).
        assert_eq!(buffer.cell(2, 0).unwrap(), &Cell::default());
        assert_eq!(render_scene_rows(&scene, Size::new(3, 1)), ["ab "]);

        // A wide char wider than the whole rect is dropped as well.
        let mut scene2 = streaming_scene(1, 1);
        let root2 = scene2.root_id();
        let s2 = scene2.children(root2).unwrap()[0];
        assert!(scene2.append_span(
            s2,
            Span {
                text: "コ".to_string(),
                style: Style::new(),
            }
        ));
        let mut compositor = Compositor::new();
        let buffer2 = compositor.paint_scene(&scene2, Size::new(1, 1));
        assert_eq!(buffer2.cell(0, 0).unwrap(), &Cell::default());
    }

    #[test]
    fn golden_streaming_text_wrap_true_wraps_at_word_boundaries() {
        // An explicit `wrap: true` on a 4x2 StreamingText rect holding the
        // span 'ab cd': the token 'cd' does not fit on the row after 'ab '
        // (col 3 + 2 > 4), so it wraps whole to row 1 — the current
        // word-boundary soft-wrap.
        let mut scene = streaming_scene(4, 2);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        scene.set_prop(s, "wrap", PropValue::Bool(true));
        assert!(scene.append_span(
            s,
            Span {
                text: "ab cd".to_string(),
                style: Style::new(),
            }
        ));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 2));

        // Expected cell grid:
        //   ab
        //   cd
        let mut expected = Buffer::new(4, 2);
        for (x, ch) in "ab ".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }
        for (x, ch) in "cd".chars().enumerate() {
            expected.set_char(x as u16, 1, ch, Style::new());
        }

        assert_eq!(buffer, expected);
        let rows = render_scene_rows(&scene, Size::new(4, 2));
        assert_eq!(rows, ["ab  ", "cd  "]);
    }

    #[test]
    fn golden_streaming_text_wrap_false_paints_single_row_trimmed() {
        // `wrap: false` on a 4x2 StreamingText rect holding 'abcdefgh': the
        // whole stream paints as ONE single-row line, trimmed at the right
        // edge ('abcd'), and the second row stays blank — no wrapping.
        let mut scene = streaming_scene(4, 2);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        scene.set_prop(s, "wrap", PropValue::Bool(false));
        assert!(scene.append_span(
            s,
            Span {
                text: "abcdefgh".to_string(),
                style: Style::new(),
            }
        ));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 2));

        // Expected cell grid:
        //   abcd
        //   (blank row)
        let mut expected = Buffer::new(4, 2);
        for (x, ch) in "abcd".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }

        assert_eq!(buffer, expected);
        let rows = render_scene_rows(&scene, Size::new(4, 2));
        assert_eq!(rows, ["abcd", "    "]);
    }

    #[test]
    fn golden_streaming_text_wrap_false_drops_wide_char_at_right_edge() {
        // `wrap: false` with a wide char (コ) that would straddle the right
        // edge of the 3-wide rect: the glyph is dropped whole, never truncated
        // mid-glyph — column 2 stays blank (no masked continuation cell).
        let mut scene = streaming_scene(3, 1);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        scene.set_prop(s, "wrap", PropValue::Bool(false));
        assert!(scene.append_span(
            s,
            Span {
                text: "abコ".to_string(),
                style: Style::new(),
            }
        ));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(3, 1));

        // Expected cell grid:
        //   ab
        let mut expected = Buffer::new(3, 1);
        for (x, ch) in "ab".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }

        assert_eq!(buffer, expected);
        assert_eq!(buffer.cell(2, 0).unwrap(), &Cell::default());
        assert_eq!(render_scene_rows(&scene, Size::new(3, 1)), ["ab "]);
    }

    #[test]
    fn golden_text_wrap_false_trims_at_right_edge() {
        // A bare Text node with `wrap: false` paints its content as a single
        // row trimmed at the rect right edge (Text leaves are inherently
        // single-row, so wrap:false matches their natural painting).
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("abcdef".to_string()));
        scene.set_prop(t, "wrap", PropValue::Bool(false));
        scene.set_prop(t, "width", PropValue::Int(4));
        scene.set_prop(t, "height", PropValue::Int(1));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 1));

        // Expected cell grid:
        //   abcd
        let mut expected = Buffer::new(4, 1);
        for (x, ch) in "abcd".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }

        assert_eq!(buffer, expected);
    }

    #[test]
    fn text_newlines_paint_every_row() {
        // A wrap-enabled Text leaf holding 'ab\ncd': the hard `\n` forces a
        // row break, so the leaf paints BOTH rows (and the layout engine sizes
        // the leaf to 2 rows at its 4-cell width — height comes from the
        // wrapped line count, not a hardcoded 1).
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("ab\ncd".to_string()));
        scene.set_prop(t, "width", PropValue::Int(4));

        let rows = render_scene_rows(&scene, Size::new(4, 2));
        assert_eq!(rows, ["ab  ", "cd  "]);
    }

    #[test]
    fn text_soft_wraps_continuation_rows() {
        // A wrap-enabled Text leaf 'abcdef' at a 4-cell width: the token is
        // wider than the row, so it hard-wraps onto continuation rows — the
        // same token-aware model `StreamingText` uses. The layout engine sizes
        // the leaf to 4x2, and paint fills both rows.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("abcdef".to_string()));
        scene.set_prop(t, "width", PropValue::Int(4));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 2));

        let mut expected = Buffer::new(4, 2);
        for (x, ch) in "abcd".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }
        for (x, ch) in "ef".chars().enumerate() {
            expected.set_char(x as u16, 1, ch, Style::new());
        }
        assert_eq!(buffer, expected);
        assert_eq!(render_scene_rows(&scene, Size::new(4, 2)), ["abcd", "ef  "]);
    }

    #[test]
    fn text_wrap_false_trims_to_a_single_row() {
        // `wrap: false` paints the content as ONE row even when it overflows
        // the rect: 'abcdef' at a 4-cell width shows 'abcd' on row 0 and the
        // second row stays blank — no continuation rows, unlike the wrap-
        // enabled leaf above.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("abcdef".to_string()));
        scene.set_prop(t, "wrap", PropValue::Bool(false));
        scene.set_prop(t, "width", PropValue::Int(4));

        let rows = render_scene_rows(&scene, Size::new(4, 2));
        assert_eq!(rows, ["abcd", "    "]);
    }

    #[test]
    fn text_wrap_keeps_wide_glyphs_whole_per_row() {
        // Per-row wide-glyph clipping: 'abコc' at a 3-cell width hard-wraps
        // cluster by cluster — 'ab' on row 0, then the 2-column コ wraps whole
        // to row 1 (lead + masked continuation) followed by 'c'. A cluster is
        // never split across rows; the continuation cell is masked.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        scene.set_prop(t, "text", PropValue::Str("abコc".to_string()));
        scene.set_prop(t, "width", PropValue::Int(3));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(3, 2));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'a');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'b');
        let lead = buffer.cell(0, 1).expect("cluster lead");
        assert_eq!(lead.ch, 'コ');
        assert_eq!(lead.width, 2);
        assert!(buffer.cell(1, 1).expect("mask").is_masked());
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'c');
        assert_eq!(buffer_rows_clusters(&buffer), vec!["ab ", "コ c"]);

        // A wide glyph that cannot fit a fresh row is dropped whole: 'abコ' at
        // a 1-row, 3-cell rect wraps the コ to row 1, which is past the
        // bottom — so it is dropped, never truncated mid-glyph.
        let mut scene2 = Scene::new();
        let root2 = scene2.root_id();
        let t2 = scene2
            .add_child(root2, NodeKind::Text, Style::new())
            .expect("add text");
        scene2.set_prop(t2, "text", PropValue::Str("abコ".to_string()));
        scene2.set_prop(t2, "width", PropValue::Int(3));
        scene2.set_prop(t2, "height", PropValue::Int(1));
        let rows2 = render_scene_rows(&scene2, Size::new(3, 1));
        assert_eq!(rows2, ["ab "]);
    }

    /// A scene with an in-flow `5x5` bg box at the origin and an absolute
    /// overlay box (with `top`/`left`/`size` props) placed on top of it.
    ///
    /// `z` is the overlay's `z_index` (or `None` to leave it unset).
    fn overlay_scene(overlay_z: Option<i64>) -> Scene {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let flow = scene
            .add_child(root, NodeKind::Box, Style::new().bg(Color::Indexed(1)))
            .expect("flow box");
        scene.set_prop(flow, "width", PropValue::Int(5));
        scene.set_prop(flow, "height", PropValue::Int(5));
        let overlay = scene
            .add_child(root, NodeKind::Box, Style::new().bg(Color::Indexed(2)))
            .expect("overlay box");
        scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
        scene.set_prop(overlay, "top", PropValue::Int(1));
        scene.set_prop(overlay, "left", PropValue::Int(1));
        scene.set_prop(overlay, "width", PropValue::Int(3));
        scene.set_prop(overlay, "height", PropValue::Int(3));
        if let Some(z) = overlay_z {
            scene.set_prop(overlay, "z_index", PropValue::Int(z));
        }
        scene
    }

    #[test]
    fn z_order_higher_z_paints_on_top() {
        // The overlay (z_index 2) paints over the in-flow box where their
        // rects overlap; each keeps its own background where they do not.
        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&overlay_scene(Some(2)), Size::new(20, 12));
        // Overlap cell (1..4, 1..4): the higher-z overlay wins.
        assert_eq!(buffer.cell(2, 2).unwrap().style.bg, Color::Indexed(2));
        // Overlay-only cell.
        assert_eq!(buffer.cell(3, 3).unwrap().style.bg, Color::Indexed(2));
        // Flow-only cell: the flow box's own background.
        assert_eq!(buffer.cell(0, 0).unwrap().style.bg, Color::Indexed(1));
    }

    #[test]
    fn z_order_default_zero_preserves_later_sibling_on_top() {
        // No z_index anywhere: both nodes stack at 0 and the stable sort
        // keeps pre-order, so the later sibling (the overlay) paints on top —
        // exactly the pre-z-order behavior.
        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&overlay_scene(None), Size::new(20, 12));
        assert_eq!(buffer.cell(2, 2).unwrap().style.bg, Color::Indexed(2));
    }

    #[test]
    fn z_order_tie_keeps_tree_order() {
        // Equal explicit z-indexes keep tree order: the later sibling still
        // paints on top.
        let mut scene = overlay_scene(Some(3));
        let root = scene.root_id();
        // Give the in-flow box the same z_index so the tie is explicit.
        let flow = scene.children(root).unwrap()[0];
        scene.set_prop(flow, "z_index", PropValue::Int(3));

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(20, 12));
        assert_eq!(buffer.cell(2, 2).unwrap().style.bg, Color::Indexed(2));
    }

    #[test]
    fn absolute_overlay_paints_above_flow() {
        // An absolutely positioned overlay with a higher z-index than its
        // in-flow sibling paints over it where the rects overlap.
        let scene = overlay_scene(Some(1));
        let root = scene.root_id();
        // The in-flow box keeps z_index 0 (default); the overlay has 1.
        let flow = scene.children(root).unwrap()[0];
        assert_eq!(
            scene.prop(flow, "z_index"),
            None,
            "flow box z defaults to 0"
        );

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(20, 12));
        // Overlap cell: the overlay wins.
        assert_eq!(buffer.cell(2, 2).unwrap().style.bg, Color::Indexed(2));
        // Flow-only cell: the flow box's background still shows through.
        assert_eq!(buffer.cell(0, 0).unwrap().style.bg, Color::Indexed(1));
    }

    #[test]
    fn clip_rect_restricts_subtree_drawing() {
        // A 6x3 box at the origin with a clip rect covering only its first
        // two rows: a 3-row-tall child text is drawn only inside the clip.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(6));
        scene.set_prop(b, "height", PropValue::Int(3));
        scene.set_clip_rect(b, Rect::new(0, 0, 6, 2));

        // Three single-row text children at rows 0, 1, 2 (column layout).
        scene.set_prop(b, "flex_direction", PropValue::Str("column".into()));
        for (row, ch) in ["a", "b", "c"].iter().enumerate() {
            let t = scene.add_text(b, ch, Style::new()).expect("text");
            scene.set_prop(t, "height", PropValue::Int(1));
            scene.set_prop(t, "align_self", PropValue::Str("flex-start".into()));
            let _ = row;
        }

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(6, 3));
        // Clip rows 0-1: 'a' and 'b' visible, 'c' (row 2) clipped away.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'a');
        assert_eq!(buffer.cell(0, 1).unwrap().ch, 'b');
        assert_eq!(buffer.cell(0, 2).unwrap(), &Cell::default());
    }

    #[test]
    fn clip_rect_out_of_bounds_paints_nothing() {
        // A clip rect that lies entirely outside the laid-out text: nothing
        // from the subtree paints.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(4));
        scene.set_prop(b, "height", PropValue::Int(1));
        // Clip to a region that does not overlap the box at all.
        scene.set_clip_rect(b, Rect::new(10, 10, 2, 2));
        scene.add_text(b, "hi", Style::new()).expect("text");

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 1));
        for x in 0..4 {
            assert_eq!(buffer.cell(x, 0).unwrap(), &Cell::default());
        }
    }

    #[test]
    fn scroll_offset_pans_content_inside_clip() {
        // A 4x3 box with scroll_y = 1: content at row 1 renders at row 0 and
        // row 0 scrolls out of view.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(4));
        scene.set_prop(b, "height", PropValue::Int(3));
        scene.set_clip_rect(b, Rect::new(0, 0, 4, 3));
        scene.set_scroll_offset(b, 0, 1);

        // Column layout with 3 rows of text.
        scene.set_prop(b, "flex_direction", PropValue::Str("column".into()));
        for ch in ["a", "b", "c"] {
            let t = scene.add_text(b, ch, Style::new()).expect("text");
            scene.set_prop(t, "height", PropValue::Int(1));
            scene.set_prop(t, "align_self", PropValue::Str("flex-start".into()));
        }

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 3));
        // 'a' (row 0) is scrolled out; 'b' renders at row 0, 'c' at row 1.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'b');
        assert_eq!(buffer.cell(0, 1).unwrap().ch, 'c');
        assert_eq!(buffer.cell(0, 2).unwrap(), &Cell::default());
    }

    #[test]
    fn scroll_offset_with_clip_clips_beyond_region() {
        // scroll_y = 2 on a 3-row viewport: rows 0-1 scroll out, row 2
        // renders at row 0; content below the clip (row 3+) never shows.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(4));
        scene.set_prop(b, "height", PropValue::Int(3));
        scene.set_clip_rect(b, Rect::new(0, 0, 4, 3));
        scene.set_scroll_offset(b, 0, 2);

        scene.set_prop(b, "flex_direction", PropValue::Str("column".into()));
        for ch in ["a", "b", "c", "d"] {
            let t = scene.add_text(b, ch, Style::new()).expect("text");
            scene.set_prop(t, "height", PropValue::Int(1));
            scene.set_prop(t, "align_self", PropValue::Str("flex-start".into()));
        }

        let mut compositor = Compositor::new();
        let buffer = compositor.paint_scene(&scene, Size::new(4, 3));
        // Content rows 2 and 3 map to buffer rows 0 and 1.
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'c');
        assert_eq!(buffer.cell(0, 1).unwrap().ch, 'd');
        assert_eq!(buffer.cell(0, 2).unwrap(), &Cell::default());
    }

    #[test]
    fn scroll_pans_streaming_text_and_frame_stays() {
        // A bordered 5x3 box with scroll_y = 1 holding a streaming child: the
        // border stays at the frame while the stream's first row scrolls out
        // and its second row pans to the top of the content area. The clip
        // rect is the content area inside the border, so scrolled content
        // never overwrites the frame.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Plain),
            )
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(5));
        scene.set_prop(b, "height", PropValue::Int(3));
        scene.set_prop(b, "border", PropValue::Int(1));
        // Clip = the content area inside the 1-cell border.
        scene.set_clip_rect(b, Rect::new(1, 1, 3, 1));
        scene.set_scroll_offset(b, 0, 1);

        let s = scene
            .add_child(b, NodeKind::StreamingText, Style::new())
            .expect("stream");
        scene.set_prop(s, "width", PropValue::Int(3));
        scene.set_prop(s, "height", PropValue::Int(2));
        assert!(scene.append_span(
            s,
            Span {
                text: "ab\ncd".to_string(),
                style: Style::new(),
            }
        ));

        let rows = render_scene_rows(&scene, Size::new(5, 3));
        // Border frame intact: +---+ top, +---+ bottom.
        // Content: stream row 0 ('ab') scrolled out; stream row 1 ('cd')
        // panned to the box's first content row.
        assert_eq!(rows[0], "+---+");
        assert_eq!(rows[1], "|cd |");
        assert_eq!(rows[2], "+---+");
    }

    #[test]
    fn streaming_leaf_absolute_child_paints_at_clip_bottom_right() {
        // The scroll-to-bottom affordance: a streaming leaf with a clip rect
        // and scroll offset whose absolutely positioned 1x1 ▼ child (right 0,
        // top = clip 2 - 1 + scroll 1 = 2, z_index 2) stays pinned to the
        // clip region's bottom-right row over the scrolled content — the
        // leaf's in-flow children are dropped, but its absolute decorations
        // lay out against it and paint above the in-flow content.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .expect("stream");
        scene.set_prop(s, "width", PropValue::Int(6));
        scene.set_prop(s, "height", PropValue::Int(2));
        scene.set_clip_rect(s, Rect::new(0, 0, 6, 2));
        scene.set_scroll_offset(s, 0, 1);
        assert!(scene.append_span(
            s,
            Span {
                text: "aaaa\nbbbb".to_string(),
                style: Style::new(),
            }
        ));
        let cell = scene
            .add_text(s, "▼", Style::new())
            .expect("affordance cell");
        scene.set_prop(cell, "position", PropValue::Str("absolute".into()));
        scene.set_prop(cell, "right", PropValue::Int(0));
        scene.set_prop(cell, "top", PropValue::Int(2)); // (clip 2 - 1) + scroll 1
        scene.set_prop(cell, "width", PropValue::Int(1));
        scene.set_prop(cell, "height", PropValue::Int(1));
        scene.set_prop(cell, "z_index", PropValue::Int(2));

        let rows = render_scene_rows(&scene, Size::new(6, 2));
        // Stream row 0 ('aaaa') scrolled out; stream row 1 ('bbbb') pans to
        // the clip's top row; the ▼ cell is pinned at the clip's bottom-right
        // (right: 0 aligns its right edge with the 6-wide clip, so it paints
        // at the rightmost column).
        assert_eq!(rows[0], "bbbb  ");
        assert_eq!(rows[1], "     ▼");

        // A leaf's in-flow child stays dropped (it is not a decoration).
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .expect("stream");
        scene.set_prop(t, "width", PropValue::Int(4));
        scene.set_prop(t, "height", PropValue::Int(1));
        scene.append_span(
            t,
            Span {
                text: "aaaa".to_string(),
                style: Style::new(),
            },
        );
        let flow = scene.add_text(t, "x", Style::new()).expect("in-flow child");
        scene.set_prop(flow, "position", PropValue::Str("relative".into()));
        let rows = render_scene_rows(&scene, Size::new(4, 1));
        // Only the leaf's own content paints; the in-flow child is dropped.
        assert_eq!(rows[0], "aaaa");
    }

    // --- Scene geometry queries (hit_test / content_size) ----------------

    #[test]
    fn hit_test_returns_topmost_z_ordered_path() {
        // A 5x5 in-flow box with a text label, plus an absolutely positioned
        // overlay (z_index 2) covering the box's top-left corner: at an
        // overlap cell the overlay is topmost; elsewhere the label (and its
        // ancestor box) win; the root is never reported.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let flow = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("flow box");
        scene.set_prop(flow, "width", PropValue::Int(5));
        scene.set_prop(flow, "height", PropValue::Int(5));
        scene.set_prop(flow, "align_items", PropValue::Str("flex-start".into()));
        let label = scene.add_text(flow, "hi", Style::new()).expect("label");

        let overlay = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("overlay");
        scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
        scene.set_prop(overlay, "top", PropValue::Int(1));
        scene.set_prop(overlay, "left", PropValue::Int(1));
        scene.set_prop(overlay, "width", PropValue::Int(3));
        scene.set_prop(overlay, "height", PropValue::Int(3));
        scene.set_prop(overlay, "z_index", PropValue::Int(2));

        let mut comp = Compositor::new();
        let viewport = Size::new(20, 12);
        // Overlap cell: the higher-z overlay wins (painted last).
        assert_eq!(comp.hit_test(&scene, 2, 2, viewport), vec![overlay]);
        // The label is topmost over the flow box, and the box (an ancestor
        // that also covers the cell) follows in the path.
        assert_eq!(comp.hit_test(&scene, 1, 0, viewport), vec![label, flow]);
        // A flow-only cell (inside the box, outside the label and overlay).
        assert_eq!(comp.hit_test(&scene, 3, 0, viewport), vec![flow]);
    }

    #[test]
    fn hit_test_empty_miss_returns_empty() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(4));
        scene.set_prop(b, "height", PropValue::Int(4));

        let mut comp = Compositor::new();
        let viewport = Size::new(20, 12);
        // Inside the viewport but outside every node.
        assert!(comp.hit_test(&scene, 6, 6, viewport).is_empty());
        // Outside the viewport entirely.
        assert!(comp.hit_test(&scene, 50, 50, viewport).is_empty());
    }

    #[test]
    fn hit_test_respects_clip_and_scroll_regions() {
        // A bordered 5x3 pane whose clip (1,1,3,1) + scroll_y=1 pan a
        // streaming child: the pane's frame (border) stays hittable where the
        // clip rejects content, the scrolled-out row is not claimed by the
        // stream, and the panned content row is topmost inside the pane.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(5));
        scene.set_prop(b, "height", PropValue::Int(3));
        scene.set_prop(b, "border", PropValue::Int(1));
        scene.set_clip_rect(b, Rect::new(1, 1, 3, 1));
        scene.set_scroll_offset(b, 0, 1);
        let s = scene
            .add_child(b, NodeKind::StreamingText, Style::new())
            .expect("stream");
        scene.set_prop(s, "width", PropValue::Int(3));
        scene.set_prop(s, "height", PropValue::Int(2));
        assert!(scene.append_span(
            s,
            Span {
                text: "ab\ncd".to_string(),
                style: Style::new(),
            }
        ));

        let mut comp = Compositor::new();
        let viewport = Size::new(5, 3);
        // 'cd' pans to buffer row 1: the stream is topmost there.
        assert_eq!(comp.hit_test(&scene, 1, 1, viewport), vec![s, b]);
        // The pane's border (buffer col 0, row 1) belongs to the pane.
        assert_eq!(comp.hit_test(&scene, 0, 1, viewport), vec![b]);
        // 'ab' is scrolled out of the clip (buffer row 0 shows the top
        // border): the stream must not claim it, the pane's frame still does.
        assert_eq!(comp.hit_test(&scene, 1, 0, viewport), vec![b]);
    }

    #[test]
    fn content_size_wrapped_streaming_height() {
        // 'abcdef' wraps onto two rows at a 4-cell width: (4, 2).
        let mut scene = streaming_scene(4, 2);
        let root = scene.root_id();
        let s = scene.children(root).unwrap()[0];
        assert!(scene.append_span(
            s,
            Span {
                text: "abcdef".to_string(),
                style: Style::new(),
            }
        ));
        let mut comp = Compositor::new();
        assert_eq!(comp.content_size(&scene, s, Size::new(4, 2)), Some((4, 2)));

        // Multi-width: 'コ' (2 cells) + 'abc' wraps to 'コa' / 'bc' at a
        // 3-cell width: width stays 3, height 2.
        let mut scene2 = streaming_scene(3, 2);
        let root2 = scene2.root_id();
        let s2 = scene2.children(root2).unwrap()[0];
        assert!(scene2.append_span(
            s2,
            Span {
                text: "コabc".to_string(),
                style: Style::new(),
            }
        ));
        assert_eq!(
            comp.content_size(&scene2, s2, Size::new(3, 2)),
            Some((3, 2))
        );

        // Hard newlines break rows; empty content reports (0, 0).
        let mut scene3 = streaming_scene(10, 4);
        let root3 = scene3.root_id();
        let s3 = scene3.children(root3).unwrap()[0];
        assert!(scene3.append_span(
            s3,
            Span {
                text: "ab\ncd".to_string(),
                style: Style::new(),
            }
        ));
        assert_eq!(
            comp.content_size(&scene3, s3, Size::new(10, 4)),
            Some((2, 2))
        );
        let scene4 = streaming_scene(10, 1);
        let root4 = scene4.root_id();
        let s4 = scene4.children(root4).unwrap()[0];
        // An empty stream still occupies one row (the empty-line rule — a
        // blank spacer keeps its row in the layout).
        assert_eq!(
            comp.content_size(&scene4, s4, Size::new(10, 1)),
            Some((0, 1))
        );

        // A `wrap: false` leaf paints one trimmed row: content size collapses
        // to the rect width by one row, regardless of content length.
        let mut scene5 = streaming_scene(4, 2);
        let root5 = scene5.root_id();
        let s5 = scene5.children(root5).unwrap()[0];
        scene5.set_prop(s5, "wrap", PropValue::Bool(false));
        assert!(scene5.append_span(
            s5,
            Span {
                text: "abcdef".to_string(),
                style: Style::new(),
            }
        ));
        assert_eq!(
            comp.content_size(&scene5, s5, Size::new(4, 2)),
            Some((4, 1))
        );
    }

    #[test]
    fn content_size_uses_layout_size_for_boxes_and_text() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("box");
        scene.set_prop(b, "width", PropValue::Int(7));
        scene.set_prop(b, "height", PropValue::Int(3));
        let t = scene.add_text(b, "hi", Style::new()).expect("text");

        let mut comp = Compositor::new();
        // A box reports its laid-out rect size; a text leaf its wrapped
        // content size (single line here).
        assert_eq!(
            comp.content_size(&scene, b, Size::new(20, 12)),
            Some((7, 3))
        );
        assert_eq!(
            comp.content_size(&scene, t, Size::new(20, 12)),
            Some((2, 1))
        );
        // Missing and display:none nodes have no geometry.
        assert_eq!(
            comp.content_size(&scene, NodeId(999), Size::new(20, 12)),
            None
        );
        scene.set_prop(b, "display", PropValue::Str("none".into()));
        assert_eq!(comp.content_size(&scene, b, Size::new(20, 12)), None);
    }

    // ---------------------------------------------------------------------
    // Dirty-region repaint (round 2)
    // ---------------------------------------------------------------------

    /// The ids of the dirty-repaint test scene's nodes.
    struct DirtyIds {
        left: NodeId,
        text: NodeId,
        right: NodeId,
        stream: NodeId,
        overlay: NodeId,
    }

    /// A non-trivial scene for dirty-repaint parity: a padded root holding a
    /// row of two boxes — one with a text leaf, one with a streaming leaf and
    /// an absolutely positioned z-ordered overlay.
    fn dirty_repaint_scene() -> (Scene, DirtyIds) {
        let mut scene = Scene::new();
        let root = scene.root_id();
        scene.set_prop(root, "padding", PropValue::Int(1));
        let row = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(row, "width", PropValue::Int(38));
        scene.set_prop(row, "height", PropValue::Int(8));
        let left = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(left, "width", PropValue::Int(18));
        scene.set_prop(left, "height", PropValue::Int(6));
        let text = scene.add_text(left, "Hello", Style::new()).unwrap();
        let right = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(right, "width", PropValue::Int(18));
        scene.set_prop(right, "height", PropValue::Int(6));
        let stream = scene
            .add_child(right, NodeKind::StreamingText, Style::new())
            .unwrap();
        assert!(scene.append_span(
            stream,
            Span {
                text: "s1".into(),
                style: Style::new(),
            }
        ));
        let overlay = scene.add_child(right, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
        scene.set_prop(overlay, "top", PropValue::Int(0));
        scene.set_prop(overlay, "left", PropValue::Int(4));
        scene.set_prop(overlay, "width", PropValue::Int(4));
        scene.set_prop(overlay, "height", PropValue::Int(2));
        scene.set_prop(overlay, "z_index", PropValue::Int(5));
        (
            scene,
            DirtyIds {
                left,
                text,
                right,
                stream,
                overlay,
            },
        )
    }

    /// Warm a compositor with frame 1, apply `mutate`, paint frame 2 on the
    /// warm compositor (the dirty path) and on a fresh compositor (the full
    /// recompute oracle), and assert the two invariants: the buffers are
    /// cell-for-cell equal, and the diffs vs the same previous frame are
    /// identical (so the renderer's terminal output is unchanged).
    fn assert_dirty_parity(
        warm: &mut Compositor,
        scene: &mut Scene,
        ids: &DirtyIds,
        viewport: Size,
        mutate: impl FnOnce(&mut Scene, &DirtyIds),
    ) {
        let prev = warm.paint_scene(scene, viewport);
        assert!(matches!(warm.last_paint_mode(), PaintMode::Full));
        mutate(scene, ids);
        let dirty = warm.paint_scene(scene, viewport);
        let mut fresh = Compositor::new();
        let full = fresh.paint_scene(scene, viewport);
        assert_eq!(
            dirty, full,
            "dirty repaint must equal a full recompute cell-for-cell"
        );
        assert_eq!(
            dirty.diff_from(&prev),
            full.diff_from(&prev),
            "the diff vs the previous frame must be identical between the paths"
        );
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_single_leaf_change() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hello, world!".into())));
        });
        // A single-leaf change repaints a small subset, never everything.
        assert!(
            matches!(warm.last_paint_mode(), PaintMode::Dirty(n) if *n < warm.last_painted_node_count()),
            "a single-leaf change must take the dirty path, got {:?}",
            warm.last_paint_mode()
        );
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_stream_append() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.append_span(
                ids.stream,
                Span {
                    text: " s2".into(),
                    style: Style::new(),
                }
            ));
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_move() {
        // A style change that shifts the sibling subtree: the dirty region is
        // the union of the old and new bounds, so no stale cells survive.
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(80, 20);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.set_prop(ids.left, "width", PropValue::Int(10)));
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_shrink() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(80, 20);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.set_prop(ids.right, "height", PropValue::Int(3)));
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_removal() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(80, 20);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.remove(ids.right), "removing the right subtree");
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_display_none() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(80, 20);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.set_prop(ids.left, "display", PropValue::Str("none".into())));
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_z_overlay() {
        // A z-index change re-stacks the overlay: the dirty region is the
        // overlay's rect, and the intersecting nodes (the stream beneath it)
        // repaint in the new z-order.
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(80, 20);
        let mut warm = Compositor::new();
        assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
            assert!(scene.set_prop(ids.overlay, "z_index", PropValue::Int(-1)));
        });
    }

    #[test]
    fn dirty_repaint_buffer_equals_full_recompute_on_status_bar() {
        // A status-bar scene: the strip owns the reserved bottom row. A
        // segment text change must dirty-repaint without disturbing the
        // pinned strip or the panels above it.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let panel = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(panel, "width", PropValue::Int(20));
        scene.set_prop(panel, "height", PropValue::Int(5));
        let _pcontent = scene.add_text(panel, "content", Style::new()).unwrap();
        let strip = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(strip, "status_bar", PropValue::Bool(true));
        scene.set_prop(strip, "width", PropValue::Int(40));
        scene.set_prop(strip, "height", PropValue::Int(1));
        let seg = scene.add_text(strip, "seg", Style::new()).unwrap();

        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        let prev = warm.paint_scene(&scene, viewport);
        // The strip is pinned to the reserved bottom row (row 9); the panel
        // content sits at the top-left.
        assert!(
            (0..40).any(|x| cell_char(&prev, x, 9) == 's'),
            "the pinned strip segment must sit on the reserved bottom row"
        );
        assert_eq!(cell_char(&prev, 0, 0), 'c');

        assert!(scene.set_prop(seg, "text", PropValue::Str("SEG!".into())));
        let dirty = warm.paint_scene(&scene, viewport);
        let mut fresh = Compositor::new();
        let full = fresh.paint_scene(&scene, viewport);
        assert_eq!(
            dirty, full,
            "status-bar dirty repaint must equal a full paint"
        );
        assert_eq!(dirty.diff_from(&prev), full.diff_from(&prev));
        // The reserved row still holds the strip (now "SEG!"), and the panel
        // content above is untouched by the pinning.
        assert!(
            (0..40).any(|x| "SEG!".contains(cell_char(&dirty, x, 9))),
            "the updated segment must be painted on the reserved bottom row"
        );
        assert_eq!(cell_char(&dirty, 0, 0), 'c');
        assert!(matches!(warm.last_paint_mode(), PaintMode::Dirty(_)));
    }

    #[test]
    fn dirty_repaint_localized_mutation_takes_dirty_path() {
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        let _ = warm.paint_scene(&scene, viewport);
        assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hi".into())));
        let _ = warm.paint_scene(&scene, viewport);
        assert!(
            matches!(warm.last_paint_mode(), PaintMode::Dirty(n) if *n < warm.last_painted_node_count()),
            "a localized mutation must take the dirty path, got {:?}",
            warm.last_paint_mode()
        );
        assert_eq!(
            warm.last_repainted_node_count(),
            *match warm.last_paint_mode() {
                PaintMode::Dirty(n) => n,
                other => panic!("expected Dirty, got {other:?}"),
            }
        );
    }

    #[test]
    fn dirty_repaint_resize_takes_full_path() {
        // A viewport change is explicit global invalidation: full repaint.
        let (scene, _ids) = dirty_repaint_scene();
        let mut warm = Compositor::new();
        let _ = warm.paint_scene(&scene, Size::new(40, 10));
        let _ = warm.paint_scene(&scene, Size::new(30, 8));
        assert_eq!(
            warm.last_paint_mode(),
            &PaintMode::Full,
            "a viewport resize must take the full-repaint path"
        );
    }

    #[test]
    fn dirty_repaint_unchanged_scene_returns_retained_buffer() {
        // The scene is painted twice without mutation: the second frame is the
        // retained buffer (no repaint at all), and the diff is empty — the
        // unchanged-scene diff output is byte-identical (empty) exactly as
        // before the dirty-repaint change.
        let (scene, _ids) = dirty_repaint_scene();
        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        let first = warm.paint_scene(&scene, viewport);
        let second = warm.paint_scene(&scene, viewport);
        assert_eq!(warm.last_paint_mode(), &PaintMode::NoPaint);
        assert_eq!(first, second, "the retained buffer is returned unchanged");
        assert!(
            second.diff_from(&first).is_empty(),
            "an unchanged scene produces an empty diff"
        );
    }

    #[test]
    fn dirty_repaint_hit_test_parity() {
        // After a dirty repaint, hit_test on the warm compositor must route
        // exactly like a fresh compositor (same cached/incremental layout).
        let (mut scene, ids) = dirty_repaint_scene();
        let viewport = Size::new(40, 10);
        let mut warm = Compositor::new();
        let _ = warm.paint_scene(&scene, viewport);
        assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hello, world!".into())));
        let _ = warm.paint_scene(&scene, viewport);

        let mut fresh = Compositor::new();
        let _ = fresh.paint_scene(&scene, viewport);
        for (col, row) in [(1, 1), (2, 2), (20, 2), (0, 9), (39, 9)] {
            let a = warm.hit_test(&scene, col, row, viewport);
            let b = fresh.hit_test(&scene, col, row, viewport);
            assert_eq!(a, b, "hit_test parity at ({col},{row})");
        }
    }

    #[test]
    fn dirty_repaint_content_size_parity() {
        // After a dirty repaint, content_size on the warm compositor matches a
        // fresh compositor — including after a viewport resize (full path).
        let (mut scene, ids) = dirty_repaint_scene();
        let mut warm = Compositor::new();
        let _ = warm.paint_scene(&scene, Size::new(40, 10));
        assert!(scene.set_prop(ids.left, "width", PropValue::Int(10)));
        let _ = warm.paint_scene(&scene, Size::new(40, 10));

        let mut fresh = Compositor::new();
        let _ = fresh.paint_scene(&scene, Size::new(40, 10));
        assert_eq!(
            warm.content_size(&scene, ids.left, Size::new(40, 10)),
            fresh.content_size(&scene, ids.left, Size::new(40, 10))
        );
        assert_eq!(
            warm.content_size(&scene, ids.text, Size::new(40, 10)),
            fresh.content_size(&scene, ids.text, Size::new(40, 10))
        );

        // Resize case: repaint at a new viewport (full path), then measure.
        let _ = warm.paint_scene(&scene, Size::new(30, 8));
        let mut fresh2 = Compositor::new();
        let _ = fresh2.paint_scene(&scene, Size::new(30, 8));
        assert_eq!(
            warm.content_size(&scene, ids.stream, Size::new(30, 8)),
            fresh2.content_size(&scene, ids.stream, Size::new(30, 8))
        );
    }


}
