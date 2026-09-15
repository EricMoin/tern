//! The overlay state: the modal stack, the find session and the replacement field.
//
// WHY THIS IS NOT IN `state.ts`. The overlay is a SEAM of its own: which modal is
// on top, what the find query is, what the replacement field holds. `state.ts`
// was over its module budget and this is the natural cut — the reducer that turns
// a search action into overlay state lives here, while the caret work a found
// match drives (`select`) stays in `state.ts`, because only the app owns the
// caret. The ONE-decision-point contract is untouched: `commands.ts` still decides
// what a key means and `plan.ts` still decides what is on screen; this module only
// holds the overlay's own live state.

import type { Buffer, Position } from "./buffer.ts";
import type { ModalId, SearchAction } from "./commands.ts";
import { graphemeStartBefore } from "./motions.ts";
import { SearchSession, type SearchMatch } from "./search.ts";

/**
 * The overlays the app has open, oldest first, and the search session they read.
 *
 * The three overlays share one stack: `find` can be raised from the editor, and
 * `replace` is raised on top of it and inherits the query. `state.ts` owns the
 * app's caret and asks this class for the match to select; nothing here touches a
 * buffer, a plan or a scene.
 */
export class OverlayState {
  #search = new SearchSession();
  #replacement = "";
  #modals: ModalId[] = [];

  /** The live find session (the query and the case flag). */
  get search(): SearchSession {
    return this.#search;
  }

  /** The replace overlay's own field. */
  get replacement(): string {
    return this.#replacement;
  }

  /** The top of the modal stack, or `null` in the editor. */
  get modal(): ModalId | null {
    return this.#modals[this.#modals.length - 1] ?? null;
  }

  /**
   * Reduce one search action. The caret-driving actions (`next`/`previous`) are
   * NOT handled here — they need the app's caret, so `state.ts` branches on them
   * before delegating; what remains is the overlay's own state.
   */
  reduce(action: SearchAction, text: string | undefined): void {
    if (action === "open") {
      this.#search.open("");
      this.push("find");
      return;
    }
    if (action === "close") {
      this.#search.close();
      this.pop("find");
      this.pop("replace");
      return;
    }
    if (action === "replace-open") {
      this.push("replace");
      return;
    }
    // next/previous/replace-current need the caret; state.ts branches first.
    if (action !== "append" && action !== "backspace") return;
    this.#editField(action, text ?? "");
  }

  /** Step the search and return the match the caret should land on. */
  step(buffer: Buffer, caret: Position, direction: 1 | -1): SearchMatch | null {
    return this.#search.step(buffer, caret, direction);
  }

  /** Raise `id` unless it is already on the stack. */
  push(id: ModalId | undefined): void {
    if (id !== undefined && !this.#modals.includes(id)) this.#modals.push(id);
  }

  /** Drop the top modal, or the one with `id` wherever it sits. */
  pop(id?: ModalId): void {
    const at = id === undefined ? this.#modals.length - 1 : this.#modals.lastIndexOf(id);
    if (at >= 0) this.#modals.splice(at, 1);
  }

  /** Type into the overlay's field: the query when finding, the replacement
   * when replacing. */
  #editField(action: "append" | "backspace", text: string): void {
    const target = this.modal === "replace" ? this.#replacement : this.#search.query;
    const next = action === "append"
      ? target + text
      : target.slice(0, graphemeStartBefore(target, target.length));
    if (this.modal === "replace") this.#replacement = next;
    else this.#search.open(next);
  }
}
