//! Screen "help" — the help overlay, laid out by the plan.
//!
//! Regime: the help modal pushed from its own binding (f1). The plan carries the
//! overlay's rows — the shortcuts the framework's own `Keymap` registry describes
//! (core/keymap.ts:132), windowed into the box the plan lays out. Anchors:
//! core-keymap-registry, core-keymap-help.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "help",
  regime: "the help modal pushed by f1: the mode line reads HELP and the plan lists the described shortcuts the keymap actually dispatches",
  anchors: ["core-keymap-registry", "core-keymap-help"],
  pending: null,
  size: { rows: 18, cols: 60 },
  path: "demo/help.ts",
  text: "export function help(): void {}\nexport const shortcuts = 30;\n",
  drive: { kind: "app", keys: [key("f1")] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
