//! The DiffView element: unified and side-by-side diffs.

import { Box, Node, Text } from "./node.ts";
import type { NodeProps } from "./types.ts";
/** The kind of a unified-diff line. */
export type DiffLineKind = "add" | "del" | "ctx";

/** One line of a unified diff. `old_line` / `new_line` are the line numbers
 * in the old/new file, or 0 when the line has no counterpart on that side
 * (a pure addition has no old line; a pure deletion has no new line). */
export interface DiffLine {
  /** The line kind: added / deleted / context. */
  kind: DiffLineKind;
  /** The line number in the old file (0 for pure additions). */
  old_line: number;
  /** The line number in the new file (0 for pure deletions). */
  new_line: number;
  /** The line content, without the leading marker char. */
  text: string;
}

/** Props for the `DiffView` element. `hunks`/`mode`/`inline_highlight` are
 * consumed by the factory (the line model is JS bookkeeping — it never
 * reaches the scene props, mirroring `Panels`); the remaining style/layout
 * props flow to the root box, which is the scrollable clip region
 * (`scroll_x` / `scroll_y` pan the composed rows).
 */
export interface DiffViewProps extends NodeProps {
  /** The unified-diff lines to render, in scene order. */
  hunks: DiffLine[];
  /**
   * Layout mode (default `"unified"`): `"unified"` renders each hunk line as
   * one full-width row; `"side"` renders two aligned columns (old | new)
   * split by the `Panels` flex-row machinery — each hunk line becomes one
   * row per column, aligned by line pair, with per-column gutters.
   */
  mode?: "unified" | "side";
  /**
   * Intra-line char-level highlighting (default `false`): for each adjacent
   * add/del line pair a char-level diff is computed and the changed segments
   * render bold + underlined on top of the line's kind color, leaving
   * unchanged characters plain.
   */
  inline_highlight?: boolean;
  /** The horizontal scroll offset in cells (default 0) — pans the rows
   * inside the clip region. */
  scroll_x?: number;
  /** The vertical scroll offset in cells (default 0) — pans the rows inside
   * the clip region. */
  scroll_y?: number;
  /**
   * Passed through to each content text leaf: `false` keeps every diff line
   * single-row (no soft wrap — the compositor trims overflow at the right
   * edge, the classic diff look); `true`/unset soft-wraps at word boundaries.
   */
  wrap?: boolean;
}

/** The default fg color for added lines (matches the default theme's
 * `success` green — diff greens read as "incoming"). */
export const DIFF_ADD_FG = "#98c379";

/** The default fg color for deleted lines (matches the default theme's
 * `danger` red — diff reds read as "removed"). */
export const DIFF_DEL_FG = "#e06c75";

/** The widest line number in `hunks`, so every gutter column aligns. */
function diffGutterWidth(hunks: DiffLine[]): number {
  let width = 1;
  for (const line of hunks) {
    width = Math.max(
      width,
      String(line.old_line).length,
      String(line.new_line).length,
    );
  }
  return width;
}

/** One gutter cell: the line number right-aligned to `width`, or blank when
 * the line has no number on this side (0). */
function diffGutterCell(
  line: DiffLine,
  width: number,
  side: "old" | "new",
): string {
  const number = side === "old" ? line.old_line : line.new_line;
  return number > 0 ? String(number).padStart(width) : " ".repeat(width);
}

/** The gutter text for one line: `old new`, each column right-aligned to the
 * widest line number. */
function diffGutterText(line: DiffLine, width: number): string {
  return `${diffGutterCell(line, width, "old")} ${
    diffGutterCell(line, width, "new")
  }`;
}

/** The per-kind style stamped on a line's marker and content: added lines
 * green, deleted lines red, context lines dimmed. */
function diffKindStyle(kind: DiffLineKind): NodeProps {
  switch (kind) {
    case "add":
      return { fg: DIFF_ADD_FG };
    case "del":
      return { fg: DIFF_DEL_FG };
    case "ctx":
      return { dim: true };
  }
}

