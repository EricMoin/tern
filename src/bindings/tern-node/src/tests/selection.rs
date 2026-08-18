use super::*;

#[test]
fn set_clipboard_forwards_text_to_the_injected_backend() {
    // The renderer forwards the clipboard text verbatim to the injected
    // backend sink; the byte-level OSC 52 emission (ESC ] 52 ; c ; <base64>
    // BEL) is asserted by tern-terminal's `set_clipboard_to` tests.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);
    renderer
        .set_clipboard("hello".to_string())
        .expect("set_clipboard succeeds");
    assert_eq!(
        probe.clipboard().as_deref(),
        Some("hello"),
        "the text must reach the backend verbatim"
    );

    // A destroyed renderer refuses.
    renderer.destroy().expect("destroy succeeds");
    let err = renderer
        .set_clipboard("nope".to_string())
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[test]
fn selection_change_invalidates_the_render_fast_path() {
    // A selection edit must force the next render to repaint (the
    // terminal shows the previous frame's overlay); an unchanged
    // selection keeps the zero-write no-op fast path.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let renderer = renderer_with_scene(backend, scene_with_text("hello", 5, 1));

    renderer.render().expect("first render paints");
    let after_first = probe.ops();
    assert!(after_first > 0);

    // Unchanged selection (None): no-op fast path, zero terminal writes.
    renderer.render().expect("unchanged render");
    assert_eq!(probe.ops(), after_first, "unchanged render must fast-path");

    // A selection edit invalidates the fast path: the next render
    // repaints (and reaches the flush).
    renderer.set_selection(1, 0, 3, 0).expect("set selection");
    renderer.render().expect("render after selection edit");
    assert!(
        probe.ops() > after_first,
        "a selection edit must force a repaint"
    );

    // The selection is now painted: an unchanged render fast-paths again.
    let after_selected = probe.ops();
    renderer.render().expect("render with unchanged selection");
    assert_eq!(probe.ops(), after_selected);

    // Clearing the selection invalidates the fast path once more.
    renderer.clear_selection().expect("clear selection");
    renderer.render().expect("render after clear");
    assert!(
        probe.ops() > after_selected,
        "a cleared selection must force a repaint"
    );
}

#[test]
fn selection_text_extracts_the_selected_region_from_the_last_painted_frame() {
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("hello world", 11, 1),
    );
    renderer.render().expect("render paints the frame");

    renderer.set_selection(6, 0, 10, 0).expect("set selection");
    assert_eq!(
        renderer.selection_text().expect("selection text"),
        "world",
        "selection_text reads the last painted buffer"
    );

    // Reversed endpoints normalize identically.
    renderer.set_selection(10, 0, 6, 0).expect("set selection reversed");
    assert_eq!(renderer.selection_text().expect("selection text"), "world");

    // A selection spanning the trailing blank cells extracts the exact
    // cell content (trailing spaces preserved).
    renderer.set_selection(8, 0, 10, 0).expect("set selection tail");
    assert_eq!(renderer.selection_text().expect("selection text"), "rld");

    // Clearing the selection empties the extraction.
    renderer.clear_selection().expect("clear selection");
    assert_eq!(renderer.selection_text().expect("selection text"), "");
}

#[test]
fn selection_text_joins_rows_with_newlines() {
    // A multi-row selection joins the rows with '\n'.
    let renderer = renderer_with_scene(CountingBackend::default(), two_row_scene());
    renderer.render().expect("render paints the frame");

    renderer.set_selection(0, 0, 4, 1).expect("set selection");
    assert_eq!(
        renderer.selection_text().expect("selection text"),
        "hello\nworld"
    );

    // A single-row window extracts only that row.
    renderer.set_selection(0, 1, 4, 1).expect("set selection row 1");
    assert_eq!(renderer.selection_text().expect("selection text"), "world");
}

#[test]
fn selection_text_is_cluster_aware_across_wide_glyphs() {
    // A wide char's masked continuation cell contributes nothing: the
    // extraction yields the full cluster once.
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("コa", 3, 1),
    );
    renderer.render().expect("render paints the frame");

    // コ at cols 0-1 (lead + mask), 'a' at col 2.
    renderer.set_selection(0, 0, 2, 0).expect("set selection");
    assert_eq!(renderer.selection_text().expect("selection text"), "コa");

    // A ZWJ family emoji stays one 2-column glyph in the extraction.
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("👨‍👩‍👧‍👦x", 3, 1),
    );
    renderer.render().expect("render paints the frame");
    renderer.set_selection(0, 0, 2, 0).expect("set selection");
    assert_eq!(
        renderer.selection_text().expect("selection text"),
        "👨‍👩‍👧‍👦x"
    );
}

