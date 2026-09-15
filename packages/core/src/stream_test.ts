//! Tests: StreamingText defaults to following the tail (scroll_y = con.

import { state, withFakeAddon } from "./testkit.ts";
import { assertSelection, makeScrollable, withScrollFakeAddon } from "./testkit.ts";
import { mouse } from "./testkit.ts";
import { Box, FocusManager, Node, SELECTION_DOUBLE_CLICK_MS, STREAM_AFFORDANCE_CHAR, ScrollView, StreamingText, Table, Text, copySelection, createRenderer, dragSelection, endSelection, focusAt, focusManager, followTail, isStreamFollowing, scrollBy, scrollTo, scrollToBottom, scrollTop, setSelectionClockForTesting, startSelection, syncStreamTail, useFocus, wheelScroll } from "./index.ts";


Deno.test("StreamingText defaults to following the tail (scroll_y = content height - clip height)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    if (!isStreamFollowing(node)) {
      throw new Error("autoScroll must default to following");
    }
    // A fresh read per assertion — TS property-access narrowing would
    // otherwise reject a later comparison against a different literal.
    const y = (): number => node.props.scroll_y as number;
    // 3 newline-terminated spans -> content 4 rows -> tail 4 - 2 = 2.
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);
    if (node.props.scroll_x !== undefined) {
      throw new Error(`scroll_x must stay unset, got ${node.props.scroll_x}`);
    }
    // The tail keeps moving as the stream grows (5 rows -> tail 3).
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 3) throw new Error(`scroll_y after 4 spans = ${y()}`);
    // The autoScroll key is consumed — never a scene prop.
    if ("autoScroll" in node.props) {
      throw new Error(
        `autoScroll leaked into props: ${JSON.stringify(node.props)}`,
      );
    }
  });
});

Deno.test("StreamingText with autoScroll: false never follows the tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({
      autoScroll: false,
      clip_height: 2,
      width: 10,
    });
    if ("autoScroll" in node.props) {
      throw new Error(
        `autoScroll leaked into props: ${JSON.stringify(node.props)}`,
      );
    }
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (isStreamFollowing(node)) {
      throw new Error("autoScroll: false must not follow");
    }
    if (node.props.scroll_y !== undefined) {
      throw new Error(`scroll_y must stay unset, got ${node.props.scroll_y}`);
    }
  });
});

Deno.test("a manual scroll above the tail detaches the follow and pins the view", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    // A fresh read per assertion (see the tail-follow test).
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    if (y() !== 2) throw new Error(`tail scroll_y = ${y()}`);

    // Scroll up above the tail: the follow detaches and the view pins.
    const applied = scrollTo(node, 0, 0);
    if (applied.x !== 0 || applied.y !== 0) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    if (isStreamFollowing(node)) {
      throw new Error("a scroll above the tail must detach the follow");
    }

    // The stream keeps growing, but the view stays pinned at row 0.
    node.appendSpan("d\n");
    syncStreamTail(node);
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // scrollBy / scrollTop funnel through scrollTo and detach the same way.
    const by = scrollBy(node, 0, 1);
    if (by.y !== 1) throw new Error(`scrollBy applied = ${JSON.stringify(by)}`);
    const top = scrollTop(node);
    if (top.y !== 0) {
      throw new Error(`scrollTop applied = ${JSON.stringify(top)}`);
    }
    if (isStreamFollowing(node)) {
      throw new Error("scrollBy/scrollTop above the tail must detach");
    }
  });
});

Deno.test("followTail re-attaches and snaps back to the growing tail", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    scrollTo(node, 0, 0); // detach (pinned at row 0)
    node.appendSpan("d\n"); // 5 rows now; sync is a no-op while detached

    // Re-attach: followTail snaps straight to the current tail (5 - 2 = 3).
    followTail(node);
    if (!isStreamFollowing(node)) {
      throw new Error("followTail must re-attach the follow");
    }
    if (y() !== 3) throw new Error(`snap scroll_y = ${y()}`);

    // And follows subsequent growth again (6 rows -> tail 4).
    node.appendSpan("e\n");
    syncStreamTail(node);
    if (y() !== 4) throw new Error(`follow scroll_y = ${y()}`);

    // A scroll to the tail keeps the follow attached (no detach).
    scrollTo(node, 0, 4);
    if (!isStreamFollowing(node)) {
      throw new Error("scrolling to the tail must keep the follow");
    }
  });
});

