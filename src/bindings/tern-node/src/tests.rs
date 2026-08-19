use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tern_core::color::Color as _Color;

mod conversion;
mod node_ops;
mod render;
mod events;
mod lifecycle;
mod selection;

/// A root handle materialized over a fresh scene, for handle tests.
fn root_handle(scene: &Arc<Mutex<Scene>>) -> NodeHandle {
    let root_id = scene.lock().expect("scene poisoned").root_id();
    NodeHandle::materialized(
        scene.clone(),
        root_id,
        NodeKind::Root,
        Style::new(),
        PropMap::new(),
    )
}

/// A run carrying no style keys — `{ text }`.
fn plain_run(text: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: None,
        bg: None,
        hyperlink: None,
        underline_style: None,
        underline_color: None,
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// A run carrying `fg: "#ff0000"` and `bold` — the style keys the styled
/// golden text uses.
fn bold_red_run(text: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: Some("#ff0000".to_string()),
        bg: None,
        hyperlink: None,
        underline_style: None,
        underline_color: None,
        bold: Some(true),
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// A run carrying `fg: "#ff0000"` — the border color the styled border
/// golden paints its border cells with.
fn red_border_run(text: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: Some("#ff0000".to_string()),
        bg: None,
        hyperlink: None,
        underline_style: None,
        underline_color: None,
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// A run carrying `hyperlink: "https://example.com"` — the link target the
/// linked golden text's cells paint as an OSC 8 hyperlink.
fn linked_run(text: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: None,
        bg: None,
        hyperlink: Some("https://example.com".to_string()),
        underline_style: None,
        underline_color: None,
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// A run carrying the given underline style keyword (`"double"`, `"curly"`,
/// `"dotted"`, ...) — the style key the underline golden text's cells paint.
fn underline_run(text: &str, underline_style: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: None,
        bg: None,
        hyperlink: None,
        underline_style: Some(underline_style.to_string()),
        underline_color: None,
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// A run carrying an underline color `"#rrggbb"` — the colored-underline
/// golden text's cells paint their underline with.
fn underline_color_run(text: &str, underline_color: &str) -> StyleRunJs {
    StyleRunJs {
        text: text.to_string(),
        fg: None,
        bg: None,
        hyperlink: None,
        underline_style: None,
        underline_color: Some(underline_color.to_string()),
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        reversed: None,
        strikethrough: None,
    }
}

/// The scene id of an attached handle.
fn attached_id(handle: &NodeHandle) -> NodeId {
    handle
        .inner
        .lock()
        .expect("node inner poisoned")
        .id
        .expect("handle is attached")
}

/// The ordered scene ids of `parent`'s children.
fn child_ids(scene: &Arc<Mutex<Scene>>, parent: &NodeHandle) -> Vec<NodeId> {
    let parent_id = attached_id(parent);
    let s = scene.lock().expect("scene poisoned");
    s.children(parent_id).expect("parent in scene").to_vec()
}

/// A detached `text` template for insertion tests.
fn text_template() -> NodeHandle {
    create_node("text".to_string(), None).expect("create text template")
}

/// A synthetic tern event of the given index, cycling the event kinds so
/// every payload shape is exercised.
fn synthetic_event(i: usize) -> TernEvent {
    match i % 5 {
        0 => TernEvent::Key(TernKey::new(KeyName::Char, Some('a'), false, false, false)),
        1 => TernEvent::Resize {
            w: 80,
            h: (i + 1) as u16,
        },
        2 => TernEvent::FocusGained,
        3 => TernEvent::Mouse(TernMouse {
            kind: MouseEventKind::Moved,
            column: (i % 100) as u16,
            row: 0,
            ctrl: false,
            alt: false,
            shift: false,
        }),
        _ => TernEvent::Paste(format!("pasted-{i}")),
    }
}

/// A fresh headless renderer with default options (virtual 80x24),
/// constructed through the real [`TuiRenderer::new`] path so the tests
/// prove headless construction never touches a terminal.
fn headless_renderer() -> TuiRenderer {
    TuiRenderer::new(TuiRendererOptions {
        exit_on_ctrl_c: None,
        use_alt_screen: None,
        title: None,
        headless: Some(true),
        keyboard_enhancement: None,
        width: None,
        height: None,
    })
    .expect("headless renderer constructs without a terminal")
}

/// A backend that counts every terminal operation instead of performing
/// it, so tests can assert exactly which renders touched the terminal.
///
/// Counters are `Arc`-shared so the test keeps reading them after the
/// backend is moved into the renderer. `size()` reports a fixed 80x24
/// viewport, keeping the viewport cache stable across renders.
/// `set_clipboard` captures the text it received into `clipboard` (the
/// injected sink: the byte-level escape emission is covered by
/// tern-terminal's `set_clipboard_to` tests, this mock proves the
/// renderer forwards the text).
#[derive(Clone, Default)]
struct CountingBackend {
    size_calls: Arc<AtomicUsize>,
    flush_calls: Arc<AtomicUsize>,
    cursor_flush_calls: Arc<AtomicUsize>,
    clipboard: Arc<Mutex<Option<String>>>,
    /// The [`Cursor`] most recently passed to `flush_diff_with_cursor` (the
    /// cursor-aware flush), or `None` before one. Lets tests assert that
    /// `set_cursor` routes the render through the cursor-aware flush with the
    /// right cursor.
    flushed_cursor: Arc<Mutex<Option<Cursor>>>,
}

impl CountingBackend {
    /// Total terminal operations so far (size probes + flushes).
    fn ops(&self) -> usize {
        self.size_calls.load(Ordering::Relaxed)
            + self.flush_calls.load(Ordering::Relaxed)
            + self.cursor_flush_calls.load(Ordering::Relaxed)
    }

    /// The text most recently passed to `set_clipboard`, or `None`.
    fn clipboard(&self) -> Option<String> {
        self.clipboard.lock().expect("clipboard poisoned").clone()
    }

    /// The [`Cursor`] most recently passed to `flush_diff_with_cursor`, or
    /// `None` before one.
    fn flushed_cursor(&self) -> Option<Cursor> {
        self.flushed_cursor
            .lock()
            .expect("flushed cursor poisoned")
            .clone()
    }
}

impl RenderBackend for CountingBackend {
    fn size(&self) -> io::Result<(u16, u16)> {
        self.size_calls.fetch_add(1, Ordering::Relaxed);
        Ok((80, 24))
    }

    fn flush_diff(
        &mut self,
        updates: &[CellUpdate],
        _cursor_pos: (u16, u16),
    ) -> io::Result<usize> {
        self.flush_calls.fetch_add(1, Ordering::Relaxed);
        // Report a nominal byte count per flushed cell so the renderer's
        // `last_flush_bytes` counter is exercised; the tests only assert
        // on the call counters, never on this value.
        Ok(updates.len())
    }

    fn flush_diff_with_cursor(
        &mut self,
        updates: &[CellUpdate],
        cursor: Cursor,
    ) -> io::Result<usize> {
        self.cursor_flush_calls.fetch_add(1, Ordering::Relaxed);
        *self.flushed_cursor.lock().expect("flushed cursor poisoned") = Some(cursor);
        Ok(updates.len())
    }

    fn set_title(&self, _title: &str) -> io::Result<()> {
        Ok(())
    }

    fn set_clipboard(&self, text: &str) -> io::Result<()> {
        *self.clipboard.lock().expect("clipboard poisoned") = Some(text.to_string());
        Ok(())
    }

    fn disable_event_listening(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_keyboard_enhancement(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_alt_screen(&self) -> io::Result<()> {
        Ok(())
    }

    fn exit_raw_mode(&self) -> io::Result<()> {
        Ok(())
    }
}

/// A renderer wired to a [`CountingBackend`] over a scene with one Text
/// child, so the no-op fast path can be exercised end to end.
fn counting_renderer(backend: CountingBackend) -> (TuiRenderer, Arc<Mutex<Scene>>) {
    let scene = Arc::new(Mutex::new(Scene::new()));
    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.add_child(root, NodeKind::Text, Style::new())
            .expect("add text node");
    }
    let renderer = renderer_with_scene(backend, scene.clone());
    (renderer, scene)
}

/// A renderer wired to `backend` over `scene` (the caller owns the
/// scene's content).
fn renderer_with_scene(backend: CountingBackend, scene: Arc<Mutex<Scene>>) -> TuiRenderer {
    let inner = RendererInner {
        backend: Box::new(backend),
        compositor: Compositor::new(),
        scene,
        last: None,
        last_painted_epoch: 0,
        last_viewport: NO_VIEWPORT,
        last_painted_viewport: NO_VIEWPORT,
        selection: None,
        last_painted_selection: None,
        cursor: None,
        last_painted_cursor: None,
        cached_size: None,
        last_flush_bytes: 0,
        #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
        exit_on_ctrl_c: false,
        use_alt_screen: false,
        headless: false,
        keyboard_enhancement: false,
        destroyed: false,
        #[cfg(feature = "push-events")]
        event_loop: None,
    };
    TuiRenderer {
        inner: Arc::new(Mutex::new(inner)),
    }
}

/// A fresh scene holding one `Text` leaf sized `w` x `h` at the origin
/// with `text` content, for selection tests.
fn scene_with_text(text: &str, w: u32, h: u32) -> Arc<Mutex<Scene>> {
    let scene = Arc::new(Mutex::new(Scene::new()));
    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        let t = s
            .add_child(root, NodeKind::Text, Style::new())
            .expect("add text");
        s.set_prop(t, "text", PropValue::Str(text.into()));
        s.set_prop(t, "width", PropValue::Int(w as i64));
        s.set_prop(t, "height", PropValue::Int(h as i64));
    }
    scene
}

/// A fresh scene with two `Text` leaves stacked in a column at rows 0 and
/// 1, for multi-row selection tests.
fn two_row_scene() -> Arc<Mutex<Scene>> {
    let scene = Arc::new(Mutex::new(Scene::new()));
    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.set_prop(root, "flex_direction", PropValue::Str("column".into()));
        for text in ["hello", "world"] {
            let t = s
                .add_child(root, NodeKind::Text, Style::new())
                .expect("add text");
            s.set_prop(t, "text", PropValue::Str(text.into()));
            s.set_prop(t, "width", PropValue::Int(11));
            s.set_prop(t, "height", PropValue::Int(1));
        }
    }
    scene
}

/// Run `f` with the shared viewport pinned to the render-path default
/// (80x24), restoring it afterwards. `size`'s pre-paint seed writes the
/// shared viewport (a static shared across parallel test threads); the
/// probe always reports 80x24 here, so pinning it before and after keeps
/// the render-path tests that read the shared viewport from ever
/// observing a stale value.
fn with_render_viewport<T>(f: impl FnOnce() -> T) -> T {
    *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
    let result = f();
    *shared_viewport_ref().lock().expect("viewport poisoned") = (80, 24);
    result
}
