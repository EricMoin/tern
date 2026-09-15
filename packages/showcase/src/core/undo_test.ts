//! Tests: the bounded undo/redo ring — ordering, redo clearing, coalescing
//! with its documented breaks, and eviction at the cap.

import { HISTORY_CAP, History } from "./undo.ts";

/**
 * The entry shape the buffer will own (a later subtask): one logical edit,
 * with the sequence number of the last keystroke it covers and whether it is
 * still a coalescible typing run. The ring is generic over its entry type, so
 * this test supplies the shape the production merge will see — undo.ts itself
 * never names it.
 */
interface TypingEntry {
  kind: "insert" | "delete";
  text: string;
  seq: number;
  typing: boolean;
}

/** A single keystroke: one character, hence coalescible (a newline is not). */
function insertEntry(text: string, seq: number): TypingEntry {
  return { kind: "insert", text, seq, typing: text.length === 1 && text !== "\n" };
}

/**
 * The documented typing rule, as the buffer will supply it: a run continues
 * while the incoming edit is a single-character, non-newline insert of the
 * same kind landing at the sequence number right after the entry it extends.
 * Everything else here — a delete, a paste, a newline, a sequence gap — breaks
 * the run and starts a new entry.
 */
function mergeTypingRun(previous: TypingEntry, next: TypingEntry): TypingEntry | undefined {
  if (!previous.typing) return undefined;
  if (next.kind !== "insert" || !next.typing) return undefined;
  if (next.seq !== previous.seq + 1) return undefined;
  return { kind: "insert", text: previous.text + next.text, seq: next.seq, typing: true };
}

/** A history over typing entries, at the product cap unless overridden. */
function typingHistory(cap: number = HISTORY_CAP): History<TypingEntry> {
  return new History<TypingEntry>({ cap, merge: mergeTypingRun });
}

/**
 * Read depth and position through a call boundary. TypeScript narrows a getter
 * read to a literal after a guard (`if (history.depth !== 0) throw`) and does
 * not invalidate that narrowing when a method mutates the ring, so a second
 * direct comparison would be rejected as an impossible one even though the
 * value did change. A fresh call reads the live value.
 */
function depthOf<T>(history: History<T>): number {
  return history.depth;
}

/** See {@link depthOf}. */
function positionOf<T>(history: History<T>): number {
  return history.position;
}

Deno.test("push/undo/redo round-trip and report their edges", () => {
  const history = new History<string>();
  if (depthOf(history) !== 0 || history.canUndo || history.canRedo) {
    throw new Error(`fresh history = ${depthOf(history)}/${history.canUndo}/${history.canRedo}`);
  }
  history.push("A");
  history.push("B");
  history.push("C");
  if (depthOf(history) !== 3 || positionOf(history) !== 3) {
    throw new Error(`depth = ${depthOf(history)}/${positionOf(history)}`);
  }
  if (!history.canUndo || history.canRedo) throw new Error("edges are wrong after three pushes");

  if (history.undo() !== "C" || history.undo() !== "B" || history.undo() !== "A") {
    throw new Error("undo did not walk back in reverse order");
  }
  if (history.canUndo || history.undo() !== undefined) {
    throw new Error("undo past the oldest entry did not report empty");
  }
  if (!history.canRedo) throw new Error("the redo tail was lost");

  if (history.redo() !== "A" || history.redo() !== "B" || history.redo() !== "C") {
    throw new Error("redo did not walk forward in order");
  }
  if (history.canRedo || history.redo() !== undefined) {
    throw new Error("redo past the newest entry did not report empty");
  }
  if (depthOf(history) !== 3) throw new Error(`entries were dropped: ${depthOf(history)}`);
});

