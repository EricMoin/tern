//! Tests for the terminal capability probe.

use super::*;

use std::io::Cursor;

/// Run the probe against `replies` (an in-memory reader that delivers
/// every byte at once, then EOF) and return the report plus the exact
/// query bytes written to the writer.
fn probe_with(replies: &[&[u8]]) -> (TerminalCapabilities, Vec<u8>) {
    let mut input = Vec::new();
    for reply in replies {
        input.extend_from_slice(reply);
    }
    let mut out = Vec::new();
    let caps = probe_capabilities(Cursor::new(input), &mut out, Duration::from_millis(20));
    (caps, out)
}

/// A reader that never delivers bytes and never hits EOF, standing in
/// for a terminal that swallows the queries without replying.
struct SilentReader;

impl Read for SilentReader {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        thread::park();
        unreachable!("parked forever")
    }
}

/// A reader that delivers the data one byte per `read` call, so the
/// probe must accumulate and parse replies across many chunks.
struct ChunkedReader {
    data: Vec<u8>,
    pos: usize,
}

impl Read for ChunkedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.data.len() {
            return Ok(0);
        }
        buf[0] = self.data[self.pos];
        self.pos += 1;
        Ok(1)
    }
}

/// A kitty-shaped reply set: DA1 advertising OSC 52, DA2 with kitty's
/// identification code, a DA3 answer, the XTVERSION text, and one
/// XTGETTCAP reply per requested capability.
fn kitty_replies() -> Vec<&'static [u8]> {
    vec![
        b"\x1b[?62;52c",                 // DA1: VT220 + OSC 52 param
        b"\x1b[>84;0;0c",                // DA2: kitty identification
        b"\x1b[=1;2c",                   // DA3: terminal unit id
        b"\x1bP>|kitty(0.36.0)\x1b\\",   // XTVERSION
        b"\x1bP1+r66756c6c6b6264\x1b\\", // XTGETTCAP fullkbd
        b"\x1bP0+r584b\x1b\\",           // XTGETTCAP XK: unknown
        b"\x1bP1+r5375\x1b\\",           // XTGETTCAP Su
        b"\x1bP1+r4d73=31\x1b\\",        // XTGETTCAP Ms = "1"
        b"\x1bP1+r5846\x1b\\",           // XTGETTCAP XF
        b"\x1bP1+r5053\x1b\\",           // XTGETTCAP PS
        b"\x1bP1+r544e=1;62;72\x1b\\",   // XTGETTCAP TN (raw value)
    ]
}

#[test]
fn probe_emits_all_five_queries_in_order() {
    let (caps, out) = probe_with(&[]);
    assert_eq!(
        out,
        b"\x1b[c\x1b[>c\x1b[=c\x1b[>q\x1bP+q66756c6c6b6264;584b;5375;536574756c63;4d73;5846;5053;544e\x1b\\"
    );
    // No replies: conservative defaults, not probed.
    assert_eq!(caps, TerminalCapabilities::default());
    assert!(!caps.probed);
}

#[test]
fn kitty_replies_yield_full_capabilities() {
    let (caps, _) = probe_with(&kitty_replies());
    assert!(caps.probed);
    assert!(caps.kitty_keyboard, "fullkbd answered: {caps:?}");
    assert!(caps.kitty_underline, "Su answered: {caps:?}");
    assert!(caps.osc52, "DA1 param 52 and Ms answered: {caps:?}");
    assert!(caps.bracketed_paste, "PS answered: {caps:?}");
    assert!(caps.focus_events, "XF answered: {caps:?}");
    // XTVERSION is the authoritative identity, ahead of the TN reply.
    assert_eq!(caps.terminal_identity.as_deref(), Some("kitty(0.36.0)"));
}

#[test]
fn replies_split_across_single_byte_chunks_are_still_parsed() {
    let mut input = Vec::new();
    for reply in kitty_replies() {
        input.extend_from_slice(reply);
    }
    let mut out = Vec::new();
    let caps = probe_capabilities(
        ChunkedReader {
            data: input,
            pos: 0,
        },
        &mut out,
        Duration::from_millis(20),
    );
    assert!(caps.probed);
    assert!(caps.kitty_keyboard);
    assert!(caps.kitty_underline);
    assert!(caps.osc52);
    assert!(caps.bracketed_paste);
    assert!(caps.focus_events);
    assert_eq!(caps.terminal_identity.as_deref(), Some("kitty(0.36.0)"));
}

#[test]
fn da1_param_52_marks_osc52_clipboard() {
    let (caps, _) = probe_with(&[b"\x1b[?62;52c"]);
    assert!(caps.probed);
    assert!(caps.osc52, "param 52 in DA1 advertises OSC 52: {caps:?}");
    assert!(!caps.kitty_keyboard);
    assert!(!caps.kitty_underline);
    assert!(!caps.bracketed_paste);
    assert!(!caps.focus_events);
    assert_eq!(caps.terminal_identity, None);
}

#[test]
fn da1_without_param_52_leaves_osc52_false() {
    // The classic VT100-with-AVO reply carries no 52.
    let (caps, _) = probe_with(&[b"\x1b[?1;2c"]);
    assert!(caps.probed);
    assert!(!caps.osc52);
}

