/**
 * Unit tests for the @tern/core MarkdownView element.
 *
 * Like the factory tests in `index_test.ts`, these exercise the declarative
 * composition surface without touching the native addon or a real terminal:
 * `MarkdownView` parses its `source` into pure `Text`/`Box` node objects
 * (native materialization is lazy), so the tests run under plain `deno test`
 * with no permission flags.
 *
 * The tests cover the block styles (headings, lists, blockquotes, horizontal
 * rules, code fences — including half-open fences — and paragraphs), the
 * inline styles (`**bold**`, `*italic*`, `` `code` ``, `[links](url)`), and a
 * golden composition test asserting the full node tree of a representative
 * document.
 */

import {
  MARKDOWN_CODE_FG,
  MARKDOWN_FENCE_BG,
  MARKDOWN_HR_CHAR,
  MARKDOWN_HR_WIDTH,
  MARKDOWN_LINK_FG,
  MarkdownView,
  THEME_COMPONENTS,
  defaultTheme,
  highlightCode,
} from "./index.ts";
import type { HighlightSpanJs, TernAddon } from "./addon.ts";
import { setAddonForTesting } from "./addon.ts";

/** The text of a node's `text` prop, or `null` for a missing/non-text node. */
function textOf(node: { props: { text?: unknown } } | undefined): string | null {
  return typeof node?.props.text === "string" ? node.props.text : null;
}

// ---------------------------------------------------------------------------
// Root composition
// ---------------------------------------------------------------------------

