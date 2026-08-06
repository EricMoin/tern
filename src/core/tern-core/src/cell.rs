//! The terminal cell model and per-cell updates.
//!
//! The indivisible text unit is the **grapheme cluster** (UAX #29 extended
//! grapheme clusters): a ZWJ emoji sequence (👨‍👩‍👧‍👦), a flag (🇷🇺), a
//! keycap (1️⃣), or a base-plus-combining sequence (e + U+0301) is one
//! cluster, never split across rows or at the right edge. A cluster occupies
//! `cluster_width` terminal columns (the sum of its member characters'
//! [`char_width`]s, clamped to 2) and is painted as one logical glyph: the
//! lead cell carries the cluster's full symbol string, and a 2-column
//! cluster's second column is a masked continuation cell.

use std::borrow::Cow;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;

use crate::style::Style;

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

/// One grapheme cluster: its text and its display width in terminal columns.
///
/// The width is the sum of the member characters' [`char_width`]s, clamped
/// to 2 — a ZWJ emoji sequence or a flag sums well past 2 but renders in
/// exactly 2 columns, and a combining sequence sums to its base's width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cluster<'a> {
    /// The cluster's full text (e.g. `"👨‍👩‍👧‍👦"` or `"e\u{301}"`).
    pub text: &'a str,
    /// Display width in columns: 1, 2, or 0 (a lone zero-width mark).
    pub width: u8,
}

impl Cluster<'_> {
    /// The cluster's lead character (the first char of its text).
    pub fn lead(&self) -> char {
        self.text.chars().next().unwrap_or('\0')
    }

    /// The full symbol a cell must carry for this cluster: `Some(text)` for
    /// a multi-char cluster (a combining sequence, a ZWJ emoji), `None` for
    /// a single-char cluster — keeping single-width cells allocation-free.
    pub fn symbol(&self) -> Option<Box<str>> {
        (self.text.chars().count() > 1).then(|| self.text.into())
    }
}

/// Iterate the extended grapheme clusters of `text` (UAX #29), each paired
/// with its display width.
pub fn clusters(text: &str) -> impl Iterator<Item = Cluster<'_>> {
    text.graphemes(true)
        .map(|g| Cluster {
            text: g,
            width: cluster_width(g),
        })
}

/// The display width of one grapheme cluster in terminal columns: the sum of
/// its member characters' [`char_width`]s, clamped to 2.
pub fn cluster_width(cluster: &str) -> u8 {
    cluster
        .chars()
        .fold(0u16, |acc, c| acc + char_width(c) as u16)
        .min(2) as u8
}

/// A single cell of a [`Buffer`](crate::Buffer): the lead character of the
/// cluster it holds, the cluster's full symbol when it spans more than one
/// character, plus its style and its display width in terminal columns.
///
/// Width is `1` for ordinary characters, `2` for wide (CJK / fullwidth /
/// ZWJ-emoji) lead clusters, and `0` for the masked "continuation" cell that
/// follows a 2-column cluster. A multi-char cluster (a combining sequence or
/// a ZWJ emoji) stores its full text in [`symbol`](Cell::symbol); the
/// terminal flusher prints that symbol once. Single-char cells keep
/// `symbol == None`, so the common case stays inline and allocation-free.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Cell {
    /// The lead character of the cluster (`'\0'` for masked continuation
    /// cells).
    pub ch: char,
    /// The cluster's full symbol string for multi-char clusters; `None` for
    /// single-char clusters and masked cells.
    pub symbol: Option<Box<str>>,
    /// The visual style of the cell.
    pub style: Style,
    /// Display width in columns: 0 (mask), 1, or 2.
    pub width: u8,
}

impl Default for Cell {
    /// A blank, unstyled, single-width cell (space).
    fn default() -> Self {
        Cell {
            ch: ' ',
            symbol: None,
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
            symbol: None,
            style: Style::new(),
            width: 1,
        }
    }

    /// A single-width cell with an explicit style.
    pub const fn styled(ch: char, style: Style) -> Self {
        Cell {
            ch,
            symbol: None,
            style,
            width: 1,
        }
    }

    /// The masked continuation cell that follows a 2-column cluster: zero
    /// width, NUL content. The terminal must not print it as-is; it exists so
    /// a wide glyph's right half is not covered by leftover content.
    pub const fn mask(style: Style) -> Self {
        Cell {
            ch: '\0',
            symbol: None,
            style,
            width: 0,
        }
    }

    /// Whether this is a zero-width continuation / masked cell.
    pub const fn is_masked(&self) -> bool {
        self.width == 0
    }

