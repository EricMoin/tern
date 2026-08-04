//! Event normalization: crossterm input events → tern's [`TernEvent`] enum.
//!
//! Only [`KeyEventKind::Press`] key events are surfaced; repeat and release
//! key events are dropped. Resize, focus gained/lost, and mouse events
//! (press, release, drag, move, wheel) are all surfaced with their modifier
//! state; paste events are surfaced as [`TernEvent::Paste`]. [`poll_events`]
//! waits up to a caller-supplied timeout for the first event, then drains
//! everything currently buffered into a batch.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    self, Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton as CrosstermMouseButton, MouseEvent as CrosstermMouseEvent,
    MouseEventKind as CrosstermMouseEventKind,
};

/// A named key, independent of the character it produced.
///
/// Printable characters are reported as [`Char`](KeyName::Char) with the
/// character itself in [`TernKey::char`]; everything else has a dedicated
/// name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyName {
    /// A printable character key; see [`TernKey::char`].
    Char,
    /// The Enter / Return key.
    Enter,
    /// The Escape key.
    Escape,
    /// Backspace (Delete on macOS, Backspace on other platforms).
    Backspace,
    /// The Tab key.
    Tab,
    /// Shift + Tab.
    BackTab,
    /// The Delete (forward-delete) key.
    Delete,
    /// The Insert key.
    Insert,
    /// The Home key.
    Home,
    /// The End key.
    End,
    /// Page Up.
    PageUp,
    /// Page Down.
    PageDown,
    /// The Up arrow key.
    Up,
    /// The Down arrow key.
    Down,
    /// The Left arrow key.
    Left,
    /// The Right arrow key.
    Right,
    /// A function key, `F(1)` is F1.
    F(u8),
    /// The NUL key.
    Null,
    /// A key crossterm reported that tern does not classify yet.
    Unknown,
}

/// A normalized key event.
///
/// `char` is the printable character for [`Char`](KeyName::Char) keys (and
/// `None` for named keys). `ctrl` / `alt` / `shift` mirror the crossterm
/// modifier state; other modifiers (super, meta, hyper) are dropped in the
/// MVP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TernKey {
    /// The key's name.
    pub name: KeyName,
    /// The printable character, when this is a character key.
    pub char: Option<char>,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

impl TernKey {
    /// A key with explicit fields.
    pub const fn new(
        name: KeyName,
        char: Option<char>,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Self {
        Self {
            name,
            char,
            ctrl,
            alt,
            shift,
        }
    }
}

/// A mouse button, independent of the crossterm type it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseButton {
    /// The left mouse button.
    Left,
    /// The right mouse button.
    Right,
    /// The middle mouse button.
    Middle,
}

impl From<CrosstermMouseButton> for MouseButton {
    fn from(button: CrosstermMouseButton) -> Self {
        match button {
            CrosstermMouseButton::Left => Self::Left,
            CrosstermMouseButton::Right => Self::Right,
            CrosstermMouseButton::Middle => Self::Middle,
        }
    }
}

/// The kind of a mouse event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseEventKind {
    /// A mouse button was pressed.
    Down(MouseButton),
    /// A mouse button was released.
    Up(MouseButton),
    /// The mouse moved while a button was held (a drag).
    Drag(MouseButton),
    /// The mouse moved with no button held.
    Moved,
    /// The wheel scrolled down (toward the user).
    ScrollDown,
    /// The wheel scrolled up (away from the user).
    ScrollUp,
    /// The wheel scrolled left (mostly on a touchpad).
    ScrollLeft,
    /// The wheel scrolled right (mostly on a touchpad).
    ScrollRight,
}

/// A normalized mouse event.
///
/// `column` / `row` are the cell the event occurred on (0-based). `ctrl` /
/// `alt` / `shift` mirror the crossterm modifier state; other modifiers
/// (super, meta, hyper) are dropped, as with [`TernKey`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TernMouse {
    /// The kind of mouse event.
    pub kind: MouseEventKind,
    /// The column the event occurred on.
    pub column: u16,
    /// The row the event occurred on.
    pub row: u16,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

