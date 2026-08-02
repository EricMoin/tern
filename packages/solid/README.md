# @tern/solid

A SolidJS custom renderer for tern, wired through a vendored
`solid-js/universal` renderer (solid-js 1.9.14). Element factories build
tern scene nodes directly; `render` mounts a scene onto a core renderer's
root, and subscription helpers wire events.

## Purpose

`@tern/solid` gives tern a SolidJS front end with feature parity to
`@tern/react`: the same element set produces the same scene node structures
(same props -> same scene). Solid has no React-style context, so the helpers
take the renderer (or node) as an explicit argument instead of reading it
from a tree context.

## API surface

**Renderer mounting**

- `render(code, node)` — the universal renderer's `render`; mounts `code()`
  under `node` (e.g. `render(() => box, renderer.root)`). Returns a disposer
  that releases the solid root.
- The destructured renderer primitives `insert` / `spread` / `setProp` /
  `effect` / `memo` / `createComponent` / `use` / `mergeProps` are also
  exported, plus `createElement` / `createTextNode` / `insertNode` (tree-op
  callbacks) and `rendererOptions` (the options object wired into
  `createRenderer`, for tests and embedders). `replaceNode(node, replacedNode)`
  performs position-accurate in-parent replacement.

**Element factories** (build the same scene structures as the `@tern/react`
host components; props are `@tern/core` `NodeProps` plus `role`/`component`
theme hints)

- `Box(props)` / `Text(props)` / `StreamingText(props)` — primitives.
- `Input(props)` / `Spinner(props)` / `StatusBar(props)` / `Panels(props)` /
  `DiffView(props)` / `Select(props)` / `ScrollView(props)` — roadmap
  elements (edit with `editKey` / `tick` / `selectKey`; manage panels with
  `collapsePanel` / `expandPanel` / `togglePanel` / `focusPanel`; drive
  scrolling with `scrollTo` / `scrollBy` / `scrollTop`).

**Subscriptions** (each returns a disposer)

- `subscribeInput(renderer, handler, { isActive, focusManager })` — the
  Solid-flavored `useInput`: routes each key through the core `FocusManager`
  first, then the tree handler.
- `subscribeStream(node, stream)` — feed an `AsyncIterable<Span>` to a
  `streaming_text` node (auto-scroll via `syncStreamTail`; the disposer
  cancels the pump).
- `subscribeResize(renderer, handler)` — terminal resize, re-invoking
  `renderer.render()` after each.
- `subscribeFocus(renderer, handler)` — terminal focus events
  (`{ focus_gained }`).
- `subscribePanelDrag(renderer, panels, handler?)` — mouse drag-resize for a
  `panels` node (drives `startPanelDrag` / `dragPanels` / `endPanelDrag`).
- `startSpinner(renderer, node, { interval })` — focus-aware tick driver for
  a spinner node (pauses while the terminal is unfocused).

**Theme** — `setTheme(overrides)` / `getTheme()` (module-level, merged over
the core `defaultTheme`) and the re-exported `defaultTheme` / `mergeTheme` /
`resolveTheme`.

**Re-exports** — the core surface: `Node`, `NodeProps`, `KeyEvent`,
`KeyHandler`, `Span`, `Renderer`, `FocusManager`, `focusManager`, `useFocus`,
`editKey`, `selectKey`, `tick`, `scrollTo` / `scrollBy` / `scrollTop`,
`followTail` / `syncStreamTail` / `isStreamFollowing`, `startPanelDrag` /
`dragPanels` / `endPanelDrag`, and the theme / element prop types.

## Example

```ts
import { createRenderer } from "@tern/core";
import { Box, Text, render, subscribeInput } from "@tern/solid";

const renderer = createRenderer({ exitOnCtrlC: true });

const box = Box({ border_style: "rounded", padding: 1 });
box.addChild(Text({ text: "Hello tern" }));

const dispose = render(() => box, renderer.root);
renderer.render();

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

## Runtime

Deno-first (`deno check` / `deno test` are canonical); the native addon
requires `--allow-ffi` under Deno. The universal renderer is vendored in
`./universal.ts` because bare `solid-js` resolves to its server build under
Deno/Node; the vendored copy's `solid-js` import maps through the package
import map (deno.json) to the client build, so signal-driven updates reach
the scene ops. See the [@tern/core README](../core/README.md) for building
the native addon and [docs/guide.md](../../docs/guide.md) for the component
and event-model guides.
