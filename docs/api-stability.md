# Public API stability (M5.1)

The canonical public-API inventory for the four tern surfaces — `@tern-tui/core`,
`@tern-tui/react`, `@tern-tui/solid`, and the napi backside — recorded per symbol,
with the **1.0 冻结边界 (freeze boundary)** that defines what the 1.0 release
promises. This document is the stability contract: M5.2 (the deprecation lifecycle)
consumes the deprecation-candidate hand-off list below as its input, and M5.7 (the
1.0 release) freezes the boundary as declared here. The audit was **read-only** —
no file under `src/` or `packages/` was modified; the four per-surface staging
inventories (`docs/.audit-core.md`, `docs/.audit-react.md`, `docs/.audit-solid.md`,
`docs/.audit-napi.md`) were absorbed into this document and deleted.

## Scope and method

Four surfaces were audited, each by enumerating **every exported symbol** and
recording a per-symbol stability intent:

| Surface | Entry file(s) | Size | Symbols |
|---------|---------------|------|---------|
| `@tern-tui/core` | `packages/core/src/index.ts` | 9,965 lines | 238 |
| `@tern-tui/react` | `packages/react/src/index.ts` + `packages/react/src/reconciler.ts` | 1,864 + 895 lines | 167 |
| `@tern-tui/solid` | `packages/solid/src/index.ts` + `packages/solid/src/universal.ts` | 1,682 + 342 lines | 170 |
| napi backside | `src/bindings/tern-node/index.d.ts` (NAPI-RS generated) | 868 lines | 53 surface items |

**Method.** For the three JS packages, every `export` statement was enumerated
(`rg -c '^export '`), multi-symbol re-export blocks were expanded per symbol, and
one table row was written per symbol — each symbol appearing exactly once. The napi
surface was enumerated as every `export declare` class / member / function /
interface (19 top-level declarations + 34 class members = 53 surface items).
Stability was classified per symbol from git history (era and release vintage),
the CHANGELOG (0.1.0 / 0.2.0 / Unreleased sections), `@deprecated` markers, and
the code's own `@internal` / tooling-comment evidence. Reconciliation checks
(export-statement counts vs. expanded table rows, duplicates = 0, unparsed = 0)
passed on every surface.

**Audit date:** 2026-08-27. **Type:** read-only — the staging files were the only
writes, and they are now absorbed here.

## Stability taxonomy

| Tier | Meaning | Semver consequence |
|------|---------|--------------------|
| **stable** | Freeze-at-1.0 candidate; part of the public contract. | Breaking changes require a minor-version deprecation cycle (M5.2); frozen at 1.0, then major-only breaks. |
| **experimental** | Usable but **not** frozen. M3/M4-era surface that has not proven itself through a release cycle; consumers opt in at their own risk. | May change or move within 0.x; may break in a minor. Re-evaluated before 1.0. |
| **internal** | Exported only for tooling / tests / renderer-contract wiring; not user-facing tern API. | Excluded from the 1.0 freeze contract; may be removed or reorganized without notice or deprecation. |
| **deprecation-candidate** | Superseded or redundant surface worth deprecating per M5.2. | Entered in the M5.2 hand-off list with a replacement name; walked through deprecate → warn → remove (≥ 1 minor cycle). |

## Inventory

The four per-surface inventories follow. Each row is one audited symbol with its
kind, category, stability, and the audit note that justifies the tag. These tables
are the exhaustive per-symbol record — the freeze boundary in the next section is
defined *over* them.

### 1. `@tern-tui/core` — `packages/core/src/index.ts` (238 symbols)

Category legend: `renderer` · `scene-node` · `component` · `event` · `theme-style`
· `a11y-semantics` · `focus` · `selection` · `highlight` · `stream` · `contrast` ·
`utility`. 218 export statements expand to 238 symbols via the multi-symbol
re-export blocks (L113, L117, L118–124, L125, L126–141 napi DTO block — 5
statements contributing 25 symbols); no duplicates, no `export default`.

