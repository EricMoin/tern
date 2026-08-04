/**
 * @tern/solid — SolidJS custom renderer for tern.
 *
 * Wires `createRenderer` from the vendored solid-js universal renderer
 * (see `./universal.ts`) with a `RendererOptions` object over the @tern/core
 * scene API. The options literal carries exactly the canonical solid-js
 * 1.9.14 `RendererOptions` key set (see
 * node_modules/solid-js/universal/types/universal.d.ts:1-12 and the
 * solidjs/solid universal README): createElement, createTextNode,
 * replaceText, isTextNode, setProperty, insertNode, removeNode,
 * getParentNode, getFirstChild, getNextSibling — nothing more. The
 * renderer's returned `setProp` is supplied by solid's runtime from the
 * canonical `setProperty`, and in-parent replacement (`replaceNode`) is
 * exposed as a standalone convenience helper below rather than as an
 * options key:
 *
 * - `createElement(type)`        -> tern node factory (`Box`/`Text`/`StreamingText`
 *   and the roadmap elements `Input`/`Spinner`/`StatusBar`/`Panels`/`DiffView`/`Select`
 *   /`ScrollView`/`Table`/`Tabs`/`Progress`/`Modal`)
 * - `createTextNode(value)`      -> `Text` node
 * - `replaceText`/`isTextNode`   -> text content re-point / type check
 * - `insertNode`/`removeNode`    -> tree ops (`Node.insertBefore`/`Node.addChild` / `Node.remove`)
 * - `replaceNode` (convenience)  -> position-accurate in-parent replacement
 * - `setProperty`                -> `Node.setProps` (feeds the runtime's `setProp`/`spread`)
 * - `getParentNode`/`getFirstChild`/`getNextSibling` -> tree traversal
 *   (best-effort: @tern/core `Node` exposes `children` but no parent/sibling
 *   accessors, so a `WeakMap` registry records parents as nodes are inserted)
 *
 * Anchor-based insertion and position-accurate replacement are wired;
 * reactive diffing against the native scene is deferred to post-MVP.
 *
 * The universal renderer is vendored (`./universal.ts`) because Deno/Node
 * resolve the bare `solid-js` specifier to its *server* build (no reactive
 * runtime); the vendored copy's `solid-js` import resolves through the
 * package import map (deno.json) to the client build, so signal-driven
 * updates actually reach the scene ops.
 *
 * The roadmap element factories (`Input`/`Textarea`/`Spinner`/`StatusBar`/
 * `Panels`/`DiffView`/`Select`/`ScrollView`/`Table`/`Tabs`/`Progress`/`Modal`)
 * materialize
 * the @tern/core factories of the same name, matching what the `@tern/react`
 * host components map to (feature parity): same props -> same scene node
 * structure. The `Textarea` factory additionally mirrors the `<Textarea>`
 * host's focus wiring: a `focusId` prop registers the node with a
 * `FocusManager` (routed keys edit it via `editTextareaKey`), firing
 * `onChange` / `onSubmit` — the registration is disposed with
 * `disposeTextareaFocus`.
 * The `Tabs` factory mirrors the `<Tabs>` host's focus wiring the same way
 * (registered with `disposeTabsFocus`).
 * `subscribeInput` wires a renderer's key events through the core
 * `FocusManager` (the Solid-flavored `useInput` equivalent — Solid has no
 * context, so the renderer is an explicit argument); `subscribePaste` wires a
 * renderer's paste events the same way (the Solid-flavored `usePaste`
 * equivalent): each paste routes to the focused element's paste handler
 * first — a focused `Input` / `Textarea` (registered with an `onPaste`
 * handler via the core `useFocus`, or the `Textarea` factory's `focusId`
 * wiring) auto-pastes into its node — and falls back to the tree handler.
 * `subscribeResize` wires
 * a renderer's terminal resize events to a handler, re-invoking
 * `renderer.render()` after each so the compositor re-lays out at the new
 * terminal size (the Solid-flavored `useResize` equivalent). `subscribeFocus`
 * wires a renderer's terminal focus events (`{ focus_gained }`) to a handler,
 * and `subscribeFocusTraversal` wires a renderer's Tab / Shift+Tab keys to
 * the focus manager's `next()` / `prev()` traversal, skipping an exclude list
 * (the Solid-flavored `useFocusTraversal` equivalent).
 * `startSpinner` drives a spinner node's frame ticks with a focus-aware
 * timer — pausing while the terminal is unfocused, resuming on regain (the
 * `@tern/react` `<Spinner>` effect equivalent, roadmap Phase 2).
 */

import {
  createRenderer,
  type RendererOptions,
} from "./universal.ts";
import {
  Box as TernBox,
  DiffView as TernDiffView,
  Input as TernInput,
  Modal as TernModal,
  Panels as TernPanels,
  Progress as TernProgress,
  ScrollView as TernScrollView,
  Select as TernSelect,
  Spinner as TernSpinner,
  StatusBar as TernStatusBar,
  StreamingText as TernStreamingText,
  Table as TernTable,
  Tabs as TernTabs,
  Text as TernText,
  Textarea as TernTextarea,
  defaultTheme,
  dragPanels,
  editTextareaKey,
  endPanelDrag,
  focusAt,
  focusManager,
  followTail,
  isStreamFollowing,
  startPanelDrag,
  FocusManager,
  mergeTheme,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  scrollBy,
  scrollTo,
  scrollTop,
  setStreamAutoScroll,
  syncStreamTail,
  tableKey,
  tabsKey,
  tick,
  useFocus,
  visibleTableRows,
  wheelScroll,
  type DiffViewProps,
  type FocusHandle,
  type FocusHandler,
  type InputProps,
  type KeyHandler,
  type ModalProps,
  type Node,
  type NodeProps,
  type PanelDragHandle,
  type PanelDragResult,
  type PanelsProps,
  type PasteHandler,
  type ProgressProps,
  type Renderer,
  type ResizeHandler,
  type ScrollViewProps,
  type SelectProps,
  type Span,
  type SpinnerProps,
  type StatusBarProps,
  type TableColumn,
  type TableProps,
  type TableState,
  type TabSpec,
  type TabsProps as CoreTabsProps,
  type TabsState,
  type TextareaProps as CoreTextareaProps,
  type TextareaState,
  type Theme,
  type ThemeOverrides,
} from "@tern/core";

