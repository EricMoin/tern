//! Tests: the auxiliary panes, driven through the REAL dispatch route.
//
// Every case below presses a key (or hands the app a pointer cell) through
// HeadlessApp.dispatch and reads the ScreenPlan the app produces. None calls
// buildPlan directly: the panes are features of the app, and a pane a key cannot
// reach is a pane nobody can use.

import { getTheme, setTheme, TREE_EXPANDED_GLYPH, type KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import { COMMANDS } from "./commands.ts";
import type { ModalRegion, ScreenPlan, SidebarRegion } from "./plan.ts";
import { HeadlessApp, type AppOptions } from "./state.ts";

/** Throw unless condition; what names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A key event with every modifier spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** The app the pane cases share: a small tree of files and a three-line document. */
function app(options: Partial<AppOptions> = {}): HeadlessApp {
  return new HeadlessApp({
    buffer: Buffer.fromString("alpha\nbeta\ngamma\n"),
    size: { rows: 20, cols: 60 },
    items: ["demo/a.ts", "demo/b.ts", "src/c.ts"],
    path: "demo/a.ts",
    ...options,
  });
}

/** The plan's overlay, or a failure. */
function modalOf(plan: ScreenPlan): ModalRegion {
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  if (modal === undefined) throw new Error("the plan carries no modal region");
  return modal;
}

/** The plan's file-list region, or a failure. */
function sidebarOf(plan: ScreenPlan): SidebarRegion {
  const sidebar = plan.regions.find((region) => region.kind === "sidebar") as SidebarRegion | undefined;
  if (sidebar === undefined) throw new Error("the plan carries no sidebar region");
  return sidebar;
}

/** Every row of an overlay as one string. */
function modalText(modal: ModalRegion): string {
  return modal.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

/** The file-list rows as one string. */
function sidebarText(plan: ScreenPlan): string {
  return sidebarOf(plan).items.map((item) => item.spans.map((span) => span.text).join("")).join("\n");
}

Deno.test("panes: the file list is a Tree with the framework's own glyphs", () => {
  const a = app();
  const text = sidebarText(a.plan());
  check(text.includes(TREE_EXPANDED_GLYPH), "a directory row carries the expanded glyph: " + JSON.stringify(text));
  check(text.includes("a.ts") && text.includes("c.ts"), "the leaves are listed");
  check(!text.includes("demo/a.ts"), "the paths are folded into a tree, not listed flat");
});

Deno.test("panes: the file picker is a real Select over the file list", () => {
  const a = app();
  check(a.dispatch(key("p", { ctrl: true })), "ctrl+p opens the picker");
  check(a.paneId === "picker", "the picker is the pane on top");
  const modal = modalOf(a.plan());
  check(modal.id === "picker", "the overlay names the picker");
  check(modalText(modal).includes("demo/a.ts"), "the files are listed");
  a.dispatch(key("down"));
  check(a.panes.index === 1, "down moves the highlight");
  for (const char of "src") {
    a.dispatch({ name: "char", char, ctrl: false, alt: false, shift: false });
  }
  const filtered = modalText(modalOf(a.plan()));
  check(filtered.includes("src/c.ts") && !filtered.includes("demo/a.ts"), "typing filters the list");
  check(a.dispatch(key("enter")), "enter activates the highlighted file");
  const effects = a.takeEffects();
  check(effects.length === 1 && effects[0]!.kind === "open" && effects[0]!.path === "src/c.ts",
    "the app asks the host to open the selected path");
  check(a.paneId === null, "and the picker closes");
});

Deno.test("panes: escape closes a pane and no key reaches the document behind it", () => {
  const a = app();
  const before = a.buffer.text();
  a.dispatch(key("p", { alt: true }));
  check(a.paneId === "preferences", "preferences is open");
  a.dispatch({ name: "char", char: "x", ctrl: false, alt: false, shift: false });
  check(a.buffer.text() === before, "a typed character does not reach the document");
  check(a.dispatch(key("escape")), "escape is handled");
  check(a.paneId === null, "and closes the pane");
  a.dispatch({ name: "char", char: "x", ctrl: false, alt: false, shift: false });
  check(a.buffer.text() !== before, "the editor types again once the pane is gone");
});

Deno.test("panes: the command palette lists the real table and runs a selection", () => {
  const a = app();
  check(a.dispatch(key("p", { ctrl: true, shift: true })), "ctrl+shift+p opens the palette");
  check(a.paneId === "palette", "the palette is the pane on top");
  const text = modalText(modalOf(a.plan()));
  check(text.includes(COMMANDS[0]!.title), "the real command table's first title is listed");
  for (const char of "Keyboard") {
    a.dispatch({ name: "char", char, ctrl: false, alt: false, shift: false });
  }
  check(modalText(modalOf(a.plan())).includes("Keyboard shortcuts"), "the filter narrows to the help command");
  a.dispatch(key("enter"));
  check(a.paneId === null, "the palette closes");
  check(a.modal === "help", "activating the help command opened the help overlay");
});

Deno.test("panes: preferences toggle wrap, tab width and open the theme pane", () => {
  const a = app();
  check(a.dispatch(key("p", { alt: true })), "alt+p opens preferences");
  check(a.wrap === true, "soft wrap starts on");
  a.dispatch(key("enter"));
  check(a.wrap === false && a.panes.prefs.wrap === false, "enter on the wrap row flips soft wrap");
  a.dispatch(key("down"));
  a.dispatch(key("enter"));
  check(a.panes.prefs.tabWidth === 8, "tab width cycles 4 -> 8");
  a.dispatch(key("down"));
  a.dispatch(key("enter"));
  check(a.paneId === "theme", "the theme row opens the theme pane");
});

Deno.test("panes: theme switching goes through setTheme and the audit reports", () => {
  setTheme({});
  const a = app();
  check(getTheme().palette.primary.fg === "#61afef", "the default theme is active first");
  check(a.dispatch(key("t", { alt: true })), "alt+t opens the theme pane");
  check(modalText(modalOf(a.plan())).includes("one-dark"), "the choices are listed");
  a.dispatch(key("down"));
  a.dispatch(key("enter"));
  check(a.panes.prefs.theme === "solarized", "the selection is recorded");
  check(getTheme().palette.primary.fg === "#268bd2", "setTheme applied the framework theme");
  check(modalText(modalOf(a.plan())).includes("solarized"), "and the pane names it");
});

Deno.test("panes: the render profile charts measurements the app really took", () => {
  const a = app();
  check(a.dispatch(key("r", { alt: true })), "alt+r opens the profile pane");
  a.plan();
  const modal = modalOf(a.plan());
  check(a.panes.samples.length >= 1, "a frame sample was recorded");
  const text = modalText(modal);
  check(text.includes("plan cost sparkline"), "the chart section is painted");
  check(/[▁▂▃▄▅▆▇█]/.test(text), "a real chart glyph is painted: " + JSON.stringify(text.slice(0, 120)));
});

Deno.test("panes: the diff pane is an explicit command over the host's external text", () => {
  const a = app({ external: "alpha\ndelta\n" });
  check(a.paneId === null, "no pane is open until the command is given");
  check(a.dispatch(key("d", { alt: true })), "alt+d opens the diff pane");
  check(a.paneId === "diff", "the diff pane is on top");
  const text = modalText(modalOf(a.plan()));
  check(text.includes("beta") && text.includes("delta"), "the diff shows both sides: " + JSON.stringify(text));
  a.dispatch(key("enter"));
  check(a.buffer.text().includes("delta"), "enter reloads the buffer from the external text");
  check(a.paneId === null, "and closes the pane");
});

Deno.test("panes: the a11y stream is opt-in and emits the framework's JSONL", () => {
  const a = app();
  check(a.panes.prefs.a11y === false, "the stream is off by default");
  check(a.dispatch(key("a", { alt: true })), "alt+a opts in");
  check(a.panes.prefs.a11y === true, "the preference flipped on");
  check(a.panes.a11yLines[0] === JSON.stringify({ v: 1 }), "the framework header is the first line");
  a.plan();
  check(a.panes.a11yLines.length >= 2, "a plan emission appends the semantics line");
  check(a.panes.a11yLines[1]!.includes("tern showcase"), "the dump names the screen root");
  check(a.dispatch(key("a", { alt: true })), "alt+a opts out");
  check(a.panes.prefs.a11y === false && a.panes.a11yLines.length === 0, "toggling off clears the buffer");
});

Deno.test("panes: the split drag resolves through the pointer intents and clamps", () => {
  const a = app();
  check(sidebarOf(a.plan()).width === 20, "the default split is 20 columns");
  a.dispatch({ kind: "press", cell: { row: 1, col: 20 } });
  check(sidebarOf(a.plan()).width === 20, "a press on the split starts the drag");
  a.dispatch({ kind: "drag", cell: { row: 1, col: 30 } });
  check(sidebarOf(a.plan()).width === 30, "the drag follows the pointer");
  a.dispatch({ kind: "drag", cell: { row: 1, col: 59 } });
  check(sidebarOf(a.plan()).width === 52, "and clamps so the editor keeps MIN_EDITOR_COLS");
  a.dispatch({ kind: "double-click", cell: { row: 1, col: 52 } });
  check(sidebarOf(a.plan()).width === 20, "a double-click restores the default width");
});
