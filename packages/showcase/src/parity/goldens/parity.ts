//! Screen "parity" — the harness's own screen.
//!
//! Regime: the SMALLEST SCREEN a fixture can pin (8x32) with a three-line document
//! and the caret on line 2 — small enough that a recorded buffer is readable by eye,
//! which is what makes it the stub self-test's subject (golden_test.ts). Anchors:
//! core-parity-test-seams, core-renderer-seam, solid-deprecated-renderer.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "parity",
  regime: "the smallest complete plan (8 rows x 32 cells), the caret on the second line",
  anchors: ["core-parity-test-seams", "core-renderer-seam", "solid-deprecated-renderer"],
  pending: null,
  size: { rows: 8, cols: 32 },
  path: "demo/parity.ts",
  text: "alpha\nbeta\ngamma\n",
  drive: { kind: "app", keys: [key("down")] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
