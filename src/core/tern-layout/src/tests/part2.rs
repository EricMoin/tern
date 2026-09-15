//! Part 2 of the the taffy layout engine tests.

use super::*;

#[test]
fn wrap_enabled_text_in_column_container_wraps_at_container_width() {
    // In a column container the leaf's width constraint is the container's
    // definite width (the cross-axis available space): 'abcdef' at 4 cells
    // wraps to 2 rows even without an explicit width prop on the leaf.
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "flex_direction",
        PropValue::Str("column".into()),
    );
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let t = scene
        .add_text(root, "abcdef", CellStyle::new())
        .expect("add text");

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(4, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 2));
}

#[test]
fn wrap_false_text_stays_single_row_at_constrained_width() {
    // `wrap: false` keeps the intrinsic single row even with a constrained
    // width: 'abcdef' at a 4-cell width stays one row (the compositor
    // trims the overflow at paint time).
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let t = scene
        .add_text(root, "abcdef", CellStyle::new())
        .expect("add text");
    set_prop(&mut scene, t, "width", PropValue::Int(4));
    set_prop(&mut scene, t, "wrap", PropValue::Bool(false));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 1));
}

#[test]
fn display_none_omits_node_and_subtree() {
    let mut scene = new_scene();
    let root = scene.root_id();
    let hidden = add_box(&mut scene, root);
    set_prop(&mut scene, hidden, "display", PropValue::Str("none".into()));
    let child = add_box(&mut scene, hidden);
    set_prop(&mut scene, child, "width", PropValue::Int(10));
    set_prop(&mut scene, child, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert!(out.iter().all(|(id, _)| *id != hidden && *id != child));
    assert!(out.iter().any(|(id, _)| *id == root));
}

#[test]
fn props_to_style_maps_align_content() {
    let cases: &[(&str, AlignContent)] = &[
        ("flex-start", AlignContent::FlexStart),
        ("flex-end", AlignContent::FlexEnd),
        ("center", AlignContent::Center),
        ("stretch", AlignContent::Stretch),
        ("space-between", AlignContent::SpaceBetween),
        ("space-around", AlignContent::SpaceAround),
        ("space-evenly", AlignContent::SpaceEvenly),
    ];
    for &(value, expected) in cases {
        let props = PropMap::from([(
            "align_content".to_string(),
            PropValue::Str(value.to_string()),
        )]);
        assert_eq!(
            props_to_style(&props).align_content,
            Some(expected),
            "align_content={value}"
        );
    }
    // Absent -> None (taffy resolves the default to Stretch).
    assert_eq!(props_to_style(&PropMap::new()).align_content, None);
}

#[test]
fn align_content_has_no_visible_effect_on_single_line() {
    // tern has no flex_wrap prop, so every flex container is single-line.
    // taffy 0.7.7 sizes the sole line to the container's inner cross size
    // (CSS flexbox algorithm step 8, `calculate_cross_size` in
    // taffy/src/compute/flexbox.rs), leaving zero free cross space: even
    // with align_content flex-end / center the line cannot shift. The
    // prop still maps through to the taffy style (see
    // `props_to_style_maps_align_content`) and will take effect once
    // multi-line wrapping exists. This test pins the actual 0.7.7
    // behavior for a 30-tall row with a 10-tall child: it stays at the
    // cross start (y = 0), NOT at the bottom (y = 20).
    for value in ["flex-end", "center"] {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "width", PropValue::Int(100));
        set_prop(&mut scene, root, "height", PropValue::Int(30));
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        set_prop(
            &mut scene,
            root,
            "align_content",
            PropValue::Str(value.into()),
        );
        let child = add_box(&mut scene, root);
        set_prop(&mut scene, child, "width", PropValue::Int(10));
        set_prop(&mut scene, child, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(
            rect_of(&out, child),
            Rect::new(0, 0, 10, 10),
            "align_content={value} must not move a single-line child"
        );
    }
}

#[test]
fn props_to_style_maps_gap_axes() {
    // column_gap maps to the main-axis gap (gap.width), row_gap to the
    // cross-axis gap (gap.height).
    let props = PropMap::from([
        ("column_gap".to_string(), PropValue::Int(5)),
        ("row_gap".to_string(), PropValue::Int(7)),
    ]);
    let style = props_to_style(&props);
    assert_eq!(style.gap.width, LengthPercentage::Length(5.0));
    assert_eq!(style.gap.height, LengthPercentage::Length(7.0));

    // Uniform `gap` fills both axes (existing behavior).
    let style = props_to_style(&PropMap::from([("gap".to_string(), PropValue::Int(9))]));
    assert_eq!(style.gap.width, LengthPercentage::Length(9.0));
    assert_eq!(style.gap.height, LengthPercentage::Length(9.0));

    // Per-axis gaps override the uniform gap on their axis.
    let props = PropMap::from([
        ("gap".to_string(), PropValue::Int(9)),
        ("column_gap".to_string(), PropValue::Int(3)),
        ("row_gap".to_string(), PropValue::Int(4)),
    ]);
    let style = props_to_style(&props);
    assert_eq!(style.gap.width, LengthPercentage::Length(3.0));
    assert_eq!(style.gap.height, LengthPercentage::Length(4.0));

    // Floats are accepted.
    let style = props_to_style(&PropMap::from([(
        "column_gap".to_string(),
        PropValue::Float(2.5),
    )]));
    assert_eq!(style.gap.width, LengthPercentage::Length(2.5));

    // Absent -> zero on both axes.
    assert_eq!(props_to_style(&PropMap::new()).gap, TaffySize::zero());
}

#[test]
fn column_gap_spaces_row_children_horizontally() {
    // On a row container column_gap is the main-axis gap: three 20-wide
    // children with a 10-cell column_gap sit at x = 0, 30, 60.
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "column_gap", PropValue::Int(10));
    let a = add_box(&mut scene, root);
    let b = add_box(&mut scene, root);
    let c = add_box(&mut scene, root);
    for (id, w, h) in [(a, 20, 10), (b, 20, 10), (c, 20, 10)] {
        set_prop(&mut scene, id, "width", PropValue::Int(w));
        set_prop(&mut scene, id, "height", PropValue::Int(h));
    }

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 20, 10));
    assert_eq!(rect_of(&out, b), Rect::new(30, 0, 20, 10));
    assert_eq!(rect_of(&out, c), Rect::new(60, 0, 20, 10));
}

