/**
 * Unit tests for the @tern-tui/react renderer.
 *
 * These exercise the renderer without the native addon or a real terminal:
 * the scene root is a *detached* core `Node` (a `Box()` template), so
 * `addChild`/`setProps` are pure JS bookkeeping and the commit never touches
 * the native scene. The full PTY smoke (real renderer, real terminal) is
 * verified in the examples package (subtask 13).
 *
 * Run with `deno test` (no permission flags needed).
 */

import { act, createElement } from "react";
import {
  Box as CoreBox,
  Text as CoreText,
  FocusManager,
  MODAL_Z_INDEX,
  STREAM_AFFORDANCE_CHAR,
  SELECTION_DOUBLE_CLICK_MS,
  closeModal,
  createRenderer,
  focusManager,
  followTail,
  isStreamFollowing,
  openModal,
  scrollTo,
  scrollToBottom,
  selectionKey,
  setSelectionClockForTesting,
  useFocus as coreUseFocus,
  type KeyEvent,
  type MouseEventJs,
  type Node,
  type Renderer,
  type ResizeHandler,
  type SelectionRange,
  type Span,
  type TernEventJs,
} from "@tern-tui/core";
import { setAddonForTesting } from "../../core/src/addon.ts";
import type { TernAddon } from "../../core/src/addon.ts";

// React 19 requires act() to be enabled explicitly in non-test-runner envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  Box,
  DiffView,
  FocusManagerContext,
  Input,
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
  createRoot,
  defaultTheme,
  hostConfig,
  name,
  render,
  tableKey,
  toNodeProps,
  Tree,
  treeKey,
  useApp,
  useClickToFocus,
  useFocus,
  useFocusManager,
  useFocusTraversal,
  useInput,
  usePanelMouseDrag,
  usePaste,
  useResize,
  useSelection,
  useTerminalDimensions,
  useTheme,
  useWheelScroll,
  version,
  visibleTableRows,
} from "./index.ts";
import type { AppHandle, TernProps, Theme, ThemeOverrides } from "./index.ts";

// The @types HostConfig marks the mutation methods optional; our config
// implements them all, so widen the surface for direct calls in tests.
const hc = hostConfig as Required<typeof hostConfig>;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** A fake core Renderer over a detached root: no native calls, render() spy. */
function mockRenderer(): {
  renderer: Renderer;
  root: ReturnType<typeof CoreBox>;
  renderCalls: number[];
  size: { width: number; height: number };
  keyHandlers: Set<(event: KeyEvent) => void>;
  resizeHandlers: Set<ResizeHandler>;
  focusHandlers: Set<(event: { focus_gained: boolean }) => void>;
  pasteHandlers: Set<(text: string) => void>;
  mouseHandlers: Set<(event: MouseEventJs) => void>;
} {
  const renderCalls: number[] = [];
  // The reported terminal size: `renderer.size` in the real renderer reads
  // the native terminal, here it reads this mutable object (tests may adjust
  // it before mounting to seed the initial state).
  const size = { width: 80, height: 24 };
  const keyHandlers = new Set<(event: KeyEvent) => void>();
  const resizeHandlers = new Set<ResizeHandler>();
  const focusHandlers = new Set<(event: { focus_gained: boolean }) => void>();
  const pasteHandlers = new Set<(text: string) => void>();
  const mouseHandlers = new Set<(event: MouseEventJs) => void>();
  const root = CoreBox();
  const renderer = {
    root,
    get size(): { width: number; height: number } {
      return size;
    },
    render: () => {
      renderCalls.push(renderCalls.length);
    },
    onKey: (handler: (event: KeyEvent) => void) => {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    onResize: (handler: ResizeHandler) => {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },
    onFocus: (handler: (event: { focus_gained: boolean }) => void) => {
      focusHandlers.add(handler);
      return () => focusHandlers.delete(handler);
    },
    onPaste: (handler: (text: string) => void) => {
      pasteHandlers.add(handler);
      return () => pasteHandlers.delete(handler);
    },
    onMouse: (handler: (event: MouseEventJs) => void) => {
      mouseHandlers.add(handler);
      return () => mouseHandlers.delete(handler);
    },
    destroy: () => {},
  } as unknown as Renderer;
  return { renderer, root, renderCalls, size, keyHandlers, resizeHandlers, focusHandlers, pasteHandlers, mouseHandlers };
}

function keyEvent(over: Partial<KeyEvent> = {}): KeyEvent {
  return { name: "char", char: "q", ctrl: false, alt: false, shift: false, ...over };
}

function mouseEvent(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

// ---------------------------------------------------------------------------
// Package surface
// ---------------------------------------------------------------------------

Deno.test("react exports package metadata", () => {
  if (name !== "@tern-tui/react") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.2.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("public API surface is exported", () => {
  for (const fn of [
    Box,
    Text,
    StreamingText,
    Input,
    Menu,
    Spinner,
    StatusBar,
    Panels,
    DiffView,
    ScrollView,
    Table,
    Tabs,
    Progress,
    useFocus,
    useFocusManager,
    useFocusTraversal,
    useResize,
    useSelection,
    useTerminalDimensions,
    createRoot,
    render,
    useApp,
    useInput,
    usePaste,
  ]) {
    if (typeof fn !== "function") {
      throw new Error(`expected ${String(fn)} to be a function`);
    }
  }
});

// ---------------------------------------------------------------------------
// HostConfig contract
// ---------------------------------------------------------------------------

Deno.test("hostConfig is mutation mode with the required mapping", () => {
  if (hostConfig.supportsMutation !== true) {
    throw new Error("supportsMutation must be true (mutation mode)");
  }
  if (hostConfig.supportsPersistence !== false) {
    throw new Error("supportsPersistence must be false");
  }
  if (hostConfig.supportsHydration !== false) {
    throw new Error("supportsHydration must be false");
  }
  if (hostConfig.noTimeout !== -1) {
    throw new Error(`noTimeout must be -1, got ${hostConfig.noTimeout}`);
  }
  for (const method of [
    "createInstance",
    "createTextInstance",
    "appendChild",
    "appendChildToContainer",
    "insertBefore",
    "removeChild",
    "removeChildFromContainer",
    "commitUpdate",
    "prepareForCommit",
    "resetAfterCommit",
    "scheduleTimeout",
    "cancelTimeout",
  ] as const) {
    if (typeof hc[method] !== "function") {
      throw new Error(`hostConfig.${method} must be a function`);
    }
  }
});

Deno.test("createInstance maps host types to tern node factories", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const box = hc.createInstance("box", { border_style: "rounded" }, container, {}, null);
  if (box.type !== "box") throw new Error(`box type = ${box.type}`);
  if (box.props.border_style !== "rounded") {
    throw new Error(`box border_style = ${box.props.border_style}`);
  }

  const text = hc.createInstance("text", { text: "hi", bold: true }, container, {}, null);
  if (text.type !== "text") throw new Error(`text type = ${text.type}`);
  if (text.props.text !== "hi") throw new Error(`text = ${text.props.text}`);
  if (text.props.bold !== true) throw new Error(`bold = ${text.props.bold}`);

  const stream = hc.createInstance("streaming_text", { text: "old" }, container, {}, null);
  if (stream.type !== "streaming_text") throw new Error(`streaming_text type = ${stream.type}`);
  if (stream.props.text !== "old") throw new Error(`streaming_text text = ${stream.props.text}`);
});

Deno.test("createInstance maps roadmap host types to the core factories", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };

  const input = hc.createInstance("input", { value: "hi", caret: 1 }, container, {}, null);
  if (input.type !== "input") throw new Error(`input type = ${input.type}`);
  if (input.props.value !== "hi" || input.props.caret !== 1) {
    throw new Error(`input props = ${JSON.stringify(input.props)}`);
  }
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text" || leaf.props.text !== "hi") {
    throw new Error("input must compose a text leaf carrying the value");
  }

  const textarea = hc.createInstance(
    "textarea",
    { lines: ["ab", "cd"], row: 1, col: 2 },
    container,
    {},
    null,
  );
  if (textarea.type !== "textarea") throw new Error(`textarea type = ${textarea.type}`);
  if (textarea.props.row !== 1 || textarea.props.col !== 2) {
    throw new Error(`textarea props = ${JSON.stringify(textarea.props)}`);
  }
  if (textarea.children.length !== 2 || textarea.children[1]?.props.caret !== 2) {
    throw new Error("textarea must compose one line leaf per line with the caret");
  }

  const spinner = hc.createInstance("spinner", {}, container, {}, null);
  if (spinner.type !== "spinner") throw new Error(`spinner type = ${spinner.type}`);
  if (typeof spinner.props.text !== "string" || spinner.props.text === "") {
    throw new Error("spinner must carry its rendered frame text");
  }

  const bar = hc.createInstance("status_bar", { left: "L", right: "R" }, container, {}, null);
  if (bar.type !== "status_bar") throw new Error(`status_bar type = ${bar.type}`);
  if (bar.children.length !== 2) throw new Error(`status_bar segments = ${bar.children.length}`);
  if (bar.children[0]?.props.text !== "L" || bar.children[1]?.props.text !== "R") {
    throw new Error("status_bar segment texts");
  }

  const panels = hc.createInstance(
    "panels",
    { panels: [{ header: "A", body: CoreBox() }] } as never,
    container,
    {},
    null,
  );
  if (panels.type !== "panels") throw new Error(`panels type = ${panels.type}`);
  if (panels.children.length !== 1) throw new Error(`panels = ${panels.children.length}`);
  if (panels.children[0]?.children[0]?.props.text !== "A") {
    throw new Error("panel header must be the first child");
  }

  const diff = hc.createInstance(
    "diff",
    { hunks: [{ kind: "add", old_line: 0, new_line: 1, text: "+x" }] } as never,
    container,
    {},
    null,
  );
  if (diff.type !== "diff") throw new Error(`diff type = ${diff.type}`);
  if (diff.children.length !== 1) throw new Error(`diff rows = ${diff.children.length}`);
  const diffRow = diff.children[0]!;
  if (diffRow.children.length !== 3) throw new Error("a diff row must be gutter + marker + content");
  if (diffRow.children[1]?.props.text !== "+") {
    throw new Error("add marker must be the first-row marker");
  }
});

Deno.test("createInstance maps scroll_view to the core ScrollView factory", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const view = hc.createInstance(
    "scroll_view",
    { clip_x: 1, clip_y: 2, clip_width: 10, clip_height: 4, scroll_y: 3, showScrollbar: true },
    container,
    {},
    null,
  );
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.clip_x !== 1 || view.props.clip_y !== 2) {
    throw new Error(`clip origin = ${JSON.stringify(view.props)}`);
  }
  if (view.props.clip_width !== 10 || view.props.clip_height !== 4) {
    throw new Error(`clip size = ${JSON.stringify(view.props)}`);
  }
  if (view.props.scroll_y !== 3) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  // `showScrollbar` is consumed by the factory (a scrollbar leaf is composed),
  // never a scene prop.
  if ("showScrollbar" in view.props) throw new Error("showScrollbar must not reach the scene props");
  const leaf = view.children[0];
  if (leaf === undefined || leaf.type !== "text" || leaf.props.position !== "absolute") {
    throw new Error("showScrollbar must compose a scrollbar text leaf");
  }
});

Deno.test("createInstance maps table to the core Table factory", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const table = hc.createInstance(
    "table",
    {
      columns: [
        { key: "name", header: "Name", width: 8 },
        { key: "score", header: "Score", width: 5, align: "right" },
      ],
      rows: [
        ["Ada", 92],
        ["Grace", 88],
      ],
      highlight: 1,
      clip_height: 2,
    } as never,
    container,
    {},
    null,
  );
  if (table.type !== "table") throw new Error(`type = ${table.type}`);
  if (table.props.highlight !== 1) throw new Error(`highlight = ${table.props.highlight}`);
  // The column/row model is JS bookkeeping, never scene props.
  if ("columns" in table.props || "rows" in table.props) {
    throw new Error("columns/rows must not reach the scene props");
  }
  // Sticky structure: header row + content region with one row per data row.
  const header = table.children[0];
  const region = table.children[1];
  if (header?.props.flex_direction !== "row" || header?.children.length !== 2) {
    throw new Error("header row must compose one cell per column");
  }
  if (region === undefined || region.children.length !== 2) {
    throw new Error(`rows = ${region?.children.length}`);
  }
  // The highlighted row (index 1) renders reversed.
  if (region.children[1]?.children.every((cell) => cell.props.reversed === true) !== true) {
    throw new Error("the highlighted row's cells must be reversed");
  }
});

Deno.test("createInstance maps tree to the core Tree factory; treeKey drives it", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const tree = hc.createInstance(
    "tree",
    {
      nodes: [
        { label: "src", children: [{ label: "index.ts" }] },
        { label: "package.json" },
      ],
      clip_height: 5,
      focusId: "tree",
      onChange: () => {},
    } as never,
    container,
    {},
    null,
  );
  if (tree.type !== "tree") throw new Error(`type = ${tree.type}`);
  // The node model + expand bookkeeping is JS state, never scene props.
  if ("nodes" in tree.props || "expanded" in tree.props || "indent" in tree.props) {
    throw new Error("nodes/expanded/indent must not reach the scene props");
  }
  // The callback + focus wiring is component-consumed (mirroring <Tabs>),
  // never scene props — a leaked function would break the native serialization.
  if ("onChange" in tree.props || "focusId" in tree.props || "focusManager" in tree.props) {
    throw new Error("onChange/focusId/focusManager must not reach the scene props");
  }
  // Collapsed: one leaf per top-level node (2), not the nested child.
  const collapsedRows = tree.children.length;
  if (collapsedRows !== 2) throw new Error(`rows = ${collapsedRows}`);
  if (tree.children[0]?.props.reversed !== true) throw new Error("row 0 must be highlighted");
  // treeKey expands the highlighted branch in place (its child appears).
  const next = treeKey(tree, { name: "right", ctrl: false, alt: false, shift: false });
  if (next.count !== 3) throw new Error(`count after expand = ${next.count}`);
  const expandedRows = tree.children.length;
  if (expandedRows !== 3) throw new Error(`rows after expand = ${expandedRows}`);
});

Deno.test("createInstance maps modal to the core Modal factory", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const body = CoreBox();
  const modal = hc.createInstance(
    "modal",
    { open: true, content: [body] } as never,
    container,
    {},
    null,
  );
  if (modal.type !== "modal") throw new Error(`type = ${modal.type}`);
  // The overlay paints above in-flow content: the high default z_index.
  if (modal.props.z_index !== MODAL_Z_INDEX) throw new Error(`z_index = ${modal.props.z_index}`);
  if (modal.props.open !== true) throw new Error(`open = ${modal.props.open}`);
  // Composition: the dimmed backdrop fill + a centered content box holding
  // the content node.
  if (modal.children.length !== 2) throw new Error(`children = ${modal.children.length}`);
  if (modal.children[0]?.props.position !== "absolute") {
    throw new Error("backdrop must be an absolute fill");
  }
  if (modal.children[1]?.children[0] !== body) {
    throw new Error("content must live inside the content box");
  }
  // The content node list is JS bookkeeping, never a scene prop.
  if ("content" in modal.props) throw new Error("content must not reach the scene props");
});

