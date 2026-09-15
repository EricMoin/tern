//! Tests: toggleKey space/enter toggle the on state; unknown keys are .

import { FakeNodeHandle, flush, state, withFakeAddon } from "./testkit.ts";
import { attachToFake, menuFixture, menuRowTexts, writesOf } from "./testkit.ts";
import { keyBase, selectOptions } from "./testkit.ts";
import { Box, Checkbox, FocusManager, Input, InputProps, MENU_Z_INDEX, Menu, Modal, RADIO_SELECTED_GLYPH, Radio, Select, TOGGLE_OFF_GLYPH, TOGGLE_ON_GLYPH, Text, Textarea, Toggle, checkboxKey, closeMenu, createRenderer, menuKey, name, openMenu, radioKey, selectKey, syncSemantics, toggleKey, useFocus } from "./index.ts";


Deno.test("toggleKey space/enter toggle the on state; unknown keys are no-ops", () => {
  const toggle = Toggle({ label: "Notifications" });
  // Accessors: toggleKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const onOf = () => toggle.props.on;
  const leafText = () => toggle.children[0]?.props.text;
  // Space turns the toggle on.
  const on = toggleKey(toggle, { name: "char", char: " ", ...keyBase });
  if (on.on !== true) throw new Error(`on = ${on.on}`);
  if (onOf() !== true) throw new Error(`node on = ${onOf()}`);
  if (leafText() !== `${TOGGLE_ON_GLYPH} Notifications`) {
    throw new Error(`text = ${JSON.stringify(leafText())}`);
  }
  // Enter turns it back off.
  const off = toggleKey(toggle, { name: "enter", ...keyBase });
  if (off.on !== false) throw new Error(`off = ${off.on}`);
  if (leafText() !== `${TOGGLE_OFF_GLYPH} Notifications`) {
    throw new Error(`text = ${JSON.stringify(leafText())}`);
  }
  // Unknown keys leave the state and composition unchanged.
  const untouched = toggleKey(toggle, { name: "escape", ...keyBase });
  if (untouched.on !== false) {
    throw new Error(`escape must not toggle = ${untouched.on}`);
  }
  if (onOf() !== false) throw new Error(`node on after escape = ${onOf()}`);
  if (leafText() !== `${TOGGLE_OFF_GLYPH} Notifications`) {
    throw new Error(`composition changed = ${JSON.stringify(leafText())}`);
  }
});

Deno.test("radioKey arrows move the focus clamped at the ends and space commits the selection", () => {
  const radio = Radio({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
  });
  // Accessors: radioKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const selectedOf = () => radio.props.selected;
  const focusedOf = () => radio.props.focused;
  // down/right move the focus down.
  const down = radioKey(radio, { name: "down", ...keyBase });
  if (down.focused !== 1) throw new Error(`down = ${down.focused}`);
  const right = radioKey(radio, { name: "right", ...keyBase });
  if (right.focused !== 2) throw new Error(`right = ${right.focused}`);
  // Further down clamps at the last option.
  const clamped = radioKey(radio, { name: "down", ...keyBase });
  if (clamped.focused !== 2) throw new Error(`down clamp = ${clamped.focused}`);
  // The composition's focused row follows the focus.
  if (radio.children[2]?.props.reversed !== true) {
    throw new Error("the focused row must be reversed");
  }
  // up/left move the focus back; at the top they clamp at 0.
  const up = radioKey(radio, { name: "up", ...keyBase });
  if (up.focused !== 1) throw new Error(`up = ${up.focused}`);
  const left = radioKey(radio, { name: "left", ...keyBase });
  if (left.focused !== 0) throw new Error(`left = ${left.focused}`);
  const clampedLow = radioKey(radio, { name: "up", ...keyBase });
  if (clampedLow.focused !== 0) {
    throw new Error(`up clamp = ${clampedLow.focused}`);
  }
  const clampedLowLeft = radioKey(radio, { name: "left", ...keyBase });
  if (clampedLowLeft.focused !== 0) {
    throw new Error(`left clamp = ${clampedLowLeft.focused}`);
  }
  // Space commits the focused option as the selection.
  radioKey(radio, { name: "down", ...keyBase });
  radioKey(radio, { name: "down", ...keyBase });
  const committed = radioKey(radio, { name: "char", char: " ", ...keyBase });
  if (committed.selected !== 2) {
    throw new Error(`space commit = ${committed.selected}`);
  }
  if (selectedOf() !== 2) throw new Error(`node selected = ${selectedOf()}`);
  if (radio.children[2]?.props.text !== `${RADIO_SELECTED_GLYPH} C`) {
    throw new Error(
      `selected row = ${JSON.stringify(radio.children[2]?.props.text)}`,
    );
  }
  // Enter also commits.
  radioKey(radio, { name: "up", ...keyBase });
  const entered = radioKey(radio, { name: "enter", ...keyBase });
  if (entered.selected !== 1) {
    throw new Error(`enter commit = ${entered.selected}`);
  }
  if (selectedOf() !== 1) {
    throw new Error(`node selected after enter = ${selectedOf()}`);
  }
  // Unknown keys leave the state unchanged.
  const untouched = radioKey(radio, { name: "tab", ...keyBase });
  if (untouched.selected !== 1 || untouched.focused !== 1) {
    throw new Error(`tab must not move = ${JSON.stringify(untouched)}`);
  }
  if (selectedOf() !== 1 || focusedOf() !== 1) {
    throw new Error(
      `node changed by tab = ${
        JSON.stringify({ selected: selectedOf(), focused: focusedOf() })
      }`,
    );
  }
});

