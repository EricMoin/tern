//! Layer C's framework-element constructors: the plan's row specs as Solid scene
//! nodes.
//!
//! THE FORM PRIMITIVES THE APP-CORE ONLY QUOTED (see layers/core/pane-elements.ts).
//! Solid can construct all of them: the `Checkbox` / `Radio` / `Toggle` factories
//! are reached from `@tern-tui/core` (the solid barrel does not re-export them, the
//! same gap `fix-solid-barrel-hides-virtual-content` reports for another seam), and
//! a core factory RETURNS the scene `Node` it built, so the node mounts directly
//! under the layer's solid tree. `Menu` and `Select` come from the solid barrel.
//!
//! NO LAYOUT IS DECIDED HERE: the spec carries the plan's own checked/on/selected
//! bit and label, so the element composes the plan's text span.

import { Checkbox, Radio, Toggle, type Node } from "@tern-tui/core";
import { Menu, Select } from "@tern-tui/solid";
import type { ControlSpec, MenuSpec, SelectSpec } from "../pane-elements.ts";

/** The framework form element one preference/theme row is drawn with. */
export function controlNode(spec: ControlSpec): Node {
  switch (spec.kind) {
    case "checkbox": return Checkbox({ checked: spec.checked, label: spec.label });
    case "toggle": return Toggle({ on: spec.on, label: spec.label });
    case "radio": return Radio({ options: [{ value: spec.label, label: spec.label }], selected: spec.selected });
  }
}

/** The palette's command rows as the solid `Menu` factory. */
export function menuNode(spec: MenuSpec): Node {
  return Menu({
    items: spec.items.map((item) => ({ id: item.key, label: item.label })),
    highlighted: spec.highlighted,
    open: true,
  });
}

/** The picker's file rows as the solid `Select` factory. */
export function selectNode(spec: SelectSpec): Node {
  return Select({ options: spec.options.map((option) => ({ value: option.value, label: option.label })), filter: spec.filter, highlighted: spec.highlighted });
}
