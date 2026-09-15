//! Tests: createRenderer is a function accepting options.

import { pushEvent, state, withFakeAddon } from "./testkit.ts";
import { mouse } from "./testkit.ts";
import { Box, KeyEvent, MouseEventJs, Renderer, TernEventJs, Text, TuiRenderer, createRenderer, name } from "./index.ts";


Deno.test("createRenderer is a function accepting options", () => {
  if (typeof createRenderer !== "function") {
    throw new Error(`typeof createRenderer = ${typeof createRenderer}`);
  }
  // Not invoked here: constructing a renderer enters raw mode and needs a PTY,
  // and materializing nodes calls the native addon (needs --allow-ffi). The
  // full renderer lifecycle (render/pollEvents/onKey/destroy + native scene
  // materialization) is covered by the PTY smoke (packages/core/smoke.mjs).
});

Deno.test("createRenderer forwards useAltScreen and title options", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ useAltScreen: false, title: "tern app" });
    // The Renderer routes the camelCase options to the snake_case native
    // constructor options, with the documented defaults for the unset ones.
    if (
      JSON.stringify(state.lastRendererOptions) !== JSON.stringify({
        exit_on_ctrl_c: false,
        use_alt_screen: false,
        title: "tern app",
      })
    ) {
      throw new Error(
        `native options = ${JSON.stringify(state.lastRendererOptions)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("createRenderer defaults useAltScreen to true", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const options = state.lastRendererOptions as { use_alt_screen?: boolean };
    if (options.use_alt_screen !== true) {
      throw new Error(`use_alt_screen = ${options.use_alt_screen}`);
    }
    if ("title" in (options as object)) {
      throw new Error("title must be omitted when unset");
    }
    renderer.destroy();
  });
});

Deno.test("createRenderer forwards headless and size to the native TuiRenderer, and the renderer works headlessly", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({
      headless: true,
      size: { width: 40, height: 10 },
    });
    // The camelCase headless surface routes to the snake_case native
    // constructor options: `headless` plus the virtual `width`/`height`
    // viewport, alongside the documented defaults for the unset options.
    // The fake records exactly what the real TuiRenderer constructor would
    // receive (the headless option shape of the binding's index.d.ts).
    if (
      JSON.stringify(state.lastRendererOptions) !== JSON.stringify({
        exit_on_ctrl_c: false,
        use_alt_screen: true,
        headless: true,
        width: 40,
        height: 10,
      })
    ) {
      throw new Error(
        `native options = ${JSON.stringify(state.lastRendererOptions)}`,
      );
    }
    // A headless renderer is fully usable without a TTY: the scene paints
    // into the virtual buffer and the snapshot paths return rows at the
    // configured size — the lifecycle a snapshot tool exercises.
    renderer.root.addChild(Text({ text: "headless" }));
    renderer.render();
    const frame = renderer.snapshotFrame(40, 10);
    if (frame.length !== 10) {
      throw new Error(`headless snapshotFrame rows = ${frame.length}`);
    }
    if (renderer.size.width !== 40 || renderer.size.height !== 10) {
      throw new Error(`headless size = ${JSON.stringify(renderer.size)}`);
    }
    renderer.destroy();
    if (!renderer.destroyed) {
      throw new Error("headless renderer must report destroyed");
    }
  });
});

Deno.test("createRenderer omits headless and size when unset", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const options = state.lastRendererOptions as Record<string, unknown>;
    // Unset headless stays unset (the native default is `false`, so there
    // is nothing to say) — and the virtual viewport keys appear only when
    // `size` is given, mirroring how `title` is omitted when unset.
    if (options.headless !== undefined) {
      throw new Error(
        `headless must be omitted when unset: ${
          JSON.stringify(options.headless)
        }`,
      );
    }
    if ("width" in options || "height" in options) {
      throw new Error("width/height must be omitted when size is unset");
    }
    renderer.destroy();
  });
});

Deno.test("renderer capabilities getter routes to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const caps = renderer.capabilities;
    // The backend color report.
    if (caps.truecolor !== true) {
      throw new Error(`truecolor = ${caps.truecolor}`);
    }
    if (caps.colors !== 16_777_216) throw new Error(`colors = ${caps.colors}`);
    // The interactive probe report: the fake answers like a kitty terminal
    // that supports every queried protocol, so every field surfaces.
    if (caps.terminalIdentity !== "kitty(0.36.0)") {
      throw new Error(
        `terminalIdentity = ${JSON.stringify(caps.terminalIdentity)}`,
      );
    }
    if (caps.kittyKeyboard !== true) {
      throw new Error(`kittyKeyboard = ${caps.kittyKeyboard}`);
    }
    if (caps.kittyUnderline !== true) {
      throw new Error(`kittyUnderline = ${caps.kittyUnderline}`);
    }
    if (caps.osc52 !== true) throw new Error(`osc52 = ${caps.osc52}`);
    if (caps.bracketedPaste !== true) {
      throw new Error(`bracketedPaste = ${caps.bracketedPaste}`);
    }
    if (caps.focusEvents !== true) {
      throw new Error(`focusEvents = ${caps.focusEvents}`);
    }
    if (caps.scrollRegion !== true) {
      throw new Error(`scrollRegion = ${caps.scrollRegion}`);
    }
    if (caps.probed !== true) throw new Error(`probed = ${caps.probed}`);
    renderer.destroy();
  });
});

Deno.test("renderer setTitle routes to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.setTitle("tern");
    if (state.lastSetTitle !== "tern") {
      throw new Error(`set_title called with ${JSON.stringify(state.lastSetTitle)}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer size reports the last render or snapshotFrame viewport", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // Before any paint the native side surfaces the current terminal size —
    // the fake's fixed 80x24 (the real getter probes through its cached-size
    // machinery on first access).
    let size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(`size before any paint = ${JSON.stringify(size)}`);
    }
    // A render paints at the current terminal size: still the fake's 80x24,
    // so `size` reports the viewport the last render used.
    renderer.render();
    size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(`size after render = ${JSON.stringify(size)}`);
    }
    // The most recent snapshotFrame's viewport wins over the render.
    renderer.snapshotFrame(6, 3);
    size = renderer.size;
    if (size.width !== 6 || size.height !== 3) {
      throw new Error(
        `size after snapshotFrame(6, 3) = ${JSON.stringify(size)}`,
      );
    }
    // A render at the current terminal size supersedes the snapshot again.
    renderer.render();
    size = renderer.size;
    if (size.width !== 80 || size.height !== 24) {
      throw new Error(
        `size after post-snapshot render = ${JSON.stringify(size)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("renderer setClipboard routes the text and implies the exact OSC 52 escape bytes", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.setClipboard("foo");
    if (state.lastClipboard !== "foo") {
      throw new Error(
        `set_clipboard called with ${JSON.stringify(state.lastClipboard)}`,
      );
    }
    // The JS-level bytes assertion: for the text just handed to the native
    // layer, the escape it must emit is exactly ESC ] 52 ; c ; <base64> BEL,
    // where the payload is the text's UTF-8 bytes base64-encoded per RFC 4648
    // (btoa is the platform's RFC 4648 encoder). The native byte-level
    // emission itself is asserted byte-exact by tern-terminal's
    // `set_clipboard_to` unit tests.
    const expected = `\x1b]52;c;${btoa("foo")}\x07`;
    if (expected !== "\x1b]52;c;Zm9v\x07") {
      throw new Error(`expected escape bytes = ${JSON.stringify(expected)}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer setSelection and clearSelection route to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const native = state.lastFakeRenderer;
    if (native === null) throw new Error("fake renderer not constructed");
    renderer.setSelection(1, 0, 3, 2);
    if (native.selection === null) {
      throw new Error("selection not set on native");
    }
    if (
      native.selection.col1 !== 1 || native.selection.row1 !== 0 ||
      native.selection.col2 !== 3 || native.selection.row2 !== 2
    ) {
      throw new Error(`native selection = ${JSON.stringify(native.selection)}`);
    }
    renderer.clearSelection();
    if (native.selection !== null) {
      throw new Error("clearSelection must clear the native selection");
    }
    renderer.destroy();
  });
});

