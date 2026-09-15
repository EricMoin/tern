//! Soft-wrap primitives: grapheme-cluster ranges and the token-aware
//! wrap that produces display rows plus their source offsets.

use super::*;

/// The char-index ranges of `line`'s grapheme clusters: one `(start, end)`
/// per cluster (end exclusive, in chars). Clusters are contiguous and
/// non-overlapping, so a char index is either on a boundary (the end of one
/// range equals the start of the next) or inside exactly one range.
pub(super) fn cluster_ranges(line: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for c in clusters(line) {
        let end = start + c.text.chars().count();
        ranges.push((start, end));
        start = end;
    }
    ranges
}

/// The display lines of `line` when soft-wrapped at `width` columns (at
/// least 1).
///
/// Wrapping is greedy and token-aware, mirroring the compositor's
/// streaming-text wrap ([`paint_word`](crate::Compositor)): a whitespace-free
/// token that does not fit on the current display line wraps whole to the
/// next when it can fit there; a token wider than the whole width is
/// hard-broken across display lines, and a single glyph wider than the width
/// is dropped. A trailing space at a full display line is dropped (the wrap
/// would collapse it anyway), and an embedded `\n` ends the display line
/// (defensive — textarea lines normally carry none). A wide glyph is never
/// split.
///
/// ANSI/OSC/CSI escape sequences are invisible to the wrap
/// ([`strip_escapes`]): they occupy no columns and never appear in a display
/// line, so an escape-carrying line wraps identically to its stripped form.
pub fn wrap_line(line: &str, width: usize) -> Vec<String> {
    wrap_line_with_offsets(line, width)
        .into_iter()
        .map(|(text, _)| text)
        .collect()
}

/// [`wrap_line`] plus the char index (within `line`) where each display line
/// starts. The offsets are exact — a character dropped by the wrap (e.g. a
/// trailing space at a full row) belongs to no display line, so a display
/// line's start is its real position in the logical line, which keeps caret
/// row/col navigation consistent with what is painted.
///
/// Escape sequences are stripped first ([`strip_escapes`]): they occupy no
/// columns, never appear in a display line, and are skipped when offsets are
/// counted — the offsets index the escape-free line, so an escape-carrying
/// `line` yields exactly the rows and offsets of its stripped form (for
/// escape-free input they are the input's own indices, unchanged).
pub(super) fn wrap_line_with_offsets(line: &str, width: usize) -> Vec<(String, usize)> {
    let width = width.max(1);
    let line = strip_escapes(line);
    let mut rows: Vec<(String, usize)> = Vec::new();
    let mut row = String::new();
    let mut row_width = 0usize;
    let mut row_start = 0usize;
    let mut token = String::new();
    let mut token_start = 0usize;

    // The char index (within `line`) of the char being processed.
    for (idx, ch) in line.chars().enumerate() {
        match ch {
            // Hard break: flush the pending token, then start a new row.
            '\n' => {
                flush_token(
                    &mut rows,
                    &mut row,
                    &mut row_width,
                    &mut row_start,
                    &token,
                    token_start,
                    width,
                );
                token.clear();
                rows.push((std::mem::take(&mut row), row_start));
                row_width = 0;
                row_start = idx + 1;
            }
            // Soft break: flush the pending token, then place the space only
            // when it fits — a trailing space at a full row is dropped (the
            // wrap would collapse it anyway).
            ' ' => {
                flush_token(
                    &mut rows,
                    &mut row,
                    &mut row_width,
                    &mut row_start,
                    &token,
                    token_start,
                    width,
                );
                token.clear();
                if row_width < width {
                    row.push(' ');
                    row_width += 1;
                }
            }
            _ => {
                if token.is_empty() {
                    token_start = idx;
                }
                token.push(ch);
            }
        }
    }
    flush_token(
        &mut rows,
        &mut row,
        &mut row_width,
        &mut row_start,
        &token,
        token_start,
        width,
    );
    rows.push((std::mem::take(&mut row), row_start));
    if rows.is_empty() {
        rows.push((String::new(), 0));
    }
    rows
}

/// Place a pending whitespace-free token onto the current display line,
/// mirroring the compositor's `paint_word`: the token wraps whole to a fresh
/// row when it does not fit the current row and can fit a fresh one; a token
/// wider than the whole width hard-breaks across rows (never splitting a wide
/// glyph), and a single glyph wider than the width is dropped. Row starts
/// track the wrap exactly (a dropped glyph advances the next row's start).
fn flush_token(
    rows: &mut Vec<(String, usize)>,
    row: &mut String,
    row_width: &mut usize,
    row_start: &mut usize,
    token: &str,
    token_start: usize,
    width: usize,
) {
    if token.is_empty() {
        return;
    }
    let token_width: usize = token.chars().map(|c| char_width(c) as usize).sum();
    if !row.is_empty() && *row_width + token_width > width && token_width <= width {
        rows.push((std::mem::take(row), *row_start));
        *row_width = 0;
        *row_start = token_start;
    }
    // The char index (within `line`) of the current token char.
    let mut cur = token_start;
    for ch in token.chars() {
        let w = char_width(ch) as usize;
        if w == 0 {
            cur += 1;
            continue;
        }
        if *row_width + w > width {
            rows.push((std::mem::take(row), *row_start));
            *row_width = 0;
            if w > width {
                cur += 1; // a glyph wider than a fresh row is dropped
                *row_start = cur;
                continue;
            }
            *row_start = cur; // the wrapped row starts at this char
        }
        row.push(ch);
        *row_width += w;
        cur += 1;
    }
}
