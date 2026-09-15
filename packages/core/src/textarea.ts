//! The multi-line Textarea element: the edit model, the vertical-move state,
//! and the composition window.
//!
//! The measurement and display-row windowing seam it composes with — cell
//! width, soft wrap, and the row/caret/window math — lives in
//! `textwrap.ts` (exported from the package root), so any consumer that
//! keeps its own index over a large buffer reuses the same row math instead
//! of re-deriving it.

import { Node, Text } from "./node.ts";
import { clusterAt, lastClusterBefore, snapToClusterEnd } from "./textutil.ts";
import type { NodeProps } from "./types.ts";
import { caretDisplayIn, caretDisplayRow, charAtDisplayCol, currentDisplayCol, logicalAtDisplayRow, textareaHeight, textareaWidth, totalDisplayRows, visibleScroll, wrapLineWithOffsets } from "./textwrap.ts";

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
import { syncSemantics } from "./semantics.ts";
/**
 * Props for the `Textarea` element. Style/layout keys flow to the framed box;
 * `lines`/`row`/`col`/`scroll` are the edit model (JS bookkeeping on the
 * node, the source of truth for `editTextareaKey` — the lines array never
 * reaches the scene, mirroring `Panels`' `panels`); `width` soft-wraps long
 * lines into display rows, `height` sets the visible window.
 */
export interface TextareaProps extends NodeProps {
  /** The logical lines of text (default `[""]`). */
  lines?: string[];
  /** The cursor row — an index into `lines` (default 0). */
  row?: number;
  /** The cursor column — a char (code-unit) index into `lines[row]` (default
   * 0). */
  col?: number;
  /**
   * The soft-wrap width in cells; unset keeps each logical line on one
   * display row. When set, long lines wrap into display rows at this width
   * (token-aware, mirroring the Rust `wrap_line`), and each leaf is sized to
   * the width.
   */
  width?: number;
  /** The visible window in display rows; unset shows every display line.
   * When set, only the window around the caret is composed (vertical
   * scroll-to-caret). */
  height?: number;
  /** The top visible display row (vertical scroll, default 0). */
  scroll?: number;
}

/** The state reported by {@link editTextareaKey} (and the `<Textarea>`
 * callbacks). */
export interface TextareaState {
  /** The logical lines after the key. */
  lines: string[];
  /** The cursor row (index into `lines`). */
  row: number;
  /** The cursor column (char index into `lines[row]`). */
  col: number;
}

/**
 * The per-textarea vertical-move state: the display column preserved across a
 * run of up/down moves (keyed by node, like `Panels`' drag state).
 */
interface TextareaVerticalState {
  /** The display column kept across consecutive up/down moves. */
  preferredCol: number;
  /** Whether the previous key was a vertical move (the column is only
   * re-captured on the first move of a run). */
  sticky: boolean;
}

/** The vertical-move state per textarea node (JS bookkeeping — never scene
 * props, mirroring `Panels`' `panelDrags`). */
const textareaVertical = new WeakMap<Node, TextareaVerticalState>();


/** The text leaf props of one visible display row: its wrapped text, sized to
 * the wrap width, plus the caret display column when the row holds the
 * caret. */
function textareaLeafProps(
  text: string,
  width: number | null,
  caretCol: number | null,
): NodeProps {
  const props: NodeProps = { text };
  if (width !== null) props.width = width;
  if (caretCol !== null) props.caret = caretCol;
  return props;
}

/** Rebuild a textarea's composition from its props: one text leaf per visible
 * display row (the `scroll..scroll+height` window, or every row with no
 * height), the caret's leaf carrying its `caret` display column. */
