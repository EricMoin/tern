//! Tests: the modal overlays in the ScreenPlan, driven through the REAL key route.
//!
//! WHY THE DRIVE IS KEYS, NOT `buildPlan`. The prerequisite this file covers was
//! found precisely because an earlier fixture bypassed the real path: a plan built by
//! hand proves nothing about the screen a user reaches. Every case below presses keys
//! through `HeadlessApp.dispatch` — the keymap's own route (core/keymap.ts:79) — and
//! reads the plan the app then reports.
//!
//! Run: deno test --allow-env=NODE_ENV packages/showcase/src/core/

import type { KeyEvent } from "@tern-tui/core";
import { Buffer } from "./buffer.ts";
import type { ModalRegion, ScreenPlan } from "./plan.ts";
import { HeadlessApp } from "./state.ts";
import { cellWidth } from "./viewport.ts";

/** Throw unless `condition`; `what` names the failing fact. */
function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** A key event with every flag spelled out. */
function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, alt: false, shift: false, ...extra };
}

/** The key events that type `text`, one per code point. */
function chars(text: string): KeyEvent[] {
  return [...text].map((char) => key("char", { char }));
}

/** The plan's overlay, or a failure that names the screen it was read from. */
function modalOf(plan: ScreenPlan): ModalRegion {
  const modal = plan.regions.find((region) => region.kind === "modal") as ModalRegion | undefined;
  if (modal === undefined) throw new Error("the plan carries no modal region");
  return modal;
}

/** One of the overlay's rows as the string a layer would paint. */
function rowText(region: ModalRegion, index: number): string {
  return (region.rows[index]?.spans ?? []).map((span) => span.text).join("");
}

/** Every row's text, frame included. */
function rows(region: ModalRegion): string[] {
  return region.rows.map((_, index) => rowText(region, index));
}

const DOC = "the total is the sum of every part.\n" +
  "a total we can check against the parts.\n" +
  "no other line mentions it.\n";

/** An app over {@link DOC} at 80x24, `keys` pressed through the real route. */
function driven(keys: readonly KeyEvent[]): HeadlessApp {
  const app = new HeadlessApp({ buffer: Buffer.fromString(DOC), path: "demo/find.ts", size: { rows: 24, cols: 80 } });
  for (const event of keys) {
    check(app.dispatch(event), "the app does not handle " + event.name + " (the fixture would pin a dead screen)");
  }
  return app;
}

Deno.test("overlay: ctrl+f and a typed query lay the FIND overlay out in the plan", () => {
  const app = driven([key("f", { ctrl: true }), ...chars("total")]);
  check(app.modal === "find", "the find overlay is open");
  const plan = app.plan();
  const modal = modalOf(plan);

  check(modal.id === "find", "the region names the modal it paints: " + modal.id);
  check(modal.title === "Find", "and its title: " + modal.title);

  // THE CONTENT, which is what the fixture could not carry before: the live query
  // and the match count the same scan replace-all uses.
  const text = rows(modal);
  check(text.some((row) => row.includes("find: total")), "the query is on screen: " + JSON.stringify(text));
  check(text.some((row) => row.includes("2 matches")), "and the count of the matches: " + JSON.stringify(text));
  check(modal.caret !== null, "a field owns the caret");
  check(modal.caret!.row === modal.y + 1, "the caret is on the field's row");
  check(modal.caret!.col === modal.x + 1 + cellWidth("find: total"),
    "and sits after the text the field holds (col " + modal.caret!.col + ")");

  console.log("overlay find: " + JSON.stringify(text));
});

