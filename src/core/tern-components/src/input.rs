//! [`Input`] — a single-line text-entry field with caret placement, key
//! handling, history navigation, and a placeholder.
//!
//! The component is plain state plus editing operations: `value`, a char-index
//! `cursor`, an optional `placeholder` rendered dimmed when the value is empty,
//! a bounded history ring browsed with up/down, and a `caret_visible` flag the
//! renderer toggles for blinking. It materializes into a tern-core scene as a
//! framed [`Box`](crate::Box) containing one [`Text`](crate::Text) leaf; the
//! leaf carries the text (or placeholder) as its `text` prop and — when the
//! caret is visible — a `caret` prop holding the caret's *display column*, so
//! the compositor can paint the block caret over the cell under the cursor.
//!
//! Key handling is renderer-agnostic: [`Input::handle_key`] maps a small
//! [`Key`] set to edits and returns an optional [`KeyAction`] (submit/cancel),
//! so the app never re-implements cursor movement.

use tern_core::clusters;
use tern_core::scene::{NodeId, PropValue, Scene};
use tern_core::style::{Modifiers, Style};

use crate::renderable::{Box, Renderable};

/// A renderer-agnostic key press fed to [`Input::handle_key`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A printable character.
    Char(char),
    /// Backspace (delete before the cursor).
    Backspace,
    /// Delete (delete under the cursor).
    Delete,
    /// Arrow left.
    Left,
    /// Arrow right.
    Right,
    /// Home.
    Home,
    /// End.
    End,
    /// Arrow up (history back).
    Up,
    /// Arrow down (history forward).
    Down,
    /// Enter.
    Enter,
    /// Escape.
    Escape,
    /// Tab.
    Tab,
}

/// The app-facing outcome of a key press.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyAction {
    /// No action; the input consumed the key.
    #[default]
    None,
    /// The input should submit its current value.
    Submit,
    /// The input should cancel the current edit.
    Cancel,
}

/// A single-line text-entry field.
#[derive(Debug, Clone)]
pub struct Input {
    /// The current text content.
    pub value: String,
    /// Cursor position as a *char index* into `value` (0 = before the first
    /// char, `chars().count()` = after the last). The index is always a
    /// grapheme-cluster boundary: every editing and stepping operation walks
    /// whole clusters (see [`tern_core::clusters`]) and never splits one.
    pub cursor: usize,
    /// Dimmed text shown when `value` is empty.
    pub placeholder: String,
    /// The style of the entered text.
    pub style: Style,
    /// The style of the placeholder text (defaults to the text style plus
    /// [`Modifiers::DIM`]).
    pub placeholder_style: Style,
    /// The style of the field frame (background, border).
    pub frame_style: Style,
    /// Field padding in cells (each side).
    pub padding: u16,
    /// Field border width in cells (each side).
    pub border: u16,
    /// Whether the caret is painted. The renderer toggles this per frame to
    /// implement blinking.
    pub caret_visible: bool,
    /// Text-area width in cells; `None` lets the leaf size to its content.
    /// When set, the content scrolls horizontally so the caret stays visible.
    pub width: Option<usize>,
    /// Display-column offset into `value` at which the visible content starts
    /// (derived from `width` + `cursor`; see [`Input::scroll`]).
    pub scroll: usize,
    /// Bounded history ring (newest at the back).
    history: Vec<String>,
    /// Maximum number of history entries kept.
    pub history_max: usize,
    /// Position in `history` being browsed; `None` means editing the draft.
    history_index: Option<usize>,
    /// The value saved when history browsing started.
    draft: String,
}

impl Input {
    /// An empty input with no placeholder.
    pub fn new() -> Self {
        Self::default()
    }

    /// An input with an initial value and the cursor at the end.
    pub fn with_value(value: impl Into<String>) -> Self {
        let value = value.into();
        let cursor = value.chars().count();
        Self {
            value,
            cursor,
            ..Self::default()
        }
    }

