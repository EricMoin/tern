//! Cell styling: foreground/background colors, text modifiers, border style.

use crate::color::Color;

/// Text modifier flags (bold, underline, ...).
///
/// A compact hand-rolled bit set so tern-core keeps a minimal dependency
/// footprint (only `unicode-width`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Modifiers(u16);

impl Modifiers {
    /// No modifiers.
    pub const EMPTY: Self = Self(0);
    /// Bold text.
    pub const BOLD: Self = Self(1 << 0);
    /// Dim / faint text.
    pub const DIM: Self = Self(1 << 1);
    /// Italic text.
    pub const ITALIC: Self = Self(1 << 2);
    /// Underlined text.
    pub const UNDERLINE: Self = Self(1 << 3);
    /// Blinking text.
    pub const BLINK: Self = Self(1 << 4);
    /// Reversed (swapped fg/bg) text.
    pub const REVERSED: Self = Self(1 << 5);
    /// Hidden / invisible text.
    pub const HIDDEN: Self = Self(1 << 6);
    /// Strikethrough text.
    pub const STRIKETHROUGH: Self = Self(1 << 7);

    /// The raw bit representation.
    pub const fn bits(self) -> u16 {
        self.0
    }

    /// Whether no modifier bit is set.
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Whether all bits of `other` are set in `self`.
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Return `self` with all bits of `other` set.
    pub const fn insert(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Return `self` with all bits of `other` cleared.
    pub const fn remove(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    /// Bitwise union of two modifier sets.
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// Border glyph set used when drawing a box frame.
///
/// The compositor picks the concrete glyphs; tern-core only carries the
/// choice on the node's [`Style`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BorderStyle {
    /// No border.
    #[default]
    None,
    /// ASCII box glyphs (`+ - |`).
    Plain,
    /// Rounded corner glyphs (`╭ ╮ ╰ ╯ ─ │`).
    Rounded,
    /// Double-line glyphs (`╔ ╗ ╚ ╝ ═ ║`).
    Double,
    /// Heavy-line glyphs (`┏ ┓ ┗ ┛ ━ ┃`).
    Thick,
}

/// The visual style of a cell or a scene node.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Style {
    /// Foreground color.
    pub fg: Color,
    /// Background color.
    pub bg: Color,
    /// Text modifier flags.
    pub modifiers: Modifiers,
    /// Border style used when the node is painted as a box.
    pub border_style: BorderStyle,
    /// The color the node's box border glyphs are painted with. `Default`
    /// (the default) leaves the border glyphs painted with the style's own
    /// `fg` — the pre-existing behavior — so a style without a border color
    /// paints byte-identically to before the field existed.
    pub border_color: Color,
    /// The hyperlink target (a URL) threaded through from a Text/span `href`
    /// to the cells painted with this style. `None` — the default — paints
    /// plain text. The field participates in style equality, so a hyperlink
    /// change splits terminal runs at the link boundary.
    pub hyperlink: Option<Box<str>>,
}

impl Style {
    /// A plain, unstyled style.
    pub const fn new() -> Self {
        Self {
            fg: Color::Default,
            bg: Color::Default,
            modifiers: Modifiers::EMPTY,
            border_style: BorderStyle::None,
            border_color: Color::Default,
            hyperlink: None,
        }
    }

    /// Builder: set the foreground color.
    pub const fn fg(mut self, fg: Color) -> Self {
        self.fg = fg;
        self
    }

    /// Builder: set the background color.
    pub const fn bg(mut self, bg: Color) -> Self {
        self.bg = bg;
        self
    }

    /// Builder: replace the modifier set.
    pub const fn modifier(mut self, modifiers: Modifiers) -> Self {
        self.modifiers = modifiers;
        self
    }

    /// Builder: add modifiers to the existing set.
    pub const fn add_modifier(mut self, modifier: Modifiers) -> Self {
        self.modifiers = self.modifiers.insert(modifier);
        self
    }

