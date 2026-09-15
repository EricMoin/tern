//! The line index: display-row geometry over a 100k-line document, without
//! measuring the document.

/** The height an unmeasured line counts as: exactly ONE display row — true at
 * no wrap width, a documented underestimate under soft wrap. A cold 100k-line
 * document must answer every query in O(log n), and "one row until proven
 * taller" is what lets it (see {@link LineIndex}). */
export const DEFAULT_LINE_HEIGHT = 1;

/** A display row resolved to the line that owns it and the row's offset
 * (display-line index) inside that line. */
export interface LineLocation {
  line: number;
  offset: number;
}

/**
 * The display-row geometry of a document: a prefix sum of per-line display
 * heights, answering row↔line — and accepting edits — in O(log lines).
 *
 * Soft wrap breaks the identity the framework's windowed elements rest on
 * (`contentHeight == rowCount`: `table.ts`'s `TableRegionState` and region
 * geometry, `Tree` every rebuild), so a table's fixed-height slice
 * `rows[scroll_y, scroll_y + viewport)` cannot express an editor's window — the
 * slice bounds are the thing to be computed. This index computes them, so a
 * viewport update costs a function of the WINDOW, never of the file.
 *
 * A flat Fenwick array gives the same prefix sums, but a mid-document splice
 * renumbers every later line and forces an O(n) rebuild — and an editor splices
 * on every newline. So the index keeps the Fenwick algebra (a subtree's stored
 * sum IS the prefix sum of the lines it holds) and buys the splice by SHAPE: an
 * implicit treap whose in-order walk is document order, with `size` (lines) and
 * `sum` (display rows) per subtree. Priorities come from a fixed-seed
 * xorshift32, so an edit sequence builds the same tree every run.
 *
 * Heights are learned, never computed: wrapping costs a walk of the line, so the
 * index holds only the heights it is TOLD and counts the rest as
 * {@link DEFAULT_LINE_HEIGHT}, becoming exact as the wrap cache — its only
 * writer — measures the window. Lines clamp into `0..lineCount-1`, rows into
 * `0..totalRows-1` (the `buffer.ts` policy: a stale position is a normal editor
 * condition), and a sub-default, non-finite or fractional height normalizes to
 * the default, because a zero-height line makes the row→line map ambiguous. The
 * index mirrors the always-one-line document: `new LineIndex()` is ONE line and
 * {@link removeLine} refuses to remove the last.
 */
export class LineIndex {
  // Node 0 is the null sentinel: slot 0 of every array is a zero no real node
  // is ever allocated, so the tree code reads a child unconditionally.
  #left: number[] = [0];
  #right: number[] = [0];
  #prio: number[] = [0];
  #size: number[] = [0];
  #sum: number[] = [0];
  #height: number[] = [0];
  #root = 0;
  #free: number[] = [];
  #state = 0x9e3779b9;
  #splitLeft = 0;
  #splitRight = 0;

  /** The geometry of `heights` in document order, built in ONE O(n) pass (the
   * Cartesian tree of the priority stream, not n merges) — the 100k-line load
   * path. No argument is the one-line document of `new Buffer()`. */
  constructor(heights?: readonly number[]) {
    const stack: number[] = [];
    for (const height of heights?.length ? heights : [DEFAULT_LINE_HEIGHT]) {
      const node = this.#alloc(height);
      let last = 0;
      while (stack.length > 0 && this.#prio[stack[stack.length - 1]!]! < this.#prio[node]!) {
        last = stack.pop()!;
      }
      this.#left[node] = last;
      const parent = stack.length > 0 ? stack[stack.length - 1]! : 0;
      if (parent !== 0) this.#right[parent] = node;
      stack.push(node);
    }
    this.#root = stack[0]!;
    this.#pull(this.#root);
  }

  /** The number of logical lines. Always at least one. */
  get lineCount(): number {
    return this.#size[this.#root]!;
  }

  /** The total display rows: the sum of every KNOWN height, so exact once every
   * line has been measured. */
  get totalRows(): number {
    return this.#sum[this.#root]!;
  }

  /** The display row where (clamped) `line` starts: the sum of the heights of
   * every line before it. `lineToRow(lineCount)` is {@link totalRows}, so
   * `[lineToRow(l), lineToRow(l + 1))` covers line `l` exactly. */
  lineToRow(line: number): number {
    const target = clampIndex(line, this.lineCount);
    let node = this.#root;
    let rows = 0;
    let rest = target;
    while (node !== 0) {
      const left = this.#left[node]!;
      const leftSize = this.#size[left]!;
      if (rest <= leftSize) {
        node = left;
        continue;
      }
      rows += this.#sum[left]! + this.#height[node]!;
      rest -= leftSize + 1;
      node = this.#right[node]!;
    }
    return rows;
  }

  /** The line and intra-line offset that display row (clamped) `row` falls in. */
  locate(row: number): LineLocation {
    const target = clampIndex(row, Math.max(0, this.totalRows - 1));
    let node = this.#root;
    let line = 0;
    let rows = 0;
    while (node !== 0) {
      const left = this.#left[node]!;
      const leftSize = this.#size[left]!;
      const leftSum = this.#sum[left]!;
      const height = this.#height[node]!;
      if (target < rows + leftSum) {
        node = left;
        continue;
      }
      if (target < rows + leftSum + height) {
        return { line: line + leftSize, offset: target - rows - leftSum };
      }
      rows += leftSum + height;
      line += leftSize + 1;
      node = this.#right[node]!;
    }
    // Unreachable — the clamp lands inside an index that always has a line —
    // but total for the type system.
    return { line: this.lineCount - 1, offset: 0 };
  }

