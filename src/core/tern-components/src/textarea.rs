//! [`Textarea`] — a multi-line text-entry field with soft-wrapped display
//! lines, caret placement, and key handling.
//!
//! The component is plain state plus editing operations: `lines` (the logical
//! lines of text), a char-index `row`/`col` cursor, and a `caret_visible`
//! flag the renderer toggles for blinking. It mirrors [`Input`](crate::Input)
//! in spirit — same builder shape, same renderer-agnostic
//! [`Key`](crate::Key) / [`KeyAction`](crate::KeyAction) mapping — but the
//! edit model is multi-line: Enter splits the line, backspace/delete join
//! adjacent lines at the boundaries, and up/down navigate across the
//! *soft-wrapped display lines* (a logical line that wraps into several
//! display rows at the field width is crossed row by row, preserving a
//! preferred display column).
//!
//! Soft wrap is the component's own math ([`wrap_line`]): a logical line is
//! broken into display lines of at most `width` columns using the same
//! token-aware greedy wrap the compositor uses for streaming text — a
//! whitespace-free token that does not fit wraps whole to the next display
//! line, a token wider than the width hard-breaks. With no `width` set, each
//! logical line is one display line. The caret is tracked as a display row +
//! column so painting can stamp a `caret` prop on the exact text leaf that
//! holds it.
//!
//! Scrolling is vertical only: `height` sets the visible window in display
//! rows and `scroll_to_caret` keeps the caret's display row inside it (rows
//! are materialized lazily — only the visible window is painted, so no clip
//! region is needed). It materializes into a tern-core scene as a framed
//! column [`Box`](crate::Box) whose children are one [`Text`](crate::Text)
//! leaf per visible display line; the leaf carrying the caret gets the
//! `caret` Int prop (its display column within that display line) that the
//! compositor paints as a block caret.
//!
//! Scope lock (subtask 3): the edit model only — insert/delete/navigation/
//! split. No clipboard, IME composition, or selection.

use tern_core::scene::{NodeId, PropValue, Scene};
use tern_core::style::Style;
use tern_core::char_width;

use crate::input::{Key, KeyAction};
use crate::renderable::{Box, Renderable};

/// A multi-line text-entry field.
#[derive(Debug, Clone)]
pub struct Textarea {
    /// The logical lines of text (no embedded `\n`; split with Enter).
    pub lines: Vec<String>,
    /// Cursor row: the index into [`lines`](Self::lines).
    pub row: usize,
    /// Cursor column: a *char index* into `lines[row]` (0 = before the first
    /// char, `chars().count()` = after the last).
    pub col: usize,
    /// The style of the entered text.
    pub style: Style,
    /// The style of the field frame (background, border).
    pub frame_style: Style,
    /// Field padding in cells (each side).
    pub padding: u16,
    /// Field border width in cells (each side).
    pub border: u16,
    /// Whether the caret is painted. The renderer toggles this per frame to
    /// implement blinking.
    pub caret_visible: bool,
    /// The soft-wrap width in cells; `None` keeps each logical line on one
    /// display line (no wrapping). When set, long lines wrap into multiple
    /// display rows at this width.
    pub width: Option<usize>,
    /// The visible window in display rows; `None` shows every display line.
    /// When set, only the `scroll..scroll+height` window is materialized and
    /// [`scroll_to_caret`](Self::scroll_to_caret) keeps the caret visible.
    pub height: Option<usize>,
    /// The display-row offset of the top visible row (vertical scroll).
    pub scroll: usize,
    /// The display column preserved across consecutive up/down moves.
    preferred_col: usize,
    /// Whether the previous operation was a vertical (up/down) move, so the
    /// preferred column is only (re)captured on the first move of a run.
    vertical_sticky: bool,
}

impl Textarea {
    /// An empty textarea with a single blank line.
    pub fn new() -> Self {
        Self::default()
    }

    /// A textarea holding `value`, split into logical lines on `\n`, with the
    /// cursor at the end of the last line.
    pub fn with_value(value: impl Into<String>) -> Self {
        let lines: Vec<String> = value.into().split('\n').map(|s| s.to_string()).collect();
        Self::with_lines(lines)
    }