Deno.test("Menu composes one row per visible item; the model and render mode never reach the scene props", () => {
  const menu = Menu({ items: menuFixture() });
  if (menu.type !== "menu") throw new Error(`type = ${menu.type}`);
  if (menu.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${menu.props.flex_direction}`);
  }
  if (menu.props.highlighted !== 0) {
    throw new Error(`highlighted = ${menu.props.highlighted}`);
  }
  // The item model + render-mode flags are JS bookkeeping, never scene props.
  if (
    "items" in menu.props || "floating" in menu.props || "submenu" in menu.props
  ) {
    throw new Error("items/floating/submenu must not reach the scene props");
  }
  // A menu starts hidden (the Modal pattern): open false, hidden, display none.
  if (menu.props.open !== false) throw new Error(`open = ${menu.props.open}`);
  if (menu.props.hidden !== true) {
    throw new Error(`hidden = ${menu.props.hidden}`);
  }
  if (menu.props.display !== "none") {
    throw new Error(`display = ${menu.props.display}`);
  }
  // All submenus closed: only the three top-level items materialize, unindented.
  const rows = menuRowTexts(menu);
  if (rows.length !== 3) throw new Error(`rows = ${JSON.stringify(rows)}`);
  if (rows[0] !== "File") throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  if (rows[1] !== "Edit") throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  if (rows[2] !== "Quit") throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  // The highlighted (first) row is reversed; the others are not.
  if (menu.children[0]?.props.reversed !== true) {
    throw new Error("row 0 must be reversed");
  }
  if (menu.children[1]?.props.reversed === true) {
    throw new Error("only the highlighted row may be reversed");
  }
  // An empty menu materializes no rows.
  const empty = Menu({ items: [] });
  if (empty.children.length !== 0) {
    throw new Error(`empty children = ${empty.children.length}`);
  }
});

Deno.test("Menu floating mode sets a z_index prop", () => {
  // Floating defaults the overlay to z-index 0 (the Select pattern).
  const floating = Menu({ items: menuFixture(), floating: true });
  if (floating.props.z_index !== 0) {
    throw new Error(`z_index = ${floating.props.z_index}`);
  }
  if ("floating" in floating.props) {
    throw new Error("floating must not reach the scene props");
  }
  // An explicit z_index is honored — including MENU_Z_INDEX for full overlays.
  const layered = Menu({
    items: menuFixture(),
    floating: true,
    z_index: MENU_Z_INDEX,
  });
  if (layered.props.z_index !== MENU_Z_INDEX) {
    throw new Error(`z_index = ${layered.props.z_index}`);
  }
  // Docked menus carry no z_index prop at all.
  const docked = Menu({ items: menuFixture() });
  if (docked.props.z_index !== undefined) {
    throw new Error(`docked z_index = ${docked.props.z_index}`);
  }
});

Deno.test("Menu inline submenus render as indented rows when open", () => {
  const menu = Menu({ items: menuFixture(), open_submenus: ["0"] });
  const rows = menuRowTexts(menu);
  // Visible order: File, New, Open, Edit, Quit (File's submenu is open).
  if (rows.length !== 5) throw new Error(`rows = ${JSON.stringify(rows)}`);
  if (rows[0] !== "File") throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
  if (rows[1] !== "  New") throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
  if (rows[2] !== "  Open") {
    throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
  }
  if (rows[3] !== "Edit") throw new Error(`row3 = ${JSON.stringify(rows[3])}`);
  if (rows[4] !== "Quit") throw new Error(`row4 = ${JSON.stringify(rows[4])}`);
  // Nested: opening Open's submenu (key "0.1") adds its child, one indent deeper.
  const nested = Menu({ items: menuFixture(), open_submenus: ["0", "0.1"] });
  const nestedRows = menuRowTexts(nested);
  if (nestedRows.length !== 6) {
    throw new Error(`nested rows = ${JSON.stringify(nestedRows)}`);
  }
  if (nestedRows[3] !== "    Open Recent") {
    throw new Error(`nested row3 = ${JSON.stringify(nestedRows[3])}`);
  }
});

Deno.test("Menu flyout submenus render as overlay layers with their own z_index", () => {
  const menu = Menu({
    items: menuFixture(),
    open_submenus: ["0"],
    submenu: "flyout",
  });
  if ("submenu" in menu.props) {
    throw new Error("submenu must not reach the scene props");
  }
  // Root children: the depth-0 rows (File, Edit, Quit) with File's open
  // submenu's flyout layer box interleaved right after its parent row (the
  // layer that paints beside it).
  if (menu.children.length !== 4) {
    throw new Error(`children = ${menu.children.length}`);
  }
  const rows = [
    menu.children[0]?.props.text,
    menu.children[2]?.props.text,
    menu.children[3]?.props.text,
  ];
  if (rows.join(",") !== "File,Edit,Quit") {
    throw new Error(`root rows = ${rows.join(",")}`);
  }
  const layer = menu.children[1];
  if (
    layer === undefined || layer.type !== "box" ||
    layer.props.flex_direction !== "column"
  ) {
    throw new Error("the flyout submenu must be a column box");
  }
  // The flyout layer carries its own paint z-order, above in-flow content.
  if (layer.props.z_index !== MENU_Z_INDEX) {
    throw new Error(`layer z_index = ${layer.props.z_index}`);
  }
  const layerTexts = layer.children.map((child) => child.props.text);
  if (layerTexts.join(",") !== "  New,  Open") {
    throw new Error(`layer rows = ${layerTexts.join(",")}`);
  }
  // A closed submenu renders no layer at all.
  const closed = Menu({ items: menuFixture(), submenu: "flyout" });
  if (closed.children.length !== 3) {
    throw new Error(`closed children = ${closed.children.length}`);
  }
});

Deno.test("Menu starts hidden and openMenu/closeMenu toggle the visible state", () => {
  const closed = Menu({ items: menuFixture() });
  // Fresh reads per assertion — TS narrows a const-typed property access to
  // its first-checked literal.
  const open = (): unknown => closed.props.open;
  const hidden = (): unknown => closed.props.hidden;
  const display = (): unknown => closed.props.display;
  if (open() !== false || hidden() !== true || display() !== "none") {
    throw new Error(`initial = ${JSON.stringify(closed.props)}`);
  }
  // openMenu shows it; closeMenu hides it again.
  openMenu(closed);
  if (open() !== true || hidden() !== false || display() !== "flex") {
    throw new Error(`after open = ${JSON.stringify(closed.props)}`);
  }
  closeMenu(closed);
  if (open() !== false || hidden() !== true || display() !== "none") {
    throw new Error(`after close = ${JSON.stringify(closed.props)}`);
  }
  // Opening an already-open menu is a no-op (the focus record must not be
  // overwritten by the focus that now sits inside the menu).
  openMenu(closed);
  openMenu(closed);
  if (open() !== true) {
    throw new Error(`double open = ${JSON.stringify(closed.props)}`);
  }
  closeMenu(closed);
  closeMenu(closed);
  if (open() !== false) {
    throw new Error(`double close = ${JSON.stringify(closed.props)}`);
  }
  // A foreign node (not created by the Menu factory) is left alone.
  const box = Box();
  openMenu(box);
  if ("open" in box.props) {
    throw new Error("openMenu must ignore non-menu nodes");
  }
  closeMenu(box);
});

Deno.test("openMenu focuses the first registered focusable and closeMenu restores the prior focus", () => {
  const menu = Menu({ items: menuFixture() });
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const outsideNode = Text({ text: "out" });
  // The menu's focusable registers first, so `openMenu`'s `focusFirst()`
  // lands inside the menu; the outside focusable is the prior focus that
  // closing restores.
  const inside = useFocus("menu-in", insideNode, () => {}, manager);
  const outside = useFocus("menu-out", outsideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    manager.focus("menu-out");
    if (activeId() !== "menu-out") throw new Error("setup focus failed");
    openMenu(menu, manager);
    if (activeId() !== "menu-in") {
      throw new Error(
        `open must focus the first registered focusable, got ${activeId()}`,
      );
    }
    closeMenu(menu, manager);
    if (activeId() !== "menu-out") {
      throw new Error(`close must restore the prior focus, got ${activeId()}`);
    }
  } finally {
    inside.dispose();
    outside.dispose();
    manager.blur();
  }
});

Deno.test("closeMenu falls back to a blur when nothing was focused before the open", () => {
  const menu = Menu({ items: menuFixture() });
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const inside = useFocus("menu-fallback-in", insideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    // Nothing is focused when the menu opens: the record is null.
    openMenu(menu, manager);
    if (activeId() !== "menu-fallback-in") {
      throw new Error(
        `focusFirst must focus the registered focusable, got ${activeId()}`,
      );
    }
    closeMenu(menu, manager);
    if (activeId() !== null) {
      throw new Error(
        `close with no recorded focus must blur, got ${activeId()}`,
      );
    }
    // A recorded id that was unregistered meanwhile also falls back to blur.
    manager.focus("menu-fallback-in");
    openMenu(menu, manager);
    inside.dispose(); // unregister the recorded id while the menu is open
    closeMenu(menu, manager);
    if (activeId() !== null) {
      throw new Error(
        `close with an unregistered recorded id must blur, got ${activeId()}`,
      );
    }
  } finally {
    inside.dispose();
    manager.blur();
  }
});

Deno.test("semantics: a checkbox flushes a checkbox descriptor on attach and checkboxKey re-syncs the checked state", () => {
  withFakeAddon(() => {
    const checkbox = Checkbox({ label: "Dark mode", checked: true });
    const handle = attachToFake(checkbox);
    // The factory-derived descriptor flushed on attach: role checkbox, the
    // label from `checkboxLabels` bookkeeping, checked state, enabled.
    const writes = writesOf(handle);
    if (writes.length !== 1) throw new Error(`writes = ${writes.length}`);
    const first = writes[0]!;
    if (first.role !== "checkbox") throw new Error(`role = ${first.role}`);
    if (first.label !== "Dark mode") {
      throw new Error(`label = ${JSON.stringify(first.label)}`);
    }
    if (first.state.join(",") !== "checked") {
      throw new Error(`state = ${first.state.join(",")}`);
    }
    if (first.enabled !== true || first.selected !== false) {
      throw new Error(`enabled/selected = ${first.enabled}/${first.selected}`);
    }
    // checkboxKey flips the state and rebuilds, re-syncing the descriptor:
    // the second write carries the unchecked state.
    checkboxKey(checkbox, { name: "enter", ...keyBase });
    const second = writesOf(handle)[1];
    if (second === undefined || second.state.join(",") !== "") {
      throw new Error(`after toggle = ${JSON.stringify(second)}`);
    }
  });
});

Deno.test("semantics: a toggle maps its on state to checked and a disabled control reports enabled: false", () => {
  withFakeAddon(() => {
    const toggle = Toggle({ label: "Notifications", on: true, disabled: true });
    const writes = writesOf(attachToFake(toggle));
    const first = writes[0];
    if (first === undefined || first.role !== "switch") {
      throw new Error(`role = ${first?.role}`);
    }
    if (first.label !== "Notifications") {
      throw new Error(`label = ${JSON.stringify(first.label)}`);
    }
    // The two-state `on` value surfaces as the native `checked` flag.
    if (first.state.join(",") !== "checked") {
      throw new Error(`state = ${first.state.join(",")}`);
    }
    if (first.enabled !== false) {
      throw new Error(`enabled = ${first.enabled}`);
    }
  });
});

Deno.test("semantics: a radio group carries a radiogroup descriptor and each option row a per-row radio descriptor", () => {
  withFakeAddon(() => {
    const radio = Radio({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", selected: true },
        { value: "c", label: "C" },
      ],
    });
    const handle = attachToFake(radio);
    const writes = writesOf(handle);
    const root = writes[0];
    if (root === undefined || root.role !== "radiogroup") {
      throw new Error(`root role = ${root?.role}`);
    }
    if (root.state.join(",") !== "focused") {
      throw new Error(`root state = ${root.state.join(",")}`);
    }
    if (root.selected !== true) {
      throw new Error(`root selected = ${root.selected}`);
    }
    // The option rows are separate radio members: the focused row (index 0)
    // carries focused, the selected row (index 1) carries checked + selected,
    // the others plain radio rows.
    const rows = radio.children.map((child) =>
      writesOf(child.handle as unknown as FakeNodeHandle)[0]
    );
    if (rows.length !== 3) throw new Error(`rows = ${rows.length}`);
    if (rows[0]?.role !== "radio" || rows[0].state.join(",") !== "focused") {
      throw new Error(`row0 = ${JSON.stringify(rows[0])}`);
    }
    if (rows[1]?.role !== "radio" || rows[1].state.join(",") !== "checked") {
      throw new Error(`row1 = ${JSON.stringify(rows[1])}`);
    }
    if (rows[1].label !== "B" || rows[1].selected !== true) {
      throw new Error(`row1 label/selected = ${JSON.stringify(rows[1])}`);
    }
    if (rows[2]?.state.length !== 0) {
      throw new Error(`row2 = ${JSON.stringify(rows[2])}`);
    }
  });
});

Deno.test("semantics: a select flushes a listbox descriptor with expanded and selected state; selectKey re-syncs", () => {
  withFakeAddon(() => {
    const select = Select({
      options: selectOptions,
      value: "banana",
    });
    const handle = attachToFake(select);
    const writes = writesOf(handle);
    const first = writes[0];
    if (first === undefined || first.role !== "listbox") {
      throw new Error(`role = ${first?.role}`);
    }
    if (first.state.join(",") !== "expanded,focused") {
      throw new Error(`state = ${first.state.join(",")}`);
    }
    if (first.selected !== true) {
      throw new Error(`selected = ${first.selected}`);
    }
    // Enter confirms the highlighted option and dismisses: the re-synced
    // descriptor drops the expanded state.
    selectKey(select, { name: "enter", ...keyBase });
    const after = writesOf(handle)[1];
    if (after === undefined || after.state.includes("expanded")) {
      throw new Error(`after enter = ${JSON.stringify(after)}`);
    }
  });
});

Deno.test("semantics: input/textarea flush a textbox descriptor with the props label; plain nodes record nothing", () => {
  withFakeAddon(() => {
    const input = Input({ value: "ab", caret: 1, label: "Name" } as InputProps);
    const inputWrites = writesOf(attachToFake(input));
    if (
      inputWrites[0]?.role !== "textbox" ||
      inputWrites[0].label !== "Name"
    ) {
      throw new Error(`input = ${JSON.stringify(inputWrites[0])}`);
    }
    const textarea = Textarea({ lines: ["ab", "cd"], row: 1, col: 2 });
    const areaWrites = writesOf(attachToFake(textarea));
    if (
      areaWrites[0]?.role !== "textbox" ||
      areaWrites[0].state.length !== 0
    ) {
      throw new Error(`textarea = ${JSON.stringify(areaWrites[0])}`);
    }
    // Plain text/box nodes have no derivation: attach records no writes.
    const plainHandle = attachToFake(Text({ text: "x" }));
    if (plainHandle.semanticsWrites.length !== 0) {
      throw new Error("plain nodes must record no semantics");
    }
    // syncSemantics is a safe no-op on them too.
    syncSemantics(Box());
  });
});

Deno.test("semantics: a menu flushes a menu descriptor that gains expanded on open and loses it on close", () => {
  withFakeAddon(() => {
    const menu = Menu({ items: menuFixture() });
    const handle = attachToFake(menu);
    const writes = writesOf(handle);
    const first = writes[0];
    if (first === undefined || first.role !== "menu") {
      throw new Error(`role = ${first?.role}`);
    }
    if (first.state.length !== 0) {
      throw new Error(`closed state = ${first.state.join(",")}`);
    }
    openMenu(menu);
    const opened = writesOf(handle).at(-1);
    if (opened === undefined || opened.state.join(",") !== "expanded") {
      throw new Error(`open state = ${JSON.stringify(opened)}`);
    }
    closeMenu(menu);
    const closed = writesOf(handle).at(-1);
    if (closed === undefined || closed.state.length !== 0) {
      throw new Error(`close state = ${JSON.stringify(closed)}`);
    }
  });
});

Deno.test("semantics: clearSemantics before attach drops the pending descriptor", () => {
  withFakeAddon(() => {
    const checkbox = Checkbox({ label: "Dark mode" });
    checkbox.clearSemantics();
    const handle = attachToFake(checkbox);
    if (handle.semanticsWrites.length !== 0) {
      throw new Error("cleared semantics must not flush");
    }
  });
});

Deno.test("renderer: the semantics option forwards to the native constructor; semantics() and setSemanticsEnabled are wired", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ headless: true, semantics: true });
    const nativeOptions = state.lastRendererOptions as { semantics?: unknown } | null;
    if (nativeOptions?.semantics !== true) {
      throw new Error(
        `native semantics = ${JSON.stringify(nativeOptions?.semantics)}`,
      );
    }
    if (renderer.semantics().length !== 0) {
      throw new Error("fake dump must be empty");
    }
    // The JS-side mirror flag: no throw, no native surface required.
    renderer.setSemanticsEnabled(false);
    renderer.setSemanticsEnabled(true);
  });
  // Without the option, the native constructor sees no semantics key.
  withFakeAddon(() => {
    createRenderer({ headless: true });
    const nativeOptions = state.lastRendererOptions as { semantics?: unknown } | null;
    if (nativeOptions?.semantics !== undefined) {
      throw new Error(
        `default semantics = ${JSON.stringify(nativeOptions?.semantics)}`,
      );
    }
  });
});

Deno.test("menuKey up/down move the highlight clamped at the ends; unknown keys are no-ops", () => {
  const menu = Menu({ items: menuFixture(), open: true });
  // Accessors: menuKey mutates the node in place, which TS's control flow
  // cannot see — reading through functions defeats the stale narrowing.
  const highlightedOf = () => menu.props.highlighted;
  const down = menuKey(menu, { name: "down", ...keyBase });
  if (down.highlighted !== 1) throw new Error(`down = ${down.highlighted}`);
  const downAgain = menuKey(menu, { name: "down", ...keyBase });
  if (downAgain.highlighted !== 2) {
    throw new Error(`down = ${downAgain.highlighted}`);
  }
  // Further down clamps at the last visible item.
  const clamped = menuKey(menu, { name: "down", ...keyBase });
  if (clamped.highlighted !== 2) {
    throw new Error(`down clamp = ${clamped.highlighted}`);
  }
  // The composition's highlighted row follows the highlight.
  if (menu.children[2]?.props.reversed !== true) {
    throw new Error("the highlighted row must be reversed");
  }
  const up = menuKey(menu, { name: "up", ...keyBase });
  if (up.highlighted !== 1) throw new Error(`up = ${up.highlighted}`);
  const clampedLow = menuKey(menu, { name: "up", ...keyBase });
  if (clampedLow.highlighted !== 0) {
    throw new Error(`up clamp = ${clampedLow.highlighted}`);
  }
  if (highlightedOf() !== 0) {
    throw new Error(`node highlighted = ${highlightedOf()}`);
  }
  // Unknown keys leave the state and composition unchanged.
  const untouched = menuKey(menu, { name: "tab", ...keyBase });
  if (untouched.highlighted !== 0 || untouched.count !== 3) {
    throw new Error(`tab must not move = ${JSON.stringify(untouched)}`);
  }
  if (menu.children.length !== 3) {
    throw new Error("tab must not change the composition");
  }
  // A key on an empty menu is a no-op.
  const empty = Menu({ items: [] });
  const onEmpty = menuKey(empty, { name: "down", ...keyBase });
  if (onEmpty.highlighted !== 0 || onEmpty.count !== 0) {
    throw new Error(`empty = ${JSON.stringify(onEmpty)}`);
  }
});

Deno.test("menuKey right opens the highlighted submenu and left closes to the parent", () => {
  const menu = Menu({ items: menuFixture(), open: true });
  const rows = () => menuRowTexts(menu);
  // Right on the highlighted branch (File, index 0) opens its submenu.
  const opened = menuKey(menu, { name: "right", ...keyBase });
  if (opened.count !== 5) throw new Error(`count = ${opened.count}`);
  if (opened.open_submenus.join(",") !== "0") {
    throw new Error(`open_submenus = ${opened.open_submenus.join(",")}`);
  }
  if (rows().join(",") !== "File,  New,  Open,Edit,Quit") {
    throw new Error(`rows = ${rows().join(",")}`);
  }
  // Right on the now-open branch steps into its first child.
  const descended = menuKey(menu, { name: "right", ...keyBase });
  if (descended.highlighted !== 1) {
    throw new Error(`descend = ${descended.highlighted}`);
  }
  // Right on a leaf is a no-op.
  const leafNoop = menuKey(menu, { name: "right", ...keyBase }); // highlighted 1 = New (leaf)
  if (leafNoop.count !== 5 || leafNoop.highlighted !== 1) {
    throw new Error(`leaf right = ${JSON.stringify(leafNoop)}`);
  }
  // Left on an item inside the submenu closes it to the parent: File's
  // submenu closes and the highlight lands on File.
  const closed = menuKey(menu, { name: "left", ...keyBase });
  if (closed.open_submenus.length !== 0) {
    throw new Error(
      `open_submenus after left = ${closed.open_submenus.join(",")}`,
    );
  }
  if (closed.highlighted !== 0) {
    throw new Error(`highlighted after left = ${closed.highlighted}`);
  }
  if (rows().join(",") !== "File,Edit,Quit") {
    throw new Error(`rows after left = ${rows().join(",")}`);
  }
  // Left on an open branch collapses it too.
  menuKey(menu, { name: "right", ...keyBase });
  const collapsed = menuKey(menu, { name: "left", ...keyBase });
  if (collapsed.open_submenus.length !== 0) {
    throw new Error(
      `open_submenus after left on branch = ${
        collapsed.open_submenus.join(",")
      }`,
    );
  }
  // Left at the top level on a leaf is a no-op.
  const topNoop = menuKey(menu, { name: "left", ...keyBase });
  if (topNoop.highlighted !== 0 || topNoop.count !== 3) {
    throw new Error(`top left = ${JSON.stringify(topNoop)}`);
  }
});

Deno.test("menuKey enter activates a leaf and dismisses; on a branch it opens the submenu; escape dismisses", () => {
  const menu = Menu({ items: menuFixture(), open: true });
  const openOf = () => menu.props.open;
  // Enter on the highlighted branch (File) opens its submenu.
  const branch = menuKey(menu, { name: "enter", ...keyBase });
  if (branch.open_submenus.join(",") !== "0") {
    throw new Error(`enter branch = ${branch.open_submenus.join(",")}`);
  }
  if (openOf() !== true) {
    throw new Error("opening a branch must not dismiss the menu");
  }
  // Down to Quit (the last visible row), then enter activates it + dismisses.
  menuKey(menu, { name: "down", ...keyBase });
  menuKey(menu, { name: "down", ...keyBase });
  menuKey(menu, { name: "down", ...keyBase });
  menuKey(menu, { name: "down", ...keyBase });
  const activated = menuKey(menu, { name: "enter", ...keyBase });
  if (activated.activated !== "2") {
    throw new Error(`activated = ${activated.activated}`);
  }
  if (activated.open !== false) throw new Error(`open = ${activated.open}`);
  if (openOf() !== false) throw new Error(`node open = ${openOf()}`);
  // Escape dismisses an open menu without activating anything.
  const reopened = Menu({ items: menuFixture(), open: true });
  const dismissed = menuKey(reopened, { name: "escape", ...keyBase });
  if (dismissed.open !== false || dismissed.activated !== null) {
    throw new Error(`escape = ${JSON.stringify(dismissed)}`);
  }
  if (reopened.props.open !== false) {
    throw new Error(`node open after escape = ${reopened.props.open}`);
  }
});
