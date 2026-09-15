//! The MarkdownView element and the markdown parser behind it.

import { CHECKBOX_CHECKED_GLYPH, CHECKBOX_UNCHECKED_GLYPH } from "./checkbox.ts";
import { incrementalHighlight } from "./highlight.ts";
import { Box, Node, Text } from "./node.ts";
import { currentScroll, maxScroll, renderScrollbar, scrollTo } from "./scrollview.ts";
import { Table, displayWidth } from "./table.ts";
import type { NodeProps, Span } from "./types.ts";
/** The fg of an inline `` `code` `` span (One-Dark red — inline code reads as
 * a keyword accent against the default text). */
export const MARKDOWN_CODE_FG = "#e06c75";

/** The fg of a `[link](url)` span (One-Dark blue — links read as the
 * `primary` role; the underline is the link affordance). */
export const MARKDOWN_LINK_FG = "#61afef";

/** The bg of a code fence block — the default theme's panel background. The
 * single fence style stands in for token colors until tree-sitter
 * highlighting lands (roadmap Phase 4). */
export const MARKDOWN_FENCE_BG = "#21252b";

/** The glyph of a horizontal rule. */
export const MARKDOWN_HR_CHAR = "─";

/** The default width of a horizontal rule in cells (when no `width` prop is
 * set). */
export const MARKDOWN_HR_WIDTH = 40;

/** Props for the `MarkdownView` element. `source` is consumed by the factory
 * (the parsed block model is JS bookkeeping — it never reaches the scene
 * props, mirroring `Panels`' `panels`); the remaining style/layout props flow
 * to the root box, which is a flex column of the composed block nodes. */
export interface MarkdownViewProps extends NodeProps {
  /** The Markdown source to render. */
  source: string;
  /**
   * The soft-wrap width in cells (default unset — lines stay unwrapped and
   * the compositor trims overflow at the right edge). Plain paragraph /
   * heading / list / blockquote leaves soft-wrap at this width (mirroring
   * `Textarea`), and the horizontal rule spans it.
   */
  width?: number;
}

/** One styled text segment of a parsed inline line: the literal text plus the
 * style keys the inline parser derived (`bold` / `italic` / `fg` /
 * `underline`). */
interface MarkdownSpan {
  text: string;
  style: NodeProps;
}

/** A parsed markdown block, before node composition. */
type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; prefix: string; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "hr" }
  | { kind: "code"; lines: string[]; lang: string }
  | { kind: "table"; columns: MarkdownTableColumn[]; rows: (string | number)[][] };

/** One column of a parsed pipe-table block: the header label and the cell
 * alignment derived from the separator row. */
interface MarkdownTableColumn {
  /** The header cell's text (also the `Table` column's header label). */
  header: string;
  /** The cell content alignment (from the separator: `:--:` center, `--:`
   * right, otherwise left). */
  align: "left" | "right" | "center";
}

/** A heading marker: 1-6 `#` followed by whitespace. */
const MARKDOWN_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/** A bullet list item: `-` / `*` / `+` after any leading indent (each 2-space
 * step is one nesting level). */
const MARKDOWN_ULIST_RE = /^ *([-*+])[ \t]+(.*)$/;

/** An ordered list item: a number plus `.` / `)` after any leading indent. */
const MARKDOWN_OLIST_RE = /^ *(\d+[.)])[ \t]+(.*)$/;

/** A task-list marker inside a list item: `[ ]` / `[x]` / `[X]` followed by
 * whitespace (the CommonMark task-list extension). */
const MARKDOWN_TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;

/** A block quote line: `>` (with an optional following space). */
const MARKDOWN_QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;

/** A thematic break: 3+ of the same `-` / `*` / `_`, spaces allowed between
 * (checked before the list patterns — `- - -` is a rule, not an item). */
const MARKDOWN_HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A pipe-table separator row: `|`-separated runs of dashes (optionally
 * colon-aligned, e.g. `|---|:--:|`), with at least one dash and one pipe. */
const MARKDOWN_TABLE_SEP_RE = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

