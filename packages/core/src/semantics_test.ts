// M4.1 semantics unit tests (subtask 4): per-component semantics derivation,
// key-handler state transitions, the default-off contract, and the
// cell-output invariance golden.
//
// Unlike the semantics tests in `index_test.ts` — which assert the native
// `set_semantics` writes recorded by the shared fake handle — these tests
// drive the M4.1 READ API end to end: `createRenderer({ headless: true,
// semantics: true })` + real component factories + `Renderer.semantics()`
// (the flat dump) and `snapshotFrame()` (the painted frame), exactly as a
// consumer or an a11y bridge would.
//
// The real `.node` addon is not loadable under the workspace test flags
// (`deno test --allow-env=NODE_ENV` — no `--allow-read`/FFI), so a fake
// addon stands in for the native store through the documented
// `setAddonForTesting` seam. The fake models the native contract faithfully:
// a default-off store gate fixed at renderer construction, `set_semantics`
// rejecting writes while disabled (the exact error the JS `#writeSemantics`
// catches and drops), a pre-order flat dump with sorted state flags, and
// `remove()` purging a subtree's entries — the native store itself is
// covered by the Rust tests in `src/bindings/tern-node/src/tests/semantics.rs`.

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
import type { KeyEvent, SemanticsNodeJs, SceneSemanticsJs } from "./index.ts";
import { setAddonForTesting } from "./addon.ts";
import type { TernAddon } from "./addon.ts";

// ---------------------------------------------------------------------------
// Fake native addon with a faithful semantics store
// ---------------------------------------------------------------------------

/** The next synthetic scene node id (the root is 0, mirroring the native
 * scene ids the dump's `id`/`parent` fields surface). */
let nextNodeId = 1n;

/** The renderer-level store gate: fixed at construction from the
 * `semantics` constructor option, default off (the M4.1 contract — there is
 * no native runtime toggle). */
let storeEnabled = false;

/** A fake native `NodeHandle` standing in for the real addon's scene handle.
 * It records the scene tree (`children`/`parent`), the prop mirror, and —
 * the M4.1 surface — the semantics entry written via `set_semantics`. */
class FakeNodeHandle {
  readonly id: bigint;
  readonly kind: string;
  readonly props: Record<string, unknown>;
  readonly children: FakeNodeHandle[] = [];
  parent: FakeNodeHandle | null = null;
  /** The recorded semantics write shape, or `null` when the node carries no
   * semantics entry (the dump omits such nodes, mirroring the native store). */
  semantics: SemanticsNodeJs | null = null;

  constructor(type: string, props: Record<string, unknown> | null | undefined) {
    this.kind = type;
    this.props = props ?? {};
    this.id = nextNodeId++;
  }

  content_size(): { width: number; height: number } {
    return { width: 11, height: 2 };
  }
  add_child(child: unknown): unknown {
    const handle = child as FakeNodeHandle;
    handle.parent = this;
    this.children.push(handle);
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    const handle = child as FakeNodeHandle;
    handle.parent = this;
    this.children.push(handle);
    return child;
  }
  set_props(props: unknown): void {
    Object.assign(this.props, props as Record<string, unknown>);
  }
  set_prop(key: string, value: unknown): void {
    this.props[key] = value;
  }
  append_span(_text: string, _style?: unknown): void {}
  /**
   * Record a semantics write — mirroring the native `NodeHandle::set_semantics`:
   * while the store is off (the default) the write is rejected with exactly the
   * error the JS `#writeSemantics` helper recognizes and drops, so a disabled
   * store makes the JS wiring's best-effort pushes inert no-ops.
   */
  set_semantics(node: SemanticsNodeJs): void {
    if (!storeEnabled) {
      throw new Error(
        "semantics store is disabled (construct the renderer with `semantics: true`)",
      );
    }
    this.semantics = node;
  }
  clear_semantics(): void {
    this.semantics = null;
  }
  /** Detach this node: drop it from its parent's children and purge its
   * semantics entry — the fake mirror of `Scene::remove`, which clears the
   * parallel tree of every removed subtree id. */
  remove(): boolean {
    if (this.parent !== null) {
      const siblings = this.parent.children;
      const index = siblings.indexOf(this);
      if (index !== -1) siblings.splice(index, 1);
    }
    this.parent = null;
    this.semantics = null;
    return true;
  }
}

/** A fake native `TuiRenderer` standing in for the real addon: it records
 * the constructor options (fixing the store gate), exposes the scene root,
 * dumps the semantics store flat, and paints the captured scene for
 * `snapshotFrame` (the golden's `render_to_buffer` stand-in). */
