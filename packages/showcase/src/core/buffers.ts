//! The buffer set: every open document, and which one is ACTIVE.
//
// WHY THIS IS NOT IN `state.ts`. Multiple buffers are a seam of their own — a slot
// holds the editing session, the caret model, the scroll offset, the follow flag
// and the path, and the set holds the list and the active index. `state.ts` was
// over its module budget and this is the natural cut. The ONE-decision-point
// contract is untouched: the app still reduces intents and the plan still decides
// what is on screen; this module only holds the documents.
//
// THE ACCESSORS ARE THE POINT. A reducer reads `this.#editing` / `this.#caret` /
// `this.#scroll` exactly as it did for one buffer, so "one buffer" and "many
// buffers" are the same code path rather than two.

import { Buffer } from "./buffer.ts";
import { editingState, type EditingState } from "./edits.ts";
import { NO_TITLE, type TabsInput } from "./plan.ts";
import { SelectionModel, type Selection } from "./selection.ts";

/** Everything one open buffer owns. */
export interface BufferSlot {
  editing: EditingState;
  caret: SelectionModel;
  scroll: number;
  /** Whether the view follows the caret (see `state.ts`'s `plan`). */
  followCaret: boolean;
  path: string | null;
}

/** The open documents, oldest first, with one active index. */
export class BufferSet {
  #slots: BufferSlot[];
  #active = 0;

  constructor(buffer: Buffer, path: string | null, historyCap?: number) {
    this.#slots = [makeSlot(buffer, path, historyCap)];
  }

  /** How many buffers are open. */
  get count(): number { return this.#slots.length; }

  /** The active buffer's index. */
  get activeIndex(): number { return this.#active; }

  /** The active slot, for the plan's tab strip and for a host. */
  get slot(): BufferSlot { return this.#slots[this.#active]!; }

  get editing(): EditingState { return this.slot.editing; }
  set editing(value: EditingState) { this.slot.editing = value; }
  get caret(): SelectionModel { return this.slot.caret; }
  get scroll(): number { return this.slot.scroll; }
  set scroll(value: number) { this.slot.scroll = value; }
  get followCaret(): boolean { return this.slot.followCaret; }
  set followCaret(value: boolean) { this.slot.followCaret = value; }
  get path(): string | null { return this.slot.path; }
  set path(value: string | null) { this.slot.path = value; }

  /** The active buffer's selection, or `null`. */
  get selection(): Selection | null { return this.caret.selection; }

  /** Open a new buffer and make it active. */
  open(text: string, path: string | null, historyCap?: number): void {
    this.#slots.push(makeSlot(Buffer.fromString(text), path, historyCap));
    this.#active = this.#slots.length - 1;
  }

  /** Close the active buffer. The last buffer is emptied rather than removed, so
   * the app always has a document to edit. */
  close(): void {
    const slot = this.#slots[0]!;
    if (this.#slots.length <= 1) {
      slot.editing = editingState(new Buffer(), slot.editing.history.cap);
      slot.caret.moveTo({ row: 0, col: 0 });
      slot.scroll = 0;
      slot.followCaret = true;
      slot.path = null;
      return;
    }
    this.#slots.splice(this.#active, 1);
    this.#active = Math.min(this.#active, this.#slots.length - 1);
  }

  /** Make buffer `index` active, clamped into range. */
  select(index: number): void {
    const target = Math.trunc(index);
    this.#active = Math.max(0, Math.min(this.#slots.length - 1, Number.isFinite(target) ? target : 0));
  }

  /** Move to the next (`delta` 1) or previous (-1) buffer, wrapping. */
  step(delta: 1 | -1): void {
    if (this.#slots.length < 2) return;
    const count = this.#slots.length;
    this.#active = (this.#active + delta + count) % count;
  }

  /** The open buffers as the plan's tab strip, or `undefined` for one buffer — a
   * single buffer paints no strip. */
  tabs(): TabsInput | undefined {
    if (this.#slots.length < 2) return undefined;
    return {
      labels: this.#slots.map((slot) => slot.path ?? NO_TITLE),
      active: this.#active,
      dirty: this.#slots.map((slot) => slot.editing.buffer.dirty),
    };
  }
}

/** A fresh slot over `buffer`. */
function makeSlot(buffer: Buffer, path: string | null, historyCap?: number): BufferSlot {
  return {
    editing: editingState(buffer, historyCap),
    caret: new SelectionModel(),
    scroll: 0,
    followCaret: true,
    path,
  };
}
