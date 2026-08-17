//! tern-layout — layout engine for the tern TUI renderer.
//!
//! Implements [`LayoutEngine`] by wrapping taffy 0.7 ([`TaffyTree<()>`]): the
//! scene tree is mirrored into a taffy tree, laid out against the viewport,
//! and each taffy [`Layout`] is mapped back to a tern-core [`Rect`].
//!
//! The engine is stateful and incremental: the cached taffy tree is mutated
//! in place across frames (see [`TaffyLayoutEngine`] for the reconciliation
//! scheme and its conservative full-rebuild fallback), so a single-cell text
//! change re-measures one leaf instead of rebuilding the whole tree.
//!
//! Layout keywords are carried on the scene node's `props` map (tern-core's
//! own [`Style`](tern_core::style::Style) is cell styling only):
//!
//! | prop              | values                                                              | default |
//! |-------------------|---------------------------------------------------------------------|---------|
//! | `display`         | `Str("flex")` \| `Str("none")`                                      | `"flex"`|
//! | `flex_direction`  | `Str("row"\|"column"\|"row-reverse"\|"column-reverse")`              | `"row"` |
//! | `justify_content` | `Str("flex-start"\|"flex-end"\|"center"\|"space-between"\|"space-around"\|"space-evenly")` | unset |
//! | `align_items`     | `Str("flex-start"\|"flex-end"\|"center"\|"stretch"\|"baseline")`     | unset (stretch) |
//! | `align_content`   | `Str("flex-start"\|"flex-end"\|"center"\|"stretch"\|"space-between"\|"space-around"\|"space-evenly")` | unset (stretch) |
//! | `gap`             | `Int` \| `Float` (cells, uniform on both axes)                       | 0      |
//! | `row_gap` / `column_gap` | `Int` \| `Float` (cells; per-axis override of `gap`)          | `gap` / 0 |
//! | `margin`          | `Int` \| `Float` (cells, uniform on all four sides)                  | 0      |
//! | `margin_x` / `margin_y` | `Int` \| `Float` (cells; per-axis override of `margin`)        | `margin` / 0 |
//! | `margin_top` / `margin_right` / `margin_bottom` / `margin_left` | `Int` \| `Float` (cells; per-side override of the axis/uniform margin) | `margin_x` / `margin_y` / `margin` / 0 |
//! | `padding`         | `Int` \| `Float` (cells, uniform)                                    | 0      |
//! | `padding_x` / `padding_y` | `Int` \| `Float` (cells; per-axis override of `padding`)      | `padding` / 0 |
//! | `padding_top` / `padding_right` / `padding_bottom` / `padding_left` | `Int` \| `Float` (cells; per-side override of the axis/uniform padding) | `padding_x` / `padding_y` / `padding` / 0 |
//! | `border`          | `Int` \| `Float` (cells, uniform border width)                       | 0      |
//! | `width` / `height`| `Int` \| `Float` (cells) \| `Str("N%")` (percent of the containing block's size) | auto   |
//! | `min_width` / `min_height` | `Int` \| `Float` (cells) \| `Str("N%")` (percent of the containing block's size) | auto   |
//! | `max_width` / `max_height` | `Int` \| `Float` (cells) \| `Str("N%")` (percent of the containing block's size) | auto   |
//! | `flex_basis`      | `Int` \| `Float` (cells) — the item's initial main-axis size; flex grow/shrink resolves from it | auto   |
//! | `position`        | `Str("relative"\|"absolute")`                                       | `"relative"` |
//! | `top` / `right` / `bottom` / `left` | `Int` \| `Float` (cells, inset edges)                       | auto   |
//! | `text`            | `Str` — content of a `Text` leaf                                     | —      |
//! | `z_index`         | `Int` — paint order; consumed by the compositor, not the engine      | 0      |
//! | `clip_x` / `clip_y` / `clip_width` / `clip_height` | `Int` (cells) — a clip rect restricting the node's subtree drawing to a bounded region; consumed by the compositor | unset (no clip) |
//! | `scroll_x` / `scroll_y` | `Int` (cells) — per-region scroll offset shifting content inside the clip rect; consumed by the compositor | 0 |
//! | `wrap`               | `Bool` — text/streaming leaf wrapping; `false` keeps the line single-row (intrinsic width, no flex shrink) and the compositor trims overflow at the right edge; `true`/unset soft-wraps at word boundaries and the leaf is sized to its wrapped line count at the constrained width (`\n` forces row breaks) | `true` |
//!
//! ## Clip and scroll regions
//!
//! A node that declares a clip rect (all four `clip_*` props) restricts every
//! cell its subtree draws to that rectangle, in scene coordinates. A node
//! with a scroll offset shifts its subtree's content by that offset *inside*
//! the region: with `scroll_y = 2`, the content that would render at row 2
//! renders at row 0 of the region, and rows 0-1 scroll out of view. Clip and
//! scroll are honored at paint time by the compositor (tern-components), so a
//! scrollable pane is a box sized to its viewport plus `clip_*` and
//! `scroll_*` props, with overflowing content as its children. They do not
//! affect the geometry taffy computes: content still lays out at its natural
//! size and is simply clipped/panned when painted.
//!
//! Nodes with `display: none` (and their whole subtree) are skipped: they get
//! no taffy node and are absent from the returned [`Rect`] list.
//!
//! The scene root fills the viewport unless it declares its own size.
//!
//! ## Absolute positioning
//!
//! `position: absolute` removes the node from flex flow (it occupies no space
//! and does not push siblings). In taffy 0.7.7 an absolute child is laid out
//! against its **direct parent's padding box** (the parent's border box minus
//! its border): each `top`/`right`/`bottom`/`left` inset is measured from the
//! padding-box origin, i.e. `parent origin + border + inset`. taffy 0.7.7 does
//! not walk up the tree to find a "positioned ancestor" — the direct parent
//! always hosts the absolute child.
//!
//! ## `align_content` and single-line containers
//!
//! `align_content` maps through to taffy's `Style.align_content` (it shifts
//! whole flex lines on the cross axis), but tern never produces more than one
//! flex line — there is no `flex_wrap` prop. For a single-line container
//! taffy 0.7.7 sizes the sole line to the container's inner cross size (CSS
//! flexbox algorithm step 8, `calculate_cross_size` in
//! `taffy/src/compute/flexbox.rs`), leaving zero free cross space, so
//! `align_content` has no visible effect. The mapping is still wired through
//! so the prop takes effect the moment multi-line wrapping is added.

use std::collections::{HashMap, HashSet};

use taffy::geometry::{Rect as TaffyRect, Size as TaffySize};
use taffy::style::{
    AlignContent, AlignItems, AvailableSpace, Dimension, Display, FlexDirection, JustifyContent,
    LengthPercentage, LengthPercentageAuto, Position, Style as TaffyStyle,
};
use taffy::tree::{Layout as TaffyLayout, NodeId as TaffyNodeId, TaffyTree};

use tern_core::cell::{clusters, strip_escapes};
use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene, SceneNode, Span};