Deno.test("overlay: the overlay is an OVERLAY — inside the body, tiling its own rows", () => {
  const plan = driven([key("h", { ctrl: true }), ...chars("x")]).plan();
  const modal = modalOf(plan);
  const editor = plan.regions.find((region) => region.kind === "editor")!;

  // Inside the BODY: an overlay that pushed the panes aside would be a band.
  check(modal.x >= 0 && modal.y >= 0, "the box starts on screen");
  check(modal.x + modal.width <= plan.size.cols, "and ends on it (columns)");
  check(modal.y + modal.height <= plan.size.rows - 1, "and above the mode line (rows)");
  check(modal.width < editor.width || modal.height < editor.height, "the box leaves part of the pane visible");
  check(plan.regions.indexOf(modal) === plan.regions.length - 2,
    "the overlay paints after the panes and before the mode line");

  // Every row tiles the box exactly: frame, content, filler, frame — no hole for
  // the document to show through.
  for (const row of modal.rows) {
    const painted = row.spans.reduce((total, span) => total + span.width, 0);
    check(painted === modal.width, "row " + row.row + " paints " + painted + " of " + modal.width + " cells");
    check(row.spans.every((span, index) => index === 0 || span.x === row.spans[index - 1]!.x + row.spans[index - 1]!.width),
      "row " + row.row + " has a gap between spans");
  }
  check(modal.rows.length === modal.height, "the box is as tall as the rows it carries");
  console.log("overlay geometry: " + modal.width + "x" + modal.height + " at " + modal.x + "," + modal.y +
    " over the editor's " + editor.width + "x" + editor.height);
});

Deno.test("overlay: ctrl+h carries the query, the replacement and the preview", () => {
  const app = driven([key("f", { ctrl: true }), ...chars("total"), key("h", { ctrl: true }), ...chars("sum")]);
  check(app.modal === "replace", "the replace overlay is on top of find");
  const modal = modalOf(app.plan());
  const text = rows(modal).join("\n");
  check(text.includes("find: total"), "the inherited query is on screen");
  check(text.includes("replace: sum"), "and the replacement the user is typing");
  check(text.includes("2 matches"), "and the count");
  check(text.includes("total -> sum"), "and a preview row per match: " + JSON.stringify(text));
  check(modal.rows[1] !== undefined && rowText(modal, 1).includes("find:"), "the query is the first field");
  console.log("overlay replace: " + JSON.stringify(rows(modal)));
});

Deno.test("overlay: f1 lists the shortcuts the keymap actually dispatches", () => {
  // A TALL screen shows the whole registry, so the list can be read row by row; the
  // SHORT screen below is what pins the windowing.
  const tall = new HeadlessApp({ buffer: Buffer.fromString(DOC), size: { rows: 60, cols: 100 } });
  check(tall.dispatch(key("f1")), "f1 opens the help overlay");
  check(tall.modal === "help", "the help overlay is open");
  const modal = modalOf(tall.plan());
  check(modal.count > 20, "the registry's described shortcuts are on screen (" + modal.count + ")");
  check(modal.rows.length === modal.count + 3,
    "the frame, every shortcut and the footer are painted (" + modal.rows.length + " rows for " + modal.count + " shortcuts)");
  const body = rows(modal).join("\n");
  check(body.includes("ctrl+f"), "the find shortcut is listed: " + JSON.stringify(rows(modal).slice(0, 3)));
  check(body.includes("Find"), "with the title the dispatcher registered for it");
  check(body.includes("Delete the line"), "and a later command's title too");
  check(body.includes("ctrl+left"), "and a motion's own combo");

  // A windowed list is a WINDOW: what does not fit is dropped, not squeezed.
  const short = driven([key("f1")]);
  const windowed = modalOf(short.plan());
  check(windowed.count === modal.count, "the same registry, on a smaller screen");
  check(windowed.rows.length < modal.rows.length, "and a smaller window of it");
  check(windowed.rows.length === windowed.height, "the box is exactly as tall as its rows");
  console.log("overlay help: " + modal.count + " shortcuts — " + modal.rows.length + " rows tall, " +
    windowed.rows.length + " rows on a 24-row screen");
});

Deno.test("overlay: escape closes the overlay and the plan stops carrying it", () => {
  const app = driven([key("f", { ctrl: true }), ...chars("total")]);
  check(modalOf(app.plan()).id === "find", "the overlay is in the plan while it is open");
  check(app.dispatch(key("escape")), "escape is claimed while the overlay owns the keyboard");
  check(app.modal === null, "and the overlay is gone");
  const plan = app.plan();
  check(plan.regions.every((region) => region.kind !== "modal"),
    "a screen with no modal carries no modal region — the nine non-modal screens are untouched");
  check(plan.stats.modalRows === 0, "and reports no overlay rows");
});
