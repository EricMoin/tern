# AGENTS.md

Working agreement for coding agents in this repository. The rules here are
narrower than `CONTRIBUTING.md` (which defines what "correct" means for a
change); this file defines **what to run, and how much of it**.

---

## 1. The rule

**Run the tests that cover what you changed. Do not run the full suite by
default.** Scope every check to the crate, package, or file you touched, and
widen only when the change is genuinely cross-cutting.

Measured on this checkout (warm build cache, Apple silicon):

| Run | Time |
|-----|------|
| `node tools/check-file-size.mjs` | **0.06s** |
| `cargo test -p tern-core`, warm | 0.24s |
| `cargo test -p tern-core`, after editing the crate | 1.9s |
| `cargo test -p tern-layout` / `-p tern-terminal` / `-p tern-components`, warm | 0.3–1.0s |
| `cargo test -p tern-highlight`, warm | 3.0s (tree-sitter grammars link) |
| `cd packages/core && deno task test` (385 tests) | **3.2s** |
| `cd packages/react && deno task test` (84 tests) | **1.5s** |
| `cargo test --workspace` — nothing changed | 7.7s |
| `cargo test --workspace` — **after editing `tern-core`** | **24.7s** |

The last row is the reason for this rule. `tern-core` is the base of every
other crate, so one edit there forces Cargo to rebuild and re-test the entire
workspace: **13× the cost of `cargo test -p tern-core`**, for the same
evidence about the file you actually changed.

Warm-cache numbers only. On a cold target directory every figure above grows
by the full compile, which is exactly when the difference matters most.

---

## 2. Scope map

### Rust — pick the crate, then the dependents

| When you edit | Minimum | Also run if the change is not local |
|---|---|---|
| `src/core/tern-core/**` | `cargo test -p tern-core` | everything depends on it — see the fan-out below |
| `src/core/tern-layout/**` | `cargo test -p tern-layout` | `tern-components`, `tern-wasm`, `tern-node` |
| `src/core/tern-terminal/**` | `cargo test -p tern-terminal` | `tern-components`, `tern-node` |
| `src/core/tern-highlight/**` | `cargo test -p tern-highlight` | `tern-node` |
| `src/core/tern-components/**` | `cargo test -p tern-components` | `tern-wasm`, `tern-node` |
| `src/core/tern-wasm/**` | `cargo test -p tern-wasm` | — |
| `src/bindings/tern-node/**` | `cargo test -p tern-node` | — |
| `examples/rust/**` | `cargo build -p tern-demo` | — |

```
tern-core  ← tern-layout, tern-terminal, tern-highlight,
             tern-components, tern-wasm, tern-node
tern-layout, tern-terminal, tern-highlight  ← tern-components
tern-components  ← tern-wasm, tern-node
```

Narrow further when you know the module:

```sh
env -u NO_COLOR cargo test -p tern-core buffer::          # by module path
env -u NO_COLOR cargo test -p tern-node --lib             # unit tests only
env -u NO_COLOR cargo test -p tern-components --test dirty_parity_fuzz
env -u NO_COLOR cargo check -p tern-layout                # compile only
```

`tern-components` also has three integration targets —
`dirty_parity_fuzz`, `incremental_consistency`, and the
`#[ignore]`d `bench_timing` (CI-only; needs a release build). Run the
first two when you touch the compositor or the dirty-region paths.

### TypeScript — pick the package, then the file

```sh
cd packages/<core|react|solid|examples> && deno task check   # types, ~0.3-0.8s
cd packages/<core|react|solid|examples> && deno task test    # that package only
```

One file, or one topic, is usually enough:

```sh
deno test --allow-env=NODE_ENV packages/core/src/textarea_test.ts
deno test --allow-env=NODE_ENV packages/core/src --filter "textarea"
```

Source → test file in `packages/core`, where the pairing is not obvious:

| Source | Test file(s) |
|---|---|
| `node.ts`, `types.ts` | `node_test.ts` (everything) |
| `renderer.ts` | `renderer_test.ts`, `snapshot_test.ts`, `stream_test.ts` |
| `selection.ts`, `mouse.ts` | `selection_test.ts` |
| `focus.ts`, `keymap.ts` | `focus_test.ts`, `keymap_test.ts` |
| `textarea.ts`, `input.ts`, `textutil.ts` | `textarea_test.ts`, `grapheme_test.ts`, `edit_fuzz_test.ts` |
| `markdown.ts`, `highlight.ts` | `markdown_test.ts`, `markdown_fence_test.ts` |
| `theme.ts`, `contrast.ts` | `theme_test.ts`, `contrast_test.ts` |
| `semantics.ts`, `a11y.ts` | `semantics_test.ts`, `a11y_test.ts` |

Everywhere else the pair is literal: `table.ts` → `table_test.ts`,
`menu.ts` → `menu_test.ts`, and so on. When in doubt, run the package's
suite — it is 1–3s.

---

## 3. Always run, no matter how small the change

```sh
node tools/check-file-size.mjs      # 0.06s
```

It is the cheapest gate in the repo and the one most likely to catch an agent
growing a file past the 800-line cap. There is no excuse for skipping it.

---

## 4. When the full suite *is* required

Escalate to `bash tools/verify.sh` (or the CI-equivalent commands) only when:

- the change is **cross-crate or cross-package** — a shared type, the napi
  surface, the scene/cell ABI, or anything under `src/core/tern-core`;
- you are about to **hand the work over as finished**, and the change touched
  more than one crate or package;
- a **public API** changed (then also re-read `docs/api-stability.md`);
- you touched **rendering output** — the golden-buffer and PTY smoke gates are
  the only way to see a regression there (`bash packages/examples/run-smoke.sh`,
  which needs macOS `script` and a built `tern-node` addon).

State the escalation reason in one line when you do it.

---

## 5. Repository gotchas (they cost agents real time)

- **Always prefix Rust runs with `env -u NO_COLOR`.** `NO_COLOR=1` is set in
  some shells here, and crossterm 0.29 honours it, which makes five
  `tern-terminal` colour tests fail for reasons that have nothing to do with
  the code. CI does not set it.
- **Do not run `cargo fmt --all`.** The tree is not rustfmt-clean under the
  pinned 1.94.0 toolchain, so a workspace-wide format rewrites ~30 files you
  never touched. Format the file you edited, or not at all.
- **Generated files are out of scope** for edits and for the size cap:
  `src/bindings/tern-node/index.d.ts`, `index.js`, and anything gitignored
  (`packages/*/dist/`, `target/`, `node_modules/`).
- **The napi addon is built, not tested, by `cargo test`.** Anything that needs
  the real `.node` binary goes through
  `cd src/bindings/tern-node && npm run build` (see `CONTRIBUTING.md`).
- **`tools/check-file-size.mjs` has a `DEFERRED` map** listing files still over
  the cap. It may only shrink. Adding your file to it is not a fix.

---

## 6. Reporting

When you report back, say exactly what ran:

- the commands you executed, and whether they passed;
- **what you deliberately did not run, and why** — "type-checked
  `packages/react` only; did not run the workspace suite because the change is
  confined to that package" is a good answer. "Verified" with no scope is not.

Never claim a check passed that you did not run, and never present a targeted
run as proof about code it does not cover.
