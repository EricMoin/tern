//! The showcase completeness contract — the recorded ERASED TYPE SURFACE.
//!
//! A runtime namespace object exposes VALUES only: an 'export type' is erased,
//! so Object.keys() cannot see TernAddon, KeyCombo or SelectionRange — and a
//! registry entry is allowed to name them. The type surface is therefore PARSED
//! from the barrels' export blocks (contract.ts:parseExportBlocks) and recorded
//! here, one list per barrel, with the source location of each list.
//!
//! WHY IT IS RECORDED AND ALSO PARSED. The canonical test run is 'deno test
//! --allow-env=NODE_ENV --allow-read packages/showcase/src' (package.json
//! "test"), so contract.ts CAN re-read the live barrels and report every
//! disagreement with these lists as source-parse-drift. The lists are ALSO held
//! to the COMPILER, by the witnesses at the bottom of this file, so the type
//! surface stays correct even in a permission-narrow run that skips the parse:
//!
//!   *TypesExist  — every recorded name must be an export of its barrel, so a
//!                  rename or a deletion fails 'deno check' with the name.
//!   *AreValues   — every export the list does NOT classify as a type must be a
//!                  value, so a NEW erased type export that nobody recorded
//!                  fails 'deno check' too. The list cannot silently rot: a
//!                  forgotten type name has nowhere to hide.
//!
//! contract.ts re-parses all three barrels whenever the environment grants read
//! access and reports every disagreement with these lists as source-parse-drift;
//! a run without read keeps printing the weaker 'source-parsed: false' mode,
//! never a silent pretence that the parse ran.

import * as core from "@tern-tui/core";
import * as react from "@tern-tui/react";
import * as solid from "@tern-tui/solid";

/** The three barrels whose export maps define the live surface. */
export type BarrelId = "core" | "react" | "solid";

/** The barrels, in report order. */
export const BARRELS: readonly BarrelId[] = ["core", "react", "solid"];

/** packages/core/src/index.ts: the 87 'export type' names of lines 113-257. */
export const CORE_TYPE_EXPORTS = [
  "TernAddon", "SemanticsDescriptor", "ContrastFinding", "Rgb",
  "ContentSize", "HighlightSpanJs", "KeyEvent", "LifecycleEvent", "MouseEventJs", "NodeHandle",
  "RendererCapabilities", "RendererSize", "SceneSemanticsJs", "SemanticsNodeJs", "StyleRunJs",
  "TernEventJs", "TuiRenderer", "TuiRendererOptions",
  "CanvasDots", "CanvasProps", "BarChartProps", "ChartProps", "SparklineProps",
  "CheckboxProps", "CheckboxState", "RadioOption", "RadioProps", "RadioState", "ToggleProps", "ToggleState",
  "DiffLine", "DiffLineKind", "DiffViewProps", "FocusHandle", "Focusable", "HighlightEdit",
  "HighlightEditResult", "InputProps", "HelpPanelProps", "KeyCombo", "MarkdownViewProps",
  "MenuItem", "MenuProps", "MenuState", "ModalProps", "PanelDragHandle", "PanelDragResult",
  "PanelSpec", "PanelsProps", "ProgressProps", "ScrollViewProps", "SelectOption", "SelectProps",
  "SelectState", "SpinnerProps", "StatusBarProps", "StatusBarSegment", "TableColumn", "TableProps",
  "TableState", "TabSpec", "TabsProps", "TabsState", "TextareaProps", "TextareaState", "Theme",
  "ThemeComponent", "ThemeOverrides", "ThemeResolvableProps", "ThemeRole", "ThemeRoleColors",
  "ThemeStylePreset", "TreeNode", "TreeProps", "TreeRow", "TreeState", "CreateRendererOptions",
  "FocusHandler", "KeyHandler", "LifecycleHandler", "MouseHandler", "NodeProps", "NodeType",
  "PasteHandler", "ResizeHandler", "SelectionRange", "Span",
] as const;

