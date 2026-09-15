//! Layer B's runnable entry point — the real terminal UI, through React.
//!
//!   deno run --allow-all packages/showcase/src/layers/react/main.ts [path]
//!
//! (`--allow-all` is the repo's own precedent for launching a TUI — the native
//! Node-API addon needs `--allow-ffi`, the size probe and the file list need the
//! terminal and the working directory. See README.md:316.)
//!
//! It builds ONE `HeadlessApp` (the same class every fixture drives), ONE
//! `Renderer`, and mounts the layer's element tree through the framework's
//! `createRoot`. Every frame is `HeadlessApp.plan()` rendered by React and painted by
//! the real compositor. No layout lives here: this file moves a plan into the tree
//! and the tree's events back into the dispatcher (hooks.ts).
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
//! The one thing layer A declares that this layer cannot: the G2 virtual content of
//! a scroll view (`declareVirtualContent`, scrollview.ts:178) has no React entry
//! point (see App.ts's header). The plan windows the document itself, so the screen
//! is right; the declared geometry would only matter to scroll maths this layer's
//! views never run.

import { createElement } from "react";
import { createRenderer, type Renderer } from "@tern-tui/core";
import { createRoot } from "@tern-tui/react";
import { Buffer } from "../../core/buffer.ts";
import { NO_TITLE } from "../../core/plan.ts";
import { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { denoHost, type HostIO } from "../core/io.ts";
import { initial, listDir } from "../core/main.ts";
import { App } from "./App.ts";

/**
 * The app, the React root and the frame loop — everything but the process, so a host
 * owns the terminal's lifetime and a test could drive the same wiring.
 *
 * The frame is REBUILT per plan, exactly as layer A rebuilds its scene: React
 * reconciles the new element tree against the old one, and every commit paints
 * through `renderer.render()` (reconciler/hooks.ts:73-79). The cursor is set BEFORE
 * the commit so the paint that lands is the one the cursor belongs to.
 */
export async function launch(
  renderer: Renderer,
  io: HostIO,
  path: string | null,
): Promise<{ app: HeadlessApp; frame: () => void }> {
  const start = await initial(path, io);
  const app = new HeadlessApp({
    buffer: Buffer.fromString(start.text),
    path: start.path,
    items: io.list(listDir(start.path)),
    size: { rows: renderer.size.height, cols: renderer.size.width },
  });
  const root = createRoot(renderer);

  const frame = (next?: ViewportSize): void => {
    const size = next ?? { rows: renderer.size.height, cols: renderer.size.width };
    const plan = app.plan(size);
    const cursor = plan.cursor;
    if (cursor === null || !cursor.visible) renderer.clearCursor();
    else renderer.setCursor({ x: cursor.col, y: cursor.row, shape: "bar", visible: true, blink: true });
    renderer.setTitle((app.path ?? NO_TITLE) + " — tern showcase (react)");
    root.render(createElement(App, { app, io, plan, frame }));
  };

  return { app, frame };
}

if (import.meta.main) {
  const renderer = createRenderer({
    exitOnCtrlC: false,
    useAltScreen: true,
    title: "tern showcase — react layer",
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
