//! Tests for the scene tree. The helpers below are shared by
//! more than one of the parts.

use super::*;

use crate::color::Color;
use crate::semantics::{SemanticsNode, SemanticsRole};
use crate::style::{BorderStyle, Modifiers};
fn checkbox_node(label: &str) -> SemanticsNode {
    let mut n = SemanticsNode::new(SemanticsRole::Checkbox);
    n.label = Some(label.to_string());
    n
}

#[path = "tests/part1.rs"]
mod part1;
#[path = "tests/part2.rs"]
mod part2;
#[path = "tests/part3.rs"]
mod part3;
