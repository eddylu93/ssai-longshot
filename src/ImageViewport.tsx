import { type ReactNode, useEffect, useRef, useState } from "react";
import { constrainTransform, fitTransform, zoomAt, type Size, type Transform } from "./viewer";

export default function ImageViewport({ width, height, expanded, onExpandedChange, interactive, children }: {
  width: number; height: number; expanded: boolean; onExpandedChange: (value: boolean) => void; interactive: boolean; children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLDivElement>(null);
  const size = useRef<Size>({ width: 440, height: 400 });
  const transform = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const pointer = useRef<{ x: number; y: number; base: Transform; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const frame = useRef(0);
  const [availableWidth, setAvailableWidth] = useState(440);
  const paint = () => {
    if (!image.current) return;
    const t = transform.current;
    image.current.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`;
  };
  const schedule = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; paint(); });
  };
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    let first = true;
    const resize = () => {
      size.current = { width: node.clientWidth, height: node.clientHeight };
      if (!expanded) setAvailableWidth(node.clientWidth);
      if (expanded) {
        transform.current = first ? fitTransform({ width, height }, size.current) : constrainTransform(transform.current, { width, height }, size.current);
        paint();
      }
      first = false;
    };
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => observer.disconnect();
  }, [expanded, width, height]);
  useEffect(() => {
    if (!expanded || !stage.current) return;
    const node = stage.current;
    const previous = document.activeElement as HTMLElement | null;
    node.focus();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      transform.current = zoomAt(transform.current, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, delta, { width, height }, size.current);
      schedule();
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => { node.removeEventListener("wheel", wheel); cancelAnimationFrame(frame.current); frame.current = 0; previous?.focus(); };
  }, [expanded, width, height]);
  const scale = Math.min(1, Math.max(1, availableWidth - 32) / Math.max(1, width));
  return <div ref={stage} className={`image-viewport ${expanded ? "expanded" : ""} ${interactive ? "can-preview" : "editing"}`} tabIndex={expanded ? 0 : -1}
    role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label={expanded ? "图片预览" : "拼接画布"}
    onKeyDown={(e) => {
      if (!expanded) return;
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); onExpandedChange(false); }
      else if (e.key === "Tab") { e.preventDefault(); stage.current?.focus(); }
      else if (["+", "=", "-", "_"].includes(e.key)) {
        e.preventDefault();
        transform.current = zoomAt(transform.current, { x: size.current.width / 2, y: size.current.height / 2 }, e.key === "+" || e.key === "=" ? -120 : 120, { width, height }, size.current);
        schedule();
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? 60 : e.key === "ArrowRight" ? -60 : 0;
        const dy = e.key === "ArrowUp" ? 60 : e.key === "ArrowDown" ? -60 : 0;
        transform.current = constrainTransform({ ...transform.current, x: transform.current.x + dx, y: transform.current.y + dy }, { width, height }, size.current);
        schedule();
      }
    }}
    onPointerDown={(e) => {
      if (!expanded || e.button !== 0) return;
      dragged.current = false;
      pointer.current = { x: e.clientX, y: e.clientY, base: { ...transform.current }, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={(e) => {
      const p = pointer.current;
      if (!expanded || !p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.hypot(dx, dy) > 5) p.moved = true;
      if (!p.moved) return;
      transform.current = constrainTransform({ ...p.base, x: p.base.x + dx, y: p.base.y + dy }, { width, height }, size.current);
      schedule();
    }}
    onPointerUp={() => { dragged.current = pointer.current?.moved ?? false; pointer.current = null; }}
    onPointerCancel={() => { pointer.current = null; dragged.current = true; }}
    onClick={() => {
      if (expanded) { if (!dragged.current) onExpandedChange(false); dragged.current = false; }
      else if (interactive && width > 0) onExpandedChange(true);
    }}>
    <div ref={image} className="image-content" style={expanded ? { width, height, transformOrigin: "0 0" } : { width: width * scale, height: height * scale, transform: "none" }}>
      {children}
    </div>
  </div>;
}
