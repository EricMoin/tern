//! Tests: the screen plan — the region layout, the editor rows against the
//! viewport they come from, the sidebar window/marker/truncation rules, the mode
//! line's packing, the one-row and no-mode-line cases, and the 100k-line window.

import { wrapLineWithOffsets } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import { DEFAULT_LINE_HEIGHT, LineIndex } from "./lineindex.ts";
import { WrapCache } from "./wrapcache.ts";
import {
  buildPlan,
  DIRTY_MARKER,
  MIN_EDITOR_COLS,
  NO_TITLE,
  type PlanRegion,
  type ScreenPlan,
} from "./plan.ts";
import { computeViewport, DEFAULT_OVERSCAN, FILLER_LINE } from "./viewport.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** The plan's region of `kind` — throws when the plan has none, which is how a
 * layout assertion fails loudly instead of reading through `undefined`. */
function region<K extends PlanRegion["kind"]>(
  plan: ScreenPlan,
  kind: K,
): Extract<PlanRegion, { kind: K }> {
  for (const entry of plan.regions) {
    if (entry.kind === kind) return entry as Extract<PlanRegion, { kind: K }>;
  }
  throw new Error(`the plan has no ${kind} region`);
}

/** A document of `count` one-row lines, an index that knows that, and a cache
 * that has measured nothing — the state a freshly opened file is in. */
function makeDocument(count: number, width: number | null) {
  const texts: string[] = new Array(count);
  for (let line = 0; line < count; line += 1) texts[line] = `line ${line}`;
  const buffer = Buffer.fromString(texts.join("\n"));
  const index = new LineIndex(new Array<number>(count).fill(DEFAULT_LINE_HEIGHT));
  const cache = new WrapCache(index, width);
  return { texts, buffer, index, cache };
}

Deno.test("plan: the regions tile the screen and the editor rows are the viewport's", () => {
  const texts = ["alpha", "beta", "gamma"];
  const buffer = Buffer.fromString(texts.join("\n"));
  const index = new LineIndex(new Array<number>(texts.length).fill(1));
  const cache = new WrapCache(index, 20);
  const size = { rows: 5, cols: 20 };
  const plan = buildPlan({ buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 }, title: "a.txt" });

  check(plan.size.rows === 5 && plan.size.cols === 20, "the plan echoes the screen it was built for");
  check(plan.focus === "editor" && plan.dirty === false, "the editor is focused and the buffer is clean");
  check(plan.regions.length === 2, "no sidebar requested: the editor and the mode line");

  // The same window computed by hand, with no band, is the oracle the plan's rows
  // are held to: the plan lays the viewport out, it does not re-derive a row.
  const view = computeViewport({
    buffer, index, cache, size: { rows: 4, cols: 20 }, scroll: 0, caret: { row: 0, col: 0 }, overscan: 0,
  });
  const editor = region(plan, "editor");
  check(editor.x === 0 && editor.y === 0 && editor.width === 20 && editor.height === 4, "the editor is the screen above the mode line");
  check(editor.rows.length === 4, "one descriptor per cell row");
  check(editor.firstRow === view.firstRow && editor.totalRows === view.totalRows, "the window's scroll and geometry");
  const cursor = plan.cursor;
  if (cursor === null) throw new Error("the focused editor always has a cursor cell");
  for (let i = 0; i < editor.rows.length; i += 1) {
    const row = editor.rows[i]!;
    const source = view.rows[i]!;
    check(row.row === i && row.screenRow === i, `row ${i} is cell row ${i}`);
    check(row.line === source.line && row.offset === source.offset, `row ${i} shows the viewport's display row`);
    check(row.cursor === (cursor.row === i), `row ${i}'s cursor mark`);
    if (source.line === FILLER_LINE) {
      check(row.spans.length === 0 && row.width === 0, `filler row ${i} paints nothing`);
      continue;
    }
    const span = row.spans[0]!;
    check(row.spans.length === 1, `text row ${i} is one span`);
    check(span.text === source.text && span.width === source.width, `row ${i} paints the viewport's text`);
    check(span.hint === "text" && span.x === 0, `row ${i}'s span is document text at the region's edge`);
    check(row.width === source.width, `row ${i} reports the viewport's width`);
  }
  check(editor.rows[3]!.line === FILLER_LINE, "a three-line document fills the fourth row blank");
  check(cursor.row === 0 && cursor.col === 0 && cursor.visible, "the caret at the document's start is visible at the origin");
  check(cursor.position.row === 0 && cursor.position.col === 0, "and reports its document position");

  const mode = region(plan, "mode");
  check(mode.x === 0 && mode.width === 20, "the mode line spans the whole screen");
  check(mode.y === 4 && mode.height === 1, "and is the last cell row");
  check(mode.segments.length >= 3, "the mode line is made of segments");
  check(mode.segments[0]!.x === 0 && mode.segments[0]!.text.includes("EDIT"), "the mode label starts the line");
  check(mode.segments.some((s) => s.hint === "path" && s.text.includes("a.txt")), "the title is on it");
  for (let i = 0; i < mode.segments.length; i += 1) {
    const segment = mode.segments[i]!;
    check(segment.x >= 0 && segment.x + segment.width <= 20, `segment ${i} ("${segment.text}") stays on the line`);
    if (i > 0) {
      const previous = mode.segments[i - 1]!;
      check(previous.x + previous.width <= segment.x, `segment ${i} does not overlap ${i - 1}`);
    }
  }
  const last = mode.segments[mode.segments.length - 1]!;
  check(last.align === "right" && last.x + last.width === 20, "the right group ends at the screen's right edge");
});

