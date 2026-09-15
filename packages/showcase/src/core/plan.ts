//! The screen plan: the ONE decision point for what is on screen.
//
// Everything here is plain data — regions, rows, spans, the cursor cell, style
// hints, mode-line segments, sidebar items — and the module imports no scene
// type, no renderer and no terminal: the app-core decides ONCE what the screen
// shows, and each renderer layer is only a pure ScreenPlan-to-scene emitter. A
// layer that re-derives a row, a column or a truncation is a second decision
// point, and two decision points is how three renderers drift apart.
//
// The document side of the plan is the viewport window ({@link computeViewport}),
// so the plan lays that window out in screen cells and never walks the document;
// the chrome around it is a function of the screen size and of the caller's own
// lists, never of the file.

import { wrapLineWithOffsets } from "@tern-tui/core";
import type { Buffer, Position } from "./buffer.ts";
import type { LineIndex } from "./lineindex.ts";
import { buildEditorRows, gutterWidthFor } from "./plan-editor.ts";
import { buildModalRegion, type ModalInput, type ModalRegion } from "./plan-modals.ts";

// The overlay vocabulary ships with the plan: a consumer of ScreenPlan narrows a
// region to ModalRegion without reaching past plan.ts for the type.
export type { ModalField, ModalInput, ModalItem, ModalRegion, ModalRow } from "./plan-modals.ts";
import type { WrapCache } from "./wrapcache.ts";
import {
  cellWidth,
  computeViewport,
  DEFAULT_OVERSCAN,
  FILLER_LINE,
  type ViewportRow,
  type ViewportSize,
  type ViewportStats,
} from "./viewport.ts";

/** The narrowest editor the layout leaves beside a sidebar: a sidebar that would
 * take it below this is truncated instead — an editor narrower than a caret and a
 * few cells is not a text editor, while a narrow file list still is a file list. */
export const MIN_EDITOR_COLS = 8;

/** The marker an active sidebar item is painted with, in its own leading column. */
export const SIDEBAR_MARKER = "> ";

/** The marker the mode line shows while there are unsaved changes. */
export const DIRTY_MARKER = "●";

/** The title of a document that has none. */
export const NO_TITLE = "[No Name]";

/** What a run of text IS, so an emitter can style it without knowing anything
 * about the layout. Hints name a semantic role, never a colour, a weight or a
 * terminal attribute — the theme owns those. */
export type StyleHint =
  | "text" | "sidebar-item" | "sidebar-active" | "sidebar-marker"
  | "mode" | "path" | "dirty" | "position" | "count"
  // The modal overlay's own parts: its frame, its title, a field's label, a
  // field's text, a listed row and the footer line (plan-modals.ts).
  | "modal-frame" | "modal-title" | "modal-label" | "modal-field" | "modal-item" | "modal-status";

/** A styled run of text. `x` and `width` are cells from the left edge of the
 * region the span belongs to, so an emitter adds its region's origin once. */
export interface PlanSpan {
  text: string;
  hint: StyleHint;
  x: number;
  width: number;
}

/** One cell row of the editor: the display row of the line it shows, the run to
 * paint, and whether the hardware cursor is on it. `row` AND `screenRow` are
 * REGION-LOCAL — every consumer places a row at `region.y + row.screenRow`
 * (layers/core/frame.ts:89, parity/mount_paint_test.ts:277), and the editor's
 * region starts at row 0, which is what hid the mismatch until the overlay (whose
 * y != 0) followed the consumers. `line` is {@link FILLER_LINE} below the end of
 * the document, and a filler row's `spans` is empty. */
export interface PlanRow {
  row: number;
  screenRow: number;
  line: number;
  offset: number;
  spans: PlanSpan[];
  width: number;
  cursor: boolean;
}

/** One row of the sidebar: an item from the caller's list, windowed into the pane
 * and reduced to what fits. `spans` holds the marker (active only) and the label. */
export interface PlanItem {
  index: number;
  row: number;
  screenRow: number;
  spans: PlanSpan[];
  width: number;
  active: boolean;
}

/** One segment of the mode line, placed in cells: left segments run from the left
 * edge, right segments against the right edge, so an emitter does no arithmetic. */
