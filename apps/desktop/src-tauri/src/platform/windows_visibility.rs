//! Show an already-confirmed edge frame without restoring its creation frame,
//! then synchronize Tao's visibility state in the same main-thread turn.

use std::{
    ffi::c_void,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{WebviewWindow, WindowEvent};

// Native resize/move notifications may arrive after the show-time checks. The
// callback cannot take the coordinator lock (it may be waiting on this thread).
// Coalesce notifications, then let the worker verify the cached geometry once.
static GEOMETRY_CHANGED: GeometryChanges = GeometryChanges(AtomicBool::new(false));

struct GeometryChanges(AtomicBool);

impl GeometryChanges {
    fn observe(&self, event: &WindowEvent) {
        if matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            self.0.store(true, Ordering::Release);
        }
    }

    fn take(&self) -> bool {
        self.0.swap(false, Ordering::AcqRel)
    }
}

pub fn observe_geometry(window: &WebviewWindow) {
    window.on_window_event(|event| GEOMETRY_CHANGED.observe(event));
}

pub fn take_geometry_change() -> bool {
    GEOMETRY_CHANGED.take()
}

const SHOW_TIMEOUT: Duration = Duration::from_secs(2);
const EXPIRED_SHOW: &str = "小窗原生显示超时，已取消本次显示；请重试窗口设置。";
const SW_HIDE: i32 = 0;
const SW_SHOWNA: i32 = 8;

enum ShowState {
    Pending,
    Running,
    Cancelled,
    Completed(Result<(), String>),
}

struct ShowTransaction {
    deadline: Instant,
    state: Mutex<ShowState>,
}

impl ShowTransaction {
    fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            state: Mutex::new(ShowState::Pending),
        }
    }

    fn begin(&self, now: Instant) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if now < self.deadline && matches!(*state, ShowState::Pending) {
            *state = ShowState::Running;
            true
        } else {
            false
        }
    }

    fn is_active(&self, now: Instant) -> bool {
        now < self.deadline
            && self
                .state
                .lock()
                .is_ok_and(|state| matches!(*state, ShowState::Running))
    }

    /// A false return requires compensating hide before the main-thread turn ends.
    fn finish(&self, result: Result<(), String>, now: Instant) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if now < self.deadline && matches!(*state, ShowState::Running) {
            *state = ShowState::Completed(result);
            true
        } else {
            false
        }
    }

    fn result_or_cancel(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| EXPIRED_SHOW.to_string())?;
        if let ShowState::Completed(result) = &*state {
            // The result may win the race with recv_timeout's deadline, even if
            // the wake-up message has not been delivered to the worker yet.
            result.clone()
        } else {
            *state = ShowState::Cancelled;
            Err(EXPIRED_SHOW.into())
        }
    }
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ShowWindow(window: *mut c_void, command: i32) -> i32;
}

