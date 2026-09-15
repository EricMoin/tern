//! Semantics store, spans, and streaming updates.

use super::*;

#[test]
fn append_span_rejects_missing_and_non_streaming_nodes() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "plain", Style::new()).unwrap();

    let span = Span {
        text: "x".to_string(),
        style: Style::new(),
    };
    assert!(!scene.append_span(NodeId(999), span.clone()));
    assert!(!scene.append_span(t, span.clone()));
    assert!(scene.stream(NodeId(999)).is_none());
    assert!(scene.stream(t).is_none());
}

#[test]
fn remove_detaches_node_and_its_stream() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .unwrap();
    assert!(scene.append_span(
        s,
        Span {
            text: "gone".to_string(),
            style: Style::new(),
        }
    ));
    assert_eq!(scene.stream(s).unwrap().len(), 1);

    assert!(scene.remove(s));
    assert!(scene.node(s).is_none());
    assert!(scene.stream(s).is_none());
    assert!(scene.children(root).unwrap().is_empty());
}

#[test]
fn clip_rect_defaults_to_none() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.clip_rect(b), None);
    assert_eq!(scene.clip_rect(NodeId(999)), None);
}

#[test]
fn clip_rect_roundtrips_via_props() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert!(scene.set_clip_rect(b, Rect::new(2, 3, 10, 5)));
    assert_eq!(scene.clip_rect(b), Some(Rect::new(2, 3, 10, 5)));
    // Reading the raw props matches the setters.
    assert_eq!(scene.prop(b, "clip_x"), Some(&PropValue::Int(2)));
    assert_eq!(scene.prop(b, "clip_height"), Some(&PropValue::Int(5)));

    // Missing a node fails.
    assert!(!scene.set_clip_rect(NodeId(999), Rect::new(0, 0, 1, 1)));
}

#[test]
fn clip_rect_rejects_negative_dimensions() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(b, "clip_x", PropValue::Int(0));
    scene.set_prop(b, "clip_y", PropValue::Int(0));
    scene.set_prop(b, "clip_width", PropValue::Int(-4));
    scene.set_prop(b, "clip_height", PropValue::Int(2));
    assert_eq!(scene.clip_rect(b), None);
}

#[test]
fn scroll_offset_defaults_and_roundtrips() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.scroll_offset(b), (0, 0));
    assert_eq!(scene.scroll_offset(NodeId(999)), (0, 0));

    assert!(scene.set_scroll_offset(b, 4, -2));
    assert_eq!(scene.scroll_offset(b), (4, -2));
    assert_eq!(scene.prop(b, "scroll_x"), Some(&PropValue::Int(4)));
    assert_eq!(scene.prop(b, "scroll_y"), Some(&PropValue::Int(-2)));

    assert!(!scene.set_scroll_offset(NodeId(999), 1, 1));
}

#[test]
fn epoch_starts_at_zero_and_bumps_on_every_mutation() {
    let mut scene = Scene::new();
    assert_eq!(scene.epoch(), 0, "a fresh scene has epoch 0");
    let root = scene.root_id();
    let mut next = 0;
    let mut expect = |scene: &Scene, label: &str| {
        next += 1;
        assert_eq!(scene.epoch(), next, "{label} must bump the epoch");
    };

    let a = scene
        .add_child(root, NodeKind::Box, Style::new())
        .expect("add_child succeeds");
    expect(&scene, "add_child");

    let b = scene
        .insert_child(root, 0, NodeKind::Text, Style::new())
        .expect("insert_child succeeds");
    expect(&scene, "insert_child");

    scene.set_style(a, Style::new().fg(Color::Rgb(9, 9, 9)));
    expect(&scene, "set_style");

    scene.set_kind(a, NodeKind::Text);
    expect(&scene, "set_kind");

    scene.set_prop(a, "width", PropValue::Int(10));
    expect(&scene, "set_prop");

    scene.set_props(a, PropMap::new());
    expect(&scene, "set_props");

    scene.update(a, Some(NodeKind::Box), None, None);
    expect(&scene, "update");

    assert!(scene.set_clip_rect(a, Rect::new(0, 0, 4, 4)));
    expect(&scene, "set_clip_rect");

    assert!(scene.set_scroll_offset(a, 1, 1));
    expect(&scene, "set_scroll_offset");

    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .expect("add streaming node");
    expect(&scene, "add_child (streaming)");

    assert!(scene.append_span(
        s,
        Span {
            text: "x".to_string(),
            style: Style::new(),
        }
    ));
    expect(&scene, "append_span");

    assert!(scene.remove(b));
    expect(&scene, "remove");

    // `node_mut` hands out a raw borrow, so it bumps conservatively.
    let node = scene.node_mut(a).expect("node exists");
    node.props.insert("z".to_string(), PropValue::Int(1));
    expect(&scene, "node_mut");
}

