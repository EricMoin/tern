/**
 * Deprecation helpers implementing the warn-once runtime mechanism for
 * @tern-tui/solid's deprecation lifecycle (the "value / object exports" row of
 * docs/api-lifecycle.md §1.5).
 *
 * @internal
 * Not part of the public surface: `index.ts` imports this module but nothing
 * here is re-exported, so the 170-symbol public count is unchanged.
 */

/**
 * Warn-once registry — at most one `console.warn` per key per process
 * (module-level flag, per docs/api-lifecycle.md §1.5 shared semantics).
 */
const warned = new Set<string>();

/**
 * Emit a deprecation warning at most once per process for `key`.
 *
 * `message` is the full warning text, already carrying the `[tern]` prefix and
 * the scheduled removal version. Never throws; never fires in the hot path
 * beyond a Set lookup — a TUI frame loop that touches a deprecated value must
 * not spam the terminal.
 *
 * @internal
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Wrap a deprecated value/object export in a warn-once Proxy: the first
 * property access warns, every subsequent read forwards to the raw value
 * unchanged.
 *
 * Implements the "value / object exports" row of docs/api-lifecycle.md §1.5:
 * importing the module never warns (no property is touched at import time);
 * only actually reading a property on the deprecated value does. The proxy is
 * transparent — `get` is the only trap, so identity, keys, and all other
 * operations forward to the raw value, keeping the deprecated export fully
 * functional and signature-identical for the entire warn phase.
 *
 * @internal
 */
export function deprecatedValue<T extends object>(
  value: T,
  key: string,
  message: string,
): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      warnOnce(key, message);
      return Reflect.get(target, prop, receiver);
    },
  });
}
