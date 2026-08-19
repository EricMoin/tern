//! The JSON-prop protocol: how JS props objects map onto a tern style + prop
//! map. This is a faithful port of the identical helpers in the napi binding
//! (`src/bindings/tern-node/src/lib.rs`, `props_to_style_map` et al.) so the
//! wasm shim and the Node/Deno host accept the exact same props.

use serde_json::Value;

use tern_core::color::Color;
use tern_core::scene::{PropMap, PropValue};
use tern_core::style::{BorderStyle, Modifiers, Style};

/// Split a JS props object into a tern style (style keys) and a tern property
/// map (everything else). The style is built from scratch over the recognized
/// style keys — a full-map replacement (see [`apply_style_key`] for the
/// single-key merge variant).
pub fn props_to_style_map(props: serde_json::Map<String, Value>) -> (Style, PropMap) {
    let mut style = Style::new();
    let mut map = PropMap::new();
    for (key, value) in props {
        match apply_style_key(style.clone(), &key, &value) {
            Some(updated) => style = updated,
            None => {
                let Some(pv) = json_to_prop_value(value) else {
                    continue;
                };
                map.insert(key, pv);
            }
        }
    }
    (style, map)
}

/// Apply a single style key to `style` (merge semantics), mirroring
/// `props_to_style_map`'s per-key handling. Returns `Some` when `key` is a
/// recognized style key, `None` when it is a regular prop key.
pub fn apply_style_key(mut style: Style, key: &str, value: &Value) -> Option<Style> {
    match key {
        "border_style" => {
            if let Value::String(s) = value {
                style = style.border_style(parse_border_style(s));
            }
        }
        "border_color" => {
            if let Value::String(s) = value {
                style = style.border_color(parse_color(s));
            }
        }
        "fg" => {
            if let Value::String(s) = value {
                style = style.fg(parse_color(s));
            }
        }
        "bg" => {
            if let Value::String(s) = value {
                style = style.bg(parse_color(s));
            }
        }
        "href" => {
            if let Value::String(s) = value {
                style = style.hyperlink(Some(s.as_str().into()));
            }
        }
        "bold" => style = apply_modifier(style, value, Modifiers::BOLD),
        "dim" => style = apply_modifier(style, value, Modifiers::DIM),
        "italic" => style = apply_modifier(style, value, Modifiers::ITALIC),
        "underline" => style = apply_modifier(style, value, Modifiers::UNDERLINE),
        "blink" => style = apply_modifier(style, value, Modifiers::BLINK),
        "reversed" => style = apply_modifier(style, value, Modifiers::REVERSED),
        "hidden" => style = apply_modifier(style, value, Modifiers::HIDDEN),
        "strikethrough" => style = apply_modifier(style, value, Modifiers::STRIKETHROUGH),
        _ => return None,
    }
    Some(style)
}

/// Set or clear `modifier` on `style` from a JSON value: `true` adds it,
/// anything else removes it.
fn apply_modifier(style: Style, value: &Value, modifier: Modifiers) -> Style {
    if value.as_bool() == Some(true) {
        style.add_modifier(modifier)
    } else {
        let cleared = style.modifiers.remove(modifier);
        style.modifier(cleared)
    }
}

/// Convert a JSON scalar into a tern property value; `None` for values that
/// have no prop representation (null, arrays, objects).
pub fn json_to_prop_value(value: Value) -> Option<PropValue> {
    match value {
        Value::String(s) => Some(PropValue::Str(s)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Some(PropValue::Int(i)),
            None => Some(PropValue::Float(n.as_f64().unwrap_or(0.0))),
        },
        Value::Bool(b) => Some(PropValue::Bool(b)),
        _ => None,
    }
}

/// Parse a color string: `"#rrggbb"` → truecolor, `"indexed:<n>"` → ANSI
/// palette, `"default"` → terminal default, anything else → default.
fn parse_color(s: &str) -> Color {
    if s == "default" {
        return Color::Default;
    }
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            let ok = (|r: &str, g: &str, b: &str| {
                Some((
                    u8::from_str_radix(r, 16).ok()?,
                    u8::from_str_radix(g, 16).ok()?,
                    u8::from_str_radix(b, 16).ok()?,
                ))
            })(&hex[0..2], &hex[2..4], &hex[4..6]);
            if let Some((r, g, b)) = ok {
                return Color::Rgb(r, g, b);
            }
        }
    }
    if let Some(idx) = s.strip_prefix("indexed:") {
        if let Ok(n) = idx.parse::<u8>() {
            return Color::Indexed(n);
        }
    }
    Color::Default
}

