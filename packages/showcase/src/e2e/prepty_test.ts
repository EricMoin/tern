//! The PRE-PTY proof: every flow's own step list driven against a real HeadlessApp
//! and the real layer-A host port, with no terminal of any kind.
//!
//! WHY THIS FILE EXISTS. run-e2e-tmux.sh needs a pseudo-terminal, and a sandbox
//! that denies /dev/ptmx cannot give it one. A suite that could only ever be run on
//! a developer's laptop is aspiration, not a gate. So every flow is ALSO replayed
//! here: the SAME FlowSpec.steps the shell runner replays, interpreted against the
//! same HeadlessApp the app builds, with the same dispatch route (core/keymap.ts:79
//! -> commands.ts -> the reducer), the same plan (core/plan.ts) and the same host
//! effect port (layers/core/io.ts:applyEffect).
//!
//! WHAT IT PROVES, AND WHAT IT CANNOT.
//!   * Every expect token is a contiguous run in ONE styled span of the frame the
//!     plan lays out - the same frame mount_paint_test.ts proves mountPlan paints.
//!   * Every absent token is on no span and in no composed row before its step.
//!   * The typed edit repaints: the typed token appears after the keystrokes.
//!   * A save step writes the edited buffer through applyEffect, and the bytes read
//!     back from the host's FileSystem are EXACTLY flow.saved.
//!   * A quit step makes applyEffect call the host's quit - the app's own exit.
//!
//! It cannot prove the tmux layer: the pty write, the raw pipe-pane stream and the
//! session teardown. Those are the steps this sandbox leaves UNOBSERVED, and the
//! script header says so; everything they assert about the APP is proven here.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/e2e/

import type { KeyEvent } from "@tern-tui/core";
import { Buffer } from "../core/buffer.ts";
import type { FileSystem } from "../core/fs.ts";
import type { PlanRegion, ScreenPlan } from "../core/plan.ts";
import { HeadlessApp } from "../core/state.ts";
import { composeRows } from "../layers/core/frame.ts";
import { applyEffect, type HostIO } from "../layers/core/io.ts";
import { SCROLL_LARGE_TARGET_LINE, type Fixture } from "./fixture.ts";
import { FLOWS, flowByName, type FlowSpec } from "./flows.ts";

/** The pinned size the runner gives its tmux pane. */
const SIZE = { rows: 24, cols: 80 };

/** The temp root the fake host composes paths under. Nothing here touches the
 * real filesystem: the host's FileSystem is an in-memory map, exactly as the React
 * and Solid slice tests drive it (layers/react/app_test.ts:270-274). */
const DIR = "/tmp/tern-e2e-prepty";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function charEvent(char: string): KeyEvent {
  return { name: "char", char, ctrl: false, alt: false, shift: false };
}

/**
 * The KeyEvent a real renderer produces for a tmux key name.
 *
 * Ctrl and Alt letters arrive as a char key with the modifier held (the native
 * binding documents it: src/bindings/tern-node/src/types.rs:275-291, and the
 * terminal's own test pins Ctrl+C as a char 'c' with ctrl - src/core/tern-terminal/
 * src/event/tests.rs:39-44). Named keys (down, escape, ...) keep their name.
 */
function keyEventOf(name: string): KeyEvent {
  if (name.startsWith("C-")) return { name: "char", char: name.slice(2).toLowerCase(), ctrl: true, alt: false, shift: false };
  if (name.startsWith("M-")) return { name: "char", char: name.slice(2).toLowerCase(), ctrl: false, alt: true, shift: false };
  return { name: name.toLowerCase(), ctrl: false, alt: false, shift: false };
}

/** An in-memory HostIO: the same port the terminal host implements, backed by a
 * Map, so a save is a real write through applyEffect that a test can read back. */
interface MemHost {
  readonly io: HostIO;
  readonly files: Map<string, string>;
  quits(): number;
}

function memHost(fixture: Fixture, dir: string): MemHost {
  const files = new Map<string, string>();
  files.set(dir + "/" + fixture.fileName, fixture.text);
  for (const sibling of fixture.siblings ?? []) files.set(dir + "/" + sibling, sibling + "\n");
  let quits = 0;
  const fs: FileSystem = {
    readFile: (path: string) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error("no such file: " + path)) : Promise.resolve(text);
    },
    writeFile: (path: string, text: string) => { files.set(path, text); return Promise.resolve(); },
  };
  const io: HostIO = {
    fs,
    list: (dirName: string) =>
      [...files.keys()]
        .filter((path) => path.startsWith(dirName + "/") && !path.slice(dirName.length + 1).includes("/"))
        .map((path) => path.slice(dirName.length + 1))
        .sort(),
    quit: () => { quits += 1; },
  };
  return { io, files, quits: () => quits };
}

/** One driven flow: the app after its steps, and the host the steps acted on. */
interface Drive {
  readonly app: HeadlessApp;
  readonly host: MemHost;
  readonly path: string;
}

/** Launch the flow's fixture the way layers/core/main.ts:57-86 does: the document
 * becomes the buffer, the directory listing becomes the file list, and the pinned
 * size becomes the app's. Only the renderer is absent - the plan is the frame. */
function launch(fixture: Fixture, dir: string): Drive {
  const host = memHost(fixture, dir);
  const path = dir + "/" + fixture.fileName;
  const app = new HeadlessApp({
    buffer: Buffer.fromString(fixture.text),
    path,
    items: host.io.list(dir),
    size: SIZE,
  });
  return { app, host, path };
}

