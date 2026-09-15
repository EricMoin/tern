//! Tests: the wrap cache — one walk per line and width, the index it feeds,
//! invalidation, splice alignment, width changes, and 100k-line laziness.

import { textareaWidth, wrapLineWithOffsets } from "@tern-tui/core";
import { DEFAULT_LINE_HEIGHT, LineIndex } from "./lineindex.ts";
import { WrapCache } from "./wrapcache.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** The framework's own rows for a line: the oracle the cache must match. */
function rows(text: string, width: number | null): Array<{ text: string; start: number }> {
  return wrapLineWithOffsets(text, width);
}

/** The line's height as the index knows it — the difference of two starts. */
function indexedHeight(index: LineIndex, line: number): number {
  return index.lineToRow(line + 1) - index.lineToRow(line);
}

/** A tiny deterministic PRNG so a failing run is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

Deno.test("wrapcache: a line is wrapped once and then served, and the index learns its height", () => {
  const index = new LineIndex();
  const cache = new WrapCache(index, 10);
  const text = "one two three four five";
  const first = cache.rowsOf(0, text);
  check(JSON.stringify(first) === JSON.stringify(rows(text, 10)), "the cache returns the framework's rows");
  check(cache.wraps === 1 && cache.hits === 0, "the first ask wrapped the line");
  check(indexedHeight(index, 0) === first.length, "the index holds the measured height");
  check(index.totalRows === first.length, "and the document is that tall");

  const second = cache.rowsOf(0, text);
  check(second === first, "a hit returns the same row array");
  check(cache.wraps === 1 && cache.hits === 1, "no second walk");
  check(cache.measuredLines === 1, "one line is measured");

  cache.rowsOf(0, "changed");
  check(cache.wraps === 2, "different text is re-measured, never served from the old rows");
  check(indexedHeight(index, 0) === rows("changed", 10).length, "and the index follows the new text");
});

Deno.test("wrapcache: invalidate drops the rows and resets the height, and null width never wraps", () => {
  const index = new LineIndex();
  const cache = new WrapCache(index, null);
  const wide = "x".repeat(500);
  check(cache.rowsOf(0, wide).length === 1, "a null width keeps a line on one display row");
  check(index.totalRows === 1, "the one-line document is one row");
  check(cache.invalidate(0), "the measured line had something to drop");
  check(!cache.invalidate(0), "the second invalidate is a no-op");
  check(cache.measuredLines === 0, "nothing is measured any more");
  check(indexedHeight(index, 0) === DEFAULT_LINE_HEIGHT, "an invalidation resets the index height");
  check(cache.rowsOf(0, wide).length === 1, "and it measures again on the next ask");
  check(cache.wraps === 2, "the reset cost no wrap; the re-measure is one");
});

Deno.test("wrapcache: setWidth re-wraps at the new width and normalizes like the framework", () => {
  const index = new LineIndex();
  const cache = new WrapCache(index, 4);
  const text = "abcdefghij";
  check(cache.rowsOf(0, text).length === 3, "at width 4 the line is three rows");
  check(indexedHeight(index, 0) === 3, "the index agrees");
  cache.setWidth(4);
  check(cache.wraps === 1 && cache.measuredLines === 1, "an unchanged width is a no-op");
  cache.setWidth(10);
  check(cache.measuredLines === 0, "a new width drops every entry");
  check(index.totalRows === DEFAULT_LINE_HEIGHT, "and resets every height");
  check(cache.rowsOf(0, text).length === 1, "at width 10 the line is one row");
  check(cache.width === 10, "the width is reported");
  cache.setWidth(0);
  check(cache.width === null && textareaWidth({ width: 0 }) === null, "a zero width is the framework's no-width case");
  cache.setWidth(7.9);
  check(cache.width === 7 && textareaWidth({ width: 7.9 }) === 7, "a fractional width floors");
});

Deno.test("wrapcache: splices keep the entry array aligned with the index", () => {
  const width = 12;
  const index = new LineIndex();
  const cache = new WrapCache(index, width);
  const document = [""];
  const lines = [
    "alpha beta gamma delta", "", "x".repeat(40), "short", "one two three four five six",
    "emoji 👨‍👩‍👧 here", "tabs\there", "ünïcödé and CJK 日本語テキスト",
  ];
  for (const line of lines) {
    document.push(line);
    cache.insertLine(document.length - 1);
  }

  /** Measure every line and hold the whole document against the framework. */
  const sameDocument = (what: string): void => {
    let expectedRows = 0;
    for (let line = 0; line < document.length; line += 1) {
      const text = document[line]!;
      const cached = cache.rowsOf(line, text);
      check(
        JSON.stringify(cached) === JSON.stringify(rows(text, width)),
        `${what}: line ${line} rows`,
      );
      expectedRows += cached.length;
    }
    check(index.lineCount === document.length, `${what}: lineCount`);
    check(index.totalRows === expectedRows, `${what}: totalRows = ${index.totalRows}, want ${expectedRows}`);
    check(cache.measuredLines === document.length, `${what}: measuredLines`);
  };
  sameDocument("initial");

  // A splice at the top must move line identities with the document: what was
  // measured for line 5 is now line 6, and must still be a hit, not a re-wrap.
  const before = cache.wraps;
  const shifted = document[5]!;
  cache.insertLine(0, 2);
  document.splice(0, 0, "inserted");
  check(indexedHeight(index, 0) === 2, "the inserted line's height is the caller's");
  check(JSON.stringify(cache.rowsOf(6, document[6]!)) === JSON.stringify(rows(shifted, width)), "line 5 moved to 6 with its rows");
  check(cache.wraps === before, "and is still served, not re-wrapped");
  check(cache.removeLine(0) === 2, "the inserted line's height comes back");
  document.splice(0, 1);
  check(cache.rowsOf(5, document[5]!) !== undefined && cache.wraps === before, "the original line is back at its index");
  sameDocument("after the top splice");

  const random = makeRandom(0xc0ffee);
  for (let step = 0; step < 200; step += 1) {
    const line = Math.floor(random() * document.length);
    if (random() < 0.5) {
      document.splice(line, 0, lines[Math.floor(random() * lines.length)]!);
      cache.insertLine(line);
    } else if (document.length > 1) {
      document.splice(line, 1);
      cache.removeLine(line);
    }
    // Measuring every line is the only state in which the index's total is
    // exact (an unmeasured inserted line honestly counts as one row), so the
    // whole document is checked against the framework after each splice.
    sameDocument(`step ${step}`);
  }
  sameDocument("after 200 splices");
});