/** A code fence opener: 3+ backticks or 3+ tildes, plus an ignored info
 * string (the language — consumed here and fed to `highlightCode`). */
const MARKDOWN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/** Whether `line` closes the fence opened with fence char `char` (3+ of the
 * same char, trailing spaces only). */
function markdownFenceClose(line: string, char: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === char;
}

/**
 * Parse a Markdown source into its block model. Line-based and best-effort: a
 * half-open code fence (no closing marker before the end of the source) still
 * yields a `code` block with the lines collected so far, so a streaming
 * document renders progressively and settles when the fence closes.
 */
function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = MARKDOWN_FENCE_RE.exec(line);
    if (fence !== null) {
      const char = fence[1]![0]!;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !markdownFenceClose(lines[i]!, char)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume the closing marker line
      // The fence info string's first whitespace/brace-delimited token is the
      // language (e.g. `rust` in ```rust) — consumed, never rendered.
      const info = (fence[2] ?? "").trim().split(/[\s{]/)[0]!.toLowerCase();
      blocks.push({ kind: "code", lines: codeLines, lang: info });
      continue;
    }
    const heading = MARKDOWN_HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }
    if (MARKDOWN_HR_RE.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    const quote = MARKDOWN_QUOTE_RE.exec(line);
    if (quote !== null) {
      blocks.push({ kind: "blockquote", text: `> ${quote[1]!}` });
      i += 1;
      continue;
    }
    const ulist = MARKDOWN_ULIST_RE.exec(line);
    if (ulist !== null) {
      const indent = line.length - line.trimStart().length;
      const base = "  ".repeat(Math.min(6, Math.floor(indent / 2)));
      const task = MARKDOWN_TASK_RE.exec(ulist[2]!);
      if (task !== null) {
        // A task-list item: the checkbox glyph replaces the bullet (the
        // checked/unchecked glyphs mirror the `Checkbox` element).
        blocks.push({
          kind: "list",
          prefix: base +
            (task[1]! === " " ? CHECKBOX_UNCHECKED_GLYPH : CHECKBOX_CHECKED_GLYPH) +
            " ",
          text: task[2]!,
        });
      } else {
        blocks.push({ kind: "list", prefix: base + "• ", text: ulist[2]! });
      }
      i += 1;
      continue;
    }
    const olist = MARKDOWN_OLIST_RE.exec(line);
    if (olist !== null) {
      const indent = line.length - line.trimStart().length;
      const base = "  ".repeat(Math.min(6, Math.floor(indent / 2)));
      const task = MARKDOWN_TASK_RE.exec(olist[2]!);
      if (task !== null) {
        // A task-list item inside an ordered list: `1. [x] item` keeps its
        // marker and gains the checkbox glyph.
        blocks.push({
          kind: "list",
          prefix: base + `${olist[1]!} ` +
            (task[1]! === " " ? CHECKBOX_UNCHECKED_GLYPH : CHECKBOX_CHECKED_GLYPH) +
            " ",
          text: task[2]!,
        });
      } else {
        blocks.push({
          kind: "list",
          prefix: base + `${olist[1]!} `,
          text: olist[2]!,
        });
      }
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1; // blank lines separate blocks — nothing to render
      continue;
    }
    // A pipe table: a `|`-containing row followed by a separator row of
    // dashes. The first line is the header row; the separator's `:---` /
    // `:--:` / `---:` runs drive per-column alignment; the following pipe
    // rows are the body. Lines without a pipe (or a separator next) fall
    // through to the paragraph path.
    if (line.includes("|") && MARKDOWN_TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      const header = splitMarkdownRow(line);
      const separator = splitMarkdownRow(lines[i + 1]!);
      const columns: MarkdownTableColumn[] = header.map((cell, col) => ({
        header: cell,
        align: markdownTableAlign(separator[col] ?? ""),
      }));
      const rows: (string | number)[][] = [];
      i += 2;
      while (
        i < lines.length &&
        lines[i]!.includes("|") &&
        lines[i]!.trim() !== ""
      ) {
        rows.push(splitMarkdownRow(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: "table", columns, rows });
      continue;
    }
    blocks.push({ kind: "paragraph", text: line });
    i += 1;
  }
  return blocks;
}

