//! Tests: tableKey auto-scrolls to keep the highlight visible and clam.

import { state, withFakeAddon } from "./testkit.ts";
import { tabsFixture } from "./testkit.ts";
import { keyBase, mouse, tableColumns, tableKeyBase, tableRows } from "./testkit.ts";
import { CHECKBOX_CHECKED_GLYPH, CHECKBOX_UNCHECKED_GLYPH, CHECK_PRIMARY_BG, CHECK_PRIMARY_FG, Checkbox, RADIO_SELECTED_GLYPH, RADIO_UNSELECTED_GLYPH, Radio, TAB_ACTIVE_MARKER, TAB_CLOSE_CHAR, TAB_PRIMARY_BG, TAB_PRIMARY_FG, TOGGLE_OFF_GLYPH, TOGGLE_ON_GLYPH, Table, TableState, Tabs, Text, Toggle, activateTab, checkboxKey, closeTab, createRenderer, name, scrollTo, tableKey, tabsKey, visibleTableRows, wheelScroll } from "./index.ts";


Deno.test("tableKey auto-scrolls to keep the highlight visible and clamps scroll_y", () => {
  const table = Table({
    columns: tableColumns,
    rows: tableRows,
    clip_height: 3,
  });
  // Down from 0: highlights 1, 2 fit the window [0, 2]; highlight 3 scrolls.
  tableKey(table, { name: "down", ...tableKeyBase });
  tableKey(table, { name: "down", ...tableKeyBase });
  const scrolled = tableKey(table, { name: "down", ...tableKeyBase });
  if (scrolled.highlight !== 3 || scrolled.scroll_y !== 1) {
    throw new Error(`scrolled = ${JSON.stringify(scrolled)}`);
  }
  // The scroll offset lands on the content region's props.
  if (table.children[1]?.props.scroll_y !== 1) {
    throw new Error(`region scroll_y = ${table.children[1]?.props.scroll_y}`);
  }
  // Down to the last row: scroll_y clamps at rows.length - clip_height.
  let last = scrolled;
  for (let i = 0; i < 10; i++) {
    last = tableKey(table, { name: "down", ...tableKeyBase });
  }
  if (last.highlight !== tableRows.length - 1) {
    throw new Error(`highlight = ${last.highlight}`);
  }
  if (last.scroll_y !== tableRows.length - 3) {
    throw new Error(`scroll_y clamp = ${last.scroll_y}`);
  }
  // Up back toward the top: scroll_y clamps at 0.
  let up = last;
  for (let i = 0; i < 10; i++) {
    up = tableKey(table, { name: "up", ...tableKeyBase });
  }
  if (up.highlight !== 0 || up.scroll_y !== 0) {
    throw new Error(`up back to top = ${JSON.stringify(up)}`);
  }
});

Deno.test("sticky_header: false moves the header into the scrollable content region", () => {
  const table = Table({
    columns: tableColumns,
    rows: tableRows,
    sticky_header: false,
  });
  if (table.props.sticky_header !== false) {
    throw new Error(`sticky_header = ${table.props.sticky_header}`);
  }
  // Single child: the content region, whose first child is the header row
  // (it scrolls away with the rows, so no sticky z_index).
  if (table.children.length !== 1) {
    throw new Error(`children = ${table.children.length}`);
  }
  const region = table.children[0];
  if (
    region === undefined || region.type !== "box" ||
    region.props.flex_direction !== "column"
  ) {
    throw new Error("content region must be a column box");
  }
  const header = region.children[0];
  if (
    header === undefined || header.props.flex_direction !== "row" ||
    header.children.length !== tableColumns.length
  ) {
    throw new Error("the header must be the region's first child");
  }
  if (header.props.z_index !== undefined) {
    throw new Error(`header z_index = ${header.props.z_index}`);
  }
  if (region.children.length !== tableRows.length + 1) {
    throw new Error(`region children = ${region.children.length}`);
  }
});

