//! tern-core — the core engine for the tern TUI renderer.
//!
//! Owns the primitive types and scene graph consumed by tern-layout and
//! tern-components:
//!
//! * [`Cell`] / [`Style`] / [`Color`] — the terminal cell model
//! * [`Cursor`] — the frame's text cursor: position, visibility, render style
//! * [`Buffer`] + [`diff`] — the compositor's 2D cell grid and the
//!   multi-width-aware minimal diff between two buffers
//! * [`Region`] — a bounded drawing region (clip rect + scroll offset) for
//!   scrollable panes and clipped overlays
//! * [`Rect`] / [`Size`] — geometry used by layout
//! * [`Scene`] / [`SceneNode`] — the scene tree produced by the reconciler
//! * [`LayoutEngine`] — the trait implemented by tern-layout
//!
//! This crate performs no terminal I/O and depends only on `unicode-width`
//! (for character display widths) and `unicode-segmentation` (for grapheme
//! cluster boundaries). See `docs/architecture.md` for where this crate sits
//! in the render pipeline (stage 3: scene tree).

#![forbid(unsafe_code)]

pub mod buffer;
pub mod cell;
pub mod color;
pub mod cursor;
pub mod layout;
pub mod rect;
pub mod scene;
pub mod style;

pub use buffer::{diff, Buffer, Region};
pub use cell::{char_width, cluster_width, clusters, Cell, CellUpdate, Cluster};
pub use color::Color;
pub use cursor::Cursor;
pub use layout::LayoutEngine;
pub use rect::{Rect, Size};
pub use scene::{NodeId, NodeKind, PropMap, PropValue, Scene, SceneNode, Span};
pub use style::{BorderStyle, Modifiers, Style};
