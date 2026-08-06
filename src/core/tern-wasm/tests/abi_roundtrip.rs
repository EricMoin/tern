//! Host-target ABI round-trip tests: drive the exported C ABI exactly as the
//! JS shim does (create_node → add_child → set_prop → append_span →
//! render_to_cells), then decode the returned cell stream and assert the
//! expected frame.
//!
//! These run on the host (`cargo test -p tern-wasm`): the `extern "C"` fns are
//! compiled into the rlib, so the test exercises the same code the wasm
//! module exports.

use tern_wasm::{cell_flags, TernWasmCell};

const CELL_SIZE: usize = std::mem::size_of::<TernWasmCell>();

/// The ABI's shared state is a single global instance, so the tests in this
/// binary must run one at a time (cargo runs them on parallel threads).
fn exclusive() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// A `(ptr, len)` string pair from a Rust string (host-side stand-in for the
/// shim's `tern_alloc` + `TextEncoder` write).
fn s(text: &str) -> (*const u8, usize) {
    (text.as_ptr(), text.len())
}

fn create_node(kind: &str, props: &str) -> u64 {
    let (kp, kl) = s(kind);
    let (pp, pl) = s(props);
    unsafe { tern_wasm::abi::tern_create_node(kp, kl, pp, pl) }
}

fn set_prop(handle: u64, key: &str, value_json: &str) -> i32 {
    let (kp, kl) = s(key);
    let (vp, vl) = s(value_json);
    unsafe { tern_wasm::abi::tern_set_prop(handle, kp, kl, vp, vl) }
}

fn append_span(handle: u64, text: &str, style_json: &str) -> i32 {
    let (tp, tl) = s(text);
    let (sp, sl) = s(style_json);
    unsafe { tern_wasm::abi::tern_append_span(handle, tp, tl, sp, sl) }
}

/// Render and decode: returns the cell records and the symbol blob.
fn cells(width: u32, height: u32) -> (Vec<TernWasmCell>, Vec<u8>) {
    let ptr = tern_wasm::abi::tern_render_to_cells(width, height);
    assert!(!ptr.is_null(), "render failed: {}", last_error());
    let count = (width as usize) * (height as usize);
    assert_eq!(tern_wasm::abi::tern_cell_count() as usize, count);
    let recs = unsafe { std::slice::from_raw_parts(ptr, count) }.to_vec();
    let blob_len = tern_wasm::abi::tern_cell_blob_len() as usize;
    let mut blob = Vec::with_capacity(blob_len);
    if blob_len > 0 {
        blob.extend_from_slice(unsafe {
            std::slice::from_raw_parts(tern_wasm::abi::tern_cell_blob_ptr(), blob_len)
        });
    }
    (recs, blob)
}

fn cell_at(recs: &[TernWasmCell], width: u32, x: u32, y: u32) -> TernWasmCell {
    recs[(y * width + x) as usize]
}

fn text_at(recs: &[TernWasmCell], blob: &[u8], width: u32, x: u32, y: u32) -> String {
    cell_at(recs, width, x, y).text(blob).into_owned()
}

/// The last operation's error message (empty when it succeeded).
fn last_error() -> String {
    let n = unsafe { tern_wasm::abi::tern_last_error(std::ptr::null_mut(), 0) };
    let mut buf = vec![0u8; n];
    let m = unsafe { tern_wasm::abi::tern_last_error(buf.as_mut_ptr(), buf.len()) };
    assert_eq!(n, m, "probe and read must agree");
    String::from_utf8(buf).expect("error message is UTF-8")
}

/// Reconstruct the whole frame as rows of display text (the host-side
/// equivalent of `snapshotFrame` — but built from the styled cell stream).
fn frame_rows(recs: &[TernWasmCell], blob: &[u8], width: u32, height: u32) -> Vec<String> {
    (0..height)
        .map(|y| {
            let mut row = String::new();
            for x in 0..width {
                let c = cell_at(recs, width, x, y);
                if c.flags & cell_flags::MASKED != 0 {
                    continue; // masked continuation cells contribute nothing
                }
                row.push_str(&c.text(blob));
            }
            row
        })
        .collect()
}

