#!/usr/bin/env bash
# run-e2e-tmux.sh - the showcase's tmux end-to-end harness.
#
# WHAT IT IS. The app's own end-to-end gate: it launches the layer-A entry point
#
#   deno run --allow-all packages/showcase/src/layers/core/main.ts [path]
#
# in a real terminal - a detached tmux pane pinned to 80x24 - drives it with real
# keystrokes, and asserts what a user would see and what the app left on disk.
# Nothing else in the repo launches that entry point, so this is the only place its
# first real frame is verified.
#
# THE STEPS ARE DATA. src/e2e/flows.ts is the registry; src/e2e/cli.ts 'prepare'
# writes each flow's fixture into a temp directory and prints the flow's own step
# list (one STEP=kind|... line per step, in order). This script replays those lines
# and decides nothing itself: expect polls the raw stream for a token, absent fails
# if the token is already there, type sends a literal edit, keys sends tmux key
# names, save sends the save keys and then asks cli.ts to assert the bytes on disk,
# quit sends the quit keys and then asserts the session disappeared. A new flow is
# runnable by name - and by the no-argument run, which lists the registry - without
# editing this script.
#
# CHANNEL DESIGN (modelled on packages/examples/run-e2e-tmux.sh, empirically
# verified there on tmux 3.7b/macOS; that file's header carries the full argument):
#   * the session is created with the APP AS ITS INITIAL COMMAND, so the window
#     closes when the app exits and 'tmux has-session -t tern-e2e' fails on its own
#     - no shell lingers behind the app;
#   * 'tmux pipe-pane -o' into a per-flow append-only temp file is the AUTHORITATIVE
#     raw-byte channel: every assertion about rendered content is a grep of that
#     stream. capture-pane is unreliable as a PRIMARY channel (the app's own stdout
#     overwrites painted cells, and the grid dies with the window), so it is used
#     here only for the failure dump - the app is usually still alive at that point,
#     and the grid says what it actually painted;
#   * a pinned 80x24 session, 0.1s polling with explicit per-step timeouts, and
#     'kill-session' on EVERY path including failure;
#   * nothing is asserted by 'it started': every flow's first step waits for a
#     content marker the opened FILE contributes to the paint, and its last step
#     quits and asserts the session is gone;
#   * escape bytes go in via printf '\x1b...' when a raw byte is wanted, so the
#     script stays greppable. The keys every registered flow needs are tmux key
#     NAMES (C-s, C-q, C-p, M-l, Down, escape), which send-keys resolves itself; no
#     flow needs a hand-built escape sequence today.
#
# REPO SAFETY. Every fixture is a temp file under $TMPDIR/tern-showcase-e2e; a flow
# types and saves for REAL, so a fixture in the checkout would rewrite the working
# tree of whoever ran the suite. The runner refuses to launch a fixture whose path
# is inside the repo, and removes the temp directory on the success path (on failure
# it keeps it - the stream, the app's stderr and the fixture are the evidence the
# summary points at).
#
# FAIL FAST, AND SAY WHY. A shell that cannot allocate a pty cannot run this at all,
# so the runner proves one works before the first flow; and a tmux that cannot
# create the session or attach the pipe is reported with tmux's own error instead
# of as a 10-second 'the marker never appeared'.
#
# WHAT REMAINS UNOBSERVED. When this script runs under a sandbox that denies
# /dev/ptmx, the preflight below reports that and exits 1 before any flow: the pty
# write, the raw pipe-pane stream and the session teardown are then UNOBSERVED here.
# That is the environment, not the app. Every assertion the flows make about the
# APP - the marker in the first frame as one contiguous styled run, the typed edit
# repainting, the bytes a save leaves on the host's fs, and the quit reaching the
# host - is proven without a terminal by src/e2e/prepty_test.ts, which replays the
# SAME step list against the headless app-core. This script is the only place the
# tmux half (pty write + pipe-pane + teardown) is exercised, and a sandbox that
# forbids a pty leaves exactly that half unproven.
#
# ZERO SESSIONS, EVERY PATH. A trap tears the session down on EXIT, INT and TERM;
# each failure path tears it down as well, before anything else; and the summary
# re-checks 'has-session' so a surviving session is reported and killed rather than
# trusted.
#
# USAGE
#   bash packages/showcase/run-e2e-tmux.sh                  # every registered flow
#   bash packages/showcase/run-e2e-tmux.sh --flow <name>    # exactly one flow
#   bash packages/showcase/run-e2e-tmux.sh --fail-flow <name>
#
# '--fail-flow <name>' runs that flow through its FORCED-FAILURE variant (cli.ts
# 'prepare --fail': the first expect token is poisoned so the content poll can never
# succeed, plus a poisoned on-disk expectation). The flow is guaranteed to fail, so
# the run tests the harness's own failure path - the evidence dump, the exit code
# and, above all, the teardown: no tmux session may survive it. The reported outcome
# is the REAL one, exactly as for any other failing flow.
#
# EXIT: 0 when every flow run passed; 1 otherwise (which includes '--fail-flow',
# whose flow is built to fail).

