//! The scene tree: a node graph produced by the reconciler and consumed by
//! layout and the compositor.

use std::collections::HashMap;

use crate::style::Style;

/// Stable identity of a scene node, unique within a [`Scene`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub u64);

/// What a node is; drives layout and paint behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeKind {
    /// The implicit root node of a scene.
    Root,
    /// A box: a styled region that lays out its children (flex container).
    Box,
    /// A leaf that renders its `text` prop content.
    Text,
}

/// A property value stored on a scene node.
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    /// String property, e.g. `text` content or a flex direction keyword.
    Str(String),
    /// Integer property, e.g. a pixel/gap size.
    Int(i64),
    /// Floating-point property.
    Float(f64),
    /// Boolean property, e.g. `display: none`.
    Bool(bool),
}

/// The property map of a scene node.
pub type PropMap = HashMap<String, PropValue>;

/// A node in the scene tree.
#[derive(Debug, Clone)]
pub struct SceneNode {
    /// This node's stable id.
    pub id: NodeId,
    /// What kind of node this is.
    pub kind: NodeKind,
    /// The node's visual style (colors, modifiers, border).
    pub style: Style,
    /// Ordered child ids. The [`Scene`] keeps the authoritative mapping; this
    /// list defines sibling order.
    pub children: Vec<NodeId>,
    /// Arbitrary per-node properties. Text content lives in `props["text"]`;
    /// layout keywords (flex direction, gap, ...) also ride here.
    pub props: PropMap,
    /// Parent id; `None` for the root.
    pub parent: Option<NodeId>,
}

/// An owned scene tree with an implicit root node.
///
/// All mutations keep parent/child links consistent: `add_child` links both
/// directions, `remove` detaches the node (and its whole subtree) from its
/// parent, and the root can never be removed.
#[derive(Debug)]
pub struct Scene {
    nodes: HashMap<NodeId, SceneNode>,
    root: NodeId,
    next_id: u64,
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

impl Scene {
    /// A new scene containing only the implicit root node.
    pub fn new() -> Self {
        let root = NodeId(0);
        let mut nodes = HashMap::new();
        nodes.insert(
            root,
            SceneNode {
                id: root,
                kind: NodeKind::Root,
                style: Style::new(),
                children: Vec::new(),
                props: PropMap::new(),
                parent: None,
            },
        );
        Self {
            nodes,
            root,
            next_id: 1,
        }
    }

    /// The id of the implicit root node.
    pub const fn root_id(&self) -> NodeId {
        self.root
    }

    /// Number of nodes in the scene (including the root).
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Whether the scene contains no nodes (never true in practice — the
    /// root always exists).
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Immutable access to a node.
    pub fn node(&self, id: NodeId) -> Option<&SceneNode> {
        self.nodes.get(&id)
    }

    /// Mutable access to a node.
    pub fn node_mut(&mut self, id: NodeId) -> Option<&mut SceneNode> {
        self.nodes.get_mut(&id)
    }

    /// The ordered child id slice of a node.
    pub fn children(&self, id: NodeId) -> Option<&[NodeId]> {
        self.nodes.get(&id).map(|n| n.children.as_slice())
    }

    /// Append a new child of `kind` under `parent`. Returns the new node's id,
    /// or `None` when `parent` does not exist.
    pub fn add_child(&mut self, parent: NodeId, kind: NodeKind, style: Style) -> Option<NodeId> {
        if !self.nodes.contains_key(&parent) {
            return None;
        }
        let id = NodeId(self.next_id);
        self.next_id += 1;
        self.nodes.insert(
            id,
            SceneNode {
                id,
                kind,
                style,
                children: Vec::new(),
                props: PropMap::new(),
                parent: Some(parent),
            },
        );
        self.nodes
            .get_mut(&parent)
            .expect("parent existence checked above")
            .children
            .push(id);
        Some(id)
    }

    /// Add a Text leaf with its `text` prop pre-populated.
    pub fn add_text(&mut self, parent: NodeId, content: &str, style: Style) -> Option<NodeId> {
        let id = self.add_child(parent, NodeKind::Text, style)?;
        self.set_prop(id, "text", PropValue::Str(content.to_string()));
        Some(id)
    }

    /// Remove `id` and all of its descendants, detaching them from their
    /// parent. The root cannot be removed. Returns whether anything was
    /// removed.
    pub fn remove(&mut self, id: NodeId) -> bool {
        if id == self.root || !self.nodes.contains_key(&id) {
            return false;
        }
        // Collect the subtree (BFS over children).
        let mut to_remove = Vec::new();
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            if let Some(n) = self.nodes.get(&cur) {
                stack.extend(n.children.iter().copied());
            }
            to_remove.push(cur);
        }
        // Detach from the parent's child list.
        if let Some(parent_id) = self.nodes.get(&id).and_then(|n| n.parent) {
            if let Some(parent) = self.nodes.get_mut(&parent_id) {
                parent.children.retain(|c| *c != id);
            }
        }
        for r in to_remove {
            self.nodes.remove(&r);
        }
        true
    }

