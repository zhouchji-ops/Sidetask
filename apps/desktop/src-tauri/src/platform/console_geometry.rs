//! Pure geometry in one desktop coordinate plane; no window, focus, or storage calls.
//! Windows supplies physical pixels. The macOS console adapter supplies global
//! logical DIPs (integer rounded, scale 1) because native per-screen backing
//! pixels are not a common desktop plane. Never mix those input conventions.
use super::geometry::PhysicalRect;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsoleNormal {
    pub inner_width: f64,
    pub inner_height: f64,
    pub monitor_name: Option<String>,
    pub monitor_position: Option<Point>,
    pub outer_offset_x: f64,
    pub outer_offset_y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsolePlacement {
    pub normal: ConsoleNormal,
    pub maximized: bool,
}

#[derive(Clone, Debug)]
pub struct GeometryMonitor {
    pub name: Option<String>,
    /// Original native physical origin, used only as a saved identity hint.
    pub position: Point,
    pub work: PhysicalRect,
    pub scale: f64,
    pub primary: bool,
}

/// A stable *normal* window measurement, never a minimized/maximized/fullscreen frame.
#[derive(Clone, Copy, Debug)]
pub struct WindowFrame {
    pub outer: PhysicalRect,
    pub inner: PixelSize,
    pub window_scale: f64,
    /// Distance from outer top to client top, in the input coordinate plane.
    pub top_inset: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseSide {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RestorePlan {
    pub monitor_index: usize,
    pub outer: PhysicalRect,
    /// Client size: never pass `outer` to the size setter. The adapter chooses
    /// PhysicalSize on Windows and LogicalSize on normalized macOS geometry.
    pub inner: PixelSize,
    pub min_inner: PixelSize,
    /// Apply only after restoring and verifying the normal rectangle.
    pub maximized: bool,
}

pub fn validate(placement: &ConsolePlacement) -> Result<(), String> {
    let normal = &placement.normal;
    if !normal.inner_width.is_finite()
        || !normal.inner_height.is_finite()
        || normal.inner_width <= 0.
        || normal.inner_height <= 0.
        || !normal.outer_offset_x.is_finite()
        || !normal.outer_offset_y.is_finite()
    {
        return Err("控制台保存的尺寸或位置无效。".into());
    }
    Ok(())
}

fn valid_monitor(monitor: &GeometryMonitor) -> bool {
    monitor.scale.is_finite()
        && monitor.scale > 0.
        && monitor.work.width > 0
        && monitor.work.height > 0
}

fn saved_monitor(normal: &ConsoleNormal, monitors: &[GeometryMonitor]) -> Option<usize> {
    if let Some(name) = normal.monitor_name.as_deref() {
        let mut matches = monitors
            .iter()
            .enumerate()
            .filter(|(_, monitor)| valid_monitor(monitor) && monitor.name.as_deref() == Some(name));
        let first = matches.next()?;
        if normal.monitor_position == Some(first.1.position) {
            return Some(first.0);
        }
        return Some(
            matches
                .find(|(_, monitor)| normal.monitor_position == Some(monitor.position))
                .unwrap_or(first)
                .0,
        );
    }
    let position = normal.monitor_position?;
    monitors
        .iter()
        .position(|monitor| valid_monitor(monitor) && monitor.position == position)
}

pub fn select_monitor(
    normal: &ConsoleNormal,
    monitors: &[GeometryMonitor],
) -> Result<usize, String> {
    saved_monitor(normal, monitors)
        .or_else(|| {
            monitors
                .iter()
                .position(|monitor| valid_monitor(monitor) && monitor.primary)
        })
        .or_else(|| monitors.iter().position(valid_monitor))
        .ok_or_else(|| "没有可用屏幕，尚未恢复控制台位置。".into())
}

fn validate_frame(frame: &WindowFrame) -> Result<(), String> {
    if !frame.window_scale.is_finite()
        || frame.window_scale <= 0.
        || frame.inner.width == 0
        || frame.inner.height == 0
        || frame.outer.width < frame.inner.width
        || frame.outer.height < frame.inner.height
        || frame.top_inset == 0
        || frame.top_inset > frame.outer.height - frame.inner.height
    {
        return Err("控制台普通窗口的边框或缩放测量尚未就绪。".into());
    }
    Ok(())
}

fn intersection(first: PhysicalRect, second: PhysicalRect) -> (u32, u32) {
    let width = (i64::from(first.x) + i64::from(first.width))
        .min(i64::from(second.x) + i64::from(second.width))
        - i64::from(first.x).max(i64::from(second.x));
    let height = (i64::from(first.y) + i64::from(first.height))
        .min(i64::from(second.y) + i64::from(second.height))
        - i64::from(first.y).max(i64::from(second.y));
    (width.max(0) as u32, height.max(0) as u32)
}

pub fn capture_normal(
    frame: &WindowFrame,
    monitors: &[GeometryMonitor],
) -> Result<ConsoleNormal, String> {
    validate_frame(frame)?;
    let mut chosen = None;
    let mut best_area = 0;
    for (index, monitor) in monitors
        .iter()
        .enumerate()
        .filter(|(_, monitor)| valid_monitor(monitor))
    {
        let (width, height) = intersection(frame.outer, monitor.work);
        let area = u64::from(width) * u64::from(height);
        if area > best_area {
            chosen = Some(index);
            best_area = area;
        }
    }
    let index = chosen
        .or_else(|| {
            monitors
                .iter()
                .position(|monitor| valid_monitor(monitor) && monitor.primary)
        })
        .or_else(|| monitors.iter().position(valid_monitor))
        .ok_or("没有可用屏幕，尚未保存控制台位置。")?;
    let monitor = &monitors[index];
    let normal = ConsoleNormal {
        inner_width: f64::from(frame.inner.width) / frame.window_scale,
        inner_height: f64::from(frame.inner.height) / frame.window_scale,
        monitor_name: monitor.name.clone(),
        monitor_position: Some(monitor.position),
        outer_offset_x: (f64::from(frame.outer.x) - f64::from(monitor.work.x)) / monitor.scale,
        outer_offset_y: (f64::from(frame.outer.y) - f64::from(monitor.work.y)) / monitor.scale,
    };
    validate(&ConsolePlacement {
        normal: normal.clone(),
        maximized: false,
    })?;
    Ok(normal)
}

fn pixels(value: f64) -> Result<u32, String> {
    let rounded = value.round();
    if !rounded.is_finite() || rounded < 0. || rounded > f64::from(u32::MAX) {
        return Err("控制台尺寸超出可表示范围。".into());
    }
    Ok(rounded as u32)
}

fn coordinate(value: f64) -> Option<i32> {
    let rounded = value.round();
    (rounded.is_finite() && rounded >= f64::from(i32::MIN) && rounded <= f64::from(i32::MAX))
        .then_some(rounded as i32)
}

fn inside(rect: PhysicalRect, work: PhysicalRect) -> bool {
    i64::from(rect.x) >= i64::from(work.x)
        && i64::from(rect.y) >= i64::from(work.y)
        && i64::from(rect.x) + i64::from(rect.width) <= i64::from(work.x) + i64::from(work.width)
        && i64::from(rect.y) + i64::from(rect.height) <= i64::from(work.y) + i64::from(work.height)
}

fn reachable(
    outer: PhysicalRect,
    inner: PixelSize,
    top_inset: u32,
    scale: f64,
    close_side: CloseSide,
    monitors: &[GeometryMonitor],
) -> bool {
    // Keep a conservative strip for the native close controls plus a drag area
    // in one work area, rather than accepting a single visible window corner.
    let title_width = (200. * scale).ceil().min(f64::from(outer.width)) as u32;
    let title_x = match close_side {
        CloseSide::Left => Some(outer.x),
        CloseSide::Right => {
            i32::try_from(i64::from(outer.x) + i64::from(outer.width - title_width)).ok()
        }
    };
    let Some(title_x) = title_x else { return false };
    let title = PhysicalRect {
        x: title_x,
        y: outer.y,
        width: title_width,
        height: top_inset,
    };
    let border_width = outer.width - inner.width;
    let border_height = outer.height - inner.height;
    // Horizontal native borders are measured as a total; conservatively inset
    // both sides by that total when evaluating the usable content viewport.
    let Some(client_x) = i32::try_from(i64::from(outer.x) + i64::from(border_width)).ok() else {
        return false;
    };
    let Some(client_y) = i32::try_from(i64::from(outer.y) + i64::from(top_inset)).ok() else {
        return false;
    };
    let client = PhysicalRect {
        x: client_x,
        y: client_y,
        width: inner.width.saturating_sub(border_width).max(1),
        height: inner.height,
    };
    monitors
        .iter()
        .filter(|monitor| valid_monitor(monitor))
        .any(|monitor| {
            let available_width = monitor
                .work
                .width
                .saturating_sub(border_width.saturating_mul(2))
                .max(1);
            let available_height = monitor.work.height.saturating_sub(border_height).max(1);
            let needed_width = (320. * scale)
                .ceil()
                .min(f64::from(client.width.min(available_width)))
                as u32;
            let needed_height = (180. * scale)
                .ceil()
                .min(f64::from(inner.height.min(available_height)))
                as u32;
            let (width, height) = intersection(client, monitor.work);
            inside(title, monitor.work) && width >= needed_width && height >= needed_height
        })
}

pub fn restore_plan(
    placement: &ConsolePlacement,
    monitors: &[GeometryMonitor],
    frame: &WindowFrame,
    close_side: CloseSide,
) -> Result<RestorePlan, String> {
    validate(placement)?;
    validate_frame(frame)?;
    let monitor_index = select_monitor(&placement.normal, monitors)?;
    let monitor = &monitors[monitor_index];
    let scale = monitor.scale;
    let border_width =
        pixels(f64::from(frame.outer.width - frame.inner.width) / frame.window_scale * scale)?;
    let border_height =
        pixels(f64::from(frame.outer.height - frame.inner.height) / frame.window_scale * scale)?;
    let top_inset = pixels(f64::from(frame.top_inset) / frame.window_scale * scale)?.max(1);
    let available = PixelSize {
        width: monitor.work.width.saturating_sub(border_width),
        height: monitor.work.height.saturating_sub(border_height),
    };
    if available.width == 0 || available.height == 0 || top_inset > border_height {
        return Err("屏幕工作区不足以显示控制台标题栏和内容。".into());
    }
    let min_inner = PixelSize {
        width: pixels(880. * scale)?.max(1).min(available.width),
        height: pixels(620. * scale)?.max(1).min(available.height),
    };
    let mut inner = PixelSize {
        width: pixels(placement.normal.inner_width * scale)?.max(min_inner.width),
        height: pixels(placement.normal.inner_height * scale)?.max(min_inner.height),
    };
    let outer_size = |inner: PixelSize| -> Result<PixelSize, String> {
        Ok(PixelSize {
            width: inner
                .width
                .checked_add(border_width)
                .ok_or("控制台外框过宽。")?,
            height: inner
                .height
                .checked_add(border_height)
                .ok_or("控制台外框过高。")?,
        })
    };
    let preferred_x =
        coordinate(f64::from(monitor.work.x) + placement.normal.outer_offset_x * scale);
    let preferred_y =
        coordinate(f64::from(monitor.work.y) + placement.normal.outer_offset_y * scale);
    let size = outer_size(inner)?;
    let desired = preferred_x.zip(preferred_y).map(|(x, y)| PhysicalRect {
        x,
        y,
        width: size.width,
        height: size.height,
    });
    if saved_monitor(&placement.normal, monitors).is_some() {
        if let Some(outer) =
            desired.filter(|outer| reachable(*outer, inner, top_inset, scale, close_side, monitors))
        {
            return Ok(RestorePlan {
                monitor_index,
                outer,
                inner,
                min_inner,
                maximized: placement.maximized,
            });
        }
    }

    // A missing monitor or unreachable titlebar is repaired within one work
    // area. This clamp is not used for already usable cross-screen positions.
    inner.width = inner.width.min(available.width);
    inner.height = inner.height.min(available.height);
    let size = outer_size(inner)?;
    let clamp_position = |preferred: Option<i32>, start: i32, room: u32| -> Result<i32, String> {
        let first = i64::from(start);
        let last = first + i64::from(room);
        i32::try_from(
            preferred
                .map(i64::from)
                .unwrap_or(first + i64::from(room) / 2)
                .clamp(first, last),
        )
        .map_err(|_| "屏幕工作区位置超出可表示范围。".into())
    };
    let outer = PhysicalRect {
        x: clamp_position(preferred_x, monitor.work.x, monitor.work.width - size.width)?,
        y: clamp_position(
            preferred_y,
            monitor.work.y,
            monitor.work.height - size.height,
        )?,
        width: size.width,
        height: size.height,
    };
    if !reachable(outer, inner, top_inset, scale, close_side, monitors) {
        return Err("控制台标题栏或内容无法安全恢复到当前工作区。".into());
    }
    Ok(RestorePlan {
        monitor_index,
        outer,
        inner,
        min_inner,
        maximized: placement.maximized,
    })
}

/// Position-only fallback after a native restore step fails. Keep the actual
/// close-control end and a titlebar drag strip reachable without assuming the
/// requested resize succeeded. The opposite side may remain off-screen.
pub fn emergency_position(
    frame: &WindowFrame,
    monitors: &[GeometryMonitor],
    close_side: CloseSide,
) -> Result<Point, String> {
    validate_frame(frame)?;
    let title_width = (200. * frame.window_scale)
        .ceil()
        .min(f64::from(frame.outer.width)) as u32;
    let mut selected: Option<usize> = None;
    let mut best_area = 0;
    for (index, monitor) in monitors.iter().enumerate().filter(|(_, monitor)| {
        valid_monitor(monitor)
            && monitor.work.width >= title_width
            && monitor.work.height >= frame.top_inset
    }) {
        let (width, height) = intersection(frame.outer, monitor.work);
        let area = u64::from(width) * u64::from(height);
        if selected.is_none()
            || area > best_area
            || (area == best_area
                && monitor.primary
                && selected.is_some_and(|previous| !monitors[previous].primary))
        {
            selected = Some(index);
            best_area = area;
        }
    }
    let monitor = selected
        .map(|index| &monitors[index])
        .ok_or("当前没有可容纳控制台关闭按钮和标题栏的工作区。")?;
    let x = match close_side {
        CloseSide::Left => i64::from(monitor.work.x),
        CloseSide::Right => {
            i64::from(monitor.work.x) + i64::from(monitor.work.width) - i64::from(frame.outer.width)
        }
    };
    Ok(Point {
        x: i32::try_from(x).map_err(|_| "应急窗口位置超出可表示范围。")?,
        y: monitor.work.y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(
        name: &str,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale: f64,
        primary: bool,
    ) -> GeometryMonitor {
        GeometryMonitor {
            name: Some(name.into()),
            position: Point { x, y },
            work: PhysicalRect {
                x,
                y,
                width,
                height,
            },
            scale,
            primary,
        }
    }
    fn frame(x: i32, y: i32, width: u32, height: u32, scale: f64) -> WindowFrame {
        let side = (8. * scale) as u32;
        let top = (30. * scale) as u32;
        WindowFrame {
            outer: PhysicalRect {
                x,
                y,
                width: width + 2 * side,
                height: height + top + side,
            },
            inner: PixelSize { width, height },
            window_scale: scale,
            top_inset: top,
        }
    }
    fn saved(normal: ConsoleNormal) -> ConsolePlacement {
        ConsolePlacement {
            normal,
            maximized: false,
        }
    }

    #[test]
    fn serde_contract_and_invalid_values_are_explicit() {
        let screens = [monitor("display", 0, 0, 1920, 1080, 1., true)];
        let original = saved(capture_normal(&frame(100, 100, 1000, 700, 1.), &screens).unwrap());
        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(
            json["normal"]["monitorPosition"],
            serde_json::json!({"x":0,"y":0})
        );
        assert_eq!(json["normal"]["innerWidth"], serde_json::json!(1000.));
        assert_eq!(
            serde_json::from_value::<ConsolePlacement>(json).unwrap(),
            original
        );
        for invalid in [f64::NAN, f64::INFINITY, 0., -1.] {
            let mut bad = original.clone();
            bad.normal.inner_width = invalid;
            assert!(validate(&bad).is_err());
        }
        let mut bad = original;
        bad.normal.outer_offset_y = f64::NEG_INFINITY;
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn duplicate_names_match_original_position_and_missing_monitor_uses_primary() {
        let screens = [
            monitor("same", -1920, 0, 1920, 1080, 1., false),
            monitor("same", 0, 0, 1920, 1080, 1., true),
        ];
        let mut normal = capture_normal(&frame(-1800, 90, 1000, 700, 1.), &screens).unwrap();
        assert_eq!(select_monitor(&normal, &screens).unwrap(), 0);
        normal.monitor_position = Some(Point { x: 0, y: 0 });
        assert_eq!(select_monitor(&normal, &screens).unwrap(), 1);
        normal.monitor_name = Some("disconnected".into());
        assert_eq!(select_monitor(&normal, &screens).unwrap(), 1);
        let mut invalid = screens[0].clone();
        invalid.scale = f64::NAN;
        invalid.primary = true;
        assert_eq!(
            select_monitor(&normal, &[invalid, screens[1].clone()]).unwrap(),
            1
        );
        assert!(select_monitor(&normal, &[]).is_err());
    }

    #[test]
    fn capture_uses_logical_client_size_and_work_area_relative_outer_position() {
        let mut screen = monitor("retina", -3000, -900, 2800, 1800, 2., true);
        screen.work.y += 48;
        screen.work.height -= 48;
        let actual = frame(-2800, -732, 2000, 1400, 2.);
        let normal = capture_normal(&actual, &[screen]).unwrap();
        assert_eq!((normal.inner_width, normal.inner_height), (1000., 700.));
        assert_eq!((normal.outer_offset_x, normal.outer_offset_y), (100., 60.));
        assert_eq!(normal.monitor_position, Some(Point { x: -3000, y: -900 }));
    }

    #[test]
    fn mixed_dpi_restores_client_and_decoration_once_without_restart_growth() {
        let old = [monitor("display", 0, 0, 1920, 1080, 1., true)];
        let source = frame(120, 100, 1000, 700, 1.);
        let mut placement = saved(capture_normal(&source, &old).unwrap());
        placement.maximized = true;
        let new = [monitor("display", -3200, -200, 3200, 2160, 2., true)];
        let plan = restore_plan(&placement, &new, &source, CloseSide::Right).unwrap();
        assert_eq!(
            plan.inner,
            PixelSize {
                width: 2000,
                height: 1400
            }
        );
        assert_eq!((plan.outer.width, plan.outer.height), (2032, 1476));
        assert_eq!((plan.outer.x, plan.outer.y), (-2960, 0));
        assert!(plan.maximized);
        let restored = WindowFrame {
            outer: plan.outer,
            inner: plan.inner,
            window_scale: 2.,
            top_inset: 60,
        };
        let saved_again = saved(capture_normal(&restored, &new).unwrap());
        let next = restore_plan(&saved_again, &new, &restored, CloseSide::Right).unwrap();
        assert_eq!(next.outer, plan.outer);
        assert_eq!(next.inner, plan.inner);
    }

    #[test]
    fn reachable_cross_screen_position_keeps_negative_offset_for_each_close_side() {
        let screens = [
            monitor("left", -1920, 0, 1920, 1080, 1., false),
            monitor("right", 0, 0, 1920, 1080, 1., true),
        ];
        let original = frame(-420, 100, 1000, 700, 1.);
        let placement = saved(capture_normal(&original, &screens).unwrap());
        assert_eq!(placement.normal.monitor_name.as_deref(), Some("right"));
        assert_eq!(placement.normal.outer_offset_x, -420.);
        for side in [CloseSide::Left, CloseSide::Right] {
            let plan = restore_plan(&placement, &screens, &original, side).unwrap();
            assert_eq!(plan.outer, original.outer);
            assert_eq!(plan.inner, original.inner);
        }
    }

    #[test]
    fn visible_corner_without_titlebar_or_close_controls_is_repaired() {
        let screens = [monitor("display", -1920, -200, 1920, 1080, 1., true)];
        for (x, y, side) in [
            (-1800, -225, CloseSide::Left),
            (-1930, 50, CloseSide::Left),
            (-150, 50, CloseSide::Right),
        ] {
            let original = frame(x, y, 1000, 700, 1.);
            let placement = saved(capture_normal(&original, &screens).unwrap());
            let plan = restore_plan(&placement, &screens, &original, side).unwrap();
            assert!(inside(plan.outer, screens[0].work));
            assert_ne!(plan.outer, original.outer);
        }
    }

    #[test]
    fn disconnected_monitor_repairs_size_and_position_within_remaining_work_area() {
        let old = [monitor("removed", -3840, -1200, 3840, 2160, 2., true)];
        let original = frame(-3000, -900, 2600, 1600, 2.);
        let placement = saved(capture_normal(&original, &old).unwrap());
        let current = [monitor("laptop", 200, 80, 1280, 720, 1., true)];
        let plan = restore_plan(&placement, &current, &original, CloseSide::Left).unwrap();
        assert!(inside(plan.outer, current[0].work));
        assert_eq!(
            plan.inner,
            PixelSize {
                width: 1264,
                height: 682
            }
        );
        assert_eq!(
            plan.min_inner,
            PixelSize {
                width: 880,
                height: 620
            }
        );
    }

    #[test]
    fn tiny_work_area_takes_priority_over_normal_minimum_and_rejects_impossible_chrome() {
        let screens = [monitor("small", -800, -600, 360, 250, 1.5, true)];
        let original = frame(-700, -500, 1500, 1050, 1.5);
        let placement = saved(capture_normal(&original, &screens).unwrap());
        for side in [CloseSide::Left, CloseSide::Right] {
            let plan = restore_plan(&placement, &screens, &original, side).unwrap();
            assert!(inside(plan.outer, screens[0].work));
            assert_eq!(
                plan.inner,
                PixelSize {
                    width: 336,
                    height: 193
                }
            );
            assert_eq!(plan.min_inner, plan.inner);
        }
        let impossible = [monitor("tiny", 0, 0, 1, 1, 1., true)];
        assert!(restore_plan(&placement, &impossible, &original, CloseSide::Left).is_err());
    }

    #[test]
    fn emergency_uses_actual_oversized_frame_and_keeps_the_requested_titlebar_end() {
        let screens = [monitor("display", 100, -200, 1000, 700, 1., true)];
        let actual = frame(400, -100, 1600, 900, 1.);
        let left = emergency_position(&actual, &screens, CloseSide::Left).unwrap();
        let right = emergency_position(&actual, &screens, CloseSide::Right).unwrap();
        assert_eq!(left, Point { x: 100, y: -200 });
        assert_eq!(right, Point { x: -516, y: -200 });
        assert_eq!(i64::from(right.x) + i64::from(actual.outer.width), 1100);
        assert!(actual.outer.width > screens[0].work.width);
        for (position, side) in [(left, CloseSide::Left), (right, CloseSide::Right)] {
            let title = PhysicalRect {
                x: match side {
                    CloseSide::Left => position.x,
                    CloseSide::Right => position.x + actual.outer.width as i32 - 200,
                },
                y: position.y,
                width: 200,
                height: actual.top_inset,
            };
            assert!(inside(title, screens[0].work));
        }
    }

    #[test]
    fn emergency_prefers_current_negative_screen_then_primary_when_fully_disconnected() {
        let screens = [
            monitor("left", -2560, -900, 1280, 800, 1., false),
            monitor("primary", 100, 0, 1920, 1080, 1., true),
        ];
        let actual = frame(-2400, -850, 2000, 900, 1.);
        assert_eq!(
            emergency_position(&actual, &screens, CloseSide::Right).unwrap(),
            Point { x: -3296, y: -900 }
        );
        let offscreen = frame(10000, 10000, 2000, 900, 1.);
        assert_eq!(
            emergency_position(&offscreen, &screens, CloseSide::Right).unwrap(),
            Point { x: 4, y: 0 }
        );
    }

    #[test]
    fn emergency_skips_invalid_or_too_small_work_areas_and_reports_no_safe_titlebar() {
        let actual = frame(0, 0, 2000, 1000, 2.);
        let narrow = monitor("narrow", 0, 0, 399, 1500, 2., true);
        let short = monitor("short", 0, 0, 1000, 59, 2., false);
        let mut invalid = monitor("invalid", 0, 0, 1920, 1080, 1., false);
        invalid.scale = f64::NAN;
        assert!(emergency_position(&actual, &[], CloseSide::Left).is_err());
        assert!(
            emergency_position(&actual, &[narrow.clone(), short, invalid], CloseSide::Right,)
                .is_err()
        );
        let usable = monitor("usable", -1920, 0, 1920, 1080, 1., false);
        assert_eq!(
            emergency_position(&actual, &[narrow, usable], CloseSide::Left).unwrap(),
            Point { x: -1920, y: 0 }
        );
    }

    #[test]
    fn zero_transient_frames_and_unrepresentable_sizes_fail_without_rewriting_preferences() {
        let screens = [monitor("display", 0, 0, 1920, 1080, 1., true)];
        let original = frame(100, 100, 1000, 700, 1.);
        let mut transient = original;
        transient.inner.height = 0;
        assert!(capture_normal(&transient, &screens).is_err());
        transient = original;
        transient.top_inset = 500;
        assert!(capture_normal(&transient, &screens).is_err());
        let mut placement = saved(capture_normal(&original, &screens).unwrap());
        placement.normal.outer_offset_x = f64::MAX;
        let plan = restore_plan(&placement, &screens, &original, CloseSide::Right).unwrap();
        assert!(inside(plan.outer, screens[0].work));
        assert_eq!(placement.normal.outer_offset_x, f64::MAX);
        placement.normal.inner_width = f64::MAX;
        assert!(restore_plan(&placement, &screens, &original, CloseSide::Right).is_err());
    }
}
