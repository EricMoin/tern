//! The flow registry: every end-to-end flow the tmux harness can run, as data.
//!
//! A FLOW IS DATA; THE DRIVE IS THE RUNNER'S. A spec names the document to open
//! and the STEPS to run against it; the runner owns the sequence - session,
//! channel, polls, teardown - so a flow cannot invent a second session, a second
//! pipe or a second assertion channel, and every flow gets the same teardown on
//! every exit path.
//!
//! THE STEPS ARE A SCRIPT, AND BOTH INTERPRETERS SHARE IT. run-e2e-tmux.sh
//! executes the list against a real tmux pane (its header documents the channel
//! design); prepty_test.ts executes the SAME list against the headless app-core
//! with no terminal at all. A step kind the shell understands is a step kind the
//! headless proof understands, so the assertions the pty run makes are the
//! assertions proven before a pty is ever opened.
//!
//! WHAT EVERY FLOW MUST HAVE: a first step that waits for a marker a launch's
//! FIRST frame paints (a flow that only proved "the process started" would pass on
//! a screen that never painted the file), and a last step that quits and asserts
//! the session disappeared (a flow that never left would leak a tmux session).
//!
//! EXTENDING THE SUITE: add a FlowSpec to FLOWS. The runner reads the registry
//! (cli.ts list) instead of carrying a hard-coded list, so a new flow is runnable
//! by name - and by the no-argument run - the moment it is here.

import {
  LAUNCH_TYPE,
  OPEN_EDIT_SAVE,
  OPEN_PICKER,
  PICKER_LISTED_FILE,
  SAVE_TEMP,
  SCROLL_LARGE,
  SCROLL_LARGE_TARGET_LINE,
  insertedText,
  prefixedText,
  type Fixture,
} from "./fixture.ts";

/** One runnable step of a flow. The shell runner and the headless proof each
 * interpret exactly these. */
export type FlowStep =
  | { readonly kind: "expect"; readonly token: string; readonly tenths: number; readonly what: string }
  | { readonly kind: "absent"; readonly token: string; readonly what: string }
  | { readonly kind: "type"; readonly text: string; readonly what: string }
  | { readonly kind: "keys"; readonly keys: readonly string[]; readonly what: string }
  | { readonly kind: "save"; readonly keys: readonly string[]; readonly tenths: number; readonly what: string }
  | { readonly kind: "quit"; readonly keys: readonly string[]; readonly tenths: number; readonly what: string };

/** One runnable flow, as the runner needs it. */
export interface FlowSpec {
  /** The name --flow takes. Also the temp directory key, so it stays a bare
   * token (letters, digits, -). */
  readonly name: string;
  /** One line the runner prints before the run - what the flow proves. */
  readonly title: string;
  /** The document the flow opens, and the edit it types. */
  readonly fixture: Fixture;
  /** The ordered assertions and keystrokes the runner and the headless proof
   * both replay. */
  readonly steps: readonly FlowStep[];
  /** The bytes the flow's save step must leave on disk, or null when the flow
   * never saves. cli.ts assert-saved compares the WHOLE file against this. */
  readonly saved: string | null;
}

/** The typed text a fixture's edit inserts, or the empty string when it has none
 * (a flow that only scrolls or lists). The contract tests reject a flow that types
 * an empty token. */
function typedOf(fixture: Fixture): string {
  return fixture.typed ?? "";
}

/** A step that polls the raw stream until the token appears. */
function stepExpect(token: string, tenths: number, what: string): FlowStep {
  return { kind: "expect", token, tenths, what };
}

/** A step that fails if the token is ALREADY in the stream - the forbidden
 * content a flow must not be able to pass on. */
function stepAbsent(token: string, what: string): FlowStep {
  return { kind: "absent", token, what };
}

/** A step that sends the fixture's literal edit. */
function stepType(fixture: Fixture, what: string): FlowStep {
  return { kind: "type", text: typedOf(fixture), what };
}

