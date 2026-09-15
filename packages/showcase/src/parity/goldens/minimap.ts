//! Screen "minimap" — a deep window into a long document.
//!
//! Regime: SCROLL. 300 display rows in a 23-row window with the caret at the end, so
//! firstRow sits far from 0 and the window is clamped to totalRows
//! (core/viewport.ts:161). Anchors: core-canvas-minimap, core-scroll-region.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

const DENSITY = [
  "const value = compute(shape, index);",
  "// a comment line, denser than the code around it",
  "return { value, index };",
  "",
];

const DOC = Array.from({ length: 300 }, (_, index) =>
  String(index + 1).padStart(3, "0") + "  " + DENSITY[index % DENSITY.length]).join("\n") + "\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "minimap",
  regime: "a deep scroll window: 300 rows, the caret at the end, firstRow near totalRows",
  anchors: ["core-canvas-minimap", "core-scroll-region"],
  pending: "the minimap pane does not exist in the app-core yet; its input — the line index's density over a long document — is what this fixture pins into a deep window",
  size: { rows: 24, cols: 80 },
  path: "demo/minimap.ts",
  text: DOC,
  drive: { kind: "app", keys: [key("end", { ctrl: true })] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
