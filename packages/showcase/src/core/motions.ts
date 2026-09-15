//! Motions: where the caret goes — by grapheme, by word, by DISPLAY row.
//
// This is the layer the virtualization work pays off in: a "line down" is a
// DISPLAY ROW down (`LineIndex` geometry), so on a soft-wrapped paragraph it
// walks the wrapped rows of one line, and on a short line after a long one it
// lands where the caret LOOKS like it should. Positions come from the
// framework's own caret math (`offsetOfCol`, `caretDisplayIn`,
// `charAtDisplayCol`) and the wrap cache, never re-derived; nothing here reads
// a key, builds a scene or names a renderer.

import { caretDisplayIn, charAtDisplayCol, offsetOfCol } from "@tern-tui/core";
import type { Buffer, Position } from "./buffer.ts";
import type { LineIndex } from "./lineindex.ts";
import { cellWidth } from "./viewport.ts";
import type { WrapCache } from "./wrapcache.ts";

/** The goal column of a caret with none yet: a real column is a cell count. */
export const NO_GOAL = -1;

/** A vertical motion's goal column, in cells; {@link NO_GOAL} adopts the caret's. */
export type GoalColumn = number;

/** The motion vocabulary. `line-*` are DISPLAY-row motions; `paragraph-*` and
 * `doc-*` are logical-line and document jumps. */
export type Motion =
  | "char-backward" | "char-forward" | "word-backward" | "word-forward"
  | "line-up" | "line-down" | "line-start" | "line-end"
  | "paragraph-backward" | "paragraph-forward" | "doc-start" | "doc-end";

/** What a motion resolves against: the document, its row geometry, its wrap cache. */
export interface MotionContext {
  buffer: Buffer;
  index: LineIndex;
  cache: WrapCache;
}

/** Where a motion left the caret, and the vertical goal it left behind. */
export interface MotionResult {
  position: Position;
  goal: GoalColumn;
}

/**
 * Apply `motion` to `caret` and report the goal column it left behind.
 *
 * A vertical motion has TWO inputs: the row to land on, and the column the user
 * MEANT. Those differ as soon as lines have different lengths, and conflating
 * them is the classic bug where `down` through a short line leaves the caret at
 * column 0 and the next `down` keeps it there. So the intended column is
 * remembered across vertical moves: `line-up` / `line-down` land on the goal,
 * adopting the caret's own display column when `goal` is {@link NO_GOAL};
 * `line-start` pins it to 0 and `line-end` to its row's display width, columns
 * the user chose explicitly; every other motion clears it, because the caret's
 * new column IS the new intent. The goal is returned rather than stored, so the
 * caller owns the caret state and every motion stays pure.
 *
 * Rows come from {@link LineIndex.locate} / `lineToRow` — exact for every line
 * the viewport has measured, the documented estimate for the rest. The incoming
 * caret is clamped in and every motion clamps its own result.
 */
export function applyMotion(
  ctx: MotionContext,
  caret: Position,
  motion: Motion,
  goal: GoalColumn = NO_GOAL,
): MotionResult {
  const from = clampPosition(ctx.buffer, caret);
  switch (motion) {
    case "char-backward": return free(charBackward(ctx.buffer, from));
    case "char-forward": return free(charForward(ctx.buffer, from));
    case "word-backward": return free(wordBackward(ctx.buffer, from));
    case "word-forward": return free(wordForward(ctx.buffer, from));
    case "line-up": return vertical(ctx, from, -1, goal);
    case "line-down": return vertical(ctx, from, 1, goal);
    case "line-start": return rowEdge(ctx, from, "start");
    case "line-end": return rowEdge(ctx, from, "end");
    case "paragraph-backward": return free({ row: paragraphStart(ctx.buffer, from.row, -1), col: 0 });
    case "paragraph-forward": return free({ row: paragraphStart(ctx.buffer, from.row, 1), col: 0 });
    case "doc-start": return free({ row: 0, col: 0 });
    case "doc-end": return free(endOfDocument(ctx.buffer));
  }
}

/** A motion with no vertical goal: the caret's own column is the new intent. */
function free(position: Position): MotionResult {
  return { position, goal: NO_GOAL };
}

/** One DISPLAY row up or down, at the goal column. `locate` turns the target
 * row into `(line, row within that line)` and `charAtDisplayCol` turns the goal
 * into a code-unit index inside it — so a goal past the row's end clamps to the
 * row's end WITHOUT changing the goal, and moving back to a longer row restores
 * the column the user meant: the whole point of the model. */
function vertical(ctx: MotionContext, caret: Position, delta: number, goal: GoalColumn): MotionResult {
  const cell = displayCellOf(ctx, caret);
  const target = clamp(cell.row + delta, 0, Math.max(0, ctx.index.totalRows - 1));
  const column = goal >= 0 ? goal : cell.col;
  if (target === cell.row) return { position: caret, goal: column };
  return { position: positionAtDisplay(ctx, target, column), goal: column };
}

