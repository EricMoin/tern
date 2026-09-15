//! Tests: selection overlay persists after release (persistent selecti.

import { createdNodes, state, withFakeAddon } from "./testkit.ts";
import { assertSelection } from "./testkit.ts";
import { mouse } from "./testkit.ts";
import { BarChart, Box, Canvas, Chart, HighlightSpanJs, Node, NodeHandle, Panels, Select, Sparkline, TernAddon, Text, Tree, TuiRenderer, brailleCell, brailleRows, copySelection, createRenderer, dragSelection, endSelection, framesEqual, highlightCode, name, selectWordAt, selectionKey, setAddonForTesting, startSelection } from "./index.ts";


Deno.test("selection overlay persists after release (persistent selection)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    // Active during the gesture.
    if (renderer.selectionText() !== "world") {
      throw new Error(
        `active selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }

    // The release ends the session but leaves the overlay up: the reversed
    // cells survive the gesture (a later copySelection still returns text).
    if (endSelection(renderer, mouse("up_left", 10, 0)) === null) {
      throw new Error("up_left must end the selection");
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });
    if (renderer.selectionText() !== "world") {
      throw new Error(
        `selectionText after release = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("copySelection after release returns the selected text", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    // Read through a function: TS control-flow narrowing would otherwise pin
    // `state.lastClipboard` to the literal of the first assertion below.
    const clipboard = (): string | null => state.lastClipboard;

    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    if (endSelection(renderer, mouse("up_left", 10, 0)) === null) {
      throw new Error("up_left must end the selection");
    }
    // The overlay persists after the release, so the copy still extracts the
    // selected region — no copy-before-end requirement anymore.
    copySelection(renderer);
    if (clipboard() !== "world") {
      throw new Error(`copy after release = ${JSON.stringify(clipboard())}`);
    }
    renderer.destroy();
  });
});

Deno.test("a bare press outside the persistent selection clears it (click-elsewhere)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    // Select "world" (cols 6-10) and release: the overlay persists.
    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    endSelection(renderer, mouse("up_left", 10, 0));
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });

    // A bare press (no drag) on a cell outside the persistent rect is
    // click-elsewhere: the release deselects — no 1-cell residue, no old
    // overlay.
    startSelection(renderer, mouse("down_left", 2, 0));
    if (endSelection(renderer, mouse("up_left", 2, 0)) === null) {
      throw new Error("up_left must end the selection");
    }
    assertSelection(null);
    if (renderer.selectionText() !== "") {
      throw new Error(
        `selectionText after click-elsewhere = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }

    // A bare press INSIDE the persistent rect is not click-elsewhere: it
    // reselects the pressed cell and keeps the overlay (no clear).
    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    endSelection(renderer, mouse("up_left", 10, 0));
    startSelection(renderer, mouse("down_left", 8, 0));
    endSelection(renderer, mouse("up_left", 8, 0));
    assertSelection({ col1: 8, row1: 0, col2: 8, row2: 0 });
    renderer.destroy();
  });
});

Deno.test("selectionKey escape clears the persistent selection", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    // Select "world" and release: the overlay persists.
    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    endSelection(renderer, mouse("up_left", 10, 0));
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });

    // `escape` is the explicit clear: consumed, and the overlay is gone.
    if (
      selectionKey(renderer, {
        name: "escape",
        ctrl: false,
        alt: false,
        shift: false,
      }) !== true
    ) {
      throw new Error("escape must be consumed");
    }
    assertSelection(null);
    if (renderer.selectionText() !== "") {
      throw new Error(
        `selectionText after escape = ${
          JSON.stringify(renderer.selectionText())
        }`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("selectionKey copies on ctrl+shift+c and leaves plain ctrl+c (exit) unconsumed", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 0));

    // ctrl+shift+c copies the active selection text.
    if (
      selectionKey(renderer, {
        name: "char",
        char: "c",
        ctrl: true,
        alt: false,
        shift: true,
      }) !== true
    ) {
      throw new Error("ctrl+shift+c must be consumed");
    }
    if (state.lastClipboard !== "hello") {
      throw new Error(`copy = ${JSON.stringify(state.lastClipboard)}`);
    }

    // Plain ctrl+c is the exit convention: never consumed by the selection
    // handler, so the exit binding still sees it.
    if (
      selectionKey(renderer, {
        name: "char",
        char: "c",
        ctrl: true,
        alt: false,
        shift: false,
      }) !== false
    ) {
      throw new Error("plain ctrl+c must not be consumed");
    }
    // Other keys are not consumed.
    if (
      selectionKey(renderer, {
        name: "char",
        char: "v",
        ctrl: true,
        alt: false,
        shift: false,
      }) !== false
    ) {
      throw new Error("ctrl+v must not be consumed");
    }
    renderer.destroy();
  });
});

Deno.test("selectWordAt applies the word range or leaves the selection untouched at whitespace", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    const range = selectWordAt(renderer, 7, 0);
    if (
      range === null || range.col1 !== 6 || range.row1 !== 0 ||
      range.col2 !== 10 || range.row2 !== 0
    ) {
      throw new Error(`word = ${JSON.stringify(range)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });

    // Whitespace: null, and the selection is left untouched.
    if (selectWordAt(renderer, 5, 0) !== null) {
      throw new Error("whitespace must yield null");
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });
    renderer.destroy();
  });
});

