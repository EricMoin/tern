//! Tests: HelpPanel renders a key-help overlay: right-aligned key colu.

import { state } from "./testkit.ts";
import { withScrollFakeAddon } from "./testkit.ts";
// `maxScroll` is a module-level helper (not part of the barrel
// surface), so this case imports it straight from the module.
import { maxScroll } from "./scrollview.ts";
import { Box, FocusManager, HelpPanel, HelpPanelProps, Keymap, MODAL_BACKDROP_BG, MODAL_Z_INDEX, Modal, NodeProps, SCROLLBAR_THUMB_CHAR, SCROLLBAR_TRACK_CHAR, ScrollView, THEME_COMPONENTS, THEME_ROLES, Text, Theme, ThemeOverrides, ThemeResolvableProps, Toggle, closeModal, createRenderer, declareVirtualContent, defaultTheme, keymap, mergeTheme, name, openModal, resolveTheme, scrollBy, scrollTo, scrollTop, useFocus } from "./index.ts";


Deno.test("HelpPanel renders a key-help overlay: right-aligned key column, dimmed descriptions, optional title", () => {
  const km = new Keymap();
  km.register({ name: "k", ctrl: true }, () => {}, "Copy selection");
  km.register({ name: "enter" }, () => {}, "Confirm");
  km.register({ name: "escape" }, () => {}); // no description: skipped in the overlay
  km.register({ name: "f1" }, () => {}, "Help");
  const panel = HelpPanel({ keymap: km });
  if (panel.type !== "box") throw new Error(`root type = ${panel.type}`);
  const flex = (): unknown => panel.props.flex_direction;
  if (flex() !== "column") {
    throw new Error(
      `root flex = ${JSON.stringify(panel.props.flex_direction)}`,
    );
  }
  // keymap/title are JS bookkeeping, never scene props.
  if ("keymap" in panel.props) {
    throw new Error("keymap must not reach the scene props");
  }
  if ("title" in panel.props) {
    throw new Error("title must not reach the scene props");
  }
  // Three described rows in registration order; the description-less escape
  // entry is skipped. Key column width = widest hint ("ctrl+k", 6): keys
  // right-aligned inside it (bubbletea help alignment).
  const rows = panel.children;
  if (rows.length !== 3) throw new Error(`rows = ${rows.length}`);
  const golden = [
    ["ctrl+k", "Copy selection"],
    [" enter", "Confirm"],
    ["    f1", "Help"],
  ] as const;
  for (let i = 0; i < golden.length; i++) {
    const row = rows[i]!;
    if (row.type !== "box" || row.props.flex_direction !== "row") {
      throw new Error(
        `row ${i} must be a row box: ${JSON.stringify(row.props)}`,
      );
    }
    const [keyLeaf, descLeaf] = row.children;
    if (keyLeaf?.props.text !== golden[i]![0]) {
      throw new Error(`row ${i} keys = ${JSON.stringify(keyLeaf?.props.text)}`);
    }
    if (descLeaf?.props.text !== golden[i]![1]) {
      throw new Error(
        `row ${i} desc = ${JSON.stringify(descLeaf?.props.text)}`,
      );
    }
    if (descLeaf?.props.dim !== true) {
      throw new Error(
        `row ${i} desc must be dimmed: ${JSON.stringify(descLeaf?.props)}`,
      );
    }
    // The dimmed description carries bubbletea's two-cell separator gap.
    if (descLeaf?.props.margin_left !== 2) {
      throw new Error(
        `row ${i} desc margin_left = ${
          JSON.stringify(descLeaf?.props.margin_left)
        }`,
      );
    }
  }
  // The optional title renders as a plain bold text row above the entries.
  const titled = HelpPanel({ keymap: km, title: "Keymap" });
  if (titled.children.length !== 4) {
    throw new Error(`titled children = ${titled.children.length}`);
  }
  const titleLeaf = titled.children[0]!;
  if (titleLeaf.type !== "text" || titleLeaf.props.text !== "Keymap") {
    throw new Error(`title leaf = ${JSON.stringify(titleLeaf.props)}`);
  }
  if (titleLeaf.props.bold !== true) {
    throw new Error(`title must be bold: ${JSON.stringify(titleLeaf.props)}`);
  }
  // An empty map renders an empty panel (no rows).
  if (HelpPanel({ keymap: new Keymap() }).children.length !== 0) {
    throw new Error("empty keymap must render no rows");
  }
});

