//! Tests: menuHover moves the highlight clamped; menuClick activates l.

import { createdNodes, state, withFakeAddon } from "./testkit.ts";
import { expectedBar, menuFixture, menuRowTexts, progressInnerOf, treeFixture, treeKeyBase, treeRowTexts } from "./testkit.ts";
import { FocusManager, KeyEvent, Menu, Node, NodeProps, PROGRESS_DEFAULT_WIDTH, Progress, ProgressProps, TREE_COLLAPSED_GLYPH, TREE_EXPANDED_GLYPH, TREE_GUIDE_VERTICAL, Tabs, Text, Tree, TreeNode, collapseTreeNode, createRenderer, defaultTheme, expandTreeNode, menuClick, menuHover, mergeTheme, name, resolveTheme, setProgress, toggleTreeNode, treeKey, visibleTreeRows } from "./index.ts";


Deno.test("menuHover moves the highlight clamped; menuClick activates like enter", () => {
  const menu = Menu({ items: menuFixture(), open: true });
  // Hover the third row (Quit, a leaf).
  const hovered = menuHover(menu, 2);
  if (hovered.highlighted !== 2) {
    throw new Error(`hover = ${hovered.highlighted}`);
  }
  if (menu.props.highlighted !== 2) {
    throw new Error(`node highlighted = ${menu.props.highlighted}`);
  }
  if (menu.children[2]?.props.reversed !== true) {
    throw new Error("the hovered row must be reversed");
  }
  // Hovering beyond the last visible row clamps.
  const clamped = menuHover(menu, 99);
  if (clamped.highlighted !== 2) {
    throw new Error(`hover clamp = ${clamped.highlighted}`);
  }
  // Click on a leaf activates it and dismisses the menu.
  const clicked = menuClick(menu, 2);
  if (clicked.activated !== "2") {
    throw new Error(`click activated = ${clicked.activated}`);
  }
  if (clicked.open !== false) throw new Error(`click open = ${clicked.open}`);
  if (menu.props.open !== false) {
    throw new Error(`node open after click = ${menu.props.open}`);
  }
  // Clicking a branch opens its submenu instead of dismissing.
  const branchMenu = Menu({ items: menuFixture(), open: true });
  const branchClicked = menuClick(branchMenu, 0);
  if (branchClicked.activated !== null) {
    throw new Error(`branch click activated = ${branchClicked.activated}`);
  }
  if (branchClicked.open_submenus.join(",") !== "0") {
    throw new Error(
      `branch click open = ${branchClicked.open_submenus.join(",")}`,
    );
  }
  if (branchMenu.props.open !== true) {
    throw new Error("clicking a branch must not dismiss the menu");
  }
  if (menuRowTexts(branchMenu).join(",") !== "File,  New,  Open,Edit,Quit") {
    throw new Error(
      `rows after branch click = ${menuRowTexts(branchMenu).join(",")}`,
    );
  }
});