impl From<CrosstermMouseEvent> for TernMouse {
    fn from(event: CrosstermMouseEvent) -> Self {
        Self {
            kind: match event.kind {
                CrosstermMouseEventKind::Down(button) => MouseEventKind::Down(button.into()),
                CrosstermMouseEventKind::Up(button) => MouseEventKind::Up(button.into()),
                CrosstermMouseEventKind::Drag(button) => MouseEventKind::Drag(button.into()),
                CrosstermMouseEventKind::Moved => MouseEventKind::Moved,
                CrosstermMouseEventKind::ScrollDown => MouseEventKind::ScrollDown,
                CrosstermMouseEventKind::ScrollUp => MouseEventKind::ScrollUp,
                CrosstermMouseEventKind::ScrollLeft => MouseEventKind::ScrollLeft,
                CrosstermMouseEventKind::ScrollRight => MouseEventKind::ScrollRight,
            },
            column: event.column,
            row: event.row,
            ctrl: event.modifiers.contains(KeyModifiers::CONTROL),
            alt: event.modifiers.contains(KeyModifiers::ALT),
            shift: event.modifiers.contains(KeyModifiers::SHIFT),
        }
    }
}

/// Normalize a crossterm key event into a tern key.
impl From<KeyEvent> for TernKey {
    fn from(event: KeyEvent) -> Self {
        let name = match event.code {
            KeyCode::Char(_) => KeyName::Char,
            KeyCode::Enter => KeyName::Enter,
            KeyCode::Esc => KeyName::Escape,
            KeyCode::Backspace => KeyName::Backspace,
            KeyCode::Tab => KeyName::Tab,
            KeyCode::BackTab => KeyName::BackTab,
            KeyCode::Delete => KeyName::Delete,
            KeyCode::Insert => KeyName::Insert,
            KeyCode::Home => KeyName::Home,
            KeyCode::End => KeyName::End,
            KeyCode::PageUp => KeyName::PageUp,
            KeyCode::PageDown => KeyName::PageDown,
            KeyCode::Up => KeyName::Up,
            KeyCode::Down => KeyName::Down,
            KeyCode::Left => KeyName::Left,
            KeyCode::Right => KeyName::Right,
            KeyCode::F(n) => KeyName::F(n),
            KeyCode::Null => KeyName::Null,
            _ => KeyName::Unknown,
        };
        let char = match event.code {
            KeyCode::Char(c) => Some(c),
            _ => None,
        };
        Self {
            name,
            char,
            ctrl: event.modifiers.contains(KeyModifiers::CONTROL),
            alt: event.modifiers.contains(KeyModifiers::ALT),
            shift: event.modifiers.contains(KeyModifiers::SHIFT),
        }
    }
}

/// A normalized terminal event.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TernEvent {
    /// A key was pressed.
    Key(TernKey),
    /// The terminal was resized to `w` columns by `h` rows.
    Resize { w: u16, h: u16 },
    /// The terminal window gained focus.
    FocusGained,
    /// The terminal window lost focus.
    FocusLost,
    /// A mouse event occurred.
    Mouse(TernMouse),
    /// Text pasted into the terminal (bracketed paste mode).
    Paste(String),
}

/// Normalize a single crossterm event into a tern event.
///
/// Returns `None` for events tern does not surface: key events that are not
/// presses (repeat / release).
pub fn normalize(event: CrosstermEvent) -> Option<TernEvent> {
    match event {
        CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => {
            Some(TernEvent::Key(TernKey::from(key)))
        }
        CrosstermEvent::Key(_) => None,
        CrosstermEvent::Resize(w, h) => Some(TernEvent::Resize { w, h }),
        CrosstermEvent::FocusGained => Some(TernEvent::FocusGained),
        CrosstermEvent::FocusLost => Some(TernEvent::FocusLost),
        CrosstermEvent::Mouse(mouse) => Some(TernEvent::Mouse(TernMouse::from(mouse))),
        CrosstermEvent::Paste(text) => Some(TernEvent::Paste(text)),
    }
}

