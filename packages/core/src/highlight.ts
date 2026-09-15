//! Syntax highlighting: the one-shot, incremental-append and incremental-edit
//! code highlighters.

import { HIGHLIGHT_LANGUAGES, spanFromRaw } from "./modal.ts";
import type { Span } from "./types.ts";

import { loadAddon } from "./addon.ts";
import type { HighlightEditJs, NativeIncrementalHighlighter, TernAddon } from "./addon.ts";
/**
 * Token-highlight `code` in `language` (a Markdown fence info string such as
 * `"rust"`, `"ts"`, `"json"`, `"bash"`). Returns a complete span stream whose
 * `text` concatenation reconstructs `code` exactly; spans carry `fg` (hex)
 * and modifier style keys ready for `Node.appendSpan` or a `Text` leaf.
 * Returns `[]` for unknown languages or when the native addon cannot be
 * loaded — callers fall back to unstyled rendering.
 */
export function highlightCode(language: string, code: string): Span[] {
  const lang = language.trim().toLowerCase();
  if (!HIGHLIGHT_LANGUAGES.has(lang) || code === "") return [];
  try {
    const addon = loadAddon();
    if (typeof addon.highlight !== "function") return [];
    return addon.highlight(lang, code).map(spanFromRaw);
  } catch {
    // The addon is not available (no --allow-ffi, browser host) — unstyled.
    return [];
  }
}

/** One cached highlighter per fence language: the native instance plus the
 * code it last highlighted and the mapped span stream it produced. */
interface HighlightCacheEntry {
  instance: NativeIncrementalHighlighter;
  prevCode: string;
  /** The complete span stream over `prevCode`, or `null` once an
   * {@link editHighlight} call invalidated it — the edit surface returns only
   * the changed window, so the next full-stream call re-derives the whole
   * document from the instance. */
  spans: Span[] | null;
}

/** The module-level per-language cache of incremental highlighters. */
const highlightCache = new Map<string, HighlightCacheEntry>();

/**
 * The streaming variant of {@link highlightCode} for a growing code fence:
 * re-highlights `code` in `language` through a cached native
 * `IncrementalHighlighter` so only the appended tail is re-parsed.
 *
 * The cache holds ONE highlighter per language. When the cached highlighter's
 * previous code is a prefix of `code` (a pure append), only the new tail
 * `code.slice(prev.length)` is handed to the engine and the stored result is
 * replaced with the engine's full stream; when `code` equals the previous
 * code (an unchanged re-render) the cached stream is returned without any
 * native call; otherwise the highlighter is reset and the whole source is
 * re-appended (a non-append edit cannot reuse the head — {@link editHighlight}
 * is the edit-aware path, whose window-only result invalidates the cached
 * stream, which this call then re-derives). The span contract
 * matches {@link highlightCode} exactly — a complete stream whose
 * concatenation reconstructs `code`, with the same fallbacks (`[]` when the
 * addon or the language is unavailable, and a plain one-shot re-highlight
 * when the binding predates the incremental surface).
 */
export function incrementalHighlight(language: string, code: string): Span[] {
  const lang = language.trim().toLowerCase();
  if (!HIGHLIGHT_LANGUAGES.has(lang) || code === "") return [];
  let addon: TernAddon;
  try {
    addon = loadAddon();
  } catch {
    return []; // the addon is unavailable — callers fall back to unstyled
  }
  if (typeof addon.IncrementalHighlighter !== "function") {
    // A binding (or fake) without the incremental surface: one-shot path.
    return highlightCode(language, code);
  }
  try {
    let entry = highlightCache.get(lang);
    if (entry === undefined) {
      entry = {
        instance: new addon.IncrementalHighlighter(lang),
        prevCode: "",
        spans: [],
      };
      highlightCache.set(lang, entry);
    }
    if (code === entry.prevCode) {
      // An unchanged re-render: reuse the cached stream, zero native calls —
      // unless an edit invalidated it, in which case it is re-derived below.
      if (entry.spans !== null) return entry.spans;
    } else if (code.startsWith(entry.prevCode)) {
      // A pure append (including one continuing a buffer an `editHighlight`
      // call advanced): re-parse only the tail. The instance's buffered source
      // tracks `prevCode` across edits, so the appended chunk is the only
      // text it has not seen.
      const result = entry.instance.append(code.slice(entry.prevCode.length));
      entry.prevCode = code;
      entry.spans = result.spans.map(spanFromRaw);
      return entry.spans;
    }
    // Not a pure append (earlier text was edited): re-highlight from scratch.
    entry.instance.reset();
    const result = entry.instance.append(code);
    entry.prevCode = code;
    entry.spans = result.spans.map(spanFromRaw);
    return entry.spans;
  } catch {
    // Defensive: any native failure degrades to the one-shot path instead of
    // poisoning the cache.
    highlightCache.delete(lang);
    return highlightCode(language, code);
  }
}

/** One mid-file edit against the source a cached incremental highlighter
 * holds: replace the byte range `[start, oldEnd)` with `newText`.
 *
 * Offsets are UTF-8 BYTES into the cached source — the unit the native
 * highlighter and `append().changed` speak — not UTF-16 code units, and they
 * must land on character boundaries. */
export interface HighlightEdit {
  /** Byte offset where the replaced range starts. */
  start: number;
  /** Byte offset where the replaced range ends (exclusive). */
  oldEnd: number;
  /** The replacement text (empty for a pure deletion). */
  newText: string;
}

