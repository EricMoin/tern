//! Imperative renderables: small builder objects that materialize into a
//! tern-core [`Scene`] tree.
//!
//! [`Text`] is a leaf that paints its content into its laid-out rect
//! (clipped to it). [`Box`] is a flex container that paints its background,
//! optional border glyphs, and a padding inset around its children. Both are
//! plain data plus builder helpers, mirroring the imperative component model
//! of the render pipeline (see `docs/architecture.md`, stages 5-6).

use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene};
use tern_core::{Color, Modifiers, Style};

/// A node in an imperative component tree: either a [`Text`] leaf or a
/// [`Box`] container.
#[derive(Debug, Clone)]
pub enum Renderable {
    /// A text leaf.
    Text(Text),
    /// A box container.
    Box(Box),
}

impl Renderable {
    /// Materialize this renderable as a new subtree under `parent`, returning
    /// the new node's id.
    pub(crate) fn materialize(&self, scene: &mut Scene, parent: NodeId) -> NodeId {
        match self {
            Renderable::Text(t) => scene
                .add_text(parent, &t.content, t.style)
                .expect("text node materialized under an existing parent"),
            Renderable::Box(b) => {
                let id = scene
                    .add_child(parent, NodeKind::Box, b.style)
                    .expect("box node materialized under an existing parent");
                for (key, value) in b.to_props() {
                    scene.set_prop(id, &key, value);
                }
                for child in &b.children {
                    child.materialize(scene, id);
                }
                id
            }
        }
    }
}

impl From<Text> for Renderable {
    fn from(t: Text) -> Self {
        Renderable::Text(t)
    }
}

impl From<Box> for Renderable {
    fn from(b: Box) -> Self {
        Renderable::Box(b)
    }
}

/// A text leaf: paints `content` into its laid-out rect, clipped to it.
#[derive(Debug, Clone)]
pub struct Text {
    /// The text content.
    pub content: String,
    /// The visual style of the painted cells.
    pub style: Style,
}

impl Text {
    /// A text leaf with the given content and style.
    pub fn new(content: impl Into<String>, style: Style) -> Self {
        Self {
            content: content.into(),
            style,
        }
    }

    /// Builder: set the foreground color.
    pub fn fg(mut self, color: Color) -> Self {
        self.style = self.style.fg(color);
        self
    }

    /// Builder: set the background color.
    pub fn bg(mut self, color: Color) -> Self {
        self.style = self.style.bg(color);
        self
    }

    /// Builder: add a text modifier.
    pub fn modifier(mut self, modifier: Modifiers) -> Self {
        self.style = self.style.add_modifier(modifier);
        self
    }

    /// Builder: bold text.
    pub fn bold(self) -> Self {
        self.modifier(Modifiers::BOLD)
    }

    /// Builder: dim text.
    pub fn dim(self) -> Self {
        self.modifier(Modifiers::DIM)
    }

    /// Builder: italic text.
    pub fn italic(self) -> Self {
        self.modifier(Modifiers::ITALIC)
    }

    /// Builder: underlined text.
    pub fn underline(self) -> Self {
        self.modifier(Modifiers::UNDERLINE)
    }
}

/// A box container: a flex layout region that paints its background, optional
/// border glyphs, and a padding inset, then lets its children paint on top.
///
/// Layout keywords (flex direction, gap, padding, border, size) ride on the
/// node's `props` map, matching the tern-layout prop vocabulary.
#[derive(Debug, Clone)]
pub struct Box {
    /// The visual style of the box (colors, modifiers, border style).
    pub style: Style,
    /// Ordered children.
    pub children: Vec<Renderable>,
    /// `display` layout keyword (`flex` | `none`).
    pub display: Option<String>,
    /// `flex_direction` layout keyword.
    pub flex_direction: Option<String>,
    /// `justify_content` layout keyword.
    pub justify_content: Option<String>,
    /// `align_items` layout keyword.
    pub align_items: Option<String>,
    /// `gap` in cells.
    pub gap: Option<i64>,
    /// Uniform `padding` in cells.
    pub padding: Option<i64>,
    /// Uniform `border` width in cells.
    pub border: Option<i64>,
    /// Explicit `width` in cells.
    pub width: Option<i64>,
    /// Explicit `height` in cells.
    pub height: Option<i64>,
}

impl Box {
    /// A box with the given style and children.
    pub fn new(style: Style, children: Vec<Renderable>) -> Self {
        Self {
            style,
            children,
            display: None,
            flex_direction: None,
            justify_content: None,
            align_items: None,
            gap: None,
            padding: None,
            border: None,
            width: None,
            height: None,
        }
    }

