# tern

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust 1.94](https://img.shields.io/badge/rust-1.94-orange)](rust-toolchain.toml)
[![CI](https://github.com/EricMoin/tern/actions/workflows/ci.yml/badge.svg)](https://github.com/EricMoin/tern/actions/workflows/ci.yml)

**Build rich terminal UIs for code agents with React or SolidJS, rendered by a
Rust-native engine.**

tern is a terminal UI engine for AI coding agents: streaming transcripts,
diffs, prompts, tables, progress, and multi-panel workspaces. You write
declarative UI in React or SolidJS; a custom renderer drives a Rust scene tree,
layout engine, compositor, and terminal frontend. The engine core is always
Rust; the JS side only describes the scene.

## Features

- **Rust-native engine** — scene tree, layout (taffy), compositor, and
  diff-flush terminal frontend all in Rust; the JS side stays thin.
- **React & SolidJS renderers** — first-class custom renderers
  (`@tern/react`, `@tern/solid`) over one scene API. Same props → same scene,
  full feature parity.
- **Streaming-first** — `StreamingText` consumes an `AsyncIterable<Span>`
  with tail-follow auto-scroll, scroll-up detach, and a `▼` scroll-to-bottom
  affordance.
- **Paste end to end** — bracketed paste surfaced as events, routed through
  the `FocusManager`, and auto-pasted into the focused `Input` / `Textarea`.
- **Focus & interaction model** — Tab/Shift+Tab traversal, click-to-focus,
  wheel scroll, panel drag-resize, and modal focus isolation.
- **Code-agent widget set** — 16 elements: `StreamingText`, `MarkdownView`,
  `DiffView`, `Input`, `Textarea`, `Select`, `Table`, `Tabs`, `Panels`,
  `Progress`, `Spinner`, `StatusBar`, `ScrollView`, `Modal`, `Box`, `Text`.
- **Diffs & tables** — unified or side-by-side diffs with intra-line
  highlighting; sticky-header tables with windowed rows (a 10k-row table
  materializes only the visible window).
- **Syntax highlighting** — tree-sitter (Rust, TS/JS, JSON, shell) inside
  Markdown code fences.
- **Theme system** — One Dark default; `role` / `component` hints resolve to
  `fg` / `bg` / `border_style` at element-creation time.
- **Golden testing** — `snapshotFrame` / `framesEqual` paint to an off-screen
  buffer with no terminal I/O, for buffer-exact assertions.

## How it works

```
 JS renderer (@tern/react | @tern/solid)
      │  scene updates
      ▼
 @tern/core (TypeScript bindings)
      │  napi (tern-node)
      ▼
 tern-core scene tree → tern-layout (taffy) → compositor → tern-terminal
      │  push events (keys / resize / focus / mouse / paste)
      └──────────────────────────────────────────────► JS renderer
```

## Installation

The `@tern/*` packages aren't on npm yet (publishing runs through
`.github/workflows/publish.yml`). Until then, build from source:

```sh
npm install                                    # repo root — JS deps
npm run build --prefix src/bindings/tern-node  # napi build --platform && node fix-dts.mjs
```

Prerequisites: stable Rust 1.94 (pinned in `rust-toolchain.toml`), Deno 2.x
(primary runtime for check/test), and Node.js ≥ 20 (for the napi build).

## Quick start — @tern/react

```tsx
// app.tsx — run with: deno run --allow-all app.tsx
// (requires the native addon built, see "Installation" above)
import { createElement } from "react";
import { createRenderer } from "@tern/core";
import { Box, Text, render, useApp, useInput } from "@tern/react";

function App() {
  const { exit } = useApp();
  useInput((event) => {
    if (event.name === "char" && event.char === "q") exit();
  });
  return createElement(
    Box,
    { border_style: "rounded", padding: 1, flex_direction: "column" },
    createElement(Text, { text: "Hello tern" }),
    createElement(Text, { text: "Press q to quit" }),
  );
}

const renderer = createRenderer({ exitOnCtrlC: true });
render(createElement(App), renderer);

// React schedules passive effects (useInput's key subscription) on the
// scheduler, so give them a beat before the event loop starts.
await new Promise((resolve) => setTimeout(resolve, 100));

// Pull-based event loop: poll_events feeds the on* handlers. 'q' destroys
// the renderer via exit(); Ctrl+C (exitOnCtrlC) does too.
while (!renderer.destroyed) {
  renderer.pollEvents(50);
}
```

The scene is a plain React tree of host components. Bare string children are
rejected — text lives in an explicit `<Text text="..." />` element.

## Quick start — @tern/solid

```ts
// app.ts — run with: deno run --allow-all app.ts
// (requires the native addon built, see "Installation" above)
import { createRenderer } from "@tern/core";
import { Box, Text, render, subscribeInput } from "@tern/solid";

const renderer = createRenderer({ exitOnCtrlC: true });

const box = Box({ border_style: "rounded", padding: 1, flex_direction: "column" });
box.addChild(Text({ text: "Hello tern" }));
box.addChild(Text({ text: "Press q to quit" }));

// Mount the scene through the solid universal renderer; the returned
// disposer releases the solid root.
const dispose = render(() => box, renderer.root);
renderer.render();

// The Solid-flavored input hook: routes each key through the FocusManager
// first, then the tree handler. Solid has no context, so the renderer is an
// explicit argument.
let quit = false;
subscribeInput(renderer, (event) => {
  if (event.name === "char" && event.char === "q") quit = true;
});

while (!quit && !renderer.destroyed) {
  renderer.pollEvents(50);
}
dispose?.();
renderer.destroy();
```

## Widgets

| Element | What it does |
|---------|--------------|
| `Box` / `Text` | Container (border, padding, flex) / text leaf |
| `StreamingText` | Incrementally fed styled-span stream, tail-follow auto-scroll |
| `MarkdownView` | Markdown blocks + inline styles, tree-sitter-highlighted code fences |
| `DiffView` | Unified or side-by-side diff rows, intra-line highlight |
| `Input` | Single-line entry with caret, placeholder, focus, auto-paste |
| `Textarea` | Multi-line editor with soft wrap, scroll-to-caret, line splits |
| `Select` | Filterable option list, multi-select, floating overlay |
| `Table` | Sticky header, windowed rows, per-column alignment |
| `Tabs` | Tab bar + content region, `ctrl+tab` / `ctrl+w` routing |
| `Panels` | Collapsible header/body stack with drag-resize gutter |
| `Progress` | Framed gauge with label + percentage readout (`setProgress`) |
| `Spinner` | Determinate bar or indeterminate glyph, focus-aware ticking |
| `StatusBar` | Left/center/right strip; reserves the bottom viewport row |
| `ScrollView` | Clip/scroll region with optional scrollbar |
| `Modal` | Dimmed overlay with centered content and focus isolation |

Interactive elements register with a `FocusManager`: `focusId` on the
`@tern/react` host components, `useFocus(id, node, onKey, onPaste?)` on the
core, `subscribe*` helpers on `@tern/solid`. See
[docs/guide.md](docs/guide.md) for the full widget API reference.

## Events & interaction

Terminal events are **push-based**: `renderer.startEventStream()` delivers
every key / resize / focus / mouse / paste event to the JS thread (no polling
in the app hot path), as a tagged `TernEventJs` union on the `renderer.events`
async iterable and through the `onKey` / `onResize` / `onFocus` / `onMouse` /
`onPaste` handlers. Keys and pastes route through the `FocusManager` first —
a focused element consumes them, the tree-level handler sees the rest.

## Examples

Run the bundled demos from the repo root (Deno-first):

```sh
deno run --allow-all packages/examples/react-demo.ts
deno run --allow-all packages/examples/solid-demo.ts
deno run --allow-all packages/examples/kitchen-sink-react.ts
deno run --allow-all packages/examples/kitchen-sink-solid.ts
```

## Packages

| Package | What it is |
|---------|------------|
| [`@tern/core`](packages/core/README.md) | TypeScript bindings over the napi addon: renderer, scene nodes, element factories, focus, theme, frame snapshots |
| [`@tern/react`](packages/react/README.md) | react-reconciler custom renderer — host components, hooks, `ThemeProvider` |
| [`@tern/solid`](packages/solid/README.md) | SolidJS universal custom renderer — factories, subscriptions, `setTheme` |
| [`@tern/examples`](packages/examples/README.md) | Runnable demos with a PTY smoke harness |

## Documentation

- [docs/guide.md](docs/guide.md) — getting started, component API reference, event model, theme usage
- [docs/architecture.md](docs/architecture.md) — render pipeline and repository conventions
- [docs/components.md](docs/components.md) — code-agent component roadmap and status
- [docs/roadmap.md](docs/roadmap.md) — post-MVP phases
- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — build / test / smoke gates and engineering rules

## Development

```sh
cargo build --workspace && cargo test --workspace   # Rust: all green required
npm run check                                       # deno check across packages
npm test                                            # deno test across packages
bash packages/examples/run-smoke.sh                 # PTY smoke: 4 demos, quit on 'q', exit 0
```

```
tern/
├── src/                    # Rust workspace
│   ├── core/               #   tern-core (scene tree) · tern-layout · tern-terminal · tern-components · tern-highlight
│   └── bindings/tern-node/ #   napi binding (Node.js/Deno → Rust)
├── packages/               # JS packages (core | react | solid | examples)
├── examples/rust/tern-demo # Rust example binary
├── docs/                   # architecture & design documents
└── tools/                  # developer tooling
```

## Built with

The Rust core leans on [crossterm](https://github.com/crossterm-rs/crossterm)
(terminal I/O and events), [taffy](https://github.com/DioxusLabs/taffy) (layout),
and [tree-sitter](https://tree-sitter.github.io/); the JS renderers are built
on [react-reconciler](https://react.dev) and the SolidJS
[universal renderer](https://www.solidjs.com); the bridge is
[napi-rs](https://napi.rs).

## License

MIT — see [LICENSE](LICENSE).