Deno.test("followTail on a plain streaming node enables auto-scroll from scratch", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    // Built through the raw Node factory — no follow state registered.
    const node = Node.create("streaming_text", { clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    node.appendSpan("a\n");
    node.appendSpan("b\n");
    node.appendSpan("c\n");
    syncStreamTail(node);
    if (isStreamFollowing(node)) {
      throw new Error("a raw node must not follow by default");
    }
    if (node.props.scroll_y !== undefined) {
      throw new Error(
        `raw node scroll_y must stay unset, got ${node.props.scroll_y}`,
      );
    }
    followTail(node);
    if (!isStreamFollowing(node)) {
      throw new Error("followTail must enable a raw node's follow");
    }
    // 4 rows - clip 2 = tail 2.
    if (node.props.scroll_y !== 2) {
      throw new Error(`raw snap scroll_y = ${node.props.scroll_y}`);
    }
  });
});

Deno.test("a manual scroll above the tail stamps the scroll-to-bottom affordance (dismissed by followTail)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // Fresh reads per assertion — TS property-access narrowing would otherwise
    // reject later comparisons against a different literal (see above).
    const count = (): number => node.children.length;
    // While following the tail there is no affordance (no children).
    if (count() !== 0) throw new Error(`following children = ${count()}`);

    // Scrolling above the tail detaches the follow and stamps the affordance
    // at the clip region's bottom-right: a 1x1 text cell with the ▼ char,
    // absolutely positioned, right-aligned, at the bottom row of the 2-row
    // viewport (top = clip 2 - 1 + scroll 0), above in-flow content.
    scrollTo(node, 0, 0);
    if (isStreamFollowing(node)) {
      throw new Error("a scroll above the tail must detach the follow");
    }
    if (count() !== 1) throw new Error(`affordance children = ${count()}`);
    const leaf = node.children[0]!;
    if (leaf.type !== "text") throw new Error(`affordance type = ${leaf.type}`);
    if (leaf.props.text !== STREAM_AFFORDANCE_CHAR) {
      throw new Error(`affordance text = ${JSON.stringify(leaf.props.text)}`);
    }
    if (leaf.props.position !== "absolute" || leaf.props.right !== 0) {
      throw new Error(`affordance position = ${JSON.stringify(leaf.props)}`);
    }
    if (leaf.props.width !== 1 || leaf.props.height !== 1) {
      throw new Error(`affordance size = ${JSON.stringify(leaf.props)}`);
    }
    if (leaf.props.z_index !== 2) {
      throw new Error(`affordance z_index = ${leaf.props.z_index}`);
    }
    const top = (): number => leaf.props.top as number;
    if (top() !== 1) throw new Error(`affordance top = ${top()}`);

    // The cell stays fixed at the viewport's bottom row as the content
    // scrolls: the `top` inset is scroll-compensated (clip 2 - 1 + scroll 1).
    scrollTo(node, 0, 1);
    if (top() !== 2) throw new Error(`compensated top = ${top()}`);

    // Further scrolls while detached keep a single affordance leaf (no dup).
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`re-scroll children = ${count()}`);

    // followTail re-attaches, snaps back to the tail, and dismisses the
    // affordance.
    followTail(node);
    if (!isStreamFollowing(node)) {
      throw new Error("followTail must re-attach the follow");
    }
    if (count() !== 0) {
      throw new Error(`affordance after followTail = ${count()}`);
    }
    if (node.props.scroll_y !== 2) {
      throw new Error(`snap scroll_y = ${node.props.scroll_y}`);
    }
  });
});

