/**
 * file-browser — a file-tree browser example scene for the tern TUI engine,
 * built on the Tree widget (Phase 8) through the `@tern-tui/react` host.
 *
 * Renders a rounded `Box` column holding a title, a key legend, a `<Tree>`
 * (the nested file model with indentation guides `│ `, expand/collapse glyphs
 * `▼`/`▶`, and the highlighted row reversed) and a selected-node readout
 * leaf. The tree registers with the core `FocusManager` under `focusId` on
 * mount; the demo then drives it *through the keyboard path* — the same
 * `FocusManager.routeKey` dispatch `useInput` uses for real terminal keys —
 * walking the highlight up/down and expanding/collapsing branches with
 * right/left/enter/space, asserting the tree's scene state and the readout
 * after every routed key, exactly like the kitchen-sink demos drive their
 * widgets. The readout updates through the `<Tree onChange>` contract (fired
 * after each routed key changes the tree), mirroring how an app would re-render
 * a selection line. The expand-state helpers (`expandTreeNode` /
 * `collapseTreeNode` / `toggleTreeNode`, keyed by node `id`) and the
 * windowed-rows property (`clip_height` materializes only the visible window)
 * are asserted as a final block.
 *
 * Every assertion prints an `ok:` line; a failing assertion prints a `FAIL`
 * line, tears the renderer down and exits 1 — so the PTY smoke harness
 * (`run-smoke.sh`) only sees exit 0 when the scene rendered and every scene
 * assertion held. The event loop then quits on 'q' (via `useInput` ->
 * `useApp().exit()`); the tree focus is blurred before the loop so the 'q'
 * key falls through the focus manager to the quit handler (the same
 * blur-before-loop pattern the kitchen-sink demos use).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import { createElement, type ReactElement } from "react";
import {
  Tree as CoreTree,
  createRenderer,
  type TernEventJs,
} from "@tern-tui/core";
import {
  Box,
  Text,
  Tree,
  collapseTreeNode,
  expandTreeNode,
  focusManager,
  render,
  toggleTreeNode,
  treeKey,
  useApp,
  useInput,
  visibleTreeRows,
  type KeyEvent,
  type Node,
  type Renderer,
  type TreeNode,
  type TreeState,
} from "@tern-tui/react";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// File model
// ---------------------------------------------------------------------------

/**
 * The nested file model of the browser: two source directories (with a nested
 * `components` directory under `src` and nested packages under `packages`)
 * plus two root leaves. Every node carries an explicit path-like `id` — the
 * stable key the expand-state bookkeeping and the `expandTreeNode` /
 * `collapseTreeNode` / `toggleTreeNode` lookups use (mirroring how a real
 * browser keys by path).
 */
const FILE_TREE: TreeNode[] = [
  {
    id: "src",
    label: "src",
    children: [
      { id: "src/index.ts", label: "index.ts" },
      {
        id: "src/components",
        label: "components",
        children: [
          { id: "src/components/button.ts", label: "button.ts" },
          { id: "src/components/tree.ts", label: "tree.ts" },
          { id: "src/components/input.ts", label: "input.ts" },
        ],
      },
    ],
  },
  {
    id: "packages",
    label: "packages",
    children: [
      {
        id: "packages/core",
        label: "core",
        children: [
          { id: "packages/core/mod.ts", label: "mod.ts" },
          { id: "packages/core/focus.ts", label: "focus.ts" },
        ],
      },
      {
        id: "packages/solid",
        label: "solid",
        children: [{ id: "packages/solid/index.ts", label: "index.ts" }],
      },
    ],
  },
  { id: "deno.json", label: "deno.json" },
  { id: "README.md", label: "README.md" },
];

/** The branches expanded initially: `src` and its `components` subdirectory,
 *  so the first paint already shows nested rows with indentation guides. */
const INITIAL_EXPANDED = ["src", "src/components"];

/** The readout's initial text: the first visible row (highlight 0) — `src`. */
const INITIAL_READOUT = `selected: ${FILE_TREE[0]?.label ?? "—"}`;

// ---------------------------------------------------------------------------
// Readout wiring (the <Tree onChange> contract updates the selection line)
// ---------------------------------------------------------------------------

/** The scene's tree node, captured after the scene settles (set below). */
let fileTree: Node | null = null;
/** The readout text leaf, captured after the scene settles (set below). */
let readout: Node | null = null;

