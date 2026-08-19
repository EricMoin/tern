//! Render backend abstraction and buffer serialization helpers.

use super::*;

/// The backend surface [`TuiRenderer`] talks to, split out so unit tests can
/// inject a counting mock and prove the no-op render fast path performs zero
/// terminal writes. [`Backend`] implements this with real terminal I/O; the
/// tests substitute a mock whose counters record every call.
pub(crate) trait RenderBackend: Send + Sync {
    /// The terminal size as `(columns, rows)`.
    fn size(&self) -> io::Result<(u16, u16)>;
    /// Flush a diff of cell updates to the terminal, recording the park
    /// position so an empty no-op frame can skip the flush entirely. Returns
    /// the number of bytes queued to the terminal (the frame's ANSI
    /// escape-sequence stream; 0 for a fully suppressed frame).
    fn flush_diff(&mut self, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> io::Result<usize>;
    /// Set the terminal window title (OSC 0).
    fn set_title(&self, title: &str) -> io::Result<()>;
    /// Copy `text` to the system clipboard (OSC 52).
    fn set_clipboard(&self, text: &str) -> io::Result<()>;
    /// Stop mouse / focus-change / bracketed-paste event reporting.
    fn disable_event_listening(&self) -> io::Result<()>;
    /// Disable the kitty keyboard protocol enhancement (pop one level).
    fn exit_keyboard_enhancement(&self) -> io::Result<()>;
    /// Leave the alternate screen.
    fn exit_alt_screen(&self) -> io::Result<()>;
    /// Leave raw mode.
    fn exit_raw_mode(&self) -> io::Result<()>;
}

impl RenderBackend for Backend {
    fn size(&self) -> io::Result<(u16, u16)> {
        Backend::size(self)
    }

    fn flush_diff(&mut self, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> io::Result<usize> {
        Backend::flush_diff(self, updates, cursor_pos)
    }

    fn set_title(&self, title: &str) -> io::Result<()> {
        Backend::set_title(self, title)
    }

    fn set_clipboard(&self, text: &str) -> io::Result<()> {
        Backend::set_clipboard(self, text)
    }

    fn disable_event_listening(&self) -> io::Result<()> {
        Backend::disable_event_listening(self)
    }

    fn exit_keyboard_enhancement(&self) -> io::Result<()> {
        Backend::exit_keyboard_enhancement(self)
    }

    fn exit_alt_screen(&self) -> io::Result<()> {
        Backend::exit_alt_screen(self)
    }

    fn exit_raw_mode(&self) -> io::Result<()> {
        Backend::exit_raw_mode(self)
    }
}

/// An in-memory [`RenderBackend`] for headless renderers: `size()` reports
/// the configured virtual size (default 80x24) and every terminal operation
/// is a no-op. A [`TuiRenderer`] constructed with `headless: true` uses this
/// so it never touches a real terminal — no raw mode, alternate screen, event
/// listening, or title — which lets rendering and snapshots run under plain
/// `cargo test`, in CI, and in snapshot tooling with no TTY present.
pub(crate) struct HeadlessBackend {
    size: (u16, u16),
}

impl HeadlessBackend {
    pub(crate) fn new(width: u32, height: u32) -> Self {
        // Clamp into the u16 cell range and floor at 1x1: a zero-sized
        // virtual terminal would make every paint a degenerate viewport.
        let w = width.clamp(1, u16::MAX as u32) as u16;
        let h = height.clamp(1, u16::MAX as u32) as u16;
        Self { size: (w, h) }
    }
}

impl RenderBackend for HeadlessBackend {
    fn size(&self) -> io::Result<(u16, u16)> {
        Ok(self.size)
    }

    fn flush_diff(
        &mut self,
        _updates: &[CellUpdate],
        _cursor_pos: (u16, u16),
    ) -> io::Result<usize> {
        // Headless frames are never flushed to a terminal; report 0 bytes so
        // `last_flush_bytes` stays honest about the absent I/O.
        Ok(0)
    }

    fn set_title(&self, _title: &str) -> io::Result<()> {
        Ok(())
    }

    fn set_clipboard(&self, _text: &str) -> io::Result<()> {
        Ok(())
    }

    fn disable_event_listening(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_keyboard_enhancement(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_alt_screen(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_raw_mode(&self) -> io::Result<()> {
        Ok(())
    }
}

/// Convert a painted buffer to one string per row, mapping masked
/// continuation cells (the zero-width right halves of wide glyphs) to spaces
/// so every row has exactly `buffer.width` display columns. Multi-width
/// aware by construction: a 2-column glyph (a wide character or a grapheme
/// cluster) occupies its lead cell plus the masked neighbor, so the row string
/// keeps the buffer's true display width. A multi-char cluster (a ZWJ emoji,
/// a combining sequence) contributes its full symbol string, so the row
/// reconstructs the cluster as it renders.
pub(crate) fn buffer_rows(buffer: &Buffer) -> Vec<String> {
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| {
                    buffer.cell(x, y).map_or_else(
                        || " ".to_string(),
                        |cell| {
                            if cell.is_masked() {
                                " ".to_string()
                            } else {
                                cell.symbol_str().into_owned()
                            }
                        },
                    )
                })
                .collect()
        })
        .collect()
}

/// The exposed style of a painted cell — the fields [`StyleRunJs`] carries:
/// fg, bg, the hyperlink target, and the six surfaced modifiers. Two
/// adjacent cells merge into one run exactly when their `RunStyle` keys are
/// equal; border style and the unsurfaced blink/hidden modifiers do not
/// split runs, so an uncolored box's border cells stay one run with its
/// surrounding default-styled blanks. A set `border_color` paints the
/// border glyphs with that color as their foreground (see `paint_box`), so
/// a colored border surfaces as its own `fg`-carrying run — the styled
/// snapshot reports it through `fg`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunStyle {
    fg: Color,
    bg: Color,
    hyperlink: Option<Box<str>>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    reversed: bool,
    strikethrough: bool,
}

impl RunStyle {
    /// The exposed style of a painted cell's [`Style`].
    fn of(style: Style) -> Self {
        Self {
            fg: style.fg,
            bg: style.bg,
            hyperlink: style.hyperlink,
            bold: style.modifiers.contains(Modifiers::BOLD),
            dim: style.modifiers.contains(Modifiers::DIM),
            italic: style.modifiers.contains(Modifiers::ITALIC),
            underline: style.modifiers.contains(Modifiers::UNDERLINE),
            reversed: style.modifiers.contains(Modifiers::REVERSED),
            strikethrough: style.modifiers.contains(Modifiers::STRIKETHROUGH),
        }
    }

