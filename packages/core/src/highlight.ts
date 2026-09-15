//! Syntax highlighting: the one-shot and incremental code highlighters.

import { HIGHLIGHT_LANGUAGES, spanFromRaw } from "./modal.ts";
import type { Span } from "./types.ts";

import { loadAddon } from "./addon.ts";
import type { NativeIncrementalHighlighter, TernAddon } from "./addon.ts";
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
  spans: Span[];
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
 * re-appended (a non-append edit cannot reuse the head). The span contract
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
      // An unchanged re-render: reuse the cached stream, zero native calls.
      return entry.spans;
    }
    if (code.startsWith(entry.prevCode)) {
      // A pure append: re-parse only the tail.
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

/**
 * Drop the cached incremental highlighters (per-language). The cache is
 * module-level and persists across renders, so a test that swaps the addon
 * (or a consumer that changes the binding) resets it through this seam —
 * the same test seam role as {@link setAddonForTesting}.
 */
export function resetIncrementalHighlightCache(): void {
  highlightCache.clear();
}

