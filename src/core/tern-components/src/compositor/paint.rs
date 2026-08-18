//! Node/box paint primitives and border glyph sets.

use super::*;

/// Paint a single node into its laid-out rect, drawing its frame through
/// `frame` (box background/border) and its content through `content` (text,
/// stream spans).
pub(super) fn paint_node(
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
pub(super) fn parent_clip_right(scene: &Scene, node: &SceneNode, rects: &HashMap<NodeId, Rect>) -> Option<i32> {
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
pub(super) fn paint_box(node: &SceneNode, rect: Rect, region: Region, buffer: &mut Buffer) {
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

/// The concrete glyph set for a border style: top-left, top-right,
/// bottom-left, bottom-right corners, horizontal edge, vertical edge.
///
/// `Rounded` maps to the light box-drawing set `┌┐└┘─│` — the exact glyphs
/// pinned by the tern-components MVP acceptance (golden buffer test).
pub(super) fn border_glyphs(style: BorderStyle) -> Option<(char, char, char, char, char, char)> {
    match style {
        BorderStyle::None => None,
        BorderStyle::Plain => Some(('+', '+', '+', '+', '-', '|')),
        BorderStyle::Rounded => Some(('┌', '┐', '└', '┘', '─', '│')),
        BorderStyle::Double => Some(('╔', '╗', '╚', '╝', '═', '║')),
        BorderStyle::Thick => Some(('┏', '┓', '┗', '┛', '━', '┃')),
    }
}
