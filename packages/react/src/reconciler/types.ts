//! The container, root and hook types the host config and hooks share.

import { render } from "./hooks.ts";
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