/** Every styled span text the plan lays out, region by region. */
function spanTexts(plan: ScreenPlan): string[] {
  const out: string[] = [];
  for (const region of plan.regions) {
    if (region.kind === "editor" || region.kind === "modal") {
      for (const row of region.rows) for (const span of row.spans) out.push(span.text);
    } else if (region.kind === "sidebar") {
      for (const item of region.items) for (const span of item.spans) out.push(span.text);
    } else {
      for (const segment of region.segments) out.push(segment.text);
    }
  }
  return out;
}

/** Fail unless token is one contiguous styled run on the frame AND survives
 * composition. A token split across two spans, or clipped by a region, would not
 * be greppable in the raw stream the runner reads. */
function assertPainted(plan: ScreenPlan, token: string, where: string): void {
  check(
    spanTexts(plan).some((text) => text.includes(token)),
    where + ": no single styled span holds '" + token + "' on the frame",
  );
  check(
    composeRows(plan).some((row) => row.includes(token)),
    where + ": the composed frame does not hold '" + token + "'",
  );
}

/** Fail unless token appears in no span and in no composed row. */
function assertAbsent(plan: ScreenPlan, token: string, where: string): void {
  const painted = spanTexts(plan).find((text) => text.includes(token));
  check(painted === undefined, where + ": '" + token + "' is already on the frame in " + JSON.stringify(painted));
  check(
    !composeRows(plan).some((row) => row.includes(token)),
    where + ": the composed frame already paints '" + token + "'",
  );
}

/** Dispatch one event through the app's ONE key route. A key the app does not
 * consume is a flow defect, so it fails instead of silently doing nothing. */
function send(app: HeadlessApp, event: KeyEvent): void {
  check(app.dispatch(event), "the app did not handle " + JSON.stringify(event));
}

/** Drain the app's effects through the layer host port, one at a time, in the same
 * order layers/core/input.ts:74-82 does. */
async function drain(app: HeadlessApp, host: MemHost): Promise<void> {
  for (const effect of app.takeEffects()) await applyEffect(app, effect, host.io);
}

/** Replay one flow's step list against the headless app. */
async function drive(flow: FlowSpec): Promise<Drive> {
  const driveState = launch(flow.fixture, DIR + "/" + flow.name);
  const { app, host, path } = driveState;
  for (const [index, step] of flow.steps.entries()) {
    const where = flow.name + " step " + (index + 1) + " (" + step.kind + ": " + step.what + ")";
    switch (step.kind) {
      case "expect":
        assertPainted(app.plan(SIZE), step.token, where);
        break;
      case "absent":
        assertAbsent(app.plan(SIZE), step.token, where);
        break;
      case "type":
        for (const char of step.text) send(app, charEvent(char));
        break;
      case "keys":
        for (const key of step.keys) send(app, keyEventOf(key));
        break;
      case "save": {
        for (const key of step.keys) send(app, keyEventOf(key));
        await drain(app, host);
        const actual = host.files.get(path) ?? null;
        check(
          actual === flow.saved,
          where + ": the bytes on disk are " + JSON.stringify((actual ?? "").slice(0, 48)) +
            ", expected " + JSON.stringify((flow.saved ?? "").slice(0, 48)),
        );
        break;
      }
      case "quit": {
        const before = host.quits();
        for (const key of step.keys) send(app, keyEventOf(key));
        await drain(app, host);
        check(host.quits() === before + 1, where + ": the quit keys did not reach the host's quit effect");
        break;
      }
    }
  }
  return driveState;
}

for (const flow of FLOWS) {
  Deno.test("pre-pty: " + flow.name + " replays its own steps against the headless app", async () => {
    const { app, host } = await drive(flow);
    const stepCount = flow.steps.length;
    console.log(
      "pre-pty: " + flow.name + " - " + stepCount + " steps, " + host.files.size + " host files, quit=" + host.quits());
    check(app.buffer.text().length > 0 || flow.fixture.text === "", flow.name + ": the app holds no document");
  });
}

Deno.test("pre-pty: scroll-large's gutter paints the line numbers the window moved to", async () => {
  const flow = flowByName("scroll-large");
  check(flow !== null, "the scroll flow is registered");
  const { app } = await drive(flow!);
  const plan = app.plan(SIZE);
  const editor = plan.regions.find((region) => region.kind === "editor");
  check(editor !== undefined, "the plan has no editor region");
  const target = (editor as Extract<PlanRegion, { kind: "editor" }>).rows.find(
    (row) => row.line === SCROLL_LARGE_TARGET_LINE - 1,
  );
  check(target !== undefined, "document line " + SCROLL_LARGE_TARGET_LINE + " is not in the scrolled window");
  const gutter = target!.spans.find((span) => span.hint === "count");
  check(gutter !== undefined, "the target row has no line-number gutter span");
  check(
    gutter!.text.includes(String(SCROLL_LARGE_TARGET_LINE)),
    "the gutter paints " + JSON.stringify(gutter!.text) + ", not line " + SCROLL_LARGE_TARGET_LINE,
  );
  console.log("pre-pty: scroll-large - the gutter moved to line " + SCROLL_LARGE_TARGET_LINE + " after the scroll");
});
