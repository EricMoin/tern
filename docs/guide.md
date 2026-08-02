# tern Guide

This guide walks through building a tern TUI with `@tern/react` or
`@tern/solid`: getting started, the component set, the event model, and
theme usage. For the rendering pipeline see
[architecture.md](architecture.md); for the widget roadmap status see
[components.md](components.md); for the post-MVP phases see
[roadmap.md](roadmap.md).

## Getting started

### Prerequisites

- Stable Rust 1.94 (pinned in `rust-toolchain.toml`).
- Deno (the primary JS runtime — `deno check` / `deno test` are the canonical
  checkers). Node.js is used for the napi build and as a fallback runtime.
- The `tern-node` native addon built once after a fresh checkout:

```sh
npm install                  # repo root — installs JS deps
npm run build --prefix src/bindings/tern-node   # napi build --platform && node fix-dts.mjs
```

### Run the bundled demos

From the repo root (Deno-first):

```sh
deno run --allow-all packages/examples/react-demo.ts
deno run --allow-all packages/examples/solid-demo.ts
deno run --allow-all packages/examples/kitchen-sink-react.ts
deno run --allow-all packages/examples/kitchen-sink-solid.ts
```

Each demo renders a scene, asserts it, and quits on `q`. The PTY smoke
harness drives all four under a macOS `script` pseudo-terminal:

```sh
bash packages/examples/run-smoke.sh
```

### Write a minimal app

See the quick-starts in the [root README](../README.md): `@tern/react`
uses a React component tree with `render` + `useApp`/`useInput`;
`@tern/solid` builds the scene with element factories and mounts it with the
universal `render`, using `subscribeInput` for input.

## Component overview

Every widget exists in three forms, all producing the same scene node
structure:

| Element | `@tern/react` | `@tern/solid` | Description |
|---------|---------------|---------------|-------------|
| Box | `<Box>` | `Box(props)` | Container: border, background, padding, flex layout |
| Text | `<Text text="..." />` | `Text(props)` | Text leaf (string children are rejected in React) |
| StreamingText | `<StreamingText stream autoScroll wrap />` | `StreamingText(props)` + `subscribeStream` | Incrementally fed styled-span stream with tail-follow auto-scroll |
| Input | `<Input value caret placeholder focusId onChange onSubmit />` | `Input(props)` + `editKey` | Single-line text entry with a block caret |
| Spinner | `<Spinner value max frames interval />` | `Spinner(props)` + `tick` / `startSpinner` | Determinate bar or indeterminate glyph |
| StatusBar | `<StatusBar left center right />` | `StatusBar(props)` | Single-row left/center/right segment strip |
| Panels | `<Panels panels active direction />` | `Panels(props)` | Collapsible header/body stack with a drag gutter |
| DiffView | `<DiffView hunks scroll_x scroll_y wrap />` | `DiffView(props)` | Unified-diff rows (gutter, markers, per-kind colors) |
| Select | `<Select options multi value ... focusId />` | `Select(props)` + `selectKey` | Filterable option list, multi-select, floating overlay |
| ScrollView | `<ScrollView clip_* scroll_* showScrollbar>` | `ScrollView(props)` + `scrollTo`/`scrollBy`/`scrollTop` | Clip/scroll region with optional scrollbar |

The roadmap elements are JS compositions over the primitive `box` / `text` /
`streaming_text` scene kinds — no new napi node kinds. Editing, caret,
selection, and scroll math live in the element (or the Rust renderable); the
compositor paints the result.

### Streaming output

`<StreamingText>` / `StreamingText` + `subscribeStream` consume an
`AsyncIterable<Span>` (`{ text, style? }`), appending each span to the node
and repainting after every append. With `autoScroll` (the default) the view
stays pinned to the stream tail (`syncStreamTail`); a manual scroll above the
tail detaches the follow, and `followTail` re-attaches.

## Event model

Events are **pull-based**: `renderer.pollEvents(timeoutMs)` blocks up to the
timeout for native input and returns the tagged `TernEventJs` union
(`"key"` / `"resize"` / `"focus"` / `"mouse"`), dispatching each event to the
handlers registered with:

