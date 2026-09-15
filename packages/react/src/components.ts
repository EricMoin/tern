//! The form and layout element factories.

import { useFocusManager } from "./hooks.ts";
import { name, resolveHostTheme, useTheme } from "./primitives.ts";
import type { TernNodeProps } from "./primitives.ts";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  copySelection,
  defaultTheme,
  dragPanels,
  dragSelection,
  editKey,
  editTextareaKey,
  endPanelDrag,
  endSelection,
  focusAt,
  focusManager,
  mergeTheme,
  menuClick,
  menuHover,
  menuKey,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  selectKey,
  setStreamAutoScroll,
  startSelection,
  startPanelDrag,
  syncStreamTail,
  tabsKey,
  tick,
  treeKey,
  useFocus as coreUseFocus,
  wheelScroll,
  type FocusManager,
  type DiffLine,
  type FocusHandle,
  type KeyHandler,
  type MenuItem,
  type MenuState,
  type Node,
  type NodeProps,
  type PanelSpec,
  type Renderer,
  type ResizeHandler,
  type SelectOption,
  type SelectState,
  type Span,
  type StatusBarSegment,
  type TabSpec,
  type TableColumn,
  type TabsState,
  type TextareaState,
  type TreeNode,
  type TreeState,
  type Theme,
  type ThemeComponent,
  type ThemeOverrides,
  type ThemeResolvableProps,
  type ThemeRole,
} from "@tern-tui/core";
import { THEME_HINT_CARRIER, useApp } from "./reconciler.ts";
// Host tags for the roadmap elements — again widened to `string` so
// `createElement` routes through the generic component overload.
const HOST_INPUT: string = "input";

const HOST_TEXTAREA: string = "textarea";

const HOST_SPINNER: string = "spinner";

const HOST_STATUS_BAR: string = "status_bar";

const HOST_PANELS: string = "panels";

const HOST_DIFF: string = "diff";

const HOST_SELECT: string = "select";

export const HOST_MENU: string = "menu";

export const HOST_SCROLL_VIEW: string = "scroll_view";

export const HOST_TABLE: string = "table";

export const HOST_TREE: string = "tree";

export const HOST_TABS: string = "tabs";

export const HOST_PROGRESS: string = "progress";

export const HOST_MODAL: string = "modal";

export const HOST_BAR_CHART: string = "bar_chart";

export const HOST_CHART: string = "chart";

export const HOST_SPARKLINE: string = "sparkline";

/** The state reported by `<Input>` callbacks after a routed key. */
export interface InputState {
  /** The input's value after the key. */
  value: string;
  /** The caret's display column after the key. */
  caret: number;
}

/**
 * Props for `<Input>`: the tern node props plus the input state and focus
 * wiring. `value` / `caret` / `placeholder` flow to the core `Input` factory;
 * the remaining keys are consumed by the component.
 */
export interface InputProps extends TernNodeProps {
  /** The input's current value (default `""`). */
  value?: string;
  /** The caret's display column (default `0`). */
  caret?: number;
  /** Dimmed text shown when the value is empty. */
  placeholder?: string;
  /**
   * Register the input with a `FocusManager` under this id so routed keys
   * (via `useInput`) edit it through the core `editKey`. Omit to leave the
   * input inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key changes the value or caret. */
  onChange?: (state: InputState) => void;
  /** Fired when the Enter key routes to this input. */
  onSubmit?: (state: InputState) => void;
}

/**
 * Props for `<Spinner>`: the tern node props plus the tick timer rate.
 */
export interface SpinnerProps extends TernNodeProps {
  /** Determinate mode: the current progress value. */
  value?: number;
  /** Determinate mode: the maximum value. */
  max?: number;
  /** Determinate mode: the bar width in cells (default 10). */
  width?: number;
  /** Indeterminate mode: the frame glyphs to cycle through. */
  frames?: string[];
  /** Indeterminate mode: the current frame index (default 0). */
  frame?: number;
  /**
   * The tick interval in ms (default 100). While the spinner is mounted an
   * interval advances the frame via the core `tick` and repaints the scene;
   * the interval is cleared on unmount.
   */
  interval?: number;
}

/**
 * Props for `<StatusBar>`: the tern node props plus the left/center/right
 * segments (strings or core `Node`s), forwarded verbatim to the core
 * `StatusBar` factory.
 */
export interface StatusBarProps extends TernNodeProps {
  /** The left-aligned segment. */
  left?: StatusBarSegment;
  /** The centered segment. */
  center?: StatusBarSegment;
  /** The right-aligned segment. */
  right?: StatusBarSegment;
}

