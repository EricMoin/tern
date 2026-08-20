//! Interactive terminal capability probing.
//!
//! Upgrades the backend's terminal knowledge from environment guessing
//! (`TERM_PROGRAM`, `supports-color`) to an interactive query/reply probe:
//! the terminal is asked — over the wire, not from `$TERM` — about its
//! device attributes and kitty protocol extensions, and the replies are
//! parsed into a [`TerminalCapabilities`] report.
//!
//! The probe sends five queries in one batch, then reads the replies:
//!
//! * **DA1** — Primary Device Attributes (`CSI c`). Every terminal answers.
//!   The reply is `CSI ? 1 ; 2 c` (VT100 with Advanced Video Option),
//!   `CSI ? 62 ; Ps c` (VT220 and up), etc. — a `?`-prefixed parameter list
//!   ending in `c`. The parameter `52` advertises OSC 52 clipboard access
//!   (the contour-terminal clipboard extension), which is how
//!   [`TerminalCapabilities::osc52`] is detected.
//! * **DA2** — Secondary Device Attributes (`CSI > c`). The reply is
//!   `CSI > Pp ; Pv ; Pc c`: terminal type, firmware version, patch level
//!   (e.g. kitty replies `CSI > 84 ; 0 ; 0 c`). Used as a last-resort
//!   terminal identity when nothing better reports.
//! * **DA3** — Tertiary Device Attributes (`CSI = c`). Replies are the
//!   DECRPTUI terminal-unit identifier — xterm sends `DCS ! | <8 hex
//!   digits> ST`; some terminals send `CSI = Pid ; Pv c`. Parsed for
//!   completeness (a DA3 answer confirms the terminal is answering), but
//!   mapped to no capability.
//! * **XTVERSION** (`CSI > q`) — the reply is `DCS > | <text> ST`, e.g.
//!   kitty replies `DCS > | kitty(0.36.0) ST`. The `<text>` is the
//!   authoritative [`TerminalCapabilities::terminal_identity`].
//! * **XTGETTCAP** (`DCS + q <hex-names> ST`) — terminfo capability query.
//!   The reply is `DCS 1 + r <hex-names> = <hex-value> ST` per name (kitty
//!   emits one DCS per capability, xterm one DCS holding every name/value
//!   pair), or `DCS 0 + r ST` for an unknown name. Boolean capabilities
//!   (kitty's `fullkbd`, `Su`, `XF`) reply without a value; strings reply
//!   with a value that is hexlified by some terminals (kitty) and written
//!   raw by others (xterm) — the parser accepts both. The probed
//!   capabilities are `fullkbd`/`XK` (kitty keyboard protocol),
//!   `Su`/`Setulc` (kitty underline styles), `Ms` (OSC 52 clipboard),
//!   `XF` (focus events), `PS` (bracketed paste), and `TN` (terminal name).
//!
//! Every wait is time-bounded and every failure is conservative: a query
//! that gets no reply, a terminal that is not interactive, or a broken read
//! all yield the all-`false` [`TerminalCapabilities::default`], never a
//! wrong guess. The total probe budget is five per-query timeouts (300 ms
//! at the default 60 ms), so a terminal that swallows the queries costs at
//! most a third of a second at startup. The cached [`probe()`] entry point
//! runs the probe once per process (mirroring the backend's
//! [`BackendCapabilities`](crate::backend::BackendCapabilities) cache) and
//! skips it entirely — staying conservative — when stdin/stdout are not
//! TTYs or `TERM` is `dumb`.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::tty::IsTty;

