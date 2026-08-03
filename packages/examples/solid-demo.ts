/**
 * solid-demo — @tern/solid example scene for the tern TUI engine.
 *
 * Builds the same scene as react-demo — a flex-column `Box` with a rounded
 * border and 1-cell padding holding two `Text` leaves ("Hello Solid" /
 * "Press q to quit") plus a `StreamingText` node fed with an async stream
 * of 3 spans — through the `@tern/solid` custom renderer, mounts it with
 * the renderer's universal `render()`, feeds the stream via the solid
 * `subscribeStream` helper (a timer/loop before the event loop), then runs
 * an event loop that quits on 'q' (via the core renderer's `onKey`;
 * @tern/solid ships no input hook yet in the MVP).
 *
 * Runtime: Deno-first per the project preference. The demo prefers
 * `deno run --allow-all`; if Deno cannot load the native Node-API addon
 * (see @tern/core `loadAddon`), the demo re-runs itself under `node` and
 * reports the limitation clearly. The smoke harness (`run-smoke.sh`) drives
 * this file under a macOS `script` PTY with 'q' piped in and asserts exit 0.
 */

import {
  createRenderer,
  type KeyEvent,
  type Node,
  type Renderer,
  type Span,
  type TernEventJs,
} from "@tern/core";
import { Box, StreamingText, Text, render as solidRender, subscribeStream } from "@tern/solid";
import process from "node:process";

const isDeno = typeof Deno !== "undefined";

// ---------------------------------------------------------------------------
// Streaming source
// ---------------------------------------------------------------------------

/** The three lines streamed into the `StreamingText` node. */
const STREAM_LINES = ["Streaming line 1", "Streaming line 2", "Streaming line 3"];

/**
 * The accumulated text of the stream, recorded as `subscribeStream` consumes
 * each span. The scene-side stream is not readable back through the binding,
 * so this record is the demo's assertion source for "the accumulated text is
 * present in the scene" (a span is only recorded after the pump has consumed
 * the yield and appended it to the node).
 */
const streamed: string[] = [];

/**
 * The demo's stream: yields each line after a short timer delay so the
 * spans visibly accumulate, mirroring a live feed.
 */
async function* stream(): AsyncIterable<Span> {
  for (const line of STREAM_LINES) {
    yield { text: line };
    streamed.push(line);
  }
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
    console.error("[solid-demo] Deno failed to load the Node-API addon:");
    console.error(message);
    console.error(
      "[solid-demo] Limitation: falling back to `node` for this run " +
        "(Deno native addon loading failed; see the error above).",
    );
    const { spawnSync } = await import("node:child_process");
    const file = new URL(import.meta.url).pathname;
    const result = spawnSync("node", [file], { stdio: "inherit" });
    process.exit(result.status === null ? 1 : result.status);
  }
  console.error("[solid-demo]", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scene, built through the @tern/solid factories (createElement + spread)
// ---------------------------------------------------------------------------

const box = Box({
  border_style: "rounded",
  padding: 1,
  flex_direction: "column",
  width: 24,
  height: 7,
});
box.addChild(Text({ text: "Hello Solid" }));
box.addChild(Text({ text: "Press q to quit" }));
const streamingNode = StreamingText();
box.addChild(streamingNode);

// Mount the scene through the solid renderer's universal `render()` (its
// insert path funnels into @tern/core `Node.addChild`). The returned
// disposer releases the solid root; for this static scene it is a no-op.
const dispose = solidRender(() => box, renderer.root);
renderer.render();

// Feed the streaming node through the solid streaming API: the pump appends
// each span to the now-attached node (straight into the shared scene) and
// records the consumed line in `streamed`.
const unsubscribe = subscribeStream(streamingNode, stream());

// Timer/loop before the event loop: wait for all STREAM_LINES spans to be
// appended, then paint the accumulated stream so it is visible.
const streamDeadline = Date.now() + 2000;
while (streamed.length < STREAM_LINES.length && Date.now() < streamDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
renderer.render();

// ---------------------------------------------------------------------------
// Scene assertions (the PTY run only passes if the scene rendered)
// ---------------------------------------------------------------------------

const boxNode: Node | undefined = renderer.root.children[0];
const leaves: readonly Node[] = boxNode?.children ?? [];
const texts: Array<string | undefined> = leaves.map((leaf) => leaf.props.text);
const expectTexts = ["Hello Solid", "Press q to quit"];
const streamNode = leaves[2];
const streamedText = streamed.join("");

const sceneOk =
  boxNode !== undefined &&
  boxNode.type === "box" &&
  leaves.length === 3 &&
  expectTexts.every((text, index) => texts[index] === text) &&
  streamNode?.type === "streaming_text" &&
  streamed.length === STREAM_LINES.length &&
  streamedText === STREAM_LINES.join("");

if (!sceneOk) {
  console.error(
    "[solid-demo] FAIL: scene mismatch",
    JSON.stringify({ texts, streamed: streamedText }),
  );
  renderer.destroy();
  process.exit(1);
}
console.log(
  `[solid-demo] ok: scene has 2 text leaves + streaming_text with ` +
    `${streamed.length} spans: "${streamedText}"`,
);

// ---------------------------------------------------------------------------
// Event loop: quit on 'q' (core onKey), or on ctrl+c auto-destroy
// ---------------------------------------------------------------------------

let quit = false;
renderer.onKey((event: KeyEvent) => {
  if (event.name === "char" && event.char === "q") quit = true;
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
unsubscribe();
dispose?.();
renderer.destroy();

if (!quit) {
  console.error("[solid-demo] FAIL: did not receive 'q' within 5s");
  process.exit(1);
}
console.log(`[solid-demo] runtime: ${isDeno ? "deno" : "node"}`);
console.log("[solid-demo] ok: rendered 'Hello Solid' and quit on 'q'");
process.exit(0);