Deno.test("createInstance maps tabs to the core Tabs factory", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const tabs = hc.createInstance(
    "tabs",
    {
      tabs: [
        { label: "logs", content: [CoreText({ text: "log line" })] },
        { label: "files", content: [CoreText({ text: "file list" })] },
      ],
    } as never,
    container,
    {},
    null,
  );
  if (tabs.type !== "tabs") throw new Error(`type = ${tabs.type}`);
  if (tabs.props.flex_direction !== "column") throw new Error(`flex_direction = ${tabs.props.flex_direction}`);
  // Composition: the tab bar row (child 0) + the content region (child 1).
  if (tabs.children.length !== 2) throw new Error(`children = ${tabs.children.length}`);
  const bar = tabs.children[0];
  if (bar?.type !== "box" || bar?.props.flex_direction !== "row") {
    throw new Error("the tab bar must be a row box");
  }
  if (bar.children.length !== 2) throw new Error(`tab leaves = ${bar.children.length}`);
  const region = tabs.children[1];
  // Only the active tab's content is materialized in the region.
  if (region?.children.length !== 1 || region?.children[0]?.props.text !== "log line") {
    throw new Error("the content region must hold the active tab's content");
  }
  // The tab spec list is JS bookkeeping, never a scene prop.
  if ("tabs" in tabs.props) throw new Error("tabs must not reach the scene props");
});

Deno.test("createInstance maps progress to the core Progress factory", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const node = hc.createInstance(
    "progress",
    { value: 5, max: 10, label: "work", width: 12 } as never,
    container,
    {},
    null,
  );
  if (node.type !== "progress") throw new Error(`type = ${node.type}`);
  // The bar model state lives on the root box's props (like Tabs' `active`).
  if (node.props.value !== 5 || node.props.max !== 10) {
    throw new Error(`bar model = ${JSON.stringify(node.props)}`);
  }
  if (node.props.width !== 12 || node.props.border_style !== "plain") {
    throw new Error(`frame = ${JSON.stringify(node.props)}`);
  }
  // The label is JS bookkeeping, never a scene prop.
  if ("label" in node.props) throw new Error("label must not reach the scene props");
  // Composition: the fill leaf (child 0) + the label overlay + the readout.
  const bar = node.children[0];
  if (bar === undefined || bar.type !== "text") throw new Error("the fill must be a text leaf");
  if (bar.props.text !== "▓▓▓▓▓░░░░░") {
    throw new Error(`fill = ${JSON.stringify(bar.props.text)}`);
  }
  if (node.children[1]?.props.text !== "work" || node.children[1]?.props.dim !== true) {
    throw new Error("the label overlay must be composed");
  }
  if (node.children[2]?.props.text !== "50%") {
    throw new Error(`readout = ${JSON.stringify(node.children[2]?.props.text)}`);
  }
});

Deno.test("createInstance strips React-only props before the factories", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const node = hc.createInstance(
    "box",
    { children: [], key: "k", ref: null, width: 10 } as never,
    container,
    {},
    null,
  );
  if ("children" in node.props || "key" in node.props || "ref" in node.props) {
    throw new Error(`React-only props leaked: ${JSON.stringify(node.props)}`);
  }
  if (node.props.width !== 10) throw new Error(`width = ${node.props.width}`);
});

Deno.test("createTextInstance throws (tern requires explicit <Text>)", () => {
  let threw: string | null = null;
  try {
    hc.createTextInstance("raw", { root: CoreBox(), renderer: mockRenderer().renderer }, {}, null);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  if (threw === null) throw new Error("createTextInstance must throw");
  if (!threw.includes("<Text")) {
    throw new Error(`error should point at <Text>: ${threw}`);
  }
});

Deno.test("commitUpdate maps to Node.setProps", () => {
  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const node = hc.createInstance("text", { text: "old" }, container, {}, null);
  hc.commitUpdate(node, "text", { text: "old" }, { text: "new", fg: "#fff" }, null);
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.fg !== "#fff") throw new Error(`fg = ${node.props.fg}`);
});

Deno.test("tree ops append/remove children on a detached root", () => {
  const { renderer, root } = mockRenderer();
  const container = { root, renderer };

  const a = hc.createInstance("text", { text: "a" }, container, {}, null);
  const b = hc.createInstance("text", { text: "b" }, container, {}, null);
  hc.appendChildToContainer(container, a);
  hc.appendChildToContainer(container, b);
  if (root.children.length !== 2) throw new Error(`children.length = ${root.children.length}`);
  if (root.children[0] !== a || root.children[1] !== b) {
    throw new Error("append order not preserved");
  }

  hc.removeChildFromContainer(container, a);
  hc.removeChildFromContainer(container, b);
  // removeChildFromContainer -> core Node.remove(): the child is spliced out
  // of the root's children list even on a detached (unmaterialized) scene, so
  // the JS tree mirrors the removal without a native call.
  const remaining: number = root.children.length;
  if (remaining !== 0) {
    throw new Error(`expected removed children to be spliced out, got ${remaining}`);
  }
  if (a.attached || b.attached) throw new Error("removed children must be detached");
});