export interface ModeSegment {
  text: string;
  hint: StyleHint;
  x: number;
  width: number;
  align: "left" | "right";
}

/** The document window: the rows the viewport computed, in screen cells. Every
 * region carries its rectangle as `x`, `y`, `width` and `height` cells;
 * `firstRow` is the absolute display row of `rows[0]` (the clamped scroll) and
 * `totalRows` what the index knew when the window was computed. */
export interface EditorRegion {
  kind: "editor";
  x: number; y: number; width: number; height: number;
  rows: PlanRow[];
  firstRow: number;
  totalRows: number;
  /** The rows at the TOP of {@link rows} that hold the tab strip, region-local.
   * Absent (0) when the screen has a single buffer. The document window is the
   * remaining `height - headerRows` rows. */
  headerRows?: number;
  /** The cells the line-number gutter takes at the left of every document row.
   * Absent (0) when the gutter is off. */
  gutterWidth?: number;
}

/** The file list, when the screen is wide enough for one. `scroll` is the first
 * visible item's index; `count` how many the caller offered, visible or not. */
export interface SidebarRegion {
  kind: "sidebar";
  x: number; y: number; width: number; height: number;
  items: PlanItem[];
  scroll: number;
  count: number;
}

/** The status line: one cell row across the WHOLE screen, segments placed. */
export interface ModeRegion {
  kind: "mode";
  x: number; y: number; width: number; height: 1;
  segments: ModeSegment[];
}

export type PlanRegion = EditorRegion | SidebarRegion | ModeRegion | ModalRegion;

/** Where the cursor goes, in screen cells, and the document position it stands
 * for. `visible` is false when the editor is unfocused or the cell is off-screen. */
export interface PlanCursor {
  row: number;
  col: number;
  visible: boolean;
  position: Position;
}

/** The caller's sidebar: the items, the width asked for in cells (`0` hides the
 * pane), the item the user is on (`-1`/`undefined` for none) and the first item
 * to show. An out-of-range index clamps; a negative one means no item. `scroll`
 * is a REQUEST: it is clamped into the list and then moved, if need be, so the
 * active item stays inside the visible window (see `sidebarScroll`). */
export interface SidebarInput {
  items: readonly string[];
  width: number;
  active?: number;
  scroll?: number;
}

/** The tab strip's content: one label per open buffer, the active one, and which
 * are dirty. The plan owns the strip's cells; this is the caller's content only. */
export interface TabsInput {
  readonly labels: readonly string[];
  readonly active: number;
  /** Per-label dirty bits, aligned with `labels`. */
  readonly dirty?: readonly boolean[];
}

/** Which pane the keyboard is on. The cursor cell belongs to the focused pane,
 * so a sidebar focus hides it rather than leaving it on the document. */
export type PlanFocus = "editor" | "sidebar";

/** Everything the screen is a function of. `size` is the WHOLE screen: the mode
 * line and the sidebar are taken out of it. `scroll`, `caret` and the sidebar's
 * indices are clamped, so a stale position is a normal editor condition. */
export interface PlanInput {
  buffer: Buffer;
  index: LineIndex;
  /** The rows of the lines the editor region covers; its width is set from the
   * editor region's here (see {@link buildPlan}). */
  cache: WrapCache;
  size: ViewportSize;
  scroll: number;
  caret: Position;
  /** The document's display name, {@link NO_TITLE} when omitted; the mode label
   * defaults to `"EDIT"`. */
  title?: string;
  mode?: string;
  sidebar?: SidebarInput;
  focus?: PlanFocus;
  /** The editor window's total overscan rows (default {@link DEFAULT_OVERSCAN}). */
  overscan?: number;
  /** Whether the last cell row is reserved for the mode line (default true; a
   * one-row screen never has one). */
  modeLine?: boolean;
  /** The tab strip (plan-editor.ts); absent when the screen has one buffer. */
  tabs?: TabsInput;
  /** Whether the editor paints its line-number gutter (default false). */
  gutter?: boolean;
  /** Whether the editor soft-wraps long lines (default true). `false` normalizes
   * the wrap width to "no wrap" through the SAME `WrapCache`/`computeViewport`
   * path, so there is no second wrap rule. */
  wrap?: boolean;
  /** The modal overlay on top of the body, when one is open (plan-modals.ts).
   * The plan lays it out last, so it paints over the panes it covers. */
  modal?: ModalInput;
}

