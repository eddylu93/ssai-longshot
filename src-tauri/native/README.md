# Offline OCR backend

## Integration (owned by the main thread)

Add `mod ocr;` and `ocr::recognize_text` to `tauri::generate_handler!` in
`src/lib.rs`. No managed state, shell plugin, capabilities, screen recording
permission, network access, or Tauri resource configuration is required.

Frontend contract:

```ts
invoke<Array<{ text: string; x: number; y: number; width: number; height: number }>>(
  'recognize_text', { image: 'data:image/png;base64,...' }
)
```

Boxes are line-level, outward-rounded original PNG pixels, origin top-left.
No resizing or EXIF orientation is applied. An empty array means successful
recognition with no text; it is never a fallback for an error. OCR is not a
guarantee that every private item was found; callers must retain manual review.

Long images are cropped at original resolution into tiles of at most 1600 pixels
high with 96 pixels of vertical overlap. Each request sets `minimumTextHeight`
to 0.001. Per-tile normalized coordinates use the actual cropped height, then
add the tile's original-image Y offset. Text-compatible boxes with at least 75%
coverage of the smaller box are merged only across neighboring overlapping tiles.
Crop-edge fragments with conflicting OCR text require at least 90% smaller-box
coverage and 90% horizontal coverage. The union preserves masking coverage; text
from an unclipped observation is preferred, otherwise the longer text. Identical
messages at different positions are not merged. Results are sorted by Y then X.
The 30-second helper deadline covers every tile together, not 30 seconds per tile.

## Platforms and packaging

macOS 12+ only. The build machine needs Xcode Command Line Tools (`xcrun swiftc`
and `codesign`). `build.rs` compiles the Swift helper for the Cargo target
architecture, ad-hoc signs it, and embeds it using `include_bytes!`. Both Intel
and Apple Silicon build targets are selected explicitly; universal builds embed
the corresponding helper in each slice. Only local Apple Silicon is validated.
The app user needs no Swift toolchain, Python, model download or installation.
Swift uses macOS system frameworks/runtime, not a command on the user's PATH.

The helper is an embedded executable resource, not Tauri `externalBin`.
No generated executable is stored in the source tree. Runtime extracts only
the non-sensitive executable to an atomically created 0700 temporary directory;
the file starts at 0600 and becomes 0700 for execution. PNG and recognized text
travel only through anonymous pipes/in-memory JSON, never temporary files or
logs. RAII removes the helper after success/failure/timeout; forced app termination
can leave a non-sensitive helper directory, but never a chat image/text file.
No network APIs are used. System Vision supplies local recognition.

This repository currently uses ad-hoc app signing. Developer ID/notarized or
App Store sandbox distribution has not been verified; validate helper execution
and nested signing before claiming support for those distribution modes.

Windows and other platforms return `OCR_UNSUPPORTED_PLATFORM`. Native
Windows.Media.Ocr is not implemented or tested; no false empty success.
Microsoft documents Windows.Media.Ocr desktop support only for applications
with package identity. Ordinary Tauri NSIS/MSI installation does not establish
that contract. Adding MSIX/sparse-package identity is outside this backend-only
change; no unsupported workaround or automatic language/model download is used.
Reference: https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr

## Limits and errors

One request at a time, no queue (`OCR_BUSY`). Maximum 16 MiB decoded PNG,
32768 pixels per side, 40 million pixels, 30 seconds per helper process,
4 MiB JSON, 10000 lines, 16384 UTF-8 bytes per line. Input format, PNG header,
native decoding, and output pixel bounds are validated independently. The
blocking worker owns the concurrency permit even if its async caller cancels.
Timeout kills and reaps the helper, then joins pipe workers before releasing it.
Error strings start with stable `OCR_*` codes and omit image/text/path details.

## Verification

```sh
cd src-tauri
cargo check --tests
cargo test --test ocr_backend
cargo test --test ocr_backend real_synthetic_png_ocr -- --ignored --nocapture
cargo test --test ocr_backend real_long_png_ocr_and_total_timeout -- --ignored --nocapture
```

The last test uses test-only AppKit synthesis (English, Chinese, phone number,
and blank PNG), then invokes the actual Rust command and bundled Vision helper.
It checks recognition and non-flipped original-pixel coordinates. It does not
capture the screen, change permissions, rebuild the frontend or bundle the app.

API references:
- https://developer.apple.com/documentation/vision/vnrecognizetextrequest
- https://developer.apple.com/documentation/vision/recognizing-text-in-images
- https://developer.apple.com/documentation/vision/boundingboxproviding/boundingbox
- https://developer.apple.com/documentation/vision/vnrecognizetextrequest/minimumtextheight

Validated locally on Apple Silicon: `cargo check --tests`, `cargo test` (3 existing
tests and 6 OCR tests), and the separately enabled real synthetic PNG test
(English/Chinese/phone number/blank image). No release app rebuild, signing
distribution test or Windows real-device test was performed.

Long-image regression: a 1000 x 12000 PNG with 16px English/Chinese at both ends,
text across both edges of tile overlaps, and identical messages at two different
positions. Checks original-pixel bounds, exactly one result per physical line,
distinct repeated messages, total runtime, and actual helper timeout/cleanup with
a short injected deadline. Test-only fixtures remain in memory and anonymous pipes.
