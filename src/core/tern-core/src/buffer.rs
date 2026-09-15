//! The compositor's 2D cell grid, plus multi-width-aware minimal diff and
//! region-aware drawing (clip rects and scroll offsets).


use crate::cell::{char_width, clusters, strip_escapes, Cell, CellUpdate, Cluster};
use crate::color::Color;
use crate::cursor::Cursor;
use crate::rect::Rect;
use crate::style::Style;

// The Buffer/Region API stays in this file; the test module moved to
// buffer/tests.rs (split into parts) to keep every file under the cap.

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

    /// Reset only the cells inside `r` to the blank default, leaving cells
    /// outside untouched. `r` is clipped to the buffer.
    ///
    /// This is the cheap-clear counterpart of [`clear`](Self::clear) for the
    /// dirty-repaint path: a reused scratch frame only needs its dirty-union
    /// cells blanked before repainting — clearing the whole buffer would touch
    /// every cell for a one-cell repaint.
    pub fn clear_rect(&mut self, r: Rect) {
        let x0 = r.x.max(0) as u16;
        let y0 = r.y.max(0) as u16;
        let x1 = r.right().min(self.width as i32).max(0) as u16;
        let y1 = r.bottom().min(self.height as i32).max(0) as u16;
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let width = self.width as usize;
        let w = (x1 - x0) as usize;
        for y in y0..y1 {
            let start = y as usize * width + x0 as usize;
            self.cells[start..start + w].fill(Cell::default());
        }
    }

    /// Copy the cells inside `r` from `src` into `self` (both viewport-sized;
    /// `r` is clipped to both buffers). This is how a dirty repaint lands:
    /// the freshly painted scratch frame supplies the dirty union's cells,
    /// and every cell outside it keeps its retained value.
    ///
    /// Row-major slice copies (one `clone_from_slice` per row) instead of a
    /// per-cell bounds-checked clone — the hot path of every dirty frame.
    pub fn copy_region(&mut self, src: &Buffer, r: Rect) {
        let x0 = r.x.max(0) as u16;
        let y0 = r.y.max(0) as u16;
        let x1 = r
            .right()
            .min(self.width as i32)
            .min(src.width as i32)
            .max(0) as u16;
        let y1 = r
            .bottom()
            .min(self.height as i32)
            .min(src.height as i32)
            .max(0) as u16;
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let dw = self.width as usize;
        let sw = src.width as usize;
        let w = (x1 - x0) as usize;
        for y in y0..y1 {
            let d = y as usize * dw + x0 as usize;
            let s = y as usize * sw + x0 as usize;
            self.cells[d..d + w].clone_from_slice(&src.cells[s..s + w]);
        }
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
                symbol: None,
                style: style.clone(),
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
            symbol: None,
            style,
            width: w,
        };
        true
    }

    /// Write a grapheme cluster starting at (`x`, `y`): the cluster occupies
    /// [`Cluster::width`] columns as one logical glyph, so a 2-column cluster
    /// writes its lead cell (carrying the full cluster symbol) plus a masked
    /// continuation cell at `x + 1`. Returns `false` (writing nothing) when
    /// the cluster does not fit, keeping the buffer's wide-char invariant
    /// intact. A zero-width cluster (a lone combining mark) writes nothing.
    pub fn set_cluster(&mut self, x: u16, y: u16, cluster: &Cluster<'_>, style: Style) -> bool {
        let w = cluster.width;
        if w == 0 {
            return false;
        }
        let ch = cluster.lead();
        let symbol = cluster.symbol();
        if w == 2 {
            if x + 1 >= self.width || y >= self.height {
                return false;
            }
            let i = self.index(x, y).expect("bounds checked above");
            self.cells[i] = Cell {
                ch,
                symbol,
                style: style.clone(),
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
            symbol,
            style,
            width: 1,
        };
        true
    }

    /// Write a string starting at (`x`, `y`), advancing the cursor by each
    /// grapheme cluster's display width. Writing stops at the right edge so
    /// no cluster is ever truncated mid-glyph: a cluster that does not fit
    /// whole is dropped whole. Zero-width clusters (lone combining marks) are
    /// skipped.
    ///
    /// ANSI/OSC/CSI escape sequences are stripped at ingestion
    /// ([`strip_escapes`](crate::cell::strip_escapes)): they occupy no
    /// columns and never reach a [`Cell`] — an escape-carrying string writes
    /// exactly the cells its stripped form writes.
    pub fn set_string(&mut self, x: u16, y: u16, text: &str, style: Style) {
        let text = strip_escapes(text);
        let mut cx = x;
        for cluster in clusters(&text) {
            if cx >= self.width {
                break;
            }
            let w = cluster.width;
            if w == 0 {
                continue;
            }
            if cx + w as u16 > self.width {
                break;
            }
            self.set_cluster(cx, y, &cluster, style.clone());
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
                symbol: None,
                style: style.clone(),
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
            symbol: None,
            style,
            width: w,
        };
        true
    }

    /// Write one grapheme cluster at content position (`x`, `y`) through
    /// `region`, occupying [`Cluster::width`] columns as one logical glyph.
    ///
    /// A 2-column cluster is written only when both of its columns land
    /// inside the clip (and the buffer); otherwise it is dropped whole, never
    /// split mid-cluster. The lead cell carries the cluster's full symbol; a
    /// masked continuation cell covers the second column. Zero-width clusters
    /// (lone combining marks) write nothing. Returns `false` when nothing was
    /// written.
    pub fn set_cluster_region(
        &mut self,
        x: i32,
        y: i32,
        cluster: &Cluster<'_>,
        style: Style,
        region: Region,
    ) -> bool {
        let w = cluster.width;
        if w == 0 {
            return false;
        }
        let ch = cluster.lead();
        let symbol = cluster.symbol();
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
                symbol,
                style: style.clone(),
                width: 2,
            };
            self.cells[i + 1] = Cell::mask(style);
            return true;
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
            symbol,
            style,
            width: 1,
        };
        true
    }

    /// Write a string through `region` starting at content position (`x`,
    /// `y`), advancing the cursor by each grapheme cluster's display width.
    /// Writing stops at the clip rect's right edge (in buffer coordinates) so
    /// no cluster is ever truncated mid-glyph: a cluster that does not fit
    /// whole is dropped whole. Zero-width clusters (lone combining marks) are
    /// skipped, as in [`set_string`](Self::set_string).
    ///
    /// ANSI/OSC/CSI escape sequences are stripped at ingestion
    /// ([`strip_escapes`](crate::cell::strip_escapes)), exactly as in
    /// [`set_string`](Self::set_string).
    pub fn set_string_region(&mut self, x: i32, y: i32, text: &str, style: Style, region: Region) {
        let text = strip_escapes(text);
        let mut cx = x;
        for cluster in clusters(&text) {
            let w = cluster.width;
            if w == 0 {
                continue;
            }
            // Stop when this glyph would cross the clip's right edge (buffer
            // coordinates) — mirrors set_string's right-edge behaviour.
            let bx = region.map_x(cx);
            if bx + w as i32 > region.clip.right() {
                break;
            }
            self.set_cluster_region(cx, y, &cluster, style.clone(), region);
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
        // added on top of the cell's own (e.g. REVERSED on a bold title). The
        // clone preserves the cell's style — including its hyperlink.
        cell.style = cell
            .style
            .clone()
            .fg(fg)
            .bg(bg)
            .add_modifier(cursor.style.modifiers);
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
            cells[dst..dst + copy_w].clone_from_slice(&self.cells[src..src + copy_w]);
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

    /// Extract the text content of `rect` as a string, row-major: each row
    /// contributes its cells' full cluster symbols ([`Cell::symbol_str`]) —
    /// a multi-char cluster (a ZWJ emoji, a combining sequence, a flag)
    /// contributes its whole symbol, and a masked continuation cell (the
    /// zero-width right half of a 2-column glyph) contributes nothing — and
    /// the rows are joined with `'\n'`.
    ///
    /// `rect` is clipped to the buffer: columns/rows outside it contribute
    /// nothing, so the extraction never reads past the buffer's extent. An
    /// empty or wholly out-of-bounds rect yields an empty string. The
    /// result is the exact cell content — trailing blank cells (default
    /// spaces) are preserved, matching what is painted.
    pub fn text_in(&self, rect: Rect) -> String {
        let x0 = rect.x.max(0) as u16;
        let y0 = rect.y.max(0) as u16;
        let x1 = rect.right().min(self.width as i32).max(0) as u16;
        let y1 = rect.bottom().min(self.height as i32).max(0) as u16;
        if x1 <= x0 || y1 <= y0 {
            return String::new();
        }
        let mut out = String::new();
        for y in y0..y1 {
            if y > y0 {
                out.push('\n');
            }
            for x in x0..x1 {
                let Some(cell) = self.cell(x, y) else {
                    continue;
                };
                if cell.is_masked() {
                    continue;
                }
                out.push_str(&cell.symbol_str());
            }
        }
        out
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
///
/// Fast path: each row is first compared as a whole [`Cell`] slice. An
/// identical row (or a row that is blank in a region `prev` does not cover)
/// is skipped entirely, so the per-cell scan only runs on rows that actually
/// changed — the common case between frames.
pub fn diff(prev: &Buffer, next: &Buffer) -> Vec<CellUpdate> {
    let mut updates = Vec::new();
    let prev_w = prev.width as usize;
    let next_w = next.width as usize;
    for y in 0..next.height {
        // Row-skip fast path: when the whole row matches between prev and
        // next (or is blank in a region prev does not cover), no cell in the
        // row can change, so the per-cell scan below is skipped entirely.
        let row_start = y as usize * next_w;
        let next_row = &next.cells[row_start..row_start + next_w];
        let row_changed = if y < prev.height {
            let prev_row = &prev.cells[y as usize * prev_w..][..prev_w];
            let common = prev_w.min(next_w);
            if prev_row[..common] != next_row[..common] {
                true
            } else if next_w > prev_w {
                // Cells in this row beyond prev's width compare against blank.
                next_row[prev_w..].iter().any(|c| c != &Cell::default())
            } else {
                false
            }
        } else {
            // Rows below prev's extent compare against blank; only non-blank
            // cells emit, so a wholly blank row is skipped.
            next_row.iter().any(|c| c != &Cell::default())
        };
        if !row_changed {
            continue;
        }

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
                        symbol: n.symbol.clone(),
                        style: n.style.clone(),
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
                                symbol: ncell.symbol.clone(),
                                style: ncell.style.clone(),
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
                        symbol: n.symbol.clone(),
                        style: n.style.clone(),
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
                        symbol: n.symbol.clone(),
                        style: n.style.clone(),
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
mod tests;
