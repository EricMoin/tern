//! The ScrollView element and the clip/scroll helpers every scrolling widget uses.

import { refreshStreamAffordance, showStreamAffordance, streamScrollStates } from "./markdown.ts";
import { Node, Text } from "./node.ts";
import { refreshTableWindow, tableRegionState } from "./table.ts";
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
/**
 * Props for the `ScrollView` element. The clip rect (`clip_x` / `clip_y` /
 * `clip_width` / `clip_height`) and the scroll offsets (`scroll_x` /
 * `scroll_y`) are the engine's existing scene region props; `showScrollbar`
 * and `children` are consumed by the factory (a scrollbar text leaf is
 * appended and content nodes are attached — neither key is a scene prop,
 * mirroring `Panels`' `panels` / `Select`'s `options` bookkeeping).
 */
export interface ScrollViewProps extends NodeProps {
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
   * (default `false`). The leaf is absolutely positioned at the clip region's
   * right edge; its track/thumb text is refreshed by {@link scrollTo} /
   * {@link scrollBy} / {@link scrollTop}.
   */
  showScrollbar?: boolean;
  /**
   * Content nodes passed through the props object (the Solid factory's path —
   * the universal renderer has no rest-arg children). `Box`-style rest-arg
   * children work too; both are attached to the composition and never reach
   * the scene props.
   */
  children?: Node[];
}

/** The thumb character of a scrollbar (painted at the scroll position). */
export const SCROLLBAR_THUMB_CHAR = "█";

/** The track character of a scrollbar (painted where there is no thumb). */
export const SCROLLBAR_TRACK_CHAR = "░";

/**
 * The scrollbar leaf's paint z-order (1). In-flow content stacks at z 0, so
 * the absolutely positioned scrollbar paints above scrolled content instead
 * of being covered by it (compositor z-order, the same mechanism `Select`'s
 * `floating` overlay uses).
 */
const SCROLLBAR_Z_INDEX = 1;

/** The scrollbar text leaf of a `scroll_view` node (JS bookkeeping — never
 *  scene props, mirroring `Panels`' `panelBodies`). */
const scrollbarLeaves = new WeakMap<Node, Node>();

/**
 * The JS-declared virtual content geometry of a scroll view (bookkeeping —
 * never scene props, mirroring `tableRegionStates`): the full content size
 * for a view whose content is *not* materialized as scene children. A
 * virtualized list materializes only the visible window, so the per-child
 * `contentSize()` walk in {@link scrollableContentSize} would measure the
 * window, never the dataset. See {@link declareVirtualContent}.
 */
const virtualContentSizes = new WeakMap<Node, ContentSize>();

/**
 * The thumb offset, thumb length and row text of a vertical scrollbar: one
 * row per viewport cell, `█` thumb rows at the scroll position and `░` track
 * rows elsewhere. The thumb length shrinks as the content overflows more
 * (`viewport/viewport` over `content`); the thumb offset moves the scroll
 * fraction along the remaining track.
 */
function scrollbarMetrics(
  scrollY: number,
  viewportHeight: number,
  contentHeight: number,
): { offset: number; thumb: number; text: string } {
  if (viewportHeight <= 0) return { offset: 0, thumb: 0, text: "" };
  const thumb = Math.max(
    1,
    Math.min(
      viewportHeight,
      Math.round(
        (viewportHeight * viewportHeight) / Math.max(1, contentHeight),
      ),
    ),
  );
  const overflow = Math.max(0, contentHeight - viewportHeight);
  const range = Math.max(0, viewportHeight - thumb);
  const offset = overflow > 0 ? Math.round((scrollY / overflow) * range) : 0;
  const rows: string[] = [];
  for (let i = 0; i < viewportHeight; i++) {
    rows.push(
      i >= offset && i < offset + thumb
        ? SCROLLBAR_THUMB_CHAR
        : SCROLLBAR_TRACK_CHAR,
    );
  }
  return { offset, thumb, text: rows.join("\n") };
}

/**
 * The measured `{ viewport, content }` pair a scroll offset clamps against.
 *
 * A `streaming_text` leaf measures itself: the content is the node's own
 * wrapped content (`Node.contentSize()` — the stream height in wrapped rows),
 * and the viewport is its clip rect (the `clip_height` / `clip_width` scene
 * props; a clip dimension that is unset falls back to the content size, so
 * nothing can scroll in that axis). Any other node measures its children
 * against the clip rect when the region declares one — a clip region's
 * viewport is what the engine clips and pans, so offsets clamp against the
 * `clip_height` / `clip_width` props, not the laid-out box (which can be
 * taller than the visible window, e.g. a table's content region) — and
 * against the node's own laid-out size otherwise.
 */