/**
 * The `<Tree onChange>` handler: after a routed key changes the tree, the
 * readout repaints with the highlighted row's label — the pattern an app
 * would use to render a "selected: <path>" status line from the tree state.
 */
function updateReadout(state: TreeState): void {
  if (fileTree === null || readout === null) return;
  const row = visibleTreeRows(fileTree)[state.highlight];
  const next = `selected: ${row?.node.label ?? "—"}`;
  readout.setProps({ ...readout.props, text: next });
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * The demo scene: a rounded box column holding the title, the key legend,
 * the `<Tree>` (registered with the FocusManager under "filetree", so routed
 * keys drive it through `treeKey`) and the readout leaf. The input handler
 * quits the app on 'q'.
 */
function App(): ReactElement {
  const { exit } = useApp();
  useInput((event: KeyEvent) => {
    if (event.name === "char" && event.char === "q") exit();
  });
  return createElement(
    Box,
    {
      border_style: "rounded",
      padding: 1,
      flex_direction: "column",
      width: 30,
      height: 16,
    },
    createElement(Text, { text: "file browser" }),
    createElement(Text, { text: "↑/↓ move · ←/→/enter/space toggle · q quit" }),
    createElement(Tree, {
      nodes: FILE_TREE,
      focusId: "filetree",
      expanded: INITIAL_EXPANDED,
      indent: 2,
      onChange: updateReadout,
    }),
    createElement(Text, { text: INITIAL_READOUT }),
  );
}

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[file-browser] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[file-browser] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[file-browser]", message);
  process.exit(1);
}

render(createElement(App), renderer);

// React schedules passive effects (useInput's key subscription, and the
// `<Tree>`'s FocusManager registration) on the scheduler rather than
// flushing them synchronously, so give them a beat to register before the
// key routing starts.
await new Promise((resolve) => setTimeout(resolve, 100));

// ---------------------------------------------------------------------------
// Scene assertions (a failure prints FAIL and exits 1)
// ---------------------------------------------------------------------------

