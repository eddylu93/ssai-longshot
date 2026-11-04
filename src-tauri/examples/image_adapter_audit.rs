//! Exercise the unchanged native adapter without launching or replacing the GUI app.
#[allow(dead_code)]
#[path = "../src/stitching.rs"]
mod stitching;

use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args().nth(1).ok_or("fixture folder required")?;
    let mut cases = fs::read_dir(&root)?.collect::<Result<Vec<_>, _>>()?;
    cases.sort_by_key(|entry| entry.file_name());
    let mut results = Vec::new();
    for case in cases {
        if !case.file_type()?.is_dir() {
            continue;
        }
        let expected_path = case.path().join("expected.png");
        if !expected_path.exists() {
            continue;
        }
        let expected = xcap::image::open(expected_path)?.to_rgba8();
        let mut frames = fs::read_dir(case.path())?.collect::<Result<Vec<_>, _>>()?;
        frames.retain(|entry| entry.file_name().to_string_lossy().starts_with("frame-"));
        frames.sort_by_key(|entry| entry.file_name());
        let mut engine = stitching::SessionStitcher::new();
        for frame in frames {
            let image = xcap::image::open(frame.path())?.to_rgba8();
            engine.push(&image).map_err(std::io::Error::other)?;
        }
        let result = engine.result().map_err(std::io::Error::other)?;
        let actual = stitching::decode_image(&result.src).map_err(std::io::Error::other)?;
        actual.save(case.path().join("actual-native-adapter.png"))?;
        let exact = expected == actual;
        let report = serde_json::json!({
            "case": case.file_name().to_string_lossy(),
            "expectedHeight": expected.height(), "actualHeight": result.height,
            "exact": exact, "processed": result.processed, "rejected": result.rejected,
            "issues": result.issues, "silentIncorrectResult": !exact && result.issues.is_empty()
        });
        println!("{report}");
        results.push(report);
    }
    fs::write(
        Path::new(&root).join("native-adapter-results.json"),
        serde_json::to_vec_pretty(&results)?,
    )?;
    Ok(())
}
