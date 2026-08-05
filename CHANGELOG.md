# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Terminal capabilities, window title, and alt-screen option:** the
  tern-terminal backend detects the terminal's color support once via the
  `supports-color` crate and exposes it as `Backend::capabilities()`
  (`{ truecolor, colors }` — truecolor plus a 16M/256/16/0 palette size,
  defaulting to truecolor when detection is inconclusive). RGB cells are
  quantized to the nearest ANSI 256-color index (6x6x6 cube + grayscale
  ramp, `rgb_to_ansi256`) when truecolor is unsupported, instead of
  emitting a sequence the terminal cannot render. `Backend::set_title`
  (and the `@tern/core` `Renderer.setTitle`) sets the terminal window
  title (OSC 0). The `TuiRenderer` constructor takes `use_alt_screen`
  (default `true`; `false` renders inline in the main screen, skipping the
  alternate-screen enter/leave escapes — including teardown) and `title`
  options, surfaced as `useAltScreen` / `title` on `@tern/core`
  `createRenderer`; the `Renderer.capabilities` getter reports the
  detected color support.
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
- **Paste events end to end (crossterm bracketed paste):** the Rust
  `tern-terminal` backend enables bracketed paste (`EnableBracketedPaste`)
  and normalizes `CrosstermEvent::Paste` into `TernEvent::Paste(String)`,
  surfaced to JS as a `"paste"` variant of the `TernEventJs` union carrying
  `paste: string`. The `@tern/core` `Renderer` gains `onPaste(handler)`
  (receiving the pasted text string; returns an unsubscribe), and the
  `renderer.events` async iterable yields `{ type: "paste", paste }`.
  `FocusManager.routePaste` (the paste counterpart of `routeKey`) dispatches
  to an explicit node or the active focus, and `useFocus(id, node, onKey,
  manager?, onPaste?)` registers a paste handler — an element without one
  never consumes, so the paste falls through to the tree-level handler.
  `pasteInto(input, text)` inserts at the caret (multi-width aware, returning
  `{ value, caret }`) and `pasteIntoTextarea(textarea, text)` splits pasted
  newlines into logical lines (returning `{ lines, row, col }`).
  `usePaste(handler, { isActive, focusManager })` (`@tern/react`) and
  `subscribePaste(renderer, handler, { isActive, focusManager })`
  (`@tern/solid`) route each paste through the `FocusManager` first; a
  focused `<Input focusId>` / `<Textarea focusId>` auto-pastes via `pasteInto`
  / `pasteIntoTextarea`, firing `onChange` (an empty paste is a no-op).
- **`DiffView` side-by-side mode + intra-line highlight:** `mode="side"`
  renders two aligned columns (old | new) split by a 1-cell gap (mirroring
  `Panels`), each hunk line one row per column aligned by line pair, with
  per-column gutters; `inline_highlight` computes a char-level diff on each
  adjacent add/del pair and renders the changed segments bold + underlined on
  the line's kind color. Both props are consumed at the factory — they never
  reach the scene props.
- **`Table` windowing:** only the visible window `rows[scroll_y, scroll_y +
  clip_height)` is materialized — a large dataset no longer creates one scene
  node per row (**windowed rows**; the 10k-row table test asserts a bounded
  row window). The full dataset stays JS bookkeeping in `tableRegionStates`,
  and the scroll clamp measures the full content height; `wheelScroll` /
  `tableKey` refresh the window on scroll.
- **Streaming scroll-to-bottom affordance:** a manual scroll above the
  stream tail detaches the follow and stamps `STREAM_AFFORDANCE_CHAR` (`▼`),
  absolutely positioned at the clip region's bottom-right (paint z-order 2,
  above the scrollbar leaf); `scrollToBottom(node)` is a one-shot jump to the
  tail (clamped) that dismisses the affordance without re-attaching the
  follow — `followTail` is the explicit re-attach.
