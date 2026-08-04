# @tern/core

TypeScript bindings for the tern TUI engine. This package wraps the
`tern-node` napi addon (the Rust core) behind a small declarative API: a
renderer owns the terminal (raw mode + alternate screen), scene nodes are
built with factory functions, and an event loop pulls input back from the
Rust side.

## Purpose

`@tern/core` is the single JS surface over the engine. It is renderer-agnostic:
`@tern/react` and `@tern/solid` both drive the same node/factory API, so a
scene built with the core factories renders identically under either
reconciler. All engine logic stays in Rust (constitution) — the JS side only
describes the scene and reads events.

## API surface

**Renderer**

- `createRenderer({ exitOnCtrlC })` — construct a `Renderer` (enters raw mode
  + alternate screen). `exitOnCtrlC: true` tears the terminal down on Ctrl+C
  instead of surfacing it as an event.
- `Renderer` — `root` (the scene root `Node`), `render()` (paint the scene),
  `pollEvents(timeoutMs)` (pull native events, feeding the handlers),
  `onKey` / `onResize` / `onFocus` / `onMouse` / `onPaste` (each returns an
  unsubscribe),
  `hit_test(col, row)` (z-ordered node ids covering a cell), `destroy()`,
  `destroyed`.

**Scene nodes**

- `Node` — `addChild` / `insertBefore` / `remove` (tree ops), `setProps`
  (replace props + style), `appendSpan(text, style)` (streaming feed),
  `contentSize()` (laid-out content size), `children` / `props` / `type` /
  `attached`.
- Element factories (pure data until attached): `Text(props)`,
  `Box(props, ...children)`, `StreamingText(props)`.

**Roadmap element factories** (compositions over the primitives; no new napi
node kinds)

- `Input` (+ `editKey`) — framed box with a caret-painted text leaf.
- `Spinner` (+ `tick`, `DEFAULT_SPINNER_FRAMES`) — determinate bar or
  indeterminate frame glyph.
- `StatusBar` — single-row `left`/`center`/`right` segment strip.
- `Panels` (+ `collapsePanel` / `expandPanel` / `togglePanel` / `focusPanel`,
  and the drag-resize helpers `startPanelDrag` / `dragPanels` /
  `endPanelDrag`, `PANEL_DRAG_MIN_SIZE`) — collapsible header/body stack with
  a 1-cell drag gutter.
- `DiffView` (+ `DIFF_ADD_FG` / `DIFF_DEL_FG`) — unified or side-by-side
  diff rows: gutter, `+`/`-`/` ` markers, per-kind colors, `mode="side"`
  two-column layout, `inline_highlight` intra-line highlighting, `wrap`
  passthrough, `scroll_x` / `scroll_y` panning.
- `Select` (+ `selectKey`, `visibleOptions`, `SELECT_FILTER_PLACEHOLDER`) —
  filterable option list, `multi` checkmarks, `floating` overlay.
- `ScrollView` (+ `scrollTo` / `scrollBy` / `scrollTop`,
  `SCROLLBAR_THUMB_CHAR` / `SCROLLBAR_TRACK_CHAR`) — clip/scroll region with
  an optional track + thumb scrollbar.

**Streaming auto-scroll** — `setStreamAutoScroll`, `isStreamFollowing`,
`syncStreamTail` (pin `scroll_y` to the stream tail after each append),
`followTail` (re-attach after a manual scroll), `scrollToBottom` (a one-shot
jump to the tail that dismisses the `▼` affordance —
`STREAM_AFFORDANCE_CHAR`, stamped when a manual scroll above the tail
detaches the follow — without re-attaching).

**Theme** — `Theme` / `ThemeOverrides` types, `defaultTheme`,
`mergeTheme(base, overrides)`, `resolveTheme(theme, props)` (stamps plain
`fg`/`bg`/`border_style` from `role`/`component` hints).

**Focus** — `FocusManager` (class), `focusManager` (default instance),
`useFocus(id, node, onKey, manager?, onPaste?)`, `routePaste` (paste
counterpart of `routeKey`).

**Types** — `NodeProps`, `NodeType`, `KeyEvent`, `KeyHandler`,
`ResizeHandler`, `FocusHandler`, `MouseHandler`, `Span`, `Renderer`,
`TernEventJs`, `ContentSize`, `MouseEventJs`, `NodeHandle`,
`TuiRendererOptions`, `TuiRenderer` (napi types re-exported from
`tern-node`'s `index.d.ts`).

## Example

```ts
import { createRenderer, Box, Text } from "@tern/core";

const renderer = createRenderer({ exitOnCtrlC: true });
renderer.root.addChild(
  Box({ border_style: "rounded", padding: 1 }, Text({ text: "Hello" })),
);
renderer.render();

let quit = false;
renderer.onKey((event) => {
  if (event.name === "char" && event.char === "q") quit = true;
});
while (!quit && !renderer.destroyed) {
  renderer.pollEvents(50);
}
renderer.destroy();
```

## Runtime

Deno-first: the native addon is loaded via `node:module` `createRequire`
(`./addon.ts`), which Deno 2.x supports for Node-API addons with
`--allow-ffi` (+ read access to the `.node` file). Node.js works unchanged.
Check with `deno check src/index.ts`, test with `deno test src`.

## Documentation

See [docs/guide.md](../../docs/guide.md) for the getting-started guide,
[docs/components.md](../../docs/components.md) for the component overview, and
[README.md](../../README.md) for quick-starts using the `@tern/react` /
`@tern/solid` renderers.
