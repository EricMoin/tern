//! Terminal colors.

/// A terminal color.
///
/// `Default` means "leave the terminal's current color alone"; `Indexed`
/// addresses the 256-color palette; `Rgb` is 24-bit truecolor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Color {
    /// Keep the terminal's default color.
    #[default]
    Default,
    /// An ANSI 256-color palette entry (0-255).
    Indexed(u8),
    /// A 24-bit truecolor value.
    Rgb(u8, u8, u8),
}

impl Color {
    /// The RGB channels of an `Rgb` color, if it is one.
    pub const fn rgb(self) -> Option<(u8, u8, u8)> {
        match self {
            Color::Rgb(r, g, b) => Some((r, g, b)),
            _ => None,
        }
    }
}