Deno.test("brailleCell maps the 2x4 sub-cell dots to their U+2800 bits (the Rust DOT_BITS layout)", () => {
  // The exact mirror of the Rust canvas renderable's dot->bit map
  // (`DOT_BITS`, src/core/tern-components/src/canvas.rs): sub-cell (0, r) is
  // dot r+1 -> bit 0x01 << r, sub-cell (1, r) is dot r+5 -> bit 0x10 << r —
  // so the JS composition and the native renderable rasterize identical
  // glyphs, glyph for glyph.
  const one = (x: number, y: number): string[] => {
    const rows = ["0000", "0000", "0000", "0000"];
    rows[y] = rows[y]!.slice(0, x) + "1" + rows[y]!.slice(x + 1);
    return rows;
  };
  // Left sub-column: dots 1..4 -> 0x01, 0x02, 0x04, 0x08.
  if (brailleCell(one(0, 0), 0, 0) !== "\u2801") {
    throw new Error(`(0,0) = ${brailleCell(one(0, 0), 0, 0)}`);
  }
  if (brailleCell(one(0, 1), 0, 0) !== "\u2802") {
    throw new Error(`(0,1) = ${brailleCell(one(0, 1), 0, 0)}`);
  }
  if (brailleCell(one(0, 2), 0, 0) !== "\u2804") {
    throw new Error(`(0,2) = ${brailleCell(one(0, 2), 0, 0)}`);
  }
  if (brailleCell(one(0, 3), 0, 0) !== "\u2808") {
    throw new Error(`(0,3) = ${brailleCell(one(0, 3), 0, 0)}`);
  }
  // Right sub-column: dots 5..8 -> 0x10, 0x20, 0x40, 0x80.
  if (brailleCell(one(1, 0), 0, 0) !== "\u2810") {
    throw new Error(`(1,0) = ${brailleCell(one(1, 0), 0, 0)}`);
  }
  if (brailleCell(one(1, 1), 0, 0) !== "\u2820") {
    throw new Error(`(1,1) = ${brailleCell(one(1, 1), 0, 0)}`);
  }
  if (brailleCell(one(1, 2), 0, 0) !== "\u2840") {
    throw new Error(`(1,2) = ${brailleCell(one(1, 2), 0, 0)}`);
  }
  if (brailleCell(one(1, 3), 0, 0) !== "\u2880") {
    throw new Error(`(1,3) = ${brailleCell(one(1, 3), 0, 0)}`);
  }
  // All eight dots: every bit set -> U+28FF.
  if (brailleCell(["11", "11", "11", "11"], 0, 0) !== "\u28ff") {
    throw new Error(`full = ${brailleCell(["11", "11", "11", "11"], 0, 0)}`);
  }
  // A sub-cell past the matrix (a partial cell edge) reads as off.
  if (brailleCell(["1"], 0, 0) !== "\u2801") {
    throw new Error(`partial = ${brailleCell(["1"], 0, 0)}`);
  }
});

