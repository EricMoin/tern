use super::*;

#[cfg(feature = "push-events")]
#[test]
fn push_event_batch_delivers_all_synthetic_events_without_loss() {
    // The push path's batch converter: N synthetic events in, N JS events
    // out, in order, each mapping to the right tagged union shape.
    let n = 40;
    let events: Vec<TernEvent> = (0..n).map(synthetic_event).collect();
    let mut delivered: Vec<TernEventJs> = Vec::new();
    let teardown = push_event_batch(&events, false, &mut |js| delivered.push(js));
    assert!(!teardown, "no ctrl+c in the batch");
    assert_eq!(delivered.len(), n, "all {n} events delivered, none lost");
    for (i, (event, js)) in events.iter().zip(&delivered).enumerate() {
        match event {
            TernEvent::Key(_key) => {
                assert_eq!(js.r#type, "key", "event {i} tagged key");
                let js_key = js.key.as_ref().expect("key payload present");
                assert_eq!(js_key.name, "char");
                assert_eq!(js_key.char.as_deref(), Some("a"));
            }
            TernEvent::Resize { w, h } => {
                assert_eq!(js.r#type, "resize", "event {i} tagged resize");
                assert_eq!(js.width, Some(*w));
                assert_eq!(js.height, Some(*h));
            }
            TernEvent::FocusGained => {
                assert_eq!(js.r#type, "focus", "event {i} tagged focus");
                assert_eq!(js.focus_gained, Some(true));
            }
            TernEvent::FocusLost => unreachable!("synthetic events never focus-lost"),
            TernEvent::Mouse(_) => {
                assert_eq!(js.r#type, "mouse", "event {i} tagged mouse");
                assert_eq!(
                    js.mouse.as_ref().expect("mouse payload present").kind,
                    "moved"
                );
            }
            TernEvent::Paste(text) => {
                assert_eq!(js.r#type, "paste", "event {i} tagged paste");
                assert_eq!(
                    js.paste.as_deref(),
                    Some(text.as_str()),
                    "event {i} payload"
                );
            }
        }
    }
}

#[cfg(feature = "push-events")]
#[test]
fn push_event_batch_flags_ctrl_c_teardown_and_still_delivers() {
    // Ctrl+C with exit_on_ctrl_c: the batch reports a teardown (the caller
    // restores the terminal and stops the loop) and the press is still
    // delivered so push-mode consumers observe it.
    let events = vec![
        TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false)),
        TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), false, false, false)),
    ];
    let mut delivered: Vec<TernEventJs> = Vec::new();
    let teardown = push_event_batch(&events, true, &mut |js| delivered.push(js));
    assert!(teardown, "ctrl+c with exit_on_ctrl_c must request teardown");
    assert_eq!(delivered.len(), 2, "both events still delivered");
    assert_eq!(delivered[0].r#type, "key");
    assert_eq!(
        delivered[0].key.as_ref().expect("key").char.as_deref(),
        Some("c")
    );
}

#[test]
fn is_ctrl_c_matches_ctrl_char_c_only() {
    let ctrl_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), true, false, false));
    assert!(is_ctrl_c(&ctrl_c));
    // Not ctrl: a plain 'c'.
    let plain_c = TernEvent::Key(TernKey::new(KeyName::Char, Some('c'), false, false, false));
    assert!(!is_ctrl_c(&plain_c));
    // Ctrl but not 'c'.
    let ctrl_q = TernEvent::Key(TernKey::new(KeyName::Char, Some('q'), true, false, false));
    assert!(!is_ctrl_c(&ctrl_q));
    // Non-key events are never ctrl+c.
    assert!(!is_ctrl_c(&TernEvent::Resize { w: 80, h: 24 }));
    assert!(!is_ctrl_c(&TernEvent::FocusGained));
}
