//! Tests: useFocus with an onPaste handler registers paste routing.

import { assertActiveId, assertEvents } from "./testkit.ts";
import { pushEvent, state, withFakeAddon } from "./testkit.ts";
import { keyBase } from "./testkit.ts";
import { FocusManager, Input, KeyEvent, Keymap, Text, Textarea, TextareaProps, createRenderer, focusManager, keymap, name, pasteInto, pasteIntoTextarea, useFocus } from "./index.ts";


Deno.test("useFocus with an onPaste handler registers paste routing", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  const pasted: string[] = [];
  const handle = useFocus(
    "f",
    node,
    () => {},
    manager,
    (text) => pasted.push(text),
  );
  handle.focus();
  if (manager.routePaste("hi") !== true) {
    throw new Error("routed paste must be handled");
  }
  if (pasted.join(",") !== "hi") {
    throw new Error(`pasted = ${pasted.join(",")}`);
  }
  handle.dispose();
  if (manager.has("f")) throw new Error("dispose() must unregister the id");
  if (manager.routePaste("hi") !== false) {
    throw new Error("disposed handle must not route");
  }
});

Deno.test("routePaste round-trips IME-confirmed CJK into a focused Input (plain and pre-composed)", () => {
  // A pre-composed (NFC) IME-confirmed string: CJK ideographs, each a single
  // 2-column grapheme cluster. The paste lands verbatim at the caret and the
  // caret advances by the total display width (8 for 你好世界).
  const manager = new FocusManager();
  const input = Input({ value: "ab", caret: 1 });
  useFocus("in", input, () => {}, manager, (text) => pasteInto(input, text))
    .focus();
  if (manager.routePaste("你好世界") !== true) {
    throw new Error("a focused input must consume the paste");
  }
  if (input.props.value !== "a你好世界b") {
    throw new Error(
      `value = ${JSON.stringify(input.props.value)}, expected "a你好世界b"`,
    );
  }
  if (input.children[0]?.props.text !== "a你好世界b") {
    throw new Error(
      `leaf text = ${JSON.stringify(input.children[0]?.props.text)}`,
    );
  }
  if (input.props.caret !== 9 || input.children[0]?.props.caret !== 9) {
    throw new Error(
      `caret = ${input.props.caret}/${
        input.children[0]?.props.caret
      }, expected 9`,
    );
  }

  // A second composition confirms in a row and accumulates losslessly (an
  // IME emits one paste per confirmed composition). The value/caret are read
  // through functions so TS does not narrow their types to the literal of the
  // previous comparison (see the pasteCount pattern above).
  const readValue = () => input.props.value;
  const readCaret = () => input.props.caret;
  if (manager.routePaste("こんにちは") !== true) {
    throw new Error("a second paste must be consumed");
  }
  if (readValue() !== "a你好世界こんにちはb") {
    throw new Error(`accumulated value = ${JSON.stringify(readValue())}`);
  }
  if (readCaret() !== 19) {
    throw new Error(`accumulated caret = ${readCaret()}, expected 19`);
  }

  // A decomposed (NFD) form: Hangul jamo — decomposed 한글 is two LVT
  // grapheme clusters (4 display columns) — must round-trip verbatim.
  const jamoManager = new FocusManager();
  const jamo = Input({ value: "ab", caret: 1 });
  useFocus("jamo", jamo, () => {}, jamoManager, (text) => pasteInto(jamo, text))
    .focus();
  if (jamoManager.routePaste("한글") !== true) {
    throw new Error("a jamo paste must be consumed");
  }
  if (jamo.props.value !== "a한글b") {
    throw new Error(`jamo value = ${JSON.stringify(jamo.props.value)}`);
  }
  if (jamo.props.caret !== 5) {
    throw new Error(`jamo caret = ${jamo.props.caret}, expected 5`);
  }

  // A base-plus-combining NFD sequence (é = e + U+0301) is one 1-column
  // cluster and must survive the round-trip as the same code units.
  const combiningManager = new FocusManager();
  const combining = Input({ value: "ab", caret: 1 });
  useFocus(
    "comb",
    combining,
    () => {},
    combiningManager,
    (text) => pasteInto(combining, text),
  ).focus();
  if (combiningManager.routePaste("e\u{301}") !== true) {
    throw new Error("a combining paste must be consumed");
  }
  if (combining.props.value !== "ae\u{301}b") {
    throw new Error(
      `combining value = ${JSON.stringify(combining.props.value)}`,
    );
  }
  if (combining.props.caret !== 2) {
    throw new Error(`combining caret = ${combining.props.caret}, expected 2`);
  }

  // Cluster-safe insert: a caret column inside a wide glyph (col 1 of the
  // 2-column コ) snaps back to the cluster start — the paste lands before
  // the glyph, never mid-cluster.
  const snapManager = new FocusManager();
  const snap = Input({ value: "コab", caret: 1 });
  useFocus("snap", snap, () => {}, snapManager, (text) => pasteInto(snap, text))
    .focus();
  if (snapManager.routePaste("世") !== true) {
    throw new Error("a snap paste must be consumed");
  }
  if (snap.props.value !== "世コab") {
    throw new Error(
      `snap value = ${JSON.stringify(snap.props.value)}, expected "世コab"`,
    );
  }
  if (snap.props.caret !== 3) {
    throw new Error(`snap caret = ${snap.props.caret}, expected 3`);
  }
});

