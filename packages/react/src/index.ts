/**
 * @tern-tui/react — react-reconciler custom renderer for tern.
 *
 * A mutation-mode custom renderer that drives the tern scene through
 * `packages/core`:
 *
 * - `<Box>` / `<Text>` / `<StreamingText>` are the host components, backed by
 *   the core `Box(props)` / `Text(props)` / `StreamingText(props)` factories.
 *   Bare string children are rejected at render time — text lives in an
 *   explicit `<Text text="..." />` element.
 * - The roadmap host components `<Input>` / `<Spinner>` / `<StatusBar>` /
 *   `<Panels>` / `<DiffView>` / `<Select>` / `<ScrollView>` / `<Table>` /
 *   `<Tabs>` / `<Progress>` / `<Modal>`
 *   materialize the core factories of the same name. `<Spinner>` runs its
 *   tick timer while mounted (cleared on unmount); `<Input>` / `<Select>` /
 *   `<Tabs>`
 *   with a `focusId` register with a `FocusManager` so routed keys edit them
 *   (`onChange` / `onSubmit`, `onChange` / `onConfirm` / `onDismiss`, and
 *   `onChange` / `onClose` for tabs).
 *   `<ScrollView>` is a clip/scroll region box (the engine's `clip_*` /
 *   `scroll_*` props); the core `scrollTo` / `scrollBy` / `scrollTop`
 *   helpers drive its offsets (clamped against `Node.contentSize()`),
 *   optionally with a track + thumb scrollbar leaf. `<Table>` composes a
 *   sticky header row above a scrollable content region of per-column rows;
 *   the core `tableKey` / `visibleTableRows` helpers drive its highlight and
 *   scroll window. `<Progress>` is a framed gauge (ratatui Gauge parity)
 *   driven with the core `setProgress` on its scene node. `<Modal>` is a
 *   full-bleed overlay (dimmed backdrop +
 *   centered content box) stamped with a high `z_index`; the core
 *   `openModal` / `closeModal` helpers toggle it and move focus into/out of
 *   the overlay through the `FocusManager`.
 * - `render(element, renderer)` / `createRoot(renderer)` mount a tree onto a
 *   core renderer's scene root; every commit paints the scene via
 *   `renderer.render()`.
 * - `useApp()` exposes the app handle (renderer, scene root, exit/unmount);
 *   `useInput(handler)` subscribes to keyboard input for the tree, routing
 *   each key to the focused element's handler first (via the core
 *   `FocusManager`) and falling back to the tree handler. `usePaste(handler)`
 *   does the same for paste events: a paste routes to the focused element's
 *   paste handler first (a focused `<Input focusId>` / `<Textarea focusId>`
 *   auto-pastes into its node) and falls back to the tree handler.
 *   `useFocus()` hooks
 *   an arbitrary element's node into a `FocusManager`; `useFocusManager()`
 *   reads the tree's current `FocusManager` (the `FocusManagerContext`
 *   provider, or the core default `focusManager`), and `useFocusTraversal()`
 *   wires Tab / Shift+Tab to the manager's `next()` / `prev()` traversal,
 *   skipping an exclude list.
 *   `useResize(handler)` subscribes to terminal resize events, re-invoking
 *   `renderer.render()` after each so the compositor re-lays out at the new
 *   terminal size.
 *   `useTerminalDimensions()` returns the terminal's current
 *   `{ width, height }` as reactive state — seeded from `renderer.size` at
 *   mount, updated on every resize — the re-render counterpart to
 *   `useResize`.
 *   `useWheelScroll(viewRef)` maps wheel events onto a scrollable view's
 *   offsets; `useSelection()` wires mouse-drag text selection onto the
 *   renderer's native selection overlay (the core
 *   `startSelection` / `dragSelection` / `endSelection` / `copySelection`
 *   helpers — double-click word select, copy-on-release).
 *
 * See `./reconciler.ts` for the HostConfig mapping table.
 */

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
  useFocus as coreUseFocus,
  wheelScroll,
  type FocusManager,
  type DiffLine,
  type FocusHandle,
  type KeyHandler,
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
  type Theme,
  type ThemeComponent,
  type ThemeOverrides,
  type ThemeRole,
} from "@tern-tui/core";
import { useApp } from "./reconciler.ts";

export const name = "@tern-tui/react";
export const version = "0.2.0";

// ---------------------------------------------------------------------------
// Host component props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the tern host components: the tern node props (style +
 * layout keys, see `@tern-tui/core` `NodeProps`) plus React `children` and the
 * semantic theme hints `role` / `component` (consumed by the host component
 * via `resolveTheme` — never scene props).
 */
export interface TernNodeProps extends NodeProps {
  children?: ReactNode;
  /** Resolve the node's `fg`/`bg` from this palette role (consumed, never a
   *  scene prop). */
  role?: ThemeRole;
  /** Resolve the node's `fg`/`bg`/`border_style` from this component preset
   *  (consumed, never a scene prop). */
  component?: ThemeComponent;
}

