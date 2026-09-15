//! Commands: the ONE decision point for what a key means.
//
// A key is bound to a command id in {@link COMMANDS}, and a command id becomes an
// {@link Intent} in {@link HANDLERS}. Nothing else in the app-core maps a key to an
// action — the keymap (`keymap.ts`) registers this table into the framework's own
// `Keymap` and never decides anything itself, and the state machine (`state.ts`)
// reduces intents and never looks at a key.
//
// The intent SHAPES this table answers with live in `intents.ts`, and the
// pointer/paste vocabulary in `events.ts`; both are re-exported here so this file
// stays the one import site a consumer needs.

import type { KeyCombo, KeyEvent } from "@tern-tui/core";
import { positionsEqual, type Position } from "./buffer.ts";
import {
  applyMotion,
  NO_GOAL,
  type Motion,
  type MotionContext,
} from "./motions.ts";
import type { PlanFocus } from "./plan.ts";
import {
  findMatches,
  matchContaining,
  nextMatchIndex,
  replaceAllEdits,
  replaceEdit,
  type TextEdit,
} from "./search.ts";
import { expandSelection, ordered, type Selection, type SelectionUnit } from "./selection.ts";
import type {
  CommandContext,
  Handler,
  Intent,
} from "./intents.ts";
import type { PointerIntent } from "./events.ts";

export type {
  AppIntent,
  CommandContext,
  DocumentIntent,
  Handler,
  Intent,
  ModalId,
  SearchAction,
  SearchContext,
} from "./intents.ts";
export {
  isPasteEvent,
  isPointerEvent,
  POINTER_COMMANDS,
  WHEEL_ROWS,
} from "./events.ts";
export type {
  AppEvent,
  PasteEvent,
  PointerContext,
  PointerEvent,
  PointerIntent,
  PointerKind,
  ScrollIntent,
} from "./events.ts";

/** A motion command's id: the motion's own name, prefixed. */
export type MotionCommandId = `move-${Motion}`;

/** Every command id the app knows. */
export type CommandId =
  | "insert-char" | "insert-newline" | "insert-tab"
  | "backspace" | "delete-forward" | "delete-word-backward"
  | "delete-word-forward" | "delete-line"
  | "undo" | "redo"
  | "select-word" | "select-line" | "select-paragraph" | "select-document" | "cancel"
  | "search-open" | "search-next" | "search-previous" | "search-replace" | "replace-all"
  | "search-replace-current"
  | "file-save" | "file-open" | "file-new" | "quit"
  | "buffer-new" | "buffer-close" | "buffer-next" | "buffer-previous"
  | "wrap-toggle" | "gutter-toggle"
  | "sidebar-toggle" | "sidebar-up" | "sidebar-down" | "sidebar-activate"
  | "focus-toggle" | "help"
  | "pointer-press" | "pointer-drag" | "pointer-double-click" | "wheel-scroll"
  | "paste"
  | MotionCommandId;

/** One row of the command table. */
export interface Command {
  readonly id: CommandId;
  /** What the help overlay lists for this shortcut. */
  readonly title: string;
  /** The combo that runs it, or `undefined` when only a character, the mouse
   * or another command reaches it. */
  readonly key?: KeyCombo;
  /** The shifted twin of {@link key}: the same key with shift held, which the
   * app reads as "extend the selection" rather than collapsing it. */
  readonly shiftKey?: KeyCombo;
  /** Pure: an Intent or `null`, never a scene mutation. */
  readonly apply: Handler;
}

/** The key each motion runs on. The `Record` is exhaustive by type, so binding
 * a new motion is a compile error rather than a dead command. */
const MOTION_KEYS: Record<Motion, KeyCombo> = {
  "char-backward": { name: "left" },
  "char-forward": { name: "right" },
  "word-backward": { name: "left", ctrl: true },
  "word-forward": { name: "right", ctrl: true },
  "line-up": { name: "up" },
  "line-down": { name: "down" },
  "line-start": { name: "home" },
  "line-end": { name: "end" },
  "paragraph-backward": { name: "up", ctrl: true },
  "paragraph-forward": { name: "down", ctrl: true },
  "doc-start": { name: "home", ctrl: true },
  "doc-end": { name: "end", ctrl: true },
};

/** The motion vocabulary, in binding order. */
const MOTION_IDS = Object.keys(MOTION_KEYS) as readonly Motion[];

