//! Signal-safe terminal lifecycle (unix only).
//!
//! Registered by [`TuiRenderer::new`] for every non-headless renderer, a
//! dedicated `tern-signals` thread owns the process's job-control and
//! termination signals and drives the renderer's terminal through them:
//!
//! * **SIGINT / SIGTERM / SIGHUP** — clean exit: the full idempotent
//!   destroy-style teardown (stop the event loop, pop the keyboard
//!   enhancement if pushed, disable event listening, leave the alternate
//!   screen, exit raw mode), flush the restore sequences out of the buffered
//!   stdout, then restore the default disposition and re-raise the signal so
//!   the parent shell reports signal termination (`128 + signum`: 130 / 143 /
//!   129).
//! * **SIGTSTP** (Ctrl+Z) — suspend: restore the terminal to its
//!   pre-renderer state, notify JS via a `"suspend"` lifecycle event, drop
//!   this library's TSTP handler (the disposition that preceded tern —
//!   typically the shell's default — is restored), and re-raise SIGTSTP so
//!   the shell's job control stops the process. The app is then a normal
//!   stopped background job: the shell repaints its prompt, `fg`/`%1` works.
//! * **SIGCONT** — resume: re-enter raw mode + the alternate screen +
//!   event listening + the keyboard enhancement (only what was pushed),
//!   invalidate the cached size and drop the retained frame so the next
//!   `render()` repaints the full screen (the terminal shows the primary
//!   screen after the suspend, not the previous frame), notify JS via a
//!   `"resume"` lifecycle event, and re-arm the SIGTSTP handler so the next
//!   Ctrl+Z suspends cleanly again.
//!
//! ## Handler installation
//!
//! The exit signals (SIGINT / SIGTERM / SIGHUP) are installed with a raw
//! [`libc::sigaction`] that **replaces** the process's handler. They cannot
//! go through signal-hook's registry: the registry *chains* — its handler
//! invokes the previously-installed handler first ([`signal_hook_registry`]
//! docs), and the JS runtime (Node/Deno) installs its own SIGINT/SIGTERM/
//! SIGHUP watchers at startup that re-raise the signal with the default
//! disposition and kill the process before the flag thread can restore the
//! terminal. The raw handler only sets an [`AtomicBool`] (async-signal-safe);
//! the thread polls the flags every 50 ms and does the terminal work in
//! normal thread context. SIGTSTP / SIGCONT do use the registry
//! ([`signal_hook::flag::register`]) — the runtime installs no watcher for
//! them, so chaining cannot race a premature process exit.
//!
//! Destroying the renderer stops the thread and restores the process's
//! default signal dispositions.

use super::*;
use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGCONT, SIGTERM, SIGTSTP};
use signal_hook::flag;
use signal_hook::low_level;
use signal_hook::SigId;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// How often the signal thread re-checks its flags while idle: the latency
/// between a signal's arrival and its handling. Matches the event loop's
/// own poll interval, and the thread burns no CPU while parked.
const SIGNAL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The exit-signal flags, set inside the async-signal-safe raw handler (one
/// flag per signal; the signal number indexes them). The signal thread swaps
/// them false when it handles the corresponding signal.
static EXIT_INT_FLAG: AtomicBool = AtomicBool::new(false);
static EXIT_TERM_FLAG: AtomicBool = AtomicBool::new(false);
static EXIT_HUP_FLAG: AtomicBool = AtomicBool::new(false);

/// The exit-signal handler, installed with a raw [`libc::sigaction`] so it
/// REPLACES whatever the process had — see the module docs for why the
/// chaining registry would lose the race to the JS runtime's own watchers.
///
/// # Safety
///
/// Async-signal-safe: only atomic stores and integer compares, no allocation,
/// no locks, no I/O.
unsafe extern "C" fn exit_handler(sig: libc::c_int) {
    match sig {
        SIGINT => EXIT_INT_FLAG.store(true, Ordering::Relaxed),
        SIGTERM => EXIT_TERM_FLAG.store(true, Ordering::Relaxed),
        SIGHUP => EXIT_HUP_FLAG.store(true, Ordering::Relaxed),
        _ => {}
    }
}

/// Install [`exit_handler`] for `signal`, replacing the current disposition.
fn install_exit_handler(signal: libc::c_int) -> Result<()> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = exit_handler as *const () as usize;
    action.sa_flags = 0;
    // SAFETY: `sigemptyset` is async-signal-safe and cannot fail for a
    // valid signal mask; `sigaction` with a fully initialized `action` is a
    // plain syscall wrapper. The pointer to `action` outlives the call.
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
            return Err(Error::from_reason(format!(
                "sigaction({signal}): {}",
                std::io::Error::last_os_error()
            )));
        }
    }
    Ok(())
}

