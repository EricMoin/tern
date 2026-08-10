/**
 * @tern-tui/core — TypeScript bindings for the tern TUI engine.
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
 *   flushed to the native handle on attach. A `streaming_text` node defaults
 *   to `autoScroll: true`: `syncStreamTail` (fed by the @tern-tui/react /
 *   @tern-tui/solid stream hosts after each span) pins `scroll_y` to the content
 *   tail vs the `clip_height` viewport, a manual scroll above the tail
 *   detaches, and `followTail` re-attaches.
 * - `Input` / `Spinner` / `StatusBar` / `Panels` / `DiffView` / `Select` /
 *   `ScrollView` / `Table` / `Tabs` / `Progress` / `Modal` / `MarkdownView`
 *   are roadmap
 *   element factories that compose the primitive kinds into richer widgets
 *   (all editing/caret/selection/scroll/tab math stays in the element, the
 *   Rust compositor paints it), and a
 *   `FocusManager`
 *   (with a `useFocus` helper) routes key events to the focused element's
 *   key handler — and paste events to the focused element's paste handler
 *   (`routePaste`), the routing the `usePaste` / `subscribePaste` host
 *   wiring consults. `Input`/`Textarea` also expose paste editing via
 *   {@link pasteInto} and {@link pasteIntoTextarea}, which insert pasted text
 *   at the caret (multi-width aware) — the natural handler for
 *   `Renderer.onPaste` events.
 *   `Panels` lays its panels out with a 1-cell gutter between
 *   them; `startPanelDrag` / `dragPanels` / `endPanelDrag` implement mouse
 *   drag-resize on that gutter (an absolute `flex_basis` on the adjacent
 *   pane, clamped to the pane's min size — roadmap Phase 2). `ScrollView`
 *   is a clip/scroll region box whose offsets are driven by `scrollTo` /
 *   `scrollBy` / `scrollTop` (clamped against `Node.contentSize()` vs the
 *   viewport) with an optional track + thumb scrollbar text leaf. Mouse
 *   interaction helpers map terminal mouse events onto the widgets:
 *   `wheelScroll(view, event)` maps wheel events (`scroll_up` /
 *   `scroll_down` / `scroll_left` / `scroll_right`) to `scrollBy` on the
 *   given scrollable node, and `focusAt(renderer, event)` routes a
 *   `down_left` press on a painted cell to the topmost registered focusable
 *   node via the `FocusManager`. Mouse text selection is viewport-cell-scoped
 *   v1: `startSelection(renderer, event)` / `dragSelection(renderer, event)`
 *   / `endSelection(renderer, event)` drive a press-drag-release selection
 *   overlay (two `down_left` presses within
 *   `SELECTION_DOUBLE_CLICK_MS` ms on nearby cells select the word under the
 *   pointer via `selectWordAt`), `copySelection(renderer)` copies the
 *   selection text to the system clipboard (OSC 52), and `selectionKey`
 *   binds `ctrl+shift+c` to copy — plain `ctrl+c` stays the exit convention
 *   and is never consumed.
 * - A theme system: `Theme` (a named palette of fg/bg per semantic role plus
 *   per-component style presets), `defaultTheme`, `mergeTheme(base, overrides)`
 *   and `resolveTheme(theme, props)`. Resolution consumes semantic hints
 *   (`role` / `component`) from the props and stamps plain `fg` / `bg` /
 *   `border_style` onto them — the output is ordinary `NodeProps`, so no new
 *   napi surface is introduced (constitution). The `@tern-tui/react` /
 *   `@tern-tui/solid` hosts resolve automatically; raw `@tern-tui/core` users call
 *   `resolveTheme` explicitly at element-creation time.
 * - `Renderer` owns the render/input loop: `render()` (synchronous, immediate
 *   paint), `requestFrame()` (coalesced paint on the next macrotask — several
 *   calls within one tick collapse into a single native render), `size` (the
 *   viewport the last render/snapshot painted at — `{ width, height }` in
 *   cells, the current terminal size before the first paint),
 *   `setClipboard(text)` (copy to the system clipboard via OSC 52),
 *   `events` (an
 *   `AsyncIterable` of tagged `TernEventJs` events pushed from the native
 *   thread), `onKey(cb)`, `onResize(cb)`, `onFocus(cb)`, `onMouse(cb)`,
 *   `onPaste(cb)` and
 *   `destroy()`. Event delivery is push-based (roadmap Phase 3): the native
 *   binding runs a background event loop and delivers every event to the JS
 *   thread through a `ThreadsafeFunction`, so the reconciler subscribes with
 *   `for await (const event of renderer.events)` instead of polling.
 * - Scene geometry queries: `Renderer.hit_test(col, row)` returns the
 *   topmost z-ordered path of scene node ids covering a cell (for mouse
 *   routing), and `Node.contentSize()` returns a node's laid-out content
 *   width/height (wrapped line count for `text`/`streaming_text`, layout
 *   size otherwise).
 *
 * The generated napi types (`KeyEvent`, `MouseEventJs`, `TernEventJs`,
 * `TuiRendererOptions`, `TuiRenderer`, `NodeHandle`, `ContentSize`) are
 * re-exported from the binding's `index.d.ts` so consumers get the canonical
 * declaration surface.
 *
 * ## Runtime
 *
 * Deno-first: the native addon is loaded via `node:module` `createRequire`
 * (see `./addon.ts`), which Deno 2.x supports for Node-API addons when given
 * `--allow-ffi` (+ read access to the `.node` file). Node.js works unchanged.
 */

export { loadAddon } from "./addon.ts";
export type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  MouseEventJs,
  NodeHandle,
  RendererCapabilities,
  RendererSize,
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";

export const name = "@tern-tui/core";
export const version = "0.1.0";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
import { loadAddon } from "./addon.ts";

/**
 * The scene node kinds. `box`/`text`/`streaming_text` are materialized by the
 * binding; `input`/`textarea`/`spinner`/`status_bar`/`panels`/`diff`/`select`/
 * `scroll_view`/`table`/`tabs`/`progress`/`modal`/`markdown` are JS-only
 * element kinds that materialize as compositions over the primitive kinds
 * (their root primitive is fixed by {@link NATIVE_KIND}).
 */
export type NodeType =
  | "box"
  | "text"
  | "streaming_text"
  | "input"
  | "textarea"
  | "spinner"
  | "status_bar"
  | "panels"
  | "diff"
  | "select"
  | "scroll_view"
  | "table"
  | "tabs"
  | "progress"
  | "modal"
  | "markdown";

/**
 * The native scene node kind each JS element kind materializes as. The
 * binding only knows `box`/`text`/`streaming_text` — the roadmap element
 * kinds are pure JS compositions over those primitives (constitution: no new
 * engine kinds in the binding), so each maps to the root primitive of its
 * composition: an `input` is a framed box, a `spinner` is a text leaf, a
 * `status_bar` / `panels` / `diff` / `select` / `table` / `tabs` / `progress`
 * / `modal` / `markdown` is a flex box.
 */
const NATIVE_KIND: Record<NodeType, NodeType> = {
  box: "box",
  text: "text",
  streaming_text: "streaming_text",
  input: "box",
  textarea: "box",
  spinner: "text",
  status_bar: "box",
  panels: "box",
  diff: "box",
  select: "box",
  scroll_view: "box",
  table: "box",
  tabs: "box",
  progress: "box",
  modal: "box",
  markdown: "box",
};

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
  padding_x?: number;
  padding_y?: number;
  padding_top?: number;
  padding_right?: number;
  padding_bottom?: number;
  padding_left?: number;
  margin?: number;
  margin_x?: number;
  margin_y?: number;
  margin_top?: number;
  margin_right?: number;
  margin_bottom?: number;
  margin_left?: number;
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
/** Receives the new terminal size as `{ width, height }`. */
export type ResizeHandler = (event: { width: number; height: number }) => void;
/** Receives `{ focus_gained }` — `true` on focus gained, `false` on lost. */
export type FocusHandler = (event: { focus_gained: boolean }) => void;
/** Receives the mouse event payload. */
export type MouseHandler = (event: MouseEventJs) => void;
/** Receives the pasted text string. */
export type PasteHandler = (text: string) => void;

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

/**
 * An inclusive cell range, in viewport coordinates: the rectangle spanned
 * by (`col1`, `row1`) and (`col2`, `row2`). Either endpoint may be the
 * top-left; consumers normalize with `min`/`max`. Mirrors the native
 * `SelectionRange` surface from the tern-node binding.
 */
export interface SelectionRange {
  /** The column of one endpoint (inclusive). */
  col1: number;
  /** The row of one endpoint (inclusive). */
  row1: number;
  /** The column of the other endpoint (inclusive). */
  col2: number;
  /** The row of the other endpoint (inclusive). */
  row2: number;
}

/** Options accepted by `createRenderer`. */
export interface CreateRendererOptions {
  /**
   * When `true`, a Ctrl+C key press tears the terminal down (raw mode +
   * alternate screen exited) and marks the renderer destroyed instead of
   * being surfaced as an event. Maps to the native `exit_on_ctrl_c`.
   */
  exitOnCtrlC?: boolean;
  /**
   * When `false`, the renderer skips the alternate screen: it renders inline
   * in the terminal's main screen, and never emits the alternate-screen
   * enter/leave escapes. Default `true`. Maps to the native
   * `use_alt_screen`.
   */
  useAltScreen?: boolean;
  /**
   * The terminal window title, applied when the renderer is constructed.
   * Maps to the native `title`.
   */
  title?: string;
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
  #parent: Node | null;
  #attached: boolean;
  #spans: Span[];

  /** @internal — use `Text` / `Box` (or `Node.wrapRoot`) to create nodes. */
  private constructor(type: NodeType, props: NodeProps, children: Node[]) {
    this.type = type;
    this.#handle = null;
    this.#props = { ...props };
    this.#children = [...children];
    this.#parent = null;
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
   * `insertBefore`, in scene order (removals via `remove` are reflected).
   * Returns a copy.
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
    child.#parent = this;
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
    child.#parent = this;
    this.#children.splice(index, 0, child);
    return child;
  }

  /**
   * Replace this node's props (and style keys) in the scene. On a detached
   * node the props are recorded and applied when the node materializes.
   *
   * Incremental sync: the new map is diffed against the current props, and
   * only the changed keys are pushed to the scene through the native
   * single-key `set_prop` path — never a full JSON serialization + whole-map
   * replace. An equal-value write (nothing changed) performs no native call
   * at all, so the scene's mutation epoch is untouched and a renderer's
   * cached frame stays valid. A write that removes a key (or whose value is
   * `undefined`, which the native layer drops) falls back to the full-map
   * path, since a removal needs the table replace to clear the stale key.
   */
  setProps(props: NodeProps): void {
    const next = { ...props };
    // `undefined` values have no scene representation (the binding drops
    // them), so strip them up front: absent and undefined are equivalent.
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    if (this.#handle !== null) {
      const prev = this.#props;
      let removed = false;
      for (const key of Object.keys(prev)) {
        if (!(key in next)) {
          removed = true;
          break;
        }
      }
      if (removed) {
        this.#handle.set_props(next);
      } else {
        const changed: Array<[string, unknown]> = [];
        for (const key of Object.keys(next)) {
          if (!(key in prev) || prev[key] !== next[key]) {
            changed.push([key, next[key]]);
          }
        }
        for (const [key, value] of changed) this.#handle.set_prop(key, value as never);
      }
    }
    this.#props = next;
  }

