//! Cell-accurate text measurement: escape stripping and grapheme cluster maths.

/**
 * The escape-stripped view of a string: the visible text and the code-unit
 * map back to the original string.
 */
interface StrippedView {
  /** The text with every escape sequence removed. */
  text: string;
  /** For each code-unit offset `s` in `0..=text.length`, the code-unit
   * offset in the original string where stripped offset `s` begins
   * (`orig[text.length]` is the original length). Strictly ascending. */
  orig: number[];
}

/**
 * Strip ANSI/OSC/CSI escape sequences from `value` — the "strip at
 * ingestion" rule the entire measurement path shares with its tern-core
 * mirror (`strip_escapes`, cell.rs), which documents the same contract.
 * Escape sequences occupy no terminal columns and never enter the
 * cluster/cell model, so measurement and painting agree by construction:
 * stripping happens before grapheme segmentation — an escape's bytes would
 * otherwise segment as their own clusters (ESC is a control boundary, and
 * the printable CSI payload bytes like `[31m` are ordinary width-1
 * characters), corrupting both width and text.
 *
 * The rule, byte-identical across both sides:
 *
 * - **CSI** — the introducer `ESC [` (0x1B 0x5B) or the C1 CSI single
 *   character 0x9B, followed by any run of characters up to and including
 *   the first **final byte** in 0x40–0x7E (a *tolerant* scan, not a strict
 *   grammar: any character before the final byte is consumed as part of the
 *   sequence, so malformed control data is removed rather than painted). A
 *   sequence truncated at the end of the string (no final byte) strips to
 *   the end of the string.
 * - **OSC** — the introducer `ESC ]` (0x1B 0x5D), followed by any
 *   characters up to and including the first terminator: BEL (0x07), ST as
 *   `ESC \` (0x1B 0x5C), or the C1 ST single character 0x9C. A bare `ESC`
 *   inside the body that is not followed by `\` is a body character, not a
 *   terminator. A sequence truncated at the end of the string (no
 *   terminator) strips to the end of the string.
 *
 * Everything else is kept as-is — including a lone `ESC` that introduces
 * neither CSI nor OSC (it measures 1 in {@link charWidth}, like any other
 * control character), and C1 bytes outside the rule such as the C1 OSC
 * start 0x9D. `orig[s]` is the code-unit index in `value` where stripped
 * offset `s` begins (`orig[text.length]` is `value.length`); every offset a
 * consumer emits is translated through this map, so it stays exact and
 * never points inside an escape.
 */
