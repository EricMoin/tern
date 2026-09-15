//! Diff flushing: turning a CellUpdate list into the minimal queued
//! escape-sequence stream, including style-run batching (Run), the
//! DECSTBM / SU / SD scroll path, and caret placement.

use super::*;

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

/// A vertical scroll operation over a DECSTBM scroll region: the region's
/// rows and how far (and in which direction) its content shifts, plus the
/// exposed band's cell updates.
///
/// The region is a contiguous run of full-width rows `top..=bottom`
/// (0-based, inclusive) whose content the terminal shifts by `rows` rows:
/// `up: true` scrolls content toward the top (`ESC[<rows>S`, SU — index),
/// exposing the bottom `rows` rows; `up: false` scrolls content toward the
/// bottom (`ESC[<rows>T`, SD — reverse index), exposing the top `rows` rows.
/// The newly exposed rows are exactly the band the caller must repaint via
/// the `updates` passed to [`flush_scroll_to`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollOp {
    /// The scroll region's top row (0-based, inclusive).
    pub top: u16,
    /// The scroll region's bottom row (0-based, inclusive).
    pub bottom: u16,
    /// How many rows the region's content shifts.
    pub rows: u16,
    /// `true` scrolls up (content toward the top, the bottom `rows` rows
    /// exposed), `false` scrolls down (content toward the bottom, the top
    /// `rows` rows exposed).
    pub up: bool,
}

/// Flush a scroll-region operation to any `Write` target: set the DECSTBM
/// region, scroll it by `op.rows`, paint the exposed band, reset the region,
/// then park the cursor at `cursor_pos`, leaving the terminal's style state
/// reset. Returns the number of cell updates queued to paint the exposed
/// band (0 when the empty-updates fast path short-circuits — the [`Backend`]
/// wrapper reports bytes separately via its counting writer).
///
/// Emits, in order: a [`MoveTo`] to the region's top-left (`column 0, row
/// op.top`), the DECSTBM region set (`ESC[<top+1>;<bottom+1>r`), the scroll
/// (`ESC[<rows>S` when `up`, `ESC[<rows>T` otherwise), the exposed band's
/// updates run-batched through [`queue_cells`], the region reset (`ESC[r`),
/// then the park trailer — `MoveTo(cursor_pos)`, `ResetColor`,
/// `Attribute::Reset`, one flush — exactly like [`flush_diff_to`].
///
/// crossterm has no DECSTBM / SU / SD commands, so those sequences are
/// written raw through the `Write` (the same seam as the OSC 8 hyperlink
/// open/close in [`Run::queue`] and the kitty extended underline in
/// [`queue_underline_with`]).
///
/// The empty-updates fast path mirrors [`flush_diff_to`]: when the exposed
/// band is empty and the caret is already parked at `cursor_pos`, nothing is
/// queued and [`flush`](Write::flush) is not called; when only the park
/// position differs (or was never recorded), just the `MoveTo` is queued and
/// flushed, and `last_flush_pos` is updated.
pub fn flush_scroll_to<W: Write>(
    w: &mut W,
    op: &ScrollOp,
    updates: &[CellUpdate],
    cursor_pos: (u16, u16),
    last_flush_pos: &mut Option<(u16, u16)>,
) -> io::Result<usize> {
    if updates.is_empty() {
        // Nothing to paint this frame. If the caret is already parked where
        // the frame wants it, there is nothing to do — not even a flush. If
        // only the park position moved (or was never recorded), emit the
        // move alone: no region work is needed and the style state is
        // already clean from the previous flush.
        if *last_flush_pos == Some(cursor_pos) {
            return Ok(0);
        }
        w.queue(MoveTo(cursor_pos.0, cursor_pos.1))?;
        w.flush()?;
        *last_flush_pos = Some(cursor_pos);
        return Ok(0);
    }
    // Move to the region's top-left, set the scroll region (DECSTBM is
    // 1-based), and scroll the content: SU (CSI S) shifts up, SD (CSI T)
    // shifts down, exposing the band the updates repaint.
    w.queue(MoveTo(0, op.top))?;
    w.write_all(format!("\x1b[{};{}r", op.top + 1, op.bottom + 1).as_bytes())?;
    if op.up {
        w.write_all(format!("\x1b[{}S", op.rows).as_bytes())?;
    } else {
        w.write_all(format!("\x1b[{}T", op.rows).as_bytes())?;
    }
    queue_cells(w, updates)?;
    // Reset the scroll region to the full screen.
    w.write_all(b"\x1b[r")?;
    // Park the cursor and leave the terminal's style state clean for
    // whatever prints next — exactly like flush_diff_to.
    w.queue(MoveTo(cursor_pos.0, cursor_pos.1))?;
    w.queue(ResetColor)?;
    w.queue(SetAttribute(Attribute::Reset))?;
    w.flush()?;
    *last_flush_pos = Some(cursor_pos);
    Ok(updates.len())
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
pub(super) struct Run {
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
