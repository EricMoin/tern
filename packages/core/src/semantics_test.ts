//! Semantics tests: semantics: a checkbox exposes checkbox role, its label, and .

import { dumpOf, enterKey, goldenScene, keyBase, menuFixture, selectFixture, semanticsRenderer, spaceKey, withFakeAddon } from "./semantics_testkit.ts";
import {
  Box,
  Checkbox,
  checkboxKey,
  closeMenu,
  createRenderer,
  Input,
  Menu,
  menuKey,
  openMenu,
  Radio,
  radioKey,
  Select,
  selectKey,
  Textarea,
  Toggle,
  toggleKey,
} from "./index.ts";

Deno.test("semantics: a checkbox exposes checkbox role, its label, and checked/enabled state", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Checkbox({ label: "Dark mode", checked: false }));
    const entries = dump.filter((entry) => entry.role === "checkbox");
    if (entries.length !== 1) {
      throw new Error(`checkbox entries = ${entries.length}: ${JSON.stringify(dump)}`);
    }
    const checkbox = entries[0]!;
    if (checkbox.label !== "Dark mode") {
      throw new Error(`label = ${JSON.stringify(checkbox.label)}`);
    }
    if (checkbox.state.length !== 0) {
      throw new Error(`unchecked state = ${checkbox.state.join(",")}`);
    }
    if (checkbox.enabled !== true || checkbox.selected !== false) {
      throw new Error(`enabled/selected = ${checkbox.enabled}/${checkbox.selected}`);
    }

    // A checked checkbox surfaces the `checked` state flag; a disabled one
    // reports `enabled: false` (the M4.1 derivation contract).
    const checked = dumpOf(Checkbox({ label: "Dark mode", checked: true }))
      .find((entry) => entry.role === "checkbox");
    if (checked === undefined || checked.state.join(",") !== "checked") {
      throw new Error(`checked state = ${JSON.stringify(checked)}`);
    }
    const disabled = dumpOf(Checkbox({ label: "Dark mode", disabled: true }))
      .find((entry) => entry.role === "checkbox");
    if (disabled === undefined || disabled.enabled !== false) {
      throw new Error(`disabled enabled = ${JSON.stringify(disabled)}`);
    }
  });
});

Deno.test("semantics: checkboxKey space flips the checkbox's checked state flag", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const checkbox = Checkbox({ label: "Dark mode", checked: false });
    renderer.root.addChild(checkbox);

    checkboxKey(checkbox, spaceKey);
    const flipped = renderer.semantics().find((entry) => entry.role === "checkbox");
    if (flipped === undefined || !flipped.state.includes("checked")) {
      throw new Error(`after space = ${JSON.stringify(flipped)}`);
    }

    checkboxKey(checkbox, spaceKey);
    const back = renderer.semantics().find((entry) => entry.role === "checkbox");
    if (back === undefined || back.state.includes("checked")) {
      throw new Error(`after second space = ${JSON.stringify(back)}`);
    }
  });
});

Deno.test("semantics: a toggle exposes switch role with its on state as checked", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Toggle({ label: "Notifications", on: true }));
    const toggle = dump.find((entry) => entry.role === "switch");
    if (toggle === undefined) {
      throw new Error(`no switch entry: ${JSON.stringify(dump)}`);
    }
    if (toggle.label !== "Notifications") {
      throw new Error(`label = ${JSON.stringify(toggle.label)}`);
    }
    // The two-state `on` value surfaces as the native `checked` flag.
    if (toggle.state.join(",") !== "checked") {
      throw new Error(`on state = ${toggle.state.join(",")}`);
    }
    if (toggle.enabled !== true || toggle.selected !== false) {
      throw new Error(`enabled/selected = ${toggle.enabled}/${toggle.selected}`);
    }

    const off = dumpOf(Toggle({ label: "Notifications", on: false }))
      .find((entry) => entry.role === "switch");
    if (off === undefined || off.state.length !== 0) {
      throw new Error(`off state = ${JSON.stringify(off)}`);
    }
    const disabled = dumpOf(Toggle({ label: "Notifications", disabled: true }))
      .find((entry) => entry.role === "switch");
    if (disabled === undefined || disabled.enabled !== false) {
      throw new Error(`disabled enabled = ${JSON.stringify(disabled)}`);
    }
  });
});