Deno.test("Tree composes one collapsed leaf per top-level node with glyphs", () => {
  const tree = Tree({ nodes: treeFixture() });
  if (tree.type !== "tree") throw new Error(`type = ${tree.type}`);
  if (tree.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${tree.props.flex_direction}`);
  }
  if (tree.props.highlight !== 0) {
    throw new Error(`highlight = ${tree.props.highlight}`);
  }
  // The model / bookkeeping keys never reach the scene props.
  if (
    "nodes" in tree.props || "expanded" in tree.props || "indent" in tree.props
  ) {
    throw new Error("nodes/expanded/indent must not reach the scene props");
  }
  // All collapsed: only the three top-level rows materialize.
  const rows = treeRowTexts(tree);
  if (rows.length !== 3) throw new Error(`rows = ${JSON.stringify(rows)}`);
  // Branches carry the collapsed glyph + space; the leaf carries two spaces.
  if (rows[0] !== `${TREE_COLLAPSED_GLYPH} src`) {
    throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  }
  if (rows[1] !== `${TREE_COLLAPSED_GLYPH} docs`) {
    throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  }
  if (rows[2] !== "  package.json") {
    throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  }
  // The highlighted (first) row is reversed; the others are not.
  if (tree.children[0]?.props.reversed !== true) {
    throw new Error("row 0 must be reversed");
  }
  if (tree.children[1]?.props.reversed === true) {
    throw new Error("only the highlighted row may be reversed");
  }
});

Deno.test("Tree indentation guides draw a vertical bar under a continuing ancestor", () => {
  // Expand `src` and its `components` child so nested rows appear.
  const tree = Tree({ nodes: treeFixture(), expanded: ["0", "0.1"] });
  const rows = treeRowTexts(tree);
  // Visible order: src, index.ts, components, button.ts, input.ts, docs, package.json.
  // `src` has a following sibling (docs), so its children draw a `│ ` guide.
  if (rows[0] !== `${TREE_EXPANDED_GLYPH} src`) {
    throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  }
  if (rows[1] !== `${TREE_GUIDE_VERTICAL} ` + "  index.ts") {
    throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  }
  if (rows[2] !== `${TREE_GUIDE_VERTICAL} ${TREE_EXPANDED_GLYPH} components`) {
    throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  }
  // Depth-2 leaves: one guide from `src` (has next sibling -> bar) + one from
  // `components` (last child of src -> gap), then the leaf glyph slot.
  if (rows[3] !== `${TREE_GUIDE_VERTICAL} ` + "    button.ts") {
    throw new Error(`row3 = ${JSON.stringify(rows[3])}`);
  }
  if (rows[4] !== `${TREE_GUIDE_VERTICAL} ` + "    input.ts") {
    throw new Error(`row4 = ${JSON.stringify(rows[4])}`);
  }
  if (rows[5] !== `${TREE_COLLAPSED_GLYPH} docs`) {
    throw new Error(`row5 = ${JSON.stringify(rows[5])}`);
  }
  if (rows[6] !== "  package.json") {
    throw new Error(`row6 = ${JSON.stringify(rows[6])}`);
  }
});

Deno.test("treeKey right/left/enter expand, collapse, and walk the tree", () => {
  const tree = Tree({ nodes: treeFixture() });
  // right on a collapsed branch expands it (src has 2 children).
  const expanded = treeKey(tree, { name: "right", ...treeKeyBase });
  if (expanded.count !== 5) {
    throw new Error(`count after expand = ${expanded.count}`);
  }
  if (visibleTreeRows(tree)[1]?.node.label !== "index.ts") {
    throw new Error(`first child = ${visibleTreeRows(tree)[1]?.node.label}`);
  }
  // right again on the (expanded) branch steps into the first child.
  const stepIn = treeKey(tree, { name: "right", ...treeKeyBase });
  if (stepIn.highlight !== 1) {
    throw new Error(`step-in highlight = ${stepIn.highlight}`);
  }
  // down to `components`, then enter expands it (2 more children).
  treeKey(tree, { name: "down", ...treeKeyBase });
  const openComponents = treeKey(tree, { name: "enter", ...treeKeyBase });
  if (openComponents.count !== 7) {
    throw new Error(`count after enter = ${openComponents.count}`);
  }
  // left on the expanded `components` collapses it back.
  const collapse = treeKey(tree, { name: "left", ...treeKeyBase });
  if (collapse.count !== 5) {
    throw new Error(`count after collapse = ${collapse.count}`);
  }
  const row = visibleTreeRows(tree)[collapse.highlight];
  if (row?.node.label !== "components" || row.expanded !== false) {
    throw new Error(
      `highlight row = ${
        JSON.stringify(row?.node.label)
      } expanded=${row?.expanded}`,
    );
  }
  // left on a collapsed node jumps to its parent (`src`).
  const toParent = treeKey(tree, { name: "left", ...treeKeyBase });
  if (visibleTreeRows(tree)[toParent.highlight]?.node.label !== "src") {
    throw new Error(
      `parent = ${visibleTreeRows(tree)[toParent.highlight]?.node.label}`,
    );
  }
});

Deno.test("expandTreeNode / collapseTreeNode / toggleTreeNode drive expand state by key", () => {
  const tree = Tree({ nodes: treeFixture() });
  if (expandTreeNode(tree, "0") !== true) {
    throw new Error("expand must report a change");
  }
  if (expandTreeNode(tree, "0") !== false) {
    throw new Error("re-expand must be a no-op");
  }
  if (visibleTreeRows(tree).length !== 5) {
    throw new Error(`after expand = ${visibleTreeRows(tree).length}`);
  }
  if (collapseTreeNode(tree, "0") !== true) {
    throw new Error("collapse must report a change");
  }
  if (visibleTreeRows(tree).length !== 3) {
    throw new Error(`after collapse = ${visibleTreeRows(tree).length}`);
  }
  if (toggleTreeNode(tree, "0") !== true) {
    throw new Error("toggle must report a change");
  }
  if (visibleTreeRows(tree)[0]?.expanded !== true) {
    throw new Error("toggle must expand");
  }
  // A custom id keys the expand state instead of the index path.
  const keyed = Tree({
    nodes: [{ id: "root", label: "root", children: [{ label: "child" }] }],
  });
  if (expandTreeNode(keyed, "0") !== false) {
    throw new Error("index-path key must miss a custom-id node");
  }
  if (expandTreeNode(keyed, "root") !== true) {
    throw new Error("custom id must expand");
  }
  if (visibleTreeRows(keyed).length !== 2) {
    throw new Error(`keyed expand = ${visibleTreeRows(keyed).length}`);
  }
});

Deno.test("treeKey up/down move the highlight and clamp at the ends", () => {
  const tree = Tree({ nodes: treeFixture() });
  const down = treeKey(tree, { name: "down", ...treeKeyBase });
  if (down.highlight !== 1) throw new Error(`down = ${down.highlight}`);
  const up = treeKey(tree, { name: "up", ...treeKeyBase });
  if (up.highlight !== 0) throw new Error(`up = ${up.highlight}`);
  const upClamp = treeKey(tree, { name: "up", ...treeKeyBase });
  if (upClamp.highlight !== 0) {
    throw new Error(`up clamp = ${upClamp.highlight}`);
  }
  for (let i = 0; i < 5; i++) treeKey(tree, { name: "down", ...treeKeyBase });
  if ((tree.props.highlight as number) !== 2) {
    throw new Error(`down clamp = ${tree.props.highlight}`);
  }
  // The reversed leaf follows the highlight.
  if (tree.children[2]?.props.reversed !== true) {
    throw new Error("last row must be reversed");
  }
});

Deno.test("a large tree materializes only the visible window and clamps scroll", () => {
  // 1000 top-level branches, each with 3 children.
  const nodes: TreeNode[] = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push({
      label: `dir-${i}`,
      children: [{ label: "a" }, { label: "b" }, { label: "c" }],
    });
  }
  const tree = Tree({ nodes, clip_height: 5 });
  // Collapsed: 1000 visible rows, but only 5 materialize.
  if (tree.children.length !== 5) {
    throw new Error(`window = ${tree.children.length}`);
  }
  if (visibleTreeRows(tree).length !== 5) {
    throw new Error(`visible = ${visibleTreeRows(tree).length}`);
  }
  if (treeRowTexts(tree)[0] !== `${TREE_COLLAPSED_GLYPH} dir-0`) {
    throw new Error(`row0 = ${JSON.stringify(treeRowTexts(tree)[0])}`);
  }
  // Drive down well past the window: the window still holds 5 leaves and the
  // highlighted row stays inside it.
  for (let i = 0; i < 40; i++) treeKey(tree, { name: "down", ...treeKeyBase });
  if (tree.children.length !== 5) {
    throw new Error(`window after scroll = ${tree.children.length}`);
  }
  if ((tree.props.highlight as number) !== 40) {
    throw new Error(`highlight = ${tree.props.highlight}`);
  }
  if ((tree.props.scroll_y as number) !== 36) {
    throw new Error(`scroll_y = ${tree.props.scroll_y}`);
  }
  if (treeRowTexts(tree)[4] !== `${TREE_COLLAPSED_GLYPH} dir-40`) {
    throw new Error(`bottom row = ${JSON.stringify(treeRowTexts(tree)[4])}`);
  }
  // Expanding one branch inserts its 3 children into the visible-row count;
  // dir-0 has a following sibling, so its children draw a `│ ` guide.
  const first = Tree({ nodes, clip_height: 5 });
  expandTreeNode(first, "0");
  if (treeRowTexts(first)[1] !== `${TREE_GUIDE_VERTICAL} ` + "  a") {
    throw new Error(
      `expanded child = ${JSON.stringify(treeRowTexts(first)[1])}`,
    );
  }
});

Deno.test("Progress composes a framed gauge: fill leaf + percentage readout", () => {
  // Defaults: plain frame, outer width 20 (inner 18), value 0/max 100.
  const node = Progress();
  if (node.type !== "progress") throw new Error(`type = ${node.type}`);
  if (node.props.border_style !== "plain") {
    throw new Error(`border_style = ${node.props.border_style}`);
  }
  if (node.props.height !== 1) throw new Error(`height = ${node.props.height}`);
  if (node.props.width !== PROGRESS_DEFAULT_WIDTH) {
    throw new Error(`width = ${node.props.width}`);
  }
  // The composition bookkeeping keys are consumed by the factory — never
  // scene props (`ratio` is the bar model state, like Tabs' `active`, so it
  // stays on the props).
  if ("label" in node.props || "show_percentage" in node.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(node.props)}`);
  }
  // Composition: the in-flow fill leaf (child 0) + the percentage readout
  // overlay (the last child); no label by default.
  if (node.children.length !== 2) {
    throw new Error(`children = ${node.children.length}`);
  }
  const bar = node.children[0];
  if (bar === undefined || bar.type !== "text") {
    throw new Error("the fill must be a text leaf");
  }
  if (bar.props.text !== expectedBar(0, progressInnerOf(node))) {
    throw new Error(`empty bar = ${JSON.stringify(bar.props.text)}`);
  }
  const readout = node.children[1];
  if (readout === undefined || readout.props.text !== "0%") {
    throw new Error(`readout = ${JSON.stringify(readout?.props.text)}`);
  }
  if (readout?.props.position !== "absolute" || readout?.props.right !== 0) {
    throw new Error(`readout position = ${JSON.stringify(readout?.props)}`);
  }
  if (readout?.props.z_index !== 1) {
    throw new Error("the readout must overlay the fill (z_index 1)");
  }
});

