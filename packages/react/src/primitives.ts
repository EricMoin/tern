//! The three host primitives (Box, Text, StreamingText) and the prop types they take.

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
export const name = "@tern-tui/react";

export const version = "0.2.0";

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

/**
 * Attach the M4.5 runtime theme hint onto resolved host props. The core
 * `resolveTheme` stamps a module-private Symbol carrying `{ role,
 * component, stamped }` onto its output — the record the core runtime theme
 * engine (`setTheme`, M4.5 subtask 1) needs to re-resolve a node in place.
 * That Symbol cannot ride a React element (`createElement` copies config
 * with `for...in`, string keys only), so it is carried under the string
 * carrier key instead; `toNodeProps` re-materializes it before the core
 * factory call (see `./reconciler.ts`). When `resolveTheme` consumed no
 * hints, there is no Symbol and the props pass through unchanged — a node
 * created without `role` / `component` is never recorded, so a later
 * `setTheme` switch leaves it alone.
 */
function withThemeHint(resolved: NodeProps): NodeProps {
  const symbols = Object.getOwnPropertySymbols(resolved);
  if (symbols.length === 0) return resolved;
  const symbol = symbols[0]!;
  const payload = (resolved as unknown as Record<symbol, unknown>)[symbol];
  const out = { ...resolved } as Record<string, unknown>;
  out[THEME_HINT_CARRIER] = { symbol, payload };
  return out as NodeProps;
}

/**
 * The host components' resolution funnel: resolves `theme` onto `props`
 * exactly like the core `resolveTheme` (explicit props win, `component`
 * preset then `role` palette fill the remaining `fg` / `bg` /
 * `border_style`), and additionally attaches the runtime theme hint onto the
 * element props (see {@link withThemeHint}) so the core `setTheme` engine can
 * re-resolve the created node in place — a framework-driven re-render
 * (`ThemeProvider` theme change) still takes precedence when used.
 */
export function resolveHostTheme(theme: Theme, props: ThemeResolvableProps): NodeProps {
  return withThemeHint(resolveTheme(theme, props));
}

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
  return createElement(HOST_BOX, resolveHostTheme(theme, props) as BoxProps);
}

/**
 * The `<Text>` host component: a leaf node carrying its content in the
 * `text` prop. Maps to the core `Text(props)` factory. String children are
 * not allowed — use `<Text text="..." />`. The active theme is resolved onto
 * the props at element-creation time.
 */
export function Text(props: TextProps): ReactElement<TextProps> {
  const theme = useTheme();
  return createElement(HOST_TEXT, resolveHostTheme(theme, props) as TextProps);
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
    ...(resolveHostTheme(theme, props) as StreamingTextProps),
    ref: nodeRef,
  });
}

