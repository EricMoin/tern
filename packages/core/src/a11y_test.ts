// M4.2 a11y stream unit tests (subtask 1): the versioned JSONL stream over
// `Renderer.semantics()` — the deterministic dump-line golden (bigint scene
// ids as decimal strings, embedded newlines escaped), the no-change
// suppression contract, the paint-invariance property (the stream is a pure
// read — painted frames are byte-identical with it running), and the
// best-effort sink-error tolerance (a throwing sink never breaks the frame
// path, and `stopA11yStream` cuts future emissions).
//
// The real `.node` addon is not loadable under the workspace test flags
// (`deno test --allow-env=NODE_ENV` — no `--allow-read`/FFI), so a fake
// addon stands in for the native store through the documented
// `setAddonForTesting` seam — the same machinery as `semantics_test.ts`,
// with one addition: the fake `TuiRenderer` gets a `render()` method, which
// the coalesced frame path (`#scheduleFrame`'s `run()`) calls and which the
// semantics tests (which never drive frames) did not need. The fake models
// the native contract faithfully: a default-off store gate fixed at renderer
// construction, `set_semantics` rejecting writes while disabled, a pre-order
// flat dump with sorted state flags, and `remove()` purging a subtree's
// entries.

import {
  Box,
  Checkbox,
  checkboxKey,
  createRenderer,
  Input,
  Toggle,
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
 * paints the captured scene for `snapshotFrame` (the golden's
 * `render_to_buffer` stand-in), and — the addition over the `semantics_test`
 * fake — `render()`: the coalesced frame path calls it, and a missing method
 * would make every `requestFrame` throw. */
class FakeTuiRenderer {
  readonly rootHandle = new FakeNodeHandle("root", {});
  constructor(options: unknown) {
    const opts = options as { semantics?: boolean } | null;
    storeEnabled = opts?.semantics === true;
  }
  root(): FakeNodeHandle {
    return this.rootHandle;
  }
  /** Paint the shared scene — the fake stand-in for the native `render()`
   * the coalesced frame path calls (no terminal I/O in the fake). */
  render(): void {}
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

/** A space-press `KeyEvent` (the checkbox flip key). */
const spaceKey: KeyEvent = { name: "char", char: " ", ...keyBase };

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
 * opt-in every a11y-stream test drives). */
function semanticsRenderer() {
  return createRenderer({ headless: true, semantics: true });
}

/** Drive one coalesced painted frame and wait for it to complete: the
 * `requestFrame` callback runs after the native render AND the a11y stream
 * emission (the emission hook sits before the queued-callback loop in the
 * frame's `run()`), so the stream line for this frame has been delivered by
 * the time the promise resolves — and a throwing frame path would reject. */
function driveFrame(renderer: ReturnType<typeof createRenderer>): Promise<void> {
  return new Promise<void>((resolve) => {
    renderer.requestFrame(() => resolve());
  });
}

/** Assert `actual === expected`, reporting `label` with the actual value.
 * A helper rather than inline comparisons keeps the comparison out of any
 * narrowed scope (a prior `!== N` guard would narrow `lines.length` to the
 * literal `N` and make a later `!== M` check a type error). */
function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} = ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic JSONL golden
// ---------------------------------------------------------------------------

/**
 * The golden scene: a wrapping box holding one of each a11y-stream-relevant
 * form primitive. The 4th input's label contains a literal newline — this
 * validates the single-line property of the stream (JSON.stringify escapes
 * it to the two-char `\n` sequence, so the dump stays one line).
 */
function goldenScene() {
  return Box({},
    Checkbox({ label: "Dark mode", checked: true }),
    Toggle({ label: "Notifications", on: true }),
    Input({ value: "type here", caret: 0, label: "Name" }),
    Input({ value: "x", caret: 0, label: "Line one\nLine two" }),
  );
}

/**
 * The exact bytes the stream must emit for {@link goldenScene}: the header
 * `{"v":1}` (protocol version 1) then one line holding the full dump as ONE
 * JSON array. Node ids follow the fake's allocation order — the renderer
 * root takes 1, then the tree materializes depth-first on attach (each
 * widget's root primitive plus its text leaf): box=2, checkbox=3,
 * toggle=5, input#1=7, input#2=9. Each dump entry serializes in the fake's
 * construction order — `id, role, state, enabled, selected, parent, label`
 * (JSON.stringify preserves insertion order) — with the bigint-replacer
 * decimal-string ids (`"id":"3"`, `"parent":"2"`) and the label's newline
 * escaped as `\n`.
 */
const GOLDEN_LINES = [
  `{"v":1}`,
  `[{"id":"3","role":"checkbox","state":["checked"],"enabled":true,"selected":false,"parent":"2","label":"Dark mode"},` +
    `{"id":"5","role":"switch","state":["checked"],"enabled":true,"selected":false,"parent":"2","label":"Notifications"},` +
    `{"id":"7","role":"textbox","state":[],"enabled":true,"selected":false,"parent":"2","label":"Name"},` +
    `{"id":"9","role":"textbox","state":[],"enabled":true,"selected":false,"parent":"2","label":"Line one\\nLine two"}]`,
];

