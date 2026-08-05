//! Incremental-path correctness regression tests (round 2, subtask 4).
//!
//! The compositor is stateful and incremental: `paint_scene` on a warm
//! compositor runs the incremental layout engine (tern-layout's cached taffy
//! tree, reconciled in place) plus dirty-region repaint. This file pins the
//! correctness contract of that path: for the **same scene** the incremental
//! frame must equal a **fresh compositor's full recompute** (full tree
//! rebuild + full paint, the oracle) cell-for-cell — character, style and
//! display width — and the diff vs the previous frame must be identical, so
//! the renderer's terminal output is unchanged no matter which path produced
//! the frame.
//!
//! Four mutation classes are exercised, each as a **multi-frame sequence**
//! (mutate -> paint -> mutate -> paint -> ...) asserting parity at every
//! frame:
//!
//! 1. single-cell text change (including a wide character, which changes
//!    both layout and the masked continuation cells);
//! 2. single style change — layout-affecting (`width` / `padding`) and
//!    non-layout-affecting (cell `Style` colors/modifiers, which must not
//!    disturb the layout cache at all);
//! 3. structural add/remove of nodes, including middle-layer nodes (a box
//!    holding children) added to and removed from the tree;
//! 4. mixed changes — several text + style + structural mutations between
//!    two consecutive frames.
//!
//! Round 3 adds a fifth class: the **mutation-site pushed dirty set**. The
//! scene records the id of every mutated node, and `paint_dirty` compares
//! paint signatures only for those pushed ids (with a whole-tree fallback for
//! raw `node_mut` borrows). The pushed-path tests below pin that the
//! signature narrowing never loses a change the rect comparison cannot see —
//! paint-only mutations whose geometry is untouched (clip/scroll prop
//! changes, stream appends, raw borrows) — while keeping cell-for-cell
//! parity with the oracle.
//!
//! On a mismatch the failure message reports the scenario, the frame index,
//! and the first differing cell (x, y, ch, style, width) on both buffers —
//! never a weakened assertion.
//!
//! The warm-up frame (frame 0) runs both paths from a cold cache (both are
//! full paints by construction) and validates the harness itself; every later
//! frame runs the incremental path against the full-recompute oracle.

use tern_components::Compositor;
use tern_core::buffer::Buffer;
use tern_core::color::Color;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropValue, Scene, Span};
use tern_core::style::{Modifiers, Style};

/// The viewport every parity scene is painted at. Large enough to host
/// nested panels, small enough that full paints stay cheap.
const VIEWPORT: Size = Size::new(80, 24);

/// The ids of the non-trivial parity scene's mutable nodes.
#[derive(Debug, Clone, Copy)]
struct SceneIds {
    row: NodeId,
    left: NodeId,
    text: NodeId,
    right: NodeId,
    stream: NodeId,
    overlay: NodeId,
}

