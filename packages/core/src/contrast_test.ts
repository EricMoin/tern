// M4.5 WCAG contrast checker unit tests (subtask 2): the pure color math —
// `parseThemeColor` (hex / indexed / default), `relativeLuminance`,
// `contrastRatio`, and `auditTheme` — against hand-computed WCAG values.
//
// Everything here is pure data flow over the theme system's string colors;
// there is no engine or napi surface, so the tests run under plain
// `deno test` with no permission flags, exactly like the factory tests in
// `index_test.ts` (same `if (...) throw new Error(...)` assertion style).
//
// Reference values used below, computed by hand from the WCAG 2.1 formulas
// (linearize sRGB channels, `L = 0.2126R + 0.7152G + 0.0722B`, ratio
// `(L1 + 0.05) / (L2 + 0.05)` with L1 the lighter):
// - #000000 / #ffffff = 21.0:1 (exactly), #ffffff / #ffffff = 1.0:1
// - #ff0000 luminance = 0.2126 (a pure channel linearizes to 1)
// - #777777 luminance ≈ 0.184475; on white ≈ 4.478:1 (< 4.5),
//   #767676 on white ≈ 4.542:1 (> 4.5) — the mid-gray threshold crossing
// - the default theme's bg #21252b luminance ≈ 0.018209, so the default
//   palette fails exactly two roles at 4.5:1 — muted ≈ 2.546:1 and
//   border ≈ 1.579:1 (danger passes narrowly at ≈ 4.817:1)

import {
  auditTheme,
  contrastRatio,
  defaultTheme,
  mergeTheme,
  parseThemeColor,
  relativeLuminance,
  XTERM_256,
} from "./index.ts";
import type { Rgb, Theme } from "./index.ts";

/** Assert `actual` equals `expected` within `tolerance` (default
 * `1e-3`), throwing with `label` on mismatch. */
function assertClose(
  actual: number,
  expected: number,
  label: string,
  tolerance = 1e-3,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
    );
  }
}

// ---------------------------------------------------------------------------
// parseThemeColor
// ---------------------------------------------------------------------------

Deno.test("parseThemeColor parses #rrggbb hex (case-insensitive)", () => {
  const black = parseThemeColor("#000000");
  if (black === null || black.r !== 0 || black.g !== 0 || black.b !== 0) {
    throw new Error(`#000000 -> ${JSON.stringify(black)}`);
  }
  const white = parseThemeColor("#ffffff");
  if (white === null || white.r !== 255 || white.g !== 255 || white.b !== 255) {
    throw new Error(`#ffffff -> ${JSON.stringify(white)}`);
  }
  const oneDark = parseThemeColor("#61AFEF");
  if (
    oneDark === null || oneDark.r !== 0x61 || oneDark.g !== 0xaf ||
    oneDark.b !== 0xef
  ) {
    throw new Error(`#61AFEF -> ${JSON.stringify(oneDark)}`);
  }
});

