use super::*;

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
