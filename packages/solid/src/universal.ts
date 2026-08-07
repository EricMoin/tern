/**
 * Vendored solid-js universal renderer for @tern-tui/solid.
 *
 * Faithful TypeScript port of `solid-js/universal`'s `createRenderer`
 * (node_modules/solid-js/universal/dist/universal.js, MIT — the logic and the
 * exported `RendererOptions` / `Renderer` interfaces are taken verbatim from
 * solidjs/solid, copyright Ryan Carniato and the SolidJS contributors).
 *
 * Why vendored instead of imported as `solid-js/universal`? Deno (and Node)
 * resolve the bare `solid-js` specifier through the package's exports map,
 * whose `deno` / `node` conditions serve the *server* build
 * (dist/server.js). That build has no reactive runtime — `createRenderEffect`
 * runs its effect once with no tracking and `createMemo` computes once,
 * eagerly — so a renderer built on it can never perform targeted scene
 * updates. The reactive *client* build (dist/solid.js) is only reachable
 * under the `browser` condition, which neither Deno nor Node uses for bare
 * imports.
 *
 * This copy lives inside the package so its `solid-js` import is a project
 * import, resolved through the package import map (deno.json) to the client
 * build — giving the renderer a real reactive runtime under Deno while the
 * rest of the code is byte-for-byte the canonical universal renderer.
 *
 * The `// @deno-types` directive pairs the mapped client build with the
 * package's canonical declarations (types/index.d.ts) — the mapped file has
 * no adjacent .d.ts, and without the directive Deno would infer JS types.
 */

// @deno-types="../../../node_modules/solid-js/types/index.d.ts"
import {
  createMemo,
  createComponent as solidCreateComponent,
  createRenderEffect,
  mergeProps,
  untrack,
  createRoot,
} from "solid-js";

export interface RendererOptions<NodeType> {
  createElement(tag: string): NodeType;
  createTextNode(value: string): NodeType;
  replaceText(textNode: NodeType, value: string): void;
  isTextNode(node: NodeType): boolean;
  setProperty<T>(node: NodeType, name: string, value: T, prev?: T): void;
  insertNode(parent: NodeType, node: NodeType, anchor?: NodeType): void;
  removeNode(parent: NodeType, node: NodeType): void;
  getParentNode(node: NodeType): NodeType | undefined;
  getFirstChild(node: NodeType): NodeType | undefined;
  getNextSibling(node: NodeType): NodeType | undefined;
}

export interface Renderer<NodeType> {
  render(code: () => NodeType, node: NodeType): () => void;
  effect<T>(fn: (prev?: T) => T, init?: T): void;
  memo<T>(fn: () => T, equal: boolean): () => T;
  createComponent<T>(Comp: (props: T) => NodeType, props: T): NodeType;
  createElement(tag: string): NodeType;
  createTextNode(value: string): NodeType;
  insertNode(parent: NodeType, node: NodeType, anchor?: NodeType): void;
  // The `any` params mirror the canonical solid-js 1.9.14 `Renderer`
  // interface verbatim (see node_modules/solid-js/universal/types/universal.d.ts).
  // deno-lint-ignore no-explicit-any
  insert<T>(parent: any, accessor: (() => T) | T, marker?: any | null, initial?: any): NodeType;
  // deno-lint-ignore no-explicit-any
  spread<T>(node: any, accessor: (() => T) | T, skipChildren?: boolean): void;
  setProp<T>(node: NodeType, name: string, value: T, prev?: T): T;
  mergeProps(...sources: unknown[]): unknown;
  use<A, T>(fn: (element: NodeType, arg: A) => T, element: NodeType, arg: A): T;
}

const memo = <T>(fn: () => T, _equal?: boolean): (() => T) => createMemo(() => fn());

/** Internal dynamic-typed alias used by the canonical reconciler helpers. */
// deno-lint-ignore no-explicit-any
type Any = any;

