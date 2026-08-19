//! tern-wasm — a C-ABI preview binding for running tern scenes in a browser.
//!
//! Phase 6 preview spike (see `docs/roadmap.md`). The crate compiles to
//! `wasm32-unknown-unknown` as a **cdylib** and depends **only** on the
//! pure-Rust, wasm-safe core crates — `tern-core`, `tern-layout`,
//! `tern-components` — never `tern-terminal`, napi, or crossterm. The OS-bound
//! terminal frontend is replaced by a JS-side cell painter: the scene is
//! rendered by the same [`Compositor`] the terminal backend uses, and
//! [`render_to_cells`] hands the JS host a flat per-cell payload carrying the
//! cluster symbol / lead char, fg/bg colors and text-modifier flags — the
//! structured cell stream a canvas renderer needs (the `snapshotFrame` row
//! strings carry no style).
//!
//! ## The exported C ABI (see [`abi`])
//!
//! All state lives in one shared instance behind a mutex:
//!
//! - **Lifecycle:** `tern_reset`, `tern_root`
//! - **Scene construction** (the same JSON-prop protocol the napi binding
//!   speaks, `src/bindings/tern-node`): `tern_create_node(type, propsJson)`,
//!   `tern_add_child(parent, child)`, `tern_remove(id)`,
//!   `tern_set_props(id, propsJson)`, `tern_set_prop(id, keyJson, valueJson)`,
//!   `tern_append_span(id, textJson, styleJson)`
//! - **Rendering:** `tern_render_to_cells(width, height)`,
//!   `tern_cell_count`, `tern_cell_blob_ptr`, `tern_cell_blob_len`
//! - **String plumbing:** `tern_alloc` / `tern_reset_alloc` (a bump scratch
//!   allocator the JS shim writes UTF-8 strings into), `tern_last_error`
//!
//! String parameters are `(ptr, len)` pairs into the wasm linear memory (or
//! any valid pointer on the host); props/values are JSON strings parsed with
//! serde_json, so the shim sends the exact same props objects the napi
//! protocol accepts.
//!
//! ## `render_to_cells` payload
//!
//! The render result is a row-major array of [`TernWasmCell`] (fixed 24-byte
//! records, `repr(C)`) plus a **symbol blob** (UTF-8): a cell that carries a
//! multi-character grapheme cluster (a ZWJ emoji, a combining sequence, a
//! flag) stores the cluster's full text in the blob and points to it via
//! `symbol_off`/`symbol_len`; every other cell carries its lead char in `ch`
//! (Unicode scalar, so wide/astral chars fit). Masked continuation cells (the
//! zero-width right halves of wide glyphs) are flagged `MASKED` with `ch = 0`
//! and are skipped by the painter. Colors are encoded by [`encode_color`].
//!
//! The returned pointers stay valid until the **next** `tern_render_to_cells`
//! call (the buffers are reused across frames, like the compositor's).

#![allow(clippy::missing_safety_doc)] // C ABI surface: safety documented at the module level

pub mod abi;
mod protocol;

use std::collections::HashMap;

use tern_components::Compositor;
use tern_core::buffer::Buffer;
use tern_core::cell::Cell;
use tern_core::color::Color;
use tern_core::rect::Size;
use tern_core::scene::{NodeId, NodeKind, PropMap, Scene, Span};
use tern_core::style::{Modifiers, Style};

pub use protocol::{apply_style_key, json_to_prop_value, props_to_style_map};

/// One rendered cell of a frame — the fixed-size record the JS painter reads.
///
/// `repr(C)` and 6 × `u32` = **24 bytes**, so a JS host can stride the array
/// returned by [`abi::tern_render_to_cells`] with a constant step.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TernWasmCell {
    /// The lead character of the grapheme cluster, as a Unicode scalar value.
    /// `0` for a masked continuation cell; for a multi-char cluster the full
    /// text lives in the symbol blob (`symbol_off`/`symbol_len`) and `ch` is
    /// its first character.
    pub ch: u32,
    /// Byte offset of the cluster's full symbol text inside the frame's
    /// symbol blob ([`abi::tern_cell_blob_ptr`] / [`abi::tern_cell_blob_len`]);
    /// `0` when the cell has no symbol.
    pub symbol_off: u32,
    /// Byte length of the symbol text; `0` when there is no symbol.
    pub symbol_len: u32,
    /// Foreground color, see [`encode_color`].
    pub fg: u32,
    /// Background color, see [`encode_color`].
    pub bg: u32,
    /// Text-modifier flags, see [`TernCellFlags`].
    pub flags: u32,
}