/** A step that sends tmux key names. */
function stepKeys(keys: readonly string[], what: string): FlowStep {
  return { kind: "keys", keys, what };
}

/** A step that sends the save keys and asserts the bytes on disk. */
function stepSave(keys: readonly string[], tenths: number, what: string): FlowStep {
  return { kind: "save", keys, tenths, what };
}

/** A step that sends the quit keys and asserts the session disappeared. */
function stepQuit(keys: readonly string[], tenths: number, what: string): FlowStep {
  return { kind: "quit", keys, tenths, what };
}

/** The token a line's numbered content carries. The scroll flow waits for a line
 * far past the first window, so the assertion needs a real scroll to pass. */
export function scrollToken(line: number): string {
  return "TERN_E2E_SCROLL_" + String(line).padStart(3, "0");
}
/** The line token the scroll flow waits for. */
export const SCROLL_TARGET_TOKEN: string = scrollToken(SCROLL_LARGE_TARGET_LINE);

/**
 * open-edit-save: the whole vertical slice layer A offers - open a file, paint
 * it, type, ctrl+s, ctrl+q.
 *
 * It asserts, in order: the marker in the raw stream (the file was painted), the
 * typed token being absent before the keystroke and present after it (the
 * keystroke reached the paint), the bytes ON DISK (the save really wrote, and
 * wrote exactly the edit), and the session's disappearance (ctrl+q reached the
 * app and the app exited).
 */
export const OPEN_EDIT_SAVE_FLOW: FlowSpec = {
  name: "open-edit-save",
  title: "open a file, paint it, type, ctrl+s to disk, ctrl+q to exit",
  fixture: OPEN_EDIT_SAVE,
  steps: [
    stepExpect(OPEN_EDIT_SAVE.marker, 100, "the opened file is painted"),
    stepAbsent(typedOf(OPEN_EDIT_SAVE), "the typed token before the keystroke"),
    stepType(OPEN_EDIT_SAVE, "the fixture's one edit"),
    stepExpect(typedOf(OPEN_EDIT_SAVE), 50, "the typed edit reached the paint"),
    stepSave(["C-s"], 50, "ctrl+s writes the edited buffer"),
    stepQuit(["C-q"], 100, "ctrl+q leaves the app"),
  ],
  saved: prefixedText(OPEN_EDIT_SAVE),
};

/**
 * launch-type: launch and type, then assert the rendered content actually
 * appeared in the stream.
 *
 * It is deliberately SAVE-FREE. open-edit-save proves the save; this flow
 * isolates the paint path - the typed token must be absent from the first frame
 * and present in a later one - so a regression that types into a buffer but never
 * repaints the screen fails here, alone and legibly.
 */
export const LAUNCH_TYPE_FLOW: FlowSpec = {
  name: "launch-type",
  title: "launch, type, and assert the typed text reached the rendered frame",
  fixture: LAUNCH_TYPE,
  steps: [
    stepExpect(LAUNCH_TYPE.marker, 100, "the opened file is painted"),
    stepAbsent(typedOf(LAUNCH_TYPE), "the typed token before the keystroke"),
    stepType(LAUNCH_TYPE, "the fixture's one edit"),
    stepExpect(typedOf(LAUNCH_TYPE), 50, "the typed edit reached the paint"),
    stepQuit(["C-q"], 100, "ctrl+q leaves the app"),
  ],
  saved: null,
};

/**
 * save-temp: type an edit that does NOT start at 0:0, ctrl+s, and assert the
 * bytes ON DISK.
 *
 * The caret moves one column right first, so the saved bytes are an INSERT in the
 * middle of the first line. That is the flow's reason to exist beside
 * open-edit-save: it proves the on-disk assertion compares the WHOLE edited
 * buffer, not a prefix a truncated write could still satisfy.
 */
