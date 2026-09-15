//! Layer C's framework primitives: the reactive wrapper that re-runs the emitter,
//! and the event source into the SAME HeadlessApp dispatcher.
//!
//! WHY THIS FILE EXISTS AT ALL. Solid has no hooks and no context: the two things
//! layer B gets from `@tern-tui/react` — a component that re-renders when its props
//! change, and a `useInput` that finds its renderer in the tree context — are
//! EXPLICIT here. `render` / `createComponent` / `createSignal` / `subscribeInput` /
//! `subscribePaste` / `subscribeResize` are the package's own primitives
//! (packages/solid/src/index.ts:568, :578, :1295, :1405, :1434) and this file is only
//! their wiring: it adds no layout, no key meaning and no second tree.
//!
//! THE MOUNT IS THE EMITTER, WIRED TO A SIGNAL. `mountPlanScene` mounts `App` — the
//! same root builder `App.planRoot` that `frame.ts`'s `withScene` mounts with a
//! constant plan — through `createComponent` and the framework's own `render`, and
//! passes the plan SIGNAL's getter as the component's `plan` prop. Nothing here
//! re-renders anything: the component runs once (`createComponent` is
//! `untrack(() => Comp(props))`, node_modules/solid-js/dist/solid.js:1274-1285) and
//! the plan is read later, inside the `createRenderEffect`s the renderer puts around
//! every prop (packages/solid/src/universal.ts:286-297). A plan write therefore
//! re-runs the emitter in place, and the tree `main.ts` paints and the tree `frame.ts`
//! reads back are the same one.
//!
//! `createSignal` IS IMPORTED FROM `solid-js` EXACTLY AS packages/solid/src/index.ts:88
//! IMPORTS IT, and that is why packages/showcase/deno.json carries the same
//! `solid-js` mapping the solid package carries: a bare `solid-js` specifier resolves
//! under the `deno` export condition to `dist/server.js` (node_modules/solid-js/
//! package.json "exports"), the build with NO reactive runtime, so a second resolution
//! path loads a second runtime and the signal this file writes is never tracked by the
//! effects `@tern-tui/solid` creates. Measured, before the mapping was added: the
//! effect ran once with the mount value and never re-ran after the write. See the
//! registry entry `fix-solid-bare-specifier-loads-server-build`.
//!
//! THE EVENT SOURCE OWNS NO KEY MEANING. A key event goes to `HeadlessApp.dispatch`
//! untouched — the same entry point `core/keymap.ts:79` gives the fixtures
//! (`driveApp`, goldens/fixture.ts:99) — so the screen the fixtures pin and the screen
//! a user reaches are one code path, and a layer cannot grow a private shortcut that
//! the plan never sees (src/index.ts:21-28). Effects are the host's job: a save, an
//! open and a quit are `PendingEffect` requests the layer drains (core/state.ts:38-43),
//! serialized through one promise chain so a burst of keystrokes cannot interleave two
//! file operations.
//!
//! A PASTE IS AN EVENT, AND ITS MEANING IS THE CORE'S — the same route layer B takes
//! (layers/react/hooks.ts): the handler hands the text over as a `PasteEvent`
//! (core/commands.ts) at `HeadlessApp.dispatch`, the SAME route the keys take, and the
//! command table turns it into an `insert` intent. The layer never splices the buffer
//! and never learns where the caret is.

// @deno-types="../../../../../node_modules/solid-js/types/index.d.ts"
import { createSignal } from "solid-js";
import {
  createComponent,
  render,
  subscribeInput,
  subscribePaste,
  subscribeResize,
} from "@tern-tui/solid";
import type { Node, Renderer } from "@tern-tui/core";
import type { ScreenPlan } from "../../core/plan.ts";
import type { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { applyEffect, type HostIO } from "../core/io.ts";
import { App } from "./App.ts";

/** Repaint at `size`, or at the size the app already knows when omitted. The same
 * shape layer A's and layer B's event sources take (layers/core/input.ts:29,
 * layers/react/hooks.ts:42) — the sink is the frame loop, and the layer never paints
 * anything itself. */
export type FrameSink = (size?: ViewportSize) => void;

/** The plan the tree is currently a function of, plus the write that replaces it. */
export interface PlanStore {
  /** Read the current plan (a tracked read inside the renderer's own effects). */
  readonly plan: () => ScreenPlan;
  /** Replace the plan, re-running the emitter on the next flush. */
  readonly setPlan: (plan: ScreenPlan) => void;
}

/**
 * A plan signal. `equals: false` because two frames of one document are two different
 * `ScreenPlan` objects even when they paint the same cells: the frame loop decides
 * when the emitter runs, and a structural comparison would be a second reading of the
 * plan the paint is about to do anyway.
 */
export function createPlanStore(initial: ScreenPlan): PlanStore {
  const [plan, setPlan] = createSignal<ScreenPlan>(initial, { equals: false });
  return { plan, setPlan };
}

/**
 * Mount layer C's scene under `host`, re-emitting whenever `source` changes.
 *
 * `render(code, host)` mounts the tree the thunk returns (packages/solid/src/
 * index.ts:568 -> the vendored universal renderer, universal.ts:302-309) inside the
 * framework's own `createRoot`, which is what owns the effects the tree installs. The
 * thunk is evaluated ONCE; the reactivity is the `plan` GETTER, read by the renderer's
 * per-prop effects later, each time the signal moves. The committed root node is
 * therefore stable across a plan write — re-propped and re-reconciled, never replaced
 * — and the returned disposer releases the root's effects. The host owns the scene.
 */
export function mountPlanScene(source: () => ScreenPlan, host: Node): () => void {
  return render(
    () =>
      createComponent(App, {
        get plan() {
          return source();
        },
      }),
    host,
  );
}

/**
 * Subscribe the layer to `renderer` and drain the app's effects.
 *
 * Every handler funnels through `settle`: the app's queued effects are applied one
 * at a time, in request order, and the frame is rebuilt once they are done — so a
 * save that fails leaves the document dirty and the mode line's `●` in place rather
 * than repainting a lie (io.ts:9-12).
 *
 * Returns the detach function: the three subscriptions are released together, so a
 * host that swaps layers does not leave a live key route behind.
 */
export function attachLayerInput(
  renderer: Renderer,
  app: HeadlessApp,
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

  const offKey = subscribeInput(renderer, (event) => {
    app.dispatch(event);
    void settle();
  });
  const offPaste = subscribePaste(renderer, (text) => {
    app.dispatch({ kind: "paste", text });
    void settle();
  });
  const offResize = subscribeResize(renderer, (event) => {
    frame({ rows: event.height, cols: event.width });
  });

  return () => {
    offKey();
    offPaste();
    offResize();
  };
}