  /**
   * Set a single property (or style key) on this node — the incremental
   * counterpart of {@link setProps}. On an attached node the single key is
   * pushed through the native single-key path (an equal-value write is
   * skipped, so the scene epoch is untouched); on a detached node the key is
   * recorded and applied when the node materializes.
   *
   * An `undefined` value is treated as a removal (the binding has no scene
   * representation for it): the key is dropped from the mirror and, when the
   * scene holds it, cleared through the full-map path.
   */
  setProp(key: string, value: unknown): void {
    if (value === undefined) {
      if (this.#handle !== null && key in this.#props) {
        const next = { ...this.#props };
        delete next[key];
        this.#handle.set_props(next);
      }
      delete this.#props[key];
      return;
    }
    if (this.#handle !== null && this.#props[key] !== value) {
      this.#handle.set_prop(key, value as never);
    }
    this.#props[key] = value;
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
   * Detach this node (and its whole subtree) from its parent and the scene.
   *
   * The node is spliced out of its parent's `children` list and its
   * materialized native handles are invalidated (the whole subtree is marked
   * detached and its handles dropped), so a later re-attach via `addChild` /
   * `insertBefore` re-materializes a fresh scene node. On a detached tree —
   * where no native handles exist — the JS children list is still updated, so
   * the tree always mirrors the removal.
   *
   * Returns `false` when the node has no parent to detach from: an orphaned
   * template or the scene root.
   */
  remove(): boolean {
    if (this.#parent === null) return false;
    const parent = this.#parent;
    const index = parent.#children.indexOf(this);
    if (index !== -1) parent.#children.splice(index, 1);
    this.#parent = null;
    if (this.#handle !== null) this.#handle.remove();
    this.#detachSubtree();
    return true;
  }

  /**
   * The laid-out content size of this node: `{ width, height }` in cells.
   *
   * For `text` / `streaming_text` nodes this is the wrapped content size
   * (the display width of the widest wrapped line and the wrapped line count
   * at the node's laid-out width); for containers it is the laid-out rect
   * size. The layout runs at the viewport of the most recent `render`, so
   * the geometry matches what is on screen. Errors when the node is not
   * attached to the shared scene.
   */
  contentSize(): ContentSize {
    if (!this.#attached || this.#handle === null) {
      throw new Error("node is not attached to a scene");
    }
    return this.#handle.content_size();
  }

  /** Create the native handle on demand (idempotent). */
  #ensureHandle(): NativeNodeHandle {
    if (this.#handle === null) {
      this.#handle = loadAddon().create_node(NATIVE_KIND[this.type], this.#props);
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
      child.#parent = this;
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

  /**
   * Mark this node and its whole subtree detached, invalidating the
   * materialized native handles so a re-attach re-creates fresh scene nodes.
   * The subtree's internal parent/child structure is preserved (`#children`
   * and `#parent` links inside the subtree are untouched) — only the
   * attachment to the shared scene is torn down.
   */
  #detachSubtree(): void {
    this.#attached = false;
    this.#handle = null;
    for (const child of this.#children) child.#detachSubtree();
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
 *
 * The `autoScroll` key is a component behavior flag (default `true`): the
 * node registers itself as following its content tail, and each appended
 * span (via {@link syncStreamTail}, which the @tern-tui/react `<StreamingText>`
 * effect and the @tern-tui/solid `subscribeStream` pump call) pins `scroll_y` to
 * the tail offset — the node's `Node.contentSize()` height vs the clip
 * viewport (`clip_height`). A manual scroll above the tail (via
 * {@link scrollTo} / {@link scrollBy} / {@link scrollTop}) detaches the
 * follow, pins the view, and stamps the scroll-to-bottom affordance;
 * {@link followTail} re-attaches and {@link scrollToBottom} jumps to the
 * tail, both dismissing it. The key is consumed and never reaches the scene
 * props.
 */
export function StreamingText(props: NodeProps = {}): Node {
  const plain = { ...props };
  const autoScroll = plain.autoScroll !== false;
  delete plain.autoScroll;
  const node = Node.create("streaming_text", plain);
  streamScrollStates.set(node, { following: autoScroll, autoScrollEnabled: autoScroll });
  return node;
}

// ---------------------------------------------------------------------------
// Roadmap element factories
//
// These compose the primitive kinds (`box`/`text`) into richer widgets. All
// editing/caret/frame math lives here — the Rust compositor just paints the
// resulting scene (e.g. the `caret` Int prop paints a block caret,
// compositor.rs:394-406). None of them introduce a new napi node kind: each
// element materializes as the root primitive of its composition (see
// {@link NATIVE_KIND}).
// ---------------------------------------------------------------------------

/**
 * The escape-stripped view of a string: the visible text and the code-unit
 * map back to the original string.
 */
interface StrippedView {
  /** The text with every escape sequence removed. */
  text: string;
  /** For each code-unit offset `s` in `0..=text.length`, the code-unit
   * offset in the original string where stripped offset `s` begins
   * (`orig[text.length]` is the original length). Strictly ascending. */
  orig: number[];
}

/**
 * Strip ANSI/OSC/CSI escape sequences from `value` — the "strip at
 * ingestion" rule the entire measurement path shares with its tern-core
 * mirror (`strip_escapes`, cell.rs), which documents the same contract.
 * Escape sequences occupy no terminal columns and never enter the
 * cluster/cell model, so measurement and painting agree by construction:
 * stripping happens before grapheme segmentation — an escape's bytes would
 * otherwise segment as their own clusters (ESC is a control boundary, and
 * the printable CSI payload bytes like `[31m` are ordinary width-1
 * characters), corrupting both width and text.
 *
 * The rule, byte-identical across both sides:
 *
 * - **CSI** — the introducer `ESC [` (0x1B 0x5B) or the C1 CSI single
 *   character 0x9B, followed by any run of characters up to and including
 *   the first **final byte** in 0x40–0x7E (a *tolerant* scan, not a strict
 *   grammar: any character before the final byte is consumed as part of the
 *   sequence, so malformed control data is removed rather than painted). A
 *   sequence truncated at the end of the string (no final byte) strips to
 *   the end of the string.
 * - **OSC** — the introducer `ESC ]` (0x1B 0x5D), followed by any
 *   characters up to and including the first terminator: BEL (0x07), ST as
 *   `ESC \` (0x1B 0x5C), or the C1 ST single character 0x9C. A bare `ESC`
 *   inside the body that is not followed by `\` is a body character, not a
 *   terminator. A sequence truncated at the end of the string (no
 *   terminator) strips to the end of the string.
 *
 * Everything else is kept as-is — including a lone `ESC` that introduces
 * neither CSI nor OSC (it measures 1 in {@link charWidth}, like any other
 * control character), and C1 bytes outside the rule such as the C1 OSC
 * start 0x9D. `orig[s]` is the code-unit index in `value` where stripped
 * offset `s` begins (`orig[text.length]` is `value.length`); every offset a
 * consumer emits is translated through this map, so it stays exact and
 * never points inside an escape.
 */
function stripEscapes(value: string): StrippedView {
  const kept: string[] = [];
  const orig: number[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    const code = value.charCodeAt(i);
    const isEsc = code === 0x1b;
    const next = i + 1 < n ? value.charCodeAt(i + 1) : -1;
    // OSC: ESC ] — payload to the first terminator (BEL 0x07, the two-byte
    // ST ESC \, or the C1 ST 0x9C), terminator consumed; a bare ESC not
    // followed by `\` is a body character; a truncated OSC (no terminator
    // before the end of the string) strips to the end.
    if (isEsc && next === 0x5d) {
      let j = i + 2;
      while (j < n) {
        const c = value.charCodeAt(j);
        if (c === 0x07) {
          j += 1; // BEL terminates
          break;
        }
        if (c === 0x1b && j + 1 < n && value.charCodeAt(j + 1) === 0x5c) {
          j += 2; // ST (ESC \) terminates
          break;
        }
        if (c === 0x9c) {
          j += 1; // C1 ST terminates
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    // CSI: ESC [ or the C1 CSI lead 0x9B — a tolerant scan up to and
    // including the first final byte (0x40–0x7E); any character before it
    // is part of the sequence. A truncated CSI (no final byte before the
    // end of the string) strips to the end.
    if ((isEsc && next === 0x5b) || code === 0x9b) {
      let j = isEsc ? i + 2 : i + 1;
      while (j < n) {
        const c = value.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j += 1; // the final byte — consumed
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    kept.push(value[i]!);
    orig.push(i);
    i += 1;
  }
  orig.push(n);
  return { text: kept.join(""), orig };
}

/** The largest stripped offset `s` with `orig[s] <= index` — a binary search
 * over the strictly ascending strip map (see {@link stripEscapes}). Every
 * original index maps to the stripped offset whose original position is at
 * or before it: `0` when `index` precedes every kept character. */
function strippedIndexAt(orig: number[], index: number): number {
  let lo = 0;
  let hi = orig.length - 1; // orig[hi] is the original length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (orig[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The display width of a character in terminal columns, mirroring
 * tern-core's `char_width` (cell.rs:11): 0 for NUL and combining/zero-width
 * marks, 2 for wide (CJK / fullwidth) characters, 1 otherwise. Escape
 * sequences never reach this function — they are stripped at ingestion (see
 * {@link stripEscapes}) — so a stray kept control byte (e.g. a lone `ESC`)
 * measures 1, exactly like tern-core's fallback.
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x1ab0 && code <= 0x1aff) || // combining diacritical marks ext.
    (code >= 0x1dc0 && code <= 0x1dff) || // combining diacritical marks suppl.
    (code >= 0x20d0 && code <= 0x20ff) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) || // combining half marks
    (code >= 0x200b && code <= 0x200f) || // zero-width space / joiners
    code === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo init. consonants
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK … Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) || // fullwidth signs
    (code >= 0x1f300 && code <= 0x1faff) // emoji (surrogate pairs, wide)
  ) {
    return 2;
  }
  return 1;
}

/**
 * One grapheme cluster of a value: its code-unit start, its text, and its
 * display width in terminal columns (the tern-core `cluster_width`
 * convention — cell.rs:75).
 */
interface ClusterRun {
  /** The code-unit index where the cluster starts. */
  start: number;
  /** The cluster's length in code units. */
  len: number;
  /** The display width in columns: 1, 2, or 0 (a lone zero-width mark). */
  width: number;
  /** The cluster's full text (e.g. `"👨‍👩‍👧‍👦"` or `"e\u{301}"`). */
  text: string;
}

/** The lazily-created shared grapheme segmenter, or `null` once a runtime
 * without `Intl.Segmenter` is observed (the documented fallback below). */
let graphemeSegmenterInstance: Intl.Segmenter | null | undefined;

/** The shared `Intl.Segmenter` (granularity `"grapheme"`), or `null` when the
 * runtime lacks it. Both declared runtimes ship it — Deno's full ICU and
 * Node >= 20 (full-icu) — so the fallback only fires on exotic hosts. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenterInstance === undefined) {
    graphemeSegmenterInstance =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return graphemeSegmenterInstance;
}

/**
 * The extended grapheme clusters of `value` (UAX #29), each with its
 * code-unit offset, its text, and its display width — the atom every edit in
 * this layer moves by. Escape sequences (ANSI/OSC/CSI, see
 * {@link stripEscapes}) are stripped at ingestion: they consume zero cells
 * and emit no run, so every cluster `start` is a code-unit index into the
 * ORIGINAL `value` (translated through the strip map) and never points
 * inside an escape — a caret's display column lands on the visible character
 * after one. When `Intl.Segmenter` is unavailable the documented fallback
 * splits on code points (surrogate pairs stay whole), so combining sequences
 * and ZWJ emoji degrade to per-code-point steps instead of mid-cluster
 * corruption.
 */
function clusterRuns(value: string): ClusterRun[] {
  const { text, orig } = stripEscapes(value);
  const runs: ClusterRun[] = [];
  const segmenter = graphemeSegmenter();
  if (segmenter !== null) {
    let start = 0;
    for (const seg of segmenter.segment(text)) {
      const segText = seg.segment;
      runs.push({
        start: orig[start]!,
        len: segText.length,
        width: clusterWidth(segText),
        text: segText,
      });
      start += segText.length;
    }
    return runs;
  }
  // Fallback: iterate code points (`for...of` over a string yields one code
  // point per iteration, keeping surrogate pairs whole).
  let start = 0;
  for (const ch of text) {
    runs.push({ start: orig[start]!, len: ch.length, width: charWidth(ch), text: ch });
    start += ch.length;
  }
  return runs;
}

/**
 * The display width of one grapheme cluster in terminal columns, mirroring
 * tern-core's `cluster_width` (cell.rs:75): the sum of its member
 * characters' {@link charWidth}s, clamped to 2. A ZWJ emoji sequence or a
 * flag sums well past 2 but renders in exactly 2 columns; a base-plus-
 * combining sequence sums to its base's width; a lone zero-width mark sums
 * to 0.
 */
function clusterWidth(cluster: string): number {
  let width = 0;
  for (const ch of cluster) width += charWidth(ch);
  return Math.min(2, width);
}

/**
 * The code-unit index whose leading edge sits at (or snaps back before)
 * `column` display columns — always a grapheme-cluster boundary. Used to
 * translate the caret's display column — the value the compositor paints —
 * into a string index for editing. `column` always lands on a cluster
 * boundary: a column inside a wide cluster snaps to that cluster's start.
 * Escape sequences are skipped (they emit no run), so the returned index is
 * the original position of the visible character — a caret at column 0 of a
 * colored line rests before its first visible character, never inside the
 * leading escape.
 */
function columnToIndex(value: string, column: number): number {
  let col = 0;
  for (const run of clusterRuns(value)) {
    if (col + run.width > column) return run.start;
    col += run.width;
  }
  return value.length;
}

/** The display column of the cluster boundary at `index` (code units). A
 * mid-cluster index counts the containing cluster's full width — a cluster
 * is one glyph, so the caret cannot rest inside it. */
function indexToColumn(value: string, index: number): number {
  let col = 0;
  for (const run of clusterRuns(value)) {
    if (run.start >= index) break;
    col += run.width;
  }
  return col;
}

/** The last grapheme cluster before `index` (a mid-cluster index snaps back
 * to its containing cluster), or `null` when `index` is 0. */
function lastClusterBefore(value: string, index: number): ClusterRun | null {
  let last: ClusterRun | null = null;
  for (const run of clusterRuns(value)) {
    if (run.start >= index) break;
    last = run;
  }
  return last;
}

/** The cluster starting at `index` — or, defensively, containing a mid-
 * cluster `index` — or `null` at the end of `value`. */
function clusterAt(value: string, index: number): ClusterRun | null {
  for (const run of clusterRuns(value)) {
    if (run.start >= index) return run.start === index ? run : null;
    if (index < run.start + run.len) return run;
  }
  return null;
}

/** Snap a code-unit index to the grapheme-cluster boundary its caret rests
 * on: a mid-cluster index maps to the boundary AFTER its containing cluster —
 * where the caret visually paints, since `indexToColumn` counts a cluster
 * whole — and a boundary index is unchanged. The textarea counterpart of
 * `columnToIndex`'s wide-glyph snap, in code-unit space. */
function snapToClusterEnd(value: string, index: number): number {
  for (const run of clusterRuns(value)) {
    if (run.start >= index) return index;
    if (index < run.start + run.len) return run.start + run.len;
  }
  return index;
}

// --- Input ----------------------------------------------------------------

/** Props for the `Input` element. Style/layout keys flow to the framed box;
 * `value`/`caret`/`placeholder` drive the composed text leaf. */
export interface InputProps extends NodeProps {
  /** The input's current value (default `""`). */
  value?: string;
  /**
   * The caret's display column (default `0`). The compositor paints a block
   * caret at this column on the text leaf (compositor.rs:394-406).
   */
  caret?: number;
  /** Dimmed text shown when the value is empty. */
  placeholder?: string;
}

/** The text leaf props for an input state: the value (or the dimmed
 * placeholder when empty) plus the caret column. */
function inputTextProps(value: string, caret: number, placeholder: string | undefined): NodeProps {
  const empty = value === "";
  const textProps: NodeProps = { text: empty && placeholder !== undefined ? placeholder : value, caret };
  if (empty && placeholder !== undefined) textProps.dim = true;
  return textProps;
}

/** Apply a new value/caret to an input node: syncs the node's own props (the
 * source of truth for `editKey`) and the composed text leaf (what the
 * compositor paints). */
function setInputState(input: Node, value: string, caret: number): void {
  const props = input.props;
  const placeholder = typeof props.placeholder === "string" ? props.placeholder : undefined;
  const leaf = input.children[0];
  if (leaf !== undefined && leaf.type === "text") {
    leaf.setProps(inputTextProps(value, caret, placeholder));
  }
  input.setProps({ ...props, value, caret });
}

/**
 * Create an `input` element: a framed box (the input's style/layout props)
 * with a `text` leaf child carrying the value as its `text` prop, the caret
 * as a `caret` Int prop (painted as a block caret), and a dim placeholder
 * when the value is empty. Edit it with {@link editKey}.
 */
export function Input(props: InputProps = {}): Node {
  const value = props.value ?? "";
  const caret = props.caret ?? 0;
  const leaf = Text(inputTextProps(value, caret, props.placeholder));
  return Node.create("input", props, [leaf]);
}

/**
 * Apply a key to an input node, mutating its value and caret in place.
 * Handles `char` insert, `backspace`, `left`/`right`, `home` and `end`;
 * any other key leaves the input unchanged. Because the caret is a display
 * column, movement and deletion are multi-width aware (a wide char counts
 * two columns) and grapheme aware: the cursor, backspace and right/left
 * arrows move whole grapheme clusters (a ZWJ emoji or a base-plus-combining
 * sequence is one step, never split mid-cluster), mirroring tern-core's
 * cluster-width convention (cell.rs:75). Returns the new `{ value, caret }`.
 */
export function editKey(input: Node, key: KeyEvent): { value: string; caret: number } {
  const props = input.props;
  const value = typeof props.value === "string" ? props.value : "";
  const caret = typeof props.caret === "number" ? props.caret : 0;
  const next = applyEditKey(value, caret, key);
  if (next.value !== value || next.caret !== caret) {
    setInputState(input, next.value, next.caret);
  }
  return next;
}

/** Pure edit-key computation shared by {@link editKey}. */
function applyEditKey(
  value: string,
  caret: number,
  key: KeyEvent,
): { value: string; caret: number } {
  const name = key.name;
  if (name === "char" && !key.ctrl && !key.alt && key.char !== undefined) {
    const index = columnToIndex(value, caret);
    const next = value.slice(0, index) + key.char + value.slice(index);
    // The caret lands on the cluster boundary after the inserted char — the
    // display column at the end of the inserted text (a combining mark or
    // ZWJ that merges into a cluster advances by that cluster's width).
    return { value: next, caret: indexToColumn(next, index + key.char.length) };
  }
  if (name === "backspace") {
    const prev = lastClusterBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    const next = value.slice(0, prev.start) + value.slice(prev.start + prev.len);
    return { value: next, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "left") {
    const prev = lastClusterBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    return { value, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "right") {
    const cluster = clusterAt(value, columnToIndex(value, caret));
    if (cluster === null) return { value, caret };
    return { value, caret: caret + cluster.width };
  }
  if (name === "home") return { value, caret: 0 };
  if (name === "end") return { value, caret: indexToColumn(value, value.length) };
  return { value, caret };
}

/**
 * Insert pasted text into an input node at the caret, mutating its value and
 * caret in place — the paste counterpart of {@link editKey}. The caret is a
 * display column, so the insertion is multi-width aware: the text lands at the
 * grapheme-cluster boundary snapped back from the caret column (a column
 * inside a wide cluster inserts before that cluster), and the caret advances
 * by the pasted text's total display width (its clusters' widths — a ZWJ
 * emoji counts 2, never per code point). Returns the new `{ value, caret }`.
 */
export function pasteInto(input: Node, text: string): { value: string; caret: number } {
  const props = input.props;
  const value = typeof props.value === "string" ? props.value : "";
  const caret = typeof props.caret === "number" ? props.caret : 0;
  const index = columnToIndex(value, caret);
  const next = value.slice(0, index) + text + value.slice(index);
  const nextCaret = caret + textWidth(text);
  setInputState(input, next, nextCaret);
  return { value: next, caret: nextCaret };
}

// --- Textarea --------------------------------------------------------------

/**
 * Props for the `Textarea` element. Style/layout keys flow to the framed box;
 * `lines`/`row`/`col`/`scroll` are the edit model (JS bookkeeping on the
 * node, the source of truth for `editTextareaKey` — the lines array never
 * reaches the scene, mirroring `Panels`' `panels`); `width` soft-wraps long
 * lines into display rows, `height` sets the visible window.
 */
export interface TextareaProps extends NodeProps {
  /** The logical lines of text (default `[""]`). */
  lines?: string[];
  /** The cursor row — an index into `lines` (default 0). */
  row?: number;
  /** The cursor column — a char (code-unit) index into `lines[row]` (default
   * 0). */
  col?: number;
  /**
   * The soft-wrap width in cells; unset keeps each logical line on one
   * display row. When set, long lines wrap into display rows at this width
   * (token-aware, mirroring the Rust `wrap_line`), and each leaf is sized to
   * the width.
   */
  width?: number;
  /** The visible window in display rows; unset shows every display line.
   * When set, only the window around the caret is composed (vertical
   * scroll-to-caret). */
  height?: number;
  /** The top visible display row (vertical scroll, default 0). */
  scroll?: number;
}

/** The state reported by {@link editTextareaKey} (and the `<Textarea>`
 * callbacks). */
export interface TextareaState {
  /** The logical lines after the key. */
  lines: string[];
  /** The cursor row (index into `lines`). */
  row: number;
  /** The cursor column (char index into `lines[row]`). */
  col: number;
}

/**
 * The per-textarea vertical-move state: the display column preserved across a
 * run of up/down moves (keyed by node, like `Panels`' drag state).
 */
interface TextareaVerticalState {
  /** The display column kept across consecutive up/down moves. */
  preferredCol: number;
  /** Whether the previous key was a vertical move (the column is only
   * re-captured on the first move of a run). */
  sticky: boolean;
}

/** The vertical-move state per textarea node (JS bookkeeping — never scene
 * props, mirroring `Panels`' `panelDrags`). */
const textareaVertical = new WeakMap<Node, TextareaVerticalState>();

/** The wrap width of a textarea's props, or `null` when no width is set. */
function textareaWidth(props: TextareaProps): number | null {
  const w = props.width;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.floor(w) : null;
}

/** The visible window of a textarea's props (rows), or `null` when unset. */
function textareaHeight(props: TextareaProps): number | null {
  const h = props.height;
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.floor(h) : null;
}

/** The total display width of a string in terminal columns — the sum of its
 * grapheme clusters' widths (a ZWJ emoji counts 2, never per code point).
 * Escape sequences consume zero cells (stripped at ingestion by
 * {@link clusterRuns}), so a colored string measures exactly as its plain
 * text. */
function textWidth(text: string): number {
  let width = 0;
  for (const run of clusterRuns(text)) width += run.width;
  return width;
}

/**
 * Soft-wrap `line` into display lines of at most `width` columns plus the
 * code-unit index (within `line`) where each display line starts. This is
 * the canonical pre-render measurement — the JS mirror of the Rust
 * `wrap_line` (token-aware greedy wrap): a whitespace-free token that does
 * not fit on the current display line wraps whole to the next when it can
 * fit there; a token wider than the width hard-breaks across rows; a
 * trailing space at a full display line is dropped (the wrap would collapse
 * it anyway); an embedded `\n` ends the display line. Escape sequences
 * (ANSI/OSC/CSI, see {@link stripEscapes}) are stripped at ingestion before
 * wrapping, so they consume zero cells, never break a token, and never
 * appear in a row's `text`. The returned `start` offsets are code-unit
 * indices into the ORIGINAL `line`, translated through the strip map: a row
 * starts at its first visible character's original index, so offsets are
 * exact and never land inside an escape — a stripped escape belongs to no
 * display line, so its bytes sit in the trailing row's original span. A
 * character dropped by the wrap belongs to no display line, so caret
 * navigation stays consistent with what is composed. Downstream consumers
 * count rows at a width through {@link measureText} — never a hand-written
 * mirror — so the measurement cannot drift from what the compositor paints.
 */
export function wrapLineWithOffsets(
  line: string,
  width: number | null,
): Array<{ text: string; start: number }> {
  if (width === null) {
    const stripped = stripEscapes(line);
    return [{ text: stripped.text, start: stripped.orig[0]! }];
  }
  const limit = Math.max(1, Math.floor(width));
  const { text, orig } = stripEscapes(line);
  const rows: Array<{ text: string; start: number }> = [];
  let row = "";
  let rowWidth = 0;
  let rowStart = 0;
  let token = "";
  let tokenStart = 0;
  let idx = 0;

  const flushToken = () => {
    if (token === "") return;
    const tokenWidth = textWidth(token);
    if (row !== "" && rowWidth + tokenWidth > limit && tokenWidth <= limit) {
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = tokenStart;
    }
    // The code-unit index (within the stripped `text`) of the current token
    // cluster; every pushed `start` is translated to the original line
    // through `orig`.
    let cur = tokenStart;
    for (const run of clusterRuns(token)) {
      const w = run.width;
      if (w === 0) {
        cur += run.len;
        continue;
      }
      if (rowWidth + w > limit) {
        rows.push({ text: row, start: orig[rowStart]! });
        row = "";
        rowWidth = 0;
        if (w > limit) {
          cur += run.len; // a cluster wider than a fresh row is dropped whole
          rowStart = cur;
          continue;
        }
        rowStart = cur; // the wrapped row starts at this cluster
      }
      row += run.text;
      rowWidth += w;
      cur += run.len;
    }
    token = "";
  };

  for (const ch of text) {
    if (ch === "\n") {
      flushToken();
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = idx + 1;
    } else if (ch === " ") {
      flushToken();
      if (rowWidth + 1 <= limit) {
        row += " ";
        rowWidth += 1;
      }
    } else {
      if (token === "") tokenStart = idx;
      token += ch;
    }
    idx += ch.length;
  }
  flushToken();
  rows.push({ text: row, start: orig[rowStart]! });
  if (rows.length === 0) rows.push({ text: "", start: 0 });
  return rows;
}

/** The number of display rows `line` occupies at the wrap width (1 when no
 * width is set). */
function wrapCount(line: string, width: number | null): number {
  return width === null ? 1 : wrapLineWithOffsets(line, width).length;
}

/**
 * Pre-render measurement of `text` at wrap width `width`: how many display
 * rows the text occupies and the widest display-line width in cells. The
 * text is split on `\n` and each logical line is soft-wrapped through
 * {@link wrapLineWithOffsets} — the canonical mirror of the Rust
 * `wrap_line` — so the row count is exactly what the compositor would
 * compose. Escape sequences consume zero cells (stripped at ingestion, see
 * {@link stripEscapes}), so a colored line measures exactly as its plain
 * text. A non-positive (or non-finite) `width` follows the file's "no
 * width" convention (`textareaWidth` maps such widths to `null`): each
 * logical line counts as one display row and the widest display line is the
 * widest logical line. An empty string occupies exactly one empty display
 * row (width 0).
 */
export function measureText(
  text: string,
  width: number,
): { rows: number; maxWidth: number } {
  const wrapWidth = Number.isFinite(width) && width > 0 ? width : null;
  let rows = 0;
  let maxWidth = 0;
  for (const line of text.split("\n")) {
    const wrapped = wrapLineWithOffsets(line, wrapWidth);
    rows += wrapped.length;
    for (const entry of wrapped) {
      const entryWidth = textWidth(entry.text);
      if (entryWidth > maxWidth) maxWidth = entryWidth;
    }
  }
  return { rows, maxWidth };
}

/** The display row where logical line `row` begins. */
function displayBase(lines: string[], row: number, width: number | null): number {
  let base = 0;
  for (let i = 0; i < row; i++) base += wrapCount(lines[i]!, width);
  return base;
}

/** The total number of display rows across all logical lines. */
function totalDisplayRows(lines: string[], width: number | null): number {
  return lines.reduce((sum, line) => sum + wrapCount(line, width), 0);
}

/** The display-line offset (within `line`'s wrapped lines) that contains the
 * char index `col`. A char dropped by the wrap maps to the display line it
 * trails — and so does an escape-stripped sequence, whose bytes sit inside
 * the trailing row's original span. The check needs no strip map: the rows'
 * original `start`s tile `line` (each row spans `start[i]..start[i+1)`, the
 * last reaching `line.length`), so `col` trails row `i` exactly while it is
 * before row `i+1`'s start. */
function offsetOfCol(line: string, col: number, width: number | null): number {
  const wrapped = wrapLineWithOffsets(line, width);
  for (let i = 0; i < wrapped.length; i++) {
    const end = i + 1 < wrapped.length ? wrapped[i + 1]!.start : line.length;
    if (col < end) return i;
  }
  return wrapped.length - 1;
}

/** The caret's display row across the whole wrapped text. */
function caretDisplayRow(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  return displayBase(lines, row, width) + offsetOfCol(lines[row]!, col, width);
}

/** The display column of `col` within display-line `offset` of `line`, and
 * the code-unit index where that display line starts. `col` (an original
 * index) is translated through the strip map first, so a caret resting on —
 * or inside — an escape measures against the visible text only: an escape
 * interior trails its content, exactly like a char dropped by the wrap. */
function caretDisplayIn(
  line: string,
  col: number,
  offset: number,
  width: number | null,
): { col: number; start: number } {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ?? { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = Math.max(0, Math.min(strippedIndexAt(orig, col) - base, entry.text.length));
  return { col: indexToColumn(entry.text, local), start: entry.start };
}

/** The caret's display column within its own display line. */
function currentDisplayCol(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  const offset = offsetOfCol(lines[row]!, col, width);
  return caretDisplayIn(lines[row]!, col, offset, width).col;
}

/** The `(logical row, display-line offset)` for display row `target`. */
function logicalAtDisplayRow(
  lines: string[],
  target: number,
  width: number | null,
): { row: number; offset: number } {
  let acc = 0;
  for (let r = 0; r < lines.length; r++) {
    const count = wrapCount(lines[r]!, width);
    if (target < acc + count) return { row: r, offset: target - acc };
    acc += count;
  }
  const last = Math.max(0, lines.length - 1);
  return { row: last, offset: Math.max(0, wrapCount(lines[last]!, width) - 1) };
}

/** The char (code-unit) index into `line` at display column `targetCol`
 * within display-line `offset` (clamped to the display line's end; a column
 * inside a wide glyph snaps to that glyph's start). The cluster boundary is
 * translated back through the strip map, so the returned index is the
 * original position of the visible character — never inside an escape. */
function charAtDisplayCol(
  line: string,
  offset: number,
  targetCol: number,
  width: number | null,
): number {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ?? { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = columnToIndex(entry.text, targetCol);
  return orig[base + local]!;
}

/** The scroll offset that keeps the caret's display row inside the visible
 * window (no-op with no height set). */
function visibleScroll(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
  height: number | null,
  current: number,
): number {
  if (height === null) return 0;
  const h = Math.max(1, height);
  const caret = caretDisplayRow(lines, row, col, width);
  if (caret < current) return caret;
  if (caret >= current + h) return caret + 1 - h;
  return current;
}

/** The text leaf props of one visible display row: its wrapped text, sized to
 * the wrap width, plus the caret display column when the row holds the
 * caret. */
function textareaLeafProps(
  text: string,
  width: number | null,
  caretCol: number | null,
): NodeProps {
  const props: NodeProps = { text };
  if (width !== null) props.width = width;
  if (caretCol !== null) props.caret = caretCol;
  return props;
}

/** Rebuild a textarea's composition from its props: one text leaf per visible
 * display row (the `scroll..scroll+height` window, or every row with no
 * height), the caret's leaf carrying its `caret` display column. */
function rebuildTextarea(textarea: Node): void {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? props.lines : [""];
  const row = Math.max(0, Math.min(typeof props.row === "number" ? Math.floor(props.row) : 0, lines.length - 1));
  const col = Math.max(0, Math.min(typeof props.col === "number" ? Math.floor(props.col) : 0, lines[row]!.length));
  const width = textareaWidth(props);
  const height = textareaHeight(props);
  const scroll = visibleScroll(
    lines,
    row,
    col,
    width,
    height,
    typeof props.scroll === "number" ? props.scroll : 0,
  );
  const caretRow = caretDisplayRow(lines, row, col, width);
  const total = totalDisplayRows(lines, width);
  const first = Math.min(scroll, total);
  const last = Math.min(scroll + (height === null ? total : height), total);
  for (const child of [...textarea.children]) child.remove();
  for (let displayRow = first; displayRow < last; displayRow++) {
    const { row: lineRow, offset } = logicalAtDisplayRow(lines, displayRow, width);
    const wrapped = wrapLineWithOffsets(lines[lineRow]!, width);
    const entry = wrapped[Math.min(offset, wrapped.length - 1)] ?? { text: "", start: 0 };
    let caretCol: number | null = null;
    if (displayRow === caretRow) {
      caretCol = caretDisplayIn(lines[lineRow]!, col, offset, width).col;
    }
    textarea.addChild(Text(textareaLeafProps(entry.text, width, caretCol)));
  }
}

/**
 * Create a `textarea` element: a framed box with one text leaf per visible
 * display line (soft-wrapped at `width`, vertically scrolled to keep the
 * caret visible within `height`), the caret's leaf carrying its `caret`
 * display column. `lines`/`row`/`col`/`scroll` stay on the node as the edit
 * model's source of truth. Edit it with {@link editTextareaKey}.
 */
export function Textarea(props: TextareaProps = {}): Node {
  const node = Node.create("textarea", props, []);
  textareaVertical.set(node, { preferredCol: 0, sticky: false });
  rebuildTextarea(node);
  return node;
}

/** The pure next-state computation shared by {@link editTextareaKey}.
 * `up`/`down` navigate the soft-wrapped display lines with `preferredCol`;
 * the other keys are the single-line edits generalized across lines. */
function textareaKeyPosition(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
  preferredCol: number,
  key: KeyEvent,
): { lines: string[]; row: number; col: number; changed: boolean } {
  const name = key.name;
  const line = lines[row] ?? "";
  // Snap a mid-cluster cursor to the cluster boundary its caret rests on
  // (after the containing cluster — where it visually paints): every edit
  // and movement lands on a grapheme-cluster boundary, never inside one.
  col = snapToClusterEnd(line, col);

  if (name === "up" || name === "down") {
    const caretRow = caretDisplayRow(lines, row, col, width);
    const total = totalDisplayRows(lines, width);
    const canMove = name === "up" ? caretRow > 0 : caretRow + 1 < total;
    if (!canMove) return { lines, row, col, changed: false };
    const target = name === "up" ? caretRow - 1 : caretRow + 1;
    const at = logicalAtDisplayRow(lines, target, width);
    const nextCol = charAtDisplayCol(lines[at.row]!, at.offset, preferredCol, width);
    return { lines, row: at.row, col: nextCol, changed: at.row !== row || nextCol !== col };
  }
  if (name === "char" && !key.ctrl && !key.alt && key.char !== undefined) {
    const next = line.slice(0, col) + key.char + line.slice(col);
    const nextLines = [...lines];
    nextLines[row] = next;
    return { lines: nextLines, row, col: col + key.char.length, changed: true };
  }
  if (name === "backspace") {
    if (col > 0) {
      const prev = lastClusterBefore(line, col);
      if (prev === null) return { lines, row, col, changed: false };
      const next = line.slice(0, prev.start) + line.slice(prev.start + prev.len);
      const nextLines = [...lines];
      nextLines[row] = next;
      return { lines: nextLines, row, col: col - prev.len, changed: true };
    }
    if (row > 0) {
      // Join into the previous line: the cursor lands at the join point (the
      // previous line's end, before the appended tail).
      const prevLen = lines[row - 1]!.length;
      const nextLines = [...lines];
      const tail = nextLines.splice(row, 1)[0] ?? "";
      nextLines[row - 1] = nextLines[row - 1]! + tail;
      return { lines: nextLines, row: row - 1, col: prevLen, changed: true };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "delete") {
    if (col < line.length) {
      const cluster = clusterAt(line, col);
      const len = cluster === null ? 1 : cluster.len;
      const next = line.slice(0, col) + line.slice(col + len);
      const nextLines = [...lines];
      nextLines[row] = next;
      return { lines: nextLines, row, col, changed: true };
    }
    if (row + 1 < lines.length) {
      const nextLines = [...lines];
      const tail = nextLines.splice(row + 1, 1)[0] ?? "";
      nextLines[row] = nextLines[row]! + tail;
      return { lines: nextLines, row, col, changed: true };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "enter") {
    // Split the line at the cursor: the tail becomes a new line below, and
    // the caret moves to the start of it.
    const nextLines = [...lines];
    nextLines[row] = line.slice(0, col);
    nextLines.splice(row + 1, 0, line.slice(col));
    return { lines: nextLines, row: row + 1, col: 0, changed: true };
  }
  if (name === "left") {
    if (col > 0) {
      const prev = lastClusterBefore(line, col);
      return { lines, row, col: prev === null ? 0 : prev.start, changed: prev !== null };
    }
    if (row > 0) return { lines, row: row - 1, col: lines[row - 1]!.length, changed: true };
    return { lines, row, col, changed: false };
  }
  if (name === "right") {
    if (col < line.length) {
      const cluster = clusterAt(line, col);
      const len = cluster === null ? 1 : cluster.len;
      return { lines, row, col: col + len, changed: true };
    }
    if (row + 1 < lines.length) return { lines, row: row + 1, col: 0, changed: true };
    return { lines, row, col, changed: false };
  }
  if (name === "home") return { lines, row, col: 0, changed: col !== 0 };
  if (name === "end") return { lines, row, col: line.length, changed: col !== line.length };
  return { lines, row, col, changed: false };
}

/**
 * Apply a key to a textarea node, mutating its lines/row/col (and vertical
 * scroll) in place and rebuilding the composed line leaves — the Textarea
 * counterpart of {@link editKey}. Handles `char` insert, `backspace` /
 * `delete` (joining adjacent lines at the boundaries), `left`/`right` /
 * `home`/`end`, `enter` (split), and `up`/`down` across the soft-wrapped
 * display lines (preserving a preferred display column across a run of
 * vertical moves). Movement and deletion are grapheme aware — `left` /
 * `right` / `backspace` / `delete` step whole grapheme clusters (a ZWJ emoji
 * or a base-plus-combining sequence is one step, never split mid-cluster),
 * mirroring tern-core's cluster-width convention — and a mid-cluster cursor
 * (e.g. from caller props) snaps to the boundary after its cluster before
 * any edit. Any other key leaves the textarea unchanged. Returns the new
 * `{ lines, row, col }`.
 */
export function editTextareaKey(textarea: Node, event: KeyEvent): TextareaState {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? [...props.lines] : [""];
  const row = Math.max(0, Math.min(typeof props.row === "number" ? Math.floor(props.row) : 0, lines.length - 1));
  const col = Math.max(0, Math.min(typeof props.col === "number" ? Math.floor(props.col) : 0, lines[row]!.length));
  const width = textareaWidth(props);
  const height = textareaHeight(props);
  const vertical = textareaVertical.get(textarea) ?? { preferredCol: 0, sticky: false };
  const verticalKey = event.name === "up" || event.name === "down";
  // A vertical run keeps the column captured on its first move; the first
  // move of a run (or any horizontal move / edit) re-captures it.
  if (verticalKey && !vertical.sticky) {
    vertical.preferredCol = currentDisplayCol(lines, row, col, width);
    vertical.sticky = true;
  }
  const next = textareaKeyPosition(lines, row, col, width, vertical.preferredCol, event);
  if (!verticalKey) {
    vertical.sticky = false;
    vertical.preferredCol = currentDisplayCol(next.lines, next.row, next.col, width);
  }
  if (next.changed) {
    const scroll = visibleScroll(
      next.lines,
      next.row,
      next.col,
      width,
      height,
      typeof props.scroll === "number" ? props.scroll : 0,
    );
    textarea.setProps({ ...props, lines: next.lines, row: next.row, col: next.col, scroll });
    rebuildTextarea(textarea);
  }
  textareaVertical.set(textarea, vertical);
  return { lines: next.lines, row: next.row, col: next.col };
}

/**
 * Insert pasted text into a textarea node at the caret, mutating its
 * lines/row/col (and vertical scroll) in place and rebuilding the composed
 * line leaves — the paste counterpart of {@link editTextareaKey}. A pasted
 * `\n` splits the text into new logical lines (the pre-caret head stays on
 * the current line, the post-caret tail joins the last pasted segment), and
 * the caret lands at the end of the pasted text. The caret column is a
 * code-unit index into the line, so wide characters are handled by the same
 * cluster math as `editTextareaKey`; a paste lands on a grapheme-cluster
 * boundary (a mid-cluster cursor snaps to the boundary after its cluster),
 * and wrap width and vertical scroll stay multi-width aware through the
 * shared soft-wrap machinery. Returns the new `{ lines, row, col }`.
 */
export function pasteIntoTextarea(textarea: Node, text: string): TextareaState {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? [...props.lines] : [""];
  const row = Math.max(0, Math.min(typeof props.row === "number" ? Math.floor(props.row) : 0, lines.length - 1));
  const rawCol = Math.max(
    0,
    Math.min(typeof props.col === "number" ? Math.floor(props.col) : 0, lines[row]!.length),
  );
  // A paste lands on a grapheme-cluster boundary: a mid-cluster cursor snaps
  // to the boundary after its cluster (where its caret visually paints).
  const col = snapToClusterEnd(lines[row]!, rawCol);
  const width = textareaWidth(props);
  const height = textareaHeight(props);

  // Split the pasted text on newlines: the head replaces the pre-caret part
  // of the current line, the middle segments become new lines, and the tail
  // of the original line joins the last segment (mirroring a multi-line
  // `enter` + insert edit).
  const segments = text.split("\n");
  const head = segments[0] ?? "";
  const nextLines = [...lines];
  const pre = nextLines[row]!.slice(0, col);
  const originalTail = nextLines[row]!.slice(col);
  if (segments.length === 1) {
    nextLines[row] = pre + head + originalTail;
  } else {
    nextLines[row] = pre + head;
    const middle = segments.slice(1);
    const last = middle.length - 1;
    nextLines.splice(
      row + 1,
      0,
      ...middle.map((segment, i) => (i === last ? segment + originalTail : segment)),
    );
  }

  const nextRow = row + Math.max(0, segments.length - 1);
  // Single-segment paste keeps the caret on the same line, advanced past the
  // pasted text; a multi-line paste lands at the end of the last pasted
  // segment (the pre-caret head stayed behind on the original line).
  const nextCol = segments.length > 1
    ? (segments[segments.length - 1] ?? "").length
    : col + (segments[0] ?? "").length;

  const vertical = textareaVertical.get(textarea) ?? { preferredCol: 0, sticky: false };
  // A paste is a horizontal edit: end any vertical-move run and re-capture
  // the preferred column at the new caret, like `editTextareaKey` does for
  // non-vertical keys.
  vertical.sticky = false;
  vertical.preferredCol = currentDisplayCol(nextLines, nextRow, nextCol, width);
  textareaVertical.set(textarea, vertical);

  const scroll = visibleScroll(
    nextLines,
    nextRow,
    nextCol,
    width,
    height,
    typeof props.scroll === "number" ? props.scroll : 0,
  );
  textarea.setProps({ ...props, lines: nextLines, row: nextRow, col: nextCol, scroll });
  rebuildTextarea(textarea);
  return { lines: nextLines, row: nextRow, col: nextCol };
}

// --- Spinner --------------------------------------------------------------

/** Props for the `Spinner` element. `value`+`max` (+`width`) select the
 * determinate bar; `frames`+`frame` select the indeterminate glyph. */
export interface SpinnerProps extends NodeProps {
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
}

/** The default indeterminate frame glyphs (braille spinner). */
export const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The text a spinner renders for the given props: the determinate
 * `'▓'`/`'░'` bar (exactly `ceil(value/max * width)` filled cells) or the
 * frame glyph at `frame` (wrapping). */
function spinnerText(props: SpinnerProps): string {
  const { value, max } = props;
  if (typeof value === "number" && typeof max === "number" && max > 0) {
    const width = typeof props.width === "number" ? Math.max(0, props.width) : 10;
    const filled = Math.max(0, Math.min(width, Math.ceil((value / max) * width)));
    return "▓".repeat(filled) + "░".repeat(width - filled);
  }
  const frames = props.frames ?? DEFAULT_SPINNER_FRAMES;
  if (frames.length === 0) return "";
  const frame = typeof props.frame === "number" ? props.frame : 0;
  return frames[((frame % frames.length) + frames.length) % frames.length] ?? "";
}

/**
 * Create a `spinner` element: a `text` leaf rendering a determinate
 * `'▓'`/`'░'` progress bar (from `value`/`max`/`width`) or an indeterminate
 * frame glyph (from `frames`/`frame`). Advance it with {@link tick}.
 */
export function Spinner(props: SpinnerProps = {}): Node {
  return Node.create("spinner", { ...props, text: spinnerText(props) }, []);
}

/**
 * Advance an indeterminate spinner's frame by one (wrapping around the frame
 * list) and repaint it via `setProps`. For a determinate spinner this
 * re-derives the bar from the current props and is a no-op when the bar is
 * unchanged. Returns the spinner's new text.
 */
export function tick(spinner: Node): string {
  const props = spinner.props as SpinnerProps;
  const current = typeof props.frame === "number" ? props.frame : 0;
  const determinate = typeof props.value === "number" && typeof props.max === "number";
  const frame = determinate ? current : current + 1;
  const text = spinnerText({ ...props, frame });
  if (text !== props.text) spinner.setProps({ ...props, frame, text });
  return text;
}

// --- StatusBar ------------------------------------------------------------

/** A status-bar segment: a string (wrapped in a `Text` node) or a `Node`. */
export type StatusBarSegment = string | Node;

/** Props for the `StatusBar` element. `left`/`center`/`right` are the
 * segments; remaining props style the strip itself. */
export interface StatusBarProps extends NodeProps {
  /** The left-aligned segment. */
  left?: StatusBarSegment;
  /** The centered segment. */
  center?: StatusBarSegment;
  /** The right-aligned segment. */
  right?: StatusBarSegment;
}

function toSegment(segment: StatusBarSegment): Node {
  return typeof segment === "string" ? Text({ text: segment }) : segment;
}

/**
 * Create a `status_bar` element: a single-row flex strip with
 * `justify_content: "space-between"` whose children are the left/center/
 * right segment `Text` nodes, in that order (missing segments are omitted).
 * The segment keys are lifted out of the strip's props — `left`/`right` are
 * absolute-position inset keywords in tern-layout, so they must never reach
 * the layout engine.
 *
 * The strip is stamped `status_bar: true`: the compositor reads that marker
 * to reserve the bottom viewport row for the strip (docs/components.md
 * "StatusBar — Reserved row") — panels lay out one row shorter and the strip
 * pins to the reserved row. Like `z_index` / `wrap`, the marker is
 * compositor-consumed (it flows through the binding into the scene prop map)
 * and never reaches the layout engine.
 */
export function StatusBar(props: StatusBarProps = {}): Node {
  const segments: Node[] = [];
  if (props.left !== undefined) segments.push(toSegment(props.left));
  if (props.center !== undefined) segments.push(toSegment(props.center));
  if (props.right !== undefined) segments.push(toSegment(props.right));
  const strip: NodeProps = {
    ...props,
    flex_direction: "row",
    justify_content: "space-between",
    height: props.height ?? 1,
    // Compositor-consumed marker (docs/components.md "StatusBar — Reserved
    // row"): the strip owns the bottom viewport row, so no panel/scroll
    // region overlaps it. Mirrors the Rust renderable's stamp in
    // src/core/tern-components/src/statusbar.rs.
    status_bar: true,
  };
  const plain = strip as Record<string, unknown>;
  delete plain.left;
  delete plain.center;
  delete plain.right;
  return Node.create("status_bar", strip, segments);
}

// --- Panels ---------------------------------------------------------------

/** A panel inside a `Panels` element: a header plus a body node. */
export interface PanelSpec {
  /** The panel's header text. */
  header: string;
  /** The panel's body node (hidden while the panel is collapsed). */
  body: Node;
  /** Start collapsed (default `false`). */
  collapsed?: boolean;
  /** The panel's minimum main-axis size in cells (default 1), enforced by
   * the mouse drag-resize helpers (roadmap Phase 2) and, once tern-layout
   * consumes them, the layout engine. */
  min_width?: number;
  /** The panel's minimum cross-axis size in cells (default 1), enforced by
   * the mouse drag-resize helpers. */
  min_height?: number;
}

/** Props for the `Panels` element. `panels`/`direction` are consumed by the
 * factory (the spec list is JS bookkeeping, never scene props); remaining
 * props style the stack container. */
export interface PanelsProps extends NodeProps {
  /** The panels, in stack order (top to bottom for a column). */
  panels: PanelSpec[];
  /** The active panel index (default 0) — its header renders bold. */
  active?: number;
  /** Stack direction (default `"column"`). */
  direction?: "row" | "column";
}

/**
 * Panel box -> its body node, kept so a collapsed body can be restored by
 * {@link expandPanel} / {@link togglePanel} after `Node.remove`.
 */
const panelBodies = new WeakMap<Node, Node>();

/** Build one panel box: a header `Text` plus the body (omitted when the
 * panel starts collapsed). The body is always recorded in `panelBodies`.
 * Children are wired through `addChild` so the parent link exists — a later
 * `body.remove()` (collapse) splices the panel's children correctly on a
 * detached tree. */
function buildPanel(spec: PanelSpec, isActive: boolean): Node {
  const panelProps: NodeProps = { flex_direction: "column" };
  // Undefined props must not reach the scene (the binding's `set_props`
  // cannot serialize them), so min sizes are set only when declared.
  if (spec.min_width !== undefined) panelProps.min_width = spec.min_width;
  if (spec.min_height !== undefined) panelProps.min_height = spec.min_height;
  const panel = Box(panelProps);
  panel.addChild(Text({ text: spec.header, bold: isActive }));
  if (!(spec.collapsed ?? false)) panel.addChild(spec.body);
  panelBodies.set(panel, spec.body);
  return panel;
}

/** The panel box at `index` within a `panels` element, or `undefined`. */
function panelAt(panels: Node, index: number): Node | undefined {
  return panels.children[index];
}

/**
 * Create a `panels` element: a flex stack (default column) of panel boxes,
 * each with a header `Text` and a body node. The active panel's header is
 * bold. Manage panels with {@link collapsePanel}, {@link expandPanel},
 * {@link togglePanel} and {@link focusPanel}.
 */
export function Panels(props: PanelsProps): Node {
  const direction = props.direction ?? "column";
  const active = props.active ?? 0;
  const panels = props.panels.map((spec, index) => buildPanel(spec, index === active));
  const boxProps: NodeProps = { ...props, flex_direction: direction, active };
  // The 1-cell gutter between adjacent panels (the mouse drag-resize handle,
  // roadmap Phase 2; matches the Rust renderable's default `gap`). An explicit
  // `gap` wins — `gap: 0` removes the gutter.
  if (boxProps.gap === undefined) boxProps.gap = 1;
  const plain = boxProps as Record<string, unknown>;
  delete plain.panels;
  delete plain.direction;
  return Node.create("panels", boxProps, panels);
}

/** Collapse the panel at `index`: detach its body from the scene tree. */
export function collapsePanel(panels: Node, index: number): void {
  const panel = panelAt(panels, index);
  if (panel === undefined) return;
  const body = panelBodies.get(panel);
  if (body === undefined || !panel.children.includes(body)) return;
  body.remove();
}

/** Expand the panel at `index`: re-attach its body under the panel. */
export function expandPanel(panels: Node, index: number): void {
  const panel = panelAt(panels, index);
  if (panel === undefined) return;
  const body = panelBodies.get(panel);
  if (body === undefined || panel.children.includes(body)) return;
  panel.addChild(body);
}

/**
 * Toggle the collapsed state of the panel at `index`. Returns the new
 * collapsed state (`true` = collapsed; `false` when the index or the panel's
 * body is unknown).
 */
export function togglePanel(panels: Node, index: number): boolean {
  const panel = panelAt(panels, index);
  if (panel === undefined) return false;
  const body = panelBodies.get(panel);
  if (body === undefined) return false;
  const wasCollapsed = !panel.children.includes(body);
  if (wasCollapsed) {
    expandPanel(panels, index);
  } else {
    collapsePanel(panels, index);
  }
  return !wasCollapsed;
}

/** Set the active panel index and restyle the headers (the active panel's
 * header is bold). */
export function focusPanel(panels: Node, index: number): void {
  if (panelAt(panels, index) === undefined) return;
  panels.setProps({ ...panels.props, active: index });
  for (let i = 0; i < panels.children.length; i++) {
    const header = panels.children[i]?.children[0];
    if (header !== undefined && header.type === "text") {
      header.setProps({ ...header.props, bold: i === index });
    }
  }
}

// --- Panel drag-resize ------------------------------------------------------
//
// Mouse drag-resize handles (roadmap Phase 2): a `Panels` stack lays its
// panels out with a 1-cell gutter between adjacent panels (`gap: 1` by
// default). Pressing `down_left` on a gutter cell starts a drag session
// ({@link startPanelDrag}); each subsequent `drag_left` moves the split by
// setting an absolute `flex_basis` on the pane above/left of the gutter
// ({@link dragPanels}, clamped to the pane's min size — and to the space the
// neighbor's min size leaves — in the stack direction); any `up_*` ends the
// session ({@link endPanelDrag}). The session lives on the panels node, so
// multiple independent stacks can be dragged in the same app.
//
// The helpers read geometry from `Node.contentSize()` (the laid-out rects
// from the most recent render) and interpret the event's `column`/`row` as
// offsets from the panels element's top-left corner — the panels element is
// expected at the scene origin (the common case for a root-level split; the
// scene API exposes no node origin query yet). Setting `flex_basis` is the
// pane-side half of a split resize: the engine consumes it once tern-layout
// maps the prop into taffy's flex-basis (roadmap Phase 2 "resize -> layout
// reflow"); until then the mutation is recorded on the scene node and the
// drag math is fully observable (constitution: the interaction math stays in
// the element, the Rust compositor owns layout/paint).

/** The default minimum main-axis size a dragged pane keeps, in cells
 * (used when the pane declares no `min_width` / `min_height`). */
export const PANEL_DRAG_MIN_SIZE = 1;

/** The pane a panel drag is resizing: the pane above/left of the gutter. */
export interface PanelDragHandle {
  /** The index of the resized pane within the panels element. */
  index: number;
  /** The stack direction of the panels element. */
  direction: "row" | "column";
}

/** The outcome of one {@link dragPanels} step. */
export interface PanelDragResult extends PanelDragHandle {
  /** The `flex_basis` applied to the resized pane (post-clamp). */
  flex_basis: number;
}

/** The active drag session on a panels node (kept in a WeakMap). */
interface PanelDragState {
  index: number;
  direction: "row" | "column";
  /** The main-axis coordinate of the last handled event. */
  lastMain: number;
  /** The resized pane's current flex-basis (cells). */
  basis: number;
  /** The resized pane's lower clamp (its `min_height`/`min_width`, or 1). */
  minSize: number;
  /** The neighbor pane's lower clamp (the upper-bound slack). */
  neighborMin: number;
  /** The upper clamp for the resized pane, or `Infinity` when the panels
   * element's laid-out size is unavailable (detached). */
  upper: number;
}

/** The active drag session per panels node (one at a time per stack). */
const panelDrags = new WeakMap<Node, PanelDragState>();

/** Read a prop as a finite number, or `null` when it is not one. */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The main-axis gap between panels, mirroring tern-layout's precedence
 * (`column_gap`/`row_gap` override `gap`; the Panels factory defaults `gap`
 * to 1). */
function panelMainGap(panels: Node, direction: "row" | "column"): number {
  const gap = asFiniteNumber(panels.props.gap);
  if (direction === "column") {
    return asFiniteNumber(panels.props.row_gap) ?? gap ?? 1;
  }
  return asFiniteNumber(panels.props.column_gap) ?? gap ?? 1;
}

/** The minimum main-axis size a pane keeps: its `min_height` (column) /
 * `min_width` (row) prop, or {@link PANEL_DRAG_MIN_SIZE}. */
function panelMinSize(panel: Node, direction: "row" | "column"): number {
  const key = direction === "column" ? "min_height" : "min_width";
  return asFiniteNumber(panel.props[key]) ?? PANEL_DRAG_MIN_SIZE;
}

/** The main-axis laid-out size of a pane, or `null` when the tree is
 * detached (`contentSize` throws without a scene). */
function mainAxisSize(panel: Node, direction: "row" | "column"): number | null {
  try {
    const size = panel.contentSize();
    return direction === "column" ? size.height : size.width;
  } catch {
    return null;
  }
}

/** The main-axis coordinate of a mouse event for the stack direction. */
function mainAxisCoord(event: MouseEventJs, direction: "row" | "column"): number {
  return direction === "column" ? event.row : event.column;
}

/**
 * Start a panel drag: a `down_left` press on the 1-cell gutter between two
 * adjacent panels records the session and returns the handle for the pane
 * being resized (the pane above/left of the gutter). The gutter cell is the
 * strip at the boundary of the two panels' laid-out extents (`Node.contentSize()`
 * along the stack's main axis, plus the `gap` between panels). Returns `null`
 * when the press is not `down_left`, is not on a gutter (a panel body or a
 * stack with fewer than two panels), or the panels element is detached (no
 * geometry).
 */
export function startPanelDrag(panels: Node, event: MouseEventJs): PanelDragHandle | null {
  if (event.kind !== "down_left") return null;
  const direction = panels.props.flex_direction === "row" ? "row" : "column";
  const children = panels.children;
  if (children.length < 2) return null;

  const gap = panelMainGap(panels, direction);
  const m = mainAxisCoord(event, direction);

  // Walk the cumulative main-axis extents: panel i spans
  // [cursor, cursor + size_i), then the gutter spans
  // [cursor + size_i, cursor + size_i + gap).
  let cursor = 0;
  for (let i = 0; i < children.length - 1; i++) {
    const size = mainAxisSize(children[i]!, direction);
    if (size === null) return null; // detached subtree — no geometry
    const gutterStart = cursor + size;
    if (m >= gutterStart && m < gutterStart + gap) {
      const pane = children[i]!;
      const neighbor = children[i + 1]!;
      const laidOut = size;
      const basis = asFiniteNumber(pane.props.flex_basis) ?? laidOut;
      const minSize = panelMinSize(pane, direction);
      const neighborMin = panelMinSize(neighbor, direction);
      // The stack's laid-out main size (the container rect) bounds the
      // pane so the neighbor keeps at least its min size.
      const stackMain = mainAxisSize(panels, direction);
      const upper = stackMain === null ? Infinity : stackMain - gap - neighborMin;
      panelDrags.set(panels, {
        index: i,
        direction,
        lastMain: m,
        basis,
        minSize,
        neighborMin,
        upper,
      });
      return { index: i, direction };
    }
    cursor = gutterStart + gap;
  }
  return null;
}

/**
 * Move an active panel drag: a `drag_left` event shifts the split by the
 * event's main-axis delta since the previous event, applying the result as
 * the pane's `flex_basis` via `setProps`. The basis is clamped to the pane's
 * min size (`min_height`/`min_width`, or {@link PANEL_DRAG_MIN_SIZE}) and to
 * the space the neighbor pane's min size leaves (the stack's laid-out main
 * size minus the gutter and the neighbor's min). Returns the applied
 * (post-clamp) result, or `null` when no drag is active or the event is not
 * `drag_left`.
 */
export function dragPanels(panels: Node, event: MouseEventJs): PanelDragResult | null {
  const state = panelDrags.get(panels);
  if (state === undefined || event.kind !== "drag_left") return null;
  const m = mainAxisCoord(event, state.direction);
  const delta = m - state.lastMain;
  state.lastMain = m;
  const lower = state.minSize;
  const upper = Math.max(lower, state.upper);
  const next = Math.min(upper, Math.max(lower, state.basis + delta));
  if (next !== state.basis) {
    const pane = panels.children[state.index];
    if (pane !== undefined) {
      state.basis = next;
      pane.setProps({ ...pane.props, flex_basis: next });
    }
  }
  return { index: state.index, direction: state.direction, flex_basis: next };
}

/**
 * End an active panel drag (any `up_*` mouse event), clearing the session.
 * Returns the ended handle, or `null` when no drag was active. The drag's
 * final `flex_basis` was already applied by the last {@link dragPanels}.
 */
export function endPanelDrag(panels: Node): PanelDragHandle | null {
  const state = panelDrags.get(panels);
  if (state === undefined) return null;
  panelDrags.delete(panels);
  return { index: state.index, direction: state.direction };
}

// --- DiffView --------------------------------------------------------------

/** The kind of a unified-diff line. */
export type DiffLineKind = "add" | "del" | "ctx";

/** One line of a unified diff. `old_line` / `new_line` are the line numbers
 * in the old/new file, or 0 when the line has no counterpart on that side
 * (a pure addition has no old line; a pure deletion has no new line). */
export interface DiffLine {
  /** The line kind: added / deleted / context. */
  kind: DiffLineKind;
  /** The line number in the old file (0 for pure additions). */
  old_line: number;
  /** The line number in the new file (0 for pure deletions). */
  new_line: number;
  /** The line content, without the leading marker char. */
  text: string;
}

/** Props for the `DiffView` element. `hunks`/`mode`/`inline_highlight` are
 * consumed by the factory (the line model is JS bookkeeping — it never
 * reaches the scene props, mirroring `Panels`); the remaining style/layout
 * props flow to the root box, which is the scrollable clip region
 * (`scroll_x` / `scroll_y` pan the composed rows).
 */
export interface DiffViewProps extends NodeProps {
  /** The unified-diff lines to render, in scene order. */
  hunks: DiffLine[];
  /**
   * Layout mode (default `"unified"`): `"unified"` renders each hunk line as
   * one full-width row; `"side"` renders two aligned columns (old | new)
   * split by the `Panels` flex-row machinery — each hunk line becomes one
   * row per column, aligned by line pair, with per-column gutters.
   */
  mode?: "unified" | "side";
  /**
   * Intra-line char-level highlighting (default `false`): for each adjacent
   * add/del line pair a char-level diff is computed and the changed segments
   * render bold + underlined on top of the line's kind color, leaving
   * unchanged characters plain.
   */
  inline_highlight?: boolean;
  /** The horizontal scroll offset in cells (default 0) — pans the rows
   * inside the clip region. */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0) — pans the rows inside
   * the clip region. */
  scroll_y?: number;
  /**
   * Passed through to each content text leaf: `false` keeps every diff line
   * single-row (no soft wrap — the compositor trims overflow at the right
   * edge, the classic diff look); `true`/unset soft-wraps at word boundaries.
   */
  wrap?: boolean;
}

/** The default fg color for added lines (matches the default theme's
 * `success` green — diff greens read as "incoming"). */
export const DIFF_ADD_FG = "#98c379";
/** The default fg color for deleted lines (matches the default theme's
 * `danger` red — diff reds read as "removed"). */
export const DIFF_DEL_FG = "#e06c75";

/** The widest line number in `hunks`, so every gutter column aligns. */
function diffGutterWidth(hunks: DiffLine[]): number {
  let width = 1;
  for (const line of hunks) {
    width = Math.max(width, String(line.old_line).length, String(line.new_line).length);
  }
  return width;
}

/** One gutter cell: the line number right-aligned to `width`, or blank when
 * the line has no number on this side (0). */
function diffGutterCell(line: DiffLine, width: number, side: "old" | "new"): string {
  const number = side === "old" ? line.old_line : line.new_line;
  return number > 0 ? String(number).padStart(width) : " ".repeat(width);
}

/** The gutter text for one line: `old new`, each column right-aligned to the
 * widest line number. */
function diffGutterText(line: DiffLine, width: number): string {
  return `${diffGutterCell(line, width, "old")} ${diffGutterCell(line, width, "new")}`;
}

/** The per-kind style stamped on a line's marker and content: added lines
 * green, deleted lines red, context lines dimmed. */
function diffKindStyle(kind: DiffLineKind): NodeProps {
  switch (kind) {
    case "add":
      return { fg: DIFF_ADD_FG };
    case "del":
      return { fg: DIFF_DEL_FG };
    case "ctx":
      return { dim: true };
  }
}

/** The distinct style stamped on changed characters of an intra-line
 * highlighted segment: bold + underline on top of the line's kind color. */
const DIFF_CHANGED_STYLE: NodeProps = { bold: true, underline: true };

/** The LCS DP guard for {@link diffChars}: pairs whose line lengths would
 * exceed this many table cells fall back to whole-line highlighting, so
 * pathological long lines stay cheap. */
const DIFF_CHAR_DIFF_MAX_CELLS = 40_000;

/** One run of a char-level diff: `keep` chars appear on both sides, `del`
 * chars only in the old line, `add` chars only in the new line. */
interface DiffCharRun {
  kind: "keep" | "del" | "add";
  text: string;
}

/**
 * A small LCS edit script at char granularity between two diff line texts.
 * Returns the aligned runs in scene order (old side: `keep` + `del`; new
 * side: `keep` + `add`). When the DP table would exceed
 * {@link DIFF_CHAR_DIFF_MAX_CELLS} cells, both whole lines are reported as
 * changed — intra-line precision degrades gracefully on pathological input
 * instead of stalling the factory. This is JS bookkeeping (the markdown
 * inline parser is the same shape): the rendering stays in the Rust engine.
 */
function diffChars(oldText: string, newText: string): DiffCharRun[] {
  const n = oldText.length;
  const m = newText.length;
  if (n * m > DIFF_CHAR_DIFF_MAX_CELLS) {
    const runs: DiffCharRun[] = [];
    if (n > 0) runs.push({ kind: "del", text: oldText });
    if (m > 0) runs.push({ kind: "add", text: newText });
    return runs;
  }
  // dp[i][j] = LCS length of oldText[0..i) and newText[0..j).
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) {
    const row = new Uint16Array(m + 1);
    if (i > 0) {
      const above = dp[i - 1]!;
      const ch = oldText[i - 1]!;
      for (let j = 1; j <= m; j++) {
        row[j] = ch === newText[j - 1]
          ? above[j - 1]! + 1
          : Math.max(above[j]!, row[j - 1]!);
      }
    }
    dp.push(row);
  }
  // Walk the table back from (n, m), collecting the edit script in reverse.
  const ops: Array<{ kind: DiffCharRun["kind"]; ch: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      ops.push({ kind: "keep", ch: oldText[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ kind: "add", ch: newText[j - 1]! });
      j -= 1;
    } else {
      ops.push({ kind: "del", ch: oldText[i - 1]! });
      i -= 1;
    }
  }
  ops.reverse();
  // Group consecutive same-kind ops into runs.
  const runs: DiffCharRun[] = [];
  for (const op of ops) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === op.kind) last.text += op.ch;
    else runs.push({ kind: op.kind, text: op.ch });
  }
  return runs;
}

/**
 * Pair adjacent add/del lines within each maximal run of change lines: the
 * i-th deleted line pairs with the i-th added line of the same run (context
 * lines break runs, so only adjacent pairs are considered). Lines without a
 * counterpart are left unpaired.
 */
function diffLinePairs(hunks: readonly DiffLine[]): Array<[DiffLine, DiffLine]> {
  const pairs: Array<[DiffLine, DiffLine]> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i++) pairs.push([dels[i]!, adds[i]!]);
    dels = [];
    adds = [];
  };
  for (const line of hunks) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else flush();
  }
  flush();
  return pairs;
}

/** Map every paired line to its `[del, add]` pair for intra-line
 * highlighting (unpaired lines are absent). */
function diffPairMap(hunks: readonly DiffLine[]): Map<DiffLine, [DiffLine, DiffLine]> {
  const map = new Map<DiffLine, [DiffLine, DiffLine]>();
  for (const pair of diffLinePairs(hunks)) {
    map.set(pair[0], pair);
    map.set(pair[1], pair);
  }
  return map;
}

/** One styled segment of a diff line's content: `changed` characters are
 * additionally bold + underlined on top of the line's kind color; plain
 * segments carry just the kind color. */
interface DiffLineSegment {
  text: string;
  changed: boolean;
}

/** Append `text` with flag `changed`, merging into the previous segment when
 * its flag matches (keeps the leaf count minimal). */
function appendSegment(segments: DiffLineSegment[], text: string, changed: boolean): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

/**
 * Split one line's text into plain/changed segments against its paired line
 * (`pair` = `[del, add]`; `line` is one of them). Unpaired lines yield one
 * plain segment carrying the whole text. The pair's other side contributes
 * nothing to this line's text, so the segments always re-join the original
 * text exactly.
 */
function diffLineSegments(line: DiffLine, pair: [DiffLine, DiffLine] | undefined): DiffLineSegment[] {
  if (pair === undefined) return [{ text: line.text, changed: false }];
  const isDel = line === pair[0];
  const segments: DiffLineSegment[] = [];
  for (const run of diffChars(pair[0].text, pair[1].text)) {
    if (run.kind === "keep") appendSegment(segments, run.text, false);
    else if ((isDel && run.kind === "del") || (!isDel && run.kind === "add")) {
      appendSegment(segments, run.text, true);
    }
  }
  if (segments.length === 0) return [{ text: "", changed: false }];
  return segments;
}

/** Compose a line's content into scene nodes: a single `Text` leaf when the
 * line is one uniform segment (the common case), or a flex row of per-segment
 * `Text` leaves when intra-line highlighting splits it — mirroring
 * `markdownLineNode`. `base` is the line's kind style; changed segments get
 * `DIFF_CHANGED_STYLE` on top.
 */
function diffContentNode(segments: DiffLineSegment[], base: NodeProps, wrap: boolean | undefined): Node {
  if (segments.length === 1) {
    const segment = segments[0]!;
    const props: NodeProps = { text: segment.text, ...base };
    if (segment.changed) Object.assign(props, DIFF_CHANGED_STYLE);
    if (wrap !== undefined) props.wrap = wrap;
    return Text(props);
  }
  const leaves = segments.map((segment) => {
    const props: NodeProps = { text: segment.text, ...base };
    if (segment.changed) Object.assign(props, DIFF_CHANGED_STYLE);
    if (wrap !== undefined) props.wrap = wrap;
    return Text(props);
  });
  return Box({ flex_direction: "row" }, ...leaves);
}

/** Build one unified diff row: a flex row of the dimmed gutter (old/new line
 * numbers), the `+`/`-`/` ` marker, and the line content. With
 * `inlineHighlight` and a paired line, the content is split into plain and
 * changed (bold + underlined) segments at char granularity. */
function buildDiffRow(
  line: DiffLine,
  width: number,
  wrap: boolean | undefined,
  pair: [DiffLine, DiffLine] | undefined,
  inlineHighlight: boolean,
): Node {
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const style = diffKindStyle(line.kind);
  const content = inlineHighlight
    ? diffContentNode(diffLineSegments(line, pair), style, wrap)
    : Text({ text: line.text, ...style, ...(wrap !== undefined ? { wrap } : {}) });
  return Box(
    { flex_direction: "row" },
    Text({ text: diffGutterText(line, width), dim: true }),
    Text({ text: marker, ...style }),
    content,
  );
}

/** The widest line number on one side of `hunks`, so each side-by-side
 * column's gutter aligns on its own numbers. */
function diffSideGutterWidth(hunks: readonly DiffLine[], side: "old" | "new"): number {
  let width = 1;
  for (const line of hunks) {
    const number = side === "old" ? line.old_line : line.new_line;
    width = Math.max(width, String(number).length);
  }
  return width;
}

/**
 * Build one side-by-side column cell for a hunk line: the same gutter /
 * marker / content shape as a unified row, but the column shows only its own
 * side — the old column renders deletions and context (additions blank), the
 * new column renders additions and context (deletions blank). `width` is the
 * side's own gutter width. With `inlineHighlight`, paired lines highlight
 * their changed chars exactly as in unified mode.
 */
function buildSideCell(
  line: DiffLine,
  side: "old" | "new",
  width: number,
  wrap: boolean | undefined,
  pair: [DiffLine, DiffLine] | undefined,
  inlineHighlight: boolean,
): Node {
  const owns = side === "old" ? line.kind !== "add" : line.kind !== "del";
  const style = side === "old"
    ? line.kind === "del"
      ? { fg: DIFF_DEL_FG }
      : line.kind === "ctx"
      ? { dim: true }
      : {}
    : line.kind === "add"
    ? { fg: DIFF_ADD_FG }
    : line.kind === "ctx"
    ? { dim: true }
    : {};
  const marker = side === "old"
    ? line.kind === "del" ? "-" : " "
    : line.kind === "add" ? "+" : " ";
  const content = !owns
    ? Text({ text: "" })
    : inlineHighlight
    ? diffContentNode(diffLineSegments(line, pair), style, wrap)
    : Text({ text: line.text, ...style, ...(wrap !== undefined ? { wrap } : {}) });
  return Box(
    { flex_direction: "row" },
    Text({ text: diffGutterCell(line, width, side), dim: true }),
    Text({ text: marker, ...style }),
    content,
  );
}

/**
 * Create a `diff` element: a column of per-line rows rendering a unified
 * diff, or two aligned columns rendering it side by side. Each hunk line
 * becomes a flex row of three `text` leaves — a dimmed gutter (old/new line
 * numbers, right-aligned to the widest number), a `+`/`-`/` ` marker, and
 * the line content — styled per kind: added lines green (`DIFF_ADD_FG`),
 * deleted lines red (`DIFF_DEL_FG`), context lines dimmed. With
 * `inline_highlight`, each adjacent add/del pair is char-diffed and its
 * changed segments render bold + underlined on top of the kind color. With
 * `mode: "side"`, the root becomes a flex row of two columns (old | new,
 * split with a 1-cell gap like `Panels`), each column one row per hunk line
 * with its own gutter — rows align by line pair. The root box is the
 * scrollable clip region: `scroll_x` / `scroll_y` pan the whole diff inside
 * it (multiple hunks scroll as one region), and the `wrap` prop passes
 * through to each content leaf. No new napi node kind: the `diff` element
 * materializes as a `box` (constitution).
 */
export function DiffView(props: DiffViewProps): Node {
  const mode = props.mode ?? "unified";
  const inline = props.inline_highlight ?? false;
  const pairs = inline ? diffPairMap(props.hunks) : new Map<DiffLine, [DiffLine, DiffLine]>();
  const rootProps: NodeProps = { ...props, flex_direction: mode === "side" ? "row" : "column" };
  // The 1-cell gutter between the two side-by-side columns (mirroring the
  // `Panels` flex-row split). An explicit `gap` wins — `gap: 0` removes it.
  if (mode === "side" && rootProps.gap === undefined) rootProps.gap = 1;
  const plain = rootProps as Record<string, unknown>;
  delete plain.hunks;
  delete plain.mode;
  delete plain.inline_highlight;
  let children: Node[];
  if (mode === "side") {
    const oldWidth = diffSideGutterWidth(props.hunks, "old");
    const newWidth = diffSideGutterWidth(props.hunks, "new");
    const oldRows: Node[] = [];
    const newRows: Node[] = [];
    for (const line of props.hunks) {
      const pair = pairs.get(line);
      oldRows.push(buildSideCell(line, "old", oldWidth, props.wrap, pair, inline));
      newRows.push(buildSideCell(line, "new", newWidth, props.wrap, pair, inline));
    }
    children = [
      Box({ flex_direction: "column" }, ...oldRows),
      Box({ flex_direction: "column" }, ...newRows),
    ];
  } else {
    const width = diffGutterWidth(props.hunks);
    children = props.hunks.map((line) =>
      buildDiffRow(line, width, props.wrap, pairs.get(line), inline)
    );
  }
  return Node.create("diff", rootProps, children);
}

// --- Select ----------------------------------------------------------------

/** One option in a `Select` list. */
export interface SelectOption {
  /** The option's value — what confirmation (single mode) or the selection
   * set (multi mode) carries. */
  value: string;
  /** The option's display label (defaults to the value). */
  label?: string;
  /** Start selected in multi mode (default `false`). */
  selected?: boolean;
}

/** The state reported by {@link selectKey} after a routed key. */
export interface SelectState {
  /** The highlighted option's index within the filtered list. */
  highlighted: number;
  /** The typeahead filter narrowing the visible options (`""` = all). */
  filter: string;
  /** Single mode: the confirmed option value; multi mode: the selected
   * values. */
  value: string | string[];
  /** Whether the dropdown is open (enter/escape dismiss it). */
  open: boolean;
}

/**
 * Props for the `Select` element. `options` / `floating` are consumed by the
 * factory (the option list is JS bookkeeping — it never reaches the scene
 * props, mirroring `Panels` / `DiffView`); the remaining state/style/layout
 * props flow to the root box, which is a flex column of text leaves.
 */
export interface SelectProps extends NodeProps {
  /** The options to choose from, in list order. */
  options: SelectOption[];
  /**
   * Multi-select mode (default `false`): space toggles the highlighted
   * option's checkmark, option rows render `✓ ` / `  ` prefixes, and a
   * summary row shows the selected count.
   */
  multi?: boolean;
  /** Single mode: the confirmed option value (default `""`); multi mode:
   * the selected values (default the `selected`-flagged options). */
  value?: string | string[];
  /** The highlighted option's index within the filtered list (default 0). */
  highlighted?: number;
  /** The typeahead filter query narrowing the visible options (default
   * `""`). Typing appends, backspace trims. */
  filter?: string;
  /** Whether the dropdown is open (default `true`). Enter/escape dismiss. */
  open?: boolean;
  /**
   * Render the dropdown as a floating overlay: the root box carries the
   * `z_index` prop (the compositor's paint z-order; default `0`), so the
   * dropdown paints above in-flow content at the default z. The mode flag is
   * consumed by the factory — only the `z_index` prop reaches the scene.
   */
  floating?: boolean;
  /** The overlay's paint z-order (used when `floating`; default 0). */
  z_index?: number;
}

/** The dim placeholder shown in the filter row while the query is empty. */
export const SELECT_FILTER_PLACEHOLDER = "filter…";

/** A select option with its label resolved (`label ?? value`), as stored in
 * {@link selectOptions}. */
interface NormalizedSelectOption {
  value: string;
  label: string;
}

/** The label-normalized option list of a select node (JS bookkeeping — never
 * scene props, mirroring `Panels`' `panelBodies`). */
const selectOptions = new WeakMap<Node, NormalizedSelectOption[]>();

/** The options visible under a filter: those whose label starts with the
 * query (case-insensitive prefix match). An empty query shows everything. */
function selectVisible(options: readonly NormalizedSelectOption[], filter: string): NormalizedSelectOption[] {
  if (filter === "") return [...options];
  const needle = filter.toLowerCase();
  return options.filter((option) => option.label.toLowerCase().startsWith(needle));
}

/**
 * The options of a select node visible under its current filter, in scene
 * order (the label-normalized records). An empty filter returns all options.
 */
export function visibleOptions(select: Node): SelectOption[] {
  const props = select.props as SelectProps;
  const filter = typeof props.filter === "string" ? props.filter : "";
  return selectVisible(selectOptions.get(select) ?? [], filter);
}

/**
 * Rebuild a select node's children from its current props (the source of
 * truth, mirroring `Input`'s value/caret): a filter row, one option row per
 * visible option, and — in multi mode — a selected-count summary row. The
 * highlighted row is reversed; selected rows (multi) carry a `✓ ` prefix.
 * Runs at creation and after every {@link selectKey} mutation.
 */
function rebuildSelect(select: Node): void {
  const props = select.props as SelectProps;
  const options = selectOptions.get(select) ?? [];
  const multi = props.multi ?? false;
  const filter = typeof props.filter === "string" ? props.filter : "";
  const highlighted = typeof props.highlighted === "number" ? props.highlighted : 0;
  const selected = new Set(Array.isArray(props.value) ? props.value : []);
  const visible = selectVisible(options, filter);

  for (const child of [...select.children]) child.remove();

  // Filter row: the typeahead query, dimmed while empty.
  const empty = filter === "";
  select.addChild(Text({ text: empty ? SELECT_FILTER_PLACEHOLDER : filter, dim: empty }));
  // Option rows: `✓ `/`  ` prefix (multi) + label; the highlight reversed.
  visible.forEach((option, index) => {
    const prefix = multi ? (selected.has(option.value) ? "✓ " : "  ") : "";
    select.addChild(
      Text({ text: `${prefix}${option.label}`, reversed: index === highlighted }),
    );
  });
  // Summary row (multi mode): the selected-count line.
  if (multi) {
    select.addChild(Text({ text: `${selected.size} selected` }));
  }
}

/**
 * Create a `select` element: a flex column of text leaves — a filter row
 * (the typeahead query, dimmed while empty), one option row per visible
 * option (the highlighted row reversed, multi-mode rows `✓ `/`  `-prefixed),
 * and in multi mode a selected-count summary row. The option list is JS
 * bookkeeping (never scene props); the interactive state (`highlighted`,
 * `filter`, `value`, `open`) lives on the root box's props. Drive it with
 * {@link selectKey}. A `floating` dropdown stamps the root box's `z_index`
 * prop (compositor paint order) so it overlays in-flow content. No new napi
 * node kind: the `select` element materializes as a `box` (constitution).
 */
export function Select(props: SelectProps): Node {
  const multi = props.multi ?? false;
  const options = props.options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
  }));
  const initialValue: string | string[] = multi
    ? Array.isArray(props.value)
      ? props.value
      : props.options.filter((option) => option.selected).map((option) => option.value)
    : typeof props.value === "string"
      ? props.value
      : "";
  const rootProps: NodeProps = {
    ...props,
    multi,
    value: initialValue,
    highlighted: props.highlighted ?? 0,
    filter: props.filter ?? "",
    open: props.open ?? true,
  };
  if (props.floating === true) {
    rootProps.z_index = (props.z_index as number | undefined) ?? 0;
  }
  const plain = rootProps as Record<string, unknown>;
  delete plain.options;
  delete plain.floating;
  const select = Node.create("select", rootProps, []);
  selectOptions.set(select, options);
  rebuildSelect(select);
  return select;
}

/**
 * Apply a key to a select node, mutating its state and rebuilding the
 * composition in place — the Select counterpart of {@link editKey}.
 *
 * - `up` / `down` move the highlight within the filtered list (clamped).
 * - `char` (except space) appends to the typeahead filter, narrowing the
 *   visible options to prefix matches and resetting the highlight to the
 *   first match; `backspace` trims the filter.
 * - `space` toggles the highlighted option's checkmark in multi mode (a
 *   no-op in single mode).
 * - `enter` confirms the highlighted option (single mode: `value` becomes
 *   the option's value; multi mode: the selection set is kept) and dismisses
 *   the dropdown.
 * - `escape` dismisses the dropdown.
 *
 * Returns the new state; any other key leaves the select unchanged.
 */
export function selectKey(select: Node, event: KeyEvent): SelectState {
  const props = select.props as SelectProps;
  const options = selectOptions.get(select) ?? [];
  const multi = props.multi ?? false;
  const filter = typeof props.filter === "string" ? props.filter : "";
  const highlighted = typeof props.highlighted === "number" ? props.highlighted : 0;
  const open = props.open ?? true;
  const value: string | string[] =
    typeof props.value === "string" || Array.isArray(props.value)
      ? props.value
      : multi
        ? []
        : "";

  let nextFilter = filter;
  let nextHighlighted = highlighted;
  let nextOpen = open;
  let nextValue = value;

  const name = event.name;
  if (name === "up") {
    nextHighlighted = Math.max(0, highlighted - 1);
  } else if (name === "down") {
    nextHighlighted = Math.min(selectVisible(options, filter).length - 1, highlighted + 1);
  } else if (name === "enter") {
    const visible = selectVisible(options, filter);
    const option = visible[Math.min(nextHighlighted, visible.length - 1)];
    if (option !== undefined) {
      if (!multi) nextValue = option.value;
      nextOpen = false;
    }
  } else if (name === "escape") {
    nextOpen = false;
  } else if (name === "char" && event.char === " ") {
    if (multi) {
      const visible = selectVisible(options, filter);
      const option = visible[Math.min(nextHighlighted, visible.length - 1)];
      if (option !== undefined) {
        const current = Array.isArray(nextValue) ? nextValue : [];
        const index = current.indexOf(option.value);
        nextValue = index === -1
          ? [...current, option.value]
          : current.filter((v) => v !== option.value);
      }
    }
  } else if (name === "char" && !event.ctrl && !event.alt && event.char !== undefined) {
    nextFilter = filter + event.char;
    nextHighlighted = 0;
  } else if (name === "backspace") {
    nextFilter = filter.slice(0, -1);
    nextHighlighted = 0;
  }

  // Clamp the highlight into the visible list (a filter change can shrink
  // it; up/down/space already clamp).
  nextHighlighted = Math.min(nextHighlighted, Math.max(0, selectVisible(options, nextFilter).length - 1));

  const state: SelectState = { highlighted: nextHighlighted, filter: nextFilter, value: nextValue, open: nextOpen };
  const changed =
    state.highlighted !== highlighted ||
    state.filter !== filter ||
    state.value !== value ||
    state.open !== open;
  if (changed) {
    select.setProps({
      ...props,
      highlighted: state.highlighted,
      filter: state.filter,
      value: state.value,
      open: state.open,
    });
    rebuildSelect(select);
  }
  return state;
}

// ---------------------------------------------------------------------------
// ScrollView
//
// A `scroll_view` element is a box carrying the engine's scene region props
// — a clip rect (`clip_x` / `clip_y` / `clip_width` / `clip_height`) and a
// scroll offset (`scroll_x` / `scroll_y`) — whose children are the scrollable
// content (tern-layout + compositor consume those props; the JS side only
// computes and sets them — constitution: no engine logic in JS). The scroll
// helpers drive the offset with `Node.contentSize()` of the content vs the
// view's own laid-out size (the viewport), and an optional scrollbar text
// leaf (track + thumb) is composed into the clip region's right edge.
// ---------------------------------------------------------------------------

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
    Math.min(viewportHeight, Math.round((viewportHeight * viewportHeight) / Math.max(1, contentHeight))),
  );
  const overflow = Math.max(0, contentHeight - viewportHeight);
  const range = Math.max(0, viewportHeight - thumb);
  const offset = overflow > 0 ? Math.round((scrollY / overflow) * range) : 0;
  const rows: string[] = [];
  for (let i = 0; i < viewportHeight; i++) {
    rows.push(i >= offset && i < offset + thumb ? SCROLLBAR_THUMB_CHAR : SCROLLBAR_TRACK_CHAR);
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
function scrollGeometry(view: Node): { viewport: ContentSize; content: ContentSize } {
  const content = view.contentSize();
  const props = view.props;
  const viewport: ContentSize = {
    width: typeof props.clip_width === "number" ? props.clip_width : content.width,
    height: typeof props.clip_height === "number" ? props.clip_height : content.height,
  };
  if (view.type === "streaming_text") {
    return { viewport, content };
  }
  return { viewport, content: scrollableContentSize(view, viewport) };
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
 * A table's content region is windowed (only the visible rows are
 * materialized), so its laid-out size measures the window — never the
 * dataset. For a table region (or a table root) the JS-known full content
 * size in `tableRegionStates` stands in, keeping the scroll clamp against the
 * whole dataset (bookkeeping, never scene props).
 */
function scrollableContentSize(view: Node, viewport: ContentSize): ContentSize {
  const table = tableRegionState(view);
  if (table !== undefined) {
    return {
      width: Math.max(table.contentWidth, viewport.width),
      height: Math.max(table.contentHeight, viewport.height),
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
  return { width: Math.max(width, viewport.width), height: Math.max(height, viewport.height) };
}

/** The current scroll offset of a scroll view (0 when unset). */
function currentScroll(view: Node): { x: number; y: number } {
  const props = view.props;
  return {
    x: typeof props.scroll_x === "number" ? props.scroll_x : 0,
    y: typeof props.scroll_y === "number" ? props.scroll_y : 0,
  };
}

/** The max scroll offsets of a view: content minus viewport, floored at 0 (a
 *  view whose content fits cannot scroll). */
function maxScroll(view: Node): { x: number; y: number } {
  const { viewport, content } = scrollGeometry(view);
  return {
    x: Math.max(0, content.width - viewport.width),
    y: Math.max(0, content.height - viewport.height),
  };
}

/** Clamp a requested scroll offset to the content bounds. */
function clampScroll(view: Node, x: number, y: number): { x: number; y: number } {
  const max = maxScroll(view);
  return { x: Math.max(0, Math.min(x, max.x)), y: Math.max(0, Math.min(y, max.y)) };
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
function renderScrollbar(view: Node): void {
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
export function ScrollView(props: ScrollViewProps = {}, ...children: Node[]): Node {
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
 * the applied offsets.
 *
 * On a streaming node with auto-scroll enabled, a scroll to a position
 * *above* the content tail detaches the follow — the view stays pinned where
 * the user left it as the stream grows — and stamps the scroll-to-bottom
 * affordance at the clip region's bottom-right (see {@link followTail} to
 * re-attach, {@link scrollToBottom} to jump to the tail). Scrolling to/at
 * the tail keeps the current follow state.
 */
export function scrollTo(view: Node, x: number, y: number): { x: number; y: number } {
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
export function scrollBy(view: Node, dx: number, dy: number): { x: number; y: number } {
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

// ---------------------------------------------------------------------------
// Table
//
// A `table` element is a flex column of box/text leaves: a header row (sticky
// by default — a sibling painted above the scrollable content region, at a
// higher `z_index` so scrolled rows pass beneath it) plus a content region
// box holding only the visible row window — `rows[scroll_y, scroll_y +
// clip_height)` — so a large dataset does not materialize one scene node per
// row (the full dataset stays JS bookkeeping). Per-column width/alignment is
// baked into each cell's padded text (display-width aware, never mid-glyph),
// so columns line up regardless of content length. The column/row model is JS
// bookkeeping (never scene props, mirroring `Select`'s `options`); the
// interactive state (`highlight`, `scroll_x`, `scroll_y`) lives on the node
// props, and `tableKey` mutates it and rebuilds the composition in place
// (mirroring `selectKey`). The scroll offsets are the engine's existing
// scene props: `scroll_x` on the root pans header + rows together (so
// columns stay aligned), `scroll_y` on the content region pans only the rows
// (the sticky header does not scroll). No new napi node kind: the `table`
// element materializes as a `box` (constitution).
// ---------------------------------------------------------------------------

/** One column of a `Table`: a `key`, the `header` label, a fixed cell
 * `width` in cells, and an optional `align` for the cell content (default
 * `"left"`). */
export interface TableColumn {
  /** The column's key (bookkeeping — identifies the column). */
  key: string;
  /** The header label painted in the header row. */
  header: string;
  /** The column's fixed width in cells. */
  width: number;
  /** The cell content alignment (default `"left"`). */
  align?: "left" | "right" | "center";
}

/** The state reported by {@link tableKey} after a routed key. */
export interface TableState {
  /** The highlighted data-row index (clamped into the rows). */
  highlight: number;
  /** The horizontal scroll offset in cells. */
  scroll_x: number;
  /** The vertical scroll offset in cells (data rows scrolled past). */
  scroll_y: number;
}

/**
 * Props for the `Table` element. `columns` / `rows` are consumed by the
 * factory (the model is JS bookkeeping — it never reaches the scene props,
 * mirroring `Panels` / `Select`); the remaining state/layout props flow to
 * the root box, which is a flex column of the header row and the scrollable
 * content region.
 */
export interface TableProps extends NodeProps {
  /** The columns, in display order (left to right). */
  columns: TableColumn[];
  /** The data rows, in display order (top to bottom); each row holds one
   *  cell per column (missing cells render blank). */
  rows: (string | number)[][];
  /** The horizontal scroll offset in cells (default 0) — pans the header
   *  row and the content region together, so columns stay aligned. */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0) — the number of data
   *  rows scrolled past inside the content region. The sticky header does
   *  not scroll with them. */
  scroll_y?: number;
  /** The highlighted data-row index (default 0) — its row renders reversed.
   *  {@link tableKey} moves it with up/down, clamping to the rows. */
  highlight?: number;
  /** Keep the header row pinned above the content region (default `true`);
   *  `false` moves the header into the scrollable region, so it scrolls
   *  away with the rows. */
  sticky_header?: boolean;
  /**
   * The content region's viewport height in rows (default unset — the whole
   * row list is the viewport). Drives {@link visibleTableRows} and the
   * scroll clamping in {@link tableKey}: the visible window is
   * `rows[scroll_y, scroll_y + clip_height)`.
   */
  clip_height?: number;
}

/** The sticky header's paint z-order (1). In-flow content stacks at z 0, so
 * the header — pinned above the content region — paints over data rows that
 * scroll up beneath it (compositor z-order, the same mechanism `Select`'s
 * `floating` overlay and the `ScrollView` scrollbar use). */
const TABLE_HEADER_Z_INDEX = 1;

/** The normalized column list of a table node (JS bookkeeping — never scene
 * props, mirroring `Select`'s `selectOptions`). */
const tableColumns = new WeakMap<Node, TableColumn[]>();

/** The normalized row list of a table node (JS bookkeeping — never scene
 * props). */
const tableRows = new WeakMap<Node, (string | number)[][]>();

/** The content region box of a table node (JS bookkeeping — the scrollable
 * sibling the sticky header is pinned above; its `scroll_y` / `clip_height`
 * props are the vertical viewport state, mirroring `ScrollView`'s
 * `scrollbarLeaves`). */
const tableRegions = new WeakMap<Node, Node>();

/** The full-dataset bookkeeping of a table's content region (JS state —
 * never scene props, mirroring `Panels`' `panelBodies`): the owning table,
 * the total row count, and the full content width/height the scroll clamp
 * measures against. The region's scene children hold only the visible row
 * window, so its `Node.contentSize()` measures the window — never the
 * dataset. */
interface TableRegionState {
  /** The owning table node (the node `tableRegions` maps to this region). */
  table: Node;
  /** The total data-row count of the full dataset. */
  rowCount: number;
  /** The full content height in cells — one cell per data row (a row is a
   *  single-line flex row), so this equals `rowCount`; it is the quantity
   *  the vertical scroll clamp measures against. */
  contentHeight: number;
  /** The full content width in cells — the sum of the column widths. */
  contentWidth: number;
}

/** The windowed-table records of every table's content region. */
const tableRegionStates = new WeakMap<Node, TableRegionState>();

/** The display width of `text` in terminal columns — the sum of its grapheme
 * clusters' widths (a ZWJ emoji counts 2, never per code point). */
function displayWidth(text: string): number {
  let width = 0;
  for (const run of clusterRuns(text)) width += run.width;
  return width;
}

/** Truncate `text` to `width` display columns, never splitting a grapheme
 * cluster (a cluster that would straddle the boundary is dropped whole). */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const run of clusterRuns(text)) {
    if (run.width === 0) continue;
    if (used + run.width > width) break;
    out += run.text;
    used += run.width;
  }
  return out;
}

/** The padded cell text for `value` in a `width`-cell column: left-aligned
 * (default), right-aligned, or centered; content wider than the column is
 * truncated (never mid-glyph). The padded string's display width is exactly
 * `width`, so every column lines up across rows. */
function tableCellText(
  value: string | number,
  width: number,
  align?: "left" | "right" | "center",
): string {
  const text = String(value);
  const used = displayWidth(text);
  if (used >= width) return truncateToWidth(text, width);
  const pad = width - used;
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
  }
  return text + " ".repeat(pad);
}

/** One cell of a table: a `width`-pinned text leaf carrying the padded,
 * aligned content; `reversed` marks a cell of the highlighted row. The
 * `width` prop fixes the leaf's laid-out width, so the compositor trims any
 * residual overflow at the column edge (the same trim `wrap: false` lines
 * get). */
function tableCell(value: string | number, column: TableColumn, reversed: boolean): Node {
  return Text({
    text: tableCellText(value, column.width, column.align),
    width: column.width,
    reversed,
  });
}

/** One data row: a flex row of per-column cell leaves, one per column
 * (missing cells render blank). The highlighted row's cells are reversed. */
function buildTableRow(row: (string | number)[], columns: TableColumn[], highlighted: boolean): Node {
  return Box(
    { flex_direction: "row" },
    ...columns.map((column, index) => tableCell(row[index] ?? "", column, highlighted)),
  );
}

/** The header row: a flex row of per-column cell leaves carrying the column
 * labels. With a sticky header it carries the higher `z_index` so it paints
 * above data rows scrolling beneath it. */
function buildTableHeader(columns: TableColumn[], sticky: boolean): Node {
  const props: NodeProps = { flex_direction: "row" };
  if (sticky) props.z_index = TABLE_HEADER_Z_INDEX;
  return Box(props, ...columns.map((column) => tableCell(column.header, column, false)));
}

/** The current vertical scroll of a table's content region (0 when unset). */
function tableScrollY(table: Node): number {
  const region = tableRegions.get(table);
  if (region === undefined) return 0;
  return typeof region.props.scroll_y === "number" ? region.props.scroll_y : 0;
}

/** The table's viewport height in rows: the `clip_height` prop, or the whole
 * row list when unset (nothing to clamp against — every row is "visible"). */
function tableViewport(table: Node): number {
  const props = table.props as TableProps;
  if (typeof props.clip_height === "number" && props.clip_height > 0) return props.clip_height;
  return (tableRows.get(table) ?? []).length;
}

/** The table region-state of `view`: its own record when `view` is a table's
 * content region, the region's record when it is a table root, `undefined`
 * for any other node. */
function tableRegionState(view: Node): TableRegionState | undefined {
  const region = view.type === "table" ? tableRegions.get(view) : view;
  if (region === undefined) return undefined;
  return tableRegionStates.get(region);
}

/**
 * Re-window a table after its content region's scroll offset changed outside
 * {@link tableKey} — through {@link scrollTo} / {@link scrollBy} /
 * {@link scrollTop}, e.g. from {@link wheelScroll} — rebuilding the
 * materialized rows to `rows[scroll_y, scroll_y + clip_height)` at the new
 * offset. A no-op for non-table scroll views and for a table root whose
 * region is gone (nothing to re-window).
 */
function refreshTableWindow(view: Node): void {
  const region = view.type === "table" ? tableRegions.get(view) : view;
  if (region === undefined) return;
  const state = tableRegionStates.get(region);
  if (state === undefined) return;
  rebuildTable(state.table);
}

/**
 * Rebuild a table node's children from its current props (the source of
 * truth, mirroring `Select`'s `rebuildSelect`): the header row — sticky when
 * `sticky_header` (a sibling above the content region, at the higher
 * `z_index`), otherwise the region's first child — plus one row leaf per
 * *visible* data row: the window `rows[scroll_y, scroll_y + clip_height)`,
 * so a large dataset does not materialize one scene node per row (the full
 * dataset stays JS bookkeeping in `tableRows`; the full content geometry is
 * recorded in `tableRegionStates` for the scroll clamp). The highlighted row
 * renders reversed. Runs at creation (seeding the content region with the
 * initial `scroll_y` prop), after every {@link tableKey} mutation, and after
 * any region scroll via {@link refreshTableWindow} (the region's own
 * `scroll_y` is re-stamped).
 */
function rebuildTable(table: Node, initialScrollY?: number): void {
  const props = table.props as TableProps;
  const columns = tableColumns.get(table) ?? [];
  const rows = tableRows.get(table) ?? [];
  const highlight = typeof props.highlight === "number" ? props.highlight : 0;
  const sticky = props.sticky_header ?? true;
  // The vertical viewport: the `clip_height` prop, or the whole dataset when
  // unset. The scroll offset is clamped into `[0, rows.length - viewport]` —
  // the same bound `maxScroll` derives from the JS-known full content height,
  // so an out-of-range initial offset cannot open an empty window.
  const viewport = Math.max(
    1,
    typeof props.clip_height === "number" && props.clip_height > 0 ? props.clip_height : rows.length,
  );
  const scrollY = Math.max(0, Math.min(initialScrollY ?? tableScrollY(table), Math.max(0, rows.length - viewport)));

  for (const child of [...table.children]) child.remove();

  const header = buildTableHeader(columns, sticky);
  // Window the rows: materialize only `rows[scroll_y, scroll_y + viewport)`.
  const start = Math.floor(scrollY);
  const end = Math.min(rows.length, start + viewport);
  const rowNodes: Node[] = [];
  for (let i = start; i < end; i++) rowNodes.push(buildTableRow(rows[i]!, columns, i === highlight));
  const regionProps: NodeProps = { flex_direction: "column", scroll_y: scrollY };
  if (typeof props.clip_height === "number") regionProps.clip_height = props.clip_height;

  let region: Node;
  if (sticky) {
    table.addChild(header);
    region = Node.create("box", regionProps, rowNodes);
    tableRegions.set(table, region);
    table.addChild(region);
  } else {
    region = Node.create("box", regionProps, [header, ...rowNodes]);
    tableRegions.set(table, region);
    table.addChild(region);
  }
  // Record the full-dataset geometry the scroll clamp measures against (the
  // region's scene content is only the window) — JS bookkeeping, never scene
  // props.
  tableRegionStates.set(region, {
    table,
    rowCount: rows.length,
    contentHeight: rows.length,
    contentWidth: columns.reduce((sum, column) => sum + column.width, 0),
  });
}

/**
 * Create a `table` element: a flex column of box/text leaves — a header row
 * (sticky by default, painted above the content region at the higher
 * `z_index`; `sticky_header: false` moves it into the scrollable region) and
 * one row leaf per *visible* data row — the window
 * `rows[scroll_y, scroll_y + clip_height)` — with per-column
 * width/alignment (each cell's text padded to the column width,
 * right/center-aligned as declared, overflow truncated never mid-glyph; the
 * highlighted row reversed). Only the window is materialized, so a large
 * dataset does not create one scene node per row; the full dataset stays JS
 * bookkeeping (never scene props) and the scroll clamp measures the full
 * content height through `tableRegionStates`. The interactive state
 * (`highlight`, `scroll_x`, `scroll_y`) lives on the node props. The
 * `scroll_x` prop on the root pans header + rows together (columns stay
 * aligned); `scroll_y` pans only the content region, so the sticky header
 * does not scroll. Drive it with {@link tableKey}; read the visible window
 * with {@link visibleTableRows}. No new napi node kind: the `table` element
 * materializes as a `box` (constitution).
 */
export function Table(props: TableProps): Node {
  const columns = props.columns.map((column) => ({ ...column }));
  const rows = props.rows.map((row) => [...row]);
  const rootProps: NodeProps = {
    ...props,
    highlight: props.highlight ?? 0,
    scroll_x: props.scroll_x ?? 0,
    sticky_header: props.sticky_header ?? true,
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.columns;
  delete plain.rows;
  delete plain.scroll_y;
  const table = Node.create("table", rootProps, []);
  tableColumns.set(table, columns);
  tableRows.set(table, rows);
  rebuildTable(table, props.scroll_y);
  return table;
}

/**
 * The data rows of a table currently inside its vertical viewport: the row
 * slice `rows[scroll_y, scroll_y + clip_height)` (the whole remaining list
 * when `clip_height` is unset), in scene order. The window the content
 * region's scroll offset exposes below the sticky header.
 */
export function visibleTableRows(table: Node): (string | number)[][] {
  const rows = tableRows.get(table) ?? [];
  const scrollY = tableScrollY(table);
  const viewport = tableViewport(table);
  return rows.slice(scrollY, scrollY + Math.max(1, viewport));
}

/**
 * Apply a key to a table node, mutating its state and rebuilding the
 * composition in place — the Table counterpart of {@link selectKey}.
 *
 * - `up` / `down` move the highlight within the rows (clamped at the ends),
 *   auto-scrolling the content region so the highlighted row stays inside
 *   the visible window (`scroll_y` is clamped to `[0, rows.length -
 *   viewport]`, where the viewport is `clip_height` or the whole list).
 *
 * Returns the new state; any other key leaves the table unchanged.
 */
export function tableKey(table: Node, event: KeyEvent): TableState {
  const props = table.props as TableProps;
  const rows = tableRows.get(table) ?? [];
  const highlight = typeof props.highlight === "number" ? props.highlight : 0;
  const scrollX = typeof props.scroll_x === "number" ? props.scroll_x : 0;
  const scrollY = tableScrollY(table);
  const viewport = Math.max(1, tableViewport(table));
  const maxScroll = Math.max(0, rows.length - viewport);

  let nextHighlight = highlight;
  if (event.name === "up") {
    nextHighlight = Math.max(0, highlight - 1);
  } else if (event.name === "down") {
    nextHighlight = Math.min(Math.max(0, rows.length - 1), highlight + 1);
  }

  // Auto-scroll: keep the highlighted row inside the visible window, then
  // clamp the offset to the content bounds (a table whose rows fit its
  // viewport cannot scroll).
  let nextScrollY = scrollY;
  if (nextHighlight < nextScrollY) nextScrollY = nextHighlight;
  if (nextHighlight > nextScrollY + viewport - 1) nextScrollY = nextHighlight - viewport + 1;
  nextScrollY = Math.max(0, Math.min(nextScrollY, maxScroll));

  const state: TableState = { highlight: nextHighlight, scroll_x: scrollX, scroll_y: nextScrollY };
  const changed = state.highlight !== highlight || state.scroll_y !== scrollY;
  if (changed) {
    table.setProps({ ...props, highlight: state.highlight });
    const region = tableRegions.get(table);
    if (region !== undefined) {
      region.setProps({ ...region.props, scroll_y: state.scroll_y });
    }
    rebuildTable(table);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Tabs
//
// A `tabs` element is a flex column of box/text leaves: a tab bar row (one
// `Text` leaf per tab, the active tab painted with the theme's `primary`
// palette colors and reversed, its label prefixed with a top-border marker)
// plus a content region box holding the *active* tab's content nodes. The
// tab list is JS bookkeeping (never scene props, mirroring `Panels`' `panels`
// / `Table`'s `rows`); the interactive state (`active`) lives on the root
// box's props, and `activateTab` / `closeTab` / `tabsKey` mutate it and
// rebuild the composition in place (mirroring `selectKey` / `tableKey`). No
// new napi node kind: the `tabs` element materializes as a `box`
// (constitution).
// ---------------------------------------------------------------------------

/** One tab in a `Tabs` element: a label plus the content nodes rendered in
 * the content region while the tab is active. */
export interface TabSpec {
  /** The tab's label text (rendered in the tab bar). */
  label: string;
  /** The tab's content nodes, rendered in the content region while the tab is
   * active (the same node instances are re-attached on every activation,
   * mirroring `Panels`' collapsed-body restore). */
  content: Node[];
  /** Show a close affordance on this tab (defaults to the element's
   * `closable`). */
  closable?: boolean;
}

/** The state reported by {@link tabsKey} after a routed key. */
export interface TabsState {
  /** The active tab index (clamped into the tabs). */
  active: number;
  /** The tab count after the key (a `ctrl+w` close shrinks it). */
  count: number;
}

/**
 * Props for the `Tabs` element. `tabs` / `closable` are consumed by the
 * factory (the tab list is JS bookkeeping — it never reaches the scene props,
 * mirroring `Panels`' `panels`); the interactive state (`active`) and the
 * remaining style/layout props flow to the root box, which is a flex column
 * of the tab bar row and the content region.
 */
export interface TabsProps extends NodeProps {
  /** The tabs, in display order (left to right). */
  tabs: TabSpec[];
  /** The active tab index (default 0). */
  active?: number;
  /** Show a close affordance on every tab (default `false`; a per-tab
   * `closable` overrides it). */
  closable?: boolean;
}

/** The fg of the active tab's primary styling — the default theme's
 * `primary` palette fg (docs/components.md "Tabs"; mirroring `DIFF_ADD_FG`
 * mirroring the `success` palette). */
export const TAB_PRIMARY_FG = "#61afef";
/** The bg of the active tab's primary styling — the default theme's `primary`
 * palette bg. */
export const TAB_PRIMARY_BG = "#21252b";
/** The top-border marker prefixed to the active tab's label — a top-border
 * fragment that visually caps the active tab. */
export const TAB_ACTIVE_MARKER = "▔";
/** The close glyph appended to a closable tab's label. */
export const TAB_CLOSE_CHAR = "×";

/** The normalized tab spec list of a tabs node (JS bookkeeping — never scene
 * props, mirroring `Table`'s `tableRows`). */
const tabSpecs = new WeakMap<Node, TabSpec[]>();

/** The element-level close-affordance default of a tabs node (JS bookkeeping —
 * never scene props, mirroring `Select`'s `floating` mapping to `z_index`).
 * Captured at creation because the `closable` flag is consumed by the factory
 * (like `Panels`' `panels` / `Table`'s `rows`). */
const tabClosables = new WeakMap<Node, boolean>();

/** The element-level `closable` default of a tabs node (`false` when unset). */
function tabsElementClosable(tabs: Node): boolean {
  return tabClosables.get(tabs) ?? false;
}

/** Clamp `index` into `[0, count - 1]` (0 when `count` is 0). */
function clampTabIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, Math.max(0, count - 1)));
}

/** Whether the tab at `index` shows a close affordance: its own `closable`
 * flag wins, falling back to the element's `closable` default. */
function tabClosable(spec: TabSpec, elementClosable: boolean): boolean {
  return spec.closable ?? elementClosable;
}

/** The text of one tab leaf: the label — prefixed by the top-border marker
 * when active, suffixed by the close glyph when closable. */
function tabLeafText(spec: TabSpec, isActive: boolean, closable: boolean): string {
  const text = isActive ? TAB_ACTIVE_MARKER + spec.label : spec.label;
  return closable ? `${text} ${TAB_CLOSE_CHAR}` : text;
}

/** The props of one tab leaf: active tabs are painted with the `primary`
 * palette colors and reversed; closable tabs carry the close glyph. */
function tabLeafProps(spec: TabSpec, isActive: boolean, closable: boolean): NodeProps {
  const props: NodeProps = { text: tabLeafText(spec, isActive, closable) };
  if (isActive) {
    props.fg = TAB_PRIMARY_FG;
    props.bg = TAB_PRIMARY_BG;
    props.reversed = true;
  }
  return props;
}

/**
 * Rebuild a tabs node's children from its current props (the source of truth,
 * mirroring `rebuildTable`): the tab bar row — a flex row box holding one
 * `Text` leaf per tab (the active one reversed + primary + top-border
 * marker, closable tabs carrying the close glyph) — plus the content region
 * box (a flex column) holding the active tab's content nodes. The same
 * content node instances are re-attached on every rebuild, mirroring
 * `Panels`' collapsed-body restore. Runs at creation and after every
 * `activateTab` / `closeTab` / `tabsKey` mutation.
 */
function rebuildTabs(tabs: Node): void {
  const props = tabs.props as TabsProps;
  const specs = tabSpecs.get(tabs) ?? [];
  const active = clampTabIndex(typeof props.active === "number" ? props.active : 0, specs.length);
  const elementClosable = tabsElementClosable(tabs);

  for (const child of [...tabs.children]) child.remove();

  const bar = Box({ flex_direction: "row" });
  specs.forEach((spec, index) => {
    bar.addChild(Text(tabLeafProps(spec, index === active, tabClosable(spec, elementClosable))));
  });
  tabs.addChild(bar);

  const region = Box({ flex_direction: "column" });
  const content = specs[active]?.content ?? [];
  for (const node of content) region.addChild(node);
  tabs.addChild(region);
}

/**
 * Create a `tabs` element: a flex column of box/text leaves — a tab bar row
 * (one `Text` leaf per tab; the active tab painted with the theme's `primary`
 * palette colors and reversed, its label prefixed with a top-border marker)
 * plus a content region box (a flex column) holding the active tab's content
 * nodes. The tab list is JS bookkeeping (never scene props); the interactive
 * state (`active`) lives on the root box's props. Drive it with
 * {@link activateTab} / {@link closeTab} / {@link tabsKey}. No new napi node
 * kind: the `tabs` element materializes as a `box` (constitution).
 */
export function Tabs(props: TabsProps): Node {
  const specs = props.tabs.map((spec) => ({ ...spec, content: [...spec.content] }));
  const rootProps: NodeProps = {
    ...props,
    active: clampTabIndex(typeof props.active === "number" ? props.active : 0, specs.length),
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.tabs;
  delete plain.closable;
  const tabs = Node.create("tabs", rootProps, []);
  tabSpecs.set(tabs, specs);
  tabClosables.set(tabs, props.closable ?? false);
  rebuildTabs(tabs);
  return tabs;
}

/**
 * Make the tab at `index` the active tab (clamped into the tabs), restyling
 * the tab bar and swapping the content region to the tab's content. A no-op
 * when `index` is out of range or already active.
 */
export function activateTab(tabs: Node, index: number): void {
  const specs = tabSpecs.get(tabs) ?? [];
  const clamped = clampTabIndex(index, specs.length);
  const current = clampTabIndex(typeof tabs.props.active === "number" ? tabs.props.active : 0, specs.length);
  if (clamped === current) return;
  tabs.setProps({ ...tabs.props, active: clamped });
  rebuildTabs(tabs);
}

/**
 * Close the tab at `index`: remove it from the tab list and re-clamp the
 * active index — closing a tab before the active one shifts it down, closing
 * the active one leaves the tab that slid into its slot (the new last tab
 * when the closed one was last; index 0 when the last tab closed). A no-op
 * when `index` is out of range.
 */
export function closeTab(tabs: Node, index: number): void {
  const specs = tabSpecs.get(tabs);
  if (specs === undefined) return;
  if (index < 0 || index >= specs.length) return;
  const props = tabs.props as TabsProps;
  const oldActive = clampTabIndex(typeof props.active === "number" ? props.active : 0, specs.length);
  specs.splice(index, 1);
  const nextActive = clampTabIndex(index < oldActive ? oldActive - 1 : oldActive, specs.length);
  tabs.setProps({ ...props, active: nextActive });
  rebuildTabs(tabs);
}

/**
 * Apply a key to a tabs node, mutating its state and rebuilding the
 * composition in place — the Tabs counterpart of {@link selectKey}.
 *
 * - `left` / `right` move the active tab (clamped at the ends).
 * - `ctrl+tab` / `ctrl+shift+tab` move to the next / previous tab, wrapping
 *   around the ends.
 * - `ctrl+w` closes the active tab (the active index re-clamps into the
 *   shorter list).
 *
 * Returns the new state; any other key leaves the tabs unchanged.
 */
export function tabsKey(tabs: Node, event: KeyEvent): TabsState {
  const specs = tabSpecs.get(tabs) ?? [];
  const active = clampTabIndex(typeof tabs.props.active === "number" ? tabs.props.active : 0, specs.length);
  const name = event.name;

  if (name === "left") {
    activateTab(tabs, active - 1);
  } else if (name === "right") {
    activateTab(tabs, active + 1);
  } else if (name === "tab" && event.ctrl && !event.shift) {
    // ctrl+tab: next, wrapping to the first tab.
    if (specs.length > 1) activateTab(tabs, (active + 1) % specs.length);
  } else if (name === "tab" && event.ctrl && event.shift) {
    // ctrl+shift+tab: previous, wrapping to the last tab.
    if (specs.length > 1) activateTab(tabs, (active - 1 + specs.length) % specs.length);
  } else if (name === "w" && event.ctrl) {
    // ctrl+w: close the active tab (closeTab re-clamps the active index).
    closeTab(tabs, active);
  }

  // Re-read the live state: a ctrl+w close changed the tab count.
  const after = tabSpecs.get(tabs) ?? [];
  const nextActive = clampTabIndex(typeof tabs.props.active === "number" ? tabs.props.active : 0, after.length);
  return { active: nextActive, count: after.length };
}

// ---------------------------------------------------------------------------
// Progress
//
// A `progress` element is a framed box (ratatui Gauge parity): a single-row
// gauge whose frame (default `plain`) wraps a filled bar — `'▓'` fill cells
// computed exactly as `ceil(value/max * inner_width)` over the inner width
// (the outer `width` minus the frame's border columns), the rest `'░'` — with
// an optional label text leaf left-aligned inside the bar area (composed only
// when it fits alongside the percentage readout) and an optional percentage
// readout (`ceil(value/max*100)%`) right-aligned inside it. The label and the
// readout are absolutely positioned overlays on top of the fill leaf
// (mirroring ratatui, where the label/percentage replace the fill glyphs in
// their cells), so the fill-cell math stays exact regardless of them. The
// bar model (`value`/`max`, or a `ratio` 0..1 float directly) lives on the
// root box's props; the composition bookkeeping (`label` /
// `show_percentage`) lives in WeakMaps (never scene props, mirroring `Tabs`'
// `tabSpecs`), and `setProgress` mutates the model and repaints the bar and
// readout in place — no rebuild. No new napi node kind: the `progress`
// element materializes as a `box` (constitution).
// ---------------------------------------------------------------------------

/** Props for the `Progress` element. Style/layout keys flow to the framed
 * box; `value`/`max` (or `ratio`) drive the fill math; `label` /
 * `show_percentage` / `width` are consumed by the factory. */
export interface ProgressProps extends NodeProps {
  /** The current progress value (default 0). */
  value?: number;
  /** The maximum value (default 100); the bar is full at `value === max`. */
  max?: number;
  /**
   * A 0..1 fill ratio as an alternative to `value`/`max`. When given, it
   * wins over `value`/`max` for both the bar fill and the percentage
   * readout (`ceil(ratio*100)%`). {@link setProgress} replaces it with an
   * explicit `value`/`max`.
   */
  ratio?: number;
  /** The optional label text, left-aligned inside the bar area when there is
   * room (composed only when it fits alongside the percentage readout). */
  label?: string;
  /** Whether the percentage readout renders on the right (default `true`). */
  show_percentage?: boolean;
  /**
   * The outer width in cells, including the frame (default
   * {@link PROGRESS_DEFAULT_WIDTH}); the inner bar width is this minus the
   * frame's border columns (2 for a visible `border_style`, 0 for `none`).
   */
  width?: number;
}

/** The default outer width of a progress gauge, in cells. */
export const PROGRESS_DEFAULT_WIDTH = 20;
/** The fill glyph of a progress bar's filled cells. */
export const PROGRESS_FILL_CHAR = "▓";
/** The fill glyph of a progress bar's unfilled cells. */
export const PROGRESS_EMPTY_CHAR = "░";
/**
 * The cell width reserved for the percentage readout in the label's room
 * check — the readout's widest form (`"100%"`). Reserving the widest form
 * keeps label presence stable as the value changes, so {@link setProgress}
 * never has to add or remove leaves (it repaints in place).
 */
const PROGRESS_PERCENT_RESERVE = 4;

/** The label text of a progress node (JS bookkeeping — never scene props,
 * mirroring `Tabs`' `tabSpecs`). Captured at creation because the label key
 * is consumed by the factory. */
const progressLabels = new WeakMap<Node, string>();

/** Whether a progress node renders its percentage readout (JS bookkeeping —
 * never scene props, mirroring `Select`'s `floating` mapping to `z_index`). */
const progressShowPercentages = new WeakMap<Node, boolean>();

/** The ratio (0..1) of a progress node's props: the explicit `ratio` wins;
 * otherwise `value`/`max` (defaults 0/100, clamped into [0, 1]). */
function progressRatio(props: ProgressProps): number {
  const ratio = props.ratio;
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    return Math.max(0, Math.min(1, ratio));
  }
  const value = typeof props.value === "number" && Number.isFinite(props.value)
    ? Math.max(0, props.value)
    : 0;
  const max = typeof props.max === "number" && Number.isFinite(props.max) && props.max > 0
    ? props.max
    : 100;
  return Math.max(0, Math.min(1, value / max));
}

/** The outer width of a progress node (default {@link PROGRESS_DEFAULT_WIDTH}). */
function progressOuterWidth(props: ProgressProps): number {
  const width = props.width;
  return typeof width === "number" && Number.isFinite(width) && width > 0
    ? Math.floor(width)
    : PROGRESS_DEFAULT_WIDTH;
}

/** The frame's horizontal border columns: 2 for a visible `border_style`,
 * 0 for `"none"` or unset. */
function progressFrameWidth(props: ProgressProps): number {
  const border = props.border_style;
  return border !== undefined && border !== "none" ? 2 : 0;
}

/** The bar area width (inside the frame): the outer width minus the border
 * columns. */
function progressInnerWidth(props: ProgressProps): number {
  return Math.max(0, progressOuterWidth(props) - progressFrameWidth(props));
}

/** The percentage readout text: `ceil(ratio*100)%` (e.g. `"50%"`). */
function progressPercentText(props: ProgressProps): string {
  return `${Math.ceil(progressRatio(props) * 100)}%`;
}

/** Whether the label leaf is composed: a non-empty `label` that fits inside
 * the bar area alongside the percentage readout (which reserves its widest
 * form, so the check is stable across value changes). */
function progressLabelFits(
  label: string,
  props: ProgressProps,
  showPercentage: boolean,
): boolean {
  if (label === "") return false;
  const reserve = showPercentage ? PROGRESS_PERCENT_RESERVE : 0;
  return textWidth(label) + reserve <= progressInnerWidth(props);
}

/** The bar text of a progress node's fill leaf: exactly
 * `ceil(ratio * inner_width)` `'▓'` cells followed by `'░'` for the rest of
 * the inner width. */
function progressBarText(props: ProgressProps): string {
  const inner = progressInnerWidth(props);
  const filled = Math.max(0, Math.min(inner, Math.ceil(progressRatio(props) * inner)));
  return PROGRESS_FILL_CHAR.repeat(filled) + PROGRESS_EMPTY_CHAR.repeat(inner - filled);
}

/**
 * Rebuild a progress node's children from its current props (the source of
 * truth, mirroring `rebuildTabs`): the in-flow fill leaf (the bar text at the
 * inner width) plus the optional label overlay (left-aligned, dimmed, only
 * when it fits) and the optional percentage readout overlay (right-aligned).
 * The overlays carry a `z_index` so they paint above the fill leaf. Runs at
 * creation and after a {@link setProgress} call that changes the composition
 * (the label's room check is stable, so in practice `setProgress` repaints in
 * place without rebuilding).
 */
function rebuildProgress(node: Node): void {
  const props = node.props as ProgressProps;
  const showPercentage = progressShowPercentages.get(node) ?? true;
  for (const child of [...node.children]) child.remove();

  // The fill leaf: in-flow, sized to the full inner width — the label and
  // readout overlay it, mirroring ratatui Gauge, so the fill count is exact.
  node.addChild(Text({ text: progressBarText(props), width: progressInnerWidth(props) }));
  // The label overlay: left-aligned inside the bar area when there is room.
  const label = progressLabels.get(node) ?? "";
  if (progressLabelFits(label, props, showPercentage)) {
    node.addChild(
      Text({ text: label, position: "absolute", left: 0, z_index: 1, dim: true }),
    );
  }
  // The percentage readout overlay: right side of the bar area.
  if (showPercentage) {
    node.addChild(
      Text({ text: progressPercentText(props), position: "absolute", right: 0, z_index: 1 }),
    );
  }
}

/**
 * Create a `progress` element (ratatui Gauge parity): a framed box — the
 * frame defaults to `border_style: "plain"`, the outer `width` (default
 * {@link PROGRESS_DEFAULT_WIDTH}) minus the border columns is the inner bar
 * width — holding an in-flow fill leaf (`'▓'` × `ceil(value/max * inner)`,
 * `'░'` for the rest) plus an optional dimmed label leaf left-aligned inside
 * the bar area (composed only when it fits alongside the readout) and an
 * optional percentage readout (`ceil(value/max*100)%`) right-aligned inside
 * it. The label and readout are absolutely positioned overlays on the fill,
 * so the fill-cell math is exact regardless of them. A `ratio` prop (0..1)
 * drives the bar directly as an alternative to `value`/`max`. Update a live
 * bar without rebuilding with {@link setProgress}. No new napi node kind: the
 * `progress` element materializes as a `box` (constitution).
 */
export function Progress(props: ProgressProps = {}): Node {
  const rootProps: NodeProps = {
    ...props,
    // The gauge is framed by default (ratatui parity); `border_style: "none"`
    // opts out and the inner width becomes the full outer width.
    border_style: props.border_style ?? "plain",
    flex_direction: "row",
    height: 1,
    width: progressOuterWidth(props),
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.label;
  delete plain.show_percentage;
  const node = Node.create("progress", rootProps, []);
  progressLabels.set(node, typeof props.label === "string" ? props.label : "");
  progressShowPercentages.set(node, props.show_percentage !== false);
  rebuildProgress(node);
  return node;
}

/**
 * Update a live progress bar's value without rebuilding its composition:
 * sets `value`/`max` on the node's props (the explicit `max` argument wins,
 * falling back to the node's current `max`) and repaints the fill leaf and
 * the percentage readout in place. The label leaf's presence is stable (its
 * room check reserves the readout's widest form), so no leaves are added or
 * removed — a pure in-place update.
 */
export function setProgress(node: Node, value: number, max?: number): void {
  const props = node.props as ProgressProps;
  const nextMax = max ?? (typeof props.max === "number" ? props.max : 100);
  const next: ProgressProps = { ...props, value, max: nextMax };
  // `value`/`max` now govern the bar — the `ratio` prop (if any) is dropped.
  delete next.ratio;
  node.setProps(next);
  const bar = node.children[0];
  if (bar !== undefined && bar.type === "text") {
    bar.setProps({ ...bar.props, text: progressBarText(next), width: progressInnerWidth(next) });
  }
  if (progressShowPercentages.get(node) ?? true) {
    const readout = node.children[node.children.length - 1];
    if (readout !== undefined && readout.type === "text") {
      readout.setProps({ ...readout.props, text: progressPercentText(next) });
    }
  }
}

// ---------------------------------------------------------------------------
// Modal
//
// A `modal` element is a full-bleed overlay: an absolutely positioned root
// box (inset to its parent's padding box — the scene root when the modal is
// mounted at the tree top) stamped with a high `z_index` so it paints above
// in-flow content (compositor z-order, the same mechanism `Select`'s
// `floating` overlay uses), composing a dimmed backdrop box plus a centered
// content box that wraps the modal's content nodes. The interactive state
// (`open`) lives on the root box's props, mirroring `Select`'s `open`;
// `openModal` / `closeModal` toggle it plus the visible state (`hidden`
// modifier + the engine's `display: none`, so a closed overlay really leaves
// the scene), and isolate focus through the {@link FocusManager}: opening
// records the active id and focuses the first registered focusable
// (`focusFirst`), closing restores the recorded id (blurring when nothing
// was recorded). No new napi node kind: the `modal` element materializes as
// a `box` (constitution).
// ---------------------------------------------------------------------------

/** The modal overlay's paint z-order (100). In-flow content stacks at z 0
 * (the scrollbar / sticky table header at 1), so a modal stamped with this
 * `z_index` always paints above them (compositor z-order, the same
 * mechanism `Select`'s `floating` overlay uses). */
export const MODAL_Z_INDEX = 100;

/** The backdrop's fill color: a dark slate a shade below the default palette
 * backgrounds, so the dim layer reads as a shade over the content beneath
 * the overlay. */
export const MODAL_BACKDROP_BG = "#17191e";

/**
 * Props for the `Modal` element. `backdrop` / `content` are consumed by the
 * factory (the content node list is JS bookkeeping — it never reaches the
 * scene props, mirroring `Panels`' `panels`); `open` / `z_index` reach the
 * root box's scene props (the compositor's paint z-order, default
 * {@link MODAL_Z_INDEX}).
 */
export interface ModalProps extends NodeProps {
  /** Whether the modal is open (default `false`). `openModal` / `closeModal`
   * toggle it (and the visible state); a modal starts hidden. */
  open?: boolean;
  /** Whether the dimmed backdrop box is composed (default `true`). */
  backdrop?: boolean;
  /** The overlay's paint z-order (default {@link MODAL_Z_INDEX}). */
  z_index?: number;
  /** Content nodes wrapped into the centered content box (the Solid
   *  factory's path; `Box`-style rest-arg children work too). */
  content?: Node[];
}

/** The per-modal focus bookkeeping (JS state — never scene props). */
interface ModalState {
  /** The active focus id recorded when the modal opened (restored on close;
   * `null` when nothing was focused before the open). */
  previousFocusId: string | null;
}

/** The focus records of modal nodes created with {@link Modal}. */
const modalStates = new WeakMap<Node, ModalState>();

/**
 * Create a `modal` element: an absolutely positioned, full-bleed overlay box
 * (inset to its parent's padding box) stamped with a high `z_index` so it
 * paints above in-flow content, composing a dimmed backdrop box (an absolute
 * fill with a dark `bg`, unless `backdrop: false`) plus a centered content
 * box (a flex column) wrapping the content nodes (rest-arg children or the
 * `content` prop). The visible state starts from `open` (default `false` —
 * hidden); drive it with {@link openModal} / {@link closeModal}, which also
 * move focus into / out of the overlay through the {@link FocusManager}. No
 * new napi node kind: the `modal` element materializes as a `box`
 * (constitution).
 */
export function Modal(props: ModalProps = {}, ...children: Node[]): Node {
  const open = props.open ?? false;
  const backdrop = props.backdrop ?? true;
  const content: Node[] = [...children];
  if (Array.isArray(props.content)) content.push(...props.content);

  const rootProps: NodeProps = {
    ...props,
    open,
    // A closed modal is truly gone: the `hidden` modifier (the reconciler's
    // hide semantics) plus `display: none` (the engine removes the node and
    // its subtree from layout).
    hidden: !open,
    display: open ? "flex" : "none",
    // The Select `floating` pattern: the overlay's paint z-order is stamped
    // on the root box (an explicit `z_index` prop wins).
    z_index: (props.z_index as number | undefined) ?? MODAL_Z_INDEX,
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flex_direction: "column",
    justify_content: "center",
    align_items: "center",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.content;
  delete plain.backdrop;

  const composed: Node[] = [];
  if (backdrop) {
    // The dim layer: an absolute fill covering the overlay, painted beneath
    // the centered content box (child order within the same z layer).
    composed.push(
      Box({
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        bg: MODAL_BACKDROP_BG,
        dim: true,
      }),
    );
  }
  composed.push(Box({ flex_direction: "column" }, ...content));

  const modal = Node.create("modal", rootProps, composed);
  modalStates.set(modal, { previousFocusId: null });
  return modal;
}

/**
 * Open a modal overlay: record the currently active focus id, show the
 * overlay (toggle the `hidden` modifier off and `display` back to flex), and
 * move focus into it — `focusFirst()` focuses the first registered
 * focusable (the overlay's content is expected to register its focusables
 * with `manager`). A no-op when the modal is already open (the record must
 * not be overwritten by the focus that now sits inside the overlay).
 */
export function openModal(modal: Node, manager: FocusManager = focusManager): void {
  const state = modalStates.get(modal);
  if (state === undefined || modal.props.open === true) return;
  state.previousFocusId = manager.activeId;
  modal.setProps({ ...modal.props, open: true, hidden: false, display: "flex" });
  manager.focusFirst();
}

/**
 * Close a modal overlay: hide it (toggle the `hidden` modifier on and
 * `display` to none) and restore the focus recorded by {@link openModal} —
 * the previously active id, or a blur when nothing was focused before the
 * open (fallback `null`; a recorded id that was unregistered meanwhile also
 * falls back to a blur). A no-op when the modal is already closed.
 */
export function closeModal(modal: Node, manager: FocusManager = focusManager): void {
  const state = modalStates.get(modal);
  if (state === undefined || modal.props.open !== true) return;
  const previous = state.previousFocusId;
  modal.setProps({ ...modal.props, open: false, hidden: true, display: "none" });
  state.previousFocusId = null;
  if (previous === null || !manager.focus(previous)) {
    manager.blur();
  }
}

// ---------------------------------------------------------------------------
// Syntax highlighting (roadmap Phase 4)
//
// `highlightCode` token-highlights a code string in a Markdown fence
// language through the napi binding's `highlight` (tree-sitter in the Rust
// `tern-highlight` crate). It returns a complete span stream — every byte of
// the source is covered, adjacent same-style runs merge — whose `text`
// concatenation reconstructs the input exactly, so the spans are ready for
// `StreamingText.appendSpan` or for the MarkdownView code-fence composer.
// The native call is lazy and fallible: when the addon is unavailable (plain
// `deno test`, a browser host) or the language is unknown, it returns `[]`
// and callers fall back to unstyled rendering. The engine logic stays in Rust
// (constitution) — JS only maps the returned tokens onto scene styles.
// ---------------------------------------------------------------------------

/** The Markdown fence languages `highlightCode` recognizes (aliases map to
 * the same grammar). */
const HIGHLIGHT_LANGUAGES = new Set([
  "rust",
  "rs",
  "typescript",
  "ts",
  "tsx",
  "javascript",
  "js",
  "jsx",
  "json",
  "bash",
  "shell",
  "sh",
  "zsh",
]);

/**
 * Token-highlight `code` in `language` (a Markdown fence info string such as
 * `"rust"`, `"ts"`, `"json"`, `"bash"`). Returns a complete span stream whose
 * `text` concatenation reconstructs `code` exactly; spans carry `fg` (hex)
 * and modifier style keys ready for `Node.appendSpan` or a `Text` leaf.
 * Returns `[]` for unknown languages or when the native addon cannot be
 * loaded — callers fall back to unstyled rendering.
 */
export function highlightCode(language: string, code: string): Span[] {
  const lang = language.trim().toLowerCase();
  if (!HIGHLIGHT_LANGUAGES.has(lang) || code === "") return [];
  try {
    const addon = loadAddon();
    if (typeof addon.highlight !== "function") return [];
    return addon.highlight(lang, code).map((raw: HighlightSpanJs): Span => {
      const style: NodeProps = {};
      if (raw.fg !== undefined && raw.fg !== null) style.fg = raw.fg;
      if (raw.bold) style.bold = true;
      if (raw.italic) style.italic = true;
      if (raw.dim) style.dim = true;
      if (raw.underline) style.underline = true;
      return { text: raw.text, style };
    });
  } catch {
    // The addon is not available (no --allow-ffi, browser host) — unstyled.
    return [];
  }
}

// ---------------------------------------------------------------------------
// MarkdownView
//
// A `markdown` element renders a Markdown source as a flex column of styled
// `Text`/`Box` leaves. The block parser (line-based, CommonMark-flavored)
// recognizes headings, lists (bulleted + ordered, 2-space nesting), block
// quotes, horizontal rules, code fences (backtick/tilde) and paragraphs; the
// inline parser recognizes `**bold**`, `*italic*`, `` `code` ``, and
// `[links](url)` — including nested combos (`**a *b* c**`) and links inside
// other styles. Parsing is best-effort and streaming-friendly: a half-open
// code fence (the closing marker has not arrived yet) renders its collected
// lines as the fenced block — a box with the single fence `bg` and, for a
// recognized fence language, tree-sitter token colors (`highlightCode`); an
// unclosed inline marker styles the rest of its line. Plain lines compose as
// a single `Text` leaf (soft-wrapping at the `width` prop); a line with mixed
// inline styles composes as one unwrapped flex row of per-span leaves. No new
// napi node kind: the `markdown` element materializes as a `box`
// (constitution).
// ---------------------------------------------------------------------------

/** The fg of an inline `` `code` `` span (One-Dark red — inline code reads as
 * a keyword accent against the default text). */
export const MARKDOWN_CODE_FG = "#e06c75";
/** The fg of a `[link](url)` span (One-Dark blue — links read as the
 * `primary` role; the underline is the link affordance). */
export const MARKDOWN_LINK_FG = "#61afef";
/** The bg of a code fence block — the default theme's panel background. The
 * single fence style stands in for token colors until tree-sitter
 * highlighting lands (roadmap Phase 4). */
export const MARKDOWN_FENCE_BG = "#21252b";
/** The glyph of a horizontal rule. */
export const MARKDOWN_HR_CHAR = "─";
/** The default width of a horizontal rule in cells (when no `width` prop is
 * set). */
export const MARKDOWN_HR_WIDTH = 40;

/** Props for the `MarkdownView` element. `source` is consumed by the factory
 * (the parsed block model is JS bookkeeping — it never reaches the scene
 * props, mirroring `Panels`' `panels`); the remaining style/layout props flow
 * to the root box, which is a flex column of the composed block nodes. */
export interface MarkdownViewProps extends NodeProps {
  /** The Markdown source to render. */
  source: string;
  /**
   * The soft-wrap width in cells (default unset — lines stay unwrapped and
   * the compositor trims overflow at the right edge). Plain paragraph /
   * heading / list / blockquote leaves soft-wrap at this width (mirroring
   * `Textarea`), and the horizontal rule spans it.
   */
  width?: number;
}

/** One styled text segment of a parsed inline line: the literal text plus the
 * style keys the inline parser derived (`bold` / `italic` / `fg` /
 * `underline`). */
interface MarkdownSpan {
  text: string;
  style: NodeProps;
}

/** A parsed markdown block, before node composition. */
type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; prefix: string; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "hr" }
  | { kind: "code"; lines: string[]; lang: string };

/** A heading marker: 1-6 `#` followed by whitespace. */
const MARKDOWN_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** A bullet list item: `-` / `*` / `+` after any leading indent (each 2-space
 * step is one nesting level). */
const MARKDOWN_ULIST_RE = /^ *([-*+])[ \t]+(.*)$/;
/** An ordered list item: a number plus `.` / `)` after any leading indent. */
const MARKDOWN_OLIST_RE = /^ *(\d+[.)])[ \t]+(.*)$/;
/** A block quote line: `>` (with an optional following space). */
const MARKDOWN_QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
/** A thematic break: 3+ of the same `-` / `*` / `_`, spaces allowed between
 * (checked before the list patterns — `- - -` is a rule, not an item). */
const MARKDOWN_HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A code fence opener: 3+ backticks or 3+ tildes, plus an ignored info
 * string (the language — consumed here and fed to `highlightCode`). */
const MARKDOWN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/** Whether `line` closes the fence opened with fence char `char` (3+ of the
 * same char, trailing spaces only). */
function markdownFenceClose(line: string, char: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === char;
}

/**
 * Parse a Markdown source into its block model. Line-based and best-effort: a
 * half-open code fence (no closing marker before the end of the source) still
 * yields a `code` block with the lines collected so far, so a streaming
 * document renders progressively and settles when the fence closes.
 */
function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = MARKDOWN_FENCE_RE.exec(line);
    if (fence !== null) {
      const char = fence[1]![0]!;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !markdownFenceClose(lines[i]!, char)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume the closing marker line
      // The fence info string's first whitespace/brace-delimited token is the
      // language (e.g. `rust` in ```rust) — consumed, never rendered.
      const info = (fence[2] ?? "").trim().split(/[\s{]/)[0]!.toLowerCase();
      blocks.push({ kind: "code", lines: codeLines, lang: info });
      continue;
    }
    const heading = MARKDOWN_HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (MARKDOWN_HR_RE.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    const quote = MARKDOWN_QUOTE_RE.exec(line);
    if (quote !== null) {
      blocks.push({ kind: "blockquote", text: `> ${quote[1]!}` });
      i += 1;
      continue;
    }
    const ulist = MARKDOWN_ULIST_RE.exec(line);
    if (ulist !== null) {
      const indent = line.length - line.trimStart().length;
      blocks.push({ kind: "list", prefix: "  ".repeat(Math.min(6, Math.floor(indent / 2))) + "• ", text: ulist[2]! });
      i += 1;
      continue;
    }
    const olist = MARKDOWN_OLIST_RE.exec(line);
    if (olist !== null) {
      const indent = line.length - line.trimStart().length;
      blocks.push({ kind: "list", prefix: "  ".repeat(Math.min(6, Math.floor(indent / 2))) + `${olist[1]!} `, text: olist[2]! });
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1; // blank lines separate blocks — nothing to render
      continue;
    }
    blocks.push({ kind: "paragraph", text: line });
    i += 1;
  }
  return blocks;
}

/** Whether two inline span styles carry the same derived keys (the parser
 * only produces `bold` / `italic` / `fg` / `underline`). */
function markdownSpanStyleEqual(a: NodeProps, b: NodeProps): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.fg === b.fg && a.underline === b.underline;
}

/**
 * Parse a line's inline styles into styled spans. A small state machine over
 * the markers `**` (bold), `*` (italic), `` ` `` (code — markers inside a
 * code span stay literal), and `[label](url)` (a link: the label is re-parsed
 * recursively and stamped with `underline` + {@link MARKDOWN_LINK_FG}).
 * Nesting works because each marker toggles its flag (`**a *b* c**`); an
 * unclosed marker styles the rest of the line (best-effort while streaming).
 * Adjacent spans with identical styles are merged.
 */
function parseInline(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let buf = "";
  let bold = false;
  let italic = false;
  let code = false;

  const push = (span: MarkdownSpan): void => {
    const last = spans[spans.length - 1];
    if (last !== undefined && markdownSpanStyleEqual(last.style, span.style)) {
      last.text += span.text;
    } else {
      spans.push(span);
    }
  };

  const flush = (): void => {
    if (buf === "") return;
    const style: NodeProps = {};
    if (bold) style.bold = true;
    if (italic) style.italic = true;
    if (code) style.fg = MARKDOWN_CODE_FG;
    push({ text: buf, style });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("`")) {
      flush();
      code = !code;
      i += 1;
      continue;
    }
    if (code) {
      // Inside a code span only the closing backtick is a marker — every
      // other character (asterisks, brackets) is literal.
      buf += text[i]!;
      i += 1;
      continue;
    }
    if (rest.startsWith("**")) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (rest.startsWith("*")) {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    if (rest.startsWith("[")) {
      const close = rest.indexOf("](");
      if (close !== -1) {
        const paren = rest.indexOf(")", close + 2);
        if (paren !== -1) {
          flush();
          // The link's label is parsed inline and stamped with the link
          // style; the surrounding bold/italic carry into the link spans.
          for (const span of parseInline(rest.slice(1, close))) {
            const style: NodeProps = { ...span.style, underline: true, fg: MARKDOWN_LINK_FG };
            if (bold) style.bold = true;
            if (italic) style.italic = true;
            push({ text: span.text, style });
          }
          i += paren + 1;
          continue;
        }
      }
    }
    buf += text[i]!;
    i += 1;
  }
  flush();
  return spans;
}

/**
 * Compose one markdown text line into scene nodes: a single `Text` leaf when
 * the line parses to one span (the common case — it soft-wraps at `width`),
 * or a flex row of per-span `Text` leaves when the line mixes inline styles.
 * `base` is the block style (e.g. `dim` for a block quote); span styles
 * override it.
 */
function markdownLineNode(text: string, base: NodeProps, width: number | null): Node {
  const spans = parseInline(text);
  if (spans.length === 1) {
    const span = spans[0]!;
    const props: NodeProps = { ...base, text: span.text, ...span.style };
    if (width !== null) props.width = width;
    return Text(props);
  }
  const leaves = spans.map((span) => Text({ ...base, text: span.text, ...span.style }));
  return Box({ flex_direction: "row" }, ...leaves);
}

/** Compose one highlighted code line into a scene node: a single `Text` leaf
 * when the line parses to one span (the common case), or a flex row of
 * per-span `Text` leaves when it mixes token styles. */
function markdownSpanRow(spans: Span[]): Node {
  if (spans.length === 1) {
    const span = spans[0]!;
    return Text({ text: span.text, ...span.style });
  }
  return Box(
    { flex_direction: "row" },
    ...spans.map((span) => Text({ text: span.text, ...span.style })),
  );
}

/** Compose one parsed markdown block into its scene node(s). */
function buildMarkdownBlock(block: MarkdownBlock, width: number | null): Node {
  switch (block.kind) {
    case "heading": {
      // Headings render bold at every level; an H1 additionally underlines
      // (terminal markdown renderers have no font sizes — weight/underline
      // carry the hierarchy).
      const style: NodeProps = { bold: true };
      if (block.level === 1) style.underline = true;
      return markdownLineNode(block.text, style, width);
    }
    case "paragraph":
      return markdownLineNode(block.text, {}, width);
    case "list":
      return markdownLineNode(block.prefix + block.text, {}, width);
    case "blockquote":
      return markdownLineNode(block.text, { dim: true }, width);
    case "hr":
      return Text({ text: MARKDOWN_HR_CHAR.repeat(width ?? MARKDOWN_HR_WIDTH), dim: true });
    case "code": {
      // The fenced block: a box with the fence `bg`. With a recognized fence
      // language the whole code text is token-highlighted and composed as one
      // node per line — a single `Text` leaf when the line is uniform, a flex
      // row of per-span leaves when it mixes styles (mirroring
      // `markdownLineNode`); otherwise (unknown language, or the addon is not
      // available) one plain text leaf per line. Fence marker lines are
      // consumed — a half-open fence renders exactly like a closed one
      // (best-effort streaming).
      const spans = highlightCode(block.lang, block.lines.join("\n"));
      if (spans.length === 0) {
        return Box(
          { flex_direction: "column", bg: MARKDOWN_FENCE_BG },
          ...block.lines.map((line) => Text({ text: line })),
        );
      }
      const rows: Node[] = [];
      let rowSpans: Span[] = [];
      // The span stream reconstructs the joined source exactly, so splitting
      // each span's text on newlines regroups it per code line.
      for (const span of spans) {
        const parts = span.text.split("\n");
        parts.forEach((part, i) => {
          if (i > 0) {
            rows.push(markdownSpanRow(rowSpans));
            rowSpans = [];
          }
          rowSpans.push(span.style === undefined ? { text: part } : { text: part, style: span.style });
        });
      }
      if (rowSpans.length > 0) rows.push(markdownSpanRow(rowSpans));
      return Box({ flex_direction: "column", bg: MARKDOWN_FENCE_BG }, ...rows);
    }
  }
}

/**
 * Create a `markdown` element: a flex column of block nodes rendering the
 * Markdown `source` — headings (bold, H1 underlined), paragraphs, bulleted /
 * ordered lists (`•` items, 2-space nesting), block quotes (dimmed `> `),
 * horizontal rules (a `─` run) and code fences (a `bg` box, one leaf per
 * line) — with `**bold**` / `*italic*` / `` `code` `` / `[links](url)` inline
 * styles parsed into per-span `Text` leaves. Parsing is best-effort and
 * streaming-friendly: a half-open code fence renders its collected lines as
 * the fenced block, and an unclosed inline marker styles the rest of its
 * line. The `source` key is consumed (JS bookkeeping — never a scene prop);
 * the `width` prop soft-wraps plain lines and spans the horizontal rule. No
 * new napi node kind: the `markdown` element materializes as a `box`
 * (constitution).
 */
export function MarkdownView(props: MarkdownViewProps): Node {
  const width =
    typeof props.width === "number" && Number.isFinite(props.width) && props.width > 0
      ? Math.floor(props.width)
      : null;
  const blocks = parseMarkdown(props.source ?? "").map((block) => buildMarkdownBlock(block, width));
  const rootProps: NodeProps = { ...props, flex_direction: "column" };
  const plain = rootProps as Record<string, unknown>;
  delete plain.source;
  return Node.create("markdown", rootProps, blocks);
}

// ---------------------------------------------------------------------------
// StreamingText auto-scroll
//
// A `streaming_text` node can pin its `scroll_y` to the content tail as the
// stream grows: `autoScroll: true` (the default) registers the node as
// following its tail, and `syncStreamTail` — called by the @tern-tui/react
// `<StreamingText>` effect and the @tern-tui/solid `subscribeStream` pump after
// each appended span — drives `scroll_y` to the tail offset: the node's
// `Node.contentSize()` height vs its clip viewport (the `clip_height` scene
// prop). A manual scroll above the tail (via `scrollTo` / `scrollBy` /
// `scrollTop`) detaches the follow and pins the view where the user left it;
// `followTail` re-attaches (and snaps back to the tail). The offsets stay
// scene props — the JS side only computes and sets them (constitution: no
// engine logic in JS).
// ---------------------------------------------------------------------------

/** The per-node auto-scroll follow state of a streaming node. */
interface StreamScrollState {
  /** Whether the node currently follows its content tail. */
  following: boolean;
  /** Whether the node's auto-scroll was enabled at creation (or by
   *  `followTail` / `setStreamAutoScroll(true)`): only such a node can *have*
   *  a follow to detach, so only it stamps the scroll-to-bottom affordance
   *  on a manual scroll above the tail. A node created with
   *  `autoScroll: false` never shows the affordance. */
  autoScrollEnabled: boolean;
}

/** The follow states of streaming nodes created with auto-scroll. */
const streamScrollStates = new WeakMap<Node, StreamScrollState>();

/**
 * @internal — register/override a streaming node's auto-scroll follow state.
 * Called by the host factories with the consumed `autoScroll` flag (the
 * `@tern-tui/react` `<StreamingText>` syncs it from its own prop on mount/toggle;
 * the `@tern-tui/solid` `StreamingText` factory passes its consumed flag).
 */
export function setStreamAutoScroll(node: Node, enabled: boolean): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) {
    streamScrollStates.set(node, { following: enabled, autoScrollEnabled: enabled });
  } else {
    state.following = enabled;
    state.autoScrollEnabled = enabled;
  }
}

/** Whether `node` is currently following its content tail (auto-scroll). */
export function isStreamFollowing(node: Node): boolean {
  return streamScrollStates.get(node)?.following ?? false;
}

/**
 * Drive a streaming node's auto-scroll after an appended span: when the node
 * is following its tail, pin `scroll_y` to the tail offset — the content
 * height minus the clip viewport height (floored at 0). A no-op on nodes
 * that are not following, or not attached (the tail measures laid-out
 * geometry). Call after each `Node.appendSpan`; the @tern-tui/react
 * `<StreamingText>` effect and the @tern-tui/solid `subscribeStream` pump do
 * exactly that.
 */
export function syncStreamTail(node: Node): void {
  const state = streamScrollStates.get(node);
  if (state === undefined || !state.following) return;
  if (!node.attached) return;
  const max = maxScroll(node);
  const props = node.props;
  node.setProps({ ...props, scroll_y: max.y });
  renderScrollbar(node);
}

/**
 * Re-attach a streaming node's auto-scroll: the node follows its tail again,
 * snapping `scroll_y` to the current tail offset immediately, and the
 * scroll-to-bottom affordance (stamped when a manual scroll detached the
 * follow) is dismissed. A node that had no follow state (e.g. one built via
 * the raw `Node` constructor) is registered and enabled. On a detached node
 * the snap is deferred until the next `syncStreamTail` after attach.
 */
export function followTail(node: Node): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) {
    streamScrollStates.set(node, { following: true, autoScrollEnabled: true });
  } else {
    state.following = true;
    state.autoScrollEnabled = true;
  }
  dismissStreamAffordance(node);
  if (node.attached) syncStreamTail(node);
}

// ---------------------------------------------------------------------------
// StreamingText scroll-to-bottom affordance
//
// A streaming node whose follow detached (a manual scroll above the tail)
// stamps a small indicator — a `▼` text cell, absolutely positioned at the
// clip region's bottom-right with a `z_index` above in-flow content — so the
// user can see the stream is still growing above. `followTail` (re-attach)
// and `scrollToBottom` (a one-shot jump to the tail) dismiss it. The leaf is
// JS bookkeeping composed into the streaming node (never scene props,
// mirroring the `scroll_view` scrollbar leaf), so it travels with the node
// across detach/re-attach of the tree.
// ---------------------------------------------------------------------------

/** The character of a streaming node's "scroll to bottom" affordance cell. */
export const STREAM_AFFORDANCE_CHAR = "▼";

/** The affordance cell's paint z-order (2): above in-flow content (0) and
 *  the scrollbar leaf (1), so it wins the clip region's bottom-right corner
 *  over both (compositor z-order, the same mechanism `Select`'s `floating`
 *  overlay uses). */
const STREAM_AFFORDANCE_Z_INDEX = 2;

/** The affordance text leaf of a streaming node (JS bookkeeping — never
 *  scene props, mirroring `scrollbarLeaves`). */
const streamAffordanceLeaves = new WeakMap<Node, Node>();

/**
 * Stamp the scroll-to-bottom affordance onto `node` (idempotent): a 1x1 text
 * leaf absolutely positioned at the clip region's bottom-right, painted above
 * in-flow content. The `top` inset is `(clipHeight - 1) + scrollY` — the
 * region's scroll pans subtree drawing up by `scroll_y`, so the compensated
 * inset keeps the cell fixed at the viewport's bottom row while the content
 * scrolls (the same compensation the scrollbar leaf uses). A no-op while
 * detached (no geometry) or when already shown.
 */
function showStreamAffordance(node: Node): void {
  if (streamAffordanceLeaves.has(node)) return;
  if (!node.attached) return;
  const props = node.props;
  const clipHeight = typeof props.clip_height === "number"
    ? props.clip_height
    : node.contentSize().height;
  const leaf = Text({
    position: "absolute",
    right: 0,
    top: Math.max(0, clipHeight - 1) + currentScroll(node).y,
    width: 1,
    height: 1,
    z_index: STREAM_AFFORDANCE_Z_INDEX,
    text: STREAM_AFFORDANCE_CHAR,
  });
  node.addChild(leaf);
  streamAffordanceLeaves.set(node, leaf);
}

/** Remove the scroll-to-bottom affordance from `node` (idempotent). */
function dismissStreamAffordance(node: Node): void {
  const leaf = streamAffordanceLeaves.get(node);
  if (leaf === undefined) return;
  leaf.remove();
  streamAffordanceLeaves.delete(node);
}

/** Recompute the affordance cell's position from the node's current scroll
 *  offset — a no-op while the affordance is not shown. */
function refreshStreamAffordance(node: Node): void {
  const leaf = streamAffordanceLeaves.get(node);
  if (leaf === undefined) return;
  const props = node.props;
  const clipHeight = typeof props.clip_height === "number"
    ? props.clip_height
    : node.contentSize().height;
  leaf.setProps({
    ...leaf.props,
    top: Math.max(0, clipHeight - 1) + currentScroll(node).y,
  });
}

/**
 * Jump a streaming node's view to the bottom of its content (the tail),
 * clamped to the content bounds, and dismiss the scroll-to-bottom
 * affordance. Unlike {@link followTail} — which re-attaches the auto-scroll
 * follow — this is a one-shot jump: the follow state is left untouched, so a
 * node detached by a manual scroll stays detached (subsequent appends do not
 * pin `scroll_y`, and the next scroll above the tail stamps the affordance
 * again). Call it from the affordance's activation (e.g. a click on the `▼`
 * cell); pair with `followTail` to resume live-follow after the jump. The
 * view must be attached: the clamp measures the laid-out sizes. Returns the
 * applied offsets.
 */
export function scrollToBottom(node: Node): { x: number; y: number } {
  const max = maxScroll(node);
  dismissStreamAffordance(node);
  return scrollTo(node, currentScroll(node).x, max.y);
}

// ---------------------------------------------------------------------------
// Theme system
//
// A `Theme` carries a named palette (fg/bg per semantic role) plus
// per-component style presets for the roadmap elements (including
// `select`). Resolution is pure prop data flow:
// `resolveTheme(theme, props)` reads the semantic `role` / `component` hints
// from the props, stamps the resolved `fg` / `bg` / `border_style` onto them,
// and returns plain `NodeProps` — the hints are consumed and never reach the
// scene (constitution: no new napi surface, no engine logic in JS).
// ---------------------------------------------------------------------------

/** The semantic palette roles. `border` colors the frame/border of a node. */
export const THEME_ROLES = [
  "primary",
  "secondary",
  "success",
  "danger",
  "warning",
  "muted",
  "border",
] as const;

/** A semantic palette role ("primary", "danger", ...). */
export type ThemeRole = (typeof THEME_ROLES)[number];

/** The components with themeable style presets. */
export const THEME_COMPONENTS = [
  "input",
  "textarea",
  "spinner",
  "status_bar",
  "panels",
  "diff",
  "select",
  "scroll_view",
  "table",
  "markdown",
  "progress",
] as const;

/** A themeable component kind ("input", "diff", ...). */
export type ThemeComponent = (typeof THEME_COMPONENTS)[number];

/** The fg/bg colors of one palette role. Colors use the engine's string
 * color format: `#rrggbb` hex, `indexed:N`, or `default`. */
export interface ThemeRoleColors {
  /** The foreground color. */
  fg: string;
  /** The background color. */
  bg: string;
}

/** The style a component preset may resolve to node props (all optional —
 * only the keys a preset defines are stamped). */
export interface ThemeStylePreset {
  /** Resolved onto the node's `fg` prop. */
  fg?: string;
  /** Resolved onto the node's `bg` prop. */
  bg?: string;
  /** Resolved onto the node's `border_style` prop. */
  border_style?: NodeProps["border_style"];
}

/** A complete theme: the named palette plus one style preset per component. */
export interface Theme {
  /** The fg/bg colors for every semantic role. */
  palette: { [role in ThemeRole]: ThemeRoleColors };
  /** The per-component style presets. */
  components: { [kind in ThemeComponent]: ThemeStylePreset };
}

/** A partial theme for `mergeTheme` / `ThemeProvider` / `setTheme`: any
 * subset of palette roles or component presets (each merged over the base). */
export interface ThemeOverrides {
  /** Palette roles to override (per-role keys are optional). */
  palette?: Partial<Record<ThemeRole, Partial<ThemeRoleColors>>>;
  /** Component presets to override. */
  components?: Partial<Record<ThemeComponent, ThemeStylePreset>>;
}

/** Props that may carry the semantic theme hints `role` / `component`.
 * `resolveTheme` consumes them; the returned `NodeProps` carry only plain
 * style/layout keys, so the hints never reach the scene. */
export interface ThemeResolvableProps extends NodeProps {
  /** Resolve the node's `fg`/`bg` from this palette role. */
  role?: ThemeRole;
  /** Resolve the node's `fg`/`bg`/`border_style` from this component preset. */
  component?: ThemeComponent;
}

/**
 * The default theme: an One-Dark-flavored palette for code-agent TUIs.
 * Component presets are empty — with the default theme, components render
 * with their built-in defaults; themes that override a component preset get
 * themed components (e.g. a rounded-bordered `Input`).
 */
export const defaultTheme: Theme = {
  palette: {
    primary: { fg: "#61afef", bg: "#21252b" },
    secondary: { fg: "#abb2bf", bg: "#21252b" },
    success: { fg: "#98c379", bg: "#21252b" },
    danger: { fg: "#e06c75", bg: "#21252b" },
    warning: { fg: "#e5c07b", bg: "#21252b" },
    muted: { fg: "#5c6370", bg: "#21252b" },
    border: { fg: "#3e4452", bg: "#21252b" },
  },
  components: {
    input: {},
    textarea: {},
    spinner: {},
    status_bar: {},
    panels: {},
    diff: {},
    select: {},
    scroll_view: {},
    table: {},
    markdown: {},
    progress: {},
  },
};

/**
 * Merge `overrides` over `base`, returning a new `Theme`. Palette roles and
 * component presets are merged per key (a partial role keeps the base's
 * other keys; a partial preset keeps the base's other style keys). The base
 * is never mutated.
 */
export function mergeTheme(base: Theme, overrides: ThemeOverrides = {}): Theme {
  const palette: Theme["palette"] = { ...base.palette };
  for (const role of THEME_ROLES) {
    const override = overrides.palette?.[role];
    if (override !== undefined) {
      palette[role] = { ...base.palette[role], ...override };
    }
  }
  const components: Theme["components"] = { ...base.components };
  for (const kind of THEME_COMPONENTS) {
    const override = overrides.components?.[kind];
    if (override !== undefined) {
      components[kind] = { ...base.components[kind], ...override };
    }
  }
  return { palette, components };
}

/**
 * Resolve `theme` onto `props` at element-creation time, stamping plain
 * style keys:
 *
 * - `component` preset fills missing `fg` / `bg` / `border_style`;
 * - `role` palette then fills any still-missing `fg` / `bg`;
 * - explicit props always win over both.
 *
 * The semantic `role` / `component` hints are consumed (stripped) from the
 * returned props, so the output is ordinary `NodeProps` — the same surface
 * the scene node understands, with no new napi surface (constitution).
 */
export function resolveTheme(theme: Theme, props: ThemeResolvableProps): NodeProps {
  const role = props.role;
  const component = props.component;
  // No hints: return the props object unchanged. Identity here matters —
  // the Solid renderer passes accessor-based reactive props (signal getters)
  // through its factories, and an eager `{ ...props }` copy would flatten
  // the accessors and sever the reactivity.
  if (role === undefined && component === undefined) {
    return props;
  }
  const out: NodeProps = { ...props };
  delete out.role;
  delete out.component;
  const presetFilled = new Set<"fg" | "bg" | "border_style">();
  if (component !== undefined) {
    const preset = theme.components[component];
    if (preset !== undefined) {
      if (out.fg === undefined && preset.fg !== undefined) {
        out.fg = preset.fg;
        presetFilled.add("fg");
      }
      if (out.bg === undefined && preset.bg !== undefined) {
        out.bg = preset.bg;
        presetFilled.add("bg");
      }
      if (out.border_style === undefined && preset.border_style !== undefined) {
        out.border_style = preset.border_style;
        presetFilled.add("border_style");
      }
    }
  }
  if (role !== undefined) {
    const colors = theme.palette[role];
    if (colors !== undefined) {
      // The role palette is the more specific intent: it overrides the
      // component preset's fg/bg, but never an explicit prop.
      if ((out.fg === undefined || presetFilled.has("fg")) && colors.fg !== undefined) {
        out.fg = colors.fg;
      }
      if ((out.bg === undefined || presetFilled.has("bg")) && colors.bg !== undefined) {
        out.bg = colors.bg;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Focus manager
// ---------------------------------------------------------------------------

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
   * Dispatch a key event to a registered element's handler. When `node` is
   * given and registered, it wins; otherwise the active focus handles the
   * event. Returns `false` (and dispatches nothing) when neither applies.
   */
  routeKey(event: KeyEvent, node?: Node): boolean {
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

// ---------------------------------------------------------------------------
// Mouse wheel scroll + click-to-focus
// ---------------------------------------------------------------------------

/**
 * Whether `view` is a scrollable scroll-view-like node: a `scroll_view`,
 * `streaming_text`, `diff`, or `table` element, or any attached node carrying
 * the engine's clip/scroll region props (`clip_*` / `scroll_*`). The node
 * must be attached — scroll geometry (`Node.contentSize()`) errors on a
 * detached node, so a detached view is never scrollable.
 */
function isScrollableNode(view: Node): boolean {
  if (!view.attached) return false;
  const type = view.type;
  if (type === "scroll_view" || type === "streaming_text" || type === "diff" || type === "table") {
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
function wheelScrollTarget(view: Node): Node | null {
  if (!view.attached) return null;
  if (view.type === "table") return tableRegions.get(view) ?? null;
  return view;
}

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

// ---------------------------------------------------------------------------
// Mouse selection (viewport-cell-scoped v1)
// ---------------------------------------------------------------------------
//
// Mouse drag-select + double-click word select (roadmap Phase 5): a
// `down_left` press starts a selection session anchored at the pressed cell
// ({@link startSelection}); each `drag_left` moves the active endpoint to the
// dragged cell, extending the selection rect ({@link dragSelection}); any
// `up_*` release ends the session ({@link endSelection}) — clear-on-release,
// the overlay is transient and lives only while the mouse button is held, so
// a released gesture leaves no reversed cells (persistent selection after
// release is future work). The session lives per renderer (a WeakMap,
// mirroring `panelDrags`), so independent renderers never share selection
// state.
//
// Two `down_left` presses on the same cell (within
// {@link SELECTION_DOUBLE_CLICK_MS} milliseconds and no more than one cell
// apart) synthesize a double-click: the second press replaces the 1-cell
// selection with the word under the pointer, resolved through the native
// `selection_word_range` API ({@link selectWordAt}). {@link copySelection}
// copies the renderer's current selection text to the system clipboard (OSC
// 52) — the action behind the `ctrl+shift+c` binding in
// {@link selectionKey} (plain `ctrl+c` stays the app's exit convention and is
// never consumed by the selection handler).
//
// The whole module is viewport-cell-scoped v1: event `column`/`row` are
// interpreted directly as cells of the terminal viewport the renderer paints
// at, never as a scene node's local coordinates. Node-scoped selection —
// resolving the pressed cell through `renderer.hit_test` to the owning scene
// node and translating into that node's local coordinate space — is future
// work.
//
// The helpers are pure interaction math over the renderer's selection API;
// they never paint. The host drives the render loop — a `render()` after
// routing mouse events paints the overlay (or clears it) — mirroring
// `wheelScroll` / `focusAt`. A host that wants copy-on-release calls
// {@link copySelection} before {@link endSelection}.

/** The double-click window: two `down_left` presses on nearby cells within
 * this many milliseconds synthesize a double-click (word select). */
export const SELECTION_DOUBLE_CLICK_MS = 500;

/** The active mouse selection session on a renderer. */
interface SelectionSession {
  /** The fixed endpoint of the selection (the press-down cell). */
  anchor: { col: number; row: number };
  /** The moving endpoint (updated by each {@link dragSelection}). */
  active: { col: number; row: number };
}

/** The active selection session per renderer (one at a time per renderer). */
const selectionSessions = new WeakMap<Renderer, SelectionSession>();

/** The most recent `down_left` press per renderer, for double-click
 * synthesis. */
interface SelectionPress {
  col: number;
  row: number;
  /** The wall-clock time of the press (from {@link selectionClock}). */
  at: number;
}

/** The most recent press per renderer (survives the gesture: the second press
 * of a double-click lands after the first gesture's release). */
const selectionLastPress = new WeakMap<Renderer, SelectionPress>();

/** The wall-clock source for double-click timing. Overridable through
 * {@link setSelectionClockForTesting}. */
let selectionClock: () => number = () => Date.now();

/**
 * Replace the wall-clock source used for double-click timing. Test-only seam
 * (mirrors `setAddonForTesting`): a fake clock makes the
 * {@link SELECTION_DOUBLE_CLICK_MS} window boundary assertable without a real
 * wait. Pass `() => Date.now()` to restore.
 */
export function setSelectionClockForTesting(clock: () => number): void {
  selectionClock = clock;
}

/**
 * Select the contiguous non-whitespace run (word) containing (`col`, `row`),
 * applying the word's cell range as the renderer's selection overlay.
 * Returns the applied range, or `null` when the cell is blank/whitespace (or
 * out of bounds, or nothing has been painted yet) — the selection is left
 * untouched then. Cluster-aware: the native word-range lookup treats a masked
 * continuation cell (a wide glyph's second column) as part of its glyph's run.
 */
export function selectWordAt(renderer: Renderer, col: number, row: number): SelectionRange | null {
  const range = renderer.selectionWordRange(col, row);
  if (range === null) return null;
  renderer.setSelection(range.col1, range.row1, range.col2, range.row2);
  return range;
}

/**
 * Start a mouse selection: a `down_left` press anchors a selection session at
 * the pressed cell and applies a 1-cell selection overlay. A second press on
 * a nearby cell — within {@link SELECTION_DOUBLE_CLICK_MS} milliseconds and
 * no more than one cell away — is treated as a double-click and selects the
 * word under the pointer instead ({@link selectWordAt}; a double-click on
 * whitespace falls back to the 1-cell selection). Returns the applied
 * selection range, or `null` when the event is not `down_left`.
 */
export function startSelection(renderer: Renderer, event: MouseEventJs): SelectionRange | null {
  if (event.kind !== "down_left") return null;
  const col = event.column;
  const row = event.row;
  const prev = selectionLastPress.get(renderer);
  const at = selectionClock();
  const doubleClick =
    prev !== undefined &&
    at - prev.at <= SELECTION_DOUBLE_CLICK_MS &&
    Math.abs(col - prev.col) + Math.abs(row - prev.row) <= 1;
  let range: SelectionRange;
  if (doubleClick) {
    const word = selectWordAt(renderer, col, row);
    if (word === null) {
      range = { col1: col, row1: row, col2: col, row2: row };
      renderer.setSelection(col, row, col, row);
    } else {
      range = word;
    }
  } else {
    range = { col1: col, row1: row, col2: col, row2: row };
    renderer.setSelection(col, row, col, row);
  }
  selectionSessions.set(renderer, { anchor: { col, row }, active: { col, row } });
  selectionLastPress.set(renderer, { col, row, at });
  return range;
}

/**
 * Move an active selection's active endpoint: a `drag_left` event extends the
 * selection to the dragged cell, keeping the press-down anchor fixed. The
 * updated rect is applied through `renderer.setSelection` (the native overlay
 * normalizes the endpoints, so dragging above/left of the anchor still
 * selects the spanned rectangle). Returns the applied (post-extension)
 * range, or `null` when no session is active or the event is not `drag_left`.
 */
export function dragSelection(renderer: Renderer, event: MouseEventJs): SelectionRange | null {
  const session = selectionSessions.get(renderer);
  if (session === undefined || event.kind !== "drag_left") return null;
  session.active = { col: event.column, row: event.row };
  const range: SelectionRange = {
    col1: session.anchor.col,
    row1: session.anchor.row,
    col2: session.active.col,
    row2: session.active.row,
  };
  renderer.setSelection(range.col1, range.row1, range.col2, range.row2);
  return range;
}

/**
 * End an active mouse selection: any `up_*` release clears the session and
 * the selection overlay — clear-on-release, the highlight is transient and
 * lives only while the mouse button is held. Returns the selection rect at
 * release, or `null` when no session was active (or the event is not an
 * `up_*` release). A host that wants the release-time text on the clipboard
 * calls {@link copySelection} before `endSelection` (copy-on-release).
 */
export function endSelection(renderer: Renderer, event: MouseEventJs): SelectionRange | null {
  const session = selectionSessions.get(renderer);
  if (session === undefined || !event.kind.startsWith("up")) return null;
  selectionSessions.delete(renderer);
  renderer.clearSelection();
  return {
    col1: session.anchor.col,
    row1: session.anchor.row,
    col2: session.active.col,
    row2: session.active.row,
  };
}

/**
 * Copy the renderer's current selection text to the system clipboard (OSC 52
 * via {@link Renderer.setClipboard}): `setClipboard(selectionText())`. With
 * the v1 clear-on-release contract the copy must happen while the selection
 * is active — during the press-drag-release gesture, or in the host's
 * `up_*` handler before it calls {@link endSelection} (copy-on-release).
 */
export function copySelection(renderer: Renderer): void {
  renderer.setClipboard(renderer.selectionText());
}

/**
 * The selection key handler: maps the copy key — `ctrl+shift+c` — to
 * {@link copySelection}, returning whether the key was consumed. Plain
 * `ctrl+c` (the app's exit convention) is deliberately not handled and
 * returns `false`, so it falls through to the exit binding. Note that some
 * terminal emulators intercept `ctrl+shift+c` for their own copy before the
 * app sees it; hosts that want a different copy key can pass a different
 * mapping.
 */
export function selectionKey(renderer: Renderer, event: KeyEvent): boolean {
  if (event.name === "char" && event.char === "c" && event.ctrl && event.shift && !event.alt) {
    copySelection(renderer);
    return true;
  }
  return false;
}

/**
 * An async event queue fed by the native push stream. `push` enqueues an
 * event on the JS thread (called by the native `ThreadsafeFunction`
 * callback); `[Symbol.asyncIterator]` yields events in arrival order until
 * `close`. No events are dropped: a consumer that is slow to `next()` simply
 * accumulates the queue.
 *
 * The iterator is safe against the classic missed-wakeup race: it re-checks
 * the queue after registering its waiter, so an event pushed between the
 * length check and the waiter registration still wakes it.
 */
class TernEventStream implements AsyncIterable<TernEventJs> {
  #queue: TernEventJs[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  /** Enqueue an event delivered from the native event loop. */
  push(event: TernEventJs): void {
    this.#queue.push(event);
    this.#wakeWaiters();
  }

  /** Stop the stream: pending and future `next()` calls resolve as done. */
  close(): void {
    this.#closed = true;
    this.#wakeWaiters();
  }

  #wakeWaiters(): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TernEventJs> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift()!;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        // Re-check after registering: an event (or a close) may have arrived
        // between the checks above and the waiter registration.
        if (this.#queue.length > 0 || this.#closed) {
          const index = this.#waiters.indexOf(resolve);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve();
        }
      });
    }
  }
}

/**
 * A terminal-facing renderer. Constructing one enters raw mode + the
 * alternate screen; `destroy()` (or Ctrl+C with `exitOnCtrlC`) restores the
 * terminal and stops the event stream. A destroyed renderer cannot render or
 * poll.
 *
 * Input delivery is push-based but **explicit**: `startEventStream()` begins
 * the native event loop (and with it the delivery of terminal events to
 * `events` and the `on*` handlers). Call it once the scene is ready — before
 * it, the terminal buffers input untouched, so an app that asserts its scene
 * first is not racing early input.
 */
export class Renderer {
  #native: NativeTuiRenderer;
  #keyHandlers = new Set<KeyHandler>();
  #resizeHandlers = new Set<ResizeHandler>();
  #focusHandlers = new Set<FocusHandler>();
  #mouseHandlers = new Set<MouseHandler>();
  #pasteHandlers = new Set<PasteHandler>();
  #events = new TernEventStream();
  #streamStarted = false;
  #destroyed = false;
  /** Whether a coalesced frame (see {@link requestFrame}) is currently
   * scheduled — the pending-frame flag the coalescing dedupe keys on. */
  #framePending = false;
  /** The callbacks queued behind the pending coalesced frame, in call order. */
  #frameCallbacks: Array<() => void> = [];
  /** The macrotask handle of the pending coalesced frame, or `null`. */
  #frameTimer: ReturnType<typeof setTimeout> | null = null;

  /** The scene root. Attach content under it with `Node.addChild`. */
  readonly root: Node;

  /** @internal — use `createRenderer`. */
  constructor(options: CreateRendererOptions = {}) {
    const addon = loadAddon();
    const nativeOptions: TuiRendererOptions = {
      exit_on_ctrl_c: options.exitOnCtrlC ?? false,
      use_alt_screen: options.useAltScreen ?? true,
    };
    if (options.title !== undefined) nativeOptions.title = options.title;
    this.#native = new addon.TuiRenderer(nativeOptions);
    this.root = Node.wrapRoot(this.#native.root());
  }

  /**
   * The terminal's color capabilities: `{ truecolor, colors }` — whether
   * 24-bit RGB is supported, and the palette size (16_777_216 for
   * truecolor, 256, 16, or 0). Detected once by the native backend.
   */
  get capabilities(): RendererCapabilities {
    return this.#native.capabilities;
  }

  /**
   * The number of bytes the most recent `render()` flush wrote to the
   * terminal: the ANSI escape-sequence stream for that frame's diff (0 for
   * a fully suppressed empty-diff frame). Fed by the backend queue on the
   * native side; a no-op fast-path render (scene unchanged) never flushes,
   * so the counter keeps the previous flush's value until the next real
   * flush. The byte-cost measure behind the bench's flushed-bytes-per-frame
   * numbers.
   */
  get lastFlushBytes(): number {
    // The native counter is a u64 surfaced as bigint; the byte counts are
    // frame-sized (~KB per flush), far inside number's safe range.
    return Number(this.#native.last_flush_bytes);
  }

  /**
   * Set the terminal window title (OSC 0). Throws on a destroyed renderer.
   */
  setTitle(title: string): void {
    this.#native.set_title(title);
  }

  /**
   * The terminal size as `{ width, height }` in cells: the viewport the most
   * recent `render()` or `snapshotFrame()` painted at (80×24 before any
   * paint). Before the first paint the native side reports the current
   * terminal size (one probe through its cached-size machinery), so a fresh
   * renderer never surfaces the synthetic fallback. Equivalent to the
   * `width`/`height` the native layer paints the next frame at — a resize
   * event's `{ width, height }` lands here once the next render paints at
   * it. Throws on a destroyed renderer.
   */
  get size(): { width: number; height: number } {
    return this.#native.size;
  }

  /**
   * Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
   * BEL`, the payload being the text's UTF-8 bytes base64-encoded per
   * RFC 4648). The terminal emulator must support OSC 52 (xterm, kitty,
   * foot, WezTerm, iTerm2, ...; tmux forwards it when `set-clipboard` is
   * enabled). Throws on a destroyed renderer.
   */
  setClipboard(text: string): void {
    this.#native.set_clipboard(text);
  }

  /**
   * Set the selection overlay to the inclusive rectangle spanned by
   * (`col1`, `row1`) and (`col2`, `row2`) in viewport cells. The endpoints
   * are normalized by the compositor, so either may be the top-left. The
   * overlay is applied at the next `render()` (which the selection edit
   * forces) and to the next `snapshotFrame()`. Per-renderer state — the
   * shared scene never carries the selection. Throws on a destroyed
   * renderer.
   */
  setSelection(col1: number, row1: number, col2: number, row2: number): void {
    this.#native.set_selection(col1, row1, col2, row2);
  }

  /**
   * Clear the selection overlay: the next render paints without any
   * reversed selection cells (and the next snapshot omits the overlay).
   * Throws on a destroyed renderer.
   */
  clearSelection(): void {
    this.#native.clear_selection();
  }

  /**
   * The text of the renderer's current selection, extracted from the last
   * painted frame (the frame the most recent `render()` produced):
   * row-major and cluster/mask-aware — a multi-char cluster (ZWJ emoji,
   * combining sequence, flag) contributes its whole symbol, a masked
   * continuation cell contributes nothing, and rows are joined with
   * `'\n'`. An empty string when no selection is set or nothing has been
   * rendered yet. Throws on a destroyed renderer.
   */
  selectionText(): string {
    return this.#native.selection_text();
  }

  /**
   * The inclusive cell range of the contiguous non-whitespace run (word)
   * containing (`col`, `row`) in the last painted frame, or `null` when
   * the cell is blank/whitespace (or out of bounds, or nothing has been
   * rendered yet). Cluster-aware: a masked continuation cell (the right
   * half of a wide glyph) is treated as part of its glyph's run — never as
   * whitespace — so a click on a wide character's second column still
   * returns the word that contains the glyph. Throws on a destroyed
   * renderer.
   */
  selectionWordRange(col: number, row: number): SelectionRange | null {
    return this.#native.selection_word_range(col, row);
  }

  /**
   * The live stream of terminal events (`TernEventJs` tagged union), pushed
   * from the native event loop after `startEventStream()`. Subscribe with
   * `for await (const event of renderer.events)` — the reconciler's
   * replacement for the old `pollEvents` loop. The stream yields every
   * delivered event in order, without loss, and closes when the renderer is
   * destroyed.
   */
  get events(): AsyncIterable<TernEventJs> {
    return this.#events;
  }

  /**
   * Begin push-based input delivery (roadmap Phase 3): the native binding
   * spawns its background event loop and delivers every terminal event to
   * the JS thread through a ThreadsafeFunction — following Node's error-first
   * callback convention, so the callback's first argument is always null —
   * feeding the `events` iterable and the `on*` handler sets. Idempotent; a
   * no-op once started. A no-op on a destroyed renderer.
   */
  startEventStream(): void {
    if (this.#streamStarted || this.#destroyed) return;
    this.#native.start_event_stream((_err, event) => {
      if (event !== undefined) this.#onNativeEvent(event);
    });
    this.#streamStarted = true;
  }

  /** The native push callback: enqueue + dispatch to the `on*` handlers. */
  #onNativeEvent(event: TernEventJs): void {
    if (this.#destroyed) return;
    this.#events.push(event);
    switch (event.type) {
      case "key":
        if (event.key !== undefined) {
          for (const handler of this.#keyHandlers) handler(event.key);
        }
        break;
      case "resize":
        if (event.width !== undefined && event.height !== undefined) {
          const size = { width: event.width, height: event.height };
          for (const handler of this.#resizeHandlers) handler(size);
        }
        break;
      case "focus":
        if (event.focus_gained !== undefined) {
          const focus = { focus_gained: event.focus_gained };
          for (const handler of this.#focusHandlers) handler(focus);
        }
        break;
      case "mouse":
        if (event.mouse !== undefined) {
          for (const handler of this.#mouseHandlers) handler(event.mouse);
        }
        break;
      case "paste":
        if (event.paste !== undefined) {
          for (const handler of this.#pasteHandlers) handler(event.paste);
        }
        break;
    }
  }

  /** Paint the shared scene to the terminal (minimal diff vs the last frame).
   *
   * Stays synchronous and immediate. An explicit paint supersedes a pending
   * coalesced frame (see {@link requestFrame}): the scheduled frame is
   * canceled — the scene was just painted in full — and any callbacks queued
   * for it run right after this paint, since they are promised to run once a
   * native render completes and this is one. With no frame pending, this is
   * exactly the native call, unchanged from a direct render.
   */
  render(): void {
    const callbacks = this.#frameCallbacks;
    this.#cancelFrame();
    this.#native.render();
    for (const callback of callbacks) callback();
  }

  /**
   * Schedule a coalesced native render on the next macrotask
   * (`setTimeout(0)`, falling back to `queueMicrotask` when timers are
   * unavailable). Several `requestFrame` calls within one tick collapse into
   * a single native `render()` — the pending-frame flag dedupes the schedule
   * — so a burst of scene mutations repaints once instead of once per call.
   * The optional `callback` runs after the native render completes (every
   * call's callback, in call order). An explicit {@link render} while a
   * coalesced frame is pending paints immediately and supersedes it, running
   * the queued callbacks right after its own paint.
   *
   * Returns a cancel function that aborts a still-pending frame: the
   * scheduled render never fires and its queued callbacks are dropped. A
   * no-op once the frame has fired (or was already canceled).
   */
  requestFrame(callback?: () => void): () => void {
    this.#scheduleFrame(callback);
    return () => this.#cancelFrame();
  }

  /**
   * The shared coalescing core: queue `callback` (if any) behind the pending
   * frame and arm one for the next macrotask unless a frame is already
   * pending. Both the schedule path (arming a fresh frame) and the coalesce
   * path (a frame is already armed) go through here, so the pending-frame
   * flag is the single source of truth for the dedupe.
   */
  #scheduleFrame(callback?: () => void): void {
    if (callback !== undefined) this.#frameCallbacks.push(callback);
    if (this.#framePending) return;
    this.#framePending = true;
    const run = () => {
      // The flag may have been cleared by a cancel (or a superseding
      // `render()`) while this task sat in the queue — only reachable via
      // the `queueMicrotask` fallback, since a canceled timer never fires.
      if (!this.#framePending) return;
      this.#frameTimer = null;
      this.#framePending = false;
      this.#native.render();
      const callbacks = this.#frameCallbacks;
      this.#frameCallbacks = [];
      for (const callback of callbacks) callback();
    };
    if (typeof setTimeout === "function") {
      this.#frameTimer = setTimeout(run, 0);
    } else {
      queueMicrotask(run);
    }
  }

  /** Cancel a still-pending coalesced frame, dropping its queued callbacks.
   * No-op when no frame is pending. */
  #cancelFrame(): void {
    if (!this.#framePending) return;
    this.#framePending = false;
    if (this.#frameTimer !== null) {
      clearTimeout(this.#frameTimer);
      this.#frameTimer = null;
    }
    this.#frameCallbacks = [];
  }

  /**
   * Paint the shared scene into a fresh buffer at the given viewport —
   * `width`/`height` in cells, each defaulting to the most recent
   * `render`'s terminal size — and return the frame as one string per row.
   * Masked/continuation cells (the zero-width right halves of wide glyphs)
   * are spaces, so every row has exactly `width` display columns
   * (multi-width aware). Performs no terminal I/O: the result is a pure
   * snapshot for testing and golden comparisons (see {@link framesEqual}).
   */
  snapshotFrame(width?: number, height?: number): string[] {
    return this.#native.render_to_buffer(width, height);
  }

  /**
   * The scene node ids covering the cell at (`col`, `row`), innermost
   * (topmost) first, then each ancestor that also covers the cell. The scene
   * root is never reported; a cell no node covers yields `[]`. Z-order and
   * clip/scroll regions match what `render()` paints, so a click at a mouse
   * event's `column`/`row` routes to the node that is visually on top.
   *
   * Node ids are u64 and surface as `bigint`.
   */
  hit_test(col: number, row: number): bigint[] {
    return this.#native.hit_test(col, row);
  }

  /**
   * Register a handler invoked for every key event delivered by the push
   * event stream. The handler receives the `KeyEvent` payload. Returns an
   * unsubscribe function.
   */
  onKey(handler: KeyHandler): () => void {
    this.#keyHandlers.add(handler);
    return () => this.#keyHandlers.delete(handler);
  }

  /**
   * Register a handler invoked when the terminal is resized. The handler
   * receives the new size as `{ width, height }`. Returns an unsubscribe
   * function.
   */
  onResize(handler: ResizeHandler): () => void {
    this.#resizeHandlers.add(handler);
    return () => this.#resizeHandlers.delete(handler);
  }

  /**
   * Register a handler invoked when the terminal window gains or loses focus.
   * The handler receives `{ focus_gained }` — `true` when focus was gained,
   * `false` when it was lost. Returns an unsubscribe function.
   */
  onFocus(handler: FocusHandler): () => void {
    this.#focusHandlers.add(handler);
    return () => this.#focusHandlers.delete(handler);
  }

  /**
   * Register a handler invoked for every mouse event delivered by the push
   * event stream. The handler receives the `MouseEventJs` payload. Returns an
   * unsubscribe function.
   */
  onMouse(handler: MouseHandler): () => void {
    this.#mouseHandlers.add(handler);
    return () => this.#mouseHandlers.delete(handler);
  }

  /**
   * Register a handler invoked for every paste event delivered by the push
   * event stream. The handler receives the pasted text string. Returns an
   * unsubscribe function.
   */
  onPaste(handler: PasteHandler): () => void {
    this.#pasteHandlers.add(handler);
    return () => this.#pasteHandlers.delete(handler);
  }

  /**
   * Leave the alternate screen and raw mode, restoring the terminal, and stop
   * the push event stream. Safe to call more than once.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // A pending coalesced frame must not fire after teardown: the native
    // renderer throws once destroyed, and the queued macrotask would call
    // `render()` on it.
    this.#cancelFrame();
    this.#events.close();
    this.#native.destroy();
  }

  /** Whether the renderer has been destroyed (explicitly or via Ctrl+C). */
  get destroyed(): boolean {
    return this.#destroyed || this.#native.destroyed;
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
 * for await (const event of renderer.events) {
 *   // push-delivered tagged TernEventJs events (no polling loop)
 * }
 * renderer.destroy();
 * ```
 */
export function createRenderer(options: CreateRendererOptions = {}): Renderer {
  return new Renderer(options);
}

/**
 * Whether two snapshot frames (from {@link Renderer.snapshotFrame}) are
 * identical: the same number of rows, each row string equal. Frames are
 * row-aligned by construction — every row has exactly the viewport width —
 * so plain string comparison is the full equality contract.
 */
export function framesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