/// A non-trivial scene: a padded column root holding a header and a body row
/// of three boxes — one with a text leaf, one with a text leaf, one with a
/// streaming leaf and an absolutely-positioned, z-ordered overlay — so every
/// mutation class has real geometry (and real painted cells) to disturb.
fn parity_scene() -> (Scene, SceneIds) {
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene.set_prop(root, "flex_direction", PropValue::Str("column".into()));
    scene.set_prop(root, "padding", PropValue::Int(1));

    let header = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(header, "width", PropValue::Int(78));
    scene.set_prop(header, "height", PropValue::Int(2));
    let _title = scene.add_text(header, "Header", Style::new()).unwrap();

    let row = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
    scene.set_prop(row, "width", PropValue::Int(78));
    scene.set_prop(row, "height", PropValue::Int(16));

    let left = scene
        .add_child(row, NodeKind::Box, Style::new().bg(Color::Indexed(4)))
        .unwrap();
    scene.set_prop(left, "width", PropValue::Int(18));
    scene.set_prop(left, "height", PropValue::Int(14));
    let text = scene.add_text(left, "Hello", Style::new()).unwrap();

    let mid = scene
        .add_child(row, NodeKind::Box, Style::new().bg(Color::Indexed(5)))
        .unwrap();
    scene.set_prop(mid, "width", PropValue::Int(20));
    scene.set_prop(mid, "height", PropValue::Int(14));
    let _mtext = scene.add_text(mid, "Middle", Style::new()).unwrap();

    let right = scene
        .add_child(row, NodeKind::Box, Style::new().bg(Color::Indexed(6)))
        .unwrap();
    scene.set_prop(right, "width", PropValue::Int(20));
    scene.set_prop(right, "height", PropValue::Int(14));
    let stream = scene
        .add_child(right, NodeKind::StreamingText, Style::new())
        .unwrap();
    assert!(scene.append_span(
        stream,
        Span {
            text: "s1".into(),
            style: Style::new(),
        }
    ));
    let overlay = scene
        .add_child(right, NodeKind::Box, Style::new().bg(Color::Indexed(2)))
        .unwrap();
    scene.set_prop(overlay, "position", PropValue::Str("absolute".into()));
    scene.set_prop(overlay, "top", PropValue::Int(1));
    scene.set_prop(overlay, "left", PropValue::Int(2));
    scene.set_prop(overlay, "width", PropValue::Int(6));
    scene.set_prop(overlay, "height", PropValue::Int(2));
    scene.set_prop(overlay, "z_index", PropValue::Int(5));

    let ids = SceneIds {
        row,
        left,
        text,
        right,
        stream,
        overlay,
    };
    (scene, ids)
}

/// The first cell at which two buffers differ, as a human-readable diagnostic
/// (coordinates plus both cells' ch/style/width), or a size-mismatch note.
fn describe_first_diff(a: &Buffer, b: &Buffer) -> String {
    if a.width != b.width || a.height != b.height {
        return format!(
            "buffer sizes differ: incremental {}x{} vs full {}x{}",
            a.width, a.height, b.width, b.height
        );
    }
    for y in 0..a.height {
        for x in 0..a.width {
            let ca = a.cell(x, y).expect("x < width, y < height");
            let cb = b.cell(x, y).expect("x < width, y < height");
            if ca != cb {
                return format!("({x},{y}): incremental {ca:?} vs full {cb:?}");
            }
        }
    }
    "none".to_string()
}

/// Paint the current scene on the warm (incremental) compositor and on a
/// fresh compositor (the full-recompute oracle) and assert:
///
/// * the frame actually changed since `prev` when `expect_change` is set (the
///   mutation was observable — a silently no-op mutation must not pass);
/// * the two buffers are cell-for-cell identical (ch, style and width);
/// * the update diff vs `prev` is identical between the two paths.
///
/// On any mismatch the message carries the scenario name, the frame index and
/// the first differing cell.
fn assert_frame_parity(
    scenario: &str,
    frame: usize,
    warm: &mut Compositor,
    prev: &Buffer,
    scene: &Scene,
    expect_change: bool,
) -> Buffer {
    let dirty = warm.paint_scene(scene, VIEWPORT);
    if expect_change {
        assert!(
            dirty != *prev,
            "{scenario} frame {frame}: the mutation must produce a visible change"
        );
    }
    let mut fresh = Compositor::new();
    let full = fresh.paint_scene(scene, VIEWPORT);
    assert!(
        dirty == full,
        "{scenario} frame {frame}: the incremental buffer must equal a fresh full recompute cell-for-cell\nfirst difference: {}",
        describe_first_diff(&dirty, &full)
    );
    assert!(
        dirty.diff_from(prev) == full.diff_from(prev),
        "{scenario} frame {frame}: the update diff vs the previous frame must be identical between paths"
    );
    dirty
}

/// Run a multi-frame parity sequence: paint frame 0 on both paths (cold
/// cache, harness validation), then apply `mutate(scene, ids, frame)` before
/// frames 1..=frames and assert incremental/full parity after every one.
fn run_incremental_parity_sequence(
    scenario: &str,
    scene: &mut Scene,
    ids: &SceneIds,
    frames: usize,
    mutate: impl FnMut(&mut Scene, &SceneIds, usize),
) {
    let mut warm = Compositor::new();
    let blank = Buffer::new(VIEWPORT.width, VIEWPORT.height);
    let mut prev = assert_frame_parity(scenario, 0, &mut warm, &blank, scene, false);
    let mut mutate = mutate;
    for frame in 1..=frames {
        mutate(scene, ids, frame);
        prev = assert_frame_parity(scenario, frame, &mut warm, &prev, scene, true);
    }
}

