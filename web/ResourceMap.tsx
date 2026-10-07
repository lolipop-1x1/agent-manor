import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowsIn, ArrowsOut, Crosshair, Minus, Plus, Resize, ShieldCheck, Star } from "@phosphor-icons/react";
import type { ResourceMapMetric, ResourceMapNode, ResourceMapResult } from "../src/resource-service-contracts";
import { ProjectPicker } from "./ProjectPicker";
import { HelpPopover } from "./HelpPopover";
import { ResourcePagination } from "./ResourcePagination";
import { dateLabel, fmt } from "./model";
import { clipRect, fitCamera, type MapPoint, type MapRect } from "./map-viewport";
import { layoutResourceMap, locateResourceMapCamera, panResourceMapCamera, resizeResourceMapCamera, resourceMapScreenRect, resourceMapTileAt, zoomResourceMapCamera, type ResourceMapCamera } from "./resource-map-layout";
import "./resource-map.css";

export const resourceMapMetricNames: Record<ResourceMapMetric, string> = { calls: "调用次数", sessions: "使用会话数", reads: "成功读取次数" };
const zeroNames: Record<ResourceMapMetric, string> = { calls: "零调用", sessions: "零会话", reads: "零读取" };
const metricUnit = (metric: ResourceMapMetric) => metric === "sessions" ? "个会话" : "次";
const shareLabel = (value: number | null) => value === null ? "未知" : value > 0 && value < .00001 ? "<0.001%" : `${(value * 100).toFixed(2)}%`;
const position = (rect: MapRect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
const dateDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
const tone = (node: ResourceMapNode, today: number) => {
  if (!node.lastUsedAt) return "missing";
  const days = (today - dateDay(new Date(node.lastUsedAt))) / 86400000;
  return days <= 30 ? "recent" : days <= 90 ? "older" : "old";
};
const statusLabel = (node: ResourceMapNode) => [node.favorite && "已收藏", node.protected && "受保护", node.partial && "部分记录", !node.lastUsedAt && "时间未记录", node.missingTimeEvents > 0 && `${fmt(node.missingTimeEvents)} 条时间缺失`].filter(Boolean).join(" · ");

interface ResourceMapProps {
  data: ResourceMapResult; selected: string; onSelect: (id: string) => void;
  zeroPage: number; zeroSize: number; reviewPage: number; reviewSize: number;
  onZeroPage: (page: number) => void; onZeroSize: (size: number) => void;
  onReviewPage: (page: number) => void; onReviewSize: (size: number) => void;
}

function CompactResources({ nodes, metric, title, label, selected, page, pageSize, onSelect, onPage, onSize }: {
  nodes: ResourceMapNode[]; metric: ResourceMapMetric; title: string; label: string; selected: string;
  page: number; pageSize: number; onSelect: (id: string) => void; onPage: (page: number) => void; onSize: (size: number) => void;
}) {
  const current = Math.min(page, Math.max(1, Math.ceil(nodes.length / pageSize)));
  const rows = nodes.slice((current - 1) * pageSize, current * pageSize);
  return <details className="resource-map-compact"><summary>{title}<span>{fmt(nodes.length)}</span></summary>
    <div className="resource-map-compact-content">
      {rows.length ? <div className="resource-map-compact-rows">{rows.map(node => <button key={node.id} aria-label={`查看${node.name}的使用详情`} className={selected === node.id ? "is-selected" : ""} onClick={() => onSelect(node.id)}>
        <strong>{node.name}</strong><span>{node.value === null ? node.observation === "insufficient" ? "观测不足" : "使用未知" : `${fmt(node.value)} ${metricUnit(metric)}`}</span>
        <div className="resource-tags">{node.metrics && metric === "calls" && node.metrics.reads > 0 && <span>{fmt(node.metrics.reads)} 次成功读取</span>}{node.favorite && <span><Star size={12} />已收藏</span>}{node.protected && <span><ShieldCheck size={12} />受保护</span>}{node.partial && <span className="is-warning">部分记录</span>}{!node.lastUsedAt && <span className="is-warning">时间未记录</span>}</div>
      </button>)}</div> : <div className="resource-empty">没有匹配的资源</div>}
      <ResourcePagination label={label} page={current} pageSize={pageSize} total={nodes.length} onChange={onPage} onPageSizeChange={onSize} />
    </div>
  </details>;
}

export function ResourceMap({ data, selected, onSelect, zeroPage, zeroSize, reviewPage, reviewSize, onZeroPage, onZeroSize, onReviewPage, onReviewSize }: ResourceMapProps) {
  const explorer = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const layout = useMemo(() => layoutResourceMap(data.positive), [data.positive]);
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
    const reset = fitCamera(layout.bounds, sizeRef.current);
    cameraRef.current = reset; setCamera(reset); setHint(null);
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
      event.preventDefault(); void document.exitFullscreen().catch(() => setFullscreenError("无法退出全屏，请使用浏览器退出全屏。"));
    };
    document.addEventListener("fullscreenchange", changed); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("fullscreenchange", changed); document.removeEventListener("keydown", escape); };
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try { if (document.fullscreenElement === explorer.current) await document.exitFullscreen(); else await explorer.current!.requestFullscreen(); }
    catch { setFullscreenError("无法进入全屏；仍可使用缩放和拖动。"); }
  };
  const chooseResource = async (id: string) => {
    if (document.fullscreenElement === explorer.current) {
      try { await document.exitFullscreen(); }
      catch { setFullscreenError("请退出全屏后查看资源详情。"); return; }
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
  const zoomPercent = camera.scale / fit.scale * 100;
  return <div className="resource-map-view">
    <section className="resource-map-explorer" ref={explorer} aria-label="资源地图浏览区域">
      <div className="resource-map-toolbar"><div className="map-zoom-controls" role="group" aria-label="资源地图缩放操作">
        <button className="icon-button" aria-label="缩小资源地图" disabled={!data.positive.length || camera.scale <= fit.scale * 1.0001} onClick={() => zoom(1 / 1.4)}><Minus size={16} /></button>
        <output aria-label="资源地图缩放倍率">{zoomPercent < 1_000_000 ? fmt(Math.round(zoomPercent)) : zoomPercent.toExponential(2)}%</output>
        <button className="icon-button" aria-label="放大资源地图" disabled={!data.positive.length || camera.scale >= layout.maxScale} onClick={() => zoom(1.4)}><Plus size={16} /></button>
        <button className="map-tool-button" aria-label="适应资源地图窗口" onClick={reset}><Resize size={16} />适应窗口</button>
        <button className="map-tool-button" aria-label="定位所选资源" disabled={!selectedTile} onClick={() => locate(selected)}><Crosshair size={16} />定位所选</button>
      </div><button className="map-tool-button" aria-label={fullscreen ? "退出资源地图全屏" : "全屏查看资源地图"} onClick={() => void toggleFullscreen()}>{fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}{fullscreen ? "退出全屏" : "全屏"}</button>
        <HelpPopover label="资源地图说明" container={fullscreen ? explorer.current : undefined}><dl>
          <div><dt>面积与统计范围</dt><dd>面积严格按{resourceMapMetricNames[data.metric]}线性分配；占比以当前筛选后全部正值之和为分母。零值与未知不占面积；缩放、拖动和定位只改变视野。</dd></div>
          <div><dt>颜色</dt><dd>按当前范围内任一调用或成功读取的最近时间着色，不随面积指标切换。灰色或小色块不表示可删除。</dd></div>
          <div><dt>浏览</dt><dd>地图内滚轮缩放，拖动平移，触屏支持双指。聚焦地图后用加减键缩放、方向键平移、0 适应窗口；定位资源可看清微小色块。</dd></div>
          <div><dt>管理</dt><dd>点击资源，在详情中选择具体本体与入口并预览操作；名称汇总不合并管理对象，历史独有项保持只读。</dd></div>
        </dl></HelpPopover>
      </div>
      <div className="resource-map-locator"><ProjectPicker label="定位资源" placeholder="搜索资源名称…" value={selectedTile ? selected : "none"} options={[{ value: "none", label: "选择资源定位" }, ...data.positive.map(node => ({ value: node.id, label: node.name }))]} container={fullscreen ? explorer.current : undefined} onChange={id => { if (id !== "none") { locate(id); void chooseResource(id); } else void chooseResource(""); }} /><span>{fmt(data.positive.length)} 个色块 · {fmt(data.totalValue)} {metricUnit(data.metric)}</span></div>
      {fullscreenError && <div className="resource-alert" role="alert">{fullscreenError}</div>}
      <div ref={host} className={`resource-map-canvas${dragging ? " dragging" : ""}`} role="group" tabIndex={0} aria-label="资源使用地图" aria-description="滚轮缩放，拖动平移；聚焦后用加减键缩放、方向键平移、0适应窗口。" data-scale={camera.scale}
        onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onKeyDown={keyboard}
        onPointerLeave={event => { if (!host.current!.hasPointerCapture(event.pointerId)) { pointers.current.delete(event.pointerId); gesture.current = null; setHint(null); } }}
        onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
        onClick={event => { if (!(event.target as Element).closest("button") && event.detail !== 0) { const tile = tileAt(localPoint(event)); if (tile) void chooseResource(tile.id); } }}>
        <svg className="resource-map-colors" width={size.width} height={size.height} aria-hidden="true">{visible.map(({ tile, rect }) => <rect key={tile.id} data-resource-id={tile.id} className={`recency-${tone(tile.node, today)}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} />)}</svg>
        {visible.filter(({ rect }) => rect.width >= 28 && rect.height >= 18).map(({ tile, rect }) => {
          const node = tile.node;
          return <button key={tile.id} style={position(rect)} className={`resource-map-tile recency-${tone(node, today)}${selected === tile.id ? " is-selected" : ""}`} aria-label={`查看${node.name}的使用详情`} aria-describedby={hint?.node.id === tile.id ? tooltipId : undefined}
            onClick={() => void chooseResource(tile.id)} onFocus={() => setHint({ node, point: { x: rect.x, y: rect.y } })} onBlur={() => setHint(null)}>
            <span className="resource-map-tile-copy">{rect.width >= 48 && rect.height >= 28 && <strong>{node.name}</strong>}{rect.width >= 80 && rect.height >= 55 && <span>{fmt(node.value!)} {metricUnit(data.metric)}</span>}{rect.width >= 130 && rect.height >= 88 && <small>{shareLabel(node.share)}{node.favorite && <Star size={12} weight="fill" />}{node.protected && <ShieldCheck size={12} />}</small>}{rect.width >= 135 && rect.height >= 110 && (node.partial || !node.lastUsedAt) && <small>{[node.partial && "部分记录", !node.lastUsedAt && "时间未记录"].filter(Boolean).join(" · ")}</small>}</span>
          </button>;
        })}
        {!data.positive.length && <div className="resource-map-empty">当前范围没有正值资源</div>}
        {hint && !dragging && <div id={tooltipId} role="tooltip" className="resource-map-tooltip" style={{ left: Math.max(6, Math.min(hint.point.x + 12, size.width - Math.min(300, size.width - 12))), top: Math.max(6, Math.min(hint.point.y + 14, size.height - 160)), maxWidth: Math.min(300, size.width - 12) }}>
          <strong>{hint.node.name}</strong><span>{resourceMapMetricNames[data.metric]} · {fmt(hint.node.value!)} {metricUnit(data.metric)}</span><span>当前结果集占比 · {shareLabel(hint.node.share)}</span><span>最近使用 · {hint.node.lastUsedAt ? dateLabel(hint.node.lastUsedAt) : "时间未记录"}</span>{statusLabel(hint.node) && <span>{statusLabel(hint.node)}</span>}
        </div>}
      </div>
      <div className="resource-map-legend" aria-label="最近使用时间图例"><span><i className="recency-recent" />近 30 天</span><span><i className="recency-older" />31–90 天</span><span><i className="recency-old" />超过 90 天</span><span><i className="recency-missing" />时间未记录</span></div>
    </section>
    <div className="resource-map-secondary"><CompactResources nodes={data.zero} metric={data.metric} title={zeroNames[data.metric]} label="零值资源" selected={selected} page={zeroPage} pageSize={zeroSize} onSelect={onSelect} onPage={onZeroPage} onSize={onZeroSize} />
      <CompactResources nodes={data.review} metric={data.metric} title="待检查" label="待检查资源" selected={selected} page={reviewPage} pageSize={reviewSize} onSelect={onSelect} onPage={onReviewPage} onSize={onReviewSize} /></div>
  </div>;
}
