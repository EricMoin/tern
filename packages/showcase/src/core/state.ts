//! The headless app's public surface: the class the host and the layers hold.
//
// The state machine is split across siblings: state-core.ts holds the shared slots
// and the source/build/context projections, state-panes.ts the auxiliary-pane
// reducer and state-reducers.ts the intent reducer. This module keeps the API —
// dispatch/plan/buffer, the read-only getters and the effect queue — so every
// consumer keeps importing HeadlessApp from state.ts.
//
// Nothing here builds a scene. The app holds the open buffers (buffers.ts), the
// overlay stack (overlay.ts), the file list (sidebar-pane.ts) and the display
// toggles; it turns an EVENT into a command (commands.ts), a command into an
// intent (intents.ts), and an intent into state; and it answers with a ScreenPlan
// by calling plan.ts. A pointer cell is resolved in pointer.ts against that plan.

import { type KeyEvent, type Keymap } from "@tern-tui/core";
import type { Buffer, Position } from "./buffer.ts";
import { applyCommand, type CommandId, type Intent, type ModalId } from "./commands.ts";
import { reopen } from "./edits.ts";
import { isPasteEvent, isPointerEvent, POINTER_COMMANDS, WHEEL_ROWS, type AppEvent, type PointerContext } from "./events.ts";
import { dispatchKey, registerCommands, type CommandHost } from "./keymap.ts";
import { displayCellOf } from "./motions.ts";
import type { OverlayState } from "./overlay.ts";
import { isAuxPane } from "./pane-ids.ts";
import type { AuxPaneId, PaneState } from "./panes.ts";
import type { PlanFocus, ScreenPlan } from "./plan.ts";
import { editorOf, sidebarOf } from "./pointer.ts";
import type { Selection } from "./selection.ts";
import type { SidebarState } from "./sidebar-pane.ts";
import { IntentReducerApp } from "./state-reducers.ts";
import { type AppOptions, IDLE_KEY, type PendingEffect } from "./state-core.ts";
import type { ViewportSize } from "./viewport.ts";

export type { AppOptions, PendingEffect } from "./state-core.ts";
export type { SidebarState } from "./sidebar-pane.ts";

/**
 * The whole application state, with no renderer attached.
 *
 * reduce is the only method that changes anything; every document change goes
 * through edits.ts's one splice, which moves the buffer, the line index and the
 * wrap cache together. plan calls buildPlan and returns its answer.
 */
export class HeadlessApp extends IntentReducerApp implements CommandHost {
  constructor(options: AppOptions = {}) {
    super(options);
    registerCommands(this, this.keys);
  }

  // Read-only state, for the host and for tests.

  get buffer(): Buffer { return this.editing.buffer; }
  get keymap(): Keymap { return this.keys; }
  get caret(): Position { return this.caretModel.caret; }
  get selection(): Selection | null { return this.buffers.selection; }
  get scroll(): number { return this.scrollOffset; }
  get focus(): PlanFocus { return this.focusPane; }
  get modal(): ModalId | null { return this.overlay.modal; }
  get path(): string | null { return this.bufferPath; }
  get sidebar(): Readonly<SidebarState> { return this.sidebarState; }
  get search(): OverlayState["search"] { return this.overlay.search; }
  get replacement(): string { return this.overlay.replacement; }
  get wrap(): boolean { return this.wrapOn; }
  get gutter(): boolean { return this.gutterOn; }
  get bufferCount(): number { return this.buffers.count; }
  get activeBuffer(): number { return this.buffers.activeIndex; }
  get panes(): Readonly<PaneState> { return this.paneState; }
  /** The auxiliary pane on top, or null — the overlay stack's own answer, so the
   * pane state and the modal stack cannot disagree about which pane is open. */
  get paneId(): AuxPaneId | null {
    const modal = this.modal;
    return isAuxPane(modal) ? modal : null;
  }

  /** The external text the diff pane will compare against; `null` clears it.
   * The host calls this after IT read a file — the core reads none. */
  noteExternal(text: string | null): void {
    this.paneState.external = text;
  }

  /** The screen plan: the app's ONE call into `plan.ts`. The scroll is kept honest
   * in the one place that knows the editor's document height — the plan's own
   * region minus its tab-strip header; a caret outside that window rebuilds once. */
  plan(size: ViewportSize = this.size): ScreenPlan {
    this.size = { rows: size.rows, cols: size.cols };
    const startedAt = this.clock();
    const plan = this.build();
    // The render-profile pane's series: the cost of the build just made and the
    // window it produced — measured here, where the build really happens.
    this.recordFrame(plan, this.clock() - startedAt);
    this.lastPlan = plan;
    if (this.a11y !== null) this.a11y.emit();
    // The file list's window is reconciled by the plan against the pane height IT
    // laid out; the app adopts the answer so the two never disagree about where the
    // list is scrolled. No rebuild: the window does not change the rows just emitted.
    const sidebar = sidebarOf(plan);
    if (sidebar !== null) this.sidebarState.scroll = sidebar.scroll;
    const editor = editorOf(plan);
    if (editor === null) return plan;
    // A wheel scroll detaches the view from the caret; every other intent re-attaches.
    if (!this.followCaret) return plan;
    const rows = editor.height - (editor.headerRows ?? 0);
    const row = displayCellOf(this.geometry(), this.caretModel.caret).row;
    if (row >= editor.firstRow && row <= editor.firstRow + rows - 1) return plan;
    this.scrollOffset = Math.max(0, row < editor.firstRow ? row : row - (rows - 1));
    return this.build();
  }

  /** Open `text` as `path` in the ACTIVE buffer; a new buffer is {@link openBuffer}. */
  override load(text: string, path: string | null): void {
    this.editing = reopen(this.editing, text);
    this.caretModel.moveTo({ row: 0, col: 0 });
    this.scrollOffset = 0;
    this.buffers.path = path;
    this.followCaret = true;
  }

  /** Open a NEW buffer and make it active. */
  openBuffer(text = "", path: string | null = null): void {
    this.buffers.open(text, path);
  }

  /** Close the active buffer. The last buffer is emptied rather than removed. */
  closeBuffer(): void {
    this.buffers.close();
  }

  /** Make buffer `index` active, clamped into range. */
  selectBuffer(index: number): void {
    this.buffers.select(index);
  }

  /** The effects the app queued, oldest first, and drains. */
  takeEffects(): PendingEffect[] {
    return this.effects.splice(0, this.effects.length);
  }

  /** Run one command and reduce what it asked for — the keymap's entry point.
   * Returns the intent, so a test can assert what the key MEANT. */
  override run(
    id: CommandId,
    key: KeyEvent = IDLE_KEY,
    pointer: PointerContext | null = null,
    paste: string | null = null,
  ): Intent | null {
    const intent = applyCommand(id, this.context(key, pointer, paste));
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
    return dispatchKey(this, this.keys, event);
  }
}