Deno.test("parseThemeColor maps indexed:N through the fixed xterm 256 palette", () => {
  // System colors: 0 black, 15 bright white.
  const c0 = parseThemeColor("indexed:0");
  if (c0 === null || c0.r !== 0 || c0.g !== 0 || c0.b !== 0) {
    throw new Error(`indexed:0 -> ${JSON.stringify(c0)}`);
  }
  const c15 = parseThemeColor("indexed:15");
  if (c15 === null || c15.r !== 255 || c15.g !== 255 || c15.b !== 255) {
    throw new Error(`indexed:15 -> ${JSON.stringify(c15)}`);
  }
  // Cube corners: 16 is #000000, 231 is #ffffff, 196 is #ff0000,
  // 21 is #0000ff.
  const c16 = parseThemeColor("indexed:16");
  if (c16 === null || c16.r !== 0 || c16.g !== 0 || c16.b !== 0) {
    throw new Error(`indexed:16 -> ${JSON.stringify(c16)}`);
  }
  const c231 = parseThemeColor("indexed:231");
  if (c231 === null || c231.r !== 255 || c231.g !== 255 || c231.b !== 255) {
    throw new Error(`indexed:231 -> ${JSON.stringify(c231)}`);
  }
  const c196 = parseThemeColor("indexed:196");
  if (c196 === null || c196.r !== 255 || c196.g !== 0 || c196.b !== 0) {
    throw new Error(`indexed:196 -> ${JSON.stringify(c196)}`);
  }
  const c21 = parseThemeColor("indexed:21");
  if (c21 === null || c21.r !== 0 || c21.g !== 0 || c21.b !== 255) {
    throw new Error(`indexed:21 -> ${JSON.stringify(c21)}`);
  }
  // Grayscale ramp endpoints: 232 is #080808, 255 is #eeeeee.
  const c232 = parseThemeColor("indexed:232");
  if (c232 === null || c232.r !== 8 || c232.g !== 8 || c232.b !== 8) {
    throw new Error(`indexed:232 -> ${JSON.stringify(c232)}`);
  }
  const c255 = parseThemeColor("indexed:255");
  if (c255 === null || c255.r !== 238 || c255.g !== 238 || c255.b !== 238) {
    throw new Error(`indexed:255 -> ${JSON.stringify(c255)}`);
  }
});

Deno.test("XTERM_256 is the fixed 256-entry palette table", () => {
  if (XTERM_256.length !== 256) {
    throw new Error(`length = ${XTERM_256.length}`);
  }
  const spot: Array<[number, Rgb]> = [
    [0, { r: 0, g: 0, b: 0 }],
    [1, { r: 0x80, g: 0, b: 0 }],
    [9, { r: 255, g: 0, b: 0 }],
    [15, { r: 255, g: 255, b: 255 }],
    [196, { r: 255, g: 0, b: 0 }],
    [231, { r: 255, g: 255, b: 255 }],
    [232, { r: 8, g: 8, b: 8 }],
    [255, { r: 238, g: 238, b: 238 }],
  ];
  for (const [index, expected] of spot) {
    const entry = XTERM_256[index];
    if (
      entry === undefined || entry.r !== expected.r || entry.g !== expected.g ||
      entry.b !== expected.b
    ) {
      throw new Error(
        `XTERM_256[${index}] = ${JSON.stringify(entry)}, ` +
          `expected ${JSON.stringify(expected)}`,
      );
    }
  }
});

Deno.test("parseThemeColor returns null for default and unparseable colors", () => {
  if (parseThemeColor("default") !== null) {
    throw new Error("default must parse to null");
  }
  for (const bad of [
    "indexed:-1",
    "indexed:256",
    "indexed:abc",
    "indexed:",
    "indexed:1.5",
    "#12345",
    "#1234567",
    "#gggggg",
    "#123",
    "123456",
    "rgb(1,2,3)",
    "",
  ]) {
    if (parseThemeColor(bad) !== null) {
      throw new Error(`${JSON.stringify(bad)} must parse to null`);
    }
  }
});

// ---------------------------------------------------------------------------
// relativeLuminance
// ---------------------------------------------------------------------------

Deno.test("relativeLuminance: black is 0, white is 1", () => {
  if (relativeLuminance({ r: 0, g: 0, b: 0 }) !== 0) {
    throw new Error("black luminance must be 0");
  }
  if (relativeLuminance({ r: 255, g: 255, b: 255 }) !== 1) {
    throw new Error("white luminance must be 1");
  }
});

Deno.test("relativeLuminance: pure red is exactly 0.2126", () => {
  // A 255 channel linearizes to 1, so L = 0.2126·1 + 0.7152·0 + 0.0722·0.
  assertClose(
    relativeLuminance({ r: 255, g: 0, b: 0 }),
    0.2126,
    "pure red luminance",
    1e-9,
  );
});

Deno.test("relativeLuminance: mid-gray and the default theme bg", () => {
  assertClose(
    relativeLuminance({ r: 0x77, g: 0x77, b: 0x77 }),
    0.184475,
    "#777777 luminance",
  );
  assertClose(
    relativeLuminance({ r: 0x21, g: 0x25, b: 0x2b }),
    0.018209,
    "#21252b luminance",
  );
});

