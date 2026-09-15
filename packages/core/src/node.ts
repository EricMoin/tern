//! The scene node primitive and the three core element factories.

import { streamScrollStates } from "./markdown.ts";
import { recordThemeHints } from "./theme.ts";
import type { NodeProps, NodeType, Span } from "./types.ts";

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
import { loadAddon } from "./addon.ts";
import type { SemanticsDescriptor } from "./semantics.ts";
/**
 * The native scene node kind each JS element kind materializes as. The
 * binding only knows `box`/`text`/`streaming_text` — the roadmap element
 * kinds are pure JS compositions over those primitives (constitution: no new
 * engine kinds in the binding), so each maps to the root primitive of its
 * composition: an `input` is a framed box, a `spinner` is a text leaf, a
 * `status_bar` / `panels` / `diff` / `select` / `checkbox` / `radio` /
 * `toggle` / `menu` / `table` / `tree` / `tabs` / `progress` / `modal` /
 * `markdown` / `canvas` is a flex box.
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
  checkbox: "box",
  radio: "box",
  toggle: "box",
  menu: "box",
  scroll_view: "box",
  table: "box",
  tree: "box",
  tabs: "box",
  progress: "box",
  modal: "box",
  markdown: "box",
  canvas: "box",
  bar_chart: "box",
  chart: "box",
  sparkline: "box",
};

/**
 * Translate the camelCase aliases (`borderColor` → `border_color`,
 * `hyperlink` → `href`, `underlineStyle` → `underline_style`,
 * `underlineColor` → `underline_color`) to the binding's snake_case style
 * keys before props reach the native layer. Each alias is consumed
 * (stripped), so the node's prop mirror holds the scene-facing key exactly
 * like every other style key (`border_style`, `flex_direction`, ...). An
 * `undefined` alias value is dropped (it has no scene representation,
 * mirroring `setProps`' undefined stripping). The snake_case keys themselves
 * flow through untouched.
 */
