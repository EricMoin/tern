//! iTerm2 accessibility annotations (OSC 1337): the A11yAnnotation model
//! and the gated emitter that only writes them for a terminal that opted
//! in and reported iTerm2 support.

use super::*;

/// A hidden accessibility annotation for iTerm2: the summary text of one
/// `OSC 1337 ; AddHiddenAnnotation = <summary> BEL` sequence, which
/// VoiceOver reads when inspecting the terminal. Emitted via
/// [`flush_a11y_annotations_to`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct A11yAnnotation {
    summary: String,
}

impl A11yAnnotation {
    /// An annotation whose VoiceOver text is `summary`.
    pub fn new(summary: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
        }
    }

    /// The annotation's VoiceOver text.
    pub fn summary(&self) -> &str {
        &self.summary
    }
}

/// Write hidden accessibility annotations (`OSC 1337 ; AddHiddenAnnotation
/// = <summary> BEL`) for `entries` to any `Write` target — one sequence
/// per entry, in order — the seam [`Backend::set_a11y_annotations`]
/// funnels stdout through (mirroring [`set_clipboard_to`]).
///
/// The escape is `ESC ] 1337 ; AddHiddenAnnotation = <summary> BEL`. The
/// summary is written raw — iTerm2's `AddHiddenAnnotation` takes the
/// message text unencoded, unlike the OSC 52 clipboard payload which is
/// base64-encoded (per the iTerm2 escape-codes documentation, accessed
/// 2026-08-21). BEL (`\x07`) terminates the OSC string, matching the
/// project's OSC 0/52 convention; a terminal accepts BEL or ST (`ESC \`)
/// interchangeably as the OSC terminator. `AddHiddenAnnotation` does not
/// reveal the annotation window on receipt, so emitting these never
/// disturbs the visible screen. The whole batch is written and flushed
/// once.
pub fn flush_a11y_annotations_to<W: Write>(
    w: &mut W,
    entries: &[A11yAnnotation],
) -> io::Result<()> {
    for entry in entries {
        w.write_all(b"\x1b]1337;AddHiddenAnnotation=")?;
        w.write_all(entry.summary.as_bytes())?;
        w.write_all(b"\x07")?;
    }
    w.flush()
}

/// Whether iTerm2 hidden accessibility annotations should be emitted: the
/// caller opted in (`opt_in`) and the terminal self-identifies as iTerm2
/// (`caps.terminal_identity` contains "iTerm2" — the probe's XTVERSION /
/// TN / DA2 answer, e.g. `iTerm2 3.5.0`).
///
/// The pure decision behind [`flush_a11y_annotations_gated_to`], mirroring
/// the probe-gated pattern of [`enable_event_listening_with`]: only the
/// terminal that understands the `AddHiddenAnnotation` sequence receives
/// it, and an unknown or silent terminal (identity `None`) stays
/// conservative.
pub fn a11y_annotations_enabled(opt_in: bool, caps: &TerminalCapabilities) -> bool {
    opt_in
        && caps
            .terminal_identity
            .as_deref()
            .is_some_and(|id| id.contains("iTerm2"))
}

/// Write iTerm2 hidden accessibility annotations to any `Write` target,
/// gated by [`a11y_annotations_enabled`]: when the caller did not opt in
/// or the terminal is not a self-identified iTerm2, the write is a strict
/// no-op — `Ok(())` with zero bytes — so the emitter can run without ever
/// disturbing a terminal that does not understand the sequence.
///
/// The same injectable-capabilities seam as
/// [`enable_event_listening_with`]: `caps` is supplied by the caller so
/// the gating is unit-testable against an in-memory buffer without a
/// terminal or a probe run.
pub(super) fn flush_a11y_annotations_gated_to<W: Write>(
    w: &mut W,
    opt_in: bool,
    caps: &TerminalCapabilities,
    entries: &[A11yAnnotation],
) -> io::Result<()> {
    if !a11y_annotations_enabled(opt_in, caps) {
        return Ok(());
    }
    flush_a11y_annotations_to(w, entries)
}
