//! tern-node — napi binding between Deno/Node.js and tern-core.
//!
//! This is the layer the JS reconciler (`packages/core`) talks to. It exposes
//! two surfaces:
//!
//! * **`TuiRenderer`** — owns the terminal lifecycle (raw mode + alternate
//!   screen via tern-terminal), the scene, and the render loop: `root()`
//!   returns a handle to the scene root, `poll_events(timeout_ms)` returns
//!   the keys pressed since the last poll, `render()` paints the scene to the
//!   terminal, and `destroy()` tears the terminal state back down.
//! * **Scene construction** — `create_node(type, props)` builds a node
//!   handle (backed by the tern-components node model), and `NodeHandle`
//!   methods (`add_child` / `remove` / `set_props`) mutate the shared scene
//!   tree that `TuiRenderer::render` paints.
//!
//! ## Scene ownership
//!
//! The binding keeps **one module-global scene** (`shared_scene()`): both
//! `create_node` (module-level) and every `TuiRenderer` operate on the same
//! tree. This mirrors the architecture doc — `tern-node` is the single bridge
//! into the tern-core scene tree, and the MVP JS reconciler drives exactly one
//! renderer. Multiple renderers would render the same scene; creating more
//! than one is documented as out of scope for the MVP.
//!
//! All shared state lives behind `Arc<Mutex<_>>`, which keeps the napi class
//! instances `Send + Sync` (required by napi-rs) and makes every method safe
//! to call from the JS thread.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use tern_components::Compositor;
use tern_core::buffer::{diff, Buffer};
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene};
use tern_core::style::{BorderStyle, Modifiers, Style};
use tern_core::{Color, Size};
use tern_terminal::backend::Backend;
use tern_terminal::event::{self, KeyName, TernEvent, TernKey};

/// The one module-global scene tree. Both node construction and rendering
/// operate on it (see module docs for the ownership rationale).
fn shared_scene() -> &'static Arc<Mutex<Scene>> {
    static SCENE: OnceLock<Arc<Mutex<Scene>>> = OnceLock::new();
    SCENE.get_or_init(|| Arc::new(Mutex::new(Scene::new())))
}

