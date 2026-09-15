//! Key combo parsing, the Keymap registry, and the HelpPanel built from it.

import { Box, Node, Text } from "./node.ts";
import type { KeyHandler, NodeProps } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
/**
 * A key combination registered with a {@link Keymap}: a key name plus the
 * modifier flags that must be held. `name` is the event's key name (`enter`,
 * `escape`, `backspace`, `tab`, `up`, `f1`, ...) or, for a printable key,
 * the character itself — `"k"` matches a `"char"` event whose `char` is
 * `"k"`. Matching is exact: a modifier omitted from the combo must be
 * released (`{ name: "k", ctrl: true }` fires on `ctrl+k` only, never on
 * plain `k` or `ctrl+shift+k`).
 */
export interface KeyCombo {
  /** The key name (`enter`, `escape`, `backspace`, `tab`, `up`, `f1`, ...),
   * or the character of a printable key (`"k"` matches a `"char"` event). */
  name: string;
  /** Whether Control must be held (default `false`). */
  ctrl?: boolean;
  /** Whether Alt must be held (default `false`). */
  alt?: boolean;
  /** Whether Shift must be held (default `false`). */
  shift?: boolean;
  /** Whether Meta must be held (default `false`). */
  meta?: boolean;
  /** Whether Super (the Windows / Command key) must be held (default
   * `false`). */
  super?: boolean;
}

/** A normalized signature for a combo: the name plus each modifier's required
 * state (omitted modifiers default to released), so re-registering an
 * equivalent combo replaces the earlier entry. */
function comboSignature(combo: KeyCombo): string {
  return [
    combo.name,
    combo.ctrl ?? false,
    combo.alt ?? false,
    combo.shift ?? false,
    combo.meta ?? false,
    combo.super ?? false,
  ].join("\u0000");
}

/** Whether `event` matches `combo` exactly: the key name (or, for a `"char"`
 * event, the character) plus every modifier flag, with omitted combo
 * modifiers treated as released. */
function comboMatches(combo: KeyCombo, event: KeyEvent): boolean {
  const nameMatches = event.name === combo.name ||
    (event.name === "char" && event.char === combo.name);
  if (!nameMatches) return false;
  return (
    event.ctrl === (combo.ctrl ?? false) &&
    event.alt === (combo.alt ?? false) &&
    event.shift === (combo.shift ?? false) &&
    (event.super ?? false) === (combo.super ?? false) &&
    (event.meta ?? false) === (combo.meta ?? false)
  );
}

/**
 * A registry of global key combinations (shortcuts) dispatched ahead of
 * {@link FocusManager} focus routing. Register a combo with
 * {@link Keymap.register}; every key event routed through
 * {@link FocusManager.routeKey} is matched against the registry first — a
 * registered combo fires regardless of focus (or an explicitly routed node)
 * and consumes the event, while an unclaimed key falls through to the focused
 * element's handler, and beyond it to the tree-level handler.
 *
 * The module-level {@link keymap} is the default instance consulted by every
 * {@link FocusManager}, so the react `useInput` / solid `subscribeInput`
 * wrappers (which route keys through the manager) inherit global shortcuts
 * with no per-tree wiring.
 */
export class Keymap {
  // `description` is explicitly `| undefined`: `register` always stores the
  // (possibly absent) argument, and exactOptionalPropertyTypes forbids an
  // explicit `undefined` for a plain optional property.
  #entries = new Map<
    string,
    { combo: KeyCombo; handler: KeyHandler; description?: string | undefined }
  >();

  /**
   * Register `handler` for `combo`, optionally with a human-readable
   * `description` — surfaced by {@link HelpPanel} as the overlay's dimmed
   * description column. Omit it (the status-quo path) for dispatch-only
   * shortcuts; the dispatch behavior is identical either way. Registering
   * the same combo again replaces the earlier handler and description.
   * Returns an unsubscribe function that removes the registration.
   */
  register(
    combo: KeyCombo,
    handler: KeyHandler,
    description?: string,
  ): () => void {
    const signature = comboSignature(combo);
    this.#entries.set(signature, { combo, handler, description });
    return () => {
      const entry = this.#entries.get(signature);
      // Only remove when the current handler is still the one this call
      // registered — an older unsubscribe must not clobber a replacement.
      if (entry !== undefined && entry.handler === handler) {
        this.#entries.delete(signature);
      }
    };
  }

