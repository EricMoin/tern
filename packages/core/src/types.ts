//! The shared prop and handler vocabulary every element speaks.

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
/**
 * The scene node kinds. `box`/`text`/`streaming_text` are materialized by the
 * binding; `input`/`textarea`/`spinner`/`status_bar`/`panels`/`diff`/`select`/
 * `checkbox`/`radio`/`toggle`/`menu`/`scroll_view`/`table`/`tree`/`tabs`/
 * `progress`/`modal`/`markdown`/`canvas`/`bar_chart`/`chart`/`sparkline` are
 * JS-only element kinds that materialize as compositions over the primitive
 * kinds (their root primitive is fixed by {@link NATIVE_KIND}).
 */
export type NodeType =
  | "box"
  | "text"
  | "streaming_text"
  | "input"
  | "textarea"
  | "spinner"
  | "status_bar"
  | "panels"
  | "diff"
  | "select"
  | "checkbox"
  | "radio"
  | "toggle"
  | "menu"
  | "scroll_view"
  | "table"
  | "tree"
  | "tabs"
  | "progress"
  | "modal"
  | "markdown"
  | "canvas"
  | "bar_chart"
  | "chart"
  | "sparkline";

/**
 * Props for a scene node. Style keys (`fg`, `bg`, `border_color`, the boolean
 * modifiers) are lifted into the node's style by the binding; every other key
 * lands in the node's property map (`text`, layout keywords such as `width`,
 * `height`, `padding`, `flex_direction`, ...). Property values must be JSON
 * scalars (string/number/boolean) — the binding drops arrays and objects.
 */
export interface NodeProps {
  /** The text content of a `text` node. */
  text?: string;
  // Layout keywords (tern-components).
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  width?: number | `${number}%`;
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  height?: number | `${number}%`;
  padding?: number;
  padding_x?: number;
  padding_y?: number;
  padding_top?: number;
  padding_right?: number;
  padding_bottom?: number;
  padding_left?: number;
  margin?: number;
  margin_x?: number;
  margin_y?: number;
  margin_top?: number;
  margin_right?: number;
  margin_bottom?: number;
  margin_left?: number;
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  min_width?: number | `${number}%`;
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  min_height?: number | `${number}%`;
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  max_width?: number | `${number}%`;
  /** A length in cells, or a `"N%"` percentage of the containing block's
   * size (passed through as a string prop to the layout engine). */
  max_height?: number | `${number}%`;
  flex_direction?: "row" | "column";
  /** The display layout mode: `"flex"` (default), `"grid"`, or `"none"`.
   * `"none"` hides the node and its whole subtree from layout and paint
   * (the engine skips the subtree entirely). Passed through as a string
   * prop to the layout engine. */
  display?: "flex" | "grid" | "none";
  /** The grid container's column track list, as a space-separated string
   * (`"1fr 2fr"`, `"10px 1fr auto"`, `"50% 1fr"`): `fr` tracks share the
   * free space, px / bare numbers are fixed cells, percents are of the
   * container's inner size, `auto` sizes to content; unparseable tokens
   * are skipped. String-form because the binding drops array values.
   * Passed through as a string prop to the layout engine. */
  grid_template_columns?: string;
  /** The grid container's row track list — the row-axis counterpart of
   * `grid_template_columns` (same tokens and string form). Passed through
   * as a string prop to the layout engine. */
  grid_template_rows?: string;
  /** How the auto-placement algorithm packs overflowing grid items:
   * `"row"` (default), `"column"`, `"row-dense"`, or `"column-dense"`.
   * Passed through as a string prop to the layout engine. */
  grid_auto_flow?: "row" | "column" | "row-dense" | "column-dense";
  /** A grid item's row placement: an integer line index (`2`, `-1` —
   * positive counts from the start, negative from the end) or a `"span N"`
   * track span. Sets the start line; the end stays auto (a one-track
   * span). Passed through as a scalar prop to the layout engine. */
  grid_row?: number | `span ${number}`;
  /** A grid item's column placement: an integer line index or a `"span N"`
   * track span. Sets the start line; the end stays auto (a one-track
   * span). Passed through as a scalar prop to the layout engine. */
  grid_column?: number | `span ${number}`;
  // Style keys.
  fg?: string;
  bg?: string;
  /**
   * The color a box's border glyphs are painted with, as a color string
   * (`#rrggbb`, `indexed:N`, or `default`). CamelCase alias for the binding's
   * `border_color` style key: it is translated to `border_color` before the
   * props reach the native layer, so `node.props` reports the snake_case key.
   * Unset, the border glyphs paint with the node's `fg` (the default).
   */
  borderColor?: string;
  /**
   * The hyperlink target (a URL) for the node's text, painted as an OSC 8
   * hyperlink by the engine. CamelCase alias for the binding's `href` style
   * key: it is translated to `href` before the props reach the native layer,
   * so `node.props` reports the snake_case key. Unset, the text paints as a
   * plain run (no OSC 8 sequences).
   */
  hyperlink?: string;
  /**
   * The underline style for the node's text: `"single"`, `"double"`,
   * `"curly"`, `"dotted"`, or `"dashed"` (kitty extended SGR `\x1b[4:Nm`).
   * CamelCase alias for the binding's `underline_style` style key: it is
   * translated to `underline_style` before the props reach the native layer,
   * so `node.props` reports the snake_case key. Unset, the text underlines
   * (when `underline` is set) with the plain legacy underline; terminals
   * without extended underline support degrade every variant to the plain
   * underline.
   */
  underlineStyle?: "single" | "double" | "curly" | "dotted" | "dashed";
  /**
   * The color the node's text underline is painted with, as a color string
   * (`#rrggbb`, `indexed:N`, or `default`). CamelCase alias for the binding's
   * `underline_color` style key: it is translated to `underline_color`
   * before the props reach the native layer, so `node.props` reports the
   * snake_case key. Unset, the underline paints in the terminal's default
   * color.
   */
  underlineColor?: string;
  border_style?: "none" | "plain" | "rounded" | "double" | "thick";
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  reversed?: boolean;
  hidden?: boolean;
  strikethrough?: boolean;
  /** Any other scalar prop is forwarded verbatim to the scene node. */
  [key: string]: unknown;
}

