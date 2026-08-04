#!/usr/bin/env -S deno run --allow-ffi --allow-read --allow-env
/**
 * render.bench.ts — baseline render round-trip benchmark for the tern TUI
 * engine, JS side.
 *
 * Loads the real tern-node addon through `@tern/core`, builds the same
 * synthetic scene the Rust bench uses (see
 * `src/core/tern-components/tests/bench_timing.rs`), and times `N = 1000`
 * `renderer.render()` calls — paint + diff + terminal flush, the full
 * per-frame round trip — with a `Spinner` tick between each frame so the
 * scene animates (the diff is non-empty every frame, like a real app).
 *
 * Run from the repo root (a PTY is required for raw mode; the native addon
 * needs `--allow-ffi` plus read access to the `.node` binding, and the napi
 * loader reads env vars, hence `--allow-env`):
 *
 *   deno run --allow-ffi --allow-read --allow-env tools/bench/render.bench.ts
 *
 * When the addon cannot be loaded (or the terminal is unusable, e.g. no
 * PTY), the script prints an explicit SKIP message and exits 0, so the bench
 * is safe to run in headless CI. Baseline numbers are recorded in
 * `tools/bench/BASELINE.md`.
 */

import {
  Box,
  Spinner,
  StreamingText,
  Text,
  createRenderer,
  loadAddon,
  tick,
} from "@tern/core";
import type { Node } from "@tern/core";

/** The number of render round-trips to time. */
const N = 1000;
/** The synthetic scene's target viewport, mirroring the Rust bench. */
const VIEWPORT_W = 120;
const VIEWPORT_H = 40;
/** The number of nested boxes under the root box. */
const BOX_COUNT = 200;
/** The number of spans fed to the streaming_text node. */
const SPAN_COUNT = 50;

/** Print an explicit skip message and exit 0 (the headless/CI path). */
function skip(reason: unknown): never {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.log(`render.bench: SKIP — ${msg}`);
  console.log(
    "render.bench: the tern-node addon could not be loaded (or the terminal is unusable); no baseline recorded.",
  );
  Deno.exit(0);
}

/**
 * Build the synthetic scene under `renderer.root`: a root box (column flex,
 * 120x40) holding an animated indeterminate spinner, ~200 nested boxes each
 * with 3-5 text leaves, one `streaming_text` node with 50 styled spans, and
 * one text leaf carrying a `caret` prop — mirroring `bench_timing.rs`.
 *
 * The spinner sits first so its changing glyph is visible inside the
 * viewport; `tick(spinner)` between renders keeps the frame diff non-empty.
 */
function buildScene(renderer: ReturnType<typeof createRenderer>): Node {
  const rootBox = Box({
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    flex_direction: "column",
  });

  const spinner = Spinner({});
  rootBox.addChild(spinner);

  for (let i = 0; i < BOX_COUNT; i++) {
    const leaves: Node[] = [];
    const count = 3 + (i % 3);
    for (let j = 0; j < count; j++) {
      leaves.push(
        Text({
          text: `cell ${i}-${j} 0123456789`,
          fg: `#${((j * 7 + 3) % 256).toString(16).padStart(2, "0")}7f00`,
        }),
      );
    }
    rootBox.addChild(Box({ width: VIEWPORT_W - 2, height: 1 }, ...leaves));
  }

  const stream = StreamingText({ width: VIEWPORT_W - 2 });
  for (let s = 0; s < SPAN_COUNT; s++) {
    stream.appendSpan(`span${s} `, s % 2 === 0 ? { fg: "#00ff88" } : { fg: "#ff8800" });
  }
  rootBox.addChild(stream);

  rootBox.addChild(Text({ text: "input value", caret: 4 }));

  renderer.root.addChild(rootBox);
  return spinner;
}

/** The nearest-rank percentile of a sorted sample: `p` in 0..=100. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function main(): void {
  // 1. Load the addon; the whole bench is skipped (exit 0) when it is
  //    unavailable — e.g. the .node binding was not built for this platform.
  try {
    loadAddon();
  } catch (err) {
    skip(err);
  }

  // 2. Construct the renderer (raw mode + alternate screen); a non-PTY
  //    environment fails here and takes the same explicit skip path.
  let renderer: ReturnType<typeof createRenderer>;
  try {
    renderer = createRenderer({ title: "tern render.bench" });
  } catch (err) {
    skip(err);
  }

  try {
    // 3. Build the synthetic scene and time N render round-trips, ticking
    //    the spinner between frames so each render paints a changed frame.
    const spinner = buildScene(renderer);
    const perFrameMs: number[] = new Array(N);
    const started = performance.now();
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      renderer.render();
      perFrameMs[i] = performance.now() - t0;
      tick(spinner);
    }
    const totalMs = performance.now() - started;

    // 4. Report mean / p50 round-trip time and fps.
    const sorted = [...perFrameMs].sort((a, b) => a - b);
    const mean = totalMs / N;
    const p50 = percentile(sorted, 50);
    const fps = 1000 / mean;

    console.log(`render.bench: ${N} render() round-trips @ ${VIEWPORT_W}x${VIEWPORT_H} synthetic scene`);
    console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
    console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
    console.log(`  fps:  ${fps.toFixed(1)}`);
  } finally {
    try {
      renderer.destroy();
    } catch {
      // Already torn down; nothing to restore.
    }
  }
}

main();
