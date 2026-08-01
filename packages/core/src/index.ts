/**
 * @tern/core — TypeScript bindings for the tern TUI engine.
 *
 * This package wraps the `tern-node` napi addon (see `src/bindings/tern-node`)
 * behind a small declarative API:
 *
 * - `createRenderer(options)` constructs a `Renderer` (a native `TuiRenderer`
 *   in raw mode + alternate screen) and exposes the scene root as a `Node`.
 * - `Text(props)` / `Box(props, ...children)` / `StreamingText(props)` are
 *   factory functions returning `Node` objects. They are pure data (no native
 *   calls) until a node is attached under the scene root with
 *   `Node.addChild`, which materializes it in the shared scene. Spans fed
 *   to a `streaming_text` node via `Node.appendSpan` while detached are
 *   flushed to the native handle on attach.
 * - `Renderer` owns the render/input loop: `render()`, `pollEvents()`,
 *   `onKey(cb)`, `onResize(cb)` and `destroy()`.
 *
 * The generated napi types (`KeyEvent`, `TuiRendererOptions`, `TuiRenderer`,
 * `NodeHandle`) are re-exported from the binding's `index.d.ts` so consumers
 * get the canonical declaration surface.
 *
 * ## Runtime
 *
 * Deno-first: the native addon is loaded via `node:module` `createRequire`
 * (see `./addon.ts`), which Deno 2.x supports for Node-API addons when given
 * `--allow-ffi` (+ read access to the `.node` file). Node.js works unchanged.
 */

export { loadAddon } from "./addon.ts";
export type {
  KeyEvent,
  NodeHandle,
  TuiRenderer,
  TuiRendererOptions,
} from "../../../src/bindings/tern-node/index.d.ts";

export const name = "@tern/core";
export const version = "0.1.0";

import type {
  KeyEvent,
  NodeHandle as NativeNodeHandle,
  TuiRenderer as NativeTuiRenderer,
} from "../../../src/bindings/tern-node/index.d.ts";
import { loadAddon } from "./addon.ts";

/** The node kinds the binding materializes. */
export type NodeType = "box" | "text" | "streaming_text";

/**
 * Props for a scene node. Style keys (`fg`, `bg`, `border_style`, the boolean
 * modifiers) are lifted into the node's style by the binding; every other key
 * lands in the node's property map (`text`, layout keywords such as `width`,
 * `height`, `padding`, `flex_direction`, ...). Property values must be JSON
 * scalars (string/number/boolean) — the binding drops arrays and objects.
 */
export interface NodeProps {
  /** The text content of a `text` node. */
  text?: string;
  // Layout keywords (tern-components).
  width?: number;
  height?: number;
  padding?: number;
  flex_direction?: "row" | "column";
  // Style keys.
  fg?: string;
  bg?: string;
  border_style?: "none" | "plain" | "rounded" | "double" | "thick";
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  reversed?: boolean;
  hidden?: boolean;
  strikethrough?: boolean;
  /** Any other scalar prop is forwarded verbatim to the scene node. */
  [key: string]: unknown;
}

export type KeyHandler = (event: KeyEvent) => void;
export type ResizeHandler = () => void;

/**
 * A single styled segment of a `streaming_text` node's stream, appended via
 * `Node.appendSpan`. `style` follows the same scalar-prop JSON convention as
 * `NodeProps` (and `setProps`): the recognized style keys (`fg`, `bg`,
 * `border_style`, the boolean modifiers) are lifted into the span's style by
 * the binding; every other key is ignored.
 */
export interface Span {
  /** The span's text content. */
  text: string;
  /** Optional style keys for this span. */
  style?: NodeProps;
}

/** Options accepted by `createRenderer`. */
export interface CreateRendererOptions {
  /**
   * When `true`, a Ctrl+C key press tears the terminal down (raw mode +
   * alternate screen exited) and marks the renderer destroyed instead of
   * being surfaced as an event. Maps to the native `exit_on_ctrl_c`.
   */
  exitOnCtrlC?: boolean;
}

/**
 * A scene node. `Text`/`Box` build detached node objects (pure data — no
 * native calls); materialization into the shared scene happens lazily when a
 * node is attached under an attached parent (the scene root counts as
 * attached). The binding enforces parent-first materialization, so a node is
 * added to a parent before its own children are attached — `Box`-declared
 * children are attached automatically.
 */
export class Node {
  readonly type: NodeType;
  #handle: NativeNodeHandle | null;
  #props: NodeProps;
  #children: Node[];
  #attached: boolean;
  #spans: Span[];

