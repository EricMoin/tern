//! The flow API run-e2e-tmux.sh drives - the decisions a terminal is not needed
//! to make.
//!
//! WHY A TYPESCRIPT MODULE DRIVES A BASH HARNESS. The registry, the fixtures and
//! the step list are typed data (flows.ts, fixture.ts); the terminal is not. Bash
//! owns tmux - the pinned 80x24 session, the pipe-pane channel, the keystrokes, the
//! polls, the teardown - and this module owns everything decidable without one, so
//! no assertion about FILE CONTENTS is ever a string comparison in shell and no
//! fixture path is ever composed in shell.
//!
//! THE PROTOCOL. prepare writes the flow's fixture into the runner's temp
//! directory and prints the fields the runner needs, one KEY=value per line:
//!
//!   TITLE, FILE, and one STEP= line per step, in order, pipe-separated:
//!     STEP=expect|TOKEN|TENTHS
//!     STEP=absent|TOKEN
//!     STEP=type|TEXT
//!     STEP=keys|KEY KEY ...
//!     STEP=save|KEY KEY ...|TENTHS
//!     STEP=quit|KEY KEY ...|TENTHS
//!
//! The runner reads TITLE and FILE with sed and replays the STEP lines; it never
//! decides what a flow asserts. Values that cross into a tmux command are held to a
//! bare-token alphabet HERE, so a fixture that could not survive the crossing fails
//! with a message about the fixture instead of a confusing shell error later.
//!
//! '--fail' IS THE FORCED-FAILURE VARIANT the runner's --fail-flow uses. It poisons
//! the FIRST expect step's token (an unwritable suffix is appended, so the poll can
//! never succeed) and poisons assert-saved to expect the PRE-EDIT bytes. The
//! failure the runner reports is therefore guaranteed, which is what makes it a test
//! of the harness's failure path - cleanup included - rather than of the app.
//!
//! Usage:
//!   deno run --allow-read --allow-write src/e2e/cli.ts list
//!   deno run --allow-read --allow-write src/e2e/cli.ts prepare --flow <name> --dir <dir> [--fail]
//!   deno run --allow-read --allow-write src/e2e/cli.ts assert-saved --flow <name> --file <path> [--timeout-ms <n>] [--fail]
//!
//! Exit: 0 when the command's assertion holds; 1 when it does not (an e2e failure -
//! the runner reports it and kills the session); 2 when the runner asked for
//! something impossible (a bad argument, a fixture that cannot cross the shell
//! boundary).

import { flowByName, flowNames, type FlowSpec, type FlowStep } from "./flows.ts";
import { readFixtureOrNull, writeFixture } from "./fixture.ts";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** The suffix prepare --fail appends to the first expect token. It appears in no
 * fixture, so a stream can never contain it and the content poll can never
 * succeed. */
const POISON = "__MUST_NOT_APPEAR__";

/** A value the runner may interpolate into a tmux/shell command: no whitespace, no
 * quote, no backslash, no leading dash (send-keys would read it as an option). */
const SHELL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:>/=-]*$/;

/** A path the runner may interpolate the same way. */
const SHELL_PATH = /^[A-Za-z0-9/._+-]+$/;

/** One tmux key name, as send-keys takes it (C-s, escape, M-1). */
const KEY_NAME = /^[A-Za-z0-9-]+$/;

/** What the runner asked for. */
interface Args {
  readonly command: string | undefined;
  readonly flow: string | undefined;
  readonly dir: string | undefined;
  readonly file: string | undefined;
  readonly timeoutMs: number;
  readonly forceFail: boolean;
}

/** The one error the runner's misuse produces, reported without a stack trace. */
class UsageError extends Error {}

const USAGE = [
  "usage: deno run --allow-read --allow-write src/e2e/cli.ts <command> [options]",
  "  list",
  "  prepare      --flow <name> --dir <dir> [--fail]",
  "  assert-saved --flow <name> --file <path> [--timeout-ms <n>] [--fail]",
].join("\n");

/** Parse argv into Args, rejecting anything the protocol does not know. */
function parse(argv: readonly string[]): Args {
  let command: string | undefined;
  let flow: string | undefined;
  let dir: string | undefined;
  let file: string | undefined;
  let timeoutMs = 5000;
  let forceFail = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--flow" || arg === "--dir" || arg === "--file" || arg === "--timeout-ms") {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(arg + " needs a value");
      if (arg === "--flow") flow = value;
      else if (arg === "--dir") dir = value;
      else if (arg === "--file") file = value;
      else {
        timeoutMs = Number(value);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new UsageError("--timeout-ms must be a positive integer, got '" + value + "'");
        }
      }
      i += 1;
      continue;
    }
    if (arg === "--fail") {
      forceFail = true;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError("unknown option '" + arg + "'");
    if (command !== undefined) throw new UsageError("unexpected argument '" + arg + "'");
    command = arg;
  }
  if (command === undefined) throw new UsageError("no command given");
  return { command, flow, dir, file, timeoutMs, forceFail };
}

