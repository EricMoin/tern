//! Tests: the document model — splicing inserts and deletes, code-unit
//! offsets, dirty state, the clamping policy, and a 100k-line functional case.

import { Buffer, positionsEqual } from "./buffer.ts";

Deno.test("fromString/text round-trip an empty document, a trailing newline and many lines", () => {
  const empty = new Buffer();
  if (empty.lineCount !== 1 || empty.text() !== "") {
    throw new Error(`empty buffer = ${JSON.stringify(empty.text())}/${empty.lineCount}`);
  }
  if (empty.dirty) throw new Error("a fresh buffer is dirty");

  const trailing = Buffer.fromString("a\n");
  if (trailing.text() !== "a\n" || trailing.lineCount !== 2 || trailing.lineAt(1) !== "") {
    throw new Error(`trailing newline = ${JSON.stringify(trailing.text())}/${trailing.lineCount}`);
  }

  const multi = Buffer.fromString("one\ntwo\nthree");
  if (multi.text() !== "one\ntwo\nthree" || multi.lineCount !== 3) {
    throw new Error(`round-trip = ${JSON.stringify(multi.text())}`);
  }
  if (multi.dirty) throw new Error("a loaded buffer is dirty");
});

Deno.test("insertText splices a single line at the column", () => {
  const buffer = Buffer.fromString("hello world");
  const caret = buffer.insertText(0, 5, " big");
  if (buffer.text() !== "hello big world") {
    throw new Error(`text = ${JSON.stringify(buffer.text())}`);
  }
  if (!positionsEqual(caret, { row: 0, col: 9 })) {
    throw new Error(`caret = ${JSON.stringify(caret)}`);
  }
  if (!buffer.dirty) throw new Error("a real insert did not set dirty");
});

Deno.test("insertText splices the row array when the text contains a newline", () => {
  // A multi-line paste at the END of a row: the middle segment becomes a row
  // of its own and the trailing segment heads the row that follows it.
  const buffer = Buffer.fromString("one\ntwo");
  const caret = buffer.insertText(0, 3, "\nA\nB");
  if (buffer.text() !== "one\nA\nB\ntwo" || buffer.lineCount !== 4) {
    throw new Error(`splice = ${JSON.stringify(buffer.text())}/${buffer.lineCount}`);
  }
  if (!positionsEqual(caret, { row: 2, col: 1 })) {
    throw new Error(`caret = ${JSON.stringify(caret)}`);
  }

  // A multi-line paste MID-row: the last segment carries the original tail of
  // the split row, so the boundary newline disappears into the row structure.
  const mid = Buffer.fromString("one\ntwo");
  const midCaret = mid.insertText(0, 1, "\nA");
  if (mid.text() !== "o\nAne\ntwo" || mid.lineCount !== 3) {
    throw new Error(`mid-row splice = ${JSON.stringify(mid.text())}/${mid.lineCount}`);
  }
  if (!positionsEqual(midCaret, { row: 1, col: 1 })) {
    throw new Error(`mid-row caret = ${JSON.stringify(midCaret)}`);
  }

  // Enter at the caret splits the line in two and the tail becomes a row.
  const split = Buffer.fromString("one\ntwo");
  const splitCaret = split.insertText(1, 1, "\n");
  if (split.text() !== "one\nt\nwo" || split.lineCount !== 3) {
    throw new Error(`split = ${JSON.stringify(split.text())}/${split.lineCount}`);
  }
  if (!positionsEqual(splitCaret, { row: 2, col: 0 })) {
    throw new Error(`split caret = ${JSON.stringify(splitCaret)}`);
  }

  // Leading and trailing newlines of the inserted text produce empty rows.
  const padded = Buffer.fromString("ab");
  const paddedCaret = padded.insertText(0, 0, "\nX\n");
  if (padded.text() !== "\nX\nab" || padded.lineCount !== 3) {
    throw new Error(`padded = ${JSON.stringify(padded.text())}/${padded.lineCount}`);
  }
  if (!positionsEqual(paddedCaret, { row: 2, col: 0 })) {
    throw new Error(`padded caret = ${JSON.stringify(paddedCaret)}`);
  }
});

