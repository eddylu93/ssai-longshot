//! Offline diagnostic only. No screen capture, application state, or permission changes.
use image::{imageops, Rgba, RgbaImage};
use std::{fs, path::Path, time::Instant};
use wayscrollshot_band::stitch::band::{CoreConfig, PixelImage, RawStitcher};

const W: u32 = 900;
const H: u32 = 680;

fn crop(image: &RgbaImage, offset: u32) -> RgbaImage {
    imageops::crop_imm(image, 0, offset, W, H).to_image()
}

fn picture(src: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let mut image = imageops::resize(src, width, height, imageops::FilterType::Lanczos3);
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    image
}

fn document(photo: &RgbaImage, other: &RgbaImage, text: &RgbaImage) -> RgbaImage {
    let mut image = RgbaImage::from_pixel(W, 3000, Rgba([241, 243, 245, 255]));
    let top = imageops::crop_imm(text, 0, 0, W, 210).to_image();
    let middle = imageops::crop_imm(text, 0, 210, W, 300).to_image();
    let bottom = imageops::crop_imm(text, 0, 510, W, 209).to_image();
    imageops::replace(&mut image, &top, 0, 0);
    imageops::replace(&mut image, &picture(photo, 736, 780), 80, 230);
    imageops::replace(&mut image, &middle, 0, 1030);
    imageops::replace(&mut image, &picture(other, 736, 760), 80, 1350);
    imageops::replace(&mut image, &bottom, 0, 2130);
    imageops::replace(&mut image, &picture(photo, 736, 600), 80, 2360);
    image
}

