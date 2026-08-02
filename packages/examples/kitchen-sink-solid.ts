/**
 * kitchen-sink-solid — @tern/solid kitchen-sink demo.
 *
 * The `@tern/solid` counterpart of `kitchen-sink-react.ts`: the same widget
 * surface built through the solid element factories, exercising `Panels`
 * (with the core mouse drag-resize helpers), `ScrollView` (clip/scroll
 * region + track/thumb scrollbar, driven by `scrollTo`), `StreamingText`
 * auto-scroll (fed by `subscribeStream`, which pumps `syncStreamTail`),
 * `DiffView`, `Select` (driven by `selectKey`), a determinate `Spinner`, a
 * `StatusBar`, and a custom theme via `setTheme` (`role` / `component`
 * hints resolved onto plain node props at element-creation time).
 *
 * Every widget is asserted against its scene node after driving it: a
 * failing assertion prints a `FAIL` line, tears the renderer down and exits
 * 1 — so the PTY smoke harness (`run-smoke.sh`) only sees exit 0 when every
 * scene assertion holds. The event loop then quits on 'q' (core `onKey`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import {
  createRenderer,
  SCROLLBAR_THUMB_CHAR,
  type MouseEventJs,
} from "@tern/core";
import {
  Box,
  DiffView,
  Panels,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Text,
  dragPanels,
  endPanelDrag,
  isStreamFollowing,
  render as solidRender,
  scrollTo,
  selectKey,
  setTheme,
  startPanelDrag,
  subscribeStream,
  tick,
  type KeyEvent,
  type Node,
  type Renderer,
  type Span,
} from "@tern/solid";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Streaming source (auto-scroll demo)
// ---------------------------------------------------------------------------

/** The newline-terminated lines streamed into the `StreamingText` node. */
const STREAM_LINES = ["stream line 1\n", "stream line 2\n", "stream line 3\n"];

/**
 * The accumulated text of the stream, recorded as `subscribeStream` consumes
 * each span (a span is recorded right after the pump's `yield` resolves,
 * before it appends — so `streamed.length` tracks the appended count). The
 * scene-side stream is not readable back through the binding, so this record
 * is the demo's assertion source.
 */
const streamed: string[] = [];

/** The demo's stream: yields each line after a short timer delay. */
async function* stream(): AsyncIterable<Span> {
  for (const line of STREAM_LINES) {
    yield { text: line };
    streamed.push(line);
  }
}

// ---------------------------------------------------------------------------
// Diff model + select options
// ---------------------------------------------------------------------------

/** A small unified diff: a context run around a del/add pair. */
const DIFF_HUNKS = [
  { kind: "ctx" as const, old_line: 1, new_line: 1, text: "  fn main() {" },
  { kind: "del" as const, old_line: 2, new_line: 0, text: "    let x = 1;" },
  { kind: "add" as const, old_line: 0, new_line: 2, text: "    let x = 2;" },
  { kind: "ctx" as const, old_line: 3, new_line: 3, text: "  }" },
];

/** The options of the `Select` dropdown. */
const SELECT_OPTIONS = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[kitchen-sink-solid] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[kitchen-sink-solid] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[kitchen-sink-solid]", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scene, built through the @tern/solid factories
// ---------------------------------------------------------------------------

/** The root box holding the kitchen-sink widgets, in assertion order. */
const box = Box({ flex_direction: "column" });

// Panels: a 2-panel column stack; the drag-resize helpers resize the pane
// above the 1-cell gutter (roadmap Phase 2). First child -> scene origin,
// which the drag helpers treat as the panels element's top-left.
box.addChild(
  Panels({
    panels: [
      { header: "A", body: Box({ height: 3 }) },
      { header: "B", body: Box({ height: 2 }) },
    ],
    direction: "column",
    height: 8,
  }),
);

// ScrollView: a 5x2 clip region with a track + thumb scrollbar.
box.addChild(
  ScrollView({
    width: 5,
    height: 2,
    showScrollbar: true,
    children: [Text({ text: "aaaa\nbbbbb\ncc" })],
  }),
);

// StreamingText: auto-scroll keeps scroll_y pinned to the stream tail.
const streamNode = StreamingText({ clip_height: 2 });
box.addChild(streamNode);

// DiffView: per-kind rows (green adds, red dels, dim context).
box.addChild(DiffView({ hunks: DIFF_HUNKS }));

// Select: typeahead filter + highlight, confirmed via enter.
const select = Select({ options: SELECT_OPTIONS });
box.addChild(select);

