//! Tests: the flow registry's contract with the runner and the headless proof.
//!
//! These are the properties the BASH harness depends on and cannot check for
//! itself - a marker that really is in the fixture, a token that survives the
//! crossing into a tmux command, fixture lines narrow enough to reach the screen
//! whole, a flow that actually saves what it claims to save. A violation fails
//! here in a second; the same violation found by the tmux harness costs a launch,
//! a session, a 10-second timeout and a puzzling trace to read.
//!
//! Everything here is pure string work: the suite runs under deno test with no
//! permissions at all, so no test may touch the filesystem (that is what the fakes
//! in core/fs_test.ts exist for).

import { PICKER_LISTED_FILE } from "./fixture.ts";
import { FLOWS, OPEN_EDIT_SAVE_FLOW, SCROLL_TARGET_TOKEN, flowByName, flowNames, type FlowStep } from "./flows.ts";

/** What the runner may interpolate into a tmux/shell command (cli.ts). */
const SHELL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:>/=-]*$/;

/** One tmux key name, as cli.ts validates it. */
const KEY_NAME = /^[A-Za-z0-9-]+$/;

/** The editor window a launch gets at 80 columns: the width minus the file list
 * (plan.ts gives the sidebar 20 cells). A wider line would wrap or truncate, and
 * a marker inside it could stop being one contiguous run in the raw stream. */
const EDITOR_COLS = 60;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Every step's poll budget, for the flows that have one. */
function pollTenths(step: FlowStep): number | null {
  return step.kind === "expect" || step.kind === "save" || step.kind === "quit" ? step.tenths : null;
}

Deno.test("every flow's marker is in the document the flow opens", () => {
  check(FLOWS.length > 0, "the registry is empty");
  for (const flow of FLOWS) {
    check(
      flow.fixture.text.includes(flow.fixture.marker),
      flow.name + ": the marker '" + flow.fixture.marker + "' is not in the fixture text - the content " +
        "assertion could never pass",
    );
    const first = flow.steps[0];
    check(
      first?.kind === "expect" && first.token === flow.fixture.marker,
      flow.name + ": the first step must be an expect of the fixture's marker",
    );
  }
});

Deno.test("every flow's runner-facing values are bare shell tokens", () => {
  for (const flow of FLOWS) {
    check(/^[a-z0-9-]+$/.test(flow.name), flow.name + ": the flow name is used as a temp directory key");
    check(flow.title.length > 0, flow.name + ": the runner prints the title");
    for (const step of flow.steps) {
      check(step.what.length > 0, flow.name + ": a step has no description");
      switch (step.kind) {
        case "expect":
        case "absent":
          check(SHELL_TOKEN.test(step.token), flow.name + ": the step token '" + step.token + "' is not a bare shell token");
          break;
        case "type":
          check(SHELL_TOKEN.test(step.text), flow.name + ": the typed text '" + step.text + "' is not a bare shell token");
          break;
        case "keys":
        case "save":
        case "quit":
          check(step.keys.length > 0, flow.name + ": step '" + step.what + "' sends no keys");
          for (const key of step.keys) {
            check(KEY_NAME.test(key), flow.name + ": '" + key + "' is not a tmux key name");
          }
          break;
      }
    }
  }
});

Deno.test("every flow launches on an expect, quits, and budgets its polls", () => {
  for (const flow of FLOWS) {
    check(flow.steps[0]?.kind === "expect", flow.name + ": the first step is not the launch assertion");
    const last = flow.steps[flow.steps.length - 1];
    check(last?.kind === "quit", flow.name + ": the last step must quit, or the session leaks");
    for (const step of flow.steps) {
      const tenths = pollTenths(step);
      if (tenths === null) continue;
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
          EDITOR_COLS + " - the paint would wrap or truncate it",
      );
    }
  }
});

Deno.test("every save step's on-disk expectation is the edit the flow types", () => {
  for (const flow of FLOWS) {
    const save = flow.steps.find((step) => step.kind === "save");
    if (save === undefined) {
      check(flow.saved === null, flow.name + ": a flow with no save step must have no saved expectation");
      continue;
    }
    check(flow.saved !== null, flow.name + ": a save step needs a saved expectation");
    check(flow.saved !== flow.fixture.text, flow.name + ": the flow must actually change the bytes on disk");
    const typed = flow.fixture.typed ?? "";
    check(typed.length > 0 && (flow.saved ?? "").includes(typed), flow.name + ": the saved bytes must contain the typed edit");
  }
});

Deno.test("the picker flow lists a sibling the fixture writes", () => {
  const flow = flowByName("open-picker");
  check(flow !== null, "the picker flow is registered");
  const siblings = flow?.fixture.siblings ?? [];
  check(siblings.includes(PICKER_LISTED_FILE), "the picker flow does not write the filename it waits for");
  for (const sibling of siblings) {
    check(!sibling.includes("/") && SHELL_TOKEN.test(sibling), "the sibling '" + sibling + "' is not a bare basename");
    check(sibling !== flow?.fixture.fileName, "the listed filename must not be the opened document's name");
  }
  const expects = flow?.steps.filter((step) => step.kind === "expect") ?? [];
  check(
    expects.some((step) => step.kind === "expect" && step.token === PICKER_LISTED_FILE),
    "the picker flow never waits for the listed filename",
  );
});

Deno.test("the scroll flow forbids its target line before it scrolls", () => {
  const flow = flowByName("scroll-large");
  check(flow !== null, "the scroll flow is registered");
  const steps = flow?.steps ?? [];
  const absentAt = steps.findIndex((step) => step.kind === "absent" && step.token === SCROLL_TARGET_TOKEN);
  const expectAt = steps.findIndex((step) => step.kind === "expect" && step.token === SCROLL_TARGET_TOKEN);
  check(absentAt >= 0, "the scroll flow never forbids the target line before scrolling");
  check(expectAt > absentAt, "the scroll flow waits for the target line before scrolling");
  const firstWindow = (flow?.fixture.text ?? "").split("\n").slice(0, 24).join("\n");
  check(!firstWindow.includes(SCROLL_TARGET_TOKEN), "the target line is already inside a 24-row first window");
});

Deno.test("the registry resolves a flow by name and nothing else", () => {
  check(flowNames().includes(OPEN_EDIT_SAVE_FLOW.name), "the first flow is registered");
  check(flowByName(OPEN_EDIT_SAVE_FLOW.name) === FLOWS[0], "a known name resolves to its spec");
  check(flowByName("no-such-flow") === null, "an unknown name resolves to null, not to a default");
  check(new Set(flowNames()).size === flowNames().length, "flow names are unique (they key temp directories)");
});
