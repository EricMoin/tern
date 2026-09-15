//! Tests for the taffy layout engine. The helpers below are shared by
//! more than one of the parts.

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

#[path = "tests/part1.rs"]
mod part1;
#[path = "tests/part2.rs"]
mod part2;
#[path = "tests/part3.rs"]
mod part3;
#[path = "tests/part4.rs"]
mod part4;
