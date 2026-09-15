//! The document model: the lines of the open file, the two edits that change
//! them, and the code-unit offset maths that connects them to a caret.

/**
 * A caret position in the document.
 *
 * `row` indexes the line array (`0 <= row < lineCount`); `col` is a UTF-16
 * code-unit index into that line (`0 <= col <= line.length`), i.e. the
 * argument `line.slice(0, col)` takes. A col is NOT a display column and NOT
 * a grapheme index: a CJK glyph or a ZWJ emoji spans several code units and
 * therefore several cols, while it paints in one or two terminal cells.
 * Mapping between code units and terminal cells belongs to the measurement
 * layer — `@tern-tui/core`'s grapheme helpers (`columnToIndex`,
 * `indexToColumn`) are not on its public surface, so this module stays on
 * plain string operations and a later subtask owns display-column mapping.
 */
export interface Position {
  row: number;
  col: number;
}

/** True when both positions name the same caret slot. */
export function positionsEqual(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * The editor's document model: the lines a file is made of, the two mutations
 * an editing command performs, and the offset maths that connects them to a
 * caret. It knows nothing about rendering, keys, selection, or files — it is
 * the data the rest of the app-core argues about.
 *
 * ## Shape
 *
 * The store is a `string[]` of lines, each WITHOUT its trailing newline, so
 * the document text is `lines.join("\n")`. A file that ends in a newline
 * therefore ends with an empty last line, and a fresh buffer is ONE empty
 * line, never zero: every valid caret row has a line to land on, and
 * `text()` of an empty document is `""`, not an error.
 *
 * ## The splice seam
 *
 * `insertText` and `deleteRange` splice the row array directly: a multi-line
 * insert is one `Array.prototype.splice` that replaces the split row with the
 * rows the inserted text describes. This is deliberately the naive line
 * index — a row insertion or removal costs one array memmove, so an edit at
 * the top of a 100k-line document is O(rows). THE ARRAY SPLICE IS EXACTLY THE
 * SEAM A ROPE OR FENWICK LINE INDEX REPLACES LATER (the showcase's 100k-line
 * requirement names a Fenwick index): such an index keeps this module's
 * observable contract — same lines, same offsets, same dirty bit — and swaps
 * the array for a tree. It is not built here, and nothing outside this file
 * may depend on the store being an array.
 *
 * ## Out-of-range positions CLAMP
 *
 * Every row/col argument is clamped into the document: a row to
 * `0..lineCount-1`, a col to `0..line.length` at that row (negatives and
 * `NaN` to 0). Rationale: the callers are key handlers and paste paths that
 * derive positions from cursor state, and a caret parked past the end of a
 * line that has just been shortened is a normal editor condition, not a
 * caller bug — throwing would force every caller to re-derive the same clamp,
 * and one of them would forget. The clamped position is also the effective
 * one for emptiness: a delete whose two ends clamp to the same slot is a
 * no-op.
 *
 * ## Columns and offsets
 *
 * `offsetAt(row, col)` is the code-unit offset of a caret in the document
 * joined with `"\n"`; `positionAt(offset)` inverts it, including the final
 * position `(lineCount-1, lastLine.length)`. Both are O(row): they walk the
 * lines, because the only index this file has is the line array itself. That
 * is the same seam as above — a prefix-sum (Fenwick) index makes both O(log
 * rows) without changing a single result.
 *
 * ## Dirty
 *
 * `dirty` is false on a fresh or freshly loaded buffer, flips true on the
 * first mutation that actually changes the text, and stays true until
 * `markSaved()`. A no-op mutation — inserting `""`, deleting an empty or
 * inverted range — leaves it alone, so a key that does nothing never makes
 * the editor claim unsaved changes.
 */
export class Buffer {
  #lines: string[];
  #dirty = false;

  /** A new, empty document: one empty line, clean. */
  constructor() {
    this.#lines = [""];
  }

  /**
   * A clean buffer holding `text` — the load path. The text is split on
   * `"\n"`, so `fromString(b.text()).text() === b.text()` for every buffer
   * and every string, including `""` (one empty line) and `"a\n"` (two
   * lines, the second empty).
   */
  static fromString(text: string): Buffer {
    const buffer = new Buffer();
    buffer.#lines = text.split("\n");
    return buffer;
  }

  /** The number of lines. A document always has at least one. */
  get lineCount(): number {
    return this.#lines.length;
  }

  /** True when there are unsaved changes. See the class comment. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * The document text: the lines joined with `"\n"`. O(document length) —
   * the whole point of the line store is that rendering and editing never
   * call this.
   */
  text(): string {
    return this.#lines.join("\n");
  }

  /** The line at (clamped) `row`, without its newline. */
  lineAt(row: number): string {
    return this.#lines[clampIndex(row, this.#lines.length - 1)] ?? "";
  }

  /**
   * Insert `text` at (clamped) `(row, col)` and return the caret position
   * just after it — the position a single-line insert reports is
   * `(row, col + text.length)`, and a multi-line insert reports the row that
   * now holds the text after its last newline.
   *
   * `text` is split on `"\n"`. One segment is a pure string splice into
   * `lines[row]`. Several segments SPLICE THE ROW ARRAY: the first segment is
   * appended to `lines[row]` at `col`, the whole middle segments become new
   * rows, and the last segment becomes the head of a new row that carries the
   * original tail of `lines[row]` (so the boundary newline disappears into
   * the row structure). Inserting `""` returns the clamped position and is a
   * no-op that leaves `dirty` false.
   */
  insertText(row: number, col: number, text: string): Position {
    const start = this.#clampPosition({ row, col });
    if (text === "") return start;
    const head = this.#lines[start.row] ?? "";
    const prefix = head.slice(0, start.col);
    const suffix = head.slice(start.col);
    const segments = text.split("\n");
    const first = segments[0] ?? "";
    const last = segments[segments.length - 1] ?? "";
    if (segments.length === 1) {
      this.#lines[start.row] = prefix + first + suffix;
      this.#dirty = true;
      return { row: start.row, col: start.col + text.length };
    }
    const middle = segments.slice(1, -1);
    this.#lines[start.row] = prefix + first;
    this.#insertRows(start.row + 1, middle);
    this.#lines.splice(start.row + 1 + middle.length, 0, last + suffix);
    this.#dirty = true;
    return { row: start.row + segments.length - 1, col: last.length };
  }

  /**
   * Delete the half-open range `[start, end)` and leave the caret at
   * `start`. With both ends on one line this is a string splice; across
   * lines the two boundary lines JOIN and every newline between them goes
   * away, so deleting a whole line (its content and one of its newlines)
   * leaves the document one row shorter.
   *
   * Empty and inverted ranges are no-ops: after clamping, `start` at or after
   * `end` in (row, col) order changes nothing and leaves `dirty` false.
   * Cross-line ranges need no special comparison: `(0, 9) -> (1, 0)` is a
   * valid range even though its columns descend.
   */
  deleteRange(start: Position, end: Position): void {
    const from = this.#clampPosition(start);
    const to = this.#clampPosition(end);
    if (from.row > to.row || (from.row === to.row && from.col >= to.col)) return;
    const head = this.#lines[from.row] ?? "";
    const tail = this.#lines[to.row] ?? "";
    this.#lines.splice(from.row, to.row - from.row + 1, head.slice(0, from.col) + tail.slice(to.col));
    this.#dirty = true;
  }

  /**
   * Mark the current text as the saved state: `dirty` becomes false. The
   * buffer does not remember what was written — the save path owns that — so
   * calling this without saving is a lie the caller tells, not one this class
   * can detect.
   */
  markSaved(): void {
    this.#dirty = false;
  }

  /**
   * The code-unit offset of (clamped) `(row, col)` in `text()`. Inverse of
   * {@link positionAt}: `positionAt(offsetAt(row, col))` is `(row, col)`, and
   * `offsetAt(positionAt(offset))` is `offset`, for every in-range pair and
   * every offset up to the final position.
   */
  offsetAt(row: number, col: number): number {
    const target = clampIndex(row, this.#lines.length - 1);
    let offset = 0;
    for (let i = 0; i < target; i += 1) {
      offset += (this.#lines[i] ?? "").length + 1;
    }
    return offset + clampIndex(col, (this.#lines[target] ?? "").length);
  }

  /**
   * The position of code-unit `offset` in `text()`: the inverse of
   * {@link offsetAt}. An offset past the end clamps to the final position
   * `(lineCount-1, lastLine.length)`, which is where a caret goes when the
   * file was truncated underneath it.
   */
  positionAt(offset: number): Position {
    let remaining = clampIndex(offset, this.#documentLength());
    for (let row = 0; row < this.#lines.length; row += 1) {
      const length = (this.#lines[row] ?? "").length;
      if (remaining <= length) return { row, col: remaining };
      remaining -= length + 1;
    }
    const last = this.#lines.length - 1;
    return { row: last, col: (this.#lines[last] ?? "").length };
  }

  /** The code-unit length of `text()`, without building it. */
  #documentLength(): number {
    let total = this.#lines.length - 1;
    for (const line of this.#lines) total += line.length;
    return total;
  }

  /** Clamp any position into the document. See the class comment. */
  #clampPosition(position: Position): Position {
    const row = clampIndex(position.row, this.#lines.length - 1);
    const line = this.#lines[row] ?? "";
    return { row, col: clampIndex(position.col, line.length) };
  }

  /**
   * Insert whole rows at `at`. Spread arguments are capped by the engine
   * (V8 refuses a spread of ~65k+ elements), so a paste of a large file is
   * inserted in chunks rather than in one call; the observable result is the
   * same single splice.
   */
  #insertRows(at: number, rows: string[]): void {
    for (let i = 0; i < rows.length; i += ROW_SPLICE_CHUNK) {
      this.#lines.splice(at + i, 0, ...rows.slice(i, i + ROW_SPLICE_CHUNK));
    }
  }
}

/** See {@link Buffer}'s `#insertRows`. */
const ROW_SPLICE_CHUNK = 4096;

/**
 * `value` as an integer index in `0..max`, with `NaN` and negatives at 0.
 * The one place this module's clamp policy is expressed.
 */
function clampIndex(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}