export type KeyHandler = (event: KeyEvent) => void;

/** Receives the new terminal size as `{ width, height }`. */
export type ResizeHandler = (event: { width: number; height: number }) => void;

/** Receives `{ focus_gained }` — `true` on focus gained, `false` on lost. */
export type FocusHandler = (event: { focus_gained: boolean }) => void;

/** Receives the mouse event payload. */
export type MouseHandler = (event: MouseEventJs) => void;

/** Receives the pasted text string. */
export type PasteHandler = (text: string) => void;

/** Receives the lifecycle event: `{ phase: "suspend" | "resume" }`. */
export type LifecycleHandler = (event: LifecycleEvent) => void;

/**
 * A single styled segment of a `streaming_text` node's stream, appended via
 * `Node.appendSpan`. `style` follows the same scalar-prop JSON convention as
 * `NodeProps` (and `setProps`): the recognized style keys (`fg`, `bg`,
 * `border_style`, the boolean modifiers) are lifted into the span's style by
 * the binding; every other key is ignored. `style.hyperlink` (the camelCase
 * alias for the binding's `href` style key, exactly as on `NodeProps`) links
 * the span's text to a URL: the binding lifts it into the span style's
 * hyperlink, and the compositor paints the span as an OSC 8 hyperlink.
 */
export interface Span {
  /** The span's text content. */
  text: string;
  /** Optional style keys for this span. */
  style?: NodeProps;
}

/**
 * An inclusive cell range, in viewport coordinates: the rectangle spanned
 * by (`col1`, `row1`) and (`col2`, `row2`). Either endpoint may be the
 * top-left; consumers normalize with `min`/`max`. Mirrors the native
 * `SelectionRange` surface from the tern-node binding.
 */
export interface SelectionRange {
  /** The column of one endpoint (inclusive). */
  col1: number;
  /** The row of one endpoint (inclusive). */
  row1: number;
  /** The column of the other endpoint (inclusive). */
  col2: number;
  /** The row of the other endpoint (inclusive). */
  row2: number;
}

