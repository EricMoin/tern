//! The modal overlay's plan: the box, its chrome and its rows.
//!
//! WHY THIS IS NOT IN `plan.ts`. The overlay is the fourth region kind and the only
//! one whose rectangle lies INSIDE another region's — it is an OVERLAY, not a band —
//! and it carries chrome (a frame, a title, field rows, a key column) no other
//! region has. `plan.ts` was already at 420 lines against its 400-line module budget
//! when this representation was added, so the overlay's layout lives here, one
//! import away, rather than growing the module that cuts the screen in three.
//!
//! THE PLAN STILL DECIDES ONCE. Every cell below — the box's rectangle, each row's
//! spans and the field's caret cell — is computed here and hangs off
//! {@link ModalRegion}, which `plan.ts` puts in `regions` in PAINT ORDER (the
//! overlay is last), so it paints over the panes it covers. A layer that re-derived
//! a truncation, a key column or a centering would be the second decision point
//! `plan.ts` exists to prevent.
//!
//! WHAT AN OVERLAY IS, GEOMETRICALLY. Its rectangle is centered in the BODY (the
//! screen minus the mode line) and is never larger than the body: the columns and
//! rows the frame and the content do not need are left to the panes underneath,
//! which is what makes it read as an overlay rather than as a pane. Each row's spans
//! tile the row's own width exactly — frame, content, filler, frame — so a layer
//! writes cells and never leaves a hole for the document to show through.
//!
//! The module imports no scene type, no renderer and no terminal: the overlay is
//! plain data, exactly like every other region.
//!
//! `ModalRow.screenRow` IS REGION-LOCAL. The editor's region starts at row 0, so its
//! `screenRow` reads the same either way; the overlay's does not. Every consumer
//! places a region's rows at `region.y + row.screenRow` (layers/core/frame.ts:89,
//! parity/mount_paint_test.ts:277), so this module keeps that convention and the
//! absolute screen row is `region.y + screenRow`.

import { wrapLineWithOffsets } from "@tern-tui/core";
import type { ModalId } from "./commands.ts";
import type { PlanSpan, StyleHint } from "./plan.ts";
import { cellWidth, type ViewportSize } from "./viewport.ts";

/** The cells kept clear between the overlay's box and the body's edges, on each
 * side, whenever the body has the room for them. */
export const MODAL_MARGIN = 2;

/** The narrowest overlay the frame and a field row still fit in. */
export const MODAL_MIN_WIDTH = 12;

/** The shortest overlay: the top frame, one content row and the bottom frame. */
export const MODAL_MIN_HEIGHT = 3;

/** The frame's glyphs. TEXT, not an engine border: the layers' paint models refuse
 * `border_style` (layers/react/frame.ts:217-223), and a frame the plan PLACES is a
 * frame the plan can also truncate. */
const FRAME = {
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
  horizontal: "─", vertical: "│",
} as const;

/** The cells between an item's key column and its text — the framework's own
 * `HelpPanel` gap (packages/core/src/keymap.ts:196-200: a margin mirroring
 * bubbletea's two-cell separator). */
const KEY_GAP = 2;

/** One field row of the overlay: a label and the text that follows it. */
export interface ModalField {
  readonly label: string;
  readonly text: string;
  /** Whether this field owns the keyboard, so its caret is the overlay's. */
  readonly caret?: boolean;
}

/** One listed row: an optional key column (`ctrl+k`, `2:1`) and its text. */
export interface ModalItem {
  readonly key?: string;
  readonly text: string;
}

/** What the caller offers the overlay — the CONTENT, never the layout. The caller
 * says what the overlay is about (its title, the live query, the replacement, the
 * shortcuts, the matches); this module decides the box they fit in. */
export interface ModalInput {
  readonly id: ModalId;
  readonly title: string;
  readonly fields?: readonly ModalField[];
  readonly items?: readonly ModalItem[];
  /** The first listed item to show; clamped into the list and never past its end. */
  readonly scroll?: number;
  /** The footer line under the content, e.g. the match count. */
  readonly status?: string;
}

/** One cell row of the overlay: the run to paint, in the overlay's own cells. */
export interface ModalRow {
  /** The row within the overlay's box, 0 at its top frame. */
  readonly row: number;
  /** The row within the overlay's box — region-local by the header's convention,
   * so an emitter places it at `region.y + screenRow`. */
  readonly screenRow: number;
  readonly spans: PlanSpan[];
  readonly width: number;
}

