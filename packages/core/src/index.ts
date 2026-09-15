/**
 * @tern-tui/core — TypeScript bindings for the tern TUI engine.
 *
 * This package wraps the `tern-node` napi addon (see `src/bindings/tern-node`)
 * behind a small declarative API:
 *
 * - `createRenderer(options)` constructs a `Renderer` (a native `TuiRenderer`
 *   in raw mode + alternate screen — or, with `headless: true`, an
 *   in-memory buffer at the configured `size`, see
 *   {@link CreateRendererOptions}) and exposes the scene root as a `Node`.
 * - `Text(props)` / `Box(props, ...children)` / `StreamingText(props)` are
 *   factory functions returning `Node` objects. They are pure data (no native
 *   calls) until a node is attached under the scene root with
 *   `Node.addChild`, which materializes it in the shared scene. Spans fed
 *   to a `streaming_text` node via `Node.appendSpan` while detached are
 *   flushed to the native handle on attach. A `streaming_text` node defaults
 *   to `autoScroll: true`: `syncStreamTail` (fed by the @tern-tui/react /
 *   @tern-tui/solid stream hosts after each span) pins `scroll_y` to the content
 *   tail vs the `clip_height` viewport, a manual scroll above the tail
 *   detaches, and `followTail` re-attaches.
 * - `Input` / `Spinner` / `StatusBar` / `Panels` / `DiffView` / `Select` /
 *   `Menu` / `ScrollView` / `Table` / `Tabs` / `Progress` / `Modal` /
 *   `MarkdownView`
 *   / `Canvas` / `BarChart` / `Chart` / `Sparkline` / `HelpPanel` are
 *   roadmap
 *   element factories that compose the primitive kinds into richer widgets
 *   (all editing/caret/selection/scroll/tab math stays in the element, the
 *   Rust compositor paints it), and a
 *   `FocusManager`
 *   (with a `useFocus` helper) routes key events to the focused element's
 *   key handler — and paste events to the focused element's paste handler
 *   (`routePaste`), the routing the `usePaste` / `subscribePaste` host
 *   wiring consults. `Input`/`Textarea` also expose paste editing via
 *   {@link pasteInto} and {@link pasteIntoTextarea}, which insert pasted text
 *   at the caret (multi-width aware) — the natural handler for
 *   `Renderer.onPaste` events.
 *   `HelpPanel` renders a key-help overlay from a `Keymap`'s listings
 *   (`Keymap.register` accepts an optional human-readable description per
 *   combo, readable back via `Keymap.list()`), defaulting to the module-level
 *   `keymap`; the `help` component preset styles it.
 *   `Panels` lays its panels out with a 1-cell gutter between
 *   them; `startPanelDrag` / `dragPanels` / `endPanelDrag` implement mouse
 *   drag-resize on that gutter (an absolute `flex_basis` on the adjacent
 *   pane, clamped to the pane's min size — roadmap Phase 2). `ScrollView`
 *   is a clip/scroll region box whose offsets are driven by `scrollTo` /
 *   `scrollBy` / `scrollTop` (clamped against `Node.contentSize()` vs the
 *   viewport) with an optional track + thumb scrollbar text leaf. Mouse
 *   interaction helpers map terminal mouse events onto the widgets:
 *   `wheelScroll(view, event)` maps wheel events (`scroll_up` /
 *   `scroll_down` / `scroll_left` / `scroll_right`) to `scrollBy` on the
 *   given scrollable node, and `focusAt(renderer, event)` routes a
 *   `down_left` press on a painted cell to the topmost registered focusable
 *   node via the `FocusManager`. Mouse text selection is viewport-cell-scoped
 *   v1: `startSelection(renderer, event)` / `dragSelection(renderer, event)`
 *   / `endSelection(renderer, event)` drive a press-drag-release selection
 *   overlay (two `down_left` presses within
 *   `SELECTION_DOUBLE_CLICK_MS` ms on nearby cells select the word under the
 *   pointer via `selectWordAt`), `copySelection(renderer)` copies the
 *   selection text to the system clipboard (OSC 52), and `selectionKey`
 *   binds `ctrl+shift+c` to copy and `escape` to clear. The overlay is
 *   persistent: it survives the release (a later `copySelection` still
 *   returns the text) and is replaced by a new selection, cleared by
 *   `escape`, or deselected by a bare press outside it — plain `ctrl+c`
 *   stays the exit convention and is never consumed.
 * - A theme system: `Theme` (a named palette of fg/bg per semantic role plus
 *   per-component style presets), `defaultTheme`, `mergeTheme(base, overrides)`
 *   and `resolveTheme(theme, props)`. Resolution consumes semantic hints
 *   (`role` / `component`) from the props and stamps plain `fg` / `bg` /
 *   `border_style` onto them — the output is ordinary `NodeProps`, so no new
 *   napi surface is introduced (constitution). The `@tern-tui/react` /
 *   `@tern-tui/solid` hosts resolve automatically; raw `@tern-tui/core` users call
 *   `resolveTheme` explicitly at element-creation time. The runtime engine
 *   (`setTheme(overrides)` / `getTheme()`, the M4.5 slice) makes the theme
 *   switchable after the fact: every node created with semantic hints is
 *   re-resolved in place against the merged theme, pushing only the changed
 *   style keys through the single-key `Node.setProp` path and scheduling one
 *   coalesced repaint — a no-op switch performs zero native calls. A pure WCAG
 *   contrast checker (`parseThemeColor` / `relativeLuminance` / `contrastRatio` /
 *   `auditTheme`, see `./contrast.ts`) audits any theme's palette roles and
 *   component presets against the 4.5:1 AA bar — no engine surface.
 * - `Renderer` owns the render/input loop: `render()` (synchronous, immediate
 *   paint), `requestFrame()` (coalesced paint on the next macrotask — several
 *   calls within one tick collapse into a single native render), `size` (the
 *   viewport the last render/snapshot painted at — `{ width, height }` in
 *   cells, the current terminal size before the first paint),
 *   `setClipboard(text)` (copy to the system clipboard via OSC 52),
 *   `events` (an
 *   `AsyncIterable` of tagged `TernEventJs` events pushed from the native
 *   thread), `onKey(cb)`, `onResize(cb)`, `onFocus(cb)`, `onMouse(cb)`,
 *   `onPaste(cb)` and
 *   `destroy()`. Event delivery is push-based (roadmap Phase 3): the native
 *   binding runs a background event loop and delivers every event to the JS
 *   thread through a `ThreadsafeFunction`, so the reconciler subscribes with
 *   `for await (const event of renderer.events)` instead of polling.
 * - Scene geometry queries: `Renderer.hit_test(col, row)` returns the
 *   topmost z-ordered path of scene node ids covering a cell (for mouse
 *   routing), and `Node.contentSize()` returns a node's laid-out content
 *   width/height (wrapped line count for `text`/`streaming_text`, layout
 *   size otherwise).
 *
 * The generated napi types (`KeyEvent`, `MouseEventJs`, `TernEventJs`,
 * `TuiRendererOptions`, `TuiRenderer`, `NodeHandle`, `ContentSize`) are
 * re-exported from the binding's `index.d.ts` so consumers get the canonical
 * declaration surface.
 *
 * ## Runtime
 *
 * Deno-first: the native addon is loaded via `node:module` `createRequire`
 * (see `./addon.ts`), which Deno 2.x supports for Node-API addons when given
 * `--allow-ffi` (+ read access to the `.node` file). Node.js works unchanged.
 */

