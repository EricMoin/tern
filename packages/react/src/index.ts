/**
 * @tern/react — react-reconciler custom renderer for tern.
 *
 * A mutation-mode custom renderer that drives the tern scene through
 * `packages/core`:
 *
 * - `<Box>` / `<Text>` are the two host components, backed by the core
 *   `Box(props)` / `Text(props)` factories. Bare string children are rejected
 *   at render time — text lives in an explicit `<Text text="..." />`.
 * - `render(element, renderer)` / `createRoot(renderer)` mount a tree onto a
 *   core renderer's scene root; every commit paints the scene via
 *   `renderer.render()`.
 * - `useApp()` exposes the app handle (renderer, scene root, exit/unmount);
 *   `useInput(handler)` subscribes to keyboard input for the tree.
 *
 * See `./reconciler.ts` for the HostConfig mapping table.
 */

import { createElement, type ReactElement, type ReactNode } from "react";
import type { NodeProps } from "@tern/core";

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

// ---------------------------------------------------------------------------
// Host components
// ---------------------------------------------------------------------------

// The host element tags are our own ("box" / "text"), not DOM tags. The tag
// constants are widened to `string` so `createElement` routes through the
// generic component overload: the literal `"text"` would otherwise collide
// with the SVG `<text>` element and the DOM/SVG overloads.
const HOST_BOX: string = "box";
const HOST_TEXT: string = "text";

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
export type { KeyEvent, Node, NodeProps, Renderer } from "@tern/core";
