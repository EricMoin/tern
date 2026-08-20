//! Module-level napi functions and JS<->tern-core conversion helpers.

use super::*;
use napi_derive::napi;

/// Create a detached node template of `type` (`"box"`, `"text"`, or
/// `"streaming_text"`) with `props`. The handle is materialized into the scene
/// when it is added to a bound parent via `NodeHandle.add_child`. See
/// `set_props` for the style-key convention.
#[napi(js_name = "create_node")]
pub fn create_node(
    node_type: String,
    props: Option<HashMap<String, serde_json::Value>>,
) -> Result<NodeHandle> {
    let kind = match node_type.as_str() {
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
        .map(span_to_highlight_js)
        .collect())
}

/// Map a tern [`Span`] onto the JS highlight span shape: the `fg` as a
/// `"#rrggbb"` hex string and the boolean modifier keys. The style-key shape
/// mirrors the `append_span` convention, so a JS consumer can feed the span
/// straight into a `streaming_text` node.
pub(crate) fn span_to_highlight_js(span: Span) -> HighlightSpanJs {
    HighlightSpanJs {
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
    }
}

/// An incremental token highlighter: buffers the accumulated source and
/// re-parses only the tail on each [`append`](Self::append), reusing the
/// previous tree so tree-sitter skips the untouched head. The one-shot
/// [`highlight`] re-parses the whole source per call; this class exists for
/// streaming consumers (a growing Markdown fence) where only the tail
/// changes between renders.
///
/// Shared state lives behind `Arc<Mutex<_>>`, the binding's standard pattern
/// (see [`NodeHandle`](crate::NodeHandle)): the class instance stays
/// `Send + Sync` and every method is safe to call from the JS thread.
#[napi]
pub struct IncrementalHighlighter {
    inner: Arc<Mutex<IncrementalHighlighterInner>>,
}

/// The engine plus the wrapper's bookkeeping. `appended` tracks whether a
/// non-empty append has happened since construction or the last
/// [`reset`](IncrementalHighlighter::reset) — `changed` is `None` before the
/// first append, when there is no previous parse to change.
pub(crate) struct IncrementalHighlighterInner {
    engine: tern_highlight::IncrementalHighlighter,
    appended: bool,
}

#[napi]
impl IncrementalHighlighter {
    /// Build a highlighter for `language` (a Markdown fence info string,
    /// exactly like [`highlight`]). Errors on unknown languages or when the
    /// grammar fails to load.
    #[napi(constructor)]
    pub fn new(language: String) -> Result<Self> {
        let Some(lang) = tern_highlight::Language::from_fence_name(&language) else {
            return Err(Error::from_reason(format!(
                "unknown highlight language {language:?}"
            )));
        };
        let Some(engine) = tern_highlight::IncrementalHighlighter::new(lang) else {
            return Err(Error::from_reason(format!(
                "failed to load the {language:?} highlight grammar"
            )));
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(IncrementalHighlighterInner {
                engine,
                appended: false,
            })),
        })
    }

    /// Append `chunk` to the buffered source and return the complete span
    /// stream over the accumulated text, plus the byte range the incremental
    /// re-parse reworked (`None` before the first append). An empty chunk is
    /// a no-op: no spans, no changed range.
    #[napi]
    pub fn append(&self, chunk: String) -> HighlightAppendJs {
        let mut inner = self.inner.lock().expect("incremental highlighter poisoned");
        let spans = inner.engine.append(&chunk);
        let changed = if !inner.appended || chunk.is_empty() {
            None
        } else {
            let (start, end) = inner.engine.last_changed_span();
            Some([start as u32, end as u32])
        };
        if !chunk.is_empty() {
            inner.appended = true;
        }
        HighlightAppendJs {
            spans: spans.into_iter().map(span_to_highlight_js).collect(),
            changed,
        }
    }

    /// Drop the buffered source and the parse tree; the next
    /// [`append`](Self::append) is a full parse from scratch (and reports no
    /// changed range, like any first append).
    #[napi]
    pub fn reset(&self) {
        let mut inner = self.inner.lock().expect("incremental highlighter poisoned");
        inner.engine.reset();
        inner.appended = false;
    }
}

