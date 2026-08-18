use super::*;

/// A raw scene with a single `Text` leaf sized to `width` x `height` at
/// the origin (a root text fills the viewport's first row).
fn selection_text_scene(text: &str, width: i64, height: i64) -> Scene {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene
        .add_child(root, NodeKind::Text, Style::new())
        .expect("add text");
    scene.set_prop(t, "text", PropValue::Str(text.into()));
    scene.set_prop(t, "width", PropValue::Int(width));
    scene.set_prop(t, "height", PropValue::Int(height));
    scene
}

#[test]
fn selection_overlay_reverses_selected_cells_and_preserves_content() {
    // A selection spanning cols 1-3 of the text row: those cells gain
    // REVERSED on top of their own style; the character content and the
    // cells outside the selection are untouched.
    let scene = selection_text_scene("hello", 5, 1);
    let mut compositor = Compositor::new();
    compositor.set_selection((1, 0), (3, 0));
    let buffer = compositor.paint_scene(&scene, Size::new(5, 1));

    assert_eq!(buffer.cell(0, 0).unwrap().ch, 'h');
    assert!(!buffer
        .cell(0, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
    for x in 1..=3 {
        let c = buffer.cell(x, 0).unwrap();
        assert_eq!(c.ch, "hello".chars().nth(x as usize).unwrap());
        assert!(
            c.style.modifiers.contains(Modifiers::REVERSED),
            "cell {x} must be reversed"
        );
    }
    assert!(!buffer
        .cell(4, 0)
        .unwrap()
        .style
        .modifiers
        .contains(Modifiers::REVERSED));
}

#[test]
fn selection_overlay_endpoints_are_normalized() {
    // The active endpoint may sit above/left of the anchor: the spanned
    // rectangle is the same either way.
    let scene = selection_text_scene("hello", 5, 1);
    let mut a = Compositor::new();
    a.set_selection((3, 0), (1, 0));
    let buf_a = a.paint_scene(&scene, Size::new(5, 1));
    let mut b = Compositor::new();
    b.set_selection((1, 0), (3, 0));
    let buf_b = b.paint_scene(&scene, Size::new(5, 1));
    assert_eq!(buf_a, buf_b);
    for x in 1..=3 {
        assert!(buf_a.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    }
}

#[test]
fn selection_overlay_is_a_noop_when_unset() {
    // The default compositor (no selection) must produce a frame without
    // any reversed cells — the overlay is a strict no-op when unset.
    let scene = selection_text_scene("hello", 5, 1);
    let mut compositor = Compositor::new();
    let buffer = compositor.paint_scene(&scene, Size::new(5, 1));
    for x in 0..5 {
        assert!(
            !buffer.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED),
            "cell {x} must not be reversed without a selection"
        );
    }
}

#[test]
fn selection_overlay_skips_masked_continuation_cells() {
    // A wide char inside the selection: its lead cell is reversed (the
    // glyph is covered), its masked continuation cell is left untouched —
    // never a reversed NUL that would corrupt the glyph's neighbor.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene
        .add_child(root, NodeKind::Text, Style::new())
        .expect("add text");
    scene.set_prop(t, "text", PropValue::Str("コab".into()));
    scene.set_prop(t, "width", PropValue::Int(4));
    scene.set_prop(t, "height", PropValue::Int(1));

    let mut compositor = Compositor::new();
    compositor.set_selection((0, 0), (3, 0)); // the whole row
    let buffer = compositor.paint_scene(&scene, Size::new(4, 1));
    // コ at cols 0-1 (lead + mask), 'a' at 2, 'b' at 3.
    let lead = buffer.cell(0, 0).unwrap();
    assert_eq!(lead.ch, 'コ');
    assert!(lead.style.modifiers.contains(Modifiers::REVERSED));
    let mask = buffer.cell(1, 0).unwrap();
    assert!(mask.is_masked());
    assert!(!mask.style.modifiers.contains(Modifiers::REVERSED));
    assert!(buffer.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    assert!(buffer.cell(3, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
}

#[test]
fn selection_overlay_change_and_clear_leave_no_stale_reversal() {
    // Moving or clearing the selection must never leave REVERSED on cells
    // that are no longer selected: a selection change forces a full
    // repaint, so the frame is rebuilt fresh before the overlay applies.
    let scene = selection_text_scene("hello", 5, 1);
    let mut compositor = Compositor::new();
    compositor.set_selection((1, 0), (3, 0));
    let first = compositor.paint_scene(&scene, Size::new(5, 1));
    assert!(first.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

    // Shrink the selection: the old cell 3 must lose REVERSED.
    compositor.set_selection((1, 0), (2, 0));
    let shrunk = compositor.paint_scene(&scene, Size::new(5, 1));
    assert!(shrunk.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    assert!(shrunk.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    assert!(!shrunk.cell(3, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

    // Clear it: no reversed cells remain.
    compositor.clear_selection();
    let cleared = compositor.paint_scene(&scene, Size::new(5, 1));
    for x in 0..5 {
        assert!(!cleared.cell(x, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    }
}

#[test]
fn selection_overlay_applied_identically_on_warm_and_fresh_paths() {
    // The mandatory dirty-parity property with a selection SET: a warm
    // compositor (dirty repaints + retained frames) with a selection must
    // produce cell-for-cell identical frames to a fresh compositor (full
    // recompute) with the same selection, across mutations. This pins
    // that the overlay is applied identically on warm and fresh paths.
    let scene = selection_text_scene("hello", 5, 1);
    let mut warm = Compositor::new();
    warm.set_selection((1, 0), (3, 0));
    let mut fresh = Compositor::new();
    fresh.set_selection((1, 0), (3, 0));

    // Frame 0 (cold full paint on both).
    let warm0 = warm.paint_scene(&scene, Size::new(5, 1));
    let fresh0 = fresh.paint_scene(&scene, Size::new(5, 1));
    assert_eq!(warm0, fresh0);

    // Mutate the scene (dirty path on the warm compositor), repaint.
    let mut scene = scene;
    let root = scene.root_id();
    scene.set_prop(root, "padding", PropValue::Int(0));
    // (re-fetch the text id — it is the root's only child)
    let t = scene.children(root).unwrap()[0];
    scene.set_prop(t, "text", PropValue::Str("world".into()));
    let warm1 = warm.paint_scene(&scene, Size::new(5, 1));
    let fresh1 = {
        let mut f = Compositor::new();
        f.set_selection((1, 0), (3, 0));
        f.paint_scene(&scene, Size::new(5, 1))
    };
    assert_eq!(warm1, fresh1);
    assert!(warm1.cell(1, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));

    // The dirty buffer's diff vs the previous frame matches the fresh
    // path's diff (the renderer's terminal output is identical).
    assert_eq!(warm1.diff_from(&warm0), fresh1.diff_from(&fresh0));
}

#[test]
fn selection_overlay_unchanged_selection_keeps_dirty_path() {
    // With a fixed selection, a localized scene mutation takes the dirty
    // path (not a forced full repaint): the overlay is re-applied on top
    // of the dirty result and parity holds. The retained buffer must keep
    // its reversed cells across the dirty pass.
    let scene = selection_text_scene("hello", 5, 1);
    let mut compositor = Compositor::new();
    compositor.set_selection((1, 0), (3, 0));
    compositor.paint_scene(&scene, Size::new(5, 1));

    let mut scene = scene;
    let root = scene.root_id();
    let t = scene.children(root).unwrap()[0];
    scene.set_prop(t, "text", PropValue::Str("hexxo".into()));
    let buffer = compositor.paint_scene(&scene, Size::new(5, 1));
    // The dirty pass repainted the text cell; the overlay still applies.
    assert_eq!(buffer.cell(2, 0).unwrap().ch, 'x');
    assert!(buffer.cell(2, 0).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    // And it matches a fresh full recompute with the same selection.
    let mut fresh = Compositor::new();
    fresh.set_selection((1, 0), (3, 0));
    let full = fresh.paint_scene(&scene, Size::new(5, 1));
    assert_eq!(buffer, full);
}
