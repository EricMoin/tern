//! The `NodeHandle` napi class: scene-node construction and mutation.

use super::*;
use napi_derive::napi;

/// A handle to a scene node: either bound into the shared scene (`id` set) or
/// a detached template built by `create_node` that `add_child` materializes.
///
/// `kind` / `style` / `props` are kept on the handle as the source of truth
/// for materialization and `set_props`.
#[napi]
pub struct NodeHandle {
    pub(crate) inner: Arc<Mutex<NodeInner>>,
}

pub(crate) struct NodeInner {
    pub(crate) scene: Arc<Mutex<Scene>>,
    pub(crate) id: Option<NodeId>,
    pub(crate) kind: NodeKind,
    pub(crate) style: Style,
    pub(crate) props: PropMap,
}

impl NodeHandle {
    pub(crate) fn materialized(
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
            .add_child(parent_id, child_inner.kind, child_inner.style.clone())
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
            (
                child_inner.kind,
                child_inner.style.clone(),
                child_inner.props.clone(),
            )
        };
        let anchor_id = {
            let anchor_inner = anchor.inner.lock().expect("node inner poisoned");
            let id = anchor_inner
                .id
                .ok_or_else(|| Error::from_reason("anchor node is not attached to a scene"))?;
            if !Arc::ptr_eq(&anchor_inner.scene, &parent_scene) {
                return Err(Error::from_reason(
                    "anchor node is not a child of this node",
                ));
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
    /// Recognized style keys are lifted out of the props object: `fg`, `bg`,
    /// `border_color` (color strings), `border_style`
    /// (`none|plain|rounded|double|thick`), and the boolean modifiers
    /// (`bold`, `dim`, `italic`, `underline`, `blink`, `reversed`, `hidden`,
    /// `strikethrough`). Every other key lands in the node's property map
    /// (`text`, layout keywords, ...).
    #[napi(js_name = "set_props")]
    pub fn set_props(&self, props: HashMap<String, serde_json::Value>) -> Result<()> {
        let (style, map) = props_to_style_map(props);
        let mut inner = self.inner.lock().expect("node inner poisoned");
        inner.style = style.clone();
        inner.props = map.clone();
        if let Some(id) = inner.id {
            let mut scene = inner.scene.lock().expect("scene poisoned");
            scene.set_style(id, style);
            scene.set_props(id, map);
        }
        Ok(())
    }

    /// Set a single property (or style key) on this node — the incremental
    /// counterpart of [`set_props`](Self::set_props): one key instead of the
    /// whole object.
    ///
    /// Recognized style keys (`fg`, `bg`, `border_color`, `border_style`, the
    /// boolean modifiers) are merged into the node's existing style; every
    /// other scalar key lands in the node's property map. Non-scalar values
    /// (null, arrays, objects) are dropped, exactly like `set_props`.
    ///
    /// An equal-value write is a no-op: the scene is not mutated and its
    /// epoch is not bumped, so a renderer's cached frame stays valid.
    #[napi(js_name = "set_prop")]
    pub fn set_prop(&self, key: String, value: serde_json::Value) -> Result<()> {
        let mut inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            // Detached template: record the single-key change for
            // materialization (`add_child` snapshots `kind`/`style`/`props`).
            if let Some(style) = apply_style_key(inner.style.clone(), &key, &value) {
                inner.style = style;
            } else if let Some(pv) = json_to_prop_value(value) {
                inner.props.insert(key, pv);
            }
            return Ok(());
        };
        // Clone the scene handle so the lock below does not hold `inner`
        // borrowed while the handle's own fields are mutated.
        let scene_arc = inner.scene.clone();
        let mut scene = scene_arc.lock().expect("scene poisoned");
        if let Some(style) = apply_style_key(inner.style.clone(), &key, &value) {
            if style != inner.style {
                inner.style = style.clone();
                scene.set_style(id, style);
            }
            return Ok(());
        }
        let Some(pv) = json_to_prop_value(value) else {
            return Ok(()); // non-scalar values are dropped, like set_props
        };
        if scene.prop(id, &key) != Some(&pv) {
            inner.props.insert(key.clone(), pv.clone());
            scene.set_prop(id, &key, pv);
        }
        Ok(())
    }

    /// Append a styled span of text to a `streaming_text` node's stream.
    ///
    /// `style` follows the same style-key convention as `set_props` (`fg`,
    /// `bg`, `border_color`, `border_style`, and the boolean modifiers are
    /// lifted into the span's style; every other key is ignored). The span is
    /// appended to the node's accumulated stream in the shared scene, in call
    /// order. Errors when the node is detached from the scene or is not a
    /// `streaming_text` node.
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

    /// Set the accessibility semantics of this node: the ARIA `role` name,
    /// optional `label`, active `state` flags, and the `enabled` /
    /// `selected` booleans.
    ///
    /// The renderer's `semantics` constructor option (default off) must
    /// have enabled the store, or the write errors. Errors when the node is
    /// detached from the scene, mirroring
    /// [`append_span`](Self::append_span), or when the role / state strings
    /// are unknown.
    #[napi(js_name = "set_semantics")]
    pub fn set_semantics(&self, node: SemanticsNodeJs) -> Result<()> {
        let node = semantics_node_from_js(node)?;
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        let mut scene = inner.scene.lock().expect("scene poisoned");
        if !scene.semantics_enabled() {
            return Err(Error::from_reason(
                "semantics store is disabled (construct the renderer with `semantics: true`)",
            ));
        }
        if !scene.set_semantics(id, node) {
            return Err(Error::from_reason("node not found in scene"));
        }
        Ok(())
    }

    /// Remove this node's accessibility semantics. Clearing a node with no
    /// entry is a no-op. Errors when the node is detached from the scene,
    /// mirroring [`append_span`](Self::append_span).
    #[napi(js_name = "clear_semantics")]
    pub fn clear_semantics(&self) -> Result<()> {
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        let mut scene = inner.scene.lock().expect("scene poisoned");
        scene.clear_semantics(id);
        Ok(())
    }

    /// The laid-out content size of this node: `{ width, height }` in cells.
    ///
    /// For `text` / `streaming_text` nodes this is the wrapped content size
    /// (the display width of the widest wrapped line and the wrapped line
    /// count at the node's laid-out width); for containers it is the laid-out
    /// rect size. The layout runs at the viewport of the most recent
    /// [`TuiRenderer::render`], so the geometry matches what is on screen. A
    /// node with no geometry (`display: none`) reports `(0, 0)`; a detached
    /// handle errors.
    #[napi(js_name = "content_size")]
    pub fn content_size(&self) -> Result<ContentSize> {
        let inner = self.inner.lock().expect("node inner poisoned");
        let Some(id) = inner.id else {
            return Err(Error::from_reason("node is not attached to a scene"));
        };
        let (w, h) = *shared_viewport_ref().lock().expect("viewport poisoned");
        let mut compositor = Compositor::new();
        let size = {
            let scene = inner.scene.lock().expect("scene poisoned");
            compositor.content_size(&scene, id, Size::new(w as u16, h as u16))
        };
        Ok(match size {
            Some((width, height)) => ContentSize { width, height },
            None => ContentSize {
                width: 0,
                height: 0,
            },
        })
    }
}