- **Frame snapshot testing (`snapshotFrame`):** `TuiRenderer::render_to_buffer`
  paints the shared scene into a fresh buffer at a given viewport (no terminal
  I/O) and returns one string per row (masked/continuation cells are spaces,
  so every row is exactly `width` display columns — multi-width aware);
  `Renderer.snapshotFrame(width?, height?)` surfaces it and `framesEqual(a, b)`
  compares two frames for golden testing.
- **`Tabs` widget:** a `tabs` element (in `@tern/core`) composing a tab bar
  row — one `Text` leaf per tab, the active tab painted with the theme
  `primary` palette colors and reversed with a top-border marker (`▔`),
  closable tabs carrying a close glyph (`×`) — plus a content region box
  holding the active tab's content nodes; driven by `activateTab` / `closeTab`
  / `tabsKey` (`left` / `right` move, `ctrl+tab` / `ctrl+shift+tab` wrap,
  `ctrl+w` closes); `<Tabs>` in `@tern/react` and `Tabs` in `@tern/solid` with
  `focusId` / `onChange` / `onClose` (+ `disposeTabsFocus` in solid). No new
  napi node kind (materializes as a `box`).
- **`Progress` widget:** a `progress` element (ratatui Gauge parity) — a
  framed single-row gauge (default `border_style: "plain"`) with an in-flow
  fill leaf (`▓` × ceil(value/max × inner), `░` for the rest), an optional
  dimmed label leaf left-aligned inside the bar area (composed only when it
  fits) and an optional percentage readout (`ceil(value/max×100)%`)
  right-aligned, both absolute overlays; `ratio` (0..1) drives the bar
  directly as an alternative to `value`/`max`; `setProgress(node, value,
  max?)` repaints a live bar in place (no rebuild); `<Progress>` in
  `@tern/react`, `Progress` in `@tern/solid`.
- **Focus traversal:** `useFocusTraversal({ manager?, exclude? })`
  (`@tern/react`) and `subscribeFocusTraversal(renderer, manager?, exclude?)`
  (`@tern/solid`) wire Tab / Shift+Tab to `FocusManager.next()` / `prev()` —
  skipping excluded ids, re-rendering after each move, and handling traversal
  keys ahead of focused-element routing (bare Tab/Shift+Tab always move focus,
  standard TUI behavior).
- **Escape-sequence run batching:** the tern-terminal backend's cell queueing
  merges consecutive updates that share a style, a row, and adjacent columns
  into single runs — one `MoveTo` to the run's first cell, one unconditional
  SGR reset plus the run's exact style applied once, and the run's characters
  in one `Print` — so a typical frame flushes a handful of runs instead of one
  sequence per cell (an internal frontend property; the diff flush stays a
  no-op for an unchanged frame).

### Performance

- **Scene-epoch no-op render fast path:** `TuiRenderer::render()` returns
  `Ok(())` with zero terminal writes when the scene's mutation epoch, the
  viewport, and the cached terminal size are all unchanged since the last
  paint. The scene-level `epoch` (a u64 bumped by every successful mutation,
  unchanged by reads and failed mutations) is compared under the same lock
  that painted the frame, so JS re-renders every animation tick but only real
  changes pay for I/O. The `RenderBackend` trait abstraction lets the fast
  path be proven zero-write under test.
- **Diff row-skip fast path:** `Buffer::diff` / `diff_from` first compare each
  row as a whole `&[Cell]` slice — identical rows (or rows blank in regions
  the previous frame does not cover) skip entirely, and the per-cell scan only
  runs on rows that actually changed (multi-width aware).
- **Empty-diff flush suppression:** an empty `CellUpdate` diff short-circuits
  the flush — when the caret parks where the previous flush left it, nothing
  is queued or flushed (zero bytes written); when only the park position
  moved, just the `MoveTo` is emitted.
- **Terminal size caching:** the renderer caches the probed terminal size
  (`cached_size`), so the hot render path skips the per-frame `size()` ioctl;
  a resize event invalidates the cache (`invalidate_size_on_resize`), forcing
  a re-probe and repaint at the new viewport. `hit_test` shares the cache.
