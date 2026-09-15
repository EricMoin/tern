//! Layer A — the core (imperative) renderer layer, and the module every other
//! module of this layer is reachable from.
//!
//! WHAT A LAYER IS. It is two things and nothing else (src/index.ts:21-28):
//!
//!   * `frame.ts` — a PURE ScreenPlan emitter: the plan in, this layer's screen
//!     out, with no layout and no key meaning of its own. `mount.ts` is the scene
//!     the same plan mounts into for a real terminal.
//!   * `input.ts` — an event source feeding the SAME `HeadlessApp` dispatcher the
//!     fixtures use, so a user's keystroke and a fixture's keystroke are one code
//!     path.
//!
//! `mount.ts` is where the emitter's scene is built, `io.ts` is the host side of
//! the app's effects, and `main.ts` is the runnable entry point:
//!
//!   deno run --allow-all packages/showcase/src/layers/core/main.ts [path]
//!
//! THIS MODULE IS THE LANDING DECLARATION. `parity/goldens/landed.ts` imports
//! `LAYER` from here — a static import, because a dynamic one needs `--allow-read`
//! and the canonical test run grants only `--allow-env` (landed.ts:1-28). The
//! record is TOTAL: a screen this layer cannot paint is a compile error there, not
//! a skip.

import { defineLayer, type RendererLayer } from "../../parity/harness.ts";
import { emit } from "./frame.ts";

/** Layer A, as the parity harness sees it: the shared app-core drive, this
 * layer's emitter. */
export const LAYER: RendererLayer = defineLayer("core", emit);

export { composeRows, emit, LAYER_ID } from "./frame.ts";
export { editorScene, modeScene, mountPlan, sidebarScene } from "./mount.ts";
export { attachInput, type FrameSink } from "./input.ts";
export { applyEffect, denoHost, type HostIO } from "./io.ts";
export { ROLE_OF_HINT } from "./mount.ts";
