//! Geometry: rectangles (layout results) and sizes (viewports).

/// A rectangular region in cell coordinates.
///
/// `x`/`y` are signed so a rect may sit partially off-screen; `width`/`height`
/// are unsigned and must stay non-negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Rect {
    /// Leftmost column (inclusive).
    pub x: i32,
    /// Topmost row (inclusive).
    pub y: i32,
    /// Width in cells.
    pub width: u32,
    /// Height in cells.
    pub height: u32,
}

impl Rect {
    /// A rect at (`x`, `y`) with the given size.
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// The empty rect at the origin.
    pub const fn zero() -> Self {
        Self::new(0, 0, 0, 0)
    }

    /// Number of cells covered by this rect.
    pub const fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }

    /// Column just past the right edge (exclusive).
    pub const fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    /// Row just past the bottom edge (exclusive).
    pub const fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    /// Whether the cell (`x`, `y`) lies inside the rect.
    pub const fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    /// The overlap of two rects, or `None` when they are disjoint.
    pub fn intersection(&self, other: &Rect) -> Option<Rect> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = self.right().min(other.right());
        let y1 = self.bottom().min(other.bottom());
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32))
    }

    /// A copy translated by (`dx`, `dy`).
    pub const fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.width, self.height)
    }
}

/// A 2D size in cells, e.g. the terminal viewport passed to the layout
/// engine. Dimensions are `u16` to match the terminal size protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Size {
    /// Width in cells.
    pub width: u16,
    /// Height in cells.
    pub height: u16,
}

impl Size {
    /// A size with the given dimensions.
    pub const fn new(width: u16, height: u16) -> Self {
        Self { width, height }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_geometry() {
        let r = Rect::new(1, 2, 3, 4);
        assert_eq!(r.area(), 12);
        assert_eq!(r.right(), 4);
        assert_eq!(r.bottom(), 6);
        assert!(r.contains(1, 2));
        assert!(r.contains(3, 5));
        assert!(!r.contains(4, 2));
        assert!(!r.contains(0, 0));
        assert_eq!(r.offset(1, -1), Rect::new(2, 1, 3, 4));
        assert_eq!(Rect::zero(), Rect::new(0, 0, 0, 0));
    }

    #[test]
    fn rect_intersection() {
        let a = Rect::new(0, 0, 4, 4);
        let b = Rect::new(2, 2, 4, 4);
        assert_eq!(a.intersection(&b), Some(Rect::new(2, 2, 2, 2)));
        let c = Rect::new(5, 5, 1, 1);
        assert_eq!(a.intersection(&c), None);
        // Touching edges do not intersect.
        let d = Rect::new(4, 0, 1, 4);
        assert_eq!(a.intersection(&d), None);
    }
}
