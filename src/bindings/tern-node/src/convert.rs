//! Module-level napi functions and JS<->tern-core conversion helpers.

use super::*;
use napi_derive::napi;

/// Create a detached node template of `type` (`"box"`, `"text"`, or
/// `"streaming_text"`) with `props`. The handle is materialized into the scene
/// when it is added to a bound parent via `NodeHandle.add_child`. See
/// `set_props` for the style-key convention.
#[napi(js_name = "create_node")]
pub fn create_node(
    r#type: String,
    props: Option<HashMap<String, serde_json::Value>>,
) -> Result<NodeHandle> {
    let kind = match r#type.as_str() {
        "box" => NodeKind::Box,
        "text" => NodeKind::Text,
        "streaming_text" => NodeKind::StreamingText,
        other => {
            return Err(Error::from_reason(format!(
                "unknown node type {other:?} (expected \"box\", \"text\", or \"streaming_text\")"
            )))
        }
    };
    let (style, props) = props_to_style_map(props.unwrap_or_default());
    Ok(NodeHandle {
        inner: Arc::new(Mutex::new(NodeInner {
            scene: shared_scene().clone(),
            id: None,
            kind,
            style,
            props,
        })),
    })
}

/// Token-highlight `source` in `language` (a Markdown fence info string:
/// `"rust"` / `"typescript"` / `"ts"` / `"tsx"` / `"javascript"` / `"js"` /
/// `"json"` / `"bash"` / `"shell"` / `"sh"` / `"zsh"`) into a complete span
/// stream for a code fence or a `streaming_text` node.
///
/// The returned spans cover every byte of `source` (gaps carry no style) and
/// merge adjacent same-style runs, so concatenating their `text` reconstructs
/// the source exactly — the compositor paints them in order. Unknown
/// languages error; tree-sitter is error-tolerant, so half-open streaming
/// input still highlights.
#[napi(js_name = "highlight")]
pub fn highlight(language: String, source: String) -> Result<Vec<HighlightSpanJs>> {
    let Some(lang) = tern_highlight::Language::from_fence_name(&language) else {
        return Err(Error::from_reason(format!(
            "unknown highlight language {language:?}"
        )));
    };
    Ok(tern_highlight::highlight(lang, &source)
        .into_iter()
        .map(|span| HighlightSpanJs {
            text: span.text,
            fg: span
                .style
                .fg
                .rgb()
                .map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}")),
            bold: span.style.modifiers.contains(Modifiers::BOLD),
            italic: span.style.modifiers.contains(Modifiers::ITALIC),
            dim: span.style.modifiers.contains(Modifiers::DIM),
            underline: span.style.modifiers.contains(Modifiers::UNDERLINE),
        })
        .collect())
}

/// Split a JS props object into a tern style (style keys) and a tern property
/// map (everything else). The style is built from scratch over the recognized
/// style keys — a full-map replacement (see [`apply_style_key`] for the
/// single-key merge variant).
pub(crate) fn props_to_style_map(props: HashMap<String, serde_json::Value>) -> (Style, PropMap) {
    let mut style = Style::new();
    let mut map = PropMap::new();
    for (key, value) in props {
        match apply_style_key(style, &key, &value) {
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
///
/// Unlike the full-map path — which rebuilds the style from scratch over the
/// given keys — this merges `key`'s effect into the existing style, so the
/// single-key `set_prop` path leaves every other style field untouched. A
/// boolean modifier key with a `false` (or non-true) value clears the
/// modifier, matching what the full-map path produces for the same key (a
/// freshly rebuilt style simply lacks it).
pub(crate) fn apply_style_key(mut style: Style, key: &str, value: &serde_json::Value) -> Option<Style> {
    match key {
        "border_style" => {
            if let serde_json::Value::String(s) = value {
                style = style.border_style(parse_border_style(s));
            }
        }
        "border_color" => {
            if let serde_json::Value::String(s) = value {
                style = style.border_color(parse_color(s));
            }
        }
        "fg" => {
            if let serde_json::Value::String(s) = value {
                style = style.fg(parse_color(s));
            }
        }
        "bg" => {
            if let serde_json::Value::String(s) = value {
                style = style.bg(parse_color(s));
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
/// anything else removes it (the full-map path builds a fresh style where a
/// non-true modifier is simply absent, so the single-key path must clear the
/// modifier to stay equivalent).
pub(crate) fn apply_modifier(style: Style, value: &serde_json::Value, modifier: Modifiers) -> Style {
    if value.as_bool() == Some(true) {
        style.add_modifier(modifier)
    } else {
        style.modifier(style.modifiers.remove(modifier))
    }
}

/// Convert a JSON scalar into a tern property value; `None` for values that
/// have no prop representation (null, arrays, objects).
pub(crate) fn json_to_prop_value(value: serde_json::Value) -> Option<PropValue> {
    match value {
        serde_json::Value::String(s) => Some(PropValue::Str(s)),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => Some(PropValue::Int(i)),
            None => Some(PropValue::Float(n.as_f64().unwrap_or(0.0))),
        },
        serde_json::Value::Bool(b) => Some(PropValue::Bool(b)),
        _ => None,
    }
}

/// Parse a color string: `"#rrggbb"` → truecolor, `"indexed:<n>"` → ANSI
/// palette, `"default"` → terminal default, anything else → default.
pub(crate) fn parse_color(s: &str) -> Color {
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
pub(crate) fn parse_border_style(s: &str) -> BorderStyle {
    match s {
        "plain" => BorderStyle::Plain,
        "rounded" => BorderStyle::Rounded,
        "double" => BorderStyle::Double,
        "thick" => BorderStyle::Thick,
        _ => BorderStyle::None,
    }
}

/// The JS-facing name of a tern key.
pub(crate) fn key_name_str(name: KeyName) -> String {
    match name {
        KeyName::Char => "char",
        KeyName::Enter => "enter",
        KeyName::Escape => "escape",
        KeyName::Backspace => "backspace",
        KeyName::Tab => "tab",
        KeyName::BackTab => "backtab",
        KeyName::Delete => "delete",
        KeyName::Insert => "insert",
        KeyName::Home => "home",
        KeyName::End => "end",
        KeyName::PageUp => "pageup",
        KeyName::PageDown => "pagedown",
        KeyName::Up => "up",
        KeyName::Down => "down",
        KeyName::Left => "left",
        KeyName::Right => "right",
        KeyName::F(n) => return format!("f{n}"),
        KeyName::Null => "null",
        KeyName::Unknown => "unknown",
    }
    .to_string()
}
