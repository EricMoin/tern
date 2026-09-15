//! Tests: the view model — the window's shape, scroll/filler clamps, wrapped
//! lines reached mid-line, the cursor cell against the framework's row math,
//! the wrap width, and the 100k-line virtualization perf case.

import { caretDisplayIn, offsetOfCol, wrapLineWithOffsets } from "@tern-tui/core";
import { DEFAULT_LINE_HEIGHT, LineIndex } from "./lineindex.ts";
import { WrapCache } from "./wrapcache.ts";
import { cellWidth, computeViewport, DEFAULT_OVERSCAN, FILLER_LINE } from "./viewport.ts";
import { Buffer } from "./buffer.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/**
 * A document whose lines are the given texts, with an index that already knows
 * each line's display height (the state an app that has scrolled there is in —
 * the lazy path is the wrap cache's and the perf case's subject) and an empty
 * wrap cache, so every line the window reaches is still a miss.
 */
function makeDocument(texts: string[], width: number | null) {
  const buffer = Buffer.fromString(texts.join("\n"));
  const heights = texts.map((text) => wrapLineWithOffsets(text, width).length);
  const index = new LineIndex(heights);
  const cache = new WrapCache(index, width);
  return { buffer, index, cache };
}

Deno.test("viewport: the window is exactly the region's rows, in screen order", () => {
  const texts = ["alpha", "a much longer line that will wrap several times at width ten", "cthulhu", ""];
  const { buffer, index, cache } = makeDocument(texts, 10);
  const totalBefore = index.totalRows;
  const view = computeViewport({
    buffer, index, cache, size: { rows: 5, cols: 10 }, scroll: 0, caret: { row: 0, col: 0 }, overscan: 0,
  });
  check(view.rows.length === 5, "one descriptor per cell row");
  check(view.firstRow === 0, "scroll 0 starts at the document top");
  for (let i = 0; i < view.rows.length; i += 1) {
    const row = view.rows[i]!;
    check(row.screenRow === i && row.row === i, `row ${i} is screen-local ${row.screenRow} at ${row.row}`);
    check(row.line >= 0, `row ${i} is inside the document`);
    check(row.width === cellWidth(row.text), "the width is the row text's own");
  }
  const wrapped = wrapLineWithOffsets(texts[0]!, 10)[0]!;
  check(view.rows[0]!.text === wrapped.text && view.rows[0]!.start === wrapped.start, "row 0 is the framework's first row");

  // The rows tile the document: each row continues the previous one, either on
  // the same line (next offset) or on the next line (offset 0).
  for (let i = 1; i < view.rows.length; i += 1) {
    const previous = view.rows[i - 1]!;
    const row = view.rows[i]!;
    const contiguous = previous.line === FILLER_LINE
      ? row.line === FILLER_LINE
      : row.line === previous.line
        ? row.offset === previous.offset + 1
        : row.line === previous.line + 1 && row.offset === 0;
    check(contiguous, `row ${i} does not continue row ${i - 1}`);
  }
  check(view.totalRows === totalBefore, "the view reports the total its clamp was computed against");
  check(index.totalRows >= totalBefore, "and measuring the window only ever learns taller lines");
});

Deno.test("viewport: scroll clamps into the document and filler pads the tail", () => {
  const texts = ["one", "two", "three"];
  const { buffer, index, cache } = makeDocument(texts, null);
  const size = { rows: 4, cols: 20 };
  const end = computeViewport({ buffer, index, cache, size, scroll: 999, caret: { row: 0, col: 0 }, overscan: 0 });
  check(end.firstRow === 0, "a three-row document cannot scroll");
  check(end.rows.length === 4, "the window is still four rows");
  check(end.rows[2]!.text === "three" && end.rows[2]!.line === 2, "the last line is at row 2");
  check(end.rows[3]!.line === FILLER_LINE, "row 3 is below the document");
  check(end.rows[3]!.text === "" && end.rows[3]!.width === 0 && end.rows[3]!.start === 0, "and is blank");

  const taller = makeDocument(new Array<string>(10).fill("x"), null);
  const scrolled = computeViewport({
    buffer: taller.buffer, index: taller.index, cache: taller.cache,
    size, scroll: 99, caret: { row: 0, col: 0 }, overscan: 0,
  });
  check(scrolled.firstRow === 6, "scroll clamps to totalRows - rows");
  check(scrolled.rows[0]!.line === 6 && scrolled.rows[3]!.line === 9, "showing the last four lines");
  const negative = computeViewport({
    buffer: taller.buffer, index: taller.index, cache: taller.cache,
    size, scroll: -12, caret: { row: NaN, col: NaN }, overscan: 0,
  });
  check(negative.firstRow === 0, "a negative scroll clamps to the top");
  check(negative.rows[0]!.line === 0, "and the caret's row/col clamp into the document");
});

