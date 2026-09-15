//! The Checkbox, Toggle and Radio elements and their shared glyphs.

import { Node, Text } from "./node.ts";
import type { NormalizedSelectOption } from "./select.ts";
import type { NodeProps } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
import { syncSemantics } from "./semantics.ts";
/** The checked glyph of a `checkbox` leaf. */
export const CHECKBOX_CHECKED_GLYPH = "[x]";

/** The unchecked glyph of a `checkbox` leaf. */
export const CHECKBOX_UNCHECKED_GLYPH = "[ ]";

/** The on glyph of a `toggle` leaf. */
export const TOGGLE_ON_GLYPH = "●";

/** The off glyph of a `toggle` leaf. */
export const TOGGLE_OFF_GLYPH = "○";

/** The selected glyph of a `radio` row. */
export const RADIO_SELECTED_GLYPH = "(•)";

/** The unselected glyph of a `radio` row. */
export const RADIO_UNSELECTED_GLYPH = "( )";

/** The fg of a focused form primitive's row — the default theme's `primary`
 * palette fg (mirroring `TAB_PRIMARY_FG`). */
export const CHECK_PRIMARY_FG = "#61afef";

/** The bg of a focused form primitive's row — the default theme's `primary`
 * palette bg (mirroring `TAB_PRIMARY_BG`). */
export const CHECK_PRIMARY_BG = "#21252b";

/** The state reported by {@link checkboxKey} after a routed key. */
export interface CheckboxState {
  /** Whether the box is checked. */
  checked: boolean;
}

/** The state reported by {@link toggleKey} after a routed key. */
export interface ToggleState {
  /** Whether the toggle is on. */
  on: boolean;
}

/** The state reported by {@link radioKey} after a routed key. */
export interface RadioState {
  /** The selected option's index. */
  selected: number;
  /** The focused option's index. */
  focused: number;
}

/** One option in a `Radio` list. */
export interface RadioOption {
  /** The option's value — what confirmation carries. */
  value: string;
  /** The option's display label (defaults to the value). */
  label?: string;
  /** Start selected (default `false`; the first selected option wins when
   * `selected` is unset). */
  selected?: boolean;
}

/**
 * Props for the `Checkbox` element. `label` is consumed by the factory (the
 * label is JS bookkeeping — it never reaches the scene props); the
 * interactive state (`checked`, `focused`) and the remaining style/layout
 * props flow to the root box, which holds one text leaf.
 */
export interface CheckboxProps extends NodeProps {
  /** The label text rendered after the glyph. */
  label: string;
  /** Whether the box is checked (default `false`). */
  checked?: boolean;
  /** Whether the box is focused (default `false`; a focused box paints its
   * leaf with the theme's `primary` palette colors, reversed). */
  focused?: boolean;
}

/**
 * Props for the `Toggle` element. `label` is consumed by the factory (the
 * label is JS bookkeeping — it never reaches the scene props); the
 * interactive state (`on`, `focused`) and the remaining style/layout props
 * flow to the root box, which holds one text leaf.
 */
export interface ToggleProps extends NodeProps {
  /** The label text rendered after the glyph. */
  label: string;
  /** Whether the toggle is on (default `false`). */
  on?: boolean;
  /** Whether the toggle is focused (default `false`; a focused toggle paints
   * its leaf with the theme's `primary` palette colors, reversed). */
  focused?: boolean;
}

/**
 * Props for the `Radio` element. `options` is consumed by the factory (the
 * option list is JS bookkeeping — it never reaches the scene props); the
 * interactive state (`selected`, `focused`) and the remaining style/layout
 * props flow to the root box, which is a flex column of text leaves.
 */
export interface RadioProps extends NodeProps {
  /** The options to choose from, in list order. */
  options: RadioOption[];
  /** The selected option's index (default the first `selected`-flagged
   * option, else 0). */
  selected?: number;
  /** The focused option's index (default 0). */
  focused?: number;
}

/** The label of a checkbox node (JS bookkeeping — never scene props,
 * mirroring `Select`'s `selectOptions`). Exported for the semantics wiring
 * (`syncSemantics`); @internal. */
export const checkboxLabels = new WeakMap<Node, string>();

/** The label of a toggle node (JS bookkeeping — never scene props, mirroring
 * `Select`'s `selectOptions`). Exported for the semantics wiring
 * (`syncSemantics`); @internal. */
export const toggleLabels = new WeakMap<Node, string>();

/** The label-normalized option list of a radio node (JS bookkeeping — never
 * scene props, mirroring `Select`'s `selectOptions`). Exported for the
 * semantics wiring (`syncSemantics`); @internal. */
