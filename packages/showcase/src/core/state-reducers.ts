//! The intent reducer: one intent in, the app's state out.
//
// WHY THIS IS NOT IN state.ts. "What an intent does to the app" is the state
// machine's largest concern and the last seam state.ts gave up; the public surface
// (state.ts) and the pane reducer (state-panes.ts) are its siblings. The contracts
// are untouched: commands.ts still decides what a key means and plan.ts still
// decides what is on screen; this module only reduces.

import type { Intent, SearchAction } from "./commands.ts";
import { applyEdit, travel } from "./edits.ts";
import { clampPosition } from "./motions.ts";
import { isAuxPane } from "./pane-ids.ts";
import { closePane, openPane } from "./panes.ts";
import { MIN_EDITOR_COLS } from "./plan.ts";
import { resolvePointer } from "./pointer.ts";
import { ordered } from "./selection.ts";
import { reduceSidebar } from "./sidebar-pane.ts";
import type { Position } from "./buffer.ts";
import { PaneReducerApp } from "./state-panes.ts";

/** The narrowest the file list may be dragged (a marker and a few label cells). */
const SIDEBAR_MIN_WIDTH = 4;

/** The width a double-click on the split restores. */
const SIDEBAR_DEFAULT_WIDTH = 20;

/** The intent reducer, layered on the pane reducer. */
export abstract class IntentReducerApp extends PaneReducerApp {

  /** Apply an intent: the only place the app's state changes. */
  reduce(intent: Intent): void {
    // A run of keystrokes is one undo step only while nothing else happens; the ring
    // cannot see that (undo.ts), so the caller tells it.
    if (intent.kind !== "insert") this.editing.history.breakCoalesce();
    // A wheel scroll is the ONE intent that detaches the view from the caret.
    if (intent.kind !== "scroll") this.followCaret = true;
    switch (intent.kind) {
      case "insert": {
        const selection = this.caretModel.selection;
        const range = selection === null
          ? { start: this.caretModel.caret, end: this.caretModel.caret }
          : ordered(selection);
        this.#edit(range.start, range.end, intent.text);
        return;
      }
      case "delete":
        this.#edit(intent.start, intent.end, "");
        return;
      case "replace-all":
        // One undo step per match: each splice is independent (see the report).
        for (const edit of intent.edits) this.#edit(edit.start, edit.end, edit.text);
        this.editing.history.breakCoalesce();
        return;
      case "move":
        this.caretModel.move(this.geometry(), intent.motion, intent.extend);
        return;
      case "cursor":
        this.caretModel.moveTo(clampPosition(this.editing.buffer, intent.position));
        return;
      case "select":
        this.caretModel.select(this.editing.buffer, intent.position, intent.unit);
        return;
      case "select-all": {
        this.caretModel.press({ row: 0, col: 0 });
        const last = this.editing.buffer.lineCount - 1;
        this.caretModel.dragTo({ row: last, col: this.editing.buffer.lineAt(last).length });
        return;
      }
      case "clear-selection":
        this.caretModel.clear();
        return;
      case "history":
        this.#travel(intent.action === "undo");
        return;
      case "search":
        this.#reduceSearch(intent.action, intent.text);
        return;
      case "modal":
        if (intent.action === "push") {
          this.overlay.push(intent.id);
          // Raising an auxiliary pane resets its window; the search overlays keep
          // their own session state in overlay.ts.
          if (isAuxPane(intent.id)) openPane(this.paneState, intent.id);
        } else {
          const top = this.overlay.modal;
          this.overlay.pop(intent.id);
          if (isAuxPane(top)) closePane(this.paneState);
        }
        return;
      case "focus":
        this.focusPane = intent.pane === "toggle" ? (this.focusPane === "editor" ? "sidebar" : "editor") : intent.pane;
        return;
      case "sidebar":
        this.#reduceSidebar(intent.action);
        return;
      case "buffer":
        this.#reduceBuffer(intent.action);
        return;
      case "wrap":
        this.wrapOn = intent.on;
        this.paneState.prefs.wrap = intent.on;
        return;
      case "pane":
        this.reducePane(intent.action, intent.text);
        return;
      case "gutter":
        this.gutterOn = intent.on;
        return;
      case "file":
        this.#reduceFile(intent.action);
        return;
      case "quit":
        this.effects.push({ kind: "quit" });
        return;
      case "pointer":
        this.#reducePointer(intent.action, intent.cell);
        return;
      case "scroll":
        this.#reduceScroll(intent.rows);
        return;
      default:
        // Exhaustiveness proof: a new Intent member with no case fails here.
        assertNever(intent);
    }
  }

