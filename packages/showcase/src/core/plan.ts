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

import type { Buffer, Position } from "./buffer.ts";
import type { LineIndex } from "./lineindex.ts";
import { buildEditorRows, gutterWidthFor } from "./plan-editor.ts";
import { buildModalRegion, type ModalInput, type ModalRegion } from "./plan-modals.ts";
import { atLeastOne, clamp, modeLineSegments, sidebarItemRows, sidebarScroll, sidebarWidthFor } from "./plan-panes.ts";

// The overlay vocabulary ships with the plan: a consumer of ScreenPlan narrows a
// region to ModalRegion without reaching past plan.ts for the type.
export type { ModalField, ModalInput, ModalItem, ModalRegion, ModalRow } from "./plan-modals.ts";
// The sidebar and mode-line chrome moved to plan-panes.ts; re-exported so every
// consumer keeps importing these from plan.ts.
export { DIRTY_MARKER, MIN_EDITOR_COLS, SIDEBAR_MARKER } from "./plan-panes.ts";
import type { WrapCache } from "./wrapcache.ts";
import {
  computeViewport,
  DEFAULT_OVERSCAN,
  FILLER_LINE,
  type ViewportRow,
  type ViewportSize,
  type ViewportStats,
} from "./viewport.ts";

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