/// Cell flag bits (the `flags` field of [`TernWasmCell`]).
pub mod cell_flags {
    pub const BOLD: u32 = 1 << 0;
    pub const DIM: u32 = 1 << 1;
    pub const ITALIC: u32 = 1 << 2;
    pub const UNDERLINE: u32 = 1 << 3;
    pub const REVERSED: u32 = 1 << 4;
    pub const BLINK: u32 = 1 << 5;
    pub const HIDDEN: u32 = 1 << 6;
    pub const STRIKETHROUGH: u32 = 1 << 7;
    /// Zero-width continuation cell (the right half of a 2-column glyph); the
    /// painter skips it — its lead cell already drew the whole glyph.
    pub const MASKED: u32 = 1 << 8;
}

impl TernWasmCell {
    /// The blank, unstyled cell.
    pub const fn blank() -> Self {
        Self {
            ch: 0,
            symbol_off: 0,
            symbol_len: 0,
            fg: 0,
            bg: 0,
            flags: 0,
        }
    }

    /// The cell's display text: the symbol blob slice when a symbol is set,
    /// otherwise the single `ch` (as UTF-8). Used by host-side tests/readers;
    /// the JS painter reads `ch` / the blob directly.
    pub fn text<'b>(&self, blob: &'b [u8]) -> std::borrow::Cow<'b, str> {
        if self.symbol_len > 0 {
            let start = (self.symbol_off as usize).min(blob.len());
            let end = (start + self.symbol_len as usize).min(blob.len());
            return String::from_utf8_lossy(&blob[start..end]);
        }
        if self.ch == 0 {
            return std::borrow::Cow::Borrowed("");
        }
        match char::from_u32(self.ch) {
            Some(c) => std::borrow::Cow::Owned(c.to_string()),
            None => std::borrow::Cow::Borrowed(""),
        }
    }
}

/// Encode a tern [`Color`] into the 32-bit ABI color format.
///
/// The top byte is a tag, the rest the payload:
///
/// - `0x00xxxxxx` — `Color::Default` (encoded as `0`), the terminal/host
///   default foreground or background
/// - `0x01xxxxxx` — `Color::Indexed(n)`, an ANSI 256-palette index
/// - `0x02rrggbb` — `Color::Rgb(r, g, b)`, 24-bit truecolor
pub const fn encode_color(color: Color) -> u32 {
    match color {
        Color::Default => 0,
        Color::Indexed(n) => 0x01_00_00_00 | n as u32,
        Color::Rgb(r, g, b) => 0x02_00_00_00 | ((r as u32) << 16) | ((g as u32) << 8) | b as u32,
    }
}

/// Whether `color` decodes as `Color::Rgb` and its channels.
pub fn decode_color_rgb(encoded: u32) -> Option<(u8, u8, u8)> {
    match encoded >> 24 {
        0x02 => Some((
            (encoded >> 16) as u8,
            (encoded >> 8) as u8,
            encoded as u8,
        )),
        _ => None,
    }
}

/// The largest render the ABI accepts per axis (guards the shared buffers
/// against absurd size requests; the demo uses ~80×24).
pub const MAX_RENDER_AXIS: u32 = 4096;

/// A handle's state: a detached `create_node` template (not yet in the scene)
/// or a bound scene node id.
#[derive(Debug, Clone)]
enum HandleState {
    /// A template awaiting `add_child`; carries the kind/style/props a bound
    /// node is materialized from (mirrors the napi `NodeInner`).
    Detached {
        kind: NodeKind,
        style: Style,
        props: PropMap,
    },
    /// Bound to a live scene node.
    Attached(NodeId),
}

/// The shared binding state: one scene + compositor (the terminal's own
/// pipeline, minus the terminal) plus the handle table and the reused render
/// buffers.
#[derive(Debug)]
pub struct WasmState {
    /// The scene tree driven through the JSON-prop protocol.
    pub scene: Scene,
    /// The retained compositor (incremental dirty repaint across frames).
    pub compositor: Compositor,
    /// Handle id -> handle state; handle `0` is the always-attached scene
    /// root.
    handles: HashMap<u64, HandleState>,
    /// Next handle id handed out by `create_node`.
    next_handle: u64,
    /// The last render's cell records (reused across frames).
    cells: Vec<TernWasmCell>,
    /// The last render's symbol blob (reused across frames).
    blob: Vec<u8>,
    /// The cell count of the last render (`width * height`).
    cell_count: usize,
    /// The bump scratch allocator backing `tern_alloc`.
    alloc: Vec<u8>,
    /// Bump offset into `alloc`.
    alloc_off: usize,
    /// Message of the last failed operation (`tern_last_error`).
    last_error: String,
}

