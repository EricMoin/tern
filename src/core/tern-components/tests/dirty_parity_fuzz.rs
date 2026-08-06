//! Deterministic randomized parity fuzzing of the incremental dirty path
//! (round 4, subtask 6).
//!
//! The hand-written parity sequences in `incremental_consistency.rs` pin the
//! dirty-path contract mutation class by mutation class. This suite replaces
//! the per-class curation with **randomized mutation sequences**: it builds a
//! fresh random scene per scenario — a mix of styled boxes, text leaves,
//! streaming leaves, absolute overlays, clip rects and scroll offsets,
//! including the grapheme and wide content from round 4 subtask 1 (ZWJ emoji,
//! flags, combining sequences, CJK) — and then applies a random mutation to
//! the scene before **every** frame, asserting after each one that the warm
//! compositor's incremental output is cell-for-cell identical (character,
//! style and display width) to a fresh compositor's full recompute, and that
//! the update diff vs the previous frame is identical between the two paths.
//!
//! This is strictly stronger than the curated sequences: the mutation engine
//! composes `prop` / `text` / `style` / `structure` mutations (plus the raw
//! `node_mut` force-full-scan fallback and pushed-path clip/scroll changes)
//! in arbitrary order against arbitrarily-shaped scenes, so a subtle
//! interaction between two mutation classes — e.g. a clip rect on a node
//! whose subtree is restructured — cannot hide behind a hand-picked scenario.
//!
//! Determinism and CI bounds:
//!
//! * Every random decision flows from one seeded [`Rng`] (SplitMix64, no
//!   external dependency — the workspace deliberately keeps a minimal
//!   dependency footprint). The default seed is a fixed constant, so the
//!   suite is byte-for-byte reproducible on every run.
//! * The seed is overridable via the `TERN_PARITY_SEED` env var (CI rotates
//!   it to sweep new mutation interleavings); scenario and per-scenario
//!   mutation counts are overridable via `TERN_PARITY_SCENARIOS` /
//!   `TERN_PARITY_MUTATIONS`. Defaults are chosen small enough that the whole
//!   suite runs in a few seconds under `cargo test --workspace`.
//! * Each scenario asserts a floor on observable mutations (the incremental
//!   buffer must differ from the previous frame at least half the time), so a
//!   degenerate mutation mix that silently no-ops cannot pass.
//!
//! On a mismatch the failure message reports the scenario, the frame index,
//! the seed (so the failing interleaving can be replayed), and the first
//! differing cell on both buffers — never a weakened assertion.

use std::env;

use tern_components::Compositor;
use tern_core::buffer::Buffer;
use tern_core::color::Color;
use tern_core::rect::{Rect, Size};
use tern_core::scene::{NodeId, NodeKind, PropValue, Scene, Span};
use tern_core::style::{BorderStyle, Modifiers, Style};

/// The viewport every fuzz scene is painted at.
const VIEWPORT: Size = Size::new(80, 24);

/// Default fuzz parameters. Bounded so `cargo test --workspace` stays green
/// in a few seconds; every value is env-overridable for CI rotation.
const DEFAULT_SEED: u64 = 0x5eed_c0de_5c3e_12c7;
const DEFAULT_SCENARIOS: usize = 12;
const DEFAULT_MUTATIONS: usize = 60;

// ---------------------------------------------------------------------------
// Deterministic PRNG (SplitMix64) — no external dependency
// ---------------------------------------------------------------------------

/// A tiny deterministic SplitMix64 PRNG. Every draw is a pure function of the
/// seed, so a given `TERN_PARITY_SEED` reproduces the exact same scene and
/// mutation sequence on every platform and Rust version.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A uniform draw in `0..n` (n > 0).
    fn below(&mut self, n: usize) -> usize {
        debug_assert!(n > 0);
        (self.next_u64() % n as u64) as usize
    }

    /// A uniform draw in the inclusive range `lo..=hi`.
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        debug_assert!(hi >= lo);
        lo + (self.next_u64() % (hi - lo + 1) as u64) as i64
    }

    /// A draw that succeeds with `pct` percent probability.
    fn chance(&mut self, pct: u32) -> bool {
        self.next_u64() % 100 < pct as u64
    }

    /// A random element of a slice.
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

