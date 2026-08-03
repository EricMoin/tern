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
  MARKDOWN_FENCE_BG,
  MarkdownView,
  createRenderer,
  SCROLLBAR_THUMB_CHAR,
  type MouseEventJs,
  type TernEventJs,
} from "@tern/core";
import {
  Box,
  DiffView,
  Input,
  Modal,
  MODAL_Z_INDEX,
  Panels,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Table,
  Text,
  Textarea,
  closeModal,
  dragPanels,
  editKey,
  editTextareaKey,
  endPanelDrag,
  focusAt,
  focusManager,
  isStreamFollowing,
  openModal,
  render as solidRender,
  scrollTo,
  selectKey,
  setTheme,
  startPanelDrag,
  subscribeClickFocus,
  subscribeStream,
  subscribeWheelScroll,
  tableKey,
  tick,
  useFocus,
  visibleTableRows,
  wheelScroll,
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

/**
 * The Markdown source of the `MarkdownView` demo node: a heading, a
 * paragraph mixing inline styles, and a rust code fence (the fence exercises
 * the tree-sitter `highlightCode` path when the native addon is available;
 * without the addon it falls back to the single fence style).
 */
const MARKDOWN_SOURCE = [
  "# Agent output",
  "",
  "Streaming **bold** answer with `code` and [links](https://example.com).",
  "",
  "```rust",
  "fn main() {",
  "    let x = 1;",
  "}",
  "```",
].join("\n");

/** The columns of the `Table`: a left-aligned name, a left-aligned role and
 * a right-aligned score (mixed alignment exercises the per-column cell
 * padding). */
const TABLE_COLUMNS = [
  { key: "name", header: "Name", width: 12 },
  { key: "role", header: "Role", width: 10 },
  { key: "score", header: "Score", width: 6, align: "right" as const },
];

/** 10 data rows (3+ columns, 10+ rows per the roadmap): enough to scroll a
 * 5-row viewport (`clip_height`) with the highlight. */
const TABLE_ROWS = [
  ["Ada", "dev", 92],
  ["Grace", "dev", 88],
  ["Linus", "maintainer", 95],
  ["Alan", "researcher", 84],
  ["Margaret", "flight", 91],
  ["Dennis", "systems", 87],
  ["Ken", "systems", 90],
  ["Barbara", "ui", 86],
  ["Edsger", "algorithms", 89],
  ["Donald", "typesetting", 93],
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
// Modal demo (overlay + focus isolation)
// ---------------------------------------------------------------------------

/** The modal's content: an input the overlay focuses on open (registered
 * first, so `openModal`'s `focusFirst()` lands inside the overlay). */
const modalBody = Input({ value: "modal", width: 20 });
const modalInsideFocus = useFocus("modal-inside", modalBody, (event: KeyEvent) => editKey(modalBody, event));

/** The outside focusable — the previously-active focus `closeModal` restores
 * (registered after the overlay's focusable). */
const modalOutside = Box();
const modalOutsideFocus = useFocus("modal-outside", modalOutside, () => {});

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

// Table: a sticky header above a scrollable content region; the highlight
// moves with tableKey (auto-scrolling the 5-row viewport).
const table = Table({
  columns: TABLE_COLUMNS,
  rows: TABLE_ROWS,
  highlight: 2,
  clip_height: 5,
});
box.addChild(table);

// Textarea: a multi-line editor — one text leaf per line, enter splits.
const textarea = Textarea({ lines: ["line one", "line two"], row: 1, col: 8, width: 12 });
box.addChild(textarea);

// Spinner: a determinate progress bar (tick is a no-op on it).
box.addChild(Spinner({ value: 5, max: 10, width: 4 }));

// StatusBar: left/center/right segments on a 1-row strip.
box.addChild(StatusBar({ left: "L", center: "C", right: "R" }));

// MarkdownView: a markdown column — heading, styled paragraph, and a rust
// code fence (tree-sitter-highlighted when the addon is up). The core
// factory is used directly (like the other solid element factories).
const markdownNode = MarkdownView({ source: MARKDOWN_SOURCE, width: 40 });
box.addChild(markdownNode);

// Theme: setTheme swaps the module-level theme; role=primary resolves the
// custom palette fg and component=input the preset border_style.
setTheme({
  palette: { primary: { fg: "#123456" } },
  components: { input: { border_style: "double" } },
});
box.addChild(Box({ role: "primary" }));
box.addChild(Box({ component: "input" }));

// Modal: a full-bleed overlay (dimmed backdrop + centered content box) stamped
// with a high z_index. Mounted as a scene-root sibling of the app box, so its
// absolute insets resolve against the full terminal. 'm' toggles it through
// openModal/closeModal (which move focus into/out of the overlay).
const modal = Modal({ open: false, content: [modalBody] });

/** The modal's open state for the 'm' key toggle (the assertions above leave
 * it closed, matching this initial state). */
let modalOpen = false;

// Mount the scene through the solid renderer's universal `render()`.
const dispose = solidRender(() => box, renderer.root);
renderer.root.addChild(modal);
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
const [panels, scrollView, streamNode2, diff, select2, table2, textarea2, spinner, statusBar, markdownNode2, themedPrimary, themedInput] = kids;

// Register the Select and the Textarea with the shared focus manager so the
// click-to-focus wiring can resolve clicks to them.
const selectFocus = useFocus("sel", select2!, () => {});
const areaFocus = useFocus("area", textarea2!, () => {});

// Wire the mouse subscriptions: wheel scrolls the ScrollView region; a
// `down_left` on a painted cell focuses the topmost registered focusable.
const disposeWheel = subscribeWheelScroll(renderer, scrollView!);
const disposeClick = subscribeClickFocus(renderer);

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(kids.length === 12, `scene holds 12 widget nodes (got ${kids.length})`);
assert(
  kids[0]?.type === "panels" &&
    kids[1]?.type === "scroll_view" &&
    kids[2]?.type === "streaming_text" &&
    kids[3]?.type === "diff" &&
    kids[4]?.type === "select" &&
    kids[5]?.type === "table" &&
    kids[6]?.type === "textarea" &&
    kids[7]?.type === "spinner" &&
    kids[8]?.type === "status_bar" &&
    kids[9]?.type === "markdown",
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

// --- Table ---------------------------------------------------------------------
assert(table2?.type === "table", "table element materializes");
assert(table2?.props.highlight === 2, "table starts with highlight 2");
assert(
  !("columns" in (table2?.props ?? {})) && !("rows" in (table2?.props ?? {})),
  "the column/row model is JS bookkeeping, never scene props",
);
const headerRow2 = table2?.children[0];
const contentRegion2 = table2?.children[1];
assert(
  headerRow2?.type === "box" &&
    headerRow2?.props.flex_direction === "row" &&
    headerRow2?.props.z_index === 1,
  "the sticky header row is pinned above the content region (z_index 1)",
);
assert(
  headerRow2?.children.length === TABLE_COLUMNS.length &&
    headerRow2?.children.map((cell) => cell.props.text).join("|") ===
      `${"Name".padEnd(12)}|${"Role".padEnd(10)}|${"Score".padStart(6)}`,
  "the header row lays out one padded cell per column",
);
assert(
  contentRegion2?.type === "box" && contentRegion2?.props.flex_direction === "column",
  "the content region is the scrollable column of row leaves",
);
assert(
  contentRegion2?.children.length === TABLE_ROWS.length,
  `the content region holds one row leaf per data row (${contentRegion2?.children.length})`,
);
assert(
  (contentRegion2?.children[2]?.children.every((cell) => cell.props.reversed === true) ?? false),
  "the highlighted row's cells are reversed",
);
const nameCell2 = contentRegion2?.children[0]?.children[0]?.props.text;
const scoreCell2 = contentRegion2?.children[0]?.children[2]?.props.text;
assert(
  nameCell2 === "Ada".padEnd(12) && scoreCell2 === String(92).padStart(6),
  "cells align per column (left name, right score)",
);
const afterDown5 = tableKey(table2!, downKey);
assert(afterDown5.highlight === 3, "down moves the highlight to row 3");
let last2 = tableKey(table2!, downKey);
last2 = tableKey(table2!, downKey);
last2 = tableKey(table2!, downKey);
last2 = tableKey(table2!, downKey);
last2 = tableKey(table2!, downKey);
assert(last2.highlight === 8, `down x6 lands on highlight 8 (got ${last2.highlight})`);
assert(
  last2.scroll_y === 4,
  `the highlight auto-scrolls the viewport (scroll_y clamped to 4, got ${last2.scroll_y})`,
);
// tableKey rebuilds the composition, so re-read the live content region (the
// pre-move reference was replaced by the rebuild).
const liveRegion2 = table2?.children[1];
assert(
  liveRegion2?.props.scroll_y === 4,
  "the content region's scroll_y prop carries the clamped offset",
);
assert(
  visibleTableRows(table2!).map((row) => row[0]).join(",") ===
    "Margaret,Dennis,Ken,Barbara,Edsger",
  `visibleTableRows returns the 5-row window under scroll (got ${visibleTableRows(table2!).map((r) => r[0]).join(",")})`,
);

// --- Textarea ------------------------------------------------------------------
assert(textarea2?.type === "textarea", "textarea element materializes");
assert(
  textarea2?.children.length === 2 &&
    textarea2?.children[0]?.props.text === "line one" &&
    textarea2?.children[1]?.props.text === "line two",
  "textarea composes one text leaf per line",
);
assert(
  textarea2?.children[1]?.props.caret === 8,
  "the caret rides the last line's leaf at its display column",
);
// Enter splits the line at the caret and rebuilds the leaves.
const afterSplit = editTextareaKey(textarea2!, {
  name: "enter",
  ctrl: false,
  alt: false,
  shift: false,
});
assert(
  afterSplit.row === 2 && afterSplit.col === 0,
  `enter splits the line (row ${afterSplit.row}/col ${afterSplit.col})`,
);
assert(
  textarea2?.children.length === 3 && textarea2?.children[2]?.props.text === "",
  "the split tail becomes a new (empty) leaf",
);

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
// The strip is stamped `status_bar: true` — the marker the compositor reads
// to reserve the bottom viewport row for the strip (docs/components.md
// "StatusBar — Reserved row"), so no panel/scroll region overlaps it.
assert(statusBar?.props.status_bar === true, "the strip carries the reserved-row marker (status_bar: true)");

// --- MarkdownView ------------------------------------------------------------------
// The core factory renders the source column: a heading, a styled paragraph
// and a rust code fence. The fence highlights through tree-sitter when the
// native addon is available (the smoke harness runs with it); without the
// addon it falls back to the single fence style — both shapes are asserted
// structurally, mirroring the @tern/core unit tests.
assert(markdownNode2?.type === "markdown", "MarkdownView materializes in the scene");
assert(markdownNode2?.props.flex_direction === "column", "the markdown root is a flex column");
assert(!("source" in (markdownNode2?.props ?? {})), "the parsed source never reaches the scene props");
const mdHeading2 = markdownNode2?.children[0];
assert(
  mdHeading2?.type === "text" && mdHeading2.props.bold === true && mdHeading2.props.underline === true,
  "the H1 heading renders bold + underlined",
);
const mdFence2 = markdownNode2?.children.find((child) => child.props.bg === MARKDOWN_FENCE_BG);
assert(mdFence2 !== undefined, "the rust code fence composes a bg box");
assert(
  (mdFence2?.children.length ?? 0) === 3,
  `the fence holds one leaf per code line (got ${mdFence2?.children.length})`,
);
// The fence leaves reconstruct the source lines exactly (whether highlighted
// with token colors or plain): a highlighted line may be a flex row of
// per-span leaves, so the text is the leaves' joined props.
const fenceText2 = (node: Node): string =>
  typeof node.props.text === "string"
    ? node.props.text
    : node.children.map(fenceText2).join("");
const fenceLines2 = mdFence2?.children.map((line) => fenceText2(line)).join("\n") ?? "";
assert(
  fenceLines2 === "fn main() {\n    let x = 1;\n}",
  `the fence renders the code lines (got ${JSON.stringify(fenceLines2)})`,
);

// --- Theme ------------------------------------------------------------------------
assert(themedPrimary?.props.fg === "#123456", "role=primary resolves the custom palette fg");
assert(themedInput?.props.border_style === "double", "component=input resolves the preset border_style");

// --- Mouse wheel scroll -------------------------------------------------------------
// A wheel event on the Table scrolls its content region (the sticky header
// stays pinned): scroll_y was 4 (auto-scrolled by tableKey); content 10 rows
// vs the 5-row clip => max 5.
const tableRegion2b = table2?.children[1];
const regionScrollY = (): number => tableRegion2b?.props.scroll_y as number;
assert(
  wheelScroll(table2!, mouse("scroll_down", 0, 0)) === true && regionScrollY() === 5,
  `wheel scroll_down pans the table content region (scroll_y 4 -> ${regionScrollY()})`,
);
assert(
  wheelScroll(table2!, mouse("scroll_down", 0, 0)) === true && regionScrollY() === 5,
  `a wheel at the content bound clamps but stays consumed (scroll_y ${regionScrollY()})`,
);
assert(
  wheelScroll(table2!, mouse("scroll_up", 0, 0)) === true && regionScrollY() === 4,
  `wheel scroll_up pans the table content region back (scroll_y 5 -> ${regionScrollY()})`,
);
// A wheel event on the ScrollView pans its offsets (scroll_y was 1 from the
// earlier scrollTo; content 3 rows vs the 2-row viewport => max 1).
assert(
  wheelScroll(scrollView!, mouse("scroll_up", 0, 0)) === true &&
    scrollView?.props.scroll_y === 0,
  "wheel scroll_up pans the ScrollView region (scroll_y 1 -> 0)",
);
assert(
  wheelScroll(scrollView!, mouse("scroll_down", 0, 0)) === true &&
    scrollView?.props.scroll_y === 1,
  "wheel scroll_down pans the ScrollView region back (scroll_y 0 -> 1)",
);
// A non-wheel event is not consumed; a wheel on a plain (non-scrollable)
// box is not consumed either.
assert(
  wheelScroll(scrollView!, mouse("down_left", 0, 0)) === false,
  "a down_left is not a wheel event and falls through",
);
assert(
  wheelScroll(themedPrimary!, mouse("scroll_down", 0, 0)) === false,
  "a wheel on a non-scrollable box is not consumed",
);

// --- Click-to-focus -----------------------------------------------------------------
// A `down_left` on a painted cell focuses the topmost registered focusable:
// the Select (registered as "sel"). Cell (0, 0) is inside the panels region —
// a painted cell at any terminal height — so the press routes through the
// real `hit_test` gate.
assert(
  focusAt(renderer, mouse("down_left", 0, 0)) === true && focusManager.activeId === "sel",
  "clicking the Select focuses it (topmost registered focusable)",
);
focusManager.blur();
// A press off any painted cell is a no-op.
assert(
  focusAt(renderer, mouse("down_left", 9999, 9999)) === false,
  "a press off any painted cell is a no-op",
);
assert(focusManager.activeId === null, "an unmatched press leaves focus untouched");
// With the Select's registration dropped, the same click pipeline resolves to
// the Textarea (registered as "area") — clicking an Input-like focusable
// focuses it.
focusManager.unregister("sel");
assert(
  focusAt(renderer, mouse("down_left", 0, 0)) === true && focusManager.activeId === "area",
  "clicking the Textarea focuses it (topmost registered focusable)",
);
focusManager.blur();

// --- Modal (overlay + focus isolation) ----------------------------------------
assert(modal.type === "modal", "modal element materializes as a scene sibling");
assert(
  modal.props.z_index === MODAL_Z_INDEX,
  `modal paints above in-flow content (z_index = ${modal.props.z_index})`,
);
assert(modal.children.length === 2, "modal composes the backdrop + a content box");
assert(modal.children[0]?.props.position === "absolute", "the backdrop is an absolute full-bleed layer");
assert(modal.children[1]?.children[0] === modalBody, "the content box holds the modal content");
// Fresh reads per assertion: TS narrows a const-typed property access to its
// first-checked literal (openModal/closeModal mutate the node's props).
const modalOpenState = (): unknown => modal.props.open;
const modalHidden = (): unknown => modal.props.hidden;
assert(modalOpenState() === false && modalHidden() === true, "modal starts hidden (open: false)");
// Focus isolation: opening records the prior focus and moves into the overlay;
// closing restores it.
focusManager.focus("modal-outside");
openModal(modal);
assert(modalOpenState() === true && modalHidden() === false, "openModal shows the overlay");
assert(focusManager.activeId === "modal-inside", "openModal focuses the overlay's first registered focusable");
closeModal(modal);
assert(modalOpenState() === false && modalHidden() === true, "closeModal hides the overlay");
assert(focusManager.activeId === "modal-outside", "closeModal restores the previously-active focus");

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (core onKey), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
renderer.onKey((event: KeyEvent) => {
  // 'm' toggles the modal: openModal moves focus into the overlay
  // (focusFirst), closeModal restores the previously-active focus.
  if (event.name === "char" && event.char === "m") {
    if (!modalOpen) {
      openModal(modal);
      modalOpen = true;
    } else {
      closeModal(modal);
      modalOpen = false;
    }
  }
  if (event.name === "char" && event.char === "q") quit = true;
});

renderer.startEventStream();
const deadline = Date.now() + 5000;
const events = renderer.events[Symbol.asyncIterator]();
while (Date.now() < deadline && !quit) {
  if (renderer.destroyed) {
    // The 'q' handler's exit() destroyed the renderer — clean quit.
    quit = true;
    break;
  }
  // Wait for the next pushed event, bounded by the deadline so a dead
  // renderer fails the demo instead of hanging forever.
  const next = await Promise.race([
    events.next(),
    new Promise<IteratorResult<TernEventJs, undefined>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    ),
  ]);
  if (next.done) break; // stream closed (renderer destroyed) or deadline hit
  if (renderer.destroyed) {
    // Ctrl+C with exitOnCtrlC tore the renderer down after delivering the
    // event — also a clean quit.
    quit = true;
    break;
  }
}
if (renderer.destroyed) quit = true;
unsubscribe();
disposeWheel();
disposeClick();
modalOutsideFocus.dispose();
modalInsideFocus.dispose();
selectFocus.dispose();
areaFocus.dispose();
focusManager.blur();
dispose?.();
renderer.destroy();

if (!quit) {
  console.error("[kitchen-sink-solid] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[kitchen-sink-solid] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[kitchen-sink-solid] ok: kitchen-sink scene asserted and quit on 'q'");
process.exit(0);
