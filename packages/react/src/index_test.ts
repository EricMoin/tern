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
import {
  Box as CoreBox,
  FocusManager,
  createRenderer,
  followTail,
  isStreamFollowing,
  scrollTo,
  syncStreamTail,
  type KeyEvent,
  type Node,
  type Renderer,
  type ResizeHandler,
  type Span,
  type TernEventJs,
} from "@tern/core";
import { setAddonForTesting } from "../../core/src/addon.ts";
import type { TernAddon } from "../../core/src/addon.ts";

// React 19 requires act() to be enabled explicitly in non-test-runner envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  Box,
  DiffView,
  Input,
  Panels,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  Text,
  ThemeProvider,
  createRoot,
  defaultTheme,
  hostConfig,
  name,
  render,
  toNodeProps,
  useApp,
  useFocus,
  useInput,
  usePanelMouseDrag,
  useResize,
  useTheme,
  version,
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
  keyHandlers: Set<(event: KeyEvent) => void>;
  resizeHandlers: Set<ResizeHandler>;
  focusHandlers: Set<(event: { focus_gained: boolean }) => void>;
} {
  const renderCalls: number[] = [];
  const keyHandlers = new Set<(event: KeyEvent) => void>();
  const resizeHandlers = new Set<ResizeHandler>();
  const focusHandlers = new Set<(event: { focus_gained: boolean }) => void>();
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
    onResize: (handler: ResizeHandler) => {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },
    onFocus: (handler: (event: { focus_gained: boolean }) => void) => {
      focusHandlers.add(handler);
      return () => focusHandlers.delete(handler);
    },
    destroy: () => {},
  } as unknown as Renderer;
  return { renderer, root, renderCalls, keyHandlers, resizeHandlers, focusHandlers };
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
  for (const fn of [
    Box,
    Text,
    StreamingText,
    Input,
    Spinner,
    StatusBar,
    Panels,
    DiffView,
    ScrollView,
    useFocus,
    useResize,
    createRoot,
    render,
    useApp,
    useInput,
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

  await act(async () => {
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

  await act(async () => {
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

// ---------------------------------------------------------------------------
// StreamingText auto-scroll wiring
//
// `<StreamingText>` feeds the core auto-scroll after each appended span:
// `syncStreamTail` pins `scroll_y` to the stream tail (content height minus
// the `clip_height` viewport) while following; a manual scroll above the tail
// detaches (pins the view); `followTail` re-attaches and snaps back. The
// tree mounts onto a real core `Renderer` over a *size-aware fake addon*
// (the `setAddonForTesting` seam — same approach as the @tern/core tests), so
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

/** Mouse events queued for the next `poll_events` call of the drag-test fake
 * renderer (consumed in order). */
const pendingMouseEvents: TernEventJs[] = [];

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
  poll_events(_timeoutMs: number): unknown[] {
    return [];
  }
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

/** A fake native `TuiRenderer` whose `poll_events` drains `pendingMouseEvents`
 * (the panel-drag tests dispatch mouse events through it). */
class DragFakeTuiRenderer {
  destroyed = false;
  constructor(_options: unknown) {}
  root(): unknown {
    return new FakeStreamNodeHandle("box");
  }
  poll_events(_timeoutMs: number): TernEventJs[] {
    return pendingMouseEvents.splice(0);
  }
  hit_test(_col: number, _row: number): bigint[] {
    // Every press lands on a painted cell (the routing gate in
    // `usePanelMouseDrag` consults this).
    return [7n];
  }
  render(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** The fake addon for the panel-drag tests: mouse events flow through
 * `poll_events` and `content_size` reads the per-handle registry. */
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

    await act(async () => {
      ternRoot.render(
        createElement(StreamingText, { stream: source.stream, clip_height: 2, width: 10 }),
      );
    });
    await act(async () => {}); // mount effects; the pump parks on next()

    // Three newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    // One push per act: each act drains the pump's microtasks, so the pump
    // parks on a fresh next() before the next push is delivered.
    await act(async () => {
      source.push({ text: "a\n" });
    });
    await act(async () => {
      source.push({ text: "b\n" });
    });
    await act(async () => {
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
    await act(async () => {
      source.push({ text: "d\n" }); // 5 rows now — the view stays pinned
    });
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // followTail: re-attach and snap to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach");
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    await act(async () => {
      source.push({ text: "e\n" });
    });
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    await act(async () => {
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

    await act(async () => {
      ternRoot.render(
        createElement(StreamingText, { stream: source.stream, autoScroll: false, clip_height: 2, width: 10 }),
      );
    });
    await act(async () => {});
    await act(async () => {
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

    await act(async () => {
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
    const ternRoot = createRoot(renderer);
    const panelsRef: { current: Node | null } = { current: null };

    await act(async () => {
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
    await act(async () => {}); // flush the mount effect (mouse subscription)

    const panels = panelsRef.current;
    if (panels === null) throw new Error("ref must receive the panels node");
    // Laid-out sizes: panel A rows 0-2, gutter row 3, panel B rows 4-5,
    // stack 9 rows tall.
    fakeDragSizes.set(panels.handle, { width: 60, height: 9 });
    fakeDragSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
    fakeDragSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });

    const emit = (kind: string, column: number, row: number): void => {
      pendingMouseEvents.push({
        type: "mouse",
        mouse: { kind, column, row, ctrl: false, alt: false, shift: false },
      });
      renderer.pollEvents(0);
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

    await act(async () => {
      ternRoot.unmount();
    });
  } finally {
    setAddonForTesting(null);
    pendingMouseEvents.length = 0;
    fakeDragSizes.clear();
  }
});

// ---------------------------------------------------------------------------
// Roadmap host components
// ---------------------------------------------------------------------------

Deno.test("Input materializes with its text leaf and strips component props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(createElement(Spinner, { interval: 5 }));
  });
  const spinner = root.children[0];
  if (!spinner || spinner.type !== "spinner") throw new Error("expected a spinner node");

  const text = () => spinner.props.text as string;
  const before = text();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const after = text();
  if (after === before) throw new Error("spinner must advance while mounted");

  await act(async () => {
    ternRoot.unmount();
  });
  const frozen = text();
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (text() !== frozen) throw new Error("spinner interval must be cleared on unmount");
});

Deno.test("Spinner pauses ticks while unfocused and resumes on focus regain", async () => {
  const { renderer, root, renderCalls, focusHandlers } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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
  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
    ternRoot.unmount();
  });
  if (manager.has("main")) throw new Error("input must unregister on unmount");
  if (manager.activeId !== null) throw new Error("active focus must clear on unregister");
});

Deno.test("Select materializes with filter and option rows and strips component props", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
    ternRoot.unmount();
  });
});

Deno.test("Select floating mode sets a z_index prop", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

Deno.test("ScrollView materializes with region props, children and a scrollbar leaf", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(el(1));
  });
  const view = root.children[0]!;
  const firstLeaf = view.children[0];

  await act(async () => {
    ternRoot.render(el(3));
  });
  if (view.props.scroll_y !== 3) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  if (view.children[0] !== firstLeaf) throw new Error("scrollbar leaf must survive re-render");
});

Deno.test("ScrollView resolves the scroll_view component preset from the theme", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(createElement(App));
  });

  if (nodeRef.current === null) throw new Error("ref must receive the scene node");
  if (!manager.has("probe")) throw new Error("useFocus must register the id");
  if (!manager.focus("probe")) throw new Error("focus(probe) must succeed");
  for (const handler of keyHandlers) handler(keyEvent({ char: "x" }));
  if (hits.length !== 1 || hits[0]!.char !== "x") {
    throw new Error(`routed hits = ${hits.length}`);
  }

  await act(async () => {
    ternRoot.unmount();
  });
  if (manager.has("probe")) throw new Error("useFocus must dispose on unmount");
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

Deno.test("host components fall back to the default theme without a provider", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
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

  await act(async () => {
    ternRoot.render(createElement(App, { theme: { palette: { danger: { fg: "#ff0000" } } } }));
  });
  const node = root.children[0]!;
  // Captured into a fresh local per assertion: TS narrows getter-only prop
  // accesses across calls (memory gotcha), which would flag the second
  // comparison as "no overlap".
  const first = node.props.fg;
  if (first !== "#ff0000") throw new Error(`first fg = ${first}`);

  await act(async () => {
    ternRoot.render(createElement(App, { theme: { palette: { danger: { fg: "#00ff00" } } } }));
  });
  const second = node.props.fg;
  if (second !== "#00ff00") throw new Error(`re-resolved fg = ${second}`);
});

Deno.test("useTheme returns the provider theme and merges over the default", async () => {
  const { renderer, root } = mockRenderer();
  const ternRoot = createRoot(renderer);
  const captured: { theme: Theme | null } = { theme: null };

  function Probe() {
    captured.theme = useTheme();
    return createElement(Text, { text: "p" });
  }

  await act(async () => {
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
