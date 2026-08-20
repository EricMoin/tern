/**
 * kitchen-sink-react — @tern-tui/react kitchen-sink demo.
 *
 * Exercises the post-MVP widget surface in one scene, through the
 * `@tern-tui/react` host components: `Panels` (with the mouse drag-resize
 * helpers `startPanelDrag` / `dragPanels` / `endPanelDrag`), `ScrollView`
 * (clip/scroll region + track/thumb scrollbar, driven by `scrollTo`),
 * `StreamingText` auto-scroll (`syncStreamTail` pinning `scroll_y` to the
 * stream tail), `DiffView`, `Select` (driven by `selectKey`), a determinate
 * `Spinner`, a framed `Progress` gauge (driven by `setProgress`), a
 * `StatusBar`, a `Tabs` bar, the M3 surface — `Checkbox` / `Toggle` / `Radio`
 * (driven by `checkboxKey` / `toggleKey` / `radioKey`), a floating `Menu`
 * (driven by `openMenu` / `menuKey`), and a `HelpPanel` rendered from a
 * small `Keymap` — and a custom theme via `ThemeProvider`
 * (`role` / `component` hints resolved onto plain node props).
 *
 * Every widget is asserted against its scene node after driving it (the
 * same assertion style as the @tern-tui/core unit tests): a failing assertion
 * prints a `FAIL` line, tears the renderer down and exits 1 — so the PTY
 * smoke harness (`run-smoke.sh`) only sees exit 0 when every scene
 * assertion holds. The event loop then quits on 'q' (via `useInput` ->
 * `useApp().exit()`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import { Fragment, createElement, useRef, type ReactElement } from "react";
import {
  Box as CoreBox,
  Text as CoreText,
  Input as CoreInput,
  MARKDOWN_FENCE_BG,
  MARKDOWN_LINK_FG,
  MODAL_Z_INDEX,
  MarkdownView,
  Checkbox,
  Toggle,
  Radio,
  HelpPanel,
  Keymap,
  checkboxKey,
  toggleKey,
  radioKey,
  CHECKBOX_CHECKED_GLYPH,
  TOGGLE_ON_GLYPH,
  RADIO_SELECTED_GLYPH,
  createRenderer,
  useFocus as coreUseFocus,
  SCROLLBAR_THUMB_CHAR,
  type MouseEventJs,
  type TernEventJs,
} from "@tern-tui/core";
import {
  Box,
  DiffView,
  Menu,
  Modal,
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
  ThemeProvider,
  MENU_Z_INDEX,
  closeModal,
  dragPanels,
  editKey,
  editTextareaKey,
  endPanelDrag,
  focusAt,
  focusManager,
  isStreamFollowing,
  closeMenu,
  menuKey,
  openMenu,
  openModal,
  render,
  scrollTo,
  selectKey,
  startPanelDrag,
  tableKey,
  tabsKey,
  tick,
  setProgress,
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
} from "@tern-tui/react";
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

/**
 * The Markdown source of the `<MarkdownView>` demo node: a heading, a
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

/**
 * The tabs of the `<Tabs>` demo: three tab specs whose content nodes are core
 * `Text` leaves (the `tabs` prop of the host component takes core `Node`s —
 * the same pattern the modal's `content` uses).
 */
const TABS_SPECS = [
  { label: "logs", content: [CoreText({ text: "log line" })] },
  { label: "files", content: [CoreText({ text: "file list" })] },
  { label: "git", content: [CoreText({ text: "git status" })] },
];

