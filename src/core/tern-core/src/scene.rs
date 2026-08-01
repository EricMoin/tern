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
    /// A leaf that renders incrementally appended styled spans (its `stream`).
    StreamingText,
}

/// A styled chunk of streaming text. The compositor concatenates the spans of
/// a [`SceneNode`]'s stream in order to render the node's content.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Span {
    /// The chunk's text content.
    pub text: String,
    /// The style applied to this chunk.
    pub style: Style,
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
    /// Incrementally appended spans for [`NodeKind::StreamingText`] nodes;
    /// `None` for every other node kind.
    pub stream: Option<Vec<Span>>,
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
                stream: None,
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
                stream: None,
            },
        );
        self.nodes
            .get_mut(&parent)
            .expect("parent existence checked above")
            .children
            .push(id);
        Some(id)
    }

    /// Insert a new child of `kind` under `parent` at `index` in the parent's
    /// ordered children list. Returns the new node's id, or `None` when
    /// `parent` does not exist or the insertion would violate the scene's root
    /// invariants (a `NodeKind::Root` node can never be inserted — the scene's
    /// single root is implicit and is never a child of anything).
    ///
    /// `index` is clamped to the children list length: `index == len` appends,
    /// and any `index > len` is treated as an append as well.
    pub fn insert_child(
        &mut self,
        parent: NodeId,
        index: usize,
        kind: NodeKind,
        style: Style,
    ) -> Option<NodeId> {
        if !self.nodes.contains_key(&parent) {
            return None;
        }
        if kind == NodeKind::Root {
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
                stream: None,
            },
        );
        let children = &mut self
            .nodes
            .get_mut(&parent)
            .expect("parent existence checked above")
            .children;
        let index = index.min(children.len());
        children.insert(index, id);
        Some(id)
    }

    /// Add a Text leaf with its `text` prop pre-populated.
    pub fn add_text(&mut self, parent: NodeId, content: &str, style: Style) -> Option<NodeId> {
        let id = self.add_child(parent, NodeKind::Text, style)?;
        self.set_prop(id, "text", PropValue::Str(content.to_string()));
        Some(id)
    }

    /// Append a styled span to a [`NodeKind::StreamingText`] node's stream.
    ///
    /// Creates the stream when the node has none yet. Returns `false` when the
    /// node does not exist or is not a `StreamingText` node.
    pub fn append_span(&mut self, id: NodeId, span: Span) -> bool {
        let Some(n) = self.nodes.get_mut(&id) else {
            return false;
        };
        if n.kind != NodeKind::StreamingText {
            return false;
        }
        n.stream.get_or_insert_with(Vec::new).push(span);
        true
    }

    /// The stream of a node, or `None` when the node does not exist or is not
    /// streaming (`stream` is only ever populated for `StreamingText` nodes).
    pub fn stream(&self, id: NodeId) -> Option<&[Span]> {
        self.nodes.get(&id).and_then(|n| n.stream.as_deref())
    }

    /// Remove `id` and all of its descendants, detaching them from their
    /// parent. The root cannot be removed. Returns whether anything was
    /// removed.
    ///
    /// Each removed node (including any `stream` it carries) is dropped with
    /// the removal, so a streaming node's spans never outlive the node.
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
    use crate::style::{BorderStyle, Modifiers};

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
    fn insert_child_at_head_middle_and_tail() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let c = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.children(root).unwrap(), &[a, b, c]);

        // Head: index 0.
        let h = scene
            .insert_child(root, 0, NodeKind::Text, Style::new())
            .unwrap();
        assert_eq!(scene.children(root).unwrap(), &[h, a, b, c]);

        // Tail: index == len appends.
        let t = scene
            .insert_child(root, 4, NodeKind::Text, Style::new())
            .unwrap();
        assert_eq!(scene.children(root).unwrap(), &[h, a, b, c, t]);

        // Middle: index 2 in a 5-child list.
        let m = scene
            .insert_child(root, 2, NodeKind::Text, Style::new())
            .unwrap();
        assert_eq!(scene.children(root).unwrap(), &[h, a, m, b, c, t]);

        // Parent/child links stay consistent for every node.
        for id in [h, a, m, b, c, t] {
            assert_eq!(scene.node(id).unwrap().parent, Some(root));
        }
        assert_eq!(scene.len(), 7); // root + 6 children
    }

    #[test]
    fn insert_child_clamps_index_beyond_len() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.children(root).unwrap(), &[a, b]);

        // index > len clamps to len, i.e. appends.
        let t = scene
            .insert_child(root, 10, NodeKind::Text, Style::new())
            .unwrap();
        assert_eq!(scene.children(root).unwrap(), &[a, b, t]);
    }

    #[test]
    fn insert_child_after_remove_fills_the_gap() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let c = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.children(root).unwrap(), &[a, b, c]);

        assert!(scene.remove(b));
        assert_eq!(scene.children(root).unwrap(), &[a, c]);

        // Re-insert at the position b used to occupy.
        let b2 = scene
            .insert_child(root, 1, NodeKind::Box, Style::new())
            .unwrap();
        assert_eq!(scene.children(root).unwrap(), &[a, b2, c]);
        assert_eq!(scene.node(b2).unwrap().parent, Some(root));
        assert_ne!(b2, b); // fresh id, not a resurrection
    }

    #[test]
    fn insert_child_missing_parent_returns_none() {
        let mut scene = Scene::new();
        assert!(scene
            .insert_child(NodeId(999), 0, NodeKind::Box, Style::new())
            .is_none());
        assert_eq!(scene.len(), 1); // nothing inserted
    }

    #[test]
    fn root_can_never_be_inserted_into_children() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();

        // A Root-kind node can never be inserted under any parent, including
        // the root itself: the scene's single root is implicit and is never a
        // child of anything.
        assert!(scene
            .insert_child(a, 0, NodeKind::Root, Style::new())
            .is_none());
        assert!(scene
            .insert_child(root, 0, NodeKind::Root, Style::new())
            .is_none());
        assert_eq!(scene.children(root).unwrap(), &[a]);
        assert_eq!(scene.len(), 2); // nothing inserted
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

    #[test]
    fn append_span_accumulates_in_order() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .unwrap();

        assert!(scene.append_span(
            s,
            Span {
                text: "Hel".to_string(),
                style: Style::new(),
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "lo".to_string(),
                style: Style::new(),
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "!".to_string(),
                style: Style::new(),
            }
        ));

        let stream = scene.stream(s).unwrap();
        let texts: Vec<&str> = stream.iter().map(|sp| sp.text.as_str()).collect();
        assert_eq!(texts, ["Hel", "lo", "!"]);
    }

    #[test]
    fn append_span_preserves_per_span_styles() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .unwrap();

        let red = Style::new().fg(Color::Rgb(255, 0, 0));
        let bold = Style::new().add_modifier(Modifiers::BOLD);
        assert!(scene.append_span(
            s,
            Span {
                text: "red".to_string(),
                style: red,
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "bold".to_string(),
                style: bold,
            }
        ));

        let stream = scene.stream(s).unwrap();
        assert_eq!(stream[0].style.fg, Color::Rgb(255, 0, 0));
        assert!(!stream[0].style.modifiers.contains(Modifiers::BOLD));
        assert!(stream[1].style.modifiers.contains(Modifiers::BOLD));
        assert_eq!(stream[1].style.fg, Color::Default);
    }

    #[test]
    fn append_span_keeps_multi_width_chars_intact() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .unwrap();

        // U+30B3 (コ) is a double-width CJK character.
        assert!(scene.append_span(
            s,
            Span {
                text: "コ".to_string(),
                style: Style::new(),
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "abc".to_string(),
                style: Style::new(),
            }
        ));

        let stream = scene.stream(s).unwrap();
        assert_eq!(stream.len(), 2);
        assert_eq!(stream[0].text, "コ");
        assert_eq!(stream[1].text, "abc");
    }

    #[test]
    fn append_span_rejects_missing_and_non_streaming_nodes() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "plain", Style::new()).unwrap();

        let span = Span {
            text: "x".to_string(),
            style: Style::new(),
        };
        assert!(!scene.append_span(NodeId(999), span.clone()));
        assert!(!scene.append_span(t, span.clone()));
        assert!(scene.stream(NodeId(999)).is_none());
        assert!(scene.stream(t).is_none());
    }

    #[test]
    fn remove_detaches_node_and_its_stream() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .unwrap();
        assert!(scene.append_span(
            s,
            Span {
                text: "gone".to_string(),
                style: Style::new(),
            }
        ));
        assert_eq!(scene.stream(s).unwrap().len(), 1);

        assert!(scene.remove(s));
        assert!(scene.node(s).is_none());
        assert!(scene.stream(s).is_none());
        assert!(scene.children(root).unwrap().is_empty());
    }
}
