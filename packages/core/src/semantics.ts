/**
 * The M4.1 semantics wiring: derive accessibility metadata — ARIA `role`,
 * accessible `label`, active `state` flags, and the `enabled` / `selected`
 * booleans — from a widget node's props + JS bookkeeping, and push it
 * through {@link Node.setSemantics}.
 *
 * Pure bookkeeping, exactly like the native semantics store it feeds (see
 * the core `semantics` module): the descriptor is recorded on the node and
 * flushed to the native store on attach, it never reaches the scene props,
 * and the compositor never reads it — so painted cell output is
 * byte-identical whether or not semantics are wired (the store is off by
 * default, and a disabled store makes the writes inert no-ops).
 */

import type { Node } from "./index.ts";
import {
  checkboxLabels,
  radioOptions,
  selectOptions,
  toggleLabels,
} from "./index.ts";

/**
 * The accessibility semantics of a widget node — the write shape of
 * {@link Node.setSemantics}, mirroring the native `SemanticsNodeJs`:
 * `role` as its ARIA role name, the optional accessible `label`, the active
 * boolean `state` flags, and the `enabled` / `selected` booleans.
 */
export interface SemanticsDescriptor {
  /**
   * The ARIA role name: `button`, `checkbox`, `radio`, `radiogroup`,
   * `switch`, `menu`, `menuitem`, `listbox`, `textbox`, `link`, or
   * `group`.
   */
  role: string;
  /**
   * The node's accessible name (what a screen reader announces), or
   * `undefined` when the node carries no label.
   */
  label?: string;
  /**
   * The boolean semantics states currently active on the node:
   * `checked`, `focused`, `expanded`, `collapsed`. Unknown flags error
   * natively (they would silently drop otherwise).
   */
  state: string[];
  /**
   * Whether the control is interactive: `false` for a disabled /
   * read-only control.
   */
  enabled: boolean;
  /**
   * Whether the node is currently selected (a row in a listbox, an
   * option in a menu).
   */
  selected: boolean;
}

/** Whether `props[key]` is boolean-true — the defensive read of a possibly
 * undeclared widget prop (e.g. `disabled` / `focused` on a plain
 * `Input`). */
function boolProp(props: Record<string, unknown>, key: string): boolean {
  return props[key] === true;
}

/** The string label of a widget's props, or `undefined` when unset. */
function labelProp(props: Record<string, unknown>): string | undefined {
  const label = props.label;
  return typeof label === "string" ? label : undefined;
}

/** Attach `label` to a descriptor, omitting the key entirely when the label
 * is `undefined` (the project's `exactOptionalPropertyTypes` rejects an
 * explicit `label: undefined`). */
function withLabel(
  base: Omit<SemanticsDescriptor, "label">,
  label: string | undefined,
): SemanticsDescriptor {
  return label === undefined ? base : { ...base, label };
}

/**
 * Derive and record the semantics of a widget node from its current props +
 * JS bookkeeping — the M3 factory pattern: called at the end of each factory
 * (so every widget starts with semantics) and inside the rebuild functions
 * (so every state flip from `checkboxKey` / `toggleKey` / `radioKey` /
 * `selectKey` / `menuKey` — and the menu open/close path — is reflected).
 *
 * The derivation per widget kind:
 * - `checkbox` → `checkbox`, labelled from `checkboxLabels`, state
 *   `checked` + `focused`, `enabled: !disabled`.
 * - `toggle` → `switch`, labelled from `toggleLabels`, state `checked`
 *   (the native vocabulary's stand-in for the two-state `on` value) +
 *   `focused`, `enabled: !disabled`.
 * - `radio` root → `radiogroup`, state `focused` (the focused row index
 *   exists), `selected` (the group always has a selected member).
 * - `select` → `listbox`, state `expanded` (the dropdown is open) +
 *   `focused` (a highlighted row exists), `selected` (a value is
 *   confirmed / the multi selection is non-empty).
 * - `input` / `textarea` → `textbox`, labelled from props, state
 *   `focused`, `enabled: !disabled` (the native model has no `disabled`
 *   state flag — a disabled control is `enabled: false`).
 * - `menu` → `menu`, state `expanded` (the menu is open).
 *
 * A no-op for node types without a derivation (plain `text` / `box`):
 * custom semantics a consumer set on those nodes are never touched.
 */
export function syncSemantics(node: Node): void {
  const props = node.props as Record<string, unknown>;
  const focused = boolProp(props, "focused");
  switch (node.type) {
    case "checkbox": {
      const state: string[] = [];
      if (boolProp(props, "checked")) state.push("checked");
      if (focused) state.push("focused");
      node.setSemantics(withLabel({
        role: "checkbox",
        state,
        enabled: !boolProp(props, "disabled"),
        selected: false,
      }, checkboxLabels.get(node)));
      break;
    }
    case "toggle": {
      const state: string[] = [];
      if (boolProp(props, "on")) state.push("checked");
      if (focused) state.push("focused");
      node.setSemantics(withLabel({
        role: "switch",
        state,
        enabled: !boolProp(props, "disabled"),
        selected: false,
      }, toggleLabels.get(node)));
      break;
    }
    case "radio": {
      const options = radioOptions.get(node) ?? [];
      const state: string[] = [];
      const focusedIndex = typeof props.focused === "number" ? props.focused : 0;
      if (focusedIndex >= 0 && focusedIndex < options.length) {
        state.push("focused");
      }
      const selectedIndex = typeof props.selected === "number"
        ? props.selected
        : 0;
      node.setSemantics({
        role: "radiogroup",
        state,
        enabled: !boolProp(props, "disabled"),
        selected: selectedIndex >= 0 && selectedIndex < options.length,
      });
      break;
    }
    case "select": {
      const options = selectOptions.get(node) ?? [];
      const state: string[] = [];
      if (props.open === true) state.push("expanded");
      const highlighted = typeof props.highlighted === "number"
        ? props.highlighted
        : 0;
      if (highlighted >= 0 && highlighted < options.length) {
        state.push("focused");
      }
      const multi = props.multi === true;
      const value = props.value;
      const selected = multi
        ? Array.isArray(value) && value.length > 0
        : options.some((option) => option.value === value);
      node.setSemantics({
        role: "listbox",
        state,
        enabled: !boolProp(props, "disabled"),
        selected,
      });
      break;
    }
    case "input":
    case "textarea": {
      const state: string[] = [];
      if (focused) state.push("focused");
      node.setSemantics(withLabel({
        role: "textbox",
        state,
        enabled: !boolProp(props, "disabled"),
        selected: false,
      }, labelProp(props)));
      break;
    }
    case "menu": {
      const state: string[] = [];
      if (props.open === true) state.push("expanded");
      node.setSemantics({
        role: "menu",
        state,
        enabled: true,
        selected: false,
      });
      break;
    }
  }
}
