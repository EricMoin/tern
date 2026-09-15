//! The per-(screen x layer) golden test — the parity gate.
//!
//! WHAT THIS FILE DECIDES. For every (screen x layer) pair whose layer has LANDED,
//! the layer's plan must be the reference ScreenPlan and its emitted buffer must be
//! the recorded one — or the run FAILS, naming the layer and the screen. A pair with
//! no layer behind it is not a pair at all: nothing is silently skipped, because a
//! skip is exactly how "no layer paints anything yet" would masquerade as parity.
//!
//! WHERE THE PAIRS COME FROM: goldens/landed.ts, a STATIC registry — probing for a
//! layer module with a dynamic import() is impossible under the canonical
//! --allow-env-only run, because Deno gates dynamic module resolution behind
//! --allow-read (landed.ts carries the measured error). A landed layer declares its
//! module and a buffer for every screen; that declaration is what this file reads.
//!
//! THE SELF-TEST IS THE HARNESS'S OWN PROOF. A harness whose failure mode has never
//! been executed is a described capability, not a mechanism. So this file runs a
//! deliberately trivial STUB layer (stub-layer.ts) through the SAME
//! `assertLayerParity` the real goldens use, and then:
//!
//!   * deletes the record      -> the run must FAIL (a missing golden is not a skip);
//!   * bends the layer's plan  -> the run must FAIL, naming the differing field;
//!   * INJECTS A DIVERGENCE    -> the run must FAIL, and the message must name the
//!     diverging layer AND the screen (harness.ts:injectDivergence).
//!
//! The passing run really executes both sides: the clean stub passes the assertion
//! and the injected stub throws it. That throw, left uncaught, is the non-zero exit;
//! this file catches it and asserts on the message, because one `deno test`
//! invocation of the parity directory must exit 0 (a second, deliberately failing
//! invocation would need --allow-run, which the canonical run does not grant).
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/parity/

import type { PlanRegion, ScreenPlan } from "../core/plan.ts";
import type { ScreenId } from "./registry-editor.ts";
import { FIXTURE_BY_SCREEN, FIXTURES, PLANS } from "./goldens/index.ts";
import { LANDED } from "./goldens/landed.ts";
import {
  formatRecordedBuffer, GOLDEN_DIR, goldenImportPath, goldenModule, type RecordedBuffer,
} from "./goldens/record.ts";
import {
  assertLayerParity, compareFrames, frameFingerprint, injectDivergence, landedBuffer, LayerDivergenceError,
  planFingerprint, planKey, referencePlan, runLayer, type RendererLayer,
} from "./harness.ts";
import { LAYERS, SCREENS, type LayerId } from "./registry-editor.ts";
import { REGISTRY } from "./registry-shell.ts";
import { stubLayer } from "./stub-layer.ts";

/** Fail unless `condition`. */
function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(what);
}

/** The (screen x layer) key of the recorded-buffer map. */
function pair(screen: ScreenId, layer: LayerId): string {
  return screen + "/" + layer;
}

/** The first line of a failure message — the one that names the layer and screen. */
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/**
 * The cells a plan does not account for, or accounts for twice: `buildPlan` cuts
 * the screen in three (core/plan.ts:194), so a fixture plan must cover every cell
 * exactly once.
 *
 * A MODAL REGION IS EXEMPT FROM THE TILING RULE AND CHECKED AGAINST IT. An overlay
 * paints OVER the panes by definition (core/plan.ts), so its cells are counted once
 * by the pane underneath — and the overlay must lie inside cells that pane covers,
 * never beside them or off the screen. That is the whole difference between an
 * overlay and a band, and it is what this rule now pins.
 */
function planCoverage(plan: ScreenPlan): string[] {
  const { rows, cols } = plan.size;
  const counts = new Uint8Array(rows * cols);
  const overlays: PlanRegion[] = [];
  for (const region of plan.regions) {
    if (region.kind === "modal") {
      overlays.push(region);
      continue;
    }
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const cell = y * cols + x;
        if (y >= 0 && y < rows && x >= 0 && x < cols) counts[cell] = (counts[cell] ?? 0) + 1;
      }
    }
  }
  const problems: string[] = [];
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] === 0) problems.push("uncovered " + Math.floor(i / cols) + "," + (i % cols));
    else if (counts[i]! > 1) problems.push("covered twice " + Math.floor(i / cols) + "," + (i % cols));
  }
  for (const region of overlays) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        if (y < 0 || y >= rows || x < 0 || x >= cols) {
          problems.push("overlay off screen " + y + "," + x);
        } else if ((counts[y * cols + x] ?? 0) === 0) {
          problems.push("overlay over nothing " + y + "," + x);
        }
      }
    }
  }
  return problems.slice(0, 8);
}

