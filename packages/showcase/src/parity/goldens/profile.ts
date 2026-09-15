//! Screen "profile" — the render-profile pane and its frame-time chart.
//!
//! Regime: the profile pane charts the frames the app really built (the clock is
//! injected so the record is stable; the app still times its own buildPlan). A
//! tall wide screen with the overlay over many short rows. Anchors:
//! core-table-profile, core-charts-profile.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = Array.from({ length: 40 }, (_, index) =>
  "frame " + String(index).padStart(2, "0") + "\tplan 0.4" + (index % 10) + "ms\twrap " + (index * 3 % 17) + "\temit 0.0" + (index % 9) + "ms").join("\n") + "\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "profile",
  regime: "the render-profile pane over 40 short rows: a chart of the frames measured in-process",
  anchors: ["core-table-profile", "core-charts-profile"],
  pending: null,
  size: { rows: 30, cols: 100 },
  path: "demo/profile.ts",
  text: DOC,
  clock: [0, 2, 2, 5, 5, 9, 9, 14, 14, 20, 20, 27],
  drive: { kind: "app", keys: [key("r", { alt: true })] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
