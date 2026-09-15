//! The StatusBar element and its segment model.

import { Node, Text } from "./node.ts";
import type { NodeProps } from "./types.ts";
/** A status-bar segment: a string (wrapped in a `Text` node) or a `Node`. */
export type StatusBarSegment = string | Node;

/** Props for the `StatusBar` element. `left`/`center`/`right` are the
 * segments; remaining props style the strip itself. */
export interface StatusBarProps extends NodeProps {
  /** The left-aligned segment. */
  left?: StatusBarSegment;
  /** The centered segment. */
  center?: StatusBarSegment;
  /** The right-aligned segment. */
  right?: StatusBarSegment;
}

function toSegment(segment: StatusBarSegment): Node {
  return typeof segment === "string" ? Text({ text: segment }) : segment;
}

/**
 * Create a `status_bar` element: a single-row flex strip with
 * `justify_content: "space-between"` whose children are the left/center/
 * right segment `Text` nodes, in that order (missing segments are omitted).
 * The segment keys are lifted out of the strip's props — `left`/`right` are
 * absolute-position inset keywords in tern-layout, so they must never reach
 * the layout engine.
 *
 * The strip is stamped `status_bar: true`: the compositor reads that marker
 * to reserve the bottom viewport row for the strip (docs/components.md
 * "StatusBar — Reserved row") — panels lay out one row shorter and the strip
 * pins to the reserved row. Like `z_index` / `wrap`, the marker is
 * compositor-consumed (it flows through the binding into the scene prop map)
 * and never reaches the layout engine.
 */
export function StatusBar(props: StatusBarProps = {}): Node {
  const segments: Node[] = [];
  if (props.left !== undefined) segments.push(toSegment(props.left));
  if (props.center !== undefined) segments.push(toSegment(props.center));
  if (props.right !== undefined) segments.push(toSegment(props.right));
  const strip: NodeProps = {
    ...props,
    flex_direction: "row",
    justify_content: "space-between",
    height: props.height ?? 1,
    // Compositor-consumed marker (docs/components.md "StatusBar — Reserved
    // row"): the strip owns the bottom viewport row, so no panel/scroll
    // region overlaps it. Mirrors the Rust renderable's stamp in
    // src/core/tern-components/src/statusbar.rs.
    status_bar: true,
  };
  const plain = strip as Record<string, unknown>;
  delete plain.left;
  delete plain.center;
  delete plain.right;
  return Node.create("status_bar", strip, segments);
}

