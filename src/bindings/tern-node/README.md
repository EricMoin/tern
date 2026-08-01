# tern-node

The napi binding between Deno/Node.js and tern-core. JS code (the reconciler in
`packages/core`) constructs a scene with `create_node` / `NodeHandle`, and a
`TuiRenderer` owns the terminal lifecycle and paint loop.

## Building

The binding is a Rust `cdylib` compiled by [napi-rs](https://napi.rs) v3
(`napi` + `napi-derive`), built with `@napi-rs/cli`:

```sh
cd src/bindings/tern-node
npm install                # fetches @napi-rs/cli
npx napi build --platform  # runs cargo build + emits index.js, index.d.ts, <platform>.node
```

This produces, in this directory:

- `index.js` — the JS loader that requires the platform addon
- `index.d.ts` — TypeScript declarations for the exported surface
- `tern-node.<platform>-<arch>.node` — the native addon (e.g.
  `tern-node.darwin-arm64.node` on macOS arm64)

## API surface

```ts
class TuiRenderer {
  constructor(options?: { exit_on_ctrl_c?: boolean });
  root(): NodeHandle;
  poll_events(timeout_ms: number): KeyEvent[]; // { name, char?, ctrl, alt, shift }
  render(): void;
  destroy(): void;
  get destroyed(): boolean;
}

function create_node(type: "box" | "text", props?: Record<string, unknown>): NodeHandle;

class NodeHandle {
  add_child(child: NodeHandle): NodeHandle;
  remove(): boolean;
  set_props(props: Record<string, unknown>): void;
}
```

`TuiRenderer` enters raw mode + the alternate screen on construction and
restores the terminal on `destroy()` (or automatically on Ctrl+C when
`exit_on_ctrl_c: true`).

## Smoke test

Deno-first (the primary runtime target): the addon is loaded through
`node:module` `createRequire`, which Deno 2.x supports for Node-API addons
with `--allow-all` (includes `--allow-ffi`). If Deno addon loading fails, the
smoke falls back to `node` and prints the limitation.

```sh
# inside this directory (built addon required):
printf 'q' | script -q /dev/null deno run --allow-all smoke.mjs   # PTY smoke: renders, quits on 'q'
# from the repo root:
printf 'q' | script -q /dev/null deno run --allow-all src/bindings/tern-node/smoke.mjs
```

Exit code 0 means: addon loaded, `typeof TuiRenderer === 'function'`, the
scene rendered, and the piped `'q'` was received as a key event.