| # | Symbol | Kind | Category | Stability | Notes |
|---|--------|------|----------|-----------|-------|
| 1 | `loadAddon` | function | utility | internal | native addon loading seam (platform plumbing; preload for Deno/tests) |
| 2 | `setAddonForTesting` | function | utility | internal | test seam — fake addon injection |
| 3 | `TernAddon` | interface | utility | internal | type of the native addon module |
| 4 | `syncSemantics` | function | a11y-semantics | experimental | M4.1 semantics wiring — derives + pushes `Node.setSemantics` |
| 5 | `SemanticsDescriptor` | interface | a11y-semantics | experimental | M4.1 semantics write shape |
| 6 | `A11Y_STREAM_VERSION` | const | a11y-semantics | experimental | M4.2 a11y stream protocol version |
| 7 | `A11yStream` | class | a11y-semantics | experimental | M4.2 versioned JSONL semantics stream |
| 8 | `auditTheme` | function | contrast | experimental | M4.5 WCAG AA (4.5:1) audit of a `Theme` |
| 9 | `contrastRatio` | function | contrast | experimental | M4.5 WCAG 2.1 §1.4.3 contrast ratio |
| 10 | `parseThemeColor` | function | contrast | experimental | M4.5 color-string parser (`#rrggbb` / `indexed:N` / `default`) |
| 11 | `relativeLuminance` | function | contrast | experimental | M4.5 WCAG 2.1 §1.4.3 relative luminance |
| 12 | `XTERM_256` | const | contrast | experimental | M4.5 fixed xterm 256-color palette table |
| 13 | `ContrastFinding` | type | contrast | experimental | M4.5 per-pair audit result item |
| 14 | `Rgb` | type | contrast | experimental | M4.5 parsed RGB triple |
| 15 | `ContentSize` | type | utility | stable | napi DTO — node content size |
| 16 | `HighlightSpanJs` | type | highlight | stable | napi DTO — highlighted span |
| 17 | `KeyEvent` | type | event | stable | napi DTO — key event (kitty kind/super/meta/hyper augmented) |
| 18 | `LifecycleEvent` | type | event | stable | napi DTO — node lifecycle event |
| 19 | `MouseEventJs` | type | event | stable | napi DTO — mouse event |
| 20 | `NodeHandle` | type | utility | stable | napi DTO — native node handle |
| 21 | `RendererCapabilities` | type | renderer | stable | napi DTO — renderer capability flags |
| 22 | `RendererSize` | type | renderer | stable | napi DTO — renderer size |
| 23 | `SceneSemanticsJs` | type | a11y-semantics | experimental | napi semantics dump DTO (M4.1 semantics surface) |
| 24 | `SemanticsNodeJs` | type | a11y-semantics | experimental | napi semantics node DTO (M4.1 semantics surface) |
| 25 | `StyleRunJs` | type | theme-style | stable | napi DTO — painted run style (hyperlink/underline augmented) |
| 26 | `TernEventJs` | type | event | stable | napi DTO — root event union |
| 27 | `TuiRenderer` | type | renderer | stable | napi DTO — native renderer interface |
| 28 | `TuiRendererOptions` | type | renderer | stable | napi DTO — native renderer options |
| 29 | `name` | const | utility | stable | package name constant |
| 30 | `version` | const | utility | stable | package version constant |
| 31 | `NodeType` | type | scene-node | stable | scene node kind union |
| 32 | `NodeProps` | interface | scene-node | stable | core node props |
| 33 | `KeyHandler` | type | event | stable | `onKey` handler signature |
| 34 | `ResizeHandler` | type | event | stable | `onResize` handler signature |
| 35 | `FocusHandler` | type | event | stable | `onFocus` handler signature |
| 36 | `MouseHandler` | type | event | stable | `onMouse` handler signature |
| 37 | `PasteHandler` | type | event | stable | `onPaste` handler signature |
| 38 | `LifecycleHandler` | type | event | stable | `onLifecycle` handler signature |
| 39 | `Span` | interface | highlight | stable | styled text span (highlight/markdown) |
| 40 | `SelectionRange` | interface | selection | experimental | selection rect type (selection surface) |
| 41 | `CreateRendererOptions` | interface | renderer | stable | `createRenderer` options |
| 42 | `Node` | class | scene-node | stable | core scene node |
| 43 | `Text` | function | component | stable | primitive text factory |
| 44 | `Box` | function | component | stable | primitive box factory |
| 45 | `StreamingText` | function | component | stable | streaming text factory |
| 46 | `InputProps` | interface | component | stable | props type |
| 47 | `Input` | function | component | stable | input factory |
| 48 | `editKey` | function | component | stable | input key interaction helper |
| 49 | `pasteInto` | function | component | stable | input paste helper |
| 50 | `TextareaProps` | interface | component | stable | props type |
| 51 | `TextareaState` | interface | component | stable | state type |
| 52 | `wrapLineWithOffsets` | function | utility | stable | textarea line-wrapping math |
| 53 | `measureText` | function | utility | stable | text measurement math |
| 54 | `Textarea` | function | component | stable | textarea factory |
| 55 | `editTextareaKey` | function | component | stable | textarea key interaction helper |
| 56 | `pasteIntoTextarea` | function | component | stable | textarea paste helper |
| 57 | `SpinnerProps` | interface | component | stable | props type |
| 58 | `DEFAULT_SPINNER_FRAMES` | const | component | stable | default spinner frame set |
| 59 | `Spinner` | function | component | stable | spinner factory |
| 60 | `tick` | function | component | stable | spinner frame advance |
| 61 | `StatusBarSegment` | type | component | stable | segment union (`string \| Node`) |
| 62 | `StatusBarProps` | interface | component | stable | props type |
| 63 | `StatusBar` | function | component | stable | status bar factory |
| 64 | `PanelSpec` | interface | component | stable | panels spec type |
| 65 | `PanelsProps` | interface | component | stable | props type |
| 66 | `Panels` | function | component | stable | panels factory |
| 67 | `collapsePanel` | function | component | stable | panels control helper |
| 68 | `expandPanel` | function | component | stable | panels control helper |
| 69 | `togglePanel` | function | component | stable | panels control helper |
| 70 | `focusPanel` | function | component | stable | panels control helper |
| 71 | `PANEL_DRAG_MIN_SIZE` | const | component | stable | drag threshold constant |
| 72 | `PanelDragHandle` | interface | component | stable | drag handle state type |
| 73 | `PanelDragResult` | interface | component | stable | drag result type |
| 74 | `startPanelDrag` | function | component | stable | panels drag control |
| 75 | `dragPanels` | function | component | stable | panels drag control |
| 76 | `endPanelDrag` | function | component | stable | panels drag control |
| 77 | `DiffLineKind` | type | component | stable | diff line kind union |
| 78 | `DiffLine` | interface | component | stable | diff line type |
| 79 | `DiffViewProps` | interface | component | stable | props type |
| 80 | `DIFF_ADD_FG` | const | theme-style | stable | diff add color constant |
| 81 | `DIFF_DEL_FG` | const | theme-style | stable | diff del color constant |
| 82 | `DiffView` | function | component | stable | diff view factory |
| 83 | `SelectOption` | interface | component | stable | option type |
| 84 | `SelectState` | interface | component | stable | state type |
| 85 | `SelectProps` | interface | component | stable | props type |
| 86 | `SELECT_FILTER_PLACEHOLDER` | const | component | stable | filter placeholder constant |
| 87 | `selectOptions` | const (WeakMap) | component | internal | normalized-option registry (reconciler/test wiring) |
| 88 | `visibleOptions` | function | component | stable | select state inspection reader |
| 89 | `Select` | function | component | stable | select factory |
| 90 | `selectKey` | function | component | stable | select key interaction helper |
| 91 | `CHECKBOX_CHECKED_GLYPH` | const | component | stable | glyph constant |
| 92 | `CHECKBOX_UNCHECKED_GLYPH` | const | component | stable | glyph constant |
| 93 | `TOGGLE_ON_GLYPH` | const | component | stable | glyph constant |
| 94 | `TOGGLE_OFF_GLYPH` | const | component | stable | glyph constant |
| 95 | `RADIO_SELECTED_GLYPH` | const | component | stable | glyph constant |
| 96 | `RADIO_UNSELECTED_GLYPH` | const | component | stable | glyph constant |
| 97 | `CHECK_PRIMARY_FG` | const | theme-style | stable | form primary fg color |
| 98 | `CHECK_PRIMARY_BG` | const | theme-style | stable | form primary bg color |
| 99 | `CheckboxState` | interface | component | stable | state type |
| 100 | `ToggleState` | interface | component | stable | state type |
| 101 | `RadioState` | interface | component | stable | state type |
| 102 | `RadioOption` | interface | component | stable | option type |
| 103 | `CheckboxProps` | interface | component | stable | props type |
| 104 | `ToggleProps` | interface | component | stable | props type |
| 105 | `RadioProps` | interface | component | stable | props type |
| 106 | `checkboxLabels` | const (WeakMap) | component | internal | label registry (reconciler/test wiring) |
| 107 | `toggleLabels` | const (WeakMap) | component | internal | label registry (reconciler/test wiring) |
| 108 | `radioOptions` | const (WeakMap) | component | internal | option registry (reconciler/test wiring) |
| 109 | `Checkbox` | function | component | stable | checkbox factory |
| 110 | `Toggle` | function | component | stable | toggle factory |
| 111 | `Radio` | function | component | stable | radio factory |
| 112 | `checkboxKey` | function | component | stable | checkbox key interaction helper |
| 113 | `toggleKey` | function | component | stable | toggle key interaction helper |
| 114 | `radioKey` | function | component | stable | radio key interaction helper |
| 115 | `MENU_Z_INDEX` | const | component | stable | menu z-index constant |
| 116 | `MenuItem` | interface | component | stable | menu item type |
| 117 | `MenuState` | interface | component | stable | state type |
| 118 | `MenuProps` | interface | component | stable | props type |
| 119 | `Menu` | function | component | stable | menu factory |
| 120 | `menuKey` | function | component | stable | menu key interaction helper |
| 121 | `menuHover` | function | component | stable | menu hover helper |
| 122 | `menuClick` | function | component | stable | menu click helper |
| 123 | `openMenu` | function | component | stable | menu control helper |
| 124 | `closeMenu` | function | component | stable | menu control helper |
| 125 | `ScrollViewProps` | interface | component | stable | props type |
| 126 | `SCROLLBAR_THUMB_CHAR` | const | component | stable | glyph constant |
| 127 | `SCROLLBAR_TRACK_CHAR` | const | component | stable | glyph constant |
| 128 | `ScrollView` | function | component | stable | scroll view factory |
| 129 | `scrollTo` | function | component | stable | scroll control helper |
| 130 | `scrollBy` | function | component | stable | scroll control helper |
| 131 | `scrollTop` | function | component | stable | scroll position reader |
| 132 | `TableColumn` | interface | component | stable | column type |
| 133 | `TableState` | interface | component | stable | state type |
| 134 | `TableProps` | interface | component | stable | props type |
| 135 | `Table` | function | component | stable | table factory |
| 136 | `visibleTableRows` | function | component | stable | table windowing reader |
| 137 | `tableKey` | function | component | stable | table key interaction helper |
| 138 | `TREE_EXPANDED_GLYPH` | const | component | stable | glyph constant |
| 139 | `TREE_COLLAPSED_GLYPH` | const | component | stable | glyph constant |
| 140 | `TREE_GUIDE_VERTICAL` | const | component | stable | glyph constant |
| 141 | `TreeNode` | interface | component | stable | tree node type |
| 142 | `TreeRow` | interface | component | stable | tree row type |
| 143 | `TreeState` | interface | component | stable | state type |
| 144 | `TreeProps` | interface | component | stable | props type |
| 145 | `Tree` | function | component | stable | tree factory |
| 146 | `visibleTreeRows` | function | component | stable | tree windowing reader |
| 147 | `expandTreeNode` | function | component | stable | tree control helper |
| 148 | `collapseTreeNode` | function | component | stable | tree control helper |
| 149 | `toggleTreeNode` | function | component | stable | tree control helper |
| 150 | `treeKey` | function | component | stable | tree key interaction helper |
| 151 | `TabSpec` | interface | component | stable | tab spec type |
| 152 | `TabsState` | interface | component | stable | state type |
| 153 | `TabsProps` | interface | component | stable | props type |
| 154 | `TAB_PRIMARY_FG` | const | theme-style | stable | tabs accent fg color |
| 155 | `TAB_PRIMARY_BG` | const | theme-style | stable | tabs accent bg color |
| 156 | `TAB_ACTIVE_MARKER` | const | component | stable | glyph constant |
| 157 | `TAB_CLOSE_CHAR` | const | component | stable | glyph constant |
| 158 | `Tabs` | function | component | stable | tabs factory |
| 159 | `activateTab` | function | component | stable | tabs control helper |
| 160 | `closeTab` | function | component | stable | tabs control helper |
| 161 | `tabsKey` | function | component | stable | tabs key interaction helper |
| 162 | `ProgressProps` | interface | component | stable | props type |
| 163 | `PROGRESS_DEFAULT_WIDTH` | const | component | stable | default width constant |
| 164 | `PROGRESS_FILL_CHAR` | const | component | stable | glyph constant |
| 165 | `PROGRESS_EMPTY_CHAR` | const | component | stable | glyph constant |
| 166 | `Progress` | function | component | stable | progress factory |
| 167 | `setProgress` | function | component | stable | progress control helper |
| 168 | `CanvasDots` | type | component | stable | canvas dot-matrix type |
| 169 | `CanvasProps` | interface | component | stable | props type |
| 170 | `brailleCell` | function | component | stable | braille glyph math |
| 171 | `brailleRows` | function | component | stable | braille row packing |
| 172 | `Canvas` | function | component | stable | canvas factory |
| 173 | `BarChartProps` | interface | component | stable | props type |
| 174 | `BarChart` | function | component | stable | bar chart factory |
| 175 | `ChartProps` | interface | component | stable | props type |
| 176 | `Chart` | function | component | stable | chart factory |
| 177 | `SparklineProps` | interface | component | stable | props type |
| 178 | `Sparkline` | function | component | stable | sparkline factory |
| 179 | `MODAL_Z_INDEX` | const | component | stable | modal z-index constant |
| 180 | `MODAL_BACKDROP_BG` | const | theme-style | stable | modal backdrop color |
| 181 | `ModalProps` | interface | component | stable | props type |
| 182 | `Modal` | function | component | stable | modal factory |
| 183 | `openModal` | function | component | stable | modal control helper |
| 184 | `closeModal` | function | component | stable | modal control helper |
| 185 | `highlightCode` | function | highlight | stable | one-shot syntax highlight |
| 186 | `incrementalHighlight` | function | highlight | stable | incremental highlight append |
| 187 | `resetIncrementalHighlightCache` | function | highlight | internal | highlight cache-reset test seam |
| 188 | `MARKDOWN_CODE_FG` | const | theme-style | stable | markdown code color |
| 189 | `MARKDOWN_LINK_FG` | const | theme-style | stable | markdown link color |
| 190 | `MARKDOWN_FENCE_BG` | const | theme-style | stable | markdown fence bg color |
| 191 | `MARKDOWN_HR_CHAR` | const | component | stable | glyph constant |
| 192 | `MARKDOWN_HR_WIDTH` | const | component | stable | hr width constant |
| 193 | `MarkdownViewProps` | interface | component | stable | props type |
| 194 | `MarkdownView` | function | component | stable | markdown view factory |
| 195 | `setStreamAutoScroll` | function | stream | internal | `@internal` — host factory wiring seam (react/solid) |
| 196 | `isStreamFollowing` | function | stream | experimental | stream follow-state reader |
| 197 | `syncStreamTail` | function | stream | experimental | follow-tail pin after append |
| 198 | `followTail` | function | stream | experimental | re-attach auto-scroll follow |
| 199 | `STREAM_AFFORDANCE_CHAR` | const | stream | experimental | scroll-to-bottom affordance glyph |
| 200 | `scrollToBottom` | function | stream | experimental | one-shot tail jump |
| 201 | `THEME_ROLES` | const | theme-style | stable | semantic palette role list |
| 202 | `ThemeRole` | type | theme-style | stable | palette role union |
| 203 | `THEME_COMPONENTS` | const | theme-style | stable | themeable component list |
| 204 | `ThemeComponent` | type | theme-style | stable | themeable component union |
| 205 | `ThemeRoleColors` | interface | theme-style | stable | role fg/bg pair type |
| 206 | `ThemeStylePreset` | interface | theme-style | stable | component preset type |
| 207 | `Theme` | interface | theme-style | stable | theme shape |
| 208 | `ThemeOverrides` | interface | theme-style | stable | partial-theme type |
| 209 | `ThemeResolvableProps` | interface | theme-style | stable | role/component hint props type |
| 210 | `defaultTheme` | const | theme-style | stable | default One-Dark theme |
| 211 | `mergeTheme` | function | theme-style | stable | theme merge (creation-time model) |
| 212 | `resolveTheme` | function | theme-style | stable | creation-time theme resolution |
| 213 | `setTheme` | function | theme-style | experimental | M4.5 runtime theme swap engine |
| 214 | `getTheme` | function | theme-style | experimental | M4.5 active-theme reader |
| 215 | `KeyCombo` | interface | focus | stable | key combo shape |
| 216 | `Keymap` | class | focus | stable | key binding map |
| 217 | `keymap` | const | focus | stable | global keymap instance |
| 218 | `HelpPanelProps` | interface | component | stable | props type |
| 219 | `HelpPanel` | function | component | stable | help panel factory |
| 220 | `Focusable` | interface | focus | stable | focusable contract |
| 221 | `FocusManager` | class | focus | stable | focus management |
| 222 | `focusManager` | const | focus | stable | global focus manager instance |
| 223 | `FocusHandle` | interface | focus | stable | focus handle type |
| 224 | `useFocus` | function | focus | stable | imperative focus request |
| 225 | `wheelScroll` | function | focus | stable | wheel-driven scroll helper |
| 226 | `focusAt` | function | focus | stable | pointer-press focus targeting |
| 227 | `SELECTION_DOUBLE_CLICK_MS` | const | selection | experimental | double-click window constant |
| 228 | `setSelectionClockForTesting` | function | selection | internal | clock test seam |
| 229 | `selectWordAt` | function | selection | experimental | word selection helper |
| 230 | `startSelection` | function | selection | experimental | press-down session start |
| 231 | `dragSelection` | function | selection | experimental | drag extension |
| 232 | `endSelection` | function | selection | experimental | release persist |
| 233 | `copySelection` | function | selection | experimental | copy overlay to clipboard |
| 234 | `selectionKey` | function | selection | experimental | selection key routing |
| 235 | `Renderer` | class | renderer | stable | renderer |
| 236 | `createRenderer` | function | renderer | stable | renderer factory |
| 237 | `framesEqual` | function | renderer | internal | frame equality — test/snapshot only |
| 238 | `styledFramesEqual` | function | renderer | internal | styled frame equality — test/snapshot only |

