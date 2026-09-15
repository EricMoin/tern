//! Layer C's scene: the ScreenPlan as a Solid element tree.
//!
//! WHAT THIS FILE DECIDES, AND WHAT IT REFUSES TO. Nothing about layout. Every
//! cell the tree paints was placed by `core/plan.ts`, the ONE decision point for
//! what is on screen: a region says where its rectangle is, a row says which cells
//! of the region it owns, a span says which cells of that row its text occupies and
//! a mode segment says the cell it starts at (plan.ts:52-121). The tree transcribes
//! those rectangles into scene nodes and sets the props the engine has no default
//! for (see `viewProps` and `modeElement`) — it never recomputes a wrap, a
//! truncation, a marker column or a right-aligned edge, because a second
//! computation is how three renderers drift apart (harness.ts:1-23).
//!
//! WHY ELEMENT FACTORIES AND NOT JSX. The repository contains zero .tsx files and no
//! per-package deno.json can carry React's `react-jsx` setting and Solid's
//! `preserve` + `jsxImportSource` setting at once — the two renderer packages are
//! siblings in one workspace, and a shared `jsx` compilerOption would silently
//! rewrite one of the two element trees. Layer C therefore calls the element
//! factories `@tern-tui/solid` already exposes (`Box`/`Text`/`ScrollView`/
//! `StatusBar`, packages/solid/src/index.ts:594, :616, :952, :813) through
//! `createComponent` (primitives.ts), exactly as layer B writes its tree longhand
//! through `createElement`.
//!
//! ONE ROOT BUILDER, TWO CALLERS. `planRoot` takes the plan as an ACCESSOR and reads
//! it through prop getters, so the same builder serves the pure emitter (`withScene`
//! passes a constant accessor) and the live mount (`mountPlanScene` passes the plan
//! signal's getter, primitives.ts). The renderer reads those getters inside its own
//! `createRenderEffect`s (packages/solid/src/universal.ts:278-299), so a plan write
//! re-runs the emitter in place — the root node is not rebuilt, only re-propped and
//! re-reconciled — and the tree the emitter paints is literally the tree `main.ts`
//! mounts.
//!
//! THE TWO SEAMS THIS LAYER'S TREE USES, AND WHY SOLID CAN.
//!
//!   * G2 — `declareVirtualContent` (packages/core/src/scrollview.ts:178). The
//!     solid factory is not a host component: `ScrollView(props)` RETURNS the
//!     `@tern-tui/core` scene `Node` it built (packages/solid/src/index.ts:952-954),
//!     so the layer holds the view and can declare its whole geometry — which is
//!     exactly what layer B could not do from React, where the host component
//!     materializes the node internally and forwards no ref to it. Both panes declare:
//!     the editor the document's display height, the list its item count, so neither
//!     pane's scroll maths measures the window it happens to have materialized.
//!     The symbol is NOT re-exported by `@tern-tui/solid` (see the layer report and
//!     the registry entry for the gap), so it is imported from `@tern-tui/core` —
//!     the barrel that owns it.
//!   * The mode line IS the framework's own `StatusBar`. `StatusBarSegment` is
//!     `string | Node` (packages/core/src/statusbar.ts:6) and a solid "element" IS a
//!     `@tern-tui/core` scene `Node`, so `left`/`right` accept the styled leaves
//!     this layer builds — where a React ELEMENT is not a `Node` and layer B had to
//!     compose the strip's scene shape by hand.

import {
  Box,
  MODAL_Z_INDEX,
  ScrollView,
  StatusBar,
  Text,
  type Node,
  type ScrollViewProps,
  type StatusBarProps,
  type ThemeRole,
} from "@tern-tui/solid";
import { declareVirtualContent } from "@tern-tui/core";
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
 * those" (plan.ts:43-48) — so the mapping from hint to palette role is a rendering
 * decision, and it lives in the layer. It is the same mapping layers A and B made
 * (layers/core/mount.ts:68-78, layers/react/App.ts:65-75): the three layers paint
 * one screen, and a divergence here would be a divergence in the app's look, not in
 * its layout.
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

