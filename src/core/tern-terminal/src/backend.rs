//! The terminal backend: a thin wrapper around crossterm.
//!
//! Owns the terminal lifecycle (raw mode, alternate screen), reports the
//! terminal size, and flushes a tern-core [`CellUpdate`] diff to the terminal
//! as a single queued ANSI escape-sequence stream. The diff-aware flush is
//! split out into [`flush_diff_to`] over a generic `Write` so it can be unit
//! tested against an in-memory buffer; the [`Backend`] methods use stdout.
//!
//! Consecutive updates with the same style on the same row at adjacent
//! columns are batched into runs: one `MoveTo`, one unconditional SGR reset
//! (`\x1b[0m`) plus the run's exact style applied once, and the run's
//! characters in a single `Print` call. Style state can never leak from one
//! run to the next, and a run is closed by any style change or column gap.
//!
//! Frame flush also carries the caret: [`flush_diff_with_cursor_to`] moves
//! the terminal cursor to the frame's [`Cursor`] position and shows or hides
//! it per its visibility, so the hardware caret tracks the model.

use std::io::{self, Write};
use std::sync::OnceLock;

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
    self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, SetTitle,
};
use crossterm::{ExecutableCommand, QueueableCommand};
use tern_core::cell::CellUpdate;
use tern_core::color::Color as TernColor;
use tern_core::cursor::Cursor;
use tern_core::style::{Modifiers, Style};

/// The terminal backend.
///
/// Stateless and cheap to copy: crossterm keeps the terminal state globally,
/// so the backend just funnels method calls at it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Backend;

/// The terminal's color capabilities, detected once at first use (see
/// [`capabilities`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendCapabilities {
    /// Whether 24-bit (16M) RGB truecolor is supported.
    pub truecolor: bool,
    /// The size of the terminal's color palette: 16_777_216 when truecolor
    /// is supported, 256 for a 256-color palette, 16 for basic ANSI, 0 when
    /// no color support was detected.
    pub colors: u32,
}

/// The detected capabilities, cached after the first probe.
static CAPABILITIES: OnceLock<BackendCapabilities> = OnceLock::new();

/// The terminal's color capabilities: whether truecolor is supported and the
/// palette size. Detected once via the `supports-color` crate and cached.
///
/// When detection is inconclusive — no color support reported (a non-TTY
/// stream, `NO_COLOR`, or a monochrome terminal) — this defaults to
/// truecolor: the SGR sequences are harmless on terminals that ignore them,
/// and unit tests run without a controlling terminal, so they see the same
/// default.
pub fn capabilities() -> BackendCapabilities {
    *CAPABILITIES.get_or_init(detect_capabilities)
}