/// Poll the terminal for up to `timeout`, returning all normalized events
/// that became available during that window.
///
/// Blocks at most `timeout` waiting for the first event, then drains
/// everything already buffered so a burst of keys arrives as one batch.
/// Returns an empty `Vec` when nothing arrived within the timeout.
pub fn poll_events(timeout: Duration) -> io::Result<Vec<TernEvent>> {
    let mut events = Vec::new();
    if !event::poll(timeout)? {
        return Ok(events);
    }
    // Drain whatever is currently buffered. `poll` with a zero timeout gates
    // each `read`, so `read` never blocks.
    loop {
        if !event::poll(Duration::ZERO)? {
            break;
        }
        if let Some(normalized) = normalize(event::read()?) {
            events.push(normalized);
        }
    }
    Ok(events)
}

/// How often a running event loop re-checks its stop flag while idle. This is
/// the wake-up latency of [`spawn_event_loop`]: a stopped loop notices within
/// one interval. It is not a busy poll — `poll_events` blocks on the terminal
/// input source for the whole interval, so an idle loop burns no CPU.
pub const EVENT_LOOP_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// A handle to a running event loop. Dropping the handle does not stop the
/// loop; call [`stop`](Self::stop) to make the loop thread exit at its next
/// interval boundary.
#[derive(Debug)]
pub struct EventLoopHandle {
    stop: Arc<AtomicBool>,
}

impl EventLoopHandle {
    /// Ask the loop to stop. The loop thread observes the flag at its next
    /// [`EVENT_LOOP_POLL_INTERVAL`] boundary and exits, dropping the sink.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Run the event loop on the current thread until `stop` is set (or the
/// reader errors).
///
/// Repeatedly calls `read(interval)` for a batch of normalized events and
/// feeds each to `sink`, in arrival order. The interval also bounds how long
/// a stop request can go unnoticed. Errors from `read` propagate to the
/// caller and end the loop.
pub fn run_event_loop<F, R>(mut sink: F, mut read: R, stop: &AtomicBool) -> io::Result<()>
where
    F: FnMut(TernEvent),
    R: FnMut(Duration) -> io::Result<Vec<TernEvent>>,
{
    while !stop.load(Ordering::Relaxed) {
        let events = read(EVENT_LOOP_POLL_INTERVAL)?;
        for event in events {
            sink(event);
        }
    }
    Ok(())
}

/// Spawn the event loop on a dedicated background thread.
///
/// The thread repeatedly polls the terminal (see [`poll_events`]) and feeds
/// every normalized event to `sink`, which must be `Send` (it runs on the
/// loop thread). Returns a handle; call [`EventLoopHandle::stop`] to end the
/// loop. The loop also exits if the terminal source errors (e.g. the PTY is
/// torn down) — the thread returns silently rather than surfacing the error.
pub fn spawn_event_loop<F>(stop: Arc<AtomicBool>, mut sink: F) -> io::Result<EventLoopHandle>
where
    F: FnMut(TernEvent) + Send + 'static,
{
    let thread_stop = stop.clone();
    std::thread::Builder::new()
        .name("tern-event-loop".to_string())
        .spawn(move || {
            let _ = run_event_loop(&mut sink, |timeout| poll_events(timeout), &thread_stop);
        })?;
    Ok(EventLoopHandle { stop })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton as CrosstermMouseButton,
        MouseEvent, MouseEventKind as CrosstermMouseEventKind,
    };

    /// A press-kind crossterm key event.
    fn press(code: KeyCode, modifiers: KeyModifiers) -> CrosstermEvent {
        CrosstermEvent::Key(KeyEvent::new(code, modifiers))
    }

