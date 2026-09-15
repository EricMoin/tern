//! Layer A's framework-element constructors: the plan's row specs as real core
//! scene nodes.
//!
//! THE FORM PRIMITIVES THE APP-CORE ONLY QUOTED. `core/panes.ts` builds the
//! preferences and theme rows from the framework's GLYPH constants and the palette
//! and picker from the `Select` filter, but it never constructs the `Checkbox`,
//! `Radio`, `Toggle` or `Menu` elements themselves. This layer does: each spec
//! `layers/pane-elements.ts` derives from a plan row is materialized through the
//! core factory, and `mount.ts` mounts it where its own composition is the row's
//! cells (asserted by `pane_test.ts`).
//!
//! NO LAYOUT IS DECIDED HERE. The element is built from the plan's own state (the
//! glyph's checked/on/selected bit and the label after it), so the element's
//! composition is the plan's text span; the plan still places the cell.

import { Checkbox, Menu, Radio, Select, Toggle, type Node } from "@tern-tui/core";
import type { ControlSpec, MenuSpec, SelectSpec } from "../pane-elements.ts";

/** The framework form element one preference/theme row is drawn with. */
export function controlNode(spec: ControlSpec): Node {
  switch (spec.kind) {
    case "checkbox": return Checkbox({ checked: spec.checked, label: spec.label });
    case "toggle": return Toggle({ on: spec.on, label: spec.label });
    case "radio": return Radio({ options: [{ value: spec.label, label: spec.label }], selected: spec.selected });
  }
}

/** The palette's command rows as the framework's own `Menu`. */
export function menuNode(spec: MenuSpec): Node {
  return Menu({
    items: spec.items.map((item) => ({ id: item.key, label: item.label })),
    highlighted: spec.highlighted,
    open: true,
  });
}

/** The picker's file rows as the framework's own `Select` (the element the core
 * pane already filters through, now constructed from the plan's rows). */
export function selectNode(spec: SelectSpec): Node {
  return Select({ options: spec.options.map((option) => ({ value: option.value, label: option.label })), filter: spec.filter, highlighted: spec.highlighted });
}