#[test]
fn epoch_does_not_bump_on_failed_operations() {
    // Failed (no-op) mutations must leave the epoch untouched: the scene
    // is provably unchanged, so a renderer's cached frame stays valid.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "x", Style::new()).unwrap();
    let epoch = scene.epoch();

    assert!(scene
        .add_child(NodeId(999), NodeKind::Box, Style::new())
        .is_none());
    assert!(scene
        .insert_child(NodeId(999), 0, NodeKind::Box, Style::new())
        .is_none());
    assert!(!scene.remove(root)); // root cannot be removed
    assert!(!scene.remove(NodeId(999)));
    assert!(!scene.set_style(NodeId(999), Style::new()));
    assert!(!scene.set_kind(NodeId(999), NodeKind::Box));
    assert!(!scene.set_prop(NodeId(999), "x", PropValue::Bool(true)));
    assert!(!scene.set_props(NodeId(999), PropMap::new()));
    assert!(!scene.update(NodeId(999), None, None, None));
    assert!(!scene.set_clip_rect(NodeId(999), Rect::new(0, 0, 1, 1)));
    assert!(!scene.set_scroll_offset(NodeId(999), 1, 1));
    assert!(!scene.append_span(
        NodeId(999),
        Span {
            text: "x".to_string(),
            style: Style::new(),
        }
    ));
    assert!(!scene.append_span(
        t, // a plain Text node: rejected, stream untouched
        Span {
            text: "x".to_string(),
            style: Style::new(),
        }
    ));

    assert_eq!(scene.epoch(), epoch, "no-op mutations must not bump");
}

#[test]
fn equal_value_prop_writes_do_not_bump_epoch() {
    // The props incremental-sync contract: a write whose value equals the
    // stored one is a no-op — nothing is replaced, the epoch is not
    // bumped, and (downstream) layout is not marked dirty. Only a real
    // change may bump.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "x", Style::new()).unwrap();
    let epoch = scene.epoch();

    // Equal single-key writes: no bump.
    assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
    assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
    assert_eq!(scene.epoch(), epoch, "equal set_prop must not bump");

    // Equal whole-map writes: no bump.
    let props = PropMap::from([("text".to_string(), PropValue::Str("x".to_string()))]);
    assert!(scene.set_props(t, props.clone()));
    assert!(scene.set_props(t, props));
    assert_eq!(scene.epoch(), epoch, "equal set_props must not bump");

    // Equal style writes: no bump.
    assert!(scene.set_style(t, Style::new()));
    assert_eq!(scene.epoch(), epoch, "equal set_style must not bump");

    // A differing value still bumps (and stores).
    let before = scene.epoch();
    assert!(scene.set_prop(t, "text", PropValue::Str("y".to_string())));
    assert_eq!(scene.epoch(), before + 1, "changed set_prop must bump");
    assert_eq!(
        scene.prop(t, "text"),
        Some(&PropValue::Str("y".to_string()))
    );

    // A differing map still bumps (full-table replace semantics).
    let before = scene.epoch();
    assert!(scene.set_props(t, PropMap::from([("a".to_string(), PropValue::Int(1))])));
    assert_eq!(scene.epoch(), before + 1, "changed set_props must bump");
    assert!(
        scene.prop(t, "text").is_none(),
        "set_props replaces the map"
    );

    // A differing style still bumps.
    let before = scene.epoch();
    assert!(scene.set_style(t, Style::new().fg(Color::Rgb(1, 2, 3))));
    assert_eq!(scene.epoch(), before + 1, "changed set_style must bump");
    assert_eq!(scene.node(t).unwrap().style.fg, Color::Rgb(1, 2, 3));

    // Same-value writes after real changes still do not bump.
    let epoch = scene.epoch();
    assert!(scene.set_prop(t, "a", PropValue::Int(1)));
    assert!(scene.set_style(t, Style::new().fg(Color::Rgb(1, 2, 3))));
    assert_eq!(scene.epoch(), epoch, "re-equal writes must not bump");
}

#[test]
fn take_dirty_drains_pushed_ids_and_force_flag() {
    // Every epoch-bumping mutation records the mutated id; a raw
    // `node_mut` borrow additionally sets the force-full-scan flag; a
    // drain resets both.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .unwrap();

    scene.set_prop(b, "text", PropValue::Str("x".into()));
    scene.set_clip_rect(a, Rect::new(0, 0, 4, 4));
    scene.set_scroll_offset(a, 1, 1);
    assert!(scene.append_span(
        s,
        Span {
            text: "s".into(),
            style: Style::new(),
        }
    ));

    let (ids, force) = scene.take_dirty();
    assert!(
        ids.contains(&a),
        "set_clip_rect/set_scroll_offset record the id"
    );
    assert!(ids.contains(&b), "set_prop records the id");
    assert!(ids.contains(&s), "append_span records the id");
    assert!(!force, "API mutations do not force a full scan");

    // A raw borrow records its id and forces the full scan.
    let _ = scene.node_mut(a).unwrap();
    let (ids, force) = scene.take_dirty();
    assert!(ids.contains(&a), "node_mut records the id");
    assert!(force, "node_mut sets the force-full-scan flag");

    // Draining resets both: no mutations in between ⇒ empty drain.
    let (ids, force) = scene.take_dirty();
    assert!(
        ids.is_empty(),
        "a drain with no mutation in between is empty"
    );
    assert!(!force);
}

#[test]
fn remove_records_every_subtree_id() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
    let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
    let _d = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();

    let (_, _) = scene.take_dirty(); // clear the add-time pushes
    assert!(scene.remove(a));
    let (ids, _) = scene.take_dirty();
    for id in [a, b, c] {
        assert!(
            ids.contains(&id),
            "removed subtree id {id:?} must be recorded so the compositor \
             repaints its old bounds"
        );
    }
    assert!(
        !ids.contains(&root),
        "the root is never removed and must not be recorded"
    );
}
