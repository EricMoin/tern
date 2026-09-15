//! Screen "chooser" — the option list windowed into its pane.
//!
//! Regime: a SCROLLED window (items 17-25 of 30, the active item inside it) — cells
//! the app's own reducer cannot set, because it clamps the list scroll down to the
//! active index only (core/state.ts:368). This fixture therefore drives buildPlan
//! directly. Anchors: core-select-chooser, core-menu-commands, core-progress-scan,
//! core-spinner-scan.

import type { ScreenPlan } from "../../core/plan.ts";
import { referencePlan, type Fixture } from "./fixture.ts";

const ITEMS = Array.from({ length: 30 }, (_, index) => "src/feature-" + String(index + 1).padStart(2, "0") + ".ts");

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "chooser",
  regime: "a scrolled option window: 8 visible rows cut from a list of 30, the active item inside the window",
  anchors: ["core-select-chooser", "core-menu-commands", "core-progress-scan", "core-spinner-scan"],
  pending: "the chooser overlay does not exist in the app-core yet; the plan cells it will window are driven directly — see the drive below and core/state.ts:368 for why no key sequence reaches them",
  size: { rows: 10, cols: 44 },
  path: "demo/chooser.ts",
  text: "const chosen = await pick();\nexport { chosen };\n",
  items: ITEMS,
  sidebarWidth: 20,
  drive: {
    kind: "plan",
    scroll: 0,
    caret: { row: 0, col: 0 },
    sidebar: { active: 19, scroll: 17 },
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