/** The result of one {@link editHighlight}: the spans covering ONLY the
 * changed window of the edited source, plus that window's byte range.
 *
 * Concatenating the span texts reproduces the window of the new source exactly
 * at the reported byte offsets. The window may cut a span of the caller's
 * previous stream in half, so a consumer that keeps its own stream splices
 * `spans` in at `changed[0]` and drops the bytes it replaced — a repaint of
 * what actually changed, never the whole document. */
export interface HighlightEditResult {
  /** The spans covering only the changed window. */
  spans: Span[];
  /** The `[start, end)` byte window in the new source `spans` cover. */
  changed: [number, number];
}

/** UTF-8 codec for {@link editHighlight}'s byte-offset contract: JS strings are
 * UTF-16, the native highlighter counts UTF-8 bytes. */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** The UTF-8 byte length of `text`. */
function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/** Whether `at` is a character boundary of the UTF-8 `bytes`: position 0, the
 * end, or the first byte of a character — never one of the `0b10xxxxxx`
 * continuation bytes. */
function isCharBoundary(bytes: Uint8Array, at: number): boolean {
  return at === 0 || at === bytes.length || (bytes[at]! & 0xc0) !== 0x80;
}

/**
 * The mid-file counterpart to {@link incrementalHighlight}: replace the byte
 * range `[start, oldEnd)` of the source the cached highlighter for `language`
 * holds with `newText`, and return the spans covering ONLY the window the
 * native incremental parse reworked — a keystroke deep in a large buffer
 * re-parses its window instead of the whole file, and returns that window
 * instead of the whole document's span stream.
 *
 * The edit applies to the source the cached highlighter currently holds, so
 * the cache {@link incrementalHighlight} primes is also the cache that feeds
 * this call: a consumer that only edits can start from the empty source with
 * `{ start: 0, oldEnd: 0, newText: code }`. Because the native edit returns
 * the window alone, the cached complete stream is invalidated — the next
 * {@link incrementalHighlight} for the edited source re-derives it with one
 * full parse, while a later append continues incrementally from the edited
 * buffer.
 *
 * Returns `null` when there is nothing to highlight with: an unknown language,
 * an addon that cannot be loaded, or an edit whose byte offsets do not describe
 * a well-formed change to the cached source (out of range, inverted, or
 * inside a multi-byte character). The caller re-highlights from scratch rather
 * than splicing a wrong window.
 */
export function editHighlight(language: string, edit: HighlightEdit): HighlightEditResult | null {
  const lang = language.trim().toLowerCase();
  if (!HIGHLIGHT_LANGUAGES.has(lang)) return null;
  let addon: TernAddon;
  try {
    addon = loadAddon();
  } catch {
    return null; // the addon is unavailable — callers fall back to unstyled
  }
  if (typeof addon.IncrementalHighlighter !== "function") return null;

  let entry = highlightCache.get(lang);
  if (entry === undefined) {
    entry = {
      instance: new addon.IncrementalHighlighter(lang),
      prevCode: "",
      spans: null,
    };
    highlightCache.set(lang, entry);
  }
  const prevBytes = utf8Encoder.encode(entry.prevCode);
  if (
    !Number.isInteger(edit.start) || !Number.isInteger(edit.oldEnd) ||
    edit.start < 0 || edit.oldEnd < edit.start || edit.oldEnd > prevBytes.length ||
    !isCharBoundary(prevBytes, edit.start) || !isCharBoundary(prevBytes, edit.oldEnd)
  ) {
    // The edit does not describe a change to the source the cache holds: the
    // caller's offsets are stale (or in the wrong unit).
    return null;
  }
  if (edit.start === edit.oldEnd && edit.newText === "") {
    // A no-op edit changes nothing: an empty window, no native call, and the
    // cached complete stream stays valid.
    return { spans: [], changed: [edit.start, edit.start] };
  }
  const code = utf8Decoder.decode(prevBytes.subarray(0, edit.start)) + edit.newText +
    utf8Decoder.decode(prevBytes.subarray(edit.oldEnd));
  try {
    if (typeof entry.instance.apply_edit !== "function") {
      // A binding without the edit surface: absorb the edit through a reset and
      // a full re-append, and report the whole source as the changed window —
      // the caller repaints everything, which is what a full re-parse implies.
      entry.instance.reset();
      const result = entry.instance.append(code);
      entry.prevCode = code;
      entry.spans = result.spans.map(spanFromRaw);
      return { spans: entry.spans, changed: [0, byteLength(code)] };
    }
    const result: HighlightEditJs = entry.instance.apply_edit(edit.start, edit.oldEnd, edit.newText);
    entry.prevCode = code;
    entry.spans = null; // the window is all the binding returned
    return { spans: result.spans.map(spanFromRaw), changed: [result.changed[0], result.changed[1]] };
  } catch {
    // Defensive: any native failure degrades the caller to a full highlight
    // instead of poisoning the cache.
    highlightCache.delete(lang);
    return null;
  }
}

/**
 * Drop the cached incremental highlighters (per-language). The cache is
 * module-level and persists across renders, so a test that swaps the addon
 * (or a consumer that changes the binding) resets it through this seam —
 * the same test seam role as {@link setAddonForTesting}.
 */
export function resetIncrementalHighlightCache(): void {
  highlightCache.clear();
}

