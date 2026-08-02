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
interaction, and paint are unit- and golden-tested); their **JS elements** and
renderer wiring (timer redraw, focus/key routing) remain. The components below
layer richer behavior on top of that foundation.

## Status legend

| Status | Meaning |
|--------|---------|
| ✅ MVP | Ships in the first runnable milestone |
| 🔜 Soon | Next after MVP; small, well-understood |
| 🔜 Soon · Rust ✅ | The tern-components renderable half ships; the JS element / renderer wiring is pending |
| 🧭 Later | Needs a prerequisite phase (see [roadmap.md](roadmap.md)) |

| Component | Status | Needs |
|-----------|--------|-------|
| [StreamingText](#streamingtext) | 🔜 Soon | incremental span feed |
| [MarkdownView](#markdownview) | 🧭 Later | tree-sitter highlighting |
| [DiffView](#diffview) | 🔜 Soon | — |
| [Input](#input) | 🔜 Soon · Rust ✅ | JS element + focus/key routing |
| [Spinner](#spinner) | 🔜 Soon · Rust ✅ | JS element + timer-driven redraw |
| [Panels / split layouts](#panels--split-layouts) | 🔜 Soon · Rust ✅ | resize handles + JS element |
| [StatusBar](#statusbar) | 🔜 Soon · Rust ✅ | JS element + reserved viewport row |
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
- **Syntax highlighting** inside code fences via tree-sitter (Phase 3 in
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
with a `caret`-prop text leaf the compositor paints as a block caret. JS
element and focus/key routing are pending.

---

## Spinner

**Purpose:** show activity — indeterminate "working…" (agent thinking) and
determinate progress (tool execution, file upload, token budget).

**Core problem:** animation needs a *periodic redraw* that the MVP
paint-on-demand pipeline does not provide yet (see the timer/event note below).

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
determinate bar via `filled_cells()`/`bar()`. JS element and the timer wiring
are pending.

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
`expand` hide the body and an `active` index tracks focus. Resize handles and
the JS element are pending.

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
(rightmost-first on ties) against a row width; it materializes as a
`space-between` strip. JS element and the reserved-viewport-row wiring are
pending.

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
