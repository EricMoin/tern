//! tern-components — the compositor and imperative renderables.
//!
//! Sits at stage 6 of the render pipeline (see `docs/architecture.md`): the
//! [`Compositor`] runs the layout engine from tern-layout over a scene tree
//! and paints the laid-out nodes into a tern-core [`Buffer`].
//!
//! Three API surfaces:
//!
//! * **Imperative renderables** — [`Text`] and [`Box`] builder objects that
//!   materialize into a tern-core [`Scene`]. A [`Text`] paints its content
//!   clipped to its laid-out rect; a [`Box`] paints its background, optional
//!   border glyphs, and a padding inset around its children.
//! * **Roadmap components** — [`Input`], [`Textarea`], [`Spinner`],
//!   [`Panels`], [`StatusBar`], and [`Canvas`], the Rust renderable half of
//!   the `docs/components.md` widget roadmap. Each is plain state plus
//!   builder/editing methods that materializes as a `Box`/`Text` subtree;
//!   [`Input`] and [`Textarea`] stamp a `caret` prop the compositor paints as
//!   a block caret ([`Textarea`] soft-wraps its lines and scrolls vertically
//!   so the caret stays visible).
//! * **The [`Compositor`]** — takes a renderable tree root (or a raw
//!   [`Scene`]) and a viewport size, runs the layout engine, and paints into a
//!   fresh [`Buffer`].

#![forbid(unsafe_code)]

mod canvas;
mod compositor;
mod input;
mod panels;
mod renderable;
mod spinner;
mod statusbar;
mod textarea;

pub use canvas::Canvas;
pub use compositor::{Compositor, ScrollShift, detect_vertical_scroll, exposed_band_updates};
pub use input::{Input, Key, KeyAction};
pub use panels::{Panel, Panels};
pub use renderable::{Box, Renderable, Text};
pub use spinner::{Spinner, SpinnerKind, BRAILLE_FRAMES, LINE_FRAMES};
pub use statusbar::{Segment, SegmentAlign, StatusBar};
pub use textarea::{wrap_line, Textarea};
