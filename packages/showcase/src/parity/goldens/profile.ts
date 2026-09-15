//! Screen "profile" — a tall, wide screen over many short rows.
//!
//! Regime: SIZE. 29 editor rows at 100 columns over 40 short rows, so the mode line's
//! right group sits far from its left group. Anchors: core-table-profile,
//! core-charts-profile.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = Array.from({ length: 40 }, (_, index) =>
  "frame " + String(index).padStart(2, "0") + "\tplan 0.4" + (index % 10) + "ms\twrap " + (index * 3 % 17) + "\temit 0.0" + (index % 9) + "ms").join("\n") + "\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "profile",
  regime: "a tall wide screen: 29 editor rows over 40 short rows, mode-line segments at both edges",
  anchors: ["core-table-profile", "core-charts-profile"],
  pending: "the render-profile pane does not exist in the app-core yet; the regime it reads — many short rows on a tall screen, with the cost samples the plan reports in stats — is what this fixture pins",
  size: { rows: 30, cols: 100 },
  path: "demo/profile.ts",
  text: DOC,
  drive: { kind: "app", keys: [key("down"), key("down"), key("down")] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
