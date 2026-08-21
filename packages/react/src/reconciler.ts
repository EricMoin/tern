/**
 * @tern-tui/react — mutation-mode react-reconciler HostConfig for tern.
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
 *   `Text(props)` / `StreamingText(props)` / `Input(props)` / `Spinner(props)`
 *   / `StatusBar(props)` / `Panels(props)` / `DiffView(props)` /
 *   `Select(props)` / `Menu(props)` / `ScrollView(props)` / `Table(props)` /
 *   `Modal(props)`.
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
 * - `resetAfterCommit` -> `renderer.render()` (the single paint per commit;
 *   `prepareForCommit` no longer paints — the pre-commit paint was redundant
 *   with the post-commit one).
 * - `noTimeout: -1`; `scheduleTimeout` / `cancelTimeout` -> `setTimeout` /
 *   `clearTimeout`.
 * - Event priority: react-reconciler 0.33 renamed `getCurrentEventPriority`
 *   to `setCurrentUpdatePriority` / `getCurrentUpdatePriority` /
 *   `resolveUpdatePriority`. Tern has no event system, so updates are always
 *   default priority (`DefaultEventPriority` from
 *   `react-reconciler/constants`).
 */

import Reconciler from "react-reconciler";
// The `.js` suffix is required: react-reconciler@0.33.x ships no `exports` map,
// so the extension-less `react-reconciler/constants` fails under Node ESM.
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
  BarChart as CoreBarChart,
  Box,
  Chart as CoreChart,
  DiffView as CoreDiffView,
  Input as CoreInput,
  Modal as CoreModal,
  Menu as CoreMenu,
  Panels as CorePanels,
  Progress as CoreProgress,
  ScrollView as CoreScrollView,
  Select as CoreSelect,
  Sparkline as CoreSparkline,
  Spinner as CoreSpinner,
  StatusBar as CoreStatusBar,
  StreamingText,
  Table as CoreTable,
  Tabs as CoreTabs,
  Text,
  Textarea as CoreTextarea,
  Tree as CoreTree,
  focusManager,
  type BarChartProps,
  type ChartProps,
  type DiffViewProps,
  type FocusManager,
  type KeyEvent,
  type ModalProps,
  type MenuProps,
  type Node,
  type NodeProps,
  type PanelsProps,
  type ProgressProps,
  type Renderer,
  type ScrollViewProps,
  type SelectProps,
  type SparklineProps,
  type SpinnerProps,
  type TableProps,
  type TabsProps,
  type TextareaProps,
  type ThemeComponent,
  type ThemeRole,
  type TreeProps,
} from "@tern-tui/core";

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
 * that owns it. `resetAfterCommit` paints the scene through
 * `renderer.render()` — the single paint per commit.
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
  /**
   * The `FocusManager` consulted before the tree-level handler: when it
   * routes the key to a focused element (`FocusManager.routeKey`), the tree
   * handler is skipped. Defaults to the core `focusManager`.
   */
  focusManager?: FocusManager;
}

/** The handler signature for `useInput`: a core key event. */
export type UseInputHandler = (event: KeyEvent) => void;

/** Options for `usePaste`. */
export interface UsePasteOptions {
  /** When `false`, the handler is detached until reactivated (default `true`). */
  isActive?: boolean;
  /**
   * The `FocusManager` consulted before the tree-level handler: when it
   * routes the paste to a focused element (`FocusManager.routePaste`), the
   * tree handler is skipped. Defaults to the core `focusManager`.
   */
  focusManager?: FocusManager;
}

/** The handler signature for `usePaste`: the pasted text string. */
export type UsePasteHandler = (text: string) => void;

// ---------------------------------------------------------------------------
// Prop sanitizing
// ---------------------------------------------------------------------------

/** React-only props that must never reach a tern scene node. */
const REACT_RESERVED_PROPS = new Set(["children", "key", "ref"]);

/**
 * Semantic theme hints consumed by the host components at render time (via
 * `resolveTheme`). They are never scene props — this strip guarantees a
 * `role` / `component` prop cannot leak onto a node even if a host component
 * forgets to resolve (constitution: theme output is plain node props).
 */
const THEME_PROPS = new Set(["role", "component"]);

/**
 * Component-consumed props of `<StreamingText>` that must never reach a scene
 * node: `stream` is a non-scalar async iterable (the binding drops objects)
 * and `autoScroll` is a component behavior flag. `wrap` IS a scene prop — the
 * compositor honors `wrap: false` (single-row paint, trimmed at the right
 * edge), so it flows through to the core factory.
 */