/** `[id, title, key?]` — the whole non-motion table, one row per command. */
const BINDINGS: ReadonlyArray<readonly [CommandId, string, KeyCombo?]> = [
  ["insert-char", "Type a character"],
  ["insert-newline", "Insert a new line", { name: "enter" }],
  ["insert-tab", "Insert a tab", { name: "tab" }],
  ["backspace", "Delete backwards", { name: "backspace" }],
  ["delete-forward", "Delete forwards", { name: "delete" }],
  ["delete-word-backward", "Delete the word before", { name: "backspace", ctrl: true }],
  ["delete-word-forward", "Delete the word after", { name: "delete", ctrl: true }],
  ["delete-line", "Delete the line", { name: "k", ctrl: true }],
  ["undo", "Undo", { name: "z", ctrl: true }],
  ["redo", "Redo", { name: "z", ctrl: true, shift: true }],
  ["select-word", "Select the word"],
  ["select-line", "Select the line"],
  ["select-paragraph", "Select the paragraph"],
  ["select-document", "Select the whole document", { name: "a", ctrl: true }],
  ["cancel", "Cancel / close", { name: "escape" }],
  ["search-open", "Find", { name: "f", ctrl: true }],
  ["search-next", "Find the next match", { name: "f3" }],
  ["search-previous", "Find the previous match", { name: "f3", shift: true }],
  ["search-replace", "Replace", { name: "h", ctrl: true }],
  ["replace-all", "Replace every match", { name: "enter", ctrl: true }],
  ["search-replace-current", "Replace the current match", { name: "enter", alt: true }],
  ["file-save", "Save", { name: "s", ctrl: true }],
  ["file-open", "Open a file", { name: "o", ctrl: true }],
  ["file-new", "New file", { name: "n", ctrl: true }],
  ["buffer-new", "New buffer", { name: "n", ctrl: true, alt: true }],
  ["buffer-close", "Close the buffer", { name: "w", ctrl: true, alt: true }],
  ["buffer-next", "Next buffer", { name: "right", ctrl: true, alt: true }],
  ["buffer-previous", "Previous buffer", { name: "left", ctrl: true, alt: true }],
  ["wrap-toggle", "Toggle soft wrap", { name: "z", alt: true }],
  ["gutter-toggle", "Toggle line numbers", { name: "l", alt: true }],
  ["quit", "Quit", { name: "q", ctrl: true }],
  ["sidebar-toggle", "Toggle the file list", { name: "b", ctrl: true }],
  ["sidebar-up", "Previous file", { name: "up", alt: true }],
  ["sidebar-down", "Next file", { name: "down", alt: true }],
  ["sidebar-activate", "Open the highlighted file"],
  ["focus-toggle", "Switch pane", { name: "tab", ctrl: true }],
  ["help", "Keyboard shortcuts", { name: "f1" }],
  // Reached by the mouse, the wheel and the terminal's paste, never by a combo —
  // which is what `Command.key` being optional is for. A combo-less command is
  // dispatch-only: `registerCommands` (keymap.ts:50-67) registers it nowhere.
  ["pointer-press", "Click to place the caret"],
  ["pointer-drag", "Drag to select"],
  ["pointer-double-click", "Double-click to select a word"],
  ["wheel-scroll", "Scroll the view"],
  ["paste", "Paste the clipboard"],
];
/** Run `id` against `ctx` — the ONE place a command id becomes an Intent. */
export function applyCommand(id: CommandId, ctx: CommandContext): Intent | null {
  return HANDLERS[id](ctx);
}

/** The command a key event types, or `null`: a `"char"` event whose Ctrl / Alt
 * and Meta / Super are released. Shift is deliberately NOT excluded — shift is what
 * produces an uppercase character, so `"K"` must still type. */
export function typedCharacter(key: KeyEvent): string | null {
  if (key.name !== "char" || key.char === undefined || key.char === "") return null;
  if (key.ctrl || key.alt || key.meta === true || key.super === true) return null;
  return key.char;
}

/** Every match replaced with the overlay's replacement text, or `null` when
 * there is no query. The edits are computed HERE, against the live buffer, and
 * carried in the intent — so the reducer applies exactly what the command decided. */
function replaceEveryMatch(ctx: CommandContext): Intent | null {
  if (ctx.search.query === "") return null;
  return {
    kind: "replace-all",
    edits: replaceAllEdits(ctx.buffer, ctx.search.query, ctx.search.replacement, {
      caseSensitive: ctx.search.caseSensitive,
    }),
  };
}

