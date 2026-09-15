//! Layer C's own gate: the element tree, the paint, the two seams and the event
//! source.
//!
//! FOUR THINGS ARE CHECKED HERE THAT THE GOLDENS CANNOT SEE.
//!
//!   1. THE PAINT INVARIANT (warning (iv) of the layer brief). A recorded buffer
//!      proves the emitter is STABLE, not that it is RIGHT: layer A's goldens were
//!      green while its scene stacked rows sideways and clipped them to the wrong
//!      columns. So every fixture's plan is painted and compared, region row by
//!      region row, against `composeRows` — the printable transcription of the plan's
//!      own regions, rows and spans that parity/mount_paint_test.ts holds layer A's
//!      scene to. This layer REUSES that model rather than adding a second one: the
//!      plan side of the comparison is the same code, and only the painted side is
//!      this layer's (frame.ts's paint of the committed Solid scene).
//!   2. THE TWO ENGINE RULES, ASSERTED ON THE COMMITTED SCENE. A scroll view whose
//!      `flex_direction` is not `column` lays its rows out sideways (the engine
//!      default is `row`), and a clip rect is in scene coordinates, not the view's own
//!      box. Both are checked by reading the props of the nodes the Solid reconciler
//!      actually committed, so a regression names the pane.
//!   3. THE TWO SEAMS LAYER B COULD NOT REACH ARE EXERCISED, NOT ASSUMED. Every pane
//!      declares its whole geometry through `declareVirtualContent` — asserted by
//!      clamping a scroll request at 1e6 rows against the DECLARED height, which is
//!      the registry's own G2 case — and the mode line is the framework's own
//!      `status_bar` node over scene-node segments, asserted on the committed node.
//!   4. THE EVENT SOURCE IS THE SAME DISPATCHER. A key pressed at the renderer's key
//!      subscription is replayed into the SAME `HeadlessApp` the fixtures use, and
//!      for every key-driven fixture the plan the primitives reach must be the plan
//!      the bare dispatcher reaches with the same interleaving — so "the user's
//!      screen and the fixture's screen are one code path" is executed rather than
//!      asserted.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/layers/solid/

import {
  Box as CoreBox,
  createRenderer,
  scrollTo,
  type KeyEvent,
  type Node,
  type Renderer,
  type ResizeHandler,
} from "@tern-tui/core";
import { withFakeAddon } from "../../../../core/src/testkit/fakes.ts";
import { Buffer } from "../../core/buffer.ts";
import type { FileSystem } from "../../core/fs.ts";
import type { EditorRegion, ScreenPlan, SidebarRegion } from "../../core/plan.ts";
import { HeadlessApp } from "../../core/state.ts";
import { cellWidth, type ViewportSize } from "../../core/viewport.ts";
import { appOptions, chars, key, referencePlan } from "../../parity/goldens/fixture.ts";
import { FIXTURES } from "../../parity/goldens/index.ts";
import { compareFrames, comparePlans, frameProblems, planKey, runLayer } from "../../parity/harness.ts";
import { composeRows } from "../core/frame.ts";
import type { HostIO } from "../core/io.ts";
import { LAYER as coreLayer } from "../core/index.ts";
import { LAYER as reactLayer } from "../react/index.ts";
import { LAYER, mountPlanScene, paintMounted, paintPlan, withScene } from "./index.ts";
import { attachLayerInput, createPlanStore } from "./primitives.ts";

/** Fail unless `condition`. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** Wait for a condition the layer reaches through a promise chain. The bound is a
 * deadline, not a sleep: the loop exits on the first tick that satisfies it. */
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
  readonly root: Node;
  readonly keys: Set<(event: KeyEvent) => void>;
  readonly pastes: Set<(text: string) => void>;
  readonly resizes: Set<ResizeHandler>;
  readonly renders: () => number;
}

/**
 * A fake core `Renderer` over a DETACHED root — the framework's own test seam
 * (packages/solid/src/index_test.ts:827-860): no native calls, no addon, no
 * terminal, and every scene mutation is pure JS bookkeeping. `render` counts the
 * paints so a test can prove the frame loop actually repainted.
 */
