//! Console geometry is device metadata. The worker serializes native sampling and
//! saves without holding a runtime or database lock across a native call.
use super::console_geometry::{
    self as geometry, CloseSide, ConsolePlacement, GeometryMonitor, PixelSize, Point, RestorePlan,
    WindowFrame,
};
use super::geometry::PhysicalRect;
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionStatus {
    pub pending: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ConsoleRuntime {
    generation: Arc<AtomicU64>,
    sender: Mutex<Option<mpsc::Sender<Command>>>,
    status: Mutex<PositionStatus>,
    initial: Mutex<Option<Result<ConsolePlacement, String>>>,
}

enum Command {
    Reveal(Value),
    Hide,
    Flush(mpsc::Sender<Result<(), String>>),
    Retry(mpsc::Sender<Result<(), String>>),
    Discard(mpsc::Sender<Result<(), String>>),
}

impl ConsoleRuntime {
    pub fn new(placement: Option<&str>) -> Self {
        // An invalid console preference must not throw away valid edge metadata.
        let initial = placement.and_then(|raw| {
            let value: Value = serde_json::from_str(raw).ok()?;
            let value = value.get("console")?.clone();
            Some(
                serde_json::from_value::<ConsolePlacement>(value)
                    .map_err(|e| format!("上次窗口位置格式无效：{e}"))
                    .and_then(|placement| {
                        geometry::validate(&placement)?;
                        Ok(placement)
                    }),
            )
        });
        Self {
            initial: Mutex::new(initial),
            ..Self::default()
        }
    }
    fn send(&self, command: Command) -> Result<(), String> {
        self.sender
            .lock()
            .map_err(|_| "窗口位置服务暂不可用。")?
            .as_ref()
            .ok_or("窗口位置服务尚未准备好。")?
            .send(command)
            .map_err(|_| "窗口位置服务已停止。".into())
    }
    pub fn changed(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Clone, Default)]
struct Model {
    saved: Option<ConsolePlacement>,
    candidate: Option<ConsolePlacement>,
    ignored: Option<ConsolePlacement>,
    error: Option<String>,
    verify_after: Option<RestorePlan>,
    restore_failed: bool,
    awaiting_maximize: bool,
    applied_min: Option<PixelSize>,
}
impl Model {
    fn observe(&mut self, value: ConsolePlacement) {
        if self.restore_failed {
            return;
        }
        if self.candidate.as_ref() != Some(&value) {
            self.candidate = Some(value);
            self.error = None;
        }
    }
    fn pending(&self) -> bool {
        self.candidate.is_some() && self.candidate != self.saved && self.candidate != self.ignored
    }
    fn status(&self) -> PositionStatus {
        PositionStatus {
            pending: self.pending() || self.error.is_some(),
            error: self.error.clone(),
        }
    }
    fn discard(&mut self) {
        self.ignored = self.candidate.clone();
        self.error = None;
        self.verify_after = None;
        self.restore_failed = false;
        self.awaiting_maximize = false;
    }
    fn committed(&mut self, value: ConsolePlacement) {
        self.saved = Some(value);
        self.ignored = None;
        self.error = None;
    }
}

fn close_side() -> CloseSide {
    if cfg!(target_os = "macos") {
        CloseSide::Left
    } else {
        CloseSide::Right
    }
}
fn err(reason: impl std::fmt::Display) -> String {
    reason.to_string()
}
fn frame(window: &WebviewWindow) -> Result<WindowFrame, String> {
    #[cfg(target_os = "macos")]
    {
        if objc2::MainThreadMarker::new().is_some() {
            return read_frame(window);
        }
        // One AppKit turn samples both native title layout and Tauri geometry.
        // Callers hold no task/dock lock, and a busy event loop cannot block this
        // worker forever. The queued operation is read-only if it arrives late.
        let (tx, rx) = mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(read_frame(&target));
            })
            .map_err(err)?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "控制台原生测量超时，未保存当前位置。".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        read_frame(window)
    }
}

