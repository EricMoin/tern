//! Tests: pointer and paste events through the app's ONE input route.
//!
//! WHAT THIS FILE PINS. A mouse event carries a SCREEN CELL and nothing else: which
//! pane that cell is in, which document slot it names and where the caret goes is the
//! app-core's decision, made against the plan (state.ts). Every case below dispatches
//! a `PointerEvent` / `PasteEvent` at `HeadlessApp.dispatch` — the same route a
//! layer's event source calls — and reads the state the app then reports.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/core/

import type { KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import { selectionText } from "./selection.ts";
import { HeadlessApp } from "./state.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A key event with every flag spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** A document taller than the window, so the wheel has somewhere to go. */
const LONG = Array.from({ length: 60 }, (_, index) => "line " + index).join("\n");

/** An app over `text` at 24x80 with no file list unless one is offered. */
function app(text = "alpha\nbeta\ngamma\n", items: readonly string[] = []): HeadlessApp {
  return new HeadlessApp({ buffer: Buffer.fromString(text), items, size: { rows: 24, cols: 80 } });
}

Deno.test("pointer: a press resolves to the pane and the document slot through dispatch", () => {
  const instance = app();
  check(instance.dispatch({ kind: "press", cell: { row: 1, col: 2 } }), "the app claims the press");
  check(instance.focus === "editor", "the press lands in the editor");
  check(instance.caret.row === 1 && instance.caret.col === 2,
    "and places the caret where the cell is (" + JSON.stringify(instance.caret) + ")");
  check(instance.selection === null, "a bare press selects nothing");

  // The drag holds the anchor the press set: the same mouse path the overlay's own
  // find-next drives (state.ts).
  check(instance.dispatch({ kind: "drag", cell: { row: 2, col: 1 } }), "a drag is claimed");
  const selection = instance.selection;
  check(selection !== null, "the drag opened a selection");
  check(selectionText(instance.buffer, selection!) === "ta\ng", "and it spans press to drag");
  console.log("pointer press+drag: " + JSON.stringify(instance.caret) + " " +
    JSON.stringify(selectionText(instance.buffer, selection!)));

  // A double-click takes the word under the pointer.
  check(instance.dispatch({ kind: "double-click", cell: { row: 0, col: 1 } }), "a double-click is claimed");
  const word = instance.selection;
  check(word !== null && selectionText(instance.buffer, word!) === "alpha", "the word under the pointer");
  console.log("pointer double-click: " + JSON.stringify(selectionText(instance.buffer, word!)));
});

Deno.test("pointer: a press on the file list focuses the pane and moves the highlight", () => {
  const instance = app(LONG, ["a.ts", "b.ts", "c.ts"]);
  const plan = instance.plan();
  const sidebar = plan.regions.find((region) => region.kind === "sidebar");
  check(sidebar !== undefined, "the fixture lays a file list out");
  check(instance.focus === "editor", "the editor starts focused");

  check(instance.dispatch({ kind: "press", cell: { row: 2, col: 4 } }), "the press is claimed");
  check(instance.focus === "sidebar", "clicking the list focuses it");
  check(instance.sidebar.active === 2, "and moves the highlight to the clicked row (" + instance.sidebar.active + ")");
  check(instance.plan().cursor === null, "a sidebar focus hides the editor's cursor cell");
  console.log("pointer sidebar: focus " + instance.focus + ", active " + instance.sidebar.active);
});

Deno.test("pointer: the wheel scrolls the window and detaches it from the caret", () => {
  const instance = app(LONG);
  check(instance.scroll === 0, "the view starts at the top");
  check(instance.dispatch({ kind: "wheel-down", cell: { row: 0, col: 0 } }), "the wheel is claimed");
  check(instance.scroll === 1, "one wheel event is one display row (" + instance.scroll + ")");
  check(instance.caret.row === 0, "and the caret stays where it was");

  // Detached: the plan must keep the window the WHEEL asked for, not re-center it on
  // a caret that is now above it.
  const plan = instance.plan();
  const editor = plan.regions.find((region) => region.kind === "editor")!;
  check(editor.firstRow === 1, "the window starts one row down (firstRow " + editor.firstRow + ")");

  // Anything else re-attaches the view: the caret moves and the window follows it.
  check(instance.dispatch(key("down")), "a key is still routed after a wheel");
  check(instance.caret.row === 1, "the caret moved with the key");
  check(instance.plan().regions.find((region) => region.kind === "editor")!.firstRow === 1,
    "and the window is the caret's again");
  console.log("pointer wheel: scroll " + instance.scroll + ", firstRow " + editor.firstRow);
});

Deno.test("pointer: the overlay owns the cells it covers", () => {
  const instance = app(LONG);
  check(instance.dispatch(key("f", { ctrl: true })), "ctrl+f opens find");
  const plan = instance.plan();
  const modal = plan.regions.find((region) => region.kind === "modal")!;
  check(instance.caret.row === 0 && instance.caret.col === 0, "the caret starts at the document's start");

  // A cell inside the box belongs to the overlay — the editor underneath must not
  // move its caret because a click landed on the modal's frame.
  check(instance.dispatch({ kind: "press", cell: { row: modal.y + 1, col: modal.x + 1 } }), "the press is claimed");
  check(instance.caret.row === 0 && instance.caret.col === 0, "and the editor's caret did not move");

  // A cell OUTSIDE the box still reaches the pane underneath.
  const below = modal.y + modal.height;
  check(instance.dispatch({ kind: "press", cell: { row: below, col: 1 } }), "a press below the box is claimed");
  check(instance.caret.row === below, "and reaches the document (row " + instance.caret.row + ")");
  console.log("pointer overlay: box " + modal.width + "x" + modal.height + " at " + modal.x + "," + modal.y);
});

Deno.test("pointer: a paste is an insert through the same route, and one undo step", () => {
  const instance = app();
  check(instance.dispatch({ kind: "paste", text: "XY" }), "a paste is claimed");
  check(instance.buffer.text() === "XYalpha\nbeta\ngamma\n", "and lands at the caret (" +
    JSON.stringify(instance.buffer.text()) + ")");
  check(!instance.dispatch({ kind: "paste", text: "" }), "an empty paste is not consumed");
  check(instance.buffer.text() === "XYalpha\nbeta\ngamma\n", "and does not touch the document");

  check(instance.dispatch(key("z", { ctrl: true })), "ctrl+z undoes it");
  check(instance.buffer.text() === "alpha\nbeta\ngamma\n", "the whole paste is one step");
  console.log("pointer paste: one insert intent, one undo step");
});
