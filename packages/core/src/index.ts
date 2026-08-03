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
 *   flushed to the native handle on attach. A `streaming_text` node defaults
 *   to `autoScroll: true`: `syncStreamTail` (fed by the @tern/react /
 *   @tern/solid stream hosts after each span) pins `scroll_y` to the content
 *   tail vs the `clip_height` viewport, a manual scroll above the tail
 *   detaches, and `followTail` re-attaches.
 * - `Input` / `Spinner` / `StatusBar` / `Panels` / `DiffView` / `Select` /
 *   `ScrollView` / `Table` / `Modal` / `MarkdownView` are roadmap element
 *   factories that compose the primitive kinds into richer widgets (all
 *   editing/caret/selection/scroll math stays in the element, the Rust
 *   compositor paints it), and a
 *   `FocusManager`
 *   (with a `useFocus` helper) routes key events to the focused element's
 *   key handler. `Panels` lays its panels out with a 1-cell gutter between
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
 *   node via the `FocusManager`.
 * - A theme system: `Theme` (a named palette of fg/bg per semantic role plus
 *   per-component style presets), `defaultTheme`, `mergeTheme(base, overrides)`
 *   and `resolveTheme(theme, props)`. Resolution consumes semantic hints
 *   (`role` / `component`) from the props and stamps plain `fg` / `bg` /
 *   `border_style` onto them — the output is ordinary `NodeProps`, so no new
 *   napi surface is introduced (constitution). The `@tern/react` /
 *   `@tern/solid` hosts resolve automatically; raw `@tern/core` users call
 *   `resolveTheme` explicitly at element-creation time.
 * - `Renderer` owns the render/input loop: `render()`, `events` (an
 *   `AsyncIterable` of tagged `TernEventJs` events pushed from the native
 *   thread), `onKey(cb)`, `onResize(cb)`, `onFocus(cb)`, `onMouse(cb)` and
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
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "../../../src/bindings/tern-node/index.d.ts";

export const name = "@tern/core";
export const version = "0.1.0";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
} from "../../../src/bindings/tern-node/index.d.ts";
import { loadAddon } from "./addon.ts";

/**
 * The scene node kinds. `box`/`text`/`streaming_text` are materialized by the
 * binding; `input`/`textarea`/`spinner`/`status_bar`/`panels`/`diff`/`select`/
 * `scroll_view`/`table`/`modal`/`markdown` are JS-only element kinds that
 * materialize as compositions over the primitive kinds (their root primitive
 * is fixed by {@link NATIVE_KIND}).
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
  | "modal"
  | "markdown";

/**
 * The native scene node kind each JS element kind materializes as. The
 * binding only knows `box`/`text`/`streaming_text` — the roadmap element
 * kinds are pure JS compositions over those primitives (constitution: no new
 * engine kinds in the binding), so each maps to the root primitive of its
 * composition: an `input` is a framed box, a `spinner` is a text leaf, a
 * `status_bar` / `panels` / `diff` / `select` / `table` / `markdown` is a
 * flex box.
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
 * span (via {@link syncStreamTail}, which the @tern/react `<StreamingText>`
 * effect and the @tern/solid `subscribeStream` pump call) pins `scroll_y` to
 * the tail offset — the node's `Node.contentSize()` height vs the clip
 * viewport (`clip_height`). A manual scroll above the tail (via
 * {@link scrollTo} / {@link scrollBy} / {@link scrollTop}) detaches the
 * follow and pins the view; {@link followTail} re-attaches. The key is
 * consumed and never reaches the scene props.
 */
