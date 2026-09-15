//! Tests: editTextareaKey backspace and delete remove a ZWJ family emo.

import { COMBINING_ACUTE, FAMILY_EMOJI } from "./testkit.ts";
import { fakeContentSizes, withFakeAddon } from "./testkit.ts";
import { attachedPanels, diffHunks, mouse } from "./testkit.ts";
import { Box, DIFF_ADD_FG, DIFF_DEL_FG, DiffView, PANEL_DRAG_MIN_SIZE, Panels, Spinner, StatusBar, Text, Textarea, collapsePanel, createRenderer, dragPanels, editTextareaKey, endPanelDrag, expandPanel, focusPanel, name, pasteIntoTextarea, startPanelDrag, tick, togglePanel } from "./index.ts";
import { caretDisplayIn, caretDisplayRow, charAtDisplayCol, currentDisplayCol, displayBase, logicalAtDisplayRow, measureText, offsetOfCol, textareaHeight, textareaWidth, totalDisplayRows, visibleScroll, wrapCount, wrapLineWithOffsets } from "@tern-tui/core";


Deno.test("editTextareaKey backspace and delete remove a ZWJ family emoji whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace before 'b' removes 'b'; backspace before the emoji removes the
  // whole 11-code-unit cluster, never a fragment.
  const bsB = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 13 }),
    {
      name: "backspace",
      ...base,
    },
  );
  if (bsB.lines[0] !== `a${FAMILY_EMOJI}` || bsB.col !== 12) {
    throw new Error(`backspace b = ${JSON.stringify(bsB)}`);
  }
  const bsFam = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 12 }),
    {
      name: "backspace",
      ...base,
    },
  );
  if (bsFam.lines[0] !== "ab" || bsFam.col !== 1) {
    throw new Error(`backspace emoji = ${JSON.stringify(bsFam)}`);
  }
  // Delete at the cluster boundary removes the whole cluster; the cursor
  // stays at the boundary (the following char's start).
  const del = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }),
    {
      name: "delete",
      ...base,
    },
  );
  if (del.lines[0] !== "ab" || del.col !== 1) {
    throw new Error(`delete emoji = ${JSON.stringify(del)}`);
  }
  // A mid-cluster cursor (from caller props) snaps to the boundary after its
  // cluster — where its caret visually paints — so backspace removes the
  // whole cluster.
  const snapped = editTextareaKey(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 5 }),
    {
      name: "backspace",
      ...base,
    },
  );
  if (snapped.lines[0] !== "ab" || snapped.col !== 1) {
    throw new Error(`snapped backspace = ${JSON.stringify(snapped)}`);
  }
});

Deno.test("pasteIntoTextarea before a ZWJ cluster inserts at the cluster boundary", () => {
  // col 1 is the boundary between 'a' and the emoji: the paste lands there.
  const atBoundary = pasteIntoTextarea(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 1 }),
    "X",
  );
  if (atBoundary.lines[0] !== `aX${FAMILY_EMOJI}b`) {
    throw new Error(`value = ${atBoundary.lines[0]}`);
  }
  if (atBoundary.row !== 0 || atBoundary.col !== 2) {
    throw new Error(`row/col = ${atBoundary.row}/${atBoundary.col}`);
  }
  // A mid-cluster cursor snaps to the boundary after its cluster — the paste
  // lands after the emoji, before 'b', never inside the cluster.
  const snapped = pasteIntoTextarea(
    Textarea({ lines: [`a${FAMILY_EMOJI}b`], row: 0, col: 5 }),
    "X",
  );
  if (snapped.lines[0] !== `a${FAMILY_EMOJI}Xb`) {
    throw new Error(`snap value = ${snapped.lines[0]}`);
  }
  if (snapped.row !== 0 || snapped.col !== 13) {
    throw new Error(`snap row/col = ${snapped.row}/${snapped.col}`);
  }
});