function createRenderer$1<NodeType>(
  {
    createElement,
    createTextNode,
    isTextNode,
    replaceText,
    insertNode,
    removeNode,
    setProperty,
    getParentNode,
    getFirstChild,
    getNextSibling,
  }: RendererOptions<NodeType>,
): Renderer<NodeType> {
  function insert(parent: NodeType, accessor: Any, marker?: Any, initial?: Any): Any {
    if (marker !== undefined && !initial) initial = [];
    if (typeof accessor !== "function") return insertExpression(parent, accessor, initial, marker);
    createRenderEffect((current: Any) => insertExpression(parent, accessor(), current, marker), initial);
  }

  function insertExpression(
    parent: NodeType,
    value: Any,
    current: Any,
    marker?: Any,
    unwrapArray?: Any,
  ): Any {
    while (typeof current === "function") current = current();
    if (value === current) return current;
    const t = typeof value,
      multi = marker !== undefined;
    if (t === "string" || t === "number") {
      if (t === "number") value = value.toString();
      if (multi) {
        let node = current[0];
        if (node && isTextNode(node)) {
          replaceText(node, value);
        } else node = createTextNode(value);
        current = cleanChildren(parent, current, marker, node);
      } else {
        if (current !== "" && typeof current === "string") {
          replaceText(getFirstChild(parent) as NodeType, (current = value));
        } else {
          cleanChildren(parent, current, marker, createTextNode(value));
          current = value;
        }
      }
    } else if (value == null || t === "boolean") {
      current = cleanChildren(parent, current, marker);
    } else if (t === "function") {
      createRenderEffect(() => {
        let v = value();
        while (typeof v === "function") v = v();
        current = insertExpression(parent, v, current, marker);
      });
      return () => current;
    } else if (Array.isArray(value)) {
      const array: Any[] = [];
      if (normalizeIncomingArray(array, value, unwrapArray)) {
        createRenderEffect(() => (current = insertExpression(parent, array, current, marker, true)));
        return () => current;
      }
      if (array.length === 0) {
        const replacement = cleanChildren(parent, current, marker);
        if (multi) return (current = replacement);
      } else {
        if (Array.isArray(current)) {
          if (current.length === 0) {
            appendNodes(parent, array, marker);
          } else reconcileArrays(parent, current, array);
        } else if (current == null || current === "") {
          appendNodes(parent, array);
        } else {
          reconcileArrays(parent, (multi && current) || [getFirstChild(parent)], array);
        }
      }
      current = array;
    } else {
      if (Array.isArray(current)) {
        if (multi) return (current = cleanChildren(parent, current, marker, value));
        cleanChildren(parent, current, null, value);
      } else if (current == null || current === "" || !getFirstChild(parent)) {
        insertNode(parent, value);
      } else replaceNode(parent, value, getFirstChild(parent));
      current = value;
    }
    return current;
  }

  function normalizeIncomingArray(normalized: Any[], array: Any[], unwrap?: Any): Any {
    let dynamic = false;
    for (let i = 0, len = array.length; i < len; i++) {
      let item = array[i],
        t: Any;
      if (item == null || item === true || item === false) {
        // no-op: null / booleans are placeholders
      } else if (Array.isArray(item)) {
        dynamic = normalizeIncomingArray(normalized, item) || dynamic;
      } else if ((t = typeof item) === "string" || t === "number") {
        normalized.push(createTextNode(item));
      } else if (t === "function") {
        if (unwrap) {
          while (typeof item === "function") item = item();
          dynamic = normalizeIncomingArray(normalized, Array.isArray(item) ? item : [item]) || dynamic;
        } else {
          normalized.push(item);
          dynamic = true;
        }
      } else normalized.push(item);
    }
    return dynamic;
  }

  function reconcileArrays(parentNode: NodeType, a: Any[], b: Any[]): void {
    const bLength = b.length;
    let aEnd = a.length,
      bEnd = bLength,
      aStart = 0,
      bStart = 0;
    const after = getNextSibling(a[aEnd - 1]);
    let map: Map<Any, number> | null = null;
    while (aStart < aEnd || bStart < bEnd) {
      if (a[aStart] === b[bStart]) {
        aStart++;
        bStart++;
        continue;
      }
      while (a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
      }
      if (aEnd === aStart) {
        const node = bEnd < bLength ? (bStart ? getNextSibling(b[bStart - 1]) : b[bEnd - bStart]) : after;
        while (bStart < bEnd) insertNode(parentNode, b[bStart++], node);
      } else if (bEnd === bStart) {
        while (aStart < aEnd) {
          if (!map || !map.has(a[aStart])) removeNode(parentNode, a[aStart]);
          aStart++;
        }
      } else if (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]) {
        const node = getNextSibling(a[--aEnd]);
        insertNode(parentNode, b[bStart++], getNextSibling(a[aStart++]));
        insertNode(parentNode, b[--bEnd], node);
        a[aEnd] = b[bEnd];
      } else {
        if (!map) {
          map = new Map();
          let i = bStart;
          while (i < bEnd) map.set(b[i], i++);
        }
        const index = map.get(a[aStart]);
        if (index != null) {
          if (bStart < index && index < bEnd) {
            let i = aStart,
              sequence = 1,
              t: Any;
            while (++i < aEnd && i < bEnd) {
              if ((t = map.get(a[i])) == null || t !== index + sequence) break;
              sequence++;
            }
            if (sequence > index - bStart) {
              const node = a[aStart];
              while (bStart < index) insertNode(parentNode, b[bStart++], node);
            } else replaceNode(parentNode, b[bStart++], a[aStart++]);
          } else aStart++;
        } else removeNode(parentNode, a[aStart++]);
      }
    }
  }

  function cleanChildren(parent: NodeType, current: Any, marker?: Any, replacement?: Any): Any {
    if (marker === undefined) {
      let removed: Any;
      while ((removed = getFirstChild(parent))) removeNode(parent, removed);
      replacement && insertNode(parent, replacement);
      return "";
    }
    const node = replacement || createTextNode("");
    if (current.length) {
      let inserted = false;
      for (let i = current.length - 1; i >= 0; i--) {
        const el = current[i];
        if (node !== el) {
          const isParent = getParentNode(el) === parent;
          if (!inserted && !i) isParent ? replaceNode(parent, node, el) : insertNode(parent, node, marker);
          else isParent && removeNode(parent, el);
        } else inserted = true;
      }
    } else insertNode(parent, node, marker);
    return [node];
  }

  function appendNodes(parent: NodeType, array: Any[], marker?: Any): void {
    for (let i = 0, len = array.length; i < len; i++) insertNode(parent, array[i], marker);
  }

  function replaceNode(parent: NodeType, newNode: Any, oldNode: Any): void {
    insertNode(parent, newNode, oldNode);
    removeNode(parent, oldNode);
  }

  function spreadExpression(
    node: Any,
    props: Any,
    prevProps: Any = {},
    skipChildren?: Any,
  ): Any {
    props || (props = {});
    if (!skipChildren) {
      createRenderEffect(() => (prevProps.children = insertExpression(node, props.children, prevProps.children)));
    }
    createRenderEffect(() => props.ref && props.ref(node));
    createRenderEffect(() => {
      for (const prop in props) {
        if (prop === "children" || prop === "ref") continue;
        const value = props[prop];
        if (value === prevProps[prop]) continue;
        setProperty(node, prop, value, prevProps[prop]);
        prevProps[prop] = value;
      }
    });
    return prevProps;
  }

  return {
    render(code: () => NodeType, element: NodeType): () => void {
      let disposer: () => void = () => {};
      createRoot((dispose) => {
        disposer = dispose;
        insert(element, code());
      });
      return disposer;
    },
    insert,
    spread(node: Any, accessor: Any, skipChildren?: Any): void {
      if (typeof accessor === "function") {
        createRenderEffect((current: Any) => spreadExpression(node, accessor(), current, skipChildren));
      } else spreadExpression(node, accessor, undefined, skipChildren);
    },
    createElement,
    createTextNode,
    insertNode,
    setProp<T>(node: NodeType, name: string, value: T, prev?: T): T {
      setProperty(node, name, value, prev);
      return value;
    },
    mergeProps,
    effect: createRenderEffect,
    memo,
    createComponent<T>(Comp: (props: T) => NodeType, props: T): NodeType {
      // Solid's own `createComponent` is `(Comp: Component<T>, props: T) => any`
      // (Component<T> = (props: T) => unknown); the universal surface narrows
      // the return to NodeType, so wrap the canonical function.
      return (solidCreateComponent as (Comp: Any, props: Any) => NodeType)(Comp, props);
    },
    use<A, T>(fn: (element: NodeType, arg: A) => T, element: NodeType, arg: A): T {
      return untrack(() => fn(element, arg));
    },
  };
}

export function createRenderer<NodeType>(options: RendererOptions<NodeType>): Renderer<NodeType> {
  const renderer = createRenderer$1(options);
  renderer.mergeProps = mergeProps;
  return renderer;
}
