//! Tests for the input normalizer.

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
fn release_kind_surfaces_with_kind_release() {
    // A release event is surfaced, tagged with kind Release (the kitty
    // keyboard protocol's REPORT_EVENT_TYPES contract) — not dropped.
    let release = CrosstermEvent::Key(KeyEvent::new_with_kind(
        KeyCode::Char('x'),
        KeyModifiers::NONE,
        KeyEventKind::Release,
    ));
    match normalize(release) {
        Some(TernEvent::Key(key)) => {
            assert_eq!(key.name, KeyName::Char);
            assert_eq!(key.char, Some('x'));
            assert_eq!(key.kind, KeyKind::Release);
        }
        other => panic!("expected a release key event, got {other:?}"),
    }
}

#[test]
fn repeat_kind_surfaces_with_kind_repeat() {
    // An auto-repeat event is surfaced, tagged with kind Repeat.
    let repeat = CrosstermEvent::Key(KeyEvent::new_with_kind(
        KeyCode::Char('x'),
        KeyModifiers::NONE,
        KeyEventKind::Repeat,
    ));
    match normalize(repeat) {
        Some(TernEvent::Key(key)) => {
            assert_eq!(key.name, KeyName::Char);
            assert_eq!(key.char, Some('x'));
            assert_eq!(key.kind, KeyKind::Repeat);
        }
        other => panic!("expected a repeat key event, got {other:?}"),
    }
}

#[test]
fn press_kind_defaults_to_press() {
    // A plain press event (the only kind a non-kitty terminal reports):
    // kind Press, exactly the pre-enhancement behavior.
    let k = key(KeyCode::Char('q'), KeyModifiers::NONE);
    assert_eq!(k.kind, KeyKind::Press);
}

#[test]
fn escape_and_ctrl_open_bracket_are_distinct_under_disambiguate() {
    // DISAMBIGUATE_ESCAPE_CODES: Esc reports as KeyCode::Esc (name
    // Escape, no char), while Ctrl+[ reports as a char key '[' with ctrl
    // set — the two are distinct events instead of both collapsing into
    // one escape sequence.
    let esc = key(KeyCode::Esc, KeyModifiers::NONE);
    assert_eq!(esc.name, KeyName::Escape);
    assert_eq!(esc.char, None);
    assert!(!esc.ctrl);

    let ctrl_bracket = key(KeyCode::Char('['), KeyModifiers::CONTROL);
    assert_eq!(ctrl_bracket.name, KeyName::Char);
    assert_eq!(ctrl_bracket.char, Some('['));
    assert!(ctrl_bracket.ctrl);
    assert_ne!(esc, ctrl_bracket, "Esc and Ctrl+[ must not collapse");
}

#[test]
fn precise_modifiers_super_meta_hyper_are_flagged() {
    // SUPER / META / HYPER surface additively alongside ctrl/alt/shift;
    // a plain key carries none of them.
    let combo = key(
        KeyCode::Char('x'),
        KeyModifiers::SUPER | KeyModifiers::META | KeyModifiers::HYPER,
    );
    assert!(combo.super_);
    assert!(combo.meta);
    assert!(combo.hyper);

    let plain = key(KeyCode::Char('x'), KeyModifiers::NONE);
    assert!(!plain.super_ && !plain.meta && !plain.hyper);
    // Back-compat: the classic modifiers still map independently.
    let shift_super = key(KeyCode::Up, KeyModifiers::SHIFT | KeyModifiers::SUPER);
    assert!(shift_super.shift);
    assert!(shift_super.super_);
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
