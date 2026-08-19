/**
 * Unit tests for the @tern-tui/core factory API.
 *
 * These exercise the declarative surface (`Text`/`Box`/`Node`) without
 * touching the native addon or a real terminal: `Text`/`Box` build pure
 * node objects and native materialization is lazy (it happens on attach, and
 * constructing a `Renderer` enters raw mode and requires a PTY). The native
 * path — addon loading, scene materialization, render/poll/destroy — is
 * covered by the PTY smoke (`packages/core/smoke.mjs`), so these tests run
 * under plain `deno test` with no permission flags.
 *
 * Event dispatch (the `Renderer` `onKey`/`onResize`/`onFocus`/`onMouse`
 * subscriber sets and the tagged `TernEventJs` returned by `pollEvents`) is
 * exercised against a *fake* native addon injected through the
 * `setAddonForTesting` seam in `./addon.ts` — no `.node` binary is loaded.
 */

import {
  Box,
  DIFF_ADD_FG,
  DIFF_DEL_FG,
  DiffView,
  FocusManager,
  Input,
  MODAL_BACKDROP_BG,
  MODAL_Z_INDEX,
  Modal,
  Node,
  PANEL_DRAG_MIN_SIZE,
  Panels,
  PROGRESS_DEFAULT_WIDTH,
  PROGRESS_EMPTY_CHAR,
  PROGRESS_FILL_CHAR,
  Progress,
  SCROLLBAR_THUMB_CHAR,
  SCROLLBAR_TRACK_CHAR,
  SELECT_FILTER_PLACEHOLDER,
  SELECTION_DOUBLE_CLICK_MS,
  STREAM_AFFORDANCE_CHAR,
  ScrollView,
  Select,
  Spinner,
  StatusBar,
  StreamingText,
  TAB_ACTIVE_MARKER,
  TAB_CLOSE_CHAR,
  TAB_PRIMARY_BG,
  TAB_PRIMARY_FG,
  Table,
  Tabs,
  Text,
  Textarea,
  THEME_COMPONENTS,
  THEME_ROLES,
  activateTab,
  closeTab,
  collapsePanel,
  closeModal,
  copySelection,
  createRenderer,
  defaultTheme,
  dragPanels,
  dragSelection,
  editKey,
  editTextareaKey,
  endPanelDrag,
  endSelection,
  expandPanel,
  followTail,
  focusAt,
  focusManager,
  focusPanel,
  framesEqual,
  isStreamFollowing,
  measureText,
  mergeTheme,
  name,
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
  selectionKey,
  setSelectionClockForTesting,
  startPanelDrag,
  startSelection,
  styledFramesEqual,
  syncStreamTail,
  tableKey,
  tabsKey,
  tick,
  toggleTreeNode,
  expandTreeNode,
  collapseTreeNode,
  Tree,
  treeKey,
  TREE_COLLAPSED_GLYPH,
  TREE_EXPANDED_GLYPH,
  TREE_GUIDE_VERTICAL,
  visibleTreeRows,
  togglePanel,
  useFocus,
  version,
  visibleOptions,
  visibleTableRows,
  wheelScroll,
  setProgress,
  wrapLineWithOffsets,
} from "./index.ts";
import type {
  NodeProps,
  ProgressProps,
  SelectOption,
  StyleRunJs,
  TabSpec,
  TableColumn,
  TableState,
  TextareaProps,
  TreeNode,
  TreeRow,
  Theme,
  ThemeOverrides,
  ThemeResolvableProps,
} from "./index.ts";
import { setAddonForTesting, loadAddon } from "./addon.ts";
import type { TernAddon } from "./addon.ts";
import type {
  KeyEvent,
  MouseEventJs,
  NodeHandle,
  Renderer,
  SelectionRange,
  Span,
  TernEventJs,
  TuiRenderer,
  TuiRendererOptions,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Fake native addon (push event dispatch)
// ---------------------------------------------------------------------------

/** The push callback registered by the fake `start_event_stream` (the
 * Renderer constructor registers it; tests feed events through it). */
let streamCallback: ((err: Error | null, event: TernEventJs) => void) | null = null;

/** The last `(col, row)` passed to the fake `hit_test`, or `null`. */
let lastHitTest: [number, number] | null = null;

/** The path returned by the fake `hit_test` (override for the click-to-focus
 * tests — an empty path models a press off any painted cell). */
let fakeHitPath: bigint[] = [7n, 3n];

/** The last title passed to the fake `set_title`, or `null`. */
let lastSetTitle: string | null = null;

/** The last text passed to the fake `set_clipboard`, or `null`. */
let lastClipboard: string | null = null;

/** The last options passed to the fake `TuiRenderer` constructor, or `null`. */
let lastRendererOptions: unknown = null;

/** The native node types materialized through the fake `create_node`. */
const createdNodes: Array<{ type: string; props: Record<string, unknown> | null }> = [];

/** Per-handle `content_size` overrides for the panel-drag geometry tests
 * (keyed by the `FakeNodeHandle` instance backing the node). */
const fakeContentSizes = new Map<object, { width: number; height: number }>();

/** The last `(width, height)` passed to the fake `render_to_buffer`, or
 * `null` when the snapshot method was never called. */
let lastSnapshotSize: [number | undefined, number | undefined] | null = null;

/** The last `(width, height)` passed to the fake
 * `render_to_buffer_styled`, or `null` when the styled snapshot method was
 * never called. */
let lastStyledSnapshotSize: [number | undefined, number | undefined] | null = null;

/** The last `FakeTuiRenderer` constructed (via the fake addon), or `null`.
 * Tests read its `renderCalls` to assert native render counts. */
let lastFakeRenderer: FakeTuiRenderer | null = null;

/** The fake's fixed terminal size — what a native render paints at (mirrors
 * the real backend's 80x24 probe used by the native counting tests). */
const FAKE_TERMINAL_SIZE = { width: 80, height: 24 };

/**
 * A fake native `NodeHandle` standing in for the real addon's scene handle.
 * `content_size` returns the per-handle override set via `fakeContentSizes`
 * (used by the panel-drag geometry tests) or a fixed size, so the geometry-
 * query tests exercise the @tern-tui/core plumbing without the native `.node`
 * binary. The handle also records its `kind`/`props` and materialized
 * children, so the fake `render_to_buffer` can paint the captured scene.
 */
class FakeNodeHandle {
  readonly kind: string;
  readonly props: Record<string, unknown>;
  readonly children: FakeNodeHandle[] = [];
  /** Single-key writes recorded via `set_prop`, in call order. */
  readonly propWrites: Array<[string, unknown]> = [];
  /** The number of whole-map `set_props` calls. */
  fullWrites = 0;
  constructor(type: string, props: Record<string, unknown> | null | undefined) {
    this.kind = type;
    this.props = props ?? {};
  }
  content_size(): { width: number; height: number } {
    return fakeContentSizes.get(this) ?? { width: 11, height: 2 };
  }
  add_child(child: unknown): unknown {
    this.children.push(child as FakeNodeHandle);
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    this.children.push(child as FakeNodeHandle);
    return child;
  }
  set_props(props: unknown): void {
    this.fullWrites++;
    Object.assign(this.props, props as Record<string, unknown>);
  }
  set_prop(key: string, value: unknown): void {
    this.propWrites.push([key, value]);
    this.props[key] = value;
  }
  append_span(_text: string, _style?: unknown): void {}
  remove(): boolean {
    return true;
  }
}

/** A fake native `TuiRenderer` standing in for the real addon. */
class FakeTuiRenderer {
  destroyed = false;
  /** The number of native `render()` invocations (the frame-coalescing
   * tests assert on this). */
  renderCalls = 0;
  /** The viewport the last render/snapshotFrame painted at — the fake's
   * fixed terminal size until a snapshot overrides it. Mirrors the real
   * native `size` getter (last painted viewport; the current terminal size
   * before any paint). */
  size = { ...FAKE_TERMINAL_SIZE };
  /** The renderer's selection overlay: the inclusive cell rect
   * `{ col1, row1, col2, row2 }` in viewport coordinates, or `null` when
   * no selection is set. Mirrors the real per-renderer selection state. */
  selection: { col1: number; row1: number; col2: number; row2: number } | null = null;
  /** The rows of the last painted frame (a `render` or `render_to_buffer`
   * snapshot), the fake's stand-in for the native retained buffer that
   * `selection_text` / `selection_word_range` read. */
  lastRows: string[] | null = null;
  /** The scene root handle, reused across `root()` calls so the scene the
   * `Renderer` builds is captured for `render_to_buffer`. */
  private rootHandle = new FakeNodeHandle("root", {});
  constructor(options: unknown) {
    lastRendererOptions = options;
    lastFakeRenderer = this;
  }
  root(): NodeHandle {
    return this.rootHandle as unknown as NodeHandle;
  }
  start_event_stream(callback: (err: Error | null, event: TernEventJs) => void): void {
    streamCallback = callback;
  }
  hit_test(col: number, row: number): bigint[] {
    lastHitTest = [col, row];
    return fakeHitPath;
  }
  render(): void {
    this.renderCalls++;
    // A render paints at the current terminal size — the fake's fixed one —
    // so the last painted viewport resets to it (mirrors the real renderer
    // probing the terminal on each paint).
    this.size = { ...FAKE_TERMINAL_SIZE };
    // Record the frame a render paints, so `selection_text` reads the last
    // painted frame (the real renderer retains the painted buffer).
    this.lastRows = paintSceneRows(this.rootHandle, this.size.width, this.size.height);
  }
  render_to_buffer(width?: number, height?: number): string[] {
    lastSnapshotSize = [width, height];
    // The viewport actually painted at — the explicit dims, or the current
    // size (the native shared-viewport default) — becomes the last painted
    // viewport, so `renderer.size` reports what the last snapshot painted.
    const w = width ?? this.size.width;
    const h = height ?? this.size.height;
    this.size = { width: w, height: h };
    const rows = paintSceneRows(this.rootHandle, w, h);
    this.lastRows = rows;
    return rows;
  }
  render_to_buffer_styled(width?: number, height?: number): StyleRunJs[][] {
    lastStyledSnapshotSize = [width, height];
    // Shares `render_to_buffer`'s viewport-recording semantics: the viewport
    // actually painted at becomes the last painted viewport (the real
    // binding records it identically for both snapshot methods).
    const w = width ?? this.size.width;
    const h = height ?? this.size.height;
    this.size = { width: w, height: h };
    const runs = paintSceneRuns(this.rootHandle, w, h);
    // Concatenating a row's run texts reconstructs the plain row string —
    // the binding's documented invariant — so the retained frame for
    // `selection_text` / `selection_word_range` stays consistent with the
    // plain snapshot path.
    this.lastRows = runs.map((row) => row.map((run) => run.text).join(""));
    return runs;
  }
  destroy(): void {
    this.destroyed = true;
  }
  capabilities = { truecolor: true, colors: 16_777_216 };
  set_title(title: string): void {
    lastSetTitle = title;
  }
  set_clipboard(text: string): void {
    lastClipboard = text;
  }
  set_selection(col1: number, row1: number, col2: number, row2: number): void {
    this.selection = { col1, row1, col2, row2 };
  }
  clear_selection(): void {
    this.selection = null;
  }
  /** The text of the current selection, extracted from the last painted
   * rows: row-major, each display column contributing its cell text (a
   * wide glyph's continuation column is already a space in the fake's
   * rows, mirroring how the real `buffer_rows` renders masked cells), rows
   * joined with `'\n'`. Empty when no selection or no paint yet. */
  selection_text(): string {
    if (this.selection === null || this.lastRows === null) return "";
    const { col1, row1, col2, row2 } = this.selection;
    const x0 = Math.min(col1, col2);
    const y0 = Math.min(row1, row2);
    const x1 = Math.max(col1, col2);
    const y1 = Math.max(row1, row2);
    const lines: string[] = [];
    for (let y = y0; y <= y1; y++) {
      const row = this.lastRows[y] ?? "";
      let line = "";
      for (let x = x0; x <= x1; x++) line += row[x] ?? " ";
      lines.push(line);
    }
    return lines.join("\n");
  }
  /** The inclusive cell range of the contiguous non-space run containing
   * (`col`, `row`) in the last painted rows, or `null` when the cell is a
   * space (or out of bounds, or nothing painted yet). */
  selection_word_range(col: number, row: number): SelectionRange | null {
    if (this.lastRows === null) return null;
    const rowStr = this.lastRows[row];
    if (rowStr === undefined || col >= rowStr.length) return null;
    if (rowStr[col] === " ") return null;
    let left = col;
    while (left > 0 && rowStr[left - 1] !== " ") left--;
    let right = col;
    while (right + 1 < rowStr.length && rowStr[right + 1] !== " ") right++;
    return { col1: left, row1: row, col2: right, row2: row };
  }
}

/** The fake addon injected through `setAddonForTesting`. */
const fakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) => {
    createdNodes.push({ type, props: props ?? null });
    return new FakeNodeHandle(type, props);
  },
} as unknown as TernAddon;

/**
 * Paint a captured fake scene into row strings, standing in for the native
 * `render_to_buffer`.
 *
 * The fake cannot run the real compositor, so this is a minimal painter for
 * the canonical golden scenes: a box child of the root (or a borderless leaf
 * such as a bare text / textarea / input), laid out at the origin of the
 * viewport and sized to its text content plus `padding`, with `border_style`
 * glyphs drawn at the rect edges — exactly the geometry the real compositor
 * produces for the same scene (see the `paint_scene_rows` Rust unit test in
 * src/bindings/tern-node/src/lib.rs). Every row is padded with spaces to the
 * viewport width.
 *
 * The inner text is painted grapheme cluster by grapheme cluster (the same
 * UAX #29 extended-cluster split the core editing layer and the Rust
 * compositor use): a cluster occupies `clusterWidth` columns as one logical
 * glyph — its full text at the lead column, a masked-continuation space on
 * the trailing columns of a 2-column cluster — so a ZWJ family emoji never
 * degrades into per-code-unit fragments. A caret-carrying leaf paints its
 * caret cell as the underlying character (the real compositor reverses the
 * cell's style, which `buffer_rows` renders as the same symbol).
 */
function paintSceneRows(
  root: FakeNodeHandle,
  width: number | undefined,
  height: number | undefined,
): string[] {
  const w = width ?? 6;
  const h = height ?? 3;
  const glyphs: Record<string, readonly [string, string, string, string, string, string]> = {
    rounded: ["┌", "┐", "└", "┘", "─", "│"],
    plain: ["+", "+", "+", "+", "-", "|"],
    double: ["╔", "╗", "╚", "╝", "═", "║"],
    thick: ["┏", "┓", "┗", "┛", "━", "┃"],
  };
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      let ch = " ";
      for (const child of root.children) {
        const textChild = child.children[0];
        const text = typeof textChild?.props.text === "string" ? textChild.props.text : "";
        const pad = typeof child.props.padding === "number" ? child.props.padding : 0;
        const runs = fakeClusterRuns(text);
        const innerWidth = runs.reduce((sum, run) => sum + run.width, 0);
        const bw = innerWidth + 2 * pad;
        const bh = 1 + 2 * pad;
        if (x < bw && y < bh) {
          const g = glyphs[String(child.props.border_style ?? "none")];
          let c = " ";
          if (g !== undefined) {
            if (y === 0) c = x === 0 ? g[0] : x === bw - 1 ? g[1] : g[4];
            else if (y === bh - 1) c = x === 0 ? g[2] : x === bw - 1 ? g[3] : g[4];
            else c = x === 0 || x === bw - 1 ? g[5] : " ";
          }
          if (g !== undefined && y === pad && x >= pad && x < pad + innerWidth) {
            c = clusterTextAt(runs, x - pad);
          } else if (g === undefined && y === 0 && x < innerWidth) {
            // A borderless leaf (bare text / textarea / input) paints its
            // first text child's clusters from the origin.
            c = clusterTextAt(runs, x);
          }
          if (c !== " ") ch = c;
        }
      }
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

/** The style a fake text leaf's props carry, in the `StyleRunJs` field
 * shape: colors as-is, modifiers present only when set (the binding's
 * "modifier keys are present only when set" contract). */
interface FakeCellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reversed?: boolean;
  strikethrough?: boolean;
  /** The hyperlink target, when the leaf's props carry an `href` style key —
   * the fake's mirror of the engine threading `href` into the style's
   * hyperlink and the styled snapshot surfacing it as `hyperlink`. */
  hyperlink?: string;
}

/** The style lifted from a fake text leaf's props, or `null` for an
 * unstyled leaf (or no leaf) — the fake's mirror of the binding lifting
 * the recognized style keys into the node's style. `blink`/`hidden` have
 * no `StyleRunJs` field, so they are dropped like the real surface. */
function leafStyle(leaf: FakeNodeHandle | undefined): FakeCellStyle | null {
  if (leaf === undefined) return null;
  const p = leaf.props;
  const style: FakeCellStyle = {};
  if (typeof p.fg === "string") style.fg = p.fg;
  if (typeof p.bg === "string") style.bg = p.bg;
  if (p.bold === true) style.bold = true;
  if (p.dim === true) style.dim = true;
  if (p.italic === true) style.italic = true;
  if (p.underline === true) style.underline = true;
  if (p.reversed === true) style.reversed = true;
  if (p.strikethrough === true) style.strikethrough = true;
  // The fake node's props carry the scene-facing `href` key (the JS layer
  // translates the camelCase `hyperlink` alias, exactly like `border_color`).
  if (typeof p.href === "string") style.hyperlink = p.href;
  return Object.keys(style).length === 0 ? null : style;
}

/** Whether two styled runs carry the same style — the merge rule behind
 * `render_to_buffer_styled` ("adjacent cells with identical style merge
 * into one run"), so `text` is excluded: the running run's text extends
 * instead of opening a new run. `hyperlink` participates like the other
 * fields — mirroring the engine's style equality, where a hyperlink change
 * splits runs at the link boundary. */
function fakeRunStyleEqual(a: StyleRunJs, b: StyleRunJs): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.reversed === b.reversed &&
    a.strikethrough === b.strikethrough &&
    a.hyperlink === b.hyperlink
  );
}

/**
 * Paint a captured fake scene into styled runs, standing in for the native
 * `render_to_buffer_styled`.
 *
 * The styled counterpart of {@link paintSceneRows}: the same mini-compositor
 * geometry (a content-sized box child at the origin, border glyphs at the
 * rect edges, clusters painted whole with masked-continuation spaces), but
 * each cell also carries the style lifted from the painted text leaf, and
 * adjacent cells with identical style merge into one run — so concatenating
 * a row's run texts reconstructs the `paintSceneRows` row string exactly,
 * the binding's documented invariant. Border and padding cells are
 * unstyled.
 */
function paintSceneRuns(
  root: FakeNodeHandle,
  width: number | undefined,
  height: number | undefined,
): StyleRunJs[][] {
  const w = width ?? 6;
  const h = height ?? 3;
  const glyphs: Record<string, readonly [string, string, string, string, string, string]> = {
    rounded: ["┌", "┐", "└", "┘", "─", "│"],
    plain: ["+", "+", "+", "+", "-", "|"],
    double: ["╔", "╗", "╚", "╝", "═", "║"],
    thick: ["┏", "┓", "┗", "┛", "━", "┃"],
  };
  const rows: StyleRunJs[][] = [];
  for (let y = 0; y < h; y++) {
    const cells: Array<{ ch: string; style: FakeCellStyle | null }> = [];
    for (let x = 0; x < w; x++) {
      let ch = " ";
      let style: FakeCellStyle | null = null;
      for (const child of root.children) {
        const textChild = child.children[0];
        const text = typeof textChild?.props.text === "string" ? textChild.props.text : "";
        const pad = typeof child.props.padding === "number" ? child.props.padding : 0;
        const runs = fakeClusterRuns(text);
        const innerWidth = runs.reduce((sum, run) => sum + run.width, 0);
        const bw = innerWidth + 2 * pad;
        const bh = 1 + 2 * pad;
        if (x < bw && y < bh) {
          const g = glyphs[String(child.props.border_style ?? "none")];
          let c = " ";
          if (g !== undefined) {
            if (y === 0) c = x === 0 ? g[0] : x === bw - 1 ? g[1] : g[4];
            else if (y === bh - 1) c = x === 0 ? g[2] : x === bw - 1 ? g[3] : g[4];
            else c = x === 0 || x === bw - 1 ? g[5] : " ";
          }
          if (g !== undefined && c !== " " && !(y === pad && x >= pad && x < pad + innerWidth)) {
            // A `border_color` on the box paints its border glyphs with that
            // color as their fg (the real compositor swaps the cell style's
            // fg — see paint_box), so the styled runs report it; interior and
            // content cells keep their own styles.
            const borderColor = child.props.border_color;
            if (typeof borderColor === "string") style = { fg: borderColor };
          }
          if (g !== undefined && y === pad && x >= pad && x < pad + innerWidth) {
            c = clusterTextAt(runs, x - pad);
            style = leafStyle(textChild);
          } else if (g === undefined && y === 0 && x < innerWidth) {
            // A borderless leaf (bare text / textarea / input) paints its
            // first text child's clusters from the origin, styled.
            c = clusterTextAt(runs, x);
            style = leafStyle(textChild);
          }
          if (c !== " ") ch = c;
        }
      }
      cells.push({ ch, style });
    }
    // Merge adjacent cells with identical style into runs — the binding's
    // documented run-merge rule for `render_to_buffer_styled`.
    const rowRuns: StyleRunJs[] = [];
    for (const cell of cells) {
      const run: StyleRunJs = { text: cell.ch, ...cell.style };
      const last = rowRuns[rowRuns.length - 1];
      if (last !== undefined && fakeRunStyleEqual(last, run)) {
        last.text += cell.ch;
      } else {
        rowRuns.push(run);
      }
    }
    rows.push(rowRuns);
  }
  return rows;
}

/** The display width of one character in terminal columns — the fake
 * painter's mirror of the core `charWidth` (combining marks 0, wide CJK /
 * emoji 2, else 1). */
function fakeCharWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x1ab0 && code <= 0x1aff) || // combining diacritical marks ext.
    (code >= 0x1dc0 && code <= 0x1dff) || // combining diacritical marks suppl.
    (code >= 0x20d0 && code <= 0x20ff) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) || // combining half marks
    (code >= 0x200b && code <= 0x200f) || // zero-width space / joiners
    code === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo init. consonants
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK … Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) || // fullwidth signs
    (code >= 0x1f300 && code <= 0x1faff) // emoji (surrogate pairs, wide)
  ) {
    return 2;
  }
  return 1;
}

/** The display width of one grapheme cluster in terminal columns — the fake
 * painter's mirror of the core `clusterWidth` (the sum of member `charWidth`s
 * clamped to 2). */
function fakeClusterWidth(cluster: string): number {
  let width = 0;
  for (const ch of cluster) width += fakeCharWidth(ch);
  return Math.min(2, width);
}

/** The extended grapheme clusters of `text` with their display widths — the
 * fake painter's cluster splitter (Intl.Segmenter with the code-point
 * fallback, mirroring the core layer's documented fallback). */
function fakeClusterRuns(text: string): Array<{ width: number; text: string }> {
  const runs: Array<{ width: number; text: string }> = [];
  const segmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  if (segmenter !== null) {
    for (const seg of segmenter.segment(text)) {
      runs.push({ width: fakeClusterWidth(seg.segment), text: seg.segment });
    }
    return runs;
  }
  for (const ch of text) {
    runs.push({ width: fakeCharWidth(ch), text: ch });
  }
  return runs;
}

/** The cluster text painting at display column `col` of `runs`: the cluster's
 * full text at its lead column, a masked-continuation space on a 2-column
 * cluster's trailing column (mirrors `buffer_rows`), or `" "` past the last
 * cluster. */
function clusterTextAt(
  runs: Array<{ width: number; text: string }>,
  col: number,
): string {
  let acc = 0;
  for (const run of runs) {
    if (col < acc + run.width) return col === acc ? run.text : " ";
    acc += run.width;
  }
  return " ";
}

/**
 * Run `fn` with the fake addon installed, resetting the seam afterwards. An
 * async `fn` keeps the seam installed until its promise settles (the renderer
 * holds its native reference directly, but renderer work after an `await`
 * should still resolve against the fake), then resets.
 */
function withFakeAddon<T>(fn: () => T): T {
  streamCallback = null;
  lastHitTest = null;
  fakeHitPath = [7n, 3n];
  createdNodes.length = 0;
  fakeContentSizes.clear();
  lastSetTitle = null;
  lastClipboard = null;
  lastRendererOptions = null;
  lastSnapshotSize = null;
  lastStyledSnapshotSize = null;
  lastFakeRenderer = null;
  setAddonForTesting(fakeAddon);
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => {
      setAddonForTesting(null);
      streamCallback = null;
    }) as T;
  }
  setAddonForTesting(null);
  streamCallback = null;
  return result;
}

/** Drain the macrotask queue (a `setTimeout(0)` round-trip): lets a
 * coalesced frame scheduled via `requestFrame` fire before the test asserts. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Feed `event` to the renderer's push callback (the fake's
 * `start_event_stream`), dispatching it like the native loop would. */
function pushEvent(event: TernEventJs): void {
  const callback = streamCallback;
  if (callback === null) throw new Error("no stream callback registered");
  callback(null, event);
}

Deno.test("core exports package metadata", () => {
  if (name !== "@tern-tui/core") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.2.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});

Deno.test("re-exported napi types are declared", () => {
  // Compile-time contract: the generated napi declarations must be reachable
  // through @tern-tui/core. `KeyEvent`/`TuiRendererOptions`/`NodeHandle`/
  // `TuiRenderer` are type-only; this function body only needs to type-check.
  const ev: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  const opts: TuiRendererOptions = { exit_on_ctrl_c: true };
  let handle: NodeHandle | undefined;
  let renderer: TuiRenderer | undefined;
  if (opts.exit_on_ctrl_c && ev.char) {
    handle = undefined;
    renderer = undefined;
  }
  if (handle !== undefined || renderer !== undefined) {
    throw new Error("unreachable");
  }
});

Deno.test("Text builds a text node with props", () => {
  const node = Text({ text: "hello", bold: true, fg: "#ff0000" });
  if (!(node instanceof Node)) throw new Error("Text() must return a Node");
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (node.props.text !== "hello") throw new Error(`text = ${node.props.text}`);
  if (node.props.bold !== true) throw new Error(`bold = ${node.props.bold}`);
  if (node.props.fg !== "#ff0000") throw new Error(`fg = ${node.props.fg}`);
  if (node.children.length !== 0) throw new Error("text nodes have no children");
});

Deno.test("Text() with no props defaults to an empty prop map", () => {
  const node = Text();
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (Object.keys(node.props).length !== 0) {
    throw new Error(`expected empty props, got ${JSON.stringify(node.props)}`);
  }
});

Deno.test("Box builds a box node with children", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const node = Box({ border_style: "rounded", padding: 1 }, a, b);
  if (node.type !== "box") throw new Error(`type = ${node.type}`);
  if (node.props.border_style !== "rounded") {
    throw new Error(`border_style = ${node.props.border_style}`);
  }
  if (node.props.padding !== 1) throw new Error(`padding = ${node.props.padding}`);
  const children = node.children;
  if (children.length !== 2) throw new Error(`children.length = ${children.length}`);
  if (children[0] !== a || children[1] !== b) {
    throw new Error("children order not preserved");
  }
});

Deno.test("Box() without children yields an empty container", () => {
  const node = Box({ width: 10 });
  if (node.type !== "box") throw new Error(`type = ${node.type}`);
  if (node.children.length !== 0) throw new Error("expected no children");
  if (node.props.width !== 10) throw new Error(`width = ${node.props.width}`);
});

Deno.test("Text and Box return distinct node instances", () => {
  const first = Text({ text: "x" });
  const second = Text({ text: "y" });
  if (first === second) throw new Error("instances must be distinct");
  if (first.props.text !== "x" || second.props.text !== "y") {
    throw new Error("props not isolated per instance");
  }
});

Deno.test("props and children getters return copies", () => {
  const node = Box({ width: 5 }, Text({ text: "kid" }));
  node.props.width = 99;
  if (node.props.width !== 5) throw new Error("props getter must be a copy");
  const kids = node.children as Node[];
  kids.length = 0;
  if (node.children.length !== 1) throw new Error("children getter must be a copy");
});

Deno.test("addChild records children on a detached parent", () => {
  const parent = Box();
  const kid = Text({ text: "k" });
  const returned = parent.addChild(kid);
  if (returned !== kid) throw new Error("addChild must return the child");
  if (parent.children.length !== 1) throw new Error("child not recorded");
  if (parent.children[0] !== kid) throw new Error("wrong child recorded");
  if (parent.attached) throw new Error("detached parent must stay unattached");
  if (kid.attached) throw new Error("child must stay unattached");
});

Deno.test("addChild rejects duplicate children", () => {
  const parent = Box();
  const kid = Text({ text: "k" });
  parent.addChild(kid);
  let threw = false;
  try {
    parent.addChild(kid);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("adding the same child twice must throw");
});

Deno.test("insertBefore before-first and between siblings reflects the new order in children", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  const parent = Box({}, a, b, c);

  // Before-first: insert x ahead of the current first child `a`.
  const x = Text({ text: "x" });
  const returned = parent.insertBefore(x, a);
  if (returned !== x) throw new Error("insertBefore must return the child");
  let kids = parent.children;
  if (kids.length !== 4) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== x || kids[1] !== a || kids[2] !== b || kids[3] !== c) {
    throw new Error("insertBefore before-first must place the child ahead of the anchor");
  }

  // Between siblings: insert y between a and b.
  const y = Text({ text: "y" });
  parent.insertBefore(y, b);
  kids = parent.children;
  if (kids.length !== 5) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== x || kids[1] !== a || kids[2] !== y || kids[3] !== b || kids[4] !== c) {
    throw new Error("insertBefore between siblings must preserve the surrounding order");
  }

  // The detached parent (and the inserted children) stay unattached; the
  // reorder is recorded positionally and lands in the scene on attach.
  if (parent.attached) throw new Error("detached parent must stay unattached");
  if (x.attached || y.attached) throw new Error("inserted children must stay unattached");
});

Deno.test("insertBefore rejects an anchor that is not a child of this node", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  const foreign = Text({ text: "foreign" });
  let threw = false;
  try {
    parent.insertBefore(b, foreign);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("inserting before a foreign anchor must throw");
  const kids = parent.children;
  if (kids.length !== 1) throw new Error("failed insert must not mutate children");
  if (kids[0] !== a) throw new Error("failed insert must not reorder children");
});

Deno.test("insertBefore rejects duplicate children", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  parent.addChild(b);
  let threw = false;
  try {
    parent.insertBefore(a, b);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("inserting an existing child must throw");
  const kids = parent.children;
  if (kids.length !== 2) throw new Error("failed insert must not mutate children");
  if (kids[0] !== a || kids[1] !== b) throw new Error("failed insert must not reorder children");
});

Deno.test("setProps works on a detached template", () => {
  const node = Text({ text: "old" });
  node.setProps({ text: "new", bold: true });
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.bold !== true) throw new Error(`bold = ${node.props.bold}`);
});

// ---------------------------------------------------------------------------
// Props incremental sync (setProp / incremental setProps)
// ---------------------------------------------------------------------------

/** The fake native handle backing an attached `Node`, or `null` when the
 * node is detached. */
function fakeHandleOf(node: Node): FakeNodeHandle | null {
  return node.attached ? (node.handle as unknown as FakeNodeHandle) : null;
}

Deno.test("setProp on a detached template records the prop for materialization", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "old" });
    child.setProp("text", "new");
    child.setProp("bold", true);
    if (child.props.text !== "new" || child.props.bold !== true) {
      throw new Error("detached setProp must record into node.props");
    }
    if (createdNodes.length !== 0) {
      throw new Error("a detached setProp must not materialize a handle");
    }
    renderer.root.addChild(child);
    // Materialization passes the recorded props to the native create_node.
    const created = createdNodes.find((c) => c.type === "text");
    if (created === undefined) {
      throw new Error("attaching the child must create a native handle");
    }
    if (created.props?.text !== "new" || created.props?.bold !== true) {
      throw new Error(
        `materialized props must carry the setProp writes, got ${JSON.stringify(created.props)}`,
      );
    }
  });
});

Deno.test("setProp on an attached node routes through the native single-key path", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a" });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    child.setProp("fg", "#ff0000");
    if (
      handle.propWrites.length !== 1 ||
      handle.propWrites[0]![0] !== "fg" ||
      handle.propWrites[0]![1] !== "#ff0000"
    ) {
      throw new Error(`expected one set_prop("fg", ...), got ${JSON.stringify(handle.propWrites)}`);
    }
    if (handle.fullWrites !== 0) throw new Error("setProp must not call the full set_props");
    if (child.props.fg !== "#ff0000") {
      throw new Error("node.props must mirror the single-key write");
    }
  });
});

Deno.test("setProp with an equal value performs no native call", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a" });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    child.setProp("text", "a"); // equal → skipped at the TS mirror
    const equalWrites = handle.propWrites.slice();
    if (equalWrites.length !== 0) {
      throw new Error(
        `an equal setProp must not cross into the native layer, got ${JSON.stringify(equalWrites)}`,
      );
    }
    child.setProp("text", "b"); // changed → exactly one native write
    const writes = handle.propWrites.slice();
    if (writes.length !== 1 || writes[0] === undefined || writes[0][1] !== "b") {
      throw new Error(
        `expected one set_prop("text", "b"), got ${JSON.stringify(writes)}`,
      );
    }
    if (child.props.text !== "b") throw new Error("node.props must reflect the change");
  });
});

Deno.test("setProps on an attached node sends only changed keys through set_prop", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    child.setProps({ text: "b", bold: true });
    if (
      handle.propWrites.length !== 1 ||
      handle.propWrites[0]![0] !== "text" ||
      handle.propWrites[0]![1] !== "b"
    ) {
      throw new Error(
        `only the changed key may go through set_prop, got ${JSON.stringify(handle.propWrites)}`,
      );
    }
    if (handle.fullWrites !== 0) {
      throw new Error("no removals → no full-map set_props");
    }
    if (child.props.text !== "b" || child.props.bold !== true) {
      throw new Error("node.props must mirror the update");
    }
  });
});

Deno.test("percentage size props pass through as strings and snapshot headlessly", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Box({ width: "50%", min_width: "25%", max_width: "75%", height: 10 });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    // The `"N%"` strings cross the JS -> native boundary verbatim: the
    // binding's json_to_prop_value maps them to PropValue::Str, which
    // tern-layout reads as a percentage of the containing block's size.
    if (
      handle.props.width !== "50%" ||
      handle.props.min_width !== "25%" ||
      handle.props.max_width !== "75%" ||
      handle.props.height !== 10
    ) {
      throw new Error(
        `percentage size props must reach the native handle, got ${JSON.stringify(handle.props)}`,
      );
    }
    if (child.props.width !== "50%" || child.props.min_width !== "25%") {
      throw new Error("node.props must mirror the percentage strings");
    }
    // A percentage-updated setProps goes through the single-key path (the
    // other keys are kept, so no key is removed and no full-map set_props).
    child.setProps({ width: "60%", min_width: "25%", max_width: "75%", height: 10 });
    if (handle.propWrites.length !== 1 || handle.propWrites[0]![1] !== "60%") {
      throw new Error(
        `expected one set_prop("width", "60%"), got ${JSON.stringify(handle.propWrites)}`,
      );
    }
    if (handle.fullWrites !== 0) {
      throw new Error("no removals -> no full-map set_props");
    }
    const widthAfter: string = String(handle.props.width);
    if (widthAfter !== "60%") {
      throw new Error(`handle width = ${widthAfter}`);
    }
    // The headless snapshot paints the percentage-sized scene without error.
    const frame = renderer.snapshotFrame(100, 10);
    if (frame.length !== 10) {
      throw new Error(`snapshotFrame must paint 10 rows, got ${frame.length}`);
    }
  });
});