function scrollGeometry(
  view: Node,
): { viewport: ContentSize; content: ContentSize } {
  const content = view.contentSize();
  const props = view.props;
  const viewport: ContentSize = {
    width: typeof props.clip_width === "number"
      ? props.clip_width
      : content.width,
    height: typeof props.clip_height === "number"
      ? props.clip_height
      : content.height,
  };
  if (view.type === "streaming_text") {
    return { viewport, content };
  }
  return { viewport, content: scrollableContentSize(view, viewport) };
}

/**
 * Declare the virtual content size of a scroll view: the full content
 * geometry the scroll clamp measures for content that is not materialized as
 * scene children. A virtualized list paints only the visible window, so the
 * measured path — walking `view.children` and calling `contentSize()` per
 * child — would measure the window, never the dataset (the same problem
 * `tableRegionStates` solves for a table's windowed content region).
 *
 * Once declared, {@link maxScroll} — and therefore {@link scrollTo} /
 * {@link scrollBy} / {@link scrollTop} and `renderScrollbar` — measures the
 * declared geometry and never walks the children: O(1) per scroll instead of
 * O(children). The declaration is JS bookkeeping, never scene props, and the
 * size is floored at the viewport exactly like the measured path (content
 * that fits cannot scroll).
 *
 * A `streaming_text` view measures its own stream (the node *is* the
 * content) and ignores the declaration; a table region keeps priority:
 * for a table node (or its content region) the full-dataset geometry
 * recorded by the table stands in regardless of any declaration. The
 * declaration lives in a `WeakMap`, so it is collected with the view;
 * re-declaring replaces the previous geometry.
 */
export function declareVirtualContent(view: Node, size: ContentSize): void {
  virtualContentSizes.set(view, { width: size.width, height: size.height });
}

/**
 * The scrollable content size of a scroll view: the larger of the view's own
 * laid-out size — a growing box measures its stacked content, e.g. a table's
 * content region — and its children's extents — a fixed-size scroll view's
 * content overflows its viewport-sized box — floored at the viewport size (so
 * an empty view — or content that fits — measures exactly the viewport and
 * cannot scroll). The scrollbar leaf is excluded: it is a viewport
 * decoration, not content.
 *
 * Content whose nodes are not all materialized cannot be measured this way,
 * so two JS-known records stand in, checked — in this order — before the
 * child walk: a table region's (or table root's) full-dataset geometry in
 * `tableRegionStates`, then the caller's {@link declareVirtualContent}
 * geometry. Both are bookkeeping, never scene props.
 */
function scrollableContentSize(view: Node, viewport: ContentSize): ContentSize {
  const table = tableRegionState(view);
  if (table !== undefined) {
    return {
      width: Math.max(table.contentWidth, viewport.width),
      height: Math.max(table.contentHeight, viewport.height),
    };
  }
  const declared = virtualContentSizes.get(view);
  if (declared !== undefined) {
    return {
      width: Math.max(declared.width, viewport.width),
      height: Math.max(declared.height, viewport.height),
    };
  }
  const scrollbar = scrollbarLeaves.get(view);
  let width = view.contentSize().width;
  let height = view.contentSize().height;
  for (const child of view.children) {
    if (child === scrollbar) continue;
    const size = child.contentSize();
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  }
  return {
    width: Math.max(width, viewport.width),
    height: Math.max(height, viewport.height),
  };
}

/** The current scroll offset of a scroll view (0 when unset). */
export function currentScroll(view: Node): { x: number; y: number } {
  const props = view.props;
  return {
    x: typeof props.scroll_x === "number" ? props.scroll_x : 0,
    y: typeof props.scroll_y === "number" ? props.scroll_y : 0,
  };
}

/** The max scroll offsets of a view: content minus viewport, floored at 0 (a
 *  view whose content fits cannot scroll). */
export function maxScroll(view: Node): { x: number; y: number } {
  const { viewport, content } = scrollGeometry(view);
  return {
    x: Math.max(0, content.width - viewport.width),
    y: Math.max(0, content.height - viewport.height),
  };
}

/** Clamp a requested scroll offset to the content bounds. */
function clampScroll(
  view: Node,
  x: number,
  y: number,
): { x: number; y: number } {
  const max = maxScroll(view);
  return {
    x: Math.max(0, Math.min(x, max.x)),
    y: Math.max(0, Math.min(y, max.y)),
  };
}

/**
 * Refresh a scroll view's scrollbar leaf from the current scroll offset and
 * the measured viewport/content sizes. A no-op while the view is detached
 * (its `contentSize` would error) or when the view has no scrollbar.
 *
 * The leaf is absolutely positioned at the clip region's right edge. Its
 * `top` inset is `thumbOffset + scroll_y`: the region's own scroll offset
 * pans subtree drawing up by `scroll_y` (buffer.rs: `x - scroll_x`), so the
 * compensated inset keeps the thumb painted at `thumbOffset` — fixed in the
 * viewport while tracking the scroll. A `z_index` of 1 paints it above the
 * in-flow content.
 */
