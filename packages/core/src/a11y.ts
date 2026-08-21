/**
 * The M4.2 a11y stream: serialize `Renderer.semantics()` dumps — the flat
 * `SceneSemanticsJs[]` pre-order shape (see docs/a11y.md) — into a versioned
 * JSONL stream, one line per coalesced painted frame.
 *
 * Pure read, exactly like the semantics store it reads: the stream never
 * touches layout or painted content, and — mirroring the M4.1 default-off
 * best-effort contract — a destroyed-renderer read error or a throwing sink
 * is caught and swallowed, never propagating into the frame path.
 *
 * Stream shape (protocol version {@link A11Y_STREAM_VERSION}):
 * - one header line `{"v":1}` emitted synchronously at construction;
 * - then one line per emission: the full dump serialized as ONE JSON array.
 *   Scene node ids (`SceneSemanticsJs.id` / `parent`) are `bigint`, which
 *   `JSON.stringify` throws on, so they serialize as decimal strings
 *   (`"id":"3"`).
 * - no-change suppression: an emission whose serialized dump is
 *   byte-identical to the last emission is skipped (the header is emitted
 *   exactly once and is not subject to suppression).
 */

import type { SceneSemanticsJs } from "./index.ts";

/** The a11y stream protocol version — the value of the stream's header
 * line. Bump on any breaking change to the emitted line shape. */
export const A11Y_STREAM_VERSION = 1;

/** Serialize a semantics dump to one JSON array line. The `bigint` replacer
 * is non-negotiable: `JSON.stringify` throws on a BigInt value, and every
 * `SceneSemanticsJs` entry carries bigint `id`/`parent` fields. */
function serializeDump(dump: SceneSemanticsJs[]): string {
  return JSON.stringify(
    dump,
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * A versioned JSONL stream over a renderer's semantics dump. Constructed by
 * {@link Renderer.startA11yStream}, which binds the semantics getter to
 * `() => renderer.semantics()` and calls `emit()` once per coalesced painted
 * frame — so each painted frame yields at most one stream line (the
 * no-change suppression drops duplicate dumps).
 */
export class A11yStream {
  /** The semantics getter — the `Renderer.semantics()` read. */
  #semantics: () => SceneSemanticsJs[];
  /** The line sink. */
  #onLine: (line: string) => void;
  /** The last dump line handed to the sink, or `null` before the first
   * emission — the no-change suppression key. */
  #last: string | null = null;
  /** Whether the stream is closed; `emit()` after close is a no-op. */
  #closed = false;

  constructor(
    semantics: () => SceneSemanticsJs[],
    onLine: (line: string) => void,
  ) {
    this.#semantics = semantics;
    this.#onLine = onLine;
    // The versioned header: exactly one line, emitted synchronously at
    // construction, best-effort (a throwing sink must not break the
    // renderer that started the stream).
    try {
      onLine(JSON.stringify({ v: A11Y_STREAM_VERSION }));
    } catch {
      // Best-effort — swallowed, never propagates into the frame path.
    }
  }

  /** Serialize the current dump and push it through the sink — unless the
   * serialized dump is byte-identical to the last emission (no-change
   * suppression). A destroyed-renderer read error and any sink throw are
   * caught and swallowed: the stream must never break the frame path. */
  emit(): void {
    if (this.#closed) return;
    try {
      const line = serializeDump(this.#semantics());
      if (line === this.#last) return;
      this.#last = line;
      this.#onLine(line);
    } catch {
      // Best-effort — swallowed, mirroring the semantics best-effort
      // contract: a broken stream must not take down a painted frame.
    }
  }

  /** Stop future emissions: `emit()` after close is a no-op. */
  close(): void {
    this.#closed = true;
  }
}
