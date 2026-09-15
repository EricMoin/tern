//! Part 3 of the the scene tree tests.

use super::*;

#[test]
fn noop_mutations_do_not_record_dirty() {
    // Equal-value writes are no-ops: they neither bump the epoch nor push
    // the id (a spurious push would widen the next dirty pass for nothing).
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "x", Style::new()).unwrap();
    let (_, _) = scene.take_dirty(); // clear construction-time pushes

    assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
    assert!(scene.set_style(t, Style::new()));
    let props = PropMap::from([("text".to_string(), PropValue::Str("x".to_string()))]);
    assert!(scene.set_props(t, props));

    let (ids, force) = scene.take_dirty();
    assert!(
        ids.is_empty(),
        "no-op writes must not record ids (got {ids:?})"
    );
    assert!(!force);

    // A real change records.
    assert!(scene.set_prop(t, "text", PropValue::Str("y".to_string())));
    let (ids, _) = scene.take_dirty();
    assert!(ids.contains(&t), "a real change records the id");
}

#[test]
fn semantics_store_is_off_by_default_and_rejects_writes() {
    // The store defaults to off: set_semantics fails (returning false),
    // reads stay empty, and no epoch/dirty state changes.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let (_, _) = scene.take_dirty(); // clear the add-child push
    let epoch = scene.epoch();

    assert!(!scene.semantics_enabled(), "the store starts disabled");
    assert!(!scene.set_semantics(a, checkbox_node("x")));
    assert_eq!(scene.semantics(a), None);
    assert_eq!(scene.semantics_iter().count(), 0);
    assert!(!scene.clear_semantics(a), "nothing to clear");

    assert_eq!(scene.epoch(), epoch, "rejected writes must not bump");
    let (ids, force) = scene.take_dirty();
    assert!(ids.is_empty() && !force, "rejected writes push nothing");
}

#[test]
fn semantics_enable_then_set_get_roundtrip() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();

    // Enabling flips the flag and bumps the epoch exactly once.
    assert!(scene.set_semantics_enabled(true));
    assert!(scene.semantics_enabled());
    assert_eq!(scene.epoch(), 2, "enable bumps once (add_child bumped once)");

    let node = checkbox_node("mute");
    assert!(scene.set_semantics(a, node.clone()));
    assert_eq!(scene.semantics(a), Some(&node));
    assert_eq!(scene.semantics_iter().count(), 1);

    // Re-enabling to the same value is a no-op.
    assert!(!scene.set_semantics_enabled(true));
    assert_eq!(scene.epoch(), 3, "no-op enable must not bump");

    // The iterator yields the populated (id, node) pair.
    let entries: Vec<(NodeId, &SemanticsNode)> = scene
        .semantics_iter()
        .map(|(id, n)| (*id, n))
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].0, a);
    assert_eq!(entries[0].1, &node);
}

#[test]
fn equal_value_semantics_write_is_noop() {
    // Mirroring set_prop: an equal-value write returns true (the value is
    // as requested) but neither bumps the epoch nor pushes a dirty id.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_semantics_enabled(true);

    let node = checkbox_node("mute");
    assert!(scene.set_semantics(a, node.clone()));
    let epoch = scene.epoch();

    assert!(scene.set_semantics(a, node.clone()));
    assert!(scene.set_semantics(a, checkbox_node("mute"))); // equal by value
    assert_eq!(scene.epoch(), epoch, "equal semantics writes must not bump");
    assert_eq!(scene.semantics(a), Some(&node));
}

#[test]
fn real_semantics_write_bumps_epoch_but_never_dirty() {
    // A real semantics write bumps the epoch (the app-level change
    // signal) but must NOT push the node into the compositor's dirty set:
    // semantics is pure bookkeeping that cannot change painted content.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_semantics_enabled(true);
    let (_, _) = scene.take_dirty(); // clear add-time pushes

    assert!(scene.set_semantics(a, checkbox_node("mute")));
    let epoch = scene.epoch();
    let (ids, force) = scene.take_dirty();
    assert!(
        ids.is_empty(),
        "a semantics write must never push a dirty id (got {ids:?})"
    );
    assert!(!force);

    assert!(scene.set_semantics(a, checkbox_node("unmute")));
    assert_eq!(scene.epoch(), epoch + 1, "a real write bumps once");
    let (ids, _) = scene.take_dirty();
    assert!(ids.is_empty(), "still nothing pushed after a second write");
}

#[test]
fn clear_semantics_removes_the_entry() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_semantics_enabled(true);
    assert!(scene.set_semantics(a, checkbox_node("mute")));

    let epoch = scene.epoch();
    assert!(scene.clear_semantics(a));
    assert_eq!(scene.epoch(), epoch + 1, "a real clear bumps once");
    assert_eq!(scene.semantics(a), None);
    assert_eq!(scene.semantics_iter().count(), 0);

    // Clearing an absent entry is a no-op.
    let epoch = scene.epoch();
    assert!(!scene.clear_semantics(a));
    assert!(!scene.clear_semantics(NodeId(999)));
    assert_eq!(scene.epoch(), epoch, "no-op clears must not bump");
}

#[test]
fn set_semantics_rejects_missing_nodes() {
    let mut scene = Scene::new();
    scene.set_semantics_enabled(true);
    let epoch = scene.epoch();

    assert!(!scene.set_semantics(NodeId(999), checkbox_node("x")));
    assert_eq!(scene.epoch(), epoch, "missing-node writes must not bump");
    assert_eq!(scene.semantics(NodeId(999)), None);
}

#[test]
fn remove_subtree_purges_semantics_of_every_removed_id() {
    // The parallel semantics map must never outlive its scene node:
    // removing a subtree drops the semantics of every id in it, while a
    // sibling outside the subtree keeps its entry.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
    let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
    let d = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
    scene.set_semantics_enabled(true);
    for id in [a, b, c, d] {
        assert!(scene.set_semantics(id, checkbox_node("x")));
    }
    assert_eq!(scene.semantics_iter().count(), 4);

    assert!(scene.remove(a));
    for id in [a, b, c] {
        assert_eq!(scene.semantics(id), None, "removed id {id:?} keeps no semantics");
    }
    assert!(scene.semantics(d).is_some(), "a sibling outside the subtree keeps its entry");
    assert_eq!(scene.semantics_iter().count(), 1);

    // Removing the last semantics-carrying node empties the store.
    assert!(scene.remove(d));
    assert_eq!(scene.semantics_iter().count(), 0);
}

#[test]
fn disable_gates_writes_but_preserves_entries() {
    // Disabling is a write-gate, not a wipe: existing entries stay
    // readable and re-enabling restores writability as-is.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_semantics_enabled(true);
    let node = checkbox_node("mute");
    assert!(scene.set_semantics(a, node.clone()));

    assert!(scene.set_semantics_enabled(false));
    assert!(!scene.semantics_enabled());
    assert!(!scene.set_semantics(a, checkbox_node("other")));
    assert_eq!(scene.semantics(a), Some(&node), "the stored entry survives a disable");
    assert_eq!(scene.semantics_iter().count(), 1);

    assert!(scene.set_semantics_enabled(true));
    assert!(scene.set_semantics(a, checkbox_node("other")));
    assert_eq!(scene.semantics(a).unwrap().label.as_deref(), Some("other"));
}
