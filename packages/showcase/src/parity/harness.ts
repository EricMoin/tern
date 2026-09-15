//! The parity harness: ONE app-core instance, ONE renderer layer, ONE frame.
//!
//! WHAT IS COMPARED, AND WHAT IS NOT (resolved decision Q4):
//!
//!   * ScreenPlan IDENTITY IS THE HARD CROSS-LAYER CONTRACT. One intent sequence
//!     must yield one ScreenPlan in all three layers, and that is a headless unit
//!     test: no addon, no PTY, no terminal. `runLayer` drives the fixture through
//!     the layer's own app-core instance and `comparePlans` holds the answer to the
//!     harness's reference plan field by field. A layer that re-derives a row, a
//!     column or a truncation is a SECOND decision point (core/plan.ts:1-8), and
//!     this is where it shows.
//!   * GOLDEN BUFFERS ARE PER-LAYER FACTS, not cross-layer pixel identity: the
//!     buffer a layer paints is THAT layer's screen, recorded once by the subtask
//!     that landed it (goldens/record.ts). React's commit batching, Solid's
//!     fine-grained effects and the core emitter's single pass may reach the same
//!     screen differently, and a cross-layer pixel gate would fail on those
//!     legitimate differences instead of on a parity break.
//!
//! THE FIXTURES ARE THE SINGLE SOURCE: twelve plans, one per screen, all produced by
//! the real core (goldens/fixture.ts). All three layers run the same twelve, so a
//! break localizes to one emitter and a feature added once is in all three layers or
//! the parity test fails.
//!
//! COST IS NOT THE SCREEN: `ScreenPlan.stats` is the measured cost of building the
//! plan (core/viewport.ts:78), so `planKey` leaves it out — exactly as the app's own
//! golden digest does (core/state_test.ts:26).
//!
//! HOW A LAYER IS FOUND: statically, through the landing registry (goldens/landed.ts).
//! Probing for the layer module with a dynamic import() would be the obvious
//! mechanism and is IMPOSSIBLE in the canonical run: Deno gates dynamic module
//! resolution behind --allow-read, so the probe dies with "Requires read access to
//! .../layers/core/index.ts" (measured, Deno 2.9.6) instead of answering "not there".
//! A STATIC import is resolved with the module graph and needs no permission, so
//! landing is a declaration. goldens/landed.ts carries the evidence and the limit.
//!
//! THE DELIBERATE-DIVERGENCE SEAM: `injectDivergence` wraps a layer so it emits a
//! WRONG cell on a named screen. golden_test.ts runs a stub layer through the SAME
//! assertion the real goldens use — clean, then injected — and asserts the injected
//! run throws a LayerDivergenceError NAMING the layer and the screen. The non-zero
//! exit is that throw left uncaught; the canonical run catches it in the self-test,
//! because one `deno test` invocation must exit 0 and a second, deliberately failing
//! invocation would need --allow-run, which the canonical run does not grant.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/parity/

import type { StyleRunJs } from "@tern-tui/core";
import { cellWidth } from "../core/viewport.ts";
import type { ScreenPlan } from "../core/plan.ts";
import { referencePlan, type Fixture } from "./goldens/fixture.ts";
import { GOLDEN_DIR, goldenModule, type RecordedBuffer } from "./goldens/record.ts";
import type { LayerId, ScreenId } from "./registry-editor.ts";

// The fixture vocabulary and the reference drive live with the fixtures; the
// harness is their one import site (see goldens/fixture.ts).
export { appOptions, chars, driveApp, key, referencePlan } from "./goldens/fixture.ts";
export type { Fixture, FixtureDrive } from "./goldens/fixture.ts";

// --- the layer: its own plan drive, its own emitter ---------------------------

/** What one layer painted for one plan: one string per screen row. */
export interface LayerFrame {
  readonly layer: LayerId;
  readonly rows: readonly string[];
  /** Optional per-row styled runs (core's `StyleRunJs`); compared only when the
   * recorded buffer carries them too. */
  readonly styled?: readonly (readonly StyleRunJs[])[];
}

/** What a layer's emitter is: the plan in, the screen out. Pure. */
export type EmitFn = (plan: ScreenPlan, screen: ScreenId) => LayerFrame;

