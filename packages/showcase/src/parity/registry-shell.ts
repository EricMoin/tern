//! The showcase completeness registry — part 3 of 3: the SHELL surface and the
//! ONE array.
//
// This file is the composition root. It holds the entries for the chrome the
// editor sits inside — keymap and help, theme, focus, the mode line, the scene
// primitives the emitters build, the renderer seam the parity harness compares,
// and the react/solid layer surfaces — and it concatenates the three parts into
// `REGISTRY`, the single array the completeness contract reads.
//
// It is also where the two remaining framework-fix entries of DELIVERABLE C
// live, both about asking the framework a question instead of guessing at it:
// the keymap cannot be queried, and the app's clamp policy is copied three times
// because the document model keeps its own private.
//
// Depends on both other parts; nothing depends on this file except the
// completeness test.

import {
  ALL_LAYERS,
  doc,
  EDITOR_ENTRIES,
  type FrameworkFixEntry,
  type RegistryEntry,
  type Role,
  type SurfaceEntry,
  type Tier,
} from "./registry-editor.ts";
import { PANE_ENTRIES } from "./registry-panes.ts";

/** The shell surface: keymap, theme, focus, chrome, renderer seam, react/solid. */
export const SHELL_ENTRIES: readonly RegistryEntry[] = [
  {
    kind: "surface",
    id: "core-keymap-registry",
    symbols: ["Keymap", "KeyCombo", "keymap"],
    feature: "Every shortcut in the app lives in one framework registry, described for the help overlay",
    tier: "stable",
    tierBasis: doc(279),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "help",
    keybinding: "all of them — the registry IS the binding table",
    headless: "registerCommands(host, keymap) / dispatchKey(host, keymap, event)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-keymap-help",
    symbols: ["HelpPanel", "HelpPanelProps"],
    feature: "The help overlay lists exactly the shortcuts that dispatch — same registry, no second table",
    tier: "stable",
    tierBasis: doc(282),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "help",
    keybinding: "f1",
    headless: "the descriptions registered by registerCommands supply the panel's rows",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-theme-roles",
    symbols: ["Theme", "ThemeRole", "ThemeRoleColors", "ThemeComponent", "THEME_ROLES", "THEME_COMPONENTS", "defaultTheme", "mergeTheme", "resolveTheme", "setTheme", "getTheme", "ThemeOverrides", "ThemeStylePreset", "ThemeResolvableProps"],
    feature: "The plan's StyleHints name semantic roles; the theme is the only place a colour is chosen",
    tier: "stable",
    tierBasis: doc(265),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "shell",
    keybinding: null,
    headless: "resolveTheme(mergeTheme(defaultTheme, overrides)) — setTheme/getTheme are experimental (docs/api-stability.md:277)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-renderer-seam",
    symbols: ["Renderer", "createRenderer", "CreateRendererOptions", "RendererSize", "RendererCapabilities", "TuiRenderer", "TuiRendererOptions", "NodeHandle"],
    feature: "The native renderer the three emitters paint into, and the size/capability probe above it",
    tier: "stable",
    tierBasis: doc(299),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "parity",
    keybinding: null,
    headless: "createRenderer(options) + the recorded event DTOs replayed through HeadlessApp.dispatch",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-parity-test-seams",
    symbols: ["framesEqual", "styledFramesEqual", "loadAddon", "setAddonForTesting", "TernAddon"],
    feature: "The parity harness compares frames and injects a fake addon, so the three layers are held to ScreenPlan identity without a PTY",
    tier: "internal",
    tierBasis: doc(301),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "parity",
    keybinding: null,
    headless: "framesEqual(expected, actual) / styledFramesEqual — internal by design, test-only",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-scene-primitives",
    symbols: ["Node", "Text", "Box", "NodeType", "NodeProps"],
    feature: "Every layer emits the same plan through the same scene primitives — the reason three renderers cannot drift",
    tier: "stable",
    tierBasis: doc(106),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "editor",
    keybinding: null,
    headless: "the emitters build Nodes from ScreenPlan spans; the core layer builds none",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-focus-routing",
    symbols: ["FocusManager", "focusManager", "Focusable", "FocusHandle", "focusAt"],
    feature: "Pane focus — editor, sidebar, overlay — routed by the framework's manager",
    tier: "stable",
    tierBasis: doc(284),
    docGap: false,
    role: "natural",
    layers: ALL_LAYERS,
    screen: "shell",
    keybinding: "ctrl+tab",
    headless: "HeadlessApp.focus + focusAt(manager, handle)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "core-statusbar-mode",
    symbols: ["StatusBar", "StatusBarProps", "StatusBarSegment"],
    feature: "The mode line: path, dirty marker, caret position, match count",
    tier: "stable",
    tierBasis: doc(125),
    docGap: false,
    role: "natural",
    layers: ["core", "solid"],
    screen: "shell",
    keybinding: null,
    headless: "plan.buildPlan's mode region supplies the segments (React cannot take element segments — fix-react-statusbar-element-segments)",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "react-layer-surface",
    symbols: ["createRoot", "render", "AppHandle", "TernRoot", "TernProps", "TernContainer", "TernNoTimeout", "TernTimeoutHandle", "hostConfig", "toNodeProps", "ThemeProvider", "ThemeContext", "ThemeProviderProps", "useTheme", "useApp", "useInput", "usePaste", "useResize", "useTerminalDimensions", "useWheelScroll", "usePanelMouseDrag", "useSelection", "useClickToFocus", "useFocus", "useFocusTraversal", "FocusManagerContext", "useFocusManager", "InputState", "StreamingTextProps"],
    feature: "The react layer: mount the same plan, feed the same dispatcher, own no layout",
    tier: "stable",
    tierBasis: doc(414),
    docGap: false,
    role: "natural",
    layers: ["react"],
    screen: "shell",
    keybinding: null,
    headless: "the layer is a ScreenPlan-to-scene emitter plus an event source; the headless tests run without it",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "solid-layer-surface",
    symbols: ["render", "insert", "spread", "createElement", "createTextNode", "insertNode", "setProp", "mergeProps", "effect", "memo", "createComponent", "use", "subscribeStream", "subscribeInput", "subscribePaste", "subscribeResize", "subscribeFocus", "subscribeFocusTraversal", "subscribePanelDrag", "subscribeMenuMouse", "subscribeWheelScroll", "subscribeSelection", "subscribeClickFocus", "startSpinner", "createTerminalDimensions", "disposeTextareaFocus", "disposeMenuFocus", "disposeTabsFocus", "disposeTreeFocus"],
    feature: "The solid layer: the same plan mounted through the destructured primitives, the same events through the subscribe* wiring",
    tier: "experimental",
    tierBasis: doc(712),
    docGap: false,
    role: "natural",
    layers: ["solid"],
    screen: "shell",
    keybinding: null,
    headless: "same contract as react: emitter + event source, held to ScreenPlan identity by the harness",
    disposition: null,
    droppable: false,
  },
  {
    kind: "surface",
    id: "solid-deprecated-renderer",
    symbols: ["renderer", "replaceNode"],
    feature: "The one deprecation-candidate in the whole audit, accounted for rather than skipped",
    tier: "deprecation-candidate",
    tierBasis: doc(711),
    docGap: false,
    role: "forced",
    layers: ["solid"],
    screen: "parity",
    keybinding: null,
    headless: "NOT used: the solid layer mounts through render/insert/spread; the parity guard asserts the absence",
    disposition: "FORCED as an exclusion entry: the completeness contract is forced to account for the 1/1 deprecation-candidate (solid renderer, removal scheduled for 0.4.0, superseded by the destructured mount primitives). The app's contribution is a negative control, not a use.",
    droppable: true,
  },
  {
    kind: "framework-fix",
    id: "fix-react-statusbar-element-segments",
    symbols: ["StatusBar", "StatusBarProps", "StatusBarSegment"],
    unreachable: [],
    feature: "React cannot take the framework's element-valued StatusBar segments: StatusBarSegment is string | Node, and a React element is neither, so the React layer composes the strip's scene shape itself",
    file: "packages/core/src/statusbar.ts:6 (StatusBarSegment = string | Node) against packages/react/src/components.ts:492 (the <StatusBar> host component forwards left/right as-is) and packages/react/src/reconciler/host_config.ts:108-109 (the status_bar case passes nodeProps straight to the core factory, whose toSegment at statusbar.ts:19-21 treats a non-string as a Node)",
    reproduction: "Hand <StatusBar> a React element segment: the core factory sends it into Node.create's children list as a foreign object (statusbar.ts:19-21). Only string segments are usable, and a string cannot carry the plan's per-segment style hint, so layers/react/App.ts:220 composes the strip (a row with justify_content space-between and the status_bar marker) instead of mounting the framework's element. The React layer's header records the gap (layers/react/App.ts:33-41).",
    classification: "real",
    fix: "Let the React host component accept element segments — resolve a React element to a core Node, or accept the scene Node type — so the React layer mounts the framework's StatusBar instead of reproducing its scene shape (statusbar.ts:43-58).",
    regression: "Showcase case: assert the React mode strip is byte-identical to the core StatusBar factory's strip while the host component cannot take an element segment; drop the gap when it can.",
    tests: [],
    landedIn: null,
    blocks: ["core-statusbar-mode", "react-layer-surface"],
  },
  {
    kind: "framework-fix",
    id: "fix-keymap-cannot-be-queried",
    symbols: ["Keymap", "KeyCombo", "keymap"],
    unreachable: ["match"],
    feature: "The keymap cannot answer which combo matches without running the handler",
    file: "packages/core/src/keymap.ts:63 (comboMatches is private) and :154 (dispatch returns only a boolean)",
    reproduction: "Ask the registry whether ctrl+s is bound, or which command a combo would run: the only answer is dispatch, which runs the handler.",
    classification: "real",
    fix: "Add Keymap.match(event): KeyCombo | null (or the registered descriptor) so a caller can query the registry — and remove the temptation to write a second matcher, which keymap.ts's own comment forbids.",
    regression: "Showcase case: a test asserts the help overlay and the dispatcher agree by asking the registry, with zero side effects — a query must not run the handler.",
    tests: [],
    landedIn: null,
    blocks: ["core-keymap-registry", "core-keymap-help"],
  },
  {
    kind: "framework-fix",
    id: "fix-buffer-clamp-is-private",
    symbols: [],
    unreachable: ["Buffer.clampPosition"],
    feature: "The document model's clamp policy is private, so it is copied three times in the app",
    file: "packages/showcase/src/core/buffer.ts:236 (#clampPosition is private) against packages/showcase/src/core/plan-panes.ts:145 (the copy plan.ts now imports), packages/showcase/src/core/plan-modals.ts:306 and packages/showcase/src/core/viewport.ts:272 (three more copies of the same rule)",
    reproduction: "Ask any caller outside the class to clamp a position: it cannot, so a third and fourth copy of the same arithmetic appears beside the canonical one.",
    classification: "real",
    fix: "Export one clampPosition(position, lineCount, lineLength) from the app's own buffer module (or move it to a shared module) and delete the copies in plan-panes.ts, plan-modals.ts and viewport.ts.",
    regression: "Showcase case: a single clamp property test over NaN, negatives and past-the-end positions drives the exported helper, and plan-panes.ts/plan-modals.ts/viewport.ts import it — a fourth copy is the failure.",
    tests: [],
    landedIn: null,
    blocks: ["core-caret-display", "core-display-rows"],
  },
  {
    kind: "framework-fix",
    id: "fix-solid-bare-specifier-loads-server-build",
    symbols: ["memo", "render"],
    unreachable: ["createSignal"],
    feature: "A bare solid-js import outside packages/solid resolves to the SERVER build, so a signal a consumer writes is never tracked by the renderer's effects",
    file: "packages/solid/src/index.ts:88 (createSignal is imported for the package's own use and never re-exported) against node_modules/solid-js/package.json (the \"deno\" export condition serves dist/server.js, the build with no reactive runtime)",
    reproduction: "Import createSignal from the bare specifier in any package other than @tern-tui/solid — the showcase's solid layer is the first consumer that needs a signal of its own — and write it: the specifier resolves to dist/server.js (packages/solid/deno.json:6 maps it to dist/solid.js for ITS OWN files only), while @tern-tui/solid's internals keep using the client build. Two runtimes: createRenderEffect runs once with the mount value and a memo over the foreign signal never re-runs after the write. Measured from packages/showcase before the mapping was added: signals [\"effect:0\", \"effect2:1\"] — the first effect never saw the write.",
    classification: "real",
    fix: "Re-export createSignal (or a tern-flavored createSource) from @tern-tui/solid so a consumer never names solid-js, and document the required deno.json mapping beside the package's install note for anyone who does. The showcase package now maps solid-js to dist/solid.js exactly as packages/solid/deno.json does.",
    regression: "Showcase case: layers/solid/primitives.ts's createPlanStore signal must re-run the emitter — layers/solid/app_test.ts (\"a plan write re-runs the emitter\") fails with \"the plan write did not re-run the emitter\" when the two runtimes are in play.",
    tests: [],
    landedIn: null,
    blocks: ["solid-layer-surface"],
  },
];