export const radioOptions = new WeakMap<Node, NormalizedSelectOption[]>();

/**
 * Rebuild a checkbox node's children from its current props (the source of
 * truth, mirroring `rebuildSelect`): one text leaf — the checked/unchecked
 * glyph + the label, painted with the `primary` palette colors and reversed
 * while focused. Runs at creation and after every {@link checkboxKey}
 * mutation.
 */
function rebuildCheckbox(checkbox: Node): void {
  const props = checkbox.props as CheckboxProps;
  const label = checkboxLabels.get(checkbox) ?? "";
  const checked = props.checked ?? false;

  for (const child of [...checkbox.children]) child.remove();

  const leaf: NodeProps = {
    text: `${
      checked ? CHECKBOX_CHECKED_GLYPH : CHECKBOX_UNCHECKED_GLYPH
    } ${label}`,
  };
  if (props.focused === true) {
    leaf.fg = CHECK_PRIMARY_FG;
    leaf.bg = CHECK_PRIMARY_BG;
    leaf.reversed = true;
  }
  checkbox.addChild(Text(leaf));
  syncSemantics(checkbox);
}

/**
 * Rebuild a toggle node's children from its current props (the source of
 * truth, mirroring `rebuildSelect`): one text leaf — the on/off glyph + the
 * label, painted with the `primary` palette colors and reversed while
 * focused. Runs at creation and after every {@link toggleKey} mutation.
 */
function rebuildToggle(toggle: Node): void {
  const props = toggle.props as ToggleProps;
  const label = toggleLabels.get(toggle) ?? "";
  const on = props.on ?? false;

  for (const child of [...toggle.children]) child.remove();

  const leaf: NodeProps = {
    text: `${on ? TOGGLE_ON_GLYPH : TOGGLE_OFF_GLYPH} ${label}`,
  };
  if (props.focused === true) {
    leaf.fg = CHECK_PRIMARY_FG;
    leaf.bg = CHECK_PRIMARY_BG;
    leaf.reversed = true;
  }
  toggle.addChild(Text(leaf));
  syncSemantics(toggle);
}

/**
 * Rebuild a radio node's children from its current props (the source of
 * truth, mirroring `rebuildSelect`): one text leaf per option — the
 * selected/unselected glyph + the label, the focused row painted with the
 * `primary` palette colors and reversed (mirroring the Select highlight).
 * Runs at creation and after every {@link radioKey} mutation.
 */
function rebuildRadio(radio: Node): void {
  const props = radio.props as RadioProps;
  const options = radioOptions.get(radio) ?? [];
  const selected = typeof props.selected === "number" ? props.selected : 0;
  const focused = typeof props.focused === "number" ? props.focused : 0;

  for (const child of [...radio.children]) child.remove();

  options.forEach((option, index) => {
    const leaf: NodeProps = {
      text: `${
        index === selected ? RADIO_SELECTED_GLYPH : RADIO_UNSELECTED_GLYPH
      } ${option.label}`,
    };
    if (index === focused) {
      leaf.fg = CHECK_PRIMARY_FG;
      leaf.bg = CHECK_PRIMARY_BG;
      leaf.reversed = true;
    }
    // Each option row is its own radio member: capture the leaf handle and
    // record its per-row semantics (the M4.1 wiring — the selected row is
    // `checked` per ARIA's role="radio" model, the focused row `focused`).
    const row = Text(leaf);
    const rowState: string[] = [];
    if (index === selected) rowState.push("checked");
    if (index === focused) rowState.push("focused");
    row.setSemantics({
      role: "radio",
      label: option.label,
      state: rowState,
      enabled: true,
      selected: index === selected,
    });
    radio.addChild(row);
  });
  syncSemantics(radio);
}

/**
 * Create a `checkbox` element: a flex box holding one text leaf — the
 * checked/unchecked glyph + the label, painted with the theme's `primary`
 * palette colors and reversed while focused. The label is JS bookkeeping
 * (never scene props); the interactive state (`checked`, `focused`) lives on
 * the root box's props. Drive it with {@link checkboxKey}. No new napi node
 * kind: the `checkbox` element materializes as a `box` (constitution).
 */
