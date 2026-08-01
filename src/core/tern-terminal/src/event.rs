//! Event normalization: crossterm input events → tern's [`TernEvent`] enum.
//!
//! Only [`KeyEventKind::Press`] key events are surfaced; repeat and release
//! key events are dropped, as are mouse, paste, and focus-gained events
//! (out of scope for the MVP). [`poll_events`] waits up to a caller-supplied
//! timeout for the first event, then drains everything currently buffered
//! into a batch.

use std::io;
use std::time::Duration;

use crossterm::event::{
    self, Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TernEvent {
    /// A key was pressed.
    Key(TernKey),
    /// The terminal was resized to `w` columns by `h` rows.
    Resize { w: u16, h: u16 },
    /// The terminal window lost focus.
    FocusLost,
}

/// Normalize a single crossterm event into a tern event.
///
/// Returns `None` for events tern does not surface: key events that are not
/// presses (repeat / release), mouse events, paste events, and focus-gained.
pub fn normalize(event: CrosstermEvent) -> Option<TernEvent> {
    match event {
        CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => {
            Some(TernEvent::Key(TernKey::from(key)))
        }
        CrosstermEvent::Key(_) => None,
        CrosstermEvent::Resize(w, h) => Some(TernEvent::Resize { w, h }),
        CrosstermEvent::FocusLost => Some(TernEvent::FocusLost),
        _ => None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

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
    fn focus_lost_maps() {
        assert_eq!(
            normalize(CrosstermEvent::FocusLost),
            Some(TernEvent::FocusLost)
        );
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
    fn unhandled_events_map_to_none() {
        // Focus gained and mouse events are out of scope for the MVP.
        assert_eq!(normalize(CrosstermEvent::FocusGained), None);
        let mouse = CrosstermEvent::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(normalize(mouse), None);
    }
}
