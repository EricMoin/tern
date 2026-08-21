import {
  name,
  version,
  Box,
  Text,
  StreamingText,
  subscribeStream,
  Input,
  Textarea,
  Spinner,
  StatusBar,
  Panels,
  DiffView,
  ScrollView,
  Select,
  Menu,
  Table,
  Tabs,
  Progress,
  setProgress,
  Modal,
  MODAL_Z_INDEX,
  openModal,
  closeModal,
  selectKey,
  menuKey,
  subscribeInput,
  subscribeMenuMouse,
  subscribeResize,
  createTerminalDimensions,
  subscribeFocus,
  subscribeFocusTraversal,
  subscribePaste,
  subscribePanelDrag,
  subscribeWheelScroll,
  subscribeClickFocus,
  subscribeSelection,
  startSpinner,
  editKey,
  editTextareaKey,
  pasteInto,
  disposeTextareaFocus,
  tableKey,
  tick,
  tabsKey,
  activateTab,
  closeTab,
  disposeTabsFocus,
  Tree,
  treeKey,
  visibleTreeRows,
  expandTreeNode,
  disposeTreeFocus,
  disposeMenuFocus,
  useFocus,
  FocusManager,
  focusManager,
  collapsePanel,
  expandPanel,
  togglePanel,
  focusPanel,
  setTheme,
  getTheme,
  defaultTheme,
  followTail,
  isStreamFollowing,
  scrollTo,
  scrollToBottom,
  STREAM_AFFORDANCE_CHAR,
  visibleTableRows,
  type Span,
  type Node,
  type KeyEvent,
  type MenuState,
  type Renderer,
  type Theme,
  type TreeNode,
  renderer,
  rendererOptions,
  replaceNode,
  render,
  insert,
  spread,
  createElement,
  createTextNode,
  insertNode,
  setProp,
  mergeProps,
  effect,
  memo,
  createComponent,
  use,
} from "./index.ts";
import {
  Box as CoreBox,
  Text as CoreText,
  Input as CoreInput,
  Spinner as CoreSpinner,
  StatusBar as CoreStatusBar,
  Panels as CorePanels,
  DiffView as CoreDiffView,
  ScrollView as CoreScrollView,
  Table as CoreTable,
  Tabs as CoreTabs,
  Progress as CoreProgress,
  Modal as CoreModal,
  createRenderer,
  wheelScroll,
  SELECTION_DOUBLE_CLICK_MS,
  setSelectionClockForTesting,
  type MouseEventJs,
  type SelectionRange,
  type TernEventJs,
} from "@tern-tui/core";
import { setAddonForTesting } from "../../core/src/addon.ts";
import type { TernAddon } from "../../core/src/addon.ts";

// @deno-types="../../../node_modules/solid-js/types/index.d.ts"
import { createSignal } from "solid-js";

Deno.test("solid exports package metadata", () => {
  if (name !== "@tern-tui/solid") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.2.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("createElement maps box/text tags to tern nodes", () => {
  const box = createElement("box");
  if (box.type !== "box") {
    throw new Error(`expected box node, got type "${box.type}"`);
  }
  const text = createElement("text");
  if (text.type !== "text") {
    throw new Error(`expected text node, got type "${text.type}"`);
  }
});

Deno.test("createElement rejects unknown tags", () => {
  let threw = false;
  try {
    createElement("nope");
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("expected createElement to throw for an unknown tag");
  }
});

Deno.test("createTextNode produces a text node carrying the value", () => {
  const node = createTextNode("hello");
  if (node.type !== "text") {
    throw new Error(`expected text node, got type "${node.type}"`);
  }
  if (node.props.text !== "hello") {
    throw new Error(`unexpected text prop: ${JSON.stringify(node.props.text)}`);
  }
});

Deno.test("spread applies props through Node.setProps", () => {
  const node = createElement("box");
  spread(node, { border_style: "rounded", padding: 1 });
  if (node.props.border_style !== "rounded") {
    throw new Error(`unexpected border_style: ${node.props.border_style}`);
  }
  if (node.props.padding !== 1) {
    throw new Error(`unexpected padding: ${node.props.padding}`);
  }
});

Deno.test("renderer setProp funnels into Node.setProps", () => {
  const node = createElement("text");
  setProp(node, "text", "hi");
  if (node.props.text !== "hi") {
    throw new Error(`unexpected text prop: ${JSON.stringify(node.props.text)}`);
  }
});

Deno.test("Box/Text components create tern nodes through the renderer", () => {
  const box = Box();
  if (box.type !== "box") {
    throw new Error(`expected box node, got type "${box.type}"`);
  }
  const text = Text({ text: "hi" });
  if (text.type !== "text" || text.props.text !== "hi") {
    throw new Error("Text() must create a text node with the text prop");
  }
});

Deno.test("Box inserts static children via insertNode", () => {
  const box = Box({
    children: [Text({ text: "a" }), Text({ text: "b" })],
  });
  if (box.children.length !== 2) {
    throw new Error(`expected 2 children, got ${box.children.length}`);
  }
  if (box.children[0]?.type !== "text" || box.children[1]?.type !== "text") {
    throw new Error("Box children must be text nodes");
  }
});

Deno.test("renderer exposes the universal primitive surface", () => {
  const primitives = [
    render,
    insert,
    spread,
    createElement,
    createTextNode,
    insertNode,
    setProp,
    mergeProps,
    effect,
    memo,
    createComponent,
    use,
  ];
  for (const fn of primitives) {
    if (typeof fn !== "function") {
      throw new Error("expected a renderer primitive function, got " + typeof fn);
    }
  }
  if (typeof renderer.render !== "function") {
    throw new Error("renderer.render must be a function");
  }
});

Deno.test("replaceText re-points a text node's content", () => {
  const node = createTextNode("old");
  rendererOptions.replaceText(node, "new");
  if (node.props.text !== "new") {
    throw new Error(`unexpected text prop: ${JSON.stringify(node.props.text)}`);
  }
});

Deno.test("isTextNode distinguishes text nodes from boxes", () => {
  if (!rendererOptions.isTextNode(createTextNode("x"))) {
    throw new Error("isTextNode must return true for text nodes");
  }
  if (rendererOptions.isTextNode(createElement("box"))) {
    throw new Error("isTextNode must return false for box nodes");
  }
});

Deno.test("replaceNode swaps a node for its recorded in-parent sibling", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  const b = createTextNode("b");
  insertNode(parent, a);
  insertNode(parent, b);
  const aIndex = parent.children.indexOf(a);

  const c = createTextNode("c");
  replaceNode(c, a);

  if (rendererOptions.getParentNode(c) !== parent) {
    throw new Error("replacement must be registered under the replaced node's parent");
  }
  if (rendererOptions.getParentNode(a) !== undefined) {
    throw new Error("replaced node's parent registry entry must be cleared");
  }
  // `c` is inserted immediately before `a` (the anchor), so it lands at
  // `a`'s former index; `a` is then spliced out by `Node.remove()`, leaving
  // `c` in exactly `a`'s old slot.
  const children = parent.children;
  if (children.indexOf(c) !== aIndex) {
    throw new Error("replacement must land at the replaced node's index");
  }
});

Deno.test("replaceNode is a no-op without a recorded parent", () => {
  const orphan = createTextNode("orphan");
  const repl = createTextNode("repl");
  replaceNode(repl, orphan);
  if (rendererOptions.getParentNode(repl) !== undefined) {
    throw new Error("no-parent replaceNode must not register a parent");
  }
  if (rendererOptions.getParentNode(orphan) !== undefined) {
    throw new Error("no-parent replaceNode must not touch the orphan");
  }
});

Deno.test("replaceNode self-replacement is a no-op", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  insertNode(parent, a);
  replaceNode(a, a);
  if (rendererOptions.getParentNode(a) !== parent) {
    throw new Error("self-replace must keep the node's parent registration");
  }
});

Deno.test("insertNode before a sibling reflects the anchor order in parent.children", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  const b = createTextNode("b");
  rendererOptions.insertNode(parent, a);
  rendererOptions.insertNode(parent, b);

  const x = createTextNode("x");
  rendererOptions.insertNode(parent, x, b);

  const children = parent.children;
  if (children.length !== 3 || children[0] !== a || children[1] !== x || children[2] !== b) {
    throw new Error("anchor insertion must place the node immediately before the anchor");
  }

  // No anchor -> append.
  const y = createTextNode("y");
  rendererOptions.insertNode(parent, y);
  const after = parent.children;
  if (after.length !== 4 || after[3] !== y) {
    throw new Error("insertNode without an anchor must append to the end");
  }
});

Deno.test("replaceNode places the new node at the replaced node's index", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  const b = createTextNode("b");
  const c = createTextNode("c");
  rendererOptions.insertNode(parent, a);
  rendererOptions.insertNode(parent, b);
  rendererOptions.insertNode(parent, c);
  const bIndex = parent.children.indexOf(b);

  const x = createTextNode("x");
  replaceNode(x, b);

  const children = parent.children;
  // `x` is spliced in at `b`'s index (insert-before-anchor), so it occupies
  // exactly the replaced node's slot in parent.children.
  if (children.indexOf(x) !== bIndex) {
    throw new Error(
      `replacement must be at the replaced node's index ${bIndex}, got ${children.indexOf(x)}`,
    );
  }
  if (children[bIndex] !== x || children[bIndex - 1] !== a) {
    throw new Error("replacement must sit exactly where the replaced node was");
  }
  if (rendererOptions.getParentNode(x) !== parent) {
    throw new Error("replacement must be registered under the parent");
  }
  if (rendererOptions.getParentNode(b) !== undefined) {
    throw new Error("replaced node's parent registry entry must be cleared");
  }
});

