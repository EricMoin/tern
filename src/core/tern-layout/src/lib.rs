//! tern-layout — layout engine for the tern TUI renderer.
//!
//! Implements [`LayoutEngine`] by wrapping taffy 0.7 ([`TaffyTree<()>`]): the
//! scene tree is mirrored into a taffy tree, laid out against the viewport,
//! and each taffy [`Layout`] is mapped back to a tern-core [`Rect`].
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
//! | `padding`         | `Int` \| `Float` (cells, uniform)                                    | 0      |
//! | `border`          | `Int` \| `Float` (cells, uniform border width)                       | 0      |
//! | `width` / `height`| `Int` \| `Float` (cells)                                             | auto   |
//! | `min_width` / `min_height` | `Int` \| `Float` (cells)                                      | auto   |
//! | `max_width` / `max_height` | `Int` \| `Float` (cells)                                      | auto   |
//! | `position`        | `Str("relative"\|"absolute")`                                       | `"relative"` |
//! | `top` / `right` / `bottom` / `left` | `Int` \| `Float` (cells, inset edges)                       | auto   |
//! | `text`            | `Str` — content of a `Text` leaf                                     | —      |
//! | `z_index`         | `Int` — paint order; consumed by the compositor, not the engine      | 0      |
//! | `clip_x` / `clip_y` / `clip_width` / `clip_height` | `Int` (cells) — a clip rect restricting the node's subtree drawing to a bounded region; consumed by the compositor | unset (no clip) |
//! | `scroll_x` / `scroll_y` | `Int` (cells) — per-region scroll offset shifting content inside the clip rect; consumed by the compositor | 0 |
//! | `wrap`               | `Bool` — text/streaming leaf wrapping; `false` keeps the line single-row (intrinsic width, no flex shrink) and the compositor trims overflow at the right edge; `true`/unset soft-wraps at word boundaries | `true` |
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

use std::collections::HashMap;

use taffy::geometry::{Rect as TaffyRect, Size as TaffySize};
use taffy::style::{
    AlignContent, AlignItems, AvailableSpace, Dimension, Display, FlexDirection, JustifyContent,
    LengthPercentage, LengthPercentageAuto, Position, Style as TaffyStyle,
};
use taffy::tree::{Layout as TaffyLayout, NodeId as TaffyNodeId, TaffyTree};

use tern_core::layout::LayoutEngine;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene};

use unicode_width::UnicodeWidthStr;

/// The tern layout engine: a thin wrapper over taffy 0.7.
///
/// Stateless: each [`compute`](LayoutEngine::compute) call builds a fresh
/// taffy tree from the scene.
#[derive(Debug, Clone, Copy, Default)]
pub struct TaffyLayoutEngine;

impl TaffyLayoutEngine {
    /// Create a new layout engine.
    pub const fn new() -> Self {
        Self
    }
}

impl LayoutEngine for TaffyLayoutEngine {
    fn compute(&mut self, scene: &Scene, viewport: Size) -> Vec<(NodeId, Rect)> {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let mut node_map: HashMap<NodeId, TaffyNodeId> = HashMap::new();
        let mut text_map: HashMap<TaffyNodeId, String> = HashMap::new();

        let root = scene.root_id();
        let Some(taffy_root) = build_node(
            scene,
            root,
            viewport,
            /* is_root */ true,
            &mut taffy,
            &mut node_map,
            &mut text_map,
        ) else {
            return Vec::new();
        };

        let available = TaffySize {
            width: AvailableSpace::Definite(viewport.width as f32),
            height: AvailableSpace::Definite(viewport.height as f32),
        };

        // The measure closure runs for every leaf node: text leaves report
        // their content size, everything else falls back to taffy's default
        // zero measurement (matching `compute_layout`).
        let text_ref = &text_map;
        let _ = taffy.compute_layout_with_measure(
            taffy_root,
            available,
            |known, _available_space, node_id, _node_context, _style| match text_ref.get(&node_id) {
                Some(content) => TaffySize {
                    width: known.width.unwrap_or(display_width(content) as f32),
                    height: known.height.unwrap_or(1.0),
                },
                None => known.unwrap_or(TaffySize { width: 0.0, height: 0.0 }),
            },
        );

        node_map
            .into_iter()
            .filter_map(|(id, taffy_node)| {
                let layout = taffy.layout(taffy_node).ok()?;
                Some((id, layout_to_rect(layout)))
            })
            .collect()
    }
}