Deno.test("deleteRange removes text within one line", () => {
  const buffer = Buffer.fromString("abcdef");
  buffer.deleteRange({ row: 0, col: 1 }, { row: 0, col: 3 });
  if (buffer.text() !== "adef") throw new Error(`text = ${JSON.stringify(buffer.text())}`);
  if (!buffer.dirty) throw new Error("a real delete did not set dirty");
});

Deno.test("deleteRange joins the boundary lines when the range spans lines", () => {
  const two = Buffer.fromString("ab\ncd\nef");
  two.deleteRange({ row: 0, col: 1 }, { row: 1, col: 1 });
  if (two.text() !== "ad\nef" || two.lineCount !== 2) {
    throw new Error(`two-line span = ${JSON.stringify(two.text())}/${two.lineCount}`);
  }

  // A range that ends at column 0 absorbs the whole newline, so the two lines
  // become one with no separator.
  const atZero = Buffer.fromString("ab\ncd");
  atZero.deleteRange({ row: 0, col: 2 }, { row: 1, col: 0 });
  if (atZero.text() !== "abcd" || atZero.lineCount !== 1) {
    throw new Error(`zero-col end = ${JSON.stringify(atZero.text())}`);
  }

  // Several lines swallowed at once: only the two boundary remainders survive.
  const three = Buffer.fromString("one\ntwo\nthree");
  three.deleteRange({ row: 0, col: 1 }, { row: 2, col: 2 });
  if (three.text() !== "oree" || three.lineCount !== 1) {
    throw new Error(`three-line span = ${JSON.stringify(three.text())}`);
  }
});

Deno.test("deleteRange removes a whole line", () => {
  // A line is its text PLUS its newline: [row, 0) -> [row+1, 0) is the range
  // that makes the row disappear entirely.
  const mid = Buffer.fromString("one\ntwo\nthree");
  mid.deleteRange({ row: 1, col: 0 }, { row: 2, col: 0 });
  if (mid.text() !== "one\nthree" || mid.lineCount !== 2) {
    throw new Error(`middle line = ${JSON.stringify(mid.text())}/${mid.lineCount}`);
  }

  const first = Buffer.fromString("one\ntwo");
  first.deleteRange({ row: 0, col: 0 }, { row: 1, col: 0 });
  if (first.text() !== "two" || first.lineCount !== 1) {
    throw new Error(`first line = ${JSON.stringify(first.text())}`);
  }

  // The last line has no trailing newline, so its predecessor's newline is the
  // one the range must absorb.
  const last = Buffer.fromString("one\ntwo");
  last.deleteRange({ row: 0, col: 3 }, { row: 1, col: 3 });
  if (last.text() !== "one" || last.lineCount !== 1) {
    throw new Error(`last line = ${JSON.stringify(last.text())}/${last.lineCount}`);
  }

  // A range that stops at the line end leaves an EMPTY line: the newline is
  // not in the range, so it is not deleted. (Deleting a line, as above, is the
  // range that crosses its newline.)
  const contentOnly = Buffer.fromString("one\ntwo\nthree");
  contentOnly.deleteRange({ row: 1, col: 0 }, { row: 1, col: 3 });
  if (contentOnly.text() !== "one\n\nthree" || contentOnly.lineCount !== 3) {
    throw new Error(`content-only = ${JSON.stringify(contentOnly.text())}/${contentOnly.lineCount}`);
  }
});

Deno.test("no-op mutations leave the buffer clean", () => {
  const buffer = Buffer.fromString("abc");
  buffer.insertText(0, 1, "");
  buffer.deleteRange({ row: 0, col: 1 }, { row: 0, col: 1 });
  buffer.deleteRange({ row: 0, col: 2 }, { row: 0, col: 1 });
  buffer.deleteRange({ row: 1, col: 0 }, { row: 0, col: 0 });
  // Out-of-range ends clamp first, and the clamped range is inverted.
  buffer.deleteRange({ row: -5, col: 99 }, { row: 9, col: 1 });
  if (buffer.text() !== "abc") throw new Error(`text = ${JSON.stringify(buffer.text())}`);
  if (buffer.dirty) throw new Error("a no-op mutation set dirty");
  if (buffer.lineCount !== 1) throw new Error(`lineCount = ${buffer.lineCount}`);
});

