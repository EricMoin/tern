#!/usr/bin/env bash
# run-e2e-tmux.sh — tmux end-to-end harness for the 7 @tern/examples demos.
#
# Runs each demo (react-demo, solid-demo, kitchen-sink-react,
# kitchen-sink-solid, agent-transcript, file-browser, diff-review) in a
# detached tmux session pinned to 80x24, waits for the demo's scene to
# render, asserts rendered content / the OSC 8 hyperlink escape sequence
# where required, sends 'q', and asserts the demo quit on 'q' (its final
# "ok: ... quit on 'q'" line) and that the session is gone (the session's
# initial command is the demo itself, so when the demo exits the window
# closes and `tmux has-session` fails).
#
# Channel design (empirically verified on tmux 3.7b, macOS):
#   - The session is created with the demo as its initial command
#     (`tmux new-session -d -s tern-e2e -x 80 -y 24 "<cmd>"`), so the
#     window closes when the demo exits and `has-session -t tern-e2e`
#     fails on its own — no shell lingers behind the demo.
#   - `tmux capture-pane -p` samples the grid, but the demos print their
#     scene-assertion lines to stdout while live, which overwrite the
#     painted cells; and the window (and its grid) is destroyed the moment
#     the demo exits, so the final "ok:" line is gone from the pane before
#     capture-pane can sample it. The authoritative channel is therefore a
#     `tmux pipe-pane` raw stream piped into a per-demo temp file (append
#     only, race-free): rendered-content markers, the OSC 8 escape bytes,
#     and the final "quit on 'q'" line are all grepped from that stream.
#     This is the same byte stream the pane displays; the grid resolution
#     step is skipped, which is what makes it reliable here.
#   - The OSC 8 assertion (kitchen-sink-react) still uses
#     `tmux capture-pane -p -e` as the primary channel (verified: with
#     `-e` tmux re-emits the stored `\x1b]8;;<url>\x1b\\` sequence from
#     the grid; without `-e` the bytes are stripped) with a raw-stream
#     fallback. Plain `-p` is never used for the OSC 8 assertion.
#   - Escape bytes are built with `printf '\x1b...'` (never typed into
#     the script) so the file stays greppable.
#
# Per-demo flow:
#   1. kill any leftover tern-e2e session; create a fresh pinned 80x24
#      session whose command is `cd $REPO_ROOT && <runtime> <file>`.
#   2. pipe the pane's raw stream into /tmp/tern-e2e-<name>.txt.
#   3. poll (0.1s) up to 15s for the demo's rendered-content marker in
#      the stream (and, for kitchen-sink-react, the OSC 8 open sequence
#      in a live `capture-pane -p -e` sample); on timeout, dump the
#      stream tail and fail.
#   4. assert the rendered cell strings for the rendered subset
#      (kitchen-sink-react: OSC 8 + tern.dev; agent-transcript:
#      "user: how do I sum a Vec<i32>?"; diff-review: "formatBytes" and
#      the status-line fragments "hunk"/"1/3" — the status line is painted
#      with cursor moves, so the grid string is not contiguous).
#   5. send 'q' (after a short grace so the input subscription is live),
#      then poll up to 10s for the demo's final "quit on 'q'" line in the
#      stream — the demo only prints it after its scene assertions held
#      AND the event loop quit on 'q' (one re-send of 'q' at 2s covers
#      the input-subscription race).
#   6. poll up to 5s for `tmux has-session -t tern-e2e` to fail — the
#      demo's exit closes the window.
#   7. cleanup: close the pipe, kill the session (both pass and fail).
#
# Usage: bash packages/examples/run-e2e-tmux.sh [bogus-demo]
#   With no args the normal 7-demo run executes. With a first arg, that
#   arg is treated as an extra demo whose source file does not exist
#   (e.g. `bogus-demo`); it runs through the same flow, cannot render,
#   and forces the harness down the failure path (exit 1) — used to
#   verify the forced-failure contract.
# Exit: 0 when every demo passes; 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root: deno must run from here so the workspace deno.json (and the
# root node_modules npm deps) resolve @tern/core / @tern/react / @tern/solid.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "run-e2e-tmux: FAIL — tmux is required" >&2
  exit 1
