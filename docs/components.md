# tern Component Roadmap (code agent)

This document is the roadmap for the tern widget library, targeted at the
primary use case: **terminal UI for code agents** (Claude Code / opencode-style
CLI assistants). It covers the components the MVP does *not* ship, in rough
implementation order, one section per component.

## How components map onto the pipeline

The render pipeline is described in [architecture.md](architecture.md). A
component lives in two places:

- **JS element** — declarative, reconciler-managed (e.g. `<StreamingText/>`
  under `@tern-tui/react` / `@tern-tui/solid`). Produces a scene update.
- **Rust renderable** — the painting/behavior half in
  `src/core/tern-components` (the `Renderable` / `Text` / `Box` pattern).

The MVP ships the core `Text` / `Box` renderables plus the compositor. A
completeness pass has since landed the full roadmap element set — **the Rust
renderable half** of [Input](#input), [Spinner](#spinner),
[Panels / split layouts](#panels--split-layouts), and [StatusBar](#statusbar)
in `src/core/tern-components` (state, interaction, and paint are unit- and
golden-tested), plus the **JS elements and renderer wiring** for every
component below: element factories in `@tern-tui/core`, host
components/factories in `@tern-tui/react` and `@tern-tui/solid`, focus/key routing via
the core `FocusManager`, spinner timer redraw, the theme system, soft wrap,
and the Phase 2 event consumers (resize reflow, panel drag-resize,
focus-aware redraw, mouse wheel scroll, click-to-focus). The status table
below is current — the shipped rows reflect what runs today.

## Event model

Terminal events reach the scene through `@tern-tui/core`'s `Renderer`:
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

Mouse capture is **tiered** (M1.3): press/release, drag, and scroll tracking
(`?1000h`/`?1002h`/`?1015h`/`?1006h`) are enabled by default; **any-event
motion tracking (`?1003h`) is off by default** — the listener count on the
core `onMouse` drives it: the first subscribe enables `?1003h` through the
native `set_any_event_mouse`, the last unsubscribe disables it (`?1003l`),
and a re-subscribe (1→1) never re-toggles. Byte-level asserted: the default
enable sequence contains no `?1003h`, and `index_test.ts` asserts the count
transitions (0→1 toggles once, 1→0 toggles off, 1→1 does not re-toggle).
Teardown closes `?1003l` before the general event-listening disable.

**Interactive capability probing** (M1.1) ships in the same layer:
`renderer.capabilities` returns the color report (`truecolor`, `colors`)
merged with the interactive probe result (`terminalIdentity`,
`kittyKeyboard`, `kittyUnderline`, `osc52`, `bracketedPaste`,
`focusEvents`, `probed`) — five queries (DA1/DA2/DA3/XTVERSION/XTGETTCAP)
are sent once per process with a 300 ms budget (60 ms per query), and the
result is cached. A non-TTY or `TERM=dumb` environment skips the probe and
reports conservative defaults with `probed: false`. The probe gates what is
enabled on the wire: the kitty keyboard enhancement push (M1.2) happens
only when `kittyKeyboard` is reported, focus-change (`?1004h`) and
bracketed paste (`?2004h`) only when the probe reports `focusEvents` /
`bracketedPaste` (M1.5) — an unsupported terminal simply never enables the
sequence. Signal-safe lifecycle (M1.4) rides the same event channel:
`onLifecycle({ phase })` receives `"suspend"` (terminal restored, about to
stop) and `"resume"` (raw mode + alt screen re-entered, screen invalidated
— the app must re-render).

Key and paste routing go through the core `FocusManager`: elements register
with `useFocus(id, node, onKey, manager?, onPaste?)` and the manager
dispatches each key to the focused element's handler (`routeKey`) and each
paste to its paste handler (`routePaste` — an element that registered no
`onPaste` never consumes, so the paste falls through to the tree handler).
The tree-level input hooks consult the manager first — `useInput` in
`@tern-tui/react` and `subscribeInput` in `@tern-tui/solid` route each key through
the core `FocusManager` before falling back to the tree handler.

### IME posture (decision)

**Composition/preedit stays with the terminal emulator** — tern deliberately
does not surface IME composition/preedit events: crossterm 0.29's `Event`
enum carries no composition variant (only focus / key / mouse / paste /
resize), and the emulator owns preedit rendering anyway. A confirmed IME
composition reaches the app as a bracket-pasted string and flows through the
`Paste` event → `FocusManager.routePaste` → `pasteInto` / `pasteIntoTextarea`
path above — multi-codepoint CJK/IME-confirmed strings (pre-composed and
decomposed) are regression-tested to round-trip losslessly into a focused
`Input` and `Textarea`. Full rationale: IME composition stays a non-goal (see the
Input/Textarea design notes in this document).

## Status legend

| Status | Meaning |
|--------|---------|
| ✅ MVP | Ships in the first runnable milestone |
| ✅ Shipped | JS element + renderer wiring complete |
| 🔜 Soon | Next after MVP; small, well-understood |
| 🧭 Later | Needs a prerequisite phase |

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
| [Selection](#selection) | ✅ Shipped | — |
| [Theme system](#theme-system--soft-wrap) | ✅ Shipped | — |
| [Soft wrap (`wrap` prop)](#theme-system--soft-wrap) | ✅ Shipped | — |
| [Terminal capabilities](#event-model) | ✅ Shipped | — (interactive probe M1.1 + tiered mouse M1.3 + signal lifecycle M1.4) |
| [Checkbox / Radio / Toggle](#checkbox--radio--toggle) | ✅ Shipped | — |
| [Menu](#menu) | ✅ Shipped | — |
| [HelpPanel](#helppanel) | ✅ Shipped | — |
| [Semantics (a11y metadata)](#semantics) | ✅ Shipped | — (default-off store; terminal a11y emission M4.2) |

---

## Box

**Purpose:** the container primitive — background fill, optional border ring,
padding, and flex layout for its children (see [architecture.md](architecture.md)
for the paint pipeline).

**Border styling.** A box's border is enabled with the `border_style` key
(`"none" | "plain" | "rounded" | "double" | "thick"`); its glyphs are chosen
from the matching box-drawing set by the compositor (`border_glyphs` in
`tern-components`). The border color is controlled independently of the box's
`fg`/`bg`:

- **`borderColor`** (camelCase alias — `@tern-tui/core` / `@tern-tui/react` /
  `@tern-tui/solid`) → **`border_color`** (the binding's style key, snake_case) —
  a color string (`#rrggbb`, `indexed:N`, or `default`).
- When set, the border ring paints with that color as its foreground (the
  glyphs themselves are unchanged); every other cell keeps its own style. When
  unset, the border paints with the node's `fg` exactly as before — the key is
  additive and opt-in, so existing scenes paint byte-identically.

```ts
Box({ border_style: "rounded", borderColor: "#ff0000", padding: 1 }, Text({ text: "Hi" }))
```

In a styled snapshot (`Renderer.snapshotStyled`), a colored border surfaces as
its own run carrying the border color in `fg` — split from the default-styled
blanks — so `styledFramesEqual` golden comparisons can assert it.

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
in `@tern-tui/core` builds the node (fed via `Node.appendSpan`); `<StreamingText>`
in `@tern-tui/react` consumes the `stream` prop with an effect that appends each
span, paints after every append, and feeds the auto-scroll; `StreamingText` +
`subscribeStream` in `@tern-tui/solid` do the same. Auto-scroll ships as the core
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
  fences, paragraphs, **tables** (a pipe table renders as a local `Table`
  node — one column header row + one row leaf per body row, aligned with
  the existing per-column padding) and **task lists** (a `[x]` / `[ ]`
  checkbox glyph prefix on list items).
- **Inline styles:** `**bold**`, `` `code` ``, `*italic*`, and
  `[links](url)` — a link paints as an **OSC 8 clickable hyperlink**
  (`href` style key → the engine's `Style::hyperlink`, surfaced on
  `StyleRunJs.hyperlink`), so a terminal with OSC 8 support makes the link
  clickable; the label renders as before.
- **Syntax highlighting** inside code fences via tree-sitter (roadmap
  Phase 4 — shipped; M3.7): the `tern-highlight` crate maps tree-sitter
  captures to style spans (keywords, strings, comments, types) over the
  whole fence; `@tern-tui/core`'s `highlightCode` feeds them into the
  fence's leaves (a fence with a recognized language renders one styled
  leaf per line with token colors, falling back to the single fence style
  for unknown languages or when the native addon is unavailable).
  `tern-highlight` now ships **12 grammars** — Rust, TypeScript, TSX,
  JavaScript, JSON, shell, plus the M3.7 expansion Python, Go, TOML, YAML,
  C and C++ — each with its own highlight query (aliases like `rs`, `ts`,
  `jsx`, `sh`, `py`, `golang`, `yml`, `c++` map to the same grammar).
  **Markdown is deliberately not among them:** the only published
  `tree-sitter-markdown` crate pins tree-sitter 0.19 and ships no
  highlight query, so it cannot join the 0.26 runtime — deferred until a
  usable crate exists.
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

**Shipped:** `MarkdownView` in `@tern-tui/core` builds the `markdown` element — a
flex column of block nodes rendering the `source` (headings bold, H1
underlined; paragraphs; bulleted/ordered lists; dimmed block quotes; `─`
horizontal rules; pipe **tables** as a local `Table` node — header row +
one row leaf per body row, per-column padded; **task lists** with `[x]` /
`[ ]` glyph prefixes; and code fences as a `bg` box with one leaf per line,
tree-sitter-highlighted for the 12 recognized languages) with `**bold**` /
`*italic*` / `` `code` `` / `[links](url)` inline styles parsed into
per-span `Text` leaves — a link stamps the engine's OSC 8 `href` style so
supporting terminals paint it clickable. Parsing is best-effort and
streaming-friendly: a half-open code fence renders its collected lines as
the fenced block, and an unclosed inline marker styles the rest of its
line. The `source` key is consumed (JS bookkeeping — never a scene prop);
the `width` prop soft-wraps plain lines. No new napi node kind: the
`markdown` element materializes as a `box` (constitution).

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

**Shipped:** `DiffView` in `@tern-tui/core` renders the unified-diff rows — a
dimmed gutter with right-aligned old/new line numbers, `+`/`-`/` ` markers,
and per-kind colors (adds `#98c379`, dels `#e06c75`, context dimmed) — with
`scroll_x` / `scroll_y` panning the whole region and the `wrap` prop passing
through to each content leaf. Side-by-side mode ships: `mode="side"` renders
two aligned columns (old | new) split by a 1-cell gap (mirroring `Panels`),
each hunk line one row per column aligned by line pair, with per-column
gutters. Intra-line highlighting ships too: `inline_highlight` computes a
char-level diff on each adjacent add/del pair and renders the changed
segments bold + underlined on the line's kind color, leaving unchanged
characters plain. `<DiffView>` in `@tern-tui/react` and `DiffView` in
`@tern-tui/solid` materialize the same factory.

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
  jumps (option-arrow), selection + clipboard paste, and confirmed-IME input
  via bracketed paste. IME composition/preedit itself stays with the terminal
  emulator — the IME-posture decision: crossterm surfaces no preedit events
  and the emulator owns the
  composing overlay; a confirmed composition arrives as a `Paste` event).
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
element (`Input` in `@tern-tui/core`; `<Input>` in `@tern-tui/react`, `Input` in
`@tern-tui/solid`) adds focus/key routing: a `focusId` registers with the core
`FocusManager` (`useFocus`), routed keys edit the value via `editKey`, and
`onChange` / `onSubmit` fire on edits and Enter. Routed paste (via `usePaste`
in `@tern-tui/react` / `subscribePaste` in `@tern-tui/solid`) auto-pastes into a
focused `<Input focusId>` through the core `pasteInto` — inserting at the
caret, multi-width aware, and firing `onChange` (an empty paste is a no-op).
IME-confirmed CJK/IME strings round-trip losslessly through this paste path
(cluster-safe insert, pre-composed and decomposed forms — see the
[IME posture](#ime-posture-decision) note above).

---

## Spinner

**Purpose:** show activity — indeterminate "working…" (agent thinking) and
determinate progress (tool execution, file upload, token budget).

**Core problem:** animation needs a *periodic redraw* on top of a
paint-on-demand pipeline. The JS side provides it — `<Spinner>` in
`@tern-tui/react` runs a tick interval while mounted (see the Rust renderable note
below), and the tick pauses while the terminal is unfocused (focus-aware
redraw — shipped).

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
`@tern-tui/core`; `<Spinner>` in `@tern-tui/react`, `Spinner` in `@tern-tui/solid`) adds
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
(`Panels` in `@tern-tui/core`; `<Panels>` in `@tern-tui/react`, `Panels` in
`@tern-tui/solid`) exposes `collapsePanel` / `expandPanel` / `togglePanel` /
`focusPanel`. Mouse drag-resize ships as `startPanelDrag` / `dragPanels` /
`endPanelDrag` in `@tern-tui/core`, wired by `usePanelMouseDrag` (`@tern-tui/react`)
and `subscribePanelDrag` (`@tern-tui/solid`); the flex-basis reflow of a drag
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
`@tern-tui/core`; `<StatusBar>` in `@tern-tui/react`, `StatusBar` in `@tern-tui/solid`)
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

**Shipped:** `Select` in `@tern-tui/core` renders the filter row (dimmed
`filter…` placeholder while empty), one option row per visible option (the
highlighted row reversed, multi-mode rows `✓ `/`  `-prefixed), and in multi
mode a selected-count summary row — driven by `selectKey` (`up` / `down` /
`enter` / `escape`, typeahead filter, space toggles checkmarks).
`<Select>` in `@tern-tui/react` and `Select` in `@tern-tui/solid` materialize it; a
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

**Shipped:** `ScrollView` in `@tern-tui/core` (with `scrollTo` / `scrollBy` /
`scrollTop` and the `SCROLLBAR_THUMB_CHAR` / `SCROLLBAR_TRACK_CHAR`
constants), `<ScrollView>` in `@tern-tui/react` (content is React children), and
`ScrollView` in `@tern-tui/solid` (content via the `children` prop). The
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

**Shipped:** `Table` in `@tern-tui/core` builds the flex column — a sticky header
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
in `@tern-tui/react` and `Table` in `@tern-tui/solid` materialize the same factory.

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

**Shipped:** `Textarea` in `@tern-tui/core` builds a framed box with one text
leaf per visible display row, soft-wrapped at `width` and vertically scrolled
to keep the caret visible within `height`; `editTextareaKey` applies the
editing keys (char insert, backspace/delete with line joins, left/right/
home/end, `enter` splits, up/down across display lines preserving a preferred
column) and returns the new `{ lines, row, col }`. `<Textarea>` in
`@tern-tui/react` adds `focusId` / `focusManager` / `onChange` / `onSubmit`
(focus registration plus callbacks); `Textarea` in `@tern-tui/solid` mirrors the
same focus wiring — a `focusId` prop registers the node with a `FocusManager`
(routed keys edit it via `editTextareaKey`), firing `onChange` / `onSubmit`,
with the registration disposed via `disposeTextareaFocus` (feature parity
with the React host component). Routed paste (via `usePaste` /
`subscribePaste`) auto-pastes into a focused textarea through the core
`pasteIntoTextarea` — a pasted `\n` splits into new logical lines, firing
`onChange`. IME-confirmed multi-codepoint CJK/IME strings round-trip
losslessly through this path too, including multi-line and decomposed forms
(see the [IME posture](#ime-posture-decision) note above).

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

**Shipped:** `Modal` in `@tern-tui/core` composes the overlay — an absolutely
positioned root box (inset to the parent) stamped with `MODAL_Z_INDEX` (100),
a dimmed backdrop box (`MODAL_BACKDROP_BG`), and a centered content box
wrapping the content nodes (the `content` prop or rest-arg children).
`openModal` / `closeModal` toggle visibility (`hidden` + `display`) and move
focus through the `FocusManager` — `focusFirst` on open, restoring the
recorded id (or blurring) on close. `<Modal>` in `@tern-tui/react` takes the
content as a `content` prop (no React children); `Modal` in `@tern-tui/solid` is
the plain factory.

---

## Selection

**Purpose:** select and copy text from the rendered scene with the mouse —
the terminal-native way to grab a command, an error line, or a log excerpt
without editing.

**Core problem:** there is no DOM to select from — the scene is a
cell-buffer, so selection must live in the renderer's paint state (a
reversed-cell overlay) and its text must be reconstructed from the painted
frame, not from a document model.

**Design:**

- **Native overlay.** The selection is per-renderer state on the native
  compositor: `Renderer.setSelection(col1, row1, col2, row2)` paints the
  inclusive cell rect reversed at the next `render()`; `clearSelection()`
  drops it. The overlay never touches the shared scene.
- **Text extraction.** `Renderer.selectionText()` reconstructs the selected
  text from the last painted frame — row-major, cluster/mask-aware (a wide
  glyph contributes its whole symbol, a masked continuation cell nothing),
  rows joined with `'\n'`. `selectionWordRange(col, row)` resolves the
  contiguous non-whitespace run (word) containing a cell for double-click
  select.
- **Interaction state machine.** The core helpers `startSelection` /
  `dragSelection` / `endSelection` are pure interaction math over the
  renderer's selection API: a `down_left` anchors a session (a second press
  on a nearby cell within `SELECTION_DOUBLE_CLICK_MS` ms — 500 — is a
  double-click and selects the word), each `drag_left` extends the rect, and
  any `up_*` release ends the session — the overlay persists after release
  (persistent selection): `Esc` or a bare click outside the selection rect
  clears it.
- **Clipboard.** `copySelection(renderer)` copies the active selection text
  to the system clipboard (OSC 52). The selection stays valid after release
  (the native side reads the last painted frame), so the copy may happen at
  any time after the gesture; `selectionKey` maps `ctrl+shift+c` to it
  (plain `ctrl+c` stays the app's exit convention).

**API sketch (JS):**

```tsx
// @tern-tui/react — one hook wires the whole gesture
useSelection();
```

```ts
// @tern-tui/solid — returns a disposer
const dispose = subscribeSelection(renderer);
```

**Acceptance:** a press-drag-release gesture paints the overlay and keeps it
up after release; `Esc` or a bare click outside the selection clears it; a
double-click selects the word under the pointer; `copySelection` /
`selectionText` stay valid after release and return the selected text; the
selection text extracts the exact painted cells (multi-row, cluster-aware);
`ctrl+shift+c` copies the active selection and plain `ctrl+c` is never
consumed.

**Shipped:** native selection overlay on the compositor (`set_selection` /
`clear_selection` / `selection_text` / `selection_word_range` on the
tern-node renderer, surfaced as `Renderer.setSelection` / `clearSelection` /
`selectionText` / `selectionWordRange`), the core interaction module
(`startSelection` / `dragSelection` / `endSelection` / `copySelection` /
`selectWordAt` / `selectionKey` / `SELECTION_DOUBLE_CLICK_MS`), and the host
wiring `useSelection` (`@tern-tui/react`) / `subscribeSelection` (`@tern-tui/solid`).
The overlay persists after `endSelection` — `Esc` or a bare click outside the
selection rect clears it, and `copySelection` / `selectionText` stay valid
against the last painted frame between gestures.

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
  re-clamps into the shorter list). `<Tabs focusId>` in `@tern-tui/react` /
  `Tabs({ focusId })` in `@tern-tui/solid` register with a `FocusManager` so
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

**Shipped:** `Tabs` in `@tern-tui/core` builds the flex column — a tab bar row
(one `Text` leaf per tab; the active tab's label prefixed with the top-border
marker `TAB_ACTIVE_MARKER` and painted with the primary palette colors
`TAB_PRIMARY_FG` / `TAB_PRIMARY_BG` and reversed, closable tabs carrying the
`TAB_CLOSE_CHAR` close glyph) plus a content region box holding the active
tab's content nodes. The tab list is JS bookkeeping (`tabSpecs`, never scene
props); `active` lives on the root box's props, and `activateTab` /
`closeTab` / `tabsKey` mutate it and rebuild the composition in place
(`left` / `right` move the active tab clamped, `ctrl+tab` / `ctrl+shift+tab`
wrap around the ends, `ctrl+w` closes the active tab re-clamping the active
index). `<Tabs>` in `@tern-tui/react` takes the tabs as a `tabs` prop (no React
children); `Tabs` in `@tern-tui/solid` is the same factory with a `focusId`
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

**Shipped:** `Progress` in `@tern-tui/core` builds the framed box — an in-flow
fill leaf (`'▓'` × `ceil(value/max * inner_width)`, `'░'` for the rest of the
inner width) plus an optional dimmed label leaf left-aligned inside the bar
area (composed only when it fits alongside the readout) and an optional
percentage readout (`ceil(value/max*100)%`) right-aligned inside it, both
absolutely positioned overlays on the fill (the fill-cell math stays exact).
The label text and `show_percentage` flag are JS bookkeeping (never scene
props); `value`/`max` (or `ratio`) live on the root box's props, and
`setProgress` mutates them and repaints the bar and readout in place — no
rebuild. `<Progress>` in `@tern-tui/react` and `Progress` in `@tern-tui/solid`
materialize the factory with the `progress` component preset resolved onto
the frame's props.

---

## Checkbox / Radio / Toggle

**Purpose:** form primitives — boolean toggles and single-choice lists for
tool-approval prompts, settings panels, model pickers, and yes/no gates in
agent UIs.

**Core problem:** a focused form control must paint its interactive state
distinctly (checked / on / selected), flip on a key press, and never leak
its model — the label or the option list is JS bookkeeping, the state lives
on the root box's props, and the theme drives the focused look.

**Design:**

- **Checkbox** — a `[x]` / `[ ]` glyph (`CHECKBOX_CHECKED_GLYPH` /
  `CHECKBOX_UNCHECKED_GLYPH`) plus the label in one text leaf; `checked` /
  `focused` live on the root box's props (the `checkbox` element
  materializes as a `box` — no new napi node kind).
- **Toggle** — an `●` / `○` glyph (`TOGGLE_ON_GLYPH` / `TOGGLE_OFF_GLYPH`)
  plus the label; `on` / `focused` on the root props (the `toggle` element,
  also a `box`).
- **Radio** — one row per option (the `radio` element, a flex column), the
  selected row `(•)`-prefixed (`RADIO_SELECTED_GLYPH`), the focused row
  painted with the theme's `primary` palette colors and reversed; a single
  `selected` index on the root props.
- **Keyboard driving.** `checkboxKey` / `toggleKey` map `space` / `enter`
  to the flip; `radioKey` moves the focus with `up` / `down` (clamped at
  the ends) and commits the selection with `space`.
- **Labels/options are JS bookkeeping** — never scene props, mirroring
  `Select`'s `options` / `Tabs`' `tabSpecs`.

**API sketch (JS):**

```ts
// Core factories (usable directly from @tern-tui/react / @tern-tui/solid
// scenes, like MarkdownView — no dedicated host tag).
const autoApply = Checkbox({ label: "Auto-apply", checked: true });
checkboxKey(autoApply, { name: "char", char: " " });   // flip

const wrap = Toggle({ label: "Soft wrap", on: true });
toggleKey(wrap, { name: "enter" });                    // flip

const lang = Radio({
  options: [{ value: "rust", label: "Rust" }, { value: "go" }],
  selected: 0,
});
radioKey(lang, { name: "down" });                      // move focus
radioKey(lang, { name: "char", char: " " });           // commit selection
```

**Acceptance:** golden buffer tests for the checked/on/selected glyphs and
the focused (primary + reversed) style; interaction tests: `space` /
`enter` flip the box and the toggle, radio arrows move the focus clamped at
the ends, `space` commits the selection.

**Shipped:** `Checkbox` / `Toggle` / `Radio` in `@tern-tui/core` compose the
glyph row(s) — one text leaf per row, the label / options consumed by the
factory — driven by `checkboxKey` / `toggleKey` / `radioKey`, with the
interactive state on the root box's props. Like `MarkdownView`, the three
are core factories usable directly from `@tern-tui/react` / `@tern-tui/solid`
scenes (no dedicated host tag). Composition + keyboard-interaction tests
land in `index_test.ts`, and the kitchen-sink demos render all three.

---

## Menu

**Purpose:** a popup menu of commands — action menus, "run with…" pickers,
nested submenus — as a floating overlay (or an inline list) driven by
keyboard and mouse.

**Core problem:** a menu overlays in-flow content (paint z-order), isolates
its focus while open, and must render a *hierarchical* item model — open
submenus add rows — without pushing the item model into the scene props.

**Design:**

- **Item model.** `items` is a recursive `MenuItem[]` — `label`, optional
  stable `id`, optional `children` (a non-empty `children` array is a
  submenu branch, an empty one a leaf). The model is JS bookkeeping (never
  scene props, mirroring `Tree`'s `nodes`).
- **Overlay.** `floating` stamps the root box's `z_index` prop so the menu
  paints above in-flow content (pass `MENU_Z_INDEX` = 100 for a full
  overlay); a closed menu is hidden (`hidden` + `display: none` — the
  Modal pattern), and `openMenu` / `closeMenu` toggle it.
- **Submenu rendering.** `submenu: "inline"` (default) renders open submenu
  items as indented rows within the menu column (tree-style); `"flyout"`
  renders each open submenu as its own overlay layer with its own
  `z_index`.
- **Keyboard driving.** `menuKey` moves the highlight (`up` / `down`,
  clamped to the visible rows), `right` opens the highlighted branch's
  submenu, `left` closes to the parent, `enter` activates a leaf (dismiss)
  or opens a branch, `escape` dismisses. `menuHover` / `menuClick` drive
  the mouse path.
- **Focus isolation.** `openMenu` records the active focus id and moves
  focus to the menu's first registered focusable; `closeMenu` restores the
  recorded id (or blurs) — the Modal pattern.

**API sketch (JS):**

```tsx
const menu = Menu({
  items: [
    { label: "Copy", id: "copy" },
    {
      label: "Insert",
      id: "insert",
      children: [{ label: "Code block", id: "code" }, { label: "Table", id: "table" }],
    },
  ],
  floating: true,
  z_index: MENU_Z_INDEX,
});
openMenu(menu);
menuKey(menu, { name: "down" });          // highlight the next visible item
menuKey(menu, { name: "enter" });         // activate a leaf / open a branch
```

**Acceptance:** golden buffer test: a floating menu paints above in-flow
content with the correct z-order and its open submenu rows indented; focus
isolation tests: `openMenu` moves focus into the menu, `closeMenu` restores
the previously-active focus (referencing the Modal/Select floating tests).

**Shipped:** `Menu` in `@tern-tui/core` builds the `menu` element — a flex
column of one leaf per *visible* item (the highlighted row reversed; open
inline submenus as indented rows, flyout submenus as overlay layers), the
item model and render mode consumed by the factory. `openMenu` / `closeMenu`
toggle visibility and move focus through the `FocusManager`; `menuKey` /
`menuHover` / `menuClick` drive it. `<Menu>` in `@tern-tui/react` and `Menu`
in `@tern-tui/solid` (with `disposeMenuFocus` / `subscribeMenuMouse`) wire
`focusId` + `onSelect` / `onDismiss` and the mouse path — the full
three-end alignment. Composition, floating z-order, submenu, focus
isolation, and key/mouse interaction tests land in `index_test.ts`, and the
kitchen-sink demos render a menu.

---

## HelpPanel

**Purpose:** a key-help overlay rendered from a `Keymap`'s registrations —
bubbletea `Help` parity for agent UIs that publish keyboard shortcuts.

**Core problem:** the overlay must derive its rows from the keymap's
described entries — the key hint right-aligned in a column as wide as the
widest hint, the description dimmed after a two-cell gap — and stay a plain
`box` composition (no new node kind).

**Design:**

- **Source of truth.** The panel renders the entries of a `Keymap`
  (defaulting to the module-level `keymap` consulted by every
  `FocusManager`); entries registered *without* a description are skipped
  (dispatch-only shortcuts, bubbletea's empty-desc skip).
- **Row shape.** One row per described entry: the combo hint rendered
  `mod1+mod2+key` (modifiers first — `ctrl+k`, `shift+enter`, `f1`),
  right-aligned in the widest-hint column, then the dimmed description with
  a two-cell `margin_left` gap.
- **Optional title.** A `title` renders as a plain bold row above the
  entries.
- **Consumed props.** `keymap` / `title` are consumed by the factory — the
  overlay is rendered at creation time, so they never reach the scene
  props; remaining props style the root box (the `help` component preset
  resolves onto it).

**API sketch (JS):**

```tsx
const km = new Keymap();
km.register({ name: "k", ctrl: true }, () => {}, "open command palette");
km.register({ name: "q", ctrl: true }, () => {}, "quit");
const help = HelpPanel({ keymap: km, title: "Keybindings" });
```

**Acceptance:** the overlay lists exactly the described entries with the key
column aligned to the widest hint, dispatch-only entries skipped, the title
row on top, and the `keymap` / `title` props absent from the scene node.

**Shipped:** `HelpPanel` in `@tern-tui/core` creates the `help` element — a
flex column `box` of text leaves (title row, then one key/description row
per described entry), materializing as a plain `box` with text children
(no new napi node kind). The `Keymap` class gains the `description` field
surfaced here. Composition tests land in `index_test.ts`, and the
kitchen-sink demos render a help panel from a small keymap.

---

## Theme system & soft wrap

**Theme system (shipped):** the core theme surface — `defaultTheme`,
`mergeTheme(base, overrides)`, `resolveTheme(theme, props)` — resolves the
semantic `role` / `component` hints on node props into plain `fg` / `bg` /
`border_style` style keys at element-creation time (the hints are consumed and
never reach the scene; explicit props always win). `@tern-tui/react` provides
`<ThemeProvider>` + `useTheme`; `@tern-tui/solid` resolves hints against the
module-level active theme. **M4.5 runtime switching (shipped):**
`setTheme(overrides)` / `getTheme()` (re-exported by core, react and solid —
the same function reference) swap the module-level active theme and re-resolve
every scene node created with `role` / `component` hints in place: only the
changed style keys are pushed (single-key writes, never a full-map replace),
exactly one coalesced repaint runs, and a React tree is never re-rendered. The
golden contract — a switched scene paints cell-for-cell identically to a fresh
mount created directly under the new theme — is unit-tested in core
(`index_test.ts` M4.5: golden / diff / un-hinted zero-calls / no-op), react and
solid. **M4.5 contrast audit (shipped):** the WCAG 2.1 checker
`parseThemeColor` / `relativeLuminance` / `contrastRatio` / `auditTheme`
(`packages/core/src/contrast.ts`, pure functions over the theme's string
colors — hex, `indexed:N`, `default`) audits any theme's palette roles and
component presets; see docs/guide.md "Contrast audit" for the runnable
example.

**Soft wrap (shipped):** the `wrap` prop passes through to each content leaf
of `DiffView` and is accepted on `StreamingText` for API stability — the
compositor soft-wraps at the node width.

## Unicode & grapheme clusters

**The indivisible text unit is the grapheme cluster** (UAX #29 extended
grapheme clusters, via `unicode-segmentation`). A ZWJ emoji sequence
(`👨‍👩‍👧‍👦`), a flag (`🇷🇺`), a keycap (`1️⃣`), or a base-plus-combining
sequence (`e` + U+0301 → `é`) is one cluster and is treated as a single
logical glyph everywhere in the paint pipeline:

- **Width** — a cluster occupies `min(2, Σ member char widths)` columns. A
  ZWJ emoji or a flag is a 2-column glyph; a combining sequence is 1 column
  (its base's width); a lone combining mark is 0 columns and is skipped.
  `display_width`, `measure_wrapped`, `flush_word`, and the layout engine's
  content-size path all measure cluster-by-cluster, so layout, wrapping, and
  painting agree on the same width.
- **Wrapping** — a cluster that does not fit on the current row wraps whole
  to the next row; a cluster wider than the whole row is dropped whole.
  `paint_word`, `paint_streaming_text`, and the right-edge truncation paths
  (`paint_text`, the `wrap: false` single-row trim) never split a cluster
  across rows or at the right edge.
- **Painting** — a cluster is written as one logical glyph occupying
  `cluster_width` columns. The lead cell carries the cluster's full symbol
  string (tern-core's `Cell.symbol`, ratatui-style); a 2-column cluster's
  second column is a masked continuation cell, so the wide-char invariant is
  unchanged. Single-char cells keep `symbol == None`, so the common case
  stays inline and allocation-free (tern-core's `Cell` drops `Copy`; the diff
  and the flusher only need `Clone` + `PartialEq`).
- **Flush** — the terminal flusher (`tern-terminal`) prints the full cluster
  string exactly once per cluster lead, in one `Print` call; a run's adjacency
  logic tracks the cluster's column advance so the following cell never lands
  on the wrong column. Combining sequences print as a single `Print` too.
- **Snapshots** — `render_to_buffer` / `snapshotFrame` rows reconstruct each
  cluster's full symbol, so a ZWJ emoji or flag appears as a single 2-column
  glyph in the row strings (masked continuation cells render as spaces).

**Cell model change:** `Cell` (and `CellUpdate`) gained a `symbol:
Option<Box<str>>` field holding the cluster's full text for multi-char
clusters. `Cell` is no longer `Copy` (its `Box<str>` cannot be) — the row-
slice fast path of `Buffer::diff_from` uses `PartialEq` slice comparison and
does not depend on `Copy`; `Buffer::resize` now `clone_from_slice`s instead
of `copy_from_slice`.

Cluster-aware cursor movement is shipped: the editing components (`Input`,
`Textarea`) now step and measure cursor/segment positions by grapheme cluster
via `tern_core::clusters` — move/delete/word-jump land on cluster boundaries,
backspace/delete remove whole clusters, and `display_col` sums cluster width
(shipped in Phase 8).

## Semantics

**Every interactive widget exposes accessibility metadata** — ARIA `role`,
accessible `label`, active `state` flags, and the `enabled` / `selected`
booleans — through the M4.1 semantics layer (see
[a11y.md](a11y.md) for the full API documentation). The metadata lives in a
**parallel bookkeeping store** that never changes painted cell output: the
store is off by default, the JS wiring is best-effort (writes to a disabled
store are dropped, never errors), and the compositor never reads it — so
enabling semantics leaves `render_to_buffer` frames byte-identical.

The per-component derivation (`syncSemantics`, run at factory creation and
after every key-handler rebuild):

| Component | `role` | `label` | `state` flags | `enabled` / `selected` |
|-----------|--------|---------|---------------|------------------------|
| Checkbox | `checkbox` | the `label` prop | `checked` (checked), `focused` | `!disabled` / `false` |
| Toggle | `switch` | the `label` prop | `checked` (on), `focused` | `!disabled` / `false` |
| Radio root | `radiogroup` | — | `focused` (a focused row exists) | `!disabled` / a member is confirmed |
| Radio option row | `radio` | the option label | `checked` (selected row), `focused` (focused row) | `true` / the row is selected |
| Select | `listbox` | — | `expanded` (dropdown open), `focused` (a highlighted row exists) | `!disabled` / a value is confirmed |
| Input / Textarea | `textbox` | the `label` prop (input) | `focused` | `!disabled` / `false` |
| Menu | `menu` | — | `expanded` (open) | `true` / `false` |

State transitions flow through the key handlers: `checkboxKey` / `toggleKey`
flip `checked`, `radioKey` moves the per-row `focused` / `selected` flags,
`selectKey` drops `expanded` on confirm/dismiss, and the menu open/close path
gains / loses `expanded`. Each transition is unit-tested in
`packages/core/src/semantics_test.ts` through the read API, alongside the
default-off contract and the cell-output invariance golden.
