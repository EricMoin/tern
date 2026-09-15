//! The landing registry: which renderer layers exist, and the buffers they recorded.
//!
//! WHY THIS FILE IS A DECLARATION AND NOT A PROBE. The obvious way to find a layer is
//! to import `packages/showcase/src/layers/<layer>/index.ts` and read "Module not
//! found" as "not landed". That is IMPOSSIBLE in the canonical run:
//!
//!   $ deno test --allow-env=NODE_ENV packages/showcase/src/parity/
//!   error: (in promise) TypeError: Requires read access to
//!     ".../packages/showcase/src/layers/core/index.ts", run again with the --allow-read flag
//!       module = await import(where);
//!       at async loadLayer (harness.ts:111:14)          [measured, Deno 2.9.6]
//!
//! Deno gates dynamic module resolution behind --allow-read — the same class of gap
//! contract.ts:29-37 reports for obtaining a module's source text. A STATIC import is
//! resolved with the module graph and needs no permission, so the harness cannot
//! DISCOVER a layer: the layer DECLARES itself here, and the declaration is what the
//! parity gate reads.
//!
//! What the gate can still enforce, it does. The buffer record is TOTAL
//! (`Record<ScreenId, RecordedBuffer>`: harness.ts`LandedLayer`), so a landed layer
//! that recorded only some screens cannot be written here — "a missing golden for an
//! existing layer" is a compile error and a parity failure at once, never a skip.
//! golden_test.ts reports the landed set out loud, so an empty registry reads as
//! "0 of 3 layers landed", not as a pass.
//!
//! The limit, stated rather than hidden: a layer that landed and was never added here
//! is invisible to the parity gate. One entry is the whole cost of landing, and the
//! subtask that builds the layer is the one that knows it exists.
//!
//! HOW A LAYER LANDS (t12/t13/t14), in full:
//!
//!   1. Build `packages/showcase/src/layers/<layer>/index.ts` exporting
//!      `LAYER: RendererLayer` (defineLayer, harness.ts).
//!   2. Record one buffer per screen: for each fixture in goldens/index.ts run
//!      `runLayer(LAYER, FIXTURE)`, print `formatRecordedBuffer` (record.ts) and paste
//!      the output into goldens/buffers/<screen>.<layer>.ts.
//!   3. Add ONE entry below — the layer and its twelve buffers, imported statically:
//!
//!        import { LAYER as core } from "../../layers/core/index.ts";
//!        import { BUFFER as editorCore } from "./buffers/editor.core.ts";
//!        … one import per screen …
//!        {
//!          layer: "core",
//!          renderer: core,
//!          buffers: {
//!            editor: editorCore, sidebar: sidebarCore, chooser: chooserCore,
//!            find: findCore, replace: replaceCore, help: helpCore,
//!            preview: previewCore, profile: profileCore, minimap: minimapCore,
//!            a11y: a11yCore, parity: parityCore, shell: shellCore,
//!          },
//!        }
//!
//! That is the only hand edit the parity gate needs, and the compiler checks its
//! shape: twelve screens, no more and no fewer.