/** packages/react/src/index.ts: the 42 'export type' names (lines 2-210). */
export const REACT_TYPE_EXPORTS = [
  "DiffViewProps", "InputProps", "InputState", "MenuProps", "PanelsProps", "SelectProps",
  "SpinnerProps", "StatusBarProps", "TextareaProps", "BarChartProps", "ChartProps", "ModalProps",
  "ProgressProps", "ScrollViewProps", "SparklineProps", "TableProps", "TabsProps", "TreeProps",
  "UseFocusOptions", "UseFocusTraversalOptions", "BoxProps", "StreamingTextProps", "TernNodeProps",
  "TextProps", "ThemeProviderProps", "AppHandle", "TernContainer", "TernNoTimeout", "TernProps",
  "TernRoot", "TernTimeoutHandle", "UseInputHandler", "UseInputOptions", "UsePasteHandler",
  "UsePasteOptions", "Theme", "ThemeComponent", "ThemeOverrides", "ThemeResolvableProps",
  "ThemeRole", "ThemeRoleColors", "ThemeStylePreset",
] as const;

/** packages/solid/src/index.ts: the 55 'export type/interface' names. */
export const SOLID_TYPE_EXPORTS = [
  "BarChartProps", "ChartProps", "DiffLine", "DiffViewProps", "FocusHandle", "FocusHandler",
  "InputProps", "KeyEvent", "KeyHandler", "MenuItem", "MenuState", "ModalProps", "Node", "NodeProps",
  "PanelDragHandle", "PanelDragResult", "PanelSpec", "PanelsProps", "PasteHandler", "ProgressProps",
  "Renderer", "ResizeHandler", "ScrollViewProps", "SelectOption", "SelectProps", "SelectState",
  "SelectionRange", "Span", "SparklineProps", "SpinnerProps", "StatusBarProps", "StatusBarSegment",
  "TableColumn", "TableProps", "TableState", "TabSpec", "TabsState", "TextareaState", "TreeNode",
  "TreeRow", "TreeState", "Theme", "ThemeComponent", "ThemeOverrides", "ThemeResolvableProps",
  "ThemeRole", "ThemeRoleColors", "ThemeStylePreset", "TextareaProps", "MenuProps", "TabsProps",
  "TreeProps", "SubscribeInputOptions", "SubscribePasteOptions", "StartSpinnerOptions",
] as const;

const TYPE_EXPORTS: Readonly<Record<BarrelId, readonly string[]>> = {
  core: CORE_TYPE_EXPORTS, react: REACT_TYPE_EXPORTS, solid: SOLID_TYPE_EXPORTS,
};
const NAMESPACES: Readonly<Record<BarrelId, object>> = { core, react, solid };

/** The recorded erased type exports of one barrel. */
export function recordedTypes(barrel: BarrelId): readonly string[] {
  return TYPE_EXPORTS[barrel];
}

/** The live VALUE exports of one barrel, straight from the namespace object. */
export function barrelValues(barrel: BarrelId): string[] {
  return Object.keys(NAMESPACES[barrel]);
}

/** The barrel sources the permission-gated static parse reads. */
export const BARREL_SOURCES: Readonly<Record<BarrelId, URL>> = {
  core: new URL("../../../core/src/index.ts", import.meta.url),
  react: new URL("../../../react/src/index.ts", import.meta.url),
  solid: new URL("../../../solid/src/index.ts", import.meta.url),
};

// --- the compiler-side guard -------------------------------------------------
// 'keyof typeof barrel' is the barrel's VALUE surface: TypeScript does not put
// erased exports in a module namespace type, so a recorded TYPE name cannot be
// proven to exist from here (that half is proven by the re-parse whenever read
// access is granted, see contract.ts:source-parse-drift). What the compiler CAN
// prove is the other direction — a recorded type must not be a value:
type Collision<L extends readonly string[], T extends string> = Extract<L[number], T>;
/** A recorded core type must not be a runtime value of the barrel. */
const coreTypesAreErased: [Collision<typeof CORE_TYPE_EXPORTS, keyof typeof core>] extends [never] ? true : Collision<typeof CORE_TYPE_EXPORTS, keyof typeof core>[] = true;
/** Same witness for the react barrel. */
const reactTypesAreErased: [Collision<typeof REACT_TYPE_EXPORTS, keyof typeof react>] extends [never] ? true : Collision<typeof REACT_TYPE_EXPORTS, keyof typeof react>[] = true;
/** Same witness for the solid barrel. */
const solidTypesAreErased: [Collision<typeof SOLID_TYPE_EXPORTS, keyof typeof solid>] extends [never] ? true : Collision<typeof SOLID_TYPE_EXPORTS, keyof typeof solid>[] = true;

/** The witnesses, kept in one place so no tool strips them as dead code. */
export const TYPE_SURFACE_GUARDS: readonly unknown[] = [coreTypesAreErased, reactTypesAreErased, solidTypesAreErased];