Deno.test("HelpPanel defaults to the module-level keymap and resolves the help component preset", () => {
  const custom = mergeTheme(defaultTheme, {
    components: {
      help: { fg: "#98c379", bg: "#111111", border_style: "double" },
    },
  });
  const out = resolveTheme(custom, { component: "help" });
  if (out.fg !== "#98c379") throw new Error(`fg = ${out.fg}`);
  if (out.bg !== "#111111") throw new Error(`bg = ${out.bg}`);
  if (out.border_style !== "double") {
    throw new Error(`border_style = ${out.border_style}`);
  }
  if ("component" in out) {
    throw new Error(`component leaked: ${JSON.stringify(out)}`);
  }
  // The preset is stamped onto the root box by the factory path (the explicit
  // prop wins over the preset); the resolveTheme output widens to NodeProps,
  // so it narrows to HelpPanelProps at the call site — the same cast the
  // react/solid hosts use.
  const unreg = keymap.register(
    { name: "h", ctrl: true },
    () => {},
    "Toggle help",
  );
  try {
    const panel = HelpPanel(
      resolveTheme(custom, { component: "help" }) as HelpPanelProps,
    );
    if (panel.props.fg !== "#98c379") {
      throw new Error(`factory fg = ${panel.props.fg}`);
    }
    if (panel.props.bg !== "#111111") {
      throw new Error(`factory bg = ${panel.props.bg}`);
    }
    if (panel.props.border_style !== "double") {
      throw new Error(`factory border = ${panel.props.border_style}`);
    }
    // The module-level keymap is the default source.
    if (panel.children.length !== 1) {
      throw new Error(`default keymap rows = ${panel.children.length}`);
    }
    const row = panel.children[0]!;
    if (row.children[0]?.props.text !== "ctrl+h") {
      throw new Error(`keys = ${JSON.stringify(row.children[0]?.props.text)}`);
    }
    if (row.children[1]?.props.text !== "Toggle help") {
      throw new Error(`desc = ${JSON.stringify(row.children[1]?.props.text)}`);
    }
  } finally {
    unreg();
  }
  // "help" is a themeable component preset carried by the default theme.
  if (!THEME_COMPONENTS.includes("help")) {
    throw new Error("help must be in THEME_COMPONENTS");
  }
  if (defaultTheme.components.help === undefined) {
    throw new Error("defaultTheme must carry the help component preset");
  }
});

Deno.test("Modal composes a dimmed backdrop plus a centered content box at a high z_index", () => {
  const content = Text({ text: "hi" });
  const modal = Modal({ open: true, content: [content] });
  if (modal.type !== "modal") throw new Error(`type = ${modal.type}`);
  // The overlay paints above in-flow content (z 0; the scrollbar/sticky
  // header stack at 1): the root box carries the high default z_index.
  if (modal.props.z_index !== MODAL_Z_INDEX) {
    throw new Error(`z_index = ${modal.props.z_index}`);
  }
  if (modal.props.position !== "absolute") {
    throw new Error(`position = ${modal.props.position}`);
  }
  if (
    modal.props.justify_content !== "center" ||
    modal.props.align_items !== "center"
  ) {
    throw new Error(`centering = ${JSON.stringify(modal.props)}`);
  }
  if (modal.props.open !== true) throw new Error(`open = ${modal.props.open}`);
  if (modal.props.hidden !== false) {
    throw new Error(`hidden = ${modal.props.hidden}`);
  }
  if (modal.props.display !== "flex") {
    throw new Error(`display = ${modal.props.display}`);
  }
  // An explicit z_index is honored.
  const layered = Modal({ z_index: 5 });
  if (layered.props.z_index !== 5) {
    throw new Error(`layered z_index = ${layered.props.z_index}`);
  }
  // Composition: a dimmed backdrop fill + a centered content box holding the
  // content nodes.
  if (modal.children.length !== 2) {
    throw new Error(`children = ${modal.children.length}`);
  }
  const backdrop = modal.children[0];
  if (backdrop?.props.position !== "absolute") {
    throw new Error("backdrop must be an absolute fill");
  }
  if (
    backdrop?.props.bg !== MODAL_BACKDROP_BG || backdrop?.props.dim !== true
  ) {
    throw new Error(`backdrop = ${JSON.stringify(backdrop?.props)}`);
  }
  const box = modal.children[1];
  if (box?.type !== "box" || box?.props.flex_direction !== "column") {
    throw new Error("content box must be a flex column");
  }
  if (box?.children[0] !== content) {
    throw new Error("content must live inside the content box");
  }
  // `backdrop: false` skips the dim layer (content box only).
  const bare = Modal({ backdrop: false });
  if (bare.children.length !== 1) {
    throw new Error(`bare children = ${bare.children.length}`);
  }
  // `content` is JS bookkeeping, never a scene prop.
  if ("content" in modal.props) {
    throw new Error("content must not reach the scene props");
  }
});

