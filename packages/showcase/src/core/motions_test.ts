//! Tests: the motions — graphemes, words, paragraphs, and the sticky
//! display-column vertical model over wrapped and short lines.

import { wrapLineWithOffsets } from "@tern-tui/core";
import { Buffer, type Position } from "./buffer.ts";
import { LineIndex } from "./lineindex.ts";
import { applyMotion, displayCellOf, NO_GOAL, type Motion, type MotionContext } from "./motions.ts";
import { WrapCache } from "./wrapcache.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A measured document: every line's height is what the wrapper really reports
 * at `width`, so the index's geometry is the viewport's, not an estimate. */
function doc(lines: string[], width: number | null = null): MotionContext {
  const buffer = Buffer.fromString(lines.join("\n"));
  const heights = lines.map((line) => wrapLineWithOffsets(line, width).length);
  const index = new LineIndex(heights);
  return { buffer, index, cache: new WrapCache(index, width) };
}

/** Where `motion` leaves the caret. */
function move(ctx: MotionContext, from: Position, motion: Motion, goal = NO_GOAL): Position {
  return applyMotion(ctx, from, motion, goal).position;
}

/** A position as `row:col`. */
function at(position: Position): string {
  return `${position.row}:${position.col}`;
}

Deno.test("motions: a character step is a grapheme cluster, never a code unit", () => {
  // A family emoji is one cluster of eight code units; "e" + U+0301 is one
  // cluster of two. Neither may be split by a one-character motion.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  check(family.length === 8, "the family emoji is eight code units, one cluster");
  const ctx = doc([`a${family}b`, "e\u0301x"]);

  check(at(move(ctx, { row: 0, col: 0 }, "char-forward")) === "0:1", "a step right leaves 'a'");
  check(at(move(ctx, { row: 0, col: 1 }, "char-forward")) === `0:${1 + family.length}`,
    "and crosses the whole cluster in one step");
  check(at(move(ctx, { row: 0, col: 1 + family.length }, "char-backward")) === "0:1",
    "one step left crosses it back");
  check(at(move(ctx, { row: 1, col: 2 }, "char-backward")) === "1:0",
    "a combining mark moves with its base letter");
  check(at(move(ctx, { row: 1, col: 2 }, "char-forward")) === "1:3",
    "and forward leaves the pair together");

  check(at(move(ctx, { row: 0, col: 0 }, "char-backward")) === "0:0", "the document's start holds");
  check(at(move(ctx, { row: 1, col: 3 }, "char-forward")) === "1:3", "and so does the last line's end");
  check(at(move(ctx, { row: 0, col: ctx.buffer.lineAt(0).length }, "char-forward")) === "1:0",
    "a step right at a line's end reaches the next line");
  check(at(move(ctx, { row: 1, col: 0 }, "char-backward")) === "0:10",
    "and one left reaches the line above's end");
});

Deno.test("motions: word motions treat punctuation as a word and cross lines", () => {
  const ctx = doc(["alpha beta", "  gamma, delta"]);
  check(at(move(ctx, { row: 0, col: 0 }, "word-forward")) === "0:6", "w lands on the next word");
  check(at(move(ctx, { row: 0, col: 3 }, "word-forward")) === "0:6", "from inside a word too");
  check(at(move(ctx, { row: 0, col: 9 }, "word-forward")) === "1:7",
    "a line with none hands off to the next word");
  check(at(move(ctx, { row: 1, col: 7 }, "word-forward")) === "1:9", "punctuation is a word of its own");
  check(at(move(ctx, { row: 1, col: 13 }, "word-forward")) === "1:14", "nothing follows the last run");
  check(at(move(ctx, { row: 1, col: 14 }, "word-forward")) === "1:14", "not even from the line's end");

  check(at(move(ctx, { row: 0, col: 6 }, "word-backward")) === "0:0", "b lands on the word's start");
  check(at(move(ctx, { row: 0, col: 3 }, "word-backward")) === "0:0", "from inside the word too");
  check(at(move(ctx, { row: 1, col: 8 }, "word-backward")) === "1:7", "backward stops at punctuation");
  check(at(move(ctx, { row: 1, col: 2 }, "word-backward")) === "0:6", "and crosses to the line above");
  check(at(move(ctx, { row: 0, col: 0 }, "word-backward")) === "0:0", "the first word has nothing before it");
});

