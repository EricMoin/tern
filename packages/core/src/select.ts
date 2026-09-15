//! The Select element: filtering, keyboard navigation, and the dropdown.

import { Node, Text } from "./node.ts";
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
/** One option in a `Select` list. */
export interface SelectOption {
  /** The option's value — what confirmation (single mode) or the selection
   * set (multi mode) carries. */
  value: string;
  /** The option's display label (defaults to the value). */
  label?: string;
  /** Start selected in multi mode (default `false`). */
  selected?: boolean;
}

/** The state reported by {@link selectKey} after a routed key. */
export interface SelectState {
  /** The highlighted option's index within the filtered list. */
  highlighted: number;
  /** The typeahead filter narrowing the visible options (`""` = all). */
  filter: string;
  /** Single mode: the confirmed option value; multi mode: the selected
   * values. */
  value: string | string[];
  /** Whether the dropdown is open (enter/escape dismiss it). */
  open: boolean;
}

/**
 * Props for the `Select` element. `options` / `floating` are consumed by the
 * factory (the option list is JS bookkeeping — it never reaches the scene
 * props, mirroring `Panels` / `DiffView`); the remaining state/style/layout
 * props flow to the root box, which is a flex column of text leaves.
 */
export interface SelectProps extends NodeProps {
  /** The options to choose from, in list order. */
  options: SelectOption[];
  /**
   * Multi-select mode (default `false`): space toggles the highlighted
   * option's checkmark, option rows render `✓ ` / `  ` prefixes, and a
   * summary row shows the selected count.
   */
  multi?: boolean;
  /** Single mode: the confirmed option value (default `""`); multi mode:
   * the selected values (default the `selected`-flagged options). */
  value?: string | string[];
  /** The highlighted option's index within the filtered list (default 0). */
  highlighted?: number;
  /** The typeahead filter query narrowing the visible options (default
   * `""`). Typing appends, backspace trims. */
  filter?: string;
  /** Whether the dropdown is open (default `true`). Enter/escape dismiss. */
  open?: boolean;
  /**
   * Render the dropdown as a floating overlay: the root box carries the
   * `z_index` prop (the compositor's paint z-order; default `0`), so the
   * dropdown paints above in-flow content at the default z. The mode flag is
   * consumed by the factory — only the `z_index` prop reaches the scene.
   */
  floating?: boolean;
  /** The overlay's paint z-order (used when `floating`; default 0). */
  z_index?: number;
}

/** The dim placeholder shown in the filter row while the query is empty. */
export const SELECT_FILTER_PLACEHOLDER = "filter…";

/** A select option with its label resolved (`label ?? value`), as stored in
 * {@link selectOptions}. */
export interface NormalizedSelectOption {
  value: string;
  label: string;
}

/** The label-normalized option list of a select node (JS bookkeeping — never
 * scene props, mirroring `Panels`' `panelBodies`). Exported for the
 * semantics wiring (`syncSemantics`); @internal. */
export const selectOptions = new WeakMap<Node, NormalizedSelectOption[]>();

/** The options visible under a filter: those whose label starts with the
 * query (case-insensitive prefix match). An empty query shows everything. */
function selectVisible(
  options: readonly NormalizedSelectOption[],
  filter: string,
): NormalizedSelectOption[] {
  if (filter === "") return [...options];
  const needle = filter.toLowerCase();
  return options.filter((option) =>
    option.label.toLowerCase().startsWith(needle)
  );
}

/**
 * The options of a select node visible under its current filter, in scene
 * order (the label-normalized records). An empty filter returns all options.
 */
export function visibleOptions(select: Node): SelectOption[] {
  const props = select.props as SelectProps;
  const filter = typeof props.filter === "string" ? props.filter : "";
  return selectVisible(selectOptions.get(select) ?? [], filter);
}

/**
 * Rebuild a select node's children from its current props (the source of
 * truth, mirroring `Input`'s value/caret): a filter row, one option row per
 * visible option, and — in multi mode — a selected-count summary row. The
 * highlighted row is reversed; selected rows (multi) carry a `✓ ` prefix.
 * Runs at creation and after every {@link selectKey} mutation.
 */
function rebuildSelect(select: Node): void {
  const props = select.props as SelectProps;
  const options = selectOptions.get(select) ?? [];
  const multi = props.multi ?? false;
  const filter = typeof props.filter === "string" ? props.filter : "";
  const highlighted = typeof props.highlighted === "number"
    ? props.highlighted
    : 0;
  const selected = new Set(Array.isArray(props.value) ? props.value : []);
  const visible = selectVisible(options, filter);

  for (const child of [...select.children]) child.remove();

  // Filter row: the typeahead query, dimmed while empty.
  const empty = filter === "";
  select.addChild(
    Text({ text: empty ? SELECT_FILTER_PLACEHOLDER : filter, dim: empty }),
  );
  // Option rows: `✓ `/`  ` prefix (multi) + label; the highlight reversed.
  visible.forEach((option, index) => {
    const prefix = multi ? (selected.has(option.value) ? "✓ " : "  ") : "";
    select.addChild(
      Text({
        text: `${prefix}${option.label}`,
        reversed: index === highlighted,
      }),
    );
  });
  // Summary row (multi mode): the selected-count line.
  if (multi) {
    select.addChild(Text({ text: `${selected.size} selected` }));
  }
  syncSemantics(select);
}

