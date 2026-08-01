/**
 * @tern/examples — runnable tern demos.
 *
 * The runnable entry files live at the package root:
 *
 * - `react-demo.ts` — Box column + two Text leaves ("Hello React" /
 *   "Press q to quit") via @tern/react, event loop quits on 'q'.
 * - `solid-demo.ts` — the same scene via the @tern/solid renderer, quits on
 *   'q'.
 * - `run-smoke.sh` — runs both demos under a macOS `script` PTY with 'q'
 *   piped in and asserts exit 0 (Deno-first runtime, node fallback).
 *
 * This file is the package entry stub (name/version metadata) consumed by
 * the workspace check/test tasks; the demos are standalone scripts.
 */
export const name = "@tern/examples";
export const version = "0.1.0";
