/**
 * kitchen-sink-react — @tern/react kitchen-sink demo.
 *
 * Exercises the post-MVP widget surface in one scene, through the
 * `@tern/react` host components: `Panels` (with the mouse drag-resize
 * helpers `startPanelDrag` / `dragPanels` / `endPanelDrag`), `ScrollView`
 * (clip/scroll region + track/thumb scrollbar, driven by `scrollTo`),
 * `StreamingText` auto-scroll (`syncStreamTail` pinning `scroll_y` to the
 * stream tail), `DiffView`, `Select` (driven by `selectKey`), a determinate
 * `Spinner`, a `StatusBar`, and a custom theme via `ThemeProvider`
 * (`role` / `component` hints resolved onto plain node props).
 *
 * Every widget is asserted against its scene node after driving it (the
 * same assertion style as the @tern/core unit tests): a failing assertion
 * prints a `FAIL` line, tears the renderer down and exits 1 — so the PTY
 * smoke harness (`run-smoke.sh`) only sees exit 0 when every scene
 * assertion holds. The event loop then quits on 'q' (via `useInput` ->
 * `useApp().exit()`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import { Fragment, createElement, useRef, type ReactElement } from "react";
import {
  Box as CoreBox,
  Input as CoreInput,
  MODAL_Z_INDEX,
  createRenderer,
  useFocus as coreUseFocus,
  SCROLLBAR_THUMB_CHAR,
  type MouseEventJs,
} from "@tern/core";
import {
  Box,
  DiffView,
  Modal,
  Panels,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Table,
  Text,
  Textarea,
  ThemeProvider,
  closeModal,
  dragPanels,
  editKey,
  editTextareaKey,
  endPanelDrag,
  focusAt,
  focusManager,
  isStreamFollowing,
  openModal,
  render,
  scrollTo,
  selectKey,
  startPanelDrag,
  tableKey,
  tick,
  useApp,
  useClickToFocus,
  useInput,
  useWheelScroll,
  visibleTableRows,
  wheelScroll,
  type KeyEvent,
  type Node,
  type Renderer,
  type Span,
} from "@tern/react";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Streaming source (auto-scroll demo)
// ---------------------------------------------------------------------------

/** The newline-terminated lines streamed into the `<StreamingText>` node. */
const STREAM_LINES = ["stream line 1\n", "stream line 2\n", "stream line 3\n"];

/**
 * The accumulated text of the stream, recorded as the `<StreamingText>`
 * component consumes each span (a span is recorded right after the pump's
 * `yield` resolves, before it appends — so `streamed.length` tracks the
 * appended count). The scene-side stream is not readable back through the
 * binding, so this record is the demo's assertion source.
 */
const streamed: string[] = [];

/** The demo's stream: yields each line after a short timer delay. */
async function* stream(): AsyncIterable<Span> {
  for (const line of STREAM_LINES) {
    yield { text: line };
    streamed.push(line);
  }
}

/** A single iterable the `<StreamingText>` effect consumes on mount. */
const streamIterable = stream();

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

/** The options of the `<Select>` dropdown. */
const SELECT_OPTIONS = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

/** The columns of the `<Table>`: a left-aligned name, a left-aligned role
 * and a right-aligned score (mixed alignment exercises the per-column cell
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
// Modal demo (overlay + focus isolation)
// ---------------------------------------------------------------------------

/** The modal's content: an input the overlay focuses on open (registered
 * first, so `openModal`'s `focusFirst()` lands inside the overlay). */
const modalBody = CoreInput({ value: "modal", width: 20 });
coreUseFocus("modal-inside", modalBody, (event: KeyEvent) => editKey(modalBody, event));

/** The outside focusable — the previously-active focus `closeModal` restores
 * (registered after the overlay's focusable). */
const modalOutside = CoreBox();
coreUseFocus("modal-outside", modalOutside, () => {});

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * The kitchen-sink scene: a column box holding the eight widgets, in a fixed
 * order the demo asserts against (panels, scroll view, streaming text, diff,
 * select, spinner, status bar, themed boxes). The `Panels` element is first
 * so its top sits at the scene origin — the drag helpers interpret mouse
 * row/column as offsets from the panels element's top-left.
 */
