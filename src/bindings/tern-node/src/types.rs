//! napi `#[napi(object)]` DTOs exchanged with the JS host.

use super::*;
use napi_derive::napi;

/// The laid-out content size of a scene node, in cells.
#[napi(object)]
pub struct ContentSize {
    /// The content width in cells.
    pub width: u32,
    /// The content height in cells.
    pub height: u32,
}

/// The terminal size reported by a [`TuiRenderer`]: `{ width, height }` in
/// cells.
#[napi(object)]
#[derive(Debug)]
pub struct RendererSize {
    /// The width in columns.
    pub width: u32,
    /// The height in rows.
    pub height: u32,
}

/// An inclusive cell range, in viewport coordinates: the rectangle spanned
/// by (`col1`, `row1`) and (`col2`, `row2`). Either endpoint may be the
/// top-left; consumers normalize with `min`/`max`.
#[napi(object)]
#[derive(Debug)]
pub struct SelectionRange {
    /// The column of one endpoint (inclusive).
    pub col1: u32,
    /// The row of one endpoint (inclusive).
    pub row1: u32,
    /// The column of the other endpoint (inclusive).
    pub col2: u32,
    /// The row of the other endpoint (inclusive).
    pub row2: u32,
}

/// One token-highlighted span: the chunk's text plus the style keys lifted
/// from the highlight style (`fg` as a `"#rrggbb"` hex string, and the boolean
/// modifiers). The shape mirrors `Span` (the `append_span` style-key
/// convention), so a JS consumer can feed a highlighted span straight into a
/// `streaming_text` node.
#[napi(object)]
#[derive(Debug)]
pub struct HighlightSpanJs {
    /// The span's text content.
    pub text: String,
    /// The foreground color as `"#rrggbb"`, when the token carries one.
    pub fg: Option<String>,
    /// Whether the token is bold.
    pub bold: bool,
    /// Whether the token is italic.
    pub italic: bool,
    /// Whether the token is dim.
    pub dim: bool,
    /// Whether the token is underlined.
    pub underline: bool,
}

/// One styled run in a [`TuiRenderer::render_to_buffer_styled`] snapshot row:
/// the run's text plus the style keys its cells share. Adjacent cells with
/// identical style merge into one run, so concatenating a row's run texts
/// reconstructs the whole row (masked continuation cells as spaces, exactly
/// like the plain [`TuiRenderer::render_to_buffer`]).
///
/// Colors surface as `"#rrggbb"` (truecolor) or `"indexed:<n>"` (ANSI
/// palette) strings; every modifier key is present only when set, so an
/// unstyled run carries just `text`. A run whose cells carry a hyperlink
/// reports the link target as `hyperlink` — the value the engine threads
/// from the `href` style key into `Style::hyperlink` (see
/// [`apply_style_key`](crate::convert::apply_style_key)). A run whose cells
/// carry an extended underline reports `underline_style` (the kitty
/// `\x1b[4:Nm` variant keyword) and `underline_color` — the values the
/// engine threads from the `underline_style` / `underline_color` style
/// keys into `Style::underline_style` / `Style::underline_color`; both are
/// present only when set.
#[napi(object)]
#[derive(Debug, PartialEq, Eq)]
pub struct StyleRunJs {
    /// The run's text content.
    pub text: String,
    /// The foreground color, when the cells carry one.
    pub fg: Option<String>,
    /// The background color, when the cells carry one.
    pub bg: Option<String>,
    /// The hyperlink target (a URL) the run's cells paint as an OSC 8
    /// hyperlink, present only when the cells carry one.
    pub hyperlink: Option<String>,
    /// The underline style variant the run's cells paint (`"single"`,
    /// `"double"`, `"curly"`, `"dotted"`, or `"dashed"`), present only when
    /// the cells carry one.
    pub underline_style: Option<String>,
    /// The color the run's underline is painted with, present only when the
    /// cells carry one.
    pub underline_color: Option<String>,
    /// Whether the run is bold.
    pub bold: Option<bool>,
    /// Whether the run is dim.
    pub dim: Option<bool>,
    /// Whether the run is italic.
    pub italic: Option<bool>,
    /// Whether the run is underlined.
    pub underline: Option<bool>,
    /// Whether the run is reversed (fg/bg swapped).
    pub reversed: Option<bool>,
    /// Whether the run is struck through.
    pub strikethrough: Option<bool>,
}

