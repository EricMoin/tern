//! The showcase completeness registry — part 1 of 3: the entry vocabulary and
//! the EDITOR surface.
//
// One registry, three files, one array: `registry-shell.ts` concatenates
// `EDITOR_ENTRIES`, `PANE_ENTRIES` and `SHELL_ENTRIES` into `REGISTRY`. The
// split is by SURFACE, not by kind, so every part carries the framework-fix
// entries of its own domain and a fix sits beside the feature that hit it.
//
// This file is the BASE module of the split. The vocabulary every part shares —
// the id unions, the two entry shapes, the doc-citation helper and the
// inventory-gap list — lives here, so `registry-panes.ts` and
// `registry-shell.ts` depend on it and never back. The runtime import graph is
// acyclic by construction: shell -> {panes, editor}, panes -> editor,
// editor -> nothing.
//
// WHAT AN ENTRY IS. One entry is one claim the app makes about the SHIPPED
// framework surface. It names the framework symbols it exercises, the tier the
// audit gave them (docs/api-stability.md), how the app uses them (natural /
// repurposed / forced), which renderer layer paints them, which screen they live
// on, and the key or the headless call that reaches them. A symbol the app
// cannot reach headlessly cannot be registered — that is what keeps this a
// proof of coverage rather than an inventory of the framework.
//
// A "forced" or "repurposed" entry is not padding: it carries an explicit
// disposition and a droppable flag, so the reader can see what the app would
// lose by dropping it. "Natural" means the feature is why the symbol exists.

/** The tier vocabulary — exactly the four rows of docs/api-stability.md's taxonomy. */
export type Tier = "stable" | "experimental" | "internal" | "deprecation-candidate";

/** How honestly the app uses the symbol: its designed job, a re-use, or a stretch. */
export type Role = "natural" | "repurposed" | "forced";

/** The three renderer layers held to ScreenPlan identity (packages/showcase/src/layers/). */
export type LayerId = "core" | "react" | "solid";

/** The screens the plan knows. A registry entry belongs to exactly one. */
export type ScreenId =
  | "editor" | "sidebar" | "chooser" | "find" | "replace" | "help"
  | "preview" | "profile" | "minimap" | "a11y" | "parity" | "shell"
  | "palette" | "preferences" | "theme" | "diff";

/** How a framework gap stands today. */
export type Classification = "real" | "already shipped" | "partially shipped";

/** A framework symbol the app exercises, and the claim it makes about it. */
export interface SurfaceEntry {
  readonly kind: "surface";
  /** Stable id. Framework-fix entries and the test refer to entries by this. */
  readonly id: string;
  /** The shipped framework symbols this entry exercises — the coverage claim. */
  readonly symbols: readonly string[];
  /** What the app does with them, in one line. */
  readonly feature: string;
  /** The shipped tier, read from docs/api-stability.md. */
  readonly tier: Tier;
  /** The citation the tier was read from (see {@link doc}). */
  readonly tierBasis: string;
  /** True when the shipped surface exists but the audit inventory has no row for
   * it, so the tier is inherited from the module's audited siblings. */
  readonly docGap: boolean;
  readonly role: Role;
  readonly layers: readonly LayerId[];
  readonly screen: ScreenId;
  /** The canonical combo, or null when only a programmatic path reaches it. */
  readonly keybinding: string | null;
  /** The headless entry point that reaches it with no renderer attached. */
  readonly headless: string;
  /** Required for repurposed/forced: what the app gets, and why it is honest. */
  readonly disposition: string | null;
  /** True when the app still works with this entry deleted. */
  readonly droppable: boolean;
}