Deno.test("rendererOptions exposes only the canonical solid-js 1.9.14 RendererOptions keys", () => {
  const canonical: readonly string[] = [
    "createElement",
    "createTextNode",
    "replaceText",
    "isTextNode",
    "setProperty",
    "insertNode",
    "removeNode",
    "getParentNode",
    "getFirstChild",
    "getNextSibling",
  ];
  const keys = Object.keys(rendererOptions);
  for (const key of keys) {
    if (!canonical.includes(key)) {
      throw new Error(`rendererOptions must not expose non-canonical key "${key}"`);
    }
  }
  if (keys.length !== canonical.length) {
    throw new Error(
      `rendererOptions must expose exactly the canonical ${canonical.length} keys, got ${keys.length}: ${JSON.stringify(keys)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// StreamingText / subscribeStream
// ---------------------------------------------------------------------------

/**
 * A push-driven async span source with an explicitly interruptible iterator.
 * `return()` releases a parked `next()` with `done: true`, so disposal
 * settles the pump deterministically (unlike an async generator, which only
 * processes `return()` when it next suspends at a yield).
 */
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

/** Drain pending microtasks (a macrotask round-trip). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("StreamingText creates a streaming_text node through the renderer", () => {
  const stream = StreamingText();
  if (stream.type !== "streaming_text") {
    throw new Error(`expected streaming_text node, got type "${stream.type}"`);
  }
  const seeded = StreamingText({ text: "seed", bold: true });
  if (seeded.type !== "streaming_text" || seeded.props.text !== "seed") {
    throw new Error("StreamingText() must spread props onto the node");
  }
});

Deno.test("subscribeStream accumulates spans on a detached streaming node", async () => {
  const node = StreamingText();
  const source = manualSpanSource();
  const dispose = subscribeStream(node, source.stream);

  source.push({ text: "hello" });
  await flush();
  source.push({ text: "world", style: { bold: true } });
  await flush();

  if (node.attached) {
    throw new Error("subscribeStream must not attach the node");
  }
  const spans = node.spans;
  if (spans.length !== 2) {
    throw new Error(`expected 2 accumulated spans, got ${spans.length}`);
  }
  if (spans[0]?.text !== "hello" || spans[1]?.text !== "world") {
    throw new Error(`unexpected spans: ${JSON.stringify(spans)}`);
  }
  if (spans[1]?.style?.bold !== true) {
    throw new Error("span style must be forwarded to appendSpan");
  }

  dispose();
});

Deno.test("subscribeStream disposer stops further appends", async () => {
  const node = StreamingText();
  const source = manualSpanSource();
  const dispose = subscribeStream(node, source.stream);

  source.push({ text: "a" });
  await flush();
  dispose();
  source.push({ text: "b" });
  await flush();

  const spans = node.spans;
  if (spans.length !== 1 || spans[0]?.text !== "a") {
    throw new Error(`disposer must stop appends, got ${JSON.stringify(spans)}`);
  }
});

// ---------------------------------------------------------------------------
// StreamingText auto-scroll
//
// `subscribeStream` feeds the core auto-scroll after each appended span:
// `syncStreamTail` pins `scroll_y` to the stream tail (content height minus
// the `clip_height` viewport) while following; a manual scroll above the tail
// detaches (pins the view); `followTail` re-attaches and snaps back. The node
// attaches under a real core `Renderer` over a *size-aware fake addon* (the
// `setAddonForTesting` seam — same approach as the @tern-tui/core tests), so
// `Node.contentSize()` measures the streamed spans and the scroll offsets are
// observable as scene props.
// ---------------------------------------------------------------------------

/** Per-handle `content_size` overrides for the panel-drag geometry tests
 * (keyed by the `FakeStreamNodeHandle` instance backing the node). */
const fakeDragSizes = new Map<object, { width: number; height: number }>();

/** The push callback registered by the fake `start_event_stream` (the
 * Renderer constructor registers it; the drag/wheel/click tests feed events
 * through it, standing in for the native event loop). */
let streamCallback: ((err: Error | null, event: TernEventJs) => void) | null = null;

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
  set_any_event_mouse(_enabled: boolean): void {}
  hit_test(_col: number, _row: number): bigint[] {
    // The wheel/click wiring gates on this; `solidFakeHitPath` is overridden
    // by the wheel/click tests (an empty path = off any painted cell).
    return solidFakeHitPath;
  }
  render(): void {
    solidFakeRenders.push(1);
    this.lastRows = [...solidSelectionRows];
  }
  set_selection(col1: number, row1: number, col2: number, row2: number): void {
    this.selection = { col1, row1, col2, row2 };
    solidFakeSelection = this.selection;
  }
  clear_selection(): void {
    this.selection = null;
    solidFakeSelection = null;
  }
  set_clipboard(text: string): void {
    solidSelectionClipboard = text;
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

/** The frame the solid fake paints on render — the stand-in for the native
 * retained buffer that `selection_text` / `selection_word_range` read (the
 * same "hello world" frame the core selection tests paint). */
const solidSelectionRows = ["hello world", "second line"];

/** The selection overlay state of the solid fake (mirrors the real
 * per-renderer native selection). */
let solidFakeSelection: { col1: number; row1: number; col2: number; row2: number } | null = null;

/** The last text the solid fake pushed to the clipboard (OSC 52). */
let solidSelectionClipboard: string | null = null;

/** The path returned by the solid fake `hit_test` (override for the
 * click-to-focus tests — an empty path models a press off any painted cell). */
let solidFakeHitPath: bigint[] = [7n];

/** Render calls recorded by the solid fake renderer's `render()`. */
const solidFakeRenders: number[] = [];

/** The size-aware fake addon injected through `setAddonForTesting`. */
const streamFakeAddon = {
  TuiRenderer: FakeStreamTuiRenderer,
  NodeHandle: FakeStreamNodeHandle,
  create_node: (type: string) => new FakeStreamNodeHandle(type),
} as unknown as TernAddon;

Deno.test("subscribeStream auto-scrolls a streaming node to the tail (detach + re-attach)", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    if (!isStreamFollowing(node)) throw new Error("autoScroll must default to following");
    const source = manualSpanSource();
    const dispose = subscribeStream(node, source.stream);

    // Three newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    source.push({ text: "a\n" });
    await flush();
    source.push({ text: "b\n" });
    await flush();
    source.push({ text: "c\n" });
    await flush();
    const y = (): number => node.props.scroll_y as number;
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);

    // Manual scroll up above the tail: the follow detaches and pins the view.
    scrollTo(node, 0, 0);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach");
    source.push({ text: "d\n" }); // 5 rows now — the view stays pinned
    await flush();
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // followTail: re-attach and snap to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach");
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    source.push({ text: "e\n" });
    await flush();
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    dispose();
  } finally {
    setAddonForTesting(null);
  }
});

Deno.test("StreamingText with autoScroll: false keeps the view pinned under subscribeStream", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const node = StreamingText({ autoScroll: false, clip_height: 2, width: 10 });
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }
    renderer.root.addChild(node);
    const source = manualSpanSource();
    const dispose = subscribeStream(node, source.stream);

    source.push({ text: "a\n" });
    await flush();
    source.push({ text: "b\n" });
    await flush();
    source.push({ text: "c\n" });
    await flush();

    if (isStreamFollowing(node)) throw new Error("autoScroll: false must not follow");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`scroll_y must stay unset, got ${node.props.scroll_y}`);
    }

    dispose();
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
// in @tern-tui/core — the framework layers surface the helpers (re-exported by
// this package) so an app can wire the affordance's activation.
// ---------------------------------------------------------------------------

Deno.test("subscribeStream stamps the scroll-to-bottom affordance on detach and dismisses on followTail/scrollToBottom", async () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const source = manualSpanSource();
    const dispose = subscribeStream(node, source.stream);

    // Fresh reads per assertion — TS property-access narrowing would reject a
    // later comparison against a different literal (see the core tests).
    const count = (): number => node.children.length;
    const y = (): number => node.props.scroll_y as number;
    source.push({ text: "a\n" });
    await flush();
    source.push({ text: "b\n" });
    await flush();
    source.push({ text: "c\n" });
    await flush();
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
    source.push({ text: "d\n" }); // 5 rows now — the view stays pinned
    await flush();
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);
    const applied = scrollToBottom(node);
    if (applied.y !== 3) throw new Error(`scrollToBottom applied = ${JSON.stringify(applied)}`);
    if (count() !== 0) throw new Error(`affordance after scrollToBottom = ${count()}`);
    if (y() !== 3) throw new Error(`jump scroll_y = ${y()}`);

    dispose();
  } finally {
    setAddonForTesting(null);
  }
});

// ---------------------------------------------------------------------------
// Reactive integration: signal -> targeted scene update (Phase-1 exit
// criterion at the @tern-tui/core level)
// ---------------------------------------------------------------------------

/**
 * Mount a reactive tree onto a detached core root via the universal
 * renderer's `render()` and prove that a signal write produces *targeted*
 * scene updates — no whole-tree rebuild:
 *
 * (a) a text node's props.text is re-set in place via the
 *     signal -> setProperty -> Node.setProps path;
 * (b) a conditional box is inserted/removed via the
 *     signal -> insertNode/removeNode path;
 * (c) every node keeps its object identity and only the affected node's
 *     props change.
 *
 * The root is a detached @tern-tui/core `Node` (never attached to a native
 * renderer), so no native addon is loaded: every mutation flows through pure
 * `Node` bookkeeping (`setProps`, `addChild`, `remove`) — exactly the
 * scene-op surface the native binding applies on attach.
 *
 * One signal drives both the text and the conditional: while the value is
 * non-empty the text shows it and a "conditional" box is present; an empty
 * value clears the text and removes the box.
 */
Deno.test("reactive signal drives targeted text and conditional-box scene updates", () => {
  const [greeting, setGreeting] = createSignal<string>("");

  // Detached core root — the host `render()` mounts the tree under.
  const root = Box();
  if (root.attached) {
    throw new Error("detached root must start unattached");
  }

  // Static sibling that must survive updates untouched (identity + props) —
  // evidence that the update is targeted rather than a whole-tree rebuild.
  const staticLabel = Text({ text: "static" });

  let textNode: Node | undefined;
  let condBox: Node | undefined;

  // Reactive mount. The tree root is a Box whose children are: a static
  // label, a text node reading the signal, and a memo accessor returning a
  // conditional box (or nothing). The universal renderer inserts each child
  // on mount and reconciles the memo-driven child on signal writes.
  const dispose = render(() => {
    textNode = createComponent(Text, { get text() { return greeting(); } });
    condBox = Box({ children: [Text({ text: "conditional" })] });
    const condAccessor = memo(() => (greeting() !== "" ? condBox : undefined), false);
    return createComponent(Box, {
      get children() {
        return [staticLabel, textNode, condAccessor];
      },
    });
  }, root);

  const treeRoot = root.children[0]!;
  const textNodeRef = textNode!;
  const condBoxRef = condBox!;

  // Instrument the two mutation funnels the renderer drives on updates:
  // `Node.setProps` (reached via the options' `setProperty` -> applyProp) and
  // `Node.remove` (reached via the options' `removeNode`). Spies are
  // installed after mount so they record only post-mount writes.
  const textWrites: Array<{ text?: unknown }> = [];
  const originalSetProps = textNodeRef.setProps.bind(textNodeRef);
  textNodeRef.setProps = (props) => {
    textWrites.push({ ...props });
    originalSetProps(props);
  };
  let condRemoves = 0;
  const originalRemove = condBoxRef.remove.bind(condBoxRef);
  condBoxRef.remove = () => {
    condRemoves++;
    return originalRemove();
  };

  // --- Mount state: text present, conditional hidden -----------------------
  if (root.children.length !== 1 || root.children[0] !== treeRoot) {
    throw new Error("render must mount exactly one tree root under the host");
  }
  if (treeRoot.children.length !== 2) {
    throw new Error(`expected [static, text] at mount, got ${treeRoot.children.length} children`);
  }
  if (treeRoot.children[0] !== staticLabel || treeRoot.children[1] !== textNodeRef) {
    throw new Error("mount order must be [staticLabel, textNode]");
  }
  const mountText: string | undefined = textNodeRef.props.text;
  if (mountText !== "") {
    throw new Error(`expected empty text at mount, got ${JSON.stringify(mountText)}`);
  }
  if (rendererOptions.getParentNode(condBoxRef) !== undefined) {
    throw new Error("hidden conditional must not be registered under any parent");
  }

  // --- One signal write: text update + conditional insertion --------------
  setGreeting("hi");

  // (a) signal -> setProperty -> Node.setProps: the SAME text node object now
  // carries the new value, and the write went through the setProps funnel.
  const textAfterFirstWrite: string | undefined = textNodeRef.props.text;
  if (textAfterFirstWrite !== "hi") {
    throw new Error(
      `text props must reflect the new signal value, got ${JSON.stringify(textAfterFirstWrite)}`,
    );
  }
  if (textWrites.length !== 1 || textWrites[0]!.text !== "hi") {
    throw new Error(
      `expected exactly one post-mount setProps write with text "hi", got ${JSON.stringify(textWrites)}`,
    );
  }

  // (b) signal -> insertNode -> addChild: the conditional box was inserted
  // under the tree root (parent registry and children list agree).
  if (rendererOptions.getParentNode(condBoxRef) !== treeRoot) {
    throw new Error("inserted conditional must be registered under the tree root");
  }
  if (!treeRoot.children.includes(condBoxRef)) {
    throw new Error("inserted conditional must appear in the tree root's children");
  }
  if (treeRoot.children[2] !== condBoxRef) {
    throw new Error("conditional must be appended after the text node");
  }

  // (c) targeted update, no whole-tree rebuild: every node keeps its identity,
  // the untouched sibling's props are unchanged, and only the text node was
  // written.
  if (root.children.length !== 1 || root.children[0] !== treeRoot) {
    throw new Error("host children must not be rebuilt");
  }
  if (treeRoot.children[0] !== staticLabel) {
    throw new Error("static label must keep its identity");
  }
  if (staticLabel.props.text !== "static") {
    throw new Error(
      `static label props must stay untouched, got ${JSON.stringify(staticLabel.props)}`,
    );
  }
  if (treeRoot.children[1] !== textNodeRef) {
    throw new Error("text node must keep its identity");
  }

  // --- Toggle back: conditional removed via removeNode ---------------------
  setGreeting("");

  const textAfterSecondWrite: string | undefined = textNodeRef.props.text;
  if (textAfterSecondWrite !== "") {
    throw new Error(
      `text must revert to "", got ${JSON.stringify(textAfterSecondWrite)}`,
    );
  }
  const writeCount: number = textWrites.length;
  if (writeCount !== 2 || textWrites[1]!.text !== "") {
    throw new Error(
      `expected a second setProps write with text "", got ${JSON.stringify(textWrites)}`,
    );
  }
  // The renderer's removeNode clears the parent registry entry...
  if (rendererOptions.getParentNode(condBoxRef) !== undefined) {
    throw new Error("removed conditional's parent registry entry must be cleared");
  }
  // ...and invokes core Node.remove() on the box (recorded by the spy).
  if (condRemoves !== 1) {
    throw new Error(`expected exactly one remove() call on the conditional, got ${condRemoves}`);
  }
  // @tern-tui/core `Node.remove()` splices the node out of its parent's children
  // list, so the JS tree mirrors the removal: the conditional is gone from
  // treeRoot.children and only [staticLabel, textNode] remain.
  if (treeRoot.children.length !== 2) {
    throw new Error(
      `expected [staticLabel, textNode] after removal, got ${treeRoot.children.length} children`,
    );
  }
  if (treeRoot.children.includes(condBoxRef)) {
    throw new Error("removed conditional must be spliced out of treeRoot.children");
  }
  if (treeRoot.children[0] !== staticLabel || staticLabel.props.text !== "static") {
    throw new Error("static label must remain untouched after removal");
  }
  if (treeRoot.children[1] !== textNodeRef) {
    throw new Error("text node must remain in place after removal");
  }

  dispose();
});

// ---------------------------------------------------------------------------
// Roadmap element factories (feature parity with @tern-tui/react)
// ---------------------------------------------------------------------------

/**
 * Read a node's child count through a function so the type checker cannot
 * narrow it across the mutating element calls below (toggle/expand/collapse/
 * remove mutate the nodes in place; a narrowed literal would make the
 * follow-up comparisons look "unintentional").
 */
const childCount = (node: Node): number => node.children.length;

/** The bold flag of a panel box's header (its first child `text` node). */
const headerBold = (node: Node): boolean | undefined => node.children[0]?.props.bold;

Deno.test("Input/Spinner/StatusBar/Panels factories materialize the core elements", () => {
  // Input: a framed box with a text leaf carrying the value/caret (and a dim
  // placeholder when empty).
  const input = Input({ value: "hi", caret: 1, placeholder: "type…" });
  if (input.type !== "input") throw new Error(`input type = ${input.type}`);
  if (input.props.value !== "hi" || input.props.caret !== 1) {
    throw new Error(`input props = ${JSON.stringify(input.props)}`);
  }
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("input must compose a text leaf");
  }
  if (leaf.props.text !== "hi" || leaf.props.caret !== 1) {
    throw new Error(`leaf must carry value/caret: ${JSON.stringify(leaf.props)}`);
  }
  // Empty input with a placeholder: the leaf shows the dimmed placeholder.
  const empty = Input({ placeholder: "ask…" });
  if (empty.children[0]?.props.text !== "ask…" || empty.children[0]?.props.dim !== true) {
    throw new Error("empty input must show the dimmed placeholder");
  }

  // Spinner: determinate bar derives its text from value/max/width.
  const spinner = Spinner({ value: 5, max: 10, width: 8 });
  if (spinner.type !== "spinner") throw new Error(`spinner type = ${spinner.type}`);
  if (spinner.props.text !== "▓▓▓▓░░░░") {
    throw new Error(`determinate bar = ${JSON.stringify(spinner.props.text)}`);
  }
  // Indeterminate: the frame glyph at `frame`, advancing via tick().
  const frames = ["⠋", "⠙"];
  const indet = Spinner({ frames, frame: 1 });
  if (indet.props.text !== "⠙") throw new Error(`frame glyph = ${JSON.stringify(indet.props.text)}`);
  const advanced = tick(indet);
  if (advanced !== "⠋") throw new Error(`tick must wrap frames, got ${JSON.stringify(advanced)}`);

  // StatusBar: a row strip whose children are the segment Text nodes; the
  // segment keys are lifted out of the strip props.
  const bar = StatusBar({ left: "L", center: "C", right: "R" });
  if (bar.type !== "status_bar") throw new Error(`status_bar type = ${bar.type}`);
  const texts = bar.children.map((child) => child.props.text).join(",");
  if (texts !== "L,C,R") throw new Error(`segments = ${texts}`);
  if (bar.props.flex_direction !== "row" || bar.props.height !== 1) {
    throw new Error(`strip props = ${JSON.stringify(bar.props)}`);
  }
  for (const key of ["left", "center", "right"]) {
    if (key in bar.props) throw new Error(`segment key leaked into strip props: ${key}`);
  }

  // Panels: a flex stack of panel boxes; the active panel's header is bold,
  // a collapsed panel hides its body.
  const bodyA = Box();
  const bodyB = Box();
  const panels = Panels({
    panels: [
      { header: "A", body: bodyA },
      { header: "B", body: bodyB, collapsed: true },
    ],
    active: 1,
  });
  if (panels.type !== "panels") throw new Error(`panels type = ${panels.type}`);
  if (panels.props.active !== 1 || panels.props.flex_direction !== "column") {
    throw new Error(`panels props = ${JSON.stringify(panels.props)}`);
  }
  if ("panels" in panels.props || "direction" in panels.props) {
    throw new Error("panel spec keys must not reach the scene props");
  }
  if (childCount(panels) !== 2) throw new Error(`panels = ${childCount(panels)}`);
  const panelA = panels.children[0]!;
  const panelB = panels.children[1]!;
  if (panelA.children[0]?.props.text !== "A" || panelA.children[1] !== bodyA) {
    throw new Error("panel A must show header + body");
  }
  if (childCount(panelB) !== 1 || panelB.children[0]?.props.text !== "B") {
    throw new Error("collapsed panel B must hide its body");
  }
  if (headerBold(panelB) !== true || headerBold(panelA) !== false) {
    throw new Error("only the active panel's header is bold");
  }
  // Panels are manageable: collapse/expand/toggle round-trip.
  togglePanel(panels, 0);
  if (childCount(panelA) !== 1) throw new Error("toggle must collapse panel A");
  expandPanel(panels, 0);
  if (childCount(panelA) !== 2) throw new Error("expand must restore the body");
  collapsePanel(panels, 0);
  if (childCount(panelA) !== 1) throw new Error("collapse must detach the body");
  focusPanel(panels, 0);
  if (headerBold(panelA) !== true || headerBold(panelB) !== false) {
    throw new Error("focusPanel must restyle the headers");
  }

  // The renderer surface also maps the roadmap tags (as empty elements).
  if (createElement("input").type !== "input") throw new Error("createElement(input) mapping");
  if (createElement("textarea").type !== "textarea") {
    throw new Error("createElement(textarea) mapping");
  }
  if (createElement("spinner").type !== "spinner") throw new Error("createElement(spinner) mapping");
  if (createElement("status_bar").type !== "status_bar") {
    throw new Error("createElement(status_bar) mapping");
  }
  if (createElement("panels").type !== "panels") throw new Error("createElement(panels) mapping");
  if (createElement("diff").type !== "diff") throw new Error("createElement(diff) mapping");
  if (createElement("menu").type !== "menu") throw new Error("createElement(menu) mapping");
});

Deno.test("Textarea factory materializes the core element with per-line leaves", () => {
  const textarea = Textarea({ lines: ["ab", "cd"], row: 1, col: 2, width: 10 });
  if (textarea.type !== "textarea") throw new Error(`textarea type = ${textarea.type}`);
  if (textarea.props.row !== 1 || textarea.props.col !== 2 || textarea.props.width !== 10) {
    throw new Error(`textarea props = ${JSON.stringify(textarea.props)}`);
  }
  if (childCount(textarea) !== 2) throw new Error(`leaves = ${childCount(textarea)}`);
  const first = textarea.children[0]!;
  const second = textarea.children[1]!;
  if (first.props.text !== "ab" || "caret" in first.props) {
    throw new Error(`leaf 0 = ${JSON.stringify(first.props)}`);
  }
  if (second.props.text !== "cd" || second.props.caret !== 2) {
    throw new Error(`leaf 1 = ${JSON.stringify(second.props)}`);
  }
  // The renderer surface maps the textarea tag (as an empty element).
  if (createElement("textarea").type !== "textarea") {
    throw new Error("createElement(textarea) mapping");
  }
});

Deno.test("subscribeInput routes keys through the FocusManager to a focused textarea", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const textarea = Textarea({ lines: ["hi"] });
  const changes: Array<{ lines: string[]; row: number; col: number }> = [];
  const submits: Array<{ lines: string[]; row: number; col: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const submitCount = () => submits.length;

  // Register the textarea node with the manager: routed keys edit it via the
  // core `editTextareaKey`, firing onChange/onSubmit like React's
  // <Textarea focusId>.
  const focusHandle = useFocus("main", textarea, (event) => {
    const before = textarea.props as { lines?: string[]; row?: number; col?: number };
    const next = editTextareaKey(textarea, event);
    const changed =
      next.lines !== before.lines || next.row !== before.row || next.col !== before.col;
    if (event.name === "enter") {
      submits.push(next);
    } else if (changed) {
      changes.push(next);
    }
  }, manager);

  // The tree-level key subscription: each key routes through the manager
  // before falling back to its own (no-op) handler.
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("main")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  if (changeCount() !== 0) throw new Error("unfocused textarea must not receive keys");

  // Focused: keys route to the textarea's handler and edit the node.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (changeCount() !== 2) throw new Error(`onChange count = ${changeCount()}`);
  if (changes[0]!.lines.join(",") !== "ahi" || changes[1]!.lines.join(",") !== "abhi") {
    throw new Error(`onChange lines = ${changes.map((c) => c.lines.join("")).join(",")}`);
  }
  if (changes[1]!.col !== 2) throw new Error(`col = ${changes[1]!.col}`);
  // The routed edits land on the scene node itself.
  if ((textarea.props as { lines?: string[] }).lines?.join(",") !== "abhi") {
    throw new Error(`node edited = ${JSON.stringify(textarea.props)}`);
  }

  // Enter splits the line and routes to the submit path.
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (submitCount() !== 1 || submits[0]!.lines.join(",") !== "ab,hi") {
    throw new Error(`onSubmit = ${JSON.stringify(submits)}`);
  }

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("main")) throw new Error("textarea must unregister on dispose");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Textarea with a focusId registers with the FocusManager and fires onChange/onSubmit", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const changes: Array<{ lines: string[]; row: number; col: number }> = [];
  const submits: Array<{ lines: string[]; row: number; col: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const submitCount = () => submits.length;

  // The factory consumes focusId/focusManager/onChange/onSubmit like React's
  // <Textarea focusId>: it registers the textarea with the manager under
  // "main" at creation, and routed keys edit it via `editTextareaKey`, firing
  // onChange/onSubmit. The component keys are consumed — never scene props.
  const textarea = Textarea({
    lines: ["hi"],
    focusId: "main",
    focusManager: manager,
    onChange: (state) => changes.push(state),
    onSubmit: (state) => submits.push(state),
  });
  for (const key of ["focusId", "focusManager", "onChange", "onSubmit"]) {
    if (key in textarea.props) throw new Error(`component key leaked into scene props: ${key}`);
  }

  // The tree-level key subscription: each key routes through the manager
  // before falling back to its own (no-op) handler.
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("main")) throw new Error("textarea must register under focusId");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  if (changeCount() !== 0) throw new Error("unfocused textarea must not receive keys");

  // Focused: keys route to the textarea's handler and edit the node.
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

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  disposeTextareaFocus(textarea);
  if (manager.has("main")) throw new Error("textarea must unregister on dispose");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
  // A second dispose is a no-op (the entry is already gone).
  disposeTextareaFocus(textarea);
  if (manager.has("main")) throw new Error("double dispose must stay a no-op");
});

Deno.test("DiffView factory materializes per-kind rows with gutter, markers, colors and scroll", () => {
  const diff = DiffView({
    hunks: [
      { kind: "ctx", old_line: 1, new_line: 1, text: "  fn main() {" },
      { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
      { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
    ],
    scroll_y: 3,
    wrap: false,
  });
  if (diff.type !== "diff") throw new Error(`diff type = ${diff.type}`);
  if (diff.props.scroll_y !== 3) throw new Error(`scroll_y = ${diff.props.scroll_y}`);
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
  if (childCount(diff) !== 3) throw new Error(`rows = ${childCount(diff)}`);

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

Deno.test("ScrollView factory materializes the core element with region props, content and a scrollbar", () => {
  const content = Text({ text: "content" });
  const view = ScrollView({
    clip_x: 1,
    clip_y: 2,
    clip_width: 10,
    clip_height: 4,
    scroll_y: 2,
    showScrollbar: true,
    children: [content],
  });
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.clip_x !== 1 || view.props.clip_y !== 2) {
    throw new Error(`clip origin = ${JSON.stringify(view.props)}`);
  }
  if (view.props.clip_width !== 10 || view.props.clip_height !== 4) {
    throw new Error(`clip size = ${JSON.stringify(view.props)}`);
  }
  if (view.props.scroll_y !== 2) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  // Content child (first) + the scrollbar text leaf (absolute at the right
  // edge); both keys are consumed by the factory — never scene props.
  if (childCount(view) !== 2) throw new Error(`children = ${childCount(view)}`);
  if (view.children[0] !== content) throw new Error("content must be the first child");
  const leaf = view.children[1];
  if (leaf === undefined || leaf.type !== "text" || leaf.props.position !== "absolute") {
    throw new Error("showScrollbar must compose a scrollbar text leaf");
  }
  if ("showScrollbar" in view.props || "children" in view.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(view.props)}`);
  }
  // The renderer surface maps the scroll_view tag too (as an empty element).
  if (createElement("scroll_view").type !== "scroll_view") {
    throw new Error("createElement(scroll_view) mapping");
  }
});

