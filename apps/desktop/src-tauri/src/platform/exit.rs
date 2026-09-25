use crate::AppState;
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitRequest {
    pub request_id: u64,
    pub window_label: &'static str,
}

#[derive(Default)]
pub struct ExitRuntime {
    sequence: u64,
    pending: Option<ExitRequest>,
    authorized: bool,
    panel_editing: bool,
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
            window_label: if self.panel_editing {
                "edge-panel"
            } else {
                "console"
            },
        };
        self.pending = Some(request);
        Ok(request)
    }

    fn resolve(&mut self, label: &str, request_id: u64, allow: bool) -> Result<(), String> {
        if !self
            .pending
            .is_some_and(|p| p.request_id == request_id && p.window_label == label)
        {
            return Err("退出请求已失效，请重新选择退出。".into());
        }
        if allow && label == "edge-panel" {
            self.panel_editing = false;
            self.pending = Some(ExitRequest {
                request_id,
                window_label: "console",
            });
            return Ok(());
        }
        self.pending = None;
        self.authorized = allow;
        Ok(())
    }

    fn set_panel_editing(&mut self, editing: bool) -> Result<(), String> {
        if editing && (self.authorized || self.pending.is_some()) {
            return Err("请先处理当前退出请求。".into());
        }
        self.panel_editing = editing;
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

pub fn pending(app: &tauri::AppHandle, label: &str) -> Result<Option<ExitRequest>, String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(None);
    };
    let pending = state.exit.lock().map_err(|_| "退出服务暂不可用。")?.pending;
    Ok(pending.filter(|request| request.window_label == label))
}

pub fn set_panel_editing(app: &tauri::AppHandle, editing: bool) -> Result<(), String> {
    crate::task_state(app)?
        .exit
        .lock()
        .map_err(|_| "退出服务暂不可用。")?
        .set_panel_editing(editing)
}

fn present_request(app: &tauri::AppHandle, request: ExitRequest) -> Result<(), String> {
    if request.window_label == "edge-panel" {
        super::focus_panel_input(app)?;
    } else {
        super::open_console(app, serde_json::Value::Null)?;
    }
    app.emit_to(request.window_label, "sidetask:exit-requested", request)
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
    // A missing/unready WebView must not discard drafts. The console also
    // queries `pending` after registering its listener to recover this event.
    present_request(app, request)
}

pub fn resolve(
    app: &tauri::AppHandle,
    label: &str,
    request_id: u64,
    allow: bool,
) -> Result<(), String> {
    let state = crate::task_state(app)?;
    if allow && label == "console" {
        if state
            .exit
            .lock()
            .map_err(|_| "退出服务暂不可用。")?
            .pending
            .is_none_or(|p| p.request_id != request_id || p.window_label != label)
        {
            return Err("退出请求已失效，请重新选择退出。".into());
        }
        // Best effort metadata flush precedes authorization. A failed position
        // save must never trap a user who already resolved the draft handshake.
        if let Err(reason) = super::console_window::flush(app) {
            eprintln!("console position on exit: {reason}");
        }
    }
    {
        // Same order as geometry writes: dock -> service -> exit. Never wait
        // for the native main thread while any of these guards is held.
        let _dock = state.dock.lock().map_err(|_| "窗口服务暂不可用。")?;
        let _service = state.service.lock().map_err(|_| "任务服务暂不可用。")?;
        state
            .exit
            .lock()
            .map_err(|_| "退出服务暂不可用。")?
            .resolve(label, request_id, allow)?;
    }
    if allow {
        if label == "console" {
            app.exit(0);
        } else if let Some(next) = pending(app, "console")? {
            present_request(app, next)?;
        }
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
        state.resolve("console", first, false).unwrap();
        assert!(!state.authorized);
        let second = state.request().unwrap().request_id;
        assert!(state.resolve("console", first, true).is_err());
        assert!(!state.authorized);
        assert_eq!(state.pending.unwrap().request_id, second);
        state.resolve("console", second, true).unwrap();
        assert!(state.authorized);
        assert!(state.request().is_err());
        assert!(state.resolve("console", second, false).is_err());
    }

    #[test]
    fn panel_and_console_must_each_approve_their_own_drafts() {
        let mut state = ExitRuntime::default();
        state.set_panel_editing(true).unwrap();
        let request = state.request().unwrap();
        assert_eq!(request.window_label, "edge-panel");
        assert!(state.resolve("console", request.request_id, true).is_err());
        state
            .resolve("edge-panel", request.request_id, false)
            .unwrap();
        assert!(state.panel_editing);
        assert!(!state.authorized);
        let next = state.request().unwrap();
        state.resolve("edge-panel", next.request_id, true).unwrap();
        assert!(!state.authorized);
        assert_eq!(state.pending.unwrap().window_label, "console");
        assert!(state.set_panel_editing(true).is_err());
        assert!(state.resolve("edge-panel", next.request_id, true).is_err());
        state.resolve("console", next.request_id, true).unwrap();
        assert!(state.authorized);
    }
}
