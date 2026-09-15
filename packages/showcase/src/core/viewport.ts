//! The view model: display rows in, scene-free row descriptors out.

import { caretDisplayIn, measureText, offsetOfCol } from "@tern-tui/core";
import type { Buffer, Position } from "./buffer.ts";
import type { LineIndex } from "./lineindex.ts";
import type { WrapCache } from "./wrapcache.ts";

/** The `line` of a row past the end of the document: a blank the region paints,
 * NOT a line index (every real line is `>= 0`). */
export const FILLER_LINE = -1;

/** The default overscan band: the extra display rows the window prepares above
 * and below the visible ones, so a scroll of a row or two is a cache hit.
 * {@link DEFAULT_OVERSCAN} rows total, split across the two edges. */
export const DEFAULT_OVERSCAN = 2;

/** The editor region's size in cells. */
export interface ViewportSize {
  /** Visible cell rows (the region's height). */
  rows: number;
  /** The region's text columns — the wrap width, in terminal cells. */
  cols: number;
}

/** Everything the window is a function of. */
export interface ViewportInput {
  buffer: Buffer;
  index: LineIndex;
  /** The rows of the lines the window covers; its width is set from
   * `size.cols` here (see {@link computeViewport}). */
  cache: WrapCache;
  size: ViewportSize;
  /** The display row the region's first cell row shows. Clamped into the
   * document, so a stale scroll is a normal condition, not a caller bug. */
  scroll: number;
  /** The caret the cursor cell is computed for. Clamped likewise. */
  caret: Position;
  /** The total overscan rows (default {@link DEFAULT_OVERSCAN}); 0 disables the
   * band. */
  overscan?: number;
  /** Whether long lines wrap at `size.cols` (default true). `false` normalizes
   * the width to the cache's own "no wrap" convention, so the soft-wrap toggle is
   * one rule shared by the cache, the wrapper and the caret math — never a second
   * wrap path. */
  wrap?: boolean;
}

/** One cell row of the region: which line it shows, which display row of that
 * line, and the text and cell width to paint. */
export interface ViewportRow {
  /** The absolute display row this cell row shows (`firstRow + screenRow`). */
  row: number;
  /** The region-local cell row (`0..size.rows-1`). */
  screenRow: number;
  /** The logical line, or {@link FILLER_LINE} below the end of the document. */
  line: number;
  /** Which display row of `line` this is. */
  offset: number;
  /** Code-unit index within `line` where the row's text starts. */
  start: number;
  /** The row's text — escapes stripped by the framework's wrapper (`""` when
   * filler). */
  text: string;
  /** The text's width in terminal cells (0 when filler). */
  width: number;
}

/** Where the hardware cursor goes, in region-local cells. */
export interface CursorCell {
  /** The caret's absolute display row in the document. */
  displayRow: number;
  /** The caret's cell column within its row. */
  col: number;
  /** The region-local cell row — negative above the window, at or past
   * `size.rows` below it. */
  row: number;
  /** True when `row` is inside `[0, size.rows)` and the cell is the caret's. */
  visible: boolean;
}

/** What this update cost, measured rather than asserted — the evidence the
 * virtualization tests hold the window to. */
export interface ViewportStats {
  /** Distinct logical lines the window walked. Each contributes at least one
   * display row to the prepared span, so this is bounded by
   * `size.rows + overscan` (plus the caret's line when that is outside the
   * span). */
  linesTouched: number;
  /** `wrapLineWithOffsets` calls the window caused (the cache's own
   * accounting), i.e. the lines that were not already measured. */
  cacheWraps: number;
  /** `wrapLineWithOffsets` calls the caret column cost: the framework's
   * {@link offsetOfCol} and {@link caretDisplayIn} each walk the caret's own
   * line. A constant, never a document term. */
  caretWraps: number;
}

/** The windowed view of the document: the rows to paint, the cursor, the cost. */
export interface Viewport {
  /** The absolute display row of `rows[0]` — the clamped scroll. */
  firstRow: number;
  /** The rows the region paints, exactly `size.rows` of them, filler-padded:
   * one descriptor per cell row keeps the plan's rows and the screen's rows
   * the same length by construction. */
  rows: ViewportRow[];
  /** The display rows the index knew when the window was computed. */
  totalRows: number;
  cursor: CursorCell;
  stats: ViewportStats;
}