Deno.test("brailleRows rasterizes a dot matrix into braille rows", () => {
  // The same pattern the Rust renderable's golden uses
  // (src/core/tern-components/src/canvas.rs `rasterized_rows_for_known_pattern`):
  // a 2x2-cell canvas (4 sub-cell columns x 8 sub-cell rows) with dots on the
  // sub-cell diagonal (x, x) for x in 0..4 plus one at (0, 7):
  //   cell (0,0): dots 1 + 6 = 0x21 -> '⠡'
  //   cell (1,0): dots 3 + 8 = 0x84 -> '⢄'
  //   cell (0,1): dot 4        = 0x08 -> '⠈'
  //   cell (1,1): empty        = 0x00 -> '⠀'
  const rows = brailleRows([
    "1000", // sub-row 0: dot (0, 0)
    "0100", // sub-row 1: dot (1, 1)
    "0010", // sub-row 2: dot (2, 2)
    "0001", // sub-row 3: dot (3, 3)
    "0000", // sub-rows 4-6: blank
    "0000",
    "0000",
    "1000", // sub-row 7: dot (0, 7)
  ]);
  if (rows.length !== 2) throw new Error(`rows = ${JSON.stringify(rows)}`);
  if (rows[0] !== "\u2821\u2884") {
    throw new Error(`row0 = ${JSON.stringify(rows[0])}`); // ⠡⢄
  }
  if (rows[1] !== "\u2808\u2800") {
    throw new Error(`row1 = ${JSON.stringify(rows[1])}`); // ⠈⠀
  }
  // A 1-sub-column x 4-sub-row canvas: only the left column's dots (bits
  // 0..3) -> U+280F.
  const left = brailleRows(["1", "1", "1", "1"]);
  if (left.length !== 1 || left[0] !== "\u280f") {
    throw new Error(`left column = ${JSON.stringify(left)}`);
  }
  // An empty matrix rasterizes to no rows.
  if (brailleRows([]).length !== 0) {
    throw new Error("empty matrix must yield no rows");
  }
});

Deno.test("Canvas composes a flex-column box of braille text leaves (dots stay JS bookkeeping)", () => {
  const canvas = Canvas({ dots: ["10", "01", "00", "00"], fg: "#ff0000" });
  if (canvas.type !== "canvas") throw new Error(`type = ${canvas.type}`);
  if (canvas.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${canvas.props.flex_direction}`);
  }
  // The sub-cell matrix is JS bookkeeping — it never reaches the scene props
  // (mirroring Tree's `nodes` / Panels' `panels`).
  if ("dots" in canvas.props) {
    throw new Error("dots must not reach the scene props");
  }
  // 2 sub-columns x 4 sub-rows rasterize to one braille cell: dots 1 + 6.
  if (canvas.children.length !== 1) {
    throw new Error(`children = ${canvas.children.length}`);
  }
  const leaf = canvas.children[0];
  if (leaf?.type !== "text") throw new Error(`leaf type = ${leaf?.type}`);
  if (leaf.props.text !== "\u2821") {
    throw new Error(`leaf text = ${JSON.stringify(leaf.props.text)}`);
  }
  // The canvas fg paints the braille leaves (mirroring the renderable's row
  // style).
  if (leaf.props.fg !== "#ff0000") {
    throw new Error(`leaf fg = ${leaf.props.fg}`);
  }
});

Deno.test("Canvas golden snapshot rasterizes the same braille as the Rust renderable", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // The exact pattern of the Rust renderable's golden
    // (src/core/tern-components/src/canvas.rs `rasterized_rows_for_known_pattern`):
    // a 2x2-cell canvas — 4 sub-cell columns x 8 sub-cell rows — with dots on
    // the sub-cell diagonal plus one at (0, 7), rasterizing to
    //   ⠡⢄
    //   ⠈⠀
    // so the JS composition and the native renderable agree glyph for glyph.
    renderer.root.addChild(
      Canvas({
        dots: [
          "1000",
          "0100",
          "0010",
          "0001",
          "0000",
          "0000",
          "0000",
          "1000",
        ],
      }),
    );
    const frame = renderer.snapshotFrame(2, 2);
    const expected = ["\u2821\u2884", "\u2808\u2800"]; // ⠡⢄ / ⠈⠀
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected canvas rows: ${JSON.stringify(frame)}`);
    }
    // The styled snapshot paints the same rows (the binding's documented
    // invariant: a row's run texts reconstruct its plain row string).
    const styled = renderer.snapshotStyled(2, 2);
    const reconstructed = styled.map((row) =>
      row.map((run) => run.text).join("")
    );
    if (!framesEqual(reconstructed, expected)) {
      throw new Error(`styled rows = ${JSON.stringify(reconstructed)}`);
    }
    // The canvas materializes as box + text ONLY — no new napi node kind
    // leaks for the canvas element (constitution).
    if (createdNodes.length !== 3) {
      throw new Error(`created nodes = ${JSON.stringify(createdNodes)}`);
    }
    for (const node of createdNodes) {
      if (node.type !== "box" && node.type !== "text") {
        throw new Error(`canvas leaked a native kind: ${node.type}`);
      }
    }
    if (
      createdNodes[0]?.type !== "box" ||
      createdNodes[1]?.type !== "text" ||
      createdNodes[2]?.type !== "text"
    ) {
      throw new Error(`created nodes = ${JSON.stringify(createdNodes)}`);
    }
    renderer.destroy();
  });
});

