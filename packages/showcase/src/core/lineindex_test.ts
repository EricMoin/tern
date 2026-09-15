//! Tests: the line index — prefix sums over per-line display heights, the
//! row↔line map, splices that keep both correct, the clamp policy, a
//! differential run against a naive model, and the 100k-line geometry.

import { DEFAULT_LINE_HEIGHT, LineIndex } from "./lineindex.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A tiny deterministic PRNG (xorshift32) so a failing run is reproducible. */
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

/** The index's rules, spelled out naively: the oracle the differential test
 * compares against. */
class Model {
  heights: number[] = [DEFAULT_LINE_HEIGHT];

  clamp(value: number, max: number): number {
    const index = Math.trunc(value);
    if (!Number.isFinite(index) || index < 0) return 0;
    return index > max ? max : index;
  }

  get totalRows(): number {
    return this.heights.reduce((sum, height) => sum + height, 0);
  }

  lineToRow(line: number): number {
    const target = this.clamp(line, this.heights.length);
    let rows = 0;
    for (let i = 0; i < target; i += 1) rows += this.heights[i]!;
    return rows;
  }

  locate(row: number): { line: number; offset: number } {
    const target = this.clamp(row, this.totalRows - 1);
    let rows = 0;
    for (let line = 0; line < this.heights.length; line += 1) {
      const height = this.heights[line]!;
      if (target < rows + height) return { line, offset: target - rows };
      rows += height;
    }
    const last = this.heights.length - 1;
    return { line: last, offset: this.heights[last]! - 1 };
  }

  normalize(height: number): number {
    const value = Math.trunc(height);
    return Number.isFinite(value) && value > DEFAULT_LINE_HEIGHT ? value : DEFAULT_LINE_HEIGHT;
  }

  setHeight(line: number, height: number): void {
    this.heights[this.clamp(line, this.heights.length - 1)] = this.normalize(height);
  }

  insertLine(at: number, height = DEFAULT_LINE_HEIGHT): void {
    this.heights.splice(this.clamp(at, this.heights.length), 0, this.normalize(height));
  }

  removeLine(line: number): number | undefined {
    if (this.heights.length <= 1) return undefined;
    return this.heights.splice(this.clamp(line, this.heights.length - 1), 1)[0];
  }
}

/** Compare every observable of `index` against `model` — the whole geometry,
 * not just the totals. */