/** The distinct style stamped on changed characters of an intra-line
 * highlighted segment: bold + underline on top of the line's kind color. */
const DIFF_CHANGED_STYLE: NodeProps = { bold: true, underline: true };

/** The LCS DP guard for {@link diffChars}: pairs whose line lengths would
 * exceed this many table cells fall back to whole-line highlighting, so
 * pathological long lines stay cheap. */
const DIFF_CHAR_DIFF_MAX_CELLS = 40_000;

/** One run of a char-level diff: `keep` chars appear on both sides, `del`
 * chars only in the old line, `add` chars only in the new line. */
interface DiffCharRun {
  kind: "keep" | "del" | "add";
  text: string;
}

/**
 * A small LCS edit script at char granularity between two diff line texts.
 * Returns the aligned runs in scene order (old side: `keep` + `del`; new
 * side: `keep` + `add`). When the DP table would exceed
 * {@link DIFF_CHAR_DIFF_MAX_CELLS} cells, both whole lines are reported as
 * changed — intra-line precision degrades gracefully on pathological input
 * instead of stalling the factory. This is JS bookkeeping (the markdown
 * inline parser is the same shape): the rendering stays in the Rust engine.
 */
function diffChars(oldText: string, newText: string): DiffCharRun[] {
  const n = oldText.length;
  const m = newText.length;
  if (n * m > DIFF_CHAR_DIFF_MAX_CELLS) {
    const runs: DiffCharRun[] = [];
    if (n > 0) runs.push({ kind: "del", text: oldText });
    if (m > 0) runs.push({ kind: "add", text: newText });
    return runs;
  }
  // dp[i][j] = LCS length of oldText[0..i) and newText[0..j).
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) {
    const row = new Uint16Array(m + 1);
    if (i > 0) {
      const above = dp[i - 1]!;
      const ch = oldText[i - 1]!;
      for (let j = 1; j <= m; j++) {
        row[j] = ch === newText[j - 1]
          ? above[j - 1]! + 1
          : Math.max(above[j]!, row[j - 1]!);
      }
    }
    dp.push(row);
  }
  // Walk the table back from (n, m), collecting the edit script in reverse.
  const ops: Array<{ kind: DiffCharRun["kind"]; ch: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      ops.push({ kind: "keep", ch: oldText[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ kind: "add", ch: newText[j - 1]! });
      j -= 1;
    } else {
      ops.push({ kind: "del", ch: oldText[i - 1]! });
      i -= 1;
    }
  }
  ops.reverse();
  // Group consecutive same-kind ops into runs.
  const runs: DiffCharRun[] = [];
  for (const op of ops) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === op.kind) last.text += op.ch;
    else runs.push({ kind: op.kind, text: op.ch });
  }
  return runs;
}

/**
 * Pair adjacent add/del lines within each maximal run of change lines: the
 * i-th deleted line pairs with the i-th added line of the same run (context
 * lines break runs, so only adjacent pairs are considered). Lines without a
 * counterpart are left unpaired.
 */
function diffLinePairs(
  hunks: readonly DiffLine[],
): Array<[DiffLine, DiffLine]> {
  const pairs: Array<[DiffLine, DiffLine]> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i++) pairs.push([dels[i]!, adds[i]!]);
    dels = [];
    adds = [];
  };
  for (const line of hunks) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else flush();
  }
  flush();
  return pairs;
}

/** Map every paired line to its `[del, add]` pair for intra-line
 * highlighting (unpaired lines are absent). */
function diffPairMap(
  hunks: readonly DiffLine[],
): Map<DiffLine, [DiffLine, DiffLine]> {
  const map = new Map<DiffLine, [DiffLine, DiffLine]>();
  for (const pair of diffLinePairs(hunks)) {
    map.set(pair[0], pair);
    map.set(pair[1], pair);
  }
  return map;
}

/** One styled segment of a diff line's content: `changed` characters are
 * additionally bold + underlined on top of the line's kind color; plain
 * segments carry just the kind color. */
interface DiffLineSegment {
  text: string;
  changed: boolean;
}

