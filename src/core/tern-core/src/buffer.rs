//! The compositor's 2D cell grid, plus multi-width-aware minimal diff and
//! region-aware drawing (clip rects and scroll offsets).

use crate::cell::{char_width, Cell, CellUpdate};
use crate::color::Color;
use crate::cursor::Cursor;
use crate::rect::Rect;
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

/// A bounded drawing region: a clip rectangle plus a scroll offset.
///
/// Drawing "through" a region maps content coordinates (the coordinates used
/// when painting, e.g. a laid-out node's rect) into buffer coordinates by
/// subtracting the scroll offset, then rejects any cell that lands outside
/// the clip rect. The clip rect therefore restricts drawing to a bounded
/// region of the buffer, and the scroll offset shifts the content *inside*
/// that region: with `scroll_y = 2`, content at row 2 renders at buffer row
/// 0, and content rows 0-1 are clipped away (scrolled out of view).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Region {
    /// The rectangle (in buffer coordinates) that drawing is restricted to.
    pub clip: Rect,
    /// Horizontal scroll offset in cells (content shifts left as it grows).
    pub scroll_x: i32,
    /// Vertical scroll offset in cells (content shifts up as it grows).
    pub scroll_y: i32,
}

impl Region {
    /// A region that clips to `clip` without scrolling.
    pub const fn clip_only(clip: Rect) -> Self {
        Self {
            clip,
            scroll_x: 0,
            scroll_y: 0,
        }
    }

    /// A region with a clip rect and a scroll offset.
    pub const fn new(clip: Rect, scroll_x: i32, scroll_y: i32) -> Self {
        Self {
            clip,
            scroll_x,
            scroll_y,
        }
    }

    /// The buffer column a content column maps to (before clipping).
    pub const fn map_x(&self, x: i32) -> i32 {
        x - self.scroll_x
    }

    /// The buffer row a content row maps to (before clipping).
    pub const fn map_y(&self, y: i32) -> i32 {
        y - self.scroll_y
    }

    /// Whether a content cell at (`x`, `y`) lands inside the clip rect.
    pub const fn contains(&self, x: i32, y: i32) -> bool {
        self.clip.contains(self.map_x(x), self.map_y(y))
    }
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

    /// Write a single character at content position (`x`, `y`) through
    /// `region`: the position is shifted by the region's scroll offset and
    /// must land inside its clip rect (and the buffer). A wide character is
    /// written only when both of its columns land inside the clip; otherwise
    /// it is dropped whole (never truncated mid-glyph). Returns `false` when
    /// nothing was written.
    pub fn set_char_region(
        &mut self,
        x: i32,
        y: i32,
        ch: char,
        style: Style,
        region: Region,
    ) -> bool {
        let w = char_width(ch);
        if w == 2 {
            let bx = region.map_x(x);
            let by = region.map_y(y);
            // Both columns must land inside the clip and the buffer.
            if bx < 0 || by < 0 || bx + 1 >= self.width as i32 || by >= self.height as i32 {
                return false;
            }
            if !region.clip.contains(bx, by) || !region.clip.contains(bx + 1, by) {
                return false;
            }
            let i = by as usize * self.width as usize + bx as usize;
            self.cells[i] = Cell {
                ch,
                style,
                width: 2,
            };
            self.cells[i + 1] = Cell::mask(style);
            return true;
        }
        if w == 0 {
            return false;
        }
        let bx = region.map_x(x);
        let by = region.map_y(y);
        if bx < 0 || by < 0 || bx >= self.width as i32 || by >= self.height as i32 {
            return false;
        }
        if !region.clip.contains(bx, by) {
            return false;
        }
        let i = by as usize * self.width as usize + bx as usize;
        self.cells[i] = Cell {
            ch,
            style,
            width: w,
        };
        true
    }

