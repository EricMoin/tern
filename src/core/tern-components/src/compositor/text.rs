//! Text and streaming-text painting, soft-wrap, and measurement.

use super::*;

/// Paint a text leaf's content starting at its rect origin, through `region`
/// (the content is shifted by the region's scroll offset and clipped to its
/// clip rect — and to the buffer).
///
/// A wrap-enabled leaf (wrap unset or `true`) paints **one row per wrapped
/// soft line**: a `\n`/`\r\n` forces a row break and long content soft-wraps
/// at word boundaries exactly like `paint_streaming_text` (the same
/// `paint_word` token-aware model), so layout, `content_size`, and paint all
/// agree on the same rows. A `wrap: false` leaf paints its content as one
/// single row trimmed at the right edge. Text advances grapheme cluster by
/// cluster: a cluster that would straddle the right edge wraps whole to the
/// next row — or is dropped whole when it cannot fit a fresh row either (a
/// ZWJ emoji or a combining sequence stays whole, never split mid-cluster).
/// ANSI/OSC/CSI escape sequences are stripped at ingestion
/// ([`strip_escapes`](tern_core::cell::strip_escapes)): they occupy no
/// columns and never reach the buffer.
///
/// When the node carries a `caret` Int prop (a display-column offset — the
/// [`Input`](crate::Input) component stamps it), the block caret is painted
/// over the cell under the cursor using the node's own style reversed, via
/// tern-core's [`Buffer::render_caret`] (subtask 3's caret machinery). The
/// caret is painted even over the placeholder when the text is empty, and it
/// always rides the leaf's first row — display rows below it wrap, the caret
/// stays on row 1. The caret position is mapped through the region like any
/// other cell, so a scrolled/clipped text leaf scrolls its caret along with
/// its content.
pub(super) fn paint_text(
    node: &SceneNode,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    parent_clip_right: Option<i32>,
) {
    // A rect with no interior rows (zero height) has no painted extent — its
    // cells are bounded by the rect mapped through the region, and the dirty
    // union is built from exactly those mapped rects, so a node must never
    // paint outside them (mirrors `paint_streaming_text`'s `bottom <= rect.y`
    // guard). Without this, a zero-height text leaf would still paint its row
    // in a full paint while the incremental path — whose union can prove
    // nothing about a zero-height rect — would skip it.
    if rect.bottom() <= rect.y {
        return;
    }
    if let Some(PropValue::Str(content)) = node.props.get("text") {
        let content = strip_escapes(content);
        if wrap_enabled(node) {
            paint_text_wrapped(&content, node.style.clone(), rect, region, buffer);
        } else {
            let ellipsis = matches!(node.props.get("ellipsis"), Some(PropValue::Bool(true)));
            paint_text_single_row(&content, node.style.clone(), rect, region, buffer, ellipsis, parent_clip_right);
        }
    }

    if let Some(PropValue::Int(caret_col)) = node.props.get("caret") {
        let cx = rect.x + *caret_col as i32;
        let cy = rect.y;
        if region.contains(cx, cy) {
            let bx = region.map_x(cx);
            let by = region.map_y(cy);
            if bx >= 0 && by >= 0 {
                let caret_style = node.style.clone().add_modifier(Modifiers::REVERSED);
                let cursor = Cursor::new(bx as u16, by as u16).styled(caret_style);
                buffer.render_caret(cursor);
            }
        }
    }
}

