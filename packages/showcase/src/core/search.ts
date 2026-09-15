//! Search: literal incremental find, and replace as a list of edits.
//
// LITERAL ONLY. There is no pattern language here, no \`RegExp\`, no regex
// dependency: `indexOf` and a code-unit fold are the whole matcher. That is a
// scope decision, not a missing feature — a regex engine in the app-core would
// be a second decision point about what the user's text MEANS, and the first
// one already lives in the document model.
//
// This module never mutates the buffer. Replace is expressed as a list of
// {@link TextEdit} descriptors the state machine applies through its own
// splice, which is the only path that keeps the line index and the wrap cache
// in step with the document (see `state.ts`). A second place that edited the
// buffer would be a second place that had to remember the row geometry.

import type { Buffer, Position } from "./buffer.ts";

/** A half-open code-unit range and the text that replaces it. */
export interface TextEdit {
  start: Position;
  end: Position;
  text: string;
}

/** How a search compares text. */
export interface SearchOptions {
  /** Compare case-sensitively (default false). */
  caseSensitive?: boolean;
}

/** One literal occurrence. `length` is in code units, so `end` is
 * `col + length` — the ranges `Buffer.deleteRange` takes. */
export interface SearchMatch {
  row: number;
  col: number;
  length: number;
  start: Position;
  end: Position;
}

/**
 * Every literal occurrence of `query`, in document order.
 *
 * Matches are found LINE BY LINE, so a literal never spans a newline: a query
 * containing `"\n"` matches nothing rather than being silently split. Matches
 * within a line do not overlap (the scan resumes after each hit), which is what
 * makes `"aa"` in `"aaa"` one match and not two — the rule that keeps
 * replace-all from re-replacing the text it just wrote.
 *
 * The case-insensitive path compares CODE UNIT to code unit through
 * `toLowerCase`, not by lowercasing the whole line: `"İ".toLowerCase()` is two
 * code units, so folding the line first would shift every later match's index
 * and hand `deleteRange` a range in the wrong place. Per-unit folding cannot
 * shift anything. It is not full Unicode case folding — a fold that needs more
 * than `toLowerCase` on one code unit simply does not match — and the
 * case-sensitive path uses `indexOf`, which is the C++-speed one.
 */
export function findMatches(
  buffer: Buffer,
  query: string,
  options: SearchOptions = {},
): SearchMatch[] {
  if (query === "") return [];
  const caseSensitive = options.caseSensitive ?? false;
  const matches: SearchMatch[] = [];
  for (let row = 0; row < buffer.lineCount; row += 1) {
    const line = buffer.lineAt(row);
    let from = 0;
    for (;;) {
      const col = caseSensitive
        ? line.indexOf(query, from)
        : indexOfFolded(line, query, from);
      if (col < 0) break;
      matches.push(matchAt(row, col, query.length));
      from = col + query.length;
    }
  }
  return matches;
}

/** The match that covers `position`, or `null`. A caret at the match's end is
 * INSIDE it (`end` is exclusive, and a caret there is still looking at the
 * text), which is the boundary a user reads as "on the match". */
export function matchContaining(
  matches: readonly SearchMatch[],
  position: Position,
): SearchMatch | null {
  for (const match of matches) {
    if (match.row !== position.row) continue;
    if (position.col >= match.col && position.col <= match.col + match.length) return match;
  }
  return null;
}

/**
 * The match a search from `position` lands on: the first that starts at or
 * after it going forward, the last that starts before it going backward, and
 * WRAPPING to the other end of the document in both directions — a search with
 * no wrap is a search that silently does nothing on the last hit.
 *
 * `-1` means there is no match at all. To advance past the match the caret is
 * already on, search from its `end`; that is what a find-next key does, and
 * why this takes a position rather than a match index.
 */
export function nextMatchIndex(
  matches: readonly SearchMatch[],
  position: Position,
  direction: 1 | -1,
): number {
  if (matches.length === 0) return -1;
  if (direction > 0) {
    for (let i = 0; i < matches.length; i += 1) {
      if (compare(matches[i]!.start, position) >= 0) return i;
    }
    return 0;
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (compare(matches[i]!.start, position) < 0) return i;
  }
  return matches.length - 1;
}

/** The edit that replaces `match` with `replacement`. */
export function replaceEdit(match: SearchMatch, replacement: string): TextEdit {
  return { start: match.start, end: match.end, text: replacement };
}

