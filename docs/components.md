# tern Component Roadmap (code agent)

This document is the roadmap for the tern widget library, targeted at the
primary use case: **terminal UI for code agents** (Claude Code / opencode-style
CLI assistants). It covers the components the MVP does *not* ship, in rough
implementation order, one section per component.

## How components map onto the pipeline

The render pipeline is described in [architecture.md](architecture.md). A
component lives in two places:

- **JS element** — declarative, reconciler-managed (e.g. `<StreamingText/>`
  under `@tern/react` / `@tern/solid`). Produces a scene update.
- **Rust renderable** — the painting/behavior half in
  `src/core/tern-components` (the `Renderable` / `Text` / `Box` pattern).

The MVP ships the core `Text` / `Box` renderables plus the compositor. A
completeness pass has since landed the full roadmap element set — **the Rust
renderable half** of [Input](#input), [Spinner](#spinner),
[Panels / split layouts](#panels--split-layouts), and [StatusBar](#statusbar)
in `src/core/tern-components` (state, interaction, and paint are unit- and
golden-tested), plus the **JS elements and renderer wiring** for every
component below: element factories in `@tern/core`, host
components/factories in `@tern/react` and `@tern/solid`, focus/key routing via
the core `FocusManager`, spinner timer redraw, the theme system, soft wrap,
and the Phase 2 event consumers (resize reflow, panel drag-resize,
focus-aware redraw, mouse wheel scroll, click-to-focus). The status table
below is current — the shipped rows reflect what runs today.

## Event model

Terminal events reach the scene through `@tern/core`'s `Renderer`:
`startEventStream()` starts push-based delivery (roadmap Phase 3 — shipped):
the native binding's background event loop pushes every terminal event to the
JS thread through a `ThreadsafeFunction`, yielding the tagged `TernEventJs`
union (`"key"` / `"resize"` / `"focus"` / `"mouse"` / `"paste"`) on the
`renderer.events` async iterable and feeding the `onKey` / `onResize` /
`onFocus` / `onMouse` / `onPaste` handlers the renderer exposes:

- `onKey(event)` — a `KeyEvent` (key name plus optional `char` / modifiers).
- `onResize({ width, height })` — the new terminal size.
- `onFocus({ focus_gained })` — `true` on focus gained, `false` on lost.
- `onMouse(event)` — a `MouseEventJs` payload.
- `onPaste(text)` — the pasted text string (crossterm bracketed paste).

Key and paste routing go through the core `FocusManager`: elements register
with `useFocus(id, node, onKey, manager?, onPaste?)` and the manager
dispatches each key to the focused element's handler (`routeKey`) and each
paste to its paste handler (`routePaste` — an element that registered no
`onPaste` never consumes, so the paste falls through to the tree handler).
The tree-level input hooks consult the manager first — `useInput` in
`@tern/react` and `subscribeInput` in `@tern/solid` route each key through
the core `FocusManager` before falling back to the tree handler.

## Status legend

| Status | Meaning |
|--------|---------|
| ✅ MVP | Ships in the first runnable milestone |
| ✅ Shipped | JS element + renderer wiring complete |
| 🔜 Soon | Next after MVP; small, well-understood |
| 🧭 Later | Needs a prerequisite phase (see [roadmap.md](roadmap.md)) |

| Component | Status | Needs |
|-----------|--------|-------|
| [StreamingText](#streamingtext) | ✅ Shipped | — |
| [MarkdownView](#markdownview) | ✅ Shipped | — |
| [DiffView](#diffview) | ✅ Shipped | — |
| [Input](#input) | ✅ Shipped | — |
| [Spinner](#spinner) | ✅ Shipped | — |
| [Panels / split layouts](#panels--split-layouts) | ✅ Shipped | — |
| [StatusBar](#statusbar) | ✅ Shipped | — |
| [Select](#select) | ✅ Shipped | — |
| [ScrollView](#scrollview) | ✅ Shipped | — |
| [Table](#table) | ✅ Shipped | — |
| [Textarea](#textarea) | ✅ Shipped | — |
| [Modal](#modal) | ✅ Shipped | — |
| [Theme system](#theme-system--soft-wrap) | ✅ Shipped | — |
| [Soft wrap (`wrap` prop)](#theme-system--soft-wrap) | ✅ Shipped | — |

---

## StreamingText

**Purpose:** render an incrementally growing stream of text — the dominant
code-agent output (LLM tokens arriving over a socket/stdio pipe).

**Core problem:** the agent appends spans of text continuously, at high
frequency. Re-rendering the whole buffer per append is wasteful; re-flowing the
whole viewport is noticeable jank.

**Design:**

- **Span feed API.** The component is driven by an append-only feed of
  *spans*: `{ text, style }` (style optionally carries ANSI/fg/bg, or a
  semantic token like `bold`). Appends happen through
  `stream.append(span)` or a reactive stream binding in the renderer.
- **Incremental layout.** Only the tail of the buffer (the partial line plus
  new lines) is re-laid-out and re-painted per append; earlier cells are
  untouched. The tern-terminal diff flush already guarantees minimal
  escape-sequence output (pipeline step 7 in architecture.md), so the win is
  on the *layout/paint* side, not the terminal side.
- **Auto-scroll.** When the stream is at the bottom, follow the tail; when the
  user scrolls up, detach and show a "scroll to bottom" affordance.
- **Wrap & soft lines.** Long tokens wrap at cell width; wrapping state is
  computed once per appended span, not per full buffer.

**API sketch (JS):**

```tsx
<StreamingText
  stream={agent.stdout}          // AsyncIterable<Span> | reactive source
  autoScroll                      // follow the tail by default
  wrap
/>
```

**Acceptance:** a 10k-token stream renders without dropping characters; typing
backpressure keeps the event loop responsive; tail-follow + scroll-up detach
works.

**Shipped:** the `streaming_text` scene node ships end to end. `StreamingText`
in `@tern/core` builds the node (fed via `Node.appendSpan`); `<StreamingText>`
in `@tern/react` consumes the `stream` prop with an effect that appends each
span, paints after every append, and feeds the auto-scroll; `StreamingText` +
`subscribeStream` in `@tern/solid` do the same. Auto-scroll ships as the core
`syncStreamTail` / `followTail` / `isStreamFollowing` / `setStreamAutoScroll`
helpers, defaulting to tail-follow (`autoScroll: true`) — a manual scroll
above the tail detaches the follow and stamps the scroll-to-bottom
affordance (a `▼` cell, `STREAM_AFFORDANCE_CHAR`, absolutely positioned at
the clip region's bottom-right above in-flow content), and `followTail`
(re-attach) or the `scrollToBottom` helper (a one-shot jump to the tail)
dismiss it.

---

## MarkdownView

**Purpose:** render agent answers that are Markdown — headings, lists, inline
code, code fences, blockquotes, links.

**Core problem:** streaming Markdown arrives incrementally; a fence may be
half-open while tokens are still arriving. The view must render best-effort
*while the document is incomplete* and settle correctly when it closes.

**Design:**

- **Parser** (incremental, streaming-friendly): parse a token prefix per
  append; keep parse state between appends so a closing ```` ``` ```` reflows
  correctly.
- **Block styles:** headings, lists, blockquotes, horizontal rules, code
  fences, paragraphs. Rendered as styled spans over `Text`/`Box`.
- **Inline styles:** `**bold**`, `` `code` ``, `[links](url)`, `*italic*`.
- **Syntax highlighting** inside code fences via tree-sitter (roadmap
  Phase 4 — shipped): the `tern-highlight` crate maps tree-sitter captures
  to style spans (keywords, strings, comments, types) over the whole fence;
  `@tern/core`'s `highlightCode` feeds them into the fence's leaves (a
  fence with a recognized language renders one styled leaf per line with
  token colors, falling back to the single fence style for unknown
  languages or when the native addon is unavailable).
- **Layout:** reuses tern-layout over block-level boxes; code blocks get a
  distinct background and optional box border.

**API sketch (JS):**

```tsx
<MarkdownView
  source={agent.answer}      // AsyncIterable<string> | string
  maxWidth                    // wrap width
  highlight={{ language: 'rust' }}  // active after tree-sitter phase
/>
```

**Acceptance:** a streamed Markdown answer renders progressively (fence closes
correctly at the end); inline/block styles match a golden buffer test.

**Shipped:** `MarkdownView` in `@tern/core` builds the `markdown` element — a
flex column of block nodes rendering the `source` (headings bold, H1
underlined; paragraphs; bulleted/ordered lists; dimmed block quotes; `─`
horizontal rules; and code fences as a `bg` box with one leaf per line,
tree-sitter-highlighted for recognized languages) with `**bold**` /
`*italic*` / `` `code` `` / `[links](url)` inline styles parsed into
per-span `Text` leaves. Parsing is best-effort and streaming-friendly: a
half-open code fence renders its collected lines as the fenced block, and an
unclosed inline marker styles the rest of its line. The `source` key is
consumed (JS bookkeeping — never a scene prop); the `width` prop soft-wraps
plain lines. No new napi node kind: the `markdown` element materializes as a
`box` (constitution).

---

## DiffView

**Purpose:** show file changes — the agent proposing edits, or a `git diff`
being reviewed before apply.

**Core problem:** line-oriented content with added/removed/context lines,
gutter markers, and (optionally) intra-line highlights. Must stay readable in a
narrow terminal and compose with side-by-side mode later.

**Design:**

- **Unified diff model** as the canonical input: hunks of `{ kind: add | del |
  ctx, old_line, new_line, text }`.
- **Rendering:** gutter (old/new line numbers), `+`/`-`/` ` markers, per-kind
  colors (green/red), context dimmed. Multiple hunks scroll as one region.
- **Intra-line diff:** char-level highlight of changed words within an add/del
  pair (computed with a Myers-style diff at char granularity, cheap for
  terminal widths).
- **Side-by-side:** a `mode="side"` variant that splits a wide viewport into
  two columns; needs the split-layout machinery from
  [Panels](#panels--split-layouts).

**API sketch (JS):**

```tsx
<DiffView hunks={diff.hunks} mode="unified" wrap={false} />
```

**Acceptance:** golden test for a 3-hunk diff: gutter alignment, kind colors,
context dimming; side-by-side mode fills two panels without overflow.

**Shipped:** `DiffView` in `@tern/core` renders the unified-diff rows — a
dimmed gutter with right-aligned old/new line numbers, `+`/`-`/` ` markers,
and per-kind colors (adds `#98c379`, dels `#e06c75`, context dimmed) — with
`scroll_x` / `scroll_y` panning the whole region and the `wrap` prop passing
through to each content leaf. Side-by-side mode ships: `mode="side"` renders
two aligned columns (old | new) split by a 1-cell gap (mirroring `Panels`),
each hunk line one row per column aligned by line pair, with per-column
gutters. Intra-line highlighting ships too: `inline_highlight` computes a
char-level diff on each adjacent add/del pair and renders the changed
segments bold + underlined on the line's kind color, leaving unchanged
characters plain. `<DiffView>` in `@tern/react` and `DiffView` in
`@tern/solid` materialize the same factory.

---

## Input

**Purpose:** single-line text entry — the agent prompt box, and any
free-text field (tool parameters, search).

**Core problem:** a visible caret that moves with arrow keys, editable text,
and history navigation are all stateful interactions layered on a
cell-buffer renderer that repaints per frame.

**Design:**

- **Caret:** block or line caret, blink handled by the renderer's redraw
  timer; caret position exposed as a column offset into the line.
- **Editing:** insert/delete, cursor movement (left/right, home/end), word
  jumps (option-arrow), selection + clipboard paste, IME composition passthrough.
- **History:** up/down arrows walk a bounded ring buffer; empty-entry resets
  to draft.
- **Focus:** an `Input` participates in the focus model — focused input owns
  key events; other components are inert.
- **Placeholder** rendered dimmed when the value is empty.

**API sketch (JS):**

```tsx
<Input
  value={prompt}
  onChange={setPrompt}
  onSubmit={run}
  history={recentPrompts}
  placeholder="Ask tern…"
  focus
/>
```

**Acceptance:** golden test for caret position + placeholder; interaction test
for history navigation and word-jump.

**Rust renderable:** ships in `src/core/tern-components` — `Input` owns the
value, char-index cursor, placeholder, bounded history ring, and a
renderer-agnostic `Key`/`handle_key` mapping; it materializes as a framed box
with a `caret`-prop text leaf the compositor paints as a block caret. The JS
element (`Input` in `@tern/core`; `<Input>` in `@tern/react`, `Input` in
`@tern/solid`) adds focus/key routing: a `focusId` registers with the core
`FocusManager` (`useFocus`), routed keys edit the value via `editKey`, and
`onChange` / `onSubmit` fire on edits and Enter. Routed paste (via `usePaste`
in `@tern/react` / `subscribePaste` in `@tern/solid`) auto-pastes into a
focused `<Input focusId>` through the core `pasteInto` — inserting at the
caret, multi-width aware, and firing `onChange` (an empty paste is a no-op).

---

## Spinner

**Purpose:** show activity — indeterminate "working…" (agent thinking) and
determinate progress (tool execution, file upload, token budget).

**Core problem:** animation needs a *periodic redraw* on top of a
paint-on-demand pipeline. The JS side provides it — `<Spinner>` in
`@tern/react` runs a tick interval while mounted (see the Rust renderable note
below), and the tick pauses while the terminal is unfocused (focus-aware
redraw, [roadmap Phase 2](roadmap.md#phase-2--resize-focus--mouse-events--done) —
shipped).

**Design:**

- **Indeterminate:** frame-cycling glyphs (`⠋⠙⠹…` braille, or
  `|/-\`). Frames advance on a timer; the component registers a redraw
  callback with the renderer.
- **Determinate:** a progress bar (`▓▓▓░░░ 42%`), updated on `value`/`max`
  changes. Optionally a label and an ETA derived from rate.
- **Lifecycle:** a spinner only ticks while mounted and visible; the timer
  stops when the panel is hidden or the app is not focused.

**API sketch (JS):**

```tsx
<Spinner indeterminate />          // "thinking…"
<Spinner value={done} max={total} label="copying" />
```

**Acceptance:** determinate bar paints exactly `ceil(value/max * width)` filled
cells; indeterminate frames advance on the renderer timer and stop when
unmounted.

**Rust renderable:** ships in `src/core/tern-components` — `Spinner` cycles
indeterminate frames on `tick()` (the renderer timer drives it) and paints the
determinate bar via `filled_cells()`/`bar()`. The JS element (`Spinner` in
`@tern/core`; `<Spinner>` in `@tern/react`, `Spinner` in `@tern/solid`) adds
timer redraw: a tick interval (default 100 ms) advances the frame via `tick`
while mounted and is cleared on unmount.

---

## Panels / split layouts

**Purpose:** the code-agent workspace is never a single pane — transcript +
input, side-by-side diffs, a file tree, a tool-log panel.

**Core problem:** resizable, nested splits with keyboard- and
mouse-driven resize, minimum sizes, and focus traversal between panes.

**Design:**

- **Split tree** over the existing tern-layout engine: `flex_row` /
  `flex_column` layouts with `flex_grow`/`flex_shrink` map naturally to
  horizontal/vertical splits (tern-layout already wraps taffy).
- **Resize handles:** a 1-cell gutter between panes; drag with mouse or
  keyboard chords (e.g. `ctrl+w ←/→`). Handles set absolute flex-basis on the
  adjacent pane.
- **Min sizes & collapse:** each pane declares `min_w`/`min_h`; collapsing
  below a threshold turns the pane into a tab/icon.
- **Focus model:** exactly one pane is focused; arrow/`tab` moves focus
  between panes; the focused pane's `Input`/`Select` receives keys.

**API sketch (JS):**

```tsx
<Split direction="row" sizes={[0.6, 0.4]}>
  <Transcript />
  <Input />
</Split>
```

**Acceptance:** nested row+column splits lay out with correct min sizes; a
keyboard resize sequence changes pane widths and a golden buffer matches.

**Rust renderable:** ships in `src/core/tern-components` — `Panels` stacks
`Panel`s (column or row), each with a collapsible header; `toggle`/`collapse`/
`expand` hide the body and an `active` index tracks focus. The JS element
(`Panels` in `@tern/core`; `<Panels>` in `@tern/react`, `Panels` in
`@tern/solid`) exposes `collapsePanel` / `expandPanel` / `togglePanel` /
`focusPanel`. Mouse drag-resize ships as `startPanelDrag` / `dragPanels` /
`endPanelDrag` in `@tern/core`, wired by `usePanelMouseDrag` (`@tern/react`)
and `subscribePanelDrag` (`@tern/solid`); the flex-basis reflow of a drag
into the layout engine ships — tern-layout maps the `flex_basis` prop into
taffy's flex-basis, so a drag reflows the pane split (roadmap Phase 2,
shipped).

---

## StatusBar

**Purpose:** a persistent bottom strip: agent state (thinking / running /
idle), current working directory / file, mode indicators, token or step
counters, and key-binding hints.

**Core problem:** it occupies a reserved viewport row that *no panel or
scroll region may overlap*, and it must reflect rapidly changing agent state
without re-rendering unrelated content.

**Design:**

- **Reserved row:** the app layout reserves the bottom row of the viewport
  (the compositor subtracts it before laying out panels).
- **Segments:** left/center/right aligned segments; each segment is a small
  styled `Text` (e.g. `● thinking`, `~/repo`, `⌘k help`).
- **Priority overflow:** when segments exceed the row width, lower-priority
  segments drop (rightmost first) rather than wrapping.
- **State derivation:** reads from the agent state store (reactive), not from
  per-component props, so any state change repaints only the status row.

**API sketch (JS):**

```tsx
<StatusBar left={<AgentState/>} right={<KeyHints/>} />
```

**Acceptance:** with a narrow viewport, overflow segments drop in priority
order; a state change repaints only the status row (verified by buffer-diff
test).

**Rust renderable:** ships in `src/core/tern-components` — `StatusBar` holds
left/center/right `Segment`s and `trimmed()` drops lowest-priority segments
(rightmost-first on ties) against a row width. The JS element (`StatusBar` in
`@tern/core`; `<StatusBar>` in `@tern/react`, `StatusBar` in `@tern/solid`)
materializes as a single-row `space-between` strip (height 1) whose children
are the left/center/right segment `Text` nodes.

**Reserved row (shipped):** the strip frame is stamped `status_bar: true`
(the Rust renderable stamps it at materialization; the JS `StatusBar` factory
stamps the same prop on the strip node). The compositor reads the marker and
reserves the bottom viewport row for the strip (roadmap Phase 2 — shipped):
the layout viewport handed to the engine is one row shorter, so every panel
and scroll region lays out entirely above the row, and the strip frame — with
its whole subtree — is pinned to that row. A scene without a `StatusBar` is
laid out against the full viewport exactly as before. The reserved-row
behavior is asserted by the compositor golden test
(`golden_panels_and_status_bar_reserve_bottom_row`).

---

## Select

**Purpose:** pick one (or many) options from a list — tool-approval menus,
model pickers, "which file to open", multi-select of files to apply.

**Core problem:** keyboard navigation over a list with filtering, in a
scrollable popup that must not disturb the layout it overlays or docks to.

**Design:**

- **List + cursor:** rendered as a scrollable list; highlighted row gets the
  selection style; up/down moves, enter confirms, escape dismisses.
- **Typeahead filter:** typing filters options by prefix/substring; the
  filter box can be inline (docked) or a popup above the trigger.
- **Multi-select:** toggleable checkmarks (`✓`/` `) with a summary line of
  selected count; confirm returns an array.
- **Overlay/docking:** a Select that cannot fit in its docked region flips
  to render as an overlay on top of the buffer (compositor supports
  z-ordered painting).

**API sketch (JS):**

```tsx
<Select
  options={files}
  filterable
  multiple
  onConfirm={setSelection}
/>
```

**Acceptance:** interaction test: filter narrows the list, enter returns the
highlighted option; golden test for the checkmark/selection styles.

**Shipped:** `Select` in `@tern/core` renders the filter row (dimmed
`filter…` placeholder while empty), one option row per visible option (the
highlighted row reversed, multi-mode rows `✓ `/`  `-prefixed), and in multi
mode a selected-count summary row — driven by `selectKey` (`up` / `down` /
`enter` / `escape`, typeahead filter, space toggles checkmarks).
`<Select>` in `@tern/react` and `Select` in `@tern/solid` materialize it; a
`focusId` (React) or `useFocus` (Solid) registers it with the `FocusManager`
so routed keys drive it (`onChange` / `onConfirm` / `onDismiss` in React). A
`floating` dropdown stamps the root box's `z_index` prop so it paints above
in-flow content.

---

## ScrollView

**Purpose:** a scrollable clip/scroll region — long output (agent transcripts,
logs, file content) inside a bounded viewport, optionally with a track + thumb
scrollbar.

**Core problem:** scrolling must stay cheap: only the viewport is painted, the
offsets are scene props, and the content is never re-laid-out per scroll step.

**Design:**

- **Clip/scroll region** over the engine's scene region props: `clip_x` /
  `clip_y` / `clip_width` / `clip_height` and `scroll_x` / `scroll_y`.
- **Driven scrolling:** the core `scrollTo` / `scrollBy` / `scrollTop` helpers
  clamp offsets against `Node.contentSize()` (content vs viewport) and update
  the scene props — the compositor paints the pan.
- **Scrollbar:** an optional track (`░`) + thumb (`█`) text leaf, absolutely
  positioned at the region's right edge (paint z-order 1, above in-flow
  content).

**API sketch (JS):**

```tsx
<ScrollView width={40} height={10} clip_height={10} showScrollbar>
  <Text text={log} />
</ScrollView>
```

**Acceptance:** scrollTo/scrollBy clamp to the content bounds; the scrollbar
thumb tracks the scroll fraction; a streaming node auto-scrolls inside the
region.

**Shipped:** `ScrollView` in `@tern/core` (with `scrollTo` / `scrollBy` /
`scrollTop` and the `SCROLLBAR_THUMB_CHAR` / `SCROLLBAR_TRACK_CHAR`
constants), `<ScrollView>` in `@tern/react` (content is React children), and
`ScrollView` in `@tern/solid` (content via the `children` prop). The
`streaming_text` auto-scroll reuses the same clip/scroll machinery.

---

## Table

**Purpose:** render columnar data — file lists, symbol tables, model pickers,
or any structured result the agent presents alongside its free-text
transcript.

**Core problem:** columns must line up across rows with fixed per-column
widths and alignment, a pinned header must stay readable while the rows
scroll, and the selection row must stay visible — all over a cell-buffer
renderer with no native table node.

**Design:**

- **Sticky header.** A header row painted above the content region at paint
  z-order 1; `scroll_y` pans only the content region, so the header never
  scrolls away. `sticky_header: false` moves the header into the scrollable
  region.
- **Per-column cells.** One row leaf per data row; each cell padded to its
  column width (left/right/center), overflow truncated never mid-glyph. The
  highlighted row renders reversed.
- **Independent axes.** `scroll_x` on the root pans header + rows together
  (columns stay aligned); `clip_height` sets the content viewport.
- **Keyboard driving.** `tableKey` moves the highlight with up/down (clamped)
  and auto-scrolls the content region; `visibleTableRows` reads the visible
  window `rows[scroll_y, scroll_y + clip_height)`.

**API sketch (JS):**

```tsx
<Table
  columns={[
    { key: "name", header: "File", width: 24 },
    { key: "size", header: "Size", width: 8, align: "right" },
  ]}
  rows={[["main.rs", 4096], ["lib.rs", 2048]]}
  highlight={0}
  sticky_header
  clip_height={10}
/>
```

**Acceptance:** golden test for per-column alignment and truncation; a key
sequence moves the highlight and auto-scrolls the region (buffer matches).

**Shipped:** `Table` in `@tern/core` builds the flex column — a sticky header
row (paint z-order 1) above a scrollable content region, and one row leaf per
visible data row: only the visible window `rows[scroll_y, scroll_y +
clip_height)` is materialized (**windowed rows** — a large dataset does not
create one scene node per row; the full dataset stays JS bookkeeping in
`tableRegionStates`, and the scroll clamp measures the full content height).
Per-column width/alignment (padded cells, overflow truncated never mid-glyph;
the highlighted row reversed). `tableKey` (up/down move the highlight and
auto-scroll, clamped to the content bounds) and `visibleTableRows` (the
visible window) drive it; `scroll_x` pans header + rows together, `scroll_y`
pans only the content region, and `clip_height` sets the viewport. `<Table>`
in `@tern/react` and `Table` in `@tern/solid` materialize the same factory.

---

## Textarea

**Purpose:** multi-line text entry — composing agent messages, editing tool
input, or any free-form field taller than one line.

**Core problem:** a multi-line caret model (rows × columns), soft wrapping of
long lines, and vertical scroll-to-caret are all stateful interactions
layered on a paint-on-demand renderer.

**Design:**

- **Edit model on the node.** `lines` / `row` / `col` / `scroll` stay on the
  node as JS bookkeeping (the source of truth for `editTextareaKey`) and
  never reach the scene props.
- **Soft wrap.** `width` wraps long lines into display rows (token-aware,
  mirroring the Rust `wrap_line`); one text leaf is composed per visible
  display row, the caret's leaf carrying its display column.
- **Visible window.** `height` sets the window in display rows with vertical
  scroll-to-caret; `scroll` is the top visible display row.
- **Editing keys.** `enter` splits the line at the cursor; insert /
  backspace / delete (joining adjacent lines at the boundaries); `left` /
  `right` / `home` / `end`; `up` / `down` move across the soft-wrapped
  display lines, preserving a preferred column across a run of vertical
  moves.

**API sketch (JS):**

```tsx
<Textarea
  lines={["fn main() {", "  println!(\"hi\");", "}"]}
  row={1}
  col={4}
  width={40}
  height={10}
  focusId="composer"
  onChange={setDraft}
  onSubmit={send}
/>
```

**Acceptance:** golden test for soft wrap and the caret column; interaction
test for editing, line splits, and vertical moves across wrapped lines.

**Shipped:** `Textarea` in `@tern/core` builds a framed box with one text
leaf per visible display row, soft-wrapped at `width` and vertically scrolled
to keep the caret visible within `height`; `editTextareaKey` applies the
editing keys (char insert, backspace/delete with line joins, left/right/
home/end, `enter` splits, up/down across display lines preserving a preferred
column) and returns the new `{ lines, row, col }`. `<Textarea>` in
`@tern/react` adds `focusId` / `focusManager` / `onChange` / `onSubmit`
(focus registration plus callbacks); `Textarea` in `@tern/solid` mirrors the
same focus wiring — a `focusId` prop registers the node with a `FocusManager`
(routed keys edit it via `editTextareaKey`), firing `onChange` / `onSubmit`,
with the registration disposed via `disposeTextareaFocus` (feature parity
with the React host component). Routed paste (via `usePaste` /
`subscribePaste`) auto-pastes into a focused textarea through the core
`pasteIntoTextarea` — a pasted `\n` splits into new logical lines, firing
`onChange`.

---

## Modal

**Purpose:** overlay dialogs — confirmations, blocking prompts, or any
transient surface that dims the workspace and takes over input.

**Core problem:** an overlay must paint above in-flow content, dim what is
beneath, center its content, and isolate keyboard focus while open — then
hand focus back where it was when it closes.

**Design:**

- **Full-bleed overlay.** An absolutely positioned root box inset to its
  parent's padding box, stamped with a high `z_index` (`MODAL_Z_INDEX` = 100)
  so it paints above in-flow content.
- **Backdrop + content.** A dimmed backdrop box (`MODAL_BACKDROP_BG`,
  `backdrop: false` to omit) plus a centered content box wrapping the content
  nodes.
- **Visibility as state.** `open` starts `false` — the overlay is hidden
  (`hidden` modifier + `display: none`); `openModal` / `closeModal` toggle it.
- **Focus isolation.** `openModal` records the active focus id and moves
  focus into the overlay (`focusFirst`); `closeModal` restores the recorded
  id, or blurs when nothing was recorded.

**API sketch (JS):**

```tsx
const modal = Modal({ content: [
  Text({ text: "Apply this edit?" }),
  Input({ placeholder: "y/n" }),
] });
openModal(modal);   // dims the scene, focuses the first registered focusable
closeModal(modal);  // restores the previously active focus
```

**Acceptance:** the overlay paints above in-flow content with the backdrop
dim; opening moves focus into the overlay and closing restores the previously
active focus.

**Shipped:** `Modal` in `@tern/core` composes the overlay — an absolutely
positioned root box (inset to the parent) stamped with `MODAL_Z_INDEX` (100),
a dimmed backdrop box (`MODAL_BACKDROP_BG`), and a centered content box
wrapping the content nodes (the `content` prop or rest-arg children).
`openModal` / `closeModal` toggle visibility (`hidden` + `display`) and move
focus through the `FocusManager` — `focusFirst` on open, restoring the
recorded id (or blurring) on close. `<Modal>` in `@tern/react` takes the
content as a `content` prop (no React children); `Modal` in `@tern/solid` is
the plain factory.

---

## Tabs

**Purpose:** switch between panels of related content — log files, open-file
tabs, tool outputs — where one tab is active and its content occupies the
region below the tab bar.

**Core problem:** a tab bar must read as a bar (active tab visually distinct),
the active tab's content must swap in/out without leaking the other tabs'
content into the scene, and keyboard navigation (arrow keys, ctrl+tab,
ctrl+w close) must drive the active index — all over a cell-buffer renderer
with no native tabs node.

**Design:**

- **Bar + region.** A flex column of two boxes: a tab bar row (one `Text`
  leaf per tab) above a content region box (a flex column) holding the
  *active* tab's content nodes. Only the active tab's content is
  materialized — the other tabs' content stays out of the scene tree.
- **Active-tab styling.** The active tab's label is prefixed with a top-border
  marker (`TAB_ACTIVE_MARKER` ▔) and painted with the theme's `primary`
  palette colors and reversed (`TAB_PRIMARY_FG` / `TAB_PRIMARY_BG`); inactive
  tabs are plain.
- **Close affordance.** A per-tab `closable` flag (falling back to the
  element's `closable` default) appends a close glyph (`TAB_CLOSE_CHAR` ×) to
  the tab's label.
- **JS bookkeeping.** The tab list is JS bookkeeping (never scene props,
  mirroring `Panels`' `panels` / `Table`'s `rows`); the interactive state
  (`active`) lives on the root box's props. `activateTab` / `closeTab` /
  `tabsKey` mutate it and rebuild the composition in place.
- **Keyboard driving.** `tabsKey` routes keys: `left` / `right` move the
  active tab (clamped at the ends); `ctrl+tab` / `ctrl+shift+tab` wrap to the
  next / previous tab; `ctrl+w` closes the active tab (the active index
  re-clamps into the shorter list). `<Tabs focusId>` in `@tern/react` /
  `Tabs({ focusId })` in `@tern/solid` register with a `FocusManager` so
  routed keys reach the node.

**API sketch (JS):**

```tsx
const tabs = Tabs({
  tabs: [
    { label: "logs", content: [Text({ text: "log line" })] },
    { label: "files", content: [Text({ text: "file list" })] },
    { label: "git", content: [Text({ text: "git status" })], closable: true },
  ],
  active: 0,
  closable: true,
});
activateTab(tabs, 1);                 // swap the content region to "files"
tabsKey(tabs, { name: "right" });     // move the active tab right (clamped)
tabsKey(tabs, { name: "w", ctrl: true }); // close the active tab
```

**Acceptance:** the active tab renders distinct (primary + reversed + top
marker), the content region holds exactly the active tab's content, and a key
sequence (arrows / ctrl+tab / ctrl+w) moves the active index and re-clamps it
after a close (buffer matches).

**Shipped:** `Tabs` in `@tern/core` builds the flex column — a tab bar row
(one `Text` leaf per tab; the active tab's label prefixed with the top-border
marker `TAB_ACTIVE_MARKER` and painted with the primary palette colors
`TAB_PRIMARY_FG` / `TAB_PRIMARY_BG` and reversed, closable tabs carrying the
`TAB_CLOSE_CHAR` close glyph) plus a content region box holding the active
tab's content nodes. The tab list is JS bookkeeping (`tabSpecs`, never scene
props); `active` lives on the root box's props, and `activateTab` /
`closeTab` / `tabsKey` mutate it and rebuild the composition in place
(`left` / `right` move the active tab clamped, `ctrl+tab` / `ctrl+shift+tab`
wrap around the ends, `ctrl+w` closes the active tab re-clamping the active
index). `<Tabs>` in `@tern/react` takes the tabs as a `tabs` prop (no React
children); `Tabs` in `@tern/solid` is the same factory with a `focusId`
option — both register with a `FocusManager` so routed keys drive the tabs.

---

## Progress

**Purpose:** show a determinate fill ratio at a glance — download / upload
progress, token budgets, batch completion — as a framed gauge (ratatui
`Gauge` parity).

**Core problem:** a gauge must paint a fill whose cell count is an exact
function of the ratio and the bar's inner width, while carrying an optional
label and a percentage readout — over a cell-buffer renderer with no native
gauge node, and without rebuilding the composition on every value change.

**Design:**

- **Framed fill.** The `progress` element is a framed box (the frame defaults
  to `border_style: "plain"`; `border_style: "none"` opts out) holding one
  in-flow fill leaf: exactly `ceil(value/max * inner_width)` `'▓'` cells
  followed by `'░'` for the rest of the inner width (the outer `width` prop —
  default `PROGRESS_DEFAULT_WIDTH` 20 — minus the frame's 2 border columns).
- **Label + readout overlays.** The optional label is a dimmed text leaf
  absolutely positioned at the inner area's left edge; the percentage readout
  (`ceil(value/max*100)%`) is an absolutely positioned leaf at the right
  edge, both at a `z_index` above the fill — mirroring ratatui, where the
  label/percentage replace the fill glyphs in their cells, so the fill-cell
  math stays exact regardless of them. The label is composed only when it
  fits alongside the readout (which reserves its widest form `"100%"`, so
  label presence never flips as the value changes).
- **Ratio shortcut.** A `ratio` prop (0..1) drives the bar directly as an
  alternative to `value`/`max` (defaults 0/100, clamped into [0, 1]).
- **Live updates without rebuilding.** The bar model (`value`/`max`/`ratio`)
  lives on the root box's props; `setProgress(node, value, max?)` mutates it
  and repaints the fill and readout leaves in place — no rebuild, so a
  streaming progress bar stays cheap.
- **JS bookkeeping.** The label text and the `show_percentage` flag are
  consumed by the factory (never scene props, mirroring `Tabs`' `tabSpecs`);
  the `progress` component preset is part of `THEME_COMPONENTS` /
  `defaultTheme`.

**API sketch (JS):**

```tsx
const progress = Progress({ value: 5, max: 10, label: "copying" });
setProgress(progress, 8);              // repaint the live bar in place
const half = Progress({ ratio: 0.5, show_percentage: false });
```

**Acceptance:** the fill leaf holds exactly `ceil(value/max * inner_width)`
filled cells, the percentage readout reads `ceil(value/max*100)%` (right
aligned), the label is composed only when it fits, and `setProgress` repaints
the bar without rebuilding the composition (buffer matches).

**Shipped:** `Progress` in `@tern/core` builds the framed box — an in-flow
fill leaf (`'▓'` × `ceil(value/max * inner_width)`, `'░'` for the rest of the
inner width) plus an optional dimmed label leaf left-aligned inside the bar
area (composed only when it fits alongside the readout) and an optional
percentage readout (`ceil(value/max*100)%`) right-aligned inside it, both
absolutely positioned overlays on the fill (the fill-cell math stays exact).
The label text and `show_percentage` flag are JS bookkeeping (never scene
props); `value`/`max` (or `ratio`) live on the root box's props, and
`setProgress` mutates them and repaints the bar and readout in place — no
rebuild. `<Progress>` in `@tern/react` and `Progress` in `@tern/solid`
materialize the factory with the `progress` component preset resolved onto
the frame's props.

---

## Theme system & soft wrap

**Theme system (shipped):** the core theme surface — `defaultTheme`,
`mergeTheme(base, overrides)`, `resolveTheme(theme, props)` — resolves the
semantic `role` / `component` hints on node props into plain `fg` / `bg` /
`border_style` style keys at element-creation time (the hints are consumed and
never reach the scene; explicit props always win). `@tern/react` provides
`<ThemeProvider>` + `useTheme`; `@tern/solid` provides `setTheme` / `getTheme`
(module-level, merged over `defaultTheme`).

**Soft wrap (shipped):** the `wrap` prop passes through to each content leaf
of `DiffView` and is accepted on `StreamingText` for API stability — the
compositor soft-wraps at the node width.
