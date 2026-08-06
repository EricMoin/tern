#!/usr/bin/env bash
# run.sh — run the tern render benchmarks and print the before/after
# comparison tables (recorded baseline vs current code). Tables printed:
# round 1 (the canonical pre-optimization baseline), round 2 (incremental
# rendering), round 3 (pushed dirty set), round 4 (large-dirty frames).
#
# Executes the canonical benches from tools/bench/BASELINE.md:
#
#   1. Rust compositor pipeline (release profile), all three bench blocks in
#      src/core/tern-components/tests/bench_timing.rs:
#        - "render pipeline bench"        — the round-1 baseline: static
#          scene, paint + diff + flush (paint-dominated).
#        - "incremental-layout target"    — the round-2 before: one cell
#          mutated per frame, paint + diff + flush (what incremental layout
#          will cut).
#        - "scroll-churn bench"           — the round-4 before: one-row
#          viewport scroll per frame (full-repaint threshold), time AND
#          flushed bytes per frame into the sink.
#        cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture
#   2. TS renderer bench (real tern-node addon, real terminal, PTY):
#        deno run --allow-all tools/bench/render.bench.ts
#      (wrapped in `script` on macOS so the raw-mode bench gets a PTY, sized
#       to the synthetic scene's 120x40 viewport via `stty` — WITHOUT the
#       explicit size the PTY reports 0x0 in headless shells, and a 0x0
#       viewport is the native "never painted" sentinel, which disables the
#       scene-epoch no-op fast path and skews every scenario). The bench
#       times six scenarios against the same synthetic scene:
#        scenario 0 — animated round-trip (the round-1 canonical number)
#        scenario 1 — no-change frames (scene-epoch idle fast path)
#        scenario 2 — single-cell change frames (incremental-layout target)
#        scenario 3 — requestFrame burst (frame coalescing, native render
#                     count must be 1 per burst)
#        scenario 4 — viewport scroll (one-row shift per frame; dirty union
#                     trips the full-repaint threshold)
#        scenario 5 — alternating full screens (whole-viewport diff every
#                     frame; prints flushed bytes per frame)
#
# The recorded baseline numbers are read from tools/bench/BASELINE.md and
# printed next to the fresh run so the delta is visible at a glance. The TS
# bench loads whatever addon profile is currently built (debug vs release
# changes the absolute numbers by an order of magnitude — see BASELINE.md),
# so the script prints the addon build profile it measured against.
#
# Exit codes: 0 when both benches ran (the TS bench may SKIP headlessly and
# still exit 0, per its contract); non-zero when the Rust bench fails or the
# script itself errors.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || { echo "run.sh: cannot cd to repo root $REPO_ROOT" >&2; exit 1; }

# --- Recorded baselines (from tools/bench/BASELINE.md, 2026-08-04) ---------
# Keep these in sync with the tables in BASELINE.md. They are the canonical
# numbers recorded when the harness landed.
#
# Round 1 (the canonical pre-optimization baseline, recorded when the harness
# landed; the round-1 optimization round measured ~0.5% Rust / ~1.8% TS p50
# movement on the same scene — see BASELINE.md).
RUST_BASE_MEAN_MS=1.292
RUST_BASE_P50_MS=1.284
RUST_BASE_P95_MS=1.349
RUST_BASE_CELLS_PER_SEC=3714736
TS_BASE_MEAN_MS=22.121
TS_BASE_P50_MS=22.001
TS_BASE_FPS=45.2
#
# Round 2 before (recorded 2026-08-04 on the round-2 pre-optimization code —
# round-1 optimizations present, no incremental layout yet; release addon,
# PTY sized 120x40; representative run of 3-4):
R2_RUST_BASE_MEAN_MS=1.439
R2_RUST_BASE_P50_MS=1.394
R2_S1_BASE_MEAN_MS=0.000
R2_S1_BASE_P50_MS=0.000
R2_S2_BASE_MEAN_MS=1.325
R2_S2_BASE_P50_MS=1.313
R2_S2_BASE_FPS=754.7
R2_S3_BASE_BURST_MS=3.662
R2_S3_BASE_RATIO=1.00
#
# Round 3 before (recorded 2026-08-05 = the round-2 AFTER numbers — the state
# the round-3 pushed-dirty-set work must beat; same release addon, PTY sized
# 120x40; representative run + avg of 3, see BASELINE.md "Round 2 after"):
R3_S0_BASE_MEAN_MS=0.894
R3_S0_BASE_P50_MS=0.881
R3_S0_BASE_FPS=1119.0
R3_S1_BASE_MEAN_MS=0.000
R3_S1_BASE_P50_MS=0.000
R3_S2_BASE_MEAN_MS=0.881
R3_S2_BASE_P50_MS=0.877
R3_S2_BASE_FPS=1135.0
R3_S3_BASE_BURST_MS=3.66
R3_S3_BASE_RATIO=1.02
R3_RUST_BASE_MEAN_MS=0.877
R3_RUST_BASE_P50_MS=0.871
#
# Round 4 before (recorded 2026-08-05 = the current tree — grapheme-cluster
# round landed — the state the large-dirty optimization work must beat; same
# release addon, PTY sized 120x40; avg of 3, see BASELINE.md "Round 4
# before"):
R4_S4_BASE_MEAN_MS=1.937
R4_S4_BASE_P50_MS=1.908
R4_S4_BASE_FPS=516.6
R4_S5_BASE_MEAN_MS=0.392
R4_S5_BASE_P50_MS=0.389
R4_S5_BASE_FPS=2551.0
R4_S5_BASE_BYTES=5009
R4_RUST_BASE_MEAN_MS=2.066
R4_RUST_BASE_P50_MS=1.957
R4_RUST_BASE_BYTES=4904