// ---------------------------------------------------------------------------
// Parity: Solid renders the same element set as React
// ---------------------------------------------------------------------------

/**
 * A canonical, order-independent snapshot of a scene node tree: `type`, the
 * sorted `props`, and the serialized children. Two snapshots are equal iff the
 * scene structures are identical.
 */
interface SceneSnapshot {
  type: string;
  props: Record<string, unknown>;
  children: SceneSnapshot[];
}

function snapshot(node: Node): SceneSnapshot {
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(node.props).sort()) props[key] = node.props[key];
  return {
    type: node.type,
    props,
    children: node.children.map((child) => snapshot(child)),
  };
}

function snapshotsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (!(key in (b as Record<string, unknown>)) || !snapshotsEqual(av, bv)) return false;
  }
  return true;
}

/**
 * Parity: for identical props, the Solid factories produce the same scene
 * node structure the React host components do.
 *
 * The React side materializes its host elements through
 * `hostConfig.createInstance(type, props)` -> `toNodeProps(props, type)` ->
 * the @tern-tui/core factory of the same name (packages/react/src/reconciler.ts).
 * `toNodeProps` strips the React-only keys (`children`/`key`/`ref` and the
 * component-consumed keys), so for a props object carrying only tern node
 * props the React-rendered node is exactly the core factory output. Asserting
 * Solid.factory(props) === Core.factory(props) for the whole element set
 * therefore proves Solid renders the same element set as React. (React itself
 * is not imported here — importing it requires `--allow-env=NODE_ENV`, which
 * would break the plain `deno test packages/solid/src` invocation.)
 */
