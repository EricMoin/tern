//! Layer B's emitter: the ScreenPlan in, this layer's screen out.
//!
//! THE FRAME IS WHAT THE REACT COMMIT PAINTED, NOT A SECOND COMPOSITION. Layer A's
//! emitter transcribes the plan's regions into printable rows itself
//! (layers/core/frame.ts:64-76). This layer does something strictly stronger: it
//! MOUNTS the element tree `App.planElement` builds through the framework's own
//! reconciler and paints the committed scene graph. So the parity rows cannot drift
//! from the tree that `main.ts` mounts — a row the tree moves is a row this file
//! reports, because the row was read back off the scene the tree produced.
//!
//! NO ADDON, NO TERMINAL, NO PTY. `createRoot` (packages/react/src/reconciler/
//! hooks.ts:81) needs a container of `{ root, renderer }` and nothing else, so the
//! mount runs against a DETACHED core root — the framework's own test seam
//! (packages/react/src/index_test.ts:105-157: "the scene root is a detached core
//! Node, so addChild/setProps are pure JS bookkeeping and the commit never touches
//! the native scene"). The commit is flushed synchronously by `createRoot`
//! (reconciler/hooks.ts:124-131), so `emit` stays a pure function of the plan.
//!
//! WHY THE ROWS ARE COMPOSED AND NOT TAKEN FROM `snapshotFrame`. A frame row must
//! satisfy the harness's shape gate: `frameProblems` (harness.ts:247-259) holds
//! every row to `cellWidth(row) === plan.size.cols` — a PRINTABLE display string,
//! whose wide glyphs measure two cells. `Renderer.snapshotFrame` returns something
//! else: a CELL-INDEXED row, one code unit per cell, whose wide-glyph continuation
//! column is masked to a space (renderer.ts:528-536). Printing such a row emits one
//! column too many per wide glyph, and MEASURING one — which is what the shape gate
//! does — reports `cols + wideGlyphs`. The preview fixture (the CJK row
//! `項目 値 備考`, goldens/preview.ts:16) fails the gate for exactly that reason.
//! The paint below therefore writes a wide cluster as its own text at its lead cell
//! and leaves its continuation cell EMPTY (not a space), which is the printable
//! convention layer A's `composeRows` produces (layers/core/frame.ts:121-132).
//! `app_test.ts` holds the two side by side for all twelve fixtures.

import { Box as CoreBox, type Node, type Renderer } from "@tern-tui/core";
import { createRoot } from "@tern-tui/react";
import type { ScreenPlan } from "../../core/plan.ts";
import { cellWidth } from "../../core/viewport.ts";
import type { LayerFrame } from "../../parity/harness.ts";
import type { LayerId, ScreenId } from "../../parity/registry-editor.ts";
import { planElement } from "./App.ts";

/** The layer this emitter is — the id every divergence message names. */
export const LAYER_ID: LayerId = "react";

/**
 * Emit one frame for one plan: the layer's whole side of the parity contract
 * (harness.ts:69). `screen` is the harness's label for the plan it handed over; the
 * frame is a function of the PLAN alone, so the label is not consulted — a layer
 * that painted differently per screen name would be a second decision point wearing
 * the harness's vocabulary.
 */
export function emit(plan: ScreenPlan, _screen: ScreenId): LayerFrame {
  return { layer: LAYER_ID, rows: paintPlan(plan) };
}

/** The plan's screen as the React tree paints it: one PRINTABLE string per screen
 * row, each measuring exactly `plan.size.cols` display cells. */
export function paintPlan(plan: ScreenPlan): string[] {
  return withScene(plan, (mounted) => paintScene(mounted, plan.size.cols, plan.size.rows));
}

/**
 * Mount `planElement(plan)` through the framework's reconciler over a detached
 * scene root, hand the committed root node to `use`, then unmount.
 *
 * The one-child assertion is what keeps a silent non-commit from reading as an
 * empty screen: `createRoot` flushes synchronously unless the process marked itself
 * as React's test environment (reconciler/hooks.ts:124-131), and a tree that never
 * flushed would paint a blank frame that every shape gate would accept.
 */
