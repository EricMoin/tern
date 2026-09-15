//! The Panels element: panel layout, collapse/expand/focus, and drag resizing.

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
/** A panel inside a `Panels` element: a header plus a body node. */
export interface PanelSpec {
  /** The panel's header text. */
  header: string;
  /** The panel's body node (hidden while the panel is collapsed). */
  body: Node;
  /** Start collapsed (default `false`). */
  collapsed?: boolean;
  /** The panel's minimum main-axis size in cells (default 1), enforced by
   * the mouse drag-resize helpers (roadmap Phase 2) and, once tern-layout
   * consumes them, the layout engine. */
  min_width?: number;
  /** The panel's minimum cross-axis size in cells (default 1), enforced by
   * the mouse drag-resize helpers. */
  min_height?: number;
}

/** Props for the `Panels` element. `panels`/`direction` are consumed by the
 * factory (the spec list is JS bookkeeping, never scene props); remaining
 * props style the stack container. */
export interface PanelsProps extends NodeProps {
  /** The panels, in stack order (top to bottom for a column). */
  panels: PanelSpec[];
  /** The active panel index (default 0) — its header renders bold. */
  active?: number;
  /** Stack direction (default `"column"`). */
  direction?: "row" | "column";
}

/**
 * Panel box -> its body node, kept so a collapsed body can be restored by
 * {@link expandPanel} / {@link togglePanel} after `Node.remove`.
 */
const panelBodies = new WeakMap<Node, Node>();

/** Build one panel box: a header `Text` plus the body (omitted when the
 * panel starts collapsed). The body is always recorded in `panelBodies`.
 * Children are wired through `addChild` so the parent link exists — a later
 * `body.remove()` (collapse) splices the panel's children correctly on a
 * detached tree. */
function buildPanel(spec: PanelSpec, isActive: boolean): Node {
  const panelProps: NodeProps = { flex_direction: "column" };
  // Undefined props must not reach the scene (the binding's `set_props`
  // cannot serialize them), so min sizes are set only when declared.
  if (spec.min_width !== undefined) panelProps.min_width = spec.min_width;
  if (spec.min_height !== undefined) panelProps.min_height = spec.min_height;
  const panel = Box(panelProps);
  panel.addChild(Text({ text: spec.header, bold: isActive }));
  if (!(spec.collapsed ?? false)) panel.addChild(spec.body);
  panelBodies.set(panel, spec.body);
  return panel;
}

/** The panel box at `index` within a `panels` element, or `undefined`. */
function panelAt(panels: Node, index: number): Node | undefined {
  return panels.children[index];
}

/**
 * Create a `panels` element: a flex stack (default column) of panel boxes,
 * each with a header `Text` and a body node. The active panel's header is
 * bold. Manage panels with {@link collapsePanel}, {@link expandPanel},
 * {@link togglePanel} and {@link focusPanel}.
 */
export function Panels(props: PanelsProps): Node {
  const direction = props.direction ?? "column";
  const active = props.active ?? 0;
  const panels = props.panels.map((spec, index) =>
    buildPanel(spec, index === active)
  );
  const boxProps: NodeProps = { ...props, flex_direction: direction, active };
  // The 1-cell gutter between adjacent panels (the mouse drag-resize handle,
  // roadmap Phase 2; matches the Rust renderable's default `gap`). An explicit
  // `gap` wins — `gap: 0` removes the gutter.
  if (boxProps.gap === undefined) boxProps.gap = 1;
  const plain = boxProps as Record<string, unknown>;
  delete plain.panels;
  delete plain.direction;
  return Node.create("panels", boxProps, panels);
}

/** Collapse the panel at `index`: detach its body from the scene tree. */
export function collapsePanel(panels: Node, index: number): void {
  const panel = panelAt(panels, index);
  if (panel === undefined) return;
  const body = panelBodies.get(panel);
  if (body === undefined || !panel.children.includes(body)) return;
  body.remove();
}

