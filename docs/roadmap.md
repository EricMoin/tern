# tern Roadmap (post-MVP)

This document tracks the phases after the first runnable milestone (MVP:
core rendering + layout + terminal frontend + napi binding skeleton + minimal
React renderer). It complements [architecture.md](architecture.md) (pipeline)
and [components.md](components.md) (widget roadmap).

## Guiding goals

- **Code-agent readiness.** The component set in [components.md](components.md)
  is the yardstick: streaming output, markdown, diffs, input, progress,
  multi-panel layouts, status, selection.
- **Deno-first runtime support.** The JS side is developed and tested against
  **Deno** as the primary runtime (`deno check` / `deno test` drive
  `packages/*`), with Node.js compatibility as a tracked secondary target.
  Every new JS-facing API (including the napi bridge) must keep this goal: it
  must run under `deno` first, and the bridge must not assume Node-only
  runtime globals. (napi-rs supports Deno via `--unstable` napi interop; the
  binding and the reconciler should not depend on `node:`-only APIs.)

## Phase 1 — Complete the solid renderer ✅ done

**Status:** shipped.

**Goal:** `@tern/solid` reaches feature parity with the MVP React renderer.

**Context:** the MVP ships a minimal `@tern/react` custom renderer
(`packages/react`); `packages/solid` now ships a universal renderer wired over
`@tern/core` — a vendored solid-js 1.9.14 universal renderer
(`packages/solid/src/universal.ts`; vendored because Deno/Node resolve the
bare `solid-js` specifier to its *server* build, which carries no reactive
runtime). SolidJS's fine-grained reactivity is a natural fit for a TUI:
individual cells/regions can re-render on signal change without whole-tree
diffing.

**Shipped:**

- The Solid universal renderer (`render()` onto a tern scene root) — the
  canonical solid-js `RendererOptions` tree ops mapped onto the `@tern/core`
  `Node` API (`insertNode`/`removeNode`/`setProperty`/traversal callbacks),
  with `rendererOptions` exported for tests and embedders.
- Roadmap element factories `Input`/`Spinner`/`StatusBar`/`Panels` with
  feature parity to the `@tern/react` host components — same props produce
  the same scene node structure.
- `subscribeInput` (Solid-flavored `useInput`: routes each key through the
  core `FocusManager` first, falling back to the tree handler),
  `subscribeStream` (feeds an `AsyncIterable<Span>` to a `streaming_text`
  node), `replaceNode`, and the core focus/edit helpers re-exported.

**Exit criteria (met):** `deno test packages/solid` passes — the suite covers
the full exported surface (renderer tree ops, roadmap element factories,
focus routing, stream subscription, replacement) against `@tern/core`.

## Phase 2 — Resize, focus & mouse events ✅ done

**Status:** shipped.

**Goal:** surface the terminal's resize, focus, and mouse events through the
JS API and use them for real UI behavior — layout reflow on resize, mouse
drag-resize for panels, and focus-aware redraw.

**Context:** the event model surfaces resize/focus/mouse via tern-node
`poll_events`: the `@tern/core` `Renderer` exposes `onResize` / `onFocus` /
`onMouse` handlers that `pollEvents()` feeds from the tagged `TernEventJs`
union (`"key"` / `"resize"` / `"focus"` / `"mouse"`). `onResize` receives
`{ width, height }`, `onFocus` receives `{ focus_gained }`, `onMouse`
receives `MouseEventJs`. The consumers below are shipped.

**Shipped:**

- **Resize → layout reflow:** `useResize(handler)` in `@tern/react` and
  `subscribeResize(renderer, handler)` in `@tern/solid` subscribe a
  renderer's resize events and re-invoke `renderer.render()` after each, so
  the compositor re-lays out the scene at the new terminal size.