  /**
   * The registered combos in registration order — one entry per live
   * registration, carrying the optional description when one was supplied.
   * Re-registering a combo keeps its original position (replacing the
   * handler and description), so the order is stable and mirrors
   * {@link dispatch}'s match order. Returns fresh copies: mutating the
   * returned array or combos never affects the keymap.
   */
  list(): { combo: KeyCombo; description?: string }[] {
    const listed: { combo: KeyCombo; description?: string }[] = [];
    for (const { combo, description } of this.#entries.values()) {
      // exactOptionalPropertyTypes: only attach `description` when present.
      const entry: { combo: KeyCombo; description?: string } = {
        combo: { ...combo },
      };
      if (description !== undefined) {
        entry.description = description;
      }
      listed.push(entry);
    }
    return listed;
  }

  /**
   * Match `event` against the registered combos: when one matches, run its
   * handler and return `true` (the event is claimed). Returns `false` when no
   * combo matches, so the caller lets the event fall through. Matching is
   * exact, so at most one combo can match a given event; the first match in
   * registration order wins.
   */
  dispatch(event: KeyEvent): boolean {
    for (const { combo, handler } of this.#entries.values()) {
      if (comboMatches(combo, event)) {
        handler(event);
        return true;
      }
    }
    return false;
  }
}

/** The default global keymap shared by all {@link FocusManager} instances:
 * {@link FocusManager.routeKey} consults it ahead of focus routing. A combo
 * registered here fires regardless of focus and is never delivered to the
 * focused element's handler or the tree-level handler. */
export const keymap: Keymap = new Keymap();

/** Props for the `HelpPanel` element. `keymap` / `title` are consumed by the
 * factory — the overlay is rendered from the keymap's listings at creation
 * time — so they never reach the scene props; remaining props style the root
 * box. */
export interface HelpPanelProps extends NodeProps {
  /** The keymap whose listings render. Defaults to the module-level
   * {@link keymap}. */
  keymap?: Keymap;
  /** An optional title row rendered above the key/description rows. */
  title?: string;
}

/** Render a combo's key hint as `mod1+mod2+key` (bubbletea help style:
 * modifiers first, then the key name — `ctrl+k`, `shift+enter`, `f1`). */
function helpComboHint(combo: KeyCombo): string {
  const mods: string[] = [];
  if (combo.ctrl) mods.push("ctrl");
  if (combo.alt) mods.push("alt");
  if (combo.shift) mods.push("shift");
  if (combo.meta) mods.push("meta");
  if (combo.super) mods.push("super");
  return [...mods, combo.name].join("+");
}

/**
 * Create a `help` element (bubbletea Help parity): a flex column `box` of
 * text leaves listing a {@link Keymap}'s described combos — one row per
 * entry, the key hint right-aligned in a key column as wide as the widest
 * hint, then the dimmed description (a `margin_left` gap mirrors bubbletea's
 * two-cell separator). Entries registered without a description are skipped
 * (dispatch-only shortcuts, bubbletea's `desc == ""` skip). The optional
 * `title` renders as a plain text row above the entries. The source keymap
 * defaults to the module-level {@link keymap}. Style the overlay through the
 * `help` component preset: hosts resolve it with
 * `resolveTheme(theme, { ...props, component: "help" })` — the factory
 * materializes as a plain `box` with text children, so no new napi node kind
 * is introduced (constitution).
 */
export function HelpPanel(props: HelpPanelProps = {}): Node {
  const source = props.keymap ?? keymap;
  const rows: Node[] = [];
  if (props.title !== undefined && props.title !== "") {
    rows.push(Text({ text: props.title, bold: true }));
  }
  // Only described entries render (bubbletea skips empty descriptions); the
  // key column is as wide as the widest hint among them.
  const described = source.list().filter((entry) =>
    entry.description !== undefined
  );
  const keyColWidth = described.reduce(
    (widest, entry) => Math.max(widest, helpComboHint(entry.combo).length),
    0,
  );
  for (const entry of described) {
    const keys = helpComboHint(entry.combo).padStart(keyColWidth);
    rows.push(
      Box(
        { flex_direction: "row", height: 1 },
        Text({ text: keys }),
        Text({ text: entry.description as string, dim: true, margin_left: 2 }),
      ),
    );
  }
  const rootProps: NodeProps = { ...props, flex_direction: "column" };
  const plain = rootProps as Record<string, unknown>;
  delete plain.keymap;
  delete plain.title;
  return Node.create("box", rootProps, rows);
}

