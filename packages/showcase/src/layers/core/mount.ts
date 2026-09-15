//! Layer A's scene: the ScreenPlan mounted into the framework's scene tree.
//!
//! This is where the plan becomes real scene nodes — a body row (the file list,
//! then the editor), the mode line as a status bar — and it is the ONLY place in
//! the layer that names a core element. It still decides no layout: every
//! rectangle, row, span and segment comes from the plan, so a mount that moved a
//! region or re-truncated a label would be the second decision point the plan
//! exists to prevent (core/plan.ts:1-13).
//!
//! THE TWO FRAMEWORK SEAMS THIS MOUNT EXISTS TO USE:
//!
//!   * G1 — the windowing seam (registry-editor.ts`fix-textarea-per-keystroke-remeasure`,
//!     the seam the Textarea fix extracted and packages/core/src/textwrap.ts:1-40
//!     exports). The editor's VISIBLE WINDOW is the plan's own editor region, which
//!     core/viewport.ts computed with that seam (wrapLineWithOffsets / WrapCache,
//!     core/viewport.ts:179) — the layer materializes exactly those rows and never
//!     walks the document to find them.
//!   * G2 — `declareVirtualContent` (packages/core/src/scrollview.ts:178). The
//!     materialized rows are one window over a document that may be 300 rows or 100k
//!     (the minimap fixture is 300); declaring `totalRows` is what makes the scroll
//!     maths — maxScroll, scrollTo, scrollBy and the scrollbar (scrollview.ts:334)
//!     — measure the WHOLE document instead of the window it can see.
//!
//! BOTH PANES ARE VIRTUAL. The editor declares the document's display height and
//! the file list declares the list's item count, so neither pane's scroll maths
//! (`scrollTo`, `scrollBy`, `maxScroll`) measures the window it happens to have
//! materialized. The registry's own G2 case is exactly this: a list that declares
//! 10k virtual rows and scrolls to the bottom without walking 10k children
//! (registry-panes.ts, `fix-scroll-region-virtual-content`).
//!
//! THE WINDOW IS THE CONTENT, SO THE OFFSET IS ZERO. Because the plan hands over
//! the window `[firstRow, firstRow + height)` and the view materializes exactly
//! those rows, `scroll_y` is 0: the compositor shifts the content it has, and the
//! content it has IS the window. The declared virtual height is what keeps the
//! clamp honest, and the plan rebuilds the window as the caret moves
//! (core/state.ts:125). A view that both declares virtual content AND offsets its
//! materialized window would paint blank rows; see the layer report for the
//! framework gap that tension names (`renderScrollbar`, scrollview.ts, reads the
//! offset, so a virtualized view cannot yet use the framework's own thumb).

import {
  Box,
  declareVirtualContent,
  getTheme,
  MODAL_Z_INDEX,
  resolveTheme,
  ScrollView,
  StatusBar,
  Text,
  type Node,
  type Theme,
  type ThemeRole,
} from "@tern-tui/core";
import type {
  EditorRegion,
  ModalRegion,
  ModeRegion,
  PlanSpan,
  ScreenPlan,
  SidebarRegion,
  StyleHint,
} from "../../core/plan.ts";

/**
 * The theme role each plan hint paints with. The plan names a SEMANTIC role
 * (`mode`, `dirty`, `sidebar-active`, ...) and never a colour — "the theme owns
 * those" (core/plan.ts:43-48) — so the mapping from hint to palette role is a
 * rendering decision, and it lives here rather than in the plan.
 */
export const ROLE_OF_HINT: Record<StyleHint, ThemeRole> = {
  "text": "secondary",
  "sidebar-item": "secondary",
  "sidebar-active": "primary",
  "sidebar-marker": "success",
  "mode": "primary",
  "path": "muted",
  "dirty": "warning",
  "position": "secondary",
  "count": "muted",
  // The modal overlay's own parts (plan-modals.ts): its frame, its title, a field's
  // label and text, a listed row and the footer line.
  "modal-frame": "muted",
  "modal-title": "primary",
  "modal-label": "muted",
  "modal-field": "secondary",
  "modal-item": "secondary",
  "modal-status": "muted",
};

