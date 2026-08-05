//! Incremental layout (round 2): a single-cell change must not trigger a
//! full tree rebuild, and the incremental result must equal a full recompute
//! rect-for-rect across every mutation class — single text leaf change,
//! stream append, style change, structural add/remove, display:none toggle,
//! viewport resize, and a z-order (paint-only) prop change.

use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropValue, Scene, Span};
use tern_core::style::Style;
use tern_layout::TaffyLayoutEngine;

/// The ids of the non-trivial test scene's nodes.
struct SceneIds {
    row: NodeId,
    left: NodeId,
    text: NodeId,
    right: NodeId,
    stream: NodeId,
    overlay: NodeId,
}

/// A non-trivial scene: a padded column root holding a row of two boxes —
/// one with a text leaf, one with a streaming leaf and an absolutely
/// positioned, z-ordered overlay — so every mutation class has real geometry
/// to disturb.
fn test_scene() -> (Scene, SceneIds) {
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene.set_prop(root, "flex_direction", PropValue::Str("column".into()));
    scene.set_prop(root, "padding", PropValue::Int(1));

    let row = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(row, "width", PropValue::Int(100));
    scene.set_prop(row, "height", PropValue::Int(10));

    let left = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(left, "width", PropValue::Int(40));
    scene.set_prop(left, "height", PropValue::Int(8));
    let text = scene.add_text(left, "Hello", Style::new()).unwrap();

    let right = scene.add_child(row, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(right, "width", PropValue::Int(40));
    scene.set_prop(right, "height", PropValue::Int(8));
    let stream = scene
        .add_child(right, NodeKind::StreamingText, Style::new())
        .unwrap();
    assert!(scene.append_span(
        stream,
        Span {
            text: "stream".into(),
            style: Style::new(),
        }
    ));
    assert!(scene.append_span(
        stream,
        Span {
            text: " data".into(),
            style: Style::new(),
        }
    ));

    let overlay = scene.add_child(right, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
    scene.set_prop(overlay, "top", PropValue::Int(1));
    scene.set_prop(overlay, "left", PropValue::Int(2));
    scene.set_prop(overlay, "width", PropValue::Int(8));
    scene.set_prop(overlay, "height", PropValue::Int(2));
    scene.set_prop(overlay, "z_index", PropValue::Int(5));

    let ids = SceneIds {
        row,
        left,
        text,
        right,
        stream,
        overlay,
    };
    (scene, ids)
}

/// The rects a fresh engine computes (the full-recompute oracle).
fn full_recompute(scene: &Scene, viewport: Size) -> Vec<(NodeId, Rect)> {
    TaffyLayoutEngine::new().compute(scene, viewport)
}

/// Rect-for-rect equality between an incremental pass and a full recompute
/// (the same node set, every rect equal).
fn assert_rects_equal(inc: &[(NodeId, Rect)], full: &[(NodeId, Rect)]) {
    let mut a: Vec<_> = inc.to_vec();
    let mut b: Vec<_> = full.to_vec();
    a.sort_by_key(|(id, _)| *id);
    b.sort_by_key(|(id, _)| *id);
    assert_eq!(
        a, b,
        "incremental layout must equal a full recompute rect-for-rect"
    );
}

/// Warm an engine, apply `mutate`, recompute incrementally and assert the two
/// round-2 invariants: the mutation added no full rebuild, and the
/// incremental rects equal a full recompute. Returns the reconciled count.
fn check_incremental(
    scene: &mut Scene,
    ids: &SceneIds,
    viewport: Size,
    mutate: impl FnOnce(&mut Scene, &SceneIds),
) -> usize {
    let mut engine = TaffyLayoutEngine::new();
    let _ = engine.compute(scene, viewport);
    assert!(
        engine.last_was_full_rebuild(),
        "the warm-up compute is a full rebuild"
    );
    let rebuilds_before = engine.full_rebuilds();

    mutate(scene, ids);
    let inc = engine.compute(scene, viewport);
    assert_rects_equal(&inc, &full_recompute(scene, viewport));
    assert_eq!(
        engine.full_rebuilds(),
        rebuilds_before,
        "the mutation must not trigger a full tree rebuild"
    );
    assert!(
        !engine.last_was_full_rebuild(),
        "the mutation frame must be incremental"
    );
    engine.last_reconciled_node_count()
}

#[test]
fn incremental_single_leaf_change_keeps_cached_tree() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let mut engine = TaffyLayoutEngine::new();
    let _ = engine.compute(&scene, viewport);
    let rebuilds_before = engine.full_rebuilds();

    // A single-cell text change: only the leaf's content differs.
    assert!(scene.set_prop(
        ids.text,
        "text",
        PropValue::Str("Hello, wider world".into())
    ));
    let _ = engine.compute(&scene, viewport);

    assert_eq!(
        engine.full_rebuilds(),
        rebuilds_before,
        "a single-leaf text change must not trigger a full tree rebuild"
    );
    assert!(!engine.last_was_full_rebuild());
    assert!(
        engine.last_reconciled_node_count() <= 3,
        "only the changed leaf is reconciled (got {})",
        engine.last_reconciled_node_count()
    );
}

#[test]
fn incremental_matches_full_recompute_on_single_leaf_change() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let reconciled = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(
            ids.text,
            "text",
            PropValue::Str("Hello, wider world".into())
        ));
    });
    assert!(
        reconciled <= 3,
        "a single text-leaf change reconciles only the leaf (got {reconciled})"
    );
}

