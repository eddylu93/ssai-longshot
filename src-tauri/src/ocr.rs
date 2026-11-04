use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_PNG_BYTES: usize = 16 * 1024 * 1024;
const MAX_DATA_URL: usize = 22_369_646;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TextBox {
    pub text: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

struct Permit;
impl Permit {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| "OCR_BUSY: another recognition is in progress".into())
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

/// PNG data URL in; line-level boxes in original pixels, with a top-left origin out.
#[tauri::command]
pub async fn recognize_text(image: String) -> Result<Vec<TextBox>, String> {
    if image.len() > MAX_DATA_URL {
        return Err("OCR_INPUT_LIMIT: PNG must not exceed 16 MiB".into());
    }
    let permit = Permit::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        recognize_sync(&image)
    })
    .await
    .map_err(|_| "OCR_INTERNAL: recognition worker failed".to_string())?
}

fn decode_png(image: &str) -> Result<(Vec<u8>, u32, u32), String> {
    if image.len() > MAX_DATA_URL {
        return Err("OCR_INPUT_LIMIT: PNG must not exceed 16 MiB".into());
    }
    let payload = image
        .strip_prefix("data:image/png;base64,")
        .ok_or("OCR_INVALID_INPUT: expected a base64 PNG data URL")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "OCR_INVALID_INPUT: invalid base64")?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err("OCR_INPUT_LIMIT: PNG must not exceed 16 MiB".into());
    }
    if bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[8..12] != 13u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return Err("OCR_INVALID_INPUT: invalid PNG header".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || u64::from(width) * u64::from(height) > 40_000_000
    {
        return Err("OCR_INPUT_LIMIT: maximum 32768 per side and 40 million pixels".into());
    }
    Ok((bytes, width, height))
}

fn parse_output(output: &[u8], width: u32, height: u32) -> Result<Vec<TextBox>, String> {
    if output.len() > MAX_OUTPUT {
        return Err("OCR_OUTPUT_LIMIT: too many recognition results".into());
    }
    let boxes: Vec<TextBox> = serde_json::from_slice(output)
        .map_err(|_| "OCR_INVALID_OUTPUT: helper did not return valid JSON")?;
    if boxes.len() > 10000
        || boxes.iter().any(|b| {
            b.text.is_empty()
                || b.text.len() > 16384
                || b.width == 0
                || b.height == 0
                || u64::from(b.x) + u64::from(b.width) > u64::from(width)
                || u64::from(b.y) + u64::from(b.height) > u64::from(height)
        })
    {
        return Err("OCR_INVALID_OUTPUT: invalid text bounds".into());
    }
    Ok(boxes)
}