fn read_frame(window: &WebviewWindow) -> Result<WindowFrame, String> {
    let outer = window.outer_position().map_err(err)?;
    let outer_size = window.outer_size().map_err(err)?;
    let inner = window.inner_size().map_err(err)?;
    let window_scale = window.scale_factor().map_err(err)?;
    #[cfg(target_os = "macos")]
    let top_inset = {
        use objc2::{msg_send, runtime::AnyObject};
        use objc2_foundation::NSRect;

        if objc2::MainThreadMarker::new().is_none() {
            return Err("控制台原生测量必须在主线程完成。".into());
        }
        let pointer = window.ns_window().map_err(err)?.cast::<AnyObject>();
        // SAFETY: Tauri owns this live NSWindow; the cloned WebviewWindow keeps
        // it alive during this main-thread sample. NSRect uses the existing
        // objc2-foundation binding, including the platform's struct-return ABI.
        let (native_frame, layout) = unsafe {
            let native = pointer.as_ref().ok_or("找不到控制台原生窗口。")?;
            let native_frame: NSRect = msg_send![native, frame];
            let layout: NSRect = msg_send![native, contentLayoutRect];
            (native_frame, layout)
        };
        super::console_coordinates::title_inset_from_layout(
            native_frame.size.height,
            layout.origin.y,
            layout.size.height,
            window_scale,
        )?
    };
    #[cfg(not(target_os = "macos"))]
    let inner_position = window.inner_position().map_err(err)?;
    #[cfg(not(target_os = "macos"))]
    let top_inset = (i64::from(inner_position.y) - i64::from(outer.y))
        .clamp(0, i64::from(outer_size.height)) as u32;
    let raw = WindowFrame {
        outer: PhysicalRect {
            x: outer.x,
            y: outer.y,
            width: outer_size.width,
            height: outer_size.height,
        },
        inner: PixelSize {
            width: inner.width,
            height: inner.height,
        },
        window_scale,
        top_inset,
    };
    // macOS origins use the window's backing scale, whereas monitor origins
    // use each screen's scale. Normalize before comparing desktop geometry.
    #[cfg(target_os = "macos")]
    {
        super::console_coordinates::frame_to_logical(raw)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(raw)
    }
}
fn monitors(window: &WebviewWindow) -> Result<Vec<GeometryMonitor>, String> {
    let primary = window
        .primary_monitor()
        .map_err(err)?
        .map(|m| *m.position());
    let raw: Vec<_> = window
        .available_monitors()
        .map_err(err)?
        .into_iter()
        .map(|m| {
            let p = m.position();
            let w = m.work_area();
            GeometryMonitor {
                name: m.name().cloned(),
                position: Point { x: p.x, y: p.y },
                work: PhysicalRect {
                    x: w.position.x,
                    y: w.position.y,
                    width: w.size.width,
                    height: w.size.height,
                },
                scale: m.scale_factor(),
                primary: primary == Some(*p),
            }
        })
        .collect();
    #[cfg(target_os = "macos")]
    {
        Ok(raw
            .into_iter()
            .filter_map(|monitor| super::console_coordinates::monitor_to_logical(monitor).ok())
            .collect())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(raw)
    }
}
fn apply(window: &WebviewWindow, plan: &RestorePlan) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // The geometry adapter uses global AppKit logical DIPs. Do not multiply
        // a target-screen origin by the old window's backing scale on a move.
        use tauri::{LogicalPosition, LogicalSize};
        window
            .set_min_size(Some(LogicalSize::new(
                f64::from(plan.min_inner.width),
                f64::from(plan.min_inner.height),
            )))
            .map_err(err)?;
        window
            .set_position(LogicalPosition::new(
                f64::from(plan.outer.x),
                f64::from(plan.outer.y),
            ))
            .map_err(err)?;
        window
            .set_size(LogicalSize::new(
                f64::from(plan.inner.width),
                f64::from(plan.inner.height),
            ))
            .map_err(err)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{PhysicalPosition, PhysicalSize};
        window
            .set_min_size(Some(PhysicalSize::new(
                plan.min_inner.width,
                plan.min_inner.height,
            )))
            .map_err(err)?;
        window
            .set_position(PhysicalPosition::new(plan.outer.x, plan.outer.y))
            .map_err(err)?;
        window
            .set_size(PhysicalSize::new(plan.inner.width, plan.inner.height))
            .map_err(err)
    }
}
fn apply_on_main(
    window: &WebviewWindow,
    plan: RestorePlan,
    generation: Arc<AtomicU64>,
    expected: u64,
) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = if generation.load(Ordering::Relaxed) != expected {
                Ok(false)
            } else {
                apply(&target, &plan).map(|()| true)
            };
            let _ = tx.send(result);
        })
        .map_err(err)?;
    rx.recv().map_err(|_| "窗口位置应用未完成。".to_string())?
}
fn fallback_position(window: &WebviewWindow, generation: &Arc<AtomicU64>) -> Result<(), String> {
    let expected = generation.load(Ordering::Relaxed);
    let current = frame(window)?;
    let screens = monitors(window)?;
    let position = geometry::emergency_position(&current, &screens, close_side())?;
    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    let generation = generation.clone();
    window
        .run_on_main_thread(move || {
            let result = if generation.load(Ordering::Relaxed) != expected {
                Err("窗口位置已变化，未覆盖较新的移动。".to_string())
            } else {
                #[cfg(target_os = "macos")]
                let result = target.set_position(tauri::LogicalPosition::new(
                    f64::from(position.x),
                    f64::from(position.y),
                ));
                #[cfg(not(target_os = "macos"))]
                let result =
                    target.set_position(tauri::PhysicalPosition::new(position.x, position.y));
                result.map_err(err)
            };
            let _ = tx.send(result);
        })
        .map_err(err)?;
    rx.recv().map_err(|_| "窗口位置校正未完成。".to_string())?
}

