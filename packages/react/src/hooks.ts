//! Focus, resize, mouse and selection hooks over the shared engine.

import { name } from "./primitives.ts";
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
 *   copy-on-release). The overlay is persistent after release: the
 *   highlight survives until `escape` ({@link selectionKey}), a bare press
 *   outside it (click-elsewhere), or a new selection replaces it; with no
 *   active session the copy is an empty write, a harmless no-op.
 *
 * The native overlay paints at the next `render()`, so every applied step
 * re-renders the scene (a `down_left` that starts a session, a `drag_left`
 * that extends it, an `up_*` that ends it); non-mouse events fall through
 * untouched. The subscription is torn down when the component unmounts.
 * Hosts that want a copy *key* can route the core {@link selectionKey}
 * (ctrl+shift+c / escape) through `useInput`.
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
        // Copy-on-release, then end the session: `endSelection` leaves the
        // overlay up (persistent selection), so the text can also be copied
        // later — the release copy is just the conventional timing.
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

// Core types re-exported so consumers can type props, focus handles and
// input handlers without importing @tern-tui/core directly. (`FocusManager` is a
// class — it is exported as a value below, which carries its type.)
export type {
  DiffLine,
  FocusHandle,
  KeyEvent,
  KeyHandler,
  MenuItem,
  MenuState,
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
  TreeNode,
  TreeRow,
  TreeState,
} from "@tern-tui/core";