fn recognize_sync(image: &str) -> Result<Vec<TextBox>, String> {
    let (bytes, width, height) = decode_png(image)?;
    #[cfg(target_os = "macos")]
    {
        let helper = macos::Helper::create()?;
        // One helper handles all tiles: this deadline is global, never per tile.
        let output = macos::run(&helper.path(), bytes, HELPER_TIMEOUT)?;
        parse_output(&output, width, height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes, width, height);
        Err("OCR_UNSUPPORTED_PLATFORM: this build supports macOS Vision only; Windows native OCR is not available in this build".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::MAX_OUTPUT;
    use std::fs::{DirBuilder, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    pub(super) struct Helper(PathBuf);
    impl Helper {
        pub(super) fn create() -> Result<Self, String> {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "OCR_INTERNAL: clock unavailable")?
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("picsew-ocr-{}-{nonce}", std::process::id()));
            // Atomic mkdir, no reuse of existing paths, and no sensitive image files.
            DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|_| "OCR_IO: cannot create private helper directory")?;
            let helper = Self(dir);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(helper.path())
                .map_err(|_| "OCR_IO: cannot create helper")?;
            file.write_all(include_bytes!(concat!(env!("OUT_DIR"), "/vision-ocr")))
                .map_err(|_| "OCR_IO: cannot write helper")?;
            file.set_permissions(std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "OCR_IO: cannot make helper executable")?;
            Ok(helper)
        }
        pub(super) fn path(&self) -> PathBuf {
            self.0.join("vision-ocr")
        }
    }
    impl Drop for Helper {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn run(path: &Path, bytes: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, String> {
        let mut command = Command::new(path);
        collect(&mut command, bytes, timeout)
    }

    pub(super) fn collect(
        command: &mut Command,
        bytes: Vec<u8>,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        let start = Instant::now();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "OCR_HELPER: cannot launch Vision helper")?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        // Concurrent bounded pipes prevent deadlock; kill + wait also unblocks the writer.
        let writer = std::thread::spawn(move || stdin.write_all(&bytes));
        let reader = std::thread::spawn(move || {
            let mut output = Vec::new();
            stdout
                .take((MAX_OUTPUT + 1) as u64)
                .read_to_end(&mut output)
                .map(|_| output)
        });
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if start.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Ok(None) => break Err("OCR_TIMEOUT: recognition exceeded its time limit"),
                Err(_) => break Err("OCR_HELPER: cannot monitor helper"),
            }
        };
        if status.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        let write_result = writer.join();
        let read_result = reader.join();
        let status = status?;
        if !status.success() {
            return Err("OCR_HELPER: Vision recognition failed".into());
        }
        write_result
            .map_err(|_| "OCR_IO: input worker failed")?
            .map_err(|_| "OCR_IO: helper rejected input")?;
        let output = read_result
            .map_err(|_| "OCR_IO: output worker failed")?
            .map_err(|_| "OCR_IO: cannot read helper output")?;
        if output.len() > MAX_OUTPUT {
            return Err("OCR_OUTPUT_LIMIT: helper output too large".into());
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(bytes: &[u8]) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    fn header(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(width.to_be_bytes());
        png.extend(height.to_be_bytes());
        png.resize(33, 0);
        png
    }

    #[test]
    fn rejects_invalid_inputs_and_dimensions() {
        for input in [
            "",
            "data:image/jpeg;base64,AAAA",
            "data:image/png;base64,?",
            "data:image/png;base64,AAAA",
        ] {
            assert!(decode_png(input)
                .unwrap_err()
                .starts_with("OCR_INVALID_INPUT"));
        }
        for (w, h) in [
            (0, 1),
            (1, 0),
            (32769, 1),
            (10000, 10000),
            (u32::MAX, u32::MAX),
        ] {
            assert!(decode_png(&url(&header(w, h)))
                .unwrap_err()
                .starts_with("OCR_INPUT_LIMIT"));
        }
        let (_, w, h) = decode_png(&url(&header(800, 1200))).unwrap();
        assert_eq!((w, h), (800, 1200));
        let mut png = header(1, 1);
        png[12] = b'X';
        assert!(decode_png(&url(&png)).is_err());
        assert!(decode_png(&"x".repeat(MAX_DATA_URL + 1))
            .unwrap_err()
            .starts_with("OCR_INPUT_LIMIT"));
        assert!(decode_png(&url(&vec![0; MAX_PNG_BYTES + 1])).is_err());
    }

    #[test]
    fn validates_json_and_pixel_bounds() {
        assert!(parse_output(b"[]", 10, 10).unwrap().is_empty());
        let valid = br#"[{"text":"name","x":1,"y":2,"width":9,"height":8}]"#;
        assert_eq!(parse_output(valid, 10, 10).unwrap()[0].x, 1);
        for invalid in [
            b"null".as_slice(),
            b"not json",
            br#"[{"text":"private","x":-1,"y":0,"width":1,"height":1}]"#,
            br#"[{"text":"private","x":4294967295,"y":0,"width":1,"height":1}]"#,
            br#"[{"text":"","x":0,"y":0,"width":1,"height":1}]"#,
            br#"[{"text":"private","x":0,"y":0,"width":0,"height":1}]"#,
        ] {
            let error = parse_output(invalid, 10, 10).unwrap_err();
            assert!(!error.contains("private"));
        }
        assert!(parse_output(&vec![b' '; MAX_OUTPUT + 1], 1, 1).is_err());
    }

    #[test]
    fn concurrency_permit_is_released() {
        let permit = Permit::acquire().unwrap();
        assert!(Permit::acquire().is_err());
        drop(permit);
        assert!(Permit::acquire().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn helper_is_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let helper = macos::Helper::create().unwrap();
        let path = helper.path();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        drop(helper);
        assert!(!path.parent().unwrap().exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn timeout_kills_child_and_unblocks_full_stdin() {
        let start = std::time::Instant::now();
        let error = macos::collect(
            std::process::Command::new("/bin/sleep").arg("5"),
            vec![0; 1024 * 1024],
            std::time::Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(error.starts_with("OCR_TIMEOUT"));
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn truncated_png_fails_in_native_decoder() {
        assert!(recognize_sync(&url(&header(800, 1200)))
            .unwrap_err()
            .starts_with("OCR_HELPER"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_platform_is_an_error_not_empty_success() {
        assert!(recognize_sync(&url(&header(10, 10)))
            .unwrap_err()
            .starts_with("OCR_UNSUPPORTED_PLATFORM"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "real Vision test; needs local Xcode to synthesize a PNG, not for end users"]
    fn real_synthetic_png_ocr() {
        for blank in [false, true] {
            let mut fixture = std::process::Command::new("xcrun");
            fixture.args(["swift", "native/ocr_fixture.swift"]);
            if blank {
                fixture.arg("blank");
            }
            let output = fixture.output().unwrap();
            assert!(output.status.success(), "fixture generation failed");
            let results =
                tauri::async_runtime::block_on(recognize_text(url(&output.stdout))).unwrap();
            if blank {
                assert!(results.is_empty());
            } else {
                let english = results
                    .iter()
                    .find(|b| b.text.contains("13800138000"))
                    .expect("phone number not recognized");
                assert!(english.x >= 35 && english.x <= 60);
                assert!(
                    english.y >= 55 && english.y <= 100,
                    "wrong top-left Y: {}",
                    english.y
                );
                let chinese = results
                    .iter()
                    .find(|b| b.text.contains("隐私"))
                    .expect("Chinese not recognized");
                assert!(chinese.y >= 155 && chinese.y <= 205);
                assert!(results
                    .iter()
                    .all(|b| b.x + b.width <= 1000 && b.y + b.height <= 360));
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "real Vision long-image test; needs local Xcode for PNG synthesis"]
    fn real_long_png_ocr_and_total_timeout() {
        let fixture = std::process::Command::new("xcrun")
            .args(["swift", "native/ocr_fixture.swift", "long"])
            .output()
            .unwrap();
        assert!(fixture.status.success(), "long fixture generation failed");
        let image = url(&fixture.stdout);
        let start = std::time::Instant::now();
        let results = tauri::async_runtime::block_on(recognize_text(image)).unwrap();
        assert!(start.elapsed() < HELPER_TIMEOUT + std::time::Duration::from_secs(2));
        for (text, expected_y) in [
            ("13800138000", 40u32),
            ("13700137000", 1498),
            ("13600136000", 1592),
            ("13900139000", 11920),
        ] {
            let matching: Vec<_> = results.iter().filter(|b| b.text.contains(text)).collect();
            assert_eq!(
                matching.len(),
                1,
                "missing or duplicate synthetic phone at {expected_y}"
            );
            let b = matching[0];
            assert!((35..=60).contains(&b.x));
            assert!(
                (expected_y.saturating_sub(4)..=expected_y + 16).contains(&b.y),
                "wrong Y {} at {expected_y}",
                b.y
            );
            assert!(
                (8..=24).contains(&b.height),
                "small text was scaled: {}",
                b.height
            );
        }
        let repeated: Vec<_> = results
            .iter()
            .filter(|b| b.text.contains("13500135000"))
            .collect();
        assert_eq!(
            repeated.len(),
            2,
            "overlap duplicates or distinct messages collapsed"
        );
        for expected_y in [1540u32, 7540] {
            assert!(repeated
                .iter()
                .any(|b| (expected_y.saturating_sub(4)..=expected_y + 16).contains(&b.y)));
        }
        for expected_y in [80u32, 11960] {
            assert!(
                results.iter().any(|b| b.text.contains("隐私")
                    && (expected_y.saturating_sub(4)..=expected_y + 16).contains(&b.y)),
                "16px Chinese not recognized at {expected_y}; synthetic results: {results:?}"
            );
        }
        assert!(results
            .iter()
            .all(|b| b.x + b.width <= 1000 && b.y + b.height <= 12000));
        assert_eq!(
            results.len(),
            8,
            "unexpected overlap fragments: {results:?}"
        );
        assert!(results.windows(2).all(|pair| pair[0].y <= pair[1].y));

        // Exercise the real tiled helper under a short whole-process deadline.
        let helper = macos::Helper::create().unwrap();
        let path = helper.path();
        let start = std::time::Instant::now();
        let error =
            macos::run(&path, fixture.stdout, std::time::Duration::from_millis(1)).unwrap_err();
        assert!(error.starts_with("OCR_TIMEOUT"));
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        drop(helper);
        assert!(!path.parent().unwrap().exists());
        eprintln!("12000px / 16px-font Vision regression: endpoints, seams, dedup and global timeout passed");
    }
}
