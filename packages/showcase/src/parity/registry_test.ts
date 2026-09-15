//! The showcase completeness contract — HALF ONE: registry shape and
//! self-resolution.
//
// This file holds the half of the contract that needs no renderer, no PTY and
// no file system: it proves that the registry is well-formed (every entry
// carries its full field set, every id is unique, every vocabulary value comes
// from the vocabulary) and that it is SELF-RESOLVING (every framework symbol any
// entry names is declared by a surface entry inside the registry, every
// `blocks` id exists, and no name a fix calls unreachable is claimed as
// covered). Nothing here reads a file: the file:line evidence in a framework-fix
// entry is a citation, and citing it is the whole claim this half makes.
//
// HALF TWO — the live-surface half — lives in contract.ts: it holds the
// registry to the barrels' real export maps. The two contract tests at the
// bottom of this file drive it, mutation check included.
//
// Run: deno test --allow-env=NODE_ENV packages/showcase/src/parity/registry_test.ts

import {
  GAP_BASIS,
  INVENTORY_GAP,
  LAYERS,
  ROLES,
  SCREENS,
  TIERS,
  type Classification,
  type FrameworkFixEntry,
  type RegistryEntry,
  type SurfaceEntry,
} from "./registry-editor.ts";
import { byKind, REGISTRY, roleCounts, tierCounts } from "./registry-shell.ts";
import { EXCLUDED, enumerateLiveSurface, findViolations, reportContract } from "./contract.ts";

/** Every classification the fix ledger may carry. */
const CLASSIFICATIONS: readonly Classification[] = ["real", "already shipped", "partially shipped"];

