//! The keymap bridge: the command table, registered into the framework's `Keymap`.
//
// `commands.ts` owns what a key MEANS; the framework's `Keymap`
// (`packages/core/src/keymap.ts:90`) owns MATCHING a combo and listing the
// registry for the help overlay. This module is the wire between them and
// nothing more: it iterates the table once, registers each bound combo, and
// passes the command's title as the `description` argument so `HelpPanel`
// lists the shortcuts that actually dispatch.
//
// It deliberately contains NO matcher. Writing `comboMatches` a second time
// here would be a second answer to "is this key that shortcut?", and the first
// one to disagree would be the one the user hits: the registry would fire one
// command while a hand-rolled match fired another.

import { type KeyEvent, type Keymap } from "@tern-tui/core";
import { COMMANDS, typedCharacter, type CommandId, type Intent } from "./commands.ts";

/**
 * What the keymap needs from the app: run one command against the live state.
 *
 * This is the whole interface on purpose. `HeadlessApp` satisfies it, and a
 * test double can too — neither the registry nor this module can reach a scene,
 * a renderer or a file, so registering shortcuts cannot smuggle IO into the
 * headless core.
 */
export interface CommandHost {
  /** Run `id` with `key` as the triggering event and return what it asked
   * for (`null` when the command had nothing to say in this context). */
  run(id: CommandId, key: KeyEvent): Intent | null;
}

/**
 * Register every bound command of {@link COMMANDS} into `keymap`.
 *
 * One registration per combo, so a command with both a plain and a shifted
 * binding (every motion: `down` and `shift+down`) gets two keymap entries
 * pointing at the same id — the app reads the event's `shift` flag to decide
 * whether the motion collapses or extends the selection, so the distinction
 * lives in the command, not in a duplicate id.
 *
 * Only the PLAIN combo carries a description. The shifted twin is the same
 * command, and a second overlay row per motion would double the help panel to
 * say nothing new — which is exactly what `register`'s optional description
 * is for (the framework skips undescribed entries, `keymap.ts:217`).
 *
 * Returns an unregister function that removes every registration this call
 * made; a later registration of the same combo by someone else is left alone
 * (the framework's own rule, `keymap.ts:114`).
 */
export function registerCommands(host: CommandHost, keymap: Keymap): () => void {
  const unregister: Array<() => void> = [];
  for (const command of COMMANDS) {
    const handler = (event: KeyEvent): void => {
      host.run(command.id, event);
    };
    if (command.key !== undefined) {
      unregister.push(keymap.register(command.key, handler, command.title));
    }
    if (command.shiftKey !== undefined) {
      unregister.push(keymap.register(command.shiftKey, handler));
    }
  }
  return () => {
    for (const off of unregister) off();
    unregister.length = 0;
  };
}

/**
 * Route one key event: the registered shortcut first, then — when nothing
 * claimed it — the character it types.
 *
 * The order is the contract. A combo that shares its key with a printable
 * character (`"?"` for help, say) is CLAIMED, so the shortcut wins and the
 * character never reaches the document; an unregistered key that types a
 * character runs `insert-char`; anything else is unhandled and returns `false`
 * so the host can let it fall through to its own focus routing.
 */
export function dispatchKey(host: CommandHost, keymap: Keymap, event: KeyEvent): boolean {
  if (keymap.dispatch(event)) return true;
  if (typedCharacter(event) === null) return false;
  host.run("insert-char", event);
  return true;
}