Deno.test("parity: solid renders the same scene structure as react's materialization baseline", () => {
  const panelsSpec = [
    { header: "A", body: CoreBox() },
    { header: "B", body: CoreBox(), collapsed: true },
  ];
  const diffHunks = [
    { kind: "ctx" as const, old_line: 1, new_line: 1, text: "  a" },
    { kind: "del" as const, old_line: 2, new_line: 0, text: "  b" },
    { kind: "add" as const, old_line: 0, new_line: 2, text: "  c" },
  ];

  // The React baseline: the @tern-tui/core factories (what React's hostConfig
  // materializes) built into the same tree shape.
  const coreRoot = CoreBox();
  coreRoot.addChild(
    CoreBox(
      { border_style: "rounded" },
      CoreText({ text: "hello", bold: true }),
      CoreInput({ value: "hi", caret: 1, placeholder: "type…" }),
      CoreSpinner({ value: 5, max: 10, width: 8 }),
      CoreStatusBar({ left: "L", right: "R" }),
      CorePanels({ panels: panelsSpec, active: 1 }),
      CoreDiffView({ hunks: diffHunks, scroll_y: 2, wrap: false }),
      CoreScrollView(
        { clip_x: 1, clip_y: 2, clip_width: 20, clip_height: 10, scroll_x: 1, scroll_y: 3, showScrollbar: true },
        CoreText({ text: "line" }),
      ),
      CoreTable({
        columns: [{ key: "name", header: "Name", width: 10 }],
        rows: [["Ada"]],
        highlight: 0,
        clip_height: 2,
      }),
      CoreTabs({
        tabs: [
          { label: "logs", content: [CoreText({ text: "log line" })] },
          { label: "files", content: [] },
        ],
        active: 1,
        closable: true,
      }),
      CoreProgress({ value: 5, max: 10, width: 12, label: "work" }),
      CoreModal({ open: true, content: [CoreBox()] }),
    ),
  );

  // The Solid tree: the same element set, same props, mounted through the
  // universal renderer onto a detached root.
  const solidHost = Box();
  const dispose = render(
    () =>
      Box({
        border_style: "rounded",
        children: [
          Text({ text: "hello", bold: true }),
          Input({ value: "hi", caret: 1, placeholder: "type…" }),
          Spinner({ value: 5, max: 10, width: 8 }),
          StatusBar({ left: "L", right: "R" }),
          Panels({ panels: panelsSpec, active: 1 }),
          DiffView({ hunks: diffHunks, scroll_y: 2, wrap: false }),
          ScrollView({
            clip_x: 1,
            clip_y: 2,
            clip_width: 20,
            clip_height: 10,
            scroll_x: 1,
            scroll_y: 3,
            showScrollbar: true,
            children: [Text({ text: "line" })],
          }),
          Table({
            columns: [{ key: "name", header: "Name", width: 10 }],
            rows: [["Ada"]],
            highlight: 0,
            clip_height: 2,
          }),
          Tabs({
            tabs: [
              { label: "logs", content: [Text({ text: "log line" })] },
              { label: "files", content: [] },
            ],
            active: 1,
            closable: true,
          }),
          Progress({ value: 5, max: 10, width: 12, label: "work" }),
          Modal({ open: true, content: [Box()] }),
        ],
      }),
    solidHost,
  );

  const coreScene = snapshot(coreRoot.children[0]!);
  const solidScene = snapshot(solidHost.children[0]!);
  if (!snapshotsEqual(solidScene, coreScene)) {
    throw new Error(
      `parity mismatch — solid scene differs from react's materialization baseline:\n` +
        `solid: ${JSON.stringify(solidScene)}\n` +
        `react baseline: ${JSON.stringify(coreScene)}`,
    );
  }
  dispose();
});

// ---------------------------------------------------------------------------
// Focus routing: subscribeInput + useFocus + editKey
// ---------------------------------------------------------------------------

