use super::*;

// ---------------------------------------------------------------------
// Dirty-region repaint (round 2)
// ---------------------------------------------------------------------

/// The ids of the dirty-repaint test scene's nodes.
struct DirtyIds {
    left: NodeId,
    text: NodeId,
    right: NodeId,
    stream: NodeId,
    overlay: NodeId,
}

/// A non-trivial scene for dirty-repaint parity: a padded root holding a
/// row of two boxes — one with a text leaf, one with a streaming leaf and
/// an absolutely positioned z-ordered overlay.
fn dirty_repaint_scene() -> (Scene, DirtyIds) {
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene.set_prop(root, "padding", PropValue::Int(1));
    let row = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(row, "width", PropValue::Int(38));
    scene.set_prop(row, "height", PropValue::Int(8));
    let left = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(left, "width", PropValue::Int(18));
    scene.set_prop(left, "height", PropValue::Int(6));
    let text = scene.add_text(left, "Hello", Style::new()).unwrap();
    let right = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(right, "width", PropValue::Int(18));
    scene.set_prop(right, "height", PropValue::Int(6));
    let stream = scene
        .add_child(right, NodeKind::StreamingText, Style::new())
        .unwrap();
    assert!(scene.append_span(
        stream,
        Span {
            text: "s1".into(),
            style: Style::new(),
        }
    ));
    let overlay = scene.add_child(right, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
    scene.set_prop(overlay, "top", PropValue::Int(0));
    scene.set_prop(overlay, "left", PropValue::Int(4));
    scene.set_prop(overlay, "width", PropValue::Int(4));
    scene.set_prop(overlay, "height", PropValue::Int(2));
    scene.set_prop(overlay, "z_index", PropValue::Int(5));
    (
        scene,
        DirtyIds {
            left,
            text,
            right,
            stream,
            overlay,
        },
    )
}

/// Warm a compositor with frame 1, apply `mutate`, paint frame 2 on the
/// warm compositor (the dirty path) and on a fresh compositor (the full
/// recompute oracle), and assert the two invariants: the buffers are
/// cell-for-cell equal, and the diffs vs the same previous frame are
/// identical (so the renderer's terminal output is unchanged).
fn assert_dirty_parity(
    warm: &mut Compositor,
    scene: &mut Scene,
    ids: &DirtyIds,
    viewport: Size,
    mutate: impl FnOnce(&mut Scene, &DirtyIds),
) {
    let prev = warm.paint_scene(scene, viewport);
    assert!(matches!(warm.last_paint_mode(), PaintMode::Full));
    mutate(scene, ids);
    let dirty = warm.paint_scene(scene, viewport);
    let mut fresh = Compositor::new();
    let full = fresh.paint_scene(scene, viewport);
    assert_eq!(
        dirty, full,
        "dirty repaint must equal a full recompute cell-for-cell"
    );
    assert_eq!(
        dirty.diff_from(&prev),
        full.diff_from(&prev),
        "the diff vs the previous frame must be identical between the paths"
    );
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_single_leaf_change() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hello, world!".into())));
    });
    // A single-leaf change repaints a small subset, never everything.
    assert!(
        matches!(warm.last_paint_mode(), PaintMode::Dirty(n) if *n < warm.last_painted_node_count()),
        "a single-leaf change must take the dirty path, got {:?}",
        warm.last_paint_mode()
    );
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_stream_append() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.append_span(
            ids.stream,
            Span {
                text: " s2".into(),
                style: Style::new(),
            }
        ));
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_move() {
    // A style change that shifts the sibling subtree: the dirty region is
    // the union of the old and new bounds, so no stale cells survive.
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(80, 20);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.left, "width", PropValue::Int(10)));
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_shrink() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(80, 20);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.right, "height", PropValue::Int(3)));
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_removal() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(80, 20);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.remove(ids.right), "removing the right subtree");
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_display_none() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(80, 20);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.left, "display", PropValue::Str("none".into())));
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_z_overlay() {
    // A z-index change re-stacks the overlay: the dirty region is the
    // overlay's rect, and the intersecting nodes (the stream beneath it)
    // repaint in the new z-order.
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(80, 20);
    let mut warm = Compositor::new();
    assert_dirty_parity(&mut warm, &mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.overlay, "z_index", PropValue::Int(-1)));
    });
}

#[test]
fn dirty_repaint_buffer_equals_full_recompute_on_status_bar() {
    // A status-bar scene: the strip owns the reserved bottom row. A
    // segment text change must dirty-repaint without disturbing the
    // pinned strip or the panels above it.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let panel = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(panel, "width", PropValue::Int(20));
    scene.set_prop(panel, "height", PropValue::Int(5));
    let _pcontent = scene.add_text(panel, "content", Style::new()).unwrap();
    let strip = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(strip, "status_bar", PropValue::Bool(true));
    scene.set_prop(strip, "width", PropValue::Int(40));
    scene.set_prop(strip, "height", PropValue::Int(1));
    let seg = scene.add_text(strip, "seg", Style::new()).unwrap();

    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    let prev = warm.paint_scene(&scene, viewport);
    // The strip is pinned to the reserved bottom row (row 9); the panel
    // content sits at the top-left.
    assert!(
        (0..40).any(|x| cell_char(&prev, x, 9) == 's'),
        "the pinned strip segment must sit on the reserved bottom row"
    );
    assert_eq!(cell_char(&prev, 0, 0), 'c');

    assert!(scene.set_prop(seg, "text", PropValue::Str("SEG!".into())));
    let dirty = warm.paint_scene(&scene, viewport);
    let mut fresh = Compositor::new();
    let full = fresh.paint_scene(&scene, viewport);
    assert_eq!(
        dirty, full,
        "status-bar dirty repaint must equal a full paint"
    );
    assert_eq!(dirty.diff_from(&prev), full.diff_from(&prev));
    // The reserved row still holds the strip (now "SEG!"), and the panel
    // content above is untouched by the pinning.
    assert!(
        (0..40).any(|x| "SEG!".contains(cell_char(&dirty, x, 9))),
        "the updated segment must be painted on the reserved bottom row"
    );
    assert_eq!(cell_char(&dirty, 0, 0), 'c');
    assert!(matches!(warm.last_paint_mode(), PaintMode::Dirty(_)));
}

