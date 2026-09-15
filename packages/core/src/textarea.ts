//! The multi-line Textarea element: soft wrap, scrolling, and the edit model.

import { Node, Text } from "./node.ts";
import { clusterAt, clusterRuns, columnToIndex, indexToColumn, lastClusterBefore, snapToClusterEnd, stripEscapes, strippedIndexAt } from "./textutil.ts";
import type { NodeProps } from "./types.ts";

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

/** The wrap width of a textarea's props, or `null` when no width is set. */
function textareaWidth(props: TextareaProps): number | null {
  const w = props.width;
  return typeof w === "number" && Number.isFinite(w) && w > 0
    ? Math.floor(w)
    : null;
}

/** The visible window of a textarea's props (rows), or `null` when unset. */
function textareaHeight(props: TextareaProps): number | null {
  const h = props.height;
  return typeof h === "number" && Number.isFinite(h) && h > 0
    ? Math.floor(h)
    : null;
}

/** The total display width of a string in terminal columns — the sum of its
 * grapheme clusters' widths (a ZWJ emoji counts 2, never per code point).
 * Escape sequences consume zero cells (stripped at ingestion by
 * {@link clusterRuns}), so a colored string measures exactly as its plain
 * text. */
export function textWidth(text: string): number {
  let width = 0;
  for (const run of clusterRuns(text)) width += run.width;
  return width;
}

/**
 * Soft-wrap `line` into display lines of at most `width` columns plus the
 * code-unit index (within `line`) where each display line starts. This is
 * the canonical pre-render measurement — the JS mirror of the Rust
 * `wrap_line` (token-aware greedy wrap): a whitespace-free token that does
 * not fit on the current display line wraps whole to the next when it can
 * fit there; a token wider than the width hard-breaks across rows; a
 * trailing space at a full display line is dropped (the wrap would collapse
 * it anyway); an embedded `\n` ends the display line. Escape sequences
 * (ANSI/OSC/CSI, see {@link stripEscapes}) are stripped at ingestion before
 * wrapping, so they consume zero cells, never break a token, and never
 * appear in a row's `text`. The returned `start` offsets are code-unit
 * indices into the ORIGINAL `line`, translated through the strip map: a row
 * starts at its first visible character's original index, so offsets are
 * exact and never land inside an escape — a stripped escape belongs to no
 * display line, so its bytes sit in the trailing row's original span. A
 * character dropped by the wrap belongs to no display line, so caret
 * navigation stays consistent with what is composed. Downstream consumers
 * count rows at a width through {@link measureText} — never a hand-written
 * mirror — so the measurement cannot drift from what the compositor paints.
 */
export function wrapLineWithOffsets(
  line: string,
  width: number | null,
): Array<{ text: string; start: number }> {
  if (width === null) {
    const stripped = stripEscapes(line);
    return [{ text: stripped.text, start: stripped.orig[0]! }];
  }
  const limit = Math.max(1, Math.floor(width));
  const { text, orig } = stripEscapes(line);
  const rows: Array<{ text: string; start: number }> = [];
  let row = "";
  let rowWidth = 0;
  let rowStart = 0;
  let token = "";
  let tokenStart = 0;
  let idx = 0;

  const flushToken = () => {
    if (token === "") return;
    const tokenWidth = textWidth(token);
    if (row !== "" && rowWidth + tokenWidth > limit && tokenWidth <= limit) {
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = tokenStart;
    }
    // The code-unit index (within the stripped `text`) of the current token
    // cluster; every pushed `start` is translated to the original line
    // through `orig`.
    let cur = tokenStart;
    for (const run of clusterRuns(token)) {
      const w = run.width;
      if (w === 0) {
        cur += run.len;
        continue;
      }
      if (rowWidth + w > limit) {
        rows.push({ text: row, start: orig[rowStart]! });
        row = "";
        rowWidth = 0;
        if (w > limit) {
          cur += run.len; // a cluster wider than a fresh row is dropped whole
          rowStart = cur;
          continue;
        }
        rowStart = cur; // the wrapped row starts at this cluster
      }
      row += run.text;
      rowWidth += w;
      cur += run.len;
    }
    token = "";
  };

  for (const ch of text) {
    if (ch === "\n") {
      flushToken();
      rows.push({ text: row, start: orig[rowStart]! });
      row = "";
      rowWidth = 0;
      rowStart = idx + 1;
    } else if (ch === " ") {
      flushToken();
      if (rowWidth + 1 <= limit) {
        row += " ";
        rowWidth += 1;
      }
    } else {
      if (token === "") tokenStart = idx;
      token += ch;
    }
    idx += ch.length;
  }
  flushToken();
  rows.push({ text: row, start: orig[rowStart]! });
  if (rows.length === 0) rows.push({ text: "", start: 0 });
  return rows;
}

/** The number of display rows `line` occupies at the wrap width (1 when no
 * width is set). */
function wrapCount(line: string, width: number | null): number {
  return width === null ? 1 : wrapLineWithOffsets(line, width).length;
}

