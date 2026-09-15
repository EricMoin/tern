//! The Table element: virtualised rows, header, and cell layout.

import { Box, Node, Text } from "./node.ts";
import { maxScroll } from "./scrollview.ts";
import { clusterRuns } from "./textutil.ts";
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
/** One column of a `Table`: a `key`, the `header` label, a fixed cell
 * `width` in cells, and an optional `align` for the cell content (default
 * `"left"`). */
export interface TableColumn {
  /** The column's key (bookkeeping — identifies the column). */
  key: string;
  /** The header label painted in the header row. */
  header: string;
  /** The column's fixed width in cells. */
  width: number;
  /** The cell content alignment (default `"left"`). */
  align?: "left" | "right" | "center";
}

/** The state reported by {@link tableKey} after a routed key. */
export interface TableState {
  /** The highlighted data-row index (clamped into the rows). */
  highlight: number;
  /** The horizontal scroll offset in cells. */
  scroll_x: number;
  /** The vertical scroll offset in cells (data rows scrolled past). */
  scroll_y: number;
}

/**
 * Props for the `Table` element. `columns` / `rows` are consumed by the
 * factory (the model is JS bookkeeping — it never reaches the scene props,
 * mirroring `Panels` / `Select`); the remaining state/layout props flow to
 * the root box, which is a flex column of the header row and the scrollable
 * content region.
 */
export interface TableProps extends NodeProps {
  /** The columns, in display order (left to right). */
  columns: TableColumn[];
  /** The data rows, in display order (top to bottom); each row holds one
   *  cell per column (missing cells render blank). */
  rows: (string | number)[][];
  /** The horizontal scroll offset in cells (default 0) — pans the header
   *  row and the content region together, so columns stay aligned. */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0) — the number of data
   *  rows scrolled past inside the content region. The sticky header does
   *  not scroll with them. */
  scroll_y?: number;
  /** The highlighted data-row index (default 0) — its row renders reversed.
   *  {@link tableKey} moves it with up/down, clamping to the rows. */
  highlight?: number;
  /** Keep the header row pinned above the content region (default `true`);
   *  `false` moves the header into the scrollable region, so it scrolls
   *  away with the rows. */
  sticky_header?: boolean;
  /**
   * The content region's viewport height in rows (default unset — the whole
   * row list is the viewport). Drives {@link visibleTableRows} and the
   * scroll clamping in {@link tableKey}: the visible window is
   * `rows[scroll_y, scroll_y + clip_height)`.
   */
  clip_height?: number;
}

/** The sticky header's paint z-order (1). In-flow content stacks at z 0, so
 * the header — pinned above the content region — paints over data rows that
 * scroll up beneath it (compositor z-order, the same mechanism `Select`'s
 * `floating` overlay and the `ScrollView` scrollbar use). */
const TABLE_HEADER_Z_INDEX = 1;

/** The normalized column list of a table node (JS bookkeeping — never scene
 * props, mirroring `Select`'s `selectOptions`). */
const tableColumns = new WeakMap<Node, TableColumn[]>();

/** The normalized row list of a table node (JS bookkeeping — never scene
 * props). */
const tableRows = new WeakMap<Node, (string | number)[][]>();

/** The content region box of a table node (JS bookkeeping — the scrollable
 * sibling the sticky header is pinned above; its `scroll_y` / `clip_height`
 * props are the vertical viewport state, mirroring `ScrollView`'s
 * `scrollbarLeaves`). */
export const tableRegions = new WeakMap<Node, Node>();

/** The full-dataset bookkeeping of a table's content region (JS state —
 * never scene props, mirroring `Panels`' `panelBodies`): the owning table,
 * the total row count, and the full content width/height the scroll clamp
 * measures against. The region's scene children hold only the visible row
 * window, so its `Node.contentSize()` measures the window — never the
 * dataset. */