    /// Write a string through `region` starting at content position (`x`,
    /// `y`), advancing the cursor by each character's display width. Writing
    /// stops at the clip rect's right edge (in buffer coordinates) so no wide
    /// character is ever truncated mid-glyph; combining marks (width 0) are
    /// skipped, as in [`set_string`](Self::set_string).
    pub fn set_string_region(
        &mut self,
        x: i32,
        y: i32,
        text: &str,
        style: Style,
        region: Region,
    ) {
        let mut cx = x;
        for ch in text.chars() {
            let w = char_width(ch);
            if w == 0 {
                continue;
            }
            // Stop when this glyph would cross the clip's right edge (buffer
            // coordinates) — mirrors set_string's right-edge behaviour.
            let bx = region.map_x(cx);
            if bx + w as i32 > region.clip.right() {
                break;
            }
            self.set_char_region(cx, y, ch, style, region);
            cx += w as i32;
        }
    }

    /// Paint a block caret into the buffer at the cursor's position.
    ///
    /// A no-op when the cursor is hidden or sits outside the buffer (returns
    /// `false` in both cases). When visible, the cell under the cursor has
    /// the caret's style merged over it: explicit foreground/background
    /// colors from the caret replace the cell's, and the caret's modifiers
    /// (typically [`Modifiers::REVERSED`]) are added to the cell's own, so
    /// the diff emits the caret as part of the frame.
    ///
    /// The caret is never painted over a masked continuation cell (the
    /// zero-width right half of a wide character): painting there would break
    /// the wide glyph, so the call returns `false` instead.
    pub fn render_caret(&mut self, cursor: Cursor) -> bool {
        if !cursor.visible {
            return false;
        }
        let Some(i) = self.index(cursor.x, cursor.y) else {
            return false;
        };
        let cell = &mut self.cells[i];
        if cell.is_masked() {
            return false;
        }
        let fg = if cursor.style.fg == Color::Default {
            cell.style.fg
        } else {
            cursor.style.fg
        };
        let bg = if cursor.style.bg == Color::Default {
            cell.style.bg
        } else {
            cursor.style.bg
        };
        // Colors override when the caret sets them; the caret's modifiers are
        // added on top of the cell's own (e.g. REVERSED on a bold title).
        cell.style = cell.style.fg(fg).bg(bg).add_modifier(cursor.style.modifiers);
        true
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
    use crate::style::Modifiers;

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

    #[test]
    fn render_caret_styles_the_cell_under_the_cursor() {
        let mut b = Buffer::new(5, 1);
        b.set_string(0, 0, "abc", Style::new());
        let caret = Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED));
        assert!(b.render_caret(caret));
        // The character is untouched; the caret's modifier is added.
        assert_eq!(b.cell(1, 0).unwrap().ch, 'b');
        assert!(b.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        // Neighboring cells are unaffected.
        assert!(!b.cell(0, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
        assert!(!b.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
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
        assert!(b.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::BOLD));
        assert!(!b.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
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
        let hidden = Cursor::new(1, 0).hide().styled(Style::new().add_modifier(Modifiers::REVERSED));
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
        assert!(!b.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

        // The caret still paints on real cells either side of the mask.
        assert!(b.render_caret(Cursor::new(2, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))));
        assert!(b.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    }

    #[test]
    fn render_caret_then_diff_emits_the_caret_cell() {
        let mut prev = Buffer::new(3, 1);
        prev.set_string(0, 0, "abc", Style::new());
        let mut next = prev.clone();
        assert!(next.render_caret(Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))));

        let u = diff(&prev, &next);
        // Only the caret cell changed: 'b' gains the REVERSED modifier.
        assert_eq!(u.len(), 1);
        assert_eq!((u[0].x, u[0].y), (1, 0));
        assert_eq!(u[0].ch, 'b');
        assert!(u[0].style.modifiers.contains(Modifiers::REVERSED));
        assert!(!u[0].masked);

        // A second render of the same caret produces no further updates.
        let mut same = next.clone();
        assert!(same.render_caret(Cursor::new(1, 0).styled(Style::new().add_modifier(Modifiers::REVERSED))));
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
}
