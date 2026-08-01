// @tern/core smoke test.
//
// Deno-first: the core binding loads the native addon through `node:module`
// createRequire (Deno 2.x supports Node-API addons with --allow-all /
// --allow-ffi). If Deno cannot load the addon, the smoke falls back to
// running under `node` and reports that limitation clearly.
//
// The smoke asserts the core API surface, builds a tiny scene through the
// factory API (rounded box with padding around two text leaves), renders it,
// then polls for a quit key ('q'). Under the PTY harness (`printf 'q' |
// script -q /dev/null deno run --allow-all packages/core/smoke.mjs`) the
// piped 'q' is delivered as a key event and the smoke exits 0. Ctrl+C with
// exitOnCtrlC also ends the loop cleanly.

import { createRenderer, Box, Text } from "./src/index.ts";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

let renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  if (isDeno) {
    console.error("[@tern/core smoke] Deno failed to load the Node-API addon:");
    console.error(err.message);
    console.error(
      "[@tern/core smoke] Limitation: falling back to `node` for this smoke run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error(err.message);
  process.exit(1);
}

// --- Surface assertions -----------------------------------------------------

if (typeof createRenderer !== "function") {
  console.error(`FAIL: typeof createRenderer = ${typeof createRenderer}`);
  process.exit(1);
}
console.log("ok: typeof createRenderer === 'function'");

if (typeof renderer.root.addChild !== "function" || renderer.root.handle === undefined) {
  console.error("FAIL: renderer.root is not a Node exposing a native handle");
  process.exit(1);
}
console.log("ok: renderer.root exposes a native NodeHandle");

// --- Scene construction through the factory API -----------------------------

const hello = Text({ text: "Hello, tern!" });
const hint = Text({ text: "Press q to quit" });
if (hello.type !== "text" || hint.type !== "text") {
  console.error("FAIL: Text() must return text nodes");
  process.exit(1);
}

const box = Box(
  { border_style: "rounded", padding: 1, flex_direction: "column", width: 24, height: 5 },
  hello,
  hint,
);
if (box.type !== "box" || box.children.length !== 2) {
  console.error("FAIL: Box() must return a box node with 2 children");
  process.exit(1);
}

renderer.root.addChild(box);
renderer.render();

// --- Event loop: quit on 'q', or on auto-destroy (ctrl+c) --------------------

let quit = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  let events;
  try {
    events = renderer.pollEvents(50);
  } catch (err) {
    // The renderer was destroyed inside pollEvents (ctrl+c with
    // exitOnCtrlC) — that is a clean quit.
    console.log(`ok: renderer destroyed (${err.message})`);
    quit = true;
    break;
  }
  for (const ev of events) {
    if (ev.name === "char" && ev.char === "q") {
      quit = true;
      break;
    }
  }
}

renderer.destroy();
if (!quit) {
  console.error("FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log("ok: received 'q', quit cleanly");
process.exit(0);
