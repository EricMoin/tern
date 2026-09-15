//! Layer B's own gate: the element tree, the paint and the event source.
//!
//! THREE THINGS ARE CHECKED HERE THAT THE GOLDENS CANNOT SEE.
//!
//!   1. THE PAINT INVARIANT (warning (iv) of the layer brief). A recorded buffer
//!      proves the emitter is STABLE, not that it is RIGHT: layer A's goldens were
//!      green while its scene stacked rows sideways and clipped them to the wrong
//!      columns. So every fixture's plan is painted and compared, region row by
//!      region row, against `composeRows` — the printable transcription of the plan's
//!      own regions, rows and spans that parity/mount_paint_test.ts holds layer A's
//!      scene to. This layer REUSES that model rather than adding a second one: the
//!      plan side of the comparison is the same code, and only the painted side is
//!      this layer's (frame.ts's paint of the committed React scene).
//!   2. THE TWO ENGINE RULES, ASSERTED ON THE COMMITTED SCENE. A scroll view whose
//!      `flex_direction` is not `column` lays its rows out sideways (the engine
//!      default is `row`), and a clip rect is in scene coordinates, not the view's own
//!      box. Both are checked by reading the props of the nodes React actually
//!      committed, so a regression names the pane.
//!   3. THE EVENT SOURCE IS THE SAME DISPATCHER. A key pressed at the renderer's key
//!      subscription is replayed into the SAME `HeadlessApp` the fixtures use, and
//!      for every key-driven fixture the plan the hooks reach must be the plan the
//!      bare dispatcher reaches with the same interleaving — so "the user's screen and
//!      the fixture's screen are one code path" is executed rather than asserted.
//!      (The fixture drive itself is COLD — it dispatches before any plan has set the
//!      wrap width — so a wrap-sensitive motion means something different there; see
//!      the identity test below for the exact file:lines and the layer A comparison.)
//!      The open/edit/scroll/save/quit slice runs the same way.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/layers/react/

import { createElement } from "react";
import {
  Box as CoreBox,
  type KeyEvent,
  type MouseEventJs,
  type Renderer,
  type ResizeHandler,
} from "@tern-tui/core";
import * as reactBarrel from "@tern-tui/react";
import { createRoot } from "@tern-tui/react";
import { Buffer } from "../../core/buffer.ts";
import type { FileSystem } from "../../core/fs.ts";
import type { ModalRegion, ScreenPlan } from "../../core/plan.ts";
import { HeadlessApp } from "../../core/state.ts";
import { cellWidth, type ViewportSize } from "../../core/viewport.ts";
import { appOptions, chars, key, referencePlan } from "../../parity/goldens/fixture.ts";
import { FIXTURES } from "../../parity/goldens/index.ts";
import { compareFrames, comparePlans, frameProblems, planKey, runLayer } from "../../parity/harness.ts";
import { composeRows } from "../core/frame.ts";
import type { HostIO } from "../core/io.ts";
import { LAYER as coreLayer } from "../core/index.ts";
import { controlSpec, paletteMenuSpec, pickerSelectSpec } from "../pane-elements.ts";
import { App } from "./App.ts";
import { LAYER, paintPlan, withScene } from "./index.ts";
import { mountElement } from "./frame.ts";
import { controlElement, paletteMenuElement, pickerSelectElement } from "./pane-elements.ts";

/** Fail unless `condition`. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** Wait for a condition the layer reaches through a promise chain or a React
 * commit. The bound is a deadline, not a sleep: the loop exits on the first tick
 * that satisfies it. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for " + what);
}

// --- the renderer seam --------------------------------------------------------

/** What a mounted layer can be driven through: the mock renderer's subscriptions,
 * so a test presses keys and pastes where the real terminal would. */
interface MockRenderer {
  readonly renderer: Renderer;
  readonly keys: Set<(event: KeyEvent) => void>;
  readonly pastes: Set<(text: string) => void>;
  readonly resizes: Set<ResizeHandler>;
  readonly mice: Set<(event: MouseEventJs) => void>;
  readonly renders: () => number;
}

