import {
  name,
  version,
  Box,
  Text,
  StreamingText,
  subscribeStream,
  Input,
  Spinner,
  StatusBar,
  Panels,
  subscribeInput,
  editKey,
  tick,
  useFocus,
  FocusManager,
  focusManager,
  collapsePanel,
  expandPanel,
  togglePanel,
  focusPanel,
  type Span,
  type Node,
  type KeyEvent,
  type Renderer,
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
} from "@tern/core";

// @deno-types="../../../node_modules/solid-js/types/index.d.ts"
import { createSignal } from "solid-js";

Deno.test("solid exports package metadata", () => {
  if (name !== "@tern/solid") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.1.0") {
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
// Reactive integration: signal -> targeted scene update (Phase-1 exit
// criterion at the @tern/core level)
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
 * The root is a detached @tern/core `Node` (never attached to a native
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
  // @tern/core `Node.remove()` splices the node out of its parent's children
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
// Roadmap element factories (feature parity with @tern/react)
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
  if (createElement("spinner").type !== "spinner") throw new Error("createElement(spinner) mapping");
  if (createElement("status_bar").type !== "status_bar") {
    throw new Error("createElement(status_bar) mapping");
  }
  if (createElement("panels").type !== "panels") throw new Error("createElement(panels) mapping");
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
 * the @tern/core factory of the same name (packages/react/src/reconciler.ts).
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

  // The React baseline: the @tern/core factories (what React's hostConfig
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
  keyHandlers: Set<(event: KeyEvent) => void>;
} {
  const renderCalls: number[] = [];
  const keyHandlers = new Set<(event: KeyEvent) => void>();
  const root = Box();
  const renderer = {
    root,
    render: () => {
      renderCalls.push(renderCalls.length);
    },
    onKey: (handler: (event: KeyEvent) => void) => {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    destroy: () => {},
  } as unknown as Renderer;
  return { renderer, root, renderCalls, keyHandlers };
}

function keyEvent(over: Partial<KeyEvent> = {}): KeyEvent {
  return { name: "char", char: "q", ctrl: false, alt: false, shift: false, ...over };
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
