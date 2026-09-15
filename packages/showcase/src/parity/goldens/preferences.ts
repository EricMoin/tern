//! Screen "preferences" — Checkbox, Radio and Toggle in one overlay.
//!
//! Regime: the preferences overlay: soft wrap, tab width, theme and the a11y
//! stream, each row carrying the framework's own glyph vocabulary. Anchors:
//! core-checkbox-preview-sync, core-radio-search-mode, core-toggle-find-case,
//! core-theme-roles.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "preferences",
  regime: "the preferences overlay: soft wrap off, tab width cycled to 8, on its third row",
  anchors: [
    "core-checkbox-preview-sync",
    "core-radio-search-mode",
    "core-toggle-find-case",
    "core-theme-roles",
  ],
  pending: null,
  size: { rows: 22, cols: 66 },
  path: "demo/preferences.ts",
  text: "const tab = 4;\n",
  drive: {
    kind: "app",
    keys: [key("p", { alt: true }), key("enter"), key("down"), key("enter")],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
