//! The Menu element: inline and flyout submenus, hover, and keyboard navigation.

import { FocusManager, focusManager } from "./focus.ts";
import { Box, Node, Text } from "./node.ts";
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
import { syncSemantics } from "./semantics.ts";
/** The menu overlay's paint z-order (100). In-flow content stacks at z 0 (the
 * scrollbar / sticky table header at 1), so a menu stamped with this
 * `z_index` always paints above them — the value to pass to `Menu`'s
 * `z_index` prop for a full-overlay menu, and the z-order a `"flyout"`
 * submenu layer is stamped with (compositor z-order, the same mechanism
 * `Select`'s `floating` overlay and the `Modal` overlay use). */
export const MENU_Z_INDEX = 100;

/** The indentation width (cells per depth level) of a menu's inline submenu
 * rows (mirroring `Tree`'s default indent). */
const MENU_INDENT = 2;

/**
 * One item of a {@link Menu}: a `label`, an optional stable `id`, and
 * optional `children`. An item with a non-empty `children` array is a submenu
 * branch (`right` / `enter` / a click open its submenu); an empty or absent
 * `children` array is a leaf (enter / a click activate it and dismiss the
 * menu).
 */
export interface MenuItem {
  /** The item's label text, painted after the indentation prefix. */
  label: string;
  /** A stable key identifying the item for open-state bookkeeping and the
   * `open_submenus` prop. Defaults to the item's dot-joined index path from
   * the root (e.g. `"0.2"`), which is unique. */
  id?: string;
  /** Child items, in display order (top to bottom). */
  children?: MenuItem[];
}

/** The state reported by {@link menuKey} after a routed key. */
export interface MenuState {
  /** The highlighted visible-item index (clamped into the visible items). */
  highlighted: number;
  /** The keys of the open submenus after the key. */
  open_submenus: string[];
  /** Whether the menu is open (enter on a leaf / escape dismiss it). */
  open: boolean;
  /** The number of visible items after the key (a submenu open/close changes
   * it). */
  count: number;
  /** The key of the item activated by `enter` (a leaf), or `null`. */
  activated: string | null;
}

/**
 * Props for the `Menu` element. `items` / `floating` / `submenu` are consumed
 * by the factory (the item model + render mode are JS bookkeeping — they
 * never reach the scene props, mirroring `Tree`'s `nodes`); the interactive
 * state (`highlighted`, `open_submenus`, `open`) and the remaining
 * style/layout props flow to the root box, which is a flex column of the
 * visible item leaves (plus the flyout layers in `"flyout"` mode).
 */
export interface MenuProps extends NodeProps {
  /** The menu items, in display order (top to bottom). */
  items: MenuItem[];
  /** The highlighted visible-item index (default 0) — its row renders
   * reversed. {@link menuKey} moves it with up/down, clamping to the visible
   * items. */
  highlighted?: number;
  /** The keys of submenus open initially (default none). A key is an item's
   * `id`, or its dot-joined index path. */
  open_submenus?: string[];
  /** Whether the menu is open (default `false`). `openMenu` / `closeMenu`
   * toggle it (and the visible state); a menu starts hidden. */
  open?: boolean;
  /**
   * Render the menu as a floating overlay: the root box carries the
   * `z_index` prop (the compositor's paint z-order; default `0`), so the
   * menu paints above in-flow content at the default z. The mode flag is
   * consumed by the factory — only the `z_index` prop reaches the scene.
   */
  floating?: boolean;
  /** The overlay's paint z-order (used when `floating`; default 0). Pass
   * {@link MENU_Z_INDEX} for a full-overlay menu. */
  z_index?: number;
  /** Submenu rendering: `"inline"` (default) renders open submenu items as
   * indented rows within the menu column (tree-style); `"flyout"` renders
   * each open submenu as a separate overlay layer beside its parent, stamped
   * with {@link MENU_Z_INDEX}. */
  submenu?: "inline" | "flyout";
}

/** One visible item row of a menu — the flattened row with its flat index
 * (internal; the scene row text derives from it). */
