//! Tests for the single-line input component.

use super::*;

use tern_core::scene::NodeKind;

use tern_core::style::Modifiers;

#[test]
fn insert_char_at_cursor_advances() {
    let mut input = Input::with_value("ab");
    input.cursor = 1;
    input.insert_char('X');
    assert_eq!(input.value, "aXb");
    assert_eq!(input.cursor, 2);

    // Multi-width content: コ counts as one char index; inserting at the
    // head lands before it.
    let mut wide = Input::with_value("コ");
    wide.cursor = 0;
    wide.insert_char('x');
    assert_eq!(wide.value, "xコ");
    assert_eq!(wide.cursor, 1);
}

#[test]
fn delete_backward_and_forward() {
    let mut input = Input::with_value("abc");
    input.cursor = 2;
    input.delete_backward();
    assert_eq!(input.value, "ac");
    assert_eq!(input.cursor, 1);

    input.cursor = 1;
    input.delete_forward();
    assert_eq!(input.value, "a");

    // At the boundaries the deletes are no-ops.
    let mut at_start = Input::with_value("x");
    at_start.cursor = 0;
    at_start.delete_backward();
    assert_eq!(at_start.value, "x");
    let mut at_end = Input::with_value("x");
    at_end.cursor = 1;
    at_end.delete_forward();
    assert_eq!(at_end.value, "x");
}

#[test]
fn clear_resets_value_and_cursor() {
    let mut input = Input::with_value("hello");
    input.cursor = 3;
    input.clear();
    assert!(input.value.is_empty());
    assert_eq!(input.cursor, 0);
}

#[test]
fn arrow_keys_move_cursor_clamped() {
    let mut input = Input::with_value("abc");
    input.cursor = 0;
    input.move_left(); // clamped at 0
    assert_eq!(input.cursor, 0);
    input.move_right();
    assert_eq!(input.cursor, 1);
    input.move_end();
    assert_eq!(input.cursor, 3);
    input.move_right(); // clamped at 3
    assert_eq!(input.cursor, 3);
    input.move_home();
    assert_eq!(input.cursor, 0);
}

#[test]
fn word_jumps_skip_whitespace_and_words() {
    let mut input = Input::with_value("one two three");
    input.move_end();
    input.word_left();
    assert_eq!(input.cursor, 8); // start of "three"
    input.word_left();
    assert_eq!(input.cursor, 4); // start of "two"
    input.word_left();
    assert_eq!(input.cursor, 0); // start of "one"

    input.cursor = 0;
    input.word_right();
    assert_eq!(input.cursor, 3); // just past "one"
    input.word_right();
    assert_eq!(input.cursor, 7); // just past "two"

    // Runs of whitespace are skipped as one step.
    let mut gap = Input::with_value("a   b");
    gap.move_end();
    gap.word_left();
    assert_eq!(gap.cursor, 4); // start of "b", skipping the gap
}

#[test]
fn display_col_is_multi_width_aware() {
    let mut input = Input::with_value("aコb");
    input.cursor = 2; // after コ
    assert_eq!(input.display_col(), 3); // 'a'(1) + コ(2)
    input.cursor = 3;
    assert_eq!(input.display_col(), 4);
}

#[test]
fn cursor_movement_steps_whole_clusters() {
    // A ZWJ family emoji (7 chars) is ONE cluster: left/right step over
    // it in a single move, never per char.
    let mut input = Input::with_value("a👨‍👩‍👧‍👦b");
    input.move_end();
    assert_eq!(input.cursor, 9); // a + 7-char emoji + b
    input.move_left();
    assert_eq!(input.cursor, 8); // before 'b'
    input.move_left();
    assert_eq!(input.cursor, 1); // the whole emoji in one step
    input.move_left();
    assert_eq!(input.cursor, 0);
    input.move_right();
    assert_eq!(input.cursor, 1); // the emoji is one step again
    input.move_right();
    assert_eq!(input.cursor, 8);
    input.move_right();
    assert_eq!(input.cursor, 9);

    // A combining sequence (e + U+0301) is one cluster too.
    let mut comb = Input::with_value("e\u{301}x");
    comb.move_end();
    assert_eq!(comb.cursor, 3);
    comb.move_left();
    assert_eq!(comb.cursor, 2); // whole "é" skipped
    comb.move_left();
    assert_eq!(comb.cursor, 0);
    comb.move_right();
    assert_eq!(comb.cursor, 2); // whole "é" in one step
}

