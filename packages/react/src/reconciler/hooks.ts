//! The root/render entry points and the app, input and paste hooks.

import { AppContext, hostConfig } from "./host_config.ts";
import type { AppHandle, TernContainer, TernRoot, UseInputHandler, UseInputOptions, UsePasteHandler, UsePasteOptions } from "./types.ts";
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