class FakeTuiRenderer {
  readonly rootHandle = new FakeNodeHandle("root", {});
  constructor(options: unknown) {
    const opts = options as { semantics?: boolean } | null;
    storeEnabled = opts?.semantics === true;
  }
  root(): FakeNodeHandle {
    return this.rootHandle;
  }
  start_event_stream(
    _callback: (err: Error | null, event: unknown) => void,
  ): void {}
  render_to_buffer(width?: number, height?: number): string[] {
    const w = width ?? 80;
    const h = height ?? 24;
    return paintScene(this.rootHandle, w, h);
  }
  render_to_buffer_styled(width?: number, height?: number): unknown[][] {
    return this.render_to_buffer(width, height).map((row) => [{ text: row }]);
  }
  /**
   * The flat semantics dump (the M4.1 read API): one entry per node with a
   * semantics record, in scene pre-order, `id`/`parent` mirroring the scene
   * tree (the root's entry has no `parent`), state flags sorted for a stable
   * dump — and, mirroring the native read, NOT gated by the store's enable
   * flag (entries written while enabled stay readable).
   */
  semantics(): SceneSemanticsJs[] {
    const dump: SceneSemanticsJs[] = [];
    const visit = (handle: FakeNodeHandle): void => {
      if (handle.semantics !== null) {
        const entry: SceneSemanticsJs = {
          id: handle.id,
          role: handle.semantics.role,
          state: [...handle.semantics.state].sort(),
          enabled: handle.semantics.enabled,
          selected: handle.semantics.selected,
        };
        // Optional fields are omitted when absent (the project's
        // `exactOptionalPropertyTypes` rejects an explicit `undefined`).
        if (handle.parent !== null) entry.parent = handle.parent.id;
        if (handle.semantics.label !== undefined) {
          entry.label = handle.semantics.label;
        }
        dump.push(entry);
      }
      for (const child of handle.children) visit(child);
    };
    visit(this.rootHandle);
    return dump;
  }
  destroy(): void {}
}

/** The fake addon injected through `setAddonForTesting`. */
const fakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) =>
    new FakeNodeHandle(type, props),
} as unknown as TernAddon;

// ---------------------------------------------------------------------------
// Minimal scene painter (the golden's render_to_buffer stand-in)
// ---------------------------------------------------------------------------

/** The box-drawing glyph sets the painter draws for a `border_style` — the
 * same sets the compositor uses (see `index_test.ts`'s `paintSceneRows`). */
const BORDER_GLYPHS: Record<
  string,
  readonly [string, string, string, string, string, string]
> = {
  rounded: ["┌", "┐", "└", "┘", "─", "│"],
  plain: ["+", "+", "+", "+", "-", "|"],
  double: ["╔", "╗", "╚", "╝", "═", "║"],
  thick: ["┏", "┓", "┗", "┛", "━", "┃"],
};

/** The display width of one grapheme cluster: 2 columns for the standard
 * East-Asian wide ranges, else 1 — the minimal subset of the core width
 * convention the golden content needs (ASCII is exact). */