#[test]
fn props_to_style_maps_min_max_size() {
    let props = PropMap::from([
        ("min_width".to_string(), PropValue::Int(30)),
        ("min_height".to_string(), PropValue::Float(4.0)),
        ("max_width".to_string(), PropValue::Int(200)),
        ("max_height".to_string(), PropValue::Int(40)),
    ]);
    let style = props_to_style(&props);
    assert_eq!(
        style.min_size,
        TaffySize {
            width: Dimension::Length(30.0),
            height: Dimension::Length(4.0),
        }
    );
    assert_eq!(
        style.max_size,
        TaffySize {
            width: Dimension::Length(200.0),
            height: Dimension::Length(40.0),
        }
    );

    // Unset axes stay Auto.
    let style = props_to_style(&PropMap::from([(
        "min_width".to_string(),
        PropValue::Int(5),
    )]));
    assert_eq!(style.min_size.width, Dimension::Length(5.0));
    assert_eq!(style.min_size.height, Dimension::Auto);
    let style = props_to_style(&PropMap::new());
    assert_eq!(
        style.min_size,
        TaffySize {
            width: Dimension::Auto,
            height: Dimension::Auto
        }
    );
    assert_eq!(
        style.max_size,
        TaffySize {
            width: Dimension::Auto,
            height: Dimension::Auto
        }
    );
}

#[test]
fn min_max_size_clamps_explicit_size() {
    let mut scene = new_scene();
    let root = scene.root_id();
    // flex-start keeps children at their explicit heights (no stretch).
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );

    // Width 100 clamped down to max_width 20.
    let a = add_box(&mut scene, root);
    set_prop(&mut scene, a, "width", PropValue::Int(100));
    set_prop(&mut scene, a, "max_width", PropValue::Int(20));
    set_prop(&mut scene, a, "height", PropValue::Int(10));

    // Width 10 raised to min_width 30.
    let b = add_box(&mut scene, root);
    set_prop(&mut scene, b, "width", PropValue::Int(10));
    set_prop(&mut scene, b, "min_width", PropValue::Int(30));
    set_prop(&mut scene, b, "height", PropValue::Int(10));

    // Height 30 clamped down to max_height 20.
    let c = add_box(&mut scene, root);
    set_prop(&mut scene, c, "width", PropValue::Int(10));
    set_prop(&mut scene, c, "height", PropValue::Int(30));
    set_prop(&mut scene, c, "max_height", PropValue::Int(20));

    // Height 10 raised to min_height 30.
    let d = add_box(&mut scene, root);
    set_prop(&mut scene, d, "width", PropValue::Int(10));
    set_prop(&mut scene, d, "height", PropValue::Int(10));
    set_prop(&mut scene, d, "min_height", PropValue::Int(30));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 20, 10));
    assert_eq!(rect_of(&out, b), Rect::new(20, 0, 30, 10));
    assert_eq!(rect_of(&out, c), Rect::new(50, 0, 10, 20));
    assert_eq!(rect_of(&out, d), Rect::new(60, 0, 10, 30));
}

#[test]
fn flex_basis_splits_panes_proportionally_to_viewport() {
    // A 60/40 `flex_basis` split with no explicit sizes anywhere: the
    // pane widths come entirely from taffy's flex-basis resolution (the
    // same prop `dragPanels` in @tern/core sets on a pane during a split
    // resize). In a 100-cell viewport the two bases sum to the container
    // (zero free space) so the panes land at exactly 60/40; halving the
    // viewport shrinks them proportionally — the flex-shrink algorithm
    // scales each item's shrink by its basis — to 30/20.
    let mut scene = new_scene();
    let root = scene.root_id();
    let a = add_box(&mut scene, root);
    let b = add_box(&mut scene, root);
    set_prop(&mut scene, a, "flex_basis", PropValue::Int(60));
    set_prop(&mut scene, b, "flex_basis", PropValue::Int(40));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 60, 10));
    assert_eq!(rect_of(&out, b), Rect::new(60, 0, 40, 10));

    // Half-width viewport: the same split stays proportional (30/20).
    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(50, 10));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 30, 10));
    assert_eq!(rect_of(&out, b), Rect::new(30, 0, 20, 10));
}
