//! Per-widget fixtures for diff, select, table and panels.

import { fakeContentSizes } from "./fakes.ts";
import { Box, MouseEventJs, Node, Panels, SelectOption, TableColumn, createRenderer, name } from "../index.ts";


/** Build a mouse event payload. */
export function mouse(kind: string, column: number, row: number): MouseEventJs {
  return { kind, column, row, ctrl: false, alt: false, shift: false };
}

/**
 * Build a 3-panel column stack attached under a fake-addon renderer root and
 * record laid-out sizes: the stack is 9 rows tall (panel A rows 0-2, gutter
 * row 3, panel B rows 4-5, gutter row 6, panel C rows 7-8). Panels are 60
 * cells wide.
 */
export function attachedPanels(): {
  renderer: ReturnType<typeof createRenderer>;
  panels: Node;
} {
  const renderer = createRenderer();
  const panels = Panels({
    panels: [
      { header: "A", body: Box() },
      { header: "B", body: Box() },
      { header: "C", body: Box() },
    ],
    direction: "column",
  });
  renderer.root.addChild(panels);
  fakeContentSizes.set(panels.handle, { width: 60, height: 9 });
  fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 3 });
  fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
  fakeContentSizes.set(panels.children[2]!.handle, { width: 60, height: 2 });
  return { renderer, panels };
}

/**
 * A 3-hunk diff: two context runs around an add/del pair each, with line
 * numbers reaching two digits (so the gutter columns must right-align to
 * width 2) and a multi-width (CJK) line in the third hunk.
 */
export const diffHunks = [
  { kind: "ctx", old_line: 1, new_line: 1, text: "  fn main() {" },
  { kind: "del", old_line: 2, new_line: 0, text: "    let x = 1;" },
  { kind: "add", old_line: 0, new_line: 2, text: "    let x = 2;" },
  { kind: "ctx", old_line: 3, new_line: 3, text: "  }" },
  { kind: "ctx", old_line: 10, new_line: 11, text: "  宽度对齐测试" },
  { kind: "del", old_line: 11, new_line: 0, text: "    old line" },
  { kind: "add", old_line: 0, new_line: 12, text: "    new line" },
] as const;

/** Flatten one diff row's leaves into their text, in scene order. */
export function diffRowTexts(row: Node): string[] {
  return row.children.map((leaf) => leaf.props.text as string);
}

/** The golden style snapshot of one text leaf: its text plus the keys the
 * intra-line highlighting stamps (`fg` kind color, `bold` / `underline`). */
export function diffLeafStyle(
  leaf: Node,
): { text: string; fg: unknown; bold: unknown; underline: unknown } {
  return {
    text: leaf.props.text as string,
    fg: leaf.props.fg,
    bold: leaf.props.bold,
    underline: leaf.props.underline,
  };
}

export const selectOptions: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

export const keyBase = { ctrl: false, alt: false, shift: false } as const;

export const tableColumns: TableColumn[] = [
  { key: "name", header: "Name", width: 10 },
  { key: "role", header: "Role", width: 8 },
  { key: "score", header: "Score", width: 5, align: "right" },
];

export const tableRows: (string | number)[][] = [
  ["Ada", "dev", 92],
  ["Grace", "dev", 88],
  ["Linus", "maintainer", 95],
  ["Alan", "researcher", 84],
  ["Margaret", "flight", 91],
  ["Dennis", "systems", 87],
  ["Ken", "systems", 90],
  ["Barbara", "ui", 86],
  ["Edsger", "algorithms", 89],
  ["Donald", "typesetting", 93],
];

export const tableKeyBase = { ctrl: false, alt: false, shift: false } as const;
