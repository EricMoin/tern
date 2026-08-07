// Post-build declaration normalization for the tsc-emitted packages.
//
// tsc's `rewriteRelativeImportExtensions` rewrites `.ts` -> `.js` in emitted
// JavaScript but NOT in emitted declaration files, so the published
// `dist/*.d.ts` keep literal `.ts` relative specifiers (`./addon.ts`,
// `./reconciler.ts`, `./universal.ts`). Those specifiers resolve to files
// that do not exist in the packed tarball (`files: ["dist"]`), so consumers
// running tsc with skipLibCheck:false hit TS2307.
//
// This script rewrites relative `*.ts` specifiers to `*.js` in every
// `*.d.ts` under the given directory. Bare specifiers (`"tern-node"`,
// `"@tern-tui/core"`) and doc-comment backtick text are untouched — only quoted
// strings beginning with `./` or `../` and ending in `.ts` are rewritten.
//
// Idempotent: runs after every `tsc -p tsconfig.build.json`; rewriting an
// already-clean `.js` specifier is a no-op.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node fix-dts.mjs <dist-dir>");
  process.exit(1);
}

// A quoted relative specifier ending in `.ts`: `from "./addon.ts"`,
// `import { ... } from "../x.ts"`. The lazy `[^"']*?` stops at the closing
// quote, so `.ts` must immediately precede it; doc-comment backtick text
// (`see `./addon.ts``) and bare specifiers (`"tern-node"`) never match.
const REWRITE = /(["'])(\.\.?\/[^"']*?)\.ts\1/g;

function walk(current) {
  for (const entry of readdirSync(current)) {
    const path = join(current, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (path.endsWith(".d.ts")) {
      const dts = readFileSync(path, "utf8");
      const fixed = dts.replace(REWRITE, "$1$2.js$1");
      if (fixed !== dts) {
        writeFileSync(path, fixed);
        console.log(`fix-dts: ${path}`);
      }
    }
  }
}

walk(dir);
console.log("fix-dts: done");