/** What building the plan cost, measured rather than asserted: the editor
 * window's own stats (the document walk this plan caused), the sidebar items laid
 * out (bounded by the pane's height) and the mode-line segments placed. */
export interface PlanStats {
  editor: ViewportStats;
  sidebarItems: number;
  modeSegments: number;
  /** The overlay's rows, 0 when no modal is open. */
  modalRows: number;
}

/** The whole screen, decided: what to paint, where the cursor goes, and what it
 * cost. `regions` is in paint order; `cursor` is null when the focused pane has
 * none (a sidebar focus); `dirty` is the document's unsaved-changes bit. */
export interface ScreenPlan {
  size: { rows: number; cols: number };
  regions: PlanRegion[];
  cursor: PlanCursor | null;
  focus: PlanFocus;
  dirty: boolean;
  stats: PlanStats;
}

/**
 * Build the screen plan for one frame.
 *
 * The screen is cut in three, in this order: the mode line takes the LAST cell
 * row when it is enabled and the screen is at least two rows tall; the sidebar
 * takes its columns off the LEFT when the caller offers items and a width that
 * leaves the editor at least {@link MIN_EDITOR_COLS}; the editor takes what is
 * left and is the only region with document rows. Both decisions live here
 * because "how wide is the text column" is also the editor's wrap width.
 *
 * A modal overlay ({@link PlanInput.modal}) is laid out after the panes and
 * before the mode line, INSIDE the body: it is the one region whose rectangle
 * overlaps another's, and it is last among the regions it covers because
 * `regions` is in paint order. Its own layout — the frame, the key column, the
 * field caret — is `plan-modals.ts`'s; this function only gives it the body it
 * is centered in and records what it cost.
 *
 * The editor's rows come from {@link computeViewport} on the editor rectangle,
 * re-expressed in screen cells: already in screen order, exactly `height` of
 * them, filler-padded, so an emitter paints row `i` without mapping anything.
 * Sidebar items and mode-line segments are laid out from the caller's own data,
 * bounded by the pane's height and the mode line's width, and truncated with the
 * framework's own first display row. What does not fit is dropped, not squeezed:
 * the plan says what is on screen, and an emitter never decides.
 */
