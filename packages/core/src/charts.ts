//! The BarChart, Chart and Sparkline elements.

import { CHART_AXIS_CHAR, CHART_BLOCK_GLYPHS, brailleRows, chartClamp, chartLeafProps, chartScale, dotMatrix, plotLine } from "./canvas.ts";
import { Node, Text } from "./node.ts";
import type { NodeProps } from "./types.ts";
/**
 * Props for the `BarChart` element. The series and the value scale are
 * consumed by the factory — they never reach the scene props (mirroring
 * `Canvas`' `dots`): only the bar row `Text` leaves (and the optional axis
 * leaf) reach the scene, and `width` stamps the root box's fixed width.
 */
export interface BarChartProps extends NodeProps {
  /** The bar values, one per bar, in display order (left to right). */
  data: number[];
  /** The chart's fixed width in cells (default: the natural bars width —
   * `data.length * bar_width + (data.length - 1) * gap`). Bars draw
   * left-aligned within it; the optional axis row spans it exactly. */
  width?: number;
  /** The chart height in cells (default 5). Each value scales into
   * `height` cells of eighth-block sub-heights (`8 * height` eighths per
   * bar), or `height` whole cells in `full_block` mode. */
  height?: number;
  /** The value scale minimum (default 0 — the baseline). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Cells per bar column (default 1). A wider bar repeats its glyph
   * `bar_width` times on every row. */
  bar_width?: number;
  /** Cells between adjacent bars (default 1). */
  gap?: number;
  /** Compose a `─` baseline axis row beneath the bars, spanning the fixed
   * width (default `false`). */
  show_axis?: boolean;
  /** Use whole-cell `█` columns instead of the eighth-block sub-cell
   * glyphs (default `false`). */
  full_block?: boolean;
}

/**
 * The per-bar sub-heights of a bar chart, in display order: each value
 * normalized onto the scale and quantized into `8 * height` eighths
 * (`full_block`: `height` whole cells) — the atom the row glyphs read.
 */
function barChartSubHeights(
  props: BarChartProps,
  scale: { min: number; max: number },
): number[] {
  const height = typeof props.height === "number"
    ? Math.max(1, Math.round(props.height))
    : 5;
  const fullBlock = props.full_block === true;
  return (props.data ?? []).map((value) => {
    const norm = chartClamp((value - scale.min) / (scale.max - scale.min));
    return fullBlock
      ? Math.round(norm * height)
      : Math.round(norm * 8 * height);
  });
}

/**
 * Create a `bar_chart` element: one column per value, painted bottom-up with
 * the eighth-block glyphs (▁▂▃▄▅▆▇█ — 8 sub-heights per cell) for sub-cell
 * bar heights, or whole-cell `█` columns with `full_block`. Every bar shares
 * the same baseline, and an optional `─` axis row (when `show_axis`) spans
 * the chart's fixed `width` beneath the bars. The series is composed as a
 * flex column `box` with one `Text` leaf per chart row (top to bottom) plus
 * the optional axis leaf — the same row-leaf materialization as `Canvas`.
 * No new napi node kind: the `bar_chart` element materializes as a `box`
 * (constitution).
 */
