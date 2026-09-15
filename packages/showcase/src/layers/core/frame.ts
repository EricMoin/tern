//! Layer A's emitter: the ScreenPlan in, this layer's screen out.
//!
//! WHAT THIS FILE DECIDES, AND WHAT IT REFUSES TO. Nothing about layout: every
//! cell it paints was placed by `core/plan.ts`, the ONE decision point for what
//! is on screen. A region says where its rectangle is, a row says which cells of
//! the region it owns, a span says which cells of that row its text occupies and a
//! mode segment says the cell it starts at. The emitter writes those cells and
//! nothing else — it never recomputes a wrap, a truncation, a marker column or a
//! right-aligned edge, because a second computation is how three renderers drift
//! apart (harness.ts:1-23).
//!
//! WHY THE ROWS ARE COMPOSED HERE AND NOT TAKEN FROM `snapshotFrame`. A frame row
//! must satisfy the harness's shape gate: `frameProblems` (harness.ts:247-259) holds
//! every row to `cellWidth(row) === plan.size.cols` — a PRINTABLE display string,
//! whose wide glyphs measure two cells. `Renderer.snapshotFrame` returns something
//! else: a CELL-INDEXED row, one code unit per cell, in which a wide glyph's
//! continuation column is masked to a space (renderer.ts:528-536 — the
//! `buffer_rows` convention asserted by packages/core/src/snapshot_test.ts:341-345 and
//! mirrored by the fake painter, testkit/fakes.ts:361 and :695). Printing such a row
//! emits one column too many per wide glyph, and MEASURING one — which is what the
//! shape gate does — reports `cols + wideGlyphs`. The preview fixture (the CJK row
//! `項目 値 備考`, goldens/preview.ts:12) fails the gate for exactly that reason, and no
//! layer can pass parity on that screen with a `snapshotFrame` row set. That is the
//! framework gap this layer reports, with those file:lines; the emitter composes the
//! printable rows itself rather than shipping a frame its own gate rejects.
//!
//! The napi addon is not required anywhere in the layer. The SCENE path
//! (`mount.ts`, driven by `main.ts` and smoked through the existing fake-addon seam
//! by `record.ts`) is the framework's own; this frame path is pure data — no addon,
//! no terminal, no PTY.

import type { PlanRegion, ScreenPlan } from "../../core/plan.ts";
import { cellWidth } from "../../core/viewport.ts";
import type { LayerFrame } from "../../parity/harness.ts";
import type { LayerId, ScreenId } from "../../parity/registry-editor.ts";

/** The layer this emitter is — the id every divergence message names. */
export const LAYER_ID: LayerId = "core";

/**
 * Emit one frame for one plan: the layer's whole side of the parity contract
 * (harness.ts:69). `screen` is the harness's label for the plan it handed over; the
 * frame is a function of the PLAN alone, so the label is not consulted — a layer that
 * painted differently per screen name would be a second decision point wearing the
 * harness's vocabulary.
 */
export function emit(plan: ScreenPlan, _screen: ScreenId): LayerFrame {
  return { layer: LAYER_ID, rows: composeRows(plan) };
}

/**
 * The plan's regions as one PRINTABLE string per screen row, each measuring exactly
 * `plan.size.cols` display cells (see the file header for why the framework's own
 * cell-indexed snapshot cannot be this).
 *
 * A blank screen is written region by region: every span, item and segment lands at
 * the cell the plan placed it at, and a wide cluster claims the cells it covers. The
 * write is clipped to the region's own rectangle, so a span can never paint outside
 * the region that owns it — the same clip the compositor applies. A plan that already
 * fits (every fixture does: the regions tile the screen exactly, golden_test.ts'
 * `planCoverage`) is unaffected by the clip; a corrupt plan is contained rather than
 * allowed to smear across its neighbours.
 */
export function composeRows(plan: ScreenPlan): string[] {
  const rows: Cell[][] = [];
  for (let y = 0; y < plan.size.rows; y += 1) rows.push(new Array<Cell>(plan.size.cols).fill(" "));
  for (const region of plan.regions) {
    const right = region.x + region.width;
    const bottom = region.y + region.height;
    for (const [text, x, y] of placements(region)) {
      if (y < 0 || y >= bottom || y >= rows.length) continue;
      writeClusters(rows[y]!, text, x, right);
    }
  }
  return rows.map((row) => joinCells(row, plan.size.cols));
}

/** One cell of a row being composed: the cluster that starts here, or `null` for a
 * wide cluster's continuation column (which contributes no character of its own). */
type Cell = string | null;

/** One region's cells as `[text, screen x, screen y]`, in paint order. The row a
 * region-local row lands on is the region's own `screenRow` (or its `y` for the
 * single-row mode line), so no region needs arithmetic of its own. */
function placements(region: PlanRegion): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  if (region.kind === "editor") {
    for (const row of region.rows) {
      for (const span of row.spans) out.push([span.text, region.x + span.x, region.y + row.screenRow]);
    }
  } else if (region.kind === "sidebar") {
    for (const item of region.items) {
      for (const span of item.spans) out.push([span.text, region.x + span.x, region.y + item.screenRow]);
    }
  } else if (region.kind === "modal") {
    // The overlay paints OVER the panes: `composeRows` walks `regions` in order and
    // writes cells, so the pane beneath is written first and the overlay's own cells
    // land on top of it — an overlay is the one region whose cells were already
    // claimed, and the plan is what decided that (plan.ts:264-273).
    for (const row of region.rows) {
      for (const span of row.spans) out.push([span.text, region.x + span.x, region.y + row.screenRow]);
    }
  } else {
    for (const segment of region.segments) out.push([segment.text, region.x + segment.x, region.y]);
  }
  return out;
}

/**
 * Write `text` from cell `x`, one grapheme cluster at a time: the cluster's text at
 * its lead column and `null` on the columns it covers beyond the first.
 *
 * A cluster is written whole — cutting one between cells is what `plan.ts` already
 * refuses to do (`fit`, plan.ts:383), so this writer must not reintroduce it — and a
 * wide cluster is measured, not counted: `cellWidth` is the framework's own cell
 * measure, the one the plan's span widths came from (core/viewport.ts:257).
 */
function writeClusters(row: Cell[], text: string, x: number, right: number): void {
  let at = x;
  for (const cluster of clusters(text)) {
    const width = Math.max(1, Math.min(2, cellWidth(cluster)));
    if (at >= right) return;
    row[at] = cluster;
    for (let i = 1; i < width && at + i < right; i += 1) row[at + i] = null;
    at += width;
  }
}

/** One composed row as its printable string: every lead cluster in cell order, the
 * continuation columns contributing nothing, padded with spaces to `cols` cells. */
function joinCells(row: readonly Cell[], cols: number): string {
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
 * registry-editor.ts' `fix-grapheme-primitives-unexported` names — so the emitter
 * segments through the platform's own segmenter and falls back to code points,
 * exactly as the framework's own `clusterRuns` does. */
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