    /// Update any combination of kind / style / props on a node; `None` leaves
    /// a field untouched. Returns `false` when the node does not exist.
    pub fn update(
        &mut self,
        id: NodeId,
        kind: Option<NodeKind>,
        style: Option<Style>,
        props: Option<PropMap>,
    ) -> bool {
        let Some(n) = self.nodes.get_mut(&id) else {
            return false;
        };
        if let Some(k) = kind {
            n.kind = k;
        }
        if let Some(s) = style {
            n.style = s;
        }
        if let Some(p) = props {
            n.props = p;
        }
        true
    }

    /// Replace a node's style. Returns `false` when the node does not exist.
    pub fn set_style(&mut self, id: NodeId, style: Style) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                n.style = style;
                true
            }
            None => false,
        }
    }

    /// Replace a node's kind. Returns `false` when the node does not exist.
    pub fn set_kind(&mut self, id: NodeId, kind: NodeKind) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                n.kind = kind;
                true
            }
            None => false,
        }
    }

    /// Replace a node's entire property map. Returns `false` when the node
    /// does not exist.
    pub fn set_props(&mut self, id: NodeId, props: PropMap) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                n.props = props;
                true
            }
            None => false,
        }
    }

    /// Set a single property on a node. Returns `false` when the node does
    /// not exist.
    pub fn set_prop(&mut self, id: NodeId, key: &str, value: PropValue) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                n.props.insert(key.to_string(), value);
                true
            }
            None => false,
        }
    }

    /// Read a property from a node.
    pub fn prop(&self, id: NodeId, key: &str) -> Option<&PropValue> {
        self.nodes.get(&id).and_then(|n| n.props.get(key))
    }

    /// Whether `id` is `ancestor` itself or a descendant of it.
    pub fn is_descendant(&self, id: NodeId, ancestor: NodeId) -> bool {
        if id == ancestor {
            return true;
        }
        let mut cur = id;
        while let Some(p) = self.nodes.get(&cur).and_then(|n| n.parent) {
            if p == ancestor {
                return true;
            }
            cur = p;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::Color;
    use crate::style::BorderStyle;

    #[test]
    fn scene_has_implicit_root() {
        let scene = Scene::new();
        let root = scene.root_id();
        let n = scene.node(root).unwrap();
        assert_eq!(n.kind, NodeKind::Root);
        assert!(n.children.is_empty());
        assert_eq!(n.parent, None);
        assert_eq!(scene.len(), 1);
        assert!(!scene.is_empty());
    }

    #[test]
    fn add_child_links_parent_and_children() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene
            .add_child(root, NodeKind::Text, Style::new().fg(Color::Rgb(1, 2, 3)))
            .unwrap();
        assert_ne!(a, b);
        assert_eq!(scene.node(a).unwrap().parent, Some(root));
        assert_eq!(scene.node(b).unwrap().style.fg, Color::Rgb(1, 2, 3));
        assert_eq!(scene.children(root).unwrap(), &[a, b]);

        // Nesting: c under a.
        let c = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.children(a).unwrap(), &[c]);
        assert!(scene.is_descendant(c, root));
        assert!(scene.is_descendant(c, a));
        assert!(!scene.is_descendant(b, a));
        assert_eq!(scene.len(), 4);
    }

    #[test]
    fn add_child_missing_parent_returns_none() {
        let mut scene = Scene::new();
        assert!(scene
            .add_child(NodeId(999), NodeKind::Box, Style::new())
            .is_none());
    }

    #[test]
    fn add_text_sets_text_prop() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "Hello", Style::new()).unwrap();
        assert_eq!(scene.node(t).unwrap().kind, NodeKind::Text);
        assert_eq!(
            scene.prop(t, "text"),
            Some(&PropValue::Str("Hello".to_string()))
        );
    }

    #[test]
    fn remove_leaf_detaches_from_parent() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();

        assert!(scene.remove(b));
        assert!(scene.node(b).is_none());
        assert_eq!(scene.children(root).unwrap(), &[a]);
        assert!(!scene.remove(b)); // already gone
        assert!(!scene.remove(root)); // root cannot be removed
        assert!(scene.node(root).is_some());
        assert!(scene.remove(a));
        assert!(scene.children(root).unwrap().is_empty());
    }

    #[test]
    fn remove_subtree_removes_descendants() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
        let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
        let d = scene.add_child(a, NodeKind::Text, Style::new()).unwrap();

        assert!(scene.remove(a));
        assert!(scene.node(a).is_none());
        assert!(scene.node(b).is_none());
        assert!(scene.node(c).is_none());
        assert!(scene.node(d).is_none());
        assert!(scene.children(root).unwrap().is_empty());
        assert_eq!(scene.len(), 1);
    }

    #[test]
    fn update_ops_change_kind_style_props() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "x", Style::new()).unwrap();

        assert!(scene.set_style(
            t,
            Style::new()
                .fg(Color::Indexed(9))
                .border_style(BorderStyle::Rounded)
        ));
        assert_eq!(scene.node(t).unwrap().style.fg, Color::Indexed(9));
        assert_eq!(
            scene.node(t).unwrap().style.border_style,
            BorderStyle::Rounded
        );

        assert!(scene.set_kind(t, NodeKind::Box));
        assert_eq!(scene.node(t).unwrap().kind, NodeKind::Box);

        assert!(scene.set_prop(t, "width", PropValue::Int(10)));
        assert_eq!(scene.prop(t, "width"), Some(&PropValue::Int(10)));

        let props = PropMap::from([("a".to_string(), PropValue::Bool(true))]);
        assert!(scene.update(
            t,
            None,
            Some(Style::new().bg(Color::Rgb(1, 2, 3))),
            Some(props)
        ));
        let n = scene.node(t).unwrap();
        assert_eq!(n.style.bg, Color::Rgb(1, 2, 3));
        assert_eq!(n.props.len(), 1);
        assert_eq!(n.props.get("a"), Some(&PropValue::Bool(true)));

        // Missing nodes are rejected.
        assert!(!scene.set_style(NodeId(4242), Style::new()));
        assert!(!scene.set_kind(NodeId(4242), NodeKind::Box));
        assert!(!scene.set_prop(NodeId(4242), "x", PropValue::Bool(true)));
        assert!(!scene.update(NodeId(4242), None, None, None));
        assert!(scene.prop(NodeId(4242), "x").is_none());
    }

    #[test]
    fn node_ids_are_unique() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let mut ids = vec![root];
        for _ in 0..100 {
            let id = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
            assert!(!ids.contains(&id));
            ids.push(id);
        }
    }
}
