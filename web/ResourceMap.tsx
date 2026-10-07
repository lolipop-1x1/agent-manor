import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowsIn, ArrowsOut, Crosshair, Minus, Plus, Resize, ShieldCheck, Star } from "@phosphor-icons/react";
import type { ResourceMapMetric, ResourceMapNode, ResourceMapResult } from "../src/resource-service-contracts";
import { ProjectPicker } from "./ProjectPicker";
import { HelpPopover } from "./HelpPopover";
import { ResourcePagination } from "./ResourcePagination";
import { dateLabel, fmt } from "./model";
import { clipRect, fitCamera, type MapPoint, type MapRect } from "./map-viewport";
import { layoutResourceMap, locateResourceMapCamera, panResourceMapCamera, resizeResourceMapCamera, resourceMapScreenRect, resourceMapTileAt, zoomResourceMapCamera, type ResourceMapCamera } from "./resource-map-layout";
import { formatList, getLanguage, messageText, t, useI18n } from "./i18n";
import { formatPercent } from "../src/i18n";
import { resourceMapCompactTitleKey, resourceMapValueMessage, resourceUsageStates } from "./resource-usage-state";
import "./resource-map.css";

const metricLabel = (metric: ResourceMapMetric) => t(metric === "sessions" ? "resources.sort.sessions" : metric === "reads" ? "resources.map.reads" : "resources.sort.calls");
const metricValue = (metric: ResourceMapMetric, count: number) => {
  const message = resourceMapValueMessage({ value: count, observation: "used" }, metric);
  return t(message.key, message.params);
};
const shareLabel = (value: number | null) => value === null ? t("common.unknown") : value > 0 && value < .00001 ? `<${formatPercent(getLanguage(), .00001, { maximumFractionDigits: 3 })}` : formatPercent(getLanguage(), value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const position = (rect: MapRect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
const dateDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
const tone = (node: ResourceMapNode, today: number) => {
  if (!node.lastUsedAt) return "missing";
  const days = (today - dateDay(new Date(node.lastUsedAt))) / 86400000;
  return days <= 30 ? "recent" : days <= 90 ? "older" : "old";
};
const usageStateLabel = (node: ResourceMapNode) => formatList(resourceUsageStates(node).map(state => t(state.key, state.params)));
const statusLabel = (node: ResourceMapNode) => formatList([node.favorite && t("resources.candidate.favorite"), node.protected && t("resources.protected"), usageStateLabel(node)].filter(Boolean) as string[]);

interface ResourceMapProps {
  data: ResourceMapResult; selected: string; onSelect: (id: string) => void;
  zeroPage: number; zeroSize: number;
  onZeroPage: (page: number) => void; onZeroSize: (size: number) => void;
}

function CompactResources({ nodes, title, label, metric, selected, page, pageSize, onSelect, onPage, onSize }: {
  nodes: ResourceMapNode[]; title: string; label: string; metric: ResourceMapMetric; selected: string;
  page: number; pageSize: number; onSelect: (id: string) => void; onPage: (page: number) => void; onSize: (size: number) => void;
}) {
  useI18n();
  const current = Math.min(page, Math.max(1, Math.ceil(nodes.length / pageSize)));
  const rows = nodes.slice((current - 1) * pageSize, current * pageSize);
  return <details className="resource-map-compact"><summary>{title}<span>{fmt(nodes.length)}</span></summary>
    <div className="resource-map-compact-content">
      {rows.length ? <div className="resource-map-compact-rows">{rows.map(node => { const value = resourceMapValueMessage(node, metric); return <button key={node.id} aria-label={t("resources.viewUsage", { name: messageText(node.nameDescriptor, node.name) })} className={selected === node.id ? "is-selected" : ""} onClick={() => onSelect(node.id)}>
        <strong>{messageText(node.nameDescriptor, node.name)}</strong><span>{t(value.key, value.params)}</span>
        <div className="resource-tags">{node.favorite && <span><Star size={12} />{t("resources.candidate.favorite")}</span>}{node.protected && <span><ShieldCheck size={12} />{t("resources.protected")}</span>}{resourceUsageStates(node).map(state => <span className="is-warning" key={state.key}>{t(state.key, state.params)}</span>)}</div>
      </button>; })}</div> : <div className="resource-empty">{t("resources.map.empty")}</div>}
      <ResourcePagination label={label} page={current} pageSize={pageSize} total={nodes.length} onChange={onPage} onPageSizeChange={onSize} />
    </div>
  </details>;
}

export function ResourceMap({ data, selected, onSelect, zeroPage, zeroSize, onZeroPage, onZeroSize }: ResourceMapProps) {
  const { percent } = useI18n();
  const explorer = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const layout = useMemo(() => layoutResourceMap(data.positive), [data.positive]);
  const geometry = JSON.stringify(data.positive.map(node => [node.id, node.value]));
  const previousGeometry = useRef<string | null>(null);
  const [size, setSize] = useState({ width: 700, height: 400 });
  const sizeRef = useRef(size);
  const [camera, setCamera] = useState<ResourceMapCamera>(() => fitCamera(layout.bounds, size));
  const cameraRef = useRef(camera), frame = useRef<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false), [fullscreenError, setFullscreenError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<{ node: ResourceMapNode; point: MapPoint } | null>(null);
  const pointers = useRef(new Map<number, MapPoint>());
  const gesture = useRef<{ start: MapPoint; last: MapPoint; moved: boolean; distance?: number } | null>(null);
  const suppressClick = useRef(false);
  const today = dateDay(new Date());
  const fit = fitCamera(layout.bounds, size);
  const updateCamera = (next: ResourceMapCamera) => {
    cameraRef.current = next;
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setCamera(cameraRef.current); });
  };
  useEffect(() => {
    const element = host.current!;
    // 管理及收藏刷新未改变面积布局时保留地图视野。
    if (previousGeometry.current !== geometry) {
      const reset = fitCamera(layout.bounds, sizeRef.current);
      cameraRef.current = reset; setCamera(reset);
    }
    previousGeometry.current = geometry; setHint(null);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry || !entry.contentRect.width || !entry.contentRect.height) return;
      const next = { width: entry.contentRect.width, height: entry.contentRect.height }, previous = sizeRef.current;
      const current = cameraRef.current, oldFit = fitCamera(layout.bounds, previous), newFit = fitCamera(layout.bounds, next);
      const wasFit = Math.abs(current.scale - oldFit.scale) < 1e-8 && Math.abs(current.x - oldFit.x) < 1 && Math.abs(current.y - oldFit.y) < 1;
      sizeRef.current = next; setSize(next);
      const resized = wasFit ? newFit : resizeResourceMapCamera(current, previous, next);
      updateCamera(zoomResourceMapCamera(resized, 1, { x: next.width / 2, y: next.height / 2 }, newFit.scale, layout.maxScale));
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); setHint(null);
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      updateCamera(zoomResourceMapCamera(cameraRef.current, Math.exp(-Math.max(-500, Math.min(500, delta)) * .002),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, fitCamera(layout.bounds, sizeRef.current).scale, layout.maxScale));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [layout]);
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === explorer.current); setHint(null); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || document.fullscreenElement !== explorer.current) return;
      event.preventDefault(); void document.exitFullscreen().catch(() => setFullscreenError("resources.map.fullscreenExitFailed"));
    };
    document.addEventListener("fullscreenchange", changed); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("fullscreenchange", changed); document.removeEventListener("keydown", escape); };
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try { if (document.fullscreenElement === explorer.current) await document.exitFullscreen(); else await explorer.current!.requestFullscreen(); }
    catch { setFullscreenError("resources.map.fullscreenEnterFailed"); }
  };
  const chooseResource = async (id: string) => {
    if (document.fullscreenElement === explorer.current) {
      try { await document.exitFullscreen(); }
      catch { setFullscreenError("resources.map.fullscreenDetailFailed"); return; }
    }
    onSelect(id); setHint(null);
  };
  const visible = useMemo(() => layout.tiles.flatMap(tile => {
    const rect = clipRect(resourceMapScreenRect(tile, camera), size);
    return rect ? [{ tile, rect }] : [];
  }), [layout, camera, size]);
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = host.current!.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const tileAt = (point: MapPoint) => {
    return resourceMapTileAt(layout.tiles, cameraRef.current, point);
  };
  const startPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const point = localPoint(event); pointers.current.set(event.pointerId, point); host.current!.setPointerCapture(event.pointerId);
    const points = [...pointers.current.values()];
    gesture.current = { start: point, last: points.length > 1 ? { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 } : point,
      moved: points.length > 1, distance: points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : undefined };
    setHint(null);
  };
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const point = localPoint(event), current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) {
      if (event.pointerType === "mouse") { const tile = tileAt(point); setHint(tile ? { node: tile.node, point } : null); }
      return;
    }
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length > 1) {
      const center = { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
      const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
      const zoomed = zoomResourceMapCamera(cameraRef.current, distance / Math.max(current.distance ?? distance, 1), current.last, fit.scale, layout.maxScale);
      updateCamera(panResourceMapCamera(zoomed, { x: center.x - current.last.x, y: center.y - current.last.y }));
      current.last = center; current.distance = distance; current.moved = true;
    } else {
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 4) current.moved = true;
      if (current.moved) updateCamera(panResourceMapCamera(cameraRef.current, { x: point.x - current.last.x, y: point.y - current.last.y }));
      current.last = point;
    }
    if (current.moved) { setDragging(true); setHint(null); }
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    const moved = gesture.current?.moved ?? false;
    pointers.current.delete(event.pointerId); if (host.current!.hasPointerCapture(event.pointerId)) host.current!.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.values()][0]; gesture.current = remaining ? { start: remaining, last: remaining, moved: true } : null;
    setDragging(false);
    if (moved || event.type === "pointercancel") { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
  };
  const zoom = (factor: number) => { setHint(null); updateCamera(zoomResourceMapCamera(cameraRef.current, factor, { x: size.width / 2, y: size.height / 2 }, fit.scale, layout.maxScale)); };
  const reset = () => { setHint(null); updateCamera(fit); };
  const locate = (id: string) => {
    const tile = layout.tiles.find(tile => tile.id === id); if (tile) { setHint(null); updateCamera(locateResourceMapCamera(tile, size, fit.scale, layout.maxScale)); }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.4); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.4); }
    else if (event.key === "0") { event.preventDefault(); reset(); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); setHint(null); updateCamera(panResourceMapCamera(cameraRef.current, { x: event.key === "ArrowLeft" ? 60 : event.key === "ArrowRight" ? -60 : 0, y: event.key === "ArrowUp" ? 60 : event.key === "ArrowDown" ? -60 : 0 }));
    }
  };
  const selectedTile = layout.tiles.some(tile => tile.id === selected);
  const compactTitle = t(resourceMapCompactTitleKey(data.zero, data.metric));
  const zoomPercent = camera.scale / fit.scale * 100;
  return <div className="resource-map-view">
    <section className="resource-map-explorer" ref={explorer} aria-label={t("resources.map.explorer")}>
      <div className="resource-map-toolbar"><div className="map-zoom-controls" role="group" aria-label={t("resources.map.zoomControls")}>
        <button className="icon-button" aria-label={t("resources.map.zoomOut")} disabled={!data.positive.length || camera.scale <= fit.scale * 1.0001} onClick={() => zoom(1 / 1.4)}><Minus size={16} /></button>
        <output aria-label={t("resources.map.zoomLevel")}>{percent(zoomPercent / 100, { minimumFractionDigits: 0, maximumFractionDigits: 0, notation: zoomPercent < 1_000_000 ? "standard" : "scientific" })}</output>
        <button className="icon-button" aria-label={t("resources.map.zoomIn")} disabled={!data.positive.length || camera.scale >= layout.maxScale} onClick={() => zoom(1.4)}><Plus size={16} /></button>
        <button className="map-tool-button" aria-label={t("resources.map.fitAria")} onClick={reset}><Resize size={16} />{t("resources.map.fit")}</button>
        <button className="map-tool-button" aria-label={t("resources.map.locateSelectedAria")} disabled={!selectedTile} onClick={() => locate(selected)}><Crosshair size={16} />{t("resources.map.locateSelected")}</button>
      </div><button className="map-tool-button" aria-label={fullscreen ? t("resources.map.fullscreenExitAria") : t("resources.map.fullscreenEnterAria")} onClick={() => void toggleFullscreen()}>{fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}{fullscreen ? t("resources.map.fullscreenExit") : t("resources.map.fullscreenEnter")}</button>
        <HelpPopover label={t("resources.map.help")} container={fullscreen ? explorer.current : undefined}><dl>
          <div><dt>{t("resources.map.helpArea")}</dt><dd>{t("resources.map.helpAreaText", { metric: metricLabel(data.metric) })}</dd></div>
          <div><dt>{t("resources.map.helpColor")}</dt><dd>{t("resources.map.helpColorText")}</dd></div>
          <div><dt>{t("resources.map.helpBrowse")}</dt><dd>{t("resources.map.helpBrowseText")}</dd></div>
          <div><dt>{t("resources.map.helpManage")}</dt><dd>{t("resources.map.helpManageText")}</dd></div>
        </dl></HelpPopover>
      </div>
      <div className="resource-map-locator"><ProjectPicker label={t("resources.map.locator")} placeholder={t("resources.map.searchPlaceholder")} value={selectedTile ? selected : "none"} options={[{ value: "none", label: t("resources.map.selectResource") }, ...data.positive.map(node => ({ value: node.id, label: messageText(node.nameDescriptor, node.name) }))]} container={fullscreen ? explorer.current : undefined} onChange={id => { if (id !== "none") { locate(id); void chooseResource(id); } else void chooseResource(""); }} /><span>{t("resources.map.summary", { count: data.positive.length })}</span></div>
      {fullscreenError && <div className="resource-alert" role="alert">{t(fullscreenError)}</div>}
      <div ref={host} className={`resource-map-canvas${dragging ? " dragging" : ""}`} role="group" tabIndex={0} aria-label={t("resources.map.canvas")} aria-description={t("resources.map.keyboardHelp")} data-scale={camera.scale}
        onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onKeyDown={keyboard}
        onPointerLeave={event => { if (!host.current!.hasPointerCapture(event.pointerId)) { pointers.current.delete(event.pointerId); gesture.current = null; setHint(null); } }}
        onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
        onClick={event => { if (!(event.target as Element).closest("button") && event.detail !== 0) { const tile = tileAt(localPoint(event)); if (tile) void chooseResource(tile.id); } }}>
        <svg className="resource-map-colors" width={size.width} height={size.height} aria-hidden="true">{visible.map(({ tile, rect }) => <rect key={tile.id} data-resource-id={tile.id} className={`recency-${tone(tile.node, today)}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} />)}</svg>
        {visible.filter(({ rect }) => rect.width >= 28 && rect.height >= 18).map(({ tile, rect }) => {
          const node = tile.node;
          return <button key={tile.id} style={position(rect)} className={`resource-map-tile recency-${tone(node, today)}${selected === tile.id ? " is-selected" : ""}`} aria-label={t("resources.viewUsage", { name: messageText(node.nameDescriptor, node.name) })} aria-describedby={hint?.node.id === tile.id ? tooltipId : undefined}
            onClick={() => void chooseResource(tile.id)} onFocus={() => setHint({ node, point: { x: rect.x, y: rect.y } })} onBlur={() => setHint(null)}>
            <span className="resource-map-tile-copy">{rect.width >= 48 && rect.height >= 28 && <strong>{messageText(node.nameDescriptor, node.name)}</strong>}{rect.width >= 80 && rect.height >= 55 && <span>{metricValue(data.metric, node.value!)}</span>}{rect.width >= 130 && rect.height >= 88 && <small>{shareLabel(node.share)}{node.favorite && <Star size={12} weight="fill" />}{node.protected && <ShieldCheck size={12} />}</small>}{rect.width >= 135 && rect.height >= 110 && usageStateLabel(node) && <small>{usageStateLabel(node)}</small>}</span>
          </button>;
        })}
        {!data.positive.length && <div className="resource-map-empty">{t("resources.map.noPositive")}</div>}
        {hint && !dragging && <div id={tooltipId} role="tooltip" className="resource-map-tooltip" style={{ left: Math.max(6, Math.min(hint.point.x + 12, size.width - Math.min(300, size.width - 12))), top: Math.max(6, Math.min(hint.point.y + 14, size.height - 160)), maxWidth: Math.min(300, size.width - 12) }}>
          <strong>{messageText(hint.node.nameDescriptor, hint.node.name)}</strong><span>{t("resources.map.tooltipMetric", { metric: metricLabel(data.metric), value: metricValue(data.metric, hint.node.value!) })}</span><span>{t("resources.map.tooltipShare", { share: shareLabel(hint.node.share) })}</span><span>{t("resources.lastUsed", { date: hint.node.lastUsedAt ? dateLabel(hint.node.lastUsedAt) : t("resources.map.timeMissing") })}</span>{statusLabel(hint.node) && <span>{statusLabel(hint.node)}</span>}
        </div>}
      </div>
      <div className="resource-map-legend" aria-label={t("resources.map.legend")}><span><i className="recency-recent" />{t("resources.time.thirty")}</span><span><i className="recency-older" />{t("resources.map.older")}</span><span><i className="recency-old" />{t("resources.map.old")}</span><span><i className="recency-missing" />{t("resources.map.timeMissing")}</span></div>
    </section>
    <div className="resource-map-secondary"><CompactResources nodes={data.zero} title={compactTitle} label={compactTitle} metric={data.metric} selected={selected} page={zeroPage} pageSize={zeroSize} onSelect={onSelect} onPage={onZeroPage} onSize={onZeroSize} /></div>
  </div>;
}