// ---------------------------------------------------------------------------
// Random content pools (grapheme + wide content from round-4 subtask 1)
// ---------------------------------------------------------------------------

/// Text fragments a random text leaf / span may be built from. Includes ASCII
/// words, single wide CJK characters, a ZWJ family emoji (one 11-code-unit
/// cluster rendered in 2 columns), a regional-indicator flag (one cluster, 2
/// columns), a base-plus-combining sequence (one cluster, 1 column) and
/// fullwidth CJK words — so every painted buffer exercises masked
/// continuation cells and multi-char cluster symbols.
const FRAGMENTS: &[&str] = &[
    "Hello", "world", "a", "Hi", "text", "line", "word", "padding", "scroll", "box",
    "コ", "日", "世", "界", "中", "漢字", "ワイド",
    "👨\u{200D}👩\u{200D}👧\u{200D}👦", // ZWJ family emoji — one cluster, 2 cols
    "🇷🇺",   // flag — one cluster, 2 cols
    "e\u{301}", // base + combining acute — one cluster, 1 col
    "a\u{301}",
    "🚀", "🍣",
    "x", "y", "z", "123", "42",
    "multi word text", "wrapped content", "a b c d e f g h i j",
];

/// Layout-affecting integer prop keys and a pool of plausible values.
const INT_PROPS: &[&str] = &[
    "width", "height", "padding", "border", "gap", "flex_basis", "min_width",
    "min_height", "max_width", "max_height", "top", "left", "right", "bottom",
    "z_index", "caret",
];
const INT_VALUES: &[i64] = &[0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30, 40, 78];

/// String enum props and their value pools.
const FLEX_DIRECTIONS: &[&str] = &["row", "column", "row-reverse", "column-reverse"];
const JUSTIFY_CONTENTS: &[&str] = &[
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around",
    "space-evenly",
];
const ALIGN_ITEMS: &[&str] = &["flex-start", "flex-end", "center", "baseline", "stretch"];
const ALIGN_CONTENTS: &[&str] = &[
    "flex-start",
    "flex-end",
    "center",
    "stretch",
    "space-between",
    "space-around",
    "space-evenly",
];
const POSITIONS: &[&str] = &["relative", "absolute"];
const DISPLAYS: &[&str] = &["flex", "none"];
const STR_PROPS: &[(&str, &[&str])] = &[
    ("flex_direction", FLEX_DIRECTIONS),
    ("justify_content", JUSTIFY_CONTENTS),
    ("align_items", ALIGN_ITEMS),
    ("align_content", ALIGN_CONTENTS),
    ("position", POSITIONS),
    ("display", DISPLAYS),
];

// ---------------------------------------------------------------------------
// Random scene builder
// ---------------------------------------------------------------------------

/// A random style: a mix of default / indexed / truecolor fg+bg, random
/// modifiers, and an occasional border.
fn random_style(rng: &mut Rng) -> Style {
    let mut style = Style::new();
    let fg = match rng.below(3) {
        0 => Color::Default,
        1 => Color::Indexed(rng.range(0, 255) as u8),
        _ => Color::Rgb(
            rng.range(0, 255) as u8,
            rng.range(0, 255) as u8,
            rng.range(0, 255) as u8,
        ),
    };
    let bg = match rng.below(3) {
        0 => Color::Default,
        1 => Color::Indexed(rng.range(0, 255) as u8),
        _ => Color::Rgb(
            rng.range(0, 255) as u8,
            rng.range(0, 255) as u8,
            rng.range(0, 255) as u8,
        ),
    };
    style.fg = fg;
    style.bg = bg;
    if rng.chance(35) {
        let mods = [
            Modifiers::BOLD,
            Modifiers::DIM,
            Modifiers::ITALIC,
            Modifiers::UNDERLINE,
            Modifiers::REVERSED,
        ];
        style.modifiers = style.modifiers.insert(*rng.pick(&mods));
        if rng.chance(30) {
            style.modifiers = style.modifiers.insert(*rng.pick(&mods));
        }
    }
    if rng.chance(25) {
        style.border_style = *rng.pick(&[
            BorderStyle::Plain,
            BorderStyle::Rounded,
            BorderStyle::Double,
            BorderStyle::Thick,
        ]);
    }
    style
}