Deno.test("scrollToBottom jumps to the tail and dismisses the affordance (without re-attaching)", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({ clip_height: 2, width: 10 });
    renderer.root.addChild(node);
    const y = (): number => node.props.scroll_y as number;
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // Fresh read per assertion (see the tail-follow tests above).
    const count = (): number => node.children.length;
    // Detach (stamps the affordance), then the stream grows while detached.
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`affordance children = ${count()}`);
    node.appendSpan("d\n"); // 5 rows now; sync is a no-op while detached
    syncStreamTail(node);
    if (y() !== 0) throw new Error(`pinned scroll_y = ${y()}`);

    // scrollToBottom: a one-shot jump to the current tail (5 - 2 = 3) and
    // the affordance is dismissed; the follow stays detached.
    const applied = scrollToBottom(node);
    if (applied.x !== 0 || applied.y !== 3) {
      throw new Error(`applied = ${JSON.stringify(applied)}`);
    }
    if (y() !== 3) throw new Error(`scrollToBottom scroll_y = ${y()}`);
    if (count() !== 0) {
      throw new Error(`affordance after scrollToBottom = ${count()}`);
    }
    if (isStreamFollowing(node)) {
      throw new Error("scrollToBottom must not re-attach the follow");
    }

    // Growth after the one-shot jump does not pin the view (still detached).
    node.appendSpan("e\n"); // 6 rows now; the view stays at the old tail
    syncStreamTail(node);
    if (y() !== 3) throw new Error(`post-jump scroll_y = ${y()}`);

    // The next scroll above the tail re-stamps the affordance.
    scrollTo(node, 0, 0);
    if (count() !== 1) throw new Error(`re-show children = ${count()}`);
    if (y() !== 0) throw new Error(`re-scroll scroll_y = ${y()}`);
  });
});

Deno.test("autoScroll: false nodes never stamp the affordance on a manual scroll", () => {
  withScrollFakeAddon(() => {
    const renderer = createRenderer();
    const node = StreamingText({
      autoScroll: false,
      clip_height: 2,
      width: 10,
    });
    renderer.root.addChild(node);
    for (const t of ["a\n", "b\n", "c\n"]) {
      node.appendSpan(t);
      syncStreamTail(node);
    }
    // A manual scroll above the tail never follows, so there is no follow to
    // detach and no affordance to show.
    scrollTo(node, 0, 0);
    if (node.children.length !== 0) {
      throw new Error(`children = ${node.children.length}`);
    }
    if (isStreamFollowing(node)) {
      throw new Error("autoScroll: false must stay detached");
    }
  });
});

Deno.test("wheelScroll maps wheel directions onto the scroll offsets (consumed)", () => {
  withFakeAddon(() => {
    const { view } = makeScrollable();
    const y = (): number => view.props.scroll_y as number;
    const x = (): number => view.props.scroll_x as number;

    // scroll_down pans the content down (scroll_y + 1).
    if (wheelScroll(view, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("scroll_down on a scrollable node must be consumed");
    }
    if (y() !== 1) throw new Error(`scroll_down scroll_y = ${y()}`);
    // scroll_up pans the content back up (scroll_y - 1).
    if (wheelScroll(view, mouse("scroll_up", 0, 0)) !== true) {
      throw new Error("scroll_up on a scrollable node must be consumed");
    }
    if (y() !== 0) throw new Error(`scroll_up scroll_y = ${y()}`);
    // scroll_right pans the columns (scroll_x + 1).
    if (wheelScroll(view, mouse("scroll_right", 0, 0)) !== true) {
      throw new Error("scroll_right on a scrollable node must be consumed");
    }
    if (x() !== 1) throw new Error(`scroll_right scroll_x = ${x()}`);
    // scroll_left pans the columns back (scroll_x - 1).
    if (wheelScroll(view, mouse("scroll_left", 0, 0)) !== true) {
      throw new Error("scroll_left on a scrollable node must be consumed");
    }
    if (x() !== 0) throw new Error(`scroll_left scroll_x = ${x()}`);
  });
});

Deno.test("wheelScroll clamps at the content bounds but stays consumed", () => {
  withFakeAddon(() => {
    const { view } = makeScrollable();
    // maxScroll.y = content 3 - viewport 2 = 1: two downs clamp at 1.
    wheelScroll(view, mouse("scroll_down", 0, 0));
    wheelScroll(view, mouse("scroll_down", 0, 0));
    if (view.props.scroll_y !== 1) {
      throw new Error(`clamped scroll_y = ${view.props.scroll_y}`);
    }
    // A wheel at the bound is still consumed — it did not fall through.
    if (wheelScroll(view, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel event at the scroll bound must stay consumed");
    }
    if (view.props.scroll_y !== 1) {
      throw new Error(`post-clamp scroll_y = ${view.props.scroll_y}`);
    }
  });
});

Deno.test("wheelScroll no-ops on non-scrollable nodes, detached views and non-wheel events", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const plain = Box();
    renderer.root.addChild(plain);
    if (wheelScroll(plain, mouse("scroll_down", 0, 0)) !== false) {
      throw new Error("a plain box must not consume a wheel event");
    }
    const detached = ScrollView(
      { width: 5, height: 2 },
      Text({ text: "aaaa\nbbbb\ncc" }),
    );
    if (wheelScroll(detached, mouse("scroll_down", 0, 0)) !== false) {
      throw new Error("a detached view must not consume a wheel event");
    }
    const { view } = makeScrollable();
    if (wheelScroll(view, mouse("down_left", 0, 0)) !== false) {
      throw new Error(
        "a down_left is not a wheel event and must not be consumed",
      );
    }
  });
});

