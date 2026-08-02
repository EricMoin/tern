/**
 * Unit tests for the @tern/react renderer.
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
import { Box as CoreBox, type KeyEvent, type Renderer, type Span } from "@tern/core";

// React 19 requires act() to be enabled explicitly in non-test-runner envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  Box,
  StreamingText,
  Text,
  createRoot,
  hostConfig,
  name,
  render,
  toNodeProps,
  useApp,
  useInput,
  version,
} from "./index.ts";
import type { AppHandle, TernProps } from "./index.ts";

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
  keyHandlers: Set<(event: KeyEvent) => void>;
} {
  const renderCalls: number[] = [];
  const keyHandlers = new Set<(event: KeyEvent) => void>();
  const root = CoreBox();
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

// ---------------------------------------------------------------------------
// Package surface
// ---------------------------------------------------------------------------

Deno.test("react exports package metadata", () => {
  if (name !== "@tern/react") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.1.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("public API surface is exported", () => {
  for (const fn of [Box, Text, StreamingText, createRoot, render, useApp, useInput]) {
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

  await act(async () => {
    ternRoot.render(createElement(Box, {}, item("a"), item("b"), item("c")));
  });
  const box = root.children[0]!;
  const order = () => box.children.map((n) => n.props.text).join(",");
  if (order() !== "a,b,c") throw new Error(`initial order: ${order()}`);

  // Full reorder: React repositions via appendChild on already-present
  // children (getHostSibling returns null when every trailing sibling moves).
  await act(async () => {
    ternRoot.render(createElement(Box, {}, item("c"), item("a"), item("b")));
  });
  if (order() !== "c,a,b") throw new Error(`full reorder: ${order()}`);

  // Partial reorder: React repositions via insertBefore with an
  // already-present child (keyed-list move).
  await act(async () => {
    ternRoot.render(createElement(Box, {}, item("b"), item("a"), item("c")));
  });
  if (order() !== "b,a,c") throw new Error(`partial reorder: ${order()}`);

  // Returning to the original order reuses the instances.
  await act(async () => {
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

// ---------------------------------------------------------------------------
// End-to-end reconciliation against a detached root
// ---------------------------------------------------------------------------

Deno.test("createRoot renders a tree onto the scene root", async () => {
  const { renderer, root, renderCalls } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

Deno.test("updates reuse instances and commitUpdate applies new props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
    ternRoot.render(createElement(Box, { border_style: "rounded" }, createElement(Text, { text: "one" })));
  });
  const firstBox = root.children[0]!;
  const firstText = firstBox.children[0]!;

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(
      createElement(Box, {}, createElement(Text, { text: "a" }), createElement(Text, { text: "b" })),
    );
  });
  const box = root.children[0]!;
  if (box.children.length !== 2) throw new Error("expected two children");

  await act(async () => {
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
    await act(async () => {
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
  await act(async () => {
    ternRoot.render(createElement(Box, {}, createElement(Text, { text: "x" })));
  });
  await act(async () => {
    ternRoot.unmount();
  });
});

Deno.test("render() convenience mounts synchronously and returns a root", async () => {
  const { renderer, root, renderCalls } = mockRenderer();
  let ternRoot: ReturnType<typeof render> | undefined;
  await act(async () => {
    ternRoot = render(createElement(Text, { text: "hi" }), renderer);
  });
  // Legacy (sync) root: the commit must have happened before render() returns.
  if (root.children.length !== 1) throw new Error("tree not mounted by render()");
  if (root.children[0]!.props.text !== "hi") throw new Error("text prop mismatch");
  if (renderCalls.length === 0) throw new Error("render() must paint");
  await act(async () => {
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
  await act(async () => {
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

  await act(async () => {
    ternRoot.render(createElement(InputProbe));
  });

  if (keyHandlers.size !== 1) throw new Error(`expected 1 key handler, got ${keyHandlers.size}`);
  for (const handler of keyHandlers) handler(keyEvent({ char: "z" }));
  if (last.event === null || last.event.char !== "z") {
    throw new Error("useInput handler must receive key events");
  }

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(createElement(InactiveProbe));
  });
  if (keyHandlers.size !== 0) throw new Error("inactive handler must not subscribe");
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

  await act(async () => {
    ternRoot.render(
      createElement(StreamingText, { stream: stream(), autoScroll: false, wrap: false, width: 30 }),
    );
  });
  await act(async () => {}); // drain the stream's microtask chain

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
  if ("stream" in node.props || "autoScroll" in node.props || "wrap" in node.props) {
    throw new Error(`component props leaked into node props: ${JSON.stringify(node.props)}`);
  }
  if (node.props.width !== 30) throw new Error(`tern props lost: width = ${node.props.width}`);
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

  await act(async () => {
    ternRoot.render(createElement(StreamingText, { stream: gated() }));
  });
  await act(async () => {}); // let the first span land

  const node = root.children[0]!;
  if (node.spans.length !== 1 || node.spans[0]!.text !== "first") {
    throw new Error(`expected only the first span, got ${JSON.stringify(node.spans)}`);
  }

  await act(async () => {
    ternRoot.unmount();
  });
  release(); // unblock the producer so the return() teardown can run
  await act(async () => {});

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

  await act(async () => {
    ternRoot.render(createElement(StreamingText, { stream: gated() }));
  });
  await act(async () => {}); // let "a" and "b" land

  const node = root.children[0]!;
  const before = node.spans.map((span) => span.text).join("");
  if (before !== "ab") throw new Error(`expected "a","b" to land, got ${before}`);
  const rendersBeforeBatch = renderCalls.length;

  release(); // unblock the later batch
  await act(async () => {});

  const after = node.spans.map((span) => span.text).join("");
  if (after !== "abc") throw new Error(`expected "c" to land, got ${after}`);
  const rendersAfterBatch = renderCalls.length;
  if (rendersAfterBatch <= rendersBeforeBatch) {
    throw new Error(
      `render() must be invoked after appends (${rendersBeforeBatch} -> ${rendersAfterBatch})`,
    );
  }
  await act(async () => {
    ternRoot.unmount();
  });
});
