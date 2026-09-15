//! Diffing and region extraction.

use super::*;

#[test]
fn resize_grow_preserves_content() {
    let mut b = Buffer::new(2, 1);
    b.set_string(0, 0, "ab", Style::new());
    b.resize(4, 2);
    assert_eq!(b.width, 4);
    assert_eq!(b.height, 2);
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert_eq!(b.cell(2, 0).unwrap(), &Cell::default());
    assert_eq!(b.cell(0, 1).unwrap(), &Cell::default());
}

#[test]
fn resize_shrink_drops_content() {
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "abcd", Style::new());
    b.resize(2, 1);
    assert_eq!(b.width, 2);
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
}

#[test]
fn resize_truncates_wide_char_at_right_edge() {
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "コ", Style::new()); // cols 0-1
    b.set_string(2, 0, "xy", Style::new());
    assert_eq!(b.cell(0, 0).unwrap().ch, 'コ');

    b.resize(2, 1); // コ still fits (cols 0-1)
    assert_eq!(b.cell(0, 0).unwrap().ch, 'コ');
    assert_eq!(b.cell(0, 0).unwrap().width, 2);
    assert_eq!(b.cell(1, 0).unwrap().width, 0);

    b.resize(1, 1); // コ no longer fits → dropped, no orphan half-width lead
    assert_eq!(b.cell(0, 0).unwrap(), &Cell::default());
    assert_eq!(b.cell(0, 0).unwrap().width, 1);
}

#[test]
fn resize_noop_same_size_keeps_content() {
    let mut b = Buffer::new(3, 2);
    b.set_string(1, 1, "z", Style::new());
    b.resize(3, 2);
    assert_eq!(b.cell(1, 1).unwrap().ch, 'z');
}

#[test]
fn clear_resets_all_cells() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abc", Style::new());
    b.clear();
    for x in 0..3 {
        assert_eq!(b.cell(x, 0), Some(&Cell::default()));
    }
}

#[test]
fn clear_rect_resets_only_inside_rect() {
    let mut b = Buffer::new(5, 3);
    for y in 0..3 {
        for x in 0..5 {
            b.set_char(x as u16, y as u16, 'x', Style::new());
        }
    }
    b.clear_rect(Rect::new(1, 1, 2, 1));
    // Inside the rect: blank.
    assert_eq!(b.cell(1, 1).unwrap(), &Cell::default());
    assert_eq!(b.cell(2, 1).unwrap(), &Cell::default());
    // Outside the rect: untouched.
    assert_eq!(b.cell(0, 1).unwrap().ch, 'x');
    assert_eq!(b.cell(3, 1).unwrap().ch, 'x');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'x');
    assert_eq!(b.cell(1, 2).unwrap().ch, 'x');
    // A rect wholly outside the buffer is a no-op.
    b.clear_rect(Rect::new(10, 10, 2, 2));
    assert_eq!(b.cell(4, 2).unwrap().ch, 'x');
}

#[test]
fn copy_region_copies_rect_from_source() {
    let mut src = Buffer::new(4, 2);
    src.set_string(1, 0, "ab", Style::new().add_modifier(Modifiers::BOLD));
    src.set_string(2, 1, "cd", Style::new().add_modifier(Modifiers::DIM));
    let mut dst = Buffer::new(4, 2);
    for y in 0..2 {
        for x in 0..4 {
            dst.set_char(x as u16, y as u16, '.', Style::new());
        }
    }
    dst.copy_region(&src, Rect::new(1, 0, 2, 1));
    // The copied region holds the source cells verbatim (ch + style).
    assert_eq!(dst.cell(1, 0).unwrap().ch, 'a');
    assert!(dst
        .cell(1, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::BOLD));
    assert_eq!(dst.cell(2, 0).unwrap().ch, 'b');
    // Cells outside the region keep their destination values.
    assert_eq!(dst.cell(0, 0).unwrap().ch, '.');
    assert_eq!(dst.cell(3, 0).unwrap().ch, '.');
    assert_eq!(dst.cell(1, 1).unwrap().ch, '.');
    // A rect clipped to the buffer bounds copies only the overlap: the
    // region (1,0,4,2) overlaps dst2's single column 1, so src's 'a'
    // (at src col 1) lands at dst2 col 1 and col 0 stays blank.
    let mut dst2 = Buffer::new(2, 1);
    dst2.copy_region(&src, Rect::new(1, 0, 4, 2));
    assert_eq!(dst2.cell(0, 0).unwrap().ch, ' ');
    assert_eq!(dst2.cell(1, 0).unwrap().ch, 'a');
}

