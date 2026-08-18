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
        cached_size: None,
        last_flush_bytes: 0,
        #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
        exit_on_ctrl_c: false,
        use_alt_screen: false,
        headless: false,
        keyboard_enhancement: false,
        destroyed: true,
        #[cfg(feature = "push-events")]
        event_loop: None,
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
        cached_size: None,
        last_flush_bytes: 0,
        #[cfg(any(feature = "push-events", feature = "poll-fallback"))]
        exit_on_ctrl_c: false,
        use_alt_screen: false,
        headless: false,
        keyboard_enhancement: false,
        destroyed: true,
        #[cfg(feature = "push-events")]
        event_loop: None,
    };
    let renderer = TuiRenderer {
        inner: Arc::new(Mutex::new(inner)),
    };
    let err = renderer
        .render_to_buffer(None, None)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}