Deno.test("Modal starts hidden and openModal/closeModal toggle the visible state", () => {
  // The default (open: false) modal is hidden. Fresh reads per assertion —
  // TS narrows a const-typed property access to its first-checked literal.
  const closed = Modal();
  const open = (): unknown => closed.props.open;
  const hidden = (): unknown => closed.props.hidden;
  const display = (): unknown => closed.props.display;
  if (open() !== false) throw new Error(`open = ${open()}`);
  if (hidden() !== true) throw new Error(`hidden = ${hidden()}`);
  if (display() !== "none") throw new Error(`display = ${display()}`);
  // openModal shows it; closeModal hides it again.
  openModal(closed);
  if (open() !== true || hidden() !== false || display() !== "flex") {
    throw new Error(`after open = ${JSON.stringify(closed.props)}`);
  }
  closeModal(closed);
  if (open() !== false || hidden() !== true || display() !== "none") {
    throw new Error(`after close = ${JSON.stringify(closed.props)}`);
  }
  // Opening an already-open modal is a no-op (the focus record must not be
  // overwritten by the focus that now sits inside the overlay).
  openModal(closed);
  openModal(closed);
  if (open() !== true) {
    throw new Error(`double open = ${JSON.stringify(closed.props)}`);
  }
  closeModal(closed);
  closeModal(closed);
  if (open() !== false) {
    throw new Error(`double close = ${JSON.stringify(closed.props)}`);
  }
  // A foreign node (not created by the Modal factory) is left alone.
  const box = Box();
  openModal(box);
  if ("open" in box.props) {
    throw new Error("openModal must ignore non-modal nodes");
  }
  closeModal(box);
});

Deno.test("openModal focuses the first registered focusable and closeModal restores the prior focus", () => {
  const modal = Modal({});
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const outsideNode = Text({ text: "out" });
  // The overlay's focusable registers first, so `openModal`'s `focusFirst()`
  // lands inside the overlay; the outside focusable is the prior focus that
  // closing restores. Fresh read per assertion (see the toggle test above).
  const inside = useFocus("modal-in", insideNode, () => {}, manager);
  const outside = useFocus("modal-out", outsideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    manager.focus("modal-out");
    if (activeId() !== "modal-out") throw new Error("setup focus failed");
    openModal(modal, manager);
    if (activeId() !== "modal-in") {
      throw new Error(
        `open must focus the first registered focusable, got ${activeId()}`,
      );
    }
    closeModal(modal, manager);
    if (activeId() !== "modal-out") {
      throw new Error(`close must restore the prior focus, got ${activeId()}`);
    }
  } finally {
    inside.dispose();
    outside.dispose();
    manager.blur();
  }
});

Deno.test("closeModal falls back to a blur when nothing was focused before the open", () => {
  const modal = Modal({});
  const manager = new FocusManager();
  const insideNode = Text({ text: "in" });
  const inside = useFocus("modal-fallback-in", insideNode, () => {}, manager);
  const activeId = (): string | null => manager.activeId;
  try {
    // Nothing is focused when the modal opens: the record is null.
    openModal(modal, manager);
    if (activeId() !== "modal-fallback-in") {
      throw new Error(
        `focusFirst must focus the registered focusable, got ${activeId()}`,
      );
    }
    closeModal(modal, manager);
    if (activeId() !== null) {
      throw new Error(
        `close with no recorded focus must blur, got ${activeId()}`,
      );
    }
    // A recorded id that was unregistered meanwhile also falls back to blur.
    manager.focus("modal-fallback-in");
    openModal(modal, manager);
    inside.dispose(); // unregister the recorded id while the modal is open
    closeModal(modal, manager);
    if (activeId() !== null) {
      throw new Error(
        `close with an unregistered recorded id must blur, got ${activeId()}`,
      );
    }
  } finally {
    inside.dispose();
    manager.blur();
  }
});