/** Options accepted by `createRenderer`. */
export interface CreateRendererOptions {
  /**
   * When `true`, a Ctrl+C key press tears the terminal down (raw mode +
   * alternate screen exited) and marks the renderer destroyed instead of
   * being surfaced as an event. Maps to the native `exit_on_ctrl_c`.
   */
  exitOnCtrlC?: boolean;
  /**
   * When `false`, the renderer skips the alternate screen: it renders inline
   * in the terminal's main screen, and never emits the alternate-screen
   * enter/leave escapes. Default `true`. Maps to the native
   * `use_alt_screen`.
   */
  useAltScreen?: boolean;
  /**
   * When `true` (default), the renderer pushes the kitty keyboard protocol
   * enhancement (DISAMBIGUATE_ESCAPE_CODES) on construction and pops it on
   * destroy, so modifier combinations like Shift-Enter arrive as distinct
   * key events instead of collapsing into the unmodified key. Terminals
   * without the protocol ignore the sequences. Maps to the native
   * `keyboard_enhancement`.
   */
  keyboardEnhancement?: boolean;
  /**
   * When `false`, the renderer skips the scroll-region (DECSTBM) fast path:
   * a frame whose diff is exactly a vertical scroll of a full-width region
   * flushes as one terminal scroll command plus the newly exposed rows
   * instead of a cell-by-cell repaint. Only active on terminals the
   * interactive probe reports as scroll-region safe (never tmux/screen).
   * Maps to the native `scroll_optimization`. Default `true`.
   */
  scrollOptimization?: boolean;
  /**
   * When `true`, the renderer enables the accessibility-semantics store
   * (default `false`): while off, native semantics writes are rejected and
   * the JS wiring's best-effort pushes are dropped — so the store and the
   * painted cells are untouched. The store is pure bookkeeping — a parallel
   * map of node metadata that never changes painted content — read back
   * through {@link Renderer.semantics}. Maps to the native `semantics`.
   * Toggling later through {@link Renderer.setSemanticsEnabled} only records
   * the JS-side mirror: the native store is fixed at construction (there is
   * no native runtime toggle).
   */
  semantics?: boolean;
  /**
   * The terminal window title, applied when the renderer is constructed.
   * Maps to the native `title`.
   */
  title?: string;
  /**
   * When `true`, the renderer never touches a terminal: no raw mode, no
   * alternate screen, no event listening, no title. The scene paints into
   * an in-memory buffer of the configured `size` (default 80x24), so
   * construction and rendering succeed without a TTY — plain `cargo test`,
   * CI, snapshot tooling, anything with a fixed viewport. `snapshotFrame`
   * and `snapshotStyled` work headlessly at the configured size (they are
   * the natural output channel: there is no screen to paint), and
   * `startEventStream()` errors — a headless renderer has no terminal to
   * read events from, so there is no event loop to start (and `events`
   * stays empty). Maps to the native `headless`. Default `false`.
   */
  headless?: boolean;
  /**
   * The virtual viewport in cells for `headless` mode, as `{ width,
   * height }` (default `{ width: 80, height: 24 }`): the buffer
   * `render()` / `snapshotFrame()` / `snapshotStyled()` paint at when no
   * explicit viewport is given, and what the `size` getter reports. The
   * terminal-less counterpart of a resize: nothing resizes a headless
   * buffer, so the configured size is the one and only viewport. Ignored
   * when `headless` is `false`. Maps to the native `width`/`height`.
   */
  size?: { width: number; height: number };
  /**
   * The renderer's frame-rate cap for **coalesced** frames: the maximum
   * number of native renders per second a {@link Renderer.requestFrame}
   * schedule can trigger. A frame scheduled sooner than `1000 / maxFps`
   * after the previous native render waits out the remainder of the budget
   * instead of firing on the next macrotask, so a high-frequency
   * `requestFrame` loop downsamples to at most `maxFps` paints per second
   * under load. The cap does not change coalescing — a burst of
   * `requestFrame` calls within one tick still collapses into a single
   * native render, it is simply delayed to the cap — and an explicit
   * {@link Renderer.render} always paints immediately, bypassing the
   * throttle. Default `0` (or unset): no cap, every coalesced frame fires
   * on the next macrotask exactly as today. JS-side only: not forwarded to
   * the native renderer.
   */
  maxFps?: number;
}

