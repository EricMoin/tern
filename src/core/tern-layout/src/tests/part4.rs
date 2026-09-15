//! Part 4 of the the taffy layout engine tests.

use super::*;

#[test]
fn props_to_style_maps_grid_placement() {
    let auto = TaffyLine { start: GridPlacement::Auto, end: GridPlacement::Auto };

    // An integer is a line index: positive from the start, negative from
    // the end. Only the start is set; the end stays auto (one-track span).
    let style = props_to_style(&PropMap::from([
        ("grid_column".to_string(), PropValue::Int(2)),
        ("grid_row".to_string(), PropValue::Int(-1)),
    ]));
    assert_eq!(style.grid_column, grid_line::<TaffyLine<GridPlacement>>(2));
    assert_eq!(style.grid_row, grid_line::<TaffyLine<GridPlacement>>(-1));

    // `"span N"` -> a track span.
    let style = props_to_style(&PropMap::from([(
        "grid_column".to_string(),
        PropValue::Str("span 2".into()),
    )]));
    assert_eq!(style.grid_column, grid_span::<TaffyLine<GridPlacement>>(2));

    // Zero is an invalid line -> auto placement; malformed strings and
    // absent props also fall back to auto.
    let style = props_to_style(&PropMap::from([("grid_row".to_string(), PropValue::Int(0))]));
    assert_eq!(style.grid_row, auto);
    let style = props_to_style(&PropMap::from([(
        "grid_row".to_string(),
        PropValue::Str("span".into()),
    )]));
    assert_eq!(style.grid_row, auto);
    assert_eq!(props_to_style(&PropMap::new()).grid_column, auto);
}

#[test]
fn grid_two_by_two_places_children_into_cells() {
    // A `display: grid` container with two `1fr` columns and two `1fr`
    // rows splits the 100x50 viewport into four equal 50x25 cells; the
    // four auto-placed children (no own size) stretch to fill their cell
    // (the grid default alignment).
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "display", PropValue::Str("grid".into()));
    set_prop(
        &mut scene,
        root,
        "grid_template_columns",
        PropValue::Str("1fr 1fr".into()),
    );
    set_prop(
        &mut scene,
        root,
        "grid_template_rows",
        PropValue::Str("1fr 1fr".into()),
    );
    let a = add_box(&mut scene, root);
    let b = add_box(&mut scene, root);
    let c = add_box(&mut scene, root);
    let d = add_box(&mut scene, root);

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, root), Rect::new(0, 0, 100, 50));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 50, 25));
    assert_eq!(rect_of(&out, b), Rect::new(50, 0, 50, 25));
    assert_eq!(rect_of(&out, c), Rect::new(0, 25, 50, 25));
    assert_eq!(rect_of(&out, d), Rect::new(50, 25, 50, 25));
}

#[test]
fn grid_explicit_placement_moves_children_to_cells() {
    // `grid_row` / `grid_column` line indices place children in specific
    // cells: positive counts from the start, negative from the end. On a
    // 2-track axis the visible cells start at lines 1/2 (positive) or
    // -3/-2 (negative); line -1 is the last *line*, so starting there
    // with an auto end spans one track off the grid (CSS-correct).
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "display", PropValue::Str("grid".into()));
    set_prop(
        &mut scene,
        root,
        "grid_template_columns",
        PropValue::Str("1fr 1fr".into()),
    );
    set_prop(
        &mut scene,
        root,
        "grid_template_rows",
        PropValue::Str("1fr 1fr".into()),
    );
    let top_left = add_box(&mut scene, root);
    set_prop(&mut scene, top_left, "grid_row", PropValue::Int(1));
    set_prop(&mut scene, top_left, "grid_column", PropValue::Int(1));
    let top_right = add_box(&mut scene, root);
    set_prop(&mut scene, top_right, "grid_row", PropValue::Int(1));
    set_prop(&mut scene, top_right, "grid_column", PropValue::Int(2));
    // Line -2 on a 2-track axis is the interior line: the item occupies
    // the last row and the last column.
    let bottom_right = add_box(&mut scene, root);
    set_prop(&mut scene, bottom_right, "grid_row", PropValue::Int(-2));
    set_prop(&mut scene, bottom_right, "grid_column", PropValue::Int(-2));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, top_left), Rect::new(0, 0, 50, 25));
    assert_eq!(rect_of(&out, top_right), Rect::new(50, 0, 50, 25));
    assert_eq!(rect_of(&out, bottom_right), Rect::new(50, 25, 50, 25));
}

#[test]
fn grid_span_tracks_across_a_row() {
    // `grid_column: "span 2"` stretches the child across both columns of
    // the row it is placed in; an unplaced sibling auto-places into the
    // next free cell.
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "display", PropValue::Str("grid".into()));
    set_prop(
        &mut scene,
        root,
        "grid_template_columns",
        PropValue::Str("1fr 1fr".into()),
    );
    set_prop(
        &mut scene,
        root,
        "grid_template_rows",
        PropValue::Str("1fr 1fr".into()),
    );
    let wide = add_box(&mut scene, root);
    set_prop(&mut scene, wide, "grid_row", PropValue::Int(1));
    set_prop(&mut scene, wide, "grid_column", PropValue::Str("span 2".into()));
    let rest = add_box(&mut scene, root);
    set_prop(&mut scene, rest, "grid_row", PropValue::Int(2));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, wide), Rect::new(0, 0, 100, 25));
    assert_eq!(rect_of(&out, rest), Rect::new(0, 25, 50, 25));
}