/// Whether [`exit_handler`] currently owns SIGINT / SIGTERM / SIGHUP.
///
/// The JS runtime (Node/Deno) installs its own SIGINT/SIGTERM/SIGHUP
/// watchers at startup or lazily during the first event-loop window, which
/// replaces our sigaction. The signal thread calls this on every poll and
/// re-installs the handler when the runtime clobbered it, so a termination
/// signal arriving at an arbitrary time hits our handler (and the terminal
/// teardown) with at most one poll interval of exposure.
fn exit_handlers_installed() -> bool {
    for sig in [SIGINT, SIGTERM, SIGHUP] {
        let mut sa: libc::sigaction = unsafe { std::mem::zeroed() };
        // SAFETY: sigaction with a null new-action only reads the current
        // disposition; cannot fail for these standard signals.
        if unsafe { libc::sigaction(sig, std::ptr::null(), &mut sa) } != 0 {
            return false;
        }
        if sa.sa_sigaction as usize != exit_handler as *const () as usize {
            return false;
        }
    }
    true
}

/// The handle to a live renderer's signal lifecycle thread.
///
/// Owned by [`RendererInner`] (non-headless renderers only). Dropping the
/// thread handle does not stop the thread; call [`stop`](Self::stop) to make
/// it exit and restore the process's default signal dispositions.
pub(crate) struct SignalHandles {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// The registry actions of the flag-registered signals (SIGCONT, and
    /// SIGTSTP's when the thread is not suspended), kept so
    /// [`stop`](Self::stop) can remove them from the registry. The exit
    /// signals are installed with raw sigaction and carry no registry id.
    sigids: Vec<SigId>,
}

impl SignalHandles {
    /// Ask the signal thread to exit, then restore the process's signal
    /// dispositions: the kernel-level sigaction is reset to `SIG_DFL` for
    /// every signal tern took over, and the registry actions are removed.
    ///
    /// The kernel reset is the authoritative part — `unregister` alone would
    /// leave signal-hook's handler installed, which *ignores* the signal
    /// instead of running the default action (so a post-destroy Ctrl+C
    /// would do nothing). The unregister is hygiene against the registry.
    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        for sig in [SIGINT, SIGTERM, SIGHUP, SIGTSTP, SIGCONT] {
            // SAFETY: `signal` with SIG_DFL is async-signal-safe and cannot
            // fail for these standard signals (a null/error return is
            // ignored — best-effort restore).
            unsafe {
                libc::signal(sig, libc::SIG_DFL);
            }
        }
        for id in self.sigids.drain(..) {
            low_level::unregister(id);
        }
    }
}

