//! Layer A's event source: the renderer's events into the SAME HeadlessApp dispatcher.
//!
//! The layer owns no key meaning and no focus routing. A key event goes to
//! `HeadlessApp.dispatch` untouched — the same entry point `core/keymap.ts:79` gives
//! the fixtures (`driveApp`, goldens/fixture.ts:99) — so the screen the fixtures pin
//! and the screen a user reaches are one code path, and a layer cannot grow a
//! private shortcut that the plan never sees (src/index.ts:21-28).
//!
//! EFFECTS ARE THE HOST'S JOB. The core never touches a file: a save, an open and a
//! quit are `PendingEffect` requests the layer drains (core/state.ts:38-43), which is
//! why the app can be driven headlessly with no permissions at all. The drain is
//! serialized through one promise chain, so a burst of keystrokes cannot interleave
//! two file operations.
//!
//! MOUSE AND PASTE GO THE SAME WAY, AND THIS FILE DECIDES NOTHING ABOUT THEM. A
//! pointer event is translated into the app's own `PointerEvent` — the SCREEN CELL the
//! framework reported, and nothing else ({@link pointerEventOf}) — and a paste into a
//! `PasteEvent`; both enter at `HeadlessApp.dispatch`, the same route the keys take.
//! Which pane a cell is in, which document slot it names, whether a wheel scrolls: all
//! of that is the app-core's decision, made against the plan (core/state.ts). A layer
//! that mapped a cell to a caret position, or a wheel event to a scroll offset, would
//! be inventing meaning in the renderer — which is what this seam exists to prevent.
//!
//! THE DOUBLE-CLICK CLOCK IS STILL THE LAYER'S. The app models `double-click` as an
//! event (core/commands.ts) because whether two presses are one is a fact about the
//! CLOCK the layer saw, not about the document; wiring that clock is renderer work
//! left to the layer subtask, so this source forwards presses, drags and wheels.

import type { MouseEventJs, Renderer } from "@tern-tui/core";
import type { PointerEvent } from "../../core/commands.ts";
import type { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { applyEffect, type HostIO } from "./io.ts";

/**
 * The framework's mouse event as the app's own pointer event, or `null` for an event
 * the app does not model (a release, a plain move, a horizontal wheel — the app has no
 * horizontal scroll).
 *
 * THE CELL IS ALL THAT IS TRANSLATED. The framework reports `column` / `row` and a
 * kind (packages/core/src/mouse.ts:39-89 names the same vocabulary); what the cell
 * MEANS is decided by the command table (core/commands.ts) and applied against the
 * plan (core/state.ts), never here.
 */
export function pointerEventOf(event: MouseEventJs): PointerEvent | null {
  const cell = { row: event.row, col: event.column };
  switch (event.kind) {
    case "down_left": return { kind: "press", cell };
    case "drag_left": return { kind: "drag", cell };
    case "scroll_up": return { kind: "wheel-up", cell };
    case "scroll_down": return { kind: "wheel-down", cell };
    default: return null;
  }
}

/** Repaint at `size`, or at the size the app already knows when omitted. */
export type FrameSink = (size?: ViewportSize) => void;

/**
 * Wire `renderer`'s events to `app`, and the app's effects to `io`.
 *
 * Returns the detach function: every handler registered here is unregistered, so a
 * host that swaps layers does not leave a live key route behind.
 */
export function attachInput(
  app: HeadlessApp,
  renderer: Renderer,
  io: HostIO,
  frame: FrameSink,
): () => void {
  let queue: Promise<void> = Promise.resolve();

  /** Drain the app's effects, then repaint — one at a time, in request order. */
  const settle = (): Promise<void> => {
    queue = queue.then(async () => {
      for (const effect of app.takeEffects()) {
        if (!await applyEffect(app, effect, io)) return;
      }
      frame();
    });
    return queue;
  };

  const offKey = renderer.onKey((event) => {
    app.dispatch(event);
    void settle();
  });
  const offMouse = renderer.onMouse((event) => {
    const pointer = pointerEventOf(event);
    if (pointer === null) return;
    app.dispatch(pointer);
    void settle();
  });
  const offResize = renderer.onResize((event) => {
    frame({ rows: event.height, cols: event.width });
  });

  return () => {
    offKey();
    offMouse();
    offResize();
  };
}
