    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tern_core::color::Color as _Color;

    #[test]
    fn key_name_str_maps_all_names() {
        assert_eq!(key_name_str(KeyName::Char), "char");
        assert_eq!(key_name_str(KeyName::Enter), "enter");
        assert_eq!(key_name_str(KeyName::Escape), "escape");
        assert_eq!(key_name_str(KeyName::Backspace), "backspace");
        assert_eq!(key_name_str(KeyName::Tab), "tab");
        assert_eq!(key_name_str(KeyName::BackTab), "backtab");
        assert_eq!(key_name_str(KeyName::Delete), "delete");
        assert_eq!(key_name_str(KeyName::Home), "home");
        assert_eq!(key_name_str(KeyName::End), "end");
        assert_eq!(key_name_str(KeyName::PageUp), "pageup");
        assert_eq!(key_name_str(KeyName::PageDown), "pagedown");
        assert_eq!(key_name_str(KeyName::Up), "up");
        assert_eq!(key_name_str(KeyName::Down), "down");
        assert_eq!(key_name_str(KeyName::Left), "left");
        assert_eq!(key_name_str(KeyName::Right), "right");
        assert_eq!(key_name_str(KeyName::F(12)), "f12");
        assert_eq!(key_name_str(KeyName::Null), "null");
        assert_eq!(key_name_str(KeyName::Unknown), "unknown");
    }

    #[test]
    fn key_event_carries_char_and_modifiers() {
        let key = TernKey::new(KeyName::Char, Some('q'), true, false, true);
        let ev = KeyEvent::from_tern(key);
        assert_eq!(ev.name, "char");
        assert_eq!(ev.char.as_deref(), Some("q"));
        assert!(ev.ctrl);
        assert!(!ev.alt);
        assert!(ev.shift);

        let enter = KeyEvent::from_tern(TernKey::new(KeyName::Enter, None, false, false, false));
        assert_eq!(enter.name, "enter");
        assert!(enter.char.is_none());
    }

    #[test]
    fn tern_event_js_resize_maps() {
        let ev = TernEventJs::from_tern(TernEvent::Resize { w: 120, h: 40 });
        assert_eq!(ev.r#type, "resize");
        assert_eq!(ev.width, Some(120));
        assert_eq!(ev.height, Some(40));
        assert!(ev.key.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn tern_event_js_focus_maps() {
        let gained = TernEventJs::from_tern(TernEvent::FocusGained);
        assert_eq!(gained.r#type, "focus");
        assert_eq!(gained.focus_gained, Some(true));
        assert!(gained.key.is_none());
        assert!(gained.width.is_none());
        assert!(gained.height.is_none());
        assert!(gained.mouse.is_none());
        assert!(gained.paste.is_none());

        let lost = TernEventJs::from_tern(TernEvent::FocusLost);
        assert_eq!(lost.r#type, "focus");
        assert_eq!(lost.focus_gained, Some(false));
    }

    #[test]
    fn tern_event_js_mouse_maps_with_modifiers() {
        let mouse = TernMouse {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 3,
            row: 4,
            ctrl: true,
            alt: false,
            shift: true,
        };
        let ev = TernEventJs::from_tern(TernEvent::Mouse(mouse));
        assert_eq!(ev.r#type, "mouse");
        let js = ev.mouse.expect("mouse payload present");
        assert_eq!(js.kind, "down_left");
        assert_eq!(js.column, 3);
        assert_eq!(js.row, 4);
        assert!(js.ctrl);
        assert!(!js.alt);
        assert!(js.shift);
        assert!(ev.key.is_none());
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn tern_event_js_paste_maps() {
        let ev = TernEventJs::from_tern(TernEvent::Paste("pasted".to_string()));
        assert_eq!(ev.r#type, "paste");
        assert_eq!(ev.paste.as_deref(), Some("pasted"));
        assert!(ev.key.is_none());
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
    }

    #[test]
    fn mouse_kind_encoding_is_lossless() {
        // Every tern mouse kind must map to a distinct, button-preserving
        // `kind` string.
        let encode = |kind: MouseEventKind| {
            MouseEventJs::from_tern(TernMouse {
                kind,
                column: 0,
                row: 0,
                ctrl: false,
                alt: false,
                shift: false,
            })
            .kind
        };
        assert_eq!(encode(MouseEventKind::Down(MouseButton::Left)), "down_left");
        assert_eq!(
            encode(MouseEventKind::Down(MouseButton::Right)),
            "down_right"
        );
        assert_eq!(
            encode(MouseEventKind::Down(MouseButton::Middle)),
            "down_middle"
        );
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Left)), "up_left");
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Right)), "up_right");
        assert_eq!(encode(MouseEventKind::Up(MouseButton::Middle)), "up_middle");
        assert_eq!(encode(MouseEventKind::Drag(MouseButton::Left)), "drag_left");
        assert_eq!(
            encode(MouseEventKind::Drag(MouseButton::Right)),
            "drag_right"
        );
        assert_eq!(
            encode(MouseEventKind::Drag(MouseButton::Middle)),
            "drag_middle"
        );
        assert_eq!(encode(MouseEventKind::Moved), "moved");
        assert_eq!(encode(MouseEventKind::ScrollUp), "scroll_up");
        assert_eq!(encode(MouseEventKind::ScrollDown), "scroll_down");
        assert_eq!(encode(MouseEventKind::ScrollLeft), "scroll_left");
        assert_eq!(encode(MouseEventKind::ScrollRight), "scroll_right");
    }

    #[test]
    fn tern_event_js_key_maps() {
        let key = TernKey::new(KeyName::Char, Some('q'), true, false, true);
        let ev = TernEventJs::from_tern(TernEvent::Key(key));
        assert_eq!(ev.r#type, "key");
        let js = ev.key.expect("key payload present");
        assert_eq!(js.name, "char");
        assert_eq!(js.char.as_deref(), Some("q"));
        assert!(js.ctrl);
        assert!(js.shift);
        assert!(ev.width.is_none());
        assert!(ev.height.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
        assert!(ev.paste.is_none());
    }

    #[test]
    fn parse_color_handles_hex_indexed_and_default() {
        assert_eq!(parse_color("#ff8000"), _Color::Rgb(255, 128, 0));
        assert_eq!(parse_color("indexed:5"), _Color::Indexed(5));
        assert_eq!(parse_color("default"), _Color::Default);
        assert_eq!(parse_color("garbage"), _Color::Default);
        assert_eq!(parse_color("#12"), _Color::Default); // too short
    }

    #[test]
    fn highlight_returns_styled_spans_for_rust() {
        // The full source is reconstructed by the span stream, with the token
        // styles surfaced as hex fg + modifiers (the JS span style keys).
        let spans = highlight(
            "rust".to_string(),
            "fn main() {\n    let x = 42; // hi\n}\n".to_string(),
        )
        .expect("rust highlight succeeds");
        let joined: String = spans.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, "fn main() {\n    let x = 42; // hi\n}\n");

        let keyword = spans.iter().find(|s| s.text == "fn").expect("fn span");
        assert_eq!(keyword.fg.as_deref(), Some("#c678dd"));
        assert!(!keyword.italic);
        let number = spans.iter().find(|s| s.text == "42").expect("42 span");
        assert_eq!(number.fg.as_deref(), Some("#d19a66"));
        let comment = spans
            .iter()
            .find(|s| s.text == "// hi")
            .expect("comment span");
        assert_eq!(comment.fg.as_deref(), Some("#7f848e"));
        assert!(comment.italic);
    }

    #[test]
    fn highlight_errors_on_unknown_language() {
        let err =
            highlight("ruby".to_string(), "x".to_string()).expect_err("unknown language errors");
        assert!(err.to_string().contains("unknown highlight language"));
    }

    #[test]
    fn parse_border_style_keywords() {
        assert_eq!(parse_border_style("plain"), BorderStyle::Plain);
        assert_eq!(parse_border_style("rounded"), BorderStyle::Rounded);
        assert_eq!(parse_border_style("double"), BorderStyle::Double);
        assert_eq!(parse_border_style("thick"), BorderStyle::Thick);
        assert_eq!(parse_border_style("nope"), BorderStyle::None);
    }

    #[test]
    fn props_split_into_style_and_prop_map() {
        let props = HashMap::from([
            ("text".to_string(), serde_json::json!("Hi")),
            ("padding".to_string(), serde_json::json!(1)),
            ("width".to_string(), serde_json::json!(10)),
            ("flex_direction".to_string(), serde_json::json!("column")),
            ("border_style".to_string(), serde_json::json!("rounded")),
            ("border_color".to_string(), serde_json::json!("#00ff00")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
            ("hidden".to_string(), serde_json::json!(true)),
            ("nested".to_string(), serde_json::json!({"a": 1})), // dropped
        ]);
        let (style, map) = props_to_style_map(props);
        assert_eq!(style.border_style, BorderStyle::Rounded);
        assert_eq!(style.border_color, _Color::Rgb(0, 255, 0));
        assert_eq!(style.fg, _Color::Rgb(255, 0, 0));
        assert!(style.modifiers.contains(Modifiers::BOLD));
        assert!(style.modifiers.contains(Modifiers::HIDDEN));
        assert!(!style.modifiers.contains(Modifiers::ITALIC));
        assert_eq!(map.get("text"), Some(&PropValue::Str("Hi".to_string())));
        assert_eq!(map.get("padding"), Some(&PropValue::Int(1)));
        assert_eq!(map.get("width"), Some(&PropValue::Int(10)));
        assert_eq!(
            map.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        assert_eq!(map.len(), 4); // nested object dropped
    }

    #[test]
    fn json_prop_values_convert_scalars_only() {
        assert_eq!(
            json_to_prop_value(serde_json::json!("x")),
            Some(PropValue::Str("x".to_string()))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(7)),
            Some(PropValue::Int(7))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(1.5)),
            Some(PropValue::Float(1.5))
        );
        assert_eq!(
            json_to_prop_value(serde_json::json!(true)),
            Some(PropValue::Bool(true))
        );
        assert_eq!(json_to_prop_value(serde_json::json!(null)), None);
        assert_eq!(json_to_prop_value(serde_json::json!([1, 2])), None);
    }

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

    /// A root handle materialized over a fresh scene, for handle tests.
    fn root_handle(scene: &Arc<Mutex<Scene>>) -> NodeHandle {
        let root_id = scene.lock().expect("scene poisoned").root_id();
        NodeHandle::materialized(
            scene.clone(),
            root_id,
            NodeKind::Root,
            Style::new(),
            PropMap::new(),
        )
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
    fn render_to_buffer_paints_known_scene_into_expected_rows() {
        // The canonical golden scene (mirrored by the JS fake-addon golden
        // test): a rounded-border box with 1-cell padding around Text('Hi'),
        // attached to the scene root, painted at a 6x3 viewport. The box
        // sizes to its content (2 text columns + 2 padding = 4 wide, 1 + 2
        // padding = 3 tall) at the origin, so the frame is
        //   ┌──┐
        //   │Hi│
        //   └──┘
        // with trailing blanks padded to the 6-column viewport width.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Rounded),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(box_id, "Hi", Style::new())
            .expect("add text");

        let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(rows, vec!["┌──┐  ", "│Hi│  ", "└──┘  "]);
    }

    #[test]
    fn render_to_buffer_styled_snapshots_styled_scene_into_runs() {
        // The styled counterpart of the golden `render_to_buffer` scene: the
        // same rounded-border box, but the inner text is bold red. The frame
        // is still
        //   ┌──┐
        //   │Hi│
        //   └──┘
        // and the runs merge adjacent same-style cells: the border and the
        // trailing blanks share the default style, so row 0 and row 2 are
        // single runs, while row 1 splits into border / bold-red "Hi" /
        // border+blanks.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Rounded),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(
                box_id,
                "Hi",
                Style::new()
                    .fg(_Color::Rgb(255, 0, 0))
                    .add_modifier(Modifiers::BOLD),
            )
            .expect("add styled text");

        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(
            runs,
            vec![
                vec![plain_run("┌──┐  ")],
                vec![plain_run("│"), bold_red_run("Hi"), plain_run("│  ")],
                vec![plain_run("└──┘  ")],
            ]
        );
    }

    #[test]
    fn render_to_buffer_styled_border_color_paints_border_runs_in_color() {
        // A box with a `border_color` paints its border glyphs with that color
        // as their foreground, so the styled snapshot reports it through the
        // border runs' `fg`: the colored border splits from the default-styled
        // blanks into its own `fg: "#ff0000"` run per row, while the glyphs
        // and the inner text stay unchanged.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new()
                    .border_style(BorderStyle::Rounded)
                    .border_color(_Color::Rgb(255, 0, 0)),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(box_id, "Hi", Style::new())
            .expect("add text");

        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        assert_eq!(
            runs,
            vec![
                vec![red_border_run("┌──┐"), plain_run("  ")],
                vec![
                    red_border_run("│"),
                    plain_run("Hi"),
                    red_border_run("│"),
                    plain_run("  "),
                ],
                vec![red_border_run("└──┘"), plain_run("  ")],
            ]
        );
    }

    #[test]
    fn render_to_buffer_styled_text_reconstructs_plain_rows() {
        // The styled snapshot must never change the painted text:
        // concatenating each row's run texts reproduces the
        // `render_to_buffer` row string for the same scene, byte for byte —
        // the two snapshot flavors share one paint path.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let box_id = scene
            .add_child(
                root,
                NodeKind::Box,
                Style::new().border_style(BorderStyle::Rounded),
            )
            .expect("add box");
        scene.set_prop(box_id, "padding", PropValue::Int(1));
        scene
            .add_text(
                box_id,
                "Hi",
                Style::new()
                    .fg(_Color::Rgb(255, 0, 0))
                    .add_modifier(Modifiers::BOLD),
            )
            .expect("add styled text");

        let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
        let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
        let reconstructed: Vec<String> = runs
            .iter()
            .map(|row| row.iter().map(|run| run.text.as_str()).collect())
            .collect();
        assert_eq!(reconstructed, rows);
    }

    #[test]
    fn render_to_buffer_styled_masks_and_merges_wide_char_cells() {
        // A wide glyph's masked continuation cell maps to a space and merges
        // into the lead cell's run — the mask carries the lead's style — so a
        // styled コ followed by a default-styled `a` collapses into two runs:
        // "コ " bold-red, then "a " default. Concatenating the run texts
        // reconstructs the plain row.
        let mut buffer = Buffer::new(4, 1);
        buffer.set_string(
            0,
            0,
            "コ",
            Style::new()
                .fg(_Color::Rgb(255, 0, 0))
                .add_modifier(Modifiers::BOLD),
        );
        buffer.set_string(2, 0, "a", Style::new());
        assert_eq!(
            buffer_runs(&buffer),
            vec![vec![bold_red_run("コ "), plain_run("a ")]]
        );
    }

    #[test]
    fn render_to_buffer_styled_errors_when_destroyed() {
        // The napi method guards on the destroyed flag like `render_to_buffer`
        // and `render`, so a torn-down renderer cannot snapshot.
        let scene = Arc::new(Mutex::new(Scene::new()));
        let inner = RendererInner {
            backend: Box::new(Backend::new()),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
            keyboard_enhancement: false,
            destroyed: true,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        let renderer = TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        };
        let err = renderer
            .render_to_buffer_styled(None, None)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    /// A run carrying no style keys — `{ text }`.
    fn plain_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: None,
            bg: None,
            bold: None,
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
    }

    /// A run carrying `fg: "#ff0000"` and `bold` — the style keys the styled
    /// golden text uses.
    fn bold_red_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: Some("#ff0000".to_string()),
            bg: None,
            bold: Some(true),
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
    }

    /// A run carrying `fg: "#ff0000"` — the border color the styled border
    /// golden paints its border cells with.
    fn red_border_run(text: &str) -> StyleRunJs {
        StyleRunJs {
            text: text.to_string(),
            fg: Some("#ff0000".to_string()),
            bg: None,
            bold: None,
            dim: None,
            italic: None,
            underline: None,
            reversed: None,
            strikethrough: None,
        }
    }

    #[test]
    fn render_to_buffer_masks_wide_char_continuation_cells() {
        // A wide glyph occupies two columns: the lead cell carries the glyph
        // and the continuation cell is masked (NUL). `buffer_rows` maps the
        // mask to a space so the row string keeps the buffer's full display
        // width — the wide character is never dropped nor doubled.
        let mut buffer = Buffer::new(4, 1);
        buffer.set_string(0, 0, "コa", Style::new());
        assert_eq!(buffer_rows(&buffer), vec!["コ a "]);
    }

    #[test]
    fn render_to_buffer_zwj_family_emoji_is_single_2_column_glyph() {
        // A ZWJ family emoji is ONE grapheme cluster rendered as a single
        // 2-column glyph: the snapshot row reconstructs the full cluster
        // string in its lead cell, with the masked continuation cell as a
        // space — never the lead char alone, never a re-split sequence.
        let mut scene = Scene::new();
        let root = scene.root_id();
        scene
            .add_text(root, "👨‍👩‍👧‍👦", Style::new())
            .expect("add text");
        let rows = paint_scene_rows_with_selection(&scene, Size::new(4, 1), None);
        // Cells: [👨‍👩‍👧‍👦][mask→space][space][space].
        assert_eq!(rows, vec!["👨‍👩‍👧‍👦   "], "got: {rows:?}");
    }

    #[test]
    fn render_to_buffer_flag_is_single_2_column_glyph() {
        // A regional-indicator flag is ONE grapheme cluster rendered as a
        // single 2-column glyph in the snapshot row.
        let mut scene = Scene::new();
        let root = scene.root_id();
        scene.add_text(root, "🇷🇺", Style::new()).expect("add text");
        let rows = paint_scene_rows_with_selection(&scene, Size::new(3, 1), None);
        assert_eq!(rows, vec!["🇷🇺  "], "got: {rows:?}");
    }

    #[test]
    fn render_to_buffer_errors_when_destroyed() {
        // The napi method guards on the destroyed flag, so a torn-down
        // renderer cannot snapshot (mirrors `render`).
        let scene = Arc::new(Mutex::new(Scene::new()));
        let inner = RendererInner {
            backend: Box::new(Backend::new()),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
            keyboard_enhancement: false,
            destroyed: true,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        let renderer = TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        };
        let err = renderer
            .render_to_buffer(None, None)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
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

    /// The scene id of an attached handle.
    fn attached_id(handle: &NodeHandle) -> NodeId {
        handle
            .inner
            .lock()
            .expect("node inner poisoned")
            .id
            .expect("handle is attached")
    }

    /// The ordered scene ids of `parent`'s children.
    fn child_ids(scene: &Arc<Mutex<Scene>>, parent: &NodeHandle) -> Vec<NodeId> {
        let parent_id = attached_id(parent);
        let s = scene.lock().expect("scene poisoned");
        s.children(parent_id).expect("parent in scene").to_vec()
    }

    /// A detached `text` template for insertion tests.
    fn text_template() -> NodeHandle {
        create_node("text".to_string(), None).expect("create text template")
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

    /// A synthetic tern event of the given index, cycling the event kinds so
    /// every payload shape is exercised.
    fn synthetic_event(i: usize) -> TernEvent {
        match i % 5 {
            0 => TernEvent::Key(TernKey::new(KeyName::Char, Some('a'), false, false, false)),
            1 => TernEvent::Resize {
                w: 80,
                h: (i + 1) as u16,
            },
            2 => TernEvent::FocusGained,
            3 => TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Moved,
                column: (i % 100) as u16,
                row: 0,
                ctrl: false,
                alt: false,
                shift: false,
            }),
            _ => TernEvent::Paste(format!("pasted-{i}")),
        }
    }

    #[cfg(feature = "push-events")]
    #[test]
    fn push_event_batch_delivers_all_synthetic_events_without_loss() {
        // The push path's batch converter: N synthetic events in, N JS events
        // out, in order, each mapping to the right tagged union shape.
        let n = 40;
        let events: Vec<TernEvent> = (0..n).map(synthetic_event).collect();
        let mut delivered: Vec<TernEventJs> = Vec::new();
        let teardown = push_event_batch(&events, false, &mut |js| delivered.push(js));
        assert!(!teardown, "no ctrl+c in the batch");
        assert_eq!(delivered.len(), n, "all {n} events delivered, none lost");
        for (i, (event, js)) in events.iter().zip(&delivered).enumerate() {
            match event {
                TernEvent::Key(_key) => {
                    assert_eq!(js.r#type, "key", "event {i} tagged key");
                    let js_key = js.key.as_ref().expect("key payload present");
                    assert_eq!(js_key.name, "char");
                    assert_eq!(js_key.char.as_deref(), Some("a"));
                }
                TernEvent::Resize { w, h } => {
                    assert_eq!(js.r#type, "resize", "event {i} tagged resize");
                    assert_eq!(js.width, Some(*w));
                    assert_eq!(js.height, Some(*h));
                }
                TernEvent::FocusGained => {
                    assert_eq!(js.r#type, "focus", "event {i} tagged focus");
                    assert_eq!(js.focus_gained, Some(true));
                }
                TernEvent::FocusLost => unreachable!("synthetic events never focus-lost"),
                TernEvent::Mouse(_) => {
                    assert_eq!(js.r#type, "mouse", "event {i} tagged mouse");
                    assert_eq!(
                        js.mouse.as_ref().expect("mouse payload present").kind,
                        "moved"
                    );
                }
                TernEvent::Paste(text) => {
                    assert_eq!(js.r#type, "paste", "event {i} tagged paste");
                    assert_eq!(
                        js.paste.as_deref(),
                        Some(text.as_str()),
                        "event {i} payload"
                    );
                }
            }
        }
    }

    #[cfg(feature = "push-events")]
    #[test]
    fn push_event_batch_flags_ctrl_c_teardown_and_still_delivers() {
        // Ctrl+C with exit_on_ctrl_c: the batch reports a teardown (the caller
        // restores the terminal and stops the loop) and the press is still
        // delivered so push-mode consumers observe it.
        let events = vec![
            TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false)),
            TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), false, false, false)),
        ];
        let mut delivered: Vec<TernEventJs> = Vec::new();
        let teardown = push_event_batch(&events, true, &mut |js| delivered.push(js));
        assert!(teardown, "ctrl+c with exit_on_ctrl_c must request teardown");
        assert_eq!(delivered.len(), 2, "both events still delivered");
        assert_eq!(delivered[0].r#type, "key");
        assert_eq!(
            delivered[0].key.as_ref().expect("key").char.as_deref(),
            Some("c")
        );
    }

    #[test]
    fn is_ctrl_c_matches_ctrl_char_c_only() {
        let ctrl_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false));
        assert!(is_ctrl_c(&ctrl_c));
        // Not ctrl: a plain 'c'.
        let plain_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), false, false, false));
        assert!(!is_ctrl_c(&plain_c));
        // Ctrl but not 'c'.
        let ctrl_q = TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), true, false, false));
        assert!(!is_ctrl_c(&ctrl_q));
        // Non-key events are never ctrl+c.
        assert!(!is_ctrl_c(&TernEvent::Resize { w: 80, h: 24 }));
        assert!(!is_ctrl_c(&TernEvent::FocusGained));
    }

    /// A fresh headless renderer with default options (virtual 80x24),
    /// constructed through the real [`TuiRenderer::new`] path so the tests
    /// prove headless construction never touches a terminal.
    fn headless_renderer() -> TuiRenderer {
        TuiRenderer::new(TuiRendererOptions {
            exit_on_ctrl_c: None,
            use_alt_screen: None,
            title: None,
            headless: Some(true),
            keyboard_enhancement: None,
            width: None,
            height: None,
        })
        .expect("headless renderer constructs without a terminal")
    }

    #[test]
    fn headless_renderer_constructs_without_a_terminal() {
        // Construction with `headless: true` must not touch a real terminal
        // (no raw mode, no alternate screen, no event listening, no title):
        // it succeeds under plain `cargo test` with no TTY and reports the
        // default 80x24 virtual size.
        let renderer = headless_renderer();
        assert!(!renderer.destroyed());
        let size = renderer.size().expect("size works headlessly");
        assert_eq!((size.width, size.height), (80, 24), "got: {size:?}");
    }

    #[test]
    fn headless_renderer_renders_and_snapshots_without_a_terminal() {
        // `render`, `render_to_buffer`, and `render_to_buffer_styled` all
        // work against the in-memory backend: the frame paints at the
        // virtual size and both snapshot flavors return one row per
        // configured height cell, each row the configured width.
        let renderer = headless_renderer();
        renderer.render().expect("render works headlessly");
        let rows = renderer
            .render_to_buffer(None, None)
            .expect("plain snapshot works headlessly");
        assert_eq!(rows.len(), 24, "snapshot defaults to the virtual height");
        assert!(
            rows.iter().all(|row| row.len() == 80),
            "snapshot rows must be the virtual width"
        );
        let runs = renderer
            .render_to_buffer_styled(None, None)
            .expect("styled snapshot works headlessly");
        assert_eq!(
            runs.len(),
            24,
            "styled snapshot defaults to the virtual height"
        );
    }

    #[test]
    fn headless_renderer_destroy_skips_teardown_and_is_idempotent() {
        // `destroy` must not attempt terminal teardown (the in-memory
        // backend no-ops it anyway), must be safe to call twice, and must
        // leave the renderer unusable — exactly like a real renderer.
        let renderer = headless_renderer();
        renderer.destroy().expect("first destroy succeeds");
        renderer.destroy().expect("second destroy is a no-op");
        assert!(renderer.destroyed());
        let err = renderer
            .render()
            .expect_err("a destroyed headless renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .size()
            .expect_err("size must error on a destroyed renderer");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn headless_renderer_custom_size_is_reported_and_painted() {
        // A custom virtual size (120x30) drives the size getter and the
        // snapshot viewport with no TTY involved. The snapshot is painted at
        // an explicit size first (recording `last_painted_viewport` without
        // touching the shared scene viewport), then `size` reports the custom
        // viewport — the suite's shared-viewport default of 80x24 is never
        // mutated, keeping the parallel tests deterministic.
        let renderer = TuiRenderer::new(TuiRendererOptions {
            exit_on_ctrl_c: None,
            use_alt_screen: None,
            title: None,
            headless: Some(true),
            keyboard_enhancement: None,
            width: Some(120),
            height: Some(30),
        })
        .expect("headless renderer with a custom size constructs");
        let rows = renderer
            .render_to_buffer(Some(120), Some(30))
            .expect("custom-size snapshot works headlessly");
        assert_eq!(rows.len(), 30, "snapshot height matches the custom size");
        assert!(
            rows.iter().all(|row| row.len() == 120),
            "snapshot rows are the custom width"
        );
        let runs = renderer
            .render_to_buffer_styled(Some(120), Some(30))
            .expect("custom-size styled snapshot works headlessly");
        assert_eq!(
            runs.len(),
            30,
            "styled snapshot height matches the custom size"
        );
        let size = renderer.size().expect("size reports the custom viewport");
        assert_eq!((size.width, size.height), (120, 30), "got: {size:?}");
    }

    /// A backend that counts every terminal operation instead of performing
    /// it, so tests can assert exactly which renders touched the terminal.
    ///
    /// Counters are `Arc`-shared so the test keeps reading them after the
    /// backend is moved into the renderer. `size()` reports a fixed 80x24
    /// viewport, keeping the viewport cache stable across renders.
    /// `set_clipboard` captures the text it received into `clipboard` (the
    /// injected sink: the byte-level escape emission is covered by
    /// tern-terminal's `set_clipboard_to` tests, this mock proves the
    /// renderer forwards the text).
    #[derive(Clone, Default)]
    struct CountingBackend {
        size_calls: Arc<AtomicUsize>,
        flush_calls: Arc<AtomicUsize>,
        clipboard: Arc<Mutex<Option<String>>>,
    }

    impl CountingBackend {
        /// Total terminal operations so far (size probes + flushes).
        fn ops(&self) -> usize {
            self.size_calls.load(Ordering::Relaxed) + self.flush_calls.load(Ordering::Relaxed)
        }

        /// The text most recently passed to `set_clipboard`, or `None`.
        fn clipboard(&self) -> Option<String> {
            self.clipboard.lock().expect("clipboard poisoned").clone()
        }
    }

    impl RenderBackend for CountingBackend {
        fn size(&self) -> io::Result<(u16, u16)> {
            self.size_calls.fetch_add(1, Ordering::Relaxed);
            Ok((80, 24))
        }

        fn flush_diff(
            &mut self,
            updates: &[CellUpdate],
            _cursor_pos: (u16, u16),
        ) -> io::Result<usize> {
            self.flush_calls.fetch_add(1, Ordering::Relaxed);
            // Report a nominal byte count per flushed cell so the renderer's
            // `last_flush_bytes` counter is exercised; the tests only assert
            // on the call counters, never on this value.
            Ok(updates.len())
        }

        fn set_title(&self, _title: &str) -> io::Result<()> {
            Ok(())
        }

        fn set_clipboard(&self, text: &str) -> io::Result<()> {
            *self.clipboard.lock().expect("clipboard poisoned") = Some(text.to_string());
            Ok(())
        }

        fn disable_event_listening(&self) -> io::Result<()> {
            Ok(())
        }

        fn exit_keyboard_enhancement(&self) -> io::Result<()> {
            Ok(())
        }

        fn exit_alt_screen(&self) -> io::Result<()> {
            Ok(())
        }

        fn exit_raw_mode(&self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A renderer wired to a [`CountingBackend`] over a scene with one Text
    /// child, so the no-op fast path can be exercised end to end.
    fn counting_renderer(backend: CountingBackend) -> (TuiRenderer, Arc<Mutex<Scene>>) {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::Text, Style::new())
                .expect("add text node");
        }
        let renderer = renderer_with_scene(backend, scene.clone());
        (renderer, scene)
    }

    /// A renderer wired to `backend` over `scene` (the caller owns the
    /// scene's content).
    fn renderer_with_scene(backend: CountingBackend, scene: Arc<Mutex<Scene>>) -> TuiRenderer {
        let inner = RendererInner {
            backend: Box::new(backend),
            compositor: Compositor::new(),
            scene,
            last: None,
            last_painted_epoch: 0,
            last_viewport: NO_VIEWPORT,
            last_painted_viewport: NO_VIEWPORT,
            selection: None,
            last_painted_selection: None,
            cached_size: None,
            last_flush_bytes: 0,
            #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
            exit_on_ctrl_c: false,
            use_alt_screen: false,
            headless: false,
            keyboard_enhancement: false,
            destroyed: false,
            #[cfg(feature = "push-events")]
            event_loop: None,
        };
        TuiRenderer {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// A fresh scene holding one `Text` leaf sized `w` x `h` at the origin
    /// with `text` content, for selection tests.
    fn scene_with_text(text: &str, w: u32, h: u32) -> Arc<Mutex<Scene>> {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            let t = s
                .add_child(root, NodeKind::Text, Style::new())
                .expect("add text");
            s.set_prop(t, "text", PropValue::Str(text.into()));
            s.set_prop(t, "width", PropValue::Int(w as i64));
            s.set_prop(t, "height", PropValue::Int(h as i64));
        }
        scene
    }

    /// A fresh scene with two `Text` leaves stacked in a column at rows 0 and
    /// 1, for multi-row selection tests.
    fn two_row_scene() -> Arc<Mutex<Scene>> {
        let scene = Arc::new(Mutex::new(Scene::new()));
        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.set_prop(root, "flex_direction", PropValue::Str("column".into()));
            for text in ["hello", "world"] {
                let t = s
                    .add_child(root, NodeKind::Text, Style::new())
                    .expect("add text");
                s.set_prop(t, "text", PropValue::Str(text.into()));
                s.set_prop(t, "width", PropValue::Int(11));
                s.set_prop(t, "height", PropValue::Int(1));
            }
        }
        scene
    }

    #[test]
    fn unchanged_scene_renders_perform_zero_terminal_writes() {
        // Two consecutive renders with no intervening mutation: the first
        // paints (a size probe plus a flush), the second must hit the no-op
        // fast path and perform zero terminal writes — no size probe, no
        // paint, no diff, no flush.
        let backend = CountingBackend::default();
        let probe = backend.clone(); // keeps the counters after the move
        let (renderer, _scene) = counting_renderer(backend);

        renderer.render().expect("first render paints the scene");
        let after_first = probe.ops();
        assert!(after_first > 0, "first render must touch the backend");

        renderer.render().expect("second render succeeds");
        assert_eq!(
            probe.ops(),
            after_first,
            "an unchanged-scene render must perform zero terminal writes"
        );
    }

    #[test]
    fn mutated_scene_renders_repaint() {
        // A mutation between renders invalidates the scene cache: the next
        // render must repaint (paying for a flush again). The terminal size
        // is served from the size cache — a mutation does not invalidate it,
        // so no second `size()` probe happens.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, scene) = counting_renderer(backend);

        renderer.render().expect("first render paints the scene");
        let after_first = probe.ops();
        assert!(after_first > 0);

        {
            let mut s = scene.lock().expect("scene poisoned");
            let root = s.root_id();
            s.add_child(root, NodeKind::Box, Style::new())
                .expect("mutate the scene");
        }
        renderer.render().expect("render after mutation succeeds");
        assert!(
            probe.ops() > after_first,
            "a mutated scene must repaint (flush; the size probe is served from the cache)"
        );
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "a mutation repaint must not re-probe the terminal size"
        );
    }

    #[test]
    fn fresh_renderer_never_fast_paths_before_first_paint() {
        // The (0,0) viewport sentinel must force a first paint even when the
        // scene epoch already matches `last_painted_epoch` (0 == 0): a
        // renderer that never painted has nothing cached to skip to.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);

        renderer.render().expect("first render paints");
        assert!(
            probe.ops() > 0,
            "the first render must paint, not fast-path"
        );
    }

    #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
    #[test]
    fn size_cache_serves_n_unchanged_renders_with_one_probe_and_resize_invalidates() {
        // The high-frame-rate contract: N consecutive renders of an unchanged
        // scene must perform exactly one `backend.size()` call. The first
        // render probes and caches the terminal size; every later render
        // either hits the no-op fast path (zero calls) or repaints from the
        // cache — no per-frame ioctl.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);

        let n = 5;
        for _ in 0..n {
            renderer.render().expect("render succeeds");
        }
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "{n} unchanged renders must perform exactly one size() call"
        );

        // A delivered resize event invalidates the cache — this is exactly
        // what the event delivery callback does for every resize event — so
        // the next render must re-query the backend size instead of painting
        // at the stale viewport.
        let probed_before = probe.size_calls.load(Ordering::Relaxed);
        invalidate_size_on_resize(&renderer.inner, &TernEvent::Resize { w: 100, h: 30 });
        renderer.render().expect("render after resize succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "a delivered resize event must cause the next render to re-query size"
        );

        // The re-queried size is cached again: the render after that probes
        // nothing more.
        renderer.render().expect("render after re-probe succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "the re-queried size is cached again for subsequent renders"
        );

        // Only resize events invalidate: a focus event leaves the cache
        // intact, so the next render still probes nothing.
        invalidate_size_on_resize(&renderer.inner, &TernEvent::FocusGained);
        renderer
            .render()
            .expect("render after focus event succeeds");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            probed_before + 1,
            "a non-resize event must not invalidate the size cache"
        );
    }

    /// Run `f` with the shared viewport pinned to the render-path default
    /// (80x24), restoring it afterwards. `size`'s pre-paint seed writes the
    /// shared viewport (a static shared across parallel test threads); the
    /// probe always reports 80x24 here, so pinning it before and after keeps
    /// the render-path tests that read the shared viewport from ever
    /// observing a stale value.
    fn with_render_viewport<T>(f: impl FnOnce() -> T) -> T {
        *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
        let result = f();
        *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
        result
    }

    #[test]
    fn size_before_any_paint_probes_the_terminal_and_seeds_the_viewport() {
        // A fresh renderer has painted nothing, so `size` surfaces the
        // current terminal size: one probe through the cached-size machinery,
        // recorded as the viewport default (a fresh renderer never reports
        // the synthetic 80x24 fallback when the terminal is a different
        // size).
        with_render_viewport(|| {
            let backend = CountingBackend::default();
            let probe = backend.clone();
            let (renderer, _scene) = counting_renderer(backend);
            let size = renderer.size().expect("size before any paint succeeds");
            assert_eq!(size.width, 80, "reports the probed terminal width");
            assert_eq!(size.height, 24, "reports the probed terminal height");
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the first size access must probe exactly once"
            );
            // The probed size was cached: a second access probes nothing.
            let again = renderer.size().expect("second size succeeds");
            assert_eq!((again.width, again.height), (80, 24));
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the cached size must serve subsequent accesses"
            );
        });
    }

    #[test]
    fn size_reports_the_viewport_of_the_last_render() {
        // After a render, `size` reports the viewport that render painted at
        // (the terminal size it probed and cached) — no re-probe.
        with_render_viewport(|| {
            let backend = CountingBackend::default();
            let probe = backend.clone();
            let (renderer, _scene) = counting_renderer(backend);
            renderer.render().expect("render paints the scene");
            let size = renderer.size().expect("size after render succeeds");
            assert_eq!((size.width, size.height), (80, 24));
            assert_eq!(
                probe.size_calls.load(Ordering::Relaxed),
                1,
                "the render's own probe serves the size access"
            );
        });
    }

    #[test]
    fn size_reports_the_viewport_of_the_last_snapshot() {
        // `render_to_buffer` records its viewport as the renderer's last
        // painted viewport, so `size` reports what the most recent
        // snapshotFrame painted at — even before any real render.
        let backend = CountingBackend::default();
        let (renderer, _scene) = counting_renderer(backend);
        renderer
            .render_to_buffer(Some(6), Some(3))
            .expect("snapshot paints");
        let size = renderer.size().expect("size after snapshot succeeds");
        assert_eq!((size.width, size.height), (6, 3), "got: {size:?}");
        // A bare snapshot defaults to the shared scene viewport (80x24 here:
        // no real render has established it), and that paint becomes the last
        // painted viewport.
        renderer
            .render_to_buffer(None, None)
            .expect("defaulted snapshot succeeds");
        let again = renderer.size().expect("size tracks the defaulted paint");
        assert_eq!((again.width, again.height), (80, 24), "got: {again:?}");
    }

    #[test]
    fn size_errors_on_a_destroyed_renderer() {
        let (renderer, _scene) = counting_renderer(CountingBackend::default());
        renderer.destroy().expect("destroy succeeds");
        let err = renderer.size().expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn set_clipboard_forwards_text_to_the_injected_backend() {
        // The renderer forwards the clipboard text verbatim to the injected
        // backend sink; the byte-level OSC 52 emission (ESC ] 52 ; c ; <base64>
        // BEL) is asserted by tern-terminal's `set_clipboard_to` tests.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);
        renderer
            .set_clipboard("hello".to_string())
            .expect("set_clipboard succeeds");
        assert_eq!(
            probe.clipboard().as_deref(),
            Some("hello"),
            "the text must reach the backend verbatim"
        );

        // A destroyed renderer refuses.
        renderer.destroy().expect("destroy succeeds");
        let err = renderer
            .set_clipboard("nope".to_string())
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }

    #[test]
    fn selection_change_invalidates_the_render_fast_path() {
        // A selection edit must force the next render to repaint (the
        // terminal shows the previous frame's overlay); an unchanged
        // selection keeps the zero-write no-op fast path.
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let renderer = renderer_with_scene(backend, scene_with_text("hello", 5, 1));

        renderer.render().expect("first render paints");
        let after_first = probe.ops();
        assert!(after_first > 0);

        // Unchanged selection (None): no-op fast path, zero terminal writes.
        renderer.render().expect("unchanged render");
        assert_eq!(probe.ops(), after_first, "unchanged render must fast-path");

        // A selection edit invalidates the fast path: the next render
        // repaints (and reaches the flush).
        renderer.set_selection(1, 0, 3, 0).expect("set selection");
        renderer.render().expect("render after selection edit");
        assert!(
            probe.ops() > after_first,
            "a selection edit must force a repaint"
        );

        // The selection is now painted: an unchanged render fast-paths again.
        let after_selected = probe.ops();
        renderer.render().expect("render with unchanged selection");
        assert_eq!(probe.ops(), after_selected);

        // Clearing the selection invalidates the fast path once more.
        renderer.clear_selection().expect("clear selection");
        renderer.render().expect("render after clear");
        assert!(
            probe.ops() > after_selected,
            "a cleared selection must force a repaint"
        );
    }

    #[test]
    fn selection_text_extracts_the_selected_region_from_the_last_painted_frame() {
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello world", 11, 1),
        );
        renderer.render().expect("render paints the frame");

        renderer.set_selection(6, 0, 10, 0).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "world",
            "selection_text reads the last painted buffer"
        );

        // Reversed endpoints normalize identically.
        renderer.set_selection(10, 0, 6, 0).expect("set selection reversed");
        assert_eq!(renderer.selection_text().expect("selection text"), "world");

        // A selection spanning the trailing blank cells extracts the exact
        // cell content (trailing spaces preserved).
        renderer.set_selection(8, 0, 10, 0).expect("set selection tail");
        assert_eq!(renderer.selection_text().expect("selection text"), "rld");

        // Clearing the selection empties the extraction.
        renderer.clear_selection().expect("clear selection");
        assert_eq!(renderer.selection_text().expect("selection text"), "");
    }

    #[test]
    fn selection_text_joins_rows_with_newlines() {
        // A multi-row selection joins the rows with '\n'.
        let renderer = renderer_with_scene(CountingBackend::default(), two_row_scene());
        renderer.render().expect("render paints the frame");

        renderer.set_selection(0, 0, 4, 1).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "hello\nworld"
        );

        // A single-row window extracts only that row.
        renderer.set_selection(0, 1, 4, 1).expect("set selection row 1");
        assert_eq!(renderer.selection_text().expect("selection text"), "world");
    }

    #[test]
    fn selection_text_is_cluster_aware_across_wide_glyphs() {
        // A wide char's masked continuation cell contributes nothing: the
        // extraction yields the full cluster once.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("コa", 3, 1),
        );
        renderer.render().expect("render paints the frame");

        // コ at cols 0-1 (lead + mask), 'a' at col 2.
        renderer.set_selection(0, 0, 2, 0).expect("set selection");
        assert_eq!(renderer.selection_text().expect("selection text"), "コa");

        // A ZWJ family emoji stays one 2-column glyph in the extraction.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("👨‍👩‍👧‍👦x", 3, 1),
        );
        renderer.render().expect("render paints the frame");
        renderer.set_selection(0, 0, 2, 0).expect("set selection");
        assert_eq!(
            renderer.selection_text().expect("selection text"),
            "👨‍👩‍👧‍👦x"
        );
    }

    #[test]
    fn selection_text_is_empty_without_a_selection_or_paint() {
        // No paint yet: nothing to extract from.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello", 5, 1),
        );
        assert_eq!(renderer.selection_text().expect("selection text"), "");

        // Painted but no selection set.
        renderer.render().expect("render paints the frame");
        assert_eq!(renderer.selection_text().expect("selection text"), "");
    }

    #[test]
    fn selection_word_range_finds_words_and_rejects_whitespace() {
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("foo bar baz", 11, 1),
        );
        renderer.render().expect("render paints the frame");

        let word_at = |col: u32, row: u32| {
            renderer
                .selection_word_range(col, row)
                .expect("word range query")
        };

        // "foo" at cols 0-2, "bar" at 4-6, "baz" at 8-10.
        assert_eq!(word_at(1, 0).unwrap().col1, 0);
        assert_eq!(word_at(1, 0).unwrap().col2, 2);
        assert_eq!(word_at(5, 0).unwrap().col1, 4);
        assert_eq!(word_at(5, 0).unwrap().col2, 6);
        assert_eq!(word_at(10, 0).unwrap().col1, 8);
        assert_eq!(word_at(10, 0).unwrap().col2, 10);

        // Whitespace and out-of-bounds cells start no word.
        assert!(word_at(3, 0).is_none(), "a space starts no word");
        assert!(word_at(7, 0).is_none(), "a space starts no word");
        assert!(word_at(0, 5).is_none(), "a row outside the buffer starts no word");
        assert!(word_at(20, 0).is_none(), "a column outside the buffer starts no word");
        assert!(word_at(11, 0).is_none(), "the right edge starts no word");
    }

    #[test]
    fn selection_word_range_is_cluster_aware_across_wide_glyphs() {
        // "コab": コ at cols 0-1 (lead + masked continuation), 'a' at 2, 'b'
        // at 3. Clicking the mask column still resolves the word containing
        // the whole glyph.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("コab", 4, 1),
        );
        renderer.render().expect("render paints the frame");

        let word_at = |col: u32| {
            renderer
                .selection_word_range(col, 0)
                .expect("word range query")
        };

        // The run is the whole non-whitespace line: 0..=3.
        let r = word_at(0).expect("lead cell");
        assert_eq!((r.col1, r.col2), (0, 3));
        let r = word_at(1).expect("mask cell");
        assert_eq!((r.col1, r.col2), (0, 3), "the mask is part of the glyph's run");
        let r = word_at(2).expect("a cell");
        assert_eq!((r.col1, r.col2), (0, 3));
    }

    #[test]
    fn render_to_buffer_snapshot_applies_the_selection_overlay_without_corrupting_text() {
        // The snapshot paints through the renderer's selection: the overlay
        // is style-only, so the returned rows are byte-identical with and
        // without a selection — the snapshot is where a styled consumer would
        // observe the reversed cells, and the text must never be corrupted.
        let renderer = renderer_with_scene(
            CountingBackend::default(),
            scene_with_text("hello", 5, 1),
        );
        let plain = renderer
            .render_to_buffer(Some(5), Some(1))
            .expect("snapshot without selection");
        assert_eq!(plain, vec!["hello"]);

        renderer.set_selection(1, 0, 3, 0).expect("set selection");
        let selected = renderer
            .render_to_buffer(Some(5), Some(1))
            .expect("snapshot with selection");
        assert_eq!(selected, plain, "the overlay must not change the text");

        // The snapshot's viewport still tracks (per-renderer state).
        let size = renderer.size().expect("size");
        assert_eq!((size.width, size.height), (5, 1));
    }

    #[test]
    fn selection_api_guards_on_a_destroyed_renderer() {
        let (renderer, _scene) = counting_renderer(CountingBackend::default());
        renderer.destroy().expect("destroy succeeds");
        let err = renderer
            .set_selection(0, 0, 1, 1)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .clear_selection()
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .selection_text()
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
        let err = renderer
            .selection_word_range(0, 0)
            .expect_err("destroyed renderer must error");
        assert!(err.to_string().contains("destroyed"), "{err}");
    }
