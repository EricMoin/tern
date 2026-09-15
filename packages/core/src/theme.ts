//! The theme system: role palettes, per-component presets, and resolution.

import { Node } from "./node.ts";
import { Renderer } from "./renderer.ts";
import type { NodeProps } from "./types.ts";
/** The semantic palette roles. `border` colors the frame/border of a node. */
export const THEME_ROLES = [
  "primary",
  "secondary",
  "success",
  "danger",
  "warning",
  "muted",
  "border",
] as const;

/** A semantic palette role ("primary", "danger", ...). */
export type ThemeRole = (typeof THEME_ROLES)[number];

/** The components with themeable style presets. */
export const THEME_COMPONENTS = [
  "input",
  "textarea",
  "spinner",
  "status_bar",
  "panels",
  "diff",
  "select",
  "checkbox",
  "radio",
  "toggle",
  "scroll_view",
  "table",
  "markdown",
  "progress",
  "help",
  "menu",
] as const;

/** A themeable component kind ("input", "diff", ...). */
export type ThemeComponent = (typeof THEME_COMPONENTS)[number];

/** The fg/bg colors of one palette role. Colors use the engine's string
 * color format: `#rrggbb` hex, `indexed:N`, or `default`. */
export interface ThemeRoleColors {
  /** The foreground color. */
  fg: string;
  /** The background color. */
  bg: string;
}

/** The style a component preset may resolve to node props (all optional —
 * only the keys a preset defines are stamped). */
export interface ThemeStylePreset {
  /** Resolved onto the node's `fg` prop. */
  fg?: string;
  /** Resolved onto the node's `bg` prop. */
  bg?: string;
  /** Resolved onto the node's `border_style` prop. */
  border_style?: NodeProps["border_style"];
}

/** A complete theme: the named palette plus one style preset per component. */
export interface Theme {
  /** The fg/bg colors for every semantic role. */
  palette: { [role in ThemeRole]: ThemeRoleColors };
  /** The per-component style presets. */
  components: { [kind in ThemeComponent]: ThemeStylePreset };
}

/** A partial theme for `mergeTheme` / `ThemeProvider` / `setTheme`: any
 * subset of palette roles or component presets (each merged over the base). */
export interface ThemeOverrides {
  /** Palette roles to override (per-role keys are optional). */
  palette?: Partial<Record<ThemeRole, Partial<ThemeRoleColors>>>;
  /** Component presets to override. */
  components?: Partial<Record<ThemeComponent, ThemeStylePreset>>;
}

/** Props that may carry the semantic theme hints `role` / `component`.
 * `resolveTheme` consumes them; the returned `NodeProps` carry only plain
 * style/layout keys, so the hints never reach the scene. */
export interface ThemeResolvableProps extends NodeProps {
  /** Resolve the node's `fg`/`bg` from this palette role. */
  role?: ThemeRole;
  /** Resolve the node's `fg`/`bg`/`border_style` from this component preset. */
  component?: ThemeComponent;
}

/**
 * The default theme: an One-Dark-flavored palette for code-agent TUIs.
 * Component presets are empty — with the default theme, components render
 * with their built-in defaults; themes that override a component preset get
 * themed components (e.g. a rounded-bordered `Input`).
 */
export const defaultTheme: Theme = {
  palette: {
    primary: { fg: "#61afef", bg: "#21252b" },
    secondary: { fg: "#abb2bf", bg: "#21252b" },
    success: { fg: "#98c379", bg: "#21252b" },
    danger: { fg: "#e06c75", bg: "#21252b" },
    warning: { fg: "#e5c07b", bg: "#21252b" },
    muted: { fg: "#5c6370", bg: "#21252b" },
    border: { fg: "#3e4452", bg: "#21252b" },
  },
  components: {
    input: {},
    textarea: {},
    spinner: {},
    status_bar: {},
    panels: {},
    diff: {},
    select: {},
    checkbox: {},
    radio: {},
    toggle: {},
    scroll_view: {},
    table: {},
    markdown: {},
    progress: {},
    help: {},
    menu: {},
  },
};

/**
 * Merge `overrides` over `base`, returning a new `Theme`. Palette roles and
 * component presets are merged per key (a partial role keeps the base's
 * other keys; a partial preset keeps the base's other style keys). The base
 * is never mutated.
 */
export function mergeTheme(base: Theme, overrides: ThemeOverrides = {}): Theme {
  const palette: Theme["palette"] = { ...base.palette };
  for (const role of THEME_ROLES) {
    const override = overrides.palette?.[role];
    if (override !== undefined) {
      palette[role] = { ...base.palette[role], ...override };
    }
  }
  const components: Theme["components"] = { ...base.components };
  for (const kind of THEME_COMPONENTS) {
    const override = overrides.components?.[kind];
    if (override !== undefined) {
      components[kind] = { ...base.components[kind], ...override };
    }
  }
  return { palette, components };
}