Deno.test("setProps with equal props performs no native call", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    child.setProps({ text: "a", bold: true }); // fully equal → nothing to write
    if (handle.propWrites.length !== 0 || handle.fullWrites !== 0) {
      throw new Error(
        `an equal setProps must not touch the native layer ` +
          `(propWrites=${JSON.stringify(handle.propWrites)}, fullWrites=${handle.fullWrites})`,
      );
    }
    if (child.props.text !== "a" || child.props.bold !== true) {
      throw new Error("node.props must stay intact");
    }
  });
});

Deno.test("setProps with a removed key falls back to the full-map path", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    child.setProps({ text: "a" }); // bold removed
    if (handle.fullWrites !== 1) {
      throw new Error(`a removal needs the full-map replace, got fullWrites=${handle.fullWrites}`);
    }
    if (handle.propWrites.length !== 0) {
      throw new Error(`the removal path must not use set_prop, got ${JSON.stringify(handle.propWrites)}`);
    }
    if ("bold" in child.props) throw new Error("removed key must leave node.props");
  });
});

Deno.test("setProps strips undefined values like the binding drops them", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const child = Text({ text: "a", bold: true });
    renderer.root.addChild(child);
    const handle = fakeHandleOf(child);
    if (handle === null) throw new Error("attached child must have a native handle");
    // `undefined` has no scene representation: it must be treated as absent,
    // so this is a removal (bold → undefined) → full-map fallback, and the
    // mirror must not retain the phantom key. Built via a Record because
    // `exactOptionalPropertyTypes` rejects `bold: undefined` in literals.
    const next: Record<string, unknown> = { text: "a" };
    next.bold = undefined;
    child.setProps(next as NodeProps);
    if (handle.fullWrites !== 1) throw new Error("undefined values must count as removals");
    if ("bold" in child.props) throw new Error("undefined-valued keys must be stripped");
    if (child.props.text !== "a") throw new Error("remaining props must be intact");
  });
});

Deno.test("StreamingText builds a streaming_text node", () => {
  const node = StreamingText();
  if (!(node instanceof Node)) throw new Error("StreamingText() must return a Node");
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  if (Object.keys(node.props).length !== 0) {
    throw new Error(`expected empty props, got ${JSON.stringify(node.props)}`);
  }
  if (node.children.length !== 0) throw new Error("streaming_text nodes have no children");
  const styled = StreamingText({ fg: "#00ff00", bold: true });
  if (styled.props.fg !== "#00ff00" || styled.props.bold !== true) {
    throw new Error("StreamingText must forward props");
  }
});

Deno.test("appendSpan on a detached node records spans", () => {
  const node = StreamingText();
  node.appendSpan("hello", { bold: true });
  node.appendSpan("world");
  const spans: readonly Span[] = node.spans;
  if (spans.length !== 2) throw new Error(`spans.length = ${spans.length}`);
  const first = spans[0];
  const second = spans[1];
  if (first === undefined || second === undefined) throw new Error("recorded spans missing");
  if (first.text !== "hello") throw new Error(`spans[0].text = ${first.text}`);
  if (first.style?.bold !== true) throw new Error("span style must be recorded");
  if (second.text !== "world") throw new Error(`spans[1].text = ${second.text}`);
  if (second.style !== undefined) throw new Error("omitted style must stay undefined");
  if (node.attached) throw new Error("node must stay unattached");
  (spans as Span[]).length = 0;
  if (node.spans.length !== 2) throw new Error("spans getter must return a copy");
});

Deno.test("setProps still works on streaming nodes", () => {
  const node = StreamingText({ text: "old" });
  node.setProps({ text: "new", fg: "#0000ff" });
  if (node.type !== "streaming_text") throw new Error(`type = ${node.type}`);
  if (node.props.text !== "new") throw new Error(`text = ${node.props.text}`);
  if (node.props.fg !== "#0000ff") throw new Error(`fg = ${node.props.fg}`);
});

Deno.test("remove on a detached template returns false", () => {
  const node = Text({ text: "x" });
  if (node.remove() !== false) throw new Error("detached remove must return false");
  if (node.attached) throw new Error("node must stay unattached");
});

Deno.test("remove detaches the node from its parent's children list", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  parent.addChild(a);
  parent.addChild(b);
  parent.addChild(c);

  // A parentless node (here the detached `parent` itself) cannot be removed.
  if (parent.remove() !== false) throw new Error("parentless remove must return false");

  if (b.remove() !== true) throw new Error("remove must return true when the node is in a tree");
  const kids = parent.children;
  if (kids.length !== 2) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== c) {
    throw new Error("removed child must be spliced out of the children list");
  }
  if (b.attached) throw new Error("removed node must be detached");
});

Deno.test("remove is idempotent and the removed child can be re-added", () => {
  const parent = Box();
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  parent.addChild(a);
  parent.addChild(b);

  if (a.remove() !== true) throw new Error("first remove must return true");
  if (a.remove() !== false) throw new Error("second remove must return false");

  // The removed child is no longer blocked by the duplicate guard: re-adding
  // it appends a fresh scene entry at the end.
  parent.addChild(a);
  const kids = parent.children;
  if (kids.length !== 2) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== b || kids[1] !== a) {
    throw new Error("re-added child must be appended at the end");
  }
});

Deno.test("remove invalidates the whole subtree and re-attach restores it", () => {
  const parent = Box();
  const other = Text({ text: "other" });
  const childBox = Box({}, Text({ text: "deep" }));
  parent.addChild(childBox);
  parent.addChild(other);
  const deep = childBox.children[0]!;

  if (childBox.remove() !== true) throw new Error("subtree root remove must return true");
  const kids = parent.children;
  if (kids.length !== 1 || kids[0] !== other) {
    throw new Error("removed subtree must leave only the remaining sibling");
  }
  if (childBox.attached || deep.attached) {
    throw new Error("the whole subtree must be detached");
  }

  // Re-attaching the removed subtree re-materializes it as a unit (its
  // internal children are preserved).
  parent.insertBefore(childBox, other);
  const after = parent.children;
  if (after.length !== 2 || after[0] !== childBox || after[1] !== other) {
    throw new Error("re-inserted subtree must land before the anchor");
  }
  if (childBox.children.length !== 1 || childBox.children[0] !== deep) {
    throw new Error("subtree children must be preserved across remove/re-add");
  }
});

Deno.test("remove after an ordered insert keeps sibling order", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const c = Text({ text: "c" });
  const parent = Box({}, a, b, c);

  const x = Text({ text: "x" });
  parent.insertBefore(x, b);
  if (parent.children[1] !== x || parent.children[2] !== b) {
    throw new Error("insertBefore must place x before b");
  }

  x.remove();
  const kids = parent.children;
  if (kids.length !== 3) throw new Error(`children.length = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== b || kids[2] !== c) {
    throw new Error("removing x must restore the original order");
  }

  parent.insertBefore(x, b);
  if (parent.children[1] !== x || parent.children[2] !== b) {
    throw new Error("re-inserting x must land before b again");
  }
});

Deno.test("the scene root cannot be removed", () => {
  // wrapRoot is @internal; the fake handle is never touched on this path
  // (remove() short-circuits on the root's missing parent).
  const root = Node.wrapRoot({} as never);
  if (root.remove() !== false) throw new Error("the scene root must not be removable");
  if (!root.attached) throw new Error("the scene root must stay attached");
});

Deno.test("createRenderer is a function accepting options", () => {
  if (typeof createRenderer !== "function") {
    throw new Error(`typeof createRenderer = ${typeof createRenderer}`);
  }
  // Not invoked here: constructing a renderer enters raw mode and needs a PTY,
  // and materializing nodes calls the native addon (needs --allow-ffi). The
  // full renderer lifecycle (render/pollEvents/onKey/destroy + native scene
  // materialization) is covered by the PTY smoke (packages/core/smoke.mjs).
});

// ---------------------------------------------------------------------------
// Terminal capabilities + title (fake native addon)
// ---------------------------------------------------------------------------

Deno.test("createRenderer forwards useAltScreen and title options", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ useAltScreen: false, title: "tern app" });
    // The Renderer routes the camelCase options to the snake_case native
    // constructor options, with the documented defaults for the unset ones.
    if (JSON.stringify(lastRendererOptions) !== JSON.stringify({
      exit_on_ctrl_c: false,
      use_alt_screen: false,
      title: "tern app",
    })) {
      throw new Error(`native options = ${JSON.stringify(lastRendererOptions)}`);
    }
    renderer.destroy();
  });
});

Deno.test("createRenderer defaults useAltScreen to true", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const options = lastRendererOptions as { use_alt_screen?: boolean };
    if (options.use_alt_screen !== true) {
      throw new Error(`use_alt_screen = ${options.use_alt_screen}`);
    }
    if ("title" in (options as object)) {
      throw new Error("title must be omitted when unset");
    }
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Headless mode (fake native addon — option forwarding)
// ---------------------------------------------------------------------------

Deno.test("createRenderer forwards headless and size to the native TuiRenderer, and the renderer works headlessly", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ headless: true, size: { width: 40, height: 10 } });
    // The camelCase headless surface routes to the snake_case native
    // constructor options: `headless` plus the virtual `width`/`height`
    // viewport, alongside the documented defaults for the unset options.
    // The fake records exactly what the real TuiRenderer constructor would
    // receive (the headless option shape of the binding's index.d.ts).
    if (JSON.stringify(lastRendererOptions) !== JSON.stringify({
      exit_on_ctrl_c: false,
      use_alt_screen: true,
      headless: true,
      width: 40,
      height: 10,
    })) {
      throw new Error(`native options = ${JSON.stringify(lastRendererOptions)}`);
    }
    // A headless renderer is fully usable without a TTY: the scene paints
    // into the virtual buffer and the snapshot paths return rows at the
    // configured size — the lifecycle a snapshot tool exercises.
    renderer.root.addChild(Text({ text: "headless" }));
    renderer.render();
    const frame = renderer.snapshotFrame(40, 10);
    if (frame.length !== 10) {
      throw new Error(`headless snapshotFrame rows = ${frame.length}`);
    }
    if (renderer.size.width !== 40 || renderer.size.height !== 10) {
      throw new Error(`headless size = ${JSON.stringify(renderer.size)}`);
    }
    renderer.destroy();
    if (!renderer.destroyed) throw new Error("headless renderer must report destroyed");
  });
});

Deno.test("createRenderer omits headless and size when unset", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const options = lastRendererOptions as Record<string, unknown>;
    // Unset headless stays unset (the native default is `false`, so there
    // is nothing to say) — and the virtual viewport keys appear only when
    // `size` is given, mirroring how `title` is omitted when unset.
    if (options.headless !== undefined) {
      throw new Error(`headless must be omitted when unset: ${JSON.stringify(options.headless)}`);
    }
    if ("width" in options || "height" in options) {
      throw new Error("width/height must be omitted when size is unset");
    }
    renderer.destroy();
  });
});

Deno.test("renderer capabilities getter routes to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const caps = renderer.capabilities;
    if (caps.truecolor !== true) throw new Error(`truecolor = ${caps.truecolor}`);
    if (caps.colors !== 16_777_216) throw new Error(`colors = ${caps.colors}`);
    renderer.destroy();
  });
});

Deno.test("renderer setTitle routes to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.setTitle("tern");
    if (lastSetTitle !== "tern") {
      throw new Error(`set_title called with ${JSON.stringify(lastSetTitle)}`);
    }
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Renderer size + clipboard (fake native addon)
// ---------------------------------------------------------------------------

Deno.test("renderer size reports the last render or snapshotFrame viewport", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // Before any paint the native side surfaces the current terminal size —
    // the fake's fixed 80x24 (the real getter probes through its cached-size
    // machinery on first access).
    let size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(`size before any paint = ${JSON.stringify(size)}`);
    }
    // A render paints at the current terminal size: still the fake's 80x24,
    // so `size` reports the viewport the last render used.
    renderer.render();
    size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(`size after render = ${JSON.stringify(size)}`);
    }
    // The most recent snapshotFrame's viewport wins over the render.
    renderer.snapshotFrame(6, 3);
    size = renderer.size;
    if (size.width !== 6 || size.height !== 3) {
      throw new Error(`size after snapshotFrame(6, 3) = ${JSON.stringify(size)}`);
    }
    // A render at the current terminal size supersedes the snapshot again.
    renderer.render();
    size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(`size after post-snapshot render = ${JSON.stringify(size)}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer setClipboard routes the text and implies the exact OSC 52 escape bytes", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.setClipboard("foo");
    if (lastClipboard !== "foo") {
      throw new Error(`set_clipboard called with ${JSON.stringify(lastClipboard)}`);
    }
    // The JS-level bytes assertion: for the text just handed to the native
    // layer, the escape it must emit is exactly ESC ] 52 ; c ; <base64> BEL,
    // where the payload is the text's UTF-8 bytes base64-encoded per RFC 4648
    // (btoa is the platform's RFC 4648 encoder). The native byte-level
    // emission itself is asserted byte-exact by tern-terminal's
    // `set_clipboard_to` unit tests.
    const expected = `\x1b]52;c;${btoa("foo")}\x07`;
    if (expected !== "\x1b]52;c;Zm9v\x07") {
      throw new Error(`expected escape bytes = ${JSON.stringify(expected)}`);
    }
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Selection overlay (fake native addon — set/clear/extract/word-range)
// ---------------------------------------------------------------------------

Deno.test("renderer setSelection and clearSelection route to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const native = lastFakeRenderer;
    if (native === null) throw new Error("fake renderer not constructed");
    renderer.setSelection(1, 0, 3, 2);
    if (native.selection === null) throw new Error("selection not set on native");
    if (
      native.selection.col1 !== 1 || native.selection.row1 !== 0 ||
      native.selection.col2 !== 3 || native.selection.row2 !== 2
    ) {
      throw new Error(`native selection = ${JSON.stringify(native.selection)}`);
    }
    renderer.clearSelection();
    if (native.selection !== null) {
      throw new Error("clearSelection must clear the native selection");
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionText extracts the selected region from the last painted frame", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // A borderless box around a bare text leaf paints the text from the
    // origin (the fake painter's canonical single-row scene), so a snapshot
    // at 11x1 yields the row "hello world".
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    // No selection set: empty.
    if (renderer.selectionText() !== "") {
      throw new Error(`selectionText without a selection = ${JSON.stringify(renderer.selectionText())}`);
    }
    renderer.setSelection(6, 0, 10, 0); // "world"
    if (renderer.selectionText() !== "world") {
      throw new Error(`selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    // Reversed endpoints normalize to the same rect.
    renderer.setSelection(10, 0, 6, 0);
    if (renderer.selectionText() !== "world") {
      throw new Error(`reversed selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    // A sub-run.
    renderer.setSelection(0, 0, 4, 0);
    if (renderer.selectionText() !== "hello") {
      throw new Error(`sub-run selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    // Clearing the selection empties the extraction.
    renderer.clearSelection();
    if (renderer.selectionText() !== "") {
      throw new Error(`selectionText after clear = ${JSON.stringify(renderer.selectionText())}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionText reads the frame the last snapshot or render painted", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello" })));
    renderer.snapshotFrame(5, 1);
    renderer.setSelection(0, 0, 4, 0);
    if (renderer.selectionText() !== "hello") {
      throw new Error(`snapshot selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    // A render repaints at the terminal size (the fake's 80x24): the wider
    // frame keeps the text at the origin, so the same selection extracts the
    // same run from the freshly painted frame.
    renderer.render();
    if (renderer.selectionText() !== "hello") {
      throw new Error(`post-render selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionWordRange returns the word run or null at whitespace", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    const range = renderer.selectionWordRange(7, 0);
    if (range === null) throw new Error("word range at 'world' must not be null");
    if (range.col1 !== 6 || range.row1 !== 0 || range.col2 !== 10 || range.row2 !== 0) {
      throw new Error(`word range = ${JSON.stringify(range)}`);
    }
    // The boundary between the words is whitespace: null.
    if (renderer.selectionWordRange(5, 0) !== null) {
      throw new Error("whitespace cell must yield null");
    }
    // Out of bounds: null.
    if (renderer.selectionWordRange(50, 0) !== null) {
      throw new Error("out-of-bounds column must yield null");
    }
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Event dispatch (fake native addon — push delivery)
// ---------------------------------------------------------------------------

Deno.test("push events dispatch resize events to onResize and unsubscribe stops dispatch", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const resized: Array<{ width: number; height: number }> = [];
    const unsub = renderer.onResize((size) => resized.push(size));
    const resize: TernEventJs = { type: "resize", width: 120, height: 40 };
    pushEvent(resize);
    if (resized.length !== 1) throw new Error(`onResize calls = ${resized.length}`);
    if (resized[0]!.width !== 120 || resized[0]!.height !== 40) {
      throw new Error(`resize payload = ${JSON.stringify(resized[0])}`);
    }
    // Unsubscribing stops further dispatch.
    unsub();
    pushEvent({ type: "resize", width: 10, height: 10 });
    if (resized.length !== 1) {
      throw new Error("unsubscribed onResize handler must not fire");
    }
  });
});

Deno.test("push events dispatch key events to onKey with the KeyEvent payload", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const keys: KeyEvent[] = [];
    renderer.onKey((event) => keys.push(event));
    const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
    pushEvent({ type: "key", key });
    if (keys.length !== 1 || keys[0] !== key) {
      throw new Error("onKey must receive the unwrapped KeyEvent payload");
    }
  });
});

Deno.test("push events dispatch focus events to onFocus", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const focusEvents: Array<{ focus_gained: boolean }> = [];
    renderer.onFocus((event) => focusEvents.push(event));
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: false });
    if (focusEvents.length !== 2) throw new Error(`onFocus calls = ${focusEvents.length}`);
    if (focusEvents[0]!.focus_gained !== true || focusEvents[1]!.focus_gained !== false) {
      throw new Error(`focus payloads = ${JSON.stringify(focusEvents)}`);
    }
    // Unsubscribe contract mirrors onKey: the removed handler never fires.
    let unsubscribedFired = 0;
    const unsub = renderer.onFocus(() => {
      unsubscribedFired++;
    });
    unsub();
    pushEvent({ type: "focus", focus_gained: true });
    if (unsubscribedFired !== 0) {
      throw new Error("unsubscribed onFocus handler must not fire");
    }
  });
});

Deno.test("push events dispatch mouse events to onMouse", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const mouseEvents: MouseEventJs[] = [];
    renderer.onMouse((event) => mouseEvents.push(event));
    const mouse: MouseEventJs = {
      kind: "down_left",
      column: 3,
      row: 7,
      ctrl: false,
      alt: false,
      shift: true,
    };
    pushEvent({ type: "mouse", mouse });
    if (mouseEvents.length !== 1 || mouseEvents[0] !== mouse) {
      throw new Error("onMouse must receive the MouseEventJs payload");
    }
  });
});

Deno.test("push events dispatch paste events to onPaste with the pasted string", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const pasted: string[] = [];
    renderer.onPaste((text) => pasted.push(text));
    pushEvent({ type: "paste", paste: "hello\n世界" });
    if (pasted.length !== 1 || pasted[0] !== "hello\n世界") {
      throw new Error("onPaste must receive the pasted string payload");
    }
    // Unsubscribe contract mirrors onKey: the removed handler never fires.
    let unsubscribedFired = 0;
    const unsub = renderer.onPaste(() => {
      unsubscribedFired++;
    });
    unsub();
    pushEvent({ type: "paste", paste: "again" });
    if (unsubscribedFired !== 0) {
      throw new Error("unsubscribed onPaste handler must not fire");
    }
  });
});

Deno.test("the events async iterable yields every pushed event without loss", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const events: TernEventJs[] = [
      { type: "key", key: { name: "enter", ctrl: false, alt: false, shift: false } },
      { type: "resize", width: 80, height: 24 },
      { type: "focus", focus_gained: true },
      {
        type: "mouse",
        mouse: { kind: "moved", column: 1, row: 2, ctrl: false, alt: false, shift: false },
      },
      { type: "paste", paste: "pasted 文本" },
    ];
    // Push N synthetic events through the native callback, exactly like the
    // real event loop does.
    for (const event of events) pushEvent(event);

    // The async iterable must yield all N, in order, without loss.
    consumer = (async () => {
      const received: TernEventJs[] = [];
      for await (const event of renderer.events) {
        received.push(event);
        if (received.length === events.length) break;
      }
      if (received.length !== events.length) {
        throw new Error(`received ${received.length} events, expected ${events.length}`);
      }
      for (let i = 0; i < events.length; i++) {
        if (received[i] !== events[i]) {
          throw new Error(`event ${i} must be passed through verbatim`);
        }
      }
    })();
  });
  await consumer;
});

Deno.test("the events async iterable yields a paste event with the pasted text", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    pushEvent({ type: "paste", paste: "multi\nline 粘贴" });
    consumer = (async () => {
      for await (const event of renderer.events) {
        if (event.type !== "paste") {
          throw new Error(`first event type = ${event.type}, expected "paste"`);
        }
        if (event.paste !== "multi\nline 粘贴") {
          throw new Error(`paste payload = ${JSON.stringify(event.paste)}`);
        }
        break;
      }
    })();
  });
  await consumer;
});

Deno.test("the events async iterable delivers events pushed after subscription", async () => {
  let consumer: Promise<void> | undefined;
  const received: TernEventJs[] = [];
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    // Subscribe first, then push — events must still arrive (no missed
    // wakeup between the queue check and the waiter registration).
    // Read the length through a function: TS narrows a const-typed empty
    // array's `length` to 0 (the pushes happen after the consumer starts).
    const receivedCount = (): number => received.length;
    consumer = (async () => {
      for await (const event of renderer.events) {
        received.push(event);
        if (receivedCount() === 3) break;
      }
    })();
    // Push all three while the consumer's waiter is registered — the
    // iterator must wake on each, never missing one.
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: true });
  });
  await consumer;
  if (received.length !== 3) throw new Error(`received ${received.length}`);
});

Deno.test("destroy closes the events stream", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    renderer.destroy();
    consumer = (async () => {
      const received: TernEventJs[] = [];
      for await (const event of renderer.events) {
        received.push(event);
      }
      if (received.length !== 0) throw new Error("a closed stream must yield nothing");
    })();
  });
  await consumer;
});

// ---------------------------------------------------------------------------
// Scene geometry queries (fake native addon)
// ---------------------------------------------------------------------------

Deno.test("Renderer.hit_test proxies (col, row) to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const path = renderer.hit_test(3, 2);
    if (lastHitTest === null || lastHitTest[0] !== 3 || lastHitTest[1] !== 2) {
      throw new Error(`hit_test received ${JSON.stringify(lastHitTest)}`);
    }
    // The fake returns the topmost path [7, 3] verbatim (u64 ids as bigint).
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`hit_test path = ${JSON.stringify(path)}`);
    }
  });
});

Deno.test("Node.contentSize proxies to the native handle", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const stream = StreamingText({ width: 8 });
    renderer.root.addChild(stream);
    // Attaching materialized the node through the fake `create_node` with the
    // streaming_text native type.
    const created = createdNodes[0];
    if (created === undefined || created.type !== "streaming_text") {
      throw new Error(`created native type = ${created?.type}`);
    }
    if (created.props?.width !== 8) {
      throw new Error(`created props = ${JSON.stringify(created.props)}`);
    }
    const size = stream.contentSize();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`contentSize = ${JSON.stringify(size)}`);
    }
  });
});

Deno.test("Node.contentSize on a detached node throws", () => {
  withFakeAddon(() => {
    const node = Text({ text: "x" });
    let threw = false;
    try {
      node.contentSize();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("contentSize on a detached node must throw");
  });
});

Deno.test("the mocked addon exposes hit_test and content_size natively", () => {
  withFakeAddon(() => {
    const addon = loadAddon();
    const renderer = new addon.TuiRenderer({ exit_on_ctrl_c: false });
    const path = renderer.hit_test(1, 1);
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`native hit_test = ${JSON.stringify(path)}`);
    }
    const handle = addon.create_node("text", { text: "hi" });
    const size = handle.content_size();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`native content_size = ${JSON.stringify(size)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Frame snapshots (render_to_buffer)
// ---------------------------------------------------------------------------

Deno.test("Renderer.snapshotFrame paints the scene to golden rows via render_to_buffer", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene: a rounded-border box with 1-cell padding
    // around Text('Hi'). The fake addon's `render_to_buffer` paints the
    // captured scene with a mini-compositor mirroring the real compositor's
    // geometry (content-sized box at the origin), so the rows must match the
    // compositor's exact output — the same golden asserted by the
    // `paint_scene_rows` Rust unit test in src/bindings/tern-node/src/lib.rs:
    //   ┌──┐
    //   │Hi│
    //   └──┘
    // with trailing blanks padded to the 6-column viewport width.
    renderer.root.addChild(Box({ border_style: "rounded", padding: 1 }, Text({ text: "Hi" })));
    const frame = renderer.snapshotFrame(6, 3);
    const expected = ["┌──┐  ", "│Hi│  ", "└──┘  "];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected frame rows: ${JSON.stringify(frame)}`);
    }
    // The viewport was forwarded to the native method.
    if (lastSnapshotSize === null || lastSnapshotSize[0] !== 6 || lastSnapshotSize[1] !== 3) {
      throw new Error(`viewport not forwarded: ${JSON.stringify(lastSnapshotSize)}`);
    }
    // The scene was materialized through the fake addon (box + text).
    if (createdNodes.length !== 2 || createdNodes[0]?.type !== "box" || createdNodes[1]?.type !== "text") {
      throw new Error(`created nodes = ${JSON.stringify(createdNodes)}`);
    }
    renderer.destroy();
  });
});

Deno.test("Renderer.snapshotFrame defaults the viewport to the native shared size", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Text({ text: "x" }));
    // No viewport args: the native method falls back to its shared viewport,
    // so the JS layer must delegate with undefined, undefined.
    renderer.snapshotFrame();
    if (lastSnapshotSize === null || lastSnapshotSize[0] !== undefined || lastSnapshotSize[1] !== undefined) {
      throw new Error(`default viewport not forwarded: ${JSON.stringify(lastSnapshotSize)}`);
    }
    renderer.destroy();
  });
});

Deno.test("framesEqual compares row counts and row strings", () => {
  if (!framesEqual(["┌──┐  ", "│Hi│  "], ["┌──┐  ", "│Hi│  "])) {
    throw new Error("identical frames must be equal");
  }
  if (framesEqual(["┌──┐  ", "│Hi│  "], ["┌──┐  ", "│Hi   "])) {
    throw new Error("differing rows must be unequal");
  }
  if (framesEqual(["┌──┐  "], ["┌──┐  ", "│Hi│  "])) {
    throw new Error("differing row counts must be unequal");
  }
  if (framesEqual([], ["x"])) {
    throw new Error("empty vs non-empty must be unequal");
  }
});

Deno.test("snapshotFrame golden keeps a ZWJ family emoji intact on the caret line", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // A single-line textarea "a👨‍👩‍👧‍👦b" with the caret at display column
    // 1 — the grapheme-cluster boundary between 'a' and the family emoji.
    // The caret rides the first (only) display row, which is the caret line.
    renderer.root.addChild(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }));
    const frame = renderer.snapshotFrame(6, 1);
    // The caret line paints the full cluster as ONE 2-column glyph — 'a' at
    // column 0, the emoji at column 1 with its continuation cell masked to a
    // space (the `buffer_rows` convention), 'b' at column 3 — padded to the
    // 6-column viewport. A per-code-unit painter would fragment the emoji
    // into surrogate halves.
    const expected = [`a${FAMILY_EMOJI} b  `];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected caret-line rows: ${JSON.stringify(frame)}`);
    }
    // The caret leaf carries the caret at the cluster boundary (display
    // column 1) — the caret sits on the same line as the intact emoji.
    const leaf = renderer.root.children[0]?.children[0];
    if (leaf?.props.caret !== 1 || leaf?.props.text !== `a${FAMILY_EMOJI}b`) {
      throw new Error(`caret leaf = ${JSON.stringify(leaf?.props)}`);
    }
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Styled frame snapshots (render_to_buffer_styled)
// ---------------------------------------------------------------------------

Deno.test("Renderer.snapshotStyled paints the scene to golden styled runs via render_to_buffer_styled", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene (the same one snapshotFrame's golden test
    // paints): a rounded-border box with 1-cell padding around a bold red
    // Text('Hi'). The styled fake paints the same geometry into runs —
    // border/padding cells unstyled, the inner text cells carrying the
    // leaf's lifted style — and merges adjacent cells with identical
    // style, mirroring the real render_to_buffer_styled (see the
    // `render_to_buffer_styled_*` Rust unit tests in
    // src/bindings/tern-node/src/lib.rs).
    renderer.root.addChild(
      Box({ border_style: "rounded", padding: 1 }, Text({ text: "Hi", fg: "#ff0000", bold: true })),
    );
    const frame = renderer.snapshotStyled(6, 3);
    // Adjacent cells with identical style merge into one run: the unstyled
    // border glyphs fold with the unstyled trailing padding spaces on each
    // row, while the styled inner text stays its own run between the two
    // unstyled `│` cells.
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐  " }],
      [{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }, { text: "│  " }],
      [{ text: "└──┘  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The viewport was forwarded to the native method.
    if (
      lastStyledSnapshotSize === null ||
      lastStyledSnapshotSize[0] !== 6 ||
      lastStyledSnapshotSize[1] !== 3
    ) {
      throw new Error(`viewport not forwarded: ${JSON.stringify(lastStyledSnapshotSize)}`);
    }
    renderer.destroy();
  });
});

Deno.test("Box borderColor paints the border cells' fg in snapshotStyled runs", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene with a `borderColor`: the border glyphs now
    // carry that color as their fg, so each border run splits from the
    // default-styled blanks into its own `fg: "#ff0000"` run — the styled
    // snapshot reports the border color (the real compositor swaps the border
    // cells' fg — see the `render_to_buffer_styled_border_color_*` Rust unit
    // tests in src/bindings/tern-node/src/lib.rs). The glyphs and the inner
    // text stay unchanged.
    renderer.root.addChild(
      Box({ border_style: "rounded", borderColor: "#ff0000", padding: 1 }, Text({ text: "Hi" })),
    );
    const frame = renderer.snapshotStyled(6, 3);
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐", fg: "#ff0000" }, { text: "  " }],
      [
        { text: "│", fg: "#ff0000" },
        { text: "Hi" },
        { text: "│", fg: "#ff0000" },
        { text: "  " },
      ],
      [{ text: "└──┘", fg: "#ff0000" }, { text: "  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The camelCase alias reaches the native layer as the snake_case style
    // key: the fake node mirror carries `border_color`.
    const boxNode = renderer.root.children[0];
    if (boxNode === undefined) throw new Error("the box child must be materialized");
    if (boxNode.props.border_color !== "#ff0000") {
      throw new Error(`border_color = ${JSON.stringify(boxNode.props.border_color)}`);
    }
    renderer.destroy();
  });
});

Deno.test("Text hyperlink paints the link target onto the styled run", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene with a `hyperlink` on the inner text: the
    // inner "Hi" run now carries `hyperlink: "https://example.com"` — the
    // fake's mirror of the engine threading the `href` style key into the
    // style's hyperlink and the styled snapshot surfacing it as `hyperlink`
    // (like the real surface, the key is present only when set, so the
    // border/padding cells stay unstyled and the run splits from them).
    renderer.root.addChild(
      Box(
        { border_style: "rounded", padding: 1 },
        Text({ text: "Hi", hyperlink: "https://example.com" }),
      ),
    );
    const frame = renderer.snapshotStyled(6, 3);
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐  " }],
      [{ text: "│" }, { text: "Hi", hyperlink: "https://example.com" }, { text: "│  " }],
      [{ text: "└──┘  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The camelCase alias reaches the native layer as the `href` style key
    // (the key convert.rs recognizes): the fake node mirror carries `href`,
    // and the alias is consumed — exactly like `border_color`.
    const boxNode = renderer.root.children[0];
    if (boxNode === undefined) throw new Error("the box child must be materialized");
    const textNode = boxNode.children[0];
    if (textNode === undefined) throw new Error("the text leaf must be materialized");
    if (textNode.props.href !== "https://example.com") {
      throw new Error(`href = ${JSON.stringify(textNode.props.href)}`);
    }
    if ("hyperlink" in textNode.props) {
      throw new Error(`the camelCase alias must be consumed, got ${JSON.stringify(textNode.props)}`);
    }
    renderer.destroy();
  });
});

Deno.test("appendSpan hyperlink translates the camelCase alias to the href style key", () => {
  // The span-style path goes through the same `props_to_style_map` as node
  // props (the binding recognizes `href`, not `hyperlink`), so the alias is
  // translated at ingestion: the recorded span carries the scene-facing key.
  const node = StreamingText();
  node.appendSpan("tern", { hyperlink: "https://example.com", bold: true });
  const first = node.spans[0];
  if (first === undefined) throw new Error("the recorded span is missing");
  if (first.text !== "tern") throw new Error(`text = ${JSON.stringify(first.text)}`);
  if (first.style?.href !== "https://example.com") {
    throw new Error(`href = ${JSON.stringify(first.style?.href)}`);
  }
  if ("hyperlink" in (first.style ?? {})) {
    throw new Error(`the camelCase alias must be consumed, got ${JSON.stringify(first.style)}`);
  }
  if (first.style?.bold !== true) throw new Error("other style keys pass through untouched");
});

Deno.test("Renderer.snapshotStyled defaults the viewport to the native shared size", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Text({ text: "x" }));
    // No viewport args: the native method falls back to its shared viewport,
    // so the JS layer must delegate with undefined, undefined.
    renderer.snapshotStyled();
    if (
      lastStyledSnapshotSize === null ||
      lastStyledSnapshotSize[0] !== undefined ||
      lastStyledSnapshotSize[1] !== undefined
    ) {
      throw new Error(`default viewport not forwarded: ${JSON.stringify(lastStyledSnapshotSize)}`);
    }
    renderer.destroy();
  });
});

Deno.test("snapshotStyled run texts reconstruct the snapshotFrame rows", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(
      Box({ border_style: "rounded", padding: 1 }, Text({ text: "Hi", fg: "#ff0000" })),
    );
    const styled = renderer.snapshotStyled(6, 3);
    const plain = renderer.snapshotFrame(6, 3);
    // The binding's documented invariant: concatenating a row's run texts
    // reconstructs the plain render_to_buffer row string exactly.
    const reconstructed = styled.map((row) => row.map((run) => run.text).join(""));
    if (!framesEqual(reconstructed, plain)) {
      throw new Error(
        `styled runs do not reconstruct plain rows: ${JSON.stringify(reconstructed)} vs ${JSON.stringify(plain)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("styledFramesEqual compares row counts, run counts, run text and style fields", () => {
  // Identical frames — the same rows, runs, texts and style fields.
  if (!styledFramesEqual(
    [[{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }]],
    [[{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }]],
  )) {
    throw new Error("identical styled frames must be equal");
  }
  // Differing run text.
  if (styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{ text: "Bye", fg: "#ff0000" }]])) {
    throw new Error("differing run text must be unequal");
  }
  // Differing color field.
  if (styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{ text: "Hi", fg: "#00ff00" }]])) {
    throw new Error("differing fg must be unequal");
  }
  // Differing modifier field — a run with an explicit modifier differs from
  // one that omits it (the binding only sets modifiers when applied).
  if (styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{ text: "Hi", fg: "#ff0000", bold: true }]])) {
    throw new Error("differing bold must be unequal");
  }
  // Differing hyperlink field — a linked run differs from a plain one (the
  // engine's style equality participates in the hyperlink, so runs split at
  // link boundaries), and the target itself is compared.
  if (styledFramesEqual([[{ text: "Hi" }]], [[{ text: "Hi", hyperlink: "https://example.com" }]])) {
    throw new Error("differing hyperlink must be unequal");
  }
  if (
    styledFramesEqual(
      [[{ text: "Hi", hyperlink: "https://a.example" }]],
      [[{ text: "Hi", hyperlink: "https://b.example" }]],
    )
  ) {
    throw new Error("differing hyperlink targets must be unequal");
  }
  // Differing run count within a row.
  if (styledFramesEqual([[{ text: "Hi" }]], [[{ text: "H" }, { text: "i" }]])) {
    throw new Error("differing run counts must be unequal");
  }
  // Differing row count.
  if (styledFramesEqual([[{ text: "Hi" }]], [[{ text: "Hi" }], [{ text: "x" }]])) {
    throw new Error("differing row counts must be unequal");
  }
});