Deno.test("wrapcache: 100k lines are measured lazily, one line at a time", () => {
  const count = 100_000;
  const texts: string[] = new Array(count);
  for (let line = 0; line < count; line += 1) texts[line] = "line " + line + " " + "x".repeat(line % 50);
  const index = new LineIndex(new Array<number>(count).fill(DEFAULT_LINE_HEIGHT));
  const cache = new WrapCache(index, 20);
  check(cache.measuredLines === 0 && cache.wraps === 0, "a fresh cache has measured nothing");
  check(index.totalRows === count, "the unmeasured document counts one row per line");

  const before = cache.wraps;
  cache.rowsOf(50_000, texts[50_000]!);
  check(cache.wraps === before + 1, "one ask wraps exactly one line");
  check(cache.measuredLines === 1, "and measures exactly one line");
  const height = rows(texts[50_000]!, 20).length;
  check(indexedHeight(index, 50_000) === height, "the index holds that line's height");
  check(index.totalRows === count - 1 + height, "and only that line moved the total");
  check(cache.rowsOf(50_000, texts[50_000]!).length === height, "the second ask is a hit");
  check(cache.wraps === before + 1 && cache.hits === 1, "no further walks");

  cache.setWidth(40);
  check(cache.measuredLines === 0, "a width change drops the one entry");
  check(index.totalRows === count, "and the whole index is back to the estimate");
  check(cache.wraps === before + 1, "which cost no wrapping at all");
});
