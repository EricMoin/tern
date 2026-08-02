/**
 * Unit tests for the @tern/core factory API.
 *
 * These exercise the declarative surface (`Text`/`Box`/`Node`) without
 * touching the native addon or a real terminal: `Text`/`Box` build pure
 * node objects and native materialization is lazy (it happens on attach, and
 * constructing a `Renderer` enters raw mode and requires a PTY). The native
 * path — addon loading, scene materialization, render/poll/destroy — is
 * covered by the PTY smoke (`packages/core/smoke.mjs`), so these tests run
 * under plain `deno test` with no permission flags.
 *
 * Event dispatch (the `Renderer` `onKey`/`onResize`/`onFocus`/`onMouse`
 * subscriber sets and the tagged `TernEventJs` returned by `pollEvents`) is
 * exercised against a *fake* native addon injected through the
 * `setAddonForTesting` seam in `./addon.ts` — no `.node` binary is loaded.
 */

import {
  Box,
  DIFF_ADD_FG,
  DIFF_DEL_FG,
  DiffView,
  FocusManager,
  Input,
  Node,
  PANEL_DRAG_MIN_SIZE,
  Panels,
  SCROLLBAR_THUMB_CHAR,
  SCROLLBAR_TRACK_CHAR,
  SELECT_FILTER_PLACEHOLDER,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Text,
  THEME_COMPONENTS,
  THEME_ROLES,
  collapsePanel,
  createRenderer,
  defaultTheme,
  dragPanels,
  editKey,
  endPanelDrag,
  expandPanel,
  followTail,
  focusManager,
  focusPanel,
  isStreamFollowing,
  mergeTheme,
  name,
  resolveTheme,
  scrollBy,
  scrollTo,
  scrollTop,
  selectKey,
  startPanelDrag,
  syncStreamTail,
  tick,
  togglePanel,
  useFocus,
  version,
  visibleOptions,
} from "./index.ts";
import type {
  SelectOption,
  SelectProps,
  SelectState,
  Theme,
  ThemeOverrides,
  ThemeResolvableProps,
} from "./index.ts";
import { setAddonForTesting, loadAddon } from "./addon.ts";
import type { TernAddon } from "./addon.ts";
import type {
  KeyEvent,
  MouseEventJs,
  NodeHandle,
  Span,
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Fake native addon (event dispatch)
// ---------------------------------------------------------------------------

/** Events queued for the next fake `poll_events` call (consumed in order). */
const pendingEvents: TernEventJs[] = [];

/** The last `(col, row)` passed to the fake `hit_test`, or `null`. */
let lastHitTest: [number, number] | null = null;

/** The native node types materialized through the fake `create_node`. */
const createdNodes: Array<{ type: string; props: Record<string, unknown> | null }> = [];

/** Per-handle `content_size` overrides for the panel-drag geometry tests
 * (keyed by the `FakeNodeHandle` instance backing the node). */
const fakeContentSizes = new Map<object, { width: number; height: number }>();

/**
 * A fake native `NodeHandle` standing in for the real addon's scene handle.
 * `content_size` returns the per-handle override set via `fakeContentSizes`
 * (used by the panel-drag geometry tests) or a fixed size, so the geometry-
 * query tests exercise the @tern/core plumbing without the native `.node`
 * binary.
 */
class FakeNodeHandle {
  content_size(): { width: number; height: number } {
    return fakeContentSizes.get(this) ?? { width: 11, height: 2 };
  }
  add_child(child: unknown): unknown {
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    return child;
  }
  set_props(_props: unknown): void {}
  append_span(_text: string, _style?: unknown): void {}
  remove(): boolean {
    return true;
  }
}

/** A fake native `TuiRenderer` standing in for the real addon. */
class FakeTuiRenderer {
  destroyed = false;
  constructor(_options: unknown) {}
  root(): NodeHandle {
    // The `Renderer` constructor only stores this in `Node.wrapRoot`;
    // the dispatch tests never touch it.
    return new FakeNodeHandle() as unknown as NodeHandle;
  }
  poll_events(_timeoutMs: number): TernEventJs[] {
    return pendingEvents.splice(0);
  }
  hit_test(col: number, row: number): bigint[] {
    lastHitTest = [col, row];
    return [7n, 3n];
  }
  render(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** The fake addon injected through `setAddonForTesting`. */
const fakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) => {
    createdNodes.push({ type, props: props ?? null });
    return new FakeNodeHandle();
  },
} as unknown as TernAddon;

/** Run `fn` with the fake addon installed, resetting the seam afterwards. */
function withFakeAddon(fn: () => void): void {
  pendingEvents.length = 0;
  lastHitTest = null;
  createdNodes.length = 0;
  fakeContentSizes.clear();
  setAddonForTesting(fakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

Deno.test("core exports package metadata", () => {
  if (name !== "@tern/core") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.1.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("re-exported napi types are declared", () => {
  // Compile-time contract: the generated napi declarations must be reachable
  // through @tern/core. `KeyEvent`/`TuiRendererOptions`/`NodeHandle`/
  // `TuiRenderer` are type-only; this function body only needs to type-check.
  const ev: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  const opts: TuiRendererOptions = { exit_on_ctrl_c: true };
  let handle: NodeHandle | undefined;
  let renderer: TuiRenderer | undefined;
  if (opts.exit_on_ctrl_c && ev.char) {
    handle = undefined;
    renderer = undefined;
  }
  if (handle !== undefined || renderer !== undefined) {
    throw new Error("unreachable");
  }
});

Deno.test("Text builds a text node with props", () => {
  const node = Text({ text: "hello", bold: true, fg: "#ff0000" });
  if (!(node instanceof Node)) throw new Error("Text() must return a Node");
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (node.props.text !== "hello") throw new Error(`text = ${node.props.text}`);
  if (node.props.bold !== true) throw new Error(`bold = ${node.props.bold}`);
  if (node.props.fg !== "#ff0000") throw new Error(`fg = ${node.props.fg}`);
  if (node.children.length !== 0) throw new Error("text nodes have no children");
});

Deno.test("Text() with no props defaults to an empty prop map", () => {
  const node = Text();
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (Object.keys(node.props).length !== 0) {
    throw new Error(`expected empty props, got ${JSON.stringify(node.props)}`);
  }
});

Deno.test("Box builds a box node with children", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const node = Box({ border_style: "rounded", padding: 1 }, a, b);
  if (node.type !== "box") throw new Error(`type = ${node.type}`);
  if (node.props.border_style !== "rounded") {
    throw new Error(`border_style = ${node.props.border_style}`);
  }
  if (node.props.padding !== 1) throw new Error(`padding = ${node.props.padding}`);
  const children = node.children;
  if (children.length !== 2) throw new Error(`children.length = ${children.length}`);
  if (children[0] !== a || children[1] !== b) {
    throw new Error("children order not preserved");
  }
});

Deno.test("Box() without children yields an empty container", () => {
  const node = Box({ width: 10 });
  if (node.type !== "box") throw new Error(`type = ${node.type}`);
  if (node.children.length !== 0) throw new Error("expected no children");
  if (node.props.width !== 10) throw new Error(`width = ${node.props.width}`);
});

Deno.test("Text and Box return distinct node instances", () => {
  const first = Text({ text: "x" });
  const second = Text({ text: "y" });
  if (first === second) throw new Error("instances must be distinct");
  if (first.props.text !== "x" || second.props.text !== "y") {
    throw new Error("props not isolated per instance");
  }
});

Deno.test("props and children getters return copies", () => {
  const node = Box({ width: 5 }, Text({ text: "kid" }));
  node.props.width = 99;
  if (node.props.width !== 5) throw new Error("props getter must be a copy");
  const kids = node.children as Node[];
  kids.length = 0;
  if (node.children.length !== 1) throw new Error("children getter must be a copy");
});

Deno.test("addChild records children on a detached parent", () => {
  const parent = Box();
  const kid = Text({ text: "k" });
  const returned = parent.addChild(kid);
  if (returned !== kid) throw new Error("addChild must return the child");
  if (parent.children.length !== 1) throw new Error("child not recorded");
  if (parent.children[0] !== kid) throw new Error("wrong child recorded");
  if (parent.attached) throw new Error("detached parent must stay unattached");
  if (kid.attached) throw new Error("child must stay unattached");
});

Deno.test("addChild rejects duplicate children", () => {
  const parent = Box();
  const kid = Text({ text: "k" });
  parent.addChild(kid);
  let threw = false;
  try {
    parent.addChild(kid);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("adding the same child twice must throw");
});

Deno.test("insertBefore before-first and between siblings reflects the new order in children", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  const parent = Box({}, a, b, c);

  // Before-first: insert x ahead of the current first child `a`.
  const x = Text({ text: "x" });
  const returned = parent.insertBefore(x, a);
  if (returned !== x) throw new Error("insertBefore must return the child");
  let kids = parent.children;
  if (kids.length !== 4) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== x || kids[1] !== a || kids[2] !== b || kids[3] !== c) {
    throw new Error("insertBefore before-first must place the child ahead of the anchor");
  }

  // Between siblings: insert y between a and b.
  const y = Text({ text: "y" });
  parent.insertBefore(y, b);
  kids = parent.children;
  if (kids.length !== 5) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== x || kids[1] !== a || kids[2] !== y || kids[3] !== b || kids[4] !== c) {
    throw new Error("insertBefore between siblings must preserve the surrounding order");
  }

  // The detached parent (and the inserted children) stay unattached; the
  // reorder is recorded positionally and lands in the scene on attach.
  if (parent.attached) throw new Error("detached parent must stay unattached");
  if (x.attached || y.attached) throw new Error("inserted children must stay unattached");
});

Deno.test("insertBefore rejects an anchor that is not a child of this node", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  const foreign = Text({ text: "foreign" });
  let threw = false;
  try {
    parent.insertBefore(b, foreign);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("inserting before a foreign anchor must throw");
  const kids = parent.children;
  if (kids.length !== 1) throw new Error("failed insert must not mutate children");
  if (kids[0] !== a) throw new Error("failed insert must not reorder children");
});

Deno.test("insertBefore rejects duplicate children", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  parent.addChild(b);
  let threw = false;
  try {
    parent.insertBefore(a, b);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("inserting an existing child must throw");
  const kids = parent.children;
  if (kids.length !== 2) throw new Error("failed insert must not mutate children");
  if (kids[0] !== a || kids[1] !== b) throw new Error("failed insert must not reorder children");
});

Deno.test("setProps works on a detached template", () => {
  const node = Text({ text: "old" });
  node.setProps({ text: "new", bold: true });
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.bold !== true) throw new Error(`bold = ${node.props.bold}`);
});

Deno.test("StreamingText builds a streaming_text node", () => {
  const node = StreamingText();
  if (!(node instanceof Node)) throw new Error("StreamingText() must return a Node");
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  if (Object.keys(node.props).length !== 0) {
    throw new Error(`expected empty props, got ${JSON.stringify(node.props)}`);
  }
  if (node.children.length !== 0) throw new Error("streaming_text nodes have no children");
  const styled = StreamingText({ fg: "#00ff00", bold: true });
  if (styled.props.fg !== "#00ff00" || styled.props.bold !== true) {
    throw new Error("StreamingText must forward props");
  }
});

Deno.test("appendSpan on a detached node records spans", () => {
  const node = StreamingText();
  node.appendSpan("hello", { bold: true });
  node.appendSpan("world");
  const spans: readonly Span[] = node.spans;
  if (spans.length !== 2) throw new Error(`spans.length = ${spans.length}`);
  const first = spans[0];
  const second = spans[1];
  if (first === undefined || second === undefined) throw new Error("recorded spans missing");
  if (first.text !== "hello") throw new Error(`spans[0].text = ${first.text}`);
  if (first.style?.bold !== true) throw new Error("span style must be recorded");
  if (second.text !== "world") throw new Error(`spans[1].text = ${second.text}`);
  if (second.style !== undefined) throw new Error("omitted style must stay undefined");
  if (node.attached) throw new Error("node must stay unattached");
  (spans as Span[]).length = 0;
  if (node.spans.length !== 2) throw new Error("spans getter must return a copy");
});

Deno.test("setProps still works on streaming nodes", () => {
  const node = StreamingText({ text: "old" });
  node.setProps({ text: "new", fg: "#0000ff" });
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.fg !== "#0000ff") throw new Error(`fg = ${node.props.fg}`);
});

