//! Tests: the headless app — the GOLDEN plan, and the state machine around it.
//
// No napi addon and no PTY: the app is built, driven by intents and keys, and
// asked for a ScreenPlan, all in memory. The golden digest below is the L1
// seed — the same intent sequence must always yield the same ScreenPlan, so a
// renderer can be checked against a screen nobody had to draw.

import type { KeyEvent } from "@tern-tui/core";
import type { Intent } from "./commands.ts";
import type { ScreenPlan, SidebarRegion } from "./plan.ts";
import { HeadlessApp } from "./state.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A key event with every flag spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** A plan reduced to what a renderer paints: geometry, rows, cursor and the mode
 * line's segments. Deliberately excludes the cost stats, which are evidence
 * about the frame rather than about the screen. */
function digest(plan: ScreenPlan): string {
  const lines: string[] = [];
  lines.push(`size ${plan.size.rows}x${plan.size.cols} focus ${plan.focus} dirty ${plan.dirty}`);
  const cursor = plan.cursor;
  lines.push(cursor === null
    ? "cursor none"
    : `cursor ${cursor.row},${cursor.col} ${cursor.visible ? "visible" : "hidden"} ` +
      `pos ${cursor.position.row}:${cursor.position.col}`);
  for (const region of plan.regions) {
    if (region.kind === "editor") {
      lines.push(
        `editor ${region.x},${region.y} ${region.width}x${region.height} ` +
          `first ${region.firstRow} total ${region.totalRows}`,
      );
      for (const row of region.rows) {
        const text = row.spans.map((span) => span.text).join("");
        lines.push(`row ${row.row} line ${row.line} off ${row.offset} cur ${row.cursor ? 1 : 0} "${text}"`);
      }
    } else if (region.kind === "sidebar") {
      lines.push(
        `sidebar ${region.x},${region.y} ${region.width}x${region.height} ` +
          `scroll ${region.scroll} count ${region.count}`,
      );
      for (const item of region.items) {
        const text = item.spans.map((span) => span.text).join("");
        lines.push(`item ${item.index} active ${item.active ? 1 : 0} "${text}"`);
      }
    } else if (region.kind === "modal") {
      lines.push(
        `modal ${region.id} "${region.title}" ${region.x},${region.y} ${region.width}x${region.height} ` +
          `scroll ${region.scroll} count ${region.count}`,
      );
      for (const row of region.rows) {
        const text = row.spans.map((span) => span.text).join("");
        lines.push(`mrow ${row.row} "${text}"`);
      }
      lines.push(region.caret === null ? "mcaret none" : `mcaret ${region.caret.row},${region.caret.col}`);
    } else {
      lines.push(`mode ${region.x},${region.y} ${region.width}x${region.height}`);
      for (const segment of region.segments) {
        lines.push(`seg ${segment.hint} "${segment.text}"`);
      }
    }
  }
  return lines.join("\n");
}

const SIZE = { rows: 4, cols: 40 };

/**
 * The fixed intent sequence the golden is built from: step down a line, type,
 * jump to the document's end, select a word, delete it, and open find.
 */
const SEQUENCE: readonly Intent[] = [
  { kind: "move", motion: "line-down", extend: false },
  { kind: "insert", text: "X" },
  { kind: "move", motion: "doc-end", extend: false },
  { kind: "select", unit: "word", position: { row: 0, col: 1 } },
  { kind: "delete", start: { row: 0, col: 0 }, end: { row: 0, col: 3 } },
  { kind: "search", action: "open" },
];

/** A fresh app over the two-line document the sequence starts from. */
function app(): HeadlessApp {
  const instance = new HeadlessApp({ items: [], size: SIZE });
  instance.load("one\ntwo", null);
  return instance;
}

/** The app with the whole fixed sequence applied. */
function driven(): HeadlessApp {
  const instance = app();
  for (const intent of SEQUENCE) instance.reduce(intent);
  return instance;
}

Deno.test("state: the golden ScreenPlan for a fixed intent sequence", () => {
  const instance = driven();
  check(instance.buffer.text() === "\nXtwo", `the sequence edited the document (${JSON.stringify(instance.buffer.text())})`);
  check(instance.buffer.dirty, "and left it unsaved");
  check(instance.modal === "find", "with the find overlay open");

  const golden = [
    "size 4x40 focus editor dirty true",
    "cursor 0,0 visible pos 0:0",
    "editor 0,0 40x3 first 0 total 2",
    'row 0 line 0 off 0 cur 1 ""',
    'row 1 line 1 off 0 cur 0 "Xtwo"',
    'row 2 line -1 off 0 cur 0 ""',
    'modal find "Find" 12,0 15x3 scroll 0 count 0',
    'mrow 0 "┌─ Find ──────┐"',
    'mrow 1 "│find:        │"',
    'mrow 2 "└─────────────┘"',
    'mcaret 1,19',
    "mode 0,3 40x1",
    'seg mode " FIND "',
    'seg path " [No Name] "',
    'seg dirty " ● "',
    'seg count " 2L "',
    'seg position " 1:1"',
  ].join("\n");

  const actual = digest(instance.plan());
  check(actual === golden, `the golden plan\n--- expected ---\n${golden}\n--- actual ---\n${actual}`);
});

