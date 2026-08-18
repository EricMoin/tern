use super::*;

#[test]
fn create_node_accepts_streaming_text_type() {
    let node = create_node("streaming_text".to_string(), None).expect("create streaming node");
    assert_eq!(
        node.inner.lock().expect("node inner poisoned").kind,
        NodeKind::StreamingText
    );
}

#[test]
fn create_node_rejects_unknown_type() {
    let err = match create_node("marquee".to_string(), None) {
        Ok(_) => panic!("unknown type must error"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("streaming_text"), "{err}");
}

#[test]
fn set_prop_updates_a_single_key_on_an_attached_node() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");

    text.set_prop("text".to_string(), serde_json::json!("hi"))
        .expect("set_prop succeeds");
    let s = scene.lock().expect("scene poisoned");
    assert_eq!(
        s.prop(attached_id(&text), "text"),
        Some(&PropValue::Str("hi".to_string()))
    );
    // The handle's prop mirror stays in sync (the materialization source).
    assert_eq!(
        text.inner
            .lock()
            .expect("node inner poisoned")
            .props
            .get("text"),
        Some(&PropValue::Str("hi".to_string()))
    );
}

#[test]
fn set_prop_style_key_merges_into_the_existing_style() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");

    text.set_props(HashMap::from([(
        "fg".to_string(),
        serde_json::json!("#ff0000"),
    )]))
    .expect("set_props succeeds");
    text.set_prop("bold".to_string(), serde_json::json!(true))
        .expect("set_prop succeeds");

    let s = scene.lock().expect("scene poisoned");
    let node = s.node(attached_id(&text)).expect("node in scene");
    assert_eq!(
        node.style.fg,
        _Color::Rgb(255, 0, 0),
        "fg survives the merge"
    );
    assert!(node.style.modifiers.contains(Modifiers::BOLD));
}

#[test]
fn set_prop_false_modifier_clears_the_modifier_like_the_full_path() {
    // The full-map path rebuilds the style from the given keys, so
    // `bold: false` yields a style without bold; the single-key path must
    // produce the same result by clearing the modifier.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");

    text.set_props(HashMap::from([
        ("fg".to_string(), serde_json::json!("#ff0000")),
        ("bold".to_string(), serde_json::json!(true)),
    ]))
    .expect("set_props succeeds");
    text.set_prop("bold".to_string(), serde_json::json!(false))
        .expect("set_prop succeeds");

    let s = scene.lock().expect("scene poisoned");
    let node = s.node(attached_id(&text)).expect("node in scene");
    assert!(
        !node.style.modifiers.contains(Modifiers::BOLD),
        "bold must be cleared"
    );
    assert_eq!(node.style.fg, _Color::Rgb(255, 0, 0), "fg stays untouched");
}

#[test]
fn equal_value_set_prop_and_set_props_do_not_bump_the_epoch() {
    // The incremental-sync contract at the binding layer: an equal-value
    // single-key or whole-map write leaves the scene epoch untouched, so
    // the renderer's no-op fast path still applies.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");
    text.set_props(HashMap::from([
        ("text".to_string(), serde_json::json!("hi")),
        ("fg".to_string(), serde_json::json!("#ff0000")),
    ]))
    .expect("initial set_props succeeds");
    let epoch = scene.lock().expect("scene poisoned").epoch();

    text.set_prop("text".to_string(), serde_json::json!("hi"))
        .expect("equal set_prop succeeds");
    text.set_prop("fg".to_string(), serde_json::json!("#ff0000"))
        .expect("equal style set_prop succeeds");
    text.set_props(HashMap::from([
        ("text".to_string(), serde_json::json!("hi")),
        ("fg".to_string(), serde_json::json!("#ff0000")),
    ]))
    .expect("equal set_props succeeds");

    assert_eq!(
        scene.lock().expect("scene poisoned").epoch(),
        epoch,
        "equal-value writes must not bump the scene epoch"
    );

    // A changed value does bump.
    text.set_prop("text".to_string(), serde_json::json!("bye"))
        .expect("changed set_prop succeeds");
    assert_eq!(
        scene.lock().expect("scene poisoned").epoch(),
        epoch + 1,
        "a changed set_prop must bump the scene epoch"
    );
}

