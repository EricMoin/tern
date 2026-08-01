//! tern-components — the compositor and imperative Text/Box renderables.
//!
//! Sits at stage 6 of the render pipeline (see `docs/architecture.md`): the
//! [`Compositor`] runs the layout engine from tern-layout over a scene tree
//! and paints the laid-out nodes into a tern-core [`Buffer`].
//!
//! Two API surfaces:
//!
//! * **Imperative renderables** — [`Text`] and [`Box`] builder objects that
//!   materialize into a tern-core [`Scene`]. A [`Text`] paints its content
//!   clipped to its laid-out rect; a [`Box`] paints its background, optional
//!   border glyphs, and a padding inset around its children.
//! * **The [`Compositor`]** — takes a renderable tree root (or a raw
//!   [`Scene`]) and a viewport size, runs the layout engine, and paints into a
//!   fresh [`Buffer`].

#![forbid(unsafe_code)]

mod compositor;
mod renderable;

pub use compositor::Compositor;
pub use renderable::{Box, Renderable, Text};
