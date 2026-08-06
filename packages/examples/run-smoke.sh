#!/usr/bin/env bash
# run-smoke.sh — PTY smoke for the @tern/examples demos.
#
# Runs the four demos (react-demo, solid-demo, kitchen-sink-react,
# kitchen-sink-solid) inside a macOS `script` pseudo-TTY, resizes the PTY
# mid-session, then pipes 'q' in, and asserts each exits 0. A demo only
# exits 0 when its scene rendered AND its scene assertions held AND the
# event loop quit on 'q' — each demo asserts its scene, paints it, and
# prints "ok: ..." lines (with a final "quit on 'q'" line) before exiting 0.
#
# Runtime: Deno-first (project preference). Each demo runs under
# `deno run --allow-all`; a demo falls back to `node` on its own only when
# Deno cannot load the native Node-API addon, and reports which runtime it
# actually used via a "[<demo>] runtime: <deno|node>" line. When the `deno`
# binary is absent entirely, this script runs the demos under `node` and
# says so. Either way the runtime each demo used is reported below.
#
# Usage: bash packages/examples/run-smoke.sh
# Exit: 0 when all four demos pass; 1 otherwise.

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
#
# `script` allocates a 0x0 PTY when launched without a controlling tty, which
# makes the compositor's scene geometry queries (`Renderer.hit_test`) return
# empty paths for every cell. The session pins a deterministic 80x24 viewport
# (via `stty` inside the PTY) so the demos' mouse-routing assertions
# (wheel scroll + click-to-focus) exercise the real hit-test gate.
#
# Resize coverage — the works-over-a-pty (incl. ssh) property: a backgrounded
# `stty -f /dev/tty rows 31 cols 111` fires ~0.8s into the session, resizing
# the PTY while the demo is live, BEFORE the 'q' input is fed (fed at ~1.5s).
# Background jobs in a non-interactive shell have /dev/null stdin, so the
# resize targets the controlling terminal explicitly (`stty -f /dev/tty`,
# macOS syntax). The window-size change raises SIGWINCH to the foreground
# process group, which crossterm 0.29 turns into a `Resize` event
# (`event/source/unix/tty.rs:72`) — the same path an `ssh host -t tern`
# session exercises when the client window resizes. The demo must still exit 0
# after the resize; a demo that misrenders or crashes on a pty resize fails
# here. The timings (resize 0.8s, input 1.5s) land inside every demo's 5s
# event-loop deadline while keeping the resize strictly before the input.
PTY_CMD=(script -q /dev/null sh -c 'stty rows 24 cols 80; (sleep 0.8; stty -f /dev/tty rows 31 cols 111) & exec "$@"' sh)

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

  echo "==> [$name] PTY run under '${RUN_CMD[0]}' (resize at 0.8s, 'q' at 1.5s)"

  # The PTY session resizes itself at ~0.8s (see PTY_CMD above); the 'q'
  # input is held until ~1.5s so every demo observes the resize while its
  # event loop is live and still quits cleanly afterwards.
  out="$({ sleep 1.5; printf 'q'; } | "${PTY_CMD[@]}" "${RUN_CMD[@]}" "$file" 2>&1)"
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
run_demo kitchen-sink-react "$SCRIPT_DIR/kitchen-sink-react.ts"
run_demo kitchen-sink-solid "$SCRIPT_DIR/kitchen-sink-solid.ts"

echo "======================="
if [ "$fail" -eq 0 ]; then
  echo "run-smoke: PASS — all 4 demos (react-demo, solid-demo, kitchen-sink-react, kitchen-sink-solid) survived the pty resize (80x24 -> 111x31), rendered, asserted their scenes, and quit on 'q'"
  exit 0
fi
echo "run-smoke: FAIL — $fail demo(s) failed"
exit 1