Deno.test("plan: the sidebar takes columns off the left and the editor wraps at what is left", () => {
  const { buffer, index, cache } = makeDocument(6, 40);
  const sidebar = { items: ["a.ts", "b.ts", "c.ts"], width: 12 };
  const wide = buildPlan({ buffer, index, cache, size: { rows: 6, cols: 40 }, scroll: 0, caret: { row: 0, col: 0 }, sidebar });
  const pane = region(wide, "sidebar");
  const editor = region(wide, "editor");
  check(pane.x === 0 && pane.width === 12 && pane.height === 5, "the pane is the left columns above the mode line");
  check(pane.count === 3 && pane.scroll === 0, "and it knows the list it windows");
  check(editor.x === 12 && editor.width === 28, "the editor starts after it");
  check(cache.width === 28, "the wrap width is the editor's width, not the screen's");
  check(region(wide, "mode").width === 40, "the mode line still spans the whole screen");

  const narrow = buildPlan({ buffer, index, cache, size: { rows: 6, cols: 10 }, scroll: 0, caret: { row: 0, col: 0 }, sidebar });
  check(region(narrow, "sidebar").width === 2, "a narrow screen gives the pane the slack above the minimum");
  check(region(narrow, "editor").width === MIN_EDITOR_COLS, "and the editor keeps its minimum");

  const squeezed = buildPlan({ buffer, index, cache, size: { rows: 6, cols: MIN_EDITOR_COLS - 1 }, scroll: 0, caret: { row: 0, col: 0 }, sidebar });
  check(squeezed.regions.every((entry) => entry.kind !== "sidebar"), "below the minimum the pane is dropped entirely");
  check(region(squeezed, "editor").width === MIN_EDITOR_COLS - 1, "and the editor takes the screen");

  const empty = buildPlan({ buffer, index, cache, size: { rows: 6, cols: 40 }, scroll: 0, caret: { row: 0, col: 0 }, sidebar: { items: [], width: 12 } });
  check(empty.regions.every((entry) => entry.kind !== "sidebar"), "an empty list is not worth the columns");
});