/// The tern layout engine: a thin wrapper over taffy 0.7.
///
/// Stateful and incremental: the engine owns the taffy tree, the
/// tern-node-id -> taffy-node-id map, and a per-node snapshot of the last
/// layout-relevant state. Across [`compute`](LayoutEngine::compute) calls the
/// tree is mutated in place — styles set, content refreshed, child lists
/// reconciled — instead of being torn down and rebuilt, and taffy's own
/// per-node cache skips the subtrees that did not change. A single-cell text
/// change therefore re-measures one leaf and re-runs its ancestors' flex pass
/// — never a full-tree rebuild.
///
/// Change detection is engine-side (the scene only carries a global mutation
/// epoch, no per-node revision): every frame the scene is walked and each
/// node's [`NodeSnapshot`] — kind, resolved taffy style, text/stream content
/// signature, visible children — is compared against the previous one. Only
/// differing nodes are reconciled onto the cached tree. taffy 0.7's
/// `mark_dirty` (called by `set_style` and friends, and by this engine for
/// content changes) marks the node and all its ancestors, so the layout pass
/// re-solves exactly the affected path while clean sibling subtrees are
/// served from cache.
///
/// Correctness over performance: any change class that cannot be reconciled
/// safely — a node kind flip, or a frame touching more than half the tree —
/// falls back to a full rebuild (clear + rebuild from the scene), which
/// produces byte-identical rects to the previous stateless engine.
///
/// Instrumentation: [`full_rebuilds`](TaffyLayoutEngine::full_rebuilds),
/// [`last_reconciled_node_count`](TaffyLayoutEngine::last_reconciled_node_count)
/// and [`last_was_full_rebuild`](TaffyLayoutEngine::last_was_full_rebuild)
/// expose how incremental each frame was, so tests can prove a single-cell
/// text change performs no full-tree relayout.
#[derive(Debug, Clone, Default)]
pub struct TaffyLayoutEngine {
    /// The cached taffy tree, mutated incrementally across frames.
    taffy: TaffyTree<()>,
    /// tern node id -> taffy node id, for every node currently in the tree.
    node_map: HashMap<NodeId, TaffyNodeId>,
    /// taffy node id -> measure input (a text leaf's `text` or a streaming
    /// leaf's concatenated spans, plus whether the leaf soft-wraps), consumed
    /// by the measure closure.
    text_map: HashMap<TaffyNodeId, TextContent>,
    /// tern node id -> the layout-relevant state seen at the last compute.
    snapshots: HashMap<NodeId, NodeSnapshot>,
    /// The viewport the last layout ran at.
    last_viewport: Option<Size>,
    /// The scene epoch at the last compute. A lower epoch means a different
    /// (fresh) scene instance, which forces a full rebuild.
    last_epoch: u64,
    /// Instrumentation: number of full tree rebuilds since construction.
    full_rebuilds: u64,
    /// Instrumentation: nodes touched by the last incremental reconciliation.
    last_reconciled_node_count: usize,
    /// Instrumentation: whether the last compute was a full rebuild.
    last_was_full_rebuild: bool,
}

/// The measure input of a text/streaming leaf: its display content and
/// whether it soft-wraps. Kept in the [`TaffyLayoutEngine::text_map`] so the
/// measure closure can size a wrap-enabled leaf to its wrapped line count at
/// the constrained width (and keep `wrap: false` leaves at their single
/// intrinsic line).
#[derive(Debug, Clone, PartialEq)]
struct TextContent {
    /// The display content (a `Text` leaf's `text`, or a `StreamingText`
    /// leaf's concatenated span texts).
    text: String,
    /// Whether the leaf soft-wraps: `wrap: false` keeps the single intrinsic
    /// line; absent or `wrap: true` wraps at word boundaries (mirroring the
    /// compositor's [`wrap_enabled`](tern_components) rule).
    wrap: bool,
}

/// The layout-relevant state of a scene node, snapshotted per frame for
/// change detection. Kept in lockstep with [`TaffyLayoutEngine::node_map`]:
/// exactly the visible (non-`display: none`) nodes carry a snapshot.
#[derive(Debug, Clone, PartialEq)]
struct NodeSnapshot {
    /// The node kind; a flip changes leaf/container semantics and forces a
    /// conservative full rebuild.
    kind: NodeKind,
    /// The resolved taffy style (including the root viewport fill and the
    /// `wrap: false` flex-shrink exemption).
    style: TaffyStyle,
    /// The `text` prop of a `Text` leaf (its measurement input).
    content: Option<String>,
    /// The `wrap` prop of a `Text`/`StreamingText` leaf (its wrap mode).
    wrap: Option<bool>,
    /// A cheap signature of a streaming leaf's content: `(span count, hash of
    /// the last span)`. Streams only grow via append in this codebase, so a
    /// length change catches every append; the last-span hash additionally
    /// catches in-place mutation of the final span — without copying the whole
    /// stream every frame.
    stream_sig: Option<(usize, u64)>,
    /// The node's visible children (display:none excluded; text/streaming
    /// leaves keep only their absolutely-positioned children) — mirrors
    /// [`build_node`]'s child filtering exactly.
    children: Vec<NodeId>,
}

/// The mutable subset of the engine handed to the reconciliation helpers, so
/// the recursive walks can borrow disjoint fields of the engine at once.
struct EngineState<'a> {
    taffy: &'a mut TaffyTree<()>,
    node_map: &'a mut HashMap<NodeId, TaffyNodeId>,
    text_map: &'a mut HashMap<TaffyNodeId, TextContent>,
    snapshots: &'a mut HashMap<NodeId, NodeSnapshot>,
}

/// Per-frame reconciliation counters (the input to the instrumentation).
#[derive(Debug, Clone, Copy, Default)]
struct ReconcileCounters {
    /// Nodes whose style/content/children were reconciled in place.
    changed: usize,
    /// Nodes (re)built from scratch (new subtrees).
    created: usize,
    /// Nodes removed from the cached tree.
    removed: usize,
}

impl ReconcileCounters {
    fn total(self) -> usize {
        self.changed + self.created + self.removed
    }
}

impl TaffyLayoutEngine {
    /// Create a new layout engine with an empty cached tree.
    pub fn new() -> Self {
        Self {
            taffy: TaffyTree::new(),
            node_map: HashMap::new(),
            text_map: HashMap::new(),
            snapshots: HashMap::new(),
            last_viewport: None,
            last_epoch: 0,
            full_rebuilds: 0,
            last_reconciled_node_count: 0,
            last_was_full_rebuild: true,
        }
    }

    /// The number of full tree rebuilds since construction (test
    /// instrumentation: the incremental fast path must not bump it).
    pub fn full_rebuilds(&self) -> u64 {
        self.full_rebuilds
    }

    /// The number of nodes touched by the last incremental reconciliation
    /// (test instrumentation: a single-leaf change must keep it small).
    pub fn last_reconciled_node_count(&self) -> usize {
        self.last_reconciled_node_count
    }

    /// Whether the last [`compute`](LayoutEngine::compute) was a full rebuild.
    pub fn last_was_full_rebuild(&self) -> bool {
        self.last_was_full_rebuild
    }

    /// Tear down the cached tree and rebuild it from the scene — the
    /// correctness baseline every incremental result is tested against.
    fn full_rebuild(&mut self, scene: &Scene, viewport: Size) -> Vec<(NodeId, Rect)> {
        self.taffy.clear();
        self.node_map.clear();
        self.text_map.clear();
        self.snapshots.clear();
        self.full_rebuilds += 1;
        self.last_was_full_rebuild = true;
        self.last_reconciled_node_count = 0;
        let scene_epoch = scene.epoch();

        let root = scene.root_id();
        let taffy_root = {
            let mut state = EngineState {
                taffy: &mut self.taffy,
                node_map: &mut self.node_map,
                text_map: &mut self.text_map,
                snapshots: &mut self.snapshots,
            };
            let built = build_node(scene, root, viewport, true, &mut state);
            if let Some(t) = built {
                snapshot_subtree(scene, root, viewport, &mut state);
                Some(t)
            } else {
                None
            }
        };
        let Some(taffy_root) = taffy_root else {
            self.last_epoch = scene_epoch;
            self.last_viewport = Some(viewport);
            return Vec::new();
        };

        self.layout_and_read(viewport, taffy_root, scene_epoch)
    }