Deno.test("remove on a detached template returns false", () => {
  const node = Text({ text: "x" });
  if (node.remove() !== false) throw new Error("detached remove must return false");
  if (node.attached) throw new Error("node must stay unattached");
});

Deno.test("remove detaches the node from its parent's children list", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  parent.addChild(a);
  parent.addChild(b);
  parent.addChild(c);

  // A parentless node (here the detached `parent` itself) cannot be removed.
  if (parent.remove() !== false) throw new Error("parentless remove must return false");

  if (b.remove() !== true) throw new Error("remove must return true when the node is in a tree");
  const kids = parent.children;
  if (kids.length !== 2) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== c) {
    throw new Error("removed child must be spliced out of the children list");
  }
  if (b.attached) throw new Error("removed node must be detached");
});

Deno.test("remove is idempotent and the removed child can be re-added", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  parent.addChild(b);

  if (a.remove() !== true) throw new Error("first remove must return true");
  if (a.remove() !== false) throw new Error("second remove must return false");

  // The removed child is no longer blocked by the duplicate guard: re-adding
  // it appends a fresh scene entry at the end.
  parent.addChild(a);
  const kids = parent.children;
  if (kids.length !== 2) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== b || kids[1] !== a) {
    throw new Error("re-added child must be appended at the end");
  }
});

Deno.test("remove invalidates the whole subtree and re-attach restores it", () => {
  const parent = Box();
  const other = Text({ text: "other" });
  const childBox = Box({}, Text({ text: "deep" }));
  parent.addChild(childBox);
  parent.addChild(other);
  const deep = childBox.children[0]!;

  if (childBox.remove() !== true) throw new Error("subtree root remove must return true");
  const kids = parent.children;
  if (kids.length !== 1 || kids[0] !== other) {
    throw new Error("removed subtree must leave only the remaining sibling");
  }
  if (childBox.attached || deep.attached) {
    throw new Error("the whole subtree must be detached");
  }

  // Re-attaching the removed subtree re-materializes it as a unit (its
  // internal children are preserved).
  parent.insertBefore(childBox, other);
  const after = parent.children;
  if (after.length !== 2 || after[0] !== childBox || after[1] !== other) {
    throw new Error("re-inserted subtree must land before the anchor");
  }
  if (childBox.children.length !== 1 || childBox.children[0] !== deep) {
    throw new Error("subtree children must be preserved across remove/re-add");
  }
});

Deno.test("remove after an ordered insert keeps sibling order", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  const parent = Box({}, a, b, c);

  const x = Text({ text: "x" });
  parent.insertBefore(x, b);
  if (parent.children[1] !== x || parent.children[2] !== b) {
    throw new Error("insertBefore must place x before b");
  }

  x.remove();
  const kids = parent.children;
  if (kids.length !== 3) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== b || kids[2] !== c) {
    throw new Error("removing x must restore the original order");
  }

  parent.insertBefore(x, b);
  if (parent.children[1] !== x || parent.children[2] !== b) {
    throw new Error("re-inserting x must land before b again");
  }
});

Deno.test("the scene root cannot be removed", () => {
  // wrapRoot is @internal; the fake handle is never touched on this path
  // (remove() short-circuits on the root's missing parent).
  const root = Node.wrapRoot({} as never);
  if (root.remove() !== false) throw new Error("the scene root must not be removable");
  if (!root.attached) throw new Error("the scene root must stay attached");
});

Deno.test("createRenderer is a function accepting options", () => {
  if (typeof createRenderer !== "function") {
    throw new Error(`typeof createRenderer = ${typeof createRenderer}`);
  }
  // Not invoked here: constructing a renderer enters raw mode and needs a PTY,
  // and materializing nodes calls the native addon (needs --allow-ffi). The
  // full renderer lifecycle (render/pollEvents/onKey/destroy + native scene
  // materialization) is covered by the PTY smoke (packages/core/smoke.mjs).
});

// ---------------------------------------------------------------------------
// Event dispatch (fake native addon)
// ---------------------------------------------------------------------------

Deno.test("pollEvents dispatches resize events to onResize and unsubscribe stops dispatch", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const resized: Array<{ width: number; height: number }> = [];
    const unsub = renderer.onResize((size) => resized.push(size));
    const resize: TernEventJs = { type: "resize", width: 120, height: 40 };
    pendingEvents.push(resize);
    const returned = renderer.pollEvents(0);
    if (returned.length !== 1 || returned[0] !== resize) {
      throw new Error("pollEvents must return the resize event verbatim");
    }
    if (resized.length !== 1) throw new Error(`onResize calls = ${resized.length}`);
    if (resized[0]!.width !== 120 || resized[0]!.height !== 40) {
      throw new Error(`resize payload = ${JSON.stringify(resized[0])}`);
    }
    // Unsubscribing stops further dispatch.
    unsub();
    pendingEvents.push({ type: "resize", width: 10, height: 10 });
    renderer.pollEvents(0);
    if (resized.length !== 1) {
      throw new Error("unsubscribed onResize handler must not fire");
    }
  });
});

Deno.test("pollEvents dispatches key events to onKey with the KeyEvent payload", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const keys: KeyEvent[] = [];
    renderer.onKey((event) => keys.push(event));
    const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
    const tagged: TernEventJs = { type: "key", key };
    pendingEvents.push(tagged);
    const returned = renderer.pollEvents(0);
    if (returned.length !== 1 || returned[0] !== tagged) {
      throw new Error("pollEvents must return the key event verbatim");
    }
    if (keys.length !== 1 || keys[0] !== key) {
      throw new Error("onKey must receive the unwrapped KeyEvent payload");
    }
  });
});

Deno.test("pollEvents dispatches focus events to onFocus", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const focusEvents: Array<{ focus_gained: boolean }> = [];
    renderer.onFocus((event) => focusEvents.push(event));
    pendingEvents.push({ type: "focus", focus_gained: true });
    pendingEvents.push({ type: "focus", focus_gained: false });
    renderer.pollEvents(0);
    if (focusEvents.length !== 2) throw new Error(`onFocus calls = ${focusEvents.length}`);
    if (focusEvents[0]!.focus_gained !== true || focusEvents[1]!.focus_gained !== false) {
      throw new Error(`focus payloads = ${JSON.stringify(focusEvents)}`);
    }
    // Unsubscribe contract mirrors onKey: the removed handler never fires.
    let unsubscribedFired = 0;
    const unsub = renderer.onFocus(() => {
      unsubscribedFired++;
    });
    unsub();
    pendingEvents.push({ type: "focus", focus_gained: true });
    renderer.pollEvents(0);
    if (unsubscribedFired !== 0) {
      throw new Error("unsubscribed onFocus handler must not fire");
    }
  });
});

Deno.test("pollEvents dispatches mouse events to onMouse", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const mouseEvents: MouseEventJs[] = [];
    renderer.onMouse((event) => mouseEvents.push(event));
    const mouse: MouseEventJs = {
      kind: "down_left",
      column: 3,
      row: 7,
      ctrl: false,
      alt: false,
      shift: true,
    };
    pendingEvents.push({ type: "mouse", mouse });
    renderer.pollEvents(0);
    if (mouseEvents.length !== 1 || mouseEvents[0] !== mouse) {
      throw new Error("onMouse must receive the MouseEventJs payload");
    }
  });
});

