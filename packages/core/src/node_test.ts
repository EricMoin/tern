//! Tests: core exports package metadata.

import { createdNodes, fakeHandleOf, withFakeAddon } from "./testkit.ts";
import { Box, KeyEvent, Node, NodeHandle, NodeProps, Span, StreamingText, Text, TuiRenderer, TuiRendererOptions, createRenderer, name, version } from "./index.ts";


Deno.test("core exports package metadata", () => {
  if (name !== "@tern-tui/core") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.2.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("re-exported napi types are declared", () => {
  // Compile-time contract: the generated napi declarations must be reachable
  // through @tern-tui/core. `KeyEvent`/`TuiRendererOptions`/`NodeHandle`/
  // `TuiRenderer` are type-only; this function body only needs to type-check.
  const ev: KeyEvent = {
    name: "char",
    char: "q",
    ctrl: false,
    alt: false,
    shift: false,
  };
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
  if (node.children.length !== 0) {
    throw new Error("text nodes have no children");
  }
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
  if (node.props.padding !== 1) {
    throw new Error(`padding = ${node.props.padding}`);
  }
  const children = node.children;
  if (children.length !== 2) {
    throw new Error(`children.length = ${children.length}`);
  }
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
  if (node.children.length !== 1) {
    throw new Error("children getter must be a copy");
  }
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
    throw new Error(
      "insertBefore before-first must place the child ahead of the anchor",
    );
  }

  // Between siblings: insert y between a and b.
  const y = Text({ text: "y" });
  parent.insertBefore(y, b);
  kids = parent.children;
  if (kids.length !== 5) throw new Error(`children.length = ${kids.length}`);
  if (
    kids[0] !== x || kids[1] !== a || kids[2] !== y || kids[3] !== b ||
    kids[4] !== c
  ) {
    throw new Error(
      "insertBefore between siblings must preserve the surrounding order",
    );
  }

  // The detached parent (and the inserted children) stay unattached; the
  // reorder is recorded positionally and lands in the scene on attach.
  if (parent.attached) throw new Error("detached parent must stay unattached");
  if (x.attached || y.attached) {
    throw new Error("inserted children must stay unattached");
  }
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
  if (kids.length !== 1) {
    throw new Error("failed insert must not mutate children");
  }
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
  if (kids.length !== 2) {
    throw new Error("failed insert must not mutate children");
  }
  if (kids[0] !== a || kids[1] !== b) {
    throw new Error("failed insert must not reorder children");
  }
});

Deno.test("setProps works on a detached template", () => {
  const node = Text({ text: "old" });
  node.setProps({ text: "new", bold: true });
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.bold !== true) throw new Error(`bold = ${node.props.bold}`);
});

Deno.test("setProp on a detached template records the prop for materialization", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "old" });
    child.setProp("text", "new");
    child.setProp("bold", true);
    if (child.props.text !== "new" || child.props.bold !== true) {
      throw new Error("detached setProp must record into node.props");
    }
    if (createdNodes.length !== 0) {
      throw new Error("a detached setProp must not materialize a handle");
    }
    renderer.root.addChild(child);
    // Materialization passes the recorded props to the native create_node.
    const created = createdNodes.find((c) => c.type === "text");
    if (created === undefined) {
      throw new Error("attaching the child must create a native handle");
    }
    if (created.props?.text !== "new" || created.props?.bold !== true) {
      throw new Error(
        `materialized props must carry the setProp writes, got ${
          JSON.stringify(created.props)
        }`,
      );
    }
  });
});

Deno.test("setProp on an attached node routes through the native single-key path", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a" });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    child.setProp("fg", "#ff0000");
    if (
      handle.propWrites.length !== 1 ||
      handle.propWrites[0]![0] !== "fg" ||
      handle.propWrites[0]![1] !== "#ff0000"
    ) {
      throw new Error(
        `expected one set_prop("fg", ...), got ${
          JSON.stringify(handle.propWrites)
        }`,
      );
    }
    if (handle.fullWrites !== 0) {
      throw new Error("setProp must not call the full set_props");
    }
    if (child.props.fg !== "#ff0000") {
      throw new Error("node.props must mirror the single-key write");
    }
  });
});

Deno.test("setProp with an equal value performs no native call", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a" });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    child.setProp("text", "a"); // equal → skipped at the TS mirror
    const equalWrites = handle.propWrites.slice();
    if (equalWrites.length !== 0) {
      throw new Error(
        `an equal setProp must not cross into the native layer, got ${
          JSON.stringify(equalWrites)
        }`,
      );
    }
    child.setProp("text", "b"); // changed → exactly one native write
    const writes = handle.propWrites.slice();
    if (
      writes.length !== 1 || writes[0] === undefined || writes[0][1] !== "b"
    ) {
      throw new Error(
        `expected one set_prop("text", "b"), got ${JSON.stringify(writes)}`,
      );
    }
    if (child.props.text !== "b") {
      throw new Error("node.props must reflect the change");
    }
  });
});