- **Coalesced frame scheduling (`Renderer.requestFrame`):** new
  `requestFrame(callback?)` API schedules a native render on the next
  macrotask (`setTimeout` 0, `queueMicrotask` fallback); several calls within
  one tick collapse into a single native `render()` (pending-frame flag
  dedupe), and an explicit `render()` paints immediately and supersedes a
  pending frame. Returns a cancel function that aborts a still-pending frame
  and drops its queued callbacks.
- **Single paint per commit (`@tern/react`):** the reconciler's redundant
  pre-commit paint is gone — `prepareForCommit` no longer renders, and
  `resetAfterCommit` (`renderer.render()`) is the one paint per commit.
- **Escape-sequence run batching** (the flush-side half of the round): the
  run-merging flush is described in the Added section above.
- **Props incremental sync:** a new native single-key `NodeHandle.set_prop`
  path replaces the per-update full JSON serialization + whole-map replace.
  `@tern/core`'s `Node.setProps` diffs the incoming map against the current
  props and pushes only the changed keys through `set_prop` (removals fall
  back to the full-map replace); `Node.setProp` is the direct single-key
  surface. Equal-value writes — at the TS mirror, the binding, and the scene
  — are skipped entirely: no replace, no scene-epoch bump, no layout dirtying,
  so the renderer's no-op fast path still applies to re-renders that change
  nothing.
- **Incremental layout:** `TaffyLayoutEngine` (tern-layout) is now stateful —
  it owns the taffy tree, caches it across frames, and reconciles it against
  the current scene instead of rebuilding it. Each cached node keeps a
  scene-input snapshot; the reconcile walk calls taffy's `mark_dirty` only on
  nodes whose inputs changed, so taffy re-lays-out just the dirty subtrees. A
  cold cache or fresh scene takes a full rebuild (the correctness baseline
  every incremental result is tested against); a frame changing more than
  half the tree falls back conservatively to a full rebuild. Instrumented
  (`full_rebuilds` / `last_reconciled_node_count`) so tests can prove a
  one-cell mutation reconciles one subtree.
- **Dirty-region repaint:** the compositor no longer paints the whole scene
  per frame. It retains the last buffer, last rects, and per-node paint
  signatures; a changed frame computes the dirty union over the changed
  nodes' OLD ∪ NEW bounds, blanks it in the retained buffer, repaints only
  the nodes intersecting the union into a blank scratch frame, and copies the
  union back (`copy_rect`) — cell-for-cell identical to a full repaint (the
  consistency tests enforce this). An unchanged scene returns the retained
  buffer as-is (a compositor-level no-op twin of the renderer's epoch fast
  path); a full repaint happens only on a cold cache, viewport change, fresh
  scene, or a dirty region covering >half the viewport. Instrumented
  (`last_paint_mode` / `last_repainted_node_count`) so tests can prove a
  one-cell mutation takes the dirty path and a resize the full path.
- **Pushed dirty set (change detection):** the per-frame whole-tree
  paint-signature walk is gone. `Scene` records the id of every node a
  mutation touches, and `Compositor::paint_dirty` drains that set
  (`Scene::take_dirty`) and collects/compares paint signatures only for the
  pushed ids (`collect_paint_sigs_for`) — O(mutated) instead of O(nodes) per
  frame. The all-node old-vs-new rect comparison stays as the repaint
  region's correctness backbone, a raw `node_mut` borrow (unintrospecatable
  by the scene) sets a force-full-scan flag that falls back to the whole-tree
  walk, and a full paint consumes the set to keep it consistent — the pushed
  set only narrows signature work, never gates the repaint decision. Measured
  on the synthetic bench: single-cell frames −24.7% (TS) / −24.0% (Rust) p50
  vs round 2 (≈ −50% cumulatively), no-change frames still ~0, requestFrame
  burst still coalesces at ratio ~1.0 (`tools/bench/BASELINE.md` → "Round 3
  after").

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