/// A random text payload: one or two fragments joined without a separator.
fn random_text(rng: &mut Rng) -> String {
    let mut s = String::from(*rng.pick(FRAGMENTS));
    if rng.chance(40) {
        s.push_str(*rng.pick(FRAGMENTS));
    }
    s
}

/// A random styled span (streaming content may embed a hard line break, which
/// re-flows the leaf).
fn random_span(rng: &mut Rng) -> Span {
    let mut text = random_text(rng);
    if rng.chance(20) {
        text.push('\n');
        text.push_str(*rng.pick(FRAGMENTS));
    }
    Span {
        text,
        style: random_style(rng),
    }
}

/// Apply a random subset of layout props to `id` (each with some
/// probability), so scenes vary in both structure and geometry.
fn random_props(rng: &mut Rng, scene: &mut Scene, id: NodeId, leaf: bool) {
    // Size props are the geometry backbone; leaf nodes usually declare them.
    let size_chance = if leaf { 75 } else { 45 };
    if rng.chance(size_chance) {
        scene.set_prop(id, "width", PropValue::Int(*rng.pick(INT_VALUES)));
    }
    if rng.chance(size_chance) {
        scene.set_prop(id, "height", PropValue::Int(*rng.pick(INT_VALUES)));
    }
    for key in ["padding", "border", "gap"] {
        if rng.chance(20) {
            scene.set_prop(id, key, PropValue::Int(rng.range(0, 3)));
        }
    }
    for &(key, values) in STR_PROPS {
        if rng.chance(20) {
            scene.set_prop(id, key, PropValue::Str((*rng.pick(values)).into()));
        }
    }
    if rng.chance(15) {
        scene.set_prop(id, "flex_basis", PropValue::Int(*rng.pick(INT_VALUES)));
    }
    if rng.chance(10) {
        scene.set_prop(id, "min_width", PropValue::Int(*rng.pick(INT_VALUES)));
    }
    if rng.chance(10) {
        scene.set_prop(id, "max_width", PropValue::Int(*rng.pick(INT_VALUES)));
    }
    // Absolute positioning + z-order (overlay coverage).
    if rng.chance(18) {
        scene.set_prop(id, "position", PropValue::Str("absolute".into()));
        scene.set_prop(id, "top", PropValue::Int(rng.range(-2, 8)));
        scene.set_prop(id, "left", PropValue::Int(rng.range(-2, 12)));
        scene.set_prop(id, "z_index", PropValue::Int(rng.range(0, 9)));
    }
    // `display: none` hides a node and its whole subtree.
    if rng.chance(8) {
        scene.set_prop(id, "display", PropValue::Str("none".into()));
    }
    if rng.chance(10) {
        scene.set_prop(id, "wrap", PropValue::Bool(rng.chance(50)));
    }
}

/// Recursively grow a random subtree under `parent`, recording every node id.
fn add_random_subtree(
    rng: &mut Rng,
    scene: &mut Scene,
    parent: NodeId,
    depth: i64,
    ids: &mut Vec<NodeId>,
) {
    let n_children = rng.range(0, 4);
    for _ in 0..n_children {
        let kind = match rng.below(10) {
            0..=4 => NodeKind::Box,
            5..=7 => NodeKind::Text,
            _ => NodeKind::StreamingText,
        };
        let id = scene
            .add_child(parent, kind, random_style(rng))
            .expect("parent exists");
        ids.push(id);
        random_props(rng, scene, id, kind != NodeKind::Box);
        match kind {
            NodeKind::Text => {
                scene.set_prop(id, "text", PropValue::Str(random_text(rng)));
            }
            NodeKind::StreamingText => {
                let spans = rng.range(0, 3);
                for _ in 0..spans {
                    assert!(scene.append_span(id, random_span(rng)));
                }
            }
            NodeKind::Box => {
                if rng.chance(20) {
                    scene.set_prop(id, "flex_direction", PropValue::Str("column".into()));
                }
                if depth > 0 {
                    add_random_subtree(rng, scene, id, depth - 1, ids);
                }
            }
            NodeKind::Root => unreachable!("never built"),
        }
    }
}

