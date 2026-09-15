//! Viewport mouse text selection and the clipboard copy path.

import { Renderer } from "./renderer.ts";
import type { SelectionRange } from "./types.ts";

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
/** The double-click window: two `down_left` presses on nearby cells within
 * this many milliseconds synthesize a double-click (word select). */
export const SELECTION_DOUBLE_CLICK_MS = 500;

/** The active mouse selection session on a renderer. */
interface SelectionSession {
  /** The fixed endpoint of the selection (the press-down cell). */
  anchor: { col: number; row: number };
  /** The moving endpoint (updated by each {@link dragSelection}). */
  active: { col: number; row: number };
  /** The overlay that was up when the press landed — the previous
   * persistent selection, or `null` when the overlay was cleared (or the
   * press synthesized a double-click, which deliberately replaces rather
   * than click-elsewhere-deselects). A bare release of a press outside it
   * clears the overlay ({@link endSelection}). */
  prior: SelectionRange | null;
}

/** The active selection session per renderer (one at a time per renderer). */
const selectionSessions = new WeakMap<Renderer, SelectionSession>();

/** The renderer's selection overlay rect, mirrored on the JS side: the
 * native surface exposes no selection getter, and the click-elsewhere clear
 * in {@link endSelection} must know where the persistent overlay sat before
 * the current gesture replaced it. Updated by every helper that applies or
 * clears a selection (`null`/absent when the overlay is cleared). */
const selectionLastRect = new WeakMap<Renderer, SelectionRange>();

/** Whether the cell (`col`, `row`) lies inside the (possibly reversed)
 * selection rect `range`. */
function rangeContains(
  range: SelectionRange,
  col: number,
  row: number,
): boolean {
  return (
    col >= Math.min(range.col1, range.col2) &&
    col <= Math.max(range.col1, range.col2) &&
    row >= Math.min(range.row1, range.row2) &&
    row <= Math.max(range.row1, range.row2)
  );
}

/** The most recent `down_left` press per renderer, for double-click
 * synthesis. */
interface SelectionPress {
  col: number;
  row: number;
  /** The wall-clock time of the press (from {@link selectionClock}). */
  at: number;
}

/** The most recent press per renderer (survives the gesture: the second press
 * of a double-click lands after the first gesture's release). */
const selectionLastPress = new WeakMap<Renderer, SelectionPress>();

/** The wall-clock source for double-click timing. Overridable through
 * {@link setSelectionClockForTesting}. */
let selectionClock: () => number = () => Date.now();

/**
 * Replace the wall-clock source used for double-click timing. Test-only seam
 * (mirrors `setAddonForTesting`): a fake clock makes the
 * {@link SELECTION_DOUBLE_CLICK_MS} window boundary assertable without a real
 * wait. Pass `() => Date.now()` to restore.
 */
export function setSelectionClockForTesting(clock: () => number): void {
  selectionClock = clock;
}

/**
 * Select the contiguous non-whitespace run (word) containing (`col`, `row`),
 * applying the word's cell range as the renderer's selection overlay.
 * Returns the applied range, or `null` when the cell is blank/whitespace (or
 * out of bounds, or nothing has been painted yet) — the selection is left
 * untouched then. Cluster-aware: the native word-range lookup treats a masked
 * continuation cell (a wide glyph's second column) as part of its glyph's run.
 */
export function selectWordAt(
  renderer: Renderer,
  col: number,
  row: number,
): SelectionRange | null {
  const range = renderer.selectionWordRange(col, row);
  if (range === null) return null;
  renderer.setSelection(range.col1, range.row1, range.col2, range.row2);
  return range;
}

/**
 * Start a mouse selection: a `down_left` press anchors a selection session at
 * the pressed cell and applies a 1-cell selection overlay. A second press on
 * a nearby cell — within {@link SELECTION_DOUBLE_CLICK_MS} milliseconds and
 * no more than one cell away — is treated as a double-click and selects the
 * word under the pointer instead ({@link selectWordAt}; a double-click on
 * whitespace falls back to the 1-cell selection). The overlay that was up
 * when the press landed is recorded on the session: a bare release of a
 * press outside it clears (click-elsewhere deselects), anything else
 * replaces it. Returns the applied selection range, or `null` when the event
 * is not `down_left`.
 */
export function startSelection(
  renderer: Renderer,
  event: MouseEventJs,
): SelectionRange | null {
  if (event.kind !== "down_left") return null;
  const col = event.column;
  const row = event.row;
  const prev = selectionLastPress.get(renderer);
  const at = selectionClock();
  const doubleClick = prev !== undefined &&
    at - prev.at <= SELECTION_DOUBLE_CLICK_MS &&
    Math.abs(col - prev.col) + Math.abs(row - prev.row) <= 1;
  // Snapshot the overlay before this gesture replaces it: the click-
  // elsewhere clear in {@link endSelection} judges a bare release against
  // where the persistent selection sat when the press landed.
  const prior = selectionLastRect.get(renderer) ?? null;
  let range: SelectionRange;
  if (doubleClick) {
    const word = selectWordAt(renderer, col, row);
    if (word === null) {
      range = { col1: col, row1: row, col2: col, row2: row };
      renderer.setSelection(col, row, col, row);
    } else {
      range = word;
    }
  } else {
    range = { col1: col, row1: row, col2: col, row2: row };
    renderer.setSelection(col, row, col, row);
  }
  // A double-click never click-elsewhere-deselects: it is a deliberate
  // replacement, so its session carries no `prior` (bare releases of it keep
  // the applied word/1-cell overlay).
  selectionSessions.set(renderer, {
    anchor: { col, row },
    active: { col, row },
    prior: doubleClick ? null : prior,
  });
  selectionLastRect.set(renderer, range);
  selectionLastPress.set(renderer, { col, row, at });
  return range;
}