Deno.test("motions: paragraph motions jump between runs of non-blank lines", () => {
  const ctx = doc(["p1a", "p1b", "", "p2a", "p2b", "", "", "p3"]);
  check(at(move(ctx, { row: 0, col: 2 }, "paragraph-forward")) === "3:0", "forward takes the next block");
  check(at(move(ctx, { row: 3, col: 1 }, "paragraph-forward")) === "7:0", "blank separators are skipped");
  check(at(move(ctx, { row: 2, col: 0 }, "paragraph-forward")) === "3:0", "a blank line is part of the gap");
  check(at(move(ctx, { row: 7, col: 0 }, "paragraph-forward")) === "7:0", "the last block has no next");

  check(at(move(ctx, { row: 4, col: 1 }, "paragraph-backward")) === "3:0", "backward takes this block's first line");
  check(at(move(ctx, { row: 3, col: 0 }, "paragraph-backward")) === "0:0", "and again leaves it upward");
  check(at(move(ctx, { row: 7, col: 0 }, "paragraph-backward")) === "3:0", "landing on the block above");
  check(at(move(ctx, { row: 0, col: 0 }, "paragraph-backward")) === "0:0", "the first block has no previous");
});

Deno.test("motions: a line step is a DISPLAY row, and the column is sticky", () => {
  // At width 10 the first line wraps into two rows, so display row 1 is still
  // line 0 — a LOGICAL line step would skip the whole wrapped row.
  const ctx = doc(["0123456789abcdefghij", "xx", "yyyyyyyyyyyy"], 10);
  check(ctx.index.totalRows === 5, "two wrapped rows, one short line, two wrapped rows");

  const down = applyMotion(ctx, { row: 0, col: 7 }, "line-down");
  check(at(down.position) === "0:17", `a row down stays inside the wrapped line (${at(down.position)})`);
  check(down.goal === 7, "and remembers the column the user meant");

  const short = applyMotion(ctx, down.position, "line-down", down.goal);
  check(at(short.position) === "1:2", "the short line clamps to its own end");
  check(short.goal === 7, "but the goal survives the clamp");

  const back = applyMotion(ctx, short.position, "line-down", short.goal);
  check(at(back.position) === "2:7", `the next long line restores the column (${at(back.position)})`);
  check(back.goal === 7, "with the same goal");
  check(at(applyMotion(ctx, back.position, "line-up", back.goal).position) === "1:2",
    "and going back up clamps again");

  const edge = applyMotion(ctx, { row: 0, col: 3 }, "line-up");
  check(at(edge.position) === "0:3", "the first row cannot move up");
  check(edge.goal === 3, "and adopts the caret's column as the goal");

  // A caret with no goal adopts its own display column, which is what makes a
  // plain "up then down" a round trip through a short line.
  const up = applyMotion(ctx, { row: 2, col: 9 }, "line-up");
  check(at(up.position) === "1:2", "up onto the short line clamps");
  check(at(applyMotion(ctx, up.position, "line-down", up.goal).position) === "2:9",
    "down after up returns to the column it left");
});

Deno.test("motions: home and end are the DISPLAY row's ends and pin the goal", () => {
  const ctx = doc(["0123456789abcdefghij"], 10);
  const start = applyMotion(ctx, { row: 0, col: 17 }, "line-start");
  check(at(start.position) === "0:10", "home goes to the wrapped row's first cell");
  check(start.goal === 0, "and pins the goal to column 0");

  const end = applyMotion(ctx, { row: 0, col: 12 }, "line-end");
  check(at(end.position) === "0:20", "end goes to the wrapped row's last cell");
  check(end.goal === 10, "and pins the goal to that row's display width");

  check(at(move(ctx, { row: 0, col: 3 }, "line-start")) === "0:0", "on the first row, home is the line's start");
  check(at(move(ctx, { row: 0, col: 3 }, "line-end")) === "0:10", "and end is the first row's end");
});

Deno.test("motions: the document edges, and the goal a non-vertical motion clears", () => {
  const ctx = doc(["abc", "de"]);
  check(at(move(ctx, { row: 1, col: 2 }, "doc-start")) === "0:0", "doc start");
  check(at(move(ctx, { row: 0, col: 0 }, "doc-end")) === "1:2", "doc end");
  check(applyMotion(ctx, { row: 0, col: 1 }, "char-forward", 5).goal === NO_GOAL,
    "a character step clears the goal");
  check(applyMotion(ctx, { row: 0, col: 1 }, "paragraph-forward", 5).goal === NO_GOAL,
    "so does a paragraph jump");
  check(at(move(ctx, { row: 99, col: 99 }, "char-backward")) === "1:1",
    "a stale caret is clamped into the document, never trusted");
  const cell = displayCellOf(ctx, { row: 0, col: 1 });
  check(cell.row === 0 && cell.col === 1, "the display cell of the first line's second column");
});