Deno.test("insertBefore places a new child before the anchor (host config)", () => {
  const { renderer, root } = mockRenderer();
  const container = { root, renderer };
  const parent = hc.createInstance("box", {}, container, {}, null);
  const a = hc.createInstance("text", { text: "a" }, container, {}, null);
  const b = hc.createInstance("text", { text: "b" }, container, {}, null);
  const c = hc.createInstance("text", { text: "c" }, container, {}, null);
  parent.addChild(a);
  parent.addChild(b);
  parent.addChild(c);

  // Insert a new child before the middle sibling.
  const x = hc.createInstance("text", { text: "x" }, container, {}, null);
  hc.insertBefore(parent, x, b);
  let kids = parent.children;
  if (kids[0] !== a || kids[1] !== x || kids[2] !== b || kids[3] !== c) {
    throw new Error(`anchor insert order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }

  // Before-first insert.
  const y = hc.createInstance("text", { text: "y" }, container, {}, null);
  hc.insertBefore(parent, y, a);
  kids = parent.children;
  if (kids[0] !== y || kids[1] !== a || kids[2] !== x || kids[3] !== b || kids[4] !== c) {
    throw new Error(`before-first insert order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }
});

Deno.test("insertBefore repositions an already-present child (keyed moves)", () => {
  const { renderer, root } = mockRenderer();
  const container = { root, renderer };
  const parent = hc.createInstance("box", {}, container, {}, null);
  const a = hc.createInstance("text", { text: "a" }, container, {}, null);
  const b = hc.createInstance("text", { text: "b" }, container, {}, null);
  const c = hc.createInstance("text", { text: "c" }, container, {}, null);
  parent.addChild(a);
  parent.addChild(b);
  parent.addChild(c);

  // Move `a` (already attached) before `c` — the keyed-reorder path.
  hc.insertBefore(parent, a, c);
  let kids = parent.children;
  if (kids[0] !== b || kids[1] !== a || kids[2] !== c) {
    throw new Error(`move-before order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }

  // Move `c` (already attached) before `b`.
  hc.insertBefore(parent, c, b);
  kids = parent.children;
  if (kids[0] !== c || kids[1] !== b || kids[2] !== a) {
    throw new Error(`second move order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }
});

Deno.test("appendChild on an already-present child moves it to the end", () => {
  const { renderer, root } = mockRenderer();
  const container = { root, renderer };
  const parent = hc.createInstance("box", {}, container, {}, null);
  const a = hc.createInstance("text", { text: "a" }, container, {}, null);
  const b = hc.createInstance("text", { text: "b" }, container, {}, null);
  const c = hc.createInstance("text", { text: "c" }, container, {}, null);
  parent.addChild(a);
  parent.addChild(b);
  parent.addChild(c);

  // React calls appendChild for the trailing placements of a full reorder;
  // the child is already attached, so this must reposition, not no-op.
  hc.appendChild(parent, a);
  let kids = parent.children;
  if (kids[0] !== b || kids[1] !== c || kids[2] !== a) {
    throw new Error(`append-move order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }
  hc.appendChild(parent, b);
  kids = parent.children;
  if (kids[0] !== c || kids[1] !== a || kids[2] !== b) {
    throw new Error(`second append-move order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }
});

Deno.test("insertInContainerBefore honors the anchor order", () => {
  const { renderer, root } = mockRenderer();
  const container = { root, renderer };
  const a = hc.createInstance("text", { text: "a" }, container, {}, null);
  const b = hc.createInstance("text", { text: "b" }, container, {}, null);
  hc.appendChildToContainer(container, a);
  hc.appendChildToContainer(container, b);

  const x = hc.createInstance("text", { text: "x" }, container, {}, null);
  hc.insertInContainerBefore(container, x, b);
  const kids = root.children;
  if (kids[0] !== a || kids[1] !== x || kids[2] !== b) {
    throw new Error(`container anchor order wrong: ${kids.map((k) => k.props.text).join(",")}`);
  }
});

Deno.test("keyed list reorder is reflected in scene order", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const item = (key: string) => createElement(Text, { key, text: key });

  await act(() => {
    ternRoot.render(createElement(Box, {}, item("a"), item("b"), item("c")));
  });
  const box = root.children[0]!;
  const order = () => box.children.map((n) => n.props.text).join(",");
  if (order() !== "a,b,c") throw new Error(`initial order: ${order()}`);

  // Full reorder: React repositions via appendChild on already-present
  // children (getHostSibling returns null when every trailing sibling moves).
  await act(() => {
    ternRoot.render(createElement(Box, {}, item("c"), item("a"), item("b")));
  });
  if (order() !== "c,a,b") throw new Error(`full reorder: ${order()}`);

  // Partial reorder: React repositions via insertBefore with an
  // already-present child (keyed-list move).
  await act(() => {
    ternRoot.render(createElement(Box, {}, item("b"), item("a"), item("c")));
  });
  if (order() !== "b,a,c") throw new Error(`partial reorder: ${order()}`);

  // Returning to the original order reuses the instances.
  await act(() => {
    ternRoot.render(createElement(Box, {}, item("a"), item("b"), item("c")));
  });
  if (order() !== "a,b,c") throw new Error(`back to original: ${order()}`);
});

Deno.test("scheduleTimeout/cancelTimeout proxy setTimeout/clearTimeout", async () => {
  let fired = false;
  const id = hc.scheduleTimeout(() => {
    fired = true;
  }, 5);
  hc.cancelTimeout(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (fired) throw new Error("cancelled timeout must not fire");
});

Deno.test("resolveUpdatePriority returns DefaultEventPriority", () => {
  if (hc.resolveUpdatePriority() !== 32) {
    throw new Error(`resolveUpdatePriority = ${hc.resolveUpdatePriority()}`);
  }
  if (hc.getCurrentUpdatePriority() !== 32) {
    throw new Error(`initial getCurrentUpdatePriority = ${hc.getCurrentUpdatePriority()}`);
  }
  hc.setCurrentUpdatePriority(2); // DiscreteEventPriority
  if (hc.getCurrentUpdatePriority() !== 2) {
    throw new Error("setCurrentUpdatePriority must round-trip");
  }
  hc.setCurrentUpdatePriority(32);
});

// ---------------------------------------------------------------------------
// toNodeProps
// ---------------------------------------------------------------------------

Deno.test("toNodeProps keeps tern props, drops children/key/ref/undefined", () => {
  // Widened to Record so `padding: undefined` survives the literal check under
  // exactOptionalPropertyTypes (the runtime value is what matters here).
  const props: Record<string, unknown> = {
    text: "hi",
    width: 10,
    children: [createElement(Text, { text: "kid" })],
    key: "k",
    ref: null,
    padding: undefined,
  };
  const out = toNodeProps(props as TernProps);
  if (out.text !== "hi" || out.width !== 10) throw new Error("tern props lost");
  if ("children" in out || "key" in out || "ref" in out || "padding" in out) {
    throw new Error(`unexpected props: ${JSON.stringify(out)}`);
  }
});

Deno.test("percentage size props pass through as strings", () => {
  // `width` / `min_width` / `max_width` accept `"N%"` strings; they survive
  // toNodeProps verbatim and reach the node's prop map through commitUpdate
  // (the JS -> native binding maps them to Str props the layout engine reads).
  const props: Record<string, unknown> = {
    width: "50%",
    min_width: "25%",
    max_width: "75%",
    height: 10,
    children: [createElement(Text, { text: "kid" })],
  };
  const out = toNodeProps(props as TernProps);
  if (out.width !== "50%" || out.min_width !== "25%" || out.max_width !== "75%") {
    throw new Error(`percentage strings lost: ${JSON.stringify(out)}`);
  }
  if (out.height !== 10) throw new Error(`height = ${out.height}`);

  const container = { root: CoreBox(), renderer: mockRenderer().renderer };
  const node = hc.createInstance("box", { width: "50%" }, container, {}, null);
  hc.commitUpdate(node, "box", { width: "50%" }, { width: "60%", min_width: "30%" }, null);
  if (node.props.width !== "60%" || node.props.min_width !== "30%") {
    throw new Error(`commitUpdate must apply the percentage props: ${JSON.stringify(node.props)}`);
  }
});

Deno.test("toNodeProps strips component-level props for input and spinner", () => {
  const inputOut = toNodeProps(
    {
      value: "v",
      caret: 2,
      width: 20,
      focusId: "f",
      focusManager: new FocusManager(),
      onChange: () => {},
      onSubmit: () => {},
    } as unknown as TernProps,
    "input",
  );
  if (inputOut.value !== "v" || inputOut.caret !== 2 || inputOut.width !== 20) {
    throw new Error(`tern props lost: ${JSON.stringify(inputOut)}`);
  }
  for (const key of ["focusId", "focusManager", "onChange", "onSubmit"]) {
    if (key in inputOut) throw new Error(`input component prop leaked: ${key}`);
  }

  const spinnerOut = toNodeProps({ frames: ["a"], interval: 50 } as unknown as TernProps, "spinner");
  if (spinnerOut.frames === undefined || (spinnerOut.frames as string[]).length !== 1) {
    throw new Error("spinner frame props must flow through");
  }
  if ("interval" in spinnerOut) throw new Error("spinner interval must be stripped");

  // Textarea: the edit-model props flow through; the callbacks and the focus
  // wiring are stripped (mirroring input).
  const textareaOut = toNodeProps(
    {
      lines: ["a", "b"],
      row: 1,
      col: 2,
      width: 10,
      focusId: "t",
      focusManager: new FocusManager(),
      onChange: () => {},
      onSubmit: () => {},
    } as unknown as TernProps,
    "textarea",
  );
  if (
    textareaOut.row !== 1 ||
    textareaOut.col !== 2 ||
    textareaOut.width !== 10 ||
    (textareaOut.lines as string[]).join(",") !== "a,b"
  ) {
    throw new Error(`textarea tern props lost: ${JSON.stringify(textareaOut)}`);
  }
  for (const key of ["focusId", "focusManager", "onChange", "onSubmit"]) {
    if (key in textareaOut) throw new Error(`textarea component prop leaked: ${key}`);
  }

  // Tabs: the tab spec list and the active state flow through (JS bookkeeping
  // the core factory consumes); the callbacks and the focus wiring are
  // stripped (mirroring select/textarea).
  const tabsOut = toNodeProps(
    {
      tabs: [{ label: "a", content: [] }],
      active: 1,
      closable: true,
      focusId: "t",
      focusManager: new FocusManager(),
      onChange: () => {},
      onClose: () => {},
    } as unknown as TernProps,
    "tabs",
  );
  if (
    (tabsOut.tabs as Array<{ label: string }>)[0]?.label !== "a" ||
    tabsOut.active !== 1 ||
    tabsOut.closable !== true
  ) {
    throw new Error(`tabs tern props lost: ${JSON.stringify(tabsOut)}`);
  }
  for (const key of ["focusId", "focusManager", "onChange", "onClose"]) {
    if (key in tabsOut) throw new Error(`tabs component prop leaked: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// End-to-end reconciliation against a detached root
// ---------------------------------------------------------------------------

Deno.test("createRoot renders a tree onto the scene root", async () => {
  const { renderer, root, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Box, { border_style: "rounded" }, createElement(Text, { text: "hello", bold: true })),
    );
  });

  const box = root.children[0];
  if (!box || box.type !== "box") throw new Error("expected a box child");
  if (box.props.border_style !== "rounded") {
    throw new Error(`box border_style = ${box.props.border_style}`);
  }
  const text = box.children[0];
  if (!text || text.type !== "text") throw new Error("expected a text child");
  if (text.props.text !== "hello") throw new Error(`text = ${text.props.text}`);
  if (text.props.bold !== true) throw new Error(`bold = ${text.props.bold}`);
  if (text.children.length !== 0) throw new Error("text nodes have no children");

  if (renderCalls.length === 0) {
    throw new Error("render() must be invoked via prepareForCommit/resetAfterCommit");
  }
});

Deno.test("<Box borderColor> passes through as the border_color scene prop", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(
        Box,
        { border_style: "rounded", borderColor: "#ff0000" },
        createElement(Text, { text: "hi" }),
      ),
    );
  });

  const box = root.children[0];
  if (!box || box.type !== "box") throw new Error("expected a box child");
  // The camelCase alias is translated to the binding's snake_case style key on
  // the core node, so the scene receives `border_color` (the same treatment
  // `border_style` gets — it is forwarded verbatim).
  if (box.props.border_color !== "#ff0000") {
    throw new Error(`border_color = ${JSON.stringify(box.props.border_color)}`);
  }
  if (box.props.border_style !== "rounded") {
    throw new Error(`border_style = ${box.props.border_style}`);
  }
});

Deno.test("updates reuse instances and commitUpdate applies new props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(createElement(Box, { border_style: "rounded" }, createElement(Text, { text: "one" })));
  });
  const firstBox = root.children[0]!;
  const firstText = firstBox.children[0]!;

  await act(() => {
    ternRoot.render(createElement(Box, { border_style: "plain" }, createElement(Text, { text: "two", fg: "#0f0" })));
  });

  if (root.children[0] !== firstBox) throw new Error("box instance must be reused");
  if (firstBox.children[0] !== firstText) throw new Error("text instance must be reused");
  if (firstBox.props.border_style !== "plain") throw new Error(`border_style = ${firstBox.props.border_style}`);
  if (firstText.props.text !== "two") throw new Error(`text = ${firstText.props.text}`);
  if (firstText.props.fg !== "#0f0") throw new Error(`fg = ${firstText.props.fg}`);
});

Deno.test("conditional children mount and unmount through tree ops", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Box, {}, createElement(Text, { text: "a" }), createElement(Text, { text: "b" })),
    );
  });
  const box = root.children[0]!;
  if (box.children.length !== 2) throw new Error("expected two children");

  await act(() => {
    ternRoot.render(createElement(Box, {}, createElement(Text, { text: "a" })));
  });
  // The unmounted child is removed through removeChild -> core Node.remove(),
  // which splices it out of the box's children list — the JS tree mirrors the
  // scene even on a detached root.
  if (root.children[0] !== box) throw new Error("box instance must be reused");
  const remaining: number = box.children.length;
  if (remaining !== 1) {
    throw new Error(`expected one child after unmount, got ${remaining}`);
  }
  if (box.children[0]!.props.text !== "a") {
    throw new Error("remaining child must be 'a'");
  }
});

Deno.test("bare text children are rejected at render time", async () => {
  const { renderer } = mockRenderer();
  const ternRoot = createRoot(renderer);
  let threw: unknown = null;
  try {
    await act(() => {
      ternRoot.render(createElement(Box, {}, "raw string"));
    });
  } catch (err) {
    threw = err;
  }
  if (threw === null) throw new Error("bare text must throw at render time");
  const message = threw instanceof Error ? threw.message : String(threw);
  if (!message.includes("<Text")) {
    throw new Error(`error should mention <Text>: ${message}`);
  }
});

Deno.test("unmount detaches the tree without throwing", async () => {
  const { renderer } = mockRenderer();
  const ternRoot = createRoot(renderer);
  await act(() => {
    ternRoot.render(createElement(Box, {}, createElement(Text, { text: "x" })));
  });
  await act(() => {
    ternRoot.unmount();
  });
});

Deno.test("render() convenience mounts synchronously and returns a root", async () => {
  const { renderer, root, renderCalls } = mockRenderer();
  let ternRoot: ReturnType<typeof render> | undefined;
  await act(() => {
    ternRoot = render(createElement(Text, { text: "hi" }), renderer);
  });
  // Legacy (sync) root: the commit must have happened before render() returns.
  if (root.children.length !== 1) throw new Error("tree not mounted by render()");
  if (root.children[0]!.props.text !== "hi") throw new Error("text prop mismatch");
  if (renderCalls.length === 0) throw new Error("render() must paint");
  await act(() => {
    ternRoot!.unmount();
  });
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

Deno.test("useApp exposes the app handle inside the tree", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  function Probe(props: { set: (app: AppHandle) => void }) {
    const app = useApp();
    props.set(app);
    return createElement(Text, { text: app === null ? "none" : "ok" });
  }

  const captured: { app: AppHandle | null } = { app: null };
  await act(() => {
    ternRoot.render(createElement(Probe, { set: (app) => (captured.app = app) }));
  });

  if (captured.app === null) throw new Error("useApp must return the app handle");
  if (captured.app.renderer !== (renderer as unknown)) {
    throw new Error("useApp().renderer must be the root's renderer");
  }
  if (root.children[0]!.props.text !== "ok") throw new Error("probe text mismatch");
});

Deno.test("useInput subscribes to renderer key events and detaches on unmount", async () => {
  const { renderer, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  const last: { event: KeyEvent | null } = { event: null };
  function InputProbe() {
    useInput((event) => {
      last.event = event;
    });
    return createElement(Text, { text: "sub" });
  }

  await act(() => {
    ternRoot.render(createElement(InputProbe));
  });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  for (const handler of keyHandlers) handler(keyEvent({ char: "z" }));
  if (last.event === null || last.event.char !== "z") {
    throw new Error("useInput handler must receive key events");
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on unmount");
});

Deno.test("useInput with isActive: false stays detached", async () => {
  const { renderer, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  function InactiveProbe() {
    useInput(() => {}, { isActive: false });
    return createElement(Text, { text: "inactive" });
  }

  await act(() => {
    ternRoot.render(createElement(InactiveProbe));
  });
  if (keyHandlers.size !== 0) throw new Error("inactive handler must not subscribe");
});

Deno.test("usePaste subscribes to renderer paste events and detaches on unmount", async () => {
  const { renderer, pasteHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  const last: { text: string | null } = { text: null };
  function PasteProbe() {
    usePaste((text) => {
      last.text = text;
    });
    return createElement(Text, { text: "sub" });
  }

  await act(() => {
    ternRoot.render(createElement(PasteProbe));
  });

  if (pasteHandlers.size !== 1) {
    throw new Error(`expected 1 paste handler, got ${pasteHandlers.size}`);
  }
  for (const handler of pasteHandlers) handler("pasted text");
  if (last.text !== "pasted text") {
    throw new Error(`usePaste handler must receive the pasted text, got ${JSON.stringify(last.text)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (pasteHandlers.size >= 1) throw new Error("paste handler must be detached on unmount");
});

Deno.test("usePaste with isActive: false stays detached", async () => {
  const { renderer, pasteHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  function InactivePasteProbe() {
    usePaste(() => {}, { isActive: false });
    return createElement(Text, { text: "inactive" });
  }

  await act(() => {
    ternRoot.render(createElement(InactivePasteProbe));
  });
  if (pasteHandlers.size !== 0) throw new Error("inactive paste handler must not subscribe");
});

Deno.test("a focused Input auto-pastes routed paste events and fires onChange", async () => {
  const { renderer, root, pasteHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const changes: Array<{ value: string; caret: number }> = [];
  const treePastes: string[] = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const treePasteCount = () => treePastes.length;

  function App() {
    // The tree-level paste subscription routes each paste through the manager
    // before falling back to its own handler.
    usePaste((text) => treePastes.push(text), { focusManager: manager });
    return createElement(Input, {
      focusId: "main",
      focusManager: manager,
      onChange: (state) => changes.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("main")) throw new Error("input must register under focusId");
  // Not focused: pastes fall through to the tree handler.
  for (const handler of pasteHandlers) handler("xy");
  if (changeCount() !== 0) throw new Error("unfocused input must not receive pastes");
  if (treePasteCount() !== 1 || treePastes[0] !== "xy") {
    throw new Error(`tree handler must receive the paste while unfocused: ${JSON.stringify(treePastes)}`);
  }

  // Focused: the paste routes to the input's paste handler (core `pasteInto`)
  // and fires onChange; the tree handler is skipped.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of pasteHandlers) handler("ab");
  if (changeCount() !== 1 || changes[0]!.value !== "ab" || changes[0]!.caret !== 2) {
    throw new Error(`onChange = ${JSON.stringify(changes)}`);
  }
  if (treePasteCount() !== 1) throw new Error("a routed paste must skip the tree handler");

  // The routed paste lands on the scene node itself (value + caret advanced
  // by the pasted text's display width).
  const input = root.children[0]!;
  if (input.props.value !== "ab" || input.props.caret !== 2) {
    throw new Error(`node edited = ${input.props.value}/${input.props.caret}`);
  }

  // A second paste inserts at the caret (mid-value) and advances past it.
  for (const handler of pasteHandlers) handler("XY");
  if (changeCount() !== 2 || changes[1]!.value !== "abXY" || changes[1]!.caret !== 4) {
    throw new Error(`second paste = ${JSON.stringify(changes)}`);
  }
  // Read through a function: TS control-flow narrowing would otherwise pin
  // `input.props.value` to the literal of the first assertion.
  const valueOf = () => input.props.value as string;
  if (valueOf() !== "abXY") {
    throw new Error(`node after second paste = ${JSON.stringify(valueOf())}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("main")) throw new Error("input must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("a focused Textarea auto-pastes routed paste events and fires onChange", async () => {
  const { renderer, root, pasteHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const changes: Array<{ lines: string[]; row: number; col: number }> = [];
  const treePastes: string[] = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const treePasteCount = () => treePastes.length;

  function App() {
    // The tree-level paste subscription routes each paste through the manager
    // before falling back to its own handler.
    usePaste((text) => treePastes.push(text), { focusManager: manager });
    return createElement(Textarea, {
      lines: ["hi"],
      focusId: "main",
      focusManager: manager,
      onChange: (state) => changes.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("main")) throw new Error("textarea must register under focusId");
  // Not focused: pastes fall through to the tree handler.
  for (const handler of pasteHandlers) handler("x");
  if (changeCount() !== 0) throw new Error("unfocused textarea must not receive pastes");
  if (treePasteCount() !== 1 || treePastes[0] !== "x") {
    throw new Error(`tree handler must receive the paste while unfocused: ${JSON.stringify(treePastes)}`);
  }

  // Focused: the paste routes to the textarea's paste handler (core
  // `pasteIntoTextarea`) and fires onChange; the tree handler is skipped.
  // The caret starts at col 0 (no col prop), so the paste lands at the head.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of pasteHandlers) handler("XY");
  if (changeCount() !== 1 || changes[0]!.lines.join(",") !== "XYhi" || changes[0]!.col !== 2) {
    throw new Error(`onChange = ${JSON.stringify(changes)}`);
  }
  if (treePasteCount() !== 1) throw new Error("a routed paste must skip the tree handler");

  // The routed paste lands on the scene node itself (one leaf per line).
  const textarea = root.children[0]!;
  if ((textarea.props as { lines?: string[] }).lines?.join(",") !== "XYhi") {
    throw new Error(`node lines = ${JSON.stringify(textarea.props)}`);
  }

  // A multi-line paste splits into new logical lines; the caret lands at the
  // end of the pasted text.
  for (const handler of pasteHandlers) handler("a\nb");
  const second = changes[1];
  if (changeCount() !== 2 || second === undefined) {
    throw new Error(`multi-line paste must fire onChange (${changeCount()})`);
  }
  if (second.lines.join("|") !== "XYa|bhi" || second.row !== 1 || second.col !== 1) {
    throw new Error(`multi-line paste = ${JSON.stringify(second)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("main")) throw new Error("textarea must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("useResize subscribes to renderer resize events, re-renders, and detaches on unmount", async () => {
  const { renderer, resizeHandlers, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);

  const last: { size: { width: number; height: number } | null } = { size: null };
  function ResizeProbe() {
    useResize((size) => {
      last.size = size;
    });
    return createElement(Text, { text: "resize" });
  }

  await act(() => {
    ternRoot.render(createElement(ResizeProbe));
  });

  if (resizeHandlers.size !== 1) {
    throw new Error(`expected 1 resize handler, got ${resizeHandlers.size}`);
  }
  // The mount commit already painted (prepareForCommit/resetAfterCommit);
  // a resize must add at least one more render() call on top of that.
  const rendersBeforeResize = renderCalls.length;
  for (const handler of resizeHandlers) handler({ width: 120, height: 40 });
  if (last.size === null || last.size.width !== 120 || last.size.height !== 40) {
    throw new Error(`useResize handler must receive the new size, got ${JSON.stringify(last.size)}`);
  }
  if (renderCalls.length <= rendersBeforeResize) {
    throw new Error(
      `useResize must re-invoke renderer.render() on resize (${rendersBeforeResize} -> ${renderCalls.length})`,
    );
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (resizeHandlers.size >= 1) throw new Error("resize handler must be detached on unmount");
});

Deno.test("useTerminalDimensions seeds from renderer.size and tracks resizes reactively", async () => {
  const { renderer, resizeHandlers, size } = mockRenderer();
  const ternRoot = createRoot(renderer);

  const captured: { dims: { width: number; height: number } | null } = { dims: null };
  function DimsProbe() {
    const dims = useTerminalDimensions();
    captured.dims = dims;
    return createElement(Text, { text: `${dims.width}x${dims.height}` });
  }

  await act(() => {
    ternRoot.render(createElement(DimsProbe));
  });

  if (resizeHandlers.size !== 1) {
    throw new Error(`expected 1 resize handler, got ${resizeHandlers.size}`);
  }
  // Seeded from renderer.size at mount — the mock's initial 80x24. Read
  // through a function: the resize below reassigns `captured.dims` inside
  // React's render, which TS control-flow narrowing cannot see.
  const dimsOf = () => captured.dims;
  const initial = dimsOf();
  if (initial === null || initial.width !== size.width || initial.height !== size.height) {
    throw new Error(
      `initial dims = ${JSON.stringify(initial)}, renderer.size = ${JSON.stringify(size)}`,
    );
  }

  // A resize event updates the state: the component re-renders and the
  // captured value reflects the new size.
  await act(() => {
    for (const handler of resizeHandlers) handler({ width: 120, height: 40 });
  });
  const resized = dimsOf();
  if (resized === null || resized.width !== 120 || resized.height !== 40) {
    throw new Error(`post-resize dims = ${JSON.stringify(resized)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (resizeHandlers.size >= 1) throw new Error("resize handler must be detached on unmount");
});

// ---------------------------------------------------------------------------
// StreamingText
// ---------------------------------------------------------------------------

Deno.test("StreamingText appends spans from an async iterable in order", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  async function* stream(): AsyncIterable<Span> {
    yield { text: "hello" };
    yield { text: " world", style: { bold: true } };
    yield { text: "!" };
  }

  await act(() => {
    ternRoot.render(
      createElement(StreamingText, { stream: stream(), autoScroll: false, wrap: false, width: 30 }),
    );
  });
  await act(() => {}); // drain the stream's microtask chain

  const node = root.children[0]!;
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  const texts = node.spans.map((span) => span.text);
  if (texts.join("") !== "hello world!") {
    throw new Error(`spans not appended in order: ${JSON.stringify(texts)}`);
  }
  if (node.spans[1]!.style?.bold !== true) {
    throw new Error("span style must be forwarded to appendSpan");
  }
  // Component-consumed props must never reach the scene node; tern props must.
  // `wrap` IS a scene prop — the compositor honors `wrap: false` (single-row
  // paint, trimmed at the right edge), so it flows through like `width`.
  if ("stream" in node.props || "autoScroll" in node.props) {
    throw new Error(`component props leaked into node props: ${JSON.stringify(node.props)}`);
  }
  if (node.props.width !== 30) throw new Error(`tern props lost: width = ${node.props.width}`);
  if (node.props.wrap !== false) throw new Error(`tern props lost: wrap = ${node.props.wrap}`);
});

Deno.test("unmounting a StreamingText cancels the iteration (no appends after unmount)", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let generatorFinally = false;

  async function* gated(): AsyncIterable<Span> {
    try {
      yield { text: "first" };
      await gate; // block until released
      yield { text: "late" };
    } finally {
      generatorFinally = true;
    }
  }

  await act(() => {
    ternRoot.render(createElement(StreamingText, { stream: gated() }));
  });
  await act(() => {}); // let the first span land

  const node = root.children[0]!;
  if (node.spans.length !== 1 || node.spans[0]!.text !== "first") {
    throw new Error(`expected only the first span, got ${JSON.stringify(node.spans)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  release(); // unblock the producer so the return() teardown can run
  await act(() => {});

  if (node.spans.length !== 1) {
    throw new Error(`appends after unmount: ${JSON.stringify(node.spans)}`);
  }
  if (!generatorFinally) {
    throw new Error("iterator.return() must be signalled on unmount");
  }
});

Deno.test("StreamingText invokes render() after stream appends", async () => {
  const { renderer, root, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  async function* gated(): AsyncIterable<Span> {
    yield { text: "a" };
    yield { text: "b" };
    await gate; // split the stream so a later batch lands after a baseline
    yield { text: "c" };
  }

  await act(() => {
    ternRoot.render(createElement(StreamingText, { stream: gated() }));
  });
  await act(() => {}); // let "a" and "b" land

  const node = root.children[0]!;
  const before = node.spans.map((span) => span.text).join("");
  if (before !== "ab") throw new Error(`expected "a","b" to land, got ${before}`);
  const rendersBeforeBatch = renderCalls.length;

  release(); // unblock the later batch
  await act(() => {});

  const after = node.spans.map((span) => span.text).join("");
  if (after !== "abc") throw new Error(`expected "c" to land, got ${after}`);
  const rendersAfterBatch = renderCalls.length;
  if (rendersAfterBatch <= rendersBeforeBatch) {
    throw new Error(
      `render() must be invoked after appends (${rendersBeforeBatch} -> ${rendersAfterBatch})`,
    );
  }
  await act(() => {
    ternRoot.unmount();
  });
});

// ---------------------------------------------------------------------------
// StreamingText auto-scroll wiring
//
// `<StreamingText>` feeds the core auto-scroll after each appended span:
// `syncStreamTail` pins `scroll_y` to the stream tail (content height minus
// the `clip_height` viewport) while following; a manual scroll above the tail
// detaches (pins the view); `followTail` re-attaches and snaps back. The
// tree mounts onto a real core `Renderer` over a *size-aware fake addon*
// (the `setAddonForTesting` seam — same approach as the @tern-tui/core tests), so
// `Node.contentSize()` measures the streamed spans and the scroll offsets are
// observable as scene props.
// ---------------------------------------------------------------------------

/** A push-driven async span source with an interruptible iterator. */
function manualSpanSource(): {
  push(span: Span): void;
  stream: AsyncIterable<Span>;
} {
  const queue: Span[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  const step = (resolve: (r: IteratorResult<Span>) => void): void => {
    const span = queue.shift();
    if (span !== undefined) {
      resolve({ value: span, done: false });
      return;
    }
    if (closed) {
      resolve({ value: undefined, done: true });
      return;
    }
    wake = () => step(resolve);
  };

  const iterator: AsyncIterator<Span> = {
    next(): Promise<IteratorResult<Span>> {
      return new Promise((resolve) => step(resolve));
    },
    return(): Promise<IteratorResult<Span>> {
      closed = true;
      wake?.(); // release a parked next() with done:true
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    push(span: Span): void {
      queue.push(span);
      wake?.();
    },
    stream: { [Symbol.asyncIterator]: () => iterator },
  };
}

/** Per-handle `content_size` overrides for the panel-drag geometry tests
 * (keyed by the `FakeStreamNodeHandle` instance backing the node). */
const fakeDragSizes = new Map<object, { width: number; height: number }>();

/** The push callback registered by the fakes' `start_event_stream` (the
 * Renderer constructor registers it; the drag/wheel/click tests feed events
 * through it, standing in for the native event loop). */
let streamCallback: ((err: Error | null, event: TernEventJs) => void) | null = null;

/** The path returned by the drag-test fake `hit_test` (override for the
 * click-to-focus tests — an empty path models a press off any painted cell). */
let dragFakeHitPath: bigint[] = [7n];

/** Render calls recorded by the drag-test fake renderer's `render()`. */
const dragFakeRenders: number[] = [];

/** The frame the drag-test fake paints on render — the stand-in for the
 * native retained buffer that `selection_text` / `selection_word_range`
 * read (the same "hello world" frame the core selection tests paint). */
const selectionFakeRows = ["hello world", "second line"];

/** The selection overlay state of the drag-test fake (mirrors the real
 * per-renderer native selection: the inclusive cell rect, or `null` when
 * no selection is set). */
let dragFakeSelection: { col1: number; row1: number; col2: number; row2: number } | null = null;

/** The last text the drag-test fake pushed to the clipboard (OSC 52). */
let lastSelectionClipboard: string | null = null;

/** Dispatch a mouse event to the renderer's push stream callback. */
function dispatchMouseEvent(kind: string, column: number, row: number): void {
  dispatchEvent({
    type: "mouse",
    mouse: { kind, column, row, ctrl: false, alt: false, shift: false },
  });
}

/** Dispatch a tagged event to the renderer's push stream callback. */
function dispatchEvent(event: TernEventJs): void {
  if (streamCallback === null) throw new Error("no stream callback registered");
  streamCallback(null, event);
}

/** A size-aware fake native handle: `content_size` measures streamed spans. */
class FakeStreamNodeHandle {
  readonly kind: string;
  streamText = "";
  constructor(type: string) {
    this.kind = type;
  }
  content_size(): { width: number; height: number } {
    // Per-handle override for the panel-drag geometry tests.
    const override = fakeDragSizes.get(this);
    if (override !== undefined) return override;
    if (this.kind === "streaming_text") {
      const lines = this.streamText.split("\n");
      let width = 0;
      for (const line of lines) width = Math.max(width, line.length);
      return { width, height: lines.length };
    }
    return { width: 11, height: 2 };
  }
  add_child(child: unknown): unknown {
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    return child;
  }
  set_props(_props: unknown): void {}
  set_prop(_key: string, _value: unknown): void {}
  append_span(text: string, _style?: unknown): void {
    this.streamText += text;
  }
  remove(): boolean {
    return true;
  }
}

/** A fake native `TuiRenderer` standing in for the real addon. */
class FakeStreamTuiRenderer {
  destroyed = false;
  constructor(_options: unknown) {}
  root(): unknown {
    return new FakeStreamNodeHandle("box");
  }
  start_event_stream(callback: (err: Error | null, event: TernEventJs) => void): void {
    streamCallback = callback;
  }
  set_any_event_mouse(_enabled: boolean): void {}
  render(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** The size-aware fake addon injected through `setAddonForTesting`. */
const streamFakeAddon = {
  TuiRenderer: FakeStreamTuiRenderer,
  NodeHandle: FakeStreamNodeHandle,
  create_node: (type: string) => new FakeStreamNodeHandle(type),
} as unknown as TernAddon;

/** A fake native `TuiRenderer` whose push stream callback receives the events
 * the drag/wheel/click tests dispatch (via `dispatchMouseEvent` /
 * `dispatchEvent`). */
class DragFakeTuiRenderer {
  destroyed = false;
  /** The selection overlay: the inclusive cell rect, or `null` when no
   * selection is set (mirrors the real per-renderer native selection). */
  selection: { col1: number; row1: number; col2: number; row2: number } | null = null;
  /** The rows of the last painted frame — the fake's stand-in for the
   * native retained buffer `selection_text` / `selection_word_range` read. */
  lastRows: string[] | null = null;
  constructor(_options: unknown) {}
  root(): unknown {
    return new FakeStreamNodeHandle("box");
  }
  start_event_stream(callback: (err: Error | null, event: TernEventJs) => void): void {
    streamCallback = callback;
  }
  hit_test(_col: number, _row: number): bigint[] {
    // The click-to-focus routing gate consults this; `dragFakeHitPath` is
    // overridden by the wheel/click tests (an empty path = off any cell).
    return dragFakeHitPath;
  }
  set_any_event_mouse(_enabled: boolean): void {}
  render(): void {
    dragFakeRenders.push(1);
    this.lastRows = [...selectionFakeRows];
  }
  set_selection(col1: number, row1: number, col2: number, row2: number): void {
    this.selection = { col1, row1, col2, row2 };
    dragFakeSelection = this.selection;
  }
  clear_selection(): void {
    this.selection = null;
    dragFakeSelection = null;
  }
  set_clipboard(text: string): void {
    lastSelectionClipboard = text;
  }
  /** The text of the current selection, extracted from the last painted
   * rows (mirrors the core fake: row-major, rows joined with `'\n'`). */
  selection_text(): string {
    if (this.selection === null || this.lastRows === null) return "";
    const { col1, row1, col2, row2 } = this.selection;
    const x0 = Math.min(col1, col2);
    const y0 = Math.min(row1, row2);
    const x1 = Math.max(col1, col2);
    const y1 = Math.max(row1, row2);
    const lines: string[] = [];
    for (let y = y0; y <= y1; y++) {
      const row = this.lastRows[y] ?? "";
      let line = "";
      for (let x = x0; x <= x1; x++) line += row[x] ?? " ";
      lines.push(line);
    }
    return lines.join("\n");
  }
  /** The inclusive cell range of the contiguous non-space run containing
   * (`col`, `row`) in the last painted rows, or `null` when the cell is a
   * space (or out of bounds, or nothing painted yet). */
  selection_word_range(col: number, row: number): SelectionRange | null {
    if (this.lastRows === null) return null;
    const rowStr = this.lastRows[row];
    if (rowStr === undefined || col >= rowStr.length) return null;
    if (rowStr[col] === " ") return null;
    let left = col;
    while (left > 0 && rowStr[left - 1] !== " ") left--;
    let right = col;
    while (right + 1 < rowStr.length && rowStr[right + 1] !== " ") right++;
    return { col1: left, row1: row, col2: right, row2: row };
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** The fake addon for the panel-drag tests: mouse events flow through the
 * push stream callback and `content_size` reads the per-handle registry. */
const dragFakeAddon = {
  TuiRenderer: DragFakeTuiRenderer,
  NodeHandle: FakeStreamNodeHandle,
  create_node: (type: string) => new FakeStreamNodeHandle(type),
} as unknown as TernAddon;

Deno.test("StreamingText auto-scrolls to the tail, detaches on scroll-up, re-attaches via followTail", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const ternRoot = createRoot(renderer);
    const source = manualSpanSource();

    await act(() => {
      ternRoot.render(
        createElement(StreamingText, { stream: source.stream, clip_height: 2, width: 10 }),
      );
    });
    await act(() => {}); // mount effects; the pump parks on next()

    // Three newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    // One push per act: each act drains the pump's microtasks, so the pump
    // parks on a fresh next() before the next push is delivered.
    await act(() => {
      source.push({ text: "a\n" });
    });
    await act(() => {
      source.push({ text: "b\n" });
    });
    await act(() => {
      source.push({ text: "c\n" });
    });

    const node = renderer.root.children[0]!;
    if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
    if (!isStreamFollowing(node)) throw new Error("autoScroll must default to following");
    const y = (): number => node.props.scroll_y as number;
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);

    // Manual scroll up above the tail: the follow detaches and pins the view.
    scrollTo(node, 0, 0);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach");
    await act(() => {
      source.push({ text: "d\n" }); // 5 rows now — the view stays pinned
    });
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // followTail: re-attach and snap to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach");
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    await act(() => {
      source.push({ text: "e\n" });
    });
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
  }
});

Deno.test("StreamingText with autoScroll: false keeps the view pinned", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const ternRoot = createRoot(renderer);
    const source = manualSpanSource();

    await act(() => {
      ternRoot.render(
        createElement(StreamingText, { stream: source.stream, autoScroll: false, clip_height: 2, width: 10 }),
      );
    });
    await act(() => {});
    await act(() => {
      source.push({ text: "a\n" });
      source.push({ text: "b\n" });
      source.push({ text: "c\n" });
    });

    const node = renderer.root.children[0]!;
    if (isStreamFollowing(node)) throw new Error("autoScroll: false must not follow");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
  }
});

// ---------------------------------------------------------------------------
// StreamingText scroll-to-bottom affordance wiring
//
// A manual scroll above the tail detaches the follow and stamps a small `▼`
// indicator leaf at the clip region's bottom-right (the core
// `STREAM_AFFORDANCE_CHAR`); `followTail` (re-attach) and `scrollToBottom`
// (one-shot jump to the tail) dismiss it. The appear/dismiss mechanics live
// in @tern-tui/core — the framework layers surface the helpers so an app can
// wire the affordance's activation.
// ---------------------------------------------------------------------------

Deno.test("StreamingText stamps the scroll-to-bottom affordance on detach and dismisses on followTail/scrollToBottom", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const ternRoot = createRoot(renderer);
    const source = manualSpanSource();

    await act(() => {
      ternRoot.render(
        createElement(StreamingText, { stream: source.stream, clip_height: 2, width: 10 }),
      );
    });
    await act(() => {}); // mount effects; the pump parks on next()
    await act(() => {
      source.push({ text: "a\n" });
    });
    await act(() => {
      source.push({ text: "b\n" });
    });
    await act(() => {
      source.push({ text: "c\n" });
    });

    const node = renderer.root.children[0]!;
    // Fresh reads per assertion — TS property-access narrowing would reject a
    // later comparison against a different literal (see the core tests).
    const count = (): number => node.children.length;
    const y = (): number => node.props.scroll_y as number;
    if (!isStreamFollowing(node)) throw new Error("autoScroll must default to following");
    if (count() !== 0) throw new Error(`following children = ${count()}`);

    // Scroll above the tail: the follow detaches and the ▼ affordance is
    // stamped at the clip region's bottom-right.
    scrollTo(node, 0, 0);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach");
    if (count() !== 1) throw new Error(`affordance children = ${count()}`);
    const leaf = node.children[0]!;
    if (leaf.props.text !== STREAM_AFFORDANCE_CHAR) {
      throw new Error(`affordance text = ${JSON.stringify(leaf.props.text)}`);
    }
    if (leaf.props.position !== "absolute" || leaf.props.right !== 0) {
      throw new Error(`affordance position = ${JSON.stringify(leaf.props)}`);
    }

    // followTail: re-attach, snap back to the tail, and dismiss the
    // affordance.
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach");
    if (count() !== 0) throw new Error(`affordance after followTail = ${count()}`);

    // Detach again, let the stream grow while pinned, then dismiss via
    // scrollToBottom: a one-shot jump to the current tail (5 - 2 = 3).
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`re-shown children = ${count()}`);
    await act(() => {
      source.push({ text: "d\n" }); // 5 rows now — the view stays pinned
    });
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);
    const applied = scrollToBottom(node);
    if (applied.y !== 3) throw new Error(`scrollToBottom applied = ${JSON.stringify(applied)}`);
    if (count() !== 0) throw new Error(`affordance after scrollToBottom = ${count()}`);
    if (y() !== 3) throw new Error(`jump scroll_y = ${y()}`);

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
  }
});

// ---------------------------------------------------------------------------
// Panel drag-resize (usePanelMouseDrag)
//
// The hook subscribes to the renderer's mouse events; a `down_left` on the
// 1-cell gutter between adjacent panels starts a drag, each `drag_left`
// mutates the adjacent pane's `flex_basis` (clamped to the pane's min size)
// and re-renders, and `up_left` ends it. The tree mounts over the drag fake
// addon so `Node.contentSize()` reports the per-handle laid-out sizes.
// ---------------------------------------------------------------------------

/** A `usePanelMouseDrag` probe: renders `<Panels>` and hooks the drag wiring
 * onto the panels node. */
function DragProbe(props: {
  panelsRef: { current: Node | null };
  panels: Array<{ header: string; body: Node }>;
}): ReturnType<typeof createElement> {
  usePanelMouseDrag(props.panelsRef);
  return createElement(Panels, { ref: props.panelsRef, panels: props.panels, direction: "column" });
}

Deno.test("usePanelMouseDrag resizes a panels split on gutter drags and clamps to the pane min", async () => {
  setAddonForTesting(dragFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const ternRoot = createRoot(renderer);
    const panelsRef: { current: Node | null } = { current: null };

    await act(() => {
      ternRoot.render(
        createElement(DragProbe, {
          panelsRef,
          panels: [
            { header: "A", body: CoreBox() },
            { header: "B", body: CoreBox() },
          ],
        }),
      );
    });
    await act(() => {}); // flush the mount effect (mouse subscription)

    const panels = panelsRef.current;
    if (panels === null) throw new Error("ref must receive the panels node");
    // Laid-out sizes: panel A rows 0-2, gutter row 3, panel B rows 4-5,
    // stack 9 rows tall.
    fakeDragSizes.set(panels.handle, { width: 60, height: 9 });
    fakeDragSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
    fakeDragSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });

    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };

    // down_left on gutter 0, then drag down 1 cell: panel A's flex_basis 3 -> 4.
    emit("down_left", 0, 3);
    emit("drag_left", 0, 4);
    const panelA = panels.children[0]!;
    // Read through a function so TS control-flow narrowing does not pin the
    // prop to the literal of the first assertion.
    const basis = (): number => panelA.props.flex_basis as number;
    if (basis() !== 4) {
      throw new Error(`flex_basis after drag = ${basis()}`);
    }

    // Drag up far above the split: clamps to the pane min (1).
    emit("drag_left", 0, -20);
    if (basis() !== 1) {
      throw new Error(`min-clamped flex_basis = ${basis()}`);
    }

    // up_left ends the drag; a later drag_left is inert.
    emit("up_left", 0, -20);
    emit("drag_left", 0, 5);
    if (basis() !== 1) {
      throw new Error(`post-up drag flex_basis = ${basis()}`);
    }

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    fakeDragSizes.clear();
  }
});

// ---------------------------------------------------------------------------
// Roadmap host components
// ---------------------------------------------------------------------------

Deno.test("Input materializes with its text leaf and strips component props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Input, { value: "hi", caret: 1, placeholder: "type…", focusId: "f", onChange: () => {} }),
    );
  });

  const input = root.children[0];
  if (!input || input.type !== "input") throw new Error("expected an input node");
  if (input.props.value !== "hi" || input.props.caret !== 1) {
    throw new Error(`value/caret props = ${JSON.stringify(input.props)}`);
  }
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text") throw new Error("input must compose a text leaf");
  if (leaf.props.text !== "hi" || leaf.props.caret !== 1) {
    throw new Error(`leaf must carry value/caret: ${JSON.stringify(leaf.props)}`);
  }
  // Component-consumed props must never reach the scene node.
  for (const key of ["focusId", "focusManager", "onChange", "onSubmit"]) {
    if (key in input.props) throw new Error(`input component prop leaked: ${key}`);
  }
});

Deno.test("StatusBar materializes left/center/right segments as text children", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(createElement(StatusBar, { left: "L", center: "C", right: "R" }));
  });

  const bar = root.children[0];
  if (!bar || bar.type !== "status_bar") throw new Error("expected a status_bar node");
  const texts = bar.children.map((child) => child.props.text).join(",");
  if (texts !== "L,C,R") throw new Error(`segments = ${texts}`);
  if (bar.props.flex_direction !== "row" || bar.props.height !== 1) {
    throw new Error(`strip props = ${JSON.stringify(bar.props)}`);
  }
  // Segment keys are lifted out of the strip props by the core factory.
  for (const key of ["left", "center", "right"]) {
    if (key in bar.props) throw new Error(`segment key leaked: ${key}`);
  }
});

Deno.test("Panels materializes panel boxes with headers and honors collapsed", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const bodyA = CoreBox();
  const bodyB = CoreBox();

  await act(() => {
    ternRoot.render(
      createElement(Panels, {
        panels: [
          { header: "A", body: bodyA },
          { header: "B", body: bodyB, collapsed: true },
        ],
        active: 1,
      }),
    );
  });

  const panels = root.children[0];
  if (!panels || panels.type !== "panels") throw new Error("expected a panels node");
  if (panels.props.active !== 1) throw new Error(`active = ${panels.props.active}`);
  if (panels.children.length !== 2) throw new Error(`panels = ${panels.children.length}`);
  const panelA = panels.children[0]!;
  const panelB = panels.children[1]!;
  if (panelA.children[0]?.props.text !== "A") throw new Error("panel A header");
  if (panelA.children[1] !== bodyA) throw new Error("panel A body must be the given node");
  if (panelA.children.length !== 2) throw new Error("panel A must show header + body");
  if (panelB.children.length !== 1) throw new Error("collapsed panel B must hide its body");
  // The active panel's header is bold; the inactive one is not.
  if (panelB.children[0]?.props.bold !== true) throw new Error("active header must be bold");
  if (panelA.children[0]?.props.bold !== false) throw new Error("inactive header must not be bold");
  // The spec list is JS bookkeeping, never scene props.
  if ("panels" in panels.props) throw new Error("panels spec must not reach the scene props");
});

Deno.test("DiffView materializes per-hunk rows with gutter, markers, kind colors and scroll props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(DiffView, {
        hunks: [
          { kind: "ctx", old_line: 1, new_line: 1, text: "  fn main() {" },
          { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
          { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
        ],
        scroll_y: 3,
        wrap: false,
      }),
    );
  });

  const diff = root.children[0];
  if (!diff || diff.type !== "diff") throw new Error("expected a diff node");
  if (diff.props.scroll_y !== 3) throw new Error(`scroll_y = ${diff.props.scroll_y}`);
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
  if (diff.children.length !== 3) throw new Error(`rows = ${diff.children.length}`);

  const ctxRow = diff.children[0]!;
  const delRow = diff.children[1]!;
  const addRow = diff.children[2]!;
  // Gutter: right-aligned old/new line numbers (single-digit -> width 1).
  if (ctxRow.children[0]?.props.text !== "1 1") {
    throw new Error(`ctx gutter = ${JSON.stringify(ctxRow.children[0]?.props.text)}`);
  }
  if (delRow.children[0]?.props.text !== "2  ") {
    throw new Error(`del gutter = ${JSON.stringify(delRow.children[0]?.props.text)}`);
  }
  // Markers: space / '-' / '+'.
  if (ctxRow.children[1]?.props.text !== " " || delRow.children[1]?.props.text !== "-" ||
      addRow.children[1]?.props.text !== "+") {
    throw new Error("marker chars must be space/-/+ per kind");
  }
  // Kind colors: del red, add green, ctx dimmed.
  if (delRow.children[1]?.props.fg !== "#e06c75" || delRow.children[2]?.props.fg !== "#e06c75") {
    throw new Error(`del colors = ${JSON.stringify(delRow.children[1]?.props.fg)}`);
  }
  if (addRow.children[1]?.props.fg !== "#98c379" || addRow.children[2]?.props.fg !== "#98c379") {
    throw new Error(`add colors = ${JSON.stringify(addRow.children[1]?.props.fg)}`);
  }
  if (ctxRow.children[2]?.props.dim !== true) throw new Error("ctx content must be dimmed");
  // wrap passes through to the content leaves.
  for (const row of diff.children) {
    if (row.children[2]?.props.wrap !== false) {
      throw new Error("content leaves must carry wrap=false");
    }
  }
});

