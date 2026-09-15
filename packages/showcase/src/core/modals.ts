//! What the three modal overlays SAY: the content the plan lays them out with.
//!
//! The plan decides WHERE the overlay's cells go (plan-modals.ts); this module
//! decides WHAT they say — the overlay's title, the live query and the replacement,
//! the match count, the replace preview, and the help overlay's shortcut rows. It
//! is the content half of the same decision point, kept beside the layout for the
//! same reason: `state.ts` was already at 410 lines against its 400-line module
//! budget, and "what the overlay says" is a seam of its own.
//!
//! WHAT IS NOT HERE. No layout (the plan measures and truncates), no scene, no
//! renderer, no terminal — the strings below are what a plan lays out and nothing
//! else knows about them.
//!
//! THE MATCHES COME FROM THE SEARCH MODULE, not from a second scan: `findMatches`
//! (search.ts:57) is the same literal scan `replaceAllEdits` (search.ts:138) walks,
//! so the count the overlay reports and the edits `ctrl+enter` applies cannot
//! disagree.

import { getTheme, type KeyCombo } from "@tern-tui/core";
import type { Buffer } from "./buffer.ts";
import type { ModalId } from "./commands.ts";
import { isAuxPane, type PaneState, paneModal } from "./panes.ts";
import type { ModalField, ModalInput, ModalItem } from "./plan-modals.ts";
import { findMatches, type SearchMatch } from "./search.ts";

/** The overlay's own title, per SEARCH overlay. The auxiliary panes carry their
 * titles in panes.ts and are built there. */
const TITLE: Record<"find" | "replace" | "help", string> = { find: "Find", replace: "Replace", help: "Help" };

/** The query field's label — the same word in both search overlays, because the
 * replace overlay inherits the query the find overlay typed. */
const QUERY_LABEL = "find: ";

/** The replacement field's label. */
const REPLACEMENT_LABEL = "replace: ";

/** The case flag as a switch: on is "Aa", off is "aa" — the overlay's own two-cell
 * readout of the flag the toggle owns (`core-toggle-find-case`). */
const CASE_ON = "Aa";
const CASE_OFF = "aa";

/** The most replace-preview rows the overlay offers. The plan windows whatever it
 * is given to the box's own height; this bound is what keeps a document with a
 * hundred thousand matches from building a hundred thousand strings per frame. The
 * COUNT in the footer is always the true one. */
export const PREVIEW_LIMIT = 64;

/** Everything the overlays read from the app — handed over by `state.ts`, which
 * owns the live session. */
export interface ModalSource {
  readonly id: ModalId;
  readonly buffer: Buffer;
  readonly query: string;
  readonly replacement: string;
  readonly caseSensitive: boolean;
  /** The auxiliary panes' own state (panes.ts); consulted only for a pane id. */
  readonly panes: PaneState;
  /** The file list the picker filters. */
  readonly files: readonly string[];
  /** The keymap's own listing (`Keymap.list()`, packages/core/src/keymap.ts:132) —
   * the same registry the dispatcher matches against and `HelpPanel` renders. */
  readonly shortcuts: readonly { readonly combo: KeyCombo; readonly description?: string }[];
}

/**
 * The overlay the app is showing, as the plan's own input.
 *
 * The three overlays share one shape: a title, the fields the user can see (the
 * find query, the replacement), a list of rows (the shortcut registry, the replace
 * preview) and a footer. `help` has no fields — nothing is typed into it — and
 * `find` has no rows beyond its field: what it has to say is the query and how many
 * times it occurs.
 */
