
export { DiffView, Input, Panels, Select, Spinner, StatusBar, Textarea } from "./components.ts";
export type { DiffViewProps, InputProps, InputState, MenuProps, PanelsProps, SelectProps, SpinnerProps, StatusBarProps, TextareaProps } from "./components.ts";
export { BarChart, Chart, Menu, Modal, Progress, ScrollView, Sparkline, Table, Tabs, Tree } from "./data_components.ts";
export type { BarChartProps, ChartProps, ModalProps, ProgressProps, ScrollViewProps, SparklineProps, TableProps, TabsProps, TreeProps } from "./data_components.ts";
export { FocusManagerContext, useClickToFocus, useFocus, useFocusManager, useFocusTraversal, usePanelMouseDrag, useResize, useSelection, useTerminalDimensions, useWheelScroll } from "./hooks.ts";
export type { UseFocusOptions, UseFocusTraversalOptions } from "./hooks.ts";
export { Box, StreamingText, Text, ThemeContext, ThemeProvider, name, useTheme, version } from "./primitives.ts";
export type { BoxProps, StreamingTextProps, TernNodeProps, TextProps, ThemeProviderProps } from "./primitives.ts";

/**
 * @tern-tui/react — react-reconciler custom renderer for tern.
 *
 * A mutation-mode custom renderer that drives the tern scene through
 * `packages/core`:
 *
 * - `<Box>` / `<Text>` / `<StreamingText>` are the host components, backed by
 *   the core `Box(props)` / `Text(props)` / `StreamingText(props)` factories.
 *   Bare string children are rejected at render time — text lives in an
 *   explicit `<Text text="..." />` element.
 * - The roadmap host components `<Input>` / `<Spinner>` / `<StatusBar>` /
 *   `<Panels>` / `<DiffView>` / `<Select>` / `<Menu>` / `<ScrollView>` /
 *   `<Table>` /
 *   `<Tabs>` / `<Progress>` / `<Modal>` / `<BarChart>` / `<Chart>` /
 *   `<Sparkline>`
 *   materialize the core factories of the same name. `<Spinner>` runs its
 *   tick timer while mounted (cleared on unmount); `<Input>` / `<Select>` /
 *   `<Menu>` / `<Tabs>`
 *   with a `focusId` register with a `FocusManager` so routed keys edit them
 *   (`onChange` / `onSubmit`, `onChange` / `onConfirm` / `onDismiss`,
 *   `onSelect` / `onDismiss`, and
 *   `onChange` / `onClose` for tabs). `<Menu>` additionally wires the
 *   renderer's mouse events onto the core `menuHover` / `menuClick` while it
 *   is open.
 *   `<ScrollView>` is a clip/scroll region box (the engine's `clip_*` /
 *   `scroll_*` props); the core `scrollTo` / `scrollBy` / `scrollTop`
 *   helpers drive its offsets (clamped against `Node.contentSize()`),
 *   optionally with a track + thumb scrollbar leaf. `<Table>` composes a
 *   sticky header row above a scrollable content region of per-column rows;
 *   the core `tableKey` / `visibleTableRows` helpers drive its highlight and
 *   scroll window. `<Progress>` is a framed gauge (ratatui Gauge parity)
 *   driven with the core `setProgress` on its scene node. `<Modal>` is a
 *   full-bleed overlay (dimmed backdrop +
 *   centered content box) stamped with a high `z_index`; the core
 *   `openModal` / `closeModal` helpers toggle it and move focus into/out of
 *   the overlay through the `FocusManager`.
 * - `render(element, renderer)` / `createRoot(renderer)` mount a tree onto a
 *   core renderer's scene root; every commit paints the scene via
 *   `renderer.render()`.
 * - The core runtime theme engine is re-exported as `setTheme(overrides)` /
 *   `getTheme()` (M4.5): an imperative `setTheme` switch re-resolves the
 *   mounted scene in place — the host components carry their `role` /
 *   `component` hints onto the element props, the reconciler records them on
 *   the core nodes, and the core engine walks, diffs and repaints — with NO
 *   React re-render. `ThemeProvider` / `useTheme` keep their framework-driven
 *   re-render path, which takes precedence when used.
 * - `useApp()` exposes the app handle (renderer, scene root, exit/unmount);
 *   `useInput(handler)` subscribes to keyboard input for the tree, routing
 *   each key to the focused element's handler first (via the core
 *   `FocusManager`) and falling back to the tree handler. `usePaste(handler)`
 *   does the same for paste events: a paste routes to the focused element's
 *   paste handler first (a focused `<Input focusId>` / `<Textarea focusId>`
 *   auto-pastes into its node) and falls back to the tree handler.
 *   `useFocus()` hooks
 *   an arbitrary element's node into a `FocusManager`; `useFocusManager()`
 *   reads the tree's current `FocusManager` (the `FocusManagerContext`
 *   provider, or the core default `focusManager`), and `useFocusTraversal()`
 *   wires Tab / Shift+Tab to the manager's `next()` / `prev()` traversal,
 *   skipping an exclude list.
 *   `useResize(handler)` subscribes to terminal resize events, re-invoking
 *   `renderer.render()` after each so the compositor re-lays out at the new
 *   terminal size.
 *   `useTerminalDimensions()` returns the terminal's current
 *   `{ width, height }` as reactive state — seeded from `renderer.size` at
 *   mount, updated on every resize — the re-render counterpart to
 *   `useResize`.
 *   `useWheelScroll(viewRef)` maps wheel events onto a scrollable view's
 *   offsets; `useSelection()` wires mouse-drag text selection onto the
 *   renderer's native selection overlay (the core
 *   `startSelection` / `dragSelection` / `endSelection` / `copySelection`
 *   helpers — double-click word select, copy-on-release).
 *
 * See `./reconciler.ts` for the HostConfig mapping table.
 */