- **Mouse drag-resize handles for [Panels](components.md#panels--split-layouts):**
  the core `startPanelDrag` / `dragPanels` / `endPanelDrag` helpers map
  `onMouse` drags on the 1-cell gutters between panels to `flex_basis`
  changes on the adjacent panes (clamped to the pane's min size, and to the
  space the neighbor's min size leaves). Wired by `usePanelMouseDrag`
  (`@tern/react`) and `subscribePanelDrag` (`@tern/solid`), gated by
  `Renderer.hit_test` so only painted gutter cells start a drag. The
  flex-basis mutation is recorded on the scene node and consumed by the
  layout engine (tern-layout maps the prop into taffy's flex-basis), so a
  drag reflows the pane split.
- **Focus-aware redraw:** the `@tern/react` `<Spinner>` mount effect and the
  `@tern/solid` `startSpinner` skip `tick()`/`render()` while the terminal is
  unfocused (an `onFocus` event with `focus_gained: false`) and resume on
  focus regain.

**Exit criteria (met):** resizing the terminal re-flows the scene via
`useResize` / `subscribeResize`; dragging a panels gutter with the mouse
changes the pane split (the drag math and the applied `flex_basis` are
asserted in the kitchen-sink demos and the `@tern/core` unit tests); a
spinning spinner's frames stop while the terminal is unfocused and resume on
focus regain (focus-aware tick, asserted by the `@tern/solid` suite).

## Phase 3 — Push-based events via napi ThreadsafeFunction ✅ done

**Status:** shipped.

**Goal:** replace the pull-based `poll_events` reverse channel with
push-based events delivered to the JS reconciler asynchronously.

**Context:** today key/resize/focus/mouse all return through tern-node
`poll_events`, dispatched to the `onKey` / `onResize` / `onFocus` / `onMouse`
handlers in `@tern/core` (packages/core). For a code agent, the host (LLM
stream, tool callbacks) and the terminal both generate events; a busy-loop
poll is wrong — it burns a thread and adds latency. napi-rs's
**ThreadsafeFunction** lets the Rust side call into the JS thread from any
Rust thread, queuing events to the JS event loop without polling.

**Shipped:**

- `TuiRenderer::start_event_stream` (`tern-node`) builds a
  `napi::ThreadsafeFunction<TernEventJs>` and spawns tern-terminal's
  background event loop (`spawn_event_loop` / `run_event_loop`), pushing
  every terminal event to the JS thread — no polling loop in the app hot
  path, no event loss (unbounded queue).
- `@tern/core` `Renderer` exposes `events` (an `AsyncIterable` of tagged
  `TernEventJs`) and an explicit `startEventStream()`; the `onKey` /
  `onResize` / `onFocus` / `onMouse` handlers are fed by the push stream.
  With `exitOnCtrlC`, a Ctrl+C press is still delivered (push consumers
  observe it) and then tears the renderer down.
- `poll_events` remains available behind the `poll-fallback` cargo feature
  (default build ships push delivery).

**Exit criteria (met):** a Rust-side `tokio`/thread emitter pushes N events;
the JS side receives all N without loss and with bounded latency; no polling
loop in the hot path. Runs under `deno` first (goal above).

## Phase 4 — tree-sitter syntax highlighting ✅ done

**Status:** shipped.

**Goal:** token-level syntax highlighting for code — inside
[MarkdownView](components.md#markdownview) code fences and in a future
dedicated code view.

**Context:** naive regex highlighting breaks on real code. tree-sitter gives
incremental, error-tolerant parsing — ideal for streaming agent output where
code arrives half-written.

**Shipped:**

- A `tern-highlight` crate with a vendored tree-sitter runtime + a small set
  of grammars (Rust, TS/JS, JSON, shell), each bundling its own
  `HIGHLIGHTS_QUERY`; `tern_highlight::highlight` maps node captures to
  style spans (keywords, strings, comments, types) over the whole source —
  tree-sitter is error-tolerant, so half-open streaming input still
  highlights.
- A napi `highlight` binding (`tern-node`) surfacing the span stream to JS;
  `highlightCode` in `@tern/core` feeds it into `MarkdownView` code fences
  (a fence with a recognized language renders one styled leaf per line with
  token colors; unknown languages or an unavailable addon fall back to the
  single fence style).
- Incremental re-parse on stream append remains future work — the current
  highlighter re-parses the whole fence per render, which is correct and
  cheap at terminal sizes.

**Exit criteria (met):** a streamed Rust code fence in `MarkdownView` is
highlighted with token colors; `highlightCode`/`MarkdownView` unit tests and
the `tern-highlight` golden tests match expected token styles.

## Phase 5 — ssh serving

**Goal:** serve a running tern app over ssh so a code agent session is
reachable from a remote terminal.

**Context:** a TUI app already owns a terminal frontend that emits minimal
escape-sequence diffs — that diff stream is exactly what a pty/ssh session
wants. The renderer is backend-agnostic today (tern-terminal owns the
frontend), so a remote backend can reuse the same buffer-diff machinery.

**Work items:**

- A `tern-server` binary that listens on a port, authenticates (key-based),
  and multiplexes a pty per session.
- Route the diff flush and the input channel over the ssh session instead of
  the local terminal.
- Session lifecycle: resize events from the remote pty feed back into layout.

**Exit criteria:** `ssh user@host -t tern` renders the demo with correct
resize behavior and working input.

## Phase 6 — web / wasm preview

**Goal:** run tern scenes in a browser for preview and embedding — compile
the core to wasm and render into a canvas/web-terminal.

**Context:** the core crates (`tern-core`, `tern-layout`, `tern-components`)
are platform-independent by design; only `tern-terminal` is OS-bound. A wasm
target swaps the terminal frontend for a JS-side cell renderer (e.g. a canvas
grid or `xterm.js`).

**Work items:**

- Add a wasm32 target + a `tern-wasm` binding (or a `wasm` feature on
  tern-node that drops the napi path and exports a plain ABI).
- A JS web renderer that consumes the buffer-diff stream and paints cells to
  canvas.
- Share the reconciler unchanged: same scene updates, different frontend.

**Exit criteria:** the demo example runs in a browser tab via the wasm build,
rendering the same scene the terminal shows; `cargo build --target
wasm32-unknown-unknown` is clean.

## Non-goals for the MVP

- Full widget library (see [components.md](components.md) — most components
  are post-MVP).
- Battery-level polish (IME composition edge cases).
- Non-terminal frontends beyond the wasm preview sketch above.

## How phases map to the component roadmap

| Phase | Unlocks component work |
|-------|------------------------|
| 1 — solid renderer (shipped) | All JS-side component elements for `@tern/solid` — shipped |
| 2 — resize, focus & mouse (shipped) | [Panels](components.md#panels--split-layouts) mouse drag-resize handles (shipped); focus-aware redraw / spinner tick pause on blur (shipped); flex-basis layout reflow (shipped — tern-layout maps the `flex_basis` prop into taffy's flex-basis) |
| 3 — push events (shipped) | Live agent state in [StatusBar](components.md#statusbar) (shipped — push-fed `onKey`/`onResize`/`onFocus`/`onMouse`, `startEventStream`) |
| 4 — tree-sitter (shipped) | [MarkdownView](components.md#markdownview) code-fence syntax highlighting (shipped — `tern-highlight` + napi `highlight` + `highlightCode`) |
| 5 — ssh serving | Remote code-agent sessions (agent runs in a server, user attaches) |
| 6 — wasm preview | Web-embedded agent UIs; shared reconciler across frontends |
