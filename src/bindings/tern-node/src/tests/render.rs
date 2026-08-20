use super::*;

#[test]
fn render_to_buffer_paints_known_scene_into_expected_rows() {
    // The canonical golden scene (mirrored by the JS fake-addon golden
    // test): a rounded-border box with 1-cell padding around Text('Hi'),
    // attached to the scene root, painted at a 6x3 viewport. The box
    // sizes to its content (2 text columns + 2 padding = 4 wide, 1 + 2
    // padding = 3 tall) at the origin, so the frame is
    //   ┌──┐
    //   │Hi│
    //   └──┘
    // with trailing blanks padded to the 6-column viewport width.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let box_id = scene
        .add_child(
            root,
            NodeKind::Box,
            Style::new().border_style(BorderStyle::Rounded),
        )
        .expect("add box");
    scene.set_prop(box_id, "padding", PropValue::Int(1));
    scene
        .add_text(box_id, "Hi", Style::new())
        .expect("add text");

    let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
    assert_eq!(rows, vec!["┌──┐  ", "│Hi│  ", "└──┘  "]);
}

#[test]
fn render_to_buffer_styled_snapshots_styled_scene_into_runs() {
    // The styled counterpart of the golden `render_to_buffer` scene: the
    // same rounded-border box, but the inner text is bold red. The frame
    // is still
    //   ┌──┐
    //   │Hi│
    //   └──┘
    // and the runs merge adjacent same-style cells: the border and the
    // trailing blanks share the default style, so row 0 and row 2 are
    // single runs, while row 1 splits into border / bold-red "Hi" /
    // border+blanks.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let box_id = scene
        .add_child(
            root,
            NodeKind::Box,
            Style::new().border_style(BorderStyle::Rounded),
        )
        .expect("add box");
    scene.set_prop(box_id, "padding", PropValue::Int(1));
    scene
        .add_text(
            box_id,
            "Hi",
            Style::new()
                .fg(_Color::Rgb(255, 0, 0))
                .add_modifier(Modifiers::BOLD),
        )
        .expect("add styled text");

    let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
    assert_eq!(
        runs,
        vec![
            vec![plain_run("┌──┐  ")],
            vec![plain_run("│"), bold_red_run("Hi"), plain_run("│  ")],
            vec![plain_run("└──┘  ")],
        ]
    );
}

#[test]
fn render_to_buffer_styled_border_color_paints_border_runs_in_color() {
    // A box with a `border_color` paints its border glyphs with that color
    // as their foreground, so the styled snapshot reports it through the
    // border runs' `fg`: the colored border splits from the default-styled
    // blanks into its own `fg: "#ff0000"` run per row, while the glyphs
    // and the inner text stay unchanged.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let box_id = scene
        .add_child(
            root,
            NodeKind::Box,
            Style::new()
                .border_style(BorderStyle::Rounded)
                .border_color(_Color::Rgb(255, 0, 0)),
        )
        .expect("add box");
    scene.set_prop(box_id, "padding", PropValue::Int(1));
    scene
        .add_text(box_id, "Hi", Style::new())
        .expect("add text");

    let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
    assert_eq!(
        runs,
        vec![
            vec![red_border_run("┌──┐"), plain_run("  ")],
            vec![
                red_border_run("│"),
                plain_run("Hi"),
                red_border_run("│"),
                plain_run("  "),
            ],
            vec![red_border_run("└──┘"), plain_run("  ")],
        ]
    );
}

#[test]
fn render_to_buffer_styled_surfaces_hyperlink_on_linked_run() {
    // A run whose cells carry a hyperlink reports the link target as
    // `hyperlink` — the value the engine threads from the `href` style key
    // into `Style::hyperlink`. The golden scene with the inner text styled
    // `.hyperlink(Some("https://example.com"))` surfaces the link on the
    // "Hi" run while every other key stays absent; because the hyperlink
    // participates in style equality, the linked run splits from the
    // default-styled border and trailing blanks exactly like a colored or
    // bold run does.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let box_id = scene
        .add_child(
            root,
            NodeKind::Box,
            Style::new().border_style(BorderStyle::Rounded),
        )
        .expect("add box");
    scene.set_prop(box_id, "padding", PropValue::Int(1));
    scene
        .add_text(
            box_id,
            "Hi",
            Style::new().hyperlink(Some("https://example.com".into())),
        )
        .expect("add linked text");

    let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
    assert_eq!(
        runs,
        vec![
            vec![plain_run("┌──┐  ")],
            vec![plain_run("│"), linked_run("Hi"), plain_run("│  ")],
            vec![plain_run("└──┘  ")],
        ]
    );
}

