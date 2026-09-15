//! Tests: the IO port — an in-memory fake drives a whole load/edit/save
//! cycle, so no test touches the real filesystem.

import { Buffer } from "./buffer.ts";
import { denoFileSystem, type FileSystem } from "./fs.ts";

/**
 * The fake every test injects. An unknown path REJECTS rather than reading as
 * an empty file: the port's failure mode is a rejection, and an editor that
 * silently opened a blank document for a missing file would invite the next
 * save to overwrite it with nothing.
 */
class MemoryFileSystem implements FileSystem {
  #files = new Map<string, string>();
  #writes = 0;

  /** Put a file in place without going through the port (test setup only). */
  seed(path: string, text: string): void {
    this.#files.set(path, text);
  }

  get writeCount(): number {
    return this.#writes;
  }

  readFile(path: string): Promise<string> {
    const text = this.#files.get(path);
    if (text === undefined) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(text);
  }

  writeFile(path: string, text: string): Promise<void> {
    this.#writes += 1;
    this.#files.set(path, text);
    return Promise.resolve();
  }
}

Deno.test("a load -> edit -> save round-trip runs entirely through the fake", async () => {
  const fake = new MemoryFileSystem();
  fake.seed("/notes/todo.txt", "alpha\nbeta");
  const files: FileSystem = fake;

  const buffer = Buffer.fromString(await files.readFile("/notes/todo.txt"));
  if (buffer.lineCount !== 2 || buffer.dirty) {
    throw new Error(`loaded buffer = ${buffer.lineCount}/${buffer.dirty}`);
  }

  buffer.insertText(0, 5, "\nnew");
  buffer.deleteRange({ row: 1, col: 0 }, { row: 1, col: 3 });
  if (buffer.text() !== "alpha\n\nbeta") {
    throw new Error(`edited text = ${JSON.stringify(buffer.text())}`);
  }
  if (!buffer.dirty) throw new Error("the edit did not mark the buffer dirty");

  await files.writeFile("/notes/todo.txt", buffer.text());
  buffer.markSaved();
  if (buffer.dirty) throw new Error("markSaved did not clear dirty");
  if (fake.writeCount !== 1) throw new Error(`writes = ${fake.writeCount}`);

  const reloaded = Buffer.fromString(await files.readFile("/notes/todo.txt"));
  if (reloaded.text() !== buffer.text()) {
    throw new Error(`reloaded = ${JSON.stringify(reloaded.text())}`);
  }
  if (reloaded.dirty || reloaded.lineCount !== 3) {
    throw new Error(`reloaded state = ${reloaded.lineCount}/${reloaded.dirty}`);
  }
});

Deno.test("the fake rejects an unknown path and serves a path it was written", async () => {
  const files: FileSystem = new MemoryFileSystem();
  let rejected = false;
  try {
    await files.readFile("/missing.txt");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("reading an unknown path resolved instead of rejecting");

  await files.writeFile("/fresh.txt", "hi");
  if (await files.readFile("/fresh.txt") !== "hi") throw new Error("a written path did not read back");
});

Deno.test("the production port satisfies the same interface (no IO is performed)", () => {
  // A compile-time check that denoFileSystem conforms to FileSystem, plus a
  // shape assertion. Referencing the value performs no IO and calls nothing:
  // this suite never reads or writes a real file.
  const port: FileSystem = denoFileSystem;
  if (typeof port.readFile !== "function" || typeof port.writeFile !== "function") {
    throw new Error(`denoFileSystem = ${JSON.stringify(Object.keys(port))}`);
  }
});