/// Paint a wrap-enabled text leaf's content at the rect origin, one row per
/// wrapped soft line, through `region` — the `Text` counterpart of
/// `paint_streaming_text`'s wrap pass. A `\n`/`\r\n` forces a row break; a
/// token (a whitespace-free run) that does not fit the current row wraps
/// whole to the next row when it fits a fresh one; a token wider than the
/// whole row is hard-broken across rows; a trailing space at a row's end is
/// dropped. A wide glyph that would straddle the right edge — or that is
/// wider than the row itself — wraps to the next row, or is dropped whole
/// when it cannot fit a fresh row either; a cluster is never split
/// mid-glyph. Painting stops at the rect's bottom edge; rows whose mapped
/// position falls outside the node's own frame are skipped, so scrolled
/// content stays inside the pane (see [`row_inside_frame`]).
pub(super) fn paint_text_wrapped(content: &str, style: Style, rect: Rect, region: Region, buffer: &mut Buffer) {
    let right = rect.right().min(region.clip.right() + region.scroll_x);
    // Content rows pan inside the node's own frame: the last content row that
    // can map into the frame is `rect.bottom() + scroll_y - 1`, so the layout
    // runs rows up to (exclusive) that bound. Rows whose mapped position
    // falls outside the frame are skipped at paint time.
    let bottom = rect.bottom() + region.scroll_y;
    if right <= rect.x || bottom <= rect.y {
        return;
    }

    let mut cursor = WrapCursor {
        row: rect.y,
        col: rect.x,
    };
    let mut word = String::new();
    for cluster in clusters(content) {
        match cluster.text {
            // Hard break: flush the pending word, then start a new row.
            // CRLF is a single grapheme cluster and breaks like LF.
            "\n" | "\r\n" => {
                paint_word(&word, style.clone(), rect, &mut cursor, region, buffer, false);
                word.clear();
                cursor.row += 1;
                cursor.col = rect.x;
                if cursor.row >= bottom {
                    return;
                }
            }
            // Soft break: flush the pending word, then place the space only
            // when it fits; a trailing space at a row's end is dropped (the
            // wrap would collapse it anyway).
            " " => {
                paint_word(&word, style.clone(), rect, &mut cursor, region, buffer, false);
                word.clear();
                if cursor.row < bottom && cursor.col < right {
                    buffer.set_char_region(cursor.col, cursor.row, ' ', style.clone(), region);
                    cursor.col += 1;
                }
            }
            _ => word.push_str(cluster.text),
        }
    }
    paint_word(&word, style.clone(), rect, &mut cursor, region, buffer, false);
}

/// Paint a `wrap: false` text leaf as a single row at the rect origin: the
/// content paints left-to-right on `rect.y`, and the line is trimmed at the
/// right edge (`right`), dropping any glyph that would straddle it — never
/// split mid-glyph, multi-width aware. A hard `\n` ends the line (there is no
/// next row in single-row mode). The row is drawn through `region` like any
/// other cell.
///
/// When `ellipsis` is true and the content is trimmed (or would run past the
/// right edge), the last visible cell paints the `…` glyph instead — the
/// single-row truncation affordance (status bars, headers). The ellipsis is
/// only drawn when something was actually cut off; content that fits exactly
/// paints unchanged.
pub(super) fn paint_text_single_row(
    content: &str,
    style: Style,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    ellipsis: bool,
    clip_right: Option<i32>,
) {
    // The single row must land inside the clip (mirrors the pre-wrap guard).
    let y = rect.y;
    if region.map_y(y) < region.clip.y
        || region.map_y(y) >= region.clip.bottom()
        || region.clip.bottom() <= region.clip.y
    {
        return;
    }
    let right = rect
        .right()
        .min(region.clip.right() + region.scroll_x)
        .min(clip_right.unwrap_or(i32::MAX));
    if right <= rect.x {
        return;
    }
    let mut cx = rect.x;
    let mut truncated = false;
    for cluster in clusters(content) {
        // single-row: a hard newline ends the line — the content up to it
        // was painted in full, so no ellipsis.
        if cluster.text == "\n" || cluster.text == "\r\n" {
            return;
        }
        let w = cluster.width;
        if w == 0 {
            continue;
        }
        // Trim: a glyph at (or past) the right edge, or one that would
        // straddle it, is dropped whole (never mid-cluster); nothing after
        // it fits either.
        if cx >= right || cx + w as i32 > right {
            truncated = true;
            break;
        }
        if cx >= 0 {
            buffer.set_cluster_region(cx, y, &cluster, style.clone(), region);
        }
        cx += w as i32;
    }
    // The truncation affordance: content was cut off, so the last visible
    // cell reports it with `…` (overwriting whatever glyph it held).
    if truncated && ellipsis && right - 1 >= rect.x {
        buffer.set_char_region(right - 1, y, '…', style, region);
    }
}

