//! The Renderer: render loop, event stream, and the headless snapshot path.

import { Node } from "./node.ts";
import { TernEventStream } from "./selection.ts";
import { liveRenderers } from "./theme.ts";
import type { CreateRendererOptions, FocusHandler, KeyHandler, LifecycleHandler, MouseHandler, PasteHandler, ResizeHandler, SelectionRange } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
import { loadAddon } from "./addon.ts";
import { A11yStream } from "./a11y.ts";
/**
 * A terminal-facing renderer. Constructing one enters raw mode + the
 * alternate screen; `destroy()` (or Ctrl+C with `exitOnCtrlC`) restores the
 * terminal and stops the event stream. A destroyed renderer cannot render or
 * poll.
 *
 * Constructed with `headless: true` (see {@link CreateRendererOptions}), a
 * renderer never touches a terminal: no raw mode, no alternate screen, no
 * event stream, no title. The scene paints into an in-memory buffer at the
 * configured `size` (default 80x24), so `render()`, `snapshotFrame()` and
 * `snapshotStyled()` work without a TTY — and `startEventStream()` errors,
 * since a headless renderer has no terminal to read events from (and
 * nothing to listen to).
 *
 * Input delivery is push-based but **explicit**: `startEventStream()` begins
 * the native event loop (and with it the delivery of terminal events to
 * `events` and the `on*` handlers). Call it once the scene is ready — before
 * it, the terminal buffers input untouched, so an app that asserts its scene
 * first is not racing early input.
 */
export class Renderer {
  #native: NativeTuiRenderer;
  #keyHandlers = new Set<KeyHandler>();
  #resizeHandlers = new Set<ResizeHandler>();
  #focusHandlers = new Set<FocusHandler>();
  #mouseHandlers = new Set<MouseHandler>();
  #pasteHandlers = new Set<PasteHandler>();
  #lifecycleHandlers = new Set<LifecycleHandler>();
  #events = new TernEventStream();
  #streamStarted = false;
  #destroyed = false;
  /** Whether a coalesced frame (see {@link requestFrame}) is currently
   * scheduled — the pending-frame flag the coalescing dedupe keys on. */
  #framePending = false;
  /** The callbacks queued behind the pending coalesced frame, in call order. */
  #frameCallbacks: Array<() => void> = [];
  /** The macrotask handle of the pending coalesced frame, or `null`. */
  #frameTimer: ReturnType<typeof setTimeout> | null = null;
  /** The configured frame-rate cap for coalesced frames (from
   * `CreateRendererOptions.maxFps`), or `0` for no throttle. JS-side only:
   * never forwarded to the native renderer. */
  #maxFps = 0;
  /** The `performance.now()` timestamp of the most recent native render
   * (an explicit `render()` or a coalesced frame) — the anchor the frame
   * budget spaces the next coalesced frame from. `0` means "never
   * rendered", so the first scheduled frame is always immediate. */
  #lastNativeRenderAt = 0;
  /** Whether the accessibility-semantics store is enabled — the JS mirror
   * of the native store gate (see `CreateRendererOptions.semantics`), kept
   * in sync with the constructor option and {@link setSemanticsEnabled}. */
  #semanticsEnabled = false;
  /** The active a11y stream (see {@link startA11yStream}), or `null` when
   * no stream is started. */
  #a11y: A11yStream | null = null;

  /** The scene root. Attach content under it with `Node.addChild`. */
  readonly root: Node;