#[test]
fn xtversion_sets_terminal_identity() {
    let (caps, _) = probe_with(&[b"\x1bP>|kitty(0.36.0)\x1b\\"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity.as_deref(), Some("kitty(0.36.0)"));
    assert!(!caps.kitty_keyboard);
    assert!(!caps.osc52);
}

#[test]
fn da2_params_fallback_terminal_identity() {
    // Only DA2 answers: the raw Pp;Pv;Pc code is the identity.
    let (caps, _) = probe_with(&[b"\x1b[>84;0;0c"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity.as_deref(), Some("84;0;0"));
    assert!(!caps.osc52);
    assert!(!caps.kitty_keyboard);
}

#[test]
fn xtgettcap_tn_raw_value_sets_identity() {
    // The task fixture: TN with a raw (non-hexlified) value.
    let (caps, _) = probe_with(&[b"\x1bP1+r544e=1;62;72\x1b\\"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity.as_deref(), Some("1;62;72"));
    // TN is a name, not a capability.
    assert!(!caps.kitty_keyboard);
    assert!(!caps.osc52);
}

#[test]
fn xtgettcap_hexlified_value_is_decoded() {
    // kitty hexlifies string values: 787465726d2d6b69747479 is
    // "xterm-kitty" in hex.
    let (caps, _) = probe_with(&[b"\x1bP1+r544e=787465726d2d6b69747479\x1b\\"]);
    assert_eq!(caps.terminal_identity.as_deref(), Some("xterm-kitty"));
}

#[test]
fn xtgettcap_negative_reply_reports_nothing() {
    // 0+r: the requested names are unknown to the terminal. A reply
    // nonetheless (probed), but no capability is reported.
    let (caps, _) = probe_with(&[b"\x1bP0+r584b\x1b\\"]);
    assert!(caps.probed);
    assert!(!caps.kitty_keyboard);
    assert_eq!(caps.terminal_identity, None);
}

#[test]
fn xtgettcap_multi_name_single_dcs_is_parsed() {
    // xterm replies to a multi-name query with one DCS holding every
    // name/value pair, separated by ';'.
    let (caps, _) =
        probe_with(&[b"\x1bP1+r66756c6c6b6264=31;5375=30;544e=787465726d\x1b\\".as_slice()]);
    assert!(caps.probed);
    assert!(caps.kitty_keyboard, "fullkbd=1: {caps:?}");
    assert!(!caps.kitty_underline, "Su=0: {caps:?}");
    assert_eq!(caps.terminal_identity.as_deref(), Some("xterm"));
}

#[test]
fn silent_terminal_times_out_to_conservative_defaults() {
    let caps = probe_capabilities(SilentReader, Vec::new(), Duration::from_millis(10));
    // The reader never answers: the per-query budget expires, and the
    // report stays all-false with probed=false.
    assert_eq!(caps, TerminalCapabilities::default());
    assert!(!caps.probed);
}

#[test]
fn empty_reply_stream_yields_conservative_defaults() {
    let (caps, _) = probe_with(&[]);
    assert_eq!(caps, TerminalCapabilities::default());
    assert!(!caps.probed);
}

#[test]
fn probed_kitty_identity_enables_scroll_region() {
    // The full kitty reply set self-identifies (XTVERSION) and is not
    // tmux or screen: the scroll-region optimization is safe.
    let (caps, _) = probe_with(&kitty_replies());
    assert!(caps.probed);
    assert!(caps.scroll_region, "kitty identity: {caps:?}");
}

#[test]
fn tmux_identity_disables_scroll_region() {
    // tmux's DECSTBM quirks make scroll-region painting unsafe (the M2
    // roadmap risk the probe gates).
    let (caps, _) = probe_with(&[b"\x1bP>|tmux 3.4\x1b\\"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity.as_deref(), Some("tmux 3.4"));
    assert!(!caps.scroll_region);
}

#[test]
fn screen_identity_disables_scroll_region() {
    // screen shares tmux's DECSTBM quirks; the same conservative gate.
    let (caps, _) = probe_with(&[b"\x1bP>|screen 4.09.00\x1b\\"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity.as_deref(), Some("screen 4.09.00"));
    assert!(!caps.scroll_region);
}

#[test]
fn unidentifiable_reply_leaves_scroll_region_false() {
    // A DA1-only answer probes the terminal but names no identity: no
    // scroll optimization without a self-identified terminal.
    let (caps, _) = probe_with(&[b"\x1b[?62;52c"]);
    assert!(caps.probed);
    assert_eq!(caps.terminal_identity, None);
    assert!(!caps.scroll_region);
}

#[test]
fn silent_terminal_leaves_scroll_region_false() {
    // The silent terminal times out: not probed, conservative defaults,
    // no scroll optimization.
    let caps = probe_capabilities(SilentReader, Vec::new(), Duration::from_millis(10));
    assert!(!caps.probed);
    assert!(!caps.scroll_region);
}

#[test]
fn cached_probe_returns_the_same_instance() {
    // The OnceLock cache (mirroring backend.rs) returns one stable
    // report; this also covers the test-harness path where stdin is not
    // a TTY and the probe stays conservative.
    assert!(std::ptr::eq(probe(), probe()));
}