set -u
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root: deno must run from here so the workspace deno.json and the root
# node_modules deps resolve @tern-tui/core and the native addon.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$SCRIPT_DIR/src/e2e/cli.ts"
APP="$SCRIPT_DIR/src/layers/core/main.ts"
SESSION="tern-e2e"

# The temp root every flow owns. A path that could not cross into a tmux command
# safely falls back to /tmp rather than failing later with a puzzling error.
WORK_BASE="${TMPDIR:-/tmp}"
WORK_BASE="${WORK_BASE%/}/tern-showcase-e2e"
case "$WORK_BASE" in
  *[!A-Za-z0-9/._+-]*)
    echo "run-e2e-tmux: note - '$WORK_BASE' is not shell-safe; using /tmp/tern-showcase-e2e" >&2
    WORK_BASE="/tmp/tern-showcase-e2e"
    ;;
esac

usage() {
  echo "usage: bash packages/showcase/run-e2e-tmux.sh [--flow <name> | --fail-flow <name>]"
  echo "       with no arguments, every flow in src/e2e/flows.ts runs"
}

# The arguments are parsed FIRST: --help and a typo'd flag must not depend on the
# environment being able to run a flow at all.
mode="all"
flow_name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flow)
      if [ $# -lt 2 ]; then
        echo "run-e2e-tmux: --flow needs a flow name" >&2
        exit 2
      fi
      mode="flow"
      flow_name="$2"
      shift 2
      ;;
    --fail-flow)
      if [ $# -lt 2 ]; then
        echo "run-e2e-tmux: --fail-flow needs a flow name" >&2
        exit 2
      fi
      mode="fail"
      flow_name="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "run-e2e-tmux: unknown argument '$1'" >&2
      usage
      exit 2
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "run-e2e-tmux: FAIL - tmux is required" >&2
  exit 1
fi
if ! command -v deno >/dev/null 2>&1; then
  echo "run-e2e-tmux: FAIL - deno is required (the app is Deno-only: it reads the terminal through the native addon under --allow-all)" >&2
  exit 1
fi

# A pane IS a pseudo-terminal, and a shell can be denied one: a seatbelt profile
# whose file-write rules do not exempt /dev/ptmx makes the openpty behind every pane
# fail with 'Operation not permitted', and tmux then reports it as a fork failure.
# Probing it once, up front, turns that into one sentence about the environment
# instead of a tmux error nobody can read. Darwin only - Linux 'script' takes its
# command with -c, not as a trailing argument.
if [ "$(uname -s)" = "Darwin" ] && command -v script >/dev/null 2>&1; then
  if ! script -q /dev/null true >/dev/null 2>&1; then
    echo "run-e2e-tmux: FAIL - this shell cannot allocate a pseudo-terminal (macOS 'script' reported an openpty failure)." >&2
    echo "  Every tmux pane needs one; a sandbox that denies opening /dev/ptmx read-write produces exactly this." >&2
    echo "  The pty write and the session teardown are therefore UNOBSERVED here; every flow's app-side assertion is proven by src/e2e/prepty_test.ts." >&2
    echo "  Run this harness from a shell that can allocate a pty (a normal terminal, not a sandboxed one)." >&2
    exit 1
  fi
fi

# The flow registry's own API. One entry point, so the flags and the single source
# of truth for a flow's data stay together.
spec() {
  deno run --allow-read --allow-write "$CLI" "$@"
}

# One KEY=value line of the spec output, or the empty string.
field() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1
}

