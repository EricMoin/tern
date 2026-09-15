//! The Tabs element: activation, closing, and keyboard navigation.

import { Box, Node, Text } from "./node.ts";
import type { NodeProps } from "./types.ts";

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
/** One tab in a `Tabs` element: a label plus the content nodes rendered in
 * the content region while the tab is active. */
export interface TabSpec {
  /** The tab's label text (rendered in the tab bar). */
  label: string;
  /** The tab's content nodes, rendered in the content region while the tab is
   * active (the same node instances are re-attached on every activation,
   * mirroring `Panels`' collapsed-body restore). */
  content: Node[];
  /** Show a close affordance on this tab (defaults to the element's
   * `closable`). */
  closable?: boolean;
}

/** The state reported by {@link tabsKey} after a routed key. */
export interface TabsState {
  /** The active tab index (clamped into the tabs). */
  active: number;
  /** The tab count after the key (a `ctrl+w` close shrinks it). */
  count: number;
}

/**
 * Props for the `Tabs` element. `tabs` / `closable` are consumed by the
 * factory (the tab list is JS bookkeeping — it never reaches the scene props,
 * mirroring `Panels`' `panels`); the interactive state (`active`) and the
 * remaining style/layout props flow to the root box, which is a flex column
 * of the tab bar row and the content region.
 */
export interface TabsProps extends NodeProps {
  /** The tabs, in display order (left to right). */
  tabs: TabSpec[];
  /** The active tab index (default 0). */
  active?: number;
  /** Show a close affordance on every tab (default `false`; a per-tab
   * `closable` overrides it). */
  closable?: boolean;
}

/** The fg of the active tab's primary styling — the default theme's
 * `primary` palette fg (docs/components.md "Tabs"; mirroring `DIFF_ADD_FG`
 * mirroring the `success` palette). */
export const TAB_PRIMARY_FG = "#61afef";

/** The bg of the active tab's primary styling — the default theme's `primary`
 * palette bg. */
export const TAB_PRIMARY_BG = "#21252b";

/** The top-border marker prefixed to the active tab's label — a top-border
 * fragment that visually caps the active tab. */
export const TAB_ACTIVE_MARKER = "▔";

/** The close glyph appended to a closable tab's label. */
export const TAB_CLOSE_CHAR = "×";

/** The normalized tab spec list of a tabs node (JS bookkeeping — never scene
 * props, mirroring `Table`'s `tableRows`). */
const tabSpecs = new WeakMap<Node, TabSpec[]>();

/** The element-level close-affordance default of a tabs node (JS bookkeeping —
 * never scene props, mirroring `Select`'s `floating` mapping to `z_index`).
 * Captured at creation because the `closable` flag is consumed by the factory
 * (like `Panels`' `panels` / `Table`'s `rows`). */
const tabClosables = new WeakMap<Node, boolean>();

/** The element-level `closable` default of a tabs node (`false` when unset). */
function tabsElementClosable(tabs: Node): boolean {
  return tabClosables.get(tabs) ?? false;
}

/** Clamp `index` into `[0, count - 1]` (0 when `count` is 0). */
function clampTabIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, Math.max(0, count - 1)));
}

/** Whether the tab at `index` shows a close affordance: its own `closable`
 * flag wins, falling back to the element's `closable` default. */
function tabClosable(spec: TabSpec, elementClosable: boolean): boolean {
  return spec.closable ?? elementClosable;
}

/** The text of one tab leaf: the label — prefixed by the top-border marker
 * when active, suffixed by the close glyph when closable. */
function tabLeafText(
  spec: TabSpec,
  isActive: boolean,
  closable: boolean,
): string {
  const text = isActive ? TAB_ACTIVE_MARKER + spec.label : spec.label;
  return closable ? `${text} ${TAB_CLOSE_CHAR}` : text;
}

/** The props of one tab leaf: active tabs are painted with the `primary`
 * palette colors and reversed; closable tabs carry the close glyph. */
function tabLeafProps(
  spec: TabSpec,
  isActive: boolean,
  closable: boolean,
): NodeProps {
  const props: NodeProps = { text: tabLeafText(spec, isActive, closable) };
  if (isActive) {
    props.fg = TAB_PRIMARY_FG;
    props.bg = TAB_PRIMARY_BG;
    props.reversed = true;
  }
  return props;
}

/**
 * Rebuild a tabs node's children from its current props (the source of truth,
 * mirroring `rebuildTable`): the tab bar row — a flex row box holding one
 * `Text` leaf per tab (the active one reversed + primary + top-border
 * marker, closable tabs carrying the close glyph) — plus the content region
 * box (a flex column) holding the active tab's content nodes. The same
 * content node instances are re-attached on every rebuild, mirroring
 * `Panels`' collapsed-body restore. Runs at creation and after every
 * `activateTab` / `closeTab` / `tabsKey` mutation.
 */
