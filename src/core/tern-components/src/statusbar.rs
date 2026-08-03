//! [`StatusBar`] — a persistent bottom status strip: left/center/right aligned
//! segments (agent state, cwd, mode, key hints) with priority-based overflow.
//!
//! When the row is too narrow, [`StatusBar::trimmed`] drops segments in
//! priority order — lowest priority first, ties breaking rightmost-first — so
//! the strip never wraps. The component materializes into a scene as a full-
//! width row [`Box`](crate::Box) with `justify_content: space-between`
//! holding one group box per alignment.
//!
//! The strip frame is stamped `status_bar: true` when it materializes; the
//! compositor reads that marker to reserve the bottom viewport row for the
//! strip — laying panels out one row shorter and pinning the strip to the
//! reserved row (docs/components.md "StatusBar — Reserved row").

use std::cmp::Reverse;

use tern_core::scene::{NodeId, NodeKind, PropValue, Scene};
use tern_core::style::Style;
use tern_core::char_width;

use crate::renderable::{Box, Renderable};

/// Which side of the strip a segment sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentAlign {
    /// Left-aligned.
    Left,
    /// Centered.
    Center,
    /// Right-aligned.
    Right,
}

/// One status segment: styled text plus its alignment and drop priority.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// The segment text.
    pub text: String,
    /// The segment style.
    pub style: Style,
    /// Drop priority: lower values drop first when the row overflows.
    pub priority: u32,
    /// Alignment within the strip.
    pub align: SegmentAlign,
}

impl Segment {
    /// A left-aligned segment with the default (lowest) priority.
    pub fn new(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
            priority: 0,
            align: SegmentAlign::Left,
        }
    }

    /// Builder: set the alignment.
    pub fn align(mut self, align: SegmentAlign) -> Self {
        self.align = align;
        self
    }

    /// Builder: set the drop priority (higher = kept longer).
    pub fn priority(mut self, priority: u32) -> Self {
        self.priority = priority;
        self
    }
}

/// A bottom status strip.
#[derive(Debug, Clone)]
pub struct StatusBar {
    /// The segments, in declaration order.
    pub segments: Vec<Segment>,
    /// The strip style (background).
    pub style: Style,
    /// The row width in cells the strip is trimmed against; `None` renders
    /// every segment untrimmed.
    pub width: Option<usize>,
    /// Inter-segment gap in cells.
    pub gap: usize,
}

impl StatusBar {
    /// An empty strip with the given background style.
    pub fn new(style: Style) -> Self {
        Self {
            segments: Vec::new(),
            style,
            width: None,
            gap: 1,
        }
    }

    /// Builder: append a segment.
    pub fn segment(mut self, segment: Segment) -> Self {
        self.segments.push(segment);
        self
    }

    /// Builder: append a left-aligned segment.
    pub fn left(mut self, text: impl Into<String>, style: Style) -> Self {
        self.segments.push(Segment::new(text, style));
        self
    }

    /// Builder: append a centered segment.
    pub fn center(mut self, text: impl Into<String>, style: Style) -> Self {
        self.segments.push(Segment::new(text, style).align(SegmentAlign::Center));
        self
    }

    /// Builder: append a right-aligned segment.
    pub fn right(mut self, text: impl Into<String>, style: Style) -> Self {
        self.segments.push(Segment::new(text, style).align(SegmentAlign::Right));
        self
    }

    /// Builder: set the trim width in cells.
    pub fn with_width(mut self, cells: usize) -> Self {
        self.width = Some(cells);
        self
    }

    /// Builder: set the inter-segment gap in cells.
    pub fn gap(mut self, cells: usize) -> Self {
        self.gap = cells;
        self
    }

    /// The total painted width of `segs`: segment text widths plus the gap
    /// between adjacent segments inside the same alignment group (inter-group
    /// spacing is `space-between`, which compresses to zero when tight).
    pub fn total_width(&self, segs: &[Segment]) -> usize {
        if segs.is_empty() {
            return 0;
        }
        let text: usize = segs.iter().map(|s| display_width(&s.text)).sum();
        let mut groups: Vec<SegmentAlign> = Vec::new();
        for s in segs {
            if !groups.contains(&s.align) {
                groups.push(s.align);
            }
        }
        text + self.gap * (segs.len() - groups.len())
    }

    /// The segments that fit in the strip's row width, dropping lowest-
    /// priority segments first (ties break rightmost-first) until the row no
    /// longer overflows. All segments when no width is set.
    pub fn trimmed(&self) -> Vec<Segment> {
        let Some(width) = self.width else {
            return self.segments.clone();
        };
        let mut segs = self.segments.clone();
        while !segs.is_empty() && self.total_width(&segs) > width {
            let drop = (0..segs.len())
                .min_by_key(|&i| (segs[i].priority, Reverse(i)))
                .expect("non-empty segments");
            segs.remove(drop);
        }
        segs
    }

