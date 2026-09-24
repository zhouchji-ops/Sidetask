pub mod exit;
mod geometry;
#[cfg(target_os = "macos")]
mod macos_exit;
pub mod startup_recovery;
use crate::{
    domain::{Action, Settings},
    AppState,
};
use geometry::{dock_geometry, DockGeometry, PhysicalRect};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    monitor_name: Option<String>,
    #[serde(default)]
    monitor_position: Option<MonitorPosition>,
    #[serde(default = "default_offset")]
    offset: f64,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
struct MonitorPosition {
    x: i32,
    y: i32,
}
fn default_offset() -> f64 {
    0.38
}
struct Drag {
    label: String,
    started: Instant,
    settings: Settings,
    original_visible: bool,
    cancelled: bool,
}
struct Resize {
    settings: Settings,
    draft: Settings,
    placement: Placement,
    top: i32,
}
pub struct DockRuntime {
    placement: Placement,
    visible: bool,
    interaction_owners: BTreeSet<String>,
    geometry: Option<DockGeometry>,
    applied_settings: Option<Settings>,
    signature: String,
    entered: Option<Instant>,
    left: Option<Instant>,
    suppressed: bool,
    drag: Option<Drag>,
    resize: Option<Resize>,
    console_focused: bool,
    window_error: Option<String>,
    notified_status: Option<WindowStatus>,
}
#[derive(Clone, PartialEq, Serialize)]
pub struct WindowStatus {
    pub pending: bool,
    pub error: Option<String>,
}
impl DockRuntime {
    pub fn new(mut placement: Placement) -> Self {
        if placement.monitor_name.is_none() && placement.offset == 0. {
            placement.offset = default_offset();
        }
        Self {
            placement,
            visible: false,
            interaction_owners: BTreeSet::new(),
            geometry: None,
            applied_settings: None,
            signature: String::new(),
            entered: None,
            left: None,
            suppressed: false,
            drag: None,
            resize: None,
            console_focused: false,
            window_error: None,
            notified_status: None,
        }
    }

    fn locked(&self) -> bool {
        self.interaction_owners.contains("edge-panel")
            || (self.console_focused && self.interaction_owners.contains("console"))
            || self.drag.is_some()
            || self.resize.is_some()
    }

    fn status(&self, desired: &Settings) -> WindowStatus {
        WindowStatus {
            pending: self.window_error.is_some() || self.applied_settings.as_ref() != Some(desired),
            error: self.window_error.clone(),
        }
    }
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn local_navigation(url: &tauri::Url) -> bool {
    let local_origin = match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        #[cfg(debug_assertions)]
        ("http", Some("127.0.0.1"), Some(1420)) => true,
        _ => false,
    };
    local_origin && ["/", "/index.html"].contains(&url.path())
}

fn authorize_window_action(label: &str, action: &str) -> Result<(), String> {
    let allowed = match label {
        "console" => [
            "quit",
            "openConsole",
            "showPanel",
            "hidePanel",
            "togglePanel",
            "interaction",
            "retryWindowSettings",
        ]
        .contains(&action),
        "edge-panel" => [
            "openConsole",
            "showPanel",
            "hidePanel",
            "togglePanel",
            "startDrag",
            "finishDrag",
            "cancelDrag",
            "resizePanel",
            "interaction",
        ]
        .contains(&action),
        "edge-handle" => [
            "openConsole",
            "showPanel",
            "startDrag",
            "finishDrag",
            "cancelDrag",
        ]
        .contains(&action),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("此窗口无权执行该窗口操作。".into())
    }
}
fn window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("找不到 {label} 窗口。"))
}
fn work_area(monitor: &tauri::Monitor) -> PhysicalRect {
    let area = monitor.work_area();
    PhysicalRect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}
fn choose_monitor(app: &tauri::AppHandle, placement: &Placement) -> Result<tauri::Monitor, String> {
    let panel = window(app, "edge-panel")?;
    let monitors = panel.available_monitors().map_err(error)?;
    let identities: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            (
                monitor.name().map(String::as_str),
                MonitorPosition {
                    x: monitor.position().x,
                    y: monitor.position().y,
                },
            )
        })
        .collect();
    if let Some(index) = saved_monitor_index(&identities, placement) {
        return Ok(monitors[index].clone());
    }
    panel
        .primary_monitor()
        .map_err(error)?
        .or_else(|| monitors.first().cloned())
        .ok_or("没有可用屏幕。".into())
}

