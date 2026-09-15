//! [`Textarea`] — a multi-line text-entry field with soft-wrapped display
//! lines, caret placement, and key handling.
//!
//! The component is plain state plus editing operations: `lines` (the logical
//! lines of text), a char-index `row`/`col` cursor that always sits on a
//! grapheme-cluster boundary, and a `caret_visible` flag the renderer toggles
//! for blinking. It mirrors [`Input`](crate::Input)
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


use tern_core::{char_width, clusters, strip_escapes};
use tern_core::scene::{NodeId, PropValue, Scene};
use tern_core::style::Style;
use crate::input::{Key, KeyAction};
use crate::renderable::{Box, Renderable};

// The Textarea component stays in this file; the soft-wrap primitives moved
// to textarea/wrap.rs and the tests to textarea/tests.rs.
mod wrap;

pub use wrap::*;

/// A multi-line text-entry field.
#[derive(Debug, Clone)]
pub struct Textarea {
    /// The logical lines of text (no embedded `\n`; split with Enter).
    pub lines: Vec<String>,
    /// Cursor row: the index into [`lines`](Self::lines).
    pub row: usize,
    /// Cursor column: a *char index* into `lines[row]` (0 = before the first
    /// char, `chars().count()` = after the last), always on a grapheme-cluster
    /// boundary — editing and navigation step whole clusters
    /// ([`tern_core::clusters`]) so a cluster is never split or straddled.
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
    /// The caret lands on the end of the cluster containing the inserted
    /// char — an inserted base before a combining mark (or a combining mark
    /// after a base) merges into one cluster, and the caret steps past it
    /// whole.
    pub fn insert_char(&mut self, ch: char) {
        self.vertical_sticky = false;
        let line = &mut self.lines[self.row];
        let mut chars: Vec<char> = line.chars().collect();
        let i = self.col.min(chars.len());
        chars.insert(i, ch);
        *line = chars.into_iter().collect();
        // The inserted char can merge with a following combining mark into
        // one cluster — inserting 'a' at col 0 of "\u{301}x" yields
        // "a\u{301}x" with the caret past the whole cluster. Land on the end
        // of the cluster containing the inserted index, falling back to
        // `i + 1` if none does.
        self.col = cluster_ranges(&self.lines[self.row])
            .iter()
            .find(|(start, end)| *start <= i && i < *end)
            .map(|(_, end)| *end)
            .unwrap_or(i + 1);
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Delete the whole grapheme cluster before the cursor; at the start of a
    /// line, join the line into the previous one (cursor at the join).
    pub fn delete_backward(&mut self) {
        self.vertical_sticky = false;
        if self.col > 0 {
            let line = &mut self.lines[self.row];
            let ranges = cluster_ranges(line);
            // The cluster to delete: the one whose range ends at `col` when
            // `col` sits on a boundary, else the one containing `col` (a
            // mid-cluster external write deletes the containing cluster
            // whole); a `col` past the line's end deletes the last cluster.
            let (start, end) = ranges
                .iter()
                .find(|(_, end)| *end == self.col)
                .or_else(|| {
                    ranges
                        .iter()
                        .find(|(start, end)| *start <= self.col && self.col < *end)
                })
                .or_else(|| ranges.iter().last())
                .copied()
                .unwrap_or((0, 0));
            let mut chars: Vec<char> = line.chars().collect();
            chars.drain(start..end);
            *line = chars.into_iter().collect();
            self.col = start;
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

    /// Delete the whole grapheme cluster under the cursor; at the end of a
    /// line, join the next line into this one.
    pub fn delete_forward(&mut self) {
        self.vertical_sticky = false;
        let line_len = self.lines[self.row].chars().count();
        if self.col < line_len {
            let line = &mut self.lines[self.row];
            let ranges = cluster_ranges(line);
            // The cluster under the cursor: the one containing `col` (its
            // start when `col` is on a boundary). A mid-cluster external
            // `col` deletes the whole containing cluster.
            let (start, end) = ranges
                .iter()
                .find(|(start, end)| *start <= self.col && self.col < *end)
                .copied()
                .unwrap_or((self.col, self.col + 1));
            let mut chars: Vec<char> = line.chars().collect();
            chars.drain(start..end);
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
    /// `col` is always on a grapheme-cluster boundary, so the char-vec split
    /// below never cuts a cluster.
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

    /// Move the cursor one grapheme cluster left (to the start of the
    /// previous cluster); at the start of a line, jump to the end of the
    /// previous line.
    pub fn move_left(&mut self) {
        self.vertical_sticky = false;
        let line_len = self.lines[self.row].chars().count();
        // Clamp a past-end external `col` so the cluster lookup stays in
        // range.
        let col = self.col.min(line_len);
        if col > 0 {
            let ranges = cluster_ranges(&self.lines[self.row]);
            // Step to the start of the cluster whose range ends at `col` (the
            // previous cluster on a boundary); a mid-cluster `col` snaps to
            // the start of the containing cluster instead of stepping past
            // it.
            self.col = ranges
                .iter()
                .find(|(_, end)| *end == col)
                .or_else(|| ranges.iter().find(|(s, e)| *s <= col && col < *e))
                .map(|(start, _)| *start)
                .unwrap_or(0);
        } else if self.row > 0 {
            self.row -= 1;
            self.col = self.lines[self.row].chars().count();
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Move the cursor one grapheme cluster right (to the end of the cluster
    /// under the cursor); at the end of a line, jump to the start of the next
    /// line.
    pub fn move_right(&mut self) {
        self.vertical_sticky = false;
        let line_len = self.lines[self.row].chars().count();
        // Clamp a past-end external `col` so the cluster lookup stays in
        // range.
        let col = self.col.min(line_len);
        if col < line_len {
            let ranges = cluster_ranges(&self.lines[self.row]);
            // Step to the end of the cluster under the cursor (the cluster
            // containing `col`, starting at `col` on a boundary); a
            // mid-cluster `col` jumps to the end of the containing cluster.
            self.col = ranges
                .iter()
                .find(|(start, end)| *start <= col && col < *end)
                .map(|(_, end)| *end)
                .unwrap_or(col + 1);
        } else if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = 0;
        }
        self.preferred_col = self.current_display_col();
        self.scroll_to_caret();
    }

    /// Move the cursor to the start of the current line (char index 0 is a
    /// cluster boundary by definition).
    pub fn move_home(&mut self) {
        self.vertical_sticky = false;
        self.col = 0;
        self.preferred_col = 0;
        self.scroll_to_caret();
    }

    /// Move the cursor to the end of the current line (`chars().count()` is
    /// always a cluster boundary).
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
        self.wrapped_with_offsets(row)
            .into_iter()
            .map(|(s, _)| s)
            .collect()
    }

    /// The start char index of the cluster containing `col` in `lines[row]`;
    /// `None` when `col` is past the line's end (callers keep `col`
    /// unchanged). On a cluster boundary this returns `col` itself.
    fn cluster_start_at(&self, row: usize, col: usize) -> Option<usize> {
        let line = self.lines.get(row)?;
        cluster_ranges(line)
            .iter()
            .find(|(start, end)| *start <= col && col < *end)
            .map(|(start, _)| *start)
    }

    /// The display-line offset (within `lines[row]`'s wrapped lines) that
    /// contains char index `col`. A char dropped by the wrap (e.g. a trailing
    /// space at a full row) maps to the display line it trails.
    fn offset_of_col(&self, row: usize, col: usize) -> usize {
        let wrapped = self.wrapped_with_offsets(row);
        // Defensive: `col` is on a cluster boundary by construction, but an
        // external write could leave it mid-cluster — snap to the containing
        // cluster's start so a cluster is never attributed across display
        // lines. The comparison below is char-space and stays exact.
        let col = self.cluster_start_at(row, col).unwrap_or(col);
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
    /// logical line). The column sums *cluster* widths, not per-char widths.
    fn caret_display_in(&self, row: usize, offset: usize) -> (usize, usize) {
        let wrapped = self.wrapped_with_offsets(row);
        let (dl, start) = wrapped.get(offset).cloned().unwrap_or_default();
        let local = self.col.saturating_sub(start).min(dl.chars().count());
        // Walk whole clusters, accumulating width while the consumed char
        // count stays within `local`: a ZWJ emoji cluster is one 2-column
        // unit, a combining sequence renders at its base's width — the same
        // columns the renderer paints.
        let mut col = 0usize;
        let mut consumed = 0usize;
        for c in clusters(&dl) {
            if consumed + c.text.chars().count() > local {
                break;
            }
            consumed += c.text.chars().count();
            col += c.width as usize;
        }
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
        // Step per cluster: a column inside a wide or multi-char cluster
        // snaps to that cluster's start, and a whole cluster occupies its
        // full width.
        for c in clusters(&dl) {
            let w = c.width as usize;
            if col + w > target_col {
                break;
            }
            col += w;
            local += c.text.chars().count();
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
        Box::new(self.frame_style.clone(), vec![])
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
                .add_text(parent, &text, self.style.clone())
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

#[cfg(test)]
mod tests;