**Totals (core):** 238 symbols — **198 stable**, **28 experimental**, **12
internal**, **0 deprecation-candidate**.

### 2. `@tern-tui/react` — `packages/react/src/index.ts` + `reconciler.ts` (167 symbols)

Classification rule: **stable** = shipped in a released version (0.1.0 —
2026-08-02, or 0.2.0 — 2026-08-10, tag `bec978c`) and unchanged in contract
since; **experimental** = shipped in the post-0.2.0 unreleased window
(2026-08-18 → 2026-08-21 — the M3/M4 milestone deliverables plus the same-window
Phase 8 / Phase 10 additions); **internal** = exported for tooling/tests or
module-internal plumbing; **deprecation-candidate** = none found (no
`@deprecated` annotations, no superseded surface). Counts: 167 total — **134
stable**, **28 experimental**, **5 internal**, **0 deprecation-candidate**
(index.ts = 164; reconciler.ts = 20, of which 17 are re-exported from index.ts
and 3 are reconciler-only).

#### Package metadata

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `name` | const | index.ts:146 | stable | Package identity, shipped since 0.1.0. |
| `version` | const | index.ts:147 | stable | Package identity, shipped since 0.1.0 (currently `"0.2.0"`). |

#### Host component props (interfaces)

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `TernNodeProps` | interface | index.ts:159 | stable | Base host props (`NodeProps` + `children` + `role`/`component`), since 0.1.0. |
| `BoxProps` | type alias | index.ts:170 | stable | = `TernNodeProps`, since 0.1.0. |
| `TextProps` | type alias | index.ts:173 | stable | = `TernNodeProps`, since 0.1.0. |
| `StreamingTextProps` | interface | index.ts:179 | stable | Since 0.1.0. `wrap` prop added 2026-08-17 (post-0.2.0, core `ffb37fe`) — additive prop, no contract break. |
| `InputState` | interface | index.ts:426 | stable | `<Input>` callback payload, since 0.1.0. |
| `InputProps` | interface | index.ts:438 | stable | Since 0.1.0. |
| `SpinnerProps` | interface | index.ts:463 | stable | Since 0.1.0. |
| `StatusBarProps` | interface | index.ts:487 | stable | Since 0.1.0. |
| `PanelsProps` | interface | index.ts:502 | stable | Since 0.1.0. |
| `DiffViewProps` | interface | index.ts:517 | stable | Since 0.2.0 window (core `8cbb03e`, 2026-08-03). |
| `SelectProps` | interface | index.ts:537 | stable | Since 0.1.0/0.2.0 window. |
| `MenuProps` | interface | index.ts:580 | experimental | `Menu` host shipped M3.2 (core `27b095d`, 2026-08-20) — unreleased. |
| `TextareaProps` | interface | index.ts:671 | stable | Since 0.2.0 (CHANGELOG 0.2.0 Textarea widget). |
| `ScrollViewProps` | interface | index.ts:975 | stable | Since 0.2.0 window. |
| `TableProps` | interface | index.ts:1019 | stable | Since 0.2.0 (CHANGELOG 0.2.0 Table widget). |
| `TreeProps` | interface | index.ts:1060 | experimental | `Tree` host shipped Phase 8 (core `67893c1`, 2026-08-18) — unreleased. |
| `ModalProps` | interface | index.ts:1137 | stable | Since 0.2.0 (CHANGELOG 0.2.0 Modal widget). |
| `TabsProps` | interface | index.ts:1171 | stable | Since 0.2.0 (CHANGELOG 0.2.0 Tabs widget). |
| `ProgressProps` | interface | index.ts:1250 | stable | Since 0.2.0 (CHANGELOG 0.2.0 Progress widget). |
| `BarChartProps` | interface | index.ts:1295 | experimental | Chart widgets shipped Phase 10 breadth (core `04daeeb`, 2026-08-19) — unreleased. |
| `ChartProps` | interface | index.ts:1338 | experimental | Same window as `BarChartProps`. |
| `SparklineProps` | interface | index.ts:1375 | experimental | Same window as `BarChartProps`. |

#### Host components

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `Box` | fn | index.ts:301 | stable | Host component, since 0.1.0. |
| `Text` | fn | index.ts:312 | stable | Host component, since 0.1.0. |
| `StreamingText` | fn | index.ts:341 | stable | Host component, since 0.1.0. |
| `Input` | fn | index.ts:625 | stable | Host component, since 0.1.0. |
| `Textarea` | fn | index.ts:713 | stable | Host component, since 0.2.0. |
| `Spinner` | fn | index.ts:768 | stable | Host component, since 0.1.0. |
| `StatusBar` | fn | index.ts:806 | stable | Host component, since 0.1.0. |
| `Panels` | fn | index.ts:820 | stable | Host component, since 0.1.0. |
| `DiffView` | fn | index.ts:837 | stable | Host component, since 0.2.0 window. |
| `Select` | fn | index.ts:856 | stable | Host component, since 0.1.0/0.2.0 window. |
| `Menu` | fn | index.ts:912 | experimental | Host component, M3.2 (2026-08-20) — unreleased. |
| `ScrollView` | fn | index.ts:1005 | stable | Host component, since 0.2.0 window. |
| `Table` | fn | index.ts:1045 | stable | Host component, since 0.2.0. |
| `Tree` | fn | index.ts:1098 | experimental | Host component, Phase 8 (2026-08-18) — unreleased. |
| `Modal` | fn | index.ts:1159 | stable | Host component, since 0.2.0. |
| `Tabs` | fn | index.ts:1208 | stable | Host component, since 0.2.0. |
| `Progress` | fn | index.ts:1282 | stable | Host component, since 0.2.0. |
| `BarChart` | fn | index.ts:1327 | experimental | Host component, Phase 10 breadth (2026-08-19) — unreleased. |
| `Chart` | fn | index.ts:1364 | experimental | Host component, Phase 10 breadth (2026-08-19) — unreleased. |
| `Sparkline` | fn | index.ts:1398 | experimental | Host component, Phase 10 breadth (2026-08-19) — unreleased. |

#### Theme

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `ThemeContext` | const | index.ts:212 | stable | Theme context (defaults to core `defaultTheme`), since 0.2.0 window. |
| `ThemeProviderProps` | interface | index.ts:217 | stable | Since 0.2.0 window. |
| `ThemeProvider` | fn | index.ts:231 | stable | Framework-driven theme path; the M4.5 `setTheme` engine is additive, does not change this contract. |
| `useTheme` | fn | index.ts:243 | stable | Since 0.2.0 window. |

#### Focus hooks

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `FocusManagerContext` | const | index.ts:1414 | stable | Focus context (defaults to core `focusManager`), since 0.1.0. |
| `useFocusManager` | fn | index.ts:1420 | stable | Since 0.1.0. |
| `UseFocusOptions` | interface | index.ts:1425 | stable | Since 0.1.0. |
| `useFocus` | fn | index.ts:1439 | stable | Wraps core `useFocus`/`FocusManager` (0.1.0). |
| `UseFocusTraversalOptions` | interface | index.ts:1469 | stable | Since 0.2.0 (core `9870c3f`, 2026-08-04). |
| `useFocusTraversal` | fn | index.ts:1495 | stable | Since 0.2.0 (core `9870c3f`, 2026-08-04). |

#### Resize / mouse hooks

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `useResize` | fn | index.ts:1553 | stable | Wraps `renderer.onResize` (Phase 2 event surface, 0.1.0; re-wired 0.2.0 window). |
| `useTerminalDimensions` | fn | index.ts:1588 | stable | Since 0.2.0 (core `d008325`, 2026-08-10; CHANGELOG 0.2.0). |
| `usePanelMouseDrag` | fn | index.ts:1626 | stable | Wraps core `dragPanels`/`startPanelDrag`/`endPanelDrag` (0.2.0 window, core `8cbb03e`). |
| `useWheelScroll` | fn | index.ts:1662 | stable | Wraps core `wheelScroll` (0.2.0, CHANGELOG "Mouse wheel scroll"). |
| `useSelection` | fn | index.ts:1699 | stable | Wraps core selection module (0.2.0, CHANGELOG "Mouse selection (roadmap Phase 5)"). Behavior refined 2026-08-19 (overlay persists after release, core `5be6101`) — signature unchanged. |
| `useClickToFocus` | fn | index.ts:1730 | stable | Wraps core `focusAt` (0.2.0, CHANGELOG "Click-to-focus"). |

#### Reconciler / root API (re-exported from `./reconciler.ts`)

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `createRoot` | fn | index.ts:1742; reconciler.ts:747 | stable | Root API, since 0.1.0. |
| `render` | fn | index.ts:1742; reconciler.ts:815 | stable | Root API, since 0.1.0. |
| `useApp` | fn | index.ts:1742; reconciler.ts:830 | stable | App-handle hook, since 0.1.0. |
| `useInput` | fn | index.ts:1742; reconciler.ts:849 | stable | Input hook, since 0.1.0. |
| `usePaste` | fn | index.ts:1742; reconciler.ts:880 | stable | Paste hook, since 0.2.0 (CHANGELOG "Paste events end to end"). |
| `AppHandle` | type | index.ts:1743; reconciler.ts:134 | stable | Root/container types, since 0.1.0. |
| `TernContainer` | type | index.ts:1743; reconciler.ts:121 | stable | Since 0.1.0. |
| `TernNoTimeout` | type | index.ts:1743; reconciler.ts:131 | stable | Since 0.1.0. |
| `TernProps` | type | index.ts:1743; reconciler.ts:110 | stable | Since 0.1.0. |
| `TernRoot` | type | index.ts:1743; reconciler.ts:149 | stable | Since 0.1.0. |
| `TernTimeoutHandle` | type | index.ts:1743; reconciler.ts:129 | stable | Since 0.1.0. |
| `UseInputHandler` | type | index.ts:1743; reconciler.ts:169 | stable | Since 0.1.0. |
| `UseInputOptions` | type | index.ts:1743; reconciler.ts:157 | stable | Since 0.1.0. |
| `UsePasteHandler` | type | index.ts:1743; reconciler.ts:184 | stable | Since 0.2.0. |
| `UsePasteOptions` | type | index.ts:1743; reconciler.ts:172 | stable | Since 0.2.0. |

#### Internal surface