Deno.test("a 10k-row table materializes a bounded row window and still clamps and highlights", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 10000; i++) rows.push([`row-${i}`, i]);
    const table = Table({
      columns: [
        { key: "name", header: "Name", width: 10 },
        { key: "n", header: "N", width: 4, align: "right" },
      ],
      rows,
      clip_height: 12,
    });

    // The window is bounded near the clip height — not one node per row.
    let region = table.children[1]!;
    if (region.children.length !== 12) {
      throw new Error(`window = ${region.children.length}`);
    }
    if (region.props.scroll_y !== 0) {
      throw new Error(`region scroll_y = ${region.props.scroll_y}`);
    }

    // visibleTableRows reports the full dataset window at the offset.
    let visible = visibleTableRows(table);
    if (visible.length !== 12) throw new Error(`visible = ${visible.length}`);
    if (visible[0]?.[0] !== "row-0" || visible[11]?.[0] !== "row-11") {
      throw new Error(
        `visible = ${JSON.stringify(visible.map((r) => r[0]).slice(0, 3))}`,
      );
    }

    // tableKey navigates the dataset: the highlight moves and the window
    // follows (auto-scroll), never materializing beyond the clip height.
    let state: TableState = { highlight: 0, scroll_x: 0, scroll_y: 0 };
    for (let i = 0; i < 30; i++) {
      state = tableKey(table, { name: "down", ...tableKeyBase });
    }
    if (state.highlight !== 30 || state.scroll_y !== 30 - 12 + 1) {
      throw new Error(`mid-nav = ${JSON.stringify(state)}`);
    }
    const midWindow = visibleTableRows(table);
    if (midWindow[0]?.[0] !== "row-19") {
      throw new Error(`mid window = ${midWindow[0]?.[0]}`);
    }
    // All the way down: the highlight clamps at the dataset end and the
    // scroll clamps against the full virtual height (10000 - 12).
    for (let i = 0; i < 10000 - 30 + 2; i++) {
      state = tableKey(table, { name: "down", ...tableKeyBase });
    }
    if (state.highlight !== 9999) {
      throw new Error(`highlight = ${state.highlight}`);
    }
    if (state.scroll_y !== 10000 - 12) {
      throw new Error(`scroll_y clamp = ${state.scroll_y}`);
    }
    region = table.children[1]!;
    if (region.children.length !== 12) {
      throw new Error(`bottom window = ${region.children.length}`);
    }
    visible = visibleTableRows(table);
    if (
      visible.length !== 12 || visible[0]?.[0] !== "row-9988" ||
      visible[11]?.[0] !== "row-9999"
    ) {
      throw new Error(
        `tail = ${JSON.stringify(visible.map((r) => r[0]).slice(0, 3))}`,
      );
    }
    // The highlighted row — the last materialized row — is reversed, and
    // only it.
    if (
      region.children[11]?.children.every((cell) =>
        cell.props.reversed === true
      ) !== true
    ) {
      throw new Error("the last windowed row must be the reversed highlight");
    }
    if (
      region.children[0]?.children.some((cell) => cell.props.reversed === true)
    ) {
      throw new Error("only the highlighted row may be reversed");
    }

    // Attach for the scene-geometry paths (scrollTo / wheelScroll).
    renderer.root.addChild(table);

    // The scroll clamp measures the JS-known full height even though the
    // scene content is only the window: a scroll far past the dataset end
    // pins at rows.length - clip_height.
    scrollTo(table.children[1]!, 0, 1e9);
    const y = (): number => table.children[1]!.props.scroll_y as number;
    if (y() !== 10000 - 12) throw new Error(`scrollTo clamp = ${y()}`);

    // wheelScroll refreshes the window and clamps against the full height: at
    // the bottom a down-wheel is consumed but pinned; an up-wheel pans back
    // into the dataset and re-windows.
    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel at the table's bound must stay consumed");
    }
    if (y() !== 9988) throw new Error(`wheel clamp = ${y()}`);
    if (wheelScroll(table, mouse("scroll_up", 0, 0)) !== true) {
      throw new Error("a wheel up on the table must be consumed");
    }
    if (y() !== 9987) throw new Error(`wheel up = ${y()}`);
    visible = visibleTableRows(table);
    if (visible[0]?.[0] !== "row-9987") {
      throw new Error(`window after wheel = ${visible[0]?.[0]}`);
    }
    if (table.props.scroll_y !== undefined) {
      throw new Error(
        "the table root must not scroll (the sticky header stays pinned)",
      );
    }
  });
});

