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
 * - `Input` / `Spinner` / `StatusBar` / `Panels` are roadmap element
 *   factories that compose the primitive kinds into richer widgets (all
 *   editing/caret math stays in the element, the Rust compositor paints it),
 *   and a `FocusManager` (with a `useFocus` helper) routes key events to the
 *   focused element's key handler.
 * - `Renderer` owns the render/input loop: `render()`, `pollEvents()`,
 *   `onKey(cb)`, `onResize(cb)`, `onFocus(cb)`, `onMouse(cb)` and
 *   `destroy()`. `pollEvents()` returns the native events as a tagged
 *   `TernEventJs` union (`"key"` / `"resize"` / `"focus"` / `"mouse"`).
 *
 * The generated napi types (`KeyEvent`, `MouseEventJs`, `TernEventJs`,
 * `TuiRendererOptions`, `TuiRenderer`, `NodeHandle`) are re-exported from the
 * binding's `index.d.ts` so consumers get the canonical declaration surface.
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
  MouseEventJs,
  NodeHandle,
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "../../../src/bindings/tern-node/index.d.ts";

export const name = "@tern/core";
export const version = "0.1.0";

import type {
  KeyEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
} from "../../../src/bindings/tern-node/index.d.ts";
import { loadAddon } from "./addon.ts";

/**
 * The scene node kinds. `box`/`text`/`streaming_text` are materialized by the
 * binding; `input`/`spinner`/`status_bar`/`panels` are JS-only element kinds
 * that materialize as compositions over the primitive kinds (their root
 * primitive is fixed by {@link NATIVE_KIND}).
 */
export type NodeType =
  | "box"
  | "text"
  | "streaming_text"
  | "input"
  | "spinner"
  | "status_bar"
  | "panels";

/**
 * The native scene node kind each JS element kind materializes as. The
 * binding only knows `box`/`text`/`streaming_text` — the roadmap element
 * kinds are pure JS compositions over those primitives (constitution: no new
 * engine kinds in the binding), so each maps to the root primitive of its
 * composition: an `input` is a framed box, a `spinner` is a text leaf, a
 * `status_bar` / `panels` is a flex box.
 */
const NATIVE_KIND: Record<NodeType, NodeType> = {
  box: "box",
  text: "text",
  streaming_text: "streaming_text",
  input: "box",
  spinner: "text",
  status_bar: "box",
  panels: "box",
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
 */
export function StreamingText(props: NodeProps = {}): Node {
  return Node.create("streaming_text", props);
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
  const panel = Box({ flex_direction: "column" });
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
 * active focus is moved with `focus`/`blur`.
 */
export class FocusManager {
  #entries = new Map<string, Focusable>();
  #active: string | null = null;

  /**
   * Register a focusable element. Returns an unsubscribe function that
   * unregisters it. Registering an id twice replaces the earlier entry.
   */
  register(focusable: Focusable): () => void {
    this.#entries.set(focusable.id, focusable);
    return () => this.unregister(focusable.id);
  }

  /** Unregister `id` (clearing it as active if it was). Returns whether an
   * entry was removed. */
  unregister(id: string): boolean {
    const removed = this.#entries.delete(id);
    if (removed && this.#active === id) this.#active = null;
    return removed;
  }

  /** Whether an element with `id` is registered. */
  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Make `id` the active focus. Returns `false` when it is not registered. */
  focus(id: string): boolean {
    if (!this.#entries.has(id)) return false;
    this.#active = id;
    return true;
  }

  /** Clear the active focus (elements stay registered). */
  blur(): void {
    this.#active = null;
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

/**
 * A terminal-facing renderer. Constructing one enters raw mode + the
 * alternate screen; `destroy()` (or Ctrl+C with `exitOnCtrlC`) restores the
 * terminal. A destroyed renderer cannot render or poll.
 */
export class Renderer {
  #native: NativeTuiRenderer;
  #keyHandlers = new Set<KeyHandler>();
  #resizeHandlers = new Set<ResizeHandler>();
  #focusHandlers = new Set<FocusHandler>();
  #mouseHandlers = new Set<MouseHandler>();

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
   * Block up to `timeoutMs` for input, dispatching each event to the handlers
   * registered with `onKey` / `onResize` / `onFocus` / `onMouse`, and return
   * the tagged events. A burst of events arrives as one batch.
   */
  pollEvents(timeoutMs: number = 50): TernEventJs[] {
    const events = this.#native.poll_events(timeoutMs);
    for (const event of events) {
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
    return events;
  }

  /**
   * Register a handler invoked for every key event returned by `pollEvents`.
   * The handler receives the `KeyEvent` payload. Returns an unsubscribe
   * function.
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
   * Register a handler invoked for every mouse event returned by `pollEvents`.
   * The handler receives the `MouseEventJs` payload. Returns an unsubscribe
   * function.
   */
  onMouse(handler: MouseHandler): () => void {
    this.#mouseHandlers.add(handler);
    return () => this.#mouseHandlers.delete(handler);
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
 * renderer.pollEvents(50); // feeds the on* handlers, returns tagged events
 * renderer.destroy();
 * ```
 */
export function createRenderer(options: CreateRendererOptions = {}): Renderer {
  return new Renderer(options);
}