Deno.test("semantics: toggleKey enter clears the switch's checked state", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const toggle = Toggle({ label: "Notifications", on: true });
    renderer.root.addChild(toggle);

    toggleKey(toggle, enterKey);
    const after = renderer.semantics().find((entry) => entry.role === "switch");
    if (after === undefined || after.state.includes("checked")) {
      throw new Error(`after enter = ${JSON.stringify(after)}`);
    }
  });
});

Deno.test("semantics: a radio group carries a radiogroup root plus one radio entry per option row", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Radio({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", selected: true },
        { value: "c", label: "C" },
      ],
    }));
    const root = dump.find((entry) => entry.role === "radiogroup");
    if (root === undefined) {
      throw new Error(`no radiogroup entry: ${JSON.stringify(dump)}`);
    }
    // The root reports focused (a valid focused row index) and selected (a
    // member of the group is confirmed).
    if (root.state.join(",") !== "focused") {
      throw new Error(`root state = ${root.state.join(",")}`);
    }
    if (root.selected !== true || root.enabled !== true) {
      throw new Error(`root selected/enabled = ${root.selected}/${root.enabled}`);
    }
    // One `radio` entry per option row: the focused row (index 0) carries
    // `focused`, the selected row (index 1) carries `checked` + `selected`,
    // the plain row carries no state.
    const rows = dump.filter((entry) => entry.role === "radio");
    if (rows.length !== 3) {
      throw new Error(`radio rows = ${rows.length}: ${JSON.stringify(dump)}`);
    }
    const [rowA, rowB, rowC] = rows;
    if (rowA?.label !== "A" || rowA.state.join(",") !== "focused" || rowA.selected) {
      throw new Error(`rowA = ${JSON.stringify(rowA)}`);
    }
    if (rowB?.label !== "B" || rowB.state.join(",") !== "checked" || !rowB.selected) {
      throw new Error(`rowB = ${JSON.stringify(rowB)}`);
    }
    if (rowC?.state.length !== 0 || rowC.selected) {
      throw new Error(`rowC = ${JSON.stringify(rowC)}`);
    }
  });
});

Deno.test("semantics: radioKey down/space moves the per-row selected flag", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const radio = Radio({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", selected: true },
        { value: "c", label: "C" },
      ],
    });
    renderer.root.addChild(radio);
    const rowStates = () =>
      renderer.semantics()
        .filter((entry) => entry.role === "radio")
        .map((entry) => entry.state.join(","));

    // down: focus moves 0 -> 1, onto the already-selected row B — the
    // focused flag follows, B now carries checked + focused.
    radioKey(radio, { name: "down", ...keyBase });
    if (rowStates().join("|") !== "|checked,focused|") {
      throw new Error(`after down = ${rowStates().join("|")}`);
    }
    // down: focus moves 1 -> 2; the focused flag follows to row C.
    radioKey(radio, { name: "down", ...keyBase });
    if (rowStates().join("|") !== "|checked|focused") {
      throw new Error(`after second down = ${rowStates().join("|")}`);
    }
    // space: the focused row (C) becomes the selection — the per-row
    // `selected` flag moves from B to C.
    radioKey(radio, spaceKey);
    const after = renderer.semantics()
      .filter((entry) => entry.role === "radio")
      .map((entry) => ({ label: entry.label, state: entry.state.join(","), selected: entry.selected }));
    const selectedRows = after.filter((entry) => entry.selected);
    if (selectedRows.length !== 1 || selectedRows[0]?.label !== "C") {
      throw new Error(`after space selected = ${JSON.stringify(after)}`);
    }
    const rowC = after.find((entry) => entry.label === "C");
    if (rowC === undefined || rowC.state !== "checked,focused") {
      throw new Error(`rowC after space = ${JSON.stringify(rowC)}`);
    }
  });
});

Deno.test("semantics: a select exposes a listbox entry with expanded/focused state and a confirmed value", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Select({ options: selectFixture(), value: "banana" }));
    const select = dump.find((entry) => entry.role === "listbox");
    if (select === undefined) {
      throw new Error(`no listbox entry: ${JSON.stringify(dump)}`);
    }
    // The dropdown opens by default and a value is confirmed.
    if (select.state.join(",") !== "expanded,focused") {
      throw new Error(`state = ${select.state.join(",")}`);
    }
    if (select.selected !== true || select.enabled !== true) {
      throw new Error(`selected/enabled = ${select.selected}/${select.enabled}`);
    }
  });
});