#[test]
fn render_to_buffer_styled_surfaces_underline_variants_and_color() {
    // A run whose cells carry an underline style variant reports the variant
    // keyword as `underline_style`, and a run whose cells carry an underline
    // color reports it as `underline_color` — the values the engine threads
    // from the `underline_style` / `underline_color` style keys into
    // `Style::underline_style` / `Style::underline_color`. The variants
    // participate in style equality, so the double/curly/dotted runs split
    // from each other and from the default-styled border exactly like a
    // colored or bold run does.
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene
        .add_text(
            root,
            "abc",
            Style::new().underline_style(UnderlineStyle::Double),
        )
        .expect("add double-underlined text");
    scene
        .add_text(
            root,
            "def",
            Style::new().underline_style(UnderlineStyle::Curly),
        )
        .expect("add curly-underlined text");
    scene
        .add_text(
            root,
            "ghi",
            Style::new().underline_style(UnderlineStyle::Dotted),
        )
        .expect("add dotted-underlined text");
    scene
        .add_text(
            root,
            "!",
            Style::new().underline_color(Some(_Color::Rgb(255, 0, 0))),
        )
        .expect("add colored-underline text");

    let runs = paint_scene_runs_with_selection(&scene, Size::new(10, 1), None);
    assert_eq!(
        runs,
        vec![vec![
            underline_run("abc", "double"),
            underline_run("def", "curly"),
            underline_run("ghi", "dotted"),
            underline_color_run("!", "#ff0000"),
        ]]
    );
}

#[test]
fn render_to_buffer_styled_text_reconstructs_plain_rows() {
    // The styled snapshot must never change the painted text:
    // concatenating each row's run texts reproduces the
    // `render_to_buffer` row string for the same scene, byte for byte —
    // the two snapshot flavors share one paint path.
    let mut scene = Scene::new();
    let root = scene.root_id();
    let box_id = scene
        .add_child(
            root,
            NodeKind::Box,
            Style::new().border_style(BorderStyle::Rounded),
        )
        .expect("add box");
    scene.set_prop(box_id, "padding", PropValue::Int(1));
    scene
        .add_text(
            box_id,
            "Hi",
            Style::new()
                .fg(_Color::Rgb(255, 0, 0))
                .add_modifier(Modifiers::BOLD),
        )
        .expect("add styled text");

    let rows = paint_scene_rows_with_selection(&scene, Size::new(6, 3), None);
    let runs = paint_scene_runs_with_selection(&scene, Size::new(6, 3), None);
    let reconstructed: Vec<String> = runs
        .iter()
        .map(|row| row.iter().map(|run| run.text.as_str()).collect())
        .collect();
    assert_eq!(reconstructed, rows);
}

#[test]
fn render_to_buffer_styled_masks_and_merges_wide_char_cells() {
    // A wide glyph's masked continuation cell maps to a space and merges
    // into the lead cell's run — the mask carries the lead's style — so a
    // styled コ followed by a default-styled `a` collapses into two runs:
    // "コ " bold-red, then "a " default. Concatenating the run texts
    // reconstructs the plain row.
    let mut buffer = Buffer::new(4, 1);
    buffer.set_string(
        0,
        0,
        "コ",
        Style::new()
            .fg(_Color::Rgb(255, 0, 0))
            .add_modifier(Modifiers::BOLD),
    );
    buffer.set_string(2, 0, "a", Style::new());
    assert_eq!(
        buffer_runs(&buffer),
        vec![vec![bold_red_run("コ "), plain_run("a ")]]
    );
}

