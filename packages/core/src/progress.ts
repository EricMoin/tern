//! The Progress element.

import { Node, Text } from "./node.ts";
import { textWidth } from "./textarea.ts";
import type { NodeProps } from "./types.ts";
/** Props for the `Progress` element. Style/layout keys flow to the framed
 * box; `value`/`max` (or `ratio`) drive the fill math; `label` /
 * `show_percentage` / `width` are consumed by the factory. */
export interface ProgressProps extends NodeProps {
  /** The current progress value (default 0). */
  value?: number;
  /** The maximum value (default 100); the bar is full at `value === max`. */
  max?: number;
  /**
   * A 0..1 fill ratio as an alternative to `value`/`max`. When given, it
   * wins over `value`/`max` for both the bar fill and the percentage
   * readout (`ceil(ratio*100)%`). {@link setProgress} replaces it with an
   * explicit `value`/`max`.
   */
  ratio?: number;
  /** The optional label text, left-aligned inside the bar area when there is
   * room (composed only when it fits alongside the percentage readout). */
  label?: string;
  /** Whether the percentage readout renders on the right (default `true`). */
  show_percentage?: boolean;
  /**
   * The outer width in cells, including the frame (default
   * {@link PROGRESS_DEFAULT_WIDTH}); the inner bar width is this minus the
   * frame's border columns (2 for a visible `border_style`, 0 for `none`).
   */
  width?: number;
}

/** The default outer width of a progress gauge, in cells. */
export const PROGRESS_DEFAULT_WIDTH = 20;

/** The fill glyph of a progress bar's filled cells. */
export const PROGRESS_FILL_CHAR = "▓";

/** The fill glyph of a progress bar's unfilled cells. */
export const PROGRESS_EMPTY_CHAR = "░";

/**
 * The cell width reserved for the percentage readout in the label's room
 * check — the readout's widest form (`"100%"`). Reserving the widest form
 * keeps label presence stable as the value changes, so {@link setProgress}
 * never has to add or remove leaves (it repaints in place).
 */
const PROGRESS_PERCENT_RESERVE = 4;

/** The label text of a progress node (JS bookkeeping — never scene props,
 * mirroring `Tabs`' `tabSpecs`). Captured at creation because the label key
 * is consumed by the factory. */
const progressLabels = new WeakMap<Node, string>();

/** Whether a progress node renders its percentage readout (JS bookkeeping —
 * never scene props, mirroring `Select`'s `floating` mapping to `z_index`). */
const progressShowPercentages = new WeakMap<Node, boolean>();

/** The ratio (0..1) of a progress node's props: the explicit `ratio` wins;
 * otherwise `value`/`max` (defaults 0/100, clamped into [0, 1]). */
function progressRatio(props: ProgressProps): number {
  const ratio = props.ratio;
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    return Math.max(0, Math.min(1, ratio));
  }
  const value = typeof props.value === "number" && Number.isFinite(props.value)
    ? Math.max(0, props.value)
    : 0;
  const max =
    typeof props.max === "number" && Number.isFinite(props.max) && props.max > 0
      ? props.max
      : 100;
  return Math.max(0, Math.min(1, value / max));
}

/** The outer width of a progress node (default {@link PROGRESS_DEFAULT_WIDTH}). */
function progressOuterWidth(props: ProgressProps): number {
  const width = props.width;
  return typeof width === "number" && Number.isFinite(width) && width > 0
    ? Math.floor(width)
    : PROGRESS_DEFAULT_WIDTH;
}

/** The frame's horizontal border columns: 2 for a visible `border_style`,
 * 0 for `"none"` or unset. */
function progressFrameWidth(props: ProgressProps): number {
  const border = props.border_style;
  return border !== undefined && border !== "none" ? 2 : 0;
}

/** The bar area width (inside the frame): the outer width minus the border
 * columns. */
function progressInnerWidth(props: ProgressProps): number {
  return Math.max(0, progressOuterWidth(props) - progressFrameWidth(props));
}

/** The percentage readout text: `ceil(ratio*100)%` (e.g. `"50%"`). */
function progressPercentText(props: ProgressProps): string {
  return `${Math.ceil(progressRatio(props) * 100)}%`;
}

/** Whether the label leaf is composed: a non-empty `label` that fits inside
 * the bar area alongside the percentage readout (which reserves its widest
 * form, so the check is stable across value changes). */
function progressLabelFits(
  label: string,
  props: ProgressProps,
  showPercentage: boolean,
): boolean {
  if (label === "") return false;
  const reserve = showPercentage ? PROGRESS_PERCENT_RESERVE : 0;
  return textWidth(label) + reserve <= progressInnerWidth(props);
}

/** The bar text of a progress node's fill leaf: exactly
 * `ceil(ratio * inner_width)` `'▓'` cells followed by `'░'` for the rest of
 * the inner width. */
