//! Scene-tree reconciliation: building taffy nodes, the incremental subtree
//! walk, snapshot capture, and orphan removal.

use super::*;

/// Mirror `id` and its subtree into the taffy tree, recording the
/// tern-node-id -> taffy-node-id mapping. Returns `None` (skipping the node)
/// when the node is missing or `display: none`. Serves both the full rebuild
/// and the incremental path (new subtrees are built with exactly this code).
pub(super) fn build_node(
    scene: &Scene,
    id: NodeId,
    viewport: Size,
    is_root: bool,
    state: &mut EngineState<'_>,
) -> Option<TaffyNodeId> {
    let node = scene.node(id)?;

    // `display: none` hides the node and its whole subtree.
    if matches!(prop_str(&node.props, "display"), Some("none")) {
        return None;
    }

    let style = scene_node_style(scene, node, viewport, is_root);

    let children: Vec<TaffyNodeId> = visible_children(scene, node)
        .into_iter()
        .filter_map(|child| build_node(scene, child, viewport, false, state))
        .collect();

    let taffy_node = match node.kind {
        NodeKind::Text => {
            let t = if children.is_empty() {
                state.taffy.new_leaf(style).ok()?
            } else {
                state.taffy.new_with_children(style, &children).ok()?
            };
            if let Some(PropValue::Str(content)) = node.props.get("text") {
                state.text_map.insert(
                    t,
                    TextContent {
                        text: content.clone(),
                        wrap: prop_bool(&node.props, "wrap") != Some(false),
                    },
                );
            }
            t
        }
        NodeKind::StreamingText => {
            let t = if children.is_empty() {
                state.taffy.new_leaf(style).ok()?
            } else {
                state.taffy.new_with_children(style, &children).ok()?
            };
            // The compositor renders the node's accumulated stream; register
            // the concatenated span texts so the measure closure sizes the
            // leaf to its display width (same path as `text` content).
            let content: String = scene
                .stream(id)
                .map(|spans| spans.iter().map(|span| span.text.as_str()).collect())
                .unwrap_or_default();
            state.text_map.insert(
                t,
                TextContent {
                    text: content,
                    wrap: prop_bool(&node.props, "wrap") != Some(false),
                },
            );
            t
        }
        _ if children.is_empty() => state.taffy.new_leaf(style).ok()?,
        _ => state.taffy.new_with_children(style, &children).ok()?,
    };

    state.node_map.insert(id, taffy_node);
    Some(taffy_node)
}

/// The taffy style a node resolves to: its layout props translated by
/// [`props_to_style`], plus the two engine-side adjustments — the `wrap:
/// false` text/streaming leaf exemption from flex shrinking, and the root
/// filling the viewport when it declares no own size. Shared by
/// [`build_node`] and the incremental reconciler so the cached style always
/// matches what was built.
fn scene_node_style(_scene: &Scene, node: &SceneNode, viewport: Size, is_root: bool) -> TaffyStyle {
    let mut style = props_to_style(&node.props);

    // A `wrap: false` text/streaming leaf is a single intrinsic-width line —
    // it must never be re-flowed by layout, so it is exempt from flex
    // shrinking (the compositor trims overflow at paint time instead).
    // Wrapping leaves (wrap unset or `true`) may be constrained; layout sizes
    // them to their wrapped line count and the compositor soft-wraps them at
    // word boundaries.
    if matches!(node.kind, NodeKind::Text | NodeKind::StreamingText)
        && prop_bool(&node.props, "wrap") == Some(false)
    {
        style.flex_shrink = 0.0;
    }

    // The scene root fills the viewport unless it declares its own size.
    if is_root && !node.props.contains_key("width") && !node.props.contains_key("height") {
        style.size = TaffySize {
            width: Dimension::Length(viewport.width as f32),
            height: Dimension::Length(viewport.height as f32),
        };
    }
    style
}

