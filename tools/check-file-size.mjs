// Regression guard for the single-file line cap (CONTRIBUTING.md §3 文件行数).
//
// Roots of the rule: a source file that grows past a few hundred lines stops
// being reviewable as a unit — the diff surface, the ownership boundary and
// the public surface all blur into one blob. tern's worst offender reached
// 11,855 lines (packages/core/src/index_test.ts) before the split that
// introduced this check; the cap is what keeps that from happening again.
//
// The rule: every hand-written source file is at most MAX_LINES lines.
// Generated artifacts are exempt by construction (see EXEMPT) — nobody edits
// them, so a line cap there would only ever be noise.
//
// What is checked: .rs, .ts, .tsx, .mts, .js, .mjs, .cjs, tracked by git.
// Restricting the scan to tracked files is what keeps node_modules/, target/
// and the gitignored packages/*/dist/ out without a hand-maintained ignore
// list.
//
// What is NOT checked: docs (*.md) and the lockfiles. Long-form prose and
// machine-generated dependency graphs are read as wholes; line count says
// nothing useful about either.
//
// Usage:
//   node tools/check-file-size.mjs            # check; exit 1 on any violation
//   node tools/check-file-size.mjs --list     # show the 25 largest, exit 0
//   node tools/check-file-size.mjs --max=600  # override the cap
//
// Exit: 0 when every scanned file is within the cap; 1 otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The default cap. Override with --max=N (or TERN_FILE_MAX_LINES). */
const DEFAULT_MAX_LINES = 800;

/** Extensions that count as hand-written source. */
const SOURCE_EXTENSIONS = [".rs", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"];

// Generated artifacts that are tracked anyway. These are exempt because they
// are produced by a tool (napi-rs, tsc, deno task docs:api), not authored:
//   src/bindings/tern-node/index.d.ts — napi-rs declaration surface
//   src/bindings/tern-node/index.js   — napi-rs platform loader
//   **/*.d.ts                        — any other emitted declaration file
// Everything else generated (packages/*/dist/, docs/api/, target/) is
// gitignored, so git ls-files already excludes it.
const EXEMPT_SUFFIXES = [".d.ts"];
const EXEMPT_PATHS = new Set([
  "src/bindings/tern-node/index.d.ts",
  "src/bindings/tern-node/index.js",
]);

/** Parse --max=N / --list out of argv. */
function parseArgs(argv) {
  let max = Number(process.env.TERN_FILE_MAX_LINES ?? DEFAULT_MAX_LINES);
  let list = false;
  for (const arg of argv) {
    if (arg === "--list") {
      list = true;
    } else if (arg.startsWith("--max=")) {
      max = Number(arg.slice("--max=".length));
    } else {
      console.error(`check-file-size: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(max) || max <= 0) {
    console.error("check-file-size: --max must be a positive integer");
    process.exit(2);
  }
  return { max, list };
}

/**
 * List tracked files, plus untracked ones that are not gitignored. Falls back
 * to a walk when git is unavailable (a tarball checkout), in which case the
 * generated trees are excluded by hand.
 *
 * --others matters: a file that has just been written but not staged is
 * exactly when a new 2,000-line module is easiest to miss, and a check that
 * only sees the index would stay quiet until someone ran `git add`.
 */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    console.error(
      "check-file-size: git ls-files unavailable — scanning only src/, packages/, tools/, examples/",
    );
    return walk(["src", "packages", "tools", "examples"]);
  }
}

/** Recursive readdir with the generated trees pruned. */
function walk(roots) {
  const found = [];
  const prune = new Set(["node_modules", "target", "dist", ".git"]);
  const visit = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || prune.has(entry.name)) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) found.push(relative(repoRoot, child));
    }
  };
  for (const root of roots) {
    try {
      statSync(join(repoRoot, root));
      visit(join(repoRoot, root));
    } catch {
      // Root absent in this checkout — nothing to scan.
    }
  }
  return found;
}

/** True when the path is hand-written source subject to the cap. */
function isSubjectToCap(path) {
  if (EXEMPT_PATHS.has(path)) return false;
  if (EXEMPT_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Count the lines of a file, counting a trailing newline as a terminator. */
function countLines(relPath) {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

const { max, list } = parseArgs(process.argv.slice(2));

const measured = trackedFiles()
  .filter(isSubjectToCap)
  // A tracked-but-deleted file (mid-refactor, or a rename in flight) has no
  // line count to check.
  .filter((path) => existsSync(join(repoRoot, path)))
  .map((path) => ({ path, lines: countLines(path) }))
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

if (list) {
  console.log(`check-file-size: ${measured.length} source files, cap ${max} lines`);
  for (const { path, lines } of measured.slice(0, 25)) {
    const mark = lines > max ? "OVER" : " ok ";
    console.log(`  ${mark} ${String(lines).padStart(6)}  ${path}`);
  }
  process.exit(0);
}

// Files still over the cap, mid-refactor. Each entry names why it is not yet
// split. This list is a ratchet: it may only ever shrink. A file that is over
// the cap and NOT listed here fails the check, so a new long file cannot hide
// behind someone else's deferral.
const DEFERRED = new Map([
  ["packages/react/src/index_test.ts", "React renderer test suite; split pending"],
  ["packages/solid/src/index_test.ts", "Solid renderer test suite; split pending"],
  ["packages/solid/src/index.ts", "Solid element factories; split pending"],
  ["packages/examples/kitchen-sink-react.ts", "React demo; split pending"],
  ["packages/examples/kitchen-sink-solid.ts", "Solid demo; split pending"],
]);

const over = measured.filter((entry) => entry.lines > max);
const hard = over.filter((entry) => !DEFERRED.has(entry.path));
const deferred = over.filter((entry) => DEFERRED.has(entry.path));

if (hard.length === 0 && deferred.length > 0) {
  console.log(
    `check-file-size: OK — ${measured.length} source files, cap ${max} lines, ` +
      `${deferred.length} deferred:`,
  );
  for (const { path, lines } of deferred) {
    console.log(`  ${String(lines).padStart(6)} lines  ${path}  (${DEFERRED.get(path)})`);
  }
  process.exit(0);
}

if (over.length === 0) {
  console.log(
    `check-file-size: OK — ${measured.length} source files, largest ${measured[0]?.lines ?? 0} lines (cap ${max}).`,
  );
  process.exit(0);
}

console.error(
  `check-file-size: FAIL — ${hard.length} file(s) exceed the ${max}-line cap:`,
);
for (const { path, lines } of hard) {
  console.error(`  ${String(lines).padStart(6)} lines (+${lines - max})  ${path}`);
}
console.error(
  `\nSplit each file along its existing seams (see CONTRIBUTING.md §3 "文件行数"` +
    `\nand docs/architecture.md "Module size") so no module exceeds ${max} lines.`,
);
process.exit(1);