/// The cursor for a streaming-text paint pass: the next row and column to
/// paint at, in scene coordinates.
pub(super) struct WrapCursor {
    row: i32,
    col: i32,
}

/// Whether a text/streaming node soft-wraps its content: false only when the
/// node explicitly declares `wrap: false`. Absent or `wrap: true` keeps the
/// word-boundary soft-wrap (the default behavior).
pub(super) fn wrap_enabled(node: &SceneNode) -> bool {
    !matches!(node.props.get("wrap"), Some(PropValue::Bool(false)))
}

/// Paint a `StreamingText` leaf: its accumulated stream spans are
/// concatenated in order and painted into the rect starting at its origin,
/// one row per wrapped soft line, through `region` (shifted by the region's
/// scroll offset, clipped to its clip rect and the buffer).
///
/// Wrapping is greedy and token-aware: a token (a whitespace-free run) that
/// does not fit on the current row wraps whole to the next row; a token wider
/// than the whole rect is hard-broken across rows. Each span paints with its
/// own style (fg/bg/modifiers); span boundaries are flush points so one span's
/// style never bleeds into the next. A wide character that would straddle the
/// right edge — or that is wider than the row itself — is dropped, never split
/// mid-glyph. Painting stops at the rect's bottom edge; both edges are clipped
/// to the region and the buffer. ANSI/OSC/CSI escape sequences are stripped
/// at ingestion ([`strip_escapes`](tern_core::cell::strip_escapes)): they
/// occupy no columns and never reach the buffer, so measurement and painting
/// agree by construction.
///
/// A node with `wrap: false` instead paints its whole stream as one
/// single-row line, trimmed at the right edge (see
/// [`paint_streaming_text_single_row`]).
pub(super) fn paint_streaming_text(
    node: &SceneNode,
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    parent_clip_right: Option<i32>,
) {
    let Some(stream) = node.stream.as_deref() else {
        return;
    };
    if stream.is_empty() {
        return;
    }
    if !wrap_enabled(node) {
        let ellipsis = matches!(node.props.get("ellipsis"), Some(PropValue::Bool(true)));
        return paint_streaming_text_single_row(stream, rect, region, buffer, ellipsis, parent_clip_right);
    }
    let right = rect.right().min(region.clip.right() + region.scroll_x);
    // Content rows pan inside the node's own frame: the last content row that
    // can map into the frame is `rect.bottom() + scroll_y - 1`, so the layout
    // runs rows up to (exclusive) that bound. Rows whose mapped position
    // falls outside the frame are skipped at paint time (see
    // [`row_inside_frame`]).
    let bottom = rect.bottom() + region.scroll_y;
    if right <= rect.x || bottom <= rect.y {
        return;
    }

    let mut cursor = WrapCursor {
        row: rect.y,
        col: rect.x,
    };
    let mut word = String::new();
    let mut word_style = Style::new();

    for span in stream {
        let text = strip_escapes(&span.text);
        for cluster in clusters(&text) {
            match cluster.text {
                // Hard break: flush the pending word, then start a new row.
                // CRLF is a single grapheme cluster and breaks like LF.
                "\n" | "\r\n" => {
                    paint_word(&word, word_style.clone(), rect, &mut cursor, region, buffer, true);
                    word.clear();
                    cursor.row += 1;
                    cursor.col = rect.x;
                    if cursor.row >= bottom {
                        return;
                    }
                }
                // Soft break: flush the pending word, then place the space
                // only when it fits; a trailing space at a row's end is
                // dropped (the wrap would collapse it anyway).
                " " => {
                    paint_word(&word, word_style.clone(), rect, &mut cursor, region, buffer, true);
                    word.clear();
                    if cursor.row < bottom
                        && cursor.col < right
                        && row_inside_frame(rect, region, cursor.row)
                    {
                        buffer.set_char_region(cursor.col, cursor.row, ' ', span.style.clone(), region);
                        cursor.col += 1;
                    }
                }
                _ => {
                    if word.is_empty() {
                        word_style = span.style.clone();
                    }
                    word.push_str(cluster.text);
                }
            }
        }
        // Span boundary: flush so per-span styles stay exact across spans.
        paint_word(&word, word_style.clone(), rect, &mut cursor, region, buffer, true);
        word.clear();
        if cursor.row >= bottom {
            return;
        }
    }
}