# --- Helpers ----------------------------------------------------------------

# Compute a signed percentage delta: pct_change <new> <old>
pct_change() {
  awk -v n="$1" -v o="$2" 'BEGIN { if (o == 0) { print "n/a"; exit } printf "%+.1f%%", (n - o) / o * 100 }'
}

# Print one before/after table row: <metric> <unit> <before> <after>
row() {
  local metric="$1" unit="$2" before="$3" after="$4"
  local delta
  if [ "$after" = "n/a" ] || [ "$before" = "n/a" ] || [ -z "$after" ] || [ "$before" = "0" ] || [ "$before" = "0.000" ]; then
    delta="n/a"
  else
    delta="$(pct_change "$after" "$before")"
  fi
  printf "  %-30s %-7s %-14s %-14s %s\n" "$metric" "$unit" "$before" "$after" "$delta"
}

# Print a row whose delta is a ratio (e.g. fps): <metric> <unit> <before> <after>
row_ratio() {
  local metric="$1" unit="$2" before="$3" after="$4"
  local ratio
  if [ "$after" = "n/a" ] || [ "$before" = "n/a" ] || [ -z "$after" ] || [ "$before" = "0" ] || [ "$before" = "0.000" ]; then
    ratio="n/a"
  else
    ratio="$(awk -v n="$after" -v o="$before" 'BEGIN { if (o == 0) { print "n/a"; exit } printf "x%.1f", n / o }')"
  fi
  printf "  %-30s %-7s %-14s %-14s %s\n" "$metric" "$unit" "$before" "$after" "$ratio"
}

# Extract the n-th occurrence of a numeric metric from a text blob:
#   nth_val <blob> <label-regex> <occurrence>
# (`|` is the sed delimiter because labels such as "cells/sec" contain `/`;
# `: *` tolerates the varying space alignment of the printed reports.)
nth_val() {
  printf '%s\n' "$1" | sed -n "s|^${2}: *\([0-9.]*\).*$|\1|p" | sed -n "${3}p"
}

# --- 1. Rust bench ----------------------------------------------------------

echo "======================================================================"
echo "1/2: Rust compositor pipeline bench (release, paint+diff+flush)"
echo "     - render pipeline bench (round-1 static scene)"
echo "     - incremental-layout target bench (1 cell changed per frame)"
echo "     - scroll-churn bench (one-row viewport scroll per frame + bytes)"
echo "======================================================================"
RUST_OUT="$(cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture 2>&1)"
RUST_CODE=$?
printf '%s\n' "$RUST_OUT" | sed -n '/^=== tern-components .* bench ===/,/^=== end bench ===/p'
if [ "$RUST_CODE" -ne 0 ]; then
  echo "run.sh: Rust bench FAILED (exit $RUST_CODE) — see output above." >&2
  exit "$RUST_CODE"
fi