impl WasmState {
    /// A fresh state: an empty scene whose handle `0` is the root.
    pub fn new() -> Self {
        let scene = Scene::new();
        let root = scene.root_id();
        let mut handles = HashMap::new();
        handles.insert(0, HandleState::Attached(root));
        Self {
            scene,
            compositor: Compositor::new(),
            handles,
            next_handle: 1,
            cells: Vec::new(),
            blob: Vec::new(),
            cell_count: 0,
            alloc: Vec::new(),
            alloc_off: 0,
            last_error: String::new(),
        }
    }

    /// The root handle (always `0`).
    pub const fn root_handle(&self) -> u64 {
        0
    }

    /// The message of the last failed operation.
    pub fn last_error(&self) -> &str {
        &self.last_error
    }

    /// Reset every handle, the scene and the compositor (a fresh state).
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    fn fail<T>(&mut self, msg: impl Into<String>) -> Result<T, String> {
        let msg = msg.into();
        self.last_error = msg.clone();
        Err(msg)
    }

    /// The scene node id a handle is bound to, or an error (recorded).
    fn attached_id(&mut self, handle: u64) -> Result<NodeId, String> {
        match self.handles.get(&handle) {
            Some(HandleState::Attached(id)) => Ok(*id),
            Some(HandleState::Detached { .. }) => self.fail(
                "handle is a detached template (add it to a parent first)".to_string(),
            ),
            None => self.fail(format!("unknown handle {handle}")),
        }
    }

