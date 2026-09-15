//! Selection: the anchor/caret model, its expansions, and the mouse paths.
//
// There is ONE selection model in the app-core, and the keyboard, a mouse drag
// and a double-click all drive it — a second model for "mouse selection" is how
// the two drift and how a copy returns text the user never highlighted. The
// model OWNS THE CARET: a selection is an anchor plus the caret's current slot,
// so there is no second owner of the caret to disagree with, and "no selection"
// is null rather than a collapsed pair nobody checks. Nothing here builds a
// scene or names a renderer.

import { positionsEqual, type Buffer, type Position } from "./buffer.ts";
import {
  applyMotion,
  clampPosition,
  classOf,
  NO_GOAL,
  type GoalColumn,
  type Motion,
  type MotionContext,
} from "./motions.ts";

/** What a selection expands to. A word is a run of one character class; a line
 * and a paragraph carry their trailing newline so deleting them removes the
 * rows rather than emptying them. */
export type SelectionUnit = "word" | "line" | "paragraph";

/** A selection's two ends. `anchor` is the end that stays put while the caret
 * moves; `caret` is the end that follows the keyboard. */
export interface Selection {
  anchor: Position;
  caret: Position;
}

/** A selection's ends in document order — what every consumer that spans a
 * range actually needs, and the one place the comparison is written. */
export function ordered(selection: Selection): { start: Position; end: Position } {
  const { anchor, caret } = selection;
  const forward = anchor.row < caret.row ||
    (anchor.row === caret.row && anchor.col <= caret.col);
  return forward ? { start: anchor, end: caret } : { start: caret, end: anchor };
}

/** The selected text: one line's slice, or the head line, the lines between and
 * the tail line joined with a newline — the join `Buffer.text()` uses, so a
 * copy of a whole document round-trips through `Buffer.fromString`. */
export function selectionText(buffer: Buffer, selection: Selection): string {
  const { start, end } = ordered(selection);
  if (start.row === end.row) return buffer.lineAt(start.row).slice(start.col, end.col);
  const parts = [buffer.lineAt(start.row).slice(start.col)];
  for (let row = start.row + 1; row < end.row; row += 1) parts.push(buffer.lineAt(row));
  parts.push(buffer.lineAt(end.row).slice(0, end.col));
  return parts.join("\n");
}

/** The maximal run of the character class the caret stands in — the word a
 * double-click picks up, and equally the punctuation or whitespace run beside
 * it, so the expansion is total rather than "a word, or nothing". A caret at
 * the line's end belongs to the last character; an empty line has one empty run
 * at column 0. */
export function classRunAt(line: string, col: number): { start: number; end: number } {
  const starts: number[] = [];
  const ends: number[] = [];
  const kinds: Array<"space" | "word" | "other"> = [];
  let index = 0;
  for (const point of line) {
    starts.push(index);
    ends.push(index + point.length);
    kinds.push(classOf(point));
    index += point.length;
  }
  if (starts.length === 0) return { start: 0, end: 0 };
  let at = 0;
  while (at + 1 < starts.length && starts[at + 1]! <= col) at += 1;
  const kind = kinds[at]!;
  let first = at;
  while (first > 0 && kinds[first - 1] === kind) first -= 1;
  let last = at;
  while (last + 1 < kinds.length && kinds[last + 1] === kind) last += 1;
  return { start: starts[first]!, end: ends[last]! };
}

/** The first and last line of the paragraph containing `row` — a maximal run
 * of lines that are all blank or all non-blank. */
export function paragraphBounds(buffer: Buffer, row: number): { first: number; last: number } {
  const end = buffer.lineCount - 1;
  const blank = buffer.lineAt(row).trim() === "";
  let first = row;
  while (first > 0 && (buffer.lineAt(first - 1).trim() === "") === blank) first -= 1;
  let last = row;
  while (last < end && (buffer.lineAt(last + 1).trim() === "") === blank) last += 1;
  return { first, last };
}

/** The selection a unit-expansion of `position` produces. A `line` and a
 * `paragraph` reach to the start of the line AFTER them when there is one, so
 * deleting the selection removes the rows; at the document's end there is no
 * newline to take, and the selection stops at the last line's end. */
export function expandSelection(
  buffer: Buffer,
  position: Position,
  unit: SelectionUnit,
): Selection {
  const at = clampPosition(buffer, position);
  if (unit === "word") {
    const run = classRunAt(buffer.lineAt(at.row), at.col);
    return { anchor: { row: at.row, col: run.start }, caret: { row: at.row, col: run.end } };
  }
  const bounds = unit === "line"
    ? { first: at.row, last: at.row }
    : paragraphBounds(buffer, at.row);
  const after = bounds.last + 1;
  const anchor: Position = { row: bounds.first, col: 0 };
  const caret: Position = after < buffer.lineCount
    ? { row: after, col: 0 }
    : { row: bounds.last, col: buffer.lineAt(bounds.last).length };
  return { anchor, caret };
}

