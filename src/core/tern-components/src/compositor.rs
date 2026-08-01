//! The compositor: runs the layout engine over a scene tree and paints the
//! laid-out nodes into a tern-core [`Buffer`].
//!
//! Painting rules (per node kind):
//!
//! * **Box** — paints its background (when a non-default `bg` is set), an
//!   optional border ring at the edges of its laid-out rect, and then lets
//!   its children paint on top. The padding inset is applied by the layout
//!   engine (children land inside `rect + border + padding`).
//! * **Text** — paints its `text` prop content starting at the rect origin,
//!   clipped to the rect (multi-width aware: a wide character never gets
//!   truncated mid-glyph at the right edge).
//! * **Root** — a plain container; paints nothing itself.
//!
//! Nodes are painted in pre-order (parent before children) so children always
//! paint over their ancestors. Geometry comes from the layout engine
//! ([`LayoutEngine`]); cells outside the viewport are ignored.

use std::collections::HashMap;

use tern_core::buffer::Buffer;
use tern_core::cell::{char_width, Cell};
use tern_core::color::Color;
use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropValue, Scene, SceneNode};
use tern_core::style::BorderStyle;
use tern_layout::TaffyLayoutEngine;

use crate::renderable::Renderable;

/// Paints a scene (or a single renderable tree) into a [`Buffer`].
///
/// A fresh layout pass runs on every [`paint`](Compositor::paint) /
/// [`paint_scene`](Compositor::paint_scene) call; the compositor itself is
/// stateless apart from the layout engine.
#[derive(Debug, Clone, Copy, Default)]
pub struct Compositor {
    layout: TaffyLayoutEngine,
}

impl Compositor {
    /// A compositor with a fresh taffy-backed layout engine.
    pub fn new() -> Self {
        Self {
            layout: TaffyLayoutEngine::new(),
        }
    }

    /// Paint a single renderable tree into a fresh `viewport`-sized buffer.
    ///
    /// Accepts a [`Renderable`], [`Box`](crate::Box), or [`Text`](crate::Text)
    /// root. The tree's root becomes the scene root, so it fills the
    /// viewport: a top-level [`Box`](crate::Box) therefore puts its border
    /// glyphs at the edges of the buffer.
    pub fn paint(&mut self, root: impl Into<Renderable>, viewport: Size) -> Buffer {
        let root: Renderable = root.into();
        let mut scene = Scene::new();
        let scene_root = scene.root_id();
        match root {
            Renderable::Box(b) => {
                // The top-level box fills the viewport: promote it to the
                // scene root (which the layout engine sizes to the viewport).
                assert!(
                    scene.update(
                        scene_root,
                        Some(NodeKind::Box),
                        Some(b.style),
                        Some(b.to_props())
                    ),
                    "scene root always exists"
                );
                for child in &b.children {
                    child.materialize(&mut scene, scene_root);
                }
            }
            Renderable::Text(t) => {
                scene.add_text(scene_root, &t.content, t.style);
            }
        }
        self.paint_scene(&scene, viewport)
    }

    /// Paint a whole scene into a fresh `viewport`-sized buffer.
    pub fn paint_scene(&mut self, scene: &Scene, viewport: Size) -> Buffer {
        let mut buffer = Buffer::new(viewport.width, viewport.height);
        let rects: HashMap<NodeId, Rect> = self
            .layout
            .compute(scene, viewport)
            .into_iter()
            .collect();
        self.paint_subtree(scene, scene.root_id(), &rects, &mut buffer);
        buffer
    }

    /// Paint `id` and its descendants (pre-order: parent first, so children
    /// paint over ancestors).
    fn paint_subtree(
        &self,
        scene: &Scene,
        id: NodeId,
        rects: &HashMap<NodeId, Rect>,
        buffer: &mut Buffer,
    ) {
        let Some(node) = scene.node(id) else {
            return;
        };
        // Nodes with no geometry (e.g. `display: none`) are skipped.
        if let Some(&rect) = rects.get(&id) {
            paint_node(node, rect, buffer);
        }
        for &child in &node.children {
            self.paint_subtree(scene, child, rects, buffer);
        }
    }
}

/// Paint a single node into its laid-out rect.
fn paint_node(node: &SceneNode, rect: Rect, buffer: &mut Buffer) {
    match node.kind {
        NodeKind::Root => {}
        NodeKind::Box => paint_box(node, rect, buffer),
        NodeKind::Text => paint_text(node, rect, buffer),
    }
}