/// The interactive capability report for the terminal on stdin/stdout.
///
/// Every field defaults conservatively to "no" (`false`, `None`): a
/// capability is reported only when the terminal itself said it supports it
/// during the probe. [`probed`](TerminalCapabilities::probed) distinguishes
/// "the terminal answered" from "the probe was skipped or timed out".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalCapabilities {
    /// Whether any query reply was parsed. `false` when the probe was
    /// skipped (non-TTY or `TERM=dumb`) or every query went unanswered
    /// (timeout / empty reply); every field is then a conservative default.
    pub probed: bool,
    /// The terminal's self-reported identity: the XTVERSION text when the
    /// terminal answers it (e.g. `kitty(0.36.0)`), else the XTGETTCAP `TN`
    /// capability value, else the raw DA2 `Pp;Pv;Pc` identification code.
    /// `None` when no reply named the terminal.
    pub terminal_identity: Option<String>,
    /// Whether the kitty keyboard protocol is supported (XTGETTCAP
    /// `fullkbd`/`XK`). When `false`, the backend falls back to legacy key
    /// reporting instead of pushing `CSI > flags u` enhancement flags.
    pub kitty_keyboard: bool,
    /// Whether kitty extended underline styles are supported (XTGETTCAP
    /// `Su`/`Setulc`: `CSI 4:N m` variants and colored underlines). When
    /// `false`, the backend takes the plain `CSI 4 m` fallback.
    pub kitty_underline: bool,
    /// Whether OSC 52 clipboard writes are supported: the DA1 parameter
    /// `52` (the contour clipboard-extension marker, what kitty advertises
    /// with `CSI ? 62;52c`), or an XTGETTCAP `Ms` reply.
    pub osc52: bool,
    /// Whether bracketed paste mode is supported (XTGETTCAP `PS`/`BE`).
    /// When `false`, paste events are filtered at the event layer.
    pub bracketed_paste: bool,
    /// Whether focus in/out events are supported (XTGETTCAP `XF`). When
    /// `false`, focus-event reporting stays disabled.
    pub focus_events: bool,
}

/// The five queries the probe sends, in stream order: DA1, DA2, DA3,
/// XTVERSION, XTGETTCAP. Replies arrive in the same order, which lets the
/// parser drain complete replies from the front of the read buffer.
const QUERY_COUNT: usize = 5;

/// The per-query reply deadline [`probe()`] uses: the whole probe is
/// bounded to `QUERY_COUNT * 60 ms = 300 ms` (see
/// [`probe_capabilities`]). A real terminal answers DA1 in microseconds;
/// the budget mostly covers the queries terminals ignore.
const DEFAULT_PER_QUERY_TIMEOUT: Duration = Duration::from_millis(60);

/// How long the probe waits after every query has an answer for a
/// multi-DCS XTGETTCAP tail (kitty emits one `DCS 1+r` per requested
/// capability) before declaring the probe finished. Kept small: once the
/// reply burst has passed, the reader stays silent.
const DRAIN_GRACE: Duration = Duration::from_millis(10);

/// How long the reader thread sleeps between would-block reads: the interval
/// at which it re-checks the probe's stop flag once the probe has finished
/// (see `probe_capabilities`). Also the upper bound on how long a finished
/// probe's reader thread can linger before exiting.
const PROBE_READ_RETRY: Duration = Duration::from_millis(2);

/// How long [`probe_capabilities`] waits after setting the reader thread's
/// stop flag for the thread to observe it and exit — the grace that makes
/// "the probe has returned" imply "no reader thread is still attached to
/// stdin" (see the reader-thread docs).
const READER_STOP_GRACE: Duration = Duration::from_millis(5);

/// The XTGETTCAP capability names the probe requests, hex-encoded in the
/// DCS payload. `fullkbd` and `XK` both name the kitty keyboard protocol
/// (kitty's own terminfo uses `fullkbd`; `XK` is the name other terminals
/// answer), `Su`/`Setulc` name underline styles, `Ms` the OSC 52 clipboard
/// string, `XF` focus events, `PS` bracketed paste, and `TN` the terminal
/// name. An unknown name costs nothing: the terminal replies `DCS 0 + r`
/// and the parser ignores it.
const TCAP_CAPNAMES: &[&str] = &["fullkbd", "XK", "Su", "Setulc", "Ms", "XF", "PS", "TN"];

/// The cached probe result, filled on first use (mirroring the backend's
/// `CAPABILITIES` cache at backend.rs:93).
static TERMINAL_CAPABILITIES: OnceLock<TerminalCapabilities> = OnceLock::new();