/** What a mounted tree needs: the plan it is a pure function of. The Solid layer's
 * event source takes the renderer as an explicit argument (primitives.ts), so unlike
 * layer B's `App` this component carries no props but the plan. `plan` may be a
 * GETTER: solid components run once (`createComponent` is
 * `untrack(() => Comp(props))`, node_modules/solid-js/dist/solid.js:1274-1285), and
 * everything reactive about this tree is reached through the prop accessors
 * `planRoot` installs. */
export interface AppProps {
  readonly plan: ScreenPlan;
}

/** The application component: the plan's tree, built through the framework's
 * `createComponent` by `mountPlanScene` (primitives.ts). It is a pure function of the
 * plan — it subscribes nothing and mutates nothing — so re-running the emitter when
 * the plan changes cannot double-subscribe or leak a side effect. */
export function App(props: AppProps): Node {
  return planRoot(() => props.plan);
}

/**
 * The scene a plan mounts into: a column of the body row and the mode line, sized to
 * the whole screen.
 *
 * THE SIZE AND THE CHILDREN ARE PROP ACCESSORS, and that is the whole reactivity of
 * this layer: the renderer's `spread` reads every prop inside a `createRenderEffect`
 * (packages/solid/src/universal.ts:286-297), so reading the plan inside them is what
 * makes a plan write re-emit. A constant accessor (`() => plan`) is the pure case the
 * emitter mounts; the plan signal's getter is the live one `main.ts` mounts.
 */
export function planRoot(plan: () => ScreenPlan): Node {
  return Box({
    flex_direction: "column",
    get width() {
      return plan().size.cols;
    },
    get height() {
      return plan().size.rows;
    },
    get children() {
      return planChildren(plan());
    },
  });
}

/**
 * The root's children: the body row, then the plan's own mode line when it lays one
 * out. No plan region is invented and none is skipped — a hidden sidebar is absent
 * from `regions`, not empty in the tree.
 */
export function planChildren(plan: ScreenPlan): Node[] {
  const editor = plan.regions.find((region) => region.kind === "editor") as EditorRegion | undefined;
  const mode = plan.regions.find((region) => region.kind === "mode") as ModeRegion | undefined;
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  const panes: Node[] = [];
  for (const region of plan.regions) {
    if (region.kind === "sidebar") panes.push(paneElement(region));
    else if (region.kind === "editor") panes.push(paneElement(region));
  }
  if (modal !== undefined) panes.push(modalElement(modal));
  const body = Box({
    flex_direction: "row",
    width: plan.size.cols,
    height: editor?.height ?? plan.size.rows,
    children: panes,
  });
  const children: Node[] = [body];
  if (mode !== undefined) children.push(modeElement(mode));
  return children;
}

/**
 * One pane: a scroll view whose children are the plan's own window of rows, one
 * styled row each, with the region's WHOLE geometry declared through the G2 seam.
 *
 * THREE PROPS ARE LOAD-BEARING AND NONE OF THEM IS A DEFAULT.
 *
 *   * `flex_direction: "column"` — a box's children run along `flex_direction`,
 *     whose engine default is `row` (src/core/tern-layout/src/style.rs:12-16,
 *     documented at src/core/tern-layout/src/lib.rs:18). Without it the plan's rows
 *     stack SIDEWAYS across the screen instead of down it. Layer A paid for this
 *     once (parity/registry-panes.ts `fix-scroll-view-flow-default-undocumented`);
 *     this layer sets it for the same reason.
 *   * `clip_x: region.x` / `clip_y: region.y` — a clip rect is in SCENE
 *     coordinates (src/core/tern-core/src/scene.rs:565-568,
 *     src/core/tern-components/src/compositor/region.rs:92-122), not in the
 *     declaring view's own box. A view at x=20 that says `clip_x: 0,
 *     clip_width: 60` clips its rows to the 40 columns left of it after its own
 *     origin and silently loses their tails
 *     (`fix-scroll-view-clip-rect-coordinate-space`).
 *   * `scroll_x: 0` / `scroll_y: 0` — the plan hands over the WINDOW
 *     `[firstRow, firstRow + height)` and the view materializes exactly those rows,
 *     so the compositor shifts the content it has and the content it has IS the
 *     window. A view that also offset its materialized window would paint blank
 *     rows (layers/core/mount.ts:31-39).
 *
 * The declaration is what keeps a scroll clamp honest: the declared height is
 * `totalRows` (what the index knew when the window was computed) for the editor and
 * `count` (what the caller offered) for the list — never the number of rows
 * materialized here.
 */