Deno.test("pollEvents returns the tagged union verbatim", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const events: TernEventJs[] = [
      { type: "key", key: { name: "enter", ctrl: false, alt: false, shift: false } },
      { type: "resize", width: 80, height: 24 },
      { type: "focus", focus_gained: true },
      {
        type: "mouse",
        mouse: { kind: "moved", column: 1, row: 2, ctrl: false, alt: false, shift: false },
      },
    ];
    pendingEvents.push(...events);
    const returned = renderer.pollEvents(0);
    if (returned.length !== events.length) {
      throw new Error(`returned ${returned.length} events, expected ${events.length}`);
    }
    for (let i = 0; i < events.length; i++) {
      if (returned[i] !== events[i]) {
        throw new Error(`event ${i} must be passed through verbatim`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scene geometry queries (fake native addon)
// ---------------------------------------------------------------------------

Deno.test("Renderer.hit_test proxies (col, row) to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const path = renderer.hit_test(3, 2);
    if (lastHitTest === null || lastHitTest[0] !== 3 || lastHitTest[1] !== 2) {
      throw new Error(`hit_test received ${JSON.stringify(lastHitTest)}`);
    }
    // The fake returns the topmost path [7, 3] verbatim (u64 ids as bigint).
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`hit_test path = ${JSON.stringify(path)}`);
    }
  });
});

Deno.test("Node.contentSize proxies to the native handle", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const stream = StreamingText({ width: 8 });
    renderer.root.addChild(stream);
    // Attaching materialized the node through the fake `create_node` with the
    // streaming_text native type.
    const created = createdNodes[0];
    if (created === undefined || created.type !== "streaming_text") {
      throw new Error(`created native type = ${created?.type}`);
    }
    if (created.props?.width !== 8) {
      throw new Error(`created props = ${JSON.stringify(created.props)}`);
    }
    const size = stream.contentSize();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`contentSize = ${JSON.stringify(size)}`);
    }
  });
});

