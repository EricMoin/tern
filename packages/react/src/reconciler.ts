/**
 * @tern/react — mutation-mode react-reconciler HostConfig for tern.
 *
 * Maps React host components onto tern scene nodes through the `packages/core`
 * factories (`Box` / `Text` / `StreamingText` / `Node`). The tree lives in the
 * tern scene; the reconciler is a thin driver that translates React's
 * commit-phase mutations into `Node.addChild` / `Node.remove` /
 * `Node.setProps` calls.
 *
 * ## HostConfig mapping (per the MVP strategy)
 *
 * - `supportsMutation: true` — mutation mode (append/insert/remove ops).
 * - `createInstance(type, props)` -> tern node via `Box(props)` /
 *   `Text(props)` / `StreamingText(props)`.
 * - `createTextInstance` throws — tern requires an explicit `<Text>` element,
 *   bare string children are rejected at render time.
 * - `appendChild` / `insertBefore` / `removeChild` -> tern tree ops. The core
 *   `Node` API exposes an ordered insert (`Node.insertBefore` ->
 *   `NodeHandle.insert_before`), so `insertBefore` places the child at the
 *   anchor with full reorder fidelity. react-reconciler reuses host instances
 *   across updates, so an `insertBefore`/`appendChild` on an already-present
 *   child is a reposition (keyed-list move) and is realized as a
 *   remove-then-insert against the core API, which throws on duplicates.
 * - `commitUpdate` -> `Node.setProps` (React-only props stripped).
 * - `prepareForCommit` / `resetAfterCommit` -> `renderer.render()`.
 * - `noTimeout: -1`; `scheduleTimeout` / `cancelTimeout` -> `setTimeout` /
 *   `clearTimeout`.
 * - Event priority: react-reconciler 0.33 renamed `getCurrentEventPriority`
 *   to `setCurrentUpdatePriority` / `getCurrentUpdatePriority` /
 *   `resolveUpdatePriority`. Tern has no event system, so updates are always
 *   default priority (`DefaultEventPriority` from
 *   `react-reconciler/constants`).
 */

import Reconciler from "react-reconciler";
import {
  DefaultEventPriority,
  LegacyRoot,
} from "react-reconciler/constants.js";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  Box,
  StreamingText,
  Text,
  type KeyEvent,
  type Node,
  type NodeProps,
  type Renderer,
} from "@tern/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Props as the reconciler hands them to the host config: the tern node props
 * plus the React-only keys (`children`, `key`, `ref`) that must never reach
 * the scene node.
 */
export type TernProps = NodeProps & {
  children?: ReactNode;
  key?: string | number | null;
  ref?: unknown;
};

/**
 * The root container for a tern tree: the scene root node plus the renderer
 * that owns it. `prepareForCommit` / `resetAfterCommit` paint the scene
 * through `renderer.render()`.
 */
export interface TernContainer {
  /** The scene root node content is attached under. */
  readonly root: Node;
  /** The renderer that paints the scene. */
  readonly renderer: Renderer;
}

/** The handle type used by `setTimeout` in the current runtime. */
export type TernTimeoutHandle = ReturnType<typeof setTimeout>;
/** `noTimeout` marker: never a valid timeout id. */
export type TernNoTimeout = -1;

/** What `useApp()` exposes to components inside a tern tree. */
export interface AppHandle {
  /** The renderer backing this tree (input loop, destroy, ...). */
  readonly renderer: Renderer;
  /** The scene root node the tree is attached under. */
  readonly root: Node;
  /**
   * Unmount the tree and tear the terminal down (exit raw mode + the
   * alternate screen). Idempotent.
   */
  exit(error?: unknown): void;
  /** Unmount the tree, leaving the renderer alive. */
  unmount(): void;
}

/** The root object returned by `createRoot` / `render`. */
export interface TernRoot {
  /** Render (or re-render) the given element into the scene root. */
  render(element: ReactNode): void;
  /** Detach the tree from the scene. */
  unmount(): void;
}

/** Options for `useInput`. */
export interface UseInputOptions {
  /** When `false`, the handler is detached until reactivated (default `true`). */
  isActive?: boolean;
}

