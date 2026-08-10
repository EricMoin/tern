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
//!
//! ## ANSI / OSC / CSI escape sequences
//!
//! Escape sequences are stripped **at ingestion** ([`strip_escapes`]), never
//! classified as zero-width: an escape occupies no columns and never enters
//! the cluster/cell model, so measurement and painting agree by
//! construction. The strip must happen *before* grapheme segmentation — an
//! escape's bytes would otherwise segment as their own clusters (ESC is a
//! control boundary and the printable CSI payload bytes like `[31m` are
//! ordinary width-1 characters), corrupting both width and text. The rule is
//! documented on [`strip_escapes`] as the byte-identical contract the JS
//! mirror in `packages/core` reproduces.

use std::borrow::Cow;
use std::iter::Peekable;
use std::str::CharIndices;

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
///
/// The iterator borrows `text`, so escape stripping happens at ingestion:
/// callers pass `&strip_escapes(text)` (see [`strip_escapes`]). An escape
/// sequence must be removed *before* segmentation — its bytes would
/// otherwise segment as their own clusters (ESC is a control boundary, and
/// the printable payload bytes of a CSI like `[31m` are ordinary width-1
/// characters) and occupy columns they must not.
pub fn clusters(text: &str) -> impl Iterator<Item = Cluster<'_>> {
    text.graphemes(true)
        .map(|g| Cluster {
            text: g,
            width: cluster_width(g),
        })
}

/// The display width of one grapheme cluster in terminal columns: the sum of
/// its member characters' [`char_width`]s, clamped to 2.
///
/// Escape sequences are invisible: [`strip_escapes`] removes them before
/// measuring, so a cluster carrying (or consisting of) an escape sequence
/// measures as its visible text only — `"\x1b[31mred\x1b[0m"` measures as
/// `"red"`. This keeps direct callers of `cluster_width` safe even when a
/// consumer forgets to strip at ingestion (the cluster is then a
/// whole-string measurement rather than a true grapheme, but the answer is
/// still the escape-free width).
pub fn cluster_width(cluster: &str) -> u8 {
    strip_escapes(cluster)
        .chars()
        .fold(0u16, |acc, c| acc + char_width(c) as u16)
        .min(2) as u8
}

/// Strip ANSI/OSC/CSI escape sequences from `text`, returning the
/// escape-free remainder — `Cow::Borrowed` when nothing was stripped (the
/// common case, so the hot measurement path allocates nothing), `Cow::Owned`
/// otherwise.
///
/// ## The strip rule (byte-identical contract)
///
/// This is the canonical rule the JS mirror (`packages/core`'s width and
/// wrap functions) must reproduce byte-identically. Two sequence kinds are
/// removed:
///
/// * **CSI** — the introducer `ESC [` (`0x1B 0x5B`) or the C1 CSI single
///   character `U+009B`, followed by any run of characters up to and
///   including the first **final byte** in `0x40..=0x7E` (the parameter
///   bytes `0x30..=0x3F` and intermediate bytes `0x20..=0x2F` are all below
///   `0x40`, so this is the standard `\x1b\[[0-?]*[ -/]*[@-~]` shape; a
///   *tolerant* scan, not a strict grammar — any character before the final
///   byte is consumed as part of the sequence, so malformed control data is
///   removed rather than painted).
/// * **OSC** — the introducer `ESC ]` (`0x1B 0x5D`), followed by any
///   characters up to and including the first terminator: BEL (`0x07`), ST
///   as `ESC \` (`0x1B 0x5C`), or the C1 ST single character `U+009C`. A
///   bare `ESC` inside the body that is not followed by `\` is a body
///   character, not a terminator.
///
/// A sequence truncated at the end of the input (no final byte / no
/// terminator) is stripped to the end of the input. Everything else is kept
/// as-is — including a lone `ESC` that introduces neither CSI nor OSC, and
/// all other C1 control characters (`U+0080..=U+009F` except `U+009B` and
/// the `U+009C` terminator). The scan works on characters (the UTF-8
/// encoding of a C1 control is a two-byte run `0xC2 0x80..0xBF`), so a
/// multi-byte character is never split: sequences start and end on
/// characters, and runs are consumed or kept whole.
pub fn strip_escapes(text: &str) -> Cow<'_, str> {
    let mut out = String::new();
    let mut run_start = 0usize; // byte offset of the current untouched run
    let mut it = text.char_indices().peekable();
    while let Some((i, ch)) = it.next() {
        let seq = match ch {
            '\u{1b}' => match it.peek() {
                Some(&(_, '[')) => {
                    it.next();
                    Sequence::Csi
                }
                Some(&(_, ']')) => {
                    it.next();
                    Sequence::Osc
                }
                _ => continue, // a lone ESC introduces no sequence
            },
            '\u{9b}' => Sequence::Csi,
            _ => continue,
        };
        // Consume the sequence body; `end` is the byte offset just past it,
        // or the end of the input when the sequence is truncated.
        let end = match seq {
            Sequence::Csi => match csi_end(&mut it) {
                Some(end) => end,
                None => text.len(),
            },
            Sequence::Osc => match osc_end(&mut it) {
                Some(end) => end,
                None => text.len(),
            },
        };
        if out.is_empty() {
            out.reserve(text.len());
        }
        out.push_str(&text[run_start..i]);
        run_start = end;
    }
    if run_start == 0 {
        Cow::Borrowed(text)
    } else {
        out.push_str(&text[run_start..]);
        Cow::Owned(out)
    }
}