Deno.test("wheelScroll on a table scrolls its content region (sticky header pinned)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const table = Table({
      columns: [{ key: "a", header: "A", width: 4 }],
      rows: [["1"], ["2"], ["3"], ["4"]],
      clip_height: 3,
    });
    renderer.root.addChild(table);
    // The region's viewport is its clip_height (3). The content region is
    // windowed — only the visible rows are materialized — so the scroll clamp
    // measures the JS-known full content height (4 rows): maxScroll.y =
    // 4 - 3 = 1.
    const region = table.children[1]!;
    if (region.children.length !== 3) {
      throw new Error(`windowed rows = ${region.children.length}`);
    }

    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error("a wheel event on a table must be consumed");
    }
    // Read through a function: TS control-flow narrowing would otherwise pin
    // the prop to the literal of the first assertion.
    const regionY = (): number => region.props.scroll_y as number;
    if (regionY() !== 1) throw new Error(`region scroll_y = ${regionY()}`);
    if (table.props.scroll_y !== undefined) {
      throw new Error(
        "the table root must not scroll (the sticky header stays pinned)",
      );
    }
    // A second wheel clamps at the full-content bound (max 1) and stays
    // consumed.
    if (wheelScroll(table, mouse("scroll_down", 0, 0)) !== true) {
      throw new Error(
        "a wheel event at the table's scroll bound must stay consumed",
      );
    }
    if (regionY() !== 1) {
      throw new Error(`clamped region scroll_y = ${regionY()}`);
    }
  });
});

Deno.test("focusAt focuses the topmost registered node on a down_left press", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const first = Box();
    const second = Box();
    renderer.root.addChild(first);
    renderer.root.addChild(second);
    useFocus("second", second, () => {}, manager);
    useFocus("first", first, () => {}, manager);
    // The fake hit path is non-empty (the press lands on a painted cell); the
    // walk resolves the first registered focusable in paint order.
    if (focusAt(renderer, mouse("down_left", 3, 2), manager) !== true) {
      throw new Error("a down_left on a painted cell must be consumed");
    }
    if (manager.activeId !== "first") {
      throw new Error(`active = ${manager.activeId}`);
    }
  });
});

Deno.test("focusAt no-ops on a press off any painted cell (empty hit_test)", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const node = Box();
    renderer.root.addChild(node);
    useFocus("probe", node, () => {}, manager);
    state.fakeHitPath = [];
    if (focusAt(renderer, mouse("down_left", 0, 0), manager) !== false) {
      throw new Error("a press off any painted cell must not be consumed");
    }
    if (manager.activeId !== null) {
      throw new Error(`active = ${manager.activeId}`);
    }
  });
});

Deno.test("focusAt no-ops on non-down_left events and on hits with no registered node", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const manager = new FocusManager();
    const node = Box();
    renderer.root.addChild(node);
    const handle = useFocus("probe", node, () => {}, manager);
    // A wheel event is not a press: never routed.
    if (focusAt(renderer, mouse("scroll_down", 0, 0), manager) !== false) {
      throw new Error("a non-down_left event must not be consumed");
    }
    handle.dispose();
    // The press lands on a painted cell, but no node is registered: no-op.
    if (focusAt(renderer, mouse("down_left", 0, 0), manager) !== false) {
      throw new Error(
        "a press on a cell with no registered node must not be consumed",
      );
    }
    if (manager.activeId !== null) {
      throw new Error(`active = ${manager.activeId}`);
    }
  });
});