Deno.test("Tabs composes a tab bar row and a content region holding the active tab's content", () => {
  const { tabs } = tabsFixture();
  if (tabs.type !== "tabs") throw new Error(`type = ${tabs.type}`);
  if (tabs.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${tabs.props.flex_direction}`);
  }
  if (tabs.props.active !== 0) throw new Error(`active = ${tabs.props.active}`);
  // The tab list is JS bookkeeping, never scene props.
  if ("tabs" in tabs.props || "closable" in tabs.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(tabs.props)}`);
  }
  // Composition: the tab bar row (child 0) + the content region (child 1).
  if (tabs.children.length !== 2) {
    throw new Error(`children = ${tabs.children.length}`);
  }
  const bar = tabs.children[0];
  if (
    bar === undefined || bar.type !== "box" ||
    bar.props.flex_direction !== "row"
  ) {
    throw new Error("the tab bar must be a row box");
  }
  if (bar.children.length !== 3) {
    throw new Error(`tab leaves = ${bar.children.length}`);
  }
  if (
    bar.children.map((leaf) => leaf.props.text).join(",") !==
      `${TAB_ACTIVE_MARKER}logs,files,git`
  ) {
    throw new Error(
      `labels = ${bar.children.map((leaf) => leaf.props.text).join(",")}`,
    );
  }
  const region = tabs.children[1];
  if (
    region === undefined || region.type !== "box" ||
    region.props.flex_direction !== "column"
  ) {
    throw new Error("the content region must be a column box");
  }
  // Only the active tab's content is materialized in the region.
  if (
    region.children.length !== 1 ||
    region.children[0]?.props.text !== "log line"
  ) {
    throw new Error(
      `region content = ${region.children.map((n) => n.props.text).join(",")}`,
    );
  }
  // The other tabs' content stays out of the scene tree (only the active
  // tab's content is composed).
  if (bar.children.some((leaf) => leaf.children.length !== 0)) {
    throw new Error("tab leaves must be text leaves without children");
  }
});

Deno.test("Tabs styles the active tab with the primary palette, reversed, and a top-border marker", () => {
  const { tabs } = tabsFixture();
  const bar = tabs.children[0]!;
  const activeLeaf = bar.children[0]!;
  const inactiveLeaf = bar.children[1]!;
  // The active tab's label is prefixed by the top-border marker.
  if (activeLeaf.props.text !== `${TAB_ACTIVE_MARKER}logs`) {
    throw new Error(`active text = ${JSON.stringify(activeLeaf.props.text)}`);
  }
  // The active tab carries the primary palette colors + reversed; inactive
  // tabs are plain.
  if (activeLeaf.props.reversed !== true) {
    throw new Error("the active tab must be reversed");
  }
  if (
    activeLeaf.props.fg !== TAB_PRIMARY_FG ||
    activeLeaf.props.bg !== TAB_PRIMARY_BG
  ) {
    throw new Error(`active colors = ${JSON.stringify(activeLeaf.props)}`);
  }
  if (inactiveLeaf.props.reversed !== undefined) {
    throw new Error("inactive tabs must not be reversed");
  }
  if (inactiveLeaf.props.fg !== undefined) {
    throw new Error("inactive tabs must not carry the primary fg");
  }
  if (inactiveLeaf.props.text !== "files") {
    throw new Error(`inactive text = ${inactiveLeaf.props.text}`);
  }
});

Deno.test("Tabs close affordance appends the close glyph per tab (per-tab closable wins)", () => {
  const closable = Tabs({
    tabs: [
      { label: "a", content: [] },
      { label: "b", content: [] },
    ],
    closable: true,
  });
  const bar = closable.children[0]!;
  if (
    bar.children[0]?.props.text !== `${TAB_ACTIVE_MARKER}a ${TAB_CLOSE_CHAR}`
  ) {
    throw new Error(
      `active closable = ${JSON.stringify(bar.children[0]?.props.text)}`,
    );
  }
  if (bar.children[1]?.props.text !== `b ${TAB_CLOSE_CHAR}`) {
    throw new Error(
      `inactive closable = ${JSON.stringify(bar.children[1]?.props.text)}`,
    );
  }
  // A per-tab `closable: false` overrides the element default.
  const mixed = Tabs({
    tabs: [
      { label: "a", content: [], closable: false },
      { label: "b", content: [] },
    ],
    closable: true,
  });
  const mixedBar = mixed.children[0]!;
  if (mixedBar.children[0]?.props.text !== `${TAB_ACTIVE_MARKER}a`) {
    throw new Error(
      `per-tab closable: false = ${
        JSON.stringify(mixedBar.children[0]?.props.text)
      }`,
    );
  }
  if (mixedBar.children[1]?.props.text !== `b ${TAB_CLOSE_CHAR}`) {
    throw new Error(
      `default closable = ${JSON.stringify(mixedBar.children[1]?.props.text)}`,
    );
  }
});

