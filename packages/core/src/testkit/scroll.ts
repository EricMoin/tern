//! The scroll-view fake handle and its fixtures.

import { FakeTuiRenderer, fakeContentSizes, state } from "./fakes.ts";
import { Node, NodeHandle, Renderer, ScrollView, TernAddon, Text, TuiRenderer, createRenderer, setAddonForTesting } from "../index.ts";


/**
 * A size-aware fake native node handle for the ScrollView tests:
 * `content_size` returns the size derived at creation — text/streaming nodes
 * measure their content (widest line width, line count), boxes use their
 * `width`/`height` props or a default viewport of {11, 2}. This mirrors the
 * real engine's `content_size` contract (text = wrapped content, containers =
 * laid-out rect) so the scroll helpers' clamping is exercised against
 * realistic geometry.
 *
 * A `streaming_text` handle accumulates spans appended through
 * `append_span` and measures *them* (the real engine measures the stream, not
 * a `text` prop — compositor.rs `content_size`), so the auto-scroll tests can
 * grow the content by appending spans, exactly like the native path.
 */
class FakeScrollNodeHandle {
  readonly kind: string;
  readonly props: Record<string, unknown>;
  streamText = "";
  constructor(type: string, props: Record<string, unknown> | null | undefined) {
    this.kind = type;
    this.props = props ?? {};
  }
  content_size(): { width: number; height: number } {
    if (this.kind === "text" || this.kind === "streaming_text") {
      const text = this.kind === "streaming_text"
        ? this.streamText
        : (typeof this.props.text === "string" ? this.props.text : "");
      const lines = text.split("\n");
      let width = 0;
      for (const line of lines) width = Math.max(width, line.length);
      return { width, height: lines.length };
    }
    return {
      width: typeof this.props.width === "number" ? this.props.width : 11,
      height: typeof this.props.height === "number" ? this.props.height : 2,
    };
  }
  add_child(child: unknown): unknown {
    return child;
  }
  insert_before(child: unknown, _anchor: unknown): unknown {
    return child;
  }
  set_props(_props: unknown): void {}
  set_prop(_key: string, _value: unknown): void {}
  append_span(text: string, _style?: unknown): void {
    this.streamText += text;
  }
  remove(): boolean {
    return true;
  }
}

/** The native node types materialized through the size-aware fake. */
const scrollCreatedNodes: Array<
  { type: string; props: Record<string, unknown> | null }
> = [];

/** A fake addon whose `content_size` reflects each node's content/layout. */
const scrollFakeAddon = {
  TuiRenderer: FakeTuiRenderer,
  NodeHandle: FakeScrollNodeHandle,
  create_node: (type: string, props?: Record<string, unknown> | null) => {
    scrollCreatedNodes.push({ type, props: props ?? null });
    return new FakeScrollNodeHandle(type, props);
  },
} as unknown as TernAddon;

/** Run `fn` with the size-aware fake addon installed. */
export function withScrollFakeAddon(fn: () => void): void {
  scrollCreatedNodes.length = 0;
  setAddonForTesting(scrollFakeAddon);
  try {
    fn();
  } finally {
    setAddonForTesting(null);
  }
}

/** A `ScrollView` with a 5x2 viewport and a 6x3 content leaf attached under a
 * fresh renderer over the fake addon: both axes can scroll (max offsets
 * (1, 1)). Returns the renderer and the attached view. */
export function makeScrollable(): { renderer: Renderer; view: Node } {
  const renderer = createRenderer();
  const view = ScrollView(
    { width: 5, height: 2, showScrollbar: true },
    Text({ text: "aaaaaa\nbbbbb\ncc" }),
  );
  renderer.root.addChild(view);
  fakeContentSizes.set(view.handle, { width: 5, height: 2 });
  const leaf = view.children.find((child) => child.type === "text");
  if (leaf === undefined) {
    throw new Error("scroll view must compose a content leaf");
  }
  fakeContentSizes.set(leaf.handle, { width: 6, height: 3 });
  return { renderer, view };
}

/** Assert the fake native renderer's selection overlay equals `expected`
 * (or is `null` when the selection must be cleared). */
export function assertSelection(
  expected: { col1: number; row1: number; col2: number; row2: number } | null,
): void {
  const native = state.lastFakeRenderer;
  if (native === null) throw new Error("fake renderer not constructed");
  const actual = native.selection;
  if (expected === null) {
    if (actual !== null) {
      throw new Error(`selection = ${JSON.stringify(actual)}, expected null`);
    }
    return;
  }
  if (actual === null) {
    throw new Error(`selection = null, expected ${JSON.stringify(expected)}`);
  }
  if (
    actual.col1 !== expected.col1 || actual.row1 !== expected.row1 ||
    actual.col2 !== expected.col2 || actual.row2 !== expected.row2
  ) {
    throw new Error(
      `selection = ${JSON.stringify(actual)}, expected ${
        JSON.stringify(expected)
      }`,
    );
  }
}