Deno.test("BarChart composes bottom-aligned eighth-block bar columns (data stays JS bookkeeping)", () => {
  const chart = BarChart({
    data: [3, 1, 4, 2],
    height: 3,
    max: 4,
    gap: 1,
    width: 7,
    show_axis: true,
    fg: "#ff0000",
  });
  if (chart.type !== "bar_chart") throw new Error(`type = ${chart.type}`);
  if (chart.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${chart.props.flex_direction}`);
  }
  // The fixed width stamps the root box; the series + scale are JS
  // bookkeeping — they never reach the scene props (mirroring Canvas' `dots`).
  if (chart.props.width !== 7) throw new Error(`width = ${chart.props.width}`);
  for (
    const key of [
      "data",
      "height",
      "min",
      "max",
      "gap",
      "bar_width",
      "show_axis",
      "full_block",
    ]
  ) {
    if (key in chart.props) {
      throw new Error(`${key} must not reach the scene props`);
    }
  }
  // 3 bar rows (top to bottom) + the axis row.
  if (chart.children.length !== 4) {
    throw new Error(`children = ${chart.children.length}`);
  }
  const texts = chart.children.map((leaf) =>
    (leaf as Node).props.text as string
  );
  // Bars [3,1,4,2] / max 4 / height 3 -> 24 eighths per bar: [18, 6, 24, 12].
  // Row 2 (top): bar0 partial ▂ (2/8), bar1 empty, bar2 full █, bar3 empty.
  if (texts[0] !== "▂   █  ") {
    throw new Error(`top row = ${JSON.stringify(texts[0])}`);
  }
  // Row 1: bar0 full, bar1 empty, bar2 full, bar3 partial ▄ (4/8).
  if (texts[1] !== "█   █ ▄") {
    throw new Error(`mid row = ${JSON.stringify(texts[1])}`);
  }
  // Row 0 (bottom): every bar reaches the shared baseline — bar1 is ▆ (6/8).
  if (texts[2] !== "█ ▆ █ █") {
    throw new Error(`bottom row = ${JSON.stringify(texts[2])}`);
  }
  // The axis row spans the fixed width.
  if (texts[3] !== "───────") {
    throw new Error(`axis row = ${JSON.stringify(texts[3])}`);
  }
  for (const leaf of chart.children) {
    if (leaf.type !== "text") throw new Error(`leaf type = ${leaf.type}`);
    // The chart fg paints the glyph leaves (mirroring Canvas' row style).
    if ((leaf as Node).props.fg !== "#ff0000") {
      throw new Error(`leaf fg = ${(leaf as Node).props.fg}`);
    }
  }
});

Deno.test("BarChart golden snapshot: bar heights + the axis row span the fixed width", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(
      BarChart({
        data: [3, 1, 4, 2],
        height: 3,
        max: 4,
        gap: 1,
        width: 7,
        show_axis: true,
      }),
    );
    const frame = renderer.snapshotFrame(7, 4);
    const expected = ["▂   █  ", "█   █ ▄", "█ ▆ █ █", "───────"];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected bar chart rows: ${JSON.stringify(frame)}`);
    }
    // Bar heights read off the frame: bar2 (max) is a full 3-cell █ column,
    // bar1 (1/4) is a single bottom ▆, bar3 (2/4) is ▄ + █ — all sharing the
    // bottom baseline row (`█ ▆ █ █`), with the axis row beneath spanning the
    // full fixed width (axis alignment).
    if (!framesEqual([frame[2]!], ["█ ▆ █ █"])) {
      throw new Error(`baseline row = ${JSON.stringify(frame[2])}`);
    }
    if (!framesEqual([frame[3]!], ["───────"])) {
      throw new Error(`axis row = ${JSON.stringify(frame[3])}`);
    }
    // The chart materializes as box + text ONLY — no new napi node kind leaks
    // for the bar_chart element (constitution).
    for (const node of createdNodes) {
      if (node.type !== "box" && node.type !== "text") {
        throw new Error(`bar_chart leaked a native kind: ${node.type}`);
      }
    }
    renderer.destroy();
  });
});

