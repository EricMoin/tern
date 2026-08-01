//! tern-demo — example binary driving the tern TUI renderer.
//!
//! Builds a scene tree (a flex-column [`Box`] with a rounded border and
//! 1-cell padding holding two [`Text`] lines), enters raw mode through
//! [`tern_terminal`], and runs an event loop on the alternate screen:
//! every frame is painted by the [`Compositor`], diffed against the previous
//! frame, and flushed through the [`Backend`]. Pressing `q` (or Ctrl+C)
//! quits; a terminal resize clears the stale frame and repaints.

use std::io;
use std::time::Duration;

use tern_components::{Box, Compositor, Text};
use tern_core::{BorderStyle, Buffer, Size, Style};
use tern_terminal::{poll_events, Backend, TernEvent};

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

/// The event loop: paint the scene, flush the frame diff, and wait for input.
/// Returns `Ok(())` when the user quits with `q` (or Ctrl+C).
fn run(backend: &Backend) -> io::Result<()> {
    let mut compositor = Compositor::new();
    let mut previous: Option<Buffer> = None;
    let mut full_redraw = true;

    loop {
        if full_redraw {
            backend.clear()?;
        }
        let (w, h) = backend.size()?;
        let buffer = compositor.paint(build_scene(), Size::new(w, h));
        // Diff against the previous frame. On the first frame — or after a
        // resize, when the screen was cleared — diff against a blank buffer
        // so every painted cell is emitted.
        let updates = match &previous {
            Some(prev) if !full_redraw => buffer.diff_from(prev),
            _ => buffer.diff_from(&Buffer::new(w, h)),
        };
        backend.flush_diff(&updates, (0, 0))?;
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
                // A resize clears the stale frame and repaints fully.
                TernEvent::Resize { .. } => {
                    full_redraw = true;
                }
                _ => {}
            }
        }
    }
}
