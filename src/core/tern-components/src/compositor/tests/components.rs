use super::*;

#[test]
fn input_caret_paints_reversed_block_over_caret_cell() {
    // A root Input fills the viewport with its 1-cell padding frame; the
    // text leaf lands at (1,1), and the caret prop (display col 2) paints
    // the reversed block caret over the blank cell at (3,1).
    let input = Input::with_value("ab");
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(input, Size::new(6, 3));

    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
    assert_eq!(buffer.cell(2, 1).unwrap().ch, 'b');
    let caret = buffer.cell(3, 1).unwrap();
    assert_eq!(caret.ch, ' ');
    assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
    // Neighbors are untouched.
    assert!(!buffer
        .cell(2, 1)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
    assert!(!buffer
        .cell(4, 1)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}

#[test]
fn input_placeholder_paints_dimmed_with_caret_at_head() {
    // An empty input shows the dimmed placeholder; the caret sits at
    // display col 0, adding REVERSED over the placeholder's DIM.
    let input = Input::new().placeholder("ask");
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(input, Size::new(6, 3));

    let c = buffer.cell(1, 1).unwrap();
    assert_eq!(c.ch, 'a');
    assert!(c.style.modifiers.contains(Modifiers::DIM));
    assert!(c.style.modifiers.contains(Modifiers::REVERSED));
    // The rest of the placeholder stays dimmed but not reversed.
    let second = buffer.cell(2, 1).unwrap();
    assert_eq!(second.ch, 's');
    assert!(second.style.modifiers.contains(Modifiers::DIM));
    assert!(!second.style.modifiers.contains(Modifiers::REVERSED));
}

#[test]
fn input_hidden_caret_paints_no_block() {
    let input = Input::with_value("ab").hide_caret();
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(input, Size::new(6, 3));
    for x in 0..6 {
        let c = buffer.cell(x, 1).unwrap();
        assert!(!c.style.modifiers.contains(Modifiers::REVERSED));
    }
    assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
}

#[test]
fn spinner_bar_paints_filled_and_empty_cells() {
    // A determinate spinner painted as the root: 4-wide bar, 1 of 4 done
    // -> '▓' + 3 '░' + " 25%".
    let mut spinner = Spinner::determinate(4).bar_width(4);
    spinner.set_progress(1);
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(spinner, Size::new(8, 1));
    let row: String = (0..8).map(|x| buffer.cell(x, 0).unwrap().ch).collect();
    assert_eq!(row, "▓░░░ 25%");
}

#[test]
fn spinner_indeterminate_paints_current_frame() {
    let spinner = Spinner::with_frames(&["⠋", "⠙"]);
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(spinner, Size::new(4, 1));
    assert_eq!(buffer.cell(0, 0).unwrap().ch, '⠋');
    assert_eq!(buffer.cell(1, 0).unwrap().ch, ' ');
}

#[test]
fn status_bar_narrow_viewport_drops_low_priority_segments() {
    // Row width 12; total content 13 > 12, so the lowest-priority segment
    // ("ab") is dropped. The survivors lay out with space-between: the
    // left group "cde" (cols 0-2), the right group "fg hijk" pushed to
    // the right edge (f at col 5, h at col 8 — the free cell plus the
    // strip gap sit between the groups).
    let bar = StatusBar::new(Style::new())
        .segment(Segment::new("ab", Style::new()).priority(0))
        .segment(Segment::new("cde", Style::new()).priority(1))
        .segment(
            Segment::new("fg", Style::new())
                .align(SegmentAlign::Right)
                .priority(2),
        )
        .segment(
            Segment::new("hijk", Style::new())
                .align(SegmentAlign::Right)
                .priority(3),
        );
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(bar, Size::new(12, 1));
    let row: String = (0..12).map(|x| buffer.cell(x, 0).unwrap().ch).collect();

    assert!(row.starts_with("cde"), "row = {row:?}");
    assert_eq!(row.chars().nth(5), Some('f'));
    assert_eq!(row.chars().nth(8), Some('h'));
    assert!(!row.contains('a'), "dropped segment still painted: {row:?}");
}

#[test]
fn status_bar_pins_left_and_right_segments_to_the_edges() {
    let bar = StatusBar::new(Style::new())
        .left("L", Style::new())
        .right("R", Style::new());
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(bar, Size::new(20, 1));
    assert_eq!(buffer.cell(0, 0).unwrap().ch, 'L');
    assert_eq!(buffer.cell(19, 0).unwrap().ch, 'R');
}

#[test]
fn golden_canvas_diagonal_braille() {
    // A 2x2-cell canvas (4 sub-cell columns x 8 sub-cell rows) with dots on
    // the sub-cell diagonal (x, x) plus one at (0, 7), painted as the root
    // into a same-sized viewport. Expected rows hand-computed from the
    // U+2800 dot->bit map (dots 1..8 -> bits 0x01..0x80):
    //   cell (0,0): dots 1 + 6 = 0x21 -> U+2821 '⠡'
    //   cell (1,0): dots 3 + 8 = 0x84 -> U+2884 '⢄'
    //   cell (0,1): dot 4        = 0x08 -> U+2808 '⠈'
    //   cell (1,1): empty        = 0x00 -> U+2800 '⠀'
    let mut canvas = Canvas::new(2, 2);
    for x in 0..4 {
        canvas.set(x, x);
    }
    canvas.set(0, 7);
    assert_eq!(render_rows(canvas, Size::new(2, 2)), ["⠡⢄", "⠈⠀"]);
}

#[test]
fn golden_canvas_filled_rectangle_all_dots() {
    // Every dot set in every cell: each cell's 8 bits -> 0xFF -> U+28FF
    // '⣿'. A 3x2-cell canvas painted as the root rasterizes to two rows of
    // three '⣿' each — the top 4 sub-rows of every cell make row 0, the
    // bottom 4 make row 1.
    let mut canvas = Canvas::new(3, 2);
    for x in 0..6 {
        for y in 0..8 {
            canvas.set(x, y);
        }
    }
    assert_eq!(render_rows(canvas, Size::new(3, 2)), ["⣿⣿⣿", "⣿⣿⣿"]);
}

#[test]
fn status_bar_root_pins_to_the_bottom_row() {
    // A root StatusBar is a single-row strip, not a viewport-filling box:
    // it pins to the bottom row of a 20x3 viewport, leaving rows 0-1
    // empty (docs/components.md "StatusBar — Reserved row").
    let bar = StatusBar::new(Style::new())
        .left("L", Style::new())
        .right("R", Style::new());
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(bar, Size::new(20, 3));
    assert_eq!(buffer.cell(0, 2).unwrap().ch, 'L');
    assert_eq!(buffer.cell(19, 2).unwrap().ch, 'R');
    for y in 0..2 {
        for x in 0..20 {
            assert_eq!(
                buffer.cell(x, y).unwrap(),
                &Cell::default(),
                "({x},{y}) not empty"
            );
        }
    }
}

#[test]
fn golden_panels_and_status_bar_reserve_bottom_row() {
    // A column app layout of an expanded Panels strip plus a StatusBar,
    // painted into a 20x8 viewport: the compositor subtracts the bottom
    // row from the layout viewport, so the panels lay out entirely above
    // it and the strip — which flex would have placed at row 5 — pins to
    // the last row (row 7). The last row belongs to the status bar; no
    // panel content and no segment leak across the boundary.
    let tree = Box::new(
        Style::new(),
        vec![
            Panels::new(vec![
                Panel::new("one", Text::new("body-a", Style::new())),
                Panel::new("two", Text::new("body-b", Style::new())),
            ])
            .into(),
            StatusBar::new(Style::new())
                .left("L", Style::new())
                .right("R", Style::new())
                .into(),
        ],
    )
    .column();

    let mut compositor = Compositor::new();
    let buffer = compositor.paint(tree, Size::new(20, 8));
    let rows: Vec<String> = (0..8)
        .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
        .collect();

    // Panels fill the rows above the reserved one: header + body per
    // panel, with the 1-cell inter-panel gap.
    assert!(rows[0].starts_with("▾ one"), "row0 = {:?}", rows[0]);
    assert!(rows[1].starts_with("body-a"), "row1 = {:?}", rows[1]);
    assert!(rows[2].trim().is_empty(), "row2 = {:?}", rows[2]);
    assert!(rows[3].starts_with("▾ two"), "row3 = {:?}", rows[3]);
    assert!(rows[4].starts_with("body-b"), "row4 = {:?}", rows[4]);
    // The in-flow slot the strip would have occupied (row 5) is vacated
    // and stays empty: the strip pinned to the reserved last row.
    assert!(rows[5].trim().is_empty(), "row5 = {:?}", rows[5]);
    assert!(rows[6].trim().is_empty(), "row6 = {:?}", rows[6]);
    // The reserved row belongs to the status bar: its left/right segments
    // pin to the strip's edges.
    assert_eq!(rows[7].chars().next(), Some('L'), "row7 = {:?}", rows[7]);
    assert_eq!(rows[7].chars().nth(19), Some('R'), "row7 = {:?}", rows[7]);
    // No segment leaked above the reserved row, and no panel content
    // leaked onto it.
    assert!(
        !rows[..7].iter().any(|r| r.contains('L') || r.contains('R')),
        "segments leaked above the reserved row"
    );
    assert!(
        !rows[7].contains('▾') && !rows[7].contains("body"),
        "row7 = {:?}",
        rows[7]
    );
}

#[test]
fn panels_collapsed_hides_body_in_painted_buffer() {
    let panels = Panels::new(vec![
        Panel::new("one", Text::new("body-a", Style::new())).collapsed(),
        Panel::new("two", Text::new("body-b", Style::new())),
    ]);
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(panels, Size::new(20, 5));
    let rows: Vec<String> = (0..5)
        .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
        .collect();

    // Row 0: the collapsed panel's header (toggle + title), body omitted.
    assert!(rows[0].starts_with("▸ one"), "row0 = {:?}", rows[0]);
    // Row 1: the inter-panel gap.
    assert!(rows[1].trim().is_empty());
    // Rows 2-3: the expanded panel's header then its body.
    assert!(rows[2].starts_with("▾ two"), "row2 = {:?}", rows[2]);
    assert!(rows[3].starts_with("body-b"), "row3 = {:?}", rows[3]);
    // The collapsed panel's body never painted.
    assert!(!rows.iter().any(|r| r.contains("body-a")));
}