/**
 * The ONE registry: the editor surface, the pane surface and the shell surface,
 * each with its own framework-fix entries, in one array.
 */
export const REGISTRY: readonly RegistryEntry[] = [
  ...EDITOR_ENTRIES,
  ...PANE_ENTRIES,
  ...SHELL_ENTRIES,
];

/** How many entries each role has. All three must be non-zero. */
export type RoleCounts = Readonly<Record<Role, number>>;

/** Count the role of every surface entry (framework-fix entries have no role). */
export function roleCounts(entries: readonly RegistryEntry[] = REGISTRY): RoleCounts {
  const counts: Record<Role, number> = { natural: 0, repurposed: 0, forced: 0 };
  for (const entry of entries) {
    if (entry.kind === "surface") counts[entry.role] += 1;
  }
  return counts;
}

/** Count the shipped tier of every surface entry. */
export function tierCounts(entries: readonly RegistryEntry[] = REGISTRY): Readonly<Record<Tier, number>> {
  const counts: Record<Tier, number> = {
    stable: 0,
    experimental: 0,
    internal: 0,
    "deprecation-candidate": 0,
  };
  for (const entry of entries) {
    if (entry.kind === "surface") counts[entry.tier] += 1;
  }
  return counts;
}

/** Split the registry by kind — what the completeness test asserts over. */
export function byKind(entries: readonly RegistryEntry[] = REGISTRY): {
  readonly surfaces: readonly SurfaceEntry[];
  readonly fixes: readonly FrameworkFixEntry[];
} {
  const surfaces: SurfaceEntry[] = [];
  const fixes: FrameworkFixEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "surface") surfaces.push(entry);
    else fixes.push(entry);
  }
  return { surfaces, fixes };
}

/** The role counts of {@link REGISTRY}, computed once at module load. */
export const REGISTRY_ROLE_COUNTS: RoleCounts = roleCounts();