/** The overlay, decided: its rectangle in screen cells, its rows and the field
 * caret. `count` is how many items the caller offered and `scroll` the first one
 * on screen — the same pair the sidebar region reports, so a layer can size a
 * scroll region the same way. */
export interface ModalRegion {
  readonly kind: "modal";
  readonly id: ModalId;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rows: ModalRow[];
  /** The caret cell in SCREEN cells (`row` and `col` are absolute), or `null`
   * when no field owns the keyboard. */
  readonly caret: { readonly row: number; readonly col: number } | null;
  readonly count: number;
  readonly scroll: number;
}

/** One part of a row before it is placed: the text and the hint it paints with. */
interface Part {
  readonly text: string;
  readonly hint: StyleHint;
}

/** A row before it is placed: its frame, the run it starts with, what fills the
 * rest and where its caret sits. */
interface RowSpec {
  readonly left: string;
  readonly right: string;
  readonly fill: string;
  readonly filler: StyleHint;
  readonly parts: readonly Part[];
  /** The index of the part the caret sits after, or -1 (a row with no caret). */
  readonly caretAfter: number;
}

/**
 * Lay the overlay out in `area` — the BODY rectangle, in screen cells.
 *
 * The box is centered in the body and sized by its content: as wide as the widest
 * row (bounded by the body minus {@link MODAL_MARGIN}) and as tall as the content
 * needs (bounded the same way). A body too short for everything keeps the FIELDS and
 * drops the list and then the status, because the fields are what the overlay IS; a
 * one-row body still yields a one-row box, because the mode line already says a
 * modal is open and a plan that answered "nothing on screen" would put the layer's
 * frame at odds with the app's own state.
 */
export function buildModalRegion(input: ModalInput, area: ViewportSize): ModalRegion {
  const cols = atLeastOne(area.cols);
  const rows = atLeastOne(area.rows);
  const fields = input.fields ?? [];
  const items = input.items ?? [];
  const status = input.status;

  const marginX = Math.min(MODAL_MARGIN, Math.max(0, Math.floor((cols - MODAL_MIN_WIDTH) / 2)));
  const marginY = Math.min(MODAL_MARGIN, Math.max(0, Math.floor((rows - MODAL_MIN_HEIGHT) / 2)));
  const maxWidth = Math.max(1, cols - 2 * marginX);
  const maxHeight = Math.max(1, rows - 2 * marginY);
  const capacity = Math.max(0, maxHeight - 2);

  // The window over the caller's list: the requested first item, clamped so the
  // window it opens still fits beside the fields and the status.
  const fixed = fields.length + (status === undefined ? 0 : 1);
  const room = Math.max(0, capacity - fixed);
  const scroll = clamp(input.scroll ?? 0, Math.max(0, items.length - room));
  const visible = Math.max(0, Math.min(items.length - scroll, room));
  const keyWidth = items.slice(scroll, scroll + visible)
    .reduce((widest, item) => Math.max(widest, cellWidth(item.key ?? "")), 0);

  // The content, in paint order: the fields, the visible list, the status.
  const content: RowSpec[] = [];
  for (const field of fields) {
    const parts: Part[] = [];
    if (field.label !== "") parts.push({ text: field.label, hint: "modal-label" });
    if (field.text !== "") parts.push({ text: field.text, hint: "modal-field" });
    content.push({
      left: FRAME.vertical, right: FRAME.vertical, fill: " ", filler: "modal-field",
      parts, caretAfter: field.caret === true ? parts.length - 1 : -1,
    });
  }
  for (let index = 0; index < visible; index += 1) {
    const item = items[scroll + index]!;
    const parts: Part[] = [];
    if (keyWidth > 0) parts.push({ text: padStart(item.key ?? "", keyWidth) + " ".repeat(KEY_GAP), hint: "modal-label" });
    if (item.text !== "") parts.push({ text: item.text, hint: "modal-item" });
    content.push({
      left: FRAME.vertical, right: FRAME.vertical, fill: " ", filler: "modal-item",
      parts, caretAfter: -1,
    });
  }
  if (status !== undefined && status !== "") {
    content.push({
      left: FRAME.vertical, right: FRAME.vertical, fill: " ", filler: "modal-status",
      parts: [{ text: status, hint: "modal-status" }], caretAfter: -1,
    });
  }

  const inner = content.reduce((widest, row) => Math.max(widest, rowWidth(row.parts)), 0);
  const width = Math.min(maxWidth, Math.max(MODAL_MIN_WIDTH, inner + 2));
  const x = Math.floor((cols - width) / 2);

  // The box: the title rides the top frame, the content rows follow, the bottom
  // frame closes it when the body has the room for it.
  const title: Part[] = [{ text: FRAME.horizontal + " ", hint: "modal-frame" }];
  if (input.title !== "") {
    title.push({ text: input.title, hint: "modal-title" }, { text: " ", hint: "modal-frame" });
  }
  const specs: RowSpec[] = [{
    left: FRAME.topLeft, right: FRAME.topRight, fill: FRAME.horizontal, filler: "modal-frame",
    parts: title, caretAfter: -1,
  }];
  for (const row of content.slice(0, Math.max(0, Math.min(capacity, content.length)))) specs.push(row);
  if (specs.length + 1 <= maxHeight) {
    specs.push({
      left: FRAME.bottomLeft, right: FRAME.bottomRight, fill: FRAME.horizontal, filler: "modal-frame",
      parts: [], caretAfter: -1,
    });
  }

  const y = Math.floor((rows - specs.length) / 2);
  const placed: ModalRow[] = [];
  let caret: { row: number; col: number } | null = null;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!;
    const row = placeRow(spec, width);
    placed.push({ row: index, screenRow: index, spans: row.spans, width });
    if (row.caret !== null) {
      const right = Math.max(x + 1, x + width - 2);
      caret = { row: y + index, col: Math.max(x + 1, Math.min(x + row.caret, right)) };
    }
  }

  return {
    kind: "modal", id: input.id, title: input.title,
    x, y, width, height: placed.length,
    rows: placed, caret, count: items.length, scroll,
  };
}