/// Paint a `wrap: false` stream as a single row at the rect's origin: the
/// concatenated spans paint left-to-right on `rect.y`, and the line is
/// trimmed at the right edge (`right`), dropping any glyph that would straddle
/// it — never split mid-glyph, multi-width aware. A hard `\n` ends the line
/// (there is no next row in single-row mode). Each span paints with its own
/// style; the row is drawn through `region` like any other cell.
pub(super) fn paint_streaming_text_single_row(
    stream: &[Span],
    rect: Rect,
    region: Region,
    buffer: &mut Buffer,
    ellipsis: bool,
    clip_right: Option<i32>,
) {
    // A zero-height rect has no painted extent (see the `paint_text` guard).
    if rect.bottom() <= rect.y {
        return;
    }
    let right = rect
        .right()
        .min(region.clip.right() + region.scroll_x)
        .min(clip_right.unwrap_or(i32::MAX));
    if right <= rect.x {
        return;
    }
    // The single row must land inside the clip (mirrors paint_text's guard).
    if region.map_y(rect.y) < region.clip.y
        || region.map_y(rect.y) >= region.clip.bottom()
        || region.clip.bottom() <= region.clip.y
    {
        return;
    }
    let mut cx = rect.x;
    let mut truncated = false;
    // The style of the span whose content was cut off — the ellipsis paints
    // with it.
    let mut trim_style = Style::new();
    for span in stream {
        let text = strip_escapes(&span.text);
        for cluster in clusters(&text) {
            if cluster.text == "\n" || cluster.text == "\r\n" {
                return; // single-row: the line ends here
            }
            let w = cluster.width;
            if w == 0 {
                continue;
            }
            // Trim: a glyph at (or past) the right edge, or one that would
            // straddle it, is dropped whole (never mid-cluster); nothing
            // after it fits either.
            if cx >= right || cx + w as i32 > right {
                truncated = true;
                trim_style = span.style.clone();
                break;
            }
            buffer.set_cluster_region(cx, rect.y, &cluster, span.style.clone(), region);
            cx += w as i32;
        }
        if truncated {
            break;
        }
    }
    if truncated && ellipsis && right - 1 >= rect.x {
        buffer.set_char_region(right - 1, rect.y, '…', trim_style, region);
    }
}

/// Whether a content row at scene row `row` is visible inside the node's own
/// frame after the region's scroll: its mapped position must land within the
/// frame's vertical extent `[rect.y, rect.bottom())`. Rows that pan above or
/// below the frame are skipped (the frame's background/border are painted by
/// the box itself, through a scroll-free region).
pub(super) fn row_inside_frame(rect: Rect, region: Region, row: i32) -> bool {
    let mapped = region.map_y(row);
    mapped >= rect.y && mapped < rect.bottom()
}

/// The display width of a string in terminal cells: the sum of its grapheme
/// clusters' widths (multi-width aware, cluster-indivisible). ANSI/OSC/CSI
/// escape sequences are stripped first ([`strip_escapes`]), so they occupy
/// no columns — measurement and the paint pass agree by construction.
pub(super) fn display_width(content: &str) -> u32 {
    clusters(&strip_escapes(content)).map(|c| c.width as u32).sum()
}

