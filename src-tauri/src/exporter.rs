use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[tauri::command]
pub async fn export_image(
    app: tauri::AppHandle,
    image: String,
    format: String,
) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "无法访问下载文件夹".to_string())?;
    tauri::async_runtime::spawn_blocking(move || save(&directory, &image, &format))
        .await
        .map_err(|_| "导出任务失败".to_string())?
}

fn save(directory: &Path, image: &str, format: &str) -> Result<String, String> {
    let (prefix, extension) = match format {
        "png" => ("data:image/png;base64,", "png"),
        "jpeg" => ("data:image/jpeg;base64,", "jpeg"),
        _ => return Err("仅支持 PNG 或 JPEG".into()),
    };
    if image.len() > 134_000_000 {
        return Err("导出文件超过 100 MB，请分批处理".into());
    }
    let payload = image.strip_prefix(prefix).ok_or("图片格式不匹配")?;
    let bytes = STANDARD.decode(payload).map_err(|_| "图片编码无效")?;
    if bytes.len() > 100_000_000
        || !(if format == "png" {
            bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        } else {
            bytes.starts_with(b"\xff\xd8\xff")
        })
    {
        return Err("导出图片无效或过大".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "无法读取系统时间")?
        .as_nanos();
    let path = directory.join(format!("long-screenshot-{stamp}.{extension}"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "无法写入下载文件夹，请检查访问权限和剩余空间")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err("文件写入未完成，请检查剩余空间".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_format_and_reports_missing_directory() {
        assert!(save(Path::new("/missing-export-directory"), "", "../png").is_err());
        assert!(save(
            Path::new("/missing-export-directory"),
            "data:image/png;base64,AAAA",
            "png"
        )
        .is_err());
        let png = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        );
        assert!(save(Path::new("/missing-export-directory"), &png, "png").is_err());
    }
    #[test]
    fn saves_without_overwriting_and_confirms_bytes() {
        let dir = std::env::temp_dir();
        let data = b"\x89PNG\r\n\x1a\nfixture";
        let image = format!("data:image/png;base64,{}", STANDARD.encode(data));
        let first = save(&dir, &image, "png").unwrap();
        let second = save(&dir, &image, "png").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), data);
        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
    }
}