Deno.test("plan: sidebar items are windowed, marked and truncated by the framework's cells", () => {
  const items = ["日本語テキスト", "b", "c", "d", "e", "f", "g", "h"];
  const { buffer, index, cache } = makeDocument(1, 10);
  const size = { rows: 4, cols: 18 };
  const scroll = 2;
  const plan = buildPlan({
    buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 },
    sidebar: { items, width: 8, active: 3, scroll },
  });
  const pane = region(plan, "sidebar");
  check(pane.height === 3 && pane.items.length === 3, "the pane is as tall as the body, never as long as the list");
  check(pane.items.map((item) => item.index).join(",") === "2,3,4", "starting at the clamped scroll");
  check(pane.scroll === 2 && pane.count === items.length, "and reporting where it is in the list");
  for (const item of pane.items) {
    check(item.row === item.screenRow, `item ${item.index} row is its screen row`);
    check(item.width <= pane.width, `item ${item.index} fits the pane`);
    for (const span of item.spans) check(span.x + span.width <= pane.width, `item ${item.index} span fits the pane`);
  }

  const plain = pane.items[0]!;
  check(plain.index === 2 && !plain.active && plain.spans.length === 1, "a plain item is one label span");
  check(plain.spans[0]!.hint === "sidebar-item" && plain.spans[0]!.x === 0, "at the pane's left edge");
  check(plain.spans[0]!.text === items[2], "and it is the item's own text, unwindowed at this width");

  const active = pane.items[1]!;
  check(active.active && active.spans.length === 2, "the active item carries a marker span and a label span");
  check(active.spans[0]!.text === "> " && active.spans[0]!.hint === "sidebar-marker", "the marker comes first");
  check(active.spans[1]!.hint === "sidebar-active" && active.spans[1]!.x === active.spans[0]!.width, "and the label follows it");
  check(active.spans[1]!.text === items[3], "the label is the item's own text");
  check(active.width === 3, "the item's width is the marker plus the label");

  // The wide-glyph label, plain and then active: the wrapper cuts it between
  // clusters, and the marker's two columns cost it one glyph.
  const wideLabel = buildPlan({
    buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 },
    sidebar: { items, width: 8 },
  });
  const truncated = region(wideLabel, "sidebar").items[0]!;
  check(!truncated.active && truncated.spans[0]!.text === "日本語テ", `a plain wide-glyph label fills the pane ("${truncated.spans[0]!.text}")`);
  check(truncated.width === 8, "and stops at the pane's edge, never half a glyph");

  const long = buildPlan({
    buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 },
    sidebar: { items, width: 8, active: 0 },
  });
  const marked = region(long, "sidebar").items[0]!;
  check(marked.active && marked.spans[1]!.text === "日本語", "an active label is truncated after the marker's columns");
  check(marked.width === 8, "and it too stops at the pane's edge");

  const past = buildPlan({
    buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 },
    sidebar: { items, width: 8, scroll: 99 },
  });
  check(region(past, "sidebar").scroll === items.length - 3, "a scroll past the end clamps to the last full window");
  check(past.regions.length === 3, "the whole plan is sidebar, editor and mode line");

  const focused = buildPlan({
    buffer, index, cache, size, scroll: 0, caret: { row: 0, col: 0 },
    sidebar: { items, width: 8 }, focus: "sidebar",
  });
  check(focused.cursor === null && focused.focus === "sidebar", "a sidebar focus hides the cursor cell");
  check(region(focused, "editor").rows.every((row) => !row.cursor), "and no editor row claims it");
});

Deno.test("plan: the mode line reports the caret, marks dirty, and drops what does not fit", () => {
  const texts = ["one", "two", "three"];
  const buffer = Buffer.fromString(texts.join("\n"));
  const index = new LineIndex(new Array<number>(texts.length).fill(1));
  const cache = new WrapCache(index, 30);
  const base = { buffer, index, cache, scroll: 0, title: "src/main.ts" };

  const clean = buildPlan({ ...base, size: { rows: 3, cols: 30 }, caret: { row: 1, col: 2 } });
  const mode = region(clean, "mode");
  const hints = mode.segments.map((segment) => segment.hint);
  check(hints.includes("mode") && hints.includes("path"), "the mode label and the title");
  check(hints.includes("position") && hints.includes("count"), "the caret and the line count");
  check(!hints.includes("dirty"), "a clean buffer has no marker");
  const position = mode.segments.find((segment) => segment.hint === "position")!;
  check(position.text.trim() === "2:3", `the caret is reported one-based ("${position.text.trim()}")`);
  check(mode.segments[mode.segments.length - 1] === position, "and is the rightmost thing on the line");
  check(position.x + position.width === 30, "flush with the right edge");
  const label = mode.segments.find((segment) => segment.hint === "path")!;
  check(label.text.includes("src/main.ts"), "the title is painted in full when it fits");

  buffer.insertText(0, 0, "x");
  const dirty = buildPlan({ ...base, size: { rows: 3, cols: 30 }, caret: { row: 1, col: 2 } });
  check(dirty.dirty, "the edit marked the buffer");
  check(
    region(dirty, "mode").segments.some((segment) => segment.hint === "dirty" && segment.text.includes(DIRTY_MARKER)),
    "and the mode line carries the marker",
  );

  const untitled = buildPlan({ buffer, index, cache, size: { rows: 3, cols: 30 }, scroll: 0, caret: { row: 0, col: 0 } });
  check(
    region(untitled, "mode").segments.some((segment) => segment.hint === "path" && segment.text.includes(NO_TITLE)),
    "an unnamed document falls back to the no-title label",
  );

  const narrow = buildPlan({ ...base, size: { rows: 2, cols: 6 }, caret: { row: 0, col: 0 } });
  const narrowMode = region(narrow, "mode");
  for (const segment of narrowMode.segments) {
    check(segment.x >= 0 && segment.x + segment.width <= 6, `"${segment.text}" stays on a six-cell line`);
  }
  check(narrowMode.segments.some((segment) => segment.hint === "position"), "the caret survives the narrowest line");
  check(narrowMode.segments.some((segment) => segment.hint === "mode"), "and so does the mode label, truncated");

  const single = buildPlan({ ...base, size: { rows: 1, cols: 10 }, caret: { row: 0, col: 0 } });
  check(single.regions.length === 1 && region(single, "editor").height === 1, "a one-row screen is all editor");
  const bare = buildPlan({ ...base, size: { rows: 4, cols: 10 }, caret: { row: 0, col: 0 }, modeLine: false });
  check(bare.regions.length === 1 && region(bare, "editor").height === 4, "the mode line can be turned off");
});