/** The handler signature for `useInput`: a core key event. */
export type UseInputHandler = (event: KeyEvent) => void;

// ---------------------------------------------------------------------------
// Prop sanitizing
// ---------------------------------------------------------------------------

/** React-only props that must never reach a tern scene node. */
const REACT_RESERVED_PROPS = new Set(["children", "key", "ref"]);

/**
 * Component-consumed props of `<StreamingText>` that must never reach a scene
 * node: `stream` is a non-scalar async iterable (the binding drops objects)
 * and `autoScroll` / `wrap` are component behavior flags, not tern node
 * props.
 */
const STREAMING_TEXT_PROPS = new Set(["stream", "autoScroll", "wrap"]);

/**
 * Strip the React-only props (and, for `streaming_text`, the component-level
 * `<StreamingText>` props), leaving the tern node props (style + layout keys)
 * that the core factories and `Node.setProps` understand.
 */
export function toNodeProps(props: TernProps, type?: string): NodeProps {
  const out: NodeProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (REACT_RESERVED_PROPS.has(key) || value === undefined) continue;
    if (type === "streaming_text" && STREAMING_TEXT_PROPS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree ops over the tern Node API
// ---------------------------------------------------------------------------

/**
 * Append `child` under `parent`. The core `Node.addChild` throws when the
 * same child instance is already recorded on that parent, but React reuses
 * host instances across updates: an `appendChild` on an already-present
 * child is a reposition to the end (DOM `appendChild` semantics — this is
 * how React realizes the trailing placements of a full list reorder), so the
 * child is detached first.
 */
function appendTo(parent: Node, child: Node): void {
  if (parent.children.includes(child)) child.remove();
  parent.addChild(child);
}

/**
 * Place `child` immediately before `beforeChild` under `parent`. Per
 * react-reconciler semantics this is used both for inserting new children
 * and for reordering existing ones (keyed-list moves), where `child` is
 * already attached. The core `Node.insertBefore` throws on an already-present
 * child, so a move is realized as a remove-then-insert at the anchor.
 */
function insertBeforeChild(parent: Node, child: Node, beforeChild: Node): void {
  if (parent.children.includes(child)) child.remove();
  parent.insertBefore(child, beforeChild);
}

/** Detach a child (and its subtree) from the scene; core `Node.remove()`
 * also splices the child out of its parent's children list. */
function removeNode(child: Node): void {
  child.remove();
}

// ---------------------------------------------------------------------------
// HostConfig
// ---------------------------------------------------------------------------

type HostConfig = Reconciler.HostConfig<
  string, // Type — host element type ("box" | "text")
  TernProps, // Props
  TernContainer, // Container
  Node, // Instance
  never, // TextInstance — tern has no text instances
  never, // SuspenseInstance
  never, // HydratableInstance
  never, // FormInstance
  Node, // PublicInstance (refs expose the scene node)
  object, // HostContext (unused; non-null sentinel)
  never, // ChildSet (persistent mode unused)
  TernTimeoutHandle, // TimeoutHandle
  TernNoTimeout, // NoTimeout
  null // TransitionStatus
>;

/** Module-level current update priority (set by the reconciler). */
let currentUpdatePriority: number = DefaultEventPriority;

/**
 * Host context is unused in tern, but React's internal context stack expects
 * a non-null entry (null would trip a DEV warning in `requiredContext`).
 */
const EMPTY_HOST_CONTEXT = {};

/** The mutation-mode host config for the tern reconciler. */
export const hostConfig: HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  // Tern apps drive renders imperatively (render()/createRoot()), not through
  // act(); keep the dev bundle from warning about missing act() calls.
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  noTimeout: -1,

  // --- tree construction (render phase) ------------------------------------

  createInstance(type, props) {
    const nodeProps = toNodeProps(props, type);
    switch (type) {
      case "box":
        return Box(nodeProps);
      case "text":
        return Text(nodeProps);
      case "streaming_text":
        return StreamingText(nodeProps);
      default:
        throw new Error(`@tern/react: unknown host element type "${type}"`);
    }
  },

  createTextInstance() {
    throw new Error(
      'tern: bare text is not supported — wrap string children in an explicit <Text text="..." /> element',
    );
  },

  appendInitialChild(parent, child) {
    appendTo(parent, child);
  },

  finalizeInitialChildren() {
    return false;
  },

  shouldSetTextContent() {
    // Never let React fold string children into a node: tern text lives in an
    // explicit <Text text="..." /> host element.
    return false;
  },

  getRootHostContext() {
    return EMPTY_HOST_CONTEXT;
  },

  getChildHostContext() {
    return EMPTY_HOST_CONTEXT;
  },

  getPublicInstance(instance) {
    return instance;
  },

  // --- commit phase ---------------------------------------------------------

  prepareForCommit(container) {
    // Per the MVP strategy both prepareForCommit and resetAfterCommit paint
    // through renderer.render(); the pre-commit paint is redundant with the
    // post-commit one but keeps the mapping explicit.
    container.renderer.render();
    return null;
  },

  resetAfterCommit(container) {
    container.renderer.render();
  },

  preparePortalMount() {},

  // --- scheduling -----------------------------------------------------------

  scheduleTimeout(fn, delay) {
    return setTimeout(fn, delay);
  },

  cancelTimeout(id) {
    clearTimeout(id);
  },

  scheduleMicrotask(fn) {
    queueMicrotask(fn);
  },

  // --- mutation ops (commit phase) ------------------------------------------

  appendChild(parent, child) {
    appendTo(parent, child);
  },

  appendChildToContainer(container, child) {
    appendTo(container.root, child);
  },

  insertBefore(parent, child, beforeChild) {
    // Anchor-accurate insert per react-reconciler semantics: place `child`
    // immediately before `beforeChild`. Keyed-list moves (an already-present
    // `child`) are handled by insertBeforeChild via remove-then-insert, since
    // the core Node.insertBefore throws on an already-present child.
    insertBeforeChild(parent, child, beforeChild);
  },

  insertInContainerBefore(container, child, beforeChild) {
    insertBeforeChild(container.root, child, beforeChild);
  },

  removeChild(_parent, child) {
    removeNode(child);
  },

  removeChildFromContainer(_container, child) {
    removeNode(child);
  },

  commitMount() {},

  commitUpdate(instance, type, _prevProps, nextProps) {
    instance.setProps(toNodeProps(nextProps, type));
  },

  commitTextUpdate() {
    throw new Error("tern: text instances are not supported — use <Text />");
  },

  resetTextContent() {},

  hideInstance(instance) {
    instance.setProps({ ...instance.props, hidden: true });
  },

  unhideInstance(instance, props) {
    instance.setProps({ ...toNodeProps(props, instance.type), hidden: false });
  },

  hideTextInstance() {},

  unhideTextInstance() {},

  clearContainer(container) {
    for (const child of [...container.root.children]) {
      removeNode(child);
    }
  },

  // --- devtools / scope / blur (unused by the MVP) --------------------------

  getInstanceFromNode() {
    return null;
  },

  beforeActiveInstanceBlur() {},

  afterActiveInstanceBlur() {},

  prepareScopeUpdate() {},

  getInstanceFromScope() {
    return null;
  },

  detachDeletedInstance() {},

  // --- event priority (0.33 renamed getCurrentEventPriority) ----------------

  setCurrentUpdatePriority(priority) {
    currentUpdatePriority = priority;
  },

  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },

  resolveUpdatePriority() {
    return DefaultEventPriority;
  },

  // --- transitions ----------------------------------------------------------

  NotPendingTransition: null,
  // React's createContext returns a runtime-compatible object; the
  // reconciler's ReactContext type additionally declares its internal fields.
  HostTransitionContext: createContext<null>(null) as unknown as Reconciler.ReactContext<null>,

  // --- misc React 19 host config surface ------------------------------------

  resetFormInstance() {},

  requestPostPaintCallback() {},

  shouldAttemptEagerTransition() {
    return false;
  },

  trackSchedulerEvent() {},

  resolveEventType() {
    return null;
  },

  resolveEventTimeStamp() {
    return -1;
  },

  // --- suspending commits (no suspending hosts in tern) ---------------------

  maySuspendCommit() {
    return false;
  },

  preloadInstance() {
    return true;
  },

  startSuspendingCommit() {},

  suspendInstance() {},

  waitForCommitToBeReady() {
    return null;
  },
};