/**
 * Run `attempt`, REQUIRE the harness to report a divergence naming `layer` and
 * `screen`, and return the message. No throw, an untyped error, or a message that
 * does not name both is itself a FAILURE: this is what converts the harness's
 * failure mode from a claim into an executed assertion.
 */
function expectDivergence(attempt: () => void, layer: LayerId, screen: ScreenId): string {
  let message: string | null = null;
  try {
    attempt();
  } catch (error) {
    check(error instanceof LayerDivergenceError, "expected a LayerDivergenceError, got " + String(error));
    message = error.message;
  }
  check(message !== null, "no divergence was reported for layer " + layer + " on screen " + screen);
  check(message.includes('"' + layer + '"'), "the failure does not name the layer: " + message);
  check(message.includes('"' + screen + '"'), "the failure does not name the screen: " + message);
  return message;
}

// --- the loaded surface: which layers have landed, and what is recorded --------

// The landing registry, checked as far as a permission-free run can check it: the
// layer ids are unique, each entry hands over the layer it claims, and the record
// covers every screen of the vocabulary.
const LANDED_IDS = new Set<LayerId>();
const LANDED_PROBLEMS: string[] = [];
for (const entry of LANDED) {
  if (LANDED_IDS.has(entry.layer)) LANDED_PROBLEMS.push("layer " + entry.layer + " is declared twice in LANDED");
  LANDED_IDS.add(entry.layer);
  if (entry.renderer.layer !== entry.layer) {
    LANDED_PROBLEMS.push("the entry for " + entry.layer + " hands over a renderer claiming " + entry.renderer.layer);
  }
  for (const screen of SCREENS) {
    const buffer = entry.buffers[screen] as RecordedBuffer | undefined;
    if (buffer === undefined) {
      LANDED_PROBLEMS.push(goldenModule(screen, entry.layer) + " is missing — a landed layer records every screen");
    } else if (buffer.screen !== screen || buffer.layer !== entry.layer) {
      LANDED_PROBLEMS.push(goldenModule(screen, entry.layer) + " names " + buffer.screen + "/" + buffer.layer);
    }
  }
}
const PAIRS = LANDED.length * FIXTURES.length;
const PENDING = LAYERS.filter((layer) => !LANDED_IDS.has(layer));

console.log("parity: " + FIXTURES.length + " screen fixtures, " + LAYERS.length + " layers — " + LANDED.length +
  " landed (" + (PENDING.length === 0 ? "all three" : PENDING.join(", ") + " pending") + ")");
console.log("parity: " + PAIRS + " of " + (FIXTURES.length * LAYERS.length) + " (screen x layer) pairs recorded in " + GOLDEN_DIR);

// --- the fixtures themselves --------------------------------------------------

Deno.test("goldens: the fixtures cover the screen vocabulary exactly, in its order", () => {
  check(FIXTURES.length === SCREENS.length, "expected " + SCREENS.length + " fixtures, got " + FIXTURES.length);
  SCREENS.forEach((screen, index) => {
    check(FIXTURES[index]?.screen === screen, "fixture " + index + " is " + FIXTURES[index]?.screen + ", expected " + screen);
  });
  const ids = new Set(FIXTURES.map((fixture) => fixture.screen));
  check(ids.size === FIXTURES.length, "a screen is covered by two fixtures");
  const entries = new Set(REGISTRY.map((entry) => entry.id));
  for (const fixture of FIXTURES) {
    check(fixture.regime.trim().length > 0, fixture.screen + ": a fixture must name the regime it pins");
    check(fixture.anchors.length > 0, fixture.screen + ": a fixture must cite the registry entries whose features live on it");
    for (const anchor of fixture.anchors) {
      check(entries.has(anchor), fixture.screen + ": anchor " + anchor + " is not a registry entry id");
    }
  }
  console.log("parity: " + FIXTURES.length + " fixtures — " + FIXTURES.map((fixture) => fixture.screen).join(", "));
});

Deno.test("goldens: every plan is the real core's, twice over, and covers its whole screen", () => {
  FIXTURES.forEach((fixture, index) => {
    const plan = PLANS[index];
    check(plan !== undefined, fixture.screen + ": no plan was captured");
    const again = referencePlan(fixture);
    check(planKey(plan) === planKey(again), fixture.screen + ": a second drive disagrees — the fixture is not a pure function of its input");
    check(plan.size.rows === fixture.size.rows && plan.size.cols === fixture.size.cols, fixture.screen + ": the plan is not the fixture's size");
    check(planKey(plan).length > 0, fixture.screen + ": the plan key is empty");
    check(planFingerprint(plan).length === 8, fixture.screen + ": the plan fingerprint is not 8 hex digits");
    check(plan.regions.some((region) => region.kind === "editor"), fixture.screen + ": the plan has no editor region");
    const holes = planCoverage(plan);
    check(holes.length === 0, fixture.screen + ": the plan does not cover its screen — " + holes.join(", "));
  });
  console.log("parity: " + FIXTURES.length + " plans rebuilt from the real core, all covering their screens exactly");
});