/** Fail unless `value` is a non-empty string. */
function requireText(where: string, field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: ${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/** Fail unless `value` is a non-empty array of non-empty strings. */
function requireTextList(where: string, field: string, value: unknown, allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${where}: ${field} must be ${allowEmpty ? "an" : "a non-empty"} array, got ${JSON.stringify(value)}`);
  }
  for (const item of value) requireText(where, `${field}[]`, item);
}

const { surfaces, fixes } = byKind();

/** The shape contract for a surface entry — the full field set, checked once. */
function checkSurface(entry: SurfaceEntry): void {
  const where = `surface ${entry.id}`;
  requireText(where, "id", entry.id);
  requireTextList(where, "symbols", entry.symbols);
  requireText(where, "feature", entry.feature);
  requireText(where, "tierBasis", entry.tierBasis);
  requireText(where, "headless", entry.headless);
  if (!TIERS.includes(entry.tier)) throw new Error(`${where}: tier ${entry.tier} is not in the taxonomy`);
  if (!ROLES.includes(entry.role)) throw new Error(`${where}: role ${entry.role} is not a role`);
  if (!SCREENS.includes(entry.screen)) throw new Error(`${where}: screen ${entry.screen} is not a screen`);
  requireTextList(where, "layers", entry.layers);
  for (const layer of entry.layers) {
    if (!LAYERS.includes(layer)) throw new Error(`${where}: layer ${layer} is not a layer`);
  }
  if (typeof entry.docGap !== "boolean") throw new Error(`${where}: docGap must be a boolean`);
  if (typeof entry.droppable !== "boolean") throw new Error(`${where}: droppable must be a boolean`);
  if (entry.keybinding !== null) requireText(where, "keybinding", entry.keybinding);
  // A repurposed or forced feature must say out loud what it is worth.
  if (entry.role === "natural" && entry.disposition !== null) {
    throw new Error(`${where}: a natural entry must not carry a disposition`);
  }
  if (entry.role !== "natural") requireText(where, "disposition", entry.disposition);
  // The tier claim must cite either an audited row or the measured inventory gap.
  if (entry.docGap) {
    if (entry.tierBasis !== GAP_BASIS) throw new Error(`${where}: docGap entries must cite GAP_BASIS`);
    // docGap means "this citation includes a symbol with no audited row" — an
    // entry may legitimately mix one such symbol with audited siblings.
    if (!entry.symbols.some((symbol) => INVENTORY_GAP.includes(symbol))) {
      throw new Error(`${where}: docGap is true but every symbol has an audited row`);
    }
  } else if (!entry.tierBasis.startsWith("docs/api-stability.md:")) {
    throw new Error(`${where}: tierBasis "${entry.tierBasis}" cites no audited row`);
  } else {
    for (const symbol of entry.symbols) {
      if (INVENTORY_GAP.includes(symbol)) {
        throw new Error(`${where}: ${symbol} has no inventory row, so docGap must be true`);
      }
    }
  }
}

/** The shape contract for a framework-fix entry — DELIVERABLE C's field set. */
function checkFix(entry: FrameworkFixEntry): void {
  const where = `framework-fix ${entry.id}`;
  requireText(where, "id", entry.id);
  requireText(where, "feature", entry.feature);
  requireText(where, "reproduction", entry.reproduction);
  requireText(where, "fix", entry.fix);
  requireText(where, "regression", entry.regression);
  requireText(where, "file", entry.file);
  if (!entry.file.includes(":")) throw new Error(`${where}: file must carry a line, got ${entry.file}`);
  if (!CLASSIFICATIONS.includes(entry.classification)) {
    throw new Error(`${where}: classification ${entry.classification} is not one of ${CLASSIFICATIONS.join(" | ")}`);
  }
  requireTextList(where, "symbols", entry.symbols, true);
  requireTextList(where, "unreachable", entry.unreachable, true);
  requireTextList(where, "tests", entry.tests, true);
  requireTextList(where, "blocks", entry.blocks);
  // Landed fixes carry their proof; open gaps carry none.
  if (entry.classification === "already shipped") {
    if (entry.tests.length === 0) throw new Error(`${where}: an already-shipped fix must name its tests`);
    requireText(where, "landedIn", entry.landedIn);
  }
  if (entry.classification === "real" && entry.tests.length > 0) {
    throw new Error(`${where}: a still-real gap cannot carry landed tests`);
  }
  if (entry.classification === "partially shipped" && entry.tests.length === 0 && entry.landedIn === null) {
    throw new Error(`${where}: a partially-shipped gap must name what landed`);
  }
}

/** Print the shape report. Called at load, so the counts are always emitted. */
export function report(entries: readonly RegistryEntry[] = REGISTRY): void {
  const roles = roleCounts(entries);
  const tiers = tierCounts(entries);
  const parts = byKind(entries);
  console.log(`registry: ${entries.length} entries — ${parts.surfaces.length} surface, ${parts.fixes.length} framework-fix`);
  console.log(`registry: roles — natural ${roles.natural}, repurposed ${roles.repurposed}, forced ${roles.forced}`);
  console.log(
    `registry: tiers — stable ${tiers.stable}, experimental ${tiers.experimental}, internal ${tiers.internal}, deprecation-candidate ${tiers["deprecation-candidate"]}`,
  );
  const screens = new Set(parts.surfaces.map((entry) => entry.screen));
  console.log(`registry: screens covered — ${[...screens].sort().join(", ")}`);
}

report();

Deno.test("registry: every entry carries the full field set for its kind", () => {
  if (REGISTRY.length === 0) throw new Error("the registry is empty");
  for (const entry of surfaces) checkSurface(entry);
  for (const entry of fixes) checkFix(entry);
});

Deno.test("registry: ids are unique and every vocabulary value is drawn from the vocabulary", () => {
  const seen = new Set<string>();
  for (const entry of REGISTRY) {
    if (seen.has(entry.id)) throw new Error(`duplicate registry id ${entry.id}`);
    seen.add(entry.id);
  }
  for (const tier of TIERS) {
    if (!surfaces.some((entry) => entry.tier === tier)) {
      console.log(`registry: note — no surface entry ships at tier ${tier}`);
    }
  }
});

Deno.test("registry: every entry's symbol reference resolves inside the registry", () => {
  const declared = new Set<string>();
  for (const entry of surfaces) for (const symbol of entry.symbols) declared.add(symbol);
  const unreachable = new Set<string>();
  for (const entry of fixes) for (const symbol of entry.unreachable) unreachable.add(symbol);
  const referenced = new Set<string>();
  for (const entry of REGISTRY) for (const symbol of entry.symbols) referenced.add(symbol);
  for (const symbol of referenced) {
    if (!declared.has(symbol)) {
      throw new Error(`symbol ${symbol} is referenced by the registry but no surface entry declares it`);
    }
  }
  for (const symbol of unreachable) {
    if (declared.has(symbol)) {
      throw new Error(`symbol ${symbol} is called unreachable AND declared as covered`);
    }
  }
  const ids = new Set(REGISTRY.map((entry) => entry.id));
  for (const entry of fixes) {
    for (const blocked of entry.blocks) {
      if (!ids.has(blocked)) throw new Error(`${entry.id}: blocks ${blocked}, which is not in the registry`);
    }
  }
  if (referenced.size === 0) throw new Error("no entry references a framework symbol");
});

Deno.test("registry: the forced-feature disposition is explicit, not padding", () => {
  const bySymbol = (symbol: string): SurfaceEntry => {
    const hit = surfaces.filter((entry) => entry.symbols.includes(symbol));
    if (hit.length !== 1) throw new Error(`${symbol}: expected exactly one owning entry, got ${hit.length}`);
    return hit[0]!;
  };
  const charts = bySymbol("Chart");
  const progress = bySymbol("Progress");
  const spinner = bySymbol("Spinner");
  const canvas = bySymbol("Canvas");
  const markdown = bySymbol("MarkdownView");
  if (charts.role !== "forced" || progress.role !== "forced" || spinner.role !== "forced") {
    throw new Error("Charts, Progress and Spinner must be forced");
  }
  if (canvas.role !== "repurposed") throw new Error("Canvas must be repurposed, not forced");
  if (markdown.role !== "forced") throw new Error("MarkdownView must be forced");
  if (spinner.droppable !== true || !spinner.disposition?.includes("WEAK")) {
    throw new Error("Spinner must be marked WEAK and droppable");
  }
  if (canvas.droppable !== true || !canvas.disposition?.includes("REPURPOSED")) {
    throw new Error("Canvas must be marked REPURPOSED and droppable");
  }
  if (charts.droppable !== false || progress.droppable !== false) {
    throw new Error("the render-profile chart and the scan bar are earned, not droppable");
  }
  for (const entry of [charts, progress, spinner, canvas, markdown]) {
    if (entry.disposition === null || entry.disposition.length < 40) {
      throw new Error(`${entry.id}: a forced feature needs a real disposition, not a word`);
    }
  }
});

Deno.test("registry: the role report prints a NON-ZERO count for every role", () => {
  report();
  const roles = roleCounts();
  for (const role of ROLES) {
    if (roles[role] === 0) throw new Error(`role ${role} has no entries — the registry is not complete`);
  }
  const tiers = tierCounts();
  if (tiers.stable === 0) throw new Error("no stable surface is exercised");
  if (tiers.experimental === 0) throw new Error("no experimental surface is exercised");
  if (tiers["deprecation-candidate"] === 0) {
    throw new Error("the audit's one deprecation-candidate is unaccounted for");
  }
  const landed = fixes.filter((entry) => entry.classification === "already shipped").length;
  const open = fixes.filter((entry) => entry.classification === "real").length;
  if (landed === 0 || open === 0) throw new Error("the fix ledger must hold landed and open gaps alike");
  console.log(`registry: fix ledger — ${landed} landed, ${open} still real`);
});

// ---------------------------------------------------------------------------
// HALF TWO — the live surface (contract.ts). The contract logic is a PURE
// function over the registry, the live export maps and the exclusion list, so
// the mutation below hands it an edited registry from memory instead of
// rewriting this file.
// ---------------------------------------------------------------------------

Deno.test("contract: the registry covers every live export, and names no ghost", () => {
  const surface = enumerateLiveSurface();
  if (surface.symbols.size === 0) throw new Error("the live surface is empty — the barrels did not load");
  for (const barrel of ["core", "react", "solid"] as const) {
    if (surface.counts[barrel].values === 0) throw new Error("no " + barrel + " value export was enumerated");
  }
  const violations = findViolations(REGISTRY, surface, EXCLUDED);
  reportContract(surface, REGISTRY, EXCLUDED, violations);
  if (violations.length > 0) {
    const lines = violations.map((violation) => "  " + violation.kind + ": " + violation.detail);
    throw new Error("the completeness contract is violated:\n" + lines.join("\n"));
  }
});

Deno.test("contract: MUTATION — dropping one covered symbol is reported as a violation", () => {
  const surface = enumerateLiveSurface();
  const shipped = findViolations(REGISTRY, surface, EXCLUDED);
  if (shipped.length > 0) throw new Error("the shipped registry must be clean before the mutation, got " + shipped.length);
  // One shipped value export, dropped from the ONE entry that names it:
  // brailleCell is painted by core-canvas-minimap and by no other entry.
  const victim = "brailleCell";
  const mutated: readonly RegistryEntry[] = REGISTRY.map((entry): RegistryEntry => {
    if (entry.kind !== "surface" || entry.id !== "core-canvas-minimap") return entry;
    return { ...entry, symbols: entry.symbols.filter((symbol) => symbol !== victim) };
  });
  const violations = findViolations(mutated, surface, EXCLUDED);
  const hit = violations.filter((violation) => violation.kind === "unregistered-value" && violation.name === victim);
  if (hit.length !== 1) {
    throw new Error("dropping " + victim + " must report exactly one unregistered-value, got " + JSON.stringify(violations));
  }
  console.log("contract: mutation — " + victim + " dropped from core-canvas-minimap -> " + hit[0]!.detail);
});