/**
 * Every edit a replace-all performs, in REVERSE document order.
 *
 * The order is the point. Applying edits from the end of the document toward
 * the front leaves every earlier edit's offsets valid, so the caller can walk
 * the list with one forward loop and one splice per edit and never re-derive a
 * position; applying them front to back would shift each later match by the
 * length difference of the one before it. The list is a single pass over the
 * ORIGINAL text — a replacement that itself contains the query is written once
 * and never re-found, which is what stops replace-all from looping.
 */
export function replaceAllEdits(
  buffer: Buffer,
  query: string,
  replacement: string,
  options: SearchOptions = {},
): TextEdit[] {
  const edits = findMatches(buffer, query, options).map((match) =>
    replaceEdit(match, replacement)
  );
  edits.reverse();
  return edits;
}

/**
 * One incremental find session: the query, how it compares, and the match the
 * caret is on.
 *
 * Matches are RECOMPUTED per step rather than cached, because a cached list
 * goes stale the moment the buffer changes and a stale match is a replace that
 * deletes the wrong text. The cost is a full document scan per step, which is
 * the seam an incremental index (a per-line match cache invalidated by the same
 * splice the wrap cache already follows) replaces later without changing a
 * single result here.
 */
export class SearchSession {
  #query = "";
  #caseSensitive = false;
  #current: SearchMatch | null = null;

  /** The literal being searched for. */
  get query(): string {
    return this.#query;
  }

  /** Whether a search is open — an open session with an empty query matches
   * nothing, so `active` is what a status line should show. */
  get active(): boolean {
    return this.#query !== "";
  }

  /** Whether the comparison is case-sensitive. */
  get caseSensitive(): boolean {
    return this.#caseSensitive;
  }

  /** The match the caret is on, or `null`. */
  get current(): SearchMatch | null {
    return this.#current;
  }

  /** Begin (or retarget) a search. The current match is dropped: it described
   * the old query. */
  open(query: string, options: SearchOptions = {}): void {
    this.#query = query;
    this.#caseSensitive = options.caseSensitive ?? this.#caseSensitive;
    this.#current = null;
  }

  /** Flip the case sensitivity of the open query, dropping the current match:
   * it was found under the old comparison. */
  setCaseSensitive(on: boolean): void {
    this.#caseSensitive = on;
    this.#current = null;
  }

  /** End the search and forget the query. */
  close(): void {
    this.#query = "";
    this.#current = null;
  }

  /** The matches of the current query. */
  matches(buffer: Buffer): SearchMatch[] {
    return findMatches(buffer, this.#query, { caseSensitive: this.#caseSensitive });
  }

  /**
   * Step to the next (`direction` 1) or previous (-1) match from `caret` and
   * make it current, or `null` when the query matches nothing.
   *
   * The origin is the match the caret is standing on — its END going forward,
   * its START going backward — so pressing find-next again ADVANCES instead of
   * re-finding the hit under the caret and appearing to hang. The one exception
   * is the first step of a fresh query, which lands on the match at or after
   * the caret rather than skipping it. When the caret is not on a match at all,
   * the caret itself is the origin, which is what makes find-next work after
   * the user moved the cursor.
   */
  step(buffer: Buffer, caret: Position, direction: 1 | -1): SearchMatch | null {
    const matches = this.matches(buffer);
    if (matches.length === 0) {
      this.#current = null;
      return null;
    }
    const inside = matchContaining(matches, caret);
    const origin = inside === null || this.#current === null
      ? caret
      : (direction > 0 ? inside.end : inside.start);
    const index = nextMatchIndex(matches, origin, direction);
    this.#current = index < 0 ? null : matches[index]!;
    return this.#current;
  }
}

/** One occurrence at `(row, col)`. */
function matchAt(row: number, col: number, length: number): SearchMatch {
  return {
    row,
    col,
    length,
    start: { row, col },
    end: { row, col: col + length },
  };
}

/** Document order over positions. */
function compare(a: Position, b: Position): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

/** The first index at or after `from` where `needle` occurs in `line`,
 * compared one code unit at a time through `toLowerCase` — see
 * {@link findMatches} for why the line is not folded wholesale. */
function indexOfFolded(line: string, needle: string, from: number): number {
  const last = line.length - needle.length;
  for (let start = Math.max(0, from); start <= last; start += 1) {
    let offset = 0;
    while (
      offset < needle.length &&
      line[start + offset]!.toLowerCase() === needle[offset]!.toLowerCase()
    ) {
      offset += 1;
    }
    if (offset === needle.length) return start;
  }
  return -1;
}