/** The screens whose fixture must carry an overlay region, and the modal each one
 * names. The overlay vocabulary is `commands.ts`'s ModalId: the three search/help
 * overlays plus the seven auxiliary panes (pane-ids.ts). Every other screen is a
 * screen with NO modal, and its plan must not grow one. */
const OVERLAY_SCREENS: ReadonlyMap<ScreenId, string> = new Map([
  ["chooser", "picker"],
  ["find", "find"], ["replace", "replace"], ["help", "help"],
  ["profile", "profile"], ["a11y", "a11y"],
  ["palette", "palette"], ["preferences", "preferences"], ["theme", "theme"], ["diff", "diff"],
]);

Deno.test("goldens: exactly the overlay screens lay a modal region out", () => {
  const found: string[] = [];
  FIXTURES.forEach((fixture, index) => {
    const plan = PLANS[index]!;
    const overlays = plan.regions.filter((region) => region.kind === "modal");
    const expected = OVERLAY_SCREENS.get(fixture.screen);
    if (expected === undefined) {
      check(overlays.length === 0, fixture.screen + ": a screen with no modal carries no overlay region");
      return;
    }
    check(overlays.length === 1, fixture.screen + ": expected one overlay region, got " + overlays.length);
    const modal = overlays[0]!;
    check(modal.kind === "modal" && modal.id === expected,
      fixture.screen + ": the overlay names " + (modal.kind === "modal" ? modal.id : modal.kind));
    check(modal.rows.length === modal.height, fixture.screen + ": the box is as tall as its rows");
    for (const row of modal.rows) {
      check(row.spans.length > 0, fixture.screen + ": overlay row " + row.row + " paints nothing");
    }
    found.push(fixture.screen);
  });
  const expected = [...FIXTURES.map((fixture) => fixture.screen)].filter((screen) => OVERLAY_SCREENS.has(screen));
  check(found.join(",") === expected.join(","), "the overlay screens are " + found.join(","));
  console.log("parity: overlays laid out for " + found.join(", ") + " — every other screen is overlay-free");
});

Deno.test("goldens: every fixture is a DIFFERENT screen, not a copy", () => {
  const seen = new Map<string, ScreenId>();
  FIXTURES.forEach((fixture, index) => {
    const plan = PLANS[index];
    check(plan !== undefined, fixture.screen + ": no plan was captured");
    const key = planKey(plan);
    const owner = seen.get(key);
    check(owner === undefined, fixture.screen + " and " + owner + " produce the same plan — one of them pins nothing");
    seen.set(key, fixture.screen);
  });
  check(seen.size === FIXTURES.length, "the fixtures are not distinct");
  console.log("parity: " + seen.size + " distinct plans — " + [...seen.values()].slice(0, 4).join(", ") + ", …");
});

// --- the recorded-buffer convention ------------------------------------------

Deno.test("harness: the recorded-buffer convention is one module per (screen x layer) pair", () => {
  check(GOLDEN_DIR.endsWith("parity/goldens/buffers"), "GOLDEN_DIR is not the goldens/buffers directory: " + GOLDEN_DIR);
  const names = new Set<string>();
  for (const screen of SCREENS) {
    for (const layer of LAYERS) {
      const module = goldenModule(screen, layer);
      check(module === screen + "." + layer + ".ts", "unexpected module name " + module);
      check(!names.has(module), "two pairs share the module name " + module);
      check(goldenImportPath(screen, layer) === "./buffers/" + module, "unexpected import path " + goldenImportPath(screen, layer));
      names.add(module);
    }
  }
  check(names.size === SCREENS.length * LAYERS.length, "expected " + (SCREENS.length * LAYERS.length) + " pair modules, got " + names.size);
  console.log("parity: " + names.size + " pair modules, e.g. " + goldenModule("editor", "core") + " in " + GOLDEN_DIR);
});