Deno.test("dirty flips on the first real mutation, stays true, and clears on markSaved", () => {
  const buffer = Buffer.fromString("abc");
  if (buffer.dirty) throw new Error("a loaded buffer is dirty");
  buffer.insertText(0, 3, "d");
  if (!buffer.dirty) throw new Error("the first mutation did not set dirty");
  buffer.deleteRange({ row: 0, col: 0 }, { row: 0, col: 1 });
  if (!buffer.dirty) throw new Error("a later edit cleared dirty");
  buffer.markSaved();
  if (buffer.dirty) throw new Error("markSaved did not clear dirty");
  buffer.insertText(0, 0, "x");
  if (!buffer.dirty) throw new Error("an edit after save did not set dirty");
});

Deno.test("offsetAt and positionAt are inverses on a multi-line document", () => {
  const text = "alpha\nbeta\n\ngamma";
  const buffer = Buffer.fromString(text);
  const rowStarts = [0, 6, 11, 12];
  for (let row = 0; row < rowStarts.length; row += 1) {
    if (buffer.offsetAt(row, 0) !== rowStarts[row]) {
      throw new Error(`offsetAt(${row}, 0) = ${buffer.offsetAt(row, 0)}`);
    }
  }
  if (buffer.offsetAt(3, 5) !== text.length) {
    throw new Error(`final offset = ${buffer.offsetAt(3, 5)} != ${text.length}`);
  }
  const final = buffer.positionAt(text.length);
  if (!positionsEqual(final, { row: 3, col: 5 })) {
    throw new Error(`final position = ${JSON.stringify(final)}`);
  }

  // Every offset, including the final position, round-trips.
  for (let offset = 0; offset <= text.length; offset += 1) {
    const position = buffer.positionAt(offset);
    const back = buffer.offsetAt(position.row, position.col);
    if (back !== offset) {
      throw new Error(`offset ${offset} -> ${JSON.stringify(position)} -> ${back}`);
    }
  }

  // Every position, including column 0 and the end of every line, round-trips.
  for (let row = 0; row < buffer.lineCount; row += 1) {
    const length = buffer.lineAt(row).length;
    for (let col = 0; col <= length; col += 1) {
      const position = buffer.positionAt(buffer.offsetAt(row, col));
      if (!positionsEqual(position, { row, col })) {
        throw new Error(`(${row}, ${col}) -> ${JSON.stringify(position)}`);
      }
    }
  }
});

Deno.test("out-of-range positions clamp instead of throwing", () => {
  const appended = Buffer.fromString("one\ntwo");
  appended.insertText(9, 99, "!");
  if (appended.text() !== "one\ntwo!") {
    throw new Error(`clamped insert = ${JSON.stringify(appended.text())}`);
  }

  const buffer = Buffer.fromString("one\ntwo");
  if (buffer.offsetAt(-3, -5) !== 0) throw new Error(`negative offset = ${buffer.offsetAt(-3, -5)}`);
  const clampedPosition = buffer.positionAt(9999);
  if (!positionsEqual(clampedPosition, { row: 1, col: 3 })) {
    throw new Error(`clamped position = ${JSON.stringify(clampedPosition)}`);
  }
  if (buffer.lineAt(99) !== "two" || buffer.lineAt(-1) !== "one") {
    throw new Error(`clamped lineAt = ${JSON.stringify([buffer.lineAt(99), buffer.lineAt(-1)])}`);
  }

  // A delete whose far end is off the document still removes everything after
  // the clamped start.
  buffer.deleteRange({ row: 0, col: 1 }, { row: 99, col: 99 });
  if (buffer.text() !== "o") throw new Error(`off-document delete = ${JSON.stringify(buffer.text())}`);
});

