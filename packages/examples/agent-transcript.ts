/**
 * agent-transcript — @tern-tui/react example of a streaming LLM-agent
 * transcript.
 *
 * A focused demo of an agent-style chat session: a user turn (a static
 * `Text` leaf), an assistant turn streamed into a `<StreamingText>` node as
 * token-like spans, a `MarkdownView` (mounted as a scene-root sibling, the
 * same pattern the kitchen-sink demos use) rendering the assistant's
 * formatted reply — a heading, a paragraph, and a rust code fence that
 * exercises the tree-sitter `highlightCode` path — and a `StatusBar` whose
 * center segment shows the agent state. The state starts `streaming` and is
 * flipped to `done` in place (a core `setProps` + `renderer.render()`)
 * once the assistant's spans are fully pumped, mirroring how a live agent
 * TUI would update its status line.
 *
 * Every scene element is asserted after driving it (the same assertion
 * style as the @tern-tui/core unit tests and the kitchen-sink demos): a
 * failing assertion prints a `FAIL` line, tears the renderer down and exits
 * 1 — so the PTY smoke harness (`run-smoke.sh`) only sees exit 0 when every
 * scene assertion holds. The event loop then quits on 'q' (via `useInput`
 * -> `useApp().exit()`).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern-tui/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly.
 */

import { createElement } from "react";
import type { ReactElement } from "react";
import {
  MARKDOWN_FENCE_BG,
  MarkdownView,
  createRenderer,
  type KeyEvent,
  type Node,
  type Renderer,
  type Span,
  type TernEventJs,
} from "@tern-tui/core";
import { Box, StatusBar, StreamingText, Text, render, useApp, useInput } from "@tern-tui/react";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Transcript model: user turn + streaming assistant turn
// ---------------------------------------------------------------------------

/** The user's turn: a static leaf at the top of the transcript. */
const USER_TURN = "user: how do I sum a Vec<i32>?";

/** The assistant turn's token-like spans, streamed into `<StreamingText>`. */
const ASSISTANT_SPANS = [
  "Use an iterator: ",
  "`for x in &v` borrows each element ",
  "in turn; ",
  "`v.iter().map(...)` chains adapters ",
  "without consuming the vector.",
];

/**
 * The accumulated text of the assistant turn, recorded as the
 * `<StreamingText>` component consumes each span. The scene-side stream is
 * not readable back through the binding, so this record is the demo's
 * assertion source for "the accumulated text is present in the scene" (a
 * span is only recorded after the component's pump has consumed the yield
 * and appended it).
 */
const streamed: string[] = [];

/**
 * The demo's stream: yields each span after a short timer delay so the
 * transcript visibly accumulates, mirroring a token-by-token agent reply.
 */
async function* stream(): AsyncIterable<Span> {
  for (const span of ASSISTANT_SPANS) {
    yield { text: span };
    streamed.push(span);
  }
}

/** A single iterable the `<StreamingText>` effect consumes on mount. */
const streamIterable = stream();

/**
 * The agent state shown in the status bar's center segment: `streaming`
 * while the assistant turn is being pumped, flipped to `done` in place once
 * it completes.
 */
type AgentState = "streaming" | "done";
let agentState: AgentState = "streaming";

// ---------------------------------------------------------------------------
// Assistant reply (MarkdownView source, mounted as a scene-root sibling)
// ---------------------------------------------------------------------------

/**
 * The Markdown source of the reply `MarkdownView`: a heading, a paragraph
 * and a rust code fence (the fence exercises the tree-sitter
 * `highlightCode` path when the native addon is available; without the
 * addon it falls back to the single fence style).
 */
const MARKDOWN_SOURCE = [
  "# Assistant reply",
  "",
  "Iterate with `for x in &v` — each `x` borrows one element.",
  "",
  "```rust",
  "let total: i32 = v.iter().sum();",
  "```",
].join("\n");

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * The demo scene: a bordered transcript column holding the user turn, the
 * streaming assistant turn, the quit hint and the agent-state status bar.
 * The input handler quits the app (tears down raw mode + alternate screen)
 * on 'q'.
 */
function App(): ReactElement {
  const { exit } = useApp();
  useInput((event: KeyEvent) => {
    if (event.name === "char" && event.char === "q") exit();
  });
  return createElement(
    Box,
    {
      border_style: "rounded",
      padding: 1,
      flex_direction: "column",
      width: 64,
      height: 9,
    },
    createElement(Text, { text: USER_TURN }),
    createElement(StreamingText, { stream: streamIterable, clip_height: 2 }),
    createElement(Text, { text: "Press q to quit" }),
    createElement(StatusBar, { left: "agent", center: agentState, right: "q quit" }),
  );
}

// ---------------------------------------------------------------------------
// Runtime setup (Deno-first, node fallback)
// ---------------------------------------------------------------------------

