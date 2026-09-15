//! The data-display element factories.

import { HOST_BAR_CHART, HOST_CHART, HOST_MENU, HOST_MODAL, HOST_PROGRESS, HOST_SCROLL_VIEW, HOST_SPARKLINE, HOST_TABLE, HOST_TABS, HOST_TREE } from "./components.ts";
import type { MenuProps } from "./components.ts";
import { useFocusManager } from "./hooks.ts";
import { name, resolveHostTheme, useTheme } from "./primitives.ts";
import type { TernNodeProps } from "./primitives.ts";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  copySelection,
  defaultTheme,
  dragPanels,
  dragSelection,
  editKey,
  editTextareaKey,
  endPanelDrag,
  endSelection,
  focusAt,
  focusManager,
  mergeTheme,
  menuClick,
  menuHover,
  menuKey,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  selectKey,
  setStreamAutoScroll,
  startSelection,
  startPanelDrag,
  syncStreamTail,
  tabsKey,
  tick,
  treeKey,
  useFocus as coreUseFocus,
  wheelScroll,
  type FocusManager,
  type DiffLine,
  type FocusHandle,
  type KeyHandler,
  type MenuItem,
  type MenuState,
  type Node,
  type NodeProps,
  type PanelSpec,
  type Renderer,
  type ResizeHandler,
  type SelectOption,
  type SelectState,
  type Span,
  type StatusBarSegment,
  type TabSpec,
  type TableColumn,
  type TabsState,
  type TextareaState,
  type TreeNode,
  type TreeState,
  type Theme,
  type ThemeComponent,
  type ThemeOverrides,
  type ThemeResolvableProps,
  type ThemeRole,
} from "@tern-tui/core";
import { THEME_HINT_CARRIER, useApp } from "./reconciler.ts";
/**
 * The `<Menu>` host component: a flex column of text leaves — one leaf per
 * *visible* item of the hierarchical `items` model, the highlighted item
 * reversed (core `Menu` factory). When `focusId` is given, the menu registers
 * with a `FocusManager` on mount and routed keys (via `useInput`) drive it
 * through the core `menuKey` — `onSelect` fires when a leaf item is
 * activated (Enter) and `onDismiss` on Escape. While mounted, the menu also
 * subscribes to the renderer's mouse events: a `moved` event drives the core
 * `menuHover` (moving the highlight to the hovered row) and a `down_left`
 * press drives `menuClick` (opening a branch's submenu or activating a leaf —
 * which fires `onSelect`) whenever the menu is open (mirroring the
 * `usePanelMouseDrag` / `useSelection` wiring; the event's row is the visible
 * item index, the established scene-origin convention). The menu's ref is
 * managed internally (like `<Select>`); the element takes no React children —
 * its composition is fixed by the factory.
 */