/**
 * The scene a plan mounts into: a column of the body row and the mode line, sized
 * to the whole screen.
 *
 * No plan region is invented and none is skipped: the sidebar mounts when the plan
 * laid one out (a hidden pane is absent from `regions`, not empty in the scene),
 * and the mode line mounts from the plan's own mode region.
 */
export function mountPlan(plan: ScreenPlan): Node {
  const theme = getTheme();
  const editor = plan.regions.find((region) => region.kind === "editor") as EditorRegion | undefined;
  const mode = plan.regions.find((region) => region.kind === "mode") as ModeRegion | undefined;
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  const body = Box({
    flex_direction: "row",
    width: plan.size.cols,
    height: editor?.height ?? plan.size.rows,
  });
  for (const region of plan.regions) {
    if (region.kind === "sidebar") body.addChild(sidebarScene(region, theme));
    else if (region.kind === "editor") body.addChild(editorScene(region, theme));
  }
  if (modal !== undefined) body.addChild(modalScene(modal, theme));
  const root = Box({ flex_direction: "column", width: plan.size.cols, height: plan.size.rows }, body);
  if (mode !== undefined) root.addChild(modeScene(mode, theme));
  return root;
}

/**
 * The modal overlay: a box at the plan's OWN rectangle, held out of the body's flex
 * flow and stamped with the framework's overlay z-order.
 *
 * TWO PROPS ARE LOAD-BEARING AND NEITHER IS A DEFAULT.
 *
 *   * `position: "absolute"` plus `left` / `top` — an absolute child is out of
 *     flex flow and is laid out against its direct parent's padding box
 *     (src/core/tern-layout/src/lib.rs:64-72), so the plan's own cells are where the
 *     overlay lands. Without it the overlay would be a THIRD pane in the body row,
 *     pushing the editor instead of covering it.
 *   * `z_index: MODAL_Z_INDEX` — the compositor's paint order (packages/core/src/
 *     modal.ts:25), so the overlay paints above the panes it covers. The plan put the
 *     region AFTER them in `regions` for the same reason; the two agree.
 *
 * The frame, the title, the fields and the key column are all TEXT the plan placed
 * (plan-modals.ts) — this mount draws no border of its own, because a border the
 * engine draws would be a second decision point about what the overlay looks like.
 */
export function modalScene(region: ModalRegion, theme: Theme = getTheme()): Node {
  return Box({
    position: "absolute",
    left: region.x,
    top: region.y,
    width: region.width,
    height: region.height,
    z_index: MODAL_Z_INDEX,
    flex_direction: "column",
  }, ...region.rows.map((row) => spanRow(theme, row.spans)));
}

/**
 * The editor: a scroll view whose children are the plan's window rows, with the
 * document's whole geometry declared through the G2 seam.
 *
 * TWO PROPS ARE LOAD-BEARING AND NEITHER IS A DEFAULT.
 *
 *   * `flex_direction: "column"` — a box's children run along `flex_direction`,
 *     whose engine default is `row` (src/core/tern-layout/src/style.rs:12-16,
 *     documented at src/core/tern-layout/src/lib.rs:18). Without it the plan's rows
 *     stack SIDEWAYS across the screen instead of down it.
 *   * `clip_x: region.x` / `clip_y: region.y` — a clip rect is in SCENE
 *     coordinates (src/core/tern-core/src/scene.rs:565-568,
 *     src/core/tern-components/src/compositor/region.rs:92-122), not in the
 *     declaring view's own box. A view at x=20 that says `clip_x: 0,
 *     clip_width: 60` clips its rows to the 40 columns left of it after its own
 *     origin and silently loses their tails.
 *
 * The clip is the region's own rectangle IN SCREEN CELLS — what the compositor
 * intersects with its ancestors' regions — so a row can never paint outside the
 * columns the plan gave the editor, and the declared content height is
 * `totalRows` — what the index knew when the window was computed
 * (`EditorRegion.totalRows`), not the number of rows materialized here.
 *
 * Both props are ALSO framework documentation gaps, recorded at
 * parity/registry-panes.ts (`fix-scroll-view-flow-default-undocumented`,
 * `fix-scroll-view-clip-rect-coordinate-space`); the regression gate for both is
 * parity/mount_paint_test.ts.
 */