export function paneElement(region: SidebarRegion | EditorRegion): Node {
  const rows = region.kind === "editor"
    ? region.rows.map((row) => rowElement(row.spans))
    : region.items.map((item) => rowElement(item.spans));
  const view = ScrollView({ ...viewProps(region), children: rows });
  declareVirtualContent(view, {
    width: region.width,
    height: region.kind === "editor" ? region.totalRows : region.count,
  });
  return view;
}

/**
 * The modal overlay: the plan's own rectangle, held OUT of the body row's flex flow
 * and stamped with the framework's overlay z-order.
 *
 * TWO PROPS ARE LOAD-BEARING AND NEITHER IS A DEFAULT.
 *
 *   * `position: "absolute"` with `left` and `top` — an absolute child is
 *     out of flex flow and is laid out against its direct parent's padding box
 *     (src/core/tern-layout/src/lib.rs:64-72), so the plan's own cells are where the
 *     overlay lands. Without it the overlay would be a THIRD pane in the body row,
 *     pushing the editor instead of covering it.
 *   * `z_index: MODAL_Z_INDEX` — the compositor's paint order
 *     (packages/core/src/modal.ts:25), so the overlay paints above the panes it
 *     covers. The plan put the region after them in `regions` for the same
 *     reason, and the two agree.
 *
 * The frame, the title, the fields and the key column are TEXT the plan placed
 * (plan-modals.ts): the tree draws no border of its own, because a border the engine
 * drew would be a second decision point about what the overlay looks like.
 */
export function modalElement(region: ModalRegion): Node {
  return Box({
    position: "absolute",
    left: region.x,
    top: region.y,
    width: region.width,
    height: region.height,
    z_index: MODAL_Z_INDEX,
    flex_direction: "column",
    children: region.rows.map((row) => rowElement(row.spans)),
  });
}

/** The engine-facing rectangle of a pane: the plan's own, in scene cells. */
export function viewProps(region: SidebarRegion | EditorRegion): ScrollViewProps {
  return {
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
  };
}

/**
 * The mode line: the plan's segments in their place, split by the alignment the
 * plan gave them, handed to the framework's own `StatusBar`. Its
 * `justify_content: "space-between"` strip puts the left group at the left edge and
 * the right group against the right edge — which is exactly where
 * `modeLineSegments` placed them (plan.ts:355-389) — and it carries the
 * compositor-consumed `status_bar` marker the factory stamps
 * (packages/core/src/statusbar.ts:48-53), so the strip owns the reserved bottom row
 * the way layer A's does. The plan already truncated what does not fit, so the strip
 * never has to.
 */
export function modeElement(region: ModeRegion): Node {
  const left = region.segments.filter((segment) => segment.align === "left");
  const right = region.segments.filter((segment) => segment.align === "right");
  const props: StatusBarProps = { width: region.width, height: 1 };
  if (left.length > 0) props.left = segmentRow(left);
  if (right.length > 0) props.right = segmentRow(right);
  return StatusBar(props);
}

/** One row's spans as a scene row: a single styled leaf when one hint covers the
 * row, a flex row of leaves when the hints differ (the sidebar's marker and label,
 * a status group's segments). Empty spans contribute nothing. */
export function rowElement(spans: readonly PlanSpan[]): Node {
  return partsElement(spans.map((span) => ({ text: span.text, hint: span.hint })));
}

/** One status group's segments as a scene row. */
function segmentRow(segments: readonly { text: string; hint: StyleHint }[]): Node {
  return partsElement(segments);
}

/** The styled leaves of one row: one leaf when a single hint covers it, a flex row
 * of leaves when the hints differ. Text is carried by the `text` prop, never by a
 * bare string child (a string child becomes a `Text` node of its own through the
 * renderer's own `createTextNode`, which would put the row's styling out of reach). */
function partsElement(parts: readonly { text: string; hint: StyleHint }[]): Node {
  const leaves = parts
    .filter((part) => part.text !== "")
    .map((part) => Text({ text: part.text, role: ROLE_OF_HINT[part.hint] }));
  if (leaves.length === 0) return Text({ text: "" });
  if (leaves.length === 1) return leaves[0]!;
  return Box({ flex_direction: "row", height: 1, children: leaves });
}
