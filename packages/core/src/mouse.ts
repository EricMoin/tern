//! Mouse routing helpers: wheel scrolling and click-to-focus.

import { FocusManager, focusManager, isScrollableNode, wheelScrollTarget } from "./focus.ts";
import { Node } from "./node.ts";
import { Renderer } from "./renderer.ts";
import { scrollBy } from "./scrollview.ts";

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
 * Map a mouse wheel event to a scroll on `view`, returning whether the event
 * was consumed. The wheel direction names the content movement: `scroll_up`
 * pans the content up one cell (`scroll_y - 1`), `scroll_down` pans down
 * (`scroll_y + 1`), and `scroll_left` / `scroll_right` pan the columns the
 * same way (`scroll_x - 1` / `scroll_x + 1`). The offset is applied through
 * {@link scrollBy}, so it clamps to the content bounds (and a streaming view
 * scrolled above the tail detaches its auto-follow, mirroring
 * {@link scrollTo}).
 *
 * A `table` view scrolls its scrollable content region (the sticky header
 * stays pinned); any other scroll view scrolls itself. Returns `false` — a
 * no-op, so the event can fall through to other mouse handlers — for
 * non-wheel events (`down_left`, `moved`, ...), for wheel events on a
 * non-scrollable node (a plain box with no clip/scroll region), and for
 * wheel events on a detached view.
 */
export function wheelScroll(view: Node, event: MouseEventJs): boolean {
  let dx = 0;
  let dy = 0;
  switch (event.kind) {
    case "scroll_up":
      dy = -1;
      break;
    case "scroll_down":
      dy = 1;
      break;
    case "scroll_left":
      dx = -1;
      break;
    case "scroll_right":
      dx = 1;
      break;
    default:
      return false; // not a wheel event — not consumed
  }
  const target = wheelScrollTarget(view);
  if (target === null || !isScrollableNode(target)) return false;
  scrollBy(target, dx, dy);
  return true;
}

/**
 * Focus the topmost registered focusable node under a `down_left` press,
 * returning whether a focus was applied.
 *
 * Mouse routing (via `Renderer.hit_test`): the press must land on a painted
 * cell — `hit_test(col, row)` returns the scene node ids covering the cell
 * (empty off any node — the scene root is never reported, so a press in dead
 * space is a no-op). On a painted cell the press resolves to the topmost
 * registered focusable node: the live scene tree is walked from the root in
 * paint order and the first node the {@link FocusManager} has registered (via
 * `focusIdFor`) is the click target, focused through `manager.focus(id)`.
 *
 * Returns `false` — a no-op — for non-`down_left` events, for presses off any
 * painted cell, and for presses whose topmost node is not registered.
 */
export function focusAt(
  renderer: Renderer,
  event: MouseEventJs,
  manager: FocusManager = focusManager,
): boolean {
  if (event.kind !== "down_left") return false;
  if (renderer.hit_test(event.column, event.row).length === 0) return false;
  const id = topmostFocusId(renderer.root, manager);
  if (id === null) return false;
  return manager.focus(id);
}

/** The registered focus id of the topmost focusable node in `root`'s live
 * subtree: the first node in a pre-order (paint-order) walk that `manager`
 * has registered, or `null` when none is. */
function topmostFocusId(root: Node, manager: FocusManager): string | null {
  const id = manager.focusIdFor(root);
  if (id !== null) return id;
  for (const child of root.children) {
    const found = topmostFocusId(child, manager);
    if (found !== null) return found;
  }
  return null;
}

