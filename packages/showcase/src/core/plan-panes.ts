//! The plan's non-editor chrome: the sidebar pane and the mode line, plus the
//! cell/index helpers the plan and the chrome share.
//!
//! WHY THIS IS NOT IN `plan.ts`. The sidebar's window/marker/truncation rules and
//! the mode line's packing are the plan's own decisions, but they are a seam of
//! their own; `plan.ts` was over its module budget (CONVENTION: 400 lines) and this
//! is the natural cut. The ONE-decision-point contract is untouched: `plan.ts`
//! still CUTS the screen (`buildPlan`), and every cell computed below is still
//! computed once, so a layer that re-derived a marker or a truncation would be the
//! second decision point the plan forbids.

import { wrapLineWithOffsets } from "@tern-tui/core";
import { cellWidth } from "./viewport.ts";
import type { ModeSegment, PlanItem, PlanSpan, SidebarInput, StyleHint } from "./plan.ts";

/** The narrowest editor the layout leaves beside a sidebar: a sidebar that would
 * take it below this is truncated instead — an editor narrower than a caret and a
 * few cells is not a text editor, while a narrow file list still is a file list. */
export const MIN_EDITOR_COLS = 8;

/** The marker an active sidebar item is painted with, in its own leading column. */
export const SIDEBAR_MARKER = "> ";

/** The marker the mode line shows while there are unsaved changes. */
export const DIRTY_MARKER = "●";

/** The visible sidebar items, from the clamped scroll: marker column plus label. */
export function sidebarItemRows(sidebar: SidebarInput, width: number, height: number, top: number): PlanItem[] {
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
export function sidebarScroll(sidebar: SidebarInput, height: number): number {
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
export function modeLineSegments(input: {
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
export function sidebarWidthFor(sidebar: SidebarInput | undefined, cols: number): number {
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
export function atLeastOne(value: number): number {
  const size = Math.trunc(value);
  return Number.isFinite(size) && size > 1 ? size : 1;
}

/** `value` as an integer index in `0..max` (NaN and negatives at 0). */
export function clamp(value: number, max: number): number {
  const index = Math.trunc(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  return index > max ? max : index;
}
