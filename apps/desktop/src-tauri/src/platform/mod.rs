#[cfg(any(target_os = "macos", test))]
mod console_coordinates;
mod console_geometry;
pub mod console_window;
mod edge_coordinates;
pub mod exit;
mod geometry;
#[cfg(target_os = "macos")]
mod macos_exit;
pub mod startup_recovery;
#[cfg(any(target_os = "windows", test))]
mod windows_input;
use crate::{
    domain::{Action, Settings},
    AppState,
};
use edge_coordinates::{CoordinateSpace, DockLayout, MonitorGeometry, Point, Rect};
use geometry::PhysicalRect;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(target_os = "macos")]
const EDGE_SPACE: CoordinateSpace = CoordinateSpace::MacLogical;
#[cfg(not(target_os = "macos"))]
const EDGE_SPACE: CoordinateSpace = CoordinateSpace::WindowsPhysical;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    monitor_name: Option<String>,
    #[serde(default)]
    monitor_position: Option<MonitorPosition>,
    #[serde(default = "default_offset")]
    offset: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    session: String,
    settings: Settings,
    draft: Settings,
    placement: Placement,
    // Global AppKit logical units on Mac; desktop physical pixels on Windows.
    top: f64,
    monitor_signature: String,
}
#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum ResizeRequest {
    Start {
        session: String,
        #[serde(rename = "expectedSettings")]
        expected_settings: Settings,
    },
    Preview {
        session: String,
        width: f64,
        height: f64,
    },
    Commit {
        session: String,
        width: f64,
        height: f64,
    },
    Cancel {
        session: String,
    },
}
impl ResizeRequest {
    fn session(&self) -> &str {
        match self {
            Self::Start { session, .. }
            | Self::Preview { session, .. }
            | Self::Commit { session, .. }
            | Self::Cancel { session } => session,
        }
    }
}
pub struct DockRuntime {
    placement: Placement,
    visible: bool,
    interaction_owners: BTreeSet<String>,
    geometry: Option<DockLayout>,
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

    fn poll_interval(&self) -> Duration {
        let millis = if self.drag.is_some() {
            40
        } else if self.resize.is_some() {
            80
        } else if self
            .applied_settings
            .as_ref()
            .is_some_and(|settings| !settings.edge_enabled)
            && self.window_error.is_none()
        {
            500
        } else if self.visible {
            80
        } else {
            160
        };
        Duration::from_millis(millis)
    }

    fn cancel_resize(&mut self, session: Option<&str>) -> bool {
        if self
            .resize
            .as_ref()
            .is_none_or(|resize| session.is_some_and(|id| id != resize.session))
        {
            return false;
        }
        let resize = self.resize.take().unwrap();
        self.placement = resize.placement;
        self.applied_settings = None;
        self.left = None;
        true
    }

