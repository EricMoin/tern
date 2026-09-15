//! Terminal lifecycle and out-of-band escapes: input modes (mouse
//! capture, focus change, bracketed paste, keyboard enhancement), the
//! alternate-screen startup, the window title, and OSC 52 clipboard.

use super::*;

/// Enable mouse, focus-change, and bracketed-paste event reporting on any
/// `Write` target, gated by the interactive capability probe.
///
/// Emits the mouse capture modes minus any-event tracking (normal, button-
/// event, rxvt, and SGR: `?1000h` `?1002h` `?1015h` `?1006h`) always, then
/// focus-change reporting (`?1004h`) only when the cached [`probe`] reports
/// `focus_events`, then bracketed-paste mode (`?2004h`) only when it reports
/// `bracketed_paste`. Without these, crossterm never surfaces mouse, focus,
/// or paste events to [`poll_events`](crate::event::poll_events). Any-event
/// tracking (`?1003h`), which makes the terminal report every mouse motion,
/// is deliberately NOT part of the default path — it streams high-volume
/// motion events even when nothing consumes them. crossterm's
/// `EnableMouseCapture` command bundles `?1003h`, so the four tiered modes
/// are written raw through the `Write` (the same seam as
/// [`set_clipboard_to`]); opt into motion reporting with
/// [`enable_any_event_mouse_to`]. Pair with
/// [`disable_event_listening_to`] at shutdown.
///
/// The gating logic lives in [`enable_event_listening_with`] (unit-testable
/// with explicit capabilities); this entry point feeds it the cached probe,
/// so `Backend::startup`, `Backend::enable_event_listening`, and the
/// SIGCONT resume all gate the optional modes on what the probe reported. A
/// probe skipped or unanswered (non-TTY, `TERM=dumb`, or a silent terminal)
/// reports conservative defaults, so focus and bracketed paste simply stay
/// off there.
pub fn enable_event_listening_to<W: Write>(w: &mut W) -> io::Result<()> {
    enable_event_listening_with(w, probe())
}

/// Enable mouse, focus-change, and bracketed-paste event reporting on any
/// `Write` target, with the probe-gated modes decided by explicit
/// capabilities.
///
/// The mouse capture modes (normal, button-event, rxvt, and SGR: `?1000h`
/// `?1002h` `?1015h` `?1006h`) are emitted unconditionally; `EnableFocusChange`
/// (`?1004h`) and `EnableBracketedPaste` (`?2004h`) follow only when `caps`
/// reports the terminal supports focus events / bracketed paste. With both
/// supported the byte stream is identical to the pre-gate sequence — the
/// terminal's behavior never changes on a fully capable terminal, and a
/// terminal that never enabled a mode has nothing to restore (the disable
/// sequences in [`disable_event_listening_to`] are harmless no-ops there).
///
/// The same seam pattern as [`flush_diff_to`]: `caps` is injected so the
/// exact escape bytes are unit-testable against an in-memory buffer without
/// a terminal or a probe run.
pub fn enable_event_listening_with<W: Write>(
    w: &mut W,
    caps: &TerminalCapabilities,
) -> io::Result<()> {
    w.write_all(b"\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h")?;
    if caps.focus_events {
        w.queue(EnableFocusChange)?;
    }
    if caps.bracketed_paste {
        w.queue(EnableBracketedPaste)?;
    }
    w.flush()
}

/// Opt into any-event mouse tracking on any `Write` target: the terminal
/// reports every mouse motion (`?1003h`), not just presses and drags.
///
/// Call only while a motion/drag listener is registered — see
/// [`enable_event_listening_to`], which leaves this mode off. Pair with
/// [`disable_any_event_mouse_to`]; the full teardown in
/// [`disable_event_listening_to`] clears this mode too.
pub fn enable_any_event_mouse_to<W: Write>(w: &mut W) -> io::Result<()> {
    w.write_all(b"\x1b[?1003h")?;
    w.flush()
}

/// Stop any-event mouse tracking on any `Write` target (`?1003l`): the
/// terminal stops reporting motion without a button pressed. Drags still
/// report via the button-event tracking enabled by
/// [`enable_event_listening_to`].
pub fn disable_any_event_mouse_to<W: Write>(w: &mut W) -> io::Result<()> {
    w.write_all(b"\x1b[?1003l")?;
    w.flush()
}

/// Disable mouse, focus-change, and bracketed-paste event reporting on any
/// `Write` target.
///
/// Emits the inverse of [`enable_event_listening_to`]: bracketed-paste mode
/// off, focus-change reporting off, then the mouse capture modes off in
/// reverse order. The mouse clear also turns off any-event tracking
/// (`?1003l`), so a separately enabled
/// [`enable_any_event_mouse_to`] mode is fully restored by this teardown.
pub fn disable_event_listening_to<W: Write>(w: &mut W) -> io::Result<()> {
    w.queue(DisableMouseCapture)?;
    w.queue(DisableFocusChange)?;
    w.queue(DisableBracketedPaste)?;
    w.flush()
}

/// Set the terminal window title (OSC 0: `ESC ] 0 ; title BEL`) on any
/// `Write` target.
pub fn set_title_to<W: Write>(w: &mut W, title: &str) -> io::Result<()> {
    w.queue(SetTitle(title))?;
    w.flush()
}

/// Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
/// BEL`) on any `Write` target.
///
/// The escape is `ESC ] 52 ; c ; <payload> BEL` — OSC 52 with the selection
/// parameter `c` (the clipboard) and the payload as the text's UTF-8 bytes
/// base64-encoded per RFC 4648 (the standard xterm "Manipulate Selection
/// Data" protocol). BEL (`\x07`) terminates the OSC string, matching the
/// project's OSC 0 title convention; a terminal accepts BEL or ST (`ESC \`)
/// interchangeably as the OSC terminator. crossterm's own clipboard command
/// is gated behind its off-by-default `osc52` feature and emits the ST
/// terminator, so the sequence is written through the queue directly rather
/// than queued as a crossterm command.
pub fn set_clipboard_to<W: Write>(w: &mut W, text: &str) -> io::Result<()> {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    w.write_all(b"\x1b]52;c;")?;
    w.write_all(encoded.as_bytes())?;
    w.write_all(b"\x07")?;
    w.flush()
}

/// Queue the renderer's post-raw-mode startup sequence into `w`: the
/// alternate screen (skipped when `use_alt_screen` is `false`), the window
/// title (when `Some`), then event listening — one batch, one flush.
///
/// Write-based so the exact escape bytes are unit-testable without a
/// terminal (the same seam as [`flush_diff_to`]).
pub fn queue_startup_to<W: Write>(
    w: &mut W,
    use_alt_screen: bool,
    title: Option<&str>,
) -> io::Result<()> {
    if use_alt_screen {
        w.queue(EnterAlternateScreen)?;
    }
    if let Some(title) = title {
        w.queue(SetTitle(title))?;
    }
    enable_event_listening_to(w)
}