export function Checkbox(props: CheckboxProps): Node {
  const rootProps: NodeProps = {
    ...props,
    checked: props.checked ?? false,
    focused: props.focused ?? false,
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.label;
  const checkbox = Node.create("checkbox", rootProps, []);
  checkboxLabels.set(checkbox, props.label);
  rebuildCheckbox(checkbox);
  syncSemantics(checkbox);
  return checkbox;
}

/**
 * Create a `toggle` element: a flex box holding one text leaf — the on/off
 * glyph + the label, painted with the theme's `primary` palette colors and
 * reversed while focused. The label is JS bookkeeping (never scene props);
 * the interactive state (`on`, `focused`) lives on the root box's props.
 * Drive it with {@link toggleKey}. No new napi node kind: the `toggle`
 * element materializes as a `box` (constitution).
 */
export function Toggle(props: ToggleProps): Node {
  const rootProps: NodeProps = {
    ...props,
    on: props.on ?? false,
    focused: props.focused ?? false,
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.label;
  const toggle = Node.create("toggle", rootProps, []);
  toggleLabels.set(toggle, props.label);
  rebuildToggle(toggle);
  syncSemantics(toggle);
  return toggle;
}

/**
 * Create a `radio` element: a flex column of text leaves — one row per
 * option, the selected row `(•)`-prefixed and the focused row painted with
 * the theme's `primary` palette colors and reversed. The option list is JS
 * bookkeeping (never scene props); the interactive state (`selected`,
 * `focused`) lives on the root box's props. Drive it with {@link radioKey}.
 * No new napi node kind: the `radio` element materializes as a `box`
 * (constitution).
 */
export function Radio(props: RadioProps): Node {
  const options = props.options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
  }));
  const selected = typeof props.selected === "number"
    ? props.selected
    : Math.max(0, props.options.findIndex((option) => option.selected));
  const rootProps: NodeProps = {
    ...props,
    selected,
    focused: props.focused ?? 0,
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.options;
  const radio = Node.create("radio", rootProps, []);
  radioOptions.set(radio, options);
  rebuildRadio(radio);
  syncSemantics(radio);
  return radio;
}

/**
 * Apply a key to a checkbox node, mutating its state and rebuilding the
 * composition in place — the Checkbox counterpart of {@link selectKey}.
 *
 * - `space` / `enter` toggle the checked state.
 *
 * Returns the new state; any other key leaves the checkbox unchanged.
 */
export function checkboxKey(checkbox: Node, event: KeyEvent): CheckboxState {
  const props = checkbox.props as CheckboxProps;
  const checked = props.checked ?? false;
  const name = event.name;
  const toggles = (name === "char" && event.char === " ") || name === "enter";
  if (!toggles) return { checked };
  const next = !checked;
  checkbox.setProps({ ...props, checked: next });
  rebuildCheckbox(checkbox);
  return { checked: next };
}

/**
 * Apply a key to a toggle node, mutating its state and rebuilding the
 * composition in place — the Toggle counterpart of {@link selectKey}.
 *
 * - `space` / `enter` toggle the on state.
 *
 * Returns the new state; any other key leaves the toggle unchanged.
 */
export function toggleKey(toggle: Node, event: KeyEvent): ToggleState {
  const props = toggle.props as ToggleProps;
  const on = props.on ?? false;
  const name = event.name;
  const toggles = (name === "char" && event.char === " ") || name === "enter";
  if (!toggles) return { on };
  const next = !on;
  toggle.setProps({ ...props, on: next });
  rebuildToggle(toggle);
  return { on: next };
}

/**
 * Apply a key to a radio node, mutating its state and rebuilding the
 * composition in place — the Radio counterpart of {@link selectKey}.
 *
 * - `up` / `left` move the focus toward the first option (clamped at 0).
 * - `down` / `right` move the focus toward the last option (clamped at the
 *   last index).
 * - `space` / `enter` commit the focused option as the selection.
 *
 * Returns the new state; any other key leaves the radio unchanged.
 */
export function radioKey(radio: Node, event: KeyEvent): RadioState {
  const props = radio.props as RadioProps;
  const options = radioOptions.get(radio) ?? [];
  const last = Math.max(0, options.length - 1);
  const selected = typeof props.selected === "number" ? props.selected : 0;
  const focused = typeof props.focused === "number" ? props.focused : 0;
  const name = event.name;
  const isSpace = name === "char" && event.char === " ";
  const isEnter = name === "enter";

  let nextFocused = focused;
  let nextSelected = selected;
  if (name === "up" || name === "left") {
    nextFocused = Math.max(0, focused - 1);
  } else if (name === "down" || name === "right") {
    nextFocused = Math.min(last, focused + 1);
  } else if (isSpace || isEnter) {
    nextSelected = focused;
  }

  if (nextFocused !== focused || nextSelected !== selected) {
    radio.setProps({ ...props, selected: nextSelected, focused: nextFocused });
    rebuildRadio(radio);
  }
  return { selected: nextSelected, focused: nextFocused };
}