Deno.test("Progress fill-cell math: ceil(value/max * inner_width) filled cells", () => {
  // width 6 with a plain frame => inner width 4.
  const cases: Array<[number, number, string]> = [
    [0, 4, "░░░░"],
    [1, 4, "▓░░░"],
    [2, 4, "▓▓░░"],
    [3, 4, "▓▓▓░"],
    [4, 4, "▓▓▓▓"],
    // value > max clamps to full; ceil rounds partial cells up.
    [5, 4, "▓▓▓▓"],
    [1, 3, "▓▓░░"], // ceil(1/3*4) = ceil(1.33) = 2 of 4
  ];
  for (const [value, max, expected] of cases) {
    const node = Progress({ value, max, width: 6 });
    const text = node.children[0]?.props.text;
    if (text !== expected) {
      throw new Error(
        `value=${value} max=${max} bar = ${JSON.stringify(text)} (want ${
          JSON.stringify(expected)
        })`,
      );
    }
  }
});

Deno.test("Progress percentage readout: ceil(value/max*100)%", () => {
  const readout = (node: Node): string | undefined =>
    node.children[node.children.length - 1]?.props.text;
  if (readout(Progress({ value: 5, max: 10, width: 6 })) !== "50%") {
    throw new Error("50% readout");
  }
  if (readout(Progress({ value: 1, max: 3, width: 6 })) !== "34%") {
    throw new Error("ceil(1/3*100) = 34% readout");
  }
  if (readout(Progress({ value: 99, max: 100, width: 6 })) !== "99%") {
    throw new Error("99% readout");
  }
  // show_percentage: false drops the readout leaf entirely.
  const noReadout = Progress({
    value: 1,
    max: 2,
    width: 6,
    show_percentage: false,
  });
  if (
    noReadout.children.length !== 1 ||
    noReadout.children[0]?.props.text !== "▓▓░░"
  ) {
    throw new Error(`no-readout composition = ${noReadout.children.length}`);
  }
});