/** A renderer layer as the harness sees it: (a) the plan it reached for the fixture
 * — its own app-core drive — and (b) its own ScreenPlan-to-scene emitter. Those two
 * jobs are the layer's whole surface (src/index.ts:21-22). */
export interface RendererLayer {
  readonly layer: LayerId;
  readonly plan: (fixture: Fixture) => ScreenPlan;
  readonly emit: EmitFn;
}

/** A layer that mounts the SHARED core drive: the plan is the core's, the layer
 * supplies only its emitter. The expected shape of all three layers — a layer that
 * builds its own plan is a second decision point, and `comparePlans` catches it. */
export function defineLayer(layer: LayerId, emit: EmitFn): RendererLayer {
  return { layer, plan: (fixture) => referencePlan(fixture), emit };
}

/** Where a landed layer's module lives, as a path a reader can open. The layer
 * subtask owns that module; the harness never probes for it, and cannot (see
 * goldens/landed.ts for the measured reason). */
export function layerPath(layer: LayerId): string {
  return "packages/showcase/src/layers/" + layer + "/index.ts";
}

/**
 * A layer that has LANDED: its module, and the buffer it recorded for EVERY screen.
 *
 * The record is TOTAL on purpose. A layer that landed with only some screens
 * recorded cannot be written as one of these, so "a missing golden for an existing
 * layer" is a compile error here and a parity failure in golden_test.ts at once —
 * never a skip.
 */
export interface LandedLayer {
  readonly layer: LayerId;
  readonly renderer: RendererLayer;
  readonly buffers: Readonly<Record<ScreenId, RecordedBuffer>>;
}

/** `entry`'s recorded buffer for `screen`, or a divergence naming both. The type
 * already requires every screen; this catches a record assembled by a cast. */
export function landedBuffer(entry: LandedLayer, screen: ScreenId): RecordedBuffer {
  const buffer = entry.buffers[screen] as RecordedBuffer | undefined;
  if (buffer === undefined) {
    throw new LayerDivergenceError(screen, entry.layer, "missing-record",
      "the landed layer has no recorded buffer for this screen — record " + GOLDEN_DIR + "/" +
      goldenModule(screen, entry.layer) + " and list it in goldens/landed.ts");
  }
  return buffer;
}

// --- comparison: the plan (identity) and the frame (this layer's own screen) ---

/** A field where two plans disagree, with the path that names it. */
export interface PlanDiff {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/** Canonical JSON of a value: object keys sorted, `undefined` dropped, so equal
 * plans always have equal text and a diff can name a path. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([name, item]) => JSON.stringify(name) + ":" + canonical(item)).join(",") + "}";
}

/** The screen a plan describes, without the cost of building it. */
function screenForm(plan: ScreenPlan): Record<string, unknown> {
  return { size: plan.size, regions: plan.regions, cursor: plan.cursor, focus: plan.focus, dirty: plan.dirty };
}

/** The canonical screen of a plan: the identity two layers must agree on. */
export function planKey(plan: ScreenPlan): string {
  return canonical(screenForm(plan));
}

/** A stable 32-bit FNV-1a hash of `text`, hex. Compact enough for a recorded buffer
 * to carry and cheap to recompute; it is a CHANGE NOTICE only — the identity check is
 * the full `planKey` comparison, so a collision cannot pass a diverging layer. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The fingerprint of a plan's screen. */
export function planFingerprint(plan: ScreenPlan): string {
  return fingerprint(planKey(plan));
}

/** The fingerprint of a frame's rows. */
export function frameFingerprint(rows: readonly string[]): string {
  return fingerprint(rows.join("\n"));
}

function brief(value: unknown): string {
  const text = canonical(value);
  return text.length <= 60 ? text : text.slice(0, 57) + "...";
}

function walk(path: string, expected: unknown, actual: unknown, out: PlanDiff[]): void {
  if (expected === actual) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: path + ".length", expected: String(expected.length), actual: String(actual.length) });
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) {
      walk(path + "[" + i + "]", expected[i], actual[i], out);
    }
    return;
  }
  const bothObjects = expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object";
  if (bothObjects && !Array.isArray(expected) && !Array.isArray(actual)) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      walk(path + "." + name, left[name], right[name], out);
    }
    return;
  }
  out.push({ path, expected: brief(expected), actual: brief(actual) });
}