function clusterWidth(cluster: string): number {
  let width = 0;
  for (const cp of cluster) {
    const code = cp.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Split `text` into grapheme clusters (UAX #29, the same split the core
 * editing layer and the Rust compositor use) with their display widths. */
function clusterRuns(text: string): Array<{ text: string; width: number }> {
  const runs: Array<{ text: string; width: number }> = [];
  for (
    const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(text)
  ) {
    runs.push({ text: segment.segment, width: clusterWidth(segment.segment) });
  }
  return runs;
}

/** The painted form of `text`: each cluster's full text at its lead column
 * and a space on its continuation columns (a wide glyph's masked right half),
 * so the row has exactly `width(text)` display columns. */
function clusterRow(text: string): string {
  let row = "";
  for (const run of clusterRuns(text)) {
    row += run.text;
    for (let i = 1; i < run.width; i++) row += " ";
  }
  return row;
}

/** Paint `node`'s subtree as viewport rows: a node paints its text children
 * as a flex column (child rows stacked top to bottom) offset by `padding`,
 * with `border_style` glyphs drawn at the rect edges — the geometry subset
 * of the real compositor the golden scenes use (mirrors `index_test.ts`'s
 * `paintSceneRows`, without the shared-roots overpaint case). */
function paintNode(node: FakeNodeHandle): string[] {
  const pad = typeof node.props.padding === "number" ? node.props.padding : 0;
  const border = BORDER_GLYPHS[String(node.props.border_style ?? "none")];

  let inner: string[] = [];
  for (const child of node.children) {
    if (child.children.length === 0) {
      // A leaf paints its `text` prop (the empty string paints a blank row).
      inner.push(clusterRow(typeof child.props.text === "string" ? child.props.text : ""));
    } else {
      for (const row of paintNode(child)) inner.push(row);
    }
  }
  if (inner.length === 0) inner = [""];

  const contentWidth = Math.max(...inner.map(clusterWidth));
  const bw = contentWidth + 2 * pad;
  const bh = inner.length + 2 * pad;
  const rows: string[] = [];
  for (let y = 0; y < bh; y++) {
    let row = "";
    for (let x = 0; x < bw; x++) {
      let ch = " ";
      if (border !== undefined) {
        if (y === 0) ch = x === 0 ? border[0] : x === bw - 1 ? border[1] : border[4];
        else if (y === bh - 1) {
          ch = x === 0 ? border[2] : x === bw - 1 ? border[3] : border[4];
        } else ch = x === 0 || x === bw - 1 ? border[5] : " ";
      }
      const contentRow = y - pad;
      if (contentRow >= 0 && contentRow < inner.length) {
        const runs = clusterRuns(inner[contentRow]!);
        const col = x - pad;
        if (col >= 0) {
          let at = 0;
          for (const run of runs) {
            if (col >= at && col < at + run.width) ch = run.text;
            at += run.width;
          }
        }
      }
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

/** Paint the fake scene under `root` into `w`×`h` rows: the root's children
 * stack as the scene's top-level rows (like a bare flex column), blank rows
 * fill the viewport height, and every row is space-padded to the width. */
function paintScene(root: FakeNodeHandle, w: number, h: number): string[] {
  const rows: string[] = [];
  for (const child of root.children) {
    for (const row of paintNode(child)) rows.push(row);
  }
  while (rows.length < h) rows.push("");
  return rows.slice(0, h).map((row) => row.padEnd(w, " ").slice(0, w));
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** The shared base of a synthetic key event (mirrors `index_test.ts`). */
const keyBase = { ctrl: false, alt: false, shift: false } as const;

/** A space-press `KeyEvent` (the checkbox/toggle/radio flip key). */
const spaceKey: KeyEvent = { name: "char", char: " ", ...keyBase };

/** An enter `KeyEvent` (the select confirm / checkbox flip key). */
const enterKey: KeyEvent = { name: "enter", ...keyBase };

/** The select options fixture used by the select tests. */
const selectFixture = () => [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

/** The menu items fixture used by the menu tests: a two-branch top level
 * with an openable submenu (the `right`-key branch-open path). */
const menuFixture = () => [
  {
    label: "File",
    children: [{ label: "Open" }, { label: "Save" }],
  },
  { label: "Edit" },
];

/**
 * Run `fn` with the fake addon installed (fresh ids + a default-off store
 * gate), resetting the seam afterwards — the `index_test.ts` pattern.
 */
function withFakeAddon<T>(fn: () => T): T {
  nextNodeId = 1n;
  storeEnabled = false;
  setAddonForTesting(fakeAddon);
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => {
      setAddonForTesting(null);
    }) as T;
  }
  setAddonForTesting(null);
  return result;
}

/** A fresh headless renderer with the semantics store enabled (the M4.1
 * opt-in every per-component test drives). */
function semanticsRenderer() {
  return createRenderer({ headless: true, semantics: true });
}

/** Attach `node` under a fresh semantics-enabled renderer and return the
 * flat semantics dump of the resulting scene. */
function dumpOf(node: ReturnType<typeof Box>): SceneSemanticsJs[] {
  const renderer = semanticsRenderer();
  renderer.root.addChild(node);
  return renderer.semantics();
}

// ---------------------------------------------------------------------------
// Per-component semantics (role / label / enabled / selected)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default-off contract + dump semantics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cell-output invariance golden
// ---------------------------------------------------------------------------

/** The golden scene: a wrapping box holding one of each semantically wired
 * form primitive (the multi-row radio exercises column stacking). */
function goldenScene() {
  return Box({},
    Checkbox({ label: "Dark mode", checked: true }),
    Toggle({ label: "Notifications", on: true }),
    Input({ value: "type here", caret: 0, label: "Name" }),
    Radio({
      options: [
        { value: "rust", label: "Rust" },
        { value: "go", label: "Go", selected: true },
      ],
    }),
  );
}

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