Deno.test("Spinner advances while mounted and clears its interval on unmount", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(createElement(Spinner, { interval: 5 }));
  });
  const spinner = root.children[0];
  if (!spinner || spinner.type !== "spinner") throw new Error("expected a spinner node");

  const text = () => spinner.props.text as string;
  const before = text();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const after = text();
  if (after === before) throw new Error("spinner must advance while mounted");

  await act(() => {
    ternRoot.unmount();
  });
  const frozen = text();
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (text() !== frozen) throw new Error("spinner interval must be cleared on unmount");
});

Deno.test("Spinner pauses ticks while unfocused and resumes on focus regain", async () => {
  const { renderer, root, renderCalls, focusHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(createElement(Spinner, { interval: 5 }));
  });
  const spinner = root.children[0];
  if (!spinner || spinner.type !== "spinner") throw new Error("expected a spinner node");
  // The effect must subscribe to renderer.onFocus alongside the interval.
  if (focusHandlers.size !== 1) {
    throw new Error(`expected 1 focus handler, got ${focusHandlers.size}`);
  }
  // The core `tick` stores the running frame counter on the node's props; it
  // is monotonic across ticks (the rendered glyph wraps), so it is the fake
  // tick counter for the test.
  const ticks = () => (typeof spinner.props.frame === "number" ? spinner.props.frame : 0);

  // Blur the terminal: ticks and repaints must freeze.
  for (const handler of focusHandlers) handler({ focus_gained: false });
  const ticksAtBlur = ticks();
  const rendersAtBlur = renderCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (ticks() !== ticksAtBlur) {
    throw new Error(`spinner must not tick while unfocused (${ticksAtBlur} -> ${ticks()})`);
  }
  if (renderCalls.length !== rendersAtBlur) {
    throw new Error(
      `render() must not run while unfocused (${rendersAtBlur} -> ${renderCalls.length})`,
    );
  }

  // Regain focus: ticks and repaints resume from where they froze.
  for (const handler of focusHandlers) handler({ focus_gained: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (ticks() === ticksAtBlur) {
    throw new Error("spinner must resume ticking after focus regain");
  }
  if (renderCalls.length <= rendersAtBlur) {
    throw new Error(
      `render() must resume after focus regain (${rendersAtBlur} -> ${renderCalls.length})`,
    );
  }

  // Unmount tears the focus subscription down with the interval.
  await act(() => {
    ternRoot.unmount();
  });
  if (focusHandlers.size >= 1) {
    throw new Error("focus subscription must be torn down on unmount");
  }
});

Deno.test("a focused Input receives routed keys and fires onChange/onSubmit", async () => {
  const { renderer, root, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const changes: Array<{ value: string; caret: number }> = [];
  const submits: Array<{ value: string; caret: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see), which
  // would flag the `!== 2` comparisons below as unintentional.
  const changeCount = () => changes.length;
  const submitCount = () => submits.length;

  function App() {
    // The tree-level key subscription routes each key through the manager
    // before falling back to its own (no-op) handler.
    useInput(() => {}, { focusManager: manager });
    return createElement(Input, {
      focusId: "main",
      focusManager: manager,
      onChange: (state) => changes.push(state),
      onSubmit: (state) => submits.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("main")) throw new Error("input must register under focusId");
  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  if (changeCount() !== 0) throw new Error("unfocused input must not receive keys");

  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (changeCount() !== 2) throw new Error(`onChange count = ${changeCount()}`);
  if (changes[0]!.value !== "a" || changes[1]!.value !== "ab") {
    throw new Error(`onChange values = ${changes.map((c) => c.value).join(",")}`);
  }
  if (changes[1]!.caret !== 2) throw new Error(`caret = ${changes[1]!.caret}`);

  // The routed edits land on the scene node itself.
  const input = root.children[0]!;
  if (input.props.value !== "ab" || input.props.caret !== 2) {
    throw new Error(`node edited = ${input.props.value}/${input.props.caret}`);
  }

  // Enter routes to onSubmit with the current value.
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (submitCount() !== 1 || submits[0]!.value !== "ab") {
    throw new Error(`onSubmit = ${JSON.stringify(submits)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("main")) throw new Error("input must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("a focused Textarea receives routed keys and fires onChange/onSubmit", async () => {
  const { renderer, root, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const changes: Array<{ lines: string[]; row: number; col: number }> = [];
  const submits: Array<{ lines: string[]; row: number; col: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const submitCount = () => submits.length;

  function App() {
    // The tree-level key subscription routes each key through the manager
    // before falling back to its own (no-op) handler.
    useInput(() => {}, { focusManager: manager });
    return createElement(Textarea, {
      lines: ["hi"],
      focusId: "main",
      focusManager: manager,
      onChange: (state) => changes.push(state),
      onSubmit: (state) => submits.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("main")) throw new Error("textarea must register under focusId");
  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  if (changeCount() !== 0) throw new Error("unfocused textarea must not receive keys");

  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (changeCount() !== 2) throw new Error(`onChange count = ${changeCount()}`);
  // The caret starts at col 0 (no col prop), so chars insert at the head.
  if (changes[0]!.lines.join(",") !== "ahi" || changes[1]!.lines.join(",") !== "abhi") {
    throw new Error(`onChange lines = ${changes.map((c) => c.lines.join("")).join(",")}`);
  }
  if (changes[1]!.col !== 2) throw new Error(`col = ${changes[1]!.col}`);

  // The routed edits land on the scene node itself (one leaf per line).
  const textarea = root.children[0]!;
  if ((textarea.props as { lines?: string[] }).lines?.join(",") !== "abhi") {
    throw new Error(`node lines = ${JSON.stringify(textarea.props)}`);
  }
  if (textarea.children.length !== 1 || textarea.children[0]?.props.text !== "abhi") {
    throw new Error(`node leaves = ${textarea.children.map((c) => c.props.text).join(",")}`);
  }

  // Enter splits the line AND routes to onSubmit (the Input mirror).
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (submitCount() !== 1 || submits[0]!.lines.join(",") !== "ab,hi") {
    throw new Error(`onSubmit = ${JSON.stringify(submits)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("main")) throw new Error("textarea must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Select materializes with filter and option rows and strips component props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Select, {
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        focusId: "s",
        onChange: () => {},
        onConfirm: () => {},
        onDismiss: () => {},
      }),
    );
  });

  const select = root.children[0];
  if (!select || select.type !== "select") throw new Error("expected a select node");
  // Component-consumed props must never reach the scene node.
  for (const key of ["focusId", "focusManager", "onChange", "onConfirm", "onDismiss"]) {
    if (key in select.props) throw new Error(`select component prop leaked: ${key}`);
  }
  // The option list is JS bookkeeping, never scene props.
  if ("options" in select.props) throw new Error("options must not reach the scene props");
  // Filter row + 2 option rows.
  if (select.children.length !== 3) throw new Error(`rows = ${select.children.length}`);
  if (select.children[0]?.props.text !== "filter…") throw new Error("filter row");
  if (select.children[1]?.props.text !== "A" || select.children[2]?.props.text !== "B") {
    throw new Error(`rows = ${select.children.map((c) => c.props.text).join(",")}`);
  }
});

Deno.test("Table materializes with a sticky header and rows; tableKey drives the highlight", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Table, {
        columns: [
          { key: "name", header: "Name", width: 10 },
          { key: "score", header: "Score", width: 5, align: "right" },
        ],
        rows: [
          ["Ada", 92],
          ["Grace", 88],
          ["Linus", 95],
          ["Alan", 84],
        ],
        highlight: 1,
        clip_height: 2,
      }),
    );
  });

  const table = root.children[0];
  if (!table || table.type !== "table") throw new Error("expected a table node");
  // Accessor: tableKey mutates the node in place, which TS's control flow
  // cannot see — reading through a function defeats the stale narrowing.
  const highlightOf = () => table.props.highlight as number | undefined;
  if (highlightOf() !== 1) throw new Error(`highlight = ${highlightOf()}`);
  // The model is JS bookkeeping, never scene props.
  if ("columns" in table.props || "rows" in table.props) {
    throw new Error("columns/rows must not reach the scene props");
  }
  // Sticky structure: header row + content region.
  const header = table.children[0];
  const region = table.children[1];
  if (header?.props.flex_direction !== "row" || header?.props.z_index !== 1) {
    throw new Error("the sticky header must be a row box above the content");
  }
  if (header?.children.length !== 2 || header?.children[0]?.props.text !== "Name".padEnd(10)) {
    throw new Error("the header row lays out padded header cells");
  }
  // The content region is windowed: only the visible rows are materialized
  // (clip_height 2 at scroll 0), not one node per data row.
  if (region === undefined || region.children.length !== 2) {
    throw new Error(`rows = ${region?.children.length}`);
  }
  // The highlighted row (index 1) is reversed; the others are not.
  if (region.children[1]?.children.every((cell) => cell.props.reversed === true) !== true) {
    throw new Error("the highlighted row's cells must be reversed");
  }
  if (region.children[0]?.children.some((cell) => cell.props.reversed === true)) {
    throw new Error("only the highlighted row may be reversed");
  }
  // tableKey moves the highlight and auto-scrolls the 2-row viewport.
  const key = { name: "down", ctrl: false, alt: false, shift: false } as const;
  let state = tableKey(table, key); // highlight 2 -> scroll_y 1
  state = tableKey(table, key); // highlight 3 -> scroll_y 2 (clamped at max)
  if (state.highlight !== 3 || state.scroll_y !== 2) {
    throw new Error(`tableKey state = ${JSON.stringify(state)}`);
  }
  if (highlightOf() !== 3) throw new Error(`node highlight = ${highlightOf()}`);
  // tableKey rebuilds the composition, so re-read the live content region.
  const liveRegion = table.children[1];
  if (liveRegion?.props.scroll_y !== 2) throw new Error(`region scroll_y = ${liveRegion?.props.scroll_y}`);
  if (visibleTableRows(table).length !== 2) throw new Error(`visible = ${visibleTableRows(table).length}`);
  if (visibleTableRows(table)[0]?.[0] !== "Linus") {
    throw new Error(`visible window = ${JSON.stringify(visibleTableRows(table).map((r) => r[0]))}`);
  }
});

