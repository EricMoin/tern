use super::*;

/// A checkbox semantics node with the given label and a checked+focused
/// state — the canonical write shape used across the semantics tests.
fn checkbox_js(label: &str) -> SemanticsNodeJs {
    SemanticsNodeJs {
        role: "checkbox".to_string(),
        label: Some(label.to_string()),
        state: vec!["checked".to_string(), "focused".to_string()],
        enabled: true,
        selected: false,
    }
}

/// A textbox semantics node with the given label and no state flags.
fn textbox_js(label: &str) -> SemanticsNodeJs {
    SemanticsNodeJs {
        role: "textbox".to_string(),
        label: Some(label.to_string()),
        state: Vec::new(),
        enabled: true,
        selected: false,
    }
}

#[test]
fn set_semantics_roundtrips_through_the_flat_dump() {
    // The M4.1 read-API contract: semantics set through NodeHandle lands in
    // the store and `TuiRenderer::semantics` dumps it back flat — one entry
    // per populated node, in scene pre-order, ids mirroring the scene tree,
    // parents linking the tree, state flags sorted.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let box1 = root
        .add_child(&create_node("box".to_string(), None).expect("create box"))
        .expect("add box1");
    let text = box1.add_child(&text_template()).expect("add text");
    let box2 = root
        .add_child(&create_node("box".to_string(), None).expect("create box"))
        .expect("add box2");
    // A node with NO semantics entry: the dump must omit it entirely.
    let _plain = root
        .add_child(&text_template())
        .expect("add semantics-less text");
    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
    }

    box1.set_semantics(checkbox_js("mute")).expect("set box1 semantics");
    text.set_semantics(textbox_js("search")).expect("set text semantics");
    box2.set_semantics(SemanticsNodeJs {
        role: "menuitem".to_string(),
        label: Some("copy".to_string()),
        state: vec!["focused".to_string()],
        enabled: true,
        selected: true,
    })
    .expect("set box2 semantics");

    let renderer = renderer_with_scene(CountingBackend::default(), scene.clone());
    let dump = renderer.semantics().expect("flat dump succeeds");
    assert_eq!(dump.len(), 3, "one entry per populated node, pre-order");
    assert_eq!(dump[0].id, attached_id(&box1).0);
    assert_eq!(dump[0].parent, Some(attached_id(&root).0));
    assert_eq!(dump[0].role, "checkbox");
    assert_eq!(dump[0].label.as_deref(), Some("mute"));
    assert_eq!(dump[0].state, vec!["checked", "focused"], "state sorted");
    assert!(dump[0].enabled);
    assert!(!dump[0].selected);
    assert_eq!(dump[1].id, attached_id(&text).0);
    assert_eq!(dump[1].parent, Some(attached_id(&box1).0));
    assert_eq!(dump[1].role, "textbox");
    assert_eq!(dump[1].label.as_deref(), Some("search"));
    assert!(dump[1].state.is_empty());
    assert_eq!(dump[2].id, attached_id(&box2).0);
    assert_eq!(dump[2].role, "menuitem");
    assert_eq!(dump[2].label.as_deref(), Some("copy"));
    assert_eq!(dump[2].state, vec!["focused"]);
    assert!(dump[2].enabled);
    assert!(dump[2].selected, "selected round-trips");
}

#[test]
fn semantics_dump_includes_the_root_with_null_parent_when_it_has_semantics() {
    // The scene root can carry semantics too; its entry links no parent
    // (the root has none in the scene tree).
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
    }
    root.set_semantics(checkbox_js("app")).expect("set root semantics");

    let renderer = renderer_with_scene(CountingBackend::default(), scene.clone());
    let dump = renderer.semantics().expect("flat dump succeeds");
    assert_eq!(dump.len(), 1);
    assert_eq!(dump[0].id, attached_id(&root).0);
    assert_eq!(dump[0].parent, None, "the root entry has no parent");
    assert_eq!(dump[0].role, "checkbox");
    assert_eq!(dump[0].label.as_deref(), Some("app"));
}

#[test]
fn set_semantics_errors_when_node_is_detached() {
    // Mirroring `append_span`: a detached `create_node` template has no
    // scene id, so the write errors before touching the store.
    let node = create_node("box".to_string(), None).expect("create template");
    let err = node
        .set_semantics(checkbox_js("mute"))
        .expect_err("detached node must error");
    assert!(err.to_string().contains("not attached"), "{err}");
}

