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
//! | `display`         | `Str("flex"\|"grid"\|"none")`                                       | `"flex"`|
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
//! | `grid_template_columns` / `grid_template_rows` | `Str` — space-separated track tokens `<n>fr` (flex fraction), `<n>px` (cells), `<n>%` (percent), `auto`; unparseable tokens are skipped | empty (auto tracks) |
//! | `grid_auto_flow`  | `Str("row"\|"column"\|"row-dense"\|"column-dense")`                | `"row"` |
//! | `grid_row` / `grid_column` | `Int` (line index, positive from the start / negative from the end) \| `Str("span N")` (track span) — sets the start line, end stays auto (a one-track span) | auto |
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
use taffy::geometry::{Line as TaffyLine, Rect as TaffyRect, Size as TaffySize};
use taffy::style::{
    AlignContent, AlignItems, AvailableSpace, Dimension, Display, FlexDirection, GridAutoFlow,
    GridPlacement, JustifyContent, LengthPercentage, LengthPercentageAuto,
    NonRepeatedTrackSizingFunction, Position, Style as TaffyStyle, TrackSizingFunction,
};
use taffy::style_helpers::{
    line as grid_line, span as grid_span, FromFlex, FromLength, FromPercent, TaffyAuto,
};
use taffy::tree::{Layout as TaffyLayout, NodeId as TaffyNodeId, TaffyTree};
use tern_core::cell::{clusters, strip_escapes};
use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene, SceneNode, Span};

// Modelled on the compositor split (tern-components/src/compositor.rs):
// the submodules hold the cohesive slices and the glob re-exports keep
// every item reachable under its original path.
mod tree;
mod style;
mod text;

use tree::*;
use style::*;
use text::*;

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

#[cfg(test)]
mod tests;
