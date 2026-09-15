//! Terminal-side controls: window title, OSC 52 clipboard, any-event
//! mouse tracking, and the hardware cursor.

use super::*;

#[napi]
impl TuiRenderer {

/// Set the terminal window title (OSC 0). Errors on a destroyed
/// renderer.
#[napi(js_name = "set_title")]
pub fn set_title(&self, title: String) -> Result<()> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    inner
        .backend
        .set_title(&title)
        .map_err(|e| Error::from_reason(format!("set title: {e}")))
}

/// Copy `text` to the system clipboard (OSC 52: `ESC ] 52 ; c ; <base64>
/// BEL`, the payload being the text's UTF-8 bytes base64-encoded). Errors
/// on a destroyed renderer.
#[napi(js_name = "set_clipboard")]
pub fn set_clipboard(&self, text: String) -> Result<()> {
    let inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    inner
        .backend
        .set_clipboard(&text)
        .map_err(|e| Error::from_reason(format!("set clipboard: {e}")))
}

/// Enable or disable any-event mouse tracking (`?1003h` / `?1003l`):
/// the terminal reports every mouse motion while enabled, not just
/// presses and drags. Off by default — the constructor enables
/// press/release, drag, and scroll tracking only — so motion events
/// flow only while a motion/drag listener is registered. Records the
/// state so [`destroy`](Self::destroy) turns the mode off (`?1003l`)
/// before the general event-listening disable. Errors on a destroyed
/// renderer.
#[napi(js_name = "set_any_event_mouse")]
pub fn set_any_event_mouse(&self, enabled: bool) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    if enabled {
        inner
            .backend
            .enable_any_event_mouse()
            .map_err(|e| Error::from_reason(format!("enable any-event mouse: {e}")))?;
    } else {
        inner
            .backend
            .disable_any_event_mouse()
            .map_err(|e| Error::from_reason(format!("disable any-event mouse: {e}")))?;
    }
    inner.any_event_mouse = enabled;
    Ok(())
}

/// Set the renderer's caret override: position (`x`, `y`), shape
/// (`"block"` / `"bar"` / `"underline"`), visibility, and blinking, all
/// in viewport cells / DECSCUSR terms. The next [`render`](Self::render)
/// (which the cursor edit forces) flushes through the cursor-aware path:
/// the frame diff, then `MoveTo` + `SetCursorStyle` (nothing for the
/// default steady block) + `Show`/`Hide` for the caret, so the hardware
/// caret tracks the model. Errors on a destroyed renderer or an
/// unrecognized shape string.
#[napi(js_name = "set_cursor")]
pub fn set_cursor(&self, x: u32, y: u32, shape: String, visible: bool, blink: bool) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    let cursor = match shape.as_str() {
        "block" => Cursor::new(x as u16, y as u16).block(),
        "bar" => Cursor::new(x as u16, y as u16).bar(),
        "underline" => Cursor::new(x as u16, y as u16).underline(),
        other => return Err(Error::from_reason(format!("invalid cursor shape: {other}"))),
    };
    let cursor = if visible { cursor.show() } else { cursor.hide() };
    let cursor = if blink { cursor.blink() } else { cursor };
    inner.cursor = Some(cursor);
    Ok(())
}

/// Clear the renderer's caret override: the next [`render`](Self::render)
/// (which the cursor edit forces) falls back to the legacy position-only
/// flush — the frame diff with the caret parked at the top-left, no
/// shape, blinking, or visibility control — byte-identical to a renderer
/// that never called [`set_cursor`](Self::set_cursor). Errors on a
/// destroyed renderer.
#[napi(js_name = "clear_cursor")]
pub fn clear_cursor(&self) -> Result<()> {
    let mut inner = self.inner.lock().expect("renderer inner poisoned");
    if inner.destroyed {
        return Err(Error::from_reason("renderer is destroyed"));
    }
    inner.cursor = None;
    Ok(())
}

}