Deno.test("a focused Select receives routed keys: filter narrows and enter confirms", async () => {
  const { renderer, root, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const changes: Array<{ filter: string; highlighted: number }> = [];
  const confirms: Array<{ value: string | string[] }> = [];
  const dismisses: Array<{ open: boolean }> = [];
  // Length read through functions: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const confirmCount = () => confirms.length;
  const dismissCount = () => dismisses.length;

  function App() {
    // The tree-level key subscription routes each key through the manager
    // before falling back to its own (no-op) handler.
    useInput(() => {}, { focusManager: manager });
    return createElement(Select, {
      options: [
        { value: "apple", label: "Apple" },
        { value: "banana", label: "Banana" },
      ],
      focusId: "sel",
      focusManager: manager,
      onChange: (state) => changes.push(state),
      onConfirm: (state) => confirms.push(state),
      onDismiss: (state) => dismisses.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("sel")) throw new Error("select must register under focusId");
  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (changeCount() !== 0) throw new Error("unfocused select must not receive keys");

  // Focused: the typeahead filter narrows the visible rows on the scene node.
  if (!manager.focus("sel")) throw new Error("focus(sel) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  const select = root.children[0]!;
  if (select.children.length !== 2) throw new Error(`rows after filter = ${select.children.length}`);
  if (select.children[1]?.props.text !== "Banana") {
    throw new Error(`visible = ${select.children[1]?.props.text}`);
  }
  if (changeCount() !== 1 || changes[0]!.filter !== "b") {
    throw new Error(`onChange = ${JSON.stringify(changes)}`);
  }

  // Enter confirms the highlighted (filtered) option and dismisses.
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (confirmCount() !== 1 || confirms[0]!.value !== "banana") {
    throw new Error(`onConfirm = ${JSON.stringify(confirms)}`);
  }
  if (select.props.value !== "banana") throw new Error(`node value = ${select.props.value}`);
  if (select.props.open !== false) throw new Error("enter must dismiss the dropdown");
  if (dismissCount() !== 0) throw new Error("enter must not fire onDismiss");

  // Escape fires onDismiss.
  for (const handler of keyHandlers) handler(keyEvent({ name: "escape" }));
  if (dismissCount() !== 1 || dismisses[0]!.open !== false) {
    throw new Error(`onDismiss = ${JSON.stringify(dismisses)}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("sel")) throw new Error("select must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Select multi mode toggles a checkmark through routed keys", async () => {
  const { renderer, root, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const rowText = () => root.children[0]?.children[1]?.props.text;
  const summaryText = () => root.children[0]?.children[3]?.props.text;

  function App() {
    useInput(() => {}, { focusManager: manager });
    return createElement(Select, {
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      multi: true,
      focusId: "multi",
      focusManager: manager,
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.focus("multi")) throw new Error("focus(multi) must succeed");
  // Space checks the highlighted (first) option; space again unchecks it.
  for (const handler of keyHandlers) handler(keyEvent({ char: " " }));
  if (rowText() !== "✓ A") throw new Error(`row = ${rowText()}`);
  if (summaryText() !== "1 selected") throw new Error(`summary = ${summaryText()}`);
  for (const handler of keyHandlers) handler(keyEvent({ char: " " }));
  if (rowText() !== "  A") throw new Error(`row = ${rowText()}`);
  if (summaryText() !== "0 selected") throw new Error(`summary = ${summaryText()}`);

  await act(() => {
    ternRoot.unmount();
  });
});

Deno.test("Select floating mode sets a z_index prop", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Select, {
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        floating: true,
      }),
    );
  });

  const select = root.children[0];
  if (!select || select.type !== "select") throw new Error("expected a select node");
  if (select.props.z_index !== 0) throw new Error(`z_index = ${select.props.z_index}`);
  if ("floating" in select.props) throw new Error("floating must not reach the scene props");
});

Deno.test("Menu materializes with item rows and strips component props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(Menu, {
        items: [
          { label: "New" },
          { label: "Open", children: [{ label: "File" }, { label: "Dir" }] },
          { label: "Quit" },
        ],
        focusId: "m",
        onSelect: () => {},
        onDismiss: () => {},
      }),
    );
  });

  const menu = root.children[0];
  if (!menu || menu.type !== "menu") throw new Error("expected a menu node");
  // Component-consumed props must never reach the scene node.
  for (const key of ["focusId", "focusManager", "onSelect", "onDismiss"]) {
    if (key in menu.props) throw new Error(`menu component prop leaked: ${key}`);
  }
  // The item model is JS bookkeeping, never scene props.
  if ("items" in menu.props) throw new Error("items must not reach the scene props");
  // One text leaf per visible item (the submenu branch is collapsed).
  if (menu.children.length !== 3) throw new Error(`rows = ${menu.children.length}`);
  if (menu.children[0]?.props.text !== "New" || menu.children[1]?.props.text !== "Open") {
    throw new Error(`rows = ${menu.children.map((c) => c.props.text).join(",")}`);
  }
  if (menu.children[2]?.props.text !== "Quit") {
    throw new Error(`rows = ${menu.children.map((c) => c.props.text).join(",")}`);
  }
  // The highlighted (first) row is reversed; the others are not.
  if (menu.children[0]?.props.reversed !== true) {
    throw new Error("the highlighted row must be reversed");
  }
  if (menu.children[1]?.props.reversed === true || menu.children[2]?.props.reversed === true) {
    throw new Error("only the highlighted row may be reversed");
  }
});

Deno.test("a focused Menu receives routed keys: down moves the highlight, enter selects, escape dismisses", async () => {
  const { renderer, root, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const selects: Array<{ activated: string | null; open: boolean }> = [];
  const dismisses: Array<{ open: boolean }> = [];
  // Length read through functions: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const selectCount = () => selects.length;
  const dismissCount = () => dismisses.length;

  function App() {
    // The tree-level key subscription routes each key through the manager
    // before falling back to its own (no-op) handler.
    useInput(() => {}, { focusManager: manager });
    return createElement(Menu, {
      items: [
        { label: "New", id: "new" },
        { label: "Open", id: "open", children: [{ label: "File", id: "file" }] },
        { label: "Quit", id: "quit" },
      ],
      focusId: "menu",
      focusManager: manager,
      onSelect: (state) => selects.push(state),
      onDismiss: (state) => dismisses.push(state),
    });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.has("menu")) throw new Error("menu must register under focusId");
  const menu = root.children[0]!;
  // Accessors: menuKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const highlightOf = () => menu.props.highlighted as number;

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 0 || selectCount() !== 0) {
    throw new Error("unfocused menu must not receive keys");
  }

  // Focused: down moves the highlight (clamped into the visible items).
  if (!manager.focus("menu")) throw new Error("focus(menu) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 1) throw new Error(`highlight = ${highlightOf()}`);
  // The moved highlight is stamped on the rebuilt rows.
  if (menu.children[1]?.props.reversed !== true) {
    throw new Error("the highlighted row must be reversed after down");
  }

  // Down again onto the leaf row, then Enter activates it and fires
  // onSelect with the item's key.
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 2) throw new Error(`highlight = ${highlightOf()}`);
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (selectCount() !== 1 || selects[0]!.activated !== "quit") {
    throw new Error(`onSelect = ${JSON.stringify(selects)}`);
  }
  if (selects[0]!.open !== false) throw new Error("a leaf activation must dismiss the menu");

  // Escape fires onDismiss without a selection.
  for (const handler of keyHandlers) handler(keyEvent({ name: "escape" }));
  if (dismissCount() !== 1 || dismisses[0]!.open !== false) {
    throw new Error(`onDismiss = ${JSON.stringify(dismisses)}`);
  }
  if (selectCount() !== 1) throw new Error("escape must not fire onSelect");

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("menu")) throw new Error("menu must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Menu mouse hover/click drive menuHover/menuClick while open; a closed menu ignores them", async () => {
  const { renderer, root, mouseHandlers, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const selects: Array<{ activated: string | null }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const selectCount = () => selects.length;

  await act(() => {
    ternRoot.render(
      createElement(Menu, {
        items: [
          { label: "New", id: "new" },
          { label: "Open", id: "open", children: [{ label: "File", id: "file" }] },
          { label: "Quit", id: "quit" },
        ],
        open: true,
        onSelect: (state) => selects.push(state),
      }),
    );
  });
  await act(() => {}); // flush the mount effect (mouse subscription)

  const menu = root.children[0]!;
  const highlightOf = () => menu.props.highlighted as number;
  const emit = (kind: string, column: number, row: number): void => {
    for (const handler of mouseHandlers) handler(mouseEvent(kind, column, row));
  };

  // A hover on row 2 moves the highlight there (menuHover).
  emit("moved", 0, 2);
  if (highlightOf() !== 2) throw new Error(`hover highlight = ${highlightOf()}`);

  // Hovering a branch row moves the highlight back without opening it.
  emit("moved", 0, 1);
  if (highlightOf() !== 1) throw new Error(`branch hover = ${highlightOf()}`);

  // A click on a branch opens its submenu — the inline rows grow to include
  // the child (and no leaf activates).
  emit("down_left", 0, 1);
  if (selectCount() !== 0) throw new Error("a branch click must not activate");
  if (menu.children.length !== 4) throw new Error(`rows after branch click = ${menu.children.length}`);
  if (menu.children[2]?.props.text !== "  File") {
    throw new Error(`child row = ${menu.children[2]?.props.text}`);
  }

  // A click on the now-visible leaf activates it and fires onSelect; the
  // click repaints the scene.
  const before = renderCalls.length;
  emit("down_left", 0, 3);
  if (selectCount() !== 1 || selects[0]!.activated !== "quit") {
    throw new Error(`click onSelect = ${JSON.stringify(selects)}`);
  }
  if (renderCalls.length <= before) throw new Error("a click must repaint the scene");

  // A closed menu ignores both hover and click: the leaf activation
  // dismissed the menu, so the highlight stays put and no callback fires.
  const closedHighlight = () => menu.props.highlighted as number;
  const closedSelects = selectCount();
  const closedRenders = renderCalls.length;
  emit("moved", 0, 99);
  emit("down_left", 0, 99);
  if (closedHighlight() !== 3) throw new Error("a closed menu must ignore hover");
  if (selectCount() !== closedSelects) throw new Error("a closed menu must ignore clicks");
  if (renderCalls.length !== closedRenders) {
    throw new Error("a closed menu must not repaint");
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (mouseHandlers.size !== 0) throw new Error("the mouse subscription must detach on unmount");
});

Deno.test("Modal host materializes an overlay and strips the content prop", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const body = CoreBox();

  await act(() => {
    ternRoot.render(createElement(Modal, { open: true, content: [body] }));
  });

  const modal = root.children[0];
  if (!modal || modal.type !== "modal") throw new Error("expected a modal node");
  if (modal.props.z_index !== MODAL_Z_INDEX) throw new Error(`z_index = ${modal.props.z_index}`);
  if (modal.props.open !== true) throw new Error(`open = ${modal.props.open}`);
  // The content node list is JS bookkeeping, never a scene prop.
  if ("content" in modal.props) throw new Error("content must not reach the scene props");
  // Composition: backdrop fill + a centered content box holding the content.
  if (modal.children.length !== 2) throw new Error(`children = ${modal.children.length}`);
  if (modal.children[0]?.props.position !== "absolute") {
    throw new Error("backdrop must be an absolute fill");
  }
  if (modal.children[1]?.children[0] !== body) {
    throw new Error("content must live inside the content box");
  }
});

Deno.test("Modal host: openModal moves focus into the overlay and closeModal restores it", async () => {
  const { renderer } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const modalRef: { current: Node | null } = { current: null };
  // A dedicated manager isolates the test from the shared focusManager (and
  // its cross-test registrations): the overlay's focusable registers first,
  // so openModal's focusFirst() lands inside; the outside focusable is the
  // prior focus that closing restores.
  const manager = new FocusManager();
  const insideBody = CoreBox();
  const outsideBody = CoreBox();
  const insideHandle = coreUseFocus("modal-in", insideBody, () => {}, manager);
  const outsideHandle = coreUseFocus("modal-out", outsideBody, () => {}, manager);
  const activeId = (): string | null => manager.activeId;

  function App() {
    return createElement(Modal, { ref: modalRef, open: false, content: [insideBody] });
  }

  try {
    await act(() => {
      ternRoot.render(createElement(App));
    });

    const modal = modalRef.current;
    if (modal === null) throw new Error("ref must receive the modal node");
    if (modal.type !== "modal") throw new Error(`type = ${modal.type}`);
    // Fresh reads per assertion — TS narrows a const-typed property access to
    // its first-checked literal (openModal/closeModal mutate the node's props).
    const open = (): unknown => modal.props.open;
    const hidden = (): unknown => modal.props.hidden;
    if (open() !== false || hidden() !== true) {
      throw new Error("modal must start hidden (open: false)");
    }

    manager.focus("modal-out");
    openModal(modal, manager);
    if (activeId() !== "modal-in") {
      throw new Error(`open must focus the overlay's focusable, got ${activeId()}`);
    }
    if (open() !== true || hidden() !== false) {
      throw new Error("openModal must show the overlay");
    }

    closeModal(modal, manager);
    if (activeId() !== "modal-out") {
      throw new Error(`close must restore the prior focus, got ${activeId()}`);
    }
    if (open() !== false || hidden() !== true) {
      throw new Error("closeModal must hide the overlay");
    }

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    insideHandle.dispose();
    outsideHandle.dispose();
    manager.blur();
  }
});

Deno.test("ScrollView materializes with region props, children and a scrollbar leaf", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(
        ScrollView,
        { clip_x: 1, clip_y: 2, clip_width: 10, clip_height: 4, scroll_y: 2, showScrollbar: true },
        createElement(Text, { text: "content" }),
      ),
    );
  });

  const view = root.children[0];
  if (!view || view.type !== "scroll_view") throw new Error("expected a scroll_view node");
  if (view.props.clip_x !== 1 || view.props.clip_y !== 2) {
    throw new Error(`clip origin = ${JSON.stringify(view.props)}`);
  }
  if (view.props.clip_width !== 10 || view.props.clip_height !== 4) {
    throw new Error(`clip size = ${JSON.stringify(view.props)}`);
  }
  if (view.props.scroll_y !== 2) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  // The scrollbar leaf is composed at factory time; the React content child
  // is appended after it (the leaf is absolutely positioned, so the paint
  // order is unaffected).
  const content = view.children.find((child) => child.props.text === "content");
  if (content === undefined) throw new Error("content child must mount under the view");
  const leaf = view.children[0];
  if (leaf === undefined || leaf.type !== "text" || leaf.props.position !== "absolute") {
    throw new Error("scrollbar leaf must be composed");
  }
  // `showScrollbar` is consumed by the factory — never a scene prop.
  if ("showScrollbar" in view.props) throw new Error("showScrollbar leaked into scene props");
});

