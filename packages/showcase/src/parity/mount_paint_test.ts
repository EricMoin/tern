//! The PLAN-VERSUS-PAINT gate: the frame mount.ts paints, at the plan's own size.
//!
//! WHY THIS TEST EXISTS, AND WHY THE GOLDENS DID NOT CATCH IT. Every other parity
//! gate in this directory records the ScreenPlan through `frame.ts`, the PURE
//! emitter (frame.ts:47-76): plan in, rows out, no scene, no compositor. So a mount
//! that stacks a scroll region's rows in the WRONG DIRECTION, or hands the
//! compositor a clip rect in the wrong coordinate space, changes nothing those
//! goldens can see — they were green while the painted frame was broken. This file
//! drives the REAL scene `mountPlan` builds and asserts the PAINTED frame, which is
//! the one artifact the plan does not already contain.
//!
//! WHAT PAINTS THE SCENE. The scene is real: `mountPlan(plan)` through the core's
//! fake-addon seam (`setAddonForTesting`, packages/core/src/addon.ts:133) — the
//! same seam `layers/core/record.ts` smokes the mount through — and the native
//! node handles it materializes are walked here. The PAINT is a model that carries
//! exactly the two engine rules this screen family depends on, each pinned to the
//! engine's own source and to the real compositor's output:
//!
//!   * FLOW. A box's children run along `flex_direction`, whose engine default is
//!     `row` (src/core/tern-layout/src/style.rs:12-16, documented at
//!     src/core/tern-layout/src/lib.rs:18). A scroll region that does not say
//!     `column` therefore lays its rows out side by side.
//!   * CLIP. A clip rect is in SCENE coordinates and is inherited by intersection
//!     (src/core/tern-core/src/scene.rs:565-568, src/core/tern-components/src/
//!     compositor/region.rs:92-122, compositor.rs:46-56) — NOT in the declaring
//!     node's own box. A view at x=20 that declares `clip_x: 0, clip_width: 60`
//!     therefore loses the columns it stands on.
//!
//! The model refuses the shapes it does not carry (padding, borders, a virtualised
//! node whose materialized window is offset) rather than guessing at them, and it
//! carries ABSOLUTE POSITIONING, which the modal overlay rides: an absolute child is
//! laid out against its direct parent's padding box and paints above the in-flow
//! content (src/core/tern-layout/src/lib.rs:64-72, `MODAL_Z_INDEX`). It does NOT
//! model the engine's soft wrap: on a CORRECT
//! scene no row overflows its region, so wrap is unobservable, and the model
//! reproduces the engine row for row (measured: the real compositor's headless
//! frame for this very scene, 80x24, matches to the cell). On a BROKEN scene the
//! model reports a divergence whose exact shape is the model's, not necessarily the
//! engine's — the engine additionally soft-wraps the overflow; both are a frame
//! that is not the plan's.
//!
//! THE TWO ROWS THAT FOUND THIS. Pre-fix, the open-edit-save launch at 80x24
//! painted (real compositor, headless):
//!
//!   row 0 |> open-edit-save.txtTERN_E2E_OPEN_EDIT_SAVE_MARKER# open-edi  |
//!   row 1 |                                        t-save                |
//!
//! — the sidebar's rows ran across the screen and the editor's rows wrapped at 40
//! of their 60 columns. The plan for the same frame puts the sidebar at x=0 w=20
//! and the editor's five rows at x=20, w=60, one per screen row.
//!
//! THE CONVENTIONS THIS FILE KEEPS. The plan side is `composeRows` — frame.ts's
//! PRINTABLE rows, which are what `frameProblems` gates (harness.ts:247-259: every
//! row must measure `cellWidth(row) === plan.size.cols`). `snapshotFrame` rows are a
//! different convention: cell-indexed, one code unit per cell, with a wide glyph's
//! continuation column masked to a space (renderer.ts:528-536), so a CJK row
//! measures `cols + wideGlyphs` and fails that gate. This file therefore compares
//! the painted (cell-indexed) frame against the cell-indexed form of the printable
//! plan frame; neither harness convention is changed here.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/parity/