- `onKey(event)` — a `KeyEvent` (a `name` like `"char"` / `"enter"` /
  `"escape"` / `"left"` / `"right"` / `"up"` / `"down"` / `"backspace"` /
  `"home"` / `"end"`, plus optional `char` and the `ctrl` / `alt` / `shift`
  modifiers).
- `onResize({ width, height })` — the new terminal size.
- `onFocus({ focus_gained })` — `true` on focus gained, `false` on lost.
- `onMouse(event)` — a `MouseEventJs` payload (`down_left`, `drag_left`,
  `up_*`, ... with `column` / `row`).

The app loop is a `while` around `pollEvents` that exits when the renderer is
destroyed (the `q` handler's `exit()` / `renderer.destroy()`, or Ctrl+C with
`exitOnCtrlC: true`).

### Key routing and focus

Elements that edit on keys register with a `FocusManager`:

- `@tern/react`: `<Input focusId="...">` and `<Select focusId="...">` register
  automatically; `useFocus(id, nodeRef, onKey)` registers an arbitrary
  element's node.
- `@tern/solid`: `useFocus(id, node, onKey)` (from `@tern/core`) registers a
  node directly.

The tree-level input hooks route each key through the manager first — when a
focused element handles it, the tree handler is skipped:

- `@tern/react`: `useInput(handler)`.
- `@tern/solid`: `subscribeInput(renderer, handler)` (Solid has no context,
  so the renderer is an explicit argument).

### Resize, focus and mouse consumers

The Phase 2 event surface is consumed in the renderers:

- **Resize reflow** — `useResize(handler)` (`@tern/react`) and
  `subscribeResize(renderer, handler)` (`@tern/solid`) re-invoke
  `renderer.render()` after each resize so the compositor re-lays out.
- **Panel drag-resize** — `usePanelMouseDrag(panelsRef)` (`@tern/react`) and
  `subscribePanelDrag(renderer, panels)` (`@tern/solid`) map mouse drags on
  the 1-cell gutters between panels to `flex_basis` changes (the core
  `startPanelDrag` / `dragPanels` / `endPanelDrag` helpers, clamped to the
  pane min sizes). Presses are gated by `renderer.hit_test(col, row)` so only
  painted gutter cells start a drag.
- **Focus-aware redraw** — the `@tern/react` `<Spinner>` mount effect and
  `@tern/solid` `startSpinner` skip `tick()` / `render()` while the terminal
  is unfocused, resuming on regain.

## Theme usage

The theme system is pure prop data flow: semantic `role` / `component` hints
on a node's props resolve to plain `fg` / `bg` / `border_style` style keys at
element-creation time (the hints are consumed and never reach the scene).

The default theme is One-Dark-flavored, with palette roles `primary` /
`secondary` / `success` / `danger` / `warning` / `muted` / `border` and
per-component presets for `input` / `spinner` / `status_bar` / `panels` /
`diff` / `select` / `scroll_view`.

- `defaultTheme` — the base theme.
- `mergeTheme(base, overrides)` — a partial theme over a base (per-role and
  per-preset keys merge; the base is never mutated).
- `resolveTheme(theme, props)` — stamp `fg` / `bg` / `border_style` onto
  props from `component` / `role` hints. Explicit props always win.
- `@tern/react`: `<ThemeProvider theme={overrides}>` provides a merged theme
  to the subtree; `useTheme()` reads it (defaults to `defaultTheme`).
- `@tern/solid`: `setTheme(overrides)` swaps the module-level active theme
  (merged over `defaultTheme`); `getTheme()` reads it. Solid has no context,
  so the theme is global state.

```tsx
// @tern/react
<ThemeProvider theme={{ palette: { primary: { fg: "#123456" } } }}>
  <Box role="primary" />            {/* fg resolves to #123456 */}
  <Box component="input" />         {/* border_style from the input preset */}
</ThemeProvider>
```

```ts
// @tern/solid
setTheme({ components: { input: { border_style: "double" } } });
Input({ placeholder: "ask…" });     // framed box resolves the preset
```
