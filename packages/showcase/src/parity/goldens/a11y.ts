//! Screen "a11y" — the opt-in accessibility JSONL stream.
//!
//! Regime: the a11y pane showing the framework A11yStream's own lines — a header
//! and one semantics dump per changed frame — over the plan's regions. Anchors:
//! core-a11y-stream, core-contrast-audit.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "a11y",
  regime: "the a11y stream pane: the framework's versioned JSONL over the plan's own regions",
  anchors: ["core-a11y-stream", "core-contrast-audit"],
  pending: null,
  size: { rows: 20, cols: 76 },
  path: null,
  text: "",
  clock: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6],
  drive: { kind: "app", keys: [key("a", { alt: true })] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
