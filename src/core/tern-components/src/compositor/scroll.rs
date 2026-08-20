//! Pure scroll-shift detection: recognizing when the change between two
//! frames of a full-width region is exactly a vertical scroll (the DECSTBM
//! scroll-region case) rather than per-cell repaints.
//!
//! A terminal scrolls a DECSTBM region by emitting one scroll command (e.g.
//! CSI S / CSI T) plus the newly exposed rows, instead of repainting the whole
//! region cell-for-cell. [`detect_vertical_scroll`] decides whether the
//! difference between `prev` and `next` is explained by such a shift, and
//! [`exposed_band_updates`] narrows the cell diff to exactly the newly exposed
//! rows the flusher must repaint after the scroll command. Both are pure
//! functions over buffers — the flusher integration lives elsewhere.

use super::*;

/// A detected vertical scroll of a full-width region.
///
/// `up` is `true` when the content scrolled up (the DECSTBM "scroll up":
/// content moves toward the top, the newly exposed rows are the bottom `rows`
/// rows of the region) and `false` when it scrolled down (the newly exposed
/// rows are the top `rows` rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollShift {
    /// The scrolled region: full-width (`region.x == 0`, `region.right() ==
    /// the viewport width`).
    pub region: Rect,
    /// The number of rows scrolled; always in `1..region.height`.
    pub rows: u32,
    /// Scroll direction: `true` scrolls content up (exposed band at the
    /// bottom), `false` scrolls content down (exposed band at the top).
    pub up: bool,
}

/// Detect whether the change from `prev` to `next` inside `region` is a pure
/// vertical scroll of whole rows, returning the smallest shift that explains
/// it.
///
/// Returns `Some` **only** when all of these hold:
///
/// * `region` is full-width (`region.x == 0` and `region.right() ==
///   viewport_width`) — DECSTBM scrolls whole rows, so sub-width regions (e.g.
///   a scrollable `Table` content pane) are excluded in v1; a vertical shift
///   inside a partial-width region is left to the regular diff/repaint path.
/// * `region.height > 1` — a one-row region has no rows to shift against.
/// * Every row of `next` in the overlap matches the `prev` row `rows` away
///   cell-for-cell (`next[y] == prev[y + rows]` scrolling up, `next[y] ==
///   prev[y - rows]` scrolling down). [`Cell`] equality covers ch/style/width
///   — and therefore the masked continuation cells of wide glyphs — so
///   wide-char rows compare exactly.
///
/// The smallest matching shift is returned (candidates `rows = 1, 2, …` are
/// tried in order): any shift that satisfies the overlap predicate
/// reconstructs `next` exactly — the flusher scrolls by `rows` and repaints
/// the exposed band — so the smallest is the cheapest, and over-detection is
/// impossible (a larger shift only matches when it is also a faithful
/// explanation). A cell outside either buffer's extent is a mismatch.
///
/// Note: two buffers whose region content is *identical* can still match when
/// the region's rows are duplicated (e.g. `next[y] == prev[y + 1]` holds for a
/// region of identical rows). Callers applying this to a frame diff should
/// skip detection when the diff produced no updates.
pub fn detect_vertical_scroll(
    prev: &Buffer,
    next: &Buffer,
    region: Rect,
    viewport_width: u16,
) -> Option<ScrollShift> {
    // v1 scope: DECSTBM scrolls whole rows, so only full-width regions are
    // detected; a sub-width region (e.g. a scrollable Table content pane)
    // would need per-cell row shifting and is left to the repaint path.
    if region.x != 0 || region.right() != viewport_width as i32 {
        return None;
    }
    // A one-row region has no rows to shift against.
    if region.height <= 1 {
        return None;
    }
    for rows in 1..region.height {
        if overlap_matches(prev, next, region, rows, true) {
            return Some(ScrollShift {
                region,
                rows,
                up: true,
            });
        }
        if overlap_matches(prev, next, region, rows, false) {
            return Some(ScrollShift {
                region,
                rows,
                up: false,
            });
        }
    }
    None
}

/// Whether every row of `next` in the overlap matches the `prev` row `rows`
/// away: `next[y] == prev[y + rows]` when scrolling up, `next[y] ==
/// prev[y - rows]` when scrolling down.
///
/// The overlap is the `next` rows whose partner lies inside the region —
/// `[region.y, region.bottom() - rows)` up, `[region.y + rows,
/// region.bottom())` down. Callers only pass `rows < region.height`, so the
/// overlap is never empty.
fn overlap_matches(prev: &Buffer, next: &Buffer, region: Rect, rows: u32, up: bool) -> bool {
    let rows = rows as i32;
    let (y0, y1) = if up {
        (region.y, region.bottom() - rows)
    } else {
        (region.y + rows, region.bottom())
    };
    for y in y0..y1 {
        let src = if up { y + rows } else { y - rows };
        if !row_matches(prev, next, region, y, src) {
            return false;
        }
    }
    true
}