function rebuildTextarea(textarea: Node): void {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? props.lines : [""];
  const row = Math.max(
    0,
    Math.min(
      typeof props.row === "number" ? Math.floor(props.row) : 0,
      lines.length - 1,
    ),
  );
  const col = Math.max(
    0,
    Math.min(
      typeof props.col === "number" ? Math.floor(props.col) : 0,
      lines[row]!.length,
    ),
  );
  const width = textareaWidth(props);
  const height = textareaHeight(props);
  const scroll = visibleScroll(
    lines,
    row,
    col,
    width,
    height,
    typeof props.scroll === "number" ? props.scroll : 0,
  );
  const caretRow = caretDisplayRow(lines, row, col, width);
  const total = totalDisplayRows(lines, width);
  const first = Math.min(scroll, total);
  const last = Math.min(scroll + (height === null ? total : height), total);
  for (const child of [...textarea.children]) child.remove();
  for (let displayRow = first; displayRow < last; displayRow++) {
    const { row: lineRow, offset } = logicalAtDisplayRow(
      lines,
      displayRow,
      width,
    );
    const wrapped = wrapLineWithOffsets(lines[lineRow]!, width);
    const entry = wrapped[Math.min(offset, wrapped.length - 1)] ??
      { text: "", start: 0 };
    let caretCol: number | null = null;
    if (displayRow === caretRow) {
      caretCol = caretDisplayIn(lines[lineRow]!, col, offset, width).col;
    }
    textarea.addChild(Text(textareaLeafProps(entry.text, width, caretCol)));
  }
}

/**
 * Create a `textarea` element: a framed box with one text leaf per visible
 * display line (soft-wrapped at `width`, vertically scrolled to keep the
 * caret visible within `height`), the caret's leaf carrying its `caret`
 * display column. `lines`/`row`/`col`/`scroll` stay on the node as the edit
 * model's source of truth. Edit it with {@link editTextareaKey}.
 */
export function Textarea(props: TextareaProps = {}): Node {
  const node = Node.create("textarea", props, []);
  textareaVertical.set(node, { preferredCol: 0, sticky: false });
  rebuildTextarea(node);
  syncSemantics(node);
  return node;
}

/** The pure next-state computation shared by {@link editTextareaKey}.
 * `up`/`down` navigate the soft-wrapped display lines with `preferredCol`;
 * the other keys are the single-line edits generalized across lines. */