import { createRenderer } from "@tern-tui/core";
import { Buffer } from "../core/buffer.ts";
import type { PlanRegion, ScreenPlan } from "../core/plan.ts";
import { HeadlessApp } from "../core/state.ts";
import { cellWidth } from "../core/viewport.ts";
import { OPEN_EDIT_SAVE } from "../e2e/fixture.ts";
import { composeRows } from "../layers/core/frame.ts";
import { mountPlan } from "../layers/core/mount.ts";
import { state, withFakeAddon, type FakeNodeHandle } from "../../../core/src/testkit/fakes.ts";
import { FIXTURES } from "./goldens/index.ts";
import { referencePlan } from "./goldens/fixture.ts";
import { frameProblems, type LayerFrame } from "./harness.ts";

// --- the paint model ---------------------------------------------------------

/** A rectangle in scene cells. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The scene the mount materializes, painted into `cols` x `rows` cell rows. */
function paintScene(root: FakeNodeHandle, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(" "));
  // The native scene root paints a single mounted child at the viewport (the
  // engine promotes a tree root's frame to the scene root — compositor.rs:30-35).
  const mounted = root.children[0];
  if (mounted === undefined || root.children.length !== 1) {
    throw new Error("the scene root holds " + root.children.length + " children, expected the one mounted plan");
  }
  paintNode(mounted, { x: 0, y: 0, width: cols, height: rows }, { x: 0, y: 0, width: cols, height: rows }, grid);
  return grid.map((row) => row.join(""));
}

/**
 * Paint one node inside `box` through the clip rect `inherited`.
 *
 * TWO KINDS OF CHILD, IN THE ENGINE'S OWN ORDER. In-flow children flow along
 * `flex_direction` and take the parent's space; an ABSOLUTELY POSITIONED child is out
 * of that flow (src/core/tern-layout/src/lib.rs:64-72: it occupies no space and is laid
 * out against its direct parent's padding box) and paints ABOVE the in-flow content,
 * which is the z-order the framework's own overlay rides (`MODAL_Z_INDEX`,
 * packages/core/src/modal.ts:25). The modal overlay is exactly that child, so the
 * model paints it last: the panes first, the overlay's cells over them — the order
 * `composeRows` writes them in.
 */
function paintNode(node: FakeNodeHandle, box: Rect, inherited: Rect, grid: string[][]): void {
  refuseUnmodelled(node);
  const clip = clipOf(node, inherited);
  const scrollX = numberOf(node.props.scroll_x) ?? 0;
  const scrollY = numberOf(node.props.scroll_y) ?? 0;
  const x = box.x - scrollX;
  const y = box.y - scrollY;
  if (node.children.length === 0) {
    paintText(node, x, y, clip, grid);
    return;
  }
  const floating = node.children.filter((child) => child.props.position === "absolute");
  const flow = node.children.filter((child) => child.props.position !== "absolute");
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
    const left = numberOf(child.props.left) ?? 0;
    const top = numberOf(child.props.top) ?? 0;
    const width = numberOf(child.props.width) ?? box.width - left;
    const height = numberOf(child.props.height) ?? box.height - top;
    paintNode(child, { x: x + left, y: y + top, width, height }, clip, grid);
  }
}

/** The effective clip rect of `node`: the inherited region intersected with the
 * node's own, which the engine reads in SCENE coordinates (scene.rs:565-568,
 * compositor/region.rs:92-122). */
