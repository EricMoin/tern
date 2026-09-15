//! Tests: the events async iterable yields a paste event with the past.

import { FAMILY_EMOJI } from "./testkit.ts";
import { createdNodes, pushEvent, state, withFakeAddon } from "./testkit.ts";
import { Box, Node, Renderer, StreamingText, StyleRunJs, TernEventJs, Text, Textarea, TuiRenderer, createRenderer, framesEqual, loadAddon, styledFramesEqual } from "./index.ts";


Deno.test("the events async iterable yields a paste event with the pasted text", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    pushEvent({ type: "paste", paste: "multi\nline 粘贴" });
    consumer = (async () => {
      for await (const event of renderer.events) {
        if (event.type !== "paste") {
          throw new Error(`first event type = ${event.type}, expected "paste"`);
        }
        if (event.paste !== "multi\nline 粘贴") {
          throw new Error(`paste payload = ${JSON.stringify(event.paste)}`);
        }
        break;
      }
    })();
  });
  await consumer;
});

Deno.test("the events async iterable delivers events pushed after subscription", async () => {
  let consumer: Promise<void> | undefined;
  const received: TernEventJs[] = [];
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    // Subscribe first, then push — events must still arrive (no missed
    // wakeup between the queue check and the waiter registration).
    // Read the length through a function: TS narrows a const-typed empty
    // array's `length` to 0 (the pushes happen after the consumer starts).
    const receivedCount = (): number => received.length;
    consumer = (async () => {
      for await (const event of renderer.events) {
        received.push(event);
        if (receivedCount() === 3) break;
      }
    })();
    // Push all three while the consumer's waiter is registered — the
    // iterator must wake on each, never missing one.
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: true });
    pushEvent({ type: "focus", focus_gained: true });
  });
  await consumer;
  if (received.length !== 3) throw new Error(`received ${received.length}`);
});

Deno.test("destroy closes the events stream", async () => {
  let consumer: Promise<void> | undefined;
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    renderer.destroy();
    consumer = (async () => {
      const received: TernEventJs[] = [];
      for await (const event of renderer.events) {
        received.push(event);
      }
      if (received.length !== 0) {
        throw new Error("a closed stream must yield nothing");
      }
    })();
  });
  await consumer;
});

Deno.test("Renderer.hit_test proxies (col, row) to the native addon", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const path = renderer.hit_test(3, 2);
    if (state.lastHitTest === null || state.lastHitTest[0] !== 3 || state.lastHitTest[1] !== 2) {
      throw new Error(`hit_test received ${JSON.stringify(state.lastHitTest)}`);
    }
    // The fake returns the topmost path [7, 3] verbatim (u64 ids as bigint).
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`hit_test path = ${JSON.stringify(path)}`);
    }
  });
});

Deno.test("Node.contentSize proxies to the native handle", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const stream = StreamingText({ width: 8 });
    renderer.root.addChild(stream);
    // Attaching materialized the node through the fake `create_node` with the
    // streaming_text native type.
    const created = createdNodes[0];
    if (created === undefined || created.type !== "streaming_text") {
      throw new Error(`created native type = ${created?.type}`);
    }
    if (created.props?.width !== 8) {
      throw new Error(`created props = ${JSON.stringify(created.props)}`);
    }
    const size = stream.contentSize();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`contentSize = ${JSON.stringify(size)}`);
    }
  });
});