/** Split one pipe-table row into its cells: the leading/trailing pipes are
 * trimmed and the remaining cells split on `|` and trimmed. A literal pipe
 * inside a cell is not supported (markdown's `\|` escape is out of scope for
 * the best-effort parser). */
function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const end = body.endsWith("|") ? body.slice(0, -1) : body;
  return end.split("|").map((cell) => cell.trim());
}

/** The cell alignment a table separator column declares: `:--:` center,
 * `--:` right, anything else left. */
function markdownTableAlign(separator: string): "left" | "right" | "center" {
  const s = separator.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  return "left";
}

/** Whether two inline span styles carry the same derived keys (the parser
 * only produces `bold` / `italic` / `fg` / `underline` / `hyperlink`). */
function markdownSpanStyleEqual(a: NodeProps, b: NodeProps): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.fg === b.fg &&
    a.underline === b.underline && a.hyperlink === b.hyperlink;
}

/**
 * Parse a line's inline styles into styled spans. A small state machine over
 * the markers `**` (bold), `*` (italic), `` ` `` (code — markers inside a
 * code span stay literal), and `[label](url)` (a link: the label is re-parsed
 * recursively and stamped with `underline` + {@link MARKDOWN_LINK_FG}).
 * Nesting works because each marker toggles its flag (`**a *b* c**`); an
 * unclosed marker styles the rest of the line (best-effort while streaming).
 * Adjacent spans with identical styles are merged.
 */
function parseInline(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let buf = "";
  let bold = false;
  let italic = false;
  let code = false;

  const push = (span: MarkdownSpan): void => {
    const last = spans[spans.length - 1];
    if (last !== undefined && markdownSpanStyleEqual(last.style, span.style)) {
      last.text += span.text;
    } else {
      spans.push(span);
    }
  };

  const flush = (): void => {
    if (buf === "") return;
    const style: NodeProps = {};
    if (bold) style.bold = true;
    if (italic) style.italic = true;
    if (code) style.fg = MARKDOWN_CODE_FG;
    push({ text: buf, style });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("`")) {
      flush();
      code = !code;
      i += 1;
      continue;
    }
    if (code) {
      // Inside a code span only the closing backtick is a marker — every
      // other character (asterisks, brackets) is literal.
      buf += text[i]!;
      i += 1;
      continue;
    }
    if (rest.startsWith("**")) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (rest.startsWith("*")) {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    if (rest.startsWith("[")) {
      const close = rest.indexOf("](");
      if (close !== -1) {
        const paren = rest.indexOf(")", close + 2);
        if (paren !== -1) {
          flush();
          // The link's target URL rides the OSC 8 `hyperlink` style key (the
          // engine's `href` — `node.props` reports the snake_case spelling),
          // so a terminal with OSC 8 support paints the label clickable; the
          // label itself is parsed inline and stamped with the link style.
          const url = rest.slice(close + 2, paren);
          for (const span of parseInline(rest.slice(1, close))) {
            const style: NodeProps = {
              ...span.style,
              underline: true,
              fg: MARKDOWN_LINK_FG,
              hyperlink: url,
            };
            if (bold) style.bold = true;
            if (italic) style.italic = true;
            push({ text: span.text, style });
          }
          i += paren + 1;
          continue;
        }
      }
    }
    buf += text[i]!;
    i += 1;
  }
  flush();
  return spans;
}

/**
 * Compose one markdown text line into scene nodes: a single `Text` leaf when
 * the line parses to one span (the common case — it soft-wraps at `width`),
 * or a flex row of per-span `Text` leaves when the line mixes inline styles.
 * `base` is the block style (e.g. `dim` for a block quote); span styles
 * override it.
 */