/// Register the renderer's signal handlers and spawn the signal thread.
///
/// Called from [`TuiRenderer::new`] for non-headless renderers only (a
/// headless renderer never touches a terminal, so no signals are taken
/// over). Registers every handler before spawning the thread — the
/// registration order also makes the first-signal race impossible: a signal
/// that arrives between the first and last registration is caught by the
/// already-installed handler.
pub(crate) fn register_signals(inner: Arc<Mutex<RendererInner>>) -> Result<SignalHandles> {
    let stop = Arc::new(AtomicBool::new(false));
    // Exit signals first, installed with a raw sigaction that replaces the
    // runtime's watchers (see the module docs — chaining would let the
    // runtime's handler kill the process before the thread restores the
    // terminal).
    for sig in [SIGINT, SIGTERM, SIGHUP] {
        install_exit_handler(sig)?;
    }
    let tstp_flag = Arc::new(AtomicBool::new(false));
    let cont_flag = Arc::new(AtomicBool::new(false));
    let mut sigids = Vec::new();
    sigids.push(
        flag::register(SIGCONT, cont_flag.clone())
            .map_err(|e| Error::from_reason(format!("register SIGCONT: {e}")))?,
    );
    // The SIGTSTP registration is owned by the thread (not the handle): the
    // suspend path unregisters it and re-raises with the default
    // disposition, and the resume path re-registers it for the next Ctrl+Z.
    // `SigId` is Copy — the copy here lets the thread unregister the action
    // later while the registry stays under the thread's control.
    let tstp_id = flag::register(SIGTSTP, tstp_flag.clone())
        .map_err(|e| Error::from_reason(format!("register SIGTSTP: {e}")))?;
    let thread_stop = stop.clone();
    let thread = std::thread::Builder::new()
        .name("tern-signals".to_string())
        .spawn(move || {
            let mut tstp_sigid: Option<SigId> = Some(tstp_id);
            let mut suspended = false;
            loop {
                // The JS runtime (Node/Deno) installs its own SIGINT/SIGTERM/
                // SIGHUP watchers when its event loop first activates, AFTER
                // the renderer's constructor ran — displacing our raw
                // sigaction. Re-arm whenever the kernel disposition is not
                // ours, so the runtime's one-time install cannot leave the
                // process without the clean-exit handler (a stray TERM would
                // then kill without restoring the terminal).
                if !exit_handlers_installed() {
                    for sig in [SIGINT, SIGTERM, SIGHUP] {
                        let _ = install_exit_handler(sig);
                    }
                }
                if thread_stop.load(Ordering::Relaxed) {
                    // The renderer was destroyed: exit. `stop` resets the
                    // kernel dispositions on the renderer's side.
                    break;
                }
                if EXIT_INT_FLAG.swap(false, Ordering::Relaxed) {
                    exit_signal(&inner, SIGINT);
                }
                if EXIT_TERM_FLAG.swap(false, Ordering::Relaxed) {
                    exit_signal(&inner, SIGTERM);
                }
                if EXIT_HUP_FLAG.swap(false, Ordering::Relaxed) {
                    exit_signal(&inner, SIGHUP);
                }
                if tstp_flag.swap(false, Ordering::Relaxed) {
                    if suspend(&inner, &mut tstp_sigid) {
                        // Only reachable after SIGCONT resumes us: the
                        // re-raised TSTP stopped the process here.
                        suspended = true;
                    }
                }
                if cont_flag.swap(false, Ordering::Relaxed) && suspended {
                    resume(&inner, &tstp_flag, &mut tstp_sigid);
                    suspended = false;
                }
                std::thread::park_timeout(SIGNAL_POLL_INTERVAL);
            }
        })
        .map_err(|e| Error::from_reason(format!("spawn signal thread: {e}")))?;
    Ok(SignalHandles {
        stop,
        thread: Some(thread),
        sigids,
    })
}

