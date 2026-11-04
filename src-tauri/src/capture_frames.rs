use std::time::Duration;
use xcap::image::RgbaImage;

const SETTLE_TIME: Duration = Duration::from_millis(180);

#[derive(Default)]
pub struct StableFrameGate {
    candidate: Option<RgbaImage>,
    changed_at: Duration,
}

impl StableFrameGate {
    pub fn observe(&mut self, image: RgbaImage, now: Duration) {
        if self
            .candidate
            .as_ref()
            .is_none_or(|old| !same_frame(old, &image))
        {
            self.candidate = Some(image);
            self.changed_at = now;
        }
    }

    pub fn take_ready(&mut self, now: Duration) -> Option<RgbaImage> {
        if now.saturating_sub(self.changed_at) >= SETTLE_TIME {
            self.candidate.take()
        } else {
            None
        }
    }
}

pub fn same_frame(a: &RgbaImage, b: &RgbaImage) -> bool {
    a.dimensions() == b.dimensions()
        && a.as_raw()
            .iter()
            .zip(b.as_raw())
            .all(|(x, y)| x.abs_diff(*y) <= 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xcap::image::Rgba;

    fn frame(value: u8) -> RgbaImage {
        RgbaImage::from_pixel(20, 20, Rgba([value, value, value, 255]))
    }

    #[test]
    fn waits_for_loaded_image_instead_of_committing_the_placeholder() {
        let mut gate = StableFrameGate::default();
        gate.observe(frame(210), Duration::ZERO);
        gate.observe(frame(80), Duration::from_millis(80));
        assert!(gate.take_ready(Duration::from_millis(180)).is_none());
        assert_eq!(gate.take_ready(Duration::from_millis(260)), Some(frame(80)));
    }

    #[test]
    fn can_settle_without_a_duplicate_native_frame() {
        let mut gate = StableFrameGate::default();
        gate.observe(frame(80), Duration::ZERO);
        assert!(gate.take_ready(Duration::from_millis(179)).is_none());
        assert_eq!(gate.take_ready(Duration::from_millis(180)), Some(frame(80)));
        assert!(gate.take_ready(Duration::from_millis(400)).is_none());
    }

    #[test]
    fn gradual_changes_are_compared_to_a_fixed_candidate_not_the_last_frame() {
        let mut gate = StableFrameGate::default();
        gate.observe(frame(100), Duration::ZERO);
        gate.observe(frame(103), Duration::from_millis(100));
        gate.observe(frame(106), Duration::from_millis(160));
        assert!(gate.take_ready(Duration::from_millis(200)).is_none());
        assert_eq!(
            gate.take_ready(Duration::from_millis(340)),
            Some(frame(106))
        );
    }

    #[test]
    fn stable_loaded_frames_stitch_without_retaining_the_placeholder() {
        let loaded = RgbaImage::from_fn(240, 900, |x, y| {
            let value = x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663);
            Rgba([value as u8, (value >> 8) as u8, (value >> 16) as u8, 255])
        });
        let crop = |y| xcap::image::imageops::crop_imm(&loaded, 0, y, 240, 360).to_image();
        let mut gate = StableFrameGate::default();
        gate.observe(
            RgbaImage::from_pixel(240, 360, Rgba([220, 220, 220, 255])),
            Duration::ZERO,
        );
        gate.observe(crop(0), Duration::from_millis(80));
        assert!(gate.take_ready(Duration::from_millis(200)).is_none());
        let mut engine = crate::stitching::SessionStitcher::new();
        engine
            .push(&gate.take_ready(Duration::from_millis(260)).unwrap())
            .unwrap();
        engine.push(&crop(180)).unwrap();
        let result = engine.result().unwrap();
        assert!(result.issues.is_empty());
        assert_eq!(
            crate::stitching::decode_image(&result.src).unwrap(),
            xcap::image::imageops::crop_imm(&loaded, 0, 0, 240, 540).to_image()
        );
    }
}