function markdownLineNode(
  text: string,
  base: NodeProps,
  width: number | null,
): Node {
  const spans = parseInline(text);
  if (spans.length === 1) {
    const span = spans[0]!;
    const props: NodeProps = { ...base, text: span.text, ...span.style };
    if (width !== null) props.width = width;
    return Text(props);
  }
  const leaves = spans.map((span) =>
    Text({ ...base, text: span.text, ...span.style })
  );
  return Box({ flex_direction: "row" }, ...leaves);
}

/** Compose one highlighted code line into a scene node: a single `Text` leaf
 * when the line parses to one span (the common case), or a flex row of
 * per-span `Text` leaves when it mixes token styles. */
function markdownSpanRow(spans: Span[]): Node {
  if (spans.length === 1) {
    const span = spans[0]!;
    return Text({ text: span.text, ...span.style });
  }
  return Box(
    { flex_direction: "row" },
    ...spans.map((span) => Text({ text: span.text, ...span.style })),
  );
}

/** Compose one parsed markdown block into its scene node(s). */
function buildMarkdownBlock(block: MarkdownBlock, width: number | null): Node {
  switch (block.kind) {
    case "heading": {
      // Headings render bold at every level; an H1 additionally underlines
      // (terminal markdown renderers have no font sizes — weight/underline
      // carry the hierarchy).
      const style: NodeProps = { bold: true };
      if (block.level === 1) style.underline = true;
      return markdownLineNode(block.text, style, width);
    }
    case "paragraph":
      return markdownLineNode(block.text, {}, width);
    case "list":
      return markdownLineNode(block.prefix + block.text, {}, width);
    case "blockquote":
      return markdownLineNode(block.text, { dim: true }, width);
    case "hr":
      return Text({
        text: MARKDOWN_HR_CHAR.repeat(width ?? MARKDOWN_HR_WIDTH),
        dim: true,
      });
    case "table": {
      // A pipe table renders through the existing `Table` element (the
      // roadmap's "表格用现有 Table 逻辑局部渲染"): one column per header
      // cell — width the widest cell in the column (header or body) plus one
      // padding cell — aligned per the separator row. The sticky header
      // stays on (the default) and the whole row list is the viewport.
      const widths = block.columns.map((column, col) =>
        Math.max(
          displayWidth(column.header),
          ...block.rows.map((row) => displayWidth(String(row[col] ?? ""))),
        ) + 1
      );
      return Table({
        columns: block.columns.map((column, col) => ({
          key: String(col),
          header: column.header,
          width: widths[col]!,
          align: column.align,
        })),
        rows: block.rows,
      });
    }
    case "code": {
      // The fenced block: a box with the fence `bg`. With a recognized fence
      // language the whole code text is token-highlighted and composed as one
      // node per line — a single `Text` leaf when the line is uniform, a flex
      // row of per-span leaves when it mixes styles (mirroring
      // `markdownLineNode`); otherwise (unknown language, or the addon is not
      // available) one plain text leaf per line. Fence marker lines are
      // consumed — a half-open fence renders exactly like a closed one
      // (best-effort streaming).
      //
      // Highlighting goes through the incremental path: a growing fence
      // (each render appends newly streamed lines) re-parses only its tail,
      // and an unchanged re-render makes zero native calls.
      const spans = incrementalHighlight(block.lang, block.lines.join("\n"));
      if (spans.length === 0) {
        return Box(
          { flex_direction: "column", bg: MARKDOWN_FENCE_BG },
          ...block.lines.map((line) => Text({ text: line })),
        );
      }
      const rows: Node[] = [];
      let rowSpans: Span[] = [];
      // The span stream reconstructs the joined source exactly, so splitting
      // each span's text on newlines regroups it per code line.
      for (const span of spans) {
        const parts = span.text.split("\n");
        parts.forEach((part, i) => {
          if (i > 0) {
            rows.push(markdownSpanRow(rowSpans));
            rowSpans = [];
          }
          rowSpans.push(
            span.style === undefined
              ? { text: part }
              : { text: part, style: span.style },
          );
        });
      }
      if (rowSpans.length > 0) rows.push(markdownSpanRow(rowSpans));
      return Box({ flex_direction: "column", bg: MARKDOWN_FENCE_BG }, ...rows);
    }
  }
}

