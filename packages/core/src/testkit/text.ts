//! Node-text helpers shared by the markdown tests.

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
  incrementalHighlight,
  resetIncrementalHighlightCache,
  type Span,
} from "../index.ts";
import type { HighlightAppendJs, HighlightSpanJs, TernAddon } from "../addon.ts";
import { setAddonForTesting } from "../addon.ts";

/** The text of a node's `text` prop, or `null` for a missing/non-text node. */
export function textOf(node: { props: { text?: unknown } } | undefined): string | null {
  return typeof node?.props.text === "string" ? node.props.text : null;
}

/**
 * A representative document exercising every block and inline style, joined
 * exactly as a streamed agent answer might settle.
 */
export const goldenSource = [
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

/** A fake `highlight` mirroring the native engine's output shape for the
 * `let x = 1;` snippet: a complete span stream (gaps carry `fg: null`) with
 * the One-Dark token colors. */
export const highlightFakeAddon = {
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
export function withHighlightAddon(fn: () => void): void {
  setAddonForTesting(highlightFakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

/** Deterministic fake span stream for the incremental fence tests: one span
 * per code line (the trailing newline included except on the last line),
 * styled from the line's first word — keyword purple for rust keywords,
 * italic grey for comment lines, string green for lines with a string
 * literal, plain otherwise. The concatenation of the span texts reconstructs
 * the source exactly, mirroring the native engine's coverage contract. */
export function fakeSpanStream(_language: string, source: string): HighlightSpanJs[] {
  const lines = source.split("\n");
  const spans: HighlightSpanJs[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    if (isLast && line === "") break; // the trailing "\n" split is empty
    const firstWord = line.trimStart().split(/\s+/)[0] ?? "";
    let fg: string | null = null;
    let italic = false;
    if (["fn", "let", "use", "pub", "impl", "struct", "enum"].includes(firstWord)) {
      fg = "#c678dd";
    } else if (line.includes("//")) {
      fg = "#7f848e";
      italic = true;
    } else if (line.includes('"')) {
      fg = "#98c379";
    }
    const span: HighlightSpanJs = {
      text: isLast ? line : line + "\n",
      bold: false,
      italic,
      dim: false,
      underline: false,
    };
    if (fg !== null) span.fg = fg;
    spans.push(span);
  }
  return spans;
}

/** A fake addon whose `highlight` counts every call and whose incremental
 * highlighter records every append result, so tests can assert the JS cache
 * drives the native surface exactly as intended. */
export function makeIncrementalFakeAddon(): {
  addon: TernAddon;
  highlightCalls: () => number;
  appendCalls: () => number;
  appendResults: () => HighlightAppendJs[];
} {
  let highlightCalls = 0;
  let appendCalls = 0;
  const appendResults: HighlightAppendJs[] = [];
  const addon = {
    TuiRenderer: class {},
    NodeHandle: class {},
    create_node: () => ({} as never),
    highlight: (language: string, source: string): HighlightSpanJs[] => {
      highlightCalls++;
      return fakeSpanStream(language, source);
    },
    IncrementalHighlighter: class {
      #language: string;
      #source = "";
      #appended = false;
      constructor(language: string) {
        this.#language = language;
      }
      append(chunk: string): HighlightAppendJs {
        appendCalls++;
        const prevLen = this.#source.length;
        this.#source += chunk;
        const spans = fakeSpanStream(this.#language, this.#source);
        // A pure tail append reworks exactly the appended region — the range
        // the native engine reports for the same append. Before the first
        // append the field is absent, mirroring the binding's `Option` (the
        // generated d.ts surfaces it as `changed?: number[]`).
        const result: HighlightAppendJs = { spans };
        if (this.#appended) result.changed = [prevLen, this.#source.length];
        this.#appended = true;
        appendResults.push(result);
        return result;
      }
      reset(): void {
        this.#source = "";
        this.#appended = false;
      }
    },
  } as unknown as TernAddon;
  return {
    addon,
    highlightCalls: () => highlightCalls,
    appendCalls: () => appendCalls,
    appendResults: () => appendResults,
  };
}

/** Deep-compare two span streams: text and style keys per span. */
export function spansEqual(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const other = b[i]!;
    return (
      s.text === other.text &&
      JSON.stringify(s.style ?? {}) === JSON.stringify(other.style ?? {})
    );
  });
}

/** A large deterministic rust fence body: `lines` code lines (default 200)
 * exercising keywords, numbers, strings and comments, plus an optional `tail`
 * appended verbatim at the end. */
export function fenceCode(lines: number, tail = ""): string {
  const body: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 4 === 0) body.push(`fn helper_${i}() {`);
    else if (i % 4 === 1) body.push(`    let value = ${i}; // count`);
    else if (i % 4 === 2) body.push(`    let name = "item_${i}";`);
    else body.push("}");
  }
  return body.join("\n") + tail;
}

/** A markdown source wrapping `code` in a rust fence. */
export function rustFenceSource(code: string): string {
  return "```rust\n" + code + "\n```\n";
}

/** The leaves of one fence row (a single text leaf, or a box of per-span
 * leaves). */
export function rowLeaves(row: { type: string; children?: readonly unknown[] }): Array<{ props: { text?: unknown } }> {
  if (row.type === "text") return [row as unknown as { props: { text?: unknown } }];
  return (row.children ?? []) as unknown as Array<{ props: { text?: unknown } }>;
}

/** The rows of a fence box. */
export function fenceRows(fence: { children: readonly unknown[] }): Array<{ type: string; children?: readonly unknown[] }> {
  return fence.children as Array<{ type: string; children?: readonly unknown[] }>;
}

/** The text a fence renders: its rows joined by newlines (the trailing empty
 * line after a final newline renders as an empty row, so a source ending in
 * `"\n"` reconstructs verbatim). */
export function fenceText(fence: { children: readonly unknown[] }): string {
  return fenceRows(fence).map((row) => rowLeaves(row).map(textOf).join("")).join("\n");
}

export const LARGE_FENCE_LINES = 200;