interface FlatMenuRow {
  /** The menu item this row renders. */
  item: MenuItem;
  /** The item's open-state key (its `id`, or its dot-joined index path). */
  key: string;
  /** The item's depth from the root (0 for a top-level item). */
  depth: number;
  /** Whether the item is a submenu branch (has children). */
  expandable: boolean;
  /** Whether the branch's submenu is currently open (always `false` for a
   * leaf). */
  open: boolean;
  /** The row's flat index in the visible list (its scene position). */
  index: number;
}

/** The normalized item model of a menu node (JS bookkeeping — never scene
 * props, mirroring `Table`'s `tableRows`). Deep-copied at creation. */
const menuItemModels = new WeakMap<Node, MenuItem[]>();

/** The submenu render mode of a menu node (JS bookkeeping — the `submenu`
 * prop is consumed by the factory, mirroring `Select`'s `floating`). */
const menuSubmenuModes = new WeakMap<Node, "inline" | "flyout">();

/** The per-menu focus bookkeeping (JS state — never scene props), mirroring
 * `Modal`'s `modalStates`. */
interface MenuFocusRecord {
  /** The active focus id recorded when the menu opened (restored on close;
   * `null` when nothing was focused before the open). */
  previousFocusId: string | null;
}

/** The focus records of menu nodes created with {@link Menu}. */
const menuFocusRecords = new WeakMap<Node, MenuFocusRecord>();

/** Clamp `index` into `[0, count - 1]` (0 when `count` is 0). */
function clampMenuIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** Deep-copy a menu item (so later mutations of the caller's model do not
 * reach the menu's private bookkeeping, mirroring `Tree`'s node copy). */
function cloneMenuItem(item: MenuItem): MenuItem {
  const copy: MenuItem = { label: item.label };
  if (item.id !== undefined) copy.id = item.id;
  if (item.children !== undefined) {
    copy.children = item.children.map(cloneMenuItem);
  }
  return copy;
}

/** The open-submenu key set of a menu node — from the `open_submenus` prop,
 * the interactive state's scene-visible source of truth. */
function menuOpenSet(menu: Node): Set<string> {
  const props = menu.props as MenuProps;
  const keys = props.open_submenus;
  return new Set<string>(Array.isArray(keys) ? keys : []);
}

/**
 * Flatten a menu's item model into the ordered list of *visible* items: an
 * item is visible when every ancestor submenu is open. Each row carries its
 * depth, its open-state key (the item's `id` or its dot-joined index path),
 * whether it is a submenu branch and open, and its flat index (its scene
 * position).
 */
function flattenMenu(items: MenuItem[], openSet: Set<string>): FlatMenuRow[] {
  const rows: FlatMenuRow[] = [];
  const walk = (list: MenuItem[], depth: number, prefix: string): void => {
    list.forEach((item, i) => {
      const indexPath = prefix === "" ? String(i) : `${prefix}.${i}`;
      const key = item.id ?? indexPath;
      const children = item.children ?? [];
      const expandable = children.length > 0;
      const open = expandable && openSet.has(key);
      rows.push({ item, key, depth, expandable, open, index: rows.length });
      if (open) walk(children, depth + 1, indexPath);
    });
  };
  walk(items, 0, "");
  return rows;
}

/** The rendered text of one menu row: the indentation prefix (2 cells per
 * depth level) plus the item label. */
function menuRowText(row: FlatMenuRow): string {
  return " ".repeat(row.depth * MENU_INDENT) + row.item.label;
}

/**
 * Rebuild a menu node's children from its current props + bookkeeping (the
 * source of truth, mirroring `rebuildTree`): flatten the model to its visible
 * items, then materialize one row per visible item — the highlighted row
 * reversed. In `"inline"` mode the rows are direct text leaves of the root
 * column; in `"flyout"` mode the root-layer (depth-0) rows are direct leaves
 * and each open submenu renders as a separate flyout layer box — an
 * absolutely positioned child stamped with {@link MENU_Z_INDEX} — holding
 * that branch's whole visible subtree. Runs at creation and after every
 * {@link menuKey} / {@link menuHover} / {@link menuClick} mutation.
 */
