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

mod paint;
mod pass;
mod region;
mod signature;
mod text;

use paint::*;
use region::*;
use signature::*;
use text::*;
// `pass` contributes `impl Compositor` methods only — no items to import.

#[cfg(test)]
mod tests;

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
