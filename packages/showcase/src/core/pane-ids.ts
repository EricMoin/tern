//! The auxiliary pane ids — the vocabulary the command table, the intent union
//! and the plan's modal ids share.
//
// It lives alone so that `commands.ts` (which must recognize a pane key) and
// `panes.ts` (which builds the plan rows) can both name a pane without importing
// each other: the id union has no dependencies, so it is the one safe seam.

/** The auxiliary panes: everything the editor is surrounded by that is not the
 * document, the file list, the mode line or the find/replace/help overlays. */
export type AuxPaneId =
  | "picker" | "palette" | "preferences" | "theme" | "profile" | "diff" | "a11y";

/** Every auxiliary pane, in the order the help/palette vocabulary uses. */
export const AUX_PANES: readonly AuxPaneId[] = [
  "picker", "palette", "preferences", "theme", "profile", "diff", "a11y",
];

/** Whether `id` names an auxiliary pane. */
export function isAuxPane(id: string | null | undefined): id is AuxPaneId {
  return id !== null && id !== undefined && (AUX_PANES as readonly string[]).includes(id);
}