  /** Edit through `edits.ts` and land the caret where the insert ended. */
  #edit(start: Position, end: Position, text: string): void {
    this.caretModel.moveTo(applyEdit(this.editing, { start, end, text, caretBefore: this.caretModel.caret }));
  }

  /** Undo or redo one step, if the ring has one. */
  #travel(back: boolean): void {
    const position = travel(this.editing, back);
    if (position !== null) this.caretModel.moveTo(position);
  }

  /** A pointer event, resolved against the plan by `resolvePointer` (pointer.ts). */
  #reducePointer(action: "press" | "drag" | "double-click", cell: Position): void {
    const target = resolvePointer(this.build(), cell, this.geometry());
    if (target === null || target.pane === "modal") return;
    if (target.pane === "gutter") {
      // The panel drag starts on the split's own cell: the split follows the
      // pointer, clamped so the editor keeps MIN_EDITOR_COLS and the list keeps its
      // own minimum. A double-click restores the default width. State only — the
      // plan lays the new width out.
      this.panelDrag = true;
      this.#setSidebarWidth(action === "double-click" ? SIDEBAR_DEFAULT_WIDTH : cell.col);
      return;
    }
    if (action === "drag" && this.panelDrag) {
      // A drag already in flight resolves its LATER cells against the split, not
      // the pane under them — the pane boundaries move as the split does, so the
      // cell that started the drag is the anchor and every later cell is a width.
      this.#setSidebarWidth(cell.col);
      return;
    }
    if (action === "press" || action === "double-click") this.panelDrag = false;
    if (target.pane === "sidebar") {
      this.focusPane = "sidebar";
      if (target.index >= 0) this.sidebarState.active = target.index;
      return;
    }
    this.focusPane = "editor";
    const buffer = this.editing.buffer;
    const position = target.position;
    if (action === "drag") this.caretModel.dragTo(clampPosition(buffer, position));
    else if (action === "double-click") this.caretModel.doubleClick(buffer, clampPosition(buffer, position));
    else this.caretModel.press(clampPosition(buffer, position));
  }

  /** Set the split's width, clamped between the list's minimum and the editor's. */
  #setSidebarWidth(width: number): void {
    const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, this.size.cols - MIN_EDITOR_COLS);
    this.sidebarState.width = Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
  }

  /** A wheel event: move the viewport and DETACH it from the caret; the plan clamps. */
  #reduceScroll(rows: number): void {
    this.followCaret = false;
    this.scrollOffset = Math.max(0, this.scrollOffset + rows);
  }

  /** The overlay's reducer: caret-driving actions here, overlay state in overlay.ts. */
  #reduceSearch(action: SearchAction, text: string | undefined): void {
    if (action === "next" || action === "previous") {
      this.#selectMatch(action === "next" ? 1 : -1);
      return;
    }
    this.overlay.reduce(action, text);
  }

  /** Step the search and select the match; a found match is a selection like any other. */
  #selectMatch(direction: 1 | -1): void {
    const match = this.overlay.step(this.editing.buffer, this.caretModel.caret, direction);
    if (match === null) return;
    this.caretModel.press(match.start);
    this.caretModel.dragTo(match.end);
  }

  #reduceSidebar(action: "toggle" | "up" | "down" | "activate"): void {
    const effect = reduceSidebar(this.sidebarState, action);
    if (effect !== null) this.effects.push(effect);
  }

  #reduceBuffer(action: "new" | "close" | "next" | "previous"): void {
    if (action === "new") {
      this.buffers.open("", null);
      return;
    }
    if (action === "close") {
      this.buffers.close();
      return;
    }
    this.buffers.step(action === "next" ? 1 : -1);
  }

  #reduceFile(action: "save" | "open" | "new"): void {
    if (action === "save") this.effects.push({ kind: "save", path: this.bufferPath });
    else if (action === "open") this.effects.push({ kind: "open", path: this.bufferPath });
    else this.buffers.open("", null);
  }
}

/** Exhaustiveness: an Intent member handled nowhere lands here at compile time. */
function assertNever(value: never): never {
  throw new Error(`unhandled intent ${JSON.stringify(value)}`);
}