/**
 * A fake core `Renderer` over a DETACHED root — the framework's own test seam
 * (packages/react/src/index_test.ts:105-157): no native calls, no addon, no
 * terminal, and the commit is pure JS bookkeeping. `render` counts the commits so a
 * test can prove the frame loop actually repainted.
 */
function mockRenderer(width: number, height: number): MockRenderer {
  const root = CoreBox();
  const keys = new Set<(event: KeyEvent) => void>();
  const pastes = new Set<(text: string) => void>();
  const resizes = new Set<ResizeHandler>();
  const mice = new Set<(event: MouseEventJs) => void>();
  let renders = 0;
  const renderer = {
    root,
    size: { width, height },
    render: () => { renders += 1; },
    onKey: (handler: (event: KeyEvent) => void) => { keys.add(handler); return () => keys.delete(handler); },
    onResize: (handler: ResizeHandler) => { resizes.add(handler); return () => resizes.delete(handler); },
    onPaste: (handler: (text: string) => void) => { pastes.add(handler); return () => pastes.delete(handler); },
    onFocus: () => () => {},
    onMouse: (handler: (event: MouseEventJs) => void) => { mice.add(handler); return () => mice.delete(handler); },
    hit_test: () => [],
    clearCursor: () => {},
    setCursor: () => {},
    setTitle: () => {},
    destroy: () => {},
  } as unknown as Renderer;
  return { renderer, keys, pastes, resizes, mice, renders: () => renders };
}

