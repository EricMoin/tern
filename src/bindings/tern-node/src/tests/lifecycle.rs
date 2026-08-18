use super::*;

#[test]
fn headless_renderer_constructs_without_a_terminal() {
    // Construction with `headless: true` must not touch a real terminal
    // (no raw mode, no alternate screen, no event listening, no title):
    // it succeeds under plain `cargo test` with no TTY and reports the
    // default 80x24 virtual size.
    let renderer = headless_renderer();
    assert!(!renderer.destroyed());
    let size = renderer.size().expect("size works headlessly");
    assert_eq!((size.width, size.height), (80, 24), "got: {size:?}");
}

#[test]
fn headless_renderer_renders_and_snapshots_without_a_terminal() {
    // `render`, `render_to_buffer`, and `render_to_buffer_styled` all
    // work against the in-memory backend: the frame paints at the
    // virtual size and both snapshot flavors return one row per
    // configured height cell, each row the configured width.
    let renderer = headless_renderer();
    renderer.render().expect("render works headlessly");
    let rows = renderer
        .render_to_buffer(None, None)
        .expect("plain snapshot works headlessly");
    assert_eq!(rows.len(), 24, "snapshot defaults to the virtual height");
    assert!(
        rows.iter().all(|row| row.len() == 80),
        "snapshot rows must be the virtual width"
    );
    let runs = renderer
        .render_to_buffer_styled(None, None)
        .expect("styled snapshot works headlessly");
    assert_eq!(
        runs.len(),
        24,
        "styled snapshot defaults to the virtual height"
    );
}

#[test]
fn headless_renderer_destroy_skips_teardown_and_is_idempotent() {
    // `destroy` must not attempt terminal teardown (the in-memory
    // backend no-ops it anyway), must be safe to call twice, and must
    // leave the renderer unusable — exactly like a real renderer.
    let renderer = headless_renderer();
    renderer.destroy().expect("first destroy succeeds");
    renderer.destroy().expect("second destroy is a no-op");
    assert!(renderer.destroyed());
    let err = renderer
        .render()
        .expect_err("a destroyed headless renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
    let err = renderer
        .size()
        .expect_err("size must error on a destroyed renderer");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[test]
fn headless_renderer_custom_size_is_reported_and_painted() {
    // A custom virtual size (120x30) drives the size getter and the
    // snapshot viewport with no TTY involved. The snapshot is painted at
    // an explicit size first (recording `last_painted_viewport` without
    // touching the shared scene viewport), then `size` reports the custom
    // viewport — the suite's shared-viewport default of 80x24 is never
    // mutated, keeping the parallel tests deterministic.
    let renderer = TuiRenderer::new(TuiRendererOptions {
        exit_on_ctrl_c: None,
        use_alt_screen: None,
        title: None,
        headless: Some(true),
        keyboard_enhancement: None,
        width: Some(120),
        height: Some(30),
    })
    .expect("headless renderer with a custom size constructs");
    let rows = renderer
        .render_to_buffer(Some(120), Some(30))
        .expect("custom-size snapshot works headlessly");
    assert_eq!(rows.len(), 30, "snapshot height matches the custom size");
    assert!(
        rows.iter().all(|row| row.len() == 120),
        "snapshot rows are the custom width"
    );
    let runs = renderer
        .render_to_buffer_styled(Some(120), Some(30))
        .expect("custom-size styled snapshot works headlessly");
    assert_eq!(
        runs.len(),
        30,
        "styled snapshot height matches the custom size"
    );
    let size = renderer.size().expect("size reports the custom viewport");
    assert_eq!((size.width, size.height), (120, 30), "got: {size:?}");
}

#[test]
fn unchanged_scene_renders_perform_zero_terminal_writes() {
    // Two consecutive renders with no intervening mutation: the first
    // paints (a size probe plus a flush), the second must hit the no-op
    // fast path and perform zero terminal writes — no size probe, no
    // paint, no diff, no flush.
    let backend = CountingBackend::default();
    let probe = backend.clone(); // keeps the counters after the move
    let (renderer, _scene) = counting_renderer(backend);

    renderer.render().expect("first render paints the scene");
    let after_first = probe.ops();
    assert!(after_first > 0, "first render must touch the backend");

    renderer.render().expect("second render succeeds");
    assert_eq!(
        probe.ops(),
        after_first,
        "an unchanged-scene render must perform zero terminal writes"
    );
}

#[test]
fn mutated_scene_renders_repaint() {
    // A mutation between renders invalidates the scene cache: the next
    // render must repaint (paying for a flush again). The terminal size
    // is served from the size cache — a mutation does not invalidate it,
    // so no second `size()` probe happens.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, scene) = counting_renderer(backend);

    renderer.render().expect("first render paints the scene");
    let after_first = probe.ops();
    assert!(after_first > 0);

    {
        let mut s = scene.lock().expect("scene poisoned");
        let root = s.root_id();
        s.add_child(root, NodeKind::Box, Style::new())
            .expect("mutate the scene");
    }
    renderer.render().expect("render after mutation succeeds");
    assert!(
        probe.ops() > after_first,
        "a mutated scene must repaint (flush; the size probe is served from the cache)"
    );
    assert_eq!(
        probe.size_calls.load(Ordering::Relaxed),
        1,
        "a mutation repaint must not re-probe the terminal size"
    );
}

#[test]
fn fresh_renderer_never_fast_paths_before_first_paint() {
    // The (0,0) viewport sentinel must force a first paint even when the
    // scene epoch already matches `last_painted_epoch` (0 == 0): a
    // renderer that never painted has nothing cached to skip to.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    renderer.render().expect("first render paints");
    assert!(
        probe.ops() > 0,
        "the first render must paint, not fast-path"
    );
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
#[test]
fn size_cache_serves_n_unchanged_renders_with_one_probe_and_resize_invalidates() {
    // The high-frame-rate contract: N consecutive renders of an unchanged
    // scene must perform exactly one `backend.size()` call. The first
    // render probes and caches the terminal size; every later render
    // either hits the no-op fast path (zero calls) or repaints from the
    // cache — no per-frame ioctl.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    let n = 5;
    for _ in 0..n {
        renderer.render().expect("render succeeds");
    }
    assert_eq!(
        probe.size_calls.load(Ordering::Relaxed),
        1,
        "{n} unchanged renders must perform exactly one size() call"
    );

    // A delivered resize event invalidates the cache — this is exactly
    // what the event delivery callback does for every resize event — so
    // the next render must re-query the backend size instead of painting
    // at the stale viewport.
    let probed_before = probe.size_calls.load(Ordering::Relaxed);
    invalidate_size_on_resize(&renderer.inner, &TernEvent::Resize { w: 100, h: 30 });
    renderer.render().expect("render after resize succeeds");
    assert_eq!(
        probe.size_calls.load(Ordering::Relaxed),
        probed_before + 1,
        "a delivered resize event must cause the next render to re-query size"
    );

    // The re-queried size is cached again: the render after that probes
    // nothing more.
    renderer.render().expect("render after re-probe succeeds");
    assert_eq!(
        probe.size_calls.load(Ordering::Relaxed),
        probed_before + 1,
        "the re-queried size is cached again for subsequent renders"
    );

    // Only resize events invalidate: a focus event leaves the cache
    // intact, so the next render still probes nothing.
    invalidate_size_on_resize(&renderer.inner, &TernEvent::FocusGained);
    renderer
        .render()
        .expect("render after focus event succeeds");
    assert_eq!(
        probe.size_calls.load(Ordering::Relaxed),
        probed_before + 1,
        "a non-resize event must not invalidate the size cache"
    );
}

#[test]
fn size_before_any_paint_probes_the_terminal_and_seeds_the_viewport() {
    // A fresh renderer has painted nothing, so `size` surfaces the
    // current terminal size: one probe through the cached-size machinery,
    // recorded as the viewport default (a fresh renderer never reports
    // the synthetic 80x24 fallback when the terminal is a different
    // size).
    with_render_viewport(|| {
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);
        let size = renderer.size().expect("size before any paint succeeds");
        assert_eq!(size.width, 80, "reports the probed terminal width");
        assert_eq!(size.height, 24, "reports the probed terminal height");
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "the first size access must probe exactly once"
        );
        // The probed size was cached: a second access probes nothing.
        let again = renderer.size().expect("second size succeeds");
        assert_eq!((again.width, again.height), (80, 24));
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "the cached size must serve subsequent accesses"
        );
    });
}

