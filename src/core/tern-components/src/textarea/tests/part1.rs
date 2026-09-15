//! Part 1 of the the text area component tests.

use super::*;

#[test]
fn wrap_breaks_at_width_and_keeps_tokens_whole() {
    assert_eq!(wrap_line("hello world", 5), vec!["hello", "world"]);
    assert_eq!(wrap_line("hello world", 11), vec!["hello world"]);
    // A token wider than the width hard-breaks across rows.
    assert_eq!(wrap_line("abcdef", 3), vec!["abc", "def"]);
    // A space that fits stays on the row (trailing at the width).
    assert_eq!(wrap_line("ab cd", 3), vec!["ab ", "cd"]);
    // Empty and whitespace-only lines stay single display lines.
    assert_eq!(wrap_line("", 5), vec![""]);
    assert_eq!(wrap_line("  ", 3), vec!["  "]);
    // An embedded newline ends the display line.
    assert_eq!(wrap_line("a\nb", 5), vec!["a", "b"]);
    // A wide glyph is never split mid-glyph (it rides the row when it
    // fits; the trailing 'b' wraps whole).
    assert_eq!(wrap_line("aコb", 3), vec!["aコ", "b"]);
}

#[test]
fn wrap_line_strips_ansi_escapes() {
    // The golden contract: an escape-carrying line wraps identically to
    // its stripped form — escapes occupy no columns and never appear in a
    // display line.
    assert_eq!(wrap_line("\x1b[31mred\x1b[0m", 5), wrap_line("red", 5));
    assert_eq!(wrap_line("\x1b[31mred\x1b[0m", 5), vec!["red"]);
    // A colored token wider than the width hard-breaks on visible glyphs.
    assert_eq!(wrap_line("\x1b[31mabcdef\x1b[0m", 3), vec!["abc", "def"]);
    // A colored wide CJK glyph keeps its 2-column width; the wrap never
    // splits it (the trailing 'b' wraps whole, as for plain text).
    assert_eq!(wrap_line("\x1b[31maコ\x1b[0m", 3), vec!["aコ"]);
    assert_eq!(wrap_line("\x1b[31maコb\x1b[0m", 3), wrap_line("aコb", 3));
    // NUL / combining-mark behavior is unchanged by surrounding escapes
    // (the wrap treats a zero-width mark exactly as before).
    assert_eq!(wrap_line("\x1b[31me\u{301}\x1b[0m", 5), wrap_line("e\u{301}", 5));
    // Offsets are exact within the escape-free line.
    assert_eq!(
        wrap_line_with_offsets("\x1b[31mhello world\x1b[0m", 5),
        wrap_line_with_offsets("hello world", 5),
    );
}

#[test]
fn with_value_splits_lines_and_places_caret_at_end() {
    let ta = Textarea::with_value("ab\ncd");
    assert_eq!(ta.lines, vec!["ab", "cd"]);
    assert_eq!(ta.row, 1);
    assert_eq!(ta.col, 2);
    assert_eq!(ta.text(), "ab\ncd");
}

#[test]
fn insert_char_at_cursor_advances() {
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 0;
    ta.col = 1;
    ta.insert_char('X');
    assert_eq!(ta.lines, vec!["aXb", "cd"]);
    assert_eq!(ta.col, 2);
    // Inserting into an empty textarea works.
    let mut empty = Textarea::new();
    empty.insert_char('h');
    assert_eq!(empty.lines, vec!["h"]);
    assert_eq!(empty.col, 1);
}

#[test]
fn delete_backward_removes_and_joins_lines() {
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 1;
    ta.col = 1;
    ta.delete_backward();
    assert_eq!(ta.lines, vec!["ab", "d"]);
    assert_eq!(ta.col, 0);
    // At the start of a line the previous line is joined.
    let mut join = Textarea::with_value("ab\ncd");
    join.row = 1;
    join.col = 0;
    join.delete_backward();
    assert_eq!(join.lines, vec!["abcd"]);
    assert_eq!(join.row, 0);
    assert_eq!(join.col, 2); // the join point
                             // At the very start it is a no-op.
    let mut top = Textarea::with_value("x");
    top.row = 0;
    top.col = 0;
    top.delete_backward();
    assert_eq!(top.lines, vec!["x"]);
}

