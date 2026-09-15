//! Tests: snapshotStyled run texts reconstruct the snapshotFrame rows.

import { COMBINING_ACUTE, EDIT_CHARS, EditRng, FAMILY_EMOJI, assertEditCursorInvariant, editBoundaryColumns, editClusters, editKeyEventName, editRandomValue, editRounds, editSeed, editTotalWidth, expectEqual, fakeRenderer } from "./testkit.ts";
import { flush, state, withFakeAddon } from "./testkit.ts";
import { Box, Input, Text, createRenderer, editKey, framesEqual, name, pasteInto, styledFramesEqual, tick } from "./index.ts";


Deno.test("snapshotStyled run texts reconstruct the snapshotFrame rows", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(
      Box(
        { border_style: "rounded", padding: 1 },
        Text({ text: "Hi", fg: "#ff0000" }),
      ),
    );
    const styled = renderer.snapshotStyled(6, 3);
    const plain = renderer.snapshotFrame(6, 3);
    // The binding's documented invariant: concatenating a row's run texts
    // reconstructs the plain render_to_buffer row string exactly.
    const reconstructed = styled.map((row) =>
      row.map((run) => run.text).join("")
    );
    if (!framesEqual(reconstructed, plain)) {
      throw new Error(
        `styled runs do not reconstruct plain rows: ${
          JSON.stringify(reconstructed)
        } vs ${JSON.stringify(plain)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("styledFramesEqual compares row counts, run counts, run text and style fields", () => {
  // Identical frames — the same rows, runs, texts and style fields.
  if (
    !styledFramesEqual(
      [[{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }]],
      [[{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }]],
    )
  ) {
    throw new Error("identical styled frames must be equal");
  }
  // Differing run text.
  if (
    styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{
      text: "Bye",
      fg: "#ff0000",
    }]])
  ) {
    throw new Error("differing run text must be unequal");
  }
  // Differing color field.
  if (
    styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{
      text: "Hi",
      fg: "#00ff00",
    }]])
  ) {
    throw new Error("differing fg must be unequal");
  }
  // Differing modifier field — a run with an explicit modifier differs from
  // one that omits it (the binding only sets modifiers when applied).
  if (
    styledFramesEqual([[{ text: "Hi", fg: "#ff0000" }]], [[{
      text: "Hi",
      fg: "#ff0000",
      bold: true,
    }]])
  ) {
    throw new Error("differing bold must be unequal");
  }
  // Differing hyperlink field — a linked run differs from a plain one (the
  // engine's style equality participates in the hyperlink, so runs split at
  // link boundaries), and the target itself is compared.
  if (
    styledFramesEqual([[{ text: "Hi" }]], [[{
      text: "Hi",
      hyperlink: "https://example.com",
    }]])
  ) {
    throw new Error("differing hyperlink must be unequal");
  }
  if (
    styledFramesEqual(
      [[{ text: "Hi", hyperlink: "https://a.example" }]],
      [[{ text: "Hi", hyperlink: "https://b.example" }]],
    )
  ) {
    throw new Error("differing hyperlink targets must be unequal");
  }
  // Differing underline style / color fields — a variant or colored-underline
  // run differs from a plain one (the engine's style equality participates
  // in both fields, so runs split at underline boundaries), and the values
  // themselves are compared.
  if (
    styledFramesEqual([[{ text: "Hi" }]], [[{
      text: "Hi",
      underlineStyle: "curly",
    }]])
  ) {
    throw new Error("differing underline style must be unequal");
  }
  if (
    styledFramesEqual(
      [[{ text: "Hi", underlineStyle: "double" }]],
      [[{ text: "Hi", underlineStyle: "curly" }]],
    )
  ) {
    throw new Error("differing underline variants must be unequal");
  }
  if (
    styledFramesEqual([[{ text: "Hi" }]], [[{
      text: "Hi",
      underlineColor: "#ff0000",
    }]])
  ) {
    throw new Error("differing underline color must be unequal");
  }
  if (
    styledFramesEqual(
      [[{ text: "Hi", underlineColor: "#ff0000" }]],
      [[{ text: "Hi", underlineColor: "#00ff00" }]],
    )
  ) {
    throw new Error("differing underline colors must be unequal");
  }
  // Differing run count within a row.
  if (styledFramesEqual([[{ text: "Hi" }]], [[{ text: "H" }, { text: "i" }]])) {
    throw new Error("differing run counts must be unequal");
  }
  // Differing row count.
  if (
    styledFramesEqual([[{ text: "Hi" }]], [[{ text: "Hi" }], [{ text: "x" }]])
  ) {
    throw new Error("differing row counts must be unequal");
  }
});

Deno.test("3 requestFrame calls in one tick collapse into a single native render", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    renderer.requestFrame();
    renderer.requestFrame();
    renderer.requestFrame();
    // Nothing paints synchronously: the frame is scheduled, not fired.
    expectEqual(fake.renderCalls, 0, "render calls before flush");
    await flush();
    // The three calls collapsed into one coalesced native render.
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("requestFrame callbacks run after the coalesced native render, in call order", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    const order: string[] = [];
    renderer.requestFrame(() => order.push("a"));
    renderer.requestFrame(() => order.push("b"));
    expectEqual(order.length, 0, "callbacks before the frame fires");
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls");
    if (order.join("") !== "ab") {
      throw new Error(`callback order = ${JSON.stringify(order)}`);
    }
    renderer.destroy();
  });
});

Deno.test("an explicit render() during a pending coalesced frame still paints immediately", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    renderer.requestFrame();
    expectEqual(fake.renderCalls, 0, "render calls before render()");
    renderer.render();
    // The synchronous paint happens right away, superseding the pending
    // coalesced frame: no second render fires when the macrotask would have.
    expectEqual(fake.renderCalls, 1, "render calls after render()");
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("the requestFrame cancel function prevents the scheduled frame", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer();
    const fake = fakeRenderer();
    const cancel = renderer.requestFrame();
    cancel();
    await flush();
    expectEqual(fake.renderCalls, 0, "render calls after cancel");
    renderer.destroy();
  });
});

Deno.test("with maxFps set, a 1000-call requestFrame burst still collapses into one native render", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer({ maxFps: 1000 });
    const fake = fakeRenderer();
    // The burst coalesces exactly like the unthrottled schedule — the
    // pending-frame flag dedupes the arming, so only the first call
    // schedules the (throttled) timer. The 1ms cap's budget cannot delay
    // this first frame: nothing has rendered yet, so `#lastNativeRenderAt`
    // anchors the delay to 0 and the frame fires within the flush.
    for (let i = 0; i < 1000; i++) renderer.requestFrame();
    expectEqual(fake.renderCalls, 0, "render calls before flush");
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("maxFps delays a coalesced frame scheduled inside the budget to the cap", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer({ maxFps: 20 }); // 50 ms per frame
    const fake = fakeRenderer();
    // The first coalesced frame has nothing to space from (never rendered):
    // it fires on the next macrotask, unthrottled.
    const t0 = performance.now();
    await new Promise<void>((resolve) => renderer.requestFrame(resolve));
    const t1 = performance.now();
    // A frame armed immediately after must wait out the remaining budget.
    // JS timers never fire early, so the >= budget spacing is a lower-bound
    // guarantee, not a timing guess.
    await new Promise<void>((resolve) => renderer.requestFrame(resolve));
    const t2 = performance.now();
    expectEqual(fake.renderCalls, 2, "render calls");
    if (t1 - t0 >= 50 - 10) {
      throw new Error(
        `first frame was throttled: ${(t1 - t0).toFixed(1)}ms elapsed`,
      );
    }
    if (t2 - t1 < 50 - 10) {
      throw new Error(
        `second frame fired after ${(t2 - t1).toFixed(1)}ms, expected >= ~50ms`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("an explicit render() bypasses the maxFps throttle and supersedes the pending frame", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer({ maxFps: 20 });
    const fake = fakeRenderer();
    renderer.requestFrame();
    // The explicit paint is synchronous — immediate, never waiting out the
    // frame budget the coalesced schedule would have imposed.
    renderer.render();
    expectEqual(fake.renderCalls, 1, "render calls after render()");
    // The superseded coalesced frame never fires.
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("maxFps 0 leaves the coalesced schedule unthrottled", async () => {
  await withFakeAddon(async () => {
    const renderer = createRenderer({ maxFps: 0 });
    const fake = fakeRenderer();
    renderer.requestFrame();
    renderer.requestFrame();
    renderer.requestFrame();
    await flush();
    expectEqual(fake.renderCalls, 1, "render calls after flush");
    renderer.destroy();
  });
});

Deno.test("maxFps stays JS-side: never forwarded to the native renderer options", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ maxFps: 30 });
    const options = state.lastRendererOptions as Record<string, unknown>;
    if ("maxFps" in options || "max_fps" in options) {
      throw new Error(
        `maxFps leaked into native options: ${JSON.stringify(options)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("Input composes a box with a text leaf carrying value and caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  if (input.type !== "input") throw new Error(`type = ${input.type}`);
  if (input.props.value !== "ab") {
    throw new Error(`value = ${input.props.value}`);
  }
  if (input.props.caret !== 1) throw new Error(`caret = ${input.props.caret}`);
  const leaf = input.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("input must compose a text leaf");
  }
  if (leaf.props.text !== "ab") {
    throw new Error(`leaf text = ${leaf.props.text}`);
  }
  if (leaf.props.caret !== 1) {
    throw new Error(`leaf caret = ${leaf.props.caret}`);
  }
});

Deno.test("Input shows a dim placeholder when empty", () => {
  const input = Input({ placeholder: "type…" });
  const leaf = input.children[0];
  if (leaf === undefined) throw new Error("missing text leaf");
  if (leaf.props.text !== "type…") {
    throw new Error(`placeholder = ${leaf.props.text}`);
  }
  if (leaf.props.dim !== true) throw new Error(`dim = ${leaf.props.dim}`);
  if (leaf.props.caret !== 0) throw new Error(`caret = ${leaf.props.caret}`);
});

Deno.test("editKey inserts a char at the caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  const next = editKey(input, {
    name: "char",
    char: "X",
    ctrl: false,
    alt: false,
    shift: false,
  });
  if (next.value !== "aXb") throw new Error(`value = ${next.value}`);
  if (next.caret !== 2) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "aXb") {
    throw new Error(`node value = ${input.props.value}`);
  }
  if (input.children[0]?.props.text !== "aXb") {
    throw new Error(`leaf text = ${input.children[0]?.props.text}`);
  }
});

Deno.test("editKey backspace removes the char before the caret", () => {
  const input = Input({ value: "ab", caret: 2 });
  const next = editKey(input, {
    name: "backspace",
    ctrl: false,
    alt: false,
    shift: false,
  });
  if (next.value !== "a") throw new Error(`value = ${next.value}`);
  if (next.caret !== 1) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "a") {
    throw new Error(`node value = ${input.props.value}`);
  }
});

Deno.test("editKey moves the caret with arrows, home and end", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const mk = () => Input({ value: "abc", caret: 2 });
  const left = editKey(mk(), { name: "left", ...base });
  if (left.caret !== 1) throw new Error(`left caret = ${left.caret}`);
  const right = editKey(mk(), { name: "right", ...base });
  if (right.caret !== 3) throw new Error(`right caret = ${right.caret}`);
  const home = editKey(mk(), { name: "home", ...base });
  if (home.caret !== 0) throw new Error(`home caret = ${home.caret}`);
  const end = editKey(mk(), { name: "end", ...base });
  if (end.caret !== 3) throw new Error(`end caret = ${end.caret}`);
  // Movement at the boundaries is a no-op.
  const noLeft = editKey(Input({ value: "abc", caret: 0 }), {
    name: "left",
    ...base,
  });
  if (noLeft.caret !== 0) throw new Error(`left at start = ${noLeft.caret}`);
  const noRight = editKey(Input({ value: "abc", caret: 3 }), {
    name: "right",
    ...base,
  });
  if (noRight.caret !== 3) throw new Error(`right at end = ${noRight.caret}`);
  // Unknown keys leave the input unchanged.
  const unknown = editKey(mk(), { name: "tab", ...base });
  if (unknown.value !== "abc" || unknown.caret !== 2) {
    throw new Error(`tab must not edit: ${unknown.value}/${unknown.caret}`);
  }
});

Deno.test("editKey is multi-width aware for the caret column", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "コ" is a 2-column char: the caret after it sits at display column 2.
  const left = editKey(Input({ value: "コa", caret: 2 }), {
    name: "left",
    ...base,
  });
  if (left.caret !== 0) {
    throw new Error(`left over a wide char = ${left.caret}`);
  }
  const right = editKey(Input({ value: "コa", caret: 0 }), {
    name: "right",
    ...base,
  });
  if (right.caret !== 2) {
    throw new Error(`right past a wide char = ${right.caret}`);
  }
  // Inserting at column 2 lands between コ and a, and the caret advances by
  // the inserted char's width.
  const ins = editKey(Input({ value: "コa", caret: 2 }), {
    name: "char",
    char: "b",
    ...base,
  });
  if (ins.value !== "コba") throw new Error(`inserted value = ${ins.value}`);
  if (ins.caret !== 3) throw new Error(`inserted caret = ${ins.caret}`);
  // Backspace over a wide char removes the whole glyph and steps two columns.
  const bs = editKey(Input({ value: "コ", caret: 2 }), {
    name: "backspace",
    ...base,
  });
  if (bs.value !== "" || bs.caret !== 0) {
    throw new Error(`backspace wide = ${bs.value}/${bs.caret}`);
  }
});

Deno.test("editKey steps the cursor over a ZWJ family emoji one cluster at a time", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "a👨‍👩‍👧‍👦b" is 3 grapheme clusters: 'a' (1 col), the family emoji
  // (2 cols, one cluster), 'b' (1 col) — display columns 0, 1–2, 3.
  const mk = (caret: number) => Input({ value: `a${FAMILY_EMOJI}b`, caret });
  // Right steps 0 → 1 → 3 → 4: over 'a', over the whole cluster, over 'b'.
  const r1 = editKey(mk(0), { name: "right", ...base });
  if (r1.caret !== 1) throw new Error(`right over a = ${r1.caret}`);
  const r2 = editKey(mk(1), { name: "right", ...base });
  if (r2.caret !== 3) throw new Error(`right over the emoji = ${r2.caret}`);
  const r3 = editKey(mk(3), { name: "right", ...base });
  if (r3.caret !== 4) throw new Error(`right over b = ${r3.caret}`);
  // Left steps 4 → 3 → 1 → 0 — never a mid-cluster column.
  const l1 = editKey(mk(4), { name: "left", ...base });
  if (l1.caret !== 3) throw new Error(`left over b = ${l1.caret}`);
  const l2 = editKey(mk(3), { name: "left", ...base });
  if (l2.caret !== 1) throw new Error(`left over the emoji = ${l2.caret}`);
  const l3 = editKey(mk(1), { name: "left", ...base });
  if (l3.caret !== 0) throw new Error(`left over a = ${l3.caret}`);
  // Movement never mutates the value.
  const moved = editKey(mk(3), { name: "left", ...base });
  if (moved.value !== `a${FAMILY_EMOJI}b`) {
    throw new Error(`value mutated = ${moved.value}`);
  }
  // home/end land on the boundaries (end = the 4-column display width).
  const end = editKey(mk(0), { name: "end", ...base });
  if (end.caret !== 4) throw new Error(`end caret = ${end.caret}`);
  const home = editKey(mk(4), { name: "home", ...base });
  if (home.caret !== 0) throw new Error(`home caret = ${home.caret}`);
});

Deno.test("editKey backspace removes a ZWJ family emoji as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace from the end removes 'b', then the whole 11-code-unit emoji
  // cluster (stepping two display columns), then 'a' — never a fragment.
  const step1 = editKey(Input({ value: `a${FAMILY_EMOJI}b`, caret: 4 }), {
    name: "backspace",
    ...base,
  });
  if (step1.value !== `a${FAMILY_EMOJI}` || step1.caret !== 3) {
    throw new Error(`backspace b = ${JSON.stringify(step1)}`);
  }
  const step2 = editKey(Input({ value: `a${FAMILY_EMOJI}`, caret: 3 }), {
    name: "backspace",
    ...base,
  });
  if (step2.value !== "a" || step2.caret !== 1) {
    throw new Error(`backspace emoji = ${JSON.stringify(step2)}`);
  }
  const step3 = editKey(Input({ value: "a", caret: 1 }), {
    name: "backspace",
    ...base,
  });
  if (step3.value !== "" || step3.caret !== 0) {
    throw new Error(`backspace a = ${JSON.stringify(step3)}`);
  }
});

Deno.test("editKey steps over a base+combining sequence as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // "a" + "e\u0301" + "b" is 3 grapheme clusters, each 1 display column:
  // the combining mark rides on its base and is never a step of its own.
  const mk = (caret: number) => Input({ value: `a${COMBINING_ACUTE}b`, caret });
  // Right steps 0 → 1 → 2: over 'a', over the whole cluster, over 'b'.
  const r1 = editKey(mk(0), { name: "right", ...base });
  if (r1.caret !== 1) throw new Error(`right over a = ${r1.caret}`);
  const r2 = editKey(mk(1), { name: "right", ...base });
  if (r2.caret !== 2) {
    throw new Error(`right over the combining cluster = ${r2.caret}`);
  }
  const r3 = editKey(mk(2), { name: "right", ...base });
  if (r3.caret !== 3) throw new Error(`right over b = ${r3.caret}`);
  // Left steps 2 → 1 → 0 — never a column between the base and its mark.
  const l1 = editKey(mk(2), { name: "left", ...base });
  if (l1.caret !== 1) throw new Error(`left over b = ${l1.caret}`);
  const l2 = editKey(mk(1), { name: "left", ...base });
  if (l2.caret !== 0) {
    throw new Error(`left over the combining cluster = ${l2.caret}`);
  }
});

Deno.test("editKey backspace removes a base+combining sequence whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace from the end removes 'b', then the whole 2-code-unit cluster
  // (base + mark together), then 'a' — never the bare base or lone mark.
  const step1 = editKey(Input({ value: `a${COMBINING_ACUTE}b`, caret: 3 }), {
    name: "backspace",
    ...base,
  });
  if (step1.value !== `a${COMBINING_ACUTE}` || step1.caret !== 2) {
    throw new Error(`backspace b = ${JSON.stringify(step1)}`);
  }
  const step2 = editKey(Input({ value: `a${COMBINING_ACUTE}`, caret: 2 }), {
    name: "backspace",
    ...base,
  });
  if (step2.value !== "a" || step2.caret !== 1) {
    throw new Error(`backspace combining = ${JSON.stringify(step2)}`);
  }
  const step3 = editKey(Input({ value: "a", caret: 1 }), {
    name: "backspace",
    ...base,
  });
  if (step3.value !== "" || step3.caret !== 0) {
    throw new Error(`backspace a = ${JSON.stringify(step3)}`);
  }
});

Deno.test("pasteInto inserts text at the caret and advances the caret", () => {
  const input = Input({ value: "ab", caret: 1 });
  const next = pasteInto(input, "XY");
  if (next.value !== "aXYb") throw new Error(`value = ${next.value}`);
  if (next.caret !== 3) throw new Error(`caret = ${next.caret}`);
  if (input.props.value !== "aXYb") {
    throw new Error(`node value = ${input.props.value}`);
  }
  if (input.children[0]?.props.text !== "aXYb") {
    throw new Error(`leaf text = ${input.children[0]?.props.text}`);
  }
  if (input.children[0]?.props.caret !== 3) {
    throw new Error(`leaf caret = ${input.children[0]?.props.caret}`);
  }
  // Pasting at the start / end.
  const start = pasteInto(Input({ value: "ab", caret: 0 }), "X");
  if (start.value !== "Xab" || start.caret !== 1) {
    throw new Error(`start paste = ${start.value}/${start.caret}`);
  }
  const end = pasteInto(Input({ value: "ab", caret: 2 }), "X");
  if (end.value !== "abX" || end.caret !== 3) {
    throw new Error(`end paste = ${end.value}/${end.caret}`);
  }
  // Empty paste is a no-op edit.
  const empty = pasteInto(Input({ value: "ab", caret: 1 }), "");
  if (empty.value !== "ab" || empty.caret !== 1) {
    throw new Error(`empty paste = ${empty.value}/${empty.caret}`);
  }
});

Deno.test("pasteInto is multi-width aware at the caret", () => {
  // コ is a 2-column char. The caret after it sits at display column 2; a
  // 1-column paste lands between コ and a and the caret advances by 1.
  const input = Input({ value: "コa", caret: 2 });
  const next = pasteInto(input, "hi");
  if (next.value !== "コhia") throw new Error(`value = ${next.value}`);
  if (next.caret !== 4) throw new Error(`caret = ${next.caret}`);
  // Pasting wide chars advances the caret by their display width.
  const wide = pasteInto(Input({ value: "ab", caret: 1 }), "世");
  if (wide.value !== "a世b") throw new Error(`wide value = ${wide.value}`);
  if (wide.caret !== 3) throw new Error(`wide caret = ${wide.caret}`);
  // A caret column inside a wide char snaps to that char's start; the caret
  // still advances by the pasted width from its original column (mirroring
  // editKey's char-insert math), landing at the start of the wide char.
  const snap = pasteInto(Input({ value: "コa", caret: 1 }), "x");
  if (snap.value !== "xコa") throw new Error(`snap value = ${snap.value}`);
  if (snap.caret !== 2) throw new Error(`snap caret = ${snap.caret}`);
});

Deno.test("pasteInto before a ZWJ cluster inserts at the cluster boundary", () => {
  // Caret at display column 1 = the boundary between 'a' and the family
  // emoji (the emoji's lead column): the paste lands there and the caret
  // advances by the pasted text's cluster width.
  const atBoundary = pasteInto(
    Input({ value: `a${FAMILY_EMOJI}b`, caret: 1 }),
    "X",
  );
  if (atBoundary.value !== `aX${FAMILY_EMOJI}b`) {
    throw new Error(`value = ${atBoundary.value}`);
  }
  if (atBoundary.caret !== 2) throw new Error(`caret = ${atBoundary.caret}`);
  // A caret column inside the emoji's display span (col 2 — its
  // continuation) snaps back to the cluster's start: the paste lands before
  // the cluster, never mid-cluster.
  const snapped = pasteInto(
    Input({ value: `a${FAMILY_EMOJI}b`, caret: 2 }),
    "X",
  );
  if (snapped.value !== `aX${FAMILY_EMOJI}b`) {
    throw new Error(`snap value = ${snapped.value}`);
  }
  if (snapped.caret !== 3) throw new Error(`snap caret = ${snapped.caret}`);
  // Pasting the ZWJ cluster advances the caret by its 2-column width.
  const wide = pasteInto(Input({ value: "ab", caret: 1 }), FAMILY_EMOJI);
  if (wide.value !== `a${FAMILY_EMOJI}b`) {
    throw new Error(`wide value = ${wide.value}`);
  }
  if (wide.caret !== 3) throw new Error(`wide caret = ${wide.caret}`);
});

Deno.test("grapheme invariant fuzz: cursor always on a cluster boundary", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const columns = editBoundaryColumns(value);
    const input = Input({ value, caret: rng.pick(columns) });
    const steps = 1 + rng.below(8);
    for (let step = 0; step < steps; step++) {
      const key = rng.below(6);
      let next;
      if (key === 0) {
        next = editKey(input, {
          name: "char",
          char: rng.pick(EDIT_CHARS),
          ...base,
        });
      } else if (key === 1) {
        next = editKey(input, { name: "backspace", ...base });
      } else if (key === 2) {
        next = editKey(input, { name: "left", ...base });
      } else if (key === 3) {
        next = editKey(input, { name: "right", ...base });
      } else if (key === 4) {
        next = editKey(input, { name: "home", ...base });
      } else {
        next = editKey(input, { name: "end", ...base });
      }
      assertEditCursorInvariant(
        next.value,
        next.caret,
        `round ${round} step ${step} (${editKeyEventName(key)})`,
      );
      // The node's own props must mirror the returned state.
      const props = input.props;
      if (props.value !== next.value || props.caret !== next.caret) {
        throw new Error(
          `round ${round} step ${step}: node props ${
            JSON.stringify(props)
          } diverge from ` +
            `returned ${JSON.stringify(next)}`,
        );
      }
    }
  }
});

Deno.test("grapheme invariant fuzz: cluster-width sums are exact", () => {
  const rng = new EditRng(editSeed());
  const rounds = editRounds();
  const base = { ctrl: false, alt: false, shift: false } as const;
  for (let round = 0; round < rounds; round++) {
    const value = editRandomValue(rng);
    const clusters = editClusters(value);
    const total = editTotalWidth(value);

    // `end` lands on the value's total display width — the sum of every
    // cluster's width.
    const end = editKey(Input({ value, caret: 0 }), { name: "end", ...base });
    if (end.caret !== total) {
      throw new Error(
        `round ${round}: end caret ${end.caret} != total width ${total} of ${
          JSON.stringify(value)
        }`,
      );
    }

    // `right` from 0 walks through every boundary: each step advances by
    // exactly the adjacent cluster's width, ending on the total width.
    const walk = Input({ value, caret: 0 });
    for (const cluster of clusters) {
      const before = walk.props.caret as number;
      const right = editKey(walk, { name: "right", ...base });
      if (right.caret - before !== cluster.width) {
        throw new Error(
          `round ${round}: right advanced ${
            right.caret - before
          } columns, expected ` +
            `${cluster.width} (cluster ${JSON.stringify(cluster.text)} of ${
              JSON.stringify(value)
            })`,
        );
      }
    }
    if (walk.props.caret !== total) {
      throw new Error(
        `round ${round}: right-walk ended at ${walk.props.caret}, expected ${total}`,
      );
    }

    // `left` from the end walks back in reverse, again by exact cluster
    // widths.
    const back = Input({ value, caret: total });
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cluster = clusters[i]!;
      const before = back.props.caret as number;
      const left = editKey(back, { name: "left", ...base });
      if (before - left.caret !== cluster.width) {
        throw new Error(
          `round ${round}: left retreated ${
            before - left.caret
          } columns, expected ` +
            `${cluster.width} (cluster ${JSON.stringify(cluster.text)})`,
        );
      }
    }
    if (back.props.caret !== 0) {
      throw new Error(
        `round ${round}: left-walk ended at ${back.props.caret}, expected 0`,
      );
    }
  }
});