fn publish(app: &tauri::AppHandle, model: &Model) {
    let state = app.state::<AppState>();
    let next = model.status();
    let changed = if let Ok(mut status) = state.console.status.lock() {
        if *status == next {
            false
        } else {
            *status = next.clone();
            true
        }
    } else {
        false
    };
    if changed {
        let _ = app.emit_to("console", "sidetask:console-position-status", next);
    }
}
pub fn status(app: &tauri::AppHandle) -> Result<PositionStatus, String> {
    crate::task_state(app)?
        .console
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "窗口位置服务暂不可用。".into())
}
fn persist(app: &tauri::AppHandle, model: &mut Model, force: bool) -> Result<(), String> {
    if !force && !model.pending() {
        return model.error.clone().map_or(Ok(()), Err);
    }
    if !force {
        if let Some(reason) = &model.error {
            return Err(reason.clone());
        }
    }
    let Some(candidate) = model.candidate.clone() else {
        return Err("还没有可保存的窗口位置，请稍后重试。".into());
    };
    let result = (|| {
        let json = serde_json::to_string(&candidate).map_err(err)?;
        let state = crate::task_state(app)?;
        let mut service = state.service.lock().map_err(|_| "任务服务暂不可用。")?;
        super::exit::ensure_running(&state)?;
        service.repository.save_console_placement(&json)
    })();
    match &result {
        Ok(()) => model.committed(candidate),
        Err(reason) => model.error = Some(reason.clone()),
    }
    publish(app, model);
    result
}