    // --- Rendering -------------------------------------------------------

    /// The strip frame as a bare box (style + layout props, no children).
    ///
    /// The frame is a single-row (`height 1`) `space-between` row: the strip
    /// occupies exactly one viewport row wherever it sits, which is what lets
    /// the compositor pin it to the reserved bottom row.
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.style, vec![])
            .row()
            .justify_content("space-between")
            .align_items("center")
            .gap(self.gap as i64)
            .height(1)
    }

    /// Materialize one alignment group (a row box of styled segment texts).
    fn materialize_group(&self, scene: &mut Scene, parent: NodeId, segs: &[Segment]) {
        if segs.is_empty() {
            return;
        }
        let id = scene
            .add_child(parent, NodeKind::Box, Style::new())
            .expect("status group under strip");
        scene.set_prop(id, "flex_direction", PropValue::Str("row".to_string()));
        scene.set_prop(id, "gap", PropValue::Int(self.gap as i64));
        for seg in segs {
            scene
                .add_text(id, &seg.text, seg.style)
                .expect("segment text under group");
        }
    }

    /// Materialize the trimmed segments as left/center/right group boxes.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        // Stamp the frame so the compositor can identify the strip node and
        // reserve the bottom viewport row for it (docs/components.md
        // "StatusBar — Reserved row"): panels lay out one row shorter and the
        // strip pins to the reserved row, so no panel/scroll region overlaps
        // it. The marker is compositor-consumed (like `z_index` / `wrap`).
        scene.set_prop(parent, "status_bar", PropValue::Bool(true));
        let trimmed = self.trimmed();
        for align in [SegmentAlign::Left, SegmentAlign::Center, SegmentAlign::Right] {
            let segs: Vec<&Segment> = trimmed.iter().filter(|s| s.align == align).collect();
            let owned: Vec<Segment> = segs.into_iter().cloned().collect();
            self.materialize_group(scene, parent, &owned);
        }
    }
}

impl From<StatusBar> for Renderable {
    fn from(bar: StatusBar) -> Self {
        Renderable::StatusBar(bar)
    }
}

