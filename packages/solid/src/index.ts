/**
 * @tern/solid — SolidJS custom renderer for tern.
 *
 * Wires `createRenderer` from the vendored solid-js universal renderer
 * (see `./universal.ts`) with a `RendererOptions` object over the @tern/core
 * scene API. The options literal carries exactly the canonical solid-js
 * 1.9.14 `RendererOptions` key set (see
 * node_modules/solid-js/universal/types/universal.d.ts:1-12 and the
 * solidjs/solid universal README): createElement, createTextNode,
 * replaceText, isTextNode, setProperty, insertNode, removeNode,
 * getParentNode, getFirstChild, getNextSibling — nothing more. The
 * renderer's returned `setProp` is supplied by solid's runtime from the
 * canonical `setProperty`, and in-parent replacement (`replaceNode`) is
 * exposed as a standalone convenience helper below rather than as an
 * options key:
 *
 * - `createElement(type)`        -> tern node factory (`Box`/`Text`/`StreamingText`
 *   and the roadmap elements `Input`/`Spinner`/`StatusBar`/`Panels`)
 * - `createTextNode(value)`      -> `Text` node
 * - `replaceText`/`isTextNode`   -> text content re-point / type check
 * - `insertNode`/`removeNode`    -> tree ops (`Node.insertBefore`/`Node.addChild` / `Node.remove`)
 * - `replaceNode` (convenience)  -> position-accurate in-parent replacement
 * - `setProperty`                -> `Node.setProps` (feeds the runtime's `setProp`/`spread`)
 * - `getParentNode`/`getFirstChild`/`getNextSibling` -> tree traversal
 *   (best-effort: @tern/core `Node` exposes `children` but no parent/sibling
 *   accessors, so a `WeakMap` registry records parents as nodes are inserted)
 *
 * Anchor-based insertion and position-accurate replacement are wired;
 * reactive diffing against the native scene is deferred to post-MVP.
 *
 * The universal renderer is vendored (`./universal.ts`) because Deno/Node
 * resolve the bare `solid-js` specifier to its *server* build (no reactive
 * runtime); the vendored copy's `solid-js` import resolves through the
 * package import map (deno.json) to the client build, so signal-driven
 * updates actually reach the scene ops.
 *
 * The roadmap element factories (`Input`/`Spinner`/`StatusBar`/`Panels`)
 * materialize the @tern/core factories of the same name, matching what the
 * `@tern/react` host components map to (feature parity): same props -> same
 * scene node structure. `subscribeInput` wires a renderer's key events
 * through the core `FocusManager` (the Solid-flavored `useInput` equivalent —
 * Solid has no context, so the renderer is an explicit argument).
 */

import {
  createRenderer,
  type RendererOptions,
} from "./universal.ts";
import {
  Box as TernBox,
  Input as TernInput,
  Panels as TernPanels,
  Spinner as TernSpinner,
  StatusBar as TernStatusBar,
  StreamingText as TernStreamingText,
  Text as TernText,
  focusManager,
  FocusManager,
  type InputProps,
  type KeyHandler,
  type Node,
  type NodeProps,
  type PanelsProps,
  type Renderer,
  type Span,
  type SpinnerProps,
  type StatusBarProps,
} from "@tern/core";

export const name = "@tern/solid";
export const version = "0.1.0";

// The @tern/core types the factories and focus wiring expose, re-exported so
// consumers can type elements, props, focus handles and input handlers without
// importing @tern/core directly (the same surface @tern/react re-exports).
export type {
  FocusHandle,
  InputProps,
  KeyEvent,
  KeyHandler,
  Node,
  NodeProps,
  PanelSpec,
  PanelsProps,
  Renderer,
  Span,
  SpinnerProps,
  StatusBarProps,
  StatusBarSegment,
} from "@tern/core";

// The @tern/core values behind the roadmap elements and the focus wiring:
// element edit/drive helpers and the focus machinery.
export {
  collapsePanel,
  editKey,
  expandPanel,
  focusManager,
  focusPanel,
  FocusManager,
  tick,
  togglePanel,
  useFocus,
} from "@tern/core";

/**
 * Apply a single prop to a tern scene node. @tern/core's `Node.setProps`
 * replaces the whole prop map, so each write merges over the node's current
 * props. This is the single funnel behind the options' `setProperty` and,
 * transitively, the renderer's returned `setProp`/`spread`.
 */
function applyProp(node: Node, prop: string, value: unknown): void {
  node.setProps({ ...node.props, [prop]: value });
}

