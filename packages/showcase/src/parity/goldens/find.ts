//! Screen "find" — the find overlay, laid out by the plan.
//!
//! Regime: the find modal pushed over an editor screen. The plan carries the
//! overlay's OWN box — its frame, the live query field, the caret and the match count
//! (plan-modals.ts) — and the editor the query matches against. Anchors:
//! core-toggle-find-case, core-keymap-registry.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = "the total is the sum of every part.\n" +
  "a total we can check against the parts.\n" +
  "no other line mentions it.\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "find",
  regime: "the find modal pushed: the mode line reads FIND, the plan lays the overlay's frame, query field and match count out, and the search session owns the query",
  anchors: ["core-toggle-find-case", "core-keymap-registry"],
  pending: null,
  size: { rows: 24, cols: 80 },
  path: "demo/find.ts",
  text: DOC,
  drive: {
    kind: "app",
    keys: [key("f", { ctrl: true }), ...chars("total"), key("f3"), key("f3", { shift: true })],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
