/**
 * The M4.5 WCAG contrast checker: pure color math over the theme system's
 * string color format — `#rrggbb` hex, `indexed:N` (a slot in the fixed
 * xterm 256-color palette, see {@link XTERM_256}), or `default` (the
 * terminal's default color, which carries no concrete RGB value).
 *
 * Everything here is a pure function over plain data — there is no engine
 * or napi surface, and no module state beyond the constant palette table —
 * so the checker runs anywhere the theme runs (unit tests, build-time
 * linting of a theme, a runtime `--check-contrast` flag). The math follows
 * the WCAG 2.x definitions:
 *
 * - **Relative luminance** (WCAG 2.1 §1.4.3): each sRGB channel is
 *   linearized (`c / 12.92` below `0.04045`, `((c + 0.055) / 1.055) ^ 2.4`
 *   above), then `L = 0.2126·R + 0.7152·G + 0.0722·B`.
 * - **Contrast ratio** (WCAG 2.1 §1.4.3): `(L1 + 0.05) / (L2 + 0.05)`
 *   where `L1` is the lighter of the two colors and `L2` the darker — so
 *   the ratio is always `>= 1` and order-independent.
 *
 * `auditTheme` applies the default AA threshold of `4.5:1` (the large-text
 * / UI-component bar) to every fg/bg pair a theme carries — each palette
 * role and each component preset that defines both colors.
 */

import {
  THEME_COMPONENTS,
  THEME_ROLES,
} from "./index.ts";
import type {
  Theme,
  ThemeComponent,
  ThemeRole,
} from "./index.ts";

/** An RGB color with 8-bit channels (`0`–`255`), as parsed from a theme
 * color string. */
export interface Rgb {
  /** The red channel, `0`–`255`. */
  r: number;
  /** The green channel, `0`–`255`. */
  g: number;
  /** The blue channel, `0`–`255`. */
  b: number;
}

/** The 16 system colors (indices `0`–`15`), in the fixed xterm order. */
const SYSTEM_COLORS: readonly (readonly [number, number, number])[] = [
  [0x00, 0x00, 0x00], //  0 black
  [0x80, 0x00, 0x00], //  1 red
  [0x00, 0x80, 0x00], //  2 green
  [0x80, 0x80, 0x00], //  3 yellow
  [0x00, 0x00, 0x80], //  4 blue
  [0x80, 0x00, 0x80], //  5 magenta
  [0x00, 0x80, 0x80], //  6 cyan
  [0xc0, 0xc0, 0xc0], //  7 white
  [0x80, 0x80, 0x80], //  8 bright black
  [0xff, 0x00, 0x00], //  9 bright red
  [0x00, 0xff, 0x00], // 10 bright green
  [0xff, 0xff, 0x00], // 11 bright yellow
  [0x00, 0x00, 0xff], // 12 bright blue
  [0xff, 0x00, 0xff], // 13 bright magenta
  [0x00, 0xff, 0xff], // 14 bright cyan
  [0xff, 0xff, 0xff], // 15 bright white
];

/** The 6×6×6 cube's per-axis levels, in ascending order. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/** Assemble the 256-entry xterm palette from its three fixed ranges. Pure
 * and deterministic: the table is a constant of the xterm specification,
 * computed here instead of hand-listed so the ranges stay auditable. */
function buildXterm256Palette(): Rgb[] {
  const table: Rgb[] = new Array(256);
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = SYSTEM_COLORS[i]!;
    table[i] = { r, g, b };
  }
  for (let i = 16; i < 232; i++) {
    const n = i - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n / 6) % 6);
    const b = n % 6;
    table[i] = {
      r: CUBE_LEVELS[r]!,
      g: CUBE_LEVELS[g]!,
      b: CUBE_LEVELS[b]!,
    };
  }
  for (let i = 232; i < 256; i++) {
    const level = 8 + 10 * (i - 232);
    table[i] = { r: level, g: level, b: level };
  }
  return table;
}

/**
 * The fixed xterm 256-color palette — the standard table `indexed:N` refers
 * to, built from the documented xterm ranges:
 *
 * - `0`–`15`: the 16 system colors (the VGA palette: black, red, green,
 *   yellow, blue, magenta, cyan, white, then the bright variants).
 * - `16`–`231`: the 6×6×6 color cube — index `i` maps to
 *   `(r, g, b)` in `0..5` via `r = (i-16) / 36`, `g = ((i-16) / 6) % 6`,
 *   `b = (i-16) % 6`, with component levels `[0, 95, 135, 175, 215, 255]`.
 * - `232`–`255`: the 24-step grayscale ramp, `level = 8 + 10·(i - 232)`
 *   (`#080808` … `#eeeeee`).
 *
 * The palette is fixed by the xterm specification (terminfo `xterm-256color`
 * `colors`/`pairs`), so it needs no external dependency and is frozen at
 * module load. Spot checks: `indexed:196` is `#ff0000`, `indexed:21` is
 * `#0000ff`, `indexed:232` is `#080808`.
 */
export const XTERM_256: readonly Rgb[] = buildXterm256Palette();