function mockRenderer(width: number, height: number): MockRenderer {
  const root = CoreBox();
  const keys = new Set<(event: KeyEvent) => void>();
  const pastes = new Set<(text: string) => void>();
  const resizes = new Set<ResizeHandler>();
  let renders = 0;
  const renderer = {
    root,
    size: { width, height },
    render: () => { renders += 1; },
    onKey: (handler: (event: KeyEvent) => void) => { keys.add(handler); return () => keys.delete(handler); },
    onResize: (handler: ResizeHandler) => { resizes.add(handler); return () => resizes.delete(handler); },
    onPaste: (handler: (text: string) => void) => { pastes.add(handler); return () => pastes.delete(handler); },
    onFocus: () => () => {},
    onMouse: () => () => {},
    clearCursor: () => {},
    setCursor: () => {},
    setTitle: () => {},
    destroy: () => {},
  } as unknown as Renderer;
  return { renderer, root, keys, pastes, resizes, renders: () => renders };
}

/** A host that reads and writes nothing, for the tests that do not exercise IO. */
function inertHost(quit: () => void = () => {}): HostIO {
  const fs: FileSystem = {
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
  return { fs, list: () => [], quit };
}

/**
 * Mount the layer the way `main.ts` does: a plan signal, the reactive scene under
 * the renderer's own root, the event source attached once. `frame` writes a new plan
 * into the signal, which is what re-runs the emitter.
 */
function mountLayer(
  app: HeadlessApp,
  io: HostIO,
  mock: MockRenderer,
  size: ViewportSize,
): { unmount: () => void; frames: () => number; host: Node } {
  const store = createPlanStore(app.plan(size));
  const disposeScene = mountPlanScene(store.plan, mock.root);
  let frames = 0;
  const frame = (next?: ViewportSize): void => {
    frames += 1;
    store.setPlan(app.plan(next ?? size));
  };
  const detach = attachLayerInput(mock.renderer, app, io, frame);
  return {
    unmount: () => {
      detach();
      disposeScene();
    },
    frames: () => frames,
    host: mock.root,
  };
}

/** Press `event` at the layer's key subscription, waiting for it to exist. */
async function press(mock: MockRenderer, event: KeyEvent): Promise<void> {
  await until(() => mock.keys.size > 0, "the layer's key subscription");
  for (const handler of mock.keys) handler(event);
}

/** Press `event` and wait for the frame it asks for, so the app-core sees dispatch
 * then plan — the same order a bare drive would produce. */
async function pressAndFrame(mock: MockRenderer, event: KeyEvent, frames: () => number): Promise<void> {
  await until(() => mock.keys.size > 0, "the layer's key subscription");
  const before = frames();
  for (const handler of mock.keys) handler(event);
  await until(() => frames() > before, "the frame after " + event.name);
}

/** The paths where the Solid mount and the plan's own rows disagree. */
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

// --- 1. the paint invariant ---------------------------------------------------

Deno.test("solid: the Solid mount paints the plan's frame on every screen", () => {
  for (const fixture of FIXTURES) {
    const run = runLayer(LAYER, fixture);
    check(run.planDiffs.length === 0, fixture.screen + ": the layer reached a different plan at " + run.planDiffs[0]?.path);
    check(run.problems.length === 0, fixture.screen + ": the frame is not this screen — " + run.problems[0]);
    const problems = paintProblems(run.observed);
    check(problems.length === 0, "the Solid scene paints a different frame than the plan lays out (" + fixture.screen +
      ", " + fixture.size.cols + "x" + fixture.size.rows + "):\n  " + problems.slice(0, 8).join("\n  "));
  }
  console.log("solid paint: 12 screens — the committed scene is the plan's frame, region row by region row");
});

Deno.test("solid: the emitter is a function of the plan alone", () => {
  const fixture = FIXTURES[0]!;
  const plan = referencePlan(fixture);
  const first = paintPlan(plan);
  const second = paintPlan(plan);
  check(compareFrames(first, second).length === 0, "two emits of one plan disagree");
  const relabelled = LAYER.emit(plan, "shell");
  check(compareFrames(relabelled.rows, first).length === 0, "the screen label changed the frame");
  check(first.length === fixture.size.rows, "emitted " + first.length + " rows, the plan has " + fixture.size.rows);
  for (const row of first) check(cellWidth(row) === fixture.size.cols, "a row is not the plan's width");
  console.log("solid: the frame is the plan's — " + fixture.size.rows + " rows of " + fixture.size.cols +
    " cells, label-independent");
});

// --- 2. the engine rules and the two seams, on the committed scene ------------

/** The committed plan root of `plan` and its body row. */
function committed(plan: ScreenPlan): { root: Node; body: Node } {
  return withScene(plan, (root) => {
    const body = root.children[0];
    if (body === undefined) throw new Error("the tree has no body row");
    return { root, body };
  });
}

Deno.test("solid: every pane commits column flow, its own scene-cell clip rect and its declared content", () => {
  for (const fixture of FIXTURES) {
    const plan = referencePlan(fixture);
    const where = fixture.screen + ": ";
    const { root, body } = committed(plan);
    check(root.props.flex_direction === "column", where + "the tree root does not stack its children as a column");
    // The body's children are the PANES plus, when a modal is open, the OVERLAY —
    // absolutely positioned, so it takes no flex space (see modalElement). Only the
    // three overlay screens lay one out (parity/golden_test.ts pins that).
    const paneRegions = plan.regions.filter((region) => region.kind === "editor" || region.kind === "sidebar");
    const overlay = plan.regions.find((region) => region.kind === "modal");
    check(
      body.children.length === paneRegions.length + (overlay === undefined ? 0 : 1),
      where + "the body holds " + body.children.length + " children, the plan lays out " + paneRegions.length +
        " panes and " + (overlay === undefined ? "no" : "one") + " overlay",
    );
    for (const pane of body.children.slice(0, paneRegions.length)) {
      check(pane.type === "scroll_view", where + "a pane is a " + pane.type + ", not a scroll view");
      check(pane.props.flex_direction === "column", where + "a pane's rows would flow sideways (flex_direction is " +
        JSON.stringify(pane.props.flex_direction) + ")");
      const clip = [pane.props.clip_x, pane.props.clip_y, pane.props.clip_width, pane.props.clip_height];
      const region = paneRegions.find((candidate) =>
        candidate.x === clip[0] && candidate.y === clip[1] && candidate.width === clip[2] && candidate.height === clip[3]
      );
      check(region !== undefined, where + "a pane's clip rect " + JSON.stringify(clip) +
        " is not a region's rectangle in scene cells (it must not be the view's own box)");
      check(pane.props.scroll_x === 0 && pane.props.scroll_y === 0, where + "a pane offsets its materialized window");
    }
    if (overlay !== undefined) {
      const element = body.children[paneRegions.length]!;
      check(element.type === "box", where + "the overlay is a " + element.type + ", not the plan's box");
      check(element.props.position === "absolute",
        where + "the overlay is not absolutely positioned — it would push the panes aside instead of covering them");
      check(element.props.left === overlay.x && element.props.top === overlay.y,
        where + "the overlay is not at the plan's rectangle (" + element.props.left + "," + element.props.top + ")");
      check(element.props.width === overlay.width && element.props.height === overlay.height,
        where + "the overlay is not the plan's size");
      check((element.props.z_index as number) >= 1, where + "the overlay does not paint above the panes");
    }
    const mode = root.children[1];
    if (plan.regions.some((region) => region.kind === "mode")) {
      check(mode !== undefined, where + "the plan lays out a mode line and the tree has none");
      check(mode!.props.justify_content === "space-between", where + "the mode strip is not a space-between row");
      check(mode!.props.status_bar === true, where + "the mode strip does not own the reserved bottom row");
    }
  }
  console.log("solid scene: 12 screens — column flow, scene-cell clip rects, one space-between mode strip");
});

/**
 * THE G2 SEAM IS EXERCISED, NOT ASSUMED. A detached scene cannot answer a scroll
 * clamp at all — `maxScroll` reads `Node.contentSize()`, which throws "node is not
 * attached to a scene" (packages/core/src/node.ts:424-427) — so this test mounts the
 * layer's own scene on a renderer over the framework's fake-addon seam
 * (packages/core/src/testkit/fakes.ts:716, the seam layer A's record.ts and
 * parity/mount_paint_test.ts smoke the scene through). The clamp a 1e6-row scroll
 * request lands on measures the DECLARED geometry, not the window: the declaration is
 * checked before the per-child walk (packages/core/src/scrollview.ts:197-210), and the
 * fake's fixed `content_size` stub (fakes.ts:121-123) is discarded with it.
 */
Deno.test("solid: both panes declare their whole geometry through the G2 seam", () => {
  let checked = 0;
  // The panes the twelve fixtures actually lay out — a hidden sidebar is absent from
  // `regions`, so the total is not simply 2 x 12.
  const panes = FIXTURES.reduce(
    (total, fixture) => total + referencePlan(fixture).regions.filter((region) => region.kind === "editor" || region.kind === "sidebar").length,
    0,
  );
  for (const fixture of FIXTURES) {
    const plan = referencePlan(fixture);
    withFakeAddon(() => {
      const renderer = createRenderer();
      const dispose = mountPlanScene(() => plan, renderer.root);
      try {
        const root = renderer.root.children[0];
        check(root !== undefined, fixture.screen + ": the mount left no tree under the renderer root");
        const body = root!.children[0];
        check(body !== undefined, fixture.screen + ": the tree has no body row");
        const panes = body!.children;
        const paneRegions = plan.regions.filter((region) => region.kind === "editor" || region.kind === "sidebar");
        paneRegions.forEach((region, index) => {
          const pane = panes[index]!;
          const declared = region.kind === "editor"
            ? (region as EditorRegion).totalRows
            : (region as SidebarRegion).count;
          const clamped = scrollTo(pane, 0, 1_000_000).y;
          const expected = Math.max(0, declared - region.height);
          check(
            clamped === expected,
            fixture.screen + " pane " + index + " (" + region.kind + "): a 1e6-row scroll clamps to " + clamped +
              ", the declared content is " + declared + " rows over a " + region.height + "-row viewport (" + expected + ")",
          );
          const materialized = pane.children.length;
          const wanted = region.kind === "editor"
            ? (region as EditorRegion).rows.length
            : (region as SidebarRegion).items.length;
          check(materialized === wanted, fixture.screen + " pane " + index +
            ": materializes " + materialized + " rows, the plan's window is " + wanted);
          checked += 1;
        });
      } finally {
        dispose();
        renderer.destroy();
      }
    });
  }
  check(checked === panes, "expected " + panes + " panes across the twelve fixtures, checked " + checked);
  console.log("solid G2: " + checked + " panes — a 1e6-row scroll clamps to the declared height, not the window");
});

/** The leaf texts of a committed subtree, in paint order. */
function textsOf(node: Node): string[] {
  if (node.children.length === 0) {
    return [typeof node.props.text === "string" ? node.props.text : ""];
  }
  return node.children.flatMap((child) => textsOf(child));
}

Deno.test("solid: the mode line is the framework's own status_bar over scene-node segments", () => {
  let checked = 0;
  for (const fixture of FIXTURES) {
    const plan = referencePlan(fixture);
    const mode = plan.regions.find((region) => region.kind === "mode");
    if (mode === undefined) continue;
    const left = mode.segments.filter((segment) => segment.align === "left");
    const right = mode.segments.filter((segment) => segment.align === "right");
    withScene(plan, (root) => {
      const strip = root.children[1];
      check(strip !== undefined && strip.type === "status_bar", fixture.screen + ": the mode line is not a status_bar node");
      check(strip!.props.status_bar === true, fixture.screen + ": the strip does not own the reserved bottom row");
      const groups = strip!.children;
      const expected = (left.length > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0);
      check(groups.length === expected, fixture.screen + ": the strip holds " + groups.length +
        " alignment groups, the plan places " + left.length + " left and " + right.length + " right segments");
      // The segment is a SCENE node (a solid element IS a core Node), which is what
      // layer B could not pass: StatusBarSegment is string | Node (statusbar.ts:6).
      let at = 0;
      for (const [segments, align] of [[left, "left"], [right, "right"]] as const) {
        if (segments.length === 0) continue;
        const group = groups[at]!;
        at += 1;
        check(group.type === "text" || group.type === "box", fixture.screen + ": the " + align + " segment is a " + group.type);
        const painted = textsOf(group).join("");
        const planned = segments.map((segment) => segment.text).join("");
        check(painted === planned, fixture.screen + ": the " + align + " group paints " + JSON.stringify(painted) +
          ", the plan places " + JSON.stringify(planned));
      }
      checked += 1;
    });
  }
  check(checked === 12, "expected the mode line on all twelve fixtures, checked " + checked);
  console.log("solid status bar: " + checked + " screens — Node segments through the framework's own factory");
});

// --- 3. the event source is the same dispatcher -------------------------------

const SLICE_SIZE: ViewportSize = { rows: 24, cols: 80 };
const SLICE_PATH = "docs/example.md";
const ON_DISK = "alpha\nbeta\n";

Deno.test("solid: the primitives drive open, edit, scroll, save and quit through the one dispatcher", async () => {
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
  console.log("solid slice: open, edit, scroll, save, quit — " + mounted.frames() + " frames, " + mock.renders() + " paints");
});

Deno.test("solid: a paste reaches the document through the reducer's insert intent", async () => {
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
  console.log("solid paste: one insert intent, one undo step — the reducer, not a private edit path");
});

/**
 * THE SUBSCRIPTION PATH IS THE BARE PATH, KEY FOR KEY — the same claim layer B
 * executes (layers/react/app_test.ts:304-350). A fixture's own drive dispatches its
 * keys against an app-core that has never built a plan, while a live layer builds one
 * before the first key, and `buildPlan` sets the wrap cache's width (core/
 * viewport.ts:157-158, a no-wrap `null` until then, core/wrapcache.ts:56-59). That
 * makes a wrap-sensitive motion mean two different things cold and warm — so this
 * test isolates the LAYER: the app driven through the Solid subscriptions must reach
 * exactly the plan the SAME app-core reaches when its keys are dispatched bare, with
 * the same plan-per-key interleaving and no Solid anywhere.
 */
Deno.test("solid: the subscription path is the bare dispatcher path, key for key", async () => {
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
    check(diffs.length === 0, fixture.screen + ": the Solid subscriptions reached a different ScreenPlan than the bare dispatcher — " +
      diffs.slice(0, 4).map((diff) => diff.path + ": bare " + diff.expected + ", mounted " + diff.actual).join("; "));
    check(planKey(through) === planKey(direct), fixture.screen + ": the plan keys disagree");
    checked += 1;
    mounted.unmount();
  }
  check(checked === 11, "expected the 11 key-driven fixtures, drove " + checked);
  console.log("solid identity: " + checked + " key-driven fixtures — the subscription path is the bare dispatcher path, plan for plan");
});

