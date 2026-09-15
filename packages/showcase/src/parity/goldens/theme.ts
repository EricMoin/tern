//! Screen "theme" — the theme switch and its contrast audit.
//!
//! Regime: a framework setTheme switch (the second choice selected) and the
//! auditTheme report over the resulting palette: the pane's rows are the WCAG
//! findings, not a hand-written list. Anchors: core-contrast-audit,
//! core-theme-roles.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "theme",
  regime: "the theme pane: solarized selected through setTheme and audited against WCAG AA",
  anchors: ["core-contrast-audit", "core-theme-roles"],
  pending: null,
  size: { rows: 26, cols: 72 },
  path: "demo/theme.ts",
  text: "const theme = 'one-dark';\n",
  drive: {
    kind: "app",
    keys: [key("t", { alt: true }), key("down"), key("enter")],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