    /// A textarea holding the given logical lines, with the cursor at the end
    /// of the last line.
    pub fn with_lines(lines: Vec<String>) -> Self {
        let row = lines.len().saturating_sub(1);
        let col = lines.get(row).map(|l| l.chars().count()).unwrap_or(0);
        Self {
            lines,
            row,
            col,
            ..Self::default()
        }
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

    /// Builder: constrain the text area to `cells` columns and soft-wrap long
    /// lines at that width.
    pub fn with_width(mut self, cells: usize) -> Self {
        self.width = Some(cells);
        self
    }

    /// Builder: limit the visible window to `rows` display lines (enables
    /// vertical scroll so the caret stays visible).
    pub fn with_height(mut self, rows: usize) -> Self {
        self.height = Some(rows);
        self
    }

    // --- Editing ---------------------------------------------------------

    /// Insert `ch` at the cursor on the current line and advance past it.
    pub fn insert_char(&mut self, ch: char) {
        self.vertical_sticky = false;
        let line = &mut self.lines[self.row];
        let mut chars: Vec<char> = line.chars().collect();
        let i = self.col.min(chars.len());
        chars.insert(i, ch);
        *line = chars.into_iter().collect();
        self.col = i + 1;
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Delete the character before the cursor; at the start of a line, join
    /// the line into the previous one (cursor at the join).
    pub fn delete_backward(&mut self) {
        self.vertical_sticky = false;
        if self.col > 0 {
            let line = &mut self.lines[self.row];
            let mut chars: Vec<char> = line.chars().collect();
            chars.remove(self.col - 1);
            *line = chars.into_iter().collect();
            self.col -= 1;
        } else if self.row > 0 {
            // Join into the previous line: the cursor lands at the join
            // point (the previous line's end, before the appended tail).
            let prev_len = self.lines[self.row - 1].chars().count();
            let tail = self.lines.remove(self.row);
            self.row -= 1;
            self.lines[self.row].push_str(&tail);
            self.col = prev_len;
        } else {
            self.preferred_col = self.current_display_col();
            return;
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Delete the character under the cursor; at the end of a line, join the
    /// next line into this one.
    pub fn delete_forward(&mut self) {
        self.vertical_sticky = false;
        let line_len = self.lines[self.row].chars().count();
        if self.col < line_len {
            let line = &mut self.lines[self.row];
            let mut chars: Vec<char> = line.chars().collect();
            chars.remove(self.col);
            *line = chars.into_iter().collect();
        } else if self.row + 1 < self.lines.len() {
            let tail = self.lines.remove(self.row + 1);
            self.lines[self.row].push_str(&tail);
        } else {
            self.preferred_col = self.current_display_col();
            return;
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Split the current line at the cursor (Enter): the tail becomes a new
    /// line below it and the cursor moves to the start of the new line.
    pub fn split_line(&mut self) {
        self.vertical_sticky = false;
        let line = &self.lines[self.row];
        let mut chars: Vec<char> = line.chars().collect();
        let i = self.col.min(chars.len());
        let tail: String = chars.split_off(i).into_iter().collect();
        self.lines[self.row] = chars.into_iter().collect();
        self.row += 1;
        self.lines.insert(self.row, tail);
        self.col = 0;
        self.preferred_col = 0;
        self.scroll_to_caret();
    }

    /// Clear every line and return the cursor to the start.
    pub fn clear(&mut self) {
        self.vertical_sticky = false;
        self.lines = vec![String::new()];
        self.row = 0;
        self.col = 0;
        self.preferred_col = 0;
        self.scroll = 0;
    }

    // --- Navigation ------------------------------------------------------

    /// Move the cursor one character left; at the start of a line, jump to
    /// the end of the previous line.
    pub fn move_left(&mut self) {
        self.vertical_sticky = false;
        if self.col > 0 {
            self.col -= 1;
        } else if self.row > 0 {
            self.row -= 1;
            self.col = self.lines[self.row].chars().count();
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Move the cursor one character right; at the end of a line, jump to the
    /// start of the next line.
    pub fn move_right(&mut self) {
        self.vertical_sticky = false;
        let line_len = self.lines[self.row].chars().count();
        if self.col < line_len {
            self.col += 1;
        } else if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = 0;
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Move the cursor to the start of the current line.
    pub fn move_home(&mut self) {
        self.vertical_sticky = false;
        self.col = 0;
        self.preferred_col = 0;
        self.scroll_to_caret();
    }

    /// Move the cursor to the end of the current line.
    pub fn move_end(&mut self) {
        self.vertical_sticky = false;
        self.col = self.lines[self.row].chars().count();
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Move the cursor one *display line* up: within a soft-wrapped logical
    /// line this moves to the display line above (the wrap point); at the
    /// top display line of a logical line it moves to the last display line
    /// of the previous logical line. The display column from the first
    /// vertical move of a run is preserved (clamped to each target line).
    pub fn move_up(&mut self) {
        let display_row = self.caret_display_row();
        if display_row == 0 {
            return;
        }
        if !self.vertical_sticky {
            self.preferred_col = self.current_display_col();
            self.vertical_sticky = true;
        }
        self.move_to_display_row(display_row - 1);
        self.scroll_to_caret();
    }

    /// Move the cursor one *display line* down (the mirror of
    /// [`move_up`](Self::move_up)); at the bottom display line it sticks.
    pub fn move_down(&mut self) {
        let display_row = self.caret_display_row();
        if display_row + 1 >= self.total_display_rows() {
            return;
        }
        if !self.vertical_sticky {
            self.preferred_col = self.current_display_col();
            self.vertical_sticky = true;
        }
        self.move_to_display_row(display_row + 1);
        self.scroll_to_caret();
    }

    /// Feed one key press: apply the edit and return the app-facing action.
    /// Enter splits the line (an edit, so the action is `None` — unlike
    /// [`Input`](crate::Input), which submits); Escape cancels.
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
            Key::Up => {
                self.move_up();
                KeyAction::None
            }
            Key::Down => {
                self.move_down();
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
            Key::Enter => {
                self.split_line();
                KeyAction::None
            }
            Key::Escape => KeyAction::Cancel,
            Key::Tab => KeyAction::None,
        }
    }

    // --- Wrap + display-line model ---------------------------------------

    /// The whole text joined by `\n` (what the textarea holds).
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    /// The number of display lines `lines[row]` occupies at the wrap width
    /// (1 when no width is set).
    fn wrap_count(&self, row: usize) -> usize {
        match self.width {
            None => 1,
            Some(w) => wrap_line(&self.lines[row], w).len(),
        }
    }

    /// The display row where logical line `row` begins.
    fn display_base(&self, row: usize) -> usize {
        (0..row).map(|r| self.wrap_count(r)).sum()
    }

    /// The total number of display lines across all logical lines.
    fn total_display_rows(&self) -> usize {
        match self.width {
            None => self.lines.len(),
            Some(w) => self.lines.iter().map(|l| wrap_line(l, w).len()).sum(),
        }
    }

    /// The wrapped display lines of `lines[row]` plus the char index (within
    /// the logical line) where each display line starts.
    fn wrapped_with_offsets(&self, row: usize) -> Vec<(String, usize)> {
        match self.width {
            None => vec![(self.lines[row].clone(), 0)],
            Some(w) => wrap_line_with_offsets(&self.lines[row], w),
        }
    }

    /// The wrapped display lines of `lines[row]` (text only).
    #[cfg(test)]
    fn wrapped(&self, row: usize) -> Vec<String> {
        self.wrapped_with_offsets(row).into_iter().map(|(s, _)| s).collect()
    }

    /// The display-line offset (within `lines[row]`'s wrapped lines) that
    /// contains char index `col`. A char dropped by the wrap (e.g. a trailing
    /// space at a full row) maps to the display line it trails.
    fn offset_of_col(&self, row: usize, col: usize) -> usize {
        let wrapped = self.wrapped_with_offsets(row);
        for (i, (dl, start)) in wrapped.iter().enumerate() {
            if col <= start + dl.chars().count() {
                return i;
            }
        }
        wrapped.len().saturating_sub(1)
    }

    /// The caret's display row across the whole wrapped text.
    fn caret_display_row(&self) -> usize {
        self.display_base(self.row) + self.offset_of_col(self.row, self.col)
    }

    /// The caret's display column within the display line at `offset` of
    /// `row`, and the char index where that display line starts (within the
    /// logical line).
    fn caret_display_in(&self, row: usize, offset: usize) -> (usize, usize) {
        let wrapped = self.wrapped_with_offsets(row);
        let (dl, start) = wrapped.get(offset).cloned().unwrap_or_default();
        let local = self.col.saturating_sub(start).min(dl.chars().count());
        let col: usize = dl
            .chars()
            .take(local)
            .map(|c| char_width(c) as usize)
            .sum();
        (col, start)
    }

    /// The caret's display column within its own display line.
    fn current_display_col(&self) -> usize {
        let offset = self.offset_of_col(self.row, self.col);
        self.caret_display_in(self.row, offset).0
    }

    /// The `(logical row, display-line offset)` for display row `target`.
    /// Defensive past-the-end fallback: the last display line of the last
    /// logical line.
    fn logical_at_display_row(&self, target: usize) -> (usize, usize) {
        let mut acc = 0usize;
        for (r, _) in self.lines.iter().enumerate() {
            let n = self.wrap_count(r);
            if target < acc + n {
                return (r, target - acc);
            }
            acc += n;
        }
        let last = self.lines.len().saturating_sub(1);
        (last, self.wrap_count(last).saturating_sub(1))
    }

    /// The char index into `lines[row]` at display column `target_col` within
    /// display line `offset` (the display line's start offset plus the local
    /// char boundary nearest `target_col`, clamped to the display line's end;
    /// a column inside a wide glyph snaps to that glyph's start).
    fn char_at_display_col(&self, row: usize, offset: usize, target_col: usize) -> usize {
        let wrapped = self.wrapped_with_offsets(row);
        let (dl, start) = wrapped.get(offset).cloned().unwrap_or_default();
        let mut col = 0usize;
        let mut local = 0usize;
        for ch in dl.chars() {
            let w = char_width(ch) as usize;
            if col + w > target_col {
                break;
            }
            col += w;
            local += 1;
        }
        start + local
    }

    /// Move the cursor to display row `target` (must be `< total`), keeping
    /// the preferred display column (clamped to the target display line).
    fn move_to_display_row(&mut self, target: usize) {
        let (row, offset) = self.logical_at_display_row(target);
        self.row = row;
        self.col = self.char_at_display_col(row, offset, self.preferred_col);
    }

    // --- Scrolling -------------------------------------------------------

    /// The scroll offset that keeps the caret's display row inside the
    /// visible window (a pure function of the current state): no-op with no
    /// height set; otherwise scrolls down when the caret is below the window
    /// and up when above.
    fn visible_scroll(&self) -> usize {
        let Some(h) = self.height else {
            return 0;
        };
        let h = h.max(1);
        let caret = self.caret_display_row();
        if caret < self.scroll {
            caret
        } else if caret >= self.scroll + h {
            caret + 1 - h
        } else {
            self.scroll
        }
    }

    /// Adjust [`scroll`](Self::scroll) so the caret stays visible (see
    /// [`visible_scroll`](Self::visible_scroll)).
    pub fn scroll_to_caret(&mut self) {
        self.scroll = self.visible_scroll();
    }

    // --- Rendering -------------------------------------------------------

    /// The field frame as a bare column box (style + layout props, no
    /// children). The frame carries no size props — as a tree root the
    /// compositor sizes it to the viewport (see
    /// [`Compositor::paint`](crate::Compositor::paint)).
    pub(crate) fn frame(&self) -> Box {
        Box::new(self.frame_style, vec![])
            .padding(self.padding as i64)
            .border(self.border as i64)
            .column()
    }

    /// Materialize the visible display-line window as one [`Text`] leaf per
    /// display row under `parent`. The leaf holding the caret carries the
    /// `caret` Int prop (its display column within that display line). Only
    /// the `scroll..scroll+height` window is materialized (all rows when no
    /// height is set), so no clip region is needed.
    pub(crate) fn materialize_content(&self, scene: &mut Scene, parent: NodeId) {
        let scroll = self.visible_scroll();
        let caret_row = self.caret_display_row();
        let total = self.total_display_rows();
        let height = self.height.unwrap_or(usize::MAX).max(1);
        let first = scroll.min(total);
        let last = (scroll + height).min(total);
        for display_row in first..last {
            let (row, offset) = self.logical_at_display_row(display_row);
            let (text, _) = self
                .wrapped_with_offsets(row)
                .get(offset)
                .cloned()
                .unwrap_or_default();
            let id = scene
                .add_text(parent, &text, self.style)
                .expect("textarea line leaf under its frame");
            if self.caret_visible && display_row == caret_row {
                let (caret_col, _) = self.caret_display_in(row, offset);
                scene.set_prop(id, "caret", PropValue::Int(caret_col as i64));
            }
            if let Some(w) = self.width {
                scene.set_prop(id, "width", PropValue::Int(w as i64));
            }
        }
    }
}

impl Default for Textarea {
    fn default() -> Self {
        Self {
            lines: vec![String::new()],
            row: 0,
            col: 0,
            style: Style::new(),
            frame_style: Style::new(),
            padding: 1,
            border: 0,
            caret_visible: true,
            width: None,
            height: None,
            scroll: 0,
            preferred_col: 0,
            vertical_sticky: false,
        }
    }
}

impl From<Textarea> for Renderable {
    fn from(textarea: Textarea) -> Self {
        Renderable::Textarea(textarea)
    }
}

/// The display lines of `line` when soft-wrapped at `width` columns (at
/// least 1).
///
/// Wrapping is greedy and token-aware, mirroring the compositor's
/// streaming-text wrap ([`paint_word`](crate::Compositor)): a whitespace-free
/// token that does not fit on the current display line wraps whole to the
/// next when it can fit there; a token wider than the whole width is
/// hard-broken across display lines, and a single glyph wider than the width
/// is dropped. A trailing space at a full display line is dropped (the wrap
/// would collapse it anyway), and an embedded `\n` ends the display line
/// (defensive — textarea lines normally carry none). A wide glyph is never
/// split.
pub fn wrap_line(line: &str, width: usize) -> Vec<String> {
    wrap_line_with_offsets(line, width)
        .into_iter()
        .map(|(text, _)| text)
        .collect()
}

/// [`wrap_line`] plus the char index (within `line`) where each display line
/// starts. The offsets are exact — a character dropped by the wrap (e.g. a
/// trailing space at a full row) belongs to no display line, so a display
/// line's start is its real position in the logical line, which keeps caret
/// row/col navigation consistent with what is painted.
fn wrap_line_with_offsets(line: &str, width: usize) -> Vec<(String, usize)> {
    let width = width.max(1);
    let mut rows: Vec<(String, usize)> = Vec::new();
    let mut row = String::new();
    let mut row_width = 0usize;
    let mut row_start = 0usize;
    let mut token = String::new();
    let mut token_start = 0usize;

    // The char index (within `line`) of the next char to process.
    let mut idx = 0usize;
    for ch in line.chars() {
        match ch {
            // Hard break: flush the pending token, then start a new row.
            '\n' => {
                flush_token(
                    &mut rows,
                    &mut row,
                    &mut row_width,
                    &mut row_start,
                    &token,
                    token_start,
                    width,
                );
                token.clear();
                rows.push((std::mem::take(&mut row), row_start));
                row_width = 0;
                row_start = idx + 1;
            }
            // Soft break: flush the pending token, then place the space only
            // when it fits — a trailing space at a full row is dropped (the
            // wrap would collapse it anyway).
            ' ' => {
                flush_token(
                    &mut rows,
                    &mut row,
                    &mut row_width,
                    &mut row_start,
                    &token,
                    token_start,
                    width,
                );
                token.clear();
                if row_width + 1 <= width {
                    row.push(' ');
                    row_width += 1;
                }
            }
            _ => {
                if token.is_empty() {
                    token_start = idx;
                }
                token.push(ch);
            }
        }
        idx += 1;
    }
    flush_token(
        &mut rows,
        &mut row,
        &mut row_width,
        &mut row_start,
        &token,
        token_start,
        width,
    );
    rows.push((std::mem::take(&mut row), row_start));
    if rows.is_empty() {
        rows.push((String::new(), 0));
    }
    rows
}

/// Place a pending whitespace-free token onto the current display line,
/// mirroring the compositor's `paint_word`: the token wraps whole to a fresh
/// row when it does not fit the current row and can fit a fresh one; a token
/// wider than the whole width hard-breaks across rows (never splitting a wide
/// glyph), and a single glyph wider than the width is dropped. Row starts
/// track the wrap exactly (a dropped glyph advances the next row's start).
fn flush_token(
    rows: &mut Vec<(String, usize)>,
    row: &mut String,
    row_width: &mut usize,
    row_start: &mut usize,
    token: &str,
    token_start: usize,
    width: usize,
) {
    if token.is_empty() {
        return;
    }
    let token_width: usize = token.chars().map(|c| char_width(c) as usize).sum();
    if !row.is_empty() && *row_width + token_width > width && token_width <= width {
        rows.push((std::mem::take(row), *row_start));
        *row_width = 0;
        *row_start = token_start;
    }
    // The char index (within `line`) of the current token char.
    let mut cur = token_start;
    for ch in token.chars() {
        let w = char_width(ch) as usize;
        if w == 0 {
            cur += 1;
            continue;
        }
        if *row_width + w > width {
            rows.push((std::mem::take(row), *row_start));
            *row_width = 0;
            if w > width {
                cur += 1; // a glyph wider than a fresh row is dropped
                *row_start = cur;
                continue;
            }
            *row_start = cur; // the wrapped row starts at this char
        }
        row.push(ch);
        *row_width += w;
        cur += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::KeyAction;
    use tern_core::scene::NodeKind;
    use tern_core::style::Modifiers;

    // --- wrap_line -------------------------------------------------------

    #[test]
    fn wrap_breaks_at_width_and_keeps_tokens_whole() {
        assert_eq!(wrap_line("hello world", 5), vec!["hello", "world"]);
        assert_eq!(wrap_line("hello world", 11), vec!["hello world"]);
        // A token wider than the width hard-breaks across rows.
        assert_eq!(wrap_line("abcdef", 3), vec!["abc", "def"]);
        // A space that fits stays on the row (trailing at the width).
        assert_eq!(wrap_line("ab cd", 3), vec!["ab ", "cd"]);
        // Empty and whitespace-only lines stay single display lines.
        assert_eq!(wrap_line("", 5), vec![""]);
        assert_eq!(wrap_line("  ", 3), vec!["  "]);
        // An embedded newline ends the display line.
        assert_eq!(wrap_line("a\nb", 5), vec!["a", "b"]);
        // A wide glyph is never split mid-glyph (it rides the row when it
        // fits; the trailing 'b' wraps whole).
        assert_eq!(wrap_line("aコb", 3), vec!["aコ", "b"]);
    }

    // --- construction + editing ------------------------------------------

    #[test]
    fn with_value_splits_lines_and_places_caret_at_end() {
        let ta = Textarea::with_value("ab\ncd");
        assert_eq!(ta.lines, vec!["ab", "cd"]);
        assert_eq!(ta.row, 1);
        assert_eq!(ta.col, 2);
        assert_eq!(ta.text(), "ab\ncd");
    }

    #[test]
    fn insert_char_at_cursor_advances() {
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 0;
        ta.col = 1;
        ta.insert_char('X');
        assert_eq!(ta.lines, vec!["aXb", "cd"]);
        assert_eq!(ta.col, 2);
        // Inserting into an empty textarea works.
        let mut empty = Textarea::new();
        empty.insert_char('h');
        assert_eq!(empty.lines, vec!["h"]);
        assert_eq!(empty.col, 1);
    }

    #[test]
    fn delete_backward_removes_and_joins_lines() {
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 1;
        ta.col = 1;
        ta.delete_backward();
        assert_eq!(ta.lines, vec!["ab", "d"]);
        assert_eq!(ta.col, 0);
        // At the start of a line the previous line is joined.
        let mut join = Textarea::with_value("ab\ncd");
        join.row = 1;
        join.col = 0;
        join.delete_backward();
        assert_eq!(join.lines, vec!["abcd"]);
        assert_eq!(join.row, 0);
        assert_eq!(join.col, 2); // the join point
        // At the very start it is a no-op.
        let mut top = Textarea::with_value("x");
        top.row = 0;
        top.col = 0;
        top.delete_backward();
        assert_eq!(top.lines, vec!["x"]);
    }

    #[test]
    fn delete_forward_removes_and_joins_next_line() {
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 0;
        ta.col = 1;
        ta.delete_forward();
        assert_eq!(ta.lines, vec!["a", "cd"]);
        // At the end of a line the next line is joined.
        let mut join = Textarea::with_value("ab\ncd");
        join.row = 0;
        join.col = 2;
        join.delete_forward();
        assert_eq!(join.lines, vec!["abcd"]);
        assert_eq!(join.row, 0);
        assert_eq!(join.col, 2);
        // At the very end it is a no-op.
        let mut bottom = Textarea::with_value("x");
        bottom.move_end();
        bottom.delete_forward();
        assert_eq!(bottom.lines, vec!["x"]);
    }

    #[test]
    fn enter_splits_the_line_and_places_cursor_at_the_tail() {
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 0;
        ta.col = 1;
        ta.split_line();
        assert_eq!(ta.lines, vec!["a", "b", "cd"]);
        assert_eq!(ta.row, 1);
        assert_eq!(ta.col, 0);
        // Splitting an empty line makes a new blank line.
        let mut blank = Textarea::new();
        blank.split_line();
        assert_eq!(blank.lines, vec!["", ""]);
        assert_eq!(blank.row, 1);
        assert_eq!(blank.col, 0);
    }

    #[test]
    fn handle_key_maps_edits_and_actions() {
        let mut ta = Textarea::with_value("hi");
        assert_eq!(ta.handle_key(Key::Char('!')), KeyAction::None);
        assert_eq!(ta.lines, vec!["hi!"]);
        assert_eq!(ta.handle_key(Key::Enter), KeyAction::None); // an edit, not a submit
        assert_eq!(ta.lines, vec!["hi!", ""]);
        assert_eq!(ta.row, 1);
        assert_eq!(ta.handle_key(Key::Backspace), KeyAction::None); // joins the blank line
        assert_eq!(ta.lines, vec!["hi!"]);
        assert_eq!(ta.handle_key(Key::Escape), KeyAction::Cancel);
        assert_eq!(ta.handle_key(Key::Tab), KeyAction::None);
    }

    // --- navigation ------------------------------------------------------

    #[test]
    fn left_right_home_end_navigate_with_wrap_around() {
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 1;
        ta.col = 0;
        ta.move_left(); // wraps to the end of the previous line
        assert_eq!((ta.row, ta.col), (0, 2));
        ta.move_right(); // wraps to the start of the next line
        assert_eq!((ta.row, ta.col), (1, 0));
        ta.move_end();
        assert_eq!((ta.row, ta.col), (1, 2));
        ta.move_home();
        assert_eq!((ta.row, ta.col), (1, 0));
        // Moving left walks back across the lines to the very start, then
        // sticks.
        ta.move_left();
        assert_eq!((ta.row, ta.col), (0, 2));
        ta.move_left();
        assert_eq!((ta.row, ta.col), (0, 1));
        ta.move_left();
        assert_eq!((ta.row, ta.col), (0, 0));
        ta.move_left();
        assert_eq!((ta.row, ta.col), (0, 0));
    }

    #[test]
    fn up_down_traverse_soft_wrapped_display_lines() {
        // "hello world" wraps at width 5 into display lines "hello" / "world"
        // (the space at the wrap point is dropped); the caret at the end sits
        // at display col 5 of the second display line.
        let mut ta = Textarea::with_value("hello world").with_width(5);
        assert_eq!(ta.wrapped(0), vec!["hello", "world"]);
        assert_eq!(ta.caret_display_row(), 1);
        ta.move_up();
        assert_eq!((ta.row, ta.col), (0, 5)); // end of "hello" — col 5 preserved
        ta.move_down();
        assert_eq!((ta.row, ta.col), (0, 11)); // back to the end
        // At the top the move sticks.
        ta.move_up();
        ta.move_up();
        assert_eq!((ta.row, ta.col), (0, 5));
        // At the bottom it sticks too.
        ta.move_end();
        ta.move_down();
        assert_eq!((ta.row, ta.col), (0, 11));
    }

    #[test]
    fn up_down_move_between_logical_lines_at_wrap_points() {
        // Each line wraps into two display lines at width 5 ("alpha" / "beta",
        // "gamma" / "delta" — the space at each wrap point is dropped).
        let mut ta = Textarea::with_value("alpha beta\ngamma delta").with_width(5);
        assert_eq!(ta.total_display_rows(), 4);
        // From the end of "delta" (display row 3, display col 5) move up: the
        // preferred column (5) is preserved, clamping at each shorter line.
        ta.move_up();
        assert_eq!((ta.row, ta.col), (1, 5)); // end of "gamma"
        ta.move_up();
        assert_eq!((ta.row, ta.col), (0, 10)); // end of "beta"
        ta.move_up();
        assert_eq!((ta.row, ta.col), (0, 5)); // end of "alpha"
        // Down again lands back on the preserved column.
        ta.move_down();
        assert_eq!((ta.row, ta.col), (0, 10));
    }

    #[test]
    fn preferred_column_is_preserved_across_a_vertical_run() {
        // Two display lines under the first logical line plus a one-line
        // second line; the caret starts at the end of "gamma" (display row 2).
        let mut ta = Textarea::with_value("alpha beta\ngamma").with_width(5);
        ta.move_up(); // preferred col 5 -> clamped to the end of "beta"
        assert_eq!((ta.row, ta.col), (0, 10));
        ta.move_down(); // col 5 still sticky -> back to the end of "gamma"
        assert_eq!((ta.row, ta.col), (1, 5));
        // A horizontal move resets the sticky column; the next vertical move
        // re-captures it (0 here, from the line start).
        ta.move_home();
        ta.move_up(); // preferred col 0 -> the start of "beta"
        assert_eq!((ta.row, ta.col), (0, 6));
    }

    // --- scrolling -------------------------------------------------------

    #[test]
    fn scroll_to_caret_keeps_the_caret_inside_the_window() {
        let mut ta = Textarea::with_value("1\n2\n3\n4\n5").with_height(2);
        ta.row = 0;
        ta.col = 0;
        assert_eq!(ta.scroll, 0);
        ta.move_down(); // (1,0) — display row 1, visible in the window [0,2)
        assert_eq!(ta.scroll, 0);
        ta.move_down(); // (2,0) — below the window -> scroll 1 (window [1,3))
        assert_eq!(ta.scroll, 1);
        ta.move_up(); // (1,0) — still inside the window -> scroll stays 1
        assert_eq!(ta.scroll, 1);
        ta.move_up(); // (0,0) — above the window -> scroll 0
        assert_eq!(ta.scroll, 0);
        // No height: everything is shown, scroll stays 0.
        let mut open = Textarea::with_value("1\n2\n3\n4\n5");
        open.move_down();
        open.move_down();
        assert_eq!(open.scroll, 0);
    }

    // --- painting --------------------------------------------------------

    #[test]
    fn materialize_creates_one_leaf_per_display_line_with_caret() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let mut ta = Textarea::with_value("ab\ncd");
        ta.row = 1;
        let id = Renderable::from(ta).materialize(&mut scene, root);

        assert_eq!(scene.node(id).unwrap().kind, NodeKind::Box);
        assert_eq!(
            scene.node(id).unwrap().props.get("flex_direction"),
            Some(&PropValue::Str("column".to_string()))
        );
        let children = scene.children(id).unwrap();
        assert_eq!(children.len(), 2);
        // Line 0 has no caret; line 1 (the caret's line) carries it.
        assert_eq!(scene.prop(children[0], "text"), Some(&PropValue::Str("ab".to_string())));
        assert!(scene.prop(children[0], "caret").is_none());
        assert_eq!(scene.prop(children[1], "text"), Some(&PropValue::Str("cd".to_string())));
        assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(2)));
    }

    #[test]
    fn materialize_wraps_long_lines_into_multiple_leaves() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let mut ta = Textarea::with_value("hello world").with_width(5);
        ta.row = 0;
        let id = Renderable::from(ta).materialize(&mut scene, root);
        let children = scene.children(id).unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(scene.prop(children[0], "text"), Some(&PropValue::Str("hello".to_string())));
        assert_eq!(scene.prop(children[1], "text"), Some(&PropValue::Str("world".to_string())));
        // The caret (end of "hello world") sits at display col 5 of "world".
        assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(5)));
        assert!(scene.prop(children[0], "caret").is_none());
        // Each leaf is sized to the wrap width.
        assert_eq!(scene.prop(children[0], "width"), Some(&PropValue::Int(5)));
    }

    #[test]
    fn materialize_only_paints_the_visible_window() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let mut ta = Textarea::with_value("1\n2\n3\n4\n5").with_height(2);
        ta.scroll = 2;
        ta.row = 3;
        let id = Renderable::from(ta).materialize(&mut scene, root);
        let children = scene.children(id).unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(scene.prop(children[0], "text"), Some(&PropValue::Str("3".to_string())));
        assert_eq!(scene.prop(children[1], "text"), Some(&PropValue::Str("4".to_string())));
        assert_eq!(scene.prop(children[1], "caret"), Some(&PropValue::Int(1)));
    }

    #[test]
    fn hidden_caret_paints_no_caret_prop() {
        let mut scene = Scene::new();
        let root = scene.root_id();
        let mut ta = Textarea::with_value("ab\ncd").hide_caret();
        ta.row = 1;
        let id = Renderable::from(ta).materialize(&mut scene, root);
        let children = scene.children(id).unwrap();
        assert!(scene.prop(children[1], "caret").is_none());
    }

    // --- paint path (through the compositor) -----------------------------

    #[test]
    fn paint_renders_lines_with_reversed_block_caret() {
        // A root textarea fills the viewport; padding 1 puts the leaves at
        // row 1; the caret (display col 2 on the second line) paints the
        // reversed block caret over the cell at (3,2).
        let buffer = crate::compositor::Compositor::new().paint(
            Textarea::with_value("ab\ncd").with_height(2),
            tern_core::Size::new(6, 4),
        );
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'a');
        assert_eq!(buffer.cell(2, 1).unwrap().ch, 'b');
        assert_eq!(buffer.cell(1, 2).unwrap().ch, 'c');
        assert_eq!(buffer.cell(2, 2).unwrap().ch, 'd');
        let caret = buffer.cell(3, 2).unwrap();
        assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
        // The first line's cells are not reversed.
        assert!(!buffer.cell(2, 1).unwrap().style.modifiers.contains(Modifiers::REVERSED));
    }

    #[test]
    fn paint_wraps_long_content_and_keeps_caret_visible() {
        // "hello world" wraps at the 4-cell text area (6-wide viewport minus
        // padding) into "hell" / "o wo" / "rld"; the caret at the end sits at
        // display col 3 of the last row.
        let buffer = crate::compositor::Compositor::new().paint(
            Textarea::with_value("hello world"),
            tern_core::Size::new(6, 6),
        );
        assert_eq!(buffer.cell(1, 1).unwrap().ch, 'h');
        assert_eq!(buffer.cell(1, 2).unwrap().ch, 'o');
        assert_eq!(buffer.cell(3, 2).unwrap().ch, 'w');
        assert_eq!(buffer.cell(1, 3).unwrap().ch, 'r');
        let caret = buffer.cell(4, 3).unwrap();
        assert!(caret.style.modifiers.contains(Modifiers::REVERSED));
    }
}