/** The flow name names, or a usage error listing the ones that exist. */
function requireFlow(name: string | undefined): FlowSpec {
  if (name === undefined) throw new UsageError("--flow <name> is required");
  const flow = flowByName(name);
  if (flow === null) {
    throw new UsageError("unknown flow '" + name + "'; known flows: " + flowNames().join(", "));
  }
  return flow;
}

/** Reject a value that could not survive the runner's shell interpolation. */
function requireShellToken(what: string, value: string): void {
  if (!SHELL_TOKEN.test(value)) {
    throw new UsageError(
      what + " '" + value + "' is not a bare shell token (letters, digits and _.:>/=- only) - " +
        "the runner interpolates it into a tmux command",
    );
  }
}

/** Reject a key name send-keys would not take. */
function requireKeyName(keys: readonly string[]): void {
  for (const key of keys) {
    if (!KEY_NAME.test(key)) throw new UsageError("'" + key + "' is not a tmux key name");
  }
}

/**
 * Refuse a temp directory that sits inside the working tree.
 *
 * A GUARD, NOT A SANDBOX: a flow types and saves for real, so a prepare --dir .
 * run by hand would rewrite the checkout. The runner composes its directory from
 * $TMPDIR and can never trip this; the check is here so the CLI cannot be misused
 * into mutating the repo.
 */
function guardOutsideRepo(dir: string): void {
  const cwd = Deno.cwd();
  const resolved = dir.startsWith("/") ? dir : cwd + "/" + dir;
  if (resolved === cwd || resolved.startsWith(cwd + "/")) {
    throw new UsageError(
      "--dir '" + dir + "' is inside the working tree (" + cwd + "): the flow edits and saves " +
        "its fixture, so it must live under a temp directory",
    );
  }
}

/** list: one flow name per line - the runner's own list, so a new FLOWS entry is
 * runnable by the no-argument form without editing the shell. */
function list(): number {
  for (const name of flowNames()) console.log(name);
  return EXIT_OK;
}

/** The first expect step's token when --fail poisons it, and the step list the
 * runner and the headless proof both replay. A forced failure never reaches the
 * later steps, so only the first expect is poisoned - exactly the assertion whose
 * timeout the failure path is meant to exercise. */
function stepsFor(flow: FlowSpec, forceFail: boolean): readonly FlowStep[] {
  if (!forceFail) return flow.steps;
  let poisoned = false;
  return flow.steps.map((step) => {
    if (poisoned || step.kind !== "expect") return step;
    poisoned = true;
    return { ...step, token: step.token + POISON };
  });
}

/** Reject a step the runner could not replay. */
function requireStep(flow: FlowSpec, step: FlowStep): void {
  if (step.what === "") throw new UsageError(flow.name + ": a step has no description");
  switch (step.kind) {
    case "expect":
      requireShellToken("the token for step '" + step.what + "'", step.token);
      requireTenths(flow, step.tenths);
      return;
    case "absent":
      requireShellToken("the token for step '" + step.what + "'", step.token);
      return;
    case "type":
      requireShellToken("the typed text for step '" + step.what + "'", step.text);
      return;
    case "keys":
      requireKeyName(step.keys);
      return;
    case "save":
      requireKeyName(step.keys);
      requireTenths(flow, step.tenths);
      if (flow.saved === null) throw new UsageError(flow.name + ": a save step needs a saved expectation");
      return;
    case "quit":
      requireKeyName(step.keys);
      requireTenths(flow, step.tenths);
      return;
  }
}

/** A poll budget must be a positive tenth of a second. */
function requireTenths(flow: FlowSpec, tenths: number): void {
  if (!Number.isInteger(tenths) || tenths <= 0) {
    throw new UsageError(flow.name + ": a poll budget must be a positive tenth count, got " + tenths);
  }
}

/** One step as the runner's pipe-separated line. */
function encodeStep(step: FlowStep): string {
  switch (step.kind) {
    case "expect": return "expect|" + step.token + "|" + step.tenths;
    case "absent": return "absent|" + step.token;
    case "type": return "type|" + step.text;
    case "keys": return "keys|" + step.keys.join(" ");
    case "save": return "save|" + step.keys.join(" ") + "|" + step.tenths;
    case "quit": return "quit|" + step.keys.join(" ") + "|" + step.tenths;
  }
}

