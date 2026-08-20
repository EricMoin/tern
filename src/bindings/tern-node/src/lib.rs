//! tern-node — napi binding between Deno/Node.js and tern-core.
//!
//! This is the layer the JS reconciler (`packages/core`) talks to. It exposes
//! two surfaces:
//!
//! * **`TuiRenderer`** — owns the terminal lifecycle (raw mode + alternate
//!   screen via tern-terminal, skippable with `use_alt_screen` for inline
//!   rendering), the scene, and the render loop: `root()` returns a handle to
//!   the scene root, `start_event_stream(callback)` pushes terminal events
//!   (keys, resizes, focus changes, mouse, and paste) to the JS thread
//!   through a napi `ThreadsafeFunction` fed by tern-terminal's background
//!   event loop, `render()` paints the scene to the terminal,
//!   `set_title(title)` sets the terminal window title, `capabilities`
//!   reports the detected color support, and `destroy()` tears the terminal
//!   state back down. The pull-based `poll_events` fallback remains
//!   available behind the `poll-fallback` cargo feature (default build ships
//!   push delivery).
//! * **Scene construction** — `create_node(type, props)` builds a node
//!   handle (backed by the tern-components node model), and `NodeHandle`
//!   methods (`add_child` / `remove` / `set_props` / `set_prop`) mutate the
//!   shared scene tree that `TuiRenderer::render` paints.
//!
//! ## Scene ownership
//!
//! The binding keeps **one module-global scene** (`shared_scene()`): both
//! `create_node` (module-level) and every `TuiRenderer` operate on the same
//! tree. This mirrors the architecture doc — `tern-node` is the single bridge
//! into the tern-core scene tree, and the MVP JS reconciler drives exactly one
//! renderer. Multiple renderers would render the same scene; creating more
//! than one is documented as out of scope for the MVP.
//!
//! All shared state lives behind `Arc<Mutex<_>>`, which keeps the napi class
//! instances `Send + Sync` (required by napi-rs) and makes every method safe
//! to call from the JS thread.
//!
//! ## Event delivery
//!
//! With the default `push-events` feature, [`TuiRenderer::start_event_stream`]
//! builds a `ThreadsafeFunction<TernEventJs>` from the JS callback and spawns
//! tern-terminal's event loop thread, which pushes every normalized event to
//! the JS thread (unbounded queue — no event loss, no polling loop in the JS
//! hot path). The loop stops when the renderer is destroyed, when a ctrl+c
//! teardown is requested (`exit_on_ctrl_c`), or when the JS side releases the
//! stream. With `exit_on_ctrl_c`, a Ctrl+C press is still delivered to JS so
//! push-mode consumers observe it, and the renderer is torn down + marked
//! destroyed right after. With the `poll-fallback` feature instead,
//! `poll_events(timeout_ms)` returns event batches on demand (the pre-Phase-3
//! pull path, for hosts that cannot host a napi JS thread).

use std::collections::HashMap;
use std::io;
#[cfg(feature = "push-events")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(feature = "poll-fallback")]
use std::time::Duration;

use napi::bindgen_prelude::*;

#[cfg(feature = "push-events")]
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

use tern_components::{Compositor, detect_vertical_scroll, exposed_band_updates};
use tern_core::buffer::{diff, Buffer};
use tern_core::cell::CellUpdate;
use tern_core::rect::Rect;
use tern_core::scene::{NodeId, NodeKind, PropMap, PropValue, Scene, Span};
use tern_core::style::{BorderStyle, Modifiers, Style, UnderlineStyle};
use tern_core::{Color, Cursor, Size};
use tern_terminal::backend::{Backend, ScrollOp};
#[cfg(feature = "poll-fallback")]
use tern_terminal::event as event_module;
use tern_terminal::event::KeyName;
#[cfg(feature = "push-events")]
use tern_terminal::event::{spawn_event_loop, EventLoopHandle};
#[cfg(any(feature = "push-events", feature = "poll-fallback"))]
use tern_terminal::event::{KeyKind, MouseButton, MouseEventKind, TernEvent, TernKey, TernMouse};

/// The one module-global scene tree. Both node construction and rendering
/// operate on it (see module docs for the ownership rationale).
fn shared_scene() -> &'static Arc<Mutex<Scene>> {
    static SCENE: OnceLock<Arc<Mutex<Scene>>> = OnceLock::new();
    SCENE.get_or_init(|| Arc::new(Mutex::new(Scene::new())))
}

/// The last viewport the shared scene was laid out at — the terminal size the
/// most recent [`TuiRenderer::render`] used. `NodeHandle::content_size` lays
/// the scene out at this viewport so its geometry matches what is on screen;
/// before any render it defaults to 80x24.
fn shared_viewport_ref() -> &'static Mutex<(u32, u32)> {
    static VIEWPORT: OnceLock<Mutex<(u32, u32)>> = OnceLock::new();
    VIEWPORT.get_or_init(|| Mutex::new((80, 24)))
}

/// Sentinel for [`RendererInner::last_viewport`]: no render has painted yet.
/// A real terminal is never 0 columns by 0 rows, so this doubles as the
/// "a viewport was already recorded" guard that keeps a fresh renderer from
/// taking the no-op fast path before its first paint.
const NO_VIEWPORT: (u16, u16) = (0, 0);

mod backend;
mod convert;
mod node;
mod renderer;
#[cfg(unix)]
mod signals;
mod types;

// Re-export the napi surface (and crate-internal helpers) at the crate
// root: keeps the public API stable and the `#[napi]` items discoverable.
pub(crate) use backend::*;
pub use convert::*;
pub use node::*;
pub use renderer::*;
#[cfg(unix)]
pub(crate) use signals::*;
pub use types::*;

#[cfg(test)]
mod tests;
