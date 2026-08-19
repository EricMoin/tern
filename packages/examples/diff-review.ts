/**
 * diff-review — @tern-tui/core diff review flow demo.
 *
 * Renders a small code change (a proposed edit to a `src/format.ts` module)
 * the way an agent would review it before applying: a unified `DiffView`
 * with `inline_highlight` (green adds, red dels, dimmed context, intra-line
 * changed words bold + underlined) above a side-by-side `mode="side"` twin,
 * and a hunk pager — `j`/`down` pages to the next hunk, `k`/`up` to the
 * previous — panning both views' clip regions through their `scroll_y`
 * props, with a status line reporting the current hunk and scroll offset.
 * `q` quits.
 *
 * The diff surface is the real `@tern-tui/core` widget: `DiffView` (with the
 * `DiffLine` row model) is exported by `@tern-tui/core` (docs/components.md
 * "DiffView", docs/guide.md "DiffView"; src/index.ts `DiffViewProps` /
 * `DiffLine`). Core ships no dedicated key handler for the diff element —
 * the demos drive `Select` / `Table` with `selectKey` / `tableKey`, and the
 * diff pager is the same shape of demo-level JS: a pure `pageDiff` helper
 * that writes the clamped `scroll_y` back onto the `DiffView` root (the
 * scrollable clip region) via `Node.setProps`, routed from `renderer.onKey`.
 *
 * Every rendered row is asserted against its scene node before the event
 * loop: a failing assertion prints a `FAIL` line, tears the renderer down
 * and exits 1 — so the PTY smoke harness (`run-smoke.sh`) only sees exit 0
 * when the scene rendered AND every assertion held AND the event loop quit
 * on 'q'.
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import {
  DIFF_ADD_FG,
  DIFF_DEL_FG,
  DiffView,
  createRenderer,
  type DiffLine,
  type KeyEvent,
  type Node,
  type Renderer,
  type TernEventJs,
} from "@tern-tui/core";
import { Box, Text, render as solidRender } from "@tern-tui/solid";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";
/** Whether stdin is a terminal: a PTY (interactive / the run-smoke.sh PTY
 * harness) vs a pipe (`</dev/null` in CI). A non-TTY stdin cannot enter raw
 * mode, so the demo runs the renderer `headless` (in-memory buffer, no event
 * stream) instead and reports success after the assertions. */
const isTty = isDeno ? Deno.stdin.isTerminal() : Boolean(process.stdin.isTTY);

// ---------------------------------------------------------------------------
// The change under review (a proposed edit to src/format.ts)
// ---------------------------------------------------------------------------

/**
 * The three change sites of the proposed edit, one `DiffLine` array per
 * hunk. The renderer takes the flat array (the canonical unified-diff model:
 * ctx/del/add rows in scene order); the group boundaries drive the pager.
 * `old_line` / `new_line` are the line numbers in the pre/post file, 0 on
 * the side the line does not exist:
 *
 *   - hunk 1 — `formatBytes` gains a `base` parameter and clamps negatives;
 *   - hunk 2 — `formatRate` passes a decimal base through;
 *   - hunk 3 — a new `formatDuration` helper is appended.
 */