#[test]
fn delete_forward_removes_and_joins_next_line() {
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 0;
    ta.col = 1;
    ta.delete_forward();
    assert_eq!(ta.lines, vec!["a", "cd"]);
    // At the end of a line the next line is joined.
    let mut join = Textarea::with_value("ab\ncd");
    join.row = 0;
    join.col = 2;
    join.delete_forward();
    assert_eq!(join.lines, vec!["abcd"]);
    assert_eq!(join.row, 0);
    assert_eq!(join.col, 2);
    // At the very end it is a no-op.
    let mut bottom = Textarea::with_value("x");
    bottom.move_end();
    bottom.delete_forward();
    assert_eq!(bottom.lines, vec!["x"]);
}

#[test]
fn enter_splits_the_line_and_places_cursor_at_the_tail() {
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 0;
    ta.col = 1;
    ta.split_line();
    assert_eq!(ta.lines, vec!["a", "b", "cd"]);
    assert_eq!(ta.row, 1);
    assert_eq!(ta.col, 0);
    // Splitting an empty line makes a new blank line.
    let mut blank = Textarea::new();
    blank.split_line();
    assert_eq!(blank.lines, vec!["", ""]);
    assert_eq!(blank.row, 1);
    assert_eq!(blank.col, 0);
}

#[test]
fn handle_key_maps_edits_and_actions() {
    let mut ta = Textarea::with_value("hi");
    assert_eq!(ta.handle_key(Key::Char('!')), KeyAction::None);
    assert_eq!(ta.lines, vec!["hi!"]);
    assert_eq!(ta.handle_key(Key::Enter), KeyAction::None); // an edit, not a submit
    assert_eq!(ta.lines, vec!["hi!", ""]);
    assert_eq!(ta.row, 1);
    assert_eq!(ta.handle_key(Key::Backspace), KeyAction::None); // joins the blank line
    assert_eq!(ta.lines, vec!["hi!"]);
    assert_eq!(ta.handle_key(Key::Escape), KeyAction::Cancel);
    assert_eq!(ta.handle_key(Key::Tab), KeyAction::None);
}

#[test]
fn left_right_home_end_navigate_with_wrap_around() {
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 1;
    ta.col = 0;
    ta.move_left(); // wraps to the end of the previous line
    assert_eq!((ta.row, ta.col), (0, 2));
    ta.move_right(); // wraps to the start of the next line
    assert_eq!((ta.row, ta.col), (1, 0));
    ta.move_end();
    assert_eq!((ta.row, ta.col), (1, 2));
    ta.move_home();
    assert_eq!((ta.row, ta.col), (1, 0));
    // Moving left walks back across the lines to the very start, then
    // sticks.
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 2));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 1));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 0));
    ta.move_left();
    assert_eq!((ta.row, ta.col), (0, 0));
}

#[test]
fn up_down_traverse_soft_wrapped_display_lines() {
    // "hello world" wraps at width 5 into display lines "hello" / "world"
    // (the space at the wrap point is dropped); the caret at the end sits
    // at display col 5 of the second display line.
    let mut ta = Textarea::with_value("hello world").with_width(5);
    assert_eq!(ta.wrapped(0), vec!["hello", "world"]);
    assert_eq!(ta.caret_display_row(), 1);
    ta.move_up();
    assert_eq!((ta.row, ta.col), (0, 5)); // end of "hello" — col 5 preserved
    ta.move_down();
    assert_eq!((ta.row, ta.col), (0, 11)); // back to the end
                                           // At the top the move sticks.
    ta.move_up();
    ta.move_up();
    assert_eq!((ta.row, ta.col), (0, 5));
    // At the bottom it sticks too.
    ta.move_end();
    ta.move_down();
    assert_eq!((ta.row, ta.col), (0, 11));
}

#[test]
fn up_down_move_between_logical_lines_at_wrap_points() {
    // Each line wraps into two display lines at width 5 ("alpha" / "beta",
    // "gamma" / "delta" — the space at each wrap point is dropped).
    let mut ta = Textarea::with_value("alpha beta\ngamma delta").with_width(5);
    assert_eq!(ta.total_display_rows(), 4);
    // From the end of "delta" (display row 3, display col 5) move up: the
    // preferred column (5) is preserved, clamping at each shorter line.
    ta.move_up();
    assert_eq!((ta.row, ta.col), (1, 5)); // end of "gamma"
    ta.move_up();
    assert_eq!((ta.row, ta.col), (0, 10)); // end of "beta"
    ta.move_up();
    assert_eq!((ta.row, ta.col), (0, 5)); // end of "alpha"
                                          // Down again lands back on the preserved column.
    ta.move_down();
    assert_eq!((ta.row, ta.col), (0, 10));
}