/** Props for `<Box>`. */
export type BoxProps = TernNodeProps;

/** Props for `<Text>`. */
export type TextProps = TernNodeProps;

/**
 * Props for `<StreamingText>`: the tern node props plus the stream feed and
 * its behavior flags.
 */
export interface StreamingTextProps extends TernNodeProps {
  /** The async stream of styled spans appended to the node. */
  stream: AsyncIterable<Span>;
  /**
   * Follow the stream tail as it grows (default `true`). While following,
   * each appended span pins the node's `scroll_y` to the content tail — the
   * stream's `Node.contentSize()` height vs the `clip_height` viewport (see
   * `@tern-tui/core` `syncStreamTail` / `followTail`). A manual scroll above the
   * tail (via `scrollTo` / `scrollBy` / `scrollTop`) detaches the follow,
   * pins the view where the user left it, and stamps the `▼` scroll-to-bottom
   * affordance at the clip region's bottom-right (`@tern-tui/core`
   * `STREAM_AFFORDANCE_CHAR`); `followTail` re-attaches and `scrollToBottom`
   * jumps to the tail, both dismissing it.
   */
  autoScroll?: boolean;
  /**
   * Soft-wrap long spans at the node width (default `true`). When `false`
   * the stream paints as a SINGLE row trimmed at the right edge (the core
   * compositor's `wrap: false` single-row paint); pair with `ellipsis` to
   * stamp `…` on the last visible cell when content is cut off.
   */
  wrap?: boolean;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The React context carrying the active `Theme`. Defaults to the core
 * `defaultTheme`, so host components resolve against the default theme when
 * no `ThemeProvider` is mounted (provider fallback).
 */
export const ThemeContext: Context<Theme> = createContext<Theme>(defaultTheme);

/** Props for `ThemeProvider`: the (partial) theme plus the tree it applies
 * to. The theme is merged over the core `defaultTheme`, so a partial theme
 * keeps the default palette/presets for everything it does not override. */
export interface ThemeProviderProps {
  /** The theme (or a partial override) applied to the subtree. */
  theme?: ThemeOverrides;
  children?: ReactNode;
}

/**
 * Provide a theme to the host components below it. The given `theme` is
 * merged over the core `defaultTheme` (`mergeTheme`), so partial overrides
 * keep the default palette and presets. Host components (`<Box>`, `<Text>`,
 * the roadmap components) resolve their `role` / `component` hints against
 * this theme at element-creation time, stamping plain `fg` / `bg` /
 * `border_style` node props.
 */
export function ThemeProvider(props: ThemeProviderProps): ReactElement<ThemeProviderProps> {
  const theme = useMemo(
    () => (props.theme === undefined ? defaultTheme : mergeTheme(defaultTheme, props.theme)),
    [props.theme],
  );
  return createElement(ThemeContext.Provider, { value: theme }, props.children);
}

/**
 * The active theme for the current tree — the value of the nearest
 * `ThemeProvider`, or the core `defaultTheme` when none is mounted.
 */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

// ---------------------------------------------------------------------------
// Host components
// ---------------------------------------------------------------------------

// The host element tags are our own ("box" / "text" / "streaming_text"), not
// DOM tags. The tag constants are widened to `string` so `createElement`
// routes through the generic component overload: the literal `"text"` would
// otherwise collide with the SVG `<text>` element and the DOM/SVG overloads.
const HOST_BOX: string = "box";
const HOST_TEXT: string = "text";
const HOST_STREAMING_TEXT: string = "streaming_text";

/**
 * The `<Box>` host component: a container node (border, background, padding,
 * flex layout). Maps to the core `Box(props)` factory. The active theme is
 * resolved onto the props at element-creation time (`role` / `component`
 * hints become plain `fg` / `bg` / `border_style`).
 */
export function Box(props: BoxProps): ReactElement<BoxProps> {
  const theme = useTheme();
  return createElement(HOST_BOX, resolveTheme(theme, props) as BoxProps);
}

/**
 * The `<Text>` host component: a leaf node carrying its content in the
 * `text` prop. Maps to the core `Text(props)` factory. String children are
 * not allowed — use `<Text text="..." />`. The active theme is resolved onto
 * the props at element-creation time.
 */
export function Text(props: TextProps): ReactElement<TextProps> {
  const theme = useTheme();
  return createElement(HOST_TEXT, resolveTheme(theme, props) as TextProps);
}

/**
 * The `<StreamingText>` host component: a `streaming_text` node whose stream
 * is fed from an async iterable of styled spans. Maps to the core
 * `StreamingText(props)` factory; the stream is consumed by an effect (see
 * below), not by the scene node.
 *
 * On mount (and whenever `stream` changes) an effect iterates the async
 * iterable, appending each span to the node (`Node.appendSpan`) and painting
 * the scene (`renderer.render()`) after each append. Unmounting — or a
 * `stream` change — cancels the iteration via `iterator.return()`, the
 * AbortController-style cleanup that lets the producer run its own
 * teardown.
 *
 * With `autoScroll` (the default), each append also feeds the core auto-scroll
 * (`syncStreamTail`): the node's `scroll_y` stays pinned to the stream tail
 * (`Node.contentSize()` height vs the `clip_height` viewport) while the user
 * does not scroll up; a manual scroll above the tail detaches, pins the view,
 * and stamps the `▼` scroll-to-bottom affordance, and `followTail` (re-attach)
 * or `scrollToBottom` (one-shot jump to the tail — exported by this package)
 * dismiss it. A separate effect keeps the core follow state in sync with the
 * `autoScroll` prop (the reconciler strips the flag from the scene props, so
 * the core factory's default-on must be corrected for an explicit
 * `autoScroll: false`).
 */
export function StreamingText(props: StreamingTextProps): ReactElement<StreamingTextProps> {
  const { renderer } = useApp();
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;

    const iterator = props.stream[Symbol.asyncIterator]();
    let cancelled = false;

    (async () => {
      try {
        for (;;) {
          const { done, value } = await iterator.next();
          if (done || cancelled) break;
          node.appendSpan(value.text, value.style);
          // Auto-scroll: keep the view pinned to the growing stream tail when
          // following (a no-op while detached, when `autoScroll` is off, or
          // after a manual scroll detached the follow).
          syncStreamTail(node);
          renderer.render();
        }
      } finally {
        // The producer keeps its cleanup on `return()`; on a stream that
        // completed on its own this is a no-op on the exhausted iterator.
        if (!cancelled) await iterator.return?.();
      }
    })();

    return () => {
      cancelled = true;
      // AbortController-style cleanup: signal the producer to stop and
      // unblock any in-flight next() so it can run its own teardown.
      iterator.return?.();
    };
  }, [renderer, props.stream]);

  // Sync the core follow state with the `autoScroll` flag. The reconciler
  // strips `autoScroll` before the core factory sees it, so the node defaults
  // to following; this corrects an explicit `autoScroll: false` and re-enables
  // on toggle. The node ref is stable across renders.
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    setStreamAutoScroll(node, props.autoScroll !== false);
  }, [props.autoScroll]);

  return createElement(HOST_STREAMING_TEXT, {
    ...(resolveTheme(theme, props) as StreamingTextProps),
    ref: nodeRef,
  });
}

