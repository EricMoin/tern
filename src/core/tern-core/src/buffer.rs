//! The compositor's 2D cell grid, plus multi-width-aware minimal diff.

use crate::cell::{char_width, Cell, CellUpdate};
use crate::style::Style;

/// A fixed-size 2D grid of cells, indexed by (`x`, `y`) with the origin at
/// the top-left. Cells are stored row-major: `index = y * width + x`.
///
/// Invariant: a wide (width 2) cell at column `x` is always followed by its
/// masked continuation cell (width 0) at column `x + 1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Buffer {
    /// Width in cells.
    pub width: u16,
    /// Height in cells.
    pub height: u16,
    cells: Vec<Cell>,
}

impl Buffer {
    /// A buffer of `width` x `height` blank cells.
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            width,
            height,
            cells: vec![Cell::default(); width as usize * height as usize],
        }
    }

    /// Reset every cell to the blank default.
    pub fn clear(&mut self) {
        self.cells.fill(Cell::default());
    }

    /// Row-major index of (`x`, `y`), or `None` when out of bounds.
    pub fn index(&self, x: u16, y: u16) -> Option<usize> {
        if x < self.width && y < self.height {
            Some(y as usize * self.width as usize + x as usize)
        } else {
            None
        }
    }

    /// Immutable access to the cell at (`x`, `y`).
    pub fn cell(&self, x: u16, y: u16) -> Option<&Cell> {
        self.index(x, y).map(|i| &self.cells[i])
    }

    /// Mutable access to the cell at (`x`, `y`).
    pub fn cell_mut(&mut self, x: u16, y: u16) -> Option<&mut Cell> {
        self.index(x, y).map(move |i| &mut self.cells[i])
    }

    /// Overwrite the cell at (`x`, `y`) directly.
    pub fn set_cell(&mut self, x: u16, y: u16, cell: Cell) -> bool {
        match self.cell_mut(x, y) {
            Some(slot) => {
                *slot = cell;
                true
            }
            None => false,
        }
    }

    /// Write a single character at (`x`, `y`), taking its display width into
    /// account. A wide character also writes its masked continuation cell at
    /// `x + 1`. Returns `false` (writing nothing) when the character does not
    /// fit, keeping the buffer's wide-char invariant intact.
    pub fn set_char(&mut self, x: u16, y: u16, ch: char, style: Style) -> bool {
        let w = char_width(ch);
        if w == 2 {
            if x + 1 >= self.width || y >= self.height {
                return false;
            }
            let i = self.index(x, y).expect("bounds checked above");
            self.cells[i] = Cell {
                ch,
                style,
                width: 2,
            };
            self.cells[i + 1] = Cell::mask(style);
            return true;
        }
        let Some(i) = self.index(x, y) else {
            return false;
        };
        self.cells[i] = Cell {
            ch,
            style,
            width: w,
        };
        true
    }

    /// Write a string starting at (`x`, `y`), advancing the cursor by each
    /// character's display width. Writing stops at the right edge so no wide
    /// character is ever truncated mid-glyph. Combining marks (width 0) are
    /// skipped: a single-char cell cannot hold a base-plus-combining cluster.
    pub fn set_string(&mut self, x: u16, y: u16, text: &str, style: Style) {
        let mut cx = x;
        for ch in text.chars() {
            if cx >= self.width {
                break;
            }
            let w = char_width(ch);
            if w == 0 {
                continue;
            }
            if cx + w as u16 > self.width {
                break;
            }
            self.set_char(cx, y, ch, style);
            cx += w as u16;
        }
    }

    /// Resize the buffer to `width` x `height` cells. Content in the
    /// overlapping region is preserved; new cells are blank. A wide character
    /// straddling the new right edge is dropped (reset to blank) so no orphan
    /// half-width lead remains.
    pub fn resize(&mut self, width: u16, height: u16) {
        if width == self.width && height == self.height {
            return;
        }
        let mut cells = vec![Cell::default(); width as usize * height as usize];
        let copy_w = self.width.min(width) as usize;
        let copy_h = self.height.min(height) as usize;
        for y in 0..copy_h {
            let src = y * self.width as usize;
            let dst = y * width as usize;
            cells[dst..dst + copy_w].copy_from_slice(&self.cells[src..src + copy_w]);
        }
        // Drop wide characters whose masked neighbor no longer fits.
        for y in 0..copy_h {
            for x in 0..width {
                let i = y * width as usize + x as usize;
                if cells[i].width == 2 && x + 1 >= width {
                    cells[i] = Cell::default();
                }
            }
        }
        self.width = width;
        self.height = height;
        self.cells = cells;
    }

    /// The minimal cell updates needed to turn `prev` into `self`.
    ///
    /// See the free [`diff`] function for semantics.
    pub fn diff_from(&self, prev: &Buffer) -> Vec<CellUpdate> {
        diff(prev, self)
    }
}

/// Compute the minimal set of cell updates needed to turn `prev` into `next`.
///
/// Multi-width aware: a changed wide (2-column) lead cell is emitted together
/// with its masked continuation cell (when that neighbor also changed), so the
/// flusher masks the second column in a single pass. Cells outside `prev`'s
/// extent are compared against a blank cell, so default cells in newly-grown
/// regions are not emitted. Updates are produced row-major (top-to-bottom,
/// left-to-right).
pub fn diff(prev: &Buffer, next: &Buffer) -> Vec<CellUpdate> {
    let mut updates = Vec::new();
    for y in 0..next.height {
        let mut x: u16 = 0;
        while x < next.width {
            let n = next.cell(x, y).expect("x < width, y < height");
            let changed = match prev.cell(x, y) {
                Some(p) => p != n,
                None => n != &Cell::default(),
            };
            if !changed {
                x += 1;
                continue;
            }
            match n.width {
                2 => {
                    updates.push(CellUpdate {
                        x,
                        y,
                        ch: n.ch,
                        style: n.style,
                        width: 2,
                        masked: false,
                    });
                    let nx = x + 1;
                    if nx < next.width {
                        let ncell = next.cell(nx, y).expect("nx < width");
                        let neighbor_changed = match prev.cell(nx, y) {
                            Some(p) => p != ncell,
                            None => ncell != &Cell::default(),
                        };
                        if neighbor_changed {
                            updates.push(CellUpdate {
                                x: nx,
                                y,
                                ch: ncell.ch,
                                style: ncell.style,
                                width: ncell.width,
                                masked: ncell.width == 0,
                            });
                        }
                    }
                    x += 2;
                }
                0 => {
                    updates.push(CellUpdate {
                        x,
                        y,
                        ch: n.ch,
                        style: n.style,
                        width: 0,
                        masked: true,
                    });
                    x += 1;
                }
                _ => {
                    updates.push(CellUpdate {
                        x,
                        y,
                        ch: n.ch,
                        style: n.style,
                        width: 1,
                        masked: false,
                    });
                    x += 1;
                }
            }
        }
    }
    updates
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-row buffer sized to the display width of `text`.
    fn string_row(text: &str) -> Buffer {
        let w: u16 = text
            .chars()
            .map(|c| char_width(c) as u16)
            .sum::<u16>()
            .max(1);
        let mut b = Buffer::new(w, 1);
        b.set_string(0, 0, text, Style::new());
        b
    }

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
}
