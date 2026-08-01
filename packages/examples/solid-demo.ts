/**
 * solid-demo — @tern/solid example scene for the tern TUI engine.
 *
 * Builds the same scene as react-demo — a flex-column `Box` with a rounded
 * border and 1-cell padding holding two `Text` leaves ("Hello Solid" /
 * "Press q to quit") — through the `@tern/solid` custom renderer, mounts it
 * with the renderer's universal `render()`, then runs an event loop that
 * quits on 'q' (via the core renderer's `onKey`; @tern/solid ships no input
 * hook yet in the MVP).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly. The smoke harness (`run-smoke.sh`) drives
 * this file under a macOS `script` PTY with 'q' piped in and asserts exit 0.
 */

import {
  createRenderer,
  type KeyEvent,
  type Node,
  type Renderer,
} from "@tern/core";
import { Box, Text, render as solidRender } from "@tern/solid";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[solid-demo] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[solid-demo] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[solid-demo]", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scene, built through the @tern/solid factories (createElement + spread)
// ---------------------------------------------------------------------------

const box = Box({
  border_style: "rounded",
  padding: 1,
  flex_direction: "column",
  width: 24,
  height: 5,
});
box.addChild(Text({ text: "Hello Solid" }));
box.addChild(Text({ text: "Press q to quit" }));

// Mount the scene through the solid renderer's universal `render()` (its
// insert path funnels into @tern/core `Node.addChild`). The returned
// disposer releases the solid root; for this static scene it is a no-op.
const dispose = solidRender(() => box, renderer.root);
renderer.render();

// ---------------------------------------------------------------------------
// Scene assertions (the PTY run only passes if the scene rendered)
// ---------------------------------------------------------------------------

const boxNode: Node | undefined = renderer.root.children[0];
const leaves: readonly Node[] = boxNode?.children ?? [];
const texts: Array<string | undefined> = leaves.map((leaf) => leaf.props.text);
const expectTexts = ["Hello Solid", "Press q to quit"];

const sceneOk =
  boxNode !== undefined &&
  boxNode.type === "box" &&
  leaves.length === 2 &&
  expectTexts.every((text, index) => texts[index] === text);

if (!sceneOk) {
  console.error("[solid-demo] FAIL: scene mismatch", JSON.stringify(texts));
  renderer.destroy();
  process.exit(1);
}
console.log(`[solid-demo] ok: scene has 2 text leaves: ${expectTexts.join(" / ")}`);

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (core onKey), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
renderer.onKey((event: KeyEvent) => {
  if (event.name === "char" && event.char === "q") quit = true;
});

const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  try {
    renderer.pollEvents(50);
  } catch {
    // The renderer was destroyed inside pollEvents (ctrl+c with
    // exitOnCtrlC) — a clean quit.
    quit = true;
    break;
  }
}
dispose?.();
renderer.destroy();

if (!quit) {
  console.error("[solid-demo] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[solid-demo] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[solid-demo] ok: rendered 'Hello Solid' and quit on 'q'");
process.exit(0);
