//! tern-node — napi binding between Deno/Node.js and tern-core.
//!
//! This is the layer the JS reconciler (`packages/core`) talks to. It exposes
//! two surfaces:
//!
//! * **`TuiRenderer`** — owns the terminal lifecycle (raw mode + alternate
//!   screen via tern-terminal), the scene, and the render loop: `root()`
//!   returns a handle to the scene root, `poll_events(timeout_ms)` returns
//!   the events since the last poll (keys, resizes, focus changes, and
//!   mouse), `render()` paints the scene to the terminal, and `destroy()`
//!   tears the terminal state back down.
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
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene, Span};
use tern_core::style::{BorderStyle, Modifiers, Style};
use tern_core::{Color, Size};
use tern_terminal::backend::Backend;
use tern_terminal::event::{self, KeyName, MouseButton, MouseEventKind, TernEvent, TernKey, TernMouse};

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

/// A mouse event surfaced to JS as a plain object.
///
/// `kind` encodes both the action and — where relevant — the button, so no
/// button information is lost: `"down_left"`, `"up_right"`,
/// `"drag_middle"`, `"moved"`, `"scroll_up"`, `"scroll_down"`,
/// `"scroll_left"`, `"scroll_right"`. `column` / `row` are the cell the
/// event occurred on (0-based); `ctrl` / `alt` / `shift` are the held
/// modifiers.
#[napi(object)]
pub struct MouseEventJs {
    /// The action + button, e.g. `"down_left"`, `"up_right"`,
    /// `"drag_middle"`, `"moved"`, `"scroll_up"`.
    pub kind: String,
    /// The column the event occurred on (0-based).
    pub column: u16,
    /// The row the event occurred on (0-based).
    pub row: u16,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

impl MouseEventJs {
    fn from_tern(mouse: TernMouse) -> Self {
        let kind = match mouse.kind {
            MouseEventKind::Down(button) => format!("down_{}", mouse_button_str(button)),
            MouseEventKind::Up(button) => format!("up_{}", mouse_button_str(button)),
            MouseEventKind::Drag(button) => format!("drag_{}", mouse_button_str(button)),
            MouseEventKind::Moved => "moved".to_string(),
            MouseEventKind::ScrollDown => "scroll_down".to_string(),
            MouseEventKind::ScrollUp => "scroll_up".to_string(),
            MouseEventKind::ScrollLeft => "scroll_left".to_string(),
            MouseEventKind::ScrollRight => "scroll_right".to_string(),
        };
        Self {
            kind,
            column: mouse.column,
            row: mouse.row,
            ctrl: mouse.ctrl,
            alt: mouse.alt,
            shift: mouse.shift,
        }
    }
}

/// The JS-facing name of a mouse button.
fn mouse_button_str(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// A terminal event surfaced to JS as a tagged-union plain object: `type`
/// discriminates (`"key"`, `"resize"`, `"focus"`, `"mouse"`) and exactly one
/// of `key` / `width`+`height` / `focus_gained` / `mouse` is set. For
/// `"focus"`, `focus_gained` is `true` on gained and `false` on lost.
#[napi(object)]
pub struct TernEventJs {
    /// The event kind: `"key"`, `"resize"`, `"focus"`, or `"mouse"`.
    #[napi(js_name = "type")]
    pub r#type: String,
    /// The key event, when `type` is `"key"`.
    pub key: Option<KeyEvent>,
    /// The new width in columns, when `type` is `"resize"`.
    pub width: Option<u16>,
    /// The new height in rows, when `type` is `"resize"`.
    pub height: Option<u16>,
    /// Whether focus was gained (`true`) or lost (`false`), when `type` is
    /// `"focus"`.
    #[napi(js_name = "focus_gained")]
    pub focus_gained: Option<bool>,
    /// The mouse event, when `type` is `"mouse"`.
    pub mouse: Option<MouseEventJs>,
}

impl TernEventJs {
    fn from_tern(ev: TernEvent) -> Self {
        match ev {
            TernEvent::Key(key) => Self {
                r#type: "key".to_string(),
                key: Some(KeyEvent::from_tern(key)),
                width: None,
                height: None,
                focus_gained: None,
                mouse: None,
            },
            TernEvent::Resize { w, h } => Self {
                r#type: "resize".to_string(),
                key: None,
                width: Some(w),
                height: Some(h),
                focus_gained: None,
                mouse: None,
            },
            TernEvent::FocusGained => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(true),
                mouse: None,
            },
            TernEvent::FocusLost => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(false),
                mouse: None,
            },
            TernEvent::Mouse(mouse) => Self {
                r#type: "mouse".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: None,
                mouse: Some(MouseEventJs::from_tern(mouse)),
            },
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
    /// Enter raw mode + the alternate screen, ready to render. Mouse and
    /// focus-change event delivery is enabled so `poll_events` can surface
    /// them.
    ///
    /// If any terminal transition fails the already-entered states are rolled
    /// back before the error is returned, so a failed constructor never leaves
    /// the terminal in raw mode.
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
        if let Err(e) = backend.enable_event_listening() {
            let _ = backend.exit_alt_screen();
            let _ = backend.exit_raw_mode();
            return Err(Error::from_reason(format!(
                "enable event listening: {e}"
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

    /// Block up to `timeout_ms` for input, returning every event that arrived
    /// in that window (a burst of events comes back as one batch).
    ///
    /// Key, resize, focus, and mouse events are all surfaced (mouse and focus
    /// delivery is enabled in the constructor). With `exit_on_ctrl_c` enabled,
    /// a Ctrl+C press tears the renderer down instead of being returned;
    /// subsequent calls error until a new renderer is constructed.
    #[napi(js_name = "poll_events")]
    pub fn poll_events(&self, timeout_ms: u32) -> Result<Vec<TernEventJs>> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Err(Error::from_reason("renderer is destroyed"));
        }
        let events = event::poll_events(Duration::from_millis(timeout_ms as u64))
            .map_err(|e| Error::from_reason(format!("poll events: {e}")))?;
        let mut out = Vec::new();
        for ev in events {
            let ctrl_c = matches!(&ev, TernEvent::Key(key) if key.ctrl && key.char == Some('c'));
            if inner.exit_on_ctrl_c && ctrl_c {
                let _ = inner.backend.disable_event_listening();
                let _ = inner.backend.exit_alt_screen();
                let _ = inner.backend.exit_raw_mode();
                inner.destroyed = true;
                return Ok(out);
            }
            out.push(TernEventJs::from_tern(ev));
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

    /// Leave the alternate screen and raw mode and stop event listening,
    /// restoring the terminal. Safe to call more than once; a destroyed
    /// renderer cannot render or poll.
    #[napi(js_name = "destroy")]
    pub fn destroy(&self) -> Result<()> {
        let mut inner = self.inner.lock().expect("renderer inner poisoned");
        if inner.destroyed {
            return Ok(());
        }
        let _ = inner.backend.disable_event_listening();
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

    /// Materialize `child` (a detached `create_node` template) into the scene
    /// under this node, positioned immediately before `anchor` in this node's
    /// children, and return the bound child handle so calls can chain
    /// (`parent.insert_before(create_node(...), existing_child)`).
    ///
    /// `anchor` must be an already-attached child of this node (in this node's
    /// scene); `child` must still be detached. Errors when `self` is detached,
    /// `child` already has a parent, or `anchor` is detached / not a child of
    /// this node.
    #[napi(js_name = "insert_before")]
    pub fn insert_before(&self, child: &NodeHandle, anchor: &NodeHandle) -> Result<NodeHandle> {
        let (parent_id, parent_scene) = {
            let parent = self.inner.lock().expect("node inner poisoned");
            let id = parent
                .id
                .ok_or_else(|| Error::from_reason("parent node is not attached to a scene"))?;
            (id, parent.scene.clone())
        };
        // Snapshot the detached child's materialization data before touching
        // the anchor: `child` and `anchor` may alias the same handle, and no
        // two handle mutexes are ever held at once.
        let (kind, style, props) = {
            let child_inner = child.inner.lock().expect("node inner poisoned");
            if child_inner.id.is_some() {
                return Err(Error::from_reason("child node already has a parent"));
            }
            (child_inner.kind, child_inner.style, child_inner.props.clone())
        };
        let anchor_id = {
            let anchor_inner = anchor.inner.lock().expect("node inner poisoned");
            let id = anchor_inner
                .id
                .ok_or_else(|| Error::from_reason("anchor node is not attached to a scene"))?;
            if !Arc::ptr_eq(&anchor_inner.scene, &parent_scene) {
                return Err(Error::from_reason("anchor node is not a child of this node"));
            }
            id
        };
        let mut scene = parent_scene.lock().expect("scene poisoned");
        let index = scene
            .children(parent_id)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?
            .iter()
            .position(|c| *c == anchor_id)
            .ok_or_else(|| Error::from_reason("anchor node is not a child of this node"))?;
        let id = scene
            .insert_child(parent_id, index, kind, style)
            .ok_or_else(|| Error::from_reason("parent node not found in scene"))?;
        scene.set_props(id, props);
        drop(scene);
        // Bind the child handle into the scene, mirroring `add_child`.
        {
            let mut child_inner = child.inner.lock().expect("node inner poisoned");
            child_inner.id = Some(id);
            child_inner.scene = parent_scene.clone();
        }
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

    /// Append a styled span of text to a `streaming_text` node's stream.
    ///
    /// `style` follows the same style-key convention as `set_props` (`fg`,
    /// `bg`, `border_style`, and the boolean modifiers are lifted into the
    /// span's style; every other key is ignored). The span is appended to the
    /// node's accumulated stream in the shared scene, in call order. Errors
    /// when the node is detached from the scene or is not a `streaming_text`
    /// node.
    #[napi(js_name = "append_span")]
    pub fn append_span(
        &self,
        text: String,
        style: Option<HashMap<String, serde_json::Value>>,
    ) -> Result<()> {
        let (style, _) = props_to_style_map(style.unwrap_or_default());
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        if inner.kind != NodeKind::StreamingText {
            return Err(Error::from_reason(
                "append_span requires a streaming_text node",
            ));
        }
        let mut scene = inner.scene.lock().expect("scene poisoned");
        if !scene.append_span(id, Span { text, style }) {
            return Err(Error::from_reason("node not found in scene"));
        }
        Ok(())
    }
}

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
    fn tern_event_js_resize_maps() {
        let ev = TernEventJs::from_tern(TernEvent::Resize { w: 120, h: 40 });
        assert_eq!(ev.r#type, "resize");
        assert_eq!(ev.width, Some(120));
        assert_eq!(ev.height, Some(40));
        assert!(ev.key.is_none());
        assert!(ev.focus_gained.is_none());
        assert!(ev.mouse.is_none());
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
        assert_eq!(
            encode(MouseEventKind::Up(MouseButton::Middle)),
            "up_middle"
        );
        assert_eq!(
            encode(MouseEventKind::Drag(MouseButton::Left)),
            "drag_left"
        );
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

    #[test]
    fn create_node_accepts_streaming_text_type() {
        let node = create_node("streaming_text".to_string(), None).expect("create streaming node");
        assert_eq!(node.inner.lock().expect("node inner poisoned").kind, NodeKind::StreamingText);
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
        node.append_span("b".to_string(), None).expect("second span");
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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

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
            vec![attached_id(&x), attached_id(&a), attached_id(&b), attached_id(&c)]
        );

        // Before the middle child.
        let y = root
            .insert_before(&text_template(), &b)
            .expect("insert before middle");
        assert_eq!(
            child_ids(&scene, &root),
            vec![attached_id(&x), attached_id(&a), attached_id(&y), attached_id(&b), attached_id(&c)]
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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

        let anchor = root.add_child(&text_template()).expect("add anchor");
        let child = create_node(
            "box".to_string(),
            Some(HashMap::from([("text".to_string(), serde_json::json!("hi"))])),
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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

        // `parent` is a box under root; the anchor is attached under root as
        // a sibling of `parent`, so it is not one of `parent`'s children.
        let parent = root.add_child(&create_node("box".to_string(), None).expect("create box"))
            .expect("add box");
        let _a = parent.add_child(&text_template()).expect("add a");
        let foreign = root.add_child(&text_template()).expect("add foreign");

        let err = match parent.insert_before(&text_template(), &foreign) {
            Ok(_) => panic!("foreign anchor must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("not a child of this node"), "{err}");
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
        let root =
            NodeHandle::materialized(scene.clone(), root_id, NodeKind::Root, Style::new(), PropMap::new());

        let a = root.add_child(&text_template()).expect("add a");
        let detached = create_node("box".to_string(), None).expect("create detached parent");

        let err = match detached.insert_before(&text_template(), &a) {
            Ok(_) => panic!("detached parent must error"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("not attached"), "{err}");
        assert_eq!(child_ids(&scene, &root), vec![attached_id(&a)]);
    }
}