export const name = "@tern/solid";
export const version = "0.1.0";

// The @tern/core types the factories and focus wiring expose, re-exported so
// consumers can type elements, props, focus handles and input handlers without
// importing @tern/core directly (the same surface @tern/react re-exports).
export type {
  DiffLine,
  DiffViewProps,
  FocusHandle,
  FocusHandler,
  InputProps,
  KeyEvent,
  KeyHandler,
  ModalProps,
  Node,
  NodeProps,
  PanelDragHandle,
  PanelDragResult,
  PanelSpec,
  PanelsProps,
  PasteHandler,
  ProgressProps,
  Renderer,
  ResizeHandler,
  ScrollViewProps,
  SelectOption,
  SelectProps,
  SelectState,
  Span,
  SpinnerProps,
  StatusBarProps,
  StatusBarSegment,
  TableColumn,
  TableProps,
  TableState,
  TabSpec,
  TabsState,
  TextareaState,
} from "@tern/core";

// The @tern/core values behind the roadmap elements and the focus wiring:
// element edit/drive helpers (including the paste counterparts `pasteInto` /
// `pasteIntoTextarea`, which a focused `Input` / `Textarea` auto-pastes
// through), the scroll helpers (including the streaming auto-scroll
// `followTail` / `syncStreamTail` / `isStreamFollowing` / `scrollToBottom` and
// the `STREAM_AFFORDANCE_CHAR` scroll-to-bottom indicator), the panel
// drag-resize helpers, the modal helpers, the focus machinery, and the
// theme surface.
export {
  activateTab,
  closeModal,
  closeTab,
  collapsePanel,
  defaultTheme,
  dragPanels,
  editKey,
  editTextareaKey,
  endPanelDrag,
  expandPanel,
  focusAt,
  followTail,
  focusManager,
  focusPanel,
  isStreamFollowing,
  FocusManager,
  mergeTheme,
  MODAL_Z_INDEX,
  openModal,
  pasteInto,
  pasteIntoTextarea,
  resolveTheme,
  scrollBy,
  scrollTo,
  scrollToBottom,
  scrollTop,
  selectKey,
  setProgress,
  startPanelDrag,
  STREAM_AFFORDANCE_CHAR,
  syncStreamTail,
  tableKey,
  tabsKey,
  tick,
  togglePanel,
  useFocus,
  visibleTableRows,
  wheelScroll,
} from "@tern/core";

// The @tern/core theme types, re-exported so consumers can type themes
// without importing @tern/core directly.
export type {
  Theme,
  ThemeComponent,
  ThemeOverrides,
  ThemeResolvableProps,
  ThemeRole,
  ThemeRoleColors,
  ThemeStylePreset,
} from "@tern/core";

// ---------------------------------------------------------------------------
// Theme
//
// Solid has no React-style context, so the theme is module-level state: the
// element factories below resolve their `role` / `component` hints against
// the active theme (see {@link getTheme}) at element-creation time, and
// `setTheme` swaps it. The active theme always merges over the core
// `defaultTheme`, so partial themes keep the default palette/presets.
// ---------------------------------------------------------------------------

/** The active theme resolved by the element factories. */
let activeTheme: Theme = defaultTheme;

/**
 * Set the active theme merged over the core `defaultTheme` (`mergeTheme`):
 * a partial theme keeps the default palette and presets for everything it
 * does not override. Subsequent element-creation resolves against the new
 * theme — the Solid-flavored `ThemeProvider` equivalent.
 */
export function setTheme(theme: ThemeOverrides): void {
  activeTheme = mergeTheme(defaultTheme, theme);
}

/** The active theme currently resolved by the element factories. */
export function getTheme(): Theme {
  return activeTheme;
}

/**
 * Apply a single prop to a tern scene node. @tern/core's `Node.setProps`
 * replaces the whole prop map, so each write merges over the node's current
 * props. This is the single funnel behind the options' `setProperty` and,
 * transitively, the renderer's returned `setProp`/`spread`.
 */
function applyProp(node: Node, prop: string, value: unknown): void {
  node.setProps({ ...node.props, [prop]: value });
}

/**
 * Best-effort parent registry. @tern/core `Node` exposes `children` but no
 * parent/sibling accessors (its `#parent` link is private), so `insertNode`
 * records the parent here and the traversal callbacks read from it. Entries
 * are dropped on `removeNode`; the children lists themselves are kept in sync
 * by @tern/core's `Node.remove()`, which splices the removed node out of its
 * parent's `children` list.
 */
const parentMap = new WeakMap<Node, Node>();

/**
 * The `RendererOptions<Node>` object handed to `createRenderer`
 * (`solid-js/universal`). Every tree mutation funnels into the @tern/core
 * `Node` API.
 *
 * The literal exposes exactly the canonical solid-js 1.9.14
 * `RendererOptions` key set (see
 * node_modules/solid-js/universal/types/universal.d.ts:1-12): createElement,
 * createTextNode, replaceText, isTextNode, setProperty, insertNode,
 * removeNode, getParentNode, getFirstChild, getNextSibling. The two
 * tern-side aliases the skeleton used to carry (`setProp`, `replaceNode`)
 * are gone: solid's runtime derives `setProp` from `setProperty`, and
 * `replaceNode` is a standalone convenience exported below (it is not part
 * of solid's interface). The literal is annotated with the interface type so
 * non-canonical keys are rejected at compile time.
 */
