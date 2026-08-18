//! Scene geometry, node coverage (hit testing), and dirty-region unions.

use super::*;

/// Whether `id` (with laid-out rect `rect`) covers the cell (`col`, `row`)
/// under the given viewport: the cell maps into the rect through the node's
/// effective region, and the mapped position lands inside the region's clip.
///
/// Both the frame region (own clip/scroll excluded — the box's background and
/// border) and the content region (own clip/scroll included — its text, stream
/// and children) are tested, so a scrollable pane's frame stays hittable where
/// its own clip would reject content, while scrolled-out content is not.
pub(super) fn node_covers(scene: &Scene, id: NodeId, rect: Rect, col: i32, row: i32, viewport: Size) -> bool {
    hits_region(scene, id, rect, col, row, viewport, false)
        || hits_region(scene, id, rect, col, row, viewport, true)
}

/// The half of [`node_covers`] that tests one effective region variant. A
/// content cell at scene origin (`col + scroll`, `row + scroll`) maps to
/// buffer cell (`col`, `row`); the node covers the buffer cell iff that origin
/// lies in the rect and the mapped cell lies in the region's clip.
pub(super) fn hits_region(
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
pub(super) fn find_status_bar(scene: &Scene) -> Option<NodeId> {
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
pub(super) fn scene_absolute_rects(scene: &Scene, relative: Vec<(NodeId, Rect)>) -> HashMap<NodeId, Rect> {
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
pub(super) fn effective_region(scene: &Scene, id: NodeId, viewport: Size, include_own: bool) -> Region {
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

/// The smallest rect containing both `a` and `b`.
pub(super) fn rect_union(a: Rect, b: Rect) -> Rect {
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
pub(super) fn caret_cell_in(scene: &Scene, id: NodeId, rect: Rect, content: &Region, r: &Rect) -> bool {
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
pub(super) fn union_add(dirty: &mut Option<Rect>, region: Rect, viewport_rect: Rect) {
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
pub(super) fn union_add_mapped(
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
pub(super) fn painted_bounds_touch(rect: Rect, region: Region, u: &Rect) -> bool {
    let shifted = rect.offset(-region.scroll_x, -region.scroll_y);
    [shifted, rect].iter().any(|r| {
        region
            .clip
            .intersection(r)
            .and_then(|m| m.intersection(u))
            .is_some()
    })
}
