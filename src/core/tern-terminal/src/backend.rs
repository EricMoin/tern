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

use std::io::{self, Write};
use std::sync::OnceLock;

use crossterm::cursor::{Hide, MoveTo, SetCursorStyle, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
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
}

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
    /// Whether kitty's extended underline styles are supported (`\x1b[4:Nm`
    /// style variants and `\x1b[58;...m` colored underlines). Detected once
    /// from the environment (see [`detect_underline_styles`]); unknown
    /// terminals default to `false` and take the plain `\x1b[4m` fallback.
    pub underline_styles: bool,
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
/// inconclusive result defaults to truecolor (see [`capabilities`]). The
/// extended-underline flag is probed separately from the environment (see
/// [`detect_underline_styles`]) — the `supports-color` crate has no opinion
/// on kitty SGR extensions.
fn detect_capabilities() -> BackendCapabilities {
    let mut caps = match supports_color::on(supports_color::Stream::Stdout) {
        Some(level) if level.has_16m => BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
            underline_styles: false,
        },
        Some(level) if level.has_256 => BackendCapabilities {
            truecolor: false,
            colors: 256,
            underline_styles: false,
        },
        Some(level) if level.has_basic => BackendCapabilities {
            truecolor: false,
            colors: 16,
            underline_styles: false,
        },
        _ => BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
            underline_styles: false,
        },
    };
    caps.underline_styles = detect_underline_styles();
    caps
}

/// Whether the terminal supports kitty's extended underline styles
/// (`\x1b[4:Nm` style variants and colored underlines `\x1b[58;...m`),
/// probed from the environment: `TERM_PROGRAM` naming a known-supporting
/// terminal (kitty, WezTerm, iTerm.app, ghostty) or a `TERM` containing
/// "kitty" (kitty sets `TERM=xterm-kitty`). Unknown terminals default to
/// `false` so they take the plain-underline fallback — every terminal
/// underlines, only the styling degrades.
fn detect_underline_styles() -> bool {
    let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    if matches!(
        term_program.as_str(),
        "kitty" | "WezTerm" | "iTerm.app" | "ghostty"
    ) {
        return true;
    }
    let term = std::env::var("TERM").unwrap_or_default();
    term.contains("kitty")
}

/// A `Write` wrapper that counts the bytes written through it, so the
/// backend can report how many bytes a frame flush queued to the terminal.
/// The count covers every byte the queueing writes (MoveTo / SGR / Print
/// sequences) plus whatever the trailing flush pushes out.
struct CountingWriter<W> {
    inner: W,
    bytes: usize,
}