export function withScene<T>(plan: ScreenPlan, use: (mounted: Node) => T): T {
  const sceneRoot = CoreBox();
  const renderer = { root: sceneRoot, render: () => {} } as unknown as Renderer;
  const root = createRoot(renderer);
  try {
    root.render(planElement(plan));
    const mounted = sceneRoot.children;
    if (mounted.length !== 1) {
      throw new Error("the React commit left " + mounted.length +
        " children on the scene root, expected the one mounted plan");
    }
    return use(mounted[0]!);
  } finally {
    root.unmount();
  }
}

// --- the paint model ---------------------------------------------------------

/** A rectangle in scene cells. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One cell of a row being painted: the cluster that starts here, `null` for a
 * wide cluster's continuation column (which contributes no character of its own). */
type Cell = string | null;

/** Paint the mounted plan into `cols` x `rows` printable rows. `mounted` is the
 * tree root the reconciler committed; the engine promotes a tree root's frame to
 * the scene root (compositor.rs:30-35), so it owns the whole viewport. */
function paintScene(mounted: Node, cols: number, rows: number): string[] {
  const grid: Cell[][] = Array.from({ length: rows }, () => new Array<Cell>(cols).fill(" "));
  paintNode(mounted, { x: 0, y: 0, width: cols, height: rows }, { x: 0, y: 0, width: cols, height: rows }, grid);
  return grid.map((row) => joinRow(row, cols));
}

/**
 * Paint one node inside `box` through the clip rect `inherited`.
 *
 * TWO KINDS OF CHILD, IN THE ENGINE'S OWN ORDER. In-flow children flow along
 * `flex_direction` and take the parent's space; an ABSOLUTELY POSITIONED child is out
 * of that flow (src/core/tern-layout/src/lib.rs:64-72: it occupies no space and is laid
 * out against its direct parent's padding box) and paints ABOVE the in-flow content —
 * the z-order the overlay rides (`MODAL_Z_INDEX`, packages/core/src/modal.ts:25). The
 * modal overlay is exactly that child, so the model paints it last: the panes first,
 * the overlay's cells over them, which is the order `composeRows` writes them in.
 */
function paintNode(node: Node, box: Rect, inherited: Rect, grid: Cell[][]): void {
  refuseUnmodelled(node);
  const clip = clipOf(node, inherited);
  const x = box.x - numberOf(node.props.scroll_x);
  const y = box.y - numberOf(node.props.scroll_y);
  const children = node.children;
  if (children.length === 0) {
    paintText(node, x, y, clip, grid);
    return;
  }
  const floating = children.filter((child) => child.props.position === "absolute");
  const flow = children.filter((child) => child.props.position !== "absolute");
  const sizes = flow.map((child) => measure(child));
  if (node.props.flex_direction === "column") {
    let cursor = y;
    for (let i = 0; i < flow.length; i += 1) {
      const height = sizes[i]!.height;
      paintNode(flow[i]!, { x, y: cursor, width: box.width, height }, clip, grid);
      cursor += height;
    }
  } else if (node.props.justify_content === "space-between") {
    // The engine's default flow is a ROW (tern-layout/src/style.rs:16).
    if (flow.length > 2) throw new Error("the paint model covers space-between with at most two children");
    paintNode(flow[0]!, { x, y, width: sizes[0]!.width, height: box.height }, clip, grid);
    if (flow.length === 2) {
      paintNode(flow[1]!, { x: x + box.width - sizes[1]!.width, y, width: sizes[1]!.width, height: box.height }, clip, grid);
    }
  } else {
    let cursor = x;
    for (let i = 0; i < flow.length; i += 1) {
      const width = sizes[i]!.width;
      paintNode(flow[i]!, { x: cursor, y, width, height: box.height }, clip, grid);
      cursor += width;
    }
  }
  for (const child of floating) {
    const left = optional(child.props.left) ?? 0;
    const top = optional(child.props.top) ?? 0;
    const width = optional(child.props.width) ?? box.width - left;
    const height = optional(child.props.height) ?? box.height - top;
    paintNode(child, { x: x + left, y: y + top, width, height }, clip, grid);
  }
}

/** The effective clip rect of `node`: the inherited region intersected with the
 * node's own, which the engine reads in SCENE coordinates (scene.rs:565-568,
 * compositor/region.rs:92-122). This is the rule the layer's own `viewProps` has to
 * obey, and the reason a clip rect cannot be the view's own box. */
