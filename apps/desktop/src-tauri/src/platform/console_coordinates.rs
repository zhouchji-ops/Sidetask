//! macOS console adapter for a single global AppKit logical coordinate plane.
//!
//! Locked Tao returns a window origin multiplied by the window's backing scale,
//! while each monitor/work-area origin uses that monitor's own backing scale.
//! Divide each by its source scale before intersecting them. Geometry's integer
//! fields then mean logical DIPs with scale 1; setters must use LogicalPosition /
//! LogicalSize. The raw physical monitor origin remains an identity hint only.
//!
//! Integer positions/client sizes round to the nearest DIP (at most 0.5 DIP).
//! Outer size is rounded client + rounded decoration, at most 1 DIP from the
//! direct conversion. Keeping these parts consistent avoids invalid negative
//! borders on odd backing-pixel sizes. Do not use this conversion on Windows.
use super::console_geometry::{GeometryMonitor, PixelSize, WindowFrame};
use super::geometry::PhysicalRect;

fn valid_scale(scale: f64) -> Result<(), String> {
    if scale.is_finite() && scale > 0. {
        Ok(())
    } else {
        Err("屏幕缩放暂不可用，尚未处理控制台位置。".into())
    }
}

fn position(value: i32, scale: f64) -> Result<i32, String> {
    let value = (f64::from(value) / scale).round();
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err("控制台逻辑坐标超出可表示范围。".into());
    }
    Ok(value as i32)
}

fn length(value: u32, scale: f64) -> Result<u32, String> {
    let value = (f64::from(value) / scale).round();
    if !value.is_finite() || value > f64::from(u32::MAX) {
        return Err("控制台逻辑尺寸超出可表示范围。".into());
    }
    Ok(value as u32)
}

pub fn frame_to_logical(frame: WindowFrame) -> Result<WindowFrame, String> {
    valid_scale(frame.window_scale)?;
    let width_border = frame
        .outer
        .width
        .checked_sub(frame.inner.width)
        .ok_or("控制台内外尺寸尚未稳定。")?;
    let height_border = frame
        .outer
        .height
        .checked_sub(frame.inner.height)
        .ok_or("控制台内外尺寸尚未稳定。")?;
    if frame.top_inset > frame.outer.height {
        return Err("控制台标题栏尺寸尚未稳定。".into());
    }
    let scale = frame.window_scale;
    let inner = PixelSize {
        width: length(frame.inner.width, scale)?,
        height: length(frame.inner.height, scale)?,
    };
    Ok(WindowFrame {
        outer: PhysicalRect {
            x: position(frame.outer.x, scale)?,
            y: position(frame.outer.y, scale)?,
            width: inner
                .width
                .checked_add(length(width_border, scale)?)
                .ok_or("控制台逻辑外框过宽。")?,
            height: inner
                .height
                .checked_add(length(height_border, scale)?)
                .ok_or("控制台逻辑外框过高。")?,
        },
        inner,
        window_scale: 1.,
        top_inset: length(frame.top_inset, scale)?,
    })
}

/// AppKit's contentLayoutRect is in window-local, bottom-up logical points.
/// FullSizeContentView can make outer == inner while this real title clearance
/// remains positive; it must not be inferred from the client-size difference.
pub fn title_inset_from_layout(
    outer_height: f64,
    layout_y: f64,
    layout_height: f64,
    scale: f64,
) -> Result<u32, String> {
    valid_scale(scale)?;
    let layout_top = layout_y + layout_height;
    let inset = (outer_height - layout_top) * scale;
    if !outer_height.is_finite()
        || !layout_y.is_finite()
        || !layout_height.is_finite()
        || outer_height <= 0.
        || layout_y < 0.
        || layout_height <= 0.
        || !inset.is_finite()
        || inset.round() < 1.
        || inset.round() > f64::from(u32::MAX)
    {
        return Err("控制台原生标题区域尚未就绪，未保存当前位置。".into());
    }
    Ok(inset.round() as u32)
}