export function stripEscapes(value: string): StrippedView {
  const kept: string[] = [];
  const orig: number[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    const code = value.charCodeAt(i);
    const isEsc = code === 0x1b;
    const next = i + 1 < n ? value.charCodeAt(i + 1) : -1;
    // OSC: ESC ] — payload to the first terminator (BEL 0x07, the two-byte
    // ST ESC \, or the C1 ST 0x9C), terminator consumed; a bare ESC not
    // followed by `\` is a body character; a truncated OSC (no terminator
    // before the end of the string) strips to the end.
    if (isEsc && next === 0x5d) {
      let j = i + 2;
      while (j < n) {
        const c = value.charCodeAt(j);
        if (c === 0x07) {
          j += 1; // BEL terminates
          break;
        }
        if (c === 0x1b && j + 1 < n && value.charCodeAt(j + 1) === 0x5c) {
          j += 2; // ST (ESC \) terminates
          break;
        }
        if (c === 0x9c) {
          j += 1; // C1 ST terminates
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    // CSI: ESC [ or the C1 CSI lead 0x9B — a tolerant scan up to and
    // including the first final byte (0x40–0x7E); any character before it
    // is part of the sequence. A truncated CSI (no final byte before the
    // end of the string) strips to the end.
    if ((isEsc && next === 0x5b) || code === 0x9b) {
      let j = isEsc ? i + 2 : i + 1;
      while (j < n) {
        const c = value.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j += 1; // the final byte — consumed
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    kept.push(value[i]!);
    orig.push(i);
    i += 1;
  }
  orig.push(n);
  return { text: kept.join(""), orig };
}

/** The largest stripped offset `s` with `orig[s] <= index` — a binary search
 * over the strictly ascending strip map (see {@link stripEscapes}). Every
 * original index maps to the stripped offset whose original position is at
 * or before it: `0` when `index` precedes every kept character. */
export function strippedIndexAt(orig: number[], index: number): number {
  let lo = 0;
  let hi = orig.length - 1; // orig[hi] is the original length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (orig[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The display width of a character in terminal columns, mirroring
 * tern-core's `char_width` (cell.rs:11): 0 for NUL and combining/zero-width
 * marks, 2 for wide (CJK / fullwidth) characters, 1 otherwise. Escape
 * sequences never reach this function — they are stripped at ingestion (see
 * {@link stripEscapes}) — so a stray kept control byte (e.g. a lone `ESC`)
 * measures 1, exactly like tern-core's fallback.
 */
function charWidth(ch: string): number {
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

/**
 * One grapheme cluster of a value: its code-unit start, its text, and its
 * display width in terminal columns (the tern-core `cluster_width`
 * convention — cell.rs:75).
 */
interface ClusterRun {
  /** The code-unit index where the cluster starts. */
  start: number;
  /** The cluster's length in code units. */
  len: number;
  /** The display width in columns: 1, 2, or 0 (a lone zero-width mark). */
  width: number;
  /** The cluster's full text (e.g. `"👨‍👩‍👧‍👦"` or `"e\u{301}"`). */
  text: string;
}

/** The lazily-created shared grapheme segmenter, or `null` once a runtime
 * without `Intl.Segmenter` is observed (the documented fallback below). */
let graphemeSegmenterInstance: Intl.Segmenter | null | undefined;

/** The shared `Intl.Segmenter` (granularity `"grapheme"`), or `null` when the
 * runtime lacks it. Both declared runtimes ship it — Deno's full ICU and
 * Node >= 20 (full-icu) — so the fallback only fires on exotic hosts. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenterInstance === undefined) {
    graphemeSegmenterInstance =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return graphemeSegmenterInstance;
}

/**
 * The extended grapheme clusters of `value` (UAX #29), each with its
 * code-unit offset, its text, and its display width — the atom every edit in
 * this layer moves by. Escape sequences (ANSI/OSC/CSI, see
 * {@link stripEscapes}) are stripped at ingestion: they consume zero cells
 * and emit no run, so every cluster `start` is a code-unit index into the
 * ORIGINAL `value` (translated through the strip map) and never points
 * inside an escape — a caret's display column lands on the visible character
 * after one. When `Intl.Segmenter` is unavailable the documented fallback
 * splits on code points (surrogate pairs stay whole), so combining sequences
 * and ZWJ emoji degrade to per-code-point steps instead of mid-cluster
 * corruption.
 */
export function clusterRuns(value: string): ClusterRun[] {
  const { text, orig } = stripEscapes(value);
  const runs: ClusterRun[] = [];
  const segmenter = graphemeSegmenter();
  if (segmenter !== null) {
    let start = 0;
    for (const seg of segmenter.segment(text)) {
      const segText = seg.segment;
      runs.push({
        start: orig[start]!,
        len: segText.length,
        width: clusterWidth(segText),
        text: segText,
      });
      start += segText.length;
    }
    return runs;
  }
  // Fallback: iterate code points (`for...of` over a string yields one code
  // point per iteration, keeping surrogate pairs whole).
  let start = 0;
  for (const ch of text) {
    runs.push({
      start: orig[start]!,
      len: ch.length,
      width: charWidth(ch),
      text: ch,
    });
    start += ch.length;
  }
  return runs;
}

/**
 * The display width of one grapheme cluster in terminal columns, mirroring
 * tern-core's `cluster_width` (cell.rs:75): the sum of its member
 * characters' {@link charWidth}s, clamped to 2. A ZWJ emoji sequence or a
 * flag sums well past 2 but renders in exactly 2 columns; a base-plus-
 * combining sequence sums to its base's width; a lone zero-width mark sums
 * to 0.
 */
function clusterWidth(cluster: string): number {
  let width = 0;
  for (const ch of cluster) width += charWidth(ch);
  return Math.min(2, width);
}

/**
 * The code-unit index whose leading edge sits at (or snaps back before)
 * `column` display columns — always a grapheme-cluster boundary. Used to
 * translate the caret's display column — the value the compositor paints —
 * into a string index for editing. `column` always lands on a cluster
 * boundary: a column inside a wide cluster snaps to that cluster's start.
 * Escape sequences are skipped (they emit no run), so the returned index is
 * the original position of the visible character — a caret at column 0 of a
 * colored line rests before its first visible character, never inside the
 * leading escape.
 */
export function columnToIndex(value: string, column: number): number {
  let col = 0;
  for (const run of clusterRuns(value)) {
    if (col + run.width > column) return run.start;
    col += run.width;
  }
  return value.length;
}

/** The display column of the cluster boundary at `index` (code units). A
 * mid-cluster index counts the containing cluster's full width — a cluster
 * is one glyph, so the caret cannot rest inside it. */
export function indexToColumn(value: string, index: number): number {
  let col = 0;
  for (const run of clusterRuns(value)) {
    if (run.start >= index) break;
    col += run.width;
  }
  return col;
}

/** The last grapheme cluster before `index` (a mid-cluster index snaps back
 * to its containing cluster), or `null` when `index` is 0. */
export function lastClusterBefore(value: string, index: number): ClusterRun | null {
  let last: ClusterRun | null = null;
  for (const run of clusterRuns(value)) {
    if (run.start >= index) break;
    last = run;
  }
  return last;
}

/** The cluster starting at `index` — or, defensively, containing a mid-
 * cluster `index` — or `null` at the end of `value`. */
export function clusterAt(value: string, index: number): ClusterRun | null {
  for (const run of clusterRuns(value)) {
    if (run.start >= index) return run.start === index ? run : null;
    if (index < run.start + run.len) return run;
  }
  return null;
}

/** Snap a code-unit index to the grapheme-cluster boundary its caret rests
 * on: a mid-cluster index maps to the boundary AFTER its containing cluster —
 * where the caret visually paints, since `indexToColumn` counts a cluster
 * whole — and a boundary index is unchanged. The textarea counterpart of
 * `columnToIndex`'s wide-glyph snap, in code-unit space. */
export function snapToClusterEnd(value: string, index: number): number {
  for (const run of clusterRuns(value)) {
    if (run.start >= index) return index;
    if (index < run.start + run.len) return run.start + run.len;
  }
  return index;
}