Deno.test("editTextareaKey steps over a base+combining sequence as one cluster", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // The line is 'a' + "e\u0301" + 'b'; col is a code-unit index. The
  // combining cluster occupies code units 1..3 (base 'e' at 1, mark at 2);
  // 'b' starts at 3.
  const right1 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 0 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right1.col !== 1) throw new Error(`right over a = ${right1.col}`);
  const right2 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right2.col !== 3) {
    throw new Error(`right over the combining cluster = ${right2.col}`);
  }
  const right3 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }),
    {
      name: "right",
      ...base,
    },
  );
  if (right3.col !== 4) throw new Error(`right over b = ${right3.col}`);
  const left1 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 4 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left1.col !== 3) throw new Error(`left over b = ${left1.col}`);
  const left2 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left2.col !== 1) {
    throw new Error(`left over the combining cluster = ${left2.col}`);
  }
  const left3 = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }),
    {
      name: "left",
      ...base,
    },
  );
  if (left3.col !== 0) throw new Error(`left over a = ${left3.col}`);
});

Deno.test("editTextareaKey backspace and delete remove a base+combining sequence whole", () => {
  const base = { ctrl: false, alt: false, shift: false } as const;
  // Backspace before 'b' removes 'b'; backspace before the cluster removes
  // the whole 2-code-unit base+mark pair, never a fragment.
  const bsB = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 4 }),
    {
      name: "backspace",
      ...base,
    },
  );
  if (bsB.lines[0] !== `a${COMBINING_ACUTE}` || bsB.col !== 3) {
    throw new Error(`backspace b = ${JSON.stringify(bsB)}`);
  }
  const bsSeq = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 3 }),
    {
      name: "backspace",
      ...base,
    },
  );
  if (bsSeq.lines[0] !== "ab" || bsSeq.col !== 1) {
    throw new Error(`backspace combining = ${JSON.stringify(bsSeq)}`);
  }
  // Delete at the cluster boundary removes the whole cluster; the cursor
  // stays at the boundary.
  const del = editTextareaKey(
    Textarea({ lines: [`a${COMBINING_ACUTE}b`], row: 0, col: 1 }),
    {
      name: "delete",
      ...base,
    },
  );
  if (del.lines[0] !== "ab" || del.col !== 1) {
    throw new Error(`delete combining = ${JSON.stringify(del)}`);
  }
});

Deno.test("Spinner renders a determinate bar of filled and empty cells", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  if (bar.type !== "spinner") throw new Error(`type = ${bar.type}`);
  if (bar.props.text !== "▓▓░░") throw new Error(`bar = ${bar.props.text}`);
  const full = Spinner({ value: 10, max: 10, width: 3 });
  if (full.props.text !== "▓▓▓") throw new Error(`full = ${full.props.text}`);
  const none = Spinner({ value: 0, max: 10, width: 3 });
  if (none.props.text !== "░░░") throw new Error(`empty = ${none.props.text}`);
  // Filled cells round up: 3/10 * 4 = 1.2 -> 2 cells.
  const ceilBar = Spinner({ value: 3, max: 10, width: 4 });
  if (ceilBar.props.text !== "▓▓░░") {
    throw new Error(`ceil = ${ceilBar.props.text}`);
  }
});

Deno.test("tick advances the indeterminate frame and wraps", () => {
  const spinner = Spinner({ frames: ["a", "b", "c"] });
  const text0 = spinner.props.text;
  if (text0 !== "a") throw new Error(`frame 0 = ${text0}`);
  const t1 = tick(spinner);
  if (t1 !== "b") throw new Error(`tick 1 = ${t1}`);
  const f1 = spinner.props.frame;
  if (f1 !== 1) throw new Error(`frame = ${f1}`);
  const t2 = tick(spinner);
  if (t2 !== "c") throw new Error(`tick 2 = ${t2}`);
  const t3 = tick(spinner);
  if (t3 !== "a") throw new Error(`tick wrap = ${t3}`);
  const f3 = spinner.props.frame;
  if (f3 !== 3) throw new Error(`frame wrap = ${f3}`);
});

Deno.test("tick on a determinate spinner leaves the bar unchanged", () => {
  const bar = Spinner({ value: 5, max: 10, width: 4 });
  const before = bar.props.text;
  const next = tick(bar);
  if (next !== "▓▓░░") throw new Error(`next = ${next}`);
  if (bar.props.text !== before) {
    throw new Error("determinate bar must not change on tick");
  }
  if (bar.props.frame !== undefined) {
    throw new Error(`frame = ${bar.props.frame}`);
  }
});