pub fn monitor_to_logical(monitor: GeometryMonitor) -> Result<GeometryMonitor, String> {
    valid_scale(monitor.scale)?;
    let scale = monitor.scale;
    Ok(GeometryMonitor {
        work: PhysicalRect {
            x: position(monitor.work.x, scale)?,
            y: position(monitor.work.y, scale)?,
            width: length(monitor.work.width, scale)?,
            height: length(monitor.work.height, scale)?,
        },
        scale: 1.,
        ..monitor
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::console_geometry::{
        capture_normal, restore_plan, CloseSide, ConsolePlacement, Point,
    };

    #[test]
    fn full_size_content_uses_native_layout_clearance_without_shrinking_saved_client() {
        let raw = WindowFrame {
            outer: PhysicalRect {
                x: 290,
                y: 122,
                width: 2360,
                height: 1582,
            },
            inner: PixelSize {
                width: 2360,
                height: 1582,
            },
            window_scale: 2.,
            top_inset: title_inset_from_layout(791., 0., 763., 2.).unwrap(),
        };
        let normalized = frame_to_logical(raw).unwrap();
        assert_eq!(normalized.top_inset, 28);
        assert_eq!(normalized.outer.height, normalized.inner.height);
        assert_eq!(
            normalized.inner,
            PixelSize {
                width: 1180,
                height: 791
            }
        );
        let screens = [monitor(0, 33, 1470, 849, 1.)];
        let normal = capture_normal(&normalized, &screens).unwrap();
        assert_eq!(normal.inner_height, 791.);
        let saved = ConsolePlacement {
            normal,
            maximized: false,
        };
        let plan = restore_plan(&saved, &screens, &normalized, CloseSide::Left).unwrap();
        assert_eq!(plan.outer, normalized.outer);
        assert_eq!(plan.inner, normalized.inner);
    }

    #[test]
    fn native_title_layout_rejects_unsettled_values_without_guessing_a_height() {
        assert_eq!(title_inset_from_layout(700., 8., 662., 2.).unwrap(), 60);
        for (outer, y, height, scale) in [
            (700., 0., 700., 2.), // No measured title/control clearance yet.
            (700., 0., 701., 2.),
            (700., -1., 671., 2.),
            (700., 0., 0., 2.),
            (700., 0., 670., 0.),
            (f64::NAN, 0., 670., 2.),
            (700., f64::INFINITY, 670., 2.),
            (700., 0., f64::NAN, 2.),
        ] {
            assert!(title_inset_from_layout(outer, y, height, scale).is_err());
        }
    }

    fn monitor(x: i32, y: i32, width: u32, height: u32, scale: f64) -> GeometryMonitor {
        GeometryMonitor {
            name: Some(format!("display-{scale}")),
            position: Point { x, y },
            work: PhysicalRect {
                x,
                y,
                width,
                height,
            },
            scale,
            primary: scale == 1.,
        }
    }

    #[test]
    fn mixed_dpi_screens_and_retina_window_share_one_negative_coordinate_plane() {
        let retina = monitor(-3840, -1600, 3840, 2160, 2.);
        let standard = monitor(0, -800, 1920, 1080, 1.);
        let screens = [
            monitor_to_logical(retina).unwrap(),
            monitor_to_logical(standard).unwrap(),
        ];
        assert_eq!(screens[0].position, Point { x: -3840, y: -1600 });
        assert_eq!(screens[0].work.x, -1920);
        assert_eq!(
            screens[0].work.x + screens[0].work.width as i32,
            screens[1].work.x
        );
        assert_eq!(screens[0].work.y, screens[1].work.y);
        let actual = frame_to_logical(WindowFrame {
            outer: PhysicalRect {
                x: -840,
                y: -1400,
                width: 2032,
                height: 1476,
            },
            inner: PixelSize {
                width: 2000,
                height: 1400,
            },
            window_scale: 2.,
            top_inset: 60,
        })
        .unwrap();
        let normal = capture_normal(&actual, &screens).unwrap();
        assert_eq!(normal.inner_width, 1000.);
        assert_eq!(normal.outer_offset_x, -420.);
        assert_eq!(normal.outer_offset_y, 100.);
        for close_side in [CloseSide::Left, CloseSide::Right] {
            let plan = restore_plan(
                &ConsolePlacement {
                    normal: normal.clone(),
                    maximized: false,
                },
                &screens,
                &actual,
                close_side,
            )
            .unwrap();
            assert_eq!(plan.outer, actual.outer);
            assert_eq!(plan.inner, actual.inner);
        }
    }

    #[test]
    fn changing_backing_scale_keeps_logical_size_position_and_work_area_insets() {
        let source = WindowFrame {
            outer: PhysicalRect {
                x: -101,
                y: -51,
                width: 1017,
                height: 739,
            },
            inner: PixelSize {
                width: 1001,
                height: 701,
            },
            window_scale: 1.,
            top_inset: 30,
        };
        let retina = WindowFrame {
            outer: PhysicalRect {
                x: -202,
                y: -102,
                width: 2034,
                height: 1478,
            },
            inner: PixelSize {
                width: 2002,
                height: 1402,
            },
            window_scale: 2.,
            top_inset: 60,
        };
        let first = frame_to_logical(source).unwrap();
        let second = frame_to_logical(retina).unwrap();
        assert_eq!(first.outer, second.outer);
        assert_eq!(first.inner, second.inner);
        assert_eq!(first.top_inset, second.top_inset);
        let mut screen = monitor(-3840, -1600, 3840, 2160, 2.);
        screen.work.y += 48;
        screen.work.height -= 48;
        let normalized = monitor_to_logical(screen).unwrap();
        assert_eq!(normalized.position.y, -1600);
        assert_eq!(normalized.work.y, -776);
        assert_eq!(normalized.work.height, 1056);
    }

    #[test]
    fn odd_backing_pixels_keep_client_and_chrome_consistent_with_bounded_rounding() {
        let raw = WindowFrame {
            outer: PhysicalRect {
                x: -203,
                y: 101,
                width: 104,
                height: 104,
            },
            inner: PixelSize {
                width: 101,
                height: 101,
            },
            window_scale: 2.,
            top_inset: 3,
        };
        let normalized = frame_to_logical(raw).unwrap();
        assert_eq!(
            normalized.inner,
            PixelSize {
                width: 51,
                height: 51
            }
        );
        assert_eq!(normalized.top_inset, 2);
        assert_eq!(normalized.outer.height - normalized.inner.height, 2);
        assert!((f64::from(normalized.outer.x) - f64::from(raw.outer.x) / 2.).abs() <= 0.5);
        assert!(
            (f64::from(normalized.outer.height) - f64::from(raw.outer.height) / 2.).abs() <= 1.
        );
        let screens = [monitor(0, 0, 1920, 1080, 1.)];
        assert!(capture_normal(&normalized, &screens).is_ok());
    }

    #[test]
    fn invalid_scale_transient_frame_and_conversion_overflow_are_not_coerced() {
        for scale in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(monitor_to_logical(monitor(0, 0, 1920, 1080, scale)).is_err());
        }
        let frame = WindowFrame {
            outer: PhysicalRect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            inner: PixelSize {
                width: 101,
                height: 90,
            },
            window_scale: 2.,
            top_inset: 10,
        };
        assert!(frame_to_logical(frame).is_err());
        assert!(monitor_to_logical(monitor(i32::MAX, 0, 100, 100, 0.001)).is_err());
    }
}
