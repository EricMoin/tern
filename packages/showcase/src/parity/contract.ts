//! The showcase completeness contract — HALF TWO: the LIVE surface.
//!
//! HALF ONE (registry_test.ts) proves the registry is well-formed and
//! SELF-resolving: every field present, every id unique, every symbol an entry
//! names declared inside the registry. That is a claim about the REGISTRY. It
//! cannot be a claim about the FRAMEWORK — a registry can be perfectly
//! self-consistent and still describe a framework that is not there: an entry
//! naming a symbol no barrel exports, or a barrel export no entry mentions.
//! This half closes both directions against the real export maps:
//!
//!   COVERAGE — every live export is named by a registry entry or explicitly
//!     excluded with a reason. A wildcard is not an exclusion.
//!   GHOSTS   — every symbol a registry entry names exists in the live surface.
//!   DRIFT    — the docGap flag and the measured INVENTORY_GAP stay in
//!     agreement, and every unaudited name stays accounted for.
//!
//! THE EXPORT MAP IS THE SOURCE OF TRUTH, NOT THE PROSE. docs/components.md
//! :105-126 lists components and omits Box, Tabs, Progress, Tree, Canvas,
//! Chart, BarChart and Sparkline, so a coverage claim read off that list is
//! wrong in eight places. The live surface is read from the barrels instead.
//!
//! WHERE THE ERASED TYPE SURFACE COMES FROM. A runtime namespace object exposes
//! VALUES only: an 'export type' is erased, so Object.keys() cannot see
//! TernAddon, KeyCombo or SelectionRange — and an entry may name them. The type
//! surface is PARSED from the barrels' export blocks (parseExportBlocks below)
//! and recorded in barrel-types.ts, together with the compiler witnesses that
//! keep the record honest.
//!
//! GAP (framework, not worked around silently): the parse cannot re-run in the
//! canonical test run. 'deno test --allow-env=NODE_ENV' (the run line at
//! registry_test.ts:17) grants no read permission, and Deno offers no
//! permission-free way to obtain a module's source text, so readBarrelSource
//! below sees the read permission in state 'prompt' and SKIPS the parse rather
//! than stalling on a prompt it cannot answer. The compiler witnesses in
//! barrel-types.ts carry the guarantee instead; this file re-parses and reports
//! source-parse-drift whenever a wider permission set allows it.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/parity/

import {
  BARRELS, BARREL_SOURCES, barrelValues, recordedTypes, type BarrelId,
} from "./barrel-types.ts";
import { INVENTORY_GAP, ROLES, type RegistryEntry } from "./registry-editor.ts";
import { REGISTRY, roleCounts, tierCounts } from "./registry-shell.ts";

/** A name is live either as a runtime VALUE or as an erased TYPE. */
export type ExportKind = "value" | "type";
export type { BarrelId } from "./barrel-types.ts";

// ---------------------------------------------------------------------------
// The static parse of a barrel's export blocks.
// ---------------------------------------------------------------------------

/** What one barrel's export blocks declare. */
export interface ParsedExports {
  readonly values: readonly string[];
  readonly types: readonly string[];
  /** Export forms this parser cannot read, e.g. 'export * from'. */
  readonly unreadable: readonly string[];
}

