fn main() {
    println!("cargo:rerun-if-changed=native/vision_ocr.swift");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let swift_arch = match arch.as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            _ => panic!("unsupported macOS OCR architecture: {arch}"),
        };
        let output =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("vision-ocr");
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-O",
                "-target",
                &format!("{swift_arch}-apple-macosx12.0"),
            ])
            .args(["native/vision_ocr.swift", "-o"])
            .arg(&output)
            .status()
            .expect("macOS OCR build requires the Xcode Swift toolchain (not needed by users)");
        assert!(
            status.success(),
            "failed to compile bundled Vision OCR helper"
        );
        let status = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&output)
            .status()
            .expect("codesign is required to sign the embedded OCR helper");
        assert!(status.success(), "failed to sign OCR helper");
    }
    tauri_build::build()
}