# Block 1: render pipeline bench (round-1 baseline metrics).
RUST_MEAN="$(nth_val "$RUST_OUT" "mean" 1)"
RUST_P50="$(nth_val "$RUST_OUT" "p50" 1)"
RUST_P95="$(nth_val "$RUST_OUT" "p95" 1)"
RUST_CELLS="$(nth_val "$RUST_OUT" "cells/sec" 1)"
# Block 2: incremental-layout target bench (round-2 before metrics).
R2_RUST_MEAN="$(nth_val "$RUST_OUT" "mean" 2)"
R2_RUST_P50="$(nth_val "$RUST_OUT" "p50" 2)"
# Block 3: scroll-churn bench (round-4 before metrics: time + flushed bytes).
R4_RUST_MEAN="$(nth_val "$RUST_OUT" "mean" 3)"
R4_RUST_P50="$(nth_val "$RUST_OUT" "p50" 3)"
R4_RUST_BYTES="$(nth_val "$RUST_OUT" "bytes/frame" 1)"

if [ -z "$RUST_P50" ]; then
  echo "run.sh: could not parse Rust bench output (p50 missing)." >&2
  exit 1
fi

# --- 2. TS bench ------------------------------------------------------------

echo
echo "======================================================================"
echo "2/2: TS renderer bench (real addon, real terminal, 6 scenarios)"
echo "======================================================================"
ADDON_PATH="src/bindings/tern-node/tern-node.darwin-arm64.node"
if [ -f "$ADDON_PATH" ]; then
  ADDON_BYTES="$(wc -c < "$ADDON_PATH" | tr -d ' ')"
  # Debug-profile napi builds are several times larger than release builds;
  # a heuristic only — the exact profile is whatever `napi build` last used.
  if [ "$ADDON_BYTES" -gt 12000000 ]; then
    ADDON_PROFILE="debug (heuristic)"
  else
    ADDON_PROFILE="release (heuristic)"
  fi
  echo "addon: $ADDON_PATH ($ADDON_BYTES bytes, ~$ADDON_PROFILE)"
else
  echo "addon: NOT BUILT at $ADDON_PATH — TS bench will SKIP."
  ADDON_PROFILE="unavailable"
fi

# The bench runs in raw mode under `script`; the PTY is sized to the
# synthetic scene's 120x40 viewport (a 0x0 PTY would be the native
# "never painted" sentinel and disable the epoch no-op fast path).
TS_OUT="$(script -q /dev/null sh -c 'stty cols 120 rows 40; deno run --allow-all tools/bench/render.bench.ts' 2>&1)"
TS_CODE=$?
# The bench runs in raw mode under `script`, so its stdout carries terminal
# escape sequences (plus a literal "^D" script echoes at EOF); strip them.
TS_CLEAN="$(printf '%s\n' "$TS_OUT" \
  | sed $'s/\033\[[0-9;?]*[a-zA-Z]//g; s/\033\][^\a]*\a//g; s/\r//g; s/\^D//g' \
  | tr -d '\000-\010\013\014\016-\037')"

if printf '%s\n' "$TS_CLEAN" | grep -q "render.bench: SKIP"; then
  printf '%s\n' "$TS_CLEAN" | grep "render.bench: SKIP"
  echo "run.sh: TS bench skipped (no addon or no PTY) — TS rows below show 'n/a'."
  TS_OK=0
else
  TS_OK=1
  # The raw-mode renderer paints frames to the same stdout the bench reports
  # on, so frame content can interleave with the report lines (a scenario
  # header may carry a frame-glyph prefix). The metric lines start at the
  # column origin and are always clean; the anchored filter drops the
  # interleaved frame noise while keeping every report line.
  printf '%s\n' "$TS_CLEAN" | grep -E "^render\.bench:|^  mean:|^  p50:|^  fps:|^  mean burst:|^  p50 burst:|^  mean single:|^  coalescing ratio:|^  expected native|^  no-op|^  bytes per frame:"
fi
if [ "$TS_CODE" -ne 0 ]; then
  echo "run.sh: TS bench exited non-zero ($TS_CODE)." >&2
fi