/**
 * Props for `<Panels>`: the tern node props plus the panel spec list,
 * forwarded verbatim to the core `Panels` factory (the specs are JS
 * bookkeeping — panel bodies are core `Node`s, e.g. obtained from a host
 * element ref — and never reach the scene props).
 */
export interface PanelsProps extends TernNodeProps {
  /** The panels, in stack order (top to bottom for a column). */
  panels: PanelSpec[];
  /** The active panel index (default 0) — its header renders bold. */
  active?: number;
  /** Stack direction (default `"column"`). */
  direction?: "row" | "column";
}

/**
 * Props for `<DiffView>`: the tern node props plus the unified-diff line
 * model and the scroll-region passthroughs, forwarded verbatim to the core
 * `DiffView` factory (`hunks` is JS bookkeeping — the lines become composed
 * text leaves and never reach the scene props).
 */
export interface DiffViewProps extends TernNodeProps {
  /** The unified-diff lines to render, in scene order. */
  hunks: DiffLine[];
  /** The horizontal scroll offset in cells (default 0). */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0). */
  scroll_y?: number;
  /**
   * Passed through to each content text leaf: `false` keeps every diff line
   * single-row (no soft wrap — the classic diff look).
   */
  wrap?: boolean;
}

/**
 * Props for `<Select>`: the tern node props plus the options list, the
 * interactive state (forwarded verbatim to the core `Select` factory — the
 * option list is JS bookkeeping and never reaches the scene props) and the
 * focus/callback wiring (consumed by the component).
 */
export interface SelectProps extends TernNodeProps {
  /** The options to choose from, in list order. */
  options: SelectOption[];
  /** Multi-select mode: space toggles checkmarks (default `false`). */
  multi?: boolean;
  /** Single mode: the confirmed value; multi mode: the selected values. */
  value?: string | string[];
  /** The highlighted option's index within the filtered list (default 0). */
  highlighted?: number;
  /** The typeahead filter query narrowing the visible options (default
   * `""`). */
  filter?: string;
  /** Whether the dropdown is open (default `true`). */
  open?: boolean;
  /** Render as a floating overlay via the root box's `z_index` prop
   * (default 0). */
  floating?: boolean;
  /** The overlay's paint z-order (used when `floating`; default 0). */
  z_index?: number;
  /**
   * Register the select with a `FocusManager` under this id so routed keys
   * (via `useInput`) drive it through the core `selectKey`. Omit to leave
   * the select inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key changes the highlight, filter or selection. */
  onChange?: (state: SelectState) => void;
  /** Fired when the Enter key routes to this select (the confirmed
   *  state — single mode `value` carries the highlighted option). */
  onConfirm?: (state: SelectState) => void;
  /** Fired when the Escape key routes to this select (dismissal). */
  onDismiss?: (state: SelectState) => void;
}

/**
 * Props for `<Menu>`: the tern node props plus the hierarchical item model,
 * the interactive state (forwarded verbatim to the core `Menu` factory — the
 * item model and the render mode are JS bookkeeping and never reach the scene
 * props) and the focus/callback wiring (consumed by the component).
 */
export interface MenuProps extends TernNodeProps {
  /** The menu items, in display order (top to bottom). */
  items: MenuItem[];
  /** The highlighted visible-item index (default 0). */
  highlighted?: number;
  /** The keys of submenus open initially (default none). */
  open_submenus?: string[];
  /** Whether the menu is open (default `false` — a closed menu is hidden).
   *  `openMenu` / `closeMenu` toggle it. */
  open?: boolean;
  /** Render the menu as a floating overlay via the root box's `z_index` prop
   *  (default 0). */
  floating?: boolean;
  /** The overlay's paint z-order (used when `floating`; default 0). */
  z_index?: number;
  /** Submenu rendering: `"inline"` (default, tree-style indented rows) or
   *  `"flyout"` (each open submenu as a separate overlay layer). */
  submenu?: "inline" | "flyout";
  /**
   * Register the menu with a `FocusManager` under this id so routed keys
   * (via `useInput`) drive it through the core `menuKey`. Omit to leave
   * the menu inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired when a leaf item is activated (the Enter key or a mouse click on
   *  it) — the state's `activated` carries the item's key. */
  onSelect?: (state: MenuState) => void;
  /** Fired when the Escape key routes to this menu (dismissal). */
  onDismiss?: (state: MenuState) => void;
}