/**
 * Create a `markdown` element: a flex column of block nodes rendering the
 * Markdown `source` — headings (bold, H1 underlined), paragraphs, bulleted /
 * ordered lists (`•` items, 2-space nesting), block quotes (dimmed `> `),
 * horizontal rules (a `─` run) and code fences (a `bg` box, one leaf per
 * line) — with `**bold**` / `*italic*` / `` `code` `` / `[links](url)` inline
 * styles parsed into per-span `Text` leaves. Parsing is best-effort and
 * streaming-friendly: a half-open code fence renders its collected lines as
 * the fenced block, and an unclosed inline marker styles the rest of its
 * line. The `source` key is consumed (JS bookkeeping — never a scene prop);
 * the `width` prop soft-wraps plain lines and spans the horizontal rule. No
 * new napi node kind: the `markdown` element materializes as a `box`
 * (constitution).
 */
export function MarkdownView(props: MarkdownViewProps): Node {
  const width =
    typeof props.width === "number" && Number.isFinite(props.width) &&
      props.width > 0
      ? Math.floor(props.width)
      : null;
  const blocks = parseMarkdown(props.source ?? "").map((block) =>
    buildMarkdownBlock(block, width)
  );
  const rootProps: NodeProps = { ...props, flex_direction: "column" };
  const plain = rootProps as Record<string, unknown>;
  delete plain.source;
  return Node.create("markdown", rootProps, blocks);
}

/** The per-node auto-scroll follow state of a streaming node. */
interface StreamScrollState {
  /** Whether the node currently follows its content tail. */
  following: boolean;
  /** Whether the node's auto-scroll was enabled at creation (or by
   *  `followTail` / `setStreamAutoScroll(true)`): only such a node can *have*
   *  a follow to detach, so only it stamps the scroll-to-bottom affordance
   *  on a manual scroll above the tail. A node created with
   *  `autoScroll: false` never shows the affordance. */
  autoScrollEnabled: boolean;
}

/** The follow states of streaming nodes created with auto-scroll. */
export const streamScrollStates = new WeakMap<Node, StreamScrollState>();

/**
 * @internal — register/override a streaming node's auto-scroll follow state.
 * Called by the host factories with the consumed `autoScroll` flag (the
 * `@tern-tui/react` `<StreamingText>` syncs it from its own prop on mount/toggle;
 * the `@tern-tui/solid` `StreamingText` factory passes its consumed flag).
 */
export function setStreamAutoScroll(node: Node, enabled: boolean): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) {
    streamScrollStates.set(node, {
      following: enabled,
      autoScrollEnabled: enabled,
    });
  } else {
    state.following = enabled;
    state.autoScrollEnabled = enabled;
  }
}

/** Whether `node` is currently following its content tail (auto-scroll). */
export function isStreamFollowing(node: Node): boolean {
  return streamScrollStates.get(node)?.following ?? false;
}

/**
 * Drive a streaming node's auto-scroll after an appended span: when the node
 * is following its tail, pin `scroll_y` to the tail offset — the content
 * height minus the clip viewport height (floored at 0). A no-op on nodes
 * that are not following, or not attached (the tail measures laid-out
 * geometry). Call after each `Node.appendSpan`; the @tern-tui/react
 * `<StreamingText>` effect and the @tern-tui/solid `subscribeStream` pump do
 * exactly that.
 */
export function syncStreamTail(node: Node): void {
  const state = streamScrollStates.get(node);
  if (state === undefined || !state.following) return;
  if (!node.attached) return;
  const max = maxScroll(node);
  const props = node.props;
  node.setProps({ ...props, scroll_y: max.y });
  renderScrollbar(node);
}

/**
 * Re-attach a streaming node's auto-scroll: the node follows its tail again,
 * snapping `scroll_y` to the current tail offset immediately, and the
 * scroll-to-bottom affordance (stamped when a manual scroll detached the
 * follow) is dismissed. A node that had no follow state (e.g. one built via
 * the raw `Node` constructor) is registered and enabled. On a detached node
 * the snap is deferred until the next `syncStreamTail` after attach.
 */