# Parse the per-scenario metrics (scenario order in the bench output is
# fixed: 0 = round-trip, 1 = no-change, 2 = single-cell, 3 = burst,
# 4 = viewport scroll, 5 = alternating full screens).
if [ "$TS_OK" = "1" ]; then
  TS_MEAN="$(nth_val "$TS_CLEAN" "  mean" 1)"
  TS_P50="$(nth_val "$TS_CLEAN" "  p50" 1)"
  TS_FPS="$(nth_val "$TS_CLEAN" "  fps" 1)"
  S1_MEAN="$(nth_val "$TS_CLEAN" "  mean" 2)"
  S1_P50="$(nth_val "$TS_CLEAN" "  p50" 2)"
  S2_MEAN="$(nth_val "$TS_CLEAN" "  mean" 3)"
  S2_P50="$(nth_val "$TS_CLEAN" "  p50" 3)"
  S2_FPS="$(nth_val "$TS_CLEAN" "  fps" 3)"
  S3_BURST_MEAN="$(nth_val "$TS_CLEAN" "  mean burst" 1)"
  S3_BURST_P50="$(nth_val "$TS_CLEAN" "  p50 burst" 1)"
  S3_SINGLE_MEAN="$(nth_val "$TS_CLEAN" "  mean single" 1)"
  S3_RATIO="$(nth_val "$TS_CLEAN" "  coalescing ratio" 1)"
  S3_EXPECTED="$(nth_val "$TS_CLEAN" "  expected native renders per burst" 1)"
  S4_MEAN="$(nth_val "$TS_CLEAN" "  mean" 4)"
  S4_P50="$(nth_val "$TS_CLEAN" "  p50" 4)"
  S4_FPS="$(nth_val "$TS_CLEAN" "  fps" 4)"
  S5_MEAN="$(nth_val "$TS_CLEAN" "  mean" 5)"
  S5_P50="$(nth_val "$TS_CLEAN" "  p50" 5)"
  S5_FPS="$(nth_val "$TS_CLEAN" "  fps" 5)"
  S5_BYTES="$(nth_val "$TS_CLEAN" "  bytes per frame" 1)"
else
  TS_MEAN=""; TS_P50=""; TS_FPS=""
  S1_MEAN=""; S1_P50=""
  S2_MEAN=""; S2_P50=""; S2_FPS=""
  S3_BURST_MEAN=""; S3_SINGLE_MEAN=""; S3_RATIO=""; S3_EXPECTED=""
  S4_MEAN=""; S4_P50=""; S4_FPS=""
  S5_MEAN=""; S5_P50=""; S5_FPS=""; S5_BYTES=""
fi

# --- 3. Round 1 before/after table ------------------------------------------

echo
echo "======================================================================"
echo "Round 1 comparison (baseline 2026-08-04 vs this run)"
echo "======================================================================"
echo "  metric                            unit     baseline       now            delta"
row "Rust p50 frame (static)" "ms" "$RUST_BASE_P50_MS" "$RUST_P50"
row "Rust mean frame (static)" "ms" "$RUST_BASE_MEAN_MS" "$RUST_MEAN"
row "Rust p95 frame (static)" "ms" "$RUST_BASE_P95_MS" "$RUST_P95"
row "Rust throughput (static)" "cells/s" "$RUST_BASE_CELLS_PER_SEC" "${RUST_CELLS:-n/a}"
if [ -n "$TS_P50" ]; then
  row "TS round-trip p50" "ms" "$TS_BASE_P50_MS" "$TS_P50"
  row "TS round-trip mean" "ms" "$TS_BASE_MEAN_MS" "$TS_MEAN"
  row_ratio "TS round-trip fps" "fps" "$TS_BASE_FPS" "$TS_FPS"
else
  row "TS round-trip p50" "ms" "$TS_BASE_P50_MS" "n/a"
  row "TS round-trip mean" "ms" "$TS_BASE_MEAN_MS" "n/a"
  row_ratio "TS round-trip fps" "fps" "$TS_BASE_FPS" "n/a"
fi

# --- 4. Round 2 before/after table ------------------------------------------

echo
echo "======================================================================"
echo "Round 2 comparison (before 2026-08-04 vs this run)"
echo "  scenarios: 1 = no-change frames (epoch idle), 2 = single-cell change,"
echo "  3 = requestFrame burst (1000 calls/burst); Rust = single-cell target"
echo "======================================================================"
echo "  metric                            unit     baseline       now            delta"
if [ -n "$S1_P50" ]; then
  row "TS no-change mean (s1)" "ms" "$R2_S1_BASE_MEAN_MS" "$S1_MEAN"
  row "TS no-change p50 (s1)" "ms" "$R2_S1_BASE_P50_MS" "$S1_P50"
  row "TS single-cell mean (s2)" "ms" "$R2_S2_BASE_MEAN_MS" "$S2_MEAN"
  row "TS single-cell p50 (s2)" "ms" "$R2_S2_BASE_P50_MS" "$S2_P50"
  row_ratio "TS single-cell fps (s2)" "fps" "$R2_S2_BASE_FPS" "$S2_FPS"
  row "TS burst mean (s3, 1000 reqs)" "ms" "$R2_S3_BASE_BURST_MS" "$S3_BURST_MEAN"
  row "TS burst/single ratio (s3)" "x" "$R2_S3_BASE_RATIO" "$S3_RATIO"
  row "Rust single-cell mean" "ms" "$R2_RUST_BASE_MEAN_MS" "$R2_RUST_MEAN"
  row "Rust single-cell p50" "ms" "$R2_RUST_BASE_P50_MS" "$R2_RUST_P50"
