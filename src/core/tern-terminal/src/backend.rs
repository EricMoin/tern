//! The terminal backend: a thin wrapper around crossterm.
//!
//! Owns the terminal lifecycle (raw mode, alternate screen), reports the
//! terminal size, and flushes a tern-core [`CellUpdate`] diff to the terminal
//! as a single queued ANSI escape-sequence stream. The diff-aware flush is
//! split out into [`flush_diff_to`] over a generic `Write` so it can be unit
//! tested against an in-memory buffer; the [`Backend`] methods use stdout.
//! Window-title (OSC 0) and clipboard (OSC 52) writes follow the same seam:
//! [`set_title_to`] / [`set_clipboard_to`] over a generic `Write`, with the
//! `Backend` methods funneling to stdout.
//!
//! Consecutive updates with the same style on the same row at adjacent
//! columns are batched into runs: one `MoveTo`, one unconditional SGR reset
//! (`\x1b[0m`) plus the run's exact style applied once, and the run's
//! characters in a single `Print` call. Style state can never leak from one
//! run to the next, and a run is closed by any style change or column gap.
//! Within one flush, a run whose style equals the previously queued run's
//! skips the redundant SGR reset/re-apply — the terminal's style state is
//! already that style — and emits only its `MoveTo` and `Print`. A run whose
//! style carries a hyperlink wraps its `Print` in OSC 8 sequences — the open
//! (`\x1b]8;;<url>\x1b\\`) written raw before the characters and the close
//! (`\x1b]8;;\x1b\\`) raw after them — via the same seam as the OSC 52
//! clipboard write ([`set_clipboard_to`]); crossterm has no hyperlink
//! command. The close follows every linked run, so a later unlinked run can
//! never inherit the link.
//!
//! An empty diff short-circuits the flush: when a frame paints nothing and
//! the caret would be parked where the previous flush left it, nothing is
//! queued or flushed; when only the park position moved, just the `MoveTo`
//! is emitted (see [`flush_diff_to`]). The caret-aware frame flush carries
//! the caret: [`flush_diff_with_cursor_to`] moves the terminal cursor to the
//! frame's [`Cursor`] position, applies its shape / blinking via
//! `SetCursorStyle` (emitted only for a non-default caret — a steady block
//! is the terminal default, so it adds nothing to existing flushes), and
//! shows or hides it per its visibility, so the hardware caret tracks the
//! model.
//!
//! A scroll-region flush ([`flush_scroll_to`]) is the same seam for the
//! terminal-native scroll optimization: it sets a DECSTBM region, scrolls it
//! with SU/SD, paints only the exposed band of [`CellUpdate`]s, resets the
//! region, and parks the caret. crossterm has no DECSTBM / SU / SD commands,
//! so those sequences are written raw through the `Write` — the same seam as
//! the OSC 8 hyperlink open/close ([`Run::queue`]) and the kitty extended
//! underline ([`queue_underline_with`]).


use std::io::{self, Write};
use std::sync::OnceLock;
use crate::probe::{probe, TerminalCapabilities};
use crossterm::cursor::{Hide, MoveTo, SetCursorStyle, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::style::{
    Attribute, Color as CrosstermColor, Print, ResetColor, SetAttribute, SetBackgroundColor,
    SetForegroundColor,
};
use crossterm::terminal::{
    self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, SetTitle,
};
use crossterm::{ExecutableCommand, QueueableCommand};
use tern_core::cell::CellUpdate;
use tern_core::color::Color as TernColor;
use tern_core::cursor::{Cursor, CursorShape};
use tern_core::style::{Modifiers, Style, UnderlineStyle};

// Modelled on the compositor split (tern-components/src/compositor.rs):
// the submodules hold the cohesive slices and the glob re-exports keep
// every item reachable under its original path.
mod caps;
mod lifecycle;
mod a11y;
mod sgr;
mod flush;

pub use caps::*;
pub use lifecycle::*;
pub use a11y::*;
pub use sgr::*;
pub use flush::*;

/// The terminal backend.
///
/// Cheap to copy: crossterm keeps the terminal state globally, so the backend
/// just funnels method calls at it. The single piece of frame-flush state is
/// the last park position written by [`flush_diff`], which lets an empty diff
/// that would park the caret in the same place skip the flush entirely (see
/// [`flush_diff_to`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct Backend {
    /// The park position written by the most recent non-skipped
    /// [`flush_diff`] flush; `None` before the first flush. Drives the
    /// empty-diff fast path in [`flush_diff_to`].
    last_flush_pos: Option<(u16, u16)>,
    /// The renderer's opt-in for iTerm2 hidden accessibility annotations
    /// (OSC 1337 `AddHiddenAnnotation`), set via
    /// [`with_a11y_annotations`](Backend::with_a11y_annotations). Off by
    /// default; the write itself is additionally gated on the interactive
    /// probe reporting an iTerm2 terminal — see
    /// [`set_a11y_annotations`](Backend::set_a11y_annotations).
    a11y_annotations: bool,
}