Deno.test("viewport: a scroll can land mid-line, which fixed-height windowing cannot express", () => {
  const long = "abcdefghij".repeat(4); // 40 cells, four rows at width 10
  const { buffer, index, cache } = makeDocument([long, "tail", "more"], 10);
  const wrapped = wrapLineWithOffsets(long, 10);
  check(wrapped.length === 4, "the line is four display rows");

  const middle = computeViewport({
    buffer, index, cache, size: { rows: 2, cols: 10 }, scroll: 2, caret: { row: 0, col: 20 }, overscan: 0,
  });
  check(middle.firstRow === 2, "the window starts at display row 2");
  check(middle.rows[0]!.line === 0 && middle.rows[0]!.offset === 2, "which is the line's third display row");
  check(middle.rows[0]!.text === wrapped[2]!.text, "painting that row's text, not the line's first");
  check(middle.rows[1]!.offset === 3, "and the next row is the line's fourth");
  check(middle.cursor.displayRow === 2 && middle.cursor.row === 0, "the caret at col 20 is on that row");

  const past = computeViewport({
    buffer, index, cache, size: { rows: 2, cols: 10 }, scroll: 4, caret: { row: 1, col: 4 }, overscan: 0,
  });
  check(past.firstRow === 4 && past.rows[0]!.line === 1 && past.rows[0]!.text === "tail", "row 4 is the second line");
  check(past.rows[1]!.line === 2 && past.rows[1]!.text === "more", "and row 5 the third");
  check(past.cursor.row === 0 && past.cursor.col === 4, "the caret sits on the first cell row");
});

Deno.test("viewport: the cursor cell is the framework's row math, clamped", () => {
  const texts = ["short", "a line that wraps at width ten for sure", "last"];
  const width = 10;
  const { buffer, index, cache } = makeDocument(texts, width);
  const size = { rows: 6, cols: width };
  const view = computeViewport({
    buffer, index, cache, size, scroll: 0, caret: { row: 1, col: 17 }, overscan: 0,
  });
  const line = texts[1]!;
  const offset = offsetOfCol(line, 17, width);
  const expected = caretDisplayIn(line, 17, offset, width).col;
  check(view.cursor.displayRow === index.lineToRow(1) + offset, "the display row comes from the index plus the line offset");
  check(view.cursor.col === expected, "the column is the framework's own caret column");
  check(view.cursor.row === view.cursor.displayRow - view.firstRow, "the cell row is the window's offset");
  check(view.cursor.visible, "a caret inside the window is visible");

  const lastRow = index.lineToRow(2);
  const beyond = computeViewport({
    buffer, index, cache, size: { rows: lastRow + 1, cols: width }, scroll: 0, caret: { row: 99, col: 99 }, overscan: 0,
  });
  check(beyond.cursor.displayRow === lastRow, "an out-of-range caret row clamps to the last line");
  check(beyond.cursor.row === lastRow, "which is the window's last cell row");
  check(beyond.cursor.visible, "and it is visible there");
  const hidden = computeViewport({
    buffer, index, cache, size, scroll: 0, caret: { row: 99, col: 99 }, overscan: 0,
  });
  check(!hidden.cursor.visible && hidden.cursor.row >= size.rows, "a six-row window hides it, reporting the cell anyway");

  const above = computeViewport({
    buffer, index, cache, size, scroll: 4, caret: { row: 0, col: 0 }, overscan: 0,
  });
  check(above.firstRow === 1, "the scroll clamps to the document's last window");
  check(above.cursor.row === -1 && !above.cursor.visible, "a caret above the window is not visible");
  check(above.cursor.displayRow === 0 && above.cursor.col === 0, "but its absolute cell is still reported");
});

