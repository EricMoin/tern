//! The file list's state and its reducer.
//
// WHY THIS IS NOT IN `state.ts`. The pane's state (what it lists, what is
// highlighted, where its window sits) and the one reducer that moves the highlight
// are a seam of their own; `state.ts` was over its module budget. Activating an
// item asks the HOST to open a path — the reducer RETURNS that request instead of
// reaching for the effect queue, so this module mutates only the pane.
//
// WHICH CELLS the pane gets is `plan.ts`'s call (`sidebarScroll` reconciles the
// window against the height the plan laid out); this module never computes layout.

import type { PendingEffect } from "./state.ts";

/** The file list beside the editor. */
export interface SidebarState {
  visible: boolean;
  width: number;
  items: readonly string[];
  active: number;
  scroll: number;
}

/** The file list a host asked for: visible and wide by default. */
export function newSidebar(options: {
  items?: readonly string[];
  sidebarWidth?: number;
  sidebarVisible?: boolean;
}): SidebarState {
  return {
    visible: options.sidebarVisible ?? true,
    width: options.sidebarWidth ?? 20,
    items: options.items ?? [],
    active: 0,
    scroll: 0,
  };
}

/** Move the highlight, or ask the host to open the active item. Returns the effect
 * for `activate`, or `null`. */
export function reduceSidebar(
  state: SidebarState,
  action: "toggle" | "up" | "down" | "activate",
): PendingEffect | null {
  if (action === "toggle") {
    state.visible = !state.visible;
    return null;
  }
  if (action === "activate") {
    const item = state.items[state.active];
    return item === undefined ? null : { kind: "open", path: item };
  }
  const last = Math.max(0, state.items.length - 1);
  const moved = state.active + (action === "up" ? -1 : 1);
  state.active = Math.max(0, Math.min(last, moved));
  // The reducer moves the HIGHLIGHT and nothing else: which items are on screen is
  // the pane's window, reconciled by the plan against the pane's own height.
  return null;
}
