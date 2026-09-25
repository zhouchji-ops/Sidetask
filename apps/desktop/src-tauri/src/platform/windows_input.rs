//! Win32 asynchronous mouse state uses physical buttons, while WebView pointer
//! events use the configured logical primary button.

fn primary_virtual_key(swapped: bool) -> i32 {
    if swapped {
        0x02 // VK_RBUTTON
    } else {
        0x01 // VK_LBUTTON
    }
}

#[cfg(target_os = "windows")]
pub fn primary_button_down() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
        fn GetSystemMetrics(index: i32) -> i32;
    }
    // SM_SWAPBUTTON is queried each time so a settings change takes effect
    // without restarting. The high bit alone represents the current state.
    unsafe { GetAsyncKeyState(primary_virtual_key(GetSystemMetrics(23) != 0)) < 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swapped_primary_button_keeps_drag_alive_until_the_actual_button_is_released() {
        let physical_state = |virtual_key| match virtual_key {
            0x01 => 0_i16,
            0x02 => i16::MIN,
            _ => unreachable!(),
        };
        assert!(physical_state(primary_virtual_key(true)) < 0);
        assert!(physical_state(primary_virtual_key(false)) >= 0);
    }
}
