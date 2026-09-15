
export { createRoot, render, useApp, useInput, usePaste } from "./reconciler/hooks.ts";
export { toNodeProps } from "./reconciler/host.ts";
export type { ReactThemeHint } from "./reconciler/host.ts";
export { AppContext, hostConfig } from "./reconciler/host_config.ts";
export { THEME_HINT_CARRIER } from "./reconciler/props.ts";
export type { AppHandle, TernContainer, TernNoTimeout, TernProps, TernRoot, TernTimeoutHandle, UseInputHandler, UseInputOptions, UsePasteHandler, UsePasteOptions } from "./reconciler/types.ts";

/**
 * @tern-tui/react — mutation-mode react-reconciler HostConfig for tern.
 *
 * Maps React host components onto tern scene nodes through the `packages/core`
 * factories (`Box` / `Text` / `StreamingText` / `Node`). The tree lives in the
 * tern scene; the reconciler is a thin driver that translates React's
 * commit-phase mutations into `Node.addChild` / `Node.remove` /
 * `Node.setProps` calls.
 *
 * ## HostConfig mapping (per the MVP strategy)
 *
 * - `supportsMutation: true` — mutation mode (append/insert/remove ops).
 * - `createInstance(type, props)` -> tern node via `Box(props)` /
 *   `Text(props)` / `StreamingText(props)` / `Input(props)` / `Spinner(props)`
 *   / `StatusBar(props)` / `Panels(props)` / `DiffView(props)` /
 *   `Select(props)` / `Menu(props)` / `ScrollView(props)` / `Table(props)` /
 *   `Modal(props)`.
 * - `createTextInstance` throws — tern requires an explicit `<Text>` element,
 *   bare string children are rejected at render time.
 * - `appendChild` / `insertBefore` / `removeChild` -> tern tree ops. The core
 *   `Node` API exposes an ordered insert (`Node.insertBefore` ->
 *   `NodeHandle.insert_before`), so `insertBefore` places the child at the
 *   anchor with full reorder fidelity. react-reconciler reuses host instances
 *   across updates, so an `insertBefore`/`appendChild` on an already-present
 *   child is a reposition (keyed-list move) and is realized as a
 *   remove-then-insert against the core API, which throws on duplicates.
 * - `commitUpdate` -> `Node.setProps` (React-only props stripped).
 * - `resetAfterCommit` -> `renderer.render()` (the single paint per commit;
 *   `prepareForCommit` no longer paints — the pre-commit paint was redundant
 *   with the post-commit one).
 * - `noTimeout: -1`; `scheduleTimeout` / `cancelTimeout` -> `setTimeout` /
 *   `clearTimeout`.
 * - Event priority: react-reconciler 0.33 renamed `getCurrentEventPriority`
 *   to `setCurrentUpdatePriority` / `getCurrentUpdatePriority` /
 *   `resolveUpdatePriority`. Tern has no event system, so updates are always
 *   default priority (`DefaultEventPriority` from
 *   `react-reconciler/constants`).
 */

// The `.js` suffix is required: react-reconciler@0.33.x ships no `exports` map,
// so the extension-less `react-reconciler/constants` fails under Node ESM.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prop sanitizing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M4.5 runtime theme hint carrier
//
// The host components resolve their `role` / `component` hints through the
// core `resolveTheme` at element-creation time, stamping plain style keys.
// The core runtime theme engine (`setTheme` / `getTheme`, M4.5 subtask 1)
// re-resolves every node it has *recorded* — and the recording happens in
// the core `Node` constructor, which reads a module-private Symbol that
// `resolveTheme` stamps onto its returned props.
//
// That Symbol cannot ride a React element: `createElement` copies its config
// with `for...in`, which iterates string keys only, so the Symbol would be
// dropped before the reconciler ever sees it. The host components therefore
// carry the hint under a string key (`resolveHostTheme` in `index.ts`), and
// `toNodeProps` re-materializes it as the Symbol right before the core
// factory call — so the node is recorded and a later core `setTheme` can
// re-resolve it in place, WITHOUT a React re-render.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tree ops over the tern Node API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HostConfig
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reconciler + root API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
