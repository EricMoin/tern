//! Editing fuzz fixtures and cursor-invariant helpers.

import { FakeTuiRenderer, state } from "./fakes.ts";
import { createRenderer, name, pasteInto } from "../index.ts";


/** Assert `actual === expected`, reporting `label` with the actual value.
 * A helper rather than inline comparisons keeps the comparison out of any
 * narrowed scope (a prior `!== 0` guard would narrow `renderCalls` to the
 * literal `0` and make a later `!== 1` check a type error). */
export function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} = ${JSON.stringify(actual)}`);
  }
}

/** The native renderer instance behind the last `createRenderer` (the fake
 * addon constructs one per renderer; its `renderCalls` counts native
 * renders). */
export function fakeRenderer(): FakeTuiRenderer {
  if (state.lastFakeRenderer === null) {
    throw new Error("no fake renderer constructed");
  }
  return state.lastFakeRenderer;
}

/** The ZWJ family emoji — ONE extended grapheme cluster of 11 code units
 * rendered in 2 terminal columns (tern-core's cluster-width convention). */
export const FAMILY_EMOJI = "👨\u200D👩\u200D👧\u200D👦";

/** A base plus a combining acute — one 2-code-unit grapheme cluster rendered
 * in 1 terminal column (the mark is zero-width). */
export const COMBINING_ACUTE = "e\u{301}";

/** The family emoji / flags / combining clusters from the Rust fuzz pool —
 * each entry is one complete extended grapheme cluster. */
const EDIT_FRAGMENTS = [
  "a",
  "b",
  "c",
  "x",
  "Hello",
  "word",
  "123",
  "text",
  "line",
  "42",
  "コ",
  "日",
  "世",
  "界",
  "中",
  "漢字",
  "ワイド",
  "👨\u200D👩\u200D👧\u200D👦", // ZWJ family — one cluster, 2 cols
  "🇷🇺", // flag — one cluster, 2 cols
  "e\u{301}", // base + combining acute — one cluster, 1 col
  "a\u{301}",
  "🚀",
  "🍣",
  "z",
  "multi",
  "word",
];

/** Single-cluster characters used for char-insert ops. */
export const EDIT_CHARS = [
  "a",
  "b",
  "x",
  "1",
  "コ",
  "日",
  "世",
  "🚀",
  "🍣",
  "e\u{301}",
];

/** The fixed default seed; `TERN_EDIT_SEED` overrides it (CI rotation). */
const EDIT_DEFAULT_SEED = 0xed17_5eed_c0de_1ce;

/** The default iteration budget; `TERN_EDIT_ROUNDS` overrides it. */
const EDIT_DEFAULT_ROUNDS = 240;

/** SplitMix64 — the same PRNG the Rust parity fuzz uses, so a given seed
 * reproduces the exact same edit sequences on every platform. */
export class EditRng {
  #state: bigint;
  constructor(seed: bigint) {
    this.#state = seed & 0xffff_ffff_ffff_ffffn;
  }
  #next(): bigint {
    this.#state = (this.#state + 0x9e37_79b9_7f4a_7c15n) &
      0xffff_ffff_ffff_ffffn;
    let z = this.#state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & 0xffff_ffff_ffff_ffffn;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & 0xffff_ffff_ffff_ffffn;
    return z ^ (z >> 31n);
  }
  /** A uniform draw in `0..n` (n > 0). */
  below(n: number): number {
    return Number(this.#next() % BigInt(n));
  }
  /** A draw that succeeds with `pct` percent probability. */
  chance(pct: number): boolean {
    return this.#next() % 100n < BigInt(pct);
  }
  /** A random element of an array. */
  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)] as T;
  }
}

/** Read the seed: `TERN_EDIT_SEED` (decimal or 0x-hex), else the fixed
 * default. Deno may deny env access on hardened hosts — that falls back to
 * the default seed too, keeping the suite green without --allow-env. */
export function editSeed(): bigint {
  try {
    const raw = Deno.env.get("TERN_EDIT_SEED");
    if (raw !== undefined && raw !== "") {
      return BigInt(raw);
    }
  } catch {
    // env denied — use the fixed default seed.
  }
  return BigInt(EDIT_DEFAULT_SEED);
}

/** Read the iteration budget: `TERN_EDIT_ROUNDS`, else the default. */
export function editRounds(): number {
  try {
    const raw = Deno.env.get("TERN_EDIT_ROUNDS");
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // env denied — use the default budget.
  }
  return EDIT_DEFAULT_ROUNDS;
}

/** Mirror of tern-core's `char_width` (cell.rs:11): 0 for NUL and
 * combining/zero-width marks, 2 for wide, 1 otherwise — an independent
 * copy so drift in the implementation is caught, not mirrored. */
function editCharWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

/** The extended grapheme clusters of `value` (UAX #29) as an independent
 * oracle: `{ start, len, width, text }` per cluster. */
export function editClusters(value: string): {
  start: number;
  len: number;
  width: number;
  text: string;
}[] {
  const runs: { start: number; len: number; width: number; text: string }[] =
    [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let start = 0;
  for (const seg of segmenter.segment(value)) {
    const text = seg.segment;
    let width = 0;
    for (const ch of text) width += editCharWidth(ch);
    runs.push({ start, len: text.length, width: Math.min(2, width), text });
    start += text.length;
  }
  return runs;
}

/** The total display width of `value` (the sum of its cluster widths). */
export function editTotalWidth(value: string): number {
  let w = 0;
  for (const run of editClusters(value)) w += run.width;
  return w;
}

/** Every display column that is a grapheme-cluster boundary of `value`,
 * including 0 and the total width. The cursor must always sit on one of
 * these. */
export function editBoundaryColumns(value: string): number[] {
  const columns = [0];
  let col = 0;
  for (const run of editClusters(value)) {
    col += run.width;
    columns.push(col);
  }
  return columns;
}

/** Build a random value from the cluster-complete fragment pool. */
export function editRandomValue(rng: EditRng): string {
  const count = rng.below(5);
  let value = "";
  for (let i = 0; i < count; i++) value += rng.pick(EDIT_FRAGMENTS);
  return value;
}

/** The invariant core shared by every edit fuzz suite: assert the cursor
 * rests on a cluster boundary of `value` and stays within the painted
 * width. `label` names the failing edit for the error message. */
export function assertEditCursorInvariant(
  value: string,
  caret: number,
  label: string,
): void {
  const columns = editBoundaryColumns(value);
  if (!columns.includes(caret)) {
    throw new Error(
      `${label}: cursor ${caret} is not a grapheme-cluster boundary of ` +
        `${JSON.stringify(value)} (boundaries: [${columns.join(", ")}])`,
    );
  }
  if (caret < 0 || caret > editTotalWidth(value)) {
    throw new Error(
      `${label}: cursor ${caret} outside the painted width of ${
        JSON.stringify(value)
      }`,
    );
  }
}

/** Map an op code to its key name for diagnostics. */
export function editKeyEventName(code: number): string {
  return ["char", "backspace", "left", "right", "home", "end"][code] ?? "?";
}

/** The code-unit index of the cluster boundary at `column` display columns
 * (the inverse of `indexToColumn`, over the boundary set): the splice
 * point `pasteInto` uses. `column` must be a boundary column of `value`. */
export function boundaryIndexAt(value: string, column: number): number {
  let col = 0;
  for (const run of editClusters(value)) {
    if (col === column) return run.start;
    col += run.width;
  }
  return value.length;
}