function toNativeProps(props: NodeProps): NodeProps {
  if (
    !("borderColor" in props) &&
    !("hyperlink" in props) &&
    !("underlineStyle" in props) &&
    !("underlineColor" in props)
  ) {
    return props;
  }
  const out = { ...props };
  const borderValue = out.borderColor;
  delete out.borderColor;
  if (borderValue !== undefined) out.border_color = borderValue;
  const hrefValue = out.hyperlink;
  delete out.hyperlink;
  if (hrefValue !== undefined) out.href = hrefValue;
  const underlineStyleValue = out.underlineStyle;
  delete out.underlineStyle;
  if (underlineStyleValue !== undefined) {
    out.underline_style = underlineStyleValue;
  }
  const underlineColorValue = out.underlineColor;
  delete out.underlineColor;
  if (underlineColorValue !== undefined) {
    out.underline_color = underlineColorValue;
  }
  return out;
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
  #semantics: SemanticsDescriptor | null;

  /** @internal — use `Text` / `Box` (or `Node.wrapRoot`) to create nodes. */
  private constructor(type: NodeType, props: NodeProps, children: Node[]) {
    this.type = type;
    this.#handle = null;
    // The M4.5 runtime theme engine: consume the semantic hint `resolveTheme`
    // attached to these props (see the theme system section) and record it in
    // the parallel store, so a later `setTheme` can re-resolve this node in
    // place. Pure bookkeeping — the hint symbol is stripped before the props
    // are mirrored, so the node's props and its native calls are untouched.
    recordThemeHints(this, props);
    this.#props = toNativeProps({ ...props });
    this.#children = [...children];
    this.#parent = null;
    this.#attached = false;
    this.#spans = [];
    this.#semantics = null;
  }

  /** @internal — build a detached node object. */
  static create(
    type: NodeType,
    props: NodeProps = {},
    children: Node[] = [],
  ): Node {
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
      this.#ensureHandle().insert_before(
        child.#ensureHandle(),
        anchor.#ensureHandle(),
      );
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
    const next = toNativeProps({ ...props });
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
        for (const [key, value] of changed) {
          this.#handle.set_prop(key, value as never);
        }
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
    // The camelCase aliases (`borderColor` → `border_color`, `hyperlink` →
    // `href`, `underlineStyle` → `underline_style`, `underlineColor` →
    // `underline_color`) route to the snake_case style keys (the
    // scene-facing spellings), exactly like the whole-map path.
    if (key === "borderColor") key = "border_color";
    if (key === "hyperlink") key = "href";
    if (key === "underlineStyle") key = "underline_style";
    if (key === "underlineColor") key = "underline_color";
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
    // The camelCase aliases translate here too: the binding's `append_span`
    // lifts the span style through the same `props_to_style_map` as node
    // props, which recognizes `href` (not `hyperlink`), so the span style is
    // normalized to the scene-facing spellings at ingestion — the recorded
    // and the flushed span agree with what the native layer receives.
    const nativeStyle = style === undefined ? undefined : toNativeProps(style);
    if (this.#attached && this.#handle !== null) {
      this.#handle.append_span(text, nativeStyle);
    } else {
      this.#spans.push(
        nativeStyle === undefined ? { text } : { text, style: nativeStyle },
      );
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
   * Set this node's accessibility semantics (the M4.1 wiring): the ARIA
   * `role` name, optional accessible `label`, active `state` flags, and the
   * `enabled` / `selected` booleans — the write shape the native
   * `set_semantics` accepts.
   *
   * On a detached node the descriptor is recorded and flushed to the native
   * handle when the node is attached to the scene (the same deferred-record
   * + attach-flush pattern as {@link appendSpan}). On an attached node it is
   * pushed to the native handle immediately.
   *
   * Semantics is a best-effort progressive enhancement: when the renderer
   * was constructed without the `semantics` option (the default), the native
   * store is off and the write is dropped — never an error — so wiring
   * semantics never changes painted cell output (the store is a parallel
   * bookkeeping map the compositor never reads).
   */
  setSemantics(descriptor: SemanticsDescriptor): void {
    this.#semantics = descriptor;
    if (this.#attached && this.#handle !== null) {
      Node.#writeSemantics(this.#handle, descriptor);
    }
  }

  /**
   * Remove this node's accessibility semantics. On a detached node the
   * pending descriptor is dropped; on an attached node the native entry is
   * cleared (clearing a node with no entry is a native no-op).
   */
  clearSemantics(): void {
    this.#semantics = null;
    if (this.#attached && this.#handle !== null) {
      this.#handle.clear_semantics();
    }
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
      this.#handle = loadAddon().create_node(
        NATIVE_KIND[this.type],
        this.#props,
      );
    }
    return this.#handle;
  }

  /** Materialize `#children` into the native handle (once). */
  #attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const handle = this.#ensureHandle();
    this.#flushSpans(handle);
    this.#flushSemantics(handle);
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
   * Replay the semantics descriptor recorded while detached onto the
   * now-attached handle — the `#spans` deferred-record counterpart for
   * accessibility semantics. Called from `#attach` only, after the handle is
   * bound into the scene (`add_child`), since the native `set_semantics`
   * errors on a not-yet-bound handle. A node without a recorded descriptor
   * performs no native call.
   */
  #flushSemantics(handle: NativeNodeHandle): void {
    if (this.#semantics !== null) {
      Node.#writeSemantics(handle, this.#semantics);
    }
  }

  /**
   * Push a semantics descriptor to a bound native handle, tolerating a
   * disabled semantics store (the M4.1 opt-in, off by default): when the
   * store is off the native write is rejected, and semantics is best-effort —
   * the write is dropped (nothing can record it), never an error, so wiring
   * semantics cannot break an app that did not opt in. Every other native
   * error (a detached / unknown node) propagates.
   */
  static #writeSemantics(
    handle: NativeNodeHandle,
    descriptor: SemanticsDescriptor,
  ): void {
    try {
      handle.set_semantics(descriptor);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("semantics store is disabled")
      ) {
        return;
      }
      throw err;
    }
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
  streamScrollStates.set(node, {
    following: autoScroll,
    autoScrollEnabled: autoScroll,
  });
  return node;
}