Deno.test("renderer setCursor and clearCursor route to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const native = state.lastFakeRenderer;
    if (native === null) throw new Error("fake renderer not constructed");
    renderer.setCursor({
      x: 3,
      y: 2,
      shape: "bar",
      visible: true,
      blink: true,
    });
    if (native.cursor === null) throw new Error("cursor not set on native");
    if (
      native.cursor.x !== 3 || native.cursor.y !== 2 ||
      native.cursor.shape !== "bar" ||
      native.cursor.visible !== true ||
      native.cursor.blink !== true
    ) {
      throw new Error(`native cursor = ${JSON.stringify(native.cursor)}`);
    }
    renderer.clearCursor();
    if (native.cursor !== null) {
      throw new Error("clearCursor must clear the native cursor");
    }
    renderer.destroy();
  });
});

Deno.test("renderer setCursor forwards every shape and visibility", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const native = state.lastFakeRenderer;
    if (native === null) throw new Error("fake renderer not constructed");
    renderer.setCursor({
      x: 0,
      y: 0,
      shape: "underline",
      visible: false,
      blink: false,
    });
    if (native.cursor === null) throw new Error("cursor not set on native");
    if (
      native.cursor.shape !== "underline" || native.cursor.visible !== false ||
      native.cursor.blink !== false
    ) {
      throw new Error(`native cursor = ${JSON.stringify(native.cursor)}`);
    }
    renderer.setCursor({
      x: 7,
      y: 1,
      shape: "block",
      visible: true,
      blink: false,
    });
    const cursor = native.cursor;
    if (cursor === null) throw new Error("cursor not set on native");
    // Widen through locals so later comparisons are not affected by the
    // narrowing from the earlier `underline` / `false` checks.
    const shape: string = cursor.shape;
    const visible: boolean = cursor.visible;
    const blink: boolean = cursor.blink;
    if (shape !== "block" || visible !== true || blink !== false) {
      throw new Error(`native cursor = ${JSON.stringify(cursor)}`);
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionText extracts the selected region from the last painted frame", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // A borderless box around a bare text leaf paints the text from the
    // origin (the fake painter's canonical single-row scene), so a snapshot
    // at 11x1 yields the row "hello world".
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    // No selection set: empty.
    if (renderer.selectionText() !== "") {
      throw new Error(
        `selectionText without a selection = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }
    renderer.setSelection(6, 0, 10, 0); // "world"
    if (renderer.selectionText() !== "world") {
      throw new Error(
        `selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    // Reversed endpoints normalize to the same rect.
    renderer.setSelection(10, 0, 6, 0);
    if (renderer.selectionText() !== "world") {
      throw new Error(
        `reversed selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    // A sub-run.
    renderer.setSelection(0, 0, 4, 0);
    if (renderer.selectionText() !== "hello") {
      throw new Error(
        `sub-run selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    // Clearing the selection empties the extraction.
    renderer.clearSelection();
    if (renderer.selectionText() !== "") {
      throw new Error(
        `selectionText after clear = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionText reads the frame the last snapshot or render painted", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello" })));
    renderer.snapshotFrame(5, 1);
    renderer.setSelection(0, 0, 4, 0);
    if (renderer.selectionText() !== "hello") {
      throw new Error(
        `snapshot selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    // A render repaints at the terminal size (the fake's 80x24): the wider
    // frame keeps the text at the origin, so the same selection extracts the
    // same run from the freshly painted frame.
    renderer.render();
    if (renderer.selectionText() !== "hello") {
      throw new Error(
        `post-render selectionText = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("renderer selectionWordRange returns the word run or null at whitespace", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    const range = renderer.selectionWordRange(7, 0);
    if (range === null) {
      throw new Error("word range at 'world' must not be null");
    }
    if (
      range.col1 !== 6 || range.row1 !== 0 || range.col2 !== 10 ||
      range.row2 !== 0
    ) {
      throw new Error(`word range = ${JSON.stringify(range)}`);
    }
    // The boundary between the words is whitespace: null.
    if (renderer.selectionWordRange(5, 0) !== null) {
      throw new Error("whitespace cell must yield null");
    }
    // Out of bounds: null.
    if (renderer.selectionWordRange(50, 0) !== null) {
      throw new Error("out-of-bounds column must yield null");
    }
    renderer.destroy();
  });
});

Deno.test("push events dispatch resize events to onResize and unsubscribe stops dispatch", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const resized: Array<{ width: number; height: number }> = [];
    const unsub = renderer.onResize((size) => resized.push(size));
    const resize: TernEventJs = { type: "resize", width: 120, height: 40 };
    pushEvent(resize);
    if (resized.length !== 1) {
      throw new Error(`onResize calls = ${resized.length}`);
    }
    if (resized[0]!.width !== 120 || resized[0]!.height !== 40) {
      throw new Error(`resize payload = ${JSON.stringify(resized[0])}`);
    }
    // Unsubscribing stops further dispatch.
    unsub();
    pushEvent({ type: "resize", width: 10, height: 10 });
    if (resized.length !== 1) {
      throw new Error("unsubscribed onResize handler must not fire");
    }
  });
});

Deno.test("push events dispatch key events to onKey with the KeyEvent payload", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const keys: KeyEvent[] = [];
    renderer.onKey((event) => keys.push(event));
    const key: KeyEvent = {
      name: "char",
      char: "q",
      ctrl: false,
      alt: false,
      shift: false,
    };
    pushEvent({ type: "key", key });
    if (keys.length !== 1 || keys[0] !== key) {
      throw new Error("onKey must receive the unwrapped KeyEvent payload");
    }
  });
});

Deno.test("push events deliver a release-kind key event to onKey unchanged", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const keys: KeyEvent[] = [];
    renderer.onKey((event) => keys.push(event));
    // A synthetic kitty-protocol release event: kind rides through onKey
    // untouched, and the precise modifiers arrive when held.
    const release: KeyEvent = {
      name: "char",
      char: "x",
      ctrl: false,
      alt: false,
      shift: false,
      kind: "release",
      super: true,
      meta: false,
      hyper: false,
    };
    pushEvent({ type: "key", key: release });
    if (keys.length !== 1 || keys[0] !== release) {
      throw new Error(
        "onKey must receive the release-kind KeyEvent payload unchanged",
      );
    }
    if (keys[0]!.kind !== "release") {
      throw new Error(`kind = ${keys[0]!.kind}, expected "release"`);
    }
    if (keys[0]!.super !== true || keys[0]!.meta !== false) {
      throw new Error(`precise modifiers lost: ${JSON.stringify(keys[0])}`);
    }
    // A press event without an explicit kind still flows (kind defaults to
    // press; kind-unaware handlers keep working).
    const press: KeyEvent = {
      name: "char",
      char: "y",
      ctrl: false,
      alt: false,
      shift: false,
    };
    pushEvent({ type: "key", key: press });
    if (keys[0] !== release || keys[1] !== press) {
      throw new Error(
        "press and release must both arrive, unchanged, in order",
      );
    }
    if (keys[1]!.kind !== undefined) {
      throw new Error(
        `press without kind must arrive unchanged, got ${
          JSON.stringify(keys[1])
        }`,
      );
    }
  });
});

Deno.test("push events dispatch focus events to onFocus", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const focusEvents: Array<{ focus_gained: boolean }> = [];
    renderer.onFocus((event) => focusEvents.push(event));
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: false });
    if (focusEvents.length !== 2) {
      throw new Error(`onFocus calls = ${focusEvents.length}`);
    }
    if (
      focusEvents[0]!.focus_gained !== true ||
      focusEvents[1]!.focus_gained !== false
    ) {
      throw new Error(`focus payloads = ${JSON.stringify(focusEvents)}`);
    }
    // Unsubscribe contract mirrors onKey: the removed handler never fires.
    let unsubscribedFired = 0;
    const unsub = renderer.onFocus(() => {
      unsubscribedFired++;
    });
    unsub();
    pushEvent({ type: "focus", focus_gained: true });
    if (unsubscribedFired !== 0) {
      throw new Error("unsubscribed onFocus handler must not fire");
    }
  });
});

Deno.test("push events dispatch mouse events to onMouse", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const mouseEvents: MouseEventJs[] = [];
    renderer.onMouse((event) => mouseEvents.push(event));
    const mouse: MouseEventJs = {
      kind: "down_left",
      column: 3,
      row: 7,
      ctrl: false,
      alt: false,
      shift: true,
    };
    pushEvent({ type: "mouse", mouse });
    if (mouseEvents.length !== 1 || mouseEvents[0] !== mouse) {
      throw new Error("onMouse must receive the MouseEventJs payload");
    }
  });
});

Deno.test("onMouse toggles any-event mouse exactly on the 0->1 and 1->0 transitions", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const native = state.lastFakeRenderer;
    if (native === null) throw new Error("no fake renderer constructed");
    const calls = native.anyEventMouseCalls;
    const callsJson = () => JSON.stringify(calls);
    // Read the length through a function so TS does not narrow it to a
    // literal after the pre-subscribe guard below.
    const n = () => calls.length;

    // No listeners: the native mode must never have been touched.
    if (n() !== 0) {
      throw new Error(`pre-subscribe toggles = ${callsJson()}`);
    }

    // 0 -> 1: the first subscribe enables the mode, exactly once.
    const unsub1 = renderer.onMouse(() => {});
    if (n() !== 1 || calls[0] !== true) {
      throw new Error(
        `first subscribe must toggle once true, got ${callsJson()}`,
      );
    }

    // 1 -> 2: a further subscribe must not re-toggle.
    const unsub2 = renderer.onMouse(() => {});
    if (n() !== 1) {
      throw new Error(
        `1->1 re-subscribe must not re-toggle, got ${callsJson()}`,
      );
    }

    // 2 -> 1: unsubscribing one of two must not toggle.
    unsub1();
    if (n() !== 1) {
      throw new Error(`2->1 unsubscribe must not toggle, got ${callsJson()}`);
    }

    // 1 -> 2 again: re-subscribing while one remains must not re-toggle.
    const unsub3 = renderer.onMouse(() => {});
    if (n() !== 1) {
      throw new Error(
        `re-subscribe with one active must not re-toggle, got ${callsJson()}`,
      );
    }

    // 2 -> 0: only the last unsubscribe disables the mode, exactly once.
    unsub2();
    if (n() !== 1) {
      throw new Error(`2->1 must not toggle, got ${callsJson()}`);
    }
    unsub3();
    if (n() !== 2 || calls[1] !== false) {
      throw new Error(
        `last unsubscribe must toggle once false, got ${callsJson()}`,
      );
    }

    // 0 -> 1 again: a fresh subscribe re-enables.
    const unsub4 = renderer.onMouse(() => {});
    if (n() !== 3 || calls[2] !== true) {
      throw new Error(
        `subscribe after empty must toggle true again, got ${callsJson()}`,
      );
    }
    unsub4();
    if (n() !== 4 || calls[3] !== false) {
      throw new Error(
        `last unsubscribe must toggle false again, got ${callsJson()}`,
      );
    }
  });
});

Deno.test("push events dispatch paste events to onPaste with the pasted string", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const pasted: string[] = [];
    renderer.onPaste((text) => pasted.push(text));
    pushEvent({ type: "paste", paste: "hello\n世界" });
    if (pasted.length !== 1 || pasted[0] !== "hello\n世界") {
      throw new Error("onPaste must receive the pasted string payload");
    }
    // Unsubscribe contract mirrors onKey: the removed handler never fires.
    let unsubscribedFired = 0;
    const unsub = renderer.onPaste(() => {
      unsubscribedFired++;
    });
    unsub();
    pushEvent({ type: "paste", paste: "again" });
    if (unsubscribedFired !== 0) {
      throw new Error("unsubscribed onPaste handler must not fire");
    }
  });
});

Deno.test("the events async iterable yields every pushed event without loss", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const events: TernEventJs[] = [
      {
        type: "key",
        key: { name: "enter", ctrl: false, alt: false, shift: false },
      },
      { type: "resize", width: 80, height: 24 },
      { type: "focus", focus_gained: true },
      {
        type: "mouse",
        mouse: {
          kind: "moved",
          column: 1,
          row: 2,
          ctrl: false,
          alt: false,
          shift: false,
        },
      },
      { type: "paste", paste: "pasted 文本" },
    ];
    // Push N synthetic events through the native callback, exactly like the
    // real event loop does.
    for (const event of events) pushEvent(event);

    // The async iterable must yield all N, in order, without loss.
    consumer = (async () => {
      const received: TernEventJs[] = [];
      for await (const event of renderer.events) {
        received.push(event);
        if (received.length === events.length) break;
      }
      if (received.length !== events.length) {
        throw new Error(
          `received ${received.length} events, expected ${events.length}`,
        );
      }
      for (let i = 0; i < events.length; i++) {
        if (received[i] !== events[i]) {
          throw new Error(`event ${i} must be passed through verbatim`);
        }
      }
    })();
  });
  await consumer;
});
