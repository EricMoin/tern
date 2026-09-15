//! The editor region's rows: the document window, an optional tab strip above it
//! and an optional line-number gutter beside it.
//
// WHY THIS IS NOT IN `plan.ts`. The editor region is the one region a renderer
// paints row by row, and "what a row of the editor IS" — a number column, the
// wrapped run, the tab strip's cells — is a seam of its own. `plan.ts` stays the
// place that CUTS the screen and hands this module a window; every cell below is
// still the plan's decision, computed once, so a layer that re-derived a gutter
// width would be the second decision point `plan.ts` forbids.
//
// THE TAB STRIP SHARES THE EDITOR REGION. It is the region's first
// `headerRows` rows rather than a fourth band, so no layer learns a new region
// kind and the strip cannot drift from the pane it heads. A document row's gutter
// is a leading span of the SAME row, likewise no new region.

import { wrapLineWithOffsets } from "@tern-tui/core";
import type { PlanRow, PlanSpan, TabsInput } from "./plan.ts";
import { cellWidth, FILLER_LINE, type ViewportRow } from "./viewport.ts";

/** The cells the line-number gutter takes: the widest line number plus two
 * spaces (one either side), so a number never touches the text. */
export function gutterWidthFor(lineCount: number): number {
  const digits = String(Math.max(1, Math.trunc(lineCount))).length;
  return digits + 2;
}

/** What the editor region's rows carry besides the document window. */
export interface EditorRowOptions {
  /** The region's width in cells — the tab strip is truncated to it. */
  readonly width: number;
  /** The display row of the window the caret is on, or -1 (unfocused/off-window). */
  readonly cursorRow: number;
  /** The gutter's width in cells, 0 when it is off. */
  readonly gutterWidth: number;
  readonly tabs?: TabsInput;
}

/** The editor region's rows, in paint order: the tab strip (if any) then the
 * document window, each already the runs a layer writes. */
export function buildEditorRows(
  window: readonly ViewportRow[],
  options: EditorRowOptions,
): { rows: PlanRow[]; headerRows: number } {
  const headerRows = options.tabs === undefined ? 0 : 1;
  const rows: PlanRow[] = [];
  if (headerRows === 1 && options.tabs !== undefined) {
    rows.push(...tabRows(options.tabs, options.width));
  }
  // The document rows are placed BELOW the strip: a region-local `screenRow` is
  // what a consumer adds the region's origin to, so the tab row and the first
  // document row cannot both sit at 0 — the later write would hide the strip.
  for (const row of window) rows.push(documentRow(row, options, headerRows));
  return { rows, headerRows };
}

/** The tab strip's single row: one span per label, the active one bracketed, the
 * dirty ones marked. Truncated to the region's width with the framework's own
 * wrapper, exactly as the sidebar's labels are (plan-panes.ts). */
function tabRows(tabs: TabsInput, width: number): PlanRow[] {
  const spans: PlanSpan[] = [];
  let x = 0;
  for (let index = 0; index < tabs.labels.length && x < width; index += 1) {
    const active = index === tabs.active;
    const dirty = tabs.dirty?.[index] === true;
    const label = tabs.labels[index] ?? "";
    const text = (active ? "[" : " ") + label + (dirty ? " ●" : "") + (active ? "]" : " ");
    if (text === "") continue;
    const room = width - x;
    const placed = cellWidth(text) <= room ? text : fit(text, room);
    const placedWidth = cellWidth(placed);
    if (placedWidth === 0) break;
    spans.push({ text: placed, hint: active ? "sidebar-active" : "sidebar-item", x, width: placedWidth });
    x += placedWidth;
  }
  return [{ row: 0, screenRow: 0, line: FILLER_LINE, offset: 0, spans, width: x, cursor: false }];
}

/** One cell row of the document window: the optional gutter number, the wrapped
 * run, and the cursor mark. A filler row past the document's end paints nothing. */
function documentRow(row: ViewportRow, options: EditorRowOptions, headerRows: number): PlanRow {
  const spans: PlanSpan[] = [];
  if (row.line !== FILLER_LINE && options.gutterWidth > 0) {
    const text = String(row.line + 1).padStart(options.gutterWidth - 2) + "  ";
    spans.push({ text, hint: "count", x: 0, width: cellWidth(text) });
  }
  if (row.line !== FILLER_LINE) {
    spans.push({ text: row.text, hint: "text", x: options.gutterWidth, width: row.width });
  }
  const screenRow = headerRows + row.screenRow;
  return {
    row: screenRow,
    screenRow,
    line: row.line,
    offset: row.offset,
    spans,
    width: options.gutterWidth + row.width,
    cursor: row.screenRow === options.cursorRow,
  };
}

/** The longest prefix of `text` that fits in `cells` — the same measure
 * `plan.ts` uses for its labels, so nothing is cut mid-glyph. */
function fit(text: string, cells: number): string {
  if (cells <= 0) return "";
  return wrapLineWithOffsets(text, cells)[0]?.text ?? "";
}