// ---------------------------------------------------------------------------
// Roadmap host components
//
// These materialize the @tern-tui/core roadmap factories (subtask 3) as React
// host elements. The React-only wiring lives in the component functions below
// (effects, refs, focus registration); the reconciler's `createInstance`
// maps the host tags to the core factories (see `./reconciler.ts`).
// ---------------------------------------------------------------------------

// Host tags for the roadmap elements — again widened to `string` so
// `createElement` routes through the generic component overload.
const HOST_INPUT: string = "input";
const HOST_TEXTAREA: string = "textarea";
const HOST_SPINNER: string = "spinner";
const HOST_STATUS_BAR: string = "status_bar";
const HOST_PANELS: string = "panels";
const HOST_DIFF: string = "diff";
const HOST_SELECT: string = "select";
const HOST_SCROLL_VIEW: string = "scroll_view";
const HOST_TABLE: string = "table";
const HOST_TABS: string = "tabs";
const HOST_PROGRESS: string = "progress";
const HOST_MODAL: string = "modal";

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
    ...(resolveTheme(theme, { ...props, component: "input" }) as InputProps),
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
    ...(resolveTheme(theme, { ...props, component: "textarea" }) as TextareaProps),
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
    ...(resolveTheme(theme, { ...props, component: "spinner" }) as SpinnerProps),
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
    resolveTheme(theme, { ...props, component: "status_bar" }) as StatusBarProps,
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
    resolveTheme(theme, { ...props, component: "panels" }) as PanelsProps,
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
    resolveTheme(theme, { ...props, component: "diff" }) as DiffViewProps,
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
    ...(resolveTheme(theme, { ...props, component: "select" }) as SelectProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<ScrollView>`: the tern node props plus the engine's scene
 * region props (the clip rect and the scroll offset) and the scrollbar flag,
 * forwarded verbatim to the core `ScrollView` factory. The view's content is
 * its React children (the reconciler appends them after the scrollbar leaf).
 */
export interface ScrollViewProps extends TernNodeProps {
  /** The clip rect's left edge in cells (default unset — no clip). */
  clip_x?: number;
  /** The clip rect's top edge in cells (default unset — no clip). */
  clip_y?: number;
  /** The clip rect's width in cells (default unset — no clip). */
  clip_width?: number;
  /** The clip rect's height in cells (default unset — no clip). */
  clip_height?: number;
  /** The horizontal scroll offset in cells (default 0). */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0). */
  scroll_y?: number;
  /**
   * Append a vertical scrollbar text leaf (track + thumb) to the composition
   * (default `false`), refreshed by the core `scrollTo` / `scrollBy` /
   * `scrollTop` helpers.
   */
  showScrollbar?: boolean;
}

/**
 * The `<ScrollView>` host component: a clip/scroll region box carrying the
 * engine's `clip_x` / `clip_y` / `clip_width` / `clip_height` and `scroll_x`
 * / `scroll_y` props (core `ScrollView` factory). Its content is the React
 * children, and the core `scrollTo` / `scrollBy` / `scrollTop` helpers drive
 * the offsets (clamped against `Node.contentSize()`). The `scroll_view`
 * component preset is resolved onto the box's props at element-creation
 * time. Takes React children.
 */
export function ScrollView(props: ScrollViewProps): ReactElement<ScrollViewProps> {
  const theme = useTheme();
  return createElement(
    HOST_SCROLL_VIEW,
    resolveTheme(theme, { ...props, component: "scroll_view" }) as ScrollViewProps,
  );
}

/**
 * Props for `<Table>`: the tern node props plus the column/row model and the
 * interactive state, forwarded verbatim to the core `Table` factory (`columns`
 * / `rows` are JS bookkeeping — the model becomes composed text leaves and
 * never reaches the scene props).
 */
export interface TableProps extends TernNodeProps {
  /** The columns, in display order (left to right). */
  columns: TableColumn[];
  /** The data rows, in display order (top to bottom); one cell per column. */
  rows: (string | number)[][];
  /** The horizontal scroll offset in cells (default 0). */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0). */
  scroll_y?: number;
  /** The highlighted data-row index (default 0). */
  highlight?: number;
  /** Keep the header pinned above the content region (default `true`). */
  sticky_header?: boolean;
  /** The content region's viewport height in rows (default unset). */
  clip_height?: number;
}

/**
 * The `<Table>` host component: a flex column of box/text leaves — a header
 * row (sticky by default, painted above the content region) and one row leaf
 * per data row with per-column width/alignment (core `Table` factory). The
 * `table` component preset is resolved onto the root box's props at
 * element-creation time. Drive it with the core `tableKey` (up/down move the
 * highlight and auto-scroll) and read the visible window with
 * `visibleTableRows`. Takes no React children.
 */
export function Table(props: TableProps): ReactElement<TableProps> {
  const theme = useTheme();
  return createElement(
    HOST_TABLE,
    resolveTheme(theme, { ...props, component: "table" }) as TableProps,
  );
}

/**
 * Props for `<Modal>`: the tern node props plus the overlay state and the
 * content node list. `open` / `backdrop` / `z_index` flow to the core
 * `Modal` factory (the overlay's paint z-order and visible state); `content`
 * is JS bookkeeping — the core `Node`s wrapped into the centered content
 * box (mirroring `<Panels>`' `panels`; the element takes no React children).
 */
export interface ModalProps extends TernNodeProps {
  /** Whether the modal is open (default `false` — hidden). The core
   *  `openModal` / `closeModal` toggle it. */
  open?: boolean;
  /** Whether the dimmed backdrop box is composed (default `true`). */
  backdrop?: boolean;
  /** The overlay's paint z-order (default `MODAL_Z_INDEX`). */
  z_index?: number;
  /** The core `Node`s wrapped into the modal's centered content box. */
  content?: Node[];
}

/**
 * The `<Modal>` host component: a full-bleed overlay — a dimmed backdrop box
 * plus a centered content box holding `content`, stamped with a high
 * `z_index` so it paints above in-flow content (core `Modal` factory). The
 * element takes no React children; the content is the core `Node[]` from the
 * `content` prop (mirroring `<Panels>`). Open/close it with the core
 * `openModal` / `closeModal` on the modal node (the `ref` forwards to the
 * scene node), which also move focus into/out of the overlay through the
 * `FocusManager`. The `modal` host tag is mapped in `./reconciler.ts`.
 */
export function Modal(props: ModalProps): ReactElement<ModalProps> {
  const theme = useTheme();
  return createElement(HOST_MODAL, resolveTheme(theme, props) as ModalProps);
}

/**
 * Props for `<Tabs>`: the tern node props plus the tab spec list, the
 * interactive state and the focus/callback wiring. `tabs` / `active` /
 * `closable` flow to the core `Tabs` factory (the spec list is JS
 * bookkeeping and never reaches the scene props); the remaining keys are
 * consumed by the component.
 */
export interface TabsProps extends TernNodeProps {
  /** The tabs, in display order (left to right). Each spec's `content` nodes
   * are core `Node`s (e.g. obtained from host element refs) rendered in the
   * content region while the tab is active. */
  tabs: TabSpec[];
  /** The active tab index (default 0). */
  active?: number;
  /** Show a close affordance on every tab (default `false`; a per-tab
   * `closable` overrides it). */
  closable?: boolean;
  /**
   * Register the tabs with a `FocusManager` under this id so routed keys
   * (via `useInput`) drive it through the core `tabsKey`. Omit to leave the
   * tabs inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  focusManager?: FocusManager;
  /** Fired after a routed key moves the active tab. */
  onChange?: (state: TabsState) => void;
  /** Fired after `ctrl+w` routes to the tabs and closes the active tab. */
  onClose?: (state: TabsState) => void;
}

/**
 * The `<Tabs>` host component: a flex column of box/text leaves — a tab bar
 * row (one `Text` leaf per tab; the active tab painted with the theme's
 * `primary` palette colors and reversed, its label prefixed with a top-border
 * marker, closable tabs carrying a close glyph) plus a content region box
 * holding the active tab's content nodes (core `Tabs` factory). When
 * `focusId` is given, the tabs register with a `FocusManager` on mount and
 * routed keys (via `useInput`) drive them through the core `tabsKey` —
 * `onChange` fires when the active tab moves, `onClose` when `ctrl+w` closes
 * the active tab. The tabs' ref is managed internally; the element takes no
 * React children — its composition is fixed by the factory.
 */
export function Tabs(props: TabsProps): ReactElement<TabsProps> {
  const theme = useTheme();
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? useFocusManager();
  // The callbacks are read through refs so a parent re-render with new
  // callbacks is picked up without re-registering the element.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || props.focusId === undefined) return;
    return coreUseFocus(props.focusId, node, (event) => {
      const before = node.props as TabsProps;
      const beforeActive = typeof before.active === "number" ? before.active : 0;
      const barBefore = node.children[0]?.children.length ?? 0;
      const next = tabsKey(node, event);
      // A ctrl+w close shrinks the tab bar (tabsKey rebuilds the
      // composition); any other routed key leaves the bar count alone.
      const closed = (node.children[0]?.children.length ?? 0) < barBefore;
      if (closed) {
        onCloseRef.current?.(next);
      } else if (next.active !== beforeActive) {
        onChangeRef.current?.(next);
      }
    }, manager).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_TABS, {
    ...(resolveTheme(theme, props) as TabsProps),
    ref: nodeRef,
  });
}

/**
 * Props for `<Progress>`: the tern node props plus the bar model
 * (`value`/`max` or `ratio`), the label and the readout flag, forwarded
 * verbatim to the core `Progress` factory (the label / `show_percentage` keys
 * are consumed there and never reach the scene props).
 */
export interface ProgressProps extends TernNodeProps {
  /** The current progress value (default 0). */
  value?: number;
  /** The maximum value (default 100); the bar is full at `value === max`. */
  max?: number;
  /**
   * A 0..1 fill ratio as an alternative to `value`/`max`; when given it wins
   * over `value`/`max` for both the bar fill and the percentage readout.
   */
  ratio?: number;
  /** The optional label text, left-aligned inside the bar area when there is
   * room (composed only when it fits alongside the percentage readout). */
  label?: string;
  /** Whether the percentage readout renders on the right (default `true`). */
  show_percentage?: boolean;
  /** The outer width in cells including the frame (default
   *  {@link PROGRESS_DEFAULT_WIDTH} — the inner bar width is this minus the
   *  frame's border columns). */
  width?: number;
}

/**
 * The `<Progress>` host component: a framed box (ratatui Gauge parity)
 * holding an in-flow fill leaf (`'▓'` × `ceil(value/max * inner)`, `'░'` for
 * the rest), an optional dimmed label leaf left-aligned inside the bar area
 * (composed only when it fits), and an optional percentage readout
 * (`ceil(value/max*100)%`) right-aligned inside it (core `Progress` factory).
 * The `progress` component preset is resolved onto the frame's props at
 * element-creation time. Drive a live bar without rebuilding with the core
 * `setProgress` on the scene node (the `ref` forwards to it). Takes no React
 * children.
 */
export function Progress(props: ProgressProps): ReactElement<ProgressProps> {
  const theme = useTheme();
  return createElement(HOST_PROGRESS, {
    ...(resolveTheme(theme, { ...props, component: "progress" }) as ProgressProps),
  });
}

// ---------------------------------------------------------------------------
// Focus hooks
// ---------------------------------------------------------------------------

/**
 * The tree's `FocusManager`, provided through React context. Defaults to the
 * core `focusManager`, so the focus hooks work without a provider; wrap the
 * tree (or a subtree) in `<FocusManagerContext.Provider value={manager}>` to
 * route the tree's focus wiring — `useFocusManager`, `useFocus` and
 * `useFocusTraversal` — through your own manager.
 */
export const FocusManagerContext: Context<FocusManager> = createContext<FocusManager>(focusManager);

/**
 * The current `FocusManager` for this tree: the one provided by
 * `FocusManagerContext` (if any), or the core default `focusManager`.
 */
export function useFocusManager(): FocusManager {
  return useContext(FocusManagerContext);
}

/** Options for `useFocus`. */
export interface UseFocusOptions {
  /** The `FocusManager` to register with (defaults to the tree's current
   *  manager — `useFocusManager()`). */
  manager?: FocusManager;
}

/**
 * Register an element with a `FocusManager` so routed keys (via `useInput`)
 * reach its key handler. The element's scene node is read from `nodeRef`,
 * which must be attached to a host element that forwards refs (e.g.
 * `<Box ref={nodeRef} />`); refs populate after commit, so registration
 * happens in an effect and is torn down on unmount. Returns the core focus
 * handle (`focus` / `blur` / `isFocused` / `dispose`).
 */
export function useFocus(
  id: string,
  nodeRef: RefObject<Node | null>,
  onKey: KeyHandler,
  options?: UseFocusOptions,
): FocusHandle {
  const manager = options?.manager ?? useFocusManager();
  // The handler is read through a ref so a parent re-render with a new
  // handler is picked up without re-registering the element.
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    return coreUseFocus(id, node, (event) => onKeyRef.current(event), manager).dispose;
  }, [id, manager, nodeRef]);

  return useMemo(
    () => ({
      focus: () => manager.focus(id),
      blur: () => manager.blur(),
      isFocused: () => manager.activeId === id,
      dispose: () => manager.unregister(id),
    }),
    [id, manager],
  );
}

/** Options for `useFocusTraversal`. */
export interface UseFocusTraversalOptions {
  /** The `FocusManager` to traverse (defaults to the tree's current manager
   *  — `useFocusManager()`). */
  manager?: FocusManager;
  /** Focus ids to skip when moving: Tab / Shift+Tab never land on a listed
   *  id (when every registered id is excluded, focus stays put). */
  exclude?: string[];
}

/**
 * Wire Tab / Shift+Tab focus traversal for the tree: Tab calls
 * `manager.next()` and Shift+Tab (the `backtab` key) calls `manager.prev()`,
 * skipping the ids in `exclude`, re-invoking `renderer.render()` after each
 * move so the compositor repaints the newly focused element.
 *
 * The subscription listens on the renderer's key channel (the same channel
 * `useInput` subscribes to) but handles Tab / Shift+Tab ahead of
 * focused-element routing: traversal keys always move focus, even while an
 * element is focused (standard TUI behavior — element handlers leave bare
 * Tab / Shift+Tab untouched). All other keys fall through to the remaining
 * subscribers untouched.
 *
 * The `exclude` list is read through a ref so a parent re-render with a new
 * list is picked up without re-subscribing. Returns nothing; the subscription
 * is torn down when the component unmounts.
 */
export function useFocusTraversal(options?: UseFocusTraversalOptions): void {
  const { renderer } = useApp();
  const manager = options?.manager ?? useFocusManager();
  // The exclude list is read through a ref so a parent re-render with a new
  // list is picked up without re-subscribing.
  const excludeRef = useRef(options?.exclude);
  excludeRef.current = options?.exclude;

  useEffect(() => {
    return renderer.onKey((event) => {
      const excluded =
        excludeRef.current === undefined ? undefined : new Set(excludeRef.current);
      if (event.name === "tab") {
        if (traverseFocus(manager, excluded, true)) renderer.render();
      } else if (event.name === "backtab") {
        if (traverseFocus(manager, excluded, false)) renderer.render();
      }
    });
  }, [renderer, manager]);
}

/**
 * Move the active focus one step forward (`forward`) or backward, skipping
 * the ids in `exclude` (wrapping around the registration order). Returns
 * whether the focus landed on a non-excluded id; when nothing is registered
 * or every registered id is excluded, the focus is left unchanged and `false`
 * is returned (the caller then skips the repaint).
 */
function traverseFocus(
  manager: FocusManager,
  exclude: ReadonlySet<string> | undefined,
  forward: boolean,
): boolean {
  const start = manager.activeId;
  const step = forward ? () => manager.next() : () => manager.prev();
  // One step beyond the excluded set: the worst case walks past every
  // excluded id (or wraps back to the start) before landing on a keeper.
  const maxSteps = (exclude?.size ?? 0) + 1;
  for (let i = 0; i < maxSteps; i++) {
    if (!step()) return false; // nothing registered — no move
    const id = manager.activeId;
    if (id !== null && (exclude === undefined || !exclude.has(id))) return true;
  }
  // Every registered id is excluded: undo the probe so the focus is unchanged.
  if (start === null) manager.blur();
  else if (manager.has(start)) manager.focus(start);
  return false;
}

/**
 * Subscribe to terminal resize events for the current tree. The handler
 * receives the new size as `{ width, height }` (the core `ResizeHandler`
 * payload); after it runs, `renderer.render()` is re-invoked so the
 * compositor re-lays out the scene at the new terminal size. The handler is
 * read through a ref so a parent re-render with a new handler is picked up
 * without re-subscribing. Returns nothing; the subscription is torn down when
 * the component unmounts.
 */
export function useResize(handler: ResizeHandler): void {
  const { renderer } = useApp();
  // The handler is read through a ref so a parent re-render with a new
  // handler is picked up without re-subscribing.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return renderer.onResize((event) => {
      handlerRef.current(event);
      // The compositor sizes the scene from the terminal; re-paint so the
      // layout reflects the new width/height.
      renderer.render();
    });
  }, [renderer]);
}

/**
 * Read the terminal's current dimensions as reactive state. Returns
 * `{ width, height }` seeded from `renderer.size` when the component mounts,
 * then updated on every terminal resize — the component re-renders with the
 * new size each time, so layout props (widths, clip regions, wrap widths,
 * table column widths) can be derived directly from the returned value
 * without a hand-wired `useResize` handler that re-renders by hand.
 *
 * The subscription listens on the renderer's resize channel (the same
 * channel `useResize` subscribes to) and updates local state from each
 * event's `{ width, height }` payload; after the update `renderer.render()`
 * is re-invoked so the compositor re-lays out the scene at the new terminal
 * size (the state update's own commit repaints as well — the extra paint is
 * idempotent, and guarantees the compositor re-lays out even when the
 * consuming component's rendered output does not change). Returns the live
 * `{ width, height }` object; the subscription is torn down when the
 * component unmounts.
 */
export function useTerminalDimensions(): { width: number; height: number } {
  const { renderer } = useApp();
  // The initial value is read lazily at mount: whatever the renderer reports
  // before the tree's first paint.
  const [size, setSize] = useState<{ width: number; height: number }>(() => renderer.size);

  useEffect(() => {
    return renderer.onResize((event) => {
      setSize(event);
      // The compositor sizes the scene from the terminal; re-paint so the
      // layout reflects the new width/height.
      renderer.render();
    });
  }, [renderer]);

  return size;
}

// ---------------------------------------------------------------------------
// Mouse hooks
// ---------------------------------------------------------------------------

/**
 * Wire mouse drag-resize for a `<Panels>` element (roadmap Phase 2). The
 * element's scene node must be read from `panelsRef` (e.g.
 * `<Panels ref={panelsRef} ... />` — refs populate after commit, so the
 * subscription is established in an effect and torn down on unmount).
 *
 * Mouse routing (via `Renderer.hit_test`): a `down_left` press starts a drag
 * only when the pressed cell is covered by a painted scene node — the gutter
 * cells inside the panels element are (the element's background covers them),
 * while dead cells outside any node are not. Once the drag starts, each
 * `drag_left` moves the split by setting the adjacent pane's `flex_basis`
 * (`dragPanels`, clamped to the pane's min size) and re-invokes
 * `renderer.render()` so the compositor re-flows; drags continue even when
 * the cursor leaves the stack (the clamp bounds the split). Any `up_*` event
 * ends the drag (`endPanelDrag`).
 */
export function usePanelMouseDrag(panelsRef: RefObject<Node | null>): void {
  const { renderer } = useApp();

  useEffect(() => {
    return renderer.onMouse((event) => {
      const panels = panelsRef.current;
      if (panels === null) return;
      if (event.kind === "down_left") {
        // The press must land on a painted cell: `hit_test` returns the scene
        // node ids covering the cell (empty off any node — the scene root is
        // never reported, so a cell the panels element does not cover misses).
        if (renderer.hit_test(event.column, event.row).length === 0) return;
        startPanelDrag(panels, event);
      } else if (event.kind === "drag_left") {
        if (dragPanels(panels, event) !== null) renderer.render();
      } else if (event.kind.startsWith("up_")) {
        endPanelDrag(panels);
      }
    });
  }, [renderer, panelsRef]);
}

/**
 * Wire mouse wheel scroll for a scrollable element (a `<ScrollView>`, a
 * `<Table>`, a `<DiffView>`, or any node carrying the engine's clip/scroll
 * region props). The element's scene node must be read from `viewRef` (e.g.
 * `<ScrollView ref={viewRef} ... />` — refs populate after commit, so the
 * subscription is established in an effect and torn down on unmount).
 *
 * Each wheel event (`scroll_up` / `scroll_down` / `scroll_left` /
 * `scroll_right`) is mapped by the core `wheelScroll` helper onto the view's
 * scroll offsets (clamped to the content bounds); a consumed wheel repaints
 * the scene so the compositor reflects the new offset (a `table` scrolls its
 * scrollable content region, keeping the sticky header pinned). Non-wheel
 * events and wheels on non-scrollable nodes fall through untouched.
 */
export function useWheelScroll(viewRef: RefObject<Node | null>): void {
  const { renderer } = useApp();

  useEffect(() => {
    return renderer.onMouse((event) => {
      const view = viewRef.current;
      if (view === null) return;
      if (wheelScroll(view, event)) renderer.render();
    });
  }, [renderer, viewRef]);
}

/**
 * Wire mouse-drag text selection for the renderer (roadmap Phase 5). The
 * core selection module is a per-renderer state machine over the native
 * selection overlay:
 *
 * - a `down_left` press anchors a selection session at the pressed cell
 *   ({@link startSelection}) — a second press on a nearby cell within
 *   `SELECTION_DOUBLE_CLICK_MS` ms is treated as a double-click and selects
 *   the word under the pointer instead;
 * - each `drag_left` moves the active endpoint to the dragged cell,
 *   extending the selection rect ({@link dragSelection});
 * - any `up_*` release copies the selected text to the clipboard and ends
 *   the session ({@link copySelection} before {@link endSelection} —
 *   copy-on-release: the overlay is clear-on-release, so the text must be
 *   read while the gesture is still active; with no active session the copy
 *   is an empty write, a harmless no-op).
 *
 * The native overlay paints at the next `render()`, so every applied step
 * re-renders the scene (a `down_left` that starts a session, a `drag_left`
 * that extends it, an `up_*` that ends it); non-mouse events fall through
 * untouched. The subscription is torn down when the component unmounts.
 * Hosts that want a copy *key* can route the core {@link selectionKey}
 * (ctrl+shift+c) through `useInput`.
 */
export function useSelection(): void {
  const { renderer } = useApp();

  useEffect(() => {
    return renderer.onMouse((event) => {
      if (event.kind === "down_left") {
        if (startSelection(renderer, event) !== null) renderer.render();
      } else if (event.kind === "drag_left") {
        if (dragSelection(renderer, event) !== null) renderer.render();
      } else if (event.kind.startsWith("up_")) {
        // Copy-on-release before the clear: `endSelection` clears the
        // overlay, so the text must be read while the gesture is active.
        copySelection(renderer);
        if (endSelection(renderer, event) !== null) renderer.render();
      }
    });
  }, [renderer]);
}

/**
 * Wire click-to-focus for the current tree: every `down_left` press on a
 * painted cell focuses the topmost registered focusable node under the
 * cursor (the core `focusAt` helper — `Renderer.hit_test` gates the press to
 * a painted cell, then the live scene tree is walked for the first node the
 * `FocusManager` has registered, focused via its id). Elements registered
 * with `useFocus` — including `<Input focusId=...>`, `<Textarea focusId=...>`
 * and `<Select focusId=...>` — become click targets. Presses off any painted
 * cell are a no-op. The subscription is torn down when the component
 * unmounts.
 */
export function useClickToFocus(renderer: Renderer): void {
  useEffect(() => {
    return renderer.onMouse((event) => {
      focusAt(renderer, event);
    });
  }, [renderer]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { createRoot, render, useApp, useInput, usePaste } from "./reconciler.ts";
export type {
  AppHandle,
  TernContainer,
  TernNoTimeout,
  TernProps,
  TernRoot,
  TernTimeoutHandle,
  UseInputHandler,
  UseInputOptions,
  UsePasteHandler,
  UsePasteOptions,
} from "./reconciler.ts";
// The HostConfig itself is internal, but exported for tooling/tests:
export { hostConfig, toNodeProps } from "./reconciler.ts";

// Core types re-exported so consumers can type props, focus handles and
// input handlers without importing @tern-tui/core directly. (`FocusManager` is a
// class — it is exported as a value below, which carries its type.)
export type {
  DiffLine,
  FocusHandle,
  KeyEvent,
  KeyHandler,
  Node,
  NodeProps,
  PanelDragHandle,
  PanelDragResult,
  PanelSpec,
  PasteHandler,
  Renderer,
  ResizeHandler,
  SelectOption,
  SelectState,
  SelectionRange,
  Span,
  StatusBarSegment,
  TabSpec,
  TableColumn,
  TableState,
  TabsState,
  TextareaState,
} from "@tern-tui/core";
// Core values re-exported: the focus machinery, the element edit helpers
// used by the roadmap host components (including the paste counterparts
// `pasteInto` / `pasteIntoTextarea`, which the focused `<Input>` / `<Textarea>`
// auto-paste through), the scroll helpers (including the streaming auto-scroll
// `followTail` / `syncStreamTail` / `isStreamFollowing` / `scrollToBottom` and
// the `STREAM_AFFORDANCE_CHAR` scroll-to-bottom indicator), the panel
// drag-resize helpers, the modal helpers, and the theme surface.
export {
  activateTab,
  closeTab,
  closeModal,
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
  followTail,
  FocusManager,
  isStreamFollowing,
  mergeTheme,
  MODAL_Z_INDEX,
  openModal,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  scrollBy,
  scrollTo,
  scrollToBottom,
  scrollTop,
  selectKey,
  selectWordAt,
  SELECTION_DOUBLE_CLICK_MS,
  selectionKey,
  setProgress,
  startPanelDrag,
  startSelection,
  STREAM_AFFORDANCE_CHAR,
  syncStreamTail,
  tableKey,
  tabsKey,
  tick,
  visibleTableRows,
  wheelScroll,
} from "@tern-tui/core";
// Core theme types re-exported so consumers can type themes without
// importing @tern-tui/core directly.
export type {
  Theme,
  ThemeComponent,
  ThemeOverrides,
  ThemeResolvableProps,
  ThemeRole,
  ThemeRoleColors,
  ThemeStylePreset,
} from "@tern-tui/core";
