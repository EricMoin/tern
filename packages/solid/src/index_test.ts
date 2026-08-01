import {
  name,
  version,
  Box,
  Text,
  StreamingText,
  subscribeStream,
  type Span,
  type Node,
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
  // `a`'s former index. The replaced node's own children entry is left
  // behind by @tern/core `Node.remove()` (the core children list is never
  // spliced on removal — a documented core limitation).
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
  // Note: @tern/core `Node.remove()` never splices the parent's children list
  // (a documented core limitation), so treeRoot.children still lists the box;
  // the authoritative removal evidence is the registry + remove() above.
  if (treeRoot.children[0] !== staticLabel || staticLabel.props.text !== "static") {
    throw new Error("static label must remain untouched after removal");
  }
  if (treeRoot.children[1] !== textNodeRef) {
    throw new Error("text node must remain in place after removal");
  }

  dispose();
});