/**
 * The items of the `<Menu>` demo: two leaves plus a submenu branch (the
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
    // M3: 'c' / 't' / 'r' drive the checkbox, toggle and radio through their
    // core key functions (the same functions the assertion section calls
    // directly) — the interactive wiring of the scene-root siblings.
    if (event.name === "char" && event.char === "c") {
      checkboxKey(checkboxNode, { name: "char", char: " ", ctrl: false, alt: false, shift: false });
    }
    if (event.name === "char" && event.char === "t") {
      toggleKey(toggleNode, { name: "enter", ctrl: false, alt: false, shift: false });
    }
    if (event.name === "char" && event.char === "r") {
      radioKey(radioNode, { name: "down", ctrl: false, alt: false, shift: false });
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
        // Tabs: a tab bar row (the active tab reversed with the primary
        // palette + top-border marker, closable tabs carrying a close glyph)
        // above a content region holding the active tab's content. Driven
        // below with tabsKey (left/right move, ctrl+tab wraps, ctrl+w closes).
        createElement(Tabs, { tabs: TABS_SPECS, active: 1, closable: true, focusId: "tabs" }),
        // Progress: a framed gauge (ratatui parity) — the fill leaf counts
        // ceil(5/10 * 10) = 5 of 10 inner cells, the "work" label overlays
        // left, "50%" reads out right. Driven below with setProgress.
        createElement(Progress, { value: 5, max: 10, width: 12, label: "work" }),
        // Theme: role=primary resolves the custom palette fg; component=input
        // resolves the preset border_style.
        createElement(Box, { role: "primary" }),
        createElement(Box, { component: "input" }),
        // Menu: a floating overlay menu (z-order above in-flow content) with
        // a submenu branch; a closed menu is hidden. Driven below with the
        // core openMenu/closeMenu + menuKey (the host's focus/mouse wiring
        // is inert without a focusId).
        createElement(Menu, {
          items: MENU_ITEMS,
          floating: true,
          z_index: MENU_Z_INDEX,
        }),
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

// The core `MarkdownView` factory is not a React host element (the reconciler
// only knows the roadmap host tags), so the demo mounts it imperatively as a
// scene-root sibling — the same pattern the solid kitchen-sink uses for its
// modal. It renders the MARKDOWN_SOURCE column (heading, styled paragraph,
// rust code fence) and is asserted below.
const markdownNode = MarkdownView({ source: MARKDOWN_SOURCE, width: 40 });
renderer.root.addChild(markdownNode);

// The M3 form primitives and the help panel are core factories (no React
// host tags — the same pattern as the MarkdownView above), so the demo
// mounts them imperatively as scene-root siblings: a checked Checkbox, an
// on Toggle, a Radio with the first option selected, and a HelpPanel
// rendered from the demo keymap. All are asserted below, and the checkbox /
// toggle / radio are driven with their core key helpers.
const checkboxNode = Checkbox({ label: "Dark mode", checked: true });
renderer.root.addChild(checkboxNode);
const toggleNode = Toggle({ label: "Wrap", on: true });
renderer.root.addChild(toggleNode);
const radioNode = Radio({
  options: [
    { value: "rust", label: "Rust" },
    { value: "go", label: "Go" },
  ],
  selected: 0,
});
renderer.root.addChild(radioNode);
const helpPanelNode = HelpPanel({ keymap: demoKeymap, title: "Keybindings" });
renderer.root.addChild(helpPanelNode);
// An OSC 8 hyperlink: the `hyperlink` prop on a `Text` node translates to
// the `href` style key the engine paints as an OSC 8 sequence (the same
// translation the markdown link span's affordance underlines; the prop is
// asserted against the scene node below).
const osc8Node = CoreText({ text: "tern.dev", hyperlink: "https://tern.dev" });
renderer.root.addChild(osc8Node);

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
const [panels, scrollView, streamNode, diff, select, table, textarea, spinner, statusBar, tabs, progress, themedPrimary, themedInput, menu] = kids;

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(kids.length === 14, `scene holds 14 widget nodes (got ${kids.length})`);
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
    kids[13]?.type === "menu",
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
// Windowing (constitution: large datasets must not materialize one node per
// row): at scroll_y 0 the content region materializes only the visible
// window `rows[0, clip_height)` — 5 of the 10 data rows.
assert(
  contentRegion?.children.length === Math.min(TABLE_ROWS.length, 5),
  `the content region materializes one row leaf per visible row (${contentRegion?.children.length})`,
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
// The strip is stamped `status_bar: true` — the marker the compositor reads
// to reserve the bottom viewport row for the strip (docs/components.md
// "StatusBar — Reserved row"), so no panel/scroll region overlaps it.
assert(statusBar?.props.status_bar === true, "the strip carries the reserved-row marker (status_bar: true)");

// --- Tabs ------------------------------------------------------------------------
assert(tabs?.type === "tabs", "tabs element materializes");
assert(tabs?.props.active === 1, "tabs starts on the active tab 1");
assert(
  !("tabs" in (tabs?.props ?? {})) && !("closable" in (tabs?.props ?? {})),
  "the tab spec list and closable flag are JS bookkeeping, never scene props",
);
// Composition: the tab bar row (child 0) + the content region (child 1).
const tabBar = tabs?.children[0];
const tabRegion = tabs?.children[1];
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
const tabsAfterRight = tabsKey(tabs!, { name: "right", ...tabsBase });
assert(tabsAfterRight.active === 2, "right moves the active tab to the last tab");
assert(
  tabs?.children[0]?.children.map((leaf) => leaf.props.text).join(",") === `logs ${"×"},files ${"×"},▔git ${"×"}`,
  "the rebuilt bar reflects the moved active tab",
);
const tabsAfterClose = tabsKey(tabs!, { ...tabsBase, name: "w", ctrl: true });
assert(
  tabsAfterClose.count === 2 && tabsAfterClose.active === 1,
  `ctrl+w closes the active tab (count ${tabsAfterClose.count}, active ${tabsAfterClose.active})`,
);
assert(
  tabs?.children[0]?.children.map((leaf) => leaf.props.text).join(",") === `logs ${"×"},▔files ${"×"}`,
  "the rebuilt bar after close drops the closed tab",
);
assert(
  tabs?.children[1]?.children[0]?.props.text === "file list",
  "the region re-reads the live composition after the close",
);

// --- Progress (framed gauge) --------------------------------------------------
assert(progress?.type === "progress", "progress element materializes");
// The bar model state lives on the root box's props; the label is JS
// bookkeeping, never a scene prop.
assert(progress?.props.value === 5 && progress?.props.max === 10, "the bar model lives on the root props");
assert(!("label" in (progress?.props ?? {})), "the label is JS bookkeeping, never a scene prop");
// Composition: the in-flow fill leaf (child 0) + the label overlay + the
// percentage readout (inner width 10, ratio 0.5 => 5 filled cells).
assert(
  progress?.children[0]?.props.text === "▓▓▓▓▓░░░░░",
  "the fill leaf counts ceil(5/10 * 10) = 5 of 10 inner cells",
);
assert(
  progress?.children[1]?.props.text === "work" && progress?.children[1]?.props.dim === true,
  "the label overlays left-aligned, dimmed",
);
assert(
  progress?.children[1]?.props.position === "absolute" && progress?.children[1]?.props.left === 0,
  "the label is an absolute left-aligned overlay",
);
assert(
  progress?.children[2]?.props.text === "50%" &&
    progress?.children[2]?.props.position === "absolute" &&
    progress?.children[2]?.props.right === 0,
  "the percentage readout overlays the right side",
);
// setProgress repaints the live bar in place (no rebuild).
const progressBarBefore = progress?.children[0];
setProgress(progress!, 8);
assert(progress?.props.value === 8 && progress?.props.max === 10, "setProgress updates the bar model");
assert(
  progress?.children[0] === progressBarBefore,
  "setProgress repaints the same fill leaf (no rebuild)",
);
assert(
  progress?.children[0]?.props.text === "▓▓▓▓▓▓▓▓░░" && progress?.children[2]?.props.text === "80%",
  "setProgress repaints the fill and the readout",
);
setProgress(progress!, 0, 10);
assert(
  progress?.children[0]?.props.text === "░░░░░░░░░░" && progress?.children[2]?.props.text === "0%",
  "setProgress clamps a 0% bar empty",
);
setProgress(progress!, 5, 10);

// --- MarkdownView (mounted as a scene-root sibling) ---------------------------------
// The core factory renders the source column: a heading, a styled paragraph
// and a rust code fence. The fence highlights through tree-sitter when the
// native addon is available (the smoke harness runs with it); without the
// addon it falls back to the single fence style — both shapes are asserted
// structurally, mirroring the @tern-tui/core unit tests.
const markdownNode2 = renderer.root.children[2];
assert(markdownNode2?.type === "markdown", "MarkdownView materializes as a scene-root sibling");
assert(markdownNode2?.props.flex_direction === "column", "the markdown root is a flex column");
assert(!("source" in (markdownNode2?.props ?? {})), "the parsed source never reaches the scene props");
const mdHeading = markdownNode2?.children[0];
assert(
  mdHeading?.type === "text" && mdHeading.props.bold === true && mdHeading.props.underline === true,
  "the H1 heading renders bold + underlined",
);
const mdFence = markdownNode2?.children.find((child) => child.props.bg === MARKDOWN_FENCE_BG);
assert(mdFence !== undefined, "the rust code fence composes a bg box");
assert(
  (mdFence?.children.length ?? 0) === 3,
  `the fence holds one leaf per code line (got ${mdFence?.children.length})`,
);
// The fence leaves reconstruct the source lines exactly (whether highlighted
// with token colors or plain): a highlighted line may be a flex row of
// per-span leaves, so the text is the leaves' joined props.
const fenceText = (node: Node): string =>
  typeof node.props.text === "string"
    ? node.props.text
    : node.children.map(fenceText).join("");
const fenceLines = mdFence?.children.map((line) => fenceText(line)).join("\n") ?? "";
assert(
  fenceLines === "fn main() {\n    let x = 1;\n}",
  `the fence renders the code lines (got ${JSON.stringify(fenceLines)})`,
);
// The deepened M3 blocks: the pipe table materializes as a `table` element
// (the parser reuses the roadmap `Table` — sticky header + content region),
// the task-list items render as checkbox-glyph rows (`[x]` / `[ ]` replace
// the bullet), and the link line composes as a row box whose span carries
// the link affordance: underline + the link fg, plus the OSC-8 `href` style
// key the engine paints as a hyperlink sequence.
const mdTable = markdownNode2?.children[3];
const mdTableHeaderCells = mdTable?.children[0]?.children.map((cell) => cell.props.text) ?? [];
const mdTableRow0Cells = mdTable?.children[1]?.children[0]?.children.map((cell) => cell.props.text) ?? [];
assert(
  mdTable?.type === "table" &&
    mdTableHeaderCells.join("|") === "Name |Role " &&
    mdTableRow0Cells.join("|") === "Ada  |dev  ",
  `the pipe table materializes as a table element (header ${JSON.stringify(mdTableHeaderCells.join("|"))}, row ${JSON.stringify(mdTableRow0Cells.join("|"))})`,
);
const mdTaskRows = markdownNode2?.children.slice(4, 6).map((child) => child.props.text) ?? [];
assert(
  mdTaskRows.join("\n") === "[x] shipped task\n[ ] pending task",
  `the task-list items render as checkbox-glyph rows (got ${JSON.stringify(mdTaskRows.join("\n"))})`,
);
const mdLinkRow = markdownNode2?.children[6];
const mdLinkSpan = mdLinkRow?.children.find(
  (span) => span.props.underline === true && span.props.fg === MARKDOWN_LINK_FG,
);
assert(
  mdLinkRow?.type === "box" &&
    mdLinkRow.props.flex_direction === "row" &&
    mdLinkSpan !== undefined &&
    mdLinkSpan.props.text === "tern docs" &&
    mdLinkSpan.props.href === "https://tern.dev",
  "the link line composes as a row box whose span carries the OSC-8 href style key",
);

// --- Theme ------------------------------------------------------------------------
assert(themedPrimary?.props.fg === "#123456", "role=primary resolves the custom palette fg");
assert(themedInput?.props.border_style === "double", "component=input resolves the preset border_style");

// --- M3 form primitives (scene-root siblings) --------------------------------------
// The Checkbox / Toggle / Radio / HelpPanel nodes mount as renderer.root
// children 3..6 (the app box, the modal and the MarkdownView precede them).
const checkboxNode2 = renderer.root.children[3];
const toggleNode2 = renderer.root.children[4];
const radioNode2 = renderer.root.children[5];
const helpPanelNode2 = renderer.root.children[6];
assert(checkboxNode2?.type === "checkbox", "Checkbox materializes as a root sibling");
assert(checkboxNode2?.props.checked === true, "the checkbox starts checked");
assert(
  !("label" in (checkboxNode2?.props ?? {})),
  "the checkbox label is JS bookkeeping, never a scene prop",
);
assert(
  checkboxNode2?.children[0]?.props.text === `${CHECKBOX_CHECKED_GLYPH} Dark mode`,
  "the checked checkbox composes the glyph + label leaf",
);
// checkboxKey flips the checked state (space), rebuilding the leaf in place.
const flipped = checkboxKey(checkboxNode2!, { name: "char", char: " ", ctrl: false, alt: false, shift: false });
assert(flipped.checked === false, "checkboxKey space unchecks the box");
assert(
  checkboxNode2?.children[0]?.props.text === "[ ] Dark mode",
  "the unchecked glyph replaces the checked one",
);
assert(toggleNode2?.type === "toggle", "Toggle materializes as a root sibling");
assert(toggleNode2?.props.on === true, "the toggle starts on");
assert(
  toggleNode2?.children[0]?.props.text === `${TOGGLE_ON_GLYPH} Wrap`,
  "the on toggle composes the glyph + label leaf",
);
const toggled = toggleKey(toggleNode2!, { name: "enter", ctrl: false, alt: false, shift: false });
assert(toggled.on === false, "toggleKey enter turns the toggle off");
assert(radioNode2?.type === "radio", "Radio materializes as a root sibling");
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
assert(helpPanelNode2?.type === "box", "HelpPanel materializes as a plain box");
assert(
  helpPanelNode2?.children[0]?.props.text === "Keybindings",
  "the help panel renders the title row first",
);
// Two described entries (the dispatch-only 'q' registration is skipped);
// the key hints right-align in the widest-hint column, descriptions dimmed.
const helpRows = helpPanelNode2?.children.slice(1) ?? [];
assert(
  helpRows.length === 2 &&
    helpRows[0]?.children[0]?.props.text === "ctrl+k" &&
    helpRows[0]?.children[1]?.props.text === "open command palette" &&
    helpRows[1]?.children[1]?.props.dim === true,
  "the help panel lists the described combos, dispatch-only entries skipped",
);

// --- OSC 8 hyperlink (root sibling) ---------------------------------------------------
// The `hyperlink` prop translates to the `href` style key on the scene node
// (the engine paints the run as an OSC 8 hyperlink sequence) — the same
// alias the markdown link affordance mirrors. Assert the translation and
// that the camelCase alias never leaks into the scene props.
const osc8Node2 = renderer.root.children[7];
assert(osc8Node2?.type === "text", "the OSC 8 hyperlink node materializes as a root sibling");
assert(
  osc8Node2?.props.text === "tern.dev" && osc8Node2?.props.href === "https://tern.dev",
  "the hyperlink prop translates to the href style key on the scene node",
);
assert(
  !("hyperlink" in (osc8Node2?.props ?? {})),
  "the camelCase hyperlink alias never reaches the scene props",
);

// --- Menu (floating overlay + focus isolation) --------------------------------------
assert(menu?.type === "menu", "the Menu host materializes in the app box");
assert(
  menu?.props.z_index === MENU_Z_INDEX,
  `the floating menu paints above in-flow content (z_index = ${menu?.props.z_index})`,
);
assert(menu?.props.hidden === true && menu?.props.display === "none", "a closed menu is hidden");
// Opening moves focus semantics: the menu registers nothing focusable (no
// focusId), so openMenu still shows it and closeMenu hides it again.
openMenu(menu!);
assert(menu?.props.hidden === false && menu?.props.display === "flex", "openMenu shows the menu");
assert(menu?.children.length === 3, "the open menu composes one row per root item");
assert(
  menu?.children[0]?.props.reversed === true,
  "the highlighted item's row renders reversed",
);
const menuDown = menuKey(menu!, { name: "down", ctrl: false, alt: false, shift: false });
assert(menuDown.highlighted === 1, "menuKey down moves the highlight to the submenu branch");
const menuRight = menuKey(menu!, { name: "right", ctrl: false, alt: false, shift: false });
assert(
  menuRight.open_submenus.includes("insert") && menuRight.count === 5,
  "menuKey right opens the branch: 3 root rows + 2 indented submenu rows",
);
closeMenu(menu!);
assert(menu?.props.hidden === true, "closeMenu hides the menu");

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
// Windowing rebuilds the region node on every scroll, so the captured
// reference would go stale — read the live region from the table each time
// (the same pattern the tableKey section uses).
const regionScrollY = (): number => table?.children[1]?.props.scroll_y as number;
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

renderer.startEventStream();
let quit = false;
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
renderer.destroy();

if (!quit) {
  console.error("[kitchen-sink-react] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[kitchen-sink-react] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[kitchen-sink-react] ok: kitchen-sink scene asserted and quit on 'q'");
process.exit(0);
