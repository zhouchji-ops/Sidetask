//! Coordinate boundaries for the edge windows; no window calls or persistence.
//!
//! In the locked Tao/wry versions, macOS cursor coordinates use the primary
//! display's scale, window coordinates use the window's scale, and monitor
//! coordinates use that monitor's scale. Each input must be normalized with its
//! own source scale. Windows already provides one physical desktop plane.
//! See docs/research/EDGE_COORDINATES.md for the fixed upstream sources/licenses.

use super::geometry::{dock_geometry, DockGeometry, PhysicalRect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinateSpace {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    MacLogical,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    WindowsPhysical,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A global desktop rectangle: fractional logical points on macOS, physical
/// pixels on Windows. Never pass a MacLogical rectangle to a Physical setter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(self, x: f64, y: f64) -> bool {
        validate_rect(self).is_ok()
            && x.is_finite()
            && y.is_finite()
            && x >= self.x
            && x - self.x < self.width
            && y >= self.y
            && y - self.y < self.height
    }

    pub fn center_y(self) -> f64 {
        self.y + self.height / 2.
    }

    /// Only for a WindowsPhysical rectangle. Refuse fractional or overflowing
    /// values instead of silently truncating a logical rectangle into pixels.
    #[cfg(any(not(target_os = "macos"), test))]
    pub fn physical_rect(self) -> Result<PhysicalRect, String> {
        validate_rect(self)?;
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| value.fract() != 0.)
        {
            return Err(INVALID_GEOMETRY.into());
        }
        Ok(PhysicalRect {
            x: self.x as i32,
            y: self.y as i32,
            width: self.width as u32,
            height: self.height as u32,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorGeometry {
    pub bounds: Rect,
    pub work: Rect,
    /// Actual backing scale, including when bounds/work are logical on macOS.
    pub scale: f64,
    space: CoordinateSpace,
    physical_work: PhysicalRect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DockLayout {
    pub panel: Rect,
    pub handle: Rect,
}

const INVALID_GEOMETRY: &str = "屏幕或窗口坐标无效，已暂停小窗定位。";

fn validate_scale(scale: f64) -> Result<(), String> {
    if !scale.is_finite() || scale <= 0. {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(())
}

fn validate_coordinate(value: f64) -> Result<(), String> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(())
}

fn validate_rect(rect: Rect) -> Result<(), String> {
    validate_coordinate(rect.x)?;
    validate_coordinate(rect.y)?;
    validate_coordinate(rect.x + rect.width)?;
    validate_coordinate(rect.y + rect.height)?;
    if !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.
        || rect.height <= 0.
        || rect.width > i32::MAX as f64
        || rect.height > i32::MAX as f64
        || rect.x + rect.width <= rect.x
        || rect.y + rect.height <= rect.y
    {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(())
}

fn physical_rect(rect: PhysicalRect) -> Result<Rect, String> {
    let result = Rect {
        x: rect.x as f64,
        y: rect.y as f64,
        width: rect.width as f64,
        height: rect.height as f64,
    };
    validate_rect(result)?;
    Ok(result)
}

fn divisor(space: CoordinateSpace, scale: f64) -> Result<f64, String> {
    validate_scale(scale)?;
    Ok(match space {
        CoordinateSpace::MacLogical => scale,
        CoordinateSpace::WindowsPhysical => 1.,
    })
}

fn normalize_rect(
    space: CoordinateSpace,
    rect: PhysicalRect,
    source_scale: f64,
) -> Result<Rect, String> {
    let rect = physical_rect(rect)?;
    let divisor = divisor(space, source_scale)?;
    let x = rect.x / divisor;
    let y = rect.y / divisor;
    let result = Rect {
        x,
        y,
        // Derive a shared monitor seam from the same native endpoint. Dividing
        // origin and width independently can create a one-ULP overlap or gap.
        width: (rect.x + rect.width) / divisor - x,
        height: (rect.y + rect.height) / divisor - y,
    };
    validate_rect(result)?;
    Ok(result)
}

pub fn monitor_geometry(
    space: CoordinateSpace,
    bounds: PhysicalRect,
    work: PhysicalRect,
    scale: f64,
) -> Result<MonitorGeometry, String> {
    let normalized_bounds = normalize_rect(space, bounds, scale)?;
    let normalized_work = normalize_rect(space, work, scale)?;
    // Both native rectangles belong to this monitor's source scale. Compare
    // their integer endpoints before division, including negative origins.
    if work.x < bounds.x
        || work.y < bounds.y
        || work.x as i64 + work.width as i64 > bounds.x as i64 + bounds.width as i64
        || work.y as i64 + work.height as i64 > bounds.y as i64 + bounds.height as i64
    {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(MonitorGeometry {
        bounds: normalized_bounds,
        work: normalized_work,
        scale,
        space,
        physical_work: work,
    })
}

/// `primary_scale` is required on macOS even when the cursor/window is on a
/// different display. Do not feed the calling window's scale into this function.
pub fn cursor_point(
    space: CoordinateSpace,
    x: f64,
    y: f64,
    primary_scale: f64,
) -> Result<Point, String> {
    validate_coordinate(x)?;
    validate_coordinate(y)?;
    let divisor = divisor(space, primary_scale)?;
    let result = Point {
        x: x / divisor,
        y: y / divisor,
    };
    validate_coordinate(result.x)?;
    validate_coordinate(result.y)?;
    Ok(result)
}

pub fn window_rect(
    space: CoordinateSpace,
    rect: PhysicalRect,
    window_scale: f64,
) -> Result<Rect, String> {
    normalize_rect(space, rect, window_scale)
}

/// AppKit can align a requested frame to whole logical points even on Retina.
/// Quantize before setting/confirming a Mac frame, while keeping every actual
/// edge inside the work area. This does not change the saved logical preference.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_native_rect(rect: Rect, work: Rect) -> Result<Rect, String> {
    validate_rect(rect)?;
    validate_rect(work)?;
    let left = work.x.ceil();
    let top = work.y.ceil();
    let right = (work.x + work.width).floor();
    let bottom = (work.y + work.height).floor();
    let width = rect.width.floor().min(right - left);
    let height = rect.height.floor().min(bottom - top);
    if width < 1. || height < 1. {
        return Err(INVALID_GEOMETRY.into());
    }
    let result = Rect {
        x: rect.x.round().clamp(left, right - width),
        y: rect.y.round().clamp(top, bottom - height),
        width,
        height,
    };
    validate_rect(result)?;
    Ok(result)
}

/// Half-open monitor bounds give a shared seam to the monitor on its right or
/// below. For mirrored/overlapping displays, enumeration order breaks the tie;
/// the caller decides its fallback when the point falls outside every display.
pub fn monitor_at_point(monitors: &[MonitorGeometry], point: Point) -> Option<usize> {
    let space = monitors.first()?.space;
    if monitors.iter().any(|monitor| monitor.space != space) {
        return None;
    }
    monitors
        .iter()
        .position(|monitor| monitor.bounds.contains(point.x, point.y))
}

fn local_layout(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    width: f64,
    height: f64,
    left: bool,
    offset: f64,
) -> Result<DockGeometry, String> {
    if monitor.space != space || !offset.is_finite() {
        return Err(INVALID_GEOMETRY.into());
    }
    validate_scale(monitor.scale)?;
    // Public display fields may be inspected freely, but calculations must not
    // combine a changed scale/work rectangle with stale native pixel dimensions.
    if monitor.work != normalize_rect(space, monitor.physical_work, monitor.scale)? {
        return Err(INVALID_GEOMETRY.into());
    }
    for logical in [width, height, 8., 18., 92.] {
        let pixels = logical * monitor.scale;
        if !logical.is_finite()
            || logical <= 0.
            || !pixels.is_finite()
            || pixels <= 0.
            || pixels.round() > i32::MAX as f64
        {
            return Err(INVALID_GEOMETRY.into());
        }
    }
    // The existing integer algorithm is safe on this validated local rectangle:
    // no global origin is multiplied by target DPI, and all dimensions fit i32.
    let result = dock_geometry(
        PhysicalRect {
            x: 0,
            y: 0,
            width: monitor.physical_work.width,
            height: monitor.physical_work.height,
        },
        monitor.scale,
        width,
        height,
        left,
        offset,
    );
    // An unusually small positive scale can round the handle to zero pixels.
    // Refuse that environment consistently for layout, drag and resize.
    physical_rect(result.panel)?;
    physical_rect(result.handle)?;
    Ok(result)
}

fn project_local(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    local: PhysicalRect,
) -> Result<Rect, String> {
    let divisor = divisor(space, monitor.scale)?;
    // Derive both edges on the same pixel grid, then the extent. Rounding an
    // absolute desktop origin to an integer logical point would lose real pixels.
    let pixel_x = monitor.physical_work.x as f64 + local.x as f64;
    let pixel_y = monitor.physical_work.y as f64 + local.y as f64;
    let x = pixel_x / divisor;
    let y = pixel_y / divisor;
    let right = ((pixel_x + local.width as f64) / divisor).min(monitor.work.x + monitor.work.width);
    let bottom =
        ((pixel_y + local.height as f64) / divisor).min(monitor.work.y + monitor.work.height);
    let result = Rect {
        x,
        y,
        width: inward_extent(x, right)?,
        height: inward_extent(y, bottom)?,
    };
    validate_rect(result)?;
    Ok(result)
}

/// Subtracting and then adding distant coordinates can round outward by one
/// ULP. Bias only that representational error inward; keep the backing-pixel
/// layout unchanged instead of rounding the whole rectangle to logical integers.
fn inward_extent(origin: f64, end: f64) -> Result<f64, String> {
    let mut extent = end - origin;
    if !extent.is_finite() || extent <= 0. {
        return Err(INVALID_GEOMETRY.into());
    }
    if origin + extent > end {
        // Positive finite IEEE-754 values are ordered by their bit pattern.
        // Keep compatibility with the crate's Rust 1.85 minimum version.
        extent = f64::from_bits(extent.to_bits() - 1);
    }
    if !extent.is_finite() || extent <= 0. || origin + extent > end {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(extent)
}

pub fn dock_layout(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    width: f64,
    height: f64,
    left: bool,
    offset: f64,
) -> Result<DockLayout, String> {
    let local = local_layout(space, monitor, width, height, left, offset)?;
    Ok(DockLayout {
        panel: project_local(space, monitor, local.panel)?,
        handle: project_local(space, monitor, local.handle)?,
    })
}

fn offset_for_top(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    local: DockGeometry,
    top: f64,
) -> Result<f64, String> {
    validate_coordinate(top)?;
    let divisor = divisor(space, monitor.scale)?;
    let travel =
        monitor.physical_work.height as i64 - local.panel.height as i64 - 2 * local.panel.y as i64;
    if travel <= 0 {
        return Ok(0.);
    }
    let offset = ((top - monitor.work.y) * divisor - local.panel.y as f64) / travel as f64;
    if !offset.is_finite() {
        return Err(INVALID_GEOMETRY.into());
    }
    Ok(offset.clamp(0., 1.))
}

/// Preserve the previous top edge while a new logical size is previewed. `top`
/// must be in the same desktop plane as MonitorGeometry::work.
pub fn resize_offset(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    width: f64,
    height: f64,
    left: bool,
    top: f64,
) -> Result<f64, String> {
    let local = local_layout(space, monitor, width, height, left, 0.)?;
    offset_for_top(space, monitor, local, top)
}

/// Preserve the released source window's center, using the target's *clamped*
/// panel height. This also applies when dragging the separate small handle.
pub fn drag_offset(
    space: CoordinateSpace,
    monitor: &MonitorGeometry,
    width: f64,
    height: f64,
    left: bool,
    center_y: f64,
) -> Result<f64, String> {
    validate_coordinate(center_y)?;
    let local = local_layout(space, monitor, width, height, left, 0.)?;
    let divisor = divisor(space, monitor.scale)?;
    let top = center_y - local.panel.height as f64 / divisor / 2.;
    offset_for_top(space, monitor, local, top)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: CoordinateSpace = CoordinateSpace::MacLogical;
    const WINDOWS: CoordinateSpace = CoordinateSpace::WindowsPhysical;

    fn pixels(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect {
        PhysicalRect {
            x,
            y,
            width,
            height,
        }
    }

    fn monitor(space: CoordinateSpace, rect: PhysicalRect, scale: f64) -> MonitorGeometry {
        monitor_geometry(space, rect, rect, scale).unwrap()
    }

    fn near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn three_source_scales_share_one_mac_plane_and_release_target() {
        let primary = monitor(MAC, pixels(0, 0, 2880, 1800), 2.);
        // Physical-looking origin 2160 means global logical x=1440 on this 1.5x screen.
        let target = monitor(MAC, pixels(2160, -450, 2880, 1800), 1.5);
        let cursor = cursor_point(MAC, 3200., 700., 2.).unwrap();
        assert_eq!(cursor, Point { x: 1600., y: 350. });
        assert_eq!(monitor_at_point(&[primary, target], cursor), Some(1));
        let source = window_rect(MAC, pixels(1450, 180, 368, 610), 1.).unwrap();
        let offset = drag_offset(MAC, &target, 368., 610., true, source.center_y()).unwrap();
        let layout = dock_layout(MAC, &target, 368., 610., true, offset).unwrap();
        near(layout.panel.x, 1448.);
        near(layout.panel.width, 368.);
        near(layout.panel.center_y(), source.center_y());
        assert!(layout.panel.contains(cursor.x, cursor.y));
        // Changing the primary scale only changes the API encoding of the cursor.
        assert_eq!(cursor_point(MAC, 1600., 350., 1.).unwrap(), cursor);
        // Changing the source window scale leaves its recovered desktop frame identical.
        assert_eq!(
            window_rect(MAC, pixels(2900, 360, 736, 1220), 2.).unwrap(),
            source
        );
    }

    #[test]
    fn negative_and_vertical_monitor_seams_are_half_open() {
        let left = monitor(MAC, pixels(-2880, 0, 2880, 1800), 2.);
        let right = monitor(MAC, pixels(0, 0, 2160, 1350), 1.5);
        let above = monitor(MAC, pixels(0, -900, 1440, 900), 1.);
        let monitors = [left, right, above];
        for (point, expected) in [
            (Point { x: -0.5, y: 100. }, Some(0)),
            (Point { x: 0., y: 100. }, Some(1)),
            (Point { x: 100., y: -0.5 }, Some(2)),
            (Point { x: 100., y: 0. }, Some(1)),
            (Point { x: 1440., y: 100. }, None),
            (
                Point {
                    x: -1440.,
                    y: 899.5,
                },
                Some(0),
            ),
            (
                Point {
                    x: -1440.5,
                    y: 100.,
                },
                None,
            ),
        ] {
            assert_eq!(monitor_at_point(&monitors, point), expected);
        }
        assert_eq!(monitor_at_point(&[], Point { x: 0., y: 0. }), None);
        assert_eq!(
            monitor_at_point(&monitors, Point { x: f64::NAN, y: 0. }),
            None
        );
    }

    #[test]
    fn fractional_mac_origin_and_real_backing_pixel_sizes_are_preserved() {
        let target = monitor(MAC, pixels(-2882, -451, 2880, 1800), 1.5);
        let layout = dock_layout(MAC, &target, 367.5, 610., false, 0.).unwrap();
        // 367.5 DIP rounds to 551 backing pixels, not to an integer DIP width.
        near(layout.panel.width * target.scale, 551.);
        near(
            (layout.panel.x - target.work.x) * target.scale,
            2880. - 12. - 551.,
        );
        near(layout.handle.width * target.scale, 27.);
        near(layout.handle.height * target.scale, 138.);
        near((layout.panel.y - target.work.y) * target.scale, 12.);
        assert_ne!(layout.panel.x.fract(), 0.);
        near(
            layout.handle.x + layout.handle.width,
            target.work.x + target.work.width,
        );
        assert!(!layout
            .handle
            .contains(target.work.x + target.work.width, layout.handle.y));
    }

    #[test]
    fn fractional_seam_is_not_assigned_to_the_previous_monitor_by_roundoff() {
        // Separately dividing 4/1.5 and 7/1.5 makes their sum one ULP larger
        // than 11/1.5. The shared native endpoint must define the half-open seam.
        let left = monitor(MAC, pixels(4, 0, 7, 150), 1.5);
        let right = monitor(MAC, pixels(22, 0, 300, 300), 3.);
        let seam = right.bounds.x;
        assert!(!left.bounds.contains(seam, 10.));
        assert!(right.bounds.contains(seam, 10.));
        assert_eq!(
            monitor_at_point(&[left, right], Point { x: seam, y: 10. }),
            Some(1)
        );
        let layout = dock_layout(MAC, &left, 368., 610., false, 0.).unwrap();
        assert!(!layout.handle.contains(seam, layout.handle.y));
        let above = monitor(MAC, pixels(0, 4, 150, 7), 1.5);
        let below = monitor(MAC, pixels(0, 22, 300, 300), 3.);
        let seam = below.bounds.y;
        assert!(!above.bounds.contains(10., seam));
        assert_eq!(
            monitor_at_point(&[above, below], Point { x: 10., y: seam }),
            Some(1)
        );
    }

    #[test]
    fn scale_too_small_to_draw_a_handle_rejects_layout_and_both_offsets() {
        for space in [MAC, WINDOWS] {
            for scale in [0.001, 0.01, 0.025] {
                let target = monitor(space, pixels(0, 0, 1920, 1080), scale);
                assert!(dock_layout(space, &target, 368., 610., true, 0.).is_err());
                assert!(resize_offset(space, &target, 368., 610., true, 10.).is_err());
                assert!(drag_offset(space, &target, 368., 610., true, 10.).is_err());
            }
        }
    }

    #[test]
    fn work_area_must_be_inside_its_monitor_in_the_native_source_plane() {
        let bounds = pixels(-1920, -900, 1920, 1080);
        for space in [MAC, WINDOWS] {
            assert!(monitor_geometry(space, bounds, pixels(-1920, -864, 1860, 1044), 1.5).is_ok());
            for work in [
                pixels(-1921, -900, 1920, 1080),
                pixels(-1920, -901, 1920, 1080),
                pixels(-1919, -900, 1920, 1080),
                pixels(-1920, -899, 1920, 1080),
                pixels(0, 0, 1920, 1080),
            ] {
                assert!(monitor_geometry(space, bounds, work, 1.5).is_err());
            }
        }
    }

    #[test]
    fn every_dock_edge_stays_inside_tiny_or_normal_work_areas() {
        for space in [MAC, WINDOWS] {
            for scale in [1., 1.25, 1.5, 2., 3.] {
                for (width, height) in [(1, 1), (4, 12), (30, 7), (1280, 800), (2880, 1800)] {
                    let target = monitor(space, pixels(-3501, -2101, width, height), scale);
                    for left in [true, false] {
                        for offset in [-1., 0., 0.38, 1., 2.] {
                            let layout =
                                dock_layout(space, &target, 640., 1000., left, offset).unwrap();
                            for rect in [layout.panel, layout.handle] {
                                assert!(rect.x >= target.work.x && rect.y >= target.work.y);
                                assert!(
                                    rect.x + rect.width <= target.work.x + target.work.width,
                                    "{space:?} scale={scale}, {width}x{height}, left={left}, offset={offset}, rect={rect:?}, work={:?}",
                                    target.work
                                );
                                assert!(
                                    rect.y + rect.height <= target.work.y + target.work.height,
                                    "{space:?} scale={scale}, {width}x{height}, left={left}, offset={offset}, rect={rect:?}, work={:?}",
                                    target.work
                                );
                                let divisor = divisor(space, scale).unwrap();
                                let local_right = (rect.x + rect.width - target.work.x) * divisor;
                                let local_bottom = (rect.y + rect.height - target.work.y) * divisor;
                                assert!(local_right <= width as f64 + 0.000_001);
                                assert!(local_bottom <= height as f64 + 0.000_001);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn resize_and_drag_offsets_follow_the_clamped_pixel_shape() {
        for space in [MAC, WINDOWS] {
            let target = monitor(space, pixels(-2881, -451, 2880, 1800), 1.5);
            let before = dock_layout(space, &target, 368., 600., false, 0.38).unwrap();
            let offset = resize_offset(space, &target, 410., 720., false, before.panel.y).unwrap();
            let resized = dock_layout(space, &target, 410., 720., false, offset).unwrap();
            near(resized.panel.y, before.panel.y);
            let restored_offset =
                resize_offset(space, &target, 368., 600., false, before.panel.y).unwrap();
            assert_eq!(
                dock_layout(space, &target, 368., 600., false, restored_offset).unwrap(),
                before
            );
            let from_center =
                drag_offset(space, &target, 368., 600., true, before.panel.center_y()).unwrap();
            let dragged = dock_layout(space, &target, 368., 600., true, from_center).unwrap();
            near(dragged.panel.center_y(), before.panel.center_y());

            let tiny = monitor(space, pixels(-150, -90, 30, 12), 1.5);
            assert_eq!(
                drag_offset(space, &tiny, 368., 610., true, 1000.).unwrap(),
                0.
            );
            assert_eq!(
                resize_offset(space, &tiny, 368., 610., true, -1000.).unwrap(),
                0.
            );
        }
    }

    #[test]
    fn windows_keeps_native_physical_coordinates_and_existing_layouts() {
        for scale in [1., 1.25, 1.5, 2., 3.] {
            let raw = pixels(-2560, -800, 2560, 1400);
            let target = monitor(WINDOWS, raw, scale);
            assert_eq!(target.work, physical_rect(raw).unwrap());
            assert_eq!(window_rect(WINDOWS, raw, scale).unwrap(), target.work);
            assert_eq!(
                cursor_point(WINDOWS, -2000., -400., scale).unwrap(),
                Point {
                    x: -2000.,
                    y: -400.
                }
            );
            for left in [true, false] {
                for offset in [0., 0.38, 1.] {
                    let expected = dock_geometry(raw, scale, 368., 610., left, offset);
                    let actual = dock_layout(WINDOWS, &target, 368., 610., left, offset).unwrap();
                    assert_eq!(actual.panel, physical_rect(expected.panel).unwrap());
                    assert_eq!(actual.handle, physical_rect(expected.handle).unwrap());
                    assert_eq!(actual.panel.physical_rect().unwrap(), expected.panel);
                    assert_eq!(actual.handle.physical_rect().unwrap(), expected.handle);
                }
            }
        }
    }

    #[test]
    fn native_desktop_limits_do_not_overflow_local_pixel_arithmetic() {
        for space in [MAC, WINDOWS] {
            for scale in [1., 1.5, 2.] {
                for raw in [
                    pixels(i32::MIN, i32::MIN, 64, 64),
                    pixels(i32::MAX - 64, i32::MAX - 64, 64, 64),
                ] {
                    let target = monitor(space, raw, scale);
                    for left in [true, false] {
                        let layout = dock_layout(space, &target, 640., 1000., left, 1.).unwrap();
                        for rect in [layout.panel, layout.handle] {
                            assert!(rect.x >= target.work.x && rect.y >= target.work.y);
                            assert!(rect.x + rect.width <= target.work.x + target.work.width);
                            assert!(rect.y + rect.height <= target.work.y + target.work.height);
                            if space == WINDOWS {
                                let physical = rect.physical_rect().unwrap();
                                assert!(
                                    physical.x as i64 + physical.width as i64 <= i32::MAX as i64
                                );
                                assert!(
                                    physical.y as i64 + physical.height as i64 <= i32::MAX as i64
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn scale_remains_part_of_monitor_identity_even_with_equal_mac_work_area() {
        let one = monitor(MAC, pixels(-1440, 0, 1440, 900), 1.);
        let two = monitor(MAC, pixels(-2880, 0, 2880, 1800), 2.);
        assert_eq!(one.work, two.work);
        assert_ne!(one, two);
        let at_one = dock_layout(MAC, &one, 367.5, 610., true, 0.).unwrap();
        let at_two = dock_layout(MAC, &two, 367.5, 610., true, 0.).unwrap();
        near(at_one.panel.width, 368.);
        near(at_two.panel.width, 367.5);
    }

    #[test]
    fn invalid_scale_values_dimensions_and_overflows_are_rejected() {
        let valid = pixels(0, 0, 1920, 1080);
        for space in [MAC, WINDOWS] {
            for scale in [0., -1., f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                assert!(monitor_geometry(space, valid, valid, scale).is_err());
                assert!(window_rect(space, valid, scale).is_err());
                assert!(cursor_point(space, 0., 0., scale).is_err());
            }
            for raw in [
                pixels(0, 0, 0, 10),
                pixels(0, 0, 10, 0),
                pixels(i32::MAX, 0, 1, 1),
                pixels(0, 0, u32::MAX, 1),
            ] {
                assert!(monitor_geometry(space, raw, raw, 1.).is_err());
                assert!(window_rect(space, raw, 1.).is_err());
            }
            let target = monitor(space, valid, 1.5);
            for invalid in [0., -1., f64::NAN, f64::INFINITY, f64::MAX] {
                assert!(dock_layout(space, &target, invalid, 610., true, 0.).is_err());
                assert!(dock_layout(space, &target, 368., invalid, true, 0.).is_err());
            }
            for invalid in [f64::NAN, f64::INFINITY, f64::MAX] {
                assert!(cursor_point(space, invalid, 0., 1.).is_err());
                assert!(cursor_point(space, 0., invalid, 1.).is_err());
                assert!(resize_offset(space, &target, 368., 610., true, invalid).is_err());
                assert!(drag_offset(space, &target, 368., 610., true, invalid).is_err());
            }
            for invalid in [f64::NAN, f64::INFINITY] {
                assert!(dock_layout(space, &target, 368., 610., true, invalid).is_err());
            }
            assert_eq!(
                dock_layout(space, &target, 368., 610., true, f64::MAX).unwrap(),
                dock_layout(space, &target, 368., 610., true, 1.).unwrap()
            );
        }
        assert!(window_rect(MAC, valid, f64::MIN_POSITIVE).is_err());
        assert!(cursor_point(MAC, 100., 100., f64::MIN_POSITIVE).is_err());
        let huge_scale = monitor(MAC, pixels(0, 0, 100, 100), f64::MAX);
        assert!(dock_layout(MAC, &huge_scale, 368., 610., true, 0.).is_err());
        let target = monitor(MAC, valid, 1.);
        assert!(dock_layout(WINDOWS, &target, 368., 610., true, 0.).is_err());
        let other = monitor(WINDOWS, valid, 1.);
        assert_eq!(
            monitor_at_point(&[target, other], Point { x: 0., y: 0. }),
            None
        );
    }

    #[test]
    fn mac_native_frames_match_appkit_point_alignment_without_changing_saved_size() {
        // Observed on macOS 26.4.1 at 2x: AppKit returns y=126 for y=125.5.
        let work = Rect {
            x: 0.,
            y: 33.,
            width: 1470.,
            height: 849.,
        };
        let desired = Rect {
            x: 1094.,
            y: 125.5,
            width: 368.,
            height: 610.,
        };
        let actual = mac_native_rect(desired, work).unwrap();
        assert_eq!(actual, Rect { y: 126., ..desired });
        assert_eq!(mac_native_rect(actual, work).unwrap(), actual);
        // Near a lower seam, rounding must move inward instead of crossing it.
        let bottom = Rect {
            y: 272.5,
            ..desired
        };
        let fitted = mac_native_rect(bottom, work).unwrap();
        assert_eq!(fitted.y, 272.);
        assert_eq!(fitted.height, 610.);
        assert_eq!(fitted.y + fitted.height, work.y + work.height);
    }

    #[test]
    fn mac_native_frames_keep_fractional_negative_work_areas_strictly_contained() {
        let work = Rect {
            x: -1920.5,
            y: -849.25,
            width: 1910.75,
            height: 840.75,
        };
        for desired in [
            Rect {
                x: work.x,
                y: work.y,
                width: work.width,
                height: work.height,
            },
            Rect {
                x: -309.9,
                y: -389.1,
                width: 300.25,
                height: 380.5,
            },
            Rect {
                x: -1920.25,
                y: -848.5,
                width: 18.5,
                height: 92.5,
            },
        ] {
            let fitted = mac_native_rect(desired, work).unwrap();
            assert!(fitted.x >= work.x && fitted.y >= work.y);
            assert!(fitted.x + fitted.width <= work.x + work.width);
            assert!(fitted.y + fitted.height <= work.y + work.height);
            assert!(fitted.width <= desired.width && fitted.height <= desired.height);
            assert!([fitted.x, fitted.y, fitted.width, fitted.height]
                .iter()
                .all(|v| v.fract() == 0.));
            assert_eq!(mac_native_rect(fitted, work).unwrap(), fitted);
        }
        assert!(mac_native_rect(work, Rect { width: 0.5, ..work }).is_err());
        assert!(mac_native_rect(
            Rect {
                y: f64::NAN,
                ..work
            },
            work
        )
        .is_err());
    }

    #[test]
    fn windows_setter_conversion_rejects_fractional_and_overflowing_rectangles() {
        let valid = Rect {
            x: -1920.,
            y: -100.,
            width: 368.,
            height: 610.,
        };
        assert_eq!(
            valid.physical_rect().unwrap(),
            pixels(-1920, -100, 368, 610)
        );
        for invalid in [
            Rect {
                x: -1920.5,
                ..valid
            },
            Rect { y: -100.5, ..valid },
            Rect {
                width: 367.5,
                ..valid
            },
            Rect {
                height: 610.5,
                ..valid
            },
            Rect {
                x: i32::MAX as f64,
                ..valid
            },
            Rect {
                y: f64::NAN,
                ..valid
            },
            Rect {
                width: u32::MAX as f64,
                ..valid
            },
        ] {
            assert!(invalid.physical_rect().is_err());
        }
    }
}
