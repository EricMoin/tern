//! Markdown rendering tests: incremental fence highlighting: appends re-parse only the ta.

import { LARGE_FENCE_LINES, fenceCode, fenceRows, fenceText, makeIncrementalFakeAddon, rowLeaves, rustFenceSource, spansEqual, textOf } from "./testkit.ts";
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
} from "./index.ts";
import { setAddonForTesting } from "./addon.ts";

Deno.test("incremental fence highlighting: appends re-parse only the tail and unchanged re-renders make no native calls", () => {
  const { addon, highlightCalls, appendCalls, appendResults } = makeIncrementalFakeAddon();
  setAddonForTesting(addon);
  try {
    resetIncrementalHighlightCache();

    const code1 = fenceCode(LARGE_FENCE_LINES);
    const tail = "\nfn appended() {\n    let fresh = true;\n}\n";
    const code2 = fenceCode(LARGE_FENCE_LINES, tail);

    // Render 1: the full large fence — a fresh per-language highlighter,
    // exactly one append, no one-shot `highlight` call.
    const view1 = MarkdownView({ source: rustFenceSource(code1) });
    const fence1 = view1.children[0]!;
    if (fenceText(fence1) !== code1) {
      throw new Error(`fence 1 text mismatch`);
    }
    if (appendCalls() !== 1) throw new Error(`appendCalls after render 1 = ${appendCalls()}`);
    if (highlightCalls() !== 0) throw new Error(`highlightCalls after render 1 = ${highlightCalls()}`);

    // The incremental stream is byte-identical to a full one-shot highlight.
    const spans1 = incrementalHighlight("rust", code1);
    if (spans1.map((s) => s.text).join("") !== code1) {
      throw new Error("render 1 spans must reconstruct the source");
    }
    if (!spansEqual(spans1, highlightCode("rust", code1))) {
      throw new Error("render 1 spans differ from a full one-shot highlight");
    }

    // Render 2: the fence grew by `tail` — a pure append re-parse.
    const view2 = MarkdownView({ source: rustFenceSource(code2) });
    const fence2 = view2.children[0]!;
    if (fenceText(fence2) !== code2) {
      throw new Error(`fence 2 text mismatch`);
    }
    if (appendCalls() !== 2) throw new Error(`appendCalls after render 2 = ${appendCalls()}`);

    // The appended stream is still byte-identical to a full highlight of the
    // grown source, and the recorded changed range stays within the tail.
    const spans2 = incrementalHighlight("rust", code2);
    if (spans2.map((s) => s.text).join("") !== code2) {
      throw new Error("render 2 spans must reconstruct the source");
    }
    if (!spansEqual(spans2, highlightCode("rust", code2))) {
      throw new Error("render 2 spans differ from a full one-shot highlight");
    }
    const recorded = appendResults();
    const changed = recorded[1]!.changed;
    if (changed === undefined) throw new Error("the second append must report a changed range");
    const headLen = code1.length;
    if (changed[0]! < headLen) {
      throw new Error(`changed start ${changed} must be within the tail (head ${headLen})`);
    }
    if (changed[1]! > code2.length) {
      throw new Error(`changed end ${changed} must be within the source (${code2.length})`);
    }

    // The appended tail's tokens actually flow into the fence rows.
    const appendedRow = fenceRows(fence2).find((row) =>
      rowLeaves(row).map(textOf).join("").includes("fn appended"),
    );
    const kwLeaf = appendedRow === undefined
      ? undefined
      : rowLeaves(appendedRow).find((leaf) => (textOf(leaf) ?? "").includes("fn appended"));
    if (kwLeaf === undefined || textOf(kwLeaf) !== "fn appended() {") {
      throw new Error(`appended row = ${JSON.stringify(appendedRow)}`);
    }
    if ((kwLeaf as { props: { fg?: unknown } }).props.fg !== "#c678dd") {
      throw new Error(`appended keyword must be token-colored`);
    }

    // Render 3: the unchanged source re-rendered — zero native calls.
    const before = { highlight: highlightCalls(), append: appendCalls() };
    const view3 = MarkdownView({ source: rustFenceSource(code2) });
    if (fenceText(view3.children[0]!) !== code2) {
      throw new Error(`fence 3 text mismatch`);
    }
    if (highlightCalls() !== before.highlight || appendCalls() !== before.append) {
      throw new Error(
        `an unchanged re-render must make no native calls: before ${JSON.stringify(before)}, after ` +
          JSON.stringify({ highlight: highlightCalls(), append: appendCalls() }),
      );
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});

Deno.test("incremental fence highlighting: an edit that breaks the prefix re-highlights from scratch", () => {
  const { addon, appendCalls, appendResults } = makeIncrementalFakeAddon();
  setAddonForTesting(addon);
  try {
    resetIncrementalHighlightCache();

    const code1 = fenceCode(LARGE_FENCE_LINES);
    const view1 = MarkdownView({ source: rustFenceSource(code1) });
    if (fenceText(view1.children[0]!) !== code1) {
      throw new Error(`fence 1 text mismatch`);
    }
    if (appendCalls() !== 1) throw new Error(`appendCalls after render 1 = ${appendCalls()}`);

    // The first line is edited: the cached previous code is no longer a
    // prefix — the highlighter resets and re-appends the whole source.
    const edited = "fn renamed() {\n" + code1.split("\n").slice(1).join("\n");
    const view2 = MarkdownView({ source: rustFenceSource(edited) });
    if (fenceText(view2.children[0]!) !== edited) {
      throw new Error(`fence 2 text mismatch`);
    }
    if (appendCalls() !== 2) throw new Error(`appendCalls after edit = ${appendCalls()}`);
    const recorded = appendResults();
    // The post-reset re-append is a fresh first append: no changed range.
    if (recorded[1]!.changed !== undefined) {
      throw new Error(`a post-reset append must report no changed range`);
    }
    if (!spansEqual(incrementalHighlight("rust", edited), highlightCode("rust", edited))) {
      throw new Error("edited spans differ from a full one-shot highlight");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});
