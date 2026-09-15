//! Layer A's construction gate: the framework elements the plan's auxiliary panes
//! name are really built, and each one recomposes the row it replaces.
//!
//! WHY THE MOUNT PAINT GATE IS NOT ENOUGH. parity/mount_paint_test.ts proves the
//! mounted scene paints the plan's frame, but a layer could pass it by painting the
//! plan's TEXT and never constructing the framework element at all — which is
//! exactly the state 15c left Behind for `Menu`, `Checkbox`, `Radio` and `Toggle`.
//! This test reads the committed scene back and asserts the element node kinds are
//! there, and that each element's own composition is the plan span it stands for.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/layers/core/

import type { Node } from "@tern-tui/core";
import { referencePlan } from "../../parity/goldens/fixture.ts";
import { FIXTURES } from "../../parity/goldens/index.ts";
import type { ModalRegion } from "../../core/plan.ts";
import { controlSpec, paletteMenuSpec, pickerSelectSpec } from "../pane-elements.ts";
import { mountPlan } from "./mount.ts";
import { controlNode, menuNode, selectNode } from "./pane-elements.ts";

/** Fail unless `condition`. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** The plan of one fixture by its screen id. */
function planOf(screen: string) {
  const fixture = FIXTURES.find((entry) => entry.screen === screen);
  check(fixture !== undefined, "no fixture for " + screen);
  return referencePlan(fixture!);
}

/** Every node of `types` in `node`'s subtree, pre-order. */
function collect(node: Node, types: ReadonlySet<string>, out: string[]): void {
  if (types.has(node.type)) out.push(node.type);
  for (const child of node.children) collect(child, types, out);
}

/** One node's composed row text: its direct text children, concatenated. */
function composition(node: Node): string {
  return node.children.map((child) => String(child.props.text ?? "")).join("");
}

const FORM_TYPES: ReadonlySet<string> = new Set(["checkbox", "radio", "toggle"]);

Deno.test("core pane: the preferences and theme rows mount the framework form elements", () => {
  const preferences: string[] = [];
  const theme: string[] = [];
  collect(mountPlan(planOf("preferences")), FORM_TYPES, preferences);
  collect(mountPlan(planOf("theme")), FORM_TYPES, theme);
  check(preferences.length === 4, "the preferences overlay mounted " + preferences.length + " form elements, expected 4");
  check(preferences.includes("checkbox") && preferences.includes("radio") && preferences.includes("toggle"),
    "the preferences overlay did not mount all three primitives: " + preferences.join(","));
  check(theme.length === 3 && theme.every((type) => type === "radio"),
    "the theme overlay's choices are not three radio rows: " + theme.join(","));
  console.log("core pane: preferences mounts checkbox + radio + toggle, theme mounts a 3-row radio group");
});

Deno.test("core pane: every control element recomposes the plan row it replaces", () => {
  let controls = 0;
  for (const screen of ["preferences", "theme"]) {
    const plan = planOf(screen);
    const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
    check(modal !== undefined, screen + " has no modal region");
    for (const row of modal!.rows) {
      for (const span of row.spans) {
        const spec = controlSpec(modal!.id, span.text);
        if (spec === null) continue;
        controls += 1;
        check(composition(controlNode(spec)) === span.text,
          screen + ": the " + spec.kind + " composes " + JSON.stringify(composition(controlNode(spec))) +
          ", the plan's span is " + JSON.stringify(span.text));
      }
    }
  }
  check(controls === 7, "checked " + controls + " control spans, expected 7");
  console.log("core pane: " + controls + " control spans — every element recomposes its plan row exactly");
});

Deno.test("core pane: the palette Menu composes the plan's command rows", () => {
  const plan = planOf("palette");
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  check(modal !== undefined, "the palette plan has no modal region");
  const spec = paletteMenuSpec(modal!);
  check(spec !== null, "the palette modal yielded no Menu spec");
  const labels = spec!.items.map((item) => item.label);
  check(labels.length > 0, "the palette Menu has no items");
  const rows = menuNode(spec!).children.map((child) => String(child.props.text ?? ""));
  check(rows.join("|") === labels.join("|"),
    "the Menu rows are not the plan's command labels:\n  " + JSON.stringify(rows) + "\n  " + JSON.stringify(labels));
  check(spec!.highlighted >= 0 && spec!.highlighted < labels.length, "the Menu highlight is out of range");
  console.log("core pane: the palette Menu composes " + labels.length + " command rows, the active one at " + spec!.highlighted);
});

Deno.test("core pane: the picker Select composes the plan's option rows", () => {
  const plan = planOf("chooser");
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  check(modal !== undefined && modal.id === "picker", "the chooser plan has no picker modal");
  const spec = pickerSelectSpec(modal!);
  check(spec !== null, "the picker modal yielded no Select spec");
  const options = selectNode(spec!).children.slice(1).map((child) => String(child.props.text ?? ""));
  check(options.join("|") === spec!.options.map((option) => option.label).join("|"),
    "the Select option rows are not the picker's files:\n  " + JSON.stringify(options));
  check(spec!.filter === "src/feature", "the Select filter is not the plan's query: " + JSON.stringify(spec!.filter));
  console.log("core pane: the picker Select composes " + spec!.options.length + " options under filter " + JSON.stringify(spec!.filter));
});