Deno.test("defaultTheme covers every palette role and component preset", () => {
  for (const role of THEME_ROLES) {
    const colors = defaultTheme.palette[role];
    if (colors === undefined) throw new Error(`missing palette role ${role}`);
    if (typeof colors.fg !== "string" || colors.fg === "") {
      throw new Error(`role ${role} fg = ${JSON.stringify(colors.fg)}`);
    }
    if (typeof colors.bg !== "string" || colors.bg === "") {
      throw new Error(`role ${role} bg = ${JSON.stringify(colors.bg)}`);
    }
  }
  for (const kind of THEME_COMPONENTS) {
    if (defaultTheme.components[kind] === undefined) {
      throw new Error(`missing component preset ${kind}`);
    }
  }
});

Deno.test("resolveTheme stamps the role palette fg/bg and strips the hint", () => {
  const out = resolveTheme(defaultTheme, { role: "danger" });
  if (out.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`fg = ${out.fg}`);
  }
  if (out.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`bg = ${out.bg}`);
  }
  if ("role" in out) throw new Error(`role leaked: ${JSON.stringify(out)}`);
  if ("component" in out) {
    throw new Error(`component leaked: ${JSON.stringify(out)}`);
  }
});

Deno.test("resolveTheme stamps a component preset fg/bg/border_style", () => {
  const custom = mergeTheme(defaultTheme, {
    components: { input: { fg: "#123456", border_style: "rounded" } },
  });
  const out = resolveTheme(custom, { component: "input" });
  if (out.fg !== "#123456") throw new Error(`fg = ${out.fg}`);
  if (out.border_style !== "rounded") {
    throw new Error(`border_style = ${out.border_style}`);
  }
  if ("component" in out) {
    throw new Error(`component leaked: ${JSON.stringify(out)}`);
  }
});

Deno.test("resolveTheme precedence: explicit props > role palette > component preset", () => {
  const custom = mergeTheme(defaultTheme, {
    components: {
      status_bar: { fg: "#111111", bg: "#222222", border_style: "thick" },
    },
  });
  // No explicit style: the component preset fills fg/bg/border_style.
  const presetOnly = resolveTheme(custom, { component: "status_bar" });
  if (presetOnly.fg !== "#111111" || presetOnly.bg !== "#222222") {
    throw new Error(`preset fill = ${JSON.stringify(presetOnly)}`);
  }
  if (presetOnly.border_style !== "thick") {
    throw new Error(`preset border_style = ${presetOnly.border_style}`);
  }
  // Role added: the role palette overrides the preset's fg/bg (role is the
  // more specific intent), the preset's border_style is kept.
  const roleWins = resolveTheme(custom, {
    component: "status_bar",
    role: "danger",
  });
  if (roleWins.fg !== custom.palette.danger.fg) {
    throw new Error(`role must win over preset fg: ${roleWins.fg}`);
  }
  if (roleWins.bg !== custom.palette.danger.bg) {
    throw new Error(`role must win over preset bg: ${roleWins.bg}`);
  }
  if (roleWins.border_style !== "thick") {
    throw new Error(
      `preset border_style must survive: ${roleWins.border_style}`,
    );
  }
  // Explicit props win over both.
  const explicit = resolveTheme(custom, {
    component: "status_bar",
    role: "danger",
    fg: "#ff0000",
  });
  if (explicit.fg !== "#ff0000") {
    throw new Error(`explicit fg = ${explicit.fg}`);
  }
  if (explicit.bg !== custom.palette.danger.bg) {
    throw new Error(
      `explicit fg must not suppress the role bg: ${explicit.bg}`,
    );
  }
});

Deno.test("resolveTheme without hints returns the props unchanged (plain node props)", () => {
  const props: ThemeResolvableProps = { text: "hi", bold: true, width: 10 };
  const out = resolveTheme(defaultTheme, props);
  if (out.text !== "hi" || out.bold !== true || out.width !== 10) {
    throw new Error(`props changed: ${JSON.stringify(out)}`);
  }
  if (Object.keys(out).length !== 3) {
    throw new Error(`unexpected keys: ${JSON.stringify(out)}`);
  }
});