#[test]
fn selection_text_is_empty_without_a_selection_or_paint() {
    // No paint yet: nothing to extract from.
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("hello", 5, 1),
    );
    assert_eq!(renderer.selection_text().expect("selection text"), "");

    // Painted but no selection set.
    renderer.render().expect("render paints the frame");
    assert_eq!(renderer.selection_text().expect("selection text"), "");
}

#[test]
fn selection_word_range_finds_words_and_rejects_whitespace() {
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("foo bar baz", 11, 1),
    );
    renderer.render().expect("render paints the frame");

    let word_at = |col: u32, row: u32| {
        renderer
            .selection_word_range(col, row)
            .expect("word range query")
    };

    // "foo" at cols 0-2, "bar" at 4-6, "baz" at 8-10.
    assert_eq!(word_at(1, 0).unwrap().col1, 0);
    assert_eq!(word_at(1, 0).unwrap().col2, 2);
    assert_eq!(word_at(5, 0).unwrap().col1, 4);
    assert_eq!(word_at(5, 0).unwrap().col2, 6);
    assert_eq!(word_at(10, 0).unwrap().col1, 8);
    assert_eq!(word_at(10, 0).unwrap().col2, 10);

    // Whitespace and out-of-bounds cells start no word.
    assert!(word_at(3, 0).is_none(), "a space starts no word");
    assert!(word_at(7, 0).is_none(), "a space starts no word");
    assert!(word_at(0, 5).is_none(), "a row outside the buffer starts no word");
    assert!(word_at(20, 0).is_none(), "a column outside the buffer starts no word");
    assert!(word_at(11, 0).is_none(), "the right edge starts no word");
}

#[test]
fn selection_word_range_is_cluster_aware_across_wide_glyphs() {
    // "コab": コ at cols 0-1 (lead + masked continuation), 'a' at 2, 'b'
    // at 3. Clicking the mask column still resolves the word containing
    // the whole glyph.
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("コab", 4, 1),
    );
    renderer.render().expect("render paints the frame");

    let word_at = |col: u32| {
        renderer
            .selection_word_range(col, 0)
            .expect("word range query")
    };

    // The run is the whole non-whitespace line: 0..=3.
    let r = word_at(0).expect("lead cell");
    assert_eq!((r.col1, r.col2), (0, 3));
    let r = word_at(1).expect("mask cell");
    assert_eq!((r.col1, r.col2), (0, 3), "the mask is part of the glyph's run");
    let r = word_at(2).expect("a cell");
    assert_eq!((r.col1, r.col2), (0, 3));
}

#[test]
fn render_to_buffer_snapshot_applies_the_selection_overlay_without_corrupting_text() {
    // The snapshot paints through the renderer's selection: the overlay
    // is style-only, so the returned rows are byte-identical with and
    // without a selection — the snapshot is where a styled consumer would
    // observe the reversed cells, and the text must never be corrupted.
    let renderer = renderer_with_scene(
        CountingBackend::default(),
        scene_with_text("hello", 5, 1),
    );
    let plain = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot without selection");
    assert_eq!(plain, vec!["hello"]);

    renderer.set_selection(1, 0, 3, 0).expect("set selection");
    let selected = renderer
        .render_to_buffer(Some(5), Some(1))
        .expect("snapshot with selection");
    assert_eq!(selected, plain, "the overlay must not change the text");

    // The snapshot's viewport still tracks (per-renderer state).
    let size = renderer.size().expect("size");
    assert_eq!((size.width, size.height), (5, 1));
}

#[test]
fn selection_api_guards_on_a_destroyed_renderer() {
    let (renderer, _scene) = counting_renderer(CountingBackend::default());
    renderer.destroy().expect("destroy succeeds");
    let err = renderer
        .set_selection(0, 0, 1, 1)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
    let err = renderer
        .clear_selection()
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
    let err = renderer
        .selection_text()
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
    let err = renderer
        .selection_word_range(0, 0)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}
