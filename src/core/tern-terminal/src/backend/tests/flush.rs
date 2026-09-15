//! Diff flushing: run batching, style changes, masked cells, wide glyphs,
//! OSC 8 hyperlinks, and the empty-diff fast path.

use super::*;

#[test]
fn flush_diff_moves_writes_and_parks_cursor() {
    let out = flush(&[update(2, 1, 'x', Style::new(), 1, false)], (0, 0));
    let s = String::from_utf8(out).unwrap();
    // The single cell is its own run: MoveTo(2, 1) (1-based -> row 2,
    // column 3), one SGR reset, then the character.
    assert!(s.contains("\x1b[2;3H\x1b[0mx"), "got: {s:?}");
    // The cursor is parked at the top-left afterwards; the trailing
    // ResetColor and Attribute::Reset both emit SGR 0.
    assert!(s.ends_with("\x1b[1;1H\x1b[0m\x1b[0m"), "got: {s:?}");
    // One SGR reset for the run plus the two trailing resets.
    assert_eq!(s.matches("\x1b[0m").count(), 3, "got: {s:?}");
}

#[test]
fn flush_diff_applies_indexed_and_rgb_colors() {
    let fg_indexed = Style::new().fg(TernColor::Indexed(1));
    let fg_rgb = Style::new().fg(TernColor::Rgb(1, 2, 3));
    let bg_indexed = Style::new().bg(TernColor::Indexed(4));
    let out = flush(
        &[
            update(0, 0, 'a', fg_indexed, 1, false),
            update(1, 0, 'b', fg_rgb, 1, false),
            update(2, 0, 'c', bg_indexed, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // Each cell has a distinct style, so each is its own run: one MoveTo
    // + one SGR reset + one color command + the character, in column
    // order. Rgb(1, 2, 3) hits the truecolor path under the test default.
    assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[38;5;1ma"), "got: {s:?}"); // fg palette 1
    assert!(
        s.contains("\x1b[1;2H\x1b[0m\x1b[38;2;1;2;3mb"),
        "got: {s:?}"
    ); // fg truecolor
    assert!(s.contains("\x1b[1;3H\x1b[0m\x1b[48;5;4mc"), "got: {s:?}"); // bg palette 4
}

#[test]
fn flush_diff_applies_modifiers() {
    let bold = Style::new().add_modifier(Modifiers::BOLD);
    let dim = Style::new().add_modifier(Modifiers::DIM);
    let out = flush(
        &[
            update(0, 0, 'a', bold, 1, false),
            update(1, 0, 'b', dim, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // Bold and dim differ, so the adjacent cells split into two runs,
    // each applying its own modifier once.
    assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[1ma"), "got: {s:?}"); // bold
    assert!(s.contains("\x1b[1;2H\x1b[0m\x1b[2mb"), "got: {s:?}"); // dim
}

#[test]
fn flush_diff_clears_masked_cells_and_keeps_wide_chars() {
    let out = flush(
        &[
            update(0, 0, '\0', Style::new(), 0, true), // masked continuation
            update(1, 0, 'コ', Style::new(), 2, false), // wide lead
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // The masked cell at (0,0) joins the run as a space and the wide
    // glyph at (1,0) prints raw, so the pair is ONE run: one MoveTo, one
    // SGR reset, one multi-character Print (" コ").
    assert!(s.starts_with("\x1b[1;1H\x1b[0m コ"), "got: {s:?}");
    // No per-cell MoveTo between the mask and the wide glyph.
    assert!(!s.contains("\x1b[2;2H"), "got: {s:?}");
}

#[test]
fn flush_diff_prints_zwj_cluster_symbol_once() {
    // A ZWJ family emoji is a single 2-column grapheme cluster. The diff
    // emits its lead update (carrying the full cluster symbol) followed by
    // the masked continuation cell. The flush must print the FULL cluster
    // string exactly once — never the lead char alone, never a re-split.
    let style = Style::new();
    let out = flush(
        &[
            cluster_update(0, 0, '👨', "👨‍👩‍👧‍👦", style.clone(), 2), // cluster lead
            update(1, 0, '\0', style.clone(), 0, true),               // its mask
            update(2, 0, 'x', style, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // The lead is its own run (advances 2, so the mask cannot extend it):
    // one MoveTo, one SGR reset, and the full cluster in one Print. The
    // mask + 'x' share the next run: " x".
    assert!(s.starts_with("\x1b[1;1H\x1b[0m👨‍👩‍👧‍👦"), "got: {s:?}");
    assert!(s.contains("\x1b[1;2H x"), "got: {s:?}");
    // The cluster string appears exactly once in the whole frame.
    assert_eq!(s.matches("👨‍👩‍👧‍👦").count(), 1, "got: {s:?}");
}

#[test]
fn flush_diff_prints_combining_sequence_symbol_once() {
    // A base + combining mark is ONE 1-column cluster: it prints its full
    // symbol and advances one column, so the following cell can extend the
    // same run — one Print holds the whole combining sequence plus the
    // next glyph.
    let style = Style::new();
    let out = flush(
        &[
            cluster_update(0, 0, 'e', "e\u{301}", style.clone(), 1), // combining seq
            update(1, 0, 'a', style, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    assert!(s.starts_with("\x1b[1;1H\x1b[0me\u{301}a"), "got: {s:?}");
    assert_eq!(s.matches("e\u{301}").count(), 1, "got: {s:?}");
}

#[test]
fn flush_diff_batches_adjacent_same_style_cells() {
    let out = flush(
        &[
            update(0, 0, 'a', Style::new(), 1, false),
            update(1, 0, 'b', Style::new(), 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // Two adjacent same-style cells merge into ONE run: exactly one
    // MoveTo, one SGR reset, and both characters in one Print call.
    assert!(s.starts_with("\x1b[1;1H\x1b[0mab"), "got: {s:?}");
    // No second MoveTo for the second cell and no SGR between the chars.
    assert!(!s.contains("\x1b[2;2H"), "got: {s:?}");
    assert!(!s.contains("a\x1b[0m"), "got: {s:?}");
    // The full frame: run (MoveTo + one SGR + "ab"), then the cursor
    // park with its two trailing resets.
    assert_eq!(s, "\x1b[1;1H\x1b[0mab\x1b[1;1H\x1b[0m\x1b[0m", "got: {s:?}");
}

#[test]
fn flush_diff_splits_runs_on_gap_and_style_change() {
    // A non-adjacent column breaks the run even with the same style: the
    // second run still gets its own MoveTo, but its style equals the
    // first run's, so the redundant SGR block is skipped.
    let gap = flush(
        &[
            update(0, 0, 'a', Style::new(), 1, false),
            update(2, 0, 'b', Style::new(), 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(gap).unwrap();
    assert!(s.contains("\x1b[1;1H\x1b[0ma"), "got: {s:?}");
    assert!(s.contains("\x1b[1;3Hb"), "got: {s:?}"); // own MoveTo, no SGR
    assert!(!s.contains("\x1b[1;3H\x1b[0m"), "got: {s:?}");

    // A wide lead closes its run so the following masked continuation
    // cannot land on the wrong column: コ advances two columns, so the
    // mask at (2,0) must be its own run with its own MoveTo. The mask
    // run shares the lead's style, so it skips the SGR block too.
    let wide = flush(
        &[
            update(0, 0, 'コ', Style::new(), 2, false), // wide lead
            update(1, 0, '\0', Style::new(), 0, true),  // its mask
            update(2, 0, 'x', Style::new(), 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(wide).unwrap();
    assert!(s.contains("\x1b[1;1H\x1b[0mコ"), "got: {s:?}"); // lead run
                                                             // Mask and 'x' share one run at the mask's column: " x".
    assert!(s.contains("\x1b[1;2H x"), "got: {s:?}");
    assert!(!s.contains("\x1b[1;2H\x1b[0m"), "got: {s:?}");
}

#[test]
fn flush_diff_skips_sgr_between_same_style_runs() {
    // Two runs separated by a column gap but sharing one style: the
    // first run applies the full SGR block (reset + fg), the second
    // emits only its MoveTo and characters — the terminal's style state
    // is already correct. Exactly one reset+style sequence is emitted.
    let fg1 = Style::new().fg(TernColor::Indexed(1));
    let out = flush(
        &[
            update(0, 0, 'a', fg1.clone(), 1, false),
            update(2, 0, 'b', fg1, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // One SGR reset for the first run plus the two trailing resets; the
    // second run contributes no SGR at all.
    assert_eq!(s.matches("\x1b[0m").count(), 3, "got: {s:?}");
    // The style is applied exactly once, in the first run's block.
    assert_eq!(s.matches("\x1b[38;5;1m").count(), 1, "got: {s:?}");
    assert_eq!(
        s, "\x1b[1;1H\x1b[0m\x1b[38;5;1ma\x1b[1;3Hb\x1b[1;1H\x1b[0m\x1b[0m",
        "got: {s:?}"
    );
}

#[test]
fn flush_diff_reapplies_sgr_on_style_change_between_runs() {
    // fg1 -> fg2 -> fg1 across three gapped runs: the middle run differs
    // from the first, so it emits its own full block; the third run's
    // style equals the FIRST's, but the terminal state after the middle
    // run is fg2, so the third must re-apply its full block too — the
    // merge tracks the most recently applied style, not any seen style.
    let fg1 = Style::new().fg(TernColor::Indexed(1));
    let fg2 = Style::new().fg(TernColor::Indexed(2));
    let out = flush(
        &[
            update(0, 0, 'a', fg1.clone(), 1, false),
            update(2, 0, 'b', fg2, 1, false),
            update(4, 0, 'c', fg1, 1, false),
        ],
        (0, 0),
    );
    let s = String::from_utf8(out).unwrap();
    // Each run emits its own SGR reset (3) plus the two trailing resets.
    assert_eq!(s.matches("\x1b[0m").count(), 5, "got: {s:?}");
    // fg1 is re-applied for the third run (terminal state is fg2 after
    // the middle run); fg2 is applied once.
    assert_eq!(s.matches("\x1b[38;5;1m").count(), 2, "got: {s:?}");
    assert_eq!(s.matches("\x1b[38;5;2m").count(), 1, "got: {s:?}");
    assert_eq!(
        s,
        "\x1b[1;1H\x1b[0m\x1b[38;5;1ma\x1b[1;3H\x1b[0m\x1b[38;5;2mb\x1b[1;5H\x1b[0m\x1b[38;5;1mc\x1b[1;1H\x1b[0m\x1b[0m",
        "got: {s:?}"
    );
}

#[test]
fn flush_diff_wraps_linked_run_in_osc8_hyperlink() {
    // A cell styled with a hyperlink is its own run whose Print is
    // wrapped: the OSC 8 open (ESC ] 8 ; ; <url> ST) precedes the
    // character and the close (ESC ] 8 ; ; ST) follows it — the raw
    // escapes land between the run's SGR reset and the cursor park, via
    // the same seam as the OSC 52 clipboard write.
    let linked = Style::new().hyperlink(Some("https://example.com".into()));
    let out = flush(&[update(0, 0, 'l', linked, 1, false)], (0, 0));
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[1;1H\x1b[0m\x1b]8;;https://example.com\x1b\\l\x1b]8;;\x1b\\\x1b[1;1H\x1b[0m\x1b[0m",
        "the linked text must be wrapped in OSC 8 open/close"
    );
}

#[test]
fn flush_diff_unlinked_run_emits_no_osc8() {
    // A linked cell followed by an unlinked adjacent cell: the styles
    // differ (the hyperlink participates in style equality), so each is
    // its own run. The linked run wraps its 'l' in OSC 8 and closes
    // before the next run starts; the unlinked run prints with no OSC 8
    // sequence at all — the link cannot leak onto it.
    let linked = Style::new().hyperlink(Some("https://example.com".into()));
    let out = flush(
        &[
            update(0, 0, 'l', linked, 1, false),
            update(1, 0, 'p', Style::new(), 1, false),
        ],
        (0, 0),
    );
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[1;1H\x1b[0m\x1b]8;;https://example.com\x1b\\l\x1b]8;;\x1b\\\x1b[1;2H\x1b[0mp\x1b[1;1H\x1b[0m\x1b[0m",
        "only the linked run wraps in OSC 8"
    );
}

#[test]
fn empty_diff_with_same_park_writes_nothing() {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    // Seed the recorded park position with a real frame at (2, 3).
    flush_diff_to(
        &mut out,
        &[update(0, 0, 'x', Style::new(), 1, false)],
        (2, 3),
        &mut last_flush_pos,
    )
    .expect("flush should succeed");
    assert!(!out.is_empty(), "seed flush should write cells");
    out.clear();

    // An empty diff parked at the recorded position: zero bytes written
    // and no flush — the frame is a complete no-op.
    flush_diff_to(&mut out, &[], (2, 3), &mut last_flush_pos).expect("flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn empty_diff_with_moved_park_emits_only_move_to() {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    flush_diff_to(
        &mut out,
        &[update(0, 0, 'x', Style::new(), 1, false)],
        (0, 0),
        &mut last_flush_pos,
    )
    .expect("flush should succeed");
    out.clear();

    // The park moved from (0, 0) to (5, 4): only the MoveTo (1-based row
    // 5, column 6) is queued — no cells, no style commands.
    flush_diff_to(&mut out, &[], (5, 4), &mut last_flush_pos).expect("flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[5;6H",
        "got: {:?}",
        out
    );

    // The new position is recorded, so the next empty frame parked at
    // the same spot is suppressed again.
    out.clear();
    flush_diff_to(&mut out, &[], (5, 4), &mut last_flush_pos).expect("flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn empty_diff_with_unknown_park_emits_move_to() {
    // Before any flush the recorded park is unknown (`None`), so even an
    // empty first frame must move the caret: (3, 1) -> row 4, column 2.
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    flush_diff_to(&mut out, &[], (3, 1), &mut last_flush_pos).expect("flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[2;4H",
        "got: {:?}",
        out
    );
    assert_eq!(last_flush_pos, Some((3, 1)));
}

#[test]
fn non_empty_diff_output_is_unchanged_and_records_park() {
    // The run-batched output must be byte-identical to the pre-suppression
    // behavior (mirrors `flush_diff_batches_adjacent_same_style_cells`),
    // and the park position is recorded for the next frame.
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    flush_diff_to(
        &mut out,
        &[
            update(0, 0, 'a', Style::new(), 1, false),
            update(1, 0, 'b', Style::new(), 1, false),
        ],
        (0, 0),
        &mut last_flush_pos,
    )
    .expect("flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[1;1H\x1b[0mab\x1b[1;1H\x1b[0m\x1b[0m",
        "got: {:?}",
        out
    );
    assert_eq!(last_flush_pos, Some((0, 0)));
}
