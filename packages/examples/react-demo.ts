/**
 * react-demo — @tern/react example scene for the tern TUI engine.
 *
 * Renders a flex-column `Box` with a rounded border and 1-cell padding
 * holding two `Text` leaves ("Hello React" / "Press q to quit") through the
 * `@tern/react` custom renderer (`render` + the `useApp` / `useInput`
 * hooks), then runs an event loop that quits when the user presses `q`
 * (`useInput` → `useApp().exit()`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly. The smoke harness (`run-smoke.sh`) drives
 * this file under a macOS `script` PTY with 'q' piped in and asserts exit 0.
 */

import { createElement } from "react";
import type { ReactElement } from "react";
import {
  createRenderer,
  type KeyEvent,
  type Node,
  type Renderer,
} from "@tern/core";
import { Box, Text, render, useApp, useInput } from "@tern/react";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * The demo scene: a box column with two text leaves. The input handler
 * quits the app (tears down raw mode + alternate screen) on 'q'.
 */
function App(): ReactElement {
  const { exit } = useApp();
  useInput((event: KeyEvent) => {
    if (event.name === "char" && event.char === "q") exit();
  });
  return createElement(
    Box,
    {
      border_style: "rounded",
      padding: 1,
      flex_direction: "column",
      width: 24,
      height: 5,
    },
    createElement(Text, { text: "Hello React" }),
    createElement(Text, { text: "Press q to quit" }),
  );
}

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[react-demo] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[react-demo] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[react-demo]", message);
  process.exit(1);
}

render(createElement(App), renderer);

// React schedules passive effects (useInput's key subscription) on the
// scheduler rather than flushing them synchronously, so give them a beat to
// register before the event loop starts — otherwise a 'q' that arrives
// before the subscription is active would be dropped.
await new Promise((resolve) => setTimeout(resolve, 100));

// ---------------------------------------------------------------------------
// Scene assertions (the PTY run only passes if the scene rendered)
// ---------------------------------------------------------------------------

const boxNode: Node | undefined = renderer.root.children[0];
const leaves: readonly Node[] = boxNode?.children ?? [];
const texts: Array<string | undefined> = leaves.map((leaf) => leaf.props.text);
const expectTexts = ["Hello React", "Press q to quit"];

const sceneOk =
  boxNode !== undefined &&
  boxNode.type === "box" &&
  leaves.length === 2 &&
  expectTexts.every((text, index) => texts[index] === text);

if (!sceneOk) {
  console.error("[react-demo] FAIL: scene mismatch", JSON.stringify(texts));
  renderer.destroy();
  process.exit(1);
}
console.log(`[react-demo] ok: scene has 2 text leaves: ${expectTexts.join(" / ")}`);

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (via useInput → exit()), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  if (renderer.destroyed) {
    // The 'q' handler's exit() destroyed the renderer — clean quit.
    quit = true;
    break;
  }
  try {
    renderer.pollEvents(50);
  } catch {
    // The renderer was destroyed inside pollEvents (ctrl+c with
    // exitOnCtrlC) — also a clean quit.
    quit = true;
    break;
  }
}
renderer.destroy();

if (!quit) {
  console.error("[react-demo] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[react-demo] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[react-demo] ok: rendered 'Hello React' and quit on 'q'");
process.exit(0);
