import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, Square, X } from "lucide-react";
import { PointerEvent, useEffect, useRef, useState } from "react";

type Rect = { x: number; y: number; width: number; height: number };
type Info = { sessionId: number; width: number; height: number; phase: string; count: number; region: Rect | null; hint?: string | null };
type Point = { x: number; y: number };

export default function CaptureOverlay({ controls }: { controls: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const start = useRef<Point | null>(null);
  const latest = useRef<Rect | null>(null);
  useEffect(() => {
    let disposed = false;
    const subscription = listen<Info>("capture-ui", ({ payload }) => { if (!disposed) setInfo(payload); });
    void subscription.then(() => invoke<Info>("capture_info")).then((value) => { if (!disposed) setInfo(value); }).catch((e) => setError(String(e)));
    return () => { disposed = true; void subscription.then((unlisten) => unlisten()); };
  }, []);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") void invoke("stop_capture"); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  const point = (event: PointerEvent<HTMLElement>) => ({
    x: Math.round(Math.min(1, Math.max(0, event.clientX / window.innerWidth)) * (info?.width ?? 1)),
    y: Math.round(Math.min(1, Math.max(0, event.clientY / window.innerHeight)) * (info?.height ?? 1))
  });
  const action = async (command: string) => {
    setBusy(true); setError("");
    try { await invoke(command); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  if (controls) return (
    <main className="capture-controls">
      <span>{error || info?.hint || (info?.phase === "recording" ? `${info.count} 张` : "区域已锁定")}</span>
      {info?.phase === "ready" ? <button title="开始采集" aria-label="开始采集" disabled={busy} onClick={() => void action("start_capture")}><Play size={18} /></button>
        : <button className="stop" title="停止采集" aria-label="停止采集" disabled={busy} onClick={() => void action("stop_capture")}><Square size={18} /></button>}
      {info?.phase !== "recording" && <button title="取消采集" aria-label="取消采集" disabled={busy} onClick={() => void action("stop_capture")}><X size={18} /></button>}
    </main>
  );
  const selecting = !info || info.phase === "select";
  const box = selecting ? rect : info.region;
  return <main className={`capture-surface ${selecting ? "selecting" : "locked"}`}
    onContextMenu={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (!selecting || !info || busy) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = point(event); latest.current = null; setRect(null); setError("");
    }}
    onPointerMove={(event) => {
      if (!start.current) return;
      const p = point(event), a = start.current;
      latest.current = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), width: Math.abs(p.x - a.x), height: Math.abs(p.y - a.y) };
      setRect(latest.current);
    }}
    onPointerUp={() => {
      start.current = null;
      const selection = latest.current;
      if (!selection || selection.width < 20 || selection.height < 20) return;
      setBusy(true);
      void invoke("select_capture_region", { selection }).catch((e) => setError(String(e))).finally(() => setBusy(false));
    }}
    onPointerCancel={() => { start.current = null; }}>
    {selecting && <div className="selection-status"><span>{error || (rect ? `${rect.width} x ${rect.height}` : "采集区域")}</span><button aria-label="取消框选" title="取消框选" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={() => void action("stop_capture")}><X size={18} /></button></div>}
    {box && info && <div className="desktop-capture-border" style={{ left: `${box.x / info.width * 100}%`, top: `${box.y / info.height * 100}%`, width: `${box.width / info.width * 100}%`, height: `${box.height / info.height * 100}%` }} />}
  </main>;
}