Deno.test("Node.contentSize on a detached node throws", () => {
  withFakeAddon(() => {
    const node = Text({ text: "x" });
    let threw = false;
    try {
      node.contentSize();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("contentSize on a detached node must throw");
  });
});

Deno.test("the mocked addon exposes hit_test and content_size natively", () => {
  withFakeAddon(() => {
    const addon = loadAddon();
    const renderer = new addon.TuiRenderer({ exit_on_ctrl_c: false });
    const path = renderer.hit_test(1, 1);
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`native hit_test = ${JSON.stringify(path)}`);
    }
    const handle = addon.create_node("text", { text: "hi" });
    const size = handle.content_size();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`native content_size = ${JSON.stringify(size)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Roadmap elements: Input
// ---------------------------------------------------------------------------

Deno.test("Input composes a box with a text leaf carrying value and caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  if (input.type !== "input") throw new Error(`type = ${input.type}`);
  if (input.props.value !== "ab") throw new Error(`value = ${input.props.value}`);
  if (input.props.caret !== 1) throw new Error(`caret = ${input.props.caret}`);
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("input must compose a text leaf");
  }
  if (leaf.props.text !== "ab") throw new Error(`leaf text = ${leaf.props.text}`);
  if (leaf.props.caret !== 1) throw new Error(`leaf caret = ${leaf.props.caret}`);
});

Deno.test("Input shows a dim placeholder when empty", () => {
  const input = Input({ placeholder: "type…" });
  const leaf = input.children[0];
  if (leaf === undefined) throw new Error("missing text leaf");
  if (leaf.props.text !== "type…") throw new Error(`placeholder = ${leaf.props.text}`);
  if (leaf.props.dim !== true) throw new Error(`dim = ${leaf.props.dim}`);
  if (leaf.props.caret !== 0) throw new Error(`caret = ${leaf.props.caret}`);
});

Deno.test("editKey inserts a char at the caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  const next = editKey(input, { name: "char", char: "X", ctrl: false, alt: false, shift: false });
  if (next.value !== "aXb") throw new Error(`value = ${next.value}`);
  if (next.caret !== 2) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "aXb") throw new Error(`node value = ${input.props.value}`);
  if (input.children[0]?.props.text !== "aXb") {
    throw new Error(`leaf text = ${input.children[0]?.props.text}`);
  }
});

Deno.test("editKey backspace removes the char before the caret", () => {
  const input = Input({ value: "ab", caret: 2 });
  const next = editKey(input, { name: "backspace", ctrl: false, alt: false, shift: false });
  if (next.value !== "a") throw new Error(`value = ${next.value}`);
  if (next.caret !== 1) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "a") throw new Error(`node value = ${input.props.value}`);
});

Deno.test("editKey moves the caret with arrows, home and end", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const mk = () => Input({ value: "abc", caret: 2 });
  const left = editKey(mk(), { name: "left", ...base });
  if (left.caret !== 1) throw new Error(`left caret = ${left.caret}`);
  const right = editKey(mk(), { name: "right", ...base });
  if (right.caret !== 3) throw new Error(`right caret = ${right.caret}`);
  const home = editKey(mk(), { name: "home", ...base });
  if (home.caret !== 0) throw new Error(`home caret = ${home.caret}`);
  const end = editKey(mk(), { name: "end", ...base });
  if (end.caret !== 3) throw new Error(`end caret = ${end.caret}`);
  // Movement at the boundaries is a no-op.
  const noLeft = editKey(Input({ value: "abc", caret: 0 }), { name: "left", ...base });
  if (noLeft.caret !== 0) throw new Error(`left at start = ${noLeft.caret}`);
  const noRight = editKey(Input({ value: "abc", caret: 3 }), { name: "right", ...base });
  if (noRight.caret !== 3) throw new Error(`right at end = ${noRight.caret}`);
  // Unknown keys leave the input unchanged.
  const unknown = editKey(mk(), { name: "tab", ...base });
  if (unknown.value !== "abc" || unknown.caret !== 2) {
    throw new Error(`tab must not edit: ${unknown.value}/${unknown.caret}`);
  }
});

Deno.test("editKey is multi-width aware for the caret column", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "コ" is a 2-column char: the caret after it sits at display column 2.
  const left = editKey(Input({ value: "コa", caret: 2 }), { name: "left", ...base });
  if (left.caret !== 0) throw new Error(`left over a wide char = ${left.caret}`);
  const right = editKey(Input({ value: "コa", caret: 0 }), { name: "right", ...base });
  if (right.caret !== 2) throw new Error(`right past a wide char = ${right.caret}`);
  // Inserting at column 2 lands between コ and a, and the caret advances by
  // the inserted char's width.
  const ins = editKey(Input({ value: "コa", caret: 2 }), { name: "char", char: "b", ...base });
  if (ins.value !== "コba") throw new Error(`inserted value = ${ins.value}`);
  if (ins.caret !== 3) throw new Error(`inserted caret = ${ins.caret}`);
  // Backspace over a wide char removes the whole glyph and steps two columns.
  const bs = editKey(Input({ value: "コ", caret: 2 }), { name: "backspace", ...base });
  if (bs.value !== "" || bs.caret !== 0) throw new Error(`backspace wide = ${bs.value}/${bs.caret}`);
});

// ---------------------------------------------------------------------------
// Roadmap elements: Spinner
// ---------------------------------------------------------------------------

Deno.test("Spinner renders a determinate bar of filled and empty cells", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  if (bar.type !== "spinner") throw new Error(`type = ${bar.type}`);
  if (bar.props.text !== "▓▓░░") throw new Error(`bar = ${bar.props.text}`);
  const full = Spinner({ value: 10, max: 10, width: 3 });
  if (full.props.text !== "▓▓▓") throw new Error(`full = ${full.props.text}`);
  const none = Spinner({ value: 0, max: 10, width: 3 });
  if (none.props.text !== "░░░") throw new Error(`empty = ${none.props.text}`);
  // Filled cells round up: 3/10 * 4 = 1.2 -> 2 cells.
  const ceilBar = Spinner({ value: 3, max: 10, width: 4 });
  if (ceilBar.props.text !== "▓▓░░") throw new Error(`ceil = ${ceilBar.props.text}`);
});

Deno.test("tick advances the indeterminate frame and wraps", () => {
  const spinner = Spinner({ frames: ["a", "b", "c"] });
  const text0 = spinner.props.text;
  if (text0 !== "a") throw new Error(`frame 0 = ${text0}`);
  const t1 = tick(spinner);
  if (t1 !== "b") throw new Error(`tick 1 = ${t1}`);
  const f1 = spinner.props.frame;
  if (f1 !== 1) throw new Error(`frame = ${f1}`);
  const t2 = tick(spinner);
  if (t2 !== "c") throw new Error(`tick 2 = ${t2}`);
  const t3 = tick(spinner);
  if (t3 !== "a") throw new Error(`tick wrap = ${t3}`);
  const f3 = spinner.props.frame;
  if (f3 !== 3) throw new Error(`frame wrap = ${f3}`);
});

Deno.test("tick on a determinate spinner leaves the bar unchanged", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  const before = bar.props.text;
  const next = tick(bar);
  if (next !== "▓▓░░") throw new Error(`next = ${next}`);
  if (bar.props.text !== before) throw new Error("determinate bar must not change on tick");
  if (bar.props.frame !== undefined) throw new Error(`frame = ${bar.props.frame}`);
});

// ---------------------------------------------------------------------------
// Roadmap elements: StatusBar
// ---------------------------------------------------------------------------

Deno.test("StatusBar composes left/center/right segment Text nodes", () => {
  const bar = StatusBar({ left: "L", center: "C", right: "R" });
  if (bar.type !== "status_bar") throw new Error(`type = ${bar.type}`);
  if (bar.props.flex_direction !== "row") throw new Error(`flex_direction = ${bar.props.flex_direction}`);
  if (bar.props.justify_content !== "space-between") {
    throw new Error(`justify_content = ${bar.props.justify_content}`);
  }
  if (bar.props.height !== 1) throw new Error(`height = ${bar.props.height}`);
  const kids = bar.children;
  if (kids.length !== 3) throw new Error(`segments = ${kids.length}`);
  const [left, center, right] = kids;
  if (left === undefined || left.type !== "text" || left.props.text !== "L") {
    throw new Error("left segment must be a Text with the segment text");
  }
  if (center?.props.text !== "C") throw new Error("center segment text");
  if (right?.props.text !== "R") throw new Error("right segment text");
});

Deno.test("StatusBar accepts node segments, omits missing ones, and lifts segment keys out of the strip props", () => {
  const rightNode = Text({ text: "R" });
  const bar = StatusBar({ left: "only", right: rightNode });
  const kids = bar.children;
  if (kids.length !== 2) throw new Error(`segments = ${kids.length}`);
  if (kids[0]?.props.text !== "only") throw new Error(`left text = ${kids[0]?.props.text}`);
  if (kids[1] !== rightNode) throw new Error("a node segment must be used verbatim");
  // left/right are absolute-position inset keywords in tern-layout; the
  // segment keys must never reach the strip's props.
  if ("left" in bar.props || "right" in bar.props || "center" in bar.props) {
    throw new Error(`segment keys leaked into strip props: ${JSON.stringify(bar.props)}`);
  }
});

// ---------------------------------------------------------------------------
// Roadmap elements: Panels
// ---------------------------------------------------------------------------

Deno.test("Panels builds header + body panels with an active index", () => {
  const bodyA = Text({ text: "a-body" });
  const bodyB = Text({ text: "b-body" });
  const panels = Panels({ panels: [{ header: "A", body: bodyA }, { header: "B", body: bodyB }], active: 1 });
  if (panels.type !== "panels") throw new Error(`type = ${panels.type}`);
  if (panels.props.active !== 1) throw new Error(`active = ${panels.props.active}`);
  if (panels.props.flex_direction !== "column") throw new Error(`direction = ${panels.props.flex_direction}`);
  const kids = panels.children;
  if (kids.length !== 2) throw new Error(`panels = ${kids.length}`);
  const first = kids[0]!;
  const second = kids[1]!;
  if (first.type !== "box") throw new Error(`panel type = ${first.type}`);
  if (first.children.length !== 2) throw new Error("panel A must have header + body");
  if (first.children[0]?.props.text !== "A") throw new Error(`header = ${first.children[0]?.props.text}`);
  if (first.children[1] !== bodyA) throw new Error("panel A body must be the given node");
  if (second.children[1] !== bodyB) throw new Error("panel B body must be the given node");
  // The active panel's header is bold; inactive headers are not.
  if (second.children[0]?.props.bold !== true) throw new Error("active header must be bold");
  if (first.children[0]?.props.bold !== false) throw new Error("inactive header must not be bold");
});

Deno.test("Panels builds collapsed panels header-only", () => {
  const body = Text({ text: "x" });
  const panels = Panels({ panels: [{ header: "A", body, collapsed: true }] });
  const panel = panels.children[0]!;
  if (panel.children.length !== 1) throw new Error(`collapsed children = ${panel.children.length}`);
  if (panel.children[0]?.props.text !== "A") throw new Error("header must be retained");
});

Deno.test("togglePanel collapses and restores a panel body", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  const collapsed = togglePanel(panels, 0);
  if (collapsed !== true) throw new Error("toggle must collapse");
  const collapsedCount = panel.children.length;
  if (collapsedCount !== 1) throw new Error(`collapsed children = ${collapsedCount}`);
  if (body.attached) throw new Error("removed body must be detached");
  const expanded = togglePanel(panels, 0);
  if (expanded !== false) throw new Error("toggle must expand");
  const expandedCount = panel.children.length;
  if (expandedCount !== 2) throw new Error(`expanded children = ${expandedCount}`);
  if (panel.children[1] !== body) throw new Error("restored body must be the same node");
});

Deno.test("collapsePanel and expandPanel are idempotent and ignore bad indices", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  collapsePanel(panels, 0);
  collapsePanel(panels, 0);
  const afterCollapse = panel.children.length;
  if (afterCollapse !== 1) throw new Error(`double collapse must be a no-op (${afterCollapse})`);
  expandPanel(panels, 0);
  expandPanel(panels, 0);
  const afterExpand = panel.children.length;
  if (afterExpand !== 2) throw new Error(`double expand must be a no-op (${afterExpand})`);
  collapsePanel(panels, 99);
  const afterBad = panel.children.length;
  if (afterBad !== 2) throw new Error(`collapsing a bad index must be a no-op (${afterBad})`);
});

Deno.test("focusPanel moves the active index and restyles headers", () => {
  const panels = Panels({
    panels: [{ header: "A", body: Text({ text: "1" }) }, { header: "B", body: Text({ text: "2" }) }],
  });
  const initialActive = panels.props.active;
  if (initialActive !== 0) throw new Error(`initial active = ${initialActive}`);
  focusPanel(panels, 1);
  const newActive = panels.props.active;
  if (newActive !== 1) throw new Error(`active after focus = ${newActive}`);
  if (panels.children[1]?.children[0]?.props.bold !== true) {
    throw new Error("new active header must be bold");
  }
  if (panels.children[0]?.children[0]?.props.bold !== false) {
    throw new Error("old active header must be un-bolded");
  }
});

// ---------------------------------------------------------------------------
// Panel drag-resize
//
// The drag helpers locate the 1-cell gutter between adjacent panels from the
// laid-out extents (`Node.contentSize()` over the fake addon, keyed per
// handle in `fakeContentSizes`) and map `down_left` -> `drag_left` -> `up_left`
// to absolute `flex_basis` changes on the pane above/left of the gutter,
// clamped to the pane's min size (and the neighbor's min as the upper bound).
// ---------------------------------------------------------------------------

/** Build a mouse event payload. */
function mouse(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

/**
 * Build a 3-panel column stack attached under a fake-addon renderer root and
 * record laid-out sizes: the stack is 9 rows tall (panel A rows 0-2, gutter
 * row 3, panel B rows 4-5, gutter row 6, panel C rows 7-8). Panels are 60
 * cells wide.
 */
function attachedPanels(): { renderer: ReturnType<typeof createRenderer>; panels: Node } {
  const renderer = createRenderer();
  const panels = Panels({
    panels: [
      { header: "A", body: Box() },
      { header: "B", body: Box() },
      { header: "C", body: Box() },
    ],
    direction: "column",
  });
  renderer.root.addChild(panels);
  fakeContentSizes.set(panels.handle, { width: 60, height: 9 });
  fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
  fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
  fakeContentSizes.set(panels.children[2]!.handle, { width: 60, height: 2 });
  return { renderer, panels };
}

Deno.test("Panels defaults to a 1-cell gutter gap (an explicit gap wins)", () => {
  const a = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }] });
  if (a.props.gap !== 1) throw new Error(`default gap = ${a.props.gap}`);
  const b = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }], gap: 0 });
  if (b.props.gap !== 0) throw new Error(`explicit gap = ${b.props.gap}`);
});

Deno.test("startPanelDrag grabs a gutter on down_left and dragPanels mutates the adjacent pane's flex_basis", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();

    // Press on gutter 0 (row 3): between panel A (rows 0-2) and panel B.
    const started = startPanelDrag(panels, mouse("down_left", 0, 3));
    if (started === null || started.index !== 0 || started.direction !== "column") {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }

    // Drag down 1 cell: panel A's flex_basis grows 3 -> 4.
    const r1 = dragPanels(panels, mouse("drag_left", 0, 4));
    if (r1 === null || r1.flex_basis !== 4 || r1.index !== 0) {
      throw new Error(`drag 1 = ${JSON.stringify(r1)}`);
    }
    if (panels.children[0]!.props.flex_basis !== 4) {
      throw new Error(`flex_basis after drag = ${panels.children[0]!.props.flex_basis}`);
    }

    // Drag down 2 more: 4 -> 6.
    const r2 = dragPanels(panels, mouse("drag_left", 0, 6));
    if (r2 === null || r2.flex_basis !== 6) throw new Error(`drag 2 = ${JSON.stringify(r2)}`);

    // A drag on a gutter further down targets its own pane (gutter 1 -> pane B).
    const r3 = dragPanels(panels, mouse("drag_left", 0, 7));
    if (r3 === null || r3.index !== 0) {
      throw new Error(`drag 3 must stay on pane 0: ${JSON.stringify(r3)}`);
    }

    // up_left ends the drag; a later drag_left is inert.
    const ended = endPanelDrag(panels);
    if (ended === null || ended.index !== 0) throw new Error(`ended = ${JSON.stringify(ended)}`);
    if (dragPanels(panels, mouse("drag_left", 0, 8)) !== null) {
      throw new Error("a drag after up_left must be a no-op");
    }
  });
});

Deno.test("dragPanels clamps the pane's flex_basis to its min size", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    // Drag far above the split: 3 - 20 = -17 -> clamps to the default min (1).
    const r = dragPanels(panels, mouse("drag_left", 0, -17));
    if (r === null || r.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`clamped basis = ${JSON.stringify(r)}`);
    }
    if (panels.children[0]!.props.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
  });
});

Deno.test("dragPanels clamps to the space the neighbor pane's min size leaves", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // The stack is 9 tall with a 1-cell gutter: pane A can grow to
    // 9 - 1 (gutter) - 1 (panel B's min) = 7.
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, 99));
    if (r === null || r.flex_basis !== 7) {
      throw new Error(`upper-clamped basis = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("a declared min_height prop raises the pane's drag floor", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box(), min_height: 4 }, { header: "B", body: Box() }],
      direction: "column",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 60, height: 7 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 4 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // Gutter 0 = row 4 (panel A rows 0-3).
    if (startPanelDrag(panels, mouse("down_left", 0, 4)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, -50));
    if (r === null || r.flex_basis !== 4) {
      throw new Error(`min_height floor = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("row stacks resize by column and use min_width", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [
        { header: "A", body: Box(), min_width: 2 },
        { header: "B", body: Box() },
      ],
      direction: "row",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 7, height: 20 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 3, height: 20 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 2, height: 20 });
    // Gutter 0 = column 3 (panel A columns 0-2); the drag axis is the column.
    const started = startPanelDrag(panels, mouse("down_left", 3, 0));
    if (started === null || started.direction !== "row" || started.index !== 0) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }
    const r = dragPanels(panels, mouse("drag_left", 5, 0)); // +2 columns
    if (r === null || r.flex_basis !== 5) throw new Error(`row drag = ${JSON.stringify(r)}`);
    if (panels.children[0]!.props.flex_basis !== 5) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
    // Far left: 5 - 20 = -15 -> clamps to min_width 2.
    const clamped = dragPanels(panels, mouse("drag_left", -15, 0));
    if (clamped === null || clamped.flex_basis !== 2) {
      throw new Error(`row min_width clamp = ${JSON.stringify(clamped)}`);
    }
  });
});

Deno.test("startPanelDrag ignores presses off the gutters and on detached trees", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // Inside panel A (row 1), inside panel C (row 8), and outside the stack
    // (row 20) are not gutters.
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a press inside a panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 8)) !== null) {
      throw new Error("a press inside the last panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 20)) !== null) {
      throw new Error("a press beyond the stack must not start a drag");
    }
    // Non-down_left events never start a drag.
    if (startPanelDrag(panels, mouse("drag_left", 0, 3)) !== null) {
      throw new Error("drag_left must not start a drag");
    }
    // A detached tree has no geometry: contentSize throws, so no drag.
    const detached = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }] });
    if (startPanelDrag(detached, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a detached tree must not start a drag");
    }
    // endPanelDrag without an active drag is a no-op.
    if (endPanelDrag(panels) !== null) throw new Error("end without a drag must return null");
  });
});

Deno.test("the gutter accounts for an explicit gap", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
      direction: "column",
      gap: 3,
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 2 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // With gap 3 the gutter spans rows 2-4 (panel A rows 0-1).
    for (const row of [2, 3, 4]) {
      if (startPanelDrag(panels, mouse("down_left", 0, row)) === null) {
        throw new Error(`row ${row} is inside the 3-cell gutter`);
      }
      endPanelDrag(panels);
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("row 1 is inside panel A, not the gutter");
    }
  });
});

// ---------------------------------------------------------------------------
// Roadmap elements: DiffView
// ---------------------------------------------------------------------------

/**
 * A 3-hunk diff: two context runs around an add/del pair each, with line
 * numbers reaching two digits (so the gutter columns must right-align to
 * width 2) and a multi-width (CJK) line in the third hunk.
 */
const diffHunks = [
  { kind: "ctx", old_line: 1, new_line: 1, text: "  fn main() {" },
  { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
  { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
  { kind: "ctx", old_line: 3, new_line: 3, text: "  }" },
  { kind: "ctx", old_line: 10, new_line: 11, text: "  宽度对齐测试" },
  { kind: "del", old_line: 11, new_line: 0, text: "    old line" },
  { kind: "add", old_line: 0, new_line: 12, text: "    new line" },
] as const;

Deno.test("DiffView composes a column of gutter/marker/content rows per hunk line", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${diff.props.flex_direction}`);
  }
  // The line model is JS bookkeeping, never a scene prop.
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
  const rows = diff.children;
  if (rows.length !== diffHunks.length) throw new Error(`rows = ${rows.length}`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined || row.type !== "box" || row.props.flex_direction !== "row") {
      throw new Error(`row ${i} must be a row box`);
    }
    const kids = row.children;
    if (kids.length !== 3) throw new Error(`row ${i} must have 3 text leaves`);
    const [gutter, marker, content] = kids;
    if (gutter?.type !== "text" || marker?.type !== "text" || content?.type !== "text") {
      throw new Error(`row ${i} leaves must be text`);
    }
  }
});

