//! The fake napi addon every core test runs against.

import { Node, NodeHandle, Renderer, SceneSemanticsJs, SelectionRange, StyleRunJs, TernAddon, TernEventJs, TuiRenderer, setAddonForTesting } from "../index.ts";

/** The last `FakeTuiRenderer` constructed (via the fake addon), or `null`.
 * Tests read its `renderCalls` to assert native render counts. */
let lastFakeRenderer: FakeTuiRenderer | null = null;
/** The last `(width, height)` passed to the fake
 * `render_to_buffer_styled`, or `null` when the styled snapshot method was
 * never called. */
let lastStyledSnapshotSize: [number | undefined, number | undefined] | null =
  null;
/** The last `(width, height)` passed to the fake `render_to_buffer`, or
 * `null` when the snapshot method was never called. */
let lastSnapshotSize: [number | undefined, number | undefined] | null = null;
/** The last options passed to the fake `TuiRenderer` constructor, or `null`. */
let lastRendererOptions: unknown = null;
/** The last text passed to the fake `set_clipboard`, or `null`. */
let lastClipboard: string | null = null;
/** The last title passed to the fake `set_title`, or `null`. */
let lastSetTitle: string | null = null;
/** The path returned by the fake `hit_test` (override for the click-to-focus
 * tests — an empty path models a press off any painted cell). */
let fakeHitPath: bigint[] = [7n, 3n];
/** The last `(col, row)` passed to the fake `hit_test`, or `null`. */
let lastHitTest: [number, number] | null = null;
/** The push callback registered by the fake `start_event_stream` (the
 * Renderer constructor registers it; tests feed events through it). */
let streamCallback: ((err: Error | null, event: TernEventJs) => void) | null =
  null;
export const state = {
  get streamCallback() {
    return streamCallback;
  },
  set streamCallback(value) {
    streamCallback = value;
  },
  get lastHitTest() {
    return lastHitTest;
  },
  set lastHitTest(value) {
    lastHitTest = value;
  },
  get fakeHitPath() {
    return fakeHitPath;
  },
  set fakeHitPath(value) {
    fakeHitPath = value;
  },
  get lastSetTitle() {
    return lastSetTitle;
  },
  set lastSetTitle(value) {
    lastSetTitle = value;
  },
  get lastClipboard() {
    return lastClipboard;
  },
  set lastClipboard(value) {
    lastClipboard = value;
  },
  get lastRendererOptions() {
    return lastRendererOptions;
  },
  set lastRendererOptions(value) {
    lastRendererOptions = value;
  },
  get lastSnapshotSize() {
    return lastSnapshotSize;
  },
  set lastSnapshotSize(value) {
    lastSnapshotSize = value;
  },
  get lastStyledSnapshotSize() {
    return lastStyledSnapshotSize;
  },
  set lastStyledSnapshotSize(value) {
    lastStyledSnapshotSize = value;
  },
  get lastFakeRenderer() {
    return lastFakeRenderer;
  },
  set lastFakeRenderer(value) {
    lastFakeRenderer = value;
  },
};

/** The native node types materialized through the fake `create_node`. */
export const createdNodes: Array<
  { type: string; props: Record<string, unknown> | null }
> = [];

/** Per-handle `content_size` overrides for the panel-drag geometry tests
 * (keyed by the `FakeNodeHandle` instance backing the node). */
export const fakeContentSizes = new Map<object, { width: number; height: number }>();

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
export class FakeNodeHandle {
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
  /** The semantics writes recorded via `set_semantics`, in call order (the
   * M4.1 surface — the fake stands in for the native store writes). */
  readonly semanticsWrites: unknown[] = [];
  set_semantics(node: unknown): void {
    this.semanticsWrites.push(node);
  }
  clear_semantics(): void {}
  remove(): boolean {
    return true;
  }
}