    /// Builder: set the `display` keyword.
    pub fn display(mut self, value: impl Into<String>) -> Self {
        self.display = Some(value.into());
        self
    }

    /// Builder: set the `flex_direction` keyword (`row` | `column` | ...).
    pub fn flex_direction(mut self, value: impl Into<String>) -> Self {
        self.flex_direction = Some(value.into());
        self
    }

    /// Builder: stack children vertically (`flex_direction: column`).
    pub fn column(mut self) -> Self {
        self.flex_direction = Some("column".to_string());
        self
    }

    /// Builder: lay children out horizontally (`flex_direction: row`).
    pub fn row(mut self) -> Self {
        self.flex_direction = Some("row".to_string());
        self
    }

    /// Builder: set the `justify_content` keyword.
    pub fn justify_content(mut self, value: impl Into<String>) -> Self {
        self.justify_content = Some(value.into());
        self
    }

    /// Builder: set the `align_items` keyword.
    pub fn align_items(mut self, value: impl Into<String>) -> Self {
        self.align_items = Some(value.into());
        self
    }

    /// Builder: set the inter-child `gap` in cells.
    pub fn gap(mut self, cells: i64) -> Self {
        self.gap = Some(cells);
        self
    }

    /// Builder: set the uniform `padding` in cells.
    pub fn padding(mut self, cells: i64) -> Self {
        self.padding = Some(cells);
        self
    }

    /// Builder: set the uniform `border` width in cells.
    pub fn border(mut self, cells: i64) -> Self {
        self.border = Some(cells);
        self
    }

    /// Builder: set the explicit `width` in cells.
    pub fn width(mut self, cells: i64) -> Self {
        self.width = Some(cells);
        self
    }

    /// Builder: set the explicit `height` in cells.
    pub fn height(mut self, cells: i64) -> Self {
        self.height = Some(cells);
        self
    }

    /// Append a child (convenience for building trees without a `Vec`).
    pub fn child(mut self, child: Renderable) -> Self {
        self.children.push(child);
        self
    }

    /// The set layout keywords as a tern-core property map.
    pub(crate) fn to_props(&self) -> PropMap {
        let mut props = PropMap::new();
        if let Some(v) = &self.display {
            props.insert("display".to_string(), PropValue::Str(v.clone()));
        }
        if let Some(v) = &self.flex_direction {
            props.insert("flex_direction".to_string(), PropValue::Str(v.clone()));
        }
        if let Some(v) = &self.justify_content {
            props.insert("justify_content".to_string(), PropValue::Str(v.clone()));
        }
        if let Some(v) = &self.align_items {
            props.insert("align_items".to_string(), PropValue::Str(v.clone()));
        }
        if let Some(v) = self.gap {
            props.insert("gap".to_string(), PropValue::Int(v));
        }
        if let Some(v) = self.padding {
            props.insert("padding".to_string(), PropValue::Int(v));
        }
        if let Some(v) = self.border {
            props.insert("border".to_string(), PropValue::Int(v));
        }
        if let Some(v) = self.width {
            props.insert("width".to_string(), PropValue::Int(v));
        }
        if let Some(v) = self.height {
            props.insert("height".to_string(), PropValue::Int(v));
        }
        props
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderables_materialize_into_scene() {
        let tree = Renderable::Box(
            Box::new(Style::new(), vec![Text::new("Hi", Style::new()).into()])
                .padding(1)
                .column(),
        );

        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = tree.materialize(&mut scene, root);

        let node = scene.node(id).unwrap();
        assert_eq!(node.kind, NodeKind::Box);
        assert_eq!(node.props.get("padding"), Some(&PropValue::Int(1)));
        assert_eq!(
            node.props.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        assert_eq!(scene.children(id).unwrap().len(), 1);
        let text_id = scene.children(id).unwrap()[0];
        assert_eq!(scene.node(text_id).unwrap().kind, NodeKind::Text);
        assert_eq!(
            scene.prop(text_id, "text"),
            Some(&PropValue::Str("Hi".to_string()))
        );
    }

    #[test]
    fn text_builder_helpers_chain_styles() {
        let t = Text::new("x", Style::new()).fg(Color::Rgb(1, 2, 3)).bold().underline();
        assert_eq!(t.content, "x");
        assert_eq!(t.style.fg, Color::Rgb(1, 2, 3));
        assert!(t.style.modifiers.contains(Modifiers::BOLD));
        assert!(t.style.modifiers.contains(Modifiers::UNDERLINE));
    }
}