export function BarChart(props: BarChartProps): Node {
  const data = props.data ?? [];
  const height = typeof props.height === "number"
    ? Math.max(1, Math.round(props.height))
    : 5;
  const barWidth = typeof props.bar_width === "number"
    ? Math.max(1, Math.round(props.bar_width))
    : 1;
  const gap = typeof props.gap === "number"
    ? Math.max(0, Math.round(props.gap))
    : 1;
  const showAxis = props.show_axis === true;
  const scale = chartScale(data, props.min, props.max, 0);
  const barsWidth = data.length === 0
    ? 0
    : data.length * barWidth + (data.length - 1) * gap;
  const width = typeof props.width === "number"
    ? Math.max(1, Math.round(props.width))
    : Math.max(1, barsWidth);
  const subHeights = barChartSubHeights(props, scale);
  const fullBlock = props.full_block === true;

  // One Text leaf per chart row, top (row `height - 1`) to bottom (row 0):
  // a bar's glyph on row `r` is a full `█` when the bar reaches the row's
  // top, the partial eighth-block glyph when it reaches partway up the row,
  // or a space above the bar's top — so all bars share the bottom baseline.
  const leaves: Node[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let text = "";
    for (let i = 0; i < data.length; i++) {
      if (i > 0) text += " ".repeat(gap);
      const sub = subHeights[i]!;
      let glyph: string;
      if (fullBlock) {
        glyph = row < sub ? "█" : " ";
      } else if (sub >= 8 * (row + 1)) {
        glyph = "█";
      } else if (sub > 8 * row) {
        glyph = CHART_BLOCK_GLYPHS[sub - 8 * row - 1]!;
      } else {
        glyph = " ";
      }
      text += glyph.repeat(barWidth);
    }
    leaves.push(Text(chartLeafProps(props, { text })));
  }
  if (showAxis) {
    leaves.push(
      Text(chartLeafProps(props, { text: CHART_AXIS_CHAR.repeat(width) })),
    );
  }

  const rootProps: NodeProps = {
    ...props,
    flex_direction: "column",
    width,
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.data;
  delete plain.height;
  delete plain.min;
  delete plain.max;
  delete plain.bar_width;
  delete plain.gap;
  delete plain.show_axis;
  delete plain.full_block;
  return Node.create("bar_chart", rootProps, leaves);
}

/**
 * Props for the `Chart` element (a line chart). The series and the value
 * scale are consumed by the factory — they never reach the scene props:
 * only the braille row `Text` leaves (and the optional axis leaf) reach the
 * scene, and `width` stamps the root box's fixed width.
 */
export interface ChartProps extends NodeProps {
  /** The data points, in x order; the polyline through them is drawn. */
  data: number[];
  /** The chart's fixed width in cells (default
   * `max(2, ceil(data.length / 2))` — the minimum that gives every point
   * its own braille sub-column). */
  width?: number;
  /** The chart height in cells (default 5) — the braille rasterizer's
   * resolution is 4 sub-rows per cell. */
  height?: number;
  /** The value scale minimum (default `min(data)`). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Compose a `─` baseline axis row beneath the plot, spanning the fixed
   * width (default `false`). */
  show_axis?: boolean;
}

/**
 * Create a `chart` element: a polyline through the data points, rasterized
 * onto the canvas sub-cell dot matrix (the x-axis maps the point indices
 * across the full sub-cell width, the y-axis maps the value scale onto the
 * full sub-cell height) and rendered as Unicode braille via the canvas
 * rasterizer (`brailleRows` — the exact mirror of the Rust canvas
 * renderable). Consecutive points are connected with Bresenham lines. The
 * plot is composed as a flex column `box` with one `Text` leaf per braille
 * row plus the optional `─` axis leaf (when `show_axis`) spanning the fixed
 * `width`. No new napi node kind: the `chart` element materializes as a
 * `box` (constitution).
 */
export function Chart(props: ChartProps): Node {
  const data = props.data ?? [];
  const height = typeof props.height === "number"
    ? Math.max(1, Math.round(props.height))
    : 5;
  const width = typeof props.width === "number"
    ? Math.max(1, Math.round(props.width))
    : Math.max(2, Math.ceil(data.length / 2));
  const subCols = 2 * width;
  const subRows = 4 * height;
  const scale = chartScale(
    data,
    props.min,
    props.max,
    data.length > 0 ? Math.min(...data) : 0,
  );

  const dots = dotMatrix(subCols, subRows);
  if (data.length >= 2) {
    for (let i = 0; i < data.length - 1; i++) {
      const x0 = Math.round((i * (subCols - 1)) / (data.length - 1));
      const x1 = Math.round(((i + 1) * (subCols - 1)) / (data.length - 1));
      const y0 = subRows - 1 -
        Math.round(
          chartClamp((data[i]! - scale.min) / (scale.max - scale.min)) *
            (subRows - 1),
        );
      const y1 = subRows - 1 -
        Math.round(
          chartClamp((data[i + 1]! - scale.min) / (scale.max - scale.min)) *
            (subRows - 1),
        );
      plotLine(dots, x0, y0, x1, y1);
    }
  } else if (data.length === 1) {
    const y = subRows - 1 -
      Math.round(
        chartClamp((data[0]! - scale.min) / (scale.max - scale.min)) *
          (subRows - 1),
      );
    plotLine(dots, 0, y, 0, y);
  }

  const leaves = brailleRows(dots).map((row) =>
    Text(chartLeafProps(props, { text: row }))
  );
  if (props.show_axis === true) {
    leaves.push(
      Text(chartLeafProps(props, { text: CHART_AXIS_CHAR.repeat(width) })),
    );
  }

  const rootProps: NodeProps = {
    ...props,
    flex_direction: "column",
    width,
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.data;
  delete plain.height;
  delete plain.min;
  delete plain.max;
  delete plain.show_axis;
  return Node.create("chart", rootProps, leaves);
}

/**
 * Props for the `Sparkline` element. The series and the value scale are
 * consumed by the factory — they never reach the scene props: only the
 * glyph row `Text` leaves reach the scene, and `width` stamps the root
 * box's fixed width.
 */
export interface SparklineProps extends NodeProps {
  /** The data points, in x order; the last `width` points are shown. */
  data: number[];
  /** The sparkline's fixed width in cells (default `data.length` — the
   * full series; a longer series shows its last `width` points, a shorter
   * one is padded at the right). */
  width?: number;
  /** The sparkline height in cells (default 1). */
  height?: number;
  /** The value scale minimum (default `min(data)`). */
  min?: number;
  /** The value scale maximum (default `max(data)`). */
  max?: number;
  /** Rasterize the sparkline as Unicode braille via the canvas rasterizer
   * (default `false` — eighth-block glyphs). */
  use_braille?: boolean;
}

/**
 * Create a `sparkline` element: one glyph per value at the series' own
 * scale, anchored to the bottom baseline and shown at a fixed `width` (the
 * last `width` points; a shorter series pads at the right). Two glyph
 * families:
 *
 * - Eighth-block glyphs (the default): each point is an eighth-block
 *   glyph (▁..█) quantized onto `8 * height` sub-heights, stacked over
 *   `height` rows — the smallest value paints ▁ (never an empty hole).
 * - Braille (`use_braille`): each point is a dot in its own sub-column
 *   (two per braille cell) of the canvas sub-cell matrix, rasterized via
 *   `brailleRows` — the exact mirror of the Rust canvas renderable.
 *
 * Either way the element composes as a flex column `box` with one `Text`
 * leaf per row (Canvas-style). No new napi node kind: the `sparkline`
 * element materializes as a `box` (constitution).
 */
export function Sparkline(props: SparklineProps): Node {
  const data = props.data ?? [];
  const height = typeof props.height === "number"
    ? Math.max(1, Math.round(props.height))
    : 1;
  const width = typeof props.width === "number"
    ? Math.max(1, Math.round(props.width))
    : data.length;
  const scale = chartScale(
    data,
    props.min,
    props.max,
    data.length > 0 ? Math.min(...data) : 0,
  );
  const window = data.slice(Math.max(0, data.length - width));

  let leaves: Node[];
  if (props.use_braille === true) {
    // One dot per point in its own sub-column (2 per braille cell), placed
    // from the bottom sub-row — the braille baseline.
    const dots = dotMatrix(2 * width, 4 * height);
    window.forEach((value, i) => {
      const norm = chartClamp((value - scale.min) / (scale.max - scale.min));
      const y = 4 * height - 1 - Math.round(norm * (4 * height - 1));
      plotLine(dots, i, y, i, y);
    });
    leaves = brailleRows(dots).map((row) =>
      Text(chartLeafProps(props, { text: row }))
    );
  } else {
    // Eighth-block glyphs: each point quantized onto `8 * height`
    // sub-heights, clamped to at least 1 eighth so no point paints an
    // empty hole. One Text leaf per row, top to bottom.
    const subHeights = window.map((value) => {
      const norm = chartClamp((value - scale.min) / (scale.max - scale.min));
      return Math.min(8 * height, Math.max(1, Math.round(norm * 8 * height)));
    });
    leaves = [];
    for (let row = height - 1; row >= 0; row--) {
      let text = "";
      for (const sub of subHeights) {
        if (sub >= 8 * (row + 1)) text += "█";
        else if (sub > 8 * row) text += CHART_BLOCK_GLYPHS[sub - 8 * row - 1]!;
        else text += " ";
      }
      text += " ".repeat(Math.max(0, width - window.length));
      leaves.push(Text(chartLeafProps(props, { text })));
    }
  }

  const rootProps: NodeProps = {
    ...props,
    flex_direction: "column",
    width,
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.data;
  delete plain.height;
  delete plain.min;
  delete plain.max;
  delete plain.use_braille;
  return Node.create("sparkline", rootProps, leaves);
}

