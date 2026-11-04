use std::{path::PathBuf, time::Instant};
use wayscrollshot_band::stitch::band::{CoreConfig, PixelImage, RawStitcher};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut split = None;
    let mut output = None;
    let mut files = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--split-height" => split = Some(args.next().ok_or("missing split height")?.parse::<u32>()?),
            "--output" => output = Some(PathBuf::from(args.next().ok_or("missing output")?)),
            _ => files.push(PathBuf::from(arg)),
        }
    }
    let start = Instant::now();
    let mut engine = None;
    let mut index = 0;
    for file in files {
        let image = image::open(file)?.to_rgba8();
        let height = split.unwrap_or(image.height());
        if height == 0 || image.height() % height != 0 { return Err("invalid split height".into()); }
        for y in (0..image.height()).step_by(height as usize) {
            let frame = image::imageops::crop_imm(&image, 0, y, image.width(), height).to_image();
            let core = engine.get_or_insert_with(|| RawStitcher::new(CoreConfig {
                min_overlap: 100.min((height / 5).max(24)) as i32,
                min_append: 1,
                ..CoreConfig::default()
            }).unwrap());
            let result = core.push(PixelImage::from_rgba(&frame))?;
            index += 1;
            println!("frame={index} status={:?} position={} added={} edge={:?}", result.status, result.position, result.added, result.edge);
        }
    }
    if let Some(image) = engine.ok_or("no frames")?.full_image()? {
        println!("result={}x{} elapsed_ms={}", image.width(), image.height(), start.elapsed().as_millis());
        if let Some(path) = output { image.to_rgba().save(path)?; }
    }
    Ok(())
}
