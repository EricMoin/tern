//! Tests: M4.5 golden: setTheme(B) repaints a mounted scene identical .

import { fakeHandleOf, flush, state, withFakeAddon } from "./testkit.ts";
import { THEME_A, THEME_B } from "./testkit.ts";
import { Box, Renderer, Text, createRenderer, framesEqual, getTheme, resolveTheme, setTheme, styledFramesEqual } from "./index.ts";


Deno.test("M4.5 golden: setTheme(B) repaints a mounted scene identical to a fresh mount under B", async () => {
  await withFakeAddon(async () => {
    // Mount the canonical themed scene: an `input`-preset box (border comes
    // from the preset) with a `primary`-role text leaf (colors from the
    // palette), resolved against the active theme at creation time.
    const mount = (): Renderer => {
      const renderer = createRenderer({
        headless: true,
        size: { width: 20, height: 6 },
      });
      const box = Box(resolveTheme(getTheme(), { component: "input", padding: 1 }));
      renderer.root.addChild(box);
      box.addChild(Text(resolveTheme(getTheme(), { text: "hi", role: "primary" })));
      renderer.render();
      return renderer;
    };
    setTheme(THEME_A);
    const r1 = mount();
    const frameA = r1.snapshotFrame();
    const styledA = r1.snapshotStyled();
    // The switch repaints the SAME scene under theme B...
    setTheme(THEME_B);
    await flush(); // the coalesced repaint fires
    const switched = r1.snapshotFrame();
    const switchedStyled = r1.snapshotStyled();
    // ...and a fresh mount created directly under theme B paints identically.
    setTheme(THEME_B);
    const r2 = mount();
    const freshB = r2.snapshotFrame();
    const freshStyledB = r2.snapshotStyled();
    if (!framesEqual(switched, freshB)) {
      throw new Error(
        `plain frames differ:\nA-under-B:\n${switched.join("\n")}\n` +
          `fresh-B:\n${freshB.join("\n")}`,
      );
    }
    if (!styledFramesEqual(switchedStyled, freshStyledB)) {
      throw new Error("styled frames differ between the switched and fresh mounts");
    }
    // Sanity: the switch really changed the painted cells (A != B) — the
    // golden comparison above must not be trivially equal.
    if (framesEqual(switched, frameA)) {
      throw new Error("the switch must change the painted frame");
    }
    if (styledFramesEqual(switchedStyled, styledA)) {
      throw new Error("the switch must change the styled frame");
    }
  });
});

Deno.test("M4.5 diff: a theme switch pushes only changed keys via set_prop, never a full-map set_props", async () => {
  await withFakeAddon(async () => {
    setTheme(THEME_A);
    const renderer = createRenderer({
      headless: true,
      size: { width: 20, height: 6 },
    });
    const box = Box(resolveTheme(getTheme(), { component: "input", padding: 1 }));
    renderer.root.addChild(box);
    const text = Text(resolveTheme(getTheme(), { text: "hi", role: "primary" }));
    box.addChild(text);
    renderer.render();
    const boxHandle = fakeHandleOf(box);
    const textHandle = fakeHandleOf(text);
    if (boxHandle === null || textHandle === null) {
      throw new Error("attached nodes must have native handles");
    }
    // No writes since creation materialized the props.
    if (boxHandle.propWrites.length !== 0 || boxHandle.fullWrites !== 0) {
      throw new Error(`box baseline writes: ${JSON.stringify(boxHandle.propWrites)}`);
    }
    if (textHandle.propWrites.length !== 0 || textHandle.fullWrites !== 0) {
      throw new Error(`text baseline writes: ${JSON.stringify(textHandle.propWrites)}`);
    }
    const rendersBefore = state.lastFakeRenderer?.renderCalls ?? 0;
    setTheme(THEME_B);
    // The box re-resolves fg/bg/border_style; the leaf re-resolves fg/bg.
    // Only the changed keys go through the single-key set_prop path — never
    // a whole-map set_props replace (fullWrites stays 0).
    const boxWrites = boxHandle.propWrites;
    if (
      boxWrites.length !== 3 ||
      boxWrites[0]?.[0] !== "fg" || boxWrites[0]?.[1] !== "#00bb00" ||
      boxWrites[1]?.[0] !== "bg" || boxWrites[1]?.[1] !== "#000022" ||
      boxWrites[2]?.[0] !== "border_style" || boxWrites[2]?.[1] !== "thick"
    ) {
      throw new Error(
        `expected 3 single-key box writes, got ${JSON.stringify(boxWrites)}`,
      );
    }
    if (boxHandle.fullWrites !== 0) {
      throw new Error("the box switch must never use the full-map set_props");
    }
    const textWrites = textHandle.propWrites;
    if (
      textWrites.length !== 2 ||
      textWrites[0]?.[0] !== "fg" || textWrites[0]?.[1] !== "#00bb00" ||
      textWrites[1]?.[0] !== "bg" || textWrites[1]?.[1] !== "#000022"
    ) {
      throw new Error(
        `expected 2 single-key text writes, got ${JSON.stringify(textWrites)}`,
      );
    }
    if (textHandle.fullWrites !== 0) {
      throw new Error("the text switch must never use the full-map set_props");
    }
    // The switch schedules exactly one coalesced repaint (requestFrame) — no
    // synchronous paint, one after the macrotask.
    if ((state.lastFakeRenderer?.renderCalls ?? 0) !== rendersBefore) {
      throw new Error("the switch must not paint synchronously");
    }
    await flush();
    if ((state.lastFakeRenderer?.renderCalls ?? 0) !== rendersBefore + 1) {
      throw new Error("the switch must schedule exactly one coalesced repaint");
    }
  });
});