/** A framework bug, or a missing/awkward API, the app hit — DELIVERABLE C. */
export interface FrameworkFixEntry {
  readonly kind: "framework-fix";
  readonly id: string;
  /** Shipped framework symbols involved; each must resolve inside the registry. */
  readonly symbols: readonly string[];
  /** Symbols that are NOT reachable from the app — not exported at all, or
   * exported but unusable from the app's data shape. Never a name a surface
   * entry declares as covered. */
  readonly unreachable: readonly string[];
  /** One line naming the gap. */
  readonly feature: string;
  /** The exact file:line the gap lives at. */
  readonly file: string;
  /** What you do to hit it. */
  readonly reproduction: string;
  readonly classification: Classification;
  /** What was done (already shipped) or what the fix is. */
  readonly fix: string;
  /** The app-level case that would have caught it. */
  readonly regression: string;
  /** The tests that prove a landed fix; empty for a gap that is still real. */
  readonly tests: readonly string[];
  /** What landed it, or null while the gap is open. */
  readonly landedIn: string | null;
  /** Registry ids this gap distorts — the entries that pay for it. */
  readonly blocks: readonly string[];
}

export type RegistryEntry = SurfaceEntry | FrameworkFixEntry;

/** Every tier, in taxonomy order. */
export const TIERS: readonly Tier[] = ["stable", "experimental", "internal", "deprecation-candidate"];
/** Every role. All three must end up non-empty. */
export const ROLES: readonly Role[] = ["natural", "repurposed", "forced"];
/** Every layer. */
export const LAYERS: readonly LayerId[] = ["core", "react", "solid"];
/** Every screen. */
export const SCREENS: readonly ScreenId[] = [
  "editor", "sidebar", "chooser", "find", "replace", "help",
  "preview", "profile", "minimap", "a11y", "parity", "shell",
  "palette", "preferences", "theme", "diff",
];
/** The three layers, for the entries every emitter paints. */
export const ALL_LAYERS: readonly LayerId[] = ["core", "react", "solid"];

/** Cite an audited symbol row in docs/api-stability.md. */
export function doc(row: number): string {
  return `docs/api-stability.md:${row}`;
}

/** Why a tier is claimed for a symbol the audit's inventory never listed. */
export const GAP_BASIS =
  "no row in the docs/api-stability.md inventory; tier inherited from the audited siblings of its own module";

/**
 * Symbols `packages/core/src/index.ts` exports that the audit inventory has no
 * row for — measured, not guessed: 20 of the barrel's exported names have no
 * table row, so 20 symbols the app calls have no audited tier. Everything here
 * is `stable` by module inheritance (each sits in an export statement beside
 * audited stable siblings), and every entry that cites one sets `docGap`.
 */
export const INVENTORY_GAP: readonly string[] = [
  "HighlightEdit", "HighlightEditResult", "caretDisplayIn", "caretDisplayRow",
  "charAtDisplayCol", "checkboxLabels", "currentDisplayCol", "declareVirtualContent",
  "displayBase", "editHighlight", "logicalAtDisplayRow", "offsetOfCol", "radioOptions",
  "selectOptions", "textareaHeight", "textareaWidth", "toggleLabels",
  "totalDisplayRows", "visibleScroll", "wrapCount",
];

/**
 * The EDITOR surface: text entry, wrap and caret geometry, highlighting, and
 * the selection the caret drives. Every entry here is on the plan's critical
 * path — the editor is the one screen the app cannot be dropped into.
 */