fn saved_monitor_index(
    monitors: &[(Option<&str>, MonitorPosition)],
    placement: &Placement,
) -> Option<usize> {
    let name = placement.monitor_name.as_deref()?;
    let mut matching = monitors
        .iter()
        .enumerate()
        .filter(|(_, (candidate, _))| *candidate == Some(name));
    let first = matching.next()?;
    if placement.monitor_position == Some(first.1 .1) {
        return Some(first.0);
    }
    matching
        .find(|(_, (_, position))| placement.monitor_position == Some(*position))
        .or(Some(first))
        .map(|(index, _)| index)
}
fn apply_rect(window: &WebviewWindow, rect: PhysicalRect) -> Result<(), String> {
    // These auxiliary windows have no decorations or system shadow; their physical
    // input bounds equal the clamped rectangle. Never slide a live window offscreen.
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(error)?;
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(error)
}
fn apply_rect_live(window: &WebviewWindow, rect: PhysicalRect) -> Result<(), String> {
    // Shrink before moving, then expand. With both endpoints in the same work
    // area, every intermediate rectangle stays inside it, including right docks.
    let old = window.outer_size().map_err(error)?;
    window
        .set_size(PhysicalSize::new(
            old.width.min(rect.width),
            old.height.min(rect.height),
        ))
        .map_err(error)?;
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(error)?;
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(error)
}
fn same_window_layout(previous: &Settings, next: &Settings) -> bool {
    // Appearance and task ordering update inside the existing WebView. They
    // must not hide/re-show a native window or interrupt its current focus.
    previous.edge == next.edge
        && previous.panel_width == next.panel_width
        && previous.panel_height == next.panel_height
        && previous.pinned == next.pinned
        && previous.edge_enabled == next.edge_enabled
}
fn apply_geometry(
    app: &tauri::AppHandle,
    dock: &mut DockRuntime,
    settings: &Settings,
) -> Result<(), String> {
    let result = apply_geometry_inner(app, dock, settings);
    if result.is_err() {
        // A failed show/position must never be cached as successfully applied.
        // Hide the auxiliary surfaces, invalidate the cache, and let the next
        // tick retry the committed preferences. The console/tray stay usable.
        dock.applied_settings = None;
        dock.geometry = None;
        dock.signature.clear();
        dock.visible = false;
        for label in ["edge-panel", "edge-handle"] {
            if let Ok(window) = window(app, label) {
                let _ = window.hide();
            }
        }
    }
    result
}