// ---------------------------------------------------------------------------
// Frame coalescing (fake native addon — render-call counting)
// ---------------------------------------------------------------------------

/** Assert `actual === expected`, reporting `label` with the actual value.
 * A helper rather than inline comparisons keeps the comparison out of any
 * narrowed scope (a prior `!== 0` guard would narrow `renderCalls` to the
 * literal `0` and make a later `!== 1` check a type error). */
function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} = ${JSON.stringify(actual)}`);
  }
}

/** The native renderer instance behind the last `createRenderer` (the fake
 * addon constructs one per renderer; its `renderCalls` counts native
 * renders). */
function fakeRenderer(): FakeTuiRenderer {
  if (lastFakeRenderer === null) throw new Error("no fake renderer constructed");
  return lastFakeRenderer;
}

Deno.test("3 requestFrame calls in one tick collapse into a single native render", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    renderer.requestFrame();
    renderer.requestFrame();
    renderer.requestFrame();
    // Nothing paints synchronously: the frame is scheduled, not fired.
    expectEqual(fake.renderCalls, 0, "render calls before flush");
    await flush();
    // The three calls collapsed into one coalesced native render.
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("requestFrame callbacks run after the coalesced native render, in call order", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    const order: string[] = [];
    renderer.requestFrame(() => order.push("a"));
    renderer.requestFrame(() => order.push("b"));
    expectEqual(order.length, 0, "callbacks before the frame fires");
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls");
    if (order.join("") !== "ab") {
      throw new Error(`callback order = ${JSON.stringify(order)}`);
    }
    renderer.destroy();
  });
});

Deno.test("an explicit render() during a pending coalesced frame still paints immediately", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    renderer.requestFrame();
    expectEqual(fake.renderCalls, 0, "render calls before render()");
    renderer.render();
    // The synchronous paint happens right away, superseding the pending
    // coalesced frame: no second render fires when the macrotask would have.
    expectEqual(fake.renderCalls, 1, "render calls after render()");
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("the requestFrame cancel function prevents the scheduled frame", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    const cancel = renderer.requestFrame();
    cancel();
    await flush();
    expectEqual(fake.renderCalls, 0, "render calls after cancel");
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Roadmap elements: Input
// ---------------------------------------------------------------------------

Deno.test("Input composes a box with a text leaf carrying value and caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  if (input.type !== "input") throw new Error(`type = ${input.type}`);
  if (input.props.value !== "ab") throw new Error(`value = ${input.props.value}`);
  if (input.props.caret !== 1) throw new Error(`caret = ${input.props.caret}`);
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("input must compose a text leaf");
  }
  if (leaf.props.text !== "ab") throw new Error(`leaf text = ${leaf.props.text}`);
  if (leaf.props.caret !== 1) throw new Error(`leaf caret = ${leaf.props.caret}`);
});

Deno.test("Input shows a dim placeholder when empty", () => {
  const input = Input({ placeholder: "type…" });
  const leaf = input.children[0];
  if (leaf === undefined) throw new Error("missing text leaf");
  if (leaf.props.text !== "type…") throw new Error(`placeholder = ${leaf.props.text}`);
  if (leaf.props.dim !== true) throw new Error(`dim = ${leaf.props.dim}`);
  if (leaf.props.caret !== 0) throw new Error(`caret = ${leaf.props.caret}`);
});

Deno.test("editKey inserts a char at the caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  const next = editKey(input, { name: "char", char: "X", ctrl: false, alt: false, shift: false });
  if (next.value !== "aXb") throw new Error(`value = ${next.value}`);
  if (next.caret !== 2) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "aXb") throw new Error(`node value = ${input.props.value}`);
  if (input.children[0]?.props.text !== "aXb") {
    throw new Error(`leaf text = ${input.children[0]?.props.text}`);
  }
});

Deno.test("editKey backspace removes the char before the caret", () => {
  const input = Input({ value: "ab", caret: 2 });
  const next = editKey(input, { name: "backspace", ctrl: false, alt: false, shift: false });
  if (next.value !== "a") throw new Error(`value = ${next.value}`);
  if (next.caret !== 1) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "a") throw new Error(`node value = ${input.props.value}`);
});

Deno.test("editKey moves the caret with arrows, home and end", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const mk = () => Input({ value: "abc", caret: 2 });
  const left = editKey(mk(), { name: "left", ...base });
  if (left.caret !== 1) throw new Error(`left caret = ${left.caret}`);
  const right = editKey(mk(), { name: "right", ...base });
  if (right.caret !== 3) throw new Error(`right caret = ${right.caret}`);
  const home = editKey(mk(), { name: "home", ...base });
  if (home.caret !== 0) throw new Error(`home caret = ${home.caret}`);
  const end = editKey(mk(), { name: "end", ...base });
  if (end.caret !== 3) throw new Error(`end caret = ${end.caret}`);
  // Movement at the boundaries is a no-op.
  const noLeft = editKey(Input({ value: "abc", caret: 0 }), { name: "left", ...base });
  if (noLeft.caret !== 0) throw new Error(`left at start = ${noLeft.caret}`);
  const noRight = editKey(Input({ value: "abc", caret: 3 }), { name: "right", ...base });
  if (noRight.caret !== 3) throw new Error(`right at end = ${noRight.caret}`);
  // Unknown keys leave the input unchanged.
  const unknown = editKey(mk(), { name: "tab", ...base });
  if (unknown.value !== "abc" || unknown.caret !== 2) {
    throw new Error(`tab must not edit: ${unknown.value}/${unknown.caret}`);
  }
});

Deno.test("editKey is multi-width aware for the caret column", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "コ" is a 2-column char: the caret after it sits at display column 2.
  const left = editKey(Input({ value: "コa", caret: 2 }), { name: "left", ...base });
  if (left.caret !== 0) throw new Error(`left over a wide char = ${left.caret}`);
  const right = editKey(Input({ value: "コa", caret: 0 }), { name: "right", ...base });
  if (right.caret !== 2) throw new Error(`right past a wide char = ${right.caret}`);
  // Inserting at column 2 lands between コ and a, and the caret advances by
  // the inserted char's width.
  const ins = editKey(Input({ value: "コa", caret: 2 }), { name: "char", char: "b", ...base });
  if (ins.value !== "コba") throw new Error(`inserted value = ${ins.value}`);
  if (ins.caret !== 3) throw new Error(`inserted caret = ${ins.caret}`);
  // Backspace over a wide char removes the whole glyph and steps two columns.
  const bs = editKey(Input({ value: "コ", caret: 2 }), { name: "backspace", ...base });
  if (bs.value !== "" || bs.caret !== 0) throw new Error(`backspace wide = ${bs.value}/${bs.caret}`);
});

/** The ZWJ family emoji — ONE extended grapheme cluster of 11 code units
 * rendered in 2 terminal columns (tern-core's cluster-width convention). */
const FAMILY_EMOJI = "👨\u200D👩\u200D👧\u200D👦";

Deno.test("editKey steps the cursor over a ZWJ family emoji one cluster at a time", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "a👨‍👩‍👧‍👦b" is 3 grapheme clusters: 'a' (1 col), the family emoji
  // (2 cols, one cluster), 'b' (1 col) — display columns 0, 1–2, 3.
  const mk = (caret: number) => Input({ value: `a${FAMILY_EMOJI}b`, caret });
  // Right steps 0 → 1 → 3 → 4: over 'a', over the whole cluster, over 'b'.
  const r1 = editKey(mk(0), { name: "right", ...base });
  if (r1.caret !== 1) throw new Error(`right over a = ${r1.caret}`);
  const r2 = editKey(mk(1), { name: "right", ...base });
  if (r2.caret !== 3) throw new Error(`right over the emoji = ${r2.caret}`);
  const r3 = editKey(mk(3), { name: "right", ...base });
  if (r3.caret !== 4) throw new Error(`right over b = ${r3.caret}`);
  // Left steps 4 → 3 → 1 → 0 — never a mid-cluster column.
  const l1 = editKey(mk(4), { name: "left", ...base });
  if (l1.caret !== 3) throw new Error(`left over b = ${l1.caret}`);
  const l2 = editKey(mk(3), { name: "left", ...base });
  if (l2.caret !== 1) throw new Error(`left over the emoji = ${l2.caret}`);
  const l3 = editKey(mk(1), { name: "left", ...base });
  if (l3.caret !== 0) throw new Error(`left over a = ${l3.caret}`);
  // Movement never mutates the value.
  const moved = editKey(mk(3), { name: "left", ...base });
  if (moved.value !== `a${FAMILY_EMOJI}b`) throw new Error(`value mutated = ${moved.value}`);
  // home/end land on the boundaries (end = the 4-column display width).
  const end = editKey(mk(0), { name: "end", ...base });
  if (end.caret !== 4) throw new Error(`end caret = ${end.caret}`);
  const home = editKey(mk(4), { name: "home", ...base });
  if (home.caret !== 0) throw new Error(`home caret = ${home.caret}`);
});

Deno.test("editKey backspace removes a ZWJ family emoji as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace from the end removes 'b', then the whole 11-code-unit emoji
  // cluster (stepping two display columns), then 'a' — never a fragment.
  const step1 = editKey(Input({ value: `a${FAMILY_EMOJI}b`, caret: 4 }), {
    name: "backspace",
    ...base,
  });
  if (step1.value !== `a${FAMILY_EMOJI}` || step1.caret !== 3) {
    throw new Error(`backspace b = ${JSON.stringify(step1)}`);
  }
  const step2 = editKey(Input({ value: `a${FAMILY_EMOJI}`, caret: 3 }), {
    name: "backspace",
    ...base,
  });
  if (step2.value !== "a" || step2.caret !== 1) {
    throw new Error(`backspace emoji = ${JSON.stringify(step2)}`);
  }
  const step3 = editKey(Input({ value: "a", caret: 1 }), { name: "backspace", ...base });
  if (step3.value !== "" || step3.caret !== 0) {
    throw new Error(`backspace a = ${JSON.stringify(step3)}`);
  }
});

/** A base plus a combining acute — one 2-code-unit grapheme cluster rendered
 * in 1 terminal column (the mark is zero-width). */
const COMBINING_ACUTE = "e\u{301}";

Deno.test("editKey steps over a base+combining sequence as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "a" + "e\u0301" + "b" is 3 grapheme clusters, each 1 display column:
  // the combining mark rides on its base and is never a step of its own.
  const mk = (caret: number) => Input({ value: `a${COMBINING_ACUTE}b`, caret });
  // Right steps 0 → 1 → 2: over 'a', over the whole cluster, over 'b'.
  const r1 = editKey(mk(0), { name: "right", ...base });
  if (r1.caret !== 1) throw new Error(`right over a = ${r1.caret}`);
  const r2 = editKey(mk(1), { name: "right", ...base });
  if (r2.caret !== 2) throw new Error(`right over the combining cluster = ${r2.caret}`);
  const r3 = editKey(mk(2), { name: "right", ...base });
  if (r3.caret !== 3) throw new Error(`right over b = ${r3.caret}`);
  // Left steps 2 → 1 → 0 — never a column between the base and its mark.
  const l1 = editKey(mk(2), { name: "left", ...base });
  if (l1.caret !== 1) throw new Error(`left over b = ${l1.caret}`);
  const l2 = editKey(mk(1), { name: "left", ...base });
  if (l2.caret !== 0) throw new Error(`left over the combining cluster = ${l2.caret}`);
});

Deno.test("editKey backspace removes a base+combining sequence whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace from the end removes 'b', then the whole 2-code-unit cluster
  // (base + mark together), then 'a' — never the bare base or lone mark.
  const step1 = editKey(Input({ value: `a${COMBINING_ACUTE}b`, caret: 3 }), {
    name: "backspace",
    ...base,
  });
  if (step1.value !== `a${COMBINING_ACUTE}` || step1.caret !== 2) {
    throw new Error(`backspace b = ${JSON.stringify(step1)}`);
  }
  const step2 = editKey(Input({ value: `a${COMBINING_ACUTE}`, caret: 2 }), {
    name: "backspace",
    ...base,
  });
  if (step2.value !== "a" || step2.caret !== 1) {
    throw new Error(`backspace combining = ${JSON.stringify(step2)}`);
  }
  const step3 = editKey(Input({ value: "a", caret: 1 }), { name: "backspace", ...base });
  if (step3.value !== "" || step3.caret !== 0) {
    throw new Error(`backspace a = ${JSON.stringify(step3)}`);
  }
});

Deno.test("pasteInto inserts text at the caret and advances the caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  const next = pasteInto(input, "XY");
  if (next.value !== "aXYb") throw new Error(`value = ${next.value}`);
  if (next.caret !== 3) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "aXYb") throw new Error(`node value = ${input.props.value}`);
  if (input.children[0]?.props.text !== "aXYb") {
    throw new Error(`leaf text = ${input.children[0]?.props.text}`);
  }
  if (input.children[0]?.props.caret !== 3) {
    throw new Error(`leaf caret = ${input.children[0]?.props.caret}`);
  }
  // Pasting at the start / end.
  const start = pasteInto(Input({ value: "ab", caret: 0 }), "X");
  if (start.value !== "Xab" || start.caret !== 1) {
    throw new Error(`start paste = ${start.value}/${start.caret}`);
  }
  const end = pasteInto(Input({ value: "ab", caret: 2 }), "X");
  if (end.value !== "abX" || end.caret !== 3) {
    throw new Error(`end paste = ${end.value}/${end.caret}`);
  }
  // Empty paste is a no-op edit.
  const empty = pasteInto(Input({ value: "ab", caret: 1 }), "");
  if (empty.value !== "ab" || empty.caret !== 1) {
    throw new Error(`empty paste = ${empty.value}/${empty.caret}`);
  }
});

Deno.test("pasteInto is multi-width aware at the caret", () => {
  // コ is a 2-column char. The caret after it sits at display column 2; a
  // 1-column paste lands between コ and a and the caret advances by 1.
  const input = Input({ value: "コa", caret: 2 });
  const next = pasteInto(input, "hi");
  if (next.value !== "コhia") throw new Error(`value = ${next.value}`);
  if (next.caret !== 4) throw new Error(`caret = ${next.caret}`);
  // Pasting wide chars advances the caret by their display width.
  const wide = pasteInto(Input({ value: "ab", caret: 1 }), "世");
  if (wide.value !== "a世b") throw new Error(`wide value = ${wide.value}`);
  if (wide.caret !== 3) throw new Error(`wide caret = ${wide.caret}`);
  // A caret column inside a wide char snaps to that char's start; the caret
  // still advances by the pasted width from its original column (mirroring
  // editKey's char-insert math), landing at the start of the wide char.
  const snap = pasteInto(Input({ value: "コa", caret: 1 }), "x");
  if (snap.value !== "xコa") throw new Error(`snap value = ${snap.value}`);
  if (snap.caret !== 2) throw new Error(`snap caret = ${snap.caret}`);
});

Deno.test("pasteInto before a ZWJ cluster inserts at the cluster boundary", () => {
  // Caret at display column 1 = the boundary between 'a' and the family
  // emoji (the emoji's lead column): the paste lands there and the caret
  // advances by the pasted text's cluster width.
  const atBoundary = pasteInto(Input({ value: `a${FAMILY_EMOJI}b`, caret: 1 }), "X");
  if (atBoundary.value !== `aX${FAMILY_EMOJI}b`) throw new Error(`value = ${atBoundary.value}`);
  if (atBoundary.caret !== 2) throw new Error(`caret = ${atBoundary.caret}`);
  // A caret column inside the emoji's display span (col 2 — its
  // continuation) snaps back to the cluster's start: the paste lands before
  // the cluster, never mid-cluster.
  const snapped = pasteInto(Input({ value: `a${FAMILY_EMOJI}b`, caret: 2 }), "X");
  if (snapped.value !== `aX${FAMILY_EMOJI}b`) throw new Error(`snap value = ${snapped.value}`);
  if (snapped.caret !== 3) throw new Error(`snap caret = ${snapped.caret}`);
  // Pasting the ZWJ cluster advances the caret by its 2-column width.
  const wide = pasteInto(Input({ value: "ab", caret: 1 }), FAMILY_EMOJI);
  if (wide.value !== `a${FAMILY_EMOJI}b`) throw new Error(`wide value = ${wide.value}`);
  if (wide.caret !== 3) throw new Error(`wide caret = ${wide.caret}`);
});

// ---------------------------------------------------------------------------
// Grapheme-editing invariant fuzz (round 4, subtask 6)
// ---------------------------------------------------------------------------
//
// The hand-written grapheme tests above pin individual moves. These suites
// replace the curation with **seeded randomized invariant checks**: a random
// value is built from a grapheme-rich content pool (ASCII, wide CJK, ZWJ
// family emoji, flags, base+combining clusters — the same classes the Rust
// parity fuzz paints), a random boundary caret is chosen, and a random
// sequence of edits (char insert / backspace / left / right / home / end /
// paste) is applied. After **every** edit the following invariants are
// asserted against an independent oracle (Intl.Segmenter + a local mirror of
// the documented width convention, cell.rs:11 — NOT the implementation under
// test):
//
// 1. the cursor always rests on a grapheme-cluster boundary of the current
//    value (the caret is a display column, so "boundary" means the prefix
//    sum of cluster widths — never a column inside a wide cluster's span);
// 2. cluster-width sums are exact: `end` lands on the value's total display
//    width, and `right`/`left` advance by exactly the adjacent cluster's
//    width (so repeated rights walk 0 → totalWidth through every boundary);
// 3. paste round-trips: pasting a text at a boundary splices it at that
//    boundary, advances the caret by the pasted text's total width, and
//    backspacing exactly the pasted text's cluster count restores the
//    original value and caret.
//
// The content pool keeps every fragment a **complete, self-contained
// grapheme cluster** (never a lone ZWJ or lone combining mark), so a splice
// never re-segments across the boundary and the round-trip count is exact.
// Cross-boundary merges (e.g. pasting a combining mark after a base) are the
// domain of the hand-written tests above, which pin them deterministically.
//
// Determinism and CI bounds mirror the Rust suite: one SplitMix64 PRNG with
// a fixed default seed; `TERN_EDIT_SEED` overrides it for CI rotation;
// `TERN_EDIT_ROUNDS` overrides the iteration budget. Defaults are small
// enough that the whole suite runs in a few hundred milliseconds.

/** The family emoji / flags / combining clusters from the Rust fuzz pool —
 * each entry is one complete extended grapheme cluster. */
const EDIT_FRAGMENTS = [
  "a", "b", "c", "x", "Hello", "word", "123", "text", "line", "42",
  "コ", "日", "世", "界", "中", "漢字", "ワイド",
  "👨\u200D👩\u200D👧\u200D👦", // ZWJ family — one cluster, 2 cols
  "🇷🇺", // flag — one cluster, 2 cols
  "e\u{301}", // base + combining acute — one cluster, 1 col
  "a\u{301}",
  "🚀", "🍣",
  "z", "multi", "word",
];

/** Single-cluster characters used for char-insert ops. */
const EDIT_CHARS = ["a", "b", "x", "1", "コ", "日", "世", "🚀", "🍣", "e\u{301}"];

/** The fixed default seed; `TERN_EDIT_SEED` overrides it (CI rotation). */
const EDIT_DEFAULT_SEED = 0xed17_5eed_c0de_1ce;
/** The default iteration budget; `TERN_EDIT_ROUNDS` overrides it. */
const EDIT_DEFAULT_ROUNDS = 240;

/** SplitMix64 — the same PRNG the Rust parity fuzz uses, so a given seed
 * reproduces the exact same edit sequences on every platform. */
class EditRng {
  #state: bigint;
  constructor(seed: bigint) {
    this.#state = seed & 0xffff_ffff_ffff_ffffn;
  }
  #next(): bigint {
    this.#state = (this.#state + 0x9e37_79b9_7f4a_7c15n) & 0xffff_ffff_ffff_ffffn;
    let z = this.#state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & 0xffff_ffff_ffff_ffffn;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & 0xffff_ffff_ffff_ffffn;
    return z ^ (z >> 31n);
  }
  /** A uniform draw in `0..n` (n > 0). */
  below(n: number): number {
    return Number(this.#next() % BigInt(n));
  }
  /** A draw that succeeds with `pct` percent probability. */
  chance(pct: number): boolean {
    return this.#next() % 100n < BigInt(pct);
  }
  /** A random element of an array. */
  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)] as T;
  }
}

/** Read the seed: `TERN_EDIT_SEED` (decimal or 0x-hex), else the fixed
 * default. Deno may deny env access on hardened hosts — that falls back to
 * the default seed too, keeping the suite green without --allow-env. */
function editSeed(): bigint {
  try {
    const raw = Deno.env.get("TERN_EDIT_SEED");
    if (raw !== undefined && raw !== "") {
      return BigInt(raw);
    }
  } catch {
    // env denied — use the fixed default seed.
  }
  return BigInt(EDIT_DEFAULT_SEED);
}

/** Read the iteration budget: `TERN_EDIT_ROUNDS`, else the default. */
function editRounds(): number {
  try {
    const raw = Deno.env.get("TERN_EDIT_ROUNDS");
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // env denied — use the default budget.
  }
  return EDIT_DEFAULT_ROUNDS;
}

/** Mirror of tern-core's `char_width` (cell.rs:11): 0 for NUL and
 * combining/zero-width marks, 2 for wide, 1 otherwise — an independent
 * copy so drift in the implementation is caught, not mirrored. */
function editCharWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

/** The extended grapheme clusters of `value` (UAX #29) as an independent
 * oracle: `{ start, len, width, text }` per cluster. */
function editClusters(value: string): {
  start: number;
  len: number;
  width: number;
  text: string;
}[] {
  const runs: { start: number; len: number; width: number; text: string }[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let start = 0;
  for (const seg of segmenter.segment(value)) {
    const text = seg.segment;
    let width = 0;
    for (const ch of text) width += editCharWidth(ch);
    runs.push({ start, len: text.length, width: Math.min(2, width), text });
    start += text.length;
  }
  return runs;
}

/** The total display width of `value` (the sum of its cluster widths). */
function editTotalWidth(value: string): number {
  let w = 0;
  for (const run of editClusters(value)) w += run.width;
  return w;
}

/** Every display column that is a grapheme-cluster boundary of `value`,
 * including 0 and the total width. The cursor must always sit on one of
 * these. */
function editBoundaryColumns(value: string): number[] {
  const columns = [0];
  let col = 0;
  for (const run of editClusters(value)) {
    col += run.width;
    columns.push(col);
  }
  return columns;
}

/** Build a random value from the cluster-complete fragment pool. */
function editRandomValue(rng: EditRng): string {
  const count = rng.below(5);
  let value = "";
  for (let i = 0; i < count; i++) value += rng.pick(EDIT_FRAGMENTS);
  return value;
}

/** The invariant core shared by every edit fuzz suite: assert the cursor
 * rests on a cluster boundary of `value` and stays within the painted
 * width. `label` names the failing edit for the error message. */
function assertEditCursorInvariant(value: string, caret: number, label: string): void {
  const columns = editBoundaryColumns(value);
  if (!columns.includes(caret)) {
    throw new Error(
      `${label}: cursor ${caret} is not a grapheme-cluster boundary of ` +
        `${JSON.stringify(value)} (boundaries: [${columns.join(", ")}])`,
    );
  }
  if (caret < 0 || caret > editTotalWidth(value)) {
    throw new Error(`${label}: cursor ${caret} outside the painted width of ${JSON.stringify(value)}`);
  }
}

Deno.test("grapheme invariant fuzz: cursor always on a cluster boundary", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const columns = editBoundaryColumns(value);
    const input = Input({ value, caret: rng.pick(columns) });
    const steps = 1 + rng.below(8);
    for (let step = 0; step < steps; step++) {
      const key = rng.below(6);
      let next;
      if (key === 0) {
        next = editKey(input, { name: "char", char: rng.pick(EDIT_CHARS), ...base });
      } else if (key === 1) {
        next = editKey(input, { name: "backspace", ...base });
      } else if (key === 2) {
        next = editKey(input, { name: "left", ...base });
      } else if (key === 3) {
        next = editKey(input, { name: "right", ...base });
      } else if (key === 4) {
        next = editKey(input, { name: "home", ...base });
      } else {
        next = editKey(input, { name: "end", ...base });
      }
      assertEditCursorInvariant(
        next.value,
        next.caret,
        `round ${round} step ${step} (${editKeyEventName(key)})`,
      );
      // The node's own props must mirror the returned state.
      const props = input.props;
      if (props.value !== next.value || props.caret !== next.caret) {
        throw new Error(
          `round ${round} step ${step}: node props ${JSON.stringify(props)} diverge from ` +
            `returned ${JSON.stringify(next)}`,
        );
      }
    }
  }
});

/** Map an op code to its key name for diagnostics. */
function editKeyEventName(code: number): string {
  return ["char", "backspace", "left", "right", "home", "end"][code] ?? "?";
}

Deno.test("grapheme invariant fuzz: cluster-width sums are exact", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const clusters = editClusters(value);
    const total = editTotalWidth(value);

    // `end` lands on the value's total display width — the sum of every
    // cluster's width.
    const end = editKey(Input({ value, caret: 0 }), { name: "end", ...base });
    if (end.caret !== total) {
      throw new Error(
        `round ${round}: end caret ${end.caret} != total width ${total} of ${JSON.stringify(value)}`,
      );
    }

    // `right` from 0 walks through every boundary: each step advances by
    // exactly the adjacent cluster's width, ending on the total width.
    const walk = Input({ value, caret: 0 });
    for (const cluster of clusters) {
      const before = walk.props.caret as number;
      const right = editKey(walk, { name: "right", ...base });
      if (right.caret - before !== cluster.width) {
        throw new Error(
          `round ${round}: right advanced ${right.caret - before} columns, expected ` +
            `${cluster.width} (cluster ${JSON.stringify(cluster.text)} of ${JSON.stringify(value)})`,
        );
      }
    }
    if (walk.props.caret !== total) {
      throw new Error(
        `round ${round}: right-walk ended at ${walk.props.caret}, expected ${total}`,
      );
    }

    // `left` from the end walks back in reverse, again by exact cluster
    // widths.
    const back = Input({ value, caret: total });
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cluster = clusters[i]!;
      const before = back.props.caret as number;
      const left = editKey(back, { name: "left", ...base });
      if (before - left.caret !== cluster.width) {
        throw new Error(
          `round ${round}: left retreated ${before - left.caret} columns, expected ` +
            `${cluster.width} (cluster ${JSON.stringify(cluster.text)})`,
        );
      }
    }
    if (back.props.caret !== 0) {
      throw new Error(`round ${round}: left-walk ended at ${back.props.caret}, expected 0`);
    }
  }
});

Deno.test("grapheme invariant fuzz: paste round-trips at a cluster boundary", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const columns = editBoundaryColumns(value);
    const caret = rng.pick(columns);
    const text = editRandomValue(rng) || "x";
    const input = Input({ value, caret });

    // The paste splices at the cluster boundary the caret column points to.
    const next = pasteInto(input, text);
    const index = boundaryIndexAt(value, caret);
    const expectedSplice = value.slice(0, index) + text + value.slice(index);
    if (next.value !== expectedSplice) {
      throw new Error(
        `round ${round}: paste of ${JSON.stringify(text)} at caret ${caret} produced ` +
          `${JSON.stringify(next.value)}, expected splice ${JSON.stringify(expectedSplice)} ` +
          `(value ${JSON.stringify(value)})`,
      );
    }

    // The caret advances by the pasted text's total display width and stays
    // on a cluster boundary of the new value.
    const pastedWidth = editTotalWidth(text);
    if (next.caret !== caret + pastedWidth) {
      throw new Error(
        `round ${round}: paste caret ${next.caret} != ${caret} + ${pastedWidth}`,
      );
    }
    assertEditCursorInvariant(next.value, next.caret, `round ${round} after paste`);

    // Round-trip: backspacing exactly the pasted text's cluster count
    // restores the original value and caret.
    const clusterCount = editClusters(text).length;
    const replay = Input({ value: next.value, caret: next.caret });
    for (let i = 0; i < clusterCount; i++) {
      editKey(replay, { name: "backspace", ...base });
    }
    const props = replay.props;
    if (props.value !== value || props.caret !== caret) {
      throw new Error(
        `round ${round}: paste round-trip restored ${JSON.stringify(props.value)}@${props.caret}, ` +
          `expected ${JSON.stringify(value)}@${caret}`,
      );
    }
  }
});

/** The code-unit index of the cluster boundary at `column` display columns
 * (the inverse of `indexToColumn`, over the boundary set): the splice
 * point `pasteInto` uses. `column` must be a boundary column of `value`. */
function boundaryIndexAt(value: string, column: number): number {
  let col = 0;
  for (const run of editClusters(value)) {
    if (col === column) return run.start;
    col += run.width;
  }
  return value.length;
}

// ---------------------------------------------------------------------------
// Roadmap elements: Textarea
// ---------------------------------------------------------------------------

Deno.test("Textarea composes one text leaf per line with the caret on the caret's line", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 2 });
  const props = ta.props as TextareaProps;
  if (ta.type !== "textarea") throw new Error(`type = ${ta.type}`);
  if (props.lines?.join(",") !== "ab,cd") throw new Error(`lines = ${JSON.stringify(props.lines)}`);
  if (props.row !== 1 || props.col !== 2) {
    throw new Error(`row/col = ${props.row}/${props.col}`);
  }
  if (ta.children.length !== 2) throw new Error(`leaves = ${ta.children.length}`);
  const first = ta.children[0]!;
  const second = ta.children[1]!;
  if (first.type !== "text" || first.props.text !== "ab") {
    throw new Error(`leaf 0 = ${JSON.stringify(first.props)}`);
  }
  if ("caret" in first.props) throw new Error("the caret's line must be the only one with a caret");
  if (second.props.text !== "cd" || second.props.caret !== 2) {
    throw new Error(`leaf 1 = ${JSON.stringify(second.props)}`);
  }
  // No explicit width: leaves are not sized, each line stays one display row.
  if ("width" in first.props) throw new Error("no width prop without a wrap width");
});

Deno.test("Textarea with a width soft-wraps long lines into multiple leaves", () => {
  // The caret starts at (0,0) unless props say otherwise; the end-of-text
  // caret (col 11) rides the second display line.
  const ta = Textarea({ lines: ["hello world"], width: 5, row: 0, col: 11 });
  if (ta.children.length !== 2) throw new Error(`leaves = ${ta.children.length}`);
  const first = ta.children[0]!;
  const second = ta.children[1]!;
  if (first.props.text !== "hello" || first.props.width !== 5) {
    throw new Error(`wrapped line 0 = ${JSON.stringify(first.props)}`);
  }
  if ("caret" in first.props) throw new Error("the first wrapped line must not carry the caret");
  // The caret (end of "hello world") rides the second display line at its
  // display column (5 — the trailing space at the wrap point is dropped).
  if (second.props.text !== "world" || second.props.caret !== 5) {
    throw new Error(`wrapped line 1 = ${JSON.stringify(second.props)}`);
  }
  // Default caret (0,0) sits on the first display line instead.
  const atStart = Textarea({ lines: ["hello world"], width: 5 });
  if (atStart.children[0]?.props.caret !== 0 || "caret" in (atStart.children[1]?.props ?? {})) {
    throw new Error(`default caret must ride the first line: ${JSON.stringify(atStart.children.map((c) => c.props))}`);
  }
});

Deno.test("wrapLineWithOffsets wraps plain ASCII at the width with exact offsets", () => {
  const wrapped = wrapLineWithOffsets("hello world", 5);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "hello" || wrapped[0]!.start !== 0) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  // The trailing space at the wrap point is dropped, so "world" starts at the
  // code-unit index of 'w' (6), not after the dropped space.
  if (wrapped[1]!.text !== "world" || wrapped[1]!.start !== 6) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // No wrap width: the whole line is one display row starting at 0.
  const flat = wrapLineWithOffsets("hello world", null);
  if (flat.length !== 1 || flat[0]!.text !== "hello world" || flat[0]!.start !== 0) {
    throw new Error(`flat = ${JSON.stringify(flat)}`);
  }
});

Deno.test("wrapLineWithOffsets wraps CJK wide chars by display columns", () => {
  // コ is a 2-column char: 4 of them occupy 8 columns, wrapping at width 4
  // into two rows of two glyphs (4 columns) each.
  const wrapped = wrapLineWithOffsets("ココココ", 4);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "ココ" || wrapped[0]!.start !== 0) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  if (wrapped[1]!.text !== "ココ" || wrapped[1]!.start !== 2) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // Mixed ASCII + wide: "aコ" is 3 columns, so 'b' wraps to its own row.
  const mixed = wrapLineWithOffsets("aコb", 3);
  if (mixed.length !== 2) throw new Error(`mixed rows = ${mixed.length}`);
  if (mixed[0]!.text !== "aコ" || mixed[0]!.start !== 0 || mixed[1]!.text !== "b" || mixed[1]!.start !== 2) {
    throw new Error(`mixed = ${JSON.stringify(mixed)}`);
  }
});

Deno.test("wrapLineWithOffsets hard-breaks a long unbroken token across rows", () => {
  // 20 ASCII chars with no whitespace: the token is wider than the width and
  // breaks every 5 columns into 4 rows.
  const wrapped = wrapLineWithOffsets("supercalifragilistic", 5);
  if (wrapped.length !== 4) throw new Error(`rows = ${wrapped.length}`);
  const texts = wrapped.map((r) => r.text).join("|");
  if (texts !== "super|calif|ragil|istic") throw new Error(`texts = ${texts}`);
  if (wrapped[0]!.start !== 0 || wrapped[1]!.start !== 5 || wrapped[2]!.start !== 10 || wrapped[3]!.start !== 15) {
    throw new Error(`starts = ${wrapped.map((r) => r.start).join(",")}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText treat the empty string as one empty row", () => {
  const wrapped = wrapLineWithOffsets("", 5);
  if (wrapped.length !== 1 || wrapped[0]!.text !== "" || wrapped[0]!.start !== 0) {
    throw new Error(`wrapped = ${JSON.stringify(wrapped)}`);
  }
  const measured = measureText("", 5);
  if (measured.rows !== 1 || measured.maxWidth !== 0) {
    throw new Error(`measured = ${JSON.stringify(measured)}`);
  }
});