Deno.test("activateTab switches the active tab and swaps the content region", () => {
  const { tabs, activeOf } = tabsFixture();
  activateTab(tabs, 1);
  if (activeOf() !== 1) throw new Error(`active = ${activeOf()}`);
  // Re-read the live composition: the rebuild replaced the bar and region.
  const bar = tabs.children[0]!;
  if (bar.children[1]?.props.text !== `${TAB_ACTIVE_MARKER}files`) {
    throw new Error(
      `active leaf = ${JSON.stringify(bar.children[1]?.props.text)}`,
    );
  }
  if (bar.children[0]?.props.text !== "logs") {
    throw new Error(`old active leaf = ${bar.children[0]?.props.text}`);
  }
  const region = tabs.children[1]!;
  if (
    region.children.length !== 1 ||
    region.children[0]?.props.text !== "file list"
  ) {
    throw new Error(
      `region content = ${region.children.map((n) => n.props.text).join(",")}`,
    );
  }
  // Activating the same tab is a no-op (the composition is not rebuilt).
  const before = tabs.children[0]!;
  activateTab(tabs, 1);
  if (tabs.children[0] !== before) {
    throw new Error("a no-op activate must not rebuild");
  }
  // Out-of-range indices clamp: 99 -> last, -1 -> first.
  activateTab(tabs, 99);
  if (activeOf() !== 2) throw new Error(`clamp high = ${activeOf()}`);
  activateTab(tabs, -1);
  if (activeOf() !== 0) throw new Error(`clamp low = ${activeOf()}`);
});

Deno.test("closeTab removes the tab and re-clamps the active index", () => {
  // Closing a tab before the active one shifts the active down.
  const shift = Tabs({ tabs: tabsFixture().specs, active: 2 });
  closeTab(shift, 0);
  if (shift.props.active !== 1) {
    throw new Error(`shift = ${shift.props.active}`);
  }
  if (
    shift.children[0]?.children.map((leaf) => leaf.props.text).join(",") !==
      `files,${TAB_ACTIVE_MARKER}git`
  ) {
    throw new Error(
      `labels after close = ${
        shift.children[0]?.children.map((leaf) => leaf.props.text).join(",")
      }`,
    );
  }
  // Closing the active tab leaves the tab that slid into its slot.
  const active = Tabs({ tabs: tabsFixture().specs, active: 1 });
  closeTab(active, 1);
  if (active.props.active !== 1) {
    throw new Error(`active after self-close = ${active.props.active}`);
  }
  if (
    active.children[0]?.children.map((leaf) => leaf.props.text).join(",") !==
      `logs,${TAB_ACTIVE_MARKER}git`
  ) {
    throw new Error(
      `labels = ${
        active.children[0]?.children.map((leaf) => leaf.props.text).join(",")
      }`,
    );
  }
  // Closing the last (active) tab clamps the active to the new last.
  const last = Tabs({ tabs: tabsFixture().specs, active: 2 });
  closeTab(last, 2);
  if (last.props.active !== 1) {
    throw new Error(`clamped active = ${last.props.active}`);
  }
  // Closing the only tab leaves an empty bar + region at active 0.
  const only = Tabs({
    tabs: [{ label: "solo", content: [Text({ text: "x" })] }],
  });
  closeTab(only, 0);
  if (only.props.active !== 0) {
    throw new Error(`empty active = ${only.props.active}`);
  }
  if (only.children[0]?.children.length !== 0) {
    throw new Error(`empty bar = ${only.children[0]?.children.length}`);
  }
  if (only.children[1]?.children.length !== 0) {
    throw new Error(`empty region = ${only.children[1]?.children.length}`);
  }
  // Bad indices are no-ops.
  const noop = Tabs({ tabs: tabsFixture().specs });
  closeTab(noop, 5);
  if (noop.children[0]?.children.length !== 3) {
    throw new Error("a bad index must not close");
  }
});

