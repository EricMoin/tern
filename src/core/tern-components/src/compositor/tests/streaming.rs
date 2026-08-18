use super::*;

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
