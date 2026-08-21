// tern-node runtime smoke — the M4.3 CI matrix platform gate.
//
// Node-only, dependency-free, and terminal-free: pure `node:module`
// createRequire + `node:process` (no runtime globals beyond standard node),
// so it runs unmodified on node:alpine (musl), FreeBSD node, and Windows
// arm64 node. It drives only the stable, release-locked API surface — the
// headless TuiRenderer, scene construction, render_to_buffer snapshots, and
// destroy — and never touches the M4.1 semantics napi surface.
//
// CI mounts this directory into a container and runs
//   node runtime-smoke.mjs
// with cwd = the mount. Exit 0 prints 'RUNTIME SMOKE PASSED'; any failed
// assertion or load failure prints a FAIL line and exits 1.

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

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

/** Fail-fast assertion: print a FAIL line and exit 1 when `ok` is false. */
function assert(ok, label) {
  if (ok) {
    console.log(`ok: ${label}`);
    return;
  }
  console.error(`FAIL: ${label}`);
  process.exit(1);
}

let tern;
try {
  tern = loadBinding();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// --- Surface gate -----------------------------------------------------------

assert(typeof tern.TuiRenderer === "function", "typeof TuiRenderer === 'function'");
assert(typeof tern.create_node === "function", "typeof create_node === 'function'");

// --- Headless renderer (virtual 80x24, never touches a terminal) ------------

const renderer = new tern.TuiRenderer({ headless: true, width: 80, height: 24 });
assert(typeof renderer.root === "function", "renderer exposes root()");
assert(typeof renderer.render_to_buffer === "function", "renderer exposes render_to_buffer()");
assert(typeof renderer.destroy === "function", "renderer exposes destroy()");

// --- Scene: rounded box + padding wrapping a text leaf, plus a stream -------

const root = renderer.root();

const box = tern.create_node("box", {
  border_style: "rounded",
  padding: 1,
  flex_direction: "column",
  width: 24,
  height: 5,
});
const leaf = tern.create_node("text", { text: "Hello, tern!" });
// Parent-first: a detached template materializes into the scene (here:
// under the root) before it can hold children.
root.add_child(box);
box.add_child(leaf);

const stream = tern.create_node("streaming_text", {});
root.add_child(stream);
stream.append_span("streaming: hello");

// --- Snapshot and assert ----------------------------------------------------

const rows = renderer.render_to_buffer(80, 24);
assert(Array.isArray(rows), "render_to_buffer returned an array");
assert(rows.length === 24, `render_to_buffer returned 24 rows (got ${rows.length})`);
assert(
  rows.every((row) => row.length === 80),
  "every row is exactly 80 columns",
);

// The box is the root's first child at the origin: 24x5 with a rounded
// border, so the frame corners sit at fixed cells.
assert(rows[0][0] === "┌", "top-left corner '┌' at row 0 col 0");
assert(rows[0][23] === "┐", "top-right corner '┐' at row 0 col 23");
assert(rows[4][0] === "└", "bottom-left corner '└' at row 4 col 0");
assert(rows[4][23] === "┘", "bottom-right corner '┘' at row 4 col 23");
assert(
  rows.some((row) => row.includes("Hello, tern!")),
  "text leaf content painted into a buffer row",
);
assert(
  rows.some((row) => row.includes("streaming: hello")),
  "streaming_text span painted into a buffer row",
);

// --- Teardown ---------------------------------------------------------------

renderer.destroy();
assert(renderer.destroyed === true, "renderer destroyed");
console.log("RUNTIME SMOKE PASSED");
process.exit(0);