  /** The line owning display row (clamped) `row`. */
  rowToLine(row: number): number {
    return this.locate(row).line;
  }

  /** Report the measured display height of (clamped) `line`. */
  setHeight(line: number, height: number): void {
    this.#split(this.#root, clampIndex(line, this.lineCount - 1));
    const before = this.#splitLeft;
    this.#split(this.#splitRight, 1);
    const node = this.#splitLeft;
    const after = this.#splitRight;
    this.#height[node] = normalizeHeight(height);
    this.#sum[node] = this.#height[node]!;
    this.#root = this.#merge(this.#merge(before, node), after);
  }

  /** Insert a line at (clamped) `at` with the given display height (default
   * {@link DEFAULT_LINE_HEIGHT}). */
  insertLine(at: number, height: number = DEFAULT_LINE_HEIGHT): void {
    const node = this.#alloc(height);
    this.#split(this.#root, clampIndex(at, this.lineCount));
    const before = this.#splitLeft;
    const after = this.#splitRight;
    this.#root = this.#merge(this.#merge(before, node), after);
  }

  /** Remove (clamped) `line`, returning the height it had — the caller's
   * inverse: re-inserting that height invalidates nothing — or `undefined` when
   * refused because the document would become empty. */
  removeLine(line: number): number | undefined {
    if (this.lineCount <= 1) return undefined;
    this.#split(this.#root, clampIndex(line, this.lineCount - 1));
    const before = this.#splitLeft;
    this.#split(this.#splitRight, 1);
    const removed = this.#splitLeft;
    const after = this.#splitRight;
    this.#root = this.#merge(before, after);
    const height = this.#height[removed]!;
    this.#free.push(removed);
    return height;
  }

  /** Forget every measured height — set all lines to `height` in one O(n) pass.
   * This is the wrap-width-change path: a new width re-wraps every line, so
   * every stored height is a fact about the old width, and n `setHeight` calls
   * would cost O(n log n) for no extra information. */
  resetHeights(height: number = DEFAULT_LINE_HEIGHT): void {
    this.#fill(this.#root, normalizeHeight(height));
    this.#pull(this.#root);
  }

  /** A node holding one line of `height`, recycled from the free list when
   * possible — a deleted line's slot is what the next inserted line reuses. */
  #alloc(height: number): number {
    const node = this.#free.pop() ?? this.#grow();
    this.#left[node] = 0;
    this.#right[node] = 0;
    this.#prio[node] = this.#nextPriority();
    this.#size[node] = 1;
    this.#height[node] = normalizeHeight(height);
    this.#sum[node] = this.#height[node]!;
    return node;
  }

  /** Append a slot to every node array and return its index. */
  #grow(): number {
    this.#left.push(0); this.#right.push(0); this.#prio.push(0);
    this.#size.push(0); this.#sum.push(0); this.#height.push(0);
    return this.#left.length - 1;
  }

  /** xorshift32: the fixed-seed priority stream of the class comment. */
  #nextPriority(): number {
    let x = this.#state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.#state = x;
    return x;
  }

  /** Re-derive a node's aggregates from its children. */
  #update(node: number): void {
    const left = this.#left[node]!;
    const right = this.#right[node]!;
    this.#size[node] = this.#size[left]! + this.#size[right]! + 1;
    this.#sum[node] = this.#sum[left]! + this.#sum[right]! + this.#height[node]!;
  }

  /** Re-derive every aggregate bottom-up (the treap is O(log n) deep in
   * expectation, so the recursion is shallow). */
  #pull(node: number): void {
    if (node === 0) return;
    this.#pull(this.#left[node]!);
    this.#pull(this.#right[node]!);
    this.#update(node);
  }

  /** Set the height of every node of a subtree (see {@link resetHeights}). */
  #fill(node: number, height: number): void {
    if (node === 0) return;
    this.#height[node] = height;
    this.#fill(this.#left[node]!, height);
    this.#fill(this.#right[node]!, height);
  }

  /** Merge two trees whose in-order walks are adjacent, by priority. */
  #merge(a: number, b: number): number {
    if (a === 0 || b === 0) return a === 0 ? b : a;
    if (this.#prio[a]! > this.#prio[b]!) {
      this.#right[a] = this.#merge(this.#right[a]!, b);
      this.#update(a);
      return a;
    }
    this.#left[b] = this.#merge(a, this.#left[b]!);
    this.#update(b);
    return b;
  }

  /** Cut `node` into its first `count` lines and the rest, left in
   * `#splitLeft` / `#splitRight` (two fields, not a pair: the edit path splits
   * twice and a pair would allocate there). */
  #split(node: number, count: number): void {
    if (node === 0) {
      this.#splitLeft = 0;
      this.#splitRight = 0;
      return;
    }
    const left = this.#left[node]!;
    if (this.#size[left]! < count) {
      this.#split(this.#right[node]!, count - this.#size[left]! - 1);
      this.#right[node] = this.#splitLeft;
      this.#update(node);
      this.#splitLeft = node;
      return;
    }
    this.#split(left, count);
    this.#left[node] = this.#splitRight;
    this.#update(node);
    this.#splitRight = node;
  }
}

/** `value` as an integer index in `0..max`: the clamp policy `buffer.ts`
 * applies to positions (NaN and negatives at 0). */
function clampIndex(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}

/** A height as the index stores it: at least {@link DEFAULT_LINE_HEIGHT}. */
function normalizeHeight(height: number): number {
  const value = Math.trunc(height);
  return Number.isFinite(value) && value > DEFAULT_LINE_HEIGHT ? value : DEFAULT_LINE_HEIGHT;
}