/** The match under the caret replaced with the replacement text, or the next one
 * when the caret is not on a match. One edit, so one undo step. */
function replaceCurrentMatch(ctx: CommandContext): Intent | null {
  if (ctx.search.query === "") return null;
  const matches = findMatches(ctx.buffer, ctx.search.query, { caseSensitive: ctx.search.caseSensitive });
  if (matches.length === 0) return null;
  const at = matchContaining(matches, ctx.caret);
  const match = at ?? matches[nextMatchIndex(matches, ctx.caret, 1)]!;
  return { kind: "replace-all", edits: [replaceEdit(match, ctx.search.replacement)] };
}

/** Whether the search overlays own the keyboard. */
function searching(ctx: CommandContext): boolean {
  return ctx.modal === "find" || ctx.modal === "replace";
}

/** The delete intent for a range, or `null` when the range is empty — an empty
 * delete must not reach the buffer, because it would push an undo step that
 * undoes nothing. */
function removeRange(selection: Selection): Intent | null {
  const { start, end } = ordered(selection);
  return positionsEqual(start, end) ? null : { kind: "delete", start, end };
}

/** Delete the span a motion covers, or `null` when the motion cannot move. The
 * span comes from the SAME `applyMotion` the keyboard uses, so a delete and a
 * move agree about where a word begins. */
function removeMotion(ctx: CommandContext, motion: Motion): Intent | null {
  const target = applyMotion(ctx, ctx.caret, motion, NO_GOAL).position;
  if (positionsEqual(target, ctx.caret)) return null;
  return removeRange({ anchor: ctx.caret, caret: target });
}

/** The selection with the selection-clearing rule applied: a selection wins over
 * the motion, so backspace over a highlighted run removes the run. */
function removeBackward(ctx: CommandContext, motion: Motion): Intent | null {
  if (ctx.selection !== null) return removeRange(ctx.selection);
  return removeMotion(ctx, motion);
}

/** One handler per motion, generated so the vocabulary and the handlers cannot
 * drift. The cast is the price of building a mapped type at runtime; the `Record`
 * annotation on {@link HANDLERS} is what proves it is complete. */
function motionHandlers(): { [K in MotionCommandId]: Handler } {
  const handlers = {} as { [K in MotionCommandId]: Handler };
  for (const motion of MOTION_IDS) {
    handlers[`move-${motion}`] = (ctx) => ({
      kind: "move",
      motion,
      extend: ctx.key.shift === true,
    });
  }
  return handlers;
}

/** What a unit-selection command produces. */
function selectUnit(unit: SelectionUnit): Handler {
  return (ctx) => ({ kind: "select", unit, position: ctx.caret });
}

