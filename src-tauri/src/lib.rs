mod capture;
mod capture_frames;
mod exporter;
mod ocr;
mod overlay;
mod stitching;

use tauri::Manager;

#[tauri::command]
fn app_health() -> &'static str {
    "ok"
}

#[tauri::command]
async fn set_compact_window(window: tauri::WebviewWindow, compact: bool) -> Result<(), String> {
    let (width, height) = if compact {
        (440.0, 560.0)
    } else {
        (960.0, 760.0)
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            app_health,
            set_compact_window,
            ocr::recognize_text,
            exporter::export_image,
            stitching::stitch_images,
            capture::open_capture_selection,
            capture::capture_info,
            capture::select_capture_region,
            capture::start_capture,
            capture::stop_capture
        ])
        .on_window_event(|window, event| {
            if (window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)))
                || matches!(event, tauri::WindowEvent::Destroyed)
            {
                let state = window.state::<capture::CaptureState>();
                capture::finish(
                    window.app_handle(),
                    &state,
                    None,
                    "采集已停止",
                    window.label() != "main",
                );
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run picsew desktop");
}