| Symbol | Kind | Source | Stability | Basis |
|--------|------|--------|-----------|-------|
| `hostConfig` | const | index.ts:1756; reconciler.ts:422 | internal | `index.ts:1755` — "The HostConfig itself is internal, but exported for tooling/tests". |
| `toNodeProps` | fn | index.ts:1756; reconciler.ts:321 | internal | Prop sanitizer alongside the HostConfig, exported for tooling/tests (same comment). |
| `THEME_HINT_CARRIER` | const | reconciler.ts:293 | internal | M4.5 theme-hint carrier string key — module-internal plumbing between `index.ts` and `reconciler.ts`; not re-exported from the package entry. |
| `ReactThemeHint` | interface | reconciler.ts:300 | internal | M4.5 theme-hint record type — same internal plumbing. |
| `AppContext` | const | reconciler.ts:727 | internal | App-handle React context — internal wiring; consumers use `useApp()`, it is not re-exported from the package entry. |

#### Core type re-exports (`from "@tern-tui/core"`)

| Symbol | Source | Stability | Basis (core vintage) |
|--------|--------|-----------|---------------------|
| `DiffLine` | index.ts:1761 | stable | DiffView model, 0.2.0 window. |
| `FocusHandle` | index.ts:1761 | stable | Focus machinery, 0.1.0. |
| `KeyEvent` | index.ts:1761 | stable | Event surface, 0.1.0. |
| `KeyHandler` | index.ts:1761 | stable | Focus machinery, 0.1.0. |
| `MenuItem` | index.ts:1761 | experimental | Menu model type, M3.2 (2026-08-20). |
| `MenuState` | index.ts:1761 | experimental | Menu state type, M3.2 (2026-08-20). |
| `Node` | index.ts:1761 | stable | Scene node, 0.1.0. |
| `NodeProps` | index.ts:1761 | stable | Scene props, 0.1.0. |
| `PanelDragHandle` | index.ts:1761 | stable | Panel drag, 0.2.0 window. |
| `PanelDragResult` | index.ts:1761 | stable | Panel drag, 0.2.0 window. |
| `PanelSpec` | index.ts:1761 | stable | Panels model, 0.1.0. |
| `PasteHandler` | index.ts:1761 | stable | Paste events, 0.2.0. |
| `Renderer` | index.ts:1761 | stable | Renderer surface, 0.1.0. |
| `ResizeHandler` | index.ts:1761 | stable | Resize events, 0.1.0. |
| `SelectOption` | index.ts:1761 | stable | Select model, 0.1.0/0.2.0 window. |
| `SelectState` | index.ts:1761 | stable | Select state, 0.1.0/0.2.0 window. |
| `SelectionRange` | index.ts:1761 | stable | Selection overlay, 0.2.0. |
| `Span` | index.ts:1761 | stable | Stream spans, 0.1.0. |
| `StatusBarSegment` | index.ts:1761 | stable | StatusBar model, 0.1.0. |
| `TabSpec` | index.ts:1761 | stable | Tabs model, 0.2.0. |
| `TableColumn` | index.ts:1761 | stable | Table model, 0.2.0. |
| `TableState` | index.ts:1761 | stable | Table state, 0.2.0. |
| `TabsState` | index.ts:1761 | stable | Tabs state, 0.2.0. |
| `TextareaState` | index.ts:1761 | stable | Textarea state, 0.2.0. |
| `TreeNode` | index.ts:1761 | experimental | Tree model type, Phase 8 (2026-08-18). |
| `TreeRow` | index.ts:1761 | experimental | Tree row type, Phase 8 (2026-08-18). |
| `TreeState` | index.ts:1761 | experimental | Tree state type, Phase 8 (2026-08-18). |

#### Core value re-exports (`from "@tern-tui/core"`)

| Symbol | Source | Stability | Basis (core vintage) |
|--------|--------|-----------|---------------------|
| `activateTab` | index.ts:1799 | stable | Tabs key handler, 0.2.0. |
| `closeTab` | index.ts:1799 | stable | Tabs helper, 0.2.0. |
| `closeMenu` | index.ts:1799 | experimental | Menu helper, M3.2 (2026-08-20). |
| `closeModal` | index.ts:1799 | stable | Modal helper, 0.2.0. |
| `copySelection` | index.ts:1799 | stable | Selection helper, 0.2.0. |
| `defaultTheme` | index.ts:1799 | stable | Theme base, 0.1.0/0.2.0 window. |
| `dragPanels` | index.ts:1799 | stable | Panel drag helper, 0.2.0 window. |
| `dragSelection` | index.ts:1799 | stable | Selection helper, 0.2.0. |
| `editKey` | index.ts:1799 | stable | Input key handler, 0.1.0. |
| `editTextareaKey` | index.ts:1799 | stable | Textarea key handler, 0.2.0. |
| `endPanelDrag` | index.ts:1799 | stable | Panel drag helper, 0.2.0 window. |
| `endSelection` | index.ts:1799 | stable | Selection helper, 0.2.0. |
| `focusAt` | index.ts:1799 | stable | Click-to-focus helper, 0.2.0. |
| `focusManager` | index.ts:1799 | stable | Default manager, 0.1.0. |
| `followTail` | index.ts:1799 | stable | Stream follow helper, 0.2.0. |
| `FocusManager` | index.ts:1799 | stable | Focus class, 0.1.0. |
| `getTheme` | index.ts:1799 | experimental | Runtime theme engine, M4.5 (core `04bf202`, 2026-08-21). |
| `isStreamFollowing` | index.ts:1799 | stable | Stream helper, 0.2.0. |
| `mergeTheme` | index.ts:1799 | stable | Theme helper, 0.1.0/0.2.0 window. |
| `MENU_Z_INDEX` | index.ts:1799 | experimental | Menu overlay z-order, M3.2 (2026-08-20). |
| `menuClick` | index.ts:1799 | experimental | Menu mouse helper, M3.2 (2026-08-20). |
| `menuHover` | index.ts:1799 | experimental | Menu mouse helper, M3.2 (2026-08-20). |
| `menuKey` | index.ts:1799 | experimental | Menu key handler, M3.2 (2026-08-20). |
| `MODAL_Z_INDEX` | index.ts:1799 | stable | Modal overlay z-order, 0.2.0. |
| `openMenu` | index.ts:1799 | experimental | Menu helper, M3.2 (2026-08-20). |
| `openModal` | index.ts:1799 | stable | Modal helper, 0.2.0. |
| `pasteInto` | index.ts:1799 | stable | Paste helper, 0.2.0. |
| `pasteIntoTextarea` | index.ts:1799 | stable | Paste helper, 0.2.0. |
| `resolveTheme` | index.ts:1799 | stable | Theme resolver, 0.1.0/0.2.0 window. |
| `scrollBy` | index.ts:1799 | stable | Scroll helper, 0.2.0. |
| `scrollTo` | index.ts:1799 | stable | Scroll helper, 0.2.0. |
| `scrollToBottom` | index.ts:1799 | stable | Stream scroll helper, 0.2.0. |
| `scrollTop` | index.ts:1799 | stable | Scroll helper, 0.2.0. |
| `selectKey` | index.ts:1799 | stable | Select key handler, 0.1.0/0.2.0 window. |
| `selectWordAt` | index.ts:1799 | stable | Selection helper, 0.2.0. |
| `SELECTION_DOUBLE_CLICK_MS` | index.ts:1799 | stable | Selection constant, 0.2.0. |
| `selectionKey` | index.ts:1799 | stable | Selection key handler, 0.2.0. |
| `setProgress` | index.ts:1799 | stable | Progress helper, 0.2.0. |
| `setTheme` | index.ts:1799 | experimental | Runtime theme engine, M4.5 (core `04bf202`, 2026-08-21). |
| `startPanelDrag` | index.ts:1799 | stable | Panel drag helper, 0.2.0 window. |
| `startSelection` | index.ts:1799 | stable | Selection helper, 0.2.0. |
| `STREAM_AFFORDANCE_CHAR` | index.ts:1799 | stable | Stream affordance constant, 0.2.0. |
| `syncStreamTail` | index.ts:1799 | stable | Stream helper, 0.2.0. |
| `tableKey` | index.ts:1799 | stable | Table key handler, 0.2.0. |
| `tabsKey` | index.ts:1799 | stable | Tabs key handler, 0.2.0. |
| `tick` | index.ts:1799 | stable | Spinner tick, 0.1.0. |
| `toggleTreeNode` | index.ts:1799 | experimental | Tree helper, Phase 8 (2026-08-18). |
| `expandTreeNode` | index.ts:1799 | experimental | Tree helper, Phase 8 (2026-08-18). |
| `collapseTreeNode` | index.ts:1799 | experimental | Tree helper, Phase 8 (2026-08-18). |
| `treeKey` | index.ts:1799 | experimental | Tree key handler, Phase 8 (2026-08-18). |
| `visibleTreeRows` | index.ts:1799 | experimental | Tree window helper, Phase 8 (2026-08-18). |
| `visibleTableRows` | index.ts:1799 | stable | Table window helper, 0.2.0. |
| `wheelScroll` | index.ts:1799 | stable | Wheel scroll helper, 0.2.0. |

#### Core theme type re-exports (`from "@tern-tui/core"`)

