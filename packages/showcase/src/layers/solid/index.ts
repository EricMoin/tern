//! Layer C — the Solid renderer layer, and the module every other module of this
//! layer is reachable from.
//!
//! WHAT A LAYER IS. It is two things and nothing else (src/index.ts:21-28):
//!
//!   * `frame.ts` — a PURE ScreenPlan emitter: the plan in, this layer's screen out,
//!     with no layout and no key meaning of its own. Here the "screen out" is a real
//!     Solid mount: the tree `App.planRoot` builds is mounted through
//!     `@tern-tui/solid`'s own `render` and painted back off the committed scene.
//!   * `primitives.ts` — an event source feeding the SAME `HeadlessApp` dispatcher the
//!     fixtures use, through the framework's own `subscribeInput` / `subscribePaste` /
//!     `subscribeResize` wiring (Solid has no context, so the renderer is an explicit
//!     argument), so a user's keystroke and a fixture's keystroke are one code path.
//!
//! `App.ts` is where the element tree is built, `frame.ts` is the emitter and the
//! paint model, and `main.ts` is the runnable entry point:
//!
//!   deno run --allow-all packages/showcase/src/layers/solid/main.ts [path]
//!
//! THIS MODULE IS THE LANDING DECLARATION. `parity/goldens/landed.ts` imports
//! `LAYER` from here — a static import, because a dynamic one needs `--allow-read`
//! and the canonical test run grants only `--allow-env` (landed.ts:1-28). The record
//! is TOTAL: a screen this layer cannot paint is a compile error there, not a skip.
//!
//! THE DRIVE IS THE SHARED CORE'S. `defineLayer` (harness.ts:84) hands the layer the
//! reference plan the ONE app-core produced for the fixture; the layer supplies only
//! its emitter. That is the expected shape of all three layers, and it is what makes
//! ScreenPlan identity between layers A, B and C a property of the harness rather
//! than a hope. `app_test.ts` additionally drives a fresh app-core through THIS
//! layer's primitives and compares the answer, so the identity is executed, not
//! assumed.

import { defineLayer, type RendererLayer } from "../../parity/harness.ts";
import { emit } from "./frame.ts";

/** Layer C, as the parity harness sees it: the shared app-core drive, this layer's
 * emitter. */
export const LAYER: RendererLayer = defineLayer("solid", emit);

export { App, modeElement, paneElement, planChildren, planRoot, ROLE_OF_HINT, rowElement, viewProps, type AppProps } from "./App.ts";
export { emit, LAYER_ID, paintMounted, paintPlan, withScene } from "./frame.ts";
export {
  attachLayerInput,
  createPlanStore,
  mountPlanScene,
  type FrameSink,
  type PlanStore,
} from "./primitives.ts";
