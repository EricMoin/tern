//! The screen fixtures — one per screen of the registry vocabulary
//! (registry-editor.ts:112), in that vocabulary's own order, and the ScreenPlan each
//! one yields from the REAL core.
//!
//! The list is deliberately NOT keyed by a lookup the test has to trust: SCREENS is
//! the registry's own order, FIXTURES follows it, and golden_test.ts asserts the two
//! agree name for name — one screen, one fixture, no copy and no gap.

import type { ScreenPlan } from "../../core/plan.ts";
import type { ScreenId } from "../registry-editor.ts";
import type { Fixture } from "./fixture.ts";
import { FIXTURE as editor, PLAN as editorPlan } from "./editor.ts";
import { FIXTURE as sidebar, PLAN as sidebarPlan } from "./sidebar.ts";
import { FIXTURE as chooser, PLAN as chooserPlan } from "./chooser.ts";
import { FIXTURE as find, PLAN as findPlan } from "./find.ts";
import { FIXTURE as replace, PLAN as replacePlan } from "./replace.ts";
import { FIXTURE as help, PLAN as helpPlan } from "./help.ts";
import { FIXTURE as preview, PLAN as previewPlan } from "./preview.ts";
import { FIXTURE as profile, PLAN as profilePlan } from "./profile.ts";
import { FIXTURE as minimap, PLAN as minimapPlan } from "./minimap.ts";
import { FIXTURE as a11y, PLAN as a11yPlan } from "./a11y.ts";
import { FIXTURE as parity, PLAN as parityPlan } from "./parity.ts";
import { FIXTURE as shell, PLAN as shellPlan } from "./shell.ts";
import { FIXTURE as palette, PLAN as palettePlan } from "./palette.ts";
import { FIXTURE as preferences, PLAN as preferencesPlan } from "./preferences.ts";
import { FIXTURE as theme, PLAN as themePlan } from "./theme.ts";
import { FIXTURE as diff, PLAN as diffPlan } from "./diff.ts";

/** The screen fixtures, in registry order (registry-editor.ts:112). */
export const FIXTURES: readonly Fixture[] = [
  editor, sidebar, chooser, find, replace, help, preview, profile, minimap, a11y, parity, shell,
  palette, preferences, theme, diff,
];

/** The plan each fixture yields from the REAL core, captured at module load. */
export const PLANS: readonly ScreenPlan[] = [
  editorPlan, sidebarPlan, chooserPlan, findPlan, replacePlan, helpPlan,
  previewPlan, profilePlan, minimapPlan, a11yPlan, parityPlan, shellPlan,
  palettePlan, preferencesPlan, themePlan, diffPlan,
];

/** The fixture of one screen, or undefined. */
export const FIXTURE_BY_SCREEN: ReadonlyMap<ScreenId, Fixture> = new Map(
  FIXTURES.map((fixture) => [fixture.screen, fixture]),
);