Deno.test("tabsKey left/right move the active tab and clamp at the ends", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  const { tabs, activeOf } = tabsFixture();
  const right = tabsKey(tabs, { name: "right", ...base });
  if (right.active !== 1 || right.count !== 3) {
    throw new Error(`right = ${JSON.stringify(right)}`);
  }
  if (activeOf() !== 1) throw new Error(`node active = ${activeOf()}`);
  // Right at the last tab clamps.
  const atEnd = tabsKey(tabs, { name: "right", ...base });
  const clamped = tabsKey(tabs, { name: "right", ...base });
  if (atEnd.active !== 2 || clamped.active !== 2) {
    throw new Error(`right clamp = ${clamped.active}`);
  }
  // Left walks back and clamps at the first.
  const left = tabsKey(tabs, { name: "left", ...base });
  if (left.active !== 1) throw new Error(`left = ${left.active}`);
  const top = tabsKey(tabs, { name: "left", ...base });
  if (top.active !== 0) throw new Error(`left = ${top.active}`);
  const clampedLow = tabsKey(tabs, { name: "left", ...base });
  if (clampedLow.active !== 0) {
    throw new Error(`left clamp = ${clampedLow.active}`);
  }
  if (activeOf() !== 0) throw new Error(`node active = ${activeOf()}`);
});

Deno.test("tabsKey ctrl+tab / ctrl+shift+tab wrap to the next / previous tab", () => {
  const base = { alt: false } as const;
  const { tabs, activeOf } = tabsFixture();
  // ctrl+shift+tab at the first tab wraps to the last.
  const prevWrap = tabsKey(tabs, {
    name: "tab",
    ctrl: true,
    shift: true,
    ...base,
  });
  if (prevWrap.active !== 2) {
    throw new Error(`ctrl+shift+tab wrap = ${prevWrap.active}`);
  }
  if (activeOf() !== 2) throw new Error(`node active = ${activeOf()}`);
  // ctrl+tab at the last tab wraps to the first.
  const nextWrap = tabsKey(tabs, {
    name: "tab",
    ctrl: true,
    shift: false,
    ...base,
  });
  if (nextWrap.active !== 0) {
    throw new Error(`ctrl+tab wrap = ${nextWrap.active}`);
  }
  // Plain tab (no ctrl) leaves the tabs unchanged.
  const plainTab = tabsKey(tabs, {
    name: "tab",
    ctrl: false,
    shift: false,
    ...base,
  });
  if (plainTab.active !== 0) throw new Error(`plain tab = ${plainTab.active}`);
});

Deno.test("tabsKey ctrl+w closes the active tab and re-clamps the active index", () => {
  const base = { alt: false, shift: false } as const;
  const { tabs, specs, activeOf } = tabsFixture();
  // Move to the middle tab, then close it with ctrl+w.
  tabsKey(tabs, { name: "right", ctrl: false, ...base });
  const closed = tabsKey(tabs, { name: "w", ctrl: true, ...base });
  if (closed.count !== 2) throw new Error(`count = ${closed.count}`);
  if (activeOf() !== 1) throw new Error(`active after close = ${activeOf()}`);
  if (
    tabs.children[0]?.children.map((leaf) => leaf.props.text).join(",") !==
      `logs,${TAB_ACTIVE_MARKER}git`
  ) {
    throw new Error(
      `labels = ${
        tabs.children[0]?.children.map((leaf) => leaf.props.text).join(",")
      }`,
    );
  }
  // ctrl+w on the last tab closes it; the active clamps to the new last.
  void specs;
  const last = Tabs({ tabs: tabsFixture().specs, active: 2 });
  const closedLast = tabsKey(last, { name: "w", ctrl: true, ...base });
  if (closedLast.count !== 2 || closedLast.active !== 1) {
    throw new Error(`last close = ${JSON.stringify(closedLast)}`);
  }
  // Unknown keys leave the tabs unchanged.
  const untouched = tabsKey(tabs, {
    name: "char",
    char: "q",
    ctrl: false,
    ...base,
  });
  if (untouched.active !== 1 || untouched.count !== 2) {
    throw new Error(`unknown key = ${JSON.stringify(untouched)}`);
  }
});