/** Append `text` with flag `changed`, merging into the previous segment when
 * its flag matches (keeps the leaf count minimal). */
function appendSegment(
  segments: DiffLineSegment[],
  text: string,
  changed: boolean,
): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

/**
 * Split one line's text into plain/changed segments against its paired line
 * (`pair` = `[del, add]`; `line` is one of them). Unpaired lines yield one
 * plain segment carrying the whole text. The pair's other side contributes
 * nothing to this line's text, so the segments always re-join the original
 * text exactly.
 */
function diffLineSegments(
  line: DiffLine,
  pair: [DiffLine, DiffLine] | undefined,
): DiffLineSegment[] {
  if (pair === undefined) return [{ text: line.text, changed: false }];
  const isDel = line === pair[0];
  const segments: DiffLineSegment[] = [];
  for (const run of diffChars(pair[0].text, pair[1].text)) {
    if (run.kind === "keep") appendSegment(segments, run.text, false);
    else if ((isDel && run.kind === "del") || (!isDel && run.kind === "add")) {
      appendSegment(segments, run.text, true);
    }
  }
  if (segments.length === 0) return [{ text: "", changed: false }];
  return segments;
}

/** Compose a line's content into scene nodes: a single `Text` leaf when the
 * line is one uniform segment (the common case), or a flex row of per-segment
 * `Text` leaves when intra-line highlighting splits it — mirroring
 * `markdownLineNode`. `base` is the line's kind style; changed segments get
 * `DIFF_CHANGED_STYLE` on top.
 */
function diffContentNode(
  segments: DiffLineSegment[],
  base: NodeProps,
  wrap: boolean | undefined,
): Node {
  if (segments.length === 1) {
    const segment = segments[0]!;
    const props: NodeProps = { text: segment.text, ...base };
    if (segment.changed) Object.assign(props, DIFF_CHANGED_STYLE);
    if (wrap !== undefined) props.wrap = wrap;
    return Text(props);
  }
  const leaves = segments.map((segment) => {
    const props: NodeProps = { text: segment.text, ...base };
    if (segment.changed) Object.assign(props, DIFF_CHANGED_STYLE);
    if (wrap !== undefined) props.wrap = wrap;
    return Text(props);
  });
  return Box({ flex_direction: "row" }, ...leaves);
}

/** Build one unified diff row: a flex row of the dimmed gutter (old/new line
 * numbers), the `+`/`-`/` ` marker, and the line content. With
 * `inlineHighlight` and a paired line, the content is split into plain and
 * changed (bold + underlined) segments at char granularity. */
function buildDiffRow(
  line: DiffLine,
  width: number,
  wrap: boolean | undefined,
  pair: [DiffLine, DiffLine] | undefined,
  inlineHighlight: boolean,
): Node {
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const style = diffKindStyle(line.kind);
  const content = inlineHighlight
    ? diffContentNode(diffLineSegments(line, pair), style, wrap)
    : Text({
      text: line.text,
      ...style,
      ...(wrap !== undefined ? { wrap } : {}),
    });
  return Box(
    { flex_direction: "row" },
    Text({ text: diffGutterText(line, width), dim: true }),
    Text({ text: marker, ...style }),
    content,
  );
}

/** The widest line number on one side of `hunks`, so each side-by-side
 * column's gutter aligns on its own numbers. */
function diffSideGutterWidth(
  hunks: readonly DiffLine[],
  side: "old" | "new",
): number {
  let width = 1;
  for (const line of hunks) {
    const number = side === "old" ? line.old_line : line.new_line;
    width = Math.max(width, String(number).length);
  }
  return width;
}

/**
 * Build one side-by-side column cell for a hunk line: the same gutter /
 * marker / content shape as a unified row, but the column shows only its own
 * side — the old column renders deletions and context (additions blank), the
 * new column renders additions and context (deletions blank). `width` is the
 * side's own gutter width. With `inlineHighlight`, paired lines highlight
 * their changed chars exactly as in unified mode.
 */
