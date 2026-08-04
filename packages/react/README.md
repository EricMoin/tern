# @tern/react

A mutation-mode react-reconciler custom renderer for tern. Renders React
trees into the tern scene: host components map to `@tern/core` node
factories, and every commit paints the terminal through the renderer.

## Purpose

`@tern/react` is the React way to build a tern TUI. A component tree of host
elements (`<Box>`, `<Text>`, `<StreamingText>`, ...) is mounted onto a core
renderer's scene root; hooks provide the app handle, input, focus, resize,
and theming. Bare string children are rejected at render time — text lives in
an explicit `<Text text="..." />` element.

## API surface

**Mounting**

- `render(element, renderer)` — create a root over `renderer` and render
  `element` immediately; returns a `TernRoot` (`render` / `unmount`).
- `createRoot(renderer)` — create a root without rendering; call
  `root.render(element)` later.

**Host components** (props are `@tern/core` `NodeProps` plus optional
`role` / `component` theme hints)

- `<Box>` — container (border, background, padding, flex layout).
- `<Text text="..." />` — leaf node; string children are not allowed.
- `<StreamingText stream={AsyncIterable<Span>} autoScroll wrap />` — appends
  each span to the node and paints after every append; auto-scroll keeps
  `scroll_y` pinned to the stream tail.
- `<Input value caret placeholder focusId onChange onSubmit />` — with a
  `focusId`, registers with a `FocusManager` so routed keys edit it; a
  focused input auto-pastes routed pastes via `pasteInto` (firing
  `onChange`).
- `<Textarea lines row col width height scroll focusId onChange onSubmit />` —
  multi-line editor; with a `focusId`, routed keys edit it via
  `editTextareaKey` and routed pastes auto-paste via `pasteIntoTextarea`
  (firing `onChange`).
- `<Spinner value max width frames frame interval />` — determinate bar or
  indeterminate glyph; a tick interval (default 100ms) runs while mounted,
  skipping while the terminal is unfocused.
- `<StatusBar left center right />` — single-row segment strip.
- `<Panels panels={PanelSpec[]} active direction />` — collapsible header/body
  stack (bodies are core `Node`s from element refs).
- `<DiffView hunks={DiffLine[]} mode inline_highlight scroll_x scroll_y
  wrap />` — unified or side-by-side diff rows (`mode="side"` two columns,
  `inline_highlight` intra-line char-level).
- `<Select options multi value highlighted filter open floating z_index
  focusId onChange onConfirm onDismiss />` — filterable option list.
- `<ScrollView clip_x clip_y clip_width clip_height scroll_x scroll_y
  showScrollbar>` — clip/scroll region; content is the children.

**Hooks**

- `useApp()` — `{ renderer, root, exit(error?), unmount() }`; `exit()` unmounts
  the tree and tears the terminal down (idempotent).
- `useInput(handler, { isActive, focusManager })` — subscribe to key events;
  each key is routed through the `FocusManager` first, falling back to the
  tree handler.
- `usePaste(handler, { isActive, focusManager })` — subscribe to paste
  events (the handler receives the pasted text string); each paste is routed
  through the `FocusManager` first (`routePaste`), falling back to the tree
  handler. Teardown on unmount.
- `useFocus(id, nodeRef, onKey, { manager })` — register an element's node
  (from a ref) with a `FocusManager`.
- `useResize(handler)` — subscribe to terminal resize; re-invokes
  `renderer.render()` after each so the compositor re-lays out.
- `usePanelMouseDrag(panelsRef)` — wire mouse drag-resize for a `<Panels>`
  element (`hit_test`-gated gutter drags).
- `useTheme()` / `<ThemeProvider theme={ThemeOverrides}>` — the active theme
  (partial themes merge over the core `defaultTheme`).

**Re-exports** — the core surface for typing props and wiring behavior:
`Node`, `NodeProps`, `KeyEvent`, `KeyHandler`, `Span`, `Renderer`,
`FocusManager`, `focusManager`, `editKey`, `selectKey`, `tick`, `scrollTo` /
`scrollBy` / `scrollTop`, `followTail` / `syncStreamTail` /
`isStreamFollowing` / `scrollToBottom`, `pasteInto` / `pasteIntoTextarea`,
`startPanelDrag` / `dragPanels` / `endPanelDrag`, `defaultTheme` /
`mergeTheme` / `resolveTheme`, and the theme types.

## Example

```tsx
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
    { border_style: "rounded", padding: 1 },
    createElement(Text, { text: "Hello tern" }),
  );
}

const renderer = createRenderer({ exitOnCtrlC: true });
render(createElement(App), renderer);

// Passive effects (useInput's subscription) settle on the scheduler first.
await new Promise((resolve) => setTimeout(resolve, 100));
while (!renderer.destroyed) {
  renderer.pollEvents(50);
}
```

## Runtime

Deno-first (`deno check` / `deno test` are canonical); the native addon
requires `--allow-ffi` under Deno. Peers: `react` ^19.2.0 and
`react-reconciler` ^0.33.0. See the [@tern/core README](../core/README.md)
for building the native addon and [docs/guide.md](../../docs/guide.md) for
the component and event-model guides.