/** A fake native `TuiRenderer` standing in for the real addon. */
export class FakeTuiRenderer {
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
  selection: { col1: number; row1: number; col2: number; row2: number } | null =
    null;
  /** The rows of the last painted frame (a `render` or `render_to_buffer`
   * snapshot), the fake's stand-in for the native retained buffer that
   * `selection_text` / `selection_word_range` read. */
  lastRows: string[] | null = null;
  /** The scene root handle, reused across `root()` calls so the scene the
   * `Renderer` builds is captured for `render_to_buffer`. */
  private rootHandle = new FakeNodeHandle("root", {});
  constructor(options: unknown) {
    state.lastRendererOptions = options;
    state.lastFakeRenderer = this;
  }
  root(): NodeHandle {
    return this.rootHandle as unknown as NodeHandle;
  }
  start_event_stream(
    callback: (err: Error | null, event: TernEventJs) => void,
  ): void {
    state.streamCallback = callback;
  }
  hit_test(col: number, row: number): bigint[] {
    state.lastHitTest = [col, row];
    return state.fakeHitPath;
  }
  render(): void {
    this.renderCalls++;
    // A render paints at the current terminal size — the fake's fixed one —
    // so the last painted viewport resets to it (mirrors the real renderer
    // probing the terminal on each paint).
    this.size = { ...FAKE_TERMINAL_SIZE };
    // Record the frame a render paints, so `selection_text` reads the last
    // painted frame (the real renderer retains the painted buffer).
    this.lastRows = paintSceneRows(
      this.rootHandle,
      this.size.width,
      this.size.height,
    );
  }
  render_to_buffer(width?: number, height?: number): string[] {
    state.lastSnapshotSize = [width, height];
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
    state.lastStyledSnapshotSize = [width, height];
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
  /** The terminal's capabilities the fake reports: the backend color report
   * merged with the interactive probe report (a kitty-style terminal that
   * answered every query), mirroring the real `capabilities` getter. */
  capabilities = {
    truecolor: true,
    colors: 16_777_216,
    terminalIdentity: "kitty(0.36.0)",
    kittyKeyboard: true,
    kittyUnderline: true,
    osc52: true,
    bracketedPaste: true,
    focusEvents: true,
    scrollRegion: true,
    probed: true,
  };
  set_title(title: string): void {
    state.lastSetTitle = title;
  }
  set_clipboard(text: string): void {
    state.lastClipboard = text;
  }
  /** The flat semantics dump (the M4.1 surface). The fake's store is the
   * per-handle `semanticsWrites` records; the renderer-level dump mirrors
   * the native read-back, which never throws. */
  semantics(): SceneSemanticsJs[] {
    return [];
  }
  /** The `set_any_event_mouse` calls recorded by the fake, in call order
   * (the 1003 any-event toggle the `onMouse` listener count drives). */
  anyEventMouseCalls: boolean[] = [];
  set_any_event_mouse(enabled: boolean): void {
    this.anyEventMouseCalls.push(enabled);
  }
  set_selection(col1: number, row1: number, col2: number, row2: number): void {
    this.selection = { col1, row1, col2, row2 };
  }
  clear_selection(): void {
    this.selection = null;
  }
  /** The renderer's caret override: `{ x, y, shape, visible, blink }` in
   * native terms, or `null` when no cursor is set (the legacy position-only
   * flush). Mirrors the real per-renderer cursor state. */
  cursor: {
    x: number;
    y: number;
    shape: string;
    visible: boolean;
    blink: boolean;
  } | null = null;
  set_cursor(
    x: number,
    y: number,
    shape: string,
    visible: boolean,
    blink: boolean,
  ): void {
    this.cursor = { x, y, shape, visible, blink };
  }
  clear_cursor(): void {
    this.cursor = null;
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
 *
 * A box paints its text children as a flex column — child `i` on content row
 * `i` (plus `padding`) — so a multi-leaf composition (the canvas element's
 * braille rows) stacks like the real compositor; a single-child box keeps
 * the original origin-row geometry.
 */
function paintSceneRows(
  root: FakeNodeHandle,
  width: number | undefined,
  height: number | undefined,
): string[] {
  const w = width ?? 6;
  const h = height ?? 3;
  const glyphs: Record<
    string,
    readonly [string, string, string, string, string, string]
  > = {
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
        // A box paints its text children as a flex column: child `ti` paints
        // content row `pad + ti` (borderless: row `ti`), so a multi-leaf
        // composition — the canvas element's braille rows, a bare flex column
        // — stacks like the real compositor. A single-child box (every legacy
        // golden) paints exactly as before (row `pad` / row 0).
        const pad = typeof child.props.padding === "number"
          ? child.props.padding
          : 0;
        child.children.forEach((textChild, ti) => {
          const text = typeof textChild?.props.text === "string"
            ? textChild.props.text
            : "";
          const runs = fakeClusterRuns(text);
          const innerWidth = runs.reduce((sum, run) => sum + run.width, 0);
          const bw = innerWidth + 2 * pad;
          const bh = child.children.length + 2 * pad;
          const contentRow = pad + ti;
          if (x < bw && y < bh) {
            const g = glyphs[String(child.props.border_style ?? "none")];
            let c = " ";
            if (g !== undefined) {
              if (y === 0) c = x === 0 ? g[0] : x === bw - 1 ? g[1] : g[4];
              else if (y === bh - 1) {
                c = x === 0 ? g[2] : x === bw - 1 ? g[3] : g[4];
              } else c = x === 0 || x === bw - 1 ? g[5] : " ";
            }
            if (
              g !== undefined && y === contentRow && x >= pad &&
              x < pad + innerWidth
            ) {
              c = clusterTextAt(runs, x - pad);
            } else if (g === undefined && y === ti && x < innerWidth) {
              // A borderless leaf (bare text / textarea / input / canvas)
              // paints its text children's clusters from the origin.
              c = clusterTextAt(runs, x);
            }
            if (c !== " ") ch = c;
          }
        });
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
  /** The underline style variant keyword, when the leaf's props carry an
   * `underline_style` style key — the fake's mirror of the engine threading
   * `underline_style` into the style's variant and the styled snapshot
   * surfacing it as `underlineStyle`. */
  underlineStyle?: string;
  /** The underline color, when the leaf's props carry an `underline_color`
   * style key — the fake's mirror of the engine threading `underline_color`
   * into the style's underline color and the styled snapshot surfacing it as
   * `underlineColor`. */
  underlineColor?: string;
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
  // Same for the underline aliases: the JS layer translates camelCase
  // `underlineStyle` / `underlineColor` to the scene-facing
  // `underline_style` / `underline_color` keys, which the fake lifts.
  if (typeof p.underline_style === "string") {
    style.underlineStyle = p.underline_style;
  }
  if (typeof p.underline_color === "string") {
    style.underlineColor = p.underline_color;
  }
  return Object.keys(style).length === 0 ? null : style;
}

/** Whether two styled runs carry the same style — the merge rule behind
 * `render_to_buffer_styled` ("adjacent cells with identical style merge
 * into one run"), so `text` is excluded: the running run's text extends
 * instead of opening a new run. `hyperlink` participates like the other
 * fields — mirroring the engine's style equality, where a hyperlink change
 * splits runs at the link boundary — and so do `underlineStyle` /
 * `underlineColor`: a variant or colored-underline change splits runs at
 * the underline boundary. */
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
    a.hyperlink === b.hyperlink &&
    a.underlineStyle === b.underlineStyle &&
    a.underlineColor === b.underlineColor
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
  const glyphs: Record<
    string,
    readonly [string, string, string, string, string, string]
  > = {
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
        // The styled twin of `paintSceneRows`' stacking: text child `ti`
        // paints content row `pad + ti` (borderless: row `ti`), so a
        // multi-leaf composition stacks like the real compositor; a
        // single-child box keeps the original geometry.
        const pad = typeof child.props.padding === "number"
          ? child.props.padding
          : 0;
        child.children.forEach((textChild, ti) => {
          const text = typeof textChild?.props.text === "string"
            ? textChild.props.text
            : "";
          const runs = fakeClusterRuns(text);
          const innerWidth = runs.reduce((sum, run) => sum + run.width, 0);
          const bw = innerWidth + 2 * pad;
          const bh = child.children.length + 2 * pad;
          const contentRow = pad + ti;
          if (x < bw && y < bh) {
            const g = glyphs[String(child.props.border_style ?? "none")];
            let c = " ";
            if (g !== undefined) {
              if (y === 0) c = x === 0 ? g[0] : x === bw - 1 ? g[1] : g[4];
              else if (y === bh - 1) {
                c = x === 0 ? g[2] : x === bw - 1 ? g[3] : g[4];
              } else c = x === 0 || x === bw - 1 ? g[5] : " ";
            }
            if (
              g !== undefined && c !== " " &&
              !(y === contentRow && x >= pad && x < pad + innerWidth)
            ) {
              // A `border_color` on the box paints its border glyphs with that
              // color as their fg (the real compositor swaps the cell style's
              // fg — see paint_box), so the styled runs report it; interior and
              // content cells keep their own styles.
              const borderColor = child.props.border_color;
              if (typeof borderColor === "string") style = { fg: borderColor };
            }
            if (
              g !== undefined && y === contentRow && x >= pad &&
              x < pad + innerWidth
            ) {
              c = clusterTextAt(runs, x - pad);
              style = leafStyle(textChild);
            } else if (g === undefined && y === ti && x < innerWidth) {
              // A borderless leaf (bare text / textarea / input / canvas)
              // paints its text children's clusters from the origin, styled.
              c = clusterTextAt(runs, x);
              style = leafStyle(textChild);
            }
            if (c !== " ") ch = c;
          }
        });
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
export function withFakeAddon<T>(fn: () => T): T {
  state.streamCallback = null;
  state.lastHitTest = null;
  state.fakeHitPath = [7n, 3n];
  createdNodes.length = 0;
  fakeContentSizes.clear();
  state.lastSetTitle = null;
  state.lastClipboard = null;
  state.lastRendererOptions = null;
  state.lastSnapshotSize = null;
  state.lastStyledSnapshotSize = null;
  state.lastFakeRenderer = null;
  setAddonForTesting(fakeAddon);
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => {
      setAddonForTesting(null);
      state.streamCallback = null;
    }) as T;
  }
  setAddonForTesting(null);
  state.streamCallback = null;
  return result;
}

/** Drain the macrotask queue (a `setTimeout(0)` round-trip): lets a
 * coalesced frame scheduled via `requestFrame` fire before the test asserts. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Feed `event` to the renderer's push callback (the fake's
 * `start_event_stream`), dispatching it like the native loop would. */
export function pushEvent(event: TernEventJs): void {
  const callback = state.streamCallback;
  if (callback === null) throw new Error("no stream callback registered");
  callback(null, event);
}

/** The fake native handle backing an attached `Node`, or `null` when the
 * node is detached. */
export function fakeHandleOf(node: Node): FakeNodeHandle | null {
  return node.attached ? (node.handle as unknown as FakeNodeHandle) : null;
}
