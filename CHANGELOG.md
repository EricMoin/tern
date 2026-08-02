# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