/**
 * Pre-render measurement of `text` at wrap width `width`: how many display
 * rows the text occupies and the widest display-line width in cells. The
 * text is split on `\n` and each logical line is soft-wrapped through
 * {@link wrapLineWithOffsets} — the canonical mirror of the Rust
 * `wrap_line` — so the row count is exactly what the compositor would
 * compose. Escape sequences consume zero cells (stripped at ingestion, see
 * {@link stripEscapes}), so a colored line measures exactly as its plain
 * text. A non-positive (or non-finite) `width` follows the file's "no
 * width" convention (`textareaWidth` maps such widths to `null`): each
 * logical line counts as one display row and the widest display line is the
 * widest logical line. An empty string occupies exactly one empty display
 * row (width 0).
 */
export function measureText(
  text: string,
  width: number,
): { rows: number; maxWidth: number } {
  const wrapWidth = Number.isFinite(width) && width > 0 ? width : null;
  let rows = 0;
  let maxWidth = 0;
  for (const line of text.split("\n")) {
    const wrapped = wrapLineWithOffsets(line, wrapWidth);
    rows += wrapped.length;
    for (const entry of wrapped) {
      const entryWidth = textWidth(entry.text);
      if (entryWidth > maxWidth) maxWidth = entryWidth;
    }
  }
  return { rows, maxWidth };
}

/** The display row where logical line `row` begins. */
function displayBase(
  lines: string[],
  row: number,
  width: number | null,
): number {
  let base = 0;
  for (let i = 0; i < row; i++) base += wrapCount(lines[i]!, width);
  return base;
}

/** The total number of display rows across all logical lines. */
function totalDisplayRows(lines: string[], width: number | null): number {
  return lines.reduce((sum, line) => sum + wrapCount(line, width), 0);
}

/** The display-line offset (within `line`'s wrapped lines) that contains the
 * char index `col`. A char dropped by the wrap maps to the display line it
 * trails — and so does an escape-stripped sequence, whose bytes sit inside
 * the trailing row's original span. The check needs no strip map: the rows'
 * original `start`s tile `line` (each row spans `start[i]..start[i+1)`, the
 * last reaching `line.length`), so `col` trails row `i` exactly while it is
 * before row `i+1`'s start. */
function offsetOfCol(line: string, col: number, width: number | null): number {
  const wrapped = wrapLineWithOffsets(line, width);
  for (let i = 0; i < wrapped.length; i++) {
    const end = i + 1 < wrapped.length ? wrapped[i + 1]!.start : line.length;
    if (col < end) return i;
  }
  return wrapped.length - 1;
}

/** The caret's display row across the whole wrapped text. */
function caretDisplayRow(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  return displayBase(lines, row, width) + offsetOfCol(lines[row]!, col, width);
}

/** The display column of `col` within display-line `offset` of `line`, and
 * the code-unit index where that display line starts. `col` (an original
 * index) is translated through the strip map first, so a caret resting on —
 * or inside — an escape measures against the visible text only: an escape
 * interior trails its content, exactly like a char dropped by the wrap. */
function caretDisplayIn(
  line: string,
  col: number,
  offset: number,
  width: number | null,
): { col: number; start: number } {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ??
    { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = Math.max(
    0,
    Math.min(strippedIndexAt(orig, col) - base, entry.text.length),
  );
  return { col: indexToColumn(entry.text, local), start: entry.start };
}

/** The caret's display column within its own display line. */
function currentDisplayCol(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
): number {
  const offset = offsetOfCol(lines[row]!, col, width);
  return caretDisplayIn(lines[row]!, col, offset, width).col;
}

/** The `(logical row, display-line offset)` for display row `target`. */
function logicalAtDisplayRow(
  lines: string[],
  target: number,
  width: number | null,
): { row: number; offset: number } {
  let acc = 0;
  for (let r = 0; r < lines.length; r++) {
    const count = wrapCount(lines[r]!, width);
    if (target < acc + count) return { row: r, offset: target - acc };
    acc += count;
  }
  const last = Math.max(0, lines.length - 1);
  return { row: last, offset: Math.max(0, wrapCount(lines[last]!, width) - 1) };
}

/** The char (code-unit) index into `line` at display column `targetCol`
 * within display-line `offset` (clamped to the display line's end; a column
 * inside a wide glyph snaps to that glyph's start). The cluster boundary is
 * translated back through the strip map, so the returned index is the
 * original position of the visible character — never inside an escape. */
function charAtDisplayCol(
  line: string,
  offset: number,
  targetCol: number,
  width: number | null,
): number {
  const wrapped = wrapLineWithOffsets(line, width);
  const entry = wrapped[Math.min(offset, wrapped.length - 1)] ??
    { text: "", start: 0 };
  const { orig } = stripEscapes(line);
  const base = strippedIndexAt(orig, entry.start);
  const local = columnToIndex(entry.text, targetCol);
  return orig[base + local]!;
}

/** The scroll offset that keeps the caret's display row inside the visible
 * window (no-op with no height set). */
function visibleScroll(
  lines: string[],
  row: number,
  col: number,
  width: number | null,
  height: number | null,
  current: number,
): number {
  if (height === null) return 0;
  const h = Math.max(1, height);
  const caret = caretDisplayRow(lines, row, col, width);
  if (caret < current) return caret;
  if (caret >= current + h) return caret + 1 - h;
  return current;
}

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

