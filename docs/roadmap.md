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

## Phase 1 — Complete the solid renderer

**Goal:** `@tern/solid` reaches feature parity with the MVP React renderer.

**Context:** the MVP ships a minimal `@tern/react` custom renderer
(`packages/react`); `packages/solid` is currently a scaffold stub. SolidJS's
fine-grained reactivity is a natural fit for a TUI: individual cells/regions
can re-render on signal change without whole-tree diffing.

**Work items:**

- Implement the Solid custom renderer (`render()` onto a tern scene root,
  `createRenderer` style host config mapping Solid elements to
  `Text`/`Box` scene nodes).
- Wire Solid signals to scene updates: a signal change should produce a
  *targeted* scene update that flows through tern-node into tern-core.
- Port the `examples/` demos so each runs on both renderers.

**Exit criteria:** the demo example renders identically under
`@tern/react` and `@tern/solid`; `deno test packages/solid` passes.

## Phase 2 — Push-based events via napi ThreadsafeFunction

**Goal:** replace the pull-based `poll_events` reverse channel with
push-based events delivered to the JS reconciler asynchronously.

**Context:** today input returns through `poll_events` (architecture.md, step
8/events). For a code agent, the host (LLM stream, tool callbacks) and the
terminal both generate events; a busy-loop poll is wrong — it burns a thread
and adds latency. napi-rs's **ThreadsafeFunction** lets the Rust side call
into the JS thread from any Rust thread, queuing events to the JS event loop
without polling.

**Work items:**

- Add a `napi::ThreadsafeFunction<TernEvent>` in `src/bindings/tern-node` that
  tern-terminal's event loop pushes into.
- Deliver events to `packages/core` as an `AsyncIterable` / emitter; the
  reconciler subscribes instead of polling.
- Keep a `poll_events` fallback for non-napi (wasm) hosts behind a feature.

**Exit criteria:** a Rust-side `tokio`/thread emitter pushes N events; the JS
side receives all N without loss and with bounded latency; no polling loop in
the hot path. Runs under `deno` first (goal above).

## Phase 3 — tree-sitter syntax highlighting

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

## Phase 4 — ssh serving

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

## Phase 5 — web / wasm preview

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
- Battery-level polish (mouse drag-resize, IME composition edge cases).
- Non-terminal frontends beyond the wasm preview sketch above.

## How phases map to the component roadmap

| Phase | Unlocks component work |
|-------|------------------------|
| 1 — solid renderer | All JS-side component elements for `@tern/solid` |
| 2 — push events | [Spinner](components.md#spinner) timer redraw, live agent state in [StatusBar](components.md#statusbar) |
| 3 — tree-sitter | [MarkdownView](components.md#markdownview) syntax highlighting |
| 4 — ssh serving | Remote code-agent sessions (agent runs in a server, user attaches) |
| 5 — wasm preview | Web-embedded agent UIs; shared reconciler across frontends |