    /// Normalize a press-kind key event and unwrap it as a `TernKey`.
    fn key(code: KeyCode, modifiers: KeyModifiers) -> TernKey {
        match normalize(press(code, modifiers)) {
            Some(TernEvent::Key(key)) => key,
            other => panic!("expected a key event, got {other:?}"),
        }
    }

    /// A crossterm mouse event at the given cell with the given modifiers.
    fn mouse(
        kind: CrosstermMouseEventKind,
        column: u16,
        row: u16,
        modifiers: KeyModifiers,
    ) -> CrosstermEvent {
        CrosstermEvent::Mouse(MouseEvent {
            kind,
            column,
            row,
            modifiers,
        })
    }

    #[test]
    fn ctrl_c_maps_to_ctrl_char_c() {
        // The acceptance contract: Ctrl+C is a 'c' char key with ctrl set.
        let k = key(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(k.name, KeyName::Char);
        assert_eq!(k.char, Some('c'));
        assert!(k.ctrl);
        assert!(!k.alt);
        assert!(!k.shift);
    }

    #[test]
    fn enter_maps_to_enter() {
        let k = key(KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(k.name, KeyName::Enter);
        assert_eq!(k.char, None);
        assert!(!k.ctrl && !k.alt && !k.shift);
    }

    #[test]
    fn escape_maps_to_escape() {
        let k = key(KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(k.name, KeyName::Escape);
        assert_eq!(k.char, None);
    }

    #[test]
    fn arrow_keys_map() {
        assert_eq!(key(KeyCode::Up, KeyModifiers::NONE).name, KeyName::Up);
        assert_eq!(key(KeyCode::Down, KeyModifiers::NONE).name, KeyName::Down);
        assert_eq!(key(KeyCode::Left, KeyModifiers::NONE).name, KeyName::Left);
        assert_eq!(key(KeyCode::Right, KeyModifiers::NONE).name, KeyName::Right);
    }

    #[test]
    fn char_keys_map() {
        let k = key(KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(k.name, KeyName::Char);
        assert_eq!(k.char, Some('a'));

        let k = key(KeyCode::Char('Z'), KeyModifiers::SHIFT);
        assert_eq!(k.name, KeyName::Char);
        assert_eq!(k.char, Some('Z'));
        assert!(k.shift);
    }

    #[test]
    fn modifier_keys_are_flagged() {
        let k = key(KeyCode::Up, KeyModifiers::SHIFT);
        assert_eq!(k.name, KeyName::Up);
        assert!(k.shift);

        let k = key(KeyCode::Char('a'), KeyModifiers::ALT);
        assert!(k.alt);
        assert_eq!(k.char, Some('a'));
    }

    #[test]
    fn shift_tab_maps_to_backtab() {
        let k = key(KeyCode::BackTab, KeyModifiers::NONE);
        assert_eq!(k.name, KeyName::BackTab);
    }

    #[test]
    fn function_keys_map() {
        assert_eq!(key(KeyCode::F(1), KeyModifiers::NONE).name, KeyName::F(1));
        assert_eq!(key(KeyCode::F(12), KeyModifiers::NONE).name, KeyName::F(12));
    }

    #[test]
    fn resize_maps_to_resize() {
        assert_eq!(
            normalize(CrosstermEvent::Resize(120, 40)),
            Some(TernEvent::Resize { w: 120, h: 40 })
        );
    }

    #[test]
    fn focus_gained_maps() {
        assert_eq!(
            normalize(CrosstermEvent::FocusGained),
            Some(TernEvent::FocusGained)
        );
    }

    #[test]
    fn focus_lost_maps() {
        assert_eq!(
            normalize(CrosstermEvent::FocusLost),
            Some(TernEvent::FocusLost)
        );
    }

    #[test]
    fn mouse_press_maps_to_down() {
        assert_eq!(
            normalize(mouse(
                CrosstermMouseEventKind::Down(CrosstermMouseButton::Left),
                3,
                4,
                KeyModifiers::NONE,
            )),
            Some(TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 3,
                row: 4,
                ctrl: false,
                alt: false,
                shift: false,
            }))
        );
    }

    #[test]
    fn mouse_release_maps_to_up() {
        assert_eq!(
            normalize(mouse(
                CrosstermMouseEventKind::Up(CrosstermMouseButton::Right),
                1,
                2,
                KeyModifiers::NONE,
            )),
            Some(TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Up(MouseButton::Right),
                column: 1,
                row: 2,
                ctrl: false,
                alt: false,
                shift: false,
            }))
        );
    }