/// Parse a border style keyword; anything unrecognized → no border.
fn parse_border_style(s: &str) -> BorderStyle {
    match s {
        "plain" => BorderStyle::Plain,
        "rounded" => BorderStyle::Rounded,
        "double" => BorderStyle::Double,
        "thick" => BorderStyle::Thick,
        _ => BorderStyle::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::scene::PropValue;

    fn map(json: &str) -> serde_json::Map<String, Value> {
        serde_json::from_str(json).expect("test JSON parses")
    }

    #[test]
    fn style_keys_lift_into_style_and_rest_into_props() {
        let (style, props) = props_to_style_map(map(
            r##"{"fg":"#ff0000","bg":"indexed:4","bold":true,"dim":false,
                "border_style":"rounded","border_color":"#00ff00",
                "text":"hi","gap":2,"width":10.5}"##,
        ));
        assert_eq!(style.fg, Color::Rgb(255, 0, 0));
        assert_eq!(style.bg, Color::Indexed(4));
        assert!(style.modifiers.contains(Modifiers::BOLD));
        assert!(!style.modifiers.contains(Modifiers::DIM));
        assert_eq!(style.border_style, BorderStyle::Rounded);
        assert_eq!(style.border_color, Color::Rgb(0, 255, 0));
        assert_eq!(props.get("text"), Some(&PropValue::Str("hi".into())));
        assert_eq!(props.get("gap"), Some(&PropValue::Int(2)));
        assert_eq!(props.get("width"), Some(&PropValue::Float(10.5)));
        assert!(!props.contains_key("fg"));
    }

    #[test]
    fn non_scalar_prop_values_are_dropped() {
        let (_, props) = props_to_style_map(map(r#"{"obj":{"a":1},"arr":[1],"null":null}"#));
        assert!(props.is_empty());
    }

    #[test]
    fn single_key_merge_matches_full_map() {
        let (full_style, _) = props_to_style_map(map(r##"{"fg":"#00ff00","bold":true}"##));
        let mut merged = Style::new();
        merged = apply_style_key(merged, "fg", &serde_json::json!("#00ff00")).unwrap();
        merged = apply_style_key(merged, "bold", &serde_json::json!(true)).unwrap();
        assert_eq!(merged, full_style);
        // A false modifier clears it.
        let cleared = apply_style_key(merged.clone(), "bold", &serde_json::json!(false)).unwrap();
        assert!(!cleared.modifiers.contains(Modifiers::BOLD));
        // Unknown keys fall through as prop keys.
        assert!(apply_style_key(merged, "gap", &serde_json::json!(2)).is_none());
    }

    #[test]
    fn href_lifts_into_style_hyperlink() {
        let (style, props) = props_to_style_map(map(
            r##"{"href":"https://example.com","fg":"#ff0000"}"##,
        ));
        assert_eq!(style.hyperlink.as_deref(), Some("https://example.com"));
        assert_eq!(style.fg, Color::Rgb(255, 0, 0), "other keys still lift");
        assert!(!props.contains_key("href"), "href is a style key, not a prop");
    }

    #[test]
    fn href_absent_or_non_string_leaves_hyperlink_none() {
        // No href key: the style carries no hyperlink.
        let (plain, _) = props_to_style_map(map(r##"{"fg":"#ff0000"}"##));
        assert!(plain.hyperlink.is_none());

        // A non-string href value is dropped, exactly like other style keys.
        let (non_string, _) = props_to_style_map(map(r#"{"href":42}"#));
        assert!(non_string.hyperlink.is_none());
    }

    #[test]
    fn single_key_href_merge_matches_full_map() {
        let (full_style, _) = props_to_style_map(map(r##"{"href":"https://example.com"}"##));
        let mut merged = Style::new();
        merged = apply_style_key(merged, "href", &serde_json::json!("https://example.com")).unwrap();
        assert_eq!(merged, full_style);
        assert_eq!(merged.hyperlink.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn color_and_border_parsing() {
        assert_eq!(parse_color("#abcdef"), Color::Rgb(0xab, 0xcd, 0xef));
        assert_eq!(parse_color("indexed:200"), Color::Indexed(200));
        assert_eq!(parse_color("default"), Color::Default);
        assert_eq!(parse_color("bogus"), Color::Default);
        assert_eq!(parse_color("#12345"), Color::Default); // wrong length
        for (s, b) in [
            ("plain", BorderStyle::Plain),
            ("rounded", BorderStyle::Rounded),
            ("double", BorderStyle::Double),
            ("thick", BorderStyle::Thick),
            ("none", BorderStyle::None),
            ("bogus", BorderStyle::None),
        ] {
            assert_eq!(parse_border_style(s), b, "{s}");
        }
    }
}