function buildSideCell(
  line: DiffLine,
  side: "old" | "new",
  width: number,
  wrap: boolean | undefined,
  pair: [DiffLine, DiffLine] | undefined,
  inlineHighlight: boolean,
): Node {
  const owns = side === "old" ? line.kind !== "add" : line.kind !== "del";
  const style = side === "old"
    ? line.kind === "del"
      ? { fg: DIFF_DEL_FG }
      : line.kind === "ctx"
      ? { dim: true }
      : {}
    : line.kind === "add"
    ? { fg: DIFF_ADD_FG }
    : line.kind === "ctx"
    ? { dim: true }
    : {};
  const marker = side === "old"
    ? line.kind === "del" ? "-" : " "
    : line.kind === "add"
    ? "+"
    : " ";
  const content = !owns
    ? Text({ text: "" })
    : inlineHighlight
    ? diffContentNode(diffLineSegments(line, pair), style, wrap)
    : Text({
      text: line.text,
      ...style,
      ...(wrap !== undefined ? { wrap } : {}),
    });
  return Box(
    { flex_direction: "row" },
    Text({ text: diffGutterCell(line, width, side), dim: true }),
    Text({ text: marker, ...style }),
    content,
  );
}

/**
 * Create a `diff` element: a column of per-line rows rendering a unified
 * diff, or two aligned columns rendering it side by side. Each hunk line
 * becomes a flex row of three `text` leaves — a dimmed gutter (old/new line
 * numbers, right-aligned to the widest number), a `+`/`-`/` ` marker, and
 * the line content — styled per kind: added lines green (`DIFF_ADD_FG`),
 * deleted lines red (`DIFF_DEL_FG`), context lines dimmed. With
 * `inline_highlight`, each adjacent add/del pair is char-diffed and its
 * changed segments render bold + underlined on top of the kind color. With
 * `mode: "side"`, the root becomes a flex row of two columns (old | new,
 * split with a 1-cell gap like `Panels`), each column one row per hunk line
 * with its own gutter — rows align by line pair. The root box is the
 * scrollable clip region: `scroll_x` / `scroll_y` pan the whole diff inside
 * it (multiple hunks scroll as one region), and the `wrap` prop passes
 * through to each content leaf. No new napi node kind: the `diff` element
 * materializes as a `box` (constitution).
 */
export function DiffView(props: DiffViewProps): Node {
  const mode = props.mode ?? "unified";
  const inline = props.inline_highlight ?? false;
  const pairs = inline
    ? diffPairMap(props.hunks)
    : new Map<DiffLine, [DiffLine, DiffLine]>();
  const rootProps: NodeProps = {
    ...props,
    flex_direction: mode === "side" ? "row" : "column",
  };
  // The 1-cell gutter between the two side-by-side columns (mirroring the
  // `Panels` flex-row split). An explicit `gap` wins — `gap: 0` removes it.
  if (mode === "side" && rootProps.gap === undefined) rootProps.gap = 1;
  const plain = rootProps as Record<string, unknown>;
  delete plain.hunks;
  delete plain.mode;
  delete plain.inline_highlight;
  let children: Node[];
  if (mode === "side") {
    const oldWidth = diffSideGutterWidth(props.hunks, "old");
    const newWidth = diffSideGutterWidth(props.hunks, "new");
    const oldRows: Node[] = [];
    const newRows: Node[] = [];
    for (const line of props.hunks) {
      const pair = pairs.get(line);
      oldRows.push(
        buildSideCell(line, "old", oldWidth, props.wrap, pair, inline),
      );
      newRows.push(
        buildSideCell(line, "new", newWidth, props.wrap, pair, inline),
      );
    }
    children = [
      Box({ flex_direction: "column" }, ...oldRows),
      Box({ flex_direction: "column" }, ...newRows),
    ];
  } else {
    const width = diffGutterWidth(props.hunks);
    children = props.hunks.map((line) =>
      buildDiffRow(line, width, props.wrap, pairs.get(line), inline)
    );
  }
  return Node.create("diff", rootProps, children);
}