const HUNK_GROUPS: DiffLine[][] = [
  // Hunk 1: formatBytes(bytes) -> formatBytes(bytes, base = 1024) + clamp.
  [
    { kind: "del", old_line: 3, new_line: 0, text: "export function formatBytes(bytes: number): string {" },
    { kind: "add", old_line: 0, new_line: 3, text: "export function formatBytes(bytes: number, base = 1024): string {" },
    { kind: "add", old_line: 0, new_line: 4, text: "  const value = clamp(bytes, 0, Number.MAX_SAFE_INTEGER);" },
    { kind: "del", old_line: 4, new_line: 0, text: "  if (bytes < 1024) return `${bytes} B`;" },
    { kind: "add", old_line: 0, new_line: 5, text: "  if (value < base) return `${value} B`;" },
    { kind: "del", old_line: 5, new_line: 0, text: "  return `${(bytes / 1024).toFixed(1)} KiB`;" },
    { kind: "add", old_line: 0, new_line: 6, text: "  return `${(value / base).toFixed(1)} ${base === 1024 ? \"KiB\" : \"kB\"}`;" },
    { kind: "ctx", old_line: 6, new_line: 7, text: "}" },
  ],
  // Hunk 2: formatRate switches to a decimal base for rates.
  [
    { kind: "ctx", old_line: 8, new_line: 9, text: "export function formatRate(bytes: number, seconds: number): string {" },
    { kind: "del", old_line: 9, new_line: 0, text: "  return `${formatBytes(bytes / seconds)}/s`;" },
    { kind: "add", old_line: 0, new_line: 10, text: "  return `${formatBytes(bytes / seconds, 1000)}/s`;" },
    { kind: "ctx", old_line: 10, new_line: 11, text: "}" },
  ],
  // Hunk 3: a new formatDuration helper appended after formatPct.
  [
    { kind: "ctx", old_line: 12, new_line: 13, text: "export function formatPct(part: number, whole: number): string {" },
    { kind: "ctx", old_line: 13, new_line: 14, text: "  return `${((part / whole) * 100).toFixed(0)}%`;" },
    { kind: "ctx", old_line: 14, new_line: 15, text: "}" },
    { kind: "add", old_line: 0, new_line: 17, text: "export function formatDuration(seconds: number): string {" },
    { kind: "add", old_line: 0, new_line: 18, text: "  if (seconds < 60) return `${seconds}s`;" },
    { kind: "add", old_line: 0, new_line: 19, text: "  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;" },
    { kind: "add", old_line: 0, new_line: 20, text: "}" },
  ],
];

/** The flat line model the `DiffView` renders, in scene order. */
const HUNKS: DiffLine[] = HUNK_GROUPS.flat();

/** The scene-row index where each hunk starts — the pager's jump targets. */
const HUNK_STARTS: number[] = [];
{
  let row = 0;
  for (const group of HUNK_GROUPS) {
    HUNK_STARTS.push(row);
    row += group.length;
  }
}

/** The clip height of the unified view: 9 of the 19 diff rows visible. */
const UNIFIED_CLIP = 9;
/** The clip height of the side-by-side view. */
const SIDE_CLIP = 6;
/** The max `scroll_y` of each view: content rows minus the clip height. */
const MAX_UNIFIED_Y = Math.max(0, HUNKS.length - UNIFIED_CLIP);
const MAX_SIDE_Y = Math.max(0, HUNKS.length - SIDE_CLIP);

/** The 1-based index of the hunk whose start row is at or above `scrollY`. */
function currentHunk(scrollY: number): number {
  let hunk = 0;
  for (let i = 0; i < HUNK_STARTS.length; i++) {
    if (HUNK_STARTS[i]! <= scrollY) hunk = i;
  }
  return hunk;
}

/** The status line text: current hunk and the view's scroll offset. */
function statusText(scrollY: number, maxY: number): string {
  return `hunk ${currentHunk(scrollY) + 1}/${HUNK_STARTS.length} · scroll_y ${scrollY}/${maxY}`;
}

/**
 * Page a diff view to the next/previous hunk: the next (or previous) hunk
 * start row becomes the top visible row, clamped to the content bound. The
 * offset is written back onto the view's `scroll_y` prop — the root box is
 * the scrollable clip region, and the compositor pans the subtree by the
 * offset (the same seam `scrollTo` uses on a `scroll_view`). Returns the
 * applied offset.
 */
function pageDiff(view: Node, direction: 1 | -1, maxY: number): number {
  const current = typeof view.props.scroll_y === "number" ? view.props.scroll_y : 0;
  let next: number;
  if (direction === 1) {
    const start = HUNK_STARTS.find((row) => row > current);
    next = start === undefined ? maxY : Math.min(start, maxY);
  } else {
    // The last hunk start strictly above the current scroll position.
    let previous = 0;
    for (const row of HUNK_STARTS) {
      if (row >= current) break;
      previous = row;
    }
    next = previous;
  }
  view.setProps({ ...view.props, scroll_y: next });
  return next;
}

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true, headless: !isTty });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[diff-review] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[diff-review] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[diff-review]", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scene: a review header, the unified diff, the side-by-side twin, status
// ---------------------------------------------------------------------------

