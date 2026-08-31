import {
  renderer,
  render,
  insert,
  spread,
  createElement,
  createTextNode,
  insertNode,
  setProp,
  mergeProps,
  effect,
  memo,
  createComponent,
  use,
} from "./index.ts";

/**
 * Capture `console.warn` calls during a window; `restore()` puts the original
 * back. Declared first so each test installs a fresh spy.
 */
function captureWarns(): { warns: unknown[][]; restore: () => void } {
  const warns: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  return { warns, restore: () => (console.warn = original) };
}

/**
 * The deprecation contract for the `renderer` value export
 * (docs/api-lifecycle.md §1.5, value/object row): warn on first property
 * access, exactly once per process, then forward unchanged.
 *
 * Tests run sequentially in declaration order, so test 1 performs the first
 * property access on the proxied `renderer` in this process; the destructured
 * primitives read the raw instance (`rendererInstance`), so importing the
 * module never touches the proxy and never warns.
 */
Deno.test("deprecated renderer warns exactly once on first property access", () => {
  const { warns, restore } = captureWarns();
  try {
    void renderer.render;
    if (warns.length !== 1) {
      throw new Error(`expected exactly 1 warning on first access, got ${warns.length}`);
    }
    const first = warns[0];
    if (first === undefined) {
      throw new Error("expected a captured warning");
    }
    const message = String(first[0]);
    if (!message.startsWith("[tern]")) {
      throw new Error(`warning must carry the [tern] prefix: ${message}`);
    }
    if (!message.includes("renderer is deprecated")) {
      throw new Error(`warning must name the deprecated symbol: ${message}`);
    }
    if (!message.includes("0.4.0")) {
      throw new Error(`warning must carry the scheduled removal version: ${message}`);
    }
  } finally {
    restore();
  }
});

Deno.test("subsequent renderer accesses do not re-warn", () => {
  const { warns, restore } = captureWarns();
  try {
    void renderer.render;
    void renderer.insert;
    void renderer.spread;
    void renderer.createComponent;
    if (warns.length !== 0) {
      throw new Error(`expected no re-warning after the first access, got ${warns.length}`);
    }
  } finally {
    restore();
  }
});

Deno.test("deprecated renderer forwards the raw primitives by identity", () => {
  const pairs: [unknown, unknown][] = [
    [renderer.render, render],
    [renderer.insert, insert],
    [renderer.spread, spread],
    [renderer.createElement, createElement],
    [renderer.createTextNode, createTextNode],
    [renderer.insertNode, insertNode],
    [renderer.setProp, setProp],
    [renderer.mergeProps, mergeProps],
    [renderer.effect, effect],
    [renderer.memo, memo],
    [renderer.createComponent, createComponent],
    [renderer.use, use],
  ];
  for (const [proxied, primitive] of pairs) {
    if (proxied !== primitive) {
      throw new Error("deprecated renderer must forward the raw primitive by identity");
    }
  }
});

Deno.test("destructured primitives never warn", () => {
  const { warns, restore } = captureWarns();
  try {
    const primitives = [
      render,
      insert,
      spread,
      createElement,
      createTextNode,
      insertNode,
      setProp,
      mergeProps,
      effect,
      memo,
      createComponent,
      use,
    ];
    for (const fn of primitives) {
      if (typeof fn !== "function") {
        throw new Error("expected a renderer primitive function, got " + typeof fn);
      }
    }
    if (warns.length !== 0) {
      throw new Error(
        `primitives must never trigger the deprecation warning, got ${warns.length}`,
      );
    }
  } finally {
    restore();
  }
});