Deno.test("StatusBar composes left/center/right segment Text nodes", () => {
  const bar = StatusBar({ left: "L", center: "C", right: "R" });
  if (bar.type !== "status_bar") throw new Error(`type = ${bar.type}`);
  if (bar.props.flex_direction !== "row") {
    throw new Error(`flex_direction = ${bar.props.flex_direction}`);
  }
  if (bar.props.justify_content !== "space-between") {
    throw new Error(`justify_content = ${bar.props.justify_content}`);
  }
  if (bar.props.height !== 1) throw new Error(`height = ${bar.props.height}`);
  const kids = bar.children;
  if (kids.length !== 3) throw new Error(`segments = ${kids.length}`);
  const [left, center, right] = kids;
  if (left === undefined || left.type !== "text" || left.props.text !== "L") {
    throw new Error("left segment must be a Text with the segment text");
  }
  if (center?.props.text !== "C") throw new Error("center segment text");
  if (right?.props.text !== "R") throw new Error("right segment text");
});

Deno.test("StatusBar accepts node segments, omits missing ones, and lifts segment keys out of the strip props", () => {
  const rightNode = Text({ text: "R" });
  const bar = StatusBar({ left: "only", right: rightNode });
  const kids = bar.children;
  if (kids.length !== 2) throw new Error(`segments = ${kids.length}`);
  if (kids[0]?.props.text !== "only") {
    throw new Error(`left text = ${kids[0]?.props.text}`);
  }
  if (kids[1] !== rightNode) {
    throw new Error("a node segment must be used verbatim");
  }
  // left/right are absolute-position inset keywords in tern-layout; the
  // segment keys must never reach the strip's props.
  if ("left" in bar.props || "right" in bar.props || "center" in bar.props) {
    throw new Error(
      `segment keys leaked into strip props: ${JSON.stringify(bar.props)}`,
    );
  }
});

Deno.test("Panels builds header + body panels with an active index", () => {
  const bodyA = Text({ text: "a-body" });
  const bodyB = Text({ text: "b-body" });
  const panels = Panels({
    panels: [{ header: "A", body: bodyA }, { header: "B", body: bodyB }],
    active: 1,
  });
  if (panels.type !== "panels") throw new Error(`type = ${panels.type}`);
  if (panels.props.active !== 1) {
    throw new Error(`active = ${panels.props.active}`);
  }
  if (panels.props.flex_direction !== "column") {
    throw new Error(`direction = ${panels.props.flex_direction}`);
  }
  const kids = panels.children;
  if (kids.length !== 2) throw new Error(`panels = ${kids.length}`);
  const first = kids[0]!;
  const second = kids[1]!;
  if (first.type !== "box") throw new Error(`panel type = ${first.type}`);
  if (first.children.length !== 2) {
    throw new Error("panel A must have header + body");
  }
  if (first.children[0]?.props.text !== "A") {
    throw new Error(`header = ${first.children[0]?.props.text}`);
  }
  if (first.children[1] !== bodyA) {
    throw new Error("panel A body must be the given node");
  }
  if (second.children[1] !== bodyB) {
    throw new Error("panel B body must be the given node");
  }
  // The active panel's header is bold; inactive headers are not.
  if (second.children[0]?.props.bold !== true) {
    throw new Error("active header must be bold");
  }
  if (first.children[0]?.props.bold !== false) {
    throw new Error("inactive header must not be bold");
  }
});

Deno.test("Panels builds collapsed panels header-only", () => {
  const body = Text({ text: "x" });
  const panels = Panels({ panels: [{ header: "A", body, collapsed: true }] });
  const panel = panels.children[0]!;
  if (panel.children.length !== 1) {
    throw new Error(`collapsed children = ${panel.children.length}`);
  }
  if (panel.children[0]?.props.text !== "A") {
    throw new Error("header must be retained");
  }
});

Deno.test("togglePanel collapses and restores a panel body", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  const collapsed = togglePanel(panels, 0);
  if (collapsed !== true) throw new Error("toggle must collapse");
  const collapsedCount = panel.children.length;
  if (collapsedCount !== 1) {
    throw new Error(`collapsed children = ${collapsedCount}`);
  }
  if (body.attached) throw new Error("removed body must be detached");
  const expanded = togglePanel(panels, 0);
  if (expanded !== false) throw new Error("toggle must expand");
  const expandedCount = panel.children.length;
  if (expandedCount !== 2) {
    throw new Error(`expanded children = ${expandedCount}`);
  }
  if (panel.children[1] !== body) {
    throw new Error("restored body must be the same node");
  }
});

