//! The auxiliary panes: the file picker, the command palette, preferences, the
//! theme audit, the render profile, the external-change diff and the a11y stream.
//!
//! Every pane is PLAN DATA — a title, fields, rows and a status — plus the state
//! the rows are a function of. Nothing here mounts a scene or mutates one: the
//! framework elements below (Select, BarChart, Sparkline, DiffView and the
//! checkbox/radio/toggle glyph vocabulary) are consulted for their PURE
//! composition helpers, so a pane cannot drift from the element it dogfoods. The
//! plan's modal representation (plan-modals.ts) is what lays the rows out; this
//! module only says what they ARE.
//!
//! THE DIFF PANE IS COMMAND-DRIVEN, NOT WATCHED. There is no file watcher: the
//! host hands the app the external text it read (AppOptions.external /
//! HeadlessApp.noteExternal), and the diff-open command shows the comparison.
//! Applying it is a second explicit command (the pane's own activate).

import {
  auditTheme,
  BarChart,
  CHECKBOX_CHECKED_GLYPH,
  CHECKBOX_UNCHECKED_GLYPH,
  DiffView,
  RADIO_SELECTED_GLYPH,
  RADIO_UNSELECTED_GLYPH,
  Select,
  Sparkline,
  TOGGLE_OFF_GLYPH,
  TOGGLE_ON_GLYPH,
  visibleOptions,
  type DiffLine,
  type Node,
  type SceneSemanticsJs,
  type Theme,
  type ThemeOverrides,
} from "@tern-tui/core";
import { COMMANDS, type CommandId } from "./commands.ts";
import { isAuxPane, type AuxPaneId } from "./pane-ids.ts";
import type { ModalField, ModalInput, ModalItem } from "./plan-modals.ts";
import type { ScreenPlan } from "./plan.ts";

export { AUX_PANES, isAuxPane } from "./pane-ids.ts";
export type { AuxPaneId } from "./pane-ids.ts";

/** The overlay title of each pane. */
const PANE_TITLE: Record<AuxPaneId, string> = {
  picker: "Open file",
  palette: "Commands",
  preferences: "Preferences",
  theme: "Theme audit",
  profile: "Render profile",
  diff: "External change",
  a11y: "A11y stream",
};

/** The pane's own title. */
export function paneTitle(id: AuxPaneId): string {
  return PANE_TITLE[id];
}

// --- theme switching (the framework's setTheme is the ONE switch) -------------

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

// --- the pane state ----------------------------------------------------------

/** The four preference toggles the preferences pane owns. */
export interface Preferences {
  /** The plan's soft-wrap toggle (mirrors HeadlessApp.wrap). */
  wrap: boolean;
  /** The tab width insert-tab expands to. */
  tabWidth: number;
  /** The active theme's name (applied through setTheme). */
  theme: string;
  /** Whether the a11y JSONL stream is on. */
  a11y: boolean;
}

/** One measured frame: the plan build cost and the window it produced. */
export interface FrameSample {
  /** The wall-clock cost of one buildPlan call, in milliseconds. */
  readonly planMs: number;
  /** The document rows the plan's viewport walked. */
  readonly lines: number;
  /** The editor window's rows. */
  readonly rows: number;
}

/** The bound on the frame samples the profile pane charts. */
export const SAMPLE_CAP = 256;

/** The bound on the a11y JSONL lines the pane shows. */
export const A11Y_LINE_CAP = 64;

/** The whole auxiliary-pane state. */
export interface PaneState {
  /** The pane on top, or null when none is open. */
  id: AuxPaneId | null;
  /** The highlighted row's index. */
  index: number;
  /** The picker/palette typeahead query. */
  query: string;
  readonly prefs: Preferences;
  readonly samples: FrameSample[];
  /** The external text the host read, or null when none is pending. */
  external: string | null;
  /** The a11y stream's JSONL lines, oldest first. */
  readonly a11yLines: string[];
}