function App(): ReactElement {
  const { exit, renderer } = useApp();
  // The modal node (set when the `<Modal>` host mounts) and its open state.
  // 'm' toggles it imperatively through openModal/closeModal — no React state,
  // so no re-render replaces the modal's visible props.
  const modalRef = useRef<Node | null>(null);
  const modalOpen = useRef(false);
  useInput((event: KeyEvent) => {
    if (event.name === "char" && event.char === "q") exit();
    // 'm' opens/closes the modal: openModal moves focus into the overlay
    // (focusFirst), closeModal restores the previously-active focus.
    if (event.name === "char" && event.char === "m") {
      const modal = modalRef.current;
      if (modal === null) return;
      if (!modalOpen.current) {
        openModal(modal);
        modalOpen.current = true;
      } else {
        closeModal(modal);
        modalOpen.current = false;
      }
    }
  });
  // Mouse wiring: wheel scrolls the `<ScrollView>` region; a `down_left` on
  // a painted cell focuses the topmost registered focusable (the Select and
  // the Textarea below carry `focusId`s).
  const scrollViewRef = useRef<Node | null>(null);
  useWheelScroll(scrollViewRef);
  useClickToFocus(renderer);
  return createElement(
    ThemeProvider,
    {
      theme: {
        palette: { primary: { fg: "#123456" } },
        components: { input: { border_style: "double" } },
      },
    },
    createElement(
      Fragment,
      null,
      createElement(
        Box,
        { flex_direction: "column" },
        // Panels: a 2-panel column stack; the drag-resize helpers resize the
        // pane above the 1-cell gutter (roadmap Phase 2).
        createElement(Panels, {
          panels: [
            { header: "A", body: CoreBox({ height: 3 }) },
            { header: "B", body: CoreBox({ height: 2 }) },
          ],
          direction: "column",
          height: 8,
        }),
        // ScrollView: a 5x2 clip region with a track + thumb scrollbar; the
        // `useWheelScroll` hook drives its offsets from mouse wheel events.
        createElement(
          ScrollView,
          { ref: scrollViewRef, width: 5, height: 2, showScrollbar: true },
          createElement(Text, { text: "aaaa\nbbbbb\ncc" }),
        ),
        // StreamingText: auto-scroll keeps scroll_y pinned to the stream tail.
        createElement(StreamingText, { stream: streamIterable, clip_height: 2 }),
        // DiffView: per-kind rows (green adds, red dels, dim context).
        createElement(DiffView, { hunks: DIFF_HUNKS }),
        // Select: typeahead filter + highlight, confirmed via enter. The
        // `focusId` registers it as a click-to-focus target.
        createElement(Select, { options: SELECT_OPTIONS, focusId: "sel" }),
        // Table: a sticky header above a scrollable content region; the
        // highlight moves with tableKey (auto-scrolling the 5-row viewport).
        createElement(Table, {
          columns: TABLE_COLUMNS,
          rows: TABLE_ROWS,
          highlight: 2,
          clip_height: 5,
        }),
        // Textarea: a multi-line editor — one text leaf per line, enter splits.
        // The `focusId` registers it as a click-to-focus target.
        createElement(Textarea, {
          lines: ["line one", "line two"],
          row: 1,
          col: 8,
          width: 12,
          focusId: "area",
        }),
        // Spinner: a determinate progress bar (tick is a no-op on it).
        createElement(Spinner, { value: 5, max: 10, width: 4 }),
        // StatusBar: left/center/right segments on a 1-row strip.
        createElement(StatusBar, { left: "L", center: "C", right: "R" }),
        // Theme: role=primary resolves the custom palette fg; component=input
        // resolves the preset border_style.
        createElement(Box, { role: "primary" }),
        createElement(Box, { component: "input" }),
      ),
      // The Modal: a full-bleed overlay sibling of the app box, so its
      // absolute insets resolve against the scene root (the full terminal).
      // 'm' toggles it; the focusable input lives in the content box.
      createElement(Modal, { ref: modalRef, open: false, content: [modalBody] }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[kitchen-sink-react] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[kitchen-sink-react] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[kitchen-sink-react]", message);
  process.exit(1);
}

render(createElement(App), renderer);

// React schedules passive effects (useInput's key subscription, and the
// StreamingText stream pump) on the scheduler rather than flushing them
// synchronously, so give them a beat to register before the event loop
// starts — otherwise a 'q' that arrives before the subscription is active
// would be dropped.
await new Promise((resolve) => setTimeout(resolve, 100));

// Wait for the streaming pump to consume and append all STREAM_LINES spans.
const streamDeadline = Date.now() + 2000;
while (streamed.length < STREAM_LINES.length && Date.now() < streamDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Scene assertions (a failure prints FAIL and exits 1)
// ---------------------------------------------------------------------------

/** Assert a scene property; on failure tear down and exit 1. */
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[kitchen-sink-react] ok: ${label}`);
    return;
  }
  console.error(`[kitchen-sink-react] FAIL: ${label}`);
  renderer.destroy();
  process.exit(1);
}

/** Build a mouse event payload. */
function mouse(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

const rootBox: Node | undefined = renderer.root.children[0];
const kids: readonly Node[] = rootBox?.children ?? [];
const [panels, scrollView, streamNode, diff, select, table, textarea, spinner, statusBar, themedPrimary, themedInput] = kids;

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(kids.length === 11, `scene holds 11 widget nodes (got ${kids.length})`);
assert(
  kids[0]?.type === "panels" &&
    kids[1]?.type === "scroll_view" &&
    kids[2]?.type === "streaming_text" &&
    kids[3]?.type === "diff" &&
    kids[4]?.type === "select" &&
    kids[5]?.type === "table" &&
    kids[6]?.type === "textarea" &&
    kids[7]?.type === "spinner" &&
    kids[8]?.type === "status_bar",
  "widget host types materialize in scene order",
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
  typeof scrollbarLeaf!.props.text === "string" &&
    scrollbarLeaf!.props.text.includes(SCROLLBAR_THUMB_CHAR),
  "scrollbar leaf paints a thumb",
);
assert((scrollbarLeaf!.props.height as number | undefined ?? 0) >= 1, "scrollbar leaf is sized to the viewport");

// --- StreamingText auto-scroll ------------------------------------------------
assert(streamNode?.type === "streaming_text", "streaming node materializes");
assert(streamed.length === STREAM_LINES.length, `stream consumed all ${STREAM_LINES.length} spans`);
assert(isStreamFollowing(streamNode!), "auto-scroll follows the stream tail");
const streamContentHeight = streamNode?.contentSize().height ?? 0;
assert(
  streamNode?.props.scroll_y === Math.max(0, streamContentHeight - 2),
  `scroll_y is pinned to the tail (content ${streamContentHeight} - clip 2 = ${Math.max(0, streamContentHeight - 2)})`,
);

// --- DiffView -----------------------------------------------------------------
assert(diff?.children.length === DIFF_HUNKS.length, `diff renders ${DIFF_HUNKS.length} rows`);
assert(diff?.children[0]?.children[0]?.props.text === "1 1", "gutter right-aligns the old/new line numbers");
assert(diff?.children[1]?.children[1]?.props.text === "-", "deleted rows carry a '-' marker");
assert(diff?.children[2]?.children[1]?.props.fg === "#98c379", "added rows are painted green");
assert(diff?.children[3]?.children[2]?.props.dim === true, "context rows are dimmed");

// --- Select --------------------------------------------------------------------
assert(select?.children.length === 4, "select composes a filter row + 3 option rows");
const downKey: KeyEvent = { name: "down", ctrl: false, alt: false, shift: false };
const afterDown = selectKey(select!, downKey);
assert(afterDown.highlighted === 1, "down moves the highlight to option 1");
const enterKey: KeyEvent = { name: "enter", ctrl: false, alt: false, shift: false };
const afterEnter = selectKey(select!, enterKey);
assert(
  afterEnter.value === "banana" && afterEnter.open === false,
  `enter confirms the highlighted option ("banana", dropdown dismissed)`,
);
assert(select?.props.value === "banana", "the select node's value prop carries the confirmation");
const typeaheadKey: KeyEvent = { name: "char", char: "b", ctrl: false, alt: false, shift: false };
const afterTypeahead = selectKey(select!, typeaheadKey);
assert(afterTypeahead.filter === "b", "typeahead appends to the filter query");

// --- Table ---------------------------------------------------------------------
assert(table?.type === "table", "table element materializes");
assert(table?.props.highlight === 2, "table starts with highlight 2");
assert(
  !("columns" in (table?.props ?? {})) && !("rows" in (table?.props ?? {})),
  "the column/row model is JS bookkeeping, never scene props",
);
const headerRow = table?.children[0];
const contentRegion = table?.children[1];
assert(
  headerRow?.type === "box" &&
    headerRow?.props.flex_direction === "row" &&
    headerRow?.props.z_index === 1,
  "the sticky header row is pinned above the content region (z_index 1)",
);
assert(
  headerRow?.children.length === TABLE_COLUMNS.length &&
    headerRow?.children.map((cell) => cell.props.text).join("|") ===
      `${"Name".padEnd(12)}|${"Role".padEnd(10)}|${"Score".padStart(6)}`,
  "the header row lays out one padded cell per column",
);
assert(
  contentRegion?.type === "box" && contentRegion?.props.flex_direction === "column",
  "the content region is the scrollable column of row leaves",
);
assert(
  contentRegion?.children.length === TABLE_ROWS.length,
  `the content region holds one row leaf per data row (${contentRegion?.children.length})`,
);
assert(
  (contentRegion?.children[2]?.children.every((cell) => cell.props.reversed === true) ?? false),
  "the highlighted row's cells are reversed",
);
// Per-column alignment: name left-padded, score right-padded.
const nameCell = contentRegion?.children[0]?.children[0]?.props.text;
const scoreCell = contentRegion?.children[0]?.children[2]?.props.text;
assert(
  nameCell === "Ada".padEnd(12) && scoreCell === String(92).padStart(6),
  "cells align per column (left name, right score)",
);
// Row highlight moves + scroll clamping: with a 5-row viewport and 10 rows,
// moving the highlight from 2 down to 8 auto-scrolls scroll_y to 4.
const afterDown5 = tableKey(table!, downKey);
assert(afterDown5.highlight === 3, "down moves the highlight to row 3");
let last = tableKey(table!, downKey);
last = tableKey(table!, downKey);
last = tableKey(table!, downKey);
last = tableKey(table!, downKey);
last = tableKey(table!, downKey);
assert(last.highlight === 8, `down x6 lands on highlight 8 (got ${last.highlight})`);
assert(
  last.scroll_y === 4,
  `the highlight auto-scrolls the viewport (scroll_y clamped to 4, got ${last.scroll_y})`,
);
assert(
  table?.props.highlight === 8,
  "the table node's highlight prop carries the moved highlight",
);
// tableKey rebuilds the composition, so re-read the live content region (the
// pre-move reference was replaced by the rebuild).
const liveRegion = table?.children[1];
assert(
  liveRegion?.props.scroll_y === 4,
  "the content region's scroll_y prop carries the clamped offset",
);
assert(
  visibleTableRows(table!).map((row) => row[0]).join(",") ===
    "Margaret,Dennis,Ken,Barbara,Edsger",
  `visibleTableRows returns the 5-row window under scroll (got ${visibleTableRows(table!).map((r) => r[0]).join(",")})`,
);

// --- Textarea ------------------------------------------------------------------
assert(textarea?.type === "textarea", "textarea element materializes");
assert(
  textarea?.children.length === 2 &&
    textarea?.children[0]?.props.text === "line one" &&
    textarea?.children[1]?.props.text === "line two",
  "textarea composes one text leaf per line",
);
assert(
  textarea?.children[1]?.props.caret === 8,
  "the caret rides the last line's leaf at its display column",
);
// Enter splits the line at the caret and rebuilds the leaves.
const afterSplit = editTextareaKey(textarea!, {
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
  textarea?.children.length === 3 && textarea?.children[2]?.props.text === "",
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

// --- Theme ------------------------------------------------------------------------
assert(themedPrimary?.props.fg === "#123456", "role=primary resolves the custom palette fg");
assert(themedInput?.props.border_style === "double", "component=input resolves the preset border_style");

// --- Modal (overlay + focus isolation) ---------------------------------------------
const modalNode = renderer.root.children[1];
// Fresh reads per assertion: TS narrows a const-typed property access to its
// first-checked literal (openModal/closeModal mutate the node's props).
const modalOpenState = (): unknown => modalNode?.props.open;
const modalHidden = (): unknown => modalNode?.props.hidden;
assert(modalNode?.type === "modal", "modal host materializes as a scene sibling");
assert(
  modalNode?.props.z_index === MODAL_Z_INDEX,
  `modal paints above in-flow content (z_index = ${modalNode?.props.z_index})`,
);
assert(modalNode?.children.length === 2, "modal composes the backdrop + a content box");
assert(modalNode?.children[0]?.props.position === "absolute", "the backdrop is an absolute full-bleed layer");
assert(modalNode?.children[1]?.children[0] === modalBody, "the content box holds the modal content");
assert(modalOpenState() === false && modalHidden() === true, "modal starts hidden (open: false)");
// Focus isolation: opening records the prior focus and moves into the overlay;
// closing restores it.
focusManager.focus("modal-outside");
openModal(modalNode!);
assert(modalOpenState() === true && modalHidden() === false, "openModal shows the overlay");
assert(focusManager.activeId === "modal-inside", "openModal focuses the overlay's first registered focusable");
closeModal(modalNode!);
assert(modalOpenState() === false && modalHidden() === true, "closeModal hides the overlay");
assert(focusManager.activeId === "modal-outside", "closeModal restores the previously-active focus");

// --- Mouse wheel scroll -------------------------------------------------------------
// A wheel event on the Table scrolls its content region (the sticky header
// stays pinned): scroll_y was 4 (auto-scrolled by tableKey); content 10 rows
// vs the 5-row clip => max 5.
const tableRegion = table?.children[1];
const regionScrollY = (): number => tableRegion?.props.scroll_y as number;
assert(
  wheelScroll(table!, mouse("scroll_down", 0, 0)) === true && regionScrollY() === 5,
  `wheel scroll_down pans the table content region (scroll_y 4 -> ${regionScrollY()})`,
);
assert(
  wheelScroll(table!, mouse("scroll_down", 0, 0)) === true && regionScrollY() === 5,
  `a wheel at the content bound clamps but stays consumed (scroll_y ${regionScrollY()})`,
);
assert(
  wheelScroll(table!, mouse("scroll_up", 0, 0)) === true && regionScrollY() === 4,
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
// the Select (focusId "sel"). Cell (0, 0) is inside the panels region — a
// painted cell at any terminal height — so the press routes through the real
// `hit_test` gate.
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
// the Textarea (focusId "area") — clicking an Input-like focusable focuses it.
focusManager.unregister("sel");
assert(
  focusAt(renderer, mouse("down_left", 0, 0)) === true && focusManager.activeId === "area",
  "clicking the Textarea focuses it (topmost registered focusable)",
);
focusManager.blur();
focusManager.unregister("area");

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (via useInput → exit()), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !quit) {
  if (renderer.destroyed) {
    // The 'q' handler's exit() destroyed the renderer — clean quit.
    quit = true;
    break;
  }
  try {
    renderer.pollEvents(50);
  } catch {
    // The renderer was destroyed inside pollEvents (ctrl+c with
    // exitOnCtrlC) — also a clean quit.
    quit = true;
    break;
  }
}
renderer.destroy();

if (!quit) {
  console.error("[kitchen-sink-react] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[kitchen-sink-react] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[kitchen-sink-react] ok: kitchen-sink scene asserted and quit on 'q'");
process.exit(0);