| Symbol | Source | Stability | Basis |
|--------|--------|-----------|-------|
| `Theme` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeComponent` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeOverrides` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeResolvableProps` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeRole` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeRoleColors` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |
| `ThemeStylePreset` | index.ts:1856 | stable | Theme surface, 0.1.0/0.2.0 window. |

**Contract-unchanged refinements (noted by the react audit):** `useSelection`
(stable) — copy-on-release behavior refined 2026-08-19 (overlay persists after
release until `escape` / click-elsewhere / a new selection, core `5be6101`);
signature unchanged. `StreamingTextProps` (stable) — `wrap` prop added
2026-08-17 (single-row paint + ellipsis, core `ffb37fe`); additive, no existing
prop changed.

**Totals (react):** 167 symbols — **134 stable**, **28 experimental**, **5
internal**, **0 deprecation-candidate**.

### 3. `@tern-tui/solid` — `packages/solid/src/index.ts` + `universal.ts` (170 symbols)

Decision rules: (1) core re-exports inherit the `@tern-tui/core` stability of
their source, recorded here as stable because they mirror the core public
surface M5.1 freezes (the canonical per-symbol intent lives in the core audit
above); (2) universal-renderer primitives are internal (the vendored
solid-js/universal contract), except the subset SolidJS users legitimately
reach to mount scenes — experimental; (3) element factories + their prop
interfaces are the user-facing API → stable; (4) dispose\*/subscribe\* wiring
helpers default to experimental (M3-era focus wiring), promoted to stable only
as pure pass-throughs of core-stable symbols (no solid-local state or control
flow beyond a trivial conditional repaint); (5) option/type interfaces follow
the stability of what they type; (6) deprecation-candidate: `renderer` (M5.2,
see hand-off below). Counts: 170 total — **140 stable**, **24 experimental**,
**5 internal**, **1 deprecation-candidate** (167 from `index.ts` across 64
`universal.ts`).

#### A. Package metadata — `index.ts`

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `name` | const | index.ts:169 | stable | Package identifier metadata. |
| `version` | const | index.ts:170 | stable | Package version metadata. |

#### B. `@tern-tui/core` type re-exports — `index.ts:175-217` (41 types)

All **stable** — core-stable type surface; canonical per-symbol freeze intent
lives in the core audit.

| Symbol | Kind | Source | Stability |
|---|---|---|---|
| `BarChartProps` | type | index.ts:176 | stable |
| `ChartProps` | type | index.ts:177 | stable |
| `DiffLine` | type | index.ts:178 | stable |
| `DiffViewProps` | type | index.ts:179 | stable |
| `FocusHandle` | type | index.ts:180 | stable |
| `FocusHandler` | type | index.ts:181 | stable |
| `InputProps` | type | index.ts:182 | stable |
| `KeyEvent` | type | index.ts:183 | stable |
| `KeyHandler` | type | index.ts:184 | stable |
| `MenuItem` | type | index.ts:185 | stable |
| `MenuState` | type | index.ts:186 | stable |
| `ModalProps` | type | index.ts:187 | stable |
| `Node` | type | index.ts:188 | stable |
| `NodeProps` | type | index.ts:189 | stable |
| `PanelDragHandle` | type | index.ts:190 | stable |
| `PanelDragResult` | type | index.ts:191 | stable |
| `PanelSpec` | type | index.ts:192 | stable |
| `PanelsProps` | type | index.ts:193 | stable |
| `PasteHandler` | type | index.ts:194 | stable |
| `ProgressProps` | type | index.ts:195 | stable |
| `Renderer` | type | index.ts:196 | stable — core renderer interface (onKey/onPaste/onResize/onFocus/onMouse/hit_test/size); distinct from the vendored universal.ts `Renderer` contract (section L). |
| `ResizeHandler` | type | index.ts:197 | stable |
| `ScrollViewProps` | type | index.ts:198 | stable |
| `SelectOption` | type | index.ts:199 | stable |
| `SelectProps` | type | index.ts:200 | stable |
| `SelectState` | type | index.ts:201 | stable |
| `SelectionRange` | type | index.ts:202 | stable |
| `Span` | type | index.ts:203 | stable |
| `SparklineProps` | type | index.ts:204 | stable |
| `SpinnerProps` | type | index.ts:205 | stable |
| `StatusBarProps` | type | index.ts:206 | stable |
| `StatusBarSegment` | type | index.ts:207 | stable |
| `TableColumn` | type | index.ts:208 | stable |
| `TableProps` | type | index.ts:209 | stable |
| `TableState` | type | index.ts:210 | stable |
| `TabSpec` | type | index.ts:211 | stable |
| `TabsState` | type | index.ts:212 | stable |
| `TextareaState` | type | index.ts:213 | stable |
| `TreeNode` | type | index.ts:214 | stable |
| `TreeRow` | type | index.ts:215 | stable |
| `TreeState` | type | index.ts:216 | stable |

#### C. `@tern-tui/core` value re-exports — `index.ts:227-286` (58 values)

All **stable** — core-stable value surface; canonical per-symbol freeze intent
lives in the core audit.

| Symbol | Kind | Source | Stability |
|---|---|---|---|
| `activateTab` | value | index.ts:228 | stable |
| `closeMenu` | value | index.ts:229 | stable |
| `closeModal` | value | index.ts:230 | stable |
| `closeTab` | value | index.ts:231 | stable |
| `collapsePanel` | value | index.ts:232 | stable |
| `copySelection` | value | index.ts:233 | stable |
| `defaultTheme` | value | index.ts:234 | stable |
| `dragPanels` | value | index.ts:235 | stable |
| `dragSelection` | value | index.ts:236 | stable |
| `editKey` | value | index.ts:237 | stable |
| `editTextareaKey` | value | index.ts:238 | stable |
| `endPanelDrag` | value | index.ts:239 | stable |
| `endSelection` | value | index.ts:240 | stable |
| `expandPanel` | value | index.ts:241 | stable |
| `focusAt` | value | index.ts:242 | stable |
| `followTail` | value | index.ts:243 | stable |
| `focusManager` | value | index.ts:244 | stable |
| `focusPanel` | value | index.ts:245 | stable |
| `getTheme` | value | index.ts:246 | stable |
| `isStreamFollowing` | value | index.ts:247 | stable |
| `FocusManager` | value | index.ts:248 | stable — core FocusManager class. |
| `MENU_Z_INDEX` | value | index.ts:249 | stable |
| `menuClick` | value | index.ts:250 | stable |
| `menuHover` | value | index.ts:251 | stable |
| `menuKey` | value | index.ts:252 | stable |
| `mergeTheme` | value | index.ts:253 | stable |
| `MODAL_Z_INDEX` | value | index.ts:254 | stable |
| `openMenu` | value | index.ts:255 | stable |
| `openModal` | value | index.ts:256 | stable |
| `pasteInto` | value | index.ts:257 | stable |
| `pasteIntoTextarea` | value | index.ts:258 | stable |
| `resolveTheme` | value | index.ts:259 | stable |
| `scrollBy` | value | index.ts:260 | stable |
| `scrollTo` | value | index.ts:261 | stable |
| `scrollToBottom` | value | index.ts:262 | stable |
| `scrollTop` | value | index.ts:263 | stable |
| `selectKey` | value | index.ts:264 | stable |
| `selectWordAt` | value | index.ts:265 | stable |
| `SELECTION_DOUBLE_CLICK_MS` | value | index.ts:266 | stable |
| `selectionKey` | value | index.ts:267 | stable |
| `setProgress` | value | index.ts:268 | stable |
| `setTheme` | value | index.ts:269 | stable |
| `startPanelDrag` | value | index.ts:270 | stable |
| `startSelection` | value | index.ts:271 | stable |
| `STREAM_AFFORDANCE_CHAR` | value | index.ts:272 | stable |
| `syncStreamTail` | value | index.ts:273 | stable |
| `tableKey` | value | index.ts:274 | stable |
| `tabsKey` | value | index.ts:275 | stable |
| `tick` | value | index.ts:276 | stable |
| `toggleTreeNode` | value | index.ts:277 | stable |
| `expandTreeNode` | value | index.ts:278 | stable |
| `collapseTreeNode` | value | index.ts:279 | stable |
| `treeKey` | value | index.ts:280 | stable |
| `togglePanel` | value | index.ts:281 | stable |
| `useFocus` | value | index.ts:282 | stable |
| `visibleTableRows` | value | index.ts:283 | stable |
| `visibleTreeRows` | value | index.ts:284 | stable |
| `wheelScroll` | value | index.ts:285 | stable |

#### D. Theme type re-exports — `index.ts:290-298` (7 types)

All **stable** — core-stable theme type surface.

| Symbol | Kind | Source | Stability |
|---|---|---|---|
| `Theme` | type | index.ts:291 | stable |
| `ThemeComponent` | type | index.ts:292 | stable |
| `ThemeOverrides` | type | index.ts:293 | stable |
| `ThemeResolvableProps` | type | index.ts:294 | stable |
| `ThemeRole` | type | index.ts:295 | stable |
| `ThemeRoleColors` | type | index.ts:296 | stable |
| `ThemeStylePreset` | type | index.ts:297 | stable |

#### E. Universal-renderer surface — `index.ts:526-579`

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `replaceNode` | function | index.ts:526 | internal | Position-accurate in-parent replacement convenience mirroring solid-js' internal `insertNode`+`removeNode` sequence. NOT a `RendererOptions` key (v1.9.14 has no `replaceNode`) and not user-facing tern API. |
| `rendererOptions` | const (alias of `options`) | index.ts:551 | internal | The `RendererOptions` object wired into `createRenderer`; exported so tests and embedders can exercise the tree-op callbacks (`replaceText`, `isTextNode`, `setProperty`, anchor `insertNode`, traversal) not reachable on the renderer surface. |
| `renderer` | const | index.ts:562 | deprecation-candidate | Superseded by the destructured mount primitives (`render`, `insert`, `spread`, `createElement`, `createTextNode`, `insertNode`, `setProp`, `mergeProps`, `effect`, `memo`, `createComponent`, `use`); M5.2 deprecation decision, removal scheduled for 0.4.0. |
| `render` | const | index.ts:568 | experimental | Universal-renderer mount primitive — SolidJS users legitimately reach it to mount scenes; part of the renderer contract rather than the tern component API. |
| `insert` | const | index.ts:569 | experimental | Reactive insertion primitive (solid-js universal contract). |
| `spread` | const | index.ts:570 | experimental | Props/children spread primitive (solid-js universal contract). |
| `createElement` | const | index.ts:571 | experimental | Tag → tern node factory dispatch primitive. |
| `createTextNode` | const | index.ts:572 | experimental | Text-leaf creation primitive. |
| `insertNode` | const | index.ts:573 | experimental | Tree-op callback (anchor insertion). |
| `setProp` | const | index.ts:574 | experimental | Property write primitive (funnels into `Node.setProps` via the options' `setProperty`). |
| `mergeProps` | const | index.ts:575 | experimental | solid-js prop-merge primitive. |
| `effect` | const | index.ts:576 | experimental | Reactive effect primitive (`createRenderEffect`). |
| `memo` | const | index.ts:577 | experimental | Reactive memo primitive. |
| `createComponent` | const | index.ts:578 | experimental | Component-creation primitive. |
| `use` | const | index.ts:579 | experimental | `untrack`-based directive primitive. |

#### F. Element factories — `index.ts:579-1185` (20)

The roadmap element set materializing the `@tern-tui/core` factories with
feature parity to the `@tern-tui/react` host components (same props → same
scene node structure). All **stable** — the package's user-facing API.

| Symbol | Source | Notes |
|---|---|---|
| `Box` | index.ts:579 | box primitive factory (theme-hint resolving). |
| `Text` | index.ts:601 | text primitive factory. |
| `StreamingText` | index.ts:632 | streaming_text factory (auto-scroll flag consumed). |
| `Input` | index.ts:679 | input factory (edit via core `editKey`). |
| `Textarea` | index.ts:747 | textarea factory + optional `focusId` focus registration (`disposeTextareaFocus`). |
| `Spinner` | index.ts:787 | spinner factory (advance via `tick` / `startSpinner`). |
| `StatusBar` | index.ts:798 | status_bar factory (left/center/right segments). |
| `Panels` | index.ts:809 | panels factory (drag-resize via `subscribePanelDrag`). |
| `DiffView` | index.ts:822 | diff factory (scrollable per-line rows). |
| `Select` | index.ts:836 | select factory (filter + option rows). |
| `Menu` | index.ts:905 | menu factory + optional `focusId` registration (`disposeMenuFocus`). |
| `ScrollView` | index.ts:937 | scroll_view factory (clip/scroll region + track/thumb). |
| `Table` | index.ts:950 | table factory (sticky header + content region). |
| `Modal` | index.ts:963 | modal factory (full-bleed overlay). |
| `Tabs` | index.ts:1028 | tabs factory + optional `focusId` registration (`disposeTabsFocus`). |
| `Tree` | index.ts:1110 | tree factory + optional `focusId` registration (`disposeTreeFocus`). |
| `Progress` | index.ts:1145 | progress factory (Gauge parity, `ratio` or `value`/`max`). |
| `BarChart` | index.ts:1158 | bar_chart factory (eighth-block glyphs). |
| `Chart` | index.ts:1171 | chart factory (braille polyline). |
| `Sparkline` | index.ts:1183 | sparkline factory (glyph-per-value, braille option). |

#### G. Factory prop interfaces — `index.ts` (4)

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `TextareaProps` | interface | index.ts:691 | stable | Props type for the stable `Textarea` factory (core textarea props + consumed `focusId`/`focusManager`/`onChange`/`onSubmit`). |
| `MenuProps` | interface | index.ts:849 | stable | Props type for the stable `Menu` factory (core menu props + `focusId`/`focusManager`/`onSelect`/`onDismiss`). |
| `TabsProps` | interface | index.ts:975 | stable | Props type for the stable `Tabs` factory (core tabs props + `focusId`/`focusManager`/`onChange`/`onClose`). |
| `TreeProps` | interface | index.ts:1062 | stable | Props type for the stable `Tree` factory (core tree props + `focusId`/`focusManager`/`onChange`). |

#### H. dispose\* focus helpers — `index.ts` (4)

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `disposeTextareaFocus` | function | index.ts:722 | stable | Pure pass-through disposal of the core-stable `FocusHandle` registered by the stable `Textarea` factory (WeakMap lookup + `handle.dispose()`); documented teardown counterpart of the factory. |
| `disposeMenuFocus` | function | index.ts:878 | stable | Same pattern for the stable `Menu` factory's registration. |
| `disposeTabsFocus` | function | index.ts:1005 | stable | Same pattern for the stable `Tabs` factory's registration. |
| `disposeTreeFocus` | function | index.ts:1088 | stable | Same pattern for the stable `Tree` factory's registration. |

#### I. subscribe\* wiring helpers — `index.ts` (11)

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `subscribeStream` | function | index.ts:1212 | stable | Streaming feature (feed an `AsyncIterable<Span>` to `StreamingText`) — documented user-facing surface, NOT M3-era focus wiring; wraps core-stable `Node.appendSpan` + `syncStreamTail`. The async pump is an implementation detail of the documented feature. |
| `subscribeInput` | function | index.ts:1280 | experimental | M3-era focus wiring (Solid-flavored `useInput`): solid-local key-routing behavior over `FocusManager.routeKey` — the routing decision is surface worth re-evaluating before freeze. |
| `subscribeFocusTraversal` | function | index.ts:1316 | experimental | M3-era focus wiring (Solid-flavored `useFocusTraversal`): solid-local `traverseFocus` walking algorithm (exclude set, wrap-around, blur/refocus undo). |
| `subscribePaste` | function | index.ts:1390 | experimental | M3-era focus wiring (Solid-flavored `usePaste`): solid-local paste-routing behavior over `FocusManager.routePaste`. |
| `subscribeResize` | function | index.ts:1419 | experimental | M3-era wiring (Solid-flavored `useResize`): adds repaint orchestration (`renderer.render()` re-invoke) on top of `Renderer.onResize`. |
| `subscribeFocus` | function | index.ts:1475 | stable | Pure pass-through of core-stable `Renderer.onFocus` (`return renderer.onFocus(handler)`) — adds no surface of its own. |
| `subscribePanelDrag` | function | index.ts:1499 | experimental | Mouse wiring: solid-local hit-test gating + drag-state orchestration over the core panel-drag helpers. |
| `subscribeMenuMouse` | function | index.ts:1543 | experimental | M3.2-era mouse wiring: solid-local hover/click gating over core `menuHover`/`menuClick`. |
| `subscribeWheelScroll` | function | index.ts:1577 | stable | Thin pass-through of core-stable `wheelScroll` onto the mouse channel (trivial conditional repaint). |
| `subscribeSelection` | function | index.ts:1607 | experimental | Mouse wiring: solid-local selection state-machine orchestration over core `startSelection`/`dragSelection`/`copySelection`/`endSelection`. |
| `subscribeClickFocus` | function | index.ts:1634 | stable | Pure pass-through of core-stable `focusAt` onto the mouse channel — adds no surface of its own. |

#### J. Reactive / driver helpers — `index.ts` (2)

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `createTerminalDimensions` | function | index.ts:1452 | experimental | Reactive dimensions accessor (Solid-flavored `useTerminalDimensions`); built on the experimental `subscribeResize` — boundary deferred with its dependency. |
| `startSpinner` | function | index.ts:1661 | experimental | M3-era focus-aware tick driver: solid-local interval + focus-flag timer behavior over core `tick`. |

#### K. Wiring option types — `index.ts` (3)

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `SubscribeInputOptions` | interface | index.ts:1251 | experimental | Types the experimental `subscribeInput`. |
| `SubscribePasteOptions` | interface | index.ts:1360 | experimental | Types the experimental `subscribePaste`. |
| `StartSpinnerOptions` | interface | index.ts:1641 | experimental | Types the experimental `startSpinner`. |

#### L. Vendored solid-js universal contract — `universal.ts` (3)

Faithful TypeScript port of `solid-js/universal`'s `createRenderer`
(node_modules/solid-js/universal, MIT — interfaces taken verbatim from
solidjs/solid). Vendored because bare `solid-js` resolves to the server build
(no reactive runtime) under Deno/Node. All **internal** — the universal-renderer
contract, not user-facing tern API.

| Symbol | Kind | Source | Stability | Rationale |
|---|---|---|---|---|
| `createRenderer` | function | universal.ts:338 | internal | The vendored renderer factory (per audit brief). Not exported from the package entry; deep-import only. |
| `Renderer<NodeType>` | interface | universal.ts:52 | internal | Vendored solid-js `Renderer` contract type. Distinct from the `@tern-tui/core` `Renderer` re-exported at index.ts:196. |
| `RendererOptions<NodeType>` | interface | universal.ts:39 | internal | Vendored `RendererOptions` contract type (canonical 1.9.14 key set). |

**Totals (solid):** 170 symbols — **140 stable**, **24 experimental**, **5
internal**, **1 deprecation-candidate**.

### 4. napi backside — `src/bindings/tern-node/index.d.ts` (53 surface items)

The NAPI-RS generated declarations (868 lines) behind the `@tern-tui/node`
package. The JS-stable typing contract is the **re-export-through-core mapping**:
`packages/core/src/index.ts` L126–141 re-exports 14 names (`ContentSize,
HighlightSpanJs, KeyEvent, LifecycleEvent, MouseEventJs, NodeHandle,
RendererCapabilities, RendererSize, SceneSemanticsJs, SemanticsNodeJs,
StyleRunJs, TernEventJs, TuiRenderer, TuiRendererOptions`) carrying the same JS
name as the napi name → stable. Core augments `StyleRunJs` (hyperlink /
underlineStyle / underlineColor, index.ts:158–171) and `KeyEvent` (kind / super
/ meta / hyper, index.ts:173–193) in `declare module` blocks without touching
the generated declarations. Two napi shapes are **not** re-exported — core
re-declares `SelectionRange` (index.ts:451–460) and `HighlightAppendJs`
(addon.ts:74–80) locally — and `IncrementalHighlighter`, `create_node`,
`highlight` are reached only through the `TernAddon` seam (addon.ts:39–64), with
`highlight` wrapped as the public `highlightCode` (core index.ts:7039–7045).

#### Table 1 — Free functions

| # | napi declaration (line) | JS-side surface | Stability | Evidence / notes |
|---|-------------------------|-----------------|-----------|------------------|
| F1 | `create_node(nodeType, props?)` (L394) | not re-exported; used via addon seam, wrapped by core `Node` materialization | **stable** (behavior pinned transitively) | core index.ts:925 `this.#handle = loadAddon().create_node(...)` |
| F2 | `highlight(language, source)` (L410) | not re-exported; wrapped as public `highlightCode` | **stable** | core index.ts:7044–7045 `addon.highlight(lang, code).map(spanFromRaw)` |