/**
 * Parse a theme color string into concrete RGB channels:
 *
 * - `"#rrggbb"` — a 6-digit hex color (case-insensitive).
 * - `"indexed:N"` — slot `N` (`0`–`255`) of the fixed xterm 256-color
 *   palette {@link XTERM_256}.
 *
 * Returns `null` when the color carries no concrete RGB value: `"default"`
 * (the terminal's default color — the theme's only unknowable color) and
 * any unparseable string (a malformed hex, a non-numeric or out-of-range
 * `indexed:N`, an unknown format). The tolerant contract mirrors how the
 * engine treats unknown colors: an audit can never throw on a theme.
 */
export function parseThemeColor(color: string): Rgb | null {
  if (color.startsWith("#")) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
    return {
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16),
    };
  }
  if (color.startsWith("indexed:")) {
    const digits = color.slice("indexed:".length);
    if (!/^\d+$/.test(digits)) return null;
    const index = Number(digits);
    if (index > 255) return null;
    return XTERM_256[index]!;
  }
  return null;
}

/** Linearize one sRGB channel (`0`–`255`) to its linear-light value, per
 * the WCAG 2.1 relative-luminance formula: `c / 12.92` below the `0.04045`
 * threshold, `((c + 0.055) / 1.055) ^ 2.4` above. */
function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The WCAG 2.1 relative luminance of an RGB color: the sRGB channels
 * linearized and weighted `0.2126·R + 0.7152·G + 0.0722·B`. The value is in
 * `[0, 1]` — `0` for black, `1` for white — and is the basis of the
 * contrast ratio (see {@link contrastRatio}).
 */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearizeChannel(rgb.r) +
    0.7152 * linearizeChannel(rgb.g) +
    0.0722 * linearizeChannel(rgb.b);
}

/**
 * The WCAG 2.1 contrast ratio between two theme color strings:
 * `(L1 + 0.05) / (L2 + 0.05)`, where `L1` is the relative luminance of the
 * lighter color and `L2` of the darker — so the ratio is always `>= 1` and
 * the argument order does not matter (`contrastRatio(fg, bg)` and
 * `contrastRatio(bg, fg)` agree). `#000000` on `#ffffff` is `21:1`;
 * identical colors are `1:1`.
 *
 * Returns `null` when either color cannot be resolved to RGB (see
 * {@link parseThemeColor}) — e.g. a `default` color has no concrete value
 * to measure against, so no ratio exists.
 */
export function contrastRatio(fg: string, bg: string): number | null {
  const fgRgb = parseThemeColor(fg);
  const bgRgb = parseThemeColor(bg);
  if (fgRgb === null || bgRgb === null) return null;
  const fgL = relativeLuminance(fgRgb);
  const bgL = relativeLuminance(bgRgb);
  return (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05);
}

/**
 * One contrast finding from {@link auditTheme}: a fg/bg pair from a theme
 * whose WCAG contrast ratio falls below the audit threshold. `ratio` and
 * `threshold` are kept on the finding so a consumer can render
 * `"muted: 2.55:1 (below 4.5:1)"` without re-computing anything.
 */
export interface ContrastFinding {
  /** Where the pair lives: a palette `role` or a component `kind`. */
  scope: "palette" | "component";
  /** The palette role (`"primary"`, `"danger"`, ...) or component kind
   * (`"input"`, `"status_bar"`, ...) the pair belongs to. */
  name: ThemeRole | ThemeComponent;
  /** The foreground color string exactly as written in the theme. */
  fg: string;
  /** The background color string exactly as written in the theme. */
  bg: string;
  /** The computed WCAG contrast ratio (`>= 1`). */
  ratio: number;
  /** The threshold the ratio falls below. */
  threshold: number;
}

/**
 * Audit every fg/bg pair a theme carries against `threshold` (default
 * `4.5`, the WCAG AA bar for normal text and UI components), returning the
 * pairs that fall below it:
 *
 * - every palette role (`theme.palette[role].fg` on `.bg`), and
 * - every component preset that defines **both** `fg` and `bg`
 *   (`theme.components[kind]`); a preset with only one color defines no
 *   pair, so it is skipped.
 *
 * A pair is skipped, never reported, when either color cannot be resolved
 * to RGB (`default` or an unparseable string — see {@link parseThemeColor}):
 * an unknowable color has no ratio. Findings come back in a deterministic
 * order — palette roles in {@link THEME_ROLES} order, then component
 * presets in {@link THEME_COMPONENTS} order.
 */
export function auditTheme(theme: Theme, threshold = 4.5): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const role of THEME_ROLES) {
    const colors = theme.palette[role];
    if (colors === undefined) continue;
    const ratio = contrastRatio(colors.fg, colors.bg);
    if (ratio !== null && ratio < threshold) {
      findings.push({
        scope: "palette",
        name: role,
        fg: colors.fg,
        bg: colors.bg,
        ratio,
        threshold,
      });
    }
  }
  for (const kind of THEME_COMPONENTS) {
    const preset = theme.components[kind];
    if (preset === undefined) continue;
    if (preset.fg === undefined || preset.bg === undefined) continue;
    const ratio = contrastRatio(preset.fg, preset.bg);
    if (ratio !== null && ratio < threshold) {
      findings.push({
        scope: "component",
        name: kind,
        fg: preset.fg,
        bg: preset.bg,
        ratio,
        threshold,
      });
    }
  }
  return findings;
}
