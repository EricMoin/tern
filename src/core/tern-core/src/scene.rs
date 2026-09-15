//! The scene tree: a node graph produced by the reconciler and consumed by
//! layout and the compositor.


use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use crate::rect::Rect;
use crate::semantics::SemanticsNode;
use crate::style::Style;

// The Scene API stays in this file; the test module moved to
// scene/tests.rs (split into parts) to keep every file under the cap.

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
mod tests;