#[test]
fn flag_and_keycap_step_as_single_clusters() {
    // A flag (2 regional indicators) is one cluster: 2 chars, one step.
    let mut flag = Input::with_value("🇷🇺");
    flag.move_end();
    assert_eq!(flag.cursor, 2);
    flag.move_left();
    assert_eq!(flag.cursor, 0); // whole flag stepped as one unit
    flag.move_right();
    assert_eq!(flag.cursor, 2);

    // A keycap ('1' + VS16 + enclosing keycap) is one cluster too.
    let mut keycap = Input::with_value("1️⃣");
    keycap.move_end();
    assert_eq!(keycap.cursor, 3);
    keycap.move_left();
    assert_eq!(keycap.cursor, 0);
    keycap.move_right();
    assert_eq!(keycap.cursor, 3);
}

#[test]
fn backspace_deletes_whole_cluster() {
    let mut family = Input::with_value("a👨‍👩‍👧‍👦b");
    family.move_end();
    family.delete_backward(); // deletes 'b'
    assert_eq!(family.value, "a👨‍👩‍👧‍👦");
    family.delete_backward(); // deletes the whole emoji cluster
    assert_eq!(family.value, "a");
    assert_eq!(family.cursor, 1);

    // A combining sequence is removed whole.
    let mut comb = Input::with_value("e\u{301}x");
    comb.move_end();
    comb.delete_backward(); // deletes 'x'
    assert_eq!(comb.value, "e\u{301}");
    comb.delete_backward(); // deletes the whole combining cluster
    assert_eq!(comb.value, "");
    assert_eq!(comb.cursor, 0);
}

#[test]
fn delete_forward_deletes_whole_cluster() {
    let mut family = Input::with_value("a👨‍👩‍👧‍👦b");
    family.cursor = 1;
    family.delete_forward(); // deletes the whole emoji cluster
    assert_eq!(family.value, "ab");
    assert_eq!(family.cursor, 1);

    let mut comb = Input::with_value("e\u{301}x");
    comb.cursor = 0;
    comb.delete_forward();
    assert_eq!(comb.value, "x");
    assert_eq!(comb.cursor, 0);
}

#[test]
fn display_col_measures_cluster_width_not_char_sum() {
    // A ZWJ family emoji is 7 chars but renders in 2 columns: the caret
    // after it sits at column 2, NOT 14 (7 × char_width 2).
    let mut family = Input::with_value("👨‍👩‍👧‍👦");
    assert_eq!(family.value.chars().count(), 7);
    family.move_end();
    assert_eq!(family.display_col(), 2);
    assert_eq!(family.cursor, 7);

    // 'a' + emoji = 1 + 2 = 3 columns; then 'b' makes 4.
    let mut mixed = Input::with_value("a👨‍👩‍👧‍👦b");
    mixed.cursor = 8; // after the emoji, before 'b'
    assert_eq!(mixed.display_col(), 3);
    mixed.move_end();
    assert_eq!(mixed.display_col(), 4);

    // A flag is 2 columns; a combining sequence is 1 (base + zero-width
    // mark); a keycap is 1 per tern-core's cluster model ('1' + two
    // zero-width modifiers).
    let mut flag = Input::with_value("🇷🇺");
    flag.move_end();
    assert_eq!(flag.display_col(), 2);
    let mut comb = Input::with_value("e\u{301}");
    comb.move_end();
    assert_eq!(comb.display_col(), 1);
    let mut keycap = Input::with_value("1️⃣");
    keycap.move_end();
    assert_eq!(keycap.display_col(), 1);
}

#[test]
fn word_jumps_respect_cluster_boundaries() {
    // "hey 👨👩👧👦 you": the ZWJ emoji is a whole word unit — word
    // jumps land on its boundaries, never inside it.
    let mut input = Input::with_value("hey 👨‍👩‍👧‍👦 you");
    input.move_end();
    input.word_left();
    assert_eq!(input.cursor, 12); // start of "you"
    input.word_left();
    assert_eq!(input.cursor, 4); // start of the emoji, not inside it
    input.word_left();
    assert_eq!(input.cursor, 0); // start of "hey"
    input.word_right();
    assert_eq!(input.cursor, 3); // just past "hey"
    input.word_right();
    assert_eq!(input.cursor, 11); // just past the emoji — skipped whole
    input.word_right();
    assert_eq!(input.cursor, 15); // just past "you" = end
}

