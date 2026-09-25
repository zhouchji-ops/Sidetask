//! Close WebView2 controllers in the final, authorized Windows exit callback.
//!
//! Tauri calls the product's RunEvent::Exit callback on the main thread before
//! cleanup_before_exit. Its normal run path eventually exits the process, so it
//! cannot rely on Wry's Rust Drop to close every still-live controller.

use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::Manager;

/// Called only from RunEvent::Exit, never from a cancellable ExitRequested event.
pub(crate) fn close_after_exit_authorized(app: &tauri::AppHandle) {
    if !crate::platform::exit::is_authorized(app) {
        let _ = writeln!(
            std::io::stderr(),
            "WIN-01 WebView2 shutdown: skipped without final exit authorization"
        );
        return;
    }

    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    windows.sort_by(|left, right| left.0.cmp(&right.0));
    for (label, window) in windows {
        let invoked = Arc::new(AtomicBool::new(false));
        let callback_invoked = invoked.clone();
        let callback_label = label.clone();
        // In the locked Tauri runtime, with_webview dispatches synchronously when
        // invoked from this main-thread exit callback. No queued task is left to
        // depend on another event-loop turn after shutdown has begun.
        let dispatched = window.with_webview(move |webview| {
            callback_invoked.store(true, Ordering::Relaxed);
            let started = Instant::now();
            // SAFETY: this is the owning UI/COM apartment. The live controller is
            // obtained through Tauri's public platform API after the user has
            // finished the draft handshake. Close is synchronous and does not
            // run beforeunload or close the parent HWND.
            let result = unsafe { webview.controller().Close() };
            let mut stderr = std::io::stderr();
            match result {
                Ok(()) => {
                    let _ = writeln!(
                        stderr,
                        "WIN-01 WebView2 shutdown: {callback_label} Close ok elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                }
                Err(error) => {
                    let _ = writeln!(
                        stderr,
                        "WIN-01 WebView2 shutdown: {callback_label} Close failed \
                         hresult=0x{:08x} error={error}",
                        error.code().0 as u32
                    );
                }
            }
        });
        if let Err(error) = dispatched {
            let _ = writeln!(
                std::io::stderr(),
                "WIN-01 WebView2 shutdown: {label} dispatch failed: {error}"
            );
        } else if !invoked.load(Ordering::Relaxed) {
            let _ = writeln!(
                std::io::stderr(),
                "WIN-01 WebView2 shutdown: {label} controller callback did not run"
            );
        }
    }
}