Deno.test("ScrollView re-render updates scroll props and keeps the scrollbar leaf", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const el = (y: number) =>
    createElement(
      ScrollView,
      { scroll_y: y, showScrollbar: true },
      createElement(Text, { text: "c" }),
    );

  await act(() => {
    ternRoot.render(el(1));
  });
  const view = root.children[0]!;
  const firstLeaf = view.children[0];

  await act(() => {
    ternRoot.render(el(3));
  });
  if (view.props.scroll_y !== 3) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  if (view.children[0] !== firstLeaf) throw new Error("scrollbar leaf must survive re-render");
});

Deno.test("ScrollView resolves the scroll_view component preset from the theme", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(
        ThemeProvider,
        { theme: { components: { scroll_view: { fg: "#eeeeee", bg: "#111111" } } } },
        createElement(ScrollView, { scroll_y: 1 }),
      ),
    );
  });

  const view = root.children[0]!;
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.fg !== "#eeeeee" || view.props.bg !== "#111111") {
    throw new Error(`stamped region box = ${JSON.stringify(view.props)}`);
  }
  if (view.props.scroll_y !== 1) throw new Error(`scroll_y = ${view.props.scroll_y}`);
});

Deno.test("useFocus registers a ref'd element and routes routed keys to it", async () => {
  const { renderer, keyHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const hits: KeyEvent[] = [];
  const nodeRef: { current: Node | null } = { current: null };

  function App() {
    useInput(() => {}, { focusManager: manager });
    useFocus("probe", nodeRef, (event) => hits.push(event), { manager });
    return createElement(Box, { ref: nodeRef });
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (nodeRef.current === null) throw new Error("ref must receive the scene node");
  if (!manager.has("probe")) throw new Error("useFocus must register the id");
  if (!manager.focus("probe")) throw new Error("focus(probe) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "x" }));
  if (hits.length !== 1 || hits[0]!.char !== "x") {
    throw new Error(`routed hits = ${hits.length}`);
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (manager.has("probe")) throw new Error("useFocus must dispose on unmount");
});

Deno.test("useFocusManager returns the context manager or the core default", async () => {
  const { renderer } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const captured: { manager: FocusManager | null } = { manager: null };

  function DefaultProbe() {
    captured.manager = useFocusManager();
    return createElement(Text, { text: "d" });
  }
  await act(() => {
    ternRoot.render(createElement(DefaultProbe));
  });
  if (captured.manager !== focusManager) {
    throw new Error("useFocusManager must default to the core focusManager");
  }

  const custom = new FocusManager();
  function CustomProbe() {
    captured.manager = useFocusManager();
    return createElement(Text, { text: "c" });
  }
  await act(() => {
    ternRoot.render(
      createElement(
        FocusManagerContext.Provider,
        { value: custom },
        createElement(CustomProbe),
      ),
    );
  });
  if (captured.manager !== custom) {
    throw new Error("useFocusManager must return the provider's manager");
  }
});

Deno.test("useFocusTraversal moves focus forward on tab and backward on backtab with wrap", async () => {
  const { renderer, keyHandlers, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const refA: { current: Node | null } = { current: null };
  const refB: { current: Node | null } = { current: null };
  const refC: { current: Node | null } = { current: null };

  function App() {
    useFocusTraversal({ manager });
    useFocus("a", refA, () => {}, { manager });
    useFocus("b", refB, () => {}, { manager });
    useFocus("c", refC, () => {}, { manager });
    return createElement(
      Box,
      null,
      createElement(Box, { ref: refA }),
      createElement(Box, { ref: refB }),
      createElement(Box, { ref: refC }),
    );
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (manager.activeId !== null) throw new Error("nothing must be focused initially");
  // The mount already painted (prepareForCommit + resetAfterCommit); traversal
  // must add exactly one render per key press on top of that baseline.
  const baseline = renderCalls.length;
  const tab = () => {
    for (const handler of keyHandlers) handler(keyEvent({ name: "tab", shift: false }));
  };
  const backtab = () => {
    for (const handler of keyHandlers) handler(keyEvent({ name: "backtab", shift: true }));
  };

  tab();
  if (manager.activeId !== "a") {
    throw new Error(`tab with nothing focused must focus the first, got ${manager.activeId}`);
  }
  tab();
  if (manager.activeId !== "b") throw new Error(`tab must move forward, got ${manager.activeId}`);
  tab();
  if (manager.activeId !== "c") throw new Error(`tab must reach the last, got ${manager.activeId}`);
  tab();
  if (manager.activeId !== "a") throw new Error(`tab must wrap to the first, got ${manager.activeId}`);
  backtab();
  if (manager.activeId !== "c") {
    throw new Error(`backtab must wrap to the last, got ${manager.activeId}`);
  }
  backtab();
  if (manager.activeId !== "b") {
    throw new Error(`backtab must move backward, got ${manager.activeId}`);
  }
  backtab();
  if (manager.activeId !== "a") throw new Error(`backtab must reach the first, got ${manager.activeId}`);
  if (renderCalls.length !== baseline + 7) {
    throw new Error(
      `each traversal must re-render once, renders = ${renderCalls.length} (baseline ${baseline})`,
    );
  }

  await act(() => {
    ternRoot.unmount();
  });
  if (keyHandlers.size >= 1) throw new Error("traversal must detach on unmount");
});

Deno.test("useFocusTraversal skips the excluded ids when moving", async () => {
  const { renderer, keyHandlers, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const refA: { current: Node | null } = { current: null };
  const refB: { current: Node | null } = { current: null };
  const refC: { current: Node | null } = { current: null };
  const refD: { current: Node | null } = { current: null };

  function App() {
    useFocusTraversal({ manager, exclude: ["b", "c"] });
    useFocus("a", refA, () => {}, { manager });
    useFocus("b", refB, () => {}, { manager });
    useFocus("c", refC, () => {}, { manager });
    useFocus("d", refD, () => {}, { manager });
    return createElement(
      Box,
      null,
      createElement(Box, { ref: refA }),
      createElement(Box, { ref: refB }),
      createElement(Box, { ref: refC }),
      createElement(Box, { ref: refD }),
    );
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.focus("a")) throw new Error("focus(a) must succeed");
  // The mount already painted; each successful traversal must add one render.
  const baseline = renderCalls.length;

  for (const handler of keyHandlers) handler(keyEvent({ name: "tab", shift: false }));
  const afterTab = manager.activeId;
  if (afterTab !== "d") {
    throw new Error(`tab must skip b and c, got ${afterTab}`);
  }

  for (const handler of keyHandlers) handler(keyEvent({ name: "backtab", shift: true }));
  const afterBacktab = manager.activeId;
  if (afterBacktab !== "a") {
    throw new Error(`backtab must skip c and b, got ${afterBacktab}`);
  }
  if (renderCalls.length !== baseline + 2) {
    throw new Error(
      `each traversal must re-render once, renders = ${renderCalls.length} (baseline ${baseline})`,
    );
  }
});

Deno.test("useFocusTraversal leaves focus unchanged when every id is excluded", async () => {
  const { renderer, keyHandlers, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const manager = new FocusManager();
  const refA: { current: Node | null } = { current: null };
  const refB: { current: Node | null } = { current: null };
  const refC: { current: Node | null } = { current: null };

  function App() {
    useFocusTraversal({ manager, exclude: ["a", "b", "c"] });
    useFocus("a", refA, () => {}, { manager });
    useFocus("b", refB, () => {}, { manager });
    useFocus("c", refC, () => {}, { manager });
    return createElement(
      Box,
      null,
      createElement(Box, { ref: refA }),
      createElement(Box, { ref: refB }),
      createElement(Box, { ref: refC }),
    );
  }

  await act(() => {
    ternRoot.render(createElement(App));
  });

  if (!manager.focus("a")) throw new Error("focus(a) must succeed");
  // The mount already painted; a fully-excluded traversal is a no-op and must
  // not add any render on top of that baseline.
  const baseline = renderCalls.length;

  for (const handler of keyHandlers) handler(keyEvent({ name: "tab", shift: false }));
  if (manager.activeId !== "a") {
    throw new Error(`fully-excluded tab must not move, got ${manager.activeId}`);
  }
  for (const handler of keyHandlers) handler(keyEvent({ name: "backtab", shift: true }));
  if (manager.activeId !== "a") {
    throw new Error(`fully-excluded backtab must not move, got ${manager.activeId}`);
  }
  if (renderCalls.length !== baseline) {
    throw new Error(
      `no-op traversal must not re-render, renders = ${renderCalls.length} (baseline ${baseline})`,
    );
  }
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

Deno.test("host components fall back to the default theme without a provider", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(createElement(Text, { text: "err", role: "danger" }));
  });

  const node = root.children[0]!;
  if (node.props.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`fallback fg = ${node.props.fg}`);
  }
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`fallback bg = ${node.props.bg}`);
  }
  // The semantic hints are consumed by the host component — never scene props.
  if ("role" in node.props || "component" in node.props) {
    throw new Error(`semantic hints leaked: ${JSON.stringify(node.props)}`);
  }
});

Deno.test("ThemeProvider partial theme merges over the default and stamps roles", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(
        ThemeProvider,
        { theme: { palette: { danger: { fg: "#ff0000" } } } },
        createElement(Text, { text: "err", role: "danger" }),
      ),
    );
  });

  const node = root.children[0]!;
  if (node.props.fg !== "#ff0000") throw new Error(`overridden fg = ${node.props.fg}`);
  // The un-overridden bg comes from the default theme (merged, not replaced).
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`merged bg = ${node.props.bg}`);
  }
});

