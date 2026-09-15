//! The recorded per-(screen x layer) buffer convention — the naming, the directory,
//! and the module each pair must provide.
//!
//! A recorded buffer is ONE LAYER'S OWN SCREEN, not a cross-layer pixel promise
//! (harness.ts's header). The three layers are held to ScreenPlan identity; their
//! buffers are per-layer facts, because React's commit batching, Solid's fine-grained
//! effects and the core emitter's single pass may reach the same screen differently,
//! and a pixel gate across three frameworks would fail on those legitimate differences
//! instead of on a parity break.
//!
//! THE CONVENTION, in one line: one module per (screen x layer) pair, named
//! `<screen>.<layer>.ts`, exporting `BUFFER: RecordedBuffer`.
//!
//!   packages/showcase/src/parity/goldens/buffers/
//!     editor.core.ts    editor.react.ts    editor.solid.ts
//!     sidebar.core.ts   … one for each of the 12 screens x 3 layers
//!
//! WHY MODULES, AND WHY THEY ARE REACHED BY A STATIC IMPORT. The canonical run is
//! `deno test --allow-env=NODE_ENV packages/showcase/src/parity/` (registry_test.ts:17)
//! and it grants NO read permission — the same restriction contract.ts:29-37 reports.
//! A golden that must be READ at test time therefore cannot be read, and a golden
//! FOUND by a dynamic import() cannot be found either: Deno gates dynamic module
//! resolution behind --allow-read, so the probe dies with
//!
//!   TypeError: Requires read access to ".../layers/core/index.ts",
//!     run again with the --allow-read flag
//!
//! (measured under the canonical run, Deno 2.9.6) instead of reporting absence. A
//! STATIC import is resolved with the module graph and needs no permission at all, so
//! the pairs are declared in goldens/landed.ts and this file only NAMES them — one
//! name builder, asserted for all 36 pairs by golden_test.ts.
//!
//! HOW TO RECORD (t12/t13/t14): once your layer exports `LAYER` from
//! `packages/showcase/src/layers/<layer>/index.ts`, run each fixture through
//! `runLayer` + `assertLayerParity` and print `formatRecordedBuffer` for the pair;
//! paste the output into the module this file names, then declare the pair in
//! goldens/landed.ts. A missing buffer for a LANDED layer FAILS
//! (harness.ts:landedBuffer, assertLayerParity) — never a skip.

import type { StyleRunJs } from "@tern-tui/core";
import type { LayerId, ScreenId } from "../registry-editor.ts";

/** Where the recorded per-(screen x layer) buffers live, relative to the package
 * root — one module per pair. */
export const GOLDEN_DIR = "packages/showcase/src/parity/goldens/buffers";

/** The module name of one pair: `<screen>.<layer>.ts`. */
export function goldenModule(screen: ScreenId, layer: LayerId): string {
  return screen + "." + layer + ".ts";
}

/** How goldens/landed.ts imports one pair's buffer:
 * `./buffers/<screen>.<layer>.ts` — the static path, which needs no permission. */
export function goldenImportPath(screen: ScreenId, layer: LayerId): string {
  return "./buffers/" + goldenModule(screen, layer);
}

/** What a layer's subtask records for one screen: the frame it emitted, and the
 * fixture plan it was emitted against. */
export interface RecordedBuffer {
  readonly screen: ScreenId;
  readonly layer: LayerId;
  /** The fingerprint of the fixture plan (`planFingerprint`) this buffer was
   * recorded against, so a changed fixture invalidates the record instead of silently
   * re-baselining it. */
  readonly planFingerprint: string;
  readonly recordedBy: string;
  readonly rows: readonly string[];
  readonly styled?: readonly (readonly StyleRunJs[])[];
}

/** The source of a recorded-buffer module — the recording recipe: print this and paste
 * it into `goldenModule(screen, layer)`. */
export function formatRecordedBuffer(recorded: RecordedBuffer): string {
  const lines: string[] = [];
  lines.push("// Recorded by " + recorded.recordedBy + " — regenerate with formatRecordedBuffer.");
  // The pair module lives IN `buffers/`, one level below this file, so the
  // specifier is `../record.ts` — two levels would name `parity/record.ts`,
  // which does not exist. (Measured: the first recorded pair failed to
  // type-check at this line; no buffer module existed before t12a to hit it.)
  lines.push("import type { RecordedBuffer } from \"../record.ts\";");
  lines.push("");
  lines.push("export const BUFFER: RecordedBuffer = {");
  lines.push("  screen: " + JSON.stringify(recorded.screen) + ",");
  lines.push("  layer: " + JSON.stringify(recorded.layer) + ",");
  lines.push("  planFingerprint: " + JSON.stringify(recorded.planFingerprint) + ",");
  lines.push("  recordedBy: " + JSON.stringify(recorded.recordedBy) + ",");
  lines.push("  rows: [");
  for (const row of recorded.rows) lines.push("    " + JSON.stringify(row) + ",");
  lines.push("  ],");
  lines.push("};");
  return lines.join("\n");
}