/** A fresh pane state: no pane, one-dark, wrap on, tab width 4. */
export function newPaneState(): PaneState {
  return {
    id: null,
    index: 0,
    query: "",
    prefs: { wrap: true, tabWidth: 4, theme: THEMES[0]!.name, a11y: false },
    samples: [],
    external: null,
    a11yLines: [],
  };
}

/** Raise id, resetting the window the previous pane left behind. */
export function openPane(state: PaneState, id: AuxPaneId): void {
  state.id = id;
  state.index = 0;
  state.query = "";
}

/** Drop the current pane. */
export function closePane(state: PaneState): void {
  state.id = null;
}

/** Append a frame sample, keeping the newest SAMPLE_CAP. */
export function recordSample(state: PaneState, sample: FrameSample): void {
  state.samples.push(sample);
  if (state.samples.length > SAMPLE_CAP) state.samples.splice(0, state.samples.length - SAMPLE_CAP);
}

/** Append an a11y line, keeping the newest A11Y_LINE_CAP. */
export function recordA11yLine(state: PaneState, line: string): void {
  state.a11yLines.push(line);
  if (state.a11yLines.length > A11Y_LINE_CAP) state.a11yLines.splice(0, state.a11yLines.length - A11Y_LINE_CAP);
}

// --- the rows -----------------------------------------------------------------

/** Everything the rows are a function of besides the pane state. */
export interface PaneContext {
  /** The file list the picker filters (the sidebar's own items). */
  readonly files: readonly string[];
  /** The active buffer's text, for the diff pane. */
  readonly bufferText: string;
  /** The active theme, for the audit pane. */
  readonly theme: Theme;
}

/** One row before the plan places it: an optional key column and the text. */
export interface PaneRow {
  readonly key?: string;
  readonly text: string;
}

/** Clamp index into [0, count - 1] (0 when empty). */
function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** The text leaves a detached element composed, in row order — how a framework
 * chart's own composition is read back as plain plan rows. */
function leafTexts(node: Node): string[] {
  return node.children.map((child) => String((child.props as { text?: unknown }).text ?? ""));
}

/** The files the picker shows under its filter, through the framework's own
 * Select prefix filter — the picker's filter is the element's, not a second. */
export function pickerFiles(state: PaneState, files: readonly string[]): string[] {
  const select = Select({
    options: files.map((value) => ({ value, label: value })),
    filter: state.query,
    highlighted: state.index,
  });
  return visibleOptions(select).map((option) => option.value);
}

/** The commands the palette lists under its filter, in table order. */
export function paletteCommands(state: PaneState): readonly CommandId[] {
  const needle = state.query.toLowerCase();
  return COMMANDS
    .filter((command) => needle === "" || command.title.toLowerCase().startsWith(needle))
    .map((command) => command.id);
}

/** The picker's rows: the filtered files, the highlighted one marked. */
function pickerRows(state: PaneState, ctx: PaneContext): PaneRow[] {
  const files = pickerFiles(state, ctx.files);
  const active = clampIndex(state.index, files.length);
  return files.map((file, index) => ({ text: (index === active ? "> " : "  ") + file }));
}

/** The palette's rows: the real command table's titles, highlighted one marked. */
function paletteRows(state: PaneState): PaneRow[] {
  const ids = paletteCommands(state);
  const active = clampIndex(state.index, ids.length);
  return ids.map((id, index) => {
    const command = COMMANDS.find((entry) => entry.id === id);
    return { key: String(index + 1), text: (index === active ? "> " : "  ") + (command?.title ?? id) };
  });
}

/** The preferences rows: a checkbox, a radio, two toggles — the four glyph
 * vocabularies the framework ships. */