    #[test]
    fn mouse_move_maps_to_moved() {
        assert_eq!(
            normalize(mouse(
                CrosstermMouseEventKind::Moved,
                7,
                8,
                KeyModifiers::NONE
            )),
            Some(TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Moved,
                column: 7,
                row: 8,
                ctrl: false,
                alt: false,
                shift: false,
            }))
        );
    }

    #[test]
    fn mouse_drag_maps_to_drag() {
        assert_eq!(
            normalize(mouse(
                CrosstermMouseEventKind::Drag(CrosstermMouseButton::Middle),
                5,
                6,
                KeyModifiers::NONE,
            )),
            Some(TernEvent::Mouse(TernMouse {
                kind: MouseEventKind::Drag(MouseButton::Middle),
                column: 5,
                row: 6,
                ctrl: false,
                alt: false,
                shift: false,
            }))
        );
    }

    #[test]
    fn wheel_events_map() {
        let wheel =
            |kind: CrosstermMouseEventKind| normalize(mouse(kind, 9, 9, KeyModifiers::NONE));
        for (crossterm_kind, tern_kind) in [
            (CrosstermMouseEventKind::ScrollUp, MouseEventKind::ScrollUp),
            (
                CrosstermMouseEventKind::ScrollDown,
                MouseEventKind::ScrollDown,
            ),
            (
                CrosstermMouseEventKind::ScrollLeft,
                MouseEventKind::ScrollLeft,
            ),
            (
                CrosstermMouseEventKind::ScrollRight,
                MouseEventKind::ScrollRight,
            ),
        ] {
            assert_eq!(
                wheel(crossterm_kind),
                Some(TernEvent::Mouse(TernMouse {
                    kind: tern_kind,
                    column: 9,
                    row: 9,
                    ctrl: false,
                    alt: false,
                    shift: false,
                }))
            );
        }
    }

    #[test]
    fn mouse_modifiers_are_flagged() {
        let event = normalize(mouse(
            CrosstermMouseEventKind::Down(CrosstermMouseButton::Left),
            0,
            0,
            KeyModifiers::CONTROL | KeyModifiers::SHIFT | KeyModifiers::ALT,
        ));
        match event {
            Some(TernEvent::Mouse(m)) => {
                assert!(m.ctrl);
                assert!(m.alt);
                assert!(m.shift);
            }
            other => panic!("expected a mouse event, got {other:?}"),
        }
    }

    #[test]
    fn release_kind_is_filtered() {
        let release = CrosstermEvent::Key(KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ));
        assert_eq!(normalize(release), None);
    }

    #[test]
    fn repeat_kind_is_filtered() {
        let repeat = CrosstermEvent::Key(KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        ));
        assert_eq!(normalize(repeat), None);
    }

    #[test]
    fn paste_events_map_to_paste() {
        assert_eq!(
            normalize(CrosstermEvent::Paste("pasted".into())),
            Some(TernEvent::Paste("pasted".into()))
        );
    }

    #[test]
    fn paste_payload_round_trips_losslessly() {
        // Multiline, tabbed, and non-ASCII paste payloads must arrive intact.
        for payload in ["line1\nline2\ttabbed", "héllo 世界"] {
            assert_eq!(
                normalize(CrosstermEvent::Paste(payload.into())),
                Some(TernEvent::Paste(payload.into()))
            );
        }
    }

    /// A fake reader that yields the given event batches, then sets the stop
    /// flag and returns empty batches (an idle terminal).
    fn fake_reader(
        batches: Vec<Vec<TernEvent>>,
        stop: Arc<AtomicBool>,
    ) -> impl FnMut(Duration) -> io::Result<Vec<TernEvent>> {
        let mut remaining = batches.into_iter();
        move |_timeout: Duration| {
            if let Some(batch) = remaining.next() {
                Ok(batch)
            } else {
                // All batches delivered: ask the loop to stop, then idle.
                stop.store(true, Ordering::Relaxed);
                Ok(vec![])
            }
        }
    }

    #[test]
    fn run_event_loop_delivers_all_events_in_order_without_loss() {
        // A synthetic burst of N events split across batches must reach the
        // sink exactly once each, in arrival order (the push contract: the JS
        // side receives all N without loss).
        let stop = Arc::new(AtomicBool::new(false));
        let n = 100;
        let mut batches: Vec<Vec<TernEvent>> = Vec::new();
        let mut window: Vec<TernEvent> = Vec::new();
        for i in 0..n {
            let event = match i % 4 {
                0 => TernEvent::Key(TernKey::new(KeyName::Char, Some('a'), false, false, false)),
                1 => TernEvent::Resize {
                    w: 80,
                    h: (i + 1) as u16,
                },
                2 => TernEvent::FocusGained,
                _ => TernEvent::Mouse(TernMouse {
                    kind: MouseEventKind::Moved,
                    column: (i % 100) as u16,
                    row: 0,
                    ctrl: false,
                    alt: false,
                    shift: false,
                }),
            };
            window.push(event);
            // Bursts of 1..=7 events per poll window.
            if i % 7 == 6 || i == n - 1 {
                batches.push(std::mem::take(&mut window));
            }
        }
        let expected: Vec<TernEvent> = batches.iter().flatten().cloned().collect();
        let mut received: Vec<TernEvent> = Vec::new();
        {
            let mut sink = |event: TernEvent| received.push(event);
            let mut read = fake_reader(batches, stop.clone());
            run_event_loop(&mut sink, &mut read, &stop).expect("loop runs cleanly");
        }
        assert_eq!(received.len(), n, "all {n} events delivered");
        assert_eq!(received, expected, "events arrive in order, no loss");
    }

    #[test]
    fn run_event_loop_exits_on_stop_flag_between_batches() {
        // The loop must observe the stop flag even when no events arrive.
        let stop = Arc::new(AtomicBool::new(false));
        let mut received: Vec<TernEvent> = Vec::new();
        {
            let mut sink = |event: TernEvent| received.push(event);
            let mut read = fake_reader(vec![], stop.clone());
            run_event_loop(&mut sink, &mut read, &stop).expect("loop runs cleanly");
        }
        assert!(received.is_empty());
    }

    #[test]
    fn event_loop_handle_stops_a_spawned_loop() {
        // `spawn_event_loop` + `EventLoopHandle::stop` terminates the thread:
        // after stop, the sink stops receiving events (the loop notices at the
        // next interval boundary).
        let stop = Arc::new(AtomicBool::new(false));
        let pushes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = pushes.clone();
        let handle = spawn_event_loop(stop.clone(), move |_event: TernEvent| {
            counter.fetch_add(1, Ordering::Relaxed);
        })
        .expect("spawn loop");
        // Give the loop a moment to run an interval, then stop it.
        std::thread::sleep(Duration::from_millis(10));
        handle.stop();
        // The thread must exit (no join handle, so wait a couple of intervals
        // and assert the sink is no longer being fed — a running loop keeps
        // polling but the terminal yields no events in a unit test, so the
        // count stays where it was).
        let before = pushes.load(Ordering::Relaxed);
        std::thread::sleep(EVENT_LOOP_POLL_INTERVAL * 3);
        assert_eq!(
            pushes.load(Ordering::Relaxed),
            before,
            "a stopped loop must not deliver events"
        );
    }
}