function sameGeometry(index: LineIndex, model: Model, what: string): void {
  check(index.lineCount === model.heights.length, `${what}: lineCount`);
  check(index.totalRows === model.totalRows, `${what}: totalRows`);
  for (let line = 0; line <= model.heights.length; line += 1) {
    check(index.lineToRow(line) === model.lineToRow(line), `${what}: lineToRow(${line})`);
  }
  for (let row = 0; row < model.totalRows; row += 1) {
    const expected = model.locate(row);
    const actual = index.locate(row);
    check(
      actual.line === expected.line && actual.offset === expected.offset,
      `${what}: locate(${row}) = ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
    check(index.rowToLine(row) === expected.line, `${what}: rowToLine(${row})`);
  }
}

Deno.test("lineindex: a fresh index is the one-line document and is total", () => {
  const index = new LineIndex();
  check(index.lineCount === 1, "a fresh index has one line");
  check(index.totalRows === DEFAULT_LINE_HEIGHT, "a fresh index has one row");
  check(index.lineToRow(0) === 0 && index.lineToRow(1) === 1, "the one line spans row 0");
  check(index.lineToRow(1e9) === 1, "a line past the end is totalRows");
  check(index.lineToRow(-4) === 0 && index.lineToRow(NaN) === 0, "negatives and NaN clamp to line 0");
  const located = index.locate(0);
  check(located.line === 0 && located.offset === 0, "row 0 is line 0 offset 0");
  check(index.locate(99).line === 0 && index.locate(-1).line === 0, "rows clamp");
});

Deno.test("lineindex: lineToRow is the prefix sum and locate is its inverse", () => {
  const index = new LineIndex([1, 3, 2, 1]);
  check(index.lineCount === 4 && index.totalRows === 7, "four lines, seven rows");
  check(index.lineToRow(0) === 0, "line 0 starts at row 0");
  check(index.lineToRow(1) === 1, "line 1 starts at row 1");
  check(index.lineToRow(2) === 4, "line 2 starts at row 4");
  check(index.lineToRow(3) === 6, "line 3 starts at row 6");
  check(index.lineToRow(4) === 7, "the end of the document is totalRows");
  const expected: Array<[number, number, number]> = [
    [0, 0, 0], [1, 1, 0], [2, 1, 1], [3, 1, 2], [4, 2, 0], [5, 2, 1], [6, 3, 0],
  ];
  for (const [row, line, offset] of expected) {
    const located = index.locate(row);
    check(
      located.line === line && located.offset === offset,
      `locate(${row}) = ${JSON.stringify(located)}, want line ${line} offset ${offset}`,
    );
  }
  check(index.locate(99).line === 3 && index.locate(99).offset === 0, "a row past the end is the last line's last row");
});

Deno.test("lineindex: setHeight, insertLine and removeLine keep the geometry exact", () => {
  const index = new LineIndex([1, 1, 1]);
  index.setHeight(1, 5);
  check(index.totalRows === 7, "a height change moves the total");
  check(index.lineToRow(2) === 6, "and every later line's start");
  index.setHeight(1, 0);
  check(index.totalRows === 3, "a sub-default height normalizes to one row");
  index.setHeight(1, 2.9);
  check(index.totalRows === 4, "a fractional height floors");

  index.insertLine(0, 4);
  check(index.lineCount === 4 && index.totalRows === 8, "an insert at the top");
  check(index.lineToRow(1) === 4, "the inserted line owns its rows");
  index.insertLine(99, 3);
  check(index.lineCount === 5 && index.totalRows === 11, "an out-of-range insert clamps to the end");
  index.insertLine(-1);
  check(index.lineCount === 6 && index.totalRows === 12, "an insert before the top clamps to line 0");

  check(index.removeLine(0) === 1, "removeLine returns the removed height");
  check(index.lineCount === 5 && index.totalRows === 11, "the document shrinks by that height");
  check(index.removeLine(99) === 3, "an out-of-range remove clamps to the last line and returns its height");

  while (index.lineCount > 1) index.removeLine(0);
  check(index.removeLine(0) === undefined, "the last line cannot be removed");
  check(index.lineCount === 1 && index.totalRows === index.lineToRow(1), "the one-line document is consistent");
});

Deno.test("lineindex: resetHeights forgets every measurement in one pass", () => {
  const index = new LineIndex([2, 5, 1, 7]);
  index.resetHeights();
  check(index.totalRows === 4, "every line is back to the default");
  check(index.lineToRow(2) === 2 && index.lineToRow(4) === 4, "the prefix sums follow");
  index.setHeight(3, 4);
  index.resetHeights(3);
  check(index.totalRows === 12, "a reset to a height applies to every line");
  check(index.lineToRow(1) === 3 && index.lineToRow(4) === 12, "and to the prefix sums");
  index.resetHeights(0);
  check(index.totalRows === 4, "a reset below the default normalizes to it");
});

Deno.test("lineindex: a differential run against the naive model", () => {
  const random = makeRandom(0x5eed);
  const index = new LineIndex();
  const model = new Model();
  const shapes = [0, 1, 2, 3, 8, 40];
  for (let step = 0; step < 400; step += 1) {
    const pick = random();
    const line = Math.floor(random() * (index.lineCount + 2)) - 1;
    const height = shapes[Math.floor(random() * shapes.length)]!;
    if (pick < 0.4) {
      index.setHeight(line, height);
      model.setHeight(line, height);
    } else if (pick < 0.75) {
      index.insertLine(line, height);
      model.insertLine(line, height);
    } else if (pick < 0.95) {
      const removed = index.removeLine(line);
      const expected = model.removeLine(line);
      check(removed === expected, `step ${step}: removeLine(${line}) = ${removed} != ${expected}`);
    } else {
      index.resetHeights(height);
      model.heights = model.heights.map(() => model.normalize(height));
    }
    sameGeometry(index, model, `step ${step} (line ${line}, height ${height})`);
  }
  check(index.lineCount > 10, "the run exercised a document of real size");
});

Deno.test("lineindex: the 100k-line geometry is exact and stays O(log n) per query", () => {
  const count = 100_000;
  const heights: number[] = new Array(count);
  for (let line = 0; line < count; line += 1) heights[line] = 1 + (line % 4);
  const start = performance.now();
  const index = new LineIndex(heights);
  const built = performance.now() - start;
  check(index.lineCount === count, "every line is present");
  let expected = 0;
  for (const height of heights) expected += height;
  check(index.totalRows === expected, `totalRows = ${index.totalRows}, want ${expected}`);

  // Sample the prefix sums against the naive sum — the index cannot be checked
  // by walking it, so the oracle walks the array.
  let running = 0;
  const samples = new Set([0, 1, 2, 3, 4, 57, 999, 1000, 50_000, count - 2, count - 1, count]);
  for (let line = 0; line <= count; line += 1) {
    if (samples.has(line)) check(index.lineToRow(line) === running, `lineToRow(${line})`);
    if (line < count) running += heights[line]!;
  }
  for (const line of samples) {
    if (line === count) continue; // the end of the document is not a line start
    const located = index.locate(index.lineToRow(line));
    check(located.line === line, `locate(lineToRow(${line})) round-trips`);
    check(located.offset === 0, `lineToRow(${line}) is a line start`);
  }
  const tail = index.locate(index.totalRows - 1);
  check(tail.line === count - 1, "the last row belongs to the last line");
  check(tail.offset === heights[count - 1]! - 1, "and carries the last line's last offset");

  // Edits in the middle keep the totals honest, and a query is a fixed cost.
  index.setHeight(70_000, 9);
  check(index.totalRows === expected + 8, "a middle height change moves the total by its delta");
  index.insertLine(50_000, 3);
  check(index.lineCount === count + 1 && index.totalRows === expected + 11, "a middle insert adds its height");
  check(index.removeLine(50_000) === 3 && index.totalRows === expected + 8, "and removing it takes it back");

  const queries = 20_000;
  const queryStart = performance.now();
  let sink = 0;
  for (let i = 0; i < queries; i += 1) sink += index.rowToLine((i * 9973) % index.totalRows);
  const perQuery = (performance.now() - queryStart) / queries;
  check(sink > 0, "the queries ran");
  check(built < 5000, `the 100k-line build took ${built.toFixed(1)}ms`);
  check(perQuery < 0.05, `${queries} queries averaged ${(perQuery * 1000).toFixed(2)}µs each`);
});