Deno.test("routePaste round-trips IME-confirmed CJK into a focused Textarea (plain and pre-composed)", () => {
  // A pre-composed (NFC) IME-confirmed string lands at the caret column; the
  // textarea caret column is a code-unit index, so it advances by the pasted
  // code units (4 for 你好世界).
  const manager = new FocusManager();
  const ta = Textarea({ lines: ["ab", "cd"], row: 1, col: 1 });
  useFocus("ta", ta, () => {}, manager, (text) => pasteIntoTextarea(ta, text))
    .focus();
  if (manager.routePaste("你好世界") !== true) {
    throw new Error("a focused textarea must consume the paste");
  }
  if ((ta.props as TextareaProps).lines?.join(",") !== "ab,c你好世界d") {
    throw new Error(`lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if (
    (ta.props as TextareaProps).row !== 1 ||
    (ta.props as TextareaProps).col !== 5
  ) {
    throw new Error(
      `row/col = ${(ta.props as TextareaProps).row}/${
        (ta.props as TextareaProps).col
      }, expected 1/5`,
    );
  }
  if (ta.children[1]?.props.text !== "c你好世界d") {
    throw new Error(`leaf = ${JSON.stringify(ta.children[1]?.props.text)}`);
  }

  // A second composition accumulates losslessly on the same line.
  if (manager.routePaste("안녕하세요") !== true) {
    throw new Error("a second textarea paste must be consumed");
  }
  if (
    (ta.props as TextareaProps).lines?.join(",") !== "ab,c你好世界안녕하세요d"
  ) {
    throw new Error(`accumulated lines = ${JSON.stringify(ta.props.lines)}`);
  }
  if ((ta.props as TextareaProps).col !== 10) {
    throw new Error(`accumulated col = ${(ta.props as TextareaProps).col}`);
  }

  // A multi-line CJK paste: the pasted \n splits into new logical lines with
  // the post-caret tail joining the last segment.
  const multiManager = new FocusManager();
  const multi = Textarea({ lines: ["你好"], row: 0, col: 2 });
  useFocus(
    "multi",
    multi,
    () => {},
    multiManager,
    (text) => pasteIntoTextarea(multi, text),
  ).focus();
  if (multiManager.routePaste("世\n界") !== true) {
    throw new Error("a multi-line paste must be consumed");
  }
  if ((multi.props as TextareaProps).lines?.join(",") !== "你好世,界") {
    throw new Error(`multi lines = ${JSON.stringify(multi.props.lines)}`);
  }
  if (
    (multi.props as TextareaProps).row !== 1 ||
    (multi.props as TextareaProps).col !== 1
  ) {
    throw new Error(
      `multi row/col = ${(multi.props as TextareaProps).row}/${
        (multi.props as TextareaProps).col
      }, expected 1/1`,
    );
  }
  if (multi.children[1]?.props.text !== "界") {
    throw new Error(
      `multi leaf = ${JSON.stringify(multi.children[1]?.props.text)}`,
    );
  }

  // A decomposed (NFD) Hangul jamo paste inserts verbatim; the caret column
  // advances by code units (3 for 한).
  const jamoManager = new FocusManager();
  const jamo = Textarea({ lines: ["ab"], row: 0, col: 1 });
  useFocus(
    "jamo",
    jamo,
    () => {},
    jamoManager,
    (text) => pasteIntoTextarea(jamo, text),
  ).focus();
  if (jamoManager.routePaste("한") !== true) {
    throw new Error("a jamo textarea paste must be consumed");
  }
  if ((jamo.props as TextareaProps).lines?.join(",") !== "a한b") {
    throw new Error(`jamo lines = ${JSON.stringify(jamo.props.lines)}`);
  }
  if ((jamo.props as TextareaProps).col !== 4) {
    throw new Error(
      `jamo col = ${(jamo.props as TextareaProps).col}, expected 4`,
    );
  }

  // Cluster-safe insert: a mid-cluster caret column (col 3 inside the
  // 3-code-unit 한 cluster) snaps to the cluster end before the paste.
  const snapManager = new FocusManager();
  const snap = Textarea({ lines: ["a한b"], row: 0, col: 3 });
  useFocus(
    "snap",
    snap,
    () => {},
    snapManager,
    (text) => pasteIntoTextarea(snap, text),
  ).focus();
  if (snapManager.routePaste("文") !== true) {
    throw new Error("a snap textarea paste must be consumed");
  }
  if ((snap.props as TextareaProps).lines?.join(",") !== "a한文b") {
    throw new Error(`snap lines = ${JSON.stringify(snap.props.lines)}`);
  }
  if ((snap.props as TextareaProps).col !== 5) {
    throw new Error(
      `snap col = ${(snap.props as TextareaProps).col}, expected 5`,
    );
  }
});

Deno.test("unregister clears the active focus and stops dispatch", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const unsub = manager.register({ id: "x", node, onKey: () => hits++ });
  manager.focus("x");
  if (manager.active?.node !== node) {
    throw new Error("active entry must expose the node");
  }
  unsub();
  if (manager.activeId !== null) {
    throw new Error("active must clear on unregister");
  }
  if (manager.has("x")) throw new Error("entry must be gone after unregister");
  const key: KeyEvent = {
    name: "char",
    char: "q",
    ctrl: false,
    alt: false,
    shift: false,
  };
  if (manager.routeKey(key) !== false) {
    throw new Error("unregistered id must not route");
  }
  if (hits !== 0) throw new Error("no dispatch after unregister");
});

Deno.test("useFocus registers, focuses and disposes through the manager", () => {
  const manager = new FocusManager();
  const node = Text({ text: "x" });
  let hits = 0;
  const handle = useFocus("f", node, () => hits++, manager);
  if (!manager.has("f")) throw new Error("useFocus must register the id");
  handle.focus();
  if (!handle.isFocused()) throw new Error("focus() must make the id active");
  const key: KeyEvent = {
    name: "char",
    char: "q",
    ctrl: false,
    alt: false,
    shift: false,
  };
  if (manager.routeKey(key) !== true) {
    throw new Error("routed key must be handled");
  }
  if (hits !== 1) {
    throw new Error(`routed through the handle's handler = ${hits}`);
  }
  handle.blur();
  if (handle.isFocused()) throw new Error("blur() must clear the active focus");
  handle.dispose();
  if (manager.has("f")) throw new Error("dispose() must unregister the id");
});

Deno.test("the default focus manager is a FocusManager instance", () => {
  if (!(focusManager instanceof FocusManager)) {
    throw new Error("default focus manager must be a FocusManager");
  }
});

Deno.test("FocusManager next/prev/focusFirst traverse registration order with wrap-around", () => {
  const manager = new FocusManager();
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.register({ id: "c", node: Text({ text: "c" }), onKey: () => {} });
  // With nothing focused, next()/prev() start at the first element.
  if (manager.next() !== true) {
    throw new Error("next() with no active must focus the first");
  }
  assertActiveId(manager, "a", "next() start");
  if (manager.next() !== true) throw new Error("next() must move forward");
  assertActiveId(manager, "b", "next() forward");
  if (manager.next() !== true) throw new Error("next() must reach the last");
  assertActiveId(manager, "c", "next() last");
  if (manager.next() !== true) throw new Error("next() must wrap to the first");
  assertActiveId(manager, "a", "next() wrap");
  if (manager.prev() !== true) throw new Error("prev() must wrap to the last");
  assertActiveId(manager, "c", "prev() wrap");
  if (manager.prev() !== true) throw new Error("prev() must move backward");
  assertActiveId(manager, "b", "prev() backward");
  if (manager.prev() !== true) throw new Error("prev() must reach the first");
  assertActiveId(manager, "a", "prev() first");
  if (manager.focusFirst() !== true) {
    throw new Error("focusFirst() must succeed");
  }
  assertActiveId(manager, "a", "focusFirst()");
  // A single-element manager: next/prev stay on the only element.
  const single = new FocusManager();
  single.register({ id: "only", node: Text({ text: "x" }), onKey: () => {} });
  if (single.next() !== true) throw new Error("single next() must succeed");
  assertActiveId(single, "only", "single next()");
  if (single.prev() !== true) throw new Error("single prev() must succeed");
  assertActiveId(single, "only", "single prev()");
  // An empty manager: traversal is a no-op that reports failure.
  const empty = new FocusManager();
  if (empty.next() !== false) {
    throw new Error("next() on empty manager must fail");
  }
  if (empty.prev() !== false) {
    throw new Error("prev() on empty manager must fail");
  }
  if (empty.focusFirst() !== false) {
    throw new Error("focusFirst() on empty manager must fail");
  }
});

Deno.test("FocusManager subscribe fires exactly once per focus/blur/unregister change", () => {
  const manager = new FocusManager();
  const events: Array<string | null> = [];
  const unsub = manager.subscribe((id) => events.push(id));
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.register({ id: "b", node: Text({ text: "b" }), onKey: () => {} });
  manager.focus("a");
  manager.focus("b");
  manager.blur();
  assertEvents(events, ["a", "b", null], "focus/blur");
  // Unregistering the active id also reports the cleared focus.
  manager.focus("a");
  manager.unregister("a");
  assertEvents(events, ["a", "b", null, "a", null], "unregister of active id");
  // Unsubscribing stops delivery.
  unsub();
  manager.focus("b");
  assertEvents(events, ["a", "b", null, "a", null], "after unsubscribe");
});

Deno.test("FocusManager focusIdFor maps nodes to registered ids and clears on unregister", () => {
  const manager = new FocusManager();
  const aNode = Text({ text: "a" });
  const bNode = Text({ text: "b" });
  if (manager.focusIdFor(aNode) !== null) {
    throw new Error("unregistered node must map to null");
  }
  manager.register({ id: "a", node: aNode, onKey: () => {} });
  manager.register({ id: "b", node: bNode, onKey: () => {} });
  if (manager.focusIdFor(aNode) !== "a") {
    throw new Error("focusIdFor(aNode) must be 'a'");
  }
  if (manager.focusIdFor(bNode) !== "b") {
    throw new Error("focusIdFor(bNode) must be 'b'");
  }
  if (manager.focusIdFor(Text({ text: "other" })) !== null) {
    throw new Error("foreign node must map to null");
  }
  manager.unregister("a");
  if (manager.focusIdFor(aNode) !== null) {
    throw new Error("focusIdFor must be null after unregister");
  }
  if (manager.focusIdFor(bNode) !== "b") {
    throw new Error("other mapping must survive");
  }
  // Re-registering the same node under a new id updates the mapping.
  manager.register({ id: "a2", node: aNode, onKey: () => {} });
  if (manager.focusIdFor(aNode) !== "a2") {
    throw new Error("re-registered node must map to the new id");
  }
});

Deno.test("FocusManager focus/blur are idempotent and notify only on change", () => {
  const manager = new FocusManager();
  const events: Array<string | null> = [];
  manager.subscribe((id) => events.push(id));
  manager.register({ id: "a", node: Text({ text: "a" }), onKey: () => {} });
  manager.focus("a");
  assertActiveId(manager, "a", "focus(a)");
  // Re-focusing the active id is a no-op: state and notifications unchanged.
  manager.focus("a");
  assertActiveId(manager, "a", "idempotent focus");
  manager.blur();
  assertActiveId(manager, null, "blur");
  // Blurring when already blurred is a no-op.
  manager.blur();
  assertActiveId(manager, null, "idempotent blur");
  // Focusing an unregistered id fails without disturbing state.
  if (manager.focus("missing") !== false) {
    throw new Error("focus on unregistered id must fail");
  }
  assertActiveId(manager, null, "failed focus");
  assertEvents(events, ["a", null], "idempotent notifications");
});

Deno.test("Keymap matches combos by name and exact modifiers", () => {
  const km = new Keymap();
  const hits: Array<{ combo: string; event: KeyEvent }> = [];
  const unsub = km.register({ name: "k", ctrl: true }, (event) => {
    hits.push({ combo: "ctrl+k", event });
  });
  // A printable combo matches a "char" event by character.
  const ctrlK: KeyEvent = {
    name: "char",
    char: "k",
    ctrl: true,
    alt: false,
    shift: false,
  };
  if (km.dispatch(ctrlK) !== true) throw new Error("ctrl+k must dispatch");
  if (hits.length !== 1 || hits[0]?.combo !== "ctrl+k") {
    throw new Error(`ctrl+k hits = ${hits.length}`);
  }
  if (hits[0]?.event !== ctrlK) {
    throw new Error("handler must receive the event verbatim");
  }
  // Plain k (ctrl released) must not match.
  if (km.dispatch({ ...keyBase, name: "char", char: "k" }) !== false) {
    throw new Error("plain k must not dispatch ctrl+k");
  }
  // ctrl+shift+k must not match (shift must be released — exact modifiers).
  if (
    km.dispatch({
      name: "char",
      char: "k",
      ctrl: true,
      alt: false,
      shift: true,
    }) !== false
  ) {
    throw new Error("ctrl+shift+k must not dispatch ctrl+k");
  }
  // A named (non-char) key never matches a different combo's name.
  if (km.dispatch({ ...keyBase, name: "enter" }) !== false) {
    throw new Error("enter must not dispatch ctrl+k");
  }
  if (hits.length !== 1) {
    throw new Error(`non-matching keys must not fire (${hits.length})`);
  }
  // Unsubscribing removes the registration.
  unsub();
  if (km.dispatch(ctrlK) !== false) {
    throw new Error("unregistered ctrl+k must not dispatch");
  }
});

Deno.test("Keymap matches named keys, super/meta flags, and replaces on re-register", () => {
  const km = new Keymap();
  // Reads through functions: TS narrows a let captured in a closure to the
  // last checked literal, which would flag the follow-up comparisons as
  // unintentional (the same discipline as the `pasteCount` helper).
  let enterHits = 0;
  const enterCount = () => enterHits;
  km.register({ name: "enter" }, () => enterHits++);
  if (km.dispatch({ ...keyBase, name: "enter" }) !== true) {
    throw new Error("enter must dispatch");
  }
  if (
    km.dispatch({ name: "enter", ctrl: true, alt: false, shift: false }) !==
      false
  ) {
    throw new Error("ctrl+enter must not dispatch enter");
  }
  if (enterCount() !== 1) throw new Error(`enter hits = ${enterCount()}`);
  // super / meta flags are matched exactly.
  let superHits = 0;
  const superCount = () => superHits;
  km.register({ name: "s", super: true }, () => superHits++);
  if (
    km.dispatch({ ...keyBase, name: "char", char: "s", super: true }) !== true
  ) {
    throw new Error("super+s must dispatch");
  }
  if (km.dispatch({ ...keyBase, name: "char", char: "s" }) !== false) {
    throw new Error("plain s must not dispatch super+s");
  }
  if (superCount() !== 1) throw new Error(`super hits = ${superCount()}`);
  // Re-registering the same combo replaces the earlier handler; the old
  // unsubscribe must not clobber the replacement.
  const replaced = km.register({ name: "enter" }, () => enterHits += 10);
  if (km.dispatch({ ...keyBase, name: "enter" }) !== true) {
    throw new Error("enter (replaced) must dispatch");
  }
  if (enterCount() !== 11) {
    throw new Error(`replaced enter hits = ${enterCount()}`);
  }
  replaced();
  if (km.dispatch({ ...keyBase, name: "enter" }) !== false) {
    throw new Error("enter must be removed");
  }
});

Deno.test("Keymap ctrl+k fires ahead of focus routing; unclaimed keys reach the focused element", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.startEventStream();
    const manager = new FocusManager();
    // Reads through functions: the counters are mutated inside event
    // handlers, so direct comparisons would be flagged by TS narrowing.
    let shortcutHits = 0;
    let elementAHits = 0;
    let elementBHits = 0;
    let treeHits = 0;
    const shortcutCount = () => shortcutHits;
    const elementACount = () => elementAHits;
    const elementBCount = () => elementBHits;
    const treeCount = () => treeHits;
    const unregister = keymap.register(
      { name: "k", ctrl: true },
      () => shortcutHits++,
    );
    // The wiring useInput / subscribeInput build: each key routes through
    // the manager; only unclaimed keys reach the tree-level handler.
    renderer.onKey((event) => {
      if (manager.routeKey(event)) return;
      treeHits++;
    });
    const ctrlK: KeyEvent = {
      name: "char",
      char: "k",
      ctrl: true,
      alt: false,
      shift: false,
    };
    const plainA: KeyEvent = {
      name: "char",
      char: "a",
      ctrl: false,
      alt: false,
      shift: false,
    };
    try {
      // Nothing focused: the registered combo still fires.
      pushEvent({ type: "key", key: ctrlK });
      if (shortcutCount() !== 1 || treeCount() !== 0) {
        throw new Error(
          `unfocused ctrl+k: shortcut = ${shortcutCount()}, tree = ${treeCount()}`,
        );
      }
      // An unclaimed key with nothing focused falls through to the tree.
      pushEvent({ type: "key", key: plainA });
      if (treeCount() !== 1) {
        throw new Error(`unfocused plain a: tree = ${treeCount()}`);
      }
      // Focus on a registered element: ctrl+k still fires the shortcut and is
      // NOT delivered to the focused element's handler.
      manager.register({
        id: "a",
        node: Text({ text: "a" }),
        onKey: () => elementAHits++,
      });
      manager.register({
        id: "b",
        node: Text({ text: "b" }),
        onKey: () => elementBHits++,
      });
      if (manager.focus("a") !== true) throw new Error("focus(a) must succeed");
      pushEvent({ type: "key", key: ctrlK });
      if (shortcutCount() !== 2 || elementACount() !== 0) {
        throw new Error(
          `focused ctrl+k: shortcut = ${shortcutCount()}, element a = ${elementACount()}`,
        );
      }
      // An unclaimed key reaches the focused element's handler (not swallowed
      // by the keymap, and the tree handler stays skipped).
      pushEvent({ type: "key", key: plainA });
      if (elementACount() !== 1 || treeCount() !== 1) {
        throw new Error(
          `focused plain a: element a = ${elementACount()}, tree = ${treeCount()}`,
        );
      }
      // Any registered element: focus b and ctrl+k still fires the shortcut.
      if (manager.focus("b") !== true) throw new Error("focus(b) must succeed");
      pushEvent({ type: "key", key: ctrlK });
      if (shortcutCount() !== 3 || elementBCount() !== 0) {
        throw new Error(
          `focused-b ctrl+k: shortcut = ${shortcutCount()}, element b = ${elementBCount()}`,
        );
      }
    } finally {
      unregister();
    }
  });
});

