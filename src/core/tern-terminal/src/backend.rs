//! The terminal backend: a thin wrapper around crossterm.
//!
//! Owns the terminal lifecycle (raw mode, alternate screen), reports the
//! terminal size, and flushes a tern-core [`CellUpdate`] diff to the terminal
//! as a single queued ANSI escape-sequence stream. The diff-aware flush is
//! split out into [`flush_diff_to`] over a generic `Write` so it can be unit
//! tested against an in-memory buffer; the [`Backend`] methods use stdout.
//!
//! Every cell is written with an unconditional SGR reset (`\x1b[0m`) followed
//! by the cell's exact style, so style state can never leak from one cell to
//! the next — correctness over escape-sequence economy in the MVP.
//!
//! Frame flush also carries the caret: [`flush_diff_with_cursor_to`] moves
//! the terminal cursor to the frame's [`Cursor`] position and shows or hides
//! it per its visibility, so the hardware caret tracks the model.

use std::io::{self, Write};

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture,
};
use crossterm::style::{
    Attribute, Color as CrosstermColor, Print, ResetColor, SetAttribute, SetBackgroundColor,
    SetForegroundColor,
};
use crossterm::terminal::{
    self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::{ExecutableCommand, QueueableCommand};
use tern_core::cell::CellUpdate;
use tern_core::color::Color as TernColor;
use tern_core::cursor::Cursor;
use tern_core::style::Modifiers;

/// The terminal backend.
///
/// Stateless and cheap to copy: crossterm keeps the terminal state globally,
/// so the backend just funnels method calls at it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Backend;

impl Backend {
    /// A fresh backend.
    pub const fn new() -> Self {
        Self
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

    /// Tell the terminal to report mouse, focus-change, and bracketed-paste
    /// events so [`poll_events`](crate::event::poll_events) can surface them.
    ///
    /// crossterm only emits these events once the terminal has been told to
    /// track them; without this, mouse, focus, and paste events never reach
    /// the event loop. Pair with
    /// [`disable_event_listening`](Backend::disable_event_listening).
    pub fn enable_event_listening(&self) -> io::Result<()> {
        let mut out = io::stdout();
        enable_event_listening_to(&mut out)
    }

    /// Tell the terminal to stop reporting mouse, focus-change, and
    /// bracketed-paste events.
    pub fn disable_event_listening(&self) -> io::Result<()> {
        let mut out = io::stdout();
        disable_event_listening_to(&mut out)
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
    /// `cursor_pos` (column, row).
    ///
    /// See [`flush_diff_to`] for the queueing semantics. This legacy variant
    /// parks the caret without touching its visibility; the caret-aware frame
    /// flush is [`flush_diff_with_cursor`](Backend::flush_diff_with_cursor).
    pub fn flush_diff(
        &self,
        updates: &[CellUpdate],
        cursor_pos: (u16, u16),
    ) -> io::Result<()> {
        let mut out = io::stdout();
        flush_diff_to(&mut out, updates, cursor_pos)
    }

    /// Flush a diff of [`CellUpdate`]s to stdout, then position the terminal
    /// caret at the cursor's (`x`, `y`) and show or hide it per
    /// [`Cursor::visible`].
    ///
    /// See [`flush_diff_with_cursor_to`] for the queueing semantics.
    pub fn flush_diff_with_cursor(
        &self,
        updates: &[CellUpdate],
        cursor: Cursor,
    ) -> io::Result<()> {
        let mut out = io::stdout();
        flush_diff_with_cursor_to(&mut out, updates, cursor)
    }

    /// Position the terminal caret at the cursor's (`x`, `y`) and show or
    /// hide it per [`Cursor::visible`], without writing any cells.
    pub fn flush_cursor(&self, cursor: Cursor) -> io::Result<()> {
        let mut out = io::stdout();
        flush_cursor_to(&mut out, cursor)
    }
}

/// Enable mouse, focus-change, and bracketed-paste event reporting on any
/// `Write` target.
///
/// Emits the crossterm enable sequences: mouse capture (normal, button-event,
/// any-event, rxvt, and SGR tracking modes), focus-change reporting, then
/// bracketed-paste mode. Without these, crossterm never surfaces mouse,
/// focus, or paste events to [`poll_events`](crate::event::poll_events). Pair
/// with [`disable_event_listening_to`] at shutdown.
pub fn enable_event_listening_to<W: Write>(w: &mut W) -> io::Result<()> {
    w.queue(EnableMouseCapture)?;
    w.queue(EnableFocusChange)?;
    w.queue(EnableBracketedPaste)?;
    w.flush()
}

/// Disable mouse, focus-change, and bracketed-paste event reporting on any
/// `Write` target.
///
/// Emits the inverse of [`enable_event_listening_to`]: bracketed-paste mode
/// off, focus-change reporting off, then the mouse capture modes off in
/// reverse order.
pub fn disable_event_listening_to<W: Write>(w: &mut W) -> io::Result<()> {
    w.queue(DisableMouseCapture)?;
    w.queue(DisableFocusChange)?;
    w.queue(DisableBracketedPaste)?;
    w.flush()
}

/// Flush a diff of [`CellUpdate`]s to any `Write` target, then park the
/// cursor at `cursor_pos` (column, row), leaving the terminal's style state
/// reset.
///
/// For each update the cursor is moved to the cell, the style is fully reset
/// and re-applied (fg color, bg color, modifier attributes), and the
/// character is printed. Masked continuation cells (NUL content) are printed
/// as a space to clear the column; zero-width combining marks are printed
/// raw. The whole batch is queued and flushed once at the end.
pub fn flush_diff_to<W: Write>(
    w: &mut W,
    updates: &[CellUpdate],
    cursor_pos: (u16, u16),
) -> io::Result<()> {
    for update in updates {
        queue_cell(w, update)?;
    }
    w.queue(MoveTo(cursor_pos.0, cursor_pos.1))?;
    // Leave the terminal's style state clean for whatever prints next.
    w.queue(ResetColor)?;
    w.queue(SetAttribute(Attribute::Reset))?;
    w.flush()
}

/// Flush a diff of [`CellUpdate`]s to any `Write` target, then position the
/// terminal caret at the cursor's (`x`, `y`) and show or hide it per
/// [`Cursor::visible`], leaving the terminal's style state reset.
///
/// The cell queueing matches [`flush_diff_to`]; the trailing caret control
/// replaces the unconditional park: [`MoveTo`] to the cursor position, then
/// [`Show`] or [`Hide`] per visibility.
pub fn flush_diff_with_cursor_to<W: Write>(
    w: &mut W,
    updates: &[CellUpdate],
    cursor: Cursor,
) -> io::Result<()> {
    for update in updates {
        queue_cell(w, update)?;
    }
    queue_cursor(w, cursor)?;
    w.flush()
}

/// Position the terminal caret at the cursor's (`x`, `y`) on any `Write`
/// target, showing or hiding it per [`Cursor::visible`], and leave the
/// terminal's style state reset.
pub fn flush_cursor_to<W: Write>(w: &mut W, cursor: Cursor) -> io::Result<()> {
    queue_cursor(w, cursor)?;
    w.flush()
}

/// Queue the caret state: move to the cursor's position, then show or hide it
/// per visibility, then reset the terminal's style state.
fn queue_cursor<W: Write>(w: &mut W, cursor: Cursor) -> io::Result<()> {
    w.queue(MoveTo(cursor.x, cursor.y))?;
    if cursor.visible {
        w.queue(Show)?;
    } else {
        w.queue(Hide)?;
    }
    // Leave the terminal's style state clean for whatever prints next.
    w.queue(ResetColor)?;
    w.queue(SetAttribute(Attribute::Reset))?;
    Ok(())
}

/// Queue the ANSI commands for a single cell update.
fn queue_cell<W: Write>(w: &mut W, update: &CellUpdate) -> io::Result<()> {
    w.queue(MoveTo(update.x, update.y))?;
    // SGR 0 resets colors and attributes; then the cell's exact style is
    // applied, so nothing leaks between cells.
    w.queue(SetAttribute(Attribute::Reset))?;
    queue_color(w, update.style.fg, true)?;
    queue_color(w, update.style.bg, false)?;
    queue_modifiers(w, update.style.modifiers)?;
    // A masked continuation cell (NUL) is cleared by printing a space; a
    // zero-width combining mark (non-NUL) is printed raw.
    let ch = if update.masked && update.ch == '\0' {
        ' '
    } else {
        update.ch
    };
    w.queue(Print(ch))?;
    Ok(())
}

/// Queue the foreground (`fg == true`) or background (`fg == false`) color
/// command for a tern-core color. `Default` needs no command: the per-cell
/// SGR reset already restored the terminal default.
fn queue_color<W: Write>(w: &mut W, color: TernColor, fg: bool) -> io::Result<()> {
    match color {
        TernColor::Default => Ok(()),
        TernColor::Indexed(index) => {
            if fg {
                w.queue(SetForegroundColor(CrosstermColor::AnsiValue(index)))?;
            } else {
                w.queue(SetBackgroundColor(CrosstermColor::AnsiValue(index)))?;
            }
            Ok(())
        }
        TernColor::Rgb(r, g, b) => {
            if fg {
                w.queue(SetForegroundColor(CrosstermColor::Rgb { r, g, b }))?;
            } else {
                w.queue(SetBackgroundColor(CrosstermColor::Rgb { r, g, b }))?;
            }
            Ok(())
        }
    }
}

/// Queue the crossterm attribute commands for a tern-core modifier set.
fn queue_modifiers<W: Write>(w: &mut W, modifiers: Modifiers) -> io::Result<()> {
    let attributes = [
        (Modifiers::BOLD, Attribute::Bold),
        (Modifiers::DIM, Attribute::Dim),
        (Modifiers::ITALIC, Attribute::Italic),
        (Modifiers::UNDERLINE, Attribute::Underlined),
        (Modifiers::BLINK, Attribute::SlowBlink),
        (Modifiers::REVERSED, Attribute::Reverse),
        (Modifiers::HIDDEN, Attribute::Hidden),
        (Modifiers::STRIKETHROUGH, Attribute::CrossedOut),
    ];
    for (flag, attribute) in attributes {
        if modifiers.contains(flag) {
            w.queue(SetAttribute(attribute))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::style::Style;

    /// Run the diff flusher against an in-memory buffer and return the bytes.
    fn flush(updates: &[CellUpdate], cursor_pos: (u16, u16)) -> Vec<u8> {
        let mut out = Vec::new();
        flush_diff_to(&mut out, updates, cursor_pos).expect("flush should succeed");
        out
    }

    fn update(x: u16, y: u16, ch: char, style: Style, width: u8, masked: bool) -> CellUpdate {
        CellUpdate {
            x,
            y,
            ch,
            style,
            width,
            masked,
        }
    }

    #[test]
    fn enable_event_listening_emits_mouse_and_focus_enable_sequences() {
        let mut out = Vec::new();
        enable_event_listening_to(&mut out).expect("enable should succeed");
        let s = String::from_utf8(out).unwrap();
        // Mouse capture: normal (?1000h), button-event (?1002h), any-event
        // (?1003h), rxvt (?1015h), sgr (?1006h); then focus change (?1004h)
        // and bracketed paste (?2004h).
        assert_eq!(
            s,
            "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?1004h\x1b[?2004h",
            "got: {s:?}"
        );
    }

    #[test]
    fn disable_event_listening_emits_mouse_and_focus_disable_sequences() {
        let mut out = Vec::new();
        disable_event_listening_to(&mut out).expect("disable should succeed");
        let s = String::from_utf8(out).unwrap();
        // The inverse of enable, in reverse order; focus change (?1004l)
        // next, then bracketed paste (?2004l), then the mouse modes back off.
        assert_eq!(
            s,
            "\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1004l\x1b[?2004l",
            "got: {s:?}"
        );
    }

    #[test]
    fn flush_diff_moves_writes_and_parks_cursor() {
        let out = flush(&[update(2, 1, 'x', Style::new(), 1, false)], (0, 0));
        let s = String::from_utf8(out).unwrap();
        // MoveTo(2, 1) is 1-based -> row 2, column 3.
        assert!(s.contains("\x1b[2;3H"), "got: {s:?}");
        // The cell is reset before printing.
        assert!(s.contains("\x1b[0m"), "got: {s:?}");
        assert!(s.contains('x'), "got: {s:?}");
        // The cursor is parked at the top-left afterwards; the trailing
        // ResetColor and Attribute::Reset both emit SGR 0.
        assert!(s.ends_with("\x1b[1;1H\x1b[0m\x1b[0m"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_applies_indexed_and_rgb_colors() {
        let fg_indexed = Style::new().fg(TernColor::Indexed(1));
        let fg_rgb = Style::new().fg(TernColor::Rgb(1, 2, 3));
        let bg_indexed = Style::new().bg(TernColor::Indexed(4));
        let out = flush(
            &[
                update(0, 0, 'a', fg_indexed, 1, false),
                update(1, 0, 'b', fg_rgb, 1, false),
                update(2, 0, 'c', bg_indexed, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("\x1b[38;5;1m"), "got: {s:?}"); // fg palette 1
        assert!(s.contains("\x1b[38;2;1;2;3m"), "got: {s:?}"); // fg truecolor
        assert!(s.contains("\x1b[48;5;4m"), "got: {s:?}"); // bg palette 4
    }

    #[test]
    fn flush_diff_applies_modifiers() {
        let bold = Style::new().add_modifier(Modifiers::BOLD);
        let dim = Style::new().add_modifier(Modifiers::DIM);
        let out = flush(&[update(0, 0, 'a', bold, 1, false), update(1, 0, 'b', dim, 1, false)], (0, 0));
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("\x1b[1m"), "got: {s:?}"); // bold
        assert!(s.contains("\x1b[2m"), "got: {s:?}"); // dim
    }

    #[test]
    fn flush_diff_clears_masked_cells_and_keeps_wide_chars() {
        let out = flush(
            &[
                update(0, 0, '\0', Style::new(), 0, true), // masked continuation
                update(1, 0, 'コ', Style::new(), 2, false), // wide lead
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // The masked cell at (0,0) is printed as a space...
        assert!(s.contains("\x1b[1;1H\x1b[0m "), "got: {s:?}");
        // ...and the wide glyph at (1,0) prints raw.
        assert!(s.contains('コ'), "got: {s:?}");
    }

    /// Flush the caret state against an in-memory buffer and return the bytes.
    fn flush_caret(cursor: Cursor) -> Vec<u8> {
        let mut out = Vec::new();
        flush_cursor_to(&mut out, cursor).expect("flush should succeed");
        out
    }

    #[test]
    fn flush_caret_moves_to_position_and_hides() {
        let out = flush_caret(Cursor::new(3, 2).hide());
        let s = String::from_utf8(out).unwrap();
        // MoveTo(3, 2) is 1-based -> row 3, column 4.
        assert!(s.starts_with("\x1b[3;4H"), "got: {s:?}");
        // Hide is DECTCEM off; the trailing resets leave the style clean.
        assert!(s.contains("\x1b[?25l"), "got: {s:?}");
        assert!(s.ends_with("\x1b[0m\x1b[0m"), "got: {s:?}");
    }

    #[test]
    fn flush_caret_moves_to_position_and_shows() {
        let out = flush_caret(Cursor::new(0, 0).show());
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("\x1b[1;1H"), "got: {s:?}");
        assert!(s.contains("\x1b[?25h"), "got: {s:?}");
        assert!(!s.contains("\x1b[?25l"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_with_caret_emits_cells_then_caret_state() {
        let mut out = Vec::new();
        let updates = [update(0, 0, 'x', Style::new(), 1, false)];
        let caret = Cursor::new(5, 4).styled(Style::new().add_modifier(Modifiers::REVERSED));
        flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
        let s = String::from_utf8(out).unwrap();
        // Cells are queued first (MoveTo + reset + char)...
        assert!(s.contains("\x1b[1;1H\x1b[0mx"), "got: {s:?}");
        // ...then the caret: MoveTo(5, 4) -> row 5, column 6, then Show.
        assert!(s.ends_with("\x1b[5;6H\x1b[?25h\x1b[0m\x1b[0m"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_with_caret_hides_a_hidden_caret() {
        let mut out = Vec::new();
        let updates = [update(1, 0, 'y', Style::new(), 1, false)];
        let caret = Cursor::hidden().at(2, 2);
        flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
        let s = String::from_utf8(out).unwrap();
        // The hidden caret still moves (MoveTo(2, 2) -> row 3, column 3),
        // then hides instead of showing.
        assert!(s.ends_with("\x1b[3;3H\x1b[?25l\x1b[0m\x1b[0m"), "got: {s:?}");
    }
}