# Whether the registry knows a flow. Checked before a run so a typo fails in a
# second instead of after a launch.
flow_exists() {
  spec list 2>/dev/null | grep -qxF -- "$1"
}

cleanup_session() {
  tmux pipe-pane -t "$SESSION" -O 2>/dev/null || true
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

trap cleanup_session EXIT
trap 'exit 130' INT TERM

# Poll the raw stream for a token, up to TENTHS tenths of a second. Prints the tick
# it succeeded on (stdout) and returns 0, or prints nothing and returns 1.
poll_stream() {
  local token="$1" tenths="$2" i=0
  while [ "$i" -lt "$tenths" ]; do
    if grep -qF -- "$token" "$STREAM" 2>/dev/null; then
      echo "$i"
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# Everything a failed flow can still show: the raw stream tail (the authoritative
# channel), the live grid while the app is still running, the app's own stderr, and
# where the evidence was kept.
dump_evidence() {
  echo "    --- raw stream tail ($STREAM) ---"
  tail -40 "$STREAM" 2>/dev/null | sed 's/^/    | /' || true
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "    --- live pane grid (tmux capture-pane -p, app still running) ---"
    tmux capture-pane -p -t "$SESSION" 2>/dev/null | sed 's/^/    | /' || true
  else
    echo "    --- the session is already gone (the app exited) ---"
  fi
  echo "    --- app stderr ($ERRORS) ---"
  tail -20 "$ERRORS" 2>/dev/null | sed 's/^/    | /' || true
  echo "    --- stream bytes: $(wc -c < "$STREAM" 2>/dev/null | tr -d ' ') ---"
  echo "    --- evidence kept: $FLOW_DIR ---"
}

# A failure path: say what broke, show the evidence while the app is still up, then
# tear the session down. Cleanup is not deferred to the caller - a failed flow must
# not be able to leave a session behind.
flow_fail() {
  echo "==> [$FLOW_NAME] FAIL ($1)"
  dump_evidence
  cleanup_session
  return 1
}

# One flow, end to end: fixture, session, channel, the flow's own steps, teardown.
# Returns 0 on pass and 1 on any failure.
run_flow() {
  FLOW_NAME="$1"
  local force_fail="${2:-0}"

  FLOW_DIR="$WORK_BASE/$FLOW_NAME"
  FIXTURE_DIR="$FLOW_DIR/fixture"
  STREAM="$FLOW_DIR/stream.txt"
  ERRORS="$FLOW_DIR/app.err"

  # 0 = run the flow; 1 = its forced-failure variant (see the header).
  local fail_flag=""
  if [ "$force_fail" -eq 1 ]; then
    fail_flag="--fail"
  fi

  # 1. A fresh temp directory, and the fixture written by the flow's own spec -
  # never by hand, so the bytes the flow asserts against are the bytes it opened.
  rm -rf "$FLOW_DIR"
  mkdir -p "$FLOW_DIR"

  local spec_out
  if ! spec_out="$(spec prepare --flow "$FLOW_NAME" --dir "$FIXTURE_DIR" $fail_flag 2>&1)"; then
    echo "==> [$FLOW_NAME] FAIL (the flow spec could not prepare the fixture)"
    printf '%s\n' "$spec_out" | sed 's/^/    | /'
    rm -rf "$FLOW_DIR"
    return 1
  fi

  local title file
  title="$(field "$spec_out" TITLE)"
  file="$(field "$spec_out" FILE)"
  if [ -z "$file" ]; then
    echo "==> [$FLOW_NAME] FAIL (the flow spec did not report FILE)"
    printf '%s\n' "$spec_out" | sed 's/^/    | /'
    rm -rf "$FLOW_DIR"
    return 1
  fi
  if ! printf '%s\n' "$spec_out" | grep -q '^STEP='; then
    echo "==> [$FLOW_NAME] FAIL (the flow spec reported no steps)"
    rm -rf "$FLOW_DIR"
    return 1
  fi

  # The repo is never the fixture's home: a save must not be able to touch it.
  case "$file" in
    "$REPO_ROOT"/*)
      echo "==> [$FLOW_NAME] FAIL (refusing to run: the fixture '$file' is inside the repo)"
      rm -rf "$FLOW_DIR"
      return 1
      ;;
  esac

  # 2. Fresh session (the app IS its initial command) and the raw-byte channel.
  echo "==> [$FLOW_NAME] tmux e2e (80x24, session '$SESSION', runtime 'deno')"
  echo "    flow: $title"
  cleanup_session
  rm -f "$STREAM" "$ERRORS"
  touch "$STREAM" "$ERRORS"
  local launch_error
  if ! launch_error="$(tmux new-session -d -s "$SESSION" -x 80 -y 24 "cd '$REPO_ROOT' && deno run --allow-all '$APP' '$file' 2>>'$ERRORS'" 2>&1)"; then
    echo "    --- tmux new-session ---"
    printf '%s\n' "$launch_error" | sed 's/^/    | /'
    flow_fail "tmux could not create the session - the app was never launched (see the tmux error above)"
    return 1
  fi
  if ! tmux pipe-pane -t "$SESSION" -o "awk '{ print; fflush() }' >> '$STREAM'" 2>/dev/null; then
    flow_fail "tmux could not attach the raw-stream pipe to the session (pipe-pane)"
    return 1
  fi

  # 3. The flow's OWN steps, in order. grace delays the first keystroke: the first
  # frame is painted BEFORE the event stream starts (layers/core/main.ts:101-102),
  # and a key that arrives before raw mode is on is line-buffered by the tty.
  local step_no=0 grace=1 step kind a b tick
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    step_no=$((step_no + 1))
    IFS='|' read -r kind a b <<< "$step"
    case "$kind" in
      expect)
        if ! tick="$(poll_stream "$a" "${b:-100}")"; then
          flow_fail "step $step_no (expect): '$a' never appeared in the raw stream within $(( ${b:-100} / 10 ))s"
          return 1
        fi
        echo "    step $step_no: saw '$a' after ~$((tick / 10)).$((tick % 10))s"
        ;;
      absent)
        if grep -qF -- "$a" "$STREAM" 2>/dev/null; then
          flow_fail "step $step_no (absent): the forbidden content '$a' was already in the raw stream"
          return 1
        fi
        echo "    step $step_no: '$a' absent, as required"
        ;;
      keys)
        if [ "$grace" -eq 1 ]; then sleep 0.5; grace=0; fi
        if ! tmux send-keys -t "$SESSION" $a 2>/dev/null; then
          flow_fail "step $step_no (keys): tmux could not send '$a' (the app may already have exited)"
          return 1
        fi
        echo "    step $step_no: sent keys '$a'"
        ;;
      type)
        if [ "$grace" -eq 1 ]; then sleep 0.5; grace=0; fi
        if ! tmux send-keys -t "$SESSION" -l "$a" 2>/dev/null; then
          flow_fail "step $step_no (type): tmux could not send the typed text (the app may already have exited)"
          return 1
        fi
        echo "    step $step_no: typed the literal edit"
        ;;
      save)
        if [ "$grace" -eq 1 ]; then sleep 0.5; grace=0; fi
        if ! tmux send-keys -t "$SESSION" $a 2>/dev/null; then
          flow_fail "step $step_no (save): tmux could not send the save keys '$a'"
          return 1
        fi
        local saved_out
        if ! saved_out="$(spec assert-saved --flow "$FLOW_NAME" --file "$file" --timeout-ms "$(( ${b:-50} * 100 ))" $fail_flag 2>&1)"; then
          echo "    --- on-disk assertion (cli.ts assert-saved) ---"
          printf '%s\n' "$saved_out" | sed 's/^/    | /'
          flow_fail "step $step_no (save): the bytes on disk are not the bytes the flow's edit must leave"
          return 1
        fi
        echo "    step $step_no: $(printf '%s\n' "$saved_out" | head -1)"
        ;;
      quit)
        if [ "$grace" -eq 1 ]; then sleep 0.5; grace=0; fi
        if ! tmux send-keys -t "$SESSION" $a 2>/dev/null; then
          flow_fail "step $step_no (quit): tmux could not send the quit keys '$a'"
          return 1
        fi
        # The app exiting is what closes its window, so has-session IS the quit
        # assertion.
        local gone=-1 i=0
        while [ "$i" -lt "${b:-100}" ]; do
          if ! tmux has-session -t "$SESSION" 2>/dev/null; then
            gone=$i
            break
          fi
          sleep 0.1
          i=$((i + 1))
        done
        if [ "$gone" -lt 0 ]; then
          flow_fail "step $step_no (quit): the app did not exit within $(( ${b:-100} / 10 ))s of the quit key (session '$SESSION' still exists)"
          return 1
        fi
        echo "    step $step_no: the quit key closed the session after ~$((gone / 10)).$((gone % 10))s"
        ;;
      *)
        flow_fail "step $step_no: unknown step kind '$kind'"
        return 1
        ;;
    esac
  done < <(printf '%s\n' "$spec_out" | sed -n 's/^STEP=//p')

  # 4. Cleanup: the pipe, the session, and - only on success - the temp dir.
  cleanup_session
  rm -rf "$FLOW_DIR"
  echo "==> [$FLOW_NAME] PASS (every step held: the fixture painted, the edits repainted, the saves written, the session gone)"
  echo
  return 0
}

echo "tern showcase tmux e2e"
echo "======================="

pass=0
fail=0

case "$mode" in
  flow|fail)
    if ! flow_exists "$flow_name"; then
      echo "run-e2e-tmux: unknown flow '$flow_name'" >&2
      echo "known flows:" >&2
      spec list 2>/dev/null | sed 's/^/  /' >&2
      exit 2
    fi
    ;;
esac

case "$mode" in
  all)
    names="$(spec list)" || {
      echo "run-e2e-tmux: FAIL - the flow registry could not be read" >&2
      exit 1
    }
    if [ -z "$names" ]; then
      echo "run-e2e-tmux: FAIL - the flow registry is empty" >&2
      exit 1
    fi
    for name in $names; do
      if run_flow "$name" 0; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
      fi
    done
    ;;
  flow)
    if run_flow "$flow_name" 0; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
    fi
    ;;
  fail)
    if run_flow "$flow_name" 1; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
    fi
    ;;
esac

echo "======================="

# The teardown contract is checked, not trusted: a session that survived any path
# is reported here even though every path above tears it down.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "run-e2e-tmux: a '$SESSION' session survived the run - killing it" >&2
  cleanup_session
  fail=$((fail + 1))
fi

if [ "$fail" -eq 0 ]; then
  echo "run-e2e-tmux: PASS - $pass flow(s) replayed their own step lists in a pinned 80x24 tmux session; no tmux session left behind"
  exit 0
fi
echo "run-e2e-tmux: FAIL - $fail flow(s) failed ($pass passed); no tmux session left behind"
exit 1
