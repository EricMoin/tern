// Post-build normalization for the generated index.d.ts.
//
// napi-derive renders the Rust raw identifier `r#type` verbatim into the
// generated TypeScript parameter list (`create_node(r#type: string, ...)`),
// which is invalid TS and breaks consumers running tsc. JS calls are
// positional, so the runtime binding is unaffected — this only repairs the
// declared parameter name to the spec'd `type`.
//
// Idempotent: runs after every `napi build`; replacing an already-clean
// `type` is a no-op.

import { readFileSync, writeFileSync } from "node:fs";
// fileURLToPath is required for Windows: URL.pathname keeps a leading slash
// before the drive letter, producing D:\D:\... when resolved.
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./index.d.ts", import.meta.url));
const dts = readFileSync(target, "utf8");
const fixed = dts.replaceAll("create_node(r#type:", "create_node(type:");

if (fixed === dts) {
  console.log("fix-dts: index.d.ts already clean");
} else {
  writeFileSync(target, fixed);
  console.log("fix-dts: rewrote r#type -> type in index.d.ts");
}