export { loadAddon, setAddonForTesting } from "./addon.ts";
export type { TernAddon } from "./addon.ts";
export { syncSemantics } from "./semantics.ts";
export type { SemanticsDescriptor } from "./semantics.ts";
export { A11Y_STREAM_VERSION, A11yStream } from "./a11y.ts";
export {
  auditTheme,
  contrastRatio,
  parseThemeColor,
  relativeLuminance,
  XTERM_256,
} from "./contrast.ts";
export type { ContrastFinding, Rgb } from "./contrast.ts";
export type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle,
  RendererCapabilities,
  RendererSize,
  SceneSemanticsJs,
  SemanticsNodeJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";

/**
 * The `hyperlink` / `underlineStyle` / `underlineColor` style surface on
 * {@link StyleRunJs}: a run whose cells carry a hyperlink reports the link
 * target as `hyperlink` (the value the engine threads from the `href` style
 * key into `Style::hyperlink`); a run whose cells carry an extended underline
 * reports `underlineStyle` (the kitty `\x1b[4:Nm` variant keyword) and
 * `underlineColor` — the values the engine threads from the
 * `underline_style` / `underline_color` style keys into
 * `Style::underline_style` / `Style::underline_color`. All three are
 * declared here — on the JS surface — alongside the binding's generated
 * fields, mirroring how the camelCase `NodeProps` aliases map to the native
 * snake_case style keys: the props are camelCase, the scene keys are
 * snake_case (`href`, `underline_style`, `underline_color`), and the painted
 * run carries the values under the camelCase names.
 */