let renderer: Renderer;
try {
  renderer = createRenderer({ exitOnCtrlC: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isDeno) {
    console.error("[agent-transcript] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[agent-transcript] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[agent-transcript]", message);
  process.exit(1);
}

render(createElement(App), renderer);

// The core `MarkdownView` factory is not a React host element (the reconciler
// only knows the roadmap host tags), so the demo mounts it imperatively as a
// scene-root sibling — the same pattern the kitchen-sink demos use. It renders
// the MARKDOWN_SOURCE column (heading, styled paragraph, rust code fence) and
// is asserted below.
const markdownNode = MarkdownView({ source: MARKDOWN_SOURCE, width: 64 });
renderer.root.addChild(markdownNode);

// React schedules passive effects (useInput's key subscription, and the
// StreamingText stream pump) on the scheduler rather than flushing them
// synchronously, so give them a beat to register before the event loop
// starts — otherwise a 'q' that arrives before the subscription is active
// would be dropped.
await new Promise((resolve) => setTimeout(resolve, 100));

// Timer/loop before the event loop: wait for the streaming pump to consume
// and append all ASSISTANT_SPANS (each consumed span is recorded in
// `streamed` right before the component appends it to the node).
const streamDeadline = Date.now() + 2000;
while (streamed.length < ASSISTANT_SPANS.length && Date.now() < streamDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// The assistant turn is fully streamed: flip the agent state to `done` in
// place — the core `setProps` single-key path repaints the center segment
// Text node, then `renderer.render()` flushes the diff (the same live-update
// idiom the core widgets use, e.g. `setProgress`).
const statusBar: Node | undefined = renderer.root.children[0]?.children[3];
const statusCenter: Node | undefined = statusBar?.children[1];
statusCenter?.setProps({ text: "done" });
agentState = "done";
renderer.render();

// ---------------------------------------------------------------------------
// Scene assertions (a failure prints FAIL and exits 1)
// ---------------------------------------------------------------------------

/** Assert a scene property; on failure tear down and exit 1. */
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[agent-transcript] ok: ${label}`);
    return;
  }
  console.error(`[agent-transcript] FAIL: ${label}`);
  renderer.destroy();
  process.exit(1);
}

const boxNode: Node | undefined = renderer.root.children[0];
const leaves: readonly Node[] = boxNode?.children ?? [];
const texts: Array<string | undefined> = leaves.map((leaf) => leaf.props.text);
const streamNode = leaves[1];
const streamedText = streamed.join("");

// --- transcript scene structure ---------------------------------------------
assert(boxNode?.type === "box", "transcript box materializes as the scene root");
assert(
  boxNode?.props.border_style === "rounded" && boxNode?.props.padding === 1,
  "transcript box is rounded with 1-cell padding",
);
assert(
  leaves.length === 4,
  `transcript holds user turn + streaming turn + quit hint + status bar (got ${leaves.length})`,
);
assert(
  leaves[0]?.type === "text" && texts[0] === USER_TURN,
  `user turn renders as a text leaf: "${USER_TURN}"`,
);
assert(
  leaves[3]?.type === "status_bar",
  "the agent-state status bar materializes as the last child",
);

// --- streaming assistant turn ------------------------------------------------
assert(
  streamNode?.type === "streaming_text" && streamNode.props.clip_height === 2,
  "the assistant turn streams into a 2-row streaming_text viewport",
);
assert(
  streamed.length === ASSISTANT_SPANS.length && streamedText === ASSISTANT_SPANS.join(""),
  `assistant turn streamed ${streamed.length} spans: "${streamedText}"`,
);

// --- StatusBar (agent state) --------------------------------------------------
const statusBar2: Node | undefined = renderer.root.children[0]?.children[3];
assert(statusBar2?.children.length === 3, "status bar holds 3 segments");
assert(
  statusBar2?.children.map((child) => child.props.text).join(",") ===
    `agent,done,q quit`,
  "left/center/right segments render in order (agent | done | q quit)",
);
assert(
  (statusBar2?.children[1]?.props.text as string | undefined) === agentState,
  `center segment shows the agent state (${agentState})`,
);
assert(statusBar2?.props.height === 1, "status bar strip is 1 row tall");
assert(!("left" in (statusBar2?.props ?? {})), "segment keys are lifted out of the strip props");
// The strip is stamped `status_bar: true` — the marker the compositor reads
// to reserve the bottom viewport row for the strip (docs/components.md
// "StatusBar — Reserved row").
assert(statusBar2?.props.status_bar === true, "the strip carries the reserved-row marker (status_bar: true)");

// --- MarkdownView (mounted as a scene-root sibling) ---------------------------
// The core factory renders the reply column: a heading, a styled paragraph
// and a rust code fence. The fence highlights through tree-sitter when the
// native addon is available (the smoke harness runs with it); without the
// addon it falls back to the single fence style — both shapes are asserted
// structurally, mirroring the @tern-tui/core unit tests.
const markdownNode2 = renderer.root.children[1];
assert(markdownNode2?.type === "markdown", "MarkdownView materializes as a scene-root sibling");
assert(markdownNode2?.props.flex_direction === "column", "the markdown root is a flex column");
assert(!("source" in (markdownNode2?.props ?? {})), "the parsed source never reaches the scene props");
const mdHeading = markdownNode2?.children[0];
assert(
  mdHeading?.type === "text" && mdHeading.props.bold === true && mdHeading.props.underline === true,
  "the reply heading renders bold + underlined",
);
const mdFence = markdownNode2?.children.find((child) => child.props.bg === MARKDOWN_FENCE_BG);
assert(mdFence !== undefined, "the rust code fence composes a bg box");
assert(
  (mdFence?.children.length ?? 0) === 1,
  `the fence holds one leaf per code line (got ${mdFence?.children.length})`,
);
// The fence leaves reconstruct the source line exactly (whether highlighted
// with token colors or plain): a highlighted line may be a flex row of
// per-span leaves, so the text is the leaves' joined props.
const fenceText = (node: Node): string =>
  typeof node.props.text === "string"
    ? node.props.text
    : node.children.map(fenceText).join("");
const fenceLines = mdFence?.children.map((line) => fenceText(line)).join("\n") ?? "";
assert(
  fenceLines === "let total: i32 = v.iter().sum();",
  `the fence renders the code line (got ${JSON.stringify(fenceLines)})`,
);

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (via useInput → exit()), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

renderer.startEventStream();
let quit = false;
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
renderer.destroy();

if (!quit) {
  console.error("[agent-transcript] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[agent-transcript] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[agent-transcript] ok: rendered the agent transcript and quit on 'q'");
process.exit(0);