Deno.test("setProps on an attached node sends only changed keys through set_prop", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    child.setProps({ text: "b", bold: true });
    if (
      handle.propWrites.length !== 1 ||
      handle.propWrites[0]![0] !== "text" ||
      handle.propWrites[0]![1] !== "b"
    ) {
      throw new Error(
        `only the changed key may go through set_prop, got ${
          JSON.stringify(handle.propWrites)
        }`,
      );
    }
    if (handle.fullWrites !== 0) {
      throw new Error("no removals → no full-map set_props");
    }
    if (child.props.text !== "b" || child.props.bold !== true) {
      throw new Error("node.props must mirror the update");
    }
  });
});

Deno.test("percentage size props pass through as strings and snapshot headlessly", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Box({
      width: "50%",
      min_width: "25%",
      max_width: "75%",
      height: 10,
    });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    // The `"N%"` strings cross the JS -> native boundary verbatim: the
    // binding's json_to_prop_value maps them to PropValue::Str, which
    // tern-layout reads as a percentage of the containing block's size.
    if (
      handle.props.width !== "50%" ||
      handle.props.min_width !== "25%" ||
      handle.props.max_width !== "75%" ||
      handle.props.height !== 10
    ) {
      throw new Error(
        `percentage size props must reach the native handle, got ${
          JSON.stringify(handle.props)
        }`,
      );
    }
    if (child.props.width !== "50%" || child.props.min_width !== "25%") {
      throw new Error("node.props must mirror the percentage strings");
    }
    // A percentage-updated setProps goes through the single-key path (the
    // other keys are kept, so no key is removed and no full-map set_props).
    child.setProps({
      width: "60%",
      min_width: "25%",
      max_width: "75%",
      height: 10,
    });
    if (handle.propWrites.length !== 1 || handle.propWrites[0]![1] !== "60%") {
      throw new Error(
        `expected one set_prop("width", "60%"), got ${
          JSON.stringify(handle.propWrites)
        }`,
      );
    }
    if (handle.fullWrites !== 0) {
      throw new Error("no removals -> no full-map set_props");
    }
    const widthAfter: string = String(handle.props.width);
    if (widthAfter !== "60%") {
      throw new Error(`handle width = ${widthAfter}`);
    }
    // The headless snapshot paints the percentage-sized scene without error.
    const frame = renderer.snapshotFrame(100, 10);
    if (frame.length !== 10) {
      throw new Error(`snapshotFrame must paint 10 rows, got ${frame.length}`);
    }
  });
});

Deno.test("grid props pass through to the scene props verbatim", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const grid = Box({
      display: "grid",
      grid_template_columns: "1fr 2fr",
      grid_template_rows: "auto 1fr",
      grid_auto_flow: "row-dense",
    });
    const item = Box({ grid_row: 2, grid_column: "span 2" });
    renderer.root.addChild(grid);
    grid.addChild(item);
    const gridHandle = fakeHandleOf(grid);
    const itemHandle = fakeHandleOf(item);
    if (gridHandle === null || itemHandle === null) {
      throw new Error("attached nodes must have native handles");
    }
    // The grid props cross the JS -> native boundary verbatim: the binding's
    // json_to_prop_value maps strings to PropValue::Str and numbers to
    // PropValue::Int, and tern-layout's props_to_style reads them by exactly
    // these keys (display / grid_template_columns / grid_template_rows /
    // grid_auto_flow / grid_row / grid_column).
    if (
      gridHandle.props.display !== "grid" ||
      gridHandle.props.grid_template_columns !== "1fr 2fr" ||
      gridHandle.props.grid_template_rows !== "auto 1fr" ||
      gridHandle.props.grid_auto_flow !== "row-dense"
    ) {
      throw new Error(
        `grid container props must reach the native handle, got ${
          JSON.stringify(gridHandle.props)
        }`,
      );
    }
    if (
      itemHandle.props.grid_row !== 2 ||
      itemHandle.props.grid_column !== "span 2"
    ) {
      throw new Error(
        `grid item placement must reach the native handle, got ${
          JSON.stringify(itemHandle.props)
        }`,
      );
    }
    if (
      grid.props.display !== "grid" ||
      grid.props.grid_template_columns !== "1fr 2fr" ||
      grid.props.grid_template_rows !== "auto 1fr" ||
      grid.props.grid_auto_flow !== "row-dense" ||
      item.props.grid_row !== 2 ||
      item.props.grid_column !== "span 2"
    ) {
      throw new Error("node.props must mirror the grid props");
    }
    // A grid-prop setProps goes through the single-key path (the other keys
    // are kept, so no key is removed and no full-map set_props).
    item.setProps({ grid_row: 3, grid_column: "span 2" });
    if (
      itemHandle.propWrites.length !== 1 || itemHandle.propWrites[0]![1] !== 3
    ) {
      throw new Error(
        `expected one set_prop("grid_row", 3), got ${
          JSON.stringify(itemHandle.propWrites)
        }`,
      );
    }
    if (itemHandle.fullWrites !== 0) {
      throw new Error("no removals -> no full-map set_props");
    }
    // Re-read through the declared prop type: the earlier `grid_row !== 2`
    // check narrows the readonly `props` getter chain to the literal `2`
    // (CFA is not invalidated by the `setProps` call), so compare the
    // annotated value instead of the narrowed access.
    const updatedRow: number | `span ${number}` = item.props.grid_row;
    if (updatedRow !== 3 || item.props.grid_column !== "span 2") {
      throw new Error("node.props must mirror the grid update");
    }
  });
});