else
  row "TS no-change mean (s1)" "ms" "$R2_S1_BASE_MEAN_MS" "n/a"
  row "TS single-cell mean (s2)" "ms" "$R2_S2_BASE_MEAN_MS" "n/a"
  row "TS burst mean (s3)" "ms" "$R2_S3_BASE_BURST_MS" "n/a"
  row "Rust single-cell mean" "ms" "$R2_RUST_BASE_MEAN_MS" "$R2_RUST_MEAN"
fi

# --- 5. Round 3 before/after table ------------------------------------------
#
# Before = the round-2 AFTER numbers (2026-08-05, the state the round-3
# pushed-dirty-set change detection had to beat). The "now" columns reuse the
# fresh-run values parsed above ($R2_RUST_MEAN / $R2_RUST_P50 hold this run's
# Rust single-cell numbers; the R2_ prefix is historical).

echo
echo "======================================================================"
echo "Round 3 comparison (before 2026-08-05 vs this run)"
echo "  before = round-2 AFTER numbers (the state the pushed-dirty-set work"
echo "  must beat); scenarios: 0 = animated round-trip, 1 = no-change frames,"
echo "  2 = single-cell change, 3 = requestFrame burst (1000 calls/burst);"
echo "  Rust = single-cell target"
echo "======================================================================"
echo "  metric                            unit     baseline       now            delta"
if [ -n "$TS_P50" ]; then
  row "TS round-trip mean (s0)" "ms" "$R3_S0_BASE_MEAN_MS" "$TS_MEAN"
  row "TS round-trip p50 (s0)" "ms" "$R3_S0_BASE_P50_MS" "$TS_P50"
  row_ratio "TS round-trip fps (s0)" "fps" "$R3_S0_BASE_FPS" "$TS_FPS"
  row "TS no-change mean (s1)" "ms" "$R3_S1_BASE_MEAN_MS" "$S1_MEAN"
  row "TS no-change p50 (s1)" "ms" "$R3_S1_BASE_P50_MS" "$S1_P50"
  row "TS single-cell mean (s2)" "ms" "$R3_S2_BASE_MEAN_MS" "$S2_MEAN"
  row "TS single-cell p50 (s2)" "ms" "$R3_S2_BASE_P50_MS" "$S2_P50"
  row_ratio "TS single-cell fps (s2)" "fps" "$R3_S2_BASE_FPS" "$S2_FPS"
  row "TS burst mean (s3, 1000 reqs)" "ms" "$R3_S3_BASE_BURST_MS" "$S3_BURST_MEAN"
  row "TS burst/single ratio (s3)" "x" "$R3_S3_BASE_RATIO" "$S3_RATIO"
  row "Rust single-cell mean" "ms" "$R3_RUST_BASE_MEAN_MS" "$R2_RUST_MEAN"
  row "Rust single-cell p50" "ms" "$R3_RUST_BASE_P50_MS" "$R2_RUST_P50"
else
  row "TS single-cell mean (s2)" "ms" "$R3_S2_BASE_MEAN_MS" "n/a"
  row "TS single-cell p50 (s2)" "ms" "$R3_S2_BASE_P50_MS" "n/a"
  row "Rust single-cell mean" "ms" "$R3_RUST_BASE_MEAN_MS" "$R2_RUST_MEAN"
fi

# --- 6. Round 4 before/after table ------------------------------------------
#
# Before = the round-4 BEFORE numbers (2026-08-05, the state the large-dirty
# work must beat — the first harness covering the full-repaint threshold
# path; see BASELINE.md "Round 4 before"). The "now" columns reuse the
# fresh-run values parsed above ($R4_RUST_* holds this run's Rust
# scroll-churn numbers).