/// The terminal's interactive capabilities, probed once and cached.
///
/// The first call runs the probe against the real stdin/stdout unless they
/// are not interactive (not a TTY, or `TERM=dumb`), in which case it stays
/// conservative; every later call returns the cached result. Callers must
/// not run the probe repeatedly: it takes up to 300 ms and every extra run
/// only re-reads the same answers.
pub fn probe() -> &'static TerminalCapabilities {
    TERMINAL_CAPABILITIES.get_or_init(probe_once)
}

/// Run [`probe_capabilities`] against the real stdin/stdout, skipping the
/// probe entirely — staying conservative — when they are not TTYs or the
/// `TERM` is `dumb` (a non-interactive terminal cannot answer queries and
/// would only burn the probe budget). Reading uses stdin; writing uses
/// stdout.
fn probe_once() -> TerminalCapabilities {
    let stdin_tty = io::stdin().is_tty();
    let stdout_tty = io::stdout().is_tty();
    let dumb = std::env::var("TERM").is_ok_and(|term| term == "dumb");
    if !stdin_tty || !stdout_tty || dumb {
        return TerminalCapabilities::default();
    }
    // The probe's reader thread must not stay blocked in `read()` on stdin
    // after the probe returns: a blocked read would consume the next input
    // byte the application reads (the probe and the event loop share the
    // stdin fd). Make stdin non-blocking for the probe's duration — a
    // no-data read returns WouldBlock, the reader thread sleeps and
    // re-checks its stop flag, and exits within milliseconds of the probe
    // finishing. The original flags are restored before this returns.
    #[cfg(unix)]
    let prev_flags = rustix::fs::fcntl_getfl(&io::stdin()).ok();
    #[cfg(unix)]
    if let Some(prev) = &prev_flags {
        // `OFlags` is a bitflags set; `|` yields the combined flags.
        let _ = rustix::fs::fcntl_setfl(&io::stdin(), *prev | rustix::fs::OFlags::NONBLOCK);
    }
    let caps = probe_capabilities(io::stdin(), io::stdout(), DEFAULT_PER_QUERY_TIMEOUT);
    #[cfg(unix)]
    if let Some(prev) = prev_flags {
        // Restore the exact flags observed before the probe: a failed
        // restore leaves stdin non-blocking (crossterm's event source sets
        // its own non-blocking mode when it starts, so the app is not
        // affected), but it is best-effort anyway.
        let _ = rustix::fs::fcntl_setfl(&io::stdin(), prev);
    }
    caps
}