Deno.test("measureText sums wrapped rows and reports the widest display line", () => {
  // "hello world" wraps to 2 rows of 5; "ココココ" wraps to 2 rows of 4.
  const measured = measureText("hello world\nココココ", 5);
  if (measured.rows !== 4 || measured.maxWidth !== 5) {
    throw new Error(`measured = ${JSON.stringify(measured)}`);
  }
  // Width <= 0 follows the "no width" convention: each logical line is one
  // display row, and the widest display line is the widest logical line.
  const nowrap = measureText("ab\ncde", 0);
  if (nowrap.rows !== 2 || nowrap.maxWidth !== 3) {
    throw new Error(`nowrap = ${JSON.stringify(nowrap)}`);
  }
  const negative = measureText("ab\ncde", -1);
  if (negative.rows !== 2 || negative.maxWidth !== 3) {
    throw new Error(`negative = ${JSON.stringify(negative)}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText strip ANSI escapes at ingestion", () => {
  // A CSI-colored string measures and wraps identically to its plain text:
  // the escape sequences consume zero cells and belong to no display line.
  const red = "\x1b[31mred\x1b[0m";
  const colored = measureText(red, 5);
  const plain = measureText("red", 5);
  if (colored.rows !== plain.rows || colored.maxWidth !== plain.maxWidth) {
    throw new Error(`colored = ${JSON.stringify(colored)}, plain = ${JSON.stringify(plain)}`);
  }
  if (colored.rows !== 1 || colored.maxWidth !== 3) {
    throw new Error(`colored = ${JSON.stringify(colored)}`);
  }
  // The wrapped row carries only the visible text; its start is the original
  // code-unit index of 'r' (after the 5-byte leading escape).
  const wrapped = wrapLineWithOffsets(red, 5);
  if (wrapped.length !== 1 || wrapped[0]!.text !== "red" || wrapped[0]!.start !== 5) {
    throw new Error(`wrapped = ${JSON.stringify(wrapped)}`);
  }
  // The no-width path strips too, so the composed leaf never carries the
  // escape bytes.
  const flat = wrapLineWithOffsets(red, null);
  if (flat.length !== 1 || flat[0]!.text !== "red" || flat[0]!.start !== 5) {
    throw new Error(`flat = ${JSON.stringify(flat)}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText strip OSC and C1 escape forms", () => {
  // OSC 8 hyperlink (ESC ] ... ESC \), BEL-terminated OSC, the C1 ST (0x9C)
  // terminator, and the C1 CSI (0x9B) lead all strip like the ESC [ SGR
  // form: the visible text is all that measures.
  const link = "\x1b]8;;https://example.com\x1b\\red\x1b]8;;\x1b\\";
  if (measureText(link, 20).maxWidth !== 3) throw new Error(`link`);
  if (measureText("\x1b]0;my title\x07red", 20).maxWidth !== 3) throw new Error(`bel`);
  if (measureText("\x1b]8;;u\x9cred", 20).maxWidth !== 3) throw new Error(`c1st`);
  if (measureText("\x9b31mred\x9b0m", 20).maxWidth !== 3) throw new Error(`c1csi`);
  // A bare ESC inside an OSC body (not followed by `\`) is body data.
  if (measureText("\x1b]0;a\x1bb\x07", 20).maxWidth !== 0) throw new Error(`bare`);
  // Truncated sequences (no final byte / no terminator) strip to the end of
  // the input rather than leaking their bytes.
  if (measureText("red\x1b[31", 20).maxWidth !== 3) throw new Error(`trunc-csi`);
  if (measureText("red\x1b]0;unterminated", 20).maxWidth !== 3) throw new Error(`trunc-osc`);
  if (measureText("a\x1b]0;title", 20).maxWidth !== 1) throw new Error(`trunc-osc-lead`);
  // Only the OSC and CSI shapes strip: a lone ESC that introduces neither
  // (here the charset-designator form ESC ( B) is kept as-is — every byte
  // measures 1, mirroring tern-core's control fallback.
  if (measureText("\x1b(Bred", 20).maxWidth !== 6) throw new Error(`other`);
  // C1 bytes outside the rule — e.g. the C1 OSC lead 0x9D — are kept as-is.
  if (measureText("\x9dred", 20).maxWidth !== 4) throw new Error(`c1osc`);
});

Deno.test("wrapLineWithOffsets offsets skip escape sequences exactly", () => {
  // Escapes are stripped before wrapping, so each row's start is the ORIGINAL
  // code-unit index of its first visible character — exact, and never inside
  // an escape. Stripped "hello world" wraps at 5 into "hello" (original
  // 5..10) and "world" (original 11..15); the trailing escape (16..20)
  // belongs to no display line.
  const wrapped = wrapLineWithOffsets("\x1b[31mhello world\x1b[0m", 5);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "hello" || wrapped[0]!.start !== 5) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  if (wrapped[1]!.text !== "world" || wrapped[1]!.start !== 11) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // An escape between two display characters on one row: "red " starts at
  // original 5, the mid-line escape (8..12) belongs to no display line, and
  // "world" starts at original 13 (the space after the escape is at 12).
  const mid = wrapLineWithOffsets("\x1b[31mred\x1b[0m world", 5);
  if (mid.length !== 2) throw new Error(`mid rows = ${mid.length}`);
  if (mid[0]!.text !== "red " || mid[0]!.start !== 5) {
    throw new Error(`mid row 0 = ${JSON.stringify(mid[0])}`);
  }
  if (mid[1]!.text !== "world" || mid[1]!.start !== 13) {
    throw new Error(`mid row 1 = ${JSON.stringify(mid[1])}`);
  }
  // An embedded newline after an escape starts the next row at the original
  // index of the first character after it.
  const nl = wrapLineWithOffsets("a\x1b[31m\nred\x1b[0m", 5);
  if (nl.length !== 2) throw new Error(`nl rows = ${nl.length}`);
  if (nl[0]!.text !== "a" || nl[0]!.start !== 0) {
    throw new Error(`nl row 0 = ${JSON.stringify(nl[0])}`);
  }
  if (nl[1]!.text !== "red" || nl[1]!.start !== 7) {
    throw new Error(`nl row 1 = ${JSON.stringify(nl[1])}`);
  }
});

Deno.test("escaped wide, ZWJ, and combining content measures as its plain text", () => {
  // Stripping happens before clustering, so an escape never splits a wide
  // char, a ZWJ emoji, or a base+combining pair, and never changes its
  // width: the colored variants measure exactly as the plain content.
  const wide = measureText("\x1b[32mココ\x1b[0m", 10);
  if (wide.rows !== 1 || wide.maxWidth !== 4) {
    throw new Error(`wide = ${JSON.stringify(wide)}`);
  }
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  const zwj = measureText(`\x1b[33m${family}\x1b[0m`, 10);
  if (zwj.rows !== 1 || zwj.maxWidth !== 2) {
    throw new Error(`zwj = ${JSON.stringify(zwj)}`);
  }
  const comb = measureText("\x1b[34me\u0301\x1b[0m", 10);
  if (comb.rows !== 1 || comb.maxWidth !== 1) {
    throw new Error(`comb = ${JSON.stringify(comb)}`);
  }
  // An escape between a base and its combining mark is stripped before
  // clustering, so the pair still forms ONE cluster of width 1.
  const split = measureText("e\x1b[31m\u0301", 10);
  if (split.rows !== 1 || split.maxWidth !== 1) {
    throw new Error(`split = ${JSON.stringify(split)}`);
  }
});

Deno.test("Textarea paints stripped leaves and maps the caret across escapes", () => {
  // The wrapped leaf text is the stripped text (the compositor never sees
  // the escape bytes), and a caret at the end of a colored line lands at the
  // display column of the visible text — the escape interior trails its
  // content, never splitting the caret into an escape.
  const ta = Textarea({ lines: ["\x1b[31mred\x1b[0m"], row: 0, col: 12, width: 5 });
  const leaves = ta.children.map((c) => c.props.text).join("|");
  if (leaves !== "red") throw new Error(`leaves = ${JSON.stringify(leaves)}`);
  const caret = (ta.children[0]?.props as { caret?: number }).caret;
  if (caret !== 3) throw new Error(`caret = ${caret}`);
  // A caret inside the leading escape rests before the first visible char
  // (display column 0 of the only display line).
  const inside = Textarea({ lines: ["\x1b[31mred\x1b[0m"], row: 0, col: 2, width: 5 });
  const insideCaret = (inside.children[0]?.props as { caret?: number }).caret;
  if (insideCaret !== 0) throw new Error(`inside caret = ${insideCaret}`);
});

Deno.test("editTextareaKey inserts chars and splits lines on enter", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const afterChar = editTextareaKey(ta, { name: "char", char: "X", ...base });
  if (afterChar.lines.join(",") !== "ab,cXd" || afterChar.col !== 2) {
    throw new Error(`after insert = ${JSON.stringify(afterChar)}`);
  }
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,cXd") {
    throw new Error(`node lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if (ta.children[1]?.props.text !== "cXd" || ta.children[1]?.props.caret !== 2) {
    throw new Error(`node leaf = ${JSON.stringify(ta.children[1]?.props)}`);
  }
  // Enter splits the line at the caret; the tail becomes a new line.
  const afterEnter = editTextareaKey(ta, { name: "enter", ...base });
  if (afterEnter.lines.join(",") !== "ab,cX,d" || afterEnter.row !== 2 || afterEnter.col !== 0) {
    throw new Error(`after enter = ${JSON.stringify(afterEnter)}`);
  }
  if (ta.children.length !== 3) throw new Error(`leaves after split = ${ta.children.length}`);
  if (ta.children[2]?.props.text !== "d" || ta.children[2]?.props.caret !== 0) {
    throw new Error(`split tail leaf = ${JSON.stringify(ta.children[2]?.props)}`);
  }
});

Deno.test("editTextareaKey backspace and delete remove chars and join lines", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace at the start of a line joins the previous line at the join point.
  const join = Textarea({ lines: ["ab", "cd"], row: 1, col: 0 });
  const joined = editTextareaKey(join, { name: "backspace", ...base });
  if (joined.lines.join(",") !== "abcd" || joined.row !== 0 || joined.col !== 2) {
    throw new Error(`backspace join = ${JSON.stringify(joined)}`);
  }
  // Delete at the end of a line joins the next line.
  const fwd = Textarea({ lines: ["ab", "cd"], row: 0, col: 2 });
  const deleted = editTextareaKey(fwd, { name: "delete", ...base });
  if (deleted.lines.join(",") !== "abcd" || deleted.row !== 0 || deleted.col !== 2) {
    throw new Error(`delete join = ${JSON.stringify(deleted)}`);
  }
  // Boundary deletes are no-ops.
  const top = Textarea({ lines: ["x"], row: 0, col: 0 });
  const noBack = editTextareaKey(top, { name: "backspace", ...base });
  if (noBack.lines.join(",") !== "x") {
    throw new Error(`backspace at top = ${JSON.stringify(noBack)}`);
  }
  const bottom = Textarea({ lines: ["x"], row: 0, col: 1 });
  const noFwd = editTextareaKey(bottom, { name: "delete", ...base });
  if (noFwd.lines.join(",") !== "x") throw new Error(`delete at bottom = ${JSON.stringify(noFwd)}`);
});

Deno.test("editTextareaKey navigates left/right/home/end with wrap-around", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const mk = () => Textarea({ lines: ["ab", "cd"], row: 1, col: 0 });
  const left = editTextareaKey(mk(), { name: "left", ...base });
  if (left.row !== 0 || left.col !== 2) {
    throw new Error(`left wraps up = ${left.row}/${left.col}`);
  }
  const right = editTextareaKey(mk(), { name: "right", ...base });
  if (right.row !== 1 || right.col !== 1) throw new Error(`right = ${right.row}/${right.col}`);
  const end = editTextareaKey(mk(), { name: "end", ...base });
  if (end.row !== 1 || end.col !== 2) throw new Error(`end = ${end.row}/${end.col}`);
  const home = editTextareaKey(mk(), { name: "home", ...base });
  if (home.row !== 1 || home.col !== 0) throw new Error(`home = ${home.row}/${home.col}`);
  // Unknown keys leave the textarea unchanged.
  const unknown = editTextareaKey(mk(), { name: "tab", ...base });
  if (unknown.lines.join(",") !== "ab,cd" || unknown.row !== 1 || unknown.col !== 0) {
    throw new Error(`tab must not edit: ${JSON.stringify(unknown)}`);
  }
});

Deno.test("editTextareaKey up/down traverse soft-wrapped display lines", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "hello world" wraps at width 5 into "hello" / "world"; the caret at the
  // end sits on display row 1 at display col 5.
  const ta = Textarea({ lines: ["hello world"], width: 5, row: 0, col: 11 });
  const up = editTextareaKey(ta, { name: "up", ...base });
  if (up.row !== 0 || up.col !== 5) throw new Error(`up = ${up.row}/${up.col}`);
  const down = editTextareaKey(ta, { name: "down", ...base });
  if (down.row !== 0 || down.col !== 11) throw new Error(`down = ${down.row}/${down.col}`);
  // The preferred column sticks across the vertical run: from the end of the
  // last display line, three ups climb the display rows keeping col 5.
  const multi = Textarea({ lines: ["alpha beta", "gamma delta"], width: 5, row: 1, col: 11 });
  const u1 = editTextareaKey(multi, { name: "up", ...base });
  if (u1.row !== 1 || u1.col !== 5) throw new Error(`u1 = ${u1.row}/${u1.col}`);
  const u2 = editTextareaKey(multi, { name: "up", ...base });
  if (u2.row !== 0 || u2.col !== 10) throw new Error(`u2 = ${u2.row}/${u2.col}`);
  const u3 = editTextareaKey(multi, { name: "up", ...base });
  if (u3.row !== 0 || u3.col !== 5) throw new Error(`u3 = ${u3.row}/${u3.col}`);
  const d1 = editTextareaKey(multi, { name: "down", ...base });
  if (d1.row !== 0 || d1.col !== 10) throw new Error(`d1 = ${d1.row}/${d1.col}`);
});

Deno.test("editTextareaKey scrolls vertically to keep the caret visible", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const scrollOf = (node: Node): number => (node.props as TextareaProps).scroll ?? 0;
  const ta = Textarea({ lines: ["1", "2", "3", "4", "5"], height: 2, row: 0, col: 0 });
  if (scrollOf(ta) !== 0) throw new Error(`initial scroll = ${scrollOf(ta)}`);
  editTextareaKey(ta, { name: "down", ...base }); // (1,0) — visible
  if (scrollOf(ta) !== 0) throw new Error(`scroll after 1 down = ${scrollOf(ta)}`);
  editTextareaKey(ta, { name: "down", ...base }); // (2,0) — below the window
  if (scrollOf(ta) !== 1) throw new Error(`scroll after 2 downs = ${scrollOf(ta)}`);
  // Only the visible window is composed: rows 2 and 3 (scroll 1, height 2).
  if (ta.children.length !== 2) throw new Error(`window leaves = ${ta.children.length}`);
  if (ta.children[0]?.props.text !== "2" || ta.children[1]?.props.text !== "3") {
    throw new Error(`window = ${ta.children.map((c) => c.props.text).join(",")}`);
  }
  if (ta.children[1]?.props.caret !== 0) {
    throw new Error(`caret on the windowed leaf = ${ta.children[1]?.props.caret}`);
  }
  editTextareaKey(ta, { name: "up", ...base }); // (1,0) — still inside [1,3)
  if (scrollOf(ta) !== 1) throw new Error(`scroll stays while visible = ${scrollOf(ta)}`);
  editTextareaKey(ta, { name: "up", ...base }); // (0,0) — above the window
  if (scrollOf(ta) !== 0) throw new Error(`scroll after up past the top = ${scrollOf(ta)}`);
});

Deno.test("pasteIntoTextarea inserts text at the caret (single line)", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const next = pasteIntoTextarea(ta, "XY");
  if (next.lines.join(",") !== "ab,cXYd") throw new Error(`lines = ${next.lines.join(",")}`);
  if (next.row !== 1 || next.col !== 3) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,cXYd") {
    throw new Error(`node lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if (ta.children[1]?.props.text !== "cXYd" || ta.children[1]?.props.caret !== 3) {
    throw new Error(`node leaf = ${JSON.stringify(ta.children[1]?.props)}`);
  }
  // Pasting at the start / end stays on the same line.
  const start = pasteIntoTextarea(Textarea({ lines: ["ab"], row: 0, col: 0 }), "X");
  if (start.lines.join(",") !== "Xab" || start.col !== 1) {
    throw new Error(`start paste = ${start.lines.join(",")}/${start.col}`);
  }
  const end = pasteIntoTextarea(Textarea({ lines: ["ab"], row: 0, col: 2 }), "X");
  if (end.lines.join(",") !== "abX" || end.col !== 3) {
    throw new Error(`end paste = ${end.lines.join(",")}/${end.col}`);
  }
});

Deno.test("pasteIntoTextarea splits lines on pasted newlines", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const next = pasteIntoTextarea(ta, "X\nYZ");
  if (next.lines.join(",") !== "ab,cX,YZd") throw new Error(`lines = ${next.lines.join(",")}`);
  if (next.row !== 2 || next.col !== 2) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  // The tail of the original line joins the last pasted segment.
  if (ta.children.length !== 3) throw new Error(`leaves after split = ${ta.children.length}`);
  if (ta.children[2]?.props.text !== "YZd" || ta.children[2]?.props.caret !== 2) {
    throw new Error(`tail leaf = ${JSON.stringify(ta.children[2]?.props)}`);
  }
  // A leading newline pastes an empty first line (pure line split).
  const lead = pasteIntoTextarea(Textarea({ lines: ["ab"], row: 0, col: 0 }), "\nxy");
  if (lead.lines.join(",") !== ",xyab" || lead.row !== 1 || lead.col !== 2) {
    throw new Error(`leading newline = ${lead.lines.join(",")}/${lead.row}/${lead.col}`);
  }
  // A trailing newline moves the tail to a fresh line.
  const trail = pasteIntoTextarea(Textarea({ lines: ["ab"], row: 0, col: 1 }), "x\n");
  if (trail.lines.join(",") !== "ax,b" || trail.row !== 1 || trail.col !== 0) {
    throw new Error(`trailing newline = ${trail.lines.join(",")}/${trail.row}/${trail.col}`);
  }
});

Deno.test("pasteIntoTextarea is multi-width aware for wide pastes", () => {
  // コ is a 2-column char. The caret column is a code-unit index (like
  // editTextareaKey): "aコb" is 3 code units, so col 2 is after コ and a
  // paste there lands between コ and b, advancing the caret by the pasted
  // code units.
  const ta = Textarea({ lines: ["aコb"], row: 0, col: 2 });
  const next = pasteIntoTextarea(ta, "世");
  if (next.lines[0] !== "aコ世b") throw new Error(`value = ${next.lines[0]}`);
  if (next.row !== 0 || next.col !== 3) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  if (ta.children[0]?.props.text !== "aコ世b" || ta.children[0]?.props.caret !== 5) {
    throw new Error(`leaf = ${JSON.stringify(ta.children[0]?.props)}`);
  }
  // A wide paste between wide chars keeps the code-unit caret consistent:
  // "コa" is 2 code units, col 1 is between コ and a.
  const mid = pasteIntoTextarea(Textarea({ lines: ["コa"], row: 0, col: 1 }), "文");
  if (mid.lines[0] !== "コ文a" || mid.col !== 2) {
    throw new Error(`mid wide = ${mid.lines[0]}/${mid.col}`);
  }
});

Deno.test("editTextareaKey steps left/right over a ZWJ family emoji one cluster at a time", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // The line is 'a' + emoji + 'b'; col is a code-unit index. Cluster starts:
  // 'a' at 0, the 11-code-unit emoji at 1, 'b' at 12.
  const right1 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 0 }), {
    name: "right",
    ...base,
  });
  if (right1.col !== 1) throw new Error(`right over a = ${right1.col}`);
  const right2 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }), {
    name: "right",
    ...base,
  });
  if (right2.col !== 12) throw new Error(`right over the emoji = ${right2.col}`);
  const right3 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }), {
    name: "right",
    ...base,
  });
  if (right3.col !== 13) throw new Error(`right over b = ${right3.col}`);
  const left1 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 13 }), {
    name: "left",
    ...base,
  });
  if (left1.col !== 12) throw new Error(`left over b = ${left1.col}`);
  const left2 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }), {
    name: "left",
    ...base,
  });
  if (left2.col !== 1) throw new Error(`left over the emoji = ${left2.col}`);
  const left3 = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }), {
    name: "left",
    ...base,
  });
  if (left3.col !== 0) throw new Error(`left over a = ${left3.col}`);
});

Deno.test("editTextareaKey backspace and delete remove a ZWJ family emoji whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace before 'b' removes 'b'; backspace before the emoji removes the
  // whole 11-code-unit cluster, never a fragment.
  const bsB = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 13 }), {
    name: "backspace",
    ...base,
  });
  if (bsB.lines[0] !== `a${FAMILY_EMOJI}` || bsB.col !== 12) {
    throw new Error(`backspace b = ${JSON.stringify(bsB)}`);
  }
  const bsFam = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }), {
    name: "backspace",
    ...base,
  });
  if (bsFam.lines[0] !== "ab" || bsFam.col !== 1) {
    throw new Error(`backspace emoji = ${JSON.stringify(bsFam)}`);
  }
  // Delete at the cluster boundary removes the whole cluster; the cursor
  // stays at the boundary (the following char's start).
  const del = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }), {
    name: "delete",
    ...base,
  });
  if (del.lines[0] !== "ab" || del.col !== 1) {
    throw new Error(`delete emoji = ${JSON.stringify(del)}`);
  }
  // A mid-cluster cursor (from caller props) snaps to the boundary after its
  // cluster — where its caret visually paints — so backspace removes the
  // whole cluster.
  const snapped = editTextareaKey(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 5 }), {
    name: "backspace",
    ...base,
  });
  if (snapped.lines[0] !== "ab" || snapped.col !== 1) {
    throw new Error(`snapped backspace = ${JSON.stringify(snapped)}`);
  }
});

Deno.test("pasteIntoTextarea before a ZWJ cluster inserts at the cluster boundary", () => {
  // col 1 is the boundary between 'a' and the emoji: the paste lands there.
  const atBoundary = pasteIntoTextarea(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }), "X");
  if (atBoundary.lines[0] !== `aX${FAMILY_EMOJI}b`) throw new Error(`value = ${atBoundary.lines[0]}`);
  if (atBoundary.row !== 0 || atBoundary.col !== 2) {
    throw new Error(`row/col = ${atBoundary.row}/${atBoundary.col}`);
  }
  // A mid-cluster cursor snaps to the boundary after its cluster — the paste
  // lands after the emoji, before 'b', never inside the cluster.
  const snapped = pasteIntoTextarea(Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 5 }), "X");
  if (snapped.lines[0] !== `a${FAMILY_EMOJI}Xb`) throw new Error(`snap value = ${snapped.lines[0]}`);
  if (snapped.row !== 0 || snapped.col !== 13) {
    throw new Error(`snap row/col = ${snapped.row}/${snapped.col}`);
  }
});

Deno.test("editTextareaKey steps over a base+combining sequence as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // The line is 'a' + "e\u0301" + 'b'; col is a code-unit index. The
  // combining cluster occupies code units 1..3 (base 'e' at 1, mark at 2);
  // 'b' starts at 3.
  const right1 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 0 }), {
    name: "right",
    ...base,
  });
  if (right1.col !== 1) throw new Error(`right over a = ${right1.col}`);
  const right2 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }), {
    name: "right",
    ...base,
  });
  if (right2.col !== 3) throw new Error(`right over the combining cluster = ${right2.col}`);
  const right3 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }), {
    name: "right",
    ...base,
  });
  if (right3.col !== 4) throw new Error(`right over b = ${right3.col}`);
  const left1 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 4 }), {
    name: "left",
    ...base,
  });
  if (left1.col !== 3) throw new Error(`left over b = ${left1.col}`);
  const left2 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }), {
    name: "left",
    ...base,
  });
  if (left2.col !== 1) throw new Error(`left over the combining cluster = ${left2.col}`);
  const left3 = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }), {
    name: "left",
    ...base,
  });
  if (left3.col !== 0) throw new Error(`left over a = ${left3.col}`);
});

Deno.test("editTextareaKey backspace and delete remove a base+combining sequence whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace before 'b' removes 'b'; backspace before the cluster removes
  // the whole 2-code-unit base+mark pair, never a fragment.
  const bsB = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 4 }), {
    name: "backspace",
    ...base,
  });
  if (bsB.lines[0] !== `a${COMBINING_ACUTE}` || bsB.col !== 3) {
    throw new Error(`backspace b = ${JSON.stringify(bsB)}`);
  }
  const bsSeq = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }), {
    name: "backspace",
    ...base,
  });
  if (bsSeq.lines[0] !== "ab" || bsSeq.col !== 1) {
    throw new Error(`backspace combining = ${JSON.stringify(bsSeq)}`);
  }
  // Delete at the cluster boundary removes the whole cluster; the cursor
  // stays at the boundary.
  const del = editTextareaKey(Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }), {
    name: "delete",
    ...base,
  });
  if (del.lines[0] !== "ab" || del.col !== 1) {
    throw new Error(`delete combining = ${JSON.stringify(del)}`);
  }
});

// ---------------------------------------------------------------------------
// Roadmap elements: Spinner
// ---------------------------------------------------------------------------

Deno.test("Spinner renders a determinate bar of filled and empty cells", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  if (bar.type !== "spinner") throw new Error(`type = ${bar.type}`);
  if (bar.props.text !== "▓▓░░") throw new Error(`bar = ${bar.props.text}`);
  const full = Spinner({ value: 10, max: 10, width: 3 });
  if (full.props.text !== "▓▓▓") throw new Error(`full = ${full.props.text}`);
  const none = Spinner({ value: 0, max: 10, width: 3 });
  if (none.props.text !== "░░░") throw new Error(`empty = ${none.props.text}`);
  // Filled cells round up: 3/10 * 4 = 1.2 -> 2 cells.
  const ceilBar = Spinner({ value: 3, max: 10, width: 4 });
  if (ceilBar.props.text !== "▓▓░░") throw new Error(`ceil = ${ceilBar.props.text}`);
});

Deno.test("tick advances the indeterminate frame and wraps", () => {
  const spinner = Spinner({ frames: ["a", "b", "c"] });
  const text0 = spinner.props.text;
  if (text0 !== "a") throw new Error(`frame 0 = ${text0}`);
  const t1 = tick(spinner);
  if (t1 !== "b") throw new Error(`tick 1 = ${t1}`);
  const f1 = spinner.props.frame;
  if (f1 !== 1) throw new Error(`frame = ${f1}`);
  const t2 = tick(spinner);
  if (t2 !== "c") throw new Error(`tick 2 = ${t2}`);
  const t3 = tick(spinner);
  if (t3 !== "a") throw new Error(`tick wrap = ${t3}`);
  const f3 = spinner.props.frame;
  if (f3 !== 3) throw new Error(`frame wrap = ${f3}`);
});

Deno.test("tick on a determinate spinner leaves the bar unchanged", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  const before = bar.props.text;
  const next = tick(bar);
  if (next !== "▓▓░░") throw new Error(`next = ${next}`);
  if (bar.props.text !== before) throw new Error("determinate bar must not change on tick");
  if (bar.props.frame !== undefined) throw new Error(`frame = ${bar.props.frame}`);
});

// ---------------------------------------------------------------------------
// Roadmap elements: StatusBar
// ---------------------------------------------------------------------------

Deno.test("StatusBar composes left/center/right segment Text nodes", () => {
  const bar = StatusBar({ left: "L", center: "C", right: "R" });
  if (bar.type !== "status_bar") throw new Error(`type = ${bar.type}`);
  if (bar.props.flex_direction !== "row") throw new Error(`flex_direction = ${bar.props.flex_direction}`);
  if (bar.props.justify_content !== "space-between") {
    throw new Error(`justify_content = ${bar.props.justify_content}`);
  }
  if (bar.props.height !== 1) throw new Error(`height = ${bar.props.height}`);
  const kids = bar.children;
  if (kids.length !== 3) throw new Error(`segments = ${kids.length}`);
  const [left, center, right] = kids;
  if (left === undefined || left.type !== "text" || left.props.text !== "L") {
    throw new Error("left segment must be a Text with the segment text");
  }
  if (center?.props.text !== "C") throw new Error("center segment text");
  if (right?.props.text !== "R") throw new Error("right segment text");
});

Deno.test("StatusBar accepts node segments, omits missing ones, and lifts segment keys out of the strip props", () => {
  const rightNode = Text({ text: "R" });
  const bar = StatusBar({ left: "only", right: rightNode });
  const kids = bar.children;
  if (kids.length !== 2) throw new Error(`segments = ${kids.length}`);
  if (kids[0]?.props.text !== "only") throw new Error(`left text = ${kids[0]?.props.text}`);
  if (kids[1] !== rightNode) throw new Error("a node segment must be used verbatim");
  // left/right are absolute-position inset keywords in tern-layout; the
  // segment keys must never reach the strip's props.
  if ("left" in bar.props || "right" in bar.props || "center" in bar.props) {
    throw new Error(`segment keys leaked into strip props: ${JSON.stringify(bar.props)}`);
  }
});

// ---------------------------------------------------------------------------
// Roadmap elements: Panels
// ---------------------------------------------------------------------------

Deno.test("Panels builds header + body panels with an active index", () => {
  const bodyA = Text({ text: "a-body" });
  const bodyB = Text({ text: "b-body" });
  const panels = Panels({ panels: [{ header: "A", body: bodyA }, { header: "B", body: bodyB }], active: 1 });
  if (panels.type !== "panels") throw new Error(`type = ${panels.type}`);
  if (panels.props.active !== 1) throw new Error(`active = ${panels.props.active}`);
  if (panels.props.flex_direction !== "column") throw new Error(`direction = ${panels.props.flex_direction}`);
  const kids = panels.children;
  if (kids.length !== 2) throw new Error(`panels = ${kids.length}`);
  const first = kids[0]!;
  const second = kids[1]!;
  if (first.type !== "box") throw new Error(`panel type = ${first.type}`);
  if (first.children.length !== 2) throw new Error("panel A must have header + body");
  if (first.children[0]?.props.text !== "A") throw new Error(`header = ${first.children[0]?.props.text}`);
  if (first.children[1] !== bodyA) throw new Error("panel A body must be the given node");
  if (second.children[1] !== bodyB) throw new Error("panel B body must be the given node");
  // The active panel's header is bold; inactive headers are not.
  if (second.children[0]?.props.bold !== true) throw new Error("active header must be bold");
  if (first.children[0]?.props.bold !== false) throw new Error("inactive header must not be bold");
});

Deno.test("Panels builds collapsed panels header-only", () => {
  const body = Text({ text: "x" });
  const panels = Panels({ panels: [{ header: "A", body, collapsed: true }] });
  const panel = panels.children[0]!;
  if (panel.children.length !== 1) throw new Error(`collapsed children = ${panel.children.length}`);
  if (panel.children[0]?.props.text !== "A") throw new Error("header must be retained");
});

Deno.test("togglePanel collapses and restores a panel body", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  const collapsed = togglePanel(panels, 0);
  if (collapsed !== true) throw new Error("toggle must collapse");
  const collapsedCount = panel.children.length;
  if (collapsedCount !== 1) throw new Error(`collapsed children = ${collapsedCount}`);
  if (body.attached) throw new Error("removed body must be detached");
  const expanded = togglePanel(panels, 0);
  if (expanded !== false) throw new Error("toggle must expand");
  const expandedCount = panel.children.length;
  if (expandedCount !== 2) throw new Error(`expanded children = ${expandedCount}`);
  if (panel.children[1] !== body) throw new Error("restored body must be the same node");
});

Deno.test("collapsePanel and expandPanel are idempotent and ignore bad indices", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  collapsePanel(panels, 0);
  collapsePanel(panels, 0);
  const afterCollapse = panel.children.length;
  if (afterCollapse !== 1) throw new Error(`double collapse must be a no-op (${afterCollapse})`);
  expandPanel(panels, 0);
  expandPanel(panels, 0);
  const afterExpand = panel.children.length;
  if (afterExpand !== 2) throw new Error(`double expand must be a no-op (${afterExpand})`);
  collapsePanel(panels, 99);
  const afterBad = panel.children.length;
  if (afterBad !== 2) throw new Error(`collapsing a bad index must be a no-op (${afterBad})`);
});

Deno.test("focusPanel moves the active index and restyles headers", () => {
  const panels = Panels({
    panels: [{ header: "A", body: Text({ text: "1" }) }, { header: "B", body: Text({ text: "2" }) }],
  });
  const initialActive = panels.props.active;
  if (initialActive !== 0) throw new Error(`initial active = ${initialActive}`);
  focusPanel(panels, 1);
  const newActive = panels.props.active;
  if (newActive !== 1) throw new Error(`active after focus = ${newActive}`);
  if (panels.children[1]?.children[0]?.props.bold !== true) {
    throw new Error("new active header must be bold");
  }
  if (panels.children[0]?.children[0]?.props.bold !== false) {
    throw new Error("old active header must be un-bolded");
  }
});

// ---------------------------------------------------------------------------
// Panel drag-resize
//
// The drag helpers locate the 1-cell gutter between adjacent panels from the
// laid-out extents (`Node.contentSize()` over the fake addon, keyed per
// handle in `fakeContentSizes`) and map `down_left` -> `drag_left` -> `up_left`
// to absolute `flex_basis` changes on the pane above/left of the gutter,
// clamped to the pane's min size (and the neighbor's min as the upper bound).
// ---------------------------------------------------------------------------

/** Build a mouse event payload. */
function mouse(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

/**
 * Build a 3-panel column stack attached under a fake-addon renderer root and
 * record laid-out sizes: the stack is 9 rows tall (panel A rows 0-2, gutter
 * row 3, panel B rows 4-5, gutter row 6, panel C rows 7-8). Panels are 60
 * cells wide.
 */
function attachedPanels(): { renderer: ReturnType<typeof createRenderer>; panels: Node } {
  const renderer = createRenderer();
  const panels = Panels({
    panels: [
      { header: "A", body: Box() },
      { header: "B", body: Box() },
      { header: "C", body: Box() },
    ],
    direction: "column",
  });
  renderer.root.addChild(panels);
  fakeContentSizes.set(panels.handle, { width: 60, height: 9 });
  fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
  fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
  fakeContentSizes.set(panels.children[2]!.handle, { width: 60, height: 2 });
  return { renderer, panels };
}

Deno.test("Panels defaults to a 1-cell gutter gap (an explicit gap wins)", () => {
  const a = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }] });
  if (a.props.gap !== 1) throw new Error(`default gap = ${a.props.gap}`);
  const b = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }], gap: 0 });
  if (b.props.gap !== 0) throw new Error(`explicit gap = ${b.props.gap}`);
});

Deno.test("startPanelDrag grabs a gutter on down_left and dragPanels mutates the adjacent pane's flex_basis", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();

    // Press on gutter 0 (row 3): between panel A (rows 0-2) and panel B.
    const started = startPanelDrag(panels, mouse("down_left", 0, 3));
    if (started === null || started.index !== 0 || started.direction !== "column") {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }

    // Drag down 1 cell: panel A's flex_basis grows 3 -> 4.
    const r1 = dragPanels(panels, mouse("drag_left", 0, 4));
    if (r1 === null || r1.flex_basis !== 4 || r1.index !== 0) {
      throw new Error(`drag 1 = ${JSON.stringify(r1)}`);
    }
    if (panels.children[0]!.props.flex_basis !== 4) {
      throw new Error(`flex_basis after drag = ${panels.children[0]!.props.flex_basis}`);
    }

    // Drag down 2 more: 4 -> 6.
    const r2 = dragPanels(panels, mouse("drag_left", 0, 6));
    if (r2 === null || r2.flex_basis !== 6) throw new Error(`drag 2 = ${JSON.stringify(r2)}`);

    // A drag on a gutter further down targets its own pane (gutter 1 -> pane B).
    const r3 = dragPanels(panels, mouse("drag_left", 0, 7));
    if (r3 === null || r3.index !== 0) {
      throw new Error(`drag 3 must stay on pane 0: ${JSON.stringify(r3)}`);
    }

    // up_left ends the drag; a later drag_left is inert.
    const ended = endPanelDrag(panels);
    if (ended === null || ended.index !== 0) throw new Error(`ended = ${JSON.stringify(ended)}`);
    if (dragPanels(panels, mouse("drag_left", 0, 8)) !== null) {
      throw new Error("a drag after up_left must be a no-op");
    }
  });
});

Deno.test("dragPanels clamps the pane's flex_basis to its min size", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    // Drag far above the split: 3 - 20 = -17 -> clamps to the default min (1).
    const r = dragPanels(panels, mouse("drag_left", 0, -17));
    if (r === null || r.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`clamped basis = ${JSON.stringify(r)}`);
    }
    if (panels.children[0]!.props.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
  });
});

