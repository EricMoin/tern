//! Part 3 of the the taffy layout engine tests.

use super::*;

#[test]
fn props_to_style_maps_position_and_inset() {
    let props = PropMap::from([
        ("position".to_string(), PropValue::Str("absolute".into())),
        ("top".to_string(), PropValue::Int(5)),
        ("right".to_string(), PropValue::Int(6)),
        ("bottom".to_string(), PropValue::Float(7.5)),
        ("left".to_string(), PropValue::Int(8)),
    ]);
    let style = props_to_style(&props);
    assert_eq!(style.position, Position::Absolute);
    assert_eq!(style.inset.top, LengthPercentageAuto::Length(5.0));
    assert_eq!(style.inset.right, LengthPercentageAuto::Length(6.0));
    assert_eq!(style.inset.bottom, LengthPercentageAuto::Length(7.5));
    assert_eq!(style.inset.left, LengthPercentageAuto::Length(8.0));

    // Unset edges stay Auto; an unset or `relative` position is Relative.
    let style = props_to_style(&PropMap::from([("top".to_string(), PropValue::Int(1))]));
    assert_eq!(style.inset.top, LengthPercentageAuto::Length(1.0));
    assert_eq!(style.inset.left, LengthPercentageAuto::Auto);
    assert_eq!(style.inset.right, LengthPercentageAuto::Auto);
    assert_eq!(style.inset.bottom, LengthPercentageAuto::Auto);
    assert_eq!(style.position, Position::Relative);

    let style = props_to_style(&PropMap::from([(
        "position".to_string(),
        PropValue::Str("relative".into()),
    )]));
    assert_eq!(style.position, Position::Relative);
    assert_eq!(props_to_style(&PropMap::new()).position, Position::Relative);
}

#[test]
fn absolute_child_is_positioned_against_parent() {
    // An absolute child's insets resolve against its direct parent: a
    // 50x30 relative parent with top=5,left=3 pins a 10x10 child at
    // (3, 5) inside the parent's padding box.
    let mut scene = new_scene();
    let root = scene.root_id();
    let parent = add_box(&mut scene, root);
    set_prop(&mut scene, parent, "width", PropValue::Int(50));
    set_prop(&mut scene, parent, "height", PropValue::Int(30));
    set_prop(
        &mut scene,
        parent,
        "position",
        PropValue::Str("relative".into()),
    );
    let abs = add_box(&mut scene, parent);
    set_prop(
        &mut scene,
        abs,
        "position",
        PropValue::Str("absolute".into()),
    );
    set_prop(&mut scene, abs, "top", PropValue::Int(5));
    set_prop(&mut scene, abs, "left", PropValue::Int(3));
    set_prop(&mut scene, abs, "width", PropValue::Int(10));
    set_prop(&mut scene, abs, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, parent), Rect::new(0, 0, 50, 30));
    assert_eq!(rect_of(&out, abs), Rect::new(3, 5, 10, 10));
}

#[test]
fn absolute_child_inset_resolves_against_padding_box() {
    // taffy 0.7.7 resolves absolute insets against the direct parent's
    // padding box: the inset origin is parent origin + border. A 30x30
    // parent with a 1-cell border and 2-cell padding puts a top=5,left=3
    // child at (1 + 3, 1 + 5) = (4, 6) — padding does not shift it.
    let mut scene = new_scene();
    let root = scene.root_id();
    let parent = add_box(&mut scene, root);
    set_prop(&mut scene, parent, "width", PropValue::Int(30));
    set_prop(&mut scene, parent, "height", PropValue::Int(30));
    set_prop(&mut scene, parent, "border", PropValue::Int(1));
    set_prop(&mut scene, parent, "padding", PropValue::Int(2));
    let abs = add_box(&mut scene, parent);
    set_prop(
        &mut scene,
        abs,
        "position",
        PropValue::Str("absolute".into()),
    );
    set_prop(&mut scene, abs, "top", PropValue::Int(5));
    set_prop(&mut scene, abs, "left", PropValue::Int(3));
    set_prop(&mut scene, abs, "width", PropValue::Int(10));
    set_prop(&mut scene, abs, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, abs), Rect::new(4, 6, 10, 10));
}

