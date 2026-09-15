use super::*;

/// Concatenated span text — the stream's coverage contract.
fn concat_spans(spans: &[HighlightSpanJs]) -> String {
    spans.iter().map(|s| s.text.as_str()).collect()
}

/// A large deterministic rust source (200 lines) exercising keywords,
/// numbers, strings and comments across many functions.
fn large_rust_source() -> String {
    let mut lines = Vec::with_capacity(200);
    for i in 0..200 {
        match i % 4 {
            0 => lines.push(format!("fn helper_{i}() {{")),
            1 => lines.push(format!("    let value = {i}; // count")),
            2 => lines.push(format!("    let name = \"item_{i}\";")),
            _ => lines.push("    println!(\"{{value}}\");".to_string()),
        }
    }
    lines.push("}".to_string());
    lines.join("\n")
}

/// The `[start, end)` changed range of an append is within the appended tail:
/// it starts at or after the previous source length and ends at or before
/// the new full length.
fn assert_changed_within_tail(changed: [u32; 2], head_len: usize, full_len: usize) {
    let (head_len, full_len) = (head_len as u32, full_len as u32);
    assert!(
        changed[0] >= head_len,
        "changed start {changed:?} must be within the appended tail (head {head_len}, full {full_len})"
    );
    assert!(
        changed[1] <= full_len,
        "changed end {changed:?} must be within the appended tail (head {head_len}, full {full_len})"
    );
    assert!(changed[0] < changed[1], "changed range must be non-empty");
}

#[test]
fn incremental_highlighter_rejects_unknown_language() {
    let err = match IncrementalHighlighter::new("ruby".to_string()) {
        Ok(_) => panic!("ruby must error"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("unknown highlight language"),
        "{err}"
    );
}

#[test]
fn incremental_highlighter_first_append_reports_no_changed_range() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let source = "fn main() {\n    let x = 42;\n}\n";
    let first = hl.append(source.to_string());
    // No previous parse existed — nothing to report as changed.
    assert!(first.changed.is_none());
    assert_eq!(concat_spans(&first.spans), source);
    // Token styles survive the round-trip: the keyword and the number.
    let kw = first
        .spans
        .iter()
        .find(|s| s.text == "fn")
        .expect("keyword span");
    assert_eq!(kw.fg.as_deref(), Some("#c678dd"));
    let num = first
        .spans
        .iter()
        .find(|s| s.text == "42")
        .expect("number span");
    assert_eq!(num.fg.as_deref(), Some("#d19a66"));
}

#[test]
fn incremental_highlighter_append_reports_the_changed_tail_range() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let head = large_rust_source();
    let head_len = head.len();
    let first = hl.append(head.clone());
    assert!(first.changed.is_none());
    assert_eq!(concat_spans(&first.spans), head);

    // A small pure append: the incremental re-parse only reworks the tail.
    let tail = "\nfn appended() {\n    let fresh = true;\n}\n";
    let second = hl.append(tail.to_string());
    let changed = second.changed.expect("second append reports a changed range");
    assert_changed_within_tail(changed, head_len, head_len + tail.len());
    assert_eq!(concat_spans(&second.spans), format!("{head}{tail}"));
}

#[test]
fn incremental_highlighter_spans_match_one_shot_highlight() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let head = large_rust_source();
    let _ = hl.append(head.clone());
    let tail = "\nfn appended() {\n    let fresh = true;\n}\n";
    let incremental = hl.append(tail.to_string());

    // The incremental stream is byte-identical (text AND per-span style
    // keys) to a fresh one-shot highlight of the full source.
    let full = format!("{head}{tail}");
    let one_shot = highlight("rust".to_string(), full).expect("one-shot highlight");
    assert_eq!(incremental.spans.len(), one_shot.len());
    for (i, (a, b)) in incremental.spans.iter().zip(one_shot.iter()).enumerate() {
        assert_eq!(a.text, b.text, "span {i} text");
        assert_eq!(a.fg, b.fg, "span {i} fg");
        assert_eq!(a.bold, b.bold, "span {i} bold");
        assert_eq!(a.italic, b.italic, "span {i} italic");
        assert_eq!(a.dim, b.dim, "span {i} dim");
        assert_eq!(a.underline, b.underline, "span {i} underline");
    }
}