/** Every field where the layer's plan and the reference plan disagree. Empty means
 * ScreenPlan identity — the hard cross-layer contract. */
export function comparePlans(expected: ScreenPlan, actual: ScreenPlan): PlanDiff[] {
  const diffs: PlanDiff[] = [];
  walk("plan", screenForm(expected), screenForm(actual), diffs);
  return diffs;
}

/** One row where two frames disagree. `col` is a code-unit index into the row; a row
 * that is missing entirely reports `col: -1`. */
export interface FrameDiff {
  readonly row: number;
  readonly col: number;
  readonly note: string;
  readonly expected: string;
  readonly actual: string;
}

/** Every row where two frames disagree, in row order. */
export function compareFrames(expected: readonly string[], actual: readonly string[]): FrameDiff[] {
  const diffs: FrameDiff[] = [];
  for (let row = 0; row < Math.max(expected.length, actual.length); row += 1) {
    const left = expected[row];
    const right = actual[row];
    if (left === right) continue;
    if (left === undefined || right === undefined) {
      diffs.push({ row, col: -1, note: "row count differs", expected: left ?? "<no row>", actual: right ?? "<no row>" });
      continue;
    }
    const width = Math.min(left.length, right.length);
    let col = 0;
    while (col < width && left[col] === right[col]) col += 1;
    diffs.push({ row, col, note: col >= width ? "row length differs" : "cell differs", expected: left, actual: right });
  }
  return diffs;
}

/** How a frame diff is spelled in a failure message. */
export function describeFrameDiff(diff: FrameDiff): string {
  return "  row " + diff.row + " col " + diff.col + " (" + diff.note + "): recorded " +
    JSON.stringify(diff.expected) + ", emitted " + JSON.stringify(diff.actual);
}

/** Where a frame is not this screen: the row count and the DISPLAY width of every row
 * must match the plan's cells — multi-width aware, so a layer that measures its own
 * text in code units fails here. */
export function frameProblems(frame: LayerFrame, plan: ScreenPlan): string[] {
  const problems: string[] = [];
  if (frame.rows.length !== plan.size.rows) {
    problems.push("emitted " + frame.rows.length + " rows, the plan has " + plan.size.rows);
  }
  for (let row = 0; row < frame.rows.length; row += 1) {
    const width = cellWidth(frame.rows[row] ?? "");
    if (width !== plan.size.cols) {
      problems.push("row " + row + " is " + width + " cells, the plan is " + plan.size.cols + " wide");
    }
  }
  return problems;
}

// --- the run, the ONE assertion, and the divergence seam ----------------------

/** One layer run against one fixture: the plan the core built, the plan the layer
 * reached, and the frame it emitted from it. */
export interface LayerRun {
  readonly screen: ScreenId;
  readonly layer: LayerId;
  readonly reference: ScreenPlan;
  readonly observed: ScreenPlan;
  readonly planDiffs: readonly PlanDiff[];
  readonly frame: LayerFrame;
  readonly problems: readonly string[];
}

/** Drive ONE app-core instance through ONE layer for ONE fixture. The reference plan
 * is the harness's, the layer's plan is the layer's, and the two are compared — so a
 * layer that re-derives anything is caught here rather than at the pixels. */
export function runLayer(layer: RendererLayer, fixture: Fixture): LayerRun {
  const reference = referencePlan(fixture);
  const observed = layer.plan(fixture);
  const frame = layer.emit(observed, fixture.screen);
  return {
    screen: fixture.screen,
    layer: layer.layer,
    reference,
    observed,
    planDiffs: comparePlans(reference, observed),
    frame,
    problems: frameProblems(frame, observed),
  };
}

/** What a parity failure IS: which layer, which screen, which contract broke. The
 * message names both, so a failure is never anonymous. */
export class LayerDivergenceError extends Error {
  readonly screen: ScreenId;
  readonly layer: LayerId;
  readonly contract: "missing-record" | "stale-record" | "plan" | "shape" | "frame" | "styled";
  constructor(screen: ScreenId, layer: LayerId, contract: LayerDivergenceError["contract"], detail: string) {
    super('parity: layer "' + layer + '" on screen "' + screen + '" — ' + detail);
    this.name = "LayerDivergenceError";
    this.screen = screen;
    this.layer = layer;
    this.contract = contract;
  }
}