/**
 * Create a `select` element: a flex column of text leaves — a filter row
 * (the typeahead query, dimmed while empty), one option row per visible
 * option (the highlighted row reversed, multi-mode rows `✓ `/`  `-prefixed),
 * and in multi mode a selected-count summary row. The option list is JS
 * bookkeeping (never scene props); the interactive state (`highlighted`,
 * `filter`, `value`, `open`) lives on the root box's props. Drive it with
 * {@link selectKey}. A `floating` dropdown stamps the root box's `z_index`
 * prop (compositor paint order) so it overlays in-flow content. No new napi
 * node kind: the `select` element materializes as a `box` (constitution).
 */
export function Select(props: SelectProps): Node {
  const multi = props.multi ?? false;
  const options = props.options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
  }));
  const initialValue: string | string[] = multi
    ? Array.isArray(props.value)
      ? props.value
      : props.options.filter((option) => option.selected).map((option) =>
        option.value
      )
    : typeof props.value === "string"
    ? props.value
    : "";
  const rootProps: NodeProps = {
    ...props,
    multi,
    value: initialValue,
    highlighted: props.highlighted ?? 0,
    filter: props.filter ?? "",
    open: props.open ?? true,
  };
  if (props.floating === true) {
    rootProps.z_index = (props.z_index as number | undefined) ?? 0;
  }
  const plain = rootProps as Record<string, unknown>;
  delete plain.options;
  delete plain.floating;
  const select = Node.create("select", rootProps, []);
  selectOptions.set(select, options);
  rebuildSelect(select);
  syncSemantics(select);
  return select;
}

/**
 * Apply a key to a select node, mutating its state and rebuilding the
 * composition in place — the Select counterpart of {@link editKey}.
 *
 * - `up` / `down` move the highlight within the filtered list (clamped).
 * - `char` (except space) appends to the typeahead filter, narrowing the
 *   visible options to prefix matches and resetting the highlight to the
 *   first match; `backspace` trims the filter.
 * - `space` toggles the highlighted option's checkmark in multi mode (a
 *   no-op in single mode).
 * - `enter` confirms the highlighted option (single mode: `value` becomes
 *   the option's value; multi mode: the selection set is kept) and dismisses
 *   the dropdown.
 * - `escape` dismisses the dropdown.
 *
 * Returns the new state; any other key leaves the select unchanged.
 */
export function selectKey(select: Node, event: KeyEvent): SelectState {
  const props = select.props as SelectProps;
  const options = selectOptions.get(select) ?? [];
  const multi = props.multi ?? false;
  const filter = typeof props.filter === "string" ? props.filter : "";
  const highlighted = typeof props.highlighted === "number"
    ? props.highlighted
    : 0;
  const open = props.open ?? true;
  const value: string | string[] =
    typeof props.value === "string" || Array.isArray(props.value)
      ? props.value
      : multi
      ? []
      : "";

  let nextFilter = filter;
  let nextHighlighted = highlighted;
  let nextOpen = open;
  let nextValue = value;

  const name = event.name;
  if (name === "up") {
    nextHighlighted = Math.max(0, highlighted - 1);
  } else if (name === "down") {
    nextHighlighted = Math.min(
      selectVisible(options, filter).length - 1,
      highlighted + 1,
    );
  } else if (name === "enter") {
    const visible = selectVisible(options, filter);
    const option = visible[Math.min(nextHighlighted, visible.length - 1)];
    if (option !== undefined) {
      if (!multi) nextValue = option.value;
      nextOpen = false;
    }
  } else if (name === "escape") {
    nextOpen = false;
  } else if (name === "char" && event.char === " ") {
    if (multi) {
      const visible = selectVisible(options, filter);
      const option = visible[Math.min(nextHighlighted, visible.length - 1)];
      if (option !== undefined) {
        const current = Array.isArray(nextValue) ? nextValue : [];
        const index = current.indexOf(option.value);
        nextValue = index === -1
          ? [...current, option.value]
          : current.filter((v) => v !== option.value);
      }
    }
  } else if (
    name === "char" && !event.ctrl && !event.alt && event.char !== undefined
  ) {
    nextFilter = filter + event.char;
    nextHighlighted = 0;
  } else if (name === "backspace") {
    nextFilter = filter.slice(0, -1);
    nextHighlighted = 0;
  }

  // Clamp the highlight into the visible list (a filter change can shrink
  // it; up/down/space already clamp).
  nextHighlighted = Math.min(
    nextHighlighted,
    Math.max(0, selectVisible(options, nextFilter).length - 1),
  );

  const state: SelectState = {
    highlighted: nextHighlighted,
    filter: nextFilter,
    value: nextValue,
    open: nextOpen,
  };
  const changed = state.highlighted !== highlighted ||
    state.filter !== filter ||
    state.value !== value ||
    state.open !== open;
  if (changed) {
    select.setProps({
      ...props,
      highlighted: state.highlighted,
      filter: state.filter,
      value: state.value,
      open: state.open,
    });
    rebuildSelect(select);
  }
  return state;
}

