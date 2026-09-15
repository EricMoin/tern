//! Screen "shell" — the chrome at its narrowest.
//!
//! Regime: CLAMP AND TRUNCATION. The sidebar takes its columns until the editor hits
//! MIN_EDITOR_COLS (core/plan.ts:32 and :376), the editor wraps at eight cells, and
//! the mode line truncates a left segment rather than overlapping the right group
//! (core/plan.ts:359-367) — so the dirty bit is set while its marker has no room.
//! Anchors: core-panels-split, core-statusbar-mode, core-theme-roles,
//! core-focus-routing.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

const ITEMS = [
  "demo/shell.ts", "demo/shell-pane.ts", "demo/shell-keymap.ts",
  "demo/shell-theme.ts", "demo/shell-status.ts", "demo/shell-focus.ts",
];

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "shell",
  regime: "the split at its narrowest: a clamped editor beside the list, a truncated mode line, a dirty document whose marker does not fit",
  anchors: ["core-panels-split", "core-statusbar-mode", "core-theme-roles", "core-focus-routing"],
  pending: null,
  size: { rows: 14, cols: 30 },
  path: "demo/shell-screen.ts",
  text: "pane focus\neditor width\nmode line\ntheme role\nstatus bar\nfocus route\n",
  items: ITEMS,
  sidebarWidth: 22,
  drive: { kind: "app", keys: [key("tab", { ctrl: true }), key("tab", { ctrl: true }), ...chars("x")] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
