//! Layer A's host side: the IO the app-core asks for and never performs.
//!
//! The core's port is `core/fs.ts` — `FileSystem`, whose production implementation
//! is the one place in the core that names a Deno API (core/fs.ts:52-60). This file
//! is that port's caller: it translates the app's three requests (save, open, quit)
//! into host calls, and it adds the one thing the port deliberately does not offer —
//! a directory listing for the file list.
//!
//! A FAILED SAVE IS NOT A SAVED FILE. `markSaved` is called only after the write
//! resolved, so a save onto an unwritable path leaves the document dirty and the
//! mode line's `●` in place. The error is reported on stderr rather than swallowed:
//! a silent failure would be data loss dressed as success.

import { denoFileSystem, type FileSystem } from "../../core/fs.ts";
import type { HeadlessApp, PendingEffect } from "../../core/state.ts";

/** What the layer's host can do for the app. */
export interface HostIO {
  /** The document port the core declares (core/fs.ts:34). */
  readonly fs: FileSystem;
  /** The names the file list offers for `dir`, or an empty list when it cannot be
   * read — the pane is not worth failing a launch over. */
  list(dir: string): string[];
  /** The user asked to quit: tear the terminal down. */
  quit(): void;
}

/**
 * Run one pending effect. Returns `false` when the app asked to quit — the one
 * effect that ends the run.
 *
 * An `open` with no path is a file chooser, which the app-core does not have yet;
 * a `save` with no path has nothing to write to. Both are left undone, which is
 * what the core's own request says: it asks the HOST for the path
 * (`PendingEffect.path`), and this host has no prompt to offer in the first slice.
 */
export async function applyEffect(
  app: HeadlessApp,
  effect: PendingEffect,
  io: HostIO,
): Promise<boolean> {
  if (effect.kind === "quit") {
    io.quit();
    return false;
  }
  if (effect.kind === "save") {
    if (effect.path === null) return true;
    try {
      await io.fs.writeFile(effect.path, app.buffer.text());
      app.buffer.markSaved();
    } catch (error) {
      console.error("save failed: " + effect.path + " — " + String(error));
    }
    return true;
  }
  if (effect.path === null) return true;
  try {
    app.load(await io.fs.readFile(effect.path), effect.path);
  } catch (error) {
    console.error("open failed: " + effect.path + " — " + String(error));
  }
  return true;
}

/** The host a terminal launch runs on: the core's Deno port, a directory listing
 * for the pane, and `stop` for the quit effect. */
export function denoHost(stop: () => void): HostIO {
  return {
    fs: denoFileSystem,
    list: (dir: string): string[] => {
      try {
        return [...Deno.readDirSync(dir)]
          .filter((entry) => entry.isFile)
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },
    quit: stop,
  };
}
