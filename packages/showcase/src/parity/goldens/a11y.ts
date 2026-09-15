//! Screen "a11y" — the EMPTY document.
//!
//! Regime: the degenerate screen. One empty span, ten filler rows (FILLER_LINE,
//! core/plan.ts:289) and a titleless document (NO_TITLE, core/plan.ts:41) — the shape
//! a semantics walk or a contrast audit meets before anything is typed. Anchors:
//! core-a11y-stream, core-contrast-audit.

import type { ScreenPlan } from "../../core/plan.ts";
import { referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "a11y",
  regime: "an empty document: one empty span, filler rows to the bottom, the [No Name] title",
  anchors: ["core-a11y-stream", "core-contrast-audit"],
  pending: null,
  size: { rows: 12, cols: 40 },
  path: null,
  text: "",
  drive: { kind: "app", keys: [] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
