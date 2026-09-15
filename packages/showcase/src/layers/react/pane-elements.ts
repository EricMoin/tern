//! Layer B's framework-element constructors — and the one it cannot construct.
//!
//! THE PALETTE'S `Menu` AND THE PICKER'S `Select` ARE REACT ELEMENTS. Both are
//! exported by `@tern-tui/react` (packages/react/src/index.ts:2, :4), so this layer
//! constructs them from the plan's own item/option rows and commits them through
//! the framework's reconciler — the construction proof is `app_test.ts`.
//!
//! THE FORM PRIMITIVES ARE NOT REACHABLE FROM REACT, AND THAT IS A GAP. The barrel
//! exports no `Checkbox`, `Radio` or `Toggle` host component
//! (packages/react/src/index.ts:2-4), the reconciler has no `checkbox`/`radio`/
//! `toggle` instance case (packages/react/src/reconciler/host_config.ts:88-140), and
//! a core scene `Node` — which is what the core factories return — is not a valid
//! React child (the reconciler rejects a non-element object). Layer A and layer C
//! CAN mount the primitives (a core factory returns the node the solid tree takes);
//! this layer paints the plan's own text instead and the gap is registered as
//! `fix-react-form-primitives-unhosted`. Nothing here fakes the construction.

import { createElement, type ReactElement } from "react";
import { Menu, Select } from "@tern-tui/react";
import type { ControlSpec, MenuSpec, SelectSpec } from "../pane-elements.ts";

/** The palette's command rows as the framework's `Menu` React element. */
export function paletteMenuElement(spec: MenuSpec): ReactElement {
  return createElement(Menu, {
    items: spec.items.map((item) => ({ id: item.key, label: item.label })),
    highlighted: spec.highlighted,
    open: true,
  });
}

/** The picker's file rows as the framework's `Select` React element. */
export function pickerSelectElement(spec: SelectSpec): ReactElement {
  return createElement(Select, {
    options: spec.options.map((option) => ({ value: option.value, label: option.label })),
    filter: spec.filter,
    highlighted: spec.highlighted,
  });
}

/**
 * The form primitives React cannot host: there is no element to return, so the
 * preference/theme rows keep the plan's own text. Named (not silently skipped) so
 * `app_test.ts` can assert the gap and the registry can cite this file:line.
 */
export const FORM_PRIMITIVES_UNHOSTED: readonly string[] = ["Checkbox", "Radio", "Toggle"];

/** Whether this renderer can host a plan row's form element — never, from React. */
export function controlElement(_spec: ControlSpec): null {
  return null;
}
