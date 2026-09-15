//! Text measurement: display width, word-boundary soft wrap, and the
//! taffy rect adapter.

use super::*;

/// Display width of a string in terminal cells: the sum of its grapheme
/// clusters' widths (multi-width aware, cluster-indivisible — a ZWJ emoji
/// measures 2 columns, a combining sequence measures 1). Mirrors the
/// compositor's `display_width` so a text leaf's laid-out size agrees with
/// what its paint pass draws. ANSI/OSC/CSI escape sequences are stripped
/// first ([`strip_escapes`](tern_core::cell::strip_escapes)), so a styled
/// text leaf measures its visible glyphs only.
pub(super) fn display_width(content: &str) -> usize {
    clusters(&strip_escapes(content)).map(|c| c.width as usize).sum()
}

/// The wrapped content size of `content` laid out at `width` cells: the
/// display width of the widest wrapped line and the wrapped line count.
///
/// The wrap model mirrors the compositor's `measure_wrapped` exactly (so
/// layout, paint, and `content_size` agree on the same rows): a token (a
/// whitespace-free run) that does not fit on the current row wraps whole to
/// the next row when it fits a fresh one; a token wider than the whole row is
/// hard-broken across rows; a `\n`/`\r\n` forces a break; a trailing space at
/// a row's end is dropped. Breaking is grapheme-cluster aware — a cluster
/// never splits across rows. An empty content reports `(0, 0)`.
pub(super) fn measure_wrapped(content: &str, width: u32) -> (u32, u32) {
    if content.is_empty() {
        // An empty text leaf still occupies ONE row — the layout counterpart
        // of a blank terminal line (and the reason an empty `<Text>` spacer
        // keeps its row instead of collapsing the column layout). Mirrors
        // the compositor's `measure_wrapped` empty rule.
        return (0, 1);
    }
    let width = width.max(1);
    let mut lines: u32 = 1;
    let mut max_col: u32 = 0;
    let mut col: u32 = 0;
    let mut word = String::new();
    let content = strip_escapes(content);
    for cluster in clusters(&content) {
        match cluster.text {
            "\n" | "\r\n" => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                lines += 1;
                col = 0;
            }
            " " => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                // A trailing space at a row's end is dropped (the wrap would
                // collapse it anyway), mirroring the compositor.
                if col < width {
                    col += 1;
                    max_col = max_col.max(col);
                }
            }
            _ => word.push_str(cluster.text),
        }
    }
    flush_word(&word, width, &mut col, &mut lines, &mut max_col);
    (max_col, lines)
}

/// Place one pending token onto the wrapped measurement, applying the same
/// wrap rule as the compositor's `flush_word`: whole-token wrap when it does
/// not fit the current row but fits a fresh one, hard cluster-by-cluster
/// break when the token is wider than the whole row.
fn flush_word(word: &str, width: u32, col: &mut u32, lines: &mut u32, max_col: &mut u32) {
    if word.is_empty() {
        return;
    }
    let tw = display_width(word) as u32;
    if tw <= width {
        if *col > 0 && *col + tw > width {
            *lines += 1;
            *col = 0;
        }
        *col += tw;
        *max_col = (*max_col).max(*col);
        return;
    }
    for cluster in clusters(&strip_escapes(word)) {
        let w = cluster.width as u32;
        if w == 0 {
            continue;
        }
        if *col + w > width {
            *lines += 1;
            *col = 0;
        }
        *col += w;
        *max_col = (*max_col).max(*col);
    }
}

/// Map a taffy `Layout` (relative to its parent, so already in scene
/// coordinates) back to a tern-core `Rect`.
pub(super) fn layout_to_rect(layout: &TaffyLayout) -> Rect {
    Rect::new(
        layout.location.x.round() as i32,
        layout.location.y.round() as i32,
        layout.size.width.round() as u32,
        layout.size.height.round() as u32,
    )
}