/** Every command's pure handler — the ONE place an id becomes an action. */
const HANDLERS: Record<CommandId, Handler> = {
  ...motionHandlers(),
  "insert-char": (ctx) => {
    const text = typedCharacter(ctx.key);
    if (text === null) return null;
    return searching(ctx) ? { kind: "search", action: "append", text } : { kind: "insert", text };
  },
  // Enter in the replace overlay runs the whole replacement: the overlay has no
  // per-match key of its own, and the query it inherited is the find's.
  "insert-newline": (ctx) => {
    if (ctx.modal === "replace") return replaceEveryMatch(ctx);
    if (ctx.modal === "find") return { kind: "search", action: "next" };
    return { kind: "insert", text: "\n" };
  },
  "insert-tab": (ctx) =>
    searching(ctx) ? null : { kind: "insert", text: "\t" },
  "backspace": (ctx) =>
    searching(ctx)
      ? { kind: "search", action: "backspace" }
      : removeBackward(ctx, "char-backward"),
  "delete-forward": (ctx) =>
    ctx.selection !== null ? removeRange(ctx.selection) : removeMotion(ctx, "char-forward"),
  "delete-word-backward": (ctx) => removeBackward(ctx, "word-backward"),
  "delete-word-forward": (ctx) =>
    ctx.selection !== null ? removeRange(ctx.selection) : removeMotion(ctx, "word-forward"),
  "delete-line": (ctx) => removeRange(expandSelection(ctx.buffer, ctx.caret, "line")),
  "undo": () => ({ kind: "history", action: "undo" }),
  "redo": () => ({ kind: "history", action: "redo" }),
  "select-word": selectUnit("word"),
  "select-line": selectUnit("line"),
  "select-paragraph": selectUnit("paragraph"),
  "select-document": () => ({ kind: "select-all" }),
  "cancel": (ctx) => {
    if (ctx.modal === "help") return { kind: "modal", action: "pop" };
    if (searching(ctx)) return { kind: "search", action: "close" };
    if (ctx.selection !== null) return { kind: "clear-selection" };
    return null;
  },
  "search-open": () => ({ kind: "search", action: "open" }),
  "search-next": () => ({ kind: "search", action: "next" }),
  "search-previous": () => ({ kind: "search", action: "previous" }),
  "search-replace": () => ({ kind: "search", action: "replace-open" }),
  "replace-all": replaceEveryMatch,
  "search-replace-current": (ctx) => searching(ctx) ? replaceCurrentMatch(ctx) : null,
  "file-save": () => ({ kind: "file", action: "save" }),
  "file-open": () => ({ kind: "file", action: "open" }),
  "file-new": () => ({ kind: "file", action: "new" }),
  "buffer-new": () => ({ kind: "buffer", action: "new" }),
  "buffer-close": () => ({ kind: "buffer", action: "close" }),
  "buffer-next": () => ({ kind: "buffer", action: "next" }),
  "buffer-previous": () => ({ kind: "buffer", action: "previous" }),
  "wrap-toggle": (ctx) => ({ kind: "wrap", on: !ctx.wrap }),
  "gutter-toggle": (ctx) => ({ kind: "gutter", on: !ctx.gutter }),
  "quit": () => ({ kind: "quit" }),
  "sidebar-toggle": () => ({ kind: "sidebar", action: "toggle" }),
  "sidebar-up": () => ({ kind: "sidebar", action: "up" }),
  "sidebar-down": () => ({ kind: "sidebar", action: "down" }),
  "sidebar-activate": () => ({ kind: "sidebar", action: "activate" }),
  "focus-toggle": () => ({ kind: "focus", pane: "toggle" }),
  "help": () => ({ kind: "modal", action: "push", id: "help" }),
  "pointer-press": (ctx) => pointerIntent(ctx, "press"),
  "pointer-drag": (ctx) => pointerIntent(ctx, "drag"),
  "pointer-double-click": (ctx) => pointerIntent(ctx, "double-click"),
  "wheel-scroll": (ctx) => {
    const rows = ctx.pointer?.rows ?? 0;
    return rows === 0 ? null : { kind: "scroll", rows };
  },
  // A paste is an INSERT, the same intent a typed character produces — so a paste
  // is one undo step, lands at the caret and replaces a selection exactly as
  // typing would. The layer hands over text; the meaning is decided here.
  "paste": (ctx) => (ctx.paste === null || ctx.paste === "" ? null : { kind: "insert", text: ctx.paste }),
};

/** The pointer intent for `action`, or `null` when the command was not reached by
 * a pointer event. The cell travels UNRESOLVED on purpose: which pane it is in and
 * which document slot it names is the resolver's decision (pointer.ts). */
function pointerIntent(ctx: CommandContext, action: PointerIntent["action"]): Intent | null {
  const pointer = ctx.pointer;
  return pointer === null ? null : { kind: "pointer", action, cell: pointer.cell };
}

/**
 * Every command: the bindings above, plus one command per motion.
 *
 * The motion commands are GENERATED from {@link MOTION_KEYS}, so the vocabulary the
 * reducer handles, the combos the keymap registers and the rows the help overlay
 * lists are one table rather than three that drift. Each motion also gets a shifted
 * twin, which is what makes shift+arrow extend a selection through the framework's
 * shortcut registry.
 */
export const COMMANDS: readonly Command[] = [
  ...MOTION_IDS.map((motion): Command => {
    const id: MotionCommandId = `move-${motion}`;
    return {
      id,
      title: `Move ${motion.replace(/-/g, " ")}`,
      key: MOTION_KEYS[motion],
      shiftKey: { ...MOTION_KEYS[motion], shift: true },
      apply: HANDLERS[id],
    };
  }),
  ...BINDINGS.map(([id, title, key]): Command => ({
    id,
    title,
    ...(key === undefined ? {} : { key }),
    apply: HANDLERS[id],
  })),
];

/** The command with `id`, or `undefined` — the table is the registry. */
export function commandById(id: CommandId): Command | undefined {
  return COMMANDS.find((command) => command.id === id);
}