/// Probe the terminal connected to `reader`/`writer` and parse its answers
/// into a [`TerminalCapabilities`] report.
///
/// Sends all five queries (DA1, DA2, DA3, XTVERSION, XTGETTCAP — see the
/// module docs for the exact sequences) in one batch, then reads replies
/// until every query has been answered or the total budget
/// (`timeout * 5`, 300 ms at the default 60 ms) is exhausted. `timeout` is
/// the per-query share of the budget. Replies may arrive in one read or
/// split across many, and are parsed incrementally as they accumulate.
///
/// The XTGETTCAP reply spans several DCS sequences on some terminals (kitty
/// answers one DCS per requested capability, xterm bundles them into one),
/// so once every other query is answered the probe keeps reading while
/// XTGETTCAP replies keep arriving and stops only after a short quiet
/// grace (10 ms) or when the budget runs out — a split reply stream is
/// fully consumed instead of being truncated at the first DCS.
///
/// Every failure mode returns conservative defaults: a write or read error,
/// an immediate EOF (no replies at all), or a silent terminal that never
/// answers within the budget all yield `TerminalCapabilities::default()`
/// with [`probed`](TerminalCapabilities::probed) `false` — never a
/// capability guess. A terminal that answers some queries but not others
/// reports exactly what it answered (the unanswered capabilities stay
/// `false`).
///
/// `reader` must be `Send + 'static`: the timeout is enforced by reading on
/// a background thread and waiting on a channel, so a generic `Read` that
/// blocks past the deadline cannot hang the probe. `std::io::Stdin`, `File`
/// (e.g. `/dev/tty`), and in-memory readers (tests) all qualify. After the
/// probe returns, the background thread lingers only until the reader next
/// delivers bytes (its channel receiver is gone), so it never consumes
/// input indefinitely.
pub fn probe_capabilities<R: Read + Send + 'static, W: Write>(
    reader: R,
    mut writer: W,
    timeout: Duration,
) -> TerminalCapabilities {
    // Feed the reader's bytes into a channel from a background thread, so
    // the deadline below can be enforced with recv_timeout even against a
    // reader whose `read` blocks (a real TTY that swallows the queries).
    // The thread exits on its own once the probe is done — see the stop
    // flag below — so it can never outlive the probe and steal the
    // application's next input byte (the probe reads the same stdin the
    // event loop reads; a lingering blocked reader would consume it).
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let reader_thread = thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 256];
        loop {
            // The probe has everything it is going to get: exit now. With
            // the non-blocking stdin `probe_once` sets up, a no-data read
            // returns WouldBlock and this check runs again within
            // `PROBE_READ_RETRY`; an in-memory test reader returns
            // immediately instead.
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                // EOF (0) or a read error: no more replies will arrive.
                Ok(0) => break,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    // No data yet on the non-blocking stdin: breathe, then
                    // re-check the stop flag. (A real TTY answers the probe
                    // queries in microseconds; the sleep is for the silent
                    // case.)
                    thread::sleep(PROBE_READ_RETRY);
                }
                Err(_) => break,
                Ok(n) => {
                    // A failed send means the probe already returned: stop
                    // reading so the thread exits at its next wake-up.
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Send every query in one batch, then flush. The terminal processes
    // them in order, so replies arrive in the same order.
    for query in queries() {
        if writer.write_all(&query).is_err() {
            return TerminalCapabilities::default();
        }
    }
    if writer.flush().is_err() {
        return TerminalCapabilities::default();
    }

    // Read and parse until every reply is in hand or the budget is spent.
    let deadline = Instant::now() + timeout.saturating_mul(QUERY_COUNT as u32);
    let mut buffer: Vec<u8> = Vec::with_capacity(512);
    let mut caps = TerminalCapabilities::default();
    let mut seen = ReplySet::default();
    loop {
        drain_replies(&mut buffer, &mut caps, &mut seen);
        if seen.complete() {
            // Every query has an answer, but the XTGETTCAP reply can span
            // several DCS sequences (kitty emits one per requested name),
            // and more bytes may still be in flight. Give the reader one
            // grace wait for stragglers, then finish.
            match rx.recv_timeout(DRAIN_GRACE) {
                Ok(chunk) => buffer.extend_from_slice(&chunk),
                Err(_) => break,
            }
            continue;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(chunk) => buffer.extend_from_slice(&chunk),
            // Timeout: the terminal never answered the remaining queries.
            // Disconnected: the reader hit EOF or an error, so no more
            // replies exist. Either way, keep what was parsed.
            Err(_) => break,
        }
    }
    drain_replies(&mut buffer, &mut caps, &mut seen);
    // Signal the reader thread to exit and give it one poll interval to
    // observe the flag: when this function returns, no thread is blocked on
    // stdin anymore, so the application's next input byte cannot be stolen.
    // (A test reader that blocks forever, e.g. `SilentReader`, stays parked
    // — the thread is not joined, and the process ends with it.)
    stop.store(true, Ordering::Relaxed);
    thread::sleep(READER_STOP_GRACE);
    drop(reader_thread);
    caps
}

/// The probe queries in stream order. XTGETTCAP is built from
/// [`TCAP_CAPNAMES`] hex-encoded; the rest are fixed escape sequences.
fn queries() -> [Vec<u8>; QUERY_COUNT] {
    [
        b"\x1b[c".to_vec(),  // DA1: primary device attributes
        b"\x1b[>c".to_vec(), // DA2: secondary device attributes
        b"\x1b[=c".to_vec(), // DA3: tertiary device attributes (DECRPTUI)
        b"\x1b[>q".to_vec(), // XTVERSION: report terminal name and version
        xtgettcap_query(),   // DCS + q <hex capnames> ST
    ]
}

