use super::*;

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
