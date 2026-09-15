//! The parity harness's STUB layer — TEST-ONLY, and deliberately trivial.
//!
//! It exists so the harness's own failure mode can be PROVEN
//! (golden_test.ts injects a divergence into it and asserts the message), not to
//! stand in for a renderer: it imports no framework, mounts no scene, owns no
//! layout, and paints the plan's own spans into a grid of characters. The three
//! real layers (packages/showcase/src/layers/) are built by their own subtasks;
//! nothing here may be mistaken for one of them — `layer` is the id the stub
//! CLAIMS so that a divergence message names a layer the way a real one would.
//!
//! It is ASCII-correct only: one code point per cell, no grapheme clustering and
//! no wide-glyph arithmetic. That is enough for the self-test's ASCII fixture and
//! is exactly why it is not a renderer.

import type { ScreenPlan } from "../core/plan.ts";
import { defineLayer, type RendererLayer } from "./harness.ts";
import type { LayerId } from "./registry-editor.ts";

/** A stub layer claiming `layer`: the plan's spans as plain text. */
export function stubLayer(layer: LayerId): RendererLayer {
  return defineLayer(layer, (plan) => ({ layer, rows: paint(plan) }));
}

/** Every cell the plan asks for, as plain characters: a span's text at its own
 * `x`, region-local row, and the mode line's segments at theirs. */
export function paint(plan: ScreenPlan): string[] {
  const grid: string[][] = [];
  for (let row = 0; row < plan.size.rows; row += 1) grid.push(new Array<string>(plan.size.cols).fill(" "));
  for (const region of plan.regions) {
    if (region.kind === "editor") {
      for (const row of region.rows) for (const span of row.spans) put(grid, span.text, region.x + span.x, region.y + row.row);
    } else if (region.kind === "sidebar") {
      for (const item of region.items) for (const span of item.spans) put(grid, span.text, region.x + span.x, region.y + item.row);
    } else if (region.kind === "modal") {
      // The overlay paints LAST (plan.ts) and put overwrites, so its cells land
      // over the panes — the same order the real layers paint in.
      for (const row of region.rows) for (const span of row.spans) put(grid, span.text, region.x + span.x, region.y + row.row);
    } else {
      for (const segment of region.segments) put(grid, segment.text, region.x + segment.x, region.y);
    }
  }
  return grid.map((row) => row.join(""));
}

/** Write `text` at cell (x, y), one code point per cell. */
function put(grid: string[][], text: string, x: number, y: number): void {
  const row = grid[y];
  if (row === undefined) return;
  let at = x;
  for (const char of text) {
    if (at >= row.length) return;
    if (at >= 0) row[at] = char;
    at += 1;
  }
}