Deno.test("Keymap list() returns registered combos in registration order", () => {
  const km = new Keymap();
  km.register({ name: "k", ctrl: true }, () => {}, "Copy selection");
  km.register({ name: "enter" }, () => {});
  km.register({ name: "f1" }, () => {}, "Help");
  const listed = km.list();
  if (listed.length !== 3) throw new Error(`listed = ${listed.length}`);
  // Registration order is stable; descriptions surface only when supplied.
  const first = listed[0]!;
  if (first.combo.name !== "k" || first.combo.ctrl !== true) {
    throw new Error(`first combo = ${JSON.stringify(first.combo)}`);
  }
  if (first.description !== "Copy selection") {
    throw new Error(`first description = ${JSON.stringify(first.description)}`);
  }
  const second = listed[1]!;
  if (second.combo.name !== "enter" || second.combo.ctrl !== undefined) {
    throw new Error(`second combo = ${JSON.stringify(second.combo)}`);
  }
  if (second.description !== undefined) {
    throw new Error(
      `second description = ${JSON.stringify(second.description)}`,
    );
  }
  const third = listed[2]!;
  if (third.combo.name !== "f1" || third.description !== "Help") {
    throw new Error(`third = ${JSON.stringify(third)}`);
  }
  // Re-registering a combo replaces its description but keeps its position.
  km.register({ name: "k", ctrl: true }, () => {}, "Copy (replaced)");
  const afterReplace = km.list();
  if (afterReplace.length !== 3) {
    throw new Error(`after replace = ${afterReplace.length}`);
  }
  if (
    afterReplace[0]!.combo.name !== "k" ||
    afterReplace[0]!.description !== "Copy (replaced)"
  ) {
    throw new Error(`replaced entry = ${JSON.stringify(afterReplace[0])}`);
  }
  if (afterReplace[1]!.combo.name !== "enter") {
    throw new Error("replacement must keep position");
  }
  // Unsubscribing removes the registration from the listing.
  const unsub = km.register({ name: "escape" }, () => {});
  unsub();
  if (km.list().length !== 3) {
    throw new Error(`after unsub = ${km.list().length}`);
  }
  // list() returns fresh copies: mutating them never affects the keymap.
  const copies = km.list();
  copies[0]!.combo.name = "mutated";
  copies[1] = { combo: { name: "injected" } };
  const untouched = km.list();
  if (untouched[0]!.combo.name !== "k") {
    throw new Error(`copy mutation leaked = ${untouched[0]!.combo.name}`);
  }
  if (untouched.length !== 3 || untouched[1]!.combo.name !== "enter") {
    throw new Error(`injected entry leaked = ${JSON.stringify(untouched)}`);
  }
});
