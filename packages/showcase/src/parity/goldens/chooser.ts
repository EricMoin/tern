//! Screen "chooser" — the file picker: a filtered Select OVERLAY plus the Tree sidebar.
//!
//! Regime: a WINDOWED option list — the picker's Select filters the workspace
//! paths and the plan windows the matches to the overlay's own box, with the
//! file list beside it painted as the framework's Tree. The scenario is driven
//! through the REAL dispatch route (ctrl+p opens the picker, typing filters it,
//! down walks it). Anchors: core-select-chooser, core-tree-file-list,
//! core-menu-commands.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

const ITEMS = Array.from({ length: 30 }, (_, index) => "src/feature-" + String(index + 1).padStart(2, "0") + ".ts");

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "chooser",
  regime: "the file picker: a prefix-filtered Select windowed into its overlay, the Tree sidebar beside it",
  anchors: ["core-select-chooser", "core-tree-file-list", "core-menu-commands"],
  pending: null,
  size: { rows: 14, cols: 50 },
  path: "demo/chooser.ts",
  text: "const chosen = await pick();\nexport { chosen };\n",
  items: ITEMS,
  sidebarWidth: 20,
  drive: {
    kind: "app",
    keys: [key("p", { ctrl: true }), ...chars("src/feature"), key("down"), key("down")],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
