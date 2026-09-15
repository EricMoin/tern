//! The react-reconciler host config and the reconciler instance itself.

import { render } from "./hooks.ts";
import { appendTo, insertBeforeChild, removeNode, toNodeProps } from "./host.ts";
import type { HostConfig } from "./host.ts";
import type { AppHandle } from "./types.ts";
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

/** React context carrying the app handle to every component in the tree. */
export const AppContext = createContext<AppHandle | null>(null);