#[test]
fn render_to_buffer_styled_errors_when_destroyed() {
    // The napi method guards on the destroyed flag like `render_to_buffer`
    // and `render`, so a torn-down renderer cannot snapshot.
    let scene = Arc::new(Mutex::new(Scene::new()));
    let inner = RendererInner {
        backend: Box::new(Backend::new()),
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
        scroll_region: false,
        keyboard_enhancement: false,
        any_event_mouse: false,
        destroyed: true,
        #[cfg(feature = "push-events")]
        event_loop: None,
        #[cfg(unix)]
        signals: None,
        #[cfg(all(unix, feature = "push-events"))]
        signal_tsfn: None,
    };
    let renderer = TuiRenderer {
        inner: Arc::new(Mutex::new(inner)),
    };
    let err = renderer
        .render_to_buffer_styled(None, None)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[test]
fn render_to_buffer_masks_wide_char_continuation_cells() {
    // A wide glyph occupies two columns: the lead cell carries the glyph
    // and the continuation cell is masked (NUL). `buffer_rows` maps the
    // mask to a space so the row string keeps the buffer's full display
    // width — the wide character is never dropped nor doubled.
    let mut buffer = Buffer::new(4, 1);
    buffer.set_string(0, 0, "コa", Style::new());
    assert_eq!(buffer_rows(&buffer), vec!["コ a "]);
}

#[test]
fn render_to_buffer_zwj_family_emoji_is_single_2_column_glyph() {
    // A ZWJ family emoji is ONE grapheme cluster rendered as a single
    // 2-column glyph: the snapshot row reconstructs the full cluster
    // string in its lead cell, with the masked continuation cell as a
    // space — never the lead char alone, never a re-split sequence.
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene
        .add_text(root, "👨‍👩‍👧‍👦", Style::new())
        .expect("add text");
    let rows = paint_scene_rows_with_selection(&scene, Size::new(4, 1), None);
    // Cells: [👨‍👩‍👧‍👦][mask→space][space][space].
    assert_eq!(rows, vec!["👨‍👩‍👧‍👦   "], "got: {rows:?}");
}

#[test]
fn render_to_buffer_flag_is_single_2_column_glyph() {
    // A regional-indicator flag is ONE grapheme cluster rendered as a
    // single 2-column glyph in the snapshot row.
    let mut scene = Scene::new();
    let root = scene.root_id();
    scene.add_text(root, "🇷🇺", Style::new()).expect("add text");
    let rows = paint_scene_rows_with_selection(&scene, Size::new(3, 1), None);
    assert_eq!(rows, vec!["🇷🇺  "], "got: {rows:?}");
}

#[test]
fn render_to_buffer_errors_when_destroyed() {
    // The napi method guards on the destroyed flag, so a torn-down
    // renderer cannot snapshot (mirrors `render`).
    let scene = Arc::new(Mutex::new(Scene::new()));
    let inner = RendererInner {
        backend: Box::new(Backend::new()),
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
        scroll_region: false,
        keyboard_enhancement: false,
        any_event_mouse: false,
        destroyed: true,
        #[cfg(feature = "push-events")]
        event_loop: None,
        #[cfg(unix)]
        signals: None,
        #[cfg(all(unix, feature = "push-events"))]
        signal_tsfn: None,
    };
    let renderer = TuiRenderer {
        inner: Arc::new(Mutex::new(inner)),
    };
    let err = renderer
        .render_to_buffer(None, None)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[test]
fn set_cursor_routes_renders_through_the_cursor_aware_flush_and_clear_restores_legacy() {
    // `set_cursor` stores the caret override; the next render flushes
    // through the cursor-aware path with exactly that cursor (position,
    // shape, visibility, blink), and a later `clear_cursor` falls back to
    // the legacy position-only flush. Both edits invalidate the render fast
    // path — exactly like a selection edit — so the cursor change reaches
    // the terminal even when the scene is unchanged, and once the cursor
    // state settles the no-op fast path returns.
    use tern_core::cursor::CursorShape;

    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    renderer
        .set_cursor(3, 2, "bar".to_string(), true, true)
        .expect("set cursor");
    renderer.render().expect("render with cursor");
    // The cursor-aware flush ran; the legacy flush did not.
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 0);
    assert_eq!(probe.cursor_flush_calls.load(Ordering::Relaxed), 1);
    let flushed = probe
        .flushed_cursor()
        .expect("the cursor-aware flush must carry the cursor");
    assert_eq!(flushed.position(), (3, 2));
    assert_eq!(flushed.shape, CursorShape::Bar);
    assert!(flushed.blinking);
    assert!(flushed.is_visible());

    // clear_cursor + render (scene unchanged): the legacy flush is used
    // again — the cursor edit forced the repaint.
    renderer.clear_cursor().expect("clear cursor");
    renderer.render().expect("render without cursor");
    assert_eq!(probe.cursor_flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 1);

    // With no cursor set and everything else unchanged, the no-op fast path
    // is back: a third render touches the backend not at all.
    renderer.render().expect("no-op render");
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.cursor_flush_calls.load(Ordering::Relaxed), 1);
}

#[test]
fn set_cursor_hides_and_rejects_unknown_shapes() {
    // `visible: false` hides the caret and an unrecognized shape string is
    // rejected without mutating the stored cursor.
    use tern_core::cursor::CursorShape;

    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    renderer
        .set_cursor(1, 1, "underline".to_string(), false, false)
        .expect("set hidden underline cursor");
    renderer.render().expect("render with hidden cursor");
    let flushed = probe
        .flushed_cursor()
        .expect("the cursor-aware flush must carry the cursor");
    assert_eq!(flushed.shape, CursorShape::Underline);
    assert!(!flushed.is_visible());
    assert!(!flushed.blinking);

    // An unknown shape is an error that leaves the stored cursor untouched:
    // the next render still sees the previous cursor, and — with everything
    // else unchanged — hits the no-op fast path (zero flushes), which is
    // exactly what an unchanged cursor state must produce.
    let err = renderer
        .set_cursor(0, 0, "diamond".to_string(), true, false)
        .expect_err("unknown shape must error");
    assert!(err.to_string().contains("invalid cursor shape"), "{err}");
    renderer.render().expect("render after rejected shape");
    assert_eq!(probe.cursor_flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 0);
}

