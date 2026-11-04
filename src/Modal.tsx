import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function Modal({ title, close, children, drawer = false }: { title: string; close: () => void; children: ReactNode; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={drawer ? "tool-drawer" : "confirm-dialog"} aria-label={title} onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  }}>
    <header className="dialog-heading"><h2>{title}</h2><button className="tool-button" aria-label={`关闭${title}`} title="关闭" onClick={close}><X size={18} /></button></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