#[test]
fn absolute_child_takes_no_flex_space() {
    // An absolute child is removed from flex flow: it does not push its
    // in-flow sibling, and it is placed by its insets alone.
    let mut scene = new_scene();
    let root = scene.root_id();
    let a = add_box(&mut scene, root);
    set_prop(&mut scene, a, "width", PropValue::Int(10));
    set_prop(&mut scene, a, "height", PropValue::Int(10));
    let abs = add_box(&mut scene, root);
    set_prop(
        &mut scene,
        abs,
        "position",
        PropValue::Str("absolute".into()),
    );
    set_prop(&mut scene, abs, "top", PropValue::Int(0));
    set_prop(&mut scene, abs, "left", PropValue::Int(15));
    set_prop(&mut scene, abs, "width", PropValue::Int(10));
    set_prop(&mut scene, abs, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    // a keeps the row-start slot; abs overlaps at x=15 without pushing it.
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 10, 10));
    assert_eq!(rect_of(&out, abs), Rect::new(15, 0, 10, 10));
}

#[test]
fn percent_width_resolves_against_the_containing_block() {
    // A `width: "50%"` string maps to taffy `Dimension::Percent(0.5)`
    // (taffy stores a 0..1 fraction), which resolves against the parent's
    // content-box width: the root fills the 100-cell viewport, so the
    // child lands at 50 cells.
    let mut scene = new_scene();
    let root = scene.root_id();
    let child = add_box(&mut scene, root);
    set_prop(&mut scene, child, "width", PropValue::Str("50%".into()));
    set_prop(&mut scene, child, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, child), Rect::new(0, 0, 50, 10));
}

#[test]
fn percent_width_tracks_root_width_changes() {
    // The same engine re-layouts on a viewport change: the percentage
    // re-resolves against the new containing-block width (100 -> 200
    // cells yields 50 -> 100 cells), on both the incremental and the
    // fresh-cache paths.
    let mut scene = new_scene();
    let root = scene.root_id();
    let child = add_box(&mut scene, root);
    set_prop(&mut scene, child, "width", PropValue::Str("50%".into()));
    set_prop(&mut scene, child, "height", PropValue::Int(10));

    let mut engine = TaffyLayoutEngine::new();
    let out = engine.compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, child).width, 50);

    // Same scene, wider viewport — the incremental path re-resolves.
    let out = engine.compute(&scene, Size::new(200, 50));
    assert_eq!(rect_of(&out, child).width, 100);

    // A fresh engine on the same scene (cold cache) agrees.
    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(200, 50));
    assert_eq!(rect_of(&out, child).width, 100);
}

#[test]
fn percent_min_and_max_clamp_the_size() {
    // min_width/max_width accept the same `"N%"` strings as width: the
    // resolved size is clamped against the percentage min/max.
    let mut scene = new_scene();
    let root = scene.root_id();
    let min_child = add_box(&mut scene, root);
    set_prop(&mut scene, min_child, "width", PropValue::Str("20%".into()));
    set_prop(&mut scene, min_child, "min_width", PropValue::Str("30%".into()));
    let max_child = add_box(&mut scene, root);
    set_prop(&mut scene, max_child, "width", PropValue::Str("20%".into()));
    set_prop(&mut scene, max_child, "max_width", PropValue::Str("10%".into()));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    // 20% = 20 cells, clamped up to min 30% = 30 cells.
    assert_eq!(rect_of(&out, min_child).width, 30);
    // 20% = 20 cells, clamped down to max 10% = 10 cells.
    assert_eq!(rect_of(&out, max_child).width, 10);
}

#[test]
fn malformed_percent_strings_fall_back_to_auto() {
    // A string that does not match `${number}%` degrades to the absent
    // prop: the style keeps `Dimension::Auto`, never panics.
    for bad in ["50", "abc%", "50 %", "%", "", "5%%"] {
        let style = props_to_style(&PropMap::from([(
            "width".to_string(),
            PropValue::Str(bad.into()),
        )]));
        assert_eq!(style.size.width, Dimension::Auto, "width = {bad:?}");
    }

    // And the layout-level observable: a malformed width lays out exactly
    // like an unset width (content-sized).
    let mut scene = new_scene();
    let root = scene.root_id();
    let plain = add_box(&mut scene, root);
    set_prop(&mut scene, plain, "height", PropValue::Int(10));
    let malformed = add_box(&mut scene, root);
    set_prop(&mut scene, malformed, "width", PropValue::Str("50".into()));
    set_prop(&mut scene, malformed, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, malformed), rect_of(&out, plain));
}