interface TableRegionState {
  /** The owning table node (the node `tableRegions` maps to this region). */
  table: Node;
  /** The total data-row count of the full dataset. */
  rowCount: number;
  /** The full content height in cells — one cell per data row (a row is a
   *  single-line flex row), so this equals `rowCount`; it is the quantity
   *  the vertical scroll clamp measures against. */
  contentHeight: number;
  /** The full content width in cells — the sum of the column widths. */
  contentWidth: number;
}

/** The windowed-table records of every table's content region. */
const tableRegionStates = new WeakMap<Node, TableRegionState>();

/** The display width of `text` in terminal columns — the sum of its grapheme
 * clusters' widths (a ZWJ emoji counts 2, never per code point). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const run of clusterRuns(text)) width += run.width;
  return width;
}

/** Truncate `text` to `width` display columns, never splitting a grapheme
 * cluster (a cluster that would straddle the boundary is dropped whole). */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const run of clusterRuns(text)) {
    if (run.width === 0) continue;
    if (used + run.width > width) break;
    out += run.text;
    used += run.width;
  }
  return out;
}

/** The padded cell text for `value` in a `width`-cell column: left-aligned
 * (default), right-aligned, or centered; content wider than the column is
 * truncated (never mid-glyph). The padded string's display width is exactly
 * `width`, so every column lines up across rows. */
function tableCellText(
  value: string | number,
  width: number,
  align?: "left" | "right" | "center",
): string {
  const text = String(value);
  const used = displayWidth(text);
  if (used >= width) return truncateToWidth(text, width);
  const pad = width - used;
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
  }
  return text + " ".repeat(pad);
}

/** One cell of a table: a `width`-pinned text leaf carrying the padded,
 * aligned content; `reversed` marks a cell of the highlighted row. The
 * `width` prop fixes the leaf's laid-out width, so the compositor trims any
 * residual overflow at the column edge (the same trim `wrap: false` lines
 * get). */
function tableCell(
  value: string | number,
  column: TableColumn,
  reversed: boolean,
): Node {
  return Text({
    text: tableCellText(value, column.width, column.align),
    width: column.width,
    reversed,
  });
}

/** One data row: a flex row of per-column cell leaves, one per column
 * (missing cells render blank). The highlighted row's cells are reversed. */
function buildTableRow(
  row: (string | number)[],
  columns: TableColumn[],
  highlighted: boolean,
): Node {
  return Box(
    { flex_direction: "row" },
    ...columns.map((column, index) =>
      tableCell(row[index] ?? "", column, highlighted)
    ),
  );
}

/** The header row: a flex row of per-column cell leaves carrying the column
 * labels. With a sticky header it carries the higher `z_index` so it paints
 * above data rows scrolling beneath it. */
function buildTableHeader(columns: TableColumn[], sticky: boolean): Node {
  const props: NodeProps = { flex_direction: "row" };
  if (sticky) props.z_index = TABLE_HEADER_Z_INDEX;
  return Box(
    props,
    ...columns.map((column) => tableCell(column.header, column, false)),
  );
}

/** The current vertical scroll of a table's content region (0 when unset). */
function tableScrollY(table: Node): number {
  const region = tableRegions.get(table);
  if (region === undefined) return 0;
  return typeof region.props.scroll_y === "number" ? region.props.scroll_y : 0;
}

/** The table's viewport height in rows: the `clip_height` prop, or the whole
 * row list when unset (nothing to clamp against — every row is "visible"). */
function tableViewport(table: Node): number {
  const props = table.props as TableProps;
  if (typeof props.clip_height === "number" && props.clip_height > 0) {
    return props.clip_height;
  }
  return (tableRows.get(table) ?? []).length;
}

/** The table region-state of `view`: its own record when `view` is a table's
 * content region, the region's record when it is a table root, `undefined`
 * for any other node. */
export function tableRegionState(view: Node): TableRegionState | undefined {
  const region = view.type === "table" ? tableRegions.get(view) : view;
  if (region === undefined) return undefined;
  return tableRegionStates.get(region);
}

