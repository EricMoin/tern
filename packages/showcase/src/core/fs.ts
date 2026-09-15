//! The document IO port: the app-core's only dependency on the outside world.

/**
 * The file system the editor reads and writes documents through.
 *
 * This interface is the whole IO surface of the headless app-core. The core
 * never calls a Deno (or Node) API directly, so it never needs a permission
 * flag, a real path, or a real disk to run: production passes
 * {@link denoFileSystem}, and EVERY TEST PASSES AN IN-MEMORY FAKE — so no test
 * ever touches the real filesystem, and no test can fail because of a temp
 * directory, a permission prompt, or a leftover file from a previous run.
 * The fake is trivial to write (a `Map<string, string>` plus a throw on an
 * unknown path), which is the point: the port exists so the document model
 * and the command layer can be driven end to end with no IO at all.
 *
 * The two methods are deliberately the minimum a text editor needs, and both
 * are async and total in their failure mode: a read of a missing file and a
 * write to an unwritable path REJECT. The caller (the command layer, a later
 * subtask) decides what a failed load or save means to the user — this port
 * never swallows an error and never invents a fallback document, because a
 * silently empty buffer in place of an unreadable file is data loss.
 *
 * Paths are passed through verbatim: no expansion, no normalization, no
 * relative-to-cwd interpretation. Whatever the caller resolved is what is
 * read.
 */
export interface FileSystem {
  /**
   * Read `path` as UTF-8 text. Rejects when the file is missing, is not
   * readable, or is not valid UTF-8.
   */
  readFile(path: string): Promise<string>;
  /**
   * Overwrite `path` with `text` as UTF-8, creating the file when it does
   * not exist. Rejects when the write fails. The caller owns atomicity: a
   * crash mid-write can truncate the file, and a "save" that must not lose
   * data is expected to write a sibling temp file and rename it — the port
   * only promises that `text` was handed to the OS.
   */
  writeFile(path: string, text: string): Promise<void>;
}

/**
 * The one production implementation: Deno's UTF-8 text file API.
 *
 * It is a plain object literal, not a class, because there is no state to
 * keep — every call is one Deno call. `Deno.readTextFile` and
 * `Deno.writeTextFile` already have exactly the reject-on-failure contract
 * {@link FileSystem} documents, so this file holds no error handling of its
 * own: any translation of an IO error into a user-facing message belongs to
 * the caller, above the port.
 *
 * This is the only place in `packages/showcase/src/core/` that names a Deno
 * API. Keeping it to one file is what lets every other file in the core be
 * checked and tested with zero permissions.
 */
export const denoFileSystem: FileSystem = {
  readFile: (path: string): Promise<string> => Deno.readTextFile(path),
  writeFile: (path: string, text: string): Promise<void> => Deno.writeTextFile(path, text),
};
