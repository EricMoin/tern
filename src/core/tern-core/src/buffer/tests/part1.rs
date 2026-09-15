//! Buffer construction, cell writes, and string painting.

use super::*;

#[test]
fn new_buffer_is_blank() {
    let b = Buffer::new(3, 2);
    assert_eq!(b.width, 3);
    assert_eq!(b.height, 2);
    assert_eq!(b.cells.len(), 6);
    for y in 0..2 {
        for x in 0..3 {
            assert_eq!(b.cell(x, y), Some(&Cell::default()));
        }
    }
    assert_eq!(b.cell(3, 0), None);
    assert_eq!(b.cell(0, 2), None);
}

#[test]
fn set_string_wide_char_masks_neighbor() {
    let mut b = Buffer::new(8, 1);
    b.set_string(0, 0, "コa", Style::new());
    let c0 = b.cell(0, 0).unwrap();
    assert_eq!(c0.ch, 'コ');
    assert_eq!(c0.width, 2);
    assert!(!c0.is_masked());
    let c1 = b.cell(1, 0).unwrap();
    assert_eq!(c1.ch, '\0');
    assert_eq!(c1.width, 0);
    assert!(c1.is_masked());
    assert_eq!(b.cell(2, 0).unwrap().ch, 'a');
    // 'a' advances past the wide char: コ at 0-1, 'a' at 2.
    assert_eq!(b.cell(3, 0).unwrap(), &Cell::default());
}

#[test]
fn set_string_zwj_emoji_occupies_two_columns() {
    // A ZWJ family emoji is ONE grapheme cluster rendered as a single
    // 2-column glyph: the lead cell carries the full cluster symbol and
    // the neighbor is masked.
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "👨‍👩‍👧‍👦x", Style::new());
    let lead = b.cell(0, 0).unwrap();
    assert_eq!(lead.ch, '👨');
    assert_eq!(lead.symbol.as_deref(), Some("👨‍👩‍👧‍👦"));
    assert_eq!(lead.width, 2);
    assert!(!lead.is_masked());
    let mask = b.cell(1, 0).unwrap();
    assert_eq!(mask.ch, '\0');
    assert_eq!(mask.width, 0);
    assert!(mask.is_masked());
    // The following char lands after the cluster's two columns.
    assert_eq!(b.cell(2, 0).unwrap().ch, 'x');
}

#[test]
fn set_string_combining_sequence_occupies_one_cell() {
    // A base + combining mark is ONE cluster occupying ONE cell, with the
    // full symbol carried on the cell.
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "e\u{301}a", Style::new());
    let c0 = b.cell(0, 0).unwrap();
    assert_eq!(c0.ch, 'e');
    assert_eq!(c0.symbol.as_deref(), Some("e\u{301}"));
    assert_eq!(c0.width, 1);
    assert!(!c0.is_masked());
    // No masked neighbor: the next char occupies column 1.
    assert_eq!(b.cell(1, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(2, 0).unwrap(), &Cell::default());
}

#[test]
fn set_string_flag_occupies_two_columns() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "🇷🇺a", Style::new());
    let lead = b.cell(0, 0).unwrap();
    assert_eq!(lead.ch, '🇷');
    assert_eq!(lead.symbol.as_deref(), Some("🇷🇺"));
    assert_eq!(lead.width, 2);
    assert_eq!(b.cell(1, 0).unwrap().width, 0);
    assert_eq!(b.cell(2, 0).unwrap().ch, 'a');
}

#[test]
fn set_string_strips_ansi_escapes_at_ingestion() {
    // The cell-model golden contract: an escape-carrying string paints
    // exactly the cells its stripped form paints — an escape occupies no
    // columns and never reaches a Cell.
    let mut plain = Buffer::new(3, 1);
    plain.set_string(0, 0, "red", Style::new());
    let mut colored = Buffer::new(3, 1);
    colored.set_string(0, 0, "\x1b[31mred\x1b[0m", Style::new());
    assert_eq!(plain.cells, colored.cells);

    // A wide glyph with surrounding escapes still lands as lead + masked
    // continuation at the same columns.
    let mut wide = Buffer::new(2, 1);
    wide.set_string(0, 0, "\x1b[1mコ\x1b[0m", Style::new());
    assert_eq!(wide.cell(0, 0).map(|c| c.width), Some(2));
    assert_eq!(wide.cell(1, 0).map(|c| c.width), Some(0));
    assert!(wide.cell(1, 0).map(Cell::is_masked).unwrap_or(false));

    // A combining sequence with surrounding escapes keeps its full symbol
    // on a single cell.
    let mut comb = Buffer::new(1, 1);
    comb.set_string(0, 0, "\x1b[31me\u{301}\x1b[0m", Style::new());
    assert_eq!(comb.cell(0, 0).map(|c| c.symbol.as_deref()), Some(Some("e\u{301}")));
    assert_eq!(comb.cell(0, 0).map(|c| c.width), Some(1));
}

