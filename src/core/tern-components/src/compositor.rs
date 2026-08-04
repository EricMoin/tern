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
//!   truncated mid-glyph at the right edge). Text leaves are inherently
//!   single-row: the line is trimmed at the right edge, so both `wrap: true`
//!   (default) and `wrap: false` paint it the same way. A `caret` Int prop (a
//!   display column) paints the block caret over the cell under the cursor,
//!   using the node's style reversed.
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

use std::collections::HashMap;

use tern_core::buffer::{Buffer, Region};
use tern_core::cell::{char_width, Cell};
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
/// A fresh layout pass runs on every [`paint`](Compositor::paint) /
/// [`paint_scene`](Compositor::paint_scene) call; the compositor itself is
/// stateless apart from the layout engine.
#[derive(Debug, Clone, Copy, Default)]
pub struct Compositor {
    layout: TaffyLayoutEngine,
}

impl Compositor {
    /// A compositor with a fresh taffy-backed layout engine.
    pub fn new() -> Self {
        Self {
            layout: TaffyLayoutEngine::new(),
        }
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
    pub fn paint_scene(&mut self, scene: &Scene, viewport: Size) -> Buffer {
        let mut buffer = Buffer::new(viewport.width, viewport.height);
        // taffy 0.7 reports each node's `Layout.location` relative to its
        // parent (verified against taffy's `round_layout` in
        // `taffy/src/compute/mod.rs`: `layout.location = round(unrounded
        // location)` with no parent-origin accumulation). Painting needs
        // scene-absolute rects, so [`layout_rects`](Compositor::layout_rects)
        // accumulates parent origins into the raw layout result before
        // anything else (and reserves the bottom row for a `StatusBar`, if
        // the scene has one). For trees where every nested parent sits at the
        // origin (all pre-existing golden tests) this is an exact no-op; it
        // is what makes depth-2+ subtrees — nested boxes, and the roadmap
        // components' group/panel -> text leaves — land at their real scene
        // positions.
        let rects = self.layout_rects(scene, viewport);
        // Collect every laid-out node in pre-order, then paint by ascending
        // effective z-index. The sort is stable, so equal z-indexes keep
        // pre-order: with no `z_index` prop anywhere this paints exactly like
        // the historical pre-order traversal.
        let mut order: Vec<NodeId> = Vec::new();
        collect_paint_order(scene, scene.root_id(), &rects, &mut order);
        order.sort_by(|&a, &b| z_index(scene, a).cmp(&z_index(scene, b)));
        for id in order {
            if let Some(node) = scene.node(id) {
                if let Some(&rect) = rects.get(&id) {
                    // A node's frame (box background/border) is drawn through
                    // its ancestors' regions only; its content (text, stream,
                    // children) also applies its own scroll offset, so a pane
                    // scrolls its content inside its own fixed frame.
                    let frame = effective_region(scene, id, viewport, false);
                    let content = effective_region(scene, id, viewport, true);
                    paint_node(node, rect, frame, content, &mut buffer);
                }
            }
        }
        buffer
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
    /// paint pass uses, so a streaming node's height is how many rows its
    /// content would occupy when displayed). A leaf declaring `wrap: false`
    /// paints a single row trimmed at the rect's right edge, so its content
    /// size is the rect width by one row. For every other node kind the size
    /// is the laid-out rect size from the layout engine.
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

/// Paint a single node into its laid-out rect, drawing its frame through
/// `frame` (box background/border) and its content through `content` (text,
/// stream spans).
fn paint_node(node: &SceneNode, rect: Rect, frame: Region, content: Region, buffer: &mut Buffer) {
    match node.kind {
        NodeKind::Root => {}
        NodeKind::Box => paint_box(node, rect, frame, buffer),
        NodeKind::Text => paint_text(node, rect, content, buffer),
        NodeKind::StreamingText => paint_streaming_text(node, rect, content, buffer),
    }
}

/// Paint a box: background fill, optional border ring, then children (painted
/// by the traversal) on top. The padding inset is baked into the children's
/// layout rects. The frame is drawn through `region` (the node's own scroll
/// excluded), so a scrollable pane's background and border stay put while its
/// content pans inside them.
fn paint_box(node: &SceneNode, rect: Rect, region: Region, buffer: &mut Buffer) {
    // Background: fill the rect only when a non-default background is set, so
    // default boxes stay transparent over whatever is beneath them.
    if node.style.bg != Color::Default {
        let x0 = region.map_x(rect.x).max(region.clip.x).max(0) as u16;
        let y0 = region.map_y(rect.y).max(region.clip.y).max(0) as u16;
        let x1 = region
            .map_x(rect.right())
            .min(region.clip.right())
            .min(buffer.width as i32) as u16;
        let y1 = region
            .map_y(rect.bottom())
            .min(region.clip.bottom())
            .min(buffer.height as i32) as u16;
        if x1 > x0 && y1 > y0 {
            for y in y0..y1 {
                for x in x0..x1 {
                    buffer.set_cell(x, y, Cell::styled(' ', node.style));
                }
            }
        }
    }

    // Border ring: concrete glyphs are chosen here (tern-core carries only the
    // style choice); the ring is clipped to the region (and the buffer).
    let Some((tl, tr, bl, br, h, v)) = border_glyphs(node.style.border_style) else {
        return;
    };
    let x0 = region.map_x(rect.x).max(region.clip.x).max(0) as u16;
    let y0 = region.map_y(rect.y).max(region.clip.y).max(0) as u16;
    let x1 = region
        .map_x(rect.right())
        .min(region.clip.right())
        .min(buffer.width as i32) as u16;
    let y1 = region
        .map_y(rect.bottom())
        .min(region.clip.bottom())
        .min(buffer.height as i32) as u16;
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let last_x = x1 - 1;
    let last_y = y1 - 1;
    for x in x0..x1 {
        buffer.set_char(x, y0, h, node.style); // top edge
        buffer.set_char(x, last_y, h, node.style); // bottom edge
    }
    for y in y0..y1 {
        buffer.set_char(x0, y, v, node.style); // left edge
        buffer.set_char(last_x, y, v, node.style); // right edge
    }
    // Corners (overwrite the edge glyphs).
    buffer.set_char(x0, y0, tl, node.style);
    buffer.set_char(last_x, y0, tr, node.style);
    buffer.set_char(x0, last_y, bl, node.style);
    buffer.set_char(last_x, last_y, br, node.style);
}

/// Paint a text leaf's content starting at its rect origin, through `region`
/// (the content is shifted by the region's scroll offset and clipped to its
/// clip rect — and to the buffer). A wide character that would straddle the
/// right edge is dropped, never truncated mid-glyph.
///
/// When the node carries a `caret` Int prop (a display-column offset — the
/// [`Input`](crate::Input) component stamps it), the block caret is painted
/// over the cell under the cursor using the node's own style reversed, via
/// tern-core's [`Buffer::render_caret`] (subtask 3's caret machinery). The
/// caret is painted even over the placeholder when the text is empty. The
/// caret position is mapped through the region like any other cell, so a
/// scrolled/clipped text leaf scrolls its caret along with its content.
fn paint_text(node: &SceneNode, rect: Rect, region: Region, buffer: &mut Buffer) {
    if let Some(PropValue::Str(content)) = node.props.get("text") {
        let y = rect.y;
        if region.map_y(y) >= region.clip.y
            && region.map_y(y) < region.clip.bottom()
            && region.clip.bottom() > region.clip.y
        {
            let right = rect.right().min(region.clip.right() + region.scroll_x);
            let mut cx = rect.x;
            for ch in content.chars() {
                if cx >= right || ch == '\n' {
                    break;
                }
                let w = char_width(ch);
                if w == 0 {
                    continue;
                }
                // Paint only fully visible glyphs: skip when the lead cell is
                // off-screen to the left or the wide glyph crosses the right
                // edge.
                if cx >= 0 && cx + w as i32 <= right {
                    buffer.set_char_region(cx, y, ch, node.style, region);
                }
                cx += w as i32;
            }
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
/// to the region and the buffer.
///
/// A node with `wrap: false` instead paints its whole stream as one
/// single-row line, trimmed at the right edge (see
/// [`paint_streaming_text_single_row`]).
fn paint_streaming_text(node: &SceneNode, rect: Rect, region: Region, buffer: &mut Buffer) {
    let Some(stream) = node.stream.as_deref() else {
        return;
    };
    if stream.is_empty() {
        return;
    }
    if !wrap_enabled(node) {
        return paint_streaming_text_single_row(stream, rect, region, buffer);
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
        for ch in span.text.chars() {
            match ch {
                // Hard break: flush the pending word, then start a new row.
                '\n' => {
                    paint_word(
                        &word,
                        word_style,
                        rect,
                        right,
                        bottom,
                        &mut cursor,
                        region,
                        buffer,
                    );
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
                ' ' => {
                    paint_word(
                        &word,
                        word_style,
                        rect,
                        right,
                        bottom,
                        &mut cursor,
                        region,
                        buffer,
                    );
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
                    word.push(ch);
                }
            }
        }
        // Span boundary: flush so per-span styles stay exact across spans.
        paint_word(
            &word,
            word_style,
            rect,
            right,
            bottom,
            &mut cursor,
            region,
            buffer,
        );
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
) {
    let right = rect.right().min(region.clip.right() + region.scroll_x);
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
    for span in stream {
        for ch in span.text.chars() {
            if ch == '\n' {
                return; // single-row: the line ends here
            }
            let w = char_width(ch);
            if w == 0 {
                continue;
            }
            // Trim: a glyph that would straddle the right edge is dropped
            // whole (never mid-glyph); nothing after it fits either.
            if cx + w as i32 > right {
                return;
            }
            buffer.set_char_region(cx, rect.y, ch, span.style, region);
            cx += w as i32;
        }
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

/// The display width of a string in terminal cells (multi-width aware).
fn display_width(content: &str) -> u32 {
    content.chars().map(|c| char_width(c) as u32).sum()
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
/// `(0, 0)` — no content, no size.
fn measure_wrapped(content: &str, width: u32) -> (u32, u32) {
    if content.is_empty() {
        return (0, 0);
    }
    let width = width.max(1);
    let mut lines: u32 = 1;
    let mut max_col: u32 = 0;
    let mut col: u32 = 0;
    let mut word = String::new();
    for ch in content.chars() {
        match ch {
            '\n' => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                lines += 1;
                col = 0;
            }
            ' ' => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                // A trailing space at a row's end is dropped (the wrap would
                // collapse it anyway), mirroring paint_streaming_text.
                if col < width {
                    col += 1;
                    max_col = max_col.max(col);
                }
            }
            _ => word.push(ch),
        }
    }
    flush_word(&word, width, &mut col, &mut lines, &mut max_col);
    (max_col, lines)
}

/// Place one pending token onto the wrapped measurement, applying the same
/// wrap rule as [`paint_word`]: whole-token wrap when it does not fit the
/// current row but fits a fresh one, hard char-by-char break when the token is
/// wider than the whole row.
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
    for ch in word.chars() {
        let w = char_width(ch) as u32;
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
/// hard-broken across rows. A wide character that would straddle `right` — or
/// that is wider than the row itself — is dropped, never split mid-glyph. The
/// cursor advances past every token glyph, including dropped ones. Each glyph
/// is drawn via [`Buffer::set_char_region`], so it is also shifted by the
/// region's scroll and clipped to its clip rect; glyphs on a row whose mapped
/// position falls outside `frame` (the node's own rect) are skipped, so
/// scrolled content stays inside the pane.
fn paint_word(
    word: &str,
    style: Style,
    frame: Rect,
    right: i32,
    bottom: i32,
    cursor: &mut WrapCursor,
    region: Region,
    buffer: &mut Buffer,
) {
    let line_start = frame.x;
    if word.is_empty() {
        return;
    }
    let width: i32 = word.chars().map(|c| char_width(c) as i32).sum();
    // Wrap the whole token when it does not fit on the current row and can fit
    // on a fresh row; a token wider than the row itself is hard-broken below.
    if cursor.col > line_start && cursor.col + width > right && width <= right - line_start {
        cursor.row += 1;
        cursor.col = line_start;
        if cursor.row >= bottom {
            return;
        }
    }
    for ch in word.chars() {
        let w = char_width(ch);
        if w == 0 {
            continue;
        }
        if cursor.col + w as i32 > right {
            // Does not fit on this row: wrap. A wide char that still cannot
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
        if row_inside_frame(frame, region, cursor.row) {
            buffer.set_char_region(cursor.col, cursor.row, ch, style, region);
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
        let buffer = Compositor::new().paint(root, viewport);
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                    .collect()
            })
            .collect()
    }

    /// Paint a raw scene and return it as a `Vec<String>` grid for golden
    /// comparisons.
    fn render_scene_rows(scene: &Scene, viewport: Size) -> Vec<String> {
        let buffer = Compositor::new().paint_scene(scene, viewport);
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                    .collect()
            })
            .collect()
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
    fn golden_rounded_box_padding_hi_in_10x4() {
        // A rounded-border box with 1-cell padding around Text('Hi'), painted
        // into a 10x4 buffer: the box fills the viewport, so the border glyphs
        // (┌┐└┘│─) sit at the edges of the buffer.
        let box_style = Style::new().border_style(BorderStyle::Rounded);
        let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

        let buffer = Compositor::new().paint(tree.clone(), Size::new(10, 4));

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
    fn text_paints_content_clipped_to_rect() {
        // A bare text root paints its content from the top-left, clipped to
        // the buffer.
        let tree = Text::new("Hello", Style::new());
        let buffer = Compositor::new().paint(tree, Size::new(3, 1));
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

        let buffer = Compositor::new().paint(tree, Size::new(5, 3));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(6, 3));
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
        let buffer = Compositor::new().paint(input, Size::new(6, 3));

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
        let buffer = Compositor::new().paint(input, Size::new(6, 3));

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
        let buffer = Compositor::new().paint(input, Size::new(6, 3));
        for x in 0..6 {
            let c = buffer.cell(x, 1).unwrap();
            assert!(!c.style.modifiers.contains(Modifiers::REVERSED));
        }
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
    }

    #[test]
    fn spinner_bar_paints_filled_and_empty_cells() {
        // A determinate spinner painted as the root: 4-wide bar, 1 of 4 done
        // -> '▓' + 3 '░' + " 25%".
        let mut spinner = Spinner::determinate(4).bar_width(4);
        spinner.set_progress(1);
        let buffer = Compositor::new().paint(spinner, Size::new(8, 1));
        let row: String = (0..8).map(|x| buffer.cell(x, 0).unwrap().ch).collect();
        assert_eq!(row, "▓░░░ 25%");
    }

    #[test]
    fn spinner_indeterminate_paints_current_frame() {
        let spinner = Spinner::with_frames(&["⠋", "⠙"]);
        let buffer = Compositor::new().paint(spinner, Size::new(4, 1));
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
        let buffer = Compositor::new().paint(bar, Size::new(12, 1));
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
        let buffer = Compositor::new().paint(bar, Size::new(20, 1));
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
        let buffer = Compositor::new().paint(bar, Size::new(20, 3));
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

        let buffer = Compositor::new().paint(tree, Size::new(20, 8));
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
        assert_eq!(rows[7].chars().nth(0), Some('L'), "row7 = {:?}", rows[7]);
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
        let buffer = Compositor::new().paint(panels, Size::new(20, 5));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(12, 3));

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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(3, 1));
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
        let buffer2 = Compositor::new().paint_scene(&scene2, Size::new(1, 1));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 2));

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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 2));

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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(3, 1));

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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 1));

        // Expected cell grid:
        //   abcd
        let mut expected = Buffer::new(4, 1);
        for (x, ch) in "abcd".chars().enumerate() {
            expected.set_char(x as u16, 0, ch, Style::new());
        }

        assert_eq!(buffer, expected);
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
        let buffer = Compositor::new().paint_scene(&overlay_scene(Some(2)), Size::new(20, 12));
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
        let buffer = Compositor::new().paint_scene(&overlay_scene(None), Size::new(20, 12));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(20, 12));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(20, 12));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(6, 3));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 1));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 3));
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

        let buffer = Compositor::new().paint_scene(&scene, Size::new(4, 3));
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
        assert_eq!(
            comp.content_size(&scene4, s4, Size::new(10, 1)),
            Some((0, 0))
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
}