    /// Builder: set the placeholder text.
    pub fn placeholder(mut self, text: impl Into<String>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// Builder: set the entered-text style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Builder: set the field frame style (background, border).
    pub fn frame_style(mut self, style: Style) -> Self {
        self.frame_style = style;
        self
    }

    /// Builder: set the field padding in cells (each side).
    pub fn padding(mut self, cells: u16) -> Self {
        self.padding = cells;
        self
    }

    /// Builder: set the field border width in cells (each side).
    pub fn border(mut self, cells: u16) -> Self {
        self.border = cells;
        self
    }

    /// Builder: hide the caret.
    pub fn hide_caret(mut self) -> Self {
        self.caret_visible = false;
        self
    }

    /// Builder: constrain the text area to `cells` columns (enables horizontal
    /// scroll so the caret stays visible).
    pub fn with_width(mut self, cells: usize) -> Self {
        self.width = Some(cells);
        self
    }

    /// Builder: cap the history ring at `max` entries.
    pub fn history_capacity(mut self, max: usize) -> Self {
        self.history_max = max;
        self
    }

    // --- Editing ---------------------------------------------------------

    /// Insert `ch` at the cursor and advance past it. Exits history browsing.
    ///
    /// The cursor is snapped to the start of the grapheme cluster containing
    /// it first, so the insertion point is always a cluster boundary and a
    /// mid-cluster cursor can never split a cluster.
    pub fn insert_char(&mut self, ch: char) {
        self.leave_history();
        let cursor = clamp_to_boundary(&self.value, self.cursor);
        let mut chars: Vec<char> = self.value.chars().collect();
        let i = cursor.min(chars.len());
        chars.insert(i, ch);
        self.value = chars.into_iter().collect();
        self.cursor = i + 1;
    }

    /// Delete the grapheme cluster before the cursor: the full char range of
    /// the previous cluster (a whole ZWJ emoji, flag, keycap, or combining
    /// sequence is removed in one backspace).
    pub fn delete_backward(&mut self) {
        self.leave_history();
        let cursor = clamp_to_boundary(&self.value, self.cursor);
        if cursor == 0 {
            return;
        }
        let starts = cluster_starts(&self.value);
        let start = starts
            .iter()
            .rev()
            .find(|&&s| s < cursor)
            .copied()
            .unwrap_or(0);
        let mut chars: Vec<char> = self.value.chars().collect();
        chars.drain(start..cursor);
        self.value = chars.into_iter().collect();
        self.cursor = start;
    }

    /// Delete the grapheme cluster under the cursor: its full char range.
    pub fn delete_forward(&mut self) {
        self.leave_history();
        let cursor = clamp_to_boundary(&self.value, self.cursor);
        let starts = cluster_starts(&self.value);
        if let Some(end) = starts.iter().find(|&&s| s > cursor).copied() {
            let mut chars: Vec<char> = self.value.chars().collect();
            chars.drain(cursor..end);
            self.value = chars.into_iter().collect();
        }
    }

    /// Clear the value and return the cursor to the start.
    pub fn clear(&mut self) {
        self.leave_history();
        self.value.clear();
        self.cursor = 0;
    }

    /// Move the cursor one grapheme cluster left: to the previous cluster
    /// boundary (a ZWJ emoji or combining sequence is stepped as one unit).
    pub fn move_left(&mut self) {
        let starts = cluster_starts(&self.value);
        self.cursor = starts
            .iter()
            .rev()
            .find(|&&s| s < self.cursor)
            .copied()
            .unwrap_or(0);
    }

    /// Move the cursor one grapheme cluster right: to the next cluster
    /// boundary (a ZWJ emoji or combining sequence is stepped as one unit).
    pub fn move_right(&mut self) {
        let starts = cluster_starts(&self.value);
        self.cursor = starts
            .iter()
            .find(|&&s| s > self.cursor)
            .copied()
            .unwrap_or_else(|| self.value.chars().count());
    }

    /// Move the cursor to the start of the line.
    pub fn move_home(&mut self) {
        self.cursor = 0;
    }

    /// Move the cursor to the end of the line.
    pub fn move_end(&mut self) {
        self.cursor = self.value.chars().count();
    }

    /// Jump the cursor to the start of the previous word. A word is a run of
    /// non-whitespace clusters; intervening whitespace is skipped. Jumps land
    /// on cluster boundaries — a multi-char cluster is one word unit.
    pub fn word_left(&mut self) {
        let clusters = clusters_with_starts(&self.value);
        let mut k = clusters
            .iter()
            .filter(|(start, _)| *start < self.cursor)
            .count();
        while k > 0 && is_whitespace_cluster(clusters[k - 1].1) {
            k -= 1;
        }
        while k > 0 && !is_whitespace_cluster(clusters[k - 1].1) {
            k -= 1;
        }
        self.cursor = cluster_start_at(&clusters, k, &self.value);
    }

    /// Jump the cursor to just past the end of the next word.
    pub fn word_right(&mut self) {
        let clusters = clusters_with_starts(&self.value);
        let n = clusters.len();
        let mut k = clusters
            .iter()
            .filter(|(start, _)| *start < self.cursor)
            .count();
        while k < n && is_whitespace_cluster(clusters[k].1) {
            k += 1;
        }
        while k < n && !is_whitespace_cluster(clusters[k].1) {
            k += 1;
        }
        self.cursor = cluster_start_at(&clusters, k, &self.value);
    }

    /// Feed one key press: apply the edit and return the app-facing action.
    pub fn handle_key(&mut self, key: Key) -> KeyAction {
        match key {
            Key::Char(c) => {
                self.insert_char(c);
                KeyAction::None
            }
            Key::Backspace => {
                self.delete_backward();
                KeyAction::None
            }
            Key::Delete => {
                self.delete_forward();
                KeyAction::None
            }
            Key::Left => {
                self.move_left();
                KeyAction::None
            }
            Key::Right => {
                self.move_right();
                KeyAction::None
            }
            Key::Home => {
                self.move_home();
                KeyAction::None
            }
            Key::End => {
                self.move_end();
                KeyAction::None
            }
            Key::Up => {
                self.history_up();
                KeyAction::None
            }
            Key::Down => {
                self.history_down();
                KeyAction::None
            }
            Key::Enter => KeyAction::Submit,
            Key::Escape => KeyAction::Cancel,
            Key::Tab => KeyAction::None,
        }
    }

    // --- History ---------------------------------------------------------

    /// Append `entry` to the history ring: empty entries and exact repeats of
    /// the newest entry are ignored; when the ring exceeds
    /// [`history_max`](Self::history_max), the oldest entry is dropped.
    pub fn push_history(&mut self, entry: String) {
        if entry.is_empty() || self.history.last() == Some(&entry) {
            return;
        }
        self.history.push(entry);
        if self.history.len() > self.history_max {
            self.history.remove(0);
        }
    }

    /// Walk one entry back through the history. On the first press the current
    /// value is saved as the draft; at the oldest entry further presses stick.
    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        if self.history_index.is_none() {
            self.draft = self.value.clone();
            self.history_index = Some(self.history.len() - 1);
        } else if let Some(i) = self.history_index {
            if i > 0 {
                self.history_index = Some(i - 1);
            }
        }
        if let Some(i) = self.history_index {
            self.value = self.history[i].clone();
            self.cursor = self.value.chars().count();
        }
    }