Deno.test("plan: the window never scales with the document", () => {
  const WIDTH = 24;
  const ROWS = 12;
  const count = 100_000;
  const texts: string[] = new Array(count);
  for (let line = 0; line < count; line += 1) texts[line] = `line ${line % 7} ${"y".repeat(40)}`;
  const buffer = Buffer.fromString(texts.join("\n"));
  // One measured height for the whole file (every line has the same shape) and an
  // empty cache: the index is the "already scrolled here" state, the window cold.
  const height = wrapLineWithOffsets(texts[0]!, WIDTH).length;
  const index = new LineIndex(new Array<number>(count).fill(height));
  const cache = new WrapCache(index, WIDTH);
  const bodyHeight = ROWS - 1;
  const scroll = Math.floor(index.totalRows / 2);
  const plan = buildPlan({
    buffer, index, cache, size: { rows: ROWS, cols: WIDTH }, scroll,
    caret: { row: index.locate(scroll).line, col: 0 }, title: "big.txt",
  });

  const editor = region(plan, "editor");
  check(editor.rows.length === bodyHeight, "the plan is the window's height, never the file's");
  check(editor.totalRows >= count, "the window knows the document is a hundred thousand lines");
  check(
    plan.stats.editor.linesTouched <= bodyHeight + DEFAULT_OVERSCAN,
    `touched ${plan.stats.editor.linesTouched} lines for a ${bodyHeight}-row window`,
  );
  check(
    plan.stats.editor.cacheWraps <= bodyHeight + DEFAULT_OVERSCAN,
    `wrapped ${plan.stats.editor.cacheWraps} lines for a ${bodyHeight}-row window`,
  );
  check(cache.wraps <= bodyHeight + DEFAULT_OVERSCAN, "and the cache measured nothing outside the window");
  check(cache.measuredLines <= cache.wraps, "every measurement came from a wrap");
  check(plan.stats.editor.caretWraps === 2, "the caret cell is a constant two measurements");
  check(plan.stats.sidebarItems === 0 && plan.stats.modeSegments > 0, "the chrome is a constant too");
  check(plan.regions.length === 2, "no sidebar: two regions at any file size");

  // The next frame, one row down, is the band the previous one prepared: it
  // wraps nothing (or the single line entering the band).
  const before = cache.wraps;
  const stepped = buildPlan({
    buffer, index, cache, size: { rows: ROWS, cols: WIDTH }, scroll: scroll + 1,
    caret: { row: index.locate(scroll + 1).line, col: 0 },
  });
  check(cache.wraps - before <= 1, `a one-row scroll wrapped ${cache.wraps - before} lines`);
  check(region(stepped, "editor").rows.length === bodyHeight, "and the window is still the region's rows");
});
