//! Tests: the editor-centric core — tabs, gutter, soft wrap and the find/replace
//! flow — driven through the REAL dispatch route (keys, pointer events), never by
//! calling buildPlan directly.
//
// WHY THE ROUTE MATTERS. A previous subtask's bug hid because its fixture bypassed
// the real path; every case below presses the key or hands over the cell a layer
// would, and reads the plan the app then produces.

import type { KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import type { EditorRegion } from "./plan.ts";
import { editorOf } from "./pointer.ts";
import { HeadlessApp } from "./state.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A key event with every flag spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** Type `text` one character at a time through the real key route. */
function type(app: HeadlessApp, text: string): void {
  for (const char of text) check(app.dispatch(key("char", { char })), `the app types ${JSON.stringify(char)}`);
}

const SIZE = { rows: 6, cols: 40 };

/** The editor region of the app's current plan, or a failure. */
function editor(app: HeadlessApp): EditorRegion {
  const region = editorOf(app.plan());
  if (region === null) throw new Error("the plan carries no editor region");
  return region;
}

Deno.test("buffers: ctrl+alt+n opens a tab, the strip is the plan's, and switching restores the slot", () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("alpha"), path: "a.txt", size: SIZE });
  check(editor(app).headerRows === undefined, "one buffer paints no tab strip");

  check(app.dispatch(key("n", { ctrl: true, alt: true })), "ctrl+alt+n is the buffer-new shortcut");
  check(app.bufferCount === 2 && app.activeBuffer === 1, "a second buffer is active");
  check(app.buffer.text() === "" && app.path === null, "and it is a fresh, unnamed document");

  type(app, "beta");
  check(app.buffer.dirty, "typing marks the NEW buffer dirty");

  const tabs = editor(app);
  check(tabs.headerRows === 1, "two buffers paint a one-row tab strip");
  const strip = tabs.rows[0]!.spans.map((span) => span.text).join("");
  check(strip.includes("a.txt") && strip.includes("[No Name]"), `the strip names both buffers (${JSON.stringify(strip)})`);
  check(tabs.rows[0]!.spans.some((span) => span.hint === "sidebar-active" && span.text.includes("[No Name]")),
    "and the active tab is the marked one");

  // Per-buffer caret: move buffer 0's caret, leave, come back, and find it kept.
  check(app.dispatch(key("left", { ctrl: true, alt: true })), "ctrl+alt+left is the previous-buffer shortcut");
  check(app.path === "a.txt" && app.buffer.text() === "alpha", "the first buffer is active again");
  check(!app.buffer.dirty, "and it is still clean — dirty is PER BUFFER");
  app.dispatch(key("end"));
  check(app.caret.col === 5, `the caret moved in buffer 0 (${app.caret.col})`);
  app.dispatch(key("right", { ctrl: true, alt: true }));
  check(app.caret.col === 4, "the second buffer's caret is its own");
  app.dispatch(key("left", { ctrl: true, alt: true }));
  check(app.caret.col === 5, "and buffer 0's caret was remembered");

  app.dispatch(key("w", { ctrl: true, alt: true }));
  check(app.bufferCount === 1, "ctrl+alt+w closes the active buffer");
});

Deno.test("gutter: alt+l toggles a plan-owned line-number gutter", () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("one\ntwo\nthree"), size: SIZE });
  check(editor(app).gutterWidth === undefined, "the gutter starts off");

  check(app.dispatch(key("l", { alt: true })), "alt+l is the gutter shortcut");
  check(app.gutter, "the app's flag is on");
  const region = editor(app);
  check(region.gutterWidth === 3, `3 lines need 1 digit + 2 spaces (${region.gutterWidth})`);
  const first = region.rows.find((row) => row.line === 0)!;
  check(first.spans[0]!.text === "1  ", `the first row numbers itself (${JSON.stringify(first.spans[0]!.text)})`);
  check(first.spans[1]!.x === 3 && first.spans[1]!.text === "one", "and the text is shifted past the gutter");

  app.dispatch(key("l", { alt: true }));
  check(editor(app).gutterWidth === undefined, "toggling back removes it");
});

Deno.test("wrap: alt+z switches between the region width and no wrap", () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("x".repeat(35)), size: { rows: 5, cols: 12 } });
  check(app.wrap, "wrap is on by default");
  const displayRows = (region: EditorRegion): number => region.rows.filter((row) => row.line === 0).length;
  check(displayRows(editor(app)) > 1, "a 35-cell line wraps at 12 columns");

  check(app.dispatch(key("z", { alt: true })), "alt+z is the soft-wrap shortcut");
  check(!app.wrap, "the flag flipped");
  check(displayRows(editor(app)) === 1, "and the same line is one display row with no wrap");
  check(app.dispatch(key("z", { alt: true })) && displayRows(editor(app)) > 1, "toggling back rewraps it");
});

Deno.test("find/replace: the whole flow runs through real keys, including replace-current", () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("one two one"), size: SIZE });
  app.dispatch(key("f", { ctrl: true }));
  check(app.modal === "find", "ctrl+f opens find");
  type(app, "one");
  check(app.search.query === "one", "the query is the typed text");

  app.dispatch(key("f3"));
  check(app.selection !== null && app.selection.caret.col === 3, "find-next selects the first match");
  app.dispatch(key("f3", { shift: true }));
  check(app.selection !== null && app.selection.anchor.col === 8 && app.selection.caret.col === 11,
    "find-previous wraps to the last match");

  app.dispatch(key("h", { ctrl: true }));
  check(app.modal === "replace", "ctrl+h raises the replace overlay on top");
  type(app, "1");
  check(app.replacement === "1", "the replacement field is its own");

  // The caret stands on the last match (0:11), so the single-match replace writes
  // THAT one; replace-all then writes what is left.
  app.dispatch(key("enter", { alt: true }));
  check(app.buffer.text() === "one two 1", `replace-current writes the caret's match (${JSON.stringify(app.buffer.text())})`);
  app.dispatch(key("enter", { ctrl: true }));
  check(app.buffer.text() === "1 two 1", "replace-all writes the rest");
  app.dispatch(key("escape"));
  check(app.modal === null, "escape closes the overlay stack");
});

Deno.test("pointer: the gutter and tab strip are taken out of the cell before the caret lands", () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("abc\ndef"), size: SIZE });
  app.dispatch(key("l", { alt: true }));
  app.dispatch({ kind: "press", cell: { row: 0, col: 4 } });
  check(app.caret.row === 0 && app.caret.col === 1,
    `a click in the text column maps through the gutter (${app.caret.row}:${app.caret.col})`);

  app.dispatch(key("n", { ctrl: true, alt: true }));
  type(app, "zz");
  app.dispatch(key("left", { ctrl: true, alt: true }));
  check(editor(app).headerRows === 1, "the strip is back");
  app.dispatch({ kind: "press", cell: { row: 1, col: 4 } });
  check(app.caret.row === 0 && app.caret.col === 1,
    `a click below the strip maps to document row 0 (${app.caret.row}:${app.caret.col})`);
});