#### Table 2 — Classes

##### TuiRenderer (napi L142) — re-exported as JS name `TuiRenderer` (core index.ts:139) → class **stable**

| # | member (line) | Stability | Evidence (core/reconciler call sites) |
|---|---------------|-----------|---------------------------------------|
| T1 | `constructor(options: TuiRendererOptions)` (L154) | **stable** | core index.ts:9305 `new addon.TuiRenderer(nativeOptions)` (camelCase→snake_case option mapping: `exitOnCtrlC`→`exit_on_ctrl_c`, `useAltScreen`→`use_alt_screen`, `keyboardEnhancement`→`keyboard_enhancement`, `scrollOptimization`→`scroll_optimization`, `width`/`height`/`title`/`headless`/`semantics` unchanged) |
| T2 | `root()` (L156) | **stable** | core index.ts:9306 `this.root = Node.wrapRoot(this.#native.root())` |
| T3 | `hit_test(col, row)` (L166) | **stable** | core index.ts:9769; react index.ts:1637; solid index.ts:1509 (mouse routing gate) |
| T4 | `render()` (L182) | **stable** | core index.ts:9628/9680; react reconciler.ts:565 (single paint per commit) |
| T5 | `render_to_buffer(width?, height?)` (L193) | **stable** | core index.ts:9733 (snapshot / golden testing) |
| T6 | `render_to_buffer_styled(width?, height?)` (L210) | **stable** | core index.ts:9756 |
| T7 | `semantics()` (L226) | **stable** | core index.ts:9416 (a11y store read) |
| T8 | `destroy()` (L237) | **stable** | core index.ts:9872; react reconciler.ts:770 |
| T9 | `get destroyed` (L242) | **stable** | core index.ts:9877 `this.#destroyed \|\| this.#native.destroyed` |
| T10 | `get capabilities` (L253) | **stable** | core index.ts:9325 |
| T11 | `get last_flush_bytes` (L263) | **stable** (mediated) | core index.ts:9340 `Number(this.#native.last_flush_bytes)` → `get lastFlushBytes` (bench byte-cost metric) |
| T12 | `set_title(title)` (L268) | **stable** | core index.ts:9347 |
| T13 | `get size` (L285) | **stable** | core index.ts:9364 |
| T14 | `set_clipboard(text)` (L291) | **stable** | core index.ts:9375 |
| T15 | `set_any_event_mouse(enabled)` (L302) | **stable** (mediated) | declared on `TernAddon` (addon.ts:63); core index.ts:9819/9824 (driven by `onMouse` listener count) |
| T16 | `set_selection(col1,row1,col2,row2)` (L313) | **stable** | core index.ts:9388 |
| T17 | `clear_selection()` (L319) | **stable** | core index.ts:9397 |
| T18 | `set_cursor(x,y,shape,visible,blink)` (L330) | **stable** | core index.ts:9484 |
| T19 | `clear_cursor()` (L339) | **stable** | core index.ts:9501 |
| T20 | `selection_text()` (L350) | **stable** | core index.ts:9514 |
| T21 | `selection_word_range(col,row)` (L362) | **stable** | core index.ts:9528 (returns core-local `SelectionRange`, see D13) |
| T22 | `start_event_stream(callback)` (L377) | **stable** | core index.ts:9555 (push event delivery; `setAddonForTesting` fake `start_event_stream` mirrors it) |