/**
 * Resolve `theme` onto `props` at element-creation time, stamping plain
 * style keys:
 *
 * - `component` preset fills missing `fg` / `bg` / `border_style`;
 * - `role` palette then fills any still-missing `fg` / `bg`;
 * - explicit props always win over both.
 *
 * The semantic `role` / `component` hints are consumed (stripped) from the
 * returned props, so the output is ordinary `NodeProps` — the same surface
 * the scene node understands, with no new napi surface (constitution).
 */
export function resolveTheme(
  theme: Theme,
  props: ThemeResolvableProps,
): NodeProps {
  const role = props.role;
  const component = props.component;
  // No hints: return the props object unchanged. Identity here matters —
  // the Solid renderer passes accessor-based reactive props (signal getters)
  // through its factories, and an eager `{ ...props }` copy would flatten
  // the accessors and sever the reactivity.
  if (role === undefined && component === undefined) {
    return props;
  }
  const out: NodeProps = { ...props };
  delete out.role;
  delete out.component;
  // The style keys this resolution fills from the theme (a component preset
  // fill, or a role palette fill) — the keys a later `setTheme` re-resolution
  // may rewrite. A key the caller set explicitly is never in the set, so it
  // always wins over both the preset and the palette.
  const stamped = new Set<"fg" | "bg" | "border_style">();
  if (component !== undefined) {
    const preset = theme.components[component];
    if (preset !== undefined) {
      if (out.fg === undefined && preset.fg !== undefined) {
        out.fg = preset.fg;
        stamped.add("fg");
      }
      if (out.bg === undefined && preset.bg !== undefined) {
        out.bg = preset.bg;
        stamped.add("bg");
      }
      if (out.border_style === undefined && preset.border_style !== undefined) {
        out.border_style = preset.border_style;
        stamped.add("border_style");
      }
    }
  }
  if (role !== undefined) {
    const colors = theme.palette[role];
    if (colors !== undefined) {
      // The role palette is the more specific intent: it overrides the
      // component preset's fg/bg, but never an explicit prop.
      if (
        (out.fg === undefined || stamped.has("fg")) &&
        colors.fg !== undefined
      ) {
        out.fg = colors.fg;
        stamped.add("fg");
      }
      if (
        (out.bg === undefined || stamped.has("bg")) &&
        colors.bg !== undefined
      ) {
        out.bg = colors.bg;
        stamped.add("bg");
      }
    }
  }
  // The M4.5 runtime engine hook: carry the consumed hints (and the keys the
  // theme stamped) on the returned props, so the `Node` created from them can
  // be re-resolved by a later `setTheme`. The symbol is invisible to every
  // string-keyed operation (`Object.keys` / spread / JSON), so the resolution
  // output is otherwise byte-identical to a plain props object — when
  // `setTheme` is never called, creation-time output is unchanged.
  Object.defineProperty(out, THEME_HINT, {
    value: { role, component, stamped },
    enumerable: true,
    configurable: true,
  });
  return out;
}

/** The semantic hint retained for a node — the `role` / `component` it was
 * resolved with at creation, plus the style keys the theme stamped (the keys
 * a later re-resolution may rewrite; an explicit prop is never in the set,
 * so it always wins over the preset and the palette). */
interface ThemeHintRecord {
  /** The palette role the node was resolved with, if any. */
  role?: ThemeRole;
  /** The component preset the node was resolved with, if any. */
  component?: ThemeComponent;
  /** The style keys `resolveTheme` filled from the theme at creation. */
  stamped: Set<"fg" | "bg" | "border_style">;
}

/**
 * The symbol `resolveTheme` attaches to the props object it returns when it
 * consumed semantic hints. Enumerable on purpose: a factory that spreads the
 * resolved props (`{ ...props }`) before `Node.create` keeps the hint, so
 * every element kind records. Invisible to every string-keyed operation
 * (`Object.keys` / spread / JSON), so the resolution output is otherwise an
 * ordinary `NodeProps` object.
 */
const THEME_HINT = Symbol("tern.tui.themeHint");

/** The parallel hint store (M4.1 pattern): node → the semantic hints it was
 * created with. Pure bookkeeping, exactly like the semantics stores — the
 * compositor never reads it. */
const themeHints = new WeakMap<Node, ThemeHintRecord>();

/** The walkable mirror of `themeHints` — a WeakMap is not iterable, and
 * `setTheme` must walk every recorded node. Holds `WeakRef`s (never strong
 * references, so a dead node is collectible); entries whose node was
 * collected are pruned during the next walk. */
const themedNodes = new Set<WeakRef<Node>>();

/** Every live renderer, registered at construction and dropped on destroy —
 * the `setTheme` repaint targets. A switch schedules exactly one coalesced
 * frame per live renderer whose scene actually holds themed nodes. */
export const liveRenderers = new Set<Renderer>();

/** The module-level active theme the runtime engine resolves against. Starts
 * as the core `defaultTheme`, so creation-time resolution is unchanged until
 * `setTheme` is called. */
let activeTheme: Theme = defaultTheme;

