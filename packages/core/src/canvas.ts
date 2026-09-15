//! The Canvas element and its braille raster helpers.

import { Node, Text } from "./node.ts";
import type { NodeProps } from "./types.ts";
/**
 * A canvas's sub-cell dot matrix: one string per sub-cell row (4 sub-rows per
 * braille cell), each string one character per sub-cell column (2 sub-columns
 * per braille cell). `"1"` paints the dot at that sub-cell; any other
 * character — or a missing column on a short row — leaves it off (mirrors the
 * Rust `Canvas::set`, whose out-of-bounds dots are ignored). The canvas's
 * braille size derives from the matrix: `ceil(cols / 2)` cells wide by
 * `ceil(rows / 4)` cells tall.
 */
export type CanvasDots = string[];

/**
 * Props for the `Canvas` element. `dots` is consumed by the factory — the
 * sub-cell matrix is JS bookkeeping that never reaches the scene props
 * (mirroring `Tree`'s `nodes` / `Panels`' `panels`): only the rasterized
 * braille text reaches the scene. Remaining props style the root box; the
 * canvas's `fg`/`bg` also paint the braille leaves (mirroring the Rust
 * renderable's row style).
 */
export interface CanvasProps extends NodeProps {
  /** The sub-cell dot matrix, one row string per sub-cell row (`"1"` paints
   * the dot, any other character leaves it off). */
  dots: CanvasDots;
}

/** The bit of the sub-cell (`subCol`, `subRow`) inside its braille cell —
 * the exact mirror of the Rust canvas's `DOT_BITS[subRow][subCol]`: the left
 * sub-column (0) holds dots 1–4 (bits 0–3, 0x01..0x08) and the right
 * sub-column (1) holds dots 5–8 (bits 4–7, 0x10..0x80), top to bottom. */
function brailleDotBit(subCol: number, subRow: number): number {
  return subCol * 4 + subRow;
}

/**
 * Rasterize one braille cell of a canvas into its braille codepoint.
 * `col`/`row` select the braille cell: sub-columns `2*col` and `2*col + 1`,
 * sub-rows `4*row .. 4*row + 3`. The dot→bit map is the Rust renderable's
 * (`DOT_BITS`, src/core/tern-components/src/canvas.rs) — sub-cell (0, r) is
 * dot r+1 (0x01..0x08), sub-cell (1, r) is dot r+5 (0x10..0x80) — so the JS
 * composition and the native renderable rasterize identical glyphs: the
 * codepoint is `0x2800 | bits`, the U+2800 braille block. A sub-cell outside
 * the matrix (a partial edge) reads as off.
 */
export function brailleCell(
  dots: CanvasDots,
  col: number,
  row: number,
): string {
  const x0 = col * 2;
  const y0 = row * 4;
  let bits = 0;
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (dots[y0 + dy]?.[x0 + dx] === "1") {
        bits |= 1 << brailleDotBit(dx, dy);
      }
    }
  }
  return String.fromCodePoint(0x2800 + bits);
}

/**
 * Rasterize a canvas's sub-cell dot matrix into its braille rows: one string
 * of braille codepoints per 4 sub-rows, each `ceil(cols / 2)` codepoints wide
 * — the JS mirror of the Rust `Canvas::rows`. A partial last column or row
 * rasterizes its missing sub-cells as off.
 */
export function brailleRows(dots: CanvasDots): string[] {
  const cols = dots.reduce((max, row) => Math.max(max, row.length), 0);
  const width = Math.ceil(cols / 2);
  const height = Math.ceil(dots.length / 4);
  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    let text = "";
    for (let col = 0; col < width; col++) text += brailleCell(dots, col, row);
    rows.push(text);
  }
  return rows;
}

/**
 * Create a `canvas` element: a sub-cell dot drawing surface rendered as
 * Unicode braille. The `dots` matrix (sub-cell rows of `"1"`/`"0"`) is
 * rasterized JS-side into braille codepoints and composed as a flex column
 * `box` with one `Text` leaf per braille row — the same materialization the
 * Rust canvas renderable produces (src/core/tern-components/src/canvas.rs).
 * The canvas's `fg`/`bg` also paint the braille leaves (mirroring the
 * renderable's row style). No new napi node kind: the `canvas` element
 * materializes as a `box` (constitution).
 */
export function Canvas(props: CanvasProps): Node {
  const rootProps: NodeProps = {
    ...props,
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.dots;
  const canvas = Node.create("canvas", rootProps, []);
  for (const row of brailleRows(props.dots)) {
    const leaf: NodeProps = { text: row };
    if (props.fg !== undefined) leaf.fg = props.fg;
    if (props.bg !== undefined) leaf.bg = props.bg;
    canvas.addChild(Text(leaf));
  }
  return canvas;
}

/** The eighth-block bar glyphs (U+2581..U+2588): index `i` paints `i + 1`
 * eighths of the cell, from the bottom `▁` (1/8) to the full `█` (8/8). */
export const CHART_BLOCK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** The axis glyph: a horizontal line spanning the chart's fixed width. */
export const CHART_AXIS_CHAR = "─";

/** The leaf props of a chart row: the row's own keys plus the chart's
 * `fg`/`bg`, so the glyphs paint in the element's colors (mirroring `Canvas`,
 * whose `fg`/`bg` paint the braille leaves). */
export function chartLeafProps(props: NodeProps, leaf: NodeProps): NodeProps {
  const out = { ...leaf };
  if (props.fg !== undefined) out.fg = props.fg;
  if (props.bg !== undefined) out.bg = props.bg;
  return out;
}

/** Clamp a normalized value into [0, 1]. A non-finite value (NaN from a
 * non-numeric data point) clamps to the bottom of the plot — never a
 * `"undefined"` glyph. */
export function chartClamp(value: number): number {
  if (!(value >= 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * The value scale for a data series: the `min`/`max` props when given,
 * otherwise the per-chart defaults. A degenerate scale (empty data, or a
 * flat series where `max` would equal `min`) spans 1, so normalization never
 * divides by zero and every value maps to the bottom of the plot.
 */
export function chartScale(
  data: number[],
  min: number | undefined,
  max: number | undefined,
  minDefault: number,
): { min: number; max: number } {
  let lo = min ?? minDefault;
  let hi = max;
  if (hi === undefined) {
    hi = data.length > 0 ? Math.max(...data) : lo;
    if (!Number.isFinite(hi)) hi = lo;
  }
  if (!(hi > lo)) hi = lo + 1;
  return { min: lo, max: hi };
}

/**
 * Plot a straight line between two sub-cell coordinates onto a dot matrix
 * (Bresenham's integer line algorithm — the same raster the canvas element
 * uses, so a line chart paints through the braille rasterizer). Both
 * endpoints are plotted; sub-cells outside the matrix are ignored.
 */
export function plotLine(
  dots: string[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const width = dots[0]?.length ?? 0;
  const height = dots.length;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (x >= 0 && y >= 0 && x < width && y < height) {
      dots[y] = dots[y]!.slice(0, x) + "1" + dots[y]!.slice(x + 1);
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** The sub-cell dot matrix of a `brailleRows`-rasterizable canvas: `subRows`
 * sub-rows (4 per braille row), each `subCols` sub-columns (2 per braille
 * cell) wide, every sub-cell off. */
export function dotMatrix(subCols: number, subRows: number): string[] {
  return Array.from({ length: subRows }, () => "0".repeat(subCols));
}