const STREAMING_TEXT_PROPS = new Set(["stream", "autoScroll"]);

/**
 * Component-consumed props of `<Input>` that must never reach a scene node:
 * `onChange` / `onSubmit` are callbacks, `focusId` is focus bookkeeping, and
 * `focusManager` is a non-scalar object (the binding drops objects). The
 * value/caret/placeholder state props flow through to the core factory.
 */
const INPUT_PROPS = new Set(["onChange", "onSubmit", "focusId", "focusManager"]);

/** Component-consumed props of `<Textarea>` that must never reach a scene
 * node: the callbacks and the focus wiring (mirroring `<Input>`). The
 * lines/row/col/width/height/scroll edit-model props flow through to the
 * core factory. */
const TEXTAREA_PROPS = new Set(["onChange", "onSubmit", "focusId", "focusManager"]);

/** Component-consumed props of `<Spinner>`: `interval` drives the timer, it
 * is not a scene prop. */
const SPINNER_PROPS = new Set(["interval"]);

/**
 * Component-consumed props of `<Select>` that must never reach a scene node:
 * the callbacks and the focus wiring. The `options` list and the
 * `floating`/`multi`/state props flow through to the core factory, which
 * consumes the bookkeeping keys itself (the option list is JS bookkeeping,
 * `floating` maps to the root box's `z_index`).
 */
