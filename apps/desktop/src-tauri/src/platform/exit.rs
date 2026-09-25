use crate::AppState;
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitRequest {
    pub request_id: u64,
    pub window: &'static str,
}

#[derive(Default)]
pub struct ExitRuntime {
    sequence: u64,
    pending: Option<ExitRequest>,
    authorized: bool,
    panel_prompt: bool,
}

impl ExitRuntime {
    fn request(&mut self) -> Result<ExitRequest, String> {
        if self.authorized {
            return Err("应用正在退出。".into());
        }
        // Repeated menu clicks address the same confirmation instead of
        // invalidating a save/discard decision which is already in progress.
        if let Some(request) = self.pending {
            return Ok(request);
        }
        self.sequence = self.sequence.checked_add(1).ok_or("退出请求编号已耗尽。")?;
        let request = ExitRequest {
            request_id: self.sequence,
            window: "edge-panel",
        };
        self.pending = Some(request);
        Ok(request)
    }

    fn resolve(&mut self, window: &str, request_id: u64, allow: bool) -> Result<(), String> {
        let pending = self.pending.ok_or("退出请求已失效，请重新选择退出。")?;
        if pending.request_id != request_id
            || (allow && pending.window != window)
            || !["console", "edge-panel"].contains(&window)
        {
            return Err("退出请求已失效，请重新选择退出。".into());
        }
        self.panel_prompt = false;
        if allow && window == "edge-panel" {
            self.pending = Some(ExitRequest {
                window: "console",
                ..pending
            });
        } else {
            self.pending = None;
            self.authorized = allow;
        }
        Ok(())
    }
}

pub fn is_authorized(app: &tauri::AppHandle) -> bool {
    if let Some(state) = app.try_state::<AppState>() {
        state
            .exit
            .lock()
            .map(|exit| exit.authorized)
            .unwrap_or(false)
    } else if let Some(recovery) = app.try_state::<super::startup_recovery::RecoveryState>() {
        recovery.is_exit_authorized()
    } else {
        // Initialization did not install either runtime: no draft or database
        // operation exists to protect, and shutdown must not panic or deadlock.
        true
    }
}

/// Call while holding the task service lock, so a final exit approval cannot
/// race a write that has already passed this guard.
pub fn ensure_running(state: &AppState) -> Result<(), String> {
    if state
        .exit
        .lock()
        .map_err(|_| "退出服务暂不可用。")?
        .authorized
    {
        Err("应用正在退出，操作尚未保存。".into())
    } else {
        Ok(())
    }
}

pub fn pending(app: &tauri::AppHandle, window: &str) -> Result<Option<ExitRequest>, String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(None);
    };
    let pending = state.exit.lock().map_err(|_| "退出服务暂不可用。")?.pending;
    // A reattached panel must remain frozen after its stage was approved.
    Ok(pending.filter(|request| request.window == window || window == "edge-panel"))
}

pub fn is_pending(state: &AppState) -> Result<bool, String> {
    Ok(state
        .exit
        .lock()
        .map_err(|_| "退出服务暂不可用。")?
        .pending
        .is_some())
}

/// A paused panel can temporarily present its draft confirmation without
/// changing the saved edge-enabled preference.
pub fn panel_prompt_visible(state: &AppState) -> Result<bool, String> {
    Ok(state
        .exit
        .lock()
        .map_err(|_| "退出服务暂不可用。")?
        .panel_prompt)
}

pub fn prepare_panel_prompt(app: &tauri::AppHandle, request_id: u64) -> Result<(), String> {
    let state = crate::task_state(app)?;
    let mut exit = state.exit.lock().map_err(|_| "退出服务暂不可用。")?;
    if !exit
        .pending
        .is_some_and(|request| request.request_id == request_id && request.window == "edge-panel")
    {
        return Err("退出请求已失效，请重新选择退出。".into());
    }
    exit.panel_prompt = true;
    Ok(())
}

fn dispatch(app: &tauri::AppHandle, request: ExitRequest) -> Result<(), String> {
    // Clean panel requests are acknowledged without opening either surface.
    // Its frontend explicitly presents the panel only when a draft needs input.
    if request.window == "console" {
        super::open_console(app, serde_json::Value::Null)?;
    }
    app.emit_to(request.window, "sidetask:exit-requested", request)
        .map_err(|e| e.to_string())
}

