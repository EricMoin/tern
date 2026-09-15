//! Tests: literal find and replace — the matcher, the step, and the edits.

import { Buffer } from "./buffer.ts";
import {
  findMatches,
  matchContaining,
  nextMatchIndex,
  replaceAllEdits,
  replaceEdit,
  SearchSession,
} from "./search.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const TEXT = "alpha beta alpha\ngamma ALPHA\n";

/** The matches of `query`, as `row:col+len`. */
function spots(buffer: Buffer, query: string, caseSensitive = true): string {
  return findMatches(buffer, query, { caseSensitive })
    .map((match) => `${match.row}:${match.col}+${match.length}`)
    .join(" ");
}

Deno.test("search: the matcher is literal, per-line and non-overlapping", () => {
  const buffer = Buffer.fromString(TEXT);
  check(spots(buffer, "alpha") === "0:0+5 0:11+5", "both lowercase occurrences, in order");
  check(spots(buffer, "alpha", false) === "0:0+5 0:11+5 1:6+5", "the folded scan finds the uppercase one");
  check(spots(buffer, "ALPHA") === "1:6+5", "and the case-sensitive scan does not");

  check(spots(buffer, "a.c") === "", "a dot is a literal dot, not a wildcard");
  check(spots(Buffer.fromString("abc"), "a.c") === "", "so it matches nothing here");
  check(spots(Buffer.fromString("a.c"), "a.c") === "0:0+3", "and matches itself");
  check(spots(buffer, "zzz") === "", "no match is no match");
  check(spots(buffer, "") === "", "an empty query never matches everything");

  check(spots(Buffer.fromString("aaa"), "aa") === "0:0+2", "matches do not overlap");
  check(spots(Buffer.fromString("a\nb"), "\n") === "", "a literal never spans a newline");
});

Deno.test("search: folding compares code units, so no match index shifts", () => {
  // "İ".toLowerCase() is TWO code units. Folding the line wholesale would shift
  // every later match by one and hand a range to the wrong place.
  const buffer = Buffer.fromString("\u0130abc");
  const matches = findMatches(buffer, "abc", { caseSensitive: false });
  check(matches.length === 1, "the real match is still found");
  check(matches[0]!.col === 1, `and at its true column (${matches[0]!.col})`);
  check(spots(buffer, "i", false) === "", "the dotted capital does not fold to a one-unit match");
});

Deno.test("search: the step wraps, and advances past the match it is on", () => {
  const buffer = Buffer.fromString(TEXT);
  const matches = findMatches(buffer, "alpha", { caseSensitive: false });
  check(matches.length === 3, "three matches to step through");

  check(nextMatchIndex(matches, { row: 0, col: 0 }, 1) === 0, "forward from the start finds the first");
  check(nextMatchIndex(matches, { row: 0, col: 6 }, 1) === 1, "forward skips the one behind it");
  check(nextMatchIndex(matches, { row: 9, col: 0 }, 1) === 0, "and wraps at the document's end");
  check(nextMatchIndex(matches, { row: 0, col: 0 }, -1) === 2, "backward wraps to the last");
  check(nextMatchIndex(matches, { row: 0, col: 12 }, -1) === 1, "backward finds the one behind it");
  check(nextMatchIndex([], { row: 0, col: 0 }, 1) === -1, "no matches, no index");

  const session = new SearchSession();
  check(!session.active && session.query === "", "a fresh session searches for nothing");
  session.open("alpha");
  check(session.active && session.query === "alpha", "and is active once given a query");

  const first = session.step(buffer, { row: 0, col: 0 }, 1);
  check(first !== null && first.col === 0, "the first step lands on the match under the caret");
  const second = session.step(buffer, { row: 0, col: 0 }, 1);
  check(second !== null && second.col === 11, `the second advances (${JSON.stringify(second)})`);
  const third = session.step(buffer, { row: 0, col: 11 }, 1);
  check(third !== null && third.row === 1, "and crosses to the next line");
  const wrapped = session.step(buffer, { row: 1, col: 6 }, 1);
  check(wrapped !== null && wrapped.row === 0 && wrapped.col === 0, "and wraps to the first");
  const back = session.step(buffer, { row: 0, col: 0 }, -1);
  check(back !== null && back.row === 1, "backward from the first wraps to the last");

  session.close();
  check(!session.active && session.current === null, "closing forgets the query and the match");
});

Deno.test("search: a match covers its own text and its end column", () => {
  const buffer = Buffer.fromString(TEXT);
  const matches = findMatches(buffer, "alpha");
  const match = matches[0]!;
  check(match.start.row === 0 && match.start.col === 0, "the match starts where it was found");
  check(match.end.row === 0 && match.end.col === 5, "and ends one length later");
  check(buffer.lineAt(0).slice(match.col, match.col + match.length) === "alpha", "which is its text");

  check(matchContaining(matches, { row: 0, col: 3 }) === match, "a caret inside it is on it");
  check(matchContaining(matches, { row: 0, col: 5 }) === match, "and so is a caret at its end");
  check(matchContaining(matches, { row: 0, col: 6 }) === null, "one column later is not");
  check(matchContaining(matches, { row: 1, col: 0 }) === null, "nor another line");
});

Deno.test("search: replace is a list of edits, and replace-all walks backward", () => {
  const buffer = Buffer.fromString(TEXT);
  const matches = findMatches(buffer, "alpha", { caseSensitive: false });
  const single = replaceEdit(matches[1]!, "ALPHA");
  check(single.start.col === 11 && single.end.col === 16 && single.text === "ALPHA",
    "one edit replaces exactly the match's range");

  const edits = replaceAllEdits(buffer, "alpha", "A", { caseSensitive: false });
  check(edits.length === 3, "one edit per match");
  check(edits[0]!.start.row === 1 && edits[2]!.start.row === 0 && edits[2]!.start.col === 0,
    "in REVERSE document order, so a forward loop keeps every earlier offset valid");
  for (let i = 1; i < edits.length; i += 1) {
    const later = edits[i - 1]!;
    const earlier = edits[i]!;
    check(
      earlier.start.row < later.start.row ||
        (earlier.start.row === later.start.row && earlier.end.col <= later.start.col),
      `edit ${i} starts at or before the one after it`,
    );
  }
  check(replaceAllEdits(buffer, "", "x").length === 0, "no query, no edits");
});