    /// Walk one entry forward through the history; past the newest entry the
    /// saved draft is restored.
    pub fn history_down(&mut self) {
        let Some(i) = self.history_index else {
            return;
        };
        if i + 1 < self.history.len() {
            self.history_index = Some(i + 1);
            self.value = self.history[i + 1].clone();
        } else {
            self.history_index = None;
            self.value = self.draft.clone();
        }
        self.cursor = self.value.chars().count();
    }

    /// Abort history browsing and restore the saved draft (the "empty-entry
    /// resets to draft" behavior).
    pub fn history_reset(&mut self) {
        if self.history_index.is_some() {
            self.value = self.draft.clone();
            self.history_index = None;
        }
        self.cursor = self.value.chars().count();
    }

    /// The number of history entries stored.
    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    /// Whether history browsing is active.
    pub fn browsing_history(&self) -> bool {
        self.history_index.is_some()
    }

    fn leave_history(&mut self) {
        self.history_index = None;
    }

    // --- Rendering -------------------------------------------------------

    /// The caret's display column: the terminal-cell width of the text before
    /// the cursor (multi-width aware: a wide char counts 2 columns, and a
    /// multi-char cluster — a ZWJ emoji, a flag, a combining sequence —
    /// counts its [`cluster_width`](tern_core::cluster_width), clamped to 2).
    pub fn display_col(&self) -> usize {
        display_col_at(&self.value, self.cursor)
    }

    /// The display-column offset at which the visible content starts, keeping
    /// the caret inside a `width`-cell text area. 0 when no width is set.
    pub fn scroll(&self) -> usize {
        match self.width {
            None => 0,
            Some(w) => {
                let w = w.max(1);
                let caret = self.display_col();
                if caret < w {
                    0
                } else {
                    caret + 1 - w
                }
            }
        }
    }

    /// The text actually painted (placeholder when empty) and the caret's
    /// display column within it, after horizontal scrolling. The visible
    /// slice always starts on a cluster boundary — a scroll offset never
    /// splits a grapheme cluster.
    pub fn visible_region(&self) -> (String, usize) {
        if self.value.is_empty() {
            return (self.placeholder.clone(), 0);
        }
        let scroll = self.scroll();
        let start_char = char_index_at_col(&self.value, scroll);
        let start_col = display_col_at(&self.value, start_char);
        let visible: String = self.value.chars().skip(start_char).collect();
        (visible, self.display_col() - start_col)
    }

    /// The style the visible text paints with: the placeholder style (text
    /// style plus DIM) when the value is empty, else the text style.
    pub fn text_style(&self) -> Style {
        if self.value.is_empty() {
            self.placeholder_style.clone()
        } else {
            self.style.clone()
        }
    }