/// The wrapped content size of `content` laid out at `width` cells: the
/// display width of the widest wrapped line and the wrapped line count.
///
/// Wrapping mirrors the streaming-text paint pass (`paint_word`): a token (a
/// whitespace-free run) that does not fit on the current row wraps whole to
/// the next row when it fits a fresh row; a token wider than the whole row is
/// hard-broken across rows; a `\n` forces a break; a trailing space at a row's
/// end is dropped. The reported width can therefore be narrower than the
/// content's total display width (wrapped rows), and an empty content reports
/// `(0, 0)` — no content, no size. Breaking is grapheme-cluster aware: a
/// cluster never splits across rows.
pub(super) fn measure_wrapped(content: &str, width: u32) -> (u32, u32) {
    if content.is_empty() {
        // An empty text leaf still occupies ONE row — the layout counterpart
        // of a blank terminal line (and the reason an empty `<Text>` spacer
        // keeps its row instead of collapsing the column layout).
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
                // collapse it anyway), mirroring paint_streaming_text.
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
/// wrap rule as [`paint_word`]: whole-token wrap when it does not fit the
/// current row but fits a fresh one, hard cluster-by-cluster break when the
/// token is wider than the whole row.
pub(super) fn flush_word(word: &str, width: u32, col: &mut u32, lines: &mut u32, max_col: &mut u32) {
    if word.is_empty() {
        return;
    }
    let tw = display_width(word);
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

/// Paint one whitespace-free token with `style` at the cursor, soft-wrapping
/// at `right` (column, exclusive) and clipping below `bottom` (row,
/// exclusive), through `region`.
///
/// A token that does not fit on the current row (which already holds content)
/// moves whole to the next row; a token wider than the whole row is
/// hard-broken across rows. Text advances grapheme cluster by cluster: a
/// cluster that would straddle `right` — or that is wider than the row itself
/// — wraps whole to the next row, or is dropped whole when it cannot fit a
/// fresh row either; a cluster is never split mid-cluster (a ZWJ emoji stays
/// a single 2-column glyph). The cursor advances past every token glyph,
/// including dropped ones. Each glyph is drawn via
/// [`Buffer::set_cluster_region`], so it is also shifted by the region's
/// scroll and clipped to its clip rect.
///
/// `frame_check` gates the [`row_inside_frame`] test: a streaming leaf's
/// content rows pan inside its own frame, so its rows are skipped when their
/// mapped position falls outside the frame (scrolled content stays inside the
/// pane). A text leaf paints its wrapped rows at its own rect rows (bounded
/// by `bottom` and the region clip, exactly like the single-row painter), so
/// its rows never frame-check.
pub(super) fn paint_word(
    word: &str,
    style: Style,
    frame: Rect,
    cursor: &mut WrapCursor,
    region: Region,
    buffer: &mut Buffer,
    frame_check: bool,
) {
    let line_start = frame.x;
    if word.is_empty() {
        return;
    }
    // Paint bounds derived from frame + region exactly as the caller does:
    // right clips at the region's right edge (plus horizontal scroll), and
    // the content pan bound runs to the frame's bottom plus vertical scroll.
    let right = frame.right().min(region.clip.right() + region.scroll_x);
    let bottom = frame.bottom() + region.scroll_y;
    let width: i32 = display_width(word) as i32;
    // Wrap the whole token when it does not fit on the current row and can fit
    // on a fresh row; a token wider than the row itself is hard-broken below.
    if cursor.col > line_start && cursor.col + width > right && width <= right - line_start {
        cursor.row += 1;
        cursor.col = line_start;
        if cursor.row >= bottom {
            return;
        }
    }
    for cluster in clusters(&strip_escapes(word)) {
        let w = cluster.width;
        if w == 0 {
            continue;
        }
        if cursor.col + w as i32 > right {
            // Does not fit on this row: wrap. A wide glyph that still cannot
            // fit on a fresh row (wider than the row) is dropped whole.
            cursor.row += 1;
            cursor.col = line_start;
            if cursor.row >= bottom {
                return;
            }
            if cursor.col + w as i32 > right {
                return;
            }
        }
        if !frame_check || row_inside_frame(frame, region, cursor.row) {
            buffer.set_cluster_region(cursor.col, cursor.row, &cluster, style.clone(), region);
        }
        cursor.col += w as i32;
    }
}
