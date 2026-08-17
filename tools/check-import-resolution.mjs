// Regression guard for the `.js`-suffixed react-reconciler import.
//
// packages/react/src/reconciler.ts imports `react-reconciler/constants.js`
// WITH the `.js` suffix. react-reconciler@0.33.x publishes no `exports` map
// (plain `main: index.js` plus a physical `constants.js` at the package root),
// so under Node ESM the extension-less spelling `react-reconciler/constants`
// fails with ERR_MODULE_NOT_FOUND — Node does not append extensions to bare
// specifier subpaths. The `.js` suffix is therefore required and must not be
// "fixed" (a previous attempt to drop it broke the build).
//
// This script imports the BUILT `packages/react/dist/reconciler.js` against
// the unpatched installed react-reconciler and exits non-zero with a clear
// message if the specifier ever stops resolving (suffix dropped, exports map
// added, or version drift). Runs under plain `node`; no tooling required.
//
// Usage: node tools/check-import-resolution.mjs   (from the repo root)
// Exit:  0 when the built reconciler imports cleanly; 1 otherwise.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The check runs against the workspace's installed react-reconciler — no patch
// mechanism is in use, so `node_modules` IS the published tarball. Verify the
// package state that motivates the `.js` suffix before trusting the import.
let rrPkg;
try {
  rrPkg = JSON.parse(
    readFileSync(require.resolve("react-reconciler/package.json"), "utf8"),
  );
} catch (err) {
  console.error(`check-import-resolution: cannot resolve react-reconciler/package.json: ${err.message}`);
  process.exit(1);
}
if (!rrPkg.version.startsWith("0.33.")) {
  console.error(
    `check-import-resolution: expected react-reconciler@0.33.x, found ${rrPkg.version} — ` +
      "re-evaluate whether the `.js` suffix is still required before trusting this check",
  );
  process.exit(1);
}
if ("exports" in rrPkg) {
  console.error(
    "check-import-resolution: installed react-reconciler now ships an `exports` map — " +
      "the `.js` suffix rationale (no exports map) no longer holds; re-verify resolution",
  );
  process.exit(1);
}

const distPath = join(repoRoot, "packages/react/dist/reconciler.js");
let mod;
try {
  mod = await import(pathToFileURL(distPath).href);
} catch (err) {
  console.error(`check-import-resolution: FAILED to import ${distPath}`);
  console.error("  The `react-reconciler/constants.js` specifier no longer resolves under Node ESM.");
  console.error("  The `.js` suffix in packages/react/src/reconciler.ts is REQUIRED");
  console.error("  (react-reconciler@0.33.x has no exports map); do not remove it.");
  console.error(`  Root cause: ${err.code ?? "error"} ${err.message}`);
  process.exit(1);
}

// Sanity-check that the module actually loaded the reconciler surface (an
// empty/silently-mocked import is not a pass).
const expected = ["hostConfig", "createRoot", "render", "useApp", "useInput"];
const missing = expected.filter((name) => !(name in mod));
if (missing.length > 0) {
  console.error(
    `check-import-resolution: dist/reconciler.js loaded but is missing exports: ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `check-import-resolution: PASS — dist/reconciler.js imports cleanly against react-reconciler@${rrPkg.version}`,
);
