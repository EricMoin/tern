//! Tests: the flow registry's contract with the runner.
//!
//! These are the properties the BASH harness depends on and cannot check for
//! itself — a marker that really is in the fixture, a token that survives the
//! crossing into a tmux command, fixture lines narrow enough to reach the screen
//! whole. A violation fails here in a second; the same violation found by the
//! tmux harness costs a launch, a session, a 10-second timeout and a puzzling
//! trace to read.
//!
//! Everything here is pure string work: the suite runs under `deno test src` with
//! no permissions at all, so no test may touch the filesystem (that is what the
//! fakes in `core/fs_test.ts` exist for).

import { OPEN_EDIT_SAVE, savedText, type Fixture } from "./fixture.ts";
import { FLOWS, OPEN_EDIT_SAVE_FLOW, flowByName, flowNames } from "./flows.ts";

/** What the runner may interpolate into a tmux/shell command (cli.ts). */
const SHELL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:>/=-]*$/;

/** The editor window a launch gets at 80 columns: the width minus the file list
 * (plan.ts gives the sidebar 20 cells). A wider line would wrap or truncate, and
 * a marker inside it could stop being one contiguous run in the raw stream. */
const EDITOR_COLS = 60;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("every flow's marker is in the document the flow opens", () => {
  check(FLOWS.length > 0, "the registry is empty");
  for (const flow of FLOWS) {
    check(
      flow.fixture.text.includes(flow.fixture.marker),
      flow.name + ": the marker '" + flow.fixture.marker + "' is not in the fixture text — the content " +
        "assertion could never pass",
    );
  }
});

Deno.test("every flow's runner-facing values are bare shell tokens", () => {
  for (const flow of FLOWS) {
    for (const [what, value] of [["MARKER", flow.fixture.marker], ["TYPED", flow.fixture.typed]] as const) {
      check(
        SHELL_TOKEN.test(value),
        flow.name + ": " + what + " '" + value + "' is not a bare shell token the runner can interpolate",
      );
    }
    for (const key of [...flow.saveKeys, ...flow.quitKeys]) {
      check(/^[A-Za-z0-9-]+$/.test(key), flow.name + ": '" + key + "' is not a tmux key name");
    }
    check(/^[a-z0-9-]+$/.test(flow.name), flow.name + ": the flow name is used as a temp directory key");
    check(flow.title.length > 0, flow.name + ": the runner prints the title");
    for (const tenths of [flow.markerTenths, flow.typedTenths, flow.quitTenths]) {
      check(Number.isInteger(tenths) && tenths > 0, flow.name + ": every poll budget is a positive tenth count");
    }
  }
});

Deno.test("every fixture line is ASCII and fits the editor window", () => {
  for (const flow of FLOWS) {
    const lines = flow.fixture.text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const char of line) {
        const code = char.codePointAt(0) ?? 0;
        check(code >= 0x20 && code <= 0x7e, flow.name + ": line " + (index + 1) + " is not printable ASCII");
      }
      check(
        line.length <= EDITOR_COLS,
        flow.name + ": line " + (index + 1) + " is " + line.length + " cells wide, and the editor window is " +
          EDITOR_COLS + " — the paint would wrap or truncate it",
      );
    }
  }
});

Deno.test("the on-disk expectation is the edit inserted at the launch caret", () => {
  const fixture: Fixture = OPEN_EDIT_SAVE;
  check(savedText(fixture) === fixture.typed + fixture.text, "savedText must be typed + text");
  check(savedText(fixture) !== fixture.text, "the flow must actually change the bytes on disk");
  check(savedText(fixture).startsWith(fixture.typed), "the edit lands at 0:0, so it is a prefix");
});

Deno.test("the registry resolves a flow by name and nothing else", () => {
  check(flowNames().includes(OPEN_EDIT_SAVE_FLOW.name), "the first flow is registered");
  check(flowByName(OPEN_EDIT_SAVE_FLOW.name) === FLOWS[0], "a known name resolves to its spec");
  check(flowByName("no-such-flow") === null, "an unknown name resolves to null, not to a default");
  check(new Set(flowNames()).size === flowNames().length, "flow names are unique (they key temp directories)");
});
