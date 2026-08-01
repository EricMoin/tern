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
 * - `createElement(type)`        -> tern node factory (`Box`/`Text`/`StreamingText`)
 * - `createTextNode(value)`      -> `Text` node
 * - `replaceText`/`isTextNode`   -> text content re-point / type check
 * - `insertNode`/`removeNode`    -> tree ops (`Node.insertBefore`/`Node.addChild` / `Node.remove`)
 * - `replaceNode` (convenience)  -> position-accurate in-parent replacement
 * - `setProperty`                -> `Node.setProps` (feeds the runtime's `setProp`/`spread`)
 * - `getParentNode`/`getFirstChild`/`getNextSibling` -> tree traversal
 *   (best-effort: @tern/core `Node` does not track parents or siblings yet,
 *   so a `WeakMap` registry records parents as nodes are inserted)
 *
 * Anchor-based insertion and position-accurate replacement are wired;
 * reactive diffing against the native scene is deferred to post-MVP.
 *
 * The universal renderer is vendored (`./universal.ts`) because Deno/Node
 * resolve the bare `solid-js` specifier to its *server* build (no reactive
 * runtime); the vendored copy's `solid-js` import resolves through the
 * package import map (deno.json) to the client build, so signal-driven
 * updates actually reach the scene ops.
 */

import {
  createRenderer,
  type RendererOptions,
} from "./universal.ts";
import {
  Box as TernBox,
  Text as TernText,
  StreamingText as TernStreamingText,
  type Node,
  type NodeProps,
  type Span,
} from "@tern/core";

export const name = "@tern/solid";
export const version = "0.1.0";

export type { Node, NodeProps, Span } from "@tern/core";

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
 * parent/sibling links, so `insertNode` records the parent here and the
 * traversal callbacks read from it. Entries are removed on `removeNode`.
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
      default:
        throw new Error(
          `@tern/solid: unknown element type "${tag}" (expected "box", "text", or "streaming_text")`,
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

  /** `removeNode` -> tree op. Detaches the node's subtree from the scene. */
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
 * Note: @tern/core's `Node.remove()` never splices the parent's children
 * list (a core limitation), so after replacement the replaced node's entry
 * remains in `parent.children` — the scene (native handles) and the parent
 * registry reflect the replacement, the children snapshot does not.
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