Deno.test("Progress label: left-aligned overlay inside the bar area when there is room", () => {
  // width 12, plain frame => inner 10; "copy" (4 cells) + "100%" reserve (4)
  // fits.
  const fits = Progress({ value: 2, max: 4, width: 12, label: "copy" });
  if (fits.children.length !== 3) {
    throw new Error(`label composition = ${fits.children.length}`);
  }
  const label = fits.children[1];
  if (label === undefined || label.props.text !== "copy") {
    throw new Error(`label text = ${JSON.stringify(label?.props.text)}`);
  }
  if (label.props.position !== "absolute" || label.props.left !== 0) {
    throw new Error(`label position = ${JSON.stringify(label?.props)}`);
  }
  if (label.props.dim !== true) throw new Error("the label must be dimmed");
  // The fill leaf still counts the full inner width (the label overlays it).
  if (
    fits.children[0]?.props.text !== expectedBar(0.5, progressInnerOf(fits))
  ) {
    throw new Error("the fill must stay exact under the label overlay");
  }
  // No room: a label wider than inner - reserve is dropped.
  const tight = Progress({ value: 1, max: 4, width: 8, label: "copying" }); // inner 6 < 4 + 4
  if (tight.children.length !== 2 || tight.children[1]?.props.text !== "25%") {
    throw new Error(`tight label must be dropped (${tight.children.length})`);
  }
  // With the readout off, the label only competes against the inner width.
  const wide = Progress({
    value: 1,
    max: 4,
    width: 10,
    label: "copying",
    show_percentage: false,
  }); // inner 8
  if (
    wide.children.length !== 2 || wide.children[1]?.props.text !== "copying"
  ) {
    throw new Error(
      `no-readout label = ${
        JSON.stringify(wide.children.map((c) => c.props.text))
      }`,
    );
  }
  // An empty label string is never composed.
  const empty = Progress({ value: 1, max: 4, width: 12, label: "" });
  if (empty.children.length !== 2) {
    throw new Error("an empty label must be dropped");
  }
});

