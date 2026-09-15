//! Host-tree mutations and the theme-hint transport between React and the scene.

import { INPUT_PROPS, MENU_PROPS, MODAL_PROPS, REACT_RESERVED_PROPS, SELECT_PROPS, SPINNER_PROPS, STREAMING_TEXT_PROPS, TABS_PROPS, TEXTAREA_PROPS, THEME_HINT_CARRIER, THEME_PROPS, TREE_PROPS } from "./props.ts";
import type { TernContainer, TernNoTimeout, TernProps, TernTimeoutHandle } from "./types.ts";
import Reconciler from "react-reconciler";
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

/**
 * Append `child` under `parent`. The core `Node.addChild` throws when the
 * same child instance is already recorded on that parent, but React reuses
 * host instances across updates: an `appendChild` on an already-present
 * child is a reposition to the end (DOM `appendChild` semantics — this is
 * how React realizes the trailing placements of a full list reorder), so the
 * child is detached first.
 */
export function appendTo(parent: Node, child: Node): void {
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
export function insertBeforeChild(parent: Node, child: Node, beforeChild: Node): void {
  if (parent.children.includes(child)) child.remove();
  parent.insertBefore(child, beforeChild);
}

/** Detach a child (and its subtree) from the scene; core `Node.remove()`
 * also splices the child out of its parent's children list. */
export function removeNode(child: Node): void {
  child.remove();
}

export type HostConfig = Reconciler.HostConfig<
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