Deno.test("a new push clears the redo tail", () => {
  const history = new History<string>();
  history.push("A");
  history.push("B");
  history.push("C");
  history.undo();
  history.undo();
  history.push("D");
  if (history.canRedo || history.redo() !== undefined) {
    throw new Error("a push left the undone future reachable");
  }
  if (depthOf(history) !== 2 || positionOf(history) !== 2) {
    throw new Error(`depth after the new push = ${depthOf(history)}/${positionOf(history)}`);
  }
  if (history.undo() !== "D" || history.undo() !== "A") {
    throw new Error("the new push was not appended after the applied prefix");
  }
});

Deno.test("consecutive single-character inserts coalesce into one step", () => {
  const history = typingHistory();
  const keys = "abcdef";
  for (let i = 0; i < keys.length; i += 1) history.push(insertEntry(keys[i] ?? "", i));
  if (depthOf(history) !== 1) throw new Error(`typing depth = ${depthOf(history)}`);
  const step = history.undo();
  if (step === undefined || step.text !== "abcdef") {
    throw new Error(`typing step = ${JSON.stringify(step)}`);
  }
  if (history.canUndo) throw new Error("a six-keystroke run produced more than one step");

  // A long run stays ONE entry, so the ring cannot grow while the user types.
  const long = typingHistory();
  for (let i = 0; i < 100; i += 1) long.push(insertEntry("x", i));
  if (depthOf(long) !== 1) throw new Error(`long run depth = ${depthOf(long)}`);
});

Deno.test("the documented breaks end a coalescing run", () => {
  // (a) a different entry kind — a delete is never part of a typing run, and
  // the insert after it starts a fresh one.
  const kinds = typingHistory();
  kinds.push(insertEntry("a", 0));
  kinds.push({ kind: "delete", text: "a", seq: 1, typing: false });
  kinds.push(insertEntry("b", 2));
  if (depthOf(kinds) !== 3) throw new Error(`kind break depth = ${depthOf(kinds)}`);

  // (b) a newline-containing insert: Enter is its own step in mid-run.
  const newline = typingHistory();
  newline.push(insertEntry("a", 0));
  newline.push(insertEntry("\n", 1));
  newline.push(insertEntry("b", 2));
  if (depthOf(newline) !== 3) throw new Error(`newline break depth = ${depthOf(newline)}`);

  // (c) a paste (multi-character insert) is its own step and is not extended
  // by the typing that follows, which coalesces with itself instead.
  const paste = typingHistory();
  paste.push(insertEntry("XYZ", 0));
  paste.push(insertEntry("q", 1));
  paste.push(insertEntry("r", 2));
  if (depthOf(paste) !== 2) throw new Error(`paste break depth = ${depthOf(paste)}`);
  const typed = paste.undo();
  if (typed === undefined || typed.text !== "qr") throw new Error(`typed step = ${JSON.stringify(typed)}`);
  if (paste.undo()?.text !== "XYZ") throw new Error("the paste entry was coalesced away");

  // (d) an explicit breakCoalesce() — the seam for a cursor move, a mode
  // switch, a selection or a save.
  const broken = typingHistory();
  broken.push(insertEntry("a", 0));
  broken.breakCoalesce();
  broken.push(insertEntry("b", 1));
  if (depthOf(broken) !== 2) throw new Error(`explicit break depth = ${depthOf(broken)}`);

  // (e) a sequence gap — a pause, or an edit arriving from another source.
  const gap = typingHistory();
  gap.push(insertEntry("a", 0));
  gap.push(insertEntry("b", 5));
  if (depthOf(gap) !== 2) throw new Error(`sequence gap depth = ${depthOf(gap)}`);

  // (f) editing after an undo starts a new step: the undone step is discarded
  // by the push, never silently extended by the next keystroke.
  const afterUndo = typingHistory();
  afterUndo.push(insertEntry("a", 0));
  afterUndo.push(insertEntry("b", 1));
  if (depthOf(afterUndo) !== 1) throw new Error("the run did not coalesce before the undo");
  afterUndo.undo();
  afterUndo.push(insertEntry("c", 2));
  if (depthOf(afterUndo) !== 1 || afterUndo.canRedo) {
    throw new Error(`post-undo push depth = ${depthOf(afterUndo)}/${afterUndo.canRedo}`);
  }
  if (afterUndo.undo()?.text !== "c") throw new Error("the post-undo push is not the newest step");
  if (afterUndo.canUndo || afterUndo.undo() !== undefined) {
    throw new Error("the undone step survived the new push");
  }

  // (g) undo -> redo leaves the ring intact but still ends the run: the next
  // keystroke is a new step, not an extension of the redone one.
  const aroundRedo = typingHistory();
  aroundRedo.push(insertEntry("a", 0));
  aroundRedo.push(insertEntry("b", 1));
  aroundRedo.undo();
  if (aroundRedo.redo()?.text !== "ab") throw new Error("redo did not return the redone step");
  aroundRedo.push(insertEntry("c", 2));
  if (depthOf(aroundRedo) !== 2) throw new Error(`post-redo push depth = ${depthOf(aroundRedo)}`);
});

