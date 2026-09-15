//! Screen "palette" — the command palette over the real command table.
//!
//! Regime: an auxiliary OVERLAY whose rows are the app's own COMMANDS titles,
//! filtered by a typeahead and walked with up/down — every row names a command
//! the dispatcher really binds, so the palette cannot drift from commands.ts.
//! Anchors: core-menu-commands, core-select-chooser, core-keymap-registry.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "palette",
  regime: "the command palette: the real COMMANDS table as a typeahead-filtered overlay, two rows down",
  anchors: ["core-menu-commands", "core-select-chooser", "core-keymap-registry"],
  pending: null,
  size: { rows: 22, cols: 64 },
  path: "demo/palette.ts",
  text: "export const x = 1;\n",
  drive: {
    kind: "app",
    keys: [
      key("p", { ctrl: true, shift: true }),
      ...chars("Move"),
      key("down"),
      key("down"),
    ],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