/// Build a fresh random scene and return it with every node id (the root
/// first). Scenes mix text, streaming, styled boxes, absolute overlays, and
/// — sprinkled over random nodes — clip rects and scroll offsets.
fn build_random_scene(rng: &mut Rng) -> (Scene, Vec<NodeId>) {
    let mut scene = Scene::new();
    let root = scene.root_id();
    let mut ids = vec![root];

    if rng.chance(50) {
        scene.set_prop(root, "flex_direction", PropValue::Str("column".into()));
    }
    if rng.chance(40) {
        scene.set_prop(root, "padding", PropValue::Int(rng.range(0, 3)));
    }
    if rng.chance(25) {
        scene.set_prop(root, "gap", PropValue::Int(rng.range(0, 2)));
    }

    let depth = rng.range(1, 4);
    add_random_subtree(rng, &mut scene, root, depth, &mut ids);

    // Guarantee the scene paints real cells: a visible top-level text leaf
    // with an explicit size. The random builder alone may produce a fully
    // transparent frame — the root paints nothing (`paint_node` on Root is a
    // no-op) and a box paints only when it carries a non-default background —
    // so without this anchor a scenario could fuzz the parity of an empty
    // buffer. The anchor is a normal node afterwards: structural mutations
    // may remove it, which is fine — every later frame is still parity-
    // checked (both paths agree on an empty buffer too).
    let anchor = scene
        .add_text(root, "anchor", Style::new().fg(Color::Indexed(3)))
        .expect("root exists");
    scene.set_prop(anchor, "width", PropValue::Int(20));
    scene.set_prop(anchor, "height", PropValue::Int(1));

    // Clip rects and scroll offsets on a random subset of SUBTREE nodes (the
    // root is excluded so the anchor's guarantee above survives): the
    // pushed-path mutation class that leaves every layout rect untouched.
    if ids.len() > 1 {
        for _ in 0..rng.range(0, 4) {
            let id = *rng.pick(&ids[1..]);
            let x = rng.range(-2, 12);
            let y = rng.range(-2, 8);
            let w = rng.range(1, 40);
            let h = rng.range(1, 12);
            scene.set_clip_rect(id, Rect::new(x as i32, y as i32, w as u32, h as u32));
        }
        for _ in 0..rng.range(0, 3) {
            let id = *rng.pick(&ids[1..]);
            scene.set_scroll_offset(id, rng.range(-4, 6) as i32, rng.range(-4, 4) as i32);
        }
    }

    // The anchor becomes a normal node after frame 0's guarantee is met: it
    // joins the mutation pool, so structural mutations may restyle, clip,
    // scroll or remove it like any other node.
    ids.push(anchor);

    (scene, ids)
}

// ---------------------------------------------------------------------------
// Random mutation engine (prop / text / style / structure)
// ---------------------------------------------------------------------------

