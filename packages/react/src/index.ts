/**
 * @tern/react — react-reconciler custom renderer for tern.
 *
 * A mutation-mode custom renderer that drives the tern scene through
 * `packages/core`:
 *
 * - `<Box>` / `<Text>` / `<StreamingText>` are the host components, backed by
 *   the core `Box(props)` / `Text(props)` / `StreamingText(props)` factories.
 *   Bare string children are rejected at render time — text lives in an
 *   explicit `<Text text="..." />` element.
 * - The roadmap host components `<Input>` / `<Spinner>` / `<StatusBar>` /
 *   `<Panels>` materialize the core factories of the same name. `<Spinner>`
 *   runs its tick timer while mounted (cleared on unmount); `<Input>` with a
 *   `focusId` registers with a `FocusManager` so routed keys edit it
 *   (`onChange` / `onSubmit`).
 * - `render(element, renderer)` / `createRoot(renderer)` mount a tree onto a
 *   core renderer's scene root; every commit paints the scene via
 *   `renderer.render()`.
 * - `useApp()` exposes the app handle (renderer, scene root, exit/unmount);
 *   `useInput(handler)` subscribes to keyboard input for the tree, routing
 *   each key to the focused element's handler first (via the core
 *   `FocusManager`) and falling back to the tree handler. `useFocus()` hooks
 *   an arbitrary element's node into a `FocusManager`.
 *
 * See `./reconciler.ts` for the HostConfig mapping table.
 */

import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  editKey,
  focusManager,
  tick,
  useFocus as coreUseFocus,
  FocusManager,
  type FocusHandle,
  type KeyHandler,
  type Node,
  type NodeProps,
  type PanelSpec,
  type Span,
  type StatusBarSegment,
} from "@tern/core";
import { useApp } from "./reconciler.ts";

export const name = "@tern/react";
export const version = "0.1.0";

// ---------------------------------------------------------------------------
// Host component props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the tern host components: the tern node props (style +
 * layout keys, see `@tern/core` `NodeProps`) plus React `children`.
 */
export interface TernNodeProps extends NodeProps {
  children?: ReactNode;
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
   * Follow the stream tail as it grows (default `true`). The MVP compositor
   * always follows the tail, so the flag is accepted for API stability.
   */
  autoScroll?: boolean;
  /**
   * Soft-wrap long spans at the node width (default `true`). The MVP
   * compositor always soft-wraps, so the flag is accepted for API stability.
   */
  wrap?: boolean;
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
 * flex layout). Maps to the core `Box(props)` factory.
 */
export function Box(props: BoxProps): ReactElement<BoxProps> {
  return createElement(HOST_BOX, props);
}

/**
 * The `<Text>` host component: a leaf node carrying its content in the
 * `text` prop. Maps to the core `Text(props)` factory. String children are
 * not allowed — use `<Text text="..." />`.
 */
export function Text(props: TextProps): ReactElement<TextProps> {
  return createElement(HOST_TEXT, props);
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
 */
export function StreamingText(props: StreamingTextProps): ReactElement<StreamingTextProps> {
  const { renderer } = useApp();
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

  return createElement(HOST_STREAMING_TEXT, { ...props, ref: nodeRef });
}

// ---------------------------------------------------------------------------
// Roadmap host components
//
// These materialize the @tern/core roadmap factories (subtask 3) as React
// host elements. The React-only wiring lives in the component functions below
// (effects, refs, focus registration); the reconciler's `createInstance`
// maps the host tags to the core factories (see `./reconciler.ts`).
// ---------------------------------------------------------------------------

// Host tags for the roadmap elements — again widened to `string` so
// `createElement` routes through the generic component overload.
const HOST_INPUT: string = "input";
const HOST_SPINNER: string = "spinner";
const HOST_STATUS_BAR: string = "status_bar";
const HOST_PANELS: string = "panels";

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
  /** The `FocusManager` to register with (defaults to the core
   *  `focusManager`). */
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
 * The `<Input>` host component: a framed box with a text leaf carrying the
 * value and caret (core `Input` factory). When `focusId` is given, the input
 * registers with a `FocusManager` on mount and routed keys (via `useInput`)
 * edit it through the core `editKey` — `onChange` fires after the value or
 * caret changes and `onSubmit` on Enter. The input's ref is managed
 * internally (like `<StreamingText>`); the element takes no React children —
 * its composition is fixed by the factory.
 */
export function Input(props: InputProps): ReactElement<InputProps> {
  const nodeRef = useRef<Node | null>(null);
  const manager = props.focusManager ?? focusManager;
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
    }, manager).dispose;
  }, [props.focusId, manager]);

  return createElement(HOST_INPUT, { ...props, ref: nodeRef });
}

/**
 * The `<Spinner>` host component: a text leaf rendering a determinate bar or
 * an indeterminate frame glyph (core `Spinner` factory). While mounted, an
 * interval (`interval` prop, default 100ms) advances the frame via the core
 * `tick` and repaints the scene; the interval is cleared on unmount. The
 * element takes no React children.
 */
export function Spinner(props: SpinnerProps): ReactElement<SpinnerProps> {
  const { renderer } = useApp();
  const nodeRef = useRef<Node | null>(null);
  const interval = props.interval ?? 100;

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    const id = setInterval(() => {
      tick(node);
      renderer.render();
    }, interval);
    return () => clearInterval(id);
  }, [renderer, interval]);

  return createElement(HOST_SPINNER, { ...props, ref: nodeRef });
}

/**
 * The `<StatusBar>` host component: a single-row flex strip whose children
 * are the left/center/right segment `Text` nodes (core `StatusBar` factory).
 * Pure prop forwarding — no React-level wiring. Takes no React children.
 */
export function StatusBar(props: StatusBarProps): ReactElement<StatusBarProps> {
  return createElement(HOST_STATUS_BAR, props);
}

/**
 * The `<Panels>` host component: a flex stack of panel boxes, each with a
 * header `Text` and a body node (core `Panels` factory). Pure prop
 * forwarding — no React-level wiring. Takes no React children.
 */
export function Panels(props: PanelsProps): ReactElement<PanelsProps> {
  return createElement(HOST_PANELS, props);
}

// ---------------------------------------------------------------------------
// Focus hooks
// ---------------------------------------------------------------------------

/** Options for `useFocus`. */
export interface UseFocusOptions {
  /** The `FocusManager` to register with (defaults to the core
   *  `focusManager`). */
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
  const manager = options?.manager ?? focusManager;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { createRoot, render, useApp, useInput } from "./reconciler.ts";
export type {
  AppHandle,
  TernContainer,
  TernNoTimeout,
  TernProps,
  TernRoot,
  TernTimeoutHandle,
  UseInputHandler,
  UseInputOptions,
} from "./reconciler.ts";
// The HostConfig itself is internal, but exported for tooling/tests:
export { hostConfig, toNodeProps } from "./reconciler.ts";

// Core types re-exported so consumers can type props, focus handles and
// input handlers without importing @tern/core directly. (`FocusManager` is a
// class — it is exported as a value below, which carries its type.)
export type {
  FocusHandle,
  KeyEvent,
  KeyHandler,
  Node,
  NodeProps,
  PanelSpec,
  Renderer,
  Span,
  StatusBarSegment,
} from "@tern/core";
// Core values re-exported: the focus machinery and the element edit helpers
// used by the roadmap host components.
export { editKey, focusManager, FocusManager, tick } from "@tern/core";