    /// The field frame as a bare box (style + layout props, no children).
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.frame_style.clone(), vec![])
            .padding(self.padding as i64)
            .border(self.border as i64)
    }

    /// Materialize the text leaf (with its `caret` prop) under `parent`.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        let (text, caret_col) = self.visible_region();
        let id = scene
            .add_text(parent, &text, self.text_style())
            .expect("input text leaf under its frame");
        if self.caret_visible {
            scene.set_prop(id, "caret", PropValue::Int(caret_col as i64));
        }
        if let Some(w) = self.width {
            scene.set_prop(id, "width", PropValue::Int(w as i64));
        }
    }
}

impl Default for Input {
    fn default() -> Self {
        Self {
            value: String::new(),
            cursor: 0,
            placeholder: String::new(),
            style: Style::new(),
            placeholder_style: Style::new().add_modifier(Modifiers::DIM),
            frame_style: Style::new(),
            padding: 1,
            border: 0,
            caret_visible: true,
            width: None,
            scroll: 0,
            history: Vec::new(),
            history_max: 50,
            history_index: None,
            draft: String::new(),
        }
    }
}

impl From<Input> for Renderable {
    fn from(input: Input) -> Self {
        Renderable::Input(input)
    }
}

/// The char index of the first cluster whose start column is at or past
/// `col` — i.e. the cluster boundary at or after display column `col` — so a
/// scroll offset never splits a grapheme cluster. Returns the char count when
/// `col` is past the end.
fn char_index_at_col(text: &str, col: usize) -> usize {
    let mut cur = 0usize;
    let mut char_idx = 0usize;
    for c in clusters(text) {
        if cur >= col {
            return char_idx;
        }
        cur += c.width as usize;
        char_idx += c.text.chars().count();
    }
    text.chars().count()
}

/// The grapheme clusters of `text` in order, each paired with the char index
/// of its first character. The cluster texts borrow `text`.
fn clusters_with_starts(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::with_capacity(text.chars().count().saturating_add(1));
    let mut char_idx = 0usize;
    for c in clusters(text) {
        out.push((char_idx, c.text));
        char_idx += c.text.chars().count();
    }
    out
}

/// The char indices of every cluster boundary in `text` — each cluster's
/// start plus the total char count — ascending. Every index is a valid
/// insertion point that never splits a grapheme cluster.
fn cluster_starts(text: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = clusters_with_starts(text)
        .iter()
        .map(|(start, _)| *start)
        .collect();
    starts.push(text.chars().count());
    starts
}

/// Snap a char index to the start of the grapheme cluster containing it — a
/// no-op when it already sits on a boundary, so edits never split a cluster.
fn clamp_to_boundary(text: &str, char_idx: usize) -> usize {
    let mut boundary = 0usize;
    for c in clusters(text) {
        let next = boundary + c.text.chars().count();
        if char_idx < next {
            return boundary;
        }
        boundary = next;
    }
    boundary
}

/// The char index of the `k`-th cluster's start, or the total char count
/// when `k` is the cluster count (past the end).
fn cluster_start_at(clusters: &[(usize, &str)], k: usize, text: &str) -> usize {
    clusters
        .get(k)
        .map_or_else(|| text.chars().count(), |(start, _)| *start)
}

/// Whether a cluster counts as whitespace for word stepping: its lead
/// character is whitespace. A cluster is one indivisible unit, so the lead
/// decides for the whole cluster (e.g. a CRLF cluster leads with `\r`).
fn is_whitespace_cluster(cluster: &str) -> bool {
    cluster.chars().next().map_or(false, char::is_whitespace)
}