Deno.test("resolveTheme output feeds the element factories as plain node props", () => {
  const node = Text(
    resolveTheme(defaultTheme, { text: "err", role: "danger" }),
  );
  if (node.type !== "text") throw new Error(`type = ${node.type}`);
  if (node.props.fg !== defaultTheme.palette.danger.fg) {
    throw new Error(`stamped fg = ${node.props.fg}`);
  }
  if (node.props.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`stamped bg = ${node.props.bg}`);
  }
  if ("role" in node.props || "component" in node.props) {
    throw new Error(
      `semantic hints reached the node: ${JSON.stringify(node.props)}`,
    );
  }
});

Deno.test("mergeTheme merges partial roles and keeps base keys", () => {
  const overrides: ThemeOverrides = { palette: { danger: { fg: "#ff0000" } } };
  const merged = mergeTheme(defaultTheme, overrides);
  // The overridden role keeps its base bg and gains the override fg.
  if (merged.palette.danger.fg !== "#ff0000") {
    throw new Error(`merged fg = ${merged.palette.danger.fg}`);
  }
  if (merged.palette.danger.bg !== defaultTheme.palette.danger.bg) {
    throw new Error(`base bg must be kept: ${merged.palette.danger.bg}`);
  }
  // Untouched roles are copied through unchanged.
  if (merged.palette.success.fg !== defaultTheme.palette.success.fg) {
    throw new Error(`untouched role changed: ${merged.palette.success.fg}`);
  }
  // The base is not mutated.
  if (defaultTheme.palette.danger.fg === "#ff0000") {
    throw new Error("mergeTheme must not mutate the base theme");
  }
  if (merged === defaultTheme) {
    throw new Error("mergeTheme must return a new theme");
  }
});

Deno.test("mergeTheme merges component presets per key", () => {
  const merged = mergeTheme(defaultTheme, {
    components: { panels: { border_style: "double" } },
  });
  if (merged.components.panels.border_style !== "double") {
    throw new Error(
      `preset border_style = ${merged.components.panels.border_style}`,
    );
  }
  if ("fg" in merged.components.panels) {
    throw new Error(
      `unset preset key must stay absent: ${
        JSON.stringify(merged.components.panels)
      }`,
    );
  }
  // Other component presets are untouched.
  if (merged.components.input !== defaultTheme.components.input) {
    throw new Error("untouched preset must be copied through");
  }
});

Deno.test("mergeTheme accepts a full Theme as overrides", () => {
  const custom: Theme = mergeTheme(defaultTheme, {
    palette: { primary: { fg: "#0000ff", bg: "#000000" } },
  });
  const merged = mergeTheme(defaultTheme, custom);
  if (
    merged.palette.primary.fg !== "#0000ff" ||
    merged.palette.primary.bg !== "#000000"
  ) {
    throw new Error(
      `full-theme override = ${JSON.stringify(merged.palette.primary)}`,
    );
  }
  if (merged.palette.muted.fg !== defaultTheme.palette.muted.fg) {
    throw new Error(`unoverridden role changed: ${merged.palette.muted.fg}`);
  }
});

Deno.test("ScrollView builds a scroll_view box with the clip/scroll region props", () => {
  const view = ScrollView({
    clip_x: 1,
    clip_y: 2,
    clip_width: 10,
    clip_height: 4,
    scroll_x: 0,
    scroll_y: 3,
  });
  if (view.type !== "scroll_view") throw new Error(`type = ${view.type}`);
  if (view.props.clip_x !== 1) throw new Error(`clip_x = ${view.props.clip_x}`);
  if (view.props.clip_y !== 2) throw new Error(`clip_y = ${view.props.clip_y}`);
  if (view.props.clip_width !== 10) {
    throw new Error(`clip_width = ${view.props.clip_width}`);
  }
  if (view.props.clip_height !== 4) {
    throw new Error(`clip_height = ${view.props.clip_height}`);
  }
  if (view.props.scroll_x !== 0) {
    throw new Error(`scroll_x = ${view.props.scroll_x}`);
  }
  if (view.props.scroll_y !== 3) {
    throw new Error(`scroll_y = ${view.props.scroll_y}`);
  }
});

Deno.test("ScrollView attaches rest-arg and props children, consuming both keys", () => {
  const a = Text({ text: "a" });
  const b = Text({ text: "b" });
  const viaProps = ScrollView({ children: [b] }, a);
  const kids = viaProps.children;
  if (kids.length !== 2) throw new Error(`children = ${kids.length}`);
  if (kids[0] !== a || kids[1] !== b) {
    throw new Error("content order must be rest args then props children");
  }
  // Both keys are consumed by the factory — never scene props.
  if ("children" in viaProps.props || "showScrollbar" in viaProps.props) {
    throw new Error(`consumed keys leaked: ${JSON.stringify(viaProps.props)}`);
  }
});

