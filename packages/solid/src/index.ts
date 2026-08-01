/**
 * @tern/solid — SolidJS custom renderer for tern.
 *
 * Wires `createRenderer` from `solid-js/universal` with a dom-expressions
 * `RendererOptions` object over the @tern/core scene API. The options object
 * covers the complete `RendererOptions` key set of solid-js 1.9.14 (see
 * node_modules/solid-js/universal/types/universal.d.ts): createElement,
 * createTextNode, replaceText, isTextNode, setProperty, insertNode,
 * removeNode, getParentNode, getFirstChild, getNextSibling. On top of the
 * real surface it carries two tern-side aliases the runtime ignores —
 * `setProp` (older universal name for the canonical `setProperty`) and
 * `replaceNode` (an in-parent replacement convenience not present in
 * solid's interface):
 *
 * - `createElement(type)`        -> tern node factory (`Box`/`Text`)
 * - `createTextNode(value)`      -> `Text` node
 * - `replaceText`/`isTextNode`   -> text content re-point / type check
 * - `insertNode`/`removeNode`    -> tree ops (`Node.addChild` / `Node.remove`)
 * - `replaceNode` (tern alias)   -> best-effort in-parent replacement
 * - `setProperty` (+ alias `setProp`) -> `Node.setProps`
 * - `getParentNode`/`getFirstChild`/`getNextSibling` -> tree traversal
 *   (best-effort: @tern/core `Node` does not track parents or siblings yet,
 *   so a `WeakMap` registry records parents as nodes are inserted)
 *
 * Full rendering correctness (anchor-based insertion, position-accurate
 * replacement, reactive diffing against the native scene) is deferred to
 * post-MVP; this package currently ships the wired, type-checked skeleton
 * and the public surface consumers need: the renderer primitives plus
 * `Box`/`Text` components.
 */

import {
  createRenderer,
  type RendererOptions,
} from "solid-js/universal";
import {
  Box as TernBox,
  Text as TernText,
  type Node,
  type NodeProps,
} from "@tern/core";

export const name = "@tern/solid";
export const version = "0.1.0";

export type { Node, NodeProps } from "@tern/core";

/**
 * Apply a single prop to a tern scene node. @tern/core's `Node.setProps`
 * replaces the whole prop map, so each write merges over the node's current
 * props. This is the single funnel behind the options' `setProperty`/`setProp`
 * and, transitively, the renderer's returned `spread`.
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
 * The dom-expressions `RendererOptions` object handed to `createRenderer`
 * (`solid-js/universal`). Every tree mutation funnels into the @tern/core
 * `Node` API.
 *
 * Real solid-js 1.9.14 `RendererOptions` key set (see
 * node_modules/solid-js/universal/types/universal.d.ts): createElement,
 * createTextNode, replaceText, isTextNode, setProperty, insertNode,
 * removeNode, getParentNode, getFirstChild, getNextSibling — all present
 * below. The literal additionally carries two tern-side aliases the runtime
 * ignores:
 *
 * - `setProp` — strategy-named alias for the canonical `setProperty`
 *   (older universal API name).
 * - `replaceNode` — tern-side convenience alias replacing a node in its
 *   parent; not part of solid's v1.9.14 `RendererOptions` interface.
 *
 * The literal is intentionally left unannotated so the aliases do not trip
 * excess-property checking; conformance to `RendererOptions<Node>` is
 * enforced by the `createRenderer(options)` call below.
 */
const options = {
  /** `createElement(type)` -> tern node factory. */
  createElement(tag: string): Node {
    switch (tag) {
      case "box":
        return TernBox();
      case "text":
        return TernText();
      default:
        throw new Error(
          `@tern/solid: unknown element type "${tag}" (expected "box" or "text")`,
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
   * Strategy-named alias for `setProperty` (older solid-js universal API used
   * `setProp`; the v1.9.14 canonical key is `setProperty`). The runtime
   * destructures `setProperty` and ignores this key; it is kept so the options
   * object exposes the strategy's contract verbatim.
   */
  setProp<T>(node: Node, name: string, value: T, _prev?: T): void {
    applyProp(node, name, value);
  },

  /**
   * `insertNode` -> tree op. Maps to `Node.addChild` (append).
   *
   * Limitation: @tern/core has no insert-before-anchor API, so a non-null
   * `anchor` is ignored (the node is appended) — anchor-accurate insertion is
   * post-MVP. The parent registry is updated so traversal callbacks work.
   */
  insertNode(parent: Node, node: Node, _anchor?: Node): void {
    parentMap.set(node, parent);
    parent.addChild(node);
  },

  /** `removeNode` -> tree op. Detaches the node's subtree from the scene. */
  removeNode(_parent: Node, node: Node): void {
    parentMap.delete(node);
    node.remove();
  },

  /**
   * Tern-side convenience alias — NOT a solid-js v1.9.14 `RendererOptions`
   * key (the real key set is createElement, createTextNode, replaceText,
   * isTextNode, setProperty, insertNode, removeNode, getParentNode,
   * getFirstChild, getNextSibling). Mirrors the `setProp` legacy-alias
   * pattern: the runtime destructures the real keys and ignores this one; it
   * is kept so the strategy's contract is exposed on the options object.
   *
   * Best-effort in-parent replacement: the new node is registered under the
   * replaced node's recorded parent and appended to it (`Node.addChild` is
   * append-only, so position-accurate replacement is post-MVP), then the
   * replaced node is detached. When the replaced node has no recorded parent
   * this is a no-op — there is nowhere to place the new node.
   */
  replaceNode(node: Node, replacedNode: Node): void {
    if (node === replacedNode) return;
    const parent = parentMap.get(replacedNode);
    if (parent === undefined) return;
    parentMap.set(node, parent);
    if (!parent.children.includes(node)) {
      parent.addChild(node);
    }
    parentMap.delete(replacedNode);
    replacedNode.remove();
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
 * The configured universal renderer. `render(code, node)` mounts a scene under
 * `node`; the destructured primitives below are the standard custom-renderer
 * surface (same shape solid-js/universal exports for its own DOM renderer).
 */
const renderer = createRenderer(options);

/**
 * The `RendererOptions` object wired into `createRenderer` above, exported so
 * tests (and embedders) can exercise the tree-op callbacks directly —
 * `replaceText`, `isTextNode`, `replaceNode`, `setProperty`,
 * `getParentNode`/`getFirstChild`/`getNextSibling` are reachable only
 * through the options object, not the renderer surface.
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
 * funnels into `Node.setProps` / `Node.addChild`.
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
