//! The headless app: the state machine, its reducers, and the plan it feeds.
//
// Nothing here builds a scene. The app holds the open buffers (buffers.ts), the
// overlay stack (overlay.ts), the file list (sidebar-pane.ts) and the display
// toggles; it turns an EVENT into a command (commands.ts), a command into an
// intent (intents.ts), and an intent into state; and it answers with a ScreenPlan
// by calling plan.ts. A pointer cell is resolved in pointer.ts against that plan.
//
// The state is a pure function of (initial state, intent sequence): replay the
// same intents and the same ScreenPlan comes out, with no napi addon and no PTY.

import { Keymap, type KeyEvent } from "@tern-tui/core";
import { Buffer, type Position } from "./buffer.ts";
import {
  applyCommand,
  type CommandContext,
  type CommandId,
  type Intent,
  type ModalId,
  type SearchAction,
} from "./commands.ts";
import { BufferSet } from "./buffers.ts";
import { applyEdit, reopen, travel, type EditingState } from "./edits.ts";
import {
  isPasteEvent,
  isPointerEvent,
  POINTER_COMMANDS,
  WHEEL_ROWS,
  type AppEvent,
  type PointerContext,
} from "./events.ts";
import { dispatchKey, registerCommands, type CommandHost } from "./keymap.ts";
import { clampPosition, displayCellOf, type MotionContext } from "./motions.ts";
import { OverlayState } from "./overlay.ts";
import { type PlanFocus, type ScreenPlan } from "./plan.ts";
import { appContext, buildAppPlan, type PlanSource } from "./app-plan.ts";
import { editorOf, resolvePointer, sidebarOf } from "./pointer.ts";
import { newSidebar, reduceSidebar, type SidebarState } from "./sidebar-pane.ts";
import { ordered, type Selection } from "./selection.ts";
import type { ViewportSize } from "./viewport.ts";

/** The screen an app with no host yet reports. */
const DEFAULT_SIZE: ViewportSize = { rows: 24, cols: 80 };

/** The event a programmatic run carries: no name, no character, no modifiers. */
const IDLE_KEY: KeyEvent = { name: "", ctrl: false, alt: false, shift: false };

/** What the app asked the HOST to do — IO and exit. The core performs none of it,
 * so a save is a REQUEST the host drains. */
export type PendingEffect =
  | { kind: "save"; path: string | null }
  | { kind: "open"; path: string | null }
  | { kind: "quit" };

// The file list's own state and reducer live in sidebar-pane.ts.
export type { SidebarState } from "./sidebar-pane.ts";

export interface AppOptions {
  buffer?: Buffer;
  path?: string | null;
  items?: readonly string[];
  sidebarWidth?: number;
  sidebarVisible?: boolean;
  size?: ViewportSize;
  historyCap?: number;
}

/**
 * The whole application state, with no renderer attached.
 *
 * `reduce` is the only method that changes anything; every document change goes
 * through `edits.ts`'s one splice, which moves the buffer, the line index and the
 * wrap cache together. `plan` calls `buildPlan` and returns its answer.
 */
export class HeadlessApp implements CommandHost {
  #buffers: BufferSet;
  #overlay = new OverlayState();
  #focus: PlanFocus = "editor";
  #sidebar: SidebarState;
  #size: ViewportSize;
  #wrap = true;
  #gutter = false;
  #effects: PendingEffect[] = [];
  #keymap: Keymap = new Keymap();

