//! The file list's state and its reducer.
//
// WHY THIS IS NOT IN `state.ts`. The pane's state (what it lists, what is
// highlighted, where its window sits, which directories are open) and the one
// reducer that moves the highlight are a seam of their own; `state.ts` was over its
// module budget. Activating an item asks the HOST to open a path — the reducer
// RETURNS that request instead of reaching for the effect queue, so this module
// mutates only the pane.
//
// THE LIST IS A TREE. The workspace paths are folded into a directory tree and
// flattened through the framework's own Tree element (`visibleTreeRows`, the
// registry's `core-tree-file-list`): a branch row shows the framework's
// expand/collapse glyph and toggles on activate, a leaf row opens. The rows the plan
// paints are this module's answer, so the highlight index and the row it marks can
// never disagree.
//
// WHICH CELLS the pane gets is `plan.ts`'s call (`sidebarScroll` reconciles the
// window against the height the plan laid out); this module never computes layout.

import { TREE_COLLAPSED_GLYPH, TREE_EXPANDED_GLYPH, Tree, visibleTreeRows, type TreeNode } from "@tern-tui/core";
import type { PendingEffect } from "./state.ts";

/** One visible row of the file list: its painted label and what activating it does. */
export interface SidebarRow {
  /** The tree row's painted label (indentation + glyph + name). */
  readonly label: string;
  /** The row's stable key (the path/prefix the tree node was built with). */
  readonly key: string;
  /** Whether the row is an expandable directory. */
  readonly branch: boolean;
  /** The path a leaf opens, or null for a branch. */
  readonly path: string | null;
}

/** The file list beside the editor. `items` are the workspace's flat paths;
 * `rows` is the tree they fold into, and `active` indexes ROWS, not items. */
export interface SidebarState {
  visible: boolean;
  width: number;
  items: readonly string[];
  active: number;
  scroll: number;
  /** The expanded branch prefixes (stable keys of {@link SidebarRow}). */
  expanded: Set<string>;
  rows: SidebarRow[];
}

/** Fold flat paths into a directory tree, and collect the branch prefixes. */
function pathTree(items: readonly string[]): { nodes: TreeNode[]; branches: string[] } {
  const nodes: TreeNode[] = [];
  const branches: string[] = [];
  for (const item of items) {
    const parts = item.split("/");
    let level = nodes;
    let prefix = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      prefix = prefix === "" ? part : prefix + "/" + part;
      const last = i === parts.length - 1;
      let node = level.find((entry) => entry.label === part);
      if (node === undefined) {
        node = { label: part, id: prefix };
        level.push(node);
      }
      if (!last) {
        if (node.children === undefined) {
          node.children = [];
          branches.push(prefix);
        }
        level = node.children;
      }
    }
  }
  return { nodes, branches };
}

/** The visible rows of the tree the flat paths fold into, across the expanded set. */
function buildRows(items: readonly string[], expanded: ReadonlySet<string>): SidebarRow[] {
  if (items.length === 0) return [];
  const { nodes } = pathTree(items);
  const tree = Tree({ nodes, expanded: [...expanded] });
  return visibleTreeRows(tree).map((row) => {
    const glyph = row.expandable
      ? (row.expanded ? TREE_EXPANDED_GLYPH : TREE_COLLAPSED_GLYPH) + " "
      : "  ";
    return {
      label: "  ".repeat(row.depth) + glyph + row.node.label,
      key: row.key,
      branch: row.expandable,
      path: row.expandable ? null : row.key,
    };
  });
}

/** The file list a host asked for: visible and wide by default, all branches open. */
export function newSidebar(options: {
  items?: readonly string[];
  sidebarWidth?: number;
  sidebarVisible?: boolean;
}): SidebarState {
  const items = options.items ?? [];
  const expanded = new Set<string>(pathTree(items).branches);
  const state: SidebarState = {
    visible: options.sidebarVisible ?? true,
    width: options.sidebarWidth ?? 20,
    items,
    active: 0,
    scroll: 0,
    expanded,
    rows: [],
  };
  state.rows = buildRows(state.items, state.expanded);
  return state;
}

/** Recompute the rows after an expand/collapse and clamp the highlight into them. */
function refresh(state: SidebarState): void {
  state.rows = buildRows(state.items, state.expanded);
  const last = Math.max(0, state.rows.length - 1);
  state.active = Math.max(0, Math.min(last, state.active));
}

/** Move the highlight, expand a directory, or ask the host to open a leaf. Returns
 * the effect for a leaf activate, or `null`. */
export function reduceSidebar(
  state: SidebarState,
  action: "toggle" | "up" | "down" | "activate",
): PendingEffect | null {
  if (action === "toggle") {
    state.visible = !state.visible;
    return null;
  }
  if (action === "up" || action === "down") {
    const last = Math.max(0, state.rows.length - 1);
    const moved = state.active + (action === "up" ? -1 : 1);
    state.active = Math.max(0, Math.min(last, moved));
    // The reducer moves the HIGHLIGHT and nothing else: which rows are on screen is
    // the pane's window, reconciled by the plan against the pane's own height.
    return null;
  }
  const row = state.rows[state.active];
  if (row === undefined) return null;
  if (row.branch) {
    if (state.expanded.has(row.key)) state.expanded.delete(row.key);
    else state.expanded.add(row.key);
    refresh(state);
    return null;
  }
  return row.path === null ? null : { kind: "open", path: row.path };
}

/** The labels the plan paints, in row order. */
export function sidebarLabels(state: SidebarState): string[] {
  return state.rows.map((row) => row.label);
}