/// A key event surfaced to JS as a plain object: `{ name, char, ctrl, alt,
/// shift }`. `char` is the printable character for `"char"`-named keys
/// (single-character string), `undefined` for named keys.
#[napi(object)]
pub struct KeyEvent {
    /// The key's name: `char`, `enter`, `escape`, `backspace`, `tab`,
    /// `backtab`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`,
    /// `up`, `down`, `left`, `right`, `f<n>`, `null`, `unknown`.
    pub name: String,
    /// The printable character for `"char"` keys.
    pub char: Option<String>,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

impl KeyEvent {
    fn from_tern(key: TernKey) -> Self {
        Self {
            name: key_name_str(key.name),
            char: key.char.map(|c| c.to_string()),
            ctrl: key.ctrl,
            alt: key.alt,
            shift: key.shift,
        }
    }
}

/// Constructor options for [`TuiRenderer`].
#[napi(object)]
pub struct TuiRendererOptions {
    /// When `true`, a Ctrl+C key press tears the terminal down (raw mode +
    /// alternate screen exited) and marks the renderer destroyed instead of
    /// being surfaced as an event.
    #[napi(js_name = "exit_on_ctrl_c")]
    pub exit_on_ctrl_c: Option<bool>,
}

/// The terminal-facing renderer: owns raw mode + alternate screen, polls
/// input, and paints the shared scene to the terminal.
#[napi]
pub struct TuiRenderer {
    inner: Arc<Mutex<RendererInner>>,
}

struct RendererInner {
    backend: Backend,
    compositor: Compositor,
    scene: Arc<Mutex<Scene>>,
    last: Option<Buffer>,
    exit_on_ctrl_c: bool,
    destroyed: bool,
}

#[napi]
impl TuiRenderer {
    /// Enter raw mode + the alternate screen, ready to render.
    ///
    /// If either terminal transition fails the other is rolled back before
    /// the error is returned, so a failed constructor never leaves the
    /// terminal in raw mode.
    #[napi(constructor, js_name = "TuiRenderer")]
    pub fn new(options: TuiRendererOptions) -> Result<Self> {
        let backend = Backend::new();
        backend
            .enter_raw_mode()
            .map_err(|e| Error::from_reason(format!("enter raw mode: {e}")))?;
        if let Err(e) = backend.enter_alt_screen() {
            let _ = backend.exit_raw_mode();
            return Err(Error::from_reason(format!(
                "enter alternate screen: {e}"
            )));
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(RendererInner {
                backend,
                compositor: Compositor::new(),
                scene: shared_scene().clone(),
                last: None,
                exit_on_ctrl_c: options.exit_on_ctrl_c.unwrap_or(false),
                destroyed: false,
            })),
        })
    }

    /// A handle to the scene root, to attach content under.
    #[napi(js_name = "root")]
    pub fn root(&self) -> NodeHandle {
        let inner = self.inner.lock().expect("renderer inner poisoned");
        let scene = inner.scene.clone();
        let id = scene.lock().expect("scene poisoned").root_id();
        NodeHandle::materialized(scene, id, NodeKind::Root, Style::new(), PropMap::new())
    }

    /// Block up to `timeout_ms` for input, returning every key event that
    /// arrived in that window (a burst of keys comes back as one batch).
    ///
    /// Resize and focus events are dropped in the MVP binding (spec: key
    /// events only). With `exit_on_ctrl_c` enabled, a Ctrl+C press tears the
    /// renderer down instead of being returned; subsequent calls error until
    /// a new renderer is constructed.
    #[napi(js_name = "poll_events")]
    pub fn poll_events(&self, timeout_ms: u32) -> Result<Vec<KeyEvent>> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let events = event::poll_events(Duration::from_millis(timeout_ms as u64))
            .map_err(|e| Error::from_reason(format!("poll events: {e}")))?;
        let mut out = Vec::new();
        for ev in events {
            // Resize / focus events are dropped in the MVP binding (spec:
            // `poll_events` returns key events only).
            let TernEvent::Key(key) = ev else {
                continue;
            };
            let ctrl_c = key.ctrl && key.char == Some('c');
            if inner.exit_on_ctrl_c && ctrl_c {
                let _ = inner.backend.exit_alt_screen();
                let _ = inner.backend.exit_raw_mode();
                inner.destroyed = true;
                return Ok(out);
            }
            out.push(KeyEvent::from_tern(key));
        }
        Ok(out)
    }

    /// Paint the shared scene into a fresh buffer at the current terminal
    /// size and flush the minimal diff (vs the previous frame) to the
    /// terminal.
    #[napi(js_name = "render")]
    pub fn render(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let (w, h) = inner
            .backend
            .size()
            .map_err(|e| Error::from_reason(format!("terminal size: {e}")))?;
        let viewport = Size::new(w, h);
        let scene = inner.scene.clone();
        let buffer = {
            let scene_guard = scene.lock().expect("scene poisoned");
            inner.compositor.paint_scene(&scene_guard, viewport)
        };
        let updates = match &inner.last {
            Some(prev) => buffer.diff_from(prev),
            None => diff(&Buffer::new(w, h), &buffer),
        };
        inner
            .backend
            .flush_diff(&updates, (0, 0))
            .map_err(|e| Error::from_reason(format!("flush: {e}")))?;
        inner.last = Some(buffer);
        Ok(())
    }

    /// Leave the alternate screen and raw mode, restoring the terminal. Safe
    /// to call more than once; a destroyed renderer cannot render or poll.
    #[napi(js_name = "destroy")]
    pub fn destroy(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Ok(());
        }
        let _ = inner.backend.exit_alt_screen();
        let _ = inner.backend.exit_raw_mode();
        inner.destroyed = true;
        Ok(())
    }

    /// Whether the renderer has been destroyed (explicitly or via Ctrl+C with
    /// `exit_on_ctrl_c`).
    #[napi(getter, js_name = "destroyed")]
    pub fn destroyed(&self) -> bool {
        self.inner.lock().expect("renderer inner poisoned").destroyed
    }
}

