mod application;
mod domain;
mod infrastructure;
mod platform;

use application::TaskService;
use domain::{Action, Snapshot};
use infrastructure::SqliteRepository;
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub service: Mutex<TaskService>,
    pub dock: Mutex<platform::DockRuntime>,
    pub exit: Mutex<platform::exit::ExitRuntime>,
}

fn require_window(label: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&label) {
        Ok(())
    } else {
        Err("此窗口无权执行该操作。".into())
    }
}

fn authorize_mutation(label: &str, action: &Action) -> Result<(), String> {
    require_window(label, &["console", "edge-panel"])?;
    if matches!(action, Action::ResetDemo { .. }) {
        return Err("正式应用不能用演示数据覆盖任务。".into());
    }
    if label == "console" {
        return Ok(());
    }
    match action {
        Action::SetCompleted { .. } | Action::PlanTask { .. } => Ok(()),
        Action::UpdateSettings { changes }
            if changes.as_object().is_some_and(|object| {
                !object.is_empty()
                    && object
                        .keys()
                        .all(|key| ["pinned", "ddlSort"].contains(&key.as_str()))
            }) =>
        {
            Ok(())
        }
        _ => Err("请在控制台执行此操作。".into()),
    }
}

#[tauri::command]
fn get_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Snapshot, String> {
    require_window(window.label(), &["console", "edge-panel", "edge-handle"])?;
    let mut snapshot = state
        .service
        .lock()
        .map(|s| s.snapshot.clone())
        .map_err(|_| "本地任务服务暂不可用。".to_string())?;
    if window.label() == "edge-handle" {
        snapshot.tasks.clear();
        snapshot.plans.clear();
    }
    Ok(snapshot)
}
#[tauri::command]
fn mutate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    action: Value,
    expected_revision: u64,
) -> Result<Snapshot, String> {
    let action: Action =
        serde_json::from_value(action).map_err(|e| format!("操作格式无效：{e}"))?;
    authorize_mutation(window.label(), &action)?;
    let snapshot = {
        let mut service = state.service.lock().map_err(|_| "本地任务服务暂不可用。")?;
        platform::exit::ensure_running(&state)?;
        service.mutate(action, expected_revision)?
    };
    // Notification failure must not turn a committed transaction into a reported failure.
    if let Err(error) = app.emit(
        "sidetask:changed",
        serde_json::json!({"revision": snapshot.revision}),
    ) {
        eprintln!("snapshot notification: {error}");
    }
    Ok(snapshot)
}
#[tauri::command]
async fn window_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<(), String> {
    platform::window_action(&app, &window, &action, payload.unwrap_or(Value::Null))
}
#[tauri::command]
fn get_monitors(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    require_window(window.label(), &["console"])?;
    platform::get_monitors(&app)
}

#[tauri::command]
async fn get_window_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<platform::WindowStatus, String> {
    require_window(window.label(), &["console"])?;
    platform::get_window_status(&app)
}

#[tauri::command]
fn get_pending_exit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<platform::exit::ExitRequest>, String> {
    require_window(window.label(), &["console"])?;
    platform::exit::pending(&app)
}

#[tauri::command]
async fn resolve_exit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: u64,
    allow: bool,
) -> Result<(), String> {
    require_window(window.label(), &["console"])?;
    platform::exit::resolve(&app, request_id, allow)
}

#[tauri::command]
async fn export_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    require_window(window.label(), &["console"])?;
    let content = app
        .state::<AppState>()
        .service
        .lock()
        .map_err(|_| "任务服务暂不可用。")?
        .export_backup()?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("exports");
    let path = write_export(&directory, &content)?;
    Ok(serde_json::json!({"path":path.to_string_lossy()}))
}

fn write_export(directory: &std::path::Path, content: &str) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|e| format!("无法创建备份目录：{e}"))?;
    let path = directory.join(format!("SideTask-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("无法创建备份文件：{e}"))?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("备份写入失败：{error}"));
    }
    Ok(path)
}

#[tauri::command]
async fn preview_restore(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    content: String,
) -> Result<application::RestorePreview, String> {
    require_window(window.label(), &["console"])?;
    app.state::<AppState>()
        .service
        .lock()
        .map_err(|_| "任务服务暂不可用。")?
        .preview_restore(&content)
}