declare module "@tern-tui/node" {
  interface StyleRunJs {
    /** The hyperlink target (a URL) the run's cells paint as an OSC 8
     * hyperlink, present only when the cells carry one. */
    hyperlink?: string;
    /** The underline style variant the run's cells paint (`"single"`,
     * `"double"`, `"curly"`, `"dotted"`, or `"dashed"`), present only when
     * the cells carry one. */
    underlineStyle?: string;
    /** The color the run's underline is painted with, present only when the
     * cells carry one. */
    underlineColor?: string;
  }
}

declare module "@tern-tui/node" {
  /**
   * The kitty keyboard protocol surface on {@link KeyEvent}, declared here
   * alongside the binding's generated fields (the same augmentation seam as
   * `StyleRunJs.hyperlink`). `kind` is `"press"` (the default — the only
   * kind a terminal without the kitty protocol reports), `"repeat"`, or
   * `"release"`; the precise modifiers are present only when held.
   */
  interface KeyEvent {
    /** The key event kind: `"press"` (default), `"repeat"`, or `"release"`.
     * On non-kitty terminals every key arrives as a press, so
     * kind-unaware handlers keep working unchanged. */
    kind?: string;
    /** Whether Super (the Windows / Command key) was held. */
    super?: boolean;
    /** Whether Meta was held. */
    meta?: boolean;
    /** Whether Hyper was held. */
    hyper?: boolean;
  }
}

export const name = "@tern-tui/core";
export const version = "0.2.0";


/**
 * The scene node kinds. `box`/`text`/`streaming_text` are materialized by the
 * binding; `input`/`textarea`/`spinner`/`status_bar`/`panels`/`diff`/`select`/
 * `checkbox`/`radio`/`toggle`/`menu`/`scroll_view`/`table`/`tree`/`tabs`/
 * `progress`/`modal`/`markdown`/`canvas`/`bar_chart`/`chart`/`sparkline` are
 * JS-only element kinds that materialize as compositions over the primitive
 * kinds (their root primitive is fixed by {@link NATIVE_KIND}).
 */

