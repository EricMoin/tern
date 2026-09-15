//! The bounded undo/redo ring: how many steps a document keeps, and when a
//! run of keystrokes collapses into one step.

/**
 * The history cap: a document keeps at most this many undo steps.
 *
 * This is a PRODUCT DECISION, not a tuning knob. 200 steps is the depth a user
 * reaches for (few sessions undo past a handful, and the long tail is "get me
 * back to roughly where I was" rather than exact history), and on a 100k-line
 * document every retained step pins the strings it replaced — the text a
 * splice removed or the rows it copied — so an unbounded history is a slow
 * memory leak whose size is a function of how long the session ran. Bounding
 * the step count is what bounds the retained memory: 200 steps is a few
 * hundred small entry records for every realistic editing session, measured
 * against a document that is itself megabytes. Deeper history is not worth
 * unbounded copies.
 *
 * The cap is a hard ring size, not a hint: when the ring is full, pushing a
 * new entry EVICTS THE OLDEST ONE instead of growing. That is why the oldest
 * step of a long session is reliably un-undoable, and why depth is a constant
 * rather than a session-length function.
 */
export const HISTORY_CAP = 200;

/** Construction options for {@link History}. */
export interface HistoryOptions<T> {
  /** Ring size. Defaults to {@link HISTORY_CAP}; values below 1 fall back to it. */
  cap?: number;
  /**
   * The coalescing policy: return the entry that should replace `previous`
   * when `next` continues the same editing run, or `undefined` when `next`
   * must start a new entry. Omitted means "never coalesce" — every push is
   * its own step.
   *
   * The ring cannot know an entry's shape (see the module comment), so the
   * shape-dependent part of the rule lives here, with the caller that owns
   * the entry type.
   */
  merge?: (previous: T, next: T) => T | undefined;
}

/**
 * A bounded, ordered undo/redo history over caller-defined entries.
 *
 * ## What an entry is
 *
 * `T` is opaque here. The buffer owns the entry shape — the suggestion is an
 * invertible record of one logical edit (what changed, where, and enough text
 * to undo and redo it) — and this module never imports, inspects, or
 * constructs one. The ring only sequences entries, moves a cursor over them,
 * and drops the oldest when it is full.
 *
 * The cursor splits the ring into the applied prefix and the redo tail:
 * `undo()` steps it back and HANDS BACK the entry the caller must invert;
 * `redo()` steps it forward and hands back the entry to re-apply. Both return
 * `undefined` when there is nothing to do, so a key handler can call them
 * unconditionally.
 *
 * ## Coalescing
 *
 * A run of keystrokes is ONE undo step — typing `abcdef` is one undo, not
 * six — or the history is useless: a user would have to undo once per
 * character. This ring does not decide WHAT merges (that needs the entry
 * shape) — the caller's `merge` does, with the rule the editor documents:
 * a coalescing run continues while the incoming edit is a single-character
 * insert of the same kind, with no newline, at the caret the previous entry
 * left behind (a paste, an Enter, a delete, a cursor move, or a sequence gap
 * all fail one of those tests and start a new entry).
 *
 * What the ring owns is WHEN a run ends. A push starts a new entry, never
 * extending the previous one, as soon as any of these holds:
 *
 * 1. no `merge` was supplied;
 * 2. `merge` returns `undefined` for (previous, next) — the entry-shape rule
 *    above, including the sequence/time gap that a slow typist's pause, or an
 *    edit arriving from another source, shows up as;
 * 3. `breakCoalesce()` ran since the last push — the explicit seam the
 *    command layer uses for anything that ends a run without pushing an
 *    entry of its own (a cursor move, a mode switch, a save, a selection);
 * 4. `undo()`, `redo()`, or `clear()` ran since the last push — editing
 *    after time travel starts a new step, so a user who undoes and types does
 *    not silently extend the step they just undid.
 *
 * A new push also CLEARS the redo tail (standard editor semantics): the
 * moment a different edit is made, the future that was undone is gone.
 *
 * ## The ring
 *
 * The store is a fixed-cap array with a moving cursor — a ring in behaviour,
 * not in index arithmetic. At a cap of 200 the oldest-entry drop is a
 * `shift()` of at most 200 slots, i.e. nothing next to the edit that produced
 * the entry, and a modular-index version would buy microseconds while making
 * the undo/redo cursor harder to read.
 */
export class History<T> {
  #entries: T[] = [];
  #cursor = 0;
  #cap: number;
  #merge: ((previous: T, next: T) => T | undefined) | undefined;
  #coalescing = false;

  constructor(options: HistoryOptions<T> = {}) {
    const cap = options.cap ?? HISTORY_CAP;
    this.#cap = Number.isFinite(cap) && cap >= 1 ? Math.trunc(cap) : HISTORY_CAP;
    this.#merge = options.merge;
  }

  /** The ring size this history was built with. */
  get cap(): number {
    return this.#cap;
  }

  /** How many entries are retained (never more than {@link cap}). */
  get depth(): number {
    return this.#entries.length;
  }

  /** How many entries are applied — the cursor, in `0..depth`. */
  get position(): number {
    return this.#cursor;
  }

  /** True when {@link undo} would return an entry. */
  get canUndo(): boolean {
    return this.#cursor > 0;
  }

  /** True when {@link redo} would return an entry. */
  get canRedo(): boolean {
    return this.#cursor < this.#entries.length;
  }

  /**
   * Record an edit. See the class comment for when it extends the previous
   * entry instead of starting one, and for the redo tail it clears.
   */
  push(entry: T): void {
    if (this.#cursor < this.#entries.length) this.#entries.length = this.#cursor;
    if (this.#coalescing && this.#cursor > 0) {
      const previous = this.#entries[this.#cursor - 1];
      const merged = previous === undefined ? undefined : this.#merge?.(previous, entry);
      if (merged !== undefined) {
        this.#entries[this.#cursor - 1] = merged;
        return;
      }
    }
    this.#entries.push(entry);
    this.#cursor = this.#entries.length;
    this.#coalescing = true;
    while (this.#entries.length > this.#cap) {
      this.#entries.shift();
      this.#cursor -= 1;
    }
  }

  /**
   * Step back and return the entry to invert, or `undefined` when there is
   * nothing to undo. The entry stays in the ring: it is the redo of this
   * undo until a new push clears it.
   */
  undo(): T | undefined {
    this.#coalescing = false;
    if (this.#cursor === 0) return undefined;
    this.#cursor -= 1;
    return this.#entries[this.#cursor];
  }

  /**
   * Step forward and return the entry to re-apply, or `undefined` when there
   * is nothing to redo.
   */
  redo(): T | undefined {
    this.#coalescing = false;
    if (this.#cursor >= this.#entries.length) return undefined;
    const entry = this.#entries[this.#cursor];
    this.#cursor += 1;
    return entry;
  }

  /**
   * End the current coalescing run without pushing an entry: the next
   * `push` starts a new step even if `merge` would have accepted it.
   */
  breakCoalesce(): void {
    this.#coalescing = false;
  }

  /** Drop every entry — what opening another document does. */
  clear(): void {
    this.#entries = [];
    this.#cursor = 0;
    this.#coalescing = false;
  }
}
