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
npm run build        # release default: napi build --platform --release && node fix-dts.mjs
```

`npm run build:debug` is the fast local dev build (debug profile); `npm run build:release` is an explicit alias for the now-default release build.

Use `npm install` (not `npm ci`) here: the `tern-node-<platform>` optional
dependencies declared for the release strategy are not yet on the registry,
so the lockfile cannot pin them, and `npm ci`'s sync check would fail.

## Releasing

Releases are gated end-to-end by the workflows in `.github/workflows/`.

### Multi-platform native addon (napi-rs distribution model)

The native addon follows the napi-rs convention: the root package
(`tern-node`) declares per-platform packages in `optionalDependencies`
(`tern-node-linux-x64-gnu`, `tern-node-linux-arm64-gnu`,
`tern-node-darwin-x64`, `tern-node-darwin-arm64`, `tern-node-win32-x64-msvc`),
and the generated `index.js` loader picks the package matching the running
system. The build matrix in `ci.yml` (`napi-build` job) builds one target
per row and uploads the `.node` binary:

| Target (Rust triple)        | Runner          | Build command |
| --------------------------- | --------------- | ------------- |
| `x86_64-unknown-linux-gnu`  | ubuntu-latest   | `npm run build` |
| `aarch64-unknown-linux-gnu` | ubuntu-latest   | `npm run build -- --target aarch64-unknown-linux-gnu --use-napi-cross` |
| `x86_64-apple-darwin`       | macos-latest    | `npm run build -- --target x86_64-apple-darwin` |
| `aarch64-apple-darwin`      | macos-latest    | `npm run build` |
| `x86_64-pc-windows-msvc`    | windows-latest  | `npm run build` |

Cross-compiled rows (binary arch ≠ runner arch) skip the native load-check;
the three native rows run `node load-check.mjs` against the freshly built
addon. The target list lives in `napi.targets` in
`src/bindings/tern-node/package.json` — keep the matrix and that list in
sync.

Publishing the platform packages themselves is a separate step once they
exist on the registry: `napi create-npm-dirs` → `napi artifacts` →
`npm publish` (whose `prepublishOnly` runs `napi prepublish -t npm` to
publish the platform packages first). See
https://napi.rs/docs/deep-dive/release.

### Publish workflow and gates

`.github/workflows/publish.yml` runs on a `v*` tag push (or manual dispatch)
and publishes `@tern/core`, `@tern/react`, `@tern/solid` (all set to
`private: false`; `packages/examples` and the repo root stay private). Three
gates must pass before any publish:

1. **Pack gate** — `npm pack --dry-run` on each of the three packages; the
   release fails if any `*_test.ts` would ship (the `files` arrays ship only
   `src/**/*.ts` excluding tests).
2. **Load-check gate** — build the tern-node addon natively and run
   `node src/bindings/tern-node/load-check.mjs` (asserts the napi surface
   loads).
3. **Platform-wiring gate** — `napi create-npm-dirs` must scaffold all five
   `npm/<platform-suffix>` directories, each a `tern-node-<platform>`
   package (the names declared in `optionalDependencies`).

### Publish command

```sh
npm version patch --workspaces -m "%s"  # bumps @tern/* versions, creates the v-tag
git push --follow-tags                   # triggers publish.yml on the v* tag
```

The workflow needs the `NPM_TOKEN` secret (an npm automation token with
publish rights on the `@tern/*` names). `id-token: write` is declared for
npm provenance.

## Checking a change

```sh
cargo build --workspace && cargo test --workspace   # Rust gates
npm run check                                       # deno check, all packages
npm test                                            # deno test, all packages
bash packages/examples/run-smoke.sh                 # PTY smoke: 4 demos, 'q', exit 0
```

CI (`.github/workflows/ci.yml`) runs the Rust build/test job and the JS
check/test job on every push and pull request.