// Spinner: a determinate progress bar (tick is a no-op on it).
box.addChild(Spinner({ value: 5, max: 10, width: 4 }));

// StatusBar: left/center/right segments on a 1-row strip.
box.addChild(StatusBar({ left: "L", center: "C", right: "R" }));

// Theme: setTheme swaps the module-level theme; role=primary resolves the
// custom palette fg and component=input the preset border_style.
setTheme({
  palette: { primary: { fg: "#123456" } },
  components: { input: { border_style: "double" } },
});
box.addChild(Box({ role: "primary" }));
box.addChild(Box({ component: "input" }));

// Mount the scene through the solid renderer's universal `render()`.
const dispose = solidRender(() => box, renderer.root);
renderer.render();

// Feed the streaming node through the solid streaming API: the pump appends
// each span to the now-attached node (straight into the shared scene) and
// feeds the core auto-scroll (`syncStreamTail`).
const unsubscribe = subscribeStream(streamNode, stream());

// Wait for all STREAM_LINES spans to be appended, then paint the scene.
const streamDeadline = Date.now() + 2000;
while (streamed.length < STREAM_LINES.length && Date.now() < streamDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
renderer.render();

// ---------------------------------------------------------------------------
// Scene assertions (a failure prints FAIL and exits 1)
// ---------------------------------------------------------------------------

/** Assert a scene property; on failure tear down and exit 1. */
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[kitchen-sink-solid] ok: ${label}`);
    return;
  }
  console.error(`[kitchen-sink-solid] FAIL: ${label}`);
  renderer.destroy();
  process.exit(1);
}

/** Build a mouse event payload. */
function mouse(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

const rootBox: Node | undefined = renderer.root.children[0];
const kids: readonly Node[] = rootBox?.children ?? [];
const [panels, scrollView, streamNode2, diff, select2, spinner, statusBar, themedPrimary, themedInput] = kids;

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(kids.length === 9, `scene holds 9 widget nodes (got ${kids.length})`);
assert(
  kids[0]?.type === "panels" &&
    kids[1]?.type === "scroll_view" &&
    kids[2]?.type === "streaming_text" &&
    kids[3]?.type === "diff" &&
    kids[4]?.type === "select" &&
    kids[5]?.type === "spinner" &&
    kids[6]?.type === "status_bar",
  "widget element types materialize in scene order",
);

// --- Panels mouse drag-resize ------------------------------------------------
assert(panels?.contentSize().height === 8, "panels stack lays out 8 rows tall");
const gutter0 = panels?.children[0]?.contentSize().height ?? 0;
assert(gutter0 === 4, `panel A lays out 4 rows (header + 3-row body), gutter at row 4 (got ${gutter0})`);
const started = startPanelDrag(panels!, mouse("down_left", 0, gutter0));
assert(
  started !== null && started.index === 0 && started.direction === "column",
  "down_left on the gutter starts a column drag for pane 0",
);
const upper = (panels?.contentSize().height ?? 0) - 1 - 1;
const expectedBasis = Math.min(Math.max(gutter0 + 2, 1), Math.max(1, upper));
const drag = dragPanels(panels!, mouse("drag_left", 0, gutter0 + 2));
assert(
  drag !== null && drag.flex_basis === expectedBasis,
  `drag_left +2 applies flex_basis ${expectedBasis} (got ${drag?.flex_basis})`,
);
assert(
  (panels?.children[0]?.props.flex_basis as number | undefined) === expectedBasis,
  "pane A's flex_basis is recorded on its scene node",
);
assert(expectedBasis > gutter0, `the drag grows pane A past its laid-out size (${gutter0} -> ${expectedBasis})`);
assert(endPanelDrag(panels!) !== null, "up_left ends the drag session");
assert(dragPanels(panels!, mouse("drag_left", 0, gutter0 + 3)) === null, "a drag after up_left is inert");
assert(startPanelDrag(panels!, mouse("down_left", 0, 1)) === null, "a press inside a panel body does not start a drag");

// --- ScrollView + scrollbar --------------------------------------------------
const scrollbarLeaf = scrollView?.children.find((child) => child.props.position === "absolute");
const scrollContent = scrollView?.children.find((child) => child.type === "text" && child.props.position !== "absolute");
assert(scrollView?.children.length === 2, "scroll view composes the content leaf + the scrollbar leaf");
assert(scrollbarLeaf !== undefined, "showScrollbar appends an absolutely positioned scrollbar leaf");
assert(scrollContent?.props.text === "aaaa\nbbbbb\ncc", "scroll view holds the content text leaf");
const scrollApplied = scrollTo(scrollView!, 0, 1);
assert(
  scrollApplied.x === 0 && scrollApplied.y === 1,
  `scrollTo(0, 1) applies (0, 1) (got ${JSON.stringify(scrollApplied)})`,
);
assert(scrollView?.props.scroll_x === 0 && scrollView?.props.scroll_y === 1, "scroll_x/scroll_y props are updated");
assert(
  typeof scrollbarLeaf!.props.text === "string" && scrollbarLeaf!.props.text.includes(SCROLLBAR_THUMB_CHAR),
  "scrollbar leaf paints a thumb",
);
assert((scrollbarLeaf!.props.height as number | undefined ?? 0) >= 1, "scrollbar leaf is sized to the viewport");

// --- StreamingText auto-scroll ------------------------------------------------
assert(streamNode2?.type === "streaming_text", "streaming node materializes");
assert(streamed.length === STREAM_LINES.length, `stream consumed all ${STREAM_LINES.length} spans`);
assert(isStreamFollowing(streamNode2!), "auto-scroll follows the stream tail");
const streamContentHeight = streamNode2?.contentSize().height ?? 0;
assert(
  streamNode2?.props.scroll_y === Math.max(0, streamContentHeight - 2),
  `scroll_y is pinned to the tail (content ${streamContentHeight} - clip 2 = ${Math.max(0, streamContentHeight - 2)})`,
);

// --- DiffView -----------------------------------------------------------------
assert(diff?.children.length === DIFF_HUNKS.length, `diff renders ${DIFF_HUNKS.length} rows`);
assert(diff?.children[0]?.children[0]?.props.text === "1 1", "gutter right-aligns the old/new line numbers");
assert(diff?.children[1]?.children[1]?.props.text === "-", "deleted rows carry a '-' marker");
assert(diff?.children[2]?.children[1]?.props.fg === "#98c379", "added rows are painted green");
assert(diff?.children[3]?.children[2]?.props.dim === true, "context rows are dimmed");

// --- Select --------------------------------------------------------------------
assert(select2?.children.length === 4, "select composes a filter row + 3 option rows");
const downKey: KeyEvent = { name: "down", ctrl: false, alt: false, shift: false };
const afterDown = selectKey(select2!, downKey);
assert(afterDown.highlighted === 1, "down moves the highlight to option 1");
const enterKey: KeyEvent = { name: "enter", ctrl: false, alt: false, shift: false };
const afterEnter = selectKey(select2!, enterKey);
assert(
  afterEnter.value === "banana" && afterEnter.open === false,
  `enter confirms the highlighted option ("banana", dropdown dismissed)`,
);
assert(select2?.props.value === "banana", "the select node's value prop carries the confirmation");
const typeaheadKey: KeyEvent = { name: "char", char: "b", ctrl: false, alt: false, shift: false };
const afterTypeahead = selectKey(select2!, typeaheadKey);
assert(afterTypeahead.filter === "b", "typeahead appends to the filter query");

// --- Spinner (determinate) -------------------------------------------------------
assert(spinner?.props.text === "▓▓░░", "determinate spinner renders 2 of 4 cells filled");
assert(tick(spinner!) === "▓▓░░", "tick is a no-op on a determinate spinner");

// --- StatusBar -------------------------------------------------------------------
assert(statusBar?.children.length === 3, "status bar holds 3 segments");
assert(
  statusBar?.children.map((child) => child.props.text).join(",") === "L,C,R",
  "left/center/right segments render in order",
);
assert(statusBar?.props.height === 1, "status bar strip is 1 row tall");
assert(!("left" in (statusBar?.props ?? {})), "segment keys are lifted out of the strip props");

// --- Theme ------------------------------------------------------------------------
assert(themedPrimary?.props.fg === "#123456", "role=primary resolves the custom palette fg");
assert(themedInput?.props.border_style === "double", "component=input resolves the preset border_style");

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (core onKey), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
renderer.onKey((event: KeyEvent) => {
  if (event.name === "char" && event.char === "q") quit = true;
});

const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  try {
    renderer.pollEvents(50);
  } catch {
    // The renderer was destroyed inside pollEvents (ctrl+c with
    // exitOnCtrlC) — a clean quit.
    quit = true;
    break;
  }
}
unsubscribe();
dispose?.();
renderer.destroy();

if (!quit) {
  console.error("[kitchen-sink-solid] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[kitchen-sink-solid] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[kitchen-sink-solid] ok: kitchen-sink scene asserted and quit on 'q'");
process.exit(0);