/// A termination signal (SIGINT / SIGTERM / SIGHUP): run the same idempotent
/// teardown as [`TuiRenderer::destroy`], flush the restore sequences out of
/// the buffered stdout (a raw process exit would drop them, leaving the
/// terminal stuck in raw mode / on the alternate screen), then restore the
/// default disposition and re-raise so the parent shell reports a
/// signal-terminated child (`128 + signum`). Never returns.
fn exit_signal(inner: &Arc<Mutex<RendererInner>>, signal: i32) -> ! {
    // Recover from a poisoned lock: the teardown MUST run — a terminal left
    // in raw mode after exit is worse than whatever poisoned the mutex.
    let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
    guard.teardown();
    drop(guard);
    // The teardown queued the restore escape sequences into the process's
    // buffered stdout; flush them while the terminal is still ours.
    let _ = std::io::stdout().flush();
    // Sets SIG_DFL and raises: the default action terminates the process,
    // so the parent sees WIFSIGNALED with the correct signal number.
    let _ = low_level::emulate_default_handler(signal);
    // Unreachable in practice (emulate_default_handler re-raises), kept as
    // a safety net in case the raise failed.
    std::process::exit(128 + signal);
}

/// Suspend for shell job control: restore the terminal, notify JS, restore
/// the default SIGTSTP disposition, and re-raise SIGTSTP so the shell stops
/// the process. Returns `true` when the re-raise happened (the process is
/// now stopped; the caller records the suspended state for the SIGCONT
/// resume). Returns `false` — doing nothing — when the renderer is already
/// destroyed: there is no terminal left to restore, and re-raising would
/// stop the app for no reason.
fn suspend(inner: &Arc<Mutex<RendererInner>>, tstp_sigid: &mut Option<SigId>) -> bool {
    let live = {
        let Ok(mut guard) = inner.lock() else {
            return false;
        };
        if guard.destroyed {
            return false;
        }
        guard.restore_terminal();
        true
    };
    if !live {
        return false;
    }
    notify_js(inner, "suspend");
    // Remove our TSTP action from the registry so the resume path's
    // re-registration installs a fresh kernel sigaction (the registry treats
    // a signal with no actions as uninstalled). The kernel disposition is
    // then reset to SIG_DFL and the signal re-raised, so the shell's job
    // control stops the process exactly as if tern had never been there.
    if let Some(id) = tstp_sigid.take() {
        low_level::unregister(id);
    }
    let _ = low_level::emulate_default_handler(SIGTSTP);
    true
}

/// Resume after a suspend/continue cycle: re-enter the terminal (raw mode,
/// alternate screen, event listening, keyboard enhancement / any-event mouse
/// as pushed), force a full repaint on the next render, notify JS, and
/// re-arm the SIGTSTP handler.
fn resume(
    inner: &Arc<Mutex<RendererInner>>,
    tstp_flag: &Arc<AtomicBool>,
    tstp_sigid: &mut Option<SigId>,
) {
    if let Ok(mut guard) = inner.lock() {
        if !guard.destroyed {
            guard.resume_terminal();
        }
    }
    notify_js(inner, "resume");
    // Re-arm the TSTP handler so the next Ctrl+Z suspends cleanly again. A
    // failure leaves the disposition at its restored default (a second
    // Ctrl+Z would stop the process without terminal restore) — best-effort.
    if tstp_sigid.is_none() {
        if let Ok(id) = flag::register(SIGTSTP, tstp_flag.clone()) {
            *tstp_sigid = Some(id);
        }
    }
}

/// Push a lifecycle event (`"suspend"` / `"resume"`) to the JS thread
/// through the push-channel tsfn handed over by `start_event_stream`. A
/// no-op before the stream starts (or under `poll-fallback`, which has no
/// push channel).
#[cfg(feature = "push-events")]
fn notify_js(inner: &Arc<Mutex<RendererInner>>, phase: &str) {
    let tsfn = {
        let Ok(guard) = inner.lock() else {
            return;
        };
        guard.signal_tsfn.clone()
    };
    if let Some(tsfn) = tsfn {
        let _ = tsfn.call(
            Ok(TernEventJs::lifecycle(phase)),
            napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

/// No push channel under `poll-fallback`: lifecycle notifications are
/// dropped (the suspend/resume terminal transitions still happen).
#[cfg(not(feature = "push-events"))]
fn notify_js(_inner: &Arc<Mutex<RendererInner>>, _phase: &str) {}