fn apply_geometry_inner(
    app: &tauri::AppHandle,
    dock: &mut DockRuntime,
    settings: &Settings,
) -> Result<(), String> {
    let monitor = choose_monitor(app, &dock.placement)?;
    let area = work_area(&monitor);
    if area.width == 0
        || area.height == 0
        || !monitor.scale_factor().is_finite()
        || monitor.scale_factor() <= 0.
    {
        return Err("屏幕工作区暂不可用，已暂停小窗。".into());
    }
    let signature = format!("{:?}:{}:{:?}", area, monitor.scale_factor(), monitor.name());
    let changed = !dock
        .applied_settings
        .as_ref()
        .is_some_and(|previous| same_window_layout(previous, settings))
        || dock.signature != signature
        || dock.geometry.is_none();
    if !changed {
        dock.applied_settings = Some(settings.clone());
        return Ok(());
    }
    let geometry = dock_geometry(
        area,
        monitor.scale_factor(),
        settings.panel_width,
        settings.panel_height,
        settings.edge == "left",
        dock.placement.offset,
    );
    let panel = window(app, "edge-panel")?;
    let handle = window(app, "edge-handle")?;
    // Hide before a geometry transition so automatic correction cannot reveal an
    // intermediate rectangle on a neighbouring monitor.
    let live_resize = dock.resize.is_some() && dock.signature == signature && dock.visible;
    if dock.visible && !live_resize {
        panel.hide().map_err(error)?;
    }
    handle.hide().map_err(error)?;
    if live_resize {
        apply_rect_live(&panel, geometry.panel)?;
    } else {
        apply_rect(&panel, geometry.panel)?;
    }
    apply_rect(&handle, geometry.handle)?;
    dock.geometry = Some(geometry);
    dock.signature = signature;
    if settings.edge_enabled {
        if dock.visible || settings.pinned {
            panel.show().map_err(error)?;
            dock.visible = true;
        } else {
            handle.show().map_err(error)?;
        }
    } else {
        panel.hide().map_err(error)?;
        dock.visible = false;
    }
    dock.applied_settings = Some(settings.clone());
    Ok(())
}
fn show_panel(
    app: &tauri::AppHandle,
    dock: &mut DockRuntime,
    settings: &Settings,
) -> Result<(), String> {
    if !settings.edge_enabled {
        return Err("边缘小窗已暂停，请在设置中开启。".into());
    }
    apply_geometry(app, dock, settings)?;
    window(app, "edge-handle")?.hide().map_err(error)?;
    window(app, "edge-panel")?.show().map_err(error)?;
    dock.visible = true;
    dock.entered = None;
    dock.left = None;
    dock.suppressed = false;
    let _ = app.emit_to("edge-panel", "sidetask:shown", ());
    Ok(())
}
fn hide_panel(
    app: &tauri::AppHandle,
    dock: &mut DockRuntime,
    settings: &Settings,
    suppress: bool,
) -> Result<(), String> {
    window(app, "edge-panel")?.hide().map_err(error)?;
    if settings.edge_enabled {
        window(app, "edge-handle")?.show().map_err(error)?;
    }
    dock.visible = false;
    dock.entered = None;
    dock.left = None;
    dock.suppressed = suppress;
    Ok(())
}
pub fn open_console(app: &tauri::AppHandle, payload: Value) -> Result<(), String> {
    let console = window(app, "console")?;
    console.unminimize().map_err(error)?;
    console.show().map_err(error)?;
    console.set_focus().map_err(error)?;
    // Restoring the console (including an exit confirmation) is not navigation.
    // Sending null both breaks the JS navigation contract and risks prompting
    // about a draft before the actual exit confirmation is displayed.
    if payload.is_object() && payload.as_object().is_some_and(|object| !object.is_empty()) {
        app.emit_to("console", "sidetask:navigate", payload)
            .map_err(error)?;
    }
    let _ = app.emit_to("console", "sidetask:shown", ());
    Ok(())
}
fn settings(app: &tauri::AppHandle) -> Result<Settings, String> {
    Ok(crate::task_state(app)?
        .service
        .lock()
        .map_err(|_| "任务服务不可用。")?
        .snapshot
        .settings
        .clone())
}

pub fn get_window_status(app: &tauri::AppHandle) -> Result<WindowStatus, String> {
    let desired = settings(app)?;
    Ok(crate::task_state(app)?
        .dock
        .lock()
        .map_err(|_| "窗口服务不可用。")?
        .status(&desired))
}

fn publish_window_status(app: &tauri::AppHandle, failure: Option<String>) {
    let Ok(desired) = settings(app) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let status = {
        let Ok(mut dock) = state.dock.lock() else {
            return;
        };
        dock.window_error = failure;
        let status = dock.status(&desired);
        if dock.notified_status.as_ref() == Some(&status) {
            return;
        }
        dock.notified_status = Some(status.clone());
        status
    };
    if let Err(error) = app.emit_to("console", "sidetask:window-status", status) {
        eprintln!("window status notification: {error}");
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    setup_console(app, false)?;
    setup_auxiliary(app)
}

pub fn setup_recovery(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    setup_console(app, true)
}

fn setup_console(app: &mut tauri::App, recovery: bool) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    macos_exit::install(app.handle())?;
    #[cfg(target_os = "macos")]
    install_application_menu(app)?;
    let console = WebviewWindowBuilder::new(
        app,
        "console",
        WebviewUrl::App("index.html?surface=console".into()),
    )
    .title(if recovery {
        "侧笺 · 数据恢复"
    } else {
        "侧笺 · SideTask"
    })
    .inner_size(1180., 790.)
    .min_inner_size(880., 620.)
    .center()
    .on_navigation(local_navigation)
    .build()?;
    let console_copy = console.clone();
    console.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if recovery {
                if let Err(error) = exit::request(console_copy.app_handle()) {
                    eprintln!("recovery close request: {error}");
                }
            } else {
                let _ = console_copy.hide();
            }
        }
    });
    Ok(())
}

