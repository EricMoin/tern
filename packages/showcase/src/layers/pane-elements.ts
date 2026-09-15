//! The page elements: how a plan's auxiliary-pane rows name the framework's own
//! factory elements.
//!
//! WHY THIS MODULE EXISTS. `core/panes.ts` builds the auxiliary panes from the
//! framework's PURE composition helpers — the `Select` prefix filter, the chart
//! readers, the glyph CONSTANTS — but it never constructs the `Menu`, `Checkbox`,
//! `Radio` or `Toggle` factory elements themselves (15c's own scope note). On its
//! own that leaves four shipped symbols without a single construction in the app,
//! which is exactly what "the showcase covers every tern feature" cannot survive.
//! The layers are where the elements belong: a layer is the thing that turns the
//! plan into real scene nodes, so it is the thing that can mount an element.
//!
//! WHAT IS DECIDED HERE, AND WHAT IS NOT. This module maps a plan row's own cells
//! onto the framework element that composes them — the glyph a preference row
//! carries names the element (`[x]` is a checkbox, `●` a toggle, `(•)` a radio),
//! and the row's label is the element's label. It re-derives no layout: the plan
//! still places every cell, and each element's own composition must equal the row
//! it stands for (the per-layer constructors assert that before mounting). The
//! palette's `Menu` and the picker's `Select` are derived from the plan's own item
//! rows the same way.
//!
//! FRAMEWORK-NEUTRAL ON PURPOSE. The three layers mount through three different
//! runtimes (core factories, React host components, Solid factories), so the
//! mapping is plain data and each layer supplies only the construction.

import {
  CHECKBOX_CHECKED_GLYPH,
  CHECKBOX_UNCHECKED_GLYPH,
  RADIO_SELECTED_GLYPH,
  RADIO_UNSELECTED_GLYPH,
  TOGGLE_OFF_GLYPH,
  TOGGLE_ON_GLYPH,
} from "@tern-tui/core";
import type { ModalId } from "../core/commands.ts";
import type { ModalRegion, ModalRow } from "../core/plan.ts";

/** The framework form element one plan row is drawn with. */
export type ControlSpec =
  | { readonly kind: "checkbox"; readonly checked: boolean; readonly label: string }
  | { readonly kind: "toggle"; readonly on: boolean; readonly label: string }
  | { readonly kind: "radio"; readonly selected: number; readonly label: string };

/** The panes whose rows are form controls: preferences and the theme audit's
 * radio group. Any other pane's rows are plain text. */
function carriesControls(id: ModalId): boolean {
  return id === "preferences" || id === "theme";
}

/**
 * The framework element a preference/theme row's text is drawn with, or null for
 * a row that is not a control.
 *
 * The glyph is the WHOLE signal: the plan's row text is the element's own
 * composition (`glyph + " " + label`), so reading the glyph back is not a second
 * layout decision — it is the inverse of the composition the element performs.
 * The label is everything after the glyph, which the element re-composes to the
 * exact same text.
 */
export function controlSpec(id: ModalId, text: string): ControlSpec | null {
  if (!carriesControls(id)) return null;
  // The glyphs are matched as whole prefixes, never split on their first space:
  // `[ ]` and `( )` carry a space INSIDE the glyph.
  const table: readonly (readonly [string, (label: string) => ControlSpec])[] = [
    [CHECKBOX_CHECKED_GLYPH, (label) => ({ kind: "checkbox", checked: true, label })],
    [CHECKBOX_UNCHECKED_GLYPH, (label) => ({ kind: "checkbox", checked: false, label })],
    [TOGGLE_ON_GLYPH, (label) => ({ kind: "toggle", on: true, label })],
    [TOGGLE_OFF_GLYPH, (label) => ({ kind: "toggle", on: false, label })],
    [RADIO_SELECTED_GLYPH, (label) => ({ kind: "radio", selected: 0, label })],
    [RADIO_UNSELECTED_GLYPH, (label) => ({ kind: "radio", selected: -1, label })],
  ];
  for (const [glyph, make] of table) {
    if (text.startsWith(glyph + " ")) return make(text.slice(glyph.length + 1));
  }
  return null;
}

/** One row's content cells: the key column (label hint) and the item text. The
 * modal's frame and filler spans are dropped, so this is what the row SAYS. */
function rowContent(row: ModalRow): { readonly key: string; readonly text: string } {
  let key = "";
  let text = "";
  for (const span of row.spans) {
    if (span.hint === "modal-label") key += span.text;
    else if (span.hint === "modal-item") text += span.text;
  }
  return { key: key.trimEnd(), text: text.trimEnd() };
}

/** Whether a row is one of the overlay's listed items (not its frame, title,
 * field or footer). */
function isItemRow(row: ModalRow): boolean {
  return row.spans.some((span) => span.hint === "modal-item" && span.text.trim() !== "");
}

/** The plan's own active-item marker, stripped so the element gets the bare label
 * the framework composes its rows from. */
function markerless(text: string): string {
  return text.startsWith("> ") || text.startsWith("  ") ? text.slice(2) : text;
}

/** The palette's command rows as the framework `Menu`'s item model. */
export interface MenuSpec {
  readonly items: readonly { readonly key: string; readonly label: string }[];
  readonly highlighted: number;
}

/**
 * The palette overlay's rows as a `Menu`. The plan's rows ARE the menu's items —
 * the numeric key column is the plan's, the framework's is the label — so the
 * menu's own composed rows reproduce the plan's item cells.
 */
export function paletteMenuSpec(region: ModalRegion): MenuSpec | null {
  if (region.id !== "palette") return null;
  const rows = region.rows.filter(isItemRow);
  if (rows.length === 0) return null;
  const items = rows.map((row) => {
    const content = rowContent(row);
    return { key: content.key, label: markerless(content.text) };
  });
  const at = rows.findIndex((row) => rowContent(row).text.startsWith("> "));
  return { items, highlighted: at < 0 ? 0 : at };
}

/** The picker's file rows as the framework `Select`'s option model. */
export interface SelectSpec {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly filter: string;
  readonly highlighted: number;
}

/** The picker overlay's rows as a `Select`: the filtered files are its options and
 * the typeahead field is its own filter query. */
export function pickerSelectSpec(region: ModalRegion): SelectSpec | null {
  if (region.id !== "picker") return null;
  const rows = region.rows.filter(isItemRow);
  const options = rows.map((row) => {
    const label = markerless(rowContent(row).text);
    return { value: label, label };
  });
  const at = rows.findIndex((row) => rowContent(row).text.startsWith("> "));
  let filter = "";
  for (const row of region.rows) {
    for (const span of row.spans) if (span.hint === "modal-field") filter += span.text;
  }
  return { options, filter: filter.trimEnd(), highlighted: at < 0 ? 0 : at };
}