export function buildPlan(input: PlanInput): ScreenPlan {
  const screenRows = atLeastOne(input.size.rows);
  const screenCols = atLeastOne(input.size.cols);
  const modeHeight = (input.modeLine ?? true) && screenRows >= 2 ? 1 : 0;
  const bodyHeight = screenRows - modeHeight;
  const sidebar = input.sidebar;
  const sidebarWidth = sidebarWidthFor(sidebar, screenCols);
  const editorWidth = screenCols - sidebarWidth;
  const focus: PlanFocus = input.focus ?? "editor";

  // The tab strip is the editor region's OWN header (plan-editor.ts), so it does
  // not become a fourth band a layer has to learn; the gutter is a leading span of
  // each document row for the same reason. Both are plan decisions.
  const headerRows = input.tabs !== undefined && bodyHeight >= 2 ? 1 : 0;
  const gutterWidth = input.gutter === true ? gutterWidthFor(input.buffer.lineCount) : 0;
  const view = computeViewport({
    buffer: input.buffer, index: input.index, cache: input.cache,
    size: { rows: bodyHeight - headerRows, cols: Math.max(1, editorWidth - gutterWidth) },
    scroll: input.scroll, caret: input.caret,
    overscan: input.overscan ?? DEFAULT_OVERSCAN,
    wrap: input.wrap !== false,
  });

  const cursorWindowRow = focus === "editor" ? view.cursor.row : -1;
  const built = buildEditorRows(view.rows, {
    width: editorWidth,
    cursorRow: cursorWindowRow,
    gutterWidth,
    ...(input.tabs === undefined ? {} : { tabs: input.tabs }),
  });
  const editor: EditorRegion = {
    kind: "editor", x: sidebarWidth, y: 0, width: editorWidth, height: bodyHeight,
    rows: built.rows, firstRow: view.firstRow, totalRows: view.totalRows,
    ...(built.headerRows === 0 ? {} : { headerRows: built.headerRows }),
    ...(gutterWidth === 0 ? {} : { gutterWidth }),
  };

  const regions: PlanRegion[] = [];
  let sidebarItems = 0;
  if (sidebarWidth > 0 && sidebar !== undefined) {
    const top = sidebarScroll(sidebar, bodyHeight);
    const items = sidebarItemRows(sidebar, sidebarWidth, bodyHeight, top);
    sidebarItems = items.length;
    regions.push({
      kind: "sidebar", x: 0, y: 0, width: sidebarWidth, height: bodyHeight,
      items, scroll: top, count: sidebar.items.length,
    });
  }
  regions.push(editor);

  const caretLine = clamp(input.caret.row, input.buffer.lineCount - 1);
  const caretCol = clamp(input.caret.col, input.buffer.lineAt(caretLine).length);
  let modeSegments = 0;
  let modalRows = 0;
  if (input.modal !== undefined) {
    // The overlay paints over the panes it covers, so its region comes AFTER them
    // in paint order and its rectangle is inside the body those two lines cut out —
    // an overlay is not a band and does not tile beside anything. (The mode line
    // still follows: it is chrome on a row of its own, and the overlay's area is
    // the body.)
    const modal = buildModalRegion(input.modal, { rows: bodyHeight, cols: screenCols });
    modalRows = modal.rows.length;
    regions.push(modal);
  }
  if (modeHeight === 1) {
    const segments = modeLineSegments({
      width: screenCols, mode: input.mode ?? "EDIT", title: input.title ?? NO_TITLE,
      dirty: input.buffer.dirty, line: caretLine + 1, col: caretCol + 1, lines: input.buffer.lineCount,
    });
    modeSegments = segments.length;
    regions.push({ kind: "mode", x: 0, y: screenRows - modeHeight, width: screenCols, height: 1, segments });
  }

  // The cursor cell: the viewport's own cell, moved into screen cells by its
  // region's origin. A column one past the editor's last cell (a caret at the
  // end of a full row) is off the screen, and says so.
  const cursor: PlanCursor | null = focus === "sidebar" ? null : {
    row: editor.y + headerRows + view.cursor.row,
    col: editor.x + gutterWidth + view.cursor.col,
    visible: view.cursor.visible && editor.x + gutterWidth + view.cursor.col < screenCols,
    position: { row: caretLine, col: caretCol },
  };

  return {
    size: { rows: screenRows, cols: screenCols },
    regions,
    cursor,
    focus,
    dirty: input.buffer.dirty,
    stats: { editor: view.stats, sidebarItems, modeSegments, modalRows },
  };
}

/** The visible sidebar items, from the clamped scroll: marker column plus label. */
function sidebarItemRows(sidebar: SidebarInput, width: number, height: number, top: number): PlanItem[] {
  const items: PlanItem[] = [];
  const active = activeIndex(sidebar.active, sidebar.items.length);
  for (let row = 0; row < height && top + row < sidebar.items.length; row += 1) {
    const index = top + row;
    const isActive = index === active;
    const marker = isActive ? SIDEBAR_MARKER : "";
    const markerWidth = cellWidth(marker);
    const label = fit(sidebar.items[index] ?? "", width - markerWidth);
    const labelWidth = cellWidth(label);
    const spans: PlanSpan[] = [];
    if (isActive) spans.push({ text: marker, hint: "sidebar-marker", x: 0, width: markerWidth });
    spans.push({ text: label, hint: isActive ? "sidebar-active" : "sidebar-item", x: markerWidth, width: labelWidth });
    items.push({ index, row, screenRow: row, spans, width: markerWidth + labelWidth, active: isActive });
  }
  return items;
}

/** The item the caller marked active, or `-1` for none. An omitted, negative or
 * non-finite index means NO item — {@link clamp} would otherwise turn `-1` into
 * index 0 and mark the first item active on every screen with no cursor in the
 * list. An index past the end clamps to the last item. */