Deno.test("ThemeProvider component presets stamp onto roadmap host components", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(() => {
    ternRoot.render(
      createElement(
        ThemeProvider,
        { theme: { components: { status_bar: { fg: "#eeeeee", bg: "#111111" } } } },
        createElement(StatusBar, { left: "L" }),
      ),
    );
  });

  const bar = root.children[0]!;
  if (bar.type !== "status_bar") throw new Error(`type = ${bar.type}`);
  if (bar.props.fg !== "#eeeeee" || bar.props.bg !== "#111111") {
    throw new Error(`stamped strip = ${JSON.stringify(bar.props)}`);
  }
  // The preset resolution must not disturb the element's composition.
  if (bar.children.length !== 1 || bar.children[0]?.props.text !== "L") {
    throw new Error(`segments = ${bar.children.map((c) => c.props.text).join(",")}`);
  }
});

Deno.test("a theme change re-resolves stamped props on re-render", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  function App(props: { theme: ThemeOverrides }) {
    return createElement(
      ThemeProvider,
      { theme: props.theme },
      createElement(Text, { text: "x", role: "danger" }),
    );
  }

  await act(() => {
    ternRoot.render(createElement(App, { theme: { palette: { danger: { fg: "#ff0000" } } } }));
  });
  const node = root.children[0]!;
  // Captured into a fresh local per assertion: TS narrows getter-only prop
  // accesses across calls (memory gotcha), which would flag the second
  // comparison as "no overlap".
  const first = node.props.fg;
  if (first !== "#ff0000") throw new Error(`first fg = ${first}`);

  await act(() => {
    ternRoot.render(createElement(App, { theme: { palette: { danger: { fg: "#00ff00" } } } }));
  });
  const second = node.props.fg;
  if (second !== "#00ff00") throw new Error(`re-resolved fg = ${second}`);
});