/// A key event surfaced to JS as a plain object: `{ name, char, ctrl, alt,
/// shift, kind, super, meta, hyper }`. `char` is the printable character for
/// `"char"`-named keys (single-character string), `undefined` for named
/// keys. `kind` is `"press"` (the default — the only kind a terminal without
/// the kitty keyboard protocol reports), `"repeat"`, or `"release"`; the
/// precise modifier keys (`super`, `meta`, `hyper`) are present only when
/// held. `name`/`char`/`ctrl`/`alt`/`shift` are unchanged for back-compat.
#[napi(object)]
pub struct KeyEvent {
    /// The key's name: `char`, `enter`, `escape`, `backspace`, `tab`,
    /// `backtab`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`,
    /// `up`, `down`, `left`, `right`, `f<n>`, `null`, `unknown`.
    pub name: String,
    /// The printable character for `"char"` keys.
    pub char: Option<String>,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
    /// The key event kind: `"press"` (default), `"repeat"`, or `"release"`.
    /// Filled by [`KeyEvent::from_tern`] from the tern [`KeyKind`].
    pub kind: Option<String>,
    /// Whether Super (the Windows / Command key) was held.
    pub super_: Option<bool>,
    /// Whether Meta was held.
    pub meta: Option<bool>,
    /// Whether Hyper was held.
    pub hyper: Option<bool>,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl KeyEvent {
    pub(crate) fn from_tern(key: TernKey) -> Self {
        Self {
            name: key_name_str(key.name),
            char: key.char.map(|c| c.to_string()),
            ctrl: key.ctrl,
            alt: key.alt,
            shift: key.shift,
            kind: Some(match key.kind {
                KeyKind::Press => "press".to_string(),
                KeyKind::Repeat => "repeat".to_string(),
                KeyKind::Release => "release".to_string(),
            }),
            super_: key.super_.then_some(true),
            meta: key.meta.then_some(true),
            hyper: key.hyper.then_some(true),
        }
    }
}

/// A mouse event surfaced to JS as a plain object.
///
/// `kind` encodes both the action and — where relevant — the button, so no
/// button information is lost: `"down_left"`, `"up_right"`,
/// `"drag_middle"`, `"moved"`, `"scroll_up"`, `"scroll_down"`,
/// `"scroll_left"`, `"scroll_right"`. `column` / `row` are the cell the
/// event occurred on (0-based); `ctrl` / `alt` / `shift` are the held
/// modifiers.
#[napi(object)]
pub struct MouseEventJs {
    /// The action + button, e.g. `"down_left"`, `"up_right"`,
    /// `"drag_middle"`, `"moved"`, `"scroll_up"`.
    pub kind: String,
    /// The column the event occurred on (0-based).
    pub column: u16,
    /// The row the event occurred on (0-based).
    pub row: u16,
    /// Whether Control was held.
    pub ctrl: bool,
    /// Whether Alt (Option) was held.
    pub alt: bool,
    /// Whether Shift was held.
    pub shift: bool,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl MouseEventJs {
    pub(crate) fn from_tern(mouse: TernMouse) -> Self {
        let kind = match mouse.kind {
            MouseEventKind::Down(button) => format!("down_{}", mouse_button_str(button)),
            MouseEventKind::Up(button) => format!("up_{}", mouse_button_str(button)),
            MouseEventKind::Drag(button) => format!("drag_{}", mouse_button_str(button)),
            MouseEventKind::Moved => "moved".to_string(),
            MouseEventKind::ScrollDown => "scroll_down".to_string(),
            MouseEventKind::ScrollUp => "scroll_up".to_string(),
            MouseEventKind::ScrollLeft => "scroll_left".to_string(),
            MouseEventKind::ScrollRight => "scroll_right".to_string(),
        };
        Self {
            kind,
            column: mouse.column,
            row: mouse.row,
            ctrl: mouse.ctrl,
            alt: mouse.alt,
            shift: mouse.shift,
        }
    }
}

/// The JS-facing name of a mouse button.
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
pub(crate) fn mouse_button_str(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// A terminal event surfaced to JS as a tagged-union plain object: `type`
/// discriminates (`"key"`, `"resize"`, `"focus"`, `"mouse"`, `"paste"`) and
/// exactly one of `key` / `width`+`height` / `focus_gained` / `mouse` /
/// `paste` is set. For `"focus"`, `focus_gained` is `true` on gained and
/// `false` on lost.
#[napi(object)]
pub struct TernEventJs {
    /// The event kind: `"key"`, `"resize"`, `"focus"`, `"mouse"`, or
    /// `"paste"`.
    #[napi(js_name = "type")]
    pub r#type: String,
    /// The key event, when `type` is `"key"`.
    pub key: Option<KeyEvent>,
    /// The new width in columns, when `type` is `"resize"`.
    pub width: Option<u16>,
    /// The new height in rows, when `type` is `"resize"`.
    pub height: Option<u16>,
    /// Whether focus was gained (`true`) or lost (`false`), when `type` is
    /// `"focus"`.
    #[napi(js_name = "focus_gained")]
    pub focus_gained: Option<bool>,
    /// The mouse event, when `type` is `"mouse"`.
    pub mouse: Option<MouseEventJs>,
    /// The pasted text, when `type` is `"paste"`.
    pub paste: Option<String>,
}

#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
impl TernEventJs {
    pub(crate) fn from_tern(ev: TernEvent) -> Self {
        match ev {
            TernEvent::Key(key) => Self {
                r#type: "key".to_string(),
                key: Some(KeyEvent::from_tern(key)),
                width: None,
                height: None,
                focus_gained: None,
                mouse: None,
                paste: None,
            },
            TernEvent::Resize { w, h } => Self {
                r#type: "resize".to_string(),
                key: None,
                width: Some(w),
                height: Some(h),
                focus_gained: None,
                mouse: None,
                paste: None,
            },
            TernEvent::FocusGained => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(true),
                mouse: None,
                paste: None,
            },
            TernEvent::FocusLost => Self {
                r#type: "focus".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: Some(false),
                mouse: None,
                paste: None,
            },
            TernEvent::Mouse(mouse) => Self {
                r#type: "mouse".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: None,
                mouse: Some(MouseEventJs::from_tern(mouse)),
                paste: None,
            },
            TernEvent::Paste(text) => Self {
                r#type: "paste".to_string(),
                key: None,
                width: None,
                height: None,
                focus_gained: None,
                mouse: None,
                paste: Some(text),
            },
        }
    }
}

/// Constructor options for [`TuiRenderer`].
#[napi(object)]
pub struct TuiRendererOptions {
    /// When `true`, a Ctrl+C key press tears the terminal down (raw mode +
    /// alternate screen exited) and marks the renderer destroyed instead of
    /// being surfaced as an event.
    #[napi(js_name = "exit_on_ctrl_c")]
    pub exit_on_ctrl_c: Option<bool>,
    /// When `false`, the renderer skips the alternate screen: it renders
    /// inline in the terminal's main screen (and never emits the alternate-
    /// screen enter/leave escapes). Default `true`.
    #[napi(js_name = "use_alt_screen")]
    pub use_alt_screen: Option<bool>,
    /// The terminal window title, applied on construction (OSC 0). `None`
    /// leaves the title untouched.
    #[napi(js_name = "title")]
    pub title: Option<String>,
    /// When `true`, the renderer never touches a terminal: no raw mode, no
    /// alternate screen, no event listening, no title. Rendering and
    /// snapshots run against an in-memory buffer of the configured `width` x
    /// `height` (default 80x24), so construction and rendering succeed
    /// without a TTY (plain `cargo test`, CI, snapshot tooling). Default
    /// `false`.
    #[napi(js_name = "headless")]
    pub headless: Option<bool>,
    /// Enable the kitty keyboard protocol (progressive enhancement) so
    /// modifier combinations like Shift-Enter arrive as distinct key events
    /// instead of collapsing into the unmodified key. Terminals that do not
    /// support the protocol ignore the sequences; the enhancement is popped
    /// on destroy. Default `true`.
    #[napi(js_name = "keyboard_enhancement")]
    pub keyboard_enhancement: Option<bool>,
    /// The virtual width in cells for `headless` mode (default 80). Ignored
    /// when `headless` is `false`.
    #[napi(js_name = "width")]
    pub width: Option<u32>,
    /// The virtual height in cells for `headless` mode (default 24). Ignored
    /// when `headless` is `false`.
    #[napi(js_name = "height")]
    pub height: Option<u32>,
}

/// The terminal's color capabilities, detected by the backend.
#[napi(object)]
pub struct RendererCapabilities {
    /// Whether 24-bit (16M) RGB truecolor is supported.
    pub truecolor: bool,
    /// The terminal's color palette size: 16_777_216 for truecolor, 256 for
    /// a 256-color palette, 16 for basic ANSI, 0 when none.
    pub colors: u32,
}