    /// Parse a props/JSON object, recording the failure message on error.
    /// An empty string parses as an empty object.
    fn parse_json_map(
        &mut self,
        json: &str,
        what: &str,
    ) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        if json.is_empty() {
            return Ok(serde_json::Map::new());
        }
        match serde_json::from_str(json) {
            Ok(m) => Ok(m),
            Err(e) => self.fail(format!("invalid {what} JSON: {e}")),
        }
    }

    /// Create a detached node template of `type` (`"box"`, `"text"`,
    /// `"streaming_text"`) with JSON `props` (the JSON-prop protocol). Returns
    /// the handle, or `0` on error ([`last_error`](Self::last_error)).
    pub fn create_node(&mut self, r#type: &str, props_json: &str) -> Result<u64, String> {
        let kind = match r#type {
            "box" => NodeKind::Box,
            "text" => NodeKind::Text,
            "streaming_text" => NodeKind::StreamingText,
            other => {
                return self.fail(format!(
                    "unknown node type {other:?} (expected \"box\", \"text\", or \"streaming_text\")"
                ))
            }
        };
        let props = self.parse_json_map(props_json, "props")?;
        let (style, props) = props_to_style_map(props);
        let handle = self.next_handle;
        self.next_handle += 1;
        self.handles
            .insert(handle, HandleState::Detached { kind, style, props });
        Ok(handle)
    }

    /// Materialize the detached template `child` under the attached `parent`
    /// and return the (now bound) child handle — callable as a chain
    /// (`root.add_child(create_node(...))`), mirroring the napi protocol.
    /// Errors when `parent` is detached/unknown or `child` is already bound.
    pub fn add_child(&mut self, parent: u64, child: u64) -> Result<u64, String> {
        let parent_id = self.attached_id(parent)?;
        let Some(HandleState::Detached { kind, style, props }) = self.handles.remove(&child) else {
            if self.handles.contains_key(&child) {
                return self.fail("child handle is already attached to the scene");
            }
            return self.fail(format!("unknown child handle {child}"));
        };
        let Some(id) = self.scene.add_child(parent_id, kind, style.clone()) else {
            self.handles.insert(
                child,
                HandleState::Detached { kind, style, props },
            );
            return self.fail("parent node not found in scene");
        };
        self.scene.set_props(id, props.clone());
        self.handles.insert(child, HandleState::Attached(id));
        Ok(child)
    }

    /// Detach `handle` (and its whole subtree) from the scene. The handle
    /// keeps its kind/style/props as a template again, so it can be re-attached
    /// elsewhere (mirrors the napi `NodeHandle::remove`). Returns whether
    /// anything was removed; the root can never be removed.
    pub fn remove(&mut self, handle: u64) -> Result<bool, String> {
        match self.handles.get(&handle) {
            Some(HandleState::Attached(id)) => {
                let Some(n) = self.scene.node(*id) else {
                    return self.fail("node missing from scene");
                };
                let (kind, style, props) = (n.kind, n.style.clone(), n.props.clone());
                let removed = self.scene.remove(*id);
                self.handles
                    .insert(handle, HandleState::Detached { kind, style, props });
                Ok(removed)
            }
            Some(HandleState::Detached { .. }) => Ok(false),
            None => self.fail(format!("unknown handle {handle}")),
        }
    }

    /// Replace a handle's props (and style keys) — full-map replacement,
    /// mirroring the napi `set_props`. Detached templates update their
    /// pending materialization data.
    pub fn set_props(&mut self, handle: u64, props_json: &str) -> Result<(), String> {
        let props = self.parse_json_map(props_json, "props")?;
        let (style, map) = props_to_style_map(props);
        match self.handles.get_mut(&handle) {
            Some(HandleState::Detached { style: s, props: p, .. }) => {
                *s = style;
                *p = map;
                Ok(())
            }
            Some(HandleState::Attached(id)) => {
                let id = *id;
                self.scene.set_style(id, style);
                self.scene.set_props(id, map);
                Ok(())
            }
            None => self.fail(format!("unknown handle {handle}")),
        }
    }

    /// Set a single property (or style key) on a handle — the incremental
    /// counterpart of [`set_props`](Self::set_props), mirroring the napi
    /// `set_prop`. An equal-value write is a no-op (the scene epoch is not
    /// bumped).
    pub fn set_prop(&mut self, handle: u64, key: &str, value_json: &str) -> Result<(), String> {
        let value: serde_json::Value = match serde_json::from_str(value_json) {
            Ok(v) => v,
            Err(e) => return self.fail(format!("invalid value JSON: {e}")),
        };
        match self.handles.get_mut(&handle) {
            Some(HandleState::Detached { style, props, .. }) => {
                if let Some(updated) = apply_style_key(style.clone(), key, &value) {
                    *style = updated;
                } else if let Some(pv) = json_to_prop_value(value) {
                    props.insert(key.to_string(), pv);
                }
                Ok(())
            }
            Some(HandleState::Attached(id)) => {
                let id = *id;
                if let Some(updated) = self
                    .scene
                    .node(id)
                    .map(|n| apply_style_key(n.style.clone(), key, &value))
                    .unwrap_or(None)
                {
                    self.scene.set_style(id, updated);
                } else if let Some(pv) = json_to_prop_value(value) {
                    self.scene.set_prop(id, key, pv);
                }
                Ok(())
            }
            None => self.fail(format!("unknown handle {handle}")),
        }
    }

    /// Append a styled span to a bound `streaming_text` node's stream.
    /// `style_json` follows the style-key convention (`fg`, `bg`, modifier
    /// keys); every other key is ignored.
    pub fn append_span(&mut self, handle: u64, text: &str, style_json: &str) -> Result<(), String> {
        let style_map = self.parse_json_map(style_json, "style")?;
        let (style, _) = props_to_style_map(style_map);
        let id = self.attached_id(handle)?;
        let is_streaming = self
            .scene
            .node(id)
            .map(|n| n.kind == NodeKind::StreamingText)
            .unwrap_or(false);
        if !is_streaming {
            return self.fail("append_span requires a streaming_text node");
        }
        if !self
            .scene
            .append_span(id, Span { text: text.to_string(), style })
        {
            return self.fail("node not found in scene");
        }
        Ok(())
    }

    /// Render the scene at `width` × `height` cells into the shared cell
    /// array + symbol blob, returning the cell count. The pointers handed out
    /// by [`abi`] stay valid until the next call.
    ///
    /// Rows are row-major: cell `y * width + x`. Every cell — blank, painted,
    /// masked — has a record, so the JS host strides the array without holes.
    pub fn render_to_cells(&mut self, width: u32, height: u32) -> Result<usize, String> {
        if width == 0 || height == 0 {
            return Ok(0);
        }
        if width > MAX_RENDER_AXIS || height > MAX_RENDER_AXIS {
            return self.fail(format!(
                "render size {width}x{height} exceeds the {MAX_RENDER_AXIS} cell-per-axis limit"
            ));
        }
        let viewport = Size::new(width as u16, height as u16);
        let buffer: Buffer = self.compositor.paint_scene(&self.scene, viewport);

        let count = (width as usize) * (height as usize);
        self.cells.clear();
        self.cells.resize(count, TernWasmCell::blank());
        self.blob.clear();
        for y in 0..height {
            for x in 0..width {
                let idx = (y as usize) * (width as usize) + (x as usize);
                let Some(cell) = buffer.cell(x as u16, y as u16) else {
                    continue;
                };
                fill_cell_record(&mut self.cells[idx], &mut self.blob, cell);
            }
        }
        self.cell_count = count;
        Ok(count)
    }

    /// The cell records of the last render.
    pub fn last_cells(&self) -> &[TernWasmCell] {
        &self.cells[..self.cell_count]
    }

    /// The symbol blob of the last render.
    pub fn last_blob(&self) -> &[u8] {
        &self.blob
    }

    /// The pointer to the cell array of the last render (valid until the next
    /// `render_to_cells`).
    pub fn cells_ptr(&self) -> *const TernWasmCell {
        self.cells.as_ptr()
    }

    /// Allocate `len` bytes in the shared bump scratch region, 8-byte aligned.
    /// The returned pointer is valid only until the next `alloc_bytes` call
    /// (the region grows lazily, which may move it). Returns `None` when `len`
    /// overflows.
    pub fn alloc_bytes(&mut self, len: usize) -> Option<*mut u8> {
        if len == 0 {
            return Some(self.alloc.as_mut_ptr());
        }
        let align = 8usize;
        let start = self.alloc_off.div_ceil(align) * align;
        let end = start.checked_add(len)?;
        if end > self.alloc.len() {
            let new_len = end.max(self.alloc.len().saturating_mul(2)).max(64 * 1024);
            self.alloc.resize(new_len, 0);
        }
        self.alloc_off = end;
        Some(unsafe { self.alloc.as_mut_ptr().add(start) })
    }

    /// Reset the bump scratch allocator (all previously allocated regions are
    /// reclaimed).
    pub fn reset_alloc(&mut self) {
        self.alloc_off = 0;
    }
}

