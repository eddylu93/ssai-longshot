use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::io::Cursor;
use wayscrollshot_band::stitch::band::{CoreConfig, FrameStatus, PixelImage, RawStitcher};
use xcap::image::{self, ImageFormat, RgbaImage};

pub const MAX_INPUT_BYTES: usize = 100_000_000;
const MAX_PIXELS: u64 = 32_000_000;
const MAX_HEIGHT: u32 = 32760;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResult {
    pub src: String,
    pub width: u32,
    pub height: u32,
    pub issues: Vec<String>,
    pub processed: usize,
    pub rejected: usize,
}

pub struct SessionStitcher {
    core: Option<RawStitcher>,
    width: u32,
    processed: usize,
    rejected: usize,
}

impl SessionStitcher {
    pub fn new() -> Self {
        Self {
            core: None,
            width: 0,
            processed: 0,
            rejected: 0,
        }
    }

    pub fn push(&mut self, image: &RgbaImage) -> Result<FrameStatus, String> {
        validate_dimensions(image.width(), image.height())?;
        if self.width != 0 && self.width != image.width() {
            return Err("图片宽度不一致，请先裁到相同宽度".into());
        }
        if self.core.is_none() {
            self.width = image.width();
            self.core = Some(
                RawStitcher::new(CoreConfig {
                    min_overlap: (image.height() / 5).clamp(1, 100) as i32,
                    min_append: 1,
                    ..CoreConfig::default()
                })
                .map_err(|e| e.to_string())?,
            );
        }
        let result = self
            .core
            .as_mut()
            .unwrap()
            .push(PixelImage::from_rgba(image))
            .map_err(|e| format!("拼接容量不足或图像尺寸超限：{e}"))?;
        self.processed += 1;
        if result.status == FrameStatus::NoMatch {
            self.rejected += 1;
        }
        Ok(result.status)
    }

    pub fn height(&self) -> u32 {
        self.core
            .as_ref()
            .map_or(0, |core| core.stats().total_height.max(0) as u32)
    }

    pub fn result(&self) -> Result<NativeResult, String> {
        let image = self
            .core
            .as_ref()
            .ok_or("没有可拼接的画面")?
            .full_image()
            .map_err(|e| e.to_string())?
            .ok_or("没有可拼接的画面")?
            .to_rgba();
        let issues = if self.rejected > 0 {
            vec![format!(
                "有 {} 帧无法可靠定位，已跳过；结果可能缺少内容，请检查或手动调整",
                self.rejected
            )]
        } else {
            Vec::new()
        };
        Ok(NativeResult {
            src: encode_png(&image)?,
            width: image.width(),
            height: image.height(),
            issues,
            processed: self.processed,
            rejected: self.rejected,
        })
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || height > MAX_HEIGHT
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("图片尺寸超限，请缩小图片后重试".into());
    }
    Ok(())
}

pub fn encode_png(image: &RgbaImage) -> Result<String, String> {
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(output.into_inner())
    ))
}

pub fn decode_image(src: &str) -> Result<RgbaImage, String> {
    if src.len() > MAX_INPUT_BYTES {
        return Err("图片容量超限".into());
    }
    let (header, data) = src.split_once(',').ok_or("图片数据无效")?;
    let format = match header {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        _ => return Err("仅支持本地 PNG/JPEG 图片".into()),
    };
    let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效")?;
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
    validate_dimensions(width, height)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32760);
    limits.max_image_height = Some(MAX_HEIGHT);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    reader.limits(limits);
    let mut image = reader.decode().map_err(|e| e.to_string())?.to_rgba8();
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    Ok(image)
}