    fn resize_invalidated(&self, settings: &Settings, signature: &str) -> Option<&'static str> {
        let resize = self.resize.as_ref()?;
        if resize.settings != *settings {
            Some("缩放期间设置已更新，已恢复最新设置，请重新调整。")
        } else if resize.monitor_signature != signature {
            Some("缩放期间屏幕或缩放比例已改变，已恢复保存尺寸，请重新调整。")
        } else {
            None
        }
    }

    fn require_resize_session(&self, session: &str) -> Result<&Resize, String> {
        self.resize
            .as_ref()
            .filter(|resize| resize.session == session)
            .ok_or_else(|| "这次缩放已结束，请重新调整。".into())
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
            "retryConsolePosition",
            "discardConsolePosition",
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
fn edge_monitor(monitor: &tauri::Monitor) -> Result<MonitorGeometry, String> {
    let area = monitor.work_area();
    edge_coordinates::monitor_geometry(
        EDGE_SPACE,
        PhysicalRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
        PhysicalRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        monitor.scale_factor(),
    )
}
fn monitor_signature(monitor: &tauri::Monitor, geometry: &MonitorGeometry) -> String {
    // Real DPI remains part of the signature even when the logical area is unchanged.
    format!("{:?}:{:?}", geometry, monitor.name())
}
fn edge_cursor(source: &WebviewWindow) -> Result<Point, String> {
    #[cfg(target_os = "macos")]
    let primary_scale = source
        .primary_monitor()
        .map_err(error)?
        .ok_or("主屏暂不可用，请稍后重试。")?
        .scale_factor();
    #[cfg(not(target_os = "macos"))]
    let primary_scale = 1.; // Windows cursor values already use desktop physical pixels.
    let cursor = source.cursor_position().map_err(error)?;
    edge_coordinates::cursor_point(EDGE_SPACE, cursor.x, cursor.y, primary_scale)
}
fn edge_window_rect(source: &WebviewWindow) -> Result<Rect, String> {
    let scale = source.scale_factor().map_err(error)?;
    let position = source.outer_position().map_err(error)?;
    let size = source.outer_size().map_err(error)?;
    if source.scale_factor().map_err(error)? != scale {
        return Err("屏幕缩放正在变化，请重新调整小窗。".into());
    }
    edge_coordinates::window_rect(
        EDGE_SPACE,
        PhysicalRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        scale,
    )
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
fn set_edge_size(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let size = LogicalSize::new(rect.width, rect.height);
    #[cfg(not(target_os = "macos"))]
    let size = {
        let physical = rect.physical_rect()?;
        PhysicalSize::new(physical.width, physical.height)
    };
    window.set_size(size).map_err(error)
}
fn set_edge_position(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let position = LogicalPosition::new(rect.x, rect.y);
    #[cfg(not(target_os = "macos"))]
    let position = {
        let physical = rect.physical_rect()?;
        PhysicalPosition::new(physical.x, physical.y)
    };
    window.set_position(position).map_err(error)
}
fn rect_applied(
    actual: Rect,
    desired: Rect,
    work: Rect,
    actual_scale: f64,
    target_scale: f64,
) -> bool {
    let epsilon = 0.000_001;
    target_scale.is_finite()
        && target_scale > 0.
        && actual_scale == target_scale
        && [
            actual.x - desired.x,
            actual.y - desired.y,
            actual.width - desired.width,
            actual.height - desired.height,
        ]
        .iter()
        .all(|delta| delta.is_finite() && delta.abs() <= epsilon)
        && actual.x >= work.x - epsilon
        && actual.y >= work.y - epsilon
        && actual.x + actual.width <= work.x + work.width + epsilon
        && actual.y + actual.height <= work.y + work.height + epsilon
}
fn confirm_edge_rect(
    window: &WebviewWindow,
    rect: Rect,
    monitor: &MonitorGeometry,
    repair_hidden: bool,
) -> Result<Rect, String> {
    // SetWindowPos and DPI notifications can complete after a setter returns.
    // Require two matching samples before revealing/caching a hidden transition.
    let mut previous = None;
    for _ in 0..32 {
        let actual = edge_window_rect(window)?;
        let scale = window.scale_factor().map_err(error)?;
        if rect_applied(actual, rect, monitor.work, scale, monitor.scale) {
            if previous == Some(actual) {
                return Ok(actual);
            }
            previous = Some(actual);
        } else {
            previous = None;
            if repair_hidden {
                set_edge_size(window, rect)?;
                set_edge_position(window, rect)?;
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    Err("屏幕或窗口尺寸尚未稳定，已暂停小窗；请稍后重试。".into())
}

#[cfg(not(target_os = "windows"))]
fn show_verified_edge(
    window: &WebviewWindow,
    _rect: Rect,
    _monitor: &MonitorGeometry,
) -> Result<(), String> {
    window.show().map_err(error)
}

#[cfg(target_os = "windows")]
fn show_verified_edge(
    window: &WebviewWindow,
    rect: Rect,
    monitor: &MonitorGeometry,
) -> Result<(), String> {
    // A first Win32 show can reapply the creation-time minimum-track frame.
    // Keep recovery inside this operation: hide, reapply while hidden, and
    // retry once before surfacing an error. Never repair a visible rectangle.
    let attempts = 2;
    for attempt in 0..attempts {
        let result = (|| {
            window.show().map_err(error)?;
            // Windows can enforce minimum tracking sizes during ShowWindow even
            // after hidden geometry was confirmed. Never cache a widened handle as
            // applied. Queries run on the worker/async IPC path, not a main callback.
            for sample in 0..2 {
                let actual = edge_window_rect(window)?;
                let scale = window.scale_factor().map_err(error)?;
                if !rect_applied(actual, rect, monitor.work, scale, monitor.scale) {
                    return Err("显示后系统改变了小窗边界，已暂停小窗；请重试窗口设置。".into());
                }
                if sample == 0 {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            Ok(())
        })();
        if result.is_ok() {
            return result;
        }
        let _ = window.hide();
        if attempt + 1 == attempts {
            return result;
        }
        // The visibility query also confirms the queued hide has completed.
        if window.is_visible().map_err(error)? {
            return result;
        }
        apply_rect(window, rect, monitor)?;
    }
    unreachable!("at least one native show attempt")
}
fn apply_rect(
    window: &WebviewWindow,
    rect: Rect,
    monitor: &MonitorGeometry,
) -> Result<Rect, String> {
    // Called while hidden. Moving a large window can keep it assigned to its old
    // monitor. A small staging frame selects the target before applying its DPI.
    if window.scale_factor().map_err(error)? != monitor.scale {
        set_edge_size(
            window,
            Rect {
                width: 1.,
                height: 1.,
                ..rect
            },
        )?;
        set_edge_position(window, rect)?;
        for _ in 0..12 {
            if window.scale_factor().map_err(error)? == monitor.scale {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if window.scale_factor().map_err(error)? != monitor.scale {
            return Err("小窗尚未切换到目标屏幕的缩放比例，请稍后重试。".into());
        }
    }
    // Mac logical setters avoid reinterpreting target pixels using the old scale.
    // Windows reapplies physical size after its WM_DPICHANGED resizing has settled.
    set_edge_size(window, rect)?;
    set_edge_position(window, rect)?;
    confirm_edge_rect(window, rect, monitor, true)
}
fn apply_rect_live(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    // Shrink before moving, then expand within the same work area. The old and new
    // sizes are first placed in the same coordinate plane, including mixed DPI.
    let old = edge_window_rect(window)?;
    set_edge_size(
        window,
        Rect {
            width: old.width.min(rect.width),
            height: old.height.min(rect.height),
            ..rect
        },
    )?;
    set_edge_position(window, rect)?;
    set_edge_size(window, rect)
}
fn same_window_layout(previous: &Settings, next: &Settings) -> bool {
    // Appearance, task ordering, and the internal section split update inside
    // the existing WebView; they must not hide/re-show or refocus the window.
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
        invalidate_geometry(app, dock);
    }
    result
}

fn invalidate_geometry(app: &tauri::AppHandle, dock: &mut DockRuntime) {
    // Never cache a failed or unconfirmed native application as successful.
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

fn apply_geometry_inner(
    app: &tauri::AppHandle,
    dock: &mut DockRuntime,
    settings: &Settings,
) -> Result<(), String> {
    if !settings.edge_enabled {
        // Pausing the edge does not require a connected monitor. Hide once and
        // skip all monitor/cursor/geometry work until it is enabled again.
        if dock.visible
            || dock.geometry.is_some()
            || !dock
                .applied_settings
                .as_ref()
                .is_some_and(|previous| !previous.edge_enabled)
        {
            window(app, "edge-panel")?.hide().map_err(error)?;
            window(app, "edge-handle")?.hide().map_err(error)?;
        }
        dock.visible = false;
        dock.geometry = None;
        dock.signature.clear();
        dock.entered = None;
        dock.left = None;
        dock.applied_settings = Some(settings.clone());
        return Ok(());
    }
    let monitor = choose_monitor(app, &dock.placement)?;
    let area = edge_monitor(&monitor)?;
    let signature = monitor_signature(&monitor, &area);
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
    let mut geometry = edge_coordinates::dock_layout(
        EDGE_SPACE,
        &area,
        settings.panel_width,
        settings.panel_height,
        settings.edge == "left",
        dock.placement.offset,
    )?;
    #[cfg(target_os = "macos")]
    {
        geometry.panel = edge_coordinates::mac_native_rect(geometry.panel, area.work)?;
        geometry.handle = edge_coordinates::mac_native_rect(geometry.handle, area.work)?;
    }
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
        geometry.panel = confirm_edge_rect(&panel, geometry.panel, &area, false)?;
    } else {
        geometry.panel = apply_rect(&panel, geometry.panel, &area)?;
    }
    let handle_unchanged = live_resize
        && dock
            .geometry
            .is_some_and(|previous| previous.handle == geometry.handle);
    if !handle_unchanged {
        geometry.handle = apply_rect(&handle, geometry.handle, &area)?;
    }
    let fresh_monitor = choose_monitor(app, &dock.placement)?;
    if monitor_signature(&fresh_monitor, &edge_monitor(&fresh_monitor)?) != signature {
        return Err("定位期间屏幕已改变，已暂停小窗；请稍后重试。".into());
    }
    dock.geometry = Some(geometry);
    dock.signature = signature;
    if settings.edge_enabled {
        if dock.visible || settings.pinned {
            if !live_resize {
                show_verified_edge(&panel, geometry.panel, &area)?;
            }
            dock.visible = true;
        } else {
            show_verified_edge(&handle, geometry.handle, &area)?;
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
    let result = (|| {
        let monitor = choose_monitor(app, &dock.placement)?;
        let area = edge_monitor(&monitor)?;
        let rect = dock.geometry.ok_or("小窗尚未定位。")?.panel;
        show_verified_edge(&window(app, "edge-panel")?, rect, &area)
    })();
    if let Err(message) = result {
        invalidate_geometry(app, dock);
        return Err(message);
    }
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
        let result = (|| {
            let monitor = choose_monitor(app, &dock.placement)?;
            let area = edge_monitor(&monitor)?;
            let rect = dock.geometry.ok_or("小窗尚未定位。")?.handle;
            show_verified_edge(&window(app, "edge-handle")?, rect, &area)
        })();
        if let Err(message) = result {
            invalidate_geometry(app, dock);
            return Err(message);
        }
    }
    dock.visible = false;
    dock.entered = None;
    dock.left = None;
    dock.suppressed = suppress;
    Ok(())
}
pub fn open_console(app: &tauri::AppHandle, payload: Value) -> Result<(), String> {
    if app.try_state::<AppState>().is_some() {
        return console_window::open(app, payload);
    }
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
    .visible(recovery)
    .focused(recovery)
    .on_navigation(local_navigation)
    .build()?;
    if !recovery {
        console_window::start(app.handle(), &console)?;
    }
    let console_copy = console.clone();
    console.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if recovery {
                if let Err(error) = exit::request(console_copy.app_handle()) {
                    eprintln!("recovery close request: {error}");
                }
            } else {
                let _ = console_window::hide(console_copy.app_handle());
            }
        }
        if !recovery
            && matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            )
        {
            if let Some(state) = console_copy.app_handle().try_state::<AppState>() {
                state.console.changed();
            }
        }
    });
    Ok(())
}

fn setup_auxiliary(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    for (label, width, height) in [("edge-panel", 376., 620.), ("edge-handle", 18., 92.)] {
        let builder = WebviewWindowBuilder::new(
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
        .on_navigation(local_navigation);
        // Without explicit constraints Win32 applies SM_CXMINTRACK on show,
        // widening the narrow handle after hidden frame confirmation.
        #[cfg(target_os = "windows")]
        let builder = builder.min_inner_size(1., 1.);
        builder.build()?;
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
    let tray = tauri::tray::TrayIconBuilder::with_id("sidetask")
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
        });
    #[cfg(target_os = "windows")]
    let tray = {
        // Template images are macOS-only. The bundled colored icon stays
        // recognizable on both light and dark Windows taskbars.
        let tray = if let Some(icon) = app.default_window_icon() {
            tray.icon(icon.clone())
        } else {
            tray
        };
        tray.show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    }
                ) {
                    if let Err(message) = open_console(tray.app_handle(), Value::Null) {
                        eprintln!("tray open console: {message}");
                    }
                }
            })
    };
    tray.build(app)?;
    let app_handle = app.handle().clone();
    std::thread::Builder::new()
        .name("sidetask-edge".into())
        .spawn(move || {
            let mut last_error = String::new();
            loop {
                let interval = app_handle
                    .state::<AppState>()
                    .dock
                    .lock()
                    .map(|d| d.poll_interval())
                    .unwrap_or(Duration::from_millis(160));
                std::thread::sleep(interval);
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
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    let settings = settings(app)?;
    if let Some(drag) = &mut dock.drag {
        drag.cancelled |= escape_down() || drag.settings != settings;
        if drag.started.elapsed() > Duration::from_millis(160) && !primary_button_down() {
            finish_drag(app, &mut dock)?;
        }
        return Ok(());
    }
    if dock.resize.is_some() {
        let reason = if escape_down() {
            Some("已取消小窗尺寸调整。")
        } else {
            let signature = choose_monitor(app, &dock.placement).and_then(|monitor| {
                edge_monitor(&monitor).map(|area| monitor_signature(&monitor, &area))
            });
            let signature = match signature {
                Ok(signature) => signature,
                Err(message) => {
                    dock.cancel_resize(None);
                    invalidate_geometry(app, &mut dock);
                    return Err(message);
                }
            };
            dock.resize_invalidated(&settings, &signature)
        };
        if let Some(message) = reason {
            dock.cancel_resize(None);
            let _ = app.emit("sidetask:window-error", message);
        }
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
    let cursor = edge_cursor(&panel)?;
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
        if settings.pinned || over_panel || over_handle || primary_button_down() {
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
    let request: ResizeRequest =
        serde_json::from_value(payload).map_err(|_| "小窗缩放请求无效。")?;
    if request.session().is_empty() || request.session().len() > 128 {
        return Err("小窗缩放会话无效。".into());
    }
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    // Do not hold the service lock across native window calls.
    let current = settings(app)?;
    if let ResizeRequest::Cancel { session } = &request {
        if dock.cancel_resize(Some(session)) {
            apply_geometry(app, &mut dock, &current)?;
        }
        return Ok(());
    }
    if let ResizeRequest::Start {
        session,
        expected_settings,
    } = request
    {
        if dock.drag.is_some() || dock.resize.is_some() {
            return Err("请先结束当前移动或缩放。".into());
        }
        exit::ensure_running(&state)?;
        if current != expected_settings {
            return Err("小窗设置已更新，请重新调整。".into());
        }
        apply_geometry(app, &mut dock, &current)?;
        dock.resize = Some(Resize {
            session,
            settings: current.clone(),
            draft: current,
            placement: dock.placement.clone(),
            top: dock.geometry.ok_or("小窗尚未定位。")?.panel.y,
            monitor_signature: dock.signature.clone(),
        });
        return Ok(());
    }
    let (session, width, height, commit) = match request {
        ResizeRequest::Preview {
            session,
            width,
            height,
        } => (session, width, height, false),
        ResizeRequest::Commit {
            session,
            width,
            height,
        } => (session, width, height, true),
        _ => unreachable!(),
    };
    // Only Start creates a gesture. Queued previews/commits after a cancellation,
    // conflict or failed commit cannot resurrect it using a newer settings base.
    dock.require_resize_session(&session)?;
    let result = (|| -> Result<(), String> {
        if !width.is_finite() || !height.is_finite() {
            return Err("小窗尺寸无效。".into());
        }
        let width = width.clamp(300., 640.);
        let height = height.clamp(380., 1000.);
        let monitor = choose_monitor(app, &dock.placement)?;
        let area = edge_monitor(&monitor)?;
        let signature = monitor_signature(&monitor, &area);
        if let Some(message) = dock.resize_invalidated(&current, &signature) {
            return Err(message.into());
        }
        let mut draft = current.clone();
        draft.panel_width = width;
        draft.panel_height = height;
        dock.placement.offset = edge_coordinates::resize_offset(
            EDGE_SPACE,
            &area,
            width,
            height,
            draft.edge == "left",
            dock.resize.as_ref().unwrap().top,
        )?;
        dock.resize.as_mut().unwrap().draft = draft.clone();
        // Preview is runtime-only; SQLite is touched once on an explicit commit.
        apply_geometry(app, &mut dock, &draft)?;
        if let Some(message) = dock.resize_invalidated(&current, &dock.signature) {
            return Err(message.into());
        }
        if !commit {
            return Ok(());
        }
        let monitor = choose_monitor(app, &dock.placement)?;
        let fresh_signature = monitor_signature(&monitor, &edge_monitor(&monitor)?);
        if let Some(message) = dock.resize_invalidated(&current, &fresh_signature) {
            return Err(message.into());
        }
        let mut service = state.service.lock().map_err(|_| "任务服务不可用。")?;
        exit::ensure_running(&state)?;
        if service.snapshot.settings != current {
            return Err("缩放期间设置已更新，请重新调整。".into());
        }
        let next = service.snapshot.apply(
            Action::UpdateSettings {
                changes: json!({"panelWidth":width,"panelHeight":height}),
            },
            service.snapshot.revision,
        )?;
        let placement = serde_json::to_string(&dock.placement).map_err(error)?;
        service.repository.save_placement(&next, &placement)?;
        service.snapshot = next.clone();
        drop(service);
        dock.resize = None;
        let _ = app.emit("sidetask:changed", json!({"revision":next.revision}));
        Ok(())
    })();
    if let Err(message) = result {
        dock.cancel_resize(Some(&session));
        // Latest committed settings may have changed during the native preview.
        // A failed rollback still invalidates/hides geometry and surfaces both errors.
        let restored = settings(app).and_then(|latest| apply_geometry(app, &mut dock, &latest));
        return match restored {
            Ok(()) => Err(message),
            Err(rollback) => Err(format!("{message} 恢复窗口失败：{rollback}")),
        };
    }
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
    let cursor = edge_cursor(&source)?;
    let monitors = source.available_monitors().map_err(error)?;
    let monitor_geometry = monitors
        .iter()
        .map(edge_monitor)
        .collect::<Result<Vec<_>, _>>()?;
    let target = edge_coordinates::monitor_at_point(&monitor_geometry, cursor)
        .map(|index| monitors[index].clone())
        .or(source.current_monitor().map_err(error)?)
        .ok_or("找不到目标屏幕。")?;
    let area = edge_monitor(&target)?;
    let source_rect = edge_window_rect(&source)?;
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
    let edge = if cursor.x < area.work.x + area.work.width / 2. {
        "left"
    } else {
        "right"
    };
    let offset = edge_coordinates::drag_offset(
        EDGE_SPACE,
        &area,
        current.panel_width,
        current.panel_height,
        edge == "left",
        source_rect.center_y(),
    )?;
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
    if action == "retryConsolePosition" {
        return console_window::retry(app);
    }
    if action == "discardConsolePosition" {
        return console_window::discard(app);
    }
    if action == "startDrag" {
        if !["edge-handle", "edge-panel"].contains(&caller.label()) {
            return Err("此窗口不能停靠。".into());
        }
        {
            let state = app.state::<AppState>();
            let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
            let settings = settings(app)?;
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
        let result = {
            let state = app.state::<AppState>();
            let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
            let desired = settings(app)?;
            if dock.drag.is_some() || dock.resize.is_some() {
                return Err("请先结束移动或缩放，再重试窗口设置。".into());
            }
            dock.applied_settings = None;
            apply_geometry(app, &mut dock, &desired)
        };
        publish_window_status(app, result.as_ref().err().cloned());
        return result;
    }
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().map_err(|_| "窗口服务不可用。")?;
    let settings = settings(app)?;
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
        "finishDrag" if primary_button_down() => Ok(()),
        "finishDrag" => finish_drag(app, &mut dock),
        "cancelDrag" => {
            if let Some(drag) = dock.drag.as_mut() {
                if drag.label != caller.label() {
                    return Err("不能取消其他窗口的拖动。".into());
                }
                drag.cancelled = true;
            }
            if primary_button_down() {
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
            if !locked && caller.label() == "edge-panel" && dock.cancel_resize(None) {
                apply_geometry(app, &mut dock, &settings)?;
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
fn primary_button_down() -> bool {
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
fn primary_button_down() -> bool {
    windows_input::primary_button_down()
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
fn primary_button_down() -> bool {
    false
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn escape_down() -> bool {
    false
}
#[cfg(test)]
mod tests {
    use super::*;

    fn resizing_dock() -> DockRuntime {
        let saved = Placement {
            monitor_name: Some("Saved display".into()),
            monitor_position: Some(MonitorPosition { x: -1920, y: 0 }),
            offset: 0.7,
        };
        let mut dock = DockRuntime::new(saved.clone());
        let settings = Settings::default();
        let mut draft = settings.clone();
        draft.panel_width = 480.;
        dock.resize = Some(Resize {
            session: "first".into(),
            settings,
            draft: draft.clone(),
            placement: saved,
            top: -300.5,
            monitor_signature: "negative-display@1.5".into(),
        });
        dock.applied_settings = Some(draft);
        dock.placement.offset = 0.2;
        dock
    }

    #[test]
    fn cancelled_resize_restores_placement_and_rejects_every_queued_request() {
        let mut dock = resizing_dock();
        assert!(dock.require_resize_session("first").is_ok());
        assert!(!dock.cancel_resize(Some("other")));
        assert_eq!(dock.placement.offset, 0.2);
        assert!(dock.cancel_resize(Some("first")));
        assert_eq!(dock.placement.offset, 0.7);
        assert_eq!(
            dock.placement.monitor_position,
            Some(MonitorPosition { x: -1920, y: 0 })
        );
        assert!(dock.applied_settings.is_none());
        for _ in 0..3 {
            assert!(dock.require_resize_session("first").is_err());
            assert!(!dock.cancel_resize(Some("first")));
        }
        assert!(!dock.locked());
    }

    #[test]
    fn resize_conflict_and_dpi_change_invalidate_the_gesture_without_restarting_it() {
        let mut dock = resizing_dock();
        let saved = dock.resize.as_ref().unwrap().settings.clone();
        assert!(dock
            .resize_invalidated(&saved, "negative-display@1.5")
            .is_none());
        assert!(dock
            .resize_invalidated(&saved, "negative-display@2")
            .is_some());
        let mut latest = saved.clone();
        latest.edge = if saved.edge == "left" {
            "right"
        } else {
            "left"
        }
        .into();
        assert!(dock
            .resize_invalidated(&latest, "negative-display@1.5")
            .is_some());
        dock.cancel_resize(None);
        assert!(dock.require_resize_session("first").is_err());
        // A stale cancel/commit must not affect an explicitly begun newer gesture.
        dock.resize = resizing_dock().resize;
        dock.resize.as_mut().unwrap().session = "second".into();
        assert!(dock.require_resize_session("first").is_err());
        assert!(!dock.cancel_resize(Some("first")));
        assert!(dock.require_resize_session("second").is_ok());
    }

    #[test]
    fn resize_protocol_requires_explicit_phases_and_start_settings() {
        for payload in [
            json!({"width":480,"height":700,"commit":true}),
            json!({"phase":"start","session":"first"}),
            json!({"phase":"preview","session":"first","width":480}),
            json!({"phase":"commit","width":480,"height":700}),
        ] {
            assert!(serde_json::from_value::<ResizeRequest>(payload).is_err());
        }
        let cancel: ResizeRequest =
            serde_json::from_value(json!({"phase":"cancel","session":"first"})).unwrap();
        assert_eq!(cancel.session(), "first");
        let start: ResizeRequest = serde_json::from_value(
            json!({"phase":"start","session":"first","expectedSettings":Settings::default()}),
        )
        .unwrap();
        assert!(matches!(start, ResizeRequest::Start { .. }));
    }

    #[test]
    fn native_dock_confirmation_rejects_dpi_resize_and_one_pixel_leaks() {
        let work = Rect {
            x: -1920.,
            y: -200.,
            width: 1920.,
            height: 1080.,
        };
        let desired = Rect {
            x: -564.,
            y: -100.,
            width: 564.,
            height: 900.,
        };
        assert!(rect_applied(desired, desired, work, 1.5, 1.5));
        // A native DPI message can resize the frame after our setter returned.
        let dpi_adjusted = Rect {
            width: 846.,
            height: 1350.,
            ..desired
        };
        assert!(!rect_applied(dpi_adjusted, desired, work, 1.5, 1.5));
        assert!(!rect_applied(desired, desired, work, 1., 1.5));
        let leaking = Rect {
            x: desired.x + 1.,
            ..desired
        };
        assert!(!rect_applied(leaking, leaking, work, 1.5, 1.5));
        let stale_position = Rect {
            y: desired.y + 1.,
            ..desired
        };
        assert!(!rect_applied(stale_position, desired, work, 1.5, 1.5));
        let fractional = Rect {
            x: -563. / 1.5,
            y: -100. / 1.5,
            width: 551. / 1.5,
            height: 900. / 1.5,
        };
        assert!(rect_applied(fractional, fractional, work, 1.5, 1.5));
    }

    #[test]
    fn auxiliary_windows_cannot_quit_or_invoke_console_operations() {
        for label in ["edge-panel", "edge-handle", "unknown"] {
            assert!(authorize_window_action(label, "quit").is_err());
        }
        assert!(authorize_window_action("edge-handle", "resizePanel").is_err());
        assert!(authorize_window_action("edge-handle", "interaction").is_err());
        assert!(authorize_window_action("console", "startDrag").is_err());
        for action in ["retryConsolePosition", "discardConsolePosition"] {
            assert!(authorize_window_action("console", action).is_ok());
            assert!(authorize_window_action("edge-panel", action).is_err());
            assert!(authorize_window_action("edge-handle", action).is_err());
        }
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
    fn paused_edge_slows_polling_only_after_native_success_and_gestures_stay_responsive() {
        let mut dock = DockRuntime::new(Placement::default());
        assert_eq!(dock.poll_interval(), Duration::from_millis(160));
        let settings = Settings {
            edge_enabled: false,
            ..Settings::default()
        };
        dock.applied_settings = Some(settings);
        assert_eq!(dock.poll_interval(), Duration::from_millis(500));
        dock.window_error = Some("hide failed".into());
        assert_eq!(dock.poll_interval(), Duration::from_millis(160));
        dock.window_error = None;
        dock.drag = Some(Drag {
            label: "edge-handle".into(),
            started: Instant::now(),
            settings: Settings::default(),
            original_visible: false,
            cancelled: false,
        });
        assert_eq!(dock.poll_interval(), Duration::from_millis(40));
        dock.drag = None;
        dock.resize = resizing_dock().resize;
        assert_eq!(dock.poll_interval(), Duration::from_millis(80));
        dock.resize = None;
        dock.applied_settings = Some(Settings::default());
        dock.visible = true;
        assert_eq!(dock.poll_interval(), Duration::from_millis(80));
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
        for split in [30, 70] {
            let mut internal_layout = initial.clone();
            internal_layout.panel_split = split;
            assert!(same_window_layout(&initial, &internal_layout));
        }
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
