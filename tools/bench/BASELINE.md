# tern render baseline

Baseline performance numbers for the tern render pipeline, recorded when the
benchmark harness landed (2026-08-04). Both benches drive the **same synthetic
scene**: a root box (120x40 viewport) holding ~200 nested boxes (3-5 text
leaves each, ~800 leaves total), one `streaming_text` node with 50 styled
spans, and one text leaf with a `caret` prop — roughly 1000 scene nodes.

## Environment

- macOS (darwin, arm64), Apple silicon
- Rust release profile (`lto = true`), Deno 2.9.x
- Measured on a MacBook Pro M-series (see per-run variance below)

## Rust: compositor pipeline (paint + diff + flush)

`src/core/tern-components/tests/bench_timing.rs` — an `#[ignore]`d integration
test that times 2000 iterations of `Compositor::paint_scene` +
`Buffer::diff_from` + `flush_diff_to` into an in-memory `Vec<u8>` sink.

```text
cargo test --release -p tern-components --test bench_timing -- --ignored --nocapture
```

| metric                 | value            |
|------------------------|------------------|
| mean frame             | ~1.29–1.32 ms    |
| **p50 frame**          | **~1.29 ms**     |
| p95 frame              | ~1.35–1.39 ms    |
| throughput             | ~3.6–3.7 M cells/sec (~770 fps @ 4800 cells/frame) |

Representative single run (first recorded):

```text
viewport: 120x40 (4800 cells/frame)
scene: root box + 200 nested boxes (3-5 text leaves each) + streaming_text (50 spans) + caret node, ~1003 nodes
iterations: 2000
mean: 1.292 ms/frame
p50:  1.284 ms/frame
p95:  1.349 ms/frame
cells/sec: 3714736 cells/sec (773.9 fps at 4800 cells/frame)
```

The scene is static, so after the first iteration the diff is empty and the
flush hits the empty-diff fast path (a no-op) — the number is dominated by
layout + paint, which is the point of the baseline.

## TS: renderer round-trip (real addon, real terminal)

`tools/bench/render.bench.ts` — a Deno script that loads the real tern-node
addon via `@tern/core`, builds the same synthetic scene, and times N = 1000
`renderer.render()` calls (paint + diff + flush to the live terminal) with a
`Spinner` tick between each frame, so the diff is non-empty every frame.

```text
deno run --allow-ffi --allow-read --allow-env tools/bench/render.bench.ts
```

Run in a real terminal / PTY sized 120x40. Without a PTY (or without the
addon), the script prints an explicit SKIP message and exits 0.

| metric                 | value              |
|------------------------|--------------------|
| mean round-trip        | ~22.1–23.3 ms      |
| **p50 round-trip**     | **~22.0–22.4 ms**  |
| **fps**                | **~43–45**         |

Representative run:

```text
render.bench: 1000 render() round-trips @ 120x40 synthetic scene
  mean: 22.121 ms/frame
  p50:  22.001 ms/frame
  fps:  45.2
```

The round-trip includes the napi boundary crossing and the real terminal
flush; it is the end-to-end JS-facing number the high-frame-rate work targets.

## Interpretation

- The Rust pipeline alone is comfortably >200 fps for this scene; the JS
  round-trip lands at ~45 fps — the gap is napi overhead + terminal I/O, the
  space the high-frame-rate rendering strategy operates in.
- Rerun both benches on the same machine after any render-path change to
  quantify the delta; the commands above are the canonical reproduction.