export const SAVE_TEMP_FLOW: FlowSpec = {
  name: "save-temp",
  title: "type an insert off 0:0, ctrl+s, and assert the bytes on disk",
  fixture: SAVE_TEMP,
  steps: [
    stepExpect(SAVE_TEMP.marker, 100, "the opened file is painted"),
    stepKeys(["Right"], "move the caret off 0:0"),
    stepAbsent(typedOf(SAVE_TEMP), "the typed token before the keystroke"),
    stepType(SAVE_TEMP, "the fixture's one edit"),
    stepExpect(typedOf(SAVE_TEMP), 50, "the typed edit reached the paint"),
    stepSave(["C-s"], 50, "ctrl+s writes the edited buffer"),
    stepQuit(["C-q"], 100, "ctrl+q leaves the app"),
  ],
  saved: insertedText(SAVE_TEMP, 1),
};

/** The Down keystrokes that walk the caret from line 1 to the target line. */
const SCROLL_DOWNS: readonly string[] = Array.from(
  { length: SCROLL_LARGE_TARGET_LINE - 1 },
  () => "Down",
);

/**
 * scroll-large: open a two-hundred-line document, turn the line-number gutter on,
 * scroll past the first window, and assert the line numbers moved.
 *
 * The forbidden step is the point: the target line's token is asserted ABSENT on
 * the launch frame before any scroll, so a flow that passed without scrolling is
 * impossible. The gutter key (alt+l) is layer A's gutter-toggle, so the painted
 * line numbers are the app's own, not the fixture's.
 */
export const SCROLL_LARGE_FLOW: FlowSpec = {
  name: "scroll-large",
  title: "scroll a 200-line file and assert the line numbers moved",
  fixture: SCROLL_LARGE,
  steps: [
    stepExpect(SCROLL_LARGE.marker, 100, "the first line is painted"),
    stepKeys(["M-l"], "turn the line-number gutter on"),
    stepAbsent(SCROLL_TARGET_TOKEN, "the target line before any scroll"),
    stepKeys(SCROLL_DOWNS, "scroll the caret past the first window"),
    stepExpect(SCROLL_TARGET_TOKEN, 50, "the later line reached the paint"),
    stepQuit(["C-q"], 100, "ctrl+q leaves the app"),
  ],
  saved: null,
};

/**
 * open-picker: launch with a second file beside the opened one, open the file
 * picker, and assert a listed filename appears.
 *
 * The listed name is chosen longer than the sidebar can show, so the full token
 * can only come from the picker's wider overlay - and the flow asserts it ABSENT
 * first. It closes the picker with escape (the app's cancel) before quitting,
 * because an open auxiliary pane owns the keyboard and would drop ctrl+q.
 */
export const OPEN_PICKER_FLOW: FlowSpec = {
  name: "open-picker",
  title: "open the file picker and assert a listed filename appears",
  fixture: OPEN_PICKER,
  steps: [
    stepExpect(OPEN_PICKER.marker, 100, "the opened file is painted"),
    stepAbsent(PICKER_LISTED_FILE, "the listed filename before the picker opens"),
    stepKeys(["C-p"], "open the file picker"),
    stepExpect(PICKER_LISTED_FILE, 50, "the picker listed the sibling file"),
    stepKeys(["escape"], "close the picker"),
    stepQuit(["C-q"], 100, "ctrl+q leaves the app"),
  ],
  saved: null,
};

/** Every flow the harness can run, in run order for the no-argument form. */
export const FLOWS: readonly FlowSpec[] = [
  OPEN_EDIT_SAVE_FLOW,
  LAUNCH_TYPE_FLOW,
  SAVE_TEMP_FLOW,
  SCROLL_LARGE_FLOW,
  OPEN_PICKER_FLOW,
];

/** The flow named 'name', or null - the one lookup the runner and cli.ts share, so
 * an unknown name is reported once, in one place. */
export function flowByName(name: string): FlowSpec | null {
  return FLOWS.find((flow) => flow.name === name) ?? null;
}

/** Every flow's name, in FLOWS order. */
export function flowNames(): string[] {
  return FLOWS.map((flow) => flow.name);
}
