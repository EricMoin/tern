//! Tests: grapheme invariant fuzz: paste round-trips at a cluster boun.

import { EditRng, FAMILY_EMOJI, assertEditCursorInvariant, boundaryIndexAt, editBoundaryColumns, editClusters, editRandomValue, editRounds, editSeed, editTotalWidth } from "./testkit.ts";
import { Input, Node, Textarea, TextareaProps, editKey, editTextareaKey, measureText, name, pasteInto, pasteIntoTextarea, wrapLineWithOffsets } from "./index.ts";


Deno.test("grapheme invariant fuzz: paste round-trips at a cluster boundary", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const columns = editBoundaryColumns(value);
    const caret = rng.pick(columns);
    const text = editRandomValue(rng) || "x";
    const input = Input({ value, caret });

    // The paste splices at the cluster boundary the caret column points to.
    const next = pasteInto(input, text);
    const index = boundaryIndexAt(value, caret);
    const expectedSplice = value.slice(0, index) + text + value.slice(index);
    if (next.value !== expectedSplice) {
      throw new Error(
        `round ${round}: paste of ${
          JSON.stringify(text)
        } at caret ${caret} produced ` +
          `${JSON.stringify(next.value)}, expected splice ${
            JSON.stringify(expectedSplice)
          } ` +
          `(value ${JSON.stringify(value)})`,
      );
    }

    // The caret advances by the pasted text's total display width and stays
    // on a cluster boundary of the new value.
    const pastedWidth = editTotalWidth(text);
    if (next.caret !== caret + pastedWidth) {
      throw new Error(
        `round ${round}: paste caret ${next.caret} != ${caret} + ${pastedWidth}`,
      );
    }
    assertEditCursorInvariant(
      next.value,
      next.caret,
      `round ${round} after paste`,
    );

    // Round-trip: backspacing exactly the pasted text's cluster count
    // restores the original value and caret.
    const clusterCount = editClusters(text).length;
    const replay = Input({ value: next.value, caret: next.caret });
    for (let i = 0; i < clusterCount; i++) {
      editKey(replay, { name: "backspace", ...base });
    }
    const props = replay.props;
    if (props.value !== value || props.caret !== caret) {
      throw new Error(
        `round ${round}: paste round-trip restored ${
          JSON.stringify(props.value)
        }@${props.caret}, ` +
          `expected ${JSON.stringify(value)}@${caret}`,
      );
    }
  }
});

Deno.test("Textarea composes one text leaf per line with the caret on the caret's line", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 2 });
  const props = ta.props as TextareaProps;
  if (ta.type !== "textarea") throw new Error(`type = ${ta.type}`);
  if (props.lines?.join(",") !== "ab,cd") {
    throw new Error(`lines = ${JSON.stringify(props.lines)}`);
  }
  if (props.row !== 1 || props.col !== 2) {
    throw new Error(`row/col = ${props.row}/${props.col}`);
  }
  if (ta.children.length !== 2) {
    throw new Error(`leaves = ${ta.children.length}`);
  }
  const first = ta.children[0]!;
  const second = ta.children[1]!;
  if (first.type !== "text" || first.props.text !== "ab") {
    throw new Error(`leaf 0 = ${JSON.stringify(first.props)}`);
  }
  if ("caret" in first.props) {
    throw new Error("the caret's line must be the only one with a caret");
  }
  if (second.props.text !== "cd" || second.props.caret !== 2) {
    throw new Error(`leaf 1 = ${JSON.stringify(second.props)}`);
  }
  // No explicit width: leaves are not sized, each line stays one display row.
  if ("width" in first.props) {
    throw new Error("no width prop without a wrap width");
  }
});