// ---------------------------------------------------------------------------
// contrastRatio
// ---------------------------------------------------------------------------

Deno.test("contrastRatio: #000000/#ffffff is 21:1, #ffffff/#ffffff is 1:1", () => {
  assertClose(contrastRatio("#000000", "#ffffff")!, 21, "black on white", 1e-6);
  assertClose(contrastRatio("#ffffff", "#ffffff")!, 1, "white on white", 1e-9);
});

Deno.test("contrastRatio is order-independent (lighter color always on top)", () => {
  assertClose(
    contrastRatio("#ffffff", "#000000")!,
    21,
    "white on black",
    1e-6,
  );
  if (
    contrastRatio("#000000", "#ffffff") !== contrastRatio("#ffffff", "#000000")
  ) {
    throw new Error("ratio must not depend on argument order");
  }
});

Deno.test("contrastRatio: a mid-gray pair crosses the 4.5 threshold", () => {
  // #767676 on white ≈ 4.542:1 — passes AA; #777777 on white ≈ 4.478:1 —
  // fails. One shade of gray straddles the 4.5 bar.
  const above = contrastRatio("#767676", "#ffffff")!;
  const below = contrastRatio("#777777", "#ffffff")!;
  assertClose(above, 4.542, "#767676 on white");
  assertClose(below, 4.478, "#777777 on white");
  if (!(above > 4.5 && below < 4.5)) {
    throw new Error(
      `expected a pair crossing 4.5: ${above} (above), ${below} (below)`,
    );
  }
});

Deno.test("contrastRatio resolves indexed colors through the palette", () => {
  // indexed:196 is #ff0000; on indexed:0 (#000000) the ratio is
  // (0.2126 + 0.05) / 0.05 = 5.252.
  assertClose(
    contrastRatio("indexed:196", "indexed:0")!,
    5.252,
    "indexed:196 on indexed:0",
  );
});

Deno.test("contrastRatio returns null when either color has no RGB value", () => {
  if (contrastRatio("default", "#ffffff") !== null) {
    throw new Error("default fg must yield null");
  }
  if (contrastRatio("#ffffff", "default") !== null) {
    throw new Error("default bg must yield null");
  }
  if (contrastRatio("indexed:999", "#ffffff") !== null) {
    throw new Error("out-of-range indexed fg must yield null");
  }
});

// ---------------------------------------------------------------------------
// auditTheme
// ---------------------------------------------------------------------------

/** The `scope:name` labels of a finding list, sorted — the shape the audit
 * set assertions compare. */
function findingLabels(
  findings: ReturnType<typeof auditTheme>,
): string[] {
  return findings.map((f) => `${f.scope}:${f.name}`).sort();
}

Deno.test("auditTheme reports the exact documented set for the default theme", () => {
  // The One-Dark default palette fails exactly two roles at 4.5:1 — muted
  // (≈ 2.546) and border (≈ 1.579); danger clears the bar narrowly
  // (≈ 4.817). The default component presets are all empty, so no
  // component pairs exist to audit.
  const findings = auditTheme(defaultTheme);
  if (findings.length !== 2) {
    throw new Error(`expected 2 findings, got ${JSON.stringify(findings)}`);
  }
  if (findings[0]!.scope !== "palette" || findings[1]!.scope !== "palette") {
    throw new Error(`unexpected scopes: ${JSON.stringify(findings)}`);
  }
  const muted = findings.find((f) => f.name === "muted");
  const border = findings.find((f) => f.name === "border");
  if (muted === undefined) throw new Error("muted must be flagged");
  if (border === undefined) throw new Error("border must be flagged");
  assertClose(muted.ratio, 2.546, "muted ratio");
  assertClose(border.ratio, 1.579, "border ratio");
  if (muted.threshold !== 4.5 || border.threshold !== 4.5) {
    throw new Error("threshold must be the default 4.5");
  }
  if (muted.fg !== defaultTheme.palette.muted.fg) {
    throw new Error(`muted fg = ${muted.fg}`);
  }
  if (muted.bg !== defaultTheme.palette.muted.bg) {
    throw new Error(`muted bg = ${muted.bg}`);
  }
});