Deno.test("Checkbox composes the checked glyph and label; the label never reaches the scene props", () => {
  const checkbox = Checkbox({ label: "Dark mode", checked: true });
  if (checkbox.type !== "checkbox") throw new Error(`type = ${checkbox.type}`);
  if (checkbox.props.checked !== true) {
    throw new Error(`checked = ${checkbox.props.checked}`);
  }
  if ("label" in checkbox.props) {
    throw new Error("label must not reach the scene props");
  }
  if ("checked" in checkbox.props !== true) {
    throw new Error("checked must live on the root props");
  }
  // Composition: one text leaf holding the checked glyph + the label.
  if (checkbox.children.length !== 1) {
    throw new Error(`children = ${checkbox.children.length}`);
  }
  const leaf = checkbox.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("the checkbox must compose a text leaf");
  }
  if (leaf.props.text !== `${CHECKBOX_CHECKED_GLYPH} Dark mode`) {
    throw new Error(`text = ${JSON.stringify(leaf.props.text)}`);
  }
  // The unchecked variant renders the unchecked glyph.
  const unchecked = Checkbox({ label: "Dark mode" });
  if (unchecked.props.checked !== false) {
    throw new Error(`default checked = ${unchecked.props.checked}`);
  }
  if (
    unchecked.children[0]?.props.text !==
      `${CHECKBOX_UNCHECKED_GLYPH} Dark mode`
  ) {
    throw new Error(
      `unchecked text = ${JSON.stringify(unchecked.children[0]?.props.text)}`,
    );
  }
});

Deno.test("Toggle composes the on/off glyph and label; the label never reaches the scene props", () => {
  const toggle = Toggle({ label: "Notifications", on: true });
  if (toggle.type !== "toggle") throw new Error(`type = ${toggle.type}`);
  if (toggle.props.on !== true) throw new Error(`on = ${toggle.props.on}`);
  if ("label" in toggle.props) {
    throw new Error("label must not reach the scene props");
  }
  if ("on" in toggle.props !== true) {
    throw new Error("on must live on the root props");
  }
  if (toggle.children.length !== 1) {
    throw new Error(`children = ${toggle.children.length}`);
  }
  const leaf = toggle.children[0];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("the toggle must compose a text leaf");
  }
  if (leaf.props.text !== `${TOGGLE_ON_GLYPH} Notifications`) {
    throw new Error(`text = ${JSON.stringify(leaf.props.text)}`);
  }
  // The off variant renders the off glyph.
  const off = Toggle({ label: "Notifications" });
  if (off.props.on !== false) throw new Error(`default on = ${off.props.on}`);
  if (off.children[0]?.props.text !== `${TOGGLE_OFF_GLYPH} Notifications`) {
    throw new Error(
      `off text = ${JSON.stringify(off.children[0]?.props.text)}`,
    );
  }
});

