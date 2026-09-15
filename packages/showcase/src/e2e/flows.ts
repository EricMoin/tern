//! The flow registry: every end-to-end flow the tmux harness can run, as data.
//!
//! A FLOW IS DATA; THE DRIVE IS THE RUNNER'S. A spec says which document to open,
//! which token proves it was painted, what to type and which tmux keys save and
//! quit. `run-e2e-tmux.sh` owns the sequence — session, channel, polls,
//! cleanup — so a flow cannot invent a second session, a second pipe or a second
//! assertion channel, and every flow gets the same teardown on every exit path.
//!
//! EXTENDING THE SUITE: add a `FlowSpec` to {@link FLOWS}. The runner reads the
//! registry (`cli.ts list`) instead of carrying a hard-coded list, so a new flow
//! is runnable by name — and by the no-argument run — the moment it is here. A
//! flow that needs a step the shared drive does not have gets a hook in the
//! runner's per-flow `case`; the drive's channel and cleanup rules stay shared.
//!
//! WHAT EVERY FLOW MUST HAVE: a marker that a launch's FIRST frame paints and a
//! typed edit that changes the bytes on disk. A flow that only proved "the process
//! started" would pass on a screen that never painted the file; a flow that only
//! proved "the paint happened" would pass on an editor that cannot save.

import { OPEN_EDIT_SAVE, type Fixture } from "./fixture.ts";

/** One runnable flow, as the runner needs it. */
export interface FlowSpec {
  /** The name `--flow` takes. Also the temp directory key, so it stays a bare
   * token (letters, digits, `-`). */
  readonly name: string;
  /** One line the runner prints before the run — what the flow proves. */
  readonly title: string;
  /** The document the flow opens, and the edit it types. */
  readonly fixture: Fixture;
  /** The tmux key names that save, sent after the typed text has been observed.
   * A list because a flow may need `escape` first (a modal, a selection). */
  readonly saveKeys: readonly string[];
  /** The tmux key names that leave the editor, sent after the save landed. */
  readonly quitKeys: readonly string[];
  /** How long the runner polls the raw stream for the content marker, in tenths
   * of a second. A launch is ~1s of Deno and addon load plus one paint; the
   * budget is the runner's, the deadline is the flow's. */
  readonly markerTenths: number;
  /** How long the runner polls the raw stream for the typed text's repaint. */
  readonly typedTenths: number;
  /** How long the runner polls for the session to disappear after the quit key —
   * the app exiting is what closes its window, so this is the quit assertion. */
  readonly quitTenths: number;
}

/**
 * `open-edit-save`: the first flow, and the whole vertical slice the layer-A
 * entry point offers — open a file, paint it, type, `ctrl+s`, `ctrl+q`.
 *
 * It asserts FOUR things, in this order, because each one makes the next
 * meaningful: the marker in the raw stream (the file was painted), the typed text
 * in the raw stream (the keystroke reached the paint), the bytes ON DISK (the
 * save really wrote, and wrote exactly the edit), and the session's disappearance
 * (`ctrl+q` reached the app and the app exited).
 */
export const OPEN_EDIT_SAVE_FLOW: FlowSpec = {
  name: "open-edit-save",
  title: "open a file, paint it, type, ctrl+s to disk, ctrl+q to exit",
  fixture: OPEN_EDIT_SAVE,
  saveKeys: ["C-s"],
  quitKeys: ["C-q"],
  markerTenths: 100,
  typedTenths: 50,
  quitTenths: 100,
};

/** Every flow the harness can run, in run order for the no-argument form. */
export const FLOWS: readonly FlowSpec[] = [OPEN_EDIT_SAVE_FLOW];

/** The flow named `name`, or `null` — the one lookup the runner and `cli.ts`
 * share, so an unknown name is reported once, in one place. */
export function flowByName(name: string): FlowSpec | null {
  return FLOWS.find((flow) => flow.name === name) ?? null;
}

/** Every flow's name, in {@link FLOWS} order. */
export function flowNames(): string[] {
  return FLOWS.map((flow) => flow.name);
}