Deno.test("dragPanels clamps to the space the neighbor pane's min size leaves", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // The stack is 9 tall with a 1-cell gutter: pane A can grow to
    // 9 - 1 (gutter) - 1 (panel B's min) = 7.
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, 99));
    if (r === null || r.flex_basis !== 7) {
      throw new Error(`upper-clamped basis = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("a declared min_height prop raises the pane's drag floor", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box(), min_height: 4 }, { header: "B", body: Box() }],
      direction: "column",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 60, height: 7 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 4 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // Gutter 0 = row 4 (panel A rows 0-3).
    if (startPanelDrag(panels, mouse("down_left", 0, 4)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, -50));
    if (r === null || r.flex_basis !== 4) {
      throw new Error(`min_height floor = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("row stacks resize by column and use min_width", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [
        { header: "A", body: Box(), min_width: 2 },
        { header: "B", body: Box() },
      ],
      direction: "row",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 7, height: 20 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 3, height: 20 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 2, height: 20 });
    // Gutter 0 = column 3 (panel A columns 0-2); the drag axis is the column.
    const started = startPanelDrag(panels, mouse("down_left", 3, 0));
    if (started === null || started.direction !== "row" || started.index !== 0) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }
    const r = dragPanels(panels, mouse("drag_left", 5, 0)); // +2 columns
    if (r === null || r.flex_basis !== 5) throw new Error(`row drag = ${JSON.stringify(r)}`);
    if (panels.children[0]!.props.flex_basis !== 5) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
    // Far left: 5 - 20 = -15 -> clamps to min_width 2.
    const clamped = dragPanels(panels, mouse("drag_left", -15, 0));
    if (clamped === null || clamped.flex_basis !== 2) {
      throw new Error(`row min_width clamp = ${JSON.stringify(clamped)}`);
    }
  });
});

Deno.test("startPanelDrag ignores presses off the gutters and on detached trees", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // Inside panel A (row 1), inside panel C (row 8), and outside the stack
    // (row 20) are not gutters.
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a press inside a panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 8)) !== null) {
      throw new Error("a press inside the last panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 20)) !== null) {
      throw new Error("a press beyond the stack must not start a drag");
    }
    // Non-down_left events never start a drag.
    if (startPanelDrag(panels, mouse("drag_left", 0, 3)) !== null) {
      throw new Error("drag_left must not start a drag");
    }
    // A detached tree has no geometry: contentSize throws, so no drag.
    const detached = Panels({ panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }] });
    if (startPanelDrag(detached, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a detached tree must not start a drag");
    }
    // endPanelDrag without an active drag is a no-op.
    if (endPanelDrag(panels) !== null) throw new Error("end without a drag must return null");
  });
});

Deno.test("the gutter accounts for an explicit gap", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
      direction: "column",
      gap: 3,
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 2 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // With gap 3 the gutter spans rows 2-4 (panel A rows 0-1).
    for (const row of [2, 3, 4]) {
      if (startPanelDrag(panels, mouse("down_left", 0, row)) === null) {
        throw new Error(`row ${row} is inside the 3-cell gutter`);
      }
      endPanelDrag(panels);
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("row 1 is inside panel A, not the gutter");
    }
  });
});

// ---------------------------------------------------------------------------
// Roadmap elements: DiffView
// ---------------------------------------------------------------------------

/**
 * A 3-hunk diff: two context runs around an add/del pair each, with line
 * numbers reaching two digits (so the gutter columns must right-align to
 * width 2) and a multi-width (CJK) line in the third hunk.
 */
const diffHunks = [
  { kind: "ctx", old_line: 1, new_line: 1, text: "  fn main() {" },
  { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
  { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
  { kind: "ctx", old_line: 3, new_line: 3, text: "  }" },
  { kind: "ctx", old_line: 10, new_line: 11, text: "  宽度对齐测试" },
  { kind: "del", old_line: 11, new_line: 0, text: "    old line" },
  { kind: "add", old_line: 0, new_line: 12, text: "    new line" },
] as const;

Deno.test("DiffView composes a column of gutter/marker/content rows per hunk line", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${diff.props.flex_direction}`);
  }
  // The line model is JS bookkeeping, never a scene prop.
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
  const rows = diff.children;
  if (rows.length !== diffHunks.length) throw new Error(`rows = ${rows.length}`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined || row.type !== "box" || row.props.flex_direction !== "row") {
      throw new Error(`row ${i} must be a row box`);
    }
    const kids = row.children;
    if (kids.length !== 3) throw new Error(`row ${i} must have 3 text leaves`);
    const [gutter, marker, content] = kids;
    if (gutter?.type !== "text" || marker?.type !== "text" || content?.type !== "text") {
      throw new Error(`row ${i} leaves must be text`);
    }
  }
});

Deno.test("DiffView gutter right-aligns old/new line numbers and blanks absent sides", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const gutter = (i: number): string => rows[i]?.children[0]?.props.text ?? "";
  // Width-2 columns: old and new, right-aligned, joined by a space.
  if (gutter(0) !== " 1  1") throw new Error(`gutter(0) = ${JSON.stringify(gutter(0))}`);
  if (gutter(1) !== " 2   ") throw new Error(`gutter(1) = ${JSON.stringify(gutter(1))}`);
  if (gutter(2) !== "    2") throw new Error(`gutter(2) = ${JSON.stringify(gutter(2))}`);
  if (gutter(3) !== " 3  3") throw new Error(`gutter(3) = ${JSON.stringify(gutter(3))}`);
  // Two-digit numbers widen neither column beyond the widest number.
  if (gutter(4) !== "10 11") throw new Error(`gutter(4) = ${JSON.stringify(gutter(4))}`);
  if (gutter(5) !== "11   ") throw new Error(`gutter(5) = ${JSON.stringify(gutter(5))}`);
  if (gutter(6) !== "   12") throw new Error(`gutter(6) = ${JSON.stringify(gutter(6))}`);
});

Deno.test("DiffView styles markers and content per kind: add green, del red, ctx dim", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const markerText = (i: number): string => rows[i]?.children[1]?.props.text ?? "";
  const markerFg = (i: number): unknown => rows[i]?.children[1]?.props.fg;
  const contentFg = (i: number): unknown => rows[i]?.children[2]?.props.fg;
  const contentDim = (i: number): unknown => rows[i]?.children[2]?.props.dim;
  // Markers: ctx is a space, del is '-', add is '+'.
  if (markerText(0) !== " ") throw new Error(`ctx marker = ${JSON.stringify(markerText(0))}`);
  if (markerText(1) !== "-") throw new Error(`del marker = ${JSON.stringify(markerText(1))}`);
  if (markerText(2) !== "+") throw new Error(`add marker = ${JSON.stringify(markerText(2))}`);
  // Marker + content carry the kind color; ctx is dimmed, no fg.
  if (markerFg(1) !== DIFF_DEL_FG) throw new Error(`del marker fg = ${markerFg(1)}`);
  if (contentFg(1) !== DIFF_DEL_FG) throw new Error(`del content fg = ${contentFg(1)}`);
  if (markerFg(2) !== DIFF_ADD_FG) throw new Error(`add marker fg = ${markerFg(2)}`);
  if (contentFg(2) !== DIFF_ADD_FG) throw new Error(`add content fg = ${contentFg(2)}`);
  if (markerFg(0) !== undefined) throw new Error(`ctx marker must have no fg (${markerFg(0)})`);
  if (contentDim(0) !== true) throw new Error(`ctx content must be dimmed (${contentDim(0)})`);
  if (contentDim(2) !== undefined) throw new Error(`add content must not be dimmed`);
  // The content leaf carries the line text verbatim (multi-width included).
  if (rows[4]?.children[2]?.props.text !== "  宽度对齐测试") {
    throw new Error(`multi-width content = ${JSON.stringify(rows[4]?.children[2]?.props.text)}`);
  }
});

Deno.test("DiffView passes scroll_x/scroll_y to the root and wrap to the content leaves", () => {
  const diff = DiffView({ hunks: [...diffHunks], scroll_x: 4, scroll_y: 7, wrap: false });
  if (diff.props.scroll_x !== 4) throw new Error(`scroll_x = ${diff.props.scroll_x}`);
  if (diff.props.scroll_y !== 7) throw new Error(`scroll_y = ${diff.props.scroll_y}`);
  for (let i = 0; i < diff.children.length; i++) {
    if (diff.children[i]?.children[2]?.props.wrap !== false) {
      throw new Error(`row ${i} content must carry wrap=false`);
    }
  }
  // Without `wrap`, the content leaves carry no wrap prop (engine default).
  const unwrapped = DiffView({ hunks: [...diffHunks] });
  for (let i = 0; i < unwrapped.children.length; i++) {
    if ("wrap" in (unwrapped.children[i]?.children[2]?.props ?? {})) {
      throw new Error(`row ${i} content must not carry wrap when unset`);
    }
  }
});

Deno.test("DiffView with no hunks yields an empty column", () => {
  const diff = DiffView({ hunks: [] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.children.length !== 0) throw new Error(`rows = ${diff.children.length}`);
  if ("hunks" in diff.props) throw new Error("hunks must not reach the scene props");
});

/** Flatten one diff row's leaves into their text, in scene order. */
function diffRowTexts(row: Node): string[] {
  return row.children.map((leaf) => leaf.props.text as string);
}

/** The golden style snapshot of one text leaf: its text plus the keys the
 * intra-line highlighting stamps (`fg` kind color, `bold` / `underline`). */
function diffLeafStyle(leaf: Node): { text: string; fg: unknown; bold: unknown; underline: unknown } {
  return {
    text: leaf.props.text as string,
    fg: leaf.props.fg,
    bold: leaf.props.bold,
    underline: leaf.props.underline,
  };
}

Deno.test("DiffView inline_highlight splits paired add/del lines at char granularity", () => {
  const diff = DiffView({
    hunks: [
      { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
      { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
    ],
    inline_highlight: true,
  });
  const delRow = diff.children[0]!;
  const addRow = diff.children[1]!;
  // Gutter + marker are unchanged from unified mode (width-1 gutters).
  if (diffRowTexts(delRow).slice(0, 2).join("|") !== "2  |-") {
    throw new Error(`del gutter|marker = ${JSON.stringify(diffRowTexts(delRow).slice(0, 2))}`);
  }
  if (diffRowTexts(addRow).slice(0, 2).join("|") !== "  2|+") {
    throw new Error(`add gutter|marker = ${JSON.stringify(diffRowTexts(addRow).slice(0, 2))}`);
  }
  // The paired content splits into per-segment leaves inside a row box.
  const delContent = delRow.children[2]!;
  const addContent = addRow.children[2]!;
  if (delContent.type !== "box" || delContent.props.flex_direction !== "row") {
    throw new Error("split del content must be a row box");
  }
  if (addContent.type !== "box" || addContent.props.flex_direction !== "row") {
    throw new Error("split add content must be a row box");
  }
  const expect = (
    content: Node,
    golden: Array<{ text: string; fg: string; bold?: boolean }>,
  ): void => {
    const segs = content.children;
    if (segs.length !== golden.length) {
      throw new Error(`segments = ${segs.length}, want ${golden.length}`);
    }
    for (let i = 0; i < golden.length; i++) {
      const got = diffLeafStyle(segs[i]!);
      const want = golden[i]!;
      if (got.text !== want.text || got.fg !== want.fg || got.bold !== want.bold) {
        throw new Error(`segment ${i} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
      // Changed chars are additionally underlined; plain chars are not.
      if (want.bold && got.underline !== true) {
        throw new Error(`changed segment ${i} must be underlined`);
      }
      if (!want.bold && got.underline !== undefined) {
        throw new Error(`plain segment ${i} must not be underlined`);
      }
    }
  };
  // Golden buffer: unchanged chars keep the kind color plain; the changed
  // digit renders bold + underlined on top of it.
  expect(delContent, [
    { text: "    let x = ", fg: DIFF_DEL_FG },
    { text: "1", fg: DIFF_DEL_FG, bold: true },
    { text: ";", fg: DIFF_DEL_FG },
  ]);
  expect(addContent, [
    { text: "    let x = ", fg: DIFF_ADD_FG },
    { text: "2", fg: DIFF_ADD_FG, bold: true },
    { text: ";", fg: DIFF_ADD_FG },
  ]);
  // The segments always re-join the original line text exactly.
  const join = (content: Node): string =>
    content.children.map((seg) => seg.props.text as string).join("");
  if (join(delContent) !== "    let x = 1;") {
    throw new Error(`del text = ${JSON.stringify(join(delContent))}`);
  }
  if (join(addContent) !== "    let x = 2;") {
    throw new Error(`add text = ${JSON.stringify(join(addContent))}`);
  }
});

Deno.test("DiffView inline_highlight keeps unpaired lines plain and whole-line changes uniform", () => {
  const diff = DiffView({
    hunks: [
      { kind: "del", old_line: 1, new_line: 0, text: "foo" }, // no adjacent add
      { kind: "ctx", old_line: 2, new_line: 1, text: "same" },
      { kind: "del", old_line: 3, new_line: 0, text: "aaa" },
      { kind: "add", old_line: 0, new_line: 2, text: "bbb" }, // whole-line change
    ],
    inline_highlight: true,
  });
  // A deleted line with no adjacent add stays a single plain text leaf.
  const lone = diff.children[0]!;
  const loneContent = lone.children[2]!;
  if (loneContent.type !== "text" || loneContent.props.text !== "foo") {
    throw new Error(`unpaired del content = ${JSON.stringify(diffLeafStyle(loneContent))}`);
  }
  if (loneContent.props.bold !== undefined) {
    throw new Error("unpaired del must not be highlighted");
  }
  // A pair with no common chars is one all-changed segment per side — still a
  // single leaf, but bold + underlined (the whole line changed).
  const delAll = diff.children[2]!;
  const addAll = diff.children[3]!;
  for (const [row, text] of [[delAll, "aaa"], [addAll, "bbb"]] as const) {
    const content = row.children[2]!;
    if (content.type !== "text" || content.props.text !== text) {
      throw new Error(`all-changed content = ${JSON.stringify(diffLeafStyle(content))}`);
    }
    if (content.props.bold !== true || content.props.underline !== true) {
      throw new Error("all-changed content must be bold + underlined");
    }
  }
});

Deno.test("DiffView mode=side composes two aligned columns with per-column gutters", () => {
  const diff = DiffView({ hunks: [...diffHunks], mode: "side" });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.props.flex_direction !== "row") {
    throw new Error(`flex_direction = ${diff.props.flex_direction}`);
  }
  if (diff.props.gap !== 1) throw new Error(`gap = ${diff.props.gap}`);
  if ("hunks" in diff.props || "mode" in diff.props || "inline_highlight" in diff.props) {
    throw new Error("hunks/mode/inline_highlight must not reach the scene props");
  }
  const oldCol = diff.children[0]!;
  const newCol = diff.children[1]!;
  if (oldCol.type !== "box" || oldCol.props.flex_direction !== "column") {
    throw new Error("the old side must be a column box");
  }
  if (newCol.type !== "box" || newCol.props.flex_direction !== "column") {
    throw new Error("the new side must be a column box");
  }
  // Aligned by line pair: one row per hunk line in both columns.
  if (oldCol.children.length !== diffHunks.length || newCol.children.length !== diffHunks.length) {
    throw new Error("columns must carry one row per hunk line");
  }
  const row = (col: Node, i: number): string => diffRowTexts(col.children[i]!).join("|");
  // Old column: deletions + context, additions blank; its gutter right-aligns
  // on the old line numbers (width 2: 1, 2, 3, 10, 11).
  if (row(oldCol, 0) !== " 1| |  fn main() {") throw new Error(`old[0] = ${JSON.stringify(row(oldCol, 0))}`);
  if (row(oldCol, 1) !== " 2|-|    let x = 1;") throw new Error(`old[1] = ${JSON.stringify(row(oldCol, 1))}`);
  if (row(oldCol, 2) !== "  | |") throw new Error(`old[2] = ${JSON.stringify(row(oldCol, 2))}`);
  if (row(oldCol, 3) !== " 3| |  }") throw new Error(`old[3] = ${JSON.stringify(row(oldCol, 3))}`);
  if (row(oldCol, 4) !== "10| |  宽度对齐测试") throw new Error(`old[4] = ${JSON.stringify(row(oldCol, 4))}`);
  if (row(oldCol, 5) !== "11|-|    old line") throw new Error(`old[5] = ${JSON.stringify(row(oldCol, 5))}`);
  if (row(oldCol, 6) !== "  | |") throw new Error(`old[6] = ${JSON.stringify(row(oldCol, 6))}`);
  // New column: additions + context, deletions blank; its gutter right-aligns
  // on the new line numbers (width 2: 1, 2, 3, 11, 12).
  if (row(newCol, 0) !== " 1| |  fn main() {") throw new Error(`new[0] = ${JSON.stringify(row(newCol, 0))}`);
  if (row(newCol, 1) !== "  | |") throw new Error(`new[1] = ${JSON.stringify(row(newCol, 1))}`);
  if (row(newCol, 2) !== " 2|+|    let x = 2;") throw new Error(`new[2] = ${JSON.stringify(row(newCol, 2))}`);
  if (row(newCol, 3) !== " 3| |  }") throw new Error(`new[3] = ${JSON.stringify(row(newCol, 3))}`);
  if (row(newCol, 4) !== "11| |  宽度对齐测试") throw new Error(`new[4] = ${JSON.stringify(row(newCol, 4))}`);
  if (row(newCol, 5) !== "  | |") throw new Error(`new[5] = ${JSON.stringify(row(newCol, 5))}`);
  if (row(newCol, 6) !== "12|+|    new line") throw new Error(`new[6] = ${JSON.stringify(row(newCol, 6))}`);
});

Deno.test("DiffView mode=side aligned pairs fit a wide viewport without overflow", () => {
  const diff = DiffView({ hunks: [...diffHunks], mode: "side" });
  const oldCol = diff.children[0]!;
  const newCol = diff.children[1]!;
  // Display width of one column cell's composed text (CJK chars measure 2
  // cells, matching the engine's multi-width handling).
  const cellWidth = (cell: Node): number => {
    let w = 0;
    for (const leaf of cell.children) {
      for (const ch of leaf.props.text as string) w += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
    }
    return w;
  };
  // Each aligned line pair spans both columns plus the 1-cell split gap.
  const pairs = oldCol.children.map((cell, i) =>
    cellWidth(cell) + 1 + cellWidth(newCol.children[i]!)
  );
  const widest = Math.max(...pairs);
  // A 40-cell viewport comfortably holds every aligned pair — nothing would
  // overflow the clip region's right edge. The widest pair is the CJK
  // context line: 17 + 1 + 17 = 35 cells.
  if (widest > 40) throw new Error(`widest aligned pair = ${widest} cells (viewport 40)`);
  if (widest !== 35) throw new Error(`widest aligned pair = ${widest}, want 35`);
});


// ---------------------------------------------------------------------------
// Roadmap elements: Select
// ---------------------------------------------------------------------------

const selectOptions: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

const keyBase = { ctrl: false, alt: false, shift: false } as const;

Deno.test("Select composes a filter row and option rows (highlighted first)", () => {
  const select = Select({ options: selectOptions });
  if (select.type !== "select") throw new Error(`type = ${select.type}`);
  if (select.props.multi !== false) throw new Error(`multi = ${select.props.multi}`);
  if (select.props.value !== "") throw new Error(`value = ${select.props.value}`);
  if (select.props.highlighted !== 0) throw new Error(`highlighted = ${select.props.highlighted}`);
  if ("options" in select.props) throw new Error("options must not reach the scene props");
  // Filter row + 3 option rows (no summary in single mode).
  if (select.children.length !== 4) throw new Error(`children = ${select.children.length}`);
  const filterRow = select.children[0];
  if (filterRow === undefined || filterRow.type !== "text") {
    throw new Error("filter row must be a text leaf");
  }
  if (filterRow.props.text !== SELECT_FILTER_PLACEHOLDER) {
    throw new Error(`filter = ${filterRow.props.text}`);
  }
  if (filterRow.props.dim !== true) throw new Error(`filter dim = ${filterRow.props.dim}`);
  const labels = select.children.slice(1).map((child) => child.props.text).join(",");
  if (labels !== "Apple,Banana,Cherry") throw new Error(`rows = ${labels}`);
  // The first option starts highlighted (reversed).
  if (select.children[1]?.props.reversed !== true) {
    throw new Error("first option must be highlighted");
  }
  if (select.children[2]?.props.reversed === true) {
    throw new Error("only the highlighted option may be reversed");
  }
});

Deno.test("Select multi mode shows checkmarks and a selected-count summary", () => {
  const select = Select({
    options: [
      { value: "a", label: "A", selected: true },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
    multi: true,
  });
  // Filter + 3 option rows + summary.
  if (select.children.length !== 5) throw new Error(`children = ${select.children.length}`);
  const rows = select.children.slice(1, 4).map((child) => child.props.text);
  if (rows[0] !== "✓ A") throw new Error(`row 0 = ${rows[0]}`);
  if (rows[1] !== "  B") throw new Error(`row 1 = ${rows[1]}`);
  const summary = select.children[4];
  if (summary === undefined || summary.props.text !== "1 selected") {
    throw new Error(`summary = ${summary?.props.text}`);
  }
  // The initial selection comes from the `selected`-flagged options.
  if (JSON.stringify(select.props.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(select.props.value)}`);
  }
});

Deno.test("selectKey moves the highlight with up/down and clamps at the ends", () => {
  const select = Select({ options: selectOptions });
  const down = selectKey(select, { name: "down", ...keyBase });
  if (down.highlighted !== 1) throw new Error(`down = ${down.highlighted}`);
  const up = selectKey(select, { name: "up", ...keyBase });
  if (up.highlighted !== 0) throw new Error(`up = ${up.highlighted}`);
  // Clamp at the top.
  const upClamped = selectKey(Select({ options: selectOptions }), { name: "up", ...keyBase });
  if (upClamped.highlighted !== 0) throw new Error(`up clamp = ${upClamped.highlighted}`);
  // Clamp at the bottom.
  selectKey(select, { name: "down", ...keyBase });
  selectKey(select, { name: "down", ...keyBase });
  const bottom = selectKey(select, { name: "down", ...keyBase });
  if (bottom.highlighted !== 2) throw new Error(`down clamp = ${bottom.highlighted}`);
  // The composition reflects the moved highlight.
  if (select.children[3]?.props.reversed !== true) {
    throw new Error("highlighted row must be reversed");
  }
  // Unknown keys leave the state unchanged.
  const tab = selectKey(select, { name: "tab", ...keyBase });
  if (tab.highlighted !== 2) throw new Error(`tab must not move = ${tab.highlighted}`);
});

Deno.test("selectKey typeahead filter narrows the visible options", () => {
  const select = Select({ options: selectOptions });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const visibleText = () => select.children[1]?.props.text;
  const childCount = () => select.children.length;
  const b = selectKey(select, { name: "char", char: "b", ...keyBase });
  if (b.filter !== "b") throw new Error(`filter = ${b.filter}`);
  if (b.highlighted !== 0) throw new Error(`highlight resets to first match = ${b.highlighted}`);
  // The composition narrows to the prefix matches (filter row + 1 row).
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
  if (visibleText() !== "Banana") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // Case-insensitive prefix match.
  selectKey(select, { name: "backspace", ...keyBase });
  const cap = selectKey(select, { name: "char", char: "C", ...keyBase });
  if (cap.filter !== "C") throw new Error(`filter = ${cap.filter}`);
  if (visibleText() !== "Cherry") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // A non-matching char empties the list down to the filter row.
  const z = selectKey(select, { name: "char", char: "z", ...keyBase });
  if (z.filter !== "Cz") throw new Error(`filter = ${z.filter}`);
  if (childCount() !== 1) throw new Error(`children = ${childCount()}`);
  // Backspace restores the full list.
  const back = selectKey(select, { name: "backspace", ...keyBase });
  if (back.filter !== "C") throw new Error(`filter = ${back.filter}`);
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
});

Deno.test("visibleOptions reflects the filter and is label-normalized", () => {
  const select = Select({ options: selectOptions });
  const all = visibleOptions(select);
  if (all.length !== 3) throw new Error(`all = ${all.length}`);
  if (all[0]?.label !== "Apple") throw new Error(`label = ${all[0]?.label}`);
  selectKey(select, { name: "char", char: "b", ...keyBase });
  const visible = visibleOptions(select);
  if (visible.length !== 1 || visible[0]?.value !== "banana" || visible[0]?.label !== "Banana") {
    throw new Error(`visible = ${JSON.stringify(visible)}`);
  }
});

Deno.test("selectKey enter confirms the highlighted option and dismisses", () => {
  const select = Select({ options: selectOptions });
  selectKey(select, { name: "down", ...keyBase });
  const next = selectKey(select, { name: "enter", ...keyBase });
  if (next.value !== "banana") throw new Error(`value = ${next.value}`);
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.value !== "banana") throw new Error(`node value = ${select.props.value}`);
  if (select.props.open !== false) throw new Error(`node open = ${select.props.open}`);
  // Enter confirms the filtered highlight too (typeahead + enter).
  const filtered = Select({ options: selectOptions });
  selectKey(filtered, { name: "char", char: "c", ...keyBase });
  const confirmed = selectKey(filtered, { name: "enter", ...keyBase });
  if (confirmed.value !== "cherry") throw new Error(`filtered confirm = ${confirmed.value}`);
});

Deno.test("selectKey escape dismisses the dropdown", () => {
  const select = Select({ options: selectOptions });
  const next = selectKey(select, { name: "escape", ...keyBase });
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.open !== false) throw new Error(`node open = ${select.props.open}`);
  // Enter/escape on an empty list is a no-op (nothing to confirm/dismiss).
  const empty = Select({ options: [] });
  const dismissed = selectKey(empty, { name: "escape", ...keyBase });
  if (dismissed.open !== false) throw new Error(`empty open = ${dismissed.open}`);
});

Deno.test("selectKey space toggles a checkmark in multi mode and updates the count", () => {
  const select = Select({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    multi: true,
  });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const rowText = () => select.children[1]?.props.text;
  const summaryText = () => select.children[3]?.props.text;
  // Space on the highlighted (first) option checks it.
  const toggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(toggled.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(toggled.value)}`);
  }
  if (rowText() !== "✓ A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "1 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
  // Space again unchecks it.
  const untoggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(untoggled.value) !== JSON.stringify([])) {
    throw new Error(`value = ${JSON.stringify(untoggled.value)}`);
  }
  if (rowText() !== "  A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "0 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
});

Deno.test("Select floating mode sets a z_index prop", () => {
  // Floating defaults the overlay to z-index 0.
  const floating = Select({ options: selectOptions, floating: true });
  if (floating.props.z_index !== 0) throw new Error(`z_index = ${floating.props.z_index}`);
  if ("floating" in floating.props) throw new Error("floating must not reach the scene props");
  // An explicit z_index is honored.
  const layered = Select({ options: selectOptions, floating: true, z_index: 5 });
  if (layered.props.z_index !== 5) throw new Error(`z_index = ${layered.props.z_index}`);
  // Docked selects carry no z_index prop at all.
  const docked = Select({ options: selectOptions });
  if (docked.props.z_index !== undefined) throw new Error(`docked z_index = ${docked.props.z_index}`);
});

// ---------------------------------------------------------------------------
// Roadmap elements: Table
// ---------------------------------------------------------------------------

const tableColumns: TableColumn[] = [
  { key: "name", header: "Name", width: 10 },
  { key: "role", header: "Role", width: 8 },
  { key: "score", header: "Score", width: 5, align: "right" },
];

const tableRows: (string | number)[][] = [
  ["Ada", "dev", 92],
  ["Grace", "dev", 88],
  ["Linus", "maintainer", 95],
  ["Alan", "researcher", 84],
  ["Margaret", "flight", 91],
  ["Dennis", "systems", 87],
  ["Ken", "systems", 90],
  ["Barbara", "ui", 86],
  ["Edsger", "algorithms", 89],
  ["Donald", "typesetting", 93],
];

const tableKeyBase = { ctrl: false, alt: false, shift: false } as const;

Deno.test("Table composes a sticky header row above a content region of per-column rows", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  if (table.type !== "table") throw new Error(`type = ${table.type}`);
  if (table.props.flex_direction !== "column") throw new Error(`flex_direction = ${table.props.flex_direction}`);
  if (table.props.highlight !== 0) throw new Error(`highlight = ${table.props.highlight}`);
  if (table.props.sticky_header !== true) throw new Error(`sticky_header = ${table.props.sticky_header}`);
  // The model is JS bookkeeping, never scene props.
  if ("columns" in table.props || "rows" in table.props) {
    throw new Error("columns/rows must not reach the scene props");
  }
  // Sticky structure: header row (child 0) + content region (child 1).
  if (table.children.length !== 2) throw new Error(`children = ${table.children.length}`);
  const header = table.children[0];
  if (header === undefined || header.type !== "box" || header.props.flex_direction !== "row") {
    throw new Error("header must be a row box");
  }
  if (header.props.z_index !== 1) throw new Error(`header z_index = ${header.props.z_index}`);
  if (header.children.length !== tableColumns.length) throw new Error(`header cells = ${header.children.length}`);
  const region = table.children[1];
  if (region === undefined || region.type !== "box" || region.props.flex_direction !== "column") {
    throw new Error("content region must be a column box");
  }
  if (region.children.length !== tableRows.length) throw new Error(`rows = ${region.children.length}`);
  for (let i = 0; i < region.children.length; i++) {
    const row = region.children[i];
    if (row === undefined || row.type !== "box" || row.props.flex_direction !== "row") {
      throw new Error(`row ${i} must be a row box`);
    }
    if (row.children.length !== tableColumns.length) throw new Error(`row ${i} cells = ${row.children.length}`);
  }
});

Deno.test("Table cells align per column (left/right/center) and truncate wide content", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  const row0 = table.children[1]?.children[0];
  // Name: left-aligned to width 10 (padded with trailing spaces).
  if (row0?.children[0]?.props.text !== "Ada".padEnd(10)) {
    throw new Error(`name cell = ${JSON.stringify(row0?.children[0]?.props.text)}`);
  }
  // Score: right-aligned to width 5 (padded with leading spaces).
  if (row0?.children[2]?.props.text !== "92".padStart(5)) {
    throw new Error(`score cell = ${JSON.stringify(row0?.children[2]?.props.text)}`);
  }
  // Each cell pins its column width so every column lines up.
  if (row0?.children[0]?.props.width !== 10 || row0?.children[2]?.props.width !== 5) {
    throw new Error(`cell widths = ${JSON.stringify(row0?.children.map((c) => c.props.width))}`);
  }
  // Center alignment splits the padding evenly.
  const centered = Table({
    columns: [{ key: "c", header: "C", width: 7, align: "center" }],
    rows: [["x"]],
  });
  if (centered.children[1]?.children[0]?.children[0]?.props.text !== "   x   ") {
    throw new Error(`center cell = ${JSON.stringify(centered.children[1]?.children[0]?.children[0]?.props.text)}`);
  }
  // Content wider than the column is truncated to the width, never mid-glyph
  // ("宽度对齐测试" is 6 wide chars -> display width 12 -> 4 kept = 2 chars).
  const wide = Table({
    columns: [{ key: "n", header: "N", width: 4 }],
    rows: [["宽度对齐测试"]],
  });
  if (wide.children[1]?.children[0]?.children[0]?.props.text !== "宽度") {
    throw new Error(`truncated cell = ${JSON.stringify(wide.children[1]?.children[0]?.children[0]?.props.text)}`);
  }
});

Deno.test("Table routes scroll_x to the root and scroll_y/clip_height to the content region", () => {
  const table = Table({ columns: tableColumns, rows: tableRows, scroll_x: 4, scroll_y: 3, clip_height: 5 });
  // scroll_x pans header + rows together, so it stays on the root.
  if (table.props.scroll_x !== 4) throw new Error(`scroll_x = ${table.props.scroll_x}`);
  // scroll_y is the content region's state — the root never carries it (it
  // would pan the sticky header with the rows).
  if ("scroll_y" in table.props) throw new Error("scroll_y must not reach the root props");
  const region = table.children[1];
  if (region?.props.scroll_y !== 3) throw new Error(`region scroll_y = ${region?.props.scroll_y}`);
  if (region?.props.clip_height !== 5) throw new Error(`region clip_height = ${region?.props.clip_height}`);
});

Deno.test("visibleTableRows returns the viewport window under scroll and clip_height", () => {
  const table = Table({ columns: tableColumns, rows: tableRows, scroll_y: 2, clip_height: 3 });
  const visible = visibleTableRows(table);
  if (visible.length !== 3) throw new Error(`visible = ${visible.length}`);
  if (visible[0]?.[0] !== "Linus" || visible[2]?.[0] !== "Margaret") {
    throw new Error(`visible = ${JSON.stringify(visible.map((r) => r[0]))}`);
  }
  // Without clip_height the whole remaining list is the window.
  const all = Table({ columns: tableColumns, rows: tableRows });
  if (visibleTableRows(all).length !== tableRows.length) {
    throw new Error(`window = ${visibleTableRows(all).length}`);
  }
});

Deno.test("tableKey moves the highlight with up/down and clamps at the ends", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  const down = tableKey(table, { name: "down", ...tableKeyBase });
  if (down.highlight !== 1) throw new Error(`down = ${down.highlight}`);
  const up = tableKey(table, { name: "up", ...tableKeyBase });
  if (up.highlight !== 0) throw new Error(`up = ${up.highlight}`);
  // Clamp at the top.
  const upClamped = tableKey(Table({ columns: tableColumns, rows: tableRows }), { name: "up", ...tableKeyBase });
  if (upClamped.highlight !== 0) throw new Error(`up clamp = ${upClamped.highlight}`);
  // Clamp at the bottom (a few extra downs past the last row).
  const bottom = Table({ columns: tableColumns, rows: tableRows });
  for (let i = 0; i < tableRows.length + 2; i++) tableKey(bottom, { name: "down", ...tableKeyBase });
  const clamped = tableKey(bottom, { name: "down", ...tableKeyBase });
  if (clamped.highlight !== tableRows.length - 1) {
    throw new Error(`down clamp = ${clamped.highlight}`);
  }
  // The composition reflects the moved highlight: the highlighted row's
  // cells are reversed, and only its.
  const moved = Table({ columns: tableColumns, rows: tableRows });
  tableKey(moved, { name: "down", ...tableKeyBase });
  tableKey(moved, { name: "down", ...tableKeyBase });
  const row2 = moved.children[1]?.children[2];
  if (row2?.children.every((cell) => cell.props.reversed === true) !== true) {
    throw new Error("the highlighted row must be reversed");
  }
  if (moved.children[1]?.children[0]?.children.some((cell) => cell.props.reversed === true)) {
    throw new Error("only the highlighted row may be reversed");
  }
  // Unknown keys leave the state unchanged.
  const tab = tableKey(moved, { name: "tab", ...tableKeyBase });
  if (tab.highlight !== 2) throw new Error(`tab must not move = ${tab.highlight}`);
});

Deno.test("tableKey auto-scrolls to keep the highlight visible and clamps scroll_y", () => {
  const table = Table({ columns: tableColumns, rows: tableRows, clip_height: 3 });
  // Down from 0: highlights 1, 2 fit the window [0, 2]; highlight 3 scrolls.
  tableKey(table, { name: "down", ...tableKeyBase });
  tableKey(table, { name: "down", ...tableKeyBase });
  const scrolled = tableKey(table, { name: "down", ...tableKeyBase });
  if (scrolled.highlight !== 3 || scrolled.scroll_y !== 1) {
    throw new Error(`scrolled = ${JSON.stringify(scrolled)}`);
  }
  // The scroll offset lands on the content region's props.
  if (table.children[1]?.props.scroll_y !== 1) {
    throw new Error(`region scroll_y = ${table.children[1]?.props.scroll_y}`);
  }
  // Down to the last row: scroll_y clamps at rows.length - clip_height.
  let last = scrolled;
  for (let i = 0; i < 10; i++) last = tableKey(table, { name: "down", ...tableKeyBase });
  if (last.highlight !== tableRows.length - 1) throw new Error(`highlight = ${last.highlight}`);
  if (last.scroll_y !== tableRows.length - 3) throw new Error(`scroll_y clamp = ${last.scroll_y}`);
  // Up back toward the top: scroll_y clamps at 0.
  let up = last;
  for (let i = 0; i < 10; i++) up = tableKey(table, { name: "up", ...tableKeyBase });
  if (up.highlight !== 0 || up.scroll_y !== 0) {
    throw new Error(`up back to top = ${JSON.stringify(up)}`);
  }
});

