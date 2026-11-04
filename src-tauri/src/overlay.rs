use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub fn open_selector(app: &AppHandle, screen: &Geometry) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(
        app,
        "capture-overlay",
        WebviewUrl::App("index.html?capture=overlay".into()),
    )
    .title("框选采集区域")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .inner_size(
        screen.width as f64 / screen.scale,
        screen.height as f64 / screen.scale,
    )
    .position(
        screen.x as f64 / screen.scale,
        screen.y as f64 / screen.scale,
    )
    .build()
    .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(screen.x, screen.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(screen.width, screen.height))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub fn control_position(screen: &Geometry, rect: (f64, f64, f64, f64)) -> Option<(f64, f64)> {
    let (x, y, w, h) = rect;
    let sw = screen.width as f64 / screen.scale;
    let sh = screen.height as f64 / screen.scale;
    let (tw, th, gap) = (200.0, 48.0, 12.0);
    let clamped_x = x.max(0.0).min((sw - tw).max(0.0));
    if y >= th + gap {
        return Some((clamped_x, y - th - gap));
    }
    if y + h + th + gap <= sh {
        return Some((clamped_x, y + h + gap));
    }
    if x >= tw + gap {
        return Some((x - tw - gap, y.max(0.0).min(sh - th)));
    }
    if x + w + tw + gap <= sw {
        return Some((x + w + gap, y.max(0.0).min(sh - th)));
    }
    None
}

pub fn open_controls(
    app: &AppHandle,
    screen: &Geometry,
    position: (f64, f64),
) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(
        app,
        "capture-controls",
        WebviewUrl::App("index.html?capture=controls".into()),
    )
    .title("区域采集")
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .inner_size(200.0, 48.0)
    .build()
    .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            screen.x + (position.0 * screen.scale).round() as i32,
            screen.y + (position.1 * screen.scale).round() as i32,
        ))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}

pub fn close(app: &AppHandle) {
    for label in ["capture-controls", "capture-overlay"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_stay_outside_capture() {
        let g = Geometry {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
        };
        assert_eq!(
            control_position(&g, (100.0, 200.0, 800.0, 500.0)),
            Some((100.0, 140.0))
        );
        assert_eq!(
            control_position(&g, (100.0, 0.0, 800.0, 500.0)),
            Some((100.0, 512.0))
        );
        assert!(control_position(&g, (0.0, 0.0, 1920.0, 1080.0)).is_none());
    }
}
