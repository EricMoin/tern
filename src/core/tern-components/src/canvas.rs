//! [`Canvas`] — a sub-cell dot matrix rendered as Unicode braille (U+2800).
//!
//! A canvas is a `width` x `height` grid of *braille cells*; each cell holds
//! a 2-column x 4-row sub-grid of dots. Dots are addressed in sub-cell
//! coordinates: [`Canvas::set`]`(x, y)` with `x` in `0..width*2` and `y` in
//! `0..height*4`. The rasterizer maps each cell's dot pattern to its U+2800
//! braille glyph — dot 1..8 -> bits 0x01..0x80, the standard Unicode braille
//! block — producing `height` row strings of `width` braille characters.
//!
//! The component materializes into a scene as a column
//! [`Box`](crate::Box) frame (the rasterized rows stack vertically) holding
//! one [`Text`](crate::Text) leaf per row (per `docs/components.md`).

use tern_core::scene::{NodeId, Scene};
use tern_core::style::Style;
use tern_core::{Color, Modifiers};

use crate::renderable::{Box, Renderable};

/// The U+2800 braille dot->bit map: `DOT_BITS[row][col]` is the bit for the
/// dot at sub-cell (`col`, `row`). Standard Unicode braille — (0,0)->dot1->
/// 0x01, (0,1)->dot2->0x02, (0,2)->dot3->0x04, (0,3)->dot4->0x08, (1,0)->
/// dot5->0x10, (1,1)->dot6->0x20, (1,2)->dot7->0x40, (1,3)->dot8->0x80.
const DOT_BITS: [[u8; 2]; 4] = [
    [0x01, 0x10], // row 0: dots 1, 5
    [0x02, 0x20], // row 1: dots 2, 6
    [0x04, 0x40], // row 2: dots 3, 7
    [0x08, 0x80], // row 3: dots 4, 8
];

/// A sub-cell dot matrix rendered as braille characters.
#[derive(Debug, Clone)]
pub struct Canvas {
    /// Canvas width in braille cells (each cell = 2 sub-cell columns).
    pub width: usize,
    /// Canvas height in braille cells (each cell = 4 sub-cell rows).
    pub height: usize,
    /// Per-cell dot bit masks: one `u8` per braille cell, dot `i` set means
    /// bit `1 << i` (dot 1 -> 0x01 ... dot 8 -> 0x80) per [`DOT_BITS`].
    pub bits: Vec<u8>,
    /// The style of the painted braille rows.
    pub style: Style,
}

impl Canvas {
    /// An empty `width` x `height` (in cells) canvas.
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            bits: vec![0; width * height],
            style: Style::new(),
        }
    }

    /// Set the dot at sub-cell (`x`, `y`); `x` in `0..width*2`, `y` in
    /// `0..height*4`. Out-of-bounds coordinates are ignored.
    pub fn set(&mut self, x: usize, y: usize) {
        let Some((cell, bit)) = self.dot_bit(x, y) else {
            return;
        };
        self.bits[cell] |= bit;
    }

    /// Clear the dot at sub-cell (`x`, `y`); out-of-bounds coordinates are
    /// ignored.
    pub fn unset(&mut self, x: usize, y: usize) {
        let Some((cell, bit)) = self.dot_bit(x, y) else {
            return;
        };
        self.bits[cell] &= !bit;
    }

    /// Clear every dot on the canvas.
    pub fn clear(&mut self) {
        self.bits.fill(0);
    }

    /// Builder: set the braille rows' style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Builder: set the foreground color.
    pub fn fg(mut self, color: Color) -> Self {
        self.style = self.style.fg(color);
        self
    }

    /// Builder: set the background color.
    pub fn bg(mut self, color: Color) -> Self {
        self.style = self.style.bg(color);
        self
    }

    /// Builder: add a text modifier.
    pub fn modifier(mut self, modifier: Modifiers) -> Self {
        self.style = self.style.add_modifier(modifier);
        self
    }

    /// The sub-cell (`x`, `y`) as a `(cell index, bit)` pair, or `None` when
    /// the sub-cell is out of bounds.
    fn dot_bit(&self, x: usize, y: usize) -> Option<(usize, u8)> {
        if x >= self.width * 2 || y >= self.height * 4 {
            return None;
        }
        let cell = (y / 4) * self.width + (x / 2);
        Some((cell, DOT_BITS[y % 4][x % 2]))
    }

    // --- Rendering -------------------------------------------------------

    /// The rasterized rows: `height` strings of `width` braille characters,
    /// one per braille cell (`0x2800 | bits` per the U+2800 block).
    pub fn rows(&self) -> Vec<String> {
        (0..self.height)
            .map(|cy| {
                (0..self.width)
                    .map(|cx| {
                        let bits = self.bits[cy * self.width + cx];
                        char::from_u32(0x2800 | u32::from(bits))
                            .expect("braille bit patterns are valid scalar values")
                    })
                    .collect()
            })
            .collect()
    }

    /// The root frame as a bare box (style + layout props, no children): a
    /// column flex so the rasterized rows stack vertically.
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.style.clone(), vec![]).column()
    }

    /// Materialize one text leaf per rasterized row under `parent`.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        for row in self.rows() {
            scene
                .add_text(parent, &row, self.style.clone())
                .expect("canvas row text under its frame");
        }
    }
}

