# Contributing to tern

tern is a Rust-native TUI engine with `@tern/react` and `@tern/solid` custom
renderers over a napi bridge. The rules below are the project's constitution;
deviations require user approval.

## Engineering rules

- **Core is always Rust.** Rendering, layout, events, and the terminal stay in
  Rust. Engine logic must never be pushed into the JS layer; the JS side only
  describes the scene (element compositions, focus/bookkeeping math) and
  reads events.
- **Unidirectional data flow.** JS renderer → `@tern/core` → tern-node (napi)
  → tern-core scene tree → tern-layout (taffy) → compositor → tern-terminal
  (crossterm) → terminal; events return via `poll_events`. No cross-layer
  shortcuts (e.g. JS touching the buffer directly).
- **Layer ownership.** `tern-core` has no terminal I/O and no heavy external
  deps; `tern-terminal` is the only crate touching the terminal; `tern-layout`
  is the only crate depending on taffy. New code goes in the correct layer
  (Fuchsia-style directories: `src/core/*`, `src/bindings/`,
  `packages/{core,react,solid,examples}`, `docs/`, `examples/`, `tools/`,
  `tests/`, `third_party/`).
- **Deno-first.** `deno check` / `deno test` are the canonical checkers;
  demos and smokes run under `deno run` first. Node.js appears only in the
  napi build phase (`@napi-rs/cli` + `fix-dts.mjs`) and as an explicit,
  self-reporting fallback runtime.
- **Clean-room.** opentui is GPL-3 — never copy or rework its source; only
  public architecture ideas may inform design. Dependencies must be
  permissively licensed (MIT/Apache).
- **Roadmap discipline.** New features must be checked against
  [docs/roadmap.md](docs/roadmap.md) and [docs/components.md](docs/components.md)
  before starting; do not open new directions at will.

## Quality gates (minimum acceptance for any change)

1. **Rust.** `cargo build --workspace` and `cargo test --workspace` must be
   green. Multi-width character handling (e.g. `コ`) must have test coverage.
2. **JS.** `deno check` and `deno test` must be green across the workspace
   (`npm run check` / `npm test` from the repo root, or the per-package
   `deno check` / `deno test` tasks).
3. **Interactive acceptance.** A TUI cannot be verified headless. Use the
   macOS `script` PTY harness — `bash packages/examples/run-smoke.sh` — which
   pipes `q` into each demo and asserts exit 0 (the standard entry point).
   Only a demo that rendered its scene, held its scene assertions, and quit
   on `q` exits 0.
4. **Golden buffers.** Golden buffer tests are the fact standard for
   rendering correctness. Any change to rendering must update or add the
   corresponding golden.

## Building the native addon

The napi build must run through the package's full script chain (a bare
`napi build` leaks `r#type` into `index.d.ts`, which is invalid TS and fails
Deno resolution):

```sh
cd src/bindings/tern-node
npm install
npm run build        # napi build --platform && node fix-dts.mjs
```

## Checking a change

```sh
cargo build --workspace && cargo test --workspace   # Rust gates
npm run check                                       # deno check, all packages
npm test                                            # deno test, all packages
bash packages/examples/run-smoke.sh                 # PTY smoke: 4 demos, 'q', exit 0
```

CI (`.github/workflows/ci.yml`) runs the Rust build/test job and the JS
check/test job on every push and pull request.