Deno.test("MarkdownView composes a wrapping column box and consumes the source key", () => {
  const view = MarkdownView({ source: "hello" });
  if (view.type !== "markdown") throw new Error(`type = ${view.type}`);
  if (view.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${view.props.flex_direction}`);
  }
  // The parsed source is JS bookkeeping, never a scene prop.
  if ("source" in view.props) throw new Error("source must not reach the scene props");
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const child = view.children[0];
  if (child === undefined || child.type !== "text") {
    throw new Error("a plain paragraph must be a single text leaf");
  }
  if (textOf(child) !== "hello") throw new Error(`text = ${textOf(child)}`);
});

Deno.test("MarkdownView with an empty source yields an empty column", () => {
  const view = MarkdownView({ source: "" });
  if (view.children.length !== 0) throw new Error(`children = ${view.children.length}`);
});

Deno.test("markdown is registered as a themeable component", () => {
  if (!THEME_COMPONENTS.includes("markdown")) {
    throw new Error("markdown must be a theme component");
  }
  if (defaultTheme.components.markdown === undefined) {
    throw new Error("defaultTheme must carry the markdown component preset");
  }
});

// ---------------------------------------------------------------------------
// Block styles
// ---------------------------------------------------------------------------

Deno.test("headings render bold, with the H1 additionally underlined", () => {
  const view = MarkdownView({ source: "# One\n## Two\n###### Six" });
  if (view.children.length !== 3) throw new Error(`children = ${view.children.length}`);
  const h1 = view.children[0];
  if (h1?.type !== "text" || h1.props.bold !== true || h1.props.underline !== true) {
    throw new Error(`h1 = ${JSON.stringify(h1?.props)}`);
  }
  if (textOf(h1) !== "One") throw new Error(`h1 text = ${textOf(h1)}`);
  const h2 = view.children[1];
  if (h2?.type !== "text" || h2.props.bold !== true || h2.props.underline !== undefined) {
    throw new Error(`h2 = ${JSON.stringify(h2?.props)}`);
  }
  if (textOf(h2) !== "Two") throw new Error(`h2 text = ${textOf(h2)}`);
  const h6 = view.children[2];
  if (h6?.type !== "text" || h6.props.bold !== true || h6.props.underline !== undefined) {
    throw new Error(`h6 = ${JSON.stringify(h6?.props)}`);
  }
  if (textOf(h6) !== "Six") throw new Error(`h6 text = ${textOf(h6)}`);
});

Deno.test("a missing heading space or more than 6 markers is a paragraph", () => {
  const view = MarkdownView({ source: "#NoSpace\n####### seven" });
  if (view.children.length !== 2) throw new Error(`children = ${view.children.length}`);
  for (const child of view.children) {
    if (child?.type !== "text") throw new Error(`child must be a paragraph leaf`);
    if (child.props.bold === true) throw new Error(`paragraph must not be bold`);
  }
  if (textOf(view.children[0]) !== "#NoSpace") throw new Error(`text = ${textOf(view.children[0])}`);
  if (textOf(view.children[1]) !== "####### seven") throw new Error(`text = ${textOf(view.children[1])}`);
});

Deno.test("paragraphs skip blank separator lines", () => {
  const view = MarkdownView({ source: "a\n\nb\n\n" });
  if (view.children.length !== 2) throw new Error(`children = ${view.children.length}`);
  if (textOf(view.children[0]) !== "a" || textOf(view.children[1]) !== "b") {
    throw new Error(`texts = ${view.children.map(textOf).join(",")}`);
  }
});

Deno.test("bullet list items normalize to a bullet prefix", () => {
  const view = MarkdownView({ source: "- a\n* b\n+ c" });
  const texts = view.children.map(textOf);
  if (texts.join("|") !== "• a|• b|• c") throw new Error(`texts = ${texts.join("|")}`);
});

Deno.test("list nesting indents two cells per level", () => {
  const view = MarkdownView({ source: "- top\n  - nested\n    - deep" });
  const texts = view.children.map(textOf);
  if (texts.join("|") !== "• top|  • nested|    • deep") {
    throw new Error(`texts = ${texts.join("|")}`);
  }
});

Deno.test("ordered list items keep their marker", () => {
  const view = MarkdownView({ source: "1. first\n2) second\n10. ten" });
  const texts = view.children.map(textOf);
  if (texts.join("|") !== "1. first|2) second|10. ten") {
    throw new Error(`texts = ${texts.join("|")}`);
  }
});

Deno.test("block quotes render dimmed with a quote prefix", () => {
  const view = MarkdownView({ source: "> a quote" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const leaf = view.children[0];
  if (leaf?.type !== "text" || leaf.props.dim !== true) {
    throw new Error(`quote leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (textOf(leaf) !== "> a quote") throw new Error(`text = ${textOf(leaf)}`);
});

Deno.test("horizontal rules render a dim rule run", () => {
  const view = MarkdownView({ source: "---" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const leaf = view.children[0];
  if (leaf?.type !== "text" || leaf.props.dim !== true) {
    throw new Error(`hr leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (textOf(leaf) !== MARKDOWN_HR_CHAR.repeat(MARKDOWN_HR_WIDTH)) {
    throw new Error(`hr text length = ${textOf(leaf)?.length}`);
  }
});

Deno.test("spaced rules match before list items; a lone dash is a paragraph", () => {
  const view = MarkdownView({ source: "- - -\n* * *\n-" });
  if (view.children.length !== 3) throw new Error(`children = ${view.children.length}`);
  // `- - -` and `* * *` are thematic breaks (3+ of the same char, spaces
  // between allowed) and win over the list pattern.
  if (textOf(view.children[0]) !== MARKDOWN_HR_CHAR.repeat(MARKDOWN_HR_WIDTH)) {
    throw new Error(`first = ${JSON.stringify(textOf(view.children[0]))}`);
  }
  if (textOf(view.children[1]) !== MARKDOWN_HR_CHAR.repeat(MARKDOWN_HR_WIDTH)) {
    throw new Error(`second = ${JSON.stringify(textOf(view.children[1]))}`);
  }
  // A lone `-` is not a rule (needs 3) and not a list item (needs a space).
  if (textOf(view.children[2]) !== "-") throw new Error(`third = ${JSON.stringify(textOf(view.children[2]))}`);
});

Deno.test("a code fence composes a background box with one leaf per line", () => {
  const view = MarkdownView({ source: "```\nlet x = 1;\n```\n" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const fence = view.children[0];
  if (fence?.type !== "box") throw new Error(`fence type = ${fence?.type}`);
  if (fence.props.flex_direction !== "column" || fence.props.bg !== MARKDOWN_FENCE_BG) {
    throw new Error(`fence props = ${JSON.stringify(fence.props)}`);
  }
  // The fence marker lines are consumed — only the content renders.
  if (fence.children.length !== 1) throw new Error(`fence lines = ${fence.children.length}`);
  const line = fence.children[0];
  if (line?.type !== "text" || textOf(line) !== "let x = 1;") {
    throw new Error(`fence line = ${JSON.stringify(line?.props)}`);
  }
});

Deno.test("a half-open fence renders its collected lines as the fenced block (streaming)", () => {
  // The closing marker has not arrived yet (the source ends inside the
  // fence) — the fence still renders with the single fence style
  // (best-effort while streaming).
  const view = MarkdownView({ source: "```rust\nlet x = 1;" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const fence = view.children[0];
  if (fence?.type !== "box" || fence.props.bg !== MARKDOWN_FENCE_BG) {
    throw new Error(`fence = ${JSON.stringify(fence?.props)}`);
  }
  if (fence.children.length !== 1) throw new Error(`fence lines = ${fence.children.length}`);
  if (textOf(fence.children[0]) !== "let x = 1;") {
    throw new Error(`fence line = ${JSON.stringify(textOf(fence.children[0]))}`);
  }
});

Deno.test("tilde fences and empty fences compose; content after the fence is a paragraph", () => {
  const view = MarkdownView({ source: "~~~\ncode\n~~~\n\ntext\n" });
  if (view.children.length !== 2) throw new Error(`children = ${view.children.length}`);
  const fence = view.children[0];
  if (fence?.type !== "box" || textOf(fence.children[0]) !== "code") {
    throw new Error(`tilde fence = ${JSON.stringify(fence?.props)}`);
  }
  if (textOf(view.children[1]) !== "text") throw new Error(`after = ${JSON.stringify(textOf(view.children[1]))}`);

  const empty = MarkdownView({ source: "```\n```" });
  if (empty.children.length !== 1) throw new Error(`empty fence children = ${empty.children.length}`);
  if (empty.children[0]?.children.length !== 0) {
    throw new Error(`empty fence must have no lines`);
  }
});

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

Deno.test("a uniform styled line composes as a single text leaf", () => {
  const view = MarkdownView({ source: "**bold**" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const leaf = view.children[0];
  if (leaf?.type !== "text" || leaf.props.bold !== true || leaf.props.italic !== undefined) {
    throw new Error(`bold leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (textOf(leaf) !== "bold") throw new Error(`text = ${textOf(leaf)}`);
});

Deno.test("italic and inline code styles stamp their leaves", () => {
  const italic = MarkdownView({ source: "*it*" });
  const it = italic.children[0];
  if (it?.type !== "text" || it.props.italic !== true || textOf(it) !== "it") {
    throw new Error(`italic leaf = ${JSON.stringify(it?.props)}`);
  }
  const code = MarkdownView({ source: "`let x`" });
  const leaf = code.children[0];
  if (leaf?.type !== "text" || leaf.props.fg !== MARKDOWN_CODE_FG || textOf(leaf) !== "let x") {
    throw new Error(`code leaf = ${JSON.stringify(leaf?.props)}`);
  }
});

Deno.test("a mixed line composes as a flex row of per-span leaves", () => {
  const view = MarkdownView({ source: "a **b** c" });
  if (view.children.length !== 1) throw new Error(`children = ${view.children.length}`);
  const row = view.children[0];
  if (row?.type !== "box" || row.props.flex_direction !== "row") {
    throw new Error(`row = ${JSON.stringify(row?.props)}`);
  }
  const texts = row.children.map(textOf).join("|");
  if (texts !== "a |b| c") throw new Error(`spans = ${texts}`);
  const middle = row.children[1];
  if (middle?.props.bold !== true) throw new Error(`middle span must be bold`);
  if (row.children[0]?.props.bold !== undefined) {
    throw new Error(`plain span must not be bold`);
  }
});

Deno.test("nested inline styles toggle independently", () => {
  const view = MarkdownView({ source: "**a *b* c**" });
  const row = view.children[0];
  if (row?.type !== "box") throw new Error(`row = ${row?.type}`);
  const spans = row.children;
  if (spans.length !== 3) throw new Error(`spans = ${spans.length}`);
  if (textOf(spans[0]) !== "a " || spans[0]?.props.bold !== true) {
    throw new Error(`span 0 = ${JSON.stringify(spans[0]?.props)}`);
  }
  if (textOf(spans[1]) !== "b" || spans[1]?.props.bold !== true || spans[1]?.props.italic !== true) {
    throw new Error(`span 1 = ${JSON.stringify(spans[1]?.props)}`);
  }
  if (textOf(spans[2]) !== " c" || spans[2]?.props.bold !== true || spans[2]?.props.italic !== undefined) {
    throw new Error(`span 2 = ${JSON.stringify(spans[2]?.props)}`);
  }
  // `***x***` folds bold + italic onto one span.
  const triple = MarkdownView({ source: "***x***" });
  const leaf = triple.children[0];
  if (leaf?.type !== "text" || leaf.props.bold !== true || leaf.props.italic !== true) {
    throw new Error(`triple = ${JSON.stringify(leaf?.props)}`);
  }
});

Deno.test("an unclosed inline marker styles the rest of its line (streaming)", () => {
  const view = MarkdownView({ source: "**bold" });
  const leaf = view.children[0];
  if (leaf?.type !== "text" || leaf.props.bold !== true || textOf(leaf) !== "bold") {
    throw new Error(`leaf = ${JSON.stringify(leaf?.props)}`);
  }
});

Deno.test("markers inside an inline code span stay literal", () => {
  const view = MarkdownView({ source: "`a **b**`" });
  const leaf = view.children[0];
  if (leaf?.type !== "text" || leaf.props.fg !== MARKDOWN_CODE_FG) {
    throw new Error(`code leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (textOf(leaf) !== "a **b**") throw new Error(`text = ${textOf(leaf)}`);
});

Deno.test("links render their label underlined with the link fg", () => {
  const view = MarkdownView({ source: "[docs](https://tern.dev)" });
  const leaf = view.children[0];
  if (leaf?.type !== "text" || textOf(leaf) !== "docs") {
    throw new Error(`link leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (leaf.props.underline !== true || leaf.props.fg !== MARKDOWN_LINK_FG) {
    throw new Error(`link style = ${JSON.stringify(leaf.props)}`);
  }
});

Deno.test("links inside a sentence split into spans and keep surrounding styles", () => {
  const view = MarkdownView({ source: "**[x](u)** and [y](v)." });
  const row = view.children[0];
  if (row?.type !== "box") throw new Error(`row = ${row?.type}`);
  const spans = row.children.map((span) => ({
    text: textOf(span),
    bold: span?.props.bold === true,
    underline: span?.props.underline === true,
    fg: span?.props.fg,
  }));
  // `[x](u)` is bold (inside `**`), `[y](v)` plain; the trailing `.` after
  // the URL is a separate plain span (no merge across the link).
  if (spans.length !== 4) throw new Error(`spans = ${JSON.stringify(spans)}`);
  if (spans[0]?.text !== "x" || spans[0]?.bold !== true || spans[0]?.underline !== true) {
    throw new Error(`span 0 = ${JSON.stringify(spans[0])}`);
  }
  if (spans[1]?.text !== " and " || spans[1]?.bold !== false || spans[1]?.underline !== false) {
    throw new Error(`span 1 = ${JSON.stringify(spans[1])}`);
  }
  if (spans[2]?.text !== "y" || spans[2]?.bold !== false || spans[2]?.underline !== true) {
    throw new Error(`span 2 = ${JSON.stringify(spans[2])}`);
  }
  if (spans[3]?.text !== "." || spans[3]?.underline !== false) {
    throw new Error(`span 3 = ${JSON.stringify(spans[3])}`);
  }
});

Deno.test("an unclosed link is literal text", () => {
  const view = MarkdownView({ source: "[no](paren" });
  const leaf = view.children[0];
  if (leaf?.type !== "text" || textOf(leaf) !== "[no](paren") {
    throw new Error(`leaf = ${JSON.stringify(leaf?.props)}`);
  }
  if (leaf.props.underline === true) throw new Error("unclosed link must not be underlined");
});

// ---------------------------------------------------------------------------
// Inline styles within block styles
// ---------------------------------------------------------------------------

Deno.test("inline styles compose inside headings, lists and block quotes", () => {
  const view = MarkdownView({ source: "# **Title**\n- **bold** item\n> *it*" });
  // Heading: the bold span merges with the heading's own bold style into one
  // leaf.
  const heading = view.children[0];
  if (heading?.type !== "text" || heading.props.bold !== true || textOf(heading) !== "Title") {
    throw new Error(`heading = ${JSON.stringify(heading?.props)}`);
  }
  // List item: a row box with the bullet and the bold span.
  const item = view.children[1];
  if (item?.type !== "box") throw new Error(`item = ${item?.type}`);
  if (textOf(item.children[0]) !== "• " || item.children[1]?.props.bold !== true) {
    throw new Error(`item spans = ${JSON.stringify(item.children.map(textOf))}`);
  }
  // Block quote: the dim block style carries into every span.
  const quote = view.children[2];
  if (quote?.type !== "box") throw new Error(`quote = ${quote?.type}`);
  const it = quote.children[1];
  if (it?.props.italic !== true || it?.props.dim !== true) {
    throw new Error(`quote italic span = ${JSON.stringify(it?.props)}`);
  }
});

// ---------------------------------------------------------------------------
// Layout props
// ---------------------------------------------------------------------------

Deno.test("the width prop soft-wraps plain leaves and spans the horizontal rule", () => {
  const view = MarkdownView({ source: "a line\n---", width: 20 });
  // The width flows to the root box (like Textarea) and to the paragraph leaf.
  if (view.props.width !== 20) throw new Error(`root width = ${view.props.width}`);
  const paragraph = view.children[0];
  if (paragraph?.type !== "text" || paragraph.props.width !== 20) {
    throw new Error(`paragraph = ${JSON.stringify(paragraph?.props)}`);
  }
  const rule = view.children[1];
  if (textOf(rule) !== MARKDOWN_HR_CHAR.repeat(20)) {
    throw new Error(`rule width = ${textOf(rule)?.length}`);
  }
});

Deno.test("a non-positive width is treated as unset on the leaves", () => {
  const view = MarkdownView({ source: "x", width: 0 });
  const leaf = view.children[0];
  if (leaf?.type !== "text" || "width" in leaf.props) {
    throw new Error(`leaf = ${JSON.stringify(leaf?.props)}`);
  }
});

// ---------------------------------------------------------------------------
// Golden composition
// ---------------------------------------------------------------------------

/**
 * A representative document exercising every block and inline style, joined
 * exactly as a streamed agent answer might settle.
 */
const goldenSource = [
  "# Title",
  "",
  "Intro **bold** and `code` and [link](https://tern.dev).",
  "",
  "- first",
  "- second",
  "  - nested",
  "",
  "> a quote",
  "",
  "---",
  "",
  "```rust",
  "fn main() {}",
  "```",
].join("\n");

Deno.test("golden composition: a full document composes the expected node tree", () => {
  const view = MarkdownView({ source: goldenSource });
  if (view.type !== "markdown") throw new Error(`type = ${view.type}`);
  if (view.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${view.props.flex_direction}`);
  }
  const blocks = view.children;
  if (blocks.length !== 8) throw new Error(`blocks = ${blocks.length}`);

  // 1. H1: bold + underlined text leaf.
  const h1 = blocks[0];
  if (h1?.type !== "text" || h1.props.bold !== true || h1.props.underline !== true) {
    throw new Error(`h1 = ${JSON.stringify(h1?.props)}`);
  }
  if (textOf(h1) !== "Title") throw new Error(`h1 text = ${textOf(h1)}`);

  // 2. Paragraph with mixed inline styles: one flex row, one leaf per span.
  const paragraph = blocks[1];
  if (paragraph?.type !== "box" || paragraph.props.flex_direction !== "row") {
    throw new Error(`paragraph = ${JSON.stringify(paragraph?.props)}`);
  }
  const spans = paragraph.children;
  if (spans.length !== 7) throw new Error(`paragraph spans = ${spans.length}`);
  const expect = (index: number, text: string, style: { bold?: boolean; fg?: string; underline?: boolean }): void => {
    const span = spans[index];
    if (textOf(span) !== text) throw new Error(`span ${index} text = ${textOf(span)}`);
    if (span?.props.bold !== style.bold && (style.bold === true || span?.props.bold === true)) {
      throw new Error(`span ${index} bold = ${span?.props.bold}`);
    }
    if (span?.props.fg !== style.fg) throw new Error(`span ${index} fg = ${span?.props.fg}`);
    if (span?.props.underline !== style.underline && (style.underline === true || span?.props.underline === true)) {
      throw new Error(`span ${index} underline = ${span?.props.underline}`);
    }
  };
  expect(0, "Intro ", {});
  expect(1, "bold", { bold: true });
  expect(2, " and ", {});
  expect(3, "code", { fg: MARKDOWN_CODE_FG });
  expect(4, " and ", {});
  expect(5, "link", { fg: MARKDOWN_LINK_FG, underline: true });
  expect(6, ".", {});

  // 3-5. List items: normalized bullets, 2-cell nesting.
  if (textOf(blocks[2]) !== "• first") throw new Error(`list 1 = ${textOf(blocks[2])}`);
  if (textOf(blocks[3]) !== "• second") throw new Error(`list 2 = ${textOf(blocks[3])}`);
  if (textOf(blocks[4]) !== "  • nested") throw new Error(`list 3 = ${textOf(blocks[4])}`);

  // 6. Block quote: dimmed leaf with the quote prefix.
  const quote = blocks[5];
  if (quote?.type !== "text" || quote.props.dim !== true || textOf(quote) !== "> a quote") {
    throw new Error(`quote = ${JSON.stringify(quote?.props)}`);
  }

  // 7. Horizontal rule: the default rule run, dimmed.
  const rule = blocks[6];
  if (rule?.type !== "text" || rule.props.dim !== true) {
    throw new Error(`rule = ${JSON.stringify(rule?.props)}`);
  }
  if (textOf(rule) !== MARKDOWN_HR_CHAR.repeat(MARKDOWN_HR_WIDTH)) {
    throw new Error(`rule text = ${textOf(rule)?.length}`);
  }

  // 8. Code fence: a background box with the fenced content, markers consumed.
  const fence = blocks[7];
  if (fence?.type !== "box" || fence.props.bg !== MARKDOWN_FENCE_BG) {
    throw new Error(`fence = ${JSON.stringify(fence?.props)}`);
  }
  if (fence.children.length !== 1 || textOf(fence.children[0]) !== "fn main() {}") {
    throw new Error(`fence lines = ${JSON.stringify(fence.children.map(textOf))}`);
  }
});

// ---------------------------------------------------------------------------
// Code fence syntax highlighting (roadmap Phase 4)
// ---------------------------------------------------------------------------

/** A fake `highlight` mirroring the native engine's output shape for the
 * `let x = 1;` snippet: a complete span stream (gaps carry `fg: null`) with
 * the One-Dark token colors. */
const highlightFakeAddon = {
  TuiRenderer: class {},
  NodeHandle: class {},
  create_node: () => ({} as never),
  highlight: (language: string, source: string): HighlightSpanJs[] => {
    if (language === "rust" && source === "let x = 1;") {
      return [
        { text: "let", fg: "#c678dd", bold: false, italic: false, dim: false, underline: false },
        { text: " x = ", bold: false, italic: false, dim: false, underline: false },
        { text: "1", fg: "#d19a66", bold: false, italic: false, dim: false, underline: false },
        { text: ";", bold: false, italic: false, dim: false, underline: false },
      ];
    }
    return [{ text: source, bold: false, italic: false, dim: false, underline: false }];
  },
} as unknown as TernAddon;

/** Run `fn` with the fake highlight addon installed, resetting the seam. */
function withHighlightAddon(fn: () => void): void {
  setAddonForTesting(highlightFakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

Deno.test("highlightCode falls back to an empty stream without the native addon", () => {
  const spans = highlightCode("rust", "let x = 1;");
  if (spans.length !== 0) throw new Error(`spans = ${JSON.stringify(spans)}`);
});

Deno.test("highlightCode returns an empty stream for unknown languages", () => {
  const spans = highlightCode("ruby", "x");
  if (spans.length !== 0) throw new Error(`spans = ${JSON.stringify(spans)}`);
});

Deno.test("highlightCode maps native spans onto scene styles and reconstructs source", () => {
  withHighlightAddon(() => {
    const spans = highlightCode("rust", "let x = 1;");
    if (spans.map((s) => s.text).join("") !== "let x = 1;") {
      throw new Error(`concat = ${spans.map((s) => s.text).join("")}`);
    }
    if (spans[0]?.style?.fg !== "#c678dd") throw new Error(`let fg = ${spans[0]?.style?.fg}`);
    if (spans[1]?.style?.fg !== undefined) throw new Error(`gap fg = ${spans[1]?.style?.fg}`);
    if (spans[2]?.style?.fg !== "#d19a66") throw new Error(`1 fg = ${spans[2]?.style?.fg}`);
  });
});

Deno.test("a fence with an unrecognized language renders plain leaves", () => {
  const view = MarkdownView({ source: "```ruby\nputs 1\n```" });
  const fence = view.children[0];
  if (fence?.type !== "box" || fence.props.bg !== MARKDOWN_FENCE_BG) {
    throw new Error(`fence = ${JSON.stringify(fence?.props)}`);
  }
  if (fence.children.length !== 1 || fence.children[0]?.type !== "text") {
    throw new Error(`fence must stay plain for unknown languages`);
  }
  if (textOf(fence.children[0]) !== "puts 1") throw new Error(`text = ${textOf(fence.children[0])}`);
});

Deno.test("the fence info string is consumed, never rendered", () => {
  const view = MarkdownView({ source: "```rust\nlet x = 1;\n```" });
  const fence = view.children[0];
  const texts = fence?.children.map(textOf).join("|") ?? "";
  if (texts.includes("rust")) throw new Error(`info string leaked: ${texts}`);
});

Deno.test("a recognized-language fence composes per-token highlighted rows", () => {
  withHighlightAddon(() => {
    const view = MarkdownView({ source: "```rust\nlet x = 1;\n```" });
    const fence = view.children[0];
    if (fence?.type !== "box" || fence.props.bg !== MARKDOWN_FENCE_BG) {
      throw new Error(`fence = ${JSON.stringify(fence?.props)}`);
    }
    // The single code line mixes token styles -> one flex row of per-span
    // leaves, with the token colors stamped as `fg`.
    if (fence.children.length !== 1) throw new Error(`rows = ${fence.children.length}`);
    const row = fence.children[0];
    if (row?.type !== "box" || row.props.flex_direction !== "row") {
      throw new Error(`row = ${JSON.stringify(row?.props)}`);
    }
    const leaves = row.children;
    if (leaves.length !== 4) throw new Error(`leaves = ${leaves.length}`);
    if (textOf(leaves[0]) !== "let" || leaves[0]?.props.fg !== "#c678dd") {
      throw new Error(`keyword leaf = ${JSON.stringify(leaves[0]?.props)}`);
    }
    if (textOf(leaves[1]) !== " x = " || leaves[1]?.props.fg !== undefined) {
      throw new Error(`gap leaf = ${JSON.stringify(leaves[1]?.props)}`);
    }
    if (textOf(leaves[2]) !== "1" || leaves[2]?.props.fg !== "#d19a66") {
      throw new Error(`number leaf = ${JSON.stringify(leaves[2]?.props)}`);
    }
  });
});

Deno.test("a uniform highlighted code line composes as a single text leaf", () => {
  withHighlightAddon(() => {
    // The fake addon returns one unstyled span for any other source -> the
    // line stays a single plain leaf (the common case).
    const view = MarkdownView({ source: "```rust\nlet y = 2;\n```" });
    const fence = view.children[0];
    if (fence?.children.length !== 1) throw new Error(`rows = ${fence?.children.length}`);
    const line = fence.children[0];
    if (line?.type !== "text" || textOf(line) !== "let y = 2;") {
      throw new Error(`line = ${JSON.stringify(line?.props)}`);
    }
  });
});
