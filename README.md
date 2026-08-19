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
  (`@tern-tui/react`, `@tern-tui/solid`) over one scene API. Same props → same scene,
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
- **Terminal introspection** — `renderer.size` reports the last painted
  viewport (or the current terminal size before the first paint), and
  `renderer.setClipboard(text)` copies to the system clipboard via OSC 52.

## How it works

```
 JS renderer (@tern-tui/react | @tern-tui/solid)
      │  scene updates
      ▼
 @tern-tui/core (TypeScript bindings)
      │  napi (tern-node)
      ▼
 tern-core scene tree → tern-layout (taffy) → compositor → tern-terminal
      │  push events (keys / resize / focus / mouse / paste)
      └──────────────────────────────────────────────► JS renderer
```

## Using tern as a library

tern ships as four npm packages:

| Package | What it is |
|---------|------------|
| `tern-node` | The native addon (Rust core, napi binding). Main package plus 11 per-platform sub-packages via `optionalDependencies`. |
| `@tern-tui/core` | TypeScript bindings over the addon: renderer, scene nodes, element factories, focus, theme, frame snapshots. Depends on `tern-node`. |
| `@tern-tui/react` | react-reconciler custom renderer — host components, hooks, `ThemeProvider`. Peers: `react` `^19.2.0`, `react-reconciler` `^0.33.0`. |
| `@tern-tui/solid` | SolidJS universal custom renderer — element factories, subscriptions, `setTheme`. Depends on `solid-js`. |

### Installation

```sh
# React renderer
npm install @tern-tui/core @tern-tui/react react react-reconciler

# Solid renderer
npm install @tern-tui/core @tern-tui/solid solid-js
```

All packages are ESM-only (`"type": "module"`, `dist/index.js` +
`dist/index.d.ts`) and require Node.js `>= 20`.

