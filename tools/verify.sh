#!/usr/bin/env bash
# verify.sh — unified verification harness for the tern workspace.
#
# Runs the quality gates from the project constitution (§5 质量门) in order,
# fail-fast: the first gate that exits non-zero aborts the run.
#
#   gate 1: size      node tools/check-file-size.mjs
#                     (every hand-written source file is <= 800 lines)
#   gate 2: Rust      cargo build --workspace && cargo test --workspace
#   gate 3: JS types  npm run check            (deno check)
#   gate 4: JS tests  npm test                 (deno test)
#   gate 5: PTY smoke bash packages/examples/run-smoke.sh
#                     (macOS `script` PTY harness, demos must exit 0 on 'q')
#
# Usage: bash tools/verify.sh   (or ./tools/verify.sh from the repo root)
# Exit:  0 when all gates pass; the failing gate's exit code otherwise.
#
# Note: the PTY smoke (gate 5) requires the macOS `script` utility and the
# pre-built tern-node native addon (src/bindings/tern-node/tern-node.*.node).

set -u

# Resolve the repo root so the script works from any invocation directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "verify.sh: cannot cd to repo root $REPO_ROOT" >&2; exit 1; }

TOTAL=5
GATE=0

run_gate() {
  local label="$1"
  shift
  GATE=$((GATE + 1))
  echo
  echo "======================================================================"
  echo "gate $GATE/$TOTAL: $label"
  echo "======================================================================"
  "$@"
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo
    echo "verify.sh: gate $GATE/$TOTAL FAILED ($label) with exit code $code — aborting (fail-fast)." >&2
    exit "$code"
  fi
}

echo "tern verify.sh — unified verification harness (constitution §5 质量门)"
echo "repo root: $REPO_ROOT"

# gate 1: single-file line cap — cheapest gate, runs first (fail-fast)
run_gate "node tools/check-file-size.mjs (source file line cap)" bash -c "node tools/check-file-size.mjs"

# gate 2: Rust workspace build + tests (constitution: cargo build + test 全绿)
run_gate "cargo build --workspace && cargo test --workspace" bash -c "cargo build --workspace && cargo test --workspace"

# gate 3: JS type check via deno (constitution: deno check 全绿)
run_gate "npm run check (deno check)" bash -c "npm run check"

# gate 4: JS tests via deno (constitution: deno test 全绿)
run_gate "npm test (deno test)" bash -c "npm test"

# gate 5: PTY smoke — macOS `script` harness, demos must exit 0 on piped 'q'
run_gate "bash packages/examples/run-smoke.sh (PTY smoke)" bash -c "bash packages/examples/run-smoke.sh"

echo
echo "verify.sh: PASS — all $TOTAL gates exited 0 (file size, cargo build+test, deno check, deno test, PTY smoke)."
