import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { panelSemantics, panelWidthRange, workspaceWidths, type PanelSemantics, type PanelSide, type PanelWidths, type WorkspaceVariant } from "./workspace-layout";
import { animateSurface } from "../motion";

export function ResizableWorkspace({ sidebarCollapsed, detailsCollapsed, children, semantics, variant = "map" }: {
  sidebarCollapsed: boolean; detailsCollapsed: boolean; children: ReactNode; semantics?: PanelSemantics; variant?: WorkspaceVariant;
}) {
  const { t } = useI18n();
  const workspace = useRef<HTMLDivElement>(null);
  const drag = useRef<{ side: PanelSide; x: number; width: number; pointerId: number } | null>(null);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState<Partial<PanelWidths>>({});
  const [pinned, setPinned] = useState<{ viewport: number; side: PanelSide; width: number } | null>(null);
  const [resizing, setResizing] = useState<PanelSide | null>(null);
  // 在当前窗口内固定另一侧的显示宽度，避免拖动联动；窗口变化后恢复它原有的偏好。
  const display = pinned?.viewport === viewport ? { ...preferred, [pinned.side]: pinned.width } : preferred;
  const widths = workspaceWidths(viewport, display, { sidebar: sidebarCollapsed, details: detailsCollapsed }, variant, availableWidth);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0) {
        // CSS 断点使用窗口宽度，拖动预算扣除滚动条等实际占用。
        setViewport(window.innerWidth);
        setAvailableWidth(entry.contentRect.width);
        setPinned(current => current?.viewport === window.innerWidth ? current : null);
      }
    });
    if (workspace.current) observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setPinned(null); }, [sidebarCollapsed, detailsCollapsed]);
  useEffect(() => {
    if (resizing) document.body.classList.add("resizing-panels");
    return () => document.body.classList.remove("resizing-panels");
  }, [resizing]);

  const previousCollapsed = useRef({ sidebar: sidebarCollapsed, details: detailsCollapsed });
  useLayoutEffect(() => {
    const animations: Animation[] = [];
    for (const side of ["sidebar", "details"] as const) {
      const collapsed = side === "sidebar" ? sidebarCollapsed : detailsCollapsed;
      if (previousCollapsed.current[side] && !collapsed) {
        const content = document.getElementById(panelSemantics(side, semantics).controls);
        if (content && workspace.current?.contains(content)) {
          const animation = animateSurface(content, [{ opacity: .6, translate: `${side === "sidebar" ? -16 : 16}px 0` }, { opacity: 1, translate: "0 0" }], "--motion-panel");
          if (animation) animations.push(animation);
        }
      }
      previousCollapsed.current[side] = collapsed;
    }
    return () => { for (const animation of animations) animation.cancel(); };
  }, [sidebarCollapsed, detailsCollapsed]);

  const adjust = (side: PanelSide, value: number) => {
    const range = panelWidthRange(side, viewport, widths, availableWidth);
    const opposite = side === "sidebar" ? "details" : "sidebar";
    const oppositeCollapsed = opposite === "sidebar" ? sidebarCollapsed : detailsCollapsed;
    setPinned(oppositeCollapsed || opposite === "details" && viewport < 1024 ? null : { viewport, side: opposite, width: widths[opposite] });
    setPreferred(current => ({ ...current, [side]: Math.max(range.min, Math.min(range.max, value)) }));
  };
  const start = (event: PointerEvent<HTMLDivElement>, side: PanelSide) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { side, x: event.clientX, width: widths[side], pointerId: event.pointerId };
    setResizing(side);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    adjust(current.side, current.width + (event.clientX - current.x) * (current.side === "sidebar" ? 1 : -1));
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, side: PanelSide) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const range = panelWidthRange(side, viewport, widths, availableWidth);
    const step = (event.shiftKey ? 40 : 10) * (side === "sidebar" ? 1 : -1);
    adjust(side, event.key === "Home" ? range.min : event.key === "End" ? range.max : widths[side] + (event.key === "ArrowRight" ? step : -step));
  };

  return <div ref={workspace} className="workspace" data-workspace={variant} data-sidebar-collapsed={sidebarCollapsed} data-details-collapsed={detailsCollapsed}
    data-resizing={resizing ?? undefined} style={{ "--sidebar-width": `${widths.sidebar}px`, "--details-width": `${widths.details}px` } as CSSProperties}>
    {children}
    {(["sidebar", "details"] as const).map(side => {
      const hidden = side === "sidebar" ? sidebarCollapsed || viewport < 768 : detailsCollapsed || viewport < 1024;
      const range = panelWidthRange(side, viewport, widths, availableWidth);
      const accessible = panelSemantics(side, semantics);
      return <div key={side} className={`panel-resizer ${side}-resizer`} role="separator" tabIndex={0} hidden={hidden}
        aria-label={accessible.label} aria-orientation="vertical" aria-controls={accessible.controls}
        aria-valuemin={range.min} aria-valuemax={Math.round(range.max)} aria-valuenow={Math.round(widths[side])}
        aria-valuetext={t("common.workspace.pixels", { count: Math.round(widths[side]) })} title={t("common.workspace.resizeHelp")}
        onPointerDown={event => start(event, side)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
        onLostPointerCapture={finish} onKeyDown={event => key(event, side)} />;
    })}
  </div>;
}