Deno.test("semantics: selectKey enter confirms and dismisses — the listbox drops expanded", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const select = Select({ options: selectFixture(), value: "banana" });
    renderer.root.addChild(select);

    selectKey(select, enterKey);
    const after = renderer.semantics().find((entry) => entry.role === "listbox");
    if (after === undefined || after.state.includes("expanded")) {
      throw new Error(`after enter = ${JSON.stringify(after)}`);
    }
    if (!after.state.includes("focused") || after.selected !== true) {
      throw new Error(`after enter state/selected = ${after.state.join(",")}/${after.selected}`);
    }
  });
});

Deno.test("semantics: an input exposes a textbox entry with its props label", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Input({ value: "ab", caret: 1, label: "Name" }));
    const textbox = dump.find((entry) => entry.role === "textbox");
    if (textbox === undefined) {
      throw new Error(`no textbox entry: ${JSON.stringify(dump)}`);
    }
    if (textbox.label !== "Name") {
      throw new Error(`label = ${JSON.stringify(textbox.label)}`);
    }
    if (textbox.state.length !== 0) {
      throw new Error(`state = ${textbox.state.join(",")}`);
    }
    if (textbox.enabled !== true || textbox.selected !== false) {
      throw new Error(`enabled/selected = ${textbox.enabled}/${textbox.selected}`);
    }

    // A disabled input reports `enabled: false`; a focused one `focused`.
    const disabled = dumpOf(Input({ value: "x", disabled: true }))
      .find((entry) => entry.role === "textbox");
    if (disabled === undefined || disabled.enabled !== false) {
      throw new Error(`disabled enabled = ${JSON.stringify(disabled)}`);
    }
    const focused = dumpOf(Input({ value: "x", focused: true }))
      .find((entry) => entry.role === "textbox");
    if (focused === undefined || focused.state.join(",") !== "focused") {
      throw new Error(`focused state = ${JSON.stringify(focused)}`);
    }
  });
});

Deno.test("semantics: a textarea exposes a textbox entry without a label", () => {
  withFakeAddon(() => {
    const dump = dumpOf(Textarea({ lines: ["ab", "cd"], row: 1, col: 2 }));
    const textbox = dump.find((entry) => entry.role === "textbox");
    if (textbox === undefined) {
      throw new Error(`no textbox entry: ${JSON.stringify(dump)}`);
    }
    if (textbox.label !== undefined) {
      throw new Error(`label = ${JSON.stringify(textbox.label)}`);
    }
    if (textbox.enabled !== true) {
      throw new Error(`enabled = ${textbox.enabled}`);
    }
  });
});

Deno.test("semantics: a closed menu exposes a menu entry that gains expanded on open and loses it on close", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const menu = Menu({ items: menuFixture() }); // open defaults to false
    renderer.root.addChild(menu);
    const entry = () => renderer.semantics().find((e) => e.role === "menu");

    const closed = entry();
    if (closed === undefined || closed.state.length !== 0) {
      throw new Error(`closed state = ${JSON.stringify(closed)}`);
    }
    if (closed?.enabled !== true || closed.selected !== false) {
      throw new Error(`closed enabled/selected = ${closed?.enabled}/${closed?.selected}`);
    }

    openMenu(menu);
    const opened = entry();
    if (opened === undefined || opened.state.join(",") !== "expanded") {
      throw new Error(`open state = ${JSON.stringify(opened)}`);
    }

    closeMenu(menu);
    const closedAgain = entry();
    if (closedAgain === undefined || closedAgain.state.length !== 0) {
      throw new Error(`close state = ${JSON.stringify(closedAgain)}`);
    }
  });
});