/// The XTGETTCAP request: `DCS + q <hex-encoded capnames> ST`, names joined
/// by `;` (two hex digits per byte).
fn xtgettcap_query() -> Vec<u8> {
    let mut query = b"\x1bP+q".to_vec();
    for (i, name) in TCAP_CAPNAMES.iter().enumerate() {
        if i > 0 {
            query.push(b';');
        }
        for byte in name.as_bytes() {
            query.extend_from_slice(format!("{:02x}", byte).as_bytes());
        }
    }
    query.extend_from_slice(b"\x1b\\");
    query
}

/// Which reply types the probe has already parsed, so the read loop knows
/// when it can stop early.
#[derive(Debug, Default)]
struct ReplySet {
    da1: bool,
    da2: bool,
    da3: bool,
    xtversion: bool,
    xtgettcap: bool,
}

impl ReplySet {
    /// Whether every query has been answered.
    fn complete(&self) -> bool {
        self.da1 && self.da2 && self.da3 && self.xtversion && self.xtgettcap
    }
}

/// One parsed terminal reply.
#[derive(Debug)]
enum Reply {
    /// DA1: `CSI ? <params> c`. The `52` parameter marks OSC 52 clipboard.
    Da1 { params: Vec<u16> },
    /// DA2: `CSI > Pp ; Pv ; Pc c` — terminal type, version, patch.
    Da2 { params: Vec<u16> },
    /// DA3: `CSI = <params> c` or the xterm DECRPTUI `DCS ! | <hex> ST`.
    /// The payload is informational (the terminal unit id); no capability
    /// is derived from it.
    Da3,
    /// XTVERSION: `DCS > | <text> ST`.
    XtVersion { text: String },
    /// XTGETTCAP: `DCS 1 + r <name> [= <value>] ST` pairs, or the
    /// empty/negative `DCS 0 + r ST` (unknown names).
    XtGetTcap {
        names: Vec<(String, Option<String>)>,
    },
}

/// Parse every complete reply at the front of `buffer`, applying each to
/// `caps` and marking it in `seen`. Stops at the first incomplete reply —
/// its bytes stay buffered for the next read.
fn drain_replies(buffer: &mut Vec<u8>, caps: &mut TerminalCapabilities, seen: &mut ReplySet) {
    while let Some(reply) = take_reply(buffer) {
        caps.probed = true;
        apply(reply, caps, seen);
    }
}

/// Take one complete reply from the front of `buffer`, draining its bytes.
/// Returns `None` when the front is not a complete reply (the bytes stay
/// put, awaiting more input). Replies arrive in query order, so only the
/// front is ever examined.
fn take_reply(buffer: &mut Vec<u8>) -> Option<Reply> {
    if buffer.starts_with(b"\x1b[") {
        return take_csi_reply(buffer);
    }
    if buffer.starts_with(b"\x1bP") {
        return take_dcs_reply(buffer);
    }
    None
}

/// Parse a leading CSI reply: `CSI <intermediate?> <params> <final>`. The
/// final byte is the first byte in `0x40..=0x7E` after the `ESC [` prefix;
/// the parameter string is everything between (digits, `;`, and the `?`,
/// `>`, `=` intermediates). The reply kind follows from the intermediate
/// byte and the final byte.
fn take_csi_reply(buffer: &mut Vec<u8>) -> Option<Reply> {
    // The final byte of a CSI sequence is the first byte in the
    // 0x40..=0x7E range, after the ESC [ prefix.
    let final_at = buffer
        .iter()
        .enumerate()
        .skip(2)
        .find_map(|(i, &b)| (0x40..=0x7e).contains(&b).then_some(i))?;
    let final_byte = buffer[final_at];
    // Only DA replies (final 'c') are expected; anything else (a stray key
    // report, a query echo) is ignored and drained.
    if final_byte != b'c' {
        buffer.drain(..=final_at);
        return None;
    }
    // The parameter string sits between the prefix and the final byte. The
    // first byte after ESC [ is the intermediate marker ('?', '>', '=').
    let params_text = std::str::from_utf8(&buffer[3..final_at]).unwrap_or("");
    let reply = match buffer[2] {
        b'?' => Some(Reply::Da1 {
            params: parse_params(params_text),
        }),
        b'>' => Some(Reply::Da2 {
            params: parse_params(params_text),
        }),
        b'=' => Some(Reply::Da3),
        _ => None,
    };
    buffer.drain(..=final_at);
    reply
}