Deno.test("harness: the recording recipe prints a pasteable BUFFER module", () => {
  const source = formatRecordedBuffer({
    screen: "parity", layer: "core", planFingerprint: "deadbeef",
    recordedBy: "golden_test.ts recipe check", rows: ["alpha", "beta"],
  });
  check(source.includes("export const BUFFER: RecordedBuffer = {"), "the recipe must print a typed export");
  check(source.includes('screen: "parity"') && source.includes('layer: "core"'), "the recipe must print the pair");
  check(source.includes('"alpha",') && source.includes('"beta",'), "the recipe must print every row");
  check(source.includes("planFingerprint: \"deadbeef\""), "the recipe must print the plan fingerprint");
  console.log("harness: recording recipe — " + source.split("\n").length + " lines for a 2-row buffer");
});

// --- the harness's own failure mode, executed ---------------------------------

Deno.test("harness: the stub layer passes parity, and an injected divergence names the layer and the screen", () => {
  const fixture = FIXTURE_BY_SCREEN.get("parity");
  check(fixture !== undefined, "the parity fixture is missing");
  const stub = stubLayer("core");
  const clean = runLayer(stub, fixture);

  // (a) the passing side, through the assertion the real goldens use.
  const recorded: RecordedBuffer = {
    screen: fixture.screen,
    layer: "core",
    planFingerprint: planFingerprint(clean.reference),
    recordedBy: "golden_test.ts self-test (the stub layer's own buffer; never shipped)",
    rows: [...clean.frame.rows],
  };
  assertLayerParity(clean, recorded);
  check(clean.planDiffs.length === 0, "the stub layer must reach the reference plan");
  check(clean.problems.length === 0, "the stub frame must be the right shape: " + clean.problems.join("; "));
  check(clean.frame.rows.length === fixture.size.rows, "the stub must emit one row per screen row");
  console.log("harness: stub parity clean — " + fixture.screen + " x core, " + clean.frame.rows.length +
    " rows, plan " + planFingerprint(clean.reference));

  // (b) a missing record is a FAILURE, not a skip — the "empty pass" rule.
  console.log("harness: missing record — " + firstLine(expectDivergence(() => assertLayerParity(clean, null), "core", "parity")));

  // (c) a layer that reaches a different PLAN fails, with the field named.
  const bent: RendererLayer = {
    ...stub,
    plan: (it) => {
      const plan = referencePlan(it);
      return { ...plan, dirty: !plan.dirty };
    },
  };
  const divergingPlan = runLayer(bent, fixture);
  check(divergingPlan.planDiffs.length === 1, "bending dirty must be exactly one plan diff, got " + divergingPlan.planDiffs.length);
  const planIssue = expectDivergence(() => assertLayerParity(divergingPlan, recorded), "core", "parity");
  check(planIssue.includes("plan.dirty"), "the plan failure must name the field: " + planIssue);
  console.log("harness: plan divergence — " + firstLine(planIssue));

  // (d) THE INJECTION SEAM: one wrong cell, on the named screen only.
  const injected = injectDivergence(stub, "parity", { row: 1, col: 3, text: "X" });
  const bad = runLayer(injected, fixture);
  check(bad.planDiffs.length === 0, "the injection must not touch the plan");
  const changed = compareFrames(clean.frame.rows, bad.frame.rows);
  check(changed.length === 1, "the injection must change exactly one row, got " + changed.length);
  check(changed[0]!.col === 3, "the injection must land at column 3, got " + changed[0]!.col);
  console.log("harness: injected divergence — " + firstLine(expectDivergence(() => assertLayerParity(bad, recorded), "core", "parity")));
});

// --- the landed layers and their records --------------------------------------

Deno.test("harness: every landed layer records every screen, and no layer lands twice", () => {
  if (LANDED_PROBLEMS.length > 0) {
    throw new Error("the landing registry is incomplete:\n" + LANDED_PROBLEMS.slice(0, 12).join("\n"));
  }
  check(LANDED.length <= LAYERS.length, "more landed layers than layers exist");
  check(LANDED_IDS.size === LANDED.length, "two entries declare the same layer");
  check(PAIRS === LANDED.length * SCREENS.length, "the pair count is not layers x screens");
  // An empty registry is NOT a quiet pass: it is reported as what it is, and the
  // mechanism above it is executed by the stub self-test in this same file.
  console.log("parity: " + LANDED.length + " of " + LAYERS.length + " layers landed, " + PAIRS + " of " +
    (FIXTURES.length * LAYERS.length) + " (screen x layer) buffers recorded, 0 disagreements");
});

for (const entry of LANDED) {
  for (const fixture of FIXTURES) {
    Deno.test("parity: the " + fixture.screen + " screen through the " + entry.layer + " layer", () => {
      const run = runLayer(entry.renderer, fixture);
      assertLayerParity(run, landedBuffer(entry, fixture.screen));
      console.log("parity: " + pair(fixture.screen, entry.layer) + " ok — " + run.frame.rows.length +
        " rows, frame " + frameFingerprint(run.frame.rows));
    });
  }
}