Deno.test("useTheme returns the provider theme and merges over the default", async () => {
  const { renderer } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const captured: { theme: Theme | null } = { theme: null };

  function Probe() {
    captured.theme = useTheme();
    return createElement(Text, { text: "p" });
  }

  await act(() => {
    ternRoot.render(
      createElement(
        ThemeProvider,
        { theme: { palette: { primary: { fg: "#123456", bg: "#000000" } } } },
        createElement(Probe),
      ),
    );
  });

  if (captured.theme === null) throw new Error("useTheme must return the theme");
  if (captured.theme.palette.primary.fg !== "#123456") {
    throw new Error(`primary fg = ${captured.theme.palette.primary.fg}`);
  }
  // Merged over the default: un-overridden roles are preserved.
  if (captured.theme.palette.danger.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`unoverridden role changed: ${captured.theme.palette.danger.fg}`);
  }
});

Deno.test("toNodeProps strips the semantic theme hints from scene props", () => {
  const out = toNodeProps({
    text: "x",
    role: "danger",
    component: "input",
  } as unknown as TernProps);
  if ("role" in out || "component" in out) {
    throw new Error(`theme hints leaked: ${JSON.stringify(out)}`);
  }
  if (out.text !== "x") throw new Error(`text = ${out.text}`);
});

// ---------------------------------------------------------------------------
// Mouse wheel scroll + click-to-focus (useWheelScroll / useClickToFocus)
//
// The hooks subscribe to the renderer's mouse events over the drag-test fake
// addon (mouse events flow through the push stream callback;
// `content_size` reads the per-handle registry): `useWheelScroll` maps wheel
// events onto the ref'd scroll view's offsets (clamped) and re-renders on a
// consumed wheel; `useClickToFocus` routes a `down_left` on a painted cell
// (the configurable `dragFakeHitPath`) to the topmost registered focusable
// via the `FocusManager`.
// ---------------------------------------------------------------------------

/** A `useWheelScroll` probe: renders a `<ScrollView>` and hooks the wheel
 * wiring onto its node. */
function WheelScrollProbe(props: { viewRef: { current: Node | null } }): ReturnType<typeof createElement> {
  useWheelScroll(props.viewRef);
  return createElement(
    ScrollView,
    { ref: props.viewRef, width: 5, height: 2 },
    createElement(Text, { text: "aaaaaa\nbbbbb\ncc" }),
  );
}

Deno.test("useWheelScroll maps wheel events onto the ref'd view and re-renders on a consumed wheel", async () => {
  setAddonForTesting(dragFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const ternRoot = createRoot(renderer);
    const viewRef: { current: Node | null } = { current: null };

    await act(() => {
      ternRoot.render(createElement(WheelScrollProbe, { viewRef }));
    });
    await act(() => {}); // flush the mount effect (mouse subscription)

    const view = viewRef.current;
    if (view === null || view.type !== "scroll_view") throw new Error("ref must receive the scroll view");
    // Viewport 5x2, content leaf 6x3 -> max offsets (1, 1).
    fakeDragSizes.set(view.handle, { width: 5, height: 2 });
    const leaf = view.children.find((child) => child.type === "text");
    if (leaf === undefined) throw new Error("scroll view must compose a content leaf");
    fakeDragSizes.set(leaf.handle, { width: 6, height: 3 });

    // The reconciler's commit phases call renderer.render(); reset the spy so
    // the assertions below count only the wheel wiring's re-renders.
    dragFakeRenders.length = 0;

    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };
    const y = (): number => view.props.scroll_y as number;

    emit("scroll_down", 0, 0);
    if (y() !== 1) throw new Error(`scroll_down scroll_y = ${y()}`);
    // Read through a function: TS control-flow narrowing would otherwise pin
    // the array length to the literal of the first assertion.
    const renderCount = (): number => dragFakeRenders.length;
    if (renderCount() !== 1) throw new Error(`a consumed wheel must re-render (renders = ${renderCount()})`);
    emit("scroll_down", 0, 0); // clamps at max 1, still consumed
    if (y() !== 1) throw new Error(`clamped scroll_y = ${y()}`);
    if (renderCount() !== 2) {
      throw new Error(`a wheel at the bound must stay consumed and re-render (renders = ${renderCount()})`);
    }
    emit("scroll_up", 0, 0);
    if (y() !== 0) throw new Error(`scroll_up scroll_y = ${y()}`);
    // A non-wheel event falls through: no scroll, no re-render.
    const rendersBefore = renderCount();
    emit("down_left", 0, 0);
    if (y() !== 0) throw new Error(`a down_left must not scroll (scroll_y = ${y()})`);
    if (renderCount() !== rendersBefore) {
      throw new Error("an unconsumed event must not re-render");
    }

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    dragFakeHitPath = [7n];
    dragFakeRenders.length = 0;
    fakeDragSizes.clear();
  }
});

/** A `useClickToFocus` probe: registers a focusable box and hooks the click
 * wiring onto the renderer from the tree context. */
function ClickFocusProbe(props: {
  boxRef: { current: Node | null };
  manager: FocusManager;
  focused: string[];
}): ReturnType<typeof createElement> {
  const { renderer } = useApp();
  useClickToFocus(renderer);
  useInput(() => {}, { focusManager: props.manager });
  useFocus("probe", props.boxRef, (event) => {
    if (event.name === "char") props.focused.push(event.char ?? "");
  }, { manager: props.manager });
  return createElement(Box, { ref: props.boxRef });
}

Deno.test("useClickToFocus focuses the topmost registered node on a down_left and no-ops on an empty hit_test", async () => {
  setAddonForTesting(dragFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const ternRoot = createRoot(renderer);
    const boxRef: { current: Node | null } = { current: null };
    // The hook routes through the core `focusManager` (its default), so the
    // probe registers on the same shared manager.
    const manager = focusManager;
    const focused: string[] = [];

    await act(() => {
      ternRoot.render(createElement(ClickFocusProbe, { boxRef, manager, focused }));
    });
    await act(() => {}); // flush the mount effects (registration + mouse subscription)

    if (!manager.has("probe")) throw new Error("useFocus must register the id");

    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };

    // A down_left on a painted cell (fake hit path non-empty) focuses the box.
    emit("down_left", 3, 2);
    if (manager.activeId !== "probe") throw new Error(`active after click = ${manager.activeId}`);

    // The focused element now routes keys: a char key reaches its handler.
    dispatchEvent({ type: "key", key: { name: "char", char: "x", ctrl: false, alt: false, shift: false } });
    if (focused.join("") !== "x") throw new Error(`focused chars = ${focused.join("")}`);

    // A press off any painted cell (empty hit path) is a no-op.
    dragFakeHitPath = [];
    manager.blur();
    emit("down_left", 0, 0);
    if (manager.activeId !== null) throw new Error(`active after empty hit = ${manager.activeId}`);

    await act(() => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    dragFakeHitPath = [7n];
    dragFakeRenders.length = 0;
    fakeDragSizes.clear();
    focusManager.blur();
    focusManager.unregister("probe");
  }
});

// ---------------------------------------------------------------------------
// Mouse selection (useSelection)
//
// The hook subscribes to the renderer's mouse events over the selection-aware
// drag-test fake (`set_selection` / `clear_selection` / `selection_text` /
// `selection_word_range` / `set_clipboard` record into the module-level
// `dragFakeSelection` / `lastSelectionClipboard`, and `render()` paints the
// `selectionFakeRows` frame the text/word reads draw from): a `down_left`
// anchors the selection and re-renders (paints the overlay), a `drag_left`
// extends it, and an `up_*` release copies the selected text
// (copy-on-release) and leaves the overlay up (persistent selection — the
// highlight survives until `escape` or a bare press outside it
// (click-elsewhere) clears it); a double-click (a second
// press on a nearby cell within SELECTION_DOUBLE_CLICK_MS ms) selects the
// word under the pointer instead; non-mouse events fall through; the
// subscription is torn down on unmount.
// ---------------------------------------------------------------------------

/** A `useSelection` probe: wires the selection state machine onto the
 * renderer from the tree context. */
function SelectionProbe(): ReturnType<typeof createElement> {
  useSelection();
  return createElement(Box);
}

/** Assert the drag-test fake's selection overlay equals `expected` (or is
 * `null` when the selection must be cleared). */
function assertDragSelection(
  actual: { col1: number; row1: number; col2: number; row2: number } | null,
  expected: { col1: number; row1: number; col2: number; row2: number } | null,
): void {
  if (expected === null) {
    if (actual !== null) throw new Error(`selection = ${JSON.stringify(actual)}, expected null`);
    return;
  }
  if (actual === null) throw new Error(`selection = null, expected ${JSON.stringify(expected)}`);
  if (actual.col1 !== expected.col1 || actual.row1 !== expected.row1 ||
      actual.col2 !== expected.col2 || actual.row2 !== expected.row2) {
    throw new Error(`selection = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

Deno.test("useSelection wires the core selection state machine (down/drag/up, copy-on-release, persistent overlay, double-click word select)", async () => {
  setAddonForTesting(dragFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const ternRoot = createRoot(renderer);

    await act(() => {
      ternRoot.render(createElement(SelectionProbe));
    });
    await act(() => {}); // flush the mount effect (mouse subscription)

    // The reconciler's commit phases call renderer.render(); reset the spy so
    // the assertions below count only the selection wiring's re-renders.
    dragFakeRenders.length = 0;
    if (SELECTION_DOUBLE_CLICK_MS !== 500) {
      throw new Error(`SELECTION_DOUBLE_CLICK_MS = ${SELECTION_DOUBLE_CLICK_MS}`);
    }

    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };
    const sel = (): { col1: number; row1: number; col2: number; row2: number } | null => dragFakeSelection;
    // Read through a function: TS control-flow narrowing would otherwise pin
    // the values to the literals of the first assertions.
    const clipboard = (): string | null => lastSelectionClipboard;
    const renderCount = (): number => dragFakeRenders.length;

    // A down_left anchors a 1-cell selection and re-renders (paints the
    // overlay at the next frame).
    emit("down_left", 6, 0);
    assertDragSelection(sel(), { col1: 6, row1: 0, col2: 6, row2: 0 });
    if (renderCount() !== 1) throw new Error(`a down must re-render (renders = ${renderCount()})`);

    // A drag_left extends the selection to the dragged cell.
    emit("drag_left", 10, 0);
    assertDragSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== 2) throw new Error(`a drag must re-render (renders = ${renderCount()})`);

    // An up_* release copies the selected text (copy-on-release) and ends
    // the session but leaves the overlay up (persistent selection): the
    // highlight survives until escape or a bare press outside it
    // (click-elsewhere) clears it.
    emit("up_left", 10, 0);
    if (clipboard() !== "world") throw new Error(`copy-on-release = ${JSON.stringify(clipboard())}`);
    assertDragSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== 3) throw new Error(`an up must re-render (renders = ${renderCount()})`);

    // A non-mouse event falls through: the persistent overlay is untouched
    // and nothing re-renders.
    const rendersBefore = renderCount();
    dispatchEvent({ type: "key", key: { name: "char", char: "q", ctrl: false, alt: false, shift: false } });
    assertDragSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== rendersBefore) throw new Error("a key event must not re-render");

    // `escape` is the explicit clear for the persistent selection: hosts
    // route the core `selectionKey` (ctrl+shift+c / escape) through
    // `useInput`. The escape is consumed and the overlay is gone.
    if (selectionKey(renderer, keyEvent({ name: "escape" })) !== true) {
      throw new Error("escape must be consumed");
    }
    assertDragSelection(sel(), null);

    // A double-click (a second press on a nearby cell within the window)
    // selects the word under the pointer instead of a 1-cell selection.
    setSelectionClockForTesting(() => 1000);
    emit("down_left", 6, 0); // 'w' of "world"
    emit("up_left", 6, 0);
    setSelectionClockForTesting(() => 1400); // +400 ms, inside the window
    emit("down_left", 6, 0);
    assertDragSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    emit("up_left", 6, 0);

    // A press two cells away is not a double-click even inside the window.
    setSelectionClockForTesting(() => 2000);
    emit("down_left", 6, 0);
    emit("up_left", 6, 0);
    setSelectionClockForTesting(() => 2300); // +300 ms, but 2 cells away
    emit("down_left", 8, 0);
    assertDragSelection(sel(), { col1: 8, row1: 0, col2: 8, row2: 0 });
    // The bare release of a press outside the overlay is click-elsewhere:
    // it deselects (no 1-cell residue, no old overlay).
    emit("up_left", 8, 0);
    assertDragSelection(sel(), null);

    // Unmount tears the subscription down: events no longer route.
    await act(() => {
      ternRoot.unmount();
    });
    const rendersAfterUnmount = renderCount();
    emit("down_left", 1, 0);
    assertDragSelection(sel(), null);
    if (renderCount() !== rendersAfterUnmount) {
      throw new Error(`a disposed subscription must not select (renders = ${renderCount()})`);
    }
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    dragFakeHitPath = [7n];
    dragFakeRenders.length = 0;
    dragFakeSelection = null;
    lastSelectionClipboard = null;
    fakeDragSizes.clear();
    setSelectionClockForTesting(() => Date.now());
  }
});
