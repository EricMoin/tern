/**
 * kitchen-sink-solid — @tern-tui/solid kitchen-sink demo.
 *
 * The `@tern-tui/solid` counterpart of `kitchen-sink-react.ts`: the same widget
 * surface built through the solid element factories, exercising `Panels`
 * (with the core mouse drag-resize helpers), `ScrollView` (clip/scroll
 * region + track/thumb scrollbar, driven by `scrollTo`), `StreamingText`
 * auto-scroll (fed by `subscribeStream`, which pumps `syncStreamTail`),
 * `DiffView`, `Select` (driven by `selectKey`), a determinate `Spinner`, a
 * `StatusBar`, a framed `Progress` gauge (driven by `setProgress`), a
 * `Tabs` bar, the M3 surface — `Checkbox` / `Toggle` / `Radio` (driven by
 * `checkboxKey` / `toggleKey` / `radioKey`), a floating `Menu` (driven by
 * `openMenu` / `menuKey`), and a `HelpPanel` rendered from a small `Keymap`
 *  — and a custom theme via `setTheme` (`role` / `component`
 * hints resolved onto plain node props at element-creation time). The M4.5
 * surface is exercised live: a runtime `setTheme` switch AFTER creation
 * re-resolves the mounted themed nodes in place and a WCAG 2.1 contrast
 * audit (`auditTheme` / `contrastRatio`) runs against the active theme.
 *
 * Every widget is asserted against its scene node after driving it: a
 * failing assertion prints a `FAIL` line, tears the renderer down and exits
 * 1 — so the PTY smoke harness (`run-smoke.sh`) only sees exit 0 when every
 * scene assertion holds. The event loop then quits on 'q' (core `onKey`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import {
  MARKDOWN_FENCE_BG,
  MARKDOWN_LINK_FG,
  MarkdownView,
  Checkbox,
  Toggle,
  Radio,
  HelpPanel,
  Keymap,
  auditTheme,
  checkboxKey,
  contrastRatio,
  defaultTheme,
  toggleKey,
  radioKey,
  CHECKBOX_CHECKED_GLYPH,
  TOGGLE_ON_GLYPH,
  RADIO_SELECTED_GLYPH,
  createRenderer,
  SCROLLBAR_THUMB_CHAR,
  type MouseEventJs,
  type TernEventJs,
} from "@tern-tui/core";
import {
  Box,
  DiffView,
  Input,
  Menu,
  Modal,
  MODAL_Z_INDEX,
  MENU_Z_INDEX,
  Panels,
  Progress,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Table,
  Tabs,
  Text,
  Textarea,
  closeMenu,
  closeModal,
  dragPanels,
  editKey,
  editTextareaKey,
  endPanelDrag,
  focusAt,
  focusManager,
  isStreamFollowing,
  menuKey,
  openMenu,
  openModal,
  render as solidRender,
  scrollTo,
  selectKey,
  setProgress,
  setTheme,
  getTheme,
  startPanelDrag,
  subscribeClickFocus,
  subscribeStream,
  subscribeWheelScroll,
  tableKey,
  tabsKey,
  tick,
  useFocus,
  visibleTableRows,
  wheelScroll,
  type KeyEvent,
  type Node,
  type Renderer,
  type Span,
} from "@tern-tui/solid";
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
 * paragraph mixing inline styles, a rust code fence (the fence exercises
 * the tree-sitter `highlightCode` path when the native addon is available;
 * without the addon it falls back to the single fence style), a pipe table
 * (renders through the roadmap `Table` element), a task list (each item a
 * checkbox-glyph row) and a link (its span carries the OSC-8 `href` style
 * key) — the deepened M3 surface.
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
  "",
  "| Name | Role |",
  "|------|------|",
  "| Ada  | dev  |",
  "",
  "- [x] shipped task",
  "- [ ] pending task",
  "",
  "See [tern docs](https://tern.dev) for details.",
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

/**
 * The tabs of the `Tabs` demo: three tab specs whose content nodes are core
 * `Text` leaves (the `tabs` prop takes core `Node`s — the same pattern the
 * modal's `content` uses).
 */
