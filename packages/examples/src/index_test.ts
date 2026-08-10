import { name, version } from "./index.ts";

Deno.test("examples exports package metadata", () => {
  if (name !== "@tern-tui/examples") {
    throw new Error(`unexpected name: ${name}`);
  }
  if (version !== "0.2.0") {
    throw new Error(`unexpected version: ${version}`);
  }
});
