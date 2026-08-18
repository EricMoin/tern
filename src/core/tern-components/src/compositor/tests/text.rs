use super::*;

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
