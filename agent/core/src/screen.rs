use serde::{Deserialize, Serialize};

/// A monitor in physical pixels, positioned in the virtual desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Screen {
    /// Convert 0..1 coordinates from the technician into a physical pixel.
    /// Out-of-range or non-finite values are clamped to the screen edge.
    pub fn to_pixel(&self, nx: f64, ny: f64) -> (i32, i32) {
        let clamp = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
        let px = (clamp(nx) * (self.width.saturating_sub(1)) as f64).round() as i32;
        let py = (clamp(ny) * (self.height.saturating_sub(1)) as f64).round() as i32;
        (self.x + px, self.y + py)
    }
}

/// Pick the monitor the user is sharing. The captured video has the monitor's
/// physical size, so match on that; prefer the primary monitor on ties.
/// Returns `(screen, exact_match)`.
pub fn pick_monitor(monitors: &[Screen], primary: Option<Screen>, video_w: u32, video_h: u32) -> Option<(Screen, bool)> {
    let close = |s: &Screen| s.width.abs_diff(video_w) <= 2 && s.height.abs_diff(video_h) <= 2;
    if let Some(p) = primary.filter(close) {
        return Some((p, true));
    }
    if let Some(m) = monitors.iter().find(|s| close(s)) {
        return Some((*m, true));
    }
    // Same aspect ratio (capture was downscaled).
    let ratio = |w: u32, h: u32| w as f64 / h.max(1) as f64;
    let target = ratio(video_w, video_h);
    let same_aspect = |s: &Screen| (ratio(s.width, s.height) - target).abs() < 0.01;
    if let Some(p) = primary.filter(same_aspect) {
        return Some((p, true));
    }
    if let Some(m) = monitors.iter().find(|s| same_aspect(s)) {
        return Some((*m, true));
    }
    primary.or_else(|| monitors.first().copied()).map(|s| (s, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Screen = Screen { x: 0, y: 0, width: 1920, height: 1080 };
    const SIDE: Screen = Screen { x: 1920, y: -200, width: 2560, height: 1440 };

    #[test]
    fn maps_corners_and_centre() {
        assert_eq!(MAIN.to_pixel(0.0, 0.0), (0, 0));
        assert_eq!(MAIN.to_pixel(1.0, 1.0), (1919, 1079));
        assert_eq!(MAIN.to_pixel(0.5, 0.5), (960, 540));
    }

    #[test]
    fn maps_onto_offset_monitor() {
        assert_eq!(SIDE.to_pixel(0.0, 0.0), (1920, -200));
        assert_eq!(SIDE.to_pixel(1.0, 1.0), (1920 + 2559, -200 + 1439));
    }

    #[test]
    fn clamps_bad_values() {
        assert_eq!(MAIN.to_pixel(-3.0, 9.0), (0, 1079));
        assert_eq!(MAIN.to_pixel(f64::NAN, f64::INFINITY), (0, 0));
    }

    #[test]
    fn picks_monitor_by_size() {
        let all = [MAIN, SIDE];
        assert_eq!(pick_monitor(&all, Some(MAIN), 2560, 1440), Some((SIDE, true)));
        assert_eq!(pick_monitor(&all, Some(MAIN), 1920, 1080), Some((MAIN, true)));
    }

    #[test]
    fn picks_downscaled_capture_by_aspect_ratio() {
        let tall = Screen { x: 0, y: 0, width: 1200, height: 1920 };
        assert_eq!(pick_monitor(&[MAIN, tall], Some(MAIN), 600, 960), Some((tall, true)));
    }

    #[test]
    fn falls_back_to_primary_when_unknown() {
        assert_eq!(pick_monitor(&[MAIN, SIDE], Some(MAIN), 800, 333), Some((MAIN, false)));
        assert_eq!(pick_monitor(&[], None, 800, 600), None);
    }
}