import { LAYER as core } from "../../layers/core/index.ts";
import { LAYER as react } from "../../layers/react/index.ts";
import { LAYER as solid } from "../../layers/solid/index.ts";
import type { LandedLayer } from "../harness.ts";
import { BUFFER as a11yCore } from "./buffers/a11y.core.ts";
import { BUFFER as chooserCore } from "./buffers/chooser.core.ts";
import { BUFFER as editorCore } from "./buffers/editor.core.ts";
import { BUFFER as findCore } from "./buffers/find.core.ts";
import { BUFFER as helpCore } from "./buffers/help.core.ts";
import { BUFFER as minimapCore } from "./buffers/minimap.core.ts";
import { BUFFER as parityCore } from "./buffers/parity.core.ts";
import { BUFFER as previewCore } from "./buffers/preview.core.ts";
import { BUFFER as profileCore } from "./buffers/profile.core.ts";
import { BUFFER as replaceCore } from "./buffers/replace.core.ts";
import { BUFFER as shellCore } from "./buffers/shell.core.ts";
import { BUFFER as sidebarCore } from "./buffers/sidebar.core.ts";
import { BUFFER as a11yReact } from "./buffers/a11y.react.ts";
import { BUFFER as chooserReact } from "./buffers/chooser.react.ts";
import { BUFFER as editorReact } from "./buffers/editor.react.ts";
import { BUFFER as findReact } from "./buffers/find.react.ts";
import { BUFFER as helpReact } from "./buffers/help.react.ts";
import { BUFFER as minimapReact } from "./buffers/minimap.react.ts";
import { BUFFER as parityReact } from "./buffers/parity.react.ts";
import { BUFFER as previewReact } from "./buffers/preview.react.ts";
import { BUFFER as profileReact } from "./buffers/profile.react.ts";
import { BUFFER as replaceReact } from "./buffers/replace.react.ts";
import { BUFFER as shellReact } from "./buffers/shell.react.ts";
import { BUFFER as sidebarReact } from "./buffers/sidebar.react.ts";
import { BUFFER as paletteCore } from "./buffers/palette.core.ts";
import { BUFFER as preferencesCore } from "./buffers/preferences.core.ts";
import { BUFFER as themeCore } from "./buffers/theme.core.ts";
import { BUFFER as diffCore } from "./buffers/diff.core.ts";
import { BUFFER as paletteReact } from "./buffers/palette.react.ts";
import { BUFFER as preferencesReact } from "./buffers/preferences.react.ts";
import { BUFFER as themeReact } from "./buffers/theme.react.ts";
import { BUFFER as diffReact } from "./buffers/diff.react.ts";
import { BUFFER as paletteSolid } from "./buffers/palette.solid.ts";
import { BUFFER as preferencesSolid } from "./buffers/preferences.solid.ts";
import { BUFFER as themeSolid } from "./buffers/theme.solid.ts";
import { BUFFER as diffSolid } from "./buffers/diff.solid.ts";
import { BUFFER as a11ySolid } from "./buffers/a11y.solid.ts";
import { BUFFER as chooserSolid } from "./buffers/chooser.solid.ts";
import { BUFFER as editorSolid } from "./buffers/editor.solid.ts";
import { BUFFER as findSolid } from "./buffers/find.solid.ts";
import { BUFFER as helpSolid } from "./buffers/help.solid.ts";
import { BUFFER as minimapSolid } from "./buffers/minimap.solid.ts";
import { BUFFER as paritySolid } from "./buffers/parity.solid.ts";
import { BUFFER as previewSolid } from "./buffers/preview.solid.ts";
import { BUFFER as profileSolid } from "./buffers/profile.solid.ts";
import { BUFFER as replaceSolid } from "./buffers/replace.solid.ts";
import { BUFFER as shellSolid } from "./buffers/shell.solid.ts";
import { BUFFER as sidebarSolid } from "./buffers/sidebar.solid.ts";

/**
 * Every layer that has landed, in layer order.
 *
 * t12a — the CORE layer (`packages/showcase/src/layers/core/`) recorded all twelve
 * screens. t13 — the REACT layer (`packages/showcase/src/layers/react/`) recorded
 * the same twelve; its rows come off the committed React scene (layers/react/
 * frame.ts) and land byte-identical to the core layer's, which is what the plan's
 * single decision point buys. t14 — the SOLID layer
 * (`packages/showcase/src/layers/solid/`) recorded the same twelve off the committed
 * Solid scene (layers/solid/frame.ts), byte-identical again: all three layers now
 * declare `defineLayer` (harness.ts:84) and supply only an emitter.
 */
export const LANDED: readonly LandedLayer[] = [
  {
    layer: "core",
    renderer: core,
    buffers: {
      editor: editorCore,
      sidebar: sidebarCore,
      chooser: chooserCore,
      find: findCore,
      replace: replaceCore,
      help: helpCore,
      preview: previewCore,
      profile: profileCore,
      minimap: minimapCore,
      a11y: a11yCore,
      parity: parityCore,
      shell: shellCore,
      palette: paletteCore,
      preferences: preferencesCore,
      theme: themeCore,
      diff: diffCore,
    },
  },
  {
    layer: "react",
    renderer: react,
    buffers: {
      editor: editorReact,
      sidebar: sidebarReact,
      chooser: chooserReact,
      find: findReact,
      replace: replaceReact,
      help: helpReact,
      preview: previewReact,
      profile: profileReact,
      minimap: minimapReact,
      a11y: a11yReact,
      parity: parityReact,
      shell: shellReact,
      palette: paletteReact,
      preferences: preferencesReact,
      theme: themeReact,
      diff: diffReact,
    },
  },
  {
    layer: "solid",
    renderer: solid,
    buffers: {
      editor: editorSolid,
      sidebar: sidebarSolid,
      chooser: chooserSolid,
      find: findSolid,
      replace: replaceSolid,
      help: helpSolid,
      preview: previewSolid,
      profile: profileSolid,
      minimap: minimapSolid,
      a11y: a11ySolid,
      parity: paritySolid,
      shell: shellSolid,
      palette: paletteSolid,
      preferences: preferencesSolid,
      theme: themeSolid,
      diff: diffSolid,
    },
  },
];
