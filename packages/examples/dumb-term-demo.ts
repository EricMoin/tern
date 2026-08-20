/**
 * dumb-term-demo — TERM=dumb degradation smoke demo for the tern TUI engine.
 *
 * Exercises the roadmap M1.5 degradation path: `createRenderer({})`
 * (non-headless, default options) must refuse to construct when the
 * terminal is not interactive. Under `TERM=dumb` — or a non-TTY stdout —
 * the native constructor errors with "tern requires an interactive terminal
 * (TERM=dumb or non-TTY)" BEFORE any terminal I/O: no raw mode, no escape
 * sequences, nothing left behind.
 *
 * The demo calls `createRenderer({})` and CATCHES the constructor throw:
 *
 * * on the expected error it prints the message and exits 0 — the guard
 *   worked, and because it fired before any terminal I/O, the demo never
 *   writes an ESC byte (the smoke harness additionally asserts the captured
 *   output contains none);
 * * on success (the guard did NOT fire — a regression) it destroys the
 *   renderer and exits 1.
 *
 * The demo never renders, never starts the event stream, and only writes
 * marker text to stdout, so it cannot produce terminal control sequences.
 *
 * Runtime: Deno-first per the project preference (mirrors signal-demo.ts).
 * The demo prefers `deno run --allow-all`; if Deno cannot load the native
 * Node-API addon (see @tern-tui/core `loadAddon`), the demo re-runs itself
 * under `node` and reports the limitation clearly. The smoke harness
 * (`run-smoke.sh`) drives this file under a macOS `script` PTY with
 * `TERM=dumb` set.
 */

import { createRenderer } from "@tern-tui/core";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// The degradation check: createRenderer({}) must refuse a non-interactive
// terminal. The constructor throw is the expected outcome.
// ---------------------------------------------------------------------------

let renderer: ReturnType<typeof createRenderer>;
try {
  renderer = createRenderer({});
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);

  // The guard fired (the addon loaded and the constructor refused the
  // terminal). Any other error under Deno is the addon-load limitation and
  // falls back to `node`, exactly like signal-demo.ts.
  if (message.includes("tern requires an interactive terminal")) {
    console.log(
      "[dumb-term-demo] ok: createRenderer refused the non-interactive terminal",
    );
    console.log(`[dumb-term-demo] message: ${message}`);
    console.log(`[dumb-term-demo] runtime: ${isDeno ? "deno" : "node"}`);
    process.exit(0);
  }

  if (isDeno) {
    console.error("[dumb-term-demo] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[dumb-term-demo] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }

  console.error("[dumb-term-demo] FAIL:", message);
  process.exit(1);
}

// The renderer constructed — the guard did NOT fire under TERM=dumb, which
// is the regression this demo exists to catch. Tear the terminal down
// (best-effort; the demo already failed) and exit 1.
console.error(
  "[dumb-term-demo] FAIL: createRenderer constructed on a non-interactive terminal",
);
try {
  renderer.destroy();
} catch {
  // Best-effort teardown (see above).
}
console.error(`[dumb-term-demo] runtime: ${isDeno ? "deno" : "node"}`);
process.exit(1);