pub fn seed(engine: &mut SessionStitcher, images: &[String]) -> Result<(), String> {
    if images.len() > 60 || images.iter().map(String::len).sum::<usize>() > MAX_INPUT_BYTES {
        return Err("一次最多处理 60 张、100 MB 图片".into());
    }
    for image in images {
        engine.push(&decode_image(image)?)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn stitch_images(images: Vec<String>) -> Result<NativeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = SessionStitcher::new();
        seed(&mut engine, &images)?;
        engine.result()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(salt: u32) -> RgbaImage {
        RgbaImage::from_fn(240, 1200, |x, y| {
            let mut n = x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663) ^ salt;
            n ^= n << 13;
            n ^= n >> 17;
            n ^= n << 5;
            image::Rgba([n as u8, (n >> 8) as u8, (n >> 16) as u8, 255])
        })
    }
    fn viewport(image: &RgbaImage, y: u32) -> RgbaImage {
        image::imageops::crop_imm(image, 0, y, 240, 360).to_image()
    }
    #[test]
    fn bidirectional_revisits_preserve_exact_pixels() {
        let original = document(47);
        let mut engine = SessionStitcher::new();
        for y in [240, 420, 240, 120, 300, 480, 660, 840, 660] {
            assert_ne!(
                engine.push(&viewport(&original, y)).unwrap(),
                FrameStatus::NoMatch,
                "offset={y}"
            );
        }
        let result = engine.result().unwrap();
        assert!(result.issues.is_empty());
        assert_eq!(
            decode_image(&result.src).unwrap(),
            image::imageops::crop_imm(&original, 0, 120, 240, 1080).to_image()
        );
    }
    #[test]
    fn bad_frame_does_not_replace_reliable_anchor() {
        let original = document(47);
        let mut engine = SessionStitcher::new();
        engine.push(&viewport(&original, 0)).unwrap();
        assert_eq!(
            engine.push(&viewport(&document(999999), 0)).unwrap(),
            FrameStatus::NoMatch
        );
        assert_eq!(
            engine.push(&viewport(&original, 180)).unwrap(),
            FrameStatus::Appended
        );
        let result = engine.result().unwrap();
        assert_eq!(result.height, 540);
        assert_eq!(result.rejected, 1);
        assert!(!result.issues.is_empty());
        assert_eq!(
            decode_image(&result.src).unwrap(),
            image::imageops::crop_imm(&original, 0, 0, 240, 540).to_image()
        );
    }
    #[test]
    fn final_small_scroll_is_not_dropped() {
        let original = document(47);
        let mut engine = SessionStitcher::new();
        engine.push(&viewport(&original, 0)).unwrap();
        engine.push(&viewport(&original, 7)).unwrap();
        assert_eq!(engine.height(), 367);
    }

    #[test]
    fn smooth_picture_is_refined_to_the_exact_row_before_commit() {
        let original = RgbaImage::from_fn(240, 1600, |x, y| {
            let value = 10 + (y / 10) as u8 + if y % 40 == 0 { 3 } else { 0 };
            image::Rgba([value, value + (x % 21) as u8, value + 20, 255])
        });
        let mut engine = SessionStitcher::new();
        for y in [0, 180, 360, 540, 720, 900] {
            let frame = image::imageops::crop_imm(&original, 0, y, 240, 680).to_image();
            assert_ne!(engine.push(&frame).unwrap(), FrameStatus::NoMatch);
        }
        let result = engine.result().unwrap();
        assert_eq!(result.height, 1580);
        assert!(result.issues.is_empty());
        assert_eq!(
            decode_image(&result.src).unwrap(),
            image::imageops::crop_imm(&original, 0, 0, 240, 1580).to_image()
        );
    }

    #[test]
    fn recovery_rejects_a_similar_viewport_with_a_different_caption() {
        let original = document(47);
        let first = viewport(&original, 0);
        let mut similar = first.clone();
        for y in 20..24 {
            for x in 80..160 {
                let pixel = similar.get_pixel_mut(x, y);
                pixel[0] = 255 - pixel[0];
                pixel[1] = 255 - pixel[1];
            }
        }
        let mut engine = SessionStitcher::new();
        engine.push(&first).unwrap();
        assert_eq!(
            engine.push(&viewport(&document(999999), 0)).unwrap(),
            FrameStatus::NoMatch
        );
        assert_eq!(engine.push(&similar).unwrap(), FrameStatus::NoMatch);
        assert_eq!(engine.height(), 360);
        assert_eq!(
            engine.push(&viewport(&original, 180)).unwrap(),
            FrameStatus::Appended
        );
        assert_eq!(engine.height(), 540);
        assert!(!engine.result().unwrap().issues.is_empty());
    }

    #[test]
    fn a_different_caption_is_not_silently_called_a_stationary_duplicate() {
        let mut frame = viewport(&document(47), 0);
        let mut engine = SessionStitcher::new();
        engine.push(&frame).unwrap();
        for y in 20..24 {
            for x in 80..160 {
                let pixel = frame.get_pixel_mut(x, y);
                pixel[0] = 255 - pixel[0];
                pixel[1] = 255 - pixel[1];
            }
        }
        assert_eq!(engine.push(&frame).unwrap(), FrameStatus::NoMatch);
        assert_eq!(engine.height(), 360);
        assert!(!engine.result().unwrap().issues.is_empty());
    }

    #[test]
    fn repeated_pictures_keep_each_occurrence_and_its_caption() {
        let original = RgbaImage::from_fn(240, 2040, |x, y| {
            let row = y % 680;
            if (20..40).contains(&row) && (30..210).contains(&x) {
                let ink = ((x / 5 + y / 680 * 13) % 7) < 3;
                return image::Rgba(if ink { [40, 50, 60, 255] } else { [255; 4] });
            }
            if (80..600).contains(&row) && (24..216).contains(&x) {
                let n = row.wrapping_mul(19349663) ^ x.wrapping_mul(73856093);
                return image::Rgba([n as u8, (n >> 8) as u8, (n >> 16) as u8, 255]);
            }
            image::Rgba([241, 243, 245, 255])
        });
        let mut engine = SessionStitcher::new();
        for y in [0, 340, 680, 1020, 1360] {
            assert_ne!(
                engine
                    .push(&image::imageops::crop_imm(&original, 0, y, 240, 680).to_image())
                    .unwrap(),
                FrameStatus::NoMatch,
                "offset={y} height={}",
                engine.height()
            );
        }
        let result = engine.result().unwrap();
        assert_eq!(result.height, 2040);
        assert!(result.issues.is_empty());
        assert_eq!(decode_image(&result.src).unwrap(), original);
    }
    #[test]
    fn ambiguous_periodic_content_is_not_guessed() {
        let make = |offset: u32| {
            RgbaImage::from_fn(240, 360, |x, y| {
                let n = ((y + offset) % 40) * 913 + x * 73;
                image::Rgba([n as u8, (n / 7) as u8, (n / 13) as u8, 255])
            })
        };
        let mut engine = SessionStitcher::new();
        engine.push(&make(0)).unwrap();
        assert_eq!(engine.push(&make(60)).unwrap(), FrameStatus::NoMatch);
        assert_eq!(engine.height(), 360);
        assert!(!engine.result().unwrap().issues.is_empty());
    }
    #[test]
    fn validates_input_and_flattens_transparency() {
        assert!(decode_image("https://example.com/private.png").is_err());
        assert!(validate_dimensions(u32::MAX, u32::MAX).is_err());
        assert!(validate_dimensions(20, 32761).is_err());
        let transparent = RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 0]));
        assert_eq!(
            decode_image(&encode_png(&transparent).unwrap())
                .unwrap()
                .get_pixel(0, 0)
                .0,
            [255; 4]
        );
        assert!(SessionStitcher::new().result().is_err());
    }
    #[test]
    fn rendered_chat_revisits_match_every_output_pixel() {
        let a = image::load_from_memory(include_bytes!("../native/fixtures/stitching/chat-0.png"))
            .unwrap()
            .to_rgba8();
        let b = image::load_from_memory(include_bytes!("../native/fixtures/stitching/chat-1.png"))
            .unwrap()
            .to_rgba8();
        let mut engine = SessionStitcher::new();
        for frame in [&a, &b, &a, &b] {
            assert_ne!(engine.push(frame).unwrap(), FrameStatus::NoMatch);
        }
        let actual = decode_image(&engine.result().unwrap().src).unwrap();
        let mut expected = RgbaImage::new(900, 863);
        image::imageops::replace(&mut expected, &a, 0, 0);
        image::imageops::replace(
            &mut expected,
            &image::imageops::crop_imm(&b, 0, 575, 900, 144).to_image(),
            0,
            719,
        );
        assert_eq!(actual, expected);
    }
    #[test]
    #[ignore = "local saved capture; set PICSEW_CAPTURE_FIXTURE to the 17-frame synthetic chat PNG"]
    fn replays_saved_capture_without_static_frame_growth() {
        let path = std::env::var("PICSEW_CAPTURE_FIXTURE").unwrap();
        let raw = image::open(path).unwrap().to_rgba8();
        assert_eq!(raw.dimensions(), (885, 11645));
        let mut engine = SessionStitcher::new();
        for y in (0..raw.height()).step_by(685) {
            engine
                .push(&image::imageops::crop_imm(&raw, 0, y, 885, 685).to_image())
                .unwrap();
        }
        let result = engine.result().unwrap();
        assert_eq!(result.height, 973);
        assert_eq!(result.processed, 17);
        assert_eq!(result.rejected, 0);
        decode_image(&result.src)
            .unwrap()
            .save(std::env::temp_dir().join("picsew-native-replay.png"))
            .unwrap();
    }
}
