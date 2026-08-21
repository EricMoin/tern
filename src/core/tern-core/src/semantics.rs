//! The semantics store: accessibility-relevant metadata for scene nodes.
//!
//! A parallel map of [`SemanticsNode`] keyed by scene node id, recording what
//! each interactive node *is* (role) and *communicates* (label, state,
//! enabled, selected) for assistive technology: screen readers, a11y test
//! bridges, and the M4.2 output channel.
//!
//! The store is pure bookkeeping. It is read only through
//! [`Scene::semantics`](crate::Scene::semantics) /
//! [`Scene::semantics_iter`](crate::Scene::semantics_iter); layout and the
//! compositor never touch it, and no semantics write can change painted
//! content (semantics mutations bump the scene epoch but never push a dirty
//! id — see [`Scene::set_semantics`](crate::Scene::set_semantics)).

use std::collections::HashSet;
use std::str::FromStr;

/// The accessibility role of a scene node, following the WAI-ARIA role
/// vocabulary: each variant's [`as_str`](SemanticsRole::as_str) name is the
/// ARIA role string for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SemanticsRole {
    /// An interactive push button.
    Button,
    /// A checkable toggle with a two-state value (checked / unchecked).
    Checkbox,
    /// A single selectable member of a radio group.
    Radio,
    /// A set of [`Radio`](SemanticsRole::Radio) members of which exactly one
    /// is checked.
    RadioGroup,
    /// An on/off toggle, distinct from a checkbox in that it does not submit
    /// a form value.
    Switch,
    /// A set of [`MenuItem`](SemanticsRole::MenuItem) choices.
    Menu,
    /// A single choice inside a menu.
    MenuItem,
    /// A list of selectable options, typically presented in a popup.
    Listbox,
    /// A single- or multi-line text entry field.
    Textbox,
    /// A navigation link to another location.
    Link,
    /// A generic container grouping related controls.
    Group,
}

impl SemanticsRole {
    /// The ARIA role name of this role (e.g. `"radiogroup"`, `"menuitem"`).
    pub const fn as_str(&self) -> &'static str {
        match self {
            SemanticsRole::Button => "button",
            SemanticsRole::Checkbox => "checkbox",
            SemanticsRole::Radio => "radio",
            SemanticsRole::RadioGroup => "radiogroup",
            SemanticsRole::Switch => "switch",
            SemanticsRole::Menu => "menu",
            SemanticsRole::MenuItem => "menuitem",
            SemanticsRole::Listbox => "listbox",
            SemanticsRole::Textbox => "textbox",
            SemanticsRole::Link => "link",
            SemanticsRole::Group => "group",
        }
    }
}

impl FromStr for SemanticsRole {
    type Err = ();

    /// Parse an ARIA role name (as produced by [`SemanticsRole::as_str`])
    /// into a [`SemanticsRole`]. Unknown or differently-cased names yield
    /// `Err(())`.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "button" => Ok(SemanticsRole::Button),
            "checkbox" => Ok(SemanticsRole::Checkbox),
            "radio" => Ok(SemanticsRole::Radio),
            "radiogroup" => Ok(SemanticsRole::RadioGroup),
            "switch" => Ok(SemanticsRole::Switch),
            "menu" => Ok(SemanticsRole::Menu),
            "menuitem" => Ok(SemanticsRole::MenuItem),
            "listbox" => Ok(SemanticsRole::Listbox),
            "textbox" => Ok(SemanticsRole::Textbox),
            "link" => Ok(SemanticsRole::Link),
            "group" => Ok(SemanticsRole::Group),
            _ => Err(()),
        }
    }
}

/// A single semantics state flag carried by a node. A node can hold several
/// at once (e.g. checked + focused); see [`SemanticsNode::state`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SemanticsState {
    /// The node is checked (checkbox / radio / switch).
    Checked,
    /// The node currently has keyboard focus.
    Focused,
    /// The node's disclosure is open (menu, listbox, group).
    Expanded,
    /// The node's disclosure is closed.
    Collapsed,
}

