//! Tests for the cell buffer. The helpers below are shared by
//! more than one of the parts.

use super::*;

use crate::style::Modifiers;
/// A one-row buffer sized to the display width of `text`.
fn string_row(text: &str) -> Buffer {
    let w: u16 = text
        .chars()
        .map(|c| char_width(c) as u16)
        .sum::<u16>()
        .max(1);
    let mut b = Buffer::new(w, 1);
    b.set_string(0, 0, text, Style::new());
    b
}

#[path = "tests/part1.rs"]
mod part1;
#[path = "tests/part2.rs"]
mod part2;
#[path = "tests/part3.rs"]
mod part3;
