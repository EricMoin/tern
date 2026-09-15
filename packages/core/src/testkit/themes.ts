//! Two contrasting themes for the theme-switch tests.

import { ThemeOverrides } from "../index.ts";


/** The theme A / theme B pair for the golden + diff tests: the `input`
 * component preset drives the border (paint-visible in plain frames) and the
 * `primary` role drives the leaf fg/bg (visible in styled frames). */
export const THEME_A: ThemeOverrides = {
  palette: { primary: { fg: "#aa0000", bg: "#000011" } },
  components: { input: { fg: "#aa0000", bg: "#000011", border_style: "rounded" } },
};

export const THEME_B: ThemeOverrides = {
  palette: { primary: { fg: "#00bb00", bg: "#000022" } },
  components: { input: { fg: "#00bb00", bg: "#000022", border_style: "thick" } },
};
