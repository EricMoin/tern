//! tern-demo — example binary driving the tern TUI renderer.
//!
//! Builds a scene tree (a flex-column [`Box`] with a rounded border and
//! 1-cell padding holding two [`Text`] lines), enters raw mode through
//! [`tern_terminal`], and runs an event loop on the alternate screen:
//! every frame is painted by the [`Compositor`], diffed against the previous
//! frame, and flushed through the [`Backend`]. The demo also tracks a caret:
//! a blinking reversed-video block painted into the frame (via
//! [`Buffer::render_caret`](tern_core::Buffer::render_caret)) whose position
//! is emitted to the terminal on every flush, so the hardware caret follows
//! it. Pressing `q` (or Ctrl+C) quits; the arrow keys move the caret, `h`
//! hides it, `s` shows it again; a terminal resize clears the stale frame and
//! repaints.

use std::io;
use std::time::Duration;

use tern_components::{Box, Compositor, Text};
use tern_core::{BorderStyle, Buffer, Cursor, Modifiers, Size, Style};
use tern_terminal::{poll_events, Backend, KeyName, TernEvent};

fn main() -> io::Result<()> {
    let backend = Backend::new();
    backend.enter_raw_mode()?;
    backend.enter_alt_screen()?;
    backend.hide_cursor()?;

    let result = run(&backend);

    // Restore the terminal no matter how the event loop ended.
    let _ = backend.show_cursor();
    let _ = backend.exit_alt_screen();
    let _ = backend.exit_raw_mode();
    result
}

/// Build the demo scene tree: a flex-column box with a rounded border and
/// 1-cell padding, holding two text lines.
fn build_scene() -> Box {
    Box::new(
        Style::new().border_style(BorderStyle::Rounded),
        vec![
            Text::new("tern TUI demo", Style::new()).bold().into(),
            Text::new("press q to quit", Style::new()).dim().into(),
        ],
    )
    .column()
    .border(1)
    .padding(1)
    .gap(1)
}

/// The event loop: paint the scene, render the caret, flush the frame diff
/// (parking the terminal caret), and wait for input. Returns `Ok(())` when
/// the user quits with `q` (or Ctrl+C).
fn run(backend: &Backend) -> io::Result<()> {
    let mut compositor = Compositor::new();
    let mut previous: Option<Buffer> = None;
    let mut full_redraw = true;
    // The demo caret: a blinking reversed-video block, starting at the box
    // content origin (border 1 + padding 1) on the title line.
    let mut caret = Cursor::new(2, 2).styled(
        Style::new()
            .add_modifier(Modifiers::REVERSED)
            .add_modifier(Modifiers::BLINK),
    );

    loop {
        if full_redraw {
            backend.clear()?;
        }
        let (w, h) = backend.size()?;
        // Keep the caret inside the buffer, also after a resize.
        caret.x = caret.x.min(w.saturating_sub(1));
        caret.y = caret.y.min(h.saturating_sub(1));
        let mut buffer = compositor.paint(build_scene(), Size::new(w, h));
        // Paint the styled block caret into the frame so the diff carries it.
        buffer.render_caret(caret.clone());
        // Diff against the previous frame. On the first frame — or after a
        // resize, when the screen was cleared — diff against a blank buffer
        // so every painted cell is emitted.
        let updates = match &previous {
            Some(prev) if !full_redraw => buffer.diff_from(prev),
            _ => buffer.diff_from(&Buffer::new(w, h)),
        };
        // Flush the frame, then park and show/hide the terminal caret.
        backend.flush_diff_with_cursor(&updates, caret.clone())?;
        previous = Some(buffer);
        full_redraw = false;

        for event in poll_events(Duration::from_millis(100))? {
            match event {
                // Quit on 'q'. Ctrl+C also quits: raw mode disables SIGINT,
                // so the key event is the only way out.
                TernEvent::Key(key)
                    if (key.char == Some('q')) || (key.ctrl && key.char == Some('c')) =>
                {
                    return Ok(());
                }
                // 'h' hides the caret, 's' shows it again.
                TernEvent::Key(key) if key.char == Some('h') => caret = caret.hide(),
                TernEvent::Key(key) if key.char == Some('s') => caret = caret.show(),
                // Arrow keys move the caret, clamped to the buffer.
                TernEvent::Key(key) if key.name == KeyName::Up => {
                    let x = caret.x;
                    let y = caret.y.saturating_sub(1);
                    caret = caret.at(x, y);
                }
                TernEvent::Key(key) if key.name == KeyName::Down => {
                    let x = caret.x;
                    let y = caret.y.saturating_add(1).min(h.saturating_sub(1));
                    caret = caret.at(x, y);
                }
                TernEvent::Key(key) if key.name == KeyName::Left => {
                    let x = caret.x.saturating_sub(1);
                    let y = caret.y;
                    caret = caret.at(x, y);
                }
                TernEvent::Key(key) if key.name == KeyName::Right => {
                    let x = caret.x.saturating_add(1).min(w.saturating_sub(1));
                    let y = caret.y;
                    caret = caret.at(x, y);
                }
                // A resize clears the stale frame and repaints fully.
                TernEvent::Resize { .. } => {
                    full_redraw = true;
                }
                _ => {}
            }
        }
    }
}