#[tauri::command]
async fn restore_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    content: String,
    expected_revision: u64,
) -> Result<application::RestoreResult, String> {
    require_window(window.label(), &["console"])?;
    let state = app.state::<AppState>();
    let result = {
        let mut service = state.service.lock().map_err(|_| "任务服务暂不可用。")?;
        platform::exit::ensure_running(&state)?;
        service.restore_backup(&content, expected_revision)?
    };
    if let Err(error) = app.emit(
        "sidetask:changed",
        serde_json::json!({"revision":result.snapshot.revision}),
    ) {
        eprintln!("restore notification: {error}");
    }
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = platform::open_console(app, Value::Null);
        }))
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            mutate,
            window_action,
            get_monitors,
            get_window_status,
            get_pending_exit,
            resolve_exit,
            export_backup,
            preview_restore,
            restore_backup
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let repo = SqliteRepository::open(&data_dir.join("sidetask.sqlite3"))?;
            let service = TaskService::new(Box::new(repo))?;
            let placement = service
                .repository
                .load_placement()?
                .and_then(|p| serde_json::from_str(&p).ok())
                .unwrap_or_default();
            app.manage(AppState {
                service: Mutex::new(service),
                dock: Mutex::new(platform::DockRuntime::new(placement)),
                exit: Mutex::new(platform::exit::ExitRuntime::default()),
            });
            platform::setup(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("SideTask could not initialize; existing data has not been reset");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } if !platform::exit::is_authorized(app) => {
            api.prevent_exit();
            if let Err(error) = platform::exit::request(app) {
                eprintln!("exit request: {error}");
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let _ = platform::open_console(app, Value::Null);
        }
        _ => {}
    });
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn handle_unknown_windows_and_edge_settings_cannot_escalate() {
        let completed = Action::SetCompleted {
            id: "test".into(),
            completed: true,
            expected_revision: 1,
        };
        assert!(authorize_mutation("edge-panel", &completed).is_ok());
        assert!(authorize_mutation("edge-handle", &completed).is_err());
        assert!(authorize_mutation("untrusted", &completed).is_err());
        let allowed = Action::UpdateSettings {
            changes: serde_json::json!({"pinned":true,"ddlSort":"priority"}),
        };
        let rejected = Action::UpdateSettings {
            changes: serde_json::json!({"pinned":true,"edgeEnabled":false}),
        };
        assert!(authorize_mutation("edge-panel", &allowed).is_ok());
        assert!(authorize_mutation("edge-panel", &rejected).is_err());
        assert!(authorize_mutation("console", &rejected).is_ok());
        assert!(authorize_mutation(
            "console",
            &Action::ResetDemo {
                date: "2026-09-25".into()
            }
        )
        .is_err());
    }

    #[test]
    fn exports_are_unique_complete_and_private_without_overwriting_existing_files() {
        let directory =
            std::env::temp_dir().join(format!("sidetask-export-test-{}", uuid::Uuid::new_v4()));
        let first = write_export(&directory, "{\"tasks\":[]}").unwrap();
        let second = write_export(&directory, "{\"tasks\":[1]}").unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(directory.as_path()));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "{\"tasks\":[]}");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "{\"tasks\":[1]}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn capability_grants_keep_internal_events_and_console_data_operations_private() {
        let shared: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let tasks: Value =
            serde_json::from_str(include_str!("../capabilities/tasks.json")).unwrap();
        let console: Value =
            serde_json::from_str(include_str!("../capabilities/console.json")).unwrap();
        for capability in [&shared, &tasks, &console] {
            assert!(capability.get("remote").is_none());
            assert!(!capability["windows"]
                .as_array()
                .unwrap()
                .contains(&Value::String("*".into())));
            for permission in capability["permissions"].as_array().unwrap() {
                let permission = permission.as_str().unwrap();
                assert!(![
                    "core:default",
                    "core:event:default",
                    "core:event:allow-emit",
                    "core:event:allow-emit-to"
                ]
                .contains(&permission));
            }
        }
        assert_eq!(console["windows"], serde_json::json!(["console"]));
        assert!(!tasks["windows"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("edge-handle")));
        for command in [
            "allow-mutate",
            "allow-export-backup",
            "allow-preview-restore",
            "allow-restore-backup",
            "allow-resolve-exit",
        ] {
            assert!(!shared["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(command)));
        }
    }
}