export function editorScene(region: EditorRegion, theme: Theme = getTheme()): Node {
  const view = ScrollView({
    flex_direction: "column",
    width: region.width,
    height: region.height,
    clip_x: region.x,
    clip_y: region.y,
    clip_width: region.width,
    clip_height: region.height,
    scroll_x: 0,
    scroll_y: 0,
    showScrollbar: false,
  }, ...region.rows.map((row) => spanRow(theme, row.spans)));
  declareVirtualContent(view, { width: region.width, height: region.totalRows });
  return view;
}

/**
 * The file list: a scroll view over the plan's window of items, one styled row
 * each — the marker span and the label span adjacent, exactly as the plan placed
 * them.
 *
 * The same G2 declaration the editor makes, for the same reason: the list offers
 * `region.count` items (the fixture is 30; the registry's own case is 10k,
 * core-scroll-virtual-content) and materializes only the window, so the declared
 * size is what a scroll clamp measures instead of walking the window it can see.
 *
 * The same two load-bearing props the editor sets, for the same reasons (see
 * `editorScene`): the list's items are one row each, so they need
 * `flex_direction: "column"` (the engine default is `row`,
 * src/core/tern-layout/src/style.rs:16), and the clip rect is the region's own
 * rectangle in SCENE coordinates, so `clip_x` is the region's x — 0 for the list,
 * which hides the defect here but is the same rule.
 */
export function sidebarScene(region: SidebarRegion, theme: Theme = getTheme()): Node {
  const view = ScrollView({
    flex_direction: "column",
    width: region.width,
    height: region.height,
    clip_x: region.x,
    clip_y: region.y,
    clip_width: region.width,
    clip_height: region.height,
    scroll_x: 0,
    scroll_y: 0,
    showScrollbar: false,
  }, ...region.items.map((item) => spanRow(theme, item.spans)));
  declareVirtualContent(view, { width: region.width, height: region.count });
  return view;
}

/**
 * The mode line: the plan's segments split by their own alignment and handed to
 * the framework's `StatusBar`, whose `space-between` strip puts the left group at
 * the left edge and the right group against the right edge — which is exactly
 * where `modeLineSegments` placed them (core/plan.ts:335). The plan already
 * truncated what does not fit, so the strip never has to.
 */
export function modeScene(region: ModeRegion, theme: Theme = getTheme()): Node {
  const left = region.segments.filter((segment) => segment.align === "left");
  const right = region.segments.filter((segment) => segment.align === "right");
  return StatusBar({
    width: region.width,
    height: 1,
    ...(left.length === 0 ? {} : { left: segmentRow(left, theme) }),
    ...(right.length === 0 ? {} : { right: segmentRow(right, theme) }),
  });
}

/** One plan row's spans as a scene row: a single styled leaf when one hint covers
 * the row, a flex row of leaves when the hints differ (the sidebar's marker and
 * label, a status group's segments). Empty spans contribute nothing. */
function spanRow(theme: Theme, spans: readonly PlanSpan[]): Node {
  return leaves(theme, spans.map((span) => ({ text: span.text, hint: span.hint })));
}

/** One status group's segments as a scene row. */
function segmentRow(
  segments: readonly { text: string; hint: StyleHint }[],
  theme: Theme,
): Node {
  return leaves(theme, segments);
}

function leaves(
  theme: Theme,
  parts: readonly { text: string; hint: StyleHint }[],
): Node {
  const nodes = parts
    .filter((part) => part.text !== "")
    .map((part) => Text(resolveTheme(theme, { role: ROLE_OF_HINT[part.hint], text: part.text })));
  if (nodes.length === 0) return Text({ text: "" });
  if (nodes.length === 1) return nodes[0]!;
  return Box({ flex_direction: "row", height: 1 }, ...nodes);
}