/**
 * Re-window a table after its content region's scroll offset changed outside
 * {@link tableKey} — through {@link scrollTo} / {@link scrollBy} /
 * {@link scrollTop}, e.g. from {@link wheelScroll} — rebuilding the
 * materialized rows to `rows[scroll_y, scroll_y + clip_height)` at the new
 * offset. A no-op for non-table scroll views and for a table root whose
 * region is gone (nothing to re-window).
 */
export function refreshTableWindow(view: Node): void {
  const region = view.type === "table" ? tableRegions.get(view) : view;
  if (region === undefined) return;
  const state = tableRegionStates.get(region);
  if (state === undefined) return;
  rebuildTable(state.table);
}

/**
 * Rebuild a table node's children from its current props (the source of
 * truth, mirroring `Select`'s `rebuildSelect`): the header row — sticky when
 * `sticky_header` (a sibling above the content region, at the higher
 * `z_index`), otherwise the region's first child — plus one row leaf per
 * *visible* data row: the window `rows[scroll_y, scroll_y + clip_height)`,
 * so a large dataset does not materialize one scene node per row (the full
 * dataset stays JS bookkeeping in `tableRows`; the full content geometry is
 * recorded in `tableRegionStates` for the scroll clamp). The highlighted row
 * renders reversed. Runs at creation (seeding the content region with the
 * initial `scroll_y` prop), after every {@link tableKey} mutation, and after
 * any region scroll via {@link refreshTableWindow} (the region's own
 * `scroll_y` is re-stamped).
 */
function rebuildTable(table: Node, initialScrollY?: number): void {
  const props = table.props as TableProps;
  const columns = tableColumns.get(table) ?? [];
  const rows = tableRows.get(table) ?? [];
  const highlight = typeof props.highlight === "number" ? props.highlight : 0;
  const sticky = props.sticky_header ?? true;
  // The vertical viewport: the `clip_height` prop, or the whole dataset when
  // unset. The scroll offset is clamped into `[0, rows.length - viewport]` —
  // the same bound `maxScroll` derives from the JS-known full content height,
  // so an out-of-range initial offset cannot open an empty window.
  const viewport = Math.max(
    1,
    typeof props.clip_height === "number" && props.clip_height > 0
      ? props.clip_height
      : rows.length,
  );
  const scrollY = Math.max(
    0,
    Math.min(
      initialScrollY ?? tableScrollY(table),
      Math.max(0, rows.length - viewport),
    ),
  );

  for (const child of [...table.children]) child.remove();

  const header = buildTableHeader(columns, sticky);
  // Window the rows: materialize only `rows[scroll_y, scroll_y + viewport)`.
  const start = Math.floor(scrollY);
  const end = Math.min(rows.length, start + viewport);
  const rowNodes: Node[] = [];
  for (let i = start; i < end; i++) {
    rowNodes.push(buildTableRow(rows[i]!, columns, i === highlight));
  }
  const regionProps: NodeProps = {
    flex_direction: "column",
    scroll_y: scrollY,
  };
  if (typeof props.clip_height === "number") {
    regionProps.clip_height = props.clip_height;
  }

  let region: Node;
  if (sticky) {
    table.addChild(header);
    region = Node.create("box", regionProps, rowNodes);
    tableRegions.set(table, region);
    table.addChild(region);
  } else {
    region = Node.create("box", regionProps, [header, ...rowNodes]);
    tableRegions.set(table, region);
    table.addChild(region);
  }
  // Record the full-dataset geometry the scroll clamp measures against (the
  // region's scene content is only the window) — JS bookkeeping, never scene
  // props.
  tableRegionStates.set(region, {
    table,
    rowCount: rows.length,
    contentHeight: rows.length,
    contentWidth: columns.reduce((sum, column) => sum + column.width, 0),
  });
}