Deno.test("auditTheme flags the expected entries of a low-contrast theme", () => {
  const lowContrast: Theme = mergeTheme(defaultTheme, {
    palette: {
      primary: { fg: "#777777", bg: "#ffffff" }, // ≈ 4.478:1 — just below
      secondary: { fg: "#000000", bg: "#000000" }, // 1:1
    },
    components: {
      input: { fg: "#999999", bg: "#ffffff" }, // ≈ 2.849:1 — fails
      status_bar: { fg: "#ffffff", bg: "#000000" }, // 21:1 — passes
    },
  });
  const labels = findingLabels(auditTheme(lowContrast));
  // The two overrides fail, plus the inherited muted/border roles; the
  // 21:1 status_bar preset and every other inherited entry pass.
  const expected = [
    "component:input",
    "palette:border",
    "palette:muted",
    "palette:primary",
    "palette:secondary",
  ].sort();
  if (JSON.stringify(labels) !== JSON.stringify(expected)) {
    throw new Error(`findings = ${JSON.stringify(labels)}`);
  }
});

Deno.test("auditTheme honors a custom threshold", () => {
  const theme = mergeTheme(defaultTheme, {
    palette: { primary: { fg: "#777777", bg: "#ffffff" } }, // ≈ 4.478
  });
  // At 4.5 primary fails; at 4 it passes; at 5 danger (≈ 4.817) joins.
  const at45 = findingLabels(auditTheme(theme));
  if (
    JSON.stringify(at45) !==
      JSON.stringify(["palette:border", "palette:muted", "palette:primary"])
  ) {
    throw new Error(`at 4.5: ${JSON.stringify(at45)}`);
  }
  const at4 = findingLabels(auditTheme(theme, 4));
  if (
    JSON.stringify(at4) !== JSON.stringify(["palette:border", "palette:muted"])
  ) {
    throw new Error(`at 4: ${JSON.stringify(at4)}`);
  }
  const at5 = findingLabels(auditTheme(theme, 5));
  if (
    JSON.stringify(at5) !==
      JSON.stringify([
        "palette:border",
        "palette:danger",
        "palette:muted",
        "palette:primary",
      ])
  ) {
    throw new Error(`at 5: ${JSON.stringify(at5)}`);
  }
});

Deno.test("auditTheme skips pairs with a default/unparseable color", () => {
  const theme = mergeTheme(defaultTheme, {
    palette: {
      // bg "default" has no RGB value — the role is skipped, never a crash.
      primary: { bg: "default" },
      // An unparseable fg is skipped the same way.
      danger: { fg: "not-a-color" },
    },
  });
  const labels = findingLabels(auditTheme(theme));
  // Only the inherited muted/border failures remain; primary and danger
  // are skipped (no ratio exists), every other role passes.
  if (
    JSON.stringify(labels) !== JSON.stringify(["palette:border", "palette:muted"])
  ) {
    throw new Error(`findings = ${JSON.stringify(labels)}`);
  }
});

Deno.test("auditTheme reports component preset pairs that define both colors", () => {
  const theme = mergeTheme(defaultTheme, {
    components: {
      // Defines both colors: audited (fails).
      checkbox: { fg: "#999999", bg: "#ffffff" },
      // Defines only fg: no pair exists — skipped.
      spinner: { fg: "#333333" },
    },
  });
  const findings = auditTheme(theme);
  const checkbox = findings.find((f) => f.name === "checkbox");
  if (checkbox === undefined) {
    throw new Error(`checkbox must be flagged: ${JSON.stringify(findings)}`);
  }
  if (checkbox.scope !== "component") {
    throw new Error(`checkbox scope = ${checkbox.scope}`);
  }
  if (checkbox.fg !== "#999999" || checkbox.bg !== "#ffffff") {
    throw new Error(`checkbox colors = ${checkbox.fg}/${checkbox.bg}`);
  }
  if (findings.some((f) => f.name === "spinner")) {
    throw new Error("spinner (fg only) must not be flagged");
  }
});