impl Default for WasmState {
    fn default() -> Self {
        Self::new()
    }
}

/// Fill one `TernWasmCell` record from a painted tern `Cell`.
fn fill_cell_record(rec: &mut TernWasmCell, blob: &mut Vec<u8>, cell: &Cell) {
    rec.fg = encode_color(cell.style.fg);
    rec.bg = encode_color(cell.style.bg);
    rec.flags = flags_of(cell.style.modifiers);
    if cell.is_masked() {
        // Zero-width continuation: no glyph, no symbol.
        rec.ch = 0;
        rec.symbol_off = 0;
        rec.symbol_len = 0;
        rec.flags |= cell_flags::MASKED;
        return;
    }
    rec.ch = cell.ch as u32;
    if let Some(symbol) = &cell.symbol {
        // A multi-char cluster (ZWJ emoji, combining sequence, flag): the full
        // text goes into the blob; the lead char stays in `ch` as a fallback.
        rec.symbol_off = blob.len() as u32;
        blob.extend_from_slice(symbol.as_bytes());
        rec.symbol_len = symbol.len() as u32;
    } else {
        rec.symbol_off = 0;
        rec.symbol_len = 0;
    }
}

/// The ABI flag bits of a tern modifier set.
const fn flags_of(modifiers: Modifiers) -> u32 {
    let mut flags = 0;
    if modifiers.contains(Modifiers::BOLD) {
        flags |= cell_flags::BOLD;
    }
    if modifiers.contains(Modifiers::DIM) {
        flags |= cell_flags::DIM;
    }
    if modifiers.contains(Modifiers::ITALIC) {
        flags |= cell_flags::ITALIC;
    }
    if modifiers.contains(Modifiers::UNDERLINE) {
        flags |= cell_flags::UNDERLINE;
    }
    if modifiers.contains(Modifiers::REVERSED) {
        flags |= cell_flags::REVERSED;
    }
    if modifiers.contains(Modifiers::BLINK) {
        flags |= cell_flags::BLINK;
    }
    if modifiers.contains(Modifiers::HIDDEN) {
        flags |= cell_flags::HIDDEN;
    }
    if modifiers.contains(Modifiers::STRIKETHROUGH) {
        flags |= cell_flags::STRIKETHROUGH;
    }
    flags
}