// No native call is made from the window event callback, and none waits with a
// service/dock lock held. Startup restoration happens before the window is shown.
pub fn start(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let state = crate::task_state(app)?;
    let initial = state
        .console
        .initial
        .lock()
        .map_err(|_| "窗口位置服务暂不可用。")?
        .take();
    let mut model = Model::default();
    match initial {
        Some(Ok(saved)) => {
            model.saved = Some(saved.clone());
            model.candidate = Some(saved.clone());
        }
        Some(Err(reason)) => {
            model.error = Some(reason);
            model.restore_failed = true;
        }
        None => (),
    }
    let restored = (|| {
        let current = frame(window)?;
        let screens = monitors(window)?;
        let candidate = match model.candidate.clone() {
            Some(value) => value,
            None => ConsolePlacement {
                normal: geometry::capture_normal(&current, &screens)?,
                maximized: false,
            },
        };
        let plan = geometry::restore_plan(&candidate, &screens, &current, close_side())?;
        if let Err(reason) = apply(window, &plan) {
            model.restore_failed = true;
            return Err(reason);
        }
        model.candidate = Some(candidate);
        // Verify the resulting normal frame after native resize events settle,
        // before maximizing. Never capture the maximized frame as normal.
        model.verify_after = Some(plan);
        model.applied_min = Some(plan.min_inner);
        Ok::<(), String>(())
    })();
    if let Err(reason) = restored {
        model.restore_failed = true;
        model.error = Some(format!("无法恢复上次窗口位置：{reason}"));
    }
    publish(app, &model);
    let (tx, rx) = mpsc::channel();
    *state
        .console
        .sender
        .lock()
        .map_err(|_| "窗口位置服务暂不可用。")? = Some(tx);
    let generation = state.console.generation.clone();
    let app = app.clone();
    let window = window.clone();
    std::thread::Builder::new()
        .name("sidetask-console".into())
        .spawn(move || worker(app, window, generation, rx, model))
        .map_err(err)?;
    Ok(())
}