##### NodeHandle (napi L44) — re-exported as JS name `NodeHandle` (core index.ts:132) → class **stable**

| # | member (line) | Stability | Evidence (core/reconciler call sites) |
|---|---------------|-----------|---------------------------------------|
| N1 | `add_child(child)` (L51) | **stable** | core index.ts:942 `handle.add_child(child.#ensureHandle())` |
| N2 | `insert_before(child, anchor)` (L63) | **stable** | core index.ts:715 `this.#ensureHandle().insert_before(...)`; react reconciler.ts:22 (`Node.insertBefore` → `NodeHandle.insert_before` ordered insert) |
| N3 | `remove()` (L68) | **stable** | core index.ts:900; react reconciler.ts:369/382/388 (`child.remove()` detach) |
| N4 | `set_props(props)` (L79) | **stable** | core index.ts:756/796 (whole-map write) |
| N5 | `set_prop(key, value)` (L93) | **stable** | core index.ts:765/802 (incremental single-key write) |
| N6 | `append_span(text, style?)` (L104) | **stable** | core index.ts:828/954 (streaming_text) |
| N7 | `set_semantics(node)` (L116) | **stable** | core index.ts:986 (gated by renderer `semantics` option) |
| N8 | `clear_semantics()` (L122) | **stable** | core index.ts:877 |
| N9 | `content_size()` (L134) | **stable** | core index.ts:919 |

##### IncrementalHighlighter (napi L15) — NOT re-exported through core; reached via `TernAddon` as `NativeIncrementalHighlighter` (addon.ts:51, 83–88) → class **experimental**

| # | member (line) | Stability | Evidence (core call sites) |
|---|---------------|-----------|---------------------------|
| I1 | `constructor(language)` (L21) | **experimental** | core index.ts:7097 `new addon.IncrementalHighlighter(lang)` (module-level per-language cache, index.ts:6981) |
| I2 | `append(chunk): HighlightAppendJs` (L28) | **experimental** | core index.ts:7109/7116 (tail re-parse streaming) |
| I3 | `reset()` (L34) | **experimental** | core index.ts:7115 |

#### Table 3 — DTO interfaces

##### Re-exported through core index.ts:126–141 (JS name = napi name) → **stable**

| # | interface (line) | fields | Stability | Notes |
|---|------------------|--------|-----------|-------|
| D1 | `ContentSize` (L381) | width, height | **stable** | also re-exported via addon.ts:27 |
| D2 | `HighlightSpanJs` (L445) | text, fg?, bold, italic, dim, underline | **stable** | shape mirrors `Span` / `append_span` style-key convention; consumed by `spanFromRaw` (core index.ts:7021) |
| D3 | `KeyEvent` (L469) | name, char?, ctrl, alt, shift, kind?, super?, meta?, hyper? | **stable** | core augmentation adds kind/super/meta/hyper (index.ts:173–193); back-compat core fields name/char/ctrl/alt/shift |
| D4 | `LifecycleEvent` (L509) | phase | **stable** | SIGTSTP/SIGCONT suspend/resume carrier inside `TernEventJs` |
| D5 | `MouseEventJs` (L527) | kind, column, row, ctrl, alt, shift | **stable** | `kind` encodes action+button (`down_left`, `drag_middle`, …) |
| D6 | `RendererCapabilities` (L554) | truecolor, colors, terminalIdentity?, kittyKeyboard, kittyUnderline, osc52, bracketedPaste, focusEvents, scrollRegion, probed | **stable** | backend color report + interactive probe merge |
| D7 | `RendererSize` (L624) | width, height | **stable** | `size` getter return |
| D8 | `SceneSemanticsJs` (L641) | id: bigint, parent?: bigint, role, label?, state, enabled, selected | **stable** | output-only (`object_from_js = false`); `u64` ids safe as bigint |
| D9 | `SemanticsNodeJs` (L681) | role, label?, state, enabled, selected | **stable** | write shape accepted by `NodeHandle.set_semantics` |
| D10 | `StyleRunJs` (L730) | text, fg?, bg?, hyperlink?, underlineStyle?, underlineColor?, bold?, dim?, italic?, underline?, reversed?, strikethrough? | **stable** | core augmentation adds hyperlink/underlineStyle/underlineColor (index.ts:158–171); hyperlink/underline fields are JS-side additions, not napi-generated |
| D11 | `TernEventJs` (L776) | type, key?, width?, height?, focus_gained?, mouse?, paste?, lifecycle? | **stable** | tagged-union discriminated by `type` |
| D12 | `TuiRendererOptions` (L805) | exit_on_ctrl_c?, use_alt_screen?, title?, headless?, keyboard_enhancement?, scroll_optimization?, semantics?, width?, height? | **stable** | constructor options; camelCase-mapped in core `CreateRendererOptions` (index.ts:462+) |

##### Not re-exported through core's export-type block

| # | interface (line) | fields | Stability | Notes |
|---|------------------|--------|-----------|-------|
| D13 | `SelectionRange` (L663) | col1, row1, col2, row2 | **internal / mediated ABI** | not re-exported; core re-declares an identical local `SelectionRange` (index.ts:451–460); shape pinned by core `selectionWordRange` (index.ts:9527–9528); JS-facing name is the core-local type (re-exported onward by react index.ts:1778) |
| D14 | `HighlightAppendJs` (L428) | spans, changed?: number[] | **experimental** | output-only (`object_from_js = false`); companion DTO of `IncrementalHighlighter.append`; re-declared locally in addon.ts:74–80; pinned by core markdown streaming (index.ts:7109–7116) |

**Mediated-ABI notes.** All TuiRenderer/NodeHandle snake_case members are the
mediated ABI wrapped by core's camelCase `Renderer` / `Node` classes; the JS
front (core + react reconciler + solid) calls every one of the 31 class members
above (T1–T22, N1–N9), so each is transitively pinned by production usage —
none are dead surface. `last_flush_bytes` and `set_any_event_mouse` are the
least-JS-visible (wrapped as `lastFlushBytes` and driven implicitly by
mouse-listener counts). `SemanticsNodeJs` is a write shape; `SceneSemanticsJs`
and `HighlightAppendJs` are output-only (`object_from_js = false`), which lets
native `u64`/`[u32;2]` types stay non-JS-safe.

**Totals (napi):** 53 surface items (19 top-level declarations — 2 free
functions, 3 classes, 14 DTO interfaces — plus 34 class members) — **47
stable**, **5 experimental**, **1 internal / mediated**, **0
deprecation-candidate**.

## 1.0 冻结边界 (Freeze Boundary)

The 1.0 freeze boundary is the per-symbol contract this audit produces: what the
1.0 release promises (frozen), what it explicitly does not promise
(experimental), what is outside the consumer contract entirely (internal), and
what M5.2's deprecation lifecycle should process (deprecation candidates — see
the hand-off below).

### Frozen at 1.0 (stable — 519 symbols)

The frozen set is **every symbol tagged stable in the four inventory tables
above** (198 core + 134 react + 140 solid + 47 napi). Composition:

- **`@tern-tui/core` (198)** — the pre-M3 core (scene node, renderer, keymap,
  focus machinery, event types, theme model) and the full component surface:
  the primitives (`Text`/`Box`/`StreamingText`), every widget factory plus its
  props/state types and key/mouse/paste/control helpers (Input, Textarea,
  Spinner, StatusBar, Panels, DiffView, Select, Checkbox/Toggle/Radio, Menu,
  ScrollView, Table, Tree, Tabs, Progress, Canvas, BarChart/Chart/Sparkline,
  Modal, MarkdownView, HelpPanel), the highlight helpers, the creation-time
  theme API (`defaultTheme`/`mergeTheme`/`resolveTheme` + theme types), the
  napi DTO re-exports that back core signatures, and package metadata.
- **`@tern-tui/react` (134)** — the full host-component set minus the four
  unreleased families, the theme/focus/resize/mouse hook set, the reconciler
  root API (`createRoot`/`render`/`useApp`/`useInput`/`usePaste` + root types),
  and every core re-export that shipped in 0.1.0/0.2.0.
- **`@tern-tui/solid` (140)** — the element factories + their prop interfaces,
  the dispose\* lifecycle helpers, the pass-through wiring helpers
  (`subscribeStream`/`subscribeFocus`/`subscribeWheelScroll`/
  `subscribeClickFocus`), and the entire core/theme re-export surface.
- **napi backside (47)** — the JS stable typing contract: the 14
  re-export-through-core names (12 DTOs + `TuiRenderer` + `NodeHandle`), all 31
  TuiRenderer/NodeHandle class members, and the two free functions
  (`create_node`, `highlight`) pinned transitively by core's `Node`/`highlightCode`
  materialization.

### Stays experimental (opt-out, may break in minor — 85 symbols)

Not part of the 1.0 promise. Consumers opt in at their own risk; the surface may
change or move within 0.x and may break in a minor. Per surface:

- **`@tern-tui/core` (28)** — the M4.1 semantics surface (`syncSemantics`,
  `SemanticsDescriptor`, `SceneSemanticsJs`, `SemanticsNodeJs`), the M4.2
  `A11yStream` / `A11Y_STREAM_VERSION`, the M4.5 contrast checker
  (`auditTheme`, `contrastRatio`, `parseThemeColor`, `relativeLuminance`,
  `XTERM_256`, `ContrastFinding`, `Rgb`), the M4.5 runtime theme engine
  (`setTheme`, `getTheme`), the selection helpers (`SelectionRange`,
  `SELECTION_DOUBLE_CLICK_MS`, `selectWordAt`, `startSelection`,
  `dragSelection`, `endSelection`, `copySelection`, `selectionKey`), and the
  stream follow helpers (`isStreamFollowing`, `syncStreamTail`, `followTail`,
  `STREAM_AFFORDANCE_CHAR`, `scrollToBottom`).
- **`@tern-tui/react` (28)** — the `Menu` family (10: `MenuProps`, `Menu`,
  `MenuItem`, `MenuState`, `closeMenu`, `MENU_Z_INDEX`, `menuClick`,
  `menuHover`, `menuKey`, `openMenu`), the `Tree` family (10: `TreeProps`,
  `Tree`, `TreeNode`, `TreeRow`, `TreeState`, `toggleTreeNode`,
  `expandTreeNode`, `collapseTreeNode`, `treeKey`, `visibleTreeRows`), the
  chart widgets (6: `BarChartProps`, `BarChart`, `ChartProps`, `Chart`,
  `SparklineProps`, `Sparkline`), and the runtime theme engine (2: `setTheme`,
  `getTheme`). These wrap core surfaces that have never seen a release; freeze
  only after a release cycle proves the contracts.