/** Expand the panel at `index`: re-attach its body under the panel. */
export function expandPanel(panels: Node, index: number): void {
  const panel = panelAt(panels, index);
  if (panel === undefined) return;
  const body = panelBodies.get(panel);
  if (body === undefined || panel.children.includes(body)) return;
  panel.addChild(body);
}

/**
 * Toggle the collapsed state of the panel at `index`. Returns the new
 * collapsed state (`true` = collapsed; `false` when the index or the panel's
 * body is unknown).
 */
export function togglePanel(panels: Node, index: number): boolean {
  const panel = panelAt(panels, index);
  if (panel === undefined) return false;
  const body = panelBodies.get(panel);
  if (body === undefined) return false;
  const wasCollapsed = !panel.children.includes(body);
  if (wasCollapsed) {
    expandPanel(panels, index);
  } else {
    collapsePanel(panels, index);
  }
  return !wasCollapsed;
}

/** Set the active panel index and restyle the headers (the active panel's
 * header is bold). */
export function focusPanel(panels: Node, index: number): void {
  if (panelAt(panels, index) === undefined) return;
  panels.setProps({ ...panels.props, active: index });
  for (let i = 0; i < panels.children.length; i++) {
    const header = panels.children[i]?.children[0];
    if (header !== undefined && header.type === "text") {
      header.setProps({ ...header.props, bold: i === index });
    }
  }
}

/** The default minimum main-axis size a dragged pane keeps, in cells
 * (used when the pane declares no `min_width` / `min_height`). */
export const PANEL_DRAG_MIN_SIZE = 1;

/** The pane a panel drag is resizing: the pane above/left of the gutter. */
export interface PanelDragHandle {
  /** The index of the resized pane within the panels element. */
  index: number;
  /** The stack direction of the panels element. */
  direction: "row" | "column";
}

/** The outcome of one {@link dragPanels} step. */
export interface PanelDragResult extends PanelDragHandle {
  /** The `flex_basis` applied to the resized pane (post-clamp). */
  flex_basis: number;
}

/** The active drag session on a panels node (kept in a WeakMap). */
interface PanelDragState {
  index: number;
  direction: "row" | "column";
  /** The main-axis coordinate of the last handled event. */
  lastMain: number;
  /** The resized pane's current flex-basis (cells). */
  basis: number;
  /** The resized pane's lower clamp (its `min_height`/`min_width`, or 1). */
  minSize: number;
  /** The neighbor pane's lower clamp (the upper-bound slack). */
  neighborMin: number;
  /** The upper clamp for the resized pane, or `Infinity` when the panels
   * element's laid-out size is unavailable (detached). */
  upper: number;
}

/** The active drag session per panels node (one at a time per stack). */
const panelDrags = new WeakMap<Node, PanelDragState>();

/** Read a prop as a finite number, or `null` when it is not one. */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The main-axis gap between panels, mirroring tern-layout's precedence
 * (`column_gap`/`row_gap` override `gap`; the Panels factory defaults `gap`
 * to 1). */
function panelMainGap(panels: Node, direction: "row" | "column"): number {
  const gap = asFiniteNumber(panels.props.gap);
  if (direction === "column") {
    return asFiniteNumber(panels.props.row_gap) ?? gap ?? 1;
  }
  return asFiniteNumber(panels.props.column_gap) ?? gap ?? 1;
}

/** The minimum main-axis size a pane keeps: its `min_height` (column) /
 * `min_width` (row) prop, or {@link PANEL_DRAG_MIN_SIZE}. */
function panelMinSize(panel: Node, direction: "row" | "column"): number {
  const key = direction === "column" ? "min_height" : "min_width";
  return asFiniteNumber(panel.props[key]) ?? PANEL_DRAG_MIN_SIZE;
}

/** The main-axis laid-out size of a pane, or `null` when the tree is
 * detached (`contentSize` throws without a scene). */
function mainAxisSize(panel: Node, direction: "row" | "column"): number | null {
  try {
    const size = panel.contentSize();
    return direction === "column" ? size.height : size.width;
  } catch {
    return null;
  }
}