#[test]
fn size_reports_the_viewport_of_the_last_render() {
    // After a render, `size` reports the viewport that render painted at
    // (the terminal size it probed and cached) — no re-probe.
    with_render_viewport(|| {
        let backend = CountingBackend::default();
        let probe = backend.clone();
        let (renderer, _scene) = counting_renderer(backend);
        renderer.render().expect("render paints the scene");
        let size = renderer.size().expect("size after render succeeds");
        assert_eq!((size.width, size.height), (80, 24));
        assert_eq!(
            probe.size_calls.load(Ordering::Relaxed),
            1,
            "the render's own probe serves the size access"
        );
    });
}

#[test]
fn size_reports_the_viewport_of_the_last_snapshot() {
    // `render_to_buffer` records its viewport as the renderer's last
    // painted viewport, so `size` reports what the most recent
    // snapshotFrame painted at — even before any real render.
    let backend = CountingBackend::default();
    let (renderer, _scene) = counting_renderer(backend);
    renderer
        .render_to_buffer(Some(6), Some(3))
        .expect("snapshot paints");
    let size = renderer.size().expect("size after snapshot succeeds");
    assert_eq!((size.width, size.height), (6, 3), "got: {size:?}");
    // A bare snapshot defaults to the shared scene viewport (80x24 here:
    // no real render has established it), and that paint becomes the last
    // painted viewport.
    renderer
        .render_to_buffer(None, None)
        .expect("defaulted snapshot succeeds");
    let again = renderer.size().expect("size tracks the defaulted paint");
    assert_eq!((again.width, again.height), (80, 24), "got: {again:?}");
}

#[test]
fn size_errors_on_a_destroyed_renderer() {
    let (renderer, _scene) = counting_renderer(CountingBackend::default());
    renderer.destroy().expect("destroy succeeds");
    let err = renderer.size().expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}