fi

# Deno-first; node only when deno is not installed (mirrors run-smoke.sh).
if command -v deno >/dev/null 2>&1; then
  RUN_CMD=(deno run --allow-all)
else
  echo "run-e2e-tmux: note — 'deno' not found; running demos under 'node' (fallback)"
  RUN_CMD=(node)
fi

SESSION="tern-e2e"

# The ESC byte and the OSC 8 open sequence, built via printf so no raw
# escape byte ever appears literally in this file.
ESC="$(printf '\033')"
OSC8_OPEN="${ESC}]8;;"

pass=0
fail=0

run_demo() {
  local name="$1"
  local file="$2"
  local marker="$3"        # rendered-content marker polled in the raw stream
  local osc8_demo="${4:-0}" # 1 = assert the OSC 8 hyperlink sequence (kitchen-sink-react)
  local tmpfile="/tmp/tern-e2e-${name}.txt"
  local out

  echo "==> [$name] tmux e2e (80x24, session '${SESSION}', runtime '${RUN_CMD[0]}')"

  # 1. Fresh session: the demo is the session's initial command, so the
  # window closes when the demo exits and has-session fails on its own.
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$tmpfile"
  tmux new-session -d -s "$SESSION" -x 80 -y 24 "cd '$REPO_ROOT' && ${RUN_CMD[*]} '$file'"

  # 2. Pipe the pane's raw stream to a temp file (line-flushed).
  tmux pipe-pane -t "$SESSION" -o "awk '{ print; fflush() }' >> '$tmpfile'"

  # 3. Poll for the rendered-content marker (and, for the OSC 8 demo, the
  # hyperlink sequence in a live `capture-pane -p -e` sample).
  local found=0 osc8_e=0 osc8_out="" i
  for i in $(seq 1 150); do
    grep -qF "$marker" "$tmpfile" 2>/dev/null && found=$i
    if [ "$osc8_demo" -eq 1 ]; then
      out="$(tmux capture-pane -p -e -t "$SESSION" 2>/dev/null)"
      if printf '%s' "$out" | grep -qF "${OSC8_OPEN}https://tern.dev${ESC}\\" 2>/dev/null; then
        osc8_e=$i
        osc8_out="$out"   # keep the capture that actually holds the sequence
      fi
      [ "$found" -gt 0 ] && [ "$osc8_e" -gt 0 ] && break
    else
      [ "$found" -gt 0 ] && break
    fi
    sleep 0.1
  done

  if [ "$found" -eq 0 ]; then
    fail=$((fail + 1))
    echo "==> [$name] FAIL (rendered-content marker '$marker' never appeared in 15s)"
    { tail -20 "$tmpfile" 2>/dev/null || true; } | sed 's/^/    /'
    tmux pipe-pane -t "$SESSION" -O 2>/dev/null || true
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$tmpfile"
    echo
    return
  fi

  # 4. Rendered-content assertions (assertion b) + OSC 8 (assertion c).
  local b_ok=1
  case "$name" in
    kitchen-sink-react)
      # Primary: live `capture-pane -p -e` (tmux re-emits stored OSC 8
      # hyperlinks only with -e). Fallback: the raw stream (same bytes).
      if [ "$osc8_e" -eq 0 ]; then
        if grep -qF "${OSC8_OPEN}https://tern.dev${ESC}\\" "$tmpfile" 2>/dev/null; then
          osc8_e=1
          echo "  note: OSC 8 asserted from the raw stream (capture-pane -p -e window closed early)"
        else
          b_ok=0
        fi
      fi
      if [ -n "$osc8_out" ]; then
        printf '%s' "$osc8_out" | grep -qF "tern.dev" || b_ok=0
      else
        grep -qF "tern.dev" "$tmpfile" || b_ok=0
      fi
      ;;
    agent-transcript)
      grep -qF "user: how do I sum a Vec<i32>?" "$tmpfile" || b_ok=0
      ;;
    diff-review)
      grep -qF "formatBytes" "$tmpfile" || b_ok=0
      grep -qF "hunk" "$tmpfile" || b_ok=0
      grep -qF "1/3" "$tmpfile" || b_ok=0
      ;;
  esac

  if [ "$b_ok" -eq 0 ]; then
    fail=$((fail + 1))
    echo "==> [$name] FAIL (rendered-content assertion did not hold)"
    { tail -20 "$tmpfile" 2>/dev/null || true; } | sed 's/^/    /'
    tmux pipe-pane -t "$SESSION" -O 2>/dev/null || true
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$tmpfile"
    echo
    return
  fi
  [ "$osc8_demo" -eq 1 ] && echo "  OSC 8 hyperlink sequence asserted (capture-pane -p -e)"

  # 5. Send 'q' (grace for the input subscription), re-send once at 2s if
  # the final ok: line has not appeared, poll up to 10s for it.
  sleep 0.5
  tmux send-keys -t "$SESSION" -l 'q' 2>/dev/null || true
  tmux send-keys -t "$SESSION" Enter 2>/dev/null || true

  local ok=0 waited=0
  while [ "$waited" -lt 100 ]; do
    if grep -qF "quit on 'q'" "$tmpfile" 2>/dev/null; then
      ok=1
      break
    fi
    if [ "$waited" -eq 20 ]; then
      # First 'q' may have landed before the input subscription was live.
      tmux send-keys -t "$SESSION" -l 'q' 2>/dev/null || true
      tmux send-keys -t "$SESSION" Enter 2>/dev/null || true
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  if [ "$ok" -eq 0 ]; then
    fail=$((fail + 1))
    echo "==> [$name] FAIL (demo did not print its 'ok: ... quit on q' line within 10s of 'q')"
    { tail -20 "$tmpfile" 2>/dev/null || true; } | sed 's/^/    /'
    tmux pipe-pane -t "$SESSION" -O 2>/dev/null || true
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$tmpfile"
    echo
    return
  fi

  # 6. The demo exited and its window closed: has-session must fail.
  local gone=0
  for i in $(seq 1 50); do
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      gone=1
      break
    fi
    sleep 0.1
  done

  # 7. Cleanup.
  tmux pipe-pane -t "$SESSION" -O 2>/dev/null || true
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$tmpfile"

  if [ "$gone" -eq 1 ]; then
    pass=$((pass + 1))
    echo "==> [$name] PASS (rendered, asserted, quit on 'q', session gone)"
  else
    fail=$((fail + 1))
    echo "==> [$name] FAIL (demo quit on 'q' but the tern-e2e session still exists)"
  fi
  echo
}