// ---------------------------------------------------------------------------
// 1. Single-cell text change
// ---------------------------------------------------------------------------

#[test]
fn incremental_buffer_parity_on_single_cell_text_change() {
    // One text leaf mutated across frames: grow (layout shifts), shrink, and
    // a wide character (multi-width painting + masked continuation cells).
    let (mut scene, ids) = parity_scene();
    let texts = ["Hello, wider world", "Hi", "コa"];
    run_incremental_parity_sequence(
        "single-cell text change",
        &mut scene,
        &ids,
        texts.len(),
        |scene, ids, frame| {
            assert!(scene.set_prop(ids.text, "text", PropValue::Str(texts[frame - 1].into())));
        },
    );
}

// ---------------------------------------------------------------------------
// 2. Single style change
// ---------------------------------------------------------------------------

#[test]
fn incremental_buffer_parity_on_layout_affecting_style_change() {
    // Layout-affecting style mutations: a box width change (shifts its
    // siblings), then a box padding change (shifts its children inside).
    let (mut scene, ids) = parity_scene();
    run_incremental_parity_sequence(
        "layout-affecting style change",
        &mut scene,
        &ids,
        2,
        |scene, ids, frame| match frame {
            1 => {
                assert!(scene.set_prop(ids.left, "width", PropValue::Int(10)));
            }
            2 => {
                assert!(scene.set_prop(ids.left, "padding", PropValue::Int(2)));
            }
            _ => unreachable!("frame {frame}"),
        },
    );
}

#[test]
fn incremental_buffer_parity_on_non_layout_style_change() {
    // Non-layout-affecting style mutations: cell `Style` changes (colors,
    // modifiers). Geometry is untouched — the layout cache must not be
    // disturbed — but the painted cells' style changes, so the dirty path has
    // real work to do. The last frame also restyles a box's background fill.
    let (mut scene, ids) = parity_scene();
    let styles = [
        Style::new().fg(Color::Indexed(1)),
        Style::new().fg(Color::Rgb(1, 2, 3)).bg(Color::Indexed(4)),
        Style::new()
            .fg(Color::Indexed(9))
            .add_modifier(Modifiers::BOLD),
        Style::new().bg(Color::Indexed(7)),
    ];
    run_incremental_parity_sequence(
        "non-layout style change",
        &mut scene,
        &ids,
        styles.len(),
        |scene, ids, frame| {
            let target = if frame == styles.len() {
                ids.left
            } else {
                ids.text
            };
            assert!(scene.set_style(target, styles[frame - 1]));
        },
    );
}

// ---------------------------------------------------------------------------
// 3. Structural add/remove (including middle-layer nodes)
// ---------------------------------------------------------------------------

#[test]
fn incremental_buffer_parity_on_structural_add_remove() {
    // Structural mutations across frames: add a middle-layer subtree (a box
    // with two text leaves), remove a middle-layer subtree (the right box
    // holding its stream and overlay), add a nested subtree under a surviving
    // box, then remove a leaf.
    let (mut scene, ids) = parity_scene();
    run_incremental_parity_sequence(
        "structural add/remove",
        &mut scene,
        &ids,
        4,
        |scene, ids, frame| {
            let root = scene.root_id();
            match frame {
                1 => {
                    // A middle-layer node: a panel box with two text children.
                    let panel = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
                    scene.set_prop(panel, "width", PropValue::Int(30));
                    scene.set_prop(panel, "height", PropValue::Int(3));
                    let t1 = scene.add_text(panel, "new A", Style::new()).unwrap();
                    scene.set_prop(t1, "width", PropValue::Int(10));
                    let t2 = scene.add_text(panel, "new B", Style::new()).unwrap();
                    scene.set_prop(t2, "width", PropValue::Int(10));
                }
                2 => {
                    // Remove a middle-layer subtree (box + stream + overlay).
                    assert!(scene.remove(ids.right), "removing the right subtree");
                }
                3 => {
                    // Re-add a nested subtree under a surviving box.
                    let inner = scene
                        .add_child(ids.left, NodeKind::Box, Style::new())
                        .unwrap();
                    scene.set_prop(inner, "width", PropValue::Int(10));
                    scene.set_prop(inner, "height", PropValue::Int(2));
                    let _label = scene.add_text(inner, "inner", Style::new()).unwrap();
                }
                4 => {
                    // Remove a leaf.
                    assert!(scene.remove(ids.text), "removing the text leaf");
                }
                _ => unreachable!("frame {frame}"),
            }
        },
    );
}

