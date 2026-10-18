import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../../shared/i18n";
import { knowledgeListWidth } from "./knowledge-model";

export function KnowledgeSplit({ children, reader }: { children: ReactNode; reader: boolean }) {
  const { t } = useI18n(), container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
  const [viewport, setViewport] = useState(1000), [preferred, setPreferred] = useState<number | undefined>(() => {
    try { const value = Number(localStorage.getItem("agent-manor:knowledge-list-width")); return value >= 315 && Number.isFinite(value) ? value : undefined; } catch { return undefined; }
  });
  const width = knowledgeListWidth(viewport, preferred);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { if (entries[0]?.contentRect.width) setViewport(entries[0].contentRect.width); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (preferred !== undefined) { try { localStorage.setItem("agent-manor:knowledge-list-width", String(preferred)); } catch { /* 禁用浏览器存储时仍可调节。 */ } } }, [preferred]);
  useEffect(() => () => document.body.classList.remove("resizing-panels"), []);
  const finish = () => { drag.current = undefined; document.body.classList.remove("resizing-panels"); };
  return <div ref={container} className={`knowledge-library${reader ? " has-reader" : ""}`} style={{ "--knowledge-list-width": `${width}px` } as CSSProperties}>
    {children}
    <div className="knowledge-list-resizer" role="separator" tabIndex={0} aria-label={t("knowledge.resizeList")} aria-controls="knowledge-list-pane" aria-orientation="vertical" aria-valuemin={315} aria-valuemax={Math.max(315, viewport - 360)} aria-valuenow={Math.round(width)} title={t("common.workspace.resizeHelp")}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, width }; document.body.classList.add("resizing-panels"); }}
      onPointerMove={event => { const start = drag.current; if (start?.id === event.pointerId) setPreferred(knowledgeListWidth(viewport, start.width + event.clientX - start.x)); }}
      onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setPreferred(knowledgeListWidth(viewport, event.key === "Home" ? 315 : event.key === "End" ? viewport - 360 : width + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10))); }} />
  </div>;
}