const box = Box({ border_style: "rounded", padding: 1, flex_direction: "column" });
box.addChild(Text({ text: "diff review: src/format.ts", bold: true }));
box.addChild(Text({ text: "j/k or up/down: page hunks · q: quit", dim: true }));

// The review pane: a unified diff with intra-line highlighting, clipped to
// UNIFIED_CLIP rows. `wrap: false` keeps every line single-row (the classic
// diff look — overflow trims at the right edge).
const unified = DiffView({
  hunks: HUNKS,
  mode: "unified",
  inline_highlight: true,
  wrap: false,
  height: UNIFIED_CLIP,
});
box.addChild(unified);

box.addChild(Text({ text: "side-by-side:", dim: true }));

// The same change in two aligned columns (old | new), each column one row
// per hunk line with its own gutter (per-column line numbers).
const side = DiffView({ hunks: HUNKS, mode: "side", wrap: false, height: SIDE_CLIP });
box.addChild(side);

// The status line: which hunk the pager is on and the scroll offset.
const status = Text({ text: statusText(0, MAX_UNIFIED_Y) });
box.addChild(status);

// Mount the scene through the solid renderer's universal `render()`.
const dispose = solidRender(() => box, renderer.root);
renderer.render();

/**
 * Page both diff views by `direction` and update the status line — the
 * shared path for the assertion block below and the event-loop key handler.
 * Mutations on the shared scene repaint only when the renderer paints, so
 * this mirrors the solid helpers (`tableKey`, `dragPanels`, ...), which
 * call `renderer.render()` after mutating the scene.
 */
function pageBoth(direction: 1 | -1): number {
  const y = pageDiff(unified, direction, MAX_UNIFIED_Y);
  pageDiff(side, direction, MAX_SIDE_Y);
  status.setProps({ text: statusText(y, MAX_UNIFIED_Y) });
  renderer.render();
  return y;
}

// ---------------------------------------------------------------------------
// Scene assertions (a failure prints FAIL and exits 1)
// ---------------------------------------------------------------------------

