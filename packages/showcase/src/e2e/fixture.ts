//! The documents the showcase e2e flows open, and the bytes a flow must leave
//! behind.
//!
//! A FIXTURE IS NEVER A REPO FILE. writeFixture is handed the directory by the
//! runner, which owns it under the system temp directory; nothing here decides a
//! path. That is the harness's one non-negotiable property - a flow types and
//! saves for REAL, so a fixture that resolved into the checkout would rewrite the
//! working tree of whoever ran the suite.
//!
//! The MARKER is the content assertion. It is a token the opened document
//! contains, so a raw terminal stream that holds it proves the app painted THE
//! FILE and not merely a chrome-only screen. It is also interpolated into a shell
//! command by the runner (the protocol src/e2e/cli.ts documents), so it stays a
//! bare token - letters, digits, underscore, dot.
//!
//! THE FIXTURE IS ALSO THE HEADLESS PROOF. prepty_test.ts drives the app through
//! each flow's OWN steps against its OWN fixture and asserts the tokens the runner
//! greps for are genuinely on the frame - so a fixture whose marker a launch
//! cannot paint fails in a second here, not after a ten-second tmux poll.

/** One document a flow opens, and the one edit the flow types into it. */
export interface Fixture {
  /** The basename of the temp file the fixture is written under; the file list
   * beside the editor shows exactly this name. Not the flow name - a flow is
   * named in flows.ts, and its fixture is a file. */
  readonly fileName: string;
  /** The document as opened: what is on disk before the first keystroke. */
  readonly text: string;
  /** A token the fixture text contains, and the token the runner greps the raw
   * terminal stream for. */
  readonly marker: string;
  /** The literal characters a flow types at its caret, when it types. A flow that
   * only scrolls or lists (the picker) has no edit and omits it. */
  readonly typed?: string;
  /** Extra files written beside the fixture, so the picker has something to list
   * under a name the sidebar truncates. Basenames only; never a path. */
  readonly siblings?: readonly string[];
}

/**
 * open-edit-save's document: five short ASCII lines, the marker FIRST.
 *
 * THE MARKER IS LINE 1 ON PURPOSE. The content assertion runs against the frame a
 * launch paints, so the token has to be one that frame shows; a marker further down
 * the file would make the flow's first assertion depend on how much of a window a
 * first frame materializes, which is a different question from "did the app paint
 * the file it was opened on". Every line is also narrower than the editor's window
 * at 80 columns (the file list takes 20 of them) and pure ASCII, so the marker
 * reaches the screen whole and nothing here depends on a wrap, a truncation or a
 * wide glyph.
 *
 * The typed edit is inserted at the caret a launch starts from - 0:0 - so it lands
 * IN FRONT of this marker and the saved bytes are the typed text then the document.
 */
export const OPEN_EDIT_SAVE_TEXT: string = [
  "TERN_E2E_OPEN_EDIT_SAVE_MARKER",
  "# open-edit-save fixture - a TEMP file, never the repo.",
  "line 3: a launch puts the caret at 0:0.",
  "line 4: ctrl+s writes the buffer back to this temp file.",
  "line 5: assert the saved bytes, not just the paint.",
  "",
].join("\n");

/** The open-edit-save fixture: the document above, the edit that must land. */
export const OPEN_EDIT_SAVE: Fixture = {
  fileName: "open-edit-save.txt",
  text: OPEN_EDIT_SAVE_TEXT,
  marker: "TERN_E2E_OPEN_EDIT_SAVE_MARKER",
  typed: "TERN_E2E_EDIT>",
};

/**
 * launch-type's document. The marker is still line 1; the flow's whole point is
 * that the typed token appears ON THE FRAME (not merely in a saved file), so the
 * first frame is the paint the content assertion runs against.
 */
export const LAUNCH_TYPE_TEXT: string = [
  "TERN_E2E_LAUNCH_TYPE_MARKER",
  "# launch-type: the typed edit must reach the paint.",
  "line 3: nothing here is saved; the frame is the evidence.",
  "",
].join("\n");

/** The launch-type fixture: the launch frame and the typed token. */
export const LAUNCH_TYPE: Fixture = {
  fileName: "launch-type.txt",
  text: LAUNCH_TYPE_TEXT,
  marker: "TERN_E2E_LAUNCH_TYPE_MARKER",
  typed: "TERN_E2E_TYPED>",
};

/**
 * save-temp's document. The edit does NOT land at 0:0 - the flow moves the caret
 * one column right first - so the on-disk expectation is an INSERT in the middle of
 * the first line, not a prefix. That is a stronger check of the save path than
 * open-edit-save's prefix edit, and it is what tests that the runner's assert-saved
 * compares the WHOLE file rather than a prefix.
 */