/** The main-axis coordinate of a mouse event for the stack direction. */
function mainAxisCoord(
  event: MouseEventJs,
  direction: "row" | "column",
): number {
  return direction === "column" ? event.row : event.column;
}

/**
 * Start a panel drag: a `down_left` press on the 1-cell gutter between two
 * adjacent panels records the session and returns the handle for the pane
 * being resized (the pane above/left of the gutter). The gutter cell is the
 * strip at the boundary of the two panels' laid-out extents (`Node.contentSize()`
 * along the stack's main axis, plus the `gap` between panels). Returns `null`
 * when the press is not `down_left`, is not on a gutter (a panel body or a
 * stack with fewer than two panels), or the panels element is detached (no
 * geometry).
 */
export function startPanelDrag(
  panels: Node,
  event: MouseEventJs,
): PanelDragHandle | null {
  if (event.kind !== "down_left") return null;
  const direction = panels.props.flex_direction === "row" ? "row" : "column";
  const children = panels.children;
  if (children.length < 2) return null;

  const gap = panelMainGap(panels, direction);
  const m = mainAxisCoord(event, direction);

  // Walk the cumulative main-axis extents: panel i spans
  // [cursor, cursor + size_i), then the gutter spans
  // [cursor + size_i, cursor + size_i + gap).
  let cursor = 0;
  for (let i = 0; i < children.length - 1; i++) {
    const size = mainAxisSize(children[i]!, direction);
    if (size === null) return null; // detached subtree — no geometry
    const gutterStart = cursor + size;
    if (m >= gutterStart && m < gutterStart + gap) {
      const pane = children[i]!;
      const neighbor = children[i + 1]!;
      const laidOut = size;
      const basis = asFiniteNumber(pane.props.flex_basis) ?? laidOut;
      const minSize = panelMinSize(pane, direction);
      const neighborMin = panelMinSize(neighbor, direction);
      // The stack's laid-out main size (the container rect) bounds the
      // pane so the neighbor keeps at least its min size.
      const stackMain = mainAxisSize(panels, direction);
      const upper = stackMain === null
        ? Infinity
        : stackMain - gap - neighborMin;
      panelDrags.set(panels, {
        index: i,
        direction,
        lastMain: m,
        basis,
        minSize,
        neighborMin,
        upper,
      });
      return { index: i, direction };
    }
    cursor = gutterStart + gap;
  }
  return null;
}

/**
 * Move an active panel drag: a `drag_left` event shifts the split by the
 * event's main-axis delta since the previous event, applying the result as
 * the pane's `flex_basis` via `setProps`. The basis is clamped to the pane's
 * min size (`min_height`/`min_width`, or {@link PANEL_DRAG_MIN_SIZE}) and to
 * the space the neighbor pane's min size leaves (the stack's laid-out main
 * size minus the gutter and the neighbor's min). Returns the applied
 * (post-clamp) result, or `null` when no drag is active or the event is not
 * `drag_left`.
 */
export function dragPanels(
  panels: Node,
  event: MouseEventJs,
): PanelDragResult | null {
  const state = panelDrags.get(panels);
  if (state === undefined || event.kind !== "drag_left") return null;
  const m = mainAxisCoord(event, state.direction);
  const delta = m - state.lastMain;
  state.lastMain = m;
  const lower = state.minSize;
  const upper = Math.max(lower, state.upper);
  const next = Math.min(upper, Math.max(lower, state.basis + delta));
  if (next !== state.basis) {
    const pane = panels.children[state.index];
    if (pane !== undefined) {
      state.basis = next;
      pane.setProps({ ...pane.props, flex_basis: next });
    }
  }
  return { index: state.index, direction: state.direction, flex_basis: next };
}

/**
 * End an active panel drag (any `up_*` mouse event), clearing the session.
 * Returns the ended handle, or `null` when no drag was active. The drag's
 * final `flex_basis` was already applied by the last {@link dragPanels}.
 */
export function endPanelDrag(panels: Node): PanelDragHandle | null {
  const state = panelDrags.get(panels);
  if (state === undefined) return null;
  panelDrags.delete(panels);
  return { index: state.index, direction: state.direction };
}