fn setup_auxiliary(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    for (label, width, height) in [("edge-panel", 376., 620.), ("edge-handle", 18., 92.)] {
        WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(format!("index.html?surface={label}").into()),
        )
        .title("SideTask")
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .on_navigation(local_navigation)
        .build()?;
    }
    use tauri::menu::{Menu, MenuItem};
    let open = MenuItem::with_id(app, "open", "打开侧笺", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "显示 / 收起小窗", true, None::<&str>)?;
    let preferences = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 SideTask", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &panel, &preferences, &quit])?;
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 5..27 {
        for x in 5..27 {
            if x < 8
                || ((12..26).contains(&x)
                    && ((6..9).contains(&y) || (14..17).contains(&y) || (22..25).contains(&y)))
            {
                let at = (y * 32 + x) * 4;
                pixels[at + 3] = 255;
            }
        }
    }
    tauri::tray::TrayIconBuilder::with_id("sidetask")
        .icon(tauri::image::Image::new_owned(pixels, 32, 32))
        .icon_as_template(true)
        .tooltip("侧笺 · SideTask")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if action == "quit" {
                if let Err(message) = exit::request(app) {
                    eprintln!("exit request: {message}");
                }
            } else if action == "open" {
                let _ = open_console(app, Value::Null);
            } else if action == "settings" {
                let _ = open_console(app, json!({"page":"settings"}));
            } else if action == "panel" {
                // Window operations dispatch to the main event loop. Do not hold a
                // coordinator lock from the main callback while a worker waits on it.
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Ok(panel) = window(&app, "edge-panel") {
                        let _ = window_action(&app, &panel, "togglePanel", Value::Null);
                    }
                });
            }
        })
        .build(app)?;
    let app_handle = app.handle().clone();
    std::thread::Builder::new()
        .name("sidetask-edge".into())
        .spawn(move || {
            let mut last_error = String::new();
            loop {
                let visible = app_handle
                    .state::<AppState>()
                    .dock
                    .lock()
                    .map(|d| d.visible)
                    .unwrap_or(false);
                std::thread::sleep(Duration::from_millis(if visible { 80 } else { 160 }));
                if let Err(message) = tick(&app_handle) {
                    publish_window_status(&app_handle, Some(message.clone()));
                    if message != last_error {
                        eprintln!("edge coordinator: {message}");
                        let _ = app_handle.emit("sidetask:window-error", &message);
                        last_error = message;
                    }
                } else {
                    publish_window_status(&app_handle, None);
                    last_error.clear();
                }
            }
        })?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_application_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    // macOS's predefined Quit item invokes NSApplication.terminate directly;
    // it does not reliably travel through Tauri RunEvent::ExitRequested.
    // A regular menu item routes both the menu and Cmd+Q to our draft handshake.
    let quit = MenuItem::with_id(
        app,
        "request-quit",
        "退出 SideTask",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "SideTask",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于侧笺"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏侧笺"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &window_menu],
    )?)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "request-quit" {
            if let Err(message) = exit::request(app) {
                eprintln!("exit request: {message}");
            }
        }
    });
    Ok(())
}

fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    let settings = settings(app)?;
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    if let Some(drag) = &mut dock.drag {
        drag.cancelled |= escape_down() || drag.settings != settings;
        if drag.started.elapsed() > Duration::from_millis(160) && !left_button_down() {
            finish_drag(app, &mut dock)?;
        }
        return Ok(());
    }
    if dock
        .resize
        .as_ref()
        .is_some_and(|resize| resize.settings != settings)
    {
        let resize = dock.resize.take().unwrap();
        dock.placement = resize.placement;
        dock.applied_settings = None;
        let _ = app.emit(
            "sidetask:window-error",
            "缩放期间设置已更新，已恢复最新设置。",
        );
    }
    let applied = dock
        .resize
        .as_ref()
        .map(|r| r.draft.clone())
        .unwrap_or_else(|| settings.clone());
    apply_geometry(app, &mut dock, &applied)?;
    if !settings.edge_enabled {
        return Ok(());
    }
    let panel = window(app, "edge-panel")?;
    let cursor = panel.cursor_position().map_err(error)?;
    let Some(geometry) = dock.geometry else {
        return Ok(());
    };
    let over_handle = geometry.handle.contains(cursor.x, cursor.y);
    let over_panel = dock.visible && geometry.panel.contains(cursor.x, cursor.y);
    let console_focused = window(app, "console")?.is_focused().unwrap_or(false);
    if console_focused
        && !dock.console_focused
        && dock.visible
        && !settings.pinned
        && !dock.locked()
    {
        hide_panel(app, &mut dock, &settings, true)?;
    }
    dock.console_focused = console_focused;
    if !over_handle && !over_panel {
        dock.suppressed = false;
    }
    if dock.locked() {
        dock.entered = None;
        dock.left = None;
        return Ok(());
    }
    if dock.visible {
        if settings.pinned || over_panel || over_handle || left_button_down() {
            dock.left = None;
        } else {
            let left = dock.left.get_or_insert_with(Instant::now);
            if left.elapsed().as_millis() >= settings.hide_delay as u128 {
                hide_panel(app, &mut dock, &settings, false)?;
            }
        }
    } else {
        if console_focused {
            // A pointer already resting at the edge must leave and enter again
            // after console use; closing the console alone is not hover intent.
            dock.suppressed = true;
        }
        if over_handle && !dock.suppressed && !console_focused {
            let entered = dock.entered.get_or_insert_with(Instant::now);
            if entered.elapsed().as_millis() >= settings.reveal_delay as u128 {
                show_panel(app, &mut dock, &settings)?;
            }
        } else {
            dock.entered = None;
        }
    }
    Ok(())
}
fn resize_panel(app: &tauri::AppHandle, payload: Value) -> Result<(), String> {
    let width = payload
        .get("width")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or("缺少有效宽度。")?
        .clamp(300., 640.);
    let height = payload
        .get("height")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or("缺少有效高度。")?
        .clamp(380., 1000.);
    let commit = payload
        .get("commit")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    if dock.drag.is_some() {
        return Err("请先结束移动，再调整小窗尺寸。".into());
    }
    // Never keep the service lock while waiting for a main-thread window call:
    // a synchronous snapshot/mutation command may be waiting for that lock.
    let current = state
        .service
        .lock()
        .map_err(|_| "任务服务不可用。")?
        .snapshot
        .settings
        .clone();
    if dock.resize.as_ref().is_some_and(|r| r.settings != current) {
        let resize = dock.resize.take().unwrap();
        dock.placement = resize.placement;
        dock.applied_settings = None;
        apply_geometry(app, &mut dock, &current)?;
        return Err("缩放期间设置已更新，请重新调整。".into());
    }
    if dock.resize.is_none() {
        apply_geometry(app, &mut dock, &current)?;
        dock.resize = Some(Resize {
            settings: current.clone(),
            draft: current.clone(),
            placement: dock.placement.clone(),
            top: dock.geometry.ok_or("小窗尚未定位。")?.panel.y,
        });
    }
    let mut draft = current.clone();
    draft.panel_width = width;
    draft.panel_height = height;
    let monitor = choose_monitor(app, &dock.placement)?;
    let area = work_area(&monitor);
    let shape = dock_geometry(
        area,
        monitor.scale_factor(),
        width,
        height,
        draft.edge == "left",
        0.,
    );
    let margin = shape.panel.y - area.y;
    let travel = area.height as i64 - shape.panel.height as i64 - 2 * margin as i64;
    let top = dock.resize.as_ref().unwrap().top;
    dock.placement.offset = if travel > 0 {
        ((top - area.y - margin) as f64 / travel as f64).clamp(0., 1.)
    } else {
        0.
    };
    dock.resize.as_mut().unwrap().draft = draft.clone();
    // Preview is runtime-only, so moving the grip never writes SQLite per frame.
    apply_geometry(app, &mut dock, &draft)?;
    if !commit {
        return Ok(());
    }
    let mut service = state.service.lock().map_err(|_| "任务服务不可用。")?;
    exit::ensure_running(&state)?;
    if service.snapshot.settings != current {
        let latest = service.snapshot.settings.clone();
        drop(service);
        let resize = dock.resize.take().unwrap();
        dock.placement = resize.placement;
        dock.applied_settings = None;
        apply_geometry(app, &mut dock, &latest)?;
        return Err("缩放期间设置已更新，请重新调整。".into());
    }
    let next = service.snapshot.apply(
        Action::UpdateSettings {
            changes: json!({"panelWidth":width,"panelHeight":height}),
        },
        service.snapshot.revision,
    )?;
    let placement = serde_json::to_string(&dock.placement).map_err(error)?;
    if let Err(message) = service.repository.save_placement(&next, &placement) {
        drop(service);
        let resize = dock.resize.take().unwrap();
        dock.placement = resize.placement;
        dock.applied_settings = None;
        apply_geometry(app, &mut dock, &current)?;
        return Err(message);
    }
    service.snapshot = next.clone();
    drop(service);
    dock.resize = None;
    let _ = app.emit("sidetask:changed", json!({"revision":next.revision}));
    Ok(())
}
fn finish_drag(app: &tauri::AppHandle, dock: &mut DockRuntime) -> Result<(), String> {
    let Some(drag) = dock.drag.take() else {
        return Ok(());
    };
    // Even if a screen disappears before we can resolve the release target,
    // the next coordinator tick must restore the last committed safe geometry.
    dock.applied_settings = None;
    dock.visible = drag.original_visible;
    dock.suppressed = true;
    dock.entered = None;
    dock.left = None;
    if drag.cancelled || escape_down() {
        return apply_geometry(app, dock, &settings(app)?);
    }
    let source = window(app, &drag.label)?;
    let cursor = source.cursor_position().map_err(error)?;
    let monitors = source.available_monitors().map_err(error)?;
    let target = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            PhysicalRect {
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            }
            .contains(cursor.x, cursor.y)
        })
        .cloned()
        .or(source.current_monitor().map_err(error)?)
        .ok_or("找不到目标屏幕。")?;
    let area = work_area(&target);
    let position = source.outer_position().map_err(error)?;
    let size = source.outer_size().map_err(error)?;
    let state = app.state::<AppState>();
    let mut service = state.service.lock().map_err(|_| "任务服务不可用。")?;
    exit::ensure_running(&state)?;
    let current = service.snapshot.settings.clone();
    if current != drag.settings {
        dock.applied_settings = None;
        drop(service);
        apply_geometry(app, dock, &current)?;
        return Err("拖动期间设置已更新，保留最新停靠设置。".into());
    }
    let edge = if cursor.x < area.x as f64 + area.width as f64 / 2. {
        "left"
    } else {
        "right"
    };
    let scale = target.scale_factor();
    let panel_height = (current.panel_height * scale).min(area.height as f64 - 16. * scale);
    let center = position.y as f64 + size.height as f64 / 2.;
    let offset = ((center - panel_height / 2. - area.y as f64 - 8. * scale)
        / (area.height as f64 - panel_height - 16. * scale).max(1.))
    .clamp(0., 1.);
    let placement = Placement {
        monitor_name: target.name().cloned(),
        monitor_position: Some(MonitorPosition {
            x: target.position().x,
            y: target.position().y,
        }),
        offset,
    };
    let placement_json = serde_json::to_string(&placement).map_err(error)?;
    let expected = service.snapshot.revision;
    let snapshot = service.snapshot.apply(
        Action::UpdateSettings {
            changes: json!({"edge":edge}),
        },
        expected,
    )?;
    if let Err(message) = service
        .repository
        .save_placement(&snapshot, &placement_json)
    {
        drop(service);
        dock.applied_settings = None;
        apply_geometry(app, dock, &current)?;
        return Err(message);
    }
    service.snapshot = snapshot.clone();
    drop(service);
    dock.placement = placement;
    dock.visible = drag.original_visible;
    dock.applied_settings = None;
    dock.suppressed = true;
    let _ = app.emit("sidetask:changed", json!({"revision":snapshot.revision}));
    apply_geometry(app, dock, &snapshot.settings)
}
pub fn window_action(
    app: &tauri::AppHandle,
    caller: &WebviewWindow,
    action: &str,
    payload: Value,
) -> Result<(), String> {
    authorize_window_action(caller.label(), action)?;
    if action == "quit" {
        return exit::request(app);
    }
    if action == "openConsole" {
        return open_console(app, payload);
    }
    crate::task_state(app)?;
    if action == "startDrag" {
        if !["edge-handle", "edge-panel"].contains(&caller.label()) {
            return Err("此窗口不能停靠。".into());
        }
        let settings = settings(app)?;
        {
            let state = app.state::<AppState>();
            let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
            if dock.resize.is_some() {
                return Err("请先结束缩放，再移动小窗。".into());
            }
            if dock.drag.is_some() {
                return Err("小窗正在移动，请先结束当前拖动。".into());
            }
            let original_visible = dock.visible;
            dock.drag = Some(Drag {
                label: caller.label().into(),
                started: Instant::now(),
                settings,
                original_visible,
                cancelled: false,
            });
            dock.entered = None;
            dock.left = None;
            if caller.label() == "edge-panel" {
                window(app, "edge-handle")?.hide().map_err(error)?;
            }
        }
        if let Err(e) = caller.start_dragging() {
            let state = app.state::<AppState>();
            let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
            dock.drag = None;
            dock.applied_settings = None;
            return Err(error(e));
        }
        return Ok(());
    }
    if action == "resizePanel" {
        return resize_panel(app, payload);
    }
    if action == "retryWindowSettings" {
        let desired = settings(app)?;
        let result = {
            let state = app.state::<AppState>();
            let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
            if dock.drag.is_some() || dock.resize.is_some() {
                return Err("请先结束移动或缩放，再重试窗口设置。".into());
            }
            dock.applied_settings = None;
            apply_geometry(app, &mut dock, &desired)
        };
        publish_window_status(app, result.as_ref().err().cloned());
        return result;
    }
    let settings = settings(app)?;
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    if ["finishDrag", "cancelDrag"].contains(&action)
        && dock
            .drag
            .as_ref()
            .is_some_and(|drag| drag.label != caller.label())
    {
        return Err("不能结束其他窗口的拖动。".into());
    }
    match action {
        "showPanel" => show_panel(app, &mut dock, &settings),
        "hidePanel" => hide_panel(app, &mut dock, &settings, true),
        "togglePanel" => {
            if dock.visible {
                hide_panel(app, &mut dock, &settings, true)
            } else {
                show_panel(app, &mut dock, &settings)
            }
        }
        // Native dragging can cancel WebView pointer capture immediately. That
        // cancellation is not a release; only the actual system button state is.
        "finishDrag" if left_button_down() => Ok(()),
        "finishDrag" => finish_drag(app, &mut dock),
        "cancelDrag" => {
            if let Some(drag) = dock.drag.as_mut() {
                if drag.label != caller.label() {
                    return Err("不能取消其他窗口的拖动。".into());
                }
                drag.cancelled = true;
            }
            if left_button_down() {
                Ok(())
            } else {
                finish_drag(app, &mut dock)
            }
        }
        "interaction" => {
            let locked = payload
                .get("locked")
                .and_then(Value::as_bool)
                .ok_or("缺少有效的交互状态。")?;
            if locked {
                dock.interaction_owners.insert(caller.label().to_string());
            } else {
                dock.interaction_owners.remove(caller.label());
            }
            if !locked && caller.label() == "edge-panel" {
                if let Some(resize) = dock.resize.take() {
                    dock.placement = resize.placement;
                    dock.applied_settings = None;
                    apply_geometry(app, &mut dock, &settings)?;
                }
            }
            dock.left = None;
            Ok(())
        }
        _ => Err(format!("不支持的窗口操作：{action}")),
    }
}
pub fn get_monitors(app: &tauri::AppHandle) -> Result<Value, String> {
    let panel = window(app, "edge-panel")?;
    let current = panel.current_monitor().map_err(error)?;
    Ok(Value::Array(panel.available_monitors().map_err(error)?.iter().map(|monitor| json!({"name":monitor.name().cloned().unwrap_or_else(|| "显示器".into()),"width":monitor.size().width as f64 / monitor.scale_factor(),"height":monitor.size().height as f64 / monitor.scale_factor(),"scaleFactor":monitor.scale_factor(),"current":current.as_ref().map(|m|m.position()==monitor.position()).unwrap_or(false)})).collect()))
}
#[cfg(target_os = "macos")]
fn left_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    unsafe { CGEventSourceButtonState(0, 0) }
}
#[cfg(target_os = "macos")]
fn escape_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
    }
    unsafe { CGEventSourceKeyState(0, 53) }
}
#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(0x01) < 0 }
}
#[cfg(target_os = "windows")]
fn escape_down() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(0x1B) < 0 }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn left_button_down() -> bool {
    false
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn escape_down() -> bool {
    false
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auxiliary_windows_cannot_quit_or_invoke_console_operations() {
        for label in ["edge-panel", "edge-handle", "unknown"] {
            assert!(authorize_window_action(label, "quit").is_err());
        }
        assert!(authorize_window_action("edge-handle", "resizePanel").is_err());
        assert!(authorize_window_action("edge-handle", "interaction").is_err());
        assert!(authorize_window_action("console", "startDrag").is_err());
        assert!(authorize_window_action("edge-panel", "cancelDrag").is_ok());
    }

    #[test]
    fn navigation_rejects_remote_documents_and_origin_confusion() {
        for url in [
            "https://example.com/",
            "https://tauri.localhost.evil.test/",
            "file:///tmp/index.html",
            "tauri://localhost/other.html",
            "https://tauri.localhost:4430/",
            "data:text/html,test",
        ] {
            assert!(!local_navigation(&tauri::Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "tauri://localhost/index.html?surface=console",
            "http://tauri.localhost/",
        ] {
            assert!(local_navigation(&tauri::Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn one_window_cannot_release_another_windows_interaction_guard() {
        let mut dock = DockRuntime::new(Placement::default());
        dock.console_focused = true;
        dock.interaction_owners.insert("console".into());
        dock.interaction_owners.insert("edge-panel".into());
        dock.interaction_owners.remove("edge-panel");
        assert!(dock.locked());
        dock.interaction_owners.remove("console");
        assert!(!dock.locked());
        dock.interaction_owners.insert("console".into());
        dock.console_focused = false;
        assert!(
            !dock.locked(),
            "a hidden console draft must not freeze edge hover forever"
        );
    }

    #[test]
    fn saved_settings_are_pending_until_native_application_succeeds() {
        let desired = Settings::default();
        let mut dock = DockRuntime::new(Placement::default());
        assert!(dock.status(&desired).pending);
        dock.applied_settings = Some(desired.clone());
        assert!(!dock.status(&desired).pending);
        let mut next = desired.clone();
        next.panel_width += 10.;
        assert!(dock.status(&next).pending);
        dock.window_error = Some("set_position failed".into());
        assert!(dock.status(&desired).pending);
        assert!(dock.status(&desired).error.is_some());
        dock.window_error = None;
        dock.applied_settings = Some(next.clone());
        assert!(!dock.status(&next).pending);
    }

    #[test]
    fn duplicate_display_names_use_saved_position_and_legacy_placement_still_loads() {
        let left = MonitorPosition { x: -1920, y: 0 };
        let right = MonitorPosition { x: 0, y: 0 };
        let monitors = [(Some("Display"), left), (Some("Display"), right)];
        let placement = Placement {
            monitor_name: Some("Display".into()),
            monitor_position: Some(right),
            offset: 0.5,
        };
        assert_eq!(saved_monitor_index(&monitors, &placement), Some(1));
        let legacy: Placement =
            serde_json::from_str(r#"{"monitorName":"Display","offset":0.5}"#).unwrap();
        assert_eq!(saved_monitor_index(&monitors, &legacy), Some(0));
        let disconnected = [(Some("Other"), right)];
        assert_eq!(saved_monitor_index(&disconnected, &placement), None);
    }

    #[test]
    fn appearance_changes_do_not_trigger_native_geometry_or_visibility_reset() {
        let initial = Settings::default();
        let mut next = initial.clone();
        next.ui_style = "editorial".into();
        next.theme = "dark".into();
        next.ddl_sort = "priority".into();
        next.hide_delay = 1000;
        assert!(same_window_layout(&initial, &next));
        next.panel_width += 10.;
        assert!(!same_window_layout(&initial, &next));
        next = initial.clone();
        next.pinned = true;
        assert!(!same_window_layout(&initial, &next));
        next = initial.clone();
        next.edge_enabled = false;
        assert!(!same_window_layout(&initial, &next));
    }
}