/** The width one row's parts ask for, in cells. */
function rowWidth(parts: readonly Part[]): number {
  return parts.reduce((total, part) => total + cellWidth(part.text), 0);
}

/**
 * One row, placed: its spans (region-local, 0-based — a layer adds its region's
 * origin) and the column the row's caret sits at, or `null`.
 *
 * The left frame, the parts that fit, the filler and the right frame. The spans tile
 * the row exactly: the filler closes whatever the truncated content left, so a layer
 * writes cells and never leaves a hole. A row narrower than two cells has no frame to
 * draw and carries its content alone.
 *
 * The caret cell is read off the PLACEMENT, not off the finished spans: a row's filler
 * carries the row's own hint (so a field row's padding is styled with the field), and
 * scanning the spans for that hint would land the caret on the frame.
 */
function placeRow(spec: RowSpec, width: number): { spans: PlanSpan[]; caret: number | null } {
  const framed = width >= 2;
  const inner = Math.max(0, width - (framed ? 2 : 0));
  const start = framed ? 1 : 0;
  const spans: PlanSpan[] = [];
  let at = start;
  if (framed) spans.push({ text: spec.left, hint: "modal-frame", x: 0, width: 1 });
  for (const part of spec.parts) {
    const room = inner - (at - start);
    if (room <= 0) break;
    const text = fit(part.text, room);
    if (text === "") continue;
    const partWidth = cellWidth(text);
    spans.push({ text, hint: part.hint, x: at, width: partWidth });
    at += partWidth;
  }
  const caret = spec.caretAfter >= 0 ? at : null;
  const used = at - start;
  if (inner > used) {
    spans.push({ text: spec.fill.repeat(inner - used), hint: spec.filler, x: at, width: inner - used });
    at += inner - used;
  }
  if (framed) spans.push({ text: spec.right, hint: "modal-frame", x: width - 1, width: 1 });
  return { spans, caret };
}

/** The longest prefix of `text` that fits in `cells` cells — the framework's own
 * first display row, the same measure `plan-panes.ts`'s `fit` uses, so
 * nothing is cut mid-glyph. */
function fit(text: string, cells: number): string {
  if (cells <= 0) return "";
  return wrapLineWithOffsets(text, cells)[0]?.text ?? "";
}

/** `text` right-aligned in `cells` cells — the framework's own key column rule
 * (packages/core/src/keymap.ts:225 pads the hint with `padStart`). */
function padStart(text: string, cells: number): string {
  return " ".repeat(Math.max(0, cells - cellWidth(text))) + text;
}

/** `value` as at least one cell: a zero-cell body is a caller bug to survive. */
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
