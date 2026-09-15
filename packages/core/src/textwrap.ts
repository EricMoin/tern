//! Text measurement and the textarea display-row windowing seam: cell
//! width, soft wrap, and the display-row math a textarea windows its
//! composition with.
//!
//! This is the one home of the framework's own row semantics — the JS mirror
//! of the Rust `wrap_line` ({@link wrapLineWithOffsets}), the row count the
//! compositor composes ({@link measureText}), and the row/caret/window maps
//! ({@link wrapCount} / {@link displayBase} / {@link logicalAtDisplayRow} /
//! {@link visibleScroll} and the caret-column helpers). Everything here is
//! exported from the package root so an application that keeps its own index
//! over a large buffer — a prefix sum of display-row counts, say — reuses
//! these functions instead of re-deriving them: the weights it sums are
//! {@link wrapCount}, the positions it maps are {@link logicalAtDisplayRow}
//! and {@link offsetOfCol}, and the window it scrolls is
//! {@link visibleScroll} — the same row math `Textarea` itself calls, so a
//! consumer's index and the framework's composition cannot drift apart.

import { clusterRuns, columnToIndex, indexToColumn, stripEscapes, strippedIndexAt } from "./textutil.ts";

/**
 * The soft-wrap width of a textarea's props in cells, or `null` when no
 * width is set — the "no width" convention the whole measurement path
 * shares ({@link wrapLineWithOffsets} keeps each logical line on one
 * display row, {@link measureText} counts one row per line: a non-finite or
 * non-positive width maps to `null`, and a fractional width floors).
 */
export function textareaWidth(props: { width?: number }): number | null {
  const w = props.width;
  return typeof w === "number" && Number.isFinite(w) && w > 0
    ? Math.floor(w)
    : null;
}

/** The visible window of a textarea's props in display rows, or `null` when
 * unset — the "no window" convention ({@link visibleScroll} is a no-op, so
 * every display row is composed): a non-finite or non-positive height maps
 * to `null`, and a fractional height floors. */
export function textareaHeight(props: { height?: number }): number | null {
  const h = props.height;
  return typeof h === "number" && Number.isFinite(h) && h > 0
    ? Math.floor(h)
    : null;
}

/** The total display width of a string in terminal columns — the sum of its
 * grapheme clusters' widths (a ZWJ emoji counts 2, never per code point).
 * Escape sequences consume zero cells (stripped at ingestion by
 * {@link clusterRuns}), so a colored string measures exactly as its plain
 * text. */
export function textWidth(text: string): number {
  let width = 0;
  for (const run of clusterRuns(text)) width += run.width;
  return width;
}

/**
 * Soft-wrap `line` into display lines of at most `width` columns plus the
 * code-unit index (within `line`) where each display line starts. This is
 * the canonical pre-render measurement — the JS mirror of the Rust
 * `wrap_line` (token-aware greedy wrap): a whitespace-free token that does
 * not fit on the current display line wraps whole to the next when it can
 * fit there; a token wider than the width hard-breaks across rows; a
 * trailing space at a full display line is dropped (the wrap would collapse
 * it anyway); an embedded `\n` ends the display line. Escape sequences
 * (ANSI/OSC/CSI, see {@link stripEscapes}) are stripped at ingestion before
 * wrapping, so they consume zero cells, never break a token, and never
 * appear in a row's `text`. The returned `start` offsets are code-unit
 * indices into the ORIGINAL `line`, translated through the strip map: a row
 * starts at its first visible character's original index, so offsets are
 * exact and never land inside an escape — a stripped escape belongs to no
 * display line, so its bytes sit in the trailing row's original span. A
 * character dropped by the wrap belongs to no display line, so caret
 * navigation stays consistent with what is composed. Downstream consumers
 * count rows at a width through {@link measureText} — never a hand-written
 * mirror — so the measurement cannot drift from what the compositor paints.
 */
export function wrapLineWithOffsets(
  line: string,
  width: number | null,
): Array<{ text: string; start: number }> {
  if (width === null) {
    const stripped = stripEscapes(line);
    return [{ text: stripped.text, start: stripped.orig[0]! }];
  }
  const limit = Math.max(1, Math.floor(width));
  const { text, orig } = stripEscapes(line);
  const rows: Array<{ text: string; start: number }> = [];
  let row = "";
  let rowWidth = 0;
  let rowStart = 0;
  let token = "";
  let tokenStart = 0;
  let idx = 0;

  const flushToken = () => {
    if (token === "") return;
    const tokenWidth = textWidth(token);
    if (row !== "" && rowWidth + tokenWidth > limit && tokenWidth <= limit) {
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = tokenStart;
    }
    // The code-unit index (within the stripped `text`) of the current token
    // cluster; every pushed `start` is translated to the original line
    // through `orig`.
    let cur = tokenStart;
    for (const run of clusterRuns(token)) {
      const w = run.width;
      if (w === 0) {
        cur += run.len;
        continue;
      }
      if (rowWidth + w > limit) {
        rows.push({ text: row, start: orig[rowStart]! });
        row = "";
        rowWidth = 0;
        if (w > limit) {
          cur += run.len; // a cluster wider than a fresh row is dropped whole
          rowStart = cur;
          continue;
        }
        rowStart = cur; // the wrapped row starts at this cluster
      }
      row += run.text;
      rowWidth += w;
      cur += run.len;
    }
    token = "";
  };

  for (const ch of text) {
    if (ch === "\n") {
      flushToken();
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = idx + 1;
    } else if (ch === " ") {
      flushToken();
      if (rowWidth + 1 <= limit) {
        row += " ";
        rowWidth += 1;
      }
    } else {
      if (token === "") tokenStart = idx;
      token += ch;
    }
    idx += ch.length;
  }
  flushToken();
  rows.push({ text: row, start: orig[rowStart]! });
  if (rows.length === 0) rows.push({ text: "", start: 0 });
  return rows;
}

