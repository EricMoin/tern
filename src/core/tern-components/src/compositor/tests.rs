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


