//! Part 2 of the the text area component tests.

use super::*;

#[test]
fn paint_renders_lines_with_reversed_block_caret() {
    // A root textarea fills the viewport; padding 1 puts the leaves at
    // row 1; the caret (display col 2 on the second line) paints the
    // reversed block caret over the cell at (3,2).
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(
        Textarea::with_value("ab\ncd").with_height(2),
        tern_core::Size::new(6, 4),
    );
    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
    assert_eq!(buffer.cell(2, 1).unwrap().ch, 'b');
    assert_eq!(buffer.cell(1, 2).unwrap().ch, 'c');
    assert_eq!(buffer.cell(2, 2).unwrap().ch, 'd');
    let caret = buffer.cell(3, 2).unwrap();
    assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
    // The first line's cells are not reversed.
    assert!(!buffer
        .cell(2, 1)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}

#[test]
fn paint_wraps_long_content_and_keeps_caret_visible() {
    // "hello world" wraps at the 4-cell text area (6-wide viewport minus
    // padding) into "hell" / "o wo" / "rld"; the caret at the end sits at
    // display col 3 of the last row.
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(
        Textarea::with_value("hello world"),
        tern_core::Size::new(6, 6),
    );
    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'h');
    assert_eq!(buffer.cell(1, 2).unwrap().ch, 'o');
    assert_eq!(buffer.cell(3, 2).unwrap().ch, 'w');
    assert_eq!(buffer.cell(1, 3).unwrap().ch, 'r');
    let caret = buffer.cell(4, 3).unwrap();
    assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
}

#[test]
fn left_right_step_whole_grapheme_clusters() {
    let mut ta = Textarea::with_value(&format!("a{FAMILY}e\u{301}b"));
    assert_eq!(ta.lines[0].chars().count(), 11);
    ta.move_end();
    assert_eq!((ta.row, ta.col), (0, 11));
    // Left steps whole clusters: past 'b', past the whole "e\u{301}"
    // cluster, past the whole ZWJ emoji, to the start.
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 10));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 8));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 1));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 0));
    ta.move_left(); // sticks at the start
    assert_eq!((ta.row, ta.col), (0, 0));
    // Right walks back cluster by cluster to the end.
    ta.move_right();
    assert_eq!((ta.row, ta.col), (0, 1));
    ta.move_right();
    assert_eq!((ta.row, ta.col), (0, 8));
    ta.move_right();
    assert_eq!((ta.row, ta.col), (0, 10));
    ta.move_right();
    assert_eq!((ta.row, ta.col), (0, 11));
}

#[test]
fn delete_backward_removes_whole_clusters() {
    let mut ta = Textarea::with_value(&format!("a{FAMILY}e\u{301}b"));
    ta.move_end();
    ta.delete_backward();
    assert_eq!(ta.lines, vec![format!("a{FAMILY}e\u{301}")]);
    assert_eq!(ta.col, 10);
    ta.delete_backward();
    assert_eq!(ta.lines, vec![format!("a{FAMILY}")]);
    assert_eq!(ta.col, 8);
    ta.delete_backward();
    assert_eq!(ta.lines, vec!["a"]);
    assert_eq!(ta.col, 1);
    ta.delete_backward();
    assert_eq!(ta.lines, vec![""]);
    assert_eq!(ta.col, 0);
}

#[test]
fn delete_forward_removes_whole_clusters() {
    // The ZWJ emoji vanishes whole with one delete.
    let mut ta = Textarea::with_value(&format!("a{FAMILY}e\u{301}b"));
    ta.col = 1;
    ta.delete_forward();
    assert_eq!(ta.lines, vec!["ae\u{301}b"]);
    assert_eq!(ta.col, 1);
    // The combining sequence vanishes whole too.
    let mut ta = Textarea::with_value(&format!("a{FAMILY}e\u{301}b"));
    ta.col = 8;
    ta.delete_forward();
    assert_eq!(ta.lines, vec![format!("a{FAMILY}b")]);
    assert_eq!(ta.col, 8);
}

#[test]
fn caret_display_col_sums_cluster_widths() {
    // "ab" (2 cols) + the ZWJ emoji (2 cols) = display col 4, not the 9
    // a per-char width sum would give.
    let mut emoji = Textarea::with_value(&format!("ab{FAMILY}"));
    emoji.move_end();
    assert_eq!(emoji.current_display_col(), 4);
    // The combining sequence renders at its base's width: 2 cols.
    let mut combining = Textarea::with_value("e\u{301}x");
    combining.move_end();
    assert_eq!(combining.current_display_col(), 2);
    // Wide glyphs keep their 2-column width.
    let mut wide = Textarea::with_value("aコb");
    wide.move_end();
    assert_eq!(wide.current_display_col(), 4);
}

#[test]
fn materialize_caret_prop_uses_cluster_width() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ta = Textarea::with_value(&format!("ab{FAMILY}"));
    ta.move_end();
    let id = Renderable::from(ta).materialize(&mut scene, root);
    let children = scene.children(id).unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(scene.prop(children[0], "caret"), Some(&PropValue::Int(4)));
}

#[test]
fn split_line_never_cuts_a_cluster() {
    let mut ta = Textarea::with_value(&format!("ab{FAMILY}c"));
    ta.col = 2; // on the boundary before the emoji
    ta.split_line();
    assert_eq!(ta.lines, vec!["ab".to_string(), format!("{FAMILY}c")]);
    assert_eq!(ta.row, 1);
    assert_eq!(ta.col, 0);
}