/**
 * Best-effort parent registry. @tern/core `Node` exposes `children` but no
 * parent/sibling accessors (its `#parent` link is private), so `insertNode`
 * records the parent here and the traversal callbacks read from it. Entries
 * are dropped on `removeNode`; the children lists themselves are kept in sync
 * by @tern/core's `Node.remove()`, which splices the removed node out of its
 * parent's `children` list.
 */
const parentMap = new WeakMap<Node, Node>();

/**
 * The `RendererOptions<Node>` object handed to `createRenderer`
 * (`solid-js/universal`). Every tree mutation funnels into the @tern/core
 * `Node` API.
 *
 * The literal exposes exactly the canonical solid-js 1.9.14
 * `RendererOptions` key set (see
 * node_modules/solid-js/universal/types/universal.d.ts:1-12): createElement,
 * createTextNode, replaceText, isTextNode, setProperty, insertNode,
 * removeNode, getParentNode, getFirstChild, getNextSibling. The two
 * tern-side aliases the skeleton used to carry (`setProp`, `replaceNode`)
 * are gone: solid's runtime derives `setProp` from `setProperty`, and
 * `replaceNode` is a standalone convenience exported below (it is not part
 * of solid's interface). The literal is annotated with the interface type so
 * non-canonical keys are rejected at compile time.
 */
const options: RendererOptions<Node> = {
  /** `createElement(type)` -> tern node factory. */
  createElement(tag: string): Node {
    switch (tag) {
      case "box":
        return TernBox();
      case "text":
        return TernText();
      case "streaming_text":
        return TernStreamingText();
      case "input":
        return TernInput();
      case "spinner":
        return TernSpinner();
      case "status_bar":
        return TernStatusBar();
      case "panels":
        // `panels` is the one required prop of the core factory; an empty
        // spec list yields a valid, empty stack.
        return TernPanels({ panels: [] });
      default:
        throw new Error(
          `@tern/solid: unknown element type "${tag}" (expected "box", "text", "streaming_text", "input", "spinner", "status_bar", or "panels")`,
        );
    }
  },

  /** `createTextNode(value)` -> `Text` node. */
  createTextNode(value: string): Node {
    return TernText({ text: value });
  },

  /** Text nodes are tern `text` nodes. */
  isTextNode(node: Node): boolean {
    return node.type === "text";
  },

  /** Re-point a text node's content. */
  replaceText(textNode: Node, value: string): void {
    applyProp(textNode, "text", value);
  },

  /**
   * `setProperty` -> `Node.setProps`. The canonical v1.9+ universal key; the
   * renderer's returned `setProp` and `spread` both funnel through here.
   */
  setProperty<T>(node: Node, name: string, value: T, _prev?: T): void {
    applyProp(node, name, value);
  },

  /**
   * `insertNode` -> tree op, anchor-accurate.
   *
   * With a non-null `anchor` the node is inserted immediately before it via
   * `Node.insertBefore` (the @tern/core equivalent of the DOM
   * `parent.insertBefore(node, anchor)` the solid-js universal docs use);
   * without an anchor the node is appended via `Node.addChild`. The parent
   * registry is updated so traversal callbacks work.
   *
   * Note: solid's array reconciliation can re-insert an already-present
   * child (a move), which @tern/core's `insertBefore` rejects — true move
   * semantics need a native scene move op and are post-MVP.
   */
  insertNode(parent: Node, node: Node, anchor?: Node): void {
    parentMap.set(node, parent);
    if (anchor != null) {
      parent.insertBefore(node, anchor);
    } else {
      parent.addChild(node);
    }
  },

  /**
   * `removeNode` -> tree op. Detaches the node's subtree from the scene and
   * keeps the local bookkeeping consistent: the registry entry is dropped
   * first (so `getParentNode` stops resolving the node even when the core
   * remove no-ops), then `Node.remove()` splices the node out of its
   * parent's `children` list — so `getFirstChild`/`getNextSibling` skip
   * removed nodes and stay correct after removals.
   */
  removeNode(_parent: Node, node: Node): void {
    parentMap.delete(node);
    node.remove();
  },

  /** Parent lookup from the insert-time registry. */
  getParentNode(node: Node): Node | undefined {
    return parentMap.get(node);
  },

  /** First child of a scene node (or `undefined` when empty). */
  getFirstChild(node: Node): Node | undefined {
    return node.children[0];
  },

  /** Next sibling within the recorded parent's children. */
  getNextSibling(node: Node): Node | undefined {
    const parent = parentMap.get(node);
    if (parent === undefined) return undefined;
    const siblings = parent.children;
    const index = siblings.indexOf(node);
    return index >= 0 ? siblings[index + 1] : undefined;
  },
};