pub fn show_current_frame_then_sync(window: &WebviewWindow) -> Result<(), String> {
    if !matches!(window.label(), "edge-panel" | "edge-handle") {
        return Err("原生小窗显示仅适用于侧边窗口。".into());
    }
    let transaction = Arc::new(ShowTransaction::new(Instant::now() + SHOW_TIMEOUT));
    let operation = transaction.clone();
    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if !operation.begin(Instant::now()) {
                let _ = tx.send(());
                return;
            }
            let mut native_handle = None;
            let result = (|| {
                let handle = target.hwnd().map_err(|error| error.to_string())?.0;
                native_handle = Some(handle);
                if !operation.is_active(Instant::now()) {
                    return Err(EXPIRED_SHOW.into());
                }
                // SW_SHOWNA preserves the current frame. Its return value is the
                // previous visibility, not an error indicator.
                // SAFETY: Tauri owns this live HWND and this is its owner thread.
                unsafe { ShowWindow(handle, SW_SHOWNA) };
                if !operation.is_active(Instant::now()) {
                    return Err(EXPIRED_SHOW.into());
                }
                // Synchronize Tao VISIBLE so its ordinary hide remains effective.
                // The locked runtime dispatches this main-thread call immediately.
                target.show().map_err(|error| error.to_string())
            })();
            let failed = result.is_err();
            let committed = operation.finish(result, Instant::now());
            if failed || !committed {
                if let Some(handle) = native_handle {
                    // A timeout between native show and Tao synchronization must
                    // hide even when Tao still thinks the HWND is already hidden.
                    // SAFETY: same live HWND, still on its owning main thread.
                    unsafe { ShowWindow(handle, SW_HIDE) };
                }
                if let Err(error) = target.hide() {
                    let _ = writeln!(std::io::stderr(), "cancelled edge show hide: {error}");
                }
            }
            let _ = tx.send(());
        })
        .map_err(|error| error.to_string())?;
    // Expiration cancels this exact operation. A queued callback cannot reveal
    // it later. An in-flight synchronous Win32 call cannot be preempted safely;
    // on return its callback checks expiration and hides before leaving the UI
    // turn. Existing recovery queues after that turn, so old cleanup cannot hide
    // a subsequent retry. Never hold the transaction lock across native calls.
    let _ = rx.recv_timeout(SHOW_TIMEOUT);
    transaction.result_or_cancel()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_events_coalesce_and_later_changes_are_not_lost() {
        let changes = GeometryChanges(AtomicBool::new(false));
        assert!(!changes.take());
        changes.observe(&WindowEvent::Resized(tauri::PhysicalSize::new(202, 138)));
        changes.observe(&WindowEvent::Moved(tauri::PhysicalPosition::new(2358, 624)));
        assert!(changes.take());
        assert!(!changes.take());
        changes.observe(&WindowEvent::Resized(tauri::PhysicalSize::new(27, 138)));
        assert!(changes.take());
    }

    #[test]
    fn focus_events_do_not_trigger_geometry_checks() {
        let changes = GeometryChanges(AtomicBool::new(false));
        changes.observe(&WindowEvent::Focused(true));
        changes.observe(&WindowEvent::Focused(false));
        assert!(!changes.take());
    }

    #[test]
    fn queued_callback_cannot_show_after_worker_cancels() {
        let now = Instant::now();
        let operation = ShowTransaction::new(now + SHOW_TIMEOUT);
        assert!(operation.result_or_cancel().is_err());
        assert!(!operation.begin(now));
        assert!(!operation.is_active(now));
    }

    #[test]
    fn queued_callback_cannot_begin_after_deadline_without_worker_wakeup() {
        let now = Instant::now();
        let deadline = now + SHOW_TIMEOUT;
        let operation = ShowTransaction::new(deadline);
        assert!(!operation.begin(deadline));
    }

    #[test]
    fn cancellation_during_native_show_requires_compensating_hide() {
        let now = Instant::now();
        let operation = ShowTransaction::new(now + SHOW_TIMEOUT);
        assert!(operation.begin(now));
        assert!(operation.result_or_cancel().is_err());
        assert!(!operation.is_active(now));
        assert!(!operation.finish(Ok(()), now));
    }

    #[test]
    fn native_call_that_outlives_deadline_cannot_commit_success() {
        let now = Instant::now();
        let deadline = now + SHOW_TIMEOUT;
        let operation = ShowTransaction::new(deadline);
        assert!(operation.begin(now));
        assert!(!operation.is_active(deadline));
        assert!(!operation.finish(Ok(()), deadline));
        assert!(operation.result_or_cancel().is_err());
    }

    #[test]
    fn completed_result_wins_race_with_worker_timeout() {
        let now = Instant::now();
        let operation = ShowTransaction::new(now + SHOW_TIMEOUT);
        assert!(operation.begin(now));
        assert!(operation.finish(Ok(()), now));
        assert_eq!(operation.result_or_cancel(), Ok(()));
    }
}