/** A host that reads and writes nothing, for the tests that do not exercise IO. */
function inertHost(quit: () => void = () => {}): HostIO {
  const fs: FileSystem = {
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
  return { fs, list: () => [], quit };
}

/** Mount the layer's `App` (the tree PLUS the hooks) and run the frame loop the
 * way `main.ts` does: build the plan, repaint the tree. */
function mountLayer(
  app: HeadlessApp,
  io: HostIO,
  mock: MockRenderer,
  size: ViewportSize,
): { unmount: () => void; frames: () => number } {
  const root = createRoot(mock.renderer);
  let frames = 0;
  const frame = (next?: ViewportSize): void => {
    frames += 1;
    root.render(createElement(App, { app, io, plan: app.plan(next ?? size), frame }));
  };
  frame();
  return { unmount: () => root.unmount(), frames: () => frames };
}

/** Press `event` at the layer's key subscription, waiting for it to exist. */
async function press(mock: MockRenderer, event: KeyEvent): Promise<void> {
  await until(() => mock.keys.size > 0, "the layer's key subscription");
  for (const handler of mock.keys) handler(event);
}

/** Press `event` and wait for the frame it asks for, so the app-core sees
 * dispatch then plan — the same order a bare drive would produce. */
async function pressAndFrame(
  mock: MockRenderer,
  event: KeyEvent,
  frames: () => number,
): Promise<void> {
  await until(() => mock.keys.size > 0, "the layer's key subscription");
  const before = frames();
  for (const handler of mock.keys) handler(event);
  await until(() => frames() > before, "the frame after " + event.name);
}

// --- 1. the paint invariant ---------------------------------------------------

/** The paths where the React commit and the plan's own rows disagree. */
function paintProblems(plan: ScreenPlan): string[] {
  const painted = paintPlan(plan);
  const problems = frameProblems({ layer: LAYER.layer, rows: painted }, plan);
  const planned = composeRows(plan);
  const diffs = compareFrames(planned, painted);
  for (const diff of diffs.slice(0, 4)) {
    problems.push("row " + diff.row + " (plan, painted): " + JSON.stringify(diff.expected) +
      " vs " + JSON.stringify(diff.actual));
  }
  return problems;
}

Deno.test("react: the React commit paints the plan's frame on every screen", () => {
  for (const fixture of FIXTURES) {
    const run = runLayer(LAYER, fixture);
    check(run.planDiffs.length === 0, fixture.screen + ": the layer reached a different plan at " + run.planDiffs[0]?.path);
    check(run.problems.length === 0, fixture.screen + ": the frame is not this screen — " + run.problems[0]);
    const problems = paintProblems(run.observed);
    check(problems.length === 0, "the React scene paints a different frame than the plan lays out (" + fixture.screen +
      ", " + fixture.size.cols + "x" + fixture.size.rows + "):\n  " + problems.slice(0, 8).join("\n  "));
  }
  console.log("react paint: 12 screens — the committed scene is the plan's frame, region row by region row");
});

Deno.test("react: the emitter is a function of the plan alone", () => {
  const fixture = FIXTURES[0]!;
  const plan = referencePlan(fixture);
  const first = paintPlan(plan);
  const second = paintPlan(plan);
  check(compareFrames(first, second).length === 0, "two emits of one plan disagree");
  const relabelled = LAYER.emit(plan, "shell");
  check(compareFrames(relabelled.rows, first).length === 0, "the screen label changed the frame");
  const rows = fixture.size.rows;
  check(first.length === rows, "emitted " + first.length + " rows, the plan has " + rows);
  for (const row of first) check(cellWidth(row) === fixture.size.cols, "a row is not the plan's width");
  console.log("react: the frame is the plan's — " + rows + " rows of " + fixture.size.cols + " cells, label-independent");
});

// --- 2. the engine rules, read off the committed scene ------------------------

Deno.test("react: every pane commits column flow and its own clip rect in scene cells", () => {
  for (const fixture of FIXTURES) {
    const plan = referencePlan(fixture);
    withScene(plan, (mounted) => {
      const where = fixture.screen + ": ";
      check(mounted.props.flex_direction === "column", where + "the tree root does not stack its children as a column");
      const body = mounted.children[0];
      check(body !== undefined, where + "the tree has no body row");
      // The body's children are the PANES plus, when a modal is open, the OVERLAY —
      // which is absolutely positioned, so it is a child of the body that takes no
      // flex space (see modalElement). The panes are what the plan tiles;
      // parity/golden_test.ts pins that only the three overlay screens have one.
      const paneRegions = plan.regions.filter((region) => region.kind === "editor" || region.kind === "sidebar");
      const overlay = plan.regions.find((region) => region.kind === "modal");
      check(
        body!.children.length === paneRegions.length + (overlay === undefined ? 0 : 1),
        where + "the body holds " + body!.children.length + " children, the plan lays out " + paneRegions.length +
          " panes and " + (overlay === undefined ? "no" : "one") + " overlay",
      );
      for (const pane of body!.children.slice(0, paneRegions.length)) {
        check(pane.type === "scroll_view", where + "a pane is a " + pane.type + ", not a scroll view");
        check(pane.props.flex_direction === "column", where + "a pane's rows would flow sideways (flex_direction is " +
          JSON.stringify(pane.props.flex_direction) + ")");
        const clip = [pane.props.clip_x, pane.props.clip_y, pane.props.clip_width, pane.props.clip_height];
        const match = paneRegions.find((region) =>
          region.x === clip[0] && region.y === clip[1] && region.width === clip[2] && region.height === clip[3]
        );
        check(match !== undefined, where + "a pane's clip rect " + JSON.stringify(clip) +
          " is not a region's rectangle in scene cells (it must not be the view's own box)");
        check(pane.props.scroll_x === 0 && pane.props.scroll_y === 0, where + "a pane offsets its materialized window");
      }
      if (overlay !== undefined) {
        const element = body!.children[paneRegions.length]!;
        check(element.type === "box", where + "the overlay is a " + element.type + ", not the plan's box");
        check(element.props.position === "absolute",
          where + "the overlay is not absolutely positioned — it would push the panes aside instead of covering them");
        check(element.props.left === overlay.x && element.props.top === overlay.y,
          where + "the overlay is not at the plan's rectangle (" + element.props.left + "," + element.props.top + ")");
        check(element.props.width === overlay.width && element.props.height === overlay.height,
          where + "the overlay is not the plan's size");
        check((element.props.z_index as number) >= 1, where + "the overlay does not paint above the panes");
      }
      const mode = mounted.children[1];
      if (plan.regions.some((region) => region.kind === "mode")) {
        check(mode !== undefined, where + "the plan lays out a mode line and the tree has none");
        check(mode!.props.justify_content === "space-between", where + "the mode strip is not a space-between row");
        check(mode!.props.status_bar === true, where + "the mode strip does not own the reserved bottom row");
      }
    });
  }
  console.log("react scene: 12 screens — column flow, scene-cell clip rects, one space-between mode strip");
});

// --- 3. the event source is the same dispatcher -------------------------------

const SLICE_SIZE: ViewportSize = { rows: 24, cols: 80 };
const SLICE_PATH = "docs/example.md";
const ON_DISK = "alpha\nbeta\n";

Deno.test("react: the hooks drive open, edit, scroll, save and quit through the one dispatcher", async () => {
  const writes: Array<{ path: string; text: string }> = [];
  let reads = 0;
  let quits = 0;
  const fs: FileSystem = {
    readFile: (path: string) => { reads += 1; return Promise.resolve(path === SLICE_PATH ? ON_DISK : ""); },
    writeFile: (path: string, text: string) => { writes.push({ path, text }); return Promise.resolve(); },
  };
  const io: HostIO = { fs, list: () => ["example.md"], quit: () => { quits += 1; } };
  const app = new HeadlessApp({
    buffer: Buffer.fromString(""),
    path: SLICE_PATH,
    items: io.list("docs"),
    size: SLICE_SIZE,
  });
  const mock = mockRenderer(SLICE_SIZE.cols, SLICE_SIZE.rows);
  const mounted = mountLayer(app, io, mock, SLICE_SIZE);

  // OPEN — ctrl+o re-reads the path the app was launched with, through the host.
  await press(mock, key("o", { ctrl: true }));
  await until(() => app.buffer.text() === ON_DISK, "the opened document");
  check(reads === 1, "the open effect made " + reads + " reads");

  // EDIT — typing goes through the same dispatcher a fixture's keys go through.
  for (const event of chars("hi")) await press(mock, event);
  await until(() => app.buffer.text() === "hi" + ON_DISK, "the typed characters");
  check(app.plan(SLICE_SIZE).dirty, "an edit must leave the document dirty");

  // SCROLL — a caret motion moves the window the plan lays out.
  await press(mock, key("down"));
  await until(() => app.caret.row === 1, "the caret's row after the motion");
  check((app.plan(SLICE_SIZE).cursor?.row ?? -1) === 1, "the plan's cursor did not follow the caret");

  // SAVE — ctrl+s hands the buffer to the host, and only then clears the marker.
  await press(mock, key("s", { ctrl: true }));
  await until(() => writes.length === 1, "the save effect");
  check(writes[0]!.path === SLICE_PATH, "the save went to " + writes[0]!.path);
  check(writes[0]!.text === app.buffer.text(), "the save wrote something other than the document");
  await until(() => !app.plan(SLICE_SIZE).dirty, "the saved document to be clean");

  // QUIT — ctrl+q reaches the host's quit, and the run ends there.
  await press(mock, key("q", { ctrl: true }));
  await until(() => quits === 1, "the quit effect");
  check(mounted.frames() >= 5, "the frame loop repainted " + mounted.frames() + " times for five events");
  mounted.unmount();
  console.log("react slice: open, edit, scroll, save, quit — " + mounted.frames() + " frames, " + mock.renders() + " commits");
});

Deno.test("react: a paste reaches the document through the reducer's insert intent", async () => {
  const app = new HeadlessApp({ buffer: Buffer.fromString("ab"), size: SLICE_SIZE });
  const mock = mockRenderer(SLICE_SIZE.cols, SLICE_SIZE.rows);
  const mounted = mountLayer(app, inertHost(), mock, SLICE_SIZE);
  await until(() => mock.pastes.size > 0, "the layer's paste subscription");
  for (const handler of mock.pastes) handler("XY");
  await until(() => app.buffer.text() === "XYab", "the pasted text");
  for (const handler of mock.pastes) handler("");
  check(app.buffer.text() === "XYab", "an empty paste must not touch the document");
  app.reduce({ kind: "history", action: "undo" });
  check(app.buffer.text() === "ab", "the paste must be one undo step, like a typed insert");
  mounted.unmount();
  console.log("react paste: one insert intent, one undo step — the reducer, not a private edit path");
});

/**
 * THE HOOK PATH IS THE BARE PATH, KEY FOR KEY. A fixture's own drive (`driveApp`)
 * dispatches its keys against an app-core that has never built a plan, while a live
 * layer builds one before the first key — and `buildPlan` sets the wrap cache's width
 * (core/viewport.ts:157-158, a no-wrap `null` until then, core/wrapcache.ts:56-59).
 * That makes a wrap-sensitive motion mean two different things cold and warm:
 * `line-end`/`line-home` resolve against the caret's DISPLAY row (core/motions.ts:104-115),
 * so on the editor fixture's 86-cell line `end` lands at column 86 with no wrap cached
 * and at column 68 (the next display row's start) once the first frame has set the
 * width. Layer A's live path behaves identically, and no golden depends on it — the
 * harness drives every layer through the SHARED `referencePlan` (harness.ts:84), not
 * through keys.
 *
 * So this test isolates the LAYER: the app driven through the React hooks must reach
 * exactly the plan the SAME app-core reaches when its keys are dispatched bare, with
 * the same plan-per-key interleaving and no React anywhere. That is what layer B
 * actually claims — the hooks add no key meaning, drop no key and reorder nothing.
 */
Deno.test("react: the hook path is the bare dispatcher path, key for key", async () => {
  let checked = 0;
  for (const fixture of FIXTURES) {
    const drive = fixture.drive;
    if (drive.kind !== "app") continue;
    const app = new HeadlessApp(appOptions(fixture));
    const mock = mockRenderer(fixture.size.cols, fixture.size.rows);
    const mounted = mountLayer(app, inertHost(), mock, fixture.size);
    for (const event of drive.keys) await pressAndFrame(mock, event, mounted.frames);

    const bare = new HeadlessApp(appOptions(fixture));
    bare.plan(fixture.size);
    for (const event of drive.keys) {
      check(bare.dispatch(event), fixture.screen + ": the fixture presses a key the app does not handle");
      bare.plan(fixture.size);
    }

    const through = app.plan(fixture.size);
    const direct = bare.plan(fixture.size);
    const diffs = comparePlans(direct, through);
    check(diffs.length === 0, fixture.screen + ": the React hooks reached a different ScreenPlan than the bare dispatcher — " +
      diffs.slice(0, 4).map((diff) => diff.path + ": bare " + diff.expected + ", hooks " + diff.actual).join("; "));
    check(planKey(through) === planKey(direct), fixture.screen + ": the plan keys disagree");
    checked += 1;
    mounted.unmount();
  }
  const appFixtures = FIXTURES.filter((fixture) => fixture.drive.kind === "app").length;
  check(checked === appFixtures, "expected the " + appFixtures + " key-driven fixtures, drove " + checked);
  console.log("react identity: " + checked + " key-driven fixtures — the hook path is the bare dispatcher path, plan for plan");
});

/**
 * LAYER A AND LAYER B REACH THE SAME PLAN, deliberately: both declare
 * `defineLayer` (harness.ts:84), so the plan is the ONE app-core's in both cases and
 * the layers supply only their emitters. This test executes that claim rather than
 * assuming it, and the recorded buffers agree cell for cell on top of it.
 */
Deno.test("react: layer A and layer B reach the same ScreenPlan on every fixture", () => {
  for (const fixture of FIXTURES) {
    const reference = coreLayer.plan(fixture);
    const through = LAYER.plan(fixture);
    check(planKey(reference) === planKey(through), fixture.screen + ": layer A and layer B reached different ScreenPlans");
    check(comparePlans(reference, through).length === 0, fixture.screen + ": the two layers' plans differ field by field");
  }
  console.log("react identity: 12 fixtures — layer A and layer B reach one ScreenPlan");
});

Deno.test("react: a resize rebuilds the plan at the new size and repaints", async () => {
  const size: ViewportSize = { rows: 24, cols: 80 };
  const app = new HeadlessApp({ buffer: Buffer.fromString("alpha\nbeta\n"), size });
  const mock = mockRenderer(size.cols, size.rows);
  const mounted = mountLayer(app, inertHost(), mock, size);
  const before = mounted.frames();
  await until(() => mock.resizes.size > 0, "the layer's resize subscription");
  for (const handler of mock.resizes) handler({ width: 40, height: 12 });
  await until(() => mounted.frames() > before, "the frame the resize asks for");
  const plan = app.plan();
  check(plan.size.cols === 40 && plan.size.rows === 12, "the plan is " + plan.size.cols + "x" + plan.size.rows + ", not the resized screen");
  check(paintProblems(plan).length === 0, "the resized plan does not paint as the plan lays out");
  mounted.unmount();
  console.log("react resize: 40x12 — the plan is rebuilt and the committed scene still is the plan's frame");
});

// --- 4. the framework elements (the form primitives and the pointer route) -----

/** Press `event` at the layer's mouse subscription, waiting for it to exist. */
async function mouse(mock: MockRenderer, event: MouseEventJs): Promise<void> {
  await until(() => mock.mice.size > 0, "the layer's mouse subscription");
  for (const handler of mock.mice) handler(event);
}

Deno.test("react: the mouse translation reaches the one dispatcher", async () => {
  const size: ViewportSize = { rows: 12, cols: 30 };
  const app = new HeadlessApp({ buffer: Buffer.fromString("alpha\nbeta\ngamma\n"), size });
  const mock = mockRenderer(size.cols, size.rows);
  const mounted = mountLayer(app, inertHost(), mock, size);
  // The layer resolves NOTHING: the cell goes to the core's pointer resolver, which
  // reads it against the plan. A press on editor row 2 names document row 2.
  await mouse(mock, { kind: "down_left", column: 1, row: 2 } as MouseEventJs);
  await until(() => app.caret.row === 2, "the caret to follow the press");
  check(app.plan(size).cursor?.row === 2, "the plan's cursor did not follow the pointer");
  mounted.unmount();
  console.log("react mouse: a press reaches the one dispatcher and the plan's cursor follows it");
});

Deno.test("react: the palette Menu and picker Select are constructed; the form primitives are not", () => {
  const palette = FIXTURES.find((fixture) => fixture.screen === "palette")!;
  const paletteModal = referencePlan(palette).regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  const menu = paletteMenuSpec(paletteModal!);
  check(menu !== null, "the palette plan yielded no Menu spec");
  const menuRows = mountElement(paletteMenuElement(menu!), (node) =>
    node.children.map((child) => String(child.props.text ?? "")));
  check(menuRows.join("|") === menu!.items.map((item) => item.label).join("|"),
    "the committed Menu rows are not the palette's commands:\n  " + JSON.stringify(menuRows));

  const chooser = FIXTURES.find((fixture) => fixture.screen === "chooser")!;
  const pickerModal = referencePlan(chooser).regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  check(pickerModal !== undefined && pickerModal.id === "picker", "the chooser plan has no picker modal");
  const select = pickerSelectSpec(pickerModal!);
  check(select !== null, "the picker plan yielded no Select spec");
  const options = mountElement(pickerSelectElement(select!), (node) =>
    node.children.slice(1).map((child) => String(child.props.text ?? "")));
  check(options.join("|") === select!.options.map((option) => option.label).join("|"),
    "the committed Select rows are not the picker's files:\n  " + JSON.stringify(options));

  // The gap, asserted rather than assumed: the barrel exports no host component for
  // the form primitives, and a core scene Node is not a React child.
  check(!("Checkbox" in reactBarrel) && !("Radio" in reactBarrel) && !("Toggle" in reactBarrel),
    "a form primitive is now exported by @tern-tui/react — mount it and drop the gap");
  const preferences = FIXTURES.find((fixture) => fixture.screen === "preferences")!;
  const modal = referencePlan(preferences).regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  const span = modal!.rows.flatMap((row) => row.spans).find((entry) => entry.text.startsWith("["));
  check(span !== undefined, "the preferences plan has no checkbox row");
  const spec = controlSpec(modal!.id, span!.text);
  check(spec !== null, "the preferences checkbox row yielded no control spec");
  check(controlElement(spec!) === null, "React constructed a form primitive it cannot host");
  console.log("react elements: palette Menu + picker Select commit; Checkbox/Radio/Toggle remain unhosted (fix-react-form-primitives-unhosted)");
});