/**
 * Move an active selection's active endpoint: a `drag_left` event extends the
 * selection to the dragged cell, keeping the press-down anchor fixed. The
 * updated rect is applied through `renderer.setSelection` (the native overlay
 * normalizes the endpoints, so dragging above/left of the anchor still
 * selects the spanned rectangle). Returns the applied (post-extension)
 * range, or `null` when no session is active or the event is not `drag_left`.
 */
export function dragSelection(
  renderer: Renderer,
  event: MouseEventJs,
): SelectionRange | null {
  const session = selectionSessions.get(renderer);
  if (session === undefined || event.kind !== "drag_left") return null;
  session.active = { col: event.column, row: event.row };
  const range: SelectionRange = {
    col1: session.anchor.col,
    row1: session.anchor.row,
    col2: session.active.col,
    row2: session.active.row,
  };
  renderer.setSelection(range.col1, range.row1, range.col2, range.row2);
  selectionLastRect.set(renderer, range);
  return range;
}

/**
 * End an active mouse selection: any `up_*` release ends the session but
 * leaves the selection overlay up (persistent selection after release) — the
 * highlight survives until a new selection replaces it, `escape` clears it
 * ({@link selectionKey}), or a bare release of a press that landed outside
 * the overlay up at press time clears it (click-elsewhere deselects). A drag
 * release always persists the dragged rect. Returns the selection rect at
 * release, or `null` when no session was active (or the event is not an
 * `up_*` release).
 */
export function endSelection(
  renderer: Renderer,
  event: MouseEventJs,
): SelectionRange | null {
  const session = selectionSessions.get(renderer);
  if (session === undefined || !event.kind.startsWith("up")) return null;
  selectionSessions.delete(renderer);
  const range: SelectionRange = {
    col1: session.anchor.col,
    row1: session.anchor.row,
    col2: session.active.col,
    row2: session.active.row,
  };
  const bare = session.anchor.col === session.active.col &&
    session.anchor.row === session.active.row;
  if (
    bare && session.prior !== null &&
    !rangeContains(session.prior, session.anchor.col, session.anchor.row)
  ) {
    // A bare click (no drag) outside the previous persistent selection is
    // click-elsewhere: deselect instead of leaving the 1-cell press up.
    renderer.clearSelection();
    selectionLastRect.delete(renderer);
  } else {
    selectionLastRect.set(renderer, range);
  }
  return range;
}

/**
 * Copy the renderer's current selection text to the system clipboard (OSC 52
 * via {@link Renderer.setClipboard}): `setClipboard(selectionText())`. The
 * overlay is persistent (it survives {@link endSelection}), so the copy may
 * happen during the gesture, right after the release, or any time before the
 * overlay is cleared (by `escape`, a bare press outside it, or a new
 * selection replacing it) — hosts can keep copy-on-release or copy lazily.
 */
export function copySelection(renderer: Renderer): void {
  renderer.setClipboard(renderer.selectionText());
}

/**
 * The selection key handler: maps the copy key — `ctrl+shift+c` — to
 * {@link copySelection} and `escape` to {@link Renderer.clearSelection} (the
 * explicit clear for a persistent selection), returning whether the key was
 * consumed. Plain `ctrl+c` (the app's exit convention) is deliberately not
 * handled and returns `false`, so it falls through to the exit binding. Note
 * that some terminal emulators intercept `ctrl+shift+c` for their own copy
 * before the app sees it; hosts that want a different copy key can pass a
 * different mapping.
 */
export function selectionKey(renderer: Renderer, event: KeyEvent): boolean {
  if (
    event.name === "char" && event.char === "c" && event.ctrl && event.shift &&
    !event.alt
  ) {
    copySelection(renderer);
    return true;
  }
  // `escape` is the explicit clear: the persistent selection (or a live one)
  // is dismissed, so a later bare press starts fresh.
  if (event.name === "escape") {
    renderer.clearSelection();
    selectionLastRect.delete(renderer);
    return true;
  }
  return false;
}

/**
 * An async event queue fed by the native push stream. `push` enqueues an
 * event on the JS thread (called by the native `ThreadsafeFunction`
 * callback); `[Symbol.asyncIterator]` yields events in arrival order until
 * `close`. No events are dropped: a consumer that is slow to `next()` simply
 * accumulates the queue.
 *
 * The iterator is safe against the classic missed-wakeup race: it re-checks
 * the queue after registering its waiter, so an event pushed between the
 * length check and the waiter registration still wakes it.
 */
export class TernEventStream implements AsyncIterable<TernEventJs> {
  #queue: TernEventJs[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  /** Enqueue an event delivered from the native event loop. */
  push(event: TernEventJs): void {
    this.#queue.push(event);
    this.#wakeWaiters();
  }

  /** Stop the stream: pending and future `next()` calls resolve as done. */
  close(): void {
    this.#closed = true;
    this.#wakeWaiters();
  }

  #wakeWaiters(): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TernEventJs> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift()!;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        // Re-check after registering: an event (or a close) may have arrived
        // between the checks above and the waiter registration.
        if (this.#queue.length > 0 || this.#closed) {
          const index = this.#waiters.indexOf(resolve);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve();
        }
      });
    }
  }
}