export const EDITOR_ENTRIES: readonly RegistryEntry[] = [
  {
    kind: "surface",
    id: "core-textarea-window-seam",
    symbols: ["Textarea", "TextareaProps", "TextareaState", "editTextareaKey", "pasteIntoTextarea"],
    feature: "The framework's own editing widget is not embedded; the windowing seam its fix extracted is what the app consumes",
    tier: "stable",
    tierBasis: doc(114),
    docGap: false,
    role: "repurposed",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "the seam: wrapLineWithOffsets + WrapCache.rowsOf (core/editTextareaKey is the widget path the app replaces)",
    disposition: "The showcase owns its Buffer, LineIndex and WrapCache, so it paints through plan.ts instead of mounting Textarea. The component is kept in the registry because its G1 fix produced the seam the app DOES use — the widget's policy is dogfooded even though the widget is not.",
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-wrap-math",
    symbols: ["wrapLineWithOffsets", "measureText"],
    feature: "Every display row, its source offsets and its cell width",
    tier: "stable",
    tierBasis: doc(116),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "WrapCache.rowsOf(line, text) / viewport.cellWidth(text)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-caret-display",
    symbols: ["offsetOfCol", "caretDisplayIn", "charAtDisplayCol", "textareaWidth"],
    feature: "Move the caret by display cell, and map a cell back to a source column",
    tier: "stable",
    tierBasis: GAP_BASIS,
    docGap: true,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: "left / right / ctrl+left / ctrl+right",
    headless: "motions.applyMotion -> offsetOfCol/caretDisplayIn (viewport.displayCellOf)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-display-rows",
    symbols: ["caretDisplayRow", "logicalAtDisplayRow", "displayBase", "currentDisplayCol", "totalDisplayRows", "textareaHeight", "wrapCount"],
    feature: "The row a logical line starts on, the row a cell lands on, and the document's display height",
    tier: "stable",
    tierBasis: GAP_BASIS,
    docGap: true,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: "up / down / ctrl+up / ctrl+down",
    headless: "viewport.computeViewport(input) -> the editor window the plan lays out",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-highlight-stream",
    symbols: ["highlightCode", "incrementalHighlight", "resetIncrementalHighlightCache", "Span"],
    feature: "Syntax spans for the visible window, produced incrementally as the buffer is edited",
    tier: "stable",
    tierBasis: doc(249),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "plan.buildPlan reads the spans; resetIncrementalHighlightCache is the internal sibling it drops with",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-highlight-edit",
    symbols: ["editHighlight", "HighlightEdit", "HighlightEditResult"],
    feature: "Absorb one mid-file edit and return only the reworked span window",
    tier: "stable",
    tierBasis: GAP_BASIS,
    docGap: true,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "edits.applyEdit -> editHighlight(start, oldEnd, newText) on the keystroke path",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-selection-model",
    symbols: ["SelectionRange", "SELECTION_DOUBLE_CLICK_MS", "selectWordAt", "startSelection", "dragSelection", "endSelection", "copySelection", "selectionKey"],
    feature: "Word/line/paragraph selection, mouse drag, and copy-on-release",
    tier: "experimental",
    tierBasis: doc(104),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: "shift+arrows / ctrl+a / drag",
    headless: "SelectionModel.press/dragTo/select/doubleClick + copySelection",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-mouse-and-events",
    symbols: ["wheelScroll", "MouseEventJs", "KeyEvent", "TernEventJs", "LifecycleEvent"],
    feature: "The event DTOs every layer feeds the one dispatcher, and the wheel route into the viewport",
    tier: "stable",
    tierBasis: doc(289),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "HeadlessApp.dispatch(event) — the layer tests replay recorded DTOs",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-modal-overlay",
    symbols: ["Modal", "ModalProps", "openModal", "closeModal", "MODAL_Z_INDEX", "MODAL_BACKDROP_BG"],
    feature: "The find/replace and help overlays ride the framework modal: backdrop, z-order, open/close",
    tier: "stable",
    tierBasis: doc(243),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "help",
    keybinding: "f1 (open) / escape (close)",
    headless: "commands.applyCommand -> { kind: \"modal\", action: \"push\" | \"pop\" }",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-input-prompt",
    symbols: ["Input", "InputProps", "editKey", "pasteInto"],
    feature: "The single-line prompt inside the modal — the find query and the replace text",
    tier: "stable",
    tierBasis: doc(110),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "find",
    keybinding: "ctrl+f (open the prompt)",
    headless: "SearchSession.open(query) / setCaseSensitive(on)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "framework-fix",
    id: "fix-textarea-per-keystroke-remeasure",
    symbols: ["Textarea", "wrapLineWithOffsets", "textareaWidth"],
    unreachable: [],
    feature: "G1 — the Textarea path re-measured the whole document on every keystroke",
    file: "packages/core/src/textarea.ts:143 (the wrap call over the windowed line the seam replaced)",
    reproduction: "Type into a very large document through the Textarea path: the caret's display row is found by walking the file, so one keystroke costs O(file).",
    classification: "already shipped",
    fix: "The windowing seam was extracted and exported and the split produced packages/core/src/textwrap.ts, so the caret/window math is a pure function of (line, width) rather than of the document.",
    regression: "Showcase case: one keystroke at the end of a 100k-line buffer must not cost more than one keystroke in a 10-line buffer — assert only the caret's line was measured.",
    tests: ["packages/core/src/textarea_test.ts:732 — 'textarea windowing seam is public and matches the composed window'"],
    landedIn: "the textwrap.ts split; the seam re-exported at packages/core/src/index.ts:252",
    blocks: ["core-textarea-window-seam", "core-wrap-math"],
  },
  {
    kind: "framework-fix",
    id: "fix-highlighter-midfile-edit",
    symbols: ["highlightCode", "incrementalHighlight", "editHighlight", "Span"],
    unreachable: [],
    feature: "G3 — the highlighter could not absorb a mid-file edit",
    file: "src/core/tern-highlight/src/lib.rs:422 + src/bindings/tern-node/src/convert.rs:167 + packages/core/src/highlight.ts (editHighlight)",
    reproduction: "Append-highlight a file, then edit byte 0: the incremental path had no mid-file entry point, so the caller had to re-run the whole document.",
    classification: "already shipped",
    fix: "IncrementalHighlighter::apply_edit reworks only the changed window; the napi binding returns HighlightEditJs; packages/core/src/highlight.ts:editHighlight wraps it with the UTF-8 byte-offset codec.",
    regression: "Showcase case: insert one character at the top of a large file and assert exactly one highlight window was recomputed and the spliced result equals a full re-highlight.",
    tests: ["packages/core/src/highlight_test.ts:183", "packages/core/src/highlight_test.ts:254"],
    landedIn: "tern-highlight apply_edit + convert.rs HighlightEditJs + highlight.ts editHighlight",
    blocks: ["core-highlight-edit", "core-highlight-stream"],
  },
  {
    kind: "framework-fix",
    id: "fix-grapheme-primitives-unexported",
    symbols: [],
    unreachable: ["clusterRuns", "columnToIndex", "indexToColumn", "lastClusterBefore", "clusterAt", "snapToClusterEnd", "ClusterRun"],
    feature: "The grapheme primitives exist and are tested, but the barrel exports none of them",
    file: "packages/core/src/textutil.ts:209 (clusterRuns), :267 (columnToIndex), :279 (indexToColumn), :290 (lastClusterBefore), :301 (clusterAt), :314 (snapToClusterEnd) — none re-exported by packages/core/src/index.ts:252",
    reproduction: "Ask the framework where a grapheme cluster starts before a column; the only way is to re-implement Intl.Segmenter.",
    classification: "real",
    fix: "Re-export the textutil.ts cluster API from packages/core/src/index.ts:252 and delete the app's copy.",
    regression: "Showcase case: the motions suite's cluster cases (motions_test.ts:34) must run against the framework's clusterRuns instead of the app's clusterBounds; a second implementation is the failure.",
    tests: [],
    landedIn: null,
    blocks: ["core-caret-display", "core-display-rows"],
  },
  {
    kind: "framework-fix",
    id: "fix-caret-math-rewraps-the-line",
    symbols: ["offsetOfCol", "caretDisplayIn", "charAtDisplayCol", "wrapLineWithOffsets"],
    unreachable: ["offsetOfRow", "caretDisplayInRow", "charAtRowDisplayCol"],
    feature: "The caret helpers re-wrap the line they measure, so a motion costs 2-3 fresh wraps",
    file: "packages/core/src/textwrap.ts:218 (offsetOfCol), :242 (caretDisplayIn), :292 (charAtDisplayCol) each call wrapLineWithOffsets internally",
    reproduction: "Hold an arrow key in a wide wrapped line: the app's WrapCache already holds the rows, but every motion re-wraps the same line 2-3 more times.",
    classification: "real",
    fix: "Ship row-taking variants (measure against a caller-supplied row array) so the app can pass the rows its WrapCache already holds. Related: packages/showcase/src/core/viewport.ts:257 flags a missing width helper for the same reason.",
    regression: "Showcase case: count wrapLineWithOffsets calls over a 100-key motion burst in a wrapped buffer — the count must not grow with the motions once the cache is warm.",
    tests: [],
    landedIn: null,
    blocks: ["core-caret-display", "core-display-rows", "core-wrap-math"],
  },
  {
    kind: "framework-fix",
    id: "fix-wrapcache-has-no-batch-splice",
    symbols: ["wrapLineWithOffsets"],
    unreachable: ["spliceLines"],
    feature: "WrapCache moves one row per call, so a 1000-line paste is 1000 splices plus 1000 treap split/merge pairs",
    file: "packages/showcase/src/core/wrapcache.ts:154 (insertLine) / :162 (removeLine); the treap pairs are packages/showcase/src/core/lineindex.ts:160 (insertLine) / :171 (removeLine)",
    reproduction: "Paste 1000 lines into the buffer: the app performs 1000 array splices and 1000 treap split/merge pairs where one batch splice would do.",
    classification: "real",
    fix: "Add a batch splice (spliceLines(at, removed, inserted)) to WrapCache and LineIndex so a multi-line paste is one structural edit.",
    regression: "Showcase case: paste 1000 lines and assert the number of treap split/merge pairs is O(1), not O(paste size).",
    tests: [],
    landedIn: null,
    blocks: ["core-wrap-math"],
  },
  {
    kind: "framework-fix",
    id: "fix-help-combo-hint-private",
    symbols: ["Keymap", "HelpPanel"],
    unreachable: ["helpComboHint"],
    feature: "helpComboHint is module-private, so no combo formatter is exported and the app re-implements it verbatim",
    file: "packages/core/src/keymap.ts:183",
    reproduction: "Ask the framework to spell a KeyCombo as ctrl+k: the only public spelling is HelpPanel's scene, and helpComboHint (keymap.ts:183-193) is not exported, so core/modals.ts:140-148 copies the rule.",
    classification: "real",
    fix: "Export helpComboHint from the barrel (packages/core/src/index.ts) and delete the app's comboHint copy (packages/showcase/src/core/modals.ts:140).",
    regression: "Showcase case: the help overlay's key column must read the framework's own formatter; a second implementation is the failure (core/modals.ts:140).",
    tests: [],
    landedIn: null,
    blocks: ["core-modal-overlay"],
  },
  {
    kind: "framework-fix",
    id: "fix-modal-factory-centers-content",
    symbols: ["Modal", "ModalProps", "MODAL_Z_INDEX", "MODAL_BACKDROP_BG"],
    unreachable: [],
    feature: "The Modal factory centers and sizes its own content, so a plan-exact overlay cannot ride it without a second centering decision",
    file: "packages/core/src/modal.ts:94",
    reproduction: "Hand the factory the plan's rectangle: it re-centers the content with justify_content/align_items center (modal.ts:94-120), owning geometry the plan already decided; the dim backdrop (MODAL_BACKDROP_BG, modal.ts:30) is bg-only and invisible in a text frame.",
    classification: "real",
    fix: "Let a caller supply the overlay rectangle (or opt out of centering) so the plan's own box is what is mounted.",
    regression: "Showcase case: the find overlay's box must equal the plan's ModalRegion rectangle (core/plan-modals.ts); the layers mount an absolutely positioned box instead (layers/react/App.ts:176).",
    tests: [],
    landedIn: null,
    blocks: ["core-modal-overlay"],
  },
  {
    kind: "framework-fix",
    id: "fix-planrow-screenrow-doc-mislabels",
    symbols: [],
    unreachable: [],
    feature: "PlanRow.screenRow is documented screen-absolute but every consumer places rows region-locally",
    file: "packages/showcase/src/core/plan.ts:60",
    reproduction: "Read the PlanRow doc (plan.ts:60-62): it says screen-absolute, while layers/core/frame.ts:89 and parity/mount_paint_test.ts:277 place rows at region.y + row.screenRow. The editor's y=0 hid it; the overlay (y != 0) followed the consumers and made the doc wrong.",
    classification: "partially shipped",
    fix: "The doc now says REGION-LOCAL (plan.ts:67-73). A framework-level guard, a named region-local row helper or a region-relative type, is still missing.",
    regression: "Showcase case: a region at y != 0 (the modal overlay) must paint at its own origin; a consumer that treats screenRow as absolute lands one region-height too low.",
    tests: [],
    landedIn: "the PlanRow doc correction in 15b (core/plan.ts:67)",
    blocks: ["core-display-rows"],
  },
];