/// Parse a leading DCS reply: `ESC P <payload> ST`, where ST is `ESC \` or
/// the single-byte `0x9C` terminator. The reply kind follows from the
/// payload's prefix.
fn take_dcs_reply(buffer: &mut Vec<u8>) -> Option<Reply> {
    // Find the string terminator: ESC \ (two bytes) or 0x9C (one byte).
    // `payload_end` is where the payload stops (before the terminator);
    // `drain_end` is where the buffer drain stops (after the terminator).
    let (payload_end, drain_end) = if let Some(i) = buffer.iter().position(|&b| b == 0x9c) {
        (i, i)
    } else if let Some(i) = buffer.windows(2).position(|w| w == b"\x1b\\") {
        (i, i + 1)
    } else {
        return None;
    };
    let payload = std::str::from_utf8(&buffer[2..payload_end]).ok()?;
    let reply = classify_dcs_payload(payload);
    buffer.drain(..=drain_end);
    reply
}

/// Classify a DCS payload (the bytes between `ESC P` and the terminator)
/// into a reply.
fn classify_dcs_payload(payload: &str) -> Option<Reply> {
    if let Some(text) = payload.strip_prefix('>') {
        // XTVERSION: DCS > | <text> ST (the '|' separator is present in
        // xterm and kitty; accept its absence too).
        let text = text.strip_prefix('|').unwrap_or(text);
        return Some(Reply::XtVersion {
            text: text.to_string(),
        });
    }
    if payload.starts_with('!') {
        // DECRPTUI (xterm's DA3 reply): DCS ! | <hex id> ST.
        return Some(Reply::Da3);
    }
    if let Some(status) = payload.strip_prefix('1').and_then(|p| p.strip_prefix("+r")) {
        // XTGETTCAP success: DCS 1 + r <name>[= <value>] ; ... ST.
        return Some(Reply::XtGetTcap {
            names: parse_xtgettcap(status),
        });
    }
    if payload.starts_with("0+r") {
        // XTGETTCAP negative reply: the requested names are unknown. A
        // response nonetheless — marks the query answered, reports nothing.
        return Some(Reply::XtGetTcap { names: Vec::new() });
    }
    // An unrelated DCS (e.g. an application reply) — ignore and drain.
    None
}

/// Parse the name/value pairs of an XTGETTCAP success payload: hex-encoded
/// names, each optionally followed by `=<value>`. The payload is `;`
/// separated; a segment containing `=` starts a new name/value pair, a
/// segment without one continues the previous pair's value when a pair is
/// open (a raw, non-hexlified value may itself contain `;` — the task's
/// `1+r544e=1;62;72` form) and otherwise starts a nameless-value pair
/// (kitty's boolean replies like `1+r66756c6c6b6264` carry no value).
/// Values are hexlified by some terminals (kitty) and written raw by others
/// (xterm); [`decode_tcap_value`] accepts both.
fn parse_xtgettcap(payload: &str) -> Vec<(String, Option<String>)> {
    let mut names = Vec::new();
    let mut current: Option<(String, Option<String>)> = None;
    for part in payload.split(';') {
        if let Some((name_hex, value)) = part.split_once('=') {
            if let Some(prev) = current.take() {
                names.push(prev);
            }
            let Some(name) = decode_hex(name_hex)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
            else {
                continue;
            };
            current = Some((name, Some(decode_tcap_value(value))));
        } else if let Some((_, value)) = current.as_mut() {
            // No '=' and a pair is open: this segment continues the
            // previous pair's value (raw values may contain ';').
            let value = value.get_or_insert_with(String::new);
            value.push(';');
            value.push_str(part);
        } else if let Ok(name) = decode_hex(part) {
            // No '=' and no pair open: a boolean capability with no value.
            if let Ok(name) = String::from_utf8(name) {
                current = Some((name, None));
            }
        }
    }
    if let Some(prev) = current {
        names.push(prev);
    }
    names
}

