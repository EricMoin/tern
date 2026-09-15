//! The auxiliary-pane reducer: the picker, palette, preferences, theme, profile,
//! diff and a11y panes, and the effects activating a row asks the host for.
//
// WHY THIS IS NOT IN state.ts. The pane reducer is the seam a previous subtask
// named as the natural cut: it reads the pane state, the file list and the buffer
// text, and it writes pane state, overlay state and host effects — one concern of
// its own. plan.ts still decides what the pane's rows look like (panes.ts composes
// them) and commands.ts still decides what a key means; this module only reduces.

import { A11yStream, getTheme, setTheme } from "@tern-tui/core";
import type { PaneAction } from "./commands.ts";
import { isAuxPane, type AuxPaneId } from "./pane-ids.ts";
import {
  a11yDump,
  closePane,
  nextTabWidth,
  openPane,
  paletteCommands,
  paneRows,
  pickerFiles,
  recordA11yLine,
  recordSample,
  themeChoice,
  THEMES,
  type PaneContext,
} from "./panes.ts";
import { editorOf } from "./pointer.ts";
import type { ScreenPlan } from "./plan.ts";
import { AppCore, IDLE_KEY } from "./state-core.ts";

/** The pane reducer, layered on the shared slots. */
export abstract class PaneReducerApp extends AppCore {

  /** Everything the auxiliary pane rows are a function of. */
  #paneContext(): PaneContext {
    return {
      files: this.sidebarState.items,
      bufferText: this.editing.buffer.text(),
      theme: getTheme(),
    };
  }

  /** The rows the open pane would lay out — the count its navigation clamps to. */
  #paneCount(id: AuxPaneId): number {
    return paneRows(id, this.paneState, this.#paneContext()).length;
  }

  /** One frame sample, from a plan build the caller timed. */
  protected recordFrame(plan: ScreenPlan, planMs: number): void {
    const editor = editorOf(plan);
    recordSample(this.paneState, {
      planMs,
      lines: plan.stats.editor.linesTouched,
      rows: editor?.rows.length ?? 0,
    });
  }

  /** The auxiliary pane's reducer — navigation, filtering and the activation each
   * pane's own row means. */
  protected reducePane(action: PaneAction, text: string | undefined): void {
    const modal = this.overlay.modal;
    const id = isAuxPane(modal) ? modal : null;
    if (action === "a11y-toggle") {
      this.#toggleA11y();
      return;
    }
    if (id === null) return;
    if (action === "prev") {
      this.paneState.index = Math.max(0, this.paneState.index - 1);
      return;
    }
    if (action === "next") {
      const count = this.#paneCount(id);
      this.paneState.index = Math.min(Math.max(0, count - 1), this.paneState.index + 1);
      return;
    }
    if (action === "filter-append") {
      this.paneState.query += text ?? "";
      this.paneState.index = 0;
      return;
    }
    if (action === "filter-backspace") {
      this.paneState.query = this.paneState.query.slice(0, -1);
      this.paneState.index = 0;
      return;
    }
    this.#activatePane(id);
  }

  /** Activate the highlighted row of `id`. The pane's rows and the per-row
   * meaning live in panes.ts; only the effects belong to the app. */
  #activatePane(id: AuxPaneId): void {
    if (id === "picker") {
      const file = pickerFiles(this.paneState, this.sidebarState.items)[this.paneState.index];
      if (file === undefined) return;
      this.effects.push({ kind: "open", path: file });
      this.overlay.pop("picker");
      closePane(this.paneState);
      return;
    }
    if (id === "palette") {
      const command = paletteCommands(this.paneState)[this.paneState.index];
      if (command === undefined) return;
      // Close the palette first, so the command it names runs against the screen
      // it was selected from and cannot find the palette still on top.
      this.overlay.pop("palette");
      closePane(this.paneState);
      this.run(command, IDLE_KEY);
      return;
    }
    if (id === "preferences") {
      if (this.paneState.index === 0) {
        this.paneState.prefs.wrap = !this.paneState.prefs.wrap;
        this.wrapOn = this.paneState.prefs.wrap;
      } else if (this.paneState.index === 1) {
        this.paneState.prefs.tabWidth = nextTabWidth(this.paneState.prefs.tabWidth);
      } else if (this.paneState.index === 2) {
        this.overlay.push("theme");
        openPane(this.paneState, "theme");
      } else if (this.paneState.index === 3) {
        this.#toggleA11y();
      }
      return;
    }
    if (id === "theme") {
      const choice = THEMES[this.paneState.index];
      if (choice === undefined) return;
      this.paneState.prefs.theme = choice.name;
      setTheme(themeChoice(choice.name).overrides);
      return;
    }
    if (id === "diff") {
      const text = this.paneState.external;
      if (text === null) return;
      this.load(text, this.bufferPath);
      this.paneState.external = null;
      this.overlay.pop("diff");
      closePane(this.paneState);
    }
  }

  /** Opt the a11y stream in or out. Turning it on starts a fresh framework
   * A11yStream over the plan's own dump; turning it off closes it and clears the
   * buffered lines. */
  #toggleA11y(): void {
    const on = !this.paneState.prefs.a11y;
    this.paneState.prefs.a11y = on;
    if (!on) {
      this.a11y?.close();
      this.a11y = null;
      this.paneState.a11yLines.length = 0;
      // The pane and the stream are one toggle: opting out closes the pane too.
      this.overlay.pop("a11y");
      closePane(this.paneState);
      return;
    }
    this.a11y = new A11yStream(
      () => (this.lastPlan === null ? [] : a11yDump(this.lastPlan)),
      (line) => recordA11yLine(this.paneState, line),
    );
    // Opting in shows the stream: raise the pane so the JSONL is on screen.
    this.overlay.push("a11y");
    openPane(this.paneState, "a11y");
  }
}
