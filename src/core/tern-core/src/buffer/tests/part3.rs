//! Part 3 of the the cell buffer tests.

use super::*;

#[test]
fn render_caret_then_diff_emits_the_caret_cell() {
    let mut prev = Buffer::new(3, 1);
    prev.set_string(0, 0, "abc", Style::new());
    let mut next = prev.clone();
    assert!(next.render_caret(
        Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))
    ));

    let u = diff(&prev, &next);
    // Only the caret cell changed: 'b' gains the REVERSED modifier.
    assert_eq!(u.len(), 1);
    assert_eq!((u[0].x, u[0].y), (1, 0));
    assert_eq!(u[0].ch, 'b');
    assert!(u[0].style.modifiers.contains(Modifiers::REVERSED));
    assert!(!u[0].masked);

    // A second render of the same caret produces no further updates.
    let mut same = next.clone();
    assert!(same.render_caret(
        Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))
    ));
    assert!(diff(&next, &same).is_empty());
}

#[test]
fn region_clip_restricts_drawing_to_bounded_area() {
    // A clip rect covering (1,1)-(3,2) inside a 5x4 buffer. Content at
    // (2,1) renders at buffer (2,1); content outside the clip is dropped.
    let region = Region::clip_only(Rect::new(1, 1, 2, 1));
    let mut b = Buffer::new(5, 4);
    assert!(b.set_char_region(2, 1, 'x', Style::new(), region));
    assert_eq!(b.cell(2, 1).unwrap().ch, 'x');

    // Out of bounds of the clip: left, right, above, below.
    assert!(!b.set_char_region(0, 1, 'x', Style::new(), region));
    assert!(!b.set_char_region(3, 1, 'x', Style::new(), region));
    assert!(!b.set_char_region(2, 0, 'x', Style::new(), region));
    assert!(!b.set_char_region(2, 2, 'x', Style::new(), region));
    assert_eq!(b.cell(0, 1).unwrap(), &Cell::default());
    assert_eq!(b.cell(3, 1).unwrap(), &Cell::default());
}

#[test]
fn region_clip_also_respects_buffer_bounds() {
    // A clip rect larger than the buffer: writes still can't escape the
    // buffer's own extent.
    let region = Region::clip_only(Rect::new(0, 0, 100, 100));
    let mut b = Buffer::new(3, 2);
    assert!(b.set_char_region(2, 1, 'a', Style::new(), region));
    assert!(!b.set_char_region(3, 0, 'x', Style::new(), region));
    assert!(!b.set_char_region(0, 2, 'x', Style::new(), region));
}

#[test]
fn region_scroll_offset_shifts_content_inside_viewport() {
    // A 3x2 viewport with scroll_y = 1: content at row 1 renders at
    // buffer row 0; content rows 0 are scrolled out (clipped away).
    let region = Region::new(Rect::new(0, 0, 3, 2), 0, 1);
    let mut b = Buffer::new(3, 2);
    assert!(!b.set_char_region(0, 0, 'x', Style::new(), region)); // scrolled out
    assert!(b.set_char_region(0, 1, 'a', Style::new(), region));
    assert!(b.set_char_region(1, 1, 'b', Style::new(), region));
    assert!(b.set_char_region(2, 1, 'c', Style::new(), region));
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert_eq!(b.cell(2, 0).unwrap().ch, 'c');
    // Content row 2 maps to buffer row 1 — still inside the viewport.
    assert!(b.set_char_region(0, 2, 'd', Style::new(), region));
    assert_eq!(b.cell(0, 1).unwrap().ch, 'd');
    // Content row 3 maps to buffer row 2 — outside the 2-row viewport.
    assert!(!b.set_char_region(0, 3, 'x', Style::new(), region));
    assert_eq!(b.cell(0, 1).unwrap().ch, 'd'); // unchanged
}