impl Backend {
    /// A fresh backend, with no park position recorded yet and iTerm2
    /// accessibility annotations disabled (see
    /// [`with_a11y_annotations`](Backend::with_a11y_annotations)).
    pub const fn new() -> Self {
        Self {
            last_flush_pos: None,
            a11y_annotations: false,
        }
    }

    /// Enter raw mode: disable line buffering and echo so the app receives
    /// keys immediately and controls the screen itself.
    pub fn enter_raw_mode(&self) -> io::Result<()> {
        terminal::enable_raw_mode()
    }

    /// Leave raw mode, restoring the terminal's original termios settings.
    pub fn exit_raw_mode(&self) -> io::Result<()> {
        terminal::disable_raw_mode()
    }

    /// Switch to the alternate screen (the app's full-screen surface).
    pub fn enter_alt_screen(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(EnterAlternateScreen)?;
        out.flush()
    }

    /// Return to the main screen, restoring whatever was there before.
    pub fn exit_alt_screen(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(LeaveAlternateScreen)?;
        out.flush()
    }

    /// Set the terminal window title (OSC 0: `ESC ] 0 ; title BEL`).
    pub fn set_title(&self, title: &str) -> io::Result<()> {
        let mut out = io::stdout();
        set_title_to(&mut out, title)
    }

    /// Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
    /// BEL`, where the payload is the text's UTF-8 bytes base64-encoded per
    /// RFC 4648).
    ///
    /// crossterm has no OSC 52 support with the feature set tern enables (its
    /// `osc52` feature is off by default, and its sequence uses the ST
    /// terminator), so the escape is written through the backend queue
    /// directly — the same seam as [`set_title`](Backend::set_title).
    pub fn set_clipboard(&self, text: &str) -> io::Result<()> {
        let mut out = io::stdout();
        set_clipboard_to(&mut out, text)
    }

    /// Write iTerm2 hidden accessibility annotations (`OSC 1337 ;
    /// AddHiddenAnnotation = <summary> BEL`) for `entries` to stdout — one
    /// sequence per entry — so VoiceOver can read the scene's semantics
    /// store in iTerm2's accessibility mode.
    ///
    /// A strict no-op (zero bytes) unless the backend was built with
    /// [`with_a11y_annotations`](Backend::with_a11y_annotations) AND the
    /// interactive probe reports the terminal self-identifies as iTerm2
    /// (the only terminal that understands the sequence) — see
    /// [`flush_a11y_annotations_gated_to`]. iTerm2's `AddHiddenAnnotation`
    /// does not reveal the annotation window on receipt, so the write never
    /// disturbs the visible screen.
    pub fn set_a11y_annotations(&self, entries: &[A11yAnnotation]) -> io::Result<()> {
        let mut out = io::stdout();
        flush_a11y_annotations_gated_to(&mut out, self.a11y_annotations, probe(), entries)
    }