/** Assert a scene property; on failure tear down and exit 1. */
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[file-browser] ok: ${label}`);
    return;
  }
  console.error(`[file-browser] FAIL: ${label}`);
  renderer.destroy();
  process.exit(1);
}

/** A key event with the base (unmodified) modifiers. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

const rootBox: Node | undefined = renderer.root.children[0];
const kids: readonly Node[] = rootBox?.children ?? [];
const [title, legend, treeNode, readoutNode] = kids;
fileTree = treeNode ?? null;
readout = readoutNode ?? null;

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(
  kids.length === 4 &&
    title?.type === "text" &&
    legend?.type === "text" &&
    treeNode?.type === "tree" &&
    readoutNode?.type === "text",
  `scene holds title + legend + tree + readout (got ${kids.map((k) => k.type).join(",")})`,
);
assert(title?.props.text === "file browser", "the title leaf renders 'file browser'");

// --- tree composition (glyphs, guides, windowed rows) -------------------------
assert(treeNode?.props.flex_direction === "column", "the tree root is a flex column");
assert(treeNode?.props.highlight === 0, "the tree starts with the first row highlighted");
assert(
  !("nodes" in (treeNode?.props ?? {})) &&
    !("expanded" in (treeNode?.props ?? {})) &&
    !("indent" in (treeNode?.props ?? {})),
  "the node model and expand bookkeeping never reach the scene props",
);
const rowTexts = (node: Node): Array<string | undefined> =>
  node.children.map((leaf) => (typeof leaf.props.text === "string" ? leaf.props.text : undefined));
const texts = rowTexts(treeNode!);
// `src` and `src/components` start expanded: 9 visible rows — the nested
// rows draw the `│ ` guide under `src` (it has a following sibling), and the
// depth-2 leaves draw a second guide slot (gap: `components` is `src`'s last
// child).
assert(
  texts.length === 9,
  `the expanded tree materializes 9 visible rows (got ${texts.length})`,
);
assert(
  texts[0] === "▼ src" &&
    texts[1] === "│   index.ts" &&
    texts[2] === "│ ▼ components" &&
    texts[3] === "│     button.ts" &&
    texts[4] === "│     tree.ts" &&
    texts[5] === "│     input.ts",
  "rows 0-5 paint the expand glyph + indentation guides + labels",
);
assert(
  texts[6] === "▶ packages" && texts[7] === "  deno.json" && texts[8] === "  README.md",
  "collapsed branches carry the ▶ glyph; leaves carry the two-space glyph slot",
);
assert(treeNode?.children[0]?.props.reversed === true, "the highlighted row renders reversed");
assert(
  treeNode?.children[1]?.props.reversed !== true,
  "only the highlighted row renders reversed",
);
const initialRows = visibleTreeRows(treeNode!);
assert(initialRows.length === 9, `visibleTreeRows reports the 9 visible rows (got ${initialRows.length})`);
assert(
  initialRows[0]?.node.label === "src" &&
    initialRows[0]?.depth === 0 &&
    initialRows[0]?.expandable === true &&
    initialRows[0]?.expanded === true,
  "row 0 is the expanded src branch",
);
assert(
  initialRows[1]?.node.label === "index.ts" &&
    initialRows[1]?.depth === 1 &&
    initialRows[1]?.expandable === false,
  "row 1 is the depth-1 index.ts leaf",
);
assert(
  initialRows[6]?.node.label === "packages" &&
    initialRows[6]?.expandable === true &&
    initialRows[6]?.expanded === false,
  "row 6 is the collapsed packages branch",
);
assert(readoutNode?.props.text === INITIAL_READOUT, `the readout starts as '${INITIAL_READOUT}'`);

// ---------------------------------------------------------------------------
// Keyboard-driven expand/collapse (routed keys through the FocusManager)
// ---------------------------------------------------------------------------

// The <Tree focusId> registration landed in the effect flush; focus it so
// routed keys reach its treeKey handler (the same path useInput uses for
// real terminal keys).
assert(focusManager.has("filetree"), "the tree registered with the FocusManager under 'filetree'");
focusManager.focus("filetree");
assert(focusManager.activeId === "filetree", "focusing the tree makes it the active focus");

/** Route one key through the FocusManager and assert the tree state. */
function drive(label: string, event: KeyEvent, highlight: number, readoutText: string, count?: number): void {
  assert(focusManager.routeKey(event) === true, `${label}: the routed key dispatches to the tree`);
  assert(
    treeNode?.props.highlight === highlight,
    `${label}: highlight moves to ${highlight} (got ${treeNode?.props.highlight})`,
  );
  if (count !== undefined) {
    assert(
      visibleTreeRows(treeNode!).length === count,
      `${label}: visible rows = ${count} (got ${visibleTreeRows(treeNode!).length})`,
    );
  }
  assert(
    readoutNode?.props.text === readoutText,
    `${label}: the readout repaints '${readoutText}' (got '${readoutNode?.props.text}')`,
  );
}

// down moves the highlight through the visible rows.
drive("down", key("down"), 1, "selected: index.ts");
drive("down", key("down"), 2, "selected: components");
// right on an expanded branch steps into its first child.
drive("right", key("right"), 3, "selected: button.ts");
// left on a leaf jumps to its parent row.
drive("left", key("left"), 2, "selected: components");
// enter toggles a branch: components collapses (9 -> 6 visible rows).
drive("enter", key("enter"), 2, "selected: components", 6);
assert(
  visibleTreeRows(treeNode!)[2]?.node.label === "components" &&
    visibleTreeRows(treeNode!)[2]?.expanded === false,
  "enter collapsed the components branch",
);
// left on a collapsed branch jumps to its parent (src).
drive("left", key("left"), 0, "selected: src");
// left on the expanded src collapses it in place (6 -> 4 visible rows).
drive("left", key("left"), 0, "selected: src", 4);
assert(visibleTreeRows(treeNode!)[0]?.expanded === false, "left collapsed src");
// right on a collapsed branch expands it in place (highlight stays).
drive("right", key("right"), 0, "selected: src", 6);
assert(visibleTreeRows(treeNode!)[0]?.expanded === true, "right re-expanded src");
// right on the now-expanded branch steps into its first child.
drive("right", key("right"), 1, "selected: index.ts");
// space on a leaf is a no-op (count and highlight unchanged).
drive("space", key("char", { char: " " }), 1, "selected: index.ts", 6);
// left on a leaf jumps back to its parent.
drive("left", key("left"), 0, "selected: src");
// down walks through every visible row to the bottom leaf, then clamps.
drive("down", key("down"), 1, "selected: index.ts", 6);
drive("down", key("down"), 2, "selected: components", 6);
drive("down", key("down"), 3, "selected: packages", 6);
drive("down", key("down"), 4, "selected: deno.json", 6);
drive("down", key("down"), 5, "selected: README.md", 6);
drive("down", key("down"), 5, "selected: README.md", 6);
// up walks back to the top, then clamps.
drive("up", key("up"), 4, "selected: deno.json", 6);
drive("up", key("up"), 3, "selected: packages", 6);
drive("up", key("up"), 2, "selected: components", 6);
drive("up", key("up"), 1, "selected: index.ts", 6);
drive("up", key("up"), 0, "selected: src", 6);
drive("up", key("up"), 0, "selected: src", 6);

// ---------------------------------------------------------------------------
// Expand-state helpers (id-keyed, mirroring expandTreeNode's lookups)
// ---------------------------------------------------------------------------

// The walk ended with src expanded (6 visible rows: src, index.ts,
// components, packages, deno.json, README.md); packages is a collapsed
// branch at row 3. The helpers key by the nodes' path-like ids.
assert(
  expandTreeNode(treeNode!, "packages") === true,
  "expandTreeNode('packages') reports a change",
);
assert(
  visibleTreeRows(treeNode!).length === 8 &&
    visibleTreeRows(treeNode!)[4]?.node.label === "core" &&
    visibleTreeRows(treeNode!)[4]?.depth === 1 &&
    visibleTreeRows(treeNode!)[5]?.node.label === "solid" &&
    visibleTreeRows(treeNode!)[5]?.depth === 1,
  "expanding packages reveals its core + solid children at depth 1",
);
assert(
  collapseTreeNode(treeNode!, "packages") === true &&
    visibleTreeRows(treeNode!).length === 6,
  "collapseTreeNode('packages') hides the subtree",
);
assert(
  toggleTreeNode(treeNode!, "packages") === true &&
    visibleTreeRows(treeNode!)[3]?.expanded === true &&
    visibleTreeRows(treeNode!).length === 8,
  "toggleTreeNode('packages') re-expands it",
);
assert(
  expandTreeNode(treeNode!, "packages") === false,
  "re-expanding an expanded branch is a no-op",
);

// ---------------------------------------------------------------------------
// Windowed rows (clip_height materializes only the visible window)
// ---------------------------------------------------------------------------

/** A 8-branch model: enough top-level rows to scroll a 3-row viewport. */
const WINDOW_NODES: TreeNode[] = [];
for (let i = 0; i < 8; i++) {
  WINDOW_NODES.push({ label: `dir-${i}`, children: [{ label: `file-${i}` }] });
}

const windowed = CoreTree({ nodes: WINDOW_NODES, clip_height: 3 });
assert(
  windowed.type === "tree" && windowed.children.length === 3,
  "clip_height 3 materializes only the 3-row window of the 8-row model",
);
for (let i = 0; i < 5; i++) treeKey(windowed, key("down"));
assert(
  windowed.props.highlight === 5 && windowed.props.scroll_y === 3,
  `down x5 scrolls the window (highlight 5, scroll_y 3; got ${windowed.props.highlight}/${windowed.props.scroll_y})`,
);
assert(windowed.children.length === 3, "the materialized window still holds 3 leaves");
assert(
  rowTexts(windowed)[2] === "▶ dir-5",
  "the window bottom shows the highlighted row after auto-scroll",
);

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (via useInput → exit()), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

// Blur the tree before the event loop so the 'q' key falls through the focus
// manager (routeKey returns false with no active focus) to the quit handler —
// the same blur-before-loop pattern the kitchen-sink demos use.
focusManager.blur();
assert(focusManager.activeId === null, "the tree focus is blurred before the event loop");

renderer.startEventStream();
let quit = false;
const deadline = Date.now() + 5000;
const events = renderer.events[Symbol.asyncIterator]();
while (Date.now() < deadline && !quit) {
  if (renderer.destroyed) {
    // The 'q' handler's exit() destroyed the renderer — clean quit.
    quit = true;
    break;
  }
  // Wait for the next pushed event, bounded by the deadline so a dead
  // renderer fails the demo instead of hanging forever.
  const next = await Promise.race([
    events.next(),
    new Promise<IteratorResult<TernEventJs, undefined>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    ),
  ]);
  if (next.done) break; // stream closed (renderer destroyed) or deadline hit
  if (renderer.destroyed) {
    // Ctrl+C with exitOnCtrlC tore the renderer down after delivering the
    // event — also a clean quit.
    quit = true;
    break;
  }
}
if (renderer.destroyed) quit = true;
renderer.destroy();

if (!quit) {
  console.error("[file-browser] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[file-browser] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[file-browser] ok: rendered the file browser and quit on 'q'");
process.exit(0);
