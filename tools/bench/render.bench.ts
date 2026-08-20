#!/usr/bin/env -S deno run --allow-ffi --allow-read --allow-env
/**
 * render.bench.ts — render benchmarks for the tern TUI engine, JS side.
 *
 * Loads the real tern-node addon through `@tern-tui/core` and times seven
 * scenarios against the same synthetic scene (see
 * `src/core/tern-components/tests/bench_timing.rs` for the Rust twin), at the
 * real terminal size under a PTY:
 *
 *   scenario 0 — animated round-trip: N = 1000 `renderer.render()` calls
 *     (paint + diff + terminal flush) with a `Spinner` tick between frames so
 *     the diff is non-empty every frame. The canonical round-1 baseline
 *     scenario (every frame paints a changed scene).
 *   scenario 1 — no-change frames: N = 2000 consecutive `render()` calls with
 *     zero scene mutation. Exercises the scene-epoch idle fast path: the
 *     first call paints, the rest hit the native no-op fast path (epoch
 *     unchanged + viewport unchanged -> return without paint/diff/flush).
 *   scenario 2 — single-cell change frames: N = 1000 frames, each mutating
 *     exactly ONE cell (one text leaf's content cycles through a single
 *     digit) before `render()`. The future incremental-layout target scene:
 *     today the whole scene repaints, so this measures the per-frame cost an
 *     incremental layout would cut.
 *   scenario 3 — requestFrame burst: 200 rounds, each issuing BURST_SIZE =
 *     1000 `requestFrame()` calls within one tick (scene mutated first so the
 *     coalesced render paints a changed frame), then awaiting the coalesced
 *     frame. Verifies JS frame coalescing end to end: the burst wall time is
 *     compared against a single-`requestFrame` control — a ~1.0 ratio proves
 *     all 1000 calls collapsed into ONE native render (a broken coalescer
 *     would cost ~1000x the control).
 *   scenario 4 — viewport scroll: N = 500 frames, each panning the whole
 *     ~202-row content pane up by ONE row (`scroll_y` on the root box). The
 *     diff covers (nearly) the whole 4800-cell viewport and the mutated
 *     node's bounds span the viewport, so the dirty union trips the
 *     full-repaint threshold — the large-dirty path the one-cell scenarios
 *     never exercise (the perf.md round-3 caveat). Since M2.1 the frame
 *     flushes through the terminal-native scroll path when the diff is a
 *     clean one-row shift; the flushed bytes per frame (`last_flush_bytes`)
 *     quantify the OPTIMIZED stream.
 *   scenario 5 — alternating full screens: N = 500 frames, each flipping the
 *     visibility of two full-screen `streaming_text` leaves (40 rows of a
 *     repeated character each, so every cell differs), so the diff is the
 *     whole viewport every frame. Prints flushed-bytes per frame via the
 *     native `last_flush_bytes` counter (fed by the backend queue): the ANSI
 *     byte cost of a full-repaint frame, the seam the diff fast paths
 *     short-circuit.
 *
 * Run from the repo root (a PTY is required for raw mode; the native addon
 * needs `--allow-ffi` plus read access to the `.node` binding, and the napi
 * loader reads env vars, hence `--allow-env`):
 *
 *   deno run --allow-ffi --allow-read --allow-env tools/bench/render.bench.ts
 *
 * The PTY must be sized to the synthetic scene's 120x40 viewport — `run.sh`
 * wraps the invocation in `script` with `stty cols 120 rows 40`. Without a
 * real size (a headless shell's `script` PTY reports 0x0), the native
 * renderer treats the viewport as the "never painted" sentinel, which
 * disables the scene-epoch no-op fast path (scenario 1) and skews every
 * scenario's absolute numbers.
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
} from "@tern-tui/core";
import type { Node } from "@tern-tui/core";

/** The number of render round-trips to time (scenario 0). */
const N = 1000;
/** The number of consecutive no-change renders to time (scenario 1). */
const NO_CHANGE_N = 2000;
/** The number of single-cell-change frames to time (scenario 2). */
const SMALL_CHANGE_N = 1000;
/** The number of requestFrame rounds (scenario 3): one burst + one single
 * control per round. */