/**
 * ALL THREE LAYERS REACH THE SAME PLAN, deliberately: every layer declares
 * `defineLayer` (harness.ts:84), so the plan is the ONE app-core's in all three cases
 * and the layers supply only their emitters. This test executes that claim rather than
 * assuming it, and the recorded buffers agree cell for cell on top of it.
 */
Deno.test("solid: layers A, B and C reach the same ScreenPlan on every fixture", () => {
  for (const fixture of FIXTURES) {
    const reference = coreLayer.plan(fixture);
    const throughReact = reactLayer.plan(fixture);
    const throughSolid = LAYER.plan(fixture);
    check(planKey(reference) === planKey(throughReact), fixture.screen + ": layer A and layer B reached different ScreenPlans");
    check(planKey(reference) === planKey(throughSolid), fixture.screen + ": layer A and layer C reached different ScreenPlans");
    check(comparePlans(reference, throughSolid).length === 0, fixture.screen + ": layer A and layer C differ field by field");
  }
  console.log("solid identity: 12 fixtures — layers A, B and C reach one ScreenPlan");
});

Deno.test("solid: a resize rebuilds the plan at the new size and repaints", async () => {
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
  console.log("solid resize: 40x12 — the plan is rebuilt and the committed scene still is the plan's frame");
});