/// Probe the terminal via `supports-color` and map the report to
/// [`BackendCapabilities`]. Never reports "no color support": any
/// inconclusive result defaults to truecolor (see [`capabilities`]).
fn detect_capabilities() -> BackendCapabilities {
    match supports_color::on(supports_color::Stream::Stdout) {
        Some(level) if level.has_16m => BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
        },
        Some(level) if level.has_256 => BackendCapabilities {
            truecolor: false,
            colors: 256,
        },
        Some(level) if level.has_basic => BackendCapabilities {
            truecolor: false,
            colors: 16,
        },
        _ => BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
        },
    }
}

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

    /// Set the terminal window title (OSC 0: `ESC ] 0 ; title BEL`).
    pub fn set_title(&self, title: &str) -> io::Result<()> {
        let mut out = io::stdout();
        set_title_to(&mut out, title)
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
    pub fn flush_diff(&self, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> io::Result<()> {
        let mut out = io::stdout();
        flush_diff_to(&mut out, updates, cursor_pos)
    }

    /// Flush a diff of [`CellUpdate`]s to stdout, then position the terminal
    /// caret at the cursor's (`x`, `y`) and show or hide it per
    /// [`Cursor::visible`].
    ///
    /// See [`flush_diff_with_cursor_to`] for the queueing semantics.
    pub fn flush_diff_with_cursor(&self, updates: &[CellUpdate], cursor: Cursor) -> io::Result<()> {
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

/// Set the terminal window title (OSC 0: `ESC ] 0 ; title BEL`) on any
/// `Write` target.
pub fn set_title_to<W: Write>(w: &mut W, title: &str) -> io::Result<()> {
    w.queue(SetTitle(title))?;
    w.flush()
}

/// Queue the renderer's post-raw-mode startup sequence into `w`: the
/// alternate screen (skipped when `use_alt_screen` is `false`), the window
/// title (when `Some`), then event listening — one batch, one flush.
///
/// Write-based so the exact escape bytes are unit-testable without a
/// terminal (the same seam as [`flush_diff_to`]).
pub fn queue_startup_to<W: Write>(
    w: &mut W,
    use_alt_screen: bool,
    title: Option<&str>,
) -> io::Result<()> {
    if use_alt_screen {
        w.queue(EnterAlternateScreen)?;
    }
    if let Some(title) = title {
        w.queue(SetTitle(title))?;
    }
    enable_event_listening_to(w)
}

/// Quantize an RGB triple to the nearest xterm 256-color palette index: the
/// 6x6x6 color cube (indices 16..=231, `16 + 36r + 6g + b` over the levels
/// 0/95/135/175/215/255) plus the grayscale ramp (indices 232..=255,
/// `8 + 10i`). Selection minimizes squared RGB distance across the whole
/// palette, so the cube and grayscale candidates compete fairly.
pub fn rgb_to_ansi256(r: u8, g: u8, b: u8) -> u8 {
    const CUBE_STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let mut best = 16u8;
    let mut best_dist = u32::MAX;
    for (ri, pr) in CUBE_STEPS.iter().enumerate() {
        for (gi, pg) in CUBE_STEPS.iter().enumerate() {
            for (bi, pb) in CUBE_STEPS.iter().enumerate() {
                let dist = sq_dist(r, g, b, *pr, *pg, *pb);
                if dist < best_dist {
                    best_dist = dist;
                    best = (16 + 36 * ri + 6 * gi + bi) as u8;
                }
            }
        }
    }
    for i in 0..24u16 {
        let v = 8 + 10 * i as u8;
        let dist = sq_dist(r, g, b, v, v, v);
        if dist < best_dist {
            best_dist = dist;
            best = (232 + i) as u8;
        }
    }
    best
}

/// The squared RGB distance between two colors.
fn sq_dist(r1: u8, g1: u8, b1: u8, r2: u8, g2: u8, b2: u8) -> u32 {
    let dr = i32::from(r1) - i32::from(r2);
    let dg = i32::from(g1) - i32::from(g2);
    let db = i32::from(b1) - i32::from(b2);
    (dr * dr + dg * dg + db * db) as u32
}

/// Flush a diff of [`CellUpdate`]s to any `Write` target, then park the
/// cursor at `cursor_pos` (column, row), leaving the terminal's style state
/// reset.
///
/// Updates are batched into runs (see [`queue_cells`]): for each run the
/// cursor is moved to the run's first cell, the style is fully reset and
/// re-applied once (fg color, bg color, modifier attributes), and the run's
/// characters are printed in a single call. Masked continuation cells (NUL
/// content) print as spaces to clear their column; zero-width combining
/// marks print raw. The whole batch is queued and flushed once at the end.
pub fn flush_diff_to<W: Write>(
    w: &mut W,
    updates: &[CellUpdate],
    cursor_pos: (u16, u16),
) -> io::Result<()> {
    queue_cells(w, updates)?;
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
/// The cell queueing matches [`flush_diff_to`] (run-batched); the trailing
/// caret control replaces the unconditional park: [`MoveTo`] to the cursor
/// position, then [`Show`] or [`Hide`] per visibility.
pub fn flush_diff_with_cursor_to<W: Write>(
    w: &mut W,
    updates: &[CellUpdate],
    cursor: Cursor,
) -> io::Result<()> {
    queue_cells(w, updates)?;
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

/// Queue the ANSI commands for a batch of cell updates, merging consecutive
/// updates that share a style, a row, and adjacent columns into single runs.
///
/// Each run emits one [`MoveTo`] to its first cell, one SGR style application
/// for the shared style, and all of the run's characters in one [`Print`]
/// call (see [`Run`] for the exact batching rules). A style change or a
/// non-adjacent cell starts a new run.
fn queue_cells<W: Write>(w: &mut W, updates: &[CellUpdate]) -> io::Result<()> {
    let mut iter = updates.iter().peekable();
    while let Some(first) = iter.next() {
        let mut run = Run::start(first);
        while let Some(next) = iter.peek() {
            if run.can_extend(next) {
                run.push(next);
                iter.next();
            } else {
                break;
            }
        }
        run.queue(w)?;
    }
    Ok(())
}

/// A batched run of consecutive same-style [`CellUpdate`]s on one row: one
/// [`MoveTo`] to the run's first cell, one SGR style application for the
/// shared style, and every member's character printed in a single [`Print`]
/// call.
///
/// Members occupy adjacent columns (`x` increases by 1 per member) and share
/// one style. A run closes when the style, the row, or the column adjacency
/// breaks, or when its last member's printed character advances the cursor
/// by other than one column (a wide lead or a combining mark) — so a later
/// member can never land on the wrong column. A masked NUL continuation cell
/// joins its run as a space.
struct Run {
    /// Column of the run's first member (the [`MoveTo`] target).
    x: u16,
    /// Row shared by every member.
    y: u16,
    /// The style shared by every member (applied once per run).
    style: Style,
    /// Column of the run's last member.
    last_x: u16,
    /// Cursor advance of the run's last member's printed character.
    last_advance: u8,
    /// The run's characters, one per member, in column order.
    text: String,
}

impl Run {
    /// A run holding just `update`.
    fn start(update: &CellUpdate) -> Self {
        Run {
            x: update.x,
            y: update.y,
            style: update.style,
            last_x: update.x,
            last_advance: cell_advance(update),
            text: String::from(cell_char(update)),
        }
    }

    /// Whether `update` continues this run: same row, same style, the next
    /// column over, and the run's last member advanced the cursor by exactly
    /// one column so `update`'s character lands on its own column.
    fn can_extend(&self, update: &CellUpdate) -> bool {
        update.y == self.y
            && update.style == self.style
            && update.x.checked_sub(1) == Some(self.last_x)
            && self.last_advance == 1
    }

    /// Append `update`'s character to the run.
    fn push(&mut self, update: &CellUpdate) {
        self.text.push(cell_char(update));
        self.last_x = update.x;
        self.last_advance = cell_advance(update);
    }

    /// Queue the run's ANSI commands: one [`MoveTo`] to the first member,
    /// one SGR style application, then all characters in one [`Print`] call.
    fn queue<W: Write>(&self, w: &mut W) -> io::Result<()> {
        w.queue(MoveTo(self.x, self.y))?;
        // SGR 0 resets colors and attributes; then the run's exact style is
        // applied once, so nothing leaks between runs.
        w.queue(SetAttribute(Attribute::Reset))?;
        queue_color(w, self.style.fg, true)?;
        queue_color(w, self.style.bg, false)?;
        queue_modifiers(w, self.style.modifiers)?;
        w.queue(Print(self.text.as_str()))?;
        Ok(())
    }
}

/// The character an update contributes to its run's `Print` call: a masked
/// continuation cell (NUL) is cleared by printing a space; a zero-width
/// combining mark (non-NUL) is printed raw.
fn cell_char(update: &CellUpdate) -> char {
    if update.masked && update.ch == '\0' {
        ' '
    } else {
        update.ch
    }
}

/// How many terminal columns an update's printed character advances the
/// cursor: 2 for a wide lead, 0 for a combining mark, 1 for everything else
/// (single-width characters and NUL masks, which print as spaces).
fn cell_advance(update: &CellUpdate) -> u8 {
    if update.width == 2 {
        2
    } else if update.width == 0 && update.ch != '\0' {
        0
    } else {
        1
    }
}

/// Queue the foreground (`fg == true`) or background (`fg == false`) color
/// command for a tern-core color, consulting the detected terminal
/// capabilities: `Default` needs no command (the per-cell SGR reset already
/// restored the terminal default), and an `Rgb` color is quantized to the
/// nearest ANSI 256-color index when truecolor is unsupported (or dropped
/// entirely on a palette smaller than 256, where the reset's default
/// remains).
fn queue_color<W: Write>(w: &mut W, color: TernColor, fg: bool) -> io::Result<()> {
    queue_color_with(w, color, fg, capabilities())
}

/// The [`queue_color`] core: like it, but with explicit capabilities, so the
/// quantization path is unit-testable without touching the global probe.
fn queue_color_with<W: Write>(
    w: &mut W,
    color: TernColor,
    fg: bool,
    caps: BackendCapabilities,
) -> io::Result<()> {
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
            if caps.truecolor {
                if fg {
                    w.queue(SetForegroundColor(CrosstermColor::Rgb { r, g, b }))?;
                } else {
                    w.queue(SetBackgroundColor(CrosstermColor::Rgb { r, g, b }))?;
                }
            } else if caps.colors >= 256 {
                // Truecolor unsupported but a 256-color palette is: map to
                // the nearest palette index so the color survives.
                let index = rgb_to_ansi256(r, g, b);
                if fg {
                    w.queue(SetForegroundColor(CrosstermColor::AnsiValue(index)))?;
                } else {
                    w.queue(SetBackgroundColor(CrosstermColor::AnsiValue(index)))?;
                }
            }
            // Fewer than 256 colors: no command — the per-cell reset
            // already restored the terminal default.
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
            s, "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?1004h\x1b[?2004h",
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
            s, "\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1004l\x1b[?2004l",
            "got: {s:?}"
        );
    }

    #[test]
    fn flush_diff_moves_writes_and_parks_cursor() {
        let out = flush(&[update(2, 1, 'x', Style::new(), 1, false)], (0, 0));
        let s = String::from_utf8(out).unwrap();
        // The single cell is its own run: MoveTo(2, 1) (1-based -> row 2,
        // column 3), one SGR reset, then the character.
        assert!(s.contains("\x1b[2;3H\x1b[0mx"), "got: {s:?}");
        // The cursor is parked at the top-left afterwards; the trailing
        // ResetColor and Attribute::Reset both emit SGR 0.
        assert!(s.ends_with("\x1b[1;1H\x1b[0m\x1b[0m"), "got: {s:?}");
        // One SGR reset for the run plus the two trailing resets.
        assert_eq!(s.matches("\x1b[0m").count(), 3, "got: {s:?}");
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
        // Each cell has a distinct style, so each is its own run: one MoveTo
        // + one SGR reset + one color command + the character, in column
        // order. Rgb(1, 2, 3) hits the truecolor path under the test default.
        assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[38;5;1ma"), "got: {s:?}"); // fg palette 1
        assert!(
            s.contains("\x1b[1;2H\x1b[0m\x1b[38;2;1;2;3mb"),
            "got: {s:?}"
        ); // fg truecolor
        assert!(s.contains("\x1b[1;3H\x1b[0m\x1b[48;5;4mc"), "got: {s:?}"); // bg palette 4
    }

    #[test]
    fn flush_diff_applies_modifiers() {
        let bold = Style::new().add_modifier(Modifiers::BOLD);
        let dim = Style::new().add_modifier(Modifiers::DIM);
        let out = flush(
            &[
                update(0, 0, 'a', bold, 1, false),
                update(1, 0, 'b', dim, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // Bold and dim differ, so the adjacent cells split into two runs,
        // each applying its own modifier once.
        assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[1ma"), "got: {s:?}"); // bold
        assert!(s.contains("\x1b[1;2H\x1b[0m\x1b[2mb"), "got: {s:?}"); // dim
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
        // The masked cell at (0,0) joins the run as a space and the wide
        // glyph at (1,0) prints raw, so the pair is ONE run: one MoveTo, one
        // SGR reset, one multi-character Print (" コ").
        assert!(s.starts_with("\x1b[1;1H\x1b[0m コ"), "got: {s:?}");
        // No per-cell MoveTo between the mask and the wide glyph.
        assert!(!s.contains("\x1b[2;2H"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_batches_adjacent_same_style_cells() {
        let out = flush(
            &[
                update(0, 0, 'a', Style::new(), 1, false),
                update(1, 0, 'b', Style::new(), 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // Two adjacent same-style cells merge into ONE run: exactly one
        // MoveTo, one SGR reset, and both characters in one Print call.
        assert!(s.starts_with("\x1b[1;1H\x1b[0mab"), "got: {s:?}");
        // No second MoveTo for the second cell and no SGR between the chars.
        assert!(!s.contains("\x1b[2;2H"), "got: {s:?}");
        assert!(!s.contains("a\x1b[0m"), "got: {s:?}");
        // The full frame: run (MoveTo + one SGR + "ab"), then the cursor
        // park with its two trailing resets.
        assert_eq!(s, "\x1b[1;1H\x1b[0mab\x1b[1;1H\x1b[0m\x1b[0m", "got: {s:?}");
    }

    #[test]
    fn flush_diff_splits_runs_on_gap_and_style_change() {
        // A non-adjacent column breaks the run even with the same style.
        let gap = flush(
            &[
                update(0, 0, 'a', Style::new(), 1, false),
                update(2, 0, 'b', Style::new(), 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(gap).unwrap();
        assert!(s.contains("\x1b[1;1H\x1b[0ma"), "got: {s:?}");
        assert!(s.contains("\x1b[1;3H\x1b[0mb"), "got: {s:?}"); // own MoveTo

        // A wide lead closes its run so the following masked continuation
        // cannot land on the wrong column: コ advances two columns, so the
        // mask at (2,0) must be its own run with its own MoveTo.
        let wide = flush(
            &[
                update(0, 0, 'コ', Style::new(), 2, false), // wide lead
                update(1, 0, '\0', Style::new(), 0, true),  // its mask
                update(2, 0, 'x', Style::new(), 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(wide).unwrap();
        assert!(s.contains("\x1b[1;1H\x1b[0mコ"), "got: {s:?}"); // lead run
                                                                 // Mask and 'x' share one run at the mask's column: " x".
        assert!(s.contains("\x1b[1;2H\x1b[0m x"), "got: {s:?}");
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
        // The single cell is one run (MoveTo + one SGR reset + char)...
        assert!(s.contains("\x1b[1;1H\x1b[0mx"), "got: {s:?}");
        // ...then the caret: MoveTo(5, 4) -> row 5, column 6, then Show,
        // then the trailing style resets.
        assert_eq!(
            s, "\x1b[1;1H\x1b[0mx\x1b[5;6H\x1b[?25h\x1b[0m\x1b[0m",
            "got: {s:?}"
        );
    }

    #[test]
    fn flush_diff_with_caret_hides_a_hidden_caret() {
        let mut out = Vec::new();
        let updates = [update(1, 0, 'y', Style::new(), 1, false)];
        let caret = Cursor::hidden().at(2, 2);
        flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
        let s = String::from_utf8(out).unwrap();
        // The cell run at (1,0) -> row 1, column 2, then the hidden caret
        // still moves (MoveTo(2, 2) -> row 3, column 3) but hides instead of
        // showing, then the trailing style resets.
        assert_eq!(
            s, "\x1b[1;2H\x1b[0my\x1b[3;3H\x1b[?25l\x1b[0m\x1b[0m",
            "got: {s:?}"
        );
    }

    #[test]
    fn rgb_to_ansi256_picks_nearest_palette_index() {
        // Pure red is exactly the cube entry (255, 0, 0) -> 16 + 36*5.
        assert_eq!(rgb_to_ansi256(255, 0, 0), 196);
        // Pure black is exactly (0, 0, 0) -> cube index 16 (the grayscale
        // ramp's darkest is (8, 8, 8), farther away).
        assert_eq!(rgb_to_ansi256(0, 0, 0), 16);
        // Pure white is exactly (255, 255, 255) -> cube index 231.
        assert_eq!(rgb_to_ansi256(255, 255, 255), 231);
        // Mid gray is exactly the ramp value 128 (8 + 10*12) -> index 244,
        // beating the cube's (135, 135, 135) candidate.
        assert_eq!(rgb_to_ansi256(128, 128, 128), 244);
    }

    #[test]
    fn queue_color_keeps_rgb_when_truecolor_supported() {
        let mut out = Vec::new();
        let caps = BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
        };
        queue_color_with(&mut out, TernColor::Rgb(1, 2, 3), true, caps)
            .expect("queue should succeed");
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "\x1b[38;2;1;2;3m", "got: {s:?}");
    }

    #[test]
    fn queue_color_quantizes_rgb_without_truecolor() {
        let mut out = Vec::new();
        // 256-color terminal: the RGB is quantized to the nearest palette
        // index instead of an unsupported truecolor sequence.
        let caps = BackendCapabilities {
            truecolor: false,
            colors: 256,
        };
        queue_color_with(&mut out, TernColor::Rgb(255, 0, 0), true, caps)
            .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[38;5;196m");
        // Background variant goes through the background SGR.
        let mut out = Vec::new();
        queue_color_with(&mut out, TernColor::Rgb(128, 128, 128), false, caps)
            .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[48;5;244m");
    }

    #[test]
    fn queue_color_drops_rgb_on_a_small_palette() {
        // A basic-16-color terminal: no SGR color command at all — the
        // per-cell reset's default stays.
        let mut out = Vec::new();
        let caps = BackendCapabilities {
            truecolor: false,
            colors: 16,
        };
        queue_color_with(&mut out, TernColor::Rgb(255, 0, 0), true, caps)
            .expect("queue should succeed");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn set_title_emits_osc0_title_sequence() {
        let mut out = Vec::new();
        set_title_to(&mut out, "Hello").expect("set title should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b]0;Hello\x07");
    }

    #[test]
    fn startup_enters_alt_screen_sets_title_and_enables_events() {
        let mut out = Vec::new();
        queue_startup_to(&mut out, true, Some("tern")).expect("startup should succeed");
        let s = String::from_utf8(out).unwrap();
        // Alternate screen first, then the title, then event listening.
        assert!(s.starts_with("\x1b[?1049h"), "got: {s:?}");
        assert!(s.contains("\x1b]0;tern\x07"), "got: {s:?}");
        assert!(s.contains("\x1b[?1000h"), "got: {s:?}"); // mouse capture
    }

    #[test]
    fn startup_off_emits_no_enter_alternate_screen_escape() {
        let mut out = Vec::new();
        queue_startup_to(&mut out, false, None).expect("startup should succeed");
        let s = String::from_utf8(out).unwrap();
        // The alternate-screen escape is absent; event listening still runs.
        assert!(!s.contains("\x1b[?1049h"), "got: {s:?}");
        assert!(s.contains("\x1b[?1000h"), "got: {s:?}");
    }
}