export function StreamingText(props: NodeProps = {}): Node {
  const plain = { ...props };
  const autoScroll = plain.autoScroll !== false;
  delete plain.autoScroll;
  const node = Node.create("streaming_text", plain);
  streamScrollStates.set(node, { following: autoScroll });
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
 * The display width of a character in terminal columns, mirroring
 * tern-core's `char_width` (cell.rs:11): 0 for NUL and combining/zero-width
 * marks, 2 for wide (CJK / fullwidth) characters, 1 otherwise.
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
 * The char (code-unit) index whose leading edge sits at (or snaps back
 * before) `column` display columns. Used to translate the caret's display
 * column — the value the compositor paints — into a string index for
 * editing. `column` always lands on a char boundary: a column inside a wide
 * char snaps to that char's start.
 */
function columnToIndex(value: string, column: number): number {
  if (column <= 0) return 0;
  let col = 0;
  for (let i = 0; i < value.length; ) {
    const ch = String.fromCodePoint(value.codePointAt(i) ?? 0);
    const w = charWidth(ch);
    if (col + w > column) return i;
    col += w;
    i += ch.length;
  }
  return value.length;
}

/** The display column of the char boundary at `index` (code units). */
function indexToColumn(value: string, index: number): number {
  let col = 0;
  for (let i = 0; i < index && i < value.length; ) {
    const ch = String.fromCodePoint(value.codePointAt(i) ?? 0);
    col += charWidth(ch);
    i += ch.length;
  }
  return col;
}

/** The last code point fully before `index`, or `null` when `index` is 0. */
function lastCodePointBefore(
  value: string,
  index: number,
): { start: number; len: number; width: number } | null {
  let last: { start: number; len: number; width: number } | null = null;
  for (let i = 0; i < index && i < value.length; ) {
    const ch = String.fromCodePoint(value.codePointAt(i) ?? 0);
    last = { start: i, len: ch.length, width: charWidth(ch) };
    i += ch.length;
  }
  return last;
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
 * two columns). Returns the new `{ value, caret }`.
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
    return { value: next, caret: caret + charWidth(key.char) };
  }
  if (name === "backspace") {
    const prev = lastCodePointBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    const next = value.slice(0, prev.start) + value.slice(prev.start + prev.len);
    return { value: next, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "left") {
    const prev = lastCodePointBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    return { value, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "right") {
    const index = columnToIndex(value, caret);
    const code = value.codePointAt(index);
    if (code === undefined) return { value, caret };
    return { value, caret: caret + charWidth(String.fromCodePoint(code)) };
  }
  if (name === "home") return { value, caret: 0 };
  if (name === "end") return { value, caret: indexToColumn(value, value.length) };
  return { value, caret };
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

/** The total display width of a string in terminal columns. */
function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/**
 * Soft-wrap `line` into display lines of at most `width` columns plus the
 * code-unit index (within `line`) where each display line starts. The JS
 * mirror of the Rust `wrap_line` (token-aware greedy wrap): a whitespace-free
 * token that does not fit on the current display line wraps whole to the next
 * when it can fit there; a token wider than the width hard-breaks across
 * rows; a trailing space at a full display line is dropped (the wrap would
 * collapse it anyway); an embedded `\n` ends the display line. The offsets
 * are exact — a character dropped by the wrap belongs to no display line, so
 * caret navigation stays consistent with what is composed.
 */
function wrapLineWithOffsets(
  line: string,
  width: number | null,
): Array<{ text: string; start: number }> {
  if (width === null) return [{ text: line, start: 0 }];
  const limit = Math.max(1, Math.floor(width));
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
      rows.push({ text: row, start: rowStart });
      row = "";
      rowWidth = 0;
      rowStart = tokenStart;
    }
    // The code-unit index (within `line`) of the current token char.
    let cur = tokenStart;
    for (const ch of token) {
      const w = charWidth(ch);
      if (w === 0) {
        cur += ch.length;
        continue;
      }
      if (rowWidth + w > limit) {
        rows.push({ text: row, start: rowStart });
        row = "";
        rowWidth = 0;
        if (w > limit) {
          cur += ch.length; // a glyph wider than a fresh row is dropped
          rowStart = cur;
          continue;
        }
        rowStart = cur; // the wrapped row starts at this char
      }
      row += ch;
      rowWidth += w;
      cur += ch.length;
    }
    token = "";
  };

  for (const ch of line) {
    if (ch === "\n") {
      flushToken();
      rows.push({ text: row, start: rowStart });
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
  rows.push({ text: row, start: rowStart });
  if (rows.length === 0) rows.push({ text: "", start: 0 });
  return rows;
}

/** The number of display rows `line` occupies at the wrap width (1 when no
 * width is set). */
function wrapCount(line: string, width: number | null): number {
  return width === null ? 1 : wrapLineWithOffsets(line, width).length;
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
 * trails. */
function offsetOfCol(line: string, col: number, width: number | null): number {
  const wrapped = wrapLineWithOffsets(line, width);
  for (let i = 0; i < wrapped.length; i++) {
    if (col <= wrapped[i]!.start + wrapped[i]!.text.length) return i;
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
 * the code-unit index where that display line starts. */
function caretDisplayIn(
  line: string,
  col: number,
  offset: number,
  width: number | null,
): { col: number; start: number } {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ?? { text: "", start: 0 };
  const local = Math.max(0, Math.min(col - entry.start, entry.text.length));
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
 * inside a wide glyph snaps to that glyph's start). */
function charAtDisplayCol(
  line: string,
  offset: number,
  targetCol: number,
  width: number | null,
): number {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ?? { text: "", start: 0 };
  return entry.start + columnToIndex(entry.text, targetCol);
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
      const prev = lastCodePointBefore(line, col);
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
      const code = line.codePointAt(col);
      const len = code === undefined ? 1 : String.fromCodePoint(code).length;
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
      const prev = lastCodePointBefore(line, col);
      return { lines, row, col: prev === null ? 0 : prev.start, changed: prev !== null };
    }
    if (row > 0) return { lines, row: row - 1, col: lines[row - 1]!.length, changed: true };
    return { lines, row, col, changed: false };
  }
  if (name === "right") {
    if (col < line.length) {
      const code = line.codePointAt(col);
      const len = code === undefined ? 1 : String.fromCodePoint(code).length;
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
 * vertical moves). Any other key leaves the textarea unchanged. Returns the
 * new `{ lines, row, col }`.
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

/** Props for the `DiffView` element. `hunks` is consumed by the factory (the
 * line model is JS bookkeeping — it never reaches the scene props, mirroring
 * `Panels`); the remaining style/layout props flow to the root box, which is
 * the scrollable clip region (`scroll_x` / `scroll_y` pan the composed rows).
 */
export interface DiffViewProps extends NodeProps {
  /** The unified-diff lines to render, in scene order. */
  hunks: DiffLine[];
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

/** Build one diff row: a flex row of three text leaves — the dimmed gutter
 * (old/new line numbers), the `+`/`-`/` ` marker, and the line content. */
function buildDiffRow(line: DiffLine, width: number, wrap: boolean | undefined): Node {
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const style = diffKindStyle(line.kind);
  const contentProps: NodeProps = { text: line.text, ...style };
  if (wrap !== undefined) contentProps.wrap = wrap;
  return Box(
    { flex_direction: "row" },
    Text({ text: diffGutterText(line, width), dim: true }),
    Text({ text: marker, ...style }),
    Text(contentProps),
  );
}

/**
 * Create a `diff` element: a column of per-line rows rendering a unified
 * diff. Each hunk line becomes a flex row of three `text` leaves — a dimmed
 * gutter (old/new line numbers, right-aligned to the widest number), a
 * `+`/`-`/` ` marker, and the line content — styled per kind: added lines
 * green (`DIFF_ADD_FG`), deleted lines red (`DIFF_DEL_FG`), context lines
 * dimmed. The root box is the scrollable clip region: `scroll_x` / `scroll_y`
 * pan the whole diff inside it (multiple hunks scroll as one region), and the
 * `wrap` prop passes through to each content leaf. No new napi node kind: the
 * `diff` element materializes as a `box` (constitution).
 */
export function DiffView(props: DiffViewProps): Node {
  const width = diffGutterWidth(props.hunks);
  const rows = props.hunks.map((line) => buildDiffRow(line, width, props.wrap));
  const rootProps: NodeProps = { ...props, flex_direction: "column" };
  const plain = rootProps as Record<string, unknown>;
  delete plain.hunks;
  return Node.create("diff", rootProps, rows);
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

/** The viewport size of a scroll view: its own laid-out rect. */
function scrollableViewport(view: Node): ContentSize {
  return view.contentSize();
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
 * content region (one row leaf per data row) — and its children's extents —
 * a fixed-size scroll view's content overflows its viewport-sized box —
 * floored at the viewport size (so an empty view — or content that fits —
 * measures exactly the viewport and cannot scroll). The scrollbar leaf is
 * excluded: it is a viewport decoration, not content.
 */
function scrollableContentSize(view: Node, viewport: ContentSize): ContentSize {
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
 * the user left it as the stream grows (see {@link followTail} to re-attach).
 * Scrolling to/at the tail keeps the current follow state.
 */
export function scrollTo(view: Node, x: number, y: number): { x: number; y: number } {
  const next = clampScroll(view, x, y);
  const state = streamScrollStates.get(view);
  if (state !== undefined && next.y < maxScroll(view).y) {
    // A manual scroll above the tail detaches the auto-follow; the view
    // stays pinned at the user's position (re-attach is `followTail`).
    state.following = false;
  }
  const props = view.props;
  view.setProps({ ...props, scroll_x: next.x, scroll_y: next.y });
  renderScrollbar(view);
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
// box holding one row leaf per data row. Per-column width/alignment is baked
// into each cell's padded text (display-width aware, never mid-glyph), so
// columns line up regardless of content length. The column/row model is JS
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

/** The display width of `text` in terminal columns (sum of `charWidth`). */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** Truncate `text` to `width` display columns, never splitting a wide glyph
 * (a wide char that would straddle the boundary is dropped). */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (w === 0) continue;
    if (used + w > width) break;
    out += ch;
    used += w;
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

/**
 * Rebuild a table node's children from its current props (the source of
 * truth, mirroring `Select`'s `rebuildSelect`): the header row — sticky when
 * `sticky_header` (a sibling above the content region, at the higher
 * `z_index`), otherwise the region's first child — plus one row leaf per
 * data row, the highlighted row reversed. Runs at creation (seeding the
 * content region with the initial `scroll_y` prop) and after every
 * {@link tableKey} mutation (the region's own `scroll_y` is re-stamped).
 */
function rebuildTable(table: Node, initialScrollY?: number): void {
  const props = table.props as TableProps;
  const columns = tableColumns.get(table) ?? [];
  const rows = tableRows.get(table) ?? [];
  const highlight = typeof props.highlight === "number" ? props.highlight : 0;
  const sticky = props.sticky_header ?? true;

  for (const child of [...table.children]) child.remove();

  const header = buildTableHeader(columns, sticky);
  const rowNodes = rows.map((row, index) => buildTableRow(row, columns, index === highlight));
  const scrollY = initialScrollY ?? tableScrollY(table);
  const regionProps: NodeProps = { flex_direction: "column", scroll_y: scrollY };
  if (typeof props.clip_height === "number") regionProps.clip_height = props.clip_height;

  if (sticky) {
    table.addChild(header);
    const region = Node.create("box", regionProps, rowNodes);
    tableRegions.set(table, region);
    table.addChild(region);
  } else {
    const region = Node.create("box", regionProps, [header, ...rowNodes]);
    tableRegions.set(table, region);
    table.addChild(region);
  }
}

/**
 * Create a `table` element: a flex column of box/text leaves — a header row
 * (sticky by default, painted above the content region at the higher
 * `z_index`; `sticky_header: false` moves it into the scrollable region) and
 * one row leaf per data row with per-column width/alignment (each cell's
 * text padded to the column width, right/center-aligned as declared,
 * overflow truncated never mid-glyph; the highlighted row reversed). The
 * column/row model is JS bookkeeping (never scene props); the interactive
 * state (`highlight`, `scroll_x`, `scroll_y`) lives on the node props. The
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
// following its tail, and `syncStreamTail` — called by the @tern/react
// `<StreamingText>` effect and the @tern/solid `subscribeStream` pump after
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
}

/** The follow states of streaming nodes created with auto-scroll. */
const streamScrollStates = new WeakMap<Node, StreamScrollState>();

/**
 * @internal — register/override a streaming node's auto-scroll follow state.
 * Called by the host factories with the consumed `autoScroll` flag (the
 * `@tern/react` `<StreamingText>` syncs it from its own prop on mount/toggle;
 * the `@tern/solid` `StreamingText` factory passes its consumed flag).
 */
export function setStreamAutoScroll(node: Node, enabled: boolean): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) streamScrollStates.set(node, { following: enabled });
  else state.following = enabled;
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
 * geometry). Call after each `Node.appendSpan`; the @tern/react
 * `<StreamingText>` effect and the @tern/solid `subscribeStream` pump do
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
 * snapping `scroll_y` to the current tail offset immediately. A node that
 * had no follow state (e.g. one built via the raw `Node` constructor) is
 * registered and enabled. On a detached node the snap is deferred until the
 * next `syncStreamTail` after attach.
 */
export function followTail(node: Node): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) streamScrollStates.set(node, { following: true });
  else state.following = true;
  if (node.attached) syncStreamTail(node);
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
}

/**
 * Routes key events to the focused element's key handler. Elements register
 * with `register` (or the {@link useFocus} helper) and become routable; the
 * active focus is moved with `focus`/`blur`, or walked in registration order
 * with `next`/`prev`/`focusFirst`. Focus changes (including blur and the
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
}

/** The default focus manager shared by {@link useFocus} calls that omit one. */
export const focusManager = new FocusManager();

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
 */
export function useFocus(
  id: string,
  node: Node,
  onKey: KeyHandler,
  manager: FocusManager = focusManager,
): FocusHandle {
  manager.register({ id, node, onKey });
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
  #events = new TernEventStream();
  #streamStarted = false;
  #destroyed = false;

  /** The scene root. Attach content under it with `Node.addChild`. */
  readonly root: Node;

  /** @internal — use `createRenderer`. */
  constructor(options: CreateRendererOptions = {}) {
    const addon = loadAddon();
    const nativeOptions = { exit_on_ctrl_c: options.exitOnCtrlC ?? false };
    this.#native = new addon.TuiRenderer(nativeOptions);
    this.root = Node.wrapRoot(this.#native.root());
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
    }
  }

  /** Paint the shared scene to the terminal (minimal diff vs the last frame). */
  render(): void {
    this.#native.render();
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
   * Leave the alternate screen and raw mode, restoring the terminal, and stop
   * the push event stream. Safe to call more than once.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
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
