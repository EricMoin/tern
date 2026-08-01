//! The terminal cell model and per-cell updates.

use crate::style::Style;
use unicode_width::UnicodeWidthChar;

/// The display width of a character in terminal columns.
///
/// Returns `0` for NUL (the masked continuation cell) and for combining
/// marks, `2` for wide characters (CJK, fullwidth), and `1` otherwise.
/// Control characters that unicode-width cannot classify fall back to 1.
pub fn char_width(ch: char) -> u8 {
    if ch == '\0' {
        return 0;
    }
    match ch.width() {
        Some(0) => 0,
        Some(1) => 1,
        Some(w) => w.min(2) as u8,
        None => 1,
    }
}

/// A single cell of a [`Buffer`](crate::Buffer): one character plus its style
/// plus its display width in terminal columns.
///
/// Width is `1` for ordinary characters, `2` for wide (CJK / fullwidth) lead
/// characters, and `0` for zero-width cells — either combining marks or the
/// masked "continuation" cell that follows a wide character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cell {
    /// The character to display (`'\0'` for masked continuation cells).
    pub ch: char,
    /// The visual style of the cell.
    pub style: Style,
    /// Display width in columns: 0 (mask/combining), 1, or 2.
    pub width: u8,
}

impl Default for Cell {
    /// A blank, unstyled, single-width cell (space).
    fn default() -> Self {
        Cell {
            ch: ' ',
            style: Style::default(),
            width: 1,
        }
    }
}

impl Cell {
    /// A blank, unstyled single-width cell holding `ch`.
    pub const fn new(ch: char) -> Self {
        Cell {
            ch,
            style: Style::new(),
            width: 1,
        }
    }

    /// A single-width cell with an explicit style.
    pub const fn styled(ch: char, style: Style) -> Self {
        Cell {
            ch,
            style,
            width: 1,
        }
    }

    /// The masked continuation cell that follows a wide character: zero
    /// width, NUL content. The terminal must not print it as-is; it exists so
    /// a wide character's right half is not covered by leftover content.
    pub const fn mask(style: Style) -> Self {
        Cell {
            ch: '\0',
            style,
            width: 0,
        }
    }

    /// Whether this is a zero-width continuation / masked cell.
    pub const fn is_masked(&self) -> bool {
        self.width == 0
    }
}

/// A single cell update produced by [`diff`](crate::diff).
///
/// For a wide (2-column) character the update set contains the lead cell
/// (`width == 2`, `masked == false`) followed by the masked neighbor cell
/// (`width == 0`, `masked == true`) when that neighbor changed. The terminal
/// flusher writes the lead glyph and clears the neighbor column.
///
/// A zero-width update with `ch != '\0'` is a combining mark: the flusher may
/// emit it raw instead of clearing the column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CellUpdate {
    /// Column of the cell.
    pub x: u16,
    /// Row of the cell.
    pub y: u16,
    /// Character to write (`'\0'` for masked continuation cells).
    pub ch: char,
    /// Style to apply.
    pub style: Style,
    /// Display width of the character (0 = masked/continuation).
    pub width: u8,
    /// True for the zero-width continuation cell of a wide character (or a
    /// standalone zero-width cell); the flusher masks the column.
    pub masked: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn char_width_classification() {
        assert_eq!(char_width('a'), 1);
        assert_eq!(char_width(' '), 1);
        assert_eq!(char_width('コ'), 2); // Katakana KO — East Asian Wide
        assert_eq!(char_width('日'), 2);
        assert_eq!(char_width('\0'), 0);
        assert_eq!(char_width('\u{0301}'), 0); // combining acute accent
        assert_eq!(char_width('\t'), 1); // control chars fall back to 1
    }

    #[test]
    fn cell_defaults_and_mask() {
        let c = Cell::default();
        assert_eq!(c.ch, ' ');
        assert_eq!(c.width, 1);
        assert!(!c.is_masked());

        let m = Cell::mask(Style::new());
        assert_eq!(m.ch, '\0');
        assert_eq!(m.width, 0);
        assert!(m.is_masked());
        assert_ne!(c, m);
    }
}