function clipOf(node: FakeNodeHandle, inherited: Rect): Rect {
  const x = numberOf(node.props.clip_x);
  const y = numberOf(node.props.clip_y);
  const width = numberOf(node.props.clip_width);
  const height = numberOf(node.props.clip_height);
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
function measure(node: FakeNodeHandle): { width: number; height: number } {
  const declaredWidth = numberOf(node.props.width);
  const declaredHeight = numberOf(node.props.height);
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

/** Write a text leaf's clusters from `x`, one row tall, clipped to `clip` — a
 * wide cluster's lead column carries its text and its trailing column a space, the
 * cell-indexed convention `snapshotFrame` returns. A cluster that would start past
 * the region's right edge is dropped whole, never split (`plan.ts` refuses to cut
 * one and the compositor clips the cell). */
function paintText(node: FakeNodeHandle, x: number, y: number, clip: Rect, grid: string[][]): void {
  const text = typeof node.props.text === "string" ? node.props.text : "";
  const row = grid[y];
  if (row === undefined) return;
  let at = x;
  for (const cluster of clusters(text)) {
    const width = Math.max(1, Math.min(2, cellWidth(cluster)));
    if (at >= clip.x + clip.width) return;
    if (at >= clip.x && y >= clip.y && y < clip.y + clip.height && at < row.length) {
      row[at] = cluster;
      for (let i = 1; i < width && at + i < clip.x + clip.width && at + i < row.length; i += 1) row[at + i] = " ";
    }
    at += width;
  }
}

/** Refuse a scene shape this model does not carry, rather than painting a guess.
 * Absolute positioning IS carried (see `paintNode`): the overlay rides it, and the
 * engine's rule for it is one line of arithmetic. Padding and borders stay refused:
 * the plan places every cell itself and draws its frame as text. */
function refuseUnmodelled(node: FakeNodeHandle): void {
  const padding = numberOf(node.props.padding);
  if (padding !== undefined && padding !== 0) throw new Error("the paint model does not carry padding (" + node.kind + ")");
  const border = node.props.border_style;
  if (border !== undefined && border !== "none") throw new Error("the paint model does not carry borders (" + node.kind + ")");
}

/** A numeric prop, or undefined when absent (or not a number). */
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** The extended grapheme clusters of `text` — the same split `frame.ts` uses. */
function clusters(text: string): Iterable<string> {
  const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  if (segmenter === null) return text;
  return (function* () {
    for (const part of segmenter.segment(text)) yield part.segment;
  })();
}

// --- the mount, painted ------------------------------------------------------

/** The frame `mountPlan` paints for `plan`, through the real scene and the paint
 * model above. One scene per call: the fake seam is reset around each run. */
function mountAndPaint(plan: ScreenPlan): string[] {
  return withFakeAddon(() => {
    const renderer = createRenderer({ headless: true, size: { width: plan.size.cols, height: plan.size.rows } });
    try {
      renderer.root.addChild(mountPlan(plan));
      const fake = state.lastFakeRenderer;
      if (fake === null) throw new Error("the fake addon recorded no renderer, so the scene was not materialized");
      return paintScene(fake.root() as unknown as FakeNodeHandle, plan.size.cols, plan.size.rows);
    } finally {
      renderer.destroy();
    }
  });
}

/** One plan row as a printable row measures it: the cell-indexed twin of a
 * `composeRows` row, one code unit per cell, wide clusters masked. */
function cellRow(row: string): string {
  let out = "";
  for (const cluster of clusters(row)) {
    const width = Math.max(1, Math.min(2, cellWidth(cluster)));
    out += cluster + " ".repeat(width - 1);
  }
  return out;
}

/** The plan's rows that own a screen row, per region, so a failure can name the
 * region and the row index the plan put a row at. Every row index here is
 * REGION-LOCAL: the caller adds `region.y` (line 276), which is the convention
 * `plan-modals.ts` documents for the overlay too. */
function regionRows(region: PlanRegion): number[] {
  if (region.kind === "editor") return region.rows.map((row) => row.screenRow);
  if (region.kind === "sidebar") return region.items.map((item) => item.screenRow);
  if (region.kind === "modal") return region.rows.map((row) => row.screenRow);
  return region.segments.length === 0 ? [] : [0];
}

/** Everything where the painted frame is not the frame the plan lays out: the
 * harness's printable shape gate on the plan side, then every region row, then every
 * screen row. */
function planVsPaintProblems(painted: readonly string[], plan: ScreenPlan): string[] {
  const planned = composeRows(plan);
  const frame: LayerFrame = { layer: "core", rows: planned };
  const problems = frameProblems(frame, plan);
  const cells = planned.map(cellRow);
  if (painted.length !== plan.size.rows) {
    problems.push("painted " + painted.length + " rows, the plan has " + plan.size.rows);
  }
  for (const region of plan.regions) {
    const right = region.x + region.width;
    for (const screenRow of regionRows(region)) {
      const row = region.y + screenRow;
      const want = (cells[row] ?? "").slice(region.x, right);
      const got = (painted[row] ?? "").slice(region.x, right);
      if (want === got) continue;
      const where = region.kind + " region, its row " + screenRow + " (screen row " + row + ", columns " + region.x + ".." + right + ")";
      if (got.trim() === "") {
        problems.push("the " + where + " paints nothing: the plan puts " + JSON.stringify(want.trimEnd()) + " there");
      } else if (want.trimEnd().startsWith(got.trimEnd())) {
        problems.push("the " + where + " stops after " + cellWidth(got.trimEnd()) + " of " + cellWidth(want.trimEnd()) +
          " cells: painted " + JSON.stringify(got.trimEnd()) + ", planned " + JSON.stringify(want.trimEnd()));
      } else {
        problems.push("the " + where + " is not the plan's row: painted " + JSON.stringify(got.trimEnd()) +
          ", planned " + JSON.stringify(want.trimEnd()));
      }
    }
  }
  for (let row = 0; row < Math.min(painted.length, cells.length); row += 1) {
    if (painted[row] === cells[row]) continue;
    if (problems.some((problem) => problem.includes("(screen row " + row + ","))) continue;
    problems.push("screen row " + row + " is not the plan's row: painted " + JSON.stringify(painted[row]) +
      ", planned " + JSON.stringify(cells[row]));
  }
  return problems;
}

/** Fail unless the frame mount.ts paints IS the frame the plan lays out. */
function checkPaint(screen: string, plan: ScreenPlan): void {
  const problems = planVsPaintProblems(mountAndPaint(plan), plan);
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).map((problem) => "  " + problem).join("\n");
    const more = problems.length > 8 ? "\n  ... " + (problems.length - 8) + " more" : "";
    throw new Error("mount.ts paints a different frame than the plan lays out (" + screen + ", " +
      plan.size.cols + "x" + plan.size.rows + "):\n" + shown + more);
  }
  console.log("mount paint: " + screen + " " + plan.size.cols + "x" + plan.size.rows +
    " — the painted frame is the plan's frame (" + plan.regions.length + " regions)");
}

// --- the screens -------------------------------------------------------------

/** The open-edit-save launch: the document the e2e flow opens, at 80x24, with the
 * file list beside it — the screen the two defects were found on (sidebar at x=0
 * w=20, editor at x=20 w=60). */
const OPEN_EDIT_SAVE_SIZE = { rows: 24, cols: 80 };

function openEditSavePlan(): ScreenPlan {
  const app = new HeadlessApp({
    buffer: Buffer.fromString(OPEN_EDIT_SAVE.text),
    path: "/tmp/tern-probe/" + OPEN_EDIT_SAVE.fileName,
    items: [OPEN_EDIT_SAVE.fileName],
    size: OPEN_EDIT_SAVE_SIZE,
  });
  return app.plan(OPEN_EDIT_SAVE_SIZE);
}

for (const fixture of FIXTURES) {
  Deno.test("mount paint: the " + fixture.screen + " screen's painted frame is the plan's frame", () => {
    checkPaint(fixture.screen, referencePlan(fixture));
  });
}

Deno.test("mount paint: the open-edit-save launch frame is the plan's frame", () => {
  checkPaint("open-edit-save", openEditSavePlan());
});
