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
 */

import {
  Box,
  Node,
  StreamingText,
  Text,
  createRenderer,
  name,
  version,
} from "./index.ts";
import type {
  KeyEvent,
  NodeHandle,
  Span,
  TuiRenderer,
  TuiRendererOptions,
} from "./index.ts";

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