fn run_case(root: &Path, name: &str, frames: &[RgbaImage], expected: &RgbaImage) -> String {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    expected.save(dir.join("expected.png")).unwrap();
    let mut core = RawStitcher::new(CoreConfig {
        min_overlap: 100,
        min_append: 1,
        approx_diff: if std::env::var_os("PICSEW_AUDIT_EXACT_SEARCH").is_some() {
            0.0
        } else {
            1.0
        },
        ..CoreConfig::default()
    })
    .unwrap();
    let started = Instant::now();
    let mut trace = String::new();
    let mut rejected = 0;
    for (index, frame) in frames.iter().enumerate() {
        frame
            .save(dir.join(format!("frame-{index:02}.png")))
            .unwrap();
        let result = core.push(PixelImage::from_rgba(frame)).unwrap();
        rejected += usize::from(format!("{:?}", result.status) == "NoMatch");
        trace.push_str(&format!(
            "frame={index} status={:?} position={} added={} height={}\n",
            result.status,
            result.position,
            result.added,
            core.stats().total_height
        ));
    }
    let result = core.full_image().unwrap().unwrap().to_rgba();
    let elapsed = started.elapsed().as_millis();
    result.save(dir.join("actual.png")).unwrap();
    let mut changed = 0_u64;
    let mut first_difference = None;
    for y in 0..expected.height().min(result.height()) {
        for x in 0..expected.width().min(result.width()) {
            if expected.get_pixel(x, y) != result.get_pixel(x, y) {
                changed += 1;
                first_difference.get_or_insert((x, y));
            }
        }
    }
    let exact = result == *expected;
    trace.push_str(&format!("expected={}x{} actual={}x{} exact={exact} mismatched_common_pixels={changed} first_difference={first_difference:?} rejected={rejected} elapsed_ms={elapsed}\n",
        expected.width(), expected.height(), result.width(), result.height()));
    fs::write(dir.join("trace.txt"), &trace).unwrap();
    print!("{name}: {trace}");
    format!(
        "{name},{},{},{exact},{changed},{rejected},{elapsed}\n",
        expected.height(),
        result.height()
    )
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let asset = Path::new(args.get(1).expect("asset folder"));
    let out = Path::new(args.get(2).expect("output folder"));
    let chat = image::open(args.get(3).expect("rendered chat PNG"))
        .unwrap()
        .to_rgba8();
    let coast = image::open(asset.join("coast.png")).unwrap().to_rgba8();
    let mountains = image::open(asset.join("mountains.png")).unwrap().to_rgba8();
    let gradient = image::open(asset.join("sonoma.png")).unwrap().to_rgba8();
    fs::create_dir_all(out).unwrap();
    let mut report = String::from(
        "case,expected_height,actual_height,exact,mismatched_common_pixels,rejected,elapsed_ms\n",
    );

    for (name, source) in [("photo-only", &coast), ("smooth-image", &gradient)] {
        let page = picture(source, W, 1600);
        let offsets = [0, 180, 360, 540, 720, 900];
        let frames: Vec<_> = offsets.iter().map(|&offset| crop(&page, offset)).collect();
        report += &run_case(
            out,
            name,
            &frames,
            &imageops::crop_imm(&page, 0, 0, W, 1580).to_image(),
        );
    }

    let mixed = document(&coast, &mountains, &chat);
    for (name, offsets) in [
        (
            "mixed-photo-text",
            vec![0, 220, 440, 660, 880, 1100, 1320, 1540, 1760, 1980, 2200],
        ),
        (
            "mixed-bidirectional",
            vec![440, 660, 880, 660, 440, 220, 0, 220, 440, 660, 880, 1100],
        ),
        ("photo-short-overlap", vec![0, 560, 1120, 1680, 2240]),
    ] {
        let min = *offsets.iter().min().unwrap();
        let max = *offsets.iter().max().unwrap();
        let frames: Vec<_> = offsets.iter().map(|&offset| crop(&mixed, offset)).collect();
        report += &run_case(
            out,
            name,
            &frames,
            &imageops::crop_imm(&mixed, 0, min, W, max - min + H).to_image(),
        );
    }

    let mut repeat = RgbaImage::from_pixel(W, H * 3, Rgba([241, 243, 245, 255]));
    let thumb = picture(&coast, 736, 500);
    for index in 0..3 {
        let label = imageops::crop_imm(&chat, 80, 25 + index * 97, 520, 64).to_image();
        imageops::replace(&mut repeat, &label, 80, i64::from(index * H + 20));
        imageops::replace(&mut repeat, &thumb, 80, i64::from(index * H + 100));
    }
    let frames: Vec<_> = [0, 340, 680, 1020, 1360]
        .iter()
        .map(|&offset| crop(&repeat, offset))
        .collect();
    report += &run_case(out, "repeated-thumbnail", &frames, &repeat);

    let mut loaded = mixed.clone();
    let replacement = picture(&mountains, 736, 780);
    imageops::replace(&mut loaded, &replacement, 80, 230);
    let frames = vec![
        crop(&mixed, 0),
        crop(&loaded, 180),
        crop(&loaded, 360),
        crop(&loaded, 540),
        crop(&loaded, 720),
    ];
    report += &run_case(
        out,
        "image-replaced-during-scroll",
        &frames,
        &imageops::crop_imm(&loaded, 0, 0, W, 1400).to_image(),
    );

    let mut sidebar_frames = Vec::new();
    for offset in [0, 180, 360, 540, 720] {
        let mut frame = crop(&mixed, offset);
        for y in 0..H {
            for x in 0..250 {
                frame.put_pixel(x, y, Rgba([235, 238, 240, 255]));
            }
        }
        sidebar_frames.push(frame);
    }
    let mut sidebar_expected = imageops::crop_imm(&mixed, 0, 0, W, 1400).to_image();
    for y in 0..1400 {
        for x in 0..250 {
            sidebar_expected.put_pixel(x, y, Rgba([235, 238, 240, 255]));
        }
    }
    report += &run_case(
        out,
        "photo-with-fixed-sidebar",
        &sidebar_frames,
        &sidebar_expected,
    );
    fs::write(out.join("results.csv"), report).unwrap();
}
