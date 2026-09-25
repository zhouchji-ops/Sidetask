//! Observe button-down events on a dedicated message thread; never consume input.
//! Event coordinates/targets are captured before delivery, not sampled by tick.
use std::{
    cell::RefCell,
    mem::size_of,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::null_mut,
    sync::mpsc::{self, Sender},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW, SystemInformation::GetTickCount,
        Threading::GetCurrentThreadId,
    },
    UI::{
        HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
        WindowsAndMessaging::*,
    },
};

use super::OutsideClick;

struct Target {
    panel: usize,
    handle: usize,
    sender: Sender<OutsideClick>,
}
struct Observer {
    thread_id: u32,
    thread: JoinHandle<()>,
}
thread_local! {
    // OBSERVER belongs to Tauri's main thread; TARGET only to the hook thread.
    static OBSERVER: RefCell<Option<Observer>> = const { RefCell::new(None) };
    static TARGET: RefCell<Option<Target>> = const { RefCell::new(None) };
}

fn button_down(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
    )
}

fn event_instant(now: Instant, current_tick: u32, event_tick: u32) -> Option<Instant> {
    // Win32 event time wraps every 49.7 days. Keep the original event age so a
    // delayed hook callback cannot hide a newer reveal/mode/gesture boundary.
    now.checked_sub(Duration::from_millis(
        current_tick.wrapping_sub(event_tick) as u64
    ))
}

fn belongs_to_edge(mut window: HWND, target: &Target) -> bool {
    // Children include WebView2's HWNDs; owned popups include native menus.
    // Bound the walk against stale/reused HWNDs while another app closes UI.
    for _ in 0..32 {
        if window.is_null() {
            return false;
        }
        if window as usize == target.panel || window as usize == target.handle {
            return true;
        }
        // SAFETY: these read-only Win32 queries accept foreign HWNDs and return
        // null for invalid handles. No window procedure or app lock is called.
        let root = unsafe { GetAncestor(window, GA_ROOT) };
        if root != window && !root.is_null() {
            window = root;
        } else {
            window = unsafe { GetWindow(window, GW_OWNER) };
        }
    }
    false
}

fn inside_edge(event: &MSLLHOOKSTRUCT, target: &Target) -> bool {
    let mut gui = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    // Native capture/menu routing takes precedence over geometric hit testing.
    // A click dismissing an edge-owned menu must reach that menu first.
    if unsafe { GetGUIThreadInfo(0, &mut gui) } != 0 {
        if !gui.hwndCapture.is_null() {
            return belongs_to_edge(gui.hwndCapture, target);
        }
        if gui.flags & GUI_INMENUMODE != 0 && belongs_to_edge(gui.hwndMenuOwner, target) {
            return true;
        }
    }
    // MSLLHOOKSTRUCT uses per-monitor-aware physical desktop coordinates,
    // including negative origins. Do not divide by a primary-monitor scale.
    belongs_to_edge(unsafe { WindowFromPhysicalPoint(event.pt) }, target)
}

unsafe extern "system" fn observe(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && button_down(message as u32) && data != 0 {
        // Never let Rust unwind across the OS callback. No Tauri calls, database
        // work, application mutexes, or window mutation occur on this thread.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let event = unsafe { &*(data as *const MSLLHOOKSTRUCT) };
            let now = Instant::now();
            let observed_at = event_instant(now, unsafe { GetTickCount() }, event.time);
            TARGET.with(|slot| {
                if let (Some(target), Some(observed_at)) = (slot.borrow().as_ref(), observed_at) {
                    if !inside_edge(event, target) {
                        let _ = target.sender.send(OutsideClick { observed_at });
                    }
                }
            });
        }));
    }
    // Includes negative hook codes, every button and injected accessibility
    // input. The click always continues to the original recipient/hook chain.
    unsafe { CallNextHookEx(null_mut(), code, message, data) }
}

pub fn install(app: &tauri::AppHandle, sender: Sender<OutsideClick>) -> Result<(), String> {
    if OBSERVER.with(|slot| slot.borrow().is_some()) {
        return Err("鼠标点击监听已安装。".into());
    }
    let hwnd = |label| {
        app.get_webview_window(label)
            .ok_or_else(|| format!("找不到 {label} 窗口。"))?
            .hwnd()
            .map(|window| window.0 as usize)
            .map_err(|error| error.to_string())
    };
    let target = Target {
        panel: hwnd("edge-panel")?,
        handle: hwnd("edge-handle")?,
        sender,
    };
    let (ready, installed) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("sidetask-pointer".into())
        .spawn(move || {
            // This thread never creates windows. Its own DPI context makes the
            // event/target coordinate contract explicit without changing Tauri.
            if unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
                .is_null()
            {
                let _ = ready.send(Err(format!(
                    "鼠标监听 DPI 初始化失败：{}",
                    std::io::Error::last_os_error()
                )));
                return;
            }
            TARGET.with(|slot| *slot.borrow_mut() = Some(target));
            let mut message = MSG::default();
            // Create the queue before publishing the ID used by stop().
            unsafe {
                PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
            }
            let hook = unsafe {
                SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(observe),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                )
            };
            if hook.is_null() {
                let _ = ready.send(Err(format!(
                    "无法安装鼠标点击监听：{}",
                    std::io::Error::last_os_error()
                )));
            } else {
                if ready.send(Ok(unsafe { GetCurrentThreadId() })).is_ok() {
                    loop {
                        let result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
                        if result <= 0 {
                            if result < 0 {
                                eprintln!(
                                    "pointer message loop: {}",
                                    std::io::Error::last_os_error()
                                );
                            }
                            break;
                        }
                        unsafe {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
            }
            TARGET.with(|slot| {
                slot.borrow_mut().take();
            });
        })
        .map_err(|error| error.to_string())?;
    match installed
        .recv()
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    {
        Ok(thread_id) => {
            OBSERVER.with(|slot| *slot.borrow_mut() = Some(Observer { thread_id, thread }));
            Ok(())
        }
        Err(error) => {
            let _ = thread.join();
            Err(error)
        }
    }
}

pub fn stop() {
    if let Some(observer) = OBSERVER.with(|slot| slot.borrow_mut().take()) {
        // Do not join a live message loop when posting failed. Dropping the
        // handle detaches it; process exit still removes the OS registration.
        if unsafe { PostThreadMessageW(observer.thread_id, WM_QUIT, 0, 0) } != 0 {
            let _ = observer.thread.join();
        } else {
            eprintln!("stop pointer observer: {}", std::io::Error::last_os_error());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_button_down_is_observed_independent_of_primary_button_mapping() {
        for message in [
            WM_LBUTTONDOWN,
            WM_RBUTTONDOWN,
            WM_MBUTTONDOWN,
            WM_XBUTTONDOWN,
        ] {
            assert!(button_down(message));
        }
        for message in [
            WM_MOUSEMOVE,
            WM_MOUSEWHEEL,
            WM_LBUTTONUP,
            WM_RBUTTONUP,
            WM_MBUTTONUP,
            WM_XBUTTONUP,
        ] {
            assert!(!button_down(message));
        }
    }

    #[test]
    fn delayed_clicks_and_uptime_wrap_keep_their_original_age() {
        let now = Instant::now();
        assert_eq!(
            event_instant(now, 1020, 1000),
            now.checked_sub(Duration::from_millis(20))
        );
        assert_eq!(
            event_instant(now, 10, u32::MAX - 9),
            now.checked_sub(Duration::from_millis(20))
        );
        let boundary = now - Duration::from_millis(10);
        assert!(event_instant(now, 1020, 1000).unwrap() < boundary);
    }
}
