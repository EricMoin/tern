//! tern-terminal — terminal frontend for the tern TUI renderer.
//!
//! Wraps crossterm in two layers:
//!
//! * [`backend`] — the terminal backend: raw mode and alternate-screen
//!   lifecycle, mouse/focus event-listening toggles, terminal size, and
//!   flushing a tern-core [`CellUpdate`] diff to the terminal as a queued
//!   ANSI escape-sequence stream.
//! * [`event`] — input normalization: crossterm events become [`TernEvent`]s
//!   (keys with name/char/modifiers, resizes, focus gain/loss, mouse events
//!   with button/kind/position/modifiers), gated to key presses. Events can
//!   be **pulled** in batches via [`poll_events`], or **pushed** to a sink by
//!   a background event loop ([`spawn_event_loop`] / [`run_event_loop`]) that
//!   feeds every normalized event to a caller-supplied callback — the push
//!   path the napi binding uses to deliver events to the JS thread. Mouse and
//!   focus events only arrive once the backend has enabled them with
//!   [`Backend::enable_event_listening`].
//!
//! This crate owns the terminal I/O; tern-core performs none. It depends on
//! `crossterm` for terminal control and on `tern-core` for the cell-update
//! types it flushes.

#![forbid(unsafe_code)]

pub mod backend;
pub mod event;

pub use backend::{flush_cursor_to, flush_diff_to, flush_diff_with_cursor_to, Backend};
pub use event::{
    normalize, poll_events, run_event_loop, spawn_event_loop, EventLoopHandle, KeyKind, KeyName,
    MouseButton, MouseEventKind, TernEvent, TernKey, TernMouse,
};