const BURST_ROUNDS = 200;
/** The number of requestFrame calls issued within one tick (scenario 3). */
const BURST_SIZE = 1000;
/** The number of one-row scroll frames to time (scenario 4). */
const SCROLL_N = 500;
/** The number of alternating full-screen frames to time (scenario 5). */
const FULLSCREEN_N = 500;
/** The scroll range scenario 4 cycles through: the synthetic scene has
 * ~204 content rows and a 40-row viewport, so any `scroll_y` in 0..=164
 * keeps every visible row filled; 160 is safely inside. */
const SCROLL_RANGE = 160;
/** The synthetic scene's target viewport, mirroring the Rust bench. */
const VIEWPORT_W = 120;
const VIEWPORT_H = 40;
/** The two full-screen states of scenario 5: 40 rows x 118 columns (the
 * content-pane width, matching the bench scene's `VIEWPORT_W - 2`) of a
 * single character, so every cell differs between the two screens. */
const SCREEN_A = Array.from({ length: VIEWPORT_H }, () => "A".repeat(VIEWPORT_W - 2)).join("\n");
const SCREEN_B = Array.from({ length: VIEWPORT_H }, () => "B".repeat(VIEWPORT_W - 2)).join("\n");
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
 * The first text leaf is returned too: scenario 2 mutates exactly one cell of
 * it per frame. The root box is returned so scenario 4 can pan its content
 * via `scroll_y` and scenario 5 can detach it before mounting the
 * alternating full-screen leaf.
 *
 * Returns `{ spinner, leaf, rootBox }`.
 */
