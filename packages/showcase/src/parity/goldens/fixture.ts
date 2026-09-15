//! The fixture kind, and the drive that turns one into a ScreenPlan.
//!
//! A fixture is ONE SCREEN'S FIXED SCENARIO: the document and panes the app starts
//! from, the keys pressed, and the plan regime the screen exists to pin. Twelve of
//! them live beside this file, one per screen of the registry vocabulary
//! (registry-editor.ts:38), and all three renderer layers are run against the same
//! twelve — which is what makes your feature appear in all three or the parity test
//! fail.
//!
//! EVERY FIXTURE IS PRODUCED BY THE REAL CORE. `referencePlan` drives one
//! HeadlessApp instance (core/state.ts:71) through the fixed input and captures
//! `plan()` (core/state.ts:125), which is the app's one call into `buildPlan`
//! (core/plan.ts:212). No layer, no framework, no addon, no PTY.

import type { KeyEvent } from "@tern-tui/core";
import { Buffer, type Position } from "../../core/buffer.ts";
import { editingState } from "../../core/edits.ts";
import { buildPlan, type PlanFocus, type ScreenPlan, type SidebarInput } from "../../core/plan.ts";
import { HeadlessApp, type AppOptions } from "../../core/state.ts";
import type { ViewportSize } from "../../core/viewport.ts";
import type { ScreenId } from "../registry-editor.ts";

/** A key event with every modifier spelled out: the framework matcher is EXACT
 * about modifiers (core/keymap.ts:63), so an omitted flag is a different combo. */
export function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** The key events that type `text`, one per code point. */
export function chars(text: string): KeyEvent[] {
  return [...text].map((char) => key("char", { char }));
}

/**
 * How a fixture reaches its plan. `app` is the contract path: the keys go through
 * the app's ONE key route (core/keymap.ts:79) into the ONE reducer
 * (core/state.ts:181). `plan` calls `buildPlan` with explicit cells instead, for a
 * regime the app cannot express through keys today: its sidebar reducer keeps the
 * list scroll pinned to the top of the window (core/state.ts:368), so a scrolled
 * option window needs cells no key sequence can set. Still the real core, never a
 * re-derivation.
 */
export type FixtureDrive =
  | { readonly kind: "app"; readonly keys: readonly KeyEvent[] }
  | {
    readonly kind: "plan";
    readonly scroll: number;
    readonly caret: Position;
    readonly sidebar?: { readonly active?: number; readonly scroll?: number };
    readonly focus?: PlanFocus;
    /** The mode line's mode label (buildPlan's `mode`, core/plan.ts:254). */
    readonly mode?: string;
    /** The mode line's title; the fixture's own `path` when omitted, NO_TITLE
     * when the fixture has no path either. */
    readonly title?: string;
    readonly modeLine?: boolean;
  };

/** One screen's fixed scenario: what the app starts from, what is pressed, and the
 * plan regime the screen exists to pin. */
export interface Fixture {
  readonly screen: ScreenId;
  /** The regime this fixture pins — what a divergence in it would mean. */
  readonly regime: string;
  /** The registry entries whose features live on this screen, so the fixture is
   * traceable to the coverage claim it serves. */
  readonly anchors: readonly string[];
  /** The part of the screen the app-core cannot reach yet, or null. Never a quiet
   * workaround: the gap is named with its file:line in the report. */
  readonly pending: string | null;
  readonly size: ViewportSize;
  readonly text: string;
  readonly path: string | null;
  readonly items?: readonly string[];
  readonly sidebarWidth?: number;
  readonly sidebarVisible?: boolean;
  /** The external text the host hands the app for the diff pane (null: none). */
  readonly external?: string;
  /** The frame clock the render-profile pane samples, consumed in order. A fixture
   * injects it so a recorded profile buffer is stable while the app still measures
   * its real build cost. */
  readonly clock?: readonly number[];
  readonly drive: FixtureDrive;
}

/** The app options the fixture's document and panes imply. */
export function appOptions(fixture: Fixture): AppOptions {
  const options: AppOptions = {
    buffer: Buffer.fromString(fixture.text),
    path: fixture.path,
    size: fixture.size,
    items: fixture.items ?? [],
  };
  if (fixture.sidebarWidth !== undefined) options.sidebarWidth = fixture.sidebarWidth;
  if (fixture.sidebarVisible !== undefined) options.sidebarVisible = fixture.sidebarVisible;
  if (fixture.external !== undefined) options.external = fixture.external;
  if (fixture.clock !== undefined) {
    const values = fixture.clock;
    let at = 0;
    options.clock = () => values[at++] ?? values[values.length - 1] ?? 0;
  }
  return options;
}

/**
 * Drive ONE app-core instance through `keys` and return it.
 *
 * Every key must be CONSUMED by the real dispatcher: a fixture that presses a key
 * the app does not bind describes a screen nobody can reach, so it fails here
 * rather than quietly pinning a dead plan.
 */
export function driveApp(fixture: Fixture, keys: readonly KeyEvent[]): HeadlessApp {
  const app = new HeadlessApp(appOptions(fixture));
  for (const event of keys) {
    if (!app.dispatch(event)) {
      const mods = (event.ctrl ? "ctrl+" : "") + (event.alt ? "alt+" : "") + (event.shift ? "shift+" : "");
      const name = event.name === "char" ? JSON.stringify(event.char ?? "") : event.name;
      throw new Error("fixture " + fixture.screen + ": the app does not handle " + mods + name);
    }
  }
  return app;
}

/** The sidebar input a plan-drive fixture asks for: the fixture's own list plus the
 * drive's cells. */
function planSidebar(fixture: Fixture, drive: Extract<FixtureDrive, { kind: "plan" }>): SidebarInput | undefined {
  if (fixture.sidebarVisible === false || fixture.items === undefined || fixture.items.length === 0) return undefined;
  return {
    items: fixture.items,
    width: fixture.sidebarWidth ?? 20,
    active: drive.sidebar?.active ?? -1,
    scroll: drive.sidebar?.scroll ?? 0,
  };
}

/** The ScreenPlan the REAL core produces for `fixture` — the reference every layer
 * is held to. */
export function referencePlan(fixture: Fixture): ScreenPlan {
  const drive = fixture.drive;
  if (drive.kind === "app") {
    const app = driveApp(fixture, drive.keys);
    // A fixture with a clock opens a pane that reads the frame history (the
    // render profile, the a11y stream): warm it so the reference is the plan
    // after a few real builds rather than the first frame such a pane could not
    // have data for. Every other fixture is driven exactly as before.
    if (fixture.clock !== undefined) {
      for (let frame = 0; frame < 4; frame += 1) app.plan(fixture.size);
    }
    return app.plan(fixture.size);
  }
  const state = editingState(Buffer.fromString(fixture.text));
  const sidebar = planSidebar(fixture, drive);
  const title = drive.title ?? fixture.path;
  return buildPlan({
    buffer: state.buffer,
    index: state.index,
    cache: state.cache,
    size: fixture.size,
    scroll: drive.scroll,
    caret: drive.caret,
    ...(sidebar === undefined ? {} : { sidebar }),
    ...(drive.focus === undefined ? {} : { focus: drive.focus }),
    ...(drive.mode === undefined ? {} : { mode: drive.mode }),
    ...(title === null ? {} : { title }),
    ...(drive.modeLine === undefined ? {} : { modeLine: drive.modeLine }),
  });
}