export function renderScrollbar(view: Node): void {
  const leaf = scrollbarLeaves.get(view);
  if (leaf === undefined || !view.attached) return;
  const viewport = view.contentSize();
  const content = scrollableContentSize(view, viewport);
  const scroll = currentScroll(view);
  const metrics = scrollbarMetrics(scroll.y, viewport.height, content.height);
  leaf.setProps({
    ...leaf.props,
    position: "absolute",
    right: 0,
    top: metrics.offset + scroll.y,
    width: 1,
    height: viewport.height,
    z_index: SCROLLBAR_Z_INDEX,
    text: metrics.text,
  });
}

/**
 * Create a `scroll_view` element: a box carrying the engine's scene region
 * props — a clip rect (`clip_x` / `clip_y` / `clip_width` / `clip_height`)
 * and a scroll offset (`scroll_x` / `scroll_y`) — whose children are the
 * scrollable content. Content may be passed as rest-arg children (`Box`-style)
 * or via the `children` prop (the Solid factory's path); the keys are
 * consumed and never reach the scene props. With `showScrollbar`, a vertical
 * scrollbar text leaf (track + thumb) is appended to the composition,
 * absolutely positioned at the clip region's right edge and refreshed by
 * {@link scrollTo} / {@link scrollBy} / {@link scrollTop}. No new napi node
 * kind: the `scroll_view` element materializes as a `box` (constitution).
 */
export function ScrollView(
  props: ScrollViewProps = {},
  ...children: Node[]
): Node {
  const content: Node[] = [...children];
  if (Array.isArray(props.children)) content.push(...props.children);
  const rootProps: NodeProps = { ...props };
  const plain = rootProps as Record<string, unknown>;
  delete plain.showScrollbar;
  delete plain.children;
  const view = Node.create("scroll_view", rootProps, content);
  if (props.showScrollbar === true) {
    const leaf = Text({
      position: "absolute",
      right: 0,
      width: 1,
      z_index: SCROLLBAR_Z_INDEX,
      text: "",
    });
    view.addChild(leaf);
    scrollbarLeaves.set(view, leaf);
  }
  return view;
}

/**
 * Scroll a scroll view to an absolute offset, clamped to the content bounds
 * — `Node.contentSize()` of the content vs the view's own laid-out size (the
 * viewport). Updates the view's `scroll_x` / `scroll_y` props and refreshes
 * the scrollbar. The view must be attached to the scene: the clamp measures
 * the laid-out sizes, and `contentSize` errors on a detached node. Returns
 * the applied offsets. The clamp measures the geometry declared by
 * {@link declareVirtualContent}, when one is set, instead of walking the
 * children.
 *
 * On a streaming node with auto-scroll enabled, a scroll to a position
 * *above* the content tail detaches the follow — the view stays pinned where
 * the user left it as the stream grows — and stamps the scroll-to-bottom
 * affordance at the clip region's bottom-right (see {@link followTail} to
 * re-attach, {@link scrollToBottom} to jump to the tail). Scrolling to/at
 * the tail keeps the current follow state.
 */
export function scrollTo(
  view: Node,
  x: number,
  y: number,
): { x: number; y: number } {
  const next = clampScroll(view, x, y);
  const state = streamScrollStates.get(view);
  if (state !== undefined && next.y < maxScroll(view).y) {
    // A manual scroll above the tail detaches the auto-follow; the view
    // stays pinned at the user's position (re-attach is `followTail`, a jump
    // to the tail is `scrollToBottom`). On a node whose auto-scroll is
    // enabled, the scroll-to-bottom affordance is stamped (idempotently) so
    // the user can see the stream is still growing above.
    if (state.following) state.following = false;
    if (state.autoScrollEnabled) showStreamAffordance(view);
  }
  const props = view.props;
  view.setProps({ ...props, scroll_x: next.x, scroll_y: next.y });
  renderScrollbar(view);
  refreshStreamAffordance(view);
  refreshTableWindow(view);
  return next;
}

/**
 * Scroll a scroll view by `dx` / `dy` cells from its current offset, clamped
 * to the content bounds. Returns the new applied offsets.
 */
export function scrollBy(
  view: Node,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const current = currentScroll(view);
  return scrollTo(view, current.x + dx, current.y + dy);
}

/**
 * Scroll a scroll view to the top: `scroll_y` becomes 0 (the horizontal
 * offset is kept) and the scrollbar is refreshed. Returns the applied
 * offsets.
 */
export function scrollTop(view: Node): { x: number; y: number } {
  const current = currentScroll(view);
  return scrollTo(view, current.x, 0);
}