/** prepare: write the fixture and print the runner's fields. */
function prepare(args: Args): number {
  const flow = requireFlow(args.flow);
  if (args.dir === undefined) throw new UsageError("prepare needs --dir <dir>");
  guardOutsideRepo(args.dir);
  if (flow.steps.length === 0) throw new UsageError(flow.name + ": the flow has no steps");
  if (flow.steps[0]?.kind !== "expect") {
    throw new UsageError(flow.name + ": the first step must be an expect (the launch paint)");
  }
  const file = writeFixture(flow.fixture, args.dir);
  if (!SHELL_PATH.test(file)) {
    throw new UsageError("the fixture path '" + file + "' is not shell-safe - use a temp directory without spaces");
  }
  const steps = stepsFor(flow, args.forceFail);
  for (const step of steps) requireStep(flow, step);
  const lines = ["TITLE=" + flow.title, "FILE=" + file];
  for (const step of steps) lines.push("STEP=" + encodeStep(step));
  console.log(lines.join("\n"));
  if (args.forceFail) {
    console.error("e2e spec: forced failure - the first expect token is poisoned and the on-disk expectation is the pre-edit bytes");
  }
  return EXIT_OK;
}

/**
 * assert-saved: poll the file until it holds exactly the bytes the flow's edit
 * must leave, or the deadline passes.
 *
 * POLLED, NOT SAMPLED ONCE: ctrl+s is a request the app drains asynchronously
 * (layers/core/input.ts serializes the effect queue), so the write lands a tick
 * after the key. A single read would race it and report a correct app as broken.
 * The comparison is EXACT - the whole file - because a save that wrote the right
 * line and lost the rest is not a save.
 */
async function assertSaved(args: Args): Promise<number> {
  const flow = requireFlow(args.flow);
  if (args.file === undefined) throw new UsageError("assert-saved needs --file <path>");
  const expected = args.forceFail ? flow.fixture.text : flow.saved;
  if (expected === null) throw new UsageError("flow '" + flow.name + "' has no save step");
  const deadline = Date.now() + args.timeoutMs;
  let polls = 0;
  let actual = readFixtureOrNull(args.file);
  while (actual !== expected && Date.now() < deadline) {
    await delay(100);
    polls += 1;
    actual = readFixtureOrNull(args.file);
  }
  if (actual === expected) {
    console.log("SAVED=ok bytes=" + actual.length + " polls=" + polls);
    return EXIT_OK;
  }
  reportUnsaved(flow, args, expected, actual);
  return EXIT_FAIL;
}

/** Why the on-disk assertion failed, in enough detail to debug the app without a
 * second run: what is on disk, what was expected, and where they diverge. */
function reportUnsaved(flow: FlowSpec, args: Args, expected: string, actual: string | null): void {
  const expectation = args.forceFail
    ? "the poisoned expectation (the pre-edit bytes)"
    : "the flow's expectation";
  console.error("e2e spec: assert-saved FAILED for '" + flow.name + "' - " + String(args.file));
  console.error("  expectation: " + expectation);
  if (actual === null) {
    console.error("  on disk:     the file could not be read (the save never wrote it)");
    return;
  }
  console.error("  on disk:     " + actual.length + " chars - " + preview(actual));
  console.error("  expected:    " + expected.length + " chars - " + preview(expected));
  console.error("  first difference at char " + firstDifference(actual, expected));
}

/** The index of the first differing code unit, or the shorter length when one
 * string is a prefix of the other. */
function firstDifference(actual: string, expected: string): number {
  const shared = Math.min(actual.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    if (actual[i] !== expected[i]) return i;
  }
  return shared;
}

/** text with control characters spelled out and long text truncated - the preview
 * must be one greppable line in a terminal that the app has been driving. */
function preview(text: string): string {
  let out = "";
  for (const char of text.slice(0, 160)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += char;
  }
  return "'" + out + (text.length > 160 ? "..." : "") + "'";
}

/** Wait ms without a timer handle left behind. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run the requested command; UsageError leaves as EXIT_USAGE. */
async function main(argv: readonly string[]): Promise<number> {
  const args = parse(argv);
  switch (args.command) {
    case "list":
      return list();
    case "prepare":
      return prepare(args);
    case "assert-saved":
      return await assertSaved(args);
    default:
      throw new UsageError("unknown command '" + String(args.command) + "'");
  }
}

try {
  Deno.exit(await main(Deno.args));
} catch (error) {
  if (error instanceof UsageError) {
    console.error("e2e spec: " + error.message);
    console.error(USAGE);
    Deno.exit(EXIT_USAGE);
  }
  throw error;
}