Deno.test("DiffView gutter right-aligns old/new line numbers and blanks absent sides", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const gutter = (i: number): string => rows[i]?.children[0]?.props.text ?? "";
  // Width-2 columns: old and new, right-aligned, joined by a space.
  if (gutter(0) !== " 1  1") throw new Error(`gutter(0) = ${JSON.stringify(gutter(0))}`);
  if (gutter(1) !== " 2   ") throw new Error(`gutter(1) = ${JSON.stringify(gutter(1))}`);
  if (gutter(2) !== "    2") throw new Error(`gutter(2) = ${JSON.stringify(gutter(2))}`);
  if (gutter(3) !== " 3  3") throw new Error(`gutter(3) = ${JSON.stringify(gutter(3))}`);
  // Two-digit numbers widen neither column beyond the widest number.
  if (gutter(4) !== "10 11") throw new Error(`gutter(4) = ${JSON.stringify(gutter(4))}`);
  if (gutter(5) !== "11   ") throw new Error(`gutter(5) = ${JSON.stringify(gutter(5))}`);
  if (gutter(6) !== "   12") throw new Error(`gutter(6) = ${JSON.stringify(gutter(6))}`);
});

Deno.test("DiffView styles markers and content per kind: add green, del red, ctx dim", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const markerText = (i: number): string => rows[i]?.children[1]?.props.text ?? "";
  const markerFg = (i: number): unknown => rows[i]?.children[1]?.props.fg;
  const contentFg = (i: number): unknown => rows[i]?.children[2]?.props.fg;
  const contentDim = (i: number): unknown => rows[i]?.children[2]?.props.dim;
  // Markers: ctx is a space, del is '-', add is '+'.
  if (markerText(0) !== " ") throw new Error(`ctx marker = ${JSON.stringify(markerText(0))}`);
  if (markerText(1) !== "-") throw new Error(`del marker = ${JSON.stringify(markerText(1))}`);
  if (markerText(2) !== "+") throw new Error(`add marker = ${JSON.stringify(markerText(2))}`);
  // Marker + content carry the kind color; ctx is dimmed, no fg.
  if (markerFg(1) !== DIFF_DEL_FG) throw new Error(`del marker fg = ${markerFg(1)}`);
  if (contentFg(1) !== DIFF_DEL_FG) throw new Error(`del content fg = ${contentFg(1)}`);
  if (markerFg(2) !== DIFF_ADD_FG) throw new Error(`add marker fg = ${markerFg(2)}`);
  if (contentFg(2) !== DIFF_ADD_FG) throw new Error(`add content fg = ${contentFg(2)}`);
  if (markerFg(0) !== undefined) throw new Error(`ctx marker must have no fg (${markerFg(0)})`);
  if (contentDim(0) !== true) throw new Error(`ctx content must be dimmed (${contentDim(0)})`);
  if (contentDim(2) !== undefined) throw new Error(`add content must not be dimmed`);
  // The content leaf carries the line text verbatim (multi-width included).
  if (rows[4]?.children[2]?.props.text !== "  宽度对齐测试") {
    throw new Error(`multi-width content = ${JSON.stringify(rows[4]?.children[2]?.props.text)}`);
  }
});

Deno.test("DiffView passes scroll_x/scroll_y to the root and wrap to the content leaves", () => {
  const diff = DiffView({ hunks: [...diffHunks], scroll_x: 4, scroll_y: 7, wrap: false });
  if (diff.props.scroll_x !== 4) throw new Error(`scroll_x = ${diff.props.scroll_x}`);
  if (diff.props.scroll_y !== 7) throw new Error(`scroll_y = ${diff.props.scroll_y}`);
  for (let i = 0; i < diff.children.length; i++) {
    if (diff.children[i]?.children[2]?.props.wrap !== false) {
      throw new Error(`row ${i} content must carry wrap=false`);
    }
  }
  // Without `wrap`, the content leaves carry no wrap prop (engine default).
  const unwrapped = DiffView({ hunks: [...diffHunks] });
  for (let i = 0; i < unwrapped.children.length; i++) {
    if ("wrap" in (unwrapped.children[i]?.children[2]?.props ?? {})) {
      throw new Error(`row ${i} content must not carry wrap when unset`);
    }
  }
});

