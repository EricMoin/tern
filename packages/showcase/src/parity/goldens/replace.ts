//! Screen "replace" — the replace overlay, opened over the find query.
//!
//! Regime: the SECOND modal on the stack ("REPLACE"), with the query inherited from
//! find and the replacement typed into the overlay's own field. The plan carries both
//! fields, the match count and the preview of what replace-all would write. Anchors:
//! core-radio-search-mode, core-diffview-replace-preview.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = "colour of the colour wheel, and one more colour.\n" +
  "colours beside colours.\n" +
  "nothing else to recolour.\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "replace",
  regime: "the replace modal on top of find: the mode line reads REPLACE, the plan lays the inherited query, the replacement field and the per-match preview out",
  anchors: ["core-radio-search-mode", "core-diffview-replace-preview"],
  pending: null,
  size: { rows: 20, cols: 72 },
  path: "demo/replace.ts",
  text: DOC,
  drive: {
    kind: "app",
    keys: [
      key("f", { ctrl: true }), ...chars("colour"), key("f3"),
      key("h", { ctrl: true }), ...chars("color"),
    ],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