// ---------------------------------------------------------------------------
// Reconciler + root API
// ---------------------------------------------------------------------------

/** React context carrying the app handle to every component in the tree. */
export const AppContext = createContext<AppHandle | null>(null);

/** The shared reconciler instance (one HostConfig, many roots). */
const ReconcilerInstance = Reconciler(hostConfig);

/** Default error reporters when no error boundary catches an error. */
function reportError(error: unknown): void {
  console.error("[@tern/react]", error);
}

/**
 * Create a tern render root over `renderer`. The scene root
 * (`renderer.root`) is the container; every commit paints the scene through
 * `renderer.render()`.
 *
 * The root is created in legacy (synchronous) mode, and `render()` flushes
 * its work synchronously (see `updateRoot`) — a TUI drives the frame loop
 * imperatively and must paint before `render()` returns; there is no
 * concurrent scheduling benefit.
 */
export function createRoot(renderer: Renderer): TernRoot {
  const container: TernContainer = { root: renderer.root, renderer };

  const internalRoot = ReconcilerInstance.createContainer(
    container,
    LegacyRoot,
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    "", // identifierPrefix
    reportError, // onUncaughtError
    reportError, // onCaughtError
    reportError, // onRecoverableError
    () => {}, // onDefaultTransitionIndicator
  );

  const app: AppHandle = {
    renderer,
    root: renderer.root,
    exit() {
      try {
        app.unmount();
      } finally {
        renderer.destroy();
      }
    },
    unmount() {
      updateRoot(null);
    },
  };

  /**
   * Schedule a root update and flush it synchronously. react-reconciler 0.33
   * schedules all sync work on an immediate task (the legacy sync flush path
   * was removed), so without `flushSyncWork()` the commit would land on a
   * microtask — wrong for a TUI frame loop, which must paint before
   * `render()` returns.
   *
   * Inside React's test environment (`IS_REACT_ACT_ENVIRONMENT`), updates are
   * expected to flush through `act()` instead; flushing directly here would
   * trip React's "not wrapped in act" warning, so the direct flush is skipped
   * there (act flushes the queued work itself).
   */
  function updateRoot(element: ReactNode | null): void {
    ReconcilerInstance.updateContainerSync(element, internalRoot, null, undefined);
    const isActEnvironment =
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT === true;
    if (!isActEnvironment) {
      ReconcilerInstance.flushSyncWork();
    }
  }

  return {
    render(element) {
      updateRoot(
        createElement(AppContext.Provider, { value: app }, element),
      );
    },
    unmount() {
      app.unmount();
    },
  };
}

/**
 * Convenience: create a root over `renderer`, render `element` immediately,
 * and return the root (so the caller can `unmount()` later).
 */
export function render(element: ReactNode, renderer: Renderer): TernRoot {
  const root = createRoot(renderer);
  root.render(element);
  return root;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Access the app handle (renderer, scene root, exit/unmount) from inside a
 * tern tree. Throws when called outside a tree rendered with `render` /
 * `createRoot`.
 */
export function useApp(): AppHandle {
  const app = useContext(AppContext);
  if (app === null) {
    throw new Error(
      "useApp() must be called inside a tern tree rendered with @tern/react render()/createRoot()",
    );
  }
  return app;
}

/**
 * Subscribe to keyboard input for the current tree. The handler receives the
 * core key event and always sees the latest closure. Returns nothing; the
 * subscription is torn down when the component unmounts or `isActive`
 * becomes `false`.
 */
export function useInput(handler: UseInputHandler, options?: UseInputOptions): void {
  const { renderer } = useApp();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const isActive = options?.isActive ?? true;

  useEffect(() => {
    if (!isActive) return;
    return renderer.onKey((event) => {
      handlerRef.current(event);
    });
  }, [renderer, isActive]);
}