#[test]
fn set_prop_on_a_detached_template_materializes_with_the_change() {
    // `set_prop` on a detached `create_node` template records the change
    // on the handle; `add_child` materializes it into the scene.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let child = create_node("text".to_string(), None).expect("create text template");
    child
        .set_prop("text".to_string(), serde_json::json!("hi"))
        .expect("set_prop on detached succeeds");
    child
        .set_prop("bold".to_string(), serde_json::json!(true))
        .expect("style set_prop on detached succeeds");

    let bound = root.add_child(&child).expect("add child");
    let s = scene.lock().expect("scene poisoned");
    assert_eq!(
        s.prop(attached_id(&bound), "text"),
        Some(&PropValue::Str("hi".to_string()))
    );
    assert!(
        s.node(attached_id(&bound))
            .expect("node in scene")
            .style
            .modifiers
            .contains(Modifiers::BOLD),
        "the detached style-key write must materialize"
    );
}

#[test]
fn set_prop_drops_non_scalar_values_like_the_full_path() {
    // The full-map path silently drops null/array/object values; the
    // single-key path must too, without touching the scene.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");
    let epoch = scene.lock().expect("scene poisoned").epoch();

    text.set_prop("nested".to_string(), serde_json::json!({"a": 1}))
        .expect("set_prop with an object value succeeds");
    text.set_prop("missing".to_string(), serde_json::Value::Null)
        .expect("set_prop with null succeeds");

    assert_eq!(
        scene.lock().expect("scene poisoned").epoch(),
        epoch,
        "dropped values must not bump the scene epoch"
    );
    let s = scene.lock().expect("scene poisoned");
    assert!(s.prop(attached_id(&text), "nested").is_none());
    assert!(s.prop(attached_id(&text), "missing").is_none());
}

#[test]
fn append_span_lands_span_in_scene_stream() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let id = {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.add_child(root, NodeKind::StreamingText, Style::new())
            .expect("add streaming node")
    };
    let node = NodeHandle::materialized(
        scene.clone(),
        id,
        NodeKind::StreamingText,
        Style::new(),
        PropMap::new(),
    );
    let style = HashMap::from([
        ("fg".to_string(), serde_json::json!("#ff0000")),
        ("bold".to_string(), serde_json::json!(true)),
        // A non-style key is ignored by the style-lifting convention.
        ("padding".to_string(), serde_json::json!(2)),
    ]);
    node.append_span("hello".to_string(), Some(style))
        .expect("append_span succeeds");
    let s = scene.lock().expect("scene poisoned");
    let stream = s.stream(id).expect("stream exists");
    assert_eq!(stream.len(), 1);
    assert_eq!(stream[0].text, "hello");
    assert_eq!(stream[0].style.fg, _Color::Rgb(255, 0, 0));
    assert!(stream[0].style.modifiers.contains(Modifiers::BOLD));
}

#[test]
fn append_span_accumulates_spans_in_call_order() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let id = {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.add_child(root, NodeKind::StreamingText, Style::new())
            .expect("add streaming node")
    };
    let node = NodeHandle::materialized(
        scene.clone(),
        id,
        NodeKind::StreamingText,
        Style::new(),
        PropMap::new(),
    );
    node.append_span("a".to_string(), None).expect("first span");
    node.append_span("b".to_string(), None)
        .expect("second span");
    let s = scene.lock().expect("scene poisoned");
    let texts: Vec<&str> = s
        .stream(id)
        .expect("stream exists")
        .iter()
        .map(|sp| sp.text.as_str())
        .collect();
    assert_eq!(texts, vec!["a", "b"]);
}

#[test]
fn append_span_errors_when_node_is_detached() {
    let node = create_node("streaming_text".to_string(), None).expect("create streaming node");
    let err = node
        .append_span("hi".to_string(), None)
        .expect_err("detached node must error");
    assert!(err.to_string().contains("not attached"), "{err}");
}

#[test]
fn append_span_errors_on_non_streaming_node() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let id = {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.add_child(root, NodeKind::Text, Style::new())
            .expect("add text node")
    };
    let node = NodeHandle::materialized(
        scene.clone(),
        id,
        NodeKind::Text,
        Style::new(),
        PropMap::new(),
    );
    let err = node
        .append_span("hi".to_string(), None)
        .expect_err("non-streaming node must error");
    assert!(err.to_string().contains("streaming_text"), "{err}");
}

