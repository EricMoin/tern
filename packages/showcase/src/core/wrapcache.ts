//! The wrap cache: what one line looks like at one width, remembered until an
//! edit or a width change says otherwise.

import { textareaWidth, wrapLineWithOffsets } from "@tern-tui/core";
import { DEFAULT_LINE_HEIGHT, type LineIndex } from "./lineindex.ts";

/** One display row of a wrapped line: the row's text and the code-unit index in
 * the ORIGINAL line where the row starts. Exactly the shape the framework's
 * {@link wrapLineWithOffsets} returns, so a caret mapped through these offsets
 * uses the same rows the compositor composes (escapes stripped, dropped
 * characters never claimed by a row). */
export interface WrappedRow {
  text: string;
  start: number;
}

/** What the cache remembers about one line: the text it measured — by identity,
 * since a row set is only valid for the text it came from — and the rows. */
interface WrapEntry {
  text: string;
  rows: readonly WrappedRow[];
}

/**
 * The display rows of the lines the viewport has touched, at one wrap width.
 *
 * ## Why it exists
 *
 * The viewport needs a line's display rows twice over: to find the rows the
 * window shows, and to report the index's height for that line. Wrapping a line
 * costs a walk of the line, so the walk is done ONCE per (line, text, width) and
 * remembered: a frame that scrolls one row re-wraps one line, and a document of
 * any size costs the same.
 *
 * ## It is the line index's only writer
 *
 * Every measurement this cache takes is reported to the {@link LineIndex} —
 * `setHeight` on a miss, {@link DEFAULT_LINE_HEIGHT} on an invalidation, and
 * `resetHeights` when the width changes — so the index's height for a line is
 * always the row count of the rows held here. That single-writer rule is the
 * whole invariant: a second writer is how the index and the cache drift apart,
 * and a drifted index windows the wrong lines.
 *
 * ## Edits
 *
 * {@link insertLine} / {@link removeLine} mirror a document splice, and
 * {@link invalidate} drops one line's rows after its text changed. The entry
 * array mirrors the document's row array, so a splice costs one array splice —
 * the same O(rows) seam `buffer.ts` documents (its own edit path), not a new
 * one. Entries are also self-correcting: an entry remembers the text it
 * measured, so a caller that forgets {@link invalidate} gets a re-measure rather
 * than stale rows, and the worst case is a wasted walk instead of a wrong screen.
 *
 * ## Width
 *
 * A width of `null` means "no wrap" — the convention `textareaWidth`,
 * `wrapLineWithOffsets` and `Textarea` share — and is normalized through that
 * same exported helper, so this cache's key and the wrapper's effective width
 * cannot disagree. {@link setWidth} drops every entry: at a new width every row
 * set is a fact about the old one. That drop is one array fill plus one
 * `resetHeights` pass, not a per-line walk.
 *
 * ## Counters
 *
 * {@link wraps} and {@link hits} are cumulative and monotone: they are the
 * evidence the virtualization tests measure a frame's real cost with, so they
 * count calls, not state.
 */
export class WrapCache {
  #index: LineIndex;
  #width: number | null;
  #entries: Array<WrapEntry | undefined>;
  #measured = 0;
  #wraps = 0;
  #hits = 0;

  /**
   * A cache over `index` (whose heights it owns from here on), with an empty
   * entry per line — nothing is measured until it is asked for, which is what
   * makes a 100k-line load O(n) in array fill and nothing else.
   */
  constructor(index: LineIndex, width: number | null) {
    this.#index = index;
    this.#width = normalizeWidth(width);
    this.#entries = new Array<WrapEntry | undefined>(index.lineCount).fill(undefined);
  }

  /** The wrap width in cells, or `null` for no wrap. */
  get width(): number | null {
    return this.#width;
  }

  /** How many lines currently hold measured rows. */
  get measuredLines(): number {
    return this.#measured;
  }

  /** How many lines this cache has wrapped (`wrapLineWithOffsets` calls). */
  get wraps(): number {
    return this.#wraps;
  }

  /** How many {@link rowsOf} calls were served from an entry. */
  get hits(): number {
    return this.#hits;
  }

  /**
   * The display rows of (clamped) `line`, wrapping it at the current width if
   * this is the first ask for this text — the call that reports the line's
   * height to the index.
   */
  rowsOf(line: number, text: string): readonly WrappedRow[] {
    const target = clampIndex(line, this.#index.lineCount - 1);
    const entry = this.#entries[target];
    if (entry !== undefined && entry.text === text) {
      this.#hits += 1;
      return entry.rows;
    }
    const rows = wrapLineWithOffsets(text, this.#width);
    this.#wraps += 1;
    if (entry === undefined) this.#measured += 1;
    this.#entries[target] = { text, rows };
    this.#index.setHeight(target, rows.length);
    return rows;
  }

  /** How many display rows (clamped) `line` occupies — the index's height for
   * it, measured on demand. */
  heightOf(line: number, text: string): number {
    return this.rowsOf(line, text).length;
  }

  /**
   * Drop (clamped) `line`'s rows because its text changed, and return whether
   * there was anything to drop. The line's height goes back to
   * {@link DEFAULT_LINE_HEIGHT} — an honest "not measured yet" — until the
   * viewport asks for it again. (A stale text is caught by
   * {@link rowsOf} anyway; this is what keeps the index honest in between, and
   * what releases the row array.)
   */
  invalidate(line: number): boolean {
    const target = clampIndex(line, this.#index.lineCount - 1);
    if (this.#entries[target] === undefined) return false;
    this.#entries[target] = undefined;
    this.#measured -= 1;
    this.#index.setHeight(target, DEFAULT_LINE_HEIGHT);
    return true;
  }

  /** Mirror a row inserted into the document at (clamped) `at`, with the
   * display height the new line starts at (default one row: it has no measured
   * rows yet). */
  insertLine(at: number, height: number = DEFAULT_LINE_HEIGHT): void {
    const target = clampIndex(at, this.#index.lineCount);
    this.#index.insertLine(target, height);
    this.#entries.splice(target, 0, undefined);
  }

  /** Mirror the removal of (clamped) `line` — the index's answer, or
   * `undefined` when it refused because the document would become empty. */
  removeLine(line: number): number | undefined {
    const target = clampIndex(line, this.#index.lineCount - 1);
    const height = this.#index.removeLine(target);
    if (height === undefined) return undefined;
    if (this.#entries[target] !== undefined) this.#measured -= 1;
    this.#entries.splice(target, 1);
    return height;
  }

  /** Re-wrap everything at `width` (a no-op when the width is unchanged). Every
   * row set is a fact about the old width, so the entries are dropped and the
   * index's heights reset in one pass each. */
  setWidth(width: number | null): void {
    const next = normalizeWidth(width);
    if (next === this.#width) return;
    this.#width = next;
    this.#entries = new Array<WrapEntry | undefined>(this.#index.lineCount).fill(undefined);
    this.#measured = 0;
    this.#index.resetHeights();
  }
}

/** The framework's own "no width" convention, through the exported helper — the
 * cache key and `wrapLineWithOffsets`'s effective width come from one rule. */
function normalizeWidth(width: number | null): number | null {
  return width === null ? null : textareaWidth({ width });
}

/** `value` as an integer index in `0..max` — the clamp rule `lineindex.ts`
 * applies, repeated here because the entry array has to land on the slot the
 * index did (a drift between the two misaligns every later line). */
function clampIndex(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}