  constructor(options: AppOptions = {}) {
    this.#buffers = new BufferSet(options.buffer ?? new Buffer(), options.path ?? null, options.historyCap);
    this.#size = { ...(options.size ?? DEFAULT_SIZE) };
    this.#sidebar = newSidebar(options);
    registerCommands(this, this.#keymap);
  }

  // The active buffer's slots, through the set's accessors, so every reducer below
  // reads one buffer and many buffers the same way.

  get #editing(): EditingState { return this.#buffers.editing; }
  set #editing(value: EditingState) { this.#buffers.editing = value; }
  get #caret() { return this.#buffers.caret; }
  get #scroll(): number { return this.#buffers.scroll; }
  set #scroll(value: number) { this.#buffers.scroll = value; }
  get #followCaret(): boolean { return this.#buffers.followCaret; }
  set #followCaret(value: boolean) { this.#buffers.followCaret = value; }
  get #path(): string | null { return this.#buffers.path; }

  // Read-only state, for the host and for tests.

  get buffer(): Buffer { return this.#editing.buffer; }
  get keymap(): Keymap { return this.#keymap; }
  get caret(): Position { return this.#caret.caret; }
  get selection(): Selection | null { return this.#buffers.selection; }
  get scroll(): number { return this.#scroll; }
  get focus(): PlanFocus { return this.#focus; }
  get modal(): ModalId | null { return this.#overlay.modal; }
  get path(): string | null { return this.#path; }
  get sidebar(): Readonly<SidebarState> { return this.#sidebar; }
  get search(): OverlayState["search"] { return this.#overlay.search; }
  get replacement(): string { return this.#overlay.replacement; }
  get wrap(): boolean { return this.#wrap; }
  get gutter(): boolean { return this.#gutter; }
  get bufferCount(): number { return this.#buffers.count; }
  get activeBuffer(): number { return this.#buffers.activeIndex; }

  /** The screen plan: the app's ONE call into `plan.ts`. The scroll is kept honest
   * in the one place that knows the editor's document height — the plan's own
   * region minus its tab-strip header; a caret outside that window rebuilds once. */
  plan(size: ViewportSize = this.#size): ScreenPlan {
    this.#size = { rows: size.rows, cols: size.cols };
    const plan = this.#build();
    // The file list's window is reconciled by the plan against the pane height IT
    // laid out; the app adopts the answer so the two never disagree about where the
    // list is scrolled. No rebuild: the window does not change the rows just emitted.
    const sidebar = sidebarOf(plan);
    if (sidebar !== null) this.#sidebar.scroll = sidebar.scroll;
    const editor = editorOf(plan);
    if (editor === null) return plan;
    // A wheel scroll detaches the view from the caret; every other intent re-attaches.
    if (!this.#followCaret) return plan;
    const rows = editor.height - (editor.headerRows ?? 0);
    const row = displayCellOf(this.#geometry(), this.#caret.caret).row;
    if (row >= editor.firstRow && row <= editor.firstRow + rows - 1) return plan;
    this.#scroll = Math.max(0, row < editor.firstRow ? row : row - (rows - 1));
    return this.#build();
  }

  /** Open `text` as `path` in the ACTIVE buffer; a new buffer is {@link openBuffer}. */
  load(text: string, path: string | null): void {
    this.#editing = reopen(this.#editing, text);
    this.#caret.moveTo({ row: 0, col: 0 });
    this.#scroll = 0;
    this.#buffers.path = path;
    this.#followCaret = true;
  }

  /** Open a NEW buffer and make it active. */
  openBuffer(text = "", path: string | null = null): void {
    this.#buffers.open(text, path);
  }

  /** Close the active buffer. The last buffer is emptied rather than removed. */
  closeBuffer(): void {
    this.#buffers.close();
  }

  /** Make buffer `index` active, clamped into range. */
  selectBuffer(index: number): void {
    this.#buffers.select(index);
  }

  /** The effects the app queued, oldest first, and drains. */
  takeEffects(): PendingEffect[] {
    return this.#effects.splice(0, this.#effects.length);
  }

  /** Run one command and reduce what it asked for — the keymap's entry point.
   * Returns the intent, so a test can assert what the key MEANT. */
  run(
    id: CommandId,
    key: KeyEvent = IDLE_KEY,
    pointer: PointerContext | null = null,
    paste: string | null = null,
  ): Intent | null {
    const intent = applyCommand(id, this.#context(key, pointer, paste));
    if (intent !== null) this.reduce(intent);
    return intent;
  }

  /** Route one input EVENT. Returns whether the event was consumed, so a host can
   * let an unhandled event fall through to its own routing. */
  dispatch(event: AppEvent): boolean {
    if (isPointerEvent(event)) {
      return this.run(POINTER_COMMANDS[event.kind], IDLE_KEY, { cell: event.cell, rows: WHEEL_ROWS[event.kind] }) !== null;
    }
    if (isPasteEvent(event)) return this.run("paste", IDLE_KEY, null, event.text) !== null;
    return dispatchKey(this, this.#keymap, event);
  }

  /** Apply an intent: the only place the app's state changes. */
  reduce(intent: Intent): void {
    // A run of keystrokes is one undo step only while nothing else happens; the ring
    // cannot see that (undo.ts), so the caller tells it.
    if (intent.kind !== "insert") this.#editing.history.breakCoalesce();
    // A wheel scroll is the ONE intent that detaches the view from the caret.
    if (intent.kind !== "scroll") this.#followCaret = true;
    switch (intent.kind) {
      case "insert": {
        const selection = this.#caret.selection;
        const range = selection === null
          ? { start: this.#caret.caret, end: this.#caret.caret }
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
        this.#editing.history.breakCoalesce();
        return;
      case "move":
        this.#caret.move(this.#geometry(), intent.motion, intent.extend);
        return;
      case "cursor":
        this.#caret.moveTo(clampPosition(this.#editing.buffer, intent.position));
        return;
      case "select":
        this.#caret.select(this.#editing.buffer, intent.position, intent.unit);
        return;
      case "select-all": {
        this.#caret.press({ row: 0, col: 0 });
        const last = this.#editing.buffer.lineCount - 1;
        this.#caret.dragTo({ row: last, col: this.#editing.buffer.lineAt(last).length });
        return;
      }
      case "clear-selection":
        this.#caret.clear();
        return;
      case "history":
        this.#travel(intent.action === "undo");
        return;
      case "search":
        this.#reduceSearch(intent.action, intent.text);
        return;
      case "modal":
        if (intent.action === "push") this.#overlay.push(intent.id);
        else this.#overlay.pop();
        return;
      case "focus":
        this.#focus = intent.pane === "toggle" ? (this.#focus === "editor" ? "sidebar" : "editor") : intent.pane;
        return;
      case "sidebar":
        this.#reduceSidebar(intent.action);
        return;
      case "buffer":
        this.#reduceBuffer(intent.action);
        return;
      case "wrap":
        this.#wrap = intent.on;
        return;
      case "gutter":
        this.#gutter = intent.on;
        return;
      case "file":
        this.#reduceFile(intent.action);
        return;
      case "quit":
        this.#effects.push({ kind: "quit" });
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
    this.#caret.moveTo(applyEdit(this.#editing, { start, end, text, caretBefore: this.#caret.caret }));
  }

  /** Undo or redo one step, if the ring has one. */
  #travel(back: boolean): void {
    const position = travel(this.#editing, back);
    if (position !== null) this.#caret.moveTo(position);
  }

  /** A pointer event, resolved against the plan by `resolvePointer` (pointer.ts). */
  #reducePointer(action: "press" | "drag" | "double-click", cell: Position): void {
    const target = resolvePointer(this.#build(), cell, this.#geometry());
    if (target === null || target.pane === "modal") return;
    if (target.pane === "sidebar") {
      this.#focus = "sidebar";
      if (target.index >= 0) this.#sidebar.active = target.index;
      return;
    }
    this.#focus = "editor";
    const buffer = this.#editing.buffer;
    const position = target.position;
    if (action === "drag") this.#caret.dragTo(clampPosition(buffer, position));
    else if (action === "double-click") this.#caret.doubleClick(buffer, clampPosition(buffer, position));
    else this.#caret.press(clampPosition(buffer, position));
  }

  /** A wheel event: move the viewport and DETACH it from the caret; the plan clamps. */
  #reduceScroll(rows: number): void {
    this.#followCaret = false;
    this.#scroll = Math.max(0, this.#scroll + rows);
  }

  /** Everything the plan and a command context are assembled from. */
  #source(): PlanSource {
    const sidebar = this.#sidebar;
    return {
      editing: this.#editing,
      caret: this.#caret.caret,
      selection: this.#buffers.selection,
      scroll: this.#scroll,
      size: this.#size,
      focus: this.#focus,
      modal: this.modal,
      path: this.#path,
      wrap: this.#wrap,
      gutter: this.#gutter,
      sidebarVisible: sidebar.visible,
      sidebarItems: sidebar.items,
      sidebarWidth: sidebar.width,
      sidebarActive: sidebar.active,
      sidebarScroll: sidebar.scroll,
      tabs: this.#buffers.tabs(),
      overlay: this.#overlay,
      keymap: this.#keymap,
    };
  }

  /** The plan for the current state and size. */
  #build(): ScreenPlan {
    return buildAppPlan(this.#source());
  }

  /** The document plus its row geometry — what a motion resolves against. */
  #geometry(): MotionContext {
    return { buffer: this.#editing.buffer, index: this.#editing.index, cache: this.#editing.cache };
  }

  /** Everything a command may read, plus the event that triggered it. */
  #context(key: KeyEvent, pointer: PointerContext | null = null, paste: string | null = null): CommandContext {
    return appContext(this.#source(), key, pointer, paste);
  }

  /** The overlay's reducer: caret-driving actions here, overlay state in overlay.ts. */
  #reduceSearch(action: SearchAction, text: string | undefined): void {
    if (action === "next" || action === "previous") {
      this.#selectMatch(action === "next" ? 1 : -1);
      return;
    }
    this.#overlay.reduce(action, text);
  }

  /** Step the search and select the match; a found match is a selection like any other. */
  #selectMatch(direction: 1 | -1): void {
    const match = this.#overlay.step(this.#editing.buffer, this.#caret.caret, direction);
    if (match === null) return;
    this.#caret.press(match.start);
    this.#caret.dragTo(match.end);
  }

  #reduceSidebar(action: "toggle" | "up" | "down" | "activate"): void {
    const effect = reduceSidebar(this.#sidebar, action);
    if (effect !== null) this.#effects.push(effect);
  }

  #reduceBuffer(action: "new" | "close" | "next" | "previous"): void {
    if (action === "new") {
      this.#buffers.open("", null);
      return;
    }
    if (action === "close") {
      this.#buffers.close();
      return;
    }
    this.#buffers.step(action === "next" ? 1 : -1);
  }

  #reduceFile(action: "save" | "open" | "new"): void {
    if (action === "save") this.#effects.push({ kind: "save", path: this.#path });
    else if (action === "open") this.#effects.push({ kind: "open", path: this.#path });
    else this.#buffers.open("", null);
  }
}

/** Exhaustiveness: an Intent member handled nowhere lands here at compile time. */
function assertNever(value: never): never {
  throw new Error(`unhandled intent ${JSON.stringify(value)}`);
}
