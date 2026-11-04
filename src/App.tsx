import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json";
import { interpolateStroke, planSegments, type Match, type Pixels } from "./stitching";
import ImageViewport from "./ImageViewport";
import Modal from "./Modal";
import EditPanel, { type EditorTab } from "./EditPanel";
import { exportDecision } from "./viewer";
import { boundedCrop, imagePoint, watermarkPlacement, watermarkTiles, type Rect, type Position, type RandomPoint, type WatermarkLayout, type WatermarkDensity } from "./editing";
import type { PrivacyBox, PrivacyOptions, TextBox } from "./privacy";
import {
  ScanLine, Check, ArrowDownToLine,
  Eraser,
  ImagePlus,
  Layers,
  MoveDown,
  MoveUp,
  RefreshCw,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  Maximize2, Minimize2, ShieldCheck, SlidersHorizontal, AlertTriangle, ChevronRight, Crop, Shuffle, Image as ImageIcon
} from "lucide-react";
import { ChangeEvent, PointerEvent, useCallback, useEffect, useRef, useState } from "react";

type FrameSource = "import" | "capture";

type Frame = {
  id: string;
  name: string;
  src: string;
  width: number;
  height: number;
  source: FrameSource;
  captureGroup?: string;
};

type StitchResult = {
  src: string;
  width: number;
  height: number;
  overlaps: Array<{ from: string; to: string; pixels: number; confidence: number }>;
  edges: { top: number; bottom: number };
  issues?: string[];
};
type NativeStitchResult = { src: string; width: number; height: number; issues: string[]; processed: number; rejected: number };
const nativeResult = (result: NativeStitchResult): StitchResult => ({ ...result, overlaps: [], edges: { top: 0, bottom: 0 } });

type WatermarkSettings = WatermarkLayout & {
  enabled: boolean;
  text: string;
  position: Position;
  opacity: number;
  fontSize: number;
  color: string;
};

type ImageWatermarkSettings = WatermarkLayout & { enabled: boolean; src: string; name: string; scale: number; opacity: number; position: Position };

type MosaicRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blockSize: number;
};

type MosaicBrush = {
  id: string;
  points: Point[];
  size: number;
  blockSize: number;
};

type Edit = { kind: "rect"; value: MosaicRect } | { kind: "brush"; value: MosaicBrush } | { kind: "batch"; value: MosaicRect[] } | { kind: "crop"; value: Rect };
type CapturedFrame = { sessionId: number; src: string; width: number; height: number };

type Point = {
  x: number;
  y: number;
};

type Tool = "none" | "rect" | "brush" | "crop";

type DraftRect = {
  start: Point;
  current: Point;
};


const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: "仅供内部使用",
  position: "bottom-right",
  mode: "tiled",
  density: "balanced",
  opacity: 0.18,
  fontSize: 32,
  color: "#111827",
  random: { x: 0.5, y: 0.5 }
};
const randomPoint = (): RandomPoint => ({ x: Math.random(), y: Math.random() });