    /// The full symbol this cell paints: the cluster's text for a multi-char
    /// cluster, otherwise the single character. A masked cell yields its
    /// (space-rendered) NUL.
    pub fn symbol_str(&self) -> Cow<'_, str> {
        match &self.symbol {
            Some(symbol) => Cow::Borrowed(symbol.as_ref()),
            None => Cow::Owned(self.ch.to_string()),
        }
    }
}

/// A single cell update produced by [`diff`](crate::diff).
///
/// For a 2-column cluster the update set contains the lead cell
/// (`width == 2`, `masked == false`, carrying the cluster's full symbol)
/// followed by the masked neighbor cell (`width == 0`, `masked == true`)
/// when that neighbor changed. The terminal flusher prints the lead's full
/// symbol once and clears the neighbor column.
///
/// A zero-width update with `ch != '\0'` is a combining mark: the flusher may
/// emit it raw instead of clearing the column.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CellUpdate {
    /// Column of the cell.
    pub x: u16,
    /// Row of the cell.
    pub y: u16,
    /// Lead character of the cluster (`'\0'` for masked continuation cells).
    pub ch: char,
    /// The cluster's full symbol string for multi-char clusters; `None` for
    /// single-char clusters and masked cells.
    pub symbol: Option<Box<str>>,
    /// Style to apply.
    pub style: Style,
    /// Display width of the cluster (0 = masked/continuation).
    pub width: u8,
    /// True for the zero-width continuation cell of a 2-column cluster (or a
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
        assert_eq!(c.symbol, None);
        assert_eq!(c.width, 1);
        assert!(!c.is_masked());

        let m = Cell::mask(Style::new());
        assert_eq!(m.ch, '\0');
        assert_eq!(m.symbol, None);
        assert_eq!(m.width, 0);
        assert!(m.is_masked());
        assert_ne!(c, m);
    }

    #[test]
    fn grapheme_clusters_split_emoji_and_combining() {
        // ZWJ family emoji is ONE cluster; a flag is ONE cluster; a base +
        // combining mark is ONE cluster; CRLF is ONE cluster.
        let family = clusters("👨‍👩‍👧‍👦").collect::<Vec<_>>();
        assert_eq!(family.len(), 1);
        assert_eq!(family[0].text, "👨‍👩‍👧‍👦");
        assert_eq!(family[0].width, 2); // sums past 2, clamped to 2

        let flag = clusters("🇷🇺").collect::<Vec<_>>();
        assert_eq!(flag.len(), 1);
        assert_eq!(flag[0].text, "🇷🇺");
        assert_eq!(flag[0].width, 2);

        let keycap = clusters("1️⃣").collect::<Vec<_>>();
        assert_eq!(keycap.len(), 1);
        assert_eq!(keycap[0].text, "1️⃣");

        let combining = clusters("e\u{301}").collect::<Vec<_>>();
        assert_eq!(combining.len(), 1);
        assert_eq!(combining[0].text, "e\u{301}");
        assert_eq!(combining[0].width, 1); // base 1 + combining 0

        let crlf = clusters("a\r\nb").collect::<Vec<_>>();
        assert_eq!(crlf.len(), 3);
        assert_eq!(crlf[1].text, "\r\n");

        // Plain ASCII: one cluster per char.
        assert_eq!(clusters("ab").map(|c| c.text).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn cluster_symbols_are_only_for_multi_char_clusters() {
        let single = Cluster { text: "a", width: 1 };
        assert_eq!(single.symbol(), None);
        assert_eq!(single.lead(), 'a');

        let wide = Cluster { text: "コ", width: 2 };
        assert_eq!(wide.symbol(), None); // single char — no symbol needed

        let seq = Cluster { text: "e\u{301}", width: 1 };
        assert_eq!(seq.symbol().as_deref(), Some("e\u{301}"));
        assert_eq!(seq.lead(), 'e');

        let family = Cluster {
            text: "👨‍👩‍👧‍👦",
            width: 2,
        };
        assert_eq!(family.symbol().as_deref(), Some("👨‍👩‍👧‍👦"));
        assert_eq!(family.lead(), '👨');
    }

    #[test]
    fn cell_symbol_str_returns_full_cluster() {
        let single = Cell {
            ch: 'a',
            symbol: None,
            style: Style::new(),
            width: 1,
        };
        assert_eq!(single.symbol_str(), "a");

        let cluster = Cell {
            ch: 'e',
            symbol: Some("e\u{301}".into()),
            style: Style::new(),
            width: 1,
        };
        assert_eq!(cluster.symbol_str(), "e\u{301}");
    }
}
