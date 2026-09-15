//! The headless app's shared state slots and the projections its reducers read.
//
// WHY THIS IS NOT IN state.ts. The state machine's slots (the open buffers, the
// overlay, the file list, the size, the pane state) and the three projections built
// from them (source, build, context) are the floor every reducer stands on.
// state.ts keeps the public surface; state-panes.ts keeps the auxiliary-pane
// reducer; state-reducers.ts keeps the intent reducer. The contracts are untouched:
// nothing here builds a scene, and plan.ts is still the ONE decision point.
//
// The state is a pure function of (initial state, intent sequence): replay the same
// intents and the same ScreenPlan comes out, with no napi addon and no PTY.

import { Keymap, type A11yStream, type KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import { BufferSet } from "./buffers.ts";
import type { CommandContext, CommandId, Intent } from "./commands.ts";
import type { EditingState } from "./edits.ts";
import type { PointerContext } from "./events.ts";
import type { MotionContext } from "./motions.ts";
import { OverlayState } from "./overlay.ts";
import { newPaneState, type PaneState } from "./panes.ts";
import { appContext, buildAppPlan, type PlanSource } from "./app-plan.ts";
import type { PlanFocus, ScreenPlan } from "./plan.ts";
import { newSidebar, sidebarLabels, type SidebarState } from "./sidebar-pane.ts";
import type { ViewportSize } from "./viewport.ts";

/** The screen an app with no host yet reports. */
const DEFAULT_SIZE: ViewportSize = { rows: 24, cols: 80 };

/** The event a programmatic run carries: no name, no character, no modifiers. */
export const IDLE_KEY: KeyEvent = { name: "", ctrl: false, alt: false, shift: false };

/** The frame clock the render-profile pane samples when the host injects none. */
const defaultClock: () => number = typeof performance !== "undefined" && typeof performance.now === "function"
  ? () => performance.now()
  : () => Date.now();

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
  /** The external text the host already read, shown by the diff pane. The core
   * never reads a file: the host hands the text over and a command shows it. */
  external?: string;
  /** The frame clock the render-profile pane samples. Defaults to
   * `performance.now`; a test injects a deterministic sequence so a recorded
   * profile buffer is stable while still measuring real elapsed ticks. */
  clock?: () => number;
}

/**
 * The app's shared state slots and the projections its reducers read.
 *
 * The slots are PROTECTED, not private, because the app is ONE class split across
 * four modules: state-panes.ts and state-reducers.ts extend this class and state.ts
 * extends them, so every reducer and the public surface read the same slots. A
 * consumer outside the hierarchy still only sees the getters state.ts publishes.
 */
export abstract class AppCore {
  protected buffers: BufferSet;
  protected overlay = new OverlayState();
  protected focusPane: PlanFocus = "editor";
  protected sidebarState: SidebarState;
  protected size: ViewportSize;
  protected wrapOn = true;
  protected gutterOn = false;
  protected effects: PendingEffect[] = [];
  protected keys: Keymap = new Keymap();
  protected paneState: PaneState = newPaneState();
  protected clock: () => number;
  protected lastPlan: ScreenPlan | null = null;
  protected a11y: A11yStream | null = null;
  /** Whether a split drag is in flight (started on the gutter, ended by a press
   * anywhere else). The pointer vocabulary has no release event, so the next press
   * is what ends it. */
  protected panelDrag = false;

  constructor(options: AppOptions = {}) {
    this.buffers = new BufferSet(options.buffer ?? new Buffer(), options.path ?? null, options.historyCap);
    this.size = { ...(options.size ?? DEFAULT_SIZE) };
    this.sidebarState = newSidebar(options);
    this.paneState.external = options.external ?? null;
    this.clock = options.clock ?? defaultClock;
  }

  // The active buffer's slots, through the set's accessors, so every reducer below
  // reads one buffer and many buffers the same way.

  protected get editing(): EditingState { return this.buffers.editing; }
  protected set editing(value: EditingState) { this.buffers.editing = value; }
  protected get caretModel() { return this.buffers.caret; }
  protected get scrollOffset(): number { return this.buffers.scroll; }
  protected set scrollOffset(value: number) { this.buffers.scroll = value; }
  protected get followCaret(): boolean { return this.buffers.followCaret; }
  protected set followCaret(value: boolean) { this.buffers.followCaret = value; }
  protected get bufferPath(): string | null { return this.buffers.path; }
  protected set bufferPath(value: string | null) { this.buffers.path = value; }

  /** The public surface's entry points, implemented by the final class. */
  protected abstract run(id: CommandId, key: KeyEvent): Intent | null;
  protected abstract load(text: string, path: string | null): void;

  /** Everything the plan and a command context are assembled from. */
  protected source(): PlanSource {
    const sidebar = this.sidebarState;
    return {
      editing: this.editing,
      caret: this.caretModel.caret,
      selection: this.buffers.selection,
      scroll: this.scrollOffset,
      size: this.size,
      focus: this.focusPane,
      modal: this.overlay.modal,
      path: this.bufferPath,
      wrap: this.wrapOn,
      gutter: this.gutterOn,
      sidebarVisible: sidebar.visible,
      sidebarItems: sidebarLabels(sidebar),
      sidebarWidth: sidebar.width,
      sidebarActive: sidebar.active,
      sidebarScroll: sidebar.scroll,
      tabs: this.buffers.tabs(),
      overlay: this.overlay,
      keymap: this.keys,
      panes: this.paneState,
      files: sidebar.items,
    };
  }

  /** The plan for the current state and size. */
  protected build(): ScreenPlan {
    return buildAppPlan(this.source());
  }

  /** The document plus its row geometry — what a motion resolves against. */
  protected geometry(): MotionContext {
    return { buffer: this.editing.buffer, index: this.editing.index, cache: this.editing.cache };
  }

  /** Everything a command may read, plus the event that triggered it. */
  protected context(key: KeyEvent, pointer: PointerContext | null = null, paste: string | null = null): CommandContext {
    return appContext(this.source(), key, pointer, paste);
  }
}
