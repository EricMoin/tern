//! Tabs, menu, tree and progress fixtures.

import { FakeNodeHandle } from "./fakes.ts";
import { MenuItem, Node, PROGRESS_DEFAULT_WIDTH, PROGRESS_EMPTY_CHAR, PROGRESS_FILL_CHAR, SemanticsNodeJs, TabSpec, Tabs, Text, Tree, TreeNode, createRenderer } from "../index.ts";


/** A small tabs fixture: three tabs with distinct content nodes. */
export function tabsFixture(): {
  tabs: Node;
  specs: TabSpec[];
  activeOf: () => number;
} {
  const specs: TabSpec[] = [
    { label: "logs", content: [Text({ text: "log line" })] },
    { label: "files", content: [Text({ text: "file list" })] },
    { label: "git", content: [Text({ text: "git status" })] },
  ];
  const tabs = Tabs({ tabs: specs });
  const activeOf = (): number => tabs.props.active as number;
  return { tabs, specs, activeOf };
}

/** A small fixture menu:
 *   File            (branch: New, Open → Open Recent)
 *   Edit            (branch: Cut, Copy)
 *   Quit            (leaf)
 */
export function menuFixture(): MenuItem[] {
  return [
    {
      label: "File",
      children: [
        { label: "New" },
        { label: "Open", children: [{ label: "Open Recent" }] },
      ],
    },
    { label: "Edit", children: [{ label: "Cut" }, { label: "Copy" }] },
    { label: "Quit" },
  ];
}

/** The text of every materialized row leaf among the menu's root children,
 * in scene order (direct row leaves only — flyout layer rows are read through
 * the layer's own children). */
export function menuRowTexts(menu: Node): string[] {
  return menu.children.map((
    child,
  ) => (typeof child.props.text === "string" ? child.props.text : ""));
}

/** Attach `node` under a fresh fake renderer and return its fake native
 * handle — whose `semanticsWrites` record every native `set_semantics` call
 * (the fake stand-in for the M4.1 store writes). */
export function attachToFake(node: Node): FakeNodeHandle {
  const renderer = createRenderer({ headless: true });
  renderer.root.addChild(node);
  return node.handle as unknown as FakeNodeHandle;
}

/** The semantics writes recorded on a fake handle as plain descriptors. */
export function writesOf(handle: FakeNodeHandle): SemanticsNodeJs[] {
  return handle.semanticsWrites as SemanticsNodeJs[];
}

/** The base modifier flags shared by every synthetic Tree key event. */
export const treeKeyBase = { ctrl: false, alt: false, shift: false } as const;

/** A small fixture tree:
 *   ▶ src            (branch: index.ts, components)
 *   ▶ docs           (branch: readme.md)
 *     package.json   (leaf)
 */
export function treeFixture(): TreeNode[] {
  return [
    {
      label: "src",
      children: [
        { label: "index.ts" },
        {
          label: "components",
          children: [{ label: "button.ts" }, { label: "input.ts" }],
        },
      ],
    },
    { label: "docs", children: [{ label: "readme.md" }] },
    { label: "package.json" },
  ];
}

/** The text of every materialized row leaf, in scene order. */
export function treeRowTexts(tree: Node): string[] {
  return tree.children.map((
    leaf,
  ) => (typeof leaf.props.text === "string" ? leaf.props.text : ""));
}

/** The inner (bar) width of a progress node: the outer width minus the frame's
 * border columns (2 for a visible border, 0 for `none`/unset). */
export function progressInnerOf(node: Node): number {
  const outer = typeof node.props.width === "number"
    ? node.props.width
    : PROGRESS_DEFAULT_WIDTH;
  const border = node.props.border_style;
  return outer - (border !== undefined && border !== "none" ? 2 : 0);
}

/** The expected bar text: `ceil(ratio*inner)` fills then empty cells. */
export function expectedBar(ratio: number, inner: number): string {
  const filled = Math.max(0, Math.min(inner, Math.ceil(ratio * inner)));
  return PROGRESS_FILL_CHAR.repeat(filled) +
    PROGRESS_EMPTY_CHAR.repeat(inner - filled);
}