const options: RendererOptions<Node> = {
  /** `createElement(type)` -> tern node factory. */
  createElement(tag: string): Node {
    switch (tag) {
      case "box":
        return TernBox();
      case "text":
        return TernText();
      case "streaming_text":
        return TernStreamingText();
      case "input":
        return TernInput();
      case "textarea":
        return TernTextarea();
      case "spinner":
        return TernSpinner();
      case "status_bar":
        return TernStatusBar();
      case "panels":
        // `panels` is the one required prop of the core factory; an empty
        // spec list yields a valid, empty stack.
        return TernPanels({ panels: [] });
      case "diff":
        // `hunks` is the one required prop of the core factory; an empty
        // line list yields a valid, empty diff.
        return TernDiffView({ hunks: [] });
      case "select":
        // `options` is the one required prop of the core factory; an empty
        // option list yields a valid, empty dropdown.
        return TernSelect({ options: [] });
      case "scroll_view":
        return TernScrollView({});
      case "table":
        // `columns` / `rows` are required props of the core factory; empty
        // model lists yield a valid, empty table.
        return TernTable({ columns: [], rows: [] });
      case "tabs":
        // `tabs` is the one required prop of the core factory; an empty
        // spec list yields a valid, empty tabs (bar + empty region).
        return TernTabs({ tabs: [] });
      case "progress":
        // No required props; the defaults yield an empty framed gauge.
        return TernProgress({});
      case "modal":
        // No required props; the default yields a closed, empty overlay.
        return TernModal({});
      default:
        throw new Error(
          `@tern/solid: unknown element type "${tag}" (expected "box", "text", "streaming_text", "input", "textarea", "spinner", "status_bar", "panels", "diff", "select", "scroll_view", "table", "tabs", "progress", or "modal")`,
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
   * `insertNode` -> tree op, anchor-accurate.
   *
   * With a non-null `anchor` the node is inserted immediately before it via
   * `Node.insertBefore` (the @tern/core equivalent of the DOM
   * `parent.insertBefore(node, anchor)` the solid-js universal docs use);
   * without an anchor the node is appended via `Node.addChild`. The parent
   * registry is updated so traversal callbacks work.
   *
   * Note: solid's array reconciliation can re-insert an already-present
   * child (a move), which @tern/core's `insertBefore` rejects — true move
   * semantics need a native scene move op and are post-MVP.
   */
  insertNode(parent: Node, node: Node, anchor?: Node): void {
    parentMap.set(node, parent);
    if (anchor != null) {
      parent.insertBefore(node, anchor);
    } else {
      parent.addChild(node);
    }
  },

  /**
   * `removeNode` -> tree op. Detaches the node's subtree from the scene and
   * keeps the local bookkeeping consistent: the registry entry is dropped
   * first (so `getParentNode` stops resolving the node even when the core
   * remove no-ops), then `Node.remove()` splices the node out of its
   * parent's `children` list — so `getFirstChild`/`getNextSibling` skip
   * removed nodes and stay correct after removals.
   */
  removeNode(_parent: Node, node: Node): void {
    parentMap.delete(node);
    node.remove();
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
 * Position-accurate in-parent replacement convenience. NOT a solid-js
 * `RendererOptions` key — the v1.9.14 interface has no `replaceNode`; solid's
 * runtime performs its own internal replacement as `insertNode(parent,
 * newNode, oldNode)` followed by `removeNode(parent, oldNode)` (see
 * node_modules/solid-js/universal/dist/universal.js:184-187). This helper
 * mirrors that canonical sequence on the module surface:
 *
 * `node` is inserted immediately before `replacedNode` (anchor-accurate, via
 * the options' `insertNode`), then `replacedNode` is detached. The new node
 * is registered under the replaced node's recorded parent and occupies the
 * replaced node's slot in `parent.children`. When the replaced node has no
 * recorded parent this is a no-op — there is nowhere to place the new node.
 * `node` must not already be a child of that parent (same constraint as
 * `Node.insertBefore`).
 *
 * @tern/core's `Node.remove()` splices the removed node out of its parent's
 * `children` list, so the replacement is fully reflected in the local
 * bookkeeping: after the swap, `parent.children` holds the new node exactly
 * where the replaced node was, and the traversal callbacks
 * (`getFirstChild`/`getNextSibling`) agree with the scene.
 */
export function replaceNode(node: Node, replacedNode: Node): void {
  if (node === replacedNode) return;
  const parent = parentMap.get(replacedNode);
  if (parent === undefined) return;
  options.insertNode(parent, node, replacedNode);
  parentMap.delete(replacedNode);
  replacedNode.remove();
}

/**
 * The configured universal renderer. `render(code, node)` mounts a scene under
 * `node`; the destructured primitives below are the standard custom-renderer
 * surface (same shape solid-js/universal exports for its own DOM renderer).
 */
const renderer = createRenderer(options);

/**
 * The `RendererOptions` object wired into `createRenderer` above, exported so
 * tests (and embedders) can exercise the tree-op callbacks directly —
 * `replaceText`, `isTextNode`, `setProperty`, `insertNode` (with anchor),
 * `getParentNode`/`getFirstChild`/`getNextSibling` are reachable only
 * through the options object, not the renderer surface. It carries exactly
 * the canonical solid-js 1.9.14 `RendererOptions` key set — nothing more.
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
 * funnels into `Node.setProps` (props) and `Node.addChild`/`Node.insertBefore`
 * (children). The active theme is resolved onto the props at element-creation
 * time (`role` / `component` hints become plain `fg` / `bg` / `border_style`).
 */
export function Box(props: NodeProps = {}): Node {
  const node = createElement("box");
  spread(node, resolveTheme(getTheme(), props));
  return node;
}

/**
 * Create a `text` scene node through the solid renderer. Props (e.g.
 * `{ text: "hi" }`) are applied via the renderer's `spread`. The active
 * theme is resolved onto the props at element-creation time.
 */
export function Text(props: NodeProps = {}): Node {
  const node = createElement("text");
  spread(node, resolveTheme(getTheme(), props));
  return node;
}

/**
 * Create a `streaming_text` scene node through the solid renderer. Props are
 * applied via the renderer's `spread`. The active theme is resolved onto the
 * props at element-creation time. The node's stream is fed with
 * `subscribeStream` (or directly via `Node.appendSpan`); spans appended
 * while the node is detached are recorded and flushed to the native handle
 * in call order when the node is attached (see `@tern/core`).
 *
 * The `autoScroll` key is a component behavior flag (default `true`): the
 * node registers itself as following its content tail, and each appended
 * span (via `subscribeStream`, which feeds `syncStreamTail`) pins `scroll_y`
 * to the tail offset — `Node.contentSize()` height vs the `clip_height`
 * viewport. A manual scroll above the tail (via `scrollTo` / `scrollBy` /
 * `scrollTop`) detaches the follow, pins the view, and stamps the `▼`
 * scroll-to-bottom affordance; `followTail` re-attaches and `scrollToBottom`
 * jumps to the tail, both dismissing it. The key is consumed and never
 * reaches the scene props.
 */
export function StreamingText(props: NodeProps = {}): Node {
  const node = createElement("streaming_text");
  const plain = { ...props };
  const autoScroll = plain.autoScroll !== false;
  delete plain.autoScroll;
  spread(node, resolveTheme(getTheme(), plain));
  setStreamAutoScroll(node, autoScroll);
  return node;
}

// ---------------------------------------------------------------------------
// Roadmap element factories
//
// These materialize the @tern/core roadmap factories (subtask 3) with the same
// props, giving @tern/solid feature parity with the @tern/react host
// components: same props -> same scene node structure (the @tern/react
// `hostConfig.createInstance` maps the host tags to these same core factories
// — see packages/react/src/reconciler.ts). Unlike the primitives above, they
// call the core factories directly with the full props rather than
// `createElement` + `spread`: the composition (an input's text leaf, a
// spinner's rendered text, a status bar's segment children, a panels element's
// panel boxes) is derived *at creation* from the full props, and `setProps`
// (what `spread` funnels into) cannot rebuild it. `createElement` with the
// roadmap tags still materializes the core factories — as empty elements, for
// the renderer surface — but stateful elements are built with these
// factories.
// ---------------------------------------------------------------------------

/**
 * Create an `input` scene node: the core `Input` factory materialized with
 * `props` — a framed box with a text leaf carrying the value and caret (and
 * a dim placeholder when the value is empty). The `input` component preset is
 * resolved onto the framed box at element-creation time. Edit it with
 * `editKey` (the focused-element handler wired by `useFocus` +
 * `subscribeInput`).
 */
export function Input(props: InputProps = {}): Node {
  return TernInput(resolveTheme(getTheme(), { ...props, component: "input" }));
}

/**
 * Props for the solid `Textarea` factory: the core textarea props plus the
 * focus/callback wiring, mirroring the `@tern/react` `<Textarea>` host
 * component. `focusId` / `focusManager` / `onChange` / `onSubmit` are
 * consumed by the factory — they never reach the scene node; the remaining
 * keys flow to the core `Textarea` factory (the `lines` / `row` / `col` /
 * `width` / `height` / `scroll` edit-model props).
 */
export interface TextareaProps extends CoreTextareaProps {
  /**
   * Register the textarea with a `FocusManager` under this id so routed keys
   * (via `subscribeInput`) edit it through the core `editTextareaKey`. Omit
   * to leave the textarea inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the core
   *  `focusManager`). */
  focusManager?: FocusManager;
  /** Fired after a routed key changes the lines, row or col. */
  onChange?: (state: TextareaState) => void;
  /** Fired when the Enter key routes to this textarea (which also splits the
   *  line). */
  onSubmit?: (state: TextareaState) => void;
}

/** The focus handles of textareas registered by the {@link Textarea} factory
 * (keyed by node, like the core `textareaVertical` map). The factory owns the
 * registration; the caller owns the node's lifecycle, so it disposes the
 * registration with {@link disposeTextareaFocus} when the node leaves the
 * scene. */
const textareaFocus = new WeakMap<Node, FocusHandle>();

/**
 * Dispose a textarea's focus registration. The {@link Textarea} factory
 * registers the node with its `FocusManager` under `focusId` at creation; the
 * registration is released here — unregistering the id and clearing the
 * active focus — when the node is discarded. A node registered without a
 * `focusId` (or already disposed) is a no-op.
 */
export function disposeTextareaFocus(node: Node): void {
  textareaFocus.get(node)?.dispose();
  textareaFocus.delete(node);
}

/**
 * Create a `textarea` scene node: the core `Textarea` factory materialized
 * with `props` — a framed box with one text leaf per visible display line
 * (soft-wrapped at `width`, vertically scrolled to keep the caret visible
 * within `height`), the caret's leaf carrying its `caret` display column. The
 * `textarea` component preset is resolved onto the framed box at
 * element-creation time.
 *
 * When `focusId` is given, the textarea registers with the `FocusManager`
 * (the `focusManager` prop, defaulting to the core `focusManager`) — the
 * Solid-flavored equivalent of the `@tern/react` `<Textarea focusId>`
 * registration. Routed keys (via `subscribeInput`) edit it through the core
 * `editTextareaKey`: `onChange` fires after the lines/row/col change and
 * `onSubmit` on Enter (which splits the line). Routed paste events (via
 * `subscribePaste`) auto-paste into the node through the core
 * `pasteIntoTextarea` while the textarea is focused: `onChange` fires after
 * the paste changes the lines/row/col (a pasted `\n` splits into new logical
 * lines). Dispose the registration with {@link disposeTextareaFocus} when the
 * node leaves the scene.
 */
export function Textarea(props: TextareaProps = {}): Node {
  // The focus/callback keys are component-consumed (mirroring `@tern/react`'s
  // `TEXTAREA_PROPS` stripping): they must never reach the core factory, or
  // they would leak onto the scene node's props.
  const { focusId, focusManager: manager, onChange, onSubmit, ...nodeProps } = props;
  const node = TernTextarea(resolveTheme(getTheme(), { ...nodeProps, component: "textarea" }));
  if (focusId !== undefined) {
    const handle = useFocus(focusId, node, (event) => {
      const before = node.props as TextareaProps;
      const next = editTextareaKey(node, event);
      const changed =
        next.lines !== before.lines || next.row !== before.row || next.col !== before.col;
      if (event.name === "enter") {
        onSubmit?.(next);
      } else if (changed) {
        onChange?.(next);
      }
    }, manager, (text) => {
      // A routed paste auto-pastes into the focused textarea
      // (pasteIntoTextarea splits pasted newlines into logical lines) and
      // reports the new state, mirroring a char-key edit. An empty paste is
      // a no-op (the lines are unchanged).
      const before = node.props as TextareaProps;
      const next = pasteIntoTextarea(node, text);
      const changed =
        next.lines !== before.lines || next.row !== before.row || next.col !== before.col;
      if (changed) onChange?.(next);
    });
    textareaFocus.set(node, handle);
  }
  return node;
}

/**
 * Create a `spinner` scene node: the core `Spinner` factory materialized with
 * `props` — a text leaf rendering a determinate `'▓'`/`'░'` progress bar
 * (from `value`/`max`/`width`) or an indeterminate frame glyph (from
 * `frames`/`frame`). The `spinner` component preset is resolved onto the
 * leaf at element-creation time. Advance it with `tick` on an interval.
 */
export function Spinner(props: SpinnerProps = {}): Node {
  return TernSpinner(resolveTheme(getTheme(), { ...props, component: "spinner" }));
}

/**
 * Create a `status_bar` scene node: the core `StatusBar` factory materialized
 * with `props` — a single-row flex strip whose children are the left/center/
 * right segment `Text` nodes. The `status_bar` component preset is resolved
 * onto the strip at element-creation time. The segment keys are lifted out
 * of the strip's props by the core factory.
 */
export function StatusBar(props: StatusBarProps = {}): Node {
  return TernStatusBar(resolveTheme(getTheme(), { ...props, component: "status_bar" }));
}

/**
 * Create a `panels` scene node: the core `Panels` factory materialized with
 * `props` — a flex stack of panel boxes, each with a header `Text` and a body
 * node (the active panel's header is bold). The `panels` component preset is
 * resolved onto the stack at element-creation time. Manage panels with
 * `collapsePanel`/`expandPanel`/`togglePanel`/`focusPanel`.
 */
export function Panels(props: PanelsProps): Node {
  return TernPanels(resolveTheme(getTheme(), { ...props, component: "panels" }) as PanelsProps);
}

/**
 * Create a `diff` scene node: the core `DiffView` factory materialized with
 * `props` — a scrollable column of per-line rows (a dimmed gutter with the
 * old/new line numbers, a `+`/`-`/` ` marker, and the line content styled per
 * kind: added green, deleted red, context dimmed). `scroll_x` / `scroll_y`
 * pan the rows inside the clip region; `wrap` passes through to each content
 * leaf. The `diff` component preset is resolved onto the root box at
 * element-creation time.
 */
export function DiffView(props: DiffViewProps): Node {
  return TernDiffView(resolveTheme(getTheme(), { ...props, component: "diff" }) as DiffViewProps);
}

/**
 * Create a `select` scene node: the core `Select` factory materialized with
 * `props` — a flex column of text leaves (a filter row, one option row per
 * visible option, and in multi mode a selected-count summary row; the
 * highlighted row is reversed, multi-mode rows `✓ `/`  `-prefixed). The
 * `select` component preset is resolved onto the root box at
 * element-creation time. Drive it with `selectKey` (the focused-element
 * handler wired by `useFocus` + `subscribeInput`); a `floating` dropdown
 * stamps the root box's `z_index` prop.
 */
export function Select(props: SelectProps): Node {
  return TernSelect(resolveTheme(getTheme(), { ...props, component: "select" }) as SelectProps);
}

/**
 * Create a `scroll_view` scene node: the core `ScrollView` factory
 * materialized with `props` — a clip/scroll region box carrying the engine's
 * `clip_x` / `clip_y` / `clip_width` / `clip_height` and `scroll_x` /
 * `scroll_y` props, with the content nodes passed via the `children` prop
 * (the core factory attaches them, mirroring how `Panels` attaches body
 * nodes) and an optional track + thumb scrollbar leaf. The `scroll_view`
 * component preset is resolved onto the box at element-creation time. Drive
 * the offsets with `scrollTo` / `scrollBy` / `scrollTop`.
 */
export function ScrollView(props: ScrollViewProps = {}): Node {
  return TernScrollView(resolveTheme(getTheme(), { ...props, component: "scroll_view" }) as ScrollViewProps);
}

/**
 * Create a `table` scene node: the core `Table` factory materialized with
 * `props` — a flex column of box/text leaves (a sticky header row painted
 * above a scrollable content region, and one row leaf per data row with
 * per-column width/alignment; the highlighted row reversed). The `table`
 * component preset is resolved onto the root box at element-creation time.
 * Drive it with `tableKey` (up/down move the highlight and auto-scroll the
 * content region); read the visible window with `visibleTableRows`.
 */
export function Table(props: TableProps): Node {
  return TernTable(resolveTheme(getTheme(), { ...props, component: "table" }) as TableProps);
}

/**
 * Create a `modal` scene node: the core `Modal` factory materialized with
 * `props` — a full-bleed overlay (a dimmed backdrop box plus a centered
 * content box holding the `content` nodes) stamped with a high `z_index` so
 * it paints above in-flow content. The visible state starts from `open`
 * (default `false` — hidden); drive it with `openModal` / `closeModal`,
 * which also move focus into/out of the overlay through the
 * `FocusManager`.
 */
export function Modal(props: ModalProps = {}): Node {
  return TernModal(resolveTheme(getTheme(), props) as ModalProps);
}

/**
 * Props for the solid `Tabs` factory: the core tabs props plus the
 * focus/callback wiring, mirroring the `@tern/react` `<Tabs>` host component.
 * `focusId` / `focusManager` / `onChange` / `onClose` are consumed by the
 * factory — they never reach the scene node; the remaining keys flow to the
 * core `Tabs` factory (the `tabs` spec list and the `active` / `closable`
 * state props).
 */
export interface TabsProps extends CoreTabsProps {
  /**
   * Register the tabs with a `FocusManager` under this id so routed keys
   * (via `subscribeInput`) drive it through the core `tabsKey`. Omit to
   * leave the tabs inert to keys.
   */
  focusId?: string;
  /** The `FocusManager` to register with (defaults to the core
   *  `focusManager`). */
  focusManager?: FocusManager;
  /** Fired after a routed key moves the active tab. */
  onChange?: (state: TabsState) => void;
  /** Fired after `ctrl+w` routes to the tabs and closes the active tab. */
  onClose?: (state: TabsState) => void;
}

/** The focus handles of tabs nodes registered by the {@link Tabs} factory
 * (keyed by node, like the `textareaFocus` map). The factory owns the
 * registration; the caller owns the node's lifecycle, so it disposes the
 * registration with {@link disposeTabsFocus} when the node leaves the
 * scene. */
const tabsFocus = new WeakMap<Node, FocusHandle>();

/**
 * Dispose a tabs node's focus registration. The {@link Tabs} factory
 * registers the node with its `FocusManager` under `focusId` at creation; the
 * registration is released here — unregistering the id and clearing the
 * active focus — when the node is discarded. A node registered without a
 * `focusId` (or already disposed) is a no-op.
 */
export function disposeTabsFocus(node: Node): void {
  tabsFocus.get(node)?.dispose();
  tabsFocus.delete(node);
}

/**
 * Create a `tabs` scene node: the core `Tabs` factory materialized with
 * `props` — a flex column of box/text leaves (a tab bar row, one `Text` leaf
 * per tab with the active tab painted with the theme's `primary` palette
 * colors and reversed and prefixed with a top-border marker, closable tabs
 * carrying a close glyph; plus a content region box holding the active tab's
 * content nodes).
 *
 * When `focusId` is given, the tabs register with the `FocusManager` (the
 * `focusManager` prop, defaulting to the core `focusManager`) — the
 * Solid-flavored equivalent of the `@tern/react` `<Tabs focusId>`
 * registration. Routed keys (via `subscribeInput`) drive it through the core
 * `tabsKey`: `left` / `right` move the active tab (clamped), `ctrl+tab` /
 * `ctrl+shift+tab` wrap to the next / previous tab, and `ctrl+w` closes the
 * active tab — `onChange` fires after the active tab moves, `onClose` after
 * a close. Dispose the registration with {@link disposeTabsFocus} when the
 * node leaves the scene.
 */
export function Tabs(props: TabsProps): Node {
  // The focus/callback keys are component-consumed (mirroring `@tern/react`'s
  // `TABS_PROPS` stripping): they must never reach the core factory, or they
  // would leak onto the scene node's props.
  const { focusId, focusManager: manager, onChange, onClose, ...nodeProps } = props;
  const node = TernTabs(resolveTheme(getTheme(), nodeProps) as CoreTabsProps);
  if (focusId !== undefined) {
    const handle = useFocus(focusId, node, (event) => {
      const before = node.props as TabsProps;
      const beforeActive = typeof before.active === "number" ? before.active : 0;
      const barBefore = node.children[0]?.children.length ?? 0;
      const next = tabsKey(node, event);
      // A ctrl+w close shrinks the tab bar (tabsKey rebuilds the
      // composition); any other routed key leaves the bar count alone.
      const closed = (node.children[0]?.children.length ?? 0) < barBefore;
      if (closed) {
        onClose?.(next);
      } else if (next.active !== beforeActive) {
        onChange?.(next);
      }
    }, manager);
    tabsFocus.set(node, handle);
  }
  return node;
}

/**
 * Create a `progress` scene node: the core `Progress` factory materialized
 * with `props` — a framed box (ratatui Gauge parity, the frame defaulting to
 * `border_style: "plain"`) holding an in-flow fill leaf (`'▓'` ×
 * `ceil(value/max * inner_width)`, `'░'` for the rest), an optional dimmed
 * label leaf left-aligned inside the bar area (composed only when it fits
 * alongside the readout), and an optional percentage readout
 * (`ceil(value/max*100)%`) right-aligned inside it. A `ratio` prop (0..1)
 * drives the bar directly as an alternative to `value`/`max`. The `progress`
 * component preset is resolved onto the frame's props at element-creation
 * time. Drive a live bar without rebuilding with `setProgress` (re-exported
 * by this package).
 */
export function Progress(props: ProgressProps = {}): Node {
  return TernProgress(resolveTheme(getTheme(), { ...props, component: "progress" }) as ProgressProps);
}

/**
 * Subscribe an `AsyncIterable<Span>` to a `streaming_text` node.
 *
 * Consumes `stream` in the background, appending each span to `node` via
 * `Node.appendSpan` as it arrives. Spans appended while the node is detached
 * are recorded and flushed to the native handle on attach. After each append
 * the core auto-scroll is fed (`syncStreamTail`): a node created with
 * `autoScroll` (the default) keeps its `scroll_y` pinned to the stream tail
 * (`Node.contentSize()` height vs the `clip_height` viewport) until a manual
 * scroll above the tail detaches it — stamping the `▼` scroll-to-bottom
 * affordance at the clip region's bottom-right — and `followTail` (re-attach)
 * or `scrollToBottom` (one-shot jump to the tail, exported by this package)
 * dismiss it.
 *
 * Returns a disposer that cancels the subscription. It marks the pump
 * stopped and calls `return()` on the active iterator, so generators
 * suspended at a yield point terminate promptly (their `finally` blocks run)
 * and the pump's pending `next()` settles. Note that an async generator
 * parked on an internal `await` only processes `return()` once it next
 * suspends at a yield; spans it produces after disposal are dropped, never
 * appended — the disposer guarantees no further appends regardless.
 *
 * A source error ends the subscription quietly (no unhandled rejection);
 * spans already appended remain on the node.
 */
export function subscribeStream(
  node: Node,
  stream: AsyncIterable<Span>,
): () => void {
  let cancelled = false;
  let iterator: AsyncIterator<Span> | undefined;

  const pump = async (): Promise<void> => {
    try {
      iterator = stream[Symbol.asyncIterator]();
      while (!cancelled) {
        const result = await iterator.next();
        if (result.done) break;
        node.appendSpan(result.value.text, result.value.style);
        // Auto-scroll: keep the view pinned to the growing stream tail when
        // following (a no-op while detached, when `autoScroll` is off, or
        // after a manual scroll detached the follow).
        syncStreamTail(node);
      }
    } catch {
      // A source error ends the subscription; nothing further to append.
    } finally {
      iterator = undefined;
    }
  };

  void pump();

  return () => {
    cancelled = true;
    iterator?.return?.();
  };
}

// ---------------------------------------------------------------------------
// Input / focus routing
// ---------------------------------------------------------------------------

/** Options for {@link subscribeInput}. */
export interface SubscribeInputOptions {
  /** When `false`, the subscription is not established (default `true`). */
  isActive?: boolean;
  /**
   * The `FocusManager` consulted before the handler: when it routes the key
   * to a focused element (`FocusManager.routeKey` returns `true`), the
   * handler is skipped. Defaults to the core `focusManager`.
   */
  focusManager?: FocusManager;
}

/**
 * Subscribe `handler` to a renderer's key events, routing each key through
 * the core `FocusManager` first — the Solid-flavored `useInput` equivalent.
 * Solid has no React-style context, so the renderer is an explicit argument
 * (the `@tern/react` `useInput` reads it from the tree context instead).
 *
 * Each key is first routed via `manager.routeKey(event)`: when the manager
 * dispatches it to a focused element's handler (an element registered with
 * `useFocus(id, node, onKey, manager)`, e.g. an `Input` node edited through
 * `editKey`), the tree-level `handler` is skipped. Only keys no focused
 * element handles reach `handler`. The handler is captured at subscribe time;
 * Solid closures over signal getters stay live because the getters are read
 * at dispatch time.
 *
 * Returns a disposer that unsubscribes (and is a no-op when `isActive` is
 * `false`). To reactivate a deactivated subscription, call `subscribeInput`
 * again.
 */
export function subscribeInput(
  renderer: Renderer,
  handler: KeyHandler,
  options: SubscribeInputOptions = {},
): () => void {
  if (options.isActive === false) return () => {};
  const manager = options.focusManager ?? focusManager;
  return renderer.onKey((event) => {
    // A focused element's key handler wins; otherwise fall back to the
    // tree-level handler.
    if (manager.routeKey(event)) return;
    handler(event);
  });
}

/**
 * Wire Tab / Shift+Tab focus traversal for a renderer — the Solid-flavored
 * `useFocusTraversal` equivalent. Solid has no React-style context, so the
 * renderer (and the manager) are explicit arguments.
 *
 * Each `tab` key calls `manager.next()`, each `backtab` (Shift+Tab) key calls
 * `manager.prev()`, skipping the ids in `exclude`, re-invoking
 * `renderer.render()` after each move so the compositor repaints the newly
 * focused element. The subscription listens on the renderer's key channel
 * (the same channel `subscribeInput` subscribes to) but handles Tab /
 * Shift+Tab ahead of focused-element routing: traversal keys always move
 * focus, even while an element is focused (standard TUI behavior — element
 * handlers leave bare Tab / Shift+Tab untouched). All other keys fall through
 * to the remaining subscribers untouched.
 *
 * `manager` defaults to the core `focusManager`; `exclude` is captured at
 * subscribe time (Solid closures over signal getters stay live because the
 * getters are read at dispatch time).
 *
 * Returns a disposer that unsubscribes.
 */
export function subscribeFocusTraversal(
  renderer: Renderer,
  manager: FocusManager = focusManager,
  exclude?: string[],
): () => void {
  const excluded = exclude === undefined ? undefined : new Set(exclude);
  return renderer.onKey((event) => {
    if (event.name === "tab") {
      if (traverseFocus(manager, excluded, true)) renderer.render();
    } else if (event.name === "backtab") {
      if (traverseFocus(manager, excluded, false)) renderer.render();
    }
  });
}

/**
 * Move the active focus one step forward (`forward`) or backward, skipping
 * the ids in `exclude` (wrapping around the registration order). Returns
 * whether the focus landed on a non-excluded id; when nothing is registered
 * or every registered id is excluded, the focus is left unchanged and `false`
 * is returned (the caller then skips the repaint).
 */
function traverseFocus(
  manager: FocusManager,
  exclude: ReadonlySet<string> | undefined,
  forward: boolean,
): boolean {
  const start = manager.activeId;
  const step = forward ? () => manager.next() : () => manager.prev();
  // One step beyond the excluded set: the worst case walks past every
  // excluded id (or wraps back to the start) before landing on a keeper.
  const maxSteps = (exclude?.size ?? 0) + 1;
  for (let i = 0; i < maxSteps; i++) {
    if (!step()) return false; // nothing registered — no move
    const id = manager.activeId;
    if (id !== null && (exclude === undefined || !exclude.has(id))) return true;
  }
  // Every registered id is excluded: undo the probe so the focus is unchanged.
  if (start === null) manager.blur();
  else if (manager.has(start)) manager.focus(start);
  return false;
}

/** Options for {@link subscribePaste}. */
export interface SubscribePasteOptions {
  /** When `false`, the subscription is not established (default `true`). */
  isActive?: boolean;
  /**
   * The `FocusManager` consulted before the handler: when it routes the paste
   * to a focused element (`FocusManager.routePaste` returns `true`), the
   * handler is skipped. Defaults to the core `focusManager`.
   */
  focusManager?: FocusManager;
}

/**
 * Subscribe `handler` to a renderer's paste events, routing each paste
 * through the core `FocusManager` first — the Solid-flavored `usePaste`
 * equivalent (the paste counterpart of `subscribeInput`). Solid has no
 * React-style context, so the renderer is an explicit argument.
 *
 * Each paste is first routed via `manager.routePaste(text)`: when the manager
 * dispatches it to a focused element's paste handler (an element registered
 * with `useFocus(id, node, onKey, manager, onPaste)`, e.g. an `Input` node
 * auto-pasting through `pasteInto` or a `Textarea` created with a `focusId`
 * auto-pasting through `pasteIntoTextarea`), the tree-level `handler` is
 * skipped. Only pastes no focused element handles reach `handler`. The
 * handler is captured at subscribe time; Solid closures over signal getters
 * stay live because the getters are read at dispatch time.
 *
 * Returns a disposer that unsubscribes (and is a no-op when `isActive` is
 * `false`). To reactivate a deactivated subscription, call `subscribePaste`
 * again.
 */
export function subscribePaste(
  renderer: Renderer,
  handler: (text: string) => void,
  options: SubscribePasteOptions = {},
): () => void {
  if (options.isActive === false) return () => {};
  const manager = options.focusManager ?? focusManager;
  return renderer.onPaste((text) => {
    // A focused element's paste handler wins; otherwise fall back to the
    // tree-level handler.
    if (manager.routePaste(text)) return;
    handler(text);
  });
}

/**
 * Subscribe `handler` to a renderer's terminal resize events — the
 * Solid-flavored `useResize` equivalent. Solid has no React-style context, so
 * the renderer is an explicit argument (the `@tern/react` `useResize` reads
 * it from the tree context instead).
 *
 * Each resize event is delivered as `{ width, height }` (the core
 * `ResizeHandler` payload); after the handler runs, `renderer.render()` is
 * re-invoked so the compositor re-lays out the scene at the new terminal
 * size. The handler is captured at subscribe time; Solid closures over signal
 * getters stay live because the getters are read at dispatch time.
 *
 * Returns a disposer that unsubscribes.
 */
export function subscribeResize(
  renderer: Renderer,
  handler: ResizeHandler,
): () => void {
  return renderer.onResize((event) => {
    handler(event);
    // The compositor sizes the scene from the terminal; re-paint so the
    // layout reflects the new width/height.
    renderer.render();
  });
}

// ---------------------------------------------------------------------------
// Focus-aware wiring: terminal focus events + the focus-aware spinner driver
// ---------------------------------------------------------------------------

/**
 * Subscribe `handler` to a renderer's terminal focus events — the
 * Solid-flavored `onFocus` subscription helper (the focus counterpart of
 * `subscribeInput` / `subscribeResize`). Solid has no React-style context, so
 * the renderer is an explicit argument (the `@tern/react` `useResize`-style
 * hooks read it from the tree context instead).
 *
 * Each focus event is delivered as `{ focus_gained }` — `true` when the
 * terminal window gained focus, `false` when it lost it. Returns a disposer
 * that unsubscribes.
 */
export function subscribeFocus(renderer: Renderer, handler: FocusHandler): () => void {
  return renderer.onFocus(handler);
}

// ---------------------------------------------------------------------------
// Panel drag-resize wiring
// ---------------------------------------------------------------------------

/**
 * Subscribe a `panels` node to a renderer's mouse events, driving the core
 * panel drag-resize helpers (roadmap Phase 2). Mouse routing (via
 * `Renderer.hit_test`): a `down_left` press starts a drag only when the
 * pressed cell is covered by a painted scene node — the gutter cells inside
 * the panels element are (the element's background covers them), while dead
 * cells outside any node are not. Once the drag starts, each `drag_left`
 * moves the split by setting the adjacent pane's `flex_basis` (`dragPanels`,
 * clamped to the pane's min size) and re-invokes `renderer.render()` so the
 * compositor re-flows; drags continue even when the cursor leaves the stack
 * (the clamp bounds the split). Any `up_*` event ends the drag
 * (`endPanelDrag`). The optional `handler` receives each helper's result
 * (`null` when the event did not apply).
 *
 * Returns a disposer that unsubscribes.
 */
export function subscribePanelDrag(
  renderer: Renderer,
  panels: Node,
  handler?: (result: PanelDragHandle | PanelDragResult | null) => void,
): () => void {
  return renderer.onMouse((event) => {
    if (event.kind === "down_left") {
      // The press must land on a painted cell: `hit_test` returns the scene
      // node ids covering the cell (empty off any node — the scene root is
      // never reported, so a cell the panels element does not cover misses).
      if (renderer.hit_test(event.column, event.row).length === 0) return;
      handler?.(startPanelDrag(panels, event));
    } else if (event.kind === "drag_left") {
      const result = dragPanels(panels, event);
      if (result !== null) renderer.render();
      handler?.(result);
    } else if (event.kind.startsWith("up_")) {
      handler?.(endPanelDrag(panels));
    }
  });
}

/**
 * Subscribe a scrollable view (a `ScrollView`, a `Table`, a `DiffView`, or
 * any node carrying the engine's clip/scroll region props) to a renderer's
 * mouse wheel events — the Solid-flavored `useWheelScroll` equivalent.
 *
 * Each wheel event (`scroll_up` / `scroll_down` / `scroll_left` /
 * `scroll_right`) is mapped by the core `wheelScroll` helper onto the view's
 * scroll offsets (clamped to the content bounds); a consumed wheel re-invokes
 * `renderer.render()` so the compositor reflects the new offset (a `table`
 * scrolls its scrollable content region, keeping the sticky header pinned).
 * Non-wheel events and wheels on non-scrollable nodes fall through untouched.
 *
 * Returns a disposer that unsubscribes.
 */
export function subscribeWheelScroll(renderer: Renderer, view: Node): () => void {
  return renderer.onMouse((event) => {
    if (wheelScroll(view, event)) renderer.render();
  });
}

/**
 * Subscribe a renderer's mouse events to click-to-focus — the Solid-flavored
 * `useClickToFocus` equivalent. Every `down_left` press on a painted cell
 * focuses the topmost registered focusable node under the cursor (the core
 * `focusAt` helper — `Renderer.hit_test` gates the press to a painted cell,
 * then the live scene tree is walked for the first node the `FocusManager`
 * has registered, focused via its id). Elements registered with the core
 * `useFocus` — e.g. an `Input` / `Select` node registered with a focus id —
 * become click targets. Presses off any painted cell are a no-op.
 *
 * Returns a disposer that unsubscribes.
 */
export function subscribeClickFocus(renderer: Renderer): () => void {
  return renderer.onMouse((event) => {
    focusAt(renderer, event);
  });
}

/** Options for {@link startSpinner}. */
export interface StartSpinnerOptions {
  /** The tick interval in ms (default 100). */
  interval?: number;
}

/**
 * Start a focus-aware tick driver on a `spinner` scene node — the
 * Solid-flavored equivalent of the `@tern/react` `<Spinner>` mount effect
 * (roadmap Phase 2 "focus-aware redraw").
 *
 * While the terminal is focused, every `interval` ms the driver advances the
 * node's frame via the core `tick` and repaints the scene with
 * `renderer.render()`. When the terminal loses focus (an `onFocus` event with
 * `focus_gained: false`) the timer keeps running but the tick and repaint are
 * skipped — the frames are invisible anyway, so the redraw cost is wasted —
 * and ticking resumes on focus regain (`focus_gained: true`).
 *
 * Returns a disposer that clears the interval and unsubscribes the focus
 * subscription.
 */
export function startSpinner(
  renderer: Renderer,
  node: Node,
  options: StartSpinnerOptions = {},
): () => void {
  const interval = options.interval ?? 100;
  // The terminal starts focused; the focus subscription flips the flag on
  // blur/regain so the interval skips tick()/render() while unfocused.
  let focused = true;
  const id = setInterval(() => {
    if (!focused) return;
    tick(node);
    renderer.render();
  }, interval);
  const unsubscribeFocus = subscribeFocus(renderer, (event) => {
    focused = event.focus_gained;
  });
  return () => {
    clearInterval(id);
    unsubscribeFocus();
  };
}