/**
 * Create a `table` element: a flex column of box/text leaves — a header row
 * (sticky by default, painted above the content region at the higher
 * `z_index`; `sticky_header: false` moves it into the scrollable region) and
 * one row leaf per *visible* data row — the window
 * `rows[scroll_y, scroll_y + clip_height)` — with per-column
 * width/alignment (each cell's text padded to the column width,
 * right/center-aligned as declared, overflow truncated never mid-glyph; the
 * highlighted row reversed). Only the window is materialized, so a large
 * dataset does not create one scene node per row; the full dataset stays JS
 * bookkeeping (never scene props) and the scroll clamp measures the full
 * content height through `tableRegionStates`. The interactive state
 * (`highlight`, `scroll_x`, `scroll_y`) lives on the node props. The
 * `scroll_x` prop on the root pans header + rows together (columns stay
 * aligned); `scroll_y` pans only the content region, so the sticky header
 * does not scroll. Drive it with {@link tableKey}; read the visible window
 * with {@link visibleTableRows}. No new napi node kind: the `table` element
 * materializes as a `box` (constitution).
 */
export function Table(props: TableProps): Node {
  const columns = props.columns.map((column) => ({ ...column }));
  const rows = props.rows.map((row) => [...row]);
  const rootProps: NodeProps = {
    ...props,
    highlight: props.highlight ?? 0,
    scroll_x: props.scroll_x ?? 0,
    sticky_header: props.sticky_header ?? true,
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.columns;
  delete plain.rows;
  delete plain.scroll_y;
  const table = Node.create("table", rootProps, []);
  tableColumns.set(table, columns);
  tableRows.set(table, rows);
  rebuildTable(table, props.scroll_y);
  return table;
}

/**
 * The data rows of a table currently inside its vertical viewport: the row
 * slice `rows[scroll_y, scroll_y + clip_height)` (the whole remaining list
 * when `clip_height` is unset), in scene order. The window the content
 * region's scroll offset exposes below the sticky header.
 */
export function visibleTableRows(table: Node): (string | number)[][] {
  const rows = tableRows.get(table) ?? [];
  const scrollY = tableScrollY(table);
  const viewport = tableViewport(table);
  return rows.slice(scrollY, scrollY + Math.max(1, viewport));
}

/**
 * Apply a key to a table node, mutating its state and rebuilding the
 * composition in place — the Table counterpart of {@link selectKey}.
 *
 * - `up` / `down` move the highlight within the rows (clamped at the ends),
 *   auto-scrolling the content region so the highlighted row stays inside
 *   the visible window (`scroll_y` is clamped to `[0, rows.length -
 *   viewport]`, where the viewport is `clip_height` or the whole list).
 *
 * Returns the new state; any other key leaves the table unchanged.
 */
export function tableKey(table: Node, event: KeyEvent): TableState {
  const props = table.props as TableProps;
  const rows = tableRows.get(table) ?? [];
  const highlight = typeof props.highlight === "number" ? props.highlight : 0;
  const scrollX = typeof props.scroll_x === "number" ? props.scroll_x : 0;
  const scrollY = tableScrollY(table);
  const viewport = Math.max(1, tableViewport(table));
  const maxScroll = Math.max(0, rows.length - viewport);

  let nextHighlight = highlight;
  if (event.name === "up") {
    nextHighlight = Math.max(0, highlight - 1);
  } else if (event.name === "down") {
    nextHighlight = Math.min(Math.max(0, rows.length - 1), highlight + 1);
  }

  // Auto-scroll: keep the highlighted row inside the visible window, then
  // clamp the offset to the content bounds (a table whose rows fit its
  // viewport cannot scroll).
  let nextScrollY = scrollY;
  if (nextHighlight < nextScrollY) nextScrollY = nextHighlight;
  if (nextHighlight > nextScrollY + viewport - 1) {
    nextScrollY = nextHighlight - viewport + 1;
  }
  nextScrollY = Math.max(0, Math.min(nextScrollY, maxScroll));

  const state: TableState = {
    highlight: nextHighlight,
    scroll_x: scrollX,
    scroll_y: nextScrollY,
  };
  const changed = state.highlight !== highlight || state.scroll_y !== scrollY;
  if (changed) {
    table.setProps({ ...props, highlight: state.highlight });
    const region = tableRegions.get(table);
    if (region !== undefined) {
      region.setProps({ ...region.props, scroll_y: state.scroll_y });
    }
    rebuildTable(table);
  }
  return state;
}