Deno.test("sticky_header: false moves the header into the scrollable content region", () => {
  const table = Table({ columns: tableColumns, rows: tableRows, sticky_header: false });
  if (table.props.sticky_header !== false) throw new Error(`sticky_header = ${table.props.sticky_header}`);
  // Single child: the content region, whose first child is the header row
  // (it scrolls away with the rows, so no sticky z_index).
  if (table.children.length !== 1) throw new Error(`children = ${table.children.length}`);
  const region = table.children[0];
  if (region === undefined || region.type !== "box" || region.props.flex_direction !== "column") {
    throw new Error("content region must be a column box");
  }
  const header = region.children[0];
  if (header === undefined || header.props.flex_direction !== "row" || header.children.length !== tableColumns.length) {
    throw new Error("the header must be the region's first child");
  }
  if (header.props.z_index !== undefined) throw new Error(`header z_index = ${header.props.z_index}`);
  if (region.children.length !== tableRows.length + 1) {
    throw new Error(`region children = ${region.children.length}`);
  }
});

Deno.test("a 10k-row table materializes a bounded row window and still clamps and highlights", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 10000; i++) rows.push([`row-${i}`, i]);
    const table = Table({
      columns: [
        { key: "name", header: "Name", width: 10 },
        { key: "n", header: "N", width: 4, align: "right" },
      ],
      rows,
      clip_height: 12,
    });

    // The window is bounded near the clip height — not one node per row.
    let region = table.children[1]!;
    if (region.children.length !== 12) throw new Error(`window = ${region.children.length}`);
    if (region.props.scroll_y !== 0) throw new Error(`region scroll_y = ${region.props.scroll_y}`);

    // visibleTableRows reports the full dataset window at the offset.
    let visible = visibleTableRows(table);
    if (visible.length !== 12) throw new Error(`visible = ${visible.length}`);
    if (visible[0]?.[0] !== "row-0" || visible[11]?.[0] !== "row-11") {
      throw new Error(`visible = ${JSON.stringify(visible.map((r) => r[0]).slice(0, 3))}`);
    }

    // tableKey navigates the dataset: the highlight moves and the window
    // follows (auto-scroll), never materializing beyond the clip height.
    let state: TableState = { highlight: 0, scroll_x: 0, scroll_y: 0 };
    for (let i = 0; i < 30; i++) state = tableKey(table, { name: "down", ...tableKeyBase });
    if (state.highlight !== 30 || state.scroll_y !== 30 - 12 + 1) {
      throw new Error(`mid-nav = ${JSON.stringify(state)}`);
    }
    const midWindow = visibleTableRows(table);
    if (midWindow[0]?.[0] !== "row-19") {
      throw new Error(`mid window = ${midWindow[0]?.[0]}`);
    }
    // All the way down: the highlight clamps at the dataset end and the
    // scroll clamps against the full virtual height (10000 - 12).
    for (let i = 0; i < 10000 - 30 + 2; i++) state = tableKey(table, { name: "down", ...tableKeyBase });
    if (state.highlight !== 9999) throw new Error(`highlight = ${state.highlight}`);
    if (state.scroll_y !== 10000 - 12) throw new Error(`scroll_y clamp = ${state.scroll_y}`);
    region = table.children[1]!;
    if (region.children.length !== 12) throw new Error(`bottom window = ${region.children.length}`);
    visible = visibleTableRows(table);
    if (visible.length !== 12 || visible[0]?.[0] !== "row-9988" || visible[11]?.[0] !== "row-9999") {
      throw new Error(`tail = ${JSON.stringify(visible.map((r) => r[0]).slice(0, 3))}`);
    }
    // The highlighted row — the last materialized row — is reversed, and
    // only it.
    if (region.children[11]?.children.every((cell) => cell.props.reversed === true) !== true) {
      throw new Error("the last windowed row must be the reversed highlight");
    }
    if (region.children[0]?.children.some((cell) => cell.props.reversed === true)) {
      throw new Error("only the highlighted row may be reversed");
    }

    // Attach for the scene-geometry paths (scrollTo / wheelScroll).
    renderer.root.addChild(table);

    // The scroll clamp measures the JS-known full height even though the
    // scene content is only the window: a scroll far past the dataset end
    // pins at rows.length - clip_height.
    scrollTo(table.children[1]!, 0, 1e9);
    const y = (): number => table.children[1]!.props.scroll_y as number;
    if (y() !== 10000 - 12) throw new Error(`scrollTo clamp = ${y()}`);

    // wheelScroll refreshes the window and clamps against the full height: at
    // the bottom a down-wheel is consumed but pinned; an up-wheel pans back
    // into the dataset and re-windows.
    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel at the table's bound must stay consumed");
    }
    if (y() !== 9988) throw new Error(`wheel clamp = ${y()}`);
    if (wheelScroll(table, mouse("scroll_up", 0, 0)) !== true) {
      throw new Error("a wheel up on the table must be consumed");
    }
    if (y() !== 9987) throw new Error(`wheel up = ${y()}`);
    visible = visibleTableRows(table);
    if (visible[0]?.[0] !== "row-9987") {
      throw new Error(`window after wheel = ${visible[0]?.[0]}`);
    }
    if (table.props.scroll_y !== undefined) {
      throw new Error("the table root must not scroll (the sticky header stays pinned)");
    }
  });
});

// ---------------------------------------------------------------------------
// Tabs: composition, active-tab styling, activateTab / closeTab / tabsKey
// ---------------------------------------------------------------------------

/** A small tabs fixture: three tabs with distinct content nodes. */
function tabsFixture(): { tabs: Node; specs: TabSpec[]; activeOf: () => number } {
  const specs: TabSpec[] = [
    { label: "logs", content: [Text({ text: "log line" })] },
    { label: "files", content: [Text({ text: "file list" })] },
    { label: "git", content: [Text({ text: "git status" })] },
  ];
  const tabs = Tabs({ tabs: specs });
  const activeOf = (): number => tabs.props.active as number;
  return { tabs, specs, activeOf };
}

Deno.test("Tabs composes a tab bar row and a content region holding the active tab's content", () => {
  const { tabs } = tabsFixture();
  if (tabs.type !== "tabs") throw new Error(`type = ${tabs.type}`);
  if (tabs.props.flex_direction !== "column") throw new Error(`flex_direction = ${tabs.props.flex_direction}`);
  if (tabs.props.active !== 0) throw new Error(`active = ${tabs.props.active}`);
  // The tab list is JS bookkeeping, never scene props.
  if ("tabs" in tabs.props || "closable" in tabs.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(tabs.props)}`);
  }
  // Composition: the tab bar row (child 0) + the content region (child 1).
  if (tabs.children.length !== 2) throw new Error(`children = ${tabs.children.length}`);
  const bar = tabs.children[0];
  if (bar === undefined || bar.type !== "box" || bar.props.flex_direction !== "row") {
    throw new Error("the tab bar must be a row box");
  }
  if (bar.children.length !== 3) throw new Error(`tab leaves = ${bar.children.length}`);
  if (bar.children.map((leaf) => leaf.props.text).join(",") !== `${TAB_ACTIVE_MARKER}logs,files,git`) {
    throw new Error(`labels = ${bar.children.map((leaf) => leaf.props.text).join(",")}`);
  }
  const region = tabs.children[1];
  if (region === undefined || region.type !== "box" || region.props.flex_direction !== "column") {
    throw new Error("the content region must be a column box");
  }
  // Only the active tab's content is materialized in the region.
  if (region.children.length !== 1 || region.children[0]?.props.text !== "log line") {
    throw new Error(`region content = ${region.children.map((n) => n.props.text).join(",")}`);
  }
  // The other tabs' content stays out of the scene tree (only the active
  // tab's content is composed).
  if (bar.children.some((leaf) => leaf.children.length !== 0)) {
    throw new Error("tab leaves must be text leaves without children");
  }
});

Deno.test("Tabs styles the active tab with the primary palette, reversed, and a top-border marker", () => {
  const { tabs } = tabsFixture();
  const bar = tabs.children[0]!;
  const activeLeaf = bar.children[0]!;
  const inactiveLeaf = bar.children[1]!;
  // The active tab's label is prefixed by the top-border marker.
  if (activeLeaf.props.text !== `${TAB_ACTIVE_MARKER}logs`) {
    throw new Error(`active text = ${JSON.stringify(activeLeaf.props.text)}`);
  }
  // The active tab carries the primary palette colors + reversed; inactive
  // tabs are plain.
  if (activeLeaf.props.reversed !== true) throw new Error("the active tab must be reversed");
  if (activeLeaf.props.fg !== TAB_PRIMARY_FG || activeLeaf.props.bg !== TAB_PRIMARY_BG) {
    throw new Error(`active colors = ${JSON.stringify(activeLeaf.props)}`);
  }
  if (inactiveLeaf.props.reversed !== undefined) throw new Error("inactive tabs must not be reversed");
  if (inactiveLeaf.props.fg !== undefined) throw new Error("inactive tabs must not carry the primary fg");
  if (inactiveLeaf.props.text !== "files") throw new Error(`inactive text = ${inactiveLeaf.props.text}`);
});

Deno.test("Tabs close affordance appends the close glyph per tab (per-tab closable wins)", () => {
  const closable = Tabs({
    tabs: [
      { label: "a", content: [] },
      { label: "b", content: [] },
    ],
    closable: true,
  });
  const bar = closable.children[0]!;
  if (bar.children[0]?.props.text !== `${TAB_ACTIVE_MARKER}a ${TAB_CLOSE_CHAR}`) {
    throw new Error(`active closable = ${JSON.stringify(bar.children[0]?.props.text)}`);
  }
  if (bar.children[1]?.props.text !== `b ${TAB_CLOSE_CHAR}`) {
    throw new Error(`inactive closable = ${JSON.stringify(bar.children[1]?.props.text)}`);
  }
  // A per-tab `closable: false` overrides the element default.
  const mixed = Tabs({
    tabs: [
      { label: "a", content: [], closable: false },
      { label: "b", content: [] },
    ],
    closable: true,
  });
  const mixedBar = mixed.children[0]!;
  if (mixedBar.children[0]?.props.text !== `${TAB_ACTIVE_MARKER}a`) {
    throw new Error(`per-tab closable: false = ${JSON.stringify(mixedBar.children[0]?.props.text)}`);
  }
  if (mixedBar.children[1]?.props.text !== `b ${TAB_CLOSE_CHAR}`) {
    throw new Error(`default closable = ${JSON.stringify(mixedBar.children[1]?.props.text)}`);
  }
});

Deno.test("activateTab switches the active tab and swaps the content region", () => {
  const { tabs, activeOf } = tabsFixture();
  activateTab(tabs, 1);
  if (activeOf() !== 1) throw new Error(`active = ${activeOf()}`);
  // Re-read the live composition: the rebuild replaced the bar and region.
  const bar = tabs.children[0]!;
  if (bar.children[1]?.props.text !== `${TAB_ACTIVE_MARKER}files`) {
    throw new Error(`active leaf = ${JSON.stringify(bar.children[1]?.props.text)}`);
  }
  if (bar.children[0]?.props.text !== "logs") throw new Error(`old active leaf = ${bar.children[0]?.props.text}`);
  const region = tabs.children[1]!;
  if (region.children.length !== 1 || region.children[0]?.props.text !== "file list") {
    throw new Error(`region content = ${region.children.map((n) => n.props.text).join(",")}`);
  }
  // Activating the same tab is a no-op (the composition is not rebuilt).
  const before = tabs.children[0]!;
  activateTab(tabs, 1);
  if (tabs.children[0] !== before) throw new Error("a no-op activate must not rebuild");
  // Out-of-range indices clamp: 99 -> last, -1 -> first.
  activateTab(tabs, 99);
  if (activeOf() !== 2) throw new Error(`clamp high = ${activeOf()}`);
  activateTab(tabs, -1);
  if (activeOf() !== 0) throw new Error(`clamp low = ${activeOf()}`);
});

Deno.test("closeTab removes the tab and re-clamps the active index", () => {
  // Closing a tab before the active one shifts the active down.
  const shift = Tabs({ tabs: tabsFixture().specs, active: 2 });
  closeTab(shift, 0);
  if (shift.props.active !== 1) throw new Error(`shift = ${shift.props.active}`);
  if (shift.children[0]?.children.map((leaf) => leaf.props.text).join(",") !== `files,${TAB_ACTIVE_MARKER}git`) {
    throw new Error(`labels after close = ${shift.children[0]?.children.map((leaf) => leaf.props.text).join(",")}`);
  }
  // Closing the active tab leaves the tab that slid into its slot.
  const active = Tabs({ tabs: tabsFixture().specs, active: 1 });
  closeTab(active, 1);
  if (active.props.active !== 1) throw new Error(`active after self-close = ${active.props.active}`);
  if (active.children[0]?.children.map((leaf) => leaf.props.text).join(",") !== `logs,${TAB_ACTIVE_MARKER}git`) {
    throw new Error(`labels = ${active.children[0]?.children.map((leaf) => leaf.props.text).join(",")}`);
  }
  // Closing the last (active) tab clamps the active to the new last.
  const last = Tabs({ tabs: tabsFixture().specs, active: 2 });
  closeTab(last, 2);
  if (last.props.active !== 1) throw new Error(`clamped active = ${last.props.active}`);
  // Closing the only tab leaves an empty bar + region at active 0.
  const only = Tabs({ tabs: [{ label: "solo", content: [Text({ text: "x" })] }] });
  closeTab(only, 0);
  if (only.props.active !== 0) throw new Error(`empty active = ${only.props.active}`);
  if (only.children[0]?.children.length !== 0) throw new Error(`empty bar = ${only.children[0]?.children.length}`);
  if (only.children[1]?.children.length !== 0) throw new Error(`empty region = ${only.children[1]?.children.length}`);
  // Bad indices are no-ops.
  const noop = Tabs({ tabs: tabsFixture().specs });
  closeTab(noop, 5);
  if (noop.children[0]?.children.length !== 3) throw new Error("a bad index must not close");
});

Deno.test("tabsKey left/right move the active tab and clamp at the ends", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const { tabs, activeOf } = tabsFixture();
  const right = tabsKey(tabs, { name: "right", ...base });
  if (right.active !== 1 || right.count !== 3) throw new Error(`right = ${JSON.stringify(right)}`);
  if (activeOf() !== 1) throw new Error(`node active = ${activeOf()}`);
  // Right at the last tab clamps.
  const atEnd = tabsKey(tabs, { name: "right", ...base });
  const clamped = tabsKey(tabs, { name: "right", ...base });
  if (atEnd.active !== 2 || clamped.active !== 2) throw new Error(`right clamp = ${clamped.active}`);
  // Left walks back and clamps at the first.
  const left = tabsKey(tabs, { name: "left", ...base });
  if (left.active !== 1) throw new Error(`left = ${left.active}`);
  const top = tabsKey(tabs, { name: "left", ...base });
  if (top.active !== 0) throw new Error(`left = ${top.active}`);
  const clampedLow = tabsKey(tabs, { name: "left", ...base });
  if (clampedLow.active !== 0) throw new Error(`left clamp = ${clampedLow.active}`);
  if (activeOf() !== 0) throw new Error(`node active = ${activeOf()}`);
});

Deno.test("tabsKey ctrl+tab / ctrl+shift+tab wrap to the next / previous tab", () => {
  const base = { alt: false } as const;
  const { tabs, activeOf } = tabsFixture();
  // ctrl+shift+tab at the first tab wraps to the last.
  const prevWrap = tabsKey(tabs, { name: "tab", ctrl: true, shift: true, ...base });
  if (prevWrap.active !== 2) throw new Error(`ctrl+shift+tab wrap = ${prevWrap.active}`);
  if (activeOf() !== 2) throw new Error(`node active = ${activeOf()}`);
  // ctrl+tab at the last tab wraps to the first.
  const nextWrap = tabsKey(tabs, { name: "tab", ctrl: true, shift: false, ...base });
  if (nextWrap.active !== 0) throw new Error(`ctrl+tab wrap = ${nextWrap.active}`);
  // Plain tab (no ctrl) leaves the tabs unchanged.
  const plainTab = tabsKey(tabs, { name: "tab", ctrl: false, shift: false, ...base });
  if (plainTab.active !== 0) throw new Error(`plain tab = ${plainTab.active}`);
});

Deno.test("tabsKey ctrl+w closes the active tab and re-clamps the active index", () => {
  const base = { alt: false, shift: false } as const;
  const { tabs, specs, activeOf } = tabsFixture();
  // Move to the middle tab, then close it with ctrl+w.
  tabsKey(tabs, { name: "right", ctrl: false, ...base });
  const closed = tabsKey(tabs, { name: "w", ctrl: true, ...base });
  if (closed.count !== 2) throw new Error(`count = ${closed.count}`);
  if (activeOf() !== 1) throw new Error(`active after close = ${activeOf()}`);
  if (tabs.children[0]?.children.map((leaf) => leaf.props.text).join(",") !== `logs,${TAB_ACTIVE_MARKER}git`) {
    throw new Error(`labels = ${tabs.children[0]?.children.map((leaf) => leaf.props.text).join(",")}`);
  }
  // ctrl+w on the last tab closes it; the active clamps to the new last.
  void specs;
  const last = Tabs({ tabs: tabsFixture().specs, active: 2 });
  const closedLast = tabsKey(last, { name: "w", ctrl: true, ...base });
  if (closedLast.count !== 2 || closedLast.active !== 1) {
    throw new Error(`last close = ${JSON.stringify(closedLast)}`);
  }
  // Unknown keys leave the tabs unchanged.
  const untouched = tabsKey(tabs, { name: "char", char: "q", ctrl: false, ...base });
  if (untouched.active !== 1 || untouched.count !== 2) {
    throw new Error(`unknown key = ${JSON.stringify(untouched)}`);
  }
});

// ---------------------------------------------------------------------------
// Tree: composition, indentation guides, expand/collapse glyphs, keyboard, windowing
// ---------------------------------------------------------------------------

/** The base modifier flags shared by every synthetic Tree key event. */
const treeKeyBase = { ctrl: false, alt: false, shift: false } as const;

/** A small fixture tree:
 *   ▶ src            (branch: index.ts, components)
 *   ▶ docs           (branch: readme.md)
 *     package.json   (leaf)
 */
function treeFixture(): TreeNode[] {
  return [
    {
      label: "src",
      children: [
        { label: "index.ts" },
        {
          label: "components",
          children: [{ label: "button.ts" }, { label: "input.ts" }],
        },
      ],
    },
    { label: "docs", children: [{ label: "readme.md" }] },
    { label: "package.json" },
  ];
}

/** The text of every materialized row leaf, in scene order. */
function treeRowTexts(tree: Node): string[] {
  return tree.children.map((leaf) => (typeof leaf.props.text === "string" ? leaf.props.text : ""));
}

Deno.test("Tree composes one collapsed leaf per top-level node with glyphs", () => {
  const tree = Tree({ nodes: treeFixture() });
  if (tree.type !== "tree") throw new Error(`type = ${tree.type}`);
  if (tree.props.flex_direction !== "column") throw new Error(`flex_direction = ${tree.props.flex_direction}`);
  if (tree.props.highlight !== 0) throw new Error(`highlight = ${tree.props.highlight}`);
  // The model / bookkeeping keys never reach the scene props.
  if ("nodes" in tree.props || "expanded" in tree.props || "indent" in tree.props) {
    throw new Error("nodes/expanded/indent must not reach the scene props");
  }
  // All collapsed: only the three top-level rows materialize.
  const rows = treeRowTexts(tree);
  if (rows.length !== 3) throw new Error(`rows = ${JSON.stringify(rows)}`);
  // Branches carry the collapsed glyph + space; the leaf carries two spaces.
  if (rows[0] !== `${TREE_COLLAPSED_GLYPH} src`) throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  if (rows[1] !== `${TREE_COLLAPSED_GLYPH} docs`) throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  if (rows[2] !== "  package.json") throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  // The highlighted (first) row is reversed; the others are not.
  if (tree.children[0]?.props.reversed !== true) throw new Error("row 0 must be reversed");
  if (tree.children[1]?.props.reversed === true) throw new Error("only the highlighted row may be reversed");
});

Deno.test("Tree indentation guides draw a vertical bar under a continuing ancestor", () => {
  // Expand `src` and its `components` child so nested rows appear.
  const tree = Tree({ nodes: treeFixture(), expanded: ["0", "0.1"] });
  const rows = treeRowTexts(tree);
  // Visible order: src, index.ts, components, button.ts, input.ts, docs, package.json.
  // `src` has a following sibling (docs), so its children draw a `│ ` guide.
  if (rows[0] !== `${TREE_EXPANDED_GLYPH} src`) throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  if (rows[1] !== `${TREE_GUIDE_VERTICAL} ` + "  index.ts") throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  if (rows[2] !== `${TREE_GUIDE_VERTICAL} ${TREE_EXPANDED_GLYPH} components`) {
    throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  }
  // Depth-2 leaves: one guide from `src` (has next sibling -> bar) + one from
  // `components` (last child of src -> gap), then the leaf glyph slot.
  if (rows[3] !== `${TREE_GUIDE_VERTICAL} ` + "    button.ts") throw new Error(`row3 = ${JSON.stringify(rows[3])}`);
  if (rows[4] !== `${TREE_GUIDE_VERTICAL} ` + "    input.ts") throw new Error(`row4 = ${JSON.stringify(rows[4])}`);
  if (rows[5] !== `${TREE_COLLAPSED_GLYPH} docs`) throw new Error(`row5 = ${JSON.stringify(rows[5])}`);
  if (rows[6] !== "  package.json") throw new Error(`row6 = ${JSON.stringify(rows[6])}`);
});

Deno.test("treeKey right/left/enter expand, collapse, and walk the tree", () => {
  const tree = Tree({ nodes: treeFixture() });
  // right on a collapsed branch expands it (src has 2 children).
  const expanded = treeKey(tree, { name: "right", ...treeKeyBase });
  if (expanded.count !== 5) throw new Error(`count after expand = ${expanded.count}`);
  if (visibleTreeRows(tree)[1]?.node.label !== "index.ts") {
    throw new Error(`first child = ${visibleTreeRows(tree)[1]?.node.label}`);
  }
  // right again on the (expanded) branch steps into the first child.
  const stepIn = treeKey(tree, { name: "right", ...treeKeyBase });
  if (stepIn.highlight !== 1) throw new Error(`step-in highlight = ${stepIn.highlight}`);
  // down to `components`, then enter expands it (2 more children).
  treeKey(tree, { name: "down", ...treeKeyBase });
  const openComponents = treeKey(tree, { name: "enter", ...treeKeyBase });
  if (openComponents.count !== 7) throw new Error(`count after enter = ${openComponents.count}`);
  // left on the expanded `components` collapses it back.
  const collapse = treeKey(tree, { name: "left", ...treeKeyBase });
  if (collapse.count !== 5) throw new Error(`count after collapse = ${collapse.count}`);
  const row = visibleTreeRows(tree)[collapse.highlight];
  if (row?.node.label !== "components" || row.expanded !== false) {
    throw new Error(`highlight row = ${JSON.stringify(row?.node.label)} expanded=${row?.expanded}`);
  }
  // left on a collapsed node jumps to its parent (`src`).
  const toParent = treeKey(tree, { name: "left", ...treeKeyBase });
  if (visibleTreeRows(tree)[toParent.highlight]?.node.label !== "src") {
    throw new Error(`parent = ${visibleTreeRows(tree)[toParent.highlight]?.node.label}`);
  }
});

Deno.test("expandTreeNode / collapseTreeNode / toggleTreeNode drive expand state by key", () => {
  const tree = Tree({ nodes: treeFixture() });
  if (expandTreeNode(tree, "0") !== true) throw new Error("expand must report a change");
  if (expandTreeNode(tree, "0") !== false) throw new Error("re-expand must be a no-op");
  if (visibleTreeRows(tree).length !== 5) throw new Error(`after expand = ${visibleTreeRows(tree).length}`);
  if (collapseTreeNode(tree, "0") !== true) throw new Error("collapse must report a change");
  if (visibleTreeRows(tree).length !== 3) throw new Error(`after collapse = ${visibleTreeRows(tree).length}`);
  if (toggleTreeNode(tree, "0") !== true) throw new Error("toggle must report a change");
  if (visibleTreeRows(tree)[0]?.expanded !== true) throw new Error("toggle must expand");
  // A custom id keys the expand state instead of the index path.
  const keyed = Tree({ nodes: [{ id: "root", label: "root", children: [{ label: "child" }] }] });
  if (expandTreeNode(keyed, "0") !== false) throw new Error("index-path key must miss a custom-id node");
  if (expandTreeNode(keyed, "root") !== true) throw new Error("custom id must expand");
  if (visibleTreeRows(keyed).length !== 2) throw new Error(`keyed expand = ${visibleTreeRows(keyed).length}`);
});

Deno.test("treeKey up/down move the highlight and clamp at the ends", () => {
  const tree = Tree({ nodes: treeFixture() });
  const down = treeKey(tree, { name: "down", ...treeKeyBase });
  if (down.highlight !== 1) throw new Error(`down = ${down.highlight}`);
  const up = treeKey(tree, { name: "up", ...treeKeyBase });
  if (up.highlight !== 0) throw new Error(`up = ${up.highlight}`);
  const upClamp = treeKey(tree, { name: "up", ...treeKeyBase });
  if (upClamp.highlight !== 0) throw new Error(`up clamp = ${upClamp.highlight}`);
  for (let i = 0; i < 5; i++) treeKey(tree, { name: "down", ...treeKeyBase });
  if ((tree.props.highlight as number) !== 2) throw new Error(`down clamp = ${tree.props.highlight}`);
  // The reversed leaf follows the highlight.
  if (tree.children[2]?.props.reversed !== true) throw new Error("last row must be reversed");
});

Deno.test("a large tree materializes only the visible window and clamps scroll", () => {
  // 1000 top-level branches, each with 3 children.
  const nodes: TreeNode[] = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push({ label: `dir-${i}`, children: [{ label: "a" }, { label: "b" }, { label: "c" }] });
  }
  const tree = Tree({ nodes, clip_height: 5 });
  // Collapsed: 1000 visible rows, but only 5 materialize.
  if (tree.children.length !== 5) throw new Error(`window = ${tree.children.length}`);
  if (visibleTreeRows(tree).length !== 5) throw new Error(`visible = ${visibleTreeRows(tree).length}`);
  if (treeRowTexts(tree)[0] !== `${TREE_COLLAPSED_GLYPH} dir-0`) {
    throw new Error(`row0 = ${JSON.stringify(treeRowTexts(tree)[0])}`);
  }
  // Drive down well past the window: the window still holds 5 leaves and the
  // highlighted row stays inside it.
  for (let i = 0; i < 40; i++) treeKey(tree, { name: "down", ...treeKeyBase });
  if (tree.children.length !== 5) throw new Error(`window after scroll = ${tree.children.length}`);
  if ((tree.props.highlight as number) !== 40) throw new Error(`highlight = ${tree.props.highlight}`);
  if ((tree.props.scroll_y as number) !== 36) throw new Error(`scroll_y = ${tree.props.scroll_y}`);
  if (treeRowTexts(tree)[4] !== `${TREE_COLLAPSED_GLYPH} dir-40`) {
    throw new Error(`bottom row = ${JSON.stringify(treeRowTexts(tree)[4])}`);
  }
  // Expanding one branch inserts its 3 children into the visible-row count;
  // dir-0 has a following sibling, so its children draw a `│ ` guide.
  const first = Tree({ nodes, clip_height: 5 });
  expandTreeNode(first, "0");
  if (treeRowTexts(first)[1] !== `${TREE_GUIDE_VERTICAL} ` + "  a") {
    throw new Error(`expanded child = ${JSON.stringify(treeRowTexts(first)[1])}`);
  }
});

// ---------------------------------------------------------------------------
// Progress: composition, fill-cell math, percentage readout, label, setProgress
// ---------------------------------------------------------------------------

/** The inner (bar) width of a progress node: the outer width minus the frame's
 * border columns (2 for a visible border, 0 for `none`/unset). */
function progressInnerOf(node: Node): number {
  const outer = typeof node.props.width === "number" ? node.props.width : PROGRESS_DEFAULT_WIDTH;
  const border = node.props.border_style;
  return outer - (border !== undefined && border !== "none" ? 2 : 0);
}

/** The expected bar text: `ceil(ratio*inner)` fills then empty cells. */
function expectedBar(ratio: number, inner: number): string {
  const filled = Math.max(0, Math.min(inner, Math.ceil(ratio * inner)));
  return PROGRESS_FILL_CHAR.repeat(filled) + PROGRESS_EMPTY_CHAR.repeat(inner - filled);
}

Deno.test("Progress composes a framed gauge: fill leaf + percentage readout", () => {
  // Defaults: plain frame, outer width 20 (inner 18), value 0/max 100.
  const node = Progress();
  if (node.type !== "progress") throw new Error(`type = ${node.type}`);
  if (node.props.border_style !== "plain") throw new Error(`border_style = ${node.props.border_style}`);
  if (node.props.height !== 1) throw new Error(`height = ${node.props.height}`);
  if (node.props.width !== PROGRESS_DEFAULT_WIDTH) throw new Error(`width = ${node.props.width}`);
  // The composition bookkeeping keys are consumed by the factory — never
  // scene props (`ratio` is the bar model state, like Tabs' `active`, so it
  // stays on the props).
  if ("label" in node.props || "show_percentage" in node.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(node.props)}`);
  }
  // Composition: the in-flow fill leaf (child 0) + the percentage readout
  // overlay (the last child); no label by default.
  if (node.children.length !== 2) throw new Error(`children = ${node.children.length}`);
  const bar = node.children[0];
  if (bar === undefined || bar.type !== "text") throw new Error("the fill must be a text leaf");
  if (bar.props.text !== expectedBar(0, progressInnerOf(node))) {
    throw new Error(`empty bar = ${JSON.stringify(bar.props.text)}`);
  }
  const readout = node.children[1];
  if (readout === undefined || readout.props.text !== "0%") {
    throw new Error(`readout = ${JSON.stringify(readout?.props.text)}`);
  }
  if (readout?.props.position !== "absolute" || readout?.props.right !== 0) {
    throw new Error(`readout position = ${JSON.stringify(readout?.props)}`);
  }
  if (readout?.props.z_index !== 1) throw new Error("the readout must overlay the fill (z_index 1)");
});

Deno.test("Progress fill-cell math: ceil(value/max * inner_width) filled cells", () => {
  // width 6 with a plain frame => inner width 4.
  const cases: Array<[number, number, string]> = [
    [0, 4, "░░░░"],
    [1, 4, "▓░░░"],
    [2, 4, "▓▓░░"],
    [3, 4, "▓▓▓░"],
    [4, 4, "▓▓▓▓"],
    // value > max clamps to full; ceil rounds partial cells up.
    [5, 4, "▓▓▓▓"],
    [1, 3, "▓▓░░"], // ceil(1/3*4) = ceil(1.33) = 2 of 4
  ];
  for (const [value, max, expected] of cases) {
    const node = Progress({ value, max, width: 6 });
    const text = node.children[0]?.props.text;
    if (text !== expected) {
      throw new Error(`value=${value} max=${max} bar = ${JSON.stringify(text)} (want ${JSON.stringify(expected)})`);
    }
  }
});

Deno.test("Progress percentage readout: ceil(value/max*100)%", () => {
  const readout = (node: Node): string | undefined => node.children[node.children.length - 1]?.props.text;
  if (readout(Progress({ value: 5, max: 10, width: 6 })) !== "50%") {
    throw new Error("50% readout");
  }
  if (readout(Progress({ value: 1, max: 3, width: 6 })) !== "34%") {
    throw new Error("ceil(1/3*100) = 34% readout");
  }
  if (readout(Progress({ value: 99, max: 100, width: 6 })) !== "99%") {
    throw new Error("99% readout");
  }
  // show_percentage: false drops the readout leaf entirely.
  const noReadout = Progress({ value: 1, max: 2, width: 6, show_percentage: false });
  if (noReadout.children.length !== 1 || noReadout.children[0]?.props.text !== "▓▓░░") {
    throw new Error(`no-readout composition = ${noReadout.children.length}`);
  }
});

Deno.test("Progress label: left-aligned overlay inside the bar area when there is room", () => {
  // width 12, plain frame => inner 10; "copy" (4 cells) + "100%" reserve (4)
  // fits.
  const fits = Progress({ value: 2, max: 4, width: 12, label: "copy" });
  if (fits.children.length !== 3) throw new Error(`label composition = ${fits.children.length}`);
  const label = fits.children[1];
  if (label === undefined || label.props.text !== "copy") {
    throw new Error(`label text = ${JSON.stringify(label?.props.text)}`);
  }
  if (label.props.position !== "absolute" || label.props.left !== 0) {
    throw new Error(`label position = ${JSON.stringify(label?.props)}`);
  }
  if (label.props.dim !== true) throw new Error("the label must be dimmed");
  // The fill leaf still counts the full inner width (the label overlays it).
  if (fits.children[0]?.props.text !== expectedBar(0.5, progressInnerOf(fits))) {
    throw new Error("the fill must stay exact under the label overlay");
  }
  // No room: a label wider than inner - reserve is dropped.
  const tight = Progress({ value: 1, max: 4, width: 8, label: "copying" }); // inner 6 < 4 + 4
  if (tight.children.length !== 2 || tight.children[1]?.props.text !== "25%") {
    throw new Error(`tight label must be dropped (${tight.children.length})`);
  }
  // With the readout off, the label only competes against the inner width.
  const wide = Progress({ value: 1, max: 4, width: 10, label: "copying", show_percentage: false }); // inner 8
  if (wide.children.length !== 2 || wide.children[1]?.props.text !== "copying") {
    throw new Error(`no-readout label = ${JSON.stringify(wide.children.map((c) => c.props.text))}`);
  }
  // An empty label string is never composed.
  const empty = Progress({ value: 1, max: 4, width: 12, label: "" });
  if (empty.children.length !== 2) throw new Error("an empty label must be dropped");
});

Deno.test("Progress ratio prop drives the bar directly (wins over value/max)", () => {
  const ratio = Progress({ value: 9, max: 10, ratio: 0.5, width: 6 });
  if (ratio.children[0]?.props.text !== expectedBar(0.5, progressInnerOf(ratio))) {
    throw new Error(`ratio bar = ${JSON.stringify(ratio.children[0]?.props.text)}`);
  }
  if (ratio.children[1]?.props.text !== "50%") {
    throw new Error(`ratio readout = ${JSON.stringify(ratio.children[1]?.props.text)}`);
  }
  // The ratio is clamped into [0, 1].
  const over = Progress({ ratio: 1.5, width: 6 });
  if (over.children[0]?.props.text !== expectedBar(1, progressInnerOf(over))) {
    throw new Error("ratio must clamp to 1");
  }
  const under = Progress({ ratio: -0.5, width: 6 });
  if (under.children[0]?.props.text !== expectedBar(0, progressInnerOf(under))) {
    throw new Error("ratio must clamp to 0");
  }
});

Deno.test("Progress border_style none fills the full outer width (no frame columns)", () => {
  const node = Progress({ value: 1, max: 4, width: 4, border_style: "none" });
  if (node.props.border_style !== "none") throw new Error(`border_style = ${node.props.border_style}`);
  // inner = 4 (no border columns): 1 of 4 cells filled.
  if (node.children[0]?.props.text !== "▓░░░") {
    throw new Error(`bar = ${JSON.stringify(node.children[0]?.props.text)}`);
  }
});

