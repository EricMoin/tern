//! The text cursor (caret) model: position, visibility, shape, blinking, and
//! render style.

use crate::style::Style;

/// The rendered shape of the terminal's hardware caret, per DECSCUSR
/// (`CSI <n> SP q`): a block, a vertical bar, or an underline. Each shape
/// has a blinking and a steady variant; the terminal's default is a steady
/// block, which is why that is [`Default`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CursorShape {
    /// The block caret (■) — the terminal's default shape.
    #[default]
    Block,
    /// The vertical bar caret (|).
    Bar,
    /// The underline caret (_).
    Underline,
}

/// The text cursor of a frame: a 0-based grid position, a visibility flag,
/// the DECSCUSR shape / blinking of the hardware caret, and the style used to
/// paint a block caret over the cell under the cursor.
///
/// Position is in [`Buffer`](crate::Buffer) coordinates (0-based, origin at
/// the top-left). `visible` gates whether the terminal's hardware caret is
/// shown after the frame is flushed; `shape` + `blinking` drive the
/// `SetCursorStyle` sequence the terminal backend emits (a steady block — the
/// terminal default — emits nothing, so existing flushes stay byte-identical
/// until a shape or blink is requested); `style` drives the block-caret
/// painting done by [`Buffer::render_caret`](crate::Buffer::render_caret) —
/// typically a reversed-video (or blinking) highlight of the cell under the
/// cursor.
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
    /// The rendered shape of the hardware caret (block / bar / underline).
    pub shape: CursorShape,
    /// Whether the hardware caret blinks.
    pub blinking: bool,
}

impl Default for Cursor {
    /// A visible caret at the origin with the default (no-op) style, a block
    /// shape, and no blinking — the terminal's own default caret, so flushing
    /// it emits no `SetCursorStyle` sequence.
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            visible: true,
            style: Style::new(),
            shape: CursorShape::Block,
            blinking: false,
        }
    }
}

impl Cursor {
    /// A visible block caret at (`x`, `y`) with the default style.
    pub const fn new(x: u16, y: u16) -> Self {
        Self {
            x,
            y,
            visible: true,
            style: Style::new(),
            shape: CursorShape::Block,
            blinking: false,
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
            shape: CursorShape::Block,
            blinking: false,
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

    /// Builder: give the caret a block shape (the terminal default).
    pub const fn block(mut self) -> Self {
        self.shape = CursorShape::Block;
        self
    }

    /// Builder: give the caret a vertical bar shape.
    pub const fn bar(mut self) -> Self {
        self.shape = CursorShape::Bar;
        self
    }

    /// Builder: give the caret an underline shape.
    pub const fn underline(mut self) -> Self {
        self.shape = CursorShape::Underline;
        self
    }

    /// Builder: make the caret blink.
    pub const fn blink(mut self) -> Self {
        self.blinking = true;
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
    fn default_shape_is_steady_block() {
        // The terminal's own default caret: a steady block. Flushing this
        // cursor emits no SetCursorStyle sequence at all.
        let c = Cursor::default();
        assert_eq!(c.shape, CursorShape::Block);
        assert!(!c.blinking);
        assert_eq!(Cursor::new(3, 1).shape, CursorShape::Block);
        assert!(!Cursor::hidden().blinking);
        assert_eq!(CursorShape::default(), CursorShape::Block);
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

    #[test]
    fn shape_builders_set_the_decscusr_shape() {
        assert_eq!(Cursor::new(0, 0).bar().shape, CursorShape::Bar);
        assert_eq!(Cursor::new(0, 0).underline().shape, CursorShape::Underline);
        assert_eq!(Cursor::new(0, 0).block().shape, CursorShape::Block);
        // The shape builders leave position, visibility, and blinking intact.
        let c = Cursor::hidden().at(5, 2).bar().blink();
        assert_eq!((c.x, c.y), (5, 2));
        assert!(!c.is_visible());
        assert_eq!(c.shape, CursorShape::Bar);
        assert!(c.blinking);
        // `block()` restores the default shape without touching the blink.
        let restored = c.clone().block();
        assert_eq!(restored.shape, CursorShape::Block);
        assert!(restored.blinking);
    }

    #[test]
    fn blink_flips_blinking_without_touching_shape() {
        let c = Cursor::new(1, 1).blink();
        assert!(c.blinking);
        assert_eq!(c.shape, CursorShape::Block);
        // A blinking underline stays an underline; a steady bar never blinks.
        assert!(Cursor::new(0, 0).underline().blink().blinking);
        assert_eq!(Cursor::new(0, 0).underline().blink().shape, CursorShape::Underline);
        assert!(!Cursor::new(0, 0).bar().blinking);
    }
}