    /// Opt into iTerm2 hidden accessibility annotations (OSC 1337
    /// `AddHiddenAnnotation`) for this backend: when enabled, every
    /// [`set_a11y_annotations`](Backend::set_a11y_annotations) call emits
    /// the annotations — provided the interactive probe reports the
    /// terminal is iTerm2. Off by default.
    pub fn with_a11y_annotations(mut self, enabled: bool) -> Self {
        self.a11y_annotations = enabled;
        self
    }

    /// Apply the renderer's startup screen transitions on stdout: the
    /// alternate screen when `use_alt_screen` is `true`, the window title
    /// when `Some`, then event listening — one batch, one flush.
    ///
    /// Hosts that render inline in the main screen pass
    /// `use_alt_screen: false` to skip the alternate screen entirely (and
    /// must skip [`exit_alt_screen`](Backend::exit_alt_screen) on teardown
    /// to match).
    pub fn startup(&self, use_alt_screen: bool, title: Option<&str>) -> io::Result<()> {
        let mut out = io::stdout();
        queue_startup_to(&mut out, use_alt_screen, title)
    }

    /// Tell the terminal to report mouse, focus-change, and bracketed-paste
    /// events so [`poll_events`](crate::event::poll_events) can surface them.
    ///
    /// crossterm only emits these events once the terminal has been told to
    /// track them; without this, mouse, focus, and paste events never reach
    /// the event loop. Mouse capture is tiered: press/release, drag, and
    /// scroll events are enabled here, but **any-event motion tracking
    /// (`?1003`, the terminal reporting every mouse movement) is not** —
    /// opt in with [`enable_any_event_mouse`](Backend::enable_any_event_mouse)
    /// only while a motion/drag listener is registered, so terminals do not
    /// stream motion events when nothing consumes them. Pair with
    /// [`disable_event_listening`](Backend::disable_event_listening).
    pub fn enable_event_listening(&self) -> io::Result<()> {
        let mut out = io::stdout();
        enable_event_listening_to(&mut out)
    }

    /// Tell the terminal to stop reporting mouse, focus-change, and
    /// bracketed-paste events. Also turns off any-event motion tracking
    /// (`?1003l`), so a separately enabled
    /// [`enable_any_event_mouse`](Backend::enable_any_event_mouse) is fully
    /// restored by this teardown.
    pub fn disable_event_listening(&self) -> io::Result<()> {
        let mut out = io::stdout();
        disable_event_listening_to(&mut out)
    }

    /// Opt into any-event mouse tracking (`?1003h`): the terminal reports
    /// every mouse motion, not just presses and drags.
    ///
    /// Off by default — [`enable_event_listening`](Backend::enable_event_listening)
    /// enables press/release, drag, and scroll tracking only — so motion
    /// events only flow while a motion/drag listener is registered. Pair with
    /// [`disable_any_event_mouse`](Backend::disable_any_event_mouse); the full
    /// teardown in [`disable_event_listening`](Backend::disable_event_listening)
    /// clears this mode too.
    pub fn enable_any_event_mouse(&self) -> io::Result<()> {
        let mut out = io::stdout();
        enable_any_event_mouse_to(&mut out)
    }

    /// Stop any-event mouse tracking (`?1003l`): the terminal stops reporting
    /// motion without a button pressed. Drags still report via the
    /// button-event tracking enabled by
    /// [`enable_event_listening`](Backend::enable_event_listening).
    pub fn disable_any_event_mouse(&self) -> io::Result<()> {
        let mut out = io::stdout();
        disable_any_event_mouse_to(&mut out)
    }

