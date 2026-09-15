//! Input-mode toggles, window title, OSC 52 clipboard, and the
//! startup batch.

use super::*;

#[test]
fn enable_event_listening_emits_mouse_and_focus_enable_sequences() {
    let mut out = Vec::new();
    // Full capabilities: every event mode the constructor enables. The
    // byte stream must be identical to the pre-probe-gate sequence —
    // focus and bracketed paste follow the mouse modes in the same order
    // on a terminal the probe reports supports both.
    let caps = TerminalCapabilities {
        focus_events: true,
        bracketed_paste: true,
        ..TerminalCapabilities::default()
    };
    enable_event_listening_with(&mut out, &caps).expect("enable should succeed");
    let s = String::from_utf8(out).unwrap();
    // Mouse capture minus any-event: normal (?1000h), button-event
    // (?1002h), rxvt (?1015h), sgr (?1006h); then focus change (?1004h)
    // and bracketed paste (?2004h).
    assert_eq!(
        s, "\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h\x1b[?1004h\x1b[?2004h",
        "got: {s:?}"
    );
    // Any-event tracking (?1003h) is NOT part of the default path — motion
    // events only stream when enable_any_event_mouse_to is called.
    assert!(
        !s.contains("?1003h"),
        "default enable must not set any-event tracking, got: {s:?}"
    );
}

#[test]
fn enable_event_listening_with_conservative_caps_skips_focus_and_paste() {
    // A probe that reported nothing — or was skipped (non-TTY,
    // TERM=dumb) leaving conservative defaults — must keep focus and
    // bracketed paste disabled. The mouse modes stay unconditional; the
    // optional modes simply do not reach the terminal.
    let mut out = Vec::new();
    enable_event_listening_with(&mut out, &TerminalCapabilities::default())
        .expect("enable should succeed");
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("?1000h"), "mouse capture stays unconditional: {s:?}");
    assert!(!s.contains("?1004h"), "focus change must be skipped: {s:?}");
    assert!(!s.contains("?2004h"), "bracketed paste must be skipped: {s:?}");
}

#[test]
fn enable_event_listening_with_focus_only_emits_1004h_without_2004h() {
    // A terminal that answers focus events but not bracketed paste (or
    // the paste query stays unanswered): ?1004h yes, ?2004h no.
    let mut out = Vec::new();
    let caps = TerminalCapabilities {
        focus_events: true,
        ..TerminalCapabilities::default()
    };
    enable_event_listening_with(&mut out, &caps).expect("enable should succeed");
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("?1004h"), "focus-only caps must enable focus: {s:?}");
    assert!(!s.contains("?2004h"), "bracketed paste stays off: {s:?}");
}

#[test]
fn enable_event_listening_with_paste_only_emits_2004h_without_1004h() {
    // The mirror case: bracketed paste yes, focus events no.
    let mut out = Vec::new();
    let caps = TerminalCapabilities {
        bracketed_paste: true,
        ..TerminalCapabilities::default()
    };
    enable_event_listening_with(&mut out, &caps).expect("enable should succeed");
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("?2004h"), "paste-only caps must enable paste: {s:?}");
    assert!(!s.contains("?1004h"), "focus change stays off: {s:?}");
}

#[test]
fn enable_any_event_mouse_emits_exact_1003h_sequence() {
    let mut out = Vec::new();
    enable_any_event_mouse_to(&mut out).expect("enable should succeed");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[?1003h",
        "any-event enable must emit exactly the ?1003h sequence"
    );
}

#[test]
fn disable_any_event_mouse_emits_exact_1003l_sequence() {
    let mut out = Vec::new();
    disable_any_event_mouse_to(&mut out).expect("disable should succeed");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[?1003l",
        "any-event disable must emit exactly the ?1003l sequence"
    );
}

#[test]
fn disable_event_listening_emits_mouse_and_focus_disable_sequences() {
    let mut out = Vec::new();
    disable_event_listening_to(&mut out).expect("disable should succeed");
    let s = String::from_utf8(out).unwrap();
    // The inverse of enable, in reverse order; the mouse clear (which
    // includes any-event ?1003l) lands first, then focus change (?1004l),
    // then bracketed paste (?2004l).
    assert_eq!(
        s, "\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1004l\x1b[?2004l",
        "got: {s:?}"
    );
    // Teardown also clears any-event tracking, so a separately enabled
    // any-event mode is fully restored.
    assert!(
        s.contains("?1003l"),
        "teardown must clear any-event tracking, got: {s:?}"
    );
}

#[test]
fn set_title_emits_osc0_title_sequence() {
    let mut out = Vec::new();
    set_title_to(&mut out, "Hello").expect("set title should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b]0;Hello\x07");
}

#[test]
fn set_clipboard_emits_osc52_clipboard_sequence() {
    // OSC 52, clipboard selection (`c`), payload = the text's UTF-8
    // bytes base64-encoded (RFC 4648) — "foo" -> "Zm9v" — terminated by
    // BEL: ESC ] 52 ; c ; Zm9v BEL.
    let mut out = Vec::new();
    set_clipboard_to(&mut out, "foo").expect("set clipboard should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b]52;c;Zm9v\x07",
        "got: {:?}",
        out
    );
    // The ST terminator must not appear: the sequence is BEL-terminated.
    assert!(!out.windows(2).any(|w| w == b"\x1b\\"), "got: {:?}", out);
}

#[test]
fn set_clipboard_base64_encodes_utf8_bytes() {
    // Multi-byte text: the base64 payload covers the raw UTF-8 bytes, not
    // code points. "hi🙂" is 6 bytes (h i + 4-byte emoji) -> "aGnwn5mC".
    let mut out = Vec::new();
    set_clipboard_to(&mut out, "hi🙂").expect("set clipboard should succeed");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b]52;c;aGnwn5mC\x07",
        "the payload must base64-encode the UTF-8 bytes"
    );
}

#[test]
fn startup_enters_alt_screen_sets_title_and_enables_events() {
    let mut out = Vec::new();
    queue_startup_to(&mut out, true, Some("tern")).expect("startup should succeed");
    let s = String::from_utf8(out).unwrap();
    // Alternate screen first, then the title, then event listening.
    assert!(s.starts_with("\x1b[?1049h"), "got: {s:?}");
    assert!(s.contains("\x1b]0;tern\x07"), "got: {s:?}");
    assert!(s.contains("\x1b[?1000h"), "got: {s:?}"); // mouse capture
}

#[test]
fn startup_off_emits_no_enter_alternate_screen_escape() {
    let mut out = Vec::new();
    queue_startup_to(&mut out, false, None).expect("startup should succeed");
    let s = String::from_utf8(out).unwrap();
    // The alternate-screen escape is absent; event listening still runs.
    assert!(!s.contains("\x1b[?1049h"), "got: {s:?}");
    assert!(s.contains("\x1b[?1000h"), "got: {s:?}");
}
