//! The input event vocabulary: what the app's ONE input route accepts, and what a
//! pointer or wheel command asks the reducer to do.
//
// WHY THIS IS NOT IN `commands.ts`. `commands.ts` is the ONE decision point for
// what a key MEANS (commands.ts:1-9); this module is the SHAPE of the events that
// reach it and of the pointer/scroll intents it answers with. The two grew apart
// enough that `commands.ts` was over its module budget, and the seam is real: the
// table maps ids to intents, while this file only says what a pointer event, a
// paste and a wheel request ARE. `commands.ts` re-exports every name below, so it
// remains the one import site a consumer needs.
//
// A pointer event carries the SCREEN CELL it landed on and nothing else. Which
// pane that cell is in, which document slot it names and where the caret goes is
// decided by the pointer resolver (pointer.ts) against the plan's own regions — a
// layer that mapped a cell to a position would be a second decision point about
// the layout.

import type { KeyEvent } from "@tern-tui/core";
import type { Position } from "./buffer.ts";
import type { CommandId } from "./commands.ts";

/** The pointer events the app models. A LAYER translates the framework's own
 * mouse event into exactly one of these and decides nothing else: what the cell
 * MEANS — which pane it is in, which document slot it names, where the caret goes —
 * is decided by the pointer resolver (pointer.ts) and applied by `state.ts`, never
 * in a renderer. */
export type PointerKind = "press" | "drag" | "double-click" | "wheel-up" | "wheel-down";

/** One pointer event, in the app's own vocabulary: what happened, and the SCREEN
 * cell it happened on (row and column from the screen's top-left). */
export interface PointerEvent {
  readonly kind: PointerKind;
  readonly cell: Position;
}

/** One paste, in the app's own vocabulary: the text the terminal handed over. */
export interface PasteEvent {
  readonly kind: "paste";
  readonly text: string;
}

/** Everything the app's ONE input route accepts: {@link KeyEvent} for keys,
 * {@link PointerEvent} for the mouse, {@link PasteEvent} for a paste. */
export type AppEvent = KeyEvent | PointerEvent | PasteEvent;

/** Whether `event` is a pointer event (it carries a cell; a key event does not). */
export function isPointerEvent(event: AppEvent): event is PointerEvent {
  return "cell" in event;
}

/** Whether `event` is a paste (it carries pasted text; a key event carries a
 * character under `char`, never `text`). */
export function isPasteEvent(event: AppEvent): event is PasteEvent {
  return "text" in event;
}

/** What a command asks the POINTER to do: what happened, at which screen cell.
 * The cell travels UNRESOLVED — the reducer resolves it against the plan's own
 * regions (pointer.ts), so no layer maps a cell to a pane or to a document slot. */
export interface PointerIntent {
  readonly kind: "pointer";
  readonly action: "press" | "drag" | "double-click";
  readonly cell: Position;
}

/** What a command asks the VIEWPORT to do: scroll by `rows` display rows, positive
 * down. The plan clamps the request, because the plan is the one place that knows
 * the window's bounds. */
export interface ScrollIntent {
  readonly kind: "scroll";
  readonly rows: number;
}

/** What a pointer command may read: the cell the event landed on and how far a
 * wheel asked the view to move. */
export interface PointerContext {
  readonly cell: Position;
  /** The signed rows a wheel event asks the view to scroll (positive = down). */
  readonly rows: number;
}

/** The command each pointer event runs: the ONE place a mouse event becomes a
 * command id, exactly as `COMMANDS` is the one place a key does. */
export const POINTER_COMMANDS: Record<PointerKind, CommandId> = {
  "press": "pointer-press",
  "drag": "pointer-drag",
  "double-click": "pointer-double-click",
  "wheel-up": "wheel-scroll",
  "wheel-down": "wheel-scroll",
};

/** The rows a wheel event asks the view to scroll. The wheel's direction names the
 * CONTENT's movement and one event is one row — the framework's own rule
 * (packages/core/src/mouse.ts:39-57). */
export const WHEEL_ROWS: Record<PointerKind, number> = {
  "press": 0, "drag": 0, "double-click": 0, "wheel-up": -1, "wheel-down": 1,
};
