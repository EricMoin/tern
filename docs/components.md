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
completeness pass has since landed the **Rust renderable half** of the
[Input](#input), [Spinner](#spinner), [Panels / split layouts](#panels--split-layouts),
and [StatusBar](#statusbar) components in `src/core/tern-components` (state,
interaction, and paint are unit- and golden-tested), and the **JS elements and
renderer wiring** now ship too: element factories in `@tern/core`, host
components/factories in `@tern/react` and `@tern/solid`, focus/key routing via
the core `FocusManager`, and spinner timer redraw. The components below layer
richer behavior on top of that foundation.

## Event model

Terminal events reach the scene through `@tern/core`'s `Renderer`:
`pollEvents()` blocks up to a timeout for native input and returns the tagged
`TernEventJs` union (`"key"` / `"resize"` / `"focus"` / `"mouse"`), feeding the
`onKey` / `onResize` / `onFocus` / `onMouse` handlers the renderer exposes:

- `onKey(event)` — a `KeyEvent` (key name plus optional `char` / modifiers).
- `onResize({ width, height })` — the new terminal size.
- `onFocus({ focus_gained })` — `true` on focus gained, `false` on lost.
- `onMouse(event)` — a `MouseEventJs` payload.

Key routing goes through the core `FocusManager`: elements register with
`useFocus(id, node, onKey)` and the manager dispatches each key to the focused
element's handler (`routeKey`). The tree-level input hooks consult the manager
first — `useInput` in `@tern/react` and `subscribeInput` in `@tern/solid`
route each key through the core `FocusManager` before falling back to the tree
handler.

## Status legend

| Status | Meaning |
|--------|---------|
| ✅ MVP | Ships in the first runnable milestone |
| ✅ Shipped | JS element + renderer wiring complete |
| 🔜 Soon | Next after MVP; small, well-understood |
| 🧭 Later | Needs a prerequisite phase (see [roadmap.md](roadmap.md)) |

| Component | Status | Needs |
|-----------|--------|-------|
| [StreamingText](#streamingtext) | 🔜 Soon | incremental span feed |
| [MarkdownView](#markdownview) | 🧭 Later | tree-sitter highlighting |
| [DiffView](#diffview) | 🔜 Soon | — |
| [Input](#input) | ✅ Shipped | — |
| [Spinner](#spinner) | ✅ Shipped | focus-aware tick pause → [roadmap Phase 2](roadmap.md#phase-2--resize-focus--mouse-events) |
| [Panels / split layouts](#panels--split-layouts) | ✅ Shipped | mouse drag-resize handles → [roadmap Phase 2](roadmap.md#phase-2--resize-focus--mouse-events) |
| [StatusBar](#statusbar) | ✅ Shipped | reserved viewport row |
| [Select](#select) | 🧭 Later | — |

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
- **Syntax highlighting** inside code fences via tree-sitter (Phase 4 in
  [roadmap.md](roadmap.md)); before that lands, fences render with a single
  fence style and no token colors.
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
`onChange` / `onSubmit` fire on edits and Enter.

---

## Spinner

**Purpose:** show activity — indeterminate "working…" (agent thinking) and
determinate progress (tool execution, file upload, token budget).

**Core problem:** animation needs a *periodic redraw* on top of a
paint-on-demand pipeline. The JS side now provides it — `<Spinner>` in
`@tern/react` runs a tick interval while mounted (see the Rust renderable note
below); pausing the tick while the terminal is unfocused is roadmap Phase 2.

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
`focusPanel`. Mouse drag-resize handles are still tracked in
[roadmap.md](roadmap.md) Phase 2.

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
are the left/center/right segment `Text` nodes. The reserved viewport row
(the compositor subtracting the bottom row before laying out panels, see
**Design** above) does not ship yet — a `StatusBar` is currently laid out as
an ordinary node in the scene.

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
