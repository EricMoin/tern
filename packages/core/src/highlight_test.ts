//! highlight.ts tests: the incremental edit path, its byte-offset contract,
//! and the changed window a mid-file edit returns.

import {
  editHighlight,
  highlightCode,
  incrementalHighlight,
  resetIncrementalHighlightCache,
  type Span,
} from "./index.ts";
import type { HighlightAppendJs, HighlightEditJs, HighlightSpanJs, TernAddon } from "./addon.ts";
import { setAddonForTesting } from "./addon.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 byte length of `text` — the unit the native offsets use. */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The concatenated text of a span stream. */
function textOf(spans: Span[]): string {
  return spans.map((span) => span.text).join("");
}

/** Deep-compare two span streams: text and style keys per span. */
function spansEqual(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((span, i) => {
    const other = b[i]!;
    return (
      span.text === other.text &&
      JSON.stringify(span.style ?? {}) === JSON.stringify(other.style ?? {})
    );
  });
}

/** The slice of `spans` covering the byte window `[from, to)`. The fixture
 * model is line-granular, so a boundary inside a span is a fixture bug (the
 * native engine may split spans; the JS layer only passes the window through,
 * so these tests pin the pass-through, not the splitting). */
function sliceSpans<T extends { text: string }>(spans: T[], from: number, to: number): T[] {
  const out: T[] = [];
  let cursor = 0;
  for (const span of spans) {
    const spanStart = cursor;
    cursor += byteLength(span.text);
    if (cursor <= from || spanStart >= to) continue;
    if (spanStart < from || cursor > to) {
      throw new Error(`the fake window ${from}..${to} cuts a span`);
    }
    out.push(span);
  }
  return out;
}

/** The byte window the fake edit reworked: the lines the replaced byte range
 * touched, in the coordinates of `old` (the caller shifts by the byte delta
 * for the new source's window). */
function lineWindowBytes(old: string, start: number, oldEnd: number): [number, number] {
  const lines = old.split("\n");
  let cursor = 0;
  let from = -1;
  let to = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = cursor;
    cursor += byteLength(i === lines.length - 1 ? lines[i]! : `${lines[i]!}\n`);
    if (from === -1 && cursor > start) from = lineStart;
    if (to === -1 && cursor >= oldEnd) to = cursor;
  }
  return [from === -1 ? cursor : from, to === -1 ? cursor : to];
}

/** The fake native span model: one span per code line (its trailing newline
 * included), styled from the line's first word — deterministic, and identical
 * for the one-shot and incremental paths, so a window and a full highlight are
 * directly comparable. */
function fakeSpans(source: string): HighlightSpanJs[] {
  const lines = source.split("\n");
  const spans: HighlightSpanJs[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    if (isLast && line === "") break; // the trailing "\n" split is empty
    const firstWord = line.trimStart().split(/\s+/)[0] ?? "";
    let fg: string | null = null;
    if (["fn", "let", "use", "pub"].includes(firstWord)) fg = "#c678dd";
    else if (line.includes("//")) fg = "#7f848e";
    else if (line.includes('"')) fg = "#98c379";
    const span: HighlightSpanJs = {
      text: isLast ? line : line + "\n",
      bold: false,
      italic: false,
      dim: false,
      underline: false,
    };
    if (fg !== null) span.fg = fg;
    spans.push(span);
  }
  return spans;
}

/** A fake addon with the native edit surface. `apply_edit` splices the byte
 * range, reworks the edited lines, and returns ONLY that window — the shape the
 * binding produces — while `append` keeps returning the complete stream.
 * Counters record which native calls the JS layer made, so the tests can prove
 * an edit took the edit path rather than a reset plus a full re-append. */
