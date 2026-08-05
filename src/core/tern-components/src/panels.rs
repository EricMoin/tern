//! [`Panels`] — a stacked, collapsible panel container.
//!
//! A column (or row) of [`Panel`]s, each with a header row (title + collapse
//! toggle) and a body. Collapsing a panel hides its body, keeping only the
//! header. The container tracks which panel (if any) is `active` so the app's
//! focus model can route keys to the right panel. Materializes into a scene as
//! a flex container box whose children are per-panel column boxes.

use tern_core::scene::{NodeId, NodeKind, PropValue, Scene};
use tern_core::style::Style;

use crate::renderable::{Box, Renderable};

/// One collapsible panel: a header (title + toggle) and a body renderable.
#[derive(Debug, Clone)]
pub struct Panel {
    /// The panel title, painted in the header row.
    pub title: String,
    /// The body content, hidden while the panel is collapsed.
    pub body: Renderable,
    /// Whether the body is currently hidden.
    pub collapsed: bool,
    /// Whether the header shows a collapse toggle (default true).
    pub collapsible: bool,
    /// The header text style.
    pub header_style: Style,
    /// The style of the body region (background, border).
    pub body_style: Style,
}

impl Panel {
    /// A panel with the given title and body.
    pub fn new(title: impl Into<String>, body: impl Into<Renderable>) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
            collapsed: false,
            collapsible: true,
            header_style: Style::new(),
            body_style: Style::new(),
        }
    }

    /// Builder: start the panel collapsed.
    pub fn collapsed(mut self) -> Self {
        self.collapsed = true;
        self
    }

    /// Builder: hide the collapse toggle.
    pub fn not_collapsible(mut self) -> Self {
        self.collapsible = false;
        self
    }

    /// Builder: set the header style.
    pub fn header_style(mut self, style: Style) -> Self {
        self.header_style = style;
        self
    }

    /// Builder: set the body region style.
    pub fn body_style(mut self, style: Style) -> Self {
        self.body_style = style;
        self
    }

    /// The header line: the toggle glyph (when collapsible) plus the title.
    pub fn header_text(&self, expanded_glyph: char, collapsed_glyph: char) -> String {
        if !self.collapsible {
            return self.title.clone();
        }
        let toggle = if self.collapsed {
            collapsed_glyph
        } else {
            expanded_glyph
        };
        format!("{toggle} {}", self.title)
    }
}

/// A container of stacked, collapsible panels.
#[derive(Debug, Clone)]
pub struct Panels {
    /// The panels, in stacking order.
    pub panels: Vec<Panel>,
    /// The container style (background, border).
    pub style: Style,
    /// Gap between panels in cells.
    pub gap: i64,
    /// Stacking direction: `Some("column")` (default) or `Some("row")`.
    pub direction: Option<String>,
    /// The currently focused panel index (part of the app's focus model).
    pub active: Option<usize>,
    /// The toggle glyphs for expanded / collapsed headers.
    pub toggle_glyphs: (char, char),
}

impl Panels {
    /// A container with the given panels.
    pub fn new(panels: Vec<Panel>) -> Self {
        Self {
            panels,
            style: Style::new(),
            gap: 1,
            direction: Some("column".to_string()),
            active: None,
            toggle_glyphs: ('▾', '▸'),
        }
    }

    /// Builder: set the container style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Builder: stack panels vertically (the default).
    pub fn column(mut self) -> Self {
        self.direction = Some("column".to_string());
        self
    }

    /// Builder: lay panels out horizontally.
    pub fn row(mut self) -> Self {
        self.direction = Some("row".to_string());
        self
    }

    /// Builder: set the inter-panel gap in cells.
    pub fn gap(mut self, cells: i64) -> Self {
        self.gap = cells;
        self
    }

    /// Builder: set the expand/collapse toggle glyphs.
    pub fn toggles(mut self, expanded: char, collapsed: char) -> Self {
        self.toggle_glyphs = (expanded, collapsed);
        self
    }

    // --- Interaction state -----------------------------------------------

    /// Whether the panel at `index` is collapsed.
    pub fn is_collapsed(&self, index: usize) -> Option<bool> {
        self.panels.get(index).map(|p| p.collapsed)
    }

    /// Collapse the panel at `index`; `false` when out of range.
    pub fn collapse(&mut self, index: usize) -> bool {
        match self.panels.get_mut(index) {
            Some(p) => {
                p.collapsed = true;
                true
            }
            None => false,
        }
    }