const TABS_SPECS = [
  { label: "logs", content: [Text({ text: "log line" })] },
  { label: "files", content: [Text({ text: "file list" })] },
  { label: "git", content: [Text({ text: "git status" })] },
];

/**
 * The items of the `Menu` demo: two leaves plus a submenu branch (the
 * branch opens with `menuKey` right / enter, closes with left / escape).
 */
const MENU_ITEMS = [
  { label: "Copy", id: "copy" },
  {
    label: "Insert",
    id: "insert",
    children: [
      { label: "Code block", id: "code" },
      { label: "Table", id: "table" },
    ],
  },
  { label: "Paste", id: "paste" },
];

/**
 * A small keymap with described entries, rendered by the `HelpPanel` demo
 * node (the module-level `keymap` is consulted by every `FocusManager`, so
 * the demo's own `Keymap` keeps the panel self-contained).
 */
const demoKeymap = new Keymap();
demoKeymap.register({ name: "k", ctrl: true }, () => {}, "open command palette");
demoKeymap.register({ name: "p", ctrl: true }, () => {}, "quick switch file");
demoKeymap.register({ name: "q", ctrl: true }, () => {}); // dispatch-only: skipped

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
// Scene, built through the @tern-tui/solid factories
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

// Tabs: a tab bar row (the active tab reversed with the primary palette +
// top-border marker, closable tabs carrying a close glyph) above a content
// region holding the active tab's content. Driven below with tabsKey
// (left/right move, ctrl+tab wraps, ctrl+w closes).
const tabs = Tabs({ tabs: TABS_SPECS, active: 1, closable: true });
box.addChild(tabs);

// Progress: a framed gauge (ratatui parity) — the fill leaf counts
// ceil(5/10 * 10) = 5 of 10 inner cells, the "work" label overlays left,
// "50%" reads out right. Driven below with setProgress.
const progress = Progress({ value: 5, max: 10, width: 12, label: "work" });
box.addChild(progress);

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

// M3 components: the form primitives and the help panel are core factories
// used directly (like MarkdownView above); the Menu is the solid factory
// with the floating overlay mode. The checkbox / toggle / radio are driven
// below with their core key helpers, the menu with openMenu/closeMenu +
// menuKey.
const checkboxNode = Checkbox({ label: "Dark mode", checked: true });
box.addChild(checkboxNode);
const toggleNode = Toggle({ label: "Wrap", on: true });
box.addChild(toggleNode);
const radioNode = Radio({
  options: [
    { value: "rust", label: "Rust" },
    { value: "go", label: "Go" },
  ],
  selected: 0,
});
box.addChild(radioNode);
const menuNode = Menu({
  items: MENU_ITEMS,
  floating: true,
  z_index: MENU_Z_INDEX,
});
box.addChild(menuNode);
const helpPanelNode = HelpPanel({ keymap: demoKeymap, title: "Keybindings" });
box.addChild(helpPanelNode);

// Modal: a full-bleed overlay (dimmed backdrop + centered content box) stamped
// with a high z_index. Mounted as a scene-root sibling of the app box, so its
// absolute insets resolve against the full terminal. 'm' toggles it through
// openModal/closeModal (which move focus into/out of the overlay).
const modal = Modal({ open: false, content: [modalBody] });

// An OSC 8 hyperlink: the `hyperlink` prop on a `Text` node translates to
// the `href` style key the engine paints as an OSC 8 sequence (the same
// translation the markdown link span's affordance underlines; the prop is
// asserted against the scene node below). Mounted as a root sibling like the
// modal, so the box children count stays stable.
const osc8Node = Text({ text: "tern.dev", hyperlink: "https://tern.dev" });

/** The modal's open state for the 'm' key toggle (the assertions above leave
 * it closed, matching this initial state). */
let modalOpen = false;