/** A fake core Renderer over a detached root: no native calls. */
function mockRenderer(): {
  renderer: Renderer;
  root: Node;
  renderCalls: number[];
  size: { width: number; height: number };
  keyHandlers: Set<(event: KeyEvent) => void>;
  resizeHandlers: Set<(event: { width: number; height: number }) => void>;
  focusHandlers: Set<(event: { focus_gained: boolean }) => void>;
  pasteHandlers: Set<(text: string) => void>;
  mouseHandlers: Set<(event: MouseEventJs) => void>;
} {
  const renderCalls: number[] = [];
  // The reported terminal size: `renderer.size` in the real renderer reads
  // the native terminal, here it reads this mutable object (tests may adjust
  // it before creation to seed the initial value).
  const size = { width: 80, height: 24 };
  const keyHandlers = new Set<(event: KeyEvent) => void>();
  const resizeHandlers = new Set<(event: { width: number; height: number }) => void>();
  const focusHandlers = new Set<(event: { focus_gained: boolean }) => void>();
  const pasteHandlers = new Set<(text: string) => void>();
  const mouseHandlers = new Set<(event: MouseEventJs) => void>();
  const root = Box();
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
    onResize: (handler: (event: { width: number; height: number }) => void) => {
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

Deno.test("subscribeInput routes keys through the FocusManager to a focused input", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const input = Input({ value: "", caret: 0 });
  const changes: Array<{ value: string; caret: number }> = [];
  const submits: Array<{ value: string; caret: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const submitCount = () => submits.length;

  // Register the input node with the manager: routed keys edit it via the
  // core `editKey`, firing onChange/onSubmit like React's <Input focusId>.
  const focusHandle = useFocus("main", input, (event) => {
    const before = input.props;
    const next = editKey(input, event);
    if (event.name === "enter") {
      submits.push({ value: next.value, caret: next.caret });
    } else if (next.value !== before.value || next.caret !== before.caret) {
      changes.push({ value: next.value, caret: next.caret });
    }
  }, manager);

  // The tree-level key subscription: each key routes through the manager
  // before falling back to its own (no-op) handler.
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("main")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  if (changeCount() !== 0) throw new Error("unfocused input must not receive keys");

  // Focused: keys route to the input's handler and edit the node.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "a" }));
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (changeCount() !== 2) throw new Error(`onChange count = ${changeCount()}`);
  if (changes[0]!.value !== "a" || changes[1]!.value !== "ab") {
    throw new Error(`onChange values = ${changes.map((c) => c.value).join(",")}`);
  }
  if (changes[1]!.caret !== 2) throw new Error(`caret = ${changes[1]!.caret}`);
  // The routed edits land on the scene node itself.
  if (input.props.value !== "ab" || input.props.caret !== 2) {
    throw new Error(`node edited = ${input.props.value}/${input.props.caret}`);
  }

  // Enter routes to the submit path with the current value.
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (submitCount() !== 1 || submits[0]!.value !== "ab") {
    throw new Error(`onSubmit = ${JSON.stringify(submits)}`);
  }

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("main")) throw new Error("input must unregister on dispose");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("subscribeInput defaults to the shared focusManager and skips routing when focused", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const input = Input({ value: "" });
  const handled: KeyEvent[] = [];

  // No explicit manager: the core `focusManager` singleton is used.
  const focusHandle = useFocus("shared", input, (event) => handled.push(event));
  const dispose = subscribeInput(renderer, () => {
    throw new Error("tree handler must not run while a focused element handles keys");
  });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  // Unfocused: the tree handler runs (would throw — so expect it not to).
  // Focus the element: the routed key must reach the element, not the handler.
  if (!focusManager.focus("shared")) throw new Error("focus(shared) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "x" }));
  if (handled.length !== 1 || handled[0]!.char !== "x") {
    throw new Error(`routed hits = ${handled.length}`);
  }

  dispose();
  focusHandle.dispose();
  focusManager.blur();
});

Deno.test("subscribeInput with isActive: false stays detached", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const dispose = subscribeInput(renderer, () => {}, { isActive: false });
  if (keyHandlers.size !== 0) throw new Error("inactive subscription must not register a handler");
  dispose();
});

Deno.test("subscribePaste routes pastes through the FocusManager to a focused input", () => {
  const { renderer, pasteHandlers } = mockRenderer();
  const manager = new FocusManager();
  const input = Input({ value: "", caret: 0 });
  const changes: Array<{ value: string; caret: number }> = [];
  const treePastes: string[] = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const treePasteCount = () => treePastes.length;

  // Register the input node with the manager: routed pastes auto-paste into
  // it via the core `pasteInto`, firing onChange like React's <Input focusId>.
  const focusHandle = useFocus("main", input, () => {}, manager, (text) => {
    const before = input.props;
    const next = pasteInto(input, text);
    if (next.value !== before.value || next.caret !== before.caret) {
      changes.push({ value: next.value, caret: next.caret });
    }
  });

  // The tree-level paste subscription: each paste routes through the manager
  // before falling back to its own handler.
  const dispose = subscribePaste(renderer, (text) => treePastes.push(text), { focusManager: manager });

  if (pasteHandlers.size !== 1) throw new Error(`expected 1 paste handler, got ${pasteHandlers.size}`);
  if (!manager.has("main")) throw new Error("useFocus must register the id");

  // Not focused: pastes fall through to the tree handler.
  for (const handler of pasteHandlers) handler("xy");
  if (changeCount() !== 0) throw new Error("unfocused input must not receive pastes");
  if (treePasteCount() !== 1 || treePastes[0] !== "xy") {
    throw new Error(`tree handler must receive the paste while unfocused: ${JSON.stringify(treePastes)}`);
  }

  // Focused: pastes route to the input's paste handler and edit the node.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of pasteHandlers) handler("ab");
  if (changeCount() !== 1 || changes[0]!.value !== "ab" || changes[0]!.caret !== 2) {
    throw new Error(`onChange = ${JSON.stringify(changes)}`);
  }
  if (treePasteCount() !== 1) throw new Error("a routed paste must skip the tree handler");
  // The routed paste lands on the scene node itself.
  if (input.props.value !== "ab" || input.props.caret !== 2) {
    throw new Error(`node edited = ${input.props.value}/${input.props.caret}`);
  }

  // A second paste inserts at the caret (mid-value) and advances past it.
  for (const handler of pasteHandlers) handler("XY");
  if (changeCount() !== 2 || changes[1]!.value !== "abXY" || changes[1]!.caret !== 4) {
    throw new Error(`second paste = ${JSON.stringify(changes)}`);
  }

  dispose();
  if (pasteHandlers.size >= 1) throw new Error("paste handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("main")) throw new Error("input must unregister on dispose");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Textarea with a focusId auto-pastes routed paste events", () => {
  const { renderer, pasteHandlers } = mockRenderer();
  const manager = new FocusManager();
  const changes: Array<{ lines: string[]; row: number; col: number }> = [];
  const treePastes: string[] = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const treePasteCount = () => treePastes.length;

  // The factory consumes focusId/focusManager/onChange/onSubmit like React's
  // <Textarea focusId>: it registers the textarea with the manager under
  // "main" at creation, routed keys edit it via `editTextareaKey`, and routed
  // pastes auto-paste via `pasteIntoTextarea` — firing onChange on each.
  const textarea = Textarea({
    lines: ["hi"],
    focusId: "main",
    focusManager: manager,
    onChange: (state) => changes.push(state),
  });

  // The tree-level paste subscription: each paste routes through the manager
  // before falling back to its own handler.
  const dispose = subscribePaste(renderer, (text) => treePastes.push(text), { focusManager: manager });

  if (pasteHandlers.size !== 1) throw new Error(`expected 1 paste handler, got ${pasteHandlers.size}`);
  if (!manager.has("main")) throw new Error("textarea must register under focusId");

  // Not focused: pastes fall through to the tree handler.
  for (const handler of pasteHandlers) handler("x");
  if (changeCount() !== 0) throw new Error("unfocused textarea must not receive pastes");
  if (treePasteCount() !== 1 || treePastes[0] !== "x") {
    throw new Error(`tree handler must receive the paste while unfocused: ${JSON.stringify(treePastes)}`);
  }

  // Focused: pastes route to the textarea's paste handler and edit the node.
  // The caret starts at col 0 (no col prop), so the paste lands at the head.
  if (!manager.focus("main")) throw new Error("focus(main) must succeed");
  for (const handler of pasteHandlers) handler("XY");
  if (changeCount() !== 1 || changes[0]!.lines.join(",") !== "XYhi" || changes[0]!.col !== 2) {
    throw new Error(`onChange = ${JSON.stringify(changes)}`);
  }
  if (treePasteCount() !== 1) throw new Error("a routed paste must skip the tree handler");
  // The routed paste lands on the scene node itself (one leaf per line).
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

  dispose();
  if (pasteHandlers.size >= 1) throw new Error("paste handler must be detached on dispose");
  disposeTextareaFocus(textarea);
  if (manager.has("main")) throw new Error("textarea must unregister on dispose");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("subscribePaste with isActive: false stays detached", () => {
  const { renderer, pasteHandlers } = mockRenderer();
  const dispose = subscribePaste(renderer, () => {}, { isActive: false });
  if (pasteHandlers.size !== 0) throw new Error("inactive subscription must not register a handler");
  dispose();
});

// Select: factory parity + selectKey routing + floating z_index
// ---------------------------------------------------------------------------

Deno.test("Select factory materializes the core element with filter and option rows", () => {
  const select = Select({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  if (select.type !== "select") throw new Error(`type = ${select.type}`);
  // Filter row + 2 option rows (no summary in single mode).
  if (select.children.length !== 3) throw new Error(`rows = ${select.children.length}`);
  if (select.children[0]?.props.text !== "filter…") throw new Error("filter row");
  if (select.children[1]?.props.text !== "A" || select.children[2]?.props.text !== "B") {
    throw new Error(`rows = ${select.children.map((c) => c.props.text).join(",")}`);
  }
  if ("options" in select.props) throw new Error("options must not reach the scene props");
  // Multi mode: checkmarks + selected-count summary.
  const multi = Select({
    options: [{ value: "a", label: "A", selected: true }],
    multi: true,
  });
  if (multi.children[1]?.props.text !== "✓ A") throw new Error(`row = ${multi.children[1]?.props.text}`);
  if (multi.children[2]?.props.text !== "1 selected") {
    throw new Error(`summary = ${multi.children[2]?.props.text}`);
  }
});

Deno.test("selectKey routes through the FocusManager to a focused select", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const select = Select({
    options: [
      { value: "apple", label: "Apple" },
      { value: "banana", label: "Banana" },
    ],
  });
  const confirms: Array<{ value: string | string[] }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const confirmCount = () => confirms.length;
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const visibleText = () => select.children[1]?.props.text;
  const childCount = () => select.children.length;

  // Register the select node with the manager: routed keys drive it via the
  // core `selectKey`, firing onConfirm-style callbacks like React's
  // `<Select focusId>`.
  const focusHandle = useFocus("sel", select, (event) => {
    const next = selectKey(select, event);
    if (event.name === "enter") confirms.push(next);
  }, manager);
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("sel")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (confirmCount() !== 0) throw new Error("unfocused select must not receive keys");

  // Focused: the typeahead filter narrows the visible rows on the node.
  if (!manager.focus("sel")) throw new Error("focus(sel) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "b" }));
  if (childCount() !== 2) throw new Error(`rows after filter = ${childCount()}`);
  if (visibleText() !== "Banana") throw new Error(`visible = ${visibleText()}`);

  // Enter confirms the highlighted (filtered) option.
  for (const handler of keyHandlers) handler(keyEvent({ name: "enter" }));
  if (confirmCount() !== 1 || confirms[0]!.value !== "banana") {
    throw new Error(`confirm = ${JSON.stringify(confirms)}`);
  }
  if (select.props.value !== "banana") throw new Error(`node value = ${select.props.value}`);

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("sel")) throw new Error("select must unregister on dispose");
});

Deno.test("selectKey space toggles a multi checkmark and updates the count", () => {
  const select = Select({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    multi: true,
  });
  const rowText = () => select.children[1]?.props.text;
  const summaryText = () => select.children[3]?.props.text;
  const base = { ctrl: false, alt: false, shift: false } as const;
  selectKey(select, { name: "char", char: " ", ...base });
  if (rowText() !== "✓ A") throw new Error(`row = ${rowText()}`);
  if (summaryText() !== "1 selected") throw new Error(`summary = ${summaryText()}`);
  selectKey(select, { name: "char", char: " ", ...base });
  if (rowText() !== "  A") throw new Error(`row = ${rowText()}`);
  if (summaryText() !== "0 selected") throw new Error(`summary = ${summaryText()}`);
});

Deno.test("Select floating mode sets a z_index prop", () => {
  const floating = Select({
    options: [{ value: "a", label: "A" }],
    floating: true,
  });
  if (floating.props.z_index !== 0) throw new Error(`z_index = ${floating.props.z_index}`);
  if ("floating" in floating.props) throw new Error("floating must not reach the scene props");
  const layered = Select({
    options: [{ value: "a", label: "A" }],
    floating: true,
    z_index: 5,
  });
  if (layered.props.z_index !== 5) throw new Error(`z_index = ${layered.props.z_index}`);
});

// Menu: factory parity + menuKey routing + mouse wiring
// ---------------------------------------------------------------------------

Deno.test("Menu factory materializes the core element with item rows and strips component props", () => {
  const menu = Menu({
    items: [
      { label: "New" },
      { label: "Open", children: [{ label: "File" }, { label: "Dir" }] },
      { label: "Quit" },
    ],
    focusId: "s-menu",
    onSelect: () => {},
    onDismiss: () => {},
  });
  if (menu.type !== "menu") throw new Error(`type = ${menu.type}`);
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
  // The factory's focusId registration is owned by the node; disposing it
  // unregisters the id.
  if (!focusManager.has("s-menu")) throw new Error("Menu(focusId) must register with the core manager");
  disposeMenuFocus(menu);
  if (focusManager.has("s-menu")) throw new Error("disposeMenuFocus must unregister the id");
});

Deno.test("menuKey routes through the FocusManager to a focused menu", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const menu = Menu({
    items: [
      { label: "New", id: "new" },
      { label: "Open", id: "open", children: [{ label: "File", id: "file" }] },
      { label: "Quit", id: "quit" },
    ],
  });
  const selects: Array<{ activated: string | null; open: boolean }> = [];
  const dismisses: Array<{ open: boolean }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const selectCount = () => selects.length;
  const dismissCount = () => dismisses.length;
  // Accessors: menuKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const highlightOf = () => menu.props.highlighted as number;

  // Register the menu node with the manager: routed keys drive it via the
  // core `menuKey`, firing onSelect/onDismiss like React's `<Menu focusId>`.
  const focusHandle = useFocus("s-menu", menu, (event) => {
    const next = menuKey(menu, event);
    if (next.activated !== null) {
      selects.push(next);
    } else if (event.name === "escape") {
      dismisses.push(next);
    }
  }, manager);
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("s-menu")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 0 || selectCount() !== 0) {
    throw new Error("unfocused menu must not receive keys");
  }

  // Focused: down moves the highlight (clamped into the visible items).
  if (!manager.focus("s-menu")) throw new Error("focus(s-menu) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 1) throw new Error(`highlight = ${highlightOf()}`);
  if (menu.children[1]?.props.reversed !== true) {
    throw new Error("the highlighted row must be reversed after down");
  }

  // Down onto the leaf row, then Enter activates it and fires onSelect with
  // the item's key (a leaf activation also dismisses the menu).
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

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("s-menu")) throw new Error("menu must unregister on dispose");
});

Deno.test("subscribeMenuMouse maps hover/click onto menuHover/menuClick; a closed menu ignores them", () => {
  const { renderer, mouseHandlers, renderCalls } = mockRenderer();
  const menu = Menu({
    items: [
      { label: "New", id: "new" },
      { label: "Open", id: "open", children: [{ label: "File", id: "file" }] },
      { label: "Quit", id: "quit" },
    ],
    open: true,
  });
  const results: Array<MenuState> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const resultCount = () => results.length;
  const dispose = subscribeMenuMouse(renderer, menu, (state) => results.push(state));
  const highlightOf = () => menu.props.highlighted as number;
  const emit = (kind: string, column: number, row: number): void => {
    for (const handler of mouseHandlers) handler(mouseEvent(kind, column, row));
  };

  // A hover on row 2 moves the highlight there (menuHover) and reports it.
  emit("moved", 0, 2);
  if (highlightOf() !== 2) throw new Error(`hover highlight = ${highlightOf()}`);
  if (resultCount() !== 1 || results[0]!.highlighted !== 2) {
    throw new Error(`hover result = ${JSON.stringify(results[0])}`);
  }

  // Hovering a branch row moves the highlight back without opening it.
  emit("moved", 0, 1);
  if (highlightOf() !== 1) throw new Error(`branch hover = ${highlightOf()}`);

  // A click on a branch opens its submenu — the inline rows grow to include
  // the child (and no leaf activates).
  emit("down_left", 0, 1);
  if (resultCount() !== 3 || results[2]!.activated !== null) {
    throw new Error(`branch click result = ${JSON.stringify(results[2])}`);
  }
  if (menu.children.length !== 4) throw new Error(`rows after branch click = ${menu.children.length}`);
  if (menu.children[2]?.props.text !== "  File") {
    throw new Error(`child row = ${menu.children[2]?.props.text}`);
  }

  // A click on the now-visible leaf activates it (the result's `activated`
  // carries the item's key) and dismisses the menu.
  const before = renderCalls.length;
  emit("down_left", 0, 3);
  if (resultCount() !== 4 || results[3]!.activated !== "quit") {
    throw new Error(`leaf click result = ${JSON.stringify(results[3])}`);
  }
  if (results[3]!.open !== false) throw new Error("a leaf click must dismiss the menu");
  if (renderCalls.length <= before) throw new Error("a click must repaint the scene");

  // A closed menu ignores both hover and click: the highlight stays put and
  // no result is reported.
  const closedHighlight = () => menu.props.highlighted as number;
  const closedResults = resultCount();
  emit("moved", 0, 99);
  emit("down_left", 0, 99);
  if (closedHighlight() !== 3) throw new Error("a closed menu must ignore hover");
  if (resultCount() !== closedResults) throw new Error("a closed menu must ignore clicks");

  dispose();
  const countBeforeDispose = resultCount();
  emit("moved", 0, 1);
  if (resultCount() !== countBeforeDispose) {
    throw new Error("a disposed subscription must not dispatch");
  }
});

// Modal: factory parity + focus save/restore through openModal/closeModal
// ---------------------------------------------------------------------------

Deno.test("Modal factory materializes the core element with a backdrop, content box and z_index", () => {
  const body = Text({ text: "hi" });
  const modal = Modal({ open: true, content: [body] });
  if (modal.type !== "modal") throw new Error(`type = ${modal.type}`);
  if (modal.props.z_index !== MODAL_Z_INDEX) throw new Error(`z_index = ${modal.props.z_index}`);
  if (modal.props.position !== "absolute") throw new Error(`position = ${modal.props.position}`);
  if (modal.props.open !== true) throw new Error(`open = ${modal.props.open}`);
  // Composition: a dimmed backdrop fill + a centered content box holding the
  // content nodes.
  if (modal.children.length !== 2) throw new Error(`children = ${modal.children.length}`);
  if (modal.children[0]?.props.position !== "absolute") {
    throw new Error("backdrop must be an absolute fill");
  }
  if (modal.children[1]?.children[0] !== body) {
    throw new Error("content must live inside the content box");
  }
  // The content node list is JS bookkeeping, never a scene prop.
  if ("content" in modal.props) throw new Error("content must not reach the scene props");
  // The universal renderer's createElement("modal") materializes a default
  // (closed, empty) overlay without throwing.
  if (createElement("modal").type !== "modal") throw new Error("createElement(modal) mapping");
});

Deno.test("Modal openModal/closeModal save and restore focus on solid", () => {
  const modal = Modal({});
  const manager = new FocusManager();
  const inside = Box();
  const outside = Box();
  // The overlay's focusable registers first, so openModal's focusFirst()
  // lands inside; the outside focusable is the prior focus closing restores.
  const insideHandle = useFocus("s-modal-in", inside, () => {}, manager);
  const outsideHandle = useFocus("s-modal-out", outside, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  const open = (): unknown => modal.props.open;
  const hidden = (): unknown => modal.props.hidden;
  try {
    if (open() !== false || hidden() !== true) throw new Error("modal must start hidden");
    manager.focus("s-modal-out");
    openModal(modal, manager);
    if (activeId() !== "s-modal-in") {
      throw new Error(`open must focus the overlay's focusable, got ${activeId()}`);
    }
    if (open() !== true || hidden() !== false) throw new Error("openModal must show the overlay");
    closeModal(modal, manager);
    if (activeId() !== "s-modal-out") {
      throw new Error(`close must restore the prior focus, got ${activeId()}`);
    }
    if (open() !== false || hidden() !== true) throw new Error("closeModal must hide the overlay");
  } finally {
    insideHandle.dispose();
    outsideHandle.dispose();
    manager.blur();
  }
});

Deno.test("Table factory materializes the core element with a sticky header and rows", () => {
  const table = Table({
    columns: [
      { key: "name", header: "Name", width: 10 },
      { key: "score", header: "Score", width: 5, align: "right" },
    ],
    rows: [
      ["Ada", 92],
      ["Grace", 88],
      ["Linus", 95],
    ],
    highlight: 1,
    clip_height: 2,
  });
  if (table.type !== "table") throw new Error(`type = ${table.type}`);
  if (table.props.highlight !== 1 || table.props.sticky_header !== true) {
    throw new Error(`table props = ${JSON.stringify(table.props)}`);
  }
  if ("columns" in table.props || "rows" in table.props) {
    throw new Error("columns/rows must not reach the scene props");
  }
  // Sticky structure: header row (child 0) + content region (child 1).
  const header = table.children[0];
  const region = table.children[1];
  if (header?.props.flex_direction !== "row" || header?.props.z_index !== 1) {
    throw new Error("the sticky header must be a row box above the content");
  }
  if (header?.children.length !== 2 || header?.children[0]?.props.text !== "Name".padEnd(10)) {
    throw new Error(`header cells = ${JSON.stringify(header?.children.map((c) => c.props.text))}`);
  }
  // The content region is windowed: only the visible rows are materialized
  // (clip_height 2 at scroll 0), not one node per data row.
  if (region === undefined || region.children.length !== 2) {
    throw new Error(`rows = ${region?.children.length}`);
  }
  // Per-column alignment: the score column is right-padded.
  if (region.children[0]?.children[1]?.props.text !== "92".padStart(5)) {
    throw new Error(`score cell = ${JSON.stringify(region.children[0]?.children[1]?.props.text)}`);
  }
  // The highlighted row (index 1) is reversed; the others are not.
  if (region.children[1]?.children.every((cell) => cell.props.reversed === true) !== true) {
    throw new Error("the highlighted row's cells must be reversed");
  }
  if (region.children[0]?.children.some((cell) => cell.props.reversed === true)) {
    throw new Error("only the highlighted row may be reversed");
  }
  // The renderer surface maps the roadmap tag (as an empty table).
  if (createElement("table").type !== "table") throw new Error("createElement(table) mapping");
});

Deno.test("tableKey moves the highlight and clamps the scroll window on a solid table", () => {
  const table = Table({
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
    clip_height: 2,
  });
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Accessors: tableKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const highlightOf = () => table.props.highlight as number | undefined;
  const liveRegion = () => table.children[1];
  const regionScrollY = () => liveRegion()?.props.scroll_y as number | undefined;

  const down1 = tableKey(table, { name: "down", ...base }); // highlight 1
  if (down1.highlight !== 1) throw new Error(`down = ${down1.highlight}`);
  const down2 = tableKey(table, { name: "down", ...base }); // highlight 2 -> scroll 1
  if (down2.highlight !== 2 || down2.scroll_y !== 1) {
    throw new Error(`down2 = ${JSON.stringify(down2)}`);
  }
  // Down to the last row: scroll_y clamps at rows.length - clip_height = 2.
  let last = down2;
  for (let i = 0; i < 4; i++) last = tableKey(table, { name: "down", ...base });
  if (last.highlight !== 3 || last.scroll_y !== 2) {
    throw new Error(`clamped = ${JSON.stringify(last)}`);
  }
  if (highlightOf() !== 3) throw new Error(`node highlight = ${highlightOf()}`);
  if (regionScrollY() !== 2) throw new Error(`region scroll_y = ${regionScrollY()}`);
  // The visible window under scroll: the last 2 rows.
  const visible = visibleTableRows(table);
  if (visible.length !== 2 || visible[0]?.[0] !== "Linus") {
    throw new Error(`visible = ${JSON.stringify(visible.map((r) => r[0]))}`);
  }
  // Up back to the top clamps scroll_y at 0.
  let up = last;
  for (let i = 0; i < 6; i++) up = tableKey(table, { name: "up", ...base });
  if (up.highlight !== 0 || up.scroll_y !== 0) {
    throw new Error(`up = ${JSON.stringify(up)}`);
  }
});

// Tree: factory parity + treeKey routing through the FocusManager
// ---------------------------------------------------------------------------

Deno.test("Tree factory materializes the core element with windowed rows and glyphs", () => {
  const nodes: TreeNode[] = [
    { label: "src", children: [{ label: "index.ts" }, { label: "util.ts" }] },
    { label: "package.json" },
  ];
  const tree = Tree({ nodes, clip_height: 5 });
  if (tree.type !== "tree") throw new Error(`type = ${tree.type}`);
  if (tree.props.flex_direction !== "column") throw new Error(`flex_direction = ${tree.props.flex_direction}`);
  // The model + bookkeeping never reach the scene props.
  if ("nodes" in tree.props || "expanded" in tree.props || "indent" in tree.props) {
    throw new Error("nodes/expanded/indent must not reach the scene props");
  }
  // Collapsed: one leaf per top-level node; the first (highlighted) reversed.
  if (tree.children.length !== 2) throw new Error(`rows = ${tree.children.length}`);
  if (tree.children[0]?.props.reversed !== true) throw new Error("row 0 must be highlighted");
  // The renderer surface maps the roadmap tag (as an empty tree).
  if (createElement("tree").type !== "tree") throw new Error("createElement(tree) mapping");
});

Deno.test("treeKey routes through the FocusManager to a focused tree node", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const tree = Tree({
    nodes: [
      { label: "src", children: [{ label: "index.ts" }, { label: "util.ts" }] },
      { label: "package.json" },
    ],
  });
  const changes: Array<{ highlight: number; count: number }> = [];
  const changeCount = () => changes.length;
  const highlightOf = () => tree.props.highlight as number;
  const rowCount = () => tree.children.length;

  const focusHandle = useFocus("s-tree", tree, (event) => {
    const beforeHighlight = highlightOf();
    const beforeScroll = (tree.props.scroll_y as number) ?? 0;
    const beforeRows = rowCount();
    const next = treeKey(tree, event);
    const changed = next.highlight !== beforeHighlight ||
      next.scroll_y !== beforeScroll ||
      rowCount() !== beforeRows;
    if (changed) changes.push(next);
  }, manager);
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (!manager.has("s-tree")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (changeCount() !== 0 || highlightOf() !== 0) {
    throw new Error("unfocused tree must not receive keys");
  }

  // Focused: right expands the highlighted `src` branch (2 children appear).
  if (!manager.focus("s-tree")) throw new Error("focus(s-tree) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ name: "right" }));
  if (changeCount() !== 1 || changes[0]!.count !== 4) {
    throw new Error(`expand = ${JSON.stringify(changes)}`);
  }
  if (rowCount() !== 4) throw new Error(`rows after expand = ${rowCount()}`);

  // down walks into the first child.
  for (const handler of keyHandlers) handler(keyEvent({ name: "down" }));
  if (highlightOf() !== 1) throw new Error(`down highlight = ${highlightOf()}`);
  if (visibleTreeRows(tree)[1]?.node.label !== "index.ts") {
    throw new Error(`child row = ${visibleTreeRows(tree)[1]?.node.label}`);
  }

  focusHandle.dispose();
  disposeTreeFocus(tree);
  dispose();
});

Deno.test("expandTreeNode drives a solid tree node in place", () => {
  const tree = Tree({ nodes: [{ label: "root", children: [{ label: "child" }] }] });
  if (visibleTreeRows(tree).length !== 1) throw new Error("starts collapsed");
  if (expandTreeNode(tree, "0") !== true) throw new Error("expand must report a change");
  if (visibleTreeRows(tree).length !== 2) throw new Error(`after expand = ${visibleTreeRows(tree).length}`);
});

// Tabs: factory parity + tabsKey routing through the FocusManager
// ---------------------------------------------------------------------------

Deno.test("Tabs factory materializes the core element with a tab bar and content region", () => {
  const tabs = Tabs({
    tabs: [
      { label: "logs", content: [Text({ text: "log line" })] },
      { label: "files", content: [Text({ text: "file list" })] },
    ],
  });
  if (tabs.type !== "tabs") throw new Error(`type = ${tabs.type}`);
  if (tabs.props.flex_direction !== "column") throw new Error(`flex_direction = ${tabs.props.flex_direction}`);
  if (tabs.props.active !== 0) throw new Error(`active = ${tabs.props.active}`);
  // The tab list is JS bookkeeping, never a scene prop.
  if ("tabs" in tabs.props) throw new Error("tabs must not reach the scene props");
  // Composition: the tab bar row (child 0) + the content region (child 1).
  const bar = tabs.children[0];
  const region = tabs.children[1];
  if (bar?.props.flex_direction !== "row") throw new Error("the tab bar must be a row box");
  if (bar?.children.length !== 2 || bar.children[0]?.props.text !== "▔logs") {
    throw new Error(`tab leaves = ${JSON.stringify(bar?.children.map((c) => c.props.text))}`);
  }
  // The active tab is painted with the primary palette and reversed.
  if (bar?.children[0]?.props.reversed !== true || bar?.children[0]?.props.fg === undefined) {
    throw new Error("the active tab must be reversed with the primary fg");
  }
  // Only the active tab's content is materialized in the region.
  if (region?.children.length !== 1 || region?.children[0]?.props.text !== "log line") {
    throw new Error("the content region must hold the active tab's content");
  }
  // The renderer surface maps the roadmap tag.
  if (createElement("tabs").type !== "tabs") throw new Error("createElement(tabs) mapping");
});

Deno.test("tabsKey routes through the FocusManager to a focused tabs node", () => {
  const { renderer, keyHandlers } = mockRenderer();
  const manager = new FocusManager();
  const tabs = Tabs({
    tabs: [
      { label: "a", content: [Text({ text: "A" })] },
      { label: "b", content: [Text({ text: "B" })] },
      { label: "c", content: [Text({ text: "C" })] },
    ],
  });
  const changes: Array<{ active: number; count: number }> = [];
  const closes: Array<{ active: number; count: number }> = [];
  // Length read through a function: TS narrows a const-typed empty array's
  // `length` to 0 (the pushes happen inside closures it cannot see).
  const changeCount = () => changes.length;
  const closeCount = () => closes.length;
  // Accessors: tabsKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const activeOf = () => tabs.props.active as number;
  const barLabels = () => tabs.children[0]?.children.map((leaf) => leaf.props.text).join(",");

  // Register the tabs node with the manager: routed keys drive it via the
  // core `tabsKey`, firing onChange/onClose-style callbacks like React's
  // `<Tabs focusId>`.
  const focusHandle = useFocus("s-tabs", tabs, (event) => {
    const beforeActive = activeOf();
    const barBefore = tabs.children[0]?.children.length ?? 0;
    const next = tabsKey(tabs, event);
    const closed = (tabs.children[0]?.children.length ?? 0) < barBefore;
    if (closed) closes.push(next);
    else if (next.active !== beforeActive) changes.push(next);
  }, manager);
  const dispose = subscribeInput(renderer, () => {}, { focusManager: manager });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  if (!manager.has("s-tabs")) throw new Error("useFocus must register the id");

  // Not focused: keys fall through to the tree handler (a no-op here).
  for (const handler of keyHandlers) handler(keyEvent({ name: "right" }));
  if (changeCount() !== 0 || activeOf() !== 0) {
    throw new Error("unfocused tabs must not receive keys");
  }

  // Focused: right moves the active tab (clamped at the ends).
  if (!manager.focus("s-tabs")) throw new Error("focus(s-tabs) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ name: "right" }));
  if (changeCount() !== 1 || changes[0]!.active !== 1) {
    throw new Error(`right = ${JSON.stringify(changes)}`);
  }
  if (activeOf() !== 1) throw new Error(`node active = ${activeOf()}`);
  if (barLabels() !== "a,▔b,c") throw new Error(`labels = ${barLabels()}`);

  // ctrl+tab wraps to the next tab; ctrl+shift+tab to the previous.
  for (const handler of keyHandlers) handler(keyEvent({ name: "tab", ctrl: true, shift: false }));
  if (changes[1]?.active !== 2) throw new Error(`ctrl+tab = ${JSON.stringify(changes[1])}`);
  for (const handler of keyHandlers) handler(keyEvent({ name: "tab", ctrl: true, shift: true }));
  if (changes[2]?.active !== 1) throw new Error(`ctrl+shift+tab = ${JSON.stringify(changes[2])}`);

  // ctrl+w closes the active tab (count shrinks) and fires onClose.
  for (const handler of keyHandlers) handler(keyEvent({ name: "w", ctrl: true, shift: false }));
  if (closeCount() !== 1 || closes[0]!.count !== 2 || closes[0]!.active !== 1) {
    throw new Error(`close = ${JSON.stringify(closes)}`);
  }
  if (barLabels() !== "a,▔c") throw new Error(`labels after close = ${barLabels()}`);

  dispose();
  if (keyHandlers.size >= 1) throw new Error("key handler must be detached on dispose");
  focusHandle.dispose();
  if (manager.has("s-tabs")) throw new Error("tabs must unregister on dispose");
});

Deno.test("activateTab/closeTab drive a solid tabs node; disposeTabsFocus releases it", () => {
  const tabs = Tabs({
    tabs: [
      { label: "a", content: [] },
      { label: "b", content: [] },
    ],
    focusId: "s-drive",
  });
  const activeOf = () => tabs.props.active as number;
  // The factory's focusId registration is owned by the node; disposing it
  // unregisters the id.
  const manager = focusManager;
  if (!manager.has("s-drive")) throw new Error("Tabs(focusId) must register with the core manager");
  activateTab(tabs, 1);
  if (activeOf() !== 1) throw new Error(`activate = ${activeOf()}`);
  closeTab(tabs, 0);
  if (activeOf() !== 0) throw new Error(`close shifts the active down = ${activeOf()}`);
  if (tabs.children[0]?.children.length !== 1) throw new Error(`bar = ${tabs.children[0]?.children.length}`);
  disposeTabsFocus(tabs);
  if (manager.has("s-drive")) throw new Error("disposeTabsFocus must unregister the id");
});

// Progress: factory parity + live setProgress updates
// ---------------------------------------------------------------------------

Deno.test("Progress factory materializes the core element with a framed gauge", () => {
  const progress = Progress({ value: 5, max: 10, width: 12, label: "work" });
  if (progress.type !== "progress") throw new Error(`type = ${progress.type}`);
  // The bar model state lives on the root box's props; the frame defaults to
  // a plain border.
  if (progress.props.value !== 5 || progress.props.max !== 10) {
    throw new Error(`bar model = ${JSON.stringify(progress.props)}`);
  }
  if (progress.props.border_style !== "plain" || progress.props.height !== 1) {
    throw new Error(`frame = ${JSON.stringify(progress.props)}`);
  }
  // The label is JS bookkeeping, never a scene prop.
  if ("label" in progress.props) throw new Error("label must not reach the scene props");
  // Composition: the fill leaf + the label overlay + the percentage readout
  // (inner width 10, ratio 0.5 => 5 filled cells).
  const bar = progress.children[0];
  if (bar === undefined || bar.type !== "text" || bar.props.text !== "▓▓▓▓▓░░░░░") {
    throw new Error(`fill = ${JSON.stringify(bar?.props.text)}`);
  }
  if (progress.children[1]?.props.text !== "work" || progress.children[1]?.props.dim !== true) {
    throw new Error("the label overlay must be composed");
  }
  if (progress.children[2]?.props.text !== "50%") {
    throw new Error(`readout = ${JSON.stringify(progress.children[2]?.props.text)}`);
  }
  // The renderer surface maps the roadmap tag.
  if (createElement("progress").type !== "progress") throw new Error("createElement(progress) mapping");
});

Deno.test("setProgress drives a solid progress node in place (no rebuild)", () => {
  const progress = Progress({ value: 1, max: 4, width: 12 });
  const barBefore = progress.children[0];
  const readoutBefore = progress.children[1];
  // Accessors: setProgress mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const barText = (): string => progress.children[0]?.props.text as string;
  const readoutText = (): string => progress.children[1]?.props.text as string;
  const maxOf = (): unknown => progress.props.max;

  setProgress(progress, 3);
  if (progress.props.value !== 3 || maxOf() !== 4) {
    throw new Error(`props = ${JSON.stringify(progress.props)}`);
  }
  if (progress.children[0] !== barBefore || progress.children[1] !== readoutBefore) {
    throw new Error("setProgress must not rebuild the composition");
  }
  if (barText() !== "▓▓▓▓▓▓▓▓░░") throw new Error(`bar = ${JSON.stringify(barText())}`);
  if (readoutText() !== "75%") throw new Error(`readout = ${JSON.stringify(readoutText())}`);

  setProgress(progress, 1, 2);
  if (maxOf() !== 2) throw new Error(`max = ${maxOf()}`);
  if (barText() !== "▓▓▓▓▓░░░░░") throw new Error(`bar after max override = ${JSON.stringify(barText())}`);
});

Deno.test("subscribeResize re-renders on resize events and detaches on dispose", () => {
  const { renderer, resizeHandlers, renderCalls } = mockRenderer();
  const sizes: Array<{ width: number; height: number }> = [];

  const dispose = subscribeResize(renderer, (size) => sizes.push(size));
  if (resizeHandlers.size !== 1) {
    throw new Error(`expected 1 resize handler, got ${resizeHandlers.size}`);
  }

  const rendersBeforeResize = renderCalls.length;
  for (const handler of resizeHandlers) handler({ width: 100, height: 30 });
  if (sizes.length !== 1 || sizes[0]!.width !== 100 || sizes[0]!.height !== 30) {
    throw new Error(`handler must receive the new size, got ${JSON.stringify(sizes)}`);
  }
  if (renderCalls.length <= rendersBeforeResize) {
    throw new Error(
      `subscribeResize must re-invoke renderer.render() on resize (${rendersBeforeResize} -> ${renderCalls.length})`,
    );
  }

  dispose();
  if (resizeHandlers.size >= 1) throw new Error("resize handler must be detached on dispose");
});

Deno.test("createTerminalDimensions seeds from renderer.size and tracks resizes reactively", () => {
  const { renderer, resizeHandlers, size } = mockRenderer();
  const dims = createTerminalDimensions(renderer);

  if (resizeHandlers.size !== 1) {
    throw new Error(`expected 1 resize handler, got ${resizeHandlers.size}`);
  }
  // Seeded from renderer.size at creation — the mock's initial 80x24.
  let current = dims.size();
  if (current.width !== size.width || current.height !== size.height) {
    throw new Error(
      `initial size = ${JSON.stringify(current)}, renderer.size = ${JSON.stringify(size)}`,
    );
  }

  // Each resize event replaces the accessor's value (signal writes are
  // synchronous, so the fresh read reflects the update immediately).
  for (const handler of resizeHandlers) handler({ width: 132, height: 43 });
  current = dims.size();
  if (current.width !== 132 || current.height !== 43) {
    throw new Error(`post-resize size = ${JSON.stringify(current)}`);
  }

  dims.dispose();
  if (resizeHandlers.size >= 1) throw new Error("resize handler must be detached on dispose");
});

Deno.test("subscribeFocus delivers focus events and detaches on dispose", () => {
  const { renderer, focusHandlers } = mockRenderer();
  const events: Array<{ focus_gained: boolean }> = [];

  const dispose = subscribeFocus(renderer, (event) => events.push(event));
  if (focusHandlers.size !== 1) {
    throw new Error(`expected 1 focus handler, got ${focusHandlers.size}`);
  }

  for (const handler of focusHandlers) handler({ focus_gained: true });
  for (const handler of focusHandlers) handler({ focus_gained: false });
  if (events.length !== 2 || events[0]!.focus_gained !== true || events[1]!.focus_gained !== false) {
    throw new Error(`focus payloads = ${JSON.stringify(events)}`);
  }

  dispose();
  if (focusHandlers.size >= 1) throw new Error("focus handler must be detached on dispose");
});

Deno.test("subscribeFocusTraversal moves focus forward on tab and backward on backtab with wrap", () => {
  const { renderer, keyHandlers, renderCalls } = mockRenderer();
  const manager = new FocusManager();
  const a = CoreBox();
  const b = CoreBox();
  const c = CoreBox();
  manager.register({ id: "a", node: a, onKey: () => {} });
  manager.register({ id: "b", node: b, onKey: () => {} });
  manager.register({ id: "c", node: c, onKey: () => {} });

  const dispose = subscribeFocusTraversal(renderer, manager);
  if (keyHandlers.size !== 1) {
    throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  }
  if (manager.activeId !== null) throw new Error("nothing must be focused initially");
  const baseline = renderCalls.length;
  const tab = () => {
    for (const handler of keyHandlers) handler(keyEvent({ name: "tab" }));
  };
  const backtab = () => {
    for (const handler of keyHandlers) handler(keyEvent({ name: "backtab" }));
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

  dispose();
  if (keyHandlers.size >= 1) throw new Error("traversal must detach on dispose");
});

Deno.test("subscribeFocusTraversal skips the excluded ids when moving", () => {
  const { renderer, keyHandlers, renderCalls } = mockRenderer();
  const manager = new FocusManager();
  const a = CoreBox();
  const b = CoreBox();
  const c = CoreBox();
  const d = CoreBox();
  manager.register({ id: "a", node: a, onKey: () => {} });
  manager.register({ id: "b", node: b, onKey: () => {} });
  manager.register({ id: "c", node: c, onKey: () => {} });
  manager.register({ id: "d", node: d, onKey: () => {} });

  const dispose = subscribeFocusTraversal(renderer, manager, ["b", "c"]);
  if (!manager.focus("a")) throw new Error("focus(a) must succeed");
  const baseline = renderCalls.length;

  for (const handler of keyHandlers) handler(keyEvent({ name: "tab" }));
  const afterTab = manager.activeId;
  if (afterTab !== "d") throw new Error(`tab must skip b and c, got ${afterTab}`);

  for (const handler of keyHandlers) handler(keyEvent({ name: "backtab" }));
  const afterBacktab = manager.activeId;
  if (afterBacktab !== "a") throw new Error(`backtab must skip c and b, got ${afterBacktab}`);
  if (renderCalls.length !== baseline + 2) {
    throw new Error(
      `each traversal must re-render once, renders = ${renderCalls.length} (baseline ${baseline})`,
    );
  }

  dispose();
});

Deno.test("subscribeFocusTraversal defaults to the core focusManager", () => {
  const { renderer, keyHandlers } = mockRenderer();
  focusManager.blur();
  try {
    focusManager.register({ id: "traversal-default-a", node: CoreBox(), onKey: () => {} });
    focusManager.register({ id: "traversal-default-b", node: CoreBox(), onKey: () => {} });
    const dispose = subscribeFocusTraversal(renderer);
    if (keyHandlers.size !== 1) {
      throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
    }

    for (const handler of keyHandlers) handler(keyEvent({ name: "tab" }));
    const afterTab = focusManager.activeId;
    if (afterTab !== "traversal-default-a") {
      throw new Error(`default manager must be the core focusManager, got ${afterTab}`);
    }
    for (const handler of keyHandlers) handler(keyEvent({ name: "backtab" }));
    const afterBacktab = focusManager.activeId;
    if (afterBacktab !== "traversal-default-b") {
      throw new Error(`default backtab must move backward, got ${afterBacktab}`);
    }

    dispose();
    if (keyHandlers.size >= 1) throw new Error("traversal must detach on dispose");
  } finally {
    focusManager.blur();
    focusManager.unregister("traversal-default-a");
    focusManager.unregister("traversal-default-b");
  }
});

Deno.test("startSpinner pauses ticks while unfocused and resumes on focus regain", async () => {
  const { renderer, renderCalls, focusHandlers } = mockRenderer();
  const spinner = Spinner();
  // The core `tick` stores the running frame counter on the node's props; it
  // is monotonic across ticks (the rendered glyph wraps), so it is the fake
  // tick counter for the test.
  const ticks = () => (typeof spinner.props.frame === "number" ? spinner.props.frame : 0);

  const dispose = startSpinner(renderer, spinner, { interval: 5 });
  if (focusHandlers.size !== 1) {
    throw new Error(`expected 1 focus handler, got ${focusHandlers.size}`);
  }

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

  // Disposal clears the interval and tears down the focus subscription.
  dispose();
  if (focusHandlers.size >= 1) throw new Error("focus handler must be detached on dispose");
  const frozen = ticks();
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (ticks() !== frozen) throw new Error("disposed driver must stop ticking");
});

// ---------------------------------------------------------------------------
// Panel drag-resize (subscribePanelDrag)
//
// The helper subscribes to the renderer's mouse events: `down_left` on the
// 1-cell gutter between adjacent panels starts a drag, each `drag_left`
// mutates the adjacent pane's `flex_basis` (clamped to the pane's min size)
// and re-renders, and `up_left` ends it. The panels tree attaches under a
// real core `Renderer` over the size-aware fake addon, so
// `Node.contentSize()` reports the per-handle laid-out sizes and the mouse
// events flow through the fake push stream callback.
// ---------------------------------------------------------------------------

Deno.test("subscribePanelDrag resizes a panels split on gutter drags and clamps to the pane min", () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const panels = Panels({
      panels: [
        { header: "A", body: Box() },
        { header: "B", body: Box() },
      ],
      direction: "column",
    });
    renderer.root.addChild(panels);
    // Laid-out sizes: panel A rows 0-2, gutter row 3, panel B rows 4-5,
    // stack 9 rows tall.
    fakeDragSizes.set(panels.handle, { width: 60, height: 9 });
    fakeDragSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
    fakeDragSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });

    const results: Array<unknown> = [];
    // Read through a function: TS narrows a const-typed empty array's
    // `length` to 0 (the pushes happen inside closures it cannot see).
    const resultCount = (): number => results.length;
    const dispose = subscribePanelDrag(renderer, panels, (result) => results.push(result));
    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };

    // down_left on gutter 0 starts the drag (results[0] = the handle).
    emit("down_left", 0, 3);
    if (resultCount() !== 1 || results[0] === null || (results[0] as { index: number }).index !== 0) {
      throw new Error(`start result = ${JSON.stringify(results[0])}`);
    }

    // drag_left down 1 cell: panel A's flex_basis 3 -> 4; the helper re-renders.
    emit("drag_left", 0, 4);
    const panelA = panels.children[0]!;
    // Read through a function so TS control-flow narrowing does not pin the
    // prop to the literal of the first assertion.
    const basis = (): number => panelA.props.flex_basis as number;
    if (basis() !== 4) {
      throw new Error(`flex_basis after drag = ${basis()}`);
    }
    if (resultCount() !== 2 || (results[1] as { flex_basis?: number }).flex_basis !== 4) {
      throw new Error(`drag result = ${JSON.stringify(results[1])}`);
    }

    // Drag far above the split: clamps to the pane min (1).
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

    dispose();
    const countBeforeDispose = resultCount();
    emit("down_left", 0, 3);
    if (resultCount() !== countBeforeDispose) {
      throw new Error("a disposed subscription must not dispatch");
    }
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    fakeDragSizes.clear();
  }
});

// ---------------------------------------------------------------------------
// removeNode bookkeeping: getNextSibling/getFirstChild stay correct
// ---------------------------------------------------------------------------

Deno.test("removeNode keeps getFirstChild/getNextSibling correct after removals", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  const b = createTextNode("b");
  const c = createTextNode("c");
  rendererOptions.insertNode(parent, a);
  rendererOptions.insertNode(parent, b);
  rendererOptions.insertNode(parent, c);

  // Remove the middle sibling: traversal must skip it entirely.
  rendererOptions.removeNode(parent, b);
  if (rendererOptions.getFirstChild(parent) !== a) {
    throw new Error("getFirstChild must still be a");
  }
  if (rendererOptions.getNextSibling(a) !== c) {
    throw new Error("a's next sibling must be c once b is removed");
  }
  if (rendererOptions.getParentNode(b) !== undefined) {
    throw new Error("removed node's parent registry entry must be cleared");
  }
  if (rendererOptions.getNextSibling(b) !== undefined) {
    throw new Error("removed node must not resolve a sibling");
  }
  if (parent.children.length !== 2 || parent.children.includes(b)) {
    throw new Error("parent.children must mirror the removal");
  }

  // Remove the first: getFirstChild advances.
  rendererOptions.removeNode(parent, a);
  if (rendererOptions.getFirstChild(parent) !== c) {
    throw new Error("getFirstChild must advance to c");
  }
  if (rendererOptions.getNextSibling(c) !== undefined) {
    throw new Error("c must be the last sibling");
  }

  // Remove the last: the parent is empty.
  rendererOptions.removeNode(parent, c);
  if (rendererOptions.getFirstChild(parent) !== undefined) {
    throw new Error("an emptied parent must have no first child");
  }
  if (parent.children.length >= 1) throw new Error("parent children must be empty");
});

Deno.test("replaceNode is fully reflected in parent.children (no stale entry)", () => {
  const parent = createElement("box");
  const a = createTextNode("a");
  const b = createTextNode("b");
  rendererOptions.insertNode(parent, a);
  rendererOptions.insertNode(parent, b);

  const x = createTextNode("x");
  replaceNode(x, a);

  // `x` takes `a`'s slot and `a` is spliced out: [x, b], and the traversal
  // callbacks agree.
  const children = parent.children;
  if (children.length !== 2 || children[0] !== x || children[1] !== b) {
    throw new Error(`children after replace = ${children.map((n) => n.props.text).join(",")}`);
  }
  if (rendererOptions.getFirstChild(parent) !== x) {
    throw new Error("getFirstChild must be the replacement");
  }
  if (rendererOptions.getNextSibling(x) !== b) {
    throw new Error("replacement's next sibling must be b");
  }
  if (rendererOptions.getParentNode(a) !== undefined) {
    throw new Error("replaced node's registry entry must be cleared");
  }
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

Deno.test("element factories resolve theme roles against the default theme", () => {
  const node = Text({ text: "err", role: "danger" });
  if (node.props.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`fallback fg = ${node.props.fg}`);
  }
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`fallback bg = ${node.props.bg}`);
  }
  // The semantic hints are consumed — never scene props.
  if ("role" in node.props || "component" in node.props) {
    throw new Error(`semantic hints leaked: ${JSON.stringify(node.props)}`);
  }
});

Deno.test("setTheme merges a partial theme over the default and getTheme round-trips", () => {
  const before = getTheme();
  try {
    setTheme({ palette: { danger: { fg: "#ff0000" } } });
    const after = getTheme();
    if (after.palette.danger.fg !== "#ff0000") throw new Error(`merged fg = ${after.palette.danger.fg}`);
    // Un-overridden role kept from the default.
    if (after.palette.success.fg !== defaultTheme.palette.success.fg) {
      throw new Error(`unoverridden role changed: ${after.palette.success.fg}`);
    }
    const node = Text({ text: "x", role: "danger" });
    if (node.props.fg !== "#ff0000") throw new Error(`stamped fg = ${node.props.fg}`);
    // The un-overridden bg comes from the default (merged, not replaced).
    if (node.props.bg !== defaultTheme.palette.danger.bg) {
      throw new Error(`merged bg = ${node.props.bg}`);
    }
  } finally {
    setTheme(before);
  }
});

Deno.test("setTheme component presets stamp onto the roadmap factories", () => {
  const before = getTheme();
  try {
    setTheme({ components: { status_bar: { fg: "#eeeeee", bg: "#111111" } } });
    const bar = StatusBar({ left: "L" });
    if (bar.props.fg !== "#eeeeee" || bar.props.bg !== "#111111") {
      throw new Error(`stamped strip = ${JSON.stringify(bar.props)}`);
    }
    // The preset resolution must not disturb the element's composition.
    if (bar.children.length !== 1 || bar.children[0]?.props.text !== "L") {
      throw new Error(`segments = ${bar.children.map((c) => c.props.text).join(",")}`);
    }
  } finally {
    setTheme(before);
  }
});

Deno.test("explicit props beat the theme stamps in solid factories", () => {
  const before = getTheme();
  try {
    setTheme({ palette: { danger: { fg: "#ff0000", bg: "#111111" } } });
    const node = Text({ text: "x", role: "danger", fg: "#00ff00" });
    if (node.props.fg !== "#00ff00") throw new Error(`explicit fg = ${node.props.fg}`);
    if (node.props.bg !== "#111111") throw new Error(`role bg = ${node.props.bg}`);
  } finally {
    setTheme(before);
  }
});

Deno.test("getTheme returns a full Theme", () => {
  const theme: Theme = getTheme();
  if (theme.palette.primary.fg === undefined || theme.palette.primary.bg === undefined) {
    throw new Error(`primary role incomplete: ${JSON.stringify(theme.palette.primary)}`);
  }
  if (theme.components.input === undefined) {
    throw new Error("input preset missing");
  }
});

Deno.test("M4.5 live switch: setTheme(B) after creation repaints existing elements to a fresh B tree", () => {
  const before = getTheme();
  try {
    // Elements created under theme A — a primitive tree (Box + Text) and a
    // roadmap element (Input), both resolved through the `primary` role.
    setTheme({ palette: { primary: { fg: "#aa1111", bg: "#aa2222" } } });
    const treeA = Box({ role: "primary", children: [Text({ text: "x", role: "primary" })] });
    const inputA = Input({ value: "v", role: "primary" });
    const propsUnderA = treeA.props;
    if (propsUnderA.fg !== "#aa1111" || inputA.props.fg !== "#aa1111") {
      throw new Error(`elements not created under theme A: ${JSON.stringify(propsUnderA)}`);
    }

    // Live switch: setTheme(B) re-resolves the recorded nodes in place.
    setTheme({ palette: { primary: { fg: "#bb3333", bg: "#bb4444" } } });

    // The existing primitive tree now snapshots identically to a fresh tree
    // created under theme B (and its nodes carry the B colors).
    const live = snapshot(treeA);
    const fresh = snapshot(Box({ role: "primary", children: [Text({ text: "x", role: "primary" })] }));
    if (!snapshotsEqual(live, fresh)) {
      throw new Error(`live tree != fresh B tree: ${JSON.stringify(live)} vs ${JSON.stringify(fresh)}`);
    }
    const propsAfterSwitch = treeA.props;
    if (propsAfterSwitch.fg !== "#bb3333" || treeA.children[0]?.props.fg !== "#bb3333") {
      throw new Error(`primitive live fg = ${JSON.stringify(propsAfterSwitch)}`);
    }

    // The roadmap element root re-resolves the same way.
    const freshInput = Input({ value: "v", role: "primary" });
    if (!snapshotsEqual(snapshot(inputA), snapshot(freshInput))) {
      throw new Error("input live tree != fresh B input tree");
    }
  } finally {
    setTheme(before);
  }
});

// ---------------------------------------------------------------------------
// Mouse wheel scroll + click-to-focus (subscribeWheelScroll / subscribeClickFocus)
//
// The subscriptions wire a renderer's mouse events over the size-aware fake
// addon (events flow through the push stream callback; `content_size` reads the
// per-handle registry; `hit_test` reads the configurable `solidFakeHitPath`):
// `subscribeWheelScroll` maps wheel events onto the given view's offsets
// (clamped) and re-renders on a consumed wheel; `subscribeClickFocus` routes
// a `down_left` on a painted cell to the topmost registered focusable via the
// core `FocusManager`.
// ---------------------------------------------------------------------------

Deno.test("subscribeWheelScroll scrolls the view on wheel events and re-renders on a consumed wheel", () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const view = ScrollView({
      width: 5,
      height: 2,
      children: [CoreText({ text: "aaaaaa\nbbbbb\ncc" })],
    });
    renderer.root.addChild(view);
    // Viewport 5x2, content leaf 6x3 -> max offsets (1, 1).
    fakeDragSizes.set(view.handle, { width: 5, height: 2 });
    const leaf = view.children.find((child) => child.type === "text");
    if (leaf === undefined) throw new Error("scroll view must compose a content leaf");
    fakeDragSizes.set(leaf.handle, { width: 6, height: 3 });
    solidFakeRenders.length = 0;

    const dispose = subscribeWheelScroll(renderer, view);
    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };
    const y = (): number => view.props.scroll_y as number;
    const renderCount = (): number => solidFakeRenders.length;

    emit("scroll_down", 0, 0);
    if (y() !== 1) throw new Error(`scroll_down scroll_y = ${y()}`);
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
    if (renderCount() !== rendersBefore) throw new Error("an unconsumed event must not re-render");

    // A direct wheelScroll call maps the same event on the same view.
    if (wheelScroll(view, { kind: "scroll_right", column: 0, row: 0, ctrl: false, alt: false, shift: false }) !== true) {
      throw new Error("scroll_right must be consumed");
    }
    if (view.props.scroll_x !== 1) throw new Error(`scroll_right scroll_x = ${view.props.scroll_x}`);

    dispose();
    const yAfterDispose = y();
    emit("scroll_down", 0, 0);
    if (y() !== yAfterDispose) throw new Error("a disposed subscription must not scroll");
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    solidFakeHitPath = [7n];
    solidFakeRenders.length = 0;
    fakeDragSizes.clear();
  }
});

