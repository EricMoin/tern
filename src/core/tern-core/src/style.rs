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

/// The underline style of a text run, per the kitty extended SGR underline
/// protocol (`\x1b[4:Nm`). `None` — the default — carries no style variant:
/// the run underlines (if at all) through the legacy `Modifiers::UNDERLINE`
/// bit, exactly as before the field existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum UnderlineStyle {
    /// No underline style variant (the default). The legacy
    /// [`Modifiers::UNDERLINE`] bit — when set — still paints a plain
    /// underline.
    #[default]
    None,
    /// A single (plain) underline — `\x1b[4:1m`, the extended spelling of
    /// the legacy `\x1b[4m`.
    Single,
    /// A double underline — `\x1b[4:2m`.
    Double,
    /// A curly (squiggly) underline — `\x1b[4:3m`.
    Curly,
    /// A dotted underline — `\x1b[4:4m`.
    Dotted,
    /// A dashed underline — `\x1b[4:5m`.
    Dashed,
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
    /// The underline style variant of the run's text. `None` — the default —
    /// leaves the run to the legacy [`Modifiers::UNDERLINE`] bit; any other
    /// variant paints the kitty extended SGR underline (`\x1b[4:Nm`) when the
    /// terminal supports it, and falls back to a plain underline otherwise.
    /// The field participates in style equality, so a variant change splits
    /// terminal runs at the underline boundary.
    pub underline_style: UnderlineStyle,
    /// The color the run's underline is painted with (kitty extended SGR
    /// `\x1b[58;...m`). `None` — the default — paints the underline in the
    /// terminal's default color. The field participates in style equality,
    /// so an underline color change splits terminal runs.
    pub underline_color: Option<Color>,
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
            underline_style: UnderlineStyle::None,
            underline_color: None,
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

    /// Builder: set the underline style variant. `UnderlineStyle::None` (the
    /// default) restores the legacy behavior — the underline, when any,
    /// comes from the `Modifiers::UNDERLINE` bit.
    pub const fn underline_style(mut self, underline_style: UnderlineStyle) -> Self {
        self.underline_style = underline_style;
        self
    }

    /// Builder: set the color the underline is painted with. `None` (the
    /// default) leaves the underline in the terminal's current color.
    pub const fn underline_color(mut self, underline_color: Option<Color>) -> Self {
        self.underline_color = underline_color;
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
        assert_eq!(s.underline_style, UnderlineStyle::None); // no variant by default
        assert!(s.underline_color.is_none()); // no underline color by default
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

    #[test]
    fn underline_style_builder_round_trip() {
        let s = Style::new().underline_style(UnderlineStyle::Curly);
        assert_eq!(s.underline_style, UnderlineStyle::Curly);
        // Field readback equals a literal-constructed style.
        let literal = Style {
            underline_style: UnderlineStyle::Curly,
            ..Style::new()
        };
        assert_eq!(s, literal);
        // Clone preserves the variant.
        let cloned = s.clone();
        assert_eq!(cloned.underline_style, UnderlineStyle::Curly);
        // Every variant is constructible and distinguishable.
        let variants = [
            UnderlineStyle::None,
            UnderlineStyle::Single,
            UnderlineStyle::Double,
            UnderlineStyle::Curly,
            UnderlineStyle::Dotted,
            UnderlineStyle::Dashed,
        ];
        for (i, v) in variants.iter().enumerate() {
            for (j, w) in variants.iter().enumerate() {
                if i == j {
                    assert_eq!(v, w);
                } else {
                    assert_ne!(v, w);
                }
            }
        }
    }

    #[test]
    fn underline_color_builder_round_trip() {
        let s = Style::new().underline_color(Some(Color::Rgb(255, 0, 0)));
        assert_eq!(s.underline_color, Some(Color::Rgb(255, 0, 0)));
        // Field readback equals a literal-constructed style.
        let literal = Style {
            underline_color: Some(Color::Rgb(255, 0, 0)),
            ..Style::new()
        };
        assert_eq!(s, literal);
        // Clone preserves the color.
        let cloned = s.clone();
        assert_eq!(cloned.underline_color, Some(Color::Rgb(255, 0, 0)));
        // None restores the default.
        let cleared = Style::new().underline_color(None);
        assert_eq!(cleared.underline_color, None);
    }

    #[test]
    fn underline_fields_participate_in_equality() {
        // Different variants split runs: curly differs from double, and any
        // variant differs from the default (no variant).
        let curly = Style::new().underline_style(UnderlineStyle::Curly);
        let double = Style::new().underline_style(UnderlineStyle::Double);
        assert_ne!(curly, double, "different variants differ");
        assert_ne!(curly, Style::new(), "variant vs none differ");

        // Equal variants are equal.
        let curly_again = Style::new().underline_style(UnderlineStyle::Curly);
        assert_eq!(curly, curly_again, "equal variants are equal");

        // An underline color differs from none, and from another color.
        let red = Style::new().underline_color(Some(Color::Rgb(255, 0, 0)));
        let green = Style::new().underline_color(Some(Color::Rgb(0, 255, 0)));
        assert_ne!(red, Style::new(), "colored underline vs none differ");
        assert_ne!(red, green, "different underline colors differ");
        assert_eq!(red, Style::new().underline_color(Some(Color::Rgb(255, 0, 0))));
    }
}