function rebuildMenu(menu: Node): void {
  const props = menu.props as MenuProps;
  const items = menuItemModels.get(menu) ?? [];
  const rows = flattenMenu(items, menuOpenSet(menu));
  const count = rows.length;
  const highlight = clampMenuIndex(
    typeof props.highlighted === "number" ? props.highlighted : 0,
    count,
  );
  const flyout = (menuSubmenuModes.get(menu) ?? "inline") === "flyout";

  for (const child of [...menu.children]) child.remove();

  if (!flyout) {
    for (const row of rows) {
      menu.addChild(
        Text({ text: menuRowText(row), reversed: row.index === highlight }),
      );
    }
    syncSemantics(menu);
    return;
  }

  // Flyout: the depth-0 rows are direct children of the menu column; each
  // contiguous run of deeper rows is an open submenu's layer — a separate
  // absolutely positioned box stamped with the flyout z-order (the branch's
  // whole visible subtree: its open children and any deeper open
  // grandchildren).
  let i = 0;
  while (i < count) {
    const row = rows[i]!;
    if (row.depth === 0) {
      menu.addChild(
        Text({ text: menuRowText(row), reversed: row.index === highlight }),
      );
      i++;
      continue;
    }
    const start = i;
    while (i < count && rows[i]!.depth >= row.depth) i++;
    const layer = Box({
      position: "absolute",
      top: 0,
      left: 0,
      flex_direction: "column",
      z_index: MENU_Z_INDEX,
    });
    for (let j = start; j < i; j++) {
      layer.addChild(
        Text({
          text: menuRowText(rows[j]!),
          reversed: rows[j]!.index === highlight,
        }),
      );
    }
    menu.addChild(layer);
  }
  syncSemantics(menu);
}

/**
 * Create a `menu` element: a flex column of text leaves — one leaf per
 * *visible* item of the hierarchical `items` model (an item is visible when
 * every ancestor submenu is open), each an indentation prefix (2 cells per
 * depth level) + the item label, the highlighted item reversed. Submenus
 * render inline as indented rows, or — with `submenu: "flyout"` — as
 * separate overlay layers stamped with their own `z_index`. The item model
 * and the render mode are JS bookkeeping (never scene props); the interactive
 * state (`highlighted`, `open_submenus`, `open`) lives on the root box's
 * props. Drive it with {@link menuKey} (up/down move the highlight, right /
 * enter open a submenu, left closes to the parent, enter on a leaf activates
 * it and dismisses, escape dismisses) or the mouse helpers {@link menuHover}
 * / {@link menuClick}; toggle visibility + focus with {@link openMenu} /
 * {@link closeMenu}. A `floating` menu stamps the root box's `z_index` prop
 * (compositor paint order, default 0) so it overlays in-flow content; a
 * closed menu is hidden (`hidden` modifier + `display: none`, so it truly
 * leaves the scene). No new napi node kind: the `menu` element materializes
 * as a `box` (constitution).
 */
export function Menu(props: MenuProps): Node {
  const items = props.items.map(cloneMenuItem);
  const open = props.open ?? false;
  const rootProps: NodeProps = {
    ...props,
    highlighted: props.highlighted ?? 0,
    open_submenus: [...(props.open_submenus ?? [])],
    open,
    // A closed menu is truly gone: the `hidden` modifier (the reconciler's
    // hide semantics) plus `display: none` (the engine removes the node and
    // its subtree from layout) — the Modal pattern.
    hidden: !open,
    display: open ? "flex" : "none",
    flex_direction: "column",
  };
  // The Select `floating` pattern: the overlay's paint z-order is stamped on
  // the root box (an explicit `z_index` prop wins).
  if (props.floating === true) {
    rootProps.z_index = (props.z_index as number | undefined) ?? 0;
  }
  const plain = rootProps as Record<string, unknown>;
  delete plain.items;
  delete plain.floating;
  delete plain.submenu;
  const menu = Node.create("menu", rootProps, []);
  menuItemModels.set(menu, items);
  menuSubmenuModes.set(menu, props.submenu === "flyout" ? "flyout" : "inline");
  menuFocusRecords.set(menu, { previousFocusId: null });
  rebuildMenu(menu);
  syncSemantics(menu);
  return menu;
}