fn sample(
    _app: &tauri::AppHandle,
    window: &WebviewWindow,
    generation: &Arc<AtomicU64>,
    model: &mut Model,
    calibrate: bool,
) -> Result<bool, String> {
    let expected = generation.load(Ordering::Relaxed);
    if model.restore_failed {
        return Err(model
            .error
            .clone()
            .unwrap_or_else(|| "窗口恢复尚未完成，请重试或不保存本次位置。".into()));
    }
    if window.is_minimized().map_err(err)? || window.is_fullscreen().map_err(err)? {
        return Ok(false);
    }
    let maximized = window.is_maximized().map_err(err)?;
    let current = frame(window)?;
    let screens = monitors(window)?;
    if expected != generation.load(Ordering::Relaxed) {
        return Ok(false);
    }
    if let Some(plan) = model.verify_after {
        if !maximized {
            if !matches_restored_frame(&current, &plan) {
                return Err(block_restore(
                    model,
                    "系统未完整应用上次窗口位置，上次保存的位置仍保留。".into(),
                ));
            }
            if plan.maximized {
                if model.awaiting_maximize {
                    return Err(block_restore(
                        model,
                        "系统未应用最大化，上次保存的位置仍保留。".into(),
                    ));
                }
                let normal = geometry::capture_normal(&current, &screens)?;
                let (tx, rx) = mpsc::channel();
                let target = window.clone();
                let generation = generation.clone();
                window
                    .run_on_main_thread(move || {
                        let result = if generation.load(Ordering::Relaxed) != expected {
                            Ok(false)
                        } else {
                            target.maximize().map(|()| true).map_err(err)
                        };
                        let _ = tx.send(result);
                    })
                    .map_err(err)?;
                match rx.recv().map_err(|_| "窗口最大化未完成。".to_string())? {
                    Ok(true) => {
                        model.observe(ConsolePlacement {
                            normal,
                            maximized: true,
                        });
                        model.awaiting_maximize = true;
                    }
                    Ok(false) => (),
                    Err(reason) => {
                        return Err(block_restore(model, reason));
                    }
                }
                return Ok(false);
            }
        }
        model.verify_after = None;
        model.awaiting_maximize = false;
    }
    let normal = if maximized {
        let Some(value) = &model.candidate else {
            return Ok(false);
        };
        value.normal.clone()
    } else {
        geometry::capture_normal(&current, &screens)?
    };
    let candidate = ConsolePlacement { normal, maximized };
    if expected != generation.load(Ordering::Relaxed) {
        return Ok(false);
    }
    if calibrate && !maximized {
        let plan = geometry::restore_plan(&candidate, &screens, &current, close_side())?;
        if plan.outer != current.outer
            || plan.inner != current.inner
            || model.applied_min != Some(plan.min_inner)
        {
            match apply_on_main(window, plan, generation.clone(), expected) {
                Ok(true) => model.applied_min = Some(plan.min_inner),
                Ok(false) => (),
                Err(reason) => {
                    return Err(block_restore(model, reason));
                }
            }
            return Ok(false);
        }
    }
    model.observe(candidate);
    Ok(true)
}
fn accepting_current(model: &Model) -> Model {
    let mut current = model.clone();
    current.restore_failed = false;
    current.verify_after = None;
    current.awaiting_maximize = false;
    current
}
fn block_restore(model: &mut Model, reason: String) -> String {
    model.restore_failed = true;
    model.error = Some(reason.clone());
    reason
}
fn matches_restored_frame(current: &WindowFrame, plan: &RestorePlan) -> bool {
    // AppKit logical coordinates can be rounded by up to one DIP when the
    // measured physical client and decorations are converted independently.
    let close = |a: i64, b: i64| (a - b).abs() <= 2;
    close(i64::from(current.outer.x), i64::from(plan.outer.x))
        && close(i64::from(current.outer.y), i64::from(plan.outer.y))
        && close(i64::from(current.inner.width), i64::from(plan.inner.width))
        && close(
            i64::from(current.inner.height),
            i64::from(plan.inner.height),
        )
}
fn refresh_for_save(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    generation: &Arc<AtomicU64>,
    model: &mut Model,
) -> Result<(), String> {
    if window.is_minimized().map_err(err)? || window.is_fullscreen().map_err(err)? {
        return Ok(());
    }
    if sample(app, window, generation, model, false)? {
        Ok(())
    } else {
        Err("窗口位置仍在变化，尚未保存；请稍后重试。".into())
    }
}
fn reveal(window: &WebviewWindow, payload: Value) -> Result<(), String> {
    window.unminimize().map_err(err)?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    if payload.as_object().is_some_and(|object| !object.is_empty()) {
        window.emit("sidetask:navigate", payload).map_err(err)?;
    }
    let _ = window.emit("sidetask:shown", ());
    Ok(())
}
fn worker(
    app: tauri::AppHandle,
    window: WebviewWindow,
    generation: Arc<AtomicU64>,
    rx: mpsc::Receiver<Command>,
    mut model: Model,
) {
    let mut observed = generation.load(Ordering::Relaxed);
    let mut quiet_since = Instant::now();
    let mut last_sample = Instant::now();
    let mut needs_sample = true;
    let mut startup = true;
    let startup_started = Instant::now();
    let mut startup_payload = Value::Null;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Command::Reveal(payload)) => {
                // Startup remains hidden until the normal frame and optional
                // maximization are confirmed. Later reopen is an explicit focus intent.
                if startup {
                    startup_payload = payload;
                } else {
                    if let Err(reason) = sample(&app, &window, &generation, &mut model, true) {
                        model.error = Some(reason);
                        publish(&app, &model);
                    }
                    if let Err(reason) = reveal(&window, payload) {
                        model.error = Some(reason);
                        publish(&app, &model);
                    }
                }
            }
            Ok(Command::Hide) => {
                if startup {
                    startup = false;
                    block_restore(
                        &mut model,
                        "首次窗口位置恢复已取消，未改变上次保存的位置。".into(),
                    );
                }
                if let Err(reason) = refresh_for_save(&app, &window, &generation, &mut model)
                    .and_then(|()| persist(&app, &mut model, false))
                {
                    model.error = Some(reason);
                    publish(&app, &model);
                }
                let _ = window.hide();
            }
            Ok(Command::Flush(reply)) => {
                let result = refresh_for_save(&app, &window, &generation, &mut model)
                    .and_then(|_| persist(&app, &mut model, false));
                let _ = reply.send(result);
            }
            Ok(Command::Retry(reply)) => {
                // Capture must succeed before accepting a new position. A failed
                // read cannot silently remove the old recovery/write blocker.
                let mut current = accepting_current(&model);
                let result =
                    refresh_for_save(&app, &window, &generation, &mut current).and_then(|()| {
                        model = current;
                        persist(&app, &mut model, true)
                    });
                publish(&app, &model);
                let _ = reply.send(result);
            }
            Ok(Command::Discard(reply)) => {
                let mut current = accepting_current(&model);
                let result = refresh_for_save(&app, &window, &generation, &mut current).map(|()| {
                    current.discard();
                    model = current;
                });
                publish(&app, &model);
                let _ = reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        let current = generation.load(Ordering::Relaxed);
        if current != observed {
            observed = current;
            quiet_since = Instant::now();
            needs_sample = true;
        }
        if quiet_since.elapsed() >= Duration::from_millis(400)
            && (needs_sample || last_sample.elapsed() >= Duration::from_secs(5))
        {
            last_sample = Instant::now();
            needs_sample = false;
            match sample(&app, &window, &generation, &mut model, true) {
                Ok(true) => {
                    let _ = persist(&app, &mut model, false);
                }
                Ok(false) => (),
                Err(reason) => {
                    if startup {
                        model.restore_failed = true;
                    }
                    model.error = Some(reason);
                    publish(&app, &model);
                }
            }
            if startup && model.verify_after.is_some() && !model.restore_failed {
                needs_sample = true;
                quiet_since = Instant::now();
            }
        }
        let ready_to_show = model.verify_after.is_none() && !needs_sample;
        if startup && !ready_to_show && startup_started.elapsed() >= Duration::from_secs(3) {
            block_restore(
                &mut model,
                "窗口位置恢复超时，上次保存的位置仍保留。".into(),
            );
        }
        if startup && (model.restore_failed || ready_to_show) {
            startup = false;
            if model.restore_failed {
                if let Err(reason) = fallback_position(&window, &generation) {
                    model.error = Some(format!(
                        "{}；无法校正窗口位置：{reason}",
                        model.error.as_deref().unwrap_or("上次位置未恢复")
                    ));
                }
            }
            if let Err(reason) = reveal(&window, std::mem::take(&mut startup_payload)) {
                model.error = Some(reason);
                publish(&app, &model);
            }
        }
        publish(&app, &model);
    }
}