Deno.test("viewport: the wrap width follows the region and cellWidth reads the framework's cells", () => {
  const text = "0123456789abcdefghij";
  const { buffer, index, cache } = makeDocument([text, "x"], 20);
  const wide = computeViewport({ buffer, index, cache, size: { rows: 3, cols: 20 }, scroll: 0, caret: { row: 0, col: 0 }, overscan: 0 });
  check(wide.rows[0]!.text === text, "at 20 columns the line is one row");
  check(cache.width === 20, "the region's columns set the cache width");
  const narrow = computeViewport({ buffer, index, cache, size: { rows: 3, cols: 5 }, scroll: 0, caret: { row: 0, col: 0 }, overscan: 0 });
  check(cache.width === 5, "a narrower region re-wraps");
  check(narrow.rows[0]!.text === "01234" && narrow.rows[1]!.text === "56789", "and the rows follow the new width");
  check(narrow.rows.length === 3 && narrow.rows[2]!.line === 0, "the tall line fills the window");

  check(cellWidth("abc") === 3, "ascii width");
  check(cellWidth("") === 0, "empty width");
  check(cellWidth("日本語") === 6, "wide glyphs count two cells");
  check(cellWidth("👨‍👩‍👧") === 2, "a ZWJ emoji cluster counts one glyph");
  check(cellWidth("\u001b[31mred\u001b[0m") === 3, "escape sequences consume no cells");
});