const SELECT_PROPS = new Set(["onChange", "onConfirm", "onDismiss", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Menu>` that must never reach a scene node:
 * the callbacks and the focus wiring (mirroring `<Select>`). The `items`
 * model and the `floating`/`submenu`/state props flow through to the core
 * factory, which consumes the bookkeeping keys itself (the item model is JS
 * bookkeeping, `floating` maps to the root box's `z_index`).
 */
const MENU_PROPS = new Set(["onSelect", "onDismiss", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Modal>` that must never reach a scene node:
 * `content` is the core `Node[]` modal body (JS bookkeeping the core factory
 * consumes, mirroring `<Panels>`' `panels`). The open/backdrop/z_index state
 * props flow through to the core factory.
 */
const MODAL_PROPS = new Set(["content"]);

/**
 * Component-consumed props of `<Tabs>` that must never reach a scene node:
 * the callbacks and the focus wiring. The `tabs` spec list and the
 * active/closable state props flow through to the core factory, which
 * consumes the bookkeeping keys itself (the spec list is JS bookkeeping,
 * `closable` maps to the per-tab close affordance).
 */
const TABS_PROPS = new Set(["onChange", "onClose", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Tree>` that must never reach a scene node:
 * the callback and the focus wiring (mirroring `<Tabs>`). The `nodes` model
 * and the `expanded` / `indent` bookkeeping flow through to the core
 * factory, which consumes them itself (they never reach the scene props).
 */
const TREE_PROPS = new Set(["onChange", "focusId", "focusManager"]);

// ---------------------------------------------------------------------------
// M4.5 runtime theme hint carrier
//
// The host components resolve their `role` / `component` hints through the
// core `resolveTheme` at element-creation time, stamping plain style keys.
// The core runtime theme engine (`setTheme` / `getTheme`, M4.5 subtask 1)
// re-resolves every node it has *recorded* — and the recording happens in
// the core `Node` constructor, which reads a module-private Symbol that
// `resolveTheme` stamps onto its returned props.
//
// That Symbol cannot ride a React element: `createElement` copies its config
// with `for...in`, which iterates string keys only, so the Symbol would be
// dropped before the reconciler ever sees it. The host components therefore
// carry the hint under a string key (`resolveHostTheme` in `index.ts`), and
// `toNodeProps` re-materializes it as the Symbol right before the core
// factory call — so the node is recorded and a later core `setTheme` can
// re-resolve it in place, WITHOUT a React re-render.
// ---------------------------------------------------------------------------

/** The string key the host components attach the runtime theme hint under
 * (never a scene prop — stripped by `toNodeProps` exactly like `role` /
 * `component`). */
export const THEME_HINT_CARRIER = "__ternThemeHint";

/** The runtime theme hint carried on the element props: the core hint
 * Symbol (as stamped by `resolveTheme` on its output) plus the hint record
 * itself (`role` / `component` + the style keys the theme stamped at
 * creation — the keys a later re-resolution may rewrite, while an explicit
 * prop is never in the set). */
export interface ReactThemeHint {
  /** The core hint Symbol, read off the resolved props object. */
  symbol: symbol;
  /** The hint record `resolveTheme` attached to its output. */
  payload: {
    role?: ThemeRole;
    component?: ThemeComponent;
    stamped: Set<"fg" | "bg" | "border_style">;
  };
}

/**
 * Strip the React-only props (and the component-level `<StreamingText>`,
 * `<Input>` / `<Spinner>` / `<Select>` / `<Modal>` / `<Tabs>` / `<Tree>`
 * props), leaving the tern node props (style + layout keys) that the core
 * factories and `Node.setProps` understand. The M4.5 theme hint carrier is
 * consumed here too: the Symbol is re-attached to the returned props (the
 * core `Node` constructor strips it again when it records the node), so
 * hinted nodes stay invisible to the scene props yet reachable by a later
 * core `setTheme` re-resolution.
 */
export function toNodeProps(props: TernProps, type?: string): NodeProps {
  let themeHint: ReactThemeHint | undefined;
  const out: NodeProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === THEME_HINT_CARRIER) {
      themeHint = value as ReactThemeHint;
      continue;
    }
    if (REACT_RESERVED_PROPS.has(key) || THEME_PROPS.has(key) || value === undefined) continue;
    if (type === "streaming_text" && STREAMING_TEXT_PROPS.has(key)) continue;
    if (type === "input" && INPUT_PROPS.has(key)) continue;
    if (type === "textarea" && TEXTAREA_PROPS.has(key)) continue;
    if (type === "spinner" && SPINNER_PROPS.has(key)) continue;
    if (type === "select" && SELECT_PROPS.has(key)) continue;
    if (type === "menu" && MENU_PROPS.has(key)) continue;
    if (type === "modal" && MODAL_PROPS.has(key)) continue;
    if (type === "tabs" && TABS_PROPS.has(key)) continue;
    if (type === "tree" && TREE_PROPS.has(key)) continue;
    out[key] = value;
  }
  if (themeHint !== undefined) {
    // Re-attach the core hint Symbol with the retained record, so the core
    // `Node` constructor records this node for the runtime theme engine. On
    // the update path (`Node.setProps`) the Symbol is inert — the node is
    // already recorded; invisible to every string-keyed operation, and
    // dropped by the native serialization, so scene props stay untouched.
    Object.defineProperty(out, themeHint.symbol, {
      value: themeHint.payload,
      enumerable: true,
      configurable: true,
    });
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
      case "input":
        return CoreInput(nodeProps);
      case "textarea":
        // The lines/row/col edit model is JS bookkeeping the core factory
        // consumes; `TextareaProps` is an open record over `NodeProps`.
        return CoreTextarea(nodeProps as TextareaProps);
      case "spinner":
        // The determinate bar width is a cell count the core factory
        // consumes; `SpinnerProps` narrows it while `NodeProps` is an open
        // record (its `width` also admits `"N%"` layout strings).
        return CoreSpinner(nodeProps as SpinnerProps);
      case "status_bar":
        return CoreStatusBar(nodeProps);
      case "panels":
        // The panel spec list is JS bookkeeping the core factory consumes;
        // `PanelsProps` requires it while `NodeProps` is an open record.
        return CorePanels(nodeProps as PanelsProps);
      case "diff":
        // The hunks model is JS bookkeeping the core factory consumes;
        // `DiffViewProps` requires it while `NodeProps` is an open record.
        return CoreDiffView(nodeProps as DiffViewProps);
      case "select":
        // The options list is JS bookkeeping the core factory consumes;
        // `SelectProps` requires it while `NodeProps` is an open record.
        return CoreSelect(nodeProps as SelectProps);
      case "menu":
        // The item model is JS bookkeeping the core factory consumes;
        // `MenuProps` requires it while `NodeProps` is an open record.
        return CoreMenu(nodeProps as MenuProps);
      case "scroll_view":
        // The clip/scroll region props and the scrollbar flag flow to the
        // core factory; React children are appended after the (absolutely
        // positioned) scrollbar leaf by the reconciler's tree ops.
        return CoreScrollView(nodeProps as ScrollViewProps);
      case "table":
        // The column/row model is JS bookkeeping the core factory consumes;
        // `TableProps` requires it while `NodeProps` is an open record.
        return CoreTable(nodeProps as TableProps);
      case "tree":
        // The node model + expand bookkeeping is JS state the core factory
        // consumes; `TreeProps` requires `nodes` while `NodeProps` is an open
        // record.
        return CoreTree(nodeProps as TreeProps);
      case "tabs":
        // The tab spec list is JS bookkeeping the core factory consumes;
        // `TabsProps` requires it while `NodeProps` is an open record.
        return CoreTabs(nodeProps as TabsProps);
      case "progress":
        // The label / show_percentage keys are consumed by the core factory
        // (never scene props); `ProgressProps` is an open record over
        // `NodeProps`, so no re-attach is needed here. The gauge width stays
        // a cell count, so the widened `NodeProps.width` narrows at the
        // factory boundary.
        return CoreProgress(nodeProps as ProgressProps);
      case "modal":
        // The content node list is JS bookkeeping the core factory consumes
        // (mirroring `Panels`' `panels`); `toNodeProps` strips it above, so
        // it is re-attached here for the factory.
        return (props as ModalProps).content === undefined
          ? CoreModal(nodeProps as ModalProps)
          : CoreModal({ ...nodeProps, content: (props as ModalProps).content } as ModalProps);
      case "bar_chart":
        // The series + scale are JS bookkeeping the core factory consumes;
        // `BarChartProps` requires `data` while `NodeProps` is an open record.
        return CoreBarChart(nodeProps as BarChartProps);
      case "chart":
        // The series + scale are JS bookkeeping the core factory consumes;
        // `ChartProps` requires `data` while `NodeProps` is an open record.
        return CoreChart(nodeProps as ChartProps);
      case "sparkline":
        // The series + scale are JS bookkeeping the core factory consumes;
        // `SparklineProps` requires `data` while `NodeProps` is an open
        // record.
        return CoreSparkline(nodeProps as SparklineProps);
      default:
        throw new Error(`@tern-tui/react: unknown host element type "${type}"`);
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

  prepareForCommit(_container) {
    // No paint here: the pre-commit paint (of the pre-mutation tree) was
    // redundant with the post-commit one — resetAfterCommit renders the
    // mutated tree and is the single paint per commit.
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
  console.error("[@tern-tui/react]", error);
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
      "useApp() must be called inside a tern tree rendered with @tern-tui/react render()/createRoot()",
    );
  }
  return app;
}

/**
 * Subscribe to keyboard input for the current tree. The handler receives the
 * core key event and always sees the latest closure. Each key is first routed
 * through the focus manager (defaulting to the core `focusManager`): when a
 * focused element handles it (`FocusManager.routeKey` returns `true`), the
 * tree-level handler is skipped; otherwise the handler runs, preserving the
 * pre-focus behavior. Returns nothing; the subscription is torn down when the
 * component unmounts or `isActive` becomes `false`.
 */
export function useInput(handler: UseInputHandler, options?: UseInputOptions): void {
  const { renderer } = useApp();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const manager = options?.focusManager ?? focusManager;
  const isActive = options?.isActive ?? true;

  useEffect(() => {
    if (!isActive) return;
    return renderer.onKey((event) => {
      // A focused element's key handler wins; otherwise fall back to the
      // tree-level handler (the current behavior).
      if (manager.routeKey(event)) return;
      handlerRef.current(event);
    });
  }, [renderer, isActive, manager]);
}

/**
 * Subscribe to terminal paste events for the current tree — the paste
 * counterpart of {@link useInput}. The handler receives the pasted text
 * string (the core `PasteHandler` payload). Each paste is first routed
 * through the focus manager (defaulting to the core `focusManager`): when a
 * focused element handles it (`FocusManager.routePaste` returns `true` — e.g.
 * a focused `<Input focusId>` / `<Textarea focusId>` auto-pasting into its
 * node), the tree-level handler is skipped; otherwise the handler runs,
 * mirroring the focus-first key routing. The handler is read through a ref so
 * a parent re-render with a new handler is picked up without re-subscribing.
 * Returns nothing; the subscription is torn down when the component unmounts
 * or `isActive` becomes `false`.
 */
export function usePaste(handler: UsePasteHandler, options?: UsePasteOptions): void {
  const { renderer } = useApp();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const manager = options?.focusManager ?? focusManager;
  const isActive = options?.isActive ?? true;

  useEffect(() => {
    if (!isActive) return;
    return renderer.onPaste((text) => {
      // A focused element's paste handler wins; otherwise fall back to the
      // tree-level handler.
      if (manager.routePaste(text)) return;
      handlerRef.current(text);
    });
  }, [renderer, isActive, manager]);
}