function textareaKeyPosition(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
  preferredCol: number,
  key: KeyEvent,
): { lines: string[]; row: number; col: number; changed: boolean } {
  const name = key.name;
  const line = lines[row] ?? "";
  // Snap a mid-cluster cursor to the cluster boundary its caret rests on
  // (after the containing cluster — where it visually paints): every edit
  // and movement lands on a grapheme-cluster boundary, never inside one.
  col = snapToClusterEnd(line, col);

  if (name === "up" || name === "down") {
    const caretRow = caretDisplayRow(lines, row, col, width);
    const total = totalDisplayRows(lines, width);
    const canMove = name === "up" ? caretRow > 0 : caretRow + 1 < total;
    if (!canMove) return { lines, row, col, changed: false };
    const target = name === "up" ? caretRow - 1 : caretRow + 1;
    const at = logicalAtDisplayRow(lines, target, width);
    const nextCol = charAtDisplayCol(
      lines[at.row]!,
      at.offset,
      preferredCol,
      width,
    );
    return {
      lines,
      row: at.row,
      col: nextCol,
      changed: at.row !== row || nextCol !== col,
    };
  }
  if (name === "char" && !key.ctrl && !key.alt && key.char !== undefined) {
    const next = line.slice(0, col) + key.char + line.slice(col);
    const nextLines = [...lines];
    nextLines[row] = next;
    return { lines: nextLines, row, col: col + key.char.length, changed: true };
  }
  if (name === "backspace") {
    if (col > 0) {
      const prev = lastClusterBefore(line, col);
      if (prev === null) return { lines, row, col, changed: false };
      const next = line.slice(0, prev.start) +
        line.slice(prev.start + prev.len);
      const nextLines = [...lines];
      nextLines[row] = next;
      return { lines: nextLines, row, col: col - prev.len, changed: true };
    }
    if (row > 0) {
      // Join into the previous line: the cursor lands at the join point (the
      // previous line's end, before the appended tail).
      const prevLen = lines[row - 1]!.length;
      const nextLines = [...lines];
      const tail = nextLines.splice(row, 1)[0] ?? "";
      nextLines[row - 1] = nextLines[row - 1]! + tail;
      return { lines: nextLines, row: row - 1, col: prevLen, changed: true };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "delete") {
    if (col < line.length) {
      const cluster = clusterAt(line, col);
      const len = cluster === null ? 1 : cluster.len;
      const next = line.slice(0, col) + line.slice(col + len);
      const nextLines = [...lines];
      nextLines[row] = next;
      return { lines: nextLines, row, col, changed: true };
    }
    if (row + 1 < lines.length) {
      const nextLines = [...lines];
      const tail = nextLines.splice(row + 1, 1)[0] ?? "";
      nextLines[row] = nextLines[row]! + tail;
      return { lines: nextLines, row, col, changed: true };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "enter") {
    // Split the line at the cursor: the tail becomes a new line below, and
    // the caret moves to the start of it.
    const nextLines = [...lines];
    nextLines[row] = line.slice(0, col);
    nextLines.splice(row + 1, 0, line.slice(col));
    return { lines: nextLines, row: row + 1, col: 0, changed: true };
  }
  if (name === "left") {
    if (col > 0) {
      const prev = lastClusterBefore(line, col);
      return {
        lines,
        row,
        col: prev === null ? 0 : prev.start,
        changed: prev !== null,
      };
    }
    if (row > 0) {
      return {
        lines,
        row: row - 1,
        col: lines[row - 1]!.length,
        changed: true,
      };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "right") {
    if (col < line.length) {
      const cluster = clusterAt(line, col);
      const len = cluster === null ? 1 : cluster.len;
      return { lines, row, col: col + len, changed: true };
    }
    if (row + 1 < lines.length) {
      return { lines, row: row + 1, col: 0, changed: true };
    }
    return { lines, row, col, changed: false };
  }
  if (name === "home") return { lines, row, col: 0, changed: col !== 0 };
  if (name === "end") {
    return { lines, row, col: line.length, changed: col !== line.length };
  }
  return { lines, row, col, changed: false };
}

/**
 * Apply a key to a textarea node, mutating its lines/row/col (and vertical
 * scroll) in place and rebuilding the composed line leaves — the Textarea
 * counterpart of {@link editKey}. Handles `char` insert, `backspace` /
 * `delete` (joining adjacent lines at the boundaries), `left`/`right` /
 * `home`/`end`, `enter` (split), and `up`/`down` across the soft-wrapped
 * display lines (preserving a preferred display column across a run of
 * vertical moves). Movement and deletion are grapheme aware — `left` /
 * `right` / `backspace` / `delete` step whole grapheme clusters (a ZWJ emoji
 * or a base-plus-combining sequence is one step, never split mid-cluster),
 * mirroring tern-core's cluster-width convention — and a mid-cluster cursor
 * (e.g. from caller props) snaps to the boundary after its cluster before
 * any edit. Any other key leaves the textarea unchanged. Returns the new
 * `{ lines, row, col }`.
 */
export function editTextareaKey(
  textarea: Node,
  event: KeyEvent,
): TextareaState {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? [...props.lines] : [""];
  const row = Math.max(
    0,
    Math.min(
      typeof props.row === "number" ? Math.floor(props.row) : 0,
      lines.length - 1,
    ),
  );
  const col = Math.max(
    0,
    Math.min(
      typeof props.col === "number" ? Math.floor(props.col) : 0,
      lines[row]!.length,
    ),
  );
  const width = textareaWidth(props);
  const height = textareaHeight(props);
  const vertical = textareaVertical.get(textarea) ??
    { preferredCol: 0, sticky: false };
  const verticalKey = event.name === "up" || event.name === "down";
  // A vertical run keeps the column captured on its first move; the first
  // move of a run (or any horizontal move / edit) re-captures it.
  if (verticalKey && !vertical.sticky) {
    vertical.preferredCol = currentDisplayCol(lines, row, col, width);
    vertical.sticky = true;
  }
  const next = textareaKeyPosition(
    lines,
    row,
    col,
    width,
    vertical.preferredCol,
    event,
  );
  if (!verticalKey) {
    vertical.sticky = false;
    vertical.preferredCol = currentDisplayCol(
      next.lines,
      next.row,
      next.col,
      width,
    );
  }
  if (next.changed) {
    const scroll = visibleScroll(
      next.lines,
      next.row,
      next.col,
      width,
      height,
      typeof props.scroll === "number" ? props.scroll : 0,
    );
    textarea.setProps({
      ...props,
      lines: next.lines,
      row: next.row,
      col: next.col,
      scroll,
    });
    rebuildTextarea(textarea);
  }
  textareaVertical.set(textarea, vertical);
  return { lines: next.lines, row: next.row, col: next.col };
}

/**
 * Insert pasted text into a textarea node at the caret, mutating its
 * lines/row/col (and vertical scroll) in place and rebuilding the composed
 * line leaves — the paste counterpart of {@link editTextareaKey}. A pasted
 * `\n` splits the text into new logical lines (the pre-caret head stays on
 * the current line, the post-caret tail joins the last pasted segment), and
 * the caret lands at the end of the pasted text. The caret column is a
 * code-unit index into the line, so wide characters are handled by the same
 * cluster math as `editTextareaKey`; a paste lands on a grapheme-cluster
 * boundary (a mid-cluster cursor snaps to the boundary after its cluster),
 * and wrap width and vertical scroll stay multi-width aware through the
 * shared soft-wrap machinery. Returns the new `{ lines, row, col }`.
 */
export function pasteIntoTextarea(textarea: Node, text: string): TextareaState {
  const props = textarea.props as TextareaProps;
  const lines = Array.isArray(props.lines) ? [...props.lines] : [""];
  const row = Math.max(
    0,
    Math.min(
      typeof props.row === "number" ? Math.floor(props.row) : 0,
      lines.length - 1,
    ),
  );
  const rawCol = Math.max(
    0,
    Math.min(
      typeof props.col === "number" ? Math.floor(props.col) : 0,
      lines[row]!.length,
    ),
  );
  // A paste lands on a grapheme-cluster boundary: a mid-cluster cursor snaps
  // to the boundary after its cluster (where its caret visually paints).
  const col = snapToClusterEnd(lines[row]!, rawCol);
  const width = textareaWidth(props);
  const height = textareaHeight(props);

  // Split the pasted text on newlines: the head replaces the pre-caret part
  // of the current line, the middle segments become new lines, and the tail
  // of the original line joins the last segment (mirroring a multi-line
  // `enter` + insert edit).
  const segments = text.split("\n");
  const head = segments[0] ?? "";
  const nextLines = [...lines];
  const pre = nextLines[row]!.slice(0, col);
  const originalTail = nextLines[row]!.slice(col);
  if (segments.length === 1) {
    nextLines[row] = pre + head + originalTail;
  } else {
    nextLines[row] = pre + head;
    const middle = segments.slice(1);
    const last = middle.length - 1;
    nextLines.splice(
      row + 1,
      0,
      ...middle.map((
        segment,
        i,
      ) => (i === last ? segment + originalTail : segment)),
    );
  }

  const nextRow = row + Math.max(0, segments.length - 1);
  // Single-segment paste keeps the caret on the same line, advanced past the
  // pasted text; a multi-line paste lands at the end of the last pasted
  // segment (the pre-caret head stayed behind on the original line).
  const nextCol = segments.length > 1
    ? (segments[segments.length - 1] ?? "").length
    : col + (segments[0] ?? "").length;

  const vertical = textareaVertical.get(textarea) ??
    { preferredCol: 0, sticky: false };
  // A paste is a horizontal edit: end any vertical-move run and re-capture
  // the preferred column at the new caret, like `editTextareaKey` does for
  // non-vertical keys.
  vertical.sticky = false;
  vertical.preferredCol = currentDisplayCol(nextLines, nextRow, nextCol, width);
  textareaVertical.set(textarea, vertical);

  const scroll = visibleScroll(
    nextLines,
    nextRow,
    nextCol,
    width,
    height,
    typeof props.scroll === "number" ? props.scroll : 0,
  );
  textarea.setProps({
    ...props,
    lines: nextLines,
    row: nextRow,
    col: nextCol,
    scroll,
  });
  rebuildTextarea(textarea);
  return { lines: nextLines, row: nextRow, col: nextCol };
}