/**
 * Position-accurate in-parent replacement convenience. NOT a solid-js
 * `RendererOptions` key — the v1.9.14 interface has no `replaceNode`; solid's
 * runtime performs its own internal replacement as `insertNode(parent,
 * newNode, oldNode)` followed by `removeNode(parent, oldNode)` (see
 * node_modules/solid-js/universal/dist/universal.js:184-187). This helper
 * mirrors that canonical sequence on the module surface:
 *
 * `node` is inserted immediately before `replacedNode` (anchor-accurate, via
 * the options' `insertNode`), then `replacedNode` is detached. The new node
 * is registered under the replaced node's recorded parent and occupies the
 * replaced node's slot in `parent.children`. When the replaced node has no
 * recorded parent this is a no-op — there is nowhere to place the new node.
 * `node` must not already be a child of that parent (same constraint as
 * `Node.insertBefore`).
 *
 * @tern/core's `Node.remove()` splices the removed node out of its parent's
 * `children` list, so the replacement is fully reflected in the local
 * bookkeeping: after the swap, `parent.children` holds the new node exactly
 * where the replaced node was, and the traversal callbacks
 * (`getFirstChild`/`getNextSibling`) agree with the scene.
 */
export function replaceNode(node: Node, replacedNode: Node): void {
  if (node === replacedNode) return;
  const parent = parentMap.get(replacedNode);
  if (parent === undefined) return;
  options.insertNode(parent, node, replacedNode);
  parentMap.delete(replacedNode);
  replacedNode.remove();
}

/**
 * The configured universal renderer. `render(code, node)` mounts a scene under
 * `node`; the destructured primitives below are the standard custom-renderer
 * surface (same shape solid-js/universal exports for its own DOM renderer).
 */
const renderer = createRenderer(options);

/**
 * The `RendererOptions` object wired into `createRenderer` above, exported so
 * tests (and embedders) can exercise the tree-op callbacks directly —
 * `replaceText`, `isTextNode`, `setProperty`, `insertNode` (with anchor),
 * `getParentNode`/`getFirstChild`/`getNextSibling` are reachable only
 * through the options object, not the renderer surface. It carries exactly
 * the canonical solid-js 1.9.14 `RendererOptions` key set — nothing more.
 */
export { options as rendererOptions };

export { renderer };

export const {
  render,
  insert,
  spread,
  createElement,
  createTextNode,
  insertNode,
  setProp,
  mergeProps,
  effect,
  memo,
  createComponent,
  use,
} = renderer;

/**
 * Create a `box` scene node through the solid renderer. Props (including
 * static `children` nodes) are applied via the renderer's `spread`, which
 * funnels into `Node.setProps` (props) and `Node.addChild`/`Node.insertBefore`
 * (children).
 */
export function Box(props: NodeProps = {}): Node {
  const node = createElement("box");
  spread(node, props);
  return node;
}

/**
 * Create a `text` scene node through the solid renderer. Props (e.g.
 * `{ text: "hi" }`) are applied via the renderer's `spread`.
 */
export function Text(props: NodeProps = {}): Node {
  const node = createElement("text");
  spread(node, props);
  return node;
}

/**
 * Create a `streaming_text` scene node through the solid renderer. Props are
 * applied via the renderer's `spread`. The node's stream is fed with
 * `subscribeStream` (or directly via `Node.appendSpan`); spans appended
 * while the node is detached are recorded and flushed to the native handle
 * in call order when the node is attached (see `@tern/core`).
 */
export function StreamingText(props: NodeProps = {}): Node {
  const node = createElement("streaming_text");
  spread(node, props);
  return node;
}

// ---------------------------------------------------------------------------
// Roadmap element factories
//
// These materialize the @tern/core roadmap factories (subtask 3) with the same
// props, giving @tern/solid feature parity with the @tern/react host
// components: same props -> same scene node structure (the @tern/react
// `hostConfig.createInstance` maps the host tags to these same core factories
// — see packages/react/src/reconciler.ts). Unlike the primitives above, they
// call the core factories directly with the full props rather than
// `createElement` + `spread`: the composition (an input's text leaf, a
// spinner's rendered text, a status bar's segment children, a panels element's
// panel boxes) is derived *at creation* from the full props, and `setProps`
// (what `spread` funnels into) cannot rebuild it. `createElement` with the
// roadmap tags still materializes the core factories — as empty elements, for
// the renderer surface — but stateful elements are built with these
// factories.
// ---------------------------------------------------------------------------

/**
 * Create an `input` scene node: the core `Input` factory materialized with
 * `props` — a framed box with a text leaf carrying the value and caret (and
 * a dim placeholder when the value is empty). Edit it with `editKey` (the
 * focused-element handler wired by `useFocus` + `subscribeInput`).
 */
