//! The intent vocabulary: what a command ASKS FOR, and what a command may read.
//
// WHY THIS IS NOT IN `commands.ts`. `commands.ts` is the TABLE — the bindings and
// the pure handlers that turn a key into an intent. The SHAPES those handlers
// answer with (an insert, a move, a buffer switch) and the context they read are a
// seam of their own, and `commands.ts` was over its module budget. `commands.ts`
// re-exports every name below, so it stays the one import site a consumer needs.
//
// An Intent is a DESCRIPTION of a change, never a scene mutation: this module
// imports no scene type, no renderer and no napi surface.

import type { KeyEvent } from "@tern-tui/core";
import type { Position } from "./buffer.ts";
import type { PointerIntent, PointerContext, ScrollIntent } from "./events.ts";
import type { Motion, MotionContext } from "./motions.ts";
import type { PlanFocus } from "./plan.ts";
import type { TextEdit } from "./search.ts";
import type { Selection, SelectionUnit } from "./selection.ts";

/** The modal overlays the command layer knows about. They are part of what a key
 * MEANS — `escape` in the find overlay is not `escape` in the editor. */
export type ModalId = "find" | "replace" | "help";

/** What a command asks the DOCUMENT to do. `state.ts` applies these through its
 * ONE splice, which keeps the line index and the wrap cache in step. */
export type DocumentIntent =
  | { kind: "insert"; text: string }
  | { kind: "delete"; start: Position; end: Position }
  | { kind: "replace-all"; edits: TextEdit[] };

/** What the replace overlay does with the search session. `next`/`previous` step
 * the caret; the single-match replace is the `search-replace-current` command's
 * own edit, carried as a one-entry edit list. */
export type SearchAction =
  | "open" | "close" | "append" | "backspace"
  | "next" | "previous" | "replace-open";

/** What a command asks the APPLICATION's own state to do — no document change. */
export type AppIntent =
  | { kind: "move"; motion: Motion; extend: boolean }
  | { kind: "cursor"; position: Position }
  | { kind: "select"; unit: SelectionUnit; position: Position }
  | { kind: "select-all" }
  | { kind: "clear-selection" }
  | { kind: "history"; action: "undo" | "redo" }
  | { kind: "search"; action: SearchAction; text?: string }
  | { kind: "modal"; action: "push" | "pop"; id?: ModalId }
  | { kind: "focus"; pane: PlanFocus | "toggle" }
  | { kind: "sidebar"; action: "toggle" | "up" | "down" | "activate" }
  | { kind: "buffer"; action: "new" | "close" | "next" | "previous" }
  | { kind: "wrap"; on: boolean }
  | { kind: "gutter"; on: boolean }
  | { kind: "file"; action: "save" | "open" | "new" }
  | { kind: "quit" }
  | PointerIntent
  | ScrollIntent;

/** A command's answer: what the app should do next. */
export type Intent = DocumentIntent | AppIntent;

/** The find/replace overlay's own state, as a command sees it. */
export interface SearchContext {
  query: string;
  replacement: string;
  caseSensitive: boolean;
}

/** Everything a command may read. It extends {@link MotionContext}, so a command
 * that needs a target range runs the SAME `applyMotion` the keyboard does rather
 * than re-deriving a word boundary of its own. */
export interface CommandContext extends MotionContext {
  caret: Position;
  selection: Selection | null;
  focus: PlanFocus;
  modal: ModalId | null;
  sidebarVisible: boolean;
  /** Whether long lines soft-wrap (the toggle in `commands.ts`). */
  wrap: boolean;
  /** Whether the line-number gutter is painted. */
  gutter: boolean;
  search: SearchContext;
  /** The event that triggered this command. */
  key: KeyEvent;
  /** The pointer event, or `null` for a key or paste command. */
  pointer: PointerContext | null;
  /** The pasted text this command is running for, or `null`. */
  paste: string | null;
}

/** A pure command: a context in, an Intent or `null` out. Never a scene. */
export type Handler = (ctx: CommandContext) => Intent | null;