Deno.test("a11y stream: one coalesced frame emits the header plus the exact golden dump line", async () => {
  await withFakeAddon(async () => {
    const renderer = semanticsRenderer();
    renderer.root.addChild(goldenScene());

    const lines: string[] = [];
    renderer.startA11yStream((line) => lines.push(line));
    await driveFrame(renderer);
    renderer.stopA11yStream();

    const actual = lines.join("\n");
    const expected = GOLDEN_LINES.join("\n");
    if (actual !== expected) {
      // Print the ACTUAL emitted line so a golden mismatch can be reconciled
      // against the derivation rules (the fake's field order, the id
      // allocation, the bigint/escape serialization) — not by bending the
      // fake or the serialization to fit.
      throw new Error(
        `a11y stream golden mismatch\n--- actual ---\n${actual}\n--- expected ---\n${expected}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// No-change suppression
// ---------------------------------------------------------------------------

Deno.test("a11y stream: an unchanged scene emits nothing on the next frame; a mutation emits a changed line", async () => {
  await withFakeAddon(async () => {
    const renderer = semanticsRenderer();
    const checkbox = Checkbox({ label: "Dark mode", checked: true });
    renderer.root.addChild(checkbox);

    const lines: string[] = [];
    renderer.startA11yStream((line) => lines.push(line));

    // First frame: header + the initial dump.
    await driveFrame(renderer);
    expectEqual(lines.length, 2, "lines after first frame");
    const firstDump = lines[1]!;

    // Second frame with no scene mutation: the serialized dump is unchanged,
    // so the emission is suppressed — still exactly header + one dump line.
    await driveFrame(renderer);
    expectEqual(lines.length, 2, "lines after unchanged frame");

    // checkboxKey flips the checked state; the re-synced dump differs, so the
    // next frame emits one changed line.
    checkboxKey(checkbox, spaceKey);
    await driveFrame(renderer);
    expectEqual(lines.length, 3, "lines after mutation");
    const changedDump = lines[2]!;
    if (changedDump === firstDump || !changedDump.includes(`"state":[]`)) {
      throw new Error(`changed dump = ${changedDump}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Paint invariance
// ---------------------------------------------------------------------------

Deno.test("a11y stream: painted frames are byte-identical with the stream running (a pure read)", async () => {
  await withFakeAddon(async () => {
    const width = 40;
    const height = 8;
    const renderer = semanticsRenderer();
    renderer.root.addChild(goldenScene());

    const before = renderer.snapshotFrame(width, height);

    const lines: string[] = [];
    renderer.startA11yStream((line) => lines.push(line));
    await driveFrame(renderer);
    renderer.stopA11yStream();

    const after = renderer.snapshotFrame(width, height);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(
        `frames differ with the stream running:\n${after.join("\n")}\n---\n${before.join("\n")}`,
      );
    }
    // Prove the test exercised the emission path: the stream must have
    // produced the header plus the frame's dump line.
    if (lines.length < 2) {
      throw new Error(`stream emitted ${lines.length} lines (expected header + dump)`);
    }
  });
});

// ---------------------------------------------------------------------------
// Best-effort sink-error tolerance
// ---------------------------------------------------------------------------

Deno.test("a11y stream: a throwing sink never breaks the frame path, and stopA11yStream cuts further emission", async () => {
  await withFakeAddon(async () => {
    const renderer = semanticsRenderer();
    const checkbox = Checkbox({ label: "Dark mode", checked: true });
    renderer.root.addChild(checkbox);

    const lines: string[] = [];
    let calls = 0;
    // The sink throws for its first 2 calls (the header + the first dump),
    // then records — mirroring a consumer whose pipeline is briefly broken.
    renderer.startA11yStream((line) => {
      calls += 1;
      if (calls <= 2) throw new Error("sink failure");
      lines.push(line);
    });

    // Header (construction) and the first dump both hit the throwing sink —
    // swallowed by the stream's best-effort contract; the frame path must
    // not throw (a rejection here would fail the await).
    await driveFrame(renderer);
    expectEqual(lines.length, 0, "lines before sink recovery");

    // A mutation + frame reaches the recovered sink: the changed dump lands.
    checkboxKey(checkbox, spaceKey);
    await driveFrame(renderer);
    expectEqual(lines.length, 1, "lines after mutation");
    if (!lines[0]!.includes(`"state":[]`)) {
      throw new Error(`recovered dump = ${lines[0]}`);
    }

    // A second mutation + frame delivers another line (the sink stays up).
    checkboxKey(checkbox, spaceKey);
    await driveFrame(renderer);
    expectEqual(lines.length, 2, "lines after second mutation");

    // Stopped: further mutations + frames emit nothing.
    renderer.stopA11yStream();
    checkboxKey(checkbox, spaceKey);
    await driveFrame(renderer);
    expectEqual(lines.length, 2, "lines after stop");
  });
});
