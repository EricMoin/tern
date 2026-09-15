//! Tests for the text area component. The helpers below are shared by
//! more than one of the parts.

use super::*;

use crate::input::KeyAction;
use tern_core::scene::NodeKind;
use tern_core::style::Modifiers;
// The ZWJ family emoji (U+1F468 ZWJ U+1F469 ZWJ U+1F467 ZWJ U+1F466) is
// 7 chars in one cluster (char range 1..8 below); "e\u{301}" is a
// 2-char cluster. Written as escapes so the joiners cannot be lost in
// transit.
const FAMILY: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";

#[path = "tests/part1.rs"]
mod part1;
#[path = "tests/part2.rs"]
mod part2;
