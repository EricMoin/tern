//! Tests: DiffView with no hunks yields an empty column.

import { state } from "./testkit.ts";
import { diffHunks, diffLeafStyle, diffRowTexts, keyBase, selectOptions, tableColumns, tableKeyBase, tableRows } from "./testkit.ts";
import { DIFF_ADD_FG, DIFF_DEL_FG, DiffView, Node, SELECT_FILTER_PLACEHOLDER, Select, Table, name, selectKey, tableKey, visibleOptions, visibleTableRows } from "./index.ts";


Deno.test("DiffView with no hunks yields an empty column", () => {
  const diff = DiffView({ hunks: [] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.children.length !== 0) {
    throw new Error(`rows = ${diff.children.length}`);
  }
  if ("hunks" in diff.props) {
    throw new Error("hunks must not reach the scene props");
  }
});

Deno.test("DiffView inline_highlight splits paired add/del lines at char granularity", () => {
  const diff = DiffView({
    hunks: [
      { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
      { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
    ],
    inline_highlight: true,
  });
  const delRow = diff.children[0]!;
  const addRow = diff.children[1]!;
  // Gutter + marker are unchanged from unified mode (width-1 gutters).
  if (diffRowTexts(delRow).slice(0, 2).join("|") !== "2  |-") {
    throw new Error(
      `del gutter|marker = ${JSON.stringify(diffRowTexts(delRow).slice(0, 2))}`,
    );
  }
  if (diffRowTexts(addRow).slice(0, 2).join("|") !== "  2|+") {
    throw new Error(
      `add gutter|marker = ${JSON.stringify(diffRowTexts(addRow).slice(0, 2))}`,
    );
  }
  // The paired content splits into per-segment leaves inside a row box.
  const delContent = delRow.children[2]!;
  const addContent = addRow.children[2]!;
  if (delContent.type !== "box" || delContent.props.flex_direction !== "row") {
    throw new Error("split del content must be a row box");
  }
  if (addContent.type !== "box" || addContent.props.flex_direction !== "row") {
    throw new Error("split add content must be a row box");
  }
  const expect = (
    content: Node,
    golden: Array<{ text: string; fg: string; bold?: boolean }>,
  ): void => {
    const segs = content.children;
    if (segs.length !== golden.length) {
      throw new Error(`segments = ${segs.length}, want ${golden.length}`);
    }
    for (let i = 0; i < golden.length; i++) {
      const got = diffLeafStyle(segs[i]!);
      const want = golden[i]!;
      if (
        got.text !== want.text || got.fg !== want.fg || got.bold !== want.bold
      ) {
        throw new Error(
          `segment ${i} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
      }
      // Changed chars are additionally underlined; plain chars are not.
      if (want.bold && got.underline !== true) {
        throw new Error(`changed segment ${i} must be underlined`);
      }
      if (!want.bold && got.underline !== undefined) {
        throw new Error(`plain segment ${i} must not be underlined`);
      }
    }
  };
  // Golden buffer: unchanged chars keep the kind color plain; the changed
  // digit renders bold + underlined on top of it.
  expect(delContent, [
    { text: "    let x = ", fg: DIFF_DEL_FG },
    { text: "1", fg: DIFF_DEL_FG, bold: true },
    { text: ";", fg: DIFF_DEL_FG },
  ]);
  expect(addContent, [
    { text: "    let x = ", fg: DIFF_ADD_FG },
    { text: "2", fg: DIFF_ADD_FG, bold: true },
    { text: ";", fg: DIFF_ADD_FG },
  ]);
  // The segments always re-join the original line text exactly.
  const join = (content: Node): string =>
    content.children.map((seg) => seg.props.text as string).join("");
  if (join(delContent) !== "    let x = 1;") {
    throw new Error(`del text = ${JSON.stringify(join(delContent))}`);
  }
  if (join(addContent) !== "    let x = 2;") {
    throw new Error(`add text = ${JSON.stringify(join(addContent))}`);
  }
});

Deno.test("DiffView inline_highlight keeps unpaired lines plain and whole-line changes uniform", () => {
  const diff = DiffView({
    hunks: [
      { kind: "del", old_line: 1, new_line: 0, text: "foo" }, // no adjacent add
      { kind: "ctx", old_line: 2, new_line: 1, text: "same" },
      { kind: "del", old_line: 3, new_line: 0, text: "aaa" },
      { kind: "add", old_line: 0, new_line: 2, text: "bbb" }, // whole-line change
    ],
    inline_highlight: true,
  });
  // A deleted line with no adjacent add stays a single plain text leaf.
  const lone = diff.children[0]!;
  const loneContent = lone.children[2]!;
  if (loneContent.type !== "text" || loneContent.props.text !== "foo") {
    throw new Error(
      `unpaired del content = ${JSON.stringify(diffLeafStyle(loneContent))}`,
    );
  }
  if (loneContent.props.bold !== undefined) {
    throw new Error("unpaired del must not be highlighted");
  }
  // A pair with no common chars is one all-changed segment per side — still a
  // single leaf, but bold + underlined (the whole line changed).
  const delAll = diff.children[2]!;
  const addAll = diff.children[3]!;
  for (const [row, text] of [[delAll, "aaa"], [addAll, "bbb"]] as const) {
    const content = row.children[2]!;
    if (content.type !== "text" || content.props.text !== text) {
      throw new Error(
        `all-changed content = ${JSON.stringify(diffLeafStyle(content))}`,
      );
    }
    if (content.props.bold !== true || content.props.underline !== true) {
      throw new Error("all-changed content must be bold + underlined");
    }
  }
});

Deno.test("DiffView mode=side composes two aligned columns with per-column gutters", () => {
  const diff = DiffView({ hunks: [...diffHunks], mode: "side" });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.props.flex_direction !== "row") {
    throw new Error(`flex_direction = ${diff.props.flex_direction}`);
  }
  if (diff.props.gap !== 1) throw new Error(`gap = ${diff.props.gap}`);
  if (
    "hunks" in diff.props || "mode" in diff.props ||
    "inline_highlight" in diff.props
  ) {
    throw new Error(
      "hunks/mode/inline_highlight must not reach the scene props",
    );
  }
  const oldCol = diff.children[0]!;
  const newCol = diff.children[1]!;
  if (oldCol.type !== "box" || oldCol.props.flex_direction !== "column") {
    throw new Error("the old side must be a column box");
  }
  if (newCol.type !== "box" || newCol.props.flex_direction !== "column") {
    throw new Error("the new side must be a column box");
  }
  // Aligned by line pair: one row per hunk line in both columns.
  if (
    oldCol.children.length !== diffHunks.length ||
    newCol.children.length !== diffHunks.length
  ) {
    throw new Error("columns must carry one row per hunk line");
  }
  const row = (col: Node, i: number): string =>
    diffRowTexts(col.children[i]!).join("|");
  // Old column: deletions + context, additions blank; its gutter right-aligns
  // on the old line numbers (width 2: 1, 2, 3, 10, 11).
  if (row(oldCol, 0) !== " 1| |  fn main() {") {
    throw new Error(`old[0] = ${JSON.stringify(row(oldCol, 0))}`);
  }
  if (row(oldCol, 1) !== " 2|-|    let x = 1;") {
    throw new Error(`old[1] = ${JSON.stringify(row(oldCol, 1))}`);
  }
  if (row(oldCol, 2) !== "  | |") {
    throw new Error(`old[2] = ${JSON.stringify(row(oldCol, 2))}`);
  }
  if (row(oldCol, 3) !== " 3| |  }") {
    throw new Error(`old[3] = ${JSON.stringify(row(oldCol, 3))}`);
  }
  if (row(oldCol, 4) !== "10| |  宽度对齐测试") {
    throw new Error(`old[4] = ${JSON.stringify(row(oldCol, 4))}`);
  }
  if (row(oldCol, 5) !== "11|-|    old line") {
    throw new Error(`old[5] = ${JSON.stringify(row(oldCol, 5))}`);
  }
  if (row(oldCol, 6) !== "  | |") {
    throw new Error(`old[6] = ${JSON.stringify(row(oldCol, 6))}`);
  }
  // New column: additions + context, deletions blank; its gutter right-aligns
  // on the new line numbers (width 2: 1, 2, 3, 11, 12).
  if (row(newCol, 0) !== " 1| |  fn main() {") {
    throw new Error(`new[0] = ${JSON.stringify(row(newCol, 0))}`);
  }
  if (row(newCol, 1) !== "  | |") {
    throw new Error(`new[1] = ${JSON.stringify(row(newCol, 1))}`);
  }
  if (row(newCol, 2) !== " 2|+|    let x = 2;") {
    throw new Error(`new[2] = ${JSON.stringify(row(newCol, 2))}`);
  }
  if (row(newCol, 3) !== " 3| |  }") {
    throw new Error(`new[3] = ${JSON.stringify(row(newCol, 3))}`);
  }
  if (row(newCol, 4) !== "11| |  宽度对齐测试") {
    throw new Error(`new[4] = ${JSON.stringify(row(newCol, 4))}`);
  }
  if (row(newCol, 5) !== "  | |") {
    throw new Error(`new[5] = ${JSON.stringify(row(newCol, 5))}`);
  }
  if (row(newCol, 6) !== "12|+|    new line") {
    throw new Error(`new[6] = ${JSON.stringify(row(newCol, 6))}`);
  }
});

Deno.test("DiffView mode=side aligned pairs fit a wide viewport without overflow", () => {
  const diff = DiffView({ hunks: [...diffHunks], mode: "side" });
  const oldCol = diff.children[0]!;
  const newCol = diff.children[1]!;
  // Display width of one column cell's composed text (CJK chars measure 2
  // cells, matching the engine's multi-width handling).
  const cellWidth = (cell: Node): number => {
    let w = 0;
    for (const leaf of cell.children) {
      for (const ch of leaf.props.text as string) {
        w += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
      }
    }
    return w;
  };
  // Each aligned line pair spans both columns plus the 1-cell split gap.
  const pairs = oldCol.children.map((cell, i) =>
    cellWidth(cell) + 1 + cellWidth(newCol.children[i]!)
  );
  const widest = Math.max(...pairs);
  // A 40-cell viewport comfortably holds every aligned pair — nothing would
  // overflow the clip region's right edge. The widest pair is the CJK
  // context line: 17 + 1 + 17 = 35 cells.
  if (widest > 40) {
    throw new Error(`widest aligned pair = ${widest} cells (viewport 40)`);
  }
  if (widest !== 35) {
    throw new Error(`widest aligned pair = ${widest}, want 35`);
  }
});

Deno.test("Select composes a filter row and option rows (highlighted first)", () => {
  const select = Select({ options: selectOptions });
  if (select.type !== "select") throw new Error(`type = ${select.type}`);
  if (select.props.multi !== false) {
    throw new Error(`multi = ${select.props.multi}`);
  }
  if (select.props.value !== "") {
    throw new Error(`value = ${select.props.value}`);
  }
  if (select.props.highlighted !== 0) {
    throw new Error(`highlighted = ${select.props.highlighted}`);
  }
  if ("options" in select.props) {
    throw new Error("options must not reach the scene props");
  }
  // Filter row + 3 option rows (no summary in single mode).
  if (select.children.length !== 4) {
    throw new Error(`children = ${select.children.length}`);
  }
  const filterRow = select.children[0];
  if (filterRow === undefined || filterRow.type !== "text") {
    throw new Error("filter row must be a text leaf");
  }
  if (filterRow.props.text !== SELECT_FILTER_PLACEHOLDER) {
    throw new Error(`filter = ${filterRow.props.text}`);
  }
  if (filterRow.props.dim !== true) {
    throw new Error(`filter dim = ${filterRow.props.dim}`);
  }
  const labels = select.children.slice(1).map((child) => child.props.text).join(
    ",",
  );
  if (labels !== "Apple,Banana,Cherry") throw new Error(`rows = ${labels}`);
  // The first option starts highlighted (reversed).
  if (select.children[1]?.props.reversed !== true) {
    throw new Error("first option must be highlighted");
  }
  if (select.children[2]?.props.reversed === true) {
    throw new Error("only the highlighted option may be reversed");
  }
});

Deno.test("Select multi mode shows checkmarks and a selected-count summary", () => {
  const select = Select({
    options: [
      { value: "a", label: "A", selected: true },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
    multi: true,
  });
  // Filter + 3 option rows + summary.
  if (select.children.length !== 5) {
    throw new Error(`children = ${select.children.length}`);
  }
  const rows = select.children.slice(1, 4).map((child) => child.props.text);
  if (rows[0] !== "✓ A") throw new Error(`row 0 = ${rows[0]}`);
  if (rows[1] !== "  B") throw new Error(`row 1 = ${rows[1]}`);
  const summary = select.children[4];
  if (summary === undefined || summary.props.text !== "1 selected") {
    throw new Error(`summary = ${summary?.props.text}`);
  }
  // The initial selection comes from the `selected`-flagged options.
  if (JSON.stringify(select.props.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(select.props.value)}`);
  }
});

Deno.test("selectKey moves the highlight with up/down and clamps at the ends", () => {
  const select = Select({ options: selectOptions });
  const down = selectKey(select, { name: "down", ...keyBase });
  if (down.highlighted !== 1) throw new Error(`down = ${down.highlighted}`);
  const up = selectKey(select, { name: "up", ...keyBase });
  if (up.highlighted !== 0) throw new Error(`up = ${up.highlighted}`);
  // Clamp at the top.
  const upClamped = selectKey(Select({ options: selectOptions }), {
    name: "up",
    ...keyBase,
  });
  if (upClamped.highlighted !== 0) {
    throw new Error(`up clamp = ${upClamped.highlighted}`);
  }
  // Clamp at the bottom.
  selectKey(select, { name: "down", ...keyBase });
  selectKey(select, { name: "down", ...keyBase });
  const bottom = selectKey(select, { name: "down", ...keyBase });
  if (bottom.highlighted !== 2) {
    throw new Error(`down clamp = ${bottom.highlighted}`);
  }
  // The composition reflects the moved highlight.
  if (select.children[3]?.props.reversed !== true) {
    throw new Error("highlighted row must be reversed");
  }
  // Unknown keys leave the state unchanged.
  const tab = selectKey(select, { name: "tab", ...keyBase });
  if (tab.highlighted !== 2) {
    throw new Error(`tab must not move = ${tab.highlighted}`);
  }
});

Deno.test("selectKey typeahead filter narrows the visible options", () => {
  const select = Select({ options: selectOptions });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const visibleText = () => select.children[1]?.props.text;
  const childCount = () => select.children.length;
  const b = selectKey(select, { name: "char", char: "b", ...keyBase });
  if (b.filter !== "b") throw new Error(`filter = ${b.filter}`);
  if (b.highlighted !== 0) {
    throw new Error(`highlight resets to first match = ${b.highlighted}`);
  }
  // The composition narrows to the prefix matches (filter row + 1 row).
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
  if (visibleText() !== "Banana") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // Case-insensitive prefix match.
  selectKey(select, { name: "backspace", ...keyBase });
  const cap = selectKey(select, { name: "char", char: "C", ...keyBase });
  if (cap.filter !== "C") throw new Error(`filter = ${cap.filter}`);
  if (visibleText() !== "Cherry") {
    throw new Error(`visible = ${visibleText()}`);
  }
  // A non-matching char empties the list down to the filter row.
  const z = selectKey(select, { name: "char", char: "z", ...keyBase });
  if (z.filter !== "Cz") throw new Error(`filter = ${z.filter}`);
  if (childCount() !== 1) throw new Error(`children = ${childCount()}`);
  // Backspace restores the full list.
  const back = selectKey(select, { name: "backspace", ...keyBase });
  if (back.filter !== "C") throw new Error(`filter = ${back.filter}`);
  if (childCount() !== 2) throw new Error(`children = ${childCount()}`);
});

Deno.test("visibleOptions reflects the filter and is label-normalized", () => {
  const select = Select({ options: selectOptions });
  const all = visibleOptions(select);
  if (all.length !== 3) throw new Error(`all = ${all.length}`);
  if (all[0]?.label !== "Apple") throw new Error(`label = ${all[0]?.label}`);
  selectKey(select, { name: "char", char: "b", ...keyBase });
  const visible = visibleOptions(select);
  if (
    visible.length !== 1 || visible[0]?.value !== "banana" ||
    visible[0]?.label !== "Banana"
  ) {
    throw new Error(`visible = ${JSON.stringify(visible)}`);
  }
});

Deno.test("selectKey enter confirms the highlighted option and dismisses", () => {
  const select = Select({ options: selectOptions });
  selectKey(select, { name: "down", ...keyBase });
  const next = selectKey(select, { name: "enter", ...keyBase });
  if (next.value !== "banana") throw new Error(`value = ${next.value}`);
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.value !== "banana") {
    throw new Error(`node value = ${select.props.value}`);
  }
  if (select.props.open !== false) {
    throw new Error(`node open = ${select.props.open}`);
  }
  // Enter confirms the filtered highlight too (typeahead + enter).
  const filtered = Select({ options: selectOptions });
  selectKey(filtered, { name: "char", char: "c", ...keyBase });
  const confirmed = selectKey(filtered, { name: "enter", ...keyBase });
  if (confirmed.value !== "cherry") {
    throw new Error(`filtered confirm = ${confirmed.value}`);
  }
});

Deno.test("selectKey escape dismisses the dropdown", () => {
  const select = Select({ options: selectOptions });
  const next = selectKey(select, { name: "escape", ...keyBase });
  if (next.open !== false) throw new Error(`open = ${next.open}`);
  if (select.props.open !== false) {
    throw new Error(`node open = ${select.props.open}`);
  }
  // Enter/escape on an empty list is a no-op (nothing to confirm/dismiss).
  const empty = Select({ options: [] });
  const dismissed = selectKey(empty, { name: "escape", ...keyBase });
  if (dismissed.open !== false) {
    throw new Error(`empty open = ${dismissed.open}`);
  }
});

Deno.test("selectKey space toggles a checkmark in multi mode and updates the count", () => {
  const select = Select({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    multi: true,
  });
  // Accessors: selectKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const rowText = () => select.children[1]?.props.text;
  const summaryText = () => select.children[3]?.props.text;
  // Space on the highlighted (first) option checks it.
  const toggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(toggled.value) !== JSON.stringify(["a"])) {
    throw new Error(`value = ${JSON.stringify(toggled.value)}`);
  }
  if (rowText() !== "✓ A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "1 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
  // Space again unchecks it.
  const untoggled = selectKey(select, { name: "char", char: " ", ...keyBase });
  if (JSON.stringify(untoggled.value) !== JSON.stringify([])) {
    throw new Error(`value = ${JSON.stringify(untoggled.value)}`);
  }
  if (rowText() !== "  A") {
    throw new Error(`row = ${rowText()}`);
  }
  if (summaryText() !== "0 selected") {
    throw new Error(`summary = ${summaryText()}`);
  }
});

Deno.test("Select floating mode sets a z_index prop", () => {
  // Floating defaults the overlay to z-index 0.
  const floating = Select({ options: selectOptions, floating: true });
  if (floating.props.z_index !== 0) {
    throw new Error(`z_index = ${floating.props.z_index}`);
  }
  if ("floating" in floating.props) {
    throw new Error("floating must not reach the scene props");
  }
  // An explicit z_index is honored.
  const layered = Select({
    options: selectOptions,
    floating: true,
    z_index: 5,
  });
  if (layered.props.z_index !== 5) {
    throw new Error(`z_index = ${layered.props.z_index}`);
  }
  // Docked selects carry no z_index prop at all.
  const docked = Select({ options: selectOptions });
  if (docked.props.z_index !== undefined) {
    throw new Error(`docked z_index = ${docked.props.z_index}`);
  }
});

Deno.test("Table composes a sticky header row above a content region of per-column rows", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  if (table.type !== "table") throw new Error(`type = ${table.type}`);
  if (table.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${table.props.flex_direction}`);
  }
  if (table.props.highlight !== 0) {
    throw new Error(`highlight = ${table.props.highlight}`);
  }
  if (table.props.sticky_header !== true) {
    throw new Error(`sticky_header = ${table.props.sticky_header}`);
  }
  // The model is JS bookkeeping, never scene props.
  if ("columns" in table.props || "rows" in table.props) {
    throw new Error("columns/rows must not reach the scene props");
  }
  // Sticky structure: header row (child 0) + content region (child 1).
  if (table.children.length !== 2) {
    throw new Error(`children = ${table.children.length}`);
  }
  const header = table.children[0];
  if (
    header === undefined || header.type !== "box" ||
    header.props.flex_direction !== "row"
  ) {
    throw new Error("header must be a row box");
  }
  if (header.props.z_index !== 1) {
    throw new Error(`header z_index = ${header.props.z_index}`);
  }
  if (header.children.length !== tableColumns.length) {
    throw new Error(`header cells = ${header.children.length}`);
  }
  const region = table.children[1];
  if (
    region === undefined || region.type !== "box" ||
    region.props.flex_direction !== "column"
  ) {
    throw new Error("content region must be a column box");
  }
  if (region.children.length !== tableRows.length) {
    throw new Error(`rows = ${region.children.length}`);
  }
  for (let i = 0; i < region.children.length; i++) {
    const row = region.children[i];
    if (
      row === undefined || row.type !== "box" ||
      row.props.flex_direction !== "row"
    ) {
      throw new Error(`row ${i} must be a row box`);
    }
    if (row.children.length !== tableColumns.length) {
      throw new Error(`row ${i} cells = ${row.children.length}`);
    }
  }
});

Deno.test("Table cells align per column (left/right/center) and truncate wide content", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  const row0 = table.children[1]?.children[0];
  // Name: left-aligned to width 10 (padded with trailing spaces).
  if (row0?.children[0]?.props.text !== "Ada".padEnd(10)) {
    throw new Error(
      `name cell = ${JSON.stringify(row0?.children[0]?.props.text)}`,
    );
  }
  // Score: right-aligned to width 5 (padded with leading spaces).
  if (row0?.children[2]?.props.text !== "92".padStart(5)) {
    throw new Error(
      `score cell = ${JSON.stringify(row0?.children[2]?.props.text)}`,
    );
  }
  // Each cell pins its column width so every column lines up.
  if (
    row0?.children[0]?.props.width !== 10 ||
    row0?.children[2]?.props.width !== 5
  ) {
    throw new Error(
      `cell widths = ${
        JSON.stringify(row0?.children.map((c) => c.props.width))
      }`,
    );
  }
  // Center alignment splits the padding evenly.
  const centered = Table({
    columns: [{ key: "c", header: "C", width: 7, align: "center" }],
    rows: [["x"]],
  });
  if (
    centered.children[1]?.children[0]?.children[0]?.props.text !== "   x   "
  ) {
    throw new Error(
      `center cell = ${
        JSON.stringify(
          centered.children[1]?.children[0]?.children[0]?.props.text,
        )
      }`,
    );
  }
  // Content wider than the column is truncated to the width, never mid-glyph
  // ("宽度对齐测试" is 6 wide chars -> display width 12 -> 4 kept = 2 chars).
  const wide = Table({
    columns: [{ key: "n", header: "N", width: 4 }],
    rows: [["宽度对齐测试"]],
  });
  if (wide.children[1]?.children[0]?.children[0]?.props.text !== "宽度") {
    throw new Error(
      `truncated cell = ${
        JSON.stringify(wide.children[1]?.children[0]?.children[0]?.props.text)
      }`,
    );
  }
});

Deno.test("Table routes scroll_x to the root and scroll_y/clip_height to the content region", () => {
  const table = Table({
    columns: tableColumns,
    rows: tableRows,
    scroll_x: 4,
    scroll_y: 3,
    clip_height: 5,
  });
  // scroll_x pans header + rows together, so it stays on the root.
  if (table.props.scroll_x !== 4) {
    throw new Error(`scroll_x = ${table.props.scroll_x}`);
  }
  // scroll_y is the content region's state — the root never carries it (it
  // would pan the sticky header with the rows).
  if ("scroll_y" in table.props) {
    throw new Error("scroll_y must not reach the root props");
  }
  const region = table.children[1];
  if (region?.props.scroll_y !== 3) {
    throw new Error(`region scroll_y = ${region?.props.scroll_y}`);
  }
  if (region?.props.clip_height !== 5) {
    throw new Error(`region clip_height = ${region?.props.clip_height}`);
  }
});

Deno.test("visibleTableRows returns the viewport window under scroll and clip_height", () => {
  const table = Table({
    columns: tableColumns,
    rows: tableRows,
    scroll_y: 2,
    clip_height: 3,
  });
  const visible = visibleTableRows(table);
  if (visible.length !== 3) throw new Error(`visible = ${visible.length}`);
  if (visible[0]?.[0] !== "Linus" || visible[2]?.[0] !== "Margaret") {
    throw new Error(`visible = ${JSON.stringify(visible.map((r) => r[0]))}`);
  }
  // Without clip_height the whole remaining list is the window.
  const all = Table({ columns: tableColumns, rows: tableRows });
  if (visibleTableRows(all).length !== tableRows.length) {
    throw new Error(`window = ${visibleTableRows(all).length}`);
  }
});

Deno.test("tableKey moves the highlight with up/down and clamps at the ends", () => {
  const table = Table({ columns: tableColumns, rows: tableRows });
  const down = tableKey(table, { name: "down", ...tableKeyBase });
  if (down.highlight !== 1) throw new Error(`down = ${down.highlight}`);
  const up = tableKey(table, { name: "up", ...tableKeyBase });
  if (up.highlight !== 0) throw new Error(`up = ${up.highlight}`);
  // Clamp at the top.
  const upClamped = tableKey(
    Table({ columns: tableColumns, rows: tableRows }),
    { name: "up", ...tableKeyBase },
  );
  if (upClamped.highlight !== 0) {
    throw new Error(`up clamp = ${upClamped.highlight}`);
  }
  // Clamp at the bottom (a few extra downs past the last row).
  const bottom = Table({ columns: tableColumns, rows: tableRows });
  for (let i = 0; i < tableRows.length + 2; i++) {
    tableKey(bottom, { name: "down", ...tableKeyBase });
  }
  const clamped = tableKey(bottom, { name: "down", ...tableKeyBase });
  if (clamped.highlight !== tableRows.length - 1) {
    throw new Error(`down clamp = ${clamped.highlight}`);
  }
  // The composition reflects the moved highlight: the highlighted row's
  // cells are reversed, and only its.
  const moved = Table({ columns: tableColumns, rows: tableRows });
  tableKey(moved, { name: "down", ...tableKeyBase });
  tableKey(moved, { name: "down", ...tableKeyBase });
  const row2 = moved.children[1]?.children[2];
  if (row2?.children.every((cell) => cell.props.reversed === true) !== true) {
    throw new Error("the highlighted row must be reversed");
  }
  if (
    moved.children[1]?.children[0]?.children.some((cell) =>
      cell.props.reversed === true
    )
  ) {
    throw new Error("only the highlighted row may be reversed");
  }
  // Unknown keys leave the state unchanged.
  const tab = tableKey(moved, { name: "tab", ...tableKeyBase });
  if (tab.highlight !== 2) {
    throw new Error(`tab must not move = ${tab.highlight}`);
  }
});
