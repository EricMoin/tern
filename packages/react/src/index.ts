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
 * - `render(element, renderer)` / `createRoot(renderer)` mount a tree onto a
 *   core renderer's scene root; every commit paints the scene via
 *   `renderer.render()`.
 * - `useApp()` exposes the app handle (renderer, scene root, exit/unmount);
 *   `useInput(handler)` subscribes to keyboard input for the tree.
 *
 * See `./reconciler.ts` for the HostConfig mapping table.
 */

import {
  createElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Node, NodeProps, Span } from "@tern/core";
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

// Core types re-exported so consumers can type props and input handlers
// without importing @tern/core directly.
export type { KeyEvent, Node, NodeProps, Renderer, Span } from "@tern/core";
