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
  FocusManager,
  Input,
  Node,
  Panels,
  Spinner,
  StatusBar,
  StreamingText,
  Text,
  collapsePanel,
  createRenderer,
  editKey,
  expandPanel,
  focusManager,
  focusPanel,
  name,
  tick,
  togglePanel,
  useFocus,
  version,
} from "./index.ts";
import { setAddonForTesting } from "./addon.ts";
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

/** A fake native `TuiRenderer` standing in for the real addon. */
class FakeTuiRenderer {
  destroyed = false;
  constructor(_options: unknown) {}
  root(): NodeHandle {
    // The `Renderer` constructor only stores this in `Node.wrapRoot`;
    // the dispatch tests never touch it.
    return {} as NodeHandle;
  }
  poll_events(_timeoutMs: number): TernEventJs[] {
    return pendingEvents.splice(0);
  }
  render(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** The fake addon injected through `setAddonForTesting`. */
const fakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: class {},
  create_node: () => {
    throw new Error("create_node is not used by the dispatch tests");
  },
} as unknown as TernAddon;

/** Run `fn` with the fake addon installed, resetting the seam afterwards. */
function withFakeAddon(fn: () => void): void {
  pendingEvents.length = 0;
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