#[test]
fn set_char_wide_does_not_fit() {
    let mut b = Buffer::new(2, 1);
    assert!(b.set_char(0, 0, 'コ', Style::new()));
    // A wide char at column 1 needs a neighbor at column 2 — out of range.
    assert!(!b.set_char(1, 0, 'コ', Style::new()));
    assert_eq!(b.cell(1, 0).unwrap().ch, '\0'); // unchanged mask
    assert!(!b.set_char(0, 1, 'x', Style::new())); // y out of range
}

#[test]
fn set_string_stops_at_right_edge() {
    let mut b = Buffer::new(3, 1);
    b.set_string(0, 0, "abcd", Style::new());
    assert_eq!(b.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
    assert_eq!(b.cell(2, 0).unwrap().ch, 'c');
}

#[test]
fn diff_unchanged_is_empty() {
    let a = string_row("hello");
    let b = string_row("hello");
    assert!(diff(&a, &b).is_empty());
    assert!(b.diff_from(&a).is_empty());
}

#[test]
fn diff_wide_char_produces_lead_and_masked_neighbor() {
    let prev = string_row("ab ");
    let next = string_row("コ ");
    let u = diff(&prev, &next);
    // コ occupies cols 0-1: lead at 0, masked neighbor at 1. Col 2 ' ' unchanged.
    assert_eq!(u.len(), 2);
    assert_eq!(u[0].x, 0);
    assert_eq!(u[0].ch, 'コ');
    assert_eq!(u[0].width, 2);
    assert!(!u[0].masked);
    assert_eq!(u[1].x, 1);
    assert_eq!(u[1].ch, '\0');
    assert_eq!(u[1].width, 0);
    assert!(u[1].masked);
}

#[test]
fn diff_wide_char_overwrites_two_single_chars() {
    let prev = string_row("ab");
    let next = string_row("コ");
    // prev: [a, b]; next: [コ, mask]
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 2);
    assert_eq!(u[0].x, 0);
    assert_eq!(u[0].ch, 'コ');
    assert_eq!(u[0].width, 2);
    assert!(!u[0].masked);
    assert_eq!(u[1].x, 1);
    assert_eq!(u[1].ch, '\0');
    assert_eq!(u[1].width, 0);
    assert!(u[1].masked);
}

#[test]
fn diff_wide_replaced_by_wide_is_single_update() {
    let prev = string_row("コx");
    let next = string_row("日x");
    // Lead differs; both mask cells are '\0'/width 0 and equal → skipped.
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].x, 0);
    assert_eq!(u[0].ch, '日');
    assert_eq!(u[0].width, 2);
    assert!(!u[0].masked);
}

#[test]
fn diff_wide_removed_clears_all_affected_columns() {
    let prev = string_row("コb");
    let next = string_row("ab ");
    // prev: [コ, mask, b]; next: [a, b, ' ']
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 3);
    assert_eq!((u[0].x, u[0].ch), (0, 'a'));
    assert_eq!((u[1].x, u[1].ch), (1, 'b'));
    assert_eq!((u[2].x, u[2].ch), (2, ' '));
    assert!(!u[1].masked); // 'b' is a real character
}

#[test]
fn diff_multi_row_and_partial_change() {
    let mut prev = Buffer::new(4, 2);
    prev.set_string(0, 0, "abcd", Style::new());
    prev.set_string(0, 1, "efgh", Style::new());
    let mut next = prev.clone();
    next.set_string(1, 1, "X", Style::new());
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].x, 1);
    assert_eq!(u[0].y, 1);
    assert_eq!(u[0].ch, 'X');
    assert_eq!(u[0].width, 1);
}

#[test]
fn diff_rows_are_row_major_sorted() {
    let mut prev = Buffer::new(2, 2);
    prev.set_string(0, 0, "ab", Style::new());
    prev.set_string(0, 1, "cd", Style::new());
    let mut next = prev.clone();
    next.set_string(1, 0, "Y", Style::new());
    next.set_string(0, 1, "Z", Style::new());
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 2);
    assert_eq!((u[0].x, u[0].y), (1, 0)); // row 0 first
    assert_eq!((u[1].x, u[1].y), (0, 1));
}

#[test]
fn diff_different_sizes_only_reports_non_default_overflow() {
    let prev = Buffer::new(2, 1);
    let mut next = Buffer::new(4, 2); // bigger
    next.set_string(2, 1, "z", Style::new());
    let u = diff(&prev, &next);
    // Default ' ' cells in the new region are skipped; 'z' is reported.
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].x, 2);
    assert_eq!(u[0].y, 1);
    assert_eq!(u[0].ch, 'z');
}

