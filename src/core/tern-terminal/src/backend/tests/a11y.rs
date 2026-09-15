//! OSC 1337 iTerm2 accessibility annotations.

use super::*;

#[test]
fn flush_a11y_annotations_emits_exact_osc1337_sequences() {
    // Two entries, each one `OSC 1337 ; AddHiddenAnnotation = <summary>
    // BEL`: the summary is written raw (no base64), the BEL terminator
    // matches the project's OSC 0/52 convention, and both sequences
    // share a single trailing flush.
    let mut out = Vec::new();
    flush_a11y_annotations_to(
        &mut out,
        &[
            A11yAnnotation::new("button: Save"),
            A11yAnnotation::new("textbox: Search, focused"),
        ],
    )
    .expect("flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b]1337;AddHiddenAnnotation=button: Save\x07\x1b]1337;AddHiddenAnnotation=textbox: Search, focused\x07",
        "got: {:?}",
        out
    );
    // The ST terminator must not appear: every sequence is BEL-terminated.
    assert!(!out.windows(2).any(|w| w == b"\x1b\\"), "got: {:?}", out);
}

#[test]
fn a11y_annotations_gated_writes_nothing_without_opt_in() {
    // The opt-in gate: on a self-identified iTerm2 terminal, a renderer
    // that never opted in writes zero bytes — the emitter stays silent
    // until the caller enables it.
    let caps = TerminalCapabilities {
        terminal_identity: Some("iTerm2 3.5.0".to_string()),
        ..TerminalCapabilities::default()
    };
    let entries = [A11yAnnotation::new("button: Save")];
    let mut out = Vec::new();
    flush_a11y_annotations_gated_to(&mut out, false, &caps, &entries)
        .expect("flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn a11y_annotations_gated_writes_nothing_for_non_iterm2() {
    // The terminal gate: an opted-in renderer on a terminal the probe
    // did not identify as iTerm2 (kitty here, or an unknown/silent
    // terminal with identity `None`) writes zero bytes — the sequence
    // only ever reaches the terminal that understands it.
    let caps = TerminalCapabilities {
        terminal_identity: Some("kitty(0.36.0)".to_string()),
        ..TerminalCapabilities::default()
    };
    let entries = [A11yAnnotation::new("button: Save")];
    let mut out = Vec::new();
    flush_a11y_annotations_gated_to(&mut out, true, &caps, &entries)
        .expect("flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn a11y_annotations_enabled_truth_table() {
    let iterm2 = TerminalCapabilities {
        terminal_identity: Some("iTerm2 3.5.0".to_string()),
        ..TerminalCapabilities::default()
    };
    let kitty = TerminalCapabilities {
        terminal_identity: Some("kitty(0.36.0)".to_string()),
        ..TerminalCapabilities::default()
    };
    assert!(
        !a11y_annotations_enabled(false, &iterm2),
        "opt-in off never enables"
    );
    assert!(
        a11y_annotations_enabled(true, &iterm2),
        "opt-in plus an iTerm2 identity enables"
    );
    assert!(
        !a11y_annotations_enabled(true, &kitty),
        "a non-iTerm2 terminal never enables"
    );
    assert!(
        !a11y_annotations_enabled(true, &TerminalCapabilities::default()),
        "an unknown terminal stays conservative"
    );
}