function rebuildTabs(tabs: Node): void {
  const props = tabs.props as TabsProps;
  const specs = tabSpecs.get(tabs) ?? [];
  const active = clampTabIndex(
    typeof props.active === "number" ? props.active : 0,
    specs.length,
  );
  const elementClosable = tabsElementClosable(tabs);

  for (const child of [...tabs.children]) child.remove();

  const bar = Box({ flex_direction: "row" });
  specs.forEach((spec, index) => {
    bar.addChild(
      Text(
        tabLeafProps(
          spec,
          index === active,
          tabClosable(spec, elementClosable),
        ),
      ),
    );
  });
  tabs.addChild(bar);

  const region = Box({ flex_direction: "column" });
  const content = specs[active]?.content ?? [];
  for (const node of content) region.addChild(node);
  tabs.addChild(region);
}

/**
 * Create a `tabs` element: a flex column of box/text leaves — a tab bar row
 * (one `Text` leaf per tab; the active tab painted with the theme's `primary`
 * palette colors and reversed, its label prefixed with a top-border marker)
 * plus a content region box (a flex column) holding the active tab's content
 * nodes. The tab list is JS bookkeeping (never scene props); the interactive
 * state (`active`) lives on the root box's props. Drive it with
 * {@link activateTab} / {@link closeTab} / {@link tabsKey}. No new napi node
 * kind: the `tabs` element materializes as a `box` (constitution).
 */
export function Tabs(props: TabsProps): Node {
  const specs = props.tabs.map((spec) => ({
    ...spec,
    content: [...spec.content],
  }));
  const rootProps: NodeProps = {
    ...props,
    active: clampTabIndex(
      typeof props.active === "number" ? props.active : 0,
      specs.length,
    ),
    flex_direction: "column",
  };
  const plain = rootProps as Record<string, unknown>;
  delete plain.tabs;
  delete plain.closable;
  const tabs = Node.create("tabs", rootProps, []);
  tabSpecs.set(tabs, specs);
  tabClosables.set(tabs, props.closable ?? false);
  rebuildTabs(tabs);
  return tabs;
}

/**
 * Make the tab at `index` the active tab (clamped into the tabs), restyling
 * the tab bar and swapping the content region to the tab's content. A no-op
 * when `index` is out of range or already active.
 */
export function activateTab(tabs: Node, index: number): void {
  const specs = tabSpecs.get(tabs) ?? [];
  const clamped = clampTabIndex(index, specs.length);
  const current = clampTabIndex(
    typeof tabs.props.active === "number" ? tabs.props.active : 0,
    specs.length,
  );
  if (clamped === current) return;
  tabs.setProps({ ...tabs.props, active: clamped });
  rebuildTabs(tabs);
}

/**
 * Close the tab at `index`: remove it from the tab list and re-clamp the
 * active index — closing a tab before the active one shifts it down, closing
 * the active one leaves the tab that slid into its slot (the new last tab
 * when the closed one was last; index 0 when the last tab closed). A no-op
 * when `index` is out of range.
 */
export function closeTab(tabs: Node, index: number): void {
  const specs = tabSpecs.get(tabs);
  if (specs === undefined) return;
  if (index < 0 || index >= specs.length) return;
  const props = tabs.props as TabsProps;
  const oldActive = clampTabIndex(
    typeof props.active === "number" ? props.active : 0,
    specs.length,
  );
  specs.splice(index, 1);
  const nextActive = clampTabIndex(
    index < oldActive ? oldActive - 1 : oldActive,
    specs.length,
  );
  tabs.setProps({ ...props, active: nextActive });
  rebuildTabs(tabs);
}

/**
 * Apply a key to a tabs node, mutating its state and rebuilding the
 * composition in place — the Tabs counterpart of {@link selectKey}.
 *
 * - `left` / `right` move the active tab (clamped at the ends).
 * - `ctrl+tab` / `ctrl+shift+tab` move to the next / previous tab, wrapping
 *   around the ends.
 * - `ctrl+w` closes the active tab (the active index re-clamps into the
 *   shorter list).
 *
 * Returns the new state; any other key leaves the tabs unchanged.
 */
export function tabsKey(tabs: Node, event: KeyEvent): TabsState {
  const specs = tabSpecs.get(tabs) ?? [];
  const active = clampTabIndex(
    typeof tabs.props.active === "number" ? tabs.props.active : 0,
    specs.length,
  );
  const name = event.name;

  if (name === "left") {
    activateTab(tabs, active - 1);
  } else if (name === "right") {
    activateTab(tabs, active + 1);
  } else if (name === "tab" && event.ctrl && !event.shift) {
    // ctrl+tab: next, wrapping to the first tab.
    if (specs.length > 1) activateTab(tabs, (active + 1) % specs.length);
  } else if (name === "tab" && event.ctrl && event.shift) {
    // ctrl+shift+tab: previous, wrapping to the last tab.
    if (specs.length > 1) {
      activateTab(tabs, (active - 1 + specs.length) % specs.length);
    }
  } else if (name === "w" && event.ctrl) {
    // ctrl+w: close the active tab (closeTab re-clamps the active index).
    closeTab(tabs, active);
  }

  // Re-read the live state: a ctrl+w close changed the tab count.
  const after = tabSpecs.get(tabs) ?? [];
  const nextActive = clampTabIndex(
    typeof tabs.props.active === "number" ? tabs.props.active : 0,
    after.length,
  );
  return { active: nextActive, count: after.length };
}