/** The first or last caret slot of the caret's OWN display row (visual home and
 * end), with the goal pinned to the column the user asked for. */
function rowEdge(ctx: MotionContext, caret: Position, edge: "start" | "end"): MotionResult {
  const text = ctx.buffer.lineAt(caret.row);
  const offset = offsetOfCol(text, caret.col, ctx.cache.width);
  const rows = ctx.cache.rowsOf(caret.row, text);
  const row = rows[offset];
  if (edge === "start") return { position: { row: caret.row, col: row?.start ?? 0 }, goal: 0 };
  const next = rows[offset + 1];
  return {
    position: { row: caret.row, col: next === undefined ? text.length : next.start },
    goal: cellWidth(row?.text ?? ""),
  };
}

/** The document's last caret slot. */
function endOfDocument(buffer: Buffer): Position {
  const row = buffer.lineCount - 1;
  return { row, col: buffer.lineAt(row).length };
}

/** Walk a line-at-a-time scan: `step` answers with the column to land on inside
 * the current line, or -1 to hand off to the adjacent line, whose edge column is
 * then the answer — unless `scan` says to run the step there too, which is what
 * separates a word motion (keeps looking) from a character motion (stops). */
function walkLines(
  buffer: Buffer,
  caret: Position,
  direction: -1 | 1,
  step: (text: string, col: number) => number,
  scan: boolean,
): Position {
  let row = caret.row;
  let col = caret.col;
  for (;;) {
    const found = step(buffer.lineAt(row), col);
    if (found >= 0) return { row, col: found };
    const next = row + direction;
    if (next < 0 || next >= buffer.lineCount) {
      return direction < 0 ? { row: 0, col: 0 } : endOfDocument(buffer);
    }
    row = next;
    col = direction < 0 ? buffer.lineAt(row).length : 0;
    if (!scan) return { row, col };
  }
}

/** One grapheme left — vim's `h`. */
function charBackward(buffer: Buffer, caret: Position): Position {
  return walkLines(buffer, caret, -1, (text, col) =>
    col > 0 ? graphemeStartBefore(text, col) : -1, false);
}

/** One grapheme right — vim's `l`. */
function charForward(buffer: Buffer, caret: Position): Position {
  return walkLines(buffer, caret, 1, (text, col) =>
    col < text.length ? graphemeEndAfter(text, col) : -1, false);
}

/** The next word run's start, a line at a time — the vim `w` model: whitespace
 * separates, a run of punctuation is a word of its own, and a line with nothing
 * left hands off to the next line. */
function wordForward(buffer: Buffer, caret: Position): Position {
  return walkLines(buffer, caret, 1, wordStartForward, true);
}

/** The mirror of {@link wordForward}, the vim `b` model. */
function wordBackward(buffer: Buffer, caret: Position): Position {
  return walkLines(buffer, caret, -1, wordStartBackward, true);
}

/** The first line of the next (`direction` 1) or previous (-1) paragraph — a
 * maximal run of non-blank lines — clamped into the document. The backward walk
 * starts one line up, which is what lets a second `paragraph-backward` leave
 * the paragraph the caret is standing on. */
function paragraphStart(buffer: Buffer, row: number, direction: -1 | 1): number {
  const last = buffer.lineCount - 1;
  let line = direction > 0 ? row : row - 1;
  if (direction > 0) {
    while (line <= last && buffer.lineAt(line).trim() !== "") line += 1;
    while (line <= last && buffer.lineAt(line).trim() === "") line += 1;
    return Math.min(line, last);
  }
  while (line >= 0 && buffer.lineAt(line).trim() === "") line -= 1;
  while (line > 0 && buffer.lineAt(line - 1).trim() !== "") line -= 1;
  return Math.max(0, line);
}

/** The caret's absolute display row plus its column in CELLS within it — the
 * row the compositor would paint the caret on, including `offsetOfCol`'s edge
 * cases (a caret on a character the wrap dropped trails that row; a caret
 * inside an escape trails the escape's visible content). */
export function displayCellOf(ctx: MotionContext, caret: Position): { row: number; col: number } {
  const position = clampPosition(ctx.buffer, caret);
  const text = ctx.buffer.lineAt(position.row);
  const offset = offsetOfCol(text, position.col, ctx.cache.width);
  return {
    row: ctx.index.lineToRow(position.row) + offset,
    col: caretDisplayIn(text, position.col, offset, ctx.cache.width).col,
  };
}

/** The caret slot at display `column` of display row `row` — the inverse of
 * {@link displayCellOf}. `charAtDisplayCol` clamps to the row's end and snaps a
 * column inside a wide glyph to that glyph's start, so the result is always a
 * slot the row can paint a caret on. */