#[test]
fn text_in_extracts_rows_joined_by_newline() {
    // Two rows of exact-width content: each row's cells contribute their
    // characters and the rows are joined with '\n'.
    let mut b = Buffer::new(3, 2);
    b.set_string(0, 0, "abc", Style::new());
    b.set_string(0, 1, "def", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 3, 2)), "abc\ndef");
}

#[test]
fn text_in_partial_rect_windows_into_the_buffer() {
    // A sub-rect picks a window: cols 1..4 of row 0.
    let mut b = Buffer::new(5, 1);
    b.set_string(0, 0, "hello", Style::new());
    assert_eq!(b.text_in(Rect::new(1, 0, 3, 1)), "ell");
}

#[test]
fn text_in_preserves_trailing_blank_cells() {
    // The extraction is exact: trailing default spaces inside the rect
    // are preserved (they are part of what is painted).
    let mut b = Buffer::new(5, 1);
    b.set_string(0, 0, "hi", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 5, 1)), "hi   ");
}

#[test]
fn text_in_skips_masked_continuation_cells() {
    // A wide char occupies cols 0-1 (lead + masked continuation): the
    // mask contributes nothing, so the extraction yields the wide glyph
    // once, followed by 'a' — never a doubled or NUL-laden column.
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "コa", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 3, 1)), "コa");
    // The full row (mask included) extracts the same glyph, not a split.
    assert_eq!(b.text_in(Rect::new(0, 0, 4, 1)), "コa ");
}

#[test]
fn text_in_zwj_emoji_contributes_the_full_cluster_symbol() {
    // A ZWJ family emoji is ONE 2-column cluster: the lead cell carries
    // the full symbol string and the masked neighbor contributes nothing,
    // so the extraction reconstructs the cluster whole.
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "👨‍👩‍👧‍👦x", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 3, 1)), "👨‍👩‍👧‍👦x");
    // The full row (masked neighbor + trailing blank) extracts the same
    // cluster plus the following char and one trailing blank cell.
    assert_eq!(b.text_in(Rect::new(0, 0, 4, 1)), "👨‍👩‍👧‍👦x ");
}

#[test]
fn text_in_combining_sequence_keeps_the_full_cluster() {
    // A base + combining mark is ONE 1-column cluster carrying the full
    // "e\u{301}" symbol on its single cell.
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "e\u{301}x", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 2, 1)), "e\u{301}x");
}

#[test]
fn text_in_flag_contributes_the_full_cluster_symbol() {
    // A regional-indicator flag is ONE 2-column cluster: lead symbol once,
    // masked neighbor skipped.
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "🇷🇺a", Style::new());
    assert_eq!(b.text_in(Rect::new(0, 0, 3, 1)), "🇷🇺a");
}

#[test]
fn text_in_clips_to_buffer_bounds() {
    // A rect extending past the buffer's right/bottom edges is clipped:
    // only the overlapping cells contribute.
    let mut b = Buffer::new(3, 2);
    b.set_string(0, 0, "abc", Style::new());
    b.set_string(0, 1, "def", Style::new());
    assert_eq!(b.text_in(Rect::new(1, 0, 10, 10)), "bc\nef");
    // A negative origin clips the left/top edges too.
    assert_eq!(b.text_in(Rect::new(-2, 0, 3, 2)), "a\nd");
}

