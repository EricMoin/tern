//! [`Spinner`] — an animated progress indicator: indeterminate frame-cycling
//! glyphs ("working…") or a determinate progress bar.
//!
//! State: a frame index into a glyph set (advanced by [`Spinner::tick`], which
//! the renderer calls on its redraw timer), or a `value`/`max` pair for the
//! determinate bar. The bar paints exactly `ceil(value / max * width)` filled
//! cells (per `docs/components.md`). The component materializes into a scene as
//! a row [`Box`](crate::Box) containing one [`Text`](crate::Text) leaf holding
//! the current glyph or bar string.

use tern_core::scene::{NodeId, Scene};
use tern_core::style::Style;

use crate::renderable::{Box, Renderable};

/// The default indeterminate glyph set (braille spinners).
pub const BRAILLE_FRAMES: [&str; 10] =
    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// The classic ASCII fallback glyph set.
pub const LINE_FRAMES: [&str; 4] = ["|", "/", "-", "\\"];

/// An animated progress indicator.
#[derive(Debug, Clone)]
pub struct Spinner {
    /// The frames cycled by [`Spinner::tick`] when indeterminate.
    pub frames: Vec<&'static str>,
    /// The current frame index (indeterminate).
    pub frame: usize,
    /// Progress mode.
    pub kind: SpinnerKind,
    /// Current determinate progress value.
    pub value: u64,
    /// Maximum determinate progress value.
    pub max: u64,
    /// Optional label painted before a determinate bar.
    pub label: String,
    /// Bar width in cells (determinate).
    pub width: usize,
    /// Style of the glyph/bar text.
    pub style: Style,
    /// Gap between the label and the bar in cells.
    pub gap: usize,
}

/// The two progress modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpinnerKind {
    /// Frame-cycling "working…" glyphs.
    Indeterminate,
    /// A `value`/`max` progress bar.
    Determinate,
}

impl Spinner {
    /// An indeterminate spinner with the braille glyph set.
    pub fn indeterminate() -> Self {
        Self {
            frames: BRAILLE_FRAMES.to_vec(),
            frame: 0,
            kind: SpinnerKind::Indeterminate,
            value: 0,
            max: 0,
            label: String::new(),
            width: 10,
            style: Style::new(),
            gap: 1,
        }
    }

    /// An indeterminate spinner with an explicit glyph set.
    pub fn with_frames(frames: &[&'static str]) -> Self {
        let mut spinner = Self::indeterminate();
        spinner.frames = frames.to_vec();
        spinner
    }

    /// A determinate progress bar with the given `max` (0 means "no progress
    /// known"; the bar stays empty until `value` is set).
    pub fn determinate(max: u64) -> Self {
        Self {
            frames: BRAILLE_FRAMES.to_vec(),
            frame: 0,
            kind: SpinnerKind::Determinate,
            value: 0,
            max,
            label: String::new(),
            width: 10,
            style: Style::new(),
            gap: 1,
        }
    }

    /// Builder: set the determinate bar width in cells.
    pub fn bar_width(mut self, cells: usize) -> Self {
        self.width = cells;
        self
    }

    /// Builder: set the determinate label.
    pub fn label(mut self, text: impl Into<String>) -> Self {
        self.label = text.into();
        self
    }

    /// Builder: set the glyph/bar style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    // --- Interaction state -----------------------------------------------

    /// Advance the frame index (wrapping); a no-op for determinate spinners.
    /// Returns the new frame glyph.
    pub fn tick(&mut self) -> &'static str {
        if self.kind == SpinnerKind::Determinate || self.frames.is_empty() {
            return self.frame_glyph();
        }
        self.frame = (self.frame + 1) % self.frames.len();
        self.frame_glyph()
    }

    /// The current frame glyph (indeterminate).
    pub fn frame_glyph(&self) -> &'static str {
        if self.frames.is_empty() {
            return " ";
        }
        self.frames[self.frame % self.frames.len()]
    }

    /// Set the determinate progress, clamped to `[0, max]`.
    pub fn set_progress(&mut self, value: u64) {
        self.value = value.min(self.max.max(1));
    }

    /// The number of filled bar cells: `ceil(value / max * width)`.
    pub fn filled_cells(&self) -> usize {
        let max = self.max.max(1);
        let value = self.value.min(max);
        let width = self.width;
        if value == 0 {
            return 0;
        }
        ((value as f64 / max as f64) * width as f64).ceil() as usize
    }

    /// The determinate bar: `label` + filled `▓` cells + remaining `░` cells +
    /// a `NN%` suffix. Empty when `value` is 0.
    pub fn bar(&self) -> String {
        let filled = self.filled_cells();
        let width = self.width;
        let mut bar = String::new();
        if !self.label.is_empty() {
            bar.push_str(&self.label);
            bar.push(' ');
        }
        bar.extend(std::iter::repeat_n('▓', filled));
        bar.extend(std::iter::repeat_n('░', width.saturating_sub(filled)));
        let max = self.max.max(1);
        let pct = (self.value.min(max) as f64 / max as f64 * 100.0).round() as u64;
        bar.push(' ');
        bar.push_str(&pct.to_string());
        bar.push('%');
        bar
    }

    // --- Rendering -------------------------------------------------------

    /// The text this spinner paints this frame.
    pub fn render_text(&self) -> String {
        match self.kind {
            SpinnerKind::Indeterminate => self.frame_glyph().to_string(),
            SpinnerKind::Determinate => self.bar(),
        }
    }

    /// The root frame as a bare box (style + layout props, no children).
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.style, vec![]).row().gap(self.gap as i64)
    }

    /// Materialize the current glyph/bar text under `parent`.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        let text = self.render_text();
        scene
            .add_text(parent, &text, self.style)
            .expect("spinner text leaf under its frame");
    }
}