  /** @internal — use `createRenderer`. */
  constructor(options: CreateRendererOptions = {}) {
    this.#maxFps = options.maxFps ?? 0;
    this.#semanticsEnabled = options.semantics ?? false;
    const addon = loadAddon();
    const nativeOptions: TuiRendererOptions = {
      exit_on_ctrl_c: options.exitOnCtrlC ?? false,
      use_alt_screen: options.useAltScreen ?? true,
    };
    if (options.title !== undefined) nativeOptions.title = options.title;
    if (options.headless !== undefined) {
      nativeOptions.headless = options.headless;
    }
    if (options.keyboardEnhancement !== undefined) {
      nativeOptions.keyboard_enhancement = options.keyboardEnhancement;
    }
    if (options.scrollOptimization !== undefined) {
      nativeOptions.scroll_optimization = options.scrollOptimization;
    }
    if (options.semantics !== undefined) {
      nativeOptions.semantics = options.semantics;
    }
    if (options.size !== undefined) {
      nativeOptions.width = options.size.width;
      nativeOptions.height = options.size.height;
    }
    this.#native = new addon.TuiRenderer(nativeOptions);
    this.root = Node.wrapRoot(this.#native.root());
    // The M4.5 runtime theme engine: register as a `setTheme` repaint target
    // (unregistered in `destroy`).
    liveRenderers.add(this);
  }

  /**
   * The terminal's capabilities: the color report detected once by the
   * native backend (`{ truecolor, colors }` — whether 24-bit RGB is
   * supported, and the palette size 16_777_216 / 256 / 16 / 0) merged with
   * the interactive probe report (`terminalIdentity`, `kittyKeyboard`,
   * `kittyUnderline`, `osc52`, `bracketedPaste`, `focusEvents`,
   * `scrollRegion`, `probed` — the terminal's self-reported identity and
   * protocol supports from the native side's DA1/DA2/XTVERSION/XTGETTCAP
   * probe). The probe result is
   * cached per process; a probe skipped for a non-TTY or `TERM=dumb`
   * reports conservative defaults with `probed: false`.
   */
  get capabilities(): RendererCapabilities {
    return this.#native.capabilities;
  }

  /**
   * The number of bytes the most recent `render()` flush wrote to the
   * terminal: the ANSI escape-sequence stream for that frame's diff (0 for
   * a fully suppressed empty-diff frame). Fed by the backend queue on the
   * native side; a no-op fast-path render (scene unchanged) never flushes,
   * so the counter keeps the previous flush's value until the next real
   * flush. The byte-cost measure behind the bench's flushed-bytes-per-frame
   * numbers.
   */
  get lastFlushBytes(): number {
    // The native counter is a u64 surfaced as bigint; the byte counts are
    // frame-sized (~KB per flush), far inside number's safe range.
    return Number(this.#native.last_flush_bytes);
  }

  /**
   * Set the terminal window title (OSC 0). Throws on a destroyed renderer.
   */
  setTitle(title: string): void {
    this.#native.set_title(title);
  }

  /**
   * The terminal size as `{ width, height }` in cells: the viewport the most
   * recent `render()` or `snapshotFrame()` painted at (80×24 before any
   * paint). Before the first paint the native side reports the current
   * terminal size (one probe through its cached-size machinery), so a fresh
   * renderer never surfaces the synthetic fallback — except a headless one
   * (see {@link CreateRendererOptions}), which reports the configured
   * virtual `size` from the start, there being no terminal to probe.
   * Equivalent to the
   * `width`/`height` the native layer paints the next frame at — a resize
   * event's `{ width, height }` lands here once the next render paints at
   * it. Throws on a destroyed renderer.
   */
  get size(): { width: number; height: number } {
    return this.#native.size;
  }

  /**
   * Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
   * BEL`, the payload being the text's UTF-8 bytes base64-encoded per
   * RFC 4648). The terminal emulator must support OSC 52 (xterm, kitty,
   * foot, WezTerm, iTerm2, ...; tmux forwards it when `set-clipboard` is
   * enabled). Throws on a destroyed renderer.
   */
  setClipboard(text: string): void {
    this.#native.set_clipboard(text);
  }

  /**
   * Set the selection overlay to the inclusive rectangle spanned by
   * (`col1`, `row1`) and (`col2`, `row2`) in viewport cells. The endpoints
   * are normalized by the compositor, so either may be the top-left. The
   * overlay is applied at the next `render()` (which the selection edit
   * forces) and to the next `snapshotFrame()`. Per-renderer state — the
   * shared scene never carries the selection. Throws on a destroyed
   * renderer.
   */
  setSelection(col1: number, row1: number, col2: number, row2: number): void {
    this.#native.set_selection(col1, row1, col2, row2);
  }

  /**
   * Clear the selection overlay: the next render paints without any
   * reversed selection cells (and the next snapshot omits the overlay).
   * Throws on a destroyed renderer.
   */
  clearSelection(): void {
    this.#native.clear_selection();
  }

  /**
   * Flatten the scene's accessibility-semantics store into a flat vector —
   * one {@link SceneSemanticsJs} entry per node with a semantics entry, in
   * scene pre-order (the ids mirror the scene tree and `parent` links each
   * entry back into it, `null` for the root), so a consumer can reconstruct
   * the accessibility tree from the flat dump. Nodes whose semantics were
   * cleared are omitted.
   *
   * Pure read for tests, debugging, and a11y bridges: it never touches
   * layout or painted content (the store is a parallel bookkeeping map —
   * see the core `semantics` module), and it is not gated by the store's
   * enable flag (entries written while enabled stay readable after
   * disabling). State flags are sorted for a stable dump. Throws on a
   * destroyed renderer.
   */
  semantics(): SceneSemanticsJs[] {
    return this.#native.semantics();
  }

  /**
   * Record whether the accessibility-semantics store is enabled — the
   * JS-side mirror of the native store gate (see
   * {@link CreateRendererOptions}). The native store itself is fixed at
   * construction (there is no native runtime toggle), so this updates the
   * JS bookkeeping only: it is the effective enabled state a consumer or
   * a11y bridge can query and coordinate against, and it stays in sync with
   * the `semantics` constructor option. The JS semantics wiring is
   * best-effort regardless: when the native store is off, writes are
   * dropped, never errors.
   */
  setSemanticsEnabled(enabled: boolean): void {
    this.#semanticsEnabled = enabled;
  }

  /**
   * Start the a11y stream: every coalesced painted frame (see
   * {@link requestFrame}) serializes the current `Renderer.semantics()`
   * dump through `onLine` as a versioned JSONL line — one header line
   * `{"v":1}` emitted synchronously at start, then one line per emission
   * holding the full dump as ONE JSON array (scene node ids, which are
   * `bigint`, serialize as decimal strings). No-change suppression drops an
   * emission whose serialized dump is byte-identical to the last one.
   * The stream is a pure read — it never touches layout or painted content
   * (painted frames are byte-identical with the stream running) — and
   * best-effort: a destroyed-renderer read error or a throwing sink is
   * swallowed, never propagating into the frame path. Emits only from the
   * coalesced frame path, so each painted frame yields at most one
   * emission. Idempotent: calling while a stream is already active is a
   * no-op.
   */
  startA11yStream(onLine: (line: string) => void): void {
    if (this.#a11y !== null) return;
    this.#a11y = new A11yStream(() => this.semantics(), onLine);
  }

  /**
   * Stop the a11y stream: future emissions are dropped (an in-flight
   * stream's `emit()` becomes a no-op). Idempotent: calling with no active
   * stream is a no-op.
   */
  stopA11yStream(): void {
    if (this.#a11y === null) return;
    this.#a11y.close();
    this.#a11y = null;
  }

  /**
   * Set the renderer's caret override: position (`x`, `y`), shape
   * (`"block"` / `"bar"` / `"underline"`), visibility, and blinking, all in
   * viewport cells / DECSCUSR terms. The next `render()` (which the cursor
   * edit forces) flushes through the cursor-aware path: the frame diff,
   * then `MoveTo` + `SetCursorStyle` (emitted only for a non-default
   * caret — a steady block is the terminal's default, so a `"block"` /
   * non-blinking cursor adds nothing to the flush) + `Show`/`Hide`, so the
   * hardware caret tracks the model. Throws on a destroyed renderer or an
   * unrecognized shape.
   */
  setCursor(options: {
    x: number;
    y: number;
    shape: "block" | "bar" | "underline";
    visible: boolean;
    blink: boolean;
  }): void {
    this.#native.set_cursor(
      options.x,
      options.y,
      options.shape,
      options.visible,
      options.blink,
    );
  }

  /**
   * Clear the renderer's caret override: the next `render()` (which the
   * cursor edit forces) falls back to the legacy position-only flush — the
   * frame diff with the caret parked at the top-left, no shape, blinking,
   * or visibility control — byte-identical to a renderer that never called
   * {@link setCursor}. Throws on a destroyed renderer.
   */
  clearCursor(): void {
    this.#native.clear_cursor();
  }

  /**
   * The text of the renderer's current selection, extracted from the last
   * painted frame (the frame the most recent `render()` produced):
   * row-major and cluster/mask-aware — a multi-char cluster (ZWJ emoji,
   * combining sequence, flag) contributes its whole symbol, a masked
   * continuation cell contributes nothing, and rows are joined with
   * `'\n'`. An empty string when no selection is set or nothing has been
   * rendered yet. Throws on a destroyed renderer.
   */
  selectionText(): string {
    return this.#native.selection_text();
  }

  /**
   * The inclusive cell range of the contiguous non-whitespace run (word)
   * containing (`col`, `row`) in the last painted frame, or `null` when
   * the cell is blank/whitespace (or out of bounds, or nothing has been
   * rendered yet). Cluster-aware: a masked continuation cell (the right
   * half of a wide glyph) is treated as part of its glyph's run — never as
   * whitespace — so a click on a wide character's second column still
   * returns the word that contains the glyph. Throws on a destroyed
   * renderer.
   */
  selectionWordRange(col: number, row: number): SelectionRange | null {
    return this.#native.selection_word_range(col, row);
  }

  /**
   * The live stream of terminal events (`TernEventJs` tagged union), pushed
   * from the native event loop after `startEventStream()`. Subscribe with
   * `for await (const event of renderer.events)` — the reconciler's
   * replacement for the old `pollEvents` loop. The stream yields every
   * delivered event in order, without loss, and closes when the renderer is
   * destroyed.
   */
  get events(): AsyncIterable<TernEventJs> {
    return this.#events;
  }

  /**
   * Begin push-based input delivery (roadmap Phase 3): the native binding
   * spawns its background event loop and delivers every terminal event to
   * the JS thread through a ThreadsafeFunction — following Node's error-first
   * callback convention, so the callback's first argument is always null —
   * feeding the `events` iterable and the `on*` handler sets. Idempotent; a
   * no-op once started. A no-op on a destroyed renderer. Errors on a
   * headless renderer (see {@link CreateRendererOptions}): there is no
   * terminal to read events from, so the native binding rejects the call.
   */
  startEventStream(): void {
    if (this.#streamStarted || this.#destroyed) return;
    this.#native.start_event_stream((_err, event) => {
      if (event !== undefined) this.#onNativeEvent(event);
    });
    this.#streamStarted = true;
  }

  /** The native push callback: enqueue + dispatch to the `on*` handlers. */
  #onNativeEvent(event: TernEventJs): void {
    if (this.#destroyed) return;
    this.#events.push(event);
    switch (event.type) {
      case "key":
        if (event.key !== undefined) {
          // Snapshot the handler set BEFORE dispatching: a handler may
          // synchronously re-render its tree (e.g. an approval dialog that
          // resolves its promise on `y` remounts the input bar), and the
          // remounted components subscribe DURING this loop. Iterating the
          // live set would deliver the SAME key event to the freshly
          // mounted handler — the decision keystroke would leak into the
          // new input buffer. Dispatch goes to the handlers registered at
          // dispatch time, exactly once each.
          for (const handler of [...this.#keyHandlers]) handler(event.key);
        }
        break;
      case "resize":
        if (event.width !== undefined && event.height !== undefined) {
          const size = { width: event.width, height: event.height };
          for (const handler of this.#resizeHandlers) handler(size);
        }
        break;
      case "focus":
        if (event.focus_gained !== undefined) {
          const focus = { focus_gained: event.focus_gained };
          for (const handler of this.#focusHandlers) handler(focus);
        }
        break;
      case "mouse":
        if (event.mouse !== undefined) {
          for (const handler of this.#mouseHandlers) handler(event.mouse);
        }
        break;
      case "paste":
        if (event.paste !== undefined) {
          for (const handler of this.#pasteHandlers) handler(event.paste);
        }
        break;
      case "lifecycle":
        // A job-control lifecycle event pushed by the native signal thread:
        // `"suspend"` (SIGTSTP — terminal restored, process about to stop)
        // or `"resume"` (SIGCONT — terminal re-entered, full repaint
        // pending). On `"resume"` the screen was invalidated, so the app
        // must re-render.
        if (event.lifecycle !== undefined) {
          for (const handler of this.#lifecycleHandlers) {
            handler(event.lifecycle);
          }
        }
        break;
    }
  }

  /** Paint the shared scene to the terminal (minimal diff vs the last frame).
   *
   * Stays synchronous and immediate. An explicit paint supersedes a pending
   * coalesced frame (see {@link requestFrame}): the scheduled frame is
   * canceled — the scene was just painted in full — and any callbacks queued
   * for it run right after this paint, since they are promised to run once a
   * native render completes and this is one. With no frame pending, this is
   * exactly the native call, unchanged from a direct render.
   */
  render(): void {
    const callbacks = this.#frameCallbacks;
    this.#cancelFrame();
    this.#native.render();
    // An explicit render is a native render: it anchors the frame budget,
    // so the next coalesced frame spaces from this paint. Immediate by
    // construction — the throttle never delays the explicit path.
    this.#lastNativeRenderAt = performance.now();
    for (const callback of callbacks) callback();
  }

  /**
   * Schedule a coalesced native render on the next macrotask
   * (`setTimeout(0)`, falling back to `queueMicrotask` when timers are
   * unavailable). Several `requestFrame` calls within one tick collapse into
   * a single native `render()` — the pending-frame flag dedupes the schedule
   * — so a burst of scene mutations repaints once instead of once per call.
   * With a `maxFps` cap configured (see {@link CreateRendererOptions}), the
   * coalesced frame fires no earlier than `1000 / maxFps` after the previous
   * native render: a high-frequency schedule loop downsamples to the cap
   * under load, while a burst still collapses into one native render — just
   * delayed to the budget. An explicit {@link render} bypasses the cap and
   * paints immediately.
   * The optional `callback` runs after the native render completes (every
   * call's callback, in call order). An explicit {@link render} while a
   * coalesced frame is pending paints immediately and supersedes it, running
   * the queued callbacks right after its own paint.
   *
   * Returns a cancel function that aborts a still-pending frame: the
   * scheduled render never fires and its queued callbacks are dropped. A
   * no-op once the frame has fired (or was already canceled).
   */
  requestFrame(callback?: () => void): () => void {
    this.#scheduleFrame(callback);
    return () => this.#cancelFrame();
  }

  /**
   * The shared coalescing core: queue `callback` (if any) behind the pending
   * frame and arm one for the next macrotask unless a frame is already
   * pending. Both the schedule path (arming a fresh frame) and the coalesce
   * path (a frame is already armed) go through here, so the pending-frame
   * flag is the single source of truth for the dedupe.
   */
  #scheduleFrame(callback?: () => void): void {
    if (callback !== undefined) this.#frameCallbacks.push(callback);
    if (this.#framePending) return;
    this.#framePending = true;
    const run = () => {
      // The flag may have been cleared by a cancel (or a superseding
      // `render()`) while this task sat in the queue — only reachable via
      // the `queueMicrotask` fallback, since a canceled timer never fires.
      if (!this.#framePending) return;
      this.#frameTimer = null;
      this.#framePending = false;
      this.#native.render();
      // Anchor the frame budget: the next coalesced frame spaces from this
      // native render, never earlier than the cap allows.
      this.#lastNativeRenderAt = performance.now();
      // The a11y stream emits once per painted frame — from the coalesced
      // path only (an explicit `render()` supersedes a pending frame, so
      // the two paths never both fire), giving at most one emission per
      // native render. Best-effort: a read or sink error is swallowed by
      // the stream and never reaches this loop.
      this.#a11y?.emit();
      const callbacks = this.#frameCallbacks;
      this.#frameCallbacks = [];
      for (const callback of callbacks) callback();
    };
    if (typeof setTimeout === "function") {
      // With a `maxFps` cap, delay to the end of the current frame budget
      // (never before the last native render + 1000/maxFps); without one
      // the delay is exactly 0 — the next macrotask, unchanged from the
      // unthrottled schedule. The microtask fallback stays throttle-free.
      const delay = this.#maxFps > 0
        ? Math.max(
          0,
          1000 / this.#maxFps - (performance.now() - this.#lastNativeRenderAt),
        )
        : 0;
      this.#frameTimer = setTimeout(run, delay);
    } else {
      queueMicrotask(run);
    }
  }

  /** Cancel a still-pending coalesced frame, dropping its queued callbacks.
   * No-op when no frame is pending. */
  #cancelFrame(): void {
    if (!this.#framePending) return;
    this.#framePending = false;
    if (this.#frameTimer !== null) {
      clearTimeout(this.#frameTimer);
      this.#frameTimer = null;
    }
    this.#frameCallbacks = [];
  }

  /**
   * Paint the shared scene into a fresh buffer at the given viewport —
   * `width`/`height` in cells, each defaulting to the most recent
   * `render`'s terminal size — and return the frame as one string per row.
   * Masked/continuation cells (the zero-width right halves of wide glyphs)
   * are spaces, so every row has exactly `width` display columns
   * (multi-width aware). Performs no terminal I/O: the result is a pure
   * snapshot for testing and golden comparisons (see {@link framesEqual}).
   */
  snapshotFrame(width?: number, height?: number): string[] {
    return this.#native.render_to_buffer(width, height);
  }

  /**
   * Paint the shared scene into a fresh buffer at the given viewport —
   * `width`/`height` in cells, each defaulting to the most recent
   * `render`'s terminal size — and return the frame as one array of
   * styled runs per row. Each run is a {@link StyleRunJs} `{ text, fg?,
   * bg?, bold?, dim?, italic?, underline?, reversed?, strikethrough? }`;
   * adjacent cells with identical style merge into one run, so
   * concatenating a row's run texts reconstructs the corresponding
   * {@link snapshotFrame} row string exactly (masked/continuation cells
   * are spaces, multi-width aware). Colors surface as `"#rrggbb"`
   * (truecolor) or `"indexed:<n>"` (palette) strings; modifier keys are
   * present only when set, so an unstyled run carries just `text`.
   *
   * The styled counterpart of {@link snapshotFrame}: shares its paint
   * path and viewport-recording semantics (the `size` getter reports the
   * viewport painted at after the call) and its destroyed-renderer error,
   * and performs no terminal I/O — a pure styled snapshot for testing and
   * golden comparisons (see {@link styledFramesEqual}).
   */
  snapshotStyled(width?: number, height?: number): StyleRunJs[][] {
    return this.#native.render_to_buffer_styled(width, height);
  }

  /**
   * The scene node ids covering the cell at (`col`, `row`), innermost
   * (topmost) first, then each ancestor that also covers the cell. The scene
   * root is never reported; a cell no node covers yields `[]`. Z-order and
   * clip/scroll regions match what `render()` paints, so a click at a mouse
   * event's `column`/`row` routes to the node that is visually on top.
   *
   * Node ids are u64 and surface as `bigint`.
   */
  hit_test(col: number, row: number): bigint[] {
    return this.#native.hit_test(col, row);
  }

  /**
   * Register a handler invoked for every key event delivered by the push
   * event stream. The handler receives the `KeyEvent` payload. Returns an
   * unsubscribe function.
   */
  onKey(handler: KeyHandler): () => void {
    this.#keyHandlers.add(handler);
    return () => this.#keyHandlers.delete(handler);
  }

  /**
   * Register a handler invoked when the terminal is resized. The handler
   * receives the new size as `{ width, height }`. Returns an unsubscribe
   * function.
   */
  onResize(handler: ResizeHandler): () => void {
    this.#resizeHandlers.add(handler);
    return () => this.#resizeHandlers.delete(handler);
  }

  /**
   * Register a handler invoked when the terminal window gains or loses focus.
   * The handler receives `{ focus_gained }` — `true` when focus was gained,
   * `false` when it was lost. Returns an unsubscribe function.
   */
  onFocus(handler: FocusHandler): () => void {
    this.#focusHandlers.add(handler);
    return () => this.#focusHandlers.delete(handler);
  }

  /**
   * Register a handler invoked for every mouse event delivered by the push
   * event stream. The handler receives the `MouseEventJs` payload. Returns an
   * unsubscribe function.
   *
   * The listener count drives the native any-event mouse mode (`?1003h`):
   * the first handler to register enables it — the terminal then reports
   * every motion, not just presses and drags — and the last unsubscribe
   * disables it (`?1003l`), so motion events flow only while a listener is
   * actually registered. A re-subscribe while a handler is already active
   * (1→1) does not re-toggle the native mode. After the renderer is
   * destroyed the toggles are skipped: the native teardown already emitted
   * `?1003l`.
   */
  onMouse(handler: MouseHandler): () => void {
    this.#mouseHandlers.add(handler);
    if (this.#mouseHandlers.size === 1 && !this.destroyed) {
      this.#native.set_any_event_mouse(true);
    }
    return () => {
      this.#mouseHandlers.delete(handler);
      if (this.#mouseHandlers.size === 0 && !this.destroyed) {
        this.#native.set_any_event_mouse(false);
      }
    };
  }

  /**
   * Register a handler invoked for every paste event delivered by the push
   * event stream. The handler receives the pasted text string. Returns an
   * unsubscribe function.
   */
  onPaste(handler: PasteHandler): () => void {
    this.#pasteHandlers.add(handler);
    return () => this.#pasteHandlers.delete(handler);
  }

  /**
   * Register a handler invoked on every job-control lifecycle event pushed
   * by the native signal thread: `{ phase: "suspend" }` when SIGTSTP
   * (Ctrl+Z) is about to stop the process — the terminal has been restored
   * to its pre-TUI state, so the app can flush anything it must persist —
   * and `{ phase: "resume" }` after SIGCONT re-entered raw mode + the
   * alternate screen and invalidated the screen. On `"resume"` the app must
   * re-render (`renderer.render()`) to repaint the full screen. Returns an
   * unsubscribe function.
   */
  onLifecycle(handler: LifecycleHandler): () => void {
    this.#lifecycleHandlers.add(handler);
    return () => this.#lifecycleHandlers.delete(handler);
  }

  /**
   * Leave the alternate screen and raw mode, restoring the terminal, and stop
   * the push event stream. Safe to call more than once.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // A destroyed renderer must not be a `setTheme` repaint target anymore.
    liveRenderers.delete(this);
    // A pending coalesced frame must not fire after teardown: the native
    // renderer throws once destroyed, and the queued macrotask would call
    // `render()` on it.
    this.#cancelFrame();
    this.#events.close();
    // A destroyed renderer must not stream: close the a11y stream so its
    // best-effort read never touches the destroyed native renderer.
    this.#a11y?.close();
    this.#a11y = null;
    this.#native.destroy();
  }

  /** Whether the renderer has been destroyed (explicitly or via Ctrl+C). */
  get destroyed(): boolean {
    return this.#destroyed || this.#native.destroyed;
  }
}

/**
 * Construct a renderer over the tern-node native addon.
 *
 * ```ts
 * const renderer = createRenderer({ exitOnCtrlC: true });
 * renderer.root.addChild(
 *   Box({ border_style: "rounded" }, Text({ text: "Hello" })),
 * );
 * renderer.render();
 * for await (const event of renderer.events) {
 *   // push-delivered tagged TernEventJs events (no polling loop)
 * }
 * renderer.destroy();
 * ```
 *
 * Pass `headless: true` (optionally with a `size`) to construct a renderer
 * that never touches a terminal — no raw mode, no alternate screen, no event
 * stream — painting into an in-memory buffer at the configured size instead
 * (see {@link CreateRendererOptions} for the full semantics).
 */
export function createRenderer(options: CreateRendererOptions = {}): Renderer {
  return new Renderer(options);
}

/**
 * Whether two snapshot frames (from {@link Renderer.snapshotFrame}) are
 * identical: the same number of rows, each row string equal. Frames are
 * row-aligned by construction — every row has exactly the viewport width —
 * so plain string comparison is the full equality contract.
 */
export function framesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Whether two styled snapshot frames (from {@link Renderer.snapshotStyled})
 * are identical: the same number of rows, each row the same number of runs,
 * and each run the same text and every style field. Style fields compare
 * strictly — a run that explicitly sets a modifier or color differs from one
 * that omits it — mirroring the binding's "modifier keys are present only
 * when set" contract, so the comparison is the full equality contract for
 * styled frames. The styled counterpart of {@link framesEqual}.
 */
export function styledFramesEqual(
  a: StyleRunJs[][],
  b: StyleRunJs[][],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const rowA = a[i]!;
    const rowB = b[i]!;
    if (rowA.length !== rowB.length) return false;
    for (let j = 0; j < rowA.length; j++) {
      if (!styledRunsEqual(rowA[j]!, rowB[j]!)) return false;
    }
  }
  return true;
}

/** Whether two styled runs are identical: the same text and every style
 * field. Field-wise strict comparison (`undefined` vs a set modifier or
 * color differs), so a styled run is never equal to a plain one. `hyperlink`
 * participates like the other style fields — mirroring the engine's style
 * equality, where a hyperlink change splits runs at the link boundary — and
 * so do `underlineStyle` / `underlineColor`: a variant or colored-underline
 * change splits runs at the underline boundary. */
function styledRunsEqual(a: StyleRunJs, b: StyleRunJs): boolean {
  if (a.text !== b.text) return false;
  if (a.fg !== b.fg) return false;
  if (a.bg !== b.bg) return false;
  if (a.bold !== b.bold) return false;
  if (a.dim !== b.dim) return false;
  if (a.italic !== b.italic) return false;
  if (a.underline !== b.underline) return false;
  if (a.reversed !== b.reversed) return false;
  if (a.strikethrough !== b.strikethrough) return false;
  if (a.hyperlink !== b.hyperlink) return false;
  if (a.underlineStyle !== b.underlineStyle) return false;
  if (a.underlineColor !== b.underlineColor) return false;
  return true;
}