Deno.test("DiffView with no hunks yields an empty column", () => {
  const diff = DiffView({ hunks: [] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.children.length !== 0) throw new Error(`rows = ${diff.children.length}`);
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
});

// ---------------------------------------------------------------------------
// Roadmap elements: Select
// ---------------------------------------------------------------------------

const selectOptions: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

const keyBase = { ctrl: false, alt: false, shift: false } as const;

Deno.test("Select composes a filter row and option rows (highlighted first)", () => {
  const select = Select({ options: selectOptions });
  if (select.type !== "select") throw new Error(`type = ${select.type}`);
  if (select.props.multi !== false) throw new Error(`multi = ${select.props.multi}`);
  if (select.props.value !== "") throw new Error(`value = ${select.props.value}`);
  if (select.props.highlighted !== 0) throw new Error(`highlighted = ${select.props.highlighted}`);
  if ("options" in select.props) throw new Error("options must not reach the scene props");
  // Filter row + 3 option rows (no summary in single mode).
  if (select.children.length !== 4) throw new Error(`children = ${select.children.length}`);
  const filterRow = select.children[0];
  if (filterRow === undefined || filterRow.type !== "text") {
    throw new Error("filter row must be a text leaf");
  }
  if (filterRow.props.text !== SELECT_FILTER_PLACEHOLDER) {
    throw new Error(`filter = ${filterRow.props.text}`);
  }
  if (filterRow.props.dim !== true) throw new Error(`filter dim = ${filterRow.props.dim}`);
  const labels = select.children.slice(1).map((child) => child.props.text).join(",");
  if (labels !== "Apple,Banana,Cherry") throw new Error(`rows = ${labels}`);
  // The first option starts highlighted (reversed).
  if (select.children[1]?.props.reversed !== true) {
    throw new Error("first option must be highlighted");
  }
  if (select.children[2]?.props.reversed === true) {
    throw new Error("only the highlighted option may be reversed");
  }
});

Deno.test("Select multi mode shows checkmarks and a selected-count summary", () => {
  const select = Select({
    options: [
      { value: "a", label: "A", selected: true },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
    multi: true,
  });
  // Filter + 3 option rows + summary.
  if (select.children.length !== 5) throw new Error(`children = ${select.children.length}`);
  const rows = select.children.slice(1, 4).map((child) => child.props.text);
  if (rows[0] !== "✓ A") throw new Error(`row 0 = ${rows[0]}`);
  if (rows[1] !== "  B") throw new Error(`row 1 = ${rows[1]}`);
  const summary = select.children[4];
  if (summary === undefined || summary.props.text !== "1 selected") {
    throw new Error(`summary = ${summary?.props.text}`);
  }
  // The initial selection comes from the `selected`-flagged options.
  if (JSON.stringify(select.props.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(select.props.value)}`);
  }
});

Deno.test("selectKey moves the highlight with up/down and clamps at the ends", () => {
  const select = Select({ options: selectOptions });
  const down = selectKey(select, { name: "down", ...keyBase });
  if (down.highlighted !== 1) throw new Error(`down = ${down.highlighted}`);
  const up = selectKey(select, { name: "up", ...keyBase });
  if (up.highlighted !== 0) throw new Error(`up = ${up.highlighted}`);
  // Clamp at the top.
  const upClamped = selectKey(Select({ options: selectOptions }), { name: "up", ...keyBase });
  if (upClamped.highlighted !== 0) throw new Error(`up clamp = ${upClamped.highlighted}`);
  // Clamp at the bottom.
  selectKey(select, { name: "down", ...keyBase });
  selectKey(select, { name: "down", ...keyBase });
  const bottom = selectKey(select, { name: "down", ...keyBase });
  if (bottom.highlighted !== 2) throw new Error(`down clamp = ${bottom.highlighted}`);
  // The composition reflects the moved highlight.
  if (select.children[3]?.props.reversed !== true) {
    throw new Error("highlighted row must be reversed");
  }
  // Unknown keys leave the state unchanged.
  const tab = selectKey(select, { name: "tab", ...keyBase });
  if (tab.highlighted !== 2) throw new Error(`tab must not move = ${tab.highlighted}`);
});

Deno.test("selectKey typeahead filter narrows the visible options", () => {
  const select = Select({ options: selectOptions });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const visibleText = () => select.children[1]?.props.text;
  const childCount = () => select.children.length;
  const b = selectKey(select, { name: "char", char: "b", ...keyBase });
  if (b.filter !== "b") throw new Error(`filter = ${b.filter}`);
  if (b.highlighted !== 0) throw new Error(`highlight resets to first match = ${b.highlighted}`);
  // The composition narrows to the prefix matches (filter row + 1 row).
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
  if (visibleText() !== "Banana") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // Case-insensitive prefix match.
  selectKey(select, { name: "backspace", ...keyBase });
  const cap = selectKey(select, { name: "char", char: "C", ...keyBase });
  if (cap.filter !== "C") throw new Error(`filter = ${cap.filter}`);
  if (visibleText() !== "Cherry") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // A non-matching char empties the list down to the filter row.
  const z = selectKey(select, { name: "char", char: "z", ...keyBase });
  if (z.filter !== "Cz") throw new Error(`filter = ${z.filter}`);
  if (childCount() !== 1) throw new Error(`children = ${childCount()}`);
  // Backspace restores the full list.
  const back = selectKey(select, { name: "backspace", ...keyBase });
  if (back.filter !== "C") throw new Error(`filter = ${back.filter}`);
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
});

Deno.test("visibleOptions reflects the filter and is label-normalized", () => {
  const select = Select({ options: selectOptions });
  const all = visibleOptions(select);
  if (all.length !== 3) throw new Error(`all = ${all.length}`);
  if (all[0]?.label !== "Apple") throw new Error(`label = ${all[0]?.label}`);
  selectKey(select, { name: "char", char: "b", ...keyBase });
  const visible = visibleOptions(select);
  if (visible.length !== 1 || visible[0]?.value !== "banana" || visible[0]?.label !== "Banana") {
    throw new Error(`visible = ${JSON.stringify(visible)}`);
  }
});

Deno.test("selectKey enter confirms the highlighted option and dismisses", () => {
  const select = Select({ options: selectOptions });
  selectKey(select, { name: "down", ...keyBase });
  const next = selectKey(select, { name: "enter", ...keyBase });
  if (next.value !== "banana") throw new Error(`value = ${next.value}`);
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.value !== "banana") throw new Error(`node value = ${select.props.value}`);
  if (select.props.open !== false) throw new Error(`node open = ${select.props.open}`);
  // Enter confirms the filtered highlight too (typeahead + enter).
  const filtered = Select({ options: selectOptions });
  selectKey(filtered, { name: "char", char: "c", ...keyBase });
  const confirmed = selectKey(filtered, { name: "enter", ...keyBase });
  if (confirmed.value !== "cherry") throw new Error(`filtered confirm = ${confirmed.value}`);
});

Deno.test("selectKey escape dismisses the dropdown", () => {
  const select = Select({ options: selectOptions });
  const next = selectKey(select, { name: "escape", ...keyBase });
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.open !== false) throw new Error(`node open = ${select.props.open}`);
  // Enter/escape on an empty list is a no-op (nothing to confirm/dismiss).
  const empty = Select({ options: [] });
  const dismissed = selectKey(empty, { name: "escape", ...keyBase });
  if (dismissed.open !== false) throw new Error(`empty open = ${dismissed.open}`);
});

Deno.test("selectKey space toggles a checkmark in multi mode and updates the count", () => {
  const select = Select({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    multi: true,
  });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const rowText = () => select.children[1]?.props.text;
  const summaryText = () => select.children[3]?.props.text;
  // Space on the highlighted (first) option checks it.
  const toggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(toggled.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(toggled.value)}`);
  }
  if (rowText() !== "✓ A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "1 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
  // Space again unchecks it.
  const untoggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(untoggled.value) !== JSON.stringify([])) {
    throw new Error(`value = ${JSON.stringify(untoggled.value)}`);
  }
  if (rowText() !== "  A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "0 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
});

Deno.test("Select floating mode sets a z_index prop", () => {
  // Floating defaults the overlay to z-index 0.
  const floating = Select({ options: selectOptions, floating: true });
  if (floating.props.z_index !== 0) throw new Error(`z_index = ${floating.props.z_index}`);
  if ("floating" in floating.props) throw new Error("floating must not reach the scene props");
  // An explicit z_index is honored.
  const layered = Select({ options: selectOptions, floating: true, z_index: 5 });
  if (layered.props.z_index !== 5) throw new Error(`z_index = ${layered.props.z_index}`);
  // Docked selects carry no z_index prop at all.
  const docked = Select({ options: selectOptions });
  if (docked.props.z_index !== undefined) throw new Error(`docked z_index = ${docked.props.z_index}`);
});

// ---------------------------------------------------------------------------
// Focus manager
// ---------------------------------------------------------------------------

Deno.test("FocusManager routes keys to the focused element's handler", () => {
  const manager = new FocusManager();
  const received: Array<{ id: string; key: KeyEvent }> = [];
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: (key) => received.push({ id: "a", key }) });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: (key) => received.push({ id: "b", key }) });
  const key: KeyEvent = { name: "char", char: "x", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== false) throw new Error("nothing focused must not route");
  if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
  if (manager.activeId !== "a") throw new Error(`activeId = ${manager.activeId}`);
  if (manager.routeKey(key) !== true) throw new Error("focused route must be handled");
  const afterA = received.length;
  if (afterA !== 1 || received[0]?.id !== "a") throw new Error(`key must route to a (${afterA})`);
  manager.focus("b");
  manager.routeKey(key);
  const afterB = received.length;
  if (afterB !== 2 || received[1]?.id !== "b") throw new Error(`key must route to b (${afterB})`);
  if (received[1]?.key !== key) throw new Error("handler must receive the key event verbatim");
});

Deno.test("routeKey with an explicit node routes to that node's handler", () => {
  const manager = new FocusManager();
  const bNode = Text({ text: "b" });
  let hits = 0;
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => hits++ });
  manager.register({ id: "b", node: bNode, onKey: () => (hits += 10) });
  const key: KeyEvent = { name: "enter", ctrl: false, alt: false, shift: false };
  manager.routeKey(key, bNode);
  if (hits !== 10) throw new Error(`explicit node route = ${hits}`);
});

Deno.test("unregister clears the active focus and stops dispatch", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const unsub = manager.register({ id: "x", node, onKey: () => hits++ });
  manager.focus("x");
  if (manager.active?.node !== node) throw new Error("active entry must expose the node");
  unsub();
  if (manager.activeId !== null) throw new Error("active must clear on unregister");
  if (manager.has("x")) throw new Error("entry must be gone after unregister");
  const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== false) throw new Error("unregistered id must not route");
  if (hits !== 0) throw new Error("no dispatch after unregister");
});

