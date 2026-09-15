//! Part 1 of the the taffy layout engine tests.

use super::*;

#[test]
fn flex_row_positions_children_horizontally() {
    let mut scene = new_scene();
    let root = scene.root_id();
    let a = add_box(&mut scene, root);
    let b = add_box(&mut scene, root);
    for (id, w, h) in [(a, 40, 20), (b, 40, 20)] {
        set_prop(&mut scene, id, "width", PropValue::Int(w));
        set_prop(&mut scene, id, "height", PropValue::Int(h));
    }

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, root), Rect::new(0, 0, 100, 50));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 40, 20));
    assert_eq!(rect_of(&out, b), Rect::new(40, 0, 40, 20));
}

#[test]
fn flex_column_stacks_children_vertically() {
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "flex_direction",
        PropValue::Str("column".into()),
    );
    let a = add_box(&mut scene, root);
    let b = add_box(&mut scene, root);
    for (id, w, h) in [(a, 40, 20), (b, 40, 20)] {
        set_prop(&mut scene, id, "width", PropValue::Int(w));
        set_prop(&mut scene, id, "height", PropValue::Int(h));
    }

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, root), Rect::new(0, 0, 100, 50));
    assert_eq!(rect_of(&out, a), Rect::new(0, 0, 40, 20));
    assert_eq!(rect_of(&out, b), Rect::new(0, 20, 40, 20));
}

#[test]
fn gap_spaces_children_apart() {
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "gap", PropValue::Int(10));
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
fn padding_and_border_inset_content() {
    // Border-box sizing (taffy default): a 30x30 box with 1px border and
    // 2px padding leaves a 24x24 content box; the child starts 3 cells in.
    let mut scene = new_scene();
    let root = scene.root_id();
    let outer = add_box(&mut scene, root);
    set_prop(&mut scene, outer, "width", PropValue::Int(30));
    set_prop(&mut scene, outer, "height", PropValue::Int(30));
    set_prop(&mut scene, outer, "border", PropValue::Int(1));
    set_prop(&mut scene, outer, "padding", PropValue::Int(2));
    let inner = add_box(&mut scene, outer);
    set_prop(&mut scene, inner, "width", PropValue::Int(10));
    set_prop(&mut scene, inner, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 30, 30));
    assert_eq!(rect_of(&out, inner), Rect::new(3, 3, 10, 10));
}

#[test]
fn margin_offsets_a_child() {
    // A uniform margin pushes the child away from the parent's edges
    // without growing the child itself.
    let mut scene = new_scene();
    let root = scene.root_id();
    let outer = add_box(&mut scene, root);
    set_prop(&mut scene, outer, "width", PropValue::Int(40));
    set_prop(&mut scene, outer, "height", PropValue::Int(20));
    let inner = add_box(&mut scene, outer);
    set_prop(&mut scene, inner, "width", PropValue::Int(10));
    set_prop(&mut scene, inner, "height", PropValue::Int(10));
    set_prop(&mut scene, inner, "margin", PropValue::Int(2));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 40, 20));
    assert_eq!(rect_of(&out, inner), Rect::new(2, 2, 10, 10));
}

#[test]
fn margin_top_overrides_uniform_margin() {
    // Per-side margin overrides the uniform margin on that side; the
    // other sides keep the uniform value.
    let mut scene = new_scene();
    let root = scene.root_id();
    let outer = add_box(&mut scene, root);
    set_prop(&mut scene, outer, "width", PropValue::Int(40));
    set_prop(&mut scene, outer, "height", PropValue::Int(30));
    let inner = add_box(&mut scene, outer);
    set_prop(&mut scene, inner, "width", PropValue::Int(10));
    set_prop(&mut scene, inner, "height", PropValue::Int(10));
    set_prop(&mut scene, inner, "margin", PropValue::Int(2));
    set_prop(&mut scene, inner, "margin_top", PropValue::Int(5));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, inner), Rect::new(2, 5, 10, 10));
}