#[test]
fn region_horizontal_scroll_shifts_columns() {
    // scroll_x = 1: content at column 1 renders at buffer column 0;
    // content at column 0 is clipped away.
    let region = Region::new(Rect::new(0, 0, 4, 1), 1, 0);
    let mut b = Buffer::new(4, 1);
    assert!(!b.set_char_region(0, 0, 'x', Style::new(), region));
    assert!(b.set_char_region(1, 0, 'h', Style::new(), region));
    assert!(b.set_char_region(2, 0, 'i', Style::new(), region));
    assert!(b.set_char_region(3, 0, 'j', Style::new(), region));
    assert_eq!(b.cell(0, 0).unwrap().ch, 'h');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'i');
    assert_eq!(b.cell(2, 0).unwrap().ch, 'j');
    // Content column 4 maps to buffer column 3 — fits.
    assert!(b.set_char_region(4, 0, 'k', Style::new(), region));
    assert_eq!(b.cell(3, 0).unwrap().ch, 'k');
    // Content column 5 maps to buffer column 4 — outside the clip.
    assert!(!b.set_char_region(5, 0, 'x', Style::new(), region));
}

#[test]
fn region_wide_char_needs_both_columns_inside_clip() {
    // A wide char at content (0,0) needs buffer columns 0 and 1 inside a
    // clip of width 3: it fits. At content (2,0) it would need columns 2
    // and 3, but column 3 is outside the clip — dropped whole.
    let region = Region::clip_only(Rect::new(0, 0, 3, 1));
    let mut b = Buffer::new(3, 1);
    assert!(b.set_char_region(0, 0, 'コ', Style::new(), region));
    assert_eq!(b.cell(0, 0).unwrap().ch, 'コ');
    assert_eq!(b.cell(0, 0).unwrap().width, 2);
    assert!(b.cell(1, 0).unwrap().is_masked());
    assert!(!b.set_char_region(2, 0, 'コ', Style::new(), region));
    assert_eq!(b.cell(2, 0).unwrap(), &Cell::default());
}

#[test]
fn region_string_stops_at_clip_right_edge() {
    // A 3-wide clip: "abcdef" paints only "abc".
    let region = Region::clip_only(Rect::new(0, 0, 3, 1));
    let mut b = Buffer::new(3, 1);
    b.set_string_region(0, 0, "abcdef", Style::new(), region);
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert_eq!(b.cell(2, 0).unwrap().ch, 'c');
}

#[test]
fn region_string_respects_scroll_and_clip() {
    // A 4-wide viewport with scroll_y = 2: writing the string at content
    // row 2 renders it at buffer row 0.
    let region = Region::new(Rect::new(0, 0, 4, 1), 0, 2);
    let mut b = Buffer::new(4, 1);
    b.set_string_region(0, 2, "abcd", Style::new(), region);
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert_eq!(b.cell(2, 0).unwrap().ch, 'c');
    assert_eq!(b.cell(3, 0).unwrap().ch, 'd');

    // A row that is scrolled out paints nothing.
    let mut b2 = Buffer::new(4, 1);
    b2.set_string_region(0, 1, "abcd", Style::new(), region);
    for x in 0..4 {
        assert_eq!(b2.cell(x, 0).unwrap(), &Cell::default());
    }
}

#[test]
fn region_clip_offsets_and_scrolls_from_origin() {
    // Clip at (1,1) sized 2x1, scroll (1,0): content at (2,1) maps to
    // buffer (1,1) — inside the clip; content at (1,1) maps to buffer
    // (0,1) — outside the clip's left edge.
    let region = Region::new(Rect::new(1, 1, 2, 1), 1, 0);
    let mut b = Buffer::new(4, 3);
    assert!(!b.set_char_region(1, 1, 'x', Style::new(), region));
    assert!(b.set_char_region(2, 1, 'y', Style::new(), region));
    assert_eq!(b.cell(1, 1).unwrap().ch, 'y');
    assert!(b.set_char_region(3, 1, 'z', Style::new(), region));
    assert_eq!(b.cell(2, 1).unwrap().ch, 'z');
}
