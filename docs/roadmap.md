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

## Phase 5 — ssh serving (exit criterion met via the pty plumbing; server product deferred)

**Status:** the ssh exit criterion is **met by existing machinery** — no
`tern-server` binary was built this round. The differentiator that would make
Phase 5 a product (embedded key auth + multiplexed persistent sessions) is
**deferred** as future work (a security-sensitive, tmux-scale subsystem).

**Goal:** serve a running tern app over ssh so a code agent session is
reachable from a remote terminal.

**Context:** a TUI app already owns a terminal frontend that emits minimal
escape-sequence diffs — that diff stream is exactly what a pty/ssh session
wants. The renderer is backend-agnostic today (tern-terminal owns the
frontend), so a remote backend can reuse the same buffer-diff machinery.

**Exit criterion — already satisfied by the write-generic flush seam.** The
renderer's diff flush is generic over the output sink: `flush_diff_to<W:
Write>` (`tern-terminal` `backend.rs:429`) plus `flush_diff_with_cursor_to` /
`flush_cursor_to` (`backend.rs:466` / `backend.rs:479`) queue the run-batched
cell diff, park/refresh the caret, and flush through **any** `std::io::Write`
target — a local stdout, a file, or a pty slave. When the app's stdout *is* a
pty (a local terminal, or the remote end of an `ssh host -t` session),
crossterm's event layer (`tern-terminal` `event.rs`) drives the app from that
same pty: `event::read()` (`event.rs:282`) surfaces keys, and the Unix event
source maps the pty's SIGWINCH to a `Resize` event
(`crossterm` `event/source/unix/tty.rs:72`) that flows into the push event
loop and invalidates the size cache (`tern-node` `lib.rs:1027`), so the next
render re-lays out at the new size.
So `ssh host -t tern`-style invocation renders with correct resize behavior
and working input today — the exit criterion needs no server binary. The PTY
smoke harness now regression-tests this property headlessly: it resizes the
`script` pty mid-session (a backgrounded `stty -f /dev/tty rows 31 cols 111`
raises SIGWINCH to the foreground process group before `q` is fed) and
asserts every demo still exits 0 (`packages/examples/run-smoke.sh`).

**Deferred — the Phase 5 differentiator.** What would turn "a tern app runs
inside an ssh pty" into "a tern *server*" is: a `tern-server` binary that
listens on a port, authenticates (embedded key-based auth), and multiplexes a
persistent pty per session, with remote resize feeding back into layout. That
is a security-sensitive, tmux-scale subsystem — a network auth surface and a
session multiplexer are exactly the kind of thing that should not be shipped
as a side effect of a rendering round. It stays on the roadmap as the Phase 5
work item, but the exit criterion that gates the phase is already green.

**Work items (remaining, deferred):**

- A `tern-server` binary that listens on a port, authenticates (key-based),
  and multiplexes a pty per session.
- Route the diff flush and the input channel over the ssh session instead of
  the local terminal.
- Session lifecycle: resize events from the remote pty feed back into layout.

## Phase 6 — web / wasm preview ✅ preview spike shipped; full parity deferred

**Status:** the Phase 6 **preview spike is shipped** — a `tern-wasm` cdylib
compiles the core to `wasm32-unknown-unknown` and a static demo page paints
the scene into a browser canvas. Full `@tern/core` reconciler parity on wasm
and `tern-highlight`-in-wasm are **deferred** (below).

**Goal:** run tern scenes in a browser for preview and embedding — compile
the core to wasm and render into a canvas/web-terminal.

**Context:** the core crates (`tern-core`, `tern-layout`, `tern-components`)
are platform-independent by design; only `tern-terminal` is OS-bound. A wasm
target swaps the terminal frontend for a JS-side cell renderer (e.g. a canvas
grid or `xterm.js`).

**Shipped (preview spike):**

- **`src/core/tern-wasm`** — a `crate-type = ["cdylib", "rlib"]` binding that
  compiles for `wasm32-unknown-unknown` and depends **only** on the pure-Rust,
  wasm-safe core crates (`tern-core` / `tern-layout` / `tern-components`; no
  `tern-terminal` / napi / crossterm). taffy 0.7.7 builds for the target with
  default features (its deps — arrayvec, grid, serde, slotmap — are all pure
  Rust; taffy is designed for wasm via its `std`/`alloc` feature flags).
- **A plain C ABI** (`extern "C"` exports): scene construction
  (`tern_create_node` / `tern_add_child` / `tern_remove` / `tern_set_prop` /
  `tern_append_span`) driven through the **same JSON-prop protocol** as the
  napi binding (style keys `fg`/`bg`/`border_style`/`bold`/`dim`/`italic`/
  `underline`/`reversed`/… lifted into the cell style, every other scalar key
  into the layout/content prop map), plus `tern_render_to_cells(width,
  height)` returning a **flat per-cell payload** — cluster symbol (in a side
  blob) or lead `ch`, `fg`/`bg` colors (tag-encoded: default / indexed / RGB),
  and the bold / italic / underline / dim / reversed (plus blink, hidden,
  strikethrough, masked) flags — the structured cell stream a canvas renderer
  needs (`snapshotFrame` row strings carry no style). A bump scratch allocator
  (`tern_alloc` / `tern_reset_alloc`) and `tern_last_error` round out the ABI.
- **Demo page** (`examples/web/`): a static page with a canvas painter +
  a small JS shim driving the scene through the JSON-prop protocol, rendering
  the same scene the terminal shows (rounded border box, bold title, styled
  streaming spans, bg-colored boxes, wide CJK + ZWJ emoji via the masked-cell
  path). `./build.sh` produces the committed `tern_wasm.wasm`;
  `cd examples/web && python3 -m http.server 8000` serves it (see
  `examples/web/README.md`).
- **Host verification:** `cargo test -p tern-wasm` passes an ABI round-trip
  suite (scene → cells → expected rows, including wide-char masks and blob
  symbols); `cargo build --target wasm32-unknown-unknown -p tern-wasm` is
  clean.

**Exit criterion — met:** `cargo build --target wasm32-unknown-unknown
-p tern-wasm` is clean, and the demo example renders the same scene the
terminal shows (verified in Node against the committed artifact, and
headlessly by the ABI round-trip tests).

**Deferred (the Phase 6 differentiators):**

- **Full `@tern/core` reconciler parity on wasm** — the React/Solid
  reconcilers, the push event stream (`startEventStream`), input/focus/mouse
  routing, and `content_size`/selection surfaces are not ported to the wasm
  frontend. The spike exposes the scene API directly; a real embedding would
  run the shared reconciler unchanged against the wasm scene, which needs the
  napi-less event/input plumbing this round did not build.
- **`tern-highlight`-in-wasm** — the tree-sitter grammar crates are not part
  of the wasm build yet; `highlightCode` stays a napi-side feature.

**Work items (remaining, deferred):**

- Share the reconciler unchanged against the wasm scene (same scene updates,
  different frontend), with wasm-side input/event plumbing.
- `tern-highlight` compiled into the wasm module (tree-sitter is pure Rust,
  so this is an additive dependency question, not a blocker).
- A web-terminal frontend (e.g. `xterm.js`) as an alternative to the canvas
  painter.

## Phase 7 — production completeness ✅ done

**Status:** shipped.

**Goal:** close the production-completeness gaps the roadmap elements exposed:
terminal capability detection, deterministic buffer-level testing, tabbed
layouts, keyboard focus traversal, determinate progress, and minimal
escape-sequence output.

**Context:** the roadmap elements landed as JS compositions over the primitive
scene kinds; this phase hardens the machinery around them. The backend detects
the terminal's color support once and quantizes RGB cells to ANSI 256 when
truecolor is unavailable; the renderer flushes the diff as minimal
escape-sequence runs; buffer-level frame snapshots make golden testing
possible without a real terminal; and the widget work fills the two remaining
roadmap items — Tabs and Progress — plus the Tab / Shift+Tab focus traversal
that makes keyboard-driven UIs usable.

**Shipped:**

- **Terminal capabilities, window title, alt-screen:** the tern-terminal
  backend detects color support once (`supports-color`) and exposes it as
  `Renderer.capabilities` (`{ truecolor, colors }` — 16_777_216 / 256 / 16 /
  0, defaulting to truecolor when detection is inconclusive); RGB cells
  quantize to the nearest ANSI 256-color index (`rgb_to_ansi256`: the 6×6×6
  color cube + grayscale ramp, minimizing squared RGB distance) when truecolor
  is unsupported instead of emitting a sequence the terminal cannot render;
  `Renderer.setTitle` sets the terminal window title (OSC 0);
  `createRenderer({ useAltScreen?, title? })` opts into inline rendering
  (`useAltScreen: false` skips the alt-screen enter/leave escapes, including
  teardown) and an initial title.
- **Frame snapshot testing:** `Renderer.snapshotFrame(width?, height?)` paints
  the shared scene into a fresh buffer via the native `render_to_buffer` (no
  terminal I/O) and returns one string per row — masked/continuation cells are
  spaces, so every row is exactly `width` display columns (multi-width aware);
  `framesEqual(a, b)` compares two frames (same row count + string equality)
  for golden assertions.
- **[Tabs](components.md#tabs) widget:** a `tabs` element (in `@tern/core`)
  composing a tab bar row — one `Text` leaf per tab, the active tab painted
  with the theme `primary` palette colors and reversed, its label prefixed
  with a top-border marker (`▔`), closable tabs carrying the close glyph
  (`×`) — plus a content region box holding the active tab's content nodes;
  driven by `activateTab` / `closeTab` / `tabsKey` (`left` / `right` move the
  active tab, `ctrl+tab` / `ctrl+shift+tab` wrap, `ctrl+w` closes). No new
  napi node kind (materializes as a `box`).
- **Focus traversal:** Tab / Shift+Tab wire to the `FocusManager`'s `next()` /
  `prev()` — `useFocusTraversal({ manager?, exclude? })` in `@tern/react`,
  `subscribeFocusTraversal(renderer, manager?, exclude?)` in `@tern/solid` —
  skipping excluded ids, re-rendering after each move, and handling the
  traversal keys ahead of focused-element routing (bare Tab / Shift+Tab always
  move focus, standard TUI behavior).
- **[Progress](components.md#progress) widget:** a `progress` element (ratatui
  Gauge parity) — a framed single-row gauge (default `border_style: "plain"`)
  with an in-flow fill leaf (`▓` × ceil(value/max × inner width), `░` for the
  rest), an optional dimmed label leaf left-aligned inside the bar area
  (composed only when it fits alongside the readout) and an optional
  percentage readout (`ceil(value/max×100)%`) right-aligned, both absolute
  overlays; `ratio` (0..1) drives the bar directly as an alternative to
  `value`/`max`; `setProgress(node, value, max?)` repaints a live bar in place
  (no rebuild).
- **Escape-sequence run batching:** the backend's cell queueing merges
  consecutive updates that share a style, a row, and adjacent columns into
  single runs — one `MoveTo` to the run's first cell, one unconditional SGR
  reset plus the run's exact style applied once, and the run's characters in
  one `Print` — so a typical frame flushes a handful of runs instead of one
  sequence per cell. This is an internal property of the frontend, not a
  user-facing JS API.

**Exit criteria (met):** `Renderer.capabilities` reports the detected palette
size and RGB cells render correctly on 256-color terminals; `snapshotFrame` /
`framesEqual` back golden tests in the `@tern/core` suites; `Tabs` and
`Progress` render and respond to their drivers (`activateTab` / `closeTab` /
`tabsKey`, `setProgress`) as asserted in the package test suites; Tab /
Shift+Tab traversal moves focus across registered elements and skips excluded
ids; the PTY smoke harness still exits 0 (minimal diff runs keep terminal
output correct).

## IME posture — composition stays a non-goal

**Decision:** IME composition/preedit is excluded as a non-goal for the
foreseeable roadmap. tern does not surface preedit events to the JS layer and
does not render composing text itself. Confirmed IME input is served by the
shipped bracketed-paste path (below) and regression-tested.

**Why composition stays excluded:**

- **crossterm 0.29 surfaces no composition/preedit events.** The terminal
  event layer (`tern-terminal` on crossterm 0.29) has no preedit or
  composition event to forward: crossterm's `Event` enum carries only
  `FocusGained` / `FocusLost` / `Key` / `Mouse` / `Paste` / `Resize`
  (`event.rs:550-560`), and its kitty-keyboard-protocol support is
  key-event-only (alternate keycodes), not an IME composition stream
  (`event.rs:287-301`). There is nothing in the event model to route or
  render, so a composition layer would have to be invented on top of raw
  key events — out of scope for a cell-buffer TUI.
- **Preedit rendering is owned by the terminal emulator.** The composing
  underline, the candidate window, and the preedit text itself are drawn by
  the terminal/OS IME overlay, not by the app's cell buffer. A TUI paints
  cells; it cannot paint the emulator's own overlay, and fighting it (e.g.
  echoing keys mid-composition) causes double-rendering.
- **Confirmed input already flows through the paste path.** When a
  composition is confirmed, the terminal delivers the composed text to the
  app as a bracket-pasted string — exactly what the shipped path consumes:
  `EnableBracketedPaste` (`tern-terminal` `backend.rs:303`),
  `TernEvent::Paste`, `FocusManager.routePaste`, and `pasteInto` /
  `pasteIntoTextarea`. Multi-codepoint CJK/IME-confirmed strings
  (pre-composed and decomposed forms) round-trip losslessly through
  `routePaste` into a focused `Input` and `Textarea` — pinned by the
  `packages/core` "IME-confirmed paste round-trips" suites.

**Revisit condition:** a frontend that owns preedit rendering — e.g. the
Phase 6 wasm/web renderer on `xterm.js`, which draws its own composition
overlay — is the natural place to reconsider a composition event surface.
Until then, composition stays the terminal's job.

## Non-goals for the MVP

- Full widget library (see [components.md](components.md) — most components
  are post-MVP).
- IME composition/preedit (see [IME posture](#ime-posture--composition-stays-a-non-goal)
  above — a deliberate exclusion, not an oversight).
- Non-terminal frontends beyond the wasm preview sketch above.

## How phases map to the component roadmap

| Phase | Unlocks component work |
|-------|------------------------|
| 1 — solid renderer (shipped) | All JS-side component elements for `@tern/solid` — shipped |
| 2 — resize, focus & mouse (shipped) | [Panels](components.md#panels--split-layouts) mouse drag-resize handles (shipped); focus-aware redraw / spinner tick pause on blur (shipped); flex-basis layout reflow (shipped — tern-layout maps the `flex_basis` prop into taffy's flex-basis) |
| 3 — push events (shipped) | Live agent state in [StatusBar](components.md#statusbar) (shipped — push-fed `onKey`/`onResize`/`onFocus`/`onMouse`, `startEventStream`) |
| 4 — tree-sitter (shipped) | [MarkdownView](components.md#markdownview) code-fence syntax highlighting (shipped — `tern-highlight` + napi `highlight` + `highlightCode`) |
| 5 — ssh serving (exit criterion met; server product deferred) | Remote code-agent sessions (agent runs in a server, user attaches) — deferred with the `tern-server` differentiator (embedded key auth + multiplexed persistent sessions); the `ssh host -t tern` exit criterion is met by the write-generic flush seam + crossterm pty handling |
| 6 — wasm preview (preview spike shipped; full parity deferred) | Web-embedded agent UIs; shared reconciler across frontends — deferred with the reconciler-parity / highlight-in-wasm work items |
| 7 — production completeness (shipped) | [Tabs](components.md#tabs) / [Progress](components.md#progress) widgets and Tab / Shift+Tab focus traversal — shipped |
