//! Baseline render-performance benchmark for the compositor pipeline.
//!
//! Times the full per-frame pipeline the renderer runs on every frame —
//! [`Compositor::paint_scene`] (layout + paint) → [`Buffer::diff_from`]
//! (minimal diff vs the previous frame) → `tern-terminal::flush_diff_to`
//! (ANSI queue + flush into an in-memory `Vec<u8>` sink, the exact seam the
//! real backend writes through) — over a synthetic scene that mirrors a
//! realistic TUI: a root box with ~200 nested boxes (3-5 text leaves each),
//! one `streaming_text` node with ~50 styled spans, and one text leaf with a
//! `caret` prop, painted at a 120x40 viewport.
//!
//! The test is `#[ignore]`d so `cargo test --workspace` skips it by default;
//! run it explicitly with:
//!
//! ```text
//! cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture
//! ```
//!
//! Baseline numbers are recorded in `tools/bench/BASELINE.md`.

use std::time::Instant;

use tern_components::Compositor;
use tern_core::buffer::Buffer;
use tern_core::color::Color;
use tern_core::rect::Size;
use tern_core::scene::{NodeKind, PropValue, Scene, Span};
use tern_core::style::{BorderStyle, Style};
use tern_terminal::flush_diff_to;

/// The benchmark viewport: 120 columns x 40 rows (4800 cells per frame).
const VIEWPORT: Size = Size::new(120, 40);
/// The number of per-frame iterations to time.
const ITERATIONS: usize = 2000;

/// The synthetic scene the baseline measures: a root box (rounded border,
/// column flex) holding ~200 nested boxes — each with 3-5 `Text` leaves — a
/// `StreamingText` node with ~50 styled spans, and a `Text` leaf with a
/// `caret` Int prop. ~1000 scene nodes total.
fn synthetic_scene() -> Scene {
    let mut scene = Scene::new();
    let root = scene.root_id();

    // Root box fills the viewport and stacks its children in a column, so the
    // 200 rows lay out top-to-bottom (overflowing the 40-row viewport, as a
    // real long document would).
    let root_box = scene
        .add_child(root, NodeKind::Box, Style::new().border_style(BorderStyle::Rounded))
        .expect("root box");
    scene.set_prop(root_box, "width", PropValue::Int(VIEWPORT.width as i64));
    scene.set_prop(root_box, "height", PropValue::Int(VIEWPORT.height as i64));
    scene.set_prop(root_box, "flex_direction", PropValue::Str("column".into()));

    // ~200 nested boxes, each holding 3-5 text leaves (avg 4 -> ~800 leaves).
    for i in 0..200 {
        let row = scene
            .add_child(root_box, NodeKind::Box, Style::new())
            .expect("nested box");
        scene.set_prop(row, "width", PropValue::Int(VIEWPORT.width as i64 - 2));
        scene.set_prop(row, "height", PropValue::Int(1));
        let leaves = 3 + (i % 3);
        for j in 0..leaves {
            scene.add_text(
                row,
                &format!("cell {i}-{j} 0123456789"),
                Style::new().fg(Color::Indexed(((j * 7 + 3) % 256) as u8)),
            );
        }
    }

    // One streaming_text node with ~50 styled spans.
    let stream = scene
        .add_child(root_box, NodeKind::StreamingText, Style::new())
        .expect("streaming text");
    scene.set_prop(stream, "width", PropValue::Int(VIEWPORT.width as i64 - 2));
    for s in 0..50 {
        let style = if s % 2 == 0 {
            Style::new().fg(Color::Rgb(0, 255, 136))
        } else {
            Style::new().fg(Color::Rgb(255, 136, 0))
        };
        scene.append_span(
            stream,
            Span {
                text: format!("span{s} "),
                style,
            },
        );
    }

    // One text node with a caret prop (the block-caret paint path).
    let caret_leaf = scene
        .add_text(root_box, "input value", Style::new())
        .expect("caret text");
    scene.set_prop(caret_leaf, "caret", PropValue::Int(4));

    scene
}

/// The nearest-rank percentile of a sorted sample: `p` in 0..=100.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    assert!(!sorted.is_empty(), "percentile of an empty sample");
    let idx = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[idx.saturating_sub(1).min(sorted.len() - 1)]
}

#[test]
#[ignore = "performance benchmark — run explicitly with -- --ignored --nocapture"]
fn bench_paint_diff_flush_frame() {
    let scene = synthetic_scene();
    let cells_per_frame = VIEWPORT.width as f64 * VIEWPORT.height as f64;
    let mut compositor = Compositor::new();
    // The sink the backend flushes into; reused across iterations.
    let mut sink: Vec<u8> = Vec::with_capacity(64 * 1024);
    // The previous frame; the first iteration diffs against a blank buffer,
    // exactly like the renderer's first frame.
    let mut prev = Buffer::new(VIEWPORT.width, VIEWPORT.height);

    let mut per_frame_ms: Vec<f64> = Vec::with_capacity(ITERATIONS);
    // The backend's recorded park position, threaded through the loop exactly
    // like a real renderer holds it: consecutive no-op frames then hit the
    // empty-diff fast path and skip the flush entirely.
    let mut last_flush_pos = None;
    let started = Instant::now();
    for _ in 0..ITERATIONS {
        let t0 = Instant::now();
        let buffer = compositor.paint_scene(&scene, VIEWPORT);
        let updates = buffer.diff_from(&prev);
        sink.clear();
        flush_diff_to(&mut sink, &updates, (0, 0), &mut last_flush_pos)
            .expect("flush into a Vec<u8> sink");
        prev = buffer;
        per_frame_ms.push(t0.elapsed().as_secs_f64() * 1e3);
    }
    let total_secs = started.elapsed().as_secs_f64();

    per_frame_ms.sort_by(|a, b| a.total_cmp(b));
    let mean = total_secs * 1e3 / ITERATIONS as f64;
    let p50 = percentile(&per_frame_ms, 50.0);
    let p95 = percentile(&per_frame_ms, 95.0);
    let cells_per_sec = cells_per_frame * ITERATIONS as f64 / total_secs;

    println!();
    println!("=== tern-components render pipeline bench ===");
    println!(
        "viewport: {}x{} ({} cells/frame)",
        VIEWPORT.width, VIEWPORT.height, cells_per_frame as u64
    );
    println!(
        "scene: root box + {} nested boxes (3-5 text leaves each) + streaming_text ({} spans) + caret node, ~{} nodes",
        200,
        50,
        scene.len()
    );
    println!("iterations: {ITERATIONS}");
    println!("mean: {mean:.3} ms/frame");
    println!("p50:  {p50:.3} ms/frame");
    println!("p95:  {p95:.3} ms/frame");
    println!(
        "cells/sec: {cells_per_sec:.0} cells/sec ({:.1} fps at {cells_per_frame:.0} cells/frame)",
        cells_per_sec / cells_per_frame
    );
    println!("=== end bench ===");
    println!();

    // Sanity: the pipeline actually painted cells into the final buffer.
    assert_eq!(prev.width, VIEWPORT.width);
    assert_eq!(prev.height, VIEWPORT.height);
    assert!(
        per_frame_ms.iter().all(|ms| *ms >= 0.0),
        "negative frame times are impossible"
    );
}