Deno.test("Radio composes one row per option with a single selected index; options never reach the scene props", () => {
  const radio = Radio({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B", selected: true },
      { value: "c", label: "C" },
    ],
  });
  if (radio.type !== "radio") throw new Error(`type = ${radio.type}`);
  if (radio.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${radio.props.flex_direction}`);
  }
  // The second option is `selected`-flagged, so the initial selection is 1.
  if (radio.props.selected !== 1) {
    throw new Error(`selected = ${radio.props.selected}`);
  }
  if (radio.props.focused !== 0) {
    throw new Error(`focused = ${radio.props.focused}`);
  }
  if ("options" in radio.props) {
    throw new Error("options must not reach the scene props");
  }
  // One row per option, the selected row `(•)`-prefixed.
  if (radio.children.length !== 3) {
    throw new Error(`children = ${radio.children.length}`);
  }
  const rows = radio.children.map((child) => child.props.text);
  if (
    rows.join(",") !==
      `${RADIO_UNSELECTED_GLYPH} A,${RADIO_SELECTED_GLYPH} B,${RADIO_UNSELECTED_GLYPH} C`
  ) {
    throw new Error(`rows = ${rows.join(",")}`);
  }
});

Deno.test("Form primitives style the focused row with the primary palette and reversed", () => {
  // A focused checkbox paints its leaf with the primary colors, reversed.
  const focusedCheck = Checkbox({ label: "Dark mode", focused: true });
  const checkLeaf = focusedCheck.children[0]!;
  if (checkLeaf.props.reversed !== true) {
    throw new Error("the focused checkbox leaf must be reversed");
  }
  if (
    checkLeaf.props.fg !== CHECK_PRIMARY_FG ||
    checkLeaf.props.bg !== CHECK_PRIMARY_BG
  ) {
    throw new Error(`focused colors = ${JSON.stringify(checkLeaf.props)}`);
  }
  // An unfocused checkbox leaf carries no fg/reversed styling.
  const plainCheck = Checkbox({ label: "Dark mode" });
  const plainLeaf = plainCheck.children[0]!;
  if (plainLeaf.props.fg !== undefined) {
    throw new Error("unfocused leaves must not carry the primary fg");
  }
  if (plainLeaf.props.reversed !== undefined) {
    throw new Error("unfocused leaves must not be reversed");
  }
  // A focused radio row is styled; the others stay plain.
  const radio = Radio({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B", selected: true },
      { value: "c", label: "C" },
    ],
    focused: 1,
  });
  const focusedRow = radio.children[1]!;
  if (focusedRow.props.reversed !== true) {
    throw new Error("the focused radio row must be reversed");
  }
  if (
    focusedRow.props.fg !== CHECK_PRIMARY_FG ||
    focusedRow.props.bg !== CHECK_PRIMARY_BG
  ) {
    throw new Error(`focused row colors = ${JSON.stringify(focusedRow.props)}`);
  }
  const plainRow0 = radio.children[0]!;
  const plainRow2 = radio.children[2]!;
  if (
    plainRow0.props.reversed !== undefined ||
    plainRow2.props.reversed !== undefined
  ) {
    throw new Error("unfocused radio rows must not be reversed");
  }
  if (plainRow0.props.fg !== undefined || plainRow2.props.fg !== undefined) {
    throw new Error("unfocused radio rows must not carry the primary fg");
  }
});

Deno.test("checkboxKey space/enter toggle the checked state and rebuild the composition; unknown keys are no-ops", () => {
  const checkbox = Checkbox({ label: "Dark mode" });
  // Accessors: checkboxKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const checkedOf = () => checkbox.props.checked;
  const leafText = () => checkbox.children[0]?.props.text;
  // Space checks the box.
  const checked = checkboxKey(checkbox, {
    name: "char",
    char: " ",
    ...keyBase,
  });
  if (checked.checked !== true) throw new Error(`checked = ${checked.checked}`);
  if (checkedOf() !== true) throw new Error(`node checked = ${checkedOf()}`);
  if (leafText() !== `${CHECKBOX_CHECKED_GLYPH} Dark mode`) {
    throw new Error(`text = ${JSON.stringify(leafText())}`);
  }
  // Enter unchecks it again.
  const unchecked = checkboxKey(checkbox, { name: "enter", ...keyBase });
  if (unchecked.checked !== false) {
    throw new Error(`unchecked = ${unchecked.checked}`);
  }
  if (leafText() !== `${CHECKBOX_UNCHECKED_GLYPH} Dark mode`) {
    throw new Error(`text = ${JSON.stringify(leafText())}`);
  }
  // Unknown keys leave the state and composition unchanged.
  const untouched = checkboxKey(checkbox, { name: "tab", ...keyBase });
  if (untouched.checked !== false) {
    throw new Error(`tab must not toggle = ${untouched.checked}`);
  }
  if (checkedOf() !== false) {
    throw new Error(`node checked after tab = ${checkedOf()}`);
  }
  if (leafText() !== `${CHECKBOX_UNCHECKED_GLYPH} Dark mode`) {
    throw new Error(`composition changed = ${JSON.stringify(leafText())}`);
  }
});
