use crate::AppState;
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitRequest {
    pub request_id: u64,
}

#[derive(Default)]
pub struct ExitRuntime {
    sequence: u64,
    pending: Option<ExitRequest>,
    authorized: bool,
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
        };
        self.pending = Some(request);
        Ok(request)
    }

    fn resolve(&mut self, request_id: u64, allow: bool) -> Result<(), String> {
        if self.pending.map(|p| p.request_id) != Some(request_id) {
            return Err("退出请求已失效，请重新选择退出。".into());
        }
        self.pending = None;
        self.authorized = allow;
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

pub fn pending(app: &tauri::AppHandle) -> Result<Option<ExitRequest>, String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(None);
    };
    let pending = state.exit.lock().map_err(|_| "退出服务暂不可用。")?.pending;
    Ok(pending)
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
    super::open_console(app, serde_json::Value::Null)?;
    app.emit_to("console", "sidetask:exit-requested", request)
        .map_err(|e| e.to_string())
}

pub fn resolve(app: &tauri::AppHandle, request_id: u64, allow: bool) -> Result<(), String> {
    let state = crate::task_state(app)?;
    if allow {
        if state
            .exit
            .lock()
            .map_err(|_| "退出服务暂不可用。")?
            .pending
            .map(|p| p.request_id)
            != Some(request_id)
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
            .resolve(request_id, allow)?;
    }
    if allow {
        app.exit(0);
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
        state.resolve(first, false).unwrap();
        assert!(!state.authorized);
        let second = state.request().unwrap().request_id;
        assert!(state.resolve(first, true).is_err());
        assert!(!state.authorized);
        assert_eq!(state.pending.unwrap().request_id, second);
        state.resolve(second, true).unwrap();
        assert!(state.authorized);
        assert!(state.request().is_err());
        assert!(state.resolve(second, false).is_err());
    }
}
