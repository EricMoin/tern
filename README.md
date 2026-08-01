# tern

tern is a Fuchsia-style monorepo for a terminal UI (TUI) renderer: a
Node.js-facing reconciler that drives a Rust scene tree, layout engine,
compositor, and terminal frontend.

## Workspace layout

```
tern/
├── Cargo.toml               # Rust workspace root
├── rust-toolchain.toml      # pinned stable Rust 1.94
├── src/
│   ├── core/                # Rust core crates
│   │   ├── tern-core/       #   scene tree
│   │   ├── tern-layout/     #   layout engine
│   │   ├── tern-terminal/   #   terminal frontend (diff flush)
│   │   └── tern-components/ #   reusable widget components
│   └── bindings/
│       └── tern-node/       #   napi binding (Node.js -> Rust)
├── examples/
│   └── rust/
│       └── tern-demo/       # example binary
├── docs/                    # architecture & design documents
├── packages/                # JS packages (reconciler lives here)
├── tools/                   # developer tooling
├── tests/                   # integration / cross-language tests
└── third_party/             # vendored dependencies
```

See [docs/architecture.md](docs/architecture.md) for the render pipeline and
directory conventions, [docs/components.md](docs/components.md) for the
code-agent component roadmap, and [docs/roadmap.md](docs/roadmap.md) for the
post-MVP phases.

## Building

```sh
cargo build --workspace
cargo metadata --no-deps --format-version 1   # list workspace members
```

Requires stable Rust 1.94 (see `rust-toolchain.toml`).
