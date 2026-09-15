//! Screen "editor" — the canonical editor screen: a long line, a caret parked on
//! it, a dirty mode line, the line-number gutter and a two-buffer TAB STRIP.
//!
//! Regime: ordinary text, the gutter toggled through the real key route, a second
//! buffer opened and typed into, switched away from and back, and soft wrap toggled
//! off last. Anchors: core-caret-display, core-display-rows, core-scroll-region,
//! core-tabs-documents.

import type { ScreenPlan } from "../../core/plan.ts";
import { chars, key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = "// the editor screen: one long line that has to wrap, and one short one.\n" +
  "export const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n" +
  "export { total };\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "editor",
  regime: "gutter on, a two-buffer tab strip with the second buffer dirty, soft wrap off, and the caret back on the first buffer's wrapped line",
  anchors: ["core-caret-display", "core-display-rows", "core-scroll-region", "core-tabs-documents"],
  pending: null,
  size: { rows: 24, cols: 80 },
  path: "demo/editor.ts",
  text: DOC,
  drive: {
    kind: "app",
    keys: [
      key("down"), key("end"), ...chars(" // note"),
      key("l", { alt: true }),
      key("n", { ctrl: true, alt: true }), ...chars("scratch"),
      key("left", { ctrl: true, alt: true }),
      key("z", { alt: true }),
    ],
  },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