export const SAVE_TEMP_TEXT: string = [
  "TERN_E2E_SAVE_TEMP_MARKER",
  "# save-temp: the edit lands after the first character.",
  "line 3: ctrl+s must write the whole edited buffer.",
  "",
].join("\n");

/** The save-temp fixture: the launch document and the typed token. */
export const SAVE_TEMP: Fixture = {
  fileName: "save-temp.txt",
  text: SAVE_TEMP_TEXT,
  marker: "TERN_E2E_SAVE_TEMP_MARKER",
  typed: "TERN_E2E_SAVED>",
};

/** The line count of SCROLL_LARGE_TEXT: two hundred numbered lines, far more than
 * the editor's window at 80x24, so every later line needs a real scroll to reach
 * the paint. */
export const SCROLL_LARGE_LINES = 200;

/**
 * scroll-large's document: SCROLL_LARGE_LINES lines, each carrying its own number.
 * The token the flow waits for after scrolling is line 90's, so the assertion cannot
 * pass on the launch frame - the first frame only ever holds the first window.
 */
export const SCROLL_LARGE_TEXT: string = Array.from({ length: SCROLL_LARGE_LINES }, (_, index) => {
  const n = String(index + 1).padStart(3, "0");
  return "TERN_E2E_SCROLL_" + n + " line " + n + " of " + SCROLL_LARGE_LINES;
}).join("\n") + "\n";

/** The scroll-large fixture. It has no typed edit: the flow's one action is a
 * scroll, and its evidence is the later line the window reaches. */
export const SCROLL_LARGE: Fixture = {
  fileName: "scroll-large.txt",
  text: SCROLL_LARGE_TEXT,
  marker: "TERN_E2E_SCROLL_001",
};

/** The line whose token SCROLL_LARGE_FLOW waits for after scrolling. */
export const SCROLL_LARGE_TARGET_LINE = 90;

/**
 * open-picker's document, and the sibling a picker can list.
 *
 * THE SIBLING NAME IS THE ASSERTION, AND IT IS LONG ON PURPOSE. The sidebar is 20
 * columns and truncates a label to about 18 cells, so the full sibling name can
 * only reach the screen through the picker's WIDER overlay - a grep for it proves
 * the picker opened rather than the file list merely rendering. The picker's own
 * title ("Open file") would be simpler but would not be a listed filename, which is
 * what this flow exists to assert.
 */
export const PICKER_LISTED_FILE = "TERN_E2E_PICKER_LISTED.txt";

/** The open-picker fixture: the opened document plus the file to be listed. */
export const OPEN_PICKER: Fixture = {
  fileName: "notes.txt",
  text: [
    "TERN_E2E_PICKER_MARKER",
    "# open-picker: the picker lists the sibling file here.",
    "",
  ].join("\n"),
  marker: "TERN_E2E_PICKER_MARKER",
  siblings: [PICKER_LISTED_FILE],
};

/** The bytes a prefix edit at 0:0 leaves: the typed text then the document. */
export function prefixedText(fixture: Fixture): string {
  return (fixture.typed ?? "") + fixture.text;
}

/** The bytes an insert at code-unit offset 'at' leaves. */
export function insertedText(fixture: Fixture, at: number): string {
  return fixture.text.slice(0, at) + (fixture.typed ?? "") + fixture.text.slice(at);
}

/**
 * Write 'fixture' into 'dir' and return the document's path.
 *
 * The directory is the RUNNER's, not this module's - it is created if missing and
 * nothing else in it is touched. A fixture's siblings are written first, so the
 * document the picker offers always exists too. The write is synchronous because
 * 'prepare' prints the path it just produced: a promised write could print a path
 * that does not exist yet, and the runner would launch the app on a missing file
 * (which the app reports and opens as an unnamed buffer rather than failing - a
 * confusing e2e failure to debug, and one this call removes).
 */
export function writeFixture(fixture: Fixture, dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  const base = dir.replace(/\/+$/, "");
  for (const sibling of fixture.siblings ?? []) {
    Deno.writeTextFileSync(base + "/" + sibling, sibling + " - a second file in the e2e directory.\n");
  }
  const path = base + "/" + fixture.fileName;
  Deno.writeTextFileSync(path, fixture.text);
  return path;
}

/** The file's text, or null when it cannot be read - the state the on-disk
 * assertion polls out of, and the one it reports as "not saved yet" rather than as
 * a crash. */
export function readFixtureOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}
