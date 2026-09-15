//! Tests for the terminal backend. The helpers below are shared by more
//! than one of the submodules.

use super::*;
use tern_core::buffer::Buffer;
use tern_core::cell::Cell;
use tern_core::style::Style;

mod lifecycle;
mod flush;
mod scroll;
mod caret;
mod sgr;
mod a11y;



/// Run the diff flusher against an in-memory buffer and return the bytes.
/// Each call starts with an unknown prior park position, so the empty-diff
/// fast path never suppresses a single-shot flush.
fn flush(updates: &[CellUpdate], cursor_pos: (u16, u16)) -> Vec<u8> {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    flush_diff_to(&mut out, updates, cursor_pos, &mut last_flush_pos)
        .expect("flush should succeed");
    out
}

/// Run the scroll flusher against an in-memory buffer and return the
/// bytes. Each call starts with an unknown prior park position, so the
/// empty-updates fast path never suppresses a single-shot flush.
fn flush_scroll(op: &ScrollOp, updates: &[CellUpdate], cursor_pos: (u16, u16)) -> Vec<u8> {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    flush_scroll_to(&mut out, op, updates, cursor_pos, &mut last_flush_pos)
        .expect("scroll flush should succeed");
    out
}

/// Apply a [`ScrollOp`] plus its exposed-band updates to `prev`,
/// simulating what the terminal does on the other end of
/// [`flush_scroll_to`]: shift the region's rows up/down by `op.rows`,
/// then overwrite the exposed band with `updates`. This is the semantic
/// model the byte stream must produce; the model tests assert it
/// reconstructs the next frame's buffer cell-for-cell.
fn apply_scroll_model(prev: &Buffer, op: &ScrollOp, updates: &[CellUpdate]) -> Buffer {
    let mut out = prev.clone();
    if op.up {
        // Content shifts up: row `y` takes row `y + rows`; the bottom
        // `rows` rows of the region are exposed (left as prev's content
        // until the updates overwrite them).
        for y in op.top..=(op.bottom.saturating_sub(op.rows)) {
            for x in 0..out.width {
                if let Some(src) = out.cell(x, y + op.rows).cloned() {
                    out.set_cell(x, y, src);
                }
            }
        }
    } else {
        // Content shifts down: row `y` takes row `y - rows`; the top
        // `rows` rows are exposed. Copy bottom-up so a row's source is
        // not overwritten before it is read.
        for y in (op.top.saturating_add(op.rows)..=op.bottom).rev() {
            for x in 0..out.width {
                if let Some(src) = out.cell(x, y - op.rows).cloned() {
                    out.set_cell(x, y, src);
                }
            }
        }
    }
    for u in updates {
        out.set_cell(
            u.x,
            u.y,
            Cell {
                ch: u.ch,
                symbol: u.symbol.clone(),
                style: u.style.clone(),
                width: u.width,
            },
        );
    }
    out
}

/// Assert two buffers match cell-for-cell, naming the first mismatch.
fn assert_buffer_eq(a: &Buffer, b: &Buffer) {
    assert_eq!(
        (a.width, a.height),
        (b.width, b.height),
        "buffer sizes must match"
    );
    for y in 0..a.height {
        for x in 0..a.width {
            assert_eq!(a.cell(x, y), b.cell(x, y), "cell ({x}, {y})");
        }
    }
}

fn update(x: u16, y: u16, ch: char, style: Style, width: u8, masked: bool) -> CellUpdate {
    CellUpdate {
        x,
        y,
        ch,
        symbol: None,
        style,
        width,
        masked,
    }
}

/// A cluster update: the lead cell of a multi-char grapheme cluster.
fn cluster_update(
    x: u16,
    y: u16,
    ch: char,
    symbol: &str,
    style: Style,
    width: u8,
) -> CellUpdate {
    CellUpdate {
        x,
        y,
        ch,
        symbol: Some(symbol.into()),
        style,
        width,
        masked: false,
    }
}
