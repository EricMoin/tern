//! DECSTBM scroll flushes and the semantic scroll model.

use super::*;

#[test]
fn flush_scroll_up_emits_region_index_and_exposed_band() {
    // Scroll up by 1 over region rows 1..=4 (DECSTBM `2;5`): the MoveTo
    // to the region's top-left (column 1, row 2), the raw region set,
    // the raw SU (`ESC[1S`), the exposed bottom row's updates via the
    // run queue, the raw region reset (`ESC[r`), then the park trailer
    // exactly like flush_diff_to.
    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 1,
        up: true,
    };
    let out = flush_scroll(&op, &[update(0, 4, 'x', Style::new(), 1, false)], (0, 0));
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[2;1H\x1b[2;5r\x1b[1S\x1b[5;1H\x1b[0mx\x1b[r\x1b[1;1H\x1b[0m\x1b[0m",
        "got: {:?}",
        out
    );
}

#[test]
fn flush_scroll_down_emits_region_reverse_index_and_exposed_band() {
    // The mirror case: scroll down by 2 over region rows 1..=4 — the
    // raw SD (`ESC[2T`) replaces the SU, and the exposed band sits at
    // the top of the region (row 1).
    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 2,
        up: false,
    };
    let out = flush_scroll(&op, &[update(0, 1, 'y', Style::new(), 1, false)], (0, 0));
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[2;1H\x1b[2;5r\x1b[2T\x1b[2;1H\x1b[0my\x1b[r\x1b[1;1H\x1b[0m\x1b[0m",
        "got: {:?}",
        out
    );
}

#[test]
fn flush_scroll_parks_cursor_at_given_position() {
    // The scroll op runs between the region setup and the park: the
    // MoveTo to the region top-left and the exposed-band run land
    // before the region reset, and the caret parks at cursor_pos (4, 3)
    // -> row 4, column 5 after it.
    let op = ScrollOp {
        top: 2,
        bottom: 6,
        rows: 1,
        up: true,
    };
    let out = flush_scroll(&op, &[update(0, 6, 'z', Style::new(), 1, false)], (4, 3));
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[3;1H\x1b[3;7r\x1b[1S\x1b[7;1H\x1b[0mz\x1b[r\x1b[4;5H\x1b[0m\x1b[0m",
        "got: {:?}",
        out
    );
}

#[test]
fn empty_scroll_with_same_park_writes_nothing() {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 1,
        up: true,
    };
    // Seed the recorded park position with a real scroll frame at (2, 3).
    flush_scroll_to(
        &mut out,
        &op,
        &[update(0, 4, 'x', Style::new(), 1, false)],
        (2, 3),
        &mut last_flush_pos,
    )
    .expect("scroll flush should succeed");
    assert!(!out.is_empty(), "seed scroll should write cells");
    out.clear();

    // An empty exposed band parked at the recorded position: zero bytes
    // written and no flush — no DECSTBM, no SU, no region reset.
    flush_scroll_to(&mut out, &op, &[], (2, 3), &mut last_flush_pos)
        .expect("scroll flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn empty_scroll_with_moved_park_emits_only_move_to() {
    let mut out = Vec::new();
    let mut last_flush_pos = None;
    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 1,
        up: true,
    };
    flush_scroll_to(
        &mut out,
        &op,
        &[update(0, 4, 'x', Style::new(), 1, false)],
        (0, 0),
        &mut last_flush_pos,
    )
    .expect("scroll flush should succeed");
    out.clear();

    // The park moved from (0, 0) to (5, 4): only the MoveTo (1-based row
    // 5, column 6) is queued — no region work, no cells, no style
    // commands.
    flush_scroll_to(&mut out, &op, &[], (5, 4), &mut last_flush_pos)
        .expect("scroll flush should succeed");
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "\x1b[5;6H",
        "got: {:?}",
        out
    );

    // The new position is recorded, so the next empty scroll parked at
    // the same spot is suppressed again.
    out.clear();
    flush_scroll_to(&mut out, &op, &[], (5, 4), &mut last_flush_pos)
        .expect("scroll flush should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn scroll_model_reconstructs_next_buffer_cell_for_cell() {
    // A pure one-row scroll up over region rows 1..=4 of an 8x6 buffer:
    // the terminal shifts the region's content up and exposes a fresh
    // bottom row. The prev -> next diff covers exactly the exposed band,
    // so feeding the ScrollOp plus those updates through the semantic
    // model must reproduce `next` cell-for-cell.
    let mut prev = Buffer::new(8, 6);
    prev.set_string(0, 0, "top", Style::new());
    prev.set_string(0, 1, "one", Style::new());
    prev.set_string(0, 2, "two", Style::new());
    prev.set_string(0, 3, "thr", Style::new());
    prev.set_string(0, 4, "fou", Style::new());
    prev.set_string(0, 5, "bot", Style::new());

    let mut next = Buffer::new(8, 6);
    next.set_string(0, 0, "top", Style::new());
    next.set_string(0, 1, "two", Style::new());
    next.set_string(0, 2, "thr", Style::new());
    next.set_string(0, 3, "fou", Style::new());
    next.set_string(0, 4, "NEW", Style::new());
    next.set_string(0, 5, "bot", Style::new());

    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 1,
        up: true,
    };
    // The full prev -> next diff covers every shifted row (the terminal
    // scrolls those natively), so the scroll path paints only the
    // exposed band — the bottom `rows` rows when scrolling up, exactly
    // the filter the renderer applies before calling flush_scroll.
    let updates: Vec<CellUpdate> = next
        .diff_from(&prev)
        .into_iter()
        .filter(|u| u.y > op.bottom - op.rows)
        .collect();
    // Only the exposed bottom row changed: three cells, all on row 4.
    assert_eq!(updates.len(), 3, "got: {updates:?}");
    assert!(updates.iter().all(|u| u.y == 4), "got: {updates:?}");

    let model = apply_scroll_model(&prev, &op, &updates);
    assert_buffer_eq(&model, &next);
    assert_eq!(model, next);

    // The mirror direction: scroll down by 1 exposes the top row.
    let mut prev = Buffer::new(8, 6);
    prev.set_string(0, 0, "top", Style::new());
    prev.set_string(0, 1, "one", Style::new());
    prev.set_string(0, 2, "two", Style::new());
    prev.set_string(0, 3, "thr", Style::new());
    prev.set_string(0, 4, "fou", Style::new());
    prev.set_string(0, 5, "bot", Style::new());

    let mut next = Buffer::new(8, 6);
    next.set_string(0, 0, "top", Style::new());
    next.set_string(0, 1, "NEW", Style::new());
    next.set_string(0, 2, "one", Style::new());
    next.set_string(0, 3, "two", Style::new());
    next.set_string(0, 4, "thr", Style::new());
    next.set_string(0, 5, "bot", Style::new());

    let op = ScrollOp {
        top: 1,
        bottom: 4,
        rows: 1,
        up: false,
    };
    // Scroll down exposes the top `rows` rows of the region.
    let updates: Vec<CellUpdate> = next
        .diff_from(&prev)
        .into_iter()
        .filter(|u| u.y < op.top + op.rows)
        .collect();
    assert_eq!(updates.len(), 3, "got: {updates:?}");
    assert!(updates.iter().all(|u| u.y == 1), "got: {updates:?}");

    let model = apply_scroll_model(&prev, &op, &updates);
    assert_buffer_eq(&model, &next);
    assert_eq!(model, next);
}
