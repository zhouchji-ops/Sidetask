/// Physical desktop coordinates. Origin may be negative; DPI is applied exactly once.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DockGeometry {
    pub panel: PhysicalRect,
    pub handle: PhysicalRect,
}
pub fn dock_geometry(
    work: PhysicalRect,
    scale: f64,
    width: f64,
    height: f64,
    left: bool,
    offset: f64,
) -> DockGeometry {
    let margin = ((8. * scale).round() as u32)
        .min(work.width.saturating_sub(1) / 2)
        .min(work.height.saturating_sub(1) / 2);
    let width = ((width * scale).round() as u32)
        .min(work.width.saturating_sub(margin * 2))
        .max(1);
    let height = ((height * scale).round() as u32)
        .min(work.height.saturating_sub(margin * 2))
        .max(1);
    let x = if left {
        work.x + margin as i32
    } else {
        work.x + work.width as i32 - width as i32 - margin as i32
    };
    let travel = work.height.saturating_sub(height + margin * 2);
    let y = work.y + margin as i32 + (travel as f64 * offset.clamp(0., 1.)).round() as i32;
    let handle_width = ((18. * scale).round() as u32).min(work.width);
    let handle_height = ((92. * scale).round() as u32).min(work.height);
    let handle_x = if left {
        work.x
    } else {
        work.x + work.width as i32 - handle_width as i32
    };
    let handle_y = (y + (height as i32 - handle_height as i32) / 2).clamp(
        work.y,
        work.y + work.height.saturating_sub(handle_height) as i32,
    );
    DockGeometry {
        panel: PhysicalRect {
            x,
            y,
            width,
            height,
        },
        handle: PhysicalRect {
            x: handle_x,
            y: handle_y,
            width: handle_width,
            height: handle_height,
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rectangles_stay_in_negative_work_area_at_mixed_scales() {
        for scale in [1., 1.25, 1.5, 2., 3.] {
            for left in [true, false] {
                for offset in [0., 0.5, 1.] {
                    let work = PhysicalRect {
                        x: -2560,
                        y: -800,
                        width: 2560,
                        height: 1400,
                    };
                    let geometry = dock_geometry(work, scale, 640., 1000., left, offset);
                    for rect in [geometry.panel, geometry.handle] {
                        assert!(rect.x >= work.x && rect.y >= work.y);
                        assert!(
                            rect.x as i64 + rect.width as i64 <= work.x as i64 + work.width as i64
                        );
                        assert!(
                            rect.y as i64 + rect.height as i64
                                <= work.y as i64 + work.height as i64
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn tiny_work_area_takes_priority_over_preferred_size_and_margin() {
        for size in [1, 4, 12, 30] {
            let work = PhysicalRect {
                x: -50,
                y: 90,
                width: size,
                height: size,
            };
            for left in [true, false] {
                let geometry = dock_geometry(work, 3., 640., 1000., left, 1.);
                for rect in [geometry.panel, geometry.handle] {
                    assert!(rect.x >= work.x && rect.y >= work.y);
                    assert!(rect.x + rect.width as i32 <= work.x + work.width as i32);
                    assert!(rect.y + rect.height as i32 <= work.y + work.height as i32);
                }
            }
        }
    }
}
