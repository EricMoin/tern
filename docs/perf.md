# tern rendering performance

This document describes the per-frame rendering pipeline, the optimizations
shipped in the high-frame-rate round (subtasks 2–8), the
`Renderer.requestFrame` coalescing API, the round-2 incremental-rendering work
(incremental layout, dirty-region repaint, props incremental sync), the
round-3 change-detection work (mutation-site pushed dirty set), the round-4
large-dirty work (scratch-frame pooling, retained-buffer reuse, single-layout
full-repaint fallback), and how to
reproduce the benchmark numbers recorded in
[`tools/bench/BASELINE.md`](../tools/bench/BASELINE.md). Read the results
section last — the measured gains on the synthetic scene are small, and this
document deliberately does not overstate them.

## The frame pipeline: paint → diff → flush

Every frame runs through `TuiRenderer::render()`
(`src/bindings/tern-node/src/lib.rs`), which drives three stages (the same
seam `src/core/tern-components/tests/bench_timing.rs` times):

1. **Paint** — `Compositor::paint_scene(&scene, viewport)` lays the scene tree
   out (tern-layout / taffy) and paints the laid-out nodes into a fresh cell
   `Buffer` (e.g. 120×40 = 4800 cells).
2. **Diff** — `Buffer::diff_from(&prev)` computes the minimal set of
   `CellUpdate`s that turns the previous frame's buffer into the new one
   (`src/core/tern-core/src/buffer.rs`).
3. **Flush** — the backend queues the ANSI escape sequences for those updates
   (run-batched `MoveTo` / SGR / `Print`, see below) and flushes them to the
   terminal once (`src/core/tern-terminal/src/backend.rs`, reached through the
   `RenderBackend::flush_diff` trait in `src/bindings/tern-node/src/lib.rs`).

On the JS side, the reconciler drives this through `Renderer.render()` (or a
coalesced `Renderer.requestFrame()`, see below) → napi → `TuiRenderer::render`.
The optimizations below attack specific hot spots in these stages.

```
 JS reconciler
      │  scene mutations bump the scene epoch — every animation tick
      ▼
 tern-node     TuiRenderer::render()
      │  ① epoch + viewport + size-cache no-op check → skip (zero writes)
      │  ② terminal size: served from the cache, else probed via Backend::size()
      ▼
 Compositor
      │  ③ paint_scene → layout + paint into a fresh Buffer
      ▼
 tern-core     Buffer
      │  ④ diff_from(prev) → minimal CellUpdate diff (row-skip fast path)
      ▼
 tern-terminal Backend
      │  ⑤ flush_diff → run-batched ANSI queue + flush (empty diff → no-op)
      ▼
 terminal
```

## Shipped optimizations

### 1. Scene-epoch no-op fast path

`Scene` keeps a monotonic mutation counter — `Scene::epoch` — bumped by every
successful tree mutation and untouched by reads and failed (no-op) mutations
(`src/core/tern-core/src/scene.rs`). `TuiRenderer::render` returns `Ok(())`
immediately when nothing changed: the scene epoch equals the epoch of the last
successful paint, **and** the cached terminal size is valid (a resize
invalidates it), **and** the viewport is unchanged since the last paint. That
short-circuit skips the size probe, the paint, the diff, the flush, and even
the buffer storage — **zero terminal writes for an unchanged frame**
(`src/bindings/tern-node/src/lib.rs`, `RendererInner::last_painted_epoch` /
`last_viewport`). The epoch is recorded under the same lock that painted the
frame, so the cached value always describes the state that was painted; a
fresh renderer never takes the fast path before its first paint (`NO_VIEWPORT`
guard). The `RenderBackend` trait abstraction lets unit tests inject a
counting mock and prove the no-op path performs zero terminal writes.

### 2. Row-skip diff

`Buffer::diff` first compares each row as a whole `&[Cell]` slice between the
previous and next buffers. An identical row (or a row that is blank in a
region the previous buffer did not cover) is skipped entirely — the per-cell
scan only runs on rows that actually changed, which is the common case between
frames (`src/core/tern-core/src/buffer.rs`). Multi-width semantics are
preserved: a changed wide lead cell still emits together with its masked
continuation cell, and grown blank rows/columns compare against blank cells
and are not emitted.