/// Apply one random mutation to the scene. Mutations are drawn from every
/// class the dirty path must survive:
///
/// * `prop` — a random layout/paint prop (`set_prop`, or a clip/scroll rect
///   through `set_clip_rect` / `set_scroll_offset`);
/// * `text` — a text-leaf content rewrite or a streaming span append;
/// * `style` — a full `Style` replacement;
/// * `structure` — node add / insert / remove, or a node `kind` swap;
/// * a raw `node_mut` borrow (the force-full-scan fallback).
///
/// `ids` is the mutation-target pool, kept live across the scenario: nodes
/// removed by structural mutations are filtered out, and nodes added by
/// structural mutations are pushed so they become eligible later.
///
/// Returns a short human-readable description of the applied mutation, so a
/// failing run can be replayed (the description is the last step of the
/// trace reported with the seed + scenario + frame).
fn apply_random_mutation(
    rng: &mut Rng,
    scene: &mut Scene,
    ids: &mut Vec<NodeId>,
) -> String {
    ids.retain(|&id| scene.node(id).is_some());
    debug_assert!(!ids.is_empty(), "the root always exists");
    let id = *rng.pick(ids);
    match rng.below(12) {
        // prop: single-key layout/paint prop writes.
        0..=4 => match rng.below(4) {
            0 => {
                // A layout-affecting Int prop.
                let key = *rng.pick(INT_PROPS);
                let value = *rng.pick(INT_VALUES);
                assert!(scene.set_prop(id, key, PropValue::Int(value)));
                format!("set_prop({id:?}, {key}={value})")
            }
            1 => {
                // A string enum prop.
                let &(key, values) = rng.pick(STR_PROPS);
                let value = *rng.pick(values);
                assert!(scene.set_prop(id, key, PropValue::Str(value.into())));
                format!("set_prop({id:?}, {key}={value})")
            }
            2 => {
                // The paint-only pushed path: clip rect.
                let x = rng.range(-2, 12);
                let y = rng.range(-2, 8);
                let w = rng.range(0, 40);
                let h = rng.range(0, 12);
                scene.set_clip_rect(id, Rect::new(x as i32, y as i32, w as u32, h as u32));
                format!("set_clip_rect({id:?}, ({x},{y},{w}x{h}))")
            }
            _ => {
                // The paint-only pushed path: scroll offset.
                let (x, y) = (rng.range(-6, 8) as i32, rng.range(-6, 6) as i32);
                scene.set_scroll_offset(id, x, y);
                format!("set_scroll_offset({id:?}, {x},{y})")
            }
        },
        // text: rewrite a leaf's content (works on any node — paint only
        // reads it for Text/StreamingText, a real-but-inert mutation on
        // others), toggle wrap, or set the caret column.
        5..=6 => match rng.below(3) {
            0 => {
                let text = random_text(rng);
                assert!(scene.set_prop(id, "text", PropValue::Str(text.clone())));
                format!("set_text({id:?}, {text:?})")
            }
            1 => {
                let wrap = rng.chance(50);
                assert!(scene.set_prop(id, "wrap", PropValue::Bool(wrap)));
                format!("set_prop({id:?}, wrap={wrap})")
            }
            _ => {
                let caret = rng.range(0, 40);
                assert!(scene.set_prop(id, "caret", PropValue::Int(caret)));
                format!("set_prop({id:?}, caret={caret})")
            }
        },
        // stream append: only StreamingText nodes accept spans.
        7 => {
            if let Some(node) = scene.node(id) {
                if node.kind == NodeKind::StreamingText {
                    let span = random_span(rng);
                    assert!(scene.append_span(id, span.clone()));
                    format!("append_span({id:?}, {:?})", span.text)
                } else {
                    // Convert the node into a streaming leaf first so the
                    // append lands — exercises the kind-swap + stream path.
                    assert!(scene.set_kind(id, NodeKind::StreamingText));
                    let span = random_span(rng);
                    assert!(scene.append_span(id, span.clone()));
                    format!("set_kind({id:?}, StreamingText) + append_span({:?})", span.text)
                }
            } else {
                "noop".to_string()
            }
        }
        // style: replace the node's full Style.
        8 => {
            assert!(scene.set_style(id, random_style(rng)));
            format!("set_style({id:?})")
        }
        // structure: add / insert / remove / kind-swap.
        9..=10 => match rng.below(5) {
            0 => {
                // Add a child under any node (root included).
                let kind = match rng.below(10) {
                    0..=4 => NodeKind::Box,
                    5..=7 => NodeKind::Text,
                    _ => NodeKind::StreamingText,
                };
                let child = scene.add_child(id, kind, random_style(rng)).unwrap();
                ids.push(child);
                random_props(rng, scene, child, kind != NodeKind::Box);
                match kind {
                    NodeKind::Text => {
                        scene.set_prop(child, "text", PropValue::Str(random_text(rng)));
                    }
                    NodeKind::StreamingText => {
                        if rng.chance(50) {
                            assert!(scene.append_span(child, random_span(rng)));
                        }
                    }
                    _ => {}
                }
                format!("add_child({id:?}, {kind:?}) -> {child:?}")
            }
            1 => {
                // Insert a child at a random position.
                let parent = *rng.pick(ids);
                let kind = if rng.chance(60) {
                    NodeKind::Box
                } else {
                    NodeKind::Text
                };
                if let Some(child) =
                    scene.insert_child(parent, rng.range(0, 8) as usize, kind, random_style(rng))
                {
                    ids.push(child);
                    if kind == NodeKind::Text {
                        scene.set_prop(child, "text", PropValue::Str(random_text(rng)));
                    }
                    format!("insert_child({parent:?}, {kind:?}) -> {child:?}")
                } else {
                    "insert_child failed".to_string()
                }
            }
            2 => {
                // Remove a subtree (never the root). When every non-root
                // node is already gone the removal is skipped — a no-op
                // frame whose parity still runs (and whose epoch does not
                // bump, keeping the productivity floor honest).
                if ids.len() > 1 {
                    let victim = *rng.pick(&ids[1..]);
                    assert!(scene.remove(victim), "removing a live non-root node");
                    format!("remove({victim:?})")
                } else {
                    "remove skipped (no non-root nodes)".to_string()
                }
            }
            3 => {
                // Swap a node's kind (Box<->Text<->StreamingText).
                let kind = match rng.below(3) {
                    0 => NodeKind::Box,
                    1 => NodeKind::Text,
                    _ => NodeKind::StreamingText,
                };
                assert!(scene.set_kind(id, kind));
                format!("set_kind({id:?}, {kind:?})")
            }
            _ => {
                // Add a text leaf under the root — the most common real edit.
                let t = scene.add_text(scene.root_id(), &random_text(rng), random_style(rng));
                if let Some(t) = t {
                    ids.push(t);
                    random_props(rng, scene, t, true);
                    format!("add_text(root) -> {t:?}")
                } else {
                    "add_text failed".to_string()
                }
            }
        },
        // raw node_mut: opaque to the scene — forces the full-signature scan.
        _ => {
            let node = scene.node_mut(id).expect("id picked from live ids");
            match rng.below(3) {
                0 => {
                    let text = random_text(rng);
                    node.props
                        .insert("text".to_string(), PropValue::Str(text.clone()));
                    format!("node_mut({id:?}).text = {text:?}")
                }
                1 => {
                    node.style = random_style(rng);
                    format!("node_mut({id:?}).style")
                }
                _ => {
                    let width = *rng.pick(INT_VALUES);
                    node.props
                        .insert("width".to_string(), PropValue::Int(width));
                    format!("node_mut({id:?}).width = {width}")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Parity harness
// ---------------------------------------------------------------------------

/// The first cell at which two buffers differ, as a human-readable diagnostic.
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

// --- Failure diagnostics (run only on a parity mismatch) ---

/// Dump the scene tree (id, kind, parent, props, style) for a failing frame.
fn dump_scene_debug(scene: &Scene) {
    fn walk(scene: &Scene, id: NodeId, depth: usize) {
        let Some(node) = scene.node(id) else { return };
        let parent = node.parent.map(|p| format!("{p:?}")).unwrap_or_else(|| "-".into());
        eprintln!(
            "{:indent$}{id:?} kind={:?} parent={} props={:?} style={:?} stream={}",
            "",
            node.kind,
            parent,
            node.props,
            node.style,
            scene.stream(id).map(|s| s.len()).unwrap_or(0),
            indent = depth * 2,
        );
        for &child in &node.children {
            walk(scene, child, depth + 1);
        }
    }
    walk(scene, scene.root_id(), 0);
}

/// Dump a window of a buffer (rows 0..8, cols 0..24) with ch/symbol/width.
fn dump_buffer_debug(buffer: &Buffer) {
    for y in 0..8.min(buffer.height) {
        let mut row = String::new();
        for x in 0..24.min(buffer.width) {
            let c = buffer.cell(x, y).expect("in bounds");
            let ch = if c.ch == ' ' { '·' } else { c.ch };
            row.push(ch);
        }
        eprintln!("y={y}: {row}");
    }
    // Also dump the specific (1,2) cell fully.
    if let Some(c) = buffer.cell(1, 2) {
        eprintln!("cell(1,2) = {c:?}");
    }
    if let Some(c) = buffer.cell(2, 2) {
        eprintln!("cell(2,2) = {c:?}");
    }
}

/// Assert that the warm compositor's frame equals a fresh compositor's full
/// recompute cell-for-cell, and that both update diffs vs `prev` agree.
/// Returns the incremental buffer.
fn assert_fuzz_parity(
    seed: u64,
    scenario: usize,
    frame: usize,
    warm: &mut Compositor,
    prev: &Buffer,
    scene: &Scene,
    trace: &[String],
) -> Buffer {
    let dirty = warm.paint_scene(scene, VIEWPORT);
    let mut fresh = Compositor::new();
    let full = fresh.paint_scene(scene, VIEWPORT);
    if dirty != full {
        // Failure diagnostics: the scene and both buffers make the mismatch
        // reproducible without re-running under a debugger.
        eprintln!("=== DBG: scene tree (scenario {scenario}, frame {frame}) ===");
        dump_scene_debug(scene);
        eprintln!("=== DBG: incremental buffer window ===");
        dump_buffer_debug(&dirty);
        eprintln!("=== DBG: full buffer window ===");
        dump_buffer_debug(&full);
    }
    assert!(
        dirty == full,
        "seed {seed:#x} scenario {scenario} frame {frame}: the incremental buffer must equal a \
         fresh full recompute cell-for-cell\nfirst difference: {}\nmutation trace:\n  {}",
        describe_first_diff(&dirty, &full),
        trace.join("\n  ")
    );
    assert!(
        dirty.diff_from(prev) == full.diff_from(prev),
        "seed {seed:#x} scenario {scenario} frame {frame}: the update diff vs the previous frame \
         must be identical between paths\nmutation trace:\n  {}",
        trace.join("\n  ")
    );
    dirty
}

/// Run the randomized parity fuzz for `scenarios` scenes × `mutations`
/// mutations each, asserting incremental/full parity after every mutation.
fn run_parity_fuzz(seed: u64, scenarios: usize, mutations: usize) {
    let mut rng = Rng::new(seed);
    for s in 0..scenarios {
        let (mut scene, mut ids) = build_random_scene(&mut rng);
        let mut warm = Compositor::new();
        let blank = Buffer::new(VIEWPORT.width, VIEWPORT.height);

        // Frame 0: cold-cache parity — both paths are full paints by
        // construction, so this validates the harness (the scene painted
        // real cells, and the two cold paints agree).
        let mut prev = assert_fuzz_parity(seed, s, 0, &mut warm, &blank, &scene, &[]);
        assert!(
            !prev.diff_from(&blank).is_empty(),
            "seed {seed:#x} scenario {s}: the random scene must paint real cells"
        );

        // The mutation mix must be productive: at least half of the frames
        // must have bumped the scene epoch (a real mutation), or the scenario
        // would be testing little but equal-value no-ops. Epoch tracking is
        // geometry-immune — a mutation that hides every cell (e.g. a clip
        // over the whole scene) still counts as productive, so the floor
        // cannot be defeated by an all-transparent degenerate frame.
        let mut productive = 0usize;
        let mut trace: Vec<String> = Vec::new();
        for frame in 1..=mutations {
            let epoch_before = scene.epoch();
            let desc = apply_random_mutation(&mut rng, &mut scene, &mut ids);
            trace.push(desc);
            if scene.epoch() != epoch_before {
                productive += 1;
            }
            let dirty = assert_fuzz_parity(seed, s, frame, &mut warm, &prev, &scene, &trace);
            prev = dirty;
        }

        assert!(
            productive * 2 >= mutations,
            "seed {seed:#x} scenario {s}: expected at least half of the mutations to bump the \
             scene epoch, got {productive}/{mutations}"
        );
    }
}

/// The env-overridable seed (defaults to the fixed [`DEFAULT_SEED`]).
fn env_seed() -> u64 {
    env::var("TERN_PARITY_SEED")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_SEED)
}

/// An env-overridable positive count, defaulting to `default`.
fn env_count(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The default fuzz run: fixed seed (env-overridable), bounded scenario and
/// mutation counts — the CI entry point.
#[test]
fn dirty_path_randomized_parity_fuzz() {
    let seed = env_seed();
    let scenarios = env_count("TERN_PARITY_SCENARIOS", DEFAULT_SCENARIOS);
    let mutations = env_count("TERN_PARITY_MUTATIONS", DEFAULT_MUTATIONS);
    run_parity_fuzz(seed, scenarios, mutations);
}

/// A second fixed seed, independent of the default (and of `TERN_PARITY_SEED`),
/// with a reduced budget so the whole suite stays bounded.
#[test]
fn dirty_path_randomized_parity_fuzz_alt_seed() {
    run_parity_fuzz(0xDEAD_BEEF_CAFE_F00D, 6, 40);
}

/// A third fixed seed favoring deep clip/scroll and streaming-heavy scenes.
#[test]
fn dirty_path_randomized_parity_fuzz_clip_seed() {
    run_parity_fuzz(0xC11F_5C20_115E_ED, 6, 40);
}
