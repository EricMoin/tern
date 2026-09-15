//! Terminal capability detection: the cached BackendCapabilities report
//! (truecolor, palette size, extended-underline support) that every style
//! decision consults, plus the counting writer the probe drains through.

use super::*;

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
pub(super) struct CountingWriter<W> {
    inner: W,
    pub(super) bytes: usize,
}

impl<W> CountingWriter<W> {
    pub(super) fn new(inner: W) -> Self {
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