function progressBarText(props: ProgressProps): string {
  const inner = progressInnerWidth(props);
  const filled = Math.max(
    0,
    Math.min(inner, Math.ceil(progressRatio(props) * inner)),
  );
  return PROGRESS_FILL_CHAR.repeat(filled) +
    PROGRESS_EMPTY_CHAR.repeat(inner - filled);
}

/**
 * Rebuild a progress node's children from its current props (the source of
 * truth, mirroring `rebuildTabs`): the in-flow fill leaf (the bar text at the
 * inner width) plus the optional label overlay (left-aligned, dimmed, only
 * when it fits) and the optional percentage readout overlay (right-aligned).
 * The overlays carry a `z_index` so they paint above the fill leaf. Runs at
 * creation and after a {@link setProgress} call that changes the composition
 * (the label's room check is stable, so in practice `setProgress` repaints in
 * place without rebuilding).
 */
function rebuildProgress(node: Node): void {
  const props = node.props as ProgressProps;
  const showPercentage = progressShowPercentages.get(node) ?? true;
  for (const child of [...node.children]) child.remove();

  // The fill leaf: in-flow, sized to the full inner width — the label and
  // readout overlay it, mirroring ratatui Gauge, so the fill count is exact.
  node.addChild(
    Text({ text: progressBarText(props), width: progressInnerWidth(props) }),
  );
  // The label overlay: left-aligned inside the bar area when there is room.
  const label = progressLabels.get(node) ?? "";
  if (progressLabelFits(label, props, showPercentage)) {
    node.addChild(
      Text({
        text: label,
        position: "absolute",
        left: 0,
        z_index: 1,
        dim: true,
      }),
    );
  }
  // The percentage readout overlay: right side of the bar area.
  if (showPercentage) {
    node.addChild(
      Text({
        text: progressPercentText(props),
        position: "absolute",
        right: 0,
        z_index: 1,
      }),
    );
  }
}

/**
 * Create a `progress` element (ratatui Gauge parity): a framed box — the
 * frame defaults to `border_style: "plain"`, the outer `width` (default
 * {@link PROGRESS_DEFAULT_WIDTH}) minus the border columns is the inner bar
 * width — holding an in-flow fill leaf (`'▓'` × `ceil(value/max * inner)`,
 * `'░'` for the rest) plus an optional dimmed label leaf left-aligned inside
 * the bar area (composed only when it fits alongside the readout) and an
 * optional percentage readout (`ceil(value/max*100)%`) right-aligned inside
 * it. The label and readout are absolutely positioned overlays on the fill,
 * so the fill-cell math is exact regardless of them. A `ratio` prop (0..1)
 * drives the bar directly as an alternative to `value`/`max`. Update a live
 * bar without rebuilding with {@link setProgress}. No new napi node kind: the
 * `progress` element materializes as a `box` (constitution).
 */
export function Progress(props: ProgressProps = {}): Node {
  const rootProps: NodeProps = {
    ...props,
    // The gauge is framed by default (ratatui parity); `border_style: "none"`
    // opts out and the inner width becomes the full outer width.
    border_style: props.border_style ?? "plain",
    flex_direction: "row",
    height: 1,
    width: progressOuterWidth(props),
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.label;
  delete plain.show_percentage;
  const node = Node.create("progress", rootProps, []);
  progressLabels.set(node, typeof props.label === "string" ? props.label : "");
  progressShowPercentages.set(node, props.show_percentage !== false);
  rebuildProgress(node);
  return node;
}

/**
 * Update a live progress bar's value without rebuilding its composition:
 * sets `value`/`max` on the node's props (the explicit `max` argument wins,
 * falling back to the node's current `max`) and repaints the fill leaf and
 * the percentage readout in place. The label leaf's presence is stable (its
 * room check reserves the readout's widest form), so no leaves are added or
 * removed — a pure in-place update.
 */
export function setProgress(node: Node, value: number, max?: number): void {
  const props = node.props as ProgressProps;
  const nextMax = max ?? (typeof props.max === "number" ? props.max : 100);
  const next: ProgressProps = { ...props, value, max: nextMax };
  // `value`/`max` now govern the bar — the `ratio` prop (if any) is dropped.
  delete next.ratio;
  node.setProps(next);
  const bar = node.children[0];
  if (bar !== undefined && bar.type === "text") {
    bar.setProps({
      ...bar.props,
      text: progressBarText(next),
      width: progressInnerWidth(next),
    });
  }
  if (progressShowPercentages.get(node) ?? true) {
    const readout = node.children[node.children.length - 1];
    if (readout !== undefined && readout.type === "text") {
      readout.setProps({ ...readout.props, text: progressPercentText(next) });
    }
  }
}