/// A handle to a scene node: either bound into the shared scene (`id` set) or
/// a detached template built by `create_node` that `add_child` materializes.
///
/// `kind` / `style` / `props` are kept on the handle as the source of truth
/// for materialization and `set_props`.
#[napi]
pub struct NodeHandle {
    inner: Arc<Mutex<NodeInner>>,
}

struct NodeInner {
    scene: Arc<Mutex<Scene>>,
    id: Option<NodeId>,
    kind: NodeKind,
    style: Style,
    props: PropMap,
}

impl NodeHandle {
    fn materialized(
        scene: Arc<Mutex<Scene>>,
        id: NodeId,
        kind: NodeKind,
        style: Style,
        props: PropMap,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NodeInner {
                scene,
                id: Some(id),
                kind,
                style,
                props,
            })),
        }
    }
}

#[napi]
impl NodeHandle {
    /// Materialize `child` (a detached `create_node` template) into the scene
    /// under this node and return the bound child handle, so calls can chain
    /// (`root.add_child(create_node(...))`). Errors when `self` is detached
    /// or `child` already has a parent.
    #[napi(js_name = "add_child")]
    pub fn add_child(&self, child: &NodeHandle) -> Result<NodeHandle> {
        let (parent_id, parent_scene) = {
            let parent = self.inner.lock().expect("node inner poisoned");
            let id = parent
                .id
                .ok_or_else(|| Error::from_reason("parent node is not attached to a scene"))?;
            (id, parent.scene.clone())
        };
        let mut child_inner = child.inner.lock().expect("node inner poisoned");
        if child_inner.id.is_some() {
            return Err(Error::from_reason("child node already has a parent"));
        }
        let mut scene = parent_scene.lock().expect("scene poisoned");
        let id = scene
            .add_child(parent_id, child_inner.kind, child_inner.style)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?;
        scene.set_props(id, child_inner.props.clone());
        drop(scene);
        child_inner.id = Some(id);
        child_inner.scene = parent_scene.clone();
        drop(child_inner);
        Ok(NodeHandle {
            inner: child.inner.clone(),
        })
    }

    /// Detach this node (and its whole subtree) from the scene. Returns
    /// `false` when the node was already detached (or is the scene root).
    #[napi(js_name = "remove")]
    pub fn remove(&self) -> Result<bool> {
        let mut inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Ok(false);
        };
        let removed = {
            let mut scene = inner.scene.lock().expect("scene poisoned");
            scene.remove(id)
        };
        inner.id = None;
        Ok(removed)
    }

    /// Replace this node's props (and style keys) in the scene.
    ///
    /// Recognized style keys are lifted out of the props object: `fg`, `bg`
    /// (color strings), `border_style` (`none|plain|rounded|double|thick`),
    /// and the boolean modifiers (`bold`, `dim`, `italic`, `underline`,
    /// `blink`, `reversed`, `hidden`, `strikethrough`). Every other key lands
    /// in the node's property map (`text`, layout keywords, ...).
    #[napi(js_name = "set_props")]
    pub fn set_props(&self, props: HashMap<String, serde_json::Value>) -> Result<()> {
        let (style, map) = props_to_style_map(props);
        let mut inner = self.inner.lock().expect("node inner poisoned");
        inner.style = style;
        inner.props = map.clone();
        if let Some(id) = inner.id {
            let mut scene = inner.scene.lock().expect("scene poisoned");
            scene.set_style(id, style);
            scene.set_props(id, map);
        }
        Ok(())
    }
}