echo "tern examples tmux e2e"
echo "======================="
run_demo react-demo "$SCRIPT_DIR/react-demo.ts" "scene has 2 text leaves"
run_demo solid-demo "$SCRIPT_DIR/solid-demo.ts" "scene has 2 text leaves"
run_demo kitchen-sink-react "$SCRIPT_DIR/kitchen-sink-react.ts" "$OSC8_OPEN" 1
run_demo kitchen-sink-solid "$SCRIPT_DIR/kitchen-sink-solid.ts" "$OSC8_OPEN"
run_demo agent-transcript "$SCRIPT_DIR/agent-transcript.ts" "user: how do I sum a Vec<i32>?"
run_demo file-browser "$SCRIPT_DIR/file-browser.ts" "file browser"
run_demo diff-review "$SCRIPT_DIR/diff-review.ts" "formatBytes"

# Forced-failure path: an extra demo arg whose file does not exist must
# fail (its marker can never appear) and drive the exit code to 1.
if [ $# -gt 0 ]; then
  run_demo "$1" "$SCRIPT_DIR/$1.ts" "__no_such_marker__"
fi

echo "======================="
if [ "$fail" -eq 0 ]; then
  echo "run-e2e-tmux: PASS — all 7 demos (react-demo, solid-demo, kitchen-sink-react, kitchen-sink-solid, agent-transcript, file-browser, diff-review) rendered in a pinned 80x24 tmux session, asserted their scenes (incl. the OSC 8 hyperlink sequence for kitchen-sink-react via capture-pane -p -e), quit on 'q', and the session closed"
  exit 0
fi
echo "run-e2e-tmux: FAIL — $fail demo(s) failed (7 demos plus any forced-failure arg)"
exit 1
