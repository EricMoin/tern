//! Layer B's scene: the ScreenPlan as a React element tree.
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
//! WHY createElement AND NOT JSX. The repository contains zero .tsx files and no
//! per-package deno.json can carry React's `react-jsx` setting and Solid's
//! `preserve` + `jsxImportSource` setting at once — the two renderer packages are
//! siblings in one workspace, and a shared `jsx` compilerOption would silently
//! rewrite one of the two element trees. Layer B therefore writes its tree out
//! longhand through `createElement` from the `react` dependency, exactly as
//! `@tern-tui/react`'s own host components do (packages/react/src/primitives.ts:220,
//! :231).
//!
//! TWO FRAMEWORK SEAMS ARE UNREACHABLE FROM THIS SIDE, AND BOTH ARE REPORTED
//! RATHER THAN WORKED AROUND SILENTLY:
//!
//!   * `declareVirtualContent` (the G2 seam layer A uses, scrollview.ts:178) has no
//!     React entry point: `@tern-tui/react` does not re-export it
//!     (packages/react/src/index.ts:144-198) and no host component forwards a ref to
//!     the scene node it materializes — `<ScrollView>` spreads its props into
//!     `createElement(HOST_SCROLL_VIEW, ...)` (data_components.ts:186-192) while
//!     `ScrollViewProps`/`TernNodeProps` declare no `ref` (primitives.ts:82-90). The
//!     view therefore declares no virtual height, and only the plan's own windowed
//!     rows are materialized — which is exactly what the emitter paints.
//!   * `<StatusBar>` (components.ts:492) forwards `left`/`right` to the core factory
//!     as-is (host_config.ts:108-109), and the core factory treats a non-string
//!     segment as a scene `Node` (packages/core/src/statusbar.ts:19-21). A React
//!     ELEMENT is not a `Node`, so an element-valued segment would land in
//!     `Node.create`'s children list as a foreign object. Only string segments are
//!     usable, and a string segment cannot carry the plan's per-segment style hint.
//!     `modeElement` therefore composes the strip's scene shape itself — a row with
//!     `justify_content: "space-between"` and the `status_bar` marker — which is
//!     byte-for-byte what the core `StatusBar` factory builds (statusbar.ts:43-58).

import { createElement, type ReactElement } from "react";
import {
  Box,
  MODAL_Z_INDEX,
  ScrollView,
  Text,
  type ScrollViewProps,
  type ThemeRole,
} from "@tern-tui/react";
import {
  type EditorRegion,
  type ModalRegion,
  type ModeRegion,
  type PlanSpan,
  type ScreenPlan,
  type SidebarRegion,
  type StyleHint,
} from "../../core/plan.ts";
import type { HeadlessApp } from "../../core/state.ts";
import type { HostIO } from "../core/io.ts";
import { useLayerInput, type FrameSink } from "./hooks.ts";

/**
 * The theme role each plan hint paints with. The plan names a SEMANTIC role
 * (`mode`, `dirty`, `sidebar-active`, ...) and never a colour — "the theme owns
 * those" (plan.ts:43-48) — so the mapping from hint to palette role is a rendering
 * decision, and it lives in the layer. It is the same mapping layer A made
 * (layers/core/mount.ts:68-78): the two layers paint one screen, and a divergence
 * here would be a divergence in the app's look, not in its layout.
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
 * to the whole screen. No plan region is invented and none is skipped — a hidden
 * sidebar is absent from `regions`, not empty in the tree, and the mode line mounts
 * from the plan's own mode region.
 */
export function planElement(plan: ScreenPlan): ReactElement {
  const editor = plan.regions.find((region) => region.kind === "editor") as EditorRegion | undefined;
  const mode = plan.regions.find((region) => region.kind === "mode") as ModeRegion | undefined;
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  const panes: ReactElement[] = [];
  for (const region of plan.regions) {
    if (region.kind === "sidebar") panes.push(paneElement(region, "sidebar"));
    else if (region.kind === "editor") panes.push(paneElement(region, "editor"));
  }
  if (modal !== undefined) panes.push(modalElement(modal));
  const body = createElement(
    Box,
    { flex_direction: "row", width: plan.size.cols, height: editor?.height ?? plan.size.rows },
    ...panes,
  );
  const root: ReactElement[] = [body];
  if (mode !== undefined) root.push(modeElement(mode));
  return createElement(
    Box,
    { flex_direction: "column", width: plan.size.cols, height: plan.size.rows },
    ...root,
  );
}

