import { useEffect, useRef, type ReactNode } from "react";
import { ArrowDownToLine, Crop, ShieldCheck, Type, X } from "lucide-react";

export type EditorTab = "crop" | "privacy" | "watermark" | "export";
const tabs = [
  { id: "crop", label: "裁剪", icon: Crop },
  { id: "privacy", label: "打码", icon: ShieldCheck },
  { id: "watermark", label: "水印", icon: Type },
  { id: "export", label: "导出", icon: ArrowDownToLine }
] as const;

export default function EditPanel({ tab, changeTab, close, hidden, children }: {
  tab: EditorTab; changeTab: (tab: EditorTab) => void; close: () => void; hidden: boolean; children: ReactNode;
}) {
  const buttons = useRef<Partial<Record<EditorTab, HTMLButtonElement | null>>>({});
  useEffect(() => { if (!hidden) buttons.current[tab]?.focus(); }, [hidden]);
  return <aside id="edit-panel" className="edit-panel" aria-labelledby="edit-panel-heading" hidden={hidden}
    onKeyDown={(event) => {
      const nativePicker = event.target instanceof HTMLSelectElement || (event.target instanceof HTMLInputElement && event.target.type === "color");
      if (event.key === "Escape" && !event.defaultPrevented && !nativePicker) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    }}>
    <header className="editor-heading">
      <h2 id="edit-panel-heading">编辑设置</h2>
      <button className="tool-button editor-close" aria-label="关闭编辑设置" title="收起编辑设置" onClick={close}><X size={18} /></button>
      <nav className="editor-tabs" role="tablist" aria-label="编辑工具" aria-orientation="horizontal">
        {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} ref={(node) => { buttons.current[id] = node; }}
          id={`editor-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="editor-content" tabIndex={tab === id ? 0 : -1}
          title={label} onClick={() => changeTab(id)} onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); changeTab(tabs[next].id); buttons.current[tabs[next].id]?.focus();
          }}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
    </header>
    <div id="editor-content" className="editor-content" role="tabpanel" tabIndex={0} aria-labelledby={`editor-tab-${tab}`}>{children}</div>
  </aside>;
}