Deno.test("focusAt defaults to the shared focusManager", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    const node = Box();
    renderer.root.addChild(node);
    const handle = useFocus("shared", node, () => {});
    if (focusAt(renderer, mouse("down_left", 0, 0)) !== true) {
      throw new Error(
        "a down_left must be consumed by the default focus manager",
      );
    }
    if (focusManager.activeId !== "shared") {
      throw new Error(`active = ${focusManager.activeId}`);
    }
    handle.dispose();
    focusManager.blur();
  });
});

Deno.test("selection drag state machine: down starts, drag extends, up ends", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1); // paint the frame selection_text reads

    // A non-down_left event never starts a session.
    if (startSelection(renderer, mouse("drag_left", 2, 0)) !== null) {
      throw new Error("drag_left must not start a selection");
    }

    // down_left starts the session anchored at the pressed cell.
    const started = startSelection(renderer, mouse("down_left", 2, 0));
    if (started === null) throw new Error("down_left must start a selection");
    if (
      started.col1 !== 2 || started.row1 !== 0 || started.col2 !== 2 ||
      started.row2 !== 0
    ) {
      throw new Error(`started = ${JSON.stringify(started)}`);
    }
    assertSelection({ col1: 2, row1: 0, col2: 2, row2: 0 });

    // drag_left moves the active endpoint, keeping the anchor fixed.
    const r1 = dragSelection(renderer, mouse("drag_left", 5, 0));
    if (
      r1 === null || r1.col1 !== 2 || r1.row1 !== 0 || r1.col2 !== 5 ||
      r1.row2 !== 0
    ) {
      throw new Error(`drag 1 = ${JSON.stringify(r1)}`);
    }
    assertSelection({ col1: 2, row1: 0, col2: 5, row2: 0 });

    // Dragging above/left of the anchor still spans the rect (the native
    // overlay normalizes the endpoints).
    const r2 = dragSelection(renderer, mouse("drag_left", 0, 0));
    if (
      r2 === null || r2.col1 !== 2 || r2.row1 !== 0 || r2.col2 !== 0 ||
      r2.row2 !== 0
    ) {
      throw new Error(`drag 2 = ${JSON.stringify(r2)}`);
    }

    // up_left ends the session and returns the last rect.
    const ended = endSelection(renderer, mouse("up_left", 0, 0));
    if (
      ended === null || ended.col1 !== 2 || ended.row1 !== 0 ||
      ended.col2 !== 0 || ended.row2 !== 0
    ) {
      throw new Error(`ended = ${JSON.stringify(ended)}`);
    }

    // After the release a drag_left is inert, and end without a session is a
    // no-op.
    if (dragSelection(renderer, mouse("drag_left", 7, 0)) !== null) {
      throw new Error("a drag after up_left must be a no-op");
    }
    if (endSelection(renderer, mouse("up_left", 7, 0)) !== null) {
      throw new Error("end without a session must return null");
    }
    renderer.destroy();
  });
});