Deno.test("subscribeClickFocus focuses the topmost registered node on a down_left and no-ops on an empty hit_test", () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    const node = Box();
    renderer.root.addChild(node);
    // Register on the shared core manager — `focusAt` (and therefore
    // `subscribeClickFocus`) routes through it by default.
    const handle = useFocus("probe", node, () => {}, focusManager);
    const dispose = subscribeClickFocus(renderer);
    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };

    // A down_left on a painted cell (fake hit path non-empty) focuses the box.
    emit("down_left", 3, 2);
    if (focusManager.activeId !== "probe") throw new Error(`active after click = ${focusManager.activeId}`);

    // The focused element now routes keys through subscribeInput: a char key
    // reaches its handler.
    const handled: string[] = [];
    useFocus("probe2", node, (event) => {
      if (event.name === "char") handled.push(event.char ?? "");
    }, focusManager);
    focusManager.blur();
    const inputDispose = subscribeInput(renderer, () => {});
    focusManager.focus("probe2");
    dispatchEvent({ type: "key", key: { name: "char", char: "z", ctrl: false, alt: false, shift: false } });
    if (handled.join("") !== "z") throw new Error(`handled chars = ${handled.join("")}`);
    inputDispose();

    // A press off any painted cell (empty hit path) is a no-op.
    solidFakeHitPath = [];
    focusManager.blur();
    emit("down_left", 0, 0);
    if (focusManager.activeId !== null) throw new Error(`active after empty hit = ${focusManager.activeId}`);

    dispose();
    handle.dispose();
    focusManager.blur();
    focusManager.unregister("probe2");
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    solidFakeHitPath = [7n];
    solidFakeRenders.length = 0;
    fakeDragSizes.clear();
    focusManager.blur();
  }
});

