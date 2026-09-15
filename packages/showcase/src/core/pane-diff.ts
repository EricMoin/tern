//! The diff pane's computation and its plan rows.
//!
//! WHY THIS IS NOT IN `panes.ts`. The diff is the one pane whose rows are COMPUTED
//! from two texts rather than read off a table, and the LCS that computes them is a
//! utility of its own; `panes.ts` was over its module budget and this is the
//! natural cut. The framework's own `DiffView` still composes the visible rows and
//! they are read back as plain plan rows, so nothing here builds a scene.

import { DiffView, type DiffLine } from "@tern-tui/core";
import type { PaneContext, PaneRow, PaneState } from "./panes.ts";

/** Above this many compared cells the diff degrades to a whole-file replace
 * rather than building a quadratic table for a pathological document. */
const DIFF_MAX_CELLS = 120_000;

/** The lines of text, with a trailing newline producing the empty tail line
 * the document model already has. */
function splitLines(text: string): string[] {
  return text.split("\n");
}

/** A unified diff between two texts: a context-preserving LCS at line
 * granularity, or a whole-file replace when the table would be too large. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > DIFF_MAX_CELLS) {
    const rows: DiffLine[] = [];
    for (let i = 0; i < a.length; i += 1) rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
    for (let j = 0; j < b.length; j += 1) rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
    return rows;
  }
  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1) dp.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const below = dp[i + 1]!;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "ctx", old_line: i + 1, new_line: j + 1, text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
  for (; j < b.length; j += 1) rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
  return rows;
}

/** The diff pane's rows: the framework's own unified DiffView, read back as
 * plan rows, between the buffer and the external text. */
export function diffRows(state: PaneState, ctx: PaneContext): PaneRow[] {
  if (state.external === null) return [{ text: "no external change pending" }];
  const view = DiffView({ hunks: lineDiff(ctx.bufferText, state.external), wrap: false });
  const rows: PaneRow[] = [];
  for (const row of view.children) {
    let text = "";
    for (const leaf of row.children) text += String((leaf.props as { text?: unknown }).text ?? "");
    rows.push({ text });
  }
  return rows;
}