Deno.test("a double-click within 500ms and one cell selects the word; slower or farther presses do not", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    if (SELECTION_DOUBLE_CLICK_MS !== 500) {
      throw new Error(
        `SELECTION_DOUBLE_CLICK_MS = ${SELECTION_DOUBLE_CLICK_MS}`,
      );
    }

    // Two presses on the same cell within the window: word select.
    setSelectionClockForTesting(() => 1000);
    startSelection(renderer, mouse("down_left", 6, 0)); // 'w' of "world"
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 1400); // +400 ms, inside the window
    const word = startSelection(renderer, mouse("down_left", 6, 0));
    if (
      word === null || word.col1 !== 6 || word.row1 !== 0 || word.col2 !== 10 ||
      word.row2 !== 0
    ) {
      throw new Error(`word double-click = ${JSON.stringify(word)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 10, row2: 0 });
    endSelection(renderer, mouse("up_left", 6, 0));

    // A press more than 500 ms after the previous one is a fresh selection.
    setSelectionClockForTesting(() => 2000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 2600); // +600 ms, outside the window
    const late = startSelection(renderer, mouse("down_left", 6, 0));
    if (late === null || late.col1 !== 6 || late.col2 !== 6) {
      throw new Error(`late press = ${JSON.stringify(late)}`);
    }
    assertSelection({ col1: 6, row1: 0, col2: 6, row2: 0 });
    endSelection(renderer, mouse("up_left", 6, 0));

    // A press two cells away is not a double-click even inside the window.
    setSelectionClockForTesting(() => 3000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 3300); // +300 ms, but 2 cells away
    const far = startSelection(renderer, mouse("down_left", 8, 0));
    if (far === null || far.col1 !== 8 || far.col2 !== 8) {
      throw new Error(`far press = ${JSON.stringify(far)}`);
    }
    assertSelection({ col1: 8, row1: 0, col2: 8, row2: 0 });
    endSelection(renderer, mouse("up_left", 8, 0));

    // A press one cell away IS a double-click (the <= 1 cell bound).
    setSelectionClockForTesting(() => 4000);
    startSelection(renderer, mouse("down_left", 6, 0));
    endSelection(renderer, mouse("up_left", 6, 0));
    setSelectionClockForTesting(() => 4200); // +200 ms, 1 cell away
    const adjacent = startSelection(renderer, mouse("down_left", 7, 0));
    if (adjacent === null || adjacent.col1 !== 6 || adjacent.col2 !== 10) {
      throw new Error(`adjacent double-click = ${JSON.stringify(adjacent)}`);
    }
    endSelection(renderer, mouse("up_left", 7, 0));

    // A double-click on whitespace falls back to the 1-cell selection.
    setSelectionClockForTesting(() => 5000);
    startSelection(renderer, mouse("down_left", 5, 0)); // the space
    endSelection(renderer, mouse("up_left", 5, 0));
    setSelectionClockForTesting(() => 5200);
    const space = startSelection(renderer, mouse("down_left", 5, 0));
    if (space === null || space.col1 !== 5 || space.col2 !== 5) {
      throw new Error(`whitespace double-click = ${JSON.stringify(space)}`);
    }
    assertSelection({ col1: 5, row1: 0, col2: 5, row2: 0 });
    endSelection(renderer, mouse("up_left", 5, 0));

    setSelectionClockForTesting(() => Date.now());
    renderer.destroy();
  });
});

Deno.test("selection text round-trips: the drag-selected rect extracts the covered text", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);

    startSelection(renderer, mouse("down_left", 6, 0));
    dragSelection(renderer, mouse("drag_left", 10, 0));
    if (renderer.selectionText() !== "world") {
      throw new Error(
        `selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }

    // Dragging beyond the text clips at the frame's spaces.
    dragSelection(renderer, mouse("drag_left", 12, 0));
    if (renderer.selectionText() !== "world  ") {
      throw new Error(
        `clipped selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("a drag onto a second row joins the selection text with a newline", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 2); // row 1 is empty (spaces)

    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 1));
    // Rect cols 0-4, rows 0-1: "hello" over the painted row, then a row of
    // five spaces — rows are joined with '\n'.
    if (renderer.selectionText() !== "hello\n     ") {
      throw new Error(
        `two-row selectionText = ${JSON.stringify(renderer.selectionText())}`,
      );
    }
    renderer.destroy();
  });
});

Deno.test("copySelection pushes the selection text to the clipboard", () => {
  withFakeAddon(() => {
    const renderer = createRenderer();
    renderer.root.addChild(Box({}, Text({ text: "hello world" })));
    renderer.snapshotFrame(11, 1);
    // Read through a function: TS control-flow narrowing would otherwise pin
    // `state.lastClipboard` to the literal of the first assertion below.
    const clipboard = (): string | null => state.lastClipboard;

    // No selection set: copies the empty string.
    copySelection(renderer);
    if (clipboard() !== "") {
      throw new Error(`empty copy = ${JSON.stringify(clipboard())}`);
    }

    startSelection(renderer, mouse("down_left", 0, 0));
    dragSelection(renderer, mouse("drag_left", 4, 0));
    copySelection(renderer);
    if (clipboard() !== "hello") {
      throw new Error(`copy = ${JSON.stringify(clipboard())}`);
    }
    renderer.destroy();
  });
});
