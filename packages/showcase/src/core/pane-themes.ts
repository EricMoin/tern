//! The theme and tab-width vocabulary the preferences pane offers.
//!
//! WHY THIS IS NOT IN `panes.ts`. The named themes, the overrides each applies and
//! the "what comes next" rules over them are a fixed table plus two pure lookups;
//! `panes.ts` was over its module budget (CONVENTION: 400 lines) and this is a seam
//! of its own. The app still owns the ONE call into the framework's `setTheme`, and
//! the pane's rows still paint through the framework's own glyph vocabulary.

import type { ThemeOverrides } from "@tern-tui/core";

/** A named theme the preferences pane offers, and the overrides it applies
 * through the framework's own setTheme. */
export interface ThemeChoice {
  readonly name: string;
  readonly overrides: ThemeOverrides;
}

/** The shipped theme choices. one-dark is the framework default (no
 * overrides), so switching back to it is the empty-override merge. */
export const THEMES: readonly ThemeChoice[] = [
  { name: "one-dark", overrides: {} },
  {
    name: "solarized",
    overrides: {
      palette: {
        primary: { fg: "#268bd2", bg: "#002b36" },
        secondary: { fg: "#93a1a1", bg: "#002b36" },
        success: { fg: "#859900", bg: "#002b36" },
        danger: { fg: "#dc322f", bg: "#002b36" },
        warning: { fg: "#b58900", bg: "#002b36" },
        muted: { fg: "#839496", bg: "#002b36" },
        border: { fg: "#586e75", bg: "#002b36" },
      },
    },
  },
  {
    name: "contrast",
    overrides: {
      palette: {
        primary: { fg: "#ffffff", bg: "#000000" },
        secondary: { fg: "#ffffff", bg: "#000000" },
        success: { fg: "#5fff87", bg: "#000000" },
        danger: { fg: "#ff6b6b", bg: "#000000" },
        warning: { fg: "#ffd75f", bg: "#000000" },
        muted: { fg: "#d0d0d0", bg: "#000000" },
        border: { fg: "#8a8a8a", bg: "#000000" },
      },
    },
  },
];

/** The choice named name, or the first choice (the app always has a theme). */
export function themeChoice(name: string): ThemeChoice {
  return THEMES.find((choice) => choice.name === name) ?? THEMES[0]!;
}

/** The name of the choice after name, wrapping. */
export function nextThemeName(name: string): string {
  const at = THEMES.findIndex((choice) => choice.name === name);
  return THEMES[(at + 1) % THEMES.length]!.name;
}

/** The tab widths the preferences pane cycles through. */
export const TAB_WIDTHS: readonly number[] = [2, 4, 8];

/** The tab width after width, wrapping to the first. */
export function nextTabWidth(width: number): number {
  const at = TAB_WIDTHS.indexOf(width);
  return TAB_WIDTHS[(at + 1) % TAB_WIDTHS.length]!;
}