Deno.test("collapsePanel and expandPanel are idempotent and ignore bad indices", () => {
  const body = Text({ text: "body" });
  const panels = Panels({ panels: [{ header: "A", body }] });
  const panel = panels.children[0]!;
  collapsePanel(panels, 0);
  collapsePanel(panels, 0);
  const afterCollapse = panel.children.length;
  if (afterCollapse !== 1) {
    throw new Error(`double collapse must be a no-op (${afterCollapse})`);
  }
  expandPanel(panels, 0);
  expandPanel(panels, 0);
  const afterExpand = panel.children.length;
  if (afterExpand !== 2) {
    throw new Error(`double expand must be a no-op (${afterExpand})`);
  }
  collapsePanel(panels, 99);
  const afterBad = panel.children.length;
  if (afterBad !== 2) {
    throw new Error(`collapsing a bad index must be a no-op (${afterBad})`);
  }
});

Deno.test("focusPanel moves the active index and restyles headers", () => {
  const panels = Panels({
    panels: [{ header: "A", body: Text({ text: "1" }) }, {
      header: "B",
      body: Text({ text: "2" }),
    }],
  });
  const initialActive = panels.props.active;
  if (initialActive !== 0) throw new Error(`initial active = ${initialActive}`);
  focusPanel(panels, 1);
  const newActive = panels.props.active;
  if (newActive !== 1) throw new Error(`active after focus = ${newActive}`);
  if (panels.children[1]?.children[0]?.props.bold !== true) {
    throw new Error("new active header must be bold");
  }
  if (panels.children[0]?.children[0]?.props.bold !== false) {
    throw new Error("old active header must be un-bolded");
  }
});

Deno.test("Panels defaults to a 1-cell gutter gap (an explicit gap wins)", () => {
  const a = Panels({
    panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
  });
  if (a.props.gap !== 1) throw new Error(`default gap = ${a.props.gap}`);
  const b = Panels({
    panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
    gap: 0,
  });
  if (b.props.gap !== 0) throw new Error(`explicit gap = ${b.props.gap}`);
});

Deno.test("startPanelDrag grabs a gutter on down_left and dragPanels mutates the adjacent pane's flex_basis", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();

    // Press on gutter 0 (row 3): between panel A (rows 0-2) and panel B.
    const started = startPanelDrag(panels, mouse("down_left", 0, 3));
    if (
      started === null || started.index !== 0 || started.direction !== "column"
    ) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }

    // Drag down 1 cell: panel A's flex_basis grows 3 -> 4.
    const r1 = dragPanels(panels, mouse("drag_left", 0, 4));
    if (r1 === null || r1.flex_basis !== 4 || r1.index !== 0) {
      throw new Error(`drag 1 = ${JSON.stringify(r1)}`);
    }
    if (panels.children[0]!.props.flex_basis !== 4) {
      throw new Error(
        `flex_basis after drag = ${panels.children[0]!.props.flex_basis}`,
      );
    }

    // Drag down 2 more: 4 -> 6.
    const r2 = dragPanels(panels, mouse("drag_left", 0, 6));
    if (r2 === null || r2.flex_basis !== 6) {
      throw new Error(`drag 2 = ${JSON.stringify(r2)}`);
    }

    // A drag on a gutter further down targets its own pane (gutter 1 -> pane B).
    const r3 = dragPanels(panels, mouse("drag_left", 0, 7));
    if (r3 === null || r3.index !== 0) {
      throw new Error(`drag 3 must stay on pane 0: ${JSON.stringify(r3)}`);
    }

    // up_left ends the drag; a later drag_left is inert.
    const ended = endPanelDrag(panels);
    if (ended === null || ended.index !== 0) {
      throw new Error(`ended = ${JSON.stringify(ended)}`);
    }
    if (dragPanels(panels, mouse("drag_left", 0, 8)) !== null) {
      throw new Error("a drag after up_left must be a no-op");
    }
  });
});