#[test]
fn padding_x_insets_content_horizontally_only() {
    // Per-axis padding applies to both horizontal edges and leaves the
    // vertical axis untouched.
    let mut scene = new_scene();
    let root = scene.root_id();
    let outer = add_box(&mut scene, root);
    set_prop(&mut scene, outer, "width", PropValue::Int(30));
    set_prop(&mut scene, outer, "height", PropValue::Int(30));
    set_prop(&mut scene, outer, "padding_x", PropValue::Int(3));
    let inner = add_box(&mut scene, outer);
    set_prop(&mut scene, inner, "width", PropValue::Int(10));
    set_prop(&mut scene, inner, "height", PropValue::Int(10));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 30, 30));
    assert_eq!(rect_of(&out, inner), Rect::new(3, 0, 10, 10));
}

#[test]
fn text_leaf_is_sized_to_content() {
    let mut scene = new_scene();
    let root = scene.root_id();
    // flex-start alignment keeps the leaf at its measured height of 1
    // instead of stretching to the container height.
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let t = scene
        .add_text(root, "Hello", CellStyle::new())
        .expect("add text");

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 5, 1));
}

#[test]
fn text_measure_is_multi_width_aware() {
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
    let t = scene
        .add_text(root, "コa", CellStyle::new())
        .expect("add text");

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 3, 1));
}

#[test]
fn streaming_text_leaf_is_sized_to_concatenated_content() {
    let mut scene = new_scene();
    let root = scene.root_id();
    // flex-start alignment keeps the leaf at its measured height of 1
    // instead of stretching to the container height.
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let s = scene
        .add_child(root, NodeKind::StreamingText, CellStyle::new())
        .expect("add streaming text");
    assert!(scene.append_span(
        s,
        Span {
            text: "Hello".into(),
            style: CellStyle::new()
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: " world".into(),
            style: CellStyle::new()
        }
    ));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    // "Hello" (5) + " world" (6) -> 11 cells.
    assert_eq!(rect_of(&out, s), Rect::new(0, 0, 11, 1));
}

#[test]
fn streaming_text_measure_is_multi_width_aware() {
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let s = scene
        .add_child(root, NodeKind::StreamingText, CellStyle::new())
        .expect("add streaming text");
    // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
    assert!(scene.append_span(
        s,
        Span {
            text: "コ".into(),
            style: CellStyle::new()
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: "a".into(),
            style: CellStyle::new()
        }
    ));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, s), Rect::new(0, 0, 3, 1));
}

#[test]
fn wrap_false_leaf_keeps_intrinsic_width_in_fixed_container() {
    // A `wrap: false` text/streaming leaf is a single intrinsic-width
    // line: layout must never re-flow it. Inside a fixed-width container
    // it keeps its full content width (overflowing the container), so the
    // compositor trims at paint time (against the clip/viewport edge)
    // instead of the layout engine squeezing the line.
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(&mut scene, root, "width", PropValue::Int(5));
    set_prop(&mut scene, root, "height", PropValue::Int(2));
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let s = scene
        .add_child(root, NodeKind::StreamingText, CellStyle::new())
        .expect("add streaming text");
    set_prop(&mut scene, s, "wrap", PropValue::Bool(false));
    assert!(scene.append_span(
        s,
        Span {
            text: "abc def".into(),
            style: CellStyle::new()
        }
    ));

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
    // 7-cell content width ('abc def') in a 5-wide container: the leaf
    // keeps its intrinsic width and overflows; height stays 1 (single row).
    assert_eq!(rect_of(&out, s), Rect::new(0, 0, 7, 1));
}

#[test]
fn wrap_enabled_text_leaf_heights_to_wrapped_rows_at_explicit_width() {
    // A wrap-enabled Text leaf with an explicit width wraps at that width
    // in LAYOUT: 'abcdef' (6 cells) at a 4-cell width occupies two rows of
    // 4 + 2 cells, so the leaf is 4 wide and 2 tall (the same geometry the
    // compositor paints and `content_size` reports).
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

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 2));
}

#[test]
fn newlines_force_row_breaks_in_wrap_enabled_text() {
    // `\n` forces a row break even without a width constraint: 'ab\ncd'
    // is two rows at its intrinsic widest-line width (2 cells).
    let mut scene = new_scene();
    let root = scene.root_id();
    set_prop(
        &mut scene,
        root,
        "align_items",
        PropValue::Str("flex-start".into()),
    );
    let t = scene
        .add_text(root, "ab\ncd", CellStyle::new())
        .expect("add text");

    let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
    assert_eq!(rect_of(&out, t), Rect::new(0, 0, 2, 2));
}