const BLOCK = /^\s*export\s+(type\s+)?\{/;
const DECL = /^\s*export\s+(type\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/;
const ALIAS = /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*[=<]/;
const IFACE = /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/;
const STAR = /^\s*export\s+\*/;

/** The exported name of one 'export { … }' specifier ('a', 'a as b', 'type a'). */
function specifierName(raw: string): { name: string; isType: boolean } | null {
  const parts = raw.trim().split(/\s+/).filter((part) => part !== "");
  if (parts.length === 0) return null;
  const isType = parts[0] === "type";
  const name = isType ? parts[1] : parts[0];
  const as = parts.indexOf("as");
  const exported = as >= 0 ? parts[as + 1] : name;
  return exported === undefined ? null : { name: exported, isType };
}

/**
 * Parse a barrel's top-level export statements into value and erased-type
 * names. Line-anchored: a statement must begin its line, which is what keeps
 * the prose in the header comments (and any code sample inside them) out.
 */
export function parseExportBlocks(source: string): ParsedExports {
  const values: string[] = [];
  const types: string[] = [];
  const unreadable: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (STAR.test(line)) { unreadable.push(line.trim()); continue; }
    const alias = ALIAS.exec(line);
    if (alias !== null) { types.push(alias[1]!); continue; }
    const iface = IFACE.exec(line);
    if (iface !== null) { types.push(iface[1]!); continue; }
    const decl = DECL.exec(line);
    if (decl !== null) { (decl[1] === "type" ? types : values).push(decl[2]!); continue; }
    if (!BLOCK.test(line)) continue;
    let text = line; // a block statement: collect lines until the closing brace
    while (!text.includes("}") && i + 1 < lines.length) { i += 1; text += "\n" + (lines[i] ?? ""); }
    const open = text.indexOf("{");
    const close = text.indexOf("}", open + 1);
    if (open < 0 || close < 0) { unreadable.push(text.trim().slice(0, 60)); continue; }
    const isTypeBlock = /^\s*export\s+type\s+\{/.test(text);
    for (const raw of text.slice(open + 1, close).split(",")) {
      const spec = specifierName(raw);
      if (spec === null) continue;
      (isTypeBlock || spec.isType ? types : values).push(spec.name);
    }
  }
  return { values, types, unreadable };
}

// ---------------------------------------------------------------------------
// The live surface.
// ---------------------------------------------------------------------------

/** One name the barrels export, and how. */
export interface LiveSymbol {
  readonly name: string;
  readonly barrels: readonly BarrelId[];
  readonly kinds: readonly ExportKind[];
}

/** The live value and erased-type counts of one barrel. */
export interface LiveCount {
  readonly values: number;
  readonly types: number;
}

/** The live surface: what the three barrels actually export, right now. */
export interface LiveSurface {
  readonly symbols: ReadonlyMap<string, LiveSymbol>;
  readonly counts: Readonly<Record<BarrelId, LiveCount>>;
  /** True when the barrel sources were read and parsed (needs read access). */
  readonly parsedSource: boolean;
  /** Names where the live parse disagrees with the recorded lists. */
  readonly drift: readonly string[];
  /** Export forms the parser could not read. */
  readonly unreadable: readonly string[];
}

/** Read a barrel source, or null when the sandbox grants no read access. */
function readBarrelSource(url: URL): string | null {
  try {
    // querySync never prompts: a test can ask about a permission it lacks
    // without stalling on a prompt it cannot answer.
    if (Deno.permissions.querySync({ name: "read", path: url }).state !== "granted") return null;
    return Deno.readTextFileSync(url);
  } catch {
    return null;
  }
}

/** The names of 'from' that 'against' does not hold. */
function difference(from: readonly string[], against: ReadonlySet<string>): string[] {
  return from.filter((name) => !against.has(name));
}

/** Enumerate the live surface from the barrels' export maps. */
export function enumerateLiveSurface(): LiveSurface {
  const symbols = new Map<string, LiveSymbol>();
  const counts: Record<BarrelId, LiveCount> = {
    core: { values: 0, types: 0 }, react: { values: 0, types: 0 }, solid: { values: 0, types: 0 },
  };
  const drift: string[] = [];
  const unreadable: string[] = [];
  let parsedSource = false;
  for (const barrel of BARRELS) {
    const values = barrelValues(barrel);
    let types: readonly string[] = recordedTypes(barrel);
    const source = readBarrelSource(BARREL_SOURCES[barrel]);
    if (source !== null) {
      parsedSource = true;
      const parsed = parseExportBlocks(source);
      types = parsed.types;
      for (const form of parsed.unreadable) unreadable.push(barrel + ": " + form);
      const live = new Set(values);
      const recorded = new Set(recordedTypes(barrel));
      const parsedValues = new Set(parsed.values);
      const parsedTypes = new Set(parsed.types);
      for (const name of difference(parsed.types, recorded)) drift.push(barrel + ": type not recorded — " + name);
      for (const name of difference([...recorded], parsedTypes)) drift.push(barrel + ": recorded type not exported — " + name);
      for (const name of difference(parsed.values, live)) drift.push(barrel + ": parsed value not in Object.keys — " + name);
      for (const name of difference(values, parsedValues)) drift.push(barrel + ": Object.keys name not parsed — " + name);
    }
    counts[barrel] = { values: values.length, types: types.length };
    const named: readonly (readonly [string, ExportKind])[] = [
      ...values.map((name) => [name, "value"] as const),
      ...types.map((name) => [name, "type"] as const),
    ];
    for (const [name, kind] of named) {
      const found = symbols.get(name);
      if (found === undefined) { symbols.set(name, { name, barrels: [barrel], kinds: [kind] }); continue; }
      const barrels = [...found.barrels];
      const kinds = [...found.kinds];
      if (!barrels.includes(barrel)) barrels.push(barrel);
      if (!kinds.includes(kind)) kinds.push(kind);
      symbols.set(name, { name, barrels, kinds });
    }
  }
  return { symbols, counts, parsedSource, drift, unreadable };
}

// ---------------------------------------------------------------------------
// The exclusions: one reason per category, every name spelled out.
// ---------------------------------------------------------------------------

/** A named group of live exports no registry entry claims, and why. */
export interface ExclusionCategory {
  /** One reason, shared by every name under it. */
  readonly reason: string;
  readonly names: readonly string[];
}

/**
 * The live exports no registry entry names. There is no wildcard and no prefix
 * rule — every NAME is listed — while the REASON is shared per category,
 * because "why is this not covered" has one answer per group.
 */
export const EXCLUDED: readonly ExclusionCategory[] = [
  {
    reason: "erased type-only exports of @tern-tui/core no entry names: a type carries no behaviour to exercise, so the only claim here is that the name is real",
    names: ["HighlightSpanJs", "StyleRunJs", "FocusHandler", "KeyHandler", "LifecycleHandler", "MouseHandler", "PasteHandler", "ResizeHandler"],
  },
  {
    reason: "brand constants: every barrel exports name/version metadata, which is not a feature and has no screen",
    names: ["name", "version"],
  },
  {
    reason: "core value exports no entry names: the selection-clock test seam, the streaming auto-scroll setter (the app drives the tail through syncStreamTail/followTail instead), and two checkbox colour constants",
    names: ["setSelectionClockForTesting", "setStreamAutoScroll", "CHECK_PRIMARY_BG", "CHECK_PRIMARY_FG"],
  },
  {
    reason: "INVENTORY_GAP names with no audited row that no entry names either: live, measured as unaudited, and accounted for here instead of being dropped or claimed as covered",
    names: ["checkboxLabels", "radioOptions", "selectOptions", "toggleLabels"],
  },
  {
    reason: "INVENTORY_GAP name a fix-ledger entry declares unreachable: exported by textwrap.ts but unusable from the app's data shape (see fix-visible-scroll-needs-string-array)",
    names: ["visibleScroll"],
  },
  {
    reason: "types only the react/solid layers declare and no entry names: the reconciler's input/paste options, the Solid subscribe/startSpinner option objects, and the host-component prop aliases",
    names: [
      "UseInputHandler", "UseInputOptions", "UsePasteHandler", "UsePasteOptions",
      "UseFocusOptions", "UseFocusTraversalOptions", "TernNodeProps", "BoxProps", "TextProps",
      "SubscribeInputOptions", "SubscribePasteOptions", "StartSpinnerOptions",
    ],
  },
  {
    reason: "the raw solid-js RendererOptions object, exported for embedders and tests; the solid entry claims the destructured primitives instead",
    names: ["rendererOptions"],
  },
];

/** Every excluded name, flattened. */
export function excludedNames(categories: readonly ExclusionCategory[] = EXCLUDED): ReadonlySet<string> {
  const names = new Set<string>();
  for (const category of categories) for (const name of category.names) names.add(name);
  return names;
}

/** Every name the registry claims: surface entry symbols and fix entry symbols. */
export function coveredNames(entries: readonly RegistryEntry[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of entries) for (const symbol of entry.symbols) names.add(symbol);
  return names;
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/** How the registry and the live surface disagree. */
export type ViolationKind =
  | "unregistered-value" | "unregistered-type" | "ghost-symbol" | "excluded-not-live"
  | "exclusion-of-covered" | "duplicate-exclusion" | "empty-exclusion" | "gap-not-live"
  | "gap-unaccounted" | "doc-gap-mismatch" | "recorded-type-is-a-value" | "source-parse-drift"
  | "unreadable-export-form";

/** One disagreement, reported with the name it is about. */
export interface Violation {
  readonly kind: ViolationKind;
  readonly name: string;
  readonly detail: string;
}

/**
 * The whole contract as a PURE function: no file read, no global state, no
 * mutation of its arguments — which is what lets the mutation check call it on
 * a registry with one entry edited in memory (see registry_test.ts).
 */
export function findViolations(
  entries: readonly RegistryEntry[],
  surface: LiveSurface,
  excluded: readonly ExclusionCategory[] = EXCLUDED,
): Violation[] {
  const violations: Violation[] = [];
  const push = (kind: ViolationKind, name: string, detail: string) => violations.push({ kind, name, detail });
  const covered = coveredNames(entries);
  const excludedReason = new Set<string>();
  for (const category of excluded) {
    if (category.reason.trim() === "") push("empty-exclusion", "<category>", "an exclusion category carries no reason");
    if (category.names.length === 0) push("empty-exclusion", "<category>", "an exclusion category lists no names");
    for (const name of category.names) {
      if (excludedReason.has(name)) push("duplicate-exclusion", name, "excluded twice — an exclusion must have exactly one reason");
      excludedReason.add(name);
      if (!surface.symbols.has(name)) push("excluded-not-live", name, "excluded, but no barrel exports that name");
      if (covered.has(name)) push("exclusion-of-covered", name, "excluded, but a registry entry names it — coverage and exclusion must not overlap");
    }
  }

  for (const [name, symbol] of surface.symbols) {
    if (covered.has(name) || excludedReason.has(name)) continue;
    const kind = symbol.kinds.includes("value") ? "unregistered-value" : "unregistered-type";
    push(kind, name, name + " is a live " + symbol.kinds.join("+") + " export of " + symbol.barrels.join("/") +
      " that no registry entry names and no exclusion lists");
  }

  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      if (!surface.symbols.has(symbol)) push("ghost-symbol", symbol, entry.id + " names " + symbol + ", which no barrel exports");
    }
  }

  // A recorded type name must be ERASED: if Object.keys() shows it, the record
  // is wrong and the ghost check above would be answering the wrong question.
  for (const barrel of BARRELS) {
    const values = new Set(barrelValues(barrel));
    for (const name of recordedTypes(barrel)) {
      if (values.has(name)) push("recorded-type-is-a-value", name, barrel + " exports " + name + " as a runtime value, so it is not an erased type");
    }
  }

  for (const entry of entries) {
    if (entry.kind !== "surface") continue;
    const gaps = entry.symbols.filter((symbol) => INVENTORY_GAP.includes(symbol));
    if (gaps.length > 0 && !entry.docGap) {
      push("doc-gap-mismatch", entry.id, entry.id + " names " + gaps.join(", ") + ", which have no inventory row, so docGap must be true");
    }
    if (entry.docGap && gaps.length === 0) push("doc-gap-mismatch", entry.id, entry.id + " sets docGap but names no inventory-gap symbol");
  }

  const unreachable = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "framework-fix") for (const name of entry.unreachable) unreachable.add(name);
  }
  for (const name of INVENTORY_GAP) {
    if (!surface.symbols.has(name)) push("gap-not-live", name, "INVENTORY_GAP cites a name the barrels do not export");
    else if (!covered.has(name) && !excludedReason.has(name) && !unreachable.has(name)) {
      push("gap-unaccounted", name, "an unaudited name is neither covered, nor excluded, nor declared unreachable");
    }
  }

  for (const name of surface.drift) push("source-parse-drift", name, "the live parse and the recorded list disagree: " + name);
  for (const form of surface.unreadable) {
    push("unreadable-export-form", form, "the parser cannot read this export form, so the surface may be incomplete");
  }
  return violations;
}

