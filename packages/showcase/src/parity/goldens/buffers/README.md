# Recorded buffers — one module per (screen x layer) pair

This directory holds the recorded golden buffers. A buffer here is **one layer's own
screen**, never a cross-layer pixel promise: the three layers are held to ScreenPlan
identity (see `../harness.ts`), while their buffers are per-layer facts, because
React's commit batching, Solid's fine-grained effects and the core emitter's single
pass may reach the same screen by different routes.

## Naming convention

    <screen>.<layer>.ts        exporting  BUFFER: RecordedBuffer

for every screen in `registry-editor.ts`'s `SCREENS` (12) x every layer in `LAYERS`
(3) — 36 modules, one per pair:

    editor.core.ts    editor.react.ts    editor.solid.ts
    sidebar.core.ts   sidebar.react.ts   sidebar.solid.ts
    …                 …                  …   (a11y, chooser, find, help, minimap,
                                             parity, preview, profile, replace,
                                             shell  x  core/react/solid)

The name is built in exactly one place — `goldenModule(screen, layer)` /
`goldenImportPath(screen, layer)` in `../record.ts` — and `golden_test.ts` asserts
the shape for all 36 pairs, so the directory listing and the code cannot drift.

## Why modules, imported STATICALLY

The canonical run is `deno test --allow-env=NODE_ENV packages/showcase/src/parity/`.
It grants **no read permission** — the same restriction `contract.ts:29-37` reports —
so a golden that must be *read* at test time cannot be read at all.

A module found by **dynamic** `import()` does not work either, and this was measured
rather than assumed: under that same permission set Deno gates dynamic module
resolution behind `--allow-read` and the probe dies with

    error: (in promise) TypeError: Requires read access to
      ".../packages/showcase/src/layers/core/index.ts", run again with the --allow-read flag

instead of answering "that module is not there". A **static** import is resolved with
the module graph and needs no permission, so each pair's module is imported by
`../landed.ts` — the one static landing registry — and this directory only *names*
the modules.

## How a layer records its buffers (t12 / t13 / t14)

1. Land your layer at `packages/showcase/src/layers/<layer>/index.ts`, exporting
   `LAYER: RendererLayer` (see `RendererLayer` / `defineLayer` in `../harness.ts`).
2. For each of the 12 fixtures, run it and print the record:

       const run = runLayer(LAYER, FIXTURE);
       console.log(formatRecordedBuffer({
         screen: FIXTURE.screen, layer: LAYER.layer,
         planFingerprint: planFingerprint(run.reference),
         recordedBy: "t12 core layer",
         rows: run.frame.rows,
       }));

3. Paste each output into `<screen>.<layer>.ts` here, and add the layer to the
   `LANDED` registry in `../landed.ts` (that file spells out the entry, which
   imports your layer and all twelve buffers statically).

The recorded `planFingerprint` is what keeps the record honest: if a later subtask
changes the core plan, the recorded buffer stops matching and the pair FAILS as stale
rather than silently re-baselining.

## The rules the gate enforces

* **A missing buffer for a layer that has landed is a FAILURE, not a skip** — the
  buffer record in `../landed.ts` is `Record<ScreenId, RecordedBuffer>`, so it cannot
  even be written with a screen missing, and `landedBuffer` /
  `assertLayerParity` (`../harness.ts`) fail loudly if one is empty anyway.
* **A stale buffer fails**: the recorded `planFingerprint` must still be the fixture
  plan's fingerprint.
* **A diverging buffer fails** with the layer and the screen named: the self-test in
  `../golden_test.ts` injects a deliberate divergence into a stub layer and asserts
  exactly that message, so the failure mode is executed on every run, not described.
