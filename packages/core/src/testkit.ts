//! Test infrastructure for the @tern-tui/core suite.
//!
//! The fake napi addon, the shared fixtures, and the helpers the topic test
//! files import. Kept out of the published surface: nothing here is imported
//! by src/index.ts, so tsc never emits it into dist/.

export * from "./testkit/fakes.ts";
export * from "./testkit/edit.ts";
export * from "./testkit/widgets.ts";
export * from "./testkit/fixtures.ts";
export * from "./testkit/events.ts";
export * from "./testkit/scroll.ts";
export * from "./testkit/themes.ts";
export * from "./testkit/text.ts";
