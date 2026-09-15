//! Layer A's runnable entry point — the real terminal UI.
//!
//!   deno run --allow-all packages/showcase/src/layers/core/main.ts [path]
//!
//! (`--allow-all` is the repo's own precedent for launching a TUI — the native
//! Node-API addon needs `--allow-ffi`, the size probe and the file list need the
//! terminal and the working directory. See README.md:316.)
//!
//! It builds ONE `HeadlessApp` (the same class every fixture drives), ONE
//! `Renderer`, and wires them with `attachInput`; every frame is
//! `HeadlessApp.plan()` mounted by `mountPlan` and painted by the real compositor.
//! No layout lives here: this file only moves a plan to the screen and the screen's
//! events back into the dispatcher.
//!
//! The first vertical slice, reachable with the keys `core/commands.ts` binds:
//! open a file (`ctrl+o` re-reads the path it was launched with), edit (typing,
//! arrows, selection), scroll (the caret's own motions — the plan windows the
//! document around it), save (`ctrl+s`) and quit (`ctrl+q`).
//!
//! The sidebar lists the launched file's directory (or the working directory) and is
//! navigated with `alt+up` / `alt+down`; `ctrl+b` hides it. That listing is a HOST
//! convenience — the app-core takes the list as data (`AppOptions.items`) and never
//! reads a directory itself.

import { createRenderer, type Node, type Renderer } from "@tern-tui/core";
import { Buffer } from "../../core/buffer.ts";
import { HeadlessApp } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import { attachInput } from "./input.ts";
import { denoHost, type HostIO } from "./io.ts";
import { mountPlan } from "./mount.ts";

/** The directory the file list shows for `path`: the file's own directory, or the
 * working directory for an unnamed document. */
export function listDir(path: string | null): string {
  if (path === null) return Deno.cwd();
  const at = path.lastIndexOf("/");
  return at <= 0 ? (at === 0 ? "/" : Deno.cwd()) : path.slice(0, at);
}

/** The document a launch starts from: the file named on the command line, or an
 * empty unnamed buffer. A path that cannot be read is reported and left unnamed
 * rather than silently swallowed — an empty buffer in place of an unreadable file
 * is data loss wearing an empty document's clothes (core/fs.ts:16-27). */
export async function initial(path: string | null, io: HostIO): Promise<{ text: string; path: string | null }> {
  if (path === null) return { text: "", path: null };
  try {
    return { text: await io.fs.readFile(path), path };
  } catch (error) {
    console.error("could not open " + path + " — " + String(error));
    return { text: "", path: null };
  }
}

/** The app, the renderer and the frame loop — everything but the process, so a host
 * owns the terminal's lifetime and a test could drive the same wiring. */
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
  let size: ViewportSize = { rows: renderer.size.height, cols: renderer.size.width };
  let mounted: Node | null = null;

  const frame = (next?: ViewportSize): void => {
    if (next !== undefined) size = next;
    const plan = app.plan(size);
    if (mounted !== null) mounted.remove();
    mounted = renderer.root.addChild(mountPlan(plan));
    const cursor = plan.cursor;
    if (cursor === null || !cursor.visible) renderer.clearCursor();
    else renderer.setCursor({ x: cursor.col, y: cursor.row, shape: "bar", visible: true, blink: true });
    renderer.setTitle((app.path ?? "[No Name]") + " — tern showcase");
    renderer.render();
  };

  attachInput(app, renderer, io, frame);
  return { app, frame };
}

if (import.meta.main) {
  const renderer = createRenderer({
    exitOnCtrlC: false,
    useAltScreen: true,
    title: "tern showcase — core layer",
  });
  const io = denoHost(() => {
    renderer.destroy();
    Deno.exit(0);
  });
  const { frame } = await launch(renderer, io, Deno.args[0] ?? null);
  // The scene is mounted before the stream starts, so the first keystroke lands on
  // a painted screen rather than racing the first frame (renderer.ts:38-42).
  frame();
  renderer.startEventStream();
}