#[test]
fn insert_before_lands_at_anchor_index() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    let a = root.add_child(&text_template()).expect("add a");
    let b = root.add_child(&text_template()).expect("add b");
    let c = root.add_child(&text_template()).expect("add c");
    assert_eq!(
        child_ids(&scene, &root),
        vec![attached_id(&a), attached_id(&b), attached_id(&c)]
    );

    // Before the first child.
    let x = root
        .insert_before(&text_template(), &a)
        .expect("insert before first");
    assert_eq!(
        child_ids(&scene, &root),
        vec![
            attached_id(&x),
            attached_id(&a),
            attached_id(&b),
            attached_id(&c)
        ]
    );

    // Before the middle child.
    let y = root
        .insert_before(&text_template(), &b)
        .expect("insert before middle");
    assert_eq!(
        child_ids(&scene, &root),
        vec![
            attached_id(&x),
            attached_id(&a),
            attached_id(&y),
            attached_id(&b),
            attached_id(&c)
        ]
    );

    // Before the last child (c sits at index 4 of [x, a, y, b, c]).
    let z = root
        .insert_before(&text_template(), &c)
        .expect("insert before last");
    assert_eq!(
        child_ids(&scene, &root),
        vec![
            attached_id(&x),
            attached_id(&a),
            attached_id(&y),
            attached_id(&b),
            attached_id(&z),
            attached_id(&c),
        ]
    );

    // Every inserted node is a child of `root` in scene order.
    let s = scene.lock().expect("scene poisoned");
    for handle in [&x, &a, &y, &z, &b, &c] {
        let n = s.node(attached_id(handle)).expect("node in scene");
        assert_eq!(n.parent, Some(root_id));
    }
}

#[test]
fn insert_before_binds_child_like_add_child() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    let anchor = root.add_child(&text_template()).expect("add anchor");
    let child = create_node(
        "box".to_string(),
        Some(HashMap::from([(
            "text".to_string(),
            serde_json::json!("hi"),
        )])),
    )
    .expect("create child with props");
    let bound = root.insert_before(&child, &anchor).expect("insert before");

    // The returned handle shares the child's inner state and is attached.
    assert!(Arc::ptr_eq(&child.inner, &bound.inner));
    assert_ne!(attached_id(&bound), attached_id(&anchor));
    // Scoped so the scene guard is dropped before `bound` is used as a
    // parent below (a MutexGuard is not released by NLL early).
    {
        let s = scene.lock().expect("scene poisoned");
        assert_eq!(
            s.prop(attached_id(&bound), "text"),
            Some(&PropValue::Str("hi".to_string()))
        );
    }

    // The bound handle can itself be a parent.
    let grandchild = bound.add_child(&text_template()).expect("add grandchild");
    {
        let s = scene.lock().expect("scene poisoned");
        assert_eq!(
            s.node(attached_id(&grandchild)).unwrap().parent,
            Some(attached_id(&bound))
        );
        assert_eq!(
            s.children(attached_id(&bound)).unwrap(),
            &[attached_id(&grandchild)]
        );
    }
}

#[test]
fn insert_before_rejects_child_with_parent() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    let a = root.add_child(&text_template()).expect("add a");
    let b = root.add_child(&text_template()).expect("add b");

    let err = match root.insert_before(&a, &b) {
        Ok(_) => panic!("attached child must error"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("already has a parent"), "{err}");
    // Nothing was inserted.
    assert_eq!(
        child_ids(&scene, &root),
        vec![attached_id(&a), attached_id(&b)]
    );
}

#[test]
fn insert_before_rejects_detached_anchor() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    let a = root.add_child(&text_template()).expect("add a");
    let detached = text_template();

    let err = match root.insert_before(&text_template(), &detached) {
        Ok(_) => panic!("detached anchor must error"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("anchor"), "{err}");
    assert_eq!(child_ids(&scene, &root), vec![attached_id(&a)]);
}

#[test]
fn insert_before_rejects_foreign_anchor() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    // `parent` is a box under root; the anchor is attached under root as
    // a sibling of `parent`, so it is not one of `parent`'s children.
    let parent = root
        .add_child(&create_node("box".to_string(), None).expect("create box"))
        .expect("add box");
    let _a = parent.add_child(&text_template()).expect("add a");
    let foreign = root.add_child(&text_template()).expect("add foreign");

    let err = match parent.insert_before(&text_template(), &foreign) {
        Ok(_) => panic!("foreign anchor must error"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("not a child of this node"),
        "{err}"
    );
    // The foreign sibling's sibling order is untouched.
    assert_eq!(
        child_ids(&scene, &root),
        vec![attached_id(&parent), attached_id(&foreign)]
    );
}

#[test]
fn insert_before_rejects_detached_parent() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root_id = scene.lock().expect("scene poisoned").root_id();
    let root = NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    );

    let a = root.add_child(&text_template()).expect("add a");
    let detached = create_node("box".to_string(), None).expect("create detached parent");

    let err = match detached.insert_before(&text_template(), &a) {
        Ok(_) => panic!("detached parent must error"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("not attached"), "{err}");
    assert_eq!(child_ids(&scene, &root), vec![attached_id(&a)]);
}