echo
echo "======================================================================"
echo "Round 4 comparison (before 2026-08-05 vs this run)"
echo "  large-dirty frames: scenario 4 = viewport scroll (one-row shift per"
echo "  frame, dirty union trips the full-repaint threshold), scenario 5 ="
echo "  alternating full screens (whole-viewport diff every frame, flushed"
echo "  bytes per frame); Rust = scroll-churn bench (time + bytes into the"
echo "  sink)"
echo "======================================================================"
echo "  metric                            unit     baseline       now            delta"
if [ -n "$S4_P50" ]; then
  row "TS scroll mean (s4)" "ms" "$R4_S4_BASE_MEAN_MS" "$S4_MEAN"
  row "TS scroll p50 (s4)" "ms" "$R4_S4_BASE_P50_MS" "$S4_P50"
  row_ratio "TS scroll fps (s4)" "fps" "$R4_S4_BASE_FPS" "$S4_FPS"
  row "TS full-screen mean (s5)" "ms" "$R4_S5_BASE_MEAN_MS" "$S5_MEAN"
  row "TS full-screen p50 (s5)" "ms" "$R4_S5_BASE_P50_MS" "$S5_P50"
  row_ratio "TS full-screen fps (s5)" "fps" "$R4_S5_BASE_FPS" "$S5_FPS"
  row "TS flushed bytes/frame (s5)" "B" "$R4_S5_BASE_BYTES" "$S5_BYTES"
  row "Rust scroll mean" "ms" "$R4_RUST_BASE_MEAN_MS" "$R4_RUST_MEAN"
  row "Rust scroll p50" "ms" "$R4_RUST_BASE_P50_MS" "$R4_RUST_P50"
  row "Rust scroll bytes/frame" "B" "$R4_RUST_BASE_BYTES" "$R4_RUST_BYTES"
else
  row "TS scroll mean (s4)" "ms" "$R4_S4_BASE_MEAN_MS" "n/a"
  row "TS full-screen mean (s5)" "ms" "$R4_S5_BASE_MEAN_MS" "n/a"
  row "Rust scroll mean" "ms" "$R4_RUST_BASE_MEAN_MS" "$R4_RUST_MEAN"
fi

echo
echo "Notes:"
echo "  - The round-1 recorded TS baseline was captured with a DEBUG-profile"
echo "    addon; the round-2 before numbers are captured with a RELEASE"
echo "    addon (npm run build:release). Absolute TS numbers depend on the"
echo "    addon profile built today (~$ADDON_PROFILE); compare round-2 rows"
echo "    only against other round-2 rows (same profile both sides)."
echo "  - Rust rows are apples-to-apples (release profile on both sides)."
echo "  - ROUND-2 SEMANTICS NOTE: the round-1 static Rust row now measures"
echo "    the retained-buffer no-op path (~0.01 ms) — an unchanged scene never"
echo "    reaches layout/paint under the round-2 compositor. That row's large"
echo "    delta is a semantics change, NOT a paint speedup; the honest"
echo "    'changed frame' comparison is the single-cell row (see BASELINE.md"
echo "    'Round 2 after')."
echo "  - Scenario 3's burst/single ratio ~1.0 proves the 1000 requestFrames"
echo "    collapsed into one native render (expected renders per burst:"
echo "    ${S3_EXPECTED:-n/a})."
echo "  - Round 3 compares against the round-2 AFTER numbers (same release"
echo "    profile both sides): the pushed-dirty-set change detection cut the"
echo "    per-frame whole-scene paint-signature walk to O(mutated). Scenario 0"
echo "    and 2 drop; scenario 1 stays ~0; scenario 3's ratio is the signal"
echo "    (its wall time is macrotask-latency dominated)."
echo "  - Round 4 before = the current tree (grapheme round landed): the first"
echo "    large-dirty coverage. Scenario 4 (viewport scroll) and scenario 5"
echo "    (alternating full screens) both diff ~the whole viewport and trip"
echo "    the >half-viewport full-repaint threshold — the path the one-cell"
echo "    scenarios never exercise. Scenario 5's bytes/frame (native"
echo "    last_flush_bytes, fed by the backend queue) and the Rust scroll"
echo "    bytes/frame (sink length) quantify the ANSI byte cost of a"
echo "    full-repaint frame. Round 4's optimization work must beat these."
echo "  - Full methodology: tools/bench/BASELINE.md."
