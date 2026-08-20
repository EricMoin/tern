#!/usr/bin/env bash
# run-smoke.sh — PTY smoke for the @tern/examples demos.
#
# Runs the seven demos (react-demo, solid-demo, kitchen-sink-react,
# kitchen-sink-solid, agent-transcript, file-browser, diff-review) inside a
# macOS `script` pseudo-TTY, resizes the PTY mid-session, then pipes 'q' in,
# and asserts each exits 0. A demo only
# exits 0 when its scene rendered AND its scene assertions held AND the
# event loop quit on 'q' — each demo asserts its scene, paints it, and
# prints "ok: ..." lines (with a final "quit on 'q'" line) before exiting 0.
#
# Beyond the demos the harness runs the signal-lifecycle cases (M1.4:
# SIGTERM clean exit + termios restored, SIGTSTP/SIGCONT suspend-resume
# against signal-demo.ts) and the TERM=dumb degradation case (M1.5:
# dumb-term-demo.ts — createRenderer must refuse the non-interactive
# terminal with no ESC bytes written).
#
# Runtime: Deno-first (project preference). Each demo runs under
# `deno run --allow-all`; a demo falls back to `node` on its own only when
# Deno cannot load the native Node-API addon, and reports which runtime it
# actually used via a "[<demo>] runtime: <deno|node>" line. When the `deno`
# binary is absent entirely, this script runs the demos under `node` and
# says so. Either way the runtime each demo used is reported below.
#
# Usage: bash packages/examples/run-smoke.sh
# Exit: 0 when all seven demos and the signal/TERM=dumb cases pass;
# 1 otherwise.

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

# The signal-case PTY: the same `script` PTY without the mid-session resize.
# The signal cases hold a stable 24x80 viewport so the termios snapshot
# comparison (SIGTERM case) and the suspend/resume timing are deterministic.
PTY_SIG_CMD=(script -q /dev/null sh -c 'stty rows 24 cols 80; exec "$@"' sh)

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
run_demo agent-transcript "$SCRIPT_DIR/agent-transcript.ts"
run_demo file-browser "$SCRIPT_DIR/file-browser.ts"
run_demo diff-review "$SCRIPT_DIR/diff-review.ts"

# ---------------------------------------------------------------------------
# Signal lifecycle cases (roadmap M1.4): SIGTERM clean exit and
# SIGTSTP/SIGCONT suspend-resume against the signal demo.
#
# The demo runs in the FOREGROUND of the PTY (exactly like the seven demos,
# so its push event loop reads 'q' from the PTY master); a background helper
# inside the same sh drives the signals, addressing the demo through the
# pidfile the demo writes at startup. The sh survives the demo (it is not
# exec'd), so the SIGTERM case can snapshot `stty -g` after the demo exited
# — the PTY is still alive — proving the signal teardown restored the
# termios (no raw-mode residue).
# ---------------------------------------------------------------------------

# (a) SIGTERM to a live demo: the native signal thread runs the destroy-style
# teardown and exits with 128 + SIGTERM = 143; the PTY must show the
# pre-demo termios again.
run_sigterm_case() {
  local name="signal-term"
  echo "==> [$name] SIGTERM at 1.5s: clean exit 143 + termios restored"
  local out status termios_ok sigterm_status
  out="$("${PTY_SIG_CMD[@]}" sh -c '
    stty -g > /tmp/tern-termios.sane
    ( sleep 1.5; DEMO=$(cat /tmp/tern-signal-demo.pid 2>/dev/null); kill -TERM "$DEMO" ) &
    "$@"
    STATUS=$?
    stty -g > /tmp/tern-termios.after
    echo "SIGTERM_STATUS=$STATUS"
    if cmp -s /tmp/tern-termios.sane /tmp/tern-termios.after; then
      echo "TERMIOS_SANE=yes"
    else
      echo "TERMIOS_SANE=no"
    fi
    rm -f /tmp/tern-termios.sane /tmp/tern-termios.after
  ' sh "${RUN_CMD[@]}" "$SIGNAL_DEMO" 2>&1)"
  status=$?
  termios_ok="$(printf '%s\n' "$out" | sed -n 's/.*TERMIOS_SANE=\([a-z]*\).*/\1/p' | tail -1)"
  sigterm_status="$(printf '%s\n' "$out" | sed -n 's/.*SIGTERM_STATUS=\([0-9]*\).*/\1/p' | tail -1)"
  if [ "$status" -eq 0 ] && [ "$sigterm_status" -eq 143 ] && [ "$termios_ok" = "yes" ] \
    && printf '%s\n' "$out" | grep -q "ok: rendered (alive)"; then
    pass=$((pass + 1))
    echo "==> [$name] PASS (exit $sigterm_status, termios restored, demo marker present)"
  else
    fail=$((fail + 1))
    echo "==> [$name] FAIL (script exit $status, demo exit ${sigterm_status:-?}, termios $termios_ok)"
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
  echo
}