    /// Run the taffy layout pass over `taffy_root` and read back the rects,
    /// recording the frame's cache state.
    fn layout_and_read(
        &mut self,
        viewport: Size,
        taffy_root: TaffyNodeId,
        scene_epoch: u64,
    ) -> Vec<(NodeId, Rect)> {
        let available = TaffySize {
            width: AvailableSpace::Definite(viewport.width as f32),
            height: AvailableSpace::Definite(viewport.height as f32),
        };

        // The measure closure runs for every leaf node: text leaves report
        // their content size, everything else falls back to taffy's default
        // zero measurement (matching `compute_layout`).
        //
        // A wrap-enabled leaf (wrap unset or `true`) is sized to its *wrapped*
        // content at the constrained width: height = the wrapped line count
        // (`\n`/`\r\n` force breaks; long tokens soft-wrap at word
        // boundaries) and width = the widest wrapped line. The constrained
        // width is the leaf's explicit `width` when it has one, else the
        // definite available width (a column container's content box — flex
        // items are measured at MaxContent/MinContent on their main axis, so
        // the definite constraint only arrives on the cross axis), else the
        // intrinsic single-line width (no constraint: one row unless `\n`
        // breaks it). A `wrap: false` leaf keeps today's intrinsic single
        // row. The wrap model mirrors the compositor's `measure_wrapped`, so
        // layout, paint, and `content_size` agree on the same rows.
        let text_ref = &self.text_map;
        let _ = self.taffy.compute_layout_with_measure(
            taffy_root,
            available,
            |known, available_space, node_id, _node_context, _style| match text_ref.get(&node_id) {
                Some(content) => {
                    let (w, h) = if content.wrap {
                        let width = known
                            .width
                            .or(match available_space.width {
                                AvailableSpace::Definite(w) => Some(w),
                                _ => None,
                            })
                            .map(|w| w.max(1.0) as u32)
                            .unwrap_or(display_width(&content.text) as u32);
                        measure_wrapped(&content.text, width)
                    } else {
                        (display_width(&content.text) as u32, 1)
                    };
                    TaffySize {
                        width: known.width.unwrap_or(w as f32),
                        height: known.height.unwrap_or(h as f32),
                    }
                }
                None => known.unwrap_or(TaffySize {
                    width: 0.0,
                    height: 0.0,
                }),
            },
        );

        let result: Vec<(NodeId, Rect)> = self
            .node_map
            .iter()
            .filter_map(|(id, taffy_node)| {
                let layout = self.taffy.layout(*taffy_node).ok()?;
                Some((*id, layout_to_rect(layout)))
            })
            .collect();
        self.last_epoch = scene_epoch;
        self.last_viewport = Some(viewport);
        result
    }
}

impl LayoutEngine for TaffyLayoutEngine {
    fn compute(&mut self, scene: &Scene, viewport: Size) -> Vec<(NodeId, Rect)> {
        self.last_reconciled_node_count = 0;
        let scene_epoch = scene.epoch();

        // Full rebuild on a cold cache or a different (fresh) scene instance
        // (a fresh scene's epoch resets to 0, so it is always below the last
        // epoch this engine saw).
        let cold = self.node_map.is_empty();
        let fresh_scene = scene_epoch < self.last_epoch;
        if cold || fresh_scene {
            return self.full_rebuild(scene, viewport);
        }

        // Incremental: reconcile the cached tree against the current scene.
        let (force_rebuild, counters) = {
            let mut counters = ReconcileCounters::default();
            let mut state = EngineState {
                taffy: &mut self.taffy,
                node_map: &mut self.node_map,
                text_map: &mut self.text_map,
                snapshots: &mut self.snapshots,
            };
            let force_rebuild = reconcile(scene, viewport, &mut state, &mut counters);
            if !force_rebuild {
                // Drop cached nodes whose tern id is no longer in the scene.
                let scene_ids = collect_scene_ids(scene);
                let orphans: Vec<NodeId> = state
                    .node_map
                    .keys()
                    .filter(|id| !scene_ids.contains(id))
                    .copied()
                    .collect();
                for id in orphans {
                    if let Some(t) = state.node_map.remove(&id) {
                        let _ = state.taffy.remove(t);
                        state.text_map.remove(&t);
                        state.snapshots.remove(&id);
                        counters.removed += 1;
                    }
                }
            }
            (force_rebuild, counters)
        };

        // Conservative fallback: a change touching more than half the tree —
        // or one that could not be reconciled safely — is cheaper and safer as
        // a full rebuild. Correctness is identical either way. Removed nodes
        // are excluded: dropping them from the cached tree is cheap, so a
        // removal-heavy frame stays on the incremental path.
        if force_rebuild || counters.changed + counters.created > self.node_map.len() / 2 {
            return self.full_rebuild(scene, viewport);
        }

        let Some(taffy_root) = self.node_map.get(&scene.root_id()).copied() else {
            // The root is hidden (display: none): no geometry this frame.
            self.last_epoch = scene_epoch;
            self.last_viewport = Some(viewport);
            return Vec::new();
        };

        let result = self.layout_and_read(viewport, taffy_root, scene_epoch);
        self.last_was_full_rebuild = false;
        self.last_reconciled_node_count = counters.total();
        result
    }
}

