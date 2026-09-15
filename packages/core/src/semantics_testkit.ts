//! The semantics-store fake addon and paint helpers.

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

/** The next synthetic scene node id (the root is 0, mirroring the native
 * scene ids the dump's `id`/`parent` fields surface). */
export let nextNodeId = 1n;

/** The renderer-level store gate: fixed at construction from the
 * `semantics` constructor option, default off (the M4.1 contract — there is
 * no native runtime toggle). */
export let storeEnabled = false;

/** A fake native `NodeHandle` standing in for the real addon's scene handle.
 * It records the scene tree (`children`/`parent`), the prop mirror, and —
 * the M4.1 surface — the semantics entry written via `set_semantics`. */
export class FakeNodeHandle {
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
export class FakeTuiRenderer {
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
export const fakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) =>
    new FakeNodeHandle(type, props),
} as unknown as TernAddon;

/** The box-drawing glyph sets the painter draws for a `border_style` — the
 * same sets the compositor uses (see `index_test.ts`'s `paintSceneRows`). */
export const BORDER_GLYPHS: Record<
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
export function clusterWidth(cluster: string): number {
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
export function clusterRuns(text: string): Array<{ text: string; width: number }> {
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
export function clusterRow(text: string): string {
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
export function paintNode(node: FakeNodeHandle): string[] {
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
export function paintScene(root: FakeNodeHandle, w: number, h: number): string[] {
  const rows: string[] = [];
  for (const child of root.children) {
    for (const row of paintNode(child)) rows.push(row);
  }
  while (rows.length < h) rows.push("");
  return rows.slice(0, h).map((row) => row.padEnd(w, " ").slice(0, w));
}

/** The shared base of a synthetic key event (mirrors `index_test.ts`). */
export const keyBase = { ctrl: false, alt: false, shift: false } as const;

/** A space-press `KeyEvent` (the checkbox/toggle/radio flip key). */
export const spaceKey: KeyEvent = { name: "char", char: " ", ...keyBase };

/** An enter `KeyEvent` (the select confirm / checkbox flip key). */
export const enterKey: KeyEvent = { name: "enter", ...keyBase };

/** The select options fixture used by the select tests. */
export const selectFixture = () => [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

/** The menu items fixture used by the menu tests: a two-branch top level
 * with an openable submenu (the `right`-key branch-open path). */
export const menuFixture = () => [
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
export function withFakeAddon<T>(fn: () => T): T {
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
export function semanticsRenderer() {
  return createRenderer({ headless: true, semantics: true });
}

/** Attach `node` under a fresh semantics-enabled renderer and return the
 * flat semantics dump of the resulting scene. */
export function dumpOf(node: ReturnType<typeof Box>): SceneSemanticsJs[] {
  const renderer = semanticsRenderer();
  renderer.root.addChild(node);
  return renderer.semantics();
}

/** The golden scene: a wrapping box holding one of each semantically wired
 * form primitive (the multi-row radio exercises column stacking). */
export function goldenScene() {
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
