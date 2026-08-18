//! Paint-order collection and per-node paint-change signatures.

use super::*;

/// Collect every laid-out node in the subtree rooted at `id` into `out`, in
/// pre-order (parent before children). Nodes without geometry (e.g.
/// `display: none`) are skipped.
pub(super) fn collect_paint_order(
    scene: &Scene,
    id: NodeId,
    rects: &HashMap<NodeId, Rect>,
    out: &mut Vec<NodeId>,
) {
    let Some(node) = scene.node(id) else {
        return;
    };
    if rects.contains_key(&id) {
        out.push(id);
    }
    for &child in &node.children {
        collect_paint_order(scene, child, rects, out);
    }
}

/// The effective paint z-index of a node: its `z_index` integer prop, or 0
/// when unset. Higher values paint later (on top).
pub(super) fn z_index(scene: &Scene, id: NodeId) -> i32 {
    match scene.prop(id, "z_index") {
        Some(PropValue::Int(i)) => *i as i32,
        _ => 0,
    }
}

/// Per-node paint signatures for every node with geometry this frame — the
/// whole-tree walk, used by [`Compositor::paint_full`] and as the
/// force-full-scan fallback of [`Compositor::paint_dirty`].
pub(super) fn collect_paint_sigs(scene: &Scene, rects: &HashMap<NodeId, Rect>) -> HashMap<NodeId, PaintSig> {
    let mut sigs = HashMap::new();
    let mut stack = vec![scene.root_id()];
    while let Some(id) = stack.pop() {
        if rects.contains_key(&id) {
            if let Some(sig) = paint_sig_of(scene, id) {
                sigs.insert(id, sig);
            }
        }
        if let Some(node) = scene.node(id) {
            stack.extend(node.children.iter().copied());
        }
    }
    sigs
}

/// Per-node paint signatures for exactly the given ids (each with geometry
/// this frame). The pushed-id counterpart of [`collect_paint_sigs`]: O(|ids|)
/// instead of O(nodes). The mutation-site pushed dirty set
/// ([`Scene::take_dirty`]) names precisely the nodes that could have changed
/// since the last drain, so their signatures are the only ones that need
/// re-collecting and comparing.
pub(super) fn collect_paint_sigs_for(
    scene: &Scene,
    rects: &HashMap<NodeId, Rect>,
    ids: &HashSet<NodeId>,
) -> HashMap<NodeId, PaintSig> {
    let mut sigs = HashMap::new();
    for &id in ids {
        if rects.contains_key(&id) {
            if let Some(sig) = paint_sig_of(scene, id) {
                sigs.insert(id, sig);
            }
        }
    }
    sigs
}

/// The paint-relevant state of a node: everything that can change what its
/// painted cells look like.
pub(super) fn paint_sig_of(scene: &Scene, id: NodeId) -> Option<PaintSig> {
    let node = scene.node(id)?;
    let stream = if matches!(node.kind, NodeKind::StreamingText) {
        scene.stream(id).map(stream_paint_signature)
    } else {
        None
    };
    Some(PaintSig {
        style: node.style,
        display_none: matches!(prop_str_scene(scene, id, "display"), Some("none")),
        text: match node.props.get("text") {
            Some(PropValue::Str(s)) => Some(s.clone()),
            _ => None,
        },
        caret: match node.props.get("caret") {
            Some(PropValue::Int(i)) => Some(*i),
            _ => None,
        },
        clip: scene.clip_rect(id),
        scroll: scene.scroll_offset(id),
        z_index: z_index(scene, id),
        wrap: match node.props.get("wrap") {
            Some(PropValue::Bool(b)) => Some(*b),
            _ => None,
        },
        status_bar: matches!(node.props.get("status_bar"), Some(PropValue::Bool(true))),
        stream,
    })
}

/// Read a string property from a scene node (local helper so the paint
/// signature does not borrow the node past the map access).
pub(super) fn prop_str_scene<'a>(scene: &'a Scene, id: NodeId, key: &str) -> Option<&'a str> {
    match scene.prop(id, key) {
        Some(PropValue::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// A cheap change signature for a streaming leaf's content: the span count
/// and a hash of the last span's text + style. The scene API only appends
/// spans (no in-place stream mutation), so the length catches every append;
/// the last-span hash additionally catches in-place mutation of the final
/// span — without copying the whole stream each frame.
pub(super) fn stream_paint_signature(spans: &[Span]) -> (usize, u64) {
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