/**
 * Apply a key to a menu node, mutating its state and rebuilding the
 * composition in place — the Menu counterpart of {@link selectKey}.
 *
 * - `up` / `down` move the highlight through the visible items (clamped at
 *   the ends).
 * - `right` opens the highlighted item's submenu (a no-op on a leaf); on an
 *   already-open branch it steps into the first child.
 * - `left` closes the highlighted item's submenu; otherwise it closes the
 *   parent submenu and highlights the parent item (a no-op at the top
 *   level).
 * - `enter` opens the highlighted item's submenu (a branch) or activates it
 *   (a leaf) and dismisses the menu.
 * - `escape` dismisses the menu.
 *
 * Returns the new state; any other key (or a key on an empty menu) leaves the
 * menu unchanged.
 */
export function menuKey(menu: Node, event: KeyEvent): MenuState {
  const props = menu.props as MenuProps;
  const items = menuItemModels.get(menu) ?? [];
  const openSet = menuOpenSet(menu);
  const rows = flattenMenu(items, openSet);
  const count = rows.length;
  const highlighted = clampMenuIndex(
    typeof props.highlighted === "number" ? props.highlighted : 0,
    count,
  );
  const open = props.open ?? false;

  let nextHighlighted = highlighted;
  let nextOpen = open;
  let activated: string | null = null;
  const nextOpenSet = new Set(openSet);

  const row = rows[highlighted];
  const name = event.name;
  if (name === "up") {
    nextHighlighted = Math.max(0, highlighted - 1);
  } else if (name === "down") {
    nextHighlighted = Math.min(Math.max(0, count - 1), highlighted + 1);
  } else if (name === "right") {
    if (row?.expandable) {
      if (!openSet.has(row.key)) nextOpenSet.add(row.key);
      else nextHighlighted = Math.min(Math.max(0, count - 1), highlighted + 1);
    }
  } else if (name === "left") {
    if (row?.expandable && openSet.has(row.key)) {
      nextOpenSet.delete(row.key);
    } else if (row !== undefined) {
      // Close to the parent: remove the nearest ancestor branch's key and
      // land the highlight on its row.
      for (let i = highlighted - 1; i >= 0; i--) {
        if (rows[i]!.depth < row.depth) {
          nextOpenSet.delete(rows[i]!.key);
          nextHighlighted = i;
          break;
        }
      }
    }
  } else if (name === "enter") {
    if (row?.expandable) {
      nextOpenSet.add(row.key);
    } else if (row !== undefined) {
      activated = row.key;
      nextOpen = false;
    }
  } else if (name === "escape") {
    nextOpen = false;
  }

  const nextRows = flattenMenu(items, nextOpenSet);
  const nextCount = nextRows.length;
  nextHighlighted = clampMenuIndex(nextHighlighted, nextCount);

  const changed = nextHighlighted !== highlighted ||
    nextOpen !== open ||
    activated !== null ||
    nextOpenSet.size !== openSet.size ||
    [...nextOpenSet].some((key) => !openSet.has(key));

  if (changed) {
    menu.setProps({
      ...props,
      highlighted: nextHighlighted,
      open_submenus: [...nextOpenSet],
      open: nextOpen,
    });
    rebuildMenu(menu);
  }
  return {
    highlighted: nextHighlighted,
    open_submenus: [...nextOpenSet],
    open: nextOpen,
    count: nextCount,
    activated,
  };
}

/**
 * Move the menu's highlight to the visible item at `index` (clamped into the
 * visible items), mutating the same state {@link menuKey} drives and
 * rebuilding the composition in place — the mouse counterpart of the up/down
 * keys, the hook the `MouseEventJs` host wiring subscribes to (a later
 * subtask wires the events; this helper is pure). Returns the new state. A
 * no-op when the highlight is already at `index` (or the menu has no items).
 */