Deno.test("semantics: a menu created open carries expanded, and menuKey escape dismisses it", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const menu = Menu({ items: menuFixture(), open: true });
    renderer.root.addChild(menu);

    const opened = renderer.semantics().find((entry) => entry.role === "menu");
    if (opened === undefined || opened.state.join(",") !== "expanded") {
      throw new Error(`open-at-creation state = ${JSON.stringify(opened)}`);
    }

    // menuKey keeps the menu open (right opens a submenu — still expanded),
    // escape dismisses it (expanded dropped) — the menuKey-driven transitions.
    menuKey(menu, { name: "right", ...keyBase });
    const branchOpen = renderer.semantics().find((entry) => entry.role === "menu");
    if (branchOpen === undefined || !branchOpen.state.includes("expanded")) {
      throw new Error(`after right = ${JSON.stringify(branchOpen)}`);
    }

    menuKey(menu, { name: "escape", ...keyBase });
    const dismissed = renderer.semantics().find((entry) => entry.role === "menu");
    if (dismissed === undefined || dismissed.state.includes("expanded")) {
      throw new Error(`after escape = ${JSON.stringify(dismissed)}`);
    }
  });
});

Deno.test("semantics: without the option the store is off — semantics() stays empty even after setSemantics", () => {
  withFakeAddon(() => {
    const renderer = createRenderer({ headless: true }); // no `semantics` option
    const checkbox = Checkbox({ label: "Dark mode", checked: false });
    renderer.root.addChild(checkbox);

    if (renderer.semantics().length !== 0) {
      throw new Error(`default-off dump = ${JSON.stringify(renderer.semantics())}`);
    }

    // Explicit setSemantics and a key-handler state flip are dropped too: the
    // JS wiring is best-effort and a disabled store rejects the writes.
    checkbox.setSemantics({
      role: "checkbox",
      label: "explicit",
      state: [],
      enabled: true,
      selected: false,
    });
    checkboxKey(checkbox, spaceKey);
    if (renderer.semantics().length !== 0) {
      throw new Error(`dump after writes = ${JSON.stringify(renderer.semantics())}`);
    }
  });
});

Deno.test("semantics: the dump surfaces parent links in scene pre-order and setSemanticsEnabled does not gate reads", () => {
  withFakeAddon(() => {
    const renderer = semanticsRenderer();
    const box = Box({}, Checkbox({ label: "A" }), Toggle({ label: "B" }));
    renderer.root.addChild(box);

    const dump = renderer.semantics();
    // The checkbox and toggle both parent-link to the wrapping box node.
    const parents = dump.map((entry) => entry.parent);
    if (parents.some((parent) => parent === undefined)) {
      throw new Error(`entries must parent-link: ${JSON.stringify(dump)}`);
    }
    if (dump.length !== 2) {
      throw new Error(`dump = ${JSON.stringify(dump)}`);
    }

    // The JS mirror toggle never clears the store: entries written while
    // enabled stay readable (the native read is not gated by the flag).
    renderer.setSemanticsEnabled(false);
    if (renderer.semantics().length !== 2) {
      throw new Error(`read after disable = ${JSON.stringify(renderer.semantics())}`);
    }
  });
});

Deno.test("semantics: render_to_buffer frames are byte-identical with and without semantics set", () => {
  withFakeAddon(() => {
    const width = 40;
    const height = 8;

    // Store off: the factories still sync semantics, but the disabled store
    // rejects every write — nothing lands, the scene is untouched.
    const off = createRenderer({ headless: true, size: { width, height } });
    off.root.addChild(goldenScene());
    const rowsOff = off.snapshotFrame(width, height);
    if (rowsOff.length !== height) {
      throw new Error(`off frame rows = ${rowsOff.length}`);
    }

    // Store on: the same scene records semantics for every wired component.
    const on = createRenderer({
      headless: true,
      semantics: true,
      size: { width, height },
    });
    on.root.addChild(goldenScene());
    const rowsOn = on.snapshotFrame(width, height);
    const dump = on.semantics();
    if (dump.length === 0) {
      throw new Error("the store-on renderer recorded no semantics");
    }

    // The golden: semantics is pure bookkeeping — the painted frames are
    // byte-identical whether or not the store was enabled and populated.
    if (JSON.stringify(rowsOn) !== JSON.stringify(rowsOff)) {
      throw new Error(
        `frames differ with/without semantics:\n${rowsOn.join("\n")}\n---\n${rowsOff.join("\n")}`,
      );
    }
  });
});
