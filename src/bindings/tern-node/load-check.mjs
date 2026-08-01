// Quick load check for the tern-node addon under Deno.
// Asserts the exported surface is present; exits 1 otherwise.
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const tern = require("./index.js");

console.log("typeof TuiRenderer:", typeof tern.TuiRenderer);
console.log("typeof NodeHandle:", typeof tern.NodeHandle);
console.log("typeof create_node:", typeof tern.create_node);

if (typeof tern.TuiRenderer !== "function") {
  console.error("FAIL: typeof TuiRenderer is not 'function'");
  process.exit(1);
}
console.log("LOAD CHECK PASSED: typeof TuiRenderer === 'function'");