    /// Expand the panel at `index`; `false` when out of range.
    pub fn expand(&mut self, index: usize) -> bool {
        match self.panels.get_mut(index) {
            Some(p) => {
                p.collapsed = false;
                true
            }
            None => false,
        }
    }

    /// Toggle the panel at `index`; `false` when out of range.
    pub fn toggle(&mut self, index: usize) -> bool {
        match self.panels.get_mut(index) {
            Some(p) => {
                p.collapsed = !p.collapsed;
                true
            }
            None => false,
        }
    }

    /// Focus the panel at `index`; `false` (no change) when out of range.
    pub fn set_active(&mut self, index: usize) -> bool {
        if index < self.panels.len() {
            self.active = Some(index);
            true
        } else {
            false
        }
    }

    /// The currently focused panel index.
    pub fn active(&self) -> Option<usize> {
        self.active
    }

    // --- Rendering -------------------------------------------------------

    /// The container frame as a bare box (style + layout props, no children).
    pub(crate) fn frame(&self) -> Box {
        let mut b = Box::new(self.style, vec![]).gap(self.gap);
        match self.direction.as_deref() {
            Some("row") => b = b.row(),
            _ => b = b.column(),
        }
        b
    }

    /// Materialize every panel (header + body) under `parent`.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        let (expanded_glyph, collapsed_glyph) = self.toggle_glyphs;
        for panel in &self.panels {
            let id = scene
                .add_child(parent, NodeKind::Box, panel.body_style)
                .expect("panel box under container");
            // A panel stacks its header above its body: the default flex
            // direction is row, which would sit them side by side.
            scene.set_prop(id, "flex_direction", PropValue::Str("column".to_string()));
            scene
                .add_text(
                    id,
                    &panel.header_text(expanded_glyph, collapsed_glyph),
                    panel.header_style,
                )
                .expect("panel header under panel");
            if !panel.collapsed {
                panel.body.materialize(scene, id);
            }
        }
    }
}

