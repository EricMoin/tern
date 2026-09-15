//! The Tree element: branch expansion, flattening, and keyboard navigation.

import { Node, Text } from "./node.ts";
import { maxScroll } from "./scrollview.ts";
import type { NodeProps } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
/** The glyph prefixed to an *expanded* branch node's label. */
export const TREE_EXPANDED_GLYPH = "▼";

/** The glyph prefixed to a *collapsed* branch node's label. */
export const TREE_COLLAPSED_GLYPH = "▶";

/** The vertical guide glyph drawn under an ancestor that has a following
 *  sibling (its subtree continues below). */
export const TREE_GUIDE_VERTICAL = "│";

/**
 * One node of a {@link Tree}: a `label`, an optional stable `id`, and optional
 * `children`. A node with a non-empty `children` array is a branch (it carries
 * an expand/collapse glyph and toggles on `enter` / `space` / `left` /
 * `right`); an empty or absent `children` array is a leaf.
 */
export interface TreeNode {
  /** The node's label text, painted after the indentation guide and the
   *  expand/collapse glyph. */
  label: string;
  /** A stable key identifying the node for expand-state bookkeeping and the
   *  {@link expandTreeNode} / {@link collapseTreeNode} / {@link toggleTreeNode}
   *  lookups (and the `expanded` initial prop). Defaults to the node's
   *  dot-joined index path from the root (e.g. `"0.2.1"`), which is unique. */
  id?: string;
  /** Child nodes, in display order (top to bottom). */
  children?: TreeNode[];
}

/** One visible row of a tree, reported by {@link visibleTreeRows}. */
export interface TreeRow {
  /** The tree node this row renders. */
  node: TreeNode;
  /** The node's expand-state key (its `id`, or its dot-joined index path). */
  key: string;
  /** The node's depth from the root (0 for a top-level node). */
  depth: number;
  /** Whether the node is a branch (has children — carries a glyph). */
  expandable: boolean;
  /** Whether the branch is currently expanded (always `false` for a leaf). */
  expanded: boolean;
}

/** A flattened tree row with the per-ancestor guide-continuation flags used
 *  to draw the indentation guides (internal — {@link TreeRow} omits them). */
interface FlatTreeRow extends TreeRow {
  /** One flag per ancestor level: `true` when that ancestor has a following
   *  sibling (draw a vertical guide under it), `false` otherwise (draw gap). */
  guides: boolean[];
}

/** The state reported by {@link treeKey} after a routed key. */
export interface TreeState {
  /** The highlighted visible-row index (clamped into the visible rows). */
  highlight: number;
  /** The vertical scroll offset in rows (visible rows scrolled past). */
  scroll_y: number;
  /** The number of visible rows after the key (an expand/collapse changes it). */
  count: number;
}

/**
 * Props for the `Tree` element. `nodes` / `expanded` / `indent` are consumed
 * by the factory (the model + bookkeeping are JS state — they never reach the
 * scene props, mirroring `Table`'s `rows` / `Tabs`' `tabs`); the interactive
 * state (`highlight`, `scroll_y`) and the remaining style/layout props flow to
 * the root box, which is a flex column of the visible row leaves.
 */
export interface TreeProps extends NodeProps {
  /** The root nodes, in display order (top to bottom). */
  nodes: TreeNode[];
  /** The highlighted visible-row index (default 0) — its row renders reversed.
   *  {@link treeKey} moves it with up/down, clamping to the visible rows. */
  highlight?: number;
  /** The vertical scroll offset in rows (default 0) — the number of visible
   *  rows scrolled past. */
  scroll_y?: number;
  /** The viewport height in rows (default unset — every visible row shows).
   *  The visible window is `rows[scroll_y, scroll_y + clip_height)`. */
  clip_height?: number;
  /** The keys of nodes expanded initially (default none — all collapsed). A
   *  key is a node's `id`, or its dot-joined index path when it has no `id`. */
  expanded?: string[];
  /** Cells of indentation per depth level (default 2). */
  indent?: number;
}

/** The normalized root-node model of a tree node (JS bookkeeping — never scene
 *  props, mirroring `Table`'s `tableRows`). Deep-copied at creation. */
const treeNodeModels = new WeakMap<Node, TreeNode[]>();

/** The set of expanded node keys of a tree node (JS bookkeeping — never scene
 *  props, mirroring `Tabs`' `tabSpecs`). */
const treeExpandedSets = new WeakMap<Node, Set<string>>();