# (b) SIGTSTP then SIGCONT: the demo suspends (terminal restored), resumes
# (terminal re-entered + full repaint), and quits on 'q' with exit 0. The
# 'q' is piped into the PTY master after the suspend/resume window, so the
# demo reads it once its event loop is live again.
run_tstp_cont_case() {
  local name="signal-tstp-cont"
  echo "==> [$name] SIGTSTP at 1.5s, SIGCONT at 2.3s, 'q' at 5s: resume + repaint + exit 0"
  local out status tstp_status
  out="$({ sleep 5; printf 'q'; } | "${PTY_SIG_CMD[@]}" sh -c '
    ( sleep 1.5; DEMO=$(cat /tmp/tern-signal-demo.pid 2>/dev/null); kill -TSTP "$DEMO"; sleep 0.8; kill -CONT "$DEMO" ) &
    "$@"
    echo "TSTP_CONT_STATUS=$?"
  ' sh "${RUN_CMD[@]}" "$SIGNAL_DEMO" 2>&1)"
  status=$?
  tstp_status="$(printf '%s\n' "$out" | sed -n 's/.*TSTP_CONT_STATUS=\([0-9]*\).*/\1/p' | tail -1)"
  if [ "$status" -eq 0 ] && [ "$tstp_status" -eq 0 ] \
    && printf '%s\n' "$out" | grep -q "ok: resumed after SIGCONT + repainted" \
    && printf '%s\n' "$out" | grep -q "quit on 'q'"; then
    pass=$((pass + 1))
    echo "==> [$name] PASS (exit 0, resumed + repainted, quit on 'q')"
  else
    fail=$((fail + 1))
    echo "==> [$name] FAIL (script exit $status, demo exit ${tstp_status:-?})"
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
  echo
}

SIGNAL_DEMO="$SCRIPT_DIR/signal-demo.ts"
run_sigterm_case
run_tstp_cont_case

# (c) TERM=dumb degradation (roadmap M1.5): `createRenderer({})`
# (non-headless) must refuse to construct on a non-interactive terminal —
# the native guard errors with "tern requires an interactive terminal
# (TERM=dumb or non-TTY)" BEFORE any terminal I/O. The demo catches the
# expected error and exits 0. Assert the message appears AND that no ESC
# byte was written: a guard that fired before any terminal I/O leaves the
# demo's stdout pure text (an escape sequence before the error would mean
# the guard ran too late and dirtied the terminal).
#
# The demo's stderr is redirected INSIDE the PTY (to a file, displayed below
# but not asserted on): deno writes its own TTY progress-erase escape
# sequences to stderr at startup whenever the PTY has a valid window size —
# a deno artifact, not tern — so a merged 2>&1 capture would fail the no-ESC
# assertion no matter how clean the renderer behaved. The demo prints its
# markers and the expected error message via console.log (stdout), which is
# where any premature renderer sequence would land.
run_dumb_term_case() {
  local name="term-dumb"
  echo "==> [$name] TERM=dumb: createRenderer refuses the non-interactive terminal"
  local out err status
  local stderr_file="/tmp/tern-dumb-stderr.txt"
  rm -f "$stderr_file"
  out="$(TERM=dumb script -q /dev/null sh -c 'stty rows 24 cols 80; exec "$@" 2>/tmp/tern-dumb-stderr.txt' sh "${RUN_CMD[@]}" "$DUMB_DEMO" 2>&1)"
  status=$?
  err="$(cat "$stderr_file" 2>/dev/null)"
  rm -f "$stderr_file"
  if [ "$status" -eq 0 ] \
    && printf '%s\n' "$out" | grep -q "tern requires an interactive terminal" \
    && ! printf '%s\n' "$out" | grep -q "$(printf '\033')"; then
    pass=$((pass + 1))
    echo "==> [$name] PASS (exit 0, expected error, no ESC bytes written)"
  else
    fail=$((fail + 1))
    echo "==> [$name] FAIL (exit $status)"
  fi
  { printf '%s\n' "$out"; printf '%s\n' "$err"; } | sed 's/^/    /'
  echo
}

DUMB_DEMO="$SCRIPT_DIR/dumb-term-demo.ts"
run_dumb_term_case

echo "======================="
if [ "$fail" -eq 0 ]; then
  echo "run-smoke: PASS — all 7 demos (react-demo, solid-demo, kitchen-sink-react, kitchen-sink-solid, agent-transcript, file-browser, diff-review) survived the pty resize (80x24 -> 111x31), rendered, asserted their scenes, and quit on 'q'; signal cases passed (SIGTERM clean exit 143 + termios restored; SIGTSTP/SIGCONT resume + repaint + exit 0); TERM=dumb degradation case passed (createRenderer refused the non-interactive terminal, no ESC bytes)"
  exit 0
fi
echo "run-smoke: FAIL — $fail demo(s)/case(s) failed (7 demos, signal cases, or the TERM=dumb case)"
exit 1