export { Canvas, brailleCell, brailleRows } from "./canvas.ts";
export type { CanvasDots, CanvasProps } from "./canvas.ts";
export { BarChart, Chart, Sparkline } from "./charts.ts";
export type { BarChartProps, ChartProps, SparklineProps } from "./charts.ts";
export { CHECKBOX_CHECKED_GLYPH, CHECKBOX_UNCHECKED_GLYPH, CHECK_PRIMARY_BG, CHECK_PRIMARY_FG, Checkbox, RADIO_SELECTED_GLYPH, RADIO_UNSELECTED_GLYPH, Radio, TOGGLE_OFF_GLYPH, TOGGLE_ON_GLYPH, Toggle, checkboxKey, checkboxLabels, radioKey, radioOptions, toggleKey, toggleLabels } from "./checkbox.ts";
export type { CheckboxProps, CheckboxState, RadioOption, RadioProps, RadioState, ToggleProps, ToggleState } from "./checkbox.ts";
export { DIFF_ADD_FG, DIFF_DEL_FG, DiffView } from "./diff.ts";
export type { DiffLine, DiffLineKind, DiffViewProps } from "./diff.ts";
export { FocusManager, focusManager, useFocus } from "./focus.ts";
export type { FocusHandle, Focusable } from "./focus.ts";
export { editHighlight, highlightCode, incrementalHighlight, resetIncrementalHighlightCache } from "./highlight.ts";
export type { HighlightEdit, HighlightEditResult } from "./highlight.ts";
export { Input, editKey, pasteInto } from "./input.ts";
export type { InputProps } from "./input.ts";
export { HelpPanel, Keymap, keymap } from "./keymap.ts";
export type { HelpPanelProps, KeyCombo } from "./keymap.ts";
export { MARKDOWN_CODE_FG, MARKDOWN_FENCE_BG, MARKDOWN_HR_CHAR, MARKDOWN_HR_WIDTH, MARKDOWN_LINK_FG, MarkdownView, STREAM_AFFORDANCE_CHAR, followTail, isStreamFollowing, scrollToBottom, setStreamAutoScroll, syncStreamTail } from "./markdown.ts";
export type { MarkdownViewProps } from "./markdown.ts";
export { MENU_Z_INDEX, Menu, closeMenu, menuClick, menuHover, menuKey, openMenu } from "./menu.ts";
export type { MenuItem, MenuProps, MenuState } from "./menu.ts";
export { MODAL_BACKDROP_BG, MODAL_Z_INDEX, Modal, closeModal, openModal } from "./modal.ts";
export type { ModalProps } from "./modal.ts";
export { focusAt, wheelScroll } from "./mouse.ts";
export { Box, Node, StreamingText, Text } from "./node.ts";
export { PANEL_DRAG_MIN_SIZE, Panels, collapsePanel, dragPanels, endPanelDrag, expandPanel, focusPanel, startPanelDrag, togglePanel } from "./panels.ts";
export type { PanelDragHandle, PanelDragResult, PanelSpec, PanelsProps } from "./panels.ts";
export { PROGRESS_DEFAULT_WIDTH, PROGRESS_EMPTY_CHAR, PROGRESS_FILL_CHAR, Progress, setProgress } from "./progress.ts";
export type { ProgressProps } from "./progress.ts";
export { Renderer, createRenderer, framesEqual, styledFramesEqual } from "./renderer.ts";
export { SCROLLBAR_THUMB_CHAR, SCROLLBAR_TRACK_CHAR, ScrollView, declareVirtualContent, scrollBy, scrollTo, scrollTop } from "./scrollview.ts";
export type { ScrollViewProps } from "./scrollview.ts";
export { SELECT_FILTER_PLACEHOLDER, Select, selectKey, selectOptions, visibleOptions } from "./select.ts";
export type { SelectOption, SelectProps, SelectState } from "./select.ts";
export { SELECTION_DOUBLE_CLICK_MS, copySelection, dragSelection, endSelection, selectWordAt, selectionKey, setSelectionClockForTesting, startSelection } from "./selection.ts";
export { DEFAULT_SPINNER_FRAMES, Spinner, tick } from "./spinner.ts";
export type { SpinnerProps } from "./spinner.ts";
export { StatusBar } from "./statusbar.ts";
export type { StatusBarProps, StatusBarSegment } from "./statusbar.ts";
export { Table, tableKey, visibleTableRows } from "./table.ts";
export type { TableColumn, TableProps, TableState } from "./table.ts";
export { TAB_ACTIVE_MARKER, TAB_CLOSE_CHAR, TAB_PRIMARY_BG, TAB_PRIMARY_FG, Tabs, activateTab, closeTab, tabsKey } from "./tabs.ts";
export type { TabSpec, TabsProps, TabsState } from "./tabs.ts";
export { Textarea, editTextareaKey, measureText, pasteIntoTextarea, wrapLineWithOffsets } from "./textarea.ts";
export type { TextareaProps, TextareaState } from "./textarea.ts";
export { THEME_COMPONENTS, THEME_ROLES, defaultTheme, getTheme, mergeTheme, resolveTheme, setTheme } from "./theme.ts";
export type { Theme, ThemeComponent, ThemeOverrides, ThemeResolvableProps, ThemeRole, ThemeRoleColors, ThemeStylePreset } from "./theme.ts";
export { TREE_COLLAPSED_GLYPH, TREE_EXPANDED_GLYPH, TREE_GUIDE_VERTICAL, Tree, collapseTreeNode, expandTreeNode, toggleTreeNode, treeKey, visibleTreeRows } from "./tree.ts";
export type { TreeNode, TreeProps, TreeRow, TreeState } from "./tree.ts";
export type { CreateRendererOptions, FocusHandler, KeyHandler, LifecycleHandler, MouseHandler, NodeProps, NodeType, PasteHandler, ResizeHandler, SelectionRange, Span } from "./types.ts";
