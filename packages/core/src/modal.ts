//! The Modal element and the open/close state it keeps.

import { FocusManager, focusManager } from "./focus.ts";
import { Box, Node } from "./node.ts";
import type { NodeProps, Span } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
/** The modal overlay's paint z-order (100). In-flow content stacks at z 0
 * (the scrollbar / sticky table header at 1), so a modal stamped with this
 * `z_index` always paints above them (compositor z-order, the same
 * mechanism `Select`'s `floating` overlay uses). */
export const MODAL_Z_INDEX = 100;

/** The backdrop's fill color: a dark slate a shade below the default palette
 * backgrounds, so the dim layer reads as a shade over the content beneath
 * the overlay. */
export const MODAL_BACKDROP_BG = "#17191e";

/**
 * Props for the `Modal` element. `backdrop` / `content` are consumed by the
 * factory (the content node list is JS bookkeeping — it never reaches the
 * scene props, mirroring `Panels`' `panels`); `open` / `z_index` reach the
 * root box's scene props (the compositor's paint z-order, default
 * {@link MODAL_Z_INDEX}).
 */
export interface ModalProps extends NodeProps {
  /** Whether the modal is open (default `false`). `openModal` / `closeModal`
   * toggle it (and the visible state); a modal starts hidden. */
  open?: boolean;
  /** Whether the dimmed backdrop box is composed (default `true`). */
  backdrop?: boolean;
  /** The overlay's paint z-order (default {@link MODAL_Z_INDEX}). */
  z_index?: number;
  /** Content nodes wrapped into the centered content box (the Solid
   *  factory's path; `Box`-style rest-arg children work too). */
  content?: Node[];
}

/** The per-modal focus bookkeeping (JS state — never scene props). */
interface ModalState {
  /** The active focus id recorded when the modal opened (restored on close;
   * `null` when nothing was focused before the open). */
  previousFocusId: string | null;
}

/** The focus records of modal nodes created with {@link Modal}. */
const modalStates = new WeakMap<Node, ModalState>();

/**
 * Create a `modal` element: an absolutely positioned, full-bleed overlay box
 * (inset to its parent's padding box) stamped with a high `z_index` so it
 * paints above in-flow content, composing a dimmed backdrop box (an absolute
 * fill with a dark `bg`, unless `backdrop: false`) plus a centered content
 * box (a flex column) wrapping the content nodes (rest-arg children or the
 * `content` prop). The visible state starts from `open` (default `false` —
 * hidden); drive it with {@link openModal} / {@link closeModal}, which also
 * move focus into / out of the overlay through the {@link FocusManager}. No
 * new napi node kind: the `modal` element materializes as a `box`
 * (constitution).
 */
export function Modal(props: ModalProps = {}, ...children: Node[]): Node {
  const open = props.open ?? false;
  const backdrop = props.backdrop ?? true;
  const content: Node[] = [...children];
  if (Array.isArray(props.content)) content.push(...props.content);

  const rootProps: NodeProps = {
    ...props,
    open,
    // A closed modal is truly gone: the `hidden` modifier (the reconciler's
    // hide semantics) plus `display: none` (the engine removes the node and
    // its subtree from layout).
    hidden: !open,
    display: open ? "flex" : "none",
    // The Select `floating` pattern: the overlay's paint z-order is stamped
    // on the root box (an explicit `z_index` prop wins).
    z_index: (props.z_index as number | undefined) ?? MODAL_Z_INDEX,
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flex_direction: "column",
    justify_content: "center",
    align_items: "center",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.content;
  delete plain.backdrop;

  const composed: Node[] = [];
  if (backdrop) {
    // The dim layer: an absolute fill covering the overlay, painted beneath
    // the centered content box (child order within the same z layer).
    composed.push(
      Box({
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        bg: MODAL_BACKDROP_BG,
        dim: true,
      }),
    );
  }
  composed.push(Box({ flex_direction: "column" }, ...content));

  const modal = Node.create("modal", rootProps, composed);
  modalStates.set(modal, { previousFocusId: null });
  return modal;
}

/**
 * Open a modal overlay: record the currently active focus id, show the
 * overlay (toggle the `hidden` modifier off and `display` back to flex), and
 * move focus into it — `focusFirst()` focuses the first registered
 * focusable (the overlay's content is expected to register its focusables
 * with `manager`). A no-op when the modal is already open (the record must
 * not be overwritten by the focus that now sits inside the overlay).
 */
export function openModal(
  modal: Node,
  manager: FocusManager = focusManager,
): void {
  const state = modalStates.get(modal);
  if (state === undefined || modal.props.open === true) return;
  state.previousFocusId = manager.activeId;
  modal.setProps({
    ...modal.props,
    open: true,
    hidden: false,
    display: "flex",
  });
  manager.focusFirst();
}

/**
 * Close a modal overlay: hide it (toggle the `hidden` modifier on and
 * `display` to none) and restore the focus recorded by {@link openModal} —
 * the previously active id, or a blur when nothing was focused before the
 * open (fallback `null`; a recorded id that was unregistered meanwhile also
 * falls back to a blur). A no-op when the modal is already closed.
 */
export function closeModal(
  modal: Node,
  manager: FocusManager = focusManager,
): void {
  const state = modalStates.get(modal);
  if (state === undefined || modal.props.open !== true) return;
  const previous = state.previousFocusId;
  modal.setProps({
    ...modal.props,
    open: false,
    hidden: true,
    display: "none",
  });
  state.previousFocusId = null;
  if (previous === null || !manager.focus(previous)) {
    manager.blur();
  }
}

/** The Markdown fence languages `highlightCode` recognizes (aliases map to
 * the same grammar). */
export const HIGHLIGHT_LANGUAGES = new Set([
  "rust",
  "rs",
  "typescript",
  "ts",
  "tsx",
  "javascript",
  "js",
  "jsx",
  "json",
  "bash",
  "shell",
  "sh",
  "zsh",
  "python",
  "py",
  "go",
  "golang",
  "toml",
  "yaml",
  "yml",
  "c",
  "cpp",
  "c++",
  "cxx",
]);

/** Map one native highlight span onto a scene `Span`: the `fg` hex string and
 * the boolean modifier keys become style props ready for `Node.appendSpan` or
 * a `Text` leaf. */
export function spanFromRaw(raw: HighlightSpanJs): Span {
  const style: NodeProps = {};
  if (raw.fg !== undefined && raw.fg !== null) style.fg = raw.fg;
  if (raw.bold) style.bold = true;
  if (raw.italic) style.italic = true;
  if (raw.dim) style.dim = true;
  if (raw.underline) style.underline = true;
  return { text: raw.text, style };
}