/** The indentation width (cells per depth level) of a tree node (JS
 *  bookkeeping — the `indent` prop is consumed by the factory). */
const treeIndents = new WeakMap<Node, number>();

/** Clamp `index` into `[0, count - 1]` (0 when `count` is 0). */
function clampRowIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** Deep-copy a tree node (so later mutations of the caller's model do not
 *  reach the tree's private bookkeeping, mirroring `Tabs`' spec copy). */
function cloneTreeNode(node: TreeNode): TreeNode {
  const copy: TreeNode = { label: node.label };
  if (node.id !== undefined) copy.id = node.id;
  if (node.children !== undefined) {
    copy.children = node.children.map(cloneTreeNode);
  }
  return copy;
}

/**
 * Flatten a tree's node model into the ordered list of *visible* rows: a node
 * is visible when every ancestor is expanded. Each row carries its depth, its
 * expand-state key (the node's `id` or its dot-joined index path), whether it
 * is an expandable branch and expanded, plus the per-ancestor guide flags
 * (whether each ancestor has a following sibling) used to draw the guides.
 */
function flattenTree(
  nodes: TreeNode[],
  expandedSet: Set<string>,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const walk = (
    list: TreeNode[],
    depth: number,
    prefix: string,
    guides: boolean[],
  ): void => {
    list.forEach((node, i) => {
      const indexPath = prefix === "" ? String(i) : `${prefix}.${i}`;
      const key = node.id ?? indexPath;
      const children = node.children ?? [];
      const expandable = children.length > 0;
      const expanded = expandable && expandedSet.has(key);
      rows.push({
        node,
        key,
        depth,
        expandable,
        expanded,
        guides: [...guides],
      });
      if (expanded) {
        walk(children, depth + 1, indexPath, [...guides, i < list.length - 1]);
      }
    });
  };
  walk(nodes, 0, "", []);
  return rows;
}

/** The rendered text of one tree row: the indentation guides (a vertical bar
 *  per continuing ancestor, a gap otherwise), the expand/collapse glyph (two
 *  spaces for a leaf so labels align), and the node label. */
function treeRowText(row: FlatTreeRow, indent: number): string {
  const gap = " ".repeat(Math.max(0, indent));
  let prefix = "";
  for (const cont of row.guides) {
    prefix += cont
      ? TREE_GUIDE_VERTICAL + " ".repeat(Math.max(0, indent - 1))
      : gap;
  }
  const glyph = row.expandable
    ? `${row.expanded ? TREE_EXPANDED_GLYPH : TREE_COLLAPSED_GLYPH} `
    : "  ";
  return prefix + glyph + row.node.label;
}

/** The current vertical scroll of a tree node (0 when unset). */
function treeScrollY(tree: Node): number {
  const value = tree.props.scroll_y;
  return typeof value === "number" ? value : 0;
}

/** The tree's viewport height in rows: the `clip_height` prop, or the whole
 *  visible-row count when unset (nothing to clamp against). */
function treeViewport(tree: Node, count: number): number {
  const props = tree.props as TreeProps;
  if (typeof props.clip_height === "number" && props.clip_height > 0) {
    return props.clip_height;
  }
  return Math.max(1, count);
}

/**
 * Rebuild a tree node's children from its current props + bookkeeping (the
 * source of truth, mirroring `rebuildTable`): flatten the model to its visible
 * rows, then materialize only the window `rows[scroll_y, scroll_y +
 * clip_height)` — one `Text` leaf per visible row, the highlighted row
 * reversed — so a large tree does not create one scene node per node. Runs at
 * creation and after every {@link treeKey} / {@link toggleTreeNode} /
 * {@link expandTreeNode} / {@link collapseTreeNode} mutation. The clamped
 * scroll offset is re-stamped onto the node props so the bookkeeping stays in
 * range after a collapse shrinks the visible rows.
 */
function rebuildTree(tree: Node, initialScrollY?: number): void {
  const props = tree.props as TreeProps;
  const models = treeNodeModels.get(tree) ?? [];
  const expandedSet = treeExpandedSets.get(tree) ?? new Set<string>();
  const indent = treeIndents.get(tree) ?? 2;
  const rows = flattenTree(models, expandedSet);
  const count = rows.length;
  const highlight = clampRowIndex(
    typeof props.highlight === "number" ? props.highlight : 0,
    count,
  );
  const viewport = treeViewport(tree, count);
  const scrollY = Math.max(
    0,
    Math.min(
      initialScrollY ?? treeScrollY(tree),
      Math.max(0, count - viewport),
    ),
  );

  for (const child of [...tree.children]) child.remove();

  const start = Math.floor(scrollY);
  const end = Math.min(count, start + viewport);
  for (let i = start; i < end; i++) {
    tree.addChild(
      Text({ text: treeRowText(rows[i]!, indent), reversed: i === highlight }),
    );
  }

  // Re-stamp the clamped scroll offset (bookkeeping — the window is
  // materialized here, never scrolled by the layout engine).
  if (treeScrollY(tree) !== scrollY) {
    tree.setProps({ ...tree.props, scroll_y: scrollY });
  }
}