/// Create a detached node template of `type` (`"box"` or `"text"`) with
/// `props`. The handle is materialized into the scene when it is added to a
/// bound parent via `NodeHandle.add_child`. See `set_props` for the style-key
/// convention.
#[napi(js_name = "create_node")]
pub fn create_node(
    r#type: String,
    props: Option<HashMap<String, serde_json::Value>>,
) -> Result<NodeHandle> {
    let kind = match r#type.as_str() {
        "box" => NodeKind::Box,
        "text" => NodeKind::Text,
        other => {
            return Err(Error::from_reason(format!(
                "unknown node type {other:?} (expected \"box\" or \"text\")"
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

/// Split a JS props object into a tern style (style keys) and a tern property
/// map (everything else).
fn props_to_style_map(props: HashMap<String, serde_json::Value>) -> (Style, PropMap) {
    let mut style = Style::new();
    let mut map = PropMap::new();
    for (key, value) in props {
        match key.as_str() {
            "border_style" => {
                if let serde_json::Value::String(s) = value {
                    style = style.border_style(parse_border_style(&s));
                }
            }
            "fg" => {
                if let serde_json::Value::String(s) = value {
                    style = style.fg(parse_color(&s));
                }
            }
            "bg" => {
                if let serde_json::Value::String(s) = value {
                    style = style.bg(parse_color(&s));
                }
            }
            "bold" => style = add_modifier_if(style, value, Modifiers::BOLD),
            "dim" => style = add_modifier_if(style, value, Modifiers::DIM),
            "italic" => style = add_modifier_if(style, value, Modifiers::ITALIC),
            "underline" => style = add_modifier_if(style, value, Modifiers::UNDERLINE),
            "blink" => style = add_modifier_if(style, value, Modifiers::BLINK),
            "reversed" => style = add_modifier_if(style, value, Modifiers::REVERSED),
            "hidden" => style = add_modifier_if(style, value, Modifiers::HIDDEN),
            "strikethrough" => style = add_modifier_if(style, value, Modifiers::STRIKETHROUGH),
            _ => {
                let Some(pv) = json_to_prop_value(value) else {
                    continue;
                };
                map.insert(key, pv);
            }
        }
    }
    (style, map)
}

/// Add `modifier` to `style` when the JSON value is `true`.
fn add_modifier_if(style: Style, value: serde_json::Value, modifier: Modifiers) -> Style {
    if value.as_bool() == Some(true) {
        style.add_modifier(modifier)
    } else {
        style
    }
}

/// Convert a JSON scalar into a tern property value; `None` for values that
/// have no prop representation (null, arrays, objects).
fn json_to_prop_value(value: serde_json::Value) -> Option<PropValue> {
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

/// The JS-facing name of a tern key.
fn key_name_str(name: KeyName) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
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
    fn parse_color_handles_hex_indexed_and_default() {
        assert_eq!(parse_color("#ff8000"), _Color::Rgb(255, 128, 0));
        assert_eq!(parse_color("indexed:5"), _Color::Indexed(5));
        assert_eq!(parse_color("default"), _Color::Default);
        assert_eq!(parse_color("garbage"), _Color::Default);
        assert_eq!(parse_color("#12"), _Color::Default); // too short
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
            ("fg".to_string(), serde_json::json!("#ff0000")),
            ("bold".to_string(), serde_json::json!(true)),
            ("hidden".to_string(), serde_json::json!(true)),
            ("nested".to_string(), serde_json::json!({"a": 1})), // dropped
        ]);
        let (style, map) = props_to_style_map(props);
        assert_eq!(style.border_style, BorderStyle::Rounded);
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
        assert_eq!(json_to_prop_value(serde_json::json!(7)), Some(PropValue::Int(7)));
        assert_eq!(
            json_to_prop_value(serde_json::json!(1.5)),
            Some(PropValue::Float(1.5))
        );
        assert_eq!(json_to_prop_value(serde_json::json!(true)), Some(PropValue::Bool(true)));
        assert_eq!(json_to_prop_value(serde_json::json!(null)), None);
        assert_eq!(json_to_prop_value(serde_json::json!([1, 2])), None);
    }
}
