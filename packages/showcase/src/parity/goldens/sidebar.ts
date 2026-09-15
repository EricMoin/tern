//! Screen "sidebar" — the file list beside the editor, focused.
//!
//! Regime: THREE regions at once (sidebar, editor, mode line) with the active item
//! marked, and a cursor that belongs to the focused pane — a sidebar focus hides it
//! (core/plan.ts:264). Anchors: core-tree-file-list, core-scroll-virtual-content,
//! core-panels-split.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

const ITEMS = [
  "demo/editor.ts", "demo/sidebar.ts", "demo/chooser.ts", "demo/find.ts", "demo/replace.ts",
  "demo/help.ts", "demo/preview.md", "demo/profile.ts", "demo/minimap.ts",
];

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "sidebar",
  regime: "the file list with a marked item, the editor beside it, and no cursor (the list has the focus)",
  anchors: ["core-tree-file-list", "core-scroll-virtual-content", "core-panels-split"],
  pending: null,
  size: { rows: 16, cols: 64 },
  path: "demo/sidebar.ts",
  text: "one\ntwo\nthree\n",
  items: ITEMS,
  sidebarWidth: 22,
  drive: { kind: "app", keys: [key("tab", { ctrl: true }), key("down", { alt: true }), key("down", { alt: true })] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