impl<W> CountingWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner, bytes: 0 }
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes += n;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Backend {
    /// A fresh backend, with no park position recorded yet.
    pub const fn new() -> Self {
        Self {
            last_flush_pos: None,
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

    /// Enable the kitty keyboard protocol (progressive enhancement,
    /// DISAMBIGUATE_ESCAPE_CODES) so modifier combinations like Shift-Enter
    /// are reported distinctly instead of collapsing into the unmodified
    /// key. Terminals that do not support the protocol ignore the sequence.
    /// Pair with [`exit_keyboard_enhancement`](Backend::exit_keyboard_enhancement).
    pub fn enter_keyboard_enhancement(&self) -> io::Result<()> {
        let mut out = io::stdout();
        out.execute(PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES,
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

/// Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
/// BEL`) on any `Write` target.
///
/// The escape is `ESC ] 52 ; c ; <payload> BEL` — OSC 52 with the selection
/// parameter `c` (the clipboard) and the payload as the text's UTF-8 bytes
/// base64-encoded per RFC 4648 (the standard xterm "Manipulate Selection
/// Data" protocol). BEL (`\x07`) terminates the OSC string, matching the
/// project's OSC 0 title convention; a terminal accepts BEL or ST (`ESC \`)
/// interchangeably as the OSC terminator. crossterm's own clipboard command
/// is gated behind its off-by-default `osc52` feature and emits the ST
/// terminator, so the sequence is written through the queue directly rather
/// than queued as a crossterm command.
pub fn set_clipboard_to<W: Write>(w: &mut W, text: &str) -> io::Result<()> {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    w.write_all(b"\x1b]52;c;")?;
    w.write_all(encoded.as_bytes())?;
    w.write_all(b"\x07")?;
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
/// characters are printed in a single call — except that a run whose style
/// equals the previously queued run's skips the redundant reset/re-apply,
/// since the terminal's style state is already that style. Masked
/// continuation cells (NUL content) print as spaces to clear their column;
/// zero-width combining marks print raw. The whole batch is queued and
/// flushed once at the end.
///
/// An empty diff short-circuits the flush. `last_flush_pos` records the park
/// position written by the most recent non-skipped flush (starting `None`).
/// When `updates` is empty and `last_flush_pos` already holds `cursor_pos`,
/// nothing is queued and [`flush`](Write::flush) is not called — the frame
/// is a no-op. When `updates` is empty but the park position differs (or was
/// never recorded), only the `MoveTo` is queued and flushed, and
/// `last_flush_pos` is updated. When `updates` is non-empty, the run-batched
/// output below is emitted exactly as before and `last_flush_pos` is updated.
pub fn flush_diff_to<W: Write>(
    w: &mut W,
    updates: &[CellUpdate],
    cursor_pos: (u16, u16),
    last_flush_pos: &mut Option<(u16, u16)>,
) -> io::Result<()> {
    if updates.is_empty() {
        // No cells changed this frame. If the caret is already parked where
        // the frame wants it, there is nothing to do — not even a flush. If
        // only the park position moved (or was never recorded), emit the
        // move alone: the style state is already clean from the previous
        // flush and nothing is printed, so no style commands are needed.
        if *last_flush_pos == Some(cursor_pos) {
            return Ok(());
        }
        w.queue(MoveTo(cursor_pos.0, cursor_pos.1))?;
        w.flush()?;
        *last_flush_pos = Some(cursor_pos);
        return Ok(());
    }
    queue_cells(w, updates)?;
    w.queue(MoveTo(cursor_pos.0, cursor_pos.1))?;
    // Leave the terminal's style state clean for whatever prints next.
    w.queue(ResetColor)?;
    w.queue(SetAttribute(Attribute::Reset))?;
    w.flush()?;
    *last_flush_pos = Some(cursor_pos);
    Ok(())
}

/// Flush a diff of [`CellUpdate`]s to any `Write` target, then position the
/// terminal caret at the cursor's (`x`, `y`), apply its shape / blinking
/// `SetCursorStyle` (nothing for the default steady block), and show or hide
/// it per [`Cursor::visible`], leaving the terminal's style state reset.
///
/// The cell queueing matches [`flush_diff_to`] (run-batched); the trailing
/// caret control replaces the unconditional park: [`MoveTo`] to the cursor
/// position, the conditional `SetCursorStyle`, then [`Show`] or [`Hide`] per
/// visibility.
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
/// target, applying its shape / blinking `SetCursorStyle` (nothing for the
/// default steady block), showing or hiding it per [`Cursor::visible`], and
/// leave the terminal's style state reset.
pub fn flush_cursor_to<W: Write>(w: &mut W, cursor: Cursor) -> io::Result<()> {
    queue_cursor(w, cursor)?;
    w.flush()
}

/// The DECSCUSR style (the crossterm `SetCursorStyle` variant) for a
/// (shape, blinking) pair: each shape has a blinking and a steady code
/// (`\x1b[1 q` .. `\x1b[6 q`). The caller decides whether to emit it at all —
/// a steady block is the terminal's default, so it is never queued.
fn cursor_style(shape: CursorShape, blinking: bool) -> SetCursorStyle {
    match (shape, blinking) {
        (CursorShape::Block, true) => SetCursorStyle::BlinkingBlock,
        (CursorShape::Block, false) => SetCursorStyle::SteadyBlock,
        (CursorShape::Bar, true) => SetCursorStyle::BlinkingBar,
        (CursorShape::Bar, false) => SetCursorStyle::SteadyBar,
        (CursorShape::Underline, true) => SetCursorStyle::BlinkingUnderScore,
        (CursorShape::Underline, false) => SetCursorStyle::SteadyUnderScore,
    }
}

/// Queue the caret state: move to the cursor's position, conditionally apply
/// the DECSCUSR shape / blinking style, show or hide it per visibility, then
/// reset the terminal's style state.
///
/// The `SetCursorStyle` sequence (`\x1b[<n> q`) is emitted only when the
/// cursor differs from the terminal's default caret — a steady block — i.e.
/// when the shape is not a block or the blink flag is set. A steady-block
/// cursor emits nothing, so every flush that never requested a shape or blink
/// stays byte-identical to before the style existed. The style lands between
/// the [`MoveTo`] and the [`Show`] / [`Hide`], matching the crossterm
/// command ordering for caret control.
fn queue_cursor<W: Write>(w: &mut W, cursor: Cursor) -> io::Result<()> {
    w.queue(MoveTo(cursor.x, cursor.y))?;
    if cursor.shape != CursorShape::Block || cursor.blinking {
        w.queue(cursor_style(cursor.shape, cursor.blinking))?;
    }
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
/// non-adjacent cell starts a new run. The style of the most recently queued
/// run is tracked across the batch: a run whose style equals it skips the
/// SGR block entirely, because nothing between two runs (only `MoveTo` and
/// `Print`) alters the terminal's style state. The first run of a flush
/// always applies its full style block.
fn queue_cells<W: Write>(w: &mut W, updates: &[CellUpdate]) -> io::Result<()> {
    let mut iter = updates.iter().peekable();
    // The style fully applied by the most recently queued run, `None` before
    // the first run of the flush so that run always emits its full style
    // block. A run whose style equals this one skips the redundant SGR
    // reset/re-apply (see [`Run::queue`]).
    let mut last_style: Option<Style> = None;
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
        run.queue(w, &mut last_style)?;
    }
    Ok(())
}

/// A batched run of consecutive same-style [`CellUpdate`]s on one row: one
/// [`MoveTo`] to the run's first cell, one SGR style application for the
/// shared style (skipped when the previously queued run applied the same
/// style — see [`Run::queue`]), and every member's text printed in a single
/// [`Print`] call.
///
/// Members occupy adjacent columns (`x` increases by 1 per member) and share
/// one style. A run closes when the style, the row, or the column adjacency
/// breaks, or when its last member's printed text advances the cursor by
/// other than one column (a 2-column cluster lead or a combining mark) — so a
/// later member can never land on the wrong column. A masked NUL continuation
/// cell joins its run as a space. A run whose style carries a hyperlink wraps
/// its text in OSC 8 open/close sequences (see [`Run::queue`]).
struct Run {
    /// Column of the run's first member (the [`MoveTo`] target).
    x: u16,
    /// Row shared by every member.
    y: u16,
    /// The style shared by every member (applied once per run).
    style: Style,
    /// Column of the run's last member.
    last_x: u16,
    /// Cursor advance of the run's last member's printed text.
    last_advance: u8,
    /// The run's text, one cluster per member, in column order. A multi-char
    /// cluster prints its full symbol string once.
    text: String,
}

impl Run {
    /// A run holding just `update`.
    fn start(update: &CellUpdate) -> Self {
        Run {
            x: update.x,
            y: update.y,
            style: update.style.clone(),
            last_x: update.x,
            last_advance: cell_advance(update),
            text: cell_text(update),
        }
    }

    /// Whether `update` continues this run: same row, same style, the next
    /// column over, and the run's last member advanced the cursor by exactly
    /// one column so `update`'s text lands on its own column.
    fn can_extend(&self, update: &CellUpdate) -> bool {
        update.y == self.y
            && update.style == self.style
            && update.x.checked_sub(1) == Some(self.last_x)
            && self.last_advance == 1
    }

    /// Append `update`'s text to the run.
    fn push(&mut self, update: &CellUpdate) {
        self.text.push_str(&cell_text(update));
        self.last_x = update.x;
        self.last_advance = cell_advance(update);
    }

    /// Queue the run's ANSI commands: one [`MoveTo`] to the first member,
    /// one SGR style application, then all characters in one [`Print`] call.
    ///
    /// `last_style` tracks the style fully applied by the most recently
    /// queued run in this flush (initially `None`). When this run's style
    /// equals it, the SGR block is skipped — only `MoveTo` and `Print` have
    /// been emitted since, and neither alters the terminal's style state —
    /// so the run's characters are queued directly. Otherwise (including the
    /// first run of a flush) the full reset + style block is queued and
    /// `last_style` is updated.
    ///
    /// A run whose style carries a hyperlink wraps its `Print` in OSC 8
    /// sequences: the open (`\x1b]8;;<url>\x1b\\`) is written raw before the
    /// characters and the close (`\x1b]8;;\x1b\\`) raw after them. crossterm
    /// has no hyperlink command, so the escapes go through the `Write`
    /// directly (the same seam as [`set_clipboard_to`]); they never touch
    /// the run's text, so they cannot split runs or leak into `cell_text`.
    /// Because the close follows every linked run, a later unlinked run —
    /// whose style necessarily differs, since the hyperlink participates in
    /// [`Style`] equality — can never inherit the link.
    fn queue<W: Write>(&self, w: &mut W, last_style: &mut Option<Style>) -> io::Result<()> {
        w.queue(MoveTo(self.x, self.y))?;
        if last_style.as_ref() != Some(&self.style) {
            // SGR 0 resets colors and attributes; then the run's exact style
            // is applied once, so nothing leaks between runs.
            w.queue(SetAttribute(Attribute::Reset))?;
            queue_color(w, self.style.fg, true)?;
            queue_color(w, self.style.bg, false)?;
            queue_underline(w, &self.style)?;
            // The extended underline path ([`queue_underline_with`]) owns the
            // underline whenever a style variant or color is set: drop the
            // legacy bit here so the modifier pass cannot clobber the
            // extended sequence (`\x1b[4:Nm` / `\x1b[58;...m`) with a plain
            // `\x1b[4m`. A style carrying only the legacy bit keeps it — the
            // modifier pass emits `Attribute::Underlined` exactly as before.
            let modifiers = if extended_underline(&self.style) {
                self.style.modifiers.remove(Modifiers::UNDERLINE)
            } else {
                self.style.modifiers
            };
            queue_modifiers(w, modifiers)?;
            *last_style = Some(self.style.clone());
        }
        if let Some(url) = &self.style.hyperlink {
            // OSC 8 hyperlink open: ESC ] 8 ; ; <url> ST.
            w.write_all(b"\x1b]8;;")?;
            w.write_all(url.as_bytes())?;
            w.write_all(b"\x1b\\")?;
        }
        w.queue(Print(self.text.as_str()))?;
        if self.style.hyperlink.is_some() {
            // OSC 8 hyperlink close (empty parameters): ESC ] 8 ; ; ST.
            w.write_all(b"\x1b]8;;\x1b\\")?;
        }
        Ok(())
    }
}

/// The text an update contributes to its run's `Print` call: a masked
/// continuation cell (NUL) is cleared by printing a space; a multi-char
/// grapheme cluster prints its full symbol string once; a single-char cluster
/// prints its character; a zero-width combining mark (non-NUL) prints raw.
fn cell_text(update: &CellUpdate) -> String {
    if update.masked && update.ch == '\0' {
        " ".to_string()
    } else if let Some(symbol) = &update.symbol {
        symbol.to_string()
    } else {
        update.ch.to_string()
    }
}

/// How many terminal columns an update's printed text advances the cursor:
/// 2 for a 2-column cluster lead, 0 for a combining mark, 1 for everything
/// else (single-width clusters and NUL masks, which print as spaces).
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

/// Queue the underline commands for a tern-core style's extended underline
/// fields (the `underline_style` variant and the `underline_color`),
/// consulting the detected terminal capabilities.
///
/// A style carrying only the legacy `Modifiers::UNDERLINE` bit (no variant,
/// no color) queues nothing here — [`queue_modifiers`] emits
/// `Attribute::Underlined` for it exactly as before, so untouched styles stay
/// byte-identical. A style with a variant or a color takes the extended path:
/// kitty's `\x1b[4:Nm` (1 single, 2 double, 3 curly, 4 dotted, 5 dashed) plus
/// the colored underline `\x1b[58;...m` when the terminal reports extended
/// underline support, and the plain `\x1b[4m` underline otherwise — the text
/// stays underlined, only the styling degrades.
fn queue_underline<W: Write>(w: &mut W, style: &Style) -> io::Result<()> {
    queue_underline_with(w, style, capabilities())
}

/// The [`queue_underline`] core: like it, but with explicit capabilities, so
/// the extended-SGR and fallback paths are unit-testable without touching
/// the global probe.
fn queue_underline_with<W: Write>(
    w: &mut W,
    style: &Style,
    caps: BackendCapabilities,
) -> io::Result<()> {
    if !extended_underline(style) {
        return Ok(());
    }
    if caps.underline_styles {
        // Kitty extended underline style: ESC [ 4 : N m. crossterm has no
        // command for it, so the sequence goes through the `Write` directly
        // (the same seam as the OSC 8 hyperlink open/close).
        let n = match style.underline_style {
            UnderlineStyle::None => None, // color-only underline
            UnderlineStyle::Single => Some(1),
            UnderlineStyle::Double => Some(2),
            UnderlineStyle::Curly => Some(3),
            UnderlineStyle::Dotted => Some(4),
            UnderlineStyle::Dashed => Some(5),
        };
        if let Some(n) = n {
            w.write_all(b"\x1b[4:")?;
            w.write_all(&[b'0' + n])?;
            w.write_all(b"m")?;
        }
        // Kitty colored underline: ESC [ 58 ; 2 ; r ; g ; b m (truecolor) or
        // ESC [ 58 ; 5 ; n m (palette). A default color needs no command —
        // the per-run SGR reset already restored the terminal default.
        match style.underline_color {
            Some(TernColor::Rgb(r, g, b)) => {
                w.write_all(b"\x1b[58;2;")?;
                w.write_all(format!("{r};{g};{b}").as_bytes())?;
                w.write_all(b"m")?;
            }
            Some(TernColor::Indexed(n)) => {
                w.write_all(b"\x1b[58;5;")?;
                w.write_all(format!("{n}").as_bytes())?;
                w.write_all(b"m")?;
            }
            Some(TernColor::Default) | None => {}
        }
    } else {
        // No extended underline support: degrade to the plain underline so
        // the text is still underlined.
        w.queue(SetAttribute(Attribute::Underlined))?;
    }
    Ok(())
}

/// Whether `style` requests an extended underline: a variant other than
/// [`UnderlineStyle::None`], or a non-default underline color. This is the
/// condition that routes the run's underline through
/// [`queue_underline_with`]'s extended/fallback path instead of the legacy
/// `Modifiers::UNDERLINE` bit (which [`queue_modifiers`] emits as plain
/// `\x1b[4m`).
fn extended_underline(style: &Style) -> bool {
    style.underline_style != UnderlineStyle::None
        || matches!(
            style.underline_color,
            Some(TernColor::Rgb(..)) | Some(TernColor::Indexed(_))
        )
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
    /// Each call starts with an unknown prior park position, so the empty-diff
    /// fast path never suppresses a single-shot flush.
    fn flush(updates: &[CellUpdate], cursor_pos: (u16, u16)) -> Vec<u8> {
        let mut out = Vec::new();
        let mut last_flush_pos = None;
        flush_diff_to(&mut out, updates, cursor_pos, &mut last_flush_pos)
            .expect("flush should succeed");
        out
    }

    fn update(x: u16, y: u16, ch: char, style: Style, width: u8, masked: bool) -> CellUpdate {
        CellUpdate {
            x,
            y,
            ch,
            symbol: None,
            style,
            width,
            masked,
        }
    }

    /// A cluster update: the lead cell of a multi-char grapheme cluster.
    fn cluster_update(
        x: u16,
        y: u16,
        ch: char,
        symbol: &str,
        style: Style,
        width: u8,
    ) -> CellUpdate {
        CellUpdate {
            x,
            y,
            ch,
            symbol: Some(symbol.into()),
            style,
            width,
            masked: false,
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
    fn flush_diff_prints_zwj_cluster_symbol_once() {
        // A ZWJ family emoji is a single 2-column grapheme cluster. The diff
        // emits its lead update (carrying the full cluster symbol) followed by
        // the masked continuation cell. The flush must print the FULL cluster
        // string exactly once — never the lead char alone, never a re-split.
        let style = Style::new();
        let out = flush(
            &[
                cluster_update(0, 0, '👨', "👨‍👩‍👧‍👦", style.clone(), 2), // cluster lead
                update(1, 0, '\0', style.clone(), 0, true),               // its mask
                update(2, 0, 'x', style, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // The lead is its own run (advances 2, so the mask cannot extend it):
        // one MoveTo, one SGR reset, and the full cluster in one Print. The
        // mask + 'x' share the next run: " x".
        assert!(s.starts_with("\x1b[1;1H\x1b[0m👨‍👩‍👧‍👦"), "got: {s:?}");
        assert!(s.contains("\x1b[1;2H x"), "got: {s:?}");
        // The cluster string appears exactly once in the whole frame.
        assert_eq!(s.matches("👨‍👩‍👧‍👦").count(), 1, "got: {s:?}");
    }

    #[test]
    fn flush_diff_prints_combining_sequence_symbol_once() {
        // A base + combining mark is ONE 1-column cluster: it prints its full
        // symbol and advances one column, so the following cell can extend the
        // same run — one Print holds the whole combining sequence plus the
        // next glyph.
        let style = Style::new();
        let out = flush(
            &[
                cluster_update(0, 0, 'e', "e\u{301}", style.clone(), 1), // combining seq
                update(1, 0, 'a', style, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("\x1b[1;1H\x1b[0me\u{301}a"), "got: {s:?}");
        assert_eq!(s.matches("e\u{301}").count(), 1, "got: {s:?}");
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
        // A non-adjacent column breaks the run even with the same style: the
        // second run still gets its own MoveTo, but its style equals the
        // first run's, so the redundant SGR block is skipped.
        let gap = flush(
            &[
                update(0, 0, 'a', Style::new(), 1, false),
                update(2, 0, 'b', Style::new(), 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(gap).unwrap();
        assert!(s.contains("\x1b[1;1H\x1b[0ma"), "got: {s:?}");
        assert!(s.contains("\x1b[1;3Hb"), "got: {s:?}"); // own MoveTo, no SGR
        assert!(!s.contains("\x1b[1;3H\x1b[0m"), "got: {s:?}");

        // A wide lead closes its run so the following masked continuation
        // cannot land on the wrong column: コ advances two columns, so the
        // mask at (2,0) must be its own run with its own MoveTo. The mask
        // run shares the lead's style, so it skips the SGR block too.
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
        assert!(s.contains("\x1b[1;2H x"), "got: {s:?}");
        assert!(!s.contains("\x1b[1;2H\x1b[0m"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_skips_sgr_between_same_style_runs() {
        // Two runs separated by a column gap but sharing one style: the
        // first run applies the full SGR block (reset + fg), the second
        // emits only its MoveTo and characters — the terminal's style state
        // is already correct. Exactly one reset+style sequence is emitted.
        let fg1 = Style::new().fg(TernColor::Indexed(1));
        let out = flush(
            &[
                update(0, 0, 'a', fg1.clone(), 1, false),
                update(2, 0, 'b', fg1, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // One SGR reset for the first run plus the two trailing resets; the
        // second run contributes no SGR at all.
        assert_eq!(s.matches("\x1b[0m").count(), 3, "got: {s:?}");
        // The style is applied exactly once, in the first run's block.
        assert_eq!(s.matches("\x1b[38;5;1m").count(), 1, "got: {s:?}");
        assert_eq!(
            s, "\x1b[1;1H\x1b[0m\x1b[38;5;1ma\x1b[1;3Hb\x1b[1;1H\x1b[0m\x1b[0m",
            "got: {s:?}"
        );
    }

    #[test]
    fn flush_diff_reapplies_sgr_on_style_change_between_runs() {
        // fg1 -> fg2 -> fg1 across three gapped runs: the middle run differs
        // from the first, so it emits its own full block; the third run's
        // style equals the FIRST's, but the terminal state after the middle
        // run is fg2, so the third must re-apply its full block too — the
        // merge tracks the most recently applied style, not any seen style.
        let fg1 = Style::new().fg(TernColor::Indexed(1));
        let fg2 = Style::new().fg(TernColor::Indexed(2));
        let out = flush(
            &[
                update(0, 0, 'a', fg1.clone(), 1, false),
                update(2, 0, 'b', fg2, 1, false),
                update(4, 0, 'c', fg1, 1, false),
            ],
            (0, 0),
        );
        let s = String::from_utf8(out).unwrap();
        // Each run emits its own SGR reset (3) plus the two trailing resets.
        assert_eq!(s.matches("\x1b[0m").count(), 5, "got: {s:?}");
        // fg1 is re-applied for the third run (terminal state is fg2 after
        // the middle run); fg2 is applied once.
        assert_eq!(s.matches("\x1b[38;5;1m").count(), 2, "got: {s:?}");
        assert_eq!(s.matches("\x1b[38;5;2m").count(), 1, "got: {s:?}");
        assert_eq!(
            s,
            "\x1b[1;1H\x1b[0m\x1b[38;5;1ma\x1b[1;3H\x1b[0m\x1b[38;5;2mb\x1b[1;5H\x1b[0m\x1b[38;5;1mc\x1b[1;1H\x1b[0m\x1b[0m",
            "got: {s:?}"
        );
    }

    #[test]
    fn flush_diff_wraps_linked_run_in_osc8_hyperlink() {
        // A cell styled with a hyperlink is its own run whose Print is
        // wrapped: the OSC 8 open (ESC ] 8 ; ; <url> ST) precedes the
        // character and the close (ESC ] 8 ; ; ST) follows it — the raw
        // escapes land between the run's SGR reset and the cursor park, via
        // the same seam as the OSC 52 clipboard write.
        let linked = Style::new().hyperlink(Some("https://example.com".into()));
        let out = flush(&[update(0, 0, 'l', linked, 1, false)], (0, 0));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b[1;1H\x1b[0m\x1b]8;;https://example.com\x1b\\l\x1b]8;;\x1b\\\x1b[1;1H\x1b[0m\x1b[0m",
            "the linked text must be wrapped in OSC 8 open/close"
        );
    }

    #[test]
    fn flush_diff_unlinked_run_emits_no_osc8() {
        // A linked cell followed by an unlinked adjacent cell: the styles
        // differ (the hyperlink participates in style equality), so each is
        // its own run. The linked run wraps its 'l' in OSC 8 and closes
        // before the next run starts; the unlinked run prints with no OSC 8
        // sequence at all — the link cannot leak onto it.
        let linked = Style::new().hyperlink(Some("https://example.com".into()));
        let out = flush(
            &[
                update(0, 0, 'l', linked, 1, false),
                update(1, 0, 'p', Style::new(), 1, false),
            ],
            (0, 0),
        );
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b[1;1H\x1b[0m\x1b]8;;https://example.com\x1b\\l\x1b]8;;\x1b\\\x1b[1;2H\x1b[0mp\x1b[1;1H\x1b[0m\x1b[0m",
            "only the linked run wraps in OSC 8"
        );
    }

    #[test]
    fn empty_diff_with_same_park_writes_nothing() {
        let mut out = Vec::new();
        let mut last_flush_pos = None;
        // Seed the recorded park position with a real frame at (2, 3).
        flush_diff_to(
            &mut out,
            &[update(0, 0, 'x', Style::new(), 1, false)],
            (2, 3),
            &mut last_flush_pos,
        )
        .expect("flush should succeed");
        assert!(!out.is_empty(), "seed flush should write cells");
        out.clear();

        // An empty diff parked at the recorded position: zero bytes written
        // and no flush — the frame is a complete no-op.
        flush_diff_to(&mut out, &[], (2, 3), &mut last_flush_pos).expect("flush should succeed");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn empty_diff_with_moved_park_emits_only_move_to() {
        let mut out = Vec::new();
        let mut last_flush_pos = None;
        flush_diff_to(
            &mut out,
            &[update(0, 0, 'x', Style::new(), 1, false)],
            (0, 0),
            &mut last_flush_pos,
        )
        .expect("flush should succeed");
        out.clear();

        // The park moved from (0, 0) to (5, 4): only the MoveTo (1-based row
        // 5, column 6) is queued — no cells, no style commands.
        flush_diff_to(&mut out, &[], (5, 4), &mut last_flush_pos).expect("flush should succeed");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b[5;6H",
            "got: {:?}",
            out
        );

        // The new position is recorded, so the next empty frame parked at
        // the same spot is suppressed again.
        out.clear();
        flush_diff_to(&mut out, &[], (5, 4), &mut last_flush_pos).expect("flush should succeed");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn empty_diff_with_unknown_park_emits_move_to() {
        // Before any flush the recorded park is unknown (`None`), so even an
        // empty first frame must move the caret: (3, 1) -> row 4, column 2.
        let mut out = Vec::new();
        let mut last_flush_pos = None;
        flush_diff_to(&mut out, &[], (3, 1), &mut last_flush_pos).expect("flush should succeed");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b[2;4H",
            "got: {:?}",
            out
        );
        assert_eq!(last_flush_pos, Some((3, 1)));
    }

    #[test]
    fn non_empty_diff_output_is_unchanged_and_records_park() {
        // The run-batched output must be byte-identical to the pre-suppression
        // behavior (mirrors `flush_diff_batches_adjacent_same_style_cells`),
        // and the park position is recorded for the next frame.
        let mut out = Vec::new();
        let mut last_flush_pos = None;
        flush_diff_to(
            &mut out,
            &[
                update(0, 0, 'a', Style::new(), 1, false),
                update(1, 0, 'b', Style::new(), 1, false),
            ],
            (0, 0),
            &mut last_flush_pos,
        )
        .expect("flush should succeed");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b[1;1H\x1b[0mab\x1b[1;1H\x1b[0m\x1b[0m",
            "got: {:?}",
            out
        );
        assert_eq!(last_flush_pos, Some((0, 0)));
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
    fn flush_caret_emits_no_style_for_the_default_cursor() {
        // The default caret — block shape, no blink — IS the terminal's own
        // default, so no DECSCUSR sequence is queued: the byte stream is
        // exactly what the pre-cursor-style backend produced (MoveTo, then
        // Show/Hide, then the trailing resets). This is the byte-identical
        // guarantee every existing flush relies on.
        let shown = flush_caret(Cursor::new(0, 0).show());
        assert_eq!(
            String::from_utf8(shown.clone()).unwrap(),
            "\x1b[1;1H\x1b[?25h\x1b[0m\x1b[0m",
            "got: {shown:?}"
        );
        // The `block()` builder spells the same state explicitly and must
        // also emit nothing.
        let blocked = flush_caret(Cursor::new(0, 0).block());
        assert_eq!(blocked, shown, "got: {blocked:?}");
        // No `\x1b[<n> q` sequence may appear for the default caret.
        assert!(!String::from_utf8(shown.clone()).unwrap().contains(" q"), "got: {shown:?}");
    }

    #[test]
    fn flush_caret_emits_decsusr_style_per_shape_and_blink() {
        // Each non-default (shape, blinking) pair maps to its DECSCUSR code,
        // queued between the MoveTo and the Show: block+blink -> `\x1b[1 q`,
        // underline steady -> `\x1b[4 q`, underline blink -> `\x1b[3 q`,
        // bar blink -> `\x1b[5 q`, bar steady -> `\x1b[6 q`. A steady block
        // (the terminal default) is covered by
        // [`flush_caret_emits_no_style_for_the_default_cursor`].
        let cases: &[(Cursor, &str)] = &[
            (Cursor::new(0, 0).show().blink(), "\x1b[1 q"),
            (Cursor::new(0, 0).show().bar(), "\x1b[6 q"),
            (Cursor::new(0, 0).show().bar().blink(), "\x1b[5 q"),
            (Cursor::new(0, 0).show().underline(), "\x1b[4 q"),
            (Cursor::new(0, 0).show().underline().blink(), "\x1b[3 q"),
        ];
        for (caret, style) in cases {
            let s = String::from_utf8(flush_caret(caret.clone())).unwrap();
            // The style lands after the MoveTo and before the Show.
            assert_eq!(
                s, format!("\x1b[1;1H{style}\x1b[?25h\x1b[0m\x1b[0m"),
                "cursor {caret:?} must emit {style:?}, got: {s:?}"
            );
        }
    }

    #[test]
    fn flush_caret_emits_style_for_a_hidden_non_default_caret() {
        // The shape / blinking style is emitted regardless of visibility: a
        // hidden bar cursor still queues its `\x1b[6 q` between the MoveTo
        // and the Hide, so a later Show (in a later frame) keeps the shape.
        let out = flush_caret(Cursor::hidden().at(1, 1).bar());
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b[2;2H\x1b[6 q\x1b[?25l\x1b[0m\x1b[0m",
            "got: {out:?}"
        );
    }

    #[test]
    fn flush_diff_with_caret_emits_style_between_cells_and_visibility() {
        // The full frame: the cell run, then MoveTo, the DECSCUSR style, the
        // Show, and the trailing resets — the style never interleaves with
        // the cell output.
        let mut out = Vec::new();
        let updates = [update(0, 0, 'x', Style::new(), 1, false)];
        let caret = Cursor::new(5, 4).underline().blink();
        flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b[1;1H\x1b[0mx\x1b[5;6H\x1b[3 q\x1b[?25h\x1b[0m\x1b[0m",
            "got: {out:?}"
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
            underline_styles: false,
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
            underline_styles: false,
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
            underline_styles: false,
        };
        queue_color_with(&mut out, TernColor::Rgb(255, 0, 0), true, caps)
            .expect("queue should succeed");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn queue_underline_emits_extended_sgr_when_supported() {
        // A terminal reporting extended underline support gets the kitty
        // sequences: `\x1b[4:Nm` for the style variant (3 = curly) and
        // `\x1b[58;2;r;g;bm` for the colored underline, style first.
        let caps = BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
            underline_styles: true,
        };
        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new().underline_style(UnderlineStyle::Curly),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4:3m", "curly");

        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new().underline_color(Some(TernColor::Rgb(255, 0, 0))),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b[58;2;255;0;0m",
            "color-only underline"
        );

        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new()
                .underline_style(UnderlineStyle::Double)
                .underline_color(Some(TernColor::Rgb(1, 2, 3))),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b[4:2m\x1b[58;2;1;2;3m",
            "variant then color"
        );

        // A palette underline color uses the 58;5 form.
        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new()
                .underline_style(UnderlineStyle::Dotted)
                .underline_color(Some(TernColor::Indexed(9))),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4:4m\x1b[58;5;9m");
    }

    #[test]
    fn queue_underline_falls_back_to_plain_when_unsupported() {
        // A terminal without extended underline support degrades the
        // variant/color to the plain `\x1b[4m` underline — the text is
        // still underlined, only the styling is lost.
        let caps = BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
            underline_styles: false,
        };
        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new().underline_style(UnderlineStyle::Curly),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4m", "plain fallback");

        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new().underline_color(Some(TernColor::Rgb(255, 0, 0))),
            caps,
        )
        .expect("queue should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4m", "color fallback");
    }

    #[test]
    fn queue_underline_leaves_legacy_bit_to_the_modifier_pass() {
        // A style carrying only the legacy `Modifiers::UNDERLINE` bit (no
        // variant, no color) queues nothing here — `queue_modifiers` emits
        // `Attribute::Underlined` for it, so untouched styles stay
        // byte-identical. A style with neither the bit nor the extended
        // fields queues nothing either.
        let caps = BackendCapabilities {
            truecolor: true,
            colors: 16_777_216,
            underline_styles: true,
        };
        let mut out = Vec::new();
        queue_underline_with(
            &mut out,
            &Style::new().add_modifier(Modifiers::UNDERLINE),
            caps,
        )
        .expect("queue should succeed");
        assert!(out.is_empty(), "got: {:?}", out);

        let mut out = Vec::new();
        queue_underline_with(&mut out, &Style::new(), caps).expect("queue should succeed");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn flush_diff_extended_underline_run_emits_one_underline_command() {
        // End-to-end through the run queue (whose capabilities come from the
        // global probe, not the injectable seam): a curly-underline cell is
        // its own run whose SGR block carries exactly ONE underline command —
        // the kitty `\x1b[4:3m` when the terminal reports extended support,
        // the plain `\x1b[4m` fallback otherwise — and never both, because
        // the extended path strips the legacy bit from the modifier pass.
        let curly = Style::new().underline_style(UnderlineStyle::Curly);
        let out = flush(&[update(0, 0, 'u', curly, 1, false)], (0, 0));
        let s = String::from_utf8(out).unwrap();
        let extended = s.matches("\x1b[4:3m").count();
        let plain = s.matches("\x1b[4m").count();
        assert_eq!(extended + plain, 1, "got: {s:?}");
        assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[4"), "got: {s:?}");
    }

    #[test]
    fn flush_diff_legacy_underline_run_keeps_attribute_underlined() {
        // The legacy path is untouched: a style with only the UNDERLINE bit
        // emits `Attribute::Underlined` (`\x1b[4m`) through the modifier
        // pass, byte-identical to before the extended fields existed.
        let legacy = Style::new().add_modifier(Modifiers::UNDERLINE);
        let out = flush(&[update(0, 0, 'u', legacy, 1, false)], (0, 0));
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[4mu"), "got: {s:?}");
        // Exactly one plain underline sequence (the run's own; the trailing
        // park resets with SGR 0, not another underline).
        assert_eq!(s.matches("\x1b[4m").count(), 1, "got: {s:?}");
    }

    #[test]
    fn set_title_emits_osc0_title_sequence() {
        let mut out = Vec::new();
        set_title_to(&mut out, "Hello").expect("set title should succeed");
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b]0;Hello\x07");
    }

    #[test]
    fn set_clipboard_emits_osc52_clipboard_sequence() {
        // OSC 52, clipboard selection (`c`), payload = the text's UTF-8
        // bytes base64-encoded (RFC 4648) — "foo" -> "Zm9v" — terminated by
        // BEL: ESC ] 52 ; c ; Zm9v BEL.
        let mut out = Vec::new();
        set_clipboard_to(&mut out, "foo").expect("set clipboard should succeed");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "\x1b]52;c;Zm9v\x07",
            "got: {:?}",
            out
        );
        // The ST terminator must not appear: the sequence is BEL-terminated.
        assert!(!out.windows(2).any(|w| w == b"\x1b\\"), "got: {:?}", out);
    }

    #[test]
    fn set_clipboard_base64_encodes_utf8_bytes() {
        // Multi-byte text: the base64 payload covers the raw UTF-8 bytes, not
        // code points. "hi🙂" is 6 bytes (h i + 4-byte emoji) -> "aGnwn5mC".
        let mut out = Vec::new();
        set_clipboard_to(&mut out, "hi🙂").expect("set clipboard should succeed");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b]52;c;aGnwn5mC\x07",
            "the payload must base64-encode the UTF-8 bytes"
        );
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