/**
 * Create a `tree` element: a flex column of text leaves — one leaf per
 * *visible* row of the hierarchical `nodes` model (a row is visible when every
 * ancestor is expanded), each an indentation guide + an expand/collapse glyph
 * (`▼`/`▶`, two spaces for a leaf) + the node label, the highlighted row
 * reversed. Only the window `rows[scroll_y, scroll_y + clip_height)` is
 * materialized, so a large tree does not create one scene node per node; the
 * full model and the expand state stay JS bookkeeping (never scene props). The
 * interactive state (`highlight`, `scroll_y`) lives on the node props. Drive it
 * with {@link treeKey} (up/down move the highlight, left/right and enter/space
 * collapse/expand); read the visible window with {@link visibleTreeRows}; drive
 * expand state directly with {@link expandTreeNode} / {@link collapseTreeNode} /
 * {@link toggleTreeNode}. No new napi node kind: the `tree` element
 * materializes as a `box` (constitution).
 */
export function Tree(props: TreeProps): Node {
  const models = props.nodes.map(cloneTreeNode);
  const rootProps: NodeProps = {
    ...props,
    highlight: props.highlight ?? 0,
    scroll_y: props.scroll_y ?? 0,
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.nodes;
  delete plain.expanded;
  delete plain.indent;
  const tree = Node.create("tree", rootProps, []);
  treeNodeModels.set(tree, models);
  treeExpandedSets.set(tree, new Set<string>(props.expanded ?? []));
  treeIndents.set(
    tree,
    typeof props.indent === "number" && props.indent > 0 ? props.indent : 2,
  );
  rebuildTree(tree, props.scroll_y);
  return tree;
}

/**
 * The visible rows of a tree currently inside its vertical viewport: the
 * flattened visible-row slice `rows[scroll_y, scroll_y + clip_height)` (the
 * whole visible list when `clip_height` is unset), in scene order. Each entry
 * reports the node, its expand-state key, its depth, and whether it is an
 * expandable branch and expanded.
 */
export function visibleTreeRows(tree: Node): TreeRow[] {
  const models = treeNodeModels.get(tree) ?? [];
  const expandedSet = treeExpandedSets.get(tree) ?? new Set<string>();
  const rows = flattenTree(models, expandedSet);
  const scrollY = treeScrollY(tree);
  const viewport = treeViewport(tree, rows.length);
  return rows.slice(scrollY, scrollY + viewport).map((row) => ({
    node: row.node,
    key: row.key,
    depth: row.depth,
    expandable: row.expandable,
    expanded: row.expanded,
  }));
}

/** Collect the expand-state keys of every *branch* (a node with children) in
 *  the full model — regardless of current expand state — so a toggle can
 *  reject an unknown or leaf key. Keys mirror {@link flattenTree}'s scheme
 *  (the node's `id`, or its dot-joined index path). */
function collectBranchKeys(nodes: TreeNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (list: TreeNode[], prefix: string): void => {
    list.forEach((node, i) => {
      const indexPath = prefix === "" ? String(i) : `${prefix}.${i}`;
      const key = node.id ?? indexPath;
      const children = node.children ?? [];
      if (children.length > 0) {
        keys.add(key);
        walk(children, indexPath);
      }
    });
  };
  walk(nodes, "");
  return keys;
}

/** Set the expanded state of the branch keyed by `key`, re-clamping the
 *  highlight into the new visible-row count and rebuilding in place. Returns
 *  whether the state changed (a no-op when already in the requested state, the
 *  key is not a known branch, or the tree has no bookkeeping). */
function setTreeExpanded(tree: Node, key: string, expanded: boolean): boolean {
  const expandedSet = treeExpandedSets.get(tree);
  if (expandedSet === undefined) return false;
  const models = treeNodeModels.get(tree) ?? [];
  if (!collectBranchKeys(models).has(key)) return false;
  const has = expandedSet.has(key);
  if (expanded === has) return false;
  if (expanded) expandedSet.add(key);
  else expandedSet.delete(key);
  const count = flattenTree(models, expandedSet).length;
  const props = tree.props as TreeProps;
  const highlight = clampRowIndex(
    typeof props.highlight === "number" ? props.highlight : 0,
    count,
  );
  tree.setProps({ ...props, highlight });
  rebuildTree(tree);
  return true;
}

/** Expand the branch keyed by `key` (its `id`, or its dot-joined index path),
 *  revealing its children. A no-op when already expanded or `key` is unknown.
 *  Returns whether the tree changed. */
export function expandTreeNode(tree: Node, key: string): boolean {
  return setTreeExpanded(tree, key, true);
}

/** Collapse the branch keyed by `key`, hiding its subtree. A no-op when
 *  already collapsed. Returns whether the tree changed. */
export function collapseTreeNode(tree: Node, key: string): boolean {
  return setTreeExpanded(tree, key, false);
}

/** Toggle the expanded state of the branch keyed by `key`. Returns whether the
 *  tree changed (always `true` for a known key). */
export function toggleTreeNode(tree: Node, key: string): boolean {
  const expandedSet = treeExpandedSets.get(tree);
  if (expandedSet === undefined) return false;
  return setTreeExpanded(tree, key, !expandedSet.has(key));
}

/**
 * Apply a key to a tree node, mutating its state and rebuilding the
 * composition in place — the Tree counterpart of {@link tableKey}.
 *
 * - `up` / `down` move the highlight through the visible rows (clamped at the
 *   ends), auto-scrolling so the highlighted row stays inside the window.
 * - `right` expands a collapsed branch; on an already-expanded branch it steps
 *   into the first child.
 * - `left` collapses an expanded branch; otherwise it jumps to the parent row.
 * - `enter` / `space` toggle a branch's expanded state.
 *
 * Returns the new state; any other key (or a key on an empty tree) leaves the
 * tree unchanged.
 */
export function treeKey(tree: Node, event: KeyEvent): TreeState {
  const props = tree.props as TreeProps;
  const models = treeNodeModels.get(tree) ?? [];
  const expandedSet = treeExpandedSets.get(tree) ?? new Set<string>();

  let rows = flattenTree(models, expandedSet);
  let count = rows.length;
  const originalHighlight = clampRowIndex(
    typeof props.highlight === "number" ? props.highlight : 0,
    count,
  );
  const originalScroll = treeScrollY(tree);
  let highlight = originalHighlight;
  const row = rows[highlight];
  const name = event.name;
  let toggledExpand = false;

  if (name === "up") {
    highlight = Math.max(0, highlight - 1);
  } else if (name === "down") {
    highlight = Math.min(Math.max(0, count - 1), highlight + 1);
  } else if (name === "right") {
    if (row?.expandable && !row.expanded) {
      expandedSet.add(row.key);
      toggledExpand = true;
    } else if (row?.expandable && row.expanded) {
      highlight = Math.min(Math.max(0, count - 1), highlight + 1);
    }
  } else if (name === "left") {
    if (row?.expandable && row.expanded) {
      expandedSet.delete(row.key);
      toggledExpand = true;
    } else if (row !== undefined) {
      for (let i = highlight - 1; i >= 0; i--) {
        if (rows[i]!.depth < row.depth) {
          highlight = i;
          break;
        }
      }
    }
  } else if (
    name === "enter" || (name === "char" && event.char === " ") ||
    name === "space"
  ) {
    if (row?.expandable) {
      if (row.expanded) expandedSet.delete(row.key);
      else expandedSet.add(row.key);
      toggledExpand = true;
    }
  }

  if (toggledExpand) {
    rows = flattenTree(models, expandedSet);
    count = rows.length;
    highlight = clampRowIndex(highlight, count);
  }

  // Auto-scroll: keep the highlighted row inside the visible window, then
  // clamp the offset to the visible-row bounds.
  const viewport = treeViewport(tree, count);
  const maxScroll = Math.max(0, count - viewport);
  let scrollY = originalScroll;
  if (highlight < scrollY) scrollY = highlight;
  if (highlight > scrollY + viewport - 1) scrollY = highlight - viewport + 1;
  scrollY = Math.max(0, Math.min(scrollY, maxScroll));

  const changed = toggledExpand || highlight !== originalHighlight ||
    scrollY !== originalScroll;
  if (changed) {
    tree.setProps({ ...tree.props, highlight, scroll_y: scrollY });
    rebuildTree(tree);
  }
  return { highlight, scroll_y: scrollY, count };
}

