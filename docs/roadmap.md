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

## Phase 2 — Resize, focus & mouse events

**Goal:** surface the terminal's resize, focus, and mouse events through the
JS API and use them for real UI behavior — layout reflow on resize, mouse
drag-resize for panels, and focus-aware redraw.

**Context:** the event model now surfaces resize/focus/mouse via tern-node
`poll_events`: the `@tern/core` `Renderer` exposes `onResize` / `onFocus` /
`onMouse` handlers that `pollEvents()` feeds from the tagged `TernEventJs`
union (`"key"` / `"resize"` / `"focus"` / `"mouse"`). `onResize` receives
`{ width, height }`, `onFocus` receives `{ focus_gained }`, `onMouse`
receives `MouseEventJs`. What remains is *consuming* them: nothing re-flows
layout on resize yet, panels have no mouse-resizable gutters, and timers keep
ticking while the terminal is unfocused.

**Work items:**

- Resize → layout reflow: subscribe a scene re-layout to `onResize` so a
  `{ width, height }` change re-flows the scene through tern-layout.
- Mouse drag-resize handles for [Panels](components.md#panels--split-layouts):
  map `onMouse` drags on the 1-cell gutters between panels to flex-basis
  changes on the adjacent panes (min sizes respected).
- Focus-aware redraw: pause spinner/timer redraw while the terminal is
  unfocused (via `onFocus` `{ focus_gained: false }`) and resume on regain.

**Exit criteria:** resizing the terminal re-flows the scene and the buffer
diff reflects the new size; dragging a panels gutter with the mouse changes
the pane split and a golden buffer matches; a spinning spinner's frames stop
while the terminal is unfocused and resume on focus regain.

## Phase 3 — Push-based events via napi ThreadsafeFunction

**Goal:** replace the pull-based `poll_events` reverse channel with
push-based events delivered to the JS reconciler asynchronously.

**Context:** today key/resize/focus/mouse all return through tern-node
`poll_events`, dispatched to the `onKey` / `onResize` / `onFocus` / `onMouse`
handlers in `@tern/core` (packages/core). For a code agent, the host (LLM
stream, tool callbacks) and the terminal both generate events; a busy-loop
poll is wrong — it burns a thread and adds latency. napi-rs's
**ThreadsafeFunction** lets the Rust side call into the JS thread from any
Rust thread, queuing events to the JS event loop without polling.

**Work items:**

- Add a `napi::ThreadsafeFunction<TernEvent>` in `src/bindings/tern-node` that
  tern-terminal's event loop pushes into.
- Deliver events to `packages/core` as an `AsyncIterable` / emitter; the
  reconciler subscribes instead of polling.
- Keep a `poll_events` fallback for non-napi (wasm) hosts behind a feature.

**Exit criteria:** a Rust-side `tokio`/thread emitter pushes N events; the JS
side receives all N without loss and with bounded latency; no polling loop in
the hot path. Runs under `deno` first (goal above).

## Phase 4 — tree-sitter syntax highlighting

**Goal:** token-level syntax highlighting for code — inside
[MarkdownView](components.md#markdownview) code fences and in a future
dedicated code view.

**Context:** naive regex highlighting breaks on real code. tree-sitter gives
incremental, error-tolerant parsing — ideal for streaming agent output where
code arrives half-written.

**Work items:**

- Vendor a tree-sitter runtime + a small set of grammars (Rust, TS/JS, JSON,
  shell) into the Rust core (or an optional `tern-highlight` crate).
- Map tree-sitter node captures to style spans (keywords, strings,
  comments, types) and feed them to `MarkdownView` / `StreamingText` spans.
- Incremental re-parse on stream append: highlight only the changed region.

**Exit criteria:** a streamed Rust code fence is highlighted progressively;
golden buffer test matches expected token colors.

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
| 2 — resize, focus & mouse | [Panels](components.md#panels--split-layouts) mouse drag-resize handles; focus-aware redraw (spinner tick pause on blur) |
| 3 — push events | Live agent state in [StatusBar](components.md#statusbar) |
| 4 — tree-sitter | [MarkdownView](components.md#markdownview) syntax highlighting |
| 5 — ssh serving | Remote code-agent sessions (agent runs in a server, user attaches) |
| 6 — wasm preview | Web-embedded agent UIs; shared reconciler across frontends |
