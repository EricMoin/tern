//! Scene construction, node properties, and the tree walk.

use super::*;

#[test]
fn scene_has_implicit_root() {
    let scene = Scene::new();
    let root = scene.root_id();
    let n = scene.node(root).unwrap();
    assert_eq!(n.kind, NodeKind::Root);
    assert!(n.children.is_empty());
    assert_eq!(n.parent, None);
    assert_eq!(scene.len(), 1);
    assert!(!scene.is_empty());
}

#[test]
fn add_child_links_parent_and_children() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene
        .add_child(root, NodeKind::Text, Style::new().fg(Color::Rgb(1, 2, 3)))
        .unwrap();
    assert_ne!(a, b);
    assert_eq!(scene.node(a).unwrap().parent, Some(root));
    assert_eq!(scene.node(b).unwrap().style.fg, Color::Rgb(1, 2, 3));
    assert_eq!(scene.children(root).unwrap(), &[a, b]);

    // Nesting: c under a.
    let c = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.children(a).unwrap(), &[c]);
    assert!(scene.is_descendant(c, root));
    assert!(scene.is_descendant(c, a));
    assert!(!scene.is_descendant(b, a));
    assert_eq!(scene.len(), 4);
}

#[test]
fn add_child_missing_parent_returns_none() {
    let mut scene = Scene::new();
    assert!(scene
        .add_child(NodeId(999), NodeKind::Box, Style::new())
        .is_none());
}

#[test]
fn insert_child_at_head_middle_and_tail() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let c = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.children(root).unwrap(), &[a, b, c]);

    // Head: index 0.
    let h = scene
        .insert_child(root, 0, NodeKind::Text, Style::new())
        .unwrap();
    assert_eq!(scene.children(root).unwrap(), &[h, a, b, c]);

    // Tail: index == len appends.
    let t = scene
        .insert_child(root, 4, NodeKind::Text, Style::new())
        .unwrap();
    assert_eq!(scene.children(root).unwrap(), &[h, a, b, c, t]);

    // Middle: index 2 in a 5-child list.
    let m = scene
        .insert_child(root, 2, NodeKind::Text, Style::new())
        .unwrap();
    assert_eq!(scene.children(root).unwrap(), &[h, a, m, b, c, t]);

    // Parent/child links stay consistent for every node.
    for id in [h, a, m, b, c, t] {
        assert_eq!(scene.node(id).unwrap().parent, Some(root));
    }
    assert_eq!(scene.len(), 7); // root + 6 children
}

#[test]
fn insert_child_clamps_index_beyond_len() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.children(root).unwrap(), &[a, b]);

    // index > len clamps to len, i.e. appends.
    let t = scene
        .insert_child(root, 10, NodeKind::Text, Style::new())
        .unwrap();
    assert_eq!(scene.children(root).unwrap(), &[a, b, t]);
}

#[test]
fn insert_child_after_remove_fills_the_gap() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let c = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    assert_eq!(scene.children(root).unwrap(), &[a, b, c]);

    assert!(scene.remove(b));
    assert_eq!(scene.children(root).unwrap(), &[a, c]);

    // Re-insert at the position b used to occupy.
    let b2 = scene
        .insert_child(root, 1, NodeKind::Box, Style::new())
        .unwrap();
    assert_eq!(scene.children(root).unwrap(), &[a, b2, c]);
    assert_eq!(scene.node(b2).unwrap().parent, Some(root));
    assert_ne!(b2, b); // fresh id, not a resurrection
}

#[test]
fn insert_child_missing_parent_returns_none() {
    let mut scene = Scene::new();
    assert!(scene
        .insert_child(NodeId(999), 0, NodeKind::Box, Style::new())
        .is_none());
    assert_eq!(scene.len(), 1); // nothing inserted
}

#[test]
fn root_can_never_be_inserted_into_children() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();

    // A Root-kind node can never be inserted under any parent, including
    // the root itself: the scene's single root is implicit and is never a
    // child of anything.
    assert!(scene
        .insert_child(a, 0, NodeKind::Root, Style::new())
        .is_none());
    assert!(scene
        .insert_child(root, 0, NodeKind::Root, Style::new())
        .is_none());
    assert_eq!(scene.children(root).unwrap(), &[a]);
    assert_eq!(scene.len(), 2); // nothing inserted
}

#[test]
fn add_text_sets_text_prop() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "Hello", Style::new()).unwrap();
    assert_eq!(scene.node(t).unwrap().kind, NodeKind::Text);
    assert_eq!(
        scene.prop(t, "text"),
        Some(&PropValue::Str("Hello".to_string()))
    );
}

