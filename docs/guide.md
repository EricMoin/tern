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
| Table | `<Table columns rows scroll_x scroll_y highlight sticky_header clip_height />` | `Table(props)` + `tableKey`/`visibleTableRows` | Sticky-header data table with per-column alignment and highlight/scroll |
| Textarea | `<Textarea lines row col width height focusId onChange onSubmit />` | `Textarea(props)` + `editTextareaKey` | Multi-line text editor with soft wrap, scroll-to-caret, line splitting |
| Modal | `<Modal open backdrop z_index content />` | `Modal(props)` + `openModal`/`closeModal` | Full-bleed dimmed overlay with centered content and focus isolation |

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

## Widget API reference

The roadmap widgets are JS compositions over the primitive `box` / `text`
scene kinds — no new napi node kinds. Their interactive state lives on the
node props; the driving helpers below read and mutate it.

### Table

`Table(props)` (core) builds a flex column: a sticky header row (paint
z-order 1) above a scrollable content region, plus one row leaf per data row
with per-column width/alignment — each cell padded to its column width,
overflow truncated never mid-glyph, the highlighted row reversed. `<Table>`
in `@tern/react` and `Table` in `@tern/solid` materialize the same factory.

- `TableProps` — `columns: TableColumn[]`, `rows: (string | number)[][]`,
  `scroll_x` / `scroll_y` (offsets in cells), `highlight` (row index),
  `sticky_header` (default `true`), `clip_height` (viewport rows).
- `TableColumn` — `key`, `header`, `width` (in cells), `align?`
  (`"left"` | `"right"` | `"center"`, default `"left"`).
- `TableState` — `highlight`, `scroll_x`, `scroll_y` (reported by
  `tableKey`).
- `tableKey(table, event)` — `up` / `down` move the highlight (clamped to the
  rows) and auto-scroll the content region so the highlighted row stays in
  the visible window; any other key leaves the table unchanged. Returns the
  new state.
- `visibleTableRows(table)` — the visible window
  `rows[scroll_y, scroll_y + clip_height)` (the whole remaining list when
  `clip_height` is unset).

`scroll_x` on the root pans the header and rows together (columns stay
aligned); `scroll_y` pans only the content region, so the sticky header does
not scroll. `clip_height` sets the content viewport.

### Textarea

`Textarea(props)` (core) builds a framed box with one text leaf per visible
display row. The edit model — `lines`, `row`, `col`, `scroll` — stays on the
node as JS bookkeeping and never reaches the scene props.

- `TextareaProps` — `lines` (default `[""]`), `row` / `col` (the cursor into
  `lines`), `width` (soft-wrap width in cells), `height` (visible window in
  display rows), `scroll` (top visible display row).
- `TextareaState` — `lines`, `row`, `col` (reported by `editTextareaKey` and
  the `<Textarea>` callbacks).
- `editTextareaKey(textarea, event)` — char insert, `backspace` / `delete`
  (joining adjacent lines at the boundaries), `left` / `right` / `home` /
  `end`, `enter` (splits the line at the cursor), and `up` / `down` across
  the soft-wrapped display lines (preserving a preferred column across a run
  of vertical moves). Returns the new `{ lines, row, col }`.

`width` soft-wraps long lines into display rows (token-aware); `height` sets
the visible window with vertical scroll-to-caret. `<Textarea>` in
`@tern/react` adds `focusId` / `focusManager` / `onChange` / `onSubmit` and
registers with a `FocusManager` so routed keys edit it; `Textarea` in
`@tern/solid` is the plain factory.

### Modal

`Modal(props)` (core) builds a full-bleed overlay: an absolutely positioned
root box inset to its parent's padding box, stamped with a high `z_index`
(`MODAL_Z_INDEX` = 100) so it paints above in-flow content, composing a
dimmed backdrop box (`MODAL_BACKDROP_BG`) plus a centered content box
wrapping the content nodes (`content` prop or rest-arg children).

- `ModalProps` — `open` (default `false` — hidden), `backdrop` (default
  `true`), `z_index` (default `MODAL_Z_INDEX`), `content` (core `Node[]`).
- `openModal(modal, manager?)` — records the active focus id, shows the
  overlay (`hidden` off / `display: flex`), and moves focus into it via
  `manager.focusFirst()`.