impl From<Panels> for Renderable {
    fn from(panels: Panels) -> Self {
        Renderable::Panels(panels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderable::{Renderable, Text};
    use tern_core::scene::PropValue;

    fn body(text: &str) -> Renderable {
        Text::new(text, Style::new()).into()
    }

    #[test]
    fn toggle_collapse_expand_state() {
        let mut panels = Panels::new(vec![
            Panel::new("one", body("a")),
            Panel::new("two", body("b")),
        ]);
        assert_eq!(panels.is_collapsed(0), Some(false));

        assert!(panels.toggle(0));
        assert_eq!(panels.is_collapsed(0), Some(true));
        assert!(panels.collapse(1));
        assert_eq!(panels.is_collapsed(1), Some(true));
        assert!(panels.expand(0));
        assert_eq!(panels.is_collapsed(0), Some(false));
        assert_eq!(panels.is_collapsed(1), Some(true));

        // Out-of-range accesses are rejected, never panic.
        assert_eq!(panels.is_collapsed(9), None);
        assert!(!panels.toggle(9));
        assert!(!panels.collapse(9));
        assert!(!panels.expand(9));
    }

    #[test]
    fn header_text_shows_toggle_and_title() {
        let open = Panel::new("log", body("x"));
        assert_eq!(open.header_text('▾', '▸'), "▾ log");

        let closed = Panel::new("log", body("x")).collapsed();
        assert_eq!(closed.header_text('▾', '▸'), "▸ log");

        let fixed = Panel::new("log", body("x")).not_collapsible();
        assert_eq!(fixed.header_text('▾', '▸'), "log");
    }

    #[test]
    fn active_focus_state() {
        let mut panels = Panels::new(vec![Panel::new("a", body("x")), Panel::new("b", body("y"))]);
        assert_eq!(panels.active(), None);
        assert!(panels.set_active(1));
        assert_eq!(panels.active(), Some(1));
        assert!(!panels.set_active(5)); // out of range rejected
        assert_eq!(panels.active(), Some(1));
    }

    #[test]
    fn collapsed_panel_omits_body() {
        let panels = Panels::new(vec![
            Panel::new("one", body("body-a")),
            Panel::new("two", body("body-b")).collapsed(),
        ]);
        let mut scene = Scene::new();
        let root = scene.root_id();
        let container = Renderable::from(panels).materialize(&mut scene, root);

        let panels_ids = scene.children(container).unwrap().to_vec();
        assert_eq!(panels_ids.len(), 2);

        // Panel 0 is expanded: header + body under it.
        let p0 = panels_ids[0];
        let p0_children = scene.children(p0).unwrap().to_vec();
        assert_eq!(p0_children.len(), 2);
        assert_eq!(
            scene.prop(p0_children[0], "text"),
            Some(&PropValue::Str("▾ one".to_string()))
        );
        assert_eq!(
            scene.prop(p0_children[1], "text"),
            Some(&PropValue::Str("body-a".to_string()))
        );

        // Panel 1 is collapsed: header only.
        let p1 = panels_ids[1];
        let p1_children = scene.children(p1).unwrap().to_vec();
        assert_eq!(p1_children.len(), 1);
        assert_eq!(
            scene.prop(p1_children[0], "text"),
            Some(&PropValue::Str("▸ two".to_string()))
        );
    }

    #[test]
    fn panels_materialize_in_stack_order() {
        let panels = Panels::new(vec![
            Panel::new("first", body("1")),
            Panel::new("second", body("2")),
        ]);
        let mut scene = Scene::new();
        let root = scene.root_id();
        let container = Renderable::from(panels).materialize(&mut scene, root);

        // The container is a column with a 1-cell gap.
        assert_eq!(
            scene.node(container).unwrap().props.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        assert_eq!(
            scene.node(container).unwrap().props.get("gap"),
            Some(&PropValue::Int(1))
        );

        let panels_ids = scene.children(container).unwrap().to_vec();
        assert_eq!(panels_ids.len(), 2);
        let first_header = scene.children(panels_ids[0]).unwrap()[0];
        assert_eq!(
            scene.prop(first_header, "text"),
            Some(&PropValue::Str("▾ first".to_string()))
        );
    }

    #[test]
    fn row_direction_lays_panels_horizontally() {
        let panels =
            Panels::new(vec![Panel::new("a", body("x")), Panel::new("b", body("y"))]).row();
        let mut scene = Scene::new();
        let root = scene.root_id();
        let container = Renderable::from(panels).materialize(&mut scene, root);
        assert_eq!(
            scene.node(container).unwrap().props.get("flex_direction"),
            Some(&PropValue::Str("row".to_string()))
        );
    }

    // --- Paint-path tests (through the compositor) -----------------------

    #[test]
    fn paint_collapsed_panel_hides_body() {
        let panels = Panels::new(vec![
            Panel::new("one", body("body-a")).collapsed(),
            Panel::new("two", body("body-b")),
        ]);
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(panels, tern_core::Size::new(20, 5));
        let rows: Vec<String> = (0..5)
            .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
            .collect();

        // Row 0: the collapsed panel's header (toggle + title), body omitted.
        assert!(rows[0].starts_with("▸ one"), "row0 = {:?}", rows[0]);
        // Row 1: the inter-panel gap.
        assert!(rows[1].trim().is_empty());
        // Rows 2-3: the expanded panel's header then its body.
        assert!(rows[2].starts_with("▾ two"), "row2 = {:?}", rows[2]);
        assert!(rows[3].starts_with("body-b"), "row3 = {:?}", rows[3]);
        // The collapsed panel's body never painted.
        assert!(!rows.iter().any(|r| r.contains("body-a")));
    }

    #[test]
    fn paint_expanded_panels_stack_in_column() {
        let panels = Panels::new(vec![
            Panel::new("first", body("1")),
            Panel::new("second", body("2")),
        ]);
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(panels, tern_core::Size::new(20, 5));
        let rows: Vec<String> = (0..5)
            .map(|y| (0..20).map(|x| buffer.cell(x, y).unwrap().ch).collect())
            .collect();
        // Panel 1 (header + body), the 1-cell gap, then panel 2.
        assert!(rows[0].starts_with("▾ first"), "row0 = {:?}", rows[0]);
        assert!(rows[1].starts_with("1"), "row1 = {:?}", rows[1]);
        assert!(rows[2].trim().is_empty(), "row2 = {:?}", rows[2]);
        assert!(rows[3].starts_with("▾ second"), "row3 = {:?}", rows[3]);
        assert!(rows[4].starts_with("2"), "row4 = {:?}", rows[4]);
    }
}
