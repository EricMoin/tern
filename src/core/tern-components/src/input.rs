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

// The Input component stays in this file; the test module moved to
// input/tests.rs so both land under the line cap.

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
mod tests;