function clipOf(node: Node, inherited: Rect): Rect {
  const x = optional(node.props.clip_x);
  const y = optional(node.props.clip_y);
  const width = optional(node.props.clip_width);
  const height = optional(node.props.clip_height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return inherited;
  const left = Math.max(inherited.x, x);
  const top = Math.max(inherited.y, y);
  const right = Math.min(inherited.x + inherited.width, x + width);
  const bottom = Math.min(inherited.y + inherited.height, y + height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** A node's natural size: its declared `width`/`height` when it has them (every
 * region rectangle and the mode strip do), else measured from its children — a
 * column sums heights and takes the widest child, a row sums widths. */
function measure(node: Node): { width: number; height: number } {
  const declaredWidth = optional(node.props.width);
  const declaredHeight = optional(node.props.height);
  if (node.children.length === 0) {
    const text = typeof node.props.text === "string" ? node.props.text : "";
    return { width: declaredWidth ?? cellWidth(text), height: declaredHeight ?? 1 };
  }
  const column = node.props.flex_direction === "column";
  let width = 0;
  let height = 0;
  for (const child of node.children) {
    const size = measure(child);
    if (column) {
      width = Math.max(width, size.width);
      height += size.height;
    } else {
      width += size.width;
      height = Math.max(height, size.height);
    }
  }
  return { width: declaredWidth ?? width, height: declaredHeight ?? height };
}

/**
 * Write a text leaf's clusters from `x`, one row tall, clipped to `clip` — the
 * PRINTABLE convention: a wide cluster's lead cell carries its whole text and its
 * trailing cell stays EMPTY, so `joinRow` emits one string per cluster and the row
 * measures the cell count the plan laid out. A cluster that would start past the
 * region's right edge is dropped whole, never split (`plan.ts` refuses to cut one
 * and the compositor clips the cell).
 */
function paintText(node: Node, x: number, y: number, clip: Rect, grid: Cell[][]): void {
  const text = typeof node.props.text === "string" ? node.props.text : "";
  const row = grid[y];
  if (row === undefined) return;
  let at = x;
  for (const cluster of clusters(text)) {
    const width = Math.max(1, Math.min(2, cellWidth(cluster)));
    if (at >= clip.x + clip.width) return;
    if (at >= clip.x && y >= clip.y && y < clip.y + clip.height && at < row.length) {
      row[at] = cluster;
      for (let i = 1; i < width && at + i < clip.x + clip.width && at + i < row.length; i += 1) row[at + i] = null;
    }
    at += width;
  }
}

/** Refuse a scene shape this model does not carry, rather than painting a guess.
 * Absolute positioning IS carried (see `paintNode`): the overlay rides it and the
 * engine's rule for it is one line of arithmetic. Padding and borders stay refused —
 * the plan places every cell itself and draws its frame as text. */
function refuseUnmodelled(node: Node): void {
  const padding = optional(node.props.padding);
  if (padding !== undefined && padding !== 0) throw new Error("the paint model does not carry padding (" + node.type + ")");
  const border = node.props.border_style;
  if (border !== undefined && border !== "none") throw new Error("the paint model does not carry borders (" + node.type + ")");
}

/** A numeric prop, or 0 when absent — the engine's own default for a scroll offset. */
function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** A numeric prop, or undefined when absent (or not a number). */
function optional(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** One painted row as its printable string: every lead cluster in cell order, the
 * continuation cells contributing nothing, padded with spaces to `cols` cells. */
function joinRow(row: readonly Cell[], cols: number): string {
  let text = "";
  let width = 0;
  for (const cell of row) {
    if (cell === null) continue;
    text += cell;
    width += Math.max(1, cellWidth(cell));
  }
  return width < cols ? text + " ".repeat(cols - width) : text;
}

/** The extended grapheme clusters of `text`. The framework's own cluster splitter
 * (packages/core/src/textutil.ts:209) is not part of the barrel — the open gap
 * registry-editor.ts' `fix-grapheme-primitives-unexported` names — so the painter
 * segments through the platform's own segmenter and falls back to code points,
 * exactly as layer A's emitter does (layers/core/frame.ts:139-155). */
function clusters(text: string): Iterable<string> {
  if (segmenter !== null) {
    const segment = segmenter;
    return (function* () {
      for (const part of segment.segment(text)) yield part.segment;
    })();
  }
  return (function* () {
    for (const char of text) yield char;
  })();
}

/** The platform's grapheme segmenter, or null where there is none. */
const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
