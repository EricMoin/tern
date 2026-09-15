//! Tests: the selection model — expansion units, text, and the mouse paths.

import { Buffer } from "./buffer.ts";
import { LineIndex } from "./lineindex.ts";
import type { MotionContext } from "./motions.ts";
import {
  classRunAt,
  expandSelection,
  ordered,
  paragraphBounds,
  SelectionModel,
  selectionText,
  type Selection,
} from "./selection.ts";
import { WrapCache } from "./wrapcache.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const LINES = ["alpha beta", "", "gamma, delta", "epsilon"];

function makeContext(): MotionContext {
  const buffer = Buffer.fromString(LINES.join("\n"));
  const index = new LineIndex(new Array<number>(LINES.length).fill(1));
  return { buffer, index, cache: new WrapCache(index, 40) };
}

/** A selection's two ends, as `anchor->caret`. */
function ends(selection: Selection): string {
  return `${selection.anchor.row}:${selection.anchor.col}->${selection.caret.row}:${selection.caret.col}`;
}

/** The model's selection, asserted to exist. */
function held(model: SelectionModel): Selection {
  const selection = model.selection;
  if (selection === null) throw new Error("expected a selection");
  return selection;
}

Deno.test("selection: a word expansion is the run of the caret's own class", () => {
  check(classRunAt("alpha beta", 2).start === 0 && classRunAt("alpha beta", 2).end === 5,
    "inside a word, the whole word");
  check(classRunAt("alpha beta", 5).start === 5 && classRunAt("alpha beta", 5).end === 6,
    "on the separator, the separator run");
  check(classRunAt("gamma, delta", 5).start === 5 && classRunAt("gamma, delta", 5).end === 6,
    "punctuation is a run of its own");
  check(classRunAt("", 0).start === 0 && classRunAt("", 0).end === 0, "an empty line is an empty run");
  check(classRunAt("abc", 3).start === 0 && classRunAt("abc", 3).end === 3,
    "a caret at the line's end belongs to the last character");
  check(classRunAt("日本語", 1).start === 0 && classRunAt("日本語", 1).end === 3,
    "a run is measured in code UNITS, so three CJK glyphs span three");
});

Deno.test("selection: line and paragraph expansions take their trailing newline", () => {
  const ctx = makeContext();
  const line = expandSelection(ctx.buffer, { row: 0, col: 3 }, "line");
  check(ends(line) === "0:0->1:0", "a line reaches the start of the next line");
  check(selectionText(ctx.buffer, line) === "alpha beta\n", "which is the line plus its newline");

  const last = expandSelection(ctx.buffer, { row: 3, col: 1 }, "line");
  check(ends(last) === "3:0->3:7", "the last line stops at its own end");

  const bounds = paragraphBounds(ctx.buffer, 2);
  check(bounds.first === 2 && bounds.last === 3, "two adjacent non-blank lines are one paragraph");
  const paragraph = expandSelection(ctx.buffer, { row: 2, col: 1 }, "paragraph");
  check(ends(paragraph) === "2:0->3:7", "a paragraph ends where its last line does");

  const blank = expandSelection(ctx.buffer, { row: 1, col: 0 }, "paragraph");
  check(ends(blank) === "1:0->2:0", "a blank line's paragraph is the blank run");

  const word = expandSelection(ctx.buffer, { row: 0, col: 0 }, "word");
  check(selectionText(ctx.buffer, word) === "alpha", "a word expansion reads back its own text");
});

Deno.test("selection: document order and text are inverses of either end", () => {
  const ctx = makeContext();
  const forward: Selection = { anchor: { row: 0, col: 3 }, caret: { row: 2, col: 4 } };
  const backward: Selection = { anchor: { row: 2, col: 4 }, caret: { row: 0, col: 3 } };
  check(ordered(forward).start.row === 0 && ordered(forward).end.row === 2, "forward order");
  check(ordered(backward).start.row === 0 && ordered(backward).end.row === 2, "backward order");
  check(selectionText(ctx.buffer, forward) === selectionText(ctx.buffer, backward), "the same text");
  check(selectionText(ctx.buffer, forward) === "ha beta\n\ngamm",
    `the joined text of three lines (${selectionText(ctx.buffer, forward)})`);
});

Deno.test("selection: the model owns the caret and the mouse drives the same path", () => {
  const ctx = makeContext();
  const model = new SelectionModel();
  check(model.caret.row === 0 && model.caret.col === 0, "a fresh model has the caret at the origin");
  check(model.selection === null && model.anchor === null, "and nothing selected");

  model.press({ row: 0, col: 1 });
  check(model.selection === null, "a press alone selects nothing");
  model.dragTo({ row: 0, col: 4 });
  check(ends(held(model)) === "0:1->0:4", "a drag extends from the press");
  check(model.text(ctx.buffer) === "lph", "and reads back the dragged text");
  model.dragTo({ row: 0, col: 1 });
  check(model.selection === null, "dragging back onto the anchor collapses it");

  model.press({ row: 0, col: 6 });
  model.dragTo({ row: 2, col: 3 });
  check(model.text(ctx.buffer) === "beta\n\ngam", "a drag across lines reads the joined text");

  model.doubleClick(ctx.buffer, { row: 0, col: 3 });
  check(ends(held(model)) === "0:0->0:5", "a double-click selects the word");
  check(model.text(ctx.buffer) === "alpha", "and it is the word's own text");

  model.select(ctx.buffer, { row: 2, col: 6 }, "line");
  check(model.text(ctx.buffer) === "gamma, delta\n", "a triple-click line takes its newline");

  model.clear();
  check(model.selection === null && model.caret.row === 3, "clearing leaves the caret where it was");
  check(model.text(ctx.buffer) === "", "and reports no text");
});

Deno.test("selection: extending seeds the anchor from where the caret stood", () => {
  const ctx = makeContext();
  const model = new SelectionModel();
  model.moveTo({ row: 0, col: 0 });
  model.move(ctx, "word-forward", true);
  check(ends(held(model)) === "0:0->0:6", "the first shift-move selects exactly its span");
  check(model.caret.col === 6, "and leaves the caret at the motion's end");

  model.move(ctx, "char-forward", true);
  check(ends(held(model)) === "0:0->0:7", "a second extends the same selection");

  model.move(ctx, "char-forward", false);
  check(model.selection === null, "a plain move collapses it");
  check(model.caret.col === 8, "and still moves the caret");

  const other = new SelectionModel();
  other.moveTo({ row: 0, col: 4 });
  other.move(ctx, "line-down", false);
  check(other.goal === 4, "a vertical move adopts the caret's display column");
  other.move(ctx, "line-down", true);
  check(other.selection !== null, "and can start a selection from there");
  check(other.caret.row === 2, "having moved two display rows");
});