function activeIndex(active: number | undefined, count: number): number {
  if (active === undefined) return -1;
  const index = Math.trunc(active);
  if (!Number.isFinite(index) || index < 0) return -1;
  return clamp(index, count - 1);
}

/**
 * The sidebar's first visible item: the caller's scroll, clamped to the last full
 * window, then MOVED so the active item is inside that window.
 *
 * The reconciliation is what keeps an item marked. {@link sidebarItemRows} marks
 * an item by the row it paints, so a window that does not contain the active
 * index has no row to carry the marker and paints a list with no cursor in it at
 * all. The window is the plan's own decision to make: the pane's height is known
 * here and nowhere else (`bodyHeight` above), so `plan.ts` corrects a window the
 * caller's cells cannot express — a stale scroll, an `active` set
 * programmatically, a pane that shrank — exactly as it clamps the editor's scroll.
 *
 * A window that ALREADY contains the active item is returned untouched, so the
 * caller's cells are honored whenever they are not broken.
 */
function sidebarScroll(sidebar: SidebarInput, height: number): number {
  const last = Math.max(0, sidebar.items.length - height);
  const top = clamp(sidebar.scroll ?? 0, last);
  const active = activeIndex(sidebar.active, sidebar.items.length);
  if (active < 0 || (active >= top && active < top + height)) return top;
  return clamp(active < top ? active : active - height + 1, last);
}

/** The mode line's segments: the left group (mode, title, dirty marker) from the
 * left edge, the right group (line count, caret position) against the right edge.
 * A left segment that does not fit is truncated and ends the group; a right one
 * that does not fit is dropped — the position indicator is rightmost, so it
 * survives the narrowest screen. */
function modeLineSegments(input: {
  width: number; mode: string; title: string; dirty: boolean; line: number; col: number; lines: number;
}): ModeSegment[] {
  const right: Array<{ text: string; hint: StyleHint }> = [
    { text: ` ${input.lines}L `, hint: "count" },
    { text: ` ${input.line}:${input.col}`, hint: "position" },
  ];
  const rightPlaced: ModeSegment[] = [];
  let edge = input.width;
  for (let i = right.length - 1; i >= 0; i -= 1) {
    const segment = right[i]!;
    const width = cellWidth(segment.text);
    if (width > edge) break;
    edge -= width;
    rightPlaced.unshift({ text: segment.text, hint: segment.hint, x: edge, width, align: "right" });
  }

  const left: Array<{ text: string; hint: StyleHint }> = [
    { text: ` ${input.mode} `, hint: "mode" },
    { text: ` ${input.title} `, hint: "path" },
  ];
  if (input.dirty) left.push({ text: ` ${DIRTY_MARKER} `, hint: "dirty" });
  const leftPlaced: ModeSegment[] = [];
  let x = 0;
  for (const segment of left) {
    const room = edge - x;
    if (room <= 0) break;
    const text = cellWidth(segment.text) <= room ? segment.text : fit(segment.text, room);
    const width = cellWidth(text);
    if (width === 0) break;
    leftPlaced.push({ text, hint: segment.hint, x, width, align: "left" });
    x += width;
  }
  return [...leftPlaced, ...rightPlaced];
}

/** The columns the sidebar gets: what was asked for, clamped into the screen and
 * never past the editor's {@link MIN_EDITOR_COLS}. Zero hides the pane — as does
 * offering no items. */
function sidebarWidthFor(sidebar: SidebarInput | undefined, cols: number): number {
  if (sidebar === undefined || sidebar.items.length === 0) return 0;
  return Math.min(clamp(sidebar.width, cols), Math.max(0, cols - MIN_EDITOR_COLS));
}

/** The longest prefix of `text` that fits in `width` cells: the first display
 * row of the framework's own wrapper, so nothing is cut mid-glyph and a truncated
 * label breaks exactly where the compositor would break it (at a word boundary
 * when the text has one). */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return wrapLineWithOffsets(text, width)[0]?.text ?? "";
}

/** `value` as at least one cell: a zero-height screen is a caller bug to survive. */
function atLeastOne(value: number): number {
  const size = Math.trunc(value);
  return Number.isFinite(size) && size > 1 ? size : 1;
}

/** `value` as an integer index in `0..max` (NaN and negatives at 0). */
function clamp(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}
