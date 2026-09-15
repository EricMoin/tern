//! Pointer resolution: the screen cell a layer handed over, read against the plan.
//
// THE PLAN IS THE ONE DECISION POINT FOR LAYOUT (plan.ts:1-13), so a pointer event
// must be resolved against the plan's own regions and never against a rectangle a
// layer re-derived. Which pane a cell is in, which file-list item it names and
// where in the document the caret goes is decided HERE and nowhere else; `state.ts`
// only applies the answer. `commands.ts`'s single decision point is about what a
// key MEANS; this one is about what a CELL names.
//
// It lives beside `state.ts` rather than inside it for the module-budget reason the
// split documents: the geometry is a pure function of (plan, cell, document
// geometry), so it needs none of the app's mutable slots.

import type { Position } from "./buffer.ts";
import type { EditorRegion, ModalRegion, PlanRegion, ScreenPlan, SidebarRegion } from "./plan.ts";
import { positionAtDisplay, type MotionContext } from "./motions.ts";

/** The plan's editor region — the only region with document rows. */
export function editorOf(plan: ScreenPlan): EditorRegion | null {
  return plan.regions.find((region) => region.kind === "editor") as EditorRegion ?? null;
}

/** The plan's file-list region, or null when the screen has no pane. */
export function sidebarOf(plan: ScreenPlan): SidebarRegion | null {
  return plan.regions.find((region) => region.kind === "sidebar") as SidebarRegion ?? null;
}

/** The plan's modal overlay, or null when no modal is open. */
export function modalOf(plan: ScreenPlan): ModalRegion | null {
  return plan.regions.find((region) => region.kind === "modal") as ModalRegion ?? null;
}

/** Whether `cell` is one of `region`'s cells, in screen coordinates. The one
 * geometric question a pointer event asks the plan. */
export function holds(region: PlanRegion, cell: Position): boolean {
  return cell.row >= region.y && cell.row < region.y + region.height &&
    cell.col >= region.x && cell.col < region.x + region.width;
}

/** What a screen cell names: which pane it is in, and — in the editor — the
 * document position it lands on. `index` is -1 when the file-list cell names no
 * item. */
export type PointerTarget =
  | { readonly pane: "modal" }
  | { readonly pane: "sidebar"; readonly index: number }
  | { readonly pane: "editor"; readonly position: Position };

/**
 * Resolve one pointer cell against `plan`.
 *
 * The OVERLAY wins the cells it covers: it is painting over the panes, so a click
 * on it belongs to it and the editor underneath must not move its caret. In the
 * file list a cell names the item on its row; in the editor it names a document
 * position, taking the editor's own optional tab-strip header and line-number
 * gutter out of the cell first (both are plan decisions, so the resolver reads
 * them off the region rather than re-deriving them).
 */
export function resolvePointer(
  plan: ScreenPlan,
  cell: Position,
  geometry: MotionContext,
): PointerTarget | null {
  const modal = modalOf(plan);
  if (modal !== null && holds(modal, cell)) return { pane: "modal" };
  const sidebar = sidebarOf(plan);
  if (sidebar !== null && holds(sidebar, cell)) {
    const item = sidebar.items.find((entry) => entry.screenRow === cell.row - sidebar.y);
    return { pane: "sidebar", index: item?.index ?? -1 };
  }
  const editor = editorOf(plan);
  if (editor === null || !holds(editor, cell)) return null; // the mode line, or dead space
  const row = editor.firstRow + (cell.row - editor.y - (editor.headerRows ?? 0));
  const position = positionAtDisplay(geometry, row, cell.col - editor.x - (editor.gutterWidth ?? 0));
  return { pane: "editor", position };
}