/// The accessibility semantics of a scene node: what it is
/// ([`SemanticsNode::role`]) and what it communicates ([`SemanticsNode::label`],
/// [`SemanticsNode::state`], [`SemanticsNode::enabled`],
/// [`SemanticsNode::selected`]).
///
/// Pure data, owned by the scene's parallel semantics map; layout and the
/// compositor never read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticsNode {
    /// What kind of control this node is (button, checkbox, ...).
    pub role: SemanticsRole,
    /// The node's accessible name (what a screen reader announces), or `None`
    /// when the node carries no label.
    pub label: Option<String>,
    /// The boolean semantics states currently active on the node.
    pub state: HashSet<SemanticsState>,
    /// Whether the control is interactive: `false` for a disabled/read-only
    /// control.
    pub enabled: bool,
    /// Whether the node is currently selected (a row in a listbox, an option
    /// in a menu).
    pub selected: bool,
}

impl SemanticsNode {
    /// A default-enabled, unselected, unlabelled node with the given role.
    pub fn new(role: SemanticsRole) -> Self {
        Self {
            role,
            label: None,
            state: HashSet::new(),
            enabled: true,
            selected: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_names_roundtrip_through_as_str_and_from_str() {
        // Every role serializes to its ARIA name and parses back to itself:
        // the two directions are exact inverses.
        let roles = [
            SemanticsRole::Button,
            SemanticsRole::Checkbox,
            SemanticsRole::Radio,
            SemanticsRole::RadioGroup,
            SemanticsRole::Switch,
            SemanticsRole::Menu,
            SemanticsRole::MenuItem,
            SemanticsRole::Listbox,
            SemanticsRole::Textbox,
            SemanticsRole::Link,
            SemanticsRole::Group,
        ];
        for role in roles {
            let name = role.as_str();
            assert_eq!(name.parse::<SemanticsRole>(), Ok(role), "{name:?}");
        }
    }

    #[test]
    fn role_names_match_aria_strings() {
        assert_eq!(SemanticsRole::Button.as_str(), "button");
        assert_eq!(SemanticsRole::Checkbox.as_str(), "checkbox");
        assert_eq!(SemanticsRole::Radio.as_str(), "radio");
        assert_eq!(SemanticsRole::RadioGroup.as_str(), "radiogroup");
        assert_eq!(SemanticsRole::Switch.as_str(), "switch");
        assert_eq!(SemanticsRole::Menu.as_str(), "menu");
        assert_eq!(SemanticsRole::MenuItem.as_str(), "menuitem");
        assert_eq!(SemanticsRole::Listbox.as_str(), "listbox");
        assert_eq!(SemanticsRole::Textbox.as_str(), "textbox");
        assert_eq!(SemanticsRole::Link.as_str(), "link");
        assert_eq!(SemanticsRole::Group.as_str(), "group");
    }

    #[test]
    fn unknown_and_miscased_role_names_fail_to_parse() {
        for bad in ["Button", "BUTTON", "radiogroup ", " radiogroup", "toggle", "", "menu-item"] {
            assert_eq!(bad.parse::<SemanticsRole>(), Err(()), "{bad:?} must not parse");
        }
    }

    #[test]
    fn new_node_defaults_to_enabled_unselected_unlabelled() {
        let n = SemanticsNode::new(SemanticsRole::Checkbox);
        assert_eq!(n.role, SemanticsRole::Checkbox);
        assert_eq!(n.label, None);
        assert!(n.state.is_empty());
        assert!(n.enabled);
        assert!(!n.selected);
    }

    #[test]
    fn node_carries_state_flags_and_label() {
        let mut n = SemanticsNode::new(SemanticsRole::Checkbox);
        n.label = Some("mute".to_string());
        n.state.insert(SemanticsState::Checked);
        n.state.insert(SemanticsState::Focused);
        n.selected = true;

        assert_eq!(n.label.as_deref(), Some("mute"));
        assert!(n.state.contains(&SemanticsState::Checked));
        assert!(n.state.contains(&SemanticsState::Focused));
        assert!(n.selected);

        // A disabled node is distinct from an enabled one (a11y consumers
        // announce disabled controls differently).
        assert!(n.enabled);
        n.enabled = false;
        assert!(!n.enabled);
    }
}