### 3. SGR run merging

The tern-terminal backend's cell queueing merges consecutive updates that
share a style, a row, and adjacent columns into single runs (`queue_cells` /
`Run` in `src/core/tern-terminal/src/backend.rs`): each run emits one `MoveTo`
to its first cell, one SGR style block for the shared style, and all of its
characters in one `Print` call. A run whose style equals the previously queued
run's skips the redundant SGR reset/re-apply entirely (nothing between two
runs alters the terminal's style state), so a typical frame flushes a handful
of runs instead of one sequence per cell.

### 4. Empty-diff flush suppression

Separately, `flush_diff_to` short-circuits an **empty diff**: when no cells
changed and the caret is already parked where the frame wants it, nothing is
queued and `Write::flush` is never called — the frame is a true no-op (zero
bytes). If only the park position moved, a lone `MoveTo` is emitted with no
style commands (the style state is already clean from the previous flush).

### 5. Terminal size caching

`RendererInner::cached_size` caches the terminal size as last probed, so the
hot render path (and `hit_test`) skips the per-frame `backend.size()` ioctl;
the cache is refreshed only on the first probe and re-queried after a resize
event invalidates it (`invalidate_size_on_resize` in
`src/bindings/tern-node/src/lib.rs`).

### 6. Frame coalescing — `Renderer.requestFrame`

`Renderer.requestFrame(callback?)` schedules a coalesced native render on the
next macrotask (`setTimeout(0)`, falling back to `queueMicrotask` when timers
are unavailable). Several `requestFrame` calls within one tick collapse into a
single native `render()` — the pending-frame flag dedupes the schedule — so a
burst of scene mutations repaints once instead of once per call
(`packages/core/src/index.ts`). See the API section below.

### 7. Removal of the redundant React pre-commit paint

The `@tern-tui/react` reconciler no longer paints in `prepareForCommit` — the
pre-commit paint (of the pre-mutation tree) was redundant with the post-commit
one. `resetAfterCommit` calls `renderer.render()` and is now the single paint
per commit (`packages/react/src/reconciler.ts`).

## Round 2 — incremental rendering

Round 2 replaces the "paint the whole scene into a fresh buffer every frame"
model with a stateful, incremental one. The compositor and the layout engine
now **retain state across frames** and redo only the work a mutation actually
invalidates. Three changes, one per seam:

### 8. Incremental layout (tern-layout)

`TaffyLayoutEngine` (`src/core/tern-layout/src/lib.rs`) is now stateful: it
owns the taffy tree, caches it across frames, and **reconciles** it against
the current scene instead of rebuilding it. Each cached node keeps a
`NodeSnapshot` of its scene-relevant style/geometry inputs; `reconcile` walks
the scene once per frame, compares each node against its snapshot, and calls
taffy's `mark_dirty` only on nodes whose inputs changed — taffy then re-lays-out
only the dirty subtrees, not the whole tree.

- A fresh scene instance or a cold cache still takes `full_rebuild` (the
  correctness baseline every incremental result is tested against).
- A frame that changes more than half the tree (or that cannot be reconciled
  safely) falls back conservatively to a full rebuild — correctness is
  identical either way.
- The engine is instrumented (`full_rebuilds`, `last_reconciled_node_count`,
  `last_was_full_rebuild`) so tests can prove a single-cell mutation reconciles
  one subtree instead of rebuilding the tree (`src/core/tern-layout/tests/
  incremental.rs`).

### 9. Dirty-region repaint (tern-components)

`Compositor::paint_scene` (`src/core/tern-components/src/compositor.rs`) no
longer paints the whole scene per frame. It retains the last buffer, the last
scene-absolute rects, and a per-node `PaintSig` (every paint-relevant input:
style, text, caret, clip, scroll, z-index, wrap, status-bar marker, a cheap
stream signature). On each frame:

- **Unchanged scene** (epoch equal) → return the retained buffer as-is
  (`PaintMode::NoPaint`) — a compositor-level twin of the renderer's
  scene-epoch no-op fast path.