pub fn open(app: &tauri::AppHandle, payload: Value) -> Result<(), String> {
    crate::task_state(app)?
        .console
        .send(Command::Reveal(payload))
}
pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    crate::task_state(app)?.console.send(Command::Hide)
}
// Called by asynchronous IPC commands, never the native event loop.
fn request(
    app: &tauri::AppHandle,
    command: impl FnOnce(mpsc::Sender<Result<(), String>>) -> Command,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    crate::task_state(app)?.console.send(command(tx))?;
    rx.recv().map_err(|_| "窗口位置操作未完成。".to_string())?
}
pub fn flush(app: &tauri::AppHandle) -> Result<(), String> {
    request(app, Command::Flush)
}
pub fn retry(app: &tauri::AppHandle) -> Result<(), String> {
    request(app, Command::Retry)
}
pub fn discard(app: &tauri::AppHandle) -> Result<(), String> {
    request(app, Command::Discard)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn placement(x: f64) -> ConsolePlacement {
        serde_json::from_value(serde_json::json!({"normal":{"innerWidth":900.0,"innerHeight":650.0,"monitorName":"test","monitorPosition":{"x":0,"y":0},"outerOffsetX":x,"outerOffsetY":20.0},"maximized":false})).unwrap()
    }
    #[test]
    fn failed_save_keeps_candidate_and_discard_ignores_only_that_position() {
        let mut model = Model {
            saved: Some(placement(10.)),
            ..Model::default()
        };
        model.observe(placement(20.));
        model.error = Some("disk full".into());
        assert!(model.status().pending);
        assert_eq!(model.candidate, Some(placement(20.)));
        model.discard();
        model.observe(placement(20.));
        assert!(!model.pending());
        assert_eq!(model.saved, Some(placement(10.)));
        model.observe(placement(30.));
        assert!(model.pending());
        model.committed(placement(30.));
        assert!(!model.pending());
        assert_eq!(model.error, None);
    }
    #[test]
    fn failed_native_restore_cannot_become_a_successful_new_preference() {
        let original = placement(10.);
        let mut model = Model {
            saved: Some(original.clone()),
            candidate: Some(original.clone()),
            ..Model::default()
        };
        block_restore(&mut model, "set_size failed after set_position".into());
        model.observe(placement(500.));
        assert_eq!(model.saved, Some(original.clone()));
        assert_eq!(model.candidate, Some(original));
        assert!(model.status().pending);
        assert!(model.status().error.is_some());
        // Choosing not to save clears the blocker, but the same current
        // candidate remains ignored until a later deliberate move.
        model.discard();
        assert!(!model.pending());
        model.observe(placement(600.));
        assert!(model.pending());
    }
    #[test]
    fn failed_maximize_preserves_normal_and_unconfirmed_preference() {
        let mut ordinary = placement(10.);
        ordinary.maximized = false;
        let mut target = ordinary.clone();
        target.maximized = true;
        let mut model = Model {
            saved: Some(target.clone()),
            candidate: Some(target.clone()),
            awaiting_maximize: true,
            ..Model::default()
        };
        block_restore(&mut model, "maximize failed".into());
        model.observe(ordinary);
        assert_eq!(model.saved, Some(target.clone()));
        assert_eq!(model.candidate, Some(target));
        assert!(model.status().error.is_some());
    }
    #[test]
    fn native_restore_confirmation_detects_partial_size_application() {
        let plan = RestorePlan {
            monitor_index: 0,
            outer: PhysicalRect {
                x: -1200,
                y: 30,
                width: 900,
                height: 680,
            },
            inner: PixelSize {
                width: 900,
                height: 650,
            },
            min_inner: PixelSize {
                width: 880,
                height: 620,
            },
            maximized: false,
        };
        let mut current = WindowFrame {
            outer: plan.outer,
            inner: plan.inner,
            top_inset: 30,
            window_scale: 1.,
        };
        assert!(matches_restored_frame(&current, &plan));
        current.outer.x += 1;
        current.inner.height -= 1;
        assert!(matches_restored_frame(&current, &plan));
        current.inner.width = 1180;
        assert!(!matches_restored_frame(&current, &plan));
    }
    #[test]
    fn failed_current_position_read_does_not_accept_or_discard_old_state() {
        let original = placement(10.);
        let mut model = Model {
            saved: Some(original.clone()),
            candidate: Some(placement(20.)),
            ..Model::default()
        };
        block_restore(&mut model, "native restore failed".into());
        let mut staged = accepting_current(&model);
        staged.observe(placement(30.));
        // A later monitor/read failure drops staged state instead of accepting it.
        drop(staged);
        assert!(model.restore_failed);
        assert_eq!(model.saved, Some(original));
        assert_eq!(model.candidate, Some(placement(20.)));
        assert_eq!(model.ignored, None);
    }
    #[test]
    fn invalid_console_is_an_independent_preference_error() {
        let runtime = ConsoleRuntime::new(Some(
            r#"{"monitorName":"valid-edge","offset":0.4,"console":{"bad":true}}"#,
        ));
        assert!(runtime.initial.lock().unwrap().as_ref().unwrap().is_err());
        assert!(ConsoleRuntime::new(Some(r#"{"offset":0.4}"#))
            .initial
            .lock()
            .unwrap()
            .is_none());
    }
}