/** The number of display rows `line` occupies at the wrap width (1 when no
 * width is set). */
export function wrapCount(line: string, width: number | null): number {
  return width === null ? 1 : wrapLineWithOffsets(line, width).length;
}

/**
 * Pre-render measurement of `text` at wrap width `width`: how many display
 * rows the text occupies and the widest display-line width in cells. The
 * text is split on `\n` and each logical line is soft-wrapped through
 * {@link wrapLineWithOffsets} — the canonical mirror of the Rust
 * `wrap_line` — so the row count is exactly what the compositor would
 * compose. Escape sequences consume zero cells (stripped at ingestion, see
 * {@link stripEscapes}), so a colored line measures exactly as its plain
 * text. A non-positive (or non-finite) `width` follows the file's "no
 * width" convention (`textareaWidth` maps such widths to `null`): each
 * logical line counts as one display row and the widest display line is the
 * widest logical line. An empty string occupies exactly one empty display
 * row (width 0).
 */
export function measureText(
  text: string,
  width: number,
): { rows: number; maxWidth: number } {
  const wrapWidth = Number.isFinite(width) && width > 0 ? width : null;
  let rows = 0;
  let maxWidth = 0;
  for (const line of text.split("\n")) {
    const wrapped = wrapLineWithOffsets(line, wrapWidth);
    rows += wrapped.length;
    for (const entry of wrapped) {
      const entryWidth = textWidth(entry.text);
      if (entryWidth > maxWidth) maxWidth = entryWidth;
    }
  }
  return { rows, maxWidth };
}

/** The display row where logical line `row` begins. */
export function displayBase(
  lines: string[],
  row: number,
  width: number | null,
): number {
  let base = 0;
  for (let i = 0; i < row; i++) base += wrapCount(lines[i]!, width);
  return base;
}

/** The total number of display rows across all logical lines. */
export function totalDisplayRows(lines: string[], width: number | null): number {
  return lines.reduce((sum, line) => sum + wrapCount(line, width), 0);
}

/** The display-line offset (within `line`'s wrapped lines) that contains the
 * char index `col`. A char dropped by the wrap maps to the display line it
 * trails — and so does an escape-stripped sequence, whose bytes sit inside
 * the trailing row's original span. The check needs no strip map: the rows'
 * original `start`s tile `line` (each row spans `start[i]..start[i+1)`, the
 * last reaching `line.length`), so `col` trails row `i` exactly while it is
 * before row `i+1`'s start. */
export function offsetOfCol(line: string, col: number, width: number | null): number {
  const wrapped = wrapLineWithOffsets(line, width);
  for (let i = 0; i < wrapped.length; i++) {
    const end = i + 1 < wrapped.length ? wrapped[i + 1]!.start : line.length;
    if (col < end) return i;
  }
  return wrapped.length - 1;
}

/** The caret's display row across the whole wrapped text. */
export function caretDisplayRow(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  return displayBase(lines, row, width) + offsetOfCol(lines[row]!, col, width);
}

/** The display column of `col` within display-line `offset` of `line`, and
 * the code-unit index where that display line starts. `col` (an original
 * index) is translated through the strip map first, so a caret resting on —
 * or inside — an escape measures against the visible text only: an escape
 * interior trails its content, exactly like a char dropped by the wrap. */
export function caretDisplayIn(
  line: string,
  col: number,
  offset: number,
  width: number | null,
): { col: number; start: number } {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ??
    { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = Math.max(
    0,
    Math.min(strippedIndexAt(orig, col) - base, entry.text.length),
  );
  return { col: indexToColumn(entry.text, local), start: entry.start };
}

/** The caret's display column within its own display line. */
export function currentDisplayCol(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  const offset = offsetOfCol(lines[row]!, col, width);
  return caretDisplayIn(lines[row]!, col, offset, width).col;
}

/** The `(logical row, display-line offset)` for display row `target`. */
export function logicalAtDisplayRow(
  lines: string[],
  target: number,
  width: number | null,
): { row: number; offset: number } {
  let acc = 0;
  for (let r = 0; r < lines.length; r++) {
    const count = wrapCount(lines[r]!, width);
    if (target < acc + count) return { row: r, offset: target - acc };
    acc += count;
  }
  const last = Math.max(0, lines.length - 1);
  return { row: last, offset: Math.max(0, wrapCount(lines[last]!, width) - 1) };
}

/** The char (code-unit) index into `line` at display column `targetCol`
 * within display-line `offset` (clamped to the display line's end; a column
 * inside a wide glyph snaps to that glyph's start). The cluster boundary is
 * translated back through the strip map, so the returned index is the
 * original position of the visible character — never inside an escape. */
export function charAtDisplayCol(
  line: string,
  offset: number,
  targetCol: number,
  width: number | null,
): number {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ??
    { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = columnToIndex(entry.text, targetCol);
  return orig[base + local]!;
}

/** The scroll offset that keeps the caret's display row inside the visible
 * window (no-op with no height set). */
export function visibleScroll(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
  height: number | null,
  current: number,
): number {
  if (height === null) return 0;
  const h = Math.max(1, height);
  const caret = caretDisplayRow(lines, row, col, width);
  if (caret < current) return caret;
  if (caret >= current + h) return caret + 1 - h;
  return current;
}