#[test]
fn parse_percent_reads_the_fraction() {
    // The `"N%"` -> 0..1 fraction conversion that backs
    // `prop_length_percentage` (taffy Percent semantics).
    assert_eq!(parse_percent("50%"), Some(0.5));
    assert_eq!(parse_percent("100%"), Some(1.0));
    assert_eq!(parse_percent("0%"), Some(0.0));
    assert_eq!(parse_percent("25%"), Some(0.25));
    assert_eq!(parse_percent("150%"), Some(1.5));
    assert_eq!(parse_percent("50"), None);
    assert_eq!(parse_percent("50 %"), None);
    assert_eq!(parse_percent(""), None);
}

#[test]
fn props_to_style_maps_display_modes() {
    // `display` picks the layout algorithm: "grid" switches the container
    // to CSS grid, "none" hides it (the engine also skips such nodes
    // before they reach taffy), and the default stays flex.
    let grid = props_to_style(&PropMap::from([(
        "display".to_string(),
        PropValue::Str("grid".into()),
    )]));
    assert_eq!(grid.display, Display::Grid);

    let none = props_to_style(&PropMap::from([(
        "display".to_string(),
        PropValue::Str("none".into()),
    )]));
    assert_eq!(none.display, Display::None);

    assert_eq!(props_to_style(&PropMap::new()).display, Display::Flex);
    assert_eq!(
        props_to_style(&PropMap::from([(
            "display".to_string(),
            PropValue::Str("bogus".into()),
        )]))
        .display,
        Display::Flex
    );
}

#[test]
fn props_to_style_parses_grid_tracks() {
    // Flex fractions: `1fr 2fr` -> two flex tracks.
    let style = props_to_style(&PropMap::from([(
        "grid_template_columns".to_string(),
        PropValue::Str("1fr 2fr".into()),
    )]));
    assert_eq!(
        style.grid_template_columns,
        vec![TrackSizingFunction::from_flex(1.0), TrackSizingFunction::from_flex(2.0)]
    );

    // Mixed fixed/auto: `10px 1fr auto` -> length, flex, auto.
    let style = props_to_style(&PropMap::from([(
        "grid_template_rows".to_string(),
        PropValue::Str("10px 1fr auto".into()),
    )]));
    assert_eq!(
        style.grid_template_rows,
        vec![
            TrackSizingFunction::from_length(10.0),
            TrackSizingFunction::from_flex(1.0),
            TrackSizingFunction::Single(NonRepeatedTrackSizingFunction::AUTO),
        ]
    );

    // Percent tracks store the 0..1 fraction (`50%` -> 0.5), and a bare
    // number is a fixed length in cells.
    let style = props_to_style(&PropMap::from([(
        "grid_template_columns".to_string(),
        PropValue::Str("50% 30".into()),
    )]));
    assert_eq!(
        style.grid_template_columns,
        vec![TrackSizingFunction::from_percent(0.5), TrackSizingFunction::from_length(30.0)]
    );

    // Absent / empty / garbage tokens degrade to an empty template (taffy
    // falls back to implicit auto tracks), never a panic.
    assert!(props_to_style(&PropMap::new()).grid_template_columns.is_empty());
    assert!(props_to_style(&PropMap::from([(
        "grid_template_columns".to_string(),
        PropValue::Str("".into()),
    )]))
    .grid_template_columns
    .is_empty());
    let style = props_to_style(&PropMap::from([(
        "grid_template_columns".to_string(),
        PropValue::Str("1fr bogus @@ 2fr".into()),
    )]));
    assert_eq!(style.grid_template_columns, vec![TrackSizingFunction::from_flex(1.0), TrackSizingFunction::from_flex(2.0)]);
}

#[test]
fn props_to_style_maps_grid_auto_flow() {
    let flow = |v: &str| {
        props_to_style(&PropMap::from([("grid_auto_flow".to_string(), PropValue::Str(v.into()))]))
            .grid_auto_flow
    };
    assert_eq!(flow("row"), GridAutoFlow::Row);
    assert_eq!(flow("column"), GridAutoFlow::Column);
    assert_eq!(flow("row-dense"), GridAutoFlow::RowDense);
    assert_eq!(flow("column-dense"), GridAutoFlow::ColumnDense);
    assert_eq!(flow("bogus"), GridAutoFlow::Row); // default
    assert_eq!(props_to_style(&PropMap::new()).grid_auto_flow, GridAutoFlow::Row);
}