#[test]
fn insert_never_lands_inside_a_cluster() {
    // A cursor parked mid-cluster snaps to the cluster start: the emoji
    // is never split, the char lands before it.
    let mut input = Input::with_value("a👨‍👩‍👧‍👦b");
    input.cursor = 4; // inside the emoji (its 3rd char)
    input.insert_char('X');
    assert_eq!(input.value, "aX👨‍👩‍👧‍👦b");
    assert_eq!(input.cursor, 2);

    // A mid-combining-sequence cursor snaps the same way.
    let mut comb = Input::with_value("e\u{301}");
    comb.cursor = 1; // between 'e' and the combining mark
    comb.insert_char('x');
    assert_eq!(comb.value, "xe\u{301}");
    assert_eq!(comb.cursor, 1);
}

#[test]
fn handle_key_maps_edits_and_actions() {
    let mut input = Input::new();
    assert_eq!(input.handle_key(Key::Char('h')), KeyAction::None);
    assert_eq!(input.handle_key(Key::Char('i')), KeyAction::None);
    assert_eq!(input.value, "hi");
    assert_eq!(input.cursor, 2);

    input.handle_key(Key::Left);
    input.handle_key(Key::Backspace);
    assert_eq!(input.value, "i");
    assert_eq!(input.cursor, 0);

    input.handle_key(Key::End);
    input.handle_key(Key::Delete); // no-op at end
    assert_eq!(input.value, "i");

    assert_eq!(input.handle_key(Key::Enter), KeyAction::Submit);
    assert_eq!(input.handle_key(Key::Escape), KeyAction::Cancel);
    assert_eq!(input.handle_key(Key::Tab), KeyAction::None);
    assert_eq!(input.handle_key(Key::Up), KeyAction::None);
}

#[test]
fn history_browsing_saves_draft_and_restores() {
    let mut input = Input::with_value("draft").history_capacity(10);
    input.push_history("first".to_string());
    input.push_history("second".to_string());

    input.value = "in-progress".to_string();
    input.cursor = 11;
    input.history_up();
    assert_eq!(input.value, "second");
    assert!(input.browsing_history());
    input.history_up();
    assert_eq!(input.value, "first");
    input.history_up(); // sticks at the oldest
    assert_eq!(input.value, "first");

    input.history_down();
    assert_eq!(input.value, "second");
    input.history_down();
    assert_eq!(input.value, "in-progress"); // draft restored
    assert!(!input.browsing_history());
}

#[test]
fn history_ring_is_bounded_and_dedupes() {
    let mut input = Input::new().history_capacity(3);
    input.push_history("a".to_string());
    input.push_history("b".to_string());
    input.push_history("a".to_string()); // not adjacent dup of "b" -> kept
    assert_eq!(input.history_len(), 3);
    input.push_history("a".to_string()); // exact repeat of newest -> ignored
    assert_eq!(input.history_len(), 3);
    input.push_history("c".to_string()); // ring full -> oldest ("a") drops
    assert_eq!(input.history_len(), 3);

    input.history_up();
    assert_eq!(input.value, "c");
    input.history_up();
    assert_eq!(input.value, "a");
    input.history_up();
    assert_eq!(input.value, "b"); // the oldest kept entry
}

#[test]
fn history_reset_restores_draft() {
    let mut input = Input::with_value("draft");
    input.push_history("entry".to_string());
    input.value = "edited".to_string();
    input.cursor = 6;
    input.history_up(); // draft is saved as "edited"
    assert_eq!(input.value, "entry");
    assert!(input.browsing_history());
    input.history_reset();
    assert_eq!(input.value, "edited"); // the draft, not the pre-edit value
    assert!(!input.browsing_history());
}

#[test]
fn editing_exits_history_browsing() {
    let mut input = Input::with_value("draft");
    input.push_history("entry".to_string());
    input.history_up();
    assert!(input.browsing_history());
    input.insert_char('x');
    assert!(!input.browsing_history());
    assert_eq!(input.value, "entryx");
}

#[test]
fn placeholder_shows_when_empty_and_style_dims() {
    let input = Input::new().placeholder("ask");
    assert_eq!(input.visible_region().0, "ask");
    assert!(input.text_style().modifiers.contains(Modifiers::DIM));

    let filled = Input::with_value("hi");
    assert_eq!(filled.visible_region().0, "hi");
    assert!(!filled.text_style().modifiers.contains(Modifiers::DIM));
}

#[test]
fn caret_sits_at_display_column() {
    let input = Input::with_value("ab");
    assert_eq!(input.visible_region(), ("ab".to_string(), 2));

    let mut wide = Input::with_value("コx");
    wide.cursor = 1;
    assert_eq!(wide.visible_region(), ("コx".to_string(), 2));
}