#[test]
fn diff_identical_multi_row_buffers_are_empty() {
    // Several rows with distinct content (including a wide char) that
    // match exactly: the row-skip path must produce no updates at all.
    let mut a = Buffer::new(6, 3);
    a.set_string(0, 0, "コabc", Style::new());
    a.set_string(0, 1, "def", Style::new());
    a.set_string(0, 2, "ghi", Style::new());
    let b = a.clone();
    assert!(diff(&a, &b).is_empty());
    assert!(b.diff_from(&a).is_empty());
}

#[test]
fn diff_identical_cluster_content_is_empty() {
    // Two buffers holding the same ZWJ cluster content diff to nothing:
    // the row-slice compare is by value (Box<str> equality), so a
    // re-painted cluster is not a change.
    let mut a = Buffer::new(4, 1);
    a.set_string(0, 0, "👨‍👩‍👧‍👦", Style::new());
    let mut b = Buffer::new(4, 1);
    b.set_string(0, 0, "👨‍👩‍👧‍👦", Style::new());
    assert!(diff(&a, &b).is_empty());
}

#[test]
fn diff_cluster_change_carries_full_symbol() {
    // "ab" (two single cells) is replaced by a ZWJ cluster (one 2-column
    // glyph): the lead update carries the FULL cluster symbol plus the
    // masked neighbor — the flusher can print the cluster once.
    let mut prev = Buffer::new(4, 1);
    prev.set_string(0, 0, "ab", Style::new());
    let mut next = Buffer::new(4, 1);
    next.set_string(0, 0, "👨‍👩‍👧‍👦", Style::new());
    let u = diff(&prev, &next);
    assert_eq!(u.len(), 2, "lead + masked neighbor: {u:?}");
    assert_eq!(u[0].x, 0);
    assert_eq!(u[0].ch, '👨');
    assert_eq!(u[0].symbol.as_deref(), Some("👨‍👩‍👧‍👦"));
    assert_eq!(u[0].width, 2);
    assert!(!u[0].masked);
    assert_eq!(u[1].x, 1);
    assert!(u[1].masked);
}

#[test]
fn diff_change_in_one_row_only_updates_that_row() {
    let mut prev = Buffer::new(5, 3);
    prev.set_string(0, 0, "abcde", Style::new());
    prev.set_string(0, 1, "fghij", Style::new());
    prev.set_string(0, 2, "klmno", Style::new());
    let mut next = prev.clone();
    next.set_string(3, 1, "X", Style::new());
    let u = diff(&prev, &next);
    // Only the changed cell in row 1 is emitted; rows 0 and 2 are skipped.
    assert_eq!(u.len(), 1);
    assert_eq!((u[0].x, u[0].y), (3, 1));
    assert_eq!(u[0].ch, 'X');
    assert!(u.iter().all(|c| c.y == 1));
}

#[test]
fn diff_row_skip_keeps_wide_and_masked_semantics() {
    // Row 0 holds a wide char in both buffers and is otherwise identical:
    // the row-skip must not emit anything for it. Row 1 changes from
    // single chars to a wide char, emitting the lead + masked neighbor
    // pairing exactly as before.
    let mut prev = Buffer::new(6, 2);
    prev.set_string(0, 0, "コab", Style::new()); // コ at 0-1, 'a' at 2, 'b' at 3
    prev.set_string(0, 1, "xy", Style::new());
    let mut next = prev.clone();
    next.set_string(0, 1, "コ", Style::new()); // lead at 0, mask at 1
    let u = diff(&prev, &next);
    // Row 1: lead at (0,1) + masked neighbor at (1,1); row 0 skipped.
    assert_eq!(u.len(), 2);
    assert_eq!((u[0].x, u[0].y), (0, 1));
    assert_eq!(u[0].ch, 'コ');
    assert_eq!(u[0].width, 2);
    assert!(!u[0].masked);
    assert_eq!((u[1].x, u[1].y), (1, 1));
    assert_eq!(u[1].ch, '\0');
    assert_eq!(u[1].width, 0);
    assert!(u[1].masked);
    assert!(u.iter().all(|c| c.y == 1));
}

#[test]
fn diff_grown_default_rows_are_skipped() {
    // next is taller than prev with matching row 0; the grown rows 1-2
    // are blank and lie beyond prev's extent, so nothing is emitted.
    let mut prev = Buffer::new(2, 1);
    prev.set_string(0, 0, "ab", Style::new());
    let mut next = Buffer::new(2, 3);
    next.set_string(0, 0, "ab", Style::new());
    assert!(diff(&prev, &next).is_empty());
}

#[test]
fn diff_grown_default_tail_columns_are_skipped() {
    // next is wider than prev in the same row; the extra blank columns
    // compare against blank cells and are skipped.
    let mut prev = Buffer::new(2, 1);
    prev.set_string(0, 0, "ab", Style::new());
    let mut next = Buffer::new(5, 1);
    next.set_string(0, 0, "ab", Style::new());
    assert!(diff(&prev, &next).is_empty());
}