- `closeModal(modal, manager?)` — hides the overlay (`hidden` on /
  `display: none`) and restores the recorded focus id, or blurs when nothing
  was recorded (or the recorded id was unregistered meanwhile).

`<Modal>` in `@tern/react` takes the content as a `content` prop (no React
children); `Modal` in `@tern/solid` is the plain factory.

### FocusManager

`FocusManager` (core) routes key events to registered focusable elements:
`register({ id, node, onKey })` returns an unsubscribe, and
`routeKey(event, node?)` dispatches to an explicit node's handler or the
active focus.

- `focus(id)` / `blur()` — set / clear the active focus; `has(id)`,
  `activeId`, and `active` read it.
- `next()` / `prev()` — walk the registered elements in registration order,
  wrapping around (with nothing focused, `next()` focuses the first).
- `focusFirst()` — focus the first registered element.
- `focusIdFor(node)` — the registered id of a scene node (`null` when not
  registered).
- `subscribe(cb)` / `unsubscribe(cb)` — observe focus changes; the callback
  receives the new active id, or `null` on blur / unregister of the active
  id.

`useFocus(id, node, onKey, manager?)` (core) registers and returns a
`FocusHandle` (`focus` / `blur` / `isFocused` / `dispose`); the module-level
`focusManager` is the default. Focus changes are observed with `subscribe`,
not a change callback prop.

### Mouse helpers

- `wheelScroll(view, event)` — maps `scroll_up` / `scroll_down` /
  `scroll_left` / `scroll_right` onto the view's offsets via `scrollBy` ±1
  (clamped to the content bounds); a `table` scrolls its content region so
  the sticky header stays pinned. Returns whether the event was consumed.
- `focusAt(renderer, event, manager?)` — routes a `down_left` press on a
  painted cell (`Renderer.hit_test` gate) to the topmost registered focusable
  node: the live scene tree is walked in paint order and the first node the
  manager has registered (via `focusIdFor`) is focused. Returns whether a
  focus was applied.

## Recipes

### Agent form: Input + Textarea + Select + Table

A code-agent compose box with a file picker table and a structured
tool-parameter form. The editable widgets register with the `FocusManager`
via `focusId` (React) or `useFocus` (Solid); `next()` / `prev()` / `tab`
traversal moves between them, and every `down_left` click focuses the
topmost registered node under the cursor.

```tsx
// @tern/react
import { Box, Input, Textarea, Select, Table, useInput } from "@tern/react";
import { tableKey, focusManager } from "@tern/core";
import { useRef } from "react";

function ComposeForm() {
  const tableRef = useRef(null);
  useInput((event) => {
    // Keys route through the FocusManager first; only unhandled keys
    // reach this tree handler — e.g. drive the table with the highlight
    // keys when nothing focused.
    const table = tableRef.current;
    if (table && !focusManager.activeId && event.name !== "char") {
      tableKey(table, event);
    }
  });
  return (
    <Box flex_direction="column" padding={1}>
      <Textarea lines={["To:"]} width={60} height={3} focusId="composer" />
      <Select options={["approve", "edit", "reject"]} focusId="action" />
      <Table ref={tableRef} columns={[{ key: "f", header: "File", width: 24 }]}
             rows={[["main.rs"], ["lib.rs"]]} highlight={0} clip_height={8} />
      <Input placeholder="message…" focusId="footer" />
    </Box>
  );
}
```

```ts
// @tern/solid — the same scene, built with factories
import { Box, Textarea, Select, Table, Input, useFocus } from "@tern/solid";
import { editTextareaKey } from "@tern/core";

const box = Box({ flex_direction: "column", padding: 1 });
box.addChild(Textarea({ lines: ["To:"], width: 60, height: 3 }));
box.addChild(Select({ options: ["approve", "edit", "reject"] }));
box.addChild(Table({ columns: [{ key: "f", header: "File", width: 24 }],
  rows: [["main.rs"], ["lib.rs"]], highlight: 0, clip_height: 8 }));
box.addChild(Input({ placeholder: "message…" }));
const editor = box.children[0];
useFocus("composer", editor, (event) => editTextareaKey(editor, event));
```

### Modal dialog with focus restore

`openModal` records the active focus id and moves focus into the overlay
(`focusFirst`); `closeModal` hands focus back to the recorded id (or blurs
when nothing was recorded). The `<Modal>` ref forwards to the modal node so
the helpers can be called on it.