/// Mirror `id` and its subtree into the taffy tree, recording the
/// tern-node-id -> taffy-node-id mapping. Returns `None` (skipping the node)
/// when the node is missing or `display: none`. Serves both the full rebuild
/// and the incremental path (new subtrees are built with exactly this code).
fn build_node(
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

    let style = scene_node_style(node, viewport, is_root);

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
fn scene_node_style(node: &SceneNode, viewport: Size, is_root: bool) -> TaffyStyle {
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
fn reconcile(
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
    let style = scene_node_style(node, viewport, is_root);
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
fn snapshot_subtree(scene: &Scene, id: NodeId, viewport: Size, state: &mut EngineState<'_>) {
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
            style: scene_node_style(node, viewport, is_root),
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
fn collect_scene_ids(scene: &Scene) -> HashSet<NodeId> {
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

/// Translate a scene node's `props` into a taffy `Style`.
fn props_to_style(props: &PropMap) -> TaffyStyle {
    let length = LengthPercentage::Length;
    let dimension = Dimension::Length;
    let length_auto = LengthPercentageAuto::Length;

    let flex_direction = match prop_str(props, "flex_direction") {
        Some("column") => FlexDirection::Column,
        Some("row-reverse") => FlexDirection::RowReverse,
        Some("column-reverse") => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    };

    let justify_content = match prop_str(props, "justify_content") {
        Some("flex-start") => Some(JustifyContent::FlexStart),
        Some("flex-end") => Some(JustifyContent::FlexEnd),
        Some("center") => Some(JustifyContent::Center),
        Some("space-between") => Some(JustifyContent::SpaceBetween),
        Some("space-around") => Some(JustifyContent::SpaceAround),
        Some("space-evenly") => Some(JustifyContent::SpaceEvenly),
        _ => None, // taffy default: flex-start on the main axis
    };

    let align_items = match prop_str(props, "align_items") {
        Some("flex-start") => Some(AlignItems::FlexStart),
        Some("flex-end") => Some(AlignItems::FlexEnd),
        Some("center") => Some(AlignItems::Center),
        Some("baseline") => Some(AlignItems::Baseline),
        Some("stretch") => Some(AlignItems::Stretch),
        _ => None, // taffy default: stretch on the cross axis
    };

    // align_content packs whole flex lines on the cross axis. Unset means
    // stretch (taffy's default), which is a no-op with a single line.
    let align_content = match prop_str(props, "align_content") {
        Some("flex-start") => Some(AlignContent::FlexStart),
        Some("flex-end") => Some(AlignContent::FlexEnd),
        Some("center") => Some(AlignContent::Center),
        Some("stretch") => Some(AlignContent::Stretch),
        Some("space-between") => Some(AlignContent::SpaceBetween),
        Some("space-around") => Some(AlignContent::SpaceAround),
        Some("space-evenly") => Some(AlignContent::SpaceEvenly),
        _ => None, // taffy default: stretch
    };

    // Per-axis gaps override the uniform `gap` on their axis. taffy stores
    // gap.width = main-axis gap and gap.height = cross-axis gap, so for a row
    // container column_gap separates items horizontally and row_gap separates
    // lines vertically; for a column container the axes swap.
    let (gap, column_gap, row_gap) = (
        prop_number(props, "gap"),
        prop_number(props, "column_gap"),
        prop_number(props, "row_gap"),
    );

    let position = match prop_str(props, "position") {
        Some("absolute") => Position::Absolute,
        _ => Position::Relative,
    };

    // Inset edges for `position: absolute` (and relative, where they offset
    // the laid-out position). Unset edges stay `Auto`.
    let inset = TaffyRect {
        top: prop_number(props, "top")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        right: prop_number(props, "right")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        bottom: prop_number(props, "bottom")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        left: prop_number(props, "left")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
    };

    let (padding, border) = (
        prop_number(props, "padding"),
        prop_number(props, "border"),
    );

    // Per-side spacing overrides the per-axis prop, which overrides the
    // uniform prop on that side — the same cascade `gap` /
    // `row_gap` / `column_gap` use, one level deeper. Each side falls back
    // to 0 when nothing is set.
    let (padding_x, padding_y) = (
        prop_number(props, "padding_x"),
        prop_number(props, "padding_y"),
    );
    let (padding_top, padding_right, padding_bottom, padding_left) = (
        prop_number(props, "padding_top"),
        prop_number(props, "padding_right"),
        prop_number(props, "padding_bottom"),
        prop_number(props, "padding_left"),
    );
    let (margin, margin_x, margin_y) = (
        prop_number(props, "margin"),
        prop_number(props, "margin_x"),
        prop_number(props, "margin_y"),
    );
    let (margin_top, margin_right, margin_bottom, margin_left) = (
        prop_number(props, "margin_top"),
        prop_number(props, "margin_right"),
        prop_number(props, "margin_bottom"),
        prop_number(props, "margin_left"),
    );

    TaffyStyle {
        display: Display::Flex,
        flex_direction,
        justify_content,
        align_items,
        align_content,
        gap: TaffySize {
            width: column_gap
                .or(gap)
                .map(length)
                .unwrap_or(LengthPercentage::Length(0.0)),
            height: row_gap
                .or(gap)
                .map(length)
                .unwrap_or(LengthPercentage::Length(0.0)),
        },
        padding: TaffyRect {
            top: length(padding_top.or(padding_y).or(padding).unwrap_or(0.0)),
            right: length(padding_right.or(padding_x).or(padding).unwrap_or(0.0)),
            bottom: length(padding_bottom.or(padding_y).or(padding).unwrap_or(0.0)),
            left: length(padding_left.or(padding_x).or(padding).unwrap_or(0.0)),
        },
        border: match border {
            Some(b) => taffy::geometry::Rect {
                left: length(b),
                right: length(b),
                top: length(b),
                bottom: length(b),
            },
            None => taffy::geometry::Rect::zero(),
        },
        // Margin offsets the node's laid-out position within its parent's
        // content box; it does not change the node's own size.
        margin: TaffyRect {
            top: length_auto(margin_top.or(margin_y).or(margin).unwrap_or(0.0)),
            right: length_auto(margin_right.or(margin_x).or(margin).unwrap_or(0.0)),
            bottom: length_auto(margin_bottom.or(margin_y).or(margin).unwrap_or(0.0)),
            left: length_auto(margin_left.or(margin_x).or(margin).unwrap_or(0.0)),
        },
        // Width/height (and the min/max clamps below) accept a number
        // (length in cells) or a `"N%"` string (percent of the containing
        // block's content-box size, via `LengthPercentage::Percent` — taffy
        // stores the fraction, see `prop_length_percentage`).
        size: TaffySize {
            width: prop_length_percentage(props, "width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        min_size: TaffySize {
            width: prop_length_percentage(props, "min_width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "min_height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        max_size: TaffySize {
            width: prop_length_percentage(props, "max_width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "max_height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        // The item's initial main-axis size: taffy's flex algorithm grows or
        // shrinks the item from this basis (the pane-side half of a split
        // resize — `dragPanels` in @tern/core sets it as absolute cells).
        flex_basis: prop_number(props, "flex_basis")
            .map(dimension)
            .unwrap_or(Dimension::Auto),
        position,
        inset,
        ..TaffyStyle::default()
    }
}

/// Read a string property.
fn prop_str<'a>(props: &'a PropMap, key: &str) -> Option<&'a str> {
    match props.get(key) {
        Some(PropValue::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// Read an integer or float property as `f32` cells.
fn prop_number(props: &PropMap, key: &str) -> Option<f32> {
    match props.get(key) {
        Some(PropValue::Int(i)) => Some(*i as f32),
        Some(PropValue::Float(f)) => Some(*f as f32),
        _ => None,
    }
}

/// Read a length-or-percentage property: a number is a length in cells, a
/// `"N%"` string is a percentage of the containing block's size.
///
/// Percentage semantics follow taffy 0.7's `LengthPercentage::Percent`, which
/// stores a **0..1 fraction** (50% -> 0.5) — see
/// `taffy-0.7.7/src/style/dimension.rs:23-25` ("percentages are represented as
/// a f32 value in the range [0.0, 1.0] NOT the range [0.0, 100.0]").
///
/// Degradation is predictable and panic-free: a string that does not match
/// `${number}%` (e.g. `"50"`, `"50 %"`, `"abc"`, `""`) yields `None`, so the
/// prop behaves exactly as if it were absent (the engine falls back to
/// `Auto`). A `%` value is never clamped; taffy clamps resulting geometry to
/// non-negative sizes.
fn prop_length_percentage(props: &PropMap, key: &str) -> Option<LengthPercentage> {
    match props.get(key) {
        Some(PropValue::Int(i)) => Some(LengthPercentage::Length(*i as f32)),
        Some(PropValue::Float(f)) => Some(LengthPercentage::Length(*f as f32)),
        Some(PropValue::Str(s)) => parse_percent(s).map(LengthPercentage::Percent),
        _ => None,
    }
}

/// Parse a `"N%"` string into a 0..1 fraction (`"50%"` -> `0.5`). Returns
/// `None` for anything that is not a plain decimal number followed by a single
/// trailing `%` (no leading/trailing whitespace, no units). Negative values
/// parse and pass through unchanged — the resulting geometry is clamped to
/// non-negative sizes by taffy.
fn parse_percent(s: &str) -> Option<f32> {
    let num = s.strip_suffix('%')?;
    let value: f32 = num.parse().ok()?;
    Some(value / 100.0)
}

/// Read a boolean property.
fn prop_bool(props: &PropMap, key: &str) -> Option<bool> {
    match props.get(key) {
        Some(PropValue::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// Display width of a string in terminal cells: the sum of its grapheme
/// clusters' widths (multi-width aware, cluster-indivisible — a ZWJ emoji
/// measures 2 columns, a combining sequence measures 1). Mirrors the
/// compositor's `display_width` so a text leaf's laid-out size agrees with
/// what its paint pass draws. ANSI/OSC/CSI escape sequences are stripped
/// first ([`strip_escapes`](tern_core::cell::strip_escapes)), so a styled
/// text leaf measures its visible glyphs only.
fn display_width(content: &str) -> usize {
    clusters(&strip_escapes(content)).map(|c| c.width as usize).sum()
}

/// The wrapped content size of `content` laid out at `width` cells: the
/// display width of the widest wrapped line and the wrapped line count.
///
/// The wrap model mirrors the compositor's `measure_wrapped` exactly (so
/// layout, paint, and `content_size` agree on the same rows): a token (a
/// whitespace-free run) that does not fit on the current row wraps whole to
/// the next row when it fits a fresh one; a token wider than the whole row is
/// hard-broken across rows; a `\n`/`\r\n` forces a break; a trailing space at
/// a row's end is dropped. Breaking is grapheme-cluster aware — a cluster
/// never splits across rows. An empty content reports `(0, 0)`.
fn measure_wrapped(content: &str, width: u32) -> (u32, u32) {
    if content.is_empty() {
        return (0, 0);
    }
    let width = width.max(1);
    let mut lines: u32 = 1;
    let mut max_col: u32 = 0;
    let mut col: u32 = 0;
    let mut word = String::new();
    let content = strip_escapes(content);
    for cluster in clusters(&content) {
        match cluster.text {
            "\n" | "\r\n" => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                lines += 1;
                col = 0;
            }
            " " => {
                flush_word(&word, width, &mut col, &mut lines, &mut max_col);
                word.clear();
                // A trailing space at a row's end is dropped (the wrap would
                // collapse it anyway), mirroring the compositor.
                if col < width {
                    col += 1;
                    max_col = max_col.max(col);
                }
            }
            _ => word.push_str(cluster.text),
        }
    }
    flush_word(&word, width, &mut col, &mut lines, &mut max_col);
    (max_col, lines)
}

/// Place one pending token onto the wrapped measurement, applying the same
/// wrap rule as the compositor's `flush_word`: whole-token wrap when it does
/// not fit the current row but fits a fresh one, hard cluster-by-cluster
/// break when the token is wider than the whole row.
fn flush_word(word: &str, width: u32, col: &mut u32, lines: &mut u32, max_col: &mut u32) {
    if word.is_empty() {
        return;
    }
    let tw = display_width(word) as u32;
    if tw <= width {
        if *col > 0 && *col + tw > width {
            *lines += 1;
            *col = 0;
        }
        *col += tw;
        *max_col = (*max_col).max(*col);
        return;
    }
    for cluster in clusters(&strip_escapes(word)) {
        let w = cluster.width as u32;
        if w == 0 {
            continue;
        }
        if *col + w > width {
            *lines += 1;
            *col = 0;
        }
        *col += w;
        *max_col = (*max_col).max(*col);
    }
}

/// Map a taffy `Layout` (relative to its parent, so already in scene
/// coordinates) back to a tern-core `Rect`.
fn layout_to_rect(layout: &TaffyLayout) -> Rect {
    Rect::new(
        layout.location.x.round() as i32,
        layout.location.y.round() as i32,
        layout.size.width.round() as u32,
        layout.size.height.round() as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::scene::{Scene, Span};
    use tern_core::style::Style as CellStyle;

    fn new_scene() -> Scene {
        Scene::new()
    }

    fn set_prop(scene: &mut Scene, id: NodeId, key: &str, value: PropValue) {
        assert!(scene.set_prop(id, key, value), "set_prop({key})");
    }

    fn add_box(scene: &mut Scene, parent: NodeId) -> NodeId {
        scene
            .add_child(parent, NodeKind::Box, CellStyle::new())
            .expect("add box")
    }

    /// The rect for `id` in the compute result.
    fn rect_of(result: &[(NodeId, Rect)], id: NodeId) -> Rect {
        result
            .iter()
            .find(|(n, _)| *n == id)
            .map(|(_, r)| *r)
            .unwrap_or_else(|| panic!("node {id:?} missing from layout result"))
    }

    #[test]
    fn flex_row_positions_children_horizontally() {
        let mut scene = new_scene();
        let root = scene.root_id();
        let a = add_box(&mut scene, root);
        let b = add_box(&mut scene, root);
        for (id, w, h) in [(a, 40, 20), (b, 40, 20)] {
            set_prop(&mut scene, id, "width", PropValue::Int(w));
            set_prop(&mut scene, id, "height", PropValue::Int(h));
        }

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, root), Rect::new(0, 0, 100, 50));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 40, 20));
        assert_eq!(rect_of(&out, b), Rect::new(40, 0, 40, 20));
    }

    #[test]
    fn flex_column_stacks_children_vertically() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "flex_direction",
            PropValue::Str("column".into()),
        );
        let a = add_box(&mut scene, root);
        let b = add_box(&mut scene, root);
        for (id, w, h) in [(a, 40, 20), (b, 40, 20)] {
            set_prop(&mut scene, id, "width", PropValue::Int(w));
            set_prop(&mut scene, id, "height", PropValue::Int(h));
        }

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, root), Rect::new(0, 0, 100, 50));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 40, 20));
        assert_eq!(rect_of(&out, b), Rect::new(0, 20, 40, 20));
    }

    #[test]
    fn gap_spaces_children_apart() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "gap", PropValue::Int(10));
        let a = add_box(&mut scene, root);
        let b = add_box(&mut scene, root);
        let c = add_box(&mut scene, root);
        for (id, w, h) in [(a, 20, 10), (b, 20, 10), (c, 20, 10)] {
            set_prop(&mut scene, id, "width", PropValue::Int(w));
            set_prop(&mut scene, id, "height", PropValue::Int(h));
        }

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 20, 10));
        assert_eq!(rect_of(&out, b), Rect::new(30, 0, 20, 10));
        assert_eq!(rect_of(&out, c), Rect::new(60, 0, 20, 10));
    }

    #[test]
    fn padding_and_border_inset_content() {
        // Border-box sizing (taffy default): a 30x30 box with 1px border and
        // 2px padding leaves a 24x24 content box; the child starts 3 cells in.
        let mut scene = new_scene();
        let root = scene.root_id();
        let outer = add_box(&mut scene, root);
        set_prop(&mut scene, outer, "width", PropValue::Int(30));
        set_prop(&mut scene, outer, "height", PropValue::Int(30));
        set_prop(&mut scene, outer, "border", PropValue::Int(1));
        set_prop(&mut scene, outer, "padding", PropValue::Int(2));
        let inner = add_box(&mut scene, outer);
        set_prop(&mut scene, inner, "width", PropValue::Int(10));
        set_prop(&mut scene, inner, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 30, 30));
        assert_eq!(rect_of(&out, inner), Rect::new(3, 3, 10, 10));
    }

    #[test]
    fn margin_offsets_a_child() {
        // A uniform margin pushes the child away from the parent's edges
        // without growing the child itself.
        let mut scene = new_scene();
        let root = scene.root_id();
        let outer = add_box(&mut scene, root);
        set_prop(&mut scene, outer, "width", PropValue::Int(40));
        set_prop(&mut scene, outer, "height", PropValue::Int(20));
        let inner = add_box(&mut scene, outer);
        set_prop(&mut scene, inner, "width", PropValue::Int(10));
        set_prop(&mut scene, inner, "height", PropValue::Int(10));
        set_prop(&mut scene, inner, "margin", PropValue::Int(2));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 40, 20));
        assert_eq!(rect_of(&out, inner), Rect::new(2, 2, 10, 10));
    }

    #[test]
    fn margin_top_overrides_uniform_margin() {
        // Per-side margin overrides the uniform margin on that side; the
        // other sides keep the uniform value.
        let mut scene = new_scene();
        let root = scene.root_id();
        let outer = add_box(&mut scene, root);
        set_prop(&mut scene, outer, "width", PropValue::Int(40));
        set_prop(&mut scene, outer, "height", PropValue::Int(30));
        let inner = add_box(&mut scene, outer);
        set_prop(&mut scene, inner, "width", PropValue::Int(10));
        set_prop(&mut scene, inner, "height", PropValue::Int(10));
        set_prop(&mut scene, inner, "margin", PropValue::Int(2));
        set_prop(&mut scene, inner, "margin_top", PropValue::Int(5));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, inner), Rect::new(2, 5, 10, 10));
    }

    #[test]
    fn padding_x_insets_content_horizontally_only() {
        // Per-axis padding applies to both horizontal edges and leaves the
        // vertical axis untouched.
        let mut scene = new_scene();
        let root = scene.root_id();
        let outer = add_box(&mut scene, root);
        set_prop(&mut scene, outer, "width", PropValue::Int(30));
        set_prop(&mut scene, outer, "height", PropValue::Int(30));
        set_prop(&mut scene, outer, "padding_x", PropValue::Int(3));
        let inner = add_box(&mut scene, outer);
        set_prop(&mut scene, inner, "width", PropValue::Int(10));
        set_prop(&mut scene, inner, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, outer), Rect::new(0, 0, 30, 30));
        assert_eq!(rect_of(&out, inner), Rect::new(3, 0, 10, 10));
    }

    #[test]
    fn text_leaf_is_sized_to_content() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start alignment keeps the leaf at its measured height of 1
        // instead of stretching to the container height.
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let t = scene
            .add_text(root, "Hello", CellStyle::new())
            .expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 5, 1));
    }

    #[test]
    fn text_measure_is_multi_width_aware() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
        let t = scene
            .add_text(root, "コa", CellStyle::new())
            .expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 3, 1));
    }

    #[test]
    fn streaming_text_leaf_is_sized_to_concatenated_content() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start alignment keeps the leaf at its measured height of 1
        // instead of stretching to the container height.
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        assert!(scene.append_span(
            s,
            Span {
                text: "Hello".into(),
                style: CellStyle::new()
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: " world".into(),
                style: CellStyle::new()
            }
        ));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        // "Hello" (5) + " world" (6) -> 11 cells.
        assert_eq!(rect_of(&out, s), Rect::new(0, 0, 11, 1));
    }

    #[test]
    fn streaming_text_measure_is_multi_width_aware() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
        assert!(scene.append_span(
            s,
            Span {
                text: "コ".into(),
                style: CellStyle::new()
            }
        ));
        assert!(scene.append_span(
            s,
            Span {
                text: "a".into(),
                style: CellStyle::new()
            }
        ));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, s), Rect::new(0, 0, 3, 1));
    }

    #[test]
    fn wrap_false_leaf_keeps_intrinsic_width_in_fixed_container() {
        // A `wrap: false` text/streaming leaf is a single intrinsic-width
        // line: layout must never re-flow it. Inside a fixed-width container
        // it keeps its full content width (overflowing the container), so the
        // compositor trims at paint time (against the clip/viewport edge)
        // instead of the layout engine squeezing the line.
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "width", PropValue::Int(5));
        set_prop(&mut scene, root, "height", PropValue::Int(2));
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        set_prop(&mut scene, s, "wrap", PropValue::Bool(false));
        assert!(scene.append_span(
            s,
            Span {
                text: "abc def".into(),
                style: CellStyle::new()
            }
        ));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        // 7-cell content width ('abc def') in a 5-wide container: the leaf
        // keeps its intrinsic width and overflows; height stays 1 (single row).
        assert_eq!(rect_of(&out, s), Rect::new(0, 0, 7, 1));
    }

    #[test]
    fn wrap_enabled_text_leaf_heights_to_wrapped_rows_at_explicit_width() {
        // A wrap-enabled Text leaf with an explicit width wraps at that width
        // in LAYOUT: 'abcdef' (6 cells) at a 4-cell width occupies two rows of
        // 4 + 2 cells, so the leaf is 4 wide and 2 tall (the same geometry the
        // compositor paints and `content_size` reports).
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let t = scene
            .add_text(root, "abcdef", CellStyle::new())
            .expect("add text");
        set_prop(&mut scene, t, "width", PropValue::Int(4));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 2));
    }

    #[test]
    fn newlines_force_row_breaks_in_wrap_enabled_text() {
        // `\n` forces a row break even without a width constraint: 'ab\ncd'
        // is two rows at its intrinsic widest-line width (2 cells).
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let t = scene
            .add_text(root, "ab\ncd", CellStyle::new())
            .expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 2, 2));
    }

    #[test]
    fn wrap_enabled_text_in_column_container_wraps_at_container_width() {
        // In a column container the leaf's width constraint is the container's
        // definite width (the cross-axis available space): 'abcdef' at 4 cells
        // wraps to 2 rows even without an explicit width prop on the leaf.
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "flex_direction",
            PropValue::Str("column".into()),
        );
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let t = scene
            .add_text(root, "abcdef", CellStyle::new())
            .expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(4, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 2));
    }

    #[test]
    fn wrap_false_text_stays_single_row_at_constrained_width() {
        // `wrap: false` keeps the intrinsic single row even with a constrained
        // width: 'abcdef' at a 4-cell width stays one row (the compositor
        // trims the overflow at paint time).
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );
        let t = scene
            .add_text(root, "abcdef", CellStyle::new())
            .expect("add text");
        set_prop(&mut scene, t, "width", PropValue::Int(4));
        set_prop(&mut scene, t, "wrap", PropValue::Bool(false));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 4, 1));
    }

    #[test]
    fn display_none_omits_node_and_subtree() {
        let mut scene = new_scene();
        let root = scene.root_id();
        let hidden = add_box(&mut scene, root);
        set_prop(&mut scene, hidden, "display", PropValue::Str("none".into()));
        let child = add_box(&mut scene, hidden);
        set_prop(&mut scene, child, "width", PropValue::Int(10));
        set_prop(&mut scene, child, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert!(out.iter().all(|(id, _)| *id != hidden && *id != child));
        assert!(out.iter().any(|(id, _)| *id == root));
    }

    #[test]
    fn props_to_style_maps_align_content() {
        let cases: &[(&str, AlignContent)] = &[
            ("flex-start", AlignContent::FlexStart),
            ("flex-end", AlignContent::FlexEnd),
            ("center", AlignContent::Center),
            ("stretch", AlignContent::Stretch),
            ("space-between", AlignContent::SpaceBetween),
            ("space-around", AlignContent::SpaceAround),
            ("space-evenly", AlignContent::SpaceEvenly),
        ];
        for &(value, expected) in cases {
            let props = PropMap::from([(
                "align_content".to_string(),
                PropValue::Str(value.to_string()),
            )]);
            assert_eq!(
                props_to_style(&props).align_content,
                Some(expected),
                "align_content={value}"
            );
        }
        // Absent -> None (taffy resolves the default to Stretch).
        assert_eq!(props_to_style(&PropMap::new()).align_content, None);
    }

    #[test]
    fn align_content_has_no_visible_effect_on_single_line() {
        // tern has no flex_wrap prop, so every flex container is single-line.
        // taffy 0.7.7 sizes the sole line to the container's inner cross size
        // (CSS flexbox algorithm step 8, `calculate_cross_size` in
        // taffy/src/compute/flexbox.rs), leaving zero free cross space: even
        // with align_content flex-end / center the line cannot shift. The
        // prop still maps through to the taffy style (see
        // `props_to_style_maps_align_content`) and will take effect once
        // multi-line wrapping exists. This test pins the actual 0.7.7
        // behavior for a 30-tall row with a 10-tall child: it stays at the
        // cross start (y = 0), NOT at the bottom (y = 20).
        for value in ["flex-end", "center"] {
            let mut scene = new_scene();
            let root = scene.root_id();
            set_prop(&mut scene, root, "width", PropValue::Int(100));
            set_prop(&mut scene, root, "height", PropValue::Int(30));
            set_prop(
                &mut scene,
                root,
                "align_items",
                PropValue::Str("flex-start".into()),
            );
            set_prop(
                &mut scene,
                root,
                "align_content",
                PropValue::Str(value.into()),
            );
            let child = add_box(&mut scene, root);
            set_prop(&mut scene, child, "width", PropValue::Int(10));
            set_prop(&mut scene, child, "height", PropValue::Int(10));

            let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
            assert_eq!(
                rect_of(&out, child),
                Rect::new(0, 0, 10, 10),
                "align_content={value} must not move a single-line child"
            );
        }
    }

    #[test]
    fn props_to_style_maps_gap_axes() {
        // column_gap maps to the main-axis gap (gap.width), row_gap to the
        // cross-axis gap (gap.height).
        let props = PropMap::from([
            ("column_gap".to_string(), PropValue::Int(5)),
            ("row_gap".to_string(), PropValue::Int(7)),
        ]);
        let style = props_to_style(&props);
        assert_eq!(style.gap.width, LengthPercentage::Length(5.0));
        assert_eq!(style.gap.height, LengthPercentage::Length(7.0));

        // Uniform `gap` fills both axes (existing behavior).
        let style = props_to_style(&PropMap::from([("gap".to_string(), PropValue::Int(9))]));
        assert_eq!(style.gap.width, LengthPercentage::Length(9.0));
        assert_eq!(style.gap.height, LengthPercentage::Length(9.0));

        // Per-axis gaps override the uniform gap on their axis.
        let props = PropMap::from([
            ("gap".to_string(), PropValue::Int(9)),
            ("column_gap".to_string(), PropValue::Int(3)),
            ("row_gap".to_string(), PropValue::Int(4)),
        ]);
        let style = props_to_style(&props);
        assert_eq!(style.gap.width, LengthPercentage::Length(3.0));
        assert_eq!(style.gap.height, LengthPercentage::Length(4.0));

        // Floats are accepted.
        let style = props_to_style(&PropMap::from([(
            "column_gap".to_string(),
            PropValue::Float(2.5),
        )]));
        assert_eq!(style.gap.width, LengthPercentage::Length(2.5));

        // Absent -> zero on both axes.
        assert_eq!(props_to_style(&PropMap::new()).gap, TaffySize::zero());
    }

    #[test]
    fn column_gap_spaces_row_children_horizontally() {
        // On a row container column_gap is the main-axis gap: three 20-wide
        // children with a 10-cell column_gap sit at x = 0, 30, 60.
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "column_gap", PropValue::Int(10));
        let a = add_box(&mut scene, root);
        let b = add_box(&mut scene, root);
        let c = add_box(&mut scene, root);
        for (id, w, h) in [(a, 20, 10), (b, 20, 10), (c, 20, 10)] {
            set_prop(&mut scene, id, "width", PropValue::Int(w));
            set_prop(&mut scene, id, "height", PropValue::Int(h));
        }

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 20, 10));
        assert_eq!(rect_of(&out, b), Rect::new(30, 0, 20, 10));
        assert_eq!(rect_of(&out, c), Rect::new(60, 0, 20, 10));
    }

    #[test]
    fn props_to_style_maps_min_max_size() {
        let props = PropMap::from([
            ("min_width".to_string(), PropValue::Int(30)),
            ("min_height".to_string(), PropValue::Float(4.0)),
            ("max_width".to_string(), PropValue::Int(200)),
            ("max_height".to_string(), PropValue::Int(40)),
        ]);
        let style = props_to_style(&props);
        assert_eq!(
            style.min_size,
            TaffySize {
                width: Dimension::Length(30.0),
                height: Dimension::Length(4.0),
            }
        );
        assert_eq!(
            style.max_size,
            TaffySize {
                width: Dimension::Length(200.0),
                height: Dimension::Length(40.0),
            }
        );

        // Unset axes stay Auto.
        let style = props_to_style(&PropMap::from([(
            "min_width".to_string(),
            PropValue::Int(5),
        )]));
        assert_eq!(style.min_size.width, Dimension::Length(5.0));
        assert_eq!(style.min_size.height, Dimension::Auto);
        let style = props_to_style(&PropMap::new());
        assert_eq!(
            style.min_size,
            TaffySize {
                width: Dimension::Auto,
                height: Dimension::Auto
            }
        );
        assert_eq!(
            style.max_size,
            TaffySize {
                width: Dimension::Auto,
                height: Dimension::Auto
            }
        );
    }

    #[test]
    fn min_max_size_clamps_explicit_size() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start keeps children at their explicit heights (no stretch).
        set_prop(
            &mut scene,
            root,
            "align_items",
            PropValue::Str("flex-start".into()),
        );

        // Width 100 clamped down to max_width 20.
        let a = add_box(&mut scene, root);
        set_prop(&mut scene, a, "width", PropValue::Int(100));
        set_prop(&mut scene, a, "max_width", PropValue::Int(20));
        set_prop(&mut scene, a, "height", PropValue::Int(10));

        // Width 10 raised to min_width 30.
        let b = add_box(&mut scene, root);
        set_prop(&mut scene, b, "width", PropValue::Int(10));
        set_prop(&mut scene, b, "min_width", PropValue::Int(30));
        set_prop(&mut scene, b, "height", PropValue::Int(10));

        // Height 30 clamped down to max_height 20.
        let c = add_box(&mut scene, root);
        set_prop(&mut scene, c, "width", PropValue::Int(10));
        set_prop(&mut scene, c, "height", PropValue::Int(30));
        set_prop(&mut scene, c, "max_height", PropValue::Int(20));

        // Height 10 raised to min_height 30.
        let d = add_box(&mut scene, root);
        set_prop(&mut scene, d, "width", PropValue::Int(10));
        set_prop(&mut scene, d, "height", PropValue::Int(10));
        set_prop(&mut scene, d, "min_height", PropValue::Int(30));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 20, 10));
        assert_eq!(rect_of(&out, b), Rect::new(20, 0, 30, 10));
        assert_eq!(rect_of(&out, c), Rect::new(50, 0, 10, 20));
        assert_eq!(rect_of(&out, d), Rect::new(60, 0, 10, 30));
    }

    #[test]
    fn flex_basis_splits_panes_proportionally_to_viewport() {
        // A 60/40 `flex_basis` split with no explicit sizes anywhere: the
        // pane widths come entirely from taffy's flex-basis resolution (the
        // same prop `dragPanels` in @tern/core sets on a pane during a split
        // resize). In a 100-cell viewport the two bases sum to the container
        // (zero free space) so the panes land at exactly 60/40; halving the
        // viewport shrinks them proportionally — the flex-shrink algorithm
        // scales each item's shrink by its basis — to 30/20.
        let mut scene = new_scene();
        let root = scene.root_id();
        let a = add_box(&mut scene, root);
        let b = add_box(&mut scene, root);
        set_prop(&mut scene, a, "flex_basis", PropValue::Int(60));
        set_prop(&mut scene, b, "flex_basis", PropValue::Int(40));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 60, 10));
        assert_eq!(rect_of(&out, b), Rect::new(60, 0, 40, 10));

        // Half-width viewport: the same split stays proportional (30/20).
        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(50, 10));
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 30, 10));
        assert_eq!(rect_of(&out, b), Rect::new(30, 0, 20, 10));
    }

    #[test]
    fn props_to_style_maps_position_and_inset() {
        let props = PropMap::from([
            ("position".to_string(), PropValue::Str("absolute".into())),
            ("top".to_string(), PropValue::Int(5)),
            ("right".to_string(), PropValue::Int(6)),
            ("bottom".to_string(), PropValue::Float(7.5)),
            ("left".to_string(), PropValue::Int(8)),
        ]);
        let style = props_to_style(&props);
        assert_eq!(style.position, Position::Absolute);
        assert_eq!(style.inset.top, LengthPercentageAuto::Length(5.0));
        assert_eq!(style.inset.right, LengthPercentageAuto::Length(6.0));
        assert_eq!(style.inset.bottom, LengthPercentageAuto::Length(7.5));
        assert_eq!(style.inset.left, LengthPercentageAuto::Length(8.0));

        // Unset edges stay Auto; an unset or `relative` position is Relative.
        let style = props_to_style(&PropMap::from([("top".to_string(), PropValue::Int(1))]));
        assert_eq!(style.inset.top, LengthPercentageAuto::Length(1.0));
        assert_eq!(style.inset.left, LengthPercentageAuto::Auto);
        assert_eq!(style.inset.right, LengthPercentageAuto::Auto);
        assert_eq!(style.inset.bottom, LengthPercentageAuto::Auto);
        assert_eq!(style.position, Position::Relative);

        let style = props_to_style(&PropMap::from([(
            "position".to_string(),
            PropValue::Str("relative".into()),
        )]));
        assert_eq!(style.position, Position::Relative);
        assert_eq!(props_to_style(&PropMap::new()).position, Position::Relative);
    }

    #[test]
    fn absolute_child_is_positioned_against_parent() {
        // An absolute child's insets resolve against its direct parent: a
        // 50x30 relative parent with top=5,left=3 pins a 10x10 child at
        // (3, 5) inside the parent's padding box.
        let mut scene = new_scene();
        let root = scene.root_id();
        let parent = add_box(&mut scene, root);
        set_prop(&mut scene, parent, "width", PropValue::Int(50));
        set_prop(&mut scene, parent, "height", PropValue::Int(30));
        set_prop(
            &mut scene,
            parent,
            "position",
            PropValue::Str("relative".into()),
        );
        let abs = add_box(&mut scene, parent);
        set_prop(
            &mut scene,
            abs,
            "position",
            PropValue::Str("absolute".into()),
        );
        set_prop(&mut scene, abs, "top", PropValue::Int(5));
        set_prop(&mut scene, abs, "left", PropValue::Int(3));
        set_prop(&mut scene, abs, "width", PropValue::Int(10));
        set_prop(&mut scene, abs, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, parent), Rect::new(0, 0, 50, 30));
        assert_eq!(rect_of(&out, abs), Rect::new(3, 5, 10, 10));
    }

    #[test]
    fn absolute_child_inset_resolves_against_padding_box() {
        // taffy 0.7.7 resolves absolute insets against the direct parent's
        // padding box: the inset origin is parent origin + border. A 30x30
        // parent with a 1-cell border and 2-cell padding puts a top=5,left=3
        // child at (1 + 3, 1 + 5) = (4, 6) — padding does not shift it.
        let mut scene = new_scene();
        let root = scene.root_id();
        let parent = add_box(&mut scene, root);
        set_prop(&mut scene, parent, "width", PropValue::Int(30));
        set_prop(&mut scene, parent, "height", PropValue::Int(30));
        set_prop(&mut scene, parent, "border", PropValue::Int(1));
        set_prop(&mut scene, parent, "padding", PropValue::Int(2));
        let abs = add_box(&mut scene, parent);
        set_prop(
            &mut scene,
            abs,
            "position",
            PropValue::Str("absolute".into()),
        );
        set_prop(&mut scene, abs, "top", PropValue::Int(5));
        set_prop(&mut scene, abs, "left", PropValue::Int(3));
        set_prop(&mut scene, abs, "width", PropValue::Int(10));
        set_prop(&mut scene, abs, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, abs), Rect::new(4, 6, 10, 10));
    }

    #[test]
    fn absolute_child_takes_no_flex_space() {
        // An absolute child is removed from flex flow: it does not push its
        // in-flow sibling, and it is placed by its insets alone.
        let mut scene = new_scene();
        let root = scene.root_id();
        let a = add_box(&mut scene, root);
        set_prop(&mut scene, a, "width", PropValue::Int(10));
        set_prop(&mut scene, a, "height", PropValue::Int(10));
        let abs = add_box(&mut scene, root);
        set_prop(
            &mut scene,
            abs,
            "position",
            PropValue::Str("absolute".into()),
        );
        set_prop(&mut scene, abs, "top", PropValue::Int(0));
        set_prop(&mut scene, abs, "left", PropValue::Int(15));
        set_prop(&mut scene, abs, "width", PropValue::Int(10));
        set_prop(&mut scene, abs, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        // a keeps the row-start slot; abs overlaps at x=15 without pushing it.
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 10, 10));
        assert_eq!(rect_of(&out, abs), Rect::new(15, 0, 10, 10));
    }

    #[test]
    fn percent_width_resolves_against_the_containing_block() {
        // A `width: "50%"` string maps to taffy `Dimension::Percent(0.5)`
        // (taffy stores a 0..1 fraction), which resolves against the parent's
        // content-box width: the root fills the 100-cell viewport, so the
        // child lands at 50 cells.
        let mut scene = new_scene();
        let root = scene.root_id();
        let child = add_box(&mut scene, root);
        set_prop(&mut scene, child, "width", PropValue::Str("50%".into()));
        set_prop(&mut scene, child, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, child), Rect::new(0, 0, 50, 10));
    }

    #[test]
    fn percent_width_tracks_root_width_changes() {
        // The same engine re-layouts on a viewport change: the percentage
        // re-resolves against the new containing-block width (100 -> 200
        // cells yields 50 -> 100 cells), on both the incremental and the
        // fresh-cache paths.
        let mut scene = new_scene();
        let root = scene.root_id();
        let child = add_box(&mut scene, root);
        set_prop(&mut scene, child, "width", PropValue::Str("50%".into()));
        set_prop(&mut scene, child, "height", PropValue::Int(10));

        let mut engine = TaffyLayoutEngine::new();
        let out = engine.compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, child).width, 50);

        // Same scene, wider viewport — the incremental path re-resolves.
        let out = engine.compute(&scene, Size::new(200, 50));
        assert_eq!(rect_of(&out, child).width, 100);

        // A fresh engine on the same scene (cold cache) agrees.
        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(200, 50));
        assert_eq!(rect_of(&out, child).width, 100);
    }

    #[test]
    fn percent_min_and_max_clamp_the_size() {
        // min_width/max_width accept the same `"N%"` strings as width: the
        // resolved size is clamped against the percentage min/max.
        let mut scene = new_scene();
        let root = scene.root_id();
        let min_child = add_box(&mut scene, root);
        set_prop(&mut scene, min_child, "width", PropValue::Str("20%".into()));
        set_prop(&mut scene, min_child, "min_width", PropValue::Str("30%".into()));
        let max_child = add_box(&mut scene, root);
        set_prop(&mut scene, max_child, "width", PropValue::Str("20%".into()));
        set_prop(&mut scene, max_child, "max_width", PropValue::Str("10%".into()));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        // 20% = 20 cells, clamped up to min 30% = 30 cells.
        assert_eq!(rect_of(&out, min_child).width, 30);
        // 20% = 20 cells, clamped down to max 10% = 10 cells.
        assert_eq!(rect_of(&out, max_child).width, 10);
    }

    #[test]
    fn malformed_percent_strings_fall_back_to_auto() {
        // A string that does not match `${number}%` degrades to the absent
        // prop: the style keeps `Dimension::Auto`, never panics.
        for bad in ["50", "abc%", "50 %", "%", "", "5%%"] {
            let style = props_to_style(&PropMap::from([(
                "width".to_string(),
                PropValue::Str(bad.into()),
            )]));
            assert_eq!(style.size.width, Dimension::Auto, "width = {bad:?}");
        }

        // And the layout-level observable: a malformed width lays out exactly
        // like an unset width (content-sized).
        let mut scene = new_scene();
        let root = scene.root_id();
        let plain = add_box(&mut scene, root);
        set_prop(&mut scene, plain, "height", PropValue::Int(10));
        let malformed = add_box(&mut scene, root);
        set_prop(&mut scene, malformed, "width", PropValue::Str("50".into()));
        set_prop(&mut scene, malformed, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        assert_eq!(rect_of(&out, malformed), rect_of(&out, plain));
    }

    #[test]
    fn parse_percent_reads_the_fraction() {
        // The `"N%"` -> 0..1 fraction conversion that backs
        // `prop_length_percentage` (taffy Percent semantics).
        assert_eq!(parse_percent("50%"), Some(0.5));
        assert_eq!(parse_percent("100%"), Some(1.0));
        assert_eq!(parse_percent("0%"), Some(0.0));
        assert_eq!(parse_percent("25%"), Some(0.25));
        assert_eq!(parse_percent("150%"), Some(1.5));
        assert_eq!(parse_percent("50"), None);
        assert_eq!(parse_percent("50 %"), None);
        assert_eq!(parse_percent(""), None);
    }
}