export function Menu(props: MenuProps): ReactElement<MenuProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  const { renderer } = useApp();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const onDismissRef = useRef(props.onDismiss);
  onDismissRef.current = props.onDismiss;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const next = menuKey(node, event);
      // Enter on a leaf activates it (the state's `activated` carries the
      // item's key) and dismisses the menu; Enter on a branch opens the
      // submenu (no callback). Escape dismisses without a selection.
      if (next.activated !== null) {
        onSelectRef.current?.(next);
      } else if (event.name === "escape") {
        onDismissRef.current?.(next);
      }
    }, manager).dispose;
  }, [props.focusId, manager]);

  // Mouse wiring: a hover (`moved`) moves the highlight through the core
  // `menuHover`; a `down_left` press clicks through `menuClick` (a branch
  // opens its submenu, a leaf activates — firing `onSelect`). Both only
  // apply while the menu is open; a hover that moves the highlight and any
  // click repaint the scene. The subscription is torn down on unmount.
  useEffect(() => {
    return renderer.onMouse((event) => {
      const menu = nodeRef.current;
      if (menu === null || menu.props.open !== true) return;
      if (event.kind === "moved") {
        const before = typeof menu.props.highlighted === "number"
          ? menu.props.highlighted
          : 0;
        const next = menuHover(menu, event.row);
        if (next.highlighted !== before) renderer.render();
      } else if (event.kind === "down_left") {
        const next = menuClick(menu, event.row);
        renderer.render();
        if (next.activated !== null) onSelectRef.current?.(next);
      }
    });
  }, [renderer]);

  return createElement(HOST_MENU, {
    ...(resolveHostTheme(theme, { ...props, component: "menu" }) as MenuProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<ScrollView>`: the tern node props plus the engine's scene
 * region props (the clip rect and the scroll offset) and the scrollbar flag,
 * forwarded verbatim to the core `ScrollView` factory. The view's content is
 * its React children (the reconciler appends them after the scrollbar leaf).
 */
export interface ScrollViewProps extends TernNodeProps {
  /** The clip rect's left edge in cells (default unset — no clip). */
  clip_x?: number;
  /** The clip rect's top edge in cells (default unset — no clip). */
  clip_y?: number;
  /** The clip rect's width in cells (default unset — no clip). */
  clip_width?: number;
  /** The clip rect's height in cells (default unset — no clip). */
  clip_height?: number;
  /** The horizontal scroll offset in cells (default 0). */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0). */
  scroll_y?: number;
  /**
   * Append a vertical scrollbar text leaf (track + thumb) to the composition
   * (default `false`), refreshed by the core `scrollTo` / `scrollBy` /
   * `scrollTop` helpers.
   */
  showScrollbar?: boolean;
}

/**
 * The `<ScrollView>` host component: a clip/scroll region box carrying the
 * engine's `clip_x` / `clip_y` / `clip_width` / `clip_height` and `scroll_x`
 * / `scroll_y` props (core `ScrollView` factory). Its content is the React
 * children, and the core `scrollTo` / `scrollBy` / `scrollTop` helpers drive
 * the offsets (clamped against `Node.contentSize()`). The `scroll_view`
 * component preset is resolved onto the box's props at element-creation
 * time. Takes React children.
 */
export function ScrollView(props: ScrollViewProps): ReactElement<ScrollViewProps> {
  const theme = useTheme();
  return createElement(
    HOST_SCROLL_VIEW,
    resolveHostTheme(theme, { ...props, component: "scroll_view" }) as ScrollViewProps,
  );
}

/**
 * Props for `<Table>`: the tern node props plus the column/row model and the
 * interactive state, forwarded verbatim to the core `Table` factory (`columns`
 * / `rows` are JS bookkeeping — the model becomes composed text leaves and
 * never reaches the scene props).
 */
export interface TableProps extends TernNodeProps {
  /** The columns, in display order (left to right). */
  columns: TableColumn[];
  /** The data rows, in display order (top to bottom); one cell per column. */
  rows: (string | number)[][];
  /** The horizontal scroll offset in cells (default 0). */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0). */
  scroll_y?: number;
  /** The highlighted data-row index (default 0). */
  highlight?: number;
  /** Keep the header pinned above the content region (default `true`). */
  sticky_header?: boolean;
  /** The content region's viewport height in rows (default unset). */
  clip_height?: number;
}

/**
 * The `<Table>` host component: a flex column of box/text leaves — a header
 * row (sticky by default, painted above the content region) and one row leaf
 * per data row with per-column width/alignment (core `Table` factory). The
 * `table` component preset is resolved onto the root box's props at
 * element-creation time. Drive it with the core `tableKey` (up/down move the
 * highlight and auto-scroll) and read the visible window with
 * `visibleTableRows`. Takes no React children.
 */
export function Table(props: TableProps): ReactElement<TableProps> {
  const theme = useTheme();
  return createElement(
    HOST_TABLE,
    resolveHostTheme(theme, { ...props, component: "table" }) as TableProps,
  );
}

/**
 * Props for `<Tree>`: the tern node props plus the hierarchical node model,
 * the interactive state and the focus/callback wiring. `nodes` / `expanded` /
 * `indent` flow to the core `Tree` factory (the model + expand bookkeeping are
 * JS state and never reach the scene props); the remaining keys are consumed
 * by the component.
 */
export interface TreeProps extends TernNodeProps {
  /** The root nodes, in display order (top to bottom). */
  nodes: TreeNode[];
  /** The highlighted visible-row index (default 0). */
  highlight?: number;
  /** The vertical scroll offset in rows (default 0). */
  scroll_y?: number;
  /** The viewport height in rows (default unset — every visible row shows). */
  clip_height?: number;
  /** The keys of nodes expanded initially (default none — all collapsed). */
  expanded?: string[];
  /** Cells of indentation per depth level (default 2). */
  indent?: number;
  /**
   * Register the tree with a `FocusManager` under this id so routed keys (via
   * `useInput`) drive it through the core `treeKey`. Omit to leave the tree
   * inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key changes the tree (move / expand / collapse). */
  onChange?: (state: TreeState) => void;
}

/**
 * The `<Tree>` host component: a flex column of text leaves — one leaf per
 * *visible* row of the hierarchical `nodes` model, each an indentation guide +
 * an expand/collapse glyph (`▼`/`▶`) + the node label, the highlighted row
 * reversed (core `Tree` factory). Only the visible window is materialized, so
 * a large tree does not create one scene node per node. When `focusId` is
 * given, the tree registers with a `FocusManager` on mount and routed keys
 * (via `useInput`) drive it through the core `treeKey` — up/down move the
 * highlight, left/right and enter/space collapse/expand — firing `onChange`
 * after each change. The tree's ref is managed internally; the element takes
 * no React children — its composition is fixed by the factory.
 */
export function Tree(props: TreeProps): ReactElement<TreeProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props as TreeProps;
      const beforeHighlight = typeof before.highlight === "number" ? before.highlight : 0;
      const beforeScroll = typeof before.scroll_y === "number" ? before.scroll_y : 0;
      // The materialized window count changes when an expand/collapse adds or
      // removes visible rows (with no `clip_height`); highlight/scroll cover
      // navigation and auto-scroll.
      const beforeRows = node.children.length;
      const next = treeKey(node, event);
      const changed = next.highlight !== beforeHighlight ||
        next.scroll_y !== beforeScroll ||
        node.children.length !== beforeRows;
      if (changed) onChangeRef.current?.(next);
    }, manager).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_TREE, {
    ...(resolveHostTheme(theme, props) as TreeProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<Modal>`: the tern node props plus the overlay state and the
 * content node list. `open` / `backdrop` / `z_index` flow to the core
 * `Modal` factory (the overlay's paint z-order and visible state); `content`
 * is JS bookkeeping — the core `Node`s wrapped into the centered content
 * box (mirroring `<Panels>`' `panels`; the element takes no React children).
 */
export interface ModalProps extends TernNodeProps {
  /** Whether the modal is open (default `false` — hidden). The core
   *  `openModal` / `closeModal` toggle it. */
  open?: boolean;
  /** Whether the dimmed backdrop box is composed (default `true`). */
  backdrop?: boolean;
  /** The overlay's paint z-order (default `MODAL_Z_INDEX`). */
  z_index?: number;
  /** The core `Node`s wrapped into the modal's centered content box. */
  content?: Node[];
}

/**
 * The `<Modal>` host component: a full-bleed overlay — a dimmed backdrop box
 * plus a centered content box holding `content`, stamped with a high
 * `z_index` so it paints above in-flow content (core `Modal` factory). The
 * element takes no React children; the content is the core `Node[]` from the
 * `content` prop (mirroring `<Panels>`). Open/close it with the core
 * `openModal` / `closeModal` on the modal node (the `ref` forwards to the
 * scene node), which also move focus into/out of the overlay through the
 * `FocusManager`. The `modal` host tag is mapped in `./reconciler.ts`.
 */
export function Modal(props: ModalProps): ReactElement<ModalProps> {
  const theme = useTheme();
  return createElement(HOST_MODAL, resolveHostTheme(theme, props) as ModalProps);
}

/**
 * Props for `<Tabs>`: the tern node props plus the tab spec list, the
 * interactive state and the focus/callback wiring. `tabs` / `active` /
 * `closable` flow to the core `Tabs` factory (the spec list is JS
 * bookkeeping and never reaches the scene props); the remaining keys are
 * consumed by the component.
 */
export interface TabsProps extends TernNodeProps {
  /** The tabs, in display order (left to right). Each spec's `content` nodes
   * are core `Node`s (e.g. obtained from host element refs) rendered in the
   * content region while the tab is active. */
  tabs: TabSpec[];
  /** The active tab index (default 0). */
  active?: number;
  /** Show a close affordance on every tab (default `false`; a per-tab
   * `closable` overrides it). */
  closable?: boolean;
  /**
   * Register the tabs with a `FocusManager` under this id so routed keys
   * (via `useInput`) drive it through the core `tabsKey`. Omit to leave the
   * tabs inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key moves the active tab. */
  onChange?: (state: TabsState) => void;
  /** Fired after `ctrl+w` routes to the tabs and closes the active tab. */
  onClose?: (state: TabsState) => void;
}

/**
 * The `<Tabs>` host component: a flex column of box/text leaves — a tab bar
 * row (one `Text` leaf per tab; the active tab painted with the theme's
 * `primary` palette colors and reversed, its label prefixed with a top-border
 * marker, closable tabs carrying a close glyph) plus a content region box
 * holding the active tab's content nodes (core `Tabs` factory). When
 * `focusId` is given, the tabs register with a `FocusManager` on mount and
 * routed keys (via `useInput`) drive them through the core `tabsKey` —
 * `onChange` fires when the active tab moves, `onClose` when `ctrl+w` closes
 * the active tab. The tabs' ref is managed internally; the element takes no
 * React children — its composition is fixed by the factory.
 */
export function Tabs(props: TabsProps): ReactElement<TabsProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props as TabsProps;
      const beforeActive = typeof before.active === "number" ? before.active : 0;
      const barBefore = node.children[0]?.children.length ?? 0;
      const next = tabsKey(node, event);
      // A ctrl+w close shrinks the tab bar (tabsKey rebuilds the
      // composition); any other routed key leaves the bar count alone.
      const closed = (node.children[0]?.children.length ?? 0) < barBefore;
      if (closed) {
        onCloseRef.current?.(next);
      } else if (next.active !== beforeActive) {
        onChangeRef.current?.(next);
      }
    }, manager).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_TABS, {
    ...(resolveHostTheme(theme, props) as TabsProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<Progress>`: the tern node props plus the bar model
 * (`value`/`max` or `ratio`), the label and the readout flag, forwarded
 * verbatim to the core `Progress` factory (the label / `show_percentage` keys
 * are consumed there and never reach the scene props).
 */
export interface ProgressProps extends TernNodeProps {
  /** The current progress value (default 0). */
  value?: number;
  /** The maximum value (default 100); the bar is full at `value === max`. */
  max?: number;
  /**
   * A 0..1 fill ratio as an alternative to `value`/`max`; when given it wins
   * over `value`/`max` for both the bar fill and the percentage readout.
   */
  ratio?: number;
  /** The optional label text, left-aligned inside the bar area when there is
   * room (composed only when it fits alongside the percentage readout). */
  label?: string;
  /** Whether the percentage readout renders on the right (default `true`). */
  show_percentage?: boolean;
  /** The outer width in cells including the frame (default
   *  {@link PROGRESS_DEFAULT_WIDTH} — the inner bar width is this minus the
   *  frame's border columns). */
  width?: number;
}

/**
 * The `<Progress>` host component: a framed box (ratatui Gauge parity)
 * holding an in-flow fill leaf (`'▓'` × `ceil(value/max * inner)`, `'░'` for
 * the rest), an optional dimmed label leaf left-aligned inside the bar area
 * (composed only when it fits), and an optional percentage readout
 * (`ceil(value/max*100)%`) right-aligned inside it (core `Progress` factory).
 * The `progress` component preset is resolved onto the frame's props at
 * element-creation time. Drive a live bar without rebuilding with the core
 * `setProgress` on the scene node (the `ref` forwards to it). Takes no React
 * children.
 */
export function Progress(props: ProgressProps): ReactElement<ProgressProps> {
  const theme = useTheme();
  return createElement(HOST_PROGRESS, {
    ...(resolveHostTheme(theme, { ...props, component: "progress" }) as ProgressProps),
  });
}

/**
 * Props for `<BarChart>`: the tern node props plus the bar series and the
 * chart geometry, forwarded verbatim to the core `BarChart` factory (`data`
 * and the scale keys are JS bookkeeping consumed there and never reach the
 * scene props).
 */
export interface BarChartProps extends TernNodeProps {
  /** The bar values, one per bar, in display order (left to right). */
  data: number[];
  /** The chart's fixed width in cells (default: the natural bars width). */
  width?: number;
  /** The chart height in cells (default 5) — eighth-block sub-heights per
   *  bar, or whole cells in `full_block` mode. */
  height?: number;
  /** The value scale minimum (default 0 — the baseline). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Cells per bar column (default 1). */
  bar_width?: number;
  /** Cells between adjacent bars (default 1). */
  gap?: number;
  /** Compose a `─` baseline axis row beneath the bars, spanning the fixed
   *  width (default `false`). */
  show_axis?: boolean;
  /** Use whole-cell `█` columns instead of the eighth-block sub-cell glyphs
   *  (default `false`). */
  full_block?: boolean;
}

/**
 * The `<BarChart>` host component: a flex column of bar-row text leaves —
 * one column per value painted bottom-up with the eighth-block glyphs
 * (▁▂▃▄▅▆▇█) for sub-cell bar heights, or whole-cell `█` columns with
 * `full_block`, all sharing the bottom baseline, plus an optional `─` axis
 * row spanning the fixed `width` (core `BarChart` factory). The `bar_chart`
 * host tag is mapped in `./reconciler.ts`. Takes no React children.
 */
export function BarChart(props: BarChartProps): ReactElement<BarChartProps> {
  const theme = useTheme();
  return createElement(HOST_BAR_CHART, resolveHostTheme(theme, props) as BarChartProps);
}

/**
 * Props for `<Chart>`: the tern node props plus the line series and the
 * chart geometry, forwarded verbatim to the core `Chart` factory (`data` and
 * the scale keys are JS bookkeeping consumed there and never reach the scene
 * props).
 */
export interface ChartProps extends TernNodeProps {
  /** The data points, in x order; the polyline through them is drawn. */
  data: number[];
  /** The chart's fixed width in cells (default
   *  `max(2, ceil(data.length / 2))`). */
  width?: number;
  /** The chart height in cells (default 5) — braille resolution is 4
   *  sub-rows per cell. */
  height?: number;
  /** The value scale minimum (default `min(data)`). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Compose a `─` baseline axis row beneath the plot, spanning the fixed
   *  width (default `false`). */
  show_axis?: boolean;
}

/**
 * The `<Chart>` host component: a braille line chart — the polyline through
 * `data` rasterized onto the canvas sub-cell dot matrix (x spans the fixed
 * width, the value scale spans the height) and rendered as Unicode braille
 * via the canvas rasterizer (core `Chart` factory), plus an optional `─`
 * axis row spanning the fixed width. The `chart` host tag is mapped in
 * `./reconciler.ts`. Takes no React children.
 */
export function Chart(props: ChartProps): ReactElement<ChartProps> {
  const theme = useTheme();
  return createElement(HOST_CHART, resolveHostTheme(theme, props) as ChartProps);
}

/**
 * Props for `<Sparkline>`: the tern node props plus the series and the
 * chart geometry, forwarded verbatim to the core `Sparkline` factory (`data`
 * and the scale keys are JS bookkeeping consumed there and never reach the
 * scene props).
 */
export interface SparklineProps extends TernNodeProps {
  /** The data points, in x order; the last `width` points are shown. */
  data: number[];
  /** The sparkline's fixed width in cells (default `data.length`). */
  width?: number;
  /** The sparkline height in cells (default 1). */
  height?: number;
  /** The value scale minimum (default `min(data)`). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Rasterize the sparkline as Unicode braille via the canvas rasterizer
   *  (default `false` — eighth-block glyphs). */
  use_braille?: boolean;
}

/**
 * The `<Sparkline>` host component: one glyph per value at the series' own
 * scale — eighth-block glyphs by default, or braille via the canvas
 * rasterizer with `use_braille` — anchored to the bottom baseline at a fixed
 * `width` (core `Sparkline` factory). The `sparkline` host tag is mapped in
 * `./reconciler.ts`. Takes no React children.
 */
export function Sparkline(props: SparklineProps): ReactElement<SparklineProps> {
  const theme = useTheme();
  return createElement(HOST_SPARKLINE, resolveHostTheme(theme, props) as SparklineProps);
}

