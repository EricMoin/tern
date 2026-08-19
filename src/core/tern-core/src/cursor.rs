//! The text cursor (caret) model: position, visibility, and render style.

use crate::style::Style;

/// The text cursor of a frame: a 0-based grid position, a visibility flag,
/// and the style used to paint a block caret over the cell under the cursor.
///
/// Position is in [`Buffer`](crate::Buffer) coordinates (0-based, origin at
/// the top-left). `visible` gates whether the terminal's hardware caret is
/// shown after the frame is flushed; `style` drives the block-caret painting
/// done by [`Buffer::render_caret`](crate::Buffer::render_caret) — typically
/// a reversed-video (or blinking) highlight of the cell under the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    /// Column (0-based cell column).
    pub x: u16,
    /// Row (0-based cell row).
    pub y: u16,
    /// Whether the caret is shown.
    pub visible: bool,
    /// Style applied to the cell under the cursor when the caret is rendered.
    pub style: Style,
}

impl Default for Cursor {
    /// A visible caret at the origin with the default (no-op) style.
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            visible: true,
            style: Style::new(),
        }
    }
}

impl Cursor {
    /// A visible caret at (`x`, `y`) with the default style.
    pub const fn new(x: u16, y: u16) -> Self {
        Self {
            x,
            y,
            visible: true,
            style: Style::new(),
        }
    }

    /// A hidden caret at the origin: the position is still tracked and
    /// emitted, but the terminal is told not to show it. This is the typical
    /// state while drawing.
    pub const fn hidden() -> Self {
        Self {
            x: 0,
            y: 0,
            visible: false,
            style: Style::new(),
        }
    }

    /// Builder: move the caret to (`x`, `y`).
    pub const fn at(mut self, x: u16, y: u16) -> Self {
        self.x = x;
        self.y = y;
        self
    }

    /// Builder: mark the caret visible.
    pub const fn show(mut self) -> Self {
        self.visible = true;
        self
    }

    /// Builder: mark the caret hidden.
    pub const fn hide(mut self) -> Self {
        self.visible = false;
        self
    }

    /// Builder: set the style the caret renders with.
    pub fn styled(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Whether the caret is currently visible.
    pub const fn is_visible(&self) -> bool {
        self.visible
    }

    /// The caret position as `(x, y)`.
    pub const fn position(&self) -> (u16, u16) {
        (self.x, self.y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::Color;
    use crate::style::Modifiers;

    #[test]
    fn default_is_visible_at_origin() {
        let c = Cursor::default();
        assert_eq!(c.position(), (0, 0));
        assert!(c.is_visible());
        assert_eq!(c.style, Style::new());
        assert_eq!(c, Cursor::new(0, 0));
    }

    #[test]
    fn new_tracks_position() {
        let c = Cursor::new(7, 3);
        assert_eq!(c.position(), (7, 3));
        assert_eq!((c.x, c.y), (7, 3));
        assert!(c.is_visible());
    }

    #[test]
    fn at_repositions() {
        let c = Cursor::new(1, 1).at(9, 5);
        assert_eq!(c.position(), (9, 5));
        // Moving the caret never flips its visibility.
        assert!(c.is_visible());
        let h = Cursor::hidden().at(4, 2);
        assert_eq!(h.position(), (4, 2));
        assert!(!h.is_visible());
    }

    #[test]
    fn show_hide_flip_visibility() {
        let mut c = Cursor::new(2, 2);
        assert!(c.is_visible());
        c = c.hide();
        assert!(!c.is_visible());
        c = c.show();
        assert!(c.is_visible());
        // Hiding keeps the tracked position intact.
        assert_eq!(c.position(), (2, 2));

        // `hidden()` starts invisible; `show()` flips it on.
        assert!(Cursor::hidden().show().is_visible());
        assert!(!Cursor::new(0, 0).hide().is_visible());
    }

    #[test]
    fn styled_sets_render_style() {
        let reversed = Style::new().add_modifier(Modifiers::REVERSED);
        let c = Cursor::new(3, 3).styled(reversed.clone());
        assert_eq!(c.style, reversed);
        assert!(c.style.modifiers.contains(Modifiers::REVERSED));

        // A styled caret with a color keeps both pieces of state.
        let red = Style::new().fg(Color::Rgb(255, 0, 0));
        let c2 = Cursor::hidden().at(1, 1).styled(red);
        assert_eq!(c2.style.fg, Color::Rgb(255, 0, 0));
        assert!(!c2.is_visible());
    }
}
