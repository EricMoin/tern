//! Screen "preview" — prose, wide glyphs and a fence, in a narrow editor.
//!
//! Regime: TEXT WIDTH. The plan's span widths come from cellWidth
//! (core/viewport.ts:257), which is NOT the code-unit length — a CJK glyph is one
//! code point and two cells — so a layer that measures its own text in code units
//! diverges here and nowhere else. Anchors: core-markdown-preview,
//! core-stream-tail, core-checkbox-preview-sync.

import type { ScreenPlan } from "../../core/plan.ts";
import { key, referencePlan, type Fixture } from "./fixture.ts";

const DOC = "# notes\n" +
  "\n" +
  "the quick brown fox jumps over the lazy dog and then keeps running past the margin\n" +
  "\n" +
  "| \u9805\u76ee | \u5024 | \u5099\u8003 |\n" +
  "\n" +
  "```ts\n" +
  "const x = 1;\n" +
  "```\n";

/** The screen's fixed scenario. */
export const FIXTURE: Fixture = {
  screen: "preview",
  regime: "wrapped prose plus a CJK row: display cells, not code units",
  anchors: ["core-markdown-preview", "core-stream-tail", "core-checkbox-preview-sync"],
  pending: "the preview pane does not exist in the app-core yet; the plan regime it depends on — wrapped prose and wide glyphs measured in cells — is what this fixture pins",
  size: { rows: 22, cols: 56 },
  path: "demo/notes.md",
  text: DOC,
  drive: { kind: "app", keys: [key("down"), key("home")] },
};

/** The ScreenPlan the REAL core produced for {@link FIXTURE}: one HeadlessApp
 * instance, driven through the scenario above, captured at {@link FIXTURE}.size.
 * No layer is involved — this is what every layer is held to. */
export const PLAN: ScreenPlan = referencePlan(FIXTURE);