/// Split a JS props object into a tern style (style keys) and a tern property
/// map (everything else). The style is built from scratch over the recognized
/// style keys — a full-map replacement (see [`apply_style_key`] for the
/// single-key merge variant).
pub(crate) fn props_to_style_map(props: HashMap<String, serde_json::Value>) -> (Style, PropMap) {
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
        "href" => {
            if let serde_json::Value::String(s) = value {
                style = style.hyperlink(Some(s.as_str().into()));
            }
        }
        "underline_style" => {
            if let serde_json::Value::String(s) = value {
                style = style.underline_style(parse_underline_style(s));
            }
        }
        "underline_color" => {
            if let serde_json::Value::String(s) = value {
                style = style.underline_color(Some(parse_color(s)));
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
        let removed = style.modifiers.remove(modifier);
        style.modifier(removed)
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

/// Parse an underline style keyword; anything unrecognized → no variant
/// (the legacy `underline` modifier bit keeps painting a plain underline).
pub(crate) fn parse_underline_style(s: &str) -> UnderlineStyle {
    match s {
        "single" => UnderlineStyle::Single,
        "double" => UnderlineStyle::Double,
        "curly" => UnderlineStyle::Curly,
        "dotted" => UnderlineStyle::Dotted,
        "dashed" => UnderlineStyle::Dashed,
        _ => UnderlineStyle::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn href_lifts_into_style_hyperlink() {
        let (style, _) = props_to_style_map(HashMap::from([
            ("href".to_string(), serde_json::json!("https://example.com")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
        ]));
        assert_eq!(style.hyperlink.as_deref(), Some("https://example.com"));
        assert_eq!(style.fg, Color::Rgb(255, 0, 0), "other keys still lift");
        assert!(!style.hyperlink.as_deref().is_none());
    }

    #[test]
    fn href_absent_or_non_string_leaves_hyperlink_none() {
        // No href key: the style carries no hyperlink.
        let (plain, _) = props_to_style_map(HashMap::from([("fg".to_string(), serde_json::json!("#ff0000"))]));
        assert!(plain.hyperlink.is_none());

        // A non-string href value is dropped, exactly like other style keys.
        let (non_string, _) = props_to_style_map(HashMap::from([("href".to_string(), serde_json::json!(42))]));
        assert!(non_string.hyperlink.is_none());
    }

    #[test]
    fn single_key_href_merge_matches_full_map() {
        let (full, _) = props_to_style_map(HashMap::from([
            ("href".to_string(), serde_json::json!("https://example.com")),
        ]));
        let mut merged = Style::new();
        merged = apply_style_key(merged, "href", &serde_json::json!("https://example.com")).unwrap();
        assert_eq!(merged, full);
        assert_eq!(merged.hyperlink.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn underline_style_lifts_into_style_variant() {
        let (style, _) = props_to_style_map(HashMap::from([
            ("underline_style".to_string(), serde_json::json!("curly")),
            ("fg".to_string(), serde_json::json!("#ff0000")),
        ]));
        assert_eq!(style.underline_style, UnderlineStyle::Curly);
        assert_eq!(style.fg, Color::Rgb(255, 0, 0), "other keys still lift");

        // Every variant keyword maps; an unknown keyword (or a non-string
        // value) leaves the variant at the default `None`.
        for (key, expected) in [
            ("single", UnderlineStyle::Single),
            ("double", UnderlineStyle::Double),
            ("curly", UnderlineStyle::Curly),
            ("dotted", UnderlineStyle::Dotted),
            ("dashed", UnderlineStyle::Dashed),
        ] {
            let (style, _) = props_to_style_map(HashMap::from([(
                "underline_style".to_string(),
                serde_json::json!(key),
            )]));
            assert_eq!(style.underline_style, expected, "keyword {key}");
        }
        let (unknown, _) = props_to_style_map(HashMap::from([(
            "underline_style".to_string(),
            serde_json::json!("wiggly"),
        )]));
        assert_eq!(unknown.underline_style, UnderlineStyle::None);
        let (non_string, _) = props_to_style_map(HashMap::from([(
            "underline_style".to_string(),
            serde_json::json!(42),
        )]));
        assert_eq!(non_string.underline_style, UnderlineStyle::None);
    }

    #[test]
    fn underline_color_lifts_into_style_color() {
        let (style, _) = props_to_style_map(HashMap::from([(
            "underline_color".to_string(),
            serde_json::json!("#ff0000"),
        )]));
        assert_eq!(style.underline_color, Some(Color::Rgb(255, 0, 0)));
        let (style, _) = props_to_style_map(HashMap::from([(
            "underline_color".to_string(),
            serde_json::json!("indexed:9"),
        )]));
        assert_eq!(style.underline_color, Some(Color::Indexed(9)));
        // Absent or non-string values leave the color unset.
        let (plain, _) = props_to_style_map(HashMap::new());
        assert!(plain.underline_color.is_none());
        let (non_string, _) = props_to_style_map(HashMap::from([(
            "underline_color".to_string(),
            serde_json::json!(true),
        )]));
        assert!(non_string.underline_color.is_none());
    }

    #[test]
    fn single_key_underline_merge_matches_full_map() {
        let (full, _) = props_to_style_map(HashMap::from([
            (
                "underline_style".to_string(),
                serde_json::json!("double"),
            ),
            (
                "underline_color".to_string(),
                serde_json::json!("#00ff00"),
            ),
        ]));
        let mut merged = Style::new();
        merged = apply_style_key(merged, "underline_style", &serde_json::json!("double")).unwrap();
        merged = apply_style_key(merged, "underline_color", &serde_json::json!("#00ff00")).unwrap();
        assert_eq!(merged, full);
        assert_eq!(merged.underline_style, UnderlineStyle::Double);
        assert_eq!(merged.underline_color, Some(Color::Rgb(0, 255, 0)));
    }

    #[test]
    fn parse_underline_style_keywords() {
        assert_eq!(parse_underline_style("single"), UnderlineStyle::Single);
        assert_eq!(parse_underline_style("double"), UnderlineStyle::Double);
        assert_eq!(parse_underline_style("curly"), UnderlineStyle::Curly);
        assert_eq!(parse_underline_style("dotted"), UnderlineStyle::Dotted);
        assert_eq!(parse_underline_style("dashed"), UnderlineStyle::Dashed);
        assert_eq!(parse_underline_style("nope"), UnderlineStyle::None);
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