Deno.test("setProps with equal props performs no native call", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    child.setProps({ text: "a", bold: true }); // fully equal → nothing to write
    if (handle.propWrites.length !== 0 || handle.fullWrites !== 0) {
      throw new Error(
        `an equal setProps must not touch the native layer ` +
          `(propWrites=${
            JSON.stringify(handle.propWrites)
          }, fullWrites=${handle.fullWrites})`,
      );
    }
    if (child.props.text !== "a" || child.props.bold !== true) {
      throw new Error("node.props must stay intact");
    }
  });
});

Deno.test("setProps with a removed key falls back to the full-map path", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    child.setProps({ text: "a" }); // bold removed
    if (handle.fullWrites !== 1) {
      throw new Error(
        `a removal needs the full-map replace, got fullWrites=${handle.fullWrites}`,
      );
    }
    if (handle.propWrites.length !== 0) {
      throw new Error(
        `the removal path must not use set_prop, got ${
          JSON.stringify(handle.propWrites)
        }`,
      );
    }
    if ("bold" in child.props) {
      throw new Error("removed key must leave node.props");
    }
  });
});

Deno.test("setProps strips undefined values like the binding drops them", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) {
      throw new Error("attached child must have a native handle");
    }
    // `undefined` has no scene representation: it must be treated as absent,
    // so this is a removal (bold → undefined) → full-map fallback, and the
    // mirror must not retain the phantom key. Built via a Record because
    // `exactOptionalPropertyTypes` rejects `bold: undefined` in literals.
    const next: Record<string, unknown> = { text: "a" };
    next.bold = undefined;
    child.setProps(next as NodeProps);
    if (handle.fullWrites !== 1) {
      throw new Error("undefined values must count as removals");
    }
    if ("bold" in child.props) {
      throw new Error("undefined-valued keys must be stripped");
    }
    if (child.props.text !== "a") {
      throw new Error("remaining props must be intact");
    }
  });
});

Deno.test("StreamingText builds a streaming_text node", () => {
  const node = StreamingText();
  if (!(node instanceof Node)) {
    throw new Error("StreamingText() must return a Node");
  }
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  if (Object.keys(node.props).length !== 0) {
    throw new Error(`expected empty props, got ${JSON.stringify(node.props)}`);
  }
  if (node.children.length !== 0) {
    throw new Error("streaming_text nodes have no children");
  }
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
  if (first === undefined || second === undefined) {
    throw new Error("recorded spans missing");
  }
  if (first.text !== "hello") throw new Error(`spans[0].text = ${first.text}`);
  if (first.style?.bold !== true) {
    throw new Error("span style must be recorded");
  }
  if (second.text !== "world") {
    throw new Error(`spans[1].text = ${second.text}`);
  }
  if (second.style !== undefined) {
    throw new Error("omitted style must stay undefined");
  }
  if (node.attached) throw new Error("node must stay unattached");
  (spans as Span[]).length = 0;
  if (node.spans.length !== 2) {
    throw new Error("spans getter must return a copy");
  }
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
  if (node.remove() !== false) {
    throw new Error("detached remove must return false");
  }
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
  if (parent.remove() !== false) {
    throw new Error("parentless remove must return false");
  }

  if (b.remove() !== true) {
    throw new Error("remove must return true when the node is in a tree");
  }
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

  if (childBox.remove() !== true) {
    throw new Error("subtree root remove must return true");
  }
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
  if (root.remove() !== false) {
    throw new Error("the scene root must not be removable");
  }
  if (!root.attached) throw new Error("the scene root must stay attached");
});
