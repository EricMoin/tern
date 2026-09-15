//! Mouse text selection: the selection overlay, its text, and the
//! word-under-pointer range.

use super::*;

#[napi]
impl TuiRenderer {

/// Set the selection overlay to the inclusive rectangle spanned by
/// (`col1`, `row1`) and (`col2`, `row2`) in viewport cells. The endpoints
/// are normalized by the compositor, so either may be the top-left. The
/// overlay is applied at the next [`render`](Self::render) (which the
/// selection edit forces) and to the next
/// [`render_to_buffer`](Self::render_to_buffer) snapshot. Per-renderer
/// state — the shared scene never carries the selection. Errors on a
/// destroyed renderer.
#[napi(js_name = "set_selection")]
pub fn set_selection(&self, col1: u32, row1: u32, col2: u32, row2: u32) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    inner.selection = Some((col1 as u16, row1 as u16, col2 as u16, row2 as u16));
    Ok(())
}

/// Clear the selection overlay: the next render paints without any
/// reversed selection cells (and the next snapshot omits the overlay).
/// Errors on a destroyed renderer.
#[napi(js_name = "clear_selection")]
pub fn clear_selection(&self) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    inner.selection = None;
    Ok(())
}

/// The text of the renderer's current selection, extracted from the last
/// painted frame (the frame the most recent [`render`](Self::render)
/// produced): row-major and cluster/mask-aware — a multi-char cluster
/// (ZWJ emoji, combining sequence, flag) contributes its whole symbol, a
/// masked continuation cell contributes nothing, and rows are joined
/// with `'\n'`. An empty string when no selection is set or nothing has
/// been rendered yet. Errors on a destroyed renderer.
#[napi(js_name = "selection_text")]
pub fn selection_text(&self) -> Result<String> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    let Some((x1, y1, x2, y2)) = inner.selection else {
        return Ok(String::new());
    };
    let Some(last) = &inner.last else {
        return Ok(String::new());
    };
    let (ax, ay) = (x1.min(x2), y1.min(y2));
    let (bx, by) = (x1.max(x2), y1.max(y2));
    let rect = Rect::new(ax as i32, ay as i32, (bx - ax) as u32 + 1, (by - ay) as u32 + 1);
    Ok(last.text_in(rect))
}

/// The inclusive cell range of the contiguous non-whitespace run (word)
/// containing (`col`, `row`) in the last painted frame, or `null` when
/// the cell is blank/whitespace (or out of bounds, or nothing has been
/// rendered yet).
///
/// Cluster-aware: a masked continuation cell (the right half of a wide
/// glyph) is treated as part of its glyph's run — never as whitespace —
/// so a click on a wide character's second column still returns the word
/// that contains the glyph. Errors on a destroyed renderer.
#[napi(js_name = "selection_word_range")]
pub fn selection_word_range(&self, col: u32, row: u32) -> Result<Option<SelectionRange>> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    let Some(last) = &inner.last else {
        return Ok(None);
    };
    if col >= last.width as u32 || row >= last.height as u32 {
        return Ok(None);
    }
    let col = col as u16;
    let row = row as u16;
    // A word cell is any non-whitespace symbol; a masked continuation
    // cell's symbol is NUL (never whitespace), so the run extends across
    // wide glyphs' right halves to cover the whole glyph.
    let is_word = |x: u16| -> bool {
        let Some(cell) = last.cell(x, row) else {
            return false;
        };
        !cell.symbol_str().chars().all(|c| c.is_whitespace())
    };
    if !is_word(col) {
        return Ok(None);
    }
    let mut left = col;
    while left > 0 && is_word(left - 1) {
        left -= 1;
    }
    let mut right = col;
    while right + 1 < last.width && is_word(right + 1) {
        right += 1;
    }
    Ok(Some(SelectionRange {
        col1: left as u32,
        row1: row as u32,
        col2: right as u32,
        row2: row as u32,
    }))
}

}
