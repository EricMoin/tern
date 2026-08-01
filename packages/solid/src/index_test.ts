import {
  name,
  version,
  Box,
  Text,
  renderer,
  rendererOptions,
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

  rendererOptions.replaceNode(b, a);

  if (rendererOptions.getParentNode(b) !== parent) {
    throw new Error("replacement must be registered under the replaced node's parent");
  }
  if (rendererOptions.getParentNode(a) !== undefined) {
    throw new Error("replaced node's parent registry entry must be cleared");
  }
  if (!parent.children.includes(b)) {
    throw new Error("replacement must be added under the parent");
  }
});

Deno.test("replaceNode is a no-op without a recorded parent", () => {
  const orphan = createTextNode("orphan");
  const repl = createTextNode("repl");
  rendererOptions.replaceNode(repl, orphan);
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
  rendererOptions.replaceNode(a, a);
  if (rendererOptions.getParentNode(a) !== parent) {
    throw new Error("self-replace must keep the node's parent registration");
  }
});