Deno.test("Progress ratio prop drives the bar directly (wins over value/max)", () => {
  const ratio = Progress({ value: 9, max: 10, ratio: 0.5, width: 6 });
  if (
    ratio.children[0]?.props.text !== expectedBar(0.5, progressInnerOf(ratio))
  ) {
    throw new Error(
      `ratio bar = ${JSON.stringify(ratio.children[0]?.props.text)}`,
    );
  }
  if (ratio.children[1]?.props.text !== "50%") {
    throw new Error(
      `ratio readout = ${JSON.stringify(ratio.children[1]?.props.text)}`,
    );
  }
  // The ratio is clamped into [0, 1].
  const over = Progress({ ratio: 1.5, width: 6 });
  if (over.children[0]?.props.text !== expectedBar(1, progressInnerOf(over))) {
    throw new Error("ratio must clamp to 1");
  }
  const under = Progress({ ratio: -0.5, width: 6 });
  if (
    under.children[0]?.props.text !== expectedBar(0, progressInnerOf(under))
  ) {
    throw new Error("ratio must clamp to 0");
  }
});

Deno.test("Progress border_style none fills the full outer width (no frame columns)", () => {
  const node = Progress({ value: 1, max: 4, width: 4, border_style: "none" });
  if (node.props.border_style !== "none") {
    throw new Error(`border_style = ${node.props.border_style}`);
  }
  // inner = 4 (no border columns): 1 of 4 cells filled.
  if (node.children[0]?.props.text !== "▓░░░") {
    throw new Error(`bar = ${JSON.stringify(node.children[0]?.props.text)}`);
  }
});