/// The XTGETTCAP value encoding differs between terminals: kitty hexlifies
/// (`hexlify` in kitty/terminfo.py), xterm writes the value raw
/// (xterm-390/misc.c). Accept both — when the value is entirely hex digits
/// and its bytes decode to printable ASCII it is treated as hexlified,
/// otherwise it is used verbatim.
fn decode_tcap_value(raw: &str) -> String {
    if raw.len().is_multiple_of(2) && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Ok(bytes) = decode_hex(raw) {
            if bytes.iter().all(|&b| b.is_ascii_graphic() || b == b' ') {
                if let Ok(text) = String::from_utf8(bytes) {
                    return text;
                }
            }
        }
    }
    raw.to_string()
}

/// Decode a hex-encoded byte string (two hex digits per byte).
fn decode_hex(text: &str) -> Result<Vec<u8>, ()> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(());
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = hex_digit(pair[0])?;
        let lo = hex_digit(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

/// The value of a hex digit byte, or `Err` when it is not one.
fn hex_digit(b: u8) -> Result<u8, ()> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(()),
    }
}

/// Parse a CSI parameter string (`1;2`, `84;0;0`, or empty) into `u16`s.
fn parse_params(text: &str) -> Vec<u16> {
    text.split(';')
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse::<u16>().ok())
        .collect()
}

/// Apply a parsed reply to the capability report.
fn apply(reply: Reply, caps: &mut TerminalCapabilities, seen: &mut ReplySet) {
    match reply {
        Reply::Da1 { params } => {
            seen.da1 = true;
            // The parameter 52 advertises OSC 52 clipboard access (the
            // contour clipboard extension; kitty emits `?62;52c` when
            // clipboard writes are allowed).
            caps.osc52 |= params.contains(&52);
        }
        Reply::Da2 { params } => {
            seen.da2 = true;
            // Last-resort identity: the raw Pp;Pv;Pc identification code.
            if caps.terminal_identity.is_none() && !params.is_empty() {
                let code = params
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(";");
                caps.terminal_identity = Some(code);
            }
        }
        Reply::Da3 => {
            // Informational (DECRPTUI / kitty-keyboard identification);
            // no capability is mapped from it, but it confirms the
            // terminal is answering (probed is set by the caller).
            seen.da3 = true;
        }
        Reply::XtVersion { text } => {
            seen.xtversion = true;
            // The authoritative name: overwrites any fallback identity.
            caps.terminal_identity = Some(text);
        }
        Reply::XtGetTcap { names } => {
            seen.xtgettcap = true;
            for (name, value) in names {
                match name.as_str() {
                    "fullkbd" | "XK" => caps.kitty_keyboard = supported(value.as_deref()),
                    "Su" | "Setulc" => caps.kitty_underline = supported(value.as_deref()),
                    "Ms" => caps.osc52 = supported(value.as_deref()),
                    "XF" => caps.focus_events = supported(value.as_deref()),
                    "PS" | "BE" => caps.bracketed_paste = supported(value.as_deref()),
                    "TN" | "name" => {
                        // The terminal name, behind XTVERSION (which is
                        // authoritative) and in front of the DA2 code.
                        if caps.terminal_identity.is_none() {
                            caps.terminal_identity = value;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Whether an XTGETTCAP reply reports support for a capability. A
/// capability answered without a value (kitty's boolean `1+r<name>`) is
/// supported; an explicit value of `0` is not; anything else counts as
/// supported.
fn supported(value: Option<&str>) -> bool {
    // A capability answered without a value (kitty's boolean `1+r<name>`)
    // is supported; an explicit value of `0` is not.
    value != Some("0")
}

#[cfg(test)]
mod tests {
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
    fn cached_probe_returns_the_same_instance() {
        // The OnceLock cache (mirroring backend.rs) returns one stable
        // report; this also covers the test-harness path where stdin is not
        // a TTY and the probe stays conservative.
        assert!(std::ptr::eq(probe(), probe()));
    }
}