Deno.test("Textarea with a width soft-wraps long lines into multiple leaves", () => {
  // The caret starts at (0,0) unless props say otherwise; the end-of-text
  // caret (col 11) rides the second display line.
  const ta = Textarea({ lines: ["hello world"], width: 5, row: 0, col: 11 });
  if (ta.children.length !== 2) {
    throw new Error(`leaves = ${ta.children.length}`);
  }
  const first = ta.children[0]!;
  const second = ta.children[1]!;
  if (first.props.text !== "hello" || first.props.width !== 5) {
    throw new Error(`wrapped line 0 = ${JSON.stringify(first.props)}`);
  }
  if ("caret" in first.props) {
    throw new Error("the first wrapped line must not carry the caret");
  }
  // The caret (end of "hello world") rides the second display line at its
  // display column (5 — the trailing space at the wrap point is dropped).
  if (second.props.text !== "world" || second.props.caret !== 5) {
    throw new Error(`wrapped line 1 = ${JSON.stringify(second.props)}`);
  }
  // Default caret (0,0) sits on the first display line instead.
  const atStart = Textarea({ lines: ["hello world"], width: 5 });
  if (
    atStart.children[0]?.props.caret !== 0 ||
    "caret" in (atStart.children[1]?.props ?? {})
  ) {
    throw new Error(
      `default caret must ride the first line: ${
        JSON.stringify(atStart.children.map((c) => c.props))
      }`,
    );
  }
});

Deno.test("wrapLineWithOffsets wraps plain ASCII at the width with exact offsets", () => {
  const wrapped = wrapLineWithOffsets("hello world", 5);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "hello" || wrapped[0]!.start !== 0) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  // The trailing space at the wrap point is dropped, so "world" starts at the
  // code-unit index of 'w' (6), not after the dropped space.
  if (wrapped[1]!.text !== "world" || wrapped[1]!.start !== 6) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // No wrap width: the whole line is one display row starting at 0.
  const flat = wrapLineWithOffsets("hello world", null);
  if (
    flat.length !== 1 || flat[0]!.text !== "hello world" || flat[0]!.start !== 0
  ) {
    throw new Error(`flat = ${JSON.stringify(flat)}`);
  }
});

Deno.test("wrapLineWithOffsets wraps CJK wide chars by display columns", () => {
  // コ is a 2-column char: 4 of them occupy 8 columns, wrapping at width 4
  // into two rows of two glyphs (4 columns) each.
  const wrapped = wrapLineWithOffsets("ココココ", 4);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "ココ" || wrapped[0]!.start !== 0) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  if (wrapped[1]!.text !== "ココ" || wrapped[1]!.start !== 2) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // Mixed ASCII + wide: "aコ" is 3 columns, so 'b' wraps to its own row.
  const mixed = wrapLineWithOffsets("aコb", 3);
  if (mixed.length !== 2) throw new Error(`mixed rows = ${mixed.length}`);
  if (
    mixed[0]!.text !== "aコ" || mixed[0]!.start !== 0 ||
    mixed[1]!.text !== "b" || mixed[1]!.start !== 2
  ) {
    throw new Error(`mixed = ${JSON.stringify(mixed)}`);
  }
});