    /// Enable the kitty keyboard protocol (progressive enhancement):
    /// DISAMBIGUATE_ESCAPE_CODES so modifier combinations like Shift-Enter
    /// are reported distinctly instead of collapsing into the unmodified
    /// key, REPORT_EVENT_TYPES so key auto-repeats and releases surface as
    /// distinct `KeyEventKind`s, and REPORT_ALL_KEYS_AS_ESCAPE_CODES so
    /// plain-text keys (not just named keys) report repeat/release — without
    /// it, a held `q` would emit no repeat/release events at all. Terminals
    /// that do not support the protocol ignore the sequences. Pair with
    /// [`exit_keyboard_enhancement`](Backend::exit_keyboard_enhancement).
    pub fn enter_keyboard_enhancement(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES,
        ))?;
        out.flush()
    }

    /// Disable the kitty keyboard protocol (pop one enhancement level).
    pub fn exit_keyboard_enhancement(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(PopKeyboardEnhancementFlags)?;
        out.flush()
    }

    /// The terminal size as `(columns, rows)`.
    pub fn size(&self) -> io::Result<(u16, u16)> {
        terminal::size()
    }

    /// Hide the cursor (used while drawing to avoid flicker).
    pub fn hide_cursor(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(Hide)?;
        out.flush()
    }

    /// Restore the cursor.
    pub fn show_cursor(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(Show)?;
        out.flush()
    }

    /// Clear the whole screen.
    pub fn clear(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(Clear(ClearType::All))?;
        out.flush()
    }

    /// Flush a diff of [`CellUpdate`]s to stdout, then park the cursor at
    /// `cursor_pos` (column, row). Returns the number of bytes queued to the
    /// terminal — the ANSI escape-sequence stream for this frame — so the
    /// renderer can report flushed-bytes-per-frame (the byte cost of a diff,
    /// the seam the empty-diff fast path short-circuits).
    ///
    /// See [`flush_diff_to`] for the queueing semantics; its empty-diff fast
    /// path is what makes consecutive no-op frames cheap (a fully suppressed
    /// frame reports 0 bytes). This legacy variant parks the caret without
    /// touching its visibility; the caret-aware frame flush is
    /// [`flush_diff_with_cursor`](Backend::flush_diff_with_cursor).
    pub fn flush_diff(
        &mut self,
        updates: &[CellUpdate],
        cursor_pos: (u16, u16),
    ) -> io::Result<usize> {
        let mut out = CountingWriter::new(io::stdout());
        flush_diff_to(&mut out, updates, cursor_pos, &mut self.last_flush_pos)?;
        Ok(out.bytes)
    }

    /// Flush a diff of [`CellUpdate`]s to stdout, then position the terminal
    /// caret at the cursor's (`x`, `y`), apply its shape / blinking
    /// `SetCursorStyle` (nothing for the default steady block), and show or
    /// hide it per [`Cursor::visible`]. Returns the number of bytes queued to
    /// the terminal, like [`flush_diff`](Backend::flush_diff).
    ///
    /// See [`flush_diff_with_cursor_to`] for the queueing semantics.
    pub fn flush_diff_with_cursor(
        &self,
        updates: &[CellUpdate],
        cursor: Cursor,
    ) -> io::Result<usize> {
        let mut out = CountingWriter::new(io::stdout());
        flush_diff_with_cursor_to(&mut out, updates, cursor)?;
        Ok(out.bytes)
    }

    /// Flush a scroll-region operation to stdout: set the DECSTBM region,
    /// scroll its content up/down by `op.rows`, paint the exposed band, reset
    /// the region, then park the cursor at `cursor_pos`. Returns the number
    /// of bytes queued to the terminal — the optimized frame's escape stream
    /// — so the renderer can report flushed bytes per frame like
    /// [`flush_diff`](Backend::flush_diff).
    ///
    /// See [`flush_scroll_to`] for the queueing semantics; its empty-updates
    /// fast path makes a scroll with an empty exposed band a no-op (0 bytes).
    pub fn flush_scroll(
        &mut self,
        op: &ScrollOp,
        updates: &[CellUpdate],
        cursor_pos: (u16, u16),
    ) -> io::Result<usize> {
        let mut out = CountingWriter::new(io::stdout());
        flush_scroll_to(&mut out, op, updates, cursor_pos, &mut self.last_flush_pos)?;
        Ok(out.bytes)
    }

    /// Position the terminal caret at the cursor's (`x`, `y`) and show or
    /// hide it per [`Cursor::visible`], without writing any cells.
    pub fn flush_cursor(&self, cursor: Cursor) -> io::Result<()> {
        let mut out = io::stdout();
        flush_cursor_to(&mut out, cursor)
    }
}

#[cfg(test)]
mod tests;
