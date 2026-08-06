//! The exported C ABI surface (see the crate docs for the full contract).
//!
//! All functions operate on one shared [`WasmState`] behind a mutex; on
//! `wasm32-unknown-unknown` this compiles to plain globals in the module's
//! linear memory (single-threaded). Every string is passed as a `(ptr, len)`
//! pair into that memory; on the host any valid pointer works. `no_mangle +
//! extern "C"` is what makes each function a wasm export under the same name.
//!
//! Error handling: operations return `0`/`false`/a null pointer on failure and
//! record a message readable through [`tern_last_error`]. The scratch
//! allocator (`tern_alloc` / `tern_reset_alloc`) is a lazily-grown bump
//! region: pointers it hands out are valid only until the next `tern_alloc`
//! call, which the shim's write-then-call pattern respects.

use std::sync::Mutex;

use crate::{TernWasmCell, WasmState};

/// The shared binding state (lazily initialized; `tern_reset` replaces it).
static STATE: Mutex<Option<WasmState>> = Mutex::new(None);

/// Run `f` against the shared state, initializing it on first use.
fn with_state<R>(f: impl FnOnce(&mut WasmState) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let state = guard.get_or_insert_with(WasmState::new);
    f(state)
}

/// Read a `(ptr, len)` string. A zero length yields an empty string without
/// dereferencing (the wasm memory access is bounds-checked by the runtime;
/// on the host the caller passes a live pointer).
///
/// # Safety
/// `ptr` must be readable for `len` bytes (or `len` must be 0).
unsafe fn read_str(ptr: *const u8, len: usize) -> String {
    if len == 0 {
        return String::new();
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Reset the shared scene + compositor to a fresh state (all handles dropped).
#[no_mangle]
pub extern "C" fn tern_reset() {
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// The root handle: always `0`.
#[no_mangle]
pub extern "C" fn tern_root() -> u64 {
    0
}

/// Create a detached node template (`"box"`, `"text"`, `"streaming_text"`)
/// with `props` as a JSON string. Returns the handle, or `0` on error.
///
/// # Safety
/// `kind`/`props` must be `(ptr, len)` string pairs into readable memory.
#[no_mangle]
pub unsafe extern "C" fn tern_create_node(
    kind: *const u8,
    kind_len: usize,
    props: *const u8,
    props_len: usize,
) -> u64 {
    let kind = read_str(kind, kind_len);
    let props = read_str(props, props_len);
    with_state(|s: &mut WasmState| s.create_node(&kind, &props).unwrap_or_default())
}

/// Materialize the detached template `child` under the attached `parent`.
/// Returns the (now bound) child handle, or `0` on error.
#[no_mangle]
pub extern "C" fn tern_add_child(parent: u64, child: u64) -> u64 {
    with_state(|s: &mut WasmState| s.add_child(parent, child).unwrap_or_default())
}

/// Detach `handle` and its subtree from the scene. Returns `1` when anything
/// was removed, `0` otherwise.
#[no_mangle]
pub extern "C" fn tern_remove(handle: u64) -> i32 {
    with_state(|s| match s.remove(handle) {
        Ok(removed) => i32::from(removed),
        Err(_) => 0,
    })
}

/// Replace `handle`'s props (and style keys) from a JSON string. Returns `1`
/// on success.
///
/// # Safety
/// `props` must be a `(ptr, len)` string pair into readable memory.
#[no_mangle]
pub unsafe extern "C" fn tern_set_props(
    handle: u64,
    props: *const u8,
    props_len: usize,
) -> i32 {
    let props = read_str(props, props_len);
    with_state(|s| i32::from(s.set_props(handle, &props).is_ok()))
}

/// Set a single property (or style key) on `handle`: `key` and `value` are
/// JSON strings. Returns `1` on success.
///
/// # Safety
/// `key`/`value` must be `(ptr, len)` string pairs into readable memory.
#[no_mangle]
pub unsafe extern "C" fn tern_set_prop(
    handle: u64,
    key: *const u8,
    key_len: usize,
    value: *const u8,
    value_len: usize,
) -> i32 {
    let key = read_str(key, key_len);
    let value = read_str(value, value_len);
    with_state(|s| i32::from(s.set_prop(handle, &key, &value).is_ok()))
}

/// Append a styled span of `text` (JSON string) to a bound `streaming_text`
/// node, with `style` as a JSON style-key object. Returns `1` on success.
///
/// # Safety
/// `text`/`style` must be `(ptr, len)` string pairs into readable memory.
#[no_mangle]
pub unsafe extern "C" fn tern_append_span(
    handle: u64,
    text: *const u8,
    text_len: usize,
    style: *const u8,
    style_len: usize,
) -> i32 {
    let text = read_str(text, text_len);
    let style = read_str(style, style_len);
    with_state(|s| i32::from(s.append_span(handle, &text, &style).is_ok()))
}

/// Render the scene at `width` × `height` cells and return a pointer to the
/// row-major [`TernWasmCell`] array (`width * height` records; the count is
/// also readable via [`tern_cell_count`]). The pointer is valid until the
/// next render call. Returns a null pointer on error.
#[no_mangle]
pub extern "C" fn tern_render_to_cells(width: u32, height: u32) -> *const TernWasmCell {
    with_state(|s| match s.render_to_cells(width, height) {
        Ok(_) => s.cells_ptr(),
        Err(_) => std::ptr::null(),
    })
}

/// The cell count (`width * height`) of the last successful render.
#[no_mangle]
pub extern "C" fn tern_cell_count() -> u32 {
    with_state(|s| s.last_cells().len() as u32)
}

/// A pointer to the last render's symbol blob (UTF-8 cluster symbols); valid
/// until the next render call. See [`tern_cell_blob_len`].
#[no_mangle]
pub extern "C" fn tern_cell_blob_ptr() -> *const u8 {
    with_state(|s| s.last_blob().as_ptr())
}

/// The byte length of the last render's symbol blob.
#[no_mangle]
pub extern "C" fn tern_cell_blob_len() -> u32 {
    with_state(|s| s.last_blob().len() as u32)
}

/// Allocate `len` bytes in the shared bump scratch region (8-byte aligned)
/// and return the pointer, or null when the request overflows. The pointer is
/// valid only until the next `tern_alloc` call — the shim writes into it and
/// calls immediately, exactly once per string.
#[no_mangle]
pub extern "C" fn tern_alloc(len: usize) -> *mut u8 {
    with_state(|s| s.alloc_bytes(len).unwrap_or(std::ptr::null_mut()))
}

/// Reset the bump scratch allocator (all previously handed-out regions are
/// reclaimed; pointers into them must not be used afterwards).
#[no_mangle]
pub extern "C" fn tern_reset_alloc() {
    with_state(|s| s.reset_alloc());
}

/// Copy the message of the last failed operation (UTF-8) into `dst`
/// (capacity `cap`) and return the message's **full** byte length (so a
/// 0-capacity probe learns the size before allocating). An empty message
/// means the last operation succeeded. `dst` may be null when `cap` is 0.
///
/// # Safety
/// `dst` must be writable for `cap` bytes (or `cap` must be 0).
#[no_mangle]
pub unsafe extern "C" fn tern_last_error(dst: *mut u8, cap: usize) -> usize {
    let msg = with_state(|s| s.last_error().as_bytes().to_vec());
    let n = msg.len();
    let written = n.min(cap);
    if written > 0 {
        std::ptr::copy_nonoverlapping(msg.as_ptr(), dst, written);
    }
    n
}