Deno.test("state: the same intents always yield the same ScreenPlan", () => {
  const first = digest(driven().plan());
  const second = digest(driven().plan());
  check(first === second, "two independent runs agree");

  // Replaying the sequence on ONE app must not accumulate: the state is a
  // function of the intents, not of how many times they were applied.
  const replayed = app();
  for (const intent of SEQUENCE) replayed.reduce(intent);
  check(digest(replayed.plan()) === first, "a fresh app agrees with the other fresh app");

  // Asking for a plan after EVERY intent warms the wrap cache differently. The
  // screen must not depend on when it was asked for.
  const warm = app();
  for (const intent of SEQUENCE) {
    warm.reduce(intent);
    warm.plan();
  }
  check(digest(warm.plan()) === first, "and a warmed cache changes nothing on screen");
  // The frame's PRICE is allowed to differ — that is the overscan band's whole
  // job — so the screen is what must be identical, never the cost. See report.
  const warmed = warm.plan();
  const cold = driven().plan();
  check(digest(warmed) === digest(cold), "the warmed screen is the same screen");
  check(cold.stats.editor.cacheWraps > warmed.stats.editor.cacheWraps,
    `and the band made the warmed frame cheaper (${warmed.stats.editor.cacheWraps} vs ${cold.stats.editor.cacheWraps} wraps)`);
});

Deno.test("state: keys reach the commands through the framework's keymap", () => {
  const instance = new HeadlessApp({ items: [], size: SIZE });
  instance.load("one\ntwo", null);

  check(instance.dispatch(key("char", { char: "z" })), "a printable character is claimed");
  check(instance.buffer.text() === "zone\ntwo", `and types (${JSON.stringify(instance.buffer.text())})`);
  check(instance.buffer.dirty, "marking the document unsaved");

  check(instance.dispatch(key("z", { ctrl: true })), "ctrl+z is the undo shortcut");
  check(instance.buffer.text() === "one\ntwo", "and it undoes");
  // Undo restores the TEXT, not the saved/unsaved bit: `Buffer` clears `dirty`
  // only in `markSaved()` (`buffer.ts`). Asserted so the behavior is on record.
  check(instance.buffer.dirty, "the document is still marked unsaved after an undo");

  check(instance.dispatch(key("down")), "the down arrow is bound to a motion");
  check(instance.caret.row === 1, `and moved the caret (${JSON.stringify(instance.caret)})`);

  check(instance.dispatch(key("f", { ctrl: true })), "ctrl+f opens find");
  check(instance.modal === "find", "pushing the overlay");

  check(instance.dispatch(key("escape")), "escape is claimed while it is open");
  check(instance.modal === null, "and closes it");
  check(!instance.dispatch(key("f13")), "a key nothing claims falls through");
});

Deno.test("state: a run of typing is one undo step, and a move ends the run", () => {
  const instance = new HeadlessApp({ items: [], size: SIZE });
  instance.load("one", null);
  for (const letter of ["a", "b", "c"]) {
    instance.run("insert-char", key("char", { char: letter }));
  }
  check(instance.buffer.text() === "abcone", "three characters typed at the start");

  instance.run("undo");
  check(instance.buffer.text() === "one", "one undo removes the whole run");
  instance.run("redo");
  check(instance.buffer.text() === "abcone", "and one redo puts it back");

  instance.run("move-char-backward");
  instance.run("insert-char", key("char", { char: "d" }));
  instance.run("undo");
  check(instance.buffer.text() === "abcone", "typing after a cursor move starts a NEW step");
  instance.run("undo");
  check(instance.buffer.text() === "one", "so the run before it is still one step");
});

