# tern

tern is a Fuchsia-style monorepo for a terminal UI (TUI) renderer: a
JavaScript-facing reconciler that drives a Rust scene tree, layout engine,
compositor, and terminal frontend. The engine core is always Rust; the
`@tern/react` and `@tern/solid` packages are first-class custom renderers over
the same scene API, built for code-agent UIs (streaming text, diffs, input,
panels, status, selection).

```
 JS renderer (@tern/react | @tern/solid)
      │  scene updates
      ▼
 @tern/core (TypeScript bindings)
      │  napi (tern-node)
      ▼
 tern-core scene tree → tern-layout (taffy) → compositor → tern-terminal
      │  poll_events (keys / resize / focus / mouse)
      └──────────────────────────────────────────────► JS renderer
```

## Packages

| Package | What it is |
|---------|------------|
| [`@tern/core`](packages/core/README.md) | TypeScript bindings over the tern-node napi addon: renderer, scene nodes, element factories, focus, theme |
| [`@tern/react`](packages/react/README.md) | react-reconciler custom renderer — host components, `render`/`createRoot`, `useApp`/`useInput`/`useFocus`/`useResize`/`useWheelScroll`/`useClickToFocus` |
| [`@tern/solid`](packages/solid/README.md) | SolidJS universal custom renderer — element factories, `render`, `subscribeInput`/`subscribeStream`/`subscribeResize`/`subscribeWheelScroll`/`subscribeClickFocus` |
| [`@tern/examples`](packages/examples/README.md) | Runnable demos (React/Solid + kitchen sinks) with a PTY smoke harness |

## Quick start — @tern/react

```tsx
// app.tsx — run with: deno run --allow-all app.tsx
// (requires the native addon built, see "Building the native addon" below)
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

The scene is a plain React tree of host components — `<Box>`, `<Text>`,
`<StreamingText>`, and the roadmap elements `<Input>`, `<Spinner>`,
`<StatusBar>`, `<Panels>`, `<DiffView>`, `<Select>`, `<ScrollView>`,
`<Table>`, `<Textarea>`, `<Modal>`. Every commit paints the terminal through
`renderer.render()`. Bare string children are rejected — text lives in an
explicit `<Text text="..." />` element.

## Quick start — @tern/solid

```ts
// app.ts — run with: deno run --allow-all app.ts
// (requires the native addon built, see "Building the native addon" below)
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

The `@tern/solid` factories (`Box`, `Text`, `StreamingText`, `Input`,
`Spinner`, `StatusBar`, `Panels`, `DiffView`, `Select`, `ScrollView`,
`Table`, `Textarea`, `Modal`) build the same scene node structures as the
`@tern/react` host components — same props, same scene. `subscribeStream`
feeds a `streaming_text` node from an `AsyncIterable<Span>`;
`startSpinner` drives a spinner's frame ticks.

## Building the native addon

The JS packages load the `tern-node` napi addon (the Rust side). Build it
once after a fresh checkout:

```sh
npm install                  # repo root — installs JS deps (react, solid, napi cli)
npm run build --prefix src/bindings/tern-node   # napi build --platform && node fix-dts.mjs
```

Run the bundled demos from the repo root (Deno-first):

```sh
deno run --allow-all packages/examples/react-demo.ts
deno run --allow-all packages/examples/solid-demo.ts
deno run --allow-all packages/examples/kitchen-sink-react.ts
deno run --allow-all packages/examples/kitchen-sink-solid.ts
```

## Checks

```sh
cargo build --workspace && cargo test --workspace   # Rust: all green required
npm run check                                       # deno check across packages
npm test                                            # deno test across packages
bash packages/examples/run-smoke.sh                 # PTY smoke: 4 demos, quit on 'q', exit 0
```

## Workspace layout

```
tern/
├── Cargo.toml               # Rust workspace root
├── rust-toolchain.toml      # pinned stable Rust 1.94
├── src/
│   ├── core/                # Rust core crates
│   │   ├── tern-core/       #   scene tree
│   │   ├── tern-layout/     #   layout engine
│   │   ├── tern-terminal/   #   terminal frontend (diff flush)
│   │   └── tern-components/ #   reusable widget components
│   └── bindings/
│       └── tern-node/       #   napi binding (Node.js -> Rust)
├── examples/
│   └── rust/
│       └── tern-demo/       # example binary
├── docs/                    # architecture & design documents
├── packages/                # JS packages (core | react | solid | examples)
├── tools/                   # developer tooling
├── tests/                   # integration / cross-language tests
└── third_party/             # vendored dependencies
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — render pipeline and directory conventions
- [docs/guide.md](docs/guide.md) — getting started, component overview, event model, theme usage
- [docs/components.md](docs/components.md) — code-agent component roadmap and status
- [docs/roadmap.md](docs/roadmap.md) — post-MVP phases
- [CONTRIBUTING.md](CONTRIBUTING.md) — build / test / smoke gates and engineering rules