#[test]
fn remove_leaf_detaches_from_parent() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();

    assert!(scene.remove(b));
    assert!(scene.node(b).is_none());
    assert_eq!(scene.children(root).unwrap(), &[a]);
    assert!(!scene.remove(b)); // already gone
    assert!(!scene.remove(root)); // root cannot be removed
    assert!(scene.node(root).is_some());
    assert!(scene.remove(a));
    assert!(scene.children(root).unwrap().is_empty());
}

#[test]
fn remove_subtree_removes_descendants() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
    let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
    let d = scene.add_child(a, NodeKind::Text, Style::new()).unwrap();

    assert!(scene.remove(a));
    assert!(scene.node(a).is_none());
    assert!(scene.node(b).is_none());
    assert!(scene.node(c).is_none());
    assert!(scene.node(d).is_none());
    assert!(scene.children(root).unwrap().is_empty());
    assert_eq!(scene.len(), 1);
}

#[test]
fn update_ops_change_kind_style_props() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene.add_text(root, "x", Style::new()).unwrap();

    assert!(scene.set_style(
        t,
        Style::new()
            .fg(Color::Indexed(9))
            .border_style(BorderStyle::Rounded)
    ));
    assert_eq!(scene.node(t).unwrap().style.fg, Color::Indexed(9));
    assert_eq!(
        scene.node(t).unwrap().style.border_style,
        BorderStyle::Rounded
    );

    assert!(scene.set_kind(t, NodeKind::Box));
    assert_eq!(scene.node(t).unwrap().kind, NodeKind::Box);

    assert!(scene.set_prop(t, "width", PropValue::Int(10)));
    assert_eq!(scene.prop(t, "width"), Some(&PropValue::Int(10)));

    let props = PropMap::from([("a".to_string(), PropValue::Bool(true))]);
    assert!(scene.update(
        t,
        None,
        Some(Style::new().bg(Color::Rgb(1, 2, 3))),
        Some(props)
    ));
    let n = scene.node(t).unwrap();
    assert_eq!(n.style.bg, Color::Rgb(1, 2, 3));
    assert_eq!(n.props.len(), 1);
    assert_eq!(n.props.get("a"), Some(&PropValue::Bool(true)));

    // Missing nodes are rejected.
    assert!(!scene.set_style(NodeId(4242), Style::new()));
    assert!(!scene.set_kind(NodeId(4242), NodeKind::Box));
    assert!(!scene.set_prop(NodeId(4242), "x", PropValue::Bool(true)));
    assert!(!scene.update(NodeId(4242), None, None, None));
    assert!(scene.prop(NodeId(4242), "x").is_none());
}

#[test]
fn node_ids_are_unique() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ids = vec![root];
    for _ in 0..100 {
        let id = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
        assert!(!ids.contains(&id));
        ids.push(id);
    }
}

#[test]
fn append_span_accumulates_in_order() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .unwrap();

    assert!(scene.append_span(
        s,
        Span {
            text: "Hel".to_string(),
            style: Style::new(),
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: "lo".to_string(),
            style: Style::new(),
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: "!".to_string(),
            style: Style::new(),
        }
    ));

    let stream = scene.stream(s).unwrap();
    let texts: Vec<&str> = stream.iter().map(|sp| sp.text.as_str()).collect();
    assert_eq!(texts, ["Hel", "lo", "!"]);
}

#[test]
fn append_span_preserves_per_span_styles() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .unwrap();

    let red = Style::new().fg(Color::Rgb(255, 0, 0));
    let bold = Style::new().add_modifier(Modifiers::BOLD);
    assert!(scene.append_span(
        s,
        Span {
            text: "red".to_string(),
            style: red,
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: "bold".to_string(),
            style: bold,
        }
    ));

    let stream = scene.stream(s).unwrap();
    assert_eq!(stream[0].style.fg, Color::Rgb(255, 0, 0));
    assert!(!stream[0].style.modifiers.contains(Modifiers::BOLD));
    assert!(stream[1].style.modifiers.contains(Modifiers::BOLD));
    assert_eq!(stream[1].style.fg, Color::Default);
}

#[test]
fn append_span_keeps_multi_width_chars_intact() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .unwrap();

    // U+30B3 (コ) is a double-width CJK character.
    assert!(scene.append_span(
        s,
        Span {
            text: "コ".to_string(),
            style: Style::new(),
        }
    ));
    assert!(scene.append_span(
        s,
        Span {
            text: "abc".to_string(),
            style: Style::new(),
        }
    ));

    let stream = scene.stream(s).unwrap();
    assert_eq!(stream.len(), 2);
    assert_eq!(stream[0].text, "コ");
    assert_eq!(stream[1].text, "abc");
}
