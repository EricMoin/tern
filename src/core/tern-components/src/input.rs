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

use tern_core::char_width;
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
    /// char, `chars().count()` = after the last).
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
    pub fn insert_char(&mut self, ch: char) {
        self.leave_history();
        let mut chars: Vec<char> = self.value.chars().collect();
        let i = self.cursor.min(chars.len());
        chars.insert(i, ch);
        self.value = chars.into_iter().collect();
        self.cursor = i + 1;
    }

    /// Delete the character before the cursor.
    pub fn delete_backward(&mut self) {
        self.leave_history();
        if self.cursor == 0 {
            return;
        }
        let mut chars: Vec<char> = self.value.chars().collect();
        chars.remove(self.cursor - 1);
        self.value = chars.into_iter().collect();
        self.cursor -= 1;
    }

    /// Delete the character under the cursor.
    pub fn delete_forward(&mut self) {
        self.leave_history();
        let len = self.value.chars().count();
        if self.cursor >= len {
            return;
        }
        let mut chars: Vec<char> = self.value.chars().collect();
        chars.remove(self.cursor);
        self.value = chars.into_iter().collect();
    }

    /// Clear the value and return the cursor to the start.
    pub fn clear(&mut self) {
        self.leave_history();
        self.value.clear();
        self.cursor = 0;
    }

    /// Move the cursor one character left (clamped).
    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    /// Move the cursor one character right (clamped).
    pub fn move_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.value.chars().count());
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
    /// non-whitespace; intervening whitespace is skipped.
    pub fn word_left(&mut self) {
        let chars: Vec<char> = self.value.chars().collect();
        let mut i = self.cursor.min(chars.len());
        while i > 0 && chars[i - 1].is_whitespace() {
            i -= 1;
        }
        while i > 0 && !chars[i - 1].is_whitespace() {
            i -= 1;
        }
        self.cursor = i;
    }

    /// Jump the cursor to just past the end of the next word.
    pub fn word_right(&mut self) {
        let chars: Vec<char> = self.value.chars().collect();
        let len = chars.len();
        let mut i = self.cursor.min(len);
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        while i < len && !chars[i].is_whitespace() {
            i += 1;
        }
        self.cursor = i;
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
    /// the cursor (multi-width aware: a wide char counts 2 columns).
    pub fn display_col(&self) -> usize {
        let byte = self
            .value
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.value.len());
        self.value[..byte]
            .chars()
            .map(|c| char_width(c) as usize)
            .sum()
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
    /// display column within it, after horizontal scrolling.
    pub fn visible_region(&self) -> (String, usize) {
        if self.value.is_empty() {
            return (self.placeholder.clone(), 0);
        }
        let scroll = self.scroll();
        let start_char = char_index_at_col(&self.value, scroll);
        let start_col: usize = self
            .value
            .chars()
            .take(start_char)
            .map(|c| char_width(c) as usize)
            .sum();
        let visible: String = self.value.chars().skip(start_char).collect();
        (visible, self.display_col() - start_col)
    }

    /// The style the visible text paints with: the placeholder style (text
    /// style plus DIM) when the value is empty, else the text style.
    pub fn text_style(&self) -> Style {
        if self.value.is_empty() {
            self.placeholder_style
        } else {
            self.style
        }
    }

    /// The field frame as a bare box (style + layout props, no children).
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.frame_style, vec![])
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

/// The char index of the character whose display-column range contains `col`
/// (the character that starts at or before `col`), so a scroll offset never
/// splits a wide glyph. Returns the char count when `col` is past the end.
fn char_index_at_col(text: &str, col: usize) -> usize {
    let mut cur = 0usize;
    for (i, ch) in text.chars().enumerate() {
        if cur >= col {
            return i;
        }
        cur += char_width(ch) as usize;
    }
    text.chars().count()
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