- **Changed scene** → compute the dirty union over the changed nodes' OLD ∪ NEW
  painted bounds, blank that union in the retained buffer, then repaint only
  the z-ordered nodes whose painted bounds intersect the union into a **blank
  scratch frame**, and `copy_rect` the union back into the retained buffer.
  Painting into a scratch frame (rather than in place, or narrowing each
  node's clip) means every node paints exactly as it would in a full paint —
  overlays, siblings, and clipped children included — so the result is
  cell-for-cell identical to a full repaint (the tests enforce this), and the
  renderer's diff against the previous frame is unchanged.
- **Full repaint** happens only on explicit invalidation: a cold cache, a
  viewport change, a different (fresh) scene instance, or a dirty region
  covering more than half the viewport (cheaper than a patchwork of small
  repaints). It never falls back to full repaint on "the scene epoch changed"
  alone.

The compositor is instrumented (`last_paint_mode`, `last_repainted_node_count`)
so tests can prove a one-cell mutation takes the dirty path and a resize takes
the full path (`src/core/tern-components/tests/incremental_consistency.rs`).

### 10. Props incremental sync (tern-node + @tern-tui/core)

`Node.setProps` (`packages/core/src/index.ts`) no longer serializes the whole
prop map and replaces it wholesale. It diffs the incoming map against the
current props and pushes **only the changed keys** through the new native
single-key `NodeHandle.set_prop` path (`src/bindings/tern-node/src/lib.rs`),
which applies one style/text key to the scene node. Removals fall back to the
full-map replace (a removal needs the table replace to clear the stale key).
`Node.setProp` is the direct single-key surface.

Equal-value writes are skipped at every layer — the TS mirror, the binding,
and the scene (`Scene::set_prop` returns without re-inserting when the value is
unchanged) — so a no-op re-render performs no native call, bumps no scene
epoch, and dirties no layout: the renderer's no-op fast path still applies to
re-renders that change nothing.

### How the fast paths compose

A one-cell mutation (the benchmark target) now flows: JS `setProps` diffs →
one `set_prop` call → scene epoch bumps → `render()` → compositor dirty path →
layout engine reconciles one subtree (`mark_dirty` on one leaf) → scratch-frame
repaint of the dirty union → `copy_rect` back → diff vs the retained previous
frame (now tiny) → flush. Everything else — the other ~1000 nodes, their
layout, their paint — is untouched.

## Round 3 — pushed dirty set (change detection)

Round 2's dirty-region repaint still had to *find* what changed: every dirty
frame ran a whole-tree paint-signature walk — `collect_paint_sigs` built and
compared a `PaintSig` for all ~1000 scene nodes, every frame, just to know
which rects to repaint. Round 3 replaces that per-frame O(nodes) walk with a
**mutation-site pushed dirty set**.

### 11. Mutation-site pushed dirty set (tern-core + tern-components)

`Scene` now records the id of every node a mutation touches in a pending dirty
set (`src/core/tern-core/src/scene.rs`). `Compositor::paint_dirty` drains it
via `Scene::take_dirty` and collects/compares paint signatures **only for the
pushed ids** (`collect_paint_sigs_for`, `src/core/tern-components/src/
compositor.rs`) — O(mutated) instead of O(nodes) per frame.

- **Correctness backbone unchanged:** the all-node old-vs-new RECT comparison
  stays — geometry, structural and overflow changes move rects, and the union
  of the changed nodes' OLD ∪ NEW bounds is what the repaint region is built
  from. The pushed set only ever narrows the signature work; it never gates
  the repaint decision, so a missed signature can never lose a repaint it was
  responsible for.
- **Raw `node_mut` fallback:** a mutation through a raw `node_mut` borrow
  (which the scene cannot introspect) sets a force-full-scan flag; the
  compositor falls back to the whole-tree signature walk for that frame.
- A full paint (`paint_full`) consumes the pushed set too, keeping the set
  consistent for the next dirty pass (a mutation recorded during a full paint
  is a mutation that was already painted).

### How the round-3 fast path composes

The one-cell benchmark frame now flows: JS `setProps` diff → one `set_prop`
call → scene epoch bumps **and the node id is pushed to the scene's dirty
set** → `render()` → compositor dirty path → layout engine reconciles one
subtree → **paint signatures collected and compared for the one pushed id
only** → scratch-frame repaint of the dirty union → `copy_rect` back → diff vs
the retained previous frame → flush. The O(nodes) per-frame signature walk is
gone; the remaining O(nodes) work — the rect-compare walk and the layout
reconcile pass — is retained as the correctness backbone.

## `Renderer.requestFrame` API

```ts
requestFrame(callback?: () => void): () => void
```

- Schedules a **coalesced** native render on the next macrotask; N calls in one
  tick produce **one** native render.
- The optional `callback` runs after the native render completes — every
  call's callback, in call order.
- Returns a cancel function that aborts a still-pending frame: the scheduled
  render never fires and its queued callbacks are dropped. A no-op once the
  frame has fired (or was already canceled).
- An explicit `render()` while a frame is pending paints immediately and
  **supersedes** it — no second render fires — running the queued callbacks
  right after its own paint. `render()` itself stays synchronous and
  immediate; `requestFrame` is the coalescing path for high-frame-rate loops.

Usage example (an animation ticker):

```ts
import { Spinner, createRenderer, tick } from "@tern-tui/core";

const renderer = createRenderer({ title: "coalesced frames" });
const spinner = Spinner({});
renderer.root.addChild(spinner);

// Mutate the scene, then request a frame. A burst of mutations within one
// tick collapses into a single native render.
function animate(): void {
  tick(spinner);                   // mutate the scene (bumps the epoch)
  renderer.requestFrame(animate);  // coalesced paint; re-arm for the next frame
}
animate();

// The returned cancel function aborts a still-pending frame:
const cancel = renderer.requestFrame();
cancel();                          // the scheduled paint never fires

// An explicit render() paints immediately and supersedes a pending frame:
renderer.requestFrame(() => console.log("painted"));
renderer.render();                 // paints now; callback runs after, no double paint
```

## Running the benchmarks

Two benches measure the pipeline, plus a runner that executes both and prints
the before/after comparison table (all three run from the repo root):

```text
# 1. Rust compositor pipeline (paint + diff + flush), release profile — two
#    blocks: the round-1 static scene + the round-2 single-cell target:
cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture

# 2. TS renderer round-trip through the real tern-node addon (needs a PTY):
deno run --allow-all tools/bench/render.bench.ts

# 3. Both, with a baseline-vs-now comparison table (rounds 1, 2, 3 and 4):
bash tools/bench/run.sh
```

Notes:

- The Rust bench is `#[ignore]`d so `cargo test --workspace` skips it by
  default; run it explicitly with `--ignored --nocapture`
  (`src/core/tern-components/tests/bench_timing.rs`). The first block times
  2000 iterations of `Compositor::paint_scene` + `Buffer::diff_from` +
  `flush_diff_to` over an **unchanged** scene (the round-1 canonical number —
  note it now exits through the compositor's `NoPaint` fast path, see
  [Results](#results--read-them-honestly)); the second block mutates exactly
  one cell per frame — the incremental-layout target.
- The TS bench (`tools/bench/render.bench.ts`) loads the real `tern-node`
  addon through `@tern-tui/core`, builds the same synthetic scene, and runs four
  scenarios: 0 = animated round-trip (N = 1000 `renderer.render()` calls with
  a `Spinner` tick between frames), 1 = no-change frames (epoch idle fast
  path), 2 = single-cell change frames (incremental-layout target), 3 =
  `requestFrame` burst (1000 calls per tick, coalescing ratio must be ~1.0).
  It runs in a real terminal (raw mode); headless (no addon / no PTY) it
  prints an explicit `SKIP` message and exits 0, so it is safe to run in CI.
  `tools/bench/run.sh` wraps it in `script` on macOS to give it a PTY sized
  to the scene's 120x40 viewport (a 0x0 PTY is the native "never painted"
  sentinel and disables the epoch no-op fast path) and heuristically reports
  which addon profile (debug vs release) it measured against.
- Absolute TS numbers depend on the addon's build profile — see the next
  section. Full methodology: `tools/bench/BASELINE.md`.

## Results — read them honestly

The recorded numbers live in `tools/bench/BASELINE.md` (baseline captured
pre-optimization at commit `3637be9`; round-1 and round-2 after-numbers
captured on the same machine with the respective optimization rounds in the
working tree). The honest reading:

### Round 1 (static/animated scene)

- **Same-profile gains were small.** On the synthetic scene, the Rust pipeline
  moved ~1.284 → ~1.278 ms p50 (−0.5%) and the same-profile (debug addon both
  sides) TS round-trip moved ~22.0 → ~21.6 ms p50 (−1.8%) — both within
  run-to-run variance, far short of the strategy's 40% p50 / ~1.7x-throughput
  target.
- **The build profile was the dominant factor, not the optimizations.** The
  ~17x TS improvement (~22 ms → ~1.3 ms p50) recorded vs the baseline is a
  debug → release addon build-profile artifact: the baseline was captured with
  a debug-profile addon and the after-numbers with a release-profile addon.
- **Why the round-1 bench under-reported the optimization work:** the bench
  ticked the spinner every frame (the scene always mutates, so the epoch no-op
  fast path never fired) and called `render()` directly (so JS `requestFrame`
  coalescing was not exercised). The round-2 scenarios (no-change frames,
  single-cell change frames, requestFrame burst) were added to exercise those
  paths.

### Round 2 (incremental rendering, release addon both sides)

- **Single-cell change frames — the round-2 target — improved ~1/3:** TS p50
  ~1.313 → ~0.877 ms (−33.2%, fps ×1.50); Rust p50 ~1.394 → ~0.871 ms
  (−37.5%). The animated round-trip (scenario 0) rides along at ~−33% because
  a spinner tick is a one-cell mutation on the same dirty path.
- **No-change frames hold at ~0** (0.000 → 0.000) and the **requestFrame
  burst is unchanged** (3.66 ms, ratio still ~1.0) — coalescing was round-1
  work; round 2 did not touch it. No regression in either.
- **The round-1 static Rust bench now measures the unchanged-frame no-op
  path** (~1.29 ms → ~0.01 ms): with the retained-buffer compositor, an
  unchanged scene never reaches layout/paint. That row is a semantics change,
  not a paint speedup — the honest "changed frame" comparison is the
  single-cell pair above.
- **Do not quote the round-2 single-cell numbers without the scenario:** they
  are for a one-cell mutation on this synthetic scene; a large-diff frame
  (window scroll, full-screen repaint) still takes the full path. Full
  tables, fast-path coverage, and the honest verdict:
  `tools/bench/BASELINE.md` → "Round 2 after".

### Round 3 (pushed dirty set, release addon both sides)

- **Single-cell change frames improved another ~1/4 on top of round 2:** TS
  p50 ~0.877 → ~0.660 ms (−24.7%, fps ×1.32); Rust p50 ~0.871 → ~0.662 ms
  (−24.0%). The animated round-trip (scenario 0) rides along at ~−24.6%. Over
  both rounds the one-cell frame went ~1.31 → ~0.66 ms p50 (≈ −50%). The
  before column is the round-2 **after** numbers (same release profile both
  sides), so the rounds chain end to end.
- **No-change frames hold at ~0** and the **requestFrame burst ratio still
  holds at ~1.0** (1 native render per 1000-call burst); the burst wall time
  moved 3.66 → ~3.07 ms, macrotask-latency/noise-consistent — not claimed as
  a gain.
- **Why not more:** the ~0.66 ms floor is fixed per-frame overhead the
  change-detection scheme does not touch — napi boundary, size probe, the
  retained O(nodes) rect-compare walk (the correctness backbone), layout
  reconcile, scratch-frame allocation + copy, diff, flush, and the JS props
  round-trip. Scenario 0's animated frame lands at the same floor.
- **Caveat:** the bench exercises one-cell mutations; large dirty frames still
  pay the rect walk + repaint region (and past the >half-viewport threshold a
  full repaint), so real-world gains on big repaints are smaller than the
  one-cell number. Full tables and the honest verdict:
  `tools/bench/BASELINE.md` → "Round 3 after".

### Round 4 (large-dirty frames, release addon both sides)

Round 4 attacks the large-dirty frame floor the round-3 caveat called out.
The harness gained two large-dirty scenarios (viewport scroll and alternating
full screens — both trip the `>half-viewport` full-repaint fallback), and the
compositor's large-dirty path was optimized. Full tables:
`tools/bench/BASELINE.md` → "Round 4 before" / "Round 4 after".

- **Viewport scroll (scenario 4) — the large-dirty win:** TS p50 ~1.908 →
  ~1.154 ms (−39.5%), Rust scroll-churn p50 ~1.957 → ~1.317 ms (−32.7%).
  Every scroll frame takes the full-repaint fallback, and the measured
  dominant cost was the **layout reconcile walk running twice** — once in
  `paint_dirty` (to compute the dirty union) and once inside `paint_full`.
  Passing the already-computed rects through the fallback removes the second
  walk, which is most of the gain.
- **Alternating full screens (scenario 5):** flat (~0.39 → ~0.38 ms p50,
  5009 bytes/frame unchanged). Its cost is dominated by painting 4720 cells
  and flushing the full viewport, not by the layout/signature work this round
  removed — honest record: no regression, byte cost unchanged.
- **One-cell and no-change scenarios: no regression.** Single-cell p50 −3.3%
  (TS) / −1.4% (Rust); no-change frames hold at ~0; the requestFrame burst
  still collapses 1000 calls into 1 native render (ratio ~1.1, macrotask
  noise — the before-run in the same session measured 1.11).

### 12. Large-dirty path (tern-components + tern-core)

The round-4 work is four small changes, each removing a per-frame cost from
the large-dirty path (`src/core/tern-components/src/compositor.rs` +
`src/core/tern-core/src/buffer.rs`):

1. **Scratch-frame pooling** — the dirty path's scratch frame is a pooled
   `Compositor` field, sized on demand and grown when the viewport grows: no
   per-frame viewport-sized allocation. Only the dirty-union region is
   cleared before repainting (`Buffer::clear_rect`) — a cheap clear instead
   of blanking the whole viewport for a one-cell repaint.
2. **Retained-buffer reuse** — the dirty path moves the retained buffer out
   and patches the union in place, cloning once for the new retained frame
   (was: two full clones + a fresh scratch allocation per frame). The paint
   order is rebuilt into a pooled list.
3. **Dirty-union walk without an id list** — the union is computed in two
   passes over the retained and current rect maps (ids that had geometry last
   frame, then ids that gained geometry this frame): no per-frame id-list
   allocation, sort or dedup. The all-node old-vs-new rect comparison is
   unchanged — it remains the repaint region's correctness backbone.
4. **Full-repaint path** — `paint_full` reuses the retained buffer as its
   paint target (cleared in place, one clone for the caller), rebuilds the
   retained paint signatures only for the mutation-site pushed ids (or every
   id on a force scan) instead of the whole-tree walk — a later dirty pass
   treats a missing baseline conservatively as a change, so no repaint is
   ever lost — and, the measured dominant win, receives the rects the dirty
   path already computed when it falls back past the >half-viewport
   threshold, so a large-dirty frame runs the layout reconcile walk **once**
   instead of twice. The union copy is `Buffer::copy_region` — row-major
   slice copies instead of per-cell bounds-checked clones.

Rerun both benches on the same machine after any render-path change to
quantify the delta — `tools/bench/run.sh` prints both comparison tables
automatically.

## Architecture diagram: unchanged

The data-flow diagram in [`architecture.md`](architecture.md) (steps 1–8:
JS reconciler → `packages/core` → tern-node → tern-core → tern-layout →
Compositor paints into a Buffer → tern-terminal diffs → terminal flush) was
reviewed against the current code and still matches: this work added no-op
fast paths *inside* the render stages, a coalesced-scheduling API on top of
the renderer, made the layout engine + compositor stateful (retained
buffer, cached taffy tree, incremental layout, dirty-region repaint), and
replaced the per-frame whole-tree paint-signature walk with a mutation-site
pushed dirty set (round 3) — but the data-flow steps themselves did not
change, so the diagram was left untouched.