Deno.test("BarChart full_block mode paints whole-cell columns; natural width derives from the bars", () => {
  const chart = BarChart({ data: [1, 0.5, 1], height: 3, full_block: true });
  // Natural width: 3 bars x 1 cell + 2 gaps = 5.
  if (chart.props.width !== 5) throw new Error(`width = ${chart.props.width}`);
  const texts = chart.children.map((leaf) =>
    (leaf as Node).props.text as string
  );
  // Cells [3, 2, 3]: rows 2/1/0 — bar0 and bar2 full columns, bar1 two cells.
  if (!framesEqual(texts, ["█   █", "█ █ █", "█ █ █"])) {
    throw new Error(`full_block rows = ${JSON.stringify(texts)}`);
  }
});

Deno.test("BarChart bar_width repeats each glyph across the bar column", () => {
  const chart = BarChart({ data: [1, 0.5], height: 1, max: 1, bar_width: 2 });
  const text = (chart.children[0] as Node).props.text as string;
  if (text !== "██ ▄▄") {
    throw new Error(`bar_width rows = ${JSON.stringify(text)}`);
  }
});

Deno.test("Chart composes braille rows via the canvas rasterizer (data stays JS bookkeeping)", () => {
  const chart = Chart({
    data: [0, 3, 3, 0],
    height: 2,
    width: 4,
    min: 0,
    max: 3,
    show_axis: true,
    bg: "#000000",
  });
  if (chart.type !== "chart") throw new Error(`type = ${chart.type}`);
  if (chart.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${chart.props.flex_direction}`);
  }
  if (chart.props.width !== 4) throw new Error(`width = ${chart.props.width}`);
  for (const key of ["data", "height", "min", "max", "show_axis"]) {
    if (key in chart.props) {
      throw new Error(`${key} must not reach the scene props`);
    }
  }
  // 2 braille rows (8 sub-rows / 4) + the axis row.
  if (chart.children.length !== 3) {
    throw new Error(`children = ${chart.children.length}`);
  }
  const texts = chart.children.map((leaf) =>
    (leaf as Node).props.text as string
  );
  if (!framesEqual(texts.slice(0, 2), ["⣀⠓⠱⠌", "⠼⠀⠀⣃"])) {
    throw new Error(`braille rows = ${JSON.stringify(texts.slice(0, 2))}`);
  }
  if (texts[2] !== "────") {
    throw new Error(`axis row = ${JSON.stringify(texts[2])}`);
  }
  for (const leaf of chart.children) {
    if (leaf.type !== "text") throw new Error(`leaf type = ${leaf.type}`);
    // The chart bg paints the braille leaves (mirroring Canvas' row style).
    if ((leaf as Node).props.bg !== "#000000") {
      throw new Error(`leaf bg = ${(leaf as Node).props.bg}`);
    }
  }
});

Deno.test("Chart golden snapshot: the braille line spans the fixed width; the axis row aligns beneath", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(
      Chart({
        data: [0, 3, 3, 0],
        height: 2,
        width: 4,
        min: 0,
        max: 3,
        show_axis: true,
      }),
    );
    const frame = renderer.snapshotFrame(4, 3);
    const expected = ["⣀⠓⠱⠌", "⠼⠀⠀⣃", "────"];
    if (!framesEqual(frame, expected)) {
      throw new Error(`unexpected chart rows: ${JSON.stringify(frame)}`);
    }
    // The plot rows are exactly the fixed width (4 cells — every braille row
    // is `width` codepoints wide), and the axis row beneath spans it exactly.
    if (
      frame[0]!.length !== 4 || frame[1]!.length !== 4 || frame[2]!.length !== 4
    ) {
      throw new Error(`row widths = ${frame.map((r) => r.length).join(",")}`);
    }
    for (const node of createdNodes) {
      if (node.type !== "box" && node.type !== "text") {
        throw new Error(`chart leaked a native kind: ${node.type}`);
      }
    }
    renderer.destroy();
  });
});

Deno.test("Sparkline block golden: one eighth-block glyph per point at the fixed width", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // Series [1,3,2,4] at its own scale (min 1, max 4): norms 0, 2/3, 1/3, 1
    // -> eighths clamped to at least 1: [1, 5, 3, 8] -> ▁, ▅, ▃, █.
    renderer.root.addChild(Sparkline({ data: [1, 3, 2, 4] }));
    const frame = renderer.snapshotFrame(4, 1);
    if (!framesEqual(frame, ["▁▅▃█"])) {
      throw new Error(`unexpected sparkline rows: ${JSON.stringify(frame)}`);
    }
    // A longer series shows its last `width` points; a shorter one pads at
    // the right — the glyphs stay anchored to the fixed-width baseline.
    renderer.root.addChild(Sparkline({ data: [1, 3, 2, 4], width: 6 }));
    const padded = renderer.snapshotFrame(6, 1);
    if (!framesEqual(padded, ["▁▅▃█  "])) {
      throw new Error(`padded rows = ${JSON.stringify(padded)}`);
    }
    for (const node of createdNodes) {
      if (node.type !== "box" && node.type !== "text") {
        throw new Error(`sparkline leaked a native kind: ${node.type}`);
      }
    }
    renderer.destroy();
  });
});

Deno.test("Sparkline braille golden: dots rasterize through the canvas rasterizer (two per cell)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    // Series [1,3,2,4] at its own scale: dots at sub-rows 3, 1, 2, 0 (from
    // the bottom baseline) in successive sub-columns — cell 0 holds points
    // 0+1 (⠨ = dots 1 + 6), cell 1 holds points 2+3 (⠔ = dots 3 + 5).
    renderer.root.addChild(
      Sparkline({ data: [1, 3, 2, 4], use_braille: true }),
    );
    const frame = renderer.snapshotFrame(4, 1);
    if (!framesEqual(frame, ["⠨⠔⠀⠀"])) {
      throw new Error(
        `unexpected braille sparkline rows: ${JSON.stringify(frame)}`,
      );
    }
    // The fixed-width window: the last `width` points only.
    renderer.root.addChild(
      Sparkline({ data: [1, 3, 2, 4], width: 2, use_braille: true }),
    );
    const windowed = renderer.snapshotFrame(2, 1);
    if (!framesEqual(windowed, ["⠔⠀"])) {
      throw new Error(`windowed rows = ${JSON.stringify(windowed)}`);
    }
    renderer.destroy();
  });
});

Deno.test("highlightCode routes the new grammar fence names through the addon", () => {
  const calls: Array<[string, string]> = [];
  const routingFakeAddon = {
    TuiRenderer: class {},
    NodeHandle: class {},
    create_node: () => ({} as never),
    highlight: (language: string, source: string): HighlightSpanJs[] => {
      calls.push([language, source]);
      return [{
        text: source,
        bold: false,
        italic: false,
        dim: false,
        underline: false,
      }];
    },
  } as unknown as TernAddon;
  setAddonForTesting(routingFakeAddon);
  try {
    // Every new grammar fence name (and its alias) reaches the native addon
    // unchanged, and the echoed span stream reconstructs the source.
    for (
      const name of [
        "python",
        "py",
        "go",
        "toml",
        "yaml",
        "yml",
        "c",
        "cpp",
        "c++",
        "cxx",
      ]
    ) {
      calls.length = 0;
      const spans = highlightCode(name, "x = 1");
      if (calls.length !== 1) {
        throw new Error(`${name}: addon calls = ${calls.length}`);
      }
      const [routed, source] = calls[0]!;
      if (routed !== name) throw new Error(`${name}: routed as ${routed}`);
      if (spans.map((s) => s.text).join("") !== "x = 1") {
        throw new Error(
          `${name}: concat = ${spans.map((s) => s.text).join("")}`,
        );
      }
      if (source !== "x = 1") throw new Error(`${name}: source = ${source}`);
    }
    // The "golang" alias and case-insensitive fence info strings route too.
    for (
      const [given, expected] of [["golang", "golang"], [
        "Python",
        "python",
      ]] as const
    ) {
      calls.length = 0;
      highlightCode(given, "x");
      const routed = calls[0]?.[0];
      if (calls.length !== 1 || routed !== expected) {
        throw new Error(`${given} routed as ${JSON.stringify(calls)}`);
      }
    }
    // Unrecognized names still never reach the addon (markdown is not a
    // grammar in this expansion — see the M3.7 research note).
    calls.length = 0;
    highlightCode("markdown", "x");
    if (calls.length !== 0) throw new Error("markdown reached the addon");
  } finally {
    setAddonForTesting(null);
  }
});