const frameId = () => `frame_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const opId = () => `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function App() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [stitchResult, setStitchResult] = useState<StitchResult | null>(null);
  const [isStitching, setIsStitching] = useState(false);
  const [status, setStatus] = useState("");
  const [watermark, setWatermark] = useState<WatermarkSettings>(DEFAULT_WATERMARK);
  const [imageWatermark, setImageWatermark] = useState<ImageWatermarkSettings>({ enabled: false, src: "", name: "", scale: 0.2, opacity: 0.25, position: "bottom-right", mode: "tiled", density: "balanced", random: { x: 0.5, y: 0.5 } });
  const [edits, setEdits] = useState<Edit[]>([]);
  const mosaicRects = edits.flatMap((edit) => edit.kind === "batch" ? edit.value : edit.kind === "rect" ? [edit.value] : []);
  const mosaicBrushes = edits.filter((edit) => edit.kind === "brush");
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [overlapOverrides, setOverlapOverrides] = useState<Record<string, number>>({});
  const [seamsDirty, setSeamsDirty] = useState(false);
  const [manualStitch, setManualStitch] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [brushSize, setBrushSize] = useState(40);
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [activeBrush, setActiveBrush] = useState<Point[] | null>(null);
  const [pendingCrop, setPendingCrop] = useState<Rect | null>(null);
  const [exportFormat, setExportFormat] = useState<"png" | "jpeg">("png");
  const [small, setSmall] = useState(window.innerWidth < 860);
  const [drawer, setDrawer] = useState<"frames" | "settings" | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("privacy");
  const [preview, setPreview] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [privacyOptions, setPrivacyOptions] = useState<PrivacyOptions>({ time: true, names: true, avatars: true });

  const [captureActive, setCaptureActive] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [isSelecting, setIsSelecting] = useState(false);
  const [captureReady, setCaptureReady] = useState(false);
  const [autoStitchPending, setAutoStitchPending] = useState(false);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const watermarkImageRef = useRef<HTMLImageElement | null>(null);
  const watermarkInputRef = useRef<HTMLInputElement | null>(null);
  const editorButtonRef = useRef<HTMLButtonElement | null>(null);
  const framesRef = useRef<Frame[]>(frames);
  framesRef.current = frames;
  const [imageReady, setImageReady] = useState(0);
  const captureSessionRef = useRef<number | null>(null);
  const captureHadFramesRef = useRef(false);
  const draftRectRef = useRef<DraftRect | null>(null);
  const activeBrushRef = useRef<Point[] | null>(null);
  const busy = isStitching || isImporting || captureActive || isSelecting || isScanning || isExporting;
  const uncertainCount = (stitchResult?.overlaps.filter((item) => item.confidence === 0).length ?? 0) + (stitchResult?.issues?.length ?? 0);
  const crop = currentCrop(stitchResult, edits);
  const exportState = exportDecision(Boolean(stitchResult), busy || Boolean(pendingCrop), seamsDirty, uncertainCount);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 859px)");
    const update = () => setSmall(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);

  const toggleWindow = async () => {
    if (isResizing) return;
    setIsResizing(true);
    let timer: number | undefined;
    try {
      if (isTauri()) await Promise.race([
        invoke("set_compact_window", { compact: !small }),
        new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error("窗口调整超时，可拖动边框调整")), 3000); })
      ]);
      else setSmall(!small);
    } catch (error) { setStatus(`切换窗口失败：${formatError(error)}`); }
    finally { window.clearTimeout(timer); setIsResizing(false); }
  };

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingChange) setPendingChange(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pendingChange]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscriptions = [
      listen<number>("capture-started", ({ payload }) => {
        if (disposed || payload !== captureSessionRef.current) return;
        captureHadFramesRef.current = false;
        setCaptureActive(true); setIsSelecting(false); setCaptureCount(0);
        setStitchResult(null); setEdits([]); setPendingCrop(null); setSeamsDirty(false);
        setStatus("正在采集...");
      }),
      listen<CapturedFrame>("capture-frame", ({ payload }) => {
        if (disposed || payload.sessionId !== captureSessionRef.current) return;
        captureHadFramesRef.current = true;
        const frame: Frame = { id: frameId(), name: `采集帧 ${new Date().toLocaleTimeString()}`, src: payload.src, width: payload.width, height: payload.height, source: "capture", captureGroup: String(payload.sessionId) };
        framesRef.current = [...framesRef.current, frame];
        setFrames(framesRef.current);
        setCaptureCount((current) => current + 1);
        setStitchResult(null);
      }),
      listen<{ sessionId: number; message: string; result?: NativeStitchResult | null }>("capture-stopped", ({ payload }) => {
        if (disposed || payload.sessionId !== captureSessionRef.current) return;
        captureSessionRef.current = null;
        setCaptureActive(false);
        setIsSelecting(false);
        if (payload.result) {
          setStitchResult(nativeResult(payload.result));
          setManualStitch(false); setOverlapOverrides({}); setSeamsDirty(false); setTool("none");
          setStatus(payload.result.issues.length ? "部分画面未能识别，请检查结果" : `拼接完成 · ${payload.result.width} x ${payload.result.height}`);
        } else {
          setStatus(payload.message);
          if (captureHadFramesRef.current) setAutoStitchPending(true);
        }
        captureHadFramesRef.current = false;
      })
    ];
    void Promise.all(subscriptions).then(() => {
      if (!disposed) setCaptureReady(true);
    }).catch((error) => setStatus(`采集初始化失败：${formatError(error)}`));
    return () => {
      disposed = true;
      subscriptions.forEach((subscription) => { void subscription.then((stop) => stop()).catch(() => {}); });
      void invoke("stop_capture").catch(() => {});
    };
  }, []);

  const guardEdits = (action: () => void) => {
    if (edits.length > 0) setPendingChange(() => action);
    else action();
  };

  const dirtyPreview = useCallback(() => {
    setPreview(false);
    setTool("none");
    setStitchResult(null);
    setEdits([]);
    setDraftRect(null);
    setActiveBrush(null);
    setPendingCrop(null);
    setSeamsDirty(false);
    draftRectRef.current = null;
    activeBrushRef.current = null;
  }, []);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    guardEdits(() => { void importFiles(files); });
  };

  const importFiles = async (files: File[]) => {
    if (files.length + frames.length > 60) { setStatus("一次最多处理 60 张图片，请分批导出。"); return; }
    setIsImporting(true);
    setStatus("正在读取图片...");
    try {
      const imported = await Promise.all(files.map((file) => fileToFrame(file)));
      const next = [...framesRef.current, ...imported];
      setFrames(next);
      dirtyPreview();
      setDrawer(null);
      await stitchFrames(next);
    } catch (error) {
      setStatus(`导入失败：${formatError(error)}`);
    } finally {
      setIsImporting(false);
    }
  };

  const moveFrame = (id: string, direction: -1 | 1) => {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index + direction < 0 || index + direction >= frames.length) return;
    guardEdits(() => {
      setFrames((current) => {
        const index = current.findIndex((frame) => frame.id === id);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
        const next = [...current];
        const [frame] = next.splice(index, 1);
        next.splice(nextIndex, 0, frame);
        return next;
      });
      dirtyPreview();
    });
  };

  const removeFrame = (id: string) => {
    guardEdits(() => {
      const next = frames.filter((frame) => frame.id !== id);
      setFrames(next);
      dirtyPreview();
    });
  };

  const clearAll = () => {
    guardEdits(() => {
      setFrames([]);
      dirtyPreview();
      setOverlapOverrides({});
      setManualStitch(false);
      setCaptureCount(0);
      setStatus("已清空当前工作区。");
    });
  };

  const stitchFrames = async (input = frames, autoOrder = false, manual = manualStitch) => {
    if (input.length === 0) {
      setStatus("请先导入或采集图片。");
      return;
    }
    setIsStitching(true);
    setStatus("正在识别重叠区域并拼接...");
    try {
      const { result, orderedFrames } = isTauri() && !manual
        ? { result: nativeResult(await invoke<NativeStitchResult>("stitch_images", { images: input.map((frame) => frame.src) })), orderedFrames: input }
        : await createStitchResult(input, overlapOverrides, autoOrder);
      setFrames(orderedFrames);
      setStitchResult(result);
      setTool("none");
      setSeamsDirty(false);
      const uncertain = result.overlaps.filter((item) => item.confidence === 0).length + (result.issues?.length ?? 0);
      setStatus(uncertain ? "部分画面未能识别，请检查结果" : `拼接完成 · ${orderedFrames.length} 张`);
    } catch (error) {
      setStatus(`拼接失败：${formatError(error)}`);
    } finally {
      setIsStitching(false);
    }
  };

  useEffect(() => {
    if (!autoStitchPending || captureActive || isSelecting || isImporting || isStitching) return;
    setAutoStitchPending(false);
    if (framesRef.current.length) void stitchFrames(framesRef.current, true);
  }, [autoStitchPending, captureActive, isSelecting, isImporting, isStitching]);

  const requestStitch = () => {
    if (busy) return;
    guardEdits(() => { setPreview(false); setDrawer(null); setEdits([]); setPendingCrop(null); void stitchFrames(); });
  };

  const scanPrivacy = async () => {
    if (!stitchResult || busy || seamsDirty) return;
    if (!isTauri()) { setStatus("离线隐私识别需使用桌面应用。"); return; }
    setIsScanning(true); setTool("none"); setPendingCrop(null); setStatus("正在本机识别隐私区域...");
    try {
      const lines = privacyOptions.time || privacyOptions.names ? await invoke<TextBox[]>("recognize_text", { image: stitchResult.src }) : [];
      const image = await loadImage(stitchResult.src);
      const canvas = normalizeImage(image, stitchResult.width);
      const pixels = get2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
      const detected = await new Promise<PrivacyBox[]>((resolve, reject) => {
        const worker = new Worker(new URL("./privacy.worker.ts", import.meta.url), { type: "module" });
        const timer = window.setTimeout(() => { worker.terminate(); reject(new Error("隐私定位超时，请分批处理。")); }, 45000);
        worker.onmessage = ({ data }) => { window.clearTimeout(timer); worker.terminate(); if (data.error) reject(new Error(data.error)); else resolve(data.boxes); };
        worker.onerror = () => { window.clearTimeout(timer); worker.terminate(); reject(new Error("隐私定位失败")); };
        worker.postMessage({ image: { width: pixels.width, height: pixels.height, data: pixels.data }, lines, options: privacyOptions }, [pixels.data.buffer]);
      });
      const boxes = detected.filter((box) => box.x < crop.x + crop.width && box.x + box.width > crop.x && box.y < crop.y + crop.height && box.y + box.height > crop.y);
      if (boxes.length) setEdits((current) => [...current, { kind: "batch", value: boxes.map((box) => ({ ...box, id: opId(), blockSize: 20 })) }]);
      setStatus(boxes.length ? `已打码 ${boxes.length} 处（时间 ${boxes.filter((b) => b.category === "time").length} / 昵称 ${boxes.filter((b) => b.category === "names").length} / 头像 ${boxes.filter((b) => b.category === "avatars").length}）。请预览检查，可能存在漏识别。` : "未识别到可靠的隐私区域，请手动打码。");
    } catch (error) { setStatus(`隐私识别失败：${formatError(error)}；已有打码保留。`); }
    finally { setIsScanning(false); }
  };

  const importWatermark = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setIsImporting(true);
    try {
      if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的 PNG/JPEG 图片。");
      const src = await readFileAsDataUrl(file), image = await loadImage(src);
      if (image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error("水印图片过大，请缩小后导入。");
      watermarkImageRef.current = image;
      setImageWatermark((current) => ({ ...current, enabled: true, src, name: file.name }));
      setStatus("图片水印已添加");
    } catch (error) { setStatus(`水印导入失败：${formatError(error)}`); }
    finally { setIsImporting(false); }
  };

  const startScreenShare = async () => {
    if (!isTauri()) {
      setStatus("区域采集需使用桌面应用；浏览器中可导入图片。");
      return;
    }
    if (frames.length >= 60) { setStatus("已达到 60 张图片上限，请先导出。"); return; }
    setIsSelecting(true);
    try {
      captureSessionRef.current = await invoke<number>("open_capture_selection", { maxFrames: 60 - frames.length, initialImages: framesRef.current.map((frame) => frame.src) });
    } catch (error) {
      setStatus(`屏幕采集启动失败：${formatError(error)}`);
      setIsSelecting(false);
    }
  };

  const stopCaptureTimer = async () => {
    try { await invoke("stop_capture"); }
    catch (error) { setStatus(`停止失败：${formatError(error)}`); }
  };


  const handlePreviewPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!stitchResult || seamsDirty || busy || pendingCrop || tool === "none" || preview) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const local = canvasPoint(event), point = { x: local.x + crop.x, y: local.y + crop.y };
    if (tool === "rect" || tool === "crop") {
      draftRectRef.current = { start: point, current: point };
      setDraftRect(draftRectRef.current);
    }
    if (tool === "brush") {
      activeBrushRef.current = [point];
      setActiveBrush([point]);
    }
  };

  const handlePreviewPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!stitchResult || seamsDirty || busy || preview) return;
    const local = canvasPoint(event), point = { x: local.x + crop.x, y: local.y + crop.y };
    if (draftRectRef.current) {
      draftRectRef.current = { ...draftRectRef.current, current: point };
      setDraftRect(draftRectRef.current);
    }
    if (activeBrushRef.current) {
      activeBrushRef.current = [...activeBrushRef.current, point];
      setActiveBrush(activeBrushRef.current);
    }
  };

  const commitPreviewOperation = () => {
    const draftRect = draftRectRef.current;
    const activeBrush = activeBrushRef.current;
    if (draftRect) {
      const rect = normalizedRect(draftRect.start, draftRect.current);
      if (rect.width > 8 && rect.height > 8) {
        if (tool === "crop") setPendingCrop(boundedCrop(rect, crop));
        else setEdits((current) => [
          ...current,
          {
            kind: "rect",
            value: {
              id: opId(),
              ...rect,
              blockSize: 14
            }
          }
        ]);
      }
      setDraftRect(null);
    }
    if (activeBrush) {
      if (activeBrush.length > 0) {
        setEdits((current) => [
          ...current,
          {
            kind: "brush",
            value: {
              id: opId(),
              points: activeBrush,
              size: brushSize,
              blockSize: 14
            }
          }
        ]);
      }
      setActiveBrush(null);
    }
    draftRectRef.current = null;
    activeBrushRef.current = null;
  };

  const undoEdit = () => {
    if (pendingCrop) { setPendingCrop(null); return; }
    setEdits((current) => current.slice(0, -1));
  };

  const exportImage = async (confirmed = false) => {
    if (exportState === "blocked") return;
    if (exportState === "confirm" && !confirmed) { setConfirmExport(true); return; }
    if (!stitchResult) {
      setStatus("请先生成拼接预览。");
      return;
    }
    setIsExporting(true);
    try {
      const canvas = await renderFinalCanvas(stitchResult, watermark, imageWatermark, edits);
      const mime = exportFormat === "png" ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(canvas, mime, exportFormat === "jpeg" ? 0.92 : undefined);
      if (isTauri()) {
        await invoke<string>("export_image", { image: await readFileAsDataUrl(blob), format: exportFormat });
        setStatus(`已保存 ${exportFormat.toUpperCase()} 至下载文件夹。`);
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `long-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${exportFormat}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus(`已导出 ${exportFormat.toUpperCase()}。`);
    } catch (error) {
      setStatus(`导出失败：${formatError(error)}`);
    } finally {
      setIsExporting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    baseImageRef.current = null;
    if (stitchResult) {
      void loadImage(stitchResult.src).then((image) => {
        if (!cancelled) { baseImageRef.current = image; setImageReady((value) => value + 1); }
      }).catch((error) => setStatus(`预览失败：${formatError(error)}`));
    }
    return () => { cancelled = true; };
  }, [stitchResult]);

  useEffect(() => {
    const render = async () => {
      const canvas = previewCanvasRef.current;
      const image = baseImageRef.current;
      if (!canvas || !stitchResult || !image) return;
      if (canvas.width !== crop.width) canvas.width = crop.width;
      if (canvas.height !== crop.height) canvas.height = crop.height;
      const ctx = get2d(canvas);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, -crop.x, -crop.y);
      applyEdits(ctx, edits, crop);
      if (activeBrush) {
        applyMosaicBrushes(ctx, [{ id: "active", points: activeBrush.map((p) => ({ x: p.x - crop.x, y: p.y - crop.y })), size: brushSize, blockSize: 14 }]);
      }
      applyWatermark(ctx, watermark);
      applyImageWatermark(ctx, imageWatermark, watermarkImageRef.current);
      if (draftRect || pendingCrop) {
        const absolute = pendingCrop ?? normalizedRect(draftRect!.start, draftRect!.current);
        const rect = { ...absolute, x: absolute.x - crop.x, y: absolute.y - crop.y };
        ctx.save();
        ctx.strokeStyle = "#22c55e";
        const scale = canvas.getBoundingClientRect().width / canvas.width || 1;
        ctx.lineWidth = Math.max(2, 2 / scale);
        ctx.setLineDash([10 / scale, 6 / scale]);
        if (tool === "crop") {
          ctx.fillStyle = "#00000066";
          ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.fill("evenodd");
        }
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      }
    };
    const request = window.requestAnimationFrame(() => { void render(); });
    return () => {
      window.cancelAnimationFrame(request);
    };
  }, [stitchResult, imageReady, watermark, imageWatermark, edits, draftRect, pendingCrop, activeBrush, brushSize]);

  return (
    <main className={`app ${drawer === "settings" && !preview ? "has-editor" : ""}`}>
      <header className="app-header" aria-hidden={preview || undefined}>
        <div className="app-brand"><ScanLine size={20} strokeWidth={1.8} /><div className="brand-text">
          <h1>SSAI 长截图工具</h1>
          <div className="brand-meta"><span className="app-version">v.{version}</span>{frames.length > 0 && <span className="frame-count">{frames.length} 张</span>}</div>
        </div></div>
        <div className="header-actions">
          <input ref={importInputRef} hidden type="file" accept="image/png,image/jpeg" multiple onChange={handleImport} disabled={busy} />
          <button className="tool-button" title="导入图片" aria-label="导入图片" onClick={() => importInputRef.current?.click()} disabled={busy}><ImagePlus size={18} /></button>
          <button className={`tool-button capture-button ${captureActive ? "recording" : ""}`} title={captureActive ? "停止采集" : "区域采集"} aria-label={captureActive ? "停止采集" : "区域采集"} disabled={!captureActive && (busy || (isTauri() && !captureReady))} onClick={() => captureActive ? void stopCaptureTimer() : guardEdits(() => { void startScreenShare(); })}>{captureActive ? <Square size={18} /> : <ScanLine size={20} />}</button>
          <button className="tool-button" title={small ? "展开窗口" : "小窗口"} aria-label={small ? "展开窗口" : "小窗口"} onClick={() => void toggleWindow()} disabled={isResizing || captureActive || isSelecting}>{small ? <Maximize2 size={16} /> : <Minimize2 size={16} />}</button>
        </div>
      </header>

      <section className="canvas-workspace" aria-busy={busy}>
        {(seamsDirty || uncertainCount > 0) && <button className="seam-notice" onClick={() => setDrawer("frames")} aria-label="检查接缝">
          <AlertTriangle size={14} /><span>{seamsDirty ? "重叠已调整，待重算" : stitchResult?.issues?.length ? "部分画面待检查" : `${uncertainCount} 处接缝待确认`}</span><ChevronRight size={14} />
        </button>}
        {stitchResult ? <ImageViewport width={crop.width} height={crop.height} expanded={preview} onExpandedChange={setPreview} interactive={tool === "none" && !busy}>
          <canvas ref={previewCanvasRef} className={`result-canvas tool-${tool}`}
            role={tool === "none" ? "button" : "img"} tabIndex={tool === "none" ? 0 : -1} aria-label="预览拼接图片"
            onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && tool === "none" && !busy) { e.preventDefault(); setPreview(!preview); } }}
            onPointerDown={handlePreviewPointerDown} onPointerMove={handlePreviewPointerMove} onPointerUp={commitPreviewOperation}
            onPointerCancel={() => { draftRectRef.current = null; activeBrushRef.current = null; setDraftRect(null); setActiveBrush(null); }} />
        </ImageViewport> : <div className="empty-canvas"><ImagePlus size={28} strokeWidth={1.25} /><span>{isStitching ? "正在拼接" : "暂无截图"}</span></div>}
        {tool !== "none" && !preview && <div className="tool-indicator"><span>{tool === "crop" ? "裁剪" : tool === "rect" ? "矩形打码" : "涂抹打码"}</span>
          {pendingCrop && <button className="tool-button active" title="应用裁剪" aria-label="应用裁剪" disabled={busy} onClick={() => { setEdits((current) => [...current, { kind: "crop", value: pendingCrop }]); setPendingCrop(null); setTool("none"); }}><Check size={18} /></button>}
          <button className="tool-button" title="结束编辑" aria-label="结束编辑" onClick={() => { setTool("none"); setPendingCrop(null); }}><X size={14} /></button></div>}
      </section>

      <div className="statusline" aria-hidden={preview || undefined}>
        <span role="status" title={status}>{status}</span>
        {stitchResult && <span className="image-size">{crop.width} x {crop.height}</span>}
      </div>
      <nav className="command-bar" aria-label="截图工具" aria-hidden={preview || undefined}>
        <div className="tool-group" role="group" aria-label="图像处理">
          <button className={`tool-button ${isStitching ? "working" : ""}`} title={stitchResult ? "重算" : "拼接"} aria-label={stitchResult ? "重算" : "拼接"} onClick={requestStitch} disabled={!frames.length || busy}>{stitchResult ? <RefreshCw size={20} /> : <Layers size={20} />}</button>
          <button className={`tool-button privacy-button ${isScanning ? "working" : ""}`} title="一键隐私打码" aria-label="一键打码" onClick={() => void scanPrivacy()} disabled={!stitchResult || seamsDirty || busy || !Object.values(privacyOptions).some(Boolean)}><ShieldCheck size={20} /></button>
          <button className="tool-button" title="撤销编辑" aria-label="撤销" disabled={!edits.length || busy} onClick={undoEdit}><Undo2 size={20} /></button>
        </div>
        <span className="bar-spacer" />
        <button className={`tool-button ${drawer === "frames" ? "active" : ""}`} title="输入与接缝" aria-label="输入与接缝" onClick={() => setDrawer("frames")}><Layers size={18} /></button>
        <button ref={editorButtonRef} className={`tool-button ${drawer === "settings" ? "active" : ""}`} title="编辑设置" aria-label="编辑设置" aria-expanded={drawer === "settings"} aria-controls="edit-panel" onClick={() => setDrawer((current) => current === "settings" ? null : "settings")}><SlidersHorizontal size={18} /></button>
        <button className="action-button primary export-button" title={seamsDirty ? "重算后导出" : "导出长图"} aria-label="导出长图" disabled={exportState === "blocked"} onClick={() => void exportImage()}><ArrowDownToLine size={18} /><span>{isExporting ? "保存中" : "导出"}</span></button>
      </nav>

      <footer className="author-footer" aria-label="作者信息" aria-hidden={preview || undefined}>
        <span>欢迎使用SSAI 工具系列</span>
        <span>微信：sanshengya88</span>
      </footer>

      {drawer === "frames" && <Modal title="输入与接缝" drawer close={() => setDrawer(null)}>
        <div className="section-heading"><span>{frames.length} 张图片</span><button className="text-button danger" disabled={!frames.length || busy} onClick={clearAll}>清空全部</button></div>
        {!frames.length && <p className="muted">暂无输入</p>}
        {stitchResult?.issues?.map((issue, index) => <p className="muted" key={index}>{issue}</p>)}
        {isTauri() && frames.length > 1 && <button className="text-button" disabled={busy} onClick={() => guardEdits(() => {
          const manual = !manualStitch;
          setManualStitch(manual); setEdits([]); setPendingCrop(null); setPreview(false);
          void stitchFrames(framesRef.current, false, manual);
        })}>{manualStitch ? "自动识别" : "手动接缝"}</button>}
        <div className="frame-list">{frames.map((frame, index) => <div className="frame-row" key={frame.id}>
          <img src={frame.src} alt={frame.name} loading="lazy" decoding="async" />
          <div className="frame-name"><strong>{index + 1}. {frame.name}</strong><span>{frame.width} x {frame.height}</span></div>
          <div className="row-actions">
            <button className="tool-button" aria-label={`上移第 ${index + 1} 张`} title="上移" disabled={busy || index === 0} onClick={() => moveFrame(frame.id, -1)}><MoveUp size={14} /></button>
            <button className="tool-button" aria-label={`下移第 ${index + 1} 张`} title="下移" disabled={busy || index === frames.length - 1} onClick={() => moveFrame(frame.id, 1)}><MoveDown size={14} /></button>
            <button className="tool-button" aria-label={`删除第 ${index + 1} 张`} title="删除" disabled={busy} onClick={() => removeFrame(frame.id)}><Trash2 size={14} /></button>
          </div>
        </div>)}</div>
        {stitchResult && stitchResult.overlaps.length > 0 && <section className="settings-section seams">
          <h3>重叠像素</h3>
          {stitchResult.overlaps.map((overlap, index) => {
            const max = Math.max(0, Math.min(frames[index].height, frames[index + 1].height) - stitchResult.edges.top - stitchResult.edges.bottom);
            return <label className="seam-row" key={`${overlap.from}:${overlap.to}`}>
              <span>第 {index + 1} / {index + 2} 张 {!overlap.confidence && <em>待确认</em>}</span>
              <input type="number" aria-label={`第 ${index + 1} 处重叠像素`} min={0} max={max} value={overlapOverrides[`${overlap.from}:${overlap.to}`] ?? overlap.pixels} disabled={busy} onChange={(event) => {
                const value = Math.max(0, Math.min(max, Number(event.target.value)));
                guardEdits(() => { setEdits([]); setOverlapOverrides((current) => ({ ...current, [`${overlap.from}:${overlap.to}`]: value })); setSeamsDirty(true); setStatus("重叠已调整，待重算"); });
              }} />
            </label>;
          })}
          <button className="action-button" onClick={requestStitch} disabled={busy}><RefreshCw size={16} />重算</button>
        </section>}
      </Modal>}

      {drawer === "settings" && <EditPanel tab={editorTab} hidden={preview} close={() => { setDrawer(null); editorButtonRef.current?.focus(); }} changeTab={(next) => {
        if (next === editorTab) return;
        setEditorTab(next); setTool("none"); setPendingCrop(null); setDraftRect(null); setActiveBrush(null);
        draftRectRef.current = null; activeBrushRef.current = null;
      }}>
        {editorTab === "crop" && <section className="settings-section"><h3><Crop size={15} />裁剪</h3>
          <div className="inline-actions"><button className={`action-button ${tool === "crop" ? "active" : ""}`} aria-pressed={tool === "crop"} disabled={!stitchResult || busy || seamsDirty} onClick={() => { setPendingCrop(null); setTool("crop"); setPreview(false); }}><Crop size={16} />框选裁剪</button></div>
        </section>}
        {editorTab === "privacy" && <><section className="settings-section manual-tools">
          <div className="inline-actions">
            <button className={`action-button ${tool === "rect" ? "active" : ""}`} aria-pressed={tool === "rect"} onClick={() => { setPendingCrop(null); setTool(tool === "rect" ? "none" : "rect"); }} disabled={!stitchResult || busy || seamsDirty}><Square size={16} />矩形</button>
            <button className={`action-button ${tool === "brush" ? "active" : ""}`} aria-pressed={tool === "brush"} onClick={() => { setPendingCrop(null); setTool(tool === "brush" ? "none" : "brush"); }} disabled={!stitchResult || busy || seamsDirty}><Eraser size={16} />涂抹</button>
            <button className="tool-button privacy-button" title="一键隐私打码" aria-label="一键打码" onClick={() => void scanPrivacy()} disabled={!stitchResult || seamsDirty || busy || !Object.values(privacyOptions).some(Boolean)}><ShieldCheck size={20} /></button>
          </div>
          {tool === "brush" && <label className="range-field"><span>笔刷大小 <output>{brushSize}</output></span><input aria-label="笔刷大小" type="range" min={12} max={120} value={brushSize} disabled={busy} onChange={(e) => setBrushSize(Number(e.target.value))} /></label>}
          <p className="muted">{mosaicRects.length} 个矩形 · {mosaicBrushes.length} 条涂抹</p>
        </section>
        <section className="settings-section"><h3><ShieldCheck size={15} />自动打码</h3>
          <div className="check-options">{([["time", "时间"], ["names", "用户昵称"], ["avatars", "用户头像"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={privacyOptions[key]} disabled={busy} onChange={(e) => setPrivacyOptions({ ...privacyOptions, [key]: e.target.checked })} />{label}</label>)}</div>
        </section></>}
        {editorTab === "watermark" && <><section className="settings-section"><h3><Type size={15} />文字水印</h3>
          <label className="check-option"><input type="checkbox" checked={watermark.enabled} disabled={busy} onChange={(e) => setWatermark({ ...watermark, enabled: e.target.checked })} />启用水印</label>
          {watermark.enabled && <>
            <input className="text-input" aria-label="水印文字" value={watermark.text} disabled={busy} onChange={(e) => setWatermark({ ...watermark, text: e.target.value })} />
            <WatermarkLayoutPicker label="文字水印" layout={watermark} disabled={busy} change={(next) => setWatermark({ ...watermark, ...next })} />
            {watermark.mode === "single" && <PositionPicker label="文字水印" position={watermark.position} disabled={busy} change={(position) => setWatermark({ ...watermark, position, random: position === "random" ? randomPoint() : watermark.random })} shuffle={() => setWatermark({ ...watermark, random: randomPoint() })} />}
            <label className="select-field"><span>颜色</span><input aria-label="文字水印颜色" type="color" value={watermark.color} disabled={busy} onChange={(e) => setWatermark({ ...watermark, color: e.target.value })} /></label>
            <label className="range-field"><span>字号 <output>{watermark.fontSize}</output></span><input type="range" min={16} max={96} value={watermark.fontSize} disabled={busy} onChange={(e) => setWatermark({ ...watermark, fontSize: Number(e.target.value) })} /></label>
            <label className="range-field"><span>透明度 <output>{Math.round(watermark.opacity * 100)}%</output></span><input type="range" min={0.05} max={0.9} step={0.01} value={watermark.opacity} disabled={busy} onChange={(e) => setWatermark({ ...watermark, opacity: Number(e.target.value) })} /></label>
          </>}
        </section>
        <section className="settings-section"><h3><ImageIcon size={15} />图片水印</h3>
          <input ref={watermarkInputRef} hidden type="file" accept="image/png,image/jpeg" onChange={importWatermark} disabled={busy} />
          <div className="inline-actions"><button className="action-button" disabled={busy} onClick={() => watermarkInputRef.current?.click()}><ImagePlus size={16} />{imageWatermark.src ? "更换图片" : "选择图片"}</button>
            {imageWatermark.src && <button className="tool-button" title="移除图片水印" aria-label="移除图片水印" disabled={busy} onClick={() => { watermarkImageRef.current = null; setImageWatermark({ ...imageWatermark, enabled: false, src: "", name: "" }); }}><Trash2 size={16} /></button>}
          </div>
          {imageWatermark.src && <>
            <div className="watermark-file"><img src={imageWatermark.src} alt="水印图片" /><span title={imageWatermark.name}>{imageWatermark.name}</span><input type="checkbox" aria-label="启用图片水印" checked={imageWatermark.enabled} disabled={busy} onChange={(e) => setImageWatermark({ ...imageWatermark, enabled: e.target.checked })} /></div>
            <WatermarkLayoutPicker label="图片水印" layout={imageWatermark} disabled={busy} change={(next) => setImageWatermark({ ...imageWatermark, ...next })} />
            {imageWatermark.mode === "single" && <PositionPicker label="图片水印" position={imageWatermark.position} disabled={busy} change={(position) => setImageWatermark({ ...imageWatermark, position, random: position === "random" ? randomPoint() : imageWatermark.random })} shuffle={() => setImageWatermark({ ...imageWatermark, random: randomPoint() })} />}
            <label className="range-field"><span>宽度 <output>{Math.round(imageWatermark.scale * 100)}%</output></span><input aria-label="图片水印宽度" type="range" min={0.05} max={0.8} step={0.01} value={imageWatermark.scale} disabled={busy} onChange={(e) => setImageWatermark({ ...imageWatermark, scale: Number(e.target.value) })} /></label>
            <label className="range-field"><span>透明度 <output>{Math.round(imageWatermark.opacity * 100)}%</output></span><input aria-label="图片水印透明度" type="range" min={0.05} max={1} step={0.05} value={imageWatermark.opacity} disabled={busy} onChange={(e) => setImageWatermark({ ...imageWatermark, opacity: Number(e.target.value) })} /></label>
          </>}
        </section></>}
        {editorTab === "export" && <section className="settings-section"><h3><ArrowDownToLine size={15} />导出格式</h3>
          <div className="segmented">{(["png", "jpeg"] as const).map((format) => <button className={exportFormat === format ? "selected" : ""} aria-pressed={exportFormat === format} disabled={busy} key={format} onClick={() => setExportFormat(format)}>{format.toUpperCase()}</button>)}</div>
        </section>}
      </EditPanel>}

      {pendingChange && <Modal title="清除当前编辑？" close={() => setPendingChange(null)}>
        <p>重算或更改输入会清除当前打码和裁剪。已导出的图片不受影响。</p>
        <div className="dialog-actions"><button className="action-button" onClick={() => setPendingChange(null)}>取消</button><button className="action-button primary" onClick={() => { const action = pendingChange; setPendingChange(null); action(); }}>清除并继续</button></div>
      </Modal>}
      {confirmExport && <Modal title="确认导出当前结果" close={() => setConfirmExport(false)}>
        <p>存在尚未确认的接缝或未识别画面，图片可能存在重复或缺失。</p><p>将保存当前结果，已有打码和水印保持不变。</p>
        <div className="dialog-actions"><button className="action-button" onClick={() => setConfirmExport(false)}>返回检查</button><button className="action-button primary" onClick={() => { setConfirmExport(false); void exportImage(true); }}>仍然导出</button></div>
      </Modal>}
    </main>
  );
}

function WatermarkLayoutPicker({ label, layout, disabled, change }: { label: string; layout: WatermarkLayout; disabled: boolean; change: (next: Partial<WatermarkLayout>) => void }) {
  return <>
    <div className="segmented" role="group" aria-label={`${label}布局`}>
      {([["single", "单个"], ["tiled", "随机铺满"]] as const).map(([mode, text]) => <button key={mode} className={layout.mode === mode ? "selected" : ""} aria-pressed={layout.mode === mode} disabled={disabled} onClick={() => change({ mode })}>{text}</button>)}
    </div>
    {layout.mode === "tiled" && <div className="select-field"><label htmlFor={`${label}-density`}>疏密</label><div className="position-picker">
      <select id={`${label}-density`} aria-label={`${label}疏密`} value={layout.density} disabled={disabled} onChange={(e) => change({ density: e.target.value as WatermarkDensity })}><option value="sparse">疏</option><option value="balanced">适中</option><option value="dense">密</option></select>
      <button className="tool-button" title="重新排列" aria-label={`${label}重新排列`} disabled={disabled} onClick={() => change({ random: randomPoint() })}><Shuffle size={18} /></button>
    </div></div>}
  </>;
}

function PositionPicker({ label, position, disabled, change, shuffle }: { label: string; position: Position; disabled: boolean; change: (value: Position) => void; shuffle: () => void }) {
  return <div className="select-field"><label htmlFor={`${label}-position`}>位置</label><div className="position-picker">
    <select id={`${label}-position`} aria-label={`${label}位置`} value={position} disabled={disabled} onChange={(e) => change(e.target.value as Position)}>
      <option value="bottom-right">右下</option><option value="bottom-left">左下</option><option value="top-right">右上</option><option value="top-left">左上</option><option value="center">居中</option><option value="random">随机</option>
    </select>
    {position === "random" && <button className="tool-button" title="换个位置" aria-label={`${label}换个位置`} disabled={disabled} onClick={shuffle}><Shuffle size={16} /></button>}
  </div></div>;
}

function currentCrop(result: StitchResult | null, edits: Edit[]): Rect {
  const last = [...edits].reverse().find((edit) => edit.kind === "crop");
  return last?.kind === "crop" ? last.value : { x: 0, y: 0, width: result?.width ?? 1, height: result?.height ?? 1 };
}

async function fileToFrame(file: File): Promise<Frame> {
  const src = await readFileAsDataUrl(file);
  const image = await loadImage(src);
  return {
    id: frameId(),
    name: file.name,
    src,
    width: image.naturalWidth,
    height: image.naturalHeight,
    source: "import"
  };
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

async function createStitchResult(input: Frame[], overrides: Record<string, number> = {}, autoOrder = false): Promise<{ result: StitchResult; orderedFrames: Frame[] }> {
  let frames = input;
  const images = await Promise.all(frames.map((frame) => loadImage(frame.src)));
  const targetWidth = images[0].naturalWidth;
  if (images.some((image) => image.naturalWidth !== targetWidth)) throw new Error("截图宽度不同，请重新截取同宽区域；不会自动拉伸图片。");
  if (targetWidth > 16384) throw new Error("图片过宽，请缩小后导入。");
  let normalized = images.map((image) => normalizeImage(image, targetWidth));
  const analysis = await analyzeInWorker(normalized.map((canvas) => get2d(canvas).getImageData(0, 0, canvas.width, canvas.height)), autoOrder ? frames.map((frame) => frame.captureGroup ?? null) : undefined);
  frames = analysis.order.map((index) => frames[index]);
  normalized = analysis.order.map((index) => normalized[index]);
  const overlaps: StitchResult["overlaps"] = [];
  let totalHeight = normalized[0].height;

  for (let index = 1; index < normalized.length; index += 1) {
    const key = `${frames[index - 1].id}:${frames[index].id}`;
    const override = overrides[key];
    const overlap = override === undefined ? analysis.matches[index - 1] : {
      pixels: Math.max(0, Math.min(normalized[index - 1].height, normalized[index].height - analysis.edges.top - analysis.edges.bottom, override)), confidence: 1
    };
    overlaps.push({
      from: frames[index - 1].id,
      to: frames[index].id,
      pixels: overlap.pixels,
      confidence: overlap.confidence
    });
    totalHeight += normalized[index].height - overlap.pixels;
  }

  const segments = planSegments(normalized.map((image) => image.height), overlaps.map((overlap) => overlap.pixels), analysis.edges);
  totalHeight = segments.reduce((sum, segment) => sum + segment.height, 0);
  if (totalHeight > 32760 || targetWidth * totalHeight > 32_000_000) {
    throw new Error("长图过大，请减少图片后分批导出。");
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = Math.max(1, totalHeight);
  const ctx = get2d(canvas);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < normalized.length; index += 1) {
    const segment = segments[index];
    const image = normalized[index];
    if (segment.height > 0) ctx.drawImage(image, 0, segment.crop, image.width, segment.height, 0, segment.y, image.width, segment.height);
  }

  return { orderedFrames: frames, result: {
    src: await readFileAsDataUrl(await canvasToBlob(canvas, "image/png")),
    width: canvas.width,
    height: canvas.height,
    overlaps,
    edges: analysis.edges
  } };
}

function normalizeImage(image: HTMLImageElement, targetWidth: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const scale = targetWidth / image.naturalWidth;
  canvas.width = targetWidth;
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  if (canvas.height > 32760 || canvas.width * canvas.height > 32_000_000) throw new Error("单张图片过大，请缩小后导入。");
  const ctx = get2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function analyzeInWorker(images: ImageData[], groups?: Array<string | null>): Promise<{ edges: { top: number; bottom: number }; matches: Match[]; order: number[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./stitch.worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => { worker.terminate(); reject(new Error("像素校验超时，请减少图片后重试。")); }, groups ? 90000 : 30000);
    worker.onmessage = ({ data }) => { window.clearTimeout(timer); worker.terminate(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
    worker.onerror = () => { window.clearTimeout(timer); worker.terminate(); reject(new Error("像素校验失败，请重试。")); };
    const raw: Pixels[] = images.map(({ width, height, data }) => ({ width, height, data }));
    worker.postMessage({ images: raw, groups }, images.map((image) => image.data.buffer));
  });
}

async function renderFinalCanvas(
  stitchResult: StitchResult,
  watermark: WatermarkSettings,
  imageWatermark: ImageWatermarkSettings,
  edits: Edit[]
): Promise<HTMLCanvasElement> {
  const image = await loadImage(stitchResult.src);
  const canvas = document.createElement("canvas");
  const crop = currentCrop(stitchResult, edits);
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = get2d(canvas);
  ctx.drawImage(image, -crop.x, -crop.y);
  applyEdits(ctx, edits, crop);
  applyWatermark(ctx, watermark);
  if (imageWatermark.enabled && imageWatermark.src) applyImageWatermark(ctx, imageWatermark, await loadImage(imageWatermark.src));
  return canvas;
}

function applyWatermark(ctx: CanvasRenderingContext2D, settings: WatermarkSettings) {
  if (!settings.enabled || !settings.text.trim()) return;
  const padding = Math.min(36, ctx.canvas.width / 10, ctx.canvas.height / 10);
  ctx.save();
  ctx.globalAlpha = settings.opacity;
  ctx.font = `600 ${settings.fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const fontSize = Math.min(settings.fontSize, ctx.canvas.height - padding * 2, settings.fontSize * (ctx.canvas.width - padding * 2) / Math.max(1, ctx.measureText(settings.text).width));
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = settings.color;
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = Math.max(1, fontSize / 12);
  const metrics = ctx.measureText(settings.text);
  paintWatermarkLayout(ctx, { width: metrics.width, height: fontSize }, settings, (x, y) => {
    ctx.strokeText(settings.text, x, y + fontSize * .8);
    ctx.fillText(settings.text, x, y + fontSize * .8);
  });
  ctx.restore();
}

function applyImageWatermark(ctx: CanvasRenderingContext2D, settings: ImageWatermarkSettings, image: HTMLImageElement | null) {
  if (!settings.enabled || !image) return;
  const padding = Math.min(36, ctx.canvas.width / 10, ctx.canvas.height / 10);
  const scale = Math.min(ctx.canvas.width * settings.scale / image.naturalWidth, (ctx.canvas.width - 2 * padding) / image.naturalWidth, (ctx.canvas.height - 2 * padding) / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  ctx.save(); ctx.globalAlpha = settings.opacity;
  paintWatermarkLayout(ctx, { width, height }, settings, (x, y) => ctx.drawImage(image, x, y, width, height));
  ctx.restore();
}

function paintWatermarkLayout(ctx: CanvasRenderingContext2D, box: { width: number; height: number }, settings: WatermarkLayout & { position: Position }, draw: (x: number, y: number) => void) {
  if (settings.mode === "single") {
    const { x, y } = watermarkPlacement(ctx.canvas, box, settings.position, settings.random);
    draw(x, y);
    return;
  }
  for (const tile of watermarkTiles(ctx.canvas, box, settings.density, settings.random)) {
    ctx.save(); ctx.translate(tile.x, tile.y); ctx.rotate(tile.angle); ctx.scale(tile.scale, tile.scale);
    draw(-box.width / 2, -box.height / 2); ctx.restore();
  }
}

function applyMosaicRects(ctx: CanvasRenderingContext2D, rects: MosaicRect[]) {
  rects.forEach((rect) => {
    pixelate(ctx, rect.x, rect.y, rect.width, rect.height, rect.blockSize);
  });
}

function applyMosaicBrushes(ctx: CanvasRenderingContext2D, brushes: MosaicBrush[]) {
  brushes.forEach((brush) => {
    interpolateStroke(brush.points, brush.size).forEach((point) => {
      const size = brush.size;
      pixelate(ctx, point.x - size / 2, point.y - size / 2, size, size, brush.blockSize);
    });
  });
}

function applyEdits(ctx: CanvasRenderingContext2D, edits: Edit[], crop: Rect) {
  edits.forEach((edit) => {
    if (edit.kind === "crop") return;
    const localRect = (rect: MosaicRect) => ({ ...rect, x: rect.x - crop.x, y: rect.y - crop.y });
    if (edit.kind === "rect") applyMosaicRects(ctx, [localRect(edit.value)]);
    else if (edit.kind === "brush") applyMosaicBrushes(ctx, [{ ...edit.value, points: edit.value.points.map((p) => ({ x: p.x - crop.x, y: p.y - crop.y })) }]);
    else applyMosaicRects(ctx, edit.value.map(localRect));
  });
}

const mosaicScratch = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

function pixelate(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, blockSize: number) {
  const sourceX = clamp(Math.round(x), 0, ctx.canvas.width);
  const sourceY = clamp(Math.round(y), 0, ctx.canvas.height);
  const sourceW = clamp(Math.round(x + width), 0, ctx.canvas.width) - sourceX;
  const sourceH = clamp(Math.round(y + height), 0, ctx.canvas.height) - sourceY;
  if (sourceW <= 0 || sourceH <= 0) return;
  const smallW = Math.max(1, Math.ceil(sourceW / blockSize));
  const smallH = Math.max(1, Math.ceil(sourceH / blockSize));
  const temp = mosaicScratch.get(ctx) ?? document.createElement("canvas");
  mosaicScratch.set(ctx, temp);
  temp.width = smallW;
  temp.height = smallH;
  const tempCtx = get2d(temp);
  tempCtx.imageSmoothingEnabled = true;
  tempCtx.drawImage(ctx.canvas, sourceX, sourceY, sourceW, sourceH, 0, 0, smallW, smallH);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(temp, 0, 0, smallW, smallH, sourceX, sourceY, sourceW, sourceH);
  ctx.restore();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片编码失败"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D 不可用");
  return ctx;
}

function canvasPoint(event: PointerEvent<HTMLCanvasElement>): Point {
  const canvas = event.currentTarget;
  return imagePoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), canvas);
}

function normalizedRect(start: Point, current: Point) {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    x,
    y,
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default App;
