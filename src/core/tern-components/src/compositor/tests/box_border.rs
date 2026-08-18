use super::*;

#[test]
fn golden_rounded_box_padding_hi_in_10x4() {
    // A rounded-border box with 1-cell padding around Text('Hi'), painted
    // into a 10x4 buffer: the box fills the viewport, so the border glyphs
    // (┌┐└┘│─) sit at the edges of the buffer.
    let box_style = Style::new().border_style(BorderStyle::Rounded);
    let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

    let mut compositor = Compositor::new();
    let buffer = compositor.paint(tree.clone(), Size::new(10, 4));

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
fn golden_rounded_box_border_color_paints_border_cells_in_color() {
    // A rounded-border box with a `border_color`: the border glyphs paint
    // with that color as their foreground while every other cell keeps its
    // own style — and the glyphs themselves are unchanged (the plain rows
    // are identical to the uncolored golden).
    let box_style = Style::new()
        .border_style(BorderStyle::Rounded)
        .border_color(Color::Rgb(255, 0, 0));
    let tree = Box::new(box_style, vec![Text::new("Hi", Style::new()).into()]).padding(1);

    let mut compositor = Compositor::new();
    let buffer = compositor.paint(tree.clone(), Size::new(6, 3));

    // Every border cell carries the border color as its fg.
    for (x, y) in [
        (0, 0),
        (5, 0),
        (2, 0), // top edge
        (0, 1),
        (5, 1), // left/right edges
        (0, 2),
        (5, 2),
        (2, 2), // bottom edge
    ] {
        let cell = buffer.cell(x, y).expect("border cell in bounds");
        assert_eq!(
            cell.style.fg, Color::Rgb(255, 0, 0),
            "border cell ({x},{y}) must carry the border color"
        );
    }
    // Interior and content cells are untouched by the border color.
    assert_eq!(buffer.cell(1, 1).unwrap().style.fg, Color::Default);
    assert_eq!(buffer.cell(2, 1).unwrap().style.fg, Color::Default);
    // The glyph grid is byte-identical to an uncolored border: a root
    // box stretches to the viewport, so the ring fills the 6x3 buffer
    // (matching the `golden_rounded_box_padding_hi_in_10x4` geometry).
    assert_eq!(
        render_rows(tree, Size::new(6, 3)),
        vec!["┌────┐", "│Hi  │", "└────┘"]
    );
}

#[test]
fn box_background_fills_its_rect() {
    let tree = Box::new(Style::new().bg(Color::Indexed(1)), vec![])
        .width(3)
        .height(2);

    let mut compositor = Compositor::new();
    let buffer = compositor.paint(tree, Size::new(5, 3));
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
        .add_child(
            root,
            NodeKind::Box,
            Style::new().border_style(BorderStyle::Plain),
        )
        .unwrap();
    scene.set_prop(b, "padding", PropValue::Int(1));
    scene.add_text(b, "ok", Style::new()).unwrap();

    let mut compositor = Compositor::new();
    let buffer = compositor.paint_scene(&scene, Size::new(6, 3));
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
