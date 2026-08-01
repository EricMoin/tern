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
//! | `gap`             | `Int` \| `Float` (cells)                                             | 0      |
//! | `padding`         | `Int` \| `Float` (cells, uniform)                                    | 0      |
//! | `border`          | `Int` \| `Float` (cells, uniform border width)                       | 0      |
//! | `width` / `height`| `Int` \| `Float` (cells)                                             | auto   |
//! | `text`            | `Str` — content of a `Text` leaf                                     | —      |
//!
//! Nodes with `display: none` (and their whole subtree) are skipped: they get
//! no taffy node and are absent from the returned [`Rect`] list.
//!
//! The scene root fills the viewport unless it declares its own size.

use std::collections::HashMap;

use taffy::geometry::Size as TaffySize;
use taffy::style::{
    AlignItems, AvailableSpace, Dimension, Display, FlexDirection, JustifyContent,
    LengthPercentage, Style as TaffyStyle,
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

    // The scene root fills the viewport unless it declares its own size.
    if is_root && !node.props.contains_key("width") && !node.props.contains_key("height") {
        style.size = TaffySize {
            width: Dimension::Length(viewport.width as f32),
            height: Dimension::Length(viewport.height as f32),
        };
    }

    // Text nodes are leaves; build their (by construction empty) children
    // list and register the content for measurement.
    let children: Vec<TaffyNodeId> = if node.kind == NodeKind::Text {
        Vec::new()
    } else {
        node.children
            .iter()
            .filter_map(|&child| build_node(scene, child, viewport, false, taffy, node_map, text_map))
            .collect()
    };

    let taffy_node = if node.kind == NodeKind::Text {
        let t = taffy.new_leaf(style).ok()?;
        if let Some(PropValue::Str(content)) = node.props.get("text") {
            text_map.insert(t, content.clone());
        }
        t
    } else if children.is_empty() {
        taffy.new_leaf(style).ok()?
    } else {
        taffy.new_with_children(style, &children).ok()?
    };

    node_map.insert(id, taffy_node);
    Some(taffy_node)
}

/// Translate a scene node's `props` into a taffy `Style`.
fn props_to_style(props: &PropMap) -> TaffyStyle {
    let length = LengthPercentage::Length;
    let dimension = Dimension::Length;

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

    let (gap, padding, border, size) = (
        prop_number(props, "gap"),
        prop_number(props, "padding"),
        prop_number(props, "border"),
        (prop_number(props, "width"), prop_number(props, "height")),
    );

    TaffyStyle {
        display: Display::Flex,
        flex_direction,
        justify_content,
        align_items,
        gap: match gap {
            Some(g) => TaffySize { width: length(g), height: length(g) },
            None => TaffySize::zero(),
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
    use tern_core::scene::Scene;
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
}