/// The node's visible children: every child that is not `display: none`; for
/// `Text`/`StreamingText` leaves (which are taffy leaves), only the
/// absolutely-positioned children — mirroring [`build_node`]'s child
/// filtering exactly.
fn visible_children(scene: &Scene, node: &SceneNode) -> Vec<NodeId> {
    let is_leaf = matches!(node.kind, NodeKind::Text | NodeKind::StreamingText);
    node.children
        .iter()
        .filter(|&&child| {
            let Some(c) = scene.node(child) else {
                return false;
            };
            if matches!(prop_str(&c.props, "display"), Some("none")) {
                return false;
            }
            if is_leaf && prop_str(&c.props, "position") != Some("absolute") {
                return false;
            }
            true
        })
        .copied()
        .collect()
}

/// Reconcile the cached taffy tree against the current scene, walking it
/// pre-order and mutating only the nodes that changed. Returns `true` when a
/// full rebuild is required (a change class too complex to reconcile safely).
pub(super) fn reconcile(
    scene: &Scene,
    viewport: Size,
    state: &mut EngineState<'_>,
    counters: &mut ReconcileCounters,
) -> bool {
    let mut force_rebuild = false;
    walk(
        scene,
        scene.root_id(),
        viewport,
        state,
        counters,
        &mut force_rebuild,
    );
    force_rebuild
}

/// The pre-order reconciliation walk. Nodes that are hidden now (`display:
/// none`) have their whole cached subtree removed; visible nodes are
/// reconciled in place. The descent mirrors [`build_node`]'s child filter
/// ([`visible_children`]) exactly: a child a fresh build would not include —
/// a non-absolute child of a `Text`/`StreamingText` leaf, or a `display:
/// none` subtree — is never walked, so it can never be (re)built into the
/// cached tree at a stale zero size. The dropped-children removal in
/// [`reconcile_one`] is what evicts such nodes when they leave the layout.
fn walk(
    scene: &Scene,
    id: NodeId,
    viewport: Size,
    state: &mut EngineState<'_>,
    counters: &mut ReconcileCounters,
    force_rebuild: &mut bool,
) {
    let Some(node) = scene.node(id) else {
        return;
    };
    if matches!(prop_str(&node.props, "display"), Some("none")) {
        // Hidden now: the node and its whole subtree must leave the tree
        // (display:none subtrees are never built, so this only fires when the
        // node was visible at the previous frame — or for a hidden root).
        if state.node_map.contains_key(&id) {
            remove_subtree(scene, id, state, counters);
        }
        return;
    }
    if reconcile_one(scene, node, id, viewport, state, counters).is_none() {
        *force_rebuild = true;
        return;
    }
    for child in visible_children(scene, node) {
        walk(scene, child, viewport, state, counters, force_rebuild);
    }
}