#[test]
fn narrow_field_scrolls_to_keep_caret_visible() {
    let mut input = Input::with_value("hello").with_width(3);
    input.move_end(); // caret at display col 5
    assert_eq!(input.scroll(), 3);
    assert_eq!(input.visible_region(), ("lo".to_string(), 2));

    // The scroll boundary never splits a wide glyph: the visible slice
    // always starts at a char boundary. caret at col 6 in "abコde" (cols
    // a=0 b=1 コ=2-3 d=4 e=5) with a 3-wide area scrolls to col 4, which
    // lands on 'd' — コ is scrolled fully out of view, not truncated.
    let mut wide = Input::with_value("abコde").with_width(3);
    wide.cursor = 5; // display col 6 -> scroll = 6 + 1 - 3 = 4 ('d')
    assert_eq!(wide.visible_region(), ("de".to_string(), 2));
}

#[test]
fn narrow_field_scroll_never_splits_a_cluster() {
    // "ab👨👩👧👦c" (cols a=0 b=1 emoji=2-3 c=4) in a 3-wide area with
    // the caret at the end: scroll = 5 + 1 - 3 = 3, which lands INSIDE
    // the emoji's column range. The emoji is scrolled fully out of view
    // — never split — and the visible slice starts at 'c'.
    let mut input = Input::with_value("ab👨‍👩‍👧‍👦c").with_width(3);
    input.move_end();
    assert_eq!(input.display_col(), 5);
    assert_eq!(input.scroll(), 3);
    assert_eq!(input.visible_region(), ("c".to_string(), 1));
}

#[test]
fn materialize_stamps_text_and_caret_props() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let input = Input::with_value("ab");
    let id: NodeId = Renderable::from(input).materialize(&mut scene, root);

    assert_eq!(scene.node(id).unwrap().kind, NodeKind::Box);
    assert_eq!(
        scene.node(id).unwrap().props.get("padding"),
        Some(&PropValue::Int(1))
    );
    let text_id = scene.children(id).unwrap()[0];
    assert_eq!(
        scene.prop(text_id, "text"),
        Some(&PropValue::Str("ab".to_string()))
    );
    assert_eq!(scene.prop(text_id, "caret"), Some(&PropValue::Int(2)));

    // Hidden caret -> no caret prop at all.
    let hidden = Input::with_value("ab").hide_caret();
    let mut scene2 = Scene::new();
    let root2 = scene2.root_id();
    let id2 = Renderable::from(hidden).materialize(&mut scene2, root2);
    let text2 = scene2.children(id2).unwrap()[0];
    assert!(scene2.prop(text2, "caret").is_none());
}

#[test]
fn materialize_sets_width_prop_when_constrained() {
    let input = Input::with_value("hello").with_width(3);
    let mut scene = Scene::new();
    let root = scene.root_id();
    let id = Renderable::from(input).materialize(&mut scene, root);
    let text_id = scene.children(id).unwrap()[0];
    assert_eq!(scene.prop(text_id, "width"), Some(&PropValue::Int(3)));
    assert_eq!(
        scene.prop(text_id, "text"),
        Some(&PropValue::Str("lo".to_string()))
    );
}

#[test]
fn paint_renders_value_with_reversed_block_caret() {
    // A root Input fills the viewport with its 1-cell padding frame; the
    // text leaf lands at (1,1), and the caret (display col 2) paints the
    // reversed block caret over the cell at (3,1).
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(Input::with_value("ab"), tern_core::Size::new(6, 3));
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
fn paint_renders_dimmed_placeholder_with_caret_at_head() {
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(Input::new().placeholder("ask"), tern_core::Size::new(6, 3));
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
fn paint_with_hidden_caret_paints_no_block() {
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(
        Input::with_value("ab").hide_caret(),
        tern_core::Size::new(6, 3),
    );
    for x in 0..6 {
        let c = buffer.cell(x, 1).unwrap();
        assert!(!c.style.modifiers.contains(Modifiers::REVERSED));
    }
    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
}

#[test]
fn paint_narrow_field_scrolls_content_and_caret() {
    // A root input in a 6-wide viewport has a 4-cell text area; with the
    // caret at the end of "hello" the content scrolls left so the caret
    // stays visible: "llo" paints with the caret after the last 'o'.
    let mut input = Input::with_value("hello");
    input.move_end();
    let mut compositor = crate::compositor::Compositor::new();
    let buffer = compositor.paint(input, tern_core::Size::new(6, 3));
    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'l');
    assert_eq!(buffer.cell(3, 1).unwrap().ch, 'o');
    let caret = buffer.cell(4, 1).unwrap();
    assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
}