/**
 * One pane: a scroll view whose children are the plan's own window of rows, one
 * styled row each.
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
 */
export function paneElement(region: SidebarRegion | EditorRegion, key: string): ReactElement {
  const props = viewProps(region);
  const rows = region.kind === "editor"
    ? region.rows.map((row, index) => rowElement(row.spans, key + "-" + index + "-" + row.screenRow))
    : region.items.map((item, index) => rowElement(item.spans, key + "-" + index + "-" + item.screenRow));
  return createElement(ScrollView, { ...props, key }, ...rows);
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
export function modalElement(region: ModalRegion): ReactElement {
  const rows = region.rows.map((row, index) => rowElement(row.spans, "modal-" + index));
  return createElement(
    Box,
    {
      key: "modal",
      position: "absolute",
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
      z_index: MODAL_Z_INDEX,
      flex_direction: "column",
    },
    ...rows,
  );
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
 * plan gave them. The strip is the core `StatusBar`'s own scene shape — a single
 * row with `justify_content: "space-between"`, which puts the left group at the
 * left edge and the right group against the right edge, which is exactly where
 * `modeLineSegments` placed them (plan.ts:355-389) — and it carries the
 * compositor-consumed `status_bar` marker the factory stamps (statusbar.ts:48-53),
 * so the strip owns the reserved bottom row like layer A's does. The plan already
 * truncated what does not fit, so the strip never has to.
 */
export function modeElement(region: ModeRegion): ReactElement {
  const groups: ReactElement[] = [];
  const left = region.segments.filter((segment) => segment.align === "left");
  const right = region.segments.filter((segment) => segment.align === "right");
  if (left.length > 0) groups.push(segmentsElement(left, "left"));
  if (right.length > 0) groups.push(segmentsElement(right, "right"));
  return createElement(
    Box,
    {
      flex_direction: "row",
      justify_content: "space-between",
      width: region.width,
      height: 1,
      status_bar: true,
      key: "mode",
    },
    ...groups,
  );
}

/** One row's spans as a scene row: a single styled leaf when one hint covers the
 * row, a flex row of leaves when the hints differ (the sidebar's marker and label,
 * a status group's segments). Empty spans contribute nothing. */
export function rowElement(spans: readonly PlanSpan[], key: string): ReactElement {
  return partsElement(spans.map((span) => ({ text: span.text, hint: span.hint })), key);
}

/** One status group's segments as a scene row. */
function segmentsElement(
  segments: readonly { text: string; hint: StyleHint }[],
  key: string,
): ReactElement {
  return partsElement(segments, key);
}

/** The styled leaves of one row: one leaf when a single hint covers it, a flex row
 * of leaves when the hints differ. Text lives in an explicit `<Text text=...>` —
 * bare string children are rejected by the reconciler (host_config.ts:176-180). */
function partsElement(parts: readonly { text: string; hint: StyleHint }[], key: string): ReactElement {
  const leaves = parts
    .filter((part) => part.text !== "")
    .map((part, index) =>
      createElement(Text, {
        key: key + "#" + index,
        text: part.text,
        role: ROLE_OF_HINT[part.hint],
      })
    );
  if (leaves.length === 0) return createElement(Text, { key: key + "#empty", text: "" });
  if (leaves.length === 1) return leaves[0]!;
  return createElement(Box, { key, flex_direction: "row", height: 1 }, ...leaves);
}

/** What the mounted app needs: the app-core it drives, the host it drains effects
 * through, the plan the frame loop just built, and the frame sink the layer's event
 * source calls to repaint. */
export interface AppProps {
  readonly app: HeadlessApp;
  readonly io: HostIO;
  readonly plan: ScreenPlan;
  readonly frame: FrameSink;
}

/**
 * The mounted application: the layer's event source (hooks.ts) subscribed to the
 * renderer, over the plan's element tree. This is the ONE component `main.ts`
 * renders; the pure tree is `planElement`, which the emitter mounts without any
 * of these props.
 */
export function App(props: AppProps): ReactElement {
  useLayerInput(props.app, props.io, props.frame);
  return planElement(props.plan);
}