/// The display column of the cluster boundary at char index `char_idx`: the
/// sum of the [`cluster_width`](tern_core::cluster_width)s before it.
fn display_col_at(text: &str, char_idx: usize) -> usize {
    let byte = text
        .char_indices()
        .nth(char_idx)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    clusters(&text[..byte])
        .map(|c| c.width as usize)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tern_core::scene::NodeKind;
    use tern_core::style::Modifiers;

    #[test]
    fn insert_char_at_cursor_advances() {
        let mut input = Input::with_value("ab");
        input.cursor = 1;
        input.insert_char('X');
        assert_eq!(input.value, "aXb");
        assert_eq!(input.cursor, 2);

        // Multi-width content: コ counts as one char index; inserting at the
        // head lands before it.
        let mut wide = Input::with_value("コ");
        wide.cursor = 0;
        wide.insert_char('x');
        assert_eq!(wide.value, "xコ");
        assert_eq!(wide.cursor, 1);
    }

    #[test]
    fn delete_backward_and_forward() {
        let mut input = Input::with_value("abc");
        input.cursor = 2;
        input.delete_backward();
        assert_eq!(input.value, "ac");
        assert_eq!(input.cursor, 1);

        input.cursor = 1;
        input.delete_forward();
        assert_eq!(input.value, "a");

        // At the boundaries the deletes are no-ops.
        let mut at_start = Input::with_value("x");
        at_start.cursor = 0;
        at_start.delete_backward();
        assert_eq!(at_start.value, "x");
        let mut at_end = Input::with_value("x");
        at_end.cursor = 1;
        at_end.delete_forward();
        assert_eq!(at_end.value, "x");
    }

    #[test]
    fn clear_resets_value_and_cursor() {
        let mut input = Input::with_value("hello");
        input.cursor = 3;
        input.clear();
        assert!(input.value.is_empty());
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn arrow_keys_move_cursor_clamped() {
        let mut input = Input::with_value("abc");
        input.cursor = 0;
        input.move_left(); // clamped at 0
        assert_eq!(input.cursor, 0);
        input.move_right();
        assert_eq!(input.cursor, 1);
        input.move_end();
        assert_eq!(input.cursor, 3);
        input.move_right(); // clamped at 3
        assert_eq!(input.cursor, 3);
        input.move_home();
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn word_jumps_skip_whitespace_and_words() {
        let mut input = Input::with_value("one two three");
        input.move_end();
        input.word_left();
        assert_eq!(input.cursor, 8); // start of "three"
        input.word_left();
        assert_eq!(input.cursor, 4); // start of "two"
        input.word_left();
        assert_eq!(input.cursor, 0); // start of "one"

        input.cursor = 0;
        input.word_right();
        assert_eq!(input.cursor, 3); // just past "one"
        input.word_right();
        assert_eq!(input.cursor, 7); // just past "two"

        // Runs of whitespace are skipped as one step.
        let mut gap = Input::with_value("a   b");
        gap.move_end();
        gap.word_left();
        assert_eq!(gap.cursor, 4); // start of "b", skipping the gap
    }

    #[test]
    fn display_col_is_multi_width_aware() {
        let mut input = Input::with_value("aコb");
        input.cursor = 2; // after コ
        assert_eq!(input.display_col(), 3); // 'a'(1) + コ(2)
        input.cursor = 3;
        assert_eq!(input.display_col(), 4);
    }

    #[test]
    fn cursor_movement_steps_whole_clusters() {
        // A ZWJ family emoji (7 chars) is ONE cluster: left/right step over
        // it in a single move, never per char.
        let mut input = Input::with_value("a👨‍👩‍👧‍👦b");
        input.move_end();
        assert_eq!(input.cursor, 9); // a + 7-char emoji + b
        input.move_left();
        assert_eq!(input.cursor, 8); // before 'b'
        input.move_left();
        assert_eq!(input.cursor, 1); // the whole emoji in one step
        input.move_left();
        assert_eq!(input.cursor, 0);
        input.move_right();
        assert_eq!(input.cursor, 1); // the emoji is one step again
        input.move_right();
        assert_eq!(input.cursor, 8);
        input.move_right();
        assert_eq!(input.cursor, 9);

        // A combining sequence (e + U+0301) is one cluster too.
        let mut comb = Input::with_value("e\u{301}x");
        comb.move_end();
        assert_eq!(comb.cursor, 3);
        comb.move_left();
        assert_eq!(comb.cursor, 2); // whole "é" skipped
        comb.move_left();
        assert_eq!(comb.cursor, 0);
        comb.move_right();
        assert_eq!(comb.cursor, 2); // whole "é" in one step
    }

    #[test]
    fn flag_and_keycap_step_as_single_clusters() {
        // A flag (2 regional indicators) is one cluster: 2 chars, one step.
        let mut flag = Input::with_value("🇷🇺");
        flag.move_end();
        assert_eq!(flag.cursor, 2);
        flag.move_left();
        assert_eq!(flag.cursor, 0); // whole flag stepped as one unit
        flag.move_right();
        assert_eq!(flag.cursor, 2);

        // A keycap ('1' + VS16 + enclosing keycap) is one cluster too.
        let mut keycap = Input::with_value("1️⃣");
        keycap.move_end();
        assert_eq!(keycap.cursor, 3);
        keycap.move_left();
        assert_eq!(keycap.cursor, 0);
        keycap.move_right();
        assert_eq!(keycap.cursor, 3);
    }

    #[test]
    fn backspace_deletes_whole_cluster() {
        let mut family = Input::with_value("a👨‍👩‍👧‍👦b");
        family.move_end();
        family.delete_backward(); // deletes 'b'
        assert_eq!(family.value, "a👨‍👩‍👧‍👦");
        family.delete_backward(); // deletes the whole emoji cluster
        assert_eq!(family.value, "a");
        assert_eq!(family.cursor, 1);

        // A combining sequence is removed whole.
        let mut comb = Input::with_value("e\u{301}x");
        comb.move_end();
        comb.delete_backward(); // deletes 'x'
        assert_eq!(comb.value, "e\u{301}");
        comb.delete_backward(); // deletes the whole combining cluster
        assert_eq!(comb.value, "");
        assert_eq!(comb.cursor, 0);
    }

    #[test]
    fn delete_forward_deletes_whole_cluster() {
        let mut family = Input::with_value("a👨‍👩‍👧‍👦b");
        family.cursor = 1;
        family.delete_forward(); // deletes the whole emoji cluster
        assert_eq!(family.value, "ab");
        assert_eq!(family.cursor, 1);

        let mut comb = Input::with_value("e\u{301}x");
        comb.cursor = 0;
        comb.delete_forward();
        assert_eq!(comb.value, "x");
        assert_eq!(comb.cursor, 0);
    }

    #[test]
    fn display_col_measures_cluster_width_not_char_sum() {
        // A ZWJ family emoji is 7 chars but renders in 2 columns: the caret
        // after it sits at column 2, NOT 14 (7 × char_width 2).
        let mut family = Input::with_value("👨‍👩‍👧‍👦");
        assert_eq!(family.value.chars().count(), 7);
        family.move_end();
        assert_eq!(family.display_col(), 2);
        assert_eq!(family.cursor, 7);

        // 'a' + emoji = 1 + 2 = 3 columns; then 'b' makes 4.
        let mut mixed = Input::with_value("a👨‍👩‍👧‍👦b");
        mixed.cursor = 8; // after the emoji, before 'b'
        assert_eq!(mixed.display_col(), 3);
        mixed.move_end();
        assert_eq!(mixed.display_col(), 4);

        // A flag is 2 columns; a combining sequence is 1 (base + zero-width
        // mark); a keycap is 1 per tern-core's cluster model ('1' + two
        // zero-width modifiers).
        let mut flag = Input::with_value("🇷🇺");
        flag.move_end();
        assert_eq!(flag.display_col(), 2);
        let mut comb = Input::with_value("e\u{301}");
        comb.move_end();
        assert_eq!(comb.display_col(), 1);
        let mut keycap = Input::with_value("1️⃣");
        keycap.move_end();
        assert_eq!(keycap.display_col(), 1);
    }

    #[test]
    fn word_jumps_respect_cluster_boundaries() {
        // "hey 👨👩👧👦 you": the ZWJ emoji is a whole word unit — word
        // jumps land on its boundaries, never inside it.
        let mut input = Input::with_value("hey 👨‍👩‍👧‍👦 you");
        input.move_end();
        input.word_left();
        assert_eq!(input.cursor, 12); // start of "you"
        input.word_left();
        assert_eq!(input.cursor, 4); // start of the emoji, not inside it
        input.word_left();
        assert_eq!(input.cursor, 0); // start of "hey"
        input.word_right();
        assert_eq!(input.cursor, 3); // just past "hey"
        input.word_right();
        assert_eq!(input.cursor, 11); // just past the emoji — skipped whole
        input.word_right();
        assert_eq!(input.cursor, 15); // just past "you" = end
    }

    #[test]
    fn insert_never_lands_inside_a_cluster() {
        // A cursor parked mid-cluster snaps to the cluster start: the emoji
        // is never split, the char lands before it.
        let mut input = Input::with_value("a👨‍👩‍👧‍👦b");
        input.cursor = 4; // inside the emoji (its 3rd char)
        input.insert_char('X');
        assert_eq!(input.value, "aX👨‍👩‍👧‍👦b");
        assert_eq!(input.cursor, 2);

        // A mid-combining-sequence cursor snaps the same way.
        let mut comb = Input::with_value("e\u{301}");
        comb.cursor = 1; // between 'e' and the combining mark
        comb.insert_char('x');
        assert_eq!(comb.value, "xe\u{301}");
        assert_eq!(comb.cursor, 1);
    }

    #[test]
    fn handle_key_maps_edits_and_actions() {
        let mut input = Input::new();
        assert_eq!(input.handle_key(Key::Char('h')), KeyAction::None);
        assert_eq!(input.handle_key(Key::Char('i')), KeyAction::None);
        assert_eq!(input.value, "hi");
        assert_eq!(input.cursor, 2);

        input.handle_key(Key::Left);
        input.handle_key(Key::Backspace);
        assert_eq!(input.value, "i");
        assert_eq!(input.cursor, 0);

        input.handle_key(Key::End);
        input.handle_key(Key::Delete); // no-op at end
        assert_eq!(input.value, "i");

        assert_eq!(input.handle_key(Key::Enter), KeyAction::Submit);
        assert_eq!(input.handle_key(Key::Escape), KeyAction::Cancel);
        assert_eq!(input.handle_key(Key::Tab), KeyAction::None);
        assert_eq!(input.handle_key(Key::Up), KeyAction::None);
    }

    #[test]
    fn history_browsing_saves_draft_and_restores() {
        let mut input = Input::with_value("draft").history_capacity(10);
        input.push_history("first".to_string());
        input.push_history("second".to_string());

        input.value = "in-progress".to_string();
        input.cursor = 11;
        input.history_up();
        assert_eq!(input.value, "second");
        assert!(input.browsing_history());
        input.history_up();
        assert_eq!(input.value, "first");
        input.history_up(); // sticks at the oldest
        assert_eq!(input.value, "first");

        input.history_down();
        assert_eq!(input.value, "second");
        input.history_down();
        assert_eq!(input.value, "in-progress"); // draft restored
        assert!(!input.browsing_history());
    }

    #[test]
    fn history_ring_is_bounded_and_dedupes() {
        let mut input = Input::new().history_capacity(3);
        input.push_history("a".to_string());
        input.push_history("b".to_string());
        input.push_history("a".to_string()); // not adjacent dup of "b" -> kept
        assert_eq!(input.history_len(), 3);
        input.push_history("a".to_string()); // exact repeat of newest -> ignored
        assert_eq!(input.history_len(), 3);
        input.push_history("c".to_string()); // ring full -> oldest ("a") drops
        assert_eq!(input.history_len(), 3);

        input.history_up();
        assert_eq!(input.value, "c");
        input.history_up();
        assert_eq!(input.value, "a");
        input.history_up();
        assert_eq!(input.value, "b"); // the oldest kept entry
    }

    #[test]
    fn history_reset_restores_draft() {
        let mut input = Input::with_value("draft");
        input.push_history("entry".to_string());
        input.value = "edited".to_string();
        input.cursor = 6;
        input.history_up(); // draft is saved as "edited"
        assert_eq!(input.value, "entry");
        assert!(input.browsing_history());
        input.history_reset();
        assert_eq!(input.value, "edited"); // the draft, not the pre-edit value
        assert!(!input.browsing_history());
    }

    #[test]
    fn editing_exits_history_browsing() {
        let mut input = Input::with_value("draft");
        input.push_history("entry".to_string());
        input.history_up();
        assert!(input.browsing_history());
        input.insert_char('x');
        assert!(!input.browsing_history());
        assert_eq!(input.value, "entryx");
    }

    #[test]
    fn placeholder_shows_when_empty_and_style_dims() {
        let input = Input::new().placeholder("ask");
        assert_eq!(input.visible_region().0, "ask");
        assert!(input.text_style().modifiers.contains(Modifiers::DIM));

        let filled = Input::with_value("hi");
        assert_eq!(filled.visible_region().0, "hi");
        assert!(!filled.text_style().modifiers.contains(Modifiers::DIM));
    }

    #[test]
    fn caret_sits_at_display_column() {
        let input = Input::with_value("ab");
        assert_eq!(input.visible_region(), ("ab".to_string(), 2));

        let mut wide = Input::with_value("コx");
        wide.cursor = 1;
        assert_eq!(wide.visible_region(), ("コx".to_string(), 2));
    }

    #[test]
    fn narrow_field_scrolls_to_keep_caret_visible() {
        let mut input = Input::with_value("hello").with_width(3);
        input.move_end(); // caret at display col 5
        assert_eq!(input.scroll(), 3);
        assert_eq!(input.visible_region(), ("lo".to_string(), 2));

        // The scroll boundary never splits a wide glyph: the visible slice
        // always starts at a char boundary. caret at col 6 in "abコde" (cols
        // a=0 b=1 コ=2-3 d=4 e=5) with a 3-wide area scrolls to col 4, which
        // lands on 'd' — コ is scrolled fully out of view, not truncated.
        let mut wide = Input::with_value("abコde").with_width(3);
        wide.cursor = 5; // display col 6 -> scroll = 6 + 1 - 3 = 4 ('d')
        assert_eq!(wide.visible_region(), ("de".to_string(), 2));
    }

    #[test]
    fn narrow_field_scroll_never_splits_a_cluster() {
        // "ab👨👩👧👦c" (cols a=0 b=1 emoji=2-3 c=4) in a 3-wide area with
        // the caret at the end: scroll = 5 + 1 - 3 = 3, which lands INSIDE
        // the emoji's column range. The emoji is scrolled fully out of view
        // — never split — and the visible slice starts at 'c'.
        let mut input = Input::with_value("ab👨‍👩‍👧‍👦c").with_width(3);
        input.move_end();
        assert_eq!(input.display_col(), 5);
        assert_eq!(input.scroll(), 3);
        assert_eq!(input.visible_region(), ("c".to_string(), 1));
    }

    #[test]
    fn materialize_stamps_text_and_caret_props() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let input = Input::with_value("ab");
        let id: NodeId = Renderable::from(input).materialize(&mut scene, root);

        assert_eq!(scene.node(id).unwrap().kind, NodeKind::Box);
        assert_eq!(
            scene.node(id).unwrap().props.get("padding"),
            Some(&PropValue::Int(1))
        );
        let text_id = scene.children(id).unwrap()[0];
        assert_eq!(
            scene.prop(text_id, "text"),
            Some(&PropValue::Str("ab".to_string()))
        );
        assert_eq!(scene.prop(text_id, "caret"), Some(&PropValue::Int(2)));

        // Hidden caret -> no caret prop at all.
        let hidden = Input::with_value("ab").hide_caret();
        let mut scene2 = Scene::new();
        let root2 = scene2.root_id();
        let id2 = Renderable::from(hidden).materialize(&mut scene2, root2);
        let text2 = scene2.children(id2).unwrap()[0];
        assert!(scene2.prop(text2, "caret").is_none());
    }

    #[test]
    fn materialize_sets_width_prop_when_constrained() {
        let input = Input::with_value("hello").with_width(3);
        let mut scene = Scene::new();
        let root = scene.root_id();
        let id = Renderable::from(input).materialize(&mut scene, root);
        let text_id = scene.children(id).unwrap()[0];
        assert_eq!(scene.prop(text_id, "width"), Some(&PropValue::Int(3)));
        assert_eq!(
            scene.prop(text_id, "text"),
            Some(&PropValue::Str("lo".to_string()))
        );
    }

    // --- Paint-path tests (through the compositor) -----------------------

    #[test]
    fn paint_renders_value_with_reversed_block_caret() {
        // A root Input fills the viewport with its 1-cell padding frame; the
        // text leaf lands at (1,1), and the caret (display col 2) paints the
        // reversed block caret over the cell at (3,1).
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(Input::with_value("ab"), tern_core::Size::new(6, 3));
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'b');
        let caret = buffer.cell(3, 1).unwrap();
        assert_eq!(caret.ch, ' ');
        assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
        // Neighbors are untouched.
        assert!(!buffer
            .cell(2, 1)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
        assert!(!buffer
            .cell(4, 1)
            .unwrap()
            .style
            .modifiers
            .contains(Modifiers::REVERSED));
    }

    #[test]
    fn paint_renders_dimmed_placeholder_with_caret_at_head() {
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(Input::new().placeholder("ask"), tern_core::Size::new(6, 3));
        let c = buffer.cell(1, 1).unwrap();
        assert_eq!(c.ch, 'a');
        assert!(c.style.modifiers.contains(Modifiers::DIM));
        assert!(c.style.modifiers.contains(Modifiers::REVERSED));
        // The rest of the placeholder stays dimmed but not reversed.
        let second = buffer.cell(2, 1).unwrap();
        assert_eq!(second.ch, 's');
        assert!(second.style.modifiers.contains(Modifiers::DIM));
        assert!(!second.style.modifiers.contains(Modifiers::REVERSED));
    }

    #[test]
    fn paint_with_hidden_caret_paints_no_block() {
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(
            Input::with_value("ab").hide_caret(),
            tern_core::Size::new(6, 3),
        );
        for x in 0..6 {
            let c = buffer.cell(x, 1).unwrap();
            assert!(!c.style.modifiers.contains(Modifiers::REVERSED));
        }
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
    }

    #[test]
    fn paint_narrow_field_scrolls_content_and_caret() {
        // A root input in a 6-wide viewport has a 4-cell text area; with the
        // caret at the end of "hello" the content scrolls left so the caret
        // stays visible: "llo" paints with the caret after the last 'o'.
        let mut input = Input::with_value("hello");
        input.move_end();
        let mut compositor = crate::compositor::Compositor::new();
        let buffer = compositor.paint(input, tern_core::Size::new(6, 3));
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'l');
        assert_eq!(buffer.cell(3, 1).unwrap().ch, 'o');
        let caret = buffer.cell(4, 1).unwrap();
        assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
    }
}