// ---------------------------------------------------------------------------
// Host component props
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Host components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Roadmap host components
//
// These materialize the @tern-tui/core roadmap factories (subtask 3) as React
// host elements. The React-only wiring lives in the component functions below
// (effects, refs, focus registration); the reconciler's `createInstance`
// maps the host tags to the core factories (see `./reconciler.ts`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Focus hooks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mouse hooks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { createRoot, render, useApp, useInput, usePaste } from "./reconciler.ts";
export type {
  AppHandle,
  TernContainer,
  TernNoTimeout,
  TernProps,
  TernRoot,
  TernTimeoutHandle,
  UseInputHandler,
  UseInputOptions,
  UsePasteHandler,
  UsePasteOptions,
} from "./reconciler.ts";
// The HostConfig itself is internal, but exported for tooling/tests:
export { hostConfig, toNodeProps } from "./reconciler.ts";

// Core values re-exported: the focus machinery, the element edit helpers
// used by the roadmap host components (including the paste counterparts
// `pasteInto` / `pasteIntoTextarea`, which the focused `<Input>` / `<Textarea>`
// auto-paste through), the scroll helpers (including the streaming auto-scroll
// `followTail` / `syncStreamTail` / `isStreamFollowing` / `scrollToBottom` and
// the `STREAM_AFFORDANCE_CHAR` scroll-to-bottom indicator), the panel
// drag-resize helpers, the modal helpers, the theme surface, and the M4.5
// runtime theme engine (`setTheme` / `getTheme` — an imperative switch
// re-resolves the mounted scene in place, without a React re-render).
export {
  activateTab,
  closeTab,
  closeMenu,
  closeModal,
  copySelection,
  defaultTheme,
  dragPanels,
  dragSelection,
  editKey,
  editTextareaKey,
  endPanelDrag,
  endSelection,
  focusAt,
  focusManager,
  followTail,
  FocusManager,
  getTheme,
  isStreamFollowing,
  mergeTheme,
  MENU_Z_INDEX,
  menuClick,
  menuHover,
  menuKey,
  MODAL_Z_INDEX,
  openMenu,
  openModal,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  scrollBy,
  scrollTo,
  scrollToBottom,
  scrollTop,
  selectKey,
  selectWordAt,
  SELECTION_DOUBLE_CLICK_MS,
  selectionKey,
  setProgress,
  setTheme,
  startPanelDrag,
  startSelection,
  STREAM_AFFORDANCE_CHAR,
  syncStreamTail,
  tableKey,
  tabsKey,
  tick,
  toggleTreeNode,
  expandTreeNode,
  collapseTreeNode,
  treeKey,
  visibleTreeRows,
  visibleTableRows,
  wheelScroll,
} from "@tern-tui/core";

// Core theme types re-exported so consumers can type themes without
// importing @tern-tui/core directly.
export type {
  Theme,
  ThemeComponent,
  ThemeOverrides,
  ThemeResolvableProps,
  ThemeRole,
  ThemeRoleColors,
  ThemeStylePreset,
} from "@tern-tui/core";