/**
 * The app-core's selection: the anchor, the caret, and the sticky vertical goal
 * column that belongs to the caret.
 *
 * ## One owner of the caret
 *
 * The caret lives HERE, not beside the model, because a selection IS the caret
 * plus the end it was dragged from. Every way the caret can move goes through
 * this class — `move` for a motion, `moveTo` for an absolute jump, `press` and
 * `dragTo` for the mouse — so the anchor's lifetime is decided in one place
 * instead of at each call site, and a stale anchor cannot survive a keystroke
 * that was supposed to collapse the selection.
 *
 * ## Extending
 *
 * `move(ctx, motion, extend)` extends while `extend` is true (shift held) and
 * collapses otherwise. Extending with no anchor yet seeds the anchor from where
 * the caret stood BEFORE the motion, so the first shift-move selects exactly
 * the motion's span — the behavior a user expects from a shift-arrow, and the
 * reason this takes the motion rather than a finished position.
 *
 * ## Mouse
 *
 * `press` starts a drag (anchor and caret at the press), `dragTo` moves the
 * caret and leaves the anchor alone, and `doubleClick` is `select(..., "word")`.
 * The double-click WINDOW is not decided here: how many milliseconds apart two
 * presses were is a property of the mouse layer that saw them, and a clock
 * inside the core would make the core untestable without controlling time.
 */
export class SelectionModel {
  #caret: Position = { row: 0, col: 0 };
  #anchor: Position | null = null;
  #goal: GoalColumn = NO_GOAL;

  /** The caret's current slot. */
  get caret(): Position {
    return this.#caret;
  }

  /** The anchor, or `null` when nothing is selected. */
  get anchor(): Position | null {
    return this.#anchor;
  }

  /** The vertical goal column of the caret (see `motions.ts`). */
  get goal(): GoalColumn {
    return this.#goal;
  }

  /** The selection, or `null` when there is no anchor or it sits on the caret
   * — a click that never dragged selects nothing, and saying so once here keeps
   * every consumer from re-testing it. */
  get selection(): Selection | null {
    if (this.#anchor === null || positionsEqual(this.#anchor, this.#caret)) return null;
    return { anchor: this.#anchor, caret: this.#caret };
  }

  /** Put the caret at `position` and drop the selection — an absolute jump. */
  moveTo(position: Position): void {
    this.#caret = position;
    this.#anchor = null;
    this.#goal = NO_GOAL;
  }

  /** Put the caret at `position`, seeding the anchor from where it stood — the
   * shape a host needs for a shift-click, which has no motion to run. */
  extendTo(position: Position): void {
    this.#anchor = this.#anchor ?? this.#caret;
    this.#caret = position;
  }

  /** Forget the selection and leave the caret where it is. */
  clear(): void {
    this.#anchor = null;
  }

  /** Run a motion: the caret moves, the anchor follows the `extend` rule, and
   * the goal column the motion reported becomes the caret's. */
  move(ctx: MotionContext, motion: Motion, extend: boolean): Position {
    const from = this.#caret;
    const result = applyMotion(ctx, from, motion, this.#goal);
    this.#caret = result.position;
    this.#goal = result.goal;
    if (extend) this.#anchor = this.#anchor ?? from;
    else this.#anchor = null;
    return this.#caret;
  }

  /** The mouse's press: both ends at `position`, which begins a drag. */
  press(position: Position): void {
    this.#caret = position;
    this.#anchor = position;
    this.#goal = NO_GOAL;
  }

  /** The mouse's drag: the caret follows the pointer, the anchor stays where the
   * press put it (or where the caret already was, for a drag with no press). */
  dragTo(position: Position): void {
    this.#anchor = this.#anchor ?? this.#caret;
    this.#caret = position;
  }

  /** Select the unit at `position` — what a double-click, a triple-click and a
   * "select line" command all are. */
  select(buffer: Buffer, position: Position, unit: SelectionUnit): Selection {
    const selection = expandSelection(buffer, clampPosition(buffer, position), unit);
    this.#anchor = selection.anchor;
    this.#caret = selection.caret;
    this.#goal = NO_GOAL;
    return selection;
  }

  /** A double-click at `position`: the word there, through the same path as
   * every other expansion. */
  doubleClick(buffer: Buffer, position: Position): Selection {
    return this.select(buffer, position, "word");
  }

  /** The selected text, or the empty string when nothing is selected. */
  text(buffer: Buffer): string {
    const selection = this.selection;
    return selection === null ? "" : selectionText(buffer, selection);
  }
}