Deno.test("setProgress updates a live bar in place without rebuilding", () => {
  // width 12 (inner 10): the label "work" (4) + the readout reserve (4) fits.
  const node = Progress({ value: 1, max: 4, width: 12, label: "work" });
  if (node.children.length !== 3) {
    throw new Error(`label composition = ${node.children.length}`);
  }
  const barBefore = node.children[0];
  const labelBefore = node.children[1];
  const readoutBefore = node.children[2];
  // Accessors: setProgress mutates the node's props and leaves in place, which
  // TS's control flow cannot see — reading through functions defeats the
  // stale narrowing (the established pattern in this suite).
  const valueOf = (): unknown => node.props.value;
  const maxOf = (): unknown => node.props.max;
  const barText = (): string => node.children[0]?.props.text as string;
  const readoutText = (): string => node.children[2]?.props.text as string;

  setProgress(node, 3);
  if (valueOf() !== 3 || maxOf() !== 4) {
    throw new Error(`props = ${JSON.stringify(node.props)}`);
  }
  // The composition is not rebuilt: the same leaf instances are repainted.
  if (node.children[0] !== barBefore) {
    throw new Error("setProgress must not rebuild the fill leaf");
  }
  if (node.children[1] !== labelBefore) {
    throw new Error("setProgress must not rebuild the label leaf");
  }
  if (node.children[2] !== readoutBefore) {
    throw new Error("setProgress must not rebuild the readout leaf");
  }
  if (barText() !== expectedBar(0.75, progressInnerOf(node))) {
    throw new Error(`bar after setProgress = ${JSON.stringify(barText())}`);
  }
  if (readoutText() !== "75%") {
    throw new Error(
      `readout after setProgress = ${JSON.stringify(readoutText())}`,
    );
  }

  // The explicit max argument overrides the node's current max.
  setProgress(node, 1, 2);
  if (maxOf() !== 2) throw new Error(`max = ${maxOf()}`);
  if (barText() !== expectedBar(0.5, progressInnerOf(node))) {
    throw new Error(`bar after max override = ${JSON.stringify(barText())}`);
  }
  // 0% clamps the bar empty.
  setProgress(node, 0);
  if (barText() !== expectedBar(0, progressInnerOf(node))) {
    throw new Error(`empty bar = ${JSON.stringify(barText())}`);
  }
  if (readoutText() !== "0%") {
    throw new Error(`0% readout = ${JSON.stringify(readoutText())}`);
  }
});

Deno.test("Progress resolves the progress component preset through resolveTheme", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { progress: { fg: "#98c379", border_style: "double" } },
  });
  const out = resolveTheme(custom, { component: "progress" });
  if (out.fg !== "#98c379") throw new Error(`fg = ${out.fg}`);
  if (out.border_style !== "double") {
    throw new Error(`border_style = ${out.border_style}`);
  }
  if ("component" in out) {
    throw new Error(`component leaked: ${JSON.stringify(out)}`);
  }
  // The preset is stamped onto the framed box by the factory path (the
  // explicit prop wins over the preset). The resolveTheme output is widened
  // NodeProps (its `width` now also admits `"N%"` strings), so it narrows to
  // ProgressProps at the call site — the same cast the react host uses.
  const node = Progress(
    resolveTheme(custom, {
      component: "progress",
      width: 6,
      value: 1,
      max: 4,
    }) as ProgressProps,
  );
  if (node.props.fg !== "#98c379") {
    throw new Error(`factory fg = ${node.props.fg}`);
  }
  if (node.props.border_style !== "double") {
    throw new Error(`factory border_style = ${node.props.border_style}`);
  }
});

Deno.test("Progress materializes as a box through the native kind map", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // width 12 (inner 10): the label "x" fits alongside the readout.
    renderer.root.addChild(
      Progress({ value: 1, max: 4, width: 12, label: "x" }),
    );
    // The progress element materializes its root as a box; the composition
    // (fill + label + readout) materializes as text leaves.
    if (createdNodes.length !== 4) {
      throw new Error(`created = ${JSON.stringify(createdNodes)}`);
    }
    if (createdNodes[0]?.type !== "box") {
      throw new Error(`root native type = ${createdNodes[0]?.type}`);
    }
    for (let i = 1; i < 4; i++) {
      if (createdNodes[i]?.type !== "text") {
        throw new Error(`child ${i} native type = ${createdNodes[i]?.type}`);
      }
    }
  });
});