Deno.test("setProgress updates a live bar in place without rebuilding", () => {
  // width 12 (inner 10): the label "work" (4) + the readout reserve (4) fits.
  const node = Progress({ value: 1, max: 4, width: 12, label: "work" });
  if (node.children.length !== 3) throw new Error(`label composition = ${node.children.length}`);
  const barBefore = node.children[0];
  const labelBefore = node.children[1];
  const readoutBefore = node.children[2];
  // Accessors: setProgress mutates the node's props and leaves in place, which
  // TS's control flow cannot see — reading through functions defeats the
  // stale narrowing (the established pattern in this suite).
  const valueOf = (): unknown => node.props.value;
  const maxOf = (): unknown => node.props.max;
  const barText = (): string => node.children[0]?.props.text as string;
  const readoutText = (): string => node.children[2]?.props.text as string;

  setProgress(node, 3);
  if (valueOf() !== 3 || maxOf() !== 4) throw new Error(`props = ${JSON.stringify(node.props)}`);
  // The composition is not rebuilt: the same leaf instances are repainted.
  if (node.children[0] !== barBefore) throw new Error("setProgress must not rebuild the fill leaf");
  if (node.children[1] !== labelBefore) throw new Error("setProgress must not rebuild the label leaf");
  if (node.children[2] !== readoutBefore) throw new Error("setProgress must not rebuild the readout leaf");
  if (barText() !== expectedBar(0.75, progressInnerOf(node))) {
    throw new Error(`bar after setProgress = ${JSON.stringify(barText())}`);
  }
  if (readoutText() !== "75%") {
    throw new Error(`readout after setProgress = ${JSON.stringify(readoutText())}`);
  }

  // The explicit max argument overrides the node's current max.
  setProgress(node, 1, 2);
  if (maxOf() !== 2) throw new Error(`max = ${maxOf()}`);
  if (barText() !== expectedBar(0.5, progressInnerOf(node))) {
    throw new Error(`bar after max override = ${JSON.stringify(barText())}`);
  }
  // 0% clamps the bar empty.
  setProgress(node, 0);
  if (barText() !== expectedBar(0, progressInnerOf(node))) {
    throw new Error(`empty bar = ${JSON.stringify(barText())}`);
  }
  if (readoutText() !== "0%") {
    throw new Error(`0% readout = ${JSON.stringify(readoutText())}`);
  }
});

Deno.test("Progress resolves the progress component preset through resolveTheme", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { progress: { fg: "#98c379", border_style: "double" } },
  });
  const out = resolveTheme(custom, { component: "progress" });
  if (out.fg !== "#98c379") throw new Error(`fg = ${out.fg}`);
  if (out.border_style !== "double") throw new Error(`border_style = ${out.border_style}`);
  if ("component" in out) throw new Error(`component leaked: ${JSON.stringify(out)}`);
  // The preset is stamped onto the framed box by the factory path (the
  // explicit prop wins over the preset). The resolveTheme output is widened
  // NodeProps (its `width` now also admits `"N%"` strings), so it narrows to
  // ProgressProps at the call site — the same cast the react host uses.
  const node = Progress(
    resolveTheme(custom, { component: "progress", width: 6, value: 1, max: 4 }) as ProgressProps,
  );
  if (node.props.fg !== "#98c379") throw new Error(`factory fg = ${node.props.fg}`);
  if (node.props.border_style !== "double") throw new Error(`factory border_style = ${node.props.border_style}`);
});

Deno.test("Progress materializes as a box through the native kind map", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // width 12 (inner 10): the label "x" fits alongside the readout.
    renderer.root.addChild(Progress({ value: 1, max: 4, width: 12, label: "x" }));
    // The progress element materializes its root as a box; the composition
    // (fill + label + readout) materializes as text leaves.
    if (createdNodes.length !== 4) throw new Error(`created = ${JSON.stringify(createdNodes)}`);
    if (createdNodes[0]?.type !== "box") throw new Error(`root native type = ${createdNodes[0]?.type}`);
    for (let i = 1; i < 4; i++) {
      if (createdNodes[i]?.type !== "text") {
        throw new Error(`child ${i} native type = ${createdNodes[i]?.type}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Focus manager
// ---------------------------------------------------------------------------

Deno.test("FocusManager routes keys to the focused element's handler", () => {
  const manager = new FocusManager();
  const received: Array<{ id: string; key: KeyEvent }> = [];
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: (key) => received.push({ id: "a", key }) });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: (key) => received.push({ id: "b", key }) });
  const key: KeyEvent = { name: "char", char: "x", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== false) throw new Error("nothing focused must not route");
  if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
  if (manager.activeId !== "a") throw new Error(`activeId = ${manager.activeId}`);
  if (manager.routeKey(key) !== true) throw new Error("focused route must be handled");
  const afterA = received.length;
  if (afterA !== 1 || received[0]?.id !== "a") throw new Error(`key must route to a (${afterA})`);
  manager.focus("b");
  manager.routeKey(key);
  const afterB = received.length;
  if (afterB !== 2 || received[1]?.id !== "b") throw new Error(`key must route to b (${afterB})`);
  if (received[1]?.key !== key) throw new Error("handler must receive the key event verbatim");
});

Deno.test("routeKey with an explicit node routes to that node's handler", () => {
  const manager = new FocusManager();
  const bNode = Text({ text: "b" });
  let hits = 0;
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => hits++ });
  manager.register({ id: "b", node: bNode, onKey: () => (hits += 10) });
  const key: KeyEvent = { name: "enter", ctrl: false, alt: false, shift: false };
  manager.routeKey(key, bNode);
  if (hits !== 10) throw new Error(`explicit node route = ${hits}`);
});

Deno.test("FocusManager routes paste to the focused element's paste handler", () => {
  const manager = new FocusManager();
  const pasted: Array<{ id: string; text: string }> = [];
  // Length read through a function: TS narrows a const-typed array's `length`
  // to the literal of the last checked comparison, which would flag the
  // follow-up `!== 2` as unintentional.
  const pasteCount = () => pasted.length;
  manager.register({
    id: "a",
    node: Text({ text: "a" }),
    onKey: () => {},
    onPaste: (text) => pasted.push({ id: "a", text }),
  });
  manager.register({
    id: "b",
    node: Text({ text: "b" }),
    onKey: () => {},
    onPaste: (text) => pasted.push({ id: "b", text }),
  });
  if (manager.routePaste("xy") !== false) throw new Error("nothing focused must not route");
  if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
  if (manager.routePaste("xy") !== true) throw new Error("focused paste must be handled");
  if (pasteCount() !== 1 || pasted[0]?.id !== "a" || pasted[0]?.text !== "xy") {
    throw new Error(`paste must route to a verbatim (${JSON.stringify(pasted)})`);
  }
  manager.focus("b");
  manager.routePaste("z");
  if (pasteCount() !== 2 || pasted[1]?.id !== "b" || pasted[1]?.text !== "z") {
    throw new Error(`paste must route to b (${JSON.stringify(pasted)})`);
  }
});

Deno.test("routePaste falls through when the focused element registers no paste handler", () => {
  const manager = new FocusManager();
  const pasted: string[] = [];
  // Only `a` handles paste; `b` is a key-only focusable.
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {}, onPaste: (t) => pasted.push(t) });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.focus("b");
  if (manager.routePaste("xy") !== false) throw new Error("a paste-blind element must not consume");
  if (pasted.length !== 0) throw new Error(`no dispatch without an onPaste handler (${pasted.length})`);
  manager.focus("a");
  if (manager.routePaste("xy") !== true) throw new Error("a paste-handling element must consume");
  if (pasted.join(",") !== "xy") throw new Error(`pasted = ${pasted.join(",")}`);
});

Deno.test("routePaste with an explicit node routes to that node's paste handler", () => {
  const manager = new FocusManager();
  const bNode = Text({ text: "b" });
  const pasted: string[] = [];
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {}, onPaste: (t) => pasted.push("a:" + t) });
  manager.register({ id: "b", node: bNode, onKey: () => {}, onPaste: (t) => pasted.push("b:" + t) });
  manager.routePaste("xy", bNode);
  if (pasted.join(",") !== "b:xy") throw new Error(`explicit node paste = ${pasted.join(",")}`);
});

Deno.test("useFocus with an onPaste handler registers paste routing", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  const pasted: string[] = [];
  const handle = useFocus("f", node, () => {}, manager, (text) => pasted.push(text));
  handle.focus();
  if (manager.routePaste("hi") !== true) throw new Error("routed paste must be handled");
  if (pasted.join(",") !== "hi") throw new Error(`pasted = ${pasted.join(",")}`);
  handle.dispose();
  if (manager.has("f")) throw new Error("dispose() must unregister the id");
  if (manager.routePaste("hi") !== false) throw new Error("disposed handle must not route");
});

// ---------------------------------------------------------------------------
// IME-confirmed paste round-trips (round 5, subtask 4)
// ---------------------------------------------------------------------------
//
// crossterm 0.29 surfaces no composition/preedit events (see docs/roadmap.md
// "IME posture"), so an IME's confirmed composition reaches an Input/Textarea
// through the shipped bracketed-paste path: `EnableBracketedPaste` in the
// backend, `TernEvent::Paste`, `FocusManager.routePaste`, and
// `pasteInto` / `pasteIntoTextarea`. These suites pin that path: every
// multi-codepoint CJK/IME-confirmed string — pre-composed (NFC) and
// decomposed (NFD) forms alike — round-trips **losslessly** into a focused
// Input and a focused Textarea, and the insert is cluster-safe (a caret
// inside a wide glyph or mid-cluster snaps to the cluster boundary, never
// splitting a grapheme).

Deno.test("routePaste round-trips IME-confirmed CJK into a focused Input (plain and pre-composed)", () => {
  // A pre-composed (NFC) IME-confirmed string: CJK ideographs, each a single
  // 2-column grapheme cluster. The paste lands verbatim at the caret and the
  // caret advances by the total display width (8 for 你好世界).
  const manager = new FocusManager();
  const input = Input({ value: "ab", caret: 1 });
  useFocus("in", input, () => {}, manager, (text) => pasteInto(input, text)).focus();
  if (manager.routePaste("你好世界") !== true) throw new Error("a focused input must consume the paste");
  if (input.props.value !== "a你好世界b") {
    throw new Error(`value = ${JSON.stringify(input.props.value)}, expected "a你好世界b"`);
  }
  if (input.children[0]?.props.text !== "a你好世界b") {
    throw new Error(`leaf text = ${JSON.stringify(input.children[0]?.props.text)}`);
  }
  if (input.props.caret !== 9 || input.children[0]?.props.caret !== 9) {
    throw new Error(`caret = ${input.props.caret}/${input.children[0]?.props.caret}, expected 9`);
  }

  // A second composition confirms in a row and accumulates losslessly (an
  // IME emits one paste per confirmed composition). The value/caret are read
  // through functions so TS does not narrow their types to the literal of the
  // previous comparison (see the pasteCount pattern above).
  const readValue = () => input.props.value;
  const readCaret = () => input.props.caret;
  if (manager.routePaste("こんにちは") !== true) throw new Error("a second paste must be consumed");
  if (readValue() !== "a你好世界こんにちはb") {
    throw new Error(`accumulated value = ${JSON.stringify(readValue())}`);
  }
  if (readCaret() !== 19) throw new Error(`accumulated caret = ${readCaret()}, expected 19`);

  // A decomposed (NFD) form: Hangul jamo — decomposed 한글 is two LVT
  // grapheme clusters (4 display columns) — must round-trip verbatim.
  const jamoManager = new FocusManager();
  const jamo = Input({ value: "ab", caret: 1 });
  useFocus("jamo", jamo, () => {}, jamoManager, (text) => pasteInto(jamo, text)).focus();
  if (jamoManager.routePaste("한글") !== true) throw new Error("a jamo paste must be consumed");
  if (jamo.props.value !== "a한글b") {
    throw new Error(`jamo value = ${JSON.stringify(jamo.props.value)}`);
  }
  if (jamo.props.caret !== 5) throw new Error(`jamo caret = ${jamo.props.caret}, expected 5`);

  // A base-plus-combining NFD sequence (é = e + U+0301) is one 1-column
  // cluster and must survive the round-trip as the same code units.
  const combiningManager = new FocusManager();
  const combining = Input({ value: "ab", caret: 1 });
  useFocus("comb", combining, () => {}, combiningManager, (text) => pasteInto(combining, text)).focus();
  if (combiningManager.routePaste("e\u{301}") !== true) throw new Error("a combining paste must be consumed");
  if (combining.props.value !== "ae\u{301}b") {
    throw new Error(`combining value = ${JSON.stringify(combining.props.value)}`);
  }
  if (combining.props.caret !== 2) throw new Error(`combining caret = ${combining.props.caret}, expected 2`);

  // Cluster-safe insert: a caret column inside a wide glyph (col 1 of the
  // 2-column コ) snaps back to the cluster start — the paste lands before
  // the glyph, never mid-cluster.
  const snapManager = new FocusManager();
  const snap = Input({ value: "コab", caret: 1 });
  useFocus("snap", snap, () => {}, snapManager, (text) => pasteInto(snap, text)).focus();
  if (snapManager.routePaste("世") !== true) throw new Error("a snap paste must be consumed");
  if (snap.props.value !== "世コab") {
    throw new Error(`snap value = ${JSON.stringify(snap.props.value)}, expected "世コab"`);
  }
  if (snap.props.caret !== 3) throw new Error(`snap caret = ${snap.props.caret}, expected 3`);
});

Deno.test("routePaste round-trips IME-confirmed CJK into a focused Textarea (plain and pre-composed)", () => {
  // A pre-composed (NFC) IME-confirmed string lands at the caret column; the
  // textarea caret column is a code-unit index, so it advances by the pasted
  // code units (4 for 你好世界).
  const manager = new FocusManager();
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  useFocus("ta", ta, () => {}, manager, (text) => pasteIntoTextarea(ta, text)).focus();
  if (manager.routePaste("你好世界") !== true) throw new Error("a focused textarea must consume the paste");
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,c你好世界d") {
    throw new Error(`lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if ((ta.props as TextareaProps).row !== 1 || (ta.props as TextareaProps).col !== 5) {
    throw new Error(`row/col = ${(ta.props as TextareaProps).row}/${(ta.props as TextareaProps).col}, expected 1/5`);
  }
  if (ta.children[1]?.props.text !== "c你好世界d") {
    throw new Error(`leaf = ${JSON.stringify(ta.children[1]?.props.text)}`);
  }

  // A second composition accumulates losslessly on the same line.
  if (manager.routePaste("안녕하세요") !== true) throw new Error("a second textarea paste must be consumed");
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,c你好世界안녕하세요d") {
    throw new Error(`accumulated lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if ((ta.props as TextareaProps).col !== 10) throw new Error(`accumulated col = ${(ta.props as TextareaProps).col}`);

  // A multi-line CJK paste: the pasted \n splits into new logical lines with
  // the post-caret tail joining the last segment.
  const multiManager = new FocusManager();
  const multi = Textarea({ lines: ["你好"], row: 0, col: 2 });
  useFocus("multi", multi, () => {}, multiManager, (text) => pasteIntoTextarea(multi, text)).focus();
  if (multiManager.routePaste("世\n界") !== true) throw new Error("a multi-line paste must be consumed");
  if ((multi.props as TextareaProps).lines?.join(",") !== "你好世,界") {
    throw new Error(`multi lines = ${JSON.stringify(multi.props.lines)}`);
  }
  if ((multi.props as TextareaProps).row !== 1 || (multi.props as TextareaProps).col !== 1) {
    throw new Error(`multi row/col = ${(multi.props as TextareaProps).row}/${(multi.props as TextareaProps).col}, expected 1/1`);
  }
  if (multi.children[1]?.props.text !== "界") throw new Error(`multi leaf = ${JSON.stringify(multi.children[1]?.props.text)}`);

  // A decomposed (NFD) Hangul jamo paste inserts verbatim; the caret column
  // advances by code units (3 for 한).
  const jamoManager = new FocusManager();
  const jamo = Textarea({ lines: ["ab"], row: 0, col: 1 });
  useFocus("jamo", jamo, () => {}, jamoManager, (text) => pasteIntoTextarea(jamo, text)).focus();
  if (jamoManager.routePaste("한") !== true) throw new Error("a jamo textarea paste must be consumed");
  if ((jamo.props as TextareaProps).lines?.join(",") !== "a한b") {
    throw new Error(`jamo lines = ${JSON.stringify(jamo.props.lines)}`);
  }
  if ((jamo.props as TextareaProps).col !== 4) throw new Error(`jamo col = ${(jamo.props as TextareaProps).col}, expected 4`);

  // Cluster-safe insert: a mid-cluster caret column (col 3 inside the
  // 3-code-unit 한 cluster) snaps to the cluster end before the paste.
  const snapManager = new FocusManager();
  const snap = Textarea({ lines: ["a한b"], row: 0, col: 3 });
  useFocus("snap", snap, () => {}, snapManager, (text) => pasteIntoTextarea(snap, text)).focus();
  if (snapManager.routePaste("文") !== true) throw new Error("a snap textarea paste must be consumed");
  if ((snap.props as TextareaProps).lines?.join(",") !== "a한文b") {
    throw new Error(`snap lines = ${JSON.stringify(snap.props.lines)}`);
  }
  if ((snap.props as TextareaProps).col !== 5) throw new Error(`snap col = ${(snap.props as TextareaProps).col}, expected 5`);
});

Deno.test("unregister clears the active focus and stops dispatch", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const unsub = manager.register({ id: "x", node, onKey: () => hits++ });
  manager.focus("x");
  if (manager.active?.node !== node) throw new Error("active entry must expose the node");
  unsub();
  if (manager.activeId !== null) throw new Error("active must clear on unregister");
  if (manager.has("x")) throw new Error("entry must be gone after unregister");
  const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== false) throw new Error("unregistered id must not route");
  if (hits !== 0) throw new Error("no dispatch after unregister");
});

Deno.test("useFocus registers, focuses and disposes through the manager", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const handle = useFocus("f", node, () => hits++, manager);
  if (!manager.has("f")) throw new Error("useFocus must register the id");
  handle.focus();
  if (!handle.isFocused()) throw new Error("focus() must make the id active");
  const key: KeyEvent = { name: "char", char: "q", ctrl: false, alt: false, shift: false };
  if (manager.routeKey(key) !== true) throw new Error("routed key must be handled");
  if (hits !== 1) throw new Error(`routed through the handle's handler = ${hits}`);
  handle.blur();
  if (handle.isFocused()) throw new Error("blur() must clear the active focus");
  handle.dispose();
  if (manager.has("f")) throw new Error("dispose() must unregister the id");
});

Deno.test("the default focus manager is a FocusManager instance", () => {
  if (!(focusManager instanceof FocusManager)) {
    throw new Error("default focus manager must be a FocusManager");
  }
});

function assertActiveId(manager: FocusManager, expected: string | null, label: string): void {
  const actual = manager.activeId;
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertEvents(events: Array<string | null>, expected: Array<string | null>, label: string): void {
  if (events.length !== expected.length) {
    throw new Error(`${label}: expected ${expected.length} events, got ${events.length}: ${JSON.stringify(events)}`);
  }
  for (let i = 0; i < events.length; i++) {
    if (events[i] !== expected[i]) {
      throw new Error(`${label}: event ${i} = ${JSON.stringify(events[i])}, expected ${JSON.stringify(expected[i])}`);
    }
  }
}

Deno.test("FocusManager next/prev/focusFirst traverse registration order with wrap-around", () => {
  const manager = new FocusManager();
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.register({ id: "c", node: Text({ text: "c" }), onKey: () => {} });
  // With nothing focused, next()/prev() start at the first element.
  if (manager.next() !== true) throw new Error("next() with no active must focus the first");
  assertActiveId(manager, "a", "next() start");
  if (manager.next() !== true) throw new Error("next() must move forward");
  assertActiveId(manager, "b", "next() forward");
  if (manager.next() !== true) throw new Error("next() must reach the last");
  assertActiveId(manager, "c", "next() last");
  if (manager.next() !== true) throw new Error("next() must wrap to the first");
  assertActiveId(manager, "a", "next() wrap");
  if (manager.prev() !== true) throw new Error("prev() must wrap to the last");
  assertActiveId(manager, "c", "prev() wrap");
  if (manager.prev() !== true) throw new Error("prev() must move backward");
  assertActiveId(manager, "b", "prev() backward");
  if (manager.prev() !== true) throw new Error("prev() must reach the first");
  assertActiveId(manager, "a", "prev() first");
  if (manager.focusFirst() !== true) throw new Error("focusFirst() must succeed");
  assertActiveId(manager, "a", "focusFirst()");
  // A single-element manager: next/prev stay on the only element.
  const single = new FocusManager();
  single.register({ id: "only", node: Text({ text: "x" }), onKey: () => {} });
  if (single.next() !== true) throw new Error("single next() must succeed");
  assertActiveId(single, "only", "single next()");
  if (single.prev() !== true) throw new Error("single prev() must succeed");
  assertActiveId(single, "only", "single prev()");
  // An empty manager: traversal is a no-op that reports failure.
  const empty = new FocusManager();
  if (empty.next() !== false) throw new Error("next() on empty manager must fail");
  if (empty.prev() !== false) throw new Error("prev() on empty manager must fail");
  if (empty.focusFirst() !== false) throw new Error("focusFirst() on empty manager must fail");
});

Deno.test("FocusManager subscribe fires exactly once per focus/blur/unregister change", () => {
  const manager = new FocusManager();
  const events: Array<string | null> = [];
  const unsub = manager.subscribe((id) => events.push(id));
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.focus("a");
  manager.focus("b");
  manager.blur();
  assertEvents(events, ["a", "b", null], "focus/blur");
  // Unregistering the active id also reports the cleared focus.
  manager.focus("a");
  manager.unregister("a");
  assertEvents(events, ["a", "b", null, "a", null], "unregister of active id");
  // Unsubscribing stops delivery.
  unsub();
  manager.focus("b");
  assertEvents(events, ["a", "b", null, "a", null], "after unsubscribe");
});

Deno.test("FocusManager focusIdFor maps nodes to registered ids and clears on unregister", () => {
  const manager = new FocusManager();
  const aNode = Text({ text: "a" });
  const bNode = Text({ text: "b" });
  if (manager.focusIdFor(aNode) !== null) throw new Error("unregistered node must map to null");
  manager.register({ id: "a", node: aNode, onKey: () => {} });
  manager.register({ id: "b", node: bNode, onKey: () => {} });
  if (manager.focusIdFor(aNode) !== "a") throw new Error("focusIdFor(aNode) must be 'a'");
  if (manager.focusIdFor(bNode) !== "b") throw new Error("focusIdFor(bNode) must be 'b'");
  if (manager.focusIdFor(Text({ text: "other" })) !== null) {
    throw new Error("foreign node must map to null");
  }
  manager.unregister("a");
  if (manager.focusIdFor(aNode) !== null) throw new Error("focusIdFor must be null after unregister");
  if (manager.focusIdFor(bNode) !== "b") throw new Error("other mapping must survive");
  // Re-registering the same node under a new id updates the mapping.
  manager.register({ id: "a2", node: aNode, onKey: () => {} });
  if (manager.focusIdFor(aNode) !== "a2") throw new Error("re-registered node must map to the new id");
});

Deno.test("FocusManager focus/blur are idempotent and notify only on change", () => {
  const manager = new FocusManager();
  const events: Array<string | null> = [];
  manager.subscribe((id) => events.push(id));
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.focus("a");
  assertActiveId(manager, "a", "focus(a)");
  // Re-focusing the active id is a no-op: state and notifications unchanged.
  manager.focus("a");
  assertActiveId(manager, "a", "idempotent focus");
  manager.blur();
  assertActiveId(manager, null, "blur");
  // Blurring when already blurred is a no-op.
  manager.blur();
  assertActiveId(manager, null, "idempotent blur");
  // Focusing an unregistered id fails without disturbing state.
  if (manager.focus("missing") !== false) throw new Error("focus on unregistered id must fail");
  assertActiveId(manager, null, "failed focus");
  assertEvents(events, ["a", null], "idempotent notifications");
});

// ---------------------------------------------------------------------------
// Roadmap elements: Modal
// ---------------------------------------------------------------------------

Deno.test("Modal composes a dimmed backdrop plus a centered content box at a high z_index", () => {
  const content = Text({ text: "hi" });
  const modal = Modal({ open: true, content: [content] });
  if (modal.type !== "modal") throw new Error(`type = ${modal.type}`);
  // The overlay paints above in-flow content (z 0; the scrollbar/sticky
  // header stack at 1): the root box carries the high default z_index.
  if (modal.props.z_index !== MODAL_Z_INDEX) throw new Error(`z_index = ${modal.props.z_index}`);
  if (modal.props.position !== "absolute") throw new Error(`position = ${modal.props.position}`);
  if (modal.props.justify_content !== "center" || modal.props.align_items !== "center") {
    throw new Error(`centering = ${JSON.stringify(modal.props)}`);
  }
  if (modal.props.open !== true) throw new Error(`open = ${modal.props.open}`);
  if (modal.props.hidden !== false) throw new Error(`hidden = ${modal.props.hidden}`);
  if (modal.props.display !== "flex") throw new Error(`display = ${modal.props.display}`);
  // An explicit z_index is honored.
  const layered = Modal({ z_index: 5 });
  if (layered.props.z_index !== 5) throw new Error(`layered z_index = ${layered.props.z_index}`);
  // Composition: a dimmed backdrop fill + a centered content box holding the
  // content nodes.
  if (modal.children.length !== 2) throw new Error(`children = ${modal.children.length}`);
  const backdrop = modal.children[0];
  if (backdrop?.props.position !== "absolute") throw new Error("backdrop must be an absolute fill");
  if (backdrop?.props.bg !== MODAL_BACKDROP_BG || backdrop?.props.dim !== true) {
    throw new Error(`backdrop = ${JSON.stringify(backdrop?.props)}`);
  }
  const box = modal.children[1];
  if (box?.type !== "box" || box?.props.flex_direction !== "column") {
    throw new Error("content box must be a flex column");
  }
  if (box?.children[0] !== content) throw new Error("content must live inside the content box");
  // `backdrop: false` skips the dim layer (content box only).
  const bare = Modal({ backdrop: false });
  if (bare.children.length !== 1) throw new Error(`bare children = ${bare.children.length}`);
  // `content` is JS bookkeeping, never a scene prop.
  if ("content" in modal.props) throw new Error("content must not reach the scene props");
});

Deno.test("Modal starts hidden and openModal/closeModal toggle the visible state", () => {
  // The default (open: false) modal is hidden. Fresh reads per assertion —
  // TS narrows a const-typed property access to its first-checked literal.
  const closed = Modal();
  const open = (): unknown => closed.props.open;
  const hidden = (): unknown => closed.props.hidden;
  const display = (): unknown => closed.props.display;
  if (open() !== false) throw new Error(`open = ${open()}`);
  if (hidden() !== true) throw new Error(`hidden = ${hidden()}`);
  if (display() !== "none") throw new Error(`display = ${display()}`);
  // openModal shows it; closeModal hides it again.
  openModal(closed);
  if (open() !== true || hidden() !== false || display() !== "flex") {
    throw new Error(`after open = ${JSON.stringify(closed.props)}`);
  }
  closeModal(closed);
  if (open() !== false || hidden() !== true || display() !== "none") {
    throw new Error(`after close = ${JSON.stringify(closed.props)}`);
  }
  // Opening an already-open modal is a no-op (the focus record must not be
  // overwritten by the focus that now sits inside the overlay).
  openModal(closed);
  openModal(closed);
  if (open() !== true) throw new Error(`double open = ${JSON.stringify(closed.props)}`);
  closeModal(closed);
  closeModal(closed);
  if (open() !== false) throw new Error(`double close = ${JSON.stringify(closed.props)}`);
  // A foreign node (not created by the Modal factory) is left alone.
  const box = Box();
  openModal(box);
  if ("open" in box.props) throw new Error("openModal must ignore non-modal nodes");
  closeModal(box);
});

Deno.test("openModal focuses the first registered focusable and closeModal restores the prior focus", () => {
  const modal = Modal({});
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const outsideNode = Text({ text: "out" });
  // The overlay's focusable registers first, so `openModal`'s `focusFirst()`
  // lands inside the overlay; the outside focusable is the prior focus that
  // closing restores. Fresh read per assertion (see the toggle test above).
  const inside = useFocus("modal-in", insideNode, () => {}, manager);
  const outside = useFocus("modal-out", outsideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    manager.focus("modal-out");
    if (activeId() !== "modal-out") throw new Error("setup focus failed");
    openModal(modal, manager);
    if (activeId() !== "modal-in") {
      throw new Error(`open must focus the first registered focusable, got ${activeId()}`);
    }
    closeModal(modal, manager);
    if (activeId() !== "modal-out") {
      throw new Error(`close must restore the prior focus, got ${activeId()}`);
    }
  } finally {
    inside.dispose();
    outside.dispose();
    manager.blur();
  }
});

Deno.test("closeModal falls back to a blur when nothing was focused before the open", () => {
  const modal = Modal({});
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const inside = useFocus("modal-fallback-in", insideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    // Nothing is focused when the modal opens: the record is null.
    openModal(modal, manager);
    if (activeId() !== "modal-fallback-in") {
      throw new Error(`focusFirst must focus the registered focusable, got ${activeId()}`);
    }
    closeModal(modal, manager);
    if (activeId() !== null) {
      throw new Error(`close with no recorded focus must blur, got ${activeId()}`);
    }
    // A recorded id that was unregistered meanwhile also falls back to blur.
    manager.focus("modal-fallback-in");
    openModal(modal, manager);
    inside.dispose(); // unregister the recorded id while the modal is open
    closeModal(modal, manager);
    if (activeId() !== null) {
      throw new Error(`close with an unregistered recorded id must blur, got ${activeId()}`);
    }
  } finally {
    inside.dispose();
    manager.blur();
  }
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

Deno.test("defaultTheme covers every palette role and component preset", () => {
  for (const role of THEME_ROLES) {
    const colors = defaultTheme.palette[role];
    if (colors === undefined) throw new Error(`missing palette role ${role}`);
    if (typeof colors.fg !== "string" || colors.fg === "") {
      throw new Error(`role ${role} fg = ${JSON.stringify(colors.fg)}`);
    }
    if (typeof colors.bg !== "string" || colors.bg === "") {
      throw new Error(`role ${role} bg = ${JSON.stringify(colors.bg)}`);
    }
  }
  for (const kind of THEME_COMPONENTS) {
    if (defaultTheme.components[kind] === undefined) {
      throw new Error(`missing component preset ${kind}`);
    }
  }
});

Deno.test("resolveTheme stamps the role palette fg/bg and strips the hint", () => {
  const out = resolveTheme(defaultTheme, { role: "danger" });
  if (out.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`fg = ${out.fg}`);
  }
  if (out.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`bg = ${out.bg}`);
  }
  if ("role" in out) throw new Error(`role leaked: ${JSON.stringify(out)}`);
  if ("component" in out) throw new Error(`component leaked: ${JSON.stringify(out)}`);
});

Deno.test("resolveTheme stamps a component preset fg/bg/border_style", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { input: { fg: "#123456", border_style: "rounded" } },
  });
  const out = resolveTheme(custom, { component: "input" });
  if (out.fg !== "#123456") throw new Error(`fg = ${out.fg}`);
  if (out.border_style !== "rounded") throw new Error(`border_style = ${out.border_style}`);
  if ("component" in out) throw new Error(`component leaked: ${JSON.stringify(out)}`);
});

Deno.test("resolveTheme precedence: explicit props > role palette > component preset", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { status_bar: { fg: "#111111", bg: "#222222", border_style: "thick" } },
  });
  // No explicit style: the component preset fills fg/bg/border_style.
  const presetOnly = resolveTheme(custom, { component: "status_bar" });
  if (presetOnly.fg !== "#111111" || presetOnly.bg !== "#222222") {
    throw new Error(`preset fill = ${JSON.stringify(presetOnly)}`);
  }
  if (presetOnly.border_style !== "thick") {
    throw new Error(`preset border_style = ${presetOnly.border_style}`);
  }
  // Role added: the role palette overrides the preset's fg/bg (role is the
  // more specific intent), the preset's border_style is kept.
  const roleWins = resolveTheme(custom, { component: "status_bar", role: "danger" });
  if (roleWins.fg !== custom.palette.danger.fg) {
    throw new Error(`role must win over preset fg: ${roleWins.fg}`);
  }
  if (roleWins.bg !== custom.palette.danger.bg) {
    throw new Error(`role must win over preset bg: ${roleWins.bg}`);
  }
  if (roleWins.border_style !== "thick") {
    throw new Error(`preset border_style must survive: ${roleWins.border_style}`);
  }
  // Explicit props win over both.
  const explicit = resolveTheme(custom, {
    component: "status_bar",
    role: "danger",
    fg: "#ff0000",
  });
  if (explicit.fg !== "#ff0000") throw new Error(`explicit fg = ${explicit.fg}`);
  if (explicit.bg !== custom.palette.danger.bg) {
    throw new Error(`explicit fg must not suppress the role bg: ${explicit.bg}`);
  }
});

Deno.test("resolveTheme without hints returns the props unchanged (plain node props)", () => {
  const props: ThemeResolvableProps = { text: "hi", bold: true, width: 10 };
  const out = resolveTheme(defaultTheme, props);
  if (out.text !== "hi" || out.bold !== true || out.width !== 10) {
    throw new Error(`props changed: ${JSON.stringify(out)}`);
  }
  if (Object.keys(out).length !== 3) {
    throw new Error(`unexpected keys: ${JSON.stringify(out)}`);
  }
});

Deno.test("resolveTheme output feeds the element factories as plain node props", () => {
  const node = Text(resolveTheme(defaultTheme, { text: "err", role: "danger" }));
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (node.props.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`stamped fg = ${node.props.fg}`);
  }
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`stamped bg = ${node.props.bg}`);
  }
  if ("role" in node.props || "component" in node.props) {
    throw new Error(`semantic hints reached the node: ${JSON.stringify(node.props)}`);
  }
});

Deno.test("mergeTheme merges partial roles and keeps base keys", () => {
  const overrides: ThemeOverrides = { palette: { danger: { fg: "#ff0000" } } };
  const merged = mergeTheme(defaultTheme, overrides);
  // The overridden role keeps its base bg and gains the override fg.
  if (merged.palette.danger.fg !== "#ff0000") throw new Error(`merged fg = ${merged.palette.danger.fg}`);
  if (merged.palette.danger.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`base bg must be kept: ${merged.palette.danger.bg}`);
  }
  // Untouched roles are copied through unchanged.
  if (merged.palette.success.fg !== defaultTheme.palette.success.fg) {
    throw new Error(`untouched role changed: ${merged.palette.success.fg}`);
  }
  // The base is not mutated.
  if (defaultTheme.palette.danger.fg === "#ff0000") {
    throw new Error("mergeTheme must not mutate the base theme");
  }
  if (merged === defaultTheme) throw new Error("mergeTheme must return a new theme");
});

Deno.test("mergeTheme merges component presets per key", () => {
  const merged = mergeTheme(defaultTheme, {
    components: { panels: { border_style: "double" } },
  });
  if (merged.components.panels.border_style !== "double") {
    throw new Error(`preset border_style = ${merged.components.panels.border_style}`);
  }
  if ("fg" in merged.components.panels) {
    throw new Error(`unset preset key must stay absent: ${JSON.stringify(merged.components.panels)}`);
  }
  // Other component presets are untouched.
  if (merged.components.input !== defaultTheme.components.input) {
    throw new Error("untouched preset must be copied through");
  }
});