export function followTail(node: Node): void {
  const state = streamScrollStates.get(node);
  if (state === undefined) {
    streamScrollStates.set(node, { following: true, autoScrollEnabled: true });
  } else {
    state.following = true;
    state.autoScrollEnabled = true;
  }
  dismissStreamAffordance(node);
  if (node.attached) syncStreamTail(node);
}

/** The character of a streaming node's "scroll to bottom" affordance cell. */
export const STREAM_AFFORDANCE_CHAR = "▼";

/** The affordance cell's paint z-order (2): above in-flow content (0) and
 *  the scrollbar leaf (1), so it wins the clip region's bottom-right corner
 *  over both (compositor z-order, the same mechanism `Select`'s `floating`
 *  overlay uses). */
const STREAM_AFFORDANCE_Z_INDEX = 2;

/** The affordance text leaf of a streaming node (JS bookkeeping — never
 *  scene props, mirroring `scrollbarLeaves`). */
const streamAffordanceLeaves = new WeakMap<Node, Node>();

/**
 * Stamp the scroll-to-bottom affordance onto `node` (idempotent): a 1x1 text
 * leaf absolutely positioned at the clip region's bottom-right, painted above
 * in-flow content. The `top` inset is `(clipHeight - 1) + scrollY` — the
 * region's scroll pans subtree drawing up by `scroll_y`, so the compensated
 * inset keeps the cell fixed at the viewport's bottom row while the content
 * scrolls (the same compensation the scrollbar leaf uses). A no-op while
 * detached (no geometry) or when already shown.
 */
export function showStreamAffordance(node: Node): void {
  if (streamAffordanceLeaves.has(node)) return;
  if (!node.attached) return;
  const props = node.props;
  const clipHeight = typeof props.clip_height === "number"
    ? props.clip_height
    : node.contentSize().height;
  const leaf = Text({
    position: "absolute",
    right: 0,
    top: Math.max(0, clipHeight - 1) + currentScroll(node).y,
    width: 1,
    height: 1,
    z_index: STREAM_AFFORDANCE_Z_INDEX,
    text: STREAM_AFFORDANCE_CHAR,
  });
  node.addChild(leaf);
  streamAffordanceLeaves.set(node, leaf);
}

/** Remove the scroll-to-bottom affordance from `node` (idempotent). */
function dismissStreamAffordance(node: Node): void {
  const leaf = streamAffordanceLeaves.get(node);
  if (leaf === undefined) return;
  leaf.remove();
  streamAffordanceLeaves.delete(node);
}

/** Recompute the affordance cell's position from the node's current scroll
 *  offset — a no-op while the affordance is not shown. */
export function refreshStreamAffordance(node: Node): void {
  const leaf = streamAffordanceLeaves.get(node);
  if (leaf === undefined) return;
  const props = node.props;
  const clipHeight = typeof props.clip_height === "number"
    ? props.clip_height
    : node.contentSize().height;
  leaf.setProps({
    ...leaf.props,
    top: Math.max(0, clipHeight - 1) + currentScroll(node).y,
  });
}

/**
 * Jump a streaming node's view to the bottom of its content (the tail),
 * clamped to the content bounds, and dismiss the scroll-to-bottom
 * affordance. Unlike {@link followTail} — which re-attaches the auto-scroll
 * follow — this is a one-shot jump: the follow state is left untouched, so a
 * node detached by a manual scroll stays detached (subsequent appends do not
 * pin `scroll_y`, and the next scroll above the tail stamps the affordance
 * again). Call it from the affordance's activation (e.g. a click on the `▼`
 * cell); pair with `followTail` to resume live-follow after the jump. The
 * view must be attached: the clamp measures the laid-out sizes. Returns the
 * applied offsets.
 */
export function scrollToBottom(node: Node): { x: number; y: number } {
  const max = maxScroll(node);
  dismissStreamAffordance(node);
  return scrollTo(node, currentScroll(node).x, max.y);
}