#[test]
fn preferred_column_is_preserved_across_a_vertical_run() {
    // Two display lines under the first logical line plus a one-line
    // second line; the caret starts at the end of "gamma" (display row 2).
    let mut ta = Textarea::with_value("alpha beta\ngamma").with_width(5);
    ta.move_up(); // preferred col 5 -> clamped to the end of "beta"
    assert_eq!((ta.row, ta.col), (0, 10));
    ta.move_down(); // col 5 still sticky -> back to the end of "gamma"
    assert_eq!((ta.row, ta.col), (1, 5));
    // A horizontal move resets the sticky column; the next vertical move
    // re-captures it (0 here, from the line start).
    ta.move_home();
    ta.move_up(); // preferred col 0 -> the start of "beta"
    assert_eq!((ta.row, ta.col), (0, 6));
}

#[test]
fn scroll_to_caret_keeps_the_caret_inside_the_window() {
    let mut ta = Textarea::with_value("1\n2\n3\n4\n5").with_height(2);
    ta.row = 0;
    ta.col = 0;
    assert_eq!(ta.scroll, 0);
    ta.move_down(); // (1,0) — display row 1, visible in the window [0,2)
    assert_eq!(ta.scroll, 0);
    ta.move_down(); // (2,0) — below the window -> scroll 1 (window [1,3))
    assert_eq!(ta.scroll, 1);
    ta.move_up(); // (1,0) — still inside the window -> scroll stays 1
    assert_eq!(ta.scroll, 1);
    ta.move_up(); // (0,0) — above the window -> scroll 0
    assert_eq!(ta.scroll, 0);
    // No height: everything is shown, scroll stays 0.
    let mut open = Textarea::with_value("1\n2\n3\n4\n5");
    open.move_down();
    open.move_down();
    assert_eq!(open.scroll, 0);
}

#[test]
fn materialize_creates_one_leaf_per_display_line_with_caret() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ta = Textarea::with_value("ab\ncd");
    ta.row = 1;
    let id = Renderable::from(ta).materialize(&mut scene, root);

    assert_eq!(scene.node(id).unwrap().kind, NodeKind::Box);
    assert_eq!(
        scene.node(id).unwrap().props.get("flex_direction"),
        Some(&PropValue::Str("column".to_string()))
    );
    let children = scene.children(id).unwrap();
    assert_eq!(children.len(), 2);
    // Line 0 has no caret; line 1 (the caret's line) carries it.
    assert_eq!(
        scene.prop(children[0], "text"),
        Some(&PropValue::Str("ab".to_string()))
    );
    assert!(scene.prop(children[0], "caret").is_none());
    assert_eq!(
        scene.prop(children[1], "text"),
        Some(&PropValue::Str("cd".to_string()))
    );
    assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(2)));
}

#[test]
fn materialize_wraps_long_lines_into_multiple_leaves() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ta = Textarea::with_value("hello world").with_width(5);
    ta.row = 0;
    let id = Renderable::from(ta).materialize(&mut scene, root);
    let children = scene.children(id).unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(
        scene.prop(children[0], "text"),
        Some(&PropValue::Str("hello".to_string()))
    );
    assert_eq!(
        scene.prop(children[1], "text"),
        Some(&PropValue::Str("world".to_string()))
    );
    // The caret (end of "hello world") sits at display col 5 of "world".
    assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(5)));
    assert!(scene.prop(children[0], "caret").is_none());
    // Each leaf is sized to the wrap width.
    assert_eq!(scene.prop(children[0], "width"), Some(&PropValue::Int(5)));
}

#[test]
fn materialize_only_paints_the_visible_window() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ta = Textarea::with_value("1\n2\n3\n4\n5").with_height(2);
    ta.scroll = 2;
    ta.row = 3;
    let id = Renderable::from(ta).materialize(&mut scene, root);
    let children = scene.children(id).unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(
        scene.prop(children[0], "text"),
        Some(&PropValue::Str("3".to_string()))
    );
    assert_eq!(
        scene.prop(children[1], "text"),
        Some(&PropValue::Str("4".to_string()))
    );
    assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(1)));
}

#[test]
fn hidden_caret_paints_no_caret_prop() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ta = Textarea::with_value("ab\ncd").hide_caret();
    ta.row = 1;
    let id = Renderable::from(ta).materialize(&mut scene, root);
    let children = scene.children(id).unwrap();
    assert!(scene.prop(children[1], "caret").is_none());
}