impl From<Canvas> for Renderable {
    fn from(canvas: Canvas) -> Self {
        Renderable::Canvas(canvas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::char_width;
    use tern_core::scene::{NodeKind, PropValue};

    use crate::renderable::Renderable;

    #[test]
    fn dot_bit_mapping_matches_unicode_braille() {
        // Each sub-cell position maps to exactly one U+2800 dot: (col, row) ->
        // (0,0)->dot1->0x01, (0,1)->dot2->0x02, (0,2)->dot3->0x04,
        // (0,3)->dot4->0x08, (1,0)->dot5->0x10, (1,1)->dot6->0x20,
        // (1,2)->dot7->0x40, (1,3)->dot8->0x80.
        let cases = [
            ((0, 0), '⠁'), // 0x2801 dots-1
            ((0, 1), '⠂'), // 0x2802 dots-2
            ((0, 2), '⠄'), // 0x2804 dots-3
            ((0, 3), '⠈'), // 0x2808 dots-4
            ((1, 0), '⠐'), // 0x2810 dots-5
            ((1, 1), '⠠'), // 0x2820 dots-6
            ((1, 2), '⡀'), // 0x2840 dots-7
            ((1, 3), '⢀'), // 0x2880 dots-8
        ];
        for ((col, row), expected) in cases {
            let mut canvas = Canvas::new(1, 1);
            canvas.set(col, row);
            assert_eq!(
                canvas.rows(),
                vec![expected.to_string()],
                "sub-cell ({col},{row})"
            );
        }
    }

    #[test]
    fn emitted_braille_chars_are_single_width() {
        // 多宽字符纪律: every possible 8-dot pattern rasterizes to exactly one
        // single-width terminal cell, so a canvas never shifts its layout.
        for bits in 0..=255u8 {
            let mut canvas = Canvas::new(1, 1);
            canvas.bits[0] = bits;
            let row = &canvas.rows()[0];
            let mut chars = row.chars();
            let w = chars.next().map(char_width).unwrap_or(0);
            assert_eq!(w, 1, "bits {bits:#04x} must rasterize single-width");
            assert!(chars.next().is_none(), "bits {bits:#04x} is one char");
        }
    }

    #[test]
    fn builders_chain_style_like_text() {
        let canvas = Canvas::new(1, 1)
            .fg(Color::Rgb(1, 2, 3))
            .bg(Color::Rgb(4, 5, 6))
            .modifier(Modifiers::BOLD);
        assert_eq!(canvas.width, 1);
        assert_eq!(canvas.height, 1);
        assert_eq!(canvas.style.fg, Color::Rgb(1, 2, 3));
        assert_eq!(canvas.style.bg, Color::Rgb(4, 5, 6));
        assert!(canvas.style.modifiers.contains(Modifiers::BOLD));

        let styled = Canvas::new(1, 1).style(Style::new().fg(Color::Rgb(7, 8, 9)));
        assert_eq!(styled.style.fg, Color::Rgb(7, 8, 9));
    }

    #[test]
    fn rasterized_rows_for_known_pattern() {
        // A 2x2-cell canvas (4 sub-cell columns x 8 sub-cell rows) with dots
        // on the sub-cell diagonal (x, x) plus one at (0, 7):
        //   cell (0,0): dots 1 + 6 = 0x21 -> '⠡'
        //   cell (1,0): dots 3 + 8 = 0x84 -> '⢄'
        //   cell (0,1): dot 4        = 0x08 -> '⠈'
        //   cell (1,1): empty        = 0x00 -> '⠀'
        let mut canvas = Canvas::new(2, 2);
        for x in 0..4 {
            canvas.set(x, x);
        }
        canvas.set(0, 7);
        assert_eq!(canvas.rows(), vec!["⠡⢄".to_string(), "⠈⠀".to_string()]);
    }

    #[test]
    fn set_unset_and_clear_edit_dots() {
        let mut canvas = Canvas::new(1, 1);
        canvas.set(0, 0);
        canvas.set(1, 1);
        assert_eq!(canvas.rows(), vec!["⠡".to_string()]); // dots 1 + 6
        canvas.unset(0, 0);
        assert_eq!(canvas.rows(), vec!["⠠".to_string()]); // dot 6 only
        canvas.clear();
        assert_eq!(canvas.rows(), vec!["⠀".to_string()]); // blank
    }

    #[test]
    fn out_of_bounds_dots_are_ignored() {
        let mut canvas = Canvas::new(1, 1);
        canvas.set(2, 0); // x past the 2 sub-cell columns
        canvas.set(0, 4); // y past the 4 sub-cell rows
        canvas.set(7, 9); // both out of range
        assert_eq!(canvas.rows(), vec!["⠀".to_string()]);
        canvas.unset(99, 99); // no panic
    }

    #[test]
    fn materialize_creates_column_frame_with_one_text_leaf_per_row() {
        let mut canvas = Canvas::new(2, 2);
        for x in 0..4 {
            canvas.set(x, x);
        }
        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = Renderable::from(canvas).materialize(&mut scene, root);

        let frame = scene.node(id).unwrap();
        assert_eq!(frame.kind, NodeKind::Box);
        assert_eq!(
            frame.props.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        let leaves = scene.children(id).unwrap().to_vec();
        assert_eq!(leaves.len(), 2);
        for t in &leaves {
            assert_eq!(scene.node(*t).unwrap().kind, NodeKind::Text);
        }
        let texts: Vec<&str> = leaves
            .iter()
            .map(|t| match scene.prop(*t, "text") {
                Some(PropValue::Str(s)) => s.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(texts, ["⠡⢄", "⠀⠀"]);
    }
}