Deno.test("dragPanels clamps the pane's flex_basis to its min size", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    // Drag far above the split: 3 - 20 = -17 -> clamps to the default min (1).
    const r = dragPanels(panels, mouse("drag_left", 0, -17));
    if (r === null || r.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`clamped basis = ${JSON.stringify(r)}`);
    }
    if (panels.children[0]!.props.flex_basis !== PANEL_DRAG_MIN_SIZE) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
  });
});

Deno.test("dragPanels clamps to the space the neighbor pane's min size leaves", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // The stack is 9 tall with a 1-cell gutter: pane A can grow to
    // 9 - 1 (gutter) - 1 (panel B's min) = 7.
    if (startPanelDrag(panels, mouse("down_left", 0, 3)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, 99));
    if (r === null || r.flex_basis !== 7) {
      throw new Error(`upper-clamped basis = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("a declared min_height prop raises the pane's drag floor", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box(), min_height: 4 }, {
        header: "B",
        body: Box(),
      }],
      direction: "column",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 60, height: 7 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 4 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // Gutter 0 = row 4 (panel A rows 0-3).
    if (startPanelDrag(panels, mouse("down_left", 0, 4)) === null) {
      throw new Error("down_left on gutter 0 must start a drag");
    }
    const r = dragPanels(panels, mouse("drag_left", 0, -50));
    if (r === null || r.flex_basis !== 4) {
      throw new Error(`min_height floor = ${JSON.stringify(r)}`);
    }
  });
});

Deno.test("row stacks resize by column and use min_width", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [
        { header: "A", body: Box(), min_width: 2 },
        { header: "B", body: Box() },
      ],
      direction: "row",
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.handle, { width: 7, height: 20 });
    fakeContentSizes.set(panels.children[0]!.handle, { width: 3, height: 20 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 2, height: 20 });
    // Gutter 0 = column 3 (panel A columns 0-2); the drag axis is the column.
    const started = startPanelDrag(panels, mouse("down_left", 3, 0));
    if (
      started === null || started.direction !== "row" || started.index !== 0
    ) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }
    const r = dragPanels(panels, mouse("drag_left", 5, 0)); // +2 columns
    if (r === null || r.flex_basis !== 5) {
      throw new Error(`row drag = ${JSON.stringify(r)}`);
    }
    if (panels.children[0]!.props.flex_basis !== 5) {
      throw new Error(`flex_basis = ${panels.children[0]!.props.flex_basis}`);
    }
    // Far left: 5 - 20 = -15 -> clamps to min_width 2.
    const clamped = dragPanels(panels, mouse("drag_left", -15, 0));
    if (clamped === null || clamped.flex_basis !== 2) {
      throw new Error(`row min_width clamp = ${JSON.stringify(clamped)}`);
    }
  });
});

Deno.test("startPanelDrag ignores presses off the gutters and on detached trees", () => {
  withFakeAddon(() => {
    const { panels } = attachedPanels();
    // Inside panel A (row 1), inside panel C (row 8), and outside the stack
    // (row 20) are not gutters.
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a press inside a panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 8)) !== null) {
      throw new Error("a press inside the last panel must not start a drag");
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 20)) !== null) {
      throw new Error("a press beyond the stack must not start a drag");
    }
    // Non-down_left events never start a drag.
    if (startPanelDrag(panels, mouse("drag_left", 0, 3)) !== null) {
      throw new Error("drag_left must not start a drag");
    }
    // A detached tree has no geometry: contentSize throws, so no drag.
    const detached = Panels({
      panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
    });
    if (startPanelDrag(detached, mouse("down_left", 0, 1)) !== null) {
      throw new Error("a detached tree must not start a drag");
    }
    // endPanelDrag without an active drag is a no-op.
    if (endPanelDrag(panels) !== null) {
      throw new Error("end without a drag must return null");
    }
  });
});

Deno.test("the gutter accounts for an explicit gap", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const panels = Panels({
      panels: [{ header: "A", body: Box() }, { header: "B", body: Box() }],
      direction: "column",
      gap: 3,
    });
    renderer.root.addChild(panels);
    fakeContentSizes.set(panels.children[0]!.handle, { width: 60, height: 2 });
    fakeContentSizes.set(panels.children[1]!.handle, { width: 60, height: 2 });
    // With gap 3 the gutter spans rows 2-4 (panel A rows 0-1).
    for (const row of [2, 3, 4]) {
      if (startPanelDrag(panels, mouse("down_left", 0, row)) === null) {
        throw new Error(`row ${row} is inside the 3-cell gutter`);
      }
      endPanelDrag(panels);
    }
    if (startPanelDrag(panels, mouse("down_left", 0, 1)) !== null) {
      throw new Error("row 1 is inside panel A, not the gutter");
    }
  });
});

Deno.test("DiffView composes a column of gutter/marker/content rows per hunk line", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  if (diff.type !== "diff") throw new Error(`type = ${diff.type}`);
  if (diff.props.flex_direction !== "column") {
    throw new Error(`flex_direction = ${diff.props.flex_direction}`);
  }
  // The line model is JS bookkeeping, never a scene prop.
  if ("hunks" in diff.props) {
    throw new Error("hunks must not reach the scene props");
  }
  const rows = diff.children;
  if (rows.length !== diffHunks.length) {
    throw new Error(`rows = ${rows.length}`);
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      row === undefined || row.type !== "box" ||
      row.props.flex_direction !== "row"
    ) {
      throw new Error(`row ${i} must be a row box`);
    }
    const kids = row.children;
    if (kids.length !== 3) throw new Error(`row ${i} must have 3 text leaves`);
    const [gutter, marker, content] = kids;
    if (
      gutter?.type !== "text" || marker?.type !== "text" ||
      content?.type !== "text"
    ) {
      throw new Error(`row ${i} leaves must be text`);
    }
  }
});

Deno.test("DiffView gutter right-aligns old/new line numbers and blanks absent sides", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const gutter = (i: number): string => rows[i]?.children[0]?.props.text ?? "";
  // Width-2 columns: old and new, right-aligned, joined by a space.
  if (gutter(0) !== " 1  1") {
    throw new Error(`gutter(0) = ${JSON.stringify(gutter(0))}`);
  }
  if (gutter(1) !== " 2   ") {
    throw new Error(`gutter(1) = ${JSON.stringify(gutter(1))}`);
  }
  if (gutter(2) !== "    2") {
    throw new Error(`gutter(2) = ${JSON.stringify(gutter(2))}`);
  }
  if (gutter(3) !== " 3  3") {
    throw new Error(`gutter(3) = ${JSON.stringify(gutter(3))}`);
  }
  // Two-digit numbers widen neither column beyond the widest number.
  if (gutter(4) !== "10 11") {
    throw new Error(`gutter(4) = ${JSON.stringify(gutter(4))}`);
  }
  if (gutter(5) !== "11   ") {
    throw new Error(`gutter(5) = ${JSON.stringify(gutter(5))}`);
  }
  if (gutter(6) !== "   12") {
    throw new Error(`gutter(6) = ${JSON.stringify(gutter(6))}`);
  }
});

Deno.test("DiffView styles markers and content per kind: add green, del red, ctx dim", () => {
  const diff = DiffView({ hunks: [...diffHunks] });
  const rows = diff.children;
  const markerText = (i: number): string =>
    rows[i]?.children[1]?.props.text ?? "";
  const markerFg = (i: number): unknown => rows[i]?.children[1]?.props.fg;
  const contentFg = (i: number): unknown => rows[i]?.children[2]?.props.fg;
  const contentDim = (i: number): unknown => rows[i]?.children[2]?.props.dim;
  // Markers: ctx is a space, del is '-', add is '+'.
  if (markerText(0) !== " ") {
    throw new Error(`ctx marker = ${JSON.stringify(markerText(0))}`);
  }
  if (markerText(1) !== "-") {
    throw new Error(`del marker = ${JSON.stringify(markerText(1))}`);
  }
  if (markerText(2) !== "+") {
    throw new Error(`add marker = ${JSON.stringify(markerText(2))}`);
  }
  // Marker + content carry the kind color; ctx is dimmed, no fg.
  if (markerFg(1) !== DIFF_DEL_FG) {
    throw new Error(`del marker fg = ${markerFg(1)}`);
  }
  if (contentFg(1) !== DIFF_DEL_FG) {
    throw new Error(`del content fg = ${contentFg(1)}`);
  }
  if (markerFg(2) !== DIFF_ADD_FG) {
    throw new Error(`add marker fg = ${markerFg(2)}`);
  }
  if (contentFg(2) !== DIFF_ADD_FG) {
    throw new Error(`add content fg = ${contentFg(2)}`);
  }
  if (markerFg(0) !== undefined) {
    throw new Error(`ctx marker must have no fg (${markerFg(0)})`);
  }
  if (contentDim(0) !== true) {
    throw new Error(`ctx content must be dimmed (${contentDim(0)})`);
  }
  if (contentDim(2) !== undefined) {
    throw new Error(`add content must not be dimmed`);
  }
  // The content leaf carries the line text verbatim (multi-width included).
  if (rows[4]?.children[2]?.props.text !== "  宽度对齐测试") {
    throw new Error(
      `multi-width content = ${
        JSON.stringify(rows[4]?.children[2]?.props.text)
      }`,
    );
  }
});

Deno.test("DiffView passes scroll_x/scroll_y to the root and wrap to the content leaves", () => {
  const diff = DiffView({
    hunks: [...diffHunks],
    scroll_x: 4,
    scroll_y: 7,
    wrap: false,
  });
  if (diff.props.scroll_x !== 4) {
    throw new Error(`scroll_x = ${diff.props.scroll_x}`);
  }
  if (diff.props.scroll_y !== 7) {
    throw new Error(`scroll_y = ${diff.props.scroll_y}`);
  }
  for (let i = 0; i < diff.children.length; i++) {
    if (diff.children[i]?.children[2]?.props.wrap !== false) {
      throw new Error(`row ${i} content must carry wrap=false`);
    }
  }
  // Without `wrap`, the content leaves carry no wrap prop (engine default).
  const unwrapped = DiffView({ hunks: [...diffHunks] });
  for (let i = 0; i < unwrapped.children.length; i++) {
    if ("wrap" in (unwrapped.children[i]?.children[2]?.props ?? {})) {
      throw new Error(`row ${i} content must not carry wrap when unset`);
    }
  }
});

Deno.test("textarea windowing seam is public and matches the composed window", () => {
  // G1: the display-row seam is public API — an application reuses the
  // framework's own row math instead of re-deriving it (imported from the
  // package root, so this fails on a tree where the seam is module-private).
  if (textareaWidth({ width: 12 }) !== 12 || textareaWidth({ width: 0 }) !== null) {
    throw new Error("textareaWidth");
  }
  if (textareaHeight({ height: 4 }) !== 4 || textareaHeight({}) !== null) {
    throw new Error("textareaHeight");
  }
  // The wrapping exports keep resolving through the same entry point.
  if (wrapLineWithOffsets("one two three", 6).length !== 3 || measureText("ab", 6).rows !== 1) {
    throw new Error("wrapping exports");
  }
  const lines = ["one two three", "short"];
  if (wrapCount("one two three", 6) !== 3 || displayBase(lines, 1, 6) !== 3) {
    throw new Error("row weights");
  }
  if (totalDisplayRows(lines, 6) !== 4 || offsetOfCol("one two three", 5, 6) !== 1) {
    throw new Error("row totals");
  }
  if (caretDisplayRow(lines, 1, 2, 6) !== 3) throw new Error("caretDisplayRow");
  if (caretDisplayIn("one two three", 5, 1, 6).start !== 4) throw new Error("caretDisplayIn");
  if (currentDisplayCol(lines, 0, 5, 6) !== 1) throw new Error("currentDisplayCol");
  if (charAtDisplayCol("one two three", 1, 1, 6) !== 5) throw new Error("charAtDisplayCol");
  const at = logicalAtDisplayRow(lines, 3, 6);
  if (at.row !== 1 || at.offset !== 0) throw new Error("logicalAtDisplayRow");
  if (visibleScroll(lines, 1, 2, 6, 2, 0) !== 2 || visibleScroll(lines, 1, 2, 6, null, 0) !== 0) {
    throw new Error("visibleScroll");
  }
  // The seam is exactly the window Textarea composes: scroll 2 + height 2.
  if (Textarea({ lines, width: 6, height: 2, row: 1, col: 2 }).children.length !== 2) {
    throw new Error("composed window");
  }
});
