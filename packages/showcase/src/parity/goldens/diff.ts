//! Screen "diff" — the external-change diff, on an explicit command.
//!
//! Regime: the DiffView pane over the buffer and the external text the HOST read
//! (there is no file watcher): the plan's rows are the framework's own unified
//! diff composition. Anchors: core-diffview-replace-preview, core-scroll-region.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "diff",
  regime: "the external-change diff over an unsaved buffer, opened by alt+d",
  anchors: ["core-diffview-replace-preview", "core-scroll-region"],
  pending: null,
  size: { rows: 18, cols: 64 },
  path: "demo/diff.ts",
  text: "alpha\nbeta\ngamma\n",
  external: "alpha\ndelta\ngamma\n",
  drive: { kind: "app", keys: [key("d", { alt: true })] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