/**
 * The `<Input>` host component: a framed box with a text leaf carrying the
 * value and caret (core `Input` factory). When `focusId` is given, the input
 * registers with a `FocusManager` on mount and routed keys (via `useInput`)
 * edit it through the core `editKey` — `onChange` fires after the value or
 * caret changes and `onSubmit` on Enter. Routed paste events (via
 * `usePaste`) auto-paste into the node through the core `pasteInto` when the
 * input is focused — `onChange` fires after the paste changes the value. The
 * input's ref is managed internally (like `<StreamingText>`); the element
 * takes no React children — its composition is fixed by the factory.
 */
export function Input(props: InputProps): ReactElement<InputProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onSubmitRef = useRef(props.onSubmit);
  onSubmitRef.current = props.onSubmit;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props;
      const next = editKey(node, event);
      const changed = next.value !== before.value || next.caret !== before.caret;
      if (event.name === "enter") {
        onSubmitRef.current?.({ value: next.value, caret: next.caret });
      } else if (changed) {
        onChangeRef.current?.({ value: next.value, caret: next.caret });
      }
    }, manager, (text) => {
      // A routed paste auto-pastes into the focused input (pasteInto is
      // multi-width aware at the caret) and reports the new state, mirroring
      // a char-key edit. An empty paste is a no-op (the value is unchanged).
      const before = node.props;
      const next = pasteInto(node, text);
      const changed = next.value !== before.value || next.caret !== before.caret;
      if (changed) onChangeRef.current?.({ value: next.value, caret: next.caret });
    }).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_INPUT, {
    ...(resolveHostTheme(theme, { ...props, component: "input" }) as InputProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<Textarea>`: the tern node props plus the multi-line edit model
 * and the focus/callback wiring. `lines` / `row` / `col` / `width` / `height`
 * / `scroll` flow to the core `Textarea` factory; the remaining keys are
 * consumed by the component.
 */
export interface TextareaProps extends TernNodeProps {
  /** The logical lines of text (default `[""]`). */
  lines?: string[];
  /** The cursor row — an index into `lines` (default 0). */
  row?: number;
  /** The cursor column — a char index into `lines[row]` (default 0). */
  col?: number;
  /** The soft-wrap width in cells; unset keeps each line on one display row. */
  width?: number;
  /** The visible window in display rows; unset shows every display line. */
  height?: number;
  /** The top visible display row (vertical scroll, default 0). */
  scroll?: number;
  /**
   * Register the textarea with a `FocusManager` under this id so routed keys
   * (via `useInput`) edit it through the core `editTextareaKey`. Omit to
   * leave the textarea inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key changes the lines, row or col. */
  onChange?: (state: TextareaState) => void;
  /** Fired when the Enter key routes to this textarea (which also splits the
   *  line). */
  onSubmit?: (state: TextareaState) => void;
}

/**
 * The `<Textarea>` host component: a framed box with one text leaf per
 * visible display line (core `Textarea` factory). When `focusId` is given,
 * the textarea registers with a `FocusManager` on mount and routed keys (via
 * `useInput`) edit it through the core `editTextareaKey` — `onChange` fires
 * after the lines/row/col change and `onSubmit` on Enter (which splits the
 * line). Routed paste events (via `usePaste`) auto-paste into the node
 * through the core `pasteIntoTextarea` when the textarea is focused —
 * `onChange` fires after the paste changes the lines/row/col (a pasted `\n`
 * splits into new logical lines). The textarea's ref is managed internally
 * (like `<Input>`); the element takes no React children — its composition is
 * fixed by the factory.
 */
export function Textarea(props: TextareaProps): ReactElement<TextareaProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onSubmitRef = useRef(props.onSubmit);
  onSubmitRef.current = props.onSubmit;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props as TextareaProps;
      const next = editTextareaKey(node, event);
      const changed =
        next.lines !== before.lines || next.row !== before.row || next.col !== before.col;
      if (event.name === "enter") {
        onSubmitRef.current?.(next);
      } else if (changed) {
        onChangeRef.current?.(next);
      }
    }, manager, (text) => {
      // A routed paste auto-pastes into the focused textarea
      // (pasteIntoTextarea splits pasted newlines into logical lines) and
      // reports the new state, mirroring a char-key edit. An empty paste is
      // a no-op (the lines are unchanged).
      const before = node.props as TextareaProps;
      const next = pasteIntoTextarea(node, text);
      const changed =
        next.lines !== before.lines || next.row !== before.row || next.col !== before.col;
      if (changed) onChangeRef.current?.(next);
    }).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_TEXTAREA, {
    ...(resolveHostTheme(theme, { ...props, component: "textarea" }) as TextareaProps),
    ref: nodeRef,
  });
}

/**
 * The `<Spinner>` host component: a text leaf rendering a determinate bar or
 * an indeterminate frame glyph (core `Spinner` factory). While mounted, an
 * interval (`interval` prop, default 100ms) advances the frame via the core
 * `tick` and repaints the scene; the interval is cleared on unmount. The
 * element takes no React children.
 *
 * The tick is focus-aware (roadmap Phase 2): the effect subscribes to
 * `renderer.onFocus` and skips `tick()`/`render()` while `focus_gained` is
 * `false` — the frames are invisible while the terminal is unfocused, so the
 * redraw cost is wasted — resuming on focus regain.
 */
export function Spinner(props: SpinnerProps): ReactElement<SpinnerProps> {
  const { renderer } = useApp();
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const interval = props.interval ?? 100;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    // The terminal starts focused; the onFocus subscription flips the flag on
    // blur/regain so the interval skips tick()/render() while unfocused.
    let focused = true;
    const id = setInterval(() => {
      if (!focused) return;
      tick(node);
      renderer.render();
    }, interval);
    const unsubscribeFocus = renderer.onFocus((event) => {
      focused = event.focus_gained;
    });
    return () => {
      clearInterval(id);
      unsubscribeFocus();
    };
  }, [renderer, interval]);

  return createElement(HOST_SPINNER, {
    ...(resolveHostTheme(theme, { ...props, component: "spinner" }) as SpinnerProps),
    ref: nodeRef,
  });
}

/**
 * The `<StatusBar>` host component: a single-row flex strip whose children
 * are the left/center/right segment `Text` nodes (core `StatusBar` factory).
 * The `status_bar` component preset is resolved onto the strip's props at
 * element-creation time. Takes no React children.
 */
export function StatusBar(props: StatusBarProps): ReactElement<StatusBarProps> {
  const theme = useTheme();
  return createElement(
    HOST_STATUS_BAR,
    resolveHostTheme(theme, { ...props, component: "status_bar" }) as StatusBarProps,
  );
}

/**
 * The `<Panels>` host component: a flex stack of panel boxes, each with a
 * header `Text` and a body node (core `Panels` factory). The `panels`
 * component preset is resolved onto the stack's props at element-creation
 * time. Takes no React children.
 */
export function Panels(props: PanelsProps): ReactElement<PanelsProps> {
  const theme = useTheme();
  return createElement(
    HOST_PANELS,
    resolveHostTheme(theme, { ...props, component: "panels" }) as PanelsProps,
  );
}

/**
 * The `<DiffView>` host component: a scrollable column of per-line rows
 * rendering a unified diff (core `DiffView` factory) — a dimmed gutter with
 * the old/new line numbers, a `+`/`-`/` ` marker, and the line content
 * styled per kind (added green, deleted red, context dimmed). `scroll_x` /
 * `scroll_y` pan the rows inside the clip region; `wrap` passes through to
 * each content leaf. The `diff` component preset is resolved onto the root
 * box's props at element-creation time. Takes no React children.
 */
export function DiffView(props: DiffViewProps): ReactElement<DiffViewProps> {
  const theme = useTheme();
  return createElement(
    HOST_DIFF,
    resolveHostTheme(theme, { ...props, component: "diff" }) as DiffViewProps,
  );
}

/**
 * The `<Select>` host component: a flex column of text leaves — a filter
 * row, one option row per visible option (the highlighted row reversed,
 * multi-mode rows `✓ `/`  `-prefixed), and in multi mode a selected-count
 * summary row (core `Select` factory). When `focusId` is given, the select
 * registers with a `FocusManager` on mount and routed keys (via `useInput`)
 * drive it through the core `selectKey` — `onChange` fires after the
 * highlight/filter/selection changes, `onConfirm` on Enter and `onDismiss`
 * on Escape. The select's ref is managed internally; the element takes no
 * React children — its composition is fixed by the factory.
 */
export function Select(props: SelectProps): ReactElement<SelectProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onConfirmRef = useRef(props.onConfirm);
  onConfirmRef.current = props.onConfirm;
  const onDismissRef = useRef(props.onDismiss);
  onDismissRef.current = props.onDismiss;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props as SelectProps;
      const next = selectKey(node, event);
      const changed =
        next.highlighted !== before.highlighted ||
        next.filter !== before.filter ||
        next.value !== before.value ||
        next.open !== before.open;
      if (event.name === "enter") {
        onConfirmRef.current?.(next);
      } else if (event.name === "escape") {
        onDismissRef.current?.(next);
      } else if (changed) {
        onChangeRef.current?.(next);
      }
    }, manager).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_SELECT, {
    ...(resolveHostTheme(theme, { ...props, component: "select" }) as SelectProps),
    ref: nodeRef,
  });
}

