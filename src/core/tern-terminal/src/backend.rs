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

use std::io::{self, Write};

use crossterm::cursor::{Hide, MoveTo, Show};
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
    /// See [`flush_diff_to`] for the queueing semantics.
    pub fn flush_diff(
        &self,
        updates: &[CellUpdate],
        cursor_pos: (u16, u16),
    ) -> io::Result<()> {
        let mut out = io::stdout();
        flush_diff_to(&mut out, updates, cursor_pos)
    }
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
}
