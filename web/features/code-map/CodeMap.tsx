import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowsIn, ArrowsOut, CaretRight, Crosshair, Folder, Minus, Plus, Resize } from "@phosphor-icons/react";
import { t, useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import type { FileCoverage } from "../../../src/contracts";
import { fileLabelRect, metricNames, metricValue, type Metric } from "./model";
import { fmt, percent } from "../../shared/format";
import { clipRect, fitCamera, locateCamera, panCamera, projectRect, resizeCamera, zoomCamera, type MapCamera, type MapPoint, type MapRect } from "../../shared/map/geometry";
import { layoutMap, refreshCamera, visibleTiles, type MapTile } from "./map-layout";
import { MapTileLayer, type MapTone } from "../../shared/map/MapTileLayer";

const position = (rect: MapRect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
const valueLabel = (file: FileCoverage, metric: Metric) => metric === "activity" ? t("codeMap.activity.calls", { count: file.activityCount }) : percent(metricValue(file, metric), file.lineCount);
const fileLabel = (file: FileCoverage, metric: Metric) => t("codeMap.map.fileLabel", { path: file.path, metric: metricNames[metric], value: valueLabel(file, metric), lines: fmt(file.lineCount) });

export function CodeMap({ files, directory, metric, selected, browse, select, heading, legend, scopeKey = directory }: {
  files: FileCoverage[]; directory: string; metric: Metric; selected: string | null;
  browse: (directory: string) => void; select: (path: string) => void; heading: ReactNode; legend: ReactNode; scopeKey?: string;
}) {
  const { language } = useI18n();
  const explorer = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutMap(files, directory), [files, directory]);
  const [size, setSize] = useState({ width: 700, height: 450 });
  const sizeRef = useRef(size);
  const [camera, setCamera] = useState<MapCamera>(() => fitCamera(layout.bounds, size));
  const cameraRef = useRef(camera);
  const previousLayout = useRef({ layout, scopeKey });
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
    const previous = previousLayout.current;
    const reset = previous.scopeKey === scopeKey ? refreshCamera(cameraRef.current, previous.layout, layout, sizeRef.current) : fitCamera(layout.bounds, sizeRef.current);
    previousLayout.current = { layout, scopeKey };
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
  }, [layout, scopeKey]);
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === explorer.current); setHint(null); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !document.fullscreenElement || document.fullscreenElement !== explorer.current) return;
      event.preventDefault();
      void document.exitFullscreen().catch(() => setFullscreenError("codeMap.map.fullscreenExitError"));
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("fullscreenchange", changed); document.removeEventListener("keydown", escape); };
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === explorer.current) await document.exitFullscreen();
      else await explorer.current!.requestFullscreen();
    } catch { setFullscreenError("codeMap.map.fullscreenEnterError"); }
  };
  const visible = useMemo(() => visibleTiles(layout.files, camera, size), [layout, camera, size]);
  const maxCount = useMemo(() => files.reduce((max, file) => Math.max(max, file.activityCount), 1), [files]);
  const tone = (file: FileCoverage) => {
    const value = metricValue(file, metric);
    return value === 0 ? 0 : Math.min(4, Math.ceil(value / (metric === "activity" ? maxCount : file.lineCount) * 4)) as MapTone;
  };
  const colorTiles = useMemo(() => visible.map(({ tile, visible: rect }) => ({ rect, tone: tone(tile.file) })), [visible, metric, maxCount]);
  const readable = useMemo(() => visible.filter(({ visible: rect }) => rect.width >= 28 && rect.height >= 16), [visible]);
  const headings = useMemo(() => layout.directories.filter(node => node.depth === 1).flatMap(node => {
    const rect = clipRect(projectRect(node, camera), size);
    return rect && rect.width >= 80 && rect.height >= 35
      ? [{ node, rect: { x: rect.x + 5, y: rect.y + 3, width: rect.width - 10, height: 22 } }] : [];
  }), [layout, camera, size]);
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
    if (event.button !== 0) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    // 目录按钮的普通单击保持原目标；超过相同的拖动阈值后再捕获指针。
    if (!(event.target as Element).closest(".map-directory")) host.current!.setPointerCapture(event.pointerId);
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
      if ((event.target as Element).closest(".map-directory")) { setHint(null); return; }
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
      if (current.moved) {
        if (!host.current!.hasPointerCapture(event.pointerId)) host.current!.setPointerCapture(event.pointerId);
        updateCamera(panCamera(cameraRef.current, { x: point.x - current.last.x, y: point.y - current.last.y }));
      }
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
  return <section className="map-explorer" ref={explorer} data-fullscreen={fullscreen} aria-label={t("codeMap.map.region")}>
    {heading}
    <div className="map-toolbar"><div className="map-zoom-controls" role="group" aria-label={t("codeMap.map.zoomControls")}>
      <button className="icon-button" aria-label={t("codeMap.map.zoomOut")} disabled={camera.scale <= fit.scale * 1.0001} onClick={() => zoom(1 / 1.4)}><Minus size={16} /></button>
      <output aria-label={t("codeMap.map.zoomLevel")}>{new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(camera.scale / fit.scale)}</output>
      <button className="icon-button" aria-label={t("codeMap.map.zoomIn")} disabled={camera.scale >= layout.maxScale} onClick={() => zoom(1.4)}><Plus size={16} /></button>
      <button className="map-tool-button" aria-label={t("codeMap.map.fit")} onClick={reset}><Resize size={16} /><span>{t("codeMap.map.fit")}</span></button>
      <button className="map-tool-button" aria-label={t("codeMap.map.locate")} disabled={!selectedTile} onClick={locate}><Crosshair size={16} /><span>{t("codeMap.map.locate")}</span></button>
    </div><HelpPopover label={t("codeMap.map.help")} container={fullscreen ? explorer.current : undefined}><dl>
      <div><dt>{t("codeMap.map.zoomPan")}</dt><dd>{t("codeMap.map.zoomPanDescription")}</dd></div>
      <div><dt>{t("codeMap.map.keyboard")}</dt><dd>{t("codeMap.map.keyboardDescription")}</dd></div></dl></HelpPopover><button className="map-tool-button" aria-label={fullscreen ? t("codeMap.map.exitFullscreenLabel") : t("codeMap.map.enterFullscreenLabel")} onClick={() => void toggleFullscreen()}>{fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}<span>{fullscreen ? t("codeMap.map.exitFullscreen") : t("codeMap.map.fullscreen")}</span></button></div>
    {fullscreenError && <p className="map-error" role="alert">{t(fullscreenError)}</p>}
    <div ref={host} className={`code-map${dragging ? " dragging" : ""}`} role="group" tabIndex={0} aria-label={t("codeMap.map.label")} aria-description={t("codeMap.map.keyboardLabel")} data-scale={camera.scale} data-visible-count={visible.length} data-file-count={layout.files.length}
      onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onPointerLeave={event => {
        if (!host.current!.hasPointerCapture(event.pointerId)) { pointers.current.delete(event.pointerId); gesture.current = null; }
        if (!gesture.current) setHint(null);
      }} onKeyDown={keyboard}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      onClick={event => { if (!(event.target as HTMLElement).closest("button") && event.detail !== 0) { const tile = tileAt(localPoint(event)); if (tile) { select(tile.path); setHint(null); } } }}>
      <MapTileLayer className="map-colors" tiles={colorTiles} size={size} />
      {readable.map(({ tile, visible: rect }) => {
        const file = tile.file;
        const near = metric === "edit" ? file.editNearLines : file.readNearLines;
        const labels = fileLabelRect(rect, headings.map(heading => heading.rect));
        const nameVisible = labels.width >= 37 && labels.height >= 18;
        const metricVisible = labels.width >= 67 && labels.height >= 54;
        const roomy = labels.width >= 102 && labels.height >= 78;
        return <button key={file.path} data-path={file.path} className={`map-file tone-${tone(file)}${selected === file.path ? " selected" : ""}${metric !== "activity" && near ? " has-near" : ""}`} style={position(rect)} aria-label={fileLabel(file, metric)}
          onClick={() => { select(file.path); setHint(null); }} onFocus={() => setHint({ tile, point: { x: labels.x, y: labels.y } })} onBlur={() => setHint(null)}>
          <span className="map-file-labels" style={{ top: labels.y - rect.y - 1 }}>
            {nameVisible && <span className="tile-name">{tile.name}</span>}{metricVisible && <strong>{valueLabel(file, metric)}</strong>}{roomy && <span className="tile-meta">{t("codeMap.line.count", { count: file.lineCount })}{metric !== "activity" && near > 0 && <em>{t("codeMap.map.nearCount", { count: near })}</em>}</span>}
          </span>
        </button>;
      })}
      {headings.map(({ node, rect }) => <button key={node.path} className="map-directory" style={{ left: rect.x, top: rect.y, maxWidth: rect.width }} onClick={() => browse(node.path)} aria-label={t("codeMap.map.enterDirectory", { path: node.path })}><Folder size={13} /><span>{node.name}</span><CaretRight size={12} /></button>)}
      {hint && !dragging && <div className="map-hover-hint" role="tooltip" style={{ left: Math.max(4, Math.min(hint.point.x + 12, size.width - Math.min(310, size.width - 8))), top: Math.max(4, Math.min(hint.point.y + 16, size.height - 78)), maxWidth: Math.min(310, size.width - 8) }}><span>{hint.tile.path}</span><strong>{metricNames[metric]} {valueLabel(hint.tile.file, metric)}</strong><small>{t("codeMap.line.count", { count: hint.tile.file.lineCount })}</small></div>}
    </div>
    {legend}
  </section>;
}
