# XCap 0.9.8 Local Patch

Source: crates.io `xcap` 0.9.8, Apache-2.0 (LICENSE retained).

Only macOS recording defaults are changed:
- Do not capture the pointer or mouse-click visualization.
- Request 15 fps instead of 60 fps for bounded screenshot-stream work.

The public API, still screenshot path and Windows recorder remain unchanged.
This does not suppress overlays drawn by other applications.