/// Paint a box: background fill, optional border ring, then children (painted
/// by the traversal) on top. The padding inset is baked into the children's
/// layout rects.
fn paint_box(node: &SceneNode, rect: Rect, buffer: &mut Buffer) {
    // Background: fill the rect only when a non-default background is set, so
    // default boxes stay transparent over whatever is beneath them.
    if node.style.bg != Color::Default {
        let x0 = rect.x.max(0) as u16;
        let y0 = rect.y.max(0) as u16;
        let x1 = rect.right().min(buffer.width as i32) as u16;
        let y1 = rect.bottom().min(buffer.height as i32) as u16;
        if x1 > x0 && y1 > y0 {
            for y in y0..y1 {
                for x in x0..x1 {
                    buffer.set_cell(x, y, Cell::styled(' ', node.style));
                }
            }
        }
    }

    // Border ring: concrete glyphs are chosen here (tern-core carries only the
    // style choice); the ring is clipped to the buffer.
    let Some((tl, tr, bl, br, h, v)) = border_glyphs(node.style.border_style) else {
        return;
    };
    let x0 = rect.x.max(0) as u16;
    let y0 = rect.y.max(0) as u16;
    let x1 = rect.right().min(buffer.width as i32) as u16;
    let y1 = rect.bottom().min(buffer.height as i32) as u16;
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let last_x = x1 - 1;
    let last_y = y1 - 1;
    for x in x0..x1 {
        buffer.set_char(x, y0, h, node.style); // top edge
        buffer.set_char(x, last_y, h, node.style); // bottom edge
    }
    for y in y0..y1 {
        buffer.set_char(x0, y, v, node.style); // left edge
        buffer.set_char(last_x, y, v, node.style); // right edge
    }
    // Corners (overwrite the edge glyphs).
    buffer.set_char(x0, y0, tl, node.style);
    buffer.set_char(last_x, y0, tr, node.style);
    buffer.set_char(x0, last_y, bl, node.style);
    buffer.set_char(last_x, last_y, br, node.style);
}

/// Paint a text leaf's content starting at its rect origin, clipped to the
/// rect (and to the buffer). A wide character that would straddle the right
/// edge is dropped, never truncated mid-glyph.
fn paint_text(node: &SceneNode, rect: Rect, buffer: &mut Buffer) {
    let Some(PropValue::Str(content)) = node.props.get("text") else {
        return;
    };
    let y = rect.y;
    if y < 0 || y >= buffer.height as i32 {
        return;
    }
    let right = rect.right().min(buffer.width as i32);
    if right <= rect.x {
        return;
    }
    let mut cx = rect.x;
    for ch in content.chars() {
        if cx >= right || ch == '\n' {
            break;
        }
        let w = char_width(ch);
        if w == 0 {
            continue;
        }
        // Paint only fully visible glyphs: skip when the lead cell is
        // off-screen to the left or the wide glyph crosses the right edge.
        if cx >= 0 && cx + w as i32 <= right {
            buffer.set_char(cx as u16, y as u16, ch, node.style);
        }
        cx += w as i32;
    }
}