/// Mirror `id` and its subtree into the taffy tree, recording the
/// tern-node-id -> taffy-node-id mapping. Returns `None` (skipping the node)
/// when the node is missing or `display: none`.
fn build_node(
    scene: &Scene,
    id: NodeId,
    viewport: Size,
    is_root: bool,
    taffy: &mut TaffyTree<()>,
    node_map: &mut HashMap<NodeId, TaffyNodeId>,
    text_map: &mut HashMap<TaffyNodeId, String>,
) -> Option<TaffyNodeId> {
    let node = scene.node(id)?;

    // `display: none` hides the node and its whole subtree.
    if matches!(prop_str(&node.props, "display"), Some("none")) {
        return None;
    }

    let mut style = props_to_style(&node.props);

    // A `wrap: false` text/streaming leaf is a single intrinsic-width line —
    // it must never be re-flowed by layout, so it is exempt from flex
    // shrinking (the compositor trims overflow at paint time instead).
    // Wrapping leaves (wrap unset or `true`) may be constrained; the
    // compositor soft-wraps them at word boundaries.
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

    // Text and StreamingText nodes are leaves; build their (by construction
    // empty) children list and register the content for measurement.
    let is_leaf = matches!(node.kind, NodeKind::Text | NodeKind::StreamingText);
    let children: Vec<TaffyNodeId> = if is_leaf {
        Vec::new()
    } else {
        node.children
            .iter()
            .filter_map(|&child| build_node(scene, child, viewport, false, taffy, node_map, text_map))
            .collect()
    };

    let taffy_node = match node.kind {
        NodeKind::Text => {
            let t = taffy.new_leaf(style).ok()?;
            if let Some(PropValue::Str(content)) = node.props.get("text") {
                text_map.insert(t, content.clone());
            }
            t
        }
        NodeKind::StreamingText => {
            let t = taffy.new_leaf(style).ok()?;
            // The compositor renders the node's accumulated stream; register
            // the concatenated span texts so the measure closure sizes the
            // leaf to its display width (same path as `text` content).
            let content: String = scene
                .stream(id)
                .map(|spans| spans.iter().map(|span| span.text.as_str()).collect())
                .unwrap_or_default();
            text_map.insert(t, content);
            t
        }
        _ if children.is_empty() => taffy.new_leaf(style).ok()?,
        _ => taffy.new_with_children(style, &children).ok()?,
    };

    node_map.insert(id, taffy_node);
    Some(taffy_node)
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
        top: prop_number(props, "top").map(length_auto).unwrap_or(LengthPercentageAuto::Auto),
        right: prop_number(props, "right").map(length_auto).unwrap_or(LengthPercentageAuto::Auto),
        bottom: prop_number(props, "bottom").map(length_auto).unwrap_or(LengthPercentageAuto::Auto),
        left: prop_number(props, "left").map(length_auto).unwrap_or(LengthPercentageAuto::Auto),
    };

    let (padding, border, size) = (
        prop_number(props, "padding"),
        prop_number(props, "border"),
        (prop_number(props, "width"), prop_number(props, "height")),
    );

    TaffyStyle {
        display: Display::Flex,
        flex_direction,
        justify_content,
        align_items,
        align_content,
        gap: TaffySize {
            width: column_gap.or(gap).map(length).unwrap_or(LengthPercentage::Length(0.0)),
            height: row_gap.or(gap).map(length).unwrap_or(LengthPercentage::Length(0.0)),
        },
        padding: match padding {
            Some(p) => taffy::geometry::Rect {
                left: length(p),
                right: length(p),
                top: length(p),
                bottom: length(p),
            },
            None => taffy::geometry::Rect::zero(),
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
        size: TaffySize {
            width: size.0.map(dimension).unwrap_or(Dimension::Auto),
            height: size.1.map(dimension).unwrap_or(Dimension::Auto),
        },
        min_size: TaffySize {
            width: prop_number(props, "min_width").map(dimension).unwrap_or(Dimension::Auto),
            height: prop_number(props, "min_height").map(dimension).unwrap_or(Dimension::Auto),
        },
        max_size: TaffySize {
            width: prop_number(props, "max_width").map(dimension).unwrap_or(Dimension::Auto),
            height: prop_number(props, "max_height").map(dimension).unwrap_or(Dimension::Auto),
        },
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

/// Read a boolean property.
fn prop_bool(props: &PropMap, key: &str) -> Option<bool> {
    match props.get(key) {
        Some(PropValue::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// Display width of a string in terminal cells (multi-width aware).
fn display_width(content: &str) -> usize {
    UnicodeWidthStr::width(content)
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
        scene.add_child(parent, NodeKind::Box, CellStyle::new()).expect("add box")
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
        set_prop(&mut scene, root, "flex_direction", PropValue::Str("column".into()));
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
    fn text_leaf_is_sized_to_content() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start alignment keeps the leaf at its measured height of 1
        // instead of stretching to the container height.
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
        let t = scene.add_text(root, "Hello", CellStyle::new()).expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 5, 1));
    }

    #[test]
    fn text_measure_is_multi_width_aware() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
        // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
        let t = scene.add_text(root, "コa", CellStyle::new()).expect("add text");

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        assert_eq!(rect_of(&out, t), Rect::new(0, 0, 3, 1));
    }

    #[test]
    fn streaming_text_leaf_is_sized_to_concatenated_content() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start alignment keeps the leaf at its measured height of 1
        // instead of stretching to the container height.
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        assert!(scene.append_span(s, Span { text: "Hello".into(), style: CellStyle::new() }));
        assert!(scene.append_span(s, Span { text: " world".into(), style: CellStyle::new() }));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 10));
        // "Hello" (5) + " world" (6) -> 11 cells.
        assert_eq!(rect_of(&out, s), Rect::new(0, 0, 11, 1));
    }

    #[test]
    fn streaming_text_measure_is_multi_width_aware() {
        let mut scene = new_scene();
        let root = scene.root_id();
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        // 'コ' is a 2-cell wide char; 'a' is 1 cell -> width 3.
        assert!(scene.append_span(s, Span { text: "コ".into(), style: CellStyle::new() }));
        assert!(scene.append_span(s, Span { text: "a".into(), style: CellStyle::new() }));

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
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
        let s = scene
            .add_child(root, NodeKind::StreamingText, CellStyle::new())
            .expect("add streaming text");
        set_prop(&mut scene, s, "wrap", PropValue::Bool(false));
        assert!(scene.append_span(s, Span { text: "abc def".into(), style: CellStyle::new() }));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        // 7-cell content width ('abc def') in a 5-wide container: the leaf
        // keeps its intrinsic width and overflows; height stays 1 (single row).
        assert_eq!(rect_of(&out, s), Rect::new(0, 0, 7, 1));
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
            set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));
            set_prop(&mut scene, root, "align_content", PropValue::Str(value.into()));
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
        let style =
            props_to_style(&PropMap::from([("min_width".to_string(), PropValue::Int(5))]));
        assert_eq!(style.min_size.width, Dimension::Length(5.0));
        assert_eq!(style.min_size.height, Dimension::Auto);
        let style = props_to_style(&PropMap::new());
        assert_eq!(
            style.min_size,
            TaffySize { width: Dimension::Auto, height: Dimension::Auto }
        );
        assert_eq!(
            style.max_size,
            TaffySize { width: Dimension::Auto, height: Dimension::Auto }
        );
    }

    #[test]
    fn min_max_size_clamps_explicit_size() {
        let mut scene = new_scene();
        let root = scene.root_id();
        // flex-start keeps children at their explicit heights (no stretch).
        set_prop(&mut scene, root, "align_items", PropValue::Str("flex-start".into()));

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

        let style =
            props_to_style(&PropMap::from([("position".to_string(), PropValue::Str("relative".into()))]));
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
        set_prop(&mut scene, parent, "position", PropValue::Str("relative".into()));
        let abs = add_box(&mut scene, parent);
        set_prop(&mut scene, abs, "position", PropValue::Str("absolute".into()));
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
        set_prop(&mut scene, abs, "position", PropValue::Str("absolute".into()));
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
        set_prop(&mut scene, abs, "position", PropValue::Str("absolute".into()));
        set_prop(&mut scene, abs, "top", PropValue::Int(0));
        set_prop(&mut scene, abs, "left", PropValue::Int(15));
        set_prop(&mut scene, abs, "width", PropValue::Int(10));
        set_prop(&mut scene, abs, "height", PropValue::Int(10));

        let out = TaffyLayoutEngine::new().compute(&scene, Size::new(100, 50));
        // a keeps the row-start slot; abs overlaps at x=15 without pushing it.
        assert_eq!(rect_of(&out, a), Rect::new(0, 0, 10, 10));
        assert_eq!(rect_of(&out, abs), Rect::new(15, 0, 10, 10));
    }
}