/// Reconcile one visible node against its cached taffy node. Returns `None`
/// when the change cannot be reconciled safely (a conservative full rebuild
/// is required instead).
fn reconcile_one(
    scene: &Scene,
    node: &SceneNode,
    id: NodeId,
    viewport: Size,
    state: &mut EngineState<'_>,
    counters: &mut ReconcileCounters,
) -> Option<()> {
    let is_root = node.parent.is_none();
    let style = scene_node_style(scene, node, viewport, is_root);
    let content = match node.kind {
        NodeKind::Text => match node.props.get("text") {
            Some(PropValue::Str(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    };
    let wrap = match node.kind {
        NodeKind::Text | NodeKind::StreamingText => prop_bool(&node.props, "wrap"),
        _ => None,
    };
    let stream_sig = match node.kind {
        NodeKind::StreamingText => scene.stream(id).map(stream_signature),
        _ => None,
    };
    let children = visible_children(scene, node);

    let t = match state.node_map.get(&id).copied() {
        Some(t) => t,
        None => {
            // A brand-new subtree: build it exactly like a full rebuild would
            // (and snapshot it so the walk's later visits see it as current).
            let before = state.node_map.len();
            build_node(scene, id, viewport, is_root, state)?;
            counters.created += state.node_map.len() - before;
            snapshot_subtree(scene, id, viewport, state);
            return Some(());
        }
    };

    // node_map and snapshots are kept in lockstep; a missing snapshot is a
    // conservative full-rebuild signal.
    let prev = state.snapshots.get(&id)?;

    // A kind flip changes leaf/container semantics — rebuild conservatively.
    if prev.kind != node.kind {
        return None;
    }
    if prev.style != style {
        let _ = state.taffy.set_style(t, style.clone());
        counters.changed += 1;
    }
    if prev.content != content {
        match content.clone() {
            Some(c) => {
                state.text_map.insert(
                    t,
                    TextContent {
                        text: c,
                        wrap: wrap != Some(false),
                    },
                );
            }
            None => {
                state.text_map.remove(&t);
            }
        }
        let _ = state.taffy.mark_dirty(t);
        counters.changed += 1;
    }
    if prev.wrap != wrap {
        // A wrap-mode toggle re-sizes the leaf without touching its content:
        // refresh the stored wrap flag so the measure closure switches between
        // wrapped rows and the single intrinsic line (the `wrap: false`
        // flex-shrink exemption above also re-applies via the style change).
        if let Some(c) = state.text_map.get(&t).cloned() {
            state.text_map.insert(
                t,
                TextContent {
                    text: c.text,
                    wrap: wrap != Some(false),
                },
            );
        }
        let _ = state.taffy.mark_dirty(t);
        counters.changed += 1;
    }
    if prev.stream_sig != stream_sig {
        // Refresh the concatenated content so the measure closure sizes the
        // leaf to its new display width, then let taffy re-measure it.
        let c: String = scene
            .stream(id)
            .map(|spans| spans.iter().map(|span| span.text.as_str()).collect())
            .unwrap_or_default();
        state.text_map.insert(
            t,
            TextContent {
                text: c,
                wrap: wrap != Some(false),
            },
        );
        let _ = state.taffy.mark_dirty(t);
        counters.changed += 1;
    }
    if prev.children != children {
        // Count only the structural delta — the nodes added to or dropped
        // from the child list — so a small structural change stays well below
        // the full-rebuild threshold.
        counters.changed += symmetric_diff_len(&prev.children, &children);
        // Children that left the layout (a `display: none` toggle, or a
        // parent that became a `Text`/`StreamingText` leaf filtering out its
        // non-absolute children) must leave the cached tree: a fresh build
        // never contains them, so keeping them around would leave stale
        // zero-size nodes that diverge from the full layout.
        let dropped: Vec<NodeId> = prev
            .children
            .iter()
            .filter(|&&c| !children.contains(&c))
            .copied()
            .collect();
        if !dropped.is_empty() {
            for dropped in dropped {
                remove_subtree(scene, dropped, state, counters);
            }
            // `TaffyTree::remove` detaches the child from its parent's
            // children array WITHOUT invalidating the parent's layout cache,
            // and `reconcile_children` may then see the child list already
            // equal to the target and skip `set_children` — which would leave
            // the parent's stale (pre-removal) layout in taffy's cache and
            // diverge from a fresh build. Invalidate the parent explicitly so
            // the next layout pass recomputes it with the new child list.
            let _ = state.taffy.mark_dirty(t);
        }
        reconcile_children(scene, t, &children, viewport, state, counters);
    }
    state.snapshots.insert(
        id,
        NodeSnapshot {
            kind: node.kind,
            style,
            content,
            wrap,
            stream_sig,
            children,
        },
    );
    Some(())
}

/// Reconcile a node's taffy children list with its current visible children:
/// build any new child subtrees, then apply the new child list (taffy's
/// `set_children` re-parents moved children and marks the parent dirty).
fn reconcile_children(
    scene: &Scene,
    taffy_parent: TaffyNodeId,
    children: &[NodeId],
    viewport: Size,
    state: &mut EngineState<'_>,
    counters: &mut ReconcileCounters,
) {
    let mut taffy_children = Vec::with_capacity(children.len());
    for &child in children {
        match state.node_map.get(&child).copied() {
            Some(t) => taffy_children.push(t),
            None => {
                let before = state.node_map.len();
                if let Some(t) = build_node(scene, child, viewport, false, state) {
                    taffy_children.push(t);
                    counters.created += state.node_map.len() - before;
                    snapshot_subtree(scene, child, viewport, state);
                }
            }
        }
    }
    let current = state.taffy.children(taffy_parent).unwrap_or_default();
    if current != taffy_children {
        let _ = state.taffy.set_children(taffy_parent, &taffy_children);
    }
}

/// The number of ids that appear in exactly one of the two child lists (the
/// structural delta between two frames).
fn symmetric_diff_len(a: &[NodeId], b: &[NodeId]) -> usize {
    let set_b: HashSet<NodeId> = b.iter().copied().collect();
    let mut n = a.iter().filter(|id| !set_b.contains(id)).count();
    let set_a: HashSet<NodeId> = a.iter().copied().collect();
    n += b.iter().filter(|id| !set_a.contains(id)).count();
    n
}

/// Record snapshots for every visible node in the subtree rooted at `id` —
/// exactly the nodes [`build_node`] just built — so a walk that visits them
/// later sees them as up to date. The descent mirrors [`build_node`]'s child
/// filter: only the nodes the cached tree actually contains are snapshotted.
pub(super) fn snapshot_subtree(scene: &Scene, id: NodeId, viewport: Size, state: &mut EngineState<'_>) {
    let Some(node) = scene.node(id) else {
        return;
    };
    if matches!(prop_str(&node.props, "display"), Some("none")) {
        return; // display:none subtrees are never built
    }
    let is_root = node.parent.is_none();
    state.snapshots.insert(
        id,
        NodeSnapshot {
            kind: node.kind,
            style: scene_node_style(scene, node, viewport, is_root),
            content: match node.kind {
                NodeKind::Text => match node.props.get("text") {
                    Some(PropValue::Str(s)) => Some(s.clone()),
                    _ => None,
                },
                _ => None,
            },
            wrap: match node.kind {
                NodeKind::Text | NodeKind::StreamingText => prop_bool(&node.props, "wrap"),
                _ => None,
            },
            stream_sig: match node.kind {
                NodeKind::StreamingText => scene.stream(id).map(stream_signature),
                _ => None,
            },
            children: visible_children(scene, node),
        },
    );
    for child in visible_children(scene, node) {
        snapshot_subtree(scene, child, viewport, state);
    }
}

/// Remove `id` and every built descendant from the cached tree (a
/// `display: none` toggle hides the whole subtree).
fn remove_subtree(
    scene: &Scene,
    id: NodeId,
    state: &mut EngineState<'_>,
    counters: &mut ReconcileCounters,
) {
    let mut stack = vec![id];
    while let Some(cur) = stack.pop() {
        if let Some(t) = state.node_map.remove(&cur) {
            let _ = state.taffy.remove(t);
            state.text_map.remove(&t);
            state.snapshots.remove(&cur);
            counters.removed += 1;
        }
        if let Some(n) = scene.node(cur) {
            stack.extend(n.children.iter().copied());
        }
    }
}

/// All node ids currently in the scene (the orphan pass diffs the cached tree
/// against this set to drop removed nodes).
pub(super) fn collect_scene_ids(scene: &Scene) -> HashSet<NodeId> {
    let mut out = HashSet::new();
    let mut stack = vec![scene.root_id()];
    while let Some(id) = stack.pop() {
        if !out.insert(id) {
            continue;
        }
        if let Some(n) = scene.node(id) {
            stack.extend(n.children.iter().copied());
        }
    }
    out
}

/// A cheap change signature for a streaming leaf's content: the span count
/// and a hash of the last span's text + style. The scene API only appends
/// spans (no in-place stream mutation), so the length catches every append;
/// the last-span hash additionally catches in-place mutation of the final
/// span. This avoids copying the whole stream per frame.
fn stream_signature(spans: &[Span]) -> (usize, u64) {
    let len = spans.len();
    let hash = match spans.last() {
        Some(last) => {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            last.text.hash(&mut h);
            last.style.hash(&mut h);
            h.finish()
        }
        None => 0,
    };
    (len, hash)
}