export function positionAtDisplay(ctx: MotionContext, row: number, column: number): Position {
  const location = ctx.index.locate(clamp(row, 0, Math.max(0, ctx.index.totalRows - 1)));
  const text = ctx.buffer.lineAt(location.line);
  return {
    row: location.line,
    col: charAtDisplayCol(text, location.offset, Math.max(0, column), ctx.cache.width),
  };
}

/** `position` clamped into the document — the mirror of `buffer.ts`'s private clamp. */
export function clampPosition(buffer: Buffer, position: Position): Position {
  const row = clamp(position.row, 0, buffer.lineCount - 1);
  return { row, col: clamp(position.col, 0, buffer.lineAt(row).length) };
}

/**
 * The code-unit start of the grapheme cluster ending at or before `col` (the
 * backward half of a one-character motion), or 0 at the line's start.
 *
 * `@tern-tui/core` owns grapheme segmentation internally — `textutil.ts`'s
 * `clusterRuns` / `columnToIndex` / `indexToColumn` — but exports none of it
 * from `packages/core/src/index.ts`, so this is a SECOND implementation of a
 * rule the framework already owns. It uses the same `Intl.Segmenter` granularity
 * and the same documented fallback.
 */
export function graphemeStartBefore(text: string, col: number): number {
  let start = 0;
  for (const bound of clusterBounds(text)) {
    if (bound.start >= col) break;
    start = bound.start;
  }
  return start;
}

/** The code-unit end of the cluster the caret at `col` sits in, or `text.length`. */
export function graphemeEndAfter(text: string, col: number): number {
  for (const bound of clusterBounds(text)) {
    if (bound.end > col) return bound.end;
  }
  return text.length;
}

/** The lazily-created shared grapheme segmenter, or `null` once a runtime
 * without `Intl.Segmenter` is observed — `textutil.ts`'s own pattern. */
let segmenterInstance: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenterInstance === undefined) {
    segmenterInstance = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  return segmenterInstance;
}

/** The cluster spans of `text` (`Intl.Segmenter`, else code-point iteration). */
function clusterBounds(text: string): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  const segmenter = graphemeSegmenter();
  if (segmenter !== null) {
    for (const part of segmenter.segment(text)) {
      bounds.push({ start: part.index, end: part.index + part.segment.length });
    }
    return bounds;
  }
  let index = 0;
  for (const point of text) {
    bounds.push({ start: index, end: index + point.length });
    index += point.length;
  }
  return bounds;
}

const WORD_PATTERN = /[\p{L}\p{N}_]/u;
const SPACE_PATTERN = /\s/;

/** The code points of `text` with their code-unit starts, so nothing splits a pair. */
function codePoints(text: string): Array<{ start: number; text: string }> {
  const points: Array<{ start: number; text: string }> = [];
  let start = 0;
  for (const point of text) {
    points.push({ start, text: point });
    start += point.length;
  }
  return points;
}

/** The three classes a word motion (and a double-click) treats differently. */
export function classOf(text: string): "space" | "word" | "other" {
  if (SPACE_PATTERN.test(text)) return "space";
  return WORD_PATTERN.test(text) ? "word" : "other";
}

/** The index of the code point at or after `col` (direction 1), or the last
 * one before it (-1); -1 when the line has none. */
function pointIndex(points: ReadonlyArray<{ start: number }>, col: number, direction: -1 | 1): number {
  if (direction > 0) {
    for (let i = 0; i < points.length; i += 1) if (points[i]!.start >= col) return i;
    return -1;
  }
  let found = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i]!.start >= col) break;
    found = i;
  }
  return found;
}

/** The start of the next word run after `col` (see {@link wordForward}); -1 if none. */
function wordStartForward(text: string, col: number): number {
  const points = codePoints(text);
  let i = pointIndex(points, col, 1);
  if (i < 0) return -1;
  while (i < points.length && classOf(points[i]!.text) === "space") i += 1;
  if (i >= points.length) return -1;
  const kind = classOf(points[i]!.text);
  while (i < points.length && classOf(points[i]!.text) === kind) i += 1;
  while (i < points.length && classOf(points[i]!.text) === "space") i += 1;
  return i >= points.length ? -1 : points[i]!.start;
}

/** The start of the word run at or before `col` (see {@link wordBackward}); -1 if none. */
function wordStartBackward(text: string, col: number): number {
  const points = codePoints(text);
  let i = pointIndex(points, col, -1);
  if (i < 0) return -1;
  while (i >= 0 && classOf(points[i]!.text) === "space") i -= 1;
  if (i < 0) return -1;
  const kind = classOf(points[i]!.text);
  while (i >= 0 && classOf(points[i]!.text) === kind) i -= 1;
  return points[i + 1]!.start;
}

/** `value` as an integer in `min..max` — the `buffer.ts` clamp policy, repeated
 * because that module's clamp is private (`plan.ts:395`, `viewport.ts:267` too). */
function clamp(value: number, min: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return min;
  if (index < min) return min;
  return index > max ? max : index;
}
