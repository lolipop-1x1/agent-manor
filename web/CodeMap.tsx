import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowsIn, ArrowsOut, CaretRight, Crosshair, Folder, Minus, Plus, Resize } from "@phosphor-icons/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { FileCoverage } from "../src/contracts";
import { fmt, metricNames, metricValue, percent, type Metric } from "./model";
import { clipRect, fitCamera, layoutMap, locateCamera, panCamera, projectRect, resizeCamera, visibleTiles, zoomCamera, type MapCamera, type MapPoint, type MapRect, type MapTile } from "./map-viewport";

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}

const position = (rect: MapRect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
const valueLabel = (file: FileCoverage, metric: Metric) => metric === "activity" ? `${fmt(file.activityCount)} 次` : percent(metricValue(file, metric), file.lineCount);
const fileLabel = (file: FileCoverage, metric: Metric) => `${file.path}，${metricNames[metric]} ${valueLabel(file, metric)}，${fmt(file.lineCount)} 行`;

export function CodeMap({ files, directory, metric, selected, browse, select, heading, legend }: {
  files: FileCoverage[]; directory: string; metric: Metric; selected: string | null;
  browse: (directory: string) => void; select: (path: string) => void; heading: ReactNode; legend: ReactNode;
}) {
  const explorer = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutMap(files, directory), [files, directory]);
  const [size, setSize] = useState({ width: 700, height: 450 });
  const sizeRef = useRef(size);
  const [camera, setCamera] = useState<MapCamera>(() => fitCamera(layout.bounds, size));
  const cameraRef = useRef(camera);
  const frame = useRef<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<{ tile: MapTile; point: MapPoint } | null>(null);
  const pointers = useRef(new Map<number, MapPoint>());
  const gesture = useRef<{ start: MapPoint; moved: boolean; last: MapPoint; distance?: number } | null>(null);
  const suppressClick = useRef(false);
  const fit = fitCamera(layout.bounds, size);
  const updateCamera = (next: MapCamera) => {
    cameraRef.current = next;
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setCamera(cameraRef.current);
    });
  };
  useEffect(() => {
    const element = host.current!;
    const reset = fitCamera(layout.bounds, sizeRef.current);
    cameraRef.current = reset; setCamera(reset); setHint(null);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry || !entry.contentRect.width || !entry.contentRect.height) return;
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      const previous = sizeRef.current;
      const oldFit = fitCamera(layout.bounds, previous);
      const newFit = fitCamera(layout.bounds, next);
      const current = cameraRef.current;
      const wasFit = Math.abs(current.scale - oldFit.scale) < 1e-8 && Math.abs(current.x - oldFit.x) < 1 && Math.abs(current.y - oldFit.y) < 1;
      const resized = wasFit ? newFit : resizeCamera(current, previous, next);
      sizeRef.current = next; setSize(next);
      updateCamera(zoomCamera(resized, 1, { x: next.width / 2, y: next.height / 2 }, newFit.scale, layout.maxScale));
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); setHint(null);
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      const factor = Math.exp(-Math.max(-500, Math.min(500, delta)) * .002);
      updateCamera(zoomCamera(cameraRef.current, factor, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, fitCamera(layout.bounds, sizeRef.current).scale, layout.maxScale));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [layout]);
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === explorer.current); setHint(null); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === explorer.current) await document.exitFullscreen();
      else await explorer.current!.requestFullscreen();
    } catch { setFullscreenError("无法进入全屏，请检查浏览器权限；仍可使用缩放和拖动。"); }
  };
  const visible = useMemo(() => visibleTiles(layout.files, camera, size), [layout, camera, size]);
  const maxCount = useMemo(() => files.reduce((max, file) => Math.max(max, file.activityCount), 1), [files]);
  const tone = (file: FileCoverage) => {
    const value = metricValue(file, metric);
    return value === 0 ? 0 : Math.min(4, Math.ceil(value / (metric === "activity" ? maxCount : file.lineCount) * 4));
  };
  const paths = useMemo(() => {
    const result = ["", "", "", "", ""];
    for (const { tile, visible: rect } of visible) {
      // 只绘制屏幕内的浮点几何，不把超大坐标或屏幕外节点交给 DOM。
      const gap = rect.width > 8 && rect.height > 8 ? 1 : 0;
      const width = rect.width - gap * 2;
      const height = rect.height - gap * 2;
      result[tone(tile.file)] += `M${rect.x + gap},${rect.y + gap}h${width}v${height}h${-width}Z`;
    }
    return result;
  }, [visible, metric, maxCount]);
  const readable = useMemo(() => visible.filter(({ visible: rect }) => rect.width >= 28 && rect.height >= 16), [visible]);
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = host.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const tileAt = (point: MapPoint) => {
    const current = cameraRef.current;
    const x = (point.x - current.x) / current.scale;
    const y = (point.y - current.y) / current.scale;
    return layout.files.find(tile => x >= tile.x && x <= tile.x + tile.width && y >= tile.y && y <= tile.y + tile.height);
  };
  const startPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".map-directory")) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    host.current!.setPointerCapture(event.pointerId);
    const points = [...pointers.current.values()];
    gesture.current = { start: point, last: point, moved: points.length > 1,
      distance: points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : undefined };
    if (points.length > 1) gesture.current.last = { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
    setHint(null);
  };
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const point = localPoint(event);
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) {
      if (event.pointerType === "mouse") { const tile = tileAt(point); setHint(tile ? { tile, point } : null); }
      return;
    }
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length > 1) {
      const center = { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
      const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
      const zoomed = zoomCamera(cameraRef.current, distance / Math.max(current.distance ?? distance, 1), current.last, fit.scale, layout.maxScale);
      updateCamera(panCamera(zoomed, { x: center.x - current.last.x, y: center.y - current.last.y }));
      current.last = center; current.distance = distance; current.moved = true;
    } else {
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 4) current.moved = true;
      if (current.moved) updateCamera(panCamera(cameraRef.current, { x: point.x - current.last.x, y: point.y - current.last.y }));
      current.last = point;
    }
    if (current.moved) { setDragging(true); setHint(null); }
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    const moved = gesture.current?.moved ?? false;
    pointers.current.delete(event.pointerId);
    if (host.current!.hasPointerCapture(event.pointerId)) host.current!.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.values()][0];
    gesture.current = remaining ? { start: remaining, last: remaining, moved: true } : null;
    setDragging(false);
    if (moved || event.type === "pointercancel") { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
  };
  const zoom = (factor: number) => { setHint(null); updateCamera(zoomCamera(cameraRef.current, factor, { x: size.width / 2, y: size.height / 2 }, fit.scale, layout.maxScale)); };
  const reset = () => { setHint(null); updateCamera(fit); };
  const locate = () => {
    const tile = layout.files.find(file => file.path === selected);
    if (tile) { setHint(null); updateCamera(locateCamera(tile, size, fit.scale, layout.maxScale)); }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.4); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.4); }
    else if (event.key === "0") { event.preventDefault(); reset(); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); setHint(null);
      updateCamera(panCamera(cameraRef.current, { x: event.key === "ArrowLeft" ? 60 : event.key === "ArrowRight" ? -60 : 0, y: event.key === "ArrowUp" ? 60 : event.key === "ArrowDown" ? -60 : 0 }));
    }
  };
  const selectedTile = layout.files.some(tile => tile.path === selected);
  return <section className="map-explorer" ref={explorer} data-fullscreen={fullscreen} aria-label="地图浏览区域">
    {heading}
    <div className="map-toolbar"><div className="map-zoom-controls" role="group" aria-label="地图缩放操作">
      <button className="icon-button" aria-label="缩小地图" disabled={camera.scale <= fit.scale * 1.0001} onClick={() => zoom(1 / 1.4)}><Minus size={16} /></button>
      <output aria-label="地图缩放倍率">{fmt(Math.round(camera.scale / fit.scale * 100))}%</output>
      <button className="icon-button" aria-label="放大地图" disabled={camera.scale >= layout.maxScale} onClick={() => zoom(1.4)}><Plus size={16} /></button>
      <button className="map-tool-button" aria-label="适应窗口" onClick={reset}><Resize size={16} /><span>适应窗口</span></button>
      <button className="map-tool-button" aria-label="定位所选文件" disabled={!selectedTile} onClick={locate}><Crosshair size={16} /><span>定位所选文件</span></button>
    </div><span className="map-gesture-help">滚轮缩放 · 拖动平移</span><button className="map-tool-button" aria-label={fullscreen ? "退出地图全屏" : "全屏查看地图"} onClick={() => void toggleFullscreen()}>{fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}<span>{fullscreen ? "退出全屏" : "全屏"}</span></button></div>
    {fullscreenError && <p className="map-error" role="alert">{fullscreenError}</p>}
    <div ref={host} className={`code-map${dragging ? " dragging" : ""}`} role="group" tabIndex={0} aria-label="文件行数决定面积的代码活动地图" aria-description="滚轮缩放，拖动平移；聚焦地图后可用加减键缩放、方向键平移、0 适应窗口。" data-scale={camera.scale} data-visible-count={visible.length} data-file-count={layout.files.length}
      onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onPointerLeave={() => { if (!gesture.current) setHint(null); }} onKeyDown={keyboard}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      onClick={event => { if (!(event.target as HTMLElement).closest("button") && event.detail !== 0) { const tile = tileAt(localPoint(event)); if (tile) { select(tile.path); setHint(null); } } }}>
      <svg className="map-colors" width={size.width} height={size.height} aria-hidden="true">{paths.map((path, i) => <path key={i} className={`tone-${i}`} d={path} />)}</svg>
      {readable.map(({ tile, visible: rect }) => {
        const file = tile.file;
        const near = metric === "edit" ? file.editNearLines : file.readNearLines;
        const nameVisible = rect.width >= 55 && rect.height >= 22;
        const metricVisible = rect.width >= 85 && rect.height >= 58;
        const roomy = rect.width >= 120 && rect.height >= 88;
        return <button key={file.path} data-path={file.path} className={`map-file tone-${tone(file)}${selected === file.path ? " selected" : ""}${metric !== "activity" && near ? " has-near" : ""}`} style={position(rect)} aria-label={fileLabel(file, metric)}
          onClick={() => { select(file.path); setHint(null); }} onFocus={() => setHint({ tile, point: { x: rect.x + 8, y: rect.y + 8 } })} onBlur={() => setHint(null)}>
          {nameVisible && <span className="tile-name">{tile.name}</span>}{metricVisible && <strong>{valueLabel(file, metric)}</strong>}{roomy && <span className="tile-meta">{fmt(file.lineCount)} 行{metric !== "activity" && near > 0 && <em>+{fmt(near)} 近似</em>}</span>}
        </button>;
      })}
      {layout.directories.filter(node => node.depth === 1).map(node => {
        const rect = clipRect(projectRect(node, camera), size);
        if (!rect || rect.width < 80 || rect.height < 35) return null;
        return <button key={node.path} className="map-directory" style={{ left: rect.x + 5, top: rect.y + 3, maxWidth: rect.width - 10 }} onClick={() => browse(node.path)} aria-label={`进入目录 ${node.path}`}><Folder size={13} /><span>{node.name}</span><CaretRight size={12} /></button>;
      })}
      {hint && !dragging && <div className="map-hover-hint" role="tooltip" style={{ left: Math.max(4, Math.min(hint.point.x + 12, size.width - Math.min(310, size.width - 8))), top: Math.max(4, Math.min(hint.point.y + 16, size.height - 78)), maxWidth: Math.min(310, size.width - 8) }}><span>{hint.tile.path}</span><strong>{metricNames[metric]} {valueLabel(hint.tile.file, metric)}</strong><small>{fmt(hint.tile.file.lineCount)} 行</small></div>}
    </div>
    {legend}
  </section>;
}