/// The sequence kind a stripped introducer opens.
enum Sequence {
    Csi,
    Osc,
}

/// Consume a CSI sequence body (the introducer is already consumed) from
/// `it`, returning the byte offset just past its end: the first character
/// whose code point is a final byte in `0x40..=0x7E` — or `None` when the
/// sequence is truncated.
fn csi_end(it: &mut Peekable<CharIndices<'_>>) -> Option<usize> {
    loop {
        match it.next() {
            Some((j, c)) if ('\u{40}'..='\u{7e}').contains(&c) => return Some(j + c.len_utf8()),
            Some(_) => {}
            None => return None,
        }
    }
}

/// Consume an OSC sequence body (the introducer is already consumed) from
/// `it`, returning the byte offset just past its end: the first terminator —
/// BEL (`0x07`), ST as `ESC \` (`0x1B 0x5C`), or the C1 ST `U+009C`. A bare
/// `ESC` not followed by `\` is a body character. `None` when the sequence
/// is truncated.
fn osc_end(it: &mut Peekable<CharIndices<'_>>) -> Option<usize> {
    loop {
        match it.next() {
            Some((j, '\u{7}')) => return Some(j + 1), // BEL (1 byte)
            Some((j, '\u{9c}')) => return Some(j + '\u{9c}'.len_utf8()), // C1 ST (2 bytes)
            Some((j, '\u{1b}')) => match it.next() {
                Some((k, '\\')) => return Some(k + 1), // ST: ESC \ (1 byte each)
                Some(_) => {} // a bare ESC is an OSC body character
                None => return Some(j + 1), // truncated at the trailing ESC
            },
            Some(_) => {}
            None => return None,
        }
    }
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
    fn strip_escapes_removes_csi_and_osc_sequences() {
        // CSI SGR color codes vanish; the visible text survives intact.
        assert_eq!(strip_escapes("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_escapes("\x1b[1m\x1b[38;2;255;0;0mbold\x1b[0m"), "bold");
        // Non-SGR CSI (hide cursor, clear screen) are sequences too.
        assert_eq!(strip_escapes("\x1b[?25l"), "");
        assert_eq!(strip_escapes("\x1b[2J"), "");
        // OSC: a BEL-terminated title, an ST-terminated hyperlink, and a
        // C1-ST terminator all vanish while the surrounding text survives.
        assert_eq!(strip_escapes("\x1b]0;title\x07"), "");
        assert_eq!(strip_escapes("a\x1b]8;;http://example.com\x1b\\b"), "ab");
        assert_eq!(strip_escapes("\x1b]0;title\u{9c}"), "");
        // A bare ESC inside an OSC body (not followed by `\`) is body data.
        assert_eq!(strip_escapes("\x1b]0;a\x1bb\x07"), "");
        // The C1 CSI single byte (0x9B) opens a CSI sequence just like ESC [.
        assert_eq!(strip_escapes("\u{9b}31mred\u{9b}0m"), "red");
        // Truncated sequences (no final byte / no terminator) strip to the
        // end of the input rather than leaking their bytes.
        assert_eq!(strip_escapes("red\x1b[31"), "red");
        assert_eq!(strip_escapes("red\x1b]0;unterminated"), "red");
    }

    #[test]
    fn strip_escapes_leaves_plain_text_borrowed() {
        // No escapes: the input is returned borrowed, byte-identical — the
        // hot path allocates nothing.
        let plain = "e\u{301}日\n";
        assert_eq!(strip_escapes(plain), plain);
        assert!(matches!(strip_escapes(plain), Cow::Borrowed(_)));
        // A lone ESC (neither CSI nor OSC introducer) and C1 bytes outside
        // the rule (e.g. the C1 OSC start 0x9D) are kept as-is.
        assert_eq!(strip_escapes("a\x1bb"), "a\x1bb");
        assert_eq!(strip_escapes("a\u{9d}b"), "a\u{9d}b");
        // NUL / combining marks / wide CJK pass through untouched.
        assert_eq!(strip_escapes("e\u{301}日\0"), "e\u{301}日\0");
    }

    #[test]
    fn ansi_escapes_measure_as_invisible() {
        // The golden contract: an escape-carrying string measures and
        // clusters identically to its stripped form.
        let colored = strip_escapes("\x1b[31mred\x1b[0m");
        assert_eq!(
            clusters(&colored).map(|c| (c.text, c.width)).collect::<Vec<_>>(),
            clusters("red").map(|c| (c.text, c.width)).collect::<Vec<_>>(),
        );
        // cluster_width clamps to 2, so the golden check is equality with
        // the stripped form; a single visible char is exactly 1.
        assert_eq!(cluster_width("\x1b[31mred\x1b[0m"), cluster_width("red"));
        assert_eq!(cluster_width("\x1b[31me\x1b[0m"), 1);
        // Wide CJK, combining, and NUL behavior is unchanged by surrounding
        // escapes: 2 columns, 1 column (base + zero-width mark), 0.
        assert_eq!(cluster_width("\x1b[31mコ\x1b[0m"), 2);
        assert_eq!(cluster_width("\x1b[31me\u{301}\x1b[0m"), 1);
        assert_eq!(cluster_width("\x1b[31m\0\x1b[0m"), 0);
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