Deno.test("showScrollbar appends a scrollbar text leaf to the composition", () => {
  const withBar = ScrollView({ showScrollbar: true }, Text({ text: "x" }));
  // Content + the scrollbar leaf (a text node pinned to the right edge).
  if (withBar.children.length !== 2) {
    throw new Error(`children = ${withBar.children.length}`);
  }
  const leaf = withBar.children[1];
  if (leaf === undefined || leaf.type !== "text") {
    throw new Error("scrollbar must be a text leaf");
  }
  if (
    leaf.props.position !== "absolute" || leaf.props.right !== 0 ||
    leaf.props.width !== 1
  ) {
    throw new Error(`leaf props = ${JSON.stringify(leaf.props)}`);
  }
  // Without the flag no scrollbar leaf is composed.
  const noBar = ScrollView({}, Text({ text: "x" }));
  if (noBar.children.length !== 1) {
    throw new Error(`no-bar children = ${noBar.children.length}`);
  }
});

Deno.test("scrollTo sets scroll props and clamps to the content bounds", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 2} (from the width/height props); the content text is
    // 5 cells wide, 3 rows tall -> maxY = 1, maxX = 0.
    const view = ScrollView(
      { width: 5, height: 2 },
      Text({ text: "aaaa\nbbbbb\ncc" }),
    );
    renderer.root.addChild(view);
    const applied = scrollTo(view, 0, 5);
    if (applied.x !== 0 || applied.y !== 1) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    if (view.props.scroll_x !== 0 || view.props.scroll_y !== 1) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scrollTo clamps horizontal overflow against the content width", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {3, 2}; the content text is 8 cells wide -> maxX = 5.
    const view = ScrollView(
      { width: 3, height: 2 },
      Text({ text: "abcdefgh" }),
    );
    renderer.root.addChild(view);
    const applied = scrollTo(view, 10, 0);
    if (applied.x !== 5 || applied.y !== 0) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    if (view.props.scroll_x !== 5) {
      throw new Error(`scroll_x = ${view.props.scroll_x}`);
    }
  });
});

Deno.test("scrollBy offsets from the current scroll and clamps both directions", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView(
      { width: 5, height: 2 },
      Text({ text: "aaaa\nbbbbb\ncc" }),
    );
    renderer.root.addChild(view);
    scrollTo(view, 0, 1); // at the max offset
    const applied = scrollBy(view, 0, 3); // past the max -> clamped back
    if (applied.y !== 1) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    const back = scrollBy(view, 0, -1); // back up
    if (back.y !== 0) throw new Error(`back = ${JSON.stringify(back)}`);
    if (view.props.scroll_y !== 0) {
      throw new Error(`scroll_y = ${view.props.scroll_y}`);
    }
  });
});

Deno.test("scrollTop resets the vertical offset and keeps the horizontal", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView(
      { width: 3, height: 2 },
      Text({ text: "abcdefgh" }),
    );
    renderer.root.addChild(view);
    scrollTo(view, 5, 0);
    const applied = scrollTop(view);
    if (applied.x !== 5 || applied.y !== 0) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    if (view.props.scroll_x !== 5 || view.props.scroll_y !== 0) {
      throw new Error(`props = ${JSON.stringify(view.props)}`);
    }
  });
});

Deno.test("scroll helpers refresh the scrollbar track and thumb from the clamped offset", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Viewport {5, 3}; content height 5 -> maxY = 2, thumb length 2
    // (round(3*3/5) = 2) on a 1-row track range.
    const view = ScrollView(
      { width: 5, height: 3, showScrollbar: true },
      Text({ text: "aa\nbb\ncc\ndd\nee" }),
    );
    renderer.root.addChild(view);
    const leaf = view.children[1]!;

    // At the top: the thumb fills the first two rows of the track.
    scrollTo(view, 0, 0);
    if (leaf.props.height !== 3) {
      throw new Error(`leaf height = ${leaf.props.height}`);
    }
    const topText = leaf.props.text;
    if (
      topText !==
        `${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_TRACK_CHAR}`
    ) {
      throw new Error(`top scrollbar = ${JSON.stringify(topText)}`);
    }

    // Scrolled to the bottom (maxY = 2): the thumb drops to the last two
    // rows, and the `top` inset is scroll-compensated (thumbOffset 1 +
    // scroll_y 2).
    scrollTo(view, 0, 2);
    const bottomText = leaf.props.text;
    if (
      bottomText !==
        `${SCROLLBAR_TRACK_CHAR}\n${SCROLLBAR_THUMB_CHAR}\n${SCROLLBAR_THUMB_CHAR}`
    ) {
      throw new Error(`bottom scrollbar = ${JSON.stringify(bottomText)}`);
    }
    if (leaf.props.top !== 3) throw new Error(`leaf top = ${leaf.props.top}`);
  });
});