Deno.test("M4.5: nodes without role/component hints receive zero native calls during a switch", async () => {
  await withFakeAddon(async () => {
    setTheme(THEME_A);
    const renderer = createRenderer({
      headless: true,
      size: { width: 20, height: 6 },
    });
    const plain = Text({ text: "no hints" });
    const box = Box({ padding: 1 }, plain);
    renderer.root.addChild(box);
    renderer.render();
    const boxHandle = fakeHandleOf(box);
    const plainHandle = fakeHandleOf(plain);
    if (boxHandle === null || plainHandle === null) {
      throw new Error("attached nodes must have native handles");
    }
    const rendersBefore = state.lastFakeRenderer?.renderCalls ?? 0;
    setTheme(THEME_B);
    if (boxHandle.propWrites.length !== 0 || boxHandle.fullWrites !== 0) {
      throw new Error(
        `un-hinted box got native writes: ${JSON.stringify(boxHandle.propWrites)}`,
      );
    }
    if (plainHandle.propWrites.length !== 0 || plainHandle.fullWrites !== 0) {
      throw new Error(
        `un-hinted leaf got native writes: ${JSON.stringify(plainHandle.propWrites)}`,
      );
    }
    // Nothing changed → no repaint scheduled either.
    await flush();
    if ((state.lastFakeRenderer?.renderCalls ?? 0) !== rendersBefore) {
      throw new Error("an all-un-hinted switch must not schedule a repaint");
    }
  });
});

Deno.test("M4.5: a no-op switch (same theme) performs zero native calls", async () => {
  await withFakeAddon(async () => {
    setTheme(THEME_A);
    const renderer = createRenderer({
      headless: true,
      size: { width: 20, height: 6 },
    });
    const box = Box(resolveTheme(getTheme(), { component: "input", padding: 1 }));
    renderer.root.addChild(box);
    const text = Text(resolveTheme(getTheme(), { text: "hi", role: "primary" }));
    box.addChild(text);
    renderer.render();
    const boxHandle = fakeHandleOf(box);
    const textHandle = fakeHandleOf(text);
    if (boxHandle === null || textHandle === null) {
      throw new Error("attached nodes must have native handles");
    }
    const rendersBefore = state.lastFakeRenderer?.renderCalls ?? 0;
    // Identical overrides → the merged theme is equal → every re-resolution
    // equals the current props → the diff is empty → zero native calls.
    setTheme(THEME_A);
    if (boxHandle.propWrites.length !== 0 || boxHandle.fullWrites !== 0) {
      throw new Error(
        `no-op box writes: ${JSON.stringify(boxHandle.propWrites)}`,
      );
    }
    if (textHandle.propWrites.length !== 0 || textHandle.fullWrites !== 0) {
      throw new Error(
        `no-op leaf writes: ${JSON.stringify(textHandle.propWrites)}`,
      );
    }
    await flush();
    if ((state.lastFakeRenderer?.renderCalls ?? 0) !== rendersBefore) {
      throw new Error("a no-op switch must not schedule a repaint");
    }
  });
});
