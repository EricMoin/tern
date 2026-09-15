//! The plan and the command context the app assembles from its own state.
//
// WHY THIS IS NOT IN `state.ts`. Building a screen plan (`buildPlan`) and building
// the context a command reads are two projections of the SAME app state, and both
// were methods on the state machine; `state.ts` was over its module budget and
// this is the seam. The ONE-decision-point contract is untouched: `plan.ts` still
// decides what is on screen and `commands.ts` still decides what a key means; this
// module only hands each the live state.
//
// It imports no scene, no renderer and no terminal — the plan is plain data.

import type { KeyEvent, Keymap } from "@tern-tui/core";
import type { Position } from "./buffer.ts";
import type { EditingState } from "./edits.ts";
import type { PointerContext } from "./events.ts";
import type { CommandContext, ModalId } from "./intents.ts";
import { modalInputFor } from "./modals.ts";
import type { OverlayState } from "./overlay.ts";
import { buildPlan, type PlanFocus, type ScreenPlan, type SidebarInput, type TabsInput } from "./plan.ts";
import type { ModalInput } from "./plan-modals.ts";
import type { Selection } from "./selection.ts";
import type { ViewportSize } from "./viewport.ts";

/** Everything building a plan or a command context reads. A snapshot of the app's
 * live slots — the app owns the originals and this module never mutates one. */
export interface PlanSource {
  readonly editing: EditingState;
  readonly caret: Position;
  readonly selection: Selection | null;
  readonly scroll: number;
  readonly size: ViewportSize;
  readonly focus: PlanFocus;
  readonly modal: ModalId | null;
  readonly path: string | null;
  readonly wrap: boolean;
  readonly gutter: boolean;
  readonly sidebarVisible: boolean;
  readonly sidebarItems: readonly string[];
  readonly sidebarWidth: number;
  readonly sidebarActive: number;
  readonly sidebarScroll: number;
  readonly tabs: TabsInput | undefined;
  readonly overlay: OverlayState;
  readonly keymap: Keymap;
}

/** The screen plan for `source` — the app's one call into `plan.ts`. */
export function buildAppPlan(source: PlanSource): ScreenPlan {
  const sidebar = sidebarInput(source);
  const modal = modalInput(source);
  return buildPlan({
    buffer: source.editing.buffer,
    index: source.editing.index,
    cache: source.editing.cache,
    size: source.size,
    scroll: source.scroll,
    caret: source.caret,
    mode: source.modal === null ? "EDIT" : source.modal.toUpperCase(),
    focus: source.focus,
    wrap: source.wrap,
    gutter: source.gutter,
    ...(source.path === null ? {} : { title: source.path }),
    ...(sidebar === undefined ? {} : { sidebar }),
    ...(source.tabs === undefined ? {} : { tabs: source.tabs }),
    ...(modal === null ? {} : { modal }),
  });
}

/** Everything a command may read, plus the event that triggered it. */
export function appContext(
  source: PlanSource,
  key: KeyEvent,
  pointer: PointerContext | null,
  paste: string | null,
): CommandContext {
  return {
    buffer: source.editing.buffer,
    index: source.editing.index,
    cache: source.editing.cache,
    caret: source.caret,
    selection: source.selection,
    focus: source.focus,
    modal: source.modal,
    sidebarVisible: source.sidebarVisible,
    wrap: source.wrap,
    gutter: source.gutter,
    search: {
      query: source.overlay.search.query,
      replacement: source.overlay.replacement,
      caseSensitive: source.overlay.search.caseSensitive,
    },
    key,
    pointer,
    paste,
  };
}

/** The file list as `plan.ts` wants it, or `undefined` when it is hidden. */
function sidebarInput(source: PlanSource): SidebarInput | undefined {
  if (!source.sidebarVisible || source.sidebarItems.length === 0) return undefined;
  return {
    items: source.sidebarItems,
    width: source.sidebarWidth,
    active: source.sidebarActive,
    scroll: source.sidebarScroll,
  };
}

/** The open overlay as the plan's own input, or `null` when the editor owns the
 * screen. The CONTENT is `modals.ts`'s; the plan decides the box it fits in. */
function modalInput(source: PlanSource): ModalInput | null {
  const id = source.modal;
  if (id === null) return null;
  return modalInputFor({
    id,
    buffer: source.editing.buffer,
    query: source.overlay.search.query,
    replacement: source.overlay.replacement,
    caseSensitive: source.overlay.search.caseSensitive,
    shortcuts: source.keymap.list(),
  });
}
