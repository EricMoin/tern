/**
 * @tern-tui/showcase — a real, runnable terminal text editor built on tern.
 *
 * Private and in-repo (CONTRIBUTING.md, "Layer ownership"): the showcase is
 * tern's first real consumer. It is never published and never enters the
 * release matrix. Its job is to prove that a non-trivial application can be
 * carried by the published surface, and to expose every framework gap that
 * application needs — each gap is fixed in this repository and proven by CI.
 *
 * The architecture it is built against — the plan/emit split, which is what
 * makes three-renderer parity mechanical rather than three copies:
 *
 * - `core/plan.ts` is the ONE decision point for what is on screen. It yields
 *   a `ScreenPlan` of plain data: regions, rows, spans, the cursor cell, style
 *   hints, mode-line segments, sidebar items.
 * - `core/commands.ts` is the ONE decision point for what a key means. It
 *   yields an Intent or a command effect — never a scene mutation.
 * - The headless app-core imports no napi addon, builds no scene, and
 *   references no renderer.
 * - Each renderer layer is only (a) a pure ScreenPlan-to-scene emitter and
 *   (b) an event source feeding the same HeadlessApp dispatcher. A layer must
 *   never re-implement layout or key meaning.
 * - One parity harness holds the three layers to ScreenPlan identity; the
 *   golden buffers are per-layer facts, not a cross-layer pixel promise.
 *
 * This module is the package entry barrel. It is a stub at skeleton stage:
 * the headless app-core, the three emitters and the parity harness land on
 * top of it.
 */
export const name = "@tern-tui/showcase";
export const version = "0.2.0";

// The completeness registry (REGISTRY, in parity/registry-shell.ts) is the
// barrel's second export: it is the app's own record of which shipped framework
// symbols it exercises, how honestly, and which gaps it is still paying for.
// Re-exporting it here is what makes `deno task check` type-check the registry
// and its contract test along with the package.
export {
  byKind,
  REGISTRY,
  REGISTRY_ROLE_COUNTS,
  roleCounts,
  tierCounts,
} from "./parity/registry-shell.ts";
export type { RoleCounts } from "./parity/registry-shell.ts";
export type {
  Classification,
  FrameworkFixEntry,
  LayerId,
  RegistryEntry,
  Role,
  ScreenId,
  SurfaceEntry,
  Tier,
} from "./parity/registry-editor.ts";

// The parity harness (parity/harness.ts) is the third export: it is what holds the
// three renderer layers to ScreenPlan identity, and it is the mechanism the twelve
// screen fixtures (parity/goldens/*.ts) and the per-(screen x layer) recorded buffers
// (parity/goldens/buffers/) are driven through. Re-exporting it here is what makes
// `deno task check` type-check the harness, its fixtures and the recording
// convention along with the rest of the package.
export {
  appOptions,
  assertLayerParity,
  chars,
  compareFrames,
  comparePlans,
  defineLayer,
  driveApp,
  frameFingerprint,
  frameProblems,
  injectDivergence,
  key,
  landedBuffer,
  LayerDivergenceError,
  layerPath,
  planFingerprint,
  planKey,
  referencePlan,
  runLayer,
} from "./parity/harness.ts";
export type {
  EmitFn,
  Fixture,
  FixtureDrive,
  FrameDiff,
  InjectedDivergence,
  LandedLayer,
  LayerFrame,
  LayerRun,
  PlanDiff,
  RendererLayer,
} from "./parity/harness.ts";
export { FIXTURE_BY_SCREEN, FIXTURES, PLANS } from "./parity/goldens/index.ts";
export { LANDED } from "./parity/goldens/landed.ts";
export {
  formatRecordedBuffer,
  goldenImportPath,
  goldenModule,
  GOLDEN_DIR,
} from "./parity/goldens/record.ts";
export type { RecordedBuffer } from "./parity/goldens/record.ts";
