//! Layer C's runnable entry point — the real terminal UI, through Solid.
//!
//!   deno run --allow-all packages/showcase/src/layers/solid/main.ts [path]
//!
//! (`--allow-all` is the repo's own precedent for launching a TUI — the native
//! Node-API addon needs `--allow-ffi`, the size probe and the file list need the
//! terminal and the working directory. See README.md:316.)
//!
//! It builds ONE `HeadlessApp` (the same class every fixture drives), ONE
//! `Renderer`, mounts the layer's component under the renderer's root through the
//! framework's own `render`, and repaints by writing a new plan into the plan signal
//! (primitives.ts). Every frame is `HeadlessApp.plan()` rendered by Solid and painted
//! by the real compositor. No layout lives here: this file moves a plan into the tree
//! and the tree's events back into the dispatcher.
//!
//! The first vertical slice, reachable with the keys `core/commands.ts` binds: open
//! a file (`ctrl+o` re-reads the path it was launched with), edit (typing, arrows,
//! selection), scroll (the caret's own motions — the plan windows the document
//! around it), save (`ctrl+s`) and quit (`ctrl+q`).
//!
//! THE HOST SIDE IS LAYER A'S, DELIBERATELY. `io.ts` (effects, the Deno port, the
//! directory listing) and `main.ts`'s `initial`/`listDir` are renderer-independent
//! host policy: forking them per layer would be a second definition of what a save
//! and a launch MEAN, which is the drift this whole exercise exists to prevent. Only
//! the mount changes, and the mount is the layer.
//!
//! WHAT THIS LAYER DECLARES THAT LAYER B COULD NOT: both panes declare their whole
//! geometry through the G2 seam (`declareVirtualContent`, App.ts) and the mode line
//! is the framework's own `StatusBar` over scene-node segments — both reachable
//! because a solid factory RETURNS the scene node it built.

import { createRenderer, type Node, type Renderer } from "@tern-tui/core";
import { Buffer } from "../../core/buffer.ts";
import { NO_TITLE } from "../../core/plan.ts";
import { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { denoHost, type HostIO } from "../core/io.ts";
import { initial, listDir } from "../core/main.ts";
import { attachLayerInput, createPlanStore, mountPlanScene } from "./primitives.ts";

/** A launched layer: the app, the frame loop, and the teardown that releases the
 * scene and its three subscriptions. */
export interface LaunchedLayer {
  readonly app: HeadlessApp;
  readonly frame: (size?: ViewportSize) => void;
  readonly dispose: () => void;
}

/**
 * The app, the mounted scene and the frame loop — everything but the process, so a
 * host owns the terminal's lifetime and a test could drive the same wiring.
 *
 * The frame is REBUILT per plan, exactly as layer A rebuilds its scene and layer B
 * re-renders its tree: the plan signal write re-runs the emitter, and the framework's
 * own effects re-prop and re-reconcile the committed root (primitives.ts). The cursor
 * is set BEFORE the write so the paint that lands is the one the cursor belongs to.
 */
export async function launch(
  renderer: Renderer,
  io: HostIO,
  path: string | null,
): Promise<LaunchedLayer> {
  const start = await initial(path, io);
  const app = new HeadlessApp({
    buffer: Buffer.fromString(start.text),
    path: start.path,
    items: io.list(listDir(start.path)),
    size: { rows: renderer.size.height, cols: renderer.size.width },
  });
  let size: ViewportSize = { rows: renderer.size.height, cols: renderer.size.width };
  const store = createPlanStore(app.plan(size));
  const mounted: Node = renderer.root;
  const disposeScene = mountPlanScene(store.plan, mounted);

  const frame = (next?: ViewportSize): void => {
    if (next !== undefined) size = next;
    const plan = app.plan(size);
    const cursor = plan.cursor;
    if (cursor === null || !cursor.visible) renderer.clearCursor();
    else renderer.setCursor({ x: cursor.col, y: cursor.row, shape: "bar", visible: true, blink: true });
    renderer.setTitle((app.path ?? NO_TITLE) + " — tern showcase (solid)");
    store.setPlan(plan);
    renderer.render();
  };

  const detach = attachLayerInput(renderer, app, io, frame);
  return {
    app,
    frame,
    dispose: () => {
      detach();
      disposeScene();
    },
  };
}

if (import.meta.main) {
  const renderer = createRenderer({
    exitOnCtrlC: false,
    useAltScreen: true,
    title: "tern showcase — solid layer",
  });
  const io = denoHost(() => {
    renderer.destroy();
    Deno.exit(0);
  });
  const { frame } = await launch(renderer, io, Deno.args[0] ?? null);
  // The tree is mounted before the stream starts, so the first keystroke lands on a
  // painted screen rather than racing the first frame (renderer.ts:38-42).
  frame();
  renderer.startEventStream();
}