pub fn request(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<AppState>() else {
        let should_exit =
            if let Some(recovery) = app.try_state::<super::startup_recovery::RecoveryState>() {
                recovery.request_exit()?
            } else {
                true
            };
        if should_exit {
            app.exit(0);
        }
        return Ok(());
    };
    let request = state
        .exit
        .lock()
        .map_err(|_| "退出服务暂不可用。")?
        .request()?;
    // An unready surface cannot authorize exit. Both surfaces query `pending`
    // after installing their listener, so a lost startup event is recoverable.
    dispatch(app, request)
}

pub fn resolve(
    app: &tauri::AppHandle,
    window: &str,
    request_id: u64,
    allow: bool,
) -> Result<(), String> {
    let state = crate::task_state(app)?;
    if allow && window == "console" {
        if state
            .exit
            .lock()
            .map_err(|_| "退出服务暂不可用。")?
            .pending
            .map(|p| (p.request_id, p.window))
            != Some((request_id, "console"))
        {
            return Err("退出请求已失效，请重新选择退出。".into());
        }
        // Best effort metadata flush precedes authorization. A failed position
        // save must never trap a user who already resolved the draft handshake.
        if let Err(reason) = super::console_window::flush(app) {
            eprintln!("console position on exit: {reason}");
        }
    }
    let (next, authorized) = {
        // Same order as geometry writes: dock -> service -> exit. Never wait
        // for the native main thread while any of these guards is held.
        let mut dock = state.dock.lock().map_err(|_| "窗口服务暂不可用。")?;
        let _service = state.service.lock().map_err(|_| "任务服务暂不可用。")?;
        let mut exit = state.exit.lock().map_err(|_| "退出服务暂不可用。")?;
        exit.resolve(window, request_id, allow)?;
        // A click observed while a confirmation was active must not hide a
        // newly editable panel after a later cancellation/stage transition.
        dock.pointer_boundary = std::time::Instant::now();
        (exit.pending, exit.authorized)
    };
    if authorized {
        app.exit(0);
    } else if let Some(next) = next {
        // Freeze the approving panel until console confirmation finishes. A
        // failed console reveal returns ownership to the panel for retry.
        if let Err(reason) = dispatch(app, next) {
            let mut exit = state.exit.lock().map_err(|_| "退出服务暂不可用。")?;
            if exit.pending.is_some_and(|pending| {
                pending.request_id == request_id && pending.window == "console"
            }) {
                exit.pending = Some(ExitRequest {
                    window: "edge-panel",
                    ..next
                });
            }
            return Err(reason);
        }
    } else {
        app.emit(
            "sidetask:exit-cancelled",
            ExitRequest {
                request_id,
                window: "console",
            },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_stale_replies_never_authorize_exit() {
        let mut state = ExitRuntime::default();
        let first = state.request().unwrap().request_id;
        assert_eq!(state.request().unwrap().request_id, first);
        state.resolve("edge-panel", first, false).unwrap();
        assert!(!state.authorized);
        let second = state.request().unwrap().request_id;
        assert!(state.resolve("edge-panel", first, true).is_err());
        assert!(!state.authorized);
        assert_eq!(state.pending.unwrap().request_id, second);
        assert!(state.resolve("console", second, true).is_err());
        state.resolve("edge-panel", second, true).unwrap();
        assert!(!state.authorized);
        assert_eq!(state.pending.unwrap().window, "console");
        assert!(state.resolve("edge-panel", second, true).is_err());
        state.resolve("console", second, true).unwrap();
        assert!(state.authorized);
        assert!(state.request().is_err());
        assert!(state.resolve("console", second, false).is_err());
    }

    #[test]
    fn panel_can_cancel_after_approval_and_a_new_request_starts_with_panel() {
        let mut state = ExitRuntime::default();
        let first = state.request().unwrap().request_id;
        state.panel_prompt = true;
        state.resolve("edge-panel", first, true).unwrap();
        assert!(!state.panel_prompt);
        assert_eq!(state.request().unwrap().window, "console");
        assert!(state.resolve("edge-handle", first, false).is_err());
        state.resolve("edge-panel", first, false).unwrap();
        assert!(!state.authorized);
        let second = state.request().unwrap();
        assert!(second.request_id > first);
        assert_eq!(second.window, "edge-panel");
        assert!(state.resolve("console", first, true).is_err());
    }
}