  /** @internal — use `Text` / `Box` (or `Node.wrapRoot`) to create nodes. */
  private constructor(type: NodeType, props: NodeProps, children: Node[]) {
    this.type = type;
    this.#handle = null;
    this.#props = { ...props };
    this.#children = [...children];
    this.#attached = false;
    this.#spans = [];
  }

  /** @internal — build a detached node object. */
  static create(type: NodeType, props: NodeProps = {}, children: Node[] = []): Node {
    return new Node(type, props, children);
  }

  /** @internal — wrap an already-materialized native handle (the scene root). */
  static wrapRoot(handle: NativeNodeHandle): Node {
    const node = new Node("box", {}, []);
    node.#handle = handle;
    node.#attached = true;
    return node;
  }

  /**
   * The raw napi handle backing this node, materializing it on first access
   * if it has not been attached yet.
   */
  get handle(): NativeNodeHandle {
    return this.#ensureHandle();
  }

  /** A copy of the props this node was created (or last set) with. */
  get props(): NodeProps {
    return { ...this.#props };
  }

  /**
   * The children declared at creation, or added via `addChild` /
   * `insertBefore`, in scene order. Returns a copy.
   */
  get children(): readonly Node[] {
    return [...this.#children];
  }

  /** Whether this node is currently attached to the shared scene. */
  get attached(): boolean {
    return this.#attached;
  }

  /**
   * Attach `child` under this node. When this node is already attached, the
   * child (and any children it was constructed with) is materialized into the
   * scene immediately; otherwise the child is recorded and attached when this
   * node is itself attached. Returns `child` for chaining.
   */
  addChild(child: Node): Node {
    if (this.#children.includes(child)) {
      throw new Error("child node is already attached to this parent");
    }
    if (this.#attached) {
      this.#ensureHandle().add_child(child.#ensureHandle());
      child.#attach();
    }
    this.#children.push(child);
    return child;
  }

  /**
   * Insert `child` into this node's children immediately before `anchor`,
   * returning `child` for chaining.
   *
   * When this node is already attached, the child is materialized into the
   * scene at `anchor`'s position via the native handle's `insert_before`, and
   * the child's own subtree is attached (mirroring `addChild`). When this
   * node is detached, the child is recorded positionally in the children
   * list, so the reorder lands in the scene automatically once this node
   * attaches (`#attach` materializes `#children` in order).
   *
   * Throws when `child` is already a child of this node, or when `anchor` is
   * not a child of this node.
   */
  insertBefore(child: Node, anchor: Node): Node {
    if (this.#children.includes(child)) {
      throw new Error("child node is already attached to this parent");
    }
    const index = this.#children.indexOf(anchor);
    if (index === -1) {
      throw new Error("anchor node is not a child of this parent");
    }
    if (this.#attached) {
      this.#ensureHandle().insert_before(child.#ensureHandle(), anchor.#ensureHandle());
      child.#attach();
    }
    this.#children.splice(index, 0, child);
    return child;
  }

  /**
   * Replace this node's props (and style keys) in the scene. On a detached
   * node the props are recorded and applied when the node materializes.
   */
  setProps(props: NodeProps): void {
    this.#props = { ...props };
    if (this.#handle !== null) this.#handle.set_props(props);
  }

  /**
   * Append a styled span of text to this node's stream.
   *
   * On a detached node the span is recorded and flushed to the native handle
   * (in call order) when the node is attached to the scene. On an attached
   * node the span is appended to the native handle immediately. `style` is
   * serialized with the same scalar-prop JSON convention as `setProps`: the
   * binding lifts the recognized style keys into the span's style and ignores
   * every other key.
   *
   * The native binding errors when the node is not a `streaming_text` node,
   * so appending to a `Text`/`Box` node surfaces that error at attach time.
   */
  appendSpan(text: string, style?: NodeProps): void {
    if (this.#attached && this.#handle !== null) {
      this.#handle.append_span(text, style);
    } else {
      this.#spans.push(style === undefined ? { text } : { text, style });
    }
  }

  /**
   * The spans appended while this node was detached, in call order. Empty
   * once the node is attached (recorded spans are flushed to the native
   * handle). Returns a copy.
   */
  get spans(): readonly Span[] {
    return [...this.#spans];
  }

  /**
   * Detach this node (and its whole subtree) from the scene. Returns `false`
   * when the node was already detached (or is the scene root).
   */
  remove(): boolean {
    if (this.#handle === null) return false;
    const removed = this.#handle.remove();
    if (removed) this.#unattach();
    return removed;
  }

  /** Create the native handle on demand (idempotent). */
  #ensureHandle(): NativeNodeHandle {
    if (this.#handle === null) {
      this.#handle = loadAddon().create_node(this.type, this.#props);
    }
    return this.#handle;
  }

  /** Materialize `#children` into the native handle (once). */
  #attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const handle = this.#ensureHandle();
    this.#flushSpans(handle);
    for (const child of this.#children) {
      handle.add_child(child.#ensureHandle());
      child.#attach();
    }
  }

  /**
   * Replay spans recorded while detached onto the now-attached handle.
   * Called only after the handle is bound into the scene (`add_child`), since
   * the native `append_span` errors on a not-yet-bound handle.
   */
  #flushSpans(handle: NativeNodeHandle): void {
    for (const span of this.#spans) {
      handle.append_span(span.text, span.style);
    }
    this.#spans = [];
  }

  #unattach(): void {
    this.#attached = false;
    for (const child of this.#children) child.#unattach();
  }
}

/** Create a `text` node object. */
export function Text(props: NodeProps = {}): Node {
  return Node.create("text", props);
}

/** Create a `box` node object with optional child nodes. */
export function Box(props: NodeProps = {}, ...children: Node[]): Node {
  return Node.create("box", props, children);
}

/**
 * Create a `streaming_text` node object. Its stream is fed with
 * `Node.appendSpan` (spans are recorded while the node is detached and
 * flushed to the native handle in call order on attach).
 */
export function StreamingText(props: NodeProps = {}): Node {
  return Node.create("streaming_text", props);
}

/**
 * A terminal-facing renderer. Constructing one enters raw mode + the
 * alternate screen; `destroy()` (or Ctrl+C with `exitOnCtrlC`) restores the
 * terminal. A destroyed renderer cannot render or poll.
 */
export class Renderer {
  #native: NativeTuiRenderer;
  #keyHandlers = new Set<KeyHandler>();
  #resizeHandlers = new Set<ResizeHandler>();

  /** The scene root. Attach content under it with `Node.addChild`. */
  readonly root: Node;

  /** @internal — use `createRenderer`. */
  constructor(options: CreateRendererOptions = {}) {
    const addon = loadAddon();
    const nativeOptions = { exit_on_ctrl_c: options.exitOnCtrlC ?? false };
    this.#native = new addon.TuiRenderer(nativeOptions);
    this.root = Node.wrapRoot(this.#native.root());
  }

  /** Paint the shared scene to the terminal (minimal diff vs the last frame). */
  render(): void {
    this.#native.render();
  }

  /**
   * Block up to `timeoutMs` for input, dispatching each key event to the
   * handlers registered with `onKey`, and return the events. A burst of keys
   * arrives as one batch. Resize/focus events are dropped by the MVP binding
   * (key events only).
   */
  pollEvents(timeoutMs: number = 50): KeyEvent[] {
    const events = this.#native.poll_events(timeoutMs);
    if (this.#keyHandlers.size > 0) {
      for (const event of events) {
        for (const handler of this.#keyHandlers) handler(event);
      }
    }
    return events;
  }

  /**
   * Register a handler invoked for every key event returned by `pollEvents`.
   * Returns an unsubscribe function.
   */
  onKey(handler: KeyHandler): () => void {
    this.#keyHandlers.add(handler);
    return () => this.#keyHandlers.delete(handler);
  }

  /**
   * Register a handler invoked when the terminal is resized.
   *
   * Limitation: the MVP native binding drops resize events (its
   * `poll_events` surfaces key events only), so with the current binding the
   * handler is never invoked. It is wired for the moment the binding starts
   * surfacing resize events; the unsubscribe contract is testable today.
   */
  onResize(handler: ResizeHandler): () => void {
    this.#resizeHandlers.add(handler);
    return () => this.#resizeHandlers.delete(handler);
  }

  /** Leave the alternate screen and raw mode, restoring the terminal. */
  destroy(): void {
    this.#native.destroy();
  }

  /** Whether the renderer has been destroyed (explicitly or via Ctrl+C). */
  get destroyed(): boolean {
    return this.#native.destroyed;
  }
}

/**
 * Construct a renderer over the tern-node native addon.
 *
 * ```ts
 * const renderer = createRenderer({ exitOnCtrlC: true });
 * renderer.root.addChild(
 *   Box({ border_style: "rounded" }, Text({ text: "Hello" })),
 * );
 * renderer.render();
 * renderer.pollEvents(50); // feeds onKey handlers, returns the events
 * renderer.destroy();
 * ```
 */
export function createRenderer(options: CreateRendererOptions = {}): Renderer {
  return new Renderer(options);
}
