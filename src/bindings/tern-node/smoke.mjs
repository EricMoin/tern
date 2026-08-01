// tern-node smoke test.
//
// Deno-first: loads the napi addon through `node:module` createRequire (Deno
// 2.x supports Node-API addons with --allow-all / --allow-ffi). If Deno
// cannot load the addon, the smoke falls back to running under `node` and
// reports that limitation clearly.
//
// The smoke asserts the addon surface, builds a tiny scene (rounded box with
// padding around a text leaf), renders it, then polls for a quit key ('q').
// Under the PTY harness (`printf 'q' | script -q /dev/null deno run
// --allow-all smoke.mjs`) the piped 'q' is delivered as a key event and the
// smoke exits 0. Ctrl+C with exit_on_ctrl_c also ends the loop cleanly.

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const isDeno = typeof Deno !== "undefined";

/** Load the addon: the napi-generated loader first, then the raw .node. */
function loadBinding() {
  const candidates = [
    "./index.js",
    `./tern-node.${process.platform}-${process.arch}.node`,
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error("could not load tern-node addon:\n" + errors.join("\n"));
}

let tern;
try {
  tern = loadBinding();
} catch (err) {
  if (isDeno) {
    console.error("[tern-node smoke] Deno failed to load the Node-API addon:");
    console.error(err.message);
    console.error(
      "[tern-node smoke] Limitation: falling back to `node` for this smoke run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = require("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error(err.message);
  process.exit(1);
}

// --- Surface assertions -----------------------------------------------------

if (typeof tern.TuiRenderer !== "function") {
  console.error(`FAIL: typeof TuiRenderer = ${typeof tern.TuiRenderer}`);
  process.exit(1);
}
console.log("ok: typeof TuiRenderer === 'function'");

// --- Scene construction (create_node / NodeHandle) --------------------------

const renderer = new tern.TuiRenderer({ exit_on_ctrl_c: true });
const root = renderer.root();

const box = tern.create_node("box", {
  border_style: "rounded",
  padding: 1,
  flex_direction: "column",
  width: 24,
  height: 5,
});
const hello = tern.create_node("text", { text: "Hello, tern!" });
const hint = tern.create_node("text", { text: "Press q to quit" });
// Parent-first: a detached template must be materialized into the scene
// (here: under the root) before it can hold children.
root.add_child(box);
box.add_child(hello);
box.add_child(hint);

renderer.render();

// --- Event loop: quit on 'q', or on auto-destroy (ctrl+c) --------------------

let quit = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  let events;
  try {
    events = renderer.poll_events(50);
  } catch (err) {
    // The renderer was destroyed inside poll_events (ctrl+c with
    // exit_on_ctrl_c) — that is a clean quit.
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