// --- 4. the reactive wrapper --------------------------------------------------

/**
 * THE PLAN SIGNAL IS WHAT RE-RUNS THE EMITTER, and the committed root is what stays
 * put. Solid components run once (`createComponent` is
 * `untrack(() => Comp(props))`, node_modules/solid-js/dist/solid.js:1274-1285):
 * nothing re-renders a tree whose props merely changed. The reactivity is the `plan`
 * GETTER `mountPlanScene` passes and `planRoot` reads inside the renderer's per-prop
 * effects — so a plan write re-emits into the SAME root node (re-propped and
 * re-reconciled, not replaced) and the paint follows. This test is what makes
 * "primitives.ts holds the thin reactive wrapper" an executed fact rather than a
 * described one.
 */
Deno.test("solid: a plan write re-emits into the committed root and the paint follows", () => {
  const first = referencePlan(FIXTURES[0]!);
  const second = referencePlan(FIXTURES[11]!);
  check(planKey(first) !== planKey(second), "the two fixtures must be different screens");
  const host = CoreBox();
  const store = createPlanStore(first);
  const dispose = mountPlanScene(store.plan, host);
  const mounted = host.children[0];
  check(mounted !== undefined, "the mount left no tree under the host");
  check(host.children.length === 1, "the mount left " + host.children.length + " trees under the host");
  check(
    compareFrames(paintMounted(mounted!, first.size.cols, first.size.rows), composeRows(first)).length === 0,
    "the mounted tree does not paint its plan",
  );

  store.setPlan(second);
  check(host.children.length === 1, "the write left " + host.children.length + " trees under the host");
  check(host.children[0] === mounted, "the plan write replaced the committed root instead of re-emitting into it");
  check(mounted!.props.width === second.size.cols, "the root kept its old width (" + String(mounted!.props.width) + ")");
  check(
    compareFrames(paintMounted(mounted!, second.size.cols, second.size.rows), composeRows(second)).length === 0,
    "the re-emitted tree does not paint the new plan",
  );
  dispose();
  console.log("solid reactive: one plan write — the emitter re-ran in place and the committed root is the new plan's frame");
});
