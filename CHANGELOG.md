# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Push-based event delivery (roadmap Phase 3):** `TuiRenderer::start_event_stream`
  (`tern-node`) builds a `napi::ThreadsafeFunction<TernEventJs>` and spawns
  tern-terminal's background event loop (`spawn_event_loop` /
  `run_event_loop`), pushing every terminal event to the JS thread — no
  polling loop in the app hot path, and no event loss (unbounded queue). The
  `@tern/core` `Renderer` exposes `events` (an `AsyncIterable` of tagged
  `TernEventJs`) and an explicit `startEventStream()`; the `onKey` /
  `onResize` / `onFocus` / `onMouse` handlers are fed by the push stream.
  `poll_events` remains available behind the `poll-fallback` cargo feature
  (default build ships push delivery). With `exitOnCtrlC`, a Ctrl+C press is
  still delivered (push consumers observe it) and then tears the renderer
  down.
- **`StatusBar` reserved viewport row (roadmap Phase 2):** the `StatusBar`
  strip is stamped `status_bar: true` (both the Rust renderable at
  materialization and the JS `StatusBar` factory); the compositor reads the
  marker and reserves the bottom viewport row — panels and scroll regions lay
  out one row shorter, and the strip (with its whole subtree) is pinned to
  the reserved row, so nothing overlaps it. Asserted by the compositor golden
  test `golden_panels_and_status_bar_reserve_bottom_row`.
- **`flex_basis` layout reflow (roadmap Phase 2):** tern-layout maps the
  `flex_basis` prop into taffy's flex-basis, so a pane's basis resolves
  through the layout engine (the prop the panel drag-resize helpers record on
  the scene node now actually reflows the pane split); `flex_basis` accepts
  `Int` / `Float` cells, defaulting to `auto`.
- **`MarkdownView` widget:** a `markdown` element (in `@tern/core`) rendering
  a Markdown source as a flex column of block nodes — headings (bold, H1
  underlined), paragraphs, bulleted/ordered lists, block quotes, horizontal
  rules, and code fences (a `bg` box, one leaf per line) — with `**bold**` /
  `*italic*` / `` `code` `` / `[links](url)` inline styles parsed into
  per-span `Text` leaves. Parsing is best-effort and streaming-friendly: a
  half-open code fence renders its collected lines as the fenced block, and
  an unclosed inline marker styles the rest of its line. No new napi node
  kind: the element materializes as a `box` (constitution).
- **tree-sitter syntax highlighting (roadmap Phase 4):** a `tern-highlight`
  crate vendors a tree-sitter runtime plus grammars (Rust, TS/JS, JSON,
  shell), each bundling its own `HIGHLIGHTS_QUERY`; `highlight` maps node
  captures to style spans (keywords, strings, comments, types) over the whole
  source. A napi `highlight` binding surfaces the span stream to JS;
  `highlightCode` in `@tern/core` feeds it into `MarkdownView` code fences —
  a fence with a recognized language renders one styled leaf per line with
  token colors (unknown languages / unavailable addon fall back to the single
  fence style).
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
  `onChange` / `onSubmit`), `Textarea` in `@tern/solid` (feature parity:
  `focusId` focus registration via `useFocus`, `editTextareaKey` routing,
  `onChange` / `onSubmit`, disposed via `disposeTextareaFocus`).
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
