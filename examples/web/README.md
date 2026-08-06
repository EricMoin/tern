# tern — wasm preview demo (Phase 6 spike)

A minimal static page that renders a tern scene in the browser: the core
crates (`tern-core`, `tern-layout`, `tern-components` — all pure Rust and
wasm-safe) are compiled to `wasm32-unknown-unknown` as a cdylib
(`src/core/tern-wasm`), exposing a plain C ABI. A small JS shim
([`shim.js`](shim.js)) drives the scene through the **same JSON-prop
protocol** as the napi binding (`create_node` / `add_child` / `set_prop` /
`append_span`, with the same style keys: `fg`, `bg`, `border_style`, `bold`,
`dim`, `italic`, `underline`, `reversed`, …), and
[`painter.js`](painter.js) paints the returned flat per-cell stream
(`render_to_cells`: symbol/ch, fg/bg colors, modifier flags) onto a canvas —
the structured cell stream `snapshotFrame`'s row strings do not carry.

## Build

```sh
# one-time: the wasm32 target
rustup target add wasm32-unknown-unknown

# build the wasm artifact and copy it next to the page
./build.sh
```

This produces `tern_wasm.wasm` (committed) from
`cargo build --target wasm32-unknown-unknown -p tern-wasm --release`.

## Serve

The page must be served over http (wasm is fetched via
`instantiateStreaming`; `file://` is blocked by browsers):

```sh
cd examples/web
python3 -m http.server 8000
# then open http://localhost:8000
```

You should see the tern demo scene — rounded border box, bold title, dim
subtitle, an animated stream of styled spans (colors, bold/italic/underline,
dim), a row of bg-colored boxes, and a wide CJK char + ZWJ emoji (the
masked-continuation cells are skipped by the painter) — re-laid out on
window resize.

## What is deliberately deferred (see `docs/roadmap.md`, Phase 6)

- Full `@tern/core` reconciler parity on wasm (this spike exposes the scene
  API directly; the React/Solid reconcilers and the event stream are not
  ported).
- tern-highlight in wasm (tree-sitter grammars are not part of this build).

## Files

- `tern_wasm.wasm` — the release cdylib artifact (built by `./build.sh`)
- `shim.js` — wasm loader + the JSON-prop protocol shim
- `painter.js` — the canvas painter for the per-cell stream
- `demo.js` — the demo scene + typing animation
- `index.html` — the page
