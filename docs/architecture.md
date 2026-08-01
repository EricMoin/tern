# tern Architecture

tern is a terminal UI (TUI) renderer with a Fuchsia-style monorepo layout.
A JavaScript reconciler drives a Rust rendering pipeline; the terminal is the
output device.

## Data Flow

```
 JS reconciler
      │  1. app code mutates the reconciler's virtual tree
      ▼
 packages/core (JS)
      │  2. reconciler produces a concrete scene update
      ▼
 tern-node (napi binding)
      │  3. scene update crosses the JS/Rust boundary into tern-core
      ▼
 tern-core (scene tree)
      │  4. scene tree materializes nodes & properties
      ▼
 tern-layout
      │  5. layout engine computes sizes & positions
      ▼
 Compositor
      │  6. paints laid-out nodes into a cell Buffer
      ▼
 tern-terminal
      │  7. diffs old buffer vs new buffer
      ▼
 terminal
      │  8. flushes the minimal escape-sequence diff

 Events: input & lifecycle events return to the host via poll_events
 (tern-node -> packages/core -> JS reconciler).
```

Steps 1-8 form a single render pass. `poll_events` is the reverse channel:
terminal input (keys, mouse, resize) is read by tern-terminal and returned
through the same layers back to the JS reconciler.

## Pipeline responsibilities

| Stage | Crate / component | Responsibility |
|-------|-------------------|----------------|
| Reconciler | `packages/core` (JS) | Virtual tree diffing; produces scene updates |
| Binding | `src/bindings/tern-node` | napi bridge; serializes updates into tern-core |
| Scene tree | `src/core/tern-core` | Owns scene graph nodes and properties |
| Layout | `src/core/tern-layout` | Size/position computation over the scene tree |
| Compositor | `src/core/tern-core` (compositor module) | Paints laid-out nodes into a cell `Buffer` |
| Terminal | `src/core/tern-terminal` | Buffer diffing + escape-sequence flush |
| Events | tern-terminal -> tern-node | `poll_events` returns input to the host |

## Directory tree convention

The repository follows a Fuchsia-style layout: one top-level tree per concern,
with the Rust workspace rooted at `Cargo.toml`.

```
tern/
├── src/           # Rust sources (workspace members)
│   ├── core/      #   platform-independent core crates
│   └── bindings/  #   language bindings (tern-node napi)
├── docs/          # architecture & design documents
├── examples/      # runnable examples
│   └── rust/      #   Rust example binaries
├── packages/      # JS packages (packages/core: the reconciler)
├── tools/         # developer tooling & build scripts
├── tests/         # integration & cross-language tests
└── third_party/   # vendored third-party sources
```

### Rules

- **`src/`** holds the Rust workspace; core crates live under `src/core/`,
  bindings under `src/bindings/`.
- **`packages/`** holds JS packages; the reconciler is `packages/core`.
- **`examples/`** holds runnable examples, namespaced by language
  (`examples/rust/`, later `examples/js/`).
- **`tests/`** is for cross-language / end-to-end tests that do not belong to
  a single crate.
- **`tools/`** holds developer tooling that is not shipped.
- **`third_party/`** holds vendored dependencies that cannot be fetched by the
  package managers.
- **`docs/`** holds all architecture and design documents; code comments
  reference it rather than duplicating it.