// ---------------------------------------------------------------------------
// 4. Multi-node mixed changes in a single frame
// ---------------------------------------------------------------------------

#[test]
fn incremental_buffer_parity_on_mixed_multi_node_changes() {
    // Several text + style + structural mutations between consecutive frames:
    // the whole change class set at once, per the round-2 target workload.
    let (mut scene, ids) = parity_scene();
    run_incremental_parity_sequence(
        "mixed multi-node changes",
        &mut scene,
        &ids,
        3,
        |scene, ids, frame| {
            let root = scene.root_id();
            match frame {
                1 => {
                    // text + layout style + structural add, same frame.
                    assert!(scene.set_prop(ids.text, "text", PropValue::Str("Mixed".into())));
                    assert!(scene.set_prop(ids.left, "width", PropValue::Int(12)));
                    let extra = scene.add_text(ids.row, "extra", Style::new()).unwrap();
                    scene.set_prop(extra, "width", PropValue::Int(10));
                }
                2 => {
                    // color style + stream append + structural remove, same frame.
                    assert!(scene.set_style(ids.text, Style::new().fg(Color::Indexed(5))));
                    assert!(scene.append_span(
                        ids.stream,
                        Span {
                            text: " s2".into(),
                            style: Style::new(),
                        }
                    ));
                    assert!(scene.remove(ids.overlay), "removing the overlay");
                }
                3 => {
                    // wide-char text + padding + add middle-layer subtree +
                    // remove leaf, same frame.
                    assert!(scene.set_prop(ids.text, "text", PropValue::Str("コ".into())));
                    assert!(scene.set_prop(ids.left, "padding", PropValue::Int(1)));
                    let panel = scene.add_child(root, NodeKind::Box, Style::new()).unwrap();
                    scene.set_prop(panel, "width", PropValue::Int(12));
                    scene.set_prop(panel, "height", PropValue::Int(2));
                    let _label = scene.add_text(panel, "x", Style::new()).unwrap();
                    assert!(scene.remove(ids.stream), "removing the stream leaf");
                }
                _ => unreachable!("frame {frame}"),
            }
        },
    );
}

// ---------------------------------------------------------------------------
// Bonus: unchanged frames must not drift from the oracle
// ---------------------------------------------------------------------------

#[test]
fn incremental_buffer_parity_on_unchanged_frames() {
    // The same scene painted repeatedly without mutation: the incremental
    // path returns the retained buffer (the NoPaint path). It must still
    // equal a fresh full recompute — the retained state must never drift.
    let (scene, _ids) = parity_scene();
    let mut warm = Compositor::new();
    let blank = Buffer::new(VIEWPORT.width, VIEWPORT.height);
    let mut prev = assert_frame_parity("unchanged frames", 0, &mut warm, &blank, &scene, false);
    for frame in 1..=3 {
        prev = assert_frame_parity("unchanged frames", frame, &mut warm, &prev, &scene, false);
    }
    assert!(
        !prev.diff_from(&blank).is_empty(),
        "the scene actually painted cells"
    );
}

// ---------------------------------------------------------------------------
// Regression pin: repaint clobbering outside the dirty union
// ---------------------------------------------------------------------------