```tsx
// @tern/react — content is a core Node[] prop (no React children)
import { Modal } from "@tern/react";
import { Box, Input, openModal, closeModal, useFocus, editKey } from "@tern/core";
import { useRef } from "react";

// The overlay's focusable: registered first, so openModal's focusFirst()
// lands inside the overlay.
const modalBody = Box();
const modalInput = Input({ value: "", width: 20 });
modalBody.addChild(modalInput);
useFocus("modal-input", modalInput, (e) => editKey(modalInput, e));

const modalRef = useRef<Node | null>(null);
const open = () => openModal(modalRef.current!);   // dims + focusFirst()
const close = () => closeModal(modalRef.current!); // restores prior focus
<Modal ref={modalRef} open content={[modalBody]} />
```

```ts
// @tern/solid
const modal = Modal({ content: [
  Box({ padding: 1 }, Text({ text: "Apply this edit?" }),
      Input({ placeholder: "y/n" })),
] });
openModal(modal);   // dims the scene, focuses the overlay's first focusable
closeModal(modal);  // restores the previously active focus
```

### Wheel-scrollable region

Attach the wheel-scroll consumer to a `ScrollView` / `Table` ref; consumed
wheels repaint the scene, other events fall through.

```tsx
// @tern/react
const viewRef = useRef<Node | null>(null);
useWheelScroll(viewRef);
<ScrollView ref={viewRef} width={60} height={10} clip_height={10}>
  <Text text={log} />
</ScrollView>
```

```ts
// @tern/solid
const view = ScrollView({ width: 60, height: 10, clip_height: 10 });
view.addChild(Text({ text: log }));
subscribeWheelScroll(renderer, view);   // returns a disposer
subscribeClickFocus(renderer);          // click-to-focus, per app
```

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

- `@tern/react`: `<Input focusId="...">`, `<Textarea focusId="...">` and
  `<Select focusId="...">` register automatically; `useFocus(id, nodeRef,
  onKey)` registers an arbitrary element's node.
- `@tern/solid`: `useFocus(id, node, onKey)` (from `@tern/core`) registers a
  node directly.

The tree-level input hooks route each key through the manager first — when a
focused element handles it, the tree handler is skipped:

- `@tern/react`: `useInput(handler)`.
- `@tern/solid`: `subscribeInput(renderer, handler)` (Solid has no context,
  so the renderer is an explicit argument).

Focus moves programmatically (`focus(id)` / `blur()`) or by traversal:
`next()` / `prev()` walk the registered elements in registration order
(wrapping around), and `focusFirst()` focuses the first registered element.
`focusIdFor(node)` maps a scene node back to its registered id. Focus changes
— including blur and the unregister of the active id — are observable with
`subscribe(cb)` / `unsubscribe(cb)`, the callback receiving the new active id
or `null`.

Click-to-focus routes a `down_left` press to the topmost registered focusable
node under the cursor: the core `focusAt(renderer, event)` gates the press
with `Renderer.hit_test` and walks the live scene tree via `focusIdFor`;
`useClickToFocus(renderer)` (`@tern/react`) and
`subscribeClickFocus(renderer)` (`@tern/solid`) wire it per app.

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
- **Wheel scroll** — `useWheelScroll(viewRef)` (`@tern/react`) and
  `subscribeWheelScroll(renderer, view)` (`@tern/solid`) map wheel events
  (`scroll_up` / `scroll_down` / `scroll_left` / `scroll_right`) through the
  core `wheelScroll(view, event)` helper onto the view's offsets (`scrollBy`
  ±1, clamped to the content bounds; a `table` scrolls its content region so
  the sticky header stays pinned). A consumed wheel repaints the scene;
  non-wheel events fall through.
- **Focus-aware redraw** — the `@tern/react` `<Spinner>` mount effect and
  `@tern/solid` `startSpinner` skip `tick()` / `render()` while the terminal
  is unfocused, resuming on regain.

## Theme usage

The theme system is pure prop data flow: semantic `role` / `component` hints
on a node's props resolve to plain `fg` / `bg` / `border_style` style keys at
element-creation time (the hints are consumed and never reach the scene).

The default theme is One-Dark-flavored, with palette roles `primary` /
`secondary` / `success` / `danger` / `warning` / `muted` / `border` and
per-component presets for `input` / `textarea` / `spinner` / `status_bar` /
`panels` / `diff` / `select` / `scroll_view` / `table`.

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
