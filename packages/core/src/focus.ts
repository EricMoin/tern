//! The focus registry: what is focusable, who holds focus, and the useFocus hook.

import { keymap } from "./keymap.ts";
import { Node } from "./node.ts";
import { tableRegions } from "./table.ts";
import type { KeyHandler, PasteHandler } from "./types.ts";

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
/** A focusable element registered with a {@link FocusManager}. */
export interface Focusable {
  /** A unique id used to focus the element. */
  id: string;
  /** The element's scene node (used to route by explicit node). */
  node: Node;
  /** The handler invoked when a key routes to this element. */
  onKey: KeyHandler;
  /**
   * The handler invoked when a paste event routes to this element (optional —
   * only elements that handle paste consume it; `routePaste` returns `false`
   * for a focused element without one, so the paste falls through to the
   * tree-level handler).
   */
  onPaste?: PasteHandler;
}

/**
 * Routes key events to the focused element's key handler, and paste events to
 * the focused element's paste handler. Elements register with `register` (or
 * the {@link useFocus} helper) and become routable; the active focus is moved
 * with `focus`/`blur`, or walked in registration order with
 * `next`/`prev`/`focusFirst`. Focus changes (including blur and the
 * unregister of the active id) are observable through `subscribe`.
 */
export class FocusManager {
  #entries = new Map<string, Focusable>();
  #nodes = new Map<Node, string>();
  #active: string | null = null;
  #listeners = new Set<(activeId: string | null) => void>();

