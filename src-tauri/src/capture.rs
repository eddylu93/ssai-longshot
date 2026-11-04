use crate::capture_frames::{same_frame, StableFrameGate};
use crate::overlay::{self, Geometry};
use crate::stitching::{self, NativeResult, SessionStitcher};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use wayscrollshot_band::stitch::band::FrameStatus;
use xcap::{image::RgbaImage, Monitor};

#[derive(Default, Clone)]
pub struct CaptureState(Arc<Mutex<Session>>);

#[derive(Default)]
struct Session {
    id: u64,
    running: bool,
    info: Option<CaptureInfo>,
    geometry: Option<Geometry>,
    max_frames: usize,
    initial_images: Vec<String>,
    worker: bool,
    stop_message: String,
    restore: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    session_id: u64,
    width: u32,
    height: u32,
    phase: String,
    count: usize,
    region: Option<Region>,
    monitor_id: u32,
    hint: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    monitor_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    screen_width: u32,
    screen_height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CapturedFrame {
    session_id: u64,
    src: String,
    width: u32,
    height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stopped {
    session_id: u64,
    message: String,
    result: Option<NativeResult>,
}

fn check_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        // The OS owns the consent prompt; never substitute a black screenshot for success.
        if !unsafe { CGPreflightScreenCaptureAccess() }
            && !unsafe { CGRequestScreenCaptureAccess() }
        {
            return Err(
                "请在系统设置 > 隐私与安全性 > 屏幕与系统音频录制中允许本工具，然后重新打开工具"
                    .into(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn open_capture_selection(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CaptureState>,
    max_frames: usize,
    initial_images: Option<Vec<String>>,
) -> Result<u64, String> {
    if state.0.lock().unwrap().info.is_some() {
        return Err("请先停止采集".into());
    }
    check_permission()?;
    let initial_images = initial_images.unwrap_or_default();
    if initial_images.len() >= 60
        || initial_images.iter().map(String::len).sum::<usize>() > stitching::MAX_INPUT_BYTES
    {
        return Err("已达到本轮图片容量上限，请先导出或清空".into());
    }
    let display = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("未找到主显示器")?;
    let geometry = Geometry {
        x: display.position().x,
        y: display.position().y,
        width: display.size().width,
        height: display.size().height,
        scale: display.scale_factor(),
    };
    window.hide().map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(|| {
        thread::sleep(Duration::from_millis(350));
        let monitor = Monitor::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|monitor| monitor.is_primary().unwrap_or(false))
            .ok_or("未找到主显示器")?;
        let image = monitor.capture_image().map_err(|e| e.to_string())?;
        Ok(CaptureInfo {
            session_id: 0,
            phase: "select".into(),
            count: 0,
            region: None,
            monitor_id: monitor.id().map_err(|e| e.to_string())?,
            width: image.width(),
            height: image.height(),
            hint: None,
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    let info = match result {
        Ok(info) => info,
        Err(error) => {
            let _ = window.show();
            let _ = window.set_focus();
            return Err(error);
        }
    };
    let id = {
        let mut session = state.0.lock().unwrap();
        session.id += 1;
        let id = session.id;
        session.info = Some(CaptureInfo {
            session_id: id,
            ..info
        });
        session.geometry = Some(geometry.clone());
        session.max_frames = max_frames.clamp(1, 60 - initial_images.len());
        session.initial_images = initial_images;
        session.worker = false;
        session.stop_message.clear();
        session.restore = true;
        id
    };
    if let Err(error) = overlay::open_selector(&app, &geometry) {
        finish(&app, &state, Some(id), &error, true);
        return Err(error);
    }
    Ok(id)
}

#[tauri::command]
pub fn capture_info(state: State<'_, CaptureState>) -> Result<CaptureInfo, String> {
    state
        .0
        .lock()
        .unwrap()
        .info
        .clone()
        .ok_or("采集已结束".into())
}

#[derive(Deserialize)]
pub struct Selection {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn notify_ui(app: &AppHandle, info: &CaptureInfo) {
    for label in ["capture-overlay", "capture-controls"] {
        let _ = app.emit_to(label, "capture-ui", info.clone());
    }
}

fn capture_hint(app: &AppHandle, state: &CaptureState, id: u64, hint: Option<&str>) {
    let mut session = state.0.lock().unwrap();
    if session.id != id {
        return;
    }
    if let Some(info) = session.info.as_mut() {
        if info.hint.as_deref() != hint {
            info.hint = hint.map(str::to_owned);
            notify_ui(app, info);
        }
    }
}

#[tauri::command]
pub async fn select_capture_region(
    app: AppHandle,
    state: State<'_, CaptureState>,
    selection: Selection,
) -> Result<(), String> {
    let (info, geometry) = {
        let session = state.0.lock().unwrap();
        (
            session.info.clone().ok_or("采集已结束")?,
            session.geometry.clone().ok_or("缺少显示器信息")?,
        )
    };
    if info.phase != "select" {
        return Err("采集区域已锁定".into());
    }
    let region = Region {
        monitor_id: info.monitor_id,
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height,
        screen_width: info.width,
        screen_height: info.height,
    };
    validate_region(&region, info.width, info.height)?;
    let sx = geometry.width as f64 / geometry.scale / info.width as f64;
    let sy = geometry.height as f64 / geometry.scale / info.height as f64;
    let position = overlay::control_position(
        &geometry,
        (
            region.x as f64 * sx,
            region.y as f64 * sy,
            region.width as f64 * sx,
            region.height as f64 * sy,
        ),
    )
    .ok_or("请在框外留出停止按钮的位置，重新框选较小区域")?;
    {
        let mut session = state.0.lock().unwrap();
        let current = session.info.as_mut().ok_or("采集已结束")?;
        current.region = Some(region);
        current.phase = "ready".into();
    }
    if let Err(error) = overlay::open_controls(&app, &geometry, position) {
        finish(&app, &state, Some(info.session_id), &error, true);
        return Err(error);
    }
    if let Some(window) = app.get_webview_window("capture-overlay") {
        if let Err(error) = window.set_ignore_cursor_events(true) {
            let message = format!("无法启用鼠标透传：{error}");
            finish(&app, &state, Some(info.session_id), &message, true);
            return Err(message);
        }
    }
    if let Some(info) = state.0.lock().unwrap().info.clone() {
        notify_ui(&app, &info);
    }
    Ok(())
}

pub fn finish(
    app: &AppHandle,
    state: &CaptureState,
    expected: Option<u64>,
    message: &str,
    restore: bool,
) {
    let (id, worker) = {
        let mut session = state.0.lock().unwrap();
        if session.info.is_none() || expected.is_some_and(|id| id != session.id) {
            return;
        }
        session.running = false;
        if session
            .info
            .as_ref()
            .is_some_and(|info| info.phase == "stopping")
        {
            if !restore {
                session.restore = false;
            }
            return;
        }
        session.restore = restore;
        session.stop_message = message.into();
        if session.worker {
            if let Some(info) = session.info.as_mut() {
                info.phase = "stopping".into();
            }
        }
        (session.id, session.worker)
    };
    overlay::close(app);
    if !worker {
        complete(app, state, id, None);
    }
}

fn complete(app: &AppHandle, state: &CaptureState, id: u64, result: Option<NativeResult>) {
    let (message, restore) = {
        let mut session = state.0.lock().unwrap();
        if session.info.is_none() || session.id != id {
            return;
        }
        session.running = false;
        session.worker = false;
        session.info = None;
        session.geometry = None;
        session.initial_images.clear();
        (session.stop_message.clone(), session.restore)
    };
    overlay::close(app);
    let _ = app.emit_to(
        "main",
        "capture-stopped",
        Stopped {
            session_id: id,
            message,
            result,
        },
    );
    if restore {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn is_running(state: &CaptureState, id: u64) -> bool {
    let session = state.0.lock().unwrap();
    session.running && session.id == id
}

fn crop_stream_frame(frame: xcap::Frame, region: &Region) -> Result<RgbaImage, String> {
    let image =
        RgbaImage::from_raw(frame.width, frame.height, frame.raw).ok_or("录屏帧数据无效")?;
    if image.width() != region.screen_width || image.height() != region.screen_height {
        return Err("显示器分辨率已变化，请重新框选区域".into());
    }
    validate_region(region, image.width(), image.height())?;
    Ok(
        xcap::image::imageops::crop_imm(&image, region.x, region.y, region.width, region.height)
            .to_image(),
    )
}

// Keep draining the native zero-capacity channel even while matching/encoding.
// Only the newest unprocessed frame is retained; stopping cannot block a callback on send.
struct RecorderFeed {
    recorder: Option<xcap::VideoRecorder>,
    latest: Arc<Mutex<Option<xcap::Frame>>>,
    disconnected: Arc<AtomicBool>,
    quit: Arc<AtomicBool>,
    pump: Option<thread::JoinHandle<()>>,
}

impl RecorderFeed {
    fn start(monitor: &Monitor) -> Result<Self, String> {
        let (recorder, receiver) = monitor.video_recorder().map_err(|e| e.to_string())?;
        let latest = Arc::new(Mutex::new(None));
        let disconnected = Arc::new(AtomicBool::new(false));
        let quit = Arc::new(AtomicBool::new(false));
        let (slot, dead, done) = (latest.clone(), disconnected.clone(), quit.clone());
        let pump = thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(frame) => {
                        *slot.lock().unwrap() = Some(frame);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            dead.store(true, Ordering::Release);
        });
        let feed = Self {
            recorder: Some(recorder),
            latest,
            disconnected,
            quit,
            pump: Some(pump),
        };
        feed.recorder
            .as_ref()
            .unwrap()
            .start()
            .map_err(|e| e.to_string())?;
        Ok(feed)
    }
    fn take(&self) -> Option<xcap::Frame> {
        self.latest.lock().unwrap().take()
    }
}

impl Drop for RecorderFeed {
    fn drop(&mut self) {
        if let Some(recorder) = self.recorder.take() {
            let _ = recorder.stop();
            drop(recorder);
        }
        self.quit.store(true, Ordering::Release);
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}

fn validate_region(region: &Region, width: u32, height: u32) -> Result<(), String> {
    if region.width < 20
        || region.height < 20
        || region.x.saturating_add(region.width) > width
        || region.y.saturating_add(region.height) > height
        || u64::from(region.width) * u64::from(region.height) > 16_000_000
    {
        return Err("采集区域无效或过大，请重新框选".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_capture(app: AppHandle, state: State<'_, CaptureState>) -> Result<u64, String> {
    check_permission()?;
    let state = state.inner().clone();
    let (id, region, max_frames, initial_images) = {
        let mut session = state.0.lock().unwrap();
        if session.running || session.worker {
            return Err("采集正在进行".into());
        }
        let info = session.info.as_mut().ok_or("请先框选采集区域")?;
        let region = info.region.clone().ok_or("请先框选采集区域")?;
        info.phase = "recording".into();
        info.hint = Some("等待画面稳定".into());
        notify_ui(&app, info);
        session.running = true;
        session.worker = true;
        (
            session.id,
            region,
            session.max_frames,
            std::mem::take(&mut session.initial_images),
        )
    };
    let _ = app.emit_to("main", "capture-started", id);
    thread::spawn(move || {
        let mut engine = SessionStitcher::new();
        let mut count = 0;
        let mut bytes = initial_images.iter().map(String::len).sum::<usize>();
        let deadline = Instant::now() + Duration::from_secs(300);
        let run = (|| -> Result<(), String> {
            stitching::seed(&mut engine, &initial_images)?;
            if !is_running(&state, id) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
            let monitor = Monitor::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| m.id().ok() == Some(region.monitor_id))
                .ok_or("显示器已断开")?;
            let feed = RecorderFeed::start(&monitor)?;
            let first_deadline = Instant::now() + Duration::from_secs(8);
            let stream_started = Instant::now();
            let mut previous = None;
            let mut stable = StableFrameGate::default();
            let mut waiting = true;
            let mut unsettled_stop = false;
            let mut pending = None;
            let mut last_key = Instant::now();
            let mut last_height = engine.height();
            let mut saw_frame = false;
            let mut deliver = |image: &RgbaImage| -> Result<(), String> {
                let src = stitching::encode_png(image)?;
                bytes += src.len();
                if bytes > stitching::MAX_INPUT_BYTES {
                    return Err("已达到本轮图片容量上限".into());
                }
                let frame = CapturedFrame {
                    session_id: id,
                    src,
                    width: image.width(),
                    height: image.height(),
                };
                let mut session = state.0.lock().unwrap();
                if session.worker && session.id == id {
                    app.emit_to("main", "capture-frame", frame)
                        .map_err(|e| e.to_string())?;
                    count += 1;
                    if let Some(info) = session.info.as_mut() {
                        info.count = count;
                        notify_ui(&app, info);
                    }
                }
                Ok(())
            };
            let mut saved = 0;
            loop {
                let running = is_running(&state, id);
                if saved >= max_frames || Instant::now() >= deadline {
                    return Err("本轮采集已达到上限".into());
                }
                let incoming = feed
                    .take()
                    .map(|frame| {
                        saw_frame = true;
                        crop_stream_frame(frame, &region)
                    })
                    .transpose()?;
                let image = if waiting {
                    if let Some(image) = incoming {
                        if previous.as_ref().is_none_or(|old| !same_frame(old, &image)) {
                            stable.observe(image, stream_started.elapsed());
                        } else {
                            stable = StableFrameGate::default();
                        }
                    }
                    stable.take_ready(stream_started.elapsed())
                } else {
                    incoming
                };
                let Some(image) = image else {
                    if !running {
                        unsettled_stop = waiting;
                        break;
                    }
                    if feed.disconnected.load(Ordering::Acquire) {
                        return Err("录屏流已断开".into());
                    }
                    if !saw_frame && Instant::now() >= first_deadline {
                        return Err("未收到录屏画面，请检查系统录屏权限后重启工具".into());
                    }
                    if saved == 0 && Instant::now() >= first_deadline {
                        return Err("画面持续变化，尚未取得稳定截图".into());
                    }
                    thread::sleep(Duration::from_millis(10));
                    continue;
                };
                waiting = false;
                if previous.as_ref().is_some_and(|old| same_frame(old, &image)) {
                    if !running {
                        break;
                    }
                    continue;
                }
                let status = engine.push(&image)?;
                if status == FrameStatus::NoMatch {
                    waiting = true;
                    stable = StableFrameGate::default();
                    capture_hint(&app, &state, id, Some("接缝未确认，等待稳定"));
                } else {
                    capture_hint(&app, &state, id, None);
                }
                let should_save = saved == 0
                    || (status != FrameStatus::NoProgress
                        && (last_key.elapsed() >= Duration::from_millis(250)
                            || engine.height().abs_diff(last_height) >= region.height / 4));
                if should_save {
                    if status == FrameStatus::NoMatch {
                        if let Some(image) = pending.take() {
                            deliver(&image)?;
                            saved += 1;
                            if saved >= max_frames {
                                return Err("本轮采集已达到上限".into());
                            }
                        }
                    }
                    deliver(&image)?;
                    saved += 1;
                    last_key = Instant::now();
                    last_height = engine.height();
                    pending = None;
                } else if status == FrameStatus::Appended
                    || status == FrameStatus::FirstFrame
                    || (status == FrameStatus::NoMatch && pending.is_none())
                {
                    pending = Some(image.clone());
                }
                previous = Some(image);
                if !running {
                    break;
                }
            }
            if let Some(image) = pending {
                if saved < max_frames {
                    deliver(&image)?;
                }
            }
            if unsettled_stop {
                return Err("画面尚未稳定或接缝未恢复，未提交变化中的画面".into());
            }
            Ok(())
        })();
        if let Err(error) = &run {
            finish(&app, &state, Some(id), &format!("采集停止：{error}"), true);
        }
        let mut result = engine.result();
        if let (Ok(result), Err(error)) = (&mut result, &run) {
            result
                .issues
                .push(format!("采集提前停止：{error}，请检查末尾内容"));
        }
        if let Err(error) = &result {
            let mut session = state.0.lock().unwrap();
            session.stop_message =
                format!("采集未生成图片：{}", run.as_ref().err().unwrap_or(error));
        }
        complete(&app, &state, id, result.ok());
    });
    Ok(id)
}

#[tauri::command]
pub fn stop_capture(app: AppHandle, state: State<'_, CaptureState>) {
    finish(&app, &state, None, "采集已停止", true);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_frames_keep_original_crop_pixels_and_reject_resolution_changes() {
        let region = Region {
            monitor_id: 1,
            x: 7,
            y: 9,
            width: 20,
            height: 20,
            screen_width: 40,
            screen_height: 40,
        };
        let image = RgbaImage::from_fn(40, 40, |x, y| {
            xcap::image::Rgba([x as u8, y as u8, 10, 255])
        });
        let cropped =
            crop_stream_frame(xcap::Frame::new(40, 40, image.into_raw()), &region).unwrap();
        assert_eq!(cropped.get_pixel(0, 0).0, [7, 9, 10, 255]);
        assert_eq!(cropped.get_pixel(19, 19).0, [26, 28, 10, 255]);
        assert!(
            crop_stream_frame(xcap::Frame::new(41, 40, vec![0; 41 * 40 * 4]), &region).is_err()
        );
        assert!(crop_stream_frame(xcap::Frame::new(40, 40, vec![0; 3]), &region).is_err());
    }
    #[test]
    fn small_compositor_noise_does_not_create_a_new_frame() {
        let a = RgbaImage::from_pixel(20, 20, xcap::image::Rgba([120, 120, 120, 255]));
        let mut b = RgbaImage::from_pixel(20, 20, xcap::image::Rgba([122, 119, 121, 255]));
        assert!(same_frame(&a, &b));
        b.put_pixel(10, 10, xcap::image::Rgba([0, 0, 0, 255]));
        assert!(!same_frame(&a, &b));
    }
    #[test]
    fn region_is_validated_without_overflow() {
        let mut r = Region {
            monitor_id: 1,
            x: 0,
            y: 0,
            width: 300,
            height: 200,
            screen_width: 1920,
            screen_height: 1080,
        };
        assert!(validate_region(&r, 1920, 1080).is_ok());
        r.x = u32::MAX;
        assert!(validate_region(&r, 1920, 1080).is_err());
        r.x = 0;
        r.width = 1;
        assert!(validate_region(&r, 1920, 1080).is_err());
    }
}
