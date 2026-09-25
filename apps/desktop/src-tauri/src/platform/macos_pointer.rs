//! Observe mouse-down delivery without intercepting another application's input.
//! AppKit's global monitor excludes this app, so a local monitor is also needed.
//! Only mouse buttons are registered; no event tap or keyboard/AX permission.
use block2::RcBlock;
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
use std::{
    cell::RefCell,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::mpsc::Sender,
    time::Instant,
};
use tauri::Manager;

use super::OutsideClick;

// NSEventMask is UInt64; NSEventType left/right/other mouse-down = 1/3/25.
const MOUSE_DOWN: u64 = (1 << 1) | (1 << 3) | (1 << 25);
thread_local! {
    static MONITORS: RefCell<Option<Monitors>> = const { RefCell::new(None) };
}
struct Monitors {
    global: Retained<AnyObject>,
    local: Retained<AnyObject>,
}
impl Drop for Monitors {
    fn drop(&mut self) {
        // SAFETY: installation, storage and removal all belong to the main
        // thread. These are the exact live tokens returned by NSEvent.
        unsafe {
            let _: () = msg_send![class!(NSEvent), removeMonitor: &*self.global];
            let _: () = msg_send![class!(NSEvent), removeMonitor: &*self.local];
        }
    }
}

pub fn install(app: &tauri::AppHandle, sender: Sender<OutsideClick>) -> Result<(), String> {
    let _main = MainThreadMarker::new().ok_or("鼠标点击监听必须在主线程安装。")?;
    if MONITORS.with(|slot| slot.borrow().is_some()) {
        return Err("鼠标点击监听已安装。".into());
    }
    let native_window = |label| {
        app.get_webview_window(label)
            .ok_or_else(|| format!("找不到 {label} 窗口。"))?
            .ns_window()
            .map(|window| window as usize)
            .map_err(|reason| reason.to_string())
    };
    let panel = native_window("edge-panel")?;
    let handle = native_window("edge-handle")?;
    let global_sender = sender.clone();
    let global = RcBlock::new(move |_event: *mut AnyObject| {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // The event was delivered to another app, even if its window happens
            // to overlap our panel. Observe the target, not the later cursor.
            let _ = global_sender.send(OutsideClick {
                observed_at: Instant::now(),
            });
        }));
    });
    let local = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: NSEvent calls this block on the main thread with a live
            // event. NSWindow parents are live AppKit objects on that thread.
            let inside = unsafe {
                let mut target: *mut AnyObject = msg_send![event, window];
                let mut inside = false;
                while !target.is_null() {
                    if target as usize == panel || target as usize == handle {
                        inside = true;
                        break;
                    }
                    target = msg_send![target, parentWindow];
                }
                inside
            };
            if !inside {
                let _ = sender.send(OutsideClick {
                    observed_at: Instant::now(),
                });
            }
        }));
        // Never consume, replace or delay delivery of the user's click.
        event
    });
    // SAFETY: signatures match AppKit's public NSEvent APIs. AppKit copies both
    // blocks; retained monitor tokens keep the registrations alive until stop.
    unsafe {
        let global_token: *mut AnyObject = msg_send![class!(NSEvent), addGlobalMonitorForEventsMatchingMask: MOUSE_DOWN, handler: &*global];
        let global_token = Retained::retain(global_token).ok_or("无法安装外部鼠标点击监听。")?;
        let local_token: *mut AnyObject = msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: MOUSE_DOWN, handler: &*local];
        let Some(local_token) = Retained::retain(local_token) else {
            let _: () = msg_send![class!(NSEvent), removeMonitor: &*global_token];
            return Err("无法安装应用内鼠标点击监听。".into());
        };
        MONITORS.with(|slot| {
            *slot.borrow_mut() = Some(Monitors {
                global: global_token,
                local: local_token,
            });
        });
    }
    Ok(())
}

pub fn stop() {
    debug_assert!(MainThreadMarker::new().is_some());
    MONITORS.with(|slot| {
        slot.borrow_mut().take();
    });
}