#[test]
fn set_semantics_errors_when_the_store_is_disabled() {
    // The store is default-off (the M4.1 gate): a write while disabled must
    // error instead of silently dropping the a11y metadata.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");
    let err = text
        .set_semantics(textbox_js("search"))
        .expect_err("disabled store must error");
    assert!(err.to_string().contains("disabled"), "{err}");
    assert_eq!(
        scene.lock().expect("scene poisoned").semantics_iter().count(),
        0,
        "nothing landed in the store"
    );
}

#[test]
fn set_semantics_rejects_unknown_role_and_state() {
    // Unknown role / state strings error instead of being silently dropped:
    // a typo must surface, not produce wrong a11y metadata.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let text = root.add_child(&text_template()).expect("add text");
    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
    }

    let err = text
        .set_semantics(SemanticsNodeJs {
            role: "toggle".to_string(),
            ..checkbox_js("mute")
        })
        .expect_err("unknown role must error");
    assert!(err.to_string().contains("role"), "{err}");

    let err = text
        .set_semantics(SemanticsNodeJs {
            state: vec!["hovered".to_string()],
            ..checkbox_js("mute")
        })
        .expect_err("unknown state must error");
    assert!(err.to_string().contains("state"), "{err}");

    assert_eq!(
        scene.lock().expect("scene poisoned").semantics_iter().count(),
        0,
        "rejected writes must not land"
    );
}

#[test]
fn clear_semantics_removes_the_entry_and_errors_when_detached() {
    let scene = Arc::new(Mutex::new(Scene::new()));
    let root = root_handle(&scene);
    let a = root.add_child(&text_template()).expect("add a");
    let b = root.add_child(&text_template()).expect("add b");
    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
    }
    a.set_semantics(textbox_js("one")).expect("set a");
    b.set_semantics(textbox_js("two")).expect("set b");

    let renderer = renderer_with_scene(CountingBackend::default(), scene.clone());
    assert_eq!(renderer.semantics().expect("dump").len(), 2);

    // Clearing one entry removes it from the dump; clearing a node with no
    // entry is a no-op (no error).
    a.clear_semantics().expect("clear a");
    a.clear_semantics().expect("clearing again is a no-op");
    let dump = renderer.semantics().expect("dump after clear");
    assert_eq!(dump.len(), 1);
    assert_eq!(dump[0].id, attached_id(&b).0);

    // A detached template has no scene id, mirroring `append_span`.
    let detached = create_node("box".to_string(), None).expect("create template");
    let err = detached
        .clear_semantics()
        .expect_err("detached clear must error");
    assert!(err.to_string().contains("not attached"), "{err}");
}

#[test]
fn semantics_writes_never_change_painted_snapshot_rows() {
    // The M4.1 contract: semantics is pure bookkeeping, so a write must not
    // alter what `render_to_buffer` paints — the rows stay byte-identical.
    let scene = scene_with_text("hello", 5, 1);
    let renderer = renderer_with_scene(CountingBackend::default(), scene.clone());
    let before = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot before");
    assert_eq!(before, vec!["hello".to_string()]);

    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
        let root = s.root_id();
        let text_id = s.children(root).expect("root children")[0];
        assert!(s.set_semantics(text_id, SemanticsNode::new(SemanticsRole::Textbox)));
    }
    let after = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot after");
    assert_eq!(after, before, "a semantics write must not change painted rows");
}

#[test]
fn set_a11y_annotations_never_changes_painted_snapshot_rows() {
    // The M4.2 contract, mirroring the M4.1 paint-invariance proof: an
    // a11y-annotation write is a pure terminal-side OSC emission, so it
    // must not alter what `render_to_buffer` paints — the rows stay
    // byte-identical before and after.
    let scene = scene_with_text("hello", 5, 1);
    let renderer = renderer_with_scene(CountingBackend::default(), scene.clone());
    let before = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot before");
    assert_eq!(before, vec!["hello".to_string()]);

    renderer
        .set_a11y_annotations(vec![A11yAnnotationJs {
            role: "textbox".to_string(),
            label: Some("Search".to_string()),
            state: Vec::new(),
        }])
        .expect("a11y annotation write succeeds");
    let after = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot after");
    assert_eq!(
        after, before,
        "an a11y-annotation write must not change painted rows"
    );
}