#[test]
fn text_in_out_of_bounds_and_empty_rects_are_empty() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abc", Style::new());
    // Wholly outside the buffer.
    assert_eq!(b.text_in(Rect::new(10, 10, 2, 2)), "");
    // Zero-width / zero-height rects.
    assert_eq!(b.text_in(Rect::new(0, 0, 0, 1)), "");
    assert_eq!(b.text_in(Rect::new(0, 0, 1, 0)), "");
}

#[test]
fn render_caret_styles_the_cell_under_the_cursor() {
    let mut b = Buffer::new(5, 1);
    b.set_string(0, 0, "abc", Style::new());
    let caret = Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED));
    assert!(b.render_caret(caret));
    // The character is untouched; the caret's modifier is added.
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert!(b
        .cell(1, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
    // Neighboring cells are unaffected.
    assert!(!b
        .cell(0, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
    assert!(!b
        .cell(2, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}

#[test]
fn render_caret_adds_modifiers_to_the_cell_own() {
    // A block caret over a bold cell stays bold: the caret's modifiers
    // (REVERSED) are added on top of the cell's own (BOLD).
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abc", Style::new().add_modifier(Modifiers::BOLD));
    let caret = Cursor::new(0, 0).styled(Style::new().add_modifier(Modifiers::REVERSED));
    assert!(b.render_caret(caret));
    let m = b.cell(0, 0).unwrap().style.modifiers;
    assert!(m.contains(Modifiers::BOLD));
    assert!(m.contains(Modifiers::REVERSED));
    // Neighboring cells keep exactly their own modifiers.
    assert!(b
        .cell(1, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::BOLD));
    assert!(!b
        .cell(1, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}

#[test]
fn render_caret_merges_explicit_colors_and_preserves_defaults() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abc", Style::new().fg(Color::Indexed(7)));
    // A caret with an explicit background and a modifier keeps the cell's
    // foreground (Default means "leave it").
    let caret = Cursor::new(0, 0).styled(
        Style::new()
            .bg(Color::Indexed(1))
            .add_modifier(Modifiers::BOLD),
    );
    assert!(b.render_caret(caret));
    let c = b.cell(0, 0).unwrap();
    assert_eq!(c.style.fg, Color::Indexed(7)); // preserved
    assert_eq!(c.style.bg, Color::Indexed(1)); // caret's bg applied
    assert!(c.style.modifiers.contains(Modifiers::BOLD));

    // An explicit caret foreground replaces the cell's.
    let mut b2 = Buffer::new(1, 1);
    b2.set_char(0, 0, 'x', Style::new().fg(Color::Rgb(1, 2, 3)));
    let caret2 = Cursor::new(0, 0).styled(Style::new().fg(Color::Rgb(9, 9, 9)));
    assert!(b2.render_caret(caret2));
    assert_eq!(b2.cell(0, 0).unwrap().style.fg, Color::Rgb(9, 9, 9));
    assert_eq!(b2.cell(0, 0).unwrap().style.bg, Color::Default);
}

#[test]
fn render_caret_hidden_and_out_of_bounds_are_noops() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abc", Style::new());
    let before = b.clone();

    // A hidden caret paints nothing.
    let hidden = Cursor::new(1, 0)
        .hide()
        .styled(Style::new().add_modifier(Modifiers::REVERSED));
    assert!(!b.render_caret(hidden));
    assert_eq!(b, before);

    // Positions outside the buffer paint nothing.
    assert!(!b.render_caret(Cursor::new(3, 0))); // x == width
    assert!(!b.render_caret(Cursor::new(0, 1))); // y == height
    assert_eq!(b, before);
}

#[test]
fn render_caret_skips_masked_continuation_cells() {
    // The right half of a wide character is a masked cell; painting the
    // caret there would corrupt the glyph, so it is refused.
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "コa", Style::new()); // コ at 0-1 (mask at 1), 'a' at 2
    let caret = Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED));
    assert!(!b.render_caret(caret));
    assert!(b.cell(1, 0).unwrap().is_masked());
    assert!(!b
        .cell(1, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));

    // The caret still paints on real cells either side of the mask.
    assert!(b.render_caret(
        Cursor::new(2, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))
    ));
    assert!(b
        .cell(2, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}
