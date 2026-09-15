//! The documents the showcase e2e flows open, and the bytes a flow must leave
//! behind.
//!
//! A FIXTURE IS NEVER A REPO FILE. {@link writeFixture} is handed the directory
//! by the runner, which owns it under the system temp directory; nothing here
//! decides a path. That is the harness's one non-negotiable property — a flow
//! types and saves for REAL, so a fixture that resolved into the checkout would
//! rewrite the working tree of whoever ran the suite.
//!
//! The MARKER is the content assertion. It is a token the opened document
//! contains, so a raw terminal stream that holds it proves the app painted THE
//! FILE and not merely a chrome-only screen. It is also interpolated into a shell
//! command by the runner (the protocol {@link ./cli.ts} documents), so it stays
//! a bare token — letters, digits and `_`.

/** One document a flow opens, and the one edit the flow types into it. */
export interface Fixture {
  /** The basename of the temp file the fixture is written under; the file list
   * beside the editor shows exactly this name. Not the flow name — a flow is
   * named in `flows.ts`, and its fixture is a file. */
  readonly fileName: string;
  /** The document as opened: what is on disk before the first keystroke. */
  readonly text: string;
  /** A token {@link Fixture.text} contains, and the token the runner greps the
   * raw terminal stream for. */
  readonly marker: string;
  /** The literal characters the flow types at the caret a launch starts from —
   * the document's own start, which is where a fresh {@link HeadlessApp} puts
   * it (`core/state.ts`: the constructor and `load` both sit at 0:0). */
  readonly typed: string;
}

/**
 * `open-edit-save`'s document: five short ASCII lines, the marker FIRST.
 *
 * THE MARKER IS LINE 1 ON PURPOSE. The content assertion runs against the frame a
 * launch paints, so the token has to be one that frame shows; a marker further
 * down the file would make the flow's first assertion depend on how much of a
 * window a first frame materializes, which is a different question from "did the
 * app paint the file it was opened on". Every line is also narrower than the
 * editor's window at 80 columns (the file list takes 20 of them) and pure ASCII,
 * so the marker reaches the screen whole and nothing here depends on a wrap, a
 * truncation or a wide glyph.
 *
 * The typed edit is inserted at the caret a launch starts from — 0:0 — so it
 * lands IN FRONT of this marker and the saved bytes are `typed + text`.
 */
export const OPEN_EDIT_SAVE_TEXT: string = [
  "TERN_E2E_OPEN_EDIT_SAVE_MARKER",
  "# open-edit-save fixture - a TEMP file, never the repo.",
  "line 3: a launch puts the caret at 0:0.",
  "line 4: ctrl+s writes the buffer back to this temp file.",
  "line 5: assert the saved bytes, not just the paint.",
  "",
].join("\n");

/** The `open-edit-save` fixture: the document above, the edit that must land. */
export const OPEN_EDIT_SAVE: Fixture = {
  fileName: "open-edit-save.txt",
  text: OPEN_EDIT_SAVE_TEXT,
  marker: "TERN_E2E_OPEN_EDIT_SAVE_MARKER",
  typed: "TERN_E2E_EDIT>",
};

/**
 * The bytes a successful run leaves on disk: the typed text inserted at the
 * document's start.
 *
 * The caret a launch starts from is 0:0, so the edit is a PREFIX of the fixture —
 * `typed + text` and nothing else, with no newline invented and no line ending
 * rewritten (the buffer round-trips the bytes it read; `core/fs.ts`).
 */
export function savedText(fixture: Fixture): string {
  return fixture.typed + fixture.text;
}

/**
 * Write `fixture` into `dir` and return the file's path.
 *
 * The directory is the RUNNER's, not this module's — it is created if missing and
 * nothing else in it is touched. The write is synchronous because `prepare`
 * prints the path it just produced: a promised write could print a path that does
 * not exist yet, and the runner would launch the app on a missing file (which the
 * app reports and opens as an unnamed buffer rather than failing — a confusing
 * e2e failure to debug, and one this call removes).
 */
export function writeFixture(fixture: Fixture, dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  const path = dir.replace(/\/+$/, "") + "/" + fixture.fileName;
  Deno.writeTextFileSync(path, fixture.text);
  return path;
}

/** The file's text, or `null` when it cannot be read — the state the on-disk
 * assertion polls out of, and the one it reports as "not saved yet" rather than
 * as a crash. */
export function readFixtureOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}