impl From<Spinner> for Renderable {
    fn from(spinner: Spinner) -> Self {
        Renderable::Spinner(spinner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::char_width;
    use tern_core::scene::PropValue;

    use crate::renderable::Renderable;

    #[test]
    fn tick_advances_and_wraps_frames() {
        let mut spinner = Spinner::with_frames(&["a", "b", "c"]);
        assert_eq!(spinner.frame_glyph(), "a");
        assert_eq!(spinner.tick(), "b");
        assert_eq!(spinner.tick(), "c");
        assert_eq!(spinner.tick(), "a"); // wraps
        assert_eq!(spinner.frame, 0);
    }

    #[test]
    fn tick_is_noop_for_determinate() {
        let mut spinner = Spinner::determinate(10);
        spinner.tick();
        assert_eq!(spinner.frame, 0);
        assert_eq!(spinner.render_text(), "░░░░░░░░░░ 0%");
    }

    #[test]
    fn default_braille_frames_are_single_width() {
        // 多宽字符纪律: every default frame glyph must occupy exactly one
        // terminal cell so a spinning indicator never shifts its layout.
        for glyph in BRAILLE_FRAMES {
            let mut chars = glyph.chars();
            let w = chars.next().map(char_width).unwrap_or(0);
            assert_eq!(w, 1, "frame glyph {glyph:?} must be single-width");
            assert!(chars.next().is_none(), "frame glyph {glyph:?} is one char");
        }
        for glyph in LINE_FRAMES {
            assert_eq!(char_width(glyph.chars().next().unwrap()), 1);
        }
    }

    #[test]
    fn determinate_bar_fills_exactly_ceil_proportion() {
        // Acceptance (docs/components.md): the bar paints exactly
        // ceil(value/max * width) filled cells.
        let mut spinner = Spinner::determinate(10).bar_width(10);
        spinner.set_progress(3);
        assert_eq!(spinner.filled_cells(), 3);

        spinner.set_progress(5);
        assert_eq!(spinner.filled_cells(), 5);

        let mut eighths = Spinner::determinate(8).bar_width(10);
        eighths.set_progress(5);
        assert_eq!(eighths.filled_cells(), 7); // ceil(6.25)

        eighths.set_progress(0);
        assert_eq!(eighths.filled_cells(), 0);
        eighths.set_progress(8);
        assert_eq!(eighths.filled_cells(), 10);
    }

    #[test]
    fn determinate_bar_string_layout() {
        let mut spinner = Spinner::determinate(4)
            .bar_width(4)
            .label("copying");
        spinner.set_progress(1);
        assert_eq!(spinner.bar(), "copying ▓░░░ 25%");
        spinner.set_progress(4);
        assert_eq!(spinner.bar(), "copying ▓▓▓▓ 100%");
    }

    #[test]
    fn set_progress_clamps_to_range() {
        let mut spinner = Spinner::determinate(10).bar_width(10);
        spinner.set_progress(100);
        assert_eq!(spinner.value, 10);
        assert_eq!(spinner.filled_cells(), 10);

        let mut zero_max = Spinner::determinate(0).bar_width(5);
        zero_max.set_progress(9); // clamped into [0, 1] (max 0 -> max 1)
        assert_eq!(zero_max.value, 1);
        assert_eq!(zero_max.filled_cells(), 5);
        assert_eq!(zero_max.bar(), "▓▓▓▓▓ 100%");
    }

    #[test]
    fn render_text_switches_on_kind() {
        let mut spinner = Spinner::with_frames(&["⠋", "⠙"]);
        assert_eq!(spinner.render_text(), "⠋");
        spinner.tick();
        assert_eq!(spinner.render_text(), "⠙");

        let mut determinate = Spinner::determinate(10).bar_width(5);
        determinate.set_progress(10);
        assert_eq!(determinate.render_text(), "▓▓▓▓▓ 100%");
    }

    #[test]
    fn materialize_renders_current_frame_and_bar() {
        let spinner = Spinner::with_frames(&["⠋", "⠙"]);
        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = Renderable::from(spinner).materialize(&mut scene, root);
        let text_id = scene.children(id).unwrap()[0];
        assert_eq!(
            scene.prop(text_id, "text"),
            Some(&PropValue::Str("⠋".to_string()))
        );

        let mut bar = Spinner::determinate(2).bar_width(2);
        bar.set_progress(1);
        let mut scene2 = Scene::new();
        let root2 = scene2.root_id();
        let id2 = Renderable::from(bar).materialize(&mut scene2, root2);
        let text2 = scene2.children(id2).unwrap()[0];
        assert_eq!(
            scene2.prop(text2, "text"),
            Some(&PropValue::Str("▓░ 50%".to_string()))
        );
    }

    // --- Paint-path tests (through the compositor) -----------------------

    #[test]
    fn paint_determinate_bar_paints_exact_cells() {
        let mut spinner = Spinner::determinate(4).bar_width(4);
        spinner.set_progress(1);
        let buffer = crate::compositor::Compositor::new().paint(spinner, tern_core::Size::new(8, 1));
        let row: String = (0..8).map(|x| buffer.cell(x, 0).unwrap().ch).collect();
        assert_eq!(row, "▓░░░ 25%");
    }

    #[test]
    fn paint_indeterminate_paints_current_frame() {
        let spinner = Spinner::with_frames(&["⠋", "⠙"]);
        let buffer = crate::compositor::Compositor::new().paint(spinner, tern_core::Size::new(4, 1));
        assert_eq!(buffer.cell(0, 0).unwrap().ch, '⠋');
        assert_eq!(buffer.cell(1, 0).unwrap().ch, ' ');
    }
}