Deno.test("state: the file list is the app's, the columns are the plan's", () => {
  const instance = new HeadlessApp({
    items: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    sidebarWidth: 12,
    size: SIZE,
  });
  instance.load("one\ntwo", null);
  const plan = instance.plan();
  const sidebar = plan.regions.find((region) => region.kind === "sidebar");
  check(sidebar !== undefined && sidebar.kind === "sidebar", "the pane is on the plan");
  if (sidebar === undefined || sidebar.kind !== "sidebar") return;
  check(sidebar.x === 0 && sidebar.width === 12, "on the left, at the width it asked for");
  check(sidebar.items[0]!.active && sidebar.items[0]!.spans[0]!.text === "> ",
    "with the first item marked active");

  instance.run("sidebar-down");
  instance.run("sidebar-activate");
  check(instance.sidebar.active === 1, "moving the highlight");
  const effects = instance.takeEffects();
  check(effects.length === 1 && effects[0]!.kind === "open", "activating queues an open");
  check(instance.takeEffects().length === 0, "and draining is draining");

  instance.run("focus-toggle");
  check(instance.focus === "sidebar", "the keyboard can move to the pane");
  check(instance.plan().cursor === null, "and the cursor cell goes with it");
  instance.run("sidebar-toggle");
  check(instance.plan().regions.every((region) => region.kind !== "sidebar"), "hiding the pane");
});

Deno.test("state: a save is a request, and the host marks it done", () => {
  const instance = new HeadlessApp({ path: "notes.txt", items: [], size: SIZE });
  instance.load("one", "notes.txt");
  instance.run("insert-char", key("char", { char: "z" }));
  check(instance.buffer.dirty, "an edit is unsaved");

  instance.run("file-save");
  check(JSON.stringify(instance.takeEffects()) === JSON.stringify([{ kind: "save", path: "notes.txt" }]),
    "the save is an effect the host performs");
  check(instance.buffer.dirty, "and the app is still dirty until the host says otherwise");
  instance.buffer.markSaved();
  check(!instance.buffer.dirty, "which it does by calling back");

  instance.run("file-new");
  check(instance.buffer.text() === "" && instance.path === null, "a new file is empty and unnamed");

  instance.run("quit");
  check(instance.takeEffects()[0]?.kind === "quit", "quit is an effect too");
});

// --- the file list's window, driven through the REAL key route ----------------
//
// The two cases below exist because the list's window used to be computed by the
// sidebar REDUCER from the active index alone (`Math.min(scroll, active)`, which is
// 0 for every list that starts at the top), so no key sequence could reach a
// scrolled window and, once `active` left the visible rows, no item carried the
// marker. Both facts are asserted here the way a user meets them: press alt+down
// and read the plan. Asserting them by calling `buildPlan` with cells would test
// the fix's mechanism instead of the defect's route.

/** A list longer than the pane: 30 items on an 8-row screen — a 7-row pane, so
 * the highlight leaves the first window after seven steps. */
const LIST = Array.from({ length: 30 }, (_, index) => "src/file-" + String(index + 1).padStart(2, "0") + ".ts");

/** A fresh app over {@link LIST}. */
function listed(): HeadlessApp {
  const instance = new HeadlessApp({ items: LIST, sidebarWidth: 20, size: { rows: 8, cols: 44 } });
  instance.load("one\ntwo", null);
  return instance;
}

/** The file-list region of `plan`, or a failure when the screen has no pane. */
function sidebarOf(plan: ScreenPlan): SidebarRegion {
  const region = plan.regions.find((entry) => entry.kind === "sidebar") as SidebarRegion | undefined;
  if (region === undefined) throw new Error("the plan carries no file list");
  return region;
}

/** Move the highlight `count` items down through the keymap. */
function stepDown(instance: HeadlessApp, count: number): void {
  for (let i = 0; i < count; i += 1) {
    check(instance.dispatch(key("down", { alt: true })), "alt+down is the file list's own motion");
  }
}

Deno.test("state: alt+down scrolls the file list once the highlight leaves the pane", () => {
  const instance = listed();
  check(sidebarOf(instance.plan()).scroll === 0, "the list starts at the top of the window");
  stepDown(instance, 10);
  check(instance.sidebar.active === 10, `the highlight moved (${instance.sidebar.active})`);
  const pane = sidebarOf(instance.plan());
  check(pane.scroll > 0, `the pane scrolled to follow it (scroll ${pane.scroll})`);
  check(pane.scroll === 10 - pane.height + 1,
    `and parked the highlight on the last row (scroll ${pane.scroll}, height ${pane.height})`);
  check(instance.sidebar.scroll === pane.scroll,
    `the app's scroll is the pane's window, not a stale ${instance.sidebar.scroll}`);
});

Deno.test("state: a scrolled file list still marks its active item", () => {
  const instance = listed();
  stepDown(instance, 10);
  const pane = sidebarOf(instance.plan());
  const marked = pane.items.filter((item) => item.active);
  check(marked.length === 1, `exactly one item is marked, got ${marked.length}`);
  check(marked[0]!.index === instance.sidebar.active, "and it is the item the highlight is on");
  check(marked[0]!.spans[0]!.text === "> ", "with the marker in its own leading column");
  check(pane.items.some((item) => item.index === 10), "and it is inside the visible window");
});