function makeEditFakeAddon(): {
  addon: TernAddon;
  highlightCalls: () => number;
  appendCalls: () => number;
  editCalls: () => number;
  resetCalls: () => number;
} {
  let highlightCalls = 0;
  let appendCalls = 0;
  let editCalls = 0;
  let resetCalls = 0;
  const addon = {
    TuiRenderer: class {},
    NodeHandle: class {},
    create_node: () => ({} as never),
    highlight: (_language: string, source: string): HighlightSpanJs[] => {
      highlightCalls++;
      return fakeSpans(source);
    },
    IncrementalHighlighter: class {
      #source = "";
      constructor(_language: string) {}
      append(chunk: string): HighlightAppendJs {
        appendCalls++;
        const wasPrimed = this.#source !== "";
        const prevBytes = byteLength(this.#source);
        this.#source += chunk;
        const result: HighlightAppendJs = { spans: fakeSpans(this.#source) };
        if (wasPrimed) result.changed = [prevBytes, byteLength(this.#source)];
        return result;
      }
      apply_edit(start: number, oldEnd: number, newText: string): HighlightEditJs {
        editCalls++;
        const old = this.#source;
        const bytes = encoder.encode(old);
        const next = decoder.decode(bytes.subarray(0, start)) + newText +
          decoder.decode(bytes.subarray(oldEnd));
        const delta = byteLength(next) - bytes.length;
        const [from, to] = lineWindowBytes(old, start, oldEnd);
        this.#source = next;
        return {
          spans: sliceSpans(fakeSpans(next), from, to + delta),
          changed: [from, to + delta],
        };
      }
      reset(): void {
        resetCalls++;
        this.#source = "";
      }
    },
  } as unknown as TernAddon;
  return {
    addon,
    highlightCalls: () => highlightCalls,
    appendCalls: () => appendCalls,
    editCalls: () => editCalls,
    resetCalls: () => resetCalls,
  };
}

/** The fixture every edit test starts from: eight lines, an interior line that
 * carries the edit, and no multi-byte characters (so byte and code-unit offsets
 * coincide; the byte contract has its own test). */
const FIXTURE = [
  "// a small fixture",
  "fn alpha() {",
  '    let a = "alpha";',
  "}",
  "fn beta() {",
  "    let b = 2;",
  "}",
  "fn gamma() {}",
].join("\n");

Deno.test("editHighlight: a mid-file edit returns only the changed window, which splices back into the complete stream", () => {
  const fake = makeEditFakeAddon();
  setAddonForTesting(fake.addon);
  try {
    resetIncrementalHighlightCache();

    // Prime the per-language cache with the complete stream.
    const code1 = FIXTURE;
    const complete = incrementalHighlight("rust", code1);
    if (textOf(complete) !== code1) throw new Error("the primed stream must reconstruct the source");
    if (fake.appendCalls() !== 1) throw new Error(`appendCalls after priming = ${fake.appendCalls()}`);

    const needle = "let b = 2;";
    const at = code1.indexOf(needle);
    const newText = "let b = 22; // beta";
    const code2 = code1.slice(0, at) + newText + code1.slice(at + needle.length);
    const result = editHighlight("rust", { start: at, oldEnd: at + needle.length, newText });
    if (result === null) throw new Error("editHighlight returned null for a valid edit");

    // The edit took the edit path: one native edit, no append, no reset, no
    // whole-file re-highlight.
    if (fake.editCalls() !== 1) throw new Error(`editCalls = ${fake.editCalls()}`);
    if (fake.appendCalls() !== 1) throw new Error(`an edit must not append (appendCalls = ${fake.appendCalls()})`);
    if (fake.resetCalls() !== 0) throw new Error(`an edit must not reset (resetCalls = ${fake.resetCalls()})`);
    if (fake.highlightCalls() !== 0) {
      throw new Error(`an edit must not re-highlight the whole file (highlightCalls = ${fake.highlightCalls()})`);
    }

    // Only the changed window came back, and it reconstructs that window of the
    // new source exactly.
    const [windowStart, windowEnd] = result.changed;
    if (windowStart <= 0 || windowEnd >= code2.length) {
      throw new Error(`the window ${result.changed} must be a sub-range of the source`);
    }
    if (windowStart > at || windowEnd < at + newText.length) {
      throw new Error(`the window ${result.changed} must cover the edit`);
    }
    if (textOf(result.spans) !== code2.slice(windowStart, windowEnd)) {
      throw new Error(
        `the window spans must reconstruct the source window: ${JSON.stringify(textOf(result.spans))} vs ` +
          JSON.stringify(code2.slice(windowStart, windowEnd)),
      );
    }

    // Spliced over the untouched prefix and suffix of the previous stream, the
    // window reconstructs the whole edited source span-for-span.
    const delta = code2.length - code1.length;
    const spliced = [
      ...sliceSpans(complete, 0, windowStart),
      ...result.spans,
      ...sliceSpans(complete, windowEnd - delta, code1.length),
    ];
    if (textOf(spliced) !== code2) {
      throw new Error("the spliced stream must reconstruct the edited source");
    }
    if (!spansEqual(spliced, highlightCode("rust", code2))) {
      throw new Error("the spliced stream must equal a full one-shot highlight of the edited source");
    }

    // The cache still answers for the edited source.
    const refreshed = incrementalHighlight("rust", code2);
    if (textOf(refreshed) !== code2) throw new Error("the cached stream must reconstruct the edited source");
    if (!spansEqual(refreshed, highlightCode("rust", code2))) {
      throw new Error("the cached stream must equal a full one-shot highlight of the edited source");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});

Deno.test("editHighlight: an append after an edit continues incrementally from the edited buffer", () => {
  const fake = makeEditFakeAddon();
  setAddonForTesting(fake.addon);
  try {
    resetIncrementalHighlightCache();

    const code1 = FIXTURE;
    incrementalHighlight("rust", code1);
    const needle = "fn beta()";
    const at = code1.indexOf(needle);
    const newText = "fn renamed_beta()";
    const code2 = code1.slice(0, at) + newText + code1.slice(at + needle.length);
    if (editHighlight("rust", { start: at, oldEnd: at + needle.length, newText }) === null) {
      throw new Error("editHighlight returned null for a valid edit");
    }

    // The next append re-parses only the tail of the edited buffer: no reset.
    const tail = "\nfn appended() {}\n";
    const grown = incrementalHighlight("rust", code2 + tail);
    if (fake.resetCalls() !== 0) {
      throw new Error(`an append after an edit must not reset (resetCalls = ${fake.resetCalls()})`);
    }
    if (fake.appendCalls() !== 2) throw new Error(`appendCalls after the tail = ${fake.appendCalls()}`);
    if (textOf(grown) !== code2 + tail) {
      throw new Error("the appended stream must reconstruct the grown source");
    }
    if (!spansEqual(grown, highlightCode("rust", code2 + tail))) {
      throw new Error("the appended stream must equal a full one-shot highlight");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});

Deno.test("editHighlight: a binding without the edit surface degrades to a full re-parse", () => {
  // The pre-edit native surface: append and reset only.
  const legacy = {
    TuiRenderer: class {},
    NodeHandle: class {},
    create_node: () => ({} as never),
    highlight: (_language: string, source: string): HighlightSpanJs[] => fakeSpans(source),
    IncrementalHighlighter: class {
      #source = "";
      append(chunk: string): HighlightAppendJs {
        this.#source += chunk;
        return { spans: fakeSpans(this.#source) };
      }
      reset(): void {
        this.#source = "";
      }
    },
  } as unknown as TernAddon;
  setAddonForTesting(legacy);
  try {
    resetIncrementalHighlightCache();

    const code1 = FIXTURE;
    incrementalHighlight("rust", code1);
    const needle = "let a =";
    const at = code1.indexOf(needle);
    const newText = "let renamed =";
    const oldEnd = at + needle.length;
    const code2 = code1.slice(0, at) + newText + code1.slice(oldEnd);
    const result = editHighlight("rust", { start: at, oldEnd, newText });
    if (result === null) throw new Error("a legacy binding must still absorb an edit");
    // No window exists without the edit surface: the whole source is the window,
    // and its spans reconstruct it exactly.
    if (result.changed[0] !== 0 || result.changed[1] !== code2.length) {
      throw new Error(`the degraded window must be the whole source, got ${result.changed}`);
    }
    if (textOf(result.spans) !== code2) {
      throw new Error("the degraded stream must reconstruct the edited source");
    }
    if (!spansEqual(result.spans, highlightCode("rust", code2))) {
      throw new Error("the degraded stream must equal a full one-shot highlight");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});

Deno.test("editHighlight: unknown languages and stale edits return null instead of a wrong window", () => {
  const fake = makeEditFakeAddon();
  setAddonForTesting(fake.addon);
  try {
    resetIncrementalHighlightCache();

    if (editHighlight("ruby", { start: 0, oldEnd: 0, newText: "x" }) !== null) {
      throw new Error("an unknown language must not highlight");
    }
    const code1 = FIXTURE;
    incrementalHighlight("rust", code1);
    const stale: Array<[string, { start: number; oldEnd: number; newText: string }]> = [
      ["past the end", { start: code1.length, oldEnd: code1.length + 4, newText: "x" }],
      ["a negative start", { start: -1, oldEnd: 0, newText: "x" }],
      ["inverted bounds", { start: 6, oldEnd: 2, newText: "" }],
      ["a fractional offset", { start: 1.5, oldEnd: 2, newText: "x" }],
    ];
    for (const [what, edit] of stale) {
      if (editHighlight("rust", edit) !== null) throw new Error(`${what} must be rejected`);
    }
    if (fake.editCalls() !== 0) {
      throw new Error(`a rejected edit must not reach the engine (editCalls = ${fake.editCalls()})`);
    }
    // The cache is intact: a valid edit still lands.
    const at = code1.indexOf("fn gamma()");
    const result = editHighlight("rust", { start: at, oldEnd: at + 2, newText: "fn" });
    if (result === null || textOf(result.spans) !== code1.slice(result.changed[0], result.changed[1])) {
      throw new Error("a valid edit after a rejected one must still work");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});

Deno.test("editHighlight: offsets are UTF-8 bytes, not UTF-16 code units", () => {
  const fake = makeEditFakeAddon();
  setAddonForTesting(fake.addon);
  try {
    resetIncrementalHighlightCache();

    const code1 = 'fn main() {\n    let s = "héllo → wörld";\n}\n';
    const literal = '"héllo → wörld"';
    const at = code1.indexOf(literal);
    const start = byteLength(code1.slice(0, at));
    const oldEnd = start + byteLength(literal);
    // The literal is wider in bytes than in code units, so the offsets below
    // only describe the right span under the byte contract.
    if (oldEnd - start === literal.length) {
      throw new Error("the fixture's literal must be wider in bytes than in code units");
    }
    incrementalHighlight("rust", code1);

    // A byte offset inside a multi-byte character describes no valid edit: the
    // é of the literal occupies bytes `start + 2` and `start + 3`, so
    // `start + 3` is a continuation byte, not a character boundary.
    if (editHighlight("rust", { start: start + 3, oldEnd: start + 3, newText: "x" }) !== null) {
      throw new Error("an offset inside a multi-byte character must be rejected");
    }

    const newText = '"bye"';
    const code2 = code1.slice(0, at) + newText + code1.slice(at + literal.length);
    const result = editHighlight("rust", { start, oldEnd, newText });
    if (result === null) throw new Error("a valid byte-offset edit must be accepted");

    // The window is measured in bytes: its span text is the byte slice, and its
    // own byte length equals the window width.
    const [windowStart, windowEnd] = result.changed;
    const window = textOf(result.spans);
    if (byteLength(window) !== windowEnd - windowStart) {
      throw new Error(`the window spans must be ${windowEnd - windowStart} bytes, got ${byteLength(window)}`);
    }
    const bytes = encoder.encode(code2);
    if (window !== decoder.decode(bytes.subarray(windowStart, windowEnd))) {
      throw new Error("the window spans must reconstruct the byte window of the new source");
    }

    // The cache still answers with the complete edited source.
    const refreshed = incrementalHighlight("rust", code2);
    if (textOf(refreshed) !== code2) throw new Error("the cached stream must reconstruct the source");
    if (!spansEqual(refreshed, highlightCode("rust", code2))) {
      throw new Error("the cached stream must equal a full one-shot highlight");
    }
  } finally {
    setAddonForTesting(null);
    resetIncrementalHighlightCache();
  }
});
