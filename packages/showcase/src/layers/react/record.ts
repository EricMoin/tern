//! Regenerate layer B's recorded buffers — the recording recipe of
//! parity/goldens/record.ts, applied to all twelve fixtures in one pass.
//!
//!   deno run --allow-env=NODE_ENV --allow-write packages/showcase/src/layers/react/record.ts
//!
//! WHY A SCRIPT AND NOT TWELVE PASTES. `formatRecordedBuffer` is the convention's one
//! printer (record.ts:74) and this file only feeds it: the same `runLayer` drive the
//! parity gate runs, the same plan fingerprint, the same rows. Transcribing twelve
//! buffers by hand is how a golden stops being a record of what the layer emitted and
//! starts being a record of what someone meant it to emit.
//!
//! IT ALSO GATES THE RECORD ON THE PAINT INVARIANT. The rows this layer records are
//! the ones its React commit painted (frame.ts), and the PLAN side of that frame is
//! layer A's `composeRows` — the printable transcription of the plan's own regions,
//! rows and spans, and the model parity/mount_paint_test.ts holds layer A's scene to.
//! A record is written only when the two agree: layer A's goldens were green while
//! its paint was broken, and this script is where that cannot happen again for this
//! layer.
//!
//! This module is a development tool: nothing in the layer's runtime surface imports
//! it, and it is not part of the package barrel.

import { FIXTURES } from "../../parity/goldens/index.ts";
import { formatRecordedBuffer, goldenModule } from "../../parity/goldens/record.ts";
import { compareFrames, frameFingerprint, planFingerprint, runLayer } from "../../parity/harness.ts";
import { composeRows } from "../core/frame.ts";
import { LAYER } from "./index.ts";

const DIR = "packages/showcase/src/parity/goldens/buffers";
const problems: string[] = [];

for (const fixture of FIXTURES) {
  const run = runLayer(LAYER, fixture);
  if (run.planDiffs.length > 0) {
    problems.push(fixture.screen + ": the layer reached a different plan at " + run.planDiffs[0]!.path);
  }
  if (run.problems.length > 0) {
    problems.push(fixture.screen + ": the frame is not this screen — " + run.problems[0]);
  }
  const painted = compareFrames(composeRows(run.observed), run.frame.rows);
  if (painted.length > 0) {
    const diff = painted[0]!;
    problems.push(fixture.screen + ": the React commit paints a different frame than the plan lays out — row " +
      diff.row + ": planned " + JSON.stringify(diff.expected) + ", painted " + JSON.stringify(diff.actual));
  }

  const source = formatRecordedBuffer({
    screen: fixture.screen,
    layer: LAYER.layer,
    planFingerprint: planFingerprint(run.reference),
    recordedBy: "t13 react layer (layers/react/record.ts)",
    rows: run.frame.rows,
  });
  await Deno.writeTextFile(DIR + "/" + goldenModule(fixture.screen, LAYER.layer), source + "\n");
  console.log("recorded " + fixture.screen + " — " + run.frame.rows.length + " rows, frame " + frameFingerprint(run.frame.rows));
}

if (problems.length > 0) {
  console.error("recording failed:\n" + problems.join("\n"));
  Deno.exit(1);
}
console.log("layer " + LAYER.layer + ": " + FIXTURES.length + " buffers written to " + DIR);