function buildScene(renderer: ReturnType<typeof createRenderer>): {
  spinner: Node;
  leaf: Node;
  rootBox: Node;
} {
  const rootBox = Box({
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    flex_direction: "column",
  });

  const spinner = Spinner({});
  rootBox.addChild(spinner);

  let leaf: Node | null = null;
  for (let i = 0; i < BOX_COUNT; i++) {
    const leaves: Node[] = [];
    const count = 3 + (i % 3);
    for (let j = 0; j < count; j++) {
      const text = Text({
        text: `cell ${i}-${j} 0123456789`,
        fg: `#${((j * 7 + 3) % 256).toString(16).padStart(2, "0")}7f00`,
      });
      if (leaf === null) leaf = text;
      leaves.push(text);
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
  if (leaf === null) throw new Error("scene has no text leaf");
  return { spinner, leaf, rootBox };
}

/** The nearest-rank percentile of a sorted sample: `p` in 0..=100. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

/** Summarize a sample into `{ mean, p50, fps }` (fps = 1000 / mean). */
function summarize(samples: number[]): { mean: number; p50: number; fps: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
  return { mean, p50: percentile(sorted, 50), fps: 1000 / mean };
}

/**
 * Scenario 0 — animated round-trip. Times N `render()` calls with a spinner
 * tick between frames, so each frame paints a changed scene: the canonical
 * end-to-end per-frame cost (paint + diff + flush through the real addon and
 * terminal).
 */
function scenario0(
  renderer: ReturnType<typeof createRenderer>,
  spinner: Node,
): { mean: number; p50: number; fps: number } {
  const perFrameMs: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    renderer.render();
    perFrameMs[i] = performance.now() - t0;
    tick(spinner);
  }
  const { mean, p50, fps } = summarize(perFrameMs);
  console.log(`render.bench: scenario 0 — animated round-trip (${N} frames)`);
  console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
  console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
  console.log(`  fps:  ${fps.toFixed(1)}`);
  return { mean, p50, fps };
}

/**
 * Scenario 1 — no-change frames (scene-epoch idle fast path). The warmup
 * render paints the scene and records its epoch + viewport; every timed
 * render then sees an unchanged scene and exits through the native no-op fast
 * path (no paint, no diff, no terminal writes). The per-frame cost should be
 * orders of magnitude below a painted frame — the number the epoch fast path
 * buys.
 */
function scenario1(
  renderer: ReturnType<typeof createRenderer>,
  paintedMean: number,
): { mean: number; p50: number; fps: number } {
  renderer.render(); // warmup: paint once, record epoch + viewport
  const perFrameMs: number[] = new Array(NO_CHANGE_N);
  for (let i = 0; i < NO_CHANGE_N; i++) {
    const t0 = performance.now();
    renderer.render();
    perFrameMs[i] = performance.now() - t0;
  }
  const { mean, p50, fps } = summarize(perFrameMs);
  const speedup = mean > 0 ? (paintedMean / mean).toFixed(0) : "n/a";
  console.log(
    `render.bench: scenario 1 — no-change frames, epoch idle fast path (${NO_CHANGE_N} frames)`,
  );
  console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
  console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
  console.log(`  fps:  ${fps.toFixed(1)}`);
  console.log(`  no-op speedup vs a painted frame: ${speedup}x`);
  return { mean, p50, fps };
}

/**
 * Scenario 2 — single-cell change frames (the incremental-layout target). Per
 * frame exactly one cell changes: the first text leaf's content cycles a
 * single digit, keeping the string (and layout) the same width. Today the
 * whole scene repaints, so this is the per-frame cost incremental layout
 * would cut. The mutation itself stays outside the timer (it is app work,
 * like scenario 0's spinner tick); the timer covers only the render.
 */
function scenario2(
  renderer: ReturnType<typeof createRenderer>,
  leaf: Node,
): { mean: number; p50: number; fps: number } {
  const perFrameMs: number[] = new Array(SMALL_CHANGE_N);
  for (let i = 0; i < SMALL_CHANGE_N; i++) {
    // One cell changes: the trailing digit of `cell 0-0 <d> 0123456789`
    // cycles 0-9; string length (and thus layout) never changes.
    leaf.setProps({ ...leaf.props, text: `cell 0-0 ${i % 10} 0123456789` });
    const t0 = performance.now();
    renderer.render();
    perFrameMs[i] = performance.now() - t0;
  }
  const { mean, p50, fps } = summarize(perFrameMs);
  console.log(
    `render.bench: scenario 2 — single-cell change frames (${SMALL_CHANGE_N} frames)`,
  );
  console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
  console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
  console.log(`  fps:  ${fps.toFixed(1)}`);
  return { mean, p50, fps };
}

/** Time one coalesced frame: `requestFrame()` armed once, awaited. */
function singleFrame(renderer: ReturnType<typeof createRenderer>): Promise<number> {
  const t0 = performance.now();
  return new Promise<void>((resolve) => {
    renderer.requestFrame(resolve);
  }).then(() => performance.now() - t0);
}

/**
 * Time one burst: `burstSize` `requestFrame()` calls issued within one tick,
 * awaited via the first call's callback (which runs after the coalesced
 * native render). If coalescing works, all `burstSize` calls collapse into
 * ONE native render and the wall time matches {@link singleFrame}; if it
 * broke, the burst would cost ~`burstSize`x the control.
 */
function burstFrame(
  renderer: ReturnType<typeof createRenderer>,
  burstSize: number,
): Promise<number> {
  const t0 = performance.now();
  return new Promise<void>((resolve) => {
    renderer.requestFrame(resolve);
    for (let i = 1; i < burstSize; i++) renderer.requestFrame();
  }).then(() => performance.now() - t0);
}

/**
 * Scenario 3 — requestFrame burst coalescing. Each round ticks the spinner
 * first (bumping the scene epoch so the coalesced render paints a changed
 * frame — a no-op epoch render would not measure the render path), then
 * issues either a single `requestFrame` (control) or a burst of
 * `BURST_SIZE` within one tick. A burst/single ratio of ~1.0 proves the
 * whole burst collapsed into one native render.
 */
async function scenario3(
  renderer: ReturnType<typeof createRenderer>,
  spinner: Node,
): Promise<{ mean: number; p50: number; ratio: number; expected: number }> {
  const singleMs: number[] = new Array(BURST_ROUNDS);
  for (let r = 0; r < BURST_ROUNDS; r++) {
    tick(spinner);
    singleMs[r] = await singleFrame(renderer);
  }
  const burstMs: number[] = new Array(BURST_ROUNDS);
  for (let r = 0; r < BURST_ROUNDS; r++) {
    tick(spinner);
    burstMs[r] = await burstFrame(renderer, BURST_SIZE);
  }
  const single = summarize(singleMs);
  const burst = summarize(burstMs);
  const ratio = burst.mean / single.mean;
  const expected = Math.round(ratio);
  console.log(
    `render.bench: scenario 3 — requestFrame burst coalescing (${BURST_ROUNDS} rounds of ${BURST_SIZE} calls)`,
  );
  console.log(`  mean burst: ${burst.mean.toFixed(3)} ms (1 native render expected)`);
  console.log(`  p50 burst:  ${burst.p50.toFixed(3)} ms`);
  console.log(`  mean single: ${single.mean.toFixed(3)} ms (control)`);
  console.log(`  coalescing ratio: ${ratio.toFixed(2)} (burst / single, ~1.0 = coalesced)`);
  console.log(`  expected native renders per burst: ${expected}`);
  return { mean: burst.mean, p50: burst.p50, ratio, expected };
}

/**
 * Scenario 4 — viewport scroll (the large-dirty frame the one-cell scenarios
 * never exercise). Per frame the whole ~204-row content pane pans UP by ONE
 * row (`scroll_y` on the root box, cycling within `SCROLL_RANGE` so the
 * viewport never scrolls past the content tail), so the diff covers (nearly)
 * the whole 4800-cell viewport and the mutated node's bounds span the
 * viewport — the dirty union trips the >half-viewport full-repaint
 * threshold. The mutation (one `setProps` key) stays outside the timer, like
 * scenarios 0 and 2; the timer covers only the render.
 *
 * Since M2.1, a frame whose diff is exactly a vertical scroll of a full-width
 * row band flushes through the terminal-native scroll path (one DECSTBM +
 * SU scroll command plus the newly exposed row — `flush_scroll`, gated on the
 * probe-derived `scrollRegion` capability) instead of repainting every
 * changed cell. Per frame the flushed bytes are read from the native
 * `last_flush_bytes` counter (fed by the backend queue — the same seam
 * scenario 5 reads) and averaged into a bytes-per-frame number: the ANSI
 * byte cost of the OPTIMIZED scroll frame, the M2 acceptance-1 target (≥60%
 * drop vs the round-4 full-repaint flush).
 */
function scenario4(
  renderer: ReturnType<typeof createRenderer>,
  rootBox: Node,
): { mean: number; p50: number; fps: number; bytesPerFrame: number } {
  const perFrameMs: number[] = new Array(SCROLL_N);
  let flushedBytes = 0;
  for (let i = 0; i < SCROLL_N; i++) {
    // One-row viewport scroll: `scroll_y` pans the content up by one row
    // each frame (cycling 0..SCROLL_RANGE-1).
    rootBox.setProps({ ...rootBox.props, scroll_y: i % SCROLL_RANGE });
    const t0 = performance.now();
    renderer.render();
    perFrameMs[i] = performance.now() - t0;
    flushedBytes += renderer.lastFlushBytes;
  }
  const { mean, p50, fps } = summarize(perFrameMs);
  const bytesPerFrame = flushedBytes / SCROLL_N;
  console.log(
    `render.bench: scenario 4 — viewport scroll (${SCROLL_N} frames, one-row shift, full-repaint threshold)`,
  );
  console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
  console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
  console.log(`  fps:  ${fps.toFixed(1)}`);
  console.log(`  bytes per frame: ${bytesPerFrame.toFixed(0)} (mean ANSI bytes flushed per frame)`);
  return { mean, p50, fps, bytesPerFrame };
}

/**
 * Scenario 5 — alternating full screens (the other large-dirty frame shape).
 * Two distinct full-screen `streaming_text` leaves — each 40 rows of a
 * repeated character, so every cell differs between the two screens — swap
 * visibility every frame (one `display: none`/`flex` `setProps` per leaf,
 * the minimal mutation that flips a whole screen), so the diff is the whole
 * viewport and the flush writes the full-screen ANSI stream every frame. Per
 * frame the flushed bytes are read from the native `last_flush_bytes`
 * counter (fed by the backend queue) and averaged into a bytes-per-frame
 * number: the byte cost a full repaint pushes through the terminal, the seam
 * the diff fast paths short-circuit.
 *
 * The synthetic scene is swapped for the two-screen content pane before
 * timing (the root box is detached and a fresh 120x40 pane mounted, with
 * screen A visible and B hidden); that one-time structural mutation is
 * outside the timer. The per-frame visibility toggles (two `setProps`) also
 * stay outside the timer — it covers only the render.
 */
function scenario5(
  renderer: ReturnType<typeof createRenderer>,
  rootBox: Node,
): { mean: number; p50: number; fps: number; bytesPerFrame: number } {
  // Swap the scene: detach the synthetic root box, mount a fresh 120x40
  // content pane holding the two full-screen leaves (A visible, B hidden).
  rootBox.remove();
  const screenBox = Box({
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    flex_direction: "column",
  });
  const screenA = StreamingText({ width: VIEWPORT_W - 2, height: VIEWPORT_H });
  const screenB = StreamingText({ width: VIEWPORT_W - 2, height: VIEWPORT_H });
  screenA.appendSpan(SCREEN_A);
  screenB.appendSpan(SCREEN_B);
  screenB.setProps({ ...screenB.props, display: "none" });
  screenBox.addChild(screenA);
  screenBox.addChild(screenB);
  renderer.root.addChild(screenBox);
  renderer.render(); // warmup: paint screen A (outside the timer)
  // Warm screen B's layout: flip once so the timed loop's first flip is not
  // the first time screen B is laid out (a cold structural paint would skew
  // frame 0 and inflate the mean).
  screenA.setProps({ ...screenA.props, display: "none" });
  screenB.setProps({ ...screenB.props, display: "flex" });
  renderer.render();

  const perFrameMs: number[] = new Array(FULLSCREEN_N);
  let flushedBytes = 0;
  for (let i = 0; i < FULLSCREEN_N; i++) {
    // Flip the screens: screen A <-> screen B (every cell differs).
    const showA = i % 2 === 0;
    screenA.setProps({ ...screenA.props, display: showA ? "flex" : "none" });
    screenB.setProps({ ...screenB.props, display: showA ? "none" : "flex" });
    const t0 = performance.now();
    renderer.render();
    perFrameMs[i] = performance.now() - t0;
    flushedBytes += renderer.lastFlushBytes;
  }
  const { mean, p50, fps } = summarize(perFrameMs);
  const bytesPerFrame = flushedBytes / FULLSCREEN_N;
  console.log(
    `render.bench: scenario 5 — alternating full screens (${FULLSCREEN_N} frames)`,
  );
  console.log(`  mean: ${mean.toFixed(3)} ms/frame`);
  console.log(`  p50:  ${p50.toFixed(3)} ms/frame`);
  console.log(`  fps:  ${fps.toFixed(1)}`);
  console.log(`  bytes per frame: ${bytesPerFrame.toFixed(0)} (mean ANSI bytes flushed per frame)`);
  return { mean, p50, fps, bytesPerFrame };
}

async function main(): Promise<void> {
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
    // 3. Build the synthetic scene once and run the scenarios against it
    //    (the spinner + one text leaf are the mutation points of 0/2/3; the
    //    root box is the scroll pane of scenario 4 and is detached by
    //    scenario 5).
    const { spinner, leaf, rootBox } = buildScene(renderer);

    // Scenario 0 — the animated round-trip (the round-1 canonical number).
    const s0 = scenario0(renderer, spinner);

    // Scenario 1 — no-change frames; the epoch idle fast path. Nothing
    // mutates, so every timed render hits the native no-op path.
    const s1 = scenario1(renderer, s0.mean);

    // Scenario 2 — single-cell change frames (incremental-layout target).
    const s2 = scenario2(renderer, leaf);

    // Scenario 3 — requestFrame burst coalescing.
    const s3 = await scenario3(renderer, spinner);

    // Scenario 4 — viewport scroll (one-row shift; full-repaint threshold).
    const s4 = scenario4(renderer, rootBox);

    // Scenario 5 — alternating full screens (flushed bytes per frame).
    const s5 = scenario5(renderer, rootBox);

    console.log();
    console.log(
      `render.bench: summary — round-trip p50 ${s0.p50.toFixed(3)} ms | no-change p50 ${s1.p50.toFixed(3)} ms | ` +
        `single-cell p50 ${s2.p50.toFixed(3)} ms | burst ratio ${s3.ratio.toFixed(2)} ` +
        `(${s3.expected} native render(s) per ${BURST_SIZE}-call burst) | ` +
        `scroll p50 ${s4.p50.toFixed(3)} ms (${s4.bytesPerFrame.toFixed(0)} bytes/frame) | ` +
        `full-screen p50 ${s5.p50.toFixed(3)} ms ` +
        `(${s5.bytesPerFrame.toFixed(0)} bytes/frame)`,
    );
  } finally {
    try {
      renderer.destroy();
    } catch {
      // Already torn down; nothing to restore.
    }
  }
}

main();
