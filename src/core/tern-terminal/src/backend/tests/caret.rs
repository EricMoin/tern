//! Caret placement and shape: MoveTo + DECSCUSR, and the cell/caret split.

use super::*;

/// Flush the caret state against an in-memory buffer and return the bytes.
fn flush_caret(cursor: Cursor) -> Vec<u8> {
    let mut out = Vec::new();
    flush_cursor_to(&mut out, cursor).expect("flush should succeed");
    out
}

#[test]
fn flush_caret_moves_to_position_and_hides() {
    let out = flush_caret(Cursor::new(3, 2).hide());
    let s = String::from_utf8(out).unwrap();
    // MoveTo(3, 2) is 1-based -> row 3, column 4.
    assert!(s.starts_with("\x1b[3;4H"), "got: {s:?}");
    // Hide is DECTCEM off; the trailing resets leave the style clean.
    assert!(s.contains("\x1b[?25l"), "got: {s:?}");
    assert!(s.ends_with("\x1b[0m\x1b[0m"), "got: {s:?}");
}

#[test]
fn flush_caret_moves_to_position_and_shows() {
    let out = flush_caret(Cursor::new(0, 0).show());
    let s = String::from_utf8(out).unwrap();
    assert!(s.starts_with("\x1b[1;1H"), "got: {s:?}");
    assert!(s.contains("\x1b[?25h"), "got: {s:?}");
    assert!(!s.contains("\x1b[?25l"), "got: {s:?}");
}

#[test]
fn flush_diff_with_caret_emits_cells_then_caret_state() {
    let mut out = Vec::new();
    let updates = [update(0, 0, 'x', Style::new(), 1, false)];
    let caret = Cursor::new(5, 4).styled(Style::new().add_modifier(Modifiers::REVERSED));
    flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
    let s = String::from_utf8(out).unwrap();
    // The single cell is one run (MoveTo + one SGR reset + char)...
    assert!(s.contains("\x1b[1;1H\x1b[0mx"), "got: {s:?}");
    // ...then the caret: MoveTo(5, 4) -> row 5, column 6, then Show,
    // then the trailing style resets.
    assert_eq!(
        s, "\x1b[1;1H\x1b[0mx\x1b[5;6H\x1b[?25h\x1b[0m\x1b[0m",
        "got: {s:?}"
    );
}

#[test]
fn flush_diff_with_caret_hides_a_hidden_caret() {
    let mut out = Vec::new();
    let updates = [update(1, 0, 'y', Style::new(), 1, false)];
    let caret = Cursor::hidden().at(2, 2);
    flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
    let s = String::from_utf8(out).unwrap();
    // The cell run at (1,0) -> row 1, column 2, then the hidden caret
    // still moves (MoveTo(2, 2) -> row 3, column 3) but hides instead of
    // showing, then the trailing style resets.
    assert_eq!(
        s, "\x1b[1;2H\x1b[0my\x1b[3;3H\x1b[?25l\x1b[0m\x1b[0m",
        "got: {s:?}"
    );
}

#[test]
fn flush_caret_emits_no_style_for_the_default_cursor() {
    // The default caret — block shape, no blink — IS the terminal's own
    // default, so no DECSCUSR sequence is queued: the byte stream is
    // exactly what the pre-cursor-style backend produced (MoveTo, then
    // Show/Hide, then the trailing resets). This is the byte-identical
    // guarantee every existing flush relies on.
    let shown = flush_caret(Cursor::new(0, 0).show());
    assert_eq!(
        String::from_utf8(shown.clone()).unwrap(),
        "\x1b[1;1H\x1b[?25h\x1b[0m\x1b[0m",
        "got: {shown:?}"
    );
    // The `block()` builder spells the same state explicitly and must
    // also emit nothing.
    let blocked = flush_caret(Cursor::new(0, 0).block());
    assert_eq!(blocked, shown, "got: {blocked:?}");
    // No `\x1b[<n> q` sequence may appear for the default caret.
    assert!(!String::from_utf8(shown.clone()).unwrap().contains(" q"), "got: {shown:?}");
}

#[test]
fn flush_caret_emits_decsusr_style_per_shape_and_blink() {
    // Each non-default (shape, blinking) pair maps to its DECSCUSR code,
    // queued between the MoveTo and the Show: block+blink -> `\x1b[1 q`,
    // underline steady -> `\x1b[4 q`, underline blink -> `\x1b[3 q`,
    // bar blink -> `\x1b[5 q`, bar steady -> `\x1b[6 q`. A steady block
    // (the terminal default) is covered by
    // [`flush_caret_emits_no_style_for_the_default_cursor`].
    let cases: &[(Cursor, &str)] = &[
        (Cursor::new(0, 0).show().blink(), "\x1b[1 q"),
        (Cursor::new(0, 0).show().bar(), "\x1b[6 q"),
        (Cursor::new(0, 0).show().bar().blink(), "\x1b[5 q"),
        (Cursor::new(0, 0).show().underline(), "\x1b[4 q"),
        (Cursor::new(0, 0).show().underline().blink(), "\x1b[3 q"),
    ];
    for (caret, style) in cases {
        let s = String::from_utf8(flush_caret(caret.clone())).unwrap();
        // The style lands after the MoveTo and before the Show.
        assert_eq!(
            s, format!("\x1b[1;1H{style}\x1b[?25h\x1b[0m\x1b[0m"),
            "cursor {caret:?} must emit {style:?}, got: {s:?}"
        );
    }
}

#[test]
fn flush_caret_emits_style_for_a_hidden_non_default_caret() {
    // The shape / blinking style is emitted regardless of visibility: a
    // hidden bar cursor still queues its `\x1b[6 q` between the MoveTo
    // and the Hide, so a later Show (in a later frame) keeps the shape.
    let out = flush_caret(Cursor::hidden().at(1, 1).bar());
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[2;2H\x1b[6 q\x1b[?25l\x1b[0m\x1b[0m",
        "got: {out:?}"
    );
}

#[test]
fn flush_diff_with_caret_emits_style_between_cells_and_visibility() {
    // The full frame: the cell run, then MoveTo, the DECSCUSR style, the
    // Show, and the trailing resets — the style never interleaves with
    // the cell output.
    let mut out = Vec::new();
    let updates = [update(0, 0, 'x', Style::new(), 1, false)];
    let caret = Cursor::new(5, 4).underline().blink();
    flush_diff_with_cursor_to(&mut out, &updates, caret).expect("flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[1;1H\x1b[0mx\x1b[5;6H\x1b[3 q\x1b[?25h\x1b[0m\x1b[0m",
        "got: {out:?}"
    );
}