function preferenceRows(state: PaneState): PaneRow[] {
  const prefs = state.prefs;
  return [
    {
      key: "wrap",
      text: (prefs.wrap ? CHECKBOX_CHECKED_GLYPH : CHECKBOX_UNCHECKED_GLYPH) + " Soft wrap",
    },
    {
      key: "tab",
      text: RADIO_SELECTED_GLYPH + " Tab width " + prefs.tabWidth,
    },
    {
      key: "theme",
      text: (prefs.theme === THEMES[0]!.name ? TOGGLE_ON_GLYPH : TOGGLE_OFF_GLYPH) + " Theme: " + prefs.theme,
    },
    {
      key: "a11y",
      text: (prefs.a11y ? TOGGLE_ON_GLYPH : TOGGLE_OFF_GLYPH) + " A11y JSONL stream",
    },
  ];
}

/** The theme pane's rows: the choices as a radio group, then the audit report. */
function themeRows(state: PaneState, ctx: PaneContext): PaneRow[] {
  const rows: PaneRow[] = THEMES.map((choice) => ({
    key: "theme:" + choice.name,
    text: (choice.name === state.prefs.theme ? RADIO_SELECTED_GLYPH : RADIO_UNSELECTED_GLYPH) + " " + choice.name,
  }));
  rows.push({ text: "" });
  rows.push({ text: "contrast audit (WCAG AA 4.5:1)" });
  const findings = auditTheme(ctx.theme);
  if (findings.length === 0) {
    rows.push({ text: "every fg/bg pair passes" });
    return rows;
  }
  for (const finding of findings) {
    rows.push({
      key: finding.name,
      text: finding.scope + " " + finding.name + "  " + finding.ratio.toFixed(2) + ":1",
    });
  }
  return rows;
}

/** The render-profile rows: a sparkline, a bar chart and a short table, all
 * built from the samples the app really measured. */
function profileRows(state: PaneState): PaneRow[] {
  const samples = state.samples;
  if (samples.length === 0) return [{ text: "no frames measured yet" }];
  const values = samples.map((sample) => sample.planMs);
  const rows: PaneRow[] = [];
  const spark = leafTexts(Sparkline({ data: values, width: Math.max(1, Math.min(48, values.length)), height: 1 }));
  rows.push({ text: "plan cost sparkline" });
  rows.push({ text: spark[0] ?? "" });
  rows.push({ text: "plan cost per frame" });
  const window = values.slice(-24);
  for (const line of leafTexts(BarChart({ data: window, width: window.length, height: 4, show_axis: true }))) {
    rows.push({ text: line });
  }
  rows.push({ text: "recent frames" });
  for (const sample of samples.slice(-8)) {
    rows.push({ text: "plan " + sample.planMs.toFixed(1) + "ms  lines " + sample.lines + "  rows " + sample.rows });
  }
  return rows;
}

/** The diff pane's rows: the framework's own unified DiffView, read back as
 * plan rows, between the buffer and the external text. */
function diffRows(state: PaneState, ctx: PaneContext): PaneRow[] {
  if (state.external === null) return [{ text: "no external change pending" }];
  const view = DiffView({ hunks: lineDiff(ctx.bufferText, state.external), wrap: false });
  const rows: PaneRow[] = [];
  for (const row of view.children) {
    let text = "";
    for (const leaf of row.children) text += String((leaf.props as { text?: unknown }).text ?? "");
    rows.push({ text });
  }
  return rows;
}

/** The a11y pane's rows: the stream's JSONL, oldest first. */
function a11yRows(state: PaneState): PaneRow[] {
  if (state.a11yLines.length === 0) {
    return [{ text: state.prefs.a11y ? "stream on, no frames emitted yet" : "stream off — toggle it in preferences" }];
  }
  return state.a11yLines.map((line, index) => ({ key: String(index + 1), text: line }));
}

/** The pane's rows, in display order. */
export function paneRows(id: AuxPaneId, state: PaneState, ctx: PaneContext): PaneRow[] {
  switch (id) {
    case "picker": return pickerRows(state, ctx);
    case "palette": return paletteRows(state);
    case "preferences": return preferenceRows(state);
    case "theme": return themeRows(state, ctx);
    case "profile": return profileRows(state);
    case "diff": return diffRows(state, ctx);
    case "a11y": return a11yRows(state);
  }
}