/** Assert a scene property; on failure tear down and exit 1. */
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[diff-review] ok: ${label}`);
    return;
  }
  console.error(`[diff-review] FAIL: ${label}`);
  renderer.destroy();
  process.exit(1);
}

const rootBox: Node | undefined = renderer.root.children[0];
const kids: readonly Node[] = rootBox?.children ?? [];
const [, , unifiedNode, , sideNode, statusNode] = kids;

// --- scene structure --------------------------------------------------------
assert(rootBox?.type === "box", "app root is a box");
assert(kids.length === 6, `scene holds 6 nodes (got ${kids.length})`);
assert(unifiedNode?.type === "diff", "the unified DiffView materializes as a diff element");
assert(sideNode?.type === "diff", "the side-by-side DiffView materializes as a diff element");

// --- unified diff rows --------------------------------------------------------
assert(
  unifiedNode?.children.length === HUNKS.length,
  `unified diff renders ${HUNKS.length} rows`,
);
assert(
  unifiedNode?.children[7]?.children[0]?.props.text === " 6  7",
  "the gutter right-aligns old/new line numbers (ctx 6,7 → ' 6  7')",
);
assert(
  unifiedNode?.children[0]?.children[1]?.props.text === "-" &&
    unifiedNode?.children[0]?.children[1]?.props.fg === DIFF_DEL_FG,
  "deleted rows carry a '-' marker painted red",
);
assert(
  unifiedNode?.children[1]?.children[1]?.props.text === "+" &&
    unifiedNode?.children[1]?.children[1]?.props.fg === DIFF_ADD_FG,
  "added rows carry a '+' marker painted green",
);
assert(
  unifiedNode?.children[7]?.children[1]?.props.text === " " &&
    unifiedNode?.children[7]?.children[1]?.props.dim === true &&
    unifiedNode?.children[7]?.children[2]?.props.dim === true &&
    unifiedNode?.children[7]?.children[2]?.props.text === "}",
  "context rows carry a blank marker and dimmed content",
);

// --- inline_highlight --------------------------------------------------------
// The signature pair (del row 0 / add row 1) shares a prefix and suffix, so
// the intra-line char diff marks only the inserted ", base = 1024" segment
// bold + underlined; the unchanged prefix stays plain.
const sigContent = unifiedNode?.children[1]?.children[2];
assert(
  sigContent?.type === "box" && sigContent.children.length === 3,
  "inline_highlight splits the paired signature line into 3 segments",
);
assert(
  sigContent?.children[1]?.props.text === ", base = 1024" &&
    sigContent?.children[1]?.props.bold === true &&
    sigContent?.children[1]?.props.underline === true,
  "the intra-line changed segment (', base = 1024') is bold + underlined",
);
assert(
  sigContent?.children[0]?.props.text === "export function formatBytes(bytes: number" &&
    sigContent?.children[0]?.props.bold !== true,
  "the unchanged prefix stays plain",
);
// Hunk 2's rate line: only ", 1000" is marked changed.
const rateContent = unifiedNode?.children[10]?.children[2];
assert(
  rateContent?.type === "box" &&
    rateContent.children[1]?.props.text === ", 1000" &&
    rateContent.children[1]?.props.bold === true &&
    rateContent.children[1]?.props.underline === true,
  "the second hunk's intra-line change (', 1000') is also highlighted",
);
// Unpaired additions (the appended formatDuration block) stay uniform.
assert(
  unifiedNode?.children[18]?.children[2]?.props.text === "}" &&
    unifiedNode?.children[18]?.children[2]?.props.bold !== true,
  "unpaired added lines render as one uniform leaf",
);

// --- side-by-side ------------------------------------------------------------
assert(sideNode?.children.length === 2, "side-by-side composes two columns");
assert(
  sideNode?.props.flex_direction === "row" && sideNode?.props.gap === 1,
  "the side root is a flex row split by the 1-cell gutter",
);
const oldCol = sideNode?.children[0];
const newCol = sideNode?.children[1];
assert(
  oldCol?.type === "box" &&
    newCol?.type === "box" &&
    oldCol.children.length === HUNKS.length &&
    newCol.children.length === HUNKS.length,
  "both columns hold one row per hunk line",
);
assert(
  oldCol?.children[0]?.children[1]?.props.text === "-" &&
    oldCol?.children[0]?.children[2]?.props.text ===
      "export function formatBytes(bytes: number): string {" &&
    oldCol?.children[0]?.children[2]?.props.fg === DIFF_DEL_FG,
  "the old column renders the deleted signature in red",
);
// Both columns hold every hunk row; the new column blanks the rows it does
// not own (row 0 is the deleted signature, so the added signature is row 1).
assert(
  newCol?.children[1]?.children[1]?.props.text === "+" &&
    newCol?.children[1]?.children[2]?.props.text ===
      "export function formatBytes(bytes: number, base = 1024): string {" &&
    newCol?.children[1]?.children[2]?.props.fg === DIFF_ADD_FG,
  "the new column renders the added signature in green",
);
assert(
  oldCol?.children[1]?.children[2]?.props.text === "" &&
    oldCol?.children[1]?.children[1]?.props.text === " ",
  "the old column blanks pure additions",
);
assert(
  oldCol?.children[7]?.children[0]?.props.text === " 6" &&
    newCol?.children[7]?.children[0]?.props.text === " 7",
  "each column right-aligns its own gutter numbers",
);

// --- hunk pager ----------------------------------------------------------------
assert(
  (unifiedNode?.props.scroll_y ?? 0) === 0 && (sideNode?.props.scroll_y ?? 0) === 0,
  "both views start at scroll_y 0",
);
assert(
  statusNode?.props.text === "hunk 1/3 · scroll_y 0/10",
  "the status line reports hunk 1 at scroll 0",
);

const y1 = pageBoth(1);
assert(
  y1 === 8 && unifiedNode?.props.scroll_y === 8,
  `j pages to hunk 2 (scroll_y 8, got ${y1})`,
);
assert(
  statusNode?.props.text === "hunk 2/3 · scroll_y 8/10",
  "the status line follows to hunk 2",
);
const y2 = pageBoth(1);
assert(
  y2 === 10 && unifiedNode?.props.scroll_y === 10,
  `the third hunk clamps to the bottom (scroll_y 10, got ${y2})`,
);
const y3 = pageBoth(1);
assert(y3 === 10, "paging past the last hunk pins at the bottom");
const y4 = pageBoth(-1);
assert(y4 === 8, "k pages back to hunk 2");
const y5 = pageBoth(-1);
assert(y5 === 0, "k pages back to hunk 1");
const y6 = pageBoth(-1);
assert(y6 === 0, "paging above the first hunk pins at the top");

const s1 = pageDiff(side, 1, MAX_SIDE_Y);
assert(s1 === 8, "the side-by-side view pages to hunk 2 too");
const s2 = pageDiff(side, 1, MAX_SIDE_Y);
assert(s2 === 12, "the side view pages to hunk 3");
const s3 = pageDiff(side, 1, MAX_SIDE_Y);
assert(s3 === 13, "the side view pins at its own bottom (13)");
const s4 = pageDiff(side, -1, MAX_SIDE_Y);
assert(s4 === 12, "up from the pinned bottom returns to hunk 3");
const s5 = pageDiff(side, -1, MAX_SIDE_Y);
assert(s5 === 8, "up returns to hunk 2");
const s6 = pageDiff(side, -1, MAX_SIDE_Y);
assert(s6 === 0 && sideNode?.props.scroll_y === 0, "up returns to hunk 1 at the top");

// Reset the pager to hunk 1 so an interactive session (and the smoke harness,
// which only feeds 'q') starts at the top of the diff.
unified.setProps({ ...unified.props, scroll_y: 0 });
side.setProps({ ...side.props, scroll_y: 0 });
status.setProps({ text: statusText(0, MAX_UNIFIED_Y) });

// ---------------------------------------------------------------------------
// Event loop: j/k page the hunks, 'q' quits (core onKey), ctrl+c auto-destroys
// ---------------------------------------------------------------------------

let quit = !isTty; // a headless run has no terminal to read 'q' from
if (isTty) {
  renderer.onKey((event: KeyEvent) => {
    if (event.name === "char" && event.char === "q") {
      quit = true;
      return;
    }
    const direction =
      event.name === "down" || (event.name === "char" && event.char === "j") ? 1 :
      event.name === "up" || (event.name === "char" && event.char === "k") ? -1 :
      0;
    if (direction !== 0) pageBoth(direction);
  });

  renderer.startEventStream();
  const deadline = Date.now() + 5000;
  const events = renderer.events[Symbol.asyncIterator]();
  while (Date.now() < deadline && !quit) {
    if (renderer.destroyed) {
      // The 'q' handler's exit() destroyed the renderer — clean quit.
      quit = true;
      break;
    }
    // Wait for the next pushed event, bounded by the deadline so a dead
    // renderer fails the demo instead of hanging forever.
    const next = await Promise.race([
      events.next(),
      new Promise<IteratorResult<TernEventJs, undefined>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (next.done) break; // stream closed (renderer destroyed) or deadline hit
    if (renderer.destroyed) {
      // Ctrl+C with exitOnCtrlC tore the renderer down after delivering the
      // event — also a clean quit.
      quit = true;
      break;
    }
  }
  if (renderer.destroyed) quit = true;
}
dispose?.();
renderer.destroy();

if (!quit) {
  console.error("[diff-review] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[diff-review] runtime: ${isDeno ? "deno" : "node"}${isTty ? "" : " (headless)"}`);
console.log(
  isTty
    ? "[diff-review] ok: 19-line diff rendered (unified + side-by-side), hunks paged, quit on 'q'"
    : "[diff-review] ok: 19-line diff rendered headless (unified + side-by-side), hunks paged, no TTY to wait on",
);
process.exit(0);