- **`@tern-tui/solid` (24)** — the universal-renderer mount surface (12:
  `render`, `insert`, `spread`, `createElement`, `createTextNode`,
  `insertNode`, `setProp`, `mergeProps`, `effect`, `memo`, `createComponent`,
  `use`), the behavior-bearing M3-era wiring helpers (7: `subscribeInput`,
  `subscribeFocusTraversal`, `subscribePaste`, `subscribeResize`,
  `subscribePanelDrag`, `subscribeMenuMouse`, `subscribeSelection`), and
  `startSpinner`, `createTerminalDimensions` plus their option types (3:
  `SubscribeInputOptions`, `SubscribePasteOptions`, `StartSpinnerOptions`).
- **napi backside (5)** — the `IncrementalHighlighter` class (`constructor`,
  `append`, `reset`) and its companion DTO `HighlightAppendJs`: newer streaming
  path, behavior pinned by core's markdown fence pipeline, but not part of the
  stabilized re-export contract.

### Excluded from the boundary (internal — 23 symbols)

Not user-facing tern API; outside the freeze decision entirely. May be removed
or reorganized without notice or deprecation. Per surface:

- **`@tern-tui/core` (12)** — the WeakMap registries (`selectOptions`,
  `checkboxLabels`, `toggleLabels`, `radioOptions`), the test seams
  (`setAddonForTesting`, `setSelectionClockForTesting`,
  `resetIncrementalHighlightCache`, `framesEqual`, `styledFramesEqual`), the
  `@internal`-tagged `setStreamAutoScroll`, and the addon plumbing
  (`loadAddon`, `TernAddon`).
- **`@tern-tui/react` (5)** — `hostConfig`, `toNodeProps`,
  `THEME_HINT_CARRIER`, `ReactThemeHint`, `AppContext` — tooling/test or
  module-internal plumbing; three of these are not even re-exported from the
  package entry.
- **`@tern-tui/solid` (5)** — `replaceNode`, `rendererOptions`, and the
  vendored `universal.ts` contract (`createRenderer`, `Renderer<NodeType>`,
  `RendererOptions<NodeType>`) — the universal-renderer contract, not
  user-facing tern API.
- **napi backside (1)** — the `SelectionRange` napi shape (D13): not
  re-exported; core re-declares an identical local type that is the actual
  JS-facing name.

### Deprecation-candidate hand-off (M5.2 input)

**The hand-off list contains 1 symbol across all four surfaces.** The
`@tern-tui/solid` `renderer` export (index.ts:562) — the configured
`UniversalRenderer<Node>` instance — is superseded by the destructured mount
primitives (`render`, `insert`, `spread`, `createElement`, `createTextNode`,
`insertNode`, `setProp`, `mergeProps`, `effect`, `memo`, `createComponent`,
`use`) and is scheduled for removal in **0.4.0**. It carries the only
`@deprecated` marker found in any audited file; every other non-seam export is
current, and all test/reconciler seams are tagged `internal` (excluded) rather
than deprecated.

The M5.2 deprecation lifecycle (deprecate → warn → remove, ≥ 1 minor cycle,
per the roadmap) should nevertheless seed its first walk-through from the
forward-looking watch items this audit surfaced:

| Watch item | Symbols at risk | When it becomes a candidate | Candidate replacement |
|------------|-----------------|-----------------------------|------------------------|
| Solid universal-renderer mount surface (experimental) | `render`, `insert`, `spread`, `createElement`, `createTextNode`, `insertNode`, `setProp`, `mergeProps`, `effect`, `memo`, `createComponent`, `use` | If the 1.0 freeze narrows the official mount API to a `render`-only contract | A narrower documented mount API (e.g. `render` only), named at M5.2/M5.7 decision time (`renderer` moved to deprecation-candidate in M5.2 — see hand-off above) |
| Solid behavior-bearing wiring helpers (experimental) | `subscribeInput`, `subscribeFocusTraversal`, `subscribePaste`, `subscribeResize`, `subscribePanelDrag`, `subscribeMenuMouse`, `subscribeSelection` | If the 1.0 freeze narrows them (they carry solid-local behavior M5.1 declined to freeze) | None named yet — decision deferred |
| napi `IncrementalHighlighter` / `HighlightAppendJs` (experimental) | `IncrementalHighlighter` (constructor/`append`/`reset`), `HighlightAppendJs` | If the markdown streaming path is reworked before 1.0 | None — not part of the re-export contract |

The remaining watch items above are **not** deprecation candidates today — they
are experimental surface M5.2 should re-check when the freeze narrows. M5.2
must not run a deprecation cycle on any of them without a new decision.

### Cross-surface reconciliation

The three package audits used two defensible but different classification bases:
the core audit classified by **era** (stable = pre-M3 core + all components;
experimental = M3/M4-era surface), while the react audit classified by
**release vintage** (stable = shipped in 0.1.0/0.2.0 and unchanged since), and
the solid audit recorded core re-exports as stable-by-inheritance while
deferring canonical intent to the core audit. This produces a small contested
band of **13 core-origin helpers** — the 0.2.0 selection helpers
(`SelectionRange`, `SELECTION_DOUBLE_CLICK_MS`, `selectWordAt`,
`startSelection`, `dragSelection`, `endSelection`, `copySelection`,
`selectionKey`) and stream-follow helpers (`isStreamFollowing`,
`syncStreamTail`, `followTail`, `STREAM_AFFORDANCE_CHAR`, `scrollToBottom`) —
tagged **experimental** in the core audit but **stable** in the react audit
(they shipped in 0.2.0 and react re-exports them as released surface). The
boundary resolves the contest as follows:

- **Semver already protects the released subset.** These 13 shipped in the
  0.2.0 release (2026-08-10); breaking their signatures still requires the M5.2
  deprecation cycle regardless of the boundary tag. The boundary therefore
  treats them as **de-facto frozen**, and the core audit's experimental tag is
  read as "behavior refinements allowed, additive-only" — exactly what
  happened with `useSelection`'s copy-on-release overlay refinement
  (2026-08-19, core `5be6101`, signature unchanged).
- **`setTheme` / `getTheme`** are experimental on core and react (M4.5,
  never released) and only stable-by-inheritance in the solid table; the
  boundary takes the stricter claim — **experimental**.
- The menu/tree divergence (stable on core and solid, experimental on react) is
  **surface-scoped, not a contradiction**: the core factory (`Menu`, `Tree`)
  and the solid factory are the released core surface, while the react `<Menu>`
  / `<Tree>` host components shipped M3.2 / Phase 8 (unreleased) and wrap them.
- M5.7 (the 1.0 release) should re-verify the contested band before declaring
  the freeze, per the checklist in the boundary-change process below.

## Rationale

**Why `@tern-tui/core` is frozen.** Core is the contract every other surface
consumes — the reconcilers, the examples, and downstream apps all import it, and
it has shipped in two releases (0.1.0, 0.2.0). Its frozen surface is the
longest-lived code in the repo: the pre-M3 core (scene node, renderer, keymap,
focus, theme model, event types) and the component set that released features
and roadmap milestones (M1–M4) all depend on. Freezing it is what makes the
M5.7 1.0 declaration meaningful — it is the surface consumers type against. The
deliberate hold-backs are the M4-era additions (semantics, a11y stream, contrast
checker, runtime theme engine) and the selection/stream-follow helpers, which
either postdate the last release or carry behavior the team is still refining —
they are the opt-in experimental band, not the promise.

**Why `@tern-tui/react` is frozen.** The React host components, hooks, and root
API are the most-used entry point; their props contract has been stable since
0.1.0/0.2.0 and the hook set has seen only additive refinements since. The audit
found no superseded symbol and no `@deprecated` marker, so freezing the released
host/hook/reconciler surface costs nothing today. The four unreleased families
(Menu, Tree, charts, runtime theme engine) stay out because none has survived a
release cycle — freezing unreleased surface would be a promise with no track
record.

**Why `@tern-tui/solid` is (mostly) frozen.** The Solid surface is a
feature-parity mirror of React over the same core factories: the element
factories and their props are the user-facing API and are frozen for the same
reason as React's hosts. The deferrals are where Solid differs from React — the
vendored universal-renderer mount primitives (`render`/`insert`/`spread`/…) are
part of the solid-js contract rather than a tern API decision, and the
behavior-bearing wiring helpers (`subscribeInput` and friends) carry
solid-local routing/traversal logic that M5.1 declined to bless. Freezing the
factories while holding the wiring helpers back keeps the promise exactly where
the package's own surface starts.

**Why the napi backside is frozen.** The napi declarations are the mediated ABI
under everything, and every one of the 31 TuiRenderer/NodeHandle members is
called by production JS — none are dead surface. Freezing them pins the
snake_case ABI so the camelCase JS wrappers cannot silently shift underneath
consumers. The two not-re-exported shapes (`SelectionRange` napi, the vendored
seams) are internal by definition — they are implementation detail, and the
single experimental class (`IncrementalHighlighter`) is a newer streaming path
not part of the re-export contract.

**Why the experimental set stays out.** Every experimental symbol either (a)
postdates the last release (M4.1 semantics, M4.2 stream, M4.5 contrast/theme
engine; react Menu/Tree/charts; solid wiring helpers) or (b) carries behavior
the team is still refining (selection/stream-follow helpers, whose 2026-08-19
refinement postdates 0.2.0). The roadmap risk note for M5 states it directly:
"1.0 冻结后新能力只能走 minor 版本——冻结边界必须经过 M5.1 严格审计" — after 1.0,
new capability can only land in minors, so the boundary must be strict. Holding
these back is the strictness; they opt in at the consumer's own risk and are
re-evaluated before 1.0.

## Boundary-change process

The freeze boundary is a living record: every tier change must update the
relevant inventory table **and** this section, and must be noted in the
CHANGELOG. The semver contract after 1.0:

| Transition | Allowed when | Procedure |
|------------|--------------|-----------|
| **stable → deprecation-candidate** | A symbol is superseded or must be removed | M5.2 lifecycle only: deprecate → warn → remove across **≥ 1 minor release cycle**; replacement name recorded in this document. Never silent. |
| **experimental → stable** | The symbol survives ≥ 1 release cycle (minor or patch) with no contract change | Promotion decision + CHANGELOG note + this document updated. Promotion is the reward for a proven contract; it cannot happen in the same release that introduces the symbol. |
| **experimental → deprecation-candidate** | The freeze narrows the experimental band | M5.2 lifecycle, same as stable → candidate. |
| **internal → (any tier)** | A seam becomes consumer-facing | Deliberate decision + doc update. Internal symbols may otherwise be removed or reorganized **without** deprecation in any version — that is the point of excluding them. |
| **new symbol** | Any new export | Enters as **experimental** by default (or **internal** for seams/tests). It becomes stable only through a release cycle, per the promotion row. |

**Pre-1.0 (0.x):** breaking changes to *frozen-at-1.0* symbols still require the
deprecation cycle — the boundary is the commitment, and the audit date
(2026-08-27) is when it took effect. **At 1.0 (M5.7):** the boundary declared
here becomes the release contract; breaking a frozen symbol afterwards requires
a **major** version. **M5.7 checklist:** re-verify the 13-symbol contested band
(selection/stream-follow helpers) and the `setTheme`/`getTheme` tag before the
1.0 declaration, and confirm no experimental symbol has silently shipped in a
release since this audit.
