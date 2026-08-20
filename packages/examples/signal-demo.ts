/**
 * signal-demo — lifecycle signal smoke demo for the tern TUI engine.
 *
 * A minimal core-only scene (a rounded box holding two text leaves) that
 * stays alive on its push event loop and exercises the native signal-safe
 * lifecycle (roadmap M1.4):
 *
 * * Under `SIGTERM` the native signal thread tears the terminal down through
 *   the shared destroy-style teardown and exits with `128 + 15` = 143 — the
 *   demo itself never observes the signal (the native handler replaces the
 *   process's default), so the smoke harness asserts the exit code, the
 *   "rendered" marker proving the demo was live, and that the PTY's termios
 *   show no raw-mode residue.
 * * Under `SIGTSTP` the native thread restores the terminal, pushes a
 *   `{ type: "lifecycle", lifecycle: { phase: "suspend" } }` event, and
 *   re-raises SIGTSTP so the shell stops the process; under `SIGCONT` it
 *   re-enters raw mode + the alternate screen, invalidates the screen, and
 *   pushes a `"resume"` event. This demo's `onLifecycle` handler re-renders
 *   on `"resume"` (a full repaint — the retained frame was dropped) and
 *   prints a marker, so the smoke harness can assert the resume path end to
 *   end. The demo then quits on 'q' with exit 0.
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly. The smoke harness (`run-smoke.sh`) drives
 * this file under a macOS `script` PTY.
 */

import { Box, Text, createRenderer, type Renderer, type TernEventJs } from "@tern-tui/core";
import { unlinkSync, writeFileSync } from "node:fs";
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
    console.error("[signal-demo] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[signal-demo] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[signal-demo]", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

renderer.root.addChild(
  Box(
    {
      border_style: "rounded",
      padding: 1,
      flex_direction: "column",
      width: 48,
      height: 7,
    },
    Text({ text: "signal-demo" }),
    Text({ text: "suspend/resume lifecycle demo" }),
    Text({ text: "Press q to quit" }),
  ),
);
renderer.render();
renderer.startEventStream();

// The smoke harness runs the demo in the foreground of a PTY and drives the
// signal cases (SIGTERM / SIGTSTP / SIGCONT) from a background helper. The
// helper finds this process through the pidfile — the foreground demo has
// no shell job id the harness could address otherwise. Best-effort: without
// the pidfile the signal smoke cases cannot address this process, but the
// demo itself still runs (and quits on 'q').
const pidfile = "/tmp/tern-signal-demo.pid";
try {
  writeFileSync(pidfile, String(process.pid));
} catch {
  // Best-effort (see above).
}
process.on("exit", () => {
  try {
    unlinkSync(pidfile);
  } catch {
    // Already gone — fine.
  }
});

console.log("[signal-demo] ok: rendered (alive)");

// The lifecycle handler: on SIGCONT resume the terminal was re-entered and
// the screen invalidated, so the app must repaint. `renderer.render()` after
// the resume paints the full frame (the native side dropped the retained
// frame and size cache); the smoke harness asserts the marker below.
renderer.onLifecycle((lifecycle) => {
  if (lifecycle.phase === "resume") {
    renderer.render();
    console.log("[signal-demo] ok: resumed after SIGCONT + repainted");
  } else {
    console.log(`[signal-demo] ok: lifecycle ${lifecycle.phase}`);
  }
});

// ---------------------------------------------------------------------------
// Event loop: quit on 'q'
// ---------------------------------------------------------------------------

let quit = false;
// The smoke holds the demo through a TSTP/CONT window and only feeds 'q'
// afterwards, so the deadline is generous (30s) — a dead renderer fails the
// demo instead of hanging the harness forever.
const deadline = Date.now() + 30000;
const events = renderer.events[Symbol.asyncIterator]();
while (Date.now() < deadline && !quit) {
  if (renderer.destroyed) {
    quit = true;
    break;
  }
  const next = await Promise.race([
    events.next(),
    new Promise<IteratorResult<TernEventJs, undefined>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    ),
  ]);
  if (next.done) break; // stream closed (renderer destroyed) or deadline hit
  if (renderer.destroyed) {
    quit = true;
    break;
  }
  const event = next.value;
  if (event.type === "key" && event.key?.char === "q") {
    renderer.destroy();
    quit = true;
  }
}
if (renderer.destroyed) quit = true;
renderer.destroy();

if (!quit) {
  console.error("[signal-demo] FAIL: did not receive 'q' within 30s");
  process.exit(1);
}
console.log(`[signal-demo] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[signal-demo] ok: quit on 'q'");
process.exit(0);