    /// Materialize a [`StyleRunJs`] carrying `text` in this style: colors as
    /// strings, modifier keys present only when set.
    fn to_run(self, text: String) -> StyleRunJs {
        StyleRunJs {
            text,
            fg: color_to_string(self.fg),
            bg: color_to_string(self.bg),
            hyperlink: self.hyperlink.map(|h| h.into_string()),
            bold: self.bold.then_some(true),
            dim: self.dim.then_some(true),
            italic: self.italic.then_some(true),
            underline: self.underline.then_some(true),
            reversed: self.reversed.then_some(true),
            strikethrough: self.strikethrough.then_some(true),
        }
    }
}

/// The JS-facing string form of a color: `"#rrggbb"` for truecolor,
/// `"indexed:<n>"` for ANSI palette entries, `None` for the terminal default
/// — the inverse of [`parse_color`].
pub(crate) fn color_to_string(c: Color) -> Option<String> {
    match c {
        Color::Default => None,
        Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
        Color::Indexed(n) => Some(format!("indexed:{n}")),
    }
}

/// Convert a painted buffer to one vector of styled runs per row: adjacent
/// cells with identical exposed style (see [`RunStyle`]) merge into a single
/// run. Masked continuation cells map to spaces exactly like [`buffer_rows`],
/// so concatenating each row's run texts reconstructs the row string
/// [`buffer_rows`] produces — the styled snapshot is the styled counterpart
/// of the plain one, never a different text.
pub(crate) fn buffer_runs(buffer: &Buffer) -> Vec<Vec<StyleRunJs>> {
    (0..buffer.height)
        .map(|y| {
            let mut runs: Vec<(RunStyle, String)> = Vec::new();
            for x in 0..buffer.width {
                let cell = buffer.cell(x, y).expect("cell in bounds");
                let text = if cell.is_masked() {
                    " ".to_string()
                } else {
                    cell.symbol_str().into_owned()
                };
                let style = RunStyle::of(cell.style.clone());
                if let Some((last_style, last_text)) = runs.last_mut() {
                    if *last_style == style {
                        last_text.push_str(&text);
                        continue;
                    }
                }
                runs.push((style, text));
            }
            runs.into_iter()
                .map(|(style, text)| style.to_run(text))
                .collect()
        })
        .collect()
}

/// Paint `scene` at `viewport` through a fresh compositor with `selection`
/// synced — the renderer's current selection overlay — and return the frame
/// buffer. `Some((anchor, active))` applies the overlay (the compositor
/// normalizes the endpoints); `None` paints without one (the default, so
/// unselected snapshots are byte-identical to before the overlay existed).
/// Both snapshot conversions — [`buffer_rows`] (plain strings) and
/// [`buffer_runs`] (styled runs) — feed from this single paint path, so the
/// styled snapshot and the plain one always agree on what was painted.
pub(crate) fn paint_scene_buffer(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Buffer {
    let mut compositor = Compositor::new();
    match selection {
        Some((anchor, active)) => compositor.set_selection(anchor, active),
        None => compositor.clear_selection(),
    }
    compositor.paint_scene(scene, viewport)
}

/// Paint `scene` at `viewport` with `selection` synced and return the frame
/// as one string per row. The overlay is style-only, so the returned rows
/// carry the same text with or without it — the snapshot is where a styled
/// consumer would observe the selection. Performs no terminal I/O; the pure
/// snapshot both [`TuiRenderer::render_to_buffer`] and its unit tests use,
/// so the tested path is the shipped path.
pub(crate) fn paint_scene_rows_with_selection(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Vec<String> {
    buffer_rows(&paint_scene_buffer(scene, viewport, selection))
}

/// Paint `scene` at `viewport` with `selection` synced and return the frame
/// as one vector of styled runs per row — the styled counterpart of
/// [`paint_scene_rows_with_selection`], sharing its paint path and viewport
/// semantics.
pub(crate) fn paint_scene_runs_with_selection(
    scene: &Scene,
    viewport: Size,
    selection: Option<((u16, u16), (u16, u16))>,
) -> Vec<Vec<StyleRunJs>> {
    buffer_runs(&paint_scene_buffer(scene, viewport, selection))
}
