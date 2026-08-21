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
        scroll_optimization: None,
        semantics: None,
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

#[test]
fn keyboard_enhancement_push_decision_covers_all_combinations() {
    // The full option × headless × probe truth table behind the
    // constructor's probe-gated kitty keyboard push: the flags are pushed
    // only when the caller opted in, the renderer is not headless, and the
    // probe reports kitty keyboard support. A conservative probe (no reply,
    // non-TTY, or TERM=dumb) or an explicit opt-out must never push, and a
    // headless renderer never pushes — `destroy` pops exactly what was
    // pushed.
    let kitty = tern_terminal::TerminalCapabilities {
        kitty_keyboard: true,
        ..tern_terminal::TerminalCapabilities::default()
    };
    let legacy = tern_terminal::TerminalCapabilities::default();
    let cases = [
        // (option, headless, probe, expect pushed)
        (false, false, &legacy, false),
        (false, false, &kitty, false),
        (false, true, &legacy, false),
        (false, true, &kitty, false),
        (true, false, &legacy, false),
        (true, false, &kitty, true),
        (true, true, &legacy, false),
        (true, true, &kitty, false),
    ];
    for (option, headless, caps, expect) in cases {
        assert_eq!(
            should_push_keyboard_enhancement(option, headless, caps),
            expect,
            "option={option} headless={headless} kitty_keyboard={}",
            caps.kitty_keyboard
        );
    }
}

#[test]
fn interactive_terminal_error_covers_all_term_dumb_stdout_tty_combinations() {
    // The full (term_dumb, stdout_tty) truth table behind the constructor's
    // interactive-terminal guard (roadmap M1.5): only a real terminal — not
    // TERM=dumb, stdout a TTY — constructs; every other combination errors
    // with the documented message. The decision is pure (no process env or
    // stdio access), so the test is deterministic under `cargo test`; the
    // ambient constructor-level check is covered by the PTY smoke case
    // instead of a nondeterministic TTY/env-dependent Rust test.
    let expected = "tern requires an interactive terminal (TERM=dumb or non-TTY)";
    let cases = [
        // (term_dumb, stdout_tty, expect error message)
        (true, false, Some(expected)),
        (true, true, Some(expected)),
        (false, false, Some(expected)),
        (false, true, None),
    ];
    for (term_dumb, stdout_tty, expect) in cases {
        assert_eq!(
            interactive_terminal_error(term_dumb, stdout_tty),
            expect,
            "term_dumb={term_dumb} stdout_tty={stdout_tty}"
        );
    }
}

#[test]
fn set_any_event_mouse_reaches_backend_and_destroy_tears_down_in_order() {
    // `set_any_event_mouse(true)` must reach the backend (the mock counts
    // the enable call), record the any-event state, and `destroy` must then
    // emit the any-event teardown (`?1003l`) BEFORE the general
    // event-listening disable — the terminal closes its capture modes in
    // enable order.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    renderer
        .set_any_event_mouse(true)
        .expect("enable reaches the backend");
    assert_eq!(
        probe.any_event_enable_calls.load(Ordering::Relaxed),
        1,
        "set_any_event_mouse(true) must call the backend's enable"
    );

    renderer.destroy().expect("destroy succeeds");
    assert_eq!(
        probe.teardown_log(),
        ["disable_any_event_mouse", "disable_event_listening"],
        "destroy must close any-event before the general disable"
    );
}

#[test]
fn disabling_any_event_mouse_suppresses_the_destroy_time_teardown() {
    // `set_any_event_mouse(false)` clears the recorded state through the
    // backend's own disable, so `destroy` must not emit a redundant second
    // any-event teardown — the log holds exactly one `disable_any_event_mouse`,
    // still before the general disable.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);

    renderer.set_any_event_mouse(true).expect("enable");
    renderer.set_any_event_mouse(false).expect("disable");
    renderer.destroy().expect("destroy succeeds");
    assert_eq!(
        probe.teardown_log(),
        ["disable_any_event_mouse", "disable_event_listening"],
        "the explicit disable replaces the destroy-time teardown, order kept"
    );
}

#[test]
fn set_any_event_mouse_errors_on_a_destroyed_renderer() {
    // Like every state toggle, `set_any_event_mouse` guards on the
    // destroyed flag: a torn-down renderer cannot touch the backend.
    let (renderer, _scene) = counting_renderer(CountingBackend::default());
    renderer.destroy().expect("destroy succeeds");
    let err = renderer
        .set_any_event_mouse(true)
        .expect_err("destroyed renderer must error");
    assert!(err.to_string().contains("destroyed"), "{err}");
}

#[cfg(unix)]
#[test]
fn restore_then_resume_terminal_round_trips_the_backend_and_forces_repaint() {
    // The SIGTSTP suspend / SIGCONT resume terminal transitions: `restore`
    // closes the capture modes in enable order, and `resume` re-enters them
    // in startup order, re-enabling exactly what was pushed, then
    // invalidates the render fast path (size cache + retained frame +
    // painted epoch) so the next render repaints the whole screen.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);
    {
        let mut inner = renderer.inner.lock().expect("renderer inner poisoned");
        inner.keyboard_enhancement = true;
        inner.use_alt_screen = true;
        inner.any_event_mouse = true;
        // A painted frame + a valid size cache: the resume must clear both.
        inner.last = Some(Buffer::new(80, 24));
        inner.last_painted_epoch = 7;
        inner.cached_size = Some((80, 24));

        inner.restore_terminal();
        inner.resume_terminal();

        // The resume invalidates the fast-path inputs so the next render
        // repaints (a full-buffer diff, not the no-op fast path).
        assert_eq!(inner.cached_size, None, "resume invalidates the size cache");
        assert!(inner.last.is_none(), "resume drops the retained frame");
        assert_eq!(
            inner.last_painted_epoch, 0,
            "resume clears the painted epoch"
        );
    }
    // The logged calls: restore closes any-event + general listening, then
    // resume re-enters raw mode, alt screen, listening, and the kitty
    // enhancement — the terminal returns to its startup state in order.
    assert_eq!(
        probe.teardown_log(),
        [
            "disable_any_event_mouse",
            "disable_event_listening",
            "enter_raw_mode",
            "enter_alt_screen",
            "enable_event_listening",
            "enter_keyboard_enhancement",
        ],
        "suspend closes the capture modes before resume re-enters them"
    );
    // Any-event mouse was on before the suspend: resume re-enables it.
    assert_eq!(
        probe.any_event_enable_calls.load(Ordering::Relaxed),
        1,
        "resume re-enables any-event mouse when it was on"
    );
}

#[cfg(unix)]
#[test]
fn restore_terminal_is_a_noop_when_the_renderer_is_destroyed() {
    // A suspend that races a destroy must not touch the terminal (the
    // teardown already restored it): the backend sees no restore calls.
    let backend = CountingBackend::default();
    let probe = backend.clone();
    let (renderer, _scene) = counting_renderer(backend);
    {
        let mut inner = renderer.inner.lock().expect("renderer inner poisoned");
        inner.destroyed = true;
        inner.restore_terminal();
    }
    assert_eq!(probe.teardown_log(), Vec::<&str>::new(), "no restore calls");
}
