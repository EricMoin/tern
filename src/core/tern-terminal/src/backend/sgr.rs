//! Style emission: the SGR sequences for colors (truecolor, indexed, and
//! the 256-color quantization fallback), extended underlines, and text
//! modifiers.

use super::*;

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

/// Queue the foreground (`fg == true`) or background (`fg == false`) color
/// command for a tern-core color, consulting the detected terminal
/// capabilities: `Default` needs no command (the per-cell SGR reset already
/// restored the terminal default), and an `Rgb` color is quantized to the
/// nearest ANSI 256-color index when truecolor is unsupported (or dropped
/// entirely on a palette smaller than 256, where the reset's default
/// remains).
pub(super) fn queue_color<W: Write>(w: &mut W, color: TernColor, fg: bool) -> io::Result<()> {
    queue_color_with(w, color, fg, capabilities())
}

/// The [`queue_color`] core: like it, but with explicit capabilities, so the
/// quantization path is unit-testable without touching the global probe.
pub(super) fn queue_color_with<W: Write>(
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
pub(super) fn queue_underline<W: Write>(w: &mut W, style: &Style) -> io::Result<()> {
    queue_underline_with(w, style, capabilities())
}

/// The [`queue_underline`] core: like it, but with explicit capabilities, so
/// the extended-SGR and fallback paths are unit-testable without touching
/// the global probe.
pub(super) fn queue_underline_with<W: Write>(
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
pub(super) fn extended_underline(style: &Style) -> bool {
    style.underline_style != UnderlineStyle::None
        || matches!(
            style.underline_color,
            Some(TernColor::Rgb(..)) | Some(TernColor::Indexed(_))
        )
}

/// Queue the crossterm attribute commands for a tern-core modifier set.
pub(super) fn queue_modifiers<W: Write>(w: &mut W, modifiers: Modifiers) -> io::Result<()> {
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