#[test]
fn set_a11y_annotations_forwards_role_label_state_summaries() {
    // The renderer forwards each entry as one core `A11yAnnotation` whose
    // summary is `[role][: label][, state...]`, in entry order, with the
    // state order kept as given — the byte-level OSC emission is covered
    // by tern-terminal's `flush_a11y_annotations_to` tests, this mock
    // proves the renderer builds the summaries.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let scene = scene_with_text("hello", 5, 1);
    let renderer = renderer_with_scene(backend, scene.clone());
    renderer
        .set_a11y_annotations(vec![
            A11yAnnotationJs {
                role: "button".to_string(),
                label: None,
                state: Vec::new(),
            },
            A11yAnnotationJs {
                role: "textbox".to_string(),
                label: Some("Search".to_string()),
                state: vec!["focused".to_string()],
            },
            A11yAnnotationJs {
                role: "checkbox".to_string(),
                label: Some("mute".to_string()),
                state: vec!["checked".to_string(), "focused".to_string()],
            },
        ])
        .expect("a11y annotations forward");
    let recorded = probe.a11y_annotations().expect("entries recorded");
    let summaries: Vec<String> = recorded
        .iter()
        .map(|annotation| annotation.summary().to_string())
        .collect();
    assert_eq!(
        summaries,
        vec![
            "button".to_string(),
            "textbox: Search, focused".to_string(),
            "checkbox: mute, checked, focused".to_string(),
        ],
        "summaries follow the role/label/state shape in entry order"
    );
}

#[test]
fn semantics_write_repaint_produces_an_empty_diff() {
    // A semantics write bumps the scene epoch (forcing a repaint) but the
    // painted frame is identical, so the repaint flushes zero cell updates —
    // the renderer-level proof that semantics never alters render output.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let scene = scene_with_text("hello", 5, 1);
    let renderer = renderer_with_scene(backend, scene.clone());

    renderer.render().expect("first render paints");
    assert!(
        probe
            .last_flush_updates()
            .is_some_and(|updates| !updates.is_empty()),
        "the first paint flushes the text cells"
    );

    {
        let mut s = scene.lock().expect("scene poisoned");
        s.set_semantics_enabled(true);
        let root = s.root_id();
        let text_id = s.children(root).expect("root children")[0];
        assert!(s.set_semantics(text_id, SemanticsNode::new(SemanticsRole::Textbox)));
    }
    renderer.render().expect("render after semantics write");
    assert_eq!(
        probe.last_flush_updates(),
        Some(vec![]),
        "a semantics write repaints the same frame — zero cell updates"
    );
}

#[test]
fn semantics_errors_on_a_destroyed_renderer() {
    let (renderer, _scene) = counting_renderer(CountingBackend::default());
    renderer.destroy().expect("destroy succeeds");
    let err = renderer
        .semantics()
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[test]
fn semantics_constructor_option_enables_the_store() {
    // The `semantics: true` constructor option maps to
    // `Scene::set_semantics_enabled`: the store accepts `set_semantics`
    // writes and the dump surfaces them. The scene is module-global (see
    // the crate docs), so the test restores the default-off flag and
    // removes its node afterwards to keep the shared state clean for the
    // parallel tests.
    shared_scene()
        .lock()
        .expect("scene poisoned")
        .set_semantics_enabled(false);
    let renderer = TuiRenderer::new(TuiRendererOptions {
        exit_on_ctrl_c: None,
        use_alt_screen: None,
        title: None,
        headless: Some(true),
        keyboard_enhancement: None,
        scroll_optimization: None,
        semantics: Some(true),
        a11y_annotations: None,
        width: None,
        height: None,
    })
    .expect("headless renderer with semantics constructs");

    let root = renderer.root();
    let child = root
        .add_child(&create_node("box".to_string(), None).expect("create box"))
        .expect("add child");
    child
        .set_semantics(checkbox_js("mute"))
        .expect("store is enabled: the write lands");
    let dump = renderer.semantics().expect("dump succeeds");
    assert!(
        dump.iter().any(|entry| entry.label.as_deref() == Some("mute")),
        "the constructor option enables the store: {dump:?}"
    );

    // Cleanup: the renderer, its node, and the shared store flag.
    child.remove().expect("remove child");
    renderer.destroy().expect("destroy succeeds");
    shared_scene()
        .lock()
        .expect("scene poisoned")
        .set_semantics_enabled(false);
}
