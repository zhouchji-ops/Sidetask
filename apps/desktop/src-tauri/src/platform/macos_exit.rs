//! macOS routes Dock/AppleEvent termination directly to NSApplication, outside
//! Tauri's ExitRequested event. Add the optional delegate method only when the
//! framework has none; never replace or swizzle an existing implementation.
use objc2::{
    class, ffi, msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::OnceLock,
};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("macOS 退出保护必须在主线程安装。".into());
    }
    // SAFETY: NSApplication is loaded by Tauri/AppKit. Its sharedApplication and
    // delegate getters return live Objective-C object pointers on this thread.
    let delegate = unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if application.is_null() {
            return Err("找不到 macOS 应用对象，未启动。".into());
        }
        let delegate: *mut AnyObject = msg_send![application, delegate];
        delegate.as_ref().ok_or("找不到 macOS 应用代理，未启动。")?
    };
    let class = delegate.class();
    let selector = sel!(applicationShouldTerminate:);
    // Future framework versions may provide this method. Refuse the unknown
    // composition rather than overriding another owner's termination policy.
    if class.instance_method(selector).is_some() || class.responds_to(selector) {
        return Err("macOS 应用代理已有退出处理；为保护草稿，需兼容该处理后再启动。".into());
    }
    APP.set(app.clone())
        .map_err(|_| "macOS 退出保护重复安装。")?;
    // SAFETY: Objective-C IMP erases the method signature. This implementation
    // has exactly (id, SEL, id) -> NSUInteger, matching Q@:@ on both supported
    // 64-bit macOS targets. The callback prevents unwinding across this boundary.
    let implementation: Imp = unsafe {
        std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate)
    };
    let installed = unsafe {
        ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            implementation,
            c"Q@:@".as_ptr(),
        )
    };
    if !installed.as_bool() {
        return Err("无法安装 macOS 退出保护；未替换原有系统方法。".into());
    }
    Ok(())
}

unsafe extern "C-unwind" fn should_terminate(
    _: *mut AnyObject,
    _: Sel,
    _: *mut AnyObject,
) -> usize {
    // NSTerminateCancel = 0; NSTerminateNow = 1. Cancel this AppKit request
    // immediately and dispatch the existing async draft handshake. A confirmed
    // reply later exits through Tauri's own runtime on its normal event loop.
    catch_unwind(AssertUnwindSafe(|| {
        let Some(app) = APP.get() else {
            return 0;
        };
        if super::exit::is_authorized(app) {
            return 1;
        }
        let app = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("sidetask-exit".into())
            .spawn(move || {
                if let Err(error) = super::exit::request(&app) {
                    eprintln!("macOS exit request: {error}");
                }
            })
        {
            eprintln!("macOS exit request dispatch: {error}");
        }
        0
    }))
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn termination_reply_uses_the_supported_macos_integer_abi() {
        assert_eq!(std::mem::size_of::<usize>(), 8);
        // Before installation no app handle is available: never approve an
        // unhandled termination or unwind out of the callback.
        let reply = unsafe {
            super::should_terminate(
                std::ptr::null_mut(),
                objc2::sel!(applicationShouldTerminate:),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(reply, 0);
    }
}
