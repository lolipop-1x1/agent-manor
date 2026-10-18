import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../../shared/i18n";
import { knowledgeListWidth, knowledgeNavigationWidth } from "./knowledge-model";

function KnowledgeResizable({ children, navigation = false, className }: { children: ReactNode; navigation?: boolean; className: string }) {
  const { t } = useI18n(), container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
  const minimum = navigation ? 176 : 315, storageKey = `agent-manor:knowledge-${navigation ? "navigation" : "list"}-width`;
  const [viewport, setViewport] = useState(1000), [preferred, setPreferred] = useState<number | undefined>(() => {
    try { const value = Number(localStorage.getItem(storageKey)); return value >= minimum && Number.isFinite(value) ? value : undefined; } catch { return undefined; }
  });
  const clamp = navigation ? knowledgeNavigationWidth : knowledgeListWidth;
  const width = clamp(viewport, preferred), maximum = navigation ? Math.max(176, Math.min(360, viewport - 675)) : Math.max(315, viewport - 360);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { if (entries[0]?.contentRect.width) setViewport(entries[0].contentRect.width); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (preferred !== undefined) { try { localStorage.setItem(storageKey, String(preferred)); } catch { /* 禁用浏览器存储时仍可调节。 */ } } }, [preferred, storageKey]);
  useEffect(() => () => document.body.classList.remove("resizing-panels"), []);
  const finish = () => { drag.current = undefined; document.body.classList.remove("resizing-panels"); };
  return <div ref={container} className={className} data-knowledge-focus-fallback={navigation || undefined} tabIndex={navigation ? -1 : undefined} style={{ [navigation ? "--knowledge-navigation-width" : "--knowledge-list-width"]: `${width}px` } as CSSProperties}>
    {children}
    <div className={`knowledge-panel-resizer knowledge-${navigation ? "navigation" : "list"}-resizer`} role="separator" tabIndex={0} aria-label={t(navigation ? "knowledge.resizeNavigation" : "knowledge.resizeList")} aria-controls={navigation ? "knowledge-navigation-pane" : "knowledge-list-pane"} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(width)} aria-valuetext={t("common.workspace.pixels", { count: Math.round(width) })} title={t("common.workspace.resizeHelp")}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, width }; document.body.classList.add("resizing-panels"); }}
      onPointerMove={event => { const start = drag.current; if (start?.id === event.pointerId) setPreferred(clamp(viewport, start.width + event.clientX - start.x)); }}
      onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setPreferred(clamp(viewport, event.key === "Home" ? minimum : event.key === "End" ? maximum : width + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10))); }} />
  </div>;
}
export function KnowledgeSplit({ children, reader }: { children: ReactNode; reader: boolean }) {
  return <KnowledgeResizable className={`knowledge-library${reader ? " has-reader" : ""}`}>{children}</KnowledgeResizable>;
}
export function KnowledgeWorkspace({ children, className }: { children: ReactNode; className: string }) {
  return <KnowledgeResizable navigation className={className}>{children}</KnowledgeResizable>;
}