/**
 * Window the document: the rows of the caret's region, plus the cursor cell.
 *
 * ## The window
 *
 * The prepared span is the visible window plus the overscan band —
 * `[scroll - bandAbove, scroll + size.rows + bandBelow)` — because those are
 * the rows a scroll of a row or two lands on immediately after, so preparing
 * them is what makes the NEXT update cheap. The span is a function of the
 * viewport size, never of the document: the walk starts at the line
 * {@link LineIndex.locate} resolves for the span's first row (O(log lines))
 * and moves forward line by line while the span lasts, so a 100k-line document
 * costs the same as a 1k-line one and nothing above the window is ever walked.
 *
 * The returned rows are exactly `size.rows` descriptors, in screen order,
 * padded with {@link FILLER_LINE} rows when the document ends above the last
 * cell row — an emitter can paint one plan row per cell row with no arithmetic
 * of its own.
 *
 * ## The width
 *
 * `size.cols` is applied to the cache here (a no-op when unchanged), because
 * the wrap width is a property of the region and two owners of it is how the
 * cache and the window drift apart. A real change re-wraps everything once, on
 * the frame that resized.
 *
 * ## The cursor cell
 *
 * The caret's display row is `index.lineToRow(caretLine)` plus the offset
 * within that line, and the offset and column come from the framework's own row
 * math ({@link offsetOfCol}, {@link caretDisplayIn}) — the same functions
 * `Textarea` composes with — so the app's cursor cannot drift from the
 * compositor's. Those two calls each walk the caret's line; the framework's
 * exports take a line and re-wrap it (`packages/core/src/textwrap.ts`), which
 * is why the caret cost is a constant {@link ViewportStats.caretWraps} rather
 * than free. They measure COLUMNS, not rows: a line the window never reached
 * keeps its {@link LineIndex} height estimate until a window does.
 *
 * ## Clamping
 *
 * `scroll` clamps into `[0, totalRows - size.rows]` (0 when the document is
 * shorter than the window), the caret's row into the document, its column into
 * its line, and `size` into at least one row and one column — the
 * `buffer.ts` policy, applied to the view.
 */
export function computeViewport(input: ViewportInput): Viewport {
  const buffer = input.buffer;
  const index = input.index;
  const cache = input.cache;
  const height = Math.max(1, Math.trunc(input.size.rows) || 1);
  const width = Math.max(1, Math.trunc(input.size.cols) || 1);
  cache.setWidth(input.wrap === false ? null : width);

  const totalRows = index.totalRows;
  const firstRow = clamp(input.scroll, Math.max(0, totalRows - height));
  const band = Math.max(0, Math.trunc(input.overscan ?? DEFAULT_OVERSCAN) || 0);
  const above = Math.min(firstRow, Math.floor(band / 2));
  const below = band - above;
  const spanStart = firstRow - above;
  const spanEnd = firstRow + height + below;

  const wrapsBefore = cache.wraps;
  const rows: ViewportRow[] = [];
  const start = index.locate(spanStart);
  let line = start.line;
  let offset = start.offset;
  let row = spanStart;
  let linesTouched = 0;
  let firstLine = -1;
  let lastLine = -1;
  while (row < spanEnd && line < buffer.lineCount) {
    const text = buffer.lineAt(line);
    const wrapped = cache.rowsOf(line, text);
    if (linesTouched === 0) firstLine = line;
    lastLine = line;
    linesTouched += 1;
    while (offset < wrapped.length && row < spanEnd) {
      if (row >= firstRow && row < firstRow + height) {
        const entry = wrapped[offset]!;
        rows.push({
          row,
          screenRow: row - firstRow,
          line,
          offset,
          start: entry.start,
          text: entry.text,
          width: cellWidth(entry.text),
        });
      }
      offset += 1;
      row += 1;
    }
    line += 1;
    offset = 0;
  }
  while (rows.length < height) {
    rows.push({
      row: firstRow + rows.length,
      screenRow: rows.length,
      line: FILLER_LINE,
      offset: 0,
      start: 0,
      text: "",
      width: 0,
    });
  }

  // The caret: an absolute display row out of the index (never a walk of the
  // document), then the framework's own row math for the offset and column.
  const caretLine = clamp(input.caret.row, buffer.lineCount - 1);
  const caretText = buffer.lineAt(caretLine);
  const caretCol = clamp(input.caret.col, caretText.length);
  const caretOffset = offsetOfCol(caretText, caretCol, cache.width);
  const displayRow = index.lineToRow(caretLine) + caretOffset;
  const displayCol = caretDisplayIn(caretText, caretCol, caretOffset, cache.width).col;
  const cursorRow = displayRow - firstRow;
  if (linesTouched === 0 || caretLine < firstLine || caretLine > lastLine) linesTouched += 1;

  return {
    firstRow,
    rows,
    totalRows,
    cursor: {
      displayRow,
      col: displayCol,
      row: cursorRow,
      visible: cursorRow >= 0 && cursorRow < height,
    },
    stats: {
      linesTouched,
      cacheWraps: cache.wraps - wrapsBefore,
      caretWraps: CARET_MEASUREMENTS,
    },
  };
}

/**
 * The display width of ONE display row's text in terminal cells.
 *
 * The framework measures cells everywhere but exports no bare width function
 * (`textwrap.ts`'s `textWidth` and `table.ts`'s `displayWidth` are internal),
 * and a renderer that measures its own text is exactly what the plan/emit split
 * forbids — so the app-core measures here, through the exported
 * {@link measureText} under its documented no-width convention: with no wrap
 * width each logical line is one display row and the widest display line IS the
 * string's own width. The text must be one display row (a `wrapLineWithOffsets`
 * row never contains a newline), which is what keeps that reading exact. This is
 * a seam the framework should close with an exported width helper; until it
 * does, this is the one place the app-core measures.
 */
export function cellWidth(text: string): number {
  return measureText(text, 0).maxWidth;
}

/** `wrapLineWithOffsets` calls one caret cell costs: {@link offsetOfCol} and
 * {@link caretDisplayIn} each walk the caret's line (see the function comment). */
const CARET_MEASUREMENTS = 2;

/** `value` as an integer in `0..max`: the clamp policy `buffer.ts` applies
 * (NaN and negatives at 0). */
function clamp(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}