export function modalInputFor(source: ModalSource): ModalInput {
  // The auxiliary panes are overlays too: their rows are built from the live pane
  // state (panes.ts) and laid out by the same modal plan.
  if (isAuxPane(source.id)) {
    return paneModal(source.id, source.panes, {
      files: source.files,
      bufferText: source.buffer.text(),
      theme: getTheme(),
    });
  }
  const title = TITLE[source.id];
  if (source.id === "help") {
    const items = shortcutItems(source.shortcuts);
    return { id: source.id, title, items, status: countLabel(items.length, "shortcut", "shortcuts") };
  }

  const matches = findMatches(source.buffer, source.query, { caseSensitive: source.caseSensitive });
  const fields: ModalField[] = [{ label: QUERY_LABEL, text: source.query, caret: source.id === "find" }];
  if (source.id === "replace") fields.push({ label: REPLACEMENT_LABEL, text: source.replacement, caret: true });
  const items = source.id === "replace" ? previewItems(source.buffer, matches, source.replacement) : [];
  const input: ModalInput = {
    id: source.id,
    title,
    fields,
    status: matchStatus(source.query, matches.length, source.caseSensitive),
  };
  // exactOptionalPropertyTypes: only attach the rows when there are any.
  return items.length === 0 ? input : { ...input, items };
}

/**
 * The replace overlay's preview rows: where each match is, what it says now, and
 * what replace-all would write there.
 *
 * This is the summary the overlay can already stand behind — every row comes from
 * the SAME scan `replaceAllEdits` performs, so the preview and the edit agree by
 * construction. The framework's `DiffView` (the registry's
 * `core-diffview-replace-preview`) is a diff of two DOCUMENTS; pointing it at this
 * document's before/after text is the pane work of the next subtask, and the plan's
 * row model is what it will render into.
 */
function previewItems(buffer: Buffer, matches: readonly SearchMatch[], replacement: string): ModalItem[] {
  return matches.slice(0, PREVIEW_LIMIT).map((match) => ({
    key: (match.row + 1) + ":" + (match.col + 1),
    text: matchedText(buffer, match) + " -> " + replacement,
  }));
}

/** The text one match covers. A match never spans a line: the scan is line by line
 * (search.ts:40-56), so `row` and `col` are all the range needs. */
function matchedText(buffer: Buffer, match: SearchMatch): string {
  return buffer.lineAt(match.row).slice(match.col, match.col + match.length);
}

/** The help overlay's rows: the DESCRIBED shortcuts, in registration order — the
 * framework's own rule (`HelpPanel` skips entries registered without a
 * description, packages/core/src/keymap.ts:217). The key column is the plan's: it
 * pads every row's key to the widest one (plan-modals.ts), exactly as `HelpPanel`
 * does. */
function shortcutItems(
  shortcuts: readonly { readonly combo: KeyCombo; readonly description?: string }[],
): ModalItem[] {
  const items: ModalItem[] = [];
  for (const entry of shortcuts) {
    if (entry.description === undefined || entry.description === "") continue;
    items.push({ key: comboHint(entry.combo), text: entry.description });
  }
  return items;
}

/**
 * A combo as `mod1+mod2+key` (`ctrl+k`, `shift+enter`, `f1`) — the framework's
 * own help hint, verbatim: modifiers first, then the key name.
 *
 * THIS IS A SECOND IMPLEMENTATION OF A RULE THE FRAMEWORK ALREADY OWNS, and it is
 * here because the barrel exports no formatter: `helpComboHint`
 * (`packages/core/src/keymap.ts:183-193`) is module-private, so the only public way
 * to spell a combo is `HelpPanel`'s scene — which is a scene, not a string the plan
 * can lay out. REPORTED as a framework gap with those file:lines; the fix is to
 * export it from the barrel.
 */
export function comboHint(combo: KeyCombo): string {
  const mods: string[] = [];
  if (combo.ctrl) mods.push("ctrl");
  if (combo.alt) mods.push("alt");
  if (combo.shift) mods.push("shift");
  if (combo.meta) mods.push("meta");
  if (combo.super) mods.push("super");
  return [...mods, combo.name].join("+");
}

/** The footer of a search overlay: what the document holds and the case flag. */
function matchStatus(query: string, count: number, caseSensitive: boolean): string {
  const flag = caseSensitive ? CASE_ON : CASE_OFF;
  if (query === "") return "no query   " + flag;
  if (count === 0) return "no match   " + flag;
  return countLabel(count, "match", "matches") + "   " + flag;
}

/** `count` of a noun, in the number the count asks for. The plural is spelled
 * out rather than suffixed: "matchs" is what `noun + "s"` produces. */
function countLabel(count: number, singular: string, plural: string): string {
  return count + " " + (count === 1 ? singular : plural);
}