/// The display width of `text` in terminal cells (multi-width aware).
fn display_width(text: &str) -> usize {
    text.chars().map(|c| char_width(c) as usize).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderable::Renderable;

    fn seg(text: &str, align: SegmentAlign, priority: u32) -> Segment {
        Segment::new(text, Style::new())
            .align(align)
            .priority(priority)
    }

    #[test]
    fn builders_append_segments() {
        let bar = StatusBar::new(Style::new())
            .left("state", Style::new())
            .center("cwd", Style::new())
            .right("keys", Style::new());
        assert_eq!(bar.segments.len(), 3);
        assert_eq!(bar.segments[0].align, SegmentAlign::Left);
        assert_eq!(bar.segments[1].align, SegmentAlign::Center);
        assert_eq!(bar.segments[2].align, SegmentAlign::Right);
        // "state"(5) + "cwd"(3) + "keys"(4); three groups, no within-group gaps.
        assert_eq!(bar.total_width(&bar.segments), 12);
    }

    #[test]
    fn no_width_keeps_every_segment() {
        let bar = StatusBar::new(Style::new())
            .left("a", Style::new())
            .right("bbbbbbbbbbbbbbbbbbbb", Style::new());
        assert_eq!(bar.trimmed().len(), 2);
    }

    #[test]
    fn trim_drops_lowest_priority_first() {
        let bar = StatusBar::new(Style::new())
            .segment(seg("a", SegmentAlign::Left, 0))
            .segment(seg("bb", SegmentAlign::Left, 1))
            .segment(seg("ccc", SegmentAlign::Right, 2))
            .segment(seg("dddd", SegmentAlign::Right, 3))
            .with_width(8);

        let trimmed = bar.trimmed();
        let texts: Vec<&str> = trimmed.iter().map(|s| s.text.as_str()).collect();
        // Total 10 + 2 within-group gaps = 12 > 8: drop "a" (10) then "bb"
        // (8 fits exactly) -> "ccc" + "dddd" survive.
        assert_eq!(texts, ["ccc", "dddd"]);
    }

    #[test]
    fn trim_ties_break_rightmost_first() {
        let bar = StatusBar::new(Style::new())
            .segment(seg("a", SegmentAlign::Left, 0))
            .segment(seg("b", SegmentAlign::Right, 0))
            .segment(seg("cc", SegmentAlign::Left, 1))
            .with_width(4);

        let trimmed = bar.trimmed();
        let texts: Vec<&str> = trimmed.iter().map(|s| s.text.as_str()).collect();
        // "b" (rightmost of the two priority-0 segments) drops; "a"+"cc" fit.
        assert_eq!(texts, ["a", "cc"]);
    }

    #[test]
    fn trim_never_keeps_an_overflowing_set() {
        let bar = StatusBar::new(Style::new())
            .segment(seg("a", SegmentAlign::Left, 0))
            .segment(seg("b", SegmentAlign::Right, 1))
            .with_width(1);
        // "a" + "b" = 2 > 1 -> drop "a" (priority 0), "b" alone fits (1 <= 1).
        let trimmed = bar.trimmed();
        let texts: Vec<&str> = trimmed.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["b"]);
        assert!(bar.total_width(&trimmed) <= 1);
    }

    #[test]
    fn multi_width_text_counts_two_cells_per_wide_char() {
        // コ is 2 cells; the 1-cell "a" has the lower priority, so a 2-cell
        // row keeps コ alone.
        let bar = StatusBar::new(Style::new())
            .segment(seg("a", SegmentAlign::Right, 0))
            .segment(seg("コ", SegmentAlign::Left, 1))
            .with_width(2);
        let trimmed = bar.trimmed();
        let texts: Vec<&str> = trimmed.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["コ"]);
        // コ + 'a' = 3 > 2; the whole wide glyph is dropped as one unit if
        // its priority loses.
        let bar2 = StatusBar::new(Style::new())
            .segment(seg("a", SegmentAlign::Right, 1))
            .segment(seg("コ", SegmentAlign::Left, 0))
            .with_width(2);
        let trimmed2 = bar2.trimmed();
        let texts2: Vec<&str> = trimmed2.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts2, ["a"]);
    }

    #[test]
    fn empty_strip_materializes_nothing() {
        let bar = StatusBar::new(Style::new());
        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = Renderable::from(bar).materialize(&mut scene, root);
        assert!(scene.children(id).unwrap().is_empty());
    }

    #[test]
    fn materialize_places_left_center_right_groups() {
        let bar = StatusBar::new(Style::new())
            .left("L", Style::new())
            .center("C", Style::new())
            .right("R", Style::new());
        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = Renderable::from(bar).materialize(&mut scene, root);

        let groups = scene.children(id).unwrap().to_vec();
        assert_eq!(groups.len(), 3);
        for g in &groups {
            assert_eq!(
                scene.node(*g).unwrap().props.get("flex_direction"),
                Some(&PropValue::Str("row".to_string()))
            );
            assert_eq!(scene.node(*g).unwrap().props.get("gap"), Some(&PropValue::Int(1)));
        }
        let texts: Vec<&str> = groups
            .iter()
            .map(|g| {
                let t = scene.children(*g).unwrap()[0];
                match scene.prop(t, "text") {
                    Some(PropValue::Str(s)) => s.as_str(),
                    _ => "",
                }
            })
            .collect();
        assert_eq!(texts, ["L", "C", "R"]);
    }

    // --- Paint-path tests (through the compositor) -----------------------

    #[test]
    fn paint_narrow_viewport_drops_low_priority_segments() {
        // Row width 12; total content 13 > 12, so the lowest-priority segment
        // ("ab") is dropped. The survivors lay out with space-between: the
        // left group "cde" (cols 0-2), the right group "fg hijk" pushed to
        // the right edge (f at col 5, h at col 8 — the free cell plus the
        // strip gap sit between the groups).
        let bar = StatusBar::new(Style::new())
            .segment(seg("ab", SegmentAlign::Left, 0))
            .segment(seg("cde", SegmentAlign::Left, 1))
            .segment(seg("fg", SegmentAlign::Right, 2))
            .segment(seg("hijk", SegmentAlign::Right, 3));
        let buffer = crate::compositor::Compositor::new().paint(bar, tern_core::Size::new(12, 1));
        let row: String = (0..12).map(|x| buffer.cell(x, 0).unwrap().ch).collect();

        assert!(row.starts_with("cde"), "row = {row:?}");
        assert_eq!(row.chars().nth(5), Some('f'));
        assert_eq!(row.chars().nth(8), Some('h'));
        assert!(!row.contains('a'), "dropped segment still painted: {row:?}");
    }

    #[test]
    fn paint_pins_left_and_right_segments_to_the_edges() {
        let bar = StatusBar::new(Style::new()).left("L", Style::new()).right("R", Style::new());
        let buffer = crate::compositor::Compositor::new().paint(bar, tern_core::Size::new(20, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, 'L');
        assert_eq!(buffer.cell(19, 0).unwrap().ch, 'R');
    }
}