Deno.test("useFocus registers, focuses and disposes through the manager", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const handle = useFocus("f", node, () => hits++, manager);
  if (!manager.has("f")) throw new Error("useFocus must register the id");
  handle.focus();
  if (!handle.isFocused()) throw new Error("focus() must make the id active");
  const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== true) throw new Error("routed key must be handled");
  if (hits !== 1) throw new Error(`routed through the handle's handler = ${hits}`);
  handle.blur();
  if (handle.isFocused()) throw new Error("blur() must clear the active focus");
  handle.dispose();
  if (manager.has("f")) throw new Error("dispose() must unregister the id");
});

Deno.test("the default focus manager is a FocusManager instance", () => {
  if (!(focusManager instanceof FocusManager)) {
    throw new Error("default focus manager must be a FocusManager");
  }
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

Deno.test("defaultTheme covers every palette role and component preset", () => {
  for (const role of THEME_ROLES) {
    const colors = defaultTheme.palette[role];
    if (colors === undefined) throw new Error(`missing palette role ${role}`);
    if (typeof colors.fg !== "string" || colors.fg === "") {
      throw new Error(`role ${role} fg = ${JSON.stringify(colors.fg)}`);
    }
    if (typeof colors.bg !== "string" || colors.bg === "") {
      throw new Error(`role ${role} bg = ${JSON.stringify(colors.bg)}`);
    }
  }
  for (const kind of THEME_COMPONENTS) {
    if (defaultTheme.components[kind] === undefined) {
      throw new Error(`missing component preset ${kind}`);
    }
  }
});

Deno.test("resolveTheme stamps the role palette fg/bg and strips the hint", () => {
  const out = resolveTheme(defaultTheme, { role: "danger" });
  if (out.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`fg = ${out.fg}`);
  }
  if (out.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`bg = ${out.bg}`);
  }
  if ("role" in out) throw new Error(`role leaked: ${JSON.stringify(out)}`);
  if ("component" in out) throw new Error(`component leaked: ${JSON.stringify(out)}`);
});

Deno.test("resolveTheme stamps a component preset fg/bg/border_style", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { input: { fg: "#123456", border_style: "rounded" } },
  });
  const out = resolveTheme(custom, { component: "input" });
  if (out.fg !== "#123456") throw new Error(`fg = ${out.fg}`);
  if (out.border_style !== "rounded") throw new Error(`border_style = ${out.border_style}`);
  if ("component" in out) throw new Error(`component leaked: ${JSON.stringify(out)}`);
});

Deno.test("resolveTheme precedence: explicit props > role palette > component preset", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { status_bar: { fg: "#111111", bg: "#222222", border_style: "thick" } },
  });
  // No explicit style: the component preset fills fg/bg/border_style.
  const presetOnly = resolveTheme(custom, { component: "status_bar" });
  if (presetOnly.fg !== "#111111" || presetOnly.bg !== "#222222") {
    throw new Error(`preset fill = ${JSON.stringify(presetOnly)}`);
  }
  if (presetOnly.border_style !== "thick") {
    throw new Error(`preset border_style = ${presetOnly.border_style}`);
  }
  // Role added: the role palette overrides the preset's fg/bg (role is the
  // more specific intent), the preset's border_style is kept.
  const roleWins = resolveTheme(custom, { component: "status_bar", role: "danger" });
  if (roleWins.fg !== custom.palette.danger.fg) {
    throw new Error(`role must win over preset fg: ${roleWins.fg}`);
  }
  if (roleWins.bg !== custom.palette.danger.bg) {
    throw new Error(`role must win over preset bg: ${roleWins.bg}`);
  }
  if (roleWins.border_style !== "thick") {
    throw new Error(`preset border_style must survive: ${roleWins.border_style}`);
  }
  // Explicit props win over both.
  const explicit = resolveTheme(custom, {
    component: "status_bar",
    role: "danger",
    fg: "#ff0000",
  });
  if (explicit.fg !== "#ff0000") throw new Error(`explicit fg = ${explicit.fg}`);
  if (explicit.bg !== custom.palette.danger.bg) {
    throw new Error(`explicit fg must not suppress the role bg: ${explicit.bg}`);
  }
});

Deno.test("resolveTheme without hints returns the props unchanged (plain node props)", () => {
  const props: ThemeResolvableProps = { text: "hi", bold: true, width: 10 };
  const out = resolveTheme(defaultTheme, props);
  if (out.text !== "hi" || out.bold !== true || out.width !== 10) {
    throw new Error(`props changed: ${JSON.stringify(out)}`);
  }
  if (Object.keys(out).length !== 3) {
    throw new Error(`unexpected keys: ${JSON.stringify(out)}`);
  }
});

Deno.test("resolveTheme output feeds the element factories as plain node props", () => {
  const node = Text(resolveTheme(defaultTheme, { text: "err", role: "danger" }));
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (node.props.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`stamped fg = ${node.props.fg}`);
  }
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`stamped bg = ${node.props.bg}`);
  }
  if ("role" in node.props || "component" in node.props) {
    throw new Error(`semantic hints reached the node: ${JSON.stringify(node.props)}`);
  }
});

Deno.test("mergeTheme merges partial roles and keeps base keys", () => {
  const overrides: ThemeOverrides = { palette: { danger: { fg: "#ff0000" } } };
  const merged = mergeTheme(defaultTheme, overrides);
  // The overridden role keeps its base bg and gains the override fg.
  if (merged.palette.danger.fg !== "#ff0000") throw new Error(`merged fg = ${merged.palette.danger.fg}`);
  if (merged.palette.danger.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`base bg must be kept: ${merged.palette.danger.bg}`);
  }
  // Untouched roles are copied through unchanged.
  if (merged.palette.success.fg !== defaultTheme.palette.success.fg) {
    throw new Error(`untouched role changed: ${merged.palette.success.fg}`);
  }
  // The base is not mutated.
  if (defaultTheme.palette.danger.fg === "#ff0000") {
    throw new Error("mergeTheme must not mutate the base theme");
  }
  if (merged === defaultTheme) throw new Error("mergeTheme must return a new theme");
});

Deno.test("mergeTheme merges component presets per key", () => {
  const merged = mergeTheme(defaultTheme, {
    components: { panels: { border_style: "double" } },
  });
  if (merged.components.panels.border_style !== "double") {
    throw new Error(`preset border_style = ${merged.components.panels.border_style}`);
  }
  if ("fg" in merged.components.panels) {
    throw new Error(`unset preset key must stay absent: ${JSON.stringify(merged.components.panels)}`);
  }
  // Other component presets are untouched.
  if (merged.components.input !== defaultTheme.components.input) {
    throw new Error("untouched preset must be copied through");
  }
});

Deno.test("mergeTheme accepts a full Theme as overrides", () => {
  const custom: Theme = mergeTheme(defaultTheme, {
    palette: { primary: { fg: "#0000ff", bg: "#000000" } },
  });
  const merged = mergeTheme(defaultTheme, custom);
  if (merged.palette.primary.fg !== "#0000ff" || merged.palette.primary.bg !== "#000000") {
    throw new Error(`full-theme override = ${JSON.stringify(merged.palette.primary)}`);
  }
  if (merged.palette.muted.fg !== defaultTheme.palette.muted.fg) {
    throw new Error(`unoverridden role changed: ${merged.palette.muted.fg}`);
  }
});

// ---------------------------------------------------------------------------
// ScrollView
// ---------------------------------------------------------------------------

/**
 * A size-aware fake native node handle for the ScrollView tests:
 * `content_size` returns the size derived at creation — text/streaming nodes
 * measure their content (widest line width, line count), boxes use their
 * `width`/`height` props or a default viewport of {11, 2}. This mirrors the
 * real engine's `content_size` contract (text = wrapped content, containers =
 * laid-out rect) so the scroll helpers' clamping is exercised against
 * realistic geometry.
 *
 * A `streaming_text` handle accumulates spans appended through
 * `append_span` and measures *them* (the real engine measures the stream, not
 * a `text` prop — compositor.rs `content_size`), so the auto-scroll tests can
 * grow the content by appending spans, exactly like the native path.
 */
class FakeScrollNodeHandle {
  readonly kind: string;
  readonly props: Record<string, unknown>;
  streamText = "";
  constructor(type: string, props: Record<string, unknown> | null | undefined) {
    this.kind = type;
    this.props = props ?? {};
  }
  content_size(): { width: number; height: number } {
    if (this.kind === "text" || this.kind === "streaming_text") {
      const text = this.kind === "streaming_text"
        ? this.streamText
        : (typeof this.props.text === "string" ? this.props.text : "");
      const lines = text.split("\n");
      let width = 0;
      for (const line of lines) width = Math.max(width, line.length);
      return { width, height: lines.length };
    }
    return {
      width: typeof this.props.width === "number" ? this.props.width : 11,
      height: typeof this.props.height === "number" ? this.props.height : 2,
    };
  }
  add_child(child: unknown): unknown {
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    return child;
  }
  set_props(_props: unknown): void {}
  append_span(text: string, _style?: unknown): void {
    this.streamText += text;
  }
  remove(): boolean {
    return true;
  }
}

/** The native node types materialized through the size-aware fake. */
const scrollCreatedNodes: Array<{ type: string; props: Record<string, unknown> | null }> = [];

/** A fake addon whose `content_size` reflects each node's content/layout. */
const scrollFakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeScrollNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) => {
    scrollCreatedNodes.push({ type, props: props ?? null });
    return new FakeScrollNodeHandle(type, props);
  },
} as unknown as TernAddon;