Deno.test("wrapLineWithOffsets hard-breaks a long unbroken token across rows", () => {
  // 20 ASCII chars with no whitespace: the token is wider than the width and
  // breaks every 5 columns into 4 rows.
  const wrapped = wrapLineWithOffsets("supercalifragilistic", 5);
  if (wrapped.length !== 4) throw new Error(`rows = ${wrapped.length}`);
  const texts = wrapped.map((r) => r.text).join("|");
  if (texts !== "super|calif|ragil|istic") throw new Error(`texts = ${texts}`);
  if (
    wrapped[0]!.start !== 0 || wrapped[1]!.start !== 5 ||
    wrapped[2]!.start !== 10 || wrapped[3]!.start !== 15
  ) {
    throw new Error(`starts = ${wrapped.map((r) => r.start).join(",")}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText treat the empty string as one empty row", () => {
  const wrapped = wrapLineWithOffsets("", 5);
  if (
    wrapped.length !== 1 || wrapped[0]!.text !== "" || wrapped[0]!.start !== 0
  ) {
    throw new Error(`wrapped = ${JSON.stringify(wrapped)}`);
  }
  const measured = measureText("", 5);
  if (measured.rows !== 1 || measured.maxWidth !== 0) {
    throw new Error(`measured = ${JSON.stringify(measured)}`);
  }
});

Deno.test("measureText sums wrapped rows and reports the widest display line", () => {
  // "hello world" wraps to 2 rows of 5; "ココココ" wraps to 2 rows of 4.
  const measured = measureText("hello world\nココココ", 5);
  if (measured.rows !== 4 || measured.maxWidth !== 5) {
    throw new Error(`measured = ${JSON.stringify(measured)}`);
  }
  // Width <= 0 follows the "no width" convention: each logical line is one
  // display row, and the widest display line is the widest logical line.
  const nowrap = measureText("ab\ncde", 0);
  if (nowrap.rows !== 2 || nowrap.maxWidth !== 3) {
    throw new Error(`nowrap = ${JSON.stringify(nowrap)}`);
  }
  const negative = measureText("ab\ncde", -1);
  if (negative.rows !== 2 || negative.maxWidth !== 3) {
    throw new Error(`negative = ${JSON.stringify(negative)}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText strip ANSI escapes at ingestion", () => {
  // A CSI-colored string measures and wraps identically to its plain text:
  // the escape sequences consume zero cells and belong to no display line.
  const red = "\x1b[31mred\x1b[0m";
  const colored = measureText(red, 5);
  const plain = measureText("red", 5);
  if (colored.rows !== plain.rows || colored.maxWidth !== plain.maxWidth) {
    throw new Error(
      `colored = ${JSON.stringify(colored)}, plain = ${JSON.stringify(plain)}`,
    );
  }
  if (colored.rows !== 1 || colored.maxWidth !== 3) {
    throw new Error(`colored = ${JSON.stringify(colored)}`);
  }
  // The wrapped row carries only the visible text; its start is the original
  // code-unit index of 'r' (after the 5-byte leading escape).
  const wrapped = wrapLineWithOffsets(red, 5);
  if (
    wrapped.length !== 1 || wrapped[0]!.text !== "red" ||
    wrapped[0]!.start !== 5
  ) {
    throw new Error(`wrapped = ${JSON.stringify(wrapped)}`);
  }
  // The no-width path strips too, so the composed leaf never carries the
  // escape bytes.
  const flat = wrapLineWithOffsets(red, null);
  if (flat.length !== 1 || flat[0]!.text !== "red" || flat[0]!.start !== 5) {
    throw new Error(`flat = ${JSON.stringify(flat)}`);
  }
});

Deno.test("wrapLineWithOffsets and measureText strip OSC and C1 escape forms", () => {
  // OSC 8 hyperlink (ESC ] ... ESC \), BEL-terminated OSC, the C1 ST (0x9C)
  // terminator, and the C1 CSI (0x9B) lead all strip like the ESC [ SGR
  // form: the visible text is all that measures.
  const link = "\x1b]8;;https://example.com\x1b\\red\x1b]8;;\x1b\\";
  if (measureText(link, 20).maxWidth !== 3) throw new Error(`link`);
  if (measureText("\x1b]0;my title\x07red", 20).maxWidth !== 3) {
    throw new Error(`bel`);
  }
  if (measureText("\x1b]8;;u\x9cred", 20).maxWidth !== 3) {
    throw new Error(`c1st`);
  }
  if (measureText("\x9b31mred\x9b0m", 20).maxWidth !== 3) {
    throw new Error(`c1csi`);
  }
  // A bare ESC inside an OSC body (not followed by `\`) is body data.
  if (measureText("\x1b]0;a\x1bb\x07", 20).maxWidth !== 0) {
    throw new Error(`bare`);
  }
  // Truncated sequences (no final byte / no terminator) strip to the end of
  // the input rather than leaking their bytes.
  if (measureText("red\x1b[31", 20).maxWidth !== 3) {
    throw new Error(`trunc-csi`);
  }
  if (measureText("red\x1b]0;unterminated", 20).maxWidth !== 3) {
    throw new Error(`trunc-osc`);
  }
  if (measureText("a\x1b]0;title", 20).maxWidth !== 1) {
    throw new Error(`trunc-osc-lead`);
  }
  // Only the OSC and CSI shapes strip: a lone ESC that introduces neither
  // (here the charset-designator form ESC ( B) is kept as-is — every byte
  // measures 1, mirroring tern-core's control fallback.
  if (measureText("\x1b(Bred", 20).maxWidth !== 6) throw new Error(`other`);
  // C1 bytes outside the rule — e.g. the C1 OSC lead 0x9D — are kept as-is.
  if (measureText("\x9dred", 20).maxWidth !== 4) throw new Error(`c1osc`);
});

Deno.test("wrapLineWithOffsets offsets skip escape sequences exactly", () => {
  // Escapes are stripped before wrapping, so each row's start is the ORIGINAL
  // code-unit index of its first visible character — exact, and never inside
  // an escape. Stripped "hello world" wraps at 5 into "hello" (original
  // 5..10) and "world" (original 11..15); the trailing escape (16..20)
  // belongs to no display line.
  const wrapped = wrapLineWithOffsets("\x1b[31mhello world\x1b[0m", 5);
  if (wrapped.length !== 2) throw new Error(`rows = ${wrapped.length}`);
  if (wrapped[0]!.text !== "hello" || wrapped[0]!.start !== 5) {
    throw new Error(`row 0 = ${JSON.stringify(wrapped[0])}`);
  }
  if (wrapped[1]!.text !== "world" || wrapped[1]!.start !== 11) {
    throw new Error(`row 1 = ${JSON.stringify(wrapped[1])}`);
  }
  // An escape between two display characters on one row: "red " starts at
  // original 5, the mid-line escape (8..12) belongs to no display line, and
  // "world" starts at original 13 (the space after the escape is at 12).
  const mid = wrapLineWithOffsets("\x1b[31mred\x1b[0m world", 5);
  if (mid.length !== 2) throw new Error(`mid rows = ${mid.length}`);
  if (mid[0]!.text !== "red " || mid[0]!.start !== 5) {
    throw new Error(`mid row 0 = ${JSON.stringify(mid[0])}`);
  }
  if (mid[1]!.text !== "world" || mid[1]!.start !== 13) {
    throw new Error(`mid row 1 = ${JSON.stringify(mid[1])}`);
  }
  // An embedded newline after an escape starts the next row at the original
  // index of the first character after it.
  const nl = wrapLineWithOffsets("a\x1b[31m\nred\x1b[0m", 5);
  if (nl.length !== 2) throw new Error(`nl rows = ${nl.length}`);
  if (nl[0]!.text !== "a" || nl[0]!.start !== 0) {
    throw new Error(`nl row 0 = ${JSON.stringify(nl[0])}`);
  }
  if (nl[1]!.text !== "red" || nl[1]!.start !== 7) {
    throw new Error(`nl row 1 = ${JSON.stringify(nl[1])}`);
  }
});

Deno.test("escaped wide, ZWJ, and combining content measures as its plain text", () => {
  // Stripping happens before clustering, so an escape never splits a wide
  // char, a ZWJ emoji, or a base+combining pair, and never changes its
  // width: the colored variants measure exactly as the plain content.
  const wide = measureText("\x1b[32mココ\x1b[0m", 10);
  if (wide.rows !== 1 || wide.maxWidth !== 4) {
    throw new Error(`wide = ${JSON.stringify(wide)}`);
  }
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  const zwj = measureText(`\x1b[33m${family}\x1b[0m`, 10);
  if (zwj.rows !== 1 || zwj.maxWidth !== 2) {
    throw new Error(`zwj = ${JSON.stringify(zwj)}`);
  }
  const comb = measureText("\x1b[34me\u0301\x1b[0m", 10);
  if (comb.rows !== 1 || comb.maxWidth !== 1) {
    throw new Error(`comb = ${JSON.stringify(comb)}`);
  }
  // An escape between a base and its combining mark is stripped before
  // clustering, so the pair still forms ONE cluster of width 1.
  const split = measureText("e\x1b[31m\u0301", 10);
  if (split.rows !== 1 || split.maxWidth !== 1) {
    throw new Error(`split = ${JSON.stringify(split)}`);
  }
});

Deno.test("Textarea paints stripped leaves and maps the caret across escapes", () => {
  // The wrapped leaf text is the stripped text (the compositor never sees
  // the escape bytes), and a caret at the end of a colored line lands at the
  // display column of the visible text — the escape interior trails its
  // content, never splitting the caret into an escape.
  const ta = Textarea({
    lines: ["\x1b[31mred\x1b[0m"],
    row: 0,
    col: 12,
    width: 5,
  });
  const leaves = ta.children.map((c) => c.props.text).join("|");
  if (leaves !== "red") throw new Error(`leaves = ${JSON.stringify(leaves)}`);
  const caret = (ta.children[0]?.props as { caret?: number }).caret;
  if (caret !== 3) throw new Error(`caret = ${caret}`);
  // A caret inside the leading escape rests before the first visible char
  // (display column 0 of the only display line).
  const inside = Textarea({
    lines: ["\x1b[31mred\x1b[0m"],
    row: 0,
    col: 2,
    width: 5,
  });
  const insideCaret = (inside.children[0]?.props as { caret?: number }).caret;
  if (insideCaret !== 0) throw new Error(`inside caret = ${insideCaret}`);
});

Deno.test("editTextareaKey inserts chars and splits lines on enter", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const afterChar = editTextareaKey(ta, { name: "char", char: "X", ...base });
  if (afterChar.lines.join(",") !== "ab,cXd" || afterChar.col !== 2) {
    throw new Error(`after insert = ${JSON.stringify(afterChar)}`);
  }
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,cXd") {
    throw new Error(`node lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if (
    ta.children[1]?.props.text !== "cXd" || ta.children[1]?.props.caret !== 2
  ) {
    throw new Error(`node leaf = ${JSON.stringify(ta.children[1]?.props)}`);
  }
  // Enter splits the line at the caret; the tail becomes a new line.
  const afterEnter = editTextareaKey(ta, { name: "enter", ...base });
  if (
    afterEnter.lines.join(",") !== "ab,cX,d" || afterEnter.row !== 2 ||
    afterEnter.col !== 0
  ) {
    throw new Error(`after enter = ${JSON.stringify(afterEnter)}`);
  }
  if (ta.children.length !== 3) {
    throw new Error(`leaves after split = ${ta.children.length}`);
  }
  if (ta.children[2]?.props.text !== "d" || ta.children[2]?.props.caret !== 0) {
    throw new Error(
      `split tail leaf = ${JSON.stringify(ta.children[2]?.props)}`,
    );
  }
});

Deno.test("editTextareaKey backspace and delete remove chars and join lines", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace at the start of a line joins the previous line at the join point.
  const join = Textarea({ lines: ["ab", "cd"], row: 1, col: 0 });
  const joined = editTextareaKey(join, { name: "backspace", ...base });
  if (
    joined.lines.join(",") !== "abcd" || joined.row !== 0 || joined.col !== 2
  ) {
    throw new Error(`backspace join = ${JSON.stringify(joined)}`);
  }
  // Delete at the end of a line joins the next line.
  const fwd = Textarea({ lines: ["ab", "cd"], row: 0, col: 2 });
  const deleted = editTextareaKey(fwd, { name: "delete", ...base });
  if (
    deleted.lines.join(",") !== "abcd" || deleted.row !== 0 || deleted.col !== 2
  ) {
    throw new Error(`delete join = ${JSON.stringify(deleted)}`);
  }
  // Boundary deletes are no-ops.
  const top = Textarea({ lines: ["x"], row: 0, col: 0 });
  const noBack = editTextareaKey(top, { name: "backspace", ...base });
  if (noBack.lines.join(",") !== "x") {
    throw new Error(`backspace at top = ${JSON.stringify(noBack)}`);
  }
  const bottom = Textarea({ lines: ["x"], row: 0, col: 1 });
  const noFwd = editTextareaKey(bottom, { name: "delete", ...base });
  if (noFwd.lines.join(",") !== "x") {
    throw new Error(`delete at bottom = ${JSON.stringify(noFwd)}`);
  }
});

Deno.test("editTextareaKey navigates left/right/home/end with wrap-around", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const mk = () => Textarea({ lines: ["ab", "cd"], row: 1, col: 0 });
  const left = editTextareaKey(mk(), { name: "left", ...base });
  if (left.row !== 0 || left.col !== 2) {
    throw new Error(`left wraps up = ${left.row}/${left.col}`);
  }
  const right = editTextareaKey(mk(), { name: "right", ...base });
  if (right.row !== 1 || right.col !== 1) {
    throw new Error(`right = ${right.row}/${right.col}`);
  }
  const end = editTextareaKey(mk(), { name: "end", ...base });
  if (end.row !== 1 || end.col !== 2) {
    throw new Error(`end = ${end.row}/${end.col}`);
  }
  const home = editTextareaKey(mk(), { name: "home", ...base });
  if (home.row !== 1 || home.col !== 0) {
    throw new Error(`home = ${home.row}/${home.col}`);
  }
  // Unknown keys leave the textarea unchanged.
  const unknown = editTextareaKey(mk(), { name: "tab", ...base });
  if (
    unknown.lines.join(",") !== "ab,cd" || unknown.row !== 1 ||
    unknown.col !== 0
  ) {
    throw new Error(`tab must not edit: ${JSON.stringify(unknown)}`);
  }
});

Deno.test("editTextareaKey up/down traverse soft-wrapped display lines", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "hello world" wraps at width 5 into "hello" / "world"; the caret at the
  // end sits on display row 1 at display col 5.
  const ta = Textarea({ lines: ["hello world"], width: 5, row: 0, col: 11 });
  const up = editTextareaKey(ta, { name: "up", ...base });
  if (up.row !== 0 || up.col !== 5) throw new Error(`up = ${up.row}/${up.col}`);
  const down = editTextareaKey(ta, { name: "down", ...base });
  if (down.row !== 0 || down.col !== 11) {
    throw new Error(`down = ${down.row}/${down.col}`);
  }
  // The preferred column sticks across the vertical run: from the end of the
  // last display line, three ups climb the display rows keeping col 5.
  const multi = Textarea({
    lines: ["alpha beta", "gamma delta"],
    width: 5,
    row: 1,
    col: 11,
  });
  const u1 = editTextareaKey(multi, { name: "up", ...base });
  if (u1.row !== 1 || u1.col !== 5) throw new Error(`u1 = ${u1.row}/${u1.col}`);
  const u2 = editTextareaKey(multi, { name: "up", ...base });
  if (u2.row !== 0 || u2.col !== 10) {
    throw new Error(`u2 = ${u2.row}/${u2.col}`);
  }
  const u3 = editTextareaKey(multi, { name: "up", ...base });
  if (u3.row !== 0 || u3.col !== 5) throw new Error(`u3 = ${u3.row}/${u3.col}`);
  const d1 = editTextareaKey(multi, { name: "down", ...base });
  if (d1.row !== 0 || d1.col !== 10) {
    throw new Error(`d1 = ${d1.row}/${d1.col}`);
  }
});

Deno.test("editTextareaKey scrolls vertically to keep the caret visible", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const scrollOf = (node: Node): number =>
    (node.props as TextareaProps).scroll ?? 0;
  const ta = Textarea({
    lines: ["1", "2", "3", "4", "5"],
    height: 2,
    row: 0,
    col: 0,
  });
  if (scrollOf(ta) !== 0) throw new Error(`initial scroll = ${scrollOf(ta)}`);
  editTextareaKey(ta, { name: "down", ...base }); // (1,0) — visible
  if (scrollOf(ta) !== 0) {
    throw new Error(`scroll after 1 down = ${scrollOf(ta)}`);
  }
  editTextareaKey(ta, { name: "down", ...base }); // (2,0) — below the window
  if (scrollOf(ta) !== 1) {
    throw new Error(`scroll after 2 downs = ${scrollOf(ta)}`);
  }
  // Only the visible window is composed: rows 2 and 3 (scroll 1, height 2).
  if (ta.children.length !== 2) {
    throw new Error(`window leaves = ${ta.children.length}`);
  }
  if (
    ta.children[0]?.props.text !== "2" || ta.children[1]?.props.text !== "3"
  ) {
    throw new Error(
      `window = ${ta.children.map((c) => c.props.text).join(",")}`,
    );
  }
  if (ta.children[1]?.props.caret !== 0) {
    throw new Error(
      `caret on the windowed leaf = ${ta.children[1]?.props.caret}`,
    );
  }
  editTextareaKey(ta, { name: "up", ...base }); // (1,0) — still inside [1,3)
  if (scrollOf(ta) !== 1) {
    throw new Error(`scroll stays while visible = ${scrollOf(ta)}`);
  }
  editTextareaKey(ta, { name: "up", ...base }); // (0,0) — above the window
  if (scrollOf(ta) !== 0) {
    throw new Error(`scroll after up past the top = ${scrollOf(ta)}`);
  }
});

Deno.test("pasteIntoTextarea inserts text at the caret (single line)", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const next = pasteIntoTextarea(ta, "XY");
  if (next.lines.join(",") !== "ab,cXYd") {
    throw new Error(`lines = ${next.lines.join(",")}`);
  }
  if (next.row !== 1 || next.col !== 3) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,cXYd") {
    throw new Error(`node lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if (
    ta.children[1]?.props.text !== "cXYd" || ta.children[1]?.props.caret !== 3
  ) {
    throw new Error(`node leaf = ${JSON.stringify(ta.children[1]?.props)}`);
  }
  // Pasting at the start / end stays on the same line.
  const start = pasteIntoTextarea(
    Textarea({ lines: ["ab"], row: 0, col: 0 }),
    "X",
  );
  if (start.lines.join(",") !== "Xab" || start.col !== 1) {
    throw new Error(`start paste = ${start.lines.join(",")}/${start.col}`);
  }
  const end = pasteIntoTextarea(
    Textarea({ lines: ["ab"], row: 0, col: 2 }),
    "X",
  );
  if (end.lines.join(",") !== "abX" || end.col !== 3) {
    throw new Error(`end paste = ${end.lines.join(",")}/${end.col}`);
  }
});

Deno.test("pasteIntoTextarea splits lines on pasted newlines", () => {
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  const next = pasteIntoTextarea(ta, "X\nYZ");
  if (next.lines.join(",") !== "ab,cX,YZd") {
    throw new Error(`lines = ${next.lines.join(",")}`);
  }
  if (next.row !== 2 || next.col !== 2) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  // The tail of the original line joins the last pasted segment.
  if (ta.children.length !== 3) {
    throw new Error(`leaves after split = ${ta.children.length}`);
  }
  if (
    ta.children[2]?.props.text !== "YZd" || ta.children[2]?.props.caret !== 2
  ) {
    throw new Error(`tail leaf = ${JSON.stringify(ta.children[2]?.props)}`);
  }
  // A leading newline pastes an empty first line (pure line split).
  const lead = pasteIntoTextarea(
    Textarea({ lines: ["ab"], row: 0, col: 0 }),
    "\nxy",
  );
  if (lead.lines.join(",") !== ",xyab" || lead.row !== 1 || lead.col !== 2) {
    throw new Error(
      `leading newline = ${lead.lines.join(",")}/${lead.row}/${lead.col}`,
    );
  }
  // A trailing newline moves the tail to a fresh line.
  const trail = pasteIntoTextarea(
    Textarea({ lines: ["ab"], row: 0, col: 1 }),
    "x\n",
  );
  if (trail.lines.join(",") !== "ax,b" || trail.row !== 1 || trail.col !== 0) {
    throw new Error(
      `trailing newline = ${trail.lines.join(",")}/${trail.row}/${trail.col}`,
    );
  }
});

Deno.test("pasteIntoTextarea is multi-width aware for wide pastes", () => {
  // コ is a 2-column char. The caret column is a code-unit index (like
  // editTextareaKey): "aコb" is 3 code units, so col 2 is after コ and a
  // paste there lands between コ and b, advancing the caret by the pasted
  // code units.
  const ta = Textarea({ lines: ["aコb"], row: 0, col: 2 });
  const next = pasteIntoTextarea(ta, "世");
  if (next.lines[0] !== "aコ世b") throw new Error(`value = ${next.lines[0]}`);
  if (next.row !== 0 || next.col !== 3) {
    throw new Error(`row/col = ${next.row}/${next.col}`);
  }
  if (
    ta.children[0]?.props.text !== "aコ世b" || ta.children[0]?.props.caret !== 5
  ) {
    throw new Error(`leaf = ${JSON.stringify(ta.children[0]?.props)}`);
  }
  // A wide paste between wide chars keeps the code-unit caret consistent:
  // "コa" is 2 code units, col 1 is between コ and a.
  const mid = pasteIntoTextarea(
    Textarea({ lines: ["コa"], row: 0, col: 1 }),
    "文",
  );
  if (mid.lines[0] !== "コ文a" || mid.col !== 2) {
    throw new Error(`mid wide = ${mid.lines[0]}/${mid.col}`);
  }
});

Deno.test("editTextareaKey steps left/right over a ZWJ family emoji one cluster at a time", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // The line is 'a' + emoji + 'b'; col is a code-unit index. Cluster starts:
  // 'a' at 0, the 11-code-unit emoji at 1, 'b' at 12.
  const right1 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 0 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right1.col !== 1) throw new Error(`right over a = ${right1.col}`);
  const right2 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right2.col !== 12) {
    throw new Error(`right over the emoji = ${right2.col}`);
  }
  const right3 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right3.col !== 13) throw new Error(`right over b = ${right3.col}`);
  const left1 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 13 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left1.col !== 12) throw new Error(`left over b = ${left1.col}`);
  const left2 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left2.col !== 1) throw new Error(`left over the emoji = ${left2.col}`);
  const left3 = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left3.col !== 0) throw new Error(`left over a = ${left3.col}`);
});