// ---------------------------------------------------------------------------
// Mouse selection (subscribeSelection)
//
// The subscription wires a renderer's mouse events over the selection-aware
// fake (`set_selection` / `clear_selection` / `selection_text` /
// `selection_word_range` / `set_clipboard` record into the module-level
// `solidFakeSelection` / `solidSelectionClipboard`, and `render()` paints the
// `solidSelectionRows` frame the text/word reads draw from): a `down_left`
// anchors the selection and re-renders (paints the overlay), a `drag_left`
// extends it, and an `up_*` release copies the selected text
// (copy-on-release) before clearing the overlay; a double-click (a second
// press on a nearby cell within SELECTION_DOUBLE_CLICK_MS ms) selects the
// word under the pointer instead; non-mouse events fall through; disposing
// the subscription stops the wiring.
// ---------------------------------------------------------------------------

/** Assert the solid fake's selection overlay equals `expected` (or is
 * `null` when the selection must be cleared). */
function assertSolidSelection(
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

Deno.test("subscribeSelection wires the core selection state machine (down/drag/up, copy-on-release, persistent overlay, double-click word select)", () => {
  setAddonForTesting(streamFakeAddon);
  try {
    const renderer = createRenderer();
    renderer.startEventStream();
    solidFakeRenders.length = 0;
    if (SELECTION_DOUBLE_CLICK_MS !== 500) {
      throw new Error(`SELECTION_DOUBLE_CLICK_MS = ${SELECTION_DOUBLE_CLICK_MS}`);
    }

    const dispose = subscribeSelection(renderer);
    const emit = (kind: string, column: number, row: number): void => {
      dispatchMouseEvent(kind, column, row);
    };
    const sel = (): { col1: number; row1: number; col2: number; row2: number } | null => solidFakeSelection;
    // Read through a function: TS control-flow narrowing would otherwise pin
    // the values to the literals of the first assertions.
    const clipboard = (): string | null => solidSelectionClipboard;
    const renderCount = (): number => solidFakeRenders.length;

    // A down_left anchors a 1-cell selection and re-renders (paints the
    // overlay at the next frame).
    emit("down_left", 6, 0);
    assertSolidSelection(sel(), { col1: 6, row1: 0, col2: 6, row2: 0 });
    if (renderCount() !== 1) throw new Error(`a down must re-render (renders = ${renderCount()})`);

    // A drag_left extends the selection to the dragged cell.
    emit("drag_left", 10, 0);
    assertSolidSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== 2) throw new Error(`a drag must re-render (renders = ${renderCount()})`);

    // An up_* release copies the selected text (copy-on-release) and ends
    // the session but leaves the overlay up (persistent selection): the
    // highlight survives until escape or a bare press outside it
    // (click-elsewhere) clears it.
    emit("up_left", 10, 0);
    if (clipboard() !== "world") throw new Error(`copy-on-release = ${JSON.stringify(clipboard())}`);
    assertSolidSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== 3) throw new Error(`an up must re-render (renders = ${renderCount()})`);

    // A non-mouse event falls through: the persistent overlay is untouched
    // and nothing re-renders.
    const rendersBefore = renderCount();
    dispatchEvent({ type: "key", key: { name: "char", char: "q", ctrl: false, alt: false, shift: false } });
    assertSolidSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderCount() !== rendersBefore) throw new Error("a key event must not re-render");

    // A double-click (a second press on a nearby cell within the window)
    // selects the word under the pointer instead of a 1-cell selection.
    setSelectionClockForTesting(() => 1000);
    emit("down_left", 6, 0); // 'w' of "world"
    emit("up_left", 6, 0);
    setSelectionClockForTesting(() => 1400); // +400 ms, inside the window
    emit("down_left", 6, 0);
    assertSolidSelection(sel(), { col1: 6, row1: 0, col2: 10, row2: 0 });
    emit("up_left", 6, 0);

    // A press two cells away is not a double-click even inside the window.
    setSelectionClockForTesting(() => 2000);
    emit("down_left", 6, 0);
    emit("up_left", 6, 0);
    setSelectionClockForTesting(() => 2300); // +300 ms, but 2 cells away
    emit("down_left", 8, 0);
    assertSolidSelection(sel(), { col1: 8, row1: 0, col2: 8, row2: 0 });
    emit("up_left", 8, 0);

    // Disposing the subscription stops the wiring: events no longer route.
    dispose();
    const rendersAfterDispose = renderCount();
    emit("down_left", 1, 0);
    assertSolidSelection(sel(), null);
    if (renderCount() !== rendersAfterDispose) {
      throw new Error(`a disposed subscription must not select (renders = ${renderCount()})`);
    }
  } finally {
    setAddonForTesting(null);
    streamCallback = null;
    solidFakeHitPath = [7n];
    solidFakeRenders.length = 0;
    solidFakeSelection = null;
    solidSelectionClipboard = null;
    fakeDragSizes.clear();
    setSelectionClockForTesting(() => Date.now());
  }
});