#[test]
fn dirty_repaint_localized_mutation_takes_dirty_path() {
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    let _ = warm.paint_scene(&scene, viewport);
    assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hi".into())));
    let _ = warm.paint_scene(&scene, viewport);
    assert!(
        matches!(warm.last_paint_mode(), PaintMode::Dirty(n) if *n < warm.last_painted_node_count()),
        "a localized mutation must take the dirty path, got {:?}",
        warm.last_paint_mode()
    );
    assert_eq!(
        warm.last_repainted_node_count(),
        *match warm.last_paint_mode() {
            PaintMode::Dirty(n) => n,
            other => panic!("expected Dirty, got {other:?}"),
        }
    );
}

#[test]
fn dirty_repaint_resize_takes_full_path() {
    // A viewport change is explicit global invalidation: full repaint.
    let (scene, _ids) = dirty_repaint_scene();
    let mut warm = Compositor::new();
    let _ = warm.paint_scene(&scene, Size::new(40, 10));
    let _ = warm.paint_scene(&scene, Size::new(30, 8));
    assert_eq!(
        warm.last_paint_mode(),
        &PaintMode::Full,
        "a viewport resize must take the full-repaint path"
    );
}

#[test]
fn dirty_repaint_unchanged_scene_returns_retained_buffer() {
    // The scene is painted twice without mutation: the second frame is the
    // retained buffer (no repaint at all), and the diff is empty — the
    // unchanged-scene diff output is byte-identical (empty) exactly as
    // before the dirty-repaint change.
    let (scene, _ids) = dirty_repaint_scene();
    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    let first = warm.paint_scene(&scene, viewport);
    let second = warm.paint_scene(&scene, viewport);
    assert_eq!(warm.last_paint_mode(), &PaintMode::NoPaint);
    assert_eq!(first, second, "the retained buffer is returned unchanged");
    assert!(
        second.diff_from(&first).is_empty(),
        "an unchanged scene produces an empty diff"
    );
}

#[test]
fn dirty_repaint_hit_test_parity() {
    // After a dirty repaint, hit_test on the warm compositor must route
    // exactly like a fresh compositor (same cached/incremental layout).
    let (mut scene, ids) = dirty_repaint_scene();
    let viewport = Size::new(40, 10);
    let mut warm = Compositor::new();
    let _ = warm.paint_scene(&scene, viewport);
    assert!(scene.set_prop(ids.text, "text", PropValue::Str("Hello, world!".into())));
    let _ = warm.paint_scene(&scene, viewport);

    let mut fresh = Compositor::new();
    let _ = fresh.paint_scene(&scene, viewport);
    for (col, row) in [(1, 1), (2, 2), (20, 2), (0, 9), (39, 9)] {
        let a = warm.hit_test(&scene, col, row, viewport);
        let b = fresh.hit_test(&scene, col, row, viewport);
        assert_eq!(a, b, "hit_test parity at ({col},{row})");
    }
}

#[test]
fn dirty_repaint_content_size_parity() {
    // After a dirty repaint, content_size on the warm compositor matches a
    // fresh compositor — including after a viewport resize (full path).
    let (mut scene, ids) = dirty_repaint_scene();
    let mut warm = Compositor::new();
    let _ = warm.paint_scene(&scene, Size::new(40, 10));
    assert!(scene.set_prop(ids.left, "width", PropValue::Int(10)));
    let _ = warm.paint_scene(&scene, Size::new(40, 10));

    let mut fresh = Compositor::new();
    let _ = fresh.paint_scene(&scene, Size::new(40, 10));
    assert_eq!(
        warm.content_size(&scene, ids.left, Size::new(40, 10)),
        fresh.content_size(&scene, ids.left, Size::new(40, 10))
    );
    assert_eq!(
        warm.content_size(&scene, ids.text, Size::new(40, 10)),
        fresh.content_size(&scene, ids.text, Size::new(40, 10))
    );

    // Resize case: repaint at a new viewport (full path), then measure.
    let _ = warm.paint_scene(&scene, Size::new(30, 8));
    let mut fresh2 = Compositor::new();
    let _ = fresh2.paint_scene(&scene, Size::new(30, 8));
    assert_eq!(
        warm.content_size(&scene, ids.stream, Size::new(30, 8)),
        fresh2.content_size(&scene, ids.stream, Size::new(30, 8))
    );
}