    /// Builder: set the border style.
    pub const fn border_style(mut self, border_style: BorderStyle) -> Self {
        self.border_style = border_style;
        self
    }

    /// Builder: set the color the border glyphs are painted with. `Default`
    /// restores the fallback (the style's own `fg`).
    pub const fn border_color(mut self, border_color: Color) -> Self {
        self.border_color = border_color;
        self
    }

    /// Builder: set the hyperlink target. `None` (the default) clears it,
    /// painting plain text.
    ///
    /// Not `const` like the other builders: assigning over the previous
    /// `Option<Box<str>>` drops the old allocation, which is not const-legal.
    pub fn hyperlink(mut self, hyperlink: Option<Box<str>>) -> Self {
        self.hyperlink = hyperlink;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_bit_ops() {
        let m = Modifiers::BOLD.insert(Modifiers::UNDERLINE);
        assert!(m.contains(Modifiers::BOLD));
        assert!(m.contains(Modifiers::UNDERLINE));
        assert!(!m.contains(Modifiers::ITALIC));
        assert!(!Modifiers::EMPTY.contains(Modifiers::BOLD));
        assert!(Modifiers::EMPTY.is_empty());

        let m2 = m.remove(Modifiers::BOLD);
        assert!(!m2.contains(Modifiers::BOLD));
        assert!(m2.contains(Modifiers::UNDERLINE));

        assert_eq!(
            Modifiers::BOLD.union(Modifiers::DIM),
            Modifiers::BOLD.insert(Modifiers::DIM)
        );
        assert!(!Modifiers::BOLD.contains(Modifiers::DIM));
    }

    #[test]
    fn style_default_and_builders() {
        let s = Style::default();
        assert_eq!(s.fg, Color::Default);
        assert_eq!(s.bg, Color::Default);
        assert_eq!(s.border_style, BorderStyle::None);
        assert_eq!(s.border_color, Color::Default); // unset by default
        assert!(s.hyperlink.is_none()); // unset by default
        assert!(s.modifiers.is_empty());

        let s2 = Style::new()
            .fg(Color::Rgb(1, 2, 3))
            .bg(Color::Indexed(4))
            .add_modifier(Modifiers::BOLD)
            .border_style(BorderStyle::Double)
            .border_color(Color::Rgb(9, 8, 7));
        assert_eq!(s2.fg, Color::Rgb(1, 2, 3));
        assert_eq!(s2.bg, Color::Indexed(4));
        assert!(s2.modifiers.contains(Modifiers::BOLD));
        assert_eq!(s2.border_style, BorderStyle::Double);
        assert_eq!(s2.border_color, Color::Rgb(9, 8, 7));
        assert_eq!(Color::Rgb(1, 2, 3).rgb(), Some((1, 2, 3)));
        assert_eq!(Color::Default.rgb(), None);
    }

    #[test]
    fn hyperlink_round_trip() {
        let s = Style::new().hyperlink(Some("https://example.com".into()));
        assert_eq!(s.hyperlink.as_deref(), Some("https://example.com"));
        // Field readback equals a literal-constructed style.
        let literal = Style {
            hyperlink: Some("https://example.com".into()),
            ..Style::new()
        };
        assert_eq!(s, literal);
        // Clone preserves the hyperlink.
        let cloned = s.clone();
        assert_eq!(cloned.hyperlink.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn hyperlink_participates_in_equality() {
        let a = Style::new().hyperlink(Some("a".into()));
        let b = Style::new().hyperlink(Some("b".into()));
        assert_ne!(a, b, "different hyperlinks differ");

        let linked = Style::new().hyperlink(Some("https://example.com".into()));
        let plain = Style::new();
        assert_ne!(linked, plain, "hyperlink vs none differ");

        let same_a = Style::new().hyperlink(Some("a".into()));
        assert_eq!(a, same_a, "equal hyperlinks are equal");
    }
}
