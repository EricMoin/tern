//! Regenerate layer A's recorded buffers — the recording recipe of
//! parity/goldens/record.ts, applied to all twelve fixtures in one pass.
//!
//!   deno run --allow-env=NODE_ENV --allow-write packages/showcase/src/layers/core/record.ts
//!
//! WHY A SCRIPT AND NOT TWELVE PASTES. `formatRecordedBuffer` is the convention's
//! one printer (record.ts:74) and this file only feeds it: the same `runLayer` drive
//! the parity gate runs, the same plan fingerprint, the same rows. Transcribing
//! twelve buffers by hand is how a golden stops being a record of what the layer
//! emitted and starts being a record of what someone meant it to emit.
//!
//! IT ALSO SMOKES THE SCENE PATH. For each fixture the REAL scene `mountPlan` builds
//! is attached to a renderer with the fake addon installed, so a mount that throws or
//! a scene that cannot materialize is reported here — a recording run that fails is a
//! failure, not a buffer full of rows nothing ever painted (see the layer report for
//! why the fake's mini-compositor cannot review the scene's LAYOUT: fakes.ts:372-470).
//!
//! This module is a development tool: nothing in the layer's runtime surface imports
//! it, and it is not part of the package barrel.

import { createRenderer } from "@tern-tui/core";
import { withFakeAddon } from "../../../../core/src/testkit/fakes.ts";
import { FIXTURES } from "../../parity/goldens/index.ts";
import { formatRecordedBuffer, goldenModule } from "../../parity/goldens/record.ts";
import { frameFingerprint, planFingerprint, runLayer } from "../../parity/harness.ts";
import { LAYER } from "./index.ts";
import { mountPlan } from "./mount.ts";

const DIR = "packages/showcase/src/parity/goldens/buffers";
const problems: string[] = [];

for (const fixture of FIXTURES) {
  const run = runLayer(LAYER, fixture);
  if (run.planDiffs.length > 0) problems.push(fixture.screen + ": the layer reached a different plan at " + run.planDiffs[0]!.path);
  if (run.problems.length > 0) problems.push(fixture.screen + ": the frame is not this screen — " + run.problems[0]);

  try {
    withFakeAddon(() => {
      const renderer = createRenderer();
      try {
        renderer.root.addChild(mountPlan(run.observed));
        renderer.snapshotFrame(fixture.size.cols, fixture.size.rows);
      } finally {
        renderer.destroy();
      }
    });
  } catch (error) {
    problems.push(fixture.screen + ": the scene did not mount — " + String(error));
  }

  const source = formatRecordedBuffer({
    screen: fixture.screen,
    layer: LAYER.layer,
    planFingerprint: planFingerprint(run.reference),
    recordedBy: "t12a core layer (layers/core/record.ts)",
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
