//! tern-terminal — terminal frontend for the tern TUI renderer.
//!
//! Wraps crossterm in two layers:
//!
//! * [`backend`] — the terminal backend: raw mode and alternate-screen
//!   lifecycle, terminal size, and flushing a tern-core [`CellUpdate`] diff
//!   to the terminal as a queued ANSI escape-sequence stream.
//! * [`event`] — input normalization: crossterm events become [`TernEvent`]s
//!   (keys with name/char/modifiers, resizes, focus loss), gated to key
//!   presses, and surfaced in batches via [`poll_events`].
//!
//! This crate owns the terminal I/O; tern-core performs none. It depends on
//! `crossterm` for terminal control and on `tern-core` for the cell-update
//! types it flushes.

#![forbid(unsafe_code)]

pub mod backend;
pub mod event;

pub use backend::{flush_diff_to, Backend};
pub use event::{normalize, poll_events, KeyName, TernEvent, TernKey};
