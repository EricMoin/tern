//! Tests: the command table — one decision point for what a key means.

import type { KeyCombo, KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import {
  applyCommand,
  COMMANDS,
  type CommandContext,
  type Intent,
  typedCharacter,
} from "./commands.ts";
import { LineIndex } from "./lineindex.ts";
import { WrapCache } from "./wrapcache.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const LINES = ["alpha beta", "", "gamma delta"];

/** The intent vocabulary the reducer is expected to handle — the contract this
 * module must not step outside. */
const KINDS = new Set([
  "insert", "delete", "replace-all",
  "move", "cursor", "select", "select-all", "clear-selection", "history",
  "search", "modal", "focus", "sidebar", "file", "quit",
  "buffer", "wrap", "gutter", "pane",
  "pointer", "scroll",
]);

function context(lines: string[], extra: Partial<CommandContext> = {}): CommandContext {
  const buffer = Buffer.fromString(lines.join("\n"));
  const index = new LineIndex(new Array<number>(lines.length).fill(1));
  return {
    buffer,
    index,
    cache: new WrapCache(index, 40),
    caret: { row: 0, col: 0 },
    selection: null,
    focus: "editor",
    modal: null,
    sidebarVisible: true,
    wrap: true,
    gutter: false,
    search: { query: "", replacement: "", caseSensitive: false },
    key: { name: "", ctrl: false, alt: false, shift: false },
    pointer: null,
    paste: null,
    ...extra,
  };
}

/** A key event with every flag spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** A combo's identity, so two commands cannot claim the same key. */
function combo(combo: KeyCombo): string {
  return [combo.name, combo.ctrl, combo.alt, combo.shift, combo.meta, combo.super].join("|");
}

/** Where a delete intent removes from and to. */
function span(intent: Intent): string {
  if (intent.kind !== "delete") throw new Error(`expected a delete, got ${intent.kind}`);
  return `${intent.start.row}:${intent.start.col}->${intent.end.row}:${intent.end.col}`;
}

Deno.test("commands: the table is one id per command, one key per id", () => {
  const ids = COMMANDS.map((command) => command.id);
  check(new Set(ids).size === ids.length, "no duplicate command ids");
  check(ids.length >= 40, `the table covers the whole vocabulary (${ids.length} commands)`);

  const combos = new Map<string, string>();
  for (const command of COMMANDS) {
    check(command.title !== "", `${command.id} has a title for the help overlay`);
    check(typeof command.apply === "function", `${command.id} has a pure handler`);
    for (const bound of [command.key, command.shiftKey]) {
      if (bound === undefined) continue;
      const signature = combo(bound);
      const owner = combos.get(signature);
      check(owner === undefined, `"${signature}" is bound twice: ${owner} and ${command.id}`);
      combos.set(signature, command.id);
    }
  }

  // Every motion is reachable both ways: the plain key and the extending twin.
  for (const id of ids.filter((value) => value.startsWith("move-"))) {
    const command = COMMANDS.find((entry) => entry.id === id)!;
    check(command.key !== undefined, `${id} has a key`);
    check(command.shiftKey !== undefined && command.shiftKey.shift === true,
      `${id} has a shifted twin that extends`);
  }
});

Deno.test("commands: a typed character is a character, not a shortcut", () => {
  check(typedCharacter(key("char", { char: "a" })) === "a", "a plain character types");
  check(typedCharacter(key("char", { char: "K", shift: true })) === "K",
    "shift is what MAKES the character, so it does not disqualify it");
  check(typedCharacter(key("char", { char: "a", ctrl: true })) === null, "ctrl+a is not the character a");
  check(typedCharacter(key("char", { char: "a", alt: true })) === null, "nor is alt+a");
  check(typedCharacter(key("char", { char: "a", super: true })) === null, "nor super+a");
  check(typedCharacter(key("char")) === null, "a char event with no character types nothing");
  check(typedCharacter(key("enter")) === null, "a named key is not a character");
});

Deno.test("commands: every command answers with an intent, or with nothing", () => {
  const ctx = context(LINES, { caret: { row: 0, col: 3 }, selection: null });
  for (const command of COMMANDS) {
    const intent = applyCommand(command.id, ctx);
    if (intent === null) continue;
    check(KINDS.has(intent.kind), `${command.id} answers with a known intent (${intent.kind})`);
    const shape = JSON.stringify(intent);
    for (const forbidden of ["\"node\"", "\"scene\"", "\"children\"", "\"props\""]) {
      check(!shape.includes(forbidden), `${command.id} builds no scene (${forbidden})`);
    }
  }
  check(applyCommand("insert-char", ctx) === null, "insert-char without a character does nothing");
  check(applyCommand("cancel", ctx) === null, "escape in a bare editor with no selection does nothing");
  check(applyCommand("insert-char", context(LINES, { key: key("char", { char: "z" }) }))
    ?.kind === "insert", "a character in the editor inserts");
  check(JSON.stringify(applyCommand("insert-char", context(LINES, {
    modal: "find", key: key("char", { char: "z" }),
  }))) === JSON.stringify({ kind: "search", action: "append", text: "z" }),
  "and the same character goes to the find overlay when it is open");
});

Deno.test("commands: cancel and enter mean what the modal stack says they mean", () => {
  const ctx = context(LINES, { selection: { anchor: { row: 0, col: 0 }, caret: { row: 0, col: 3 } } });
  check(applyCommand("cancel", ctx)?.kind === "clear-selection", "escape clears a selection first");
  check(applyCommand("cancel", context(LINES, { modal: "find" }))?.kind === "search",
    "in the find overlay it closes the search");
  const help = applyCommand("cancel", context(LINES, { modal: "help" })) as Intent;
  check(help.kind === "modal" && help.action === "pop", "in the help overlay it pops the overlay");

  check(applyCommand("insert-newline", context(LINES))?.kind === "insert", "enter inserts a line");
  check(JSON.stringify(applyCommand("insert-newline", context(LINES, { modal: "find" })))
    === JSON.stringify({ kind: "search", action: "next" }), "in the find overlay it steps");
  const replacing = context(LINES, {
    modal: "replace",
    search: { query: "alpha", replacement: "A", caseSensitive: true },
  });
  check(applyCommand("insert-newline", replacing)?.kind === "replace-all",
    "in the replace overlay it replaces every match");
  check(applyCommand("insert-newline", context(LINES, { modal: "replace" })) === null,
    "and with no query there is nothing to replace");
  check(applyCommand("insert-tab", context(LINES, { modal: "find" })) === null,
    "and tab does nothing while the find overlay owns the keyboard");
});

Deno.test("commands: a delete is the span the SAME motion would move over", () => {
  const ctx = context(LINES, { caret: { row: 0, col: 6 } });
  check(span(applyCommand("delete-word-backward", ctx)!) === "0:0->0:6",
    "delete-word-backward takes the word the motion would reach");
  check(span(applyCommand("delete-forward", ctx)!) === "0:6->0:7", "delete-forward takes one cluster");
  check(span(applyCommand("backspace", ctx)!) === "0:5->0:6", "backspace takes the cluster before");

  const selected = context(LINES, {
    selection: { anchor: { row: 0, col: 8 }, caret: { row: 2, col: 2 } },
  });
  check(span(applyCommand("backspace", selected)!) === "0:8->2:2",
    "a selection wins over the motion, in document order");
  check(span(applyCommand("delete-line", { ...ctx, caret: { row: 1, col: 0 } })!) === "1:0->2:0",
    "delete-line takes the line and its newline");

  const empty = context(["a"], { caret: { row: 0, col: 0 } });
  check(applyCommand("backspace", empty) === null, "at the document's start there is nothing to delete");
  check(applyCommand("delete-forward", context(["a"], { caret: { row: 0, col: 1 } })) === null,
    "and at its end either");
});

Deno.test("commands: replace-all computes its edits against the live buffer", () => {
  const ctx = context(["one two one"], {
    search: { query: "one", replacement: "1", caseSensitive: true },
  });
  const intent = applyCommand("replace-all", ctx) as Intent;
  check(intent.kind === "replace-all", "it is the document intent");
  if (intent.kind !== "replace-all") return;
  check(intent.edits.length === 2, "one edit per match");
  check(intent.edits[0]!.start.col === 8, "in reverse document order");
  check(intent.edits[0]!.text === "1" && intent.edits[0]!.end.col === 11, "each replacing its range");

  check(applyCommand("replace-all", context(["one"], {
    search: { query: "", replacement: "1", caseSensitive: true },
  })) === null, "an empty query has nothing to replace");
});

Deno.test("commands: the editor-centric toggles and buffer verbs are pure intents", () => {
  check(JSON.stringify(applyCommand("wrap-toggle", context(LINES, { wrap: true })))
    === JSON.stringify({ kind: "wrap", on: false }), "wrap-toggle flips the live flag off");
  check(JSON.stringify(applyCommand("wrap-toggle", context(LINES, { wrap: false })))
    === JSON.stringify({ kind: "wrap", on: true }), "and back on");
  check(JSON.stringify(applyCommand("gutter-toggle", context(LINES, { gutter: false })))
    === JSON.stringify({ kind: "gutter", on: true }), "gutter-toggle flips the gutter on");
  for (const action of ["new", "close", "next", "previous"] as const) {
    const id = ("buffer-" + action) as Parameters<typeof applyCommand>[0];
    check(JSON.stringify(applyCommand(id, context(LINES))) === JSON.stringify({ kind: "buffer", action }),
      `buffer-${action} is the pure buffer intent`);
  }
});

Deno.test("commands: replace-current edits the match under the caret only", () => {
  const ctx = context(["one two one"], {
    caret: { row: 0, col: 0 },
    search: { query: "one", replacement: "1", caseSensitive: true },
  });
  const intent = applyCommand("search-replace-current", { ...ctx, modal: "replace" }) as Intent;
  check(intent.kind === "replace-all", "the single-match edit rides the edit-list intent");
  if (intent.kind !== "replace-all") return;
  check(intent.edits.length === 1, "exactly one edit");
  check(intent.edits[0]!.start.col === 0 && intent.edits[0]!.end.col === 3, "covering the caret's match");
  check(applyCommand("search-replace-current", context(["one"])) === null,
    "and in the editor it is not a search command at all");
});