Deno.test("Node.contentSize on a detached node throws", () => {
  withFakeAddon(() => {
    const node = Text({ text: "x" });
    let threw = false;
    try {
      node.contentSize();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("contentSize on a detached node must throw");
  });
});

Deno.test("the mocked addon exposes hit_test and content_size natively", () => {
  withFakeAddon(() => {
    const addon = loadAddon();
    const renderer = new addon.TuiRenderer({ exit_on_ctrl_c: false });
    const path = renderer.hit_test(1, 1);
    if (path.length !== 2 || path[0] !== 7n || path[1] !== 3n) {
      throw new Error(`native hit_test = ${JSON.stringify(path)}`);
    }
    const handle = addon.create_node("text", { text: "hi" });
    const size = handle.content_size();
    if (size.width !== 11 || size.height !== 2) {
      throw new Error(`native content_size = ${JSON.stringify(size)}`);
    }
  });
});

Deno.test("Renderer.snapshotFrame paints the scene to golden rows via render_to_buffer", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene: a rounded-border box with 1-cell padding
    // around Text('Hi'). The fake addon's `render_to_buffer` paints the
    // captured scene with a mini-compositor mirroring the real compositor's
    // geometry (content-sized box at the origin), so the rows must match the
    // compositor's exact output — the same golden asserted by the
    // `paint_scene_rows` Rust unit test in src/bindings/tern-node/src/lib.rs:
    //   ┌──┐
    //   │Hi│
    //   └──┘
    // with trailing blanks padded to the 6-column viewport width.
    renderer.root.addChild(
      Box({ border_style: "rounded", padding: 1 }, Text({ text: "Hi" })),
    );
    const frame = renderer.snapshotFrame(6, 3);
    const expected = ["┌──┐  ", "│Hi│  ", "└──┘  "];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected frame rows: ${JSON.stringify(frame)}`);
    }
    // The viewport was forwarded to the native method.
    if (
      state.lastSnapshotSize === null || state.lastSnapshotSize[0] !== 6 ||
      state.lastSnapshotSize[1] !== 3
    ) {
      throw new Error(
        `viewport not forwarded: ${JSON.stringify(state.lastSnapshotSize)}`,
      );
    }
    // The scene was materialized through the fake addon (box + text).
    if (
      createdNodes.length !== 2 || createdNodes[0]?.type !== "box" ||
      createdNodes[1]?.type !== "text"
    ) {
      throw new Error(`created nodes = ${JSON.stringify(createdNodes)}`);
    }
    renderer.destroy();
  });
});

Deno.test("scrollOptimization on/off renderers snapshot identical golden frames across a scroll and a mutation", () => {
  withFakeAddon(() => {
    // Two headless renderers with identical scenes — the only difference is
    // the M2.1 scroll fast-path flag (`scrollOptimization`). The flag only
    // changes the native FLUSH strategy for a scroll frame (one DECSTBM
    // scroll command + the exposed band vs a cell-by-cell diff); it must
    // never change the painted screen, so the `snapshotFrame()` sequences
    // (each a full repaint) are cell-for-cell identical across the flag,
    // and the final frame is exactly the full repaint of the final scene.
    const on = createRenderer({
      headless: true,
      size: { width: 40, height: 10 },
      scrollOptimization: true,
    });
    const onOptions = state.lastRendererOptions as Record<string, unknown>;
    const off = createRenderer({
      headless: true,
      size: { width: 40, height: 10 },
      scrollOptimization: false,
    });
    const offOptions = state.lastRendererOptions as Record<string, unknown>;
    // The camelCase flag routes to the snake_case native constructor option
    // in both directions.
    if (onOptions.scroll_optimization !== true) {
      throw new Error(
        `scrollOptimization: true not forwarded: ${JSON.stringify(onOptions)}`,
      );
    }
    if (offOptions.scroll_optimization !== false) {
      throw new Error(
        `scrollOptimization: false not forwarded: ${
          JSON.stringify(offOptions)
        }`,
      );
    }

    // Identical scenes: a borderless box stacking three text leaves as a
    // flex column at the origin (rows 0..2) — the shape a scrolled content
    // region takes. The row leaves are mutated for the scroll / mutation
    // edits below.
    const onBox = on.root.addChild(
      Box(
        {},
        Text({ text: "aaaaa" }),
        Text({ text: "bbbbb" }),
        Text({ text: "ccccc" }),
      ),
    );
    const offBox = off.root.addChild(
      Box(
        {},
        Text({ text: "aaaaa" }),
        Text({ text: "bbbbb" }),
        Text({ text: "ccccc" }),
      ),
    );
    const W = 40;
    const H = 10;
    // The full repaint a fresh compositor produces for a column of `texts`
    // at the origin: one row per text, blanks padded to the viewport.
    const golden = (...texts: string[]): string[] => [
      ...texts.map((t) => t + " ".repeat(W - t.length)),
      ...Array.from({ length: H - texts.length }, () => " ".repeat(W)),
    ];

    // Frame 1 — the initial paint: both renderers start from the same scene.
    on.render();
    off.render();
    const f1on = on.snapshotFrame(W, H);
    const f1off = off.snapshotFrame(W, H);
    if (!framesEqual(f1on, f1off)) {
      throw new Error("initial frames differ across the flag");
    }
    if (!framesEqual(f1on, golden("aaaaa", "bbbbb", "ccccc"))) {
      throw new Error("initial frame is not the full repaint");
    }

    // Frame 2 — the content scrolls up one row (in a real terminal this
    // frame's diff is a full-width vertical scroll, the fast-path trigger):
    // the top two rows shift down one row and a new row appears at the
    // bottom.
    for (const rows of [onBox.children, offBox.children]) {
      rows[0]!.setProps({ text: "bbbbb" });
      rows[1]!.setProps({ text: "ccccc" });
      rows[2]!.setProps({ text: "ddddd" });
    }
    on.render();
    off.render();
    const f2on = on.snapshotFrame(W, H);
    const f2off = off.snapshotFrame(W, H);
    if (!framesEqual(f2on, f2off)) {
      throw new Error("scrolled frames differ across the flag");
    }
    if (!framesEqual(f2on, golden("bbbbb", "ccccc", "ddddd"))) {
      throw new Error("scrolled frame is not the full repaint");
    }

    // Frame 3 — an in-place mutation in the middle row (a normal diff
    // against the retained post-scroll frame, not a scroll): the fast path
    // must not corrupt the retained buffer, so the final screen is still the
    // cell-for-cell full repaint of the final scene.
    onBox.children[1]!.setProps({ text: "XXXXX" });
    offBox.children[1]!.setProps({ text: "XXXXX" });
    on.render();
    off.render();
    const f3on = on.snapshotFrame(W, H);
    const f3off = off.snapshotFrame(W, H);
    if (!framesEqual(f3on, f3off)) {
      throw new Error("mutated frames differ across the flag");
    }
    if (!framesEqual(f3on, golden("bbbbb", "XXXXX", "ddddd"))) {
      throw new Error("final frame is not the full repaint of the final scene");
    }

    on.destroy();
    off.destroy();
  });
});

Deno.test("Renderer.snapshotFrame defaults the viewport to the native shared size", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Text({ text: "x" }));
    // No viewport args: the native method falls back to its shared viewport,
    // so the JS layer must delegate with undefined, undefined.
    renderer.snapshotFrame();
    if (
      state.lastSnapshotSize === null || state.lastSnapshotSize[0] !== undefined ||
      state.lastSnapshotSize[1] !== undefined
    ) {
      throw new Error(
        `default viewport not forwarded: ${JSON.stringify(state.lastSnapshotSize)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("framesEqual compares row counts and row strings", () => {
  if (!framesEqual(["┌──┐  ", "│Hi│  "], ["┌──┐  ", "│Hi│  "])) {
    throw new Error("identical frames must be equal");
  }
  if (framesEqual(["┌──┐  ", "│Hi│  "], ["┌──┐  ", "│Hi   "])) {
    throw new Error("differing rows must be unequal");
  }
  if (framesEqual(["┌──┐  "], ["┌──┐  ", "│Hi│  "])) {
    throw new Error("differing row counts must be unequal");
  }
  if (framesEqual([], ["x"])) {
    throw new Error("empty vs non-empty must be unequal");
  }
});

Deno.test("snapshotFrame golden keeps a ZWJ family emoji intact on the caret line", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // A single-line textarea "a👨‍👩‍👧‍👦b" with the caret at display column
    // 1 — the grapheme-cluster boundary between 'a' and the family emoji.
    // The caret rides the first (only) display row, which is the caret line.
    renderer.root.addChild(
      Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }),
    );
    const frame = renderer.snapshotFrame(6, 1);
    // The caret line paints the full cluster as ONE 2-column glyph — 'a' at
    // column 0, the emoji at column 1 with its continuation cell masked to a
    // space (the `buffer_rows` convention), 'b' at column 3 — padded to the
    // 6-column viewport. A per-code-unit painter would fragment the emoji
    // into surrogate halves.
    const expected = [`a${FAMILY_EMOJI} b  `];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected caret-line rows: ${JSON.stringify(frame)}`);
    }
    // The caret leaf carries the caret at the cluster boundary (display
    // column 1) — the caret sits on the same line as the intact emoji.
    const leaf = renderer.root.children[0]?.children[0];
    if (leaf?.props.caret !== 1 || leaf?.props.text !== `a${FAMILY_EMOJI}b`) {
      throw new Error(`caret leaf = ${JSON.stringify(leaf?.props)}`);
    }
    renderer.destroy();
  });
});

Deno.test("Renderer.snapshotStyled paints the scene to golden styled runs via render_to_buffer_styled", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene (the same one snapshotFrame's golden test
    // paints): a rounded-border box with 1-cell padding around a bold red
    // Text('Hi'). The styled fake paints the same geometry into runs —
    // border/padding cells unstyled, the inner text cells carrying the
    // leaf's lifted style — and merges adjacent cells with identical
    // style, mirroring the real render_to_buffer_styled (see the
    // `render_to_buffer_styled_*` Rust unit tests in
    // src/bindings/tern-node/src/lib.rs).
    renderer.root.addChild(
      Box(
        { border_style: "rounded", padding: 1 },
        Text({ text: "Hi", fg: "#ff0000", bold: true }),
      ),
    );
    const frame = renderer.snapshotStyled(6, 3);
    // Adjacent cells with identical style merge into one run: the unstyled
    // border glyphs fold with the unstyled trailing padding spaces on each
    // row, while the styled inner text stays its own run between the two
    // unstyled `│` cells.
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐  " }],
      [{ text: "│" }, { text: "Hi", fg: "#ff0000", bold: true }, {
        text: "│  ",
      }],
      [{ text: "└──┘  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The viewport was forwarded to the native method.
    if (
      state.lastStyledSnapshotSize === null ||
      state.lastStyledSnapshotSize[0] !== 6 ||
      state.lastStyledSnapshotSize[1] !== 3
    ) {
      throw new Error(
        `viewport not forwarded: ${JSON.stringify(state.lastStyledSnapshotSize)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("Box borderColor paints the border cells' fg in snapshotStyled runs", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene with a `borderColor`: the border glyphs now
    // carry that color as their fg, so each border run splits from the
    // default-styled blanks into its own `fg: "#ff0000"` run — the styled
    // snapshot reports the border color (the real compositor swaps the border
    // cells' fg — see the `render_to_buffer_styled_border_color_*` Rust unit
    // tests in src/bindings/tern-node/src/lib.rs). The glyphs and the inner
    // text stay unchanged.
    renderer.root.addChild(
      Box(
        { border_style: "rounded", borderColor: "#ff0000", padding: 1 },
        Text({ text: "Hi" }),
      ),
    );
    const frame = renderer.snapshotStyled(6, 3);
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐", fg: "#ff0000" }, { text: "  " }],
      [
        { text: "│", fg: "#ff0000" },
        { text: "Hi" },
        { text: "│", fg: "#ff0000" },
        { text: "  " },
      ],
      [{ text: "└──┘", fg: "#ff0000" }, { text: "  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The camelCase alias reaches the native layer as the snake_case style
    // key: the fake node mirror carries `border_color`.
    const boxNode = renderer.root.children[0];
    if (boxNode === undefined) {
      throw new Error("the box child must be materialized");
    }
    if (boxNode.props.border_color !== "#ff0000") {
      throw new Error(
        `border_color = ${JSON.stringify(boxNode.props.border_color)}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("Text hyperlink paints the link target onto the styled run", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The canonical golden scene with a `hyperlink` on the inner text: the
    // inner "Hi" run now carries `hyperlink: "https://example.com"` — the
    // fake's mirror of the engine threading the `href` style key into the
    // style's hyperlink and the styled snapshot surfacing it as `hyperlink`
    // (like the real surface, the key is present only when set, so the
    // border/padding cells stay unstyled and the run splits from them).
    renderer.root.addChild(
      Box(
        { border_style: "rounded", padding: 1 },
        Text({ text: "Hi", hyperlink: "https://example.com" }),
      ),
    );
    const frame = renderer.snapshotStyled(6, 3);
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐  " }],
      [{ text: "│" }, { text: "Hi", hyperlink: "https://example.com" }, {
        text: "│  ",
      }],
      [{ text: "└──┘  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The camelCase alias reaches the native layer as the `href` style key
    // (the key convert.rs recognizes): the fake node mirror carries `href`,
    // and the alias is consumed — exactly like `border_color`.
    const boxNode = renderer.root.children[0];
    if (boxNode === undefined) {
      throw new Error("the box child must be materialized");
    }
    const textNode = boxNode.children[0];
    if (textNode === undefined) {
      throw new Error("the text leaf must be materialized");
    }
    if (textNode.props.href !== "https://example.com") {
      throw new Error(`href = ${JSON.stringify(textNode.props.href)}`);
    }
    if ("hyperlink" in textNode.props) {
      throw new Error(
        `the camelCase alias must be consumed, got ${
          JSON.stringify(textNode.props)
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("Text underline style and color paint onto the styled run", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // A text with an underline style variant and an underline color: the
    // inner "Hi" run carries `underlineStyle: "curly"` and
    // `underlineColor: "#ff0000"` — the fake's mirror of the engine
    // threading the `underline_style` / `underline_color` style keys into
    // the style's variant/color and the styled snapshot surfacing them
    // (like the real surface, the keys are present only when set, so the
    // border/padding cells stay unstyled and the run splits from them).
    renderer.root.addChild(
      Box(
        { border_style: "rounded", padding: 1 },
        Text({
          text: "Hi",
          underlineStyle: "curly",
          underlineColor: "#ff0000",
        }),
      ),
    );
    const frame = renderer.snapshotStyled(6, 3);
    const expected: StyleRunJs[][] = [
      [{ text: "┌──┐  " }],
      [
        { text: "│" },
        { text: "Hi", underlineStyle: "curly", underlineColor: "#ff0000" },
        { text: "│  " },
      ],
      [{ text: "└──┘  " }],
    ];
    if (!styledFramesEqual(frame, expected)) {
      throw new Error(`unexpected styled runs: ${JSON.stringify(frame)}`);
    }
    // The camelCase aliases reach the native layer as the snake_case style
    // keys (the keys convert.rs recognizes): the fake node mirror carries
    // `underline_style` / `underline_color`, and the aliases are consumed —
    // exactly like `href`.
    const boxNode = renderer.root.children[0];
    if (boxNode === undefined) {
      throw new Error("the box child must be materialized");
    }
    const textNode = boxNode.children[0];
    if (textNode === undefined) {
      throw new Error("the text leaf must be materialized");
    }
    if (textNode.props.underline_style !== "curly") {
      throw new Error(
        `underline_style = ${JSON.stringify(textNode.props.underline_style)}`,
      );
    }
    if (textNode.props.underline_color !== "#ff0000") {
      throw new Error(
        `underline_color = ${JSON.stringify(textNode.props.underline_color)}`,
      );
    }
    if ("underlineStyle" in textNode.props) {
      throw new Error(
        `the camelCase alias must be consumed, got ${
          JSON.stringify(textNode.props)
        }`,
      );
    }
    if ("underlineColor" in textNode.props) {
      throw new Error(
        `the camelCase alias must be consumed, got ${
          JSON.stringify(textNode.props)
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("Text underline variants distinguish styled runs (double / curly / dotted)", () => {
  withFakeAddon(() => {
    // Each variant paints its own run carrying the variant keyword: a double
    // run never equals a curly one, and neither merges with the plain border
    // — the fake's mirror of the engine splitting runs on underline-style
    // equality.
    const variants = ["double", "curly", "dotted"] as const;
    for (const variant of variants) {
      const renderer = createRenderer();
      renderer.root.addChild(
        Box(
          { border_style: "rounded", padding: 1 },
          Text({ text: "Hi", underlineStyle: variant }),
        ),
      );
      const frame = renderer.snapshotStyled(6, 3);
      const expected: StyleRunJs[][] = [
        [{ text: "┌──┐  " }],
        [{ text: "│" }, { text: "Hi", underlineStyle: variant }, {
          text: "│  ",
        }],
        [{ text: "└──┘  " }],
      ];
      if (!styledFramesEqual(frame, expected)) {
        throw new Error(
          `variant ${variant} unexpected styled runs: ${JSON.stringify(frame)}`,
        );
      }
      renderer.destroy();
    }
    // Cross-variant: a double run differs from a curly run — the equality
    // contract splits runs at the underline boundary.
    if (
      styledFramesEqual(
        [[{ text: "Hi", underlineStyle: "double" }]],
        [[{ text: "Hi", underlineStyle: "curly" }]],
      )
    ) {
      throw new Error("differing underline variants must be unequal");
    }
  });
});

Deno.test("appendSpan hyperlink translates the camelCase alias to the href style key", () => {
  // The span-style path goes through the same `props_to_style_map` as node
  // props (the binding recognizes `href`, not `hyperlink`), so the alias is
  // translated at ingestion: the recorded span carries the scene-facing key.
  const node = StreamingText();
  node.appendSpan("tern", { hyperlink: "https://example.com", bold: true });
  const first = node.spans[0];
  if (first === undefined) throw new Error("the recorded span is missing");
  if (first.text !== "tern") {
    throw new Error(`text = ${JSON.stringify(first.text)}`);
  }
  if (first.style?.href !== "https://example.com") {
    throw new Error(`href = ${JSON.stringify(first.style?.href)}`);
  }
  if ("hyperlink" in (first.style ?? {})) {
    throw new Error(
      `the camelCase alias must be consumed, got ${
        JSON.stringify(first.style)
      }`,
    );
  }
  if (first.style?.bold !== true) {
    throw new Error("other style keys pass through untouched");
  }
});

Deno.test("appendSpan underline aliases translate to the snake_case style keys", () => {
  // The span-style path goes through the same `props_to_style_map` as node
  // props (the binding recognizes `underline_style` / `underline_color`,
  // not the camelCase spellings), so the aliases are translated at
  // ingestion: the recorded span carries the scene-facing keys.
  const node = StreamingText();
  node.appendSpan("tern", {
    underlineStyle: "curly",
    underlineColor: "#00ff00",
  });
  const first = node.spans[0];
  if (first === undefined) throw new Error("the recorded span is missing");
  if (first.text !== "tern") {
    throw new Error(`text = ${JSON.stringify(first.text)}`);
  }
  if (first.style?.underline_style !== "curly") {
    throw new Error(
      `underline_style = ${JSON.stringify(first.style?.underline_style)}`,
    );
  }
  if (first.style?.underline_color !== "#00ff00") {
    throw new Error(
      `underline_color = ${JSON.stringify(first.style?.underline_color)}`,
    );
  }
  if ("underlineStyle" in (first.style ?? {})) {
    throw new Error(
      `the camelCase alias must be consumed, got ${
        JSON.stringify(first.style)
      }`,
    );
  }
  if ("underlineColor" in (first.style ?? {})) {
    throw new Error(
      `the camelCase alias must be consumed, got ${
        JSON.stringify(first.style)
      }`,
    );
  }
});

Deno.test("Renderer.snapshotStyled defaults the viewport to the native shared size", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Text({ text: "x" }));
    // No viewport args: the native method falls back to its shared viewport,
    // so the JS layer must delegate with undefined, undefined.
    renderer.snapshotStyled();
    if (
      state.lastStyledSnapshotSize === null ||
      state.lastStyledSnapshotSize[0] !== undefined ||
      state.lastStyledSnapshotSize[1] !== undefined
    ) {
      throw new Error(
        `default viewport not forwarded: ${
          JSON.stringify(state.lastStyledSnapshotSize)
        }`,
      );
    }
    renderer.destroy();
  });
});
