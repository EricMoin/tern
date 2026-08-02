//! Imperative renderables: small builder objects that materialize into a
//! tern-core [`Scene`] tree.
//!
//! [`Text`] is a leaf that paints its content into its laid-out rect
//! (clipped to it). [`Box`] is a flex container that paints its background,
//! optional border glyphs, and a padding inset around its children. The
//! roadmap components — [`Input`](crate::Input), [`Spinner`](crate::Spinner),
//! [`Panels`](crate::Panels), [`StatusBar`](crate::StatusBar) — layer richer
//! interaction state on top of the same pattern: each is a plain-data struct
//! with builder helpers and editing/mutation methods that materializes as a
//! subtree of `Box`/`Text` scene nodes (see `docs/components.md`).
//!
//! Every container renderable exposes a *root frame* ([`Renderable::root_box`]:
//! the top-level box's style + layout props) plus its content
//! ([`Renderable::materialize_under`]). The compositor uses those to promote
//! the frame to the scene root when the renderable is painted as the top of a
//! tree, so a root `Box`/`StatusBar` fills the viewport.

use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene};
use tern_core::{Color, Modifiers, Style};

use crate::input::Input;
use crate::panels::Panels;
use crate::spinner::Spinner;
use crate::statusbar::StatusBar;

/// A node in an imperative component tree: a [`Text`] leaf, a [`Box`]
/// container, or one of the roadmap components.
#[derive(Debug, Clone)]
pub enum Renderable {
    /// A text leaf.
    Text(Text),
    /// A box container.
    Box(Box),
    /// A single-line text-entry field ([`Input`]).
    Input(Input),
    /// An animated progress indicator ([`Spinner`]).
    Spinner(Spinner),
    /// A stacked, collapsible panel container ([`Panels`]).
    Panels(Panels),
    /// A bottom status strip ([`StatusBar`]).
    StatusBar(StatusBar),
}

impl Renderable {
    /// Materialize this renderable as a new subtree under `parent`, returning
    /// the new node's id.
    ///
    /// Container renderables (and bare [`Box`]es) materialize their root frame
    /// as a new box node, then their content under it. A [`Text`] leaf adds a
    /// text node directly.
    pub(crate) fn materialize(&self, scene: &mut Scene, parent: NodeId) -> NodeId {
        match self {
            Renderable::Text(t) => scene
                .add_text(parent, &t.content, t.style)
                .expect("text node materialized under an existing parent"),
            other => {
                let frame = other
                    .root_box()
                    .expect("container renderables carry a root frame");
                let id = scene
                    .add_child(parent, NodeKind::Box, frame.style)
                    .expect("container node materialized under an existing parent");
                for (key, value) in frame.to_props() {
                    scene.set_prop(id, &key, value);
                }
                other.materialize_under(scene, id);
                id
            }
        }
    }

    /// The root frame of a container renderable: the top-level box's style and
    /// layout props (without children), used by the compositor to promote the
    /// frame to the scene root when this renderable is painted as the top of a
    /// tree. `None` for bare [`Text`] roots.
    pub(crate) fn root_box(&self) -> Option<Box> {
        match self {
            Renderable::Box(b) => Some(b.clone()),
            Renderable::Input(i) => Some(i.frame()),
            Renderable::Spinner(s) => Some(s.frame()),
            Renderable::Panels(p) => Some(p.frame()),
            Renderable::StatusBar(sb) => Some(sb.frame()),
            Renderable::Text(_) => None,
        }
    }

    /// Materialize everything below the (already-promoted) root frame under
    /// `parent`. For a bare [`Box`] that is its children; for a roadmap
    /// component, its content.
    pub(crate) fn materialize_under(&self, scene: &mut Scene, parent: NodeId) {
        match self {
            Renderable::Box(b) => {
                for child in &b.children {
                    child.materialize(scene, parent);
                }
            }
            Renderable::Input(i) => i.materialize_content(scene, parent),
            Renderable::Spinner(s) => s.materialize_content(scene, parent),
            Renderable::Panels(p) => p.materialize_content(scene, parent),
            Renderable::StatusBar(sb) => sb.materialize_content(scene, parent),
            Renderable::Text(_) => {}
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