export function menuHover(menu: Node, index: number): MenuState {
  const props = menu.props as MenuProps;
  const items = menuItemModels.get(menu) ?? [];
  const openSet = menuOpenSet(menu);
  const rows = flattenMenu(items, openSet);
  const count = rows.length;
  const target = clampMenuIndex(index, count);
  const highlighted = clampMenuIndex(
    typeof props.highlighted === "number" ? props.highlighted : 0,
    count,
  );
  if (target !== highlighted) {
    menu.setProps({ ...props, highlighted: target });
    rebuildMenu(menu);
  }
  return {
    highlighted: target,
    open_submenus: [...openSet],
    open: props.open ?? false,
    count,
    activated: null,
  };
}

/**
 * Click the visible item at `index` (clamped into the visible items): first
 * moves the highlight there (like {@link menuHover}), then acts like `enter`
 * — a branch opens its submenu, a leaf activates (the returned state's
 * `activated` carries its key) and dismisses the menu. Returns the new state.
 */
export function menuClick(menu: Node, index: number): MenuState {
  const props = menu.props as MenuProps;
  const items = menuItemModels.get(menu) ?? [];
  const openSet = menuOpenSet(menu);
  const rows = flattenMenu(items, openSet);
  const count = rows.length;
  const target = clampMenuIndex(index, count);
  const row = rows[target];
  const highlighted = clampMenuIndex(
    typeof props.highlighted === "number" ? props.highlighted : 0,
    count,
  );

  let activated: string | null = null;
  let open = props.open ?? false;
  const nextOpenSet = new Set(openSet);
  if (row?.expandable) {
    if (!openSet.has(row.key)) nextOpenSet.add(row.key);
  } else if (row !== undefined) {
    activated = row.key;
    open = false;
  }
  const nextOpenSubmenus = [...nextOpenSet];
  const changed = target !== highlighted ||
    open !== (props.open ?? false) ||
    activated !== null ||
    nextOpenSubmenus.length !== openSet.size ||
    nextOpenSubmenus.some((key) => !openSet.has(key));
  if (changed) {
    menu.setProps({
      ...props,
      highlighted: target,
      open_submenus: nextOpenSubmenus,
      open,
    });
    rebuildMenu(menu);
  }
  return {
    highlighted: target,
    open_submenus: nextOpenSubmenus,
    open,
    count: flattenMenu(items, nextOpenSet).length,
    activated,
  };
}

/**
 * Open a menu: record the currently active focus id, show the menu (toggle
 * the `hidden` modifier off and `display` back to flex), and move focus into
 * it — `focusFirst()` focuses the first registered focusable (the menu's
 * content is expected to register its focusables with `manager`, mirroring
 * `openModal`). A no-op when the menu is already open (the record must not be
 * overwritten by the focus that now sits inside the menu).
 */
export function openMenu(
  menu: Node,
  manager: FocusManager = focusManager,
): void {
  const record = menuFocusRecords.get(menu);
  if (record === undefined || menu.props.open === true) return;
  record.previousFocusId = manager.activeId;
  menu.setProps({ ...menu.props, open: true, hidden: false, display: "flex" });
  syncSemantics(menu);
  manager.focusFirst();
}

/**
 * Close a menu: hide it (toggle the `hidden` modifier on and `display` to
 * none) and restore the focus recorded by {@link openMenu} — the previously
 * active id, or a blur when nothing was focused before the open (fallback
 * `null`; a recorded id that was unregistered meanwhile also falls back to a
 * blur), mirroring `closeModal`. A no-op when the menu is already closed.
 */
export function closeMenu(
  menu: Node,
  manager: FocusManager = focusManager,
): void {
  const record = menuFocusRecords.get(menu);
  if (record === undefined || menu.props.open !== true) return;
  const previous = record.previousFocusId;
  menu.setProps({ ...menu.props, open: false, hidden: true, display: "none" });
  syncSemantics(menu);
  record.previousFocusId = null;
  if (previous === null || !manager.focus(previous)) {
    manager.blur();
  }
}

