# tern render baseline

Baseline and post-optimization numbers for the tern render pipeline. The
**baseline** was recorded when the benchmark harness landed (2026-08-04, pre-
optimization, commit `3637be9`); the **after** numbers were recorded after the
high-frame-rate optimization round (subtasks 2–8: scene-epoch no-op fast path,
diff row-skip, SGR run merge, size cache, JS frame coalescing) landed in the
working tree (2026-08-04, same machine).

The round-2 **before** numbers — the incremental-rendering fast-path scenarios
(no-change frames, single-cell change frames, requestFrame burst) recorded on
the round-2 pre-optimization code — are in the
[Round 2 before](#round-2-before--incremental-rendering-fast-path-scenarios-2026-08-04)
section, and the **after** numbers (incremental layout + dirty-region repaint
landed) in the
[Round 2 after](#round-2-after--incremental-rendering-2026-08-05)
section at the end. The round-3 **after** numbers (mutation-site pushed dirty
set landed — the per-frame whole-scene paint-signature walk replaced by an
O(mutated) one) are in the
[Round 3 after](#round-3-after--pushed-dirty-set-2026-08-05)
section after that; its before column is the round-2 after numbers, so the
rounds chain: round 2 before → round 2 after → round 3 after.

Both benches drive the **same synthetic scene**: a root box (120x40 viewport)
holding ~200 nested boxes (3-5 text leaves each, ~800 leaves total), one
`streaming_text` node with 50 styled spans, and one text leaf with a `caret`
prop — roughly 1000 scene nodes.

## Environment

- macOS (darwin, arm64), Apple silicon
- Rust release profile (`lto = true`), Deno 2.9.3, rustc 1.94.0
- Measured on a MacBook Pro M-series (see per-run variance below)
- **Important — addon build profile:** the TS bench loads the tern-node addon
  built at `src/bindings/tern-node/tern-node.darwin-arm64.node`. The recorded
  baseline was captured with the CI default build (`napi build --platform`,
  **debug** profile). The after-numbers below were captured with the
  **release** profile (`npm run build:release`); see the profile-aware
  comparison in the TS section.

## Before / after summary

| metric                            | baseline     | after        | delta      |
|-----------------------------------|--------------|--------------|------------|
| Rust p50 frame (ms)               | ~1.284       | ~1.278       | −0.5%      |
| Rust mean frame (ms)              | ~1.292       | ~1.289       | −0.2%      |
| Rust throughput (M cells/sec)     | ~3.71        | ~3.72        | +0.3%      |
| TS round-trip p50 (ms, release)   | ~22.0*       | ~1.284       | −94%*      |
| TS round-trip mean (ms, release)  | ~22.1*       | ~1.315       | −94%*      |
| TS fps (release)                  | ~45*         | ~761         | ~17x*      |

\* The TS baseline was recorded with a **debug-profile addon**; the after
numbers with a **release-profile addon**. The ~17x TS delta is dominated by the
debug → release profile change, **not** by the optimization work. The same-
profile (debug addon, both sides) TS comparison is ~22.0 → ~21.6 ms p50 (−1.8%)
— see the TS section for the full analysis.

**Honest verdict on the target:** the optimization round did **not** meet the
40% p50 / ~1.7x-throughput target on this synthetic scene. Same-profile Rust
p50 improved ~0.5% and same-profile TS p50 improved ~1.8%. The shortfall is
analyzed honestly in [Interpretation](#interpretation); no thresholds were
adjusted.

## Rust: compositor pipeline (paint + diff + flush)

`src/core/tern-components/tests/bench_timing.rs` — an `#[ignore]`d integration
test that times 2000 iterations of `Compositor::paint_scene` +
`Buffer::diff_from` + `flush_diff_to` into an in-memory `Vec<u8>` sink.

```text
cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture
```

| metric                 | baseline             | after (3 runs)        |
|------------------------|----------------------|-----------------------|
| mean frame             | ~1.29–1.32 ms        | 1.282–1.293 ms (avg 1.289) |
| **p50 frame**          | **~1.284 ms**        | **1.272–1.281 ms (avg 1.278)** |
| p95 frame              | ~1.35–1.39 ms        | 1.331–1.382 ms (avg 1.362) |
| throughput             | ~3.6–3.7 M cells/sec | ~3.71–3.75 M cells/sec (avg ~3.72 M) |

Representative baseline run (first recorded):

```text
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 1.292 ms/frame
p50:  1.284 ms/frame
p95:  1.349 ms/frame
cells/sec: 3714736 cells/sec (773.9 fps at 4800 cells/frame)
```

Representative after run:

```text
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 1.282 ms/frame
p50:  1.274 ms/frame
p95:  1.331 ms/frame
cells/sec: 3745146 cells/sec (780.2 fps at 4800 cells/frame)
```

The scene is static, so after the first iteration the diff is empty and the
flush hits the empty-diff fast path (a no-op) — the number is dominated by
layout + paint, which is the point of the baseline. The optimization work
(row-skip diff, SGR run merge, no-op flush) lands mostly on the diff/flush
seam, which this static scene does not stress: same-profile Rust p50 moved
~1.284 → ~1.278 ms (−0.5%), within run-to-run variance.

## TS: renderer round-trip (real addon, real terminal)

`tools/bench/render.bench.ts` — a Deno script that loads the real tern-node
addon via `@tern/core`, builds the same synthetic scene, and times N = 1000
`renderer.render()` calls (paint + diff + flush to the live terminal) with a
`Spinner` tick between each frame, so the diff is non-empty every frame.

```text
deno run --allow-ffi --allow-read --allow-env tools/bench/render.bench.ts
```

Run in a real terminal / PTY sized 120x40. Without a PTY (or without the
addon), the script prints an explicit SKIP message and exits 0.

| metric                 | baseline (debug addon) | after — release addon (3 runs) | after — same profile (debug addon, 3 runs) |
|------------------------|------------------------|--------------------------------|--------------------------------------------|
| mean round-trip        | ~22.1–23.3 ms          | 1.294–1.340 ms (avg 1.315)     | 21.724–21.743 ms (avg 21.733)              |
| **p50 round-trip**     | **~22.0–22.4 ms**      | **1.271–1.296 ms (avg 1.284)** | **21.568–21.652 ms (avg 21.611)**          |
| **fps**                | **~43–45**             | **~747–773 (avg ~761)**        | **~46.0**                                  |

Representative baseline run (recorded with the debug-profile addon):

```text
render.bench: 1000 render() round-trips @ 120x40 synthetic scene
  mean: 22.121 ms/frame
  p50:  22.001 ms/frame
  fps:  45.2
```

Representative after run (release addon):

```text
render.bench: 1000 render() round-trips @ 120x40 synthetic scene
  mean: 1.312 ms/frame
  p50:  1.286 ms/frame
  fps:  762.4
```

### Profile-aware reading of the TS delta

The two right-hand columns answer different questions:

- **Same profile (debug addon both sides):** ~22.0 → ~21.6 ms p50, −1.8%. This
  isolates the *optimization work* on the synthetic scene. The gain is small
  because the bench ticks the spinner every frame (the scene always mutates, so
  the epoch no-op fast path never fires) and calls `render()` directly (so the
  JS `requestFrame` coalescing is not exercised either) — the per-frame cost is
  dominated by debug-profile napi/terminal work that the optimization round did
  not target.
- **Cross profile (debug baseline → release after):** ~22.0 → ~1.28 ms p50,
  ~17x. This is the number a release-built app ships, but the delta is
  attributable to the debug → release build-profile change, **not** to the
  optimization subtasks. No release-profile baseline exists for the old code,
  so this column must not be read as the optimization's effect.

The round-trip includes the napi boundary crossing and the real terminal
flush; it is the end-to-end JS-facing number the high-frame-rate work targets.

## Interpretation

- The Rust pipeline alone is comfortably >200 fps for this scene (release:
  ~780 fps); the JS round-trip lands at ~45 fps with a debug addon and ~760 fps
  with a release addon — the gap between them is napi overhead + terminal I/O
  + build profile, the space the high-frame-rate rendering strategy operates in.
- **Target not met (recorded honestly, thresholds untouched).** The strategy
  target was a ≥40% p50 frame-time improvement (or ~1.7x throughput) on the
  synthetic scene vs the recorded baseline. Measured same-profile: Rust p50
  −0.5%, TS p50 −1.8%, Rust throughput +0.3% — all within run-to-run variance,
  well short of the target. The optimization round's headline wins (epoch no-op
  fast path, JS frame coalescing, diff row-skip, SGR run merge) are not
  exercised by this bench: the scene mutates every frame and `render()` is
  called directly, so the no-op and coalescing paths never trigger, and the
  static Rust scene reduces diff/flush to the empty fast path the baseline
  already recorded. A bench that calls `requestFrame()` in bursts (or renders
  unchanged frames) would show the real optimization delta.
- The large TS "improvement" vs the recorded baseline (~22 ms → ~1.3 ms) is
  real for release-built apps but is a build-profile artifact of the baseline,
  not a measure of the optimization work; both profiles' numbers are recorded
  above so the comparison stays honest.
- Rerun both benches on the same machine after any render-path change to
  quantify the delta; the commands above are the canonical reproduction, and
  `tools/bench/run.sh` runs both and prints this comparison table.

---

# Round 2 before — incremental-rendering fast-path scenarios (2026-08-04)

Recorded on the **round-2 pre-optimization code**: the round-1 optimization
work is in the working tree (scene-epoch no-op fast path, diff row-skip, SGR
run merge, size cache, JS frame coalescing) but **no incremental layout yet**.
This is the baseline the round-2 (incremental rendering) work must beat.

Environment: same machine as round 1, **release** addon (`npm run
build:release`), Rust release profile, Deno 2.9.3. **The TS bench now runs in a
PTY sized to the synthetic scene's 120x40 viewport** — `run.sh` wraps the
invocation in `script -q /dev/null sh -c 'stty cols 120 rows 40; deno run
...'`. Without the explicit size, a headless shell's `script` PTY reports 0x0,
which is the native "never painted" sentinel (`NO_VIEWPORT`): it disables the
scene-epoch no-op fast path and makes every render repaint, skewing every
scenario. Sizing the PTY makes the numbers deterministic in any shell.

The three new scenarios in `tools/bench/render.bench.ts` (plus the new Rust
target bench) cover the fast paths the round-1 harness never exercised:

1. **no-change frames** — consecutive `render()` with zero scene mutation:
   the scene-epoch idle fast path.
2. **single-cell change frames** — one cell changed per frame: the
   incremental-layout target scene (today the whole scene repaints).
3. **requestFrame burst** — 1000 `requestFrame()` calls within one tick:
   JS frame coalescing, native render count must be 1.

## Scenario 1 — no-change frames (epoch idle fast path)

`tools/bench/render.bench.ts` scenario 1: N = 2000 consecutive `render()`
calls with zero scene mutation; the warmup render paints, every timed render
exits through the native no-op fast path (epoch unchanged + viewport unchanged
→ no paint, no diff, no terminal writes).

| metric | value (4 runs) |
|------------------------|-------------------------------|
| mean frame             | 0.000 ms (sub-µs, ~0.13–0.18 µs) |
| **p50 frame**          | **0.000 ms**                  |
| no-op speedup vs a painted frame | **~7,200–8,100×**    |

Representative run:

```text
render.bench: scenario 1 — no-change frames, epoch idle fast path (2000 frames)
  mean: 0.000 ms/frame
  p50:  0.000 ms/frame
  fps:  5671136.5
  no-op speedup vs a painted frame: 7548x
```

This path already works (it landed in round 1); round 2 must keep it at ~0.
The `fps` figure (5.6M) is an artifact of dividing 1000 by a sub-µs mean and is
meaningless as a frame rate — the speedup line is the real signal.

## Scenario 2 — single-cell change frames (incremental-layout target)

`tools/bench/render.bench.ts` scenario 2: N = 1000 frames, each changing
exactly ONE cell (the first text leaf's content cycles a single digit; the
string length — and therefore the layout — never changes) before `render()`.
The mutation is app work and stays outside the timer, exactly like scenario
0's spinner tick; the timer covers the render round-trip.

| metric | value (4 runs) |
|------------------------|-------------------------------|
| mean frame             | 1.325 ms (1.308–1.434 across runs) |
| **p50 frame**          | **1.313 ms (1.272–1.322)**     |
| fps                    | ~755 (698–755)                 |

Representative run:

```text
render.bench: scenario 2 — single-cell change frames (1000 frames)
  mean: 1.325 ms/frame
  p50:  1.313 ms/frame
  fps:  754.7
```

**Reading:** a one-cell change costs essentially the same as scenario 0's
fully animated frame (p50 ~1.31 ms vs ~1.30–1.32 ms) — the compositor repaints
the whole scene today. This is the number incremental layout will cut; the
delta between scenario 2 and scenario 1 (~1.31 ms vs 0.000 ms) is the
opportunity.

## Scenario 3 — requestFrame burst (JS frame coalescing)

`tools/bench/render.bench.ts` scenario 3: 200 rounds, each issuing
BURST_SIZE = 1000 `requestFrame()` calls within one tick (the spinner is
ticked first so the coalesced render paints a changed frame — a no-op epoch
render would not measure the render path), awaited via the first call's
callback; compared against a single-`requestFrame` control. A burst/single
ratio ≈ 1.0 proves all 1000 calls collapsed into ONE native render.

| metric | value (5 runs) |
|------------------------|-------------------------------|
| mean burst wall time   | 3.66 ms (3.60–5.57; macrotask-latency noise) |
| mean single (control)  | 3.67 ms (3.69–5.49)           |
| **coalescing ratio**   | **1.00 (0.96–1.01)**           |
| **expected native renders per burst** | **1** (a broken coalescer would cost ~1000×) |

Representative run:

```text
render.bench: scenario 3 — requestFrame burst coalescing (200 rounds of 1000 calls)
  mean burst: 3.662 ms (1 native render expected)
  p50 burst:  3.682 ms
  mean single: 3.673 ms (control)
  coalescing ratio: 1.00 (burst / single, ~1.0 = coalesced)
  expected native renders per burst: 1
```

**Reading:** the wall time per burst is ~1 render + one macrotask scheduling
latency; the ~3.7 ms total (vs the ~1.3 ms raw render) is the `setTimeout(0)`
round-trip in the measured loop, which the single control shares, so the ratio
is the honest coalescing signal. The 1000× separation between the coalesced
(≈1) and broken (≈1000) outcomes makes the timing evidence conclusive.

## Rust compositor: single-cell change target

`bench_paint_single_cell_change_frame` in
`src/core/tern-components/tests/bench_timing.rs` — 2000 iterations, one cell
mutated per frame, then the full `paint_scene` → `diff_from` →
`flush_diff_to` pipeline into an in-memory sink. The compositor-level before
number for the incremental-layout work.

| metric | round-1 static baseline | round-2 before (single-cell) |
|------------------------|------------------------|------------------------------|
| mean frame             | ~1.292 ms              | 1.439 ms (1.349–1.439)       |
| p50 frame              | ~1.284 ms              | 1.394 ms (1.337–1.394)       |

Representative run:

```text
=== tern-components incremental-layout target bench ===
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 1.439 ms/frame
p50:  1.394 ms/frame
p95:  1.631 ms/frame
cells/sec: 3336317 cells/sec (695.1 fps at 4800 cells/frame)
```

**Reading:** the single-cell frame tracks the static-scene pipeline frame
within ~1% on the same run (both repaint fully today) — a one-cell mutation
does not reduce the compositor's cost at all. This machine ran ~5–8% slower
during this recording than during the round-1 baseline session (the static
pipeline p50 measured 1.33–1.39 ms here vs the recorded 1.284 ms), so the
single-cell number must be compared against the static number from the SAME
run, not across sessions.

## Notes

- `tools/bench/run.sh` now sizes the TS bench's PTY to 120x40 (`stty` inside
  `script`) and parses all three new scenarios plus the second Rust bench into
  a "Round 2 comparison" table. The round-1 table is unchanged.
- All three new scenarios are exercised end to end through the real addon and
  terminal; the same scenes/iterations are fixed in the bench source, so the
  before/after delta for round 2 is apples-to-apples (release addon, both
  sides).

---

# Round 2 after — incremental rendering (2026-08-05)

Recorded after the round-2 (incremental rendering) work landed in the working
tree: stateful incremental layout (`TaffyLayoutEngine` reconciles the cached
taffy tree, `mark_dirty` re-lays-out only the changed subtrees), compositor
dirty-region repaint (retained buffer + per-node paint signatures; a changed
frame blanks the dirty union of the changed nodes' OLD ∪ NEW bounds and
repaints only the nodes intersecting it into a scratch frame, then `copy_rect`s
the union back — full repaint only on a cold cache, viewport change, fresh
scene instance, or a dirty region covering >half the viewport), and the props
incremental-sync path (single-key native `set_prop`, equal-write epoch skip).

Same environment as the round-2 before recording: same machine, **release**
addon (`npm run build:release`), Rust release profile, Deno 2.9.3, PTY sized
120x40. Three runs; representative run shown, averages in the table.

## Before / after comparison (round 2, release addon both sides)

| metric                              | before (2026-08-04) | after (2026-08-05, avg of 3) | delta        |
|-------------------------------------|---------------------|------------------------------|--------------|
| TS no-change mean (s1)              | 0.000 ms            | 0.000 ms                     | n/a (holds)  |
| TS no-change p50 (s1)               | 0.000 ms            | 0.000 ms                     | n/a (holds)  |
| TS single-cell mean (s2)            | 1.325 ms            | 0.881 ms                     | **−33.5%**   |
| **TS single-cell p50 (s2)**         | **1.313 ms**        | **0.877 ms**                 | **−33.2%**   |
| TS single-cell fps (s2)             | 754.7               | ~1135 (1131–1139)            | **×1.50**    |
| TS burst mean (s3, 1000 reqs)       | 3.662 ms            | 3.66 ms (3.47–3.76)          | −0.1% (noise)|
| TS burst/single ratio (s3)          | 1.00                | 1.02                         | holds (~1.0) |
| Rust single-cell mean               | 1.439 ms            | 0.877 ms                     | **−39.1%**   |
| **Rust single-cell p50**            | **1.394 ms**        | **0.871 ms**                 | **−37.5%**   |
| Rust static mean (round-1 bench)    | 1.292 ms            | 0.012 ms                     | −99.0%*      |
| Rust static p50 (round-1 bench)     | 1.284 ms            | 0.011 ms                     | −99.2%*      |

\* **Semantics change, not a paint speedup.** The round-1 "render pipeline
bench" paints an **unchanged** scene every iteration; with the retained-buffer
compositor it now exits through the compositor-level `NoPaint` fast path
(scene epoch unchanged → return the retained buffer as-is) and never reaches
layout/paint. The row measures the unchanged-frame no-op path, not the paint
pipeline. The apples-to-apples "what does a real changed frame cost" number is
the single-cell bench, which forces a mutation every frame.

Representative after run (first of three):

```text
=== tern-components render pipeline bench ===
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 0.016 ms/frame
p50:  0.014 ms/frame
p95:  0.018 ms/frame
cells/sec: 300447545 cells/sec (62593.2 fps at 4800 cells/frame)
=== tern-components incremental-layout target bench ===
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 0.886 ms/frame
p50:  0.876 ms/frame
p95:  0.941 ms/frame
cells/sec: 5414956 cells/sec (1128.1 fps at 4800 cells/frame)
render.bench: scenario 0 — animated round-trip (1000 frames)
  mean: 0.894 ms/frame
  p50:  0.881 ms/frame
  fps:  1119.0
render.bench: scenario 1 — no-change frames, epoch idle fast path (2000 frames)
  mean: 0.000 ms/frame
  p50:  0.000 ms/frame
render.bench: scenario 2 — single-cell change frames (1000 frames)
  mean: 0.884 ms/frame
  p50:  0.879 ms/frame
  fps:  1131.7
render.bench: scenario 3 — requestFrame burst coalescing (200 rounds of 1000 calls)
  mean burst: 3.469 ms (1 native render expected)
  p50 burst:  3.475 ms
  mean single: 3.389 ms (control)
  coalescing ratio: 1.02 (burst / single, ~1.0 = coalesced)
  expected native renders per burst: 1
```

## Scenario-by-scenario reading

### Scenario 1 — no-change frames: unchanged (~0, holds)

0.000 → 0.000. This path landed in round 1 (scene-epoch no-op fast path); the
round-2 compositor adds a second, deeper no-op layer (retained-buffer
`NoPaint`), but the renderer-level epoch check already makes the TS number
sub-µs, so there is nothing left to cut. **No further gain possible here; the
requirement was to keep it at ~0, and it does.**

### Scenario 2 — single-cell change frames: the round-2 win

TS p50 **1.313 → 0.877 ms (−33.2%)**, mean −33.5%, fps 754.7 → ~1135
(×1.50); Rust p50 **1.394 → 0.871 ms (−37.5%)**, mean −39.1%. This is the
incremental-layout + dirty-region-repaint target scenario, and it is where the
round-2 work lands: a one-cell mutation now reconciles a single subtree in the
cached taffy tree (`mark_dirty` on the changed leaf only) and repaints just
the dirty union instead of the whole 4800-cell frame.

**Why not more?** The remaining ~0.88 ms is dominated by fixed per-frame work
the fast paths do not touch: the napi boundary crossing, the terminal size
cache probe, the row-slice diff walk, and the JS-side props diff/`set_prop`
round-trip that every scenario pays (scenario 0's animated frame measures the
same ~0.88 ms). The dirty path still walks layout + signatures for the whole
scene (a per-frame O(nodes) pass to find *what* changed), which incremental
layout shrinks but does not eliminate. So the ~1/3 cut is real and
well outside run-to-run variance (before recorded 1.272–1.322 p50 across runs;
after 0.866–0.879) — but a single-cell frame is not free yet: the floor is the
scene-wide change-detection walk plus the fixed JS/napi/terminal overhead.

### Scenario 3 — requestFrame burst: no change (expected)

3.662 → ~3.66 ms, ratio 1.00 → 1.02, still 1 native render per 1000-call
burst. Frame coalescing is round-1 work and was not touched in round 2; the
burst wall time is macrotask-latency dominated (the before range was already
3.60–5.57 ms), so the ±3% movement is scheduling noise, not a regression or a
gain. **No benefit in this scenario — none was expected; the honest record is
"unchanged, coalescing still holds".**

### Bonus: the animated round-trip (scenario 0) improved too

The round-2 before recording did not table scenario 0, but its notes state
scenario 0 ≈ scenario 2 (p50 ~1.31 ms). After, scenario 0 measures
**0.873–0.881 ms p50** — the same ~−33% as scenario 2, because a spinner tick
is a one-cell mutation and now rides the same dirty-repaint path. The
round-1-canonical round-trip number moved for the first time in round 2.

## Fast-path coverage (which scenario exercises which path)

| fast path | code | exercised by |
|-----------|------|--------------|
| Renderer scene-epoch no-op (zero terminal writes) | `TuiRenderer::render` (`last_painted_epoch`) | s1 |
| Compositor retained-buffer `NoPaint` (unchanged scene) | `paint_scene` epoch check (`compositor.rs`) | s1, Rust static bench |
| Incremental layout (cached taffy tree, `mark_dirty` reconcile) | `TaffyLayoutEngine::compute` / `reconcile` | s2, s0 (every frame mutates one cell) |
| Dirty-region repaint (scratch frame + `copy_rect`) | `paint_dirty` / `copy_rect` | s2, s0 |
| Full-repaint fallback (>half viewport dirty, cold cache, resize) | `paint_full` | not hit by these scenarios (1-cell changes) |
| Props incremental sync (single-key `set_prop`, equal-write epoch skip) | `Node.setProps` diff → `set_prop` | s2's per-frame `setProps` call (the mutation itself) |
| JS frame coalescing (`requestFrame`) | `Renderer.requestFrame` | s3 |

## Conclusion — honest verdict

- **The round-2 target scenario is a real, measured win:** single-cell change
  frames are −33% (TS) / −37% (Rust) p50, ×1.50 fps, on the same release
  profile both sides. The animated round-trip rides along at ~−33%.
- **No-change frames stay at ~0** — no regression, and no room left to
  improve.
- **requestFrame burst is unchanged** — coalescing was round-1 work; nothing
  moved, nothing regressed.
- **Do not read the Rust static row as a paint speedup** (−99%): the bench's
  semantics changed to the unchanged-frame no-op path. The paint pipeline's
  real before/after is the single-cell pair (−37% p50), which is the honest
  apples-to-apples comparison.
- **Difference vs the round-1 baseline:** round 1 moved the static/animated
  scene ~0.5% (Rust) / ~1.8% (TS, same profile) and recorded the 40%-target
  miss; round 2's incremental work is what actually cuts per-frame cost on
  *changed* frames, and it does so by ~1/3 on the one-cell scenario the
  round-1 harness never exercised. The round-1 static bench is now a no-op
  path measurement, so its recorded 1.284 ms is historical.
- No thresholds were adjusted; every number above is as measured.

---

# Round 3 after — pushed dirty set (2026-08-05)

Recorded after the round-3 change-detection work landed in the working tree:
the **mutation-site pushed dirty set**. Round 2's dirty path still walked the
whole scene every frame to *find* what changed — `collect_paint_sigs` built
and compared a `PaintSig` for all ~1000 scene nodes per frame. Round 3
replaces that per-frame O(nodes) signature walk with a push: the scene records
the id of every node a mutation touches, and `Compositor::paint_dirty` drains
that set (`Scene::take_dirty`) and collects/compares paint signatures **only
for the pushed ids** (`collect_paint_sigs_for`) — O(mutated) instead of
O(nodes). The all-node old-vs-new RECT comparison stays as the repaint
region's correctness backbone (geometry, structural and overflow changes move
rects), and a raw `node_mut` borrow (which the scene cannot introspect) sets a
force-full-scan flag that falls back to the whole-tree walk — so the pushed
set only ever narrows the signature work, never gates the repaint decision.

Same environment as the round-2 after recording: same machine, same session
(2026-08-05), **release** addon (`npm run build` — release-default since
round-3 subtask 1), Rust release profile, Deno 2.9.3, PTY sized 120x40. Three
runs; representative run shown (first of three), averages in the table. The
round-3 **before** numbers are the round-2 **after** numbers — same release
profile, same scene, same PTY setup — the state the pushed-dirty-set work had
to beat.

## Before / after comparison (round 3: round-2 after vs round-3 after)

| metric                              | before (round-2 after, 2026-08-05) | after (round-3, avg of 3)  | delta        |
|-------------------------------------|------------------------------------|----------------------------|--------------|
| TS round-trip mean (s0)             | 0.894 ms                           | 0.675 ms (0.666–0.681)     | **−24.5%**   |
| **TS round-trip p50 (s0)**          | **0.881 ms**                       | **0.664 ms (0.660–0.666)** | **−24.6%**   |
| TS round-trip fps (s0)              | 1119.0                             | ~1481 (1469–1500)          | **×1.32**    |
| TS no-change mean (s1)              | 0.000 ms                           | 0.000 ms                   | n/a (holds)  |
| TS no-change p50 (s1)               | 0.000 ms                           | 0.000 ms                   | n/a (holds)  |
| TS single-cell mean (s2)            | 0.881 ms                           | 0.668 ms (0.663–0.672)     | **−24.2%**   |
| **TS single-cell p50 (s2)**         | **0.877 ms**                       | **0.660 ms (0.657–0.662)** | **−24.7%**   |
| TS single-cell fps (s2)             | ~1135 (1131–1139)                  | ~1497 (1489–1508)          | **×1.32**    |
| TS burst mean (s3, 1000 reqs)       | 3.66 ms (3.47–3.76)                | 3.07 ms (3.02–3.10)        | −16.2%\*     |
| TS burst/single ratio (s3)          | 1.02                               | 1.00 (0.99–1.01)           | holds (~1.0) |
| Rust single-cell mean               | 0.877 ms                           | 0.688 ms (0.662–0.732)     | **−21.6%**   |
| **Rust single-cell p50**            | **0.871 ms**                       | **0.662 ms (0.654–0.673)** | **−24.0%**   |
| Rust static mean (round-1 bench)    | 0.012 ms (no-op path)              | 0.011 ms                   | n/a (holds)  |
| Rust static p50 (round-1 bench)     | 0.011 ms (no-op path)              | 0.009–0.010 ms             | n/a (holds)  |

\* The s3 burst wall time is macrotask-scheduling-latency dominated (the
round-2 before recording already ranged 3.60–5.57 ms); the ~0.6 ms drop is
consistent with the faster native render inside the coalesced frame plus
scheduling noise. The coalescing signal — the burst/single ratio — holds at
~1.00, i.e. still exactly 1 native render per 1000-call burst.

Representative after run (first of three):

```text
=== tern-components render pipeline bench ===
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 0.011 ms/frame
p50:  0.010 ms/frame
p95:  0.011 ms/frame
cells/sec: 424164886 cells/sec (88367.7 fps at 4800 cells/frame)
=== tern-components incremental-layout target bench ===
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 0.670 ms/frame
p50:  0.658 ms/frame
p95:  0.739 ms/frame
cells/sec: 7163969 cells/sec (1492.5 fps at 4800 cells/frame)
render.bench: scenario 0 — animated round-trip (1000 frames)
  mean: 0.681 ms/frame
  p50:  0.666 ms/frame
  fps:  1469.3
render.bench: scenario 1 — no-change frames, epoch idle fast path (2000 frames)
  mean: 0.000 ms/frame
  p50:  0.000 ms/frame
render.bench: scenario 2 — single-cell change frames (1000 frames)
  mean: 0.672 ms/frame
  p50:  0.662 ms/frame
  fps:  1488.6
render.bench: scenario 3 — requestFrame burst coalescing (200 rounds of 1000 calls)
  mean burst: 3.019 ms (1 native render expected)
  p50 burst:  3.021 ms
  mean single: 3.056 ms (control)
  coalescing ratio: 0.99 (burst / single, ~1.0 = coalesced)
  expected native renders per burst: 1
```

## Scenario-by-scenario reading

### Scenario 2 — single-cell change frames: another ~1/4 off the round-2 number

TS p50 **0.877 → 0.660 ms (−24.7%)**, mean −24.2%, fps ~1135 → ~1497
(×1.32); Rust p50 **0.871 → 0.662 ms (−24.0%)**, mean −21.6%. Round 2's dirty
path still walked the whole scene every frame to *find* what changed (the
per-frame full-scene paint-signature collection + comparison); round 3
replaces that with the mutation-site pushed dirty set, so a one-cell mutation
now collects and compares exactly one (or a few) signatures instead of ~1000.

**Why not more?** The remaining ~0.66 ms floor is the fixed per-frame work no
change-detection scheme removes: the napi boundary crossing, the terminal size
cache probe, the all-node old-vs-new rect walk (kept as the correctness
backbone — a cheap compare, but still O(nodes)), the layout reconcile pass
over the scene tree, the scratch-frame allocation + `copy_rect`, the row-slice
diff, the flush, and the JS-side props diff/`set_prop` round-trip. Scenario 0's
animated frame (which also mutates one cell) lands at the same ~0.66 ms, so
the floor is structural, not a missed fast path.

### Scenario 0 — animated round-trip: rides the same −1/4

p50 **0.881 → 0.664 ms (−24.6%)**, fps 1119 → ~1481. The round-2 after
recording did not table scenario 0; its notes stated scenario 0 ≈ scenario 2
(~1.31 ms before round 2) and measured 0.873–0.881 ms p50 after round 2. Round
3 cuts it to 0.660–0.666 ms. A spinner tick is a one-cell mutation, so the
animated round-trip exercises the same pushed-dirty path as scenario 2 — the
round-1-canonical round-trip number moved again.

### Scenario 1 — no-change frames: unchanged (~0, holds)

0.000 → 0.000. The renderer-level scene-epoch no-op fast path fires before the
compositor is even consulted; the pushed dirty set neither helps nor hurts
here. No change, no regression.

### Scenario 3 — requestFrame burst: coalescing holds, wall time dropped slightly

Ratio 1.02 → 1.00 (0.99–1.01 across runs) — still exactly 1 native render per
1000-call burst. The burst wall time moved ~3.66 → ~3.07 ms (−16%); this is
macrotask-latency dominated (the round-2 before recording ranged 3.60–5.57
ms), and the drop is consistent with the ~0.2 ms faster native render inside
the coalesced frame plus scheduling noise. **The honest signal is the ratio,
which holds; the wall-time movement is not claimed as a round-3 gain.**

## Fast-path coverage (round-3 delta)

| fast path | code | round-2 → round-3 change |
|-----------|------|--------------------------|
| Renderer scene-epoch no-op | `TuiRenderer::render` (`last_painted_epoch`) | unchanged |
| Compositor retained-buffer `NoPaint` | `paint_scene` epoch check (`compositor.rs`) | unchanged |
| Incremental layout (`mark_dirty` reconcile) | `TaffyLayoutEngine::compute` / `reconcile` | unchanged |
| Dirty-region repaint (scratch frame + `copy_rect`) | `paint_dirty` / `copy_rect` | unchanged |
| **Mutation-site pushed dirty set** | `Scene::take_dirty` → `collect_paint_sigs_for` | **new in round 3** — signature work O(mutated); whole-tree walk only on the force-full-scan (`node_mut`) fallback |
| Props incremental sync (`set_prop`) | `Node.setProps` diff → `set_prop` | unchanged |
| JS frame coalescing (`requestFrame`) | `Renderer.requestFrame` | unchanged |

## Conclusion — honest verdict

- **The round-3 change-detection win is real and stacks on round 2:**
  single-cell change frames are −24.7% (TS) / −24.0% (Rust) p50, ×1.32 fps,
  against the round-2 after numbers on the same release profile both sides.
  The animated round-trip (scenario 0) rides along at −24.6%. Over both
  rounds, the one-cell frame went ~1.31 → ~0.66 ms p50 (≈ −50%).
- **No-change frames stay at ~0** and the **requestFrame burst still coalesces
  at ratio ~1.0** — nothing regressed; the burst wall-time movement is
  noise-consistent and is not claimed as a gain.
- **The round-1 static Rust row remains a no-op-path measurement** (~0.01 ms)
  — its semantics changed in round 2; the apples-to-apples "changed frame"
  cost is the single-cell pair, now ~0.66 ms.
- **Honesty note (scope of the win):** this bench only exercises one-cell
  mutations. The pushed dirty set also removes the signature-walk cost from
  *large* dirty frames — but those still pay the O(nodes) rect walk, the
  full-paint region, and, past the >half-viewport threshold, a full repaint —
  so the real-world gain on big repaints is smaller than the one-cell number
  suggests. No thresholds were adjusted; every number above is as measured.