/// Whether `next`'s row `dst_y` equals `prev`'s row `src_y` cell-for-cell
/// across the full width of `region`. A cell outside either buffer is a
/// mismatch — out-of-bounds rows never scroll.
fn row_matches(prev: &Buffer, next: &Buffer, region: Rect, dst_y: i32, src_y: i32) -> bool {
    for x in region.x..region.right() {
        match (next.cell(x as u16, dst_y as u16), prev.cell(x as u16, src_y as u16)) {
            (Some(n), Some(p)) if n == p => {}
            _ => return false,
        }
    }
    true
}

/// Narrow a cell diff to the rows a scroll exposes: the bottom `rows` rows of
/// `region` when scrolling up, the top `rows` rows when scrolling down.
///
/// After the flusher emits the scroll command, only these rows need
/// repainting — every other row was moved by the terminal itself. Updates
/// outside the exposed band are dropped; updates inside it keep their order
/// and content (including the lead + masked-neighbor pairing of a wide glyph,
/// both of which share the same row).
pub fn exposed_band_updates(updates: &[CellUpdate], shift: &ScrollShift) -> Vec<CellUpdate> {
    let (start, end) = if shift.up {
        (
            shift.region.bottom() - shift.rows as i32,
            shift.region.bottom(),
        )
    } else {
        (shift.region.y, shift.region.y + shift.rows as i32)
    };
    updates
        .iter()
        .filter(|u| (u.y as i32) >= start && (u.y as i32) < end)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::buffer::diff;
    use tern_core::style::Style;

    /// A `width`-wide buffer whose rows hold the given strings.
    fn buffer(width: u16, rows: &[&str]) -> Buffer {
        let mut b = Buffer::new(width, rows.len() as u16);
        for (y, text) in rows.iter().enumerate() {
            b.set_string(0, y as u16, text, Style::new());
        }
        b
    }

    #[test]
    fn detects_one_row_shift_up() {
        let prev = buffer(5, &["aaaaa", "bbbbb", "ccccc", "ddddd"]);
        let next = buffer(5, &["bbbbb", "ccccc", "ddddd", "eeeee"]);
        let region = Rect::new(0, 0, 5, 4);
        let shift =
            detect_vertical_scroll(&prev, &next, region, 5).expect("one-row scroll up");
        assert_eq!(shift.rows, 1);
        assert!(shift.up);
        assert_eq!(shift.region, region);
    }

    #[test]
    fn detects_one_row_shift_down() {
        let prev = buffer(5, &["aaaaa", "bbbbb", "ccccc", "ddddd"]);
        let next = buffer(5, &["00000", "aaaaa", "bbbbb", "ccccc"]);
        let region = Rect::new(0, 0, 5, 4);
        let shift =
            detect_vertical_scroll(&prev, &next, region, 5).expect("one-row scroll down");
        assert_eq!(shift.rows, 1);
        assert!(!shift.up);
        // Down-scroll exposes the TOP row: the diff's 5 updates land in row 0
        // and all of them survive the band filter.
        let updates = diff(&prev, &next);
        let exposed = exposed_band_updates(&updates, &shift);
        assert_eq!(exposed.len(), 5);
        assert!(exposed.iter().all(|u| u.y == 0));
        assert!(exposed.iter().all(|u| u.ch == '0'));
    }

    #[test]
    fn detects_multi_row_shift() {
        let prev = buffer(
            5,
            &["aaaaa", "bbbbb", "ccccc", "ddddd", "eeeee", "fffff"],
        );
        let next = buffer(
            5,
            &["ddddd", "eeeee", "fffff", "ggggg", "hhhhh", "iiiii"],
        );
        let region = Rect::new(0, 0, 5, 6);
        let shift =
            detect_vertical_scroll(&prev, &next, region, 5).expect("three-row scroll up");
        assert_eq!(shift.rows, 3);
        assert!(shift.up);
    }

    #[test]
    fn shift_with_content_change_in_exposed_row_is_still_some() {
        // The exposed (bottom) row holds brand-new content — it is not part of
        // the overlap check — so the scroll is still detected, and the band
        // filter keeps exactly that row's updates.
        let prev = buffer(5, &["aaaaa", "bbbbb", "ccccc"]);
        let next = buffer(5, &["bbbbb", "ccccc", "zzzzz"]);
        let region = Rect::new(0, 0, 5, 3);
        let shift = detect_vertical_scroll(&prev, &next, region, 5)
            .expect("scroll with new exposed-row content");
        assert_eq!(shift.rows, 1);
        assert!(shift.up);
        let updates = diff(&prev, &next);
        let exposed = exposed_band_updates(&updates, &shift);
        assert_eq!(exposed.len(), 5);
        assert!(exposed.iter().all(|u| u.y == 2));
        assert!(exposed.iter().all(|u| u.ch == 'z'));
    }

    #[test]
    fn in_region_non_shift_change_is_none() {
        // Row 1 changed in place (neither `next[0] == prev[1]` nor
        // `next[1] == prev[0]` can hold): not a scroll.
        let prev = buffer(5, &["aaaaa", "bbbbb", "ccccc"]);
        let next = buffer(5, &["bbbbb", "xxxxx", "ccccc"]);
        let region = Rect::new(0, 0, 5, 3);
        assert!(detect_vertical_scroll(&prev, &next, region, 5).is_none());
    }

    #[test]
    fn sub_width_region_is_none() {
        let prev = buffer(6, &["aaaaaa", "bbbbbb", "cccccc"]);
        let next = buffer(6, &["bbbbbb", "cccccc", "dddddd"]);
        // The region starts past the left edge: not full-width.
        let shifted = Rect::new(2, 0, 4, 3);
        assert!(detect_vertical_scroll(&prev, &next, shifted, 6).is_none());
        // The region ends before the viewport edge: not full-width.
        let partial = Rect::new(0, 0, 4, 3);
        assert!(detect_vertical_scroll(&prev, &next, partial, 6).is_none());
        // The same buffers with the full-width region DO match — proving the
        // exclusion is the width gate, not the content.
        let full = Rect::new(0, 0, 6, 3);
        assert!(detect_vertical_scroll(&prev, &next, full, 6).is_some());
    }

    #[test]
    fn height_one_region_is_none() {
        let prev = buffer(5, &["aaaaa", "bbbbb"]);
        let next = buffer(5, &["bbbbb", "ccccc"]);
        let region = Rect::new(0, 0, 5, 1);
        assert!(detect_vertical_scroll(&prev, &next, region, 5).is_none());
    }

    #[test]
    fn wide_char_overlap_scrolls() {
        // The wide glyph's masked continuation cell scrolls with the row: Cell
        // equality covers ch/style/width, so the mask at column 1 must match
        // too — a scroll is detected across a wide-char row.
        let prev = buffer(5, &["aaaaa", "コab", "cdef"]);
        let next = buffer(5, &["コab", "cdef", "ghij"]);
        let region = Rect::new(0, 0, 5, 3);
        let shift =
            detect_vertical_scroll(&prev, &next, region, 5).expect("wide-char scroll up");
        assert_eq!(shift.rows, 1);
        assert!(shift.up);
        let updates = diff(&prev, &next);
        let exposed = exposed_band_updates(&updates, &shift);
        // Only the exposed bottom row changed (the overlap rows are equal):
        // "ghij" vs "cdef" touches 4 cells, the trailing blank column matches.
        assert_eq!(exposed.len(), 4);
        assert!(exposed.iter().all(|u| u.y == 2));
    }

    #[test]
    fn detects_scroll_in_region_not_at_top() {
        // A DECSTBM-style region starting below the top row: only the rows
        // inside the region participate; row 0 is untouched.
        let prev = buffer(5, &["00000", "aaaaa", "bbbbb", "ccccc", "ddddd"]);
        let next = buffer(5, &["00000", "bbbbb", "ccccc", "ddddd", "eeeee"]);
        let region = Rect::new(0, 1, 5, 4);
        let shift = detect_vertical_scroll(&prev, &next, region, 5)
            .expect("region scroll below the top row");
        assert_eq!(shift.rows, 1);
        assert!(shift.up);
        let updates = diff(&prev, &next);
        let exposed = exposed_band_updates(&updates, &shift);
        // The exposed band is the region's bottom row: row 4, not row 0.
        assert_eq!(exposed.len(), 5);
        assert!(exposed.iter().all(|u| u.y == 4));
        assert!(exposed.iter().all(|u| u.ch == 'e'));
    }

    #[test]
    fn exposed_band_updates_filters_by_direction_and_rows() {
        let region = Rect::new(0, 0, 10, 6);
        let updates: Vec<CellUpdate> = (0..6)
            .map(|y| CellUpdate {
                x: 0,
                y,
                ch: 'x',
                symbol: None,
                style: Style::new(),
                width: 1,
                masked: false,
            })
            .collect();
        // Up: the bottom `rows` rows of the region.
        let up = ScrollShift {
            region,
            rows: 2,
            up: true,
        };
        let exposed = exposed_band_updates(&updates, &up);
        assert_eq!(exposed.len(), 2);
        assert!(exposed.iter().all(|u| u.y == 4 || u.y == 5));
        // Down: the top `rows` rows of the region.
        let down = ScrollShift {
            region,
            rows: 2,
            up: false,
        };
        let exposed = exposed_band_updates(&updates, &down);
        assert_eq!(exposed.len(), 2);
        assert!(exposed.iter().all(|u| u.y == 0 || u.y == 1));
    }
}