Deno.test("FocusManager routes keys to the focused element's handler", () => {
  const manager = new FocusManager();
  const received: Array<{ id: string; key: KeyEvent }> = [];
  manager.register({
    id: "a",
    node: Text({ text: "a" }),
    onKey: (key) => received.push({ id: "a", key }),
  });
  manager.register({
    id: "b",
    node: Text({ text: "b" }),
    onKey: (key) => received.push({ id: "b", key }),
  });
  const key: KeyEvent = {
    name: "char",
    char: "x",
    ctrl: false,
    alt: false,
    shift: false,
  };
  if (manager.routeKey(key) !== false) {
    throw new Error("nothing focused must not route");
  }
  if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
  if (manager.activeId !== "a") {
    throw new Error(`activeId = ${manager.activeId}`);
  }
  if (manager.routeKey(key) !== true) {
    throw new Error("focused route must be handled");
  }
  const afterA = received.length;
  if (afterA !== 1 || received[0]?.id !== "a") {
    throw new Error(`key must route to a (${afterA})`);
  }
  manager.focus("b");
  manager.routeKey(key);
  const afterB = received.length;
  if (afterB !== 2 || received[1]?.id !== "b") {
    throw new Error(`key must route to b (${afterB})`);
  }
  if (received[1]?.key !== key) {
    throw new Error("handler must receive the key event verbatim");
  }
});

Deno.test("routeKey with an explicit node routes to that node's handler", () => {
  const manager = new FocusManager();
  const bNode = Text({ text: "b" });
  let hits = 0;
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => hits++ });
  manager.register({ id: "b", node: bNode, onKey: () => (hits += 10) });
  const key: KeyEvent = {
    name: "enter",
    ctrl: false,
    alt: false,
    shift: false,
  };
  manager.routeKey(key, bNode);
  if (hits !== 10) throw new Error(`explicit node route = ${hits}`);
});

Deno.test("FocusManager routes paste to the focused element's paste handler", () => {
  const manager = new FocusManager();
  const pasted: Array<{ id: string; text: string }> = [];
  // Length read through a function: TS narrows a const-typed array's `length`
  // to the literal of the last checked comparison, which would flag the
  // follow-up `!== 2` as unintentional.
  const pasteCount = () => pasted.length;
  manager.register({
    id: "a",
    node: Text({ text: "a" }),
    onKey: () => {},
    onPaste: (text) => pasted.push({ id: "a", text }),
  });
  manager.register({
    id: "b",
    node: Text({ text: "b" }),
    onKey: () => {},
    onPaste: (text) => pasted.push({ id: "b", text }),
  });
  if (manager.routePaste("xy") !== false) {
    throw new Error("nothing focused must not route");
  }
  if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
  if (manager.routePaste("xy") !== true) {
    throw new Error("focused paste must be handled");
  }
  if (pasteCount() !== 1 || pasted[0]?.id !== "a" || pasted[0]?.text !== "xy") {
    throw new Error(
      `paste must route to a verbatim (${JSON.stringify(pasted)})`,
    );
  }
  manager.focus("b");
  manager.routePaste("z");
  if (pasteCount() !== 2 || pasted[1]?.id !== "b" || pasted[1]?.text !== "z") {
    throw new Error(`paste must route to b (${JSON.stringify(pasted)})`);
  }
});

Deno.test("routePaste falls through when the focused element registers no paste handler", () => {
  const manager = new FocusManager();
  const pasted: string[] = [];
  // Only `a` handles paste; `b` is a key-only focusable.
  manager.register({
    id: "a",
    node: Text({ text: "a" }),
    onKey: () => {},
    onPaste: (t) => pasted.push(t),
  });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.focus("b");
  if (manager.routePaste("xy") !== false) {
    throw new Error("a paste-blind element must not consume");
  }
  if (pasted.length !== 0) {
    throw new Error(
      `no dispatch without an onPaste handler (${pasted.length})`,
    );
  }
  manager.focus("a");
  if (manager.routePaste("xy") !== true) {
    throw new Error("a paste-handling element must consume");
  }
  if (pasted.join(",") !== "xy") {
    throw new Error(`pasted = ${pasted.join(",")}`);
  }
});

Deno.test("routePaste with an explicit node routes to that node's paste handler", () => {
  const manager = new FocusManager();
  const bNode = Text({ text: "b" });
  const pasted: string[] = [];
  manager.register({
    id: "a",
    node: Text({ text: "a" }),
    onKey: () => {},
    onPaste: (t) => pasted.push("a:" + t),
  });
  manager.register({
    id: "b",
    node: bNode,
    onKey: () => {},
    onPaste: (t) => pasted.push("b:" + t),
  });
  manager.routePaste("xy", bNode);
  if (pasted.join(",") !== "b:xy") {
    throw new Error(`explicit node paste = ${pasted.join(",")}`);
  }
});