// GENUINE INCREMENTAL-PATH DEFECT (found by this suite, NOT fixed — fixing
// production code is out of scope for this subtask):
//
// `Compositor::paint_dirty` repaints every node whose painted bounds
// intersect the dirty union over that node's FULL bounds. When such a node's
// painted area is larger than the union — e.g. a `bg`-filled box that merely
// contains a changed child — the repaint writes cells OUTSIDE the union that
// belong to other nodes; those other nodes are not repainted (they do not
// intersect the union), so their cells are left with the clobbering paint
// instead of their own content.
//
// Failure case (as observed): `structural add/remove` frame 3 above, and the
// dedicated test below — adding a child inside a `bg`-filled box wipes a
// sibling text leaf whose cells lie outside the dirty union. The fresh
// full-recompute oracle paints the box background first and the text glyphs
// on top, so it keeps the glyphs; the incremental path does not.
//
// The assertion below is deliberately NOT weakened: the suite must stay red
// until the production defect is fixed, so this regression cannot silently
// re-appear.

#[test]
fn incremental_buffer_parity_bg_repaint_must_not_clobber_outside_union() {
    let mut scene = Scene::new();
    let root = scene.root_id();
    assert!(scene.set_prop(root, "flex_direction", PropValue::Str("column".into())));
    assert!(scene.set_prop(root, "padding", PropValue::Int(1)));
    // A bg-filled box whose paint area extends far beyond the dirty union.
    let left = scene
        .add_child(root, NodeKind::Box, Style::new().bg(Color::Indexed(4)))
        .unwrap();
    assert!(scene.set_prop(left, "width", PropValue::Int(18)));
    assert!(scene.set_prop(left, "height", PropValue::Int(14)));
    let _text = scene.add_text(left, "Hello", Style::new()).unwrap();

    let mut warm = Compositor::new();
    let prev = warm.paint_scene(&scene, VIEWPORT);
    assert_eq!(
        prev,
        Compositor::new().paint_scene(&scene, VIEWPORT),
        "frame 0: baseline parity"
    );
    assert_eq!(prev.cell(1, 1).expect("in bounds").ch, 'H');

    // Frame 1: add a sibling box INSIDE the bg-filled box. The dirty union is
    // the new box's rect; the bg-filled parent intersects it and repaints its
    // full 18x14 bounds, clobbering the text leaf's cells at (1,1)-(5,1) that
    // lie outside the union. The leaf itself does not intersect the union and
    // is not repainted.
    let inner = scene.add_child(left, NodeKind::Box, Style::new()).unwrap();
    assert!(scene.set_prop(inner, "width", PropValue::Int(10)));
    assert!(scene.set_prop(inner, "height", PropValue::Int(2)));
    let inc = warm.paint_scene(&scene, VIEWPORT);
    let full = Compositor::new().paint_scene(&scene, VIEWPORT);
    assert_eq!(
        inc,
        full,
        "frame 1: adding a sibling inside a bg-filled box must not clobber the \
         text leaf outside the dirty union\nfirst difference: {}",
        describe_first_diff(&inc, &full)
    );
    assert_eq!(
        inc.diff_from(&prev),
        full.diff_from(&prev),
        "frame 1: the renderer diff must be identical between paths"
    );
    assert_eq!(
        inc.cell(1, 1).expect("in bounds").ch,
        'H',
        "frame 1: the text glyph inside the bg-filled box must survive the dirty repaint"
    );
    assert_eq!(full.cell(1, 1).expect("in bounds").ch, 'H');
}

// ---------------------------------------------------------------------------
// 5. Pushed-path mutations (round 3): the mutation-site pushed dirty set
// ---------------------------------------------------------------------------
//
// The scene records the id of every mutated node and `paint_dirty` compares
// paint signatures ONLY for those pushed ids. These tests pin that the
// narrowing never loses a change the all-node RECT comparison cannot see: a
// clip/scroll prop change, a stream append and a raw `node_mut` borrow all
// leave (or may leave) every layout rect untouched, so without the pushed
// set — or, for `node_mut`, without the force-full-scan fallback — the dirty
// pass would return the retained buffer unchanged and the parity harness
// below would fail with "the mutation must produce a visible change".