// Mount the scene through the solid renderer's universal `render()`.
const dispose = solidRender(() => box, renderer.root);
renderer.root.addChild(modal);
renderer.root.addChild(osc8Node);
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
const [panels, scrollView, streamNode2, diff, select2, table2, textarea2, spinner, statusBar, tabs2, progress2, markdownNode2, themedPrimary, themedInput, checkboxNode2, toggleNode2, radioNode2, menuNode2, helpPanelNode2] = kids;

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
assert(kids.length === 19, `scene holds 19 widget nodes (got ${kids.length})`);
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
    kids[9]?.type === "tabs" &&
    kids[10]?.type === "progress" &&
    kids[11]?.type === "markdown" &&
    kids[14]?.type === "checkbox" &&
    kids[15]?.type === "toggle" &&
    kids[16]?.type === "radio" &&
    kids[17]?.type === "menu" &&
    kids[18]?.type === "box",
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
// Windowing (constitution: large datasets must not materialize one node per
// row): at scroll_y 0 the content region materializes only the visible
// window `rows[0, clip_height)` — 5 of the 10 data rows.
assert(
  contentRegion2?.children.length === Math.min(TABLE_ROWS.length, 5),
  `the content region materializes one row leaf per visible row (${contentRegion2?.children.length})`,
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

// --- Tabs ------------------------------------------------------------------------
assert(tabs2?.type === "tabs", "tabs element materializes");
assert(tabs2?.props.active === 1, "tabs starts on the active tab 1");
assert(
  !("tabs" in (tabs2?.props ?? {})) && !("closable" in (tabs2?.props ?? {})),
  "the tab spec list and closable flag are JS bookkeeping, never scene props",
);
// Composition: the tab bar row (child 0) + the content region (child 1).
const tabBar = tabs2?.children[0];
const tabRegion = tabs2?.children[1];
assert(
  tabBar?.type === "box" && tabBar?.props.flex_direction === "row" && tabBar?.children.length === 3,
  "the tab bar is a row box with one leaf per tab",
);
assert(
  tabBar?.children.map((leaf) => leaf.props.text).join(",") ===
    `logs ${"×"},▔files ${"×"},git ${"×"}`,
  "the active tab is reversed + prefixed with the top-border marker; closable tabs carry the close glyph",
);
assert(
  tabBar?.children[1]?.props.reversed === true &&
    tabBar?.children[1]?.props.fg === "#61afef" &&
    tabBar?.children[0]?.props.reversed !== true,
  "the active tab paints the primary palette reversed; inactive tabs are plain",
);
assert(
  tabRegion?.type === "box" &&
    tabRegion?.props.flex_direction === "column" &&
    tabRegion?.children.length === 1 &&
    tabRegion?.children[0]?.props.text === "file list",
  "the content region holds the active tab's content",
);
// tabsKey drives the composition in place: right moves the active tab, ctrl+w
// closes it (the tab count shrinks), and the active index re-clamps.
const tabsBase = { ctrl: false, alt: false, shift: false } as const;
const tabsAfterRight = tabsKey(tabs2!, { name: "right", ...tabsBase });
assert(tabsAfterRight.active === 2, "right moves the active tab to the last tab");
assert(
  tabs2?.children[0]?.children.map((leaf) => leaf.props.text).join(",") === `logs ${"×"},files ${"×"},▔git ${"×"}`,
  "the rebuilt bar reflects the moved active tab",
);
const tabsAfterClose = tabsKey(tabs2!, { ...tabsBase, name: "w", ctrl: true });
assert(
  tabsAfterClose.count === 2 && tabsAfterClose.active === 1,
  `ctrl+w closes the active tab (count ${tabsAfterClose.count}, active ${tabsAfterClose.active})`,
);
assert(
  tabs2?.children[0]?.children.map((leaf) => leaf.props.text).join(",") === `logs ${"×"},▔files ${"×"}`,
  "the rebuilt bar after close drops the closed tab",
);
assert(
  tabs2?.children[1]?.children[0]?.props.text === "file list",
  "the region re-reads the live composition after the close",
);

// --- Progress (framed gauge) ----------------------------------------------------
assert(progress2?.type === "progress", "progress element materializes");
// The bar model state lives on the root box's props; the label is JS
// bookkeeping, never a scene prop.
assert(progress2?.props.value === 5 && progress2?.props.max === 10, "the bar model lives on the root props");
assert(!("label" in (progress2?.props ?? {})), "the label is JS bookkeeping, never a scene prop");
// Composition: the in-flow fill leaf (child 0) + the label overlay + the
// percentage readout (inner width 10, ratio 0.5 => 5 filled cells).
assert(
  progress2?.children[0]?.props.text === "▓▓▓▓▓░░░░░",
  "the fill leaf counts ceil(5/10 * 10) = 5 of 10 inner cells",
);
assert(
  progress2?.children[1]?.props.text === "work" && progress2?.children[1]?.props.dim === true,
  "the label overlays left-aligned, dimmed",
);
assert(
  progress2?.children[1]?.props.position === "absolute" && progress2?.children[1]?.props.left === 0,
  "the label is an absolute left-aligned overlay",
);
assert(
  progress2?.children[2]?.props.text === "50%" &&
    progress2?.children[2]?.props.position === "absolute" &&
    progress2?.children[2]?.props.right === 0,
  "the percentage readout overlays the right side",
);
// setProgress repaints the live bar in place (no rebuild).
const progressBarBefore = progress2?.children[0];
setProgress(progress2!, 8);
assert(progress2?.props.value === 8 && progress2?.props.max === 10, "setProgress updates the bar model");
assert(
  progress2?.children[0] === progressBarBefore,
  "setProgress repaints the same fill leaf (no rebuild)",
);
assert(
  progress2?.children[0]?.props.text === "▓▓▓▓▓▓▓▓░░" && progress2?.children[2]?.props.text === "80%",
  "setProgress repaints the fill and the readout",
);
setProgress(progress2!, 0, 10);
assert(
  progress2?.children[0]?.props.text === "░░░░░░░░░░" && progress2?.children[2]?.props.text === "0%",
  "setProgress clamps a 0% bar empty",
);
setProgress(progress2!, 5, 10);

// --- MarkdownView ------------------------------------------------------------------
// The core factory renders the source column: a heading, a styled paragraph
// and a rust code fence. The fence highlights through tree-sitter when the
// native addon is available (the smoke harness runs with it); without the
// addon it falls back to the single fence style — both shapes are asserted
// structurally, mirroring the @tern-tui/core unit tests.
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
// The deepened M3 blocks: the pipe table materializes as a `table` element
// (the parser reuses the roadmap `Table` — sticky header + content region),
// the task-list items render as checkbox-glyph rows (`[x]` / `[ ]` replace
// the bullet), and the link line composes as a row box whose span carries
// the link affordance: underline + the link fg, plus the OSC-8 `href` style
// key the engine paints as a hyperlink sequence.
const mdTable2 = markdownNode2?.children[3];
const mdTableHeaderCells2 = mdTable2?.children[0]?.children.map((cell) => cell.props.text) ?? [];
const mdTableRow0Cells2 = mdTable2?.children[1]?.children[0]?.children.map((cell) => cell.props.text) ?? [];
assert(
  mdTable2?.type === "table" &&
    mdTableHeaderCells2.join("|") === "Name |Role " &&
    mdTableRow0Cells2.join("|") === "Ada  |dev  ",
  `the pipe table materializes as a table element (header ${JSON.stringify(mdTableHeaderCells2.join("|"))}, row ${JSON.stringify(mdTableRow0Cells2.join("|"))})`,
);
const mdTaskRows2 = markdownNode2?.children.slice(4, 6).map((child) => child.props.text) ?? [];
assert(
  mdTaskRows2.join("\n") === "[x] shipped task\n[ ] pending task",
  `the task-list items render as checkbox-glyph rows (got ${JSON.stringify(mdTaskRows2.join("\n"))})`,
);
const mdLinkRow2 = markdownNode2?.children[6];
const mdLinkSpan2 = mdLinkRow2?.children.find(
  (span) => span.props.underline === true && span.props.fg === MARKDOWN_LINK_FG,
);
assert(
  mdLinkRow2?.type === "box" &&
    mdLinkRow2.props.flex_direction === "row" &&
    mdLinkSpan2 !== undefined &&
    mdLinkSpan2.props.text === "tern docs" &&
    mdLinkSpan2.props.href === "https://tern.dev",
  "the link line composes as a row box whose span carries the OSC-8 href style key",
);

// --- Theme ------------------------------------------------------------------------
assert(themedPrimary?.props.fg === "#123456", "role=primary resolves the custom palette fg");
assert(themedInput?.props.border_style === "double", "component=input resolves the preset border_style");

// --- M4.5 live theme switch + contrast audit --------------------------------------
// The runtime theme engine: `setTheme(overrides)` AFTER creation swaps the
// module-level active theme and re-resolves every node created with hints in
// place — the factories recorded the themed nodes at creation (the same
// `resolveTheme(getTheme(), ...)` stamp), so the live switch repaints them.
const primaryBefore = themedPrimary;
const inputBefore = themedInput;
setTheme({
  palette: { primary: { fg: "#00bb00" } },
  components: { input: { border_style: "thick" } },
});
// Read through functions: TS control-flow narrowing pins a const-typed
// property access to its first-checked literal (setTheme mutates the props
// in place, so a plain property read would be typed against the old value).
const liveFg = (): unknown => themedPrimary?.props.fg;
const liveBorder = (): unknown => themedInput?.props.border_style;
assert(liveFg() === "#00bb00", "setTheme after creation re-resolves role=primary fg in place");
assert(liveBorder() === "thick", "setTheme after creation re-resolves component=input border_style in place");
assert(
  themedPrimary === primaryBefore && themedInput === inputBefore,
  "the live switch updates the same nodes in place (no rebuild)",
);
assert(getTheme().palette.primary.fg === "#00bb00", "getTheme reads the live active theme");

// The WCAG 2.1 contrast checker: pure functions over the theme's string
// colors (hex / indexed:N / default), so the audit runs anywhere the theme
// runs. Black on white is 21:1; the default muted role sits below the 4.5
// AA bar; the default One-Dark palette flags exactly two roles (muted ≈
// 2.55, border ≈ 1.58 — danger clears the bar narrowly at ≈ 4.82).
const blackOnWhite = contrastRatio("#000000", "#ffffff");
assert(
  blackOnWhite !== null && blackOnWhite >= 20,
  `black on white is 21:1 (got ${blackOnWhite})`,
);
const mutedRatio = contrastRatio(
  defaultTheme.palette.muted.fg,
  defaultTheme.palette.muted.bg,
);
assert(
  mutedRatio !== null && mutedRatio < 4.5,
  `the default muted role is below the 4.5 AA bar (got ${mutedRatio})`,
);
const audit = auditTheme(getTheme());
assert(
  audit.length === 2 &&
    audit.some((f) => f.name === "muted") &&
    audit.some((f) => f.name === "border"),
  `auditTheme flags exactly muted + border below 4.5 (got ${JSON.stringify(audit.map((f) => `${f.scope}:${f.name}`))})`,
);

// --- M3 form primitives -------------------------------------------------------------
assert(checkboxNode2?.type === "checkbox", "Checkbox materializes");
assert(checkboxNode2?.props.checked === true, "the checkbox starts checked");
assert(
  !("label" in (checkboxNode2?.props ?? {})),
  "the checkbox label is JS bookkeeping, never a scene prop",
);
assert(
  checkboxNode2?.children[0]?.props.text === `${CHECKBOX_CHECKED_GLYPH} Dark mode`,
  "the checked checkbox composes the glyph + label leaf",
);
const flipped = checkboxKey(checkboxNode2!, { name: "char", char: " ", ctrl: false, alt: false, shift: false });
assert(flipped.checked === false, "checkboxKey space unchecks the box");
assert(toggleNode2?.type === "toggle", "Toggle materializes");
assert(toggleNode2?.props.on === true, "the toggle starts on");
assert(
  toggleNode2?.children[0]?.props.text === `${TOGGLE_ON_GLYPH} Wrap`,
  "the on toggle composes the glyph + label leaf",
);
const toggled = toggleKey(toggleNode2!, { name: "enter", ctrl: false, alt: false, shift: false });
assert(toggled.on === false, "toggleKey enter turns the toggle off");
assert(radioNode2?.type === "radio", "Radio materializes");
assert(radioNode2?.props.selected === 0, "the radio starts on the first option");
assert(
  radioNode2?.children.length === 2 &&
    radioNode2?.children[0]?.props.text === `${RADIO_SELECTED_GLYPH} Rust`,
  "the radio composes one row per option, the selected row glyph-prefixed",
);
const moved = radioKey(radioNode2!, { name: "down", ctrl: false, alt: false, shift: false });
assert(moved.focused === 1, "radioKey down moves the focus to option 1");
const committed = radioKey(radioNode2!, { name: "char", char: " ", ctrl: false, alt: false, shift: false });
assert(committed.selected === 1, "radioKey space commits the focused option");

// --- Menu (floating overlay + focus isolation) -------------------------------------
assert(menuNode2?.type === "menu", "the Menu materializes");
assert(
  menuNode2?.props.z_index === MENU_Z_INDEX,
  `the floating menu paints above in-flow content (z_index = ${menuNode2?.props.z_index})`,
);
assert(
  menuNode2?.props.hidden === true && menuNode2?.props.display === "none",
  "a closed menu is hidden",
);
openMenu(menuNode2!);
assert(
  menuNode2?.props.hidden === false && menuNode2?.props.display === "flex",
  "openMenu shows the menu",
);
assert(menuNode2?.children.length === 3, "the open menu composes one row per root item");
assert(
  menuNode2?.children[0]?.props.reversed === true,
  "the highlighted item's row renders reversed",
);
const menuDown = menuKey(menuNode2!, { name: "down", ctrl: false, alt: false, shift: false });
assert(menuDown.highlighted === 1, "menuKey down moves the highlight to the submenu branch");
const menuRight = menuKey(menuNode2!, { name: "right", ctrl: false, alt: false, shift: false });
assert(
  menuRight.open_submenus.includes("insert") && menuRight.count === 5,
  "menuKey right opens the branch: 3 root rows + 2 indented submenu rows",
);
closeMenu(menuNode2!);
assert(menuNode2?.props.hidden === true, "closeMenu hides the menu");

// --- HelpPanel (rendered from the demo keymap) --------------------------------------
assert(helpPanelNode2?.type === "box", "HelpPanel materializes as a plain box");
assert(
  helpPanelNode2?.children[0]?.props.text === "Keybindings",
  "the help panel renders the title row first",
);
const helpRows2 = helpPanelNode2?.children.slice(1) ?? [];
assert(
  helpRows2.length === 2 &&
    helpRows2[0]?.children[0]?.props.text === "ctrl+k" &&
    helpRows2[0]?.children[1]?.props.text === "open command palette" &&
    helpRows2[1]?.children[1]?.props.dim === true,
  "the help panel lists the described combos, dispatch-only entries skipped",
);

// --- OSC 8 hyperlink (root sibling) ---------------------------------------------------
// The `hyperlink` prop translates to the `href` style key on the scene node
// (the engine paints the run as an OSC 8 hyperlink sequence) — the same
// alias the markdown link affordance mirrors. Assert the translation and
// that the camelCase alias never leaks into the scene props.
const osc8Node2 = renderer.root.children[2];
assert(osc8Node2?.type === "text", "the OSC 8 hyperlink node materializes as a root sibling");
assert(
  osc8Node2?.props.text === "tern.dev" && osc8Node2?.props.href === "https://tern.dev",
  "the hyperlink prop translates to the href style key on the scene node",
);
assert(
  !("hyperlink" in (osc8Node2?.props ?? {})),
  "the camelCase hyperlink alias never reaches the scene props",
);

// --- Mouse wheel scroll -------------------------------------------------------------
// A wheel event on the Table scrolls its content region (the sticky header
// stays pinned): scroll_y was 4 (auto-scrolled by tableKey); content 10 rows
// vs the 5-row clip => max 5.
// Windowing rebuilds the region node on every scroll, so the captured
// reference would go stale — read the live region from the table each time
// (the same pattern the tableKey section uses).
const regionScrollY = (): number => table2?.children[1]?.props.scroll_y as number;
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
  // M3: 'c' / 't' / 'r' drive the checkbox, toggle and radio through their
  // core key functions (the same functions the assertion section calls
  // directly) — the interactive wiring of the scene nodes.
  if (event.name === "char" && event.char === "c") {
    checkboxKey(checkboxNode, { name: "char", char: " ", ctrl: false, alt: false, shift: false });
  }
  if (event.name === "char" && event.char === "t") {
    toggleKey(toggleNode, { name: "enter", ctrl: false, alt: false, shift: false });
  }
  if (event.name === "char" && event.char === "r") {
    radioKey(radioNode, { name: "down", ctrl: false, alt: false, shift: false });
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
