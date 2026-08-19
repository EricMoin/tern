use super::*;
use crate::canvas::Canvas;
use crate::input::Input;
use crate::panels::{Panel, Panels};
use crate::renderable::{Box, Text};
use crate::spinner::Spinner;
use crate::statusbar::{Segment, SegmentAlign, StatusBar};
use tern_core::scene::Span;
use tern_core::style::{Modifiers, Style};

mod text;
mod box_border;
mod streaming;
mod components;
mod selection;
mod regions;
mod dirty;

/// Paint a renderable tree and return it as a `Vec<String>` grid for
/// debugging and golden comparisons.
fn render_rows(root: impl Into<Renderable>, viewport: Size) -> Vec<String> {
    let mut compositor = Compositor::new();
    let buffer = compositor.paint(root, viewport);
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                .collect()
        })
        .collect()
}

/// Reconstruct rows with FULL cluster symbols from a buffer (masked
/// continuation cells as spaces), mirroring tern-node's `buffer_rows` —
/// for grapheme-cluster golden comparisons.
fn buffer_rows_clusters(buffer: &Buffer) -> Vec<String> {
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| {
                    buffer.cell(x, y).map_or_else(
                        || " ".to_string(),
                        |c| {
                            if c.is_masked() {
                                " ".to_string()
                            } else {
                                c.symbol_str().into_owned()
                            }
                        },
                    )
                })
                .collect()
        })
        .collect()
}

/// Paint a raw scene and return it as a `Vec<String>` grid for golden
/// comparisons.
fn render_scene_rows(scene: &Scene, viewport: Size) -> Vec<String> {
    let mut compositor = Compositor::new();
    let buffer = compositor.paint_scene(scene, viewport);
    (0..buffer.height)
        .map(|y| {
            (0..buffer.width)
                .map(|x| buffer.cell(x, y).map(|c| c.ch).unwrap_or(' '))
                .collect()
        })
        .collect()
}

/// The character at (`x`, `y`) in a buffer, or a space outside it.
fn cell_char(buffer: &Buffer, x: i32, y: i32) -> char {
    if x < 0 || y < 0 || x >= buffer.width as i32 || y >= buffer.height as i32 {
        return ' ';
    }
    buffer.cell(x as u16, y as u16).map(|c| c.ch).unwrap_or(' ')
}

/// A scene with a `StreamingText` child sized to `width` x `height` at the
/// origin of a same-sized viewport.
fn streaming_scene(width: i64, height: i64) -> Scene {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let s = scene
        .add_child(root, NodeKind::StreamingText, Style::new())
        .expect("add streaming text");
    scene.set_prop(s, "width", PropValue::Int(width));
    scene.set_prop(s, "height", PropValue::Int(height));
    scene
}