/** Run `fn` with the size-aware fake addon installed. */
function withScrollFakeAddon(fn: () => void): void {
  scrollCreatedNodes.length = 0;
  setAddonForTesting(scrollFakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

Deno.test("ScrollView builds a scroll_view box with the clip/scroll region props", () => {
  const view = ScrollView({
    clip_x: 1,
    clip_y: 2,
    clip_width: 10,
    clip_height: 4,
    scroll_x: 0,
    scroll_y: 3,
  });
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.clip_x !== 1) throw new Error(`clip_x = ${view.props.clip_x}`);
  if (view.props.clip_y !== 2) throw new Error(`clip_y = ${view.props.clip_y}`);
  if (view.props.clip_width !== 10) throw new Error(`clip_width = ${view.props.clip_width}`);
  if (view.props.clip_height !== 4) throw new Error(`clip_height = ${view.props.clip_height}`);
  if (view.props.scroll_x !== 0) throw new Error(`scroll_x = ${view.props.scroll_x}`);
  if (view.props.scroll_y !== 3) throw new Error(`scroll_y = ${view.props.scroll_y}`);
});

Deno.test("ScrollView attaches rest-arg and props children, consuming both keys", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const viaProps = ScrollView({ children: [b] }, a);
  const kids = viaProps.children;
  if (kids.length !== 2) throw new Error(`children = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== b) throw new Error("content order must be rest args then props children");
  // Both keys are consumed by the factory — never scene props.
  if ("children" in viaProps.props || "showScrollbar" in viaProps.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(viaProps.props)}`);
  }
});

Deno.test("showScrollbar appends a scrollbar text leaf to the composition", () => {
  const withBar = ScrollView({ showScrollbar: true }, Text({ text: "x" }));
  // Content + the scrollbar leaf (a text node pinned to the right edge).
  if (withBar.children.length !== 2) throw new Error(`children = ${withBar.children.length}`);
  const leaf = withBar.children[1];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("scrollbar must be a text leaf");
  }
  if (leaf.props.position !== "absolute" || leaf.props.right !== 0 || leaf.props.width !== 1) {
    throw new Error(`leaf props = ${JSON.stringify(leaf.props)}`);
  }
  // Without the flag no scrollbar leaf is composed.
  const noBar = ScrollView({}, Text({ text: "x" }));
  if (noBar.children.length !== 1) throw new Error(`no-bar children = ${noBar.children.length}`);
});

Deno.test("scrollTo sets scroll props and clamps to the content bounds", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 2} (from the width/height props); the content text is
    // 5 cells wide, 3 rows tall -> maxY = 1, maxX = 0.
    const view = ScrollView({ width: 5, height: 2 }, Text({ text: "aaaa\nbbbbb\ncc" }));
    renderer.root.addChild(view);
    const applied = scrollTo(view, 0, 5);
    if (applied.x !== 0 || applied.y !== 1) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 0 || view.props.scroll_y !== 1) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scrollTo clamps horizontal overflow against the content width", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {3, 2}; the content text is 8 cells wide -> maxX = 5.
    const view = ScrollView({ width: 3, height: 2 }, Text({ text: "abcdefgh" }));
    renderer.root.addChild(view);
    const applied = scrollTo(view, 10, 0);
    if (applied.x !== 5 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 5) throw new Error(`scroll_x = ${view.props.scroll_x}`);
  });
});

Deno.test("scrollBy offsets from the current scroll and clamps both directions", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 5, height: 2 }, Text({ text: "aaaa\nbbbbb\ncc" }));
    renderer.root.addChild(view);
    scrollTo(view, 0, 1); // at the max offset
    const applied = scrollBy(view, 0, 3); // past the max -> clamped back
    if (applied.y !== 1) throw new Error(`applied = ${JSON.stringify(applied)}`);
    const back = scrollBy(view, 0, -1); // back up
    if (back.y !== 0) throw new Error(`back = ${JSON.stringify(back)}`);
    if (view.props.scroll_y !== 0) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  });
});

Deno.test("scrollTop resets the vertical offset and keeps the horizontal", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 3, height: 2 }, Text({ text: "abcdefgh" }));
    renderer.root.addChild(view);
    scrollTo(view, 5, 0);
    const applied = scrollTop(view);
    if (applied.x !== 5 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 5 || view.props.scroll_y !== 0) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scroll helpers refresh the scrollbar track and thumb from the clamped offset", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 3}; content height 5 -> maxY = 2, thumb length 2
    // (round(3*3/5) = 2) on a 1-row track range.
    const view = ScrollView({ width: 5, height: 3, showScrollbar: true }, Text({ text: "aa\nbb\ncc\ndd\nee" }));
    renderer.root.addChild(view);
    const leaf = view.children[1]!;

    // At the top: the thumb fills the first two rows of the track.
    scrollTo(view, 0, 0);
    if (leaf.props.height !== 3) throw new Error(`leaf height = ${leaf.props.height}`);
    const topText = leaf.props.text;
    if (topText !== `${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_TRACK_CHAR}`) {
      throw new Error(`top scrollbar = ${JSON.stringify(topText)}`);
    }

    // Scrolled to the bottom (maxY = 2): the thumb drops to the last two
    // rows, and the `top` inset is scroll-compensated (thumbOffset 1 +
    // scroll_y 2).
    scrollTo(view, 0, 2);
    const bottomText = leaf.props.text;
    if (bottomText !== `${SCROLLBAR_TRACK_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}`) {
      throw new Error(`bottom scrollbar = ${JSON.stringify(bottomText)}`);
    }
    if (leaf.props.top !== 3) throw new Error(`leaf top = ${leaf.props.top}`);
  });
});

Deno.test("scroll helpers on a detached view throw (contentSize requires the scene)", () => {
  const view = ScrollView({ width: 5, height: 2 }, Text({ text: "x" }));
  let threw = false;
  try {
    scrollTo(view, 0, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("scrollTo on a detached view must throw");
});

Deno.test("removing a scroll view clears its scrollbar from the scene", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 5, height: 2, showScrollbar: true }, Text({ text: "x" }));
    renderer.root.addChild(view);
    const leaf = view.children[1]!;
    if (!view.attached || !leaf.attached) throw new Error("view and scrollbar must attach");
    if (view.remove() !== true) throw new Error("remove must succeed");
    // The whole subtree detaches with the view: the scrollbar leaf is
    // cleared from the scene, and the view is spliced out of its parent.
    if (view.attached || leaf.attached) throw new Error("scrollbar must detach with the view");
    if (renderer.root.children.length !== 0) throw new Error("view must be spliced out of the scene");
  });
});

// ---------------------------------------------------------------------------
// StreamingText auto-scroll
//
// A streaming node with `autoScroll` (the default) follows its content tail:
// `syncStreamTail` pins `scroll_y` to the content height minus the clip
// viewport height. A manual scroll above the tail (via `scrollTo` / `scrollBy`
// / `scrollTop`) detaches the follow and pins the view; `followTail`
// re-attaches and snaps back. The fake addon's `content_size` measures the
// streamed spans verbatim (spans concatenate, one row per `\n`), so with
// newline-terminated spans and a `clip_height: 2` viewport, N spans put the
// content at N + 1 rows and the tail at N - 1.
// ---------------------------------------------------------------------------

Deno.test("StreamingText defaults to following the tail (scroll_y = content height - clip height)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    if (!isStreamFollowing(node)) throw new Error("autoScroll must default to following");
    // A fresh read per assertion — TS property-access narrowing would
    // otherwise reject a later comparison against a different literal.
    const y = (): number => node.props.scroll_y as number;
    // 3 newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);
    if (node.props.scroll_x !== undefined) {
      throw new Error(`scroll_x must stay unset, got ${node.props.scroll_x}`);
    }
    // The tail keeps moving as the stream grows (5 rows -> tail 3).
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 3) throw new Error(`scroll_y after 4 spans = ${y()}`);
    // The autoScroll key is consumed — never a scene prop.
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }
  });
});

Deno.test("StreamingText with autoScroll: false never follows the tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ autoScroll: false, clip_height: 2, width: 10 });
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (isStreamFollowing(node)) throw new Error("autoScroll: false must not follow");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
  });
});

Deno.test("a manual scroll above the tail detaches the follow and pins the view", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    // A fresh read per assertion (see the tail-follow test).
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);

    // Scroll up above the tail: the follow detaches and the view pins.
    const applied = scrollTo(node, 0, 0);
    if (applied.x !== 0 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach the follow");

    // The stream keeps growing, but the view stays pinned at row 0.
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // scrollBy / scrollTop funnel through scrollTo and detach the same way.
    const by = scrollBy(node, 0, 1);
    if (by.y !== 1) throw new Error(`scrollBy applied = ${JSON.stringify(by)}`);
    const top = scrollTop(node);
    if (top.y !== 0) throw new Error(`scrollTop applied = ${JSON.stringify(top)}`);
    if (isStreamFollowing(node)) throw new Error("scrollBy/scrollTop above the tail must detach");
  });
});

Deno.test("followTail re-attaches and snaps back to the growing tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    scrollTo(node, 0, 0); // detach (pinned at row 0)
    node.appendSpan("d\n"); // 5 rows now; sync is a no-op while detached

    // Re-attach: followTail snaps straight to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach the follow");
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    node.appendSpan("e\n");
    syncStreamTail(node);
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    // A scroll to the tail keeps the follow attached (no detach).
    scrollTo(node, 0, 4);
    if (!isStreamFollowing(node)) throw new Error("scrolling to the tail must keep the follow");
  });
});

Deno.test("followTail on a plain streaming node enables auto-scroll from scratch", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Built through the raw Node factory — no follow state registered.
    const node = Node.create("streaming_text", { clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    node.appendSpan("a\n");
    node.appendSpan("b\n");
    node.appendSpan("c\n");
    syncStreamTail(node);
    if (isStreamFollowing(node)) throw new Error("a raw node must not follow by default");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`raw node scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must enable a raw node's follow");
    // 4 rows - clip 2 = tail 2.
    if (node.props.scroll_y !== 2) throw new Error(`raw snap scroll_y = ${node.props.scroll_y}`);
  });
});
