//! Layer B's event source: the framework's hooks into the SAME HeadlessApp
//! dispatcher.
//!
//! The layer owns no key meaning and no focus routing. A key event goes to
//! `HeadlessApp.dispatch` untouched — the same entry point `core/keymap.ts:79` gives
//! the fixtures (`driveApp`, goldens/fixture.ts:99) — so the screen the fixtures pin
//! and the screen a user reaches are one code path, and a layer cannot grow a
//! private shortcut that the plan never sees (src/index.ts:21-28).
//!
//! WHAT THE FRAMEWORK OWNS HERE. The subscriptions are `@tern-tui/react`'s own
//! `useInput` (reconciler/hooks.ts:179), `usePaste` (:210) and `useResize`
//! (packages/react/src/hooks.ts:219), not `renderer.onKey` called by hand: the hooks
//! are the documented React seam, they read their handler through a ref (so a
//! re-render never re-subscribes) and they tear the subscription down on unmount.
//! `useResize` additionally repaints after its handler — the compositor re-lays out
//! at the new size, and this layer's handler rebuilds the plan for it.
//!
//! EFFECTS ARE THE HOST'S JOB. The core never touches a file: a save, an open and a
//! quit are `PendingEffect` requests the layer drains (core/state.ts:38-43), which
//! is why the app can be driven headlessly with no permissions at all. The drain is
//! serialized through one promise chain, so a burst of keystrokes cannot interleave
//! two file operations.
//!
//! A PASTE IS AN EVENT, AND ITS MEANING IS THE CORE'S. The hook hands the text over
//! as a `PasteEvent` (core/commands.ts) at `HeadlessApp.dispatch`, the SAME route the
//! keys take; the command table turns it into an `insert` intent, so a paste lands at
//! the caret, replaces a selection and is one undo step exactly as typing is. The
//! layer never splices the buffer, never learns where the caret is and cannot drift
//! from what `ctrl+v`-style typing would do. No key gains a meaning here.

import { useCallback, useRef } from "react";
import { useInput, usePaste, useResize } from "@tern-tui/react";
import type { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { applyEffect, type HostIO } from "../core/io.ts";

/** Repaint at `size`, or at the size the app already knows when omitted. The same
 * shape layer A's event source takes (layers/core/input.ts:30) — the sink is the
 * frame loop, and the layer never paints anything itself. */
export type FrameSink = (size?: ViewportSize) => void;

/**
 * Subscribe the mounted tree to the renderer, and drain the app's effects.
 *
 * Every handler funnels through `settle`: the app's queued effects are applied one
 * at a time, in request order, and the frame is rebuilt once they are done — so a
 * save that fails leaves the document dirty and the mode line's `●` in place rather
 * than repainting a lie (io.ts:9-12).
 */
export function useLayerInput(app: HeadlessApp, io: HostIO, frame: FrameSink): void {
  const queue = useRef<Promise<void>>(Promise.resolve());

  /** Drain the app's effects, then repaint — one at a time, in request order. */
  const settle = useCallback((): Promise<void> => {
    queue.current = queue.current.then(async () => {
      for (const effect of app.takeEffects()) {
        if (!await applyEffect(app, effect, io)) return;
      }
      frame();
    });
    return queue.current;
  }, [app, io, frame]);

  useInput((event) => {
    app.dispatch(event);
    void settle();
  });

  usePaste((text) => {
    app.dispatch({ kind: "paste", text });
    void settle();
  });

  useResize((event) => {
    frame({ rows: event.height, cols: event.width });
  });
}
