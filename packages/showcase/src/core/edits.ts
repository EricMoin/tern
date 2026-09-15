//! The editing session: the ONE splice, the row-geometry mirror, the undo ring.
//
// A document change is three changes at once — the text, the display-row
// geometry the viewport windows on, and the history that can put it back — and
// they are only correct together. This module is where they happen, so no other
// file has to remember the other two: `state.ts` asks for an edit and gets the
// caret position back, and nothing else in the core touches the buffer.
//
// It owns no caret. Where the caret goes is the selection model's business
// (`selection.ts`), so an edit takes the caret's position as an INPUT (undo has
// to put it back) and never sets one.

import { Buffer, positionsEqual, type Position } from "./buffer.ts";
import { DEFAULT_LINE_HEIGHT, LineIndex } from "./lineindex.ts";
import { clampPosition } from "./motions.ts";
import { selectionText } from "./selection.ts";
import { History } from "./undo.ts";
import { WrapCache } from "./wrapcache.ts";

/** One undoable edit. `after` is the end of the applied content, flipped by
 * undo and redo from the BUFFER's own answer, so this record never mirrors
 * `Buffer.insertText`'s position arithmetic. */
export interface EditStep {
  readonly start: Position;
  readonly end: Position;
  readonly text: string;
  readonly removed: string;
  readonly caretBefore: Position;
  /** Whether this step is a coalescing run of single-character inserts. */
  readonly run: boolean;
  after: Position;
}

/** A requested change: replace `[start, end)` with `text`, from a caret that
 * stood at `caretBefore`. */
export interface EditRequest {
  start: Position;
  end: Position;
  text: string;
  caretBefore: Position;
}

/** A document with the row geometry and the history that must move with it. The
 * three are one value because a splice that updates the buffer and not the
 * geometry windows lines the file no longer has. */
export interface EditingState {
  buffer: Buffer;
  index: LineIndex;
  cache: WrapCache;
  history: History<EditStep>;
}

/** A fresh session over `buffer`: one display row per line until the viewport
 * measures the window (`lineindex.ts`), the given wrap width, no history. */
export function editingState(
  buffer: Buffer,
  cap?: number,
  width: number | null = null,
): EditingState {
  const index = new LineIndex(new Array<number>(buffer.lineCount).fill(DEFAULT_LINE_HEIGHT));
  return {
    buffer,
    index,
    cache: new WrapCache(index, width),
    history: new History<EditStep>({
      ...(cap === undefined ? {} : { cap }),
      merge: mergeSteps,
    }),
  };
}

/** Swap the document, keeping the WRAP WIDTH and the ring size: opening a file
 * does not resize the pane, and dropping the width would re-wrap every line. */
export function reopen(state: EditingState, text: string): EditingState {
  return editingState(Buffer.fromString(text), state.history.cap, state.cache.width);
}

/**
 * Apply one edit and return the position the inserted text ends at.
 *
 * The order matters: the buffer moves first, then the row delta is mirrored
 * into the wrap cache — which is the line index's ONLY writer (`wrapcache.ts`)
 * — and finally the row the splice started in is invalidated, because its text
 * certainly changed. The rows the splice created or removed are dropped by the
 * cache itself and re-measured when the viewport next asks, which is what makes
 * a stale entry a wasted walk rather than a wrong screen.
 */
export function applyEdit(state: EditingState, edit: EditRequest): Position {
  const from = clampPosition(state.buffer, edit.start);
  const to = clampPosition(state.buffer, edit.end);
  const caretBefore = clampPosition(state.buffer, edit.caretBefore);
  const removed = selectionText(state.buffer, { anchor: from, caret: to });
  const after = splice(state, from, to, edit.text);
  state.history.push({
    start: from,
    end: to,
    text: edit.text,
    removed,
    caretBefore,
    after,
    run: edit.text.length === 1 && edit.text !== "\n",
  });
  return after;
}

/** Undo (`back`) or redo one step and return where the caret should go, or
 * `null` when the ring has nothing in that direction. */
export function travel(state: EditingState, back: boolean): Position | null {
  const step = back ? state.history.undo() : state.history.redo();
  if (step === undefined) return null;
  const from = clampPosition(state.buffer, step.start);
  step.after = splice(state, from, step.after, back ? step.removed : step.text);
  return clampPosition(state.buffer, back ? step.caretBefore : step.after);
}

/** The buffer splice plus the row-geometry mirror — the single value every edit
 * and every history step goes through. */
function splice(
  state: EditingState,
  start: Position,
  end: Position,
  text: string,
): Position {
  const before = state.buffer.lineCount;
  state.buffer.deleteRange(start, end);
  const caret = state.buffer.insertText(start.row, start.col, text);
  const added = state.buffer.lineCount - before;
  for (let i = 0; i < added; i += 1) state.cache.insertLine(start.row + 1 + i);
  for (let i = 0; i < -added; i += 1) state.cache.removeLine(start.row + 1);
  state.cache.invalidate(start.row);
  return caret;
}

/**
 * `undo.ts`'s documented coalescing rule, in this module's entry shape: a
 * single-character insert with no newline that continues exactly where the
 * previous step left off joins it, so typing `abcdef` is ONE undo. A paste, an
 * Enter, a delete, a replace or a gap starts a new step — and the ring's own
 * `breakCoalesce` covers what the entry shape cannot see, like a cursor move.
 */
function mergeSteps(previous: EditStep, next: EditStep): EditStep | undefined {
  if (!previous.run || !next.run) return undefined;
  if (previous.removed !== "" || !positionsEqual(previous.after, next.start)) return undefined;
  return { ...previous, text: previous.text + next.text, after: next.after };
}