export function Input(props: InputProps = {}): Node {
  return TernInput(props);
}

/**
 * Create a `spinner` scene node: the core `Spinner` factory materialized with
 * `props` — a text leaf rendering a determinate `'▓'`/`'░'` progress bar
 * (from `value`/`max`/`width`) or an indeterminate frame glyph (from
 * `frames`/`frame`). Advance it with `tick` on an interval.
 */
export function Spinner(props: SpinnerProps = {}): Node {
  return TernSpinner(props);
}

/**
 * Create a `status_bar` scene node: the core `StatusBar` factory materialized
 * with `props` — a single-row flex strip whose children are the left/center/
 * right segment `Text` nodes. The segment keys are lifted out of the strip's
 * props by the core factory.
 */
export function StatusBar(props: StatusBarProps = {}): Node {
  return TernStatusBar(props);
}

/**
 * Create a `panels` scene node: the core `Panels` factory materialized with
 * `props` — a flex stack of panel boxes, each with a header `Text` and a body
 * node (the active panel's header is bold). Manage panels with
 * `collapsePanel`/`expandPanel`/`togglePanel`/`focusPanel`.
 */
export function Panels(props: PanelsProps): Node {
  return TernPanels(props);
}

/**
 * Subscribe an `AsyncIterable<Span>` to a `streaming_text` node.
 *
 * Consumes `stream` in the background, appending each span to `node` via
 * `Node.appendSpan` as it arrives. Spans appended while the node is detached
 * are recorded and flushed to the native handle on attach.
 *
 * Returns a disposer that cancels the subscription. It marks the pump
 * stopped and calls `return()` on the active iterator, so generators
 * suspended at a yield point terminate promptly (their `finally` blocks run)
 * and the pump's pending `next()` settles. Note that an async generator
 * parked on an internal `await` only processes `return()` once it next
 * suspends at a yield; spans it produces after disposal are dropped, never
 * appended — the disposer guarantees no further appends regardless.
 *
 * A source error ends the subscription quietly (no unhandled rejection);
 * spans already appended remain on the node.
 */
export function subscribeStream(
  node: Node,
  stream: AsyncIterable<Span>,
): () => void {
  let cancelled = false;
  let iterator: AsyncIterator<Span> | undefined;

  const pump = async (): Promise<void> => {
    try {
      iterator = stream[Symbol.asyncIterator]();
      while (!cancelled) {
        const result = await iterator.next();
        if (result.done) break;
        node.appendSpan(result.value.text, result.value.style);
      }
    } catch {
      // A source error ends the subscription; nothing further to append.
    } finally {
      iterator = undefined;
    }
  };

  void pump();

  return () => {
    cancelled = true;
    iterator?.return?.();
  };
}

// ---------------------------------------------------------------------------
// Input / focus routing
// ---------------------------------------------------------------------------

/** Options for {@link subscribeInput}. */
export interface SubscribeInputOptions {
  /** When `false`, the subscription is not established (default `true`). */
  isActive?: boolean;
  /**
   * The `FocusManager` consulted before the handler: when it routes the key
   * to a focused element (`FocusManager.routeKey` returns `true`), the
   * handler is skipped. Defaults to the core `focusManager`.
   */
  focusManager?: FocusManager;
}

/**
 * Subscribe `handler` to a renderer's key events, routing each key through
 * the core `FocusManager` first — the Solid-flavored `useInput` equivalent.
 * Solid has no React-style context, so the renderer is an explicit argument
 * (the `@tern/react` `useInput` reads it from the tree context instead).
 *
 * Each key is first routed via `manager.routeKey(event)`: when the manager
 * dispatches it to a focused element's handler (an element registered with
 * `useFocus(id, node, onKey, manager)`, e.g. an `Input` node edited through
 * `editKey`), the tree-level `handler` is skipped. Only keys no focused
 * element handles reach `handler`. The handler is captured at subscribe time;
 * Solid closures over signal getters stay live because the getters are read
 * at dispatch time.
 *
 * Returns a disposer that unsubscribes (and is a no-op when `isActive` is
 * `false`). To reactivate a deactivated subscription, call `subscribeInput`
 * again.
 */
export function subscribeInput(
  renderer: Renderer,
  handler: KeyHandler,
  options: SubscribeInputOptions = {},
): () => void {
  if (options.isActive === false) return () => {};
  const manager = options.focusManager ?? focusManager;
  return renderer.onKey((event) => {
    // A focused element's key handler wins; otherwise fall back to the
    // tree-level handler.
    if (manager.routeKey(event)) return;
    handler(event);
  });
}
