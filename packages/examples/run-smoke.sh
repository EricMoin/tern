#!/usr/bin/env bash
# run-smoke.sh — PTY smoke for the @tern/examples demos.
#
# Runs react-demo and solid-demo inside a macOS `script` pseudo-TTY with 'q'
# piped into it, and asserts each exits 0. A demo only exits 0 when its
# scene rendered AND the event loop quit on 'q' — each demo asserts its
# scene (a box column holding the two expected text leaves), paints it, and
# prints "ok: ... quit on 'q'" before exiting 0.
#
# Runtime: Deno-first (project preference). Each demo runs under
# `deno run --allow-all`; a demo falls back to `node` on its own only when
# Deno cannot load the native Node-API addon, and reports which runtime it
# actually used via a "[<demo>] runtime: <deno|node>" line. When the `deno`
# binary is absent entirely, this script runs the demos under `node` and
# says so. Either way the runtime each demo used is reported below.
#
# Usage: bash packages/examples/run-smoke.sh
# Exit: 0 when both demos pass; 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root: deno must run from here so the workspace deno.json (and the
# root node_modules npm deps) resolve @tern/core / @tern/react / @tern/solid.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v script >/dev/null 2>&1; then
  echo "run-smoke: FAIL — the macOS 'script' PTY utility is required" >&2
  exit 1
fi

# macOS `script`: -q quiet, /dev/null discards the session transcript. The
# child's exit status propagates through script (verified on macOS).
PTY_CMD=(script -q /dev/null)

# Deno-first; node only when deno is not installed. The addon-load fallback
# (deno present but unable to load the native addon) is handled inside the
# demos themselves.
if command -v deno >/dev/null 2>&1; then
  RUN_CMD=(deno run --allow-all)
else
  echo "run-smoke: note — 'deno' not found; running demos under 'node' (fallback)"
  RUN_CMD=(node)
fi

pass=0
fail=0

run_demo() {
  local name="$1"
  local file="$2"
  local out status runtime

  echo "==> [$name] PTY run under '${RUN_CMD[0]}' with 'q' piped in"

  out="$(printf 'q' | "${PTY_CMD[@]}" "${RUN_CMD[@]}" "$file" 2>&1)"
  status=$?

  # The demo reports its own runtime (deno, or node after a fallback).
  runtime="$(printf '%s\n' "$out" | sed -n 's/.*runtime: \([a-z]*\).*/\1/p' | tail -1)"
  [ -n "$runtime" ] || runtime="unknown"

  if [ "$status" -eq 0 ]; then
    pass=$((pass + 1))
    echo "==> [$name] PASS (exit 0, runtime: $runtime)"
  else
    fail=$((fail + 1))
    echo "==> [$name] FAIL (exit $status, runtime: $runtime)"
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
  echo
}

echo "tern examples PTY smoke"
echo "======================="
run_demo react-demo "$SCRIPT_DIR/react-demo.ts"
run_demo solid-demo "$SCRIPT_DIR/solid-demo.ts"

echo "======================="
if [ "$fail" -eq 0 ]; then
  echo "run-smoke: PASS — react-demo and solid-demo both rendered and quit on 'q'"
  exit 0
fi
echo "run-smoke: FAIL — $fail demo(s) failed"
exit 1