#[test]
fn cell_record_layout_is_fixed_and_documented() {
    let _serial = exclusive();
    // 6 × u32, repr(C): the JS host strides the array with a constant step.
    assert_eq!(CELL_SIZE, 24);
    assert_eq!(std::mem::align_of::<TernWasmCell>(), 4);
    assert_eq!(std::mem::size_of::<TernWasmCell>(), 24);
}

#[test]
fn abi_roundtrip_scene_to_cells() {
    let _serial = exclusive();
    tern_wasm::abi::tern_reset();
    let root = tern_wasm::abi::tern_root();
    assert_eq!(root, 0);

    // A column box with a rounded border, 1-cell border + padding + gap.
    let box_h = create_node(
        "box",
        r##"{"flex_direction":"column","border":1,"padding":1,"gap":1,
             "border_style":"rounded","width":20,"height":8}"##,
    );
    assert_ne!(box_h, 0, "{}", last_error());
    assert_eq!(
        tern_wasm::abi::tern_add_child(root, box_h),
        box_h,
        "{}",
        last_error()
    );

    // Title line (bold), subtitle line (green), streaming spans (red + bold).
    let title = create_node("text", r##"{"text":"tern wasm","bold":true}"##);
    assert_ne!(title, 0);
    assert_eq!(tern_wasm::abi::tern_add_child(box_h, title), title);

    let sub = create_node("text", r##"{"text":"cells!","fg":"#00ff00"}"##);
    assert_ne!(sub, 0);
    assert_eq!(tern_wasm::abi::tern_add_child(box_h, sub), sub);

    let stream = create_node("streaming_text", "{}");
    assert_ne!(stream, 0);
    assert_eq!(tern_wasm::abi::tern_add_child(box_h, stream), stream);
    assert_eq!(append_span(stream, "sp", r##"{"fg":"#ff0000"}"##), 1);
    assert_eq!(append_span(stream, "an", r#"{"bold":true}"#), 1);

    // Render at a 24x10 viewport (the box is 20x8 at the origin).
    let (recs, blob) = cells(24, 10);

    // Rounded border ring at the box edges.
    assert_eq!(text_at(&recs, &blob, 24, 0, 0), "┌");
    assert_eq!(text_at(&recs, &blob, 24, 19, 0), "┐");
    assert_eq!(text_at(&recs, &blob, 24, 0, 7), "└");
    assert_eq!(text_at(&recs, &blob, 24, 19, 7), "┘");
    assert_eq!(text_at(&recs, &blob, 24, 1, 0), "─");
    assert_eq!(text_at(&recs, &blob, 24, 0, 1), "│");

    // Content area starts at (2,2) — border 1 + padding 1. With gap 1, the
    // three children stack at buffer rows 2, 4 and 6.
    assert_eq!(text_at(&recs, &blob, 24, 2, 2), "t");
    assert_eq!(text_at(&recs, &blob, 24, 10, 2), "m"); // "tern wasm" ends at col 10
    let title_cell = cell_at(&recs, 24, 2, 2);
    assert_ne!(title_cell.flags & cell_flags::BOLD, 0, "title is bold");
    assert_eq!(title_cell.fg, 0, "default fg encodes as 0");

    // Subtitle at content row 2 (buffer y=4), green fg.
    assert_eq!(text_at(&recs, &blob, 24, 2, 4), "c");
    let sub_cell = cell_at(&recs, 24, 2, 4);
    assert_eq!(sub_cell.fg, 0x0200_ff00, "rgb green encoding");

    // Streaming spans at content row 4 (buffer y=6): "sp" red, "an" bold.
    assert_eq!(text_at(&recs, &blob, 24, 2, 6), "s");
    assert_eq!(cell_at(&recs, 24, 2, 6).fg, 0x02ff_0000);
    assert_eq!(cell_at(&recs, 24, 3, 6).fg, 0x02ff_0000);
    assert_eq!(text_at(&recs, &blob, 24, 4, 6), "a");
    assert_ne!(cell_at(&recs, 24, 4, 6).flags & cell_flags::BOLD, 0);
    assert_eq!(text_at(&recs, &blob, 24, 5, 6), "n");

    // Cells outside the box are blank (space, no flags, default colors).
    assert_eq!(text_at(&recs, &blob, 24, 21, 9), " ");
    let blank = cell_at(&recs, 24, 21, 9);
    assert_eq!(blank.flags, 0);
    assert_eq!(blank.fg, 0);
    assert_eq!(blank.bg, 0);

    // The reconstructed rows match the expected frame (border col, padding
    // space, then the content: t lands at buffer col 2).
    let rows = frame_rows(&recs, &blob, 24, 10);
    assert!(rows[0].starts_with("┌──────────────────┐"));
    assert!(rows[2].starts_with("│ tern wasm"));
    assert!(rows[4].starts_with("│ cells!"));
    assert!(rows[6].starts_with("│ span"));
}

#[test]
fn abi_remove_reattach_and_set_prop() {
    let _serial = exclusive();
    tern_wasm::abi::tern_reset();
    let root = tern_wasm::abi::tern_root();

    let box_h = create_node(
        "box",
        r##"{"width":4,"height":2,"border":1,"border_style":"plain"}"##,
    );
    assert_eq!(tern_wasm::abi::tern_add_child(root, box_h), box_h);
    let (recs, blob) = cells(8, 4);
    assert_eq!(text_at(&recs, &blob, 8, 0, 0), "+", "plain border corner");

    // Removing detaches the subtree; the frame is blank again.
    assert_eq!(tern_wasm::abi::tern_remove(box_h), 1);
    let (recs, blob) = cells(8, 4);
    assert_eq!(text_at(&recs, &blob, 8, 0, 0), " ");

    // The handle kept its template, so it re-attaches elsewhere.
    assert_eq!(tern_wasm::abi::tern_add_child(root, box_h), box_h);
    let (recs, blob) = cells(8, 4);
    assert_eq!(text_at(&recs, &blob, 8, 0, 0), "+");

    // Removing an already-detached handle is a no-op (returns 0).
    assert_eq!(tern_wasm::abi::tern_remove(box_h), 1);
    assert_eq!(tern_wasm::abi::tern_remove(box_h), 0);

    // Incremental set_prop changes a text leaf's content.
    let text = create_node("text", r#"{"text":"abc"}"#);
    assert_eq!(tern_wasm::abi::tern_add_child(root, text), text);
    let (recs, blob) = cells(8, 2);
    assert_eq!(text_at(&recs, &blob, 8, 0, 0), "a");
    assert_eq!(set_prop(text, "text", r#""xyz""#), 1);
    let (recs, blob) = cells(8, 2);
    assert_eq!(text_at(&recs, &blob, 8, 0, 0), "x");
    assert_eq!(text_at(&recs, &blob, 8, 2, 0), "z");

    // An equal-value write is a no-op that still reports success.
    assert_eq!(set_prop(text, "text", r#""xyz""#), 1);
}

#[test]
fn abi_wide_char_mask_and_symbol_blob() {
    let _serial = exclusive();
    tern_wasm::abi::tern_reset();
    let root = tern_wasm::abi::tern_root();

    // Stack the two text leaves vertically (column root), so row 0 holds the
    // wide char and row 1 the ZWJ emoji.
    assert_eq!(set_prop(root, "flex_direction", r#""column""#), 1);

    // Row 0: wide char + single char; row 1: a ZWJ family emoji (one cluster).
    let t1 = create_node("text", r##"{"text":"コa","fg":"#ff0000"}"##);
    assert_eq!(tern_wasm::abi::tern_add_child(root, t1), t1, "{}", last_error());
    let t2 = create_node("text", r#"{"text":"👨‍👩‍👧‍👦x"}"#);
    assert_eq!(tern_wasm::abi::tern_add_child(root, t2), t2, "{}", last_error());

    let (recs, blob) = cells(8, 2);

    // コ (U+30B3) is a 2-column glyph: lead + masked continuation.
    let lead = cell_at(&recs, 8, 0, 0);
    assert_eq!(lead.ch, 0x30B3);
    assert_eq!(lead.fg, 0x02ff_0000);
    assert_eq!(lead.flags & cell_flags::MASKED, 0);
    let mask = cell_at(&recs, 8, 1, 0);
    assert_eq!(mask.ch, 0);
    assert_ne!(mask.flags & cell_flags::MASKED, 0);
    // The single char after the wide glyph.
    assert_eq!(text_at(&recs, &blob, 8, 2, 0), "a");

    // The ZWJ emoji is ONE 2-column cluster: its full text lives in the blob.
    let emoji = cell_at(&recs, 8, 0, 1);
    assert_eq!(emoji.ch, '👨' as u32, "lead char of the cluster");
    assert!(emoji.symbol_len > 0);
    let start = emoji.symbol_off as usize;
    let end = start + emoji.symbol_len as usize;
    assert_eq!(&blob[start..end], "👨‍👩‍👧‍👦".as_bytes());
    assert_ne!(cell_at(&recs, 8, 1, 1).flags & cell_flags::MASKED, 0);
    assert_eq!(text_at(&recs, &blob, 8, 2, 1), "x");

    // The reconstructed rows are the plain text the terminal would show
    // (trailing blank cells are preserved, like snapshotFrame rows).
    let rows = frame_rows(&recs, &blob, 8, 2);
    assert_eq!(rows[0].trim_end(), "コa");
    assert_eq!(rows[1].trim_end(), "👨‍👩‍👧‍👦x");
}

#[test]
fn abi_error_paths_report_and_fail_cleanly() {
    let _serial = exclusive();
    tern_wasm::abi::tern_reset();
    let root = tern_wasm::abi::tern_root();

    // Unknown node type.
    assert_eq!(create_node("bogus", "{}"), 0);
    assert!(last_error().contains("unknown node type"));

    // Invalid props JSON.
    assert_eq!(create_node("text", "{not json"), 0);
    assert!(
        last_error().contains("invalid props JSON"),
        "got: {:?}",
        last_error()
    );

    // add_child with a detached parent or unknown handles.
    let parent = create_node("box", "{}");
    let child = create_node("text", "{}");
    assert_eq!(tern_wasm::abi::tern_add_child(parent, child), 0);
    assert!(last_error().contains("detached template"));
    assert_eq!(tern_wasm::abi::tern_add_child(root, 99_999), 0);
    assert!(last_error().contains("unknown child handle"));

    // A detached child is added once; the same template cannot be added
    // twice.
    let again = create_node("text", r#"{"text":"x"}"#);
    assert_eq!(tern_wasm::abi::tern_add_child(root, again), again);
    assert_eq!(tern_wasm::abi::tern_add_child(root, again), 0);

    // append_span on a text node (not streaming) fails; on a detached
    // streaming template it fails too.
    let txt = create_node("text", r#"{"text":"x"}"#);
    assert_eq!(tern_wasm::abi::tern_add_child(root, txt), txt);
    assert_eq!(append_span(txt, "z", "{}"), 0);
    assert!(last_error().contains("requires a streaming_text node"));
    let det = create_node("streaming_text", "{}");
    assert_eq!(append_span(det, "z", "{}"), 0);
    assert!(last_error().contains("detached template"));

    // An absurd render size is refused with a null pointer.
    let ptr = tern_wasm::abi::tern_render_to_cells(5000, 5000);
    assert!(ptr.is_null());
    assert!(last_error().contains("limit"));
}

#[test]
fn abi_scratch_allocator_bumps_and_resets() {
    let _serial = exclusive();
    tern_wasm::abi::tern_reset_alloc();
    let p1 = tern_wasm::abi::tern_alloc(16) as usize;
    let p2 = tern_wasm::abi::tern_alloc(16) as usize;
    assert!(p1 != 0 && p2 != 0);
    assert!(p2 >= p1 + 16, "bump allocation advances (alignment-aware)");
    tern_wasm::abi::tern_reset_alloc();
    let p3 = tern_wasm::abi::tern_alloc(16) as usize;
    assert_eq!(p3, p1, "reset reclaims the region from the start");
    // A zero-length allocation is valid and cheap.
    let pz = tern_wasm::abi::tern_alloc(0) as usize;
    assert_eq!(pz, p3);
}