/** The role counts of the registry, in vocabulary order: natural, repurposed, forced. */
export function reportRoles(entries: readonly RegistryEntry[] = REGISTRY): string {
  const roles = roleCounts(entries);
  return ROLES.map((role) => role + " " + roles[role]).join(", ");
}

/** Print the whole contract: counts, the forced list, the exclusions, the gap. */
export function reportContract(
  surface: LiveSurface,
  entries: readonly RegistryEntry[] = REGISTRY,
  excluded: readonly ExclusionCategory[] = EXCLUDED,
  violations: readonly Violation[] = [],
): void {
  const lines: string[] = [];
  const counts = BARRELS.map((barrel) =>
    barrel + " " + surface.counts[barrel].values + " values + " + surface.counts[barrel].types + " types").join(", ");
  const surfaces = entries.filter((entry) => entry.kind === "surface").length;
  lines.push("contract: live surface — " + counts + " (" + surface.symbols.size + " distinct names; source-parsed: " + surface.parsedSource + ")");
  lines.push("contract: registry — " + entries.length + " entries (" + surfaces + " surface, " + (entries.length - surfaces) + " framework-fix)");
  lines.push("contract: roles — " + reportRoles(entries));
  lines.push("contract: tiers — " + Object.entries(tierCounts(entries)).map(([tier, count]) => tier + " " + count).join(", "));
  for (const entry of entries) {
    if (entry.kind === "surface" && entry.role === "forced") {
      lines.push("contract: forced — " + entry.id + " [" + entry.symbols.join(", ") + "] droppable=" + entry.droppable);
    }
  }
  const excludedSet = excludedNames(excluded);
  lines.push("contract: excluded — " + excludedSet.size + " names, every one listed, none by wildcard");
  const gapCovered = INVENTORY_GAP.filter((name) => coveredNames(entries).has(name)).length;
  const gapExcluded = INVENTORY_GAP.filter((name) => excludedSet.has(name)).length;
  lines.push("contract: inventory gap — " + INVENTORY_GAP.length + " unaudited names: " + gapCovered + " covered, " +
    gapExcluded + " excluded, " + (INVENTORY_GAP.length - gapCovered - gapExcluded) + " declared unreachable");
  lines.push("contract: violations — " + violations.length);
  for (const violation of violations) lines.push("contract: VIOLATION " + violation.kind + " — " + violation.detail);
  for (const line of lines) console.log(line);
}