Deno.test("a 100k-line document edits in the middle and at the end", () => {
  const ROWS = 100_000;
  const lines: string[] = [];
  const rowStart: number[] = [];
  let at = 0;
  for (let i = 0; i < ROWS; i += 1) {
    const line = `line ${i}`;
    lines.push(line);
    rowStart.push(at);
    at += line.length + 1;
  }
  const documentLength = at - 1;
  const lastRow = ROWS - 1;

  const buffer = Buffer.fromString(lines.join("\n"));
  if (buffer.lineCount !== ROWS) throw new Error(`lineCount = ${buffer.lineCount}`);
  if (buffer.text().length !== documentLength) {
    throw new Error(`text length = ${buffer.text().length} != ${documentLength}`);
  }

  // Probes spread over the document: offsetAt/positionAt stay inverses.
  for (const row of [0, 1, 49_999, 50_000, 99_998, lastRow]) {
    const col = (lines[row] ?? "").length;
    const offset = buffer.offsetAt(row, col);
    if (offset !== (rowStart[row] ?? -1) + col) {
      throw new Error(`offsetAt(${row}, ${col}) = ${offset}`);
    }
    const back = buffer.positionAt(offset);
    if (back.row !== row || back.col !== col) {
      throw new Error(`positionAt(${offset}) = ${JSON.stringify(back)}`);
    }
  }

  // Edit in the middle: a multi-line insert splices rows into a 100k array.
  const caret = buffer.insertText(50_000, 4, "X\nY\nZ");
  if (buffer.lineCount !== ROWS + 2) throw new Error(`lineCount after paste = ${buffer.lineCount}`);
  if (buffer.lineAt(50_000) !== "lineX" || buffer.lineAt(50_001) !== "Y" || buffer.lineAt(50_002) !== "Z 50000") {
    throw new Error(
      `rows around the paste = ${JSON.stringify([buffer.lineAt(50_000), buffer.lineAt(50_001), buffer.lineAt(50_002)])}`,
    );
  }
  if (caret.row !== 50_002 || caret.col !== 1) throw new Error(`caret = ${JSON.stringify(caret)}`);
  const middleOffset = buffer.offsetAt(50_002, 1);
  if (middleOffset !== (rowStart[50_000] ?? -1) + 9) {
    throw new Error(`middle offset = ${middleOffset}`);
  }
  const middleBack = buffer.positionAt(middleOffset);
  if (middleBack.row !== 50_002 || middleBack.col !== 1) {
    throw new Error(`middle position = ${JSON.stringify(middleBack)}`);
  }

  // Edit at the end: the last row moved down by two but its content did not.
  const grownLength = documentLength + "X\nY\nZ".length;
  const endRow = buffer.lineCount - 1;
  if (endRow !== lastRow + 2) throw new Error(`end row = ${endRow}`);
  const lastLength = (lines[lastRow] ?? "").length;
  if (buffer.offsetAt(endRow, 0) !== grownLength - lastLength) {
    throw new Error(`end row start = ${buffer.offsetAt(endRow, 0)}`);
  }
  buffer.insertText(endRow, lastLength, "!");
  const finalOffset = buffer.offsetAt(endRow, lastLength + 1);
  if (finalOffset !== grownLength + 1) throw new Error(`final offset = ${finalOffset}`);
  const finalBack = buffer.positionAt(finalOffset);
  if (finalBack.row !== endRow || finalBack.col !== lastLength + 1) {
    throw new Error(`final position = ${JSON.stringify(finalBack)}`);
  }
  if (buffer.text().length !== finalOffset) {
    throw new Error(`text length = ${buffer.text().length} != ${finalOffset}`);
  }

  // And a delete at the end keeps every offset consistent.
  buffer.deleteRange({ row: endRow, col: 0 }, { row: endRow, col: 4 });
  const afterDelete = buffer.offsetAt(endRow, lastLength - 3);
  if (afterDelete !== grownLength + 1 - 4) throw new Error(`offset after delete = ${afterDelete}`);
  const deleteBack = buffer.positionAt(afterDelete);
  if (deleteBack.row !== endRow || deleteBack.col !== lastLength - 3) {
    throw new Error(`position after delete = ${JSON.stringify(deleteBack)}`);
  }
  if (buffer.lineCount !== ROWS + 2) throw new Error(`final lineCount = ${buffer.lineCount}`);
});