/** The pane's fields: the picker and the palette type into one, the rest have none. */
export function paneFields(id: AuxPaneId, state: PaneState): ModalField[] {
  if (id === "picker") return [{ label: "filter: ", text: state.query, caret: true }];
  if (id === "palette") return [{ label: "run: ", text: state.query, caret: true }];
  return [];
}

/** The pane's footer. */
export function paneStatus(id: AuxPaneId, state: PaneState, ctx: PaneContext): string {
  switch (id) {
    case "picker": return pickerFiles(state, ctx.files).length + " files";
    case "palette": return paletteCommands(state).length + " commands";
    case "preferences": return "enter toggles · tab cycles width · esc closes";
    case "theme": return "current: " + state.prefs.theme;
    case "profile": return state.samples.length + " samples";
    case "diff": return state.external === null ? "no pending change" : "enter reloads";
    case "a11y": return state.prefs.a11y ? "stream on · " + state.a11yLines.length + " lines" : "stream off";
  }
}

/** The whole pane as the plan's modal input: title, fields, rows and footer. */
export function paneModal(id: AuxPaneId, state: PaneState, ctx: PaneContext): ModalInput {
  const fields = paneFields(id, state);
  const items: ModalItem[] = paneRows(id, state, ctx).map((row) =>
    row.key === undefined ? { text: row.text } : { key: row.key, text: row.text }
  );
  const base: ModalInput = { id, title: paneTitle(id), status: paneStatus(id, state, ctx) };
  const withFields = fields.length === 0 ? base : { ...base, fields };
  return items.length === 0 ? withFields : { ...withFields, items };
}

// --- the a11y dump ------------------------------------------------------------

/** The plan as the semantics dump the a11y stream serializes: one node per
 * region, plus the screen root. Pure data — no scene, no renderer. */
export function a11yDump(plan: ScreenPlan): SceneSemanticsJs[] {
  const dump: SceneSemanticsJs[] = [
    { id: 0n, role: "group", label: "tern showcase", state: [], enabled: true, selected: false },
  ];
  let next = 1n;
  for (const region of plan.regions) {
    if (region.kind === "editor") {
      dump.push({
        id: next, parent: 0n, role: "textbox", label: region.totalRows + " lines",
        state: plan.focus === "editor" ? ["focused"] : [], enabled: true, selected: false,
      });
    } else if (region.kind === "sidebar") {
      dump.push({
        id: next, parent: 0n, role: "listbox", label: region.count + " items",
        state: plan.focus === "sidebar" ? ["focused"] : [], enabled: true, selected: false,
      });
    } else if (region.kind === "modal") {
      dump.push({
        id: next, parent: 0n, role: "dialog", label: region.title,
        state: [], enabled: true, selected: true,
      });
    } else {
      dump.push({
        id: next, parent: 0n, role: "status", label: region.segments.length + " segments",
        state: [], enabled: true, selected: false,
      });
    }
    next += 1n;
  }
  return dump;
}

// --- the line diff ------------------------------------------------------------

/** Above this many compared cells the diff degrades to a whole-file replace
 * rather than building a quadratic table for a pathological document. */
const DIFF_MAX_CELLS = 120_000;

/** The lines of text, with a trailing newline producing the empty tail line
 * the document model already has. */
function splitLines(text: string): string[] {
  return text.split("\n");
}

/** A unified diff between two texts: a context-preserving LCS at line
 * granularity, or a whole-file replace when the table would be too large. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > DIFF_MAX_CELLS) {
    const rows: DiffLine[] = [];
    for (let i = 0; i < a.length; i += 1) rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
    for (let j = 0; j < b.length; j += 1) rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
    return rows;
  }
  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1) dp.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const below = dp[i + 1]!;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "ctx", old_line: i + 1, new_line: j + 1, text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ kind: "del", old_line: i + 1, new_line: 0, text: a[i]! });
  for (; j < b.length; j += 1) rows.push({ kind: "add", old_line: 0, new_line: j + 1, text: b[j]! });
  return rows;
}