/**
 * Consume the theme hint `resolveTheme` attached to `props` and record it for
 * the node in the parallel store. Called from the `Node` constructor, before
 * the props are mirrored — the symbol is stripped (consumed, like the hints
 * themselves), so it never reaches the node's props or the native layer.
 *
 * A node created without hints is never recorded: a later `setTheme` switch
 * leaves it alone — zero native calls (the walk's diff is empty because the
 * node is not in the store at all).
 */
export function recordThemeHints(node: Node, props: NodeProps): void {
  const hinted = props as NodeProps & { [THEME_HINT]?: ThemeHintRecord };
  const hint = hinted[THEME_HINT];
  if (hint === undefined) return;
  delete hinted[THEME_HINT];
  const record: ThemeHintRecord = { stamped: hint.stamped };
  // Set conditionally: `exactOptionalPropertyTypes` rejects an explicit
  // `undefined` for an optional property.
  if (hint.role !== undefined) record.role = hint.role;
  if (hint.component !== undefined) record.component = hint.component;
  themeHints.set(node, record);
  themedNodes.add(new WeakRef(node));
}

/**
 * Whether `node`'s subtree contains at least one node with a recorded theme
 * hint — the repaint-target check behind `setTheme`: a renderer is only asked
 * to repaint when its scene actually holds themed nodes. The scene root itself
 * is never recorded, so a renderer with no themed content reports `false`.
 */
function subtreeHasThemeHint(node: Node): boolean {
  if (themeHints.has(node)) return true;
  for (const child of node.children) {
    if (subtreeHasThemeHint(child)) return true;
  }
  return false;
}

/**
 * Set the active theme merged over the core `defaultTheme` (`mergeTheme`):
 * a partial theme keeps the default palette and presets for everything it
 * does not override. Unlike the hosts' creation-time-only resolution, the
 * core runtime engine then re-resolves every node that was created with
 * semantic hints against the new theme, in place:
 *
 * - each recorded node's current props (minus the keys the theme stamped at
 *   creation, so the new values replace the old) are re-run through
 *   `resolveTheme` with the retained `role` / `component` hints;
 * - the result is diffed against the node's `#props` mirror and ONLY the
 *   changed keys are pushed, through the single-key `Node.setProp` path —
 *   an equal-value write no-ops, so the scene mutation epoch stays untouched;
 * - a stamped key the new theme no longer fills is cleared through `setProp`'s
 *   existing removal path (the fresh-mount equivalent carries no such key);
 * - when anything actually changed, one coalesced {@link Renderer.requestFrame}
 *   is scheduled per live renderer. A switch that changed nothing (the same
 *   theme, or a theme whose resolution leaves every node's props equal)
 *   performs zero native calls and schedules no repaint.
 */
export function setTheme(overrides: ThemeOverrides): void {
  activeTheme = mergeTheme(defaultTheme, overrides);
  let pushed = false;
  for (const ref of themedNodes) {
    const node = ref.deref();
    // The node was collected: prune the dead entry (the WeakMap entry is
    // already gone) and move on. Deleting the current entry during the
    // iteration is safe.
    if (node === undefined) {
      themedNodes.delete(ref);
      continue;
    }
    const hint = themeHints.get(node);
    // A defensive skip: recording only ever happens with at least one hint,
    // and `resolveTheme`'s no-hint fast path must never run here (it would
    // return the base props with `role` / `component` keys un-stripped).
    if (hint === undefined) continue;
    if (hint.role === undefined && hint.component === undefined) continue;
    // Re-resolve against the node's current props, clearing the theme-owned
    // keys first — the new theme's values replace them, while an explicit
    // prop (never in `stamped`) always wins.
    const base = { ...node.props };
    for (const key of hint.stamped) delete (base as Record<string, unknown>)[key];
    const re: ThemeResolvableProps = base;
    if (hint.role !== undefined) re.role = hint.role;
    if (hint.component !== undefined) re.component = hint.component;
    const next = resolveTheme(activeTheme, re);
    const current = node.props as Record<string, unknown>;
    // Push ONLY the changed keys through the single-key setProp path; an
    // equal-value write no-ops inside setProp too, so the scene mutation
    // epoch stays untouched for a no-op switch.
    for (const key of Object.keys(next)) {
      if (current[key] !== next[key]) {
        node.setProp(key, next[key]);
        pushed = true;
      }
    }
    // A stamped key the new theme no longer fills must be cleared — the
    // fresh-mount equivalent (resolved under the new theme) carries no such
    // key. The removal routes through setProp's existing undefined path.
    for (const key of hint.stamped) {
      if (!(key in next) && key in current) {
        node.setProp(key, undefined);
        pushed = true;
      }
    }
  }
  if (pushed) {
    for (const renderer of liveRenderers) {
      if (subtreeHasThemeHint(renderer.root)) renderer.requestFrame();
    }
  }
}

/** The active theme currently resolved by the element factories (the core
 * counterpart of the hosts' `getTheme`). */
export function getTheme(): Theme {
  return activeTheme;
}