#[test]
fn scroll_frame_routes_to_flush_scroll_and_mutation_diffs_correctly() {
    // The M2.1 scroll fast path end to end (roadmap diff-correctness
    // requirement): a frame whose diff is exactly a vertical scroll of a
    // full-width band flushes through `flush_scroll` with the detected
    // `ScrollOp` and only the exposed band; a subsequent in-place mutation
    // flushes the normal diff against the RETAINED frame — the full
    // post-scroll buffer, not the exposed-band-only paint — so the diff is
    // exactly the mutated cells.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    // A 3-line text leaf at the origin: rows 0..2, full viewport width.
    let scene = scene_with_text("aaaaa\nbbbbb\nccccc", 5, 3);
    let renderer = renderer_with_scene(backend, scene.clone());
    // Enable the scroll fast path. The harness defaults it off (the
    // constructor's probe reports conservative defaults under cargo test);
    // the gate itself is covered by
    // `scroll_optimization_decision_covers_all_combinations`.
    renderer
        .inner
        .lock()
        .expect("renderer inner poisoned")
        .scroll_region = true;

    // Render 1: no retained frame yet — full diff flush.
    renderer.render().expect("first render");
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.scroll_flush_calls.load(Ordering::Relaxed), 0);

    // Render 2: the content scrolls up one row — every row of the band's
    // overlap matches the previous frame one row away cell-for-cell, so the
    // scroll is detected and the frame routes to flush_scroll (no diff
    // flush), with the bottom (exposed) row as the only repaint.
    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        let text = s.children(root).expect("root children")[0];
        s.set_prop(text, "text", PropValue::Str("bbbbb\nccccc\nddddd".into()));
    }
    renderer.render().expect("scroll render");
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.scroll_flush_calls.load(Ordering::Relaxed), 1);
    let ops = probe.scroll_ops();
    assert_eq!(ops, vec![ScrollOp {
        top: 0,
        bottom: 2,
        rows: 1,
        up: true,
    }]);
    // The scroll flush reported the exposed band's 5 cells.
    assert_eq!(renderer.last_flush_bytes(), 5);

    // Render 3: an in-place mutation in the middle row — not a scroll (the
    // changed-row band is one row tall) — so the normal diff flush runs,
    // computed against the retained full post-scroll frame: exactly the 5
    // mutated cells, nothing from the exposed band the scroll painted.
    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        let text = s.children(root).expect("root children")[0];
        s.set_prop(text, "text", PropValue::Str("bbbbb\nXXXXX\nddddd".into()));
    }
    renderer.render().expect("mutation render");
    assert_eq!(probe.scroll_flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(probe.flush_calls.load(Ordering::Relaxed), 2);
    let updates = probe
        .last_flush_updates()
        .expect("mutation diff captured");
    assert_eq!(updates.len(), 5, "only the mutated row diffs");
    assert!(updates.iter().all(|u| u.y == 1), "updates: {updates:?}");
}

#[test]
fn scroll_optimization_decision_covers_all_combinations() {
    // The full option × headless × probe truth table behind the
    // constructor's probe-gated scroll fast path (mirroring the kitty
    // keyboard decision): the path is enabled only when the caller opted in,
    // the renderer is not headless, and the probe reports scroll-region
    // support. A conservative probe (no reply, non-TTY, or TERM=dumb), a
    // tmux/screen identity, an explicit opt-out, or a headless renderer must
    // never take the scroll path.
    let scroll_region = tern_terminal::TerminalCapabilities {
        scroll_region: true,
        ..tern_terminal::TerminalCapabilities::default()
    };
    let legacy = tern_terminal::TerminalCapabilities::default();
    let cases = [
        // (option, headless, probe, expect scroll enabled)
        (false, false, &legacy, false),
        (false, false, &scroll_region, false),
        (false, true, &legacy, false),
        (false, true, &scroll_region, false),
        (true, false, &legacy, false),
        (true, false, &scroll_region, true),
        (true, true, &legacy, false),
        (true, true, &scroll_region, false),
    ];
    for (option, headless, caps, expect) in cases {
        assert_eq!(
            should_scroll_optimize(option, headless, caps),
            expect,
            "option={option} headless={headless} scroll_region={}",
            caps.scroll_region
        );
    }
}