Deno.test("scroll helpers on a detached view throw (contentSize requires the scene)", () => {
  const view = ScrollView({ width: 5, height: 2 }, Text({ text: "x" }));
  let threw = false;
  try {
    scrollTo(view, 0, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("scrollTo on a detached view must throw");
});

Deno.test("removing a scroll view clears its scrollbar from the scene", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const view = ScrollView(
      { width: 5, height: 2, showScrollbar: true },
      Text({ text: "x" }),
    );
    renderer.root.addChild(view);
    const leaf = view.children[1]!;
    if (!view.attached || !leaf.attached) {
      throw new Error("view and scrollbar must attach");
    }
    if (view.remove() !== true) throw new Error("remove must succeed");
    // The whole subtree detaches with the view: the scrollbar leaf is
    // cleared from the scene, and the view is spliced out of its parent.
    if (view.attached || leaf.attached) {
      throw new Error("scrollbar must detach with the view");
    }
    if (renderer.root.children.length !== 0) {
      throw new Error("view must be spliced out of the scene");
    }
  });
});

Deno.test("declareVirtualContent is measured before the per-child walk by maxScroll and scrollTo", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // A {5, 2} viewport over a 6x3 leaf: measured, both axes clamp at 1.
    const child = Text({ text: "aaaaaa\nbbbbb\ncc" });
    const view = ScrollView({ width: 5, height: 2 }, child);
    renderer.root.addChild(view);
    // Count the child's `contentSize` calls: the declared geometry must be
    // consulted before the child walk, so a declared scroll never measures.
    let childMeasures = 0;
    const measured = child.contentSize.bind(child);
    child.contentSize = () => {
      childMeasures++;
      return measured();
    };
    const measuredMax = maxScroll(view);
    if (measuredMax.x !== 1 || measuredMax.y !== 1 || childMeasures !== 1) {
      throw new Error(
        `measured max = ${JSON.stringify(measuredMax)} after ${childMeasures} child call(s)`,
      );
    }
    // A 40x100 virtual list (only the window is materialized): the declared
    // geometry replaces the child walk in both `maxScroll` and `scrollTo`.
    declareVirtualContent(view, { width: 40, height: 100 });
    childMeasures = 0;
    const declaredMax = maxScroll(view);
    if (declaredMax.x !== 35 || declaredMax.y !== 98) {
      throw new Error(`declared max = ${JSON.stringify(declaredMax)}`);
    }
    const applied = scrollTo(view, 0, 50);
    if (applied.x !== 0 || applied.y !== 50) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    const clamped = scrollTo(view, 999, 999);
    if (clamped.x !== 35 || clamped.y !== 98) {
      throw new Error(`clamped = ${JSON.stringify(clamped)}`);
    }
    if (childMeasures !== 0) {
      throw new Error(
        `declared geometry must not walk children: ${childMeasures} call(s)`,
      );
    }
    // JS bookkeeping, never scene props; re-declaring replaces the geometry
    // and the viewport still floors it (content that fits cannot scroll).
    if ("virtualContent" in view.props) {
      throw new Error(`declared geometry leaked: ${JSON.stringify(view.props)}`);
    }
    declareVirtualContent(view, { width: 2, height: 1 });
    const floored = maxScroll(view);
    if (floored.x !== 0 || floored.y !== 0) {
      throw new Error(`floored max = ${JSON.stringify(floored)}`);
    }
    // The registry is per view: a second view over its own leaf still
    // measures (nothing was patched globally).
    const other = ScrollView(
      { width: 5, height: 2 },
      Text({ text: "aaaaaa\nbbbbb\ncc" }),
    );
    renderer.root.addChild(other);
    const otherMax = maxScroll(other);
    if (otherMax.x !== 1 || otherMax.y !== 1) {
      throw new Error(`other max = ${JSON.stringify(otherMax)}`);
    }
  });
});