/**
 * The parity assertion: a LANDED layer must have a recorded buffer for the screen, the
 * record must be against the current fixture plan, and the layer's plan and frame must
 * match it. A missing record FAILS here — an empty pass must never be able to
 * masquerade as parity.
 */
export function assertLayerParity(run: LayerRun, recorded: RecordedBuffer | null): void {
  const { screen, layer } = run;
  if (recorded === null) {
    throw new LayerDivergenceError(screen, layer, "missing-record",
      "the layer has landed and this screen has no recorded buffer — record " + GOLDEN_DIR + "/" +
      goldenModule(screen, layer) + " (see goldens/buffers/README.md). A missing golden is a FAILURE, not a skip");
  }
  if (recorded.screen !== screen || recorded.layer !== layer) {
    throw new LayerDivergenceError(screen, layer, "stale-record",
      "the recorded buffer names " + recorded.screen + "/" + recorded.layer);
  }
  const expected = planFingerprint(run.reference);
  if (recorded.planFingerprint !== expected) {
    throw new LayerDivergenceError(screen, layer, "stale-record",
      "the recorded buffer was taken against a different plan (recorded " + recorded.planFingerprint +
      ", now " + expected + ") — re-record it");
  }
  if (run.planDiffs.length > 0) {
    throw new LayerDivergenceError(screen, layer, "plan",
      "the layer reached a different ScreenPlan:\n" + run.planDiffs.slice(0, 8).map((diff) =>
        "  " + diff.path + ": expected " + diff.expected + ", got " + diff.actual).join("\n"));
  }
  if (run.problems.length > 0) {
    throw new LayerDivergenceError(screen, layer, "shape",
      "the frame is not this screen:\n" + run.problems.slice(0, 8).map((problem) => "  " + problem).join("\n"));
  }
  const diffs = compareFrames(recorded.rows, run.frame.rows);
  if (diffs.length > 0) {
    const more = diffs.length > 8 ? "\n  ... " + (diffs.length - 8) + " more rows differ" : "";
    throw new LayerDivergenceError(screen, layer, "frame",
      "the emitted buffer differs from the recorded one:\n" +
      diffs.slice(0, 8).map(describeFrameDiff).join("\n") + more);
  }
  if (recorded.styled !== undefined && run.frame.styled !== undefined) {
    const styled = compareFrames(recorded.styled.map((runs) => canonical(runs)), run.frame.styled.map((runs) => canonical(runs)));
    if (styled.length > 0) {
      throw new LayerDivergenceError(screen, layer, "styled",
        "the styled runs differ from the recorded ones at row " + styled[0]!.row);
    }
  }
}

/** One cell a layer is made to emit WRONG, so the harness's failure mode is provable
 * rather than described. */
export interface InjectedDivergence {
  readonly row: number;
  readonly col: number;
  /** Painted in place of `text.length` code units at that cell; the row keeps its
   * width, so the divergence is a VALUE difference, not a shape error. */
  readonly text: string;
}

/** Wrap `layer` so the screen named by `screen` emits a wrong cell. Every other
 * screen, and the plan itself, pass through untouched — which is what makes the
 * injected run a control for the parity assertion. */
export function injectDivergence(layer: RendererLayer, screen: ScreenId, injected: InjectedDivergence): RendererLayer {
  return {
    layer: layer.layer,
    plan: (fixture) => layer.plan(fixture),
    emit: (plan, target) => {
      const frame = layer.emit(plan, target);
      if (target !== screen) return frame;
      const rows = frame.rows.map((row, index) =>
        index === injected.row ? spliceCells(row, injected.col, injected.text, plan.size.cols) : row);
      return { layer: frame.layer, rows };
    },
  };
}

/** `row` with `text` written at code-unit `col`, kept `width` code units wide. */
function spliceCells(row: string, col: number, text: string, width: number): string {
  const next = row.slice(0, col) + text + row.slice(col + text.length);
  if (next.length === width) return next;
  return next.length > width ? next.slice(0, width) : next + " ".repeat(width - next.length);
}