/// The concrete glyph set for a border style: top-left, top-right,
/// bottom-left, bottom-right corners, horizontal edge, vertical edge.
///
/// `Rounded` maps to the light box-drawing set `┌┐└┘─│` — the exact glyphs
/// pinned by the tern-components MVP acceptance (golden buffer test).
fn border_glyphs(style: BorderStyle) -> Option<(char, char, char, char, char, char)> {
    match style {
        BorderStyle::None => None,
        BorderStyle::Plain => Some(('+', '+', '+', '+', '-', '|')),
        BorderStyle::Rounded => Some(('┌', '┐', '└', '┘', '─', '│')),
        BorderStyle::Double => Some(('╔', '╗', '╚', '╝', '═', '║')),
        BorderStyle::Thick => Some(('┏', '┓', '┗', '┛', '━', '┃')),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderable::{Box, Text};
    use tern_core::style::Style;

    /// Paint a renderable tree and return it as a `Vec<String>` grid for
    /// debugging and golden comparisons.
    fn render_rows(root: impl Into<Renderable>, viewport: Size) -> Vec<String> {
        let buffer = Compositor::new().paint(root, viewport);
        (0..buffer.height)
            .map(|y| {
                (0..buffer.width)
                    .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn golden_rounded_box_padding_hi_in_10x4() {
        // A rounded-border box with 1-cell padding around Text('Hi'), painted
        // into a 10x4 buffer: the box fills the viewport, so the border glyphs
        // (┌┐└┘│─) sit at the edges of the buffer.
        let box_style = Style::new().border_style(BorderStyle::Rounded);
        let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

        let buffer = Compositor::new().paint(tree.clone(), Size::new(10, 4));

        // Expected cell grid:
        //   ┌────────┐
        //   │Hi      │
        //   │        │
        //   └────────┘
        let rows = ["┌────────┐", "│Hi      │", "│        │", "└────────┘"];
        let mut expected = Buffer::new(10, 4);
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                let style = if "┌┐└┘│─".contains(ch) {
                    box_style
                } else {
                    Style::new()
                };
                expected.set_char(x as u16, y as u16, ch, style);
            }
        }

        assert_eq!(buffer, expected);
        assert_eq!(render_rows(tree, Size::new(10, 4)), rows);
    }

    #[test]
    fn text_paints_content_clipped_to_rect() {
        // A bare text root paints its content from the top-left, clipped to
        // the buffer.
        let tree = Text::new("Hello", Style::new());
        let buffer = Compositor::new().paint(tree, Size::new(3, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'H');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, 'e');
        assert_eq!(buffer.cell(2, 0).unwrap().ch, 'l');
    }

    #[test]
    fn text_wider_than_content_area_overflows() {
        // A 5x3 box with 1-cell padding has a 3-wide content area, but taffy
        // cannot shrink a text leaf below its min-content width, so 'Hello'
        // overflows the box's right edge (no child clipping in the MVP) and
        // is painted up to the buffer edge.
        let tree = Box::new(
            Style::new(),
            vec![Text::new("Hello", Style::new()).into()],
        )
        .width(5)
        .height(3)
        .padding(1);

        let rows = render_rows(tree, Size::new(10, 4));
        assert_eq!(rows[0], "          "); // padding row, blank
        assert_eq!(rows[1], " Hello    "); // content row, 'Hello' overflows to col 5
        assert_eq!(rows[2], "          "); // bottom padding row, blank
        assert_eq!(rows[3], "          "); // outside the box rect
    }

    #[test]
    fn box_background_fills_its_rect() {
        let tree = Box::new(Style::new().bg(Color::Indexed(1)), vec![])
            .width(3)
            .height(2);

        let buffer = Compositor::new().paint(tree, Size::new(5, 3));
        for y in 0..2 {
            for x in 0..3 {
                let c = buffer.cell(x, y).unwrap();
                assert_eq!(c.ch, ' ');
                assert_eq!(c.style.bg, Color::Indexed(1));
            }
        }
        // Cells outside the box stay blank (default bg).
        assert_eq!(buffer.cell(3, 0).unwrap().style.bg, Color::Default);
        assert_eq!(buffer.cell(0, 2).unwrap().style.bg, Color::Default);
    }

    #[test]
    fn box_without_border_style_paints_no_border() {
        let tree = Box::new(
            Style::new().border_style(BorderStyle::None),
            vec![Text::new("Hi", Style::new()).into()],
        );

        let rows = render_rows(tree, Size::new(4, 1));
        // No border glyphs: just the text at the origin.
        assert_eq!(rows, vec!["Hi  "]);
    }

    #[test]
    fn paint_scene_handles_a_raw_scene() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene
            .add_child(root, NodeKind::Box, Style::new().border_style(BorderStyle::Plain))
            .unwrap();
        scene.set_prop(b, "padding", PropValue::Int(1));
        scene.add_text(b, "ok", Style::new()).unwrap();

        let buffer = Compositor::new().paint_scene(&scene, Size::new(6, 3));
        // A non-root box sizes to its content: 4x3 (2 + 2 padding), at the
        // origin of the 6x3 viewport.
        //   +--+
        //   |ok|
        //   +--+
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '+');
        assert_eq!(buffer.cell(3, 0).unwrap().ch, '+'); // box top-right corner
        assert_eq!(buffer.cell(0, 1).unwrap().ch, '|');
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'o');
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'k');
        assert_eq!(buffer.cell(3, 2).unwrap().ch, '+'); // box bottom-right corner
        assert_eq!(buffer.cell(5, 0).unwrap().ch, ' '); // outside the box
    }

    #[test]
    fn border_glyph_sets_match_style() {
        assert_eq!(
            border_glyphs(BorderStyle::Rounded),
            Some(('┌', '┐', '└', '┘', '─', '│'))
        );
        assert_eq!(border_glyphs(BorderStyle::None), None);
    }
}