Deno.test("mergeTheme accepts a full Theme as overrides", () => {
  const custom: Theme = mergeTheme(defaultTheme, {
    palette: { primary: { fg: "#0000ff", bg: "#000000" } },
  });
  const merged = mergeTheme(defaultTheme, custom);
  if (merged.palette.primary.fg !== "#0000ff" || merged.palette.primary.bg !== "#000000") {
    throw new Error(`full-theme override = ${JSON.stringify(merged.palette.primary)}`);
  }
  if (merged.palette.muted.fg !== defaultTheme.palette.muted.fg) {
    throw new Error(`unoverridden role changed: ${merged.palette.muted.fg}`);
  }
});

// ---------------------------------------------------------------------------
// ScrollView
// ---------------------------------------------------------------------------

/**
 * A size-aware fake native node handle for the ScrollView tests:
 * `content_size` returns the size derived at creation — text/streaming nodes
 * measure their content (widest line width, line count), boxes use their
 * `width`/`height` props or a default viewport of {11, 2}. This mirrors the
 * real engine's `content_size` contract (text = wrapped content, containers =
 * laid-out rect) so the scroll helpers' clamping is exercised against
 * realistic geometry.
 *
 * A `streaming_text` handle accumulates spans appended through
 * `append_span` and measures *them* (the real engine measures the stream, not
 * a `text` prop — compositor.rs `content_size`), so the auto-scroll tests can
 * grow the content by appending spans, exactly like the native path.
 */
class FakeScrollNodeHandle {
  readonly kind: string;
  readonly props: Record<string, unknown>;
  streamText = "";
  constructor(type: string, props: Record<string, unknown> | null | undefined) {
    this.kind = type;
    this.props = props ?? {};
  }
  content_size(): { width: number; height: number } {
    if (this.kind === "text" || this.kind === "streaming_text") {
      const text = this.kind === "streaming_text"
        ? this.streamText
        : (typeof this.props.text === "string" ? this.props.text : "");
      const lines = text.split("\n");
      let width = 0;
      for (const line of lines) width = Math.max(width, line.length);
      return { width, height: lines.length };
    }
    return {
      width: typeof this.props.width === "number" ? this.props.width : 11,
      height: typeof this.props.height === "number" ? this.props.height : 2,
    };
  }
  add_child(child: unknown): unknown {
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    return child;
  }
  set_props(_props: unknown): void {}
  set_prop(_key: string, _value: unknown): void {}
  append_span(text: string, _style?: unknown): void {
    this.streamText += text;
  }
  remove(): boolean {
    return true;
  }
}

/** The native node types materialized through the size-aware fake. */
const scrollCreatedNodes: Array<{ type: string; props: Record<string, unknown> | null }> = [];

/** A fake addon whose `content_size` reflects each node's content/layout. */
const scrollFakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeScrollNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) => {
    scrollCreatedNodes.push({ type, props: props ?? null });
    return new FakeScrollNodeHandle(type, props);
  },
} as unknown as TernAddon;

/** Run `fn` with the size-aware fake addon installed. */
function withScrollFakeAddon(fn: () => void): void {
  scrollCreatedNodes.length = 0;
  setAddonForTesting(scrollFakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

Deno.test("ScrollView builds a scroll_view box with the clip/scroll region props", () => {
  const view = ScrollView({
    clip_x: 1,
    clip_y: 2,
    clip_width: 10,
    clip_height: 4,
    scroll_x: 0,
    scroll_y: 3,
  });
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.clip_x !== 1) throw new Error(`clip_x = ${view.props.clip_x}`);
  if (view.props.clip_y !== 2) throw new Error(`clip_y = ${view.props.clip_y}`);
  if (view.props.clip_width !== 10) throw new Error(`clip_width = ${view.props.clip_width}`);
  if (view.props.clip_height !== 4) throw new Error(`clip_height = ${view.props.clip_height}`);
  if (view.props.scroll_x !== 0) throw new Error(`scroll_x = ${view.props.scroll_x}`);
  if (view.props.scroll_y !== 3) throw new Error(`scroll_y = ${view.props.scroll_y}`);
});

Deno.test("ScrollView attaches rest-arg and props children, consuming both keys", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const viaProps = ScrollView({ children: [b] }, a);
  const kids = viaProps.children;
  if (kids.length !== 2) throw new Error(`children = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== b) throw new Error("content order must be rest args then props children");
  // Both keys are consumed by the factory — never scene props.
  if ("children" in viaProps.props || "showScrollbar" in viaProps.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(viaProps.props)}`);
  }
});

Deno.test("showScrollbar appends a scrollbar text leaf to the composition", () => {
  const withBar = ScrollView({ showScrollbar: true }, Text({ text: "x" }));
  // Content + the scrollbar leaf (a text node pinned to the right edge).
  if (withBar.children.length !== 2) throw new Error(`children = ${withBar.children.length}`);
  const leaf = withBar.children[1];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("scrollbar must be a text leaf");
  }
  if (leaf.props.position !== "absolute" || leaf.props.right !== 0 || leaf.props.width !== 1) {
    throw new Error(`leaf props = ${JSON.stringify(leaf.props)}`);
  }
  // Without the flag no scrollbar leaf is composed.
  const noBar = ScrollView({}, Text({ text: "x" }));
  if (noBar.children.length !== 1) throw new Error(`no-bar children = ${noBar.children.length}`);
});

Deno.test("scrollTo sets scroll props and clamps to the content bounds", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 2} (from the width/height props); the content text is
    // 5 cells wide, 3 rows tall -> maxY = 1, maxX = 0.
    const view = ScrollView({ width: 5, height: 2 }, Text({ text: "aaaa\nbbbbb\ncc" }));
    renderer.root.addChild(view);
    const applied = scrollTo(view, 0, 5);
    if (applied.x !== 0 || applied.y !== 1) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 0 || view.props.scroll_y !== 1) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scrollTo clamps horizontal overflow against the content width", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {3, 2}; the content text is 8 cells wide -> maxX = 5.
    const view = ScrollView({ width: 3, height: 2 }, Text({ text: "abcdefgh" }));
    renderer.root.addChild(view);
    const applied = scrollTo(view, 10, 0);
    if (applied.x !== 5 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 5) throw new Error(`scroll_x = ${view.props.scroll_x}`);
  });
});

Deno.test("scrollBy offsets from the current scroll and clamps both directions", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 5, height: 2 }, Text({ text: "aaaa\nbbbbb\ncc" }));
    renderer.root.addChild(view);
    scrollTo(view, 0, 1); // at the max offset
    const applied = scrollBy(view, 0, 3); // past the max -> clamped back
    if (applied.y !== 1) throw new Error(`applied = ${JSON.stringify(applied)}`);
    const back = scrollBy(view, 0, -1); // back up
    if (back.y !== 0) throw new Error(`back = ${JSON.stringify(back)}`);
    if (view.props.scroll_y !== 0) throw new Error(`scroll_y = ${view.props.scroll_y}`);
  });
});

Deno.test("scrollTop resets the vertical offset and keeps the horizontal", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 3, height: 2 }, Text({ text: "abcdefgh" }));
    renderer.root.addChild(view);
    scrollTo(view, 5, 0);
    const applied = scrollTop(view);
    if (applied.x !== 5 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (view.props.scroll_x !== 5 || view.props.scroll_y !== 0) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scroll helpers refresh the scrollbar track and thumb from the clamped offset", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 3}; content height 5 -> maxY = 2, thumb length 2
    // (round(3*3/5) = 2) on a 1-row track range.
    const view = ScrollView({ width: 5, height: 3, showScrollbar: true }, Text({ text: "aa\nbb\ncc\ndd\nee" }));
    renderer.root.addChild(view);
    const leaf = view.children[1]!;

    // At the top: the thumb fills the first two rows of the track.
    scrollTo(view, 0, 0);
    if (leaf.props.height !== 3) throw new Error(`leaf height = ${leaf.props.height}`);
    const topText = leaf.props.text;
    if (topText !== `${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_TRACK_CHAR}`) {
      throw new Error(`top scrollbar = ${JSON.stringify(topText)}`);
    }

    // Scrolled to the bottom (maxY = 2): the thumb drops to the last two
    // rows, and the `top` inset is scroll-compensated (thumbOffset 1 +
    // scroll_y 2).
    scrollTo(view, 0, 2);
    const bottomText = leaf.props.text;
    if (bottomText !== `${SCROLLBAR_TRACK_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}`) {
      throw new Error(`bottom scrollbar = ${JSON.stringify(bottomText)}`);
    }
    if (leaf.props.top !== 3) throw new Error(`leaf top = ${leaf.props.top}`);
  });
});

Deno.test("scroll helpers on a detached view throw (contentSize requires the scene)", () => {
  const view = ScrollView({ width: 5, height: 2 }, Text({ text: "x" }));
  let threw = false;
  try {
    scrollTo(view, 0, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("scrollTo on a detached view must throw");
});

Deno.test("removing a scroll view clears its scrollbar from the scene", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView({ width: 5, height: 2, showScrollbar: true }, Text({ text: "x" }));
    renderer.root.addChild(view);
    const leaf = view.children[1]!;
    if (!view.attached || !leaf.attached) throw new Error("view and scrollbar must attach");
    if (view.remove() !== true) throw new Error("remove must succeed");
    // The whole subtree detaches with the view: the scrollbar leaf is
    // cleared from the scene, and the view is spliced out of its parent.
    if (view.attached || leaf.attached) throw new Error("scrollbar must detach with the view");
    if (renderer.root.children.length !== 0) throw new Error("view must be spliced out of the scene");
  });
});

// ---------------------------------------------------------------------------
// StreamingText auto-scroll
//
// A streaming node with `autoScroll` (the default) follows its content tail:
// `syncStreamTail` pins `scroll_y` to the content height minus the clip
// viewport height. A manual scroll above the tail (via `scrollTo` / `scrollBy`
// / `scrollTop`) detaches the follow and pins the view; `followTail`
// re-attaches and snaps back. The fake addon's `content_size` measures the
// streamed spans verbatim (spans concatenate, one row per `\n`), so with
// newline-terminated spans and a `clip_height: 2` viewport, N spans put the
// content at N + 1 rows and the tail at N - 1.
// ---------------------------------------------------------------------------

Deno.test("StreamingText defaults to following the tail (scroll_y = content height - clip height)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    if (!isStreamFollowing(node)) throw new Error("autoScroll must default to following");
    // A fresh read per assertion — TS property-access narrowing would
    // otherwise reject a later comparison against a different literal.
    const y = (): number => node.props.scroll_y as number;
    // 3 newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);
    if (node.props.scroll_x !== undefined) {
      throw new Error(`scroll_x must stay unset, got ${node.props.scroll_x}`);
    }
    // The tail keeps moving as the stream grows (5 rows -> tail 3).
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 3) throw new Error(`scroll_y after 4 spans = ${y()}`);
    // The autoScroll key is consumed — never a scene prop.
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }
  });
});

Deno.test("StreamingText with autoScroll: false never follows the tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ autoScroll: false, clip_height: 2, width: 10 });
    if ("autoScroll" in node.props) {
      throw new Error(`autoScroll leaked into props: ${JSON.stringify(node.props)}`);
    }
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (isStreamFollowing(node)) throw new Error("autoScroll: false must not follow");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
  });
});

Deno.test("a manual scroll above the tail detaches the follow and pins the view", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    // A fresh read per assertion (see the tail-follow test).
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);

    // Scroll up above the tail: the follow detaches and the view pins.
    const applied = scrollTo(node, 0, 0);
    if (applied.x !== 0 || applied.y !== 0) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach the follow");

    // The stream keeps growing, but the view stays pinned at row 0.
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // scrollBy / scrollTop funnel through scrollTo and detach the same way.
    const by = scrollBy(node, 0, 1);
    if (by.y !== 1) throw new Error(`scrollBy applied = ${JSON.stringify(by)}`);
    const top = scrollTop(node);
    if (top.y !== 0) throw new Error(`scrollTop applied = ${JSON.stringify(top)}`);
    if (isStreamFollowing(node)) throw new Error("scrollBy/scrollTop above the tail must detach");
  });
});

Deno.test("followTail re-attaches and snaps back to the growing tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    scrollTo(node, 0, 0); // detach (pinned at row 0)
    node.appendSpan("d\n"); // 5 rows now; sync is a no-op while detached

    // Re-attach: followTail snaps straight to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach the follow");
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    node.appendSpan("e\n");
    syncStreamTail(node);
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    // A scroll to the tail keeps the follow attached (no detach).
    scrollTo(node, 0, 4);
    if (!isStreamFollowing(node)) throw new Error("scrolling to the tail must keep the follow");
  });
});

Deno.test("followTail on a plain streaming node enables auto-scroll from scratch", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Built through the raw Node factory — no follow state registered.
    const node = Node.create("streaming_text", { clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    node.appendSpan("a\n");
    node.appendSpan("b\n");
    node.appendSpan("c\n");
    syncStreamTail(node);
    if (isStreamFollowing(node)) throw new Error("a raw node must not follow by default");
    if (node.props.scroll_y !== undefined) {
      throw new Error(`raw node scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must enable a raw node's follow");
    // 4 rows - clip 2 = tail 2.
    if (node.props.scroll_y !== 2) throw new Error(`raw snap scroll_y = ${node.props.scroll_y}`);
  });
});

// ---------------------------------------------------------------------------
// StreamingText scroll-to-bottom affordance
//
// A manual scroll above the tail detaches the follow and stamps a small
// `▼` indicator leaf (a 1x1 text cell, absolutely positioned at the clip
// region's bottom-right with a z_index above in-flow content) so the user
// can see the stream is still growing above. `followTail` (re-attach) and
// `scrollToBottom` (a one-shot jump to the tail) dismiss it.
// ---------------------------------------------------------------------------

Deno.test("a manual scroll above the tail stamps the scroll-to-bottom affordance (dismissed by followTail)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // Fresh reads per assertion — TS property-access narrowing would otherwise
    // reject later comparisons against a different literal (see above).
    const count = (): number => node.children.length;
    // While following the tail there is no affordance (no children).
    if (count() !== 0) throw new Error(`following children = ${count()}`);

    // Scrolling above the tail detaches the follow and stamps the affordance
    // at the clip region's bottom-right: a 1x1 text cell with the ▼ char,
    // absolutely positioned, right-aligned, at the bottom row of the 2-row
    // viewport (top = clip 2 - 1 + scroll 0), above in-flow content.
    scrollTo(node, 0, 0);
    if (isStreamFollowing(node)) throw new Error("a scroll above the tail must detach the follow");
    if (count() !== 1) throw new Error(`affordance children = ${count()}`);
    const leaf = node.children[0]!;
    if (leaf.type !== "text") throw new Error(`affordance type = ${leaf.type}`);
    if (leaf.props.text !== STREAM_AFFORDANCE_CHAR) {
      throw new Error(`affordance text = ${JSON.stringify(leaf.props.text)}`);
    }
    if (leaf.props.position !== "absolute" || leaf.props.right !== 0) {
      throw new Error(`affordance position = ${JSON.stringify(leaf.props)}`);
    }
    if (leaf.props.width !== 1 || leaf.props.height !== 1) {
      throw new Error(`affordance size = ${JSON.stringify(leaf.props)}`);
    }
    if (leaf.props.z_index !== 2) throw new Error(`affordance z_index = ${leaf.props.z_index}`);
    const top = (): number => leaf.props.top as number;
    if (top() !== 1) throw new Error(`affordance top = ${top()}`);

    // The cell stays fixed at the viewport's bottom row as the content
    // scrolls: the `top` inset is scroll-compensated (clip 2 - 1 + scroll 1).
    scrollTo(node, 0, 1);
    if (top() !== 2) throw new Error(`compensated top = ${top()}`);

    // Further scrolls while detached keep a single affordance leaf (no dup).
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`re-scroll children = ${count()}`);

    // followTail re-attaches, snaps back to the tail, and dismisses the
    // affordance.
    followTail(node);
    if (!isStreamFollowing(node)) throw new Error("followTail must re-attach the follow");
    if (count() !== 0) throw new Error(`affordance after followTail = ${count()}`);
    if (node.props.scroll_y !== 2) throw new Error(`snap scroll_y = ${node.props.scroll_y}`);
  });
});

Deno.test("scrollToBottom jumps to the tail and dismisses the affordance (without re-attaching)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // Fresh read per assertion (see the tail-follow tests above).
    const count = (): number => node.children.length;
    // Detach (stamps the affordance), then the stream grows while detached.
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`affordance children = ${count()}`);
    node.appendSpan("d\n"); // 5 rows now; sync is a no-op while detached
    syncStreamTail(node);
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // scrollToBottom: a one-shot jump to the current tail (5 - 2 = 3) and
    // the affordance is dismissed; the follow stays detached.
    const applied = scrollToBottom(node);
    if (applied.x !== 0 || applied.y !== 3) throw new Error(`applied = ${JSON.stringify(applied)}`);
    if (y() !== 3) throw new Error(`scrollToBottom scroll_y = ${y()}`);
    if (count() !== 0) throw new Error(`affordance after scrollToBottom = ${count()}`);
    if (isStreamFollowing(node)) throw new Error("scrollToBottom must not re-attach the follow");

    // Growth after the one-shot jump does not pin the view (still detached).
    node.appendSpan("e\n"); // 6 rows now; the view stays at the old tail
    syncStreamTail(node);
    if (y() !== 3) throw new Error(`post-jump scroll_y = ${y()}`);

    // The next scroll above the tail re-stamps the affordance.
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`re-show children = ${count()}`);
    if (y() !== 0) throw new Error(`re-scroll scroll_y = ${y()}`);
  });
});

Deno.test("autoScroll: false nodes never stamp the affordance on a manual scroll", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ autoScroll: false, clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // A manual scroll above the tail never follows, so there is no follow to
    // detach and no affordance to show.
    scrollTo(node, 0, 0);
    if (node.children.length !== 0) throw new Error(`children = ${node.children.length}`);
    if (isStreamFollowing(node)) throw new Error("autoScroll: false must stay detached");
  });
});

// ---------------------------------------------------------------------------
// Mouse wheel scroll + click-to-focus
//
// `wheelScroll` maps terminal wheel events (`scroll_up` / `scroll_down` /
// `scroll_left` / `scroll_right`) onto a scrollable node's offsets via
// `scrollBy` (consumed = a wheel event on a scrollable node; clamping and
// no-ops follow the scroll helpers). `focusAt` routes a `down_left` press on
// a painted cell (the fake `hit_test` path, configurable via `fakeHitPath`)
// to the topmost registered focusable node through the `FocusManager`
// (`focusIdFor` + `focus`).
// ---------------------------------------------------------------------------

/** A `ScrollView` with a 5x2 viewport and a 6x3 content leaf attached under a
 * fresh renderer over the fake addon: both axes can scroll (max offsets
 * (1, 1)). Returns the renderer and the attached view. */
function makeScrollable(): { renderer: Renderer; view: Node } {
  const renderer = createRenderer();
  const view = ScrollView(
    { width: 5, height: 2, showScrollbar: true },
    Text({ text: "aaaaaa\nbbbbb\ncc" }),
  );
  renderer.root.addChild(view);
  fakeContentSizes.set(view.handle, { width: 5, height: 2 });
  const leaf = view.children.find((child) => child.type === "text");
  if (leaf === undefined) throw new Error("scroll view must compose a content leaf");
  fakeContentSizes.set(leaf.handle, { width: 6, height: 3 });
  return { renderer, view };
}

Deno.test("wheelScroll maps wheel directions onto the scroll offsets (consumed)", () => {
  withFakeAddon(() => {
    const { view } = makeScrollable();
    const y = (): number => view.props.scroll_y as number;
    const x = (): number => view.props.scroll_x as number;

    // scroll_down pans the content down (scroll_y + 1).
    if (wheelScroll(view, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("scroll_down on a scrollable node must be consumed");
    }
    if (y() !== 1) throw new Error(`scroll_down scroll_y = ${y()}`);
    // scroll_up pans the content back up (scroll_y - 1).
    if (wheelScroll(view, mouse("scroll_up", 0, 0)) !== true) {
      throw new Error("scroll_up on a scrollable node must be consumed");
    }
    if (y() !== 0) throw new Error(`scroll_up scroll_y = ${y()}`);
    // scroll_right pans the columns (scroll_x + 1).
    if (wheelScroll(view, mouse("scroll_right", 0, 0)) !== true) {
      throw new Error("scroll_right on a scrollable node must be consumed");
    }
    if (x() !== 1) throw new Error(`scroll_right scroll_x = ${x()}`);
    // scroll_left pans the columns back (scroll_x - 1).
    if (wheelScroll(view, mouse("scroll_left", 0, 0)) !== true) {
      throw new Error("scroll_left on a scrollable node must be consumed");
    }
    if (x() !== 0) throw new Error(`scroll_left scroll_x = ${x()}`);
  });
});

Deno.test("wheelScroll clamps at the content bounds but stays consumed", () => {
  withFakeAddon(() => {
    const { view } = makeScrollable();
    // maxScroll.y = content 3 - viewport 2 = 1: two downs clamp at 1.
    wheelScroll(view, mouse("scroll_down", 0, 0));
    wheelScroll(view, mouse("scroll_down", 0, 0));
    if (view.props.scroll_y !== 1) throw new Error(`clamped scroll_y = ${view.props.scroll_y}`);
    // A wheel at the bound is still consumed — it did not fall through.
    if (wheelScroll(view, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel event at the scroll bound must stay consumed");
    }
    if (view.props.scroll_y !== 1) throw new Error(`post-clamp scroll_y = ${view.props.scroll_y}`);
  });
});

Deno.test("wheelScroll no-ops on non-scrollable nodes, detached views and non-wheel events", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const plain = Box();
    renderer.root.addChild(plain);
    if (wheelScroll(plain, mouse("scroll_down", 0, 0)) !== false) {
      throw new Error("a plain box must not consume a wheel event");
    }
    const detached = ScrollView({ width: 5, height: 2 }, Text({ text: "aaaa\nbbbb\ncc" }));
    if (wheelScroll(detached, mouse("scroll_down", 0, 0)) !== false) {
      throw new Error("a detached view must not consume a wheel event");
    }
    const { view } = makeScrollable();
    if (wheelScroll(view, mouse("down_left", 0, 0)) !== false) {
      throw new Error("a down_left is not a wheel event and must not be consumed");
    }
  });
});

Deno.test("wheelScroll on a table scrolls its content region (sticky header pinned)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const table = Table({
      columns: [{ key: "a", header: "A", width: 4 }],
      rows: [["1"], ["2"], ["3"], ["4"]],
      clip_height: 3,
    });
    renderer.root.addChild(table);
    // The region's viewport is its clip_height (3). The content region is
    // windowed — only the visible rows are materialized — so the scroll clamp
    // measures the JS-known full content height (4 rows): maxScroll.y =
    // 4 - 3 = 1.
    const region = table.children[1]!;
    if (region.children.length !== 3) throw new Error(`windowed rows = ${region.children.length}`);

    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel event on a table must be consumed");
    }
    // Read through a function: TS control-flow narrowing would otherwise pin
    // the prop to the literal of the first assertion.
    const regionY = (): number => region.props.scroll_y as number;
    if (regionY() !== 1) throw new Error(`region scroll_y = ${regionY()}`);
    if (table.props.scroll_y !== undefined) {
      throw new Error("the table root must not scroll (the sticky header stays pinned)");
    }
    // A second wheel clamps at the full-content bound (max 1) and stays
    // consumed.
    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel event at the table's scroll bound must stay consumed");
    }
    if (regionY() !== 1) throw new Error(`clamped region scroll_y = ${regionY()}`);
  });
});

Deno.test("focusAt focuses the topmost registered node on a down_left press", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const first = Box();
    const second = Box();
    renderer.root.addChild(first);
    renderer.root.addChild(second);
    useFocus("second", second, () => {}, manager);
    useFocus("first", first, () => {}, manager);
    // The fake hit path is non-empty (the press lands on a painted cell); the
    // walk resolves the first registered focusable in paint order.
    if (focusAt(renderer, mouse("down_left", 3, 2), manager) !== true) {
      throw new Error("a down_left on a painted cell must be consumed");
    }
    if (manager.activeId !== "first") throw new Error(`active = ${manager.activeId}`);
  });
});

Deno.test("focusAt no-ops on a press off any painted cell (empty hit_test)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const node = Box();
    renderer.root.addChild(node);
    useFocus("probe", node, () => {}, manager);
    fakeHitPath = [];
    if (focusAt(renderer, mouse("down_left", 0, 0), manager) !== false) {
      throw new Error("a press off any painted cell must not be consumed");
    }
    if (manager.activeId !== null) throw new Error(`active = ${manager.activeId}`);
  });
});

Deno.test("focusAt no-ops on non-down_left events and on hits with no registered node", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const node = Box();
    renderer.root.addChild(node);
    const handle = useFocus("probe", node, () => {}, manager);
    // A wheel event is not a press: never routed.
    if (focusAt(renderer, mouse("scroll_down", 0, 0), manager) !== false) {
      throw new Error("a non-down_left event must not be consumed");
    }
    handle.dispose();
    // The press lands on a painted cell, but no node is registered: no-op.
    if (focusAt(renderer, mouse("down_left", 0, 0), manager) !== false) {
      throw new Error("a press on a cell with no registered node must not be consumed");
    }
    if (manager.activeId !== null) throw new Error(`active = ${manager.activeId}`);
  });
});

Deno.test("focusAt defaults to the shared focusManager", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const node = Box();
    renderer.root.addChild(node);
    const handle = useFocus("shared", node, () => {});
    if (focusAt(renderer, mouse("down_left", 0, 0)) !== true) {
      throw new Error("a down_left must be consumed by the default focus manager");
    }
    if (focusManager.activeId !== "shared") throw new Error(`active = ${focusManager.activeId}`);
    handle.dispose();
    focusManager.blur();
  });
});

// ---------------------------------------------------------------------------
// Mouse selection (viewport-cell-scoped v1)
//
// The selection module drives the renderer's native selection overlay
// (subtask 1) from mouse events: `down_left` starts a session (a double-click
// within SELECTION_DOUBLE_CLICK_MS ms / one cell selects the word),
// `drag_left` moves the active endpoint, any `up_*` ends the session with
// clear-on-release. copySelection pushes the selection text to the clipboard;
// selectionKey binds ctrl+shift+c (plain ctrl+c stays unconsumed).
//
// Scenes are the fake painter's canonical single-row "hello world" (11x1, or
// 11x2 for the multi-row '\n' join) painted via `snapshotFrame` so the fake
// `selection_text` / `selection_word_range` read real painted rows.
// ---------------------------------------------------------------------------

/** Assert the fake native renderer's selection overlay equals `expected`
 * (or is `null` when the selection must be cleared). */
function assertSelection(
  expected: { col1: number; row1: number; col2: number; row2: number } | null,
): void {
  const native = lastFakeRenderer;
  if (native === null) throw new Error("fake renderer not constructed");
  const actual = native.selection;
  if (expected === null) {
    if (actual !== null) throw new Error(`selection = ${JSON.stringify(actual)}, expected null`);
    return;
  }
  if (actual === null) throw new Error(`selection = null, expected ${JSON.stringify(expected)}`);
  if (
    actual.col1 !== expected.col1 || actual.row1 !== expected.row1 ||
    actual.col2 !== expected.col2 || actual.row2 !== expected.row2
  ) {
    throw new Error(`selection = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

Deno.test("selection drag state machine: down starts, drag extends, up ends", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1); // paint the frame selection_text reads

    // A non-down_left event never starts a session.
    if (startSelection(renderer, mouse("drag_left", 2, 0)) !== null) {
      throw new Error("drag_left must not start a selection");
    }

    // down_left starts the session anchored at the pressed cell.
    const started = startSelection(renderer, mouse("down_left", 2, 0));
    if (started === null) throw new Error("down_left must start a selection");
    if (started.col1 !== 2 || started.row1 !== 0 || started.col2 !== 2 || started.row2 !== 0) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }
    assertSelection({ col1: 2, row1: 0, col2: 2, row2: 0 });

    // drag_left moves the active endpoint, keeping the anchor fixed.
    const r1 = dragSelection(renderer, mouse("drag_left", 5, 0));
    if (r1 === null || r1.col1 !== 2 || r1.row1 !== 0 || r1.col2 !== 5 || r1.row2 !== 0) {
      throw new Error(`drag 1 = ${JSON.stringify(r1)}`);
    }
    assertSelection({ col1: 2, row1: 0, col2: 5, row2: 0 });

    // Dragging above/left of the anchor still spans the rect (the native
    // overlay normalizes the endpoints).
    const r2 = dragSelection(renderer, mouse("drag_left", 0, 0));
    if (r2 === null || r2.col1 !== 2 || r2.row1 !== 0 || r2.col2 !== 0 || r2.row2 !== 0) {
      throw new Error(`drag 2 = ${JSON.stringify(r2)}`);
    }

    // up_left ends the session and returns the last rect.
    const ended = endSelection(renderer, mouse("up_left", 0, 0));
    if (ended === null || ended.col1 !== 2 || ended.row1 !== 0 || ended.col2 !== 0 || ended.row2 !== 0) {
      throw new Error(`ended = ${JSON.stringify(ended)}`);
    }

    // After the release a drag_left is inert, and end without a session is a
    // no-op.
    if (dragSelection(renderer, mouse("drag_left", 7, 0)) !== null) {
      throw new Error("a drag after up_left must be a no-op");
    }
    if (endSelection(renderer, mouse("up_left", 7, 0)) !== null) {
      throw new Error("end without a session must return null");
    }
    renderer.destroy();
  });
});

Deno.test("a double-click within 500ms and one cell selects the word; slower or farther presses do not", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    if (SELECTION_DOUBLE_CLICK_MS !== 500) {
      throw new Error(`SELECTION_DOUBLE_CLICK_MS = ${SELECTION_DOUBLE_CLICK_MS}`);
    }

    // Two presses on the same cell within the window: word select.
    setSelectionClockForTesting(() => 1000);
    startSelection(renderer, mouse("down_left", 6, 0)); // 'w' of "world"
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 1400); // +400 ms, inside the window
    const word = startSelection(renderer, mouse("down_left", 6, 0));
    if (word === null || word.col1 !== 6 || word.row1 !== 0 || word.col2 !== 10 || word.row2 !== 0) {
      throw new Error(`word double-click = ${JSON.stringify(word)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });
    endSelection(renderer, mouse("up_left", 6, 0));

    // A press more than 500 ms after the previous one is a fresh selection.
    setSelectionClockForTesting(() => 2000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 2600); // +600 ms, outside the window
    const late = startSelection(renderer, mouse("down_left", 6, 0));
    if (late === null || late.col1 !== 6 || late.col2 !== 6) {
      throw new Error(`late press = ${JSON.stringify(late)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 6, row2: 0 });
    endSelection(renderer, mouse("up_left", 6, 0));

    // A press two cells away is not a double-click even inside the window.
    setSelectionClockForTesting(() => 3000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 3300); // +300 ms, but 2 cells away
    const far = startSelection(renderer, mouse("down_left", 8, 0));
    if (far === null || far.col1 !== 8 || far.col2 !== 8) {
      throw new Error(`far press = ${JSON.stringify(far)}`);
    }
    assertSelection({ col1: 8, row1: 0, col2: 8, row2: 0 });
    endSelection(renderer, mouse("up_left", 8, 0));

    // A press one cell away IS a double-click (the <= 1 cell bound).
    setSelectionClockForTesting(() => 4000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 4200); // +200 ms, 1 cell away
    const adjacent = startSelection(renderer, mouse("down_left", 7, 0));
    if (adjacent === null || adjacent.col1 !== 6 || adjacent.col2 !== 10) {
      throw new Error(`adjacent double-click = ${JSON.stringify(adjacent)}`);
    }
    endSelection(renderer, mouse("up_left", 7, 0));

    // A double-click on whitespace falls back to the 1-cell selection.
    setSelectionClockForTesting(() => 5000);
    startSelection(renderer, mouse("down_left", 5, 0)); // the space
    endSelection(renderer, mouse("up_left", 5, 0));
    setSelectionClockForTesting(() => 5200);
    const space = startSelection(renderer, mouse("down_left", 5, 0));
    if (space === null || space.col1 !== 5 || space.col2 !== 5) {
      throw new Error(`whitespace double-click = ${JSON.stringify(space)}`);
    }
    assertSelection({ col1: 5, row1: 0, col2: 5, row2: 0 });
    endSelection(renderer, mouse("up_left", 5, 0));

    setSelectionClockForTesting(() => Date.now());
    renderer.destroy();
  });
});

Deno.test("selection text round-trips: the drag-selected rect extracts the covered text", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    if (renderer.selectionText() !== "world") {
      throw new Error(`selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }

    // Dragging beyond the text clips at the frame's spaces.
    dragSelection(renderer, mouse("drag_left", 12, 0));
    if (renderer.selectionText() !== "world  ") {
      throw new Error(`clipped selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    renderer.destroy();
  });
});

Deno.test("a drag onto a second row joins the selection text with a newline", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 2); // row 1 is empty (spaces)

    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 1));
    // Rect cols 0-4, rows 0-1: "hello" over the painted row, then a row of
    // five spaces — rows are joined with '\n'.
    if (renderer.selectionText() !== "hello\n     ") {
      throw new Error(`two-row selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }
    renderer.destroy();
  });
});

Deno.test("copySelection pushes the selection text to the clipboard", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    // Read through a function: TS control-flow narrowing would otherwise pin
    // `lastClipboard` to the literal of the first assertion below.
    const clipboard = (): string | null => lastClipboard;

    // No selection set: copies the empty string.
    copySelection(renderer);
    if (clipboard() !== "") {
      throw new Error(`empty copy = ${JSON.stringify(clipboard())}`);
    }

    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 0));
    copySelection(renderer);
    if (clipboard() !== "hello") {
      throw new Error(`copy = ${JSON.stringify(clipboard())}`);
    }
    renderer.destroy();
  });
});

Deno.test("endSelection clears the selection overlay on release (clear-on-release)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    // Active during the gesture.
    if (renderer.selectionText() !== "world") {
      throw new Error(`active selectionText = ${JSON.stringify(renderer.selectionText())}`);
    }

    // The release ends the session AND clears the overlay: no reversed cells
    // survive the gesture.
    if (endSelection(renderer, mouse("up_left", 10, 0)) === null) {
      throw new Error("up_left must end the selection");
    }
    if (renderer.selectionText() !== "") {
      throw new Error(`selectionText after release = ${JSON.stringify(renderer.selectionText())}`);
    }
    assertSelection(null);
    renderer.destroy();
  });
});

Deno.test("selectionKey copies on ctrl+shift+c and leaves plain ctrl+c (exit) unconsumed", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 0));

    // ctrl+shift+c copies the active selection text.
    if (selectionKey(renderer, { name: "char", char: "c", ctrl: true, alt: false, shift: true }) !== true) {
      throw new Error("ctrl+shift+c must be consumed");
    }
    if (lastClipboard !== "hello") {
      throw new Error(`copy = ${JSON.stringify(lastClipboard)}`);
    }

    // Plain ctrl+c is the exit convention: never consumed by the selection
    // handler, so the exit binding still sees it.
    if (selectionKey(renderer, { name: "char", char: "c", ctrl: true, alt: false, shift: false }) !== false) {
      throw new Error("plain ctrl+c must not be consumed");
    }
    // Other keys are not consumed.
    if (selectionKey(renderer, { name: "char", char: "v", ctrl: true, alt: false, shift: false }) !== false) {
      throw new Error("ctrl+v must not be consumed");
    }
    renderer.destroy();
  });
});

Deno.test("selectWordAt applies the word range or leaves the selection untouched at whitespace", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    const range = selectWordAt(renderer, 7, 0);
    if (range === null || range.col1 !== 6 || range.row1 !== 0 || range.col2 !== 10 || range.row2 !== 0) {
      throw new Error(`word = ${JSON.stringify(range)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });

    // Whitespace: null, and the selection is left untouched.
    if (selectWordAt(renderer, 5, 0) !== null) {
      throw new Error("whitespace must yield null");
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });
    renderer.destroy();
  });
});