  /**
   * Register a focusable element. Returns an unsubscribe function that
   * unregisters it. Registering an id twice replaces the earlier entry (the
   * stale node mapping, if any, is dropped).
   */
  register(focusable: Focusable): () => void {
    const { id, node } = focusable;
    const prev = this.#entries.get(id);
    if (prev !== undefined && prev.node !== node) {
      if (this.#nodes.get(prev.node) === id) this.#nodes.delete(prev.node);
    }
    this.#entries.set(id, focusable);
    this.#nodes.set(node, id);
    return () => this.unregister(id);
  }

  /** Unregister `id` (clearing it as active if it was, which notifies
   * subscribers with `null`). Returns whether an entry was removed. */
  unregister(id: string): boolean {
    const entry = this.#entries.get(id);
    const removed = this.#entries.delete(id);
    if (removed && entry !== undefined) {
      if (this.#nodes.get(entry.node) === id) this.#nodes.delete(entry.node);
    }
    if (removed && this.#active === id) {
      this.#active = null;
      this.#notify(null);
    }
    return removed;
  }

  /** Whether an element with `id` is registered. */
  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Make `id` the active focus. Returns `false` when it is not registered.
   * Focusing the already-active id is a no-op (subscribers are not re-fired). */
  focus(id: string): boolean {
    if (!this.#entries.has(id)) return false;
    if (this.#active !== id) {
      this.#active = id;
      this.#notify(id);
    }
    return true;
  }

  /** Clear the active focus (elements stay registered). Blurring when nothing
   * is focused is a no-op (subscribers are not re-fired). */
  blur(): void {
    if (this.#active !== null) {
      this.#active = null;
      this.#notify(null);
    }
  }

  /** The id of the active focus, or `null`. */
  get activeId(): string | null {
    return this.#active;
  }

  /** The active focusable entry, or `null`. */
  get active(): Focusable | null {
    if (this.#active === null) return null;
    return this.#entries.get(this.#active) ?? null;
  }

  /** Focus the first registered element. Returns `false` when nothing is
   * registered. */
  focusFirst(): boolean {
    const first = [...this.#entries.keys()][0];
    if (first === undefined) return false;
    return this.focus(first);
  }

  /**
   * Move the active focus to the element registered after the current one,
   * wrapping around to the first. With nothing focused, focuses the first
   * element. Returns `false` when nothing is registered.
   */
  next(): boolean {
    if (this.#active === null) return this.focusFirst();
    const keys = [...this.#entries.keys()];
    const idx = keys.indexOf(this.#active);
    if (idx === -1) return false;
    const nextId = keys[(idx + 1) % keys.length];
    if (nextId === undefined) return false;
    return this.focus(nextId);
  }

  /**
   * Move the active focus to the element registered before the current one,
   * wrapping around to the last. With nothing focused, focuses the first
   * element. Returns `false` when nothing is registered.
   */
  prev(): boolean {
    if (this.#active === null) return this.focusFirst();
    const keys = [...this.#entries.keys()];
    const idx = keys.indexOf(this.#active);
    if (idx === -1) return false;
    const prevId = keys[(idx - 1 + keys.length) % keys.length];
    if (prevId === undefined) return false;
    return this.focus(prevId);
  }

  /** The registered focus id for a scene node, or `null` when the node is not
   * registered. When the same node is registered under several ids, the most
   * recently registered id wins. */
  focusIdFor(node: Node): string | null {
    return this.#nodes.get(node) ?? null;
  }

  /**
   * Subscribe to focus changes. The callback runs with the new active id (or
   * `null` when focus is cleared) each time the active focus changes — on
   * `focus`, `blur`, and when unregistering the active id. Returns an
   * unsubscribe function.
   */
  subscribe(cb: (activeId: string | null) => void): () => void {
    this.#listeners.add(cb);
    return () => this.unsubscribe(cb);
  }

  /** Remove a focus-change subscriber added with {@link FocusManager.subscribe}. */
  unsubscribe(cb: (activeId: string | null) => void): void {
    this.#listeners.delete(cb);
  }

  #notify(activeId: string | null): void {
    for (const cb of this.#listeners) cb(activeId);
  }

  /**
   * Dispatch a key event to a registered element's handler. The global
   * {@link keymap} is consulted first: a registered combo fires (regardless
   * of focus or an explicit `node`) and consumes the event. Otherwise, when
   * `node` is given and registered, it wins; otherwise the active focus
   * handles the event. Returns `false` (and dispatches nothing) when neither
   * the keymap nor a focusable claims the event.
   */
  routeKey(event: KeyEvent, node?: Node): boolean {
    // Global shortcuts dispatch ahead of focus routing: a registered combo
    // fires regardless of focus and swallows the event; an unclaimed key
    // falls through to the focused element's handler.
    if (keymap.dispatch(event)) return true;
    let entry: Focusable | undefined;
    if (node !== undefined) {
      entry = [...this.#entries.values()].find((e) => e.node === node);
    }
    if (entry === undefined && this.#active !== null) {
      entry = this.#entries.get(this.#active);
    }
    if (entry === undefined) return false;
    entry.onKey(event);
    return true;
  }

  /**
   * Dispatch a paste event to a registered element's paste handler — the
   * paste counterpart of {@link FocusManager.routeKey}. When `node` is given
   * and registered, it wins; otherwise the active focus handles the event.
   *
   * Returns `false` (and dispatches nothing) when neither applies, and also
   * when the resolved element registered no `onPaste` handler — an element
   * that does not handle paste never consumes it, so the event falls through
   * to the tree-level paste handler.
   */
  routePaste(text: string, node?: Node): boolean {
    let entry: Focusable | undefined;
    if (node !== undefined) {
      entry = [...this.#entries.values()].find((e) => e.node === node);
    }
    if (entry === undefined && this.#active !== null) {
      entry = this.#entries.get(this.#active);
    }
    if (entry === undefined) return false;
    const onPaste = entry.onPaste;
    if (onPaste === undefined) return false;
    onPaste(text);
    return true;
  }
}

/** The default focus manager shared by {@link useFocus} calls that omit one. */
export const focusManager: FocusManager = new FocusManager();

/** The handle returned by {@link useFocus}. */
export interface FocusHandle {
  /** Make the registered id the active focus. */
  focus(): void;
  /** Clear the active focus. */
  blur(): void;
  /** Whether the registered id is currently the active focus. */
  isFocused(): boolean;
  /** Unregister the element from the manager. */
  dispose(): void;
}

/**
 * Register a focusable element with a {@link FocusManager} and return a small
 * handle to focus/blur it. `manager` defaults to the module-level
 * {@link focusManager}. The caller owns the node's lifecycle — call
 * `dispose()` to unregister (e.g. on unmount).
 *
 * `onPaste` is the element's paste handler: when given, paste events routed
 * to this element (via `FocusManager.routePaste`, e.g. from the `usePaste` /
 * `subscribePaste` host wiring) dispatch to it — the paste counterpart of
 * `onKey`. Elements without one never consume pastes, so a routed paste falls
 * through to the tree-level handler.
 */
export function useFocus(
  id: string,
  node: Node,
  onKey: KeyHandler,
  manager: FocusManager = focusManager,
  onPaste?: PasteHandler,
): FocusHandle {
  manager.register(
    onPaste === undefined ? { id, node, onKey } : { id, node, onKey, onPaste },
  );
  return {
    focus: () => manager.focus(id),
    blur: () => manager.blur(),
    isFocused: () => manager.activeId === id,
    dispose: () => manager.unregister(id),
  };
}

/**
 * Whether `view` is a scrollable scroll-view-like node: a `scroll_view`,
 * `streaming_text`, `diff`, or `table` element, or any attached node carrying
 * the engine's clip/scroll region props (`clip_*` / `scroll_*`). The node
 * must be attached — scroll geometry (`Node.contentSize()`) errors on a
 * detached node, so a detached view is never scrollable.
 */
export function isScrollableNode(view: Node): boolean {
  if (!view.attached) return false;
  const type = view.type;
  if (
    type === "scroll_view" || type === "streaming_text" || type === "diff" ||
    type === "table"
  ) {
    return true;
  }
  const props = view.props;
  return (
    typeof props.clip_width === "number" ||
    typeof props.clip_height === "number" ||
    typeof props.scroll_x === "number" ||
    typeof props.scroll_y === "number"
  );
}

/** The node a wheel event scrolls for `view`: a `table` scrolls its content
 * region (the sticky header stays pinned — the region carries the `scroll_y`
 * / `clip_height` viewport props); any other scroll view is the node itself.
 * Returns `null` when `view` is detached (scroll geometry is unavailable). */
export function wheelScrollTarget(view: Node): Node | null {
  if (!view.attached) return null;
  if (view.type === "table") return tableRegions.get(view) ?? null;
  return view;
}