#[test]
fn incremental_matches_full_recompute_on_stream_append() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let reconciled = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.append_span(
            ids.stream,
            Span {
                text: " appended".into(),
                style: Style::new(),
            }
        ));
    });
    assert!(
        reconciled <= 3,
        "a stream append reconciles only the leaf (got {reconciled})"
    );
}

#[test]
fn incremental_matches_full_recompute_on_style_change() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let _ = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.left, "width", PropValue::Int(60)));
        assert!(scene.set_prop(ids.left, "height", PropValue::Int(6)));
    });
}

#[test]
fn incremental_matches_full_recompute_on_structural_add() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let _ = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        let extra = scene
            .add_child(ids.row, NodeKind::Box, Style::new())
            .unwrap();
        scene.set_prop(extra, "width", PropValue::Int(10));
        scene.set_prop(extra, "height", PropValue::Int(8));
        let label = scene.add_text(extra, "x", Style::new()).unwrap();
        scene.set_prop(label, "width", PropValue::Int(4));
    });
}

#[test]
fn incremental_matches_full_recompute_on_structural_remove() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let _ = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.remove(ids.right), "removing the right box subtree");
    });
}

#[test]
fn incremental_matches_full_recompute_on_display_none_toggle() {
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let _ = check_incremental(&mut scene, &ids, viewport, |scene, ids| {
        assert!(scene.set_prop(ids.left, "display", PropValue::Str("none".into())));
    });
}

#[test]
fn incremental_matches_full_recompute_on_viewport_resize() {
    // No mutation: only the viewport changes. The root's viewport-fill style
    // differs (set_style marks it dirty) and every node's available space
    // changes, so taffy re-lays-out — but there must be no structural
    // rebuild.
    let (scene, _ids) = test_scene();
    let mut engine = TaffyLayoutEngine::new();
    let _ = engine.compute(&scene, Size::new(120, 30));
    let rebuilds_before = engine.full_rebuilds();

    let viewport = Size::new(90, 20);
    let inc = engine.compute(&scene, viewport);
    assert_rects_equal(&inc, &full_recompute(&scene, viewport));
    assert_eq!(
        engine.full_rebuilds(),
        rebuilds_before,
        "a viewport resize must not rebuild the cached tree"
    );
    assert!(!engine.last_was_full_rebuild());
}

#[test]
fn incremental_matches_full_recompute_on_z_order_overlay() {
    // z_index is a paint-order prop the layout engine never reads: changing
    // it must not disturb the cached tree at all (zero reconciled nodes).
    let (mut scene, ids) = test_scene();
    let viewport = Size::new(120, 30);
    let mut engine = TaffyLayoutEngine::new();
    let before = engine.compute(&scene, viewport);
    let rebuilds_before = engine.full_rebuilds();

    assert!(scene.set_prop(ids.overlay, "z_index", PropValue::Int(9)));
    let after = engine.compute(&scene, viewport);
    assert_rects_equal(&after, &full_recompute(&scene, viewport));
    assert_eq!(after, before, "a z_index change must not move any node");
    assert_eq!(
        engine.full_rebuilds(),
        rebuilds_before,
        "a z_index change must not trigger a rebuild"
    );
    assert_eq!(
        engine.last_reconciled_node_count(),
        0,
        "a paint-only prop change reconciles nothing"
    );
}

#[test]
fn incremental_engine_reuses_cached_tree_across_repeated_unchanged_frames() {
    // A static scene painted repeatedly: after the warm-up, every later frame
    // is a pure no-op (zero reconciled nodes, zero rebuilds).
    let (scene, _ids) = test_scene();
    let viewport = Size::new(120, 30);
    let mut engine = TaffyLayoutEngine::new();
    let _ = engine.compute(&scene, viewport);
    let rebuilds_before = engine.full_rebuilds();

    for _ in 0..3 {
        let _ = engine.compute(&scene, viewport);
        assert_eq!(
            engine.last_reconciled_node_count(),
            0,
            "an unchanged frame reconciles nothing"
        );
        assert_eq!(engine.full_rebuilds(), rebuilds_before);
        assert!(!engine.last_was_full_rebuild());
    }
}