#[test]
fn incremental_highlighter_reset_round_trips() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let first = hl.append("fn a() {}\n".to_string());
    assert!(first.changed.is_none());
    assert_eq!(concat_spans(&first.spans), "fn a() {}\n");

    hl.reset();
    // A post-reset append is a fresh first append: no prior parse to change.
    let second = hl.append("fn b() {}\n".to_string());
    assert!(second.changed.is_none());
    assert_eq!(concat_spans(&second.spans), "fn b() {}\n");

    // And the reset highlighter re-accumulates: the next append reports a
    // changed range within its own tail.
    let third = hl.append("fn c() {}\n".to_string());
    let changed = third
        .changed
        .expect("post-reset second append reports a changed range");
    assert_changed_within_tail(changed, "fn b() {}\n".len(), "fn b() {}\nfn c() {}\n".len());
    assert_eq!(concat_spans(&third.spans), "fn b() {}\nfn c() {}\n");
}

/// The binding's edit surface must cross the napi boundary with the changed
/// window alone: the returned spans cover the reworked bytes of the edited
/// source, and the engine's buffer advances to the edited text so later
/// appends stay incremental.
#[test]
fn incremental_edit_returns_only_the_changed_window() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let head = large_rust_source();
    let _ = hl.append(head.clone());

    // Rename an interior helper — the mid-file edit append cannot express.
    let needle = "fn helper_4()";
    let at = head.find(needle).expect("interior declaration");
    let renamed = "fn renamed_4()";
    let edited = head.replacen(needle, renamed, 1);
    let edit = hl.apply_edit(at as u32, (at + needle.len()) as u32, renamed.to_string());

    let (start, end) = (edit.changed[0] as usize, edit.changed[1] as usize);
    assert!(
        start > 0 && end < edited.len(),
        "a mid-file edit must report a window inside the file, got {start}..{end}"
    );
    let window = concat_spans(&edit.spans);
    assert_eq!(
        window,
        edited[start..end],
        "the window spans must reconstruct their own slice of the new source"
    );
    assert!(
        window.len() < edited.len(),
        "only the changed window may cross the boundary ({} of {} bytes)",
        window.len(),
        edited.len()
    );

    // The buffer now holds the edited source: the next append is a tail
    // re-parse whose stream matches a one-shot highlight of the full text.
    let tail = "\nfn appended_after_edit() {}\n";
    let appended = hl.append(tail.to_string());
    let full = format!("{edited}{tail}");
    assert_eq!(concat_spans(&appended.spans), full);
    let one_shot = highlight("rust".to_string(), full).expect("one-shot highlight");
    assert_eq!(appended.spans.len(), one_shot.len(), "span counts differ");
    for (i, (a, b)) in appended.spans.iter().zip(one_shot.iter()).enumerate() {
        assert_eq!(a.text, b.text, "span {i} text");
        assert_eq!(a.fg, b.fg, "span {i} fg");
        assert_eq!(a.italic, b.italic, "span {i} italic");
    }
}

/// An edit that describes no well-formed change is a no-op: no spans, an empty
/// window, and a buffer left exactly as it was.
#[test]
fn incremental_edit_rejects_out_of_range_edits() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let source = "fn é() {}\n";
    let _ = hl.append(source.to_string());
    // Past the end of the buffer, inverted, and inside the two-byte é.
    for (start, old_end, new_text) in [(99u32, 99u32, "x"), (5, 2, ""), (4, 4, "x")] {
        let rejected = hl.apply_edit(start, old_end, new_text.to_string());
        assert!(
            rejected.spans.is_empty(),
            "an edit {start}..{old_end} must return no spans"
        );
        assert_eq!(rejected.changed, [0, 0], "an edit {start}..{old_end} has no window");
    }
    // The buffer survived untouched: a later append's complete stream covers
    // the original text plus the tail, matching a one-shot highlight — a
    // partially applied rejection would show up here as a wrong tree.
    let tail = hl.append("// tail\n".to_string());
    let full = "fn é() {}\n// tail\n";
    assert_eq!(concat_spans(&tail.spans), full);
    let one_shot = highlight("rust".to_string(), full.to_string()).expect("one-shot highlight");
    assert_eq!(tail.spans.len(), one_shot.len(), "span counts differ");
}

#[test]
fn incremental_highlighter_empty_append_is_a_no_op() {
    let hl = IncrementalHighlighter::new("rust".to_string()).expect("rust highlighter");
    let empty = hl.append(String::new());
    assert!(empty.spans.is_empty());
    assert!(empty.changed.is_none());
    // An empty first append does not consume the "first append" slot.
    let real = hl.append("fn x() {}\n".to_string());
    assert!(real.changed.is_none());
    assert_eq!(concat_spans(&real.spans), "fn x() {}\n");
}