#[test]
fn incremental_buffer_parity_on_clip_scroll_prop_changes() {
    // Paint-only prop changes on a dedicated text leaf: a clip rect trims the
    // glyphs and a scroll offset pans them (buffer = scene - scroll, so a
    // positive scroll pans content up/left inside the clip window). `clip_*`
    // / `scroll_*` are compositor-consumed, never layout keywords, so every
    // layout rect stays identical across frames — the rect-vs-rect comparison
    // sees nothing, and only the pushed ids (recorded by set_clip_rect /
    // set_scroll_offset) keep the dirty pass honest. Each frame's mutation
    // visibly changes the pane:
    //
    //   frame 1: clip to 10 cells wide           -> "abcdefghij"  (trimmed)
    //   frame 2: scroll +2, +0                   -> "cdefghijkl"  (panned left)
    //   frame 3: scroll +2, +1                   -> blank (row panned out)
    //   frame 4: scroll reset, clip to x[4,12)   -> "efghijkl"    (window moved)
    let mut scene = Scene::new();
    let root = scene.root_id();
    let t = scene
        .add_text(root, "abcdefghijklmnopqrs", Style::new())
        .unwrap();
    assert!(scene.set_prop(t, "width", PropValue::Int(20)));
    assert!(scene.set_prop(t, "height", PropValue::Int(1)));

    let mut warm = Compositor::new();
    let blank = Buffer::new(VIEWPORT.width, VIEWPORT.height);
    let mut prev = assert_frame_parity(
        "clip/scroll prop change",
        0,
        &mut warm,
        &blank,
        &scene,
        false,
    );
    for frame in 1..=4 {
        match frame {
            1 => assert!(scene.set_clip_rect(t, Rect::new(0, 0, 10, 1))),
            2 => assert!(scene.set_scroll_offset(t, 2, 0)),
            3 => assert!(scene.set_scroll_offset(t, 2, 1)),
            4 => {
                assert!(scene.set_scroll_offset(t, 0, 0));
                assert!(scene.set_clip_rect(t, Rect::new(4, 0, 8, 1)));
            }
            _ => unreachable!("frame {frame}"),
        }
        prev = assert_frame_parity(
            "clip/scroll prop change",
            frame,
            &mut warm,
            &prev,
            &scene,
            true,
        );
    }
}

#[test]
fn incremental_buffer_parity_on_stream_append() {
    // Dedicated stream-append pushed path: appending a span mutates only the
    // streaming leaf (append_span records its id), so the dirty pass must
    // repaint the leaf's region from a retained buffer — styled spans, a wide
    // character, and a hard line break included.
    let (mut scene, ids) = parity_scene();
    run_incremental_parity_sequence("stream append", &mut scene, &ids, 4, |scene, ids, frame| {
        let span = match frame {
            1 => Span {
                text: " tail".into(),
                style: Style::new(),
            },
            2 => Span {
                text: "コ".into(),
                style: Style::new(),
            },
            3 => Span {
                text: " styled".into(),
                style: Style::new().fg(Color::Indexed(3)),
            },
            4 => Span {
                text: "\nsecond".into(),
                style: Style::new().add_modifier(Modifiers::BOLD),
            },
            _ => unreachable!("frame {frame}"),
        };
        assert!(scene.append_span(ids.stream, span));
    });
}

#[test]
fn incremental_buffer_parity_on_raw_node_mut() {
    // The force-full-scan fallback: a raw `node_mut` borrow is opaque to the
    // scene, so it records the id AND sets the force flag, and the dirty pass
    // falls back to the whole-tree signature walk. The painted output must
    // still equal a fresh full recompute cell-for-cell.
    let (mut scene, ids) = parity_scene();
    run_incremental_parity_sequence("raw node_mut", &mut scene, &ids, 3, |scene, ids, frame| {
        match frame {
            1 => {
                // Rewrite the text prop through the raw borrow.
                let n = scene.node_mut(ids.text).expect("text node exists");
                n.props
                    .insert("text".to_string(), PropValue::Str("raw!".into()));
            }
            2 => {
                // Restyle the left box's background through the raw borrow.
                let n = scene.node_mut(ids.left).expect("left box exists");
                n.style.bg = Color::Indexed(1);
            }
            3 => {
                // Push a span straight into the stream field, bypassing
                // append_span entirely.
                let n = scene.node_mut(ids.stream).expect("stream node exists");
                let stream = n.stream.get_or_insert_with(Vec::new);
                stream.push(Span {
                    text: " raw".into(),
                    style: Style::new(),
                });
            }
            _ => unreachable!("frame {frame}"),
        }
    });
}