Deno.test("the ring evicts its oldest entry at the cap instead of growing", () => {
  const history = new History<number>({ cap: 8 });
  for (let i = 0; i < 12; i += 1) history.push(i);
  if (history.cap !== 8) throw new Error(`cap = ${history.cap}`);
  if (depthOf(history) !== 8) throw new Error(`depth = ${depthOf(history)}`);

  const seen: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const entry = history.undo();
    if (entry === undefined) throw new Error(`undo ${i} was empty though depth is at the cap`);
    seen.push(entry);
  }
  if (seen.join(",") !== "11,10,9,8,7,6,5,4") throw new Error(`seen = ${seen.join(",")}`);
  if (seen.includes(3)) throw new Error("an evicted entry is still reachable");
  if (history.canUndo || history.undo() !== undefined) {
    throw new Error("undoing cap times did not exhaust the ring");
  }

  // A cap below 1 falls back to the product cap rather than disabling history.
  if (new History<string>({ cap: 0 }).cap !== HISTORY_CAP) throw new Error("cap 0 did not fall back");
});

Deno.test("the product cap bounds a long session at exactly HISTORY_CAP", () => {
  if (HISTORY_CAP !== 200) throw new Error(`HISTORY_CAP = ${HISTORY_CAP}`);
  const history = new History<number>();
  if (history.cap !== HISTORY_CAP) throw new Error(`default cap = ${history.cap}`);
  const pushes = HISTORY_CAP + 25;
  for (let i = 0; i < pushes; i += 1) history.push(i);
  if (depthOf(history) !== HISTORY_CAP) {
    throw new Error(`depth after ${pushes} pushes = ${depthOf(history)}`);
  }

  let oldest = -1;
  let steps = 0;
  for (let entry = history.undo(); entry !== undefined; entry = history.undo()) {
    oldest = entry;
    steps += 1;
  }
  if (steps !== HISTORY_CAP) throw new Error(`undoable steps = ${steps}`);
  if (oldest !== pushes - HISTORY_CAP) throw new Error(`oldest retained = ${oldest}`);
  if (history.canRedo !== true) throw new Error("the whole ring should be a redo tail after exhausting undo");
});

Deno.test("clear() drops every entry and the run state", () => {
  const history = typingHistory();
  history.push(insertEntry("a", 0));
  history.push(insertEntry("b", 1));
  history.clear();
  if (depthOf(history) !== 0 || history.canUndo || history.canRedo) {
    throw new Error(`after clear = ${depthOf(history)}/${history.canUndo}/${history.canRedo}`);
  }
  history.push(insertEntry("c", 2));
  if (depthOf(history) !== 1) throw new Error(`push after clear = ${depthOf(history)}`);
  if (history.undo()?.text !== "c") throw new Error("the post-clear entry did not survive");
});