Deno.test("lineindex/viewport: the 100k-line perf case wraps at most a window plus its band and stays a constant multiple of the 1k case", () => {
  const WIDTH = 16;
  const ROWS = 40;
  const OVERSCAN = DEFAULT_OVERSCAN;
  const WARM_UP = 5;
  const shape = (line: number): string => "line" + (line % 10) + ":" + "x".repeat(43);
  const document = (count: number): string[] => {
    const texts: string[] = new Array(count);
    for (let line = 0; line < count; line += 1) texts[line] = shape(line);
    return texts;
  };

  /**
   * Drive a document through `updates` cold windows, holding every window to
   * the bound. Five untimed windows run first (the JIT's first frames are not
   * the mechanism's cost); the timed batch then lands on regions the warm-up
   * never touched, so it is still cold at both file sizes.
   */
  const run = (count: number, updates: number) => {
    const texts = document(count);
    const buffer = Buffer.fromString(texts.join("\n"));
    // Every line of this document has the same shape, so the index is built warm
    // from ONE measurement (the app's "I have scrolled this far" state) while the
    // wrap cache starts empty, so each window is still a cold miss.
    const height = wrapLineWithOffsets(texts[0]!, WIDTH).length;
    const index = new LineIndex(new Array<number>(count).fill(height));
    const cache = new WrapCache(index, WIDTH);
    let firstWork = -1;
    let firstWraps = -1;
    let caretWraps = -1;
    let totalWork = 0;
    let totalWraps = 0;
    const stride = 59;
    const drive = (step: number): void => {
      const scroll = (step * stride) % Math.max(1, index.totalRows - ROWS);
      const caret = { row: index.locate(scroll).line, col: 0 };
      const measuredBefore = cache.measuredLines;
      const view = computeViewport({
        buffer, index, cache, size: { rows: ROWS, cols: WIDTH }, scroll, caret, overscan: OVERSCAN,
      });
      check(view.rows.length === ROWS, "the window is the region's height");
      // The acceptance bound: a window walks at most the visible rows plus the
      // overscan band, whatever the file size.
      check(
        view.stats.linesTouched <= ROWS + OVERSCAN,
        `${count} lines, window ${step}: touched ${view.stats.linesTouched} > ${ROWS + OVERSCAN}`,
      );
      check(
        view.stats.cacheWraps <= ROWS + OVERSCAN,
        `${count} lines, window ${step}: wrapped ${view.stats.cacheWraps} > ${ROWS + OVERSCAN}`,
      );
      check(view.stats.caretWraps === 2, "the caret cell's fixed two measurements");
      check(
        cache.measuredLines - measuredBefore <= ROWS + OVERSCAN,
        `${count} lines, window ${step}: the cache grew by ${cache.measuredLines - measuredBefore} lines`,
      );
      totalWork += view.stats.linesTouched;
      totalWraps += view.stats.cacheWraps;
      if (firstWork === -1) {
        firstWork = view.stats.linesTouched;
        firstWraps = view.stats.cacheWraps;
        caretWraps = view.stats.caretWraps;
      }
    };
    for (let step = 0; step < WARM_UP; step += 1) drive(step);
    // One timer for the batch: `performance.now()` is a 0.1ms clock here, so a
    // single window is far below its resolution.
    const started = performance.now();
    for (let step = WARM_UP; step < WARM_UP + updates; step += 1) drive(step);
    const perUpdate = (performance.now() - started) / updates;
    return { perUpdate, firstWork, firstWraps, totalWork, totalWraps, caretWraps, index, cache, buffer };
  };

  const small = run(1_000, 40);
  const large = run(100_000, 40);
  // The structural half of the acceptance: identical windowed work at 100× the
  // file (same document shapes, same scroll sequence, so every number here is
  // byte-for-byte comparable), and a cold window is measured, never the
  // document.
  check(
    large.totalWork === small.totalWork && large.totalWraps === small.totalWraps,
    `the 1k run did ${small.totalWork} line-touches / ${small.totalWraps} wraps, the 100k run ${large.totalWork} / ${large.totalWraps}`,
  );
  check(small.firstWork === large.firstWork && small.firstWraps === large.firstWraps, "the first window is the same window");
  check(large.cache.wraps <= 40 * (ROWS + OVERSCAN), "the 100k case wrapped its windows, never the document");
  check(large.cache.measuredLines <= large.cache.wraps, "every measurement came from a wrap");
  check(large.index.totalRows >= 100_000, "and the index spans the document");
  check(large.firstWraps === large.firstWork, "every line the window touched was wrapped: the windows were cold, not cached");
  check(large.firstWork >= 5, `the window exercised real lines (touched ${large.firstWork})`);

  // A warm scroll: the band prepared by the previous update is what the next
  // one lands on, so it wraps nothing (or the one line entering the band).
  const warmBefore = large.cache.wraps;
  const warm = computeViewport({
    buffer: large.buffer, index: large.index, cache: large.cache,
    size: { rows: ROWS, cols: WIDTH }, scroll: 1, caret: { row: 0, col: 0 }, overscan: OVERSCAN,
  });
  check(
    large.cache.wraps - warmBefore <= 1,
    `a one-row scroll under a band of ${OVERSCAN} wrapped ${large.cache.wraps - warmBefore} lines`,
  );
  check(warm.stats.cacheWraps <= 1, "reported as at most one line");

  // The timing half: the same computation at 100× the file, within a small
  // constant of the 1k case and far below any document-proportional cost.
  const floor = 0.02; // ms — below the timer's useful resolution, so a fast 1k case cannot make the ratio explode
  const ratio = large.perUpdate / Math.max(small.perUpdate, floor);
  console.log(
    `100k perf case: 1k ${small.perUpdate.toFixed(4)}ms/window, 100k ${large.perUpdate.toFixed(4)}ms/window, ` +
      `ratio ${ratio.toFixed(2)} (bound 15); ${large.totalWork} line-touches / ${large.totalWraps} wraps over ` +
      `${WARM_UP + 40} windows at both sizes, ${large.caretWraps} caret measurements each`,
  );
  check(ratio <= 15, `the 100k viewport costs ${ratio.toFixed(2)}× the 1k one`);
  check(large.perUpdate < 5, `a 100k-line window took ${large.perUpdate.toFixed(3)}ms`);
});
