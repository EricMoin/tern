//! The scene tree: a node graph produced by the reconciler and consumed by
//! layout and the compositor.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use crate::rect::Rect;
use crate::semantics::SemanticsNode;
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
///
/// Every successful mutation bumps [`Scene::epoch`]. The epoch is the
/// renderer's change-detection signal: a renderer can skip repainting a
/// scene whose epoch is unchanged since its last paint. It starts at `0` and
/// only ever increases.
///
/// Alongside the epoch, every mutation pushes the id of the mutated node
/// (for `remove`, every id of the removed subtree) into a dirty set, and a
/// raw [`Scene::node_mut`] borrow additionally sets a force-full-scan flag
/// (the scene cannot introspect what the caller changes through the raw
/// borrow). The compositor consumes this hint per paint via
/// [`Scene::take_dirty`] to limit its per-frame paint-signature walk to the
/// mutated nodes instead of the whole tree. The hint is interior-mutable so
/// a renderer holding only `&Scene` can drain it.
///
/// One deliberate exception to "every mutation pushes a dirty id": the
/// semantics store (see the `semantics` field) bumps the epoch on real
/// writes but pushes nothing. Semantics is pure bookkeeping — it can never
/// change painted content — so its mutations must not widen the compositor's
/// paint-signature work. The compositor's dirty path treats an
/// empty-pushed-set / unchanged-rects frame as a no-op and returns the
/// retained frame unchanged.
#[derive(Debug)]
pub struct Scene {
    nodes: HashMap<NodeId, SceneNode>,
    root: NodeId,
    next_id: u64,
    /// Monotonic mutation counter: bumped by every successful tree change.
    /// Unchanged across reads and failed (no-op) mutations, so an unchanged
    /// [`Scene::epoch`] between two renders proves the scene was not mutated.
    epoch: u64,
    /// The ids of the nodes mutated since the last [`Scene::take_dirty`]
    /// drain: every epoch-bumping mutation records the id it changed, and a
    /// raw [`Scene::node_mut`] borrow records its id too. Drained (emptied)
    /// by [`Scene::take_dirty`], so between two drains it holds exactly the
    /// ids mutated in between. Interior-mutable so the compositor can drain
    /// it through an `&Scene`; the scene's own mutation methods never read it
    /// back.
    dirty: RefCell<HashSet<NodeId>>,
    /// Force-full-scan flag: set by [`Scene::node_mut`], whose raw borrow the
    /// scene cannot introspect. When set, the compositor falls back to the
    /// whole-tree paint-signature walk instead of the pushed set.
    force_full_scan: Cell<bool>,
    /// The parallel accessibility-semantics map: node id → [`SemanticsNode`]
    /// (see [`crate::semantics`]). Pure bookkeeping — layout and the
    /// compositor never read it, and no write to it ever pushes to the
    /// `dirty` set (semantics cannot change painted content). Writes are
    /// gated by [`Scene::semantics_enabled`].
    semantics: HashMap<NodeId, SemanticsNode>,
    /// Master switch for the semantics store. Off by default; while off,
    /// [`Scene::set_semantics`] rejects writes (returns `false`). Disabling
    /// does not wipe existing entries — it only gates future writes — so a
    /// later re-enable restores the stored tree as-is.
    semantics_enabled: bool,
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
            epoch: 0,
            dirty: RefCell::new(HashSet::new()),
            force_full_scan: Cell::new(false),
            semantics: HashMap::new(),
            semantics_enabled: false,
        }
    }

    /// The scene's mutation epoch: the number of successful tree mutations
    /// since construction. Read-only; bumped by every mutating method. Two
    /// reads that return the same value mean no mutation happened in between.
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The id of the implicit root node.
    pub const fn root_id(&self) -> NodeId {
        self.root
    }

    /// Drain the mutation-site pushed dirty set: the ids of the nodes mutated
    /// since the last drain, and whether a raw [`Scene::node_mut`] borrow
    /// forces a full paint-signature scan (the scene cannot introspect what
    /// the caller changed through the raw borrow).
    ///
    /// Draining resets the set and the flag, so a consumer that paints the
    /// scene sees exactly the mutations since the last drain. The compositor
    /// calls this on every paint (full and dirty) and uses the ids to limit
    /// its per-frame paint-signature comparison to the mutated nodes. This is
    /// a read of change-detection *hints*: it never affects the epoch, so the
    /// guarantee "epoch unchanged between reads ⇒ no mutation" stays sound.
    pub fn take_dirty(&self) -> (HashSet<NodeId>, bool) {
        let ids = std::mem::take(&mut *self.dirty.borrow_mut());
        let force = self.force_full_scan.replace(false);
        (ids, force)
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
    ///
    /// The borrow is raw, so the scene cannot know whether the caller mutates
    /// the node through it. To keep the change-detection guarantee ("epoch
    /// unchanged between renders ⇒ the scene was not mutated") sound, every
    /// call bumps the epoch conservatively: at worst one extra repaint, never
    /// a missed one. The same conservatism applies to the pushed dirty set:
    /// the id is recorded AND the force-full-scan flag is set, so the
    /// compositor falls back to the whole-tree paint-signature walk rather
    /// than trusting the pushed set to name the changed node.
    pub fn node_mut(&mut self, id: NodeId) -> Option<&mut SceneNode> {
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
        self.force_full_scan.set(true);
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
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
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
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
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
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
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
    /// the removal, so a streaming node's spans never outlive the node. The
    /// parallel semantics map is purged for every removed subtree id too —
    /// a semantics entry never outlives its scene node.
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
            // The parallel semantics map must not outlive its scene node:
            // purge the entry of every removed subtree id.
            self.semantics.remove(&r);
            // Every removed subtree id is pushed: the compositor must repaint
            // the OLD bounds of each (their new bounds are gone), so each is
            // a dirty node in its own right.
            self.dirty.borrow_mut().insert(r);
        }
        self.epoch += 1;
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
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
        true
    }

    /// Replace a node's style. Returns `false` when the node does not exist.
    ///
    /// An equal-value write (the incoming style equals the stored one) is a
    /// no-op: the style is not replaced and the scene epoch is not bumped,
    /// so a renderer's cached frame stays valid.
    pub fn set_style(&mut self, id: NodeId, style: Style) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                if n.style == style {
                    return true;
                }
                n.style = style;
                self.epoch += 1;
                self.dirty.borrow_mut().insert(id);
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
                self.epoch += 1;
                self.dirty.borrow_mut().insert(id);
                true
            }
            None => false,
        }
    }

    /// Replace a node's entire property map. Returns `false` when the node
    /// does not exist.
    ///
    /// An equal-value write (the incoming map equals the stored one) is a
    /// no-op: nothing is replaced and the scene epoch is not bumped, so a
    /// renderer's cached frame stays valid.
    pub fn set_props(&mut self, id: NodeId, props: PropMap) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                if n.props == props {
                    return true;
                }
                n.props = props;
                self.epoch += 1;
                self.dirty.borrow_mut().insert(id);
                true
            }
            None => false,
        }
    }

    /// Set a single property on a node. Returns `false` when the node does
    /// not exist.
    ///
    /// An equal-value write (the stored value already equals `value`) is a
    /// no-op: the prop is not re-inserted and the scene epoch is not bumped,
    /// so a renderer's cached frame stays valid.
    pub fn set_prop(&mut self, id: NodeId, key: &str, value: PropValue) -> bool {
        match self.nodes.get_mut(&id) {
            Some(n) => {
                if n.props.get(key) == Some(&value) {
                    return true;
                }
                n.props.insert(key.to_string(), value);
                self.epoch += 1;
                self.dirty.borrow_mut().insert(id);
                true
            }
            None => false,
        }
    }

    /// Read a property from a node.
    pub fn prop(&self, id: NodeId, key: &str) -> Option<&PropValue> {
        self.nodes.get(&id).and_then(|n| n.props.get(key))
    }

    /// Turn the semantics store on or off. Returns `true` when the flag
    /// actually changed (the epoch bumps), `false` when it already had the
    /// requested value (a no-op: nothing changes, no bump).
    ///
    /// Disabling does not wipe existing entries — it only gates future
    /// [`Scene::set_semantics`] writes — so a later re-enable restores the
    /// stored tree as-is.
    pub fn set_semantics_enabled(&mut self, enabled: bool) -> bool {
        if self.semantics_enabled == enabled {
            return false;
        }
        self.semantics_enabled = enabled;
        self.epoch += 1;
        true
    }

    /// Whether the semantics store accepts writes.
    pub const fn semantics_enabled(&self) -> bool {
        self.semantics_enabled
    }

    /// Set the accessibility semantics of a node. Returns `false` when the
    /// store is disabled (the default — call [`Scene::set_semantics_enabled`]
    /// first) or the node does not exist.
    ///
    /// An equal-value write (the incoming node equals the stored one) is a
    /// no-op: nothing is replaced and the epoch is not bumped — the same
    /// equal-write contract as [`Scene::set_prop`].
    ///
    /// A real write bumps the epoch but pushes no dirty id: the semantics
    /// store is pure bookkeeping and can never change painted content, so the
    /// compositor's dirty set stays untouched (see the `Scene` type docs).
    pub fn set_semantics(&mut self, id: NodeId, node: SemanticsNode) -> bool {
        if !self.semantics_enabled || !self.nodes.contains_key(&id) {
            return false;
        }
        if self.semantics.get(&id) == Some(&node) {
            return true;
        }
        self.semantics.insert(id, node);
        self.epoch += 1;
        true
    }

    /// Remove a node's semantics entry. Returns `true` when an entry existed
    /// and was removed (the epoch bumps); `false` when there was nothing to
    /// clear (a no-op: no bump). Not gated by the store's enable flag — it is
    /// a cleanup operation and removing a stale entry is always safe.
    pub fn clear_semantics(&mut self, id: NodeId) -> bool {
        if self.semantics.remove(&id).is_none() {
            return false;
        }
        self.epoch += 1;
        true
    }

    /// The semantics of a node, or `None` when the node has none. Reads are
    /// not gated by the store's enable flag: entries written while enabled
    /// stay readable after disabling.
    pub fn semantics(&self, id: NodeId) -> Option<&SemanticsNode> {
        self.semantics.get(&id)
    }

    /// Iterate over the populated semantics entries (node id → node), in
    /// arbitrary map order. Reads are not gated by the store's enable flag.
    pub fn semantics_iter(&self) -> impl Iterator<Item = (&NodeId, &SemanticsNode)> {
        self.semantics.iter()
    }

    /// The clip rect declared on a node via the `clip_x` / `clip_y` /
    /// `clip_width` / `clip_height` props (in scene coordinates), or `None`
    /// when any of the four is absent. When set, the compositor restricts
    /// drawing of the node's subtree to this rect.
    pub fn clip_rect(&self, id: NodeId) -> Option<Rect> {
        let x = self.int_prop(id, "clip_x")?;
        let y = self.int_prop(id, "clip_y")?;
        let width = self.int_prop(id, "clip_width")?;
        let height = self.int_prop(id, "clip_height")?;
        if width < 0 || height < 0 {
            return None;
        }
        Some(Rect::new(x as i32, y as i32, width as u32, height as u32))
    }

    /// Set a node's clip rect via the `clip_x` / `clip_y` / `clip_width` /
    /// `clip_height` props. Returns `false` when the node does not exist.
    pub fn set_clip_rect(&mut self, id: NodeId, clip: Rect) -> bool {
        let Some(n) = self.nodes.get_mut(&id) else {
            return false;
        };
        n.props
            .insert("clip_x".to_string(), PropValue::Int(clip.x as i64));
        n.props
            .insert("clip_y".to_string(), PropValue::Int(clip.y as i64));
        n.props
            .insert("clip_width".to_string(), PropValue::Int(clip.width as i64));
        n.props.insert(
            "clip_height".to_string(),
            PropValue::Int(clip.height as i64),
        );
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
        true
    }

    /// The scroll offset declared on a node via the `scroll_x` / `scroll_y`
    /// props (in cells), defaulting to `(0, 0)` when either is absent. The
    /// compositor shifts the node's content by this offset inside its clip
    /// rect.
    pub fn scroll_offset(&self, id: NodeId) -> (i32, i32) {
        (
            self.int_prop(id, "scroll_x").unwrap_or(0) as i32,
            self.int_prop(id, "scroll_y").unwrap_or(0) as i32,
        )
    }

    /// Set a node's scroll offset via the `scroll_x` / `scroll_y` props.
    /// Returns `false` when the node does not exist.
    pub fn set_scroll_offset(&mut self, id: NodeId, x: i32, y: i32) -> bool {
        let Some(n) = self.nodes.get_mut(&id) else {
            return false;
        };
        n.props
            .insert("scroll_x".to_string(), PropValue::Int(x as i64));
        n.props
            .insert("scroll_y".to_string(), PropValue::Int(y as i64));
        self.epoch += 1;
        self.dirty.borrow_mut().insert(id);
        true
    }

    /// Read an integer property from a node.
    fn int_prop(&self, id: NodeId, key: &str) -> Option<i64> {
        match self.prop(id, key) {
            Some(PropValue::Int(i)) => Some(*i),
            _ => None,
        }
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
    use crate::semantics::{SemanticsNode, SemanticsRole};
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

    #[test]
    fn clip_rect_defaults_to_none() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.clip_rect(b), None);
        assert_eq!(scene.clip_rect(NodeId(999)), None);
    }

    #[test]
    fn clip_rect_roundtrips_via_props() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert!(scene.set_clip_rect(b, Rect::new(2, 3, 10, 5)));
        assert_eq!(scene.clip_rect(b), Some(Rect::new(2, 3, 10, 5)));
        // Reading the raw props matches the setters.
        assert_eq!(scene.prop(b, "clip_x"), Some(&PropValue::Int(2)));
        assert_eq!(scene.prop(b, "clip_height"), Some(&PropValue::Int(5)));

        // Missing a node fails.
        assert!(!scene.set_clip_rect(NodeId(999), Rect::new(0, 0, 1, 1)));
    }

    #[test]
    fn clip_rect_rejects_negative_dimensions() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_prop(b, "clip_x", PropValue::Int(0));
        scene.set_prop(b, "clip_y", PropValue::Int(0));
        scene.set_prop(b, "clip_width", PropValue::Int(-4));
        scene.set_prop(b, "clip_height", PropValue::Int(2));
        assert_eq!(scene.clip_rect(b), None);
    }

    #[test]
    fn scroll_offset_defaults_and_roundtrips() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let b = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        assert_eq!(scene.scroll_offset(b), (0, 0));
        assert_eq!(scene.scroll_offset(NodeId(999)), (0, 0));

        assert!(scene.set_scroll_offset(b, 4, -2));
        assert_eq!(scene.scroll_offset(b), (4, -2));
        assert_eq!(scene.prop(b, "scroll_x"), Some(&PropValue::Int(4)));
        assert_eq!(scene.prop(b, "scroll_y"), Some(&PropValue::Int(-2)));

        assert!(!scene.set_scroll_offset(NodeId(999), 1, 1));
    }

    #[test]
    fn epoch_starts_at_zero_and_bumps_on_every_mutation() {
        let mut scene = Scene::new();
        assert_eq!(scene.epoch(), 0, "a fresh scene has epoch 0");
        let root = scene.root_id();
        let mut next = 0;
        let mut expect = |scene: &Scene, label: &str| {
            next += 1;
            assert_eq!(scene.epoch(), next, "{label} must bump the epoch");
        };

        let a = scene
            .add_child(root, NodeKind::Box, Style::new())
            .expect("add_child succeeds");
        expect(&scene, "add_child");

        let b = scene
            .insert_child(root, 0, NodeKind::Text, Style::new())
            .expect("insert_child succeeds");
        expect(&scene, "insert_child");

        scene.set_style(a, Style::new().fg(Color::Rgb(9, 9, 9)));
        expect(&scene, "set_style");

        scene.set_kind(a, NodeKind::Text);
        expect(&scene, "set_kind");

        scene.set_prop(a, "width", PropValue::Int(10));
        expect(&scene, "set_prop");

        scene.set_props(a, PropMap::new());
        expect(&scene, "set_props");

        scene.update(a, Some(NodeKind::Box), None, None);
        expect(&scene, "update");

        assert!(scene.set_clip_rect(a, Rect::new(0, 0, 4, 4)));
        expect(&scene, "set_clip_rect");

        assert!(scene.set_scroll_offset(a, 1, 1));
        expect(&scene, "set_scroll_offset");

        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .expect("add streaming node");
        expect(&scene, "add_child (streaming)");

        assert!(scene.append_span(
            s,
            Span {
                text: "x".to_string(),
                style: Style::new(),
            }
        ));
        expect(&scene, "append_span");

        assert!(scene.remove(b));
        expect(&scene, "remove");

        // `node_mut` hands out a raw borrow, so it bumps conservatively.
        let node = scene.node_mut(a).expect("node exists");
        node.props.insert("z".to_string(), PropValue::Int(1));
        expect(&scene, "node_mut");
    }

    #[test]
    fn epoch_does_not_bump_on_failed_operations() {
        // Failed (no-op) mutations must leave the epoch untouched: the scene
        // is provably unchanged, so a renderer's cached frame stays valid.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "x", Style::new()).unwrap();
        let epoch = scene.epoch();

        assert!(scene
            .add_child(NodeId(999), NodeKind::Box, Style::new())
            .is_none());
        assert!(scene
            .insert_child(NodeId(999), 0, NodeKind::Box, Style::new())
            .is_none());
        assert!(!scene.remove(root)); // root cannot be removed
        assert!(!scene.remove(NodeId(999)));
        assert!(!scene.set_style(NodeId(999), Style::new()));
        assert!(!scene.set_kind(NodeId(999), NodeKind::Box));
        assert!(!scene.set_prop(NodeId(999), "x", PropValue::Bool(true)));
        assert!(!scene.set_props(NodeId(999), PropMap::new()));
        assert!(!scene.update(NodeId(999), None, None, None));
        assert!(!scene.set_clip_rect(NodeId(999), Rect::new(0, 0, 1, 1)));
        assert!(!scene.set_scroll_offset(NodeId(999), 1, 1));
        assert!(!scene.append_span(
            NodeId(999),
            Span {
                text: "x".to_string(),
                style: Style::new(),
            }
        ));
        assert!(!scene.append_span(
            t, // a plain Text node: rejected, stream untouched
            Span {
                text: "x".to_string(),
                style: Style::new(),
            }
        ));

        assert_eq!(scene.epoch(), epoch, "no-op mutations must not bump");
    }

    #[test]
    fn equal_value_prop_writes_do_not_bump_epoch() {
        // The props incremental-sync contract: a write whose value equals the
        // stored one is a no-op — nothing is replaced, the epoch is not
        // bumped, and (downstream) layout is not marked dirty. Only a real
        // change may bump.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "x", Style::new()).unwrap();
        let epoch = scene.epoch();

        // Equal single-key writes: no bump.
        assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
        assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
        assert_eq!(scene.epoch(), epoch, "equal set_prop must not bump");

        // Equal whole-map writes: no bump.
        let props = PropMap::from([("text".to_string(), PropValue::Str("x".to_string()))]);
        assert!(scene.set_props(t, props.clone()));
        assert!(scene.set_props(t, props));
        assert_eq!(scene.epoch(), epoch, "equal set_props must not bump");

        // Equal style writes: no bump.
        assert!(scene.set_style(t, Style::new()));
        assert_eq!(scene.epoch(), epoch, "equal set_style must not bump");

        // A differing value still bumps (and stores).
        let before = scene.epoch();
        assert!(scene.set_prop(t, "text", PropValue::Str("y".to_string())));
        assert_eq!(scene.epoch(), before + 1, "changed set_prop must bump");
        assert_eq!(
            scene.prop(t, "text"),
            Some(&PropValue::Str("y".to_string()))
        );

        // A differing map still bumps (full-table replace semantics).
        let before = scene.epoch();
        assert!(scene.set_props(t, PropMap::from([("a".to_string(), PropValue::Int(1))])));
        assert_eq!(scene.epoch(), before + 1, "changed set_props must bump");
        assert!(
            scene.prop(t, "text").is_none(),
            "set_props replaces the map"
        );

        // A differing style still bumps.
        let before = scene.epoch();
        assert!(scene.set_style(t, Style::new().fg(Color::Rgb(1, 2, 3))));
        assert_eq!(scene.epoch(), before + 1, "changed set_style must bump");
        assert_eq!(scene.node(t).unwrap().style.fg, Color::Rgb(1, 2, 3));

        // Same-value writes after real changes still do not bump.
        let epoch = scene.epoch();
        assert!(scene.set_prop(t, "a", PropValue::Int(1)));
        assert!(scene.set_style(t, Style::new().fg(Color::Rgb(1, 2, 3))));
        assert_eq!(scene.epoch(), epoch, "re-equal writes must not bump");
    }

    #[test]
    fn take_dirty_drains_pushed_ids_and_force_flag() {
        // Every epoch-bumping mutation records the mutated id; a raw
        // `node_mut` borrow additionally sets the force-full-scan flag; a
        // drain resets both.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
        let s = scene
            .add_child(root, NodeKind::StreamingText, Style::new())
            .unwrap();

        scene.set_prop(b, "text", PropValue::Str("x".into()));
        scene.set_clip_rect(a, Rect::new(0, 0, 4, 4));
        scene.set_scroll_offset(a, 1, 1);
        assert!(scene.append_span(
            s,
            Span {
                text: "s".into(),
                style: Style::new(),
            }
        ));

        let (ids, force) = scene.take_dirty();
        assert!(
            ids.contains(&a),
            "set_clip_rect/set_scroll_offset record the id"
        );
        assert!(ids.contains(&b), "set_prop records the id");
        assert!(ids.contains(&s), "append_span records the id");
        assert!(!force, "API mutations do not force a full scan");

        // A raw borrow records its id and forces the full scan.
        let _ = scene.node_mut(a).unwrap();
        let (ids, force) = scene.take_dirty();
        assert!(ids.contains(&a), "node_mut records the id");
        assert!(force, "node_mut sets the force-full-scan flag");

        // Draining resets both: no mutations in between ⇒ empty drain.
        let (ids, force) = scene.take_dirty();
        assert!(
            ids.is_empty(),
            "a drain with no mutation in between is empty"
        );
        assert!(!force);
    }

    #[test]
    fn remove_records_every_subtree_id() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
        let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
        let _d = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();

        let (_, _) = scene.take_dirty(); // clear the add-time pushes
        assert!(scene.remove(a));
        let (ids, _) = scene.take_dirty();
        for id in [a, b, c] {
            assert!(
                ids.contains(&id),
                "removed subtree id {id:?} must be recorded so the compositor \
                 repaints its old bounds"
            );
        }
        assert!(
            !ids.contains(&root),
            "the root is never removed and must not be recorded"
        );
    }

    #[test]
    fn noop_mutations_do_not_record_dirty() {
        // Equal-value writes are no-ops: they neither bump the epoch nor push
        // the id (a spurious push would widen the next dirty pass for nothing).
        let mut scene = Scene::new();
        let root = scene.root_id();
        let t = scene.add_text(root, "x", Style::new()).unwrap();
        let (_, _) = scene.take_dirty(); // clear construction-time pushes

        assert!(scene.set_prop(t, "text", PropValue::Str("x".to_string())));
        assert!(scene.set_style(t, Style::new()));
        let props = PropMap::from([("text".to_string(), PropValue::Str("x".to_string()))]);
        assert!(scene.set_props(t, props));

        let (ids, force) = scene.take_dirty();
        assert!(
            ids.is_empty(),
            "no-op writes must not record ids (got {ids:?})"
        );
        assert!(!force);

        // A real change records.
        assert!(scene.set_prop(t, "text", PropValue::Str("y".to_string())));
        let (ids, _) = scene.take_dirty();
        assert!(ids.contains(&t), "a real change records the id");
    }

    // --- semantics store -------------------------------------------------

    fn checkbox_node(label: &str) -> SemanticsNode {
        let mut n = SemanticsNode::new(SemanticsRole::Checkbox);
        n.label = Some(label.to_string());
        n
    }

    #[test]
    fn semantics_store_is_off_by_default_and_rejects_writes() {
        // The store defaults to off: set_semantics fails (returning false),
        // reads stay empty, and no epoch/dirty state changes.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let (_, _) = scene.take_dirty(); // clear the add-child push
        let epoch = scene.epoch();

        assert!(!scene.semantics_enabled(), "the store starts disabled");
        assert!(!scene.set_semantics(a, checkbox_node("x")));
        assert_eq!(scene.semantics(a), None);
        assert_eq!(scene.semantics_iter().count(), 0);
        assert!(!scene.clear_semantics(a), "nothing to clear");

        assert_eq!(scene.epoch(), epoch, "rejected writes must not bump");
        let (ids, force) = scene.take_dirty();
        assert!(ids.is_empty() && !force, "rejected writes push nothing");
    }

    #[test]
    fn semantics_enable_then_set_get_roundtrip() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();

        // Enabling flips the flag and bumps the epoch exactly once.
        assert!(scene.set_semantics_enabled(true));
        assert!(scene.semantics_enabled());
        assert_eq!(scene.epoch(), 2, "enable bumps once (add_child bumped once)");

        let node = checkbox_node("mute");
        assert!(scene.set_semantics(a, node.clone()));
        assert_eq!(scene.semantics(a), Some(&node));
        assert_eq!(scene.semantics_iter().count(), 1);

        // Re-enabling to the same value is a no-op.
        assert!(!scene.set_semantics_enabled(true));
        assert_eq!(scene.epoch(), 3, "no-op enable must not bump");

        // The iterator yields the populated (id, node) pair.
        let entries: Vec<(NodeId, &SemanticsNode)> = scene
            .semantics_iter()
            .map(|(id, n)| (*id, n))
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, a);
        assert_eq!(entries[0].1, &node);
    }

    #[test]
    fn equal_value_semantics_write_is_noop() {
        // Mirroring set_prop: an equal-value write returns true (the value is
        // as requested) but neither bumps the epoch nor pushes a dirty id.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_semantics_enabled(true);

        let node = checkbox_node("mute");
        assert!(scene.set_semantics(a, node.clone()));
        let epoch = scene.epoch();

        assert!(scene.set_semantics(a, node.clone()));
        assert!(scene.set_semantics(a, checkbox_node("mute"))); // equal by value
        assert_eq!(scene.epoch(), epoch, "equal semantics writes must not bump");
        assert_eq!(scene.semantics(a), Some(&node));
    }

    #[test]
    fn real_semantics_write_bumps_epoch_but_never_dirty() {
        // A real semantics write bumps the epoch (the app-level change
        // signal) but must NOT push the node into the compositor's dirty set:
        // semantics is pure bookkeeping that cannot change painted content.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_semantics_enabled(true);
        let (_, _) = scene.take_dirty(); // clear add-time pushes

        assert!(scene.set_semantics(a, checkbox_node("mute")));
        let epoch = scene.epoch();
        let (ids, force) = scene.take_dirty();
        assert!(
            ids.is_empty(),
            "a semantics write must never push a dirty id (got {ids:?})"
        );
        assert!(!force);

        assert!(scene.set_semantics(a, checkbox_node("unmute")));
        assert_eq!(scene.epoch(), epoch + 1, "a real write bumps once");
        let (ids, _) = scene.take_dirty();
        assert!(ids.is_empty(), "still nothing pushed after a second write");
    }

    #[test]
    fn clear_semantics_removes_the_entry() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_semantics_enabled(true);
        assert!(scene.set_semantics(a, checkbox_node("mute")));

        let epoch = scene.epoch();
        assert!(scene.clear_semantics(a));
        assert_eq!(scene.epoch(), epoch + 1, "a real clear bumps once");
        assert_eq!(scene.semantics(a), None);
        assert_eq!(scene.semantics_iter().count(), 0);

        // Clearing an absent entry is a no-op.
        let epoch = scene.epoch();
        assert!(!scene.clear_semantics(a));
        assert!(!scene.clear_semantics(NodeId(999)));
        assert_eq!(scene.epoch(), epoch, "no-op clears must not bump");
    }

    #[test]
    fn set_semantics_rejects_missing_nodes() {
        let mut scene = Scene::new();
        scene.set_semantics_enabled(true);
        let epoch = scene.epoch();

        assert!(!scene.set_semantics(NodeId(999), checkbox_node("x")));
        assert_eq!(scene.epoch(), epoch, "missing-node writes must not bump");
        assert_eq!(scene.semantics(NodeId(999)), None);
    }

    #[test]
    fn remove_subtree_purges_semantics_of_every_removed_id() {
        // The parallel semantics map must never outlive its scene node:
        // removing a subtree drops the semantics of every id in it, while a
        // sibling outside the subtree keeps its entry.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        let b = scene.add_child(a, NodeKind::Box, Style::new()).unwrap();
        let c = scene.add_child(b, NodeKind::Text, Style::new()).unwrap();
        let d = scene.add_child(root, NodeKind::Text, Style::new()).unwrap();
        scene.set_semantics_enabled(true);
        for id in [a, b, c, d] {
            assert!(scene.set_semantics(id, checkbox_node("x")));
        }
        assert_eq!(scene.semantics_iter().count(), 4);

        assert!(scene.remove(a));
        for id in [a, b, c] {
            assert_eq!(scene.semantics(id), None, "removed id {id:?} keeps no semantics");
        }
        assert!(scene.semantics(d).is_some(), "a sibling outside the subtree keeps its entry");
        assert_eq!(scene.semantics_iter().count(), 1);

        // Removing the last semantics-carrying node empties the store.
        assert!(scene.remove(d));
        assert_eq!(scene.semantics_iter().count(), 0);
    }

    #[test]
    fn disable_gates_writes_but_preserves_entries() {
        // Disabling is a write-gate, not a wipe: existing entries stay
        // readable and re-enabling restores writability as-is.
        let mut scene = Scene::new();
        let root = scene.root_id();
        let a = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
        scene.set_semantics_enabled(true);
        let node = checkbox_node("mute");
        assert!(scene.set_semantics(a, node.clone()));

        assert!(scene.set_semantics_enabled(false));
        assert!(!scene.semantics_enabled());
        assert!(!scene.set_semantics(a, checkbox_node("other")));
        assert_eq!(scene.semantics(a), Some(&node), "the stored entry survives a disable");
        assert_eq!(scene.semantics_iter().count(), 1);

        assert!(scene.set_semantics_enabled(true));
        assert!(scene.set_semantics(a, checkbox_node("other")));
        assert_eq!(scene.semantics(a).unwrap().label.as_deref(), Some("other"));
    }
}