> **Published on npm.** All packages ship at version `0.2.0` under the
> `@tern-tui` scope — install them with the [snippet above](#installation).
> Publishing is automated and re-runs when a `v*` tag is pushed (see
> [Release](#release)). To develop against the monorepo instead, build from
> source:

```sh
git clone https://github.com/EricMoin/tern
cd tern
npm install                    # repo root — installs and links the workspaces
cd src/bindings/tern-node
npm install                    # addon deps (use npm install, not npm ci — see below)
npm run build                  # napi build --platform --release && node fix-dts.mjs
cd ../..
npm run build -w @tern-tui/core    # tsc build + fix-dts (core first)
npm run build -w @tern-tui/react   # depends on @tern-tui/core
npm run build -w @tern-tui/solid   # depends on @tern-tui/core
```

The root workspace install links the JS packages and the native addon into
`node_modules`, so they are importable by name from anywhere in the checkout.
The bundled demos run Deno-first straight off the TypeScript sources (via the
`deno.json` import map); a Node consumer imports the built `dist`, hence the
build steps above.

### Quick start — @tern-tui/react

```tsx
// app.tsx — run with: deno run --allow-all app.tsx
// (requires the native addon built and the @tern-tui/* dist built — see Installation)
import { createElement } from "react";
import { createRenderer } from "@tern-tui/core";
import { Box, Text, render, useApp, useInput } from "@tern-tui/react";

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

// Push-based events: startEventStream() delivers every key / resize /
// focus / mouse / paste event to renderer.events. exit() (on 'q') and
// Ctrl+C (exitOnCtrlC) destroy the renderer, closing the stream.
renderer.startEventStream();
for await (const event of renderer.events) {
  if (renderer.destroyed) break;
}
```

The scene is a plain React tree of host components. Bare string children are
rejected — text lives in an explicit `<Text text="..." />` element.

### Quick start — @tern-tui/solid

```ts
// app.ts — run with: deno run --allow-all app.ts
// (requires the native addon built and the @tern-tui/* dist built — see Installation)
import { createRenderer } from "@tern-tui/core";
import { Box, Text, render, subscribeInput } from "@tern-tui/solid";

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

renderer.startEventStream();
for await (const event of renderer.events) {
  if (quit || renderer.destroyed) break;
}
dispose?.();
renderer.destroy();
```

### What runs where

- **Node.js `>= 20`** — ESM only; all packages are `"type": "module"` and
  export an `import` condition. TypeScript/JSX sources need your own
  transpilation step (the demos run Deno-first, straight from source).
- **Deno 2.x** — supported; Node-API addons load with `--allow-ffi`, and the
  demos run with `deno run --allow-all`. `deno.json` import-maps
  `@tern-tui/core` to the source for in-repo runs.
- **Terminal/PTY required** — constructing a renderer enters raw mode and
  the alternate screen immediately (crossterm). The scene renders only into
  a real terminal; non-interactive shells cannot paint it. For headless
  assertions, use `renderer.snapshotFrame(width, height)` and `framesEqual`
  instead.

### Supported platforms

The native addon follows the napi-rs distribution model: the `@tern-tui/node`
root package (binary name `tern-node`) declares per-platform packages in
`optionalDependencies`, and the generated loader picks the one matching the
running system. The release matrix builds eleven targets:

| Platform | Rust target triple | npm package | CI verification |
|----------|--------------------|-------------|-----------------|
| Linux x64 (glibc) | `x86_64-unknown-linux-gnu` | `@tern-tui/node-linux-x64-gnu` | native load-check |
| Linux arm64 (glibc) | `aarch64-unknown-linux-gnu` | `@tern-tui/node-linux-arm64-gnu` | build-only |
| Linux x64 (musl) | `x86_64-unknown-linux-musl` | `@tern-tui/node-linux-x64-musl` | build-only |
| Linux arm64 (musl) | `aarch64-unknown-linux-musl` | `@tern-tui/node-linux-arm64-musl` | build-only |
| FreeBSD x64 | `x86_64-unknown-freebsd` | `@tern-tui/node-freebsd-x64` | build-only |
| Linux riscv64 (glibc) | `riscv64gc-unknown-linux-gnu` | `@tern-tui/node-linux-riscv64-gnu` | build-only |
| Android arm64 | `aarch64-linux-android` | `@tern-tui/node-android-arm64` | build-only |
| macOS x64 (Intel) | `x86_64-apple-darwin` | `@tern-tui/node-darwin-x64` | build-only |
| macOS arm64 (Apple Silicon) | `aarch64-apple-darwin` | `@tern-tui/node-darwin-arm64` | native load-check |
| Windows x64 (MSVC) | `x86_64-pc-windows-msvc` | `@tern-tui/node-win32-x64-msvc` | native load-check |
| Windows arm64 (MSVC) | `aarch64-pc-windows-msvc` | `@tern-tui/node-win32-arm64-msvc` | build-only |

A native load-check runs only on rows where the runner arch matches the target
(linux-gnu x64, darwin arm64, win32-x64 msvc); every other row is build-only —
the binary is cross-compiled and uploaded, but not loaded in CI. When the
platform package is missing, the loader falls back to a locally built
`tern-node.<platform>-<arch>.node`. On a build-only row, verify the binding on
a matching runtime (e.g. a `node:alpine` container for musl, the
`windows-11-arm` hosted runner for Windows arm64, on-device for Android).

### Troubleshooting

- **`ERR_DLOPEN_FAILED` / "Cannot find native binding"** — the addon could
  not be loaded for this platform: the per-platform package is missing
  (unsupported target), `node_modules` is stale, or the addon was never
  built. Build it locally:

  ```sh
  cd src/bindings/tern-node && npm install && npm run build
  ```

  If `node_modules` is stale, follow the loader's own hint: remove
  `package-lock.json` and `node_modules`, then `npm install` (see
  https://github.com/npm/cli/issues/4828).

- **Raw-mode / PTY requirement** — `createRenderer()` enters raw mode and
  the alternate screen immediately; a scene never renders into piped output
  or a CI log. Run inside a real terminal. To render inline without the
  alternate screen, construct with `{ useAltScreen: false }`. For buffer
  assertions without a terminal, use `snapshotFrame` / `framesEqual`.

- **`npm ci` fails in `src/bindings/tern-node`** — the `tern-node-<platform>`
  optional dependencies are not on the registry yet, so the lockfile cannot
  pin them and `npm ci`'s sync check fails. Use `npm install` there
  (see [CONTRIBUTING.md](CONTRIBUTING.md)).

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
`@tern-tui/react` host components, `useFocus(id, node, onKey, onPaste?)` on the
core, `subscribe*` helpers on `@tern-tui/solid`. See
[docs/guide.md](docs/guide.md) for the full widget API reference.

## Events & interaction

Terminal events are **push-based**: `renderer.startEventStream()` delivers
every key / resize / focus / mouse / paste event to the JS thread (no polling
in the app hot path), as a tagged `TernEventJs` union on the `renderer.events`
async iterable and through the `onKey` / `onResize` / `onFocus` / `onMouse` /
`onPaste` handlers. Keys and pastes route through the `FocusManager` first —
a focused element consumes them, the tree-level handler sees the rest.

`renderer.size` reports the terminal size as `{ width, height }` — the
viewport the last render/snapshot painted at (the current terminal size
before any paint) — and `renderer.setClipboard(text)` copies to the system
clipboard via OSC 52 (`ESC ] 52 ; c ; <base64> BEL`; the terminal emulator
must support it).

## Examples

Run the bundled demos from the repo root (Deno-first):

```sh
deno run --allow-all packages/examples/react-demo.ts
deno run --allow-all packages/examples/solid-demo.ts
deno run --allow-all packages/examples/kitchen-sink-react.ts
deno run --allow-all packages/examples/kitchen-sink-solid.ts
```

Or through the `@tern-tui/examples` workspace scripts:

```sh
npm run demo:react -w @tern-tui/examples
npm run demo:solid -w @tern-tui/examples
npm run demo:kitchen-react -w @tern-tui/examples
npm run demo:kitchen-solid -w @tern-tui/examples
```

Each demo renders a scene, asserts it against the scene tree, and quits on
`q`.

## Packages

| Package | What it is |
|---------|------------|
| [`@tern-tui/core`](packages/core/README.md) | TypeScript bindings over the napi addon: renderer, scene nodes, element factories, focus, theme, frame snapshots |
| [`@tern-tui/react`](packages/react/README.md) | react-reconciler custom renderer — host components, hooks, `ThemeProvider` |
| [`@tern-tui/solid`](packages/solid/README.md) | SolidJS universal custom renderer — factories, subscriptions, `setTheme` |
| `@tern-tui/examples` | Runnable demos (`react-demo.ts`, `solid-demo.ts`, kitchen-sink scenes) with a PTY smoke harness (`run-smoke.sh`) |

## Documentation

- [docs/guide.md](docs/guide.md) — getting started, component API reference, event model, theme usage
- [docs/api/](docs/api/index.html) — generated API reference for `@tern-tui/core` / `@tern-tui/react` / `@tern-tui/solid` (build: `deno task docs:api`)
- [docs/architecture.md](docs/architecture.md) — render pipeline and repository conventions
- [docs/components.md](docs/components.md) — code-agent component roadmap and status
- [docs/roadmap.md](docs/roadmap.md) — post-MVP phases
- [docs/todo.md](docs/todo.md) — remaining work toward a complete TUI library, staged as a TODO checklist
- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — build / test / smoke gates and engineering rules

## Development

Prerequisites for building from source: stable Rust 1.94 (pinned in
`rust-toolchain.toml`), Deno 2.x (the primary runtime for check/test and
demos), and Node.js `>= 20` (for the napi build and the JS toolchain).

Build the native addon and the JS packages:

```sh
npm install                                  # repo root — JS deps (npm workspaces)
cd src/bindings/tern-node
npm install                                  # addon deps (npm install, not npm ci — see CONTRIBUTING.md)
npm run build                                # napi build --platform --release && node fix-dts.mjs
cd ../..
npm run build -w @tern-tui/core                   # tsc build + fix-dts (core first)
npm run build -w @tern-tui/react                  # depends on @tern-tui/core
npm run build -w @tern-tui/solid                  # depends on @tern-tui/core
```

`npm run build:debug` in `src/bindings/tern-node` is the fast local dev
build (debug profile); the default build is the release profile.

Check / test / smoke:

```sh
npm run check                                       # deno check across packages
npm test                                            # deno test across packages
cargo build --workspace && cargo test --workspace   # Rust gates — all green required
bash packages/examples/run-smoke.sh                 # PTY smoke: 4 demos, quit on 'q', exit 0
```

## Release

Publishing is fully automated — nothing is published on ordinary pushes or
by hand. Pushing a `v*` tag (e.g. `v0.1.0`) — or running
`.github/workflows/release.yml` manually — triggers the release:

1. **Build** — the napi-rs matrix compiles the `tern-node` addon for every
   target in `napi.targets` (natively where the runner arch matches, or
   cross-compiled: apt cross gcc for Linux arm64, zig for musl and FreeBSD,
   the NDK for Android, MSVC cross-linking for Windows arm64), load-checks
   the rows whose runner arch matches the target, and uploads each binary as
   a workflow artifact.
2. **Release** — collects the binaries into the per-platform packages
   (`napi create-npm-dirs` + `napi artifacts`), publishes `@tern-tui/node`
   (its `prepublishOnly` publishes the `@tern-tui/node-<platform>` packages
   first), then builds and publishes `@tern-tui/core` → `@tern-tui/react` →
   `@tern-tui/solid` in dependency order.

The workflow requires the `NPM_TOKEN` secret — an npm automation token with
publish rights on the `@tern-tui/*` and `tern-node*` names — and declares
`id-token: write` for npm provenance.

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
