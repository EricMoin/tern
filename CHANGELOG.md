# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `Table` widget: a sticky header row (paint z-order 1) above a scrollable
  content region, one row leaf per data row with per-column width/alignment
  (padded cells, overflow truncated never mid-glyph), the highlighted row
  reversed — driven by `tableKey` (up/down highlight + auto-scroll, clamped
  to the content bounds) and `visibleTableRows` (the visible window);
  `<Table>` in `@tern/react`, `Table` in `@tern/solid`.
- `Textarea` widget (Rust + JS): a multi-line editor renderable in
  `src/core/tern-components/src/textarea.rs` (plain state plus editing
  operations — `lines` + char-index `row`/`col` cursor, token-aware soft
  wrap via `wrap_line`, lazy vertical windowing, and a renderer-agnostic
  `Key` / `KeyAction` mapping), surfaced in JS with a `lines` + `row`/`col`
  cursor, `width`-bounded soft wrap, `height`-bounded visible window with
  scroll-to-caret, `enter` line splitting, and up/down across soft-wrapped
  display lines preserving a preferred column — `editTextareaKey`;
  `<Textarea>` in `@tern/react` (with `focusId` / `focusManager` /
  `onChange` / `onSubmit`), `Textarea` in `@tern/solid`.
- `Modal` widget: a full-bleed dimmed overlay (`MODAL_Z_INDEX` 100) with a
  centered content box — `openModal` / `closeModal` toggle visibility
  (`hidden` + `display`) and move focus in/out through the `FocusManager`,
  saving the previously active focus on open and restoring it on close.
- Mouse wheel scroll: the core `wheelScroll(view, event)` maps
  `scroll_up` / `scroll_down` / `scroll_left` / `scroll_right` to `scrollBy`
  ±1 (a `table` scrolls its content region so the sticky header stays
  pinned); wired by `useWheelScroll` (`@tern/react`) and
  `subscribeWheelScroll` (`@tern/solid`).
- Click-to-focus: the core `focusAt(renderer, event)` routes a `down_left`
  press on a painted cell (`Renderer.hit_test`) to the topmost registered
  focusable node; wired by `useClickToFocus` (`@tern/react`) and
  `subscribeClickFocus` (`@tern/solid`).
- `FocusManager` traversal, subscription, and reverse index: `next` /
  `prev` (wrap-around), `focusFirst`, `focusIdFor` (the scene-node-to-id
  reverse index), and `subscribe` / `unsubscribe` for focus-change
  callbacks (the new active id, or `null` on blur / unregister of the
  active focus).
- Multi-platform napi release pipeline: a tag-triggered / manually
  dispatched publish workflow (`.github/workflows/publish.yml`) that gates
  on pack integrity (no `*_test.ts` shipped), a native addon build +
  load-check, and the `napi create-npm-dirs` platform-package wiring
  (`tern-node-<platform>` optionalDependencies for linux-x64-gnu,
  linux-arm64-gnu, darwin-x64, darwin-arm64, win32-x64-msvc), then
  publishes `@tern/core` / `@tern/react` / `@tern/solid`.

## [0.1.0] - 2026-08-02

Initial release of tern: a Rust-native TUI renderer driven by React and SolidJS
reconcilers over a napi bridge. The release bundles three shipped milestones:
the MVP, the roadmap element set, and the Phase 2 event surface.

### Added — MVP (first runnable milestone)

- Rust workspace scaffold (`Cargo.toml` Fuchsia-style layout, pinned stable
  Rust 1.94 via `rust-toolchain.toml`).
- `tern-core`: scene tree (`SceneNode`), buffer diff, and style primitives.
- `tern-layout`: taffy-based layout engine over the scene tree.
- `tern-terminal`: crossterm backend with event normalization and minimal
  escape-sequence diff flush.
- `tern-components`: compositor and the imperative `Text` / `Box` renderables.
- `tern-node`: napi-rs v3 binding bridging Deno/Node.js into `tern-core`.
- `tern-demo`: example binary driving the render pipeline in a real terminal.
- JS workspace: `@tern/core` TypeScript bindings, `@tern/react`
  (react-reconciler custom renderer), `@tern/solid` (vendored solid-js 1.9.14
  universal renderer), `@tern/examples` (React/Solid demos with a PTY smoke
  harness).
- Docs: `docs/architecture.md`, `docs/components.md`, `docs/roadmap.md`.

### Added — Roadmap elements (code-agent component set)

- `streaming_text` node with span streams end to end: core node, layout sizing
  to span content, soft-wrap painting, napi `streaming_text` /
  `insert_before` / `append_span` bindings, and `StreamingText` host
  components in `@tern/react` and `@tern/solid` (`subscribeStream`).
- Clip/scroll regions and a caret model in `tern-core`; flex props, absolute
  positioning, and region attributes in `tern-layout`.
- Z-order painting, region clipping, and the `Input` / `Spinner` /
  `StatusBar` / `Panels` roadmap renderables in `tern-components`, with
  element factories in `@tern/core` and host components in `@tern/react` and
  `@tern/solid` (feature-parity factories).
- Focus routing: core `FocusManager` with `useFocus` / `routeKey`;
  tree-level input hooks (`useInput` in React, `subscribeInput` in Solid)
  consult the manager before falling back to the tree handler.
- Correct sibling ordering: `insertBefore` honored in the React reconciler and
  the core JS layer (subtree detach on remove).
- Mouse/focus terminal events and caret flushing; movable caret in the Rust
  demo.
- CI: workspace build + test workflow (`.github/workflows/ci.yml`).

### Added — Phase 2 event surface (resize, focus & mouse)

- `tern-node` surfaces resize, focus, and mouse terminal events through
  `poll_events`; `@tern/core` `Renderer` exposes `onResize` / `onFocus` /
  `onMouse` handlers fed from the tagged `TernEventJs` union
  (`"key"` / `"resize"` / `"focus"` / `"mouse"`).
- `onResize` receives `{ width, height }`, `onFocus` receives
  `{ focus_gained }`, `onMouse` receives a `MouseEventJs` payload.
- Consuming the surface — layout reflow on resize, mouse drag-resize handles
  for `Panels`, and focus-aware redraw — remains tracked in
  `docs/roadmap.md` Phase 2.

[0.1.0]: https://github.com/EricMoin/tern/releases/tag/v0.1.0
