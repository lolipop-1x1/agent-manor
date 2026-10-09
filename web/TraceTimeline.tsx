import { getLanguage, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber, formatPercent, formatTime } from "../src/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Minus, Plus, Resize } from "@phosphor-icons/react";
import type { SessionTimelineEvent, SessionTimelineResult } from "../src/session-contracts";
import { SessionError } from "./SessionControls";
import { kindLabels } from "./SessionMessage";
import { sessionParams, turnTitle } from "./session-model";
import { isAborted, request } from "./api";
import { Hint } from "./CodeMap";
import { TRACE_MAX_ZOOM, timelineCenteredScroll, timelineFraction, timelineNodes, timelinePosition, timelineProjection, timelineVisibleMarks, timelineZoomScroll, type TraceProjection } from "./session-trace-model";

const projections = { sequence: "sessions.timeline.sequence", turn: "sessions.timeline.turn", time: "sessions.timeline.time" } as const;
export function TraceTimeline({ data, sessionId, selectedId, loading, error, onSelect, onRetry }: {
  data?: SessionTimelineResult; sessionId?: string; selectedId?: string; loading: boolean; error?: Error;
  onSelect: (event: SessionTimelineEvent) => void; onRetry: () => void;
}) {
  useI18n();
  const [mode, setMode] = useState<TraceProjection>("sequence");
  const [hover, setHover] = useState<{ index: number; x: number; y: number }>();
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(1000);
  const [scroll, setScroll] = useState(0);
  const [detail, setDetail] = useState<SessionTimelineResult>();
  const [detailError, setDetailError] = useState<Error>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const resolution = Math.min(5000, 1800 * zoom);
  useEffect(() => {
    if (!sessionId || !data?.version || resolution === 1800 && (!selectedId || data.events.some(event => event.id === selectedId))) { setDetailLoading(false); setDetailError(undefined); return; }
    const controller = new AbortController(); setDetailLoading(true); setDetailError(undefined);
    void request<SessionTimelineResult>(`/sessions/${encodeURIComponent(sessionId)}/timeline${sessionParams({ version: data.version, maxEvents: resolution, messageId: selectedId })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && result.version === data.version) setDetail(result); })
      .catch(error => { if (!isAborted(error)) setDetailError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [sessionId, data?.version, resolution, selectedId, detailRetry]);
  const shownData = detail?.version === data?.version ? detail : data;
  const events = shownData?.events ?? [];
  const viewport = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | undefined>(undefined);
  const geometry = useRef({ width, zoom });
  geometry.current = { width, zoom };
  const plotWidth = width * zoom;
  const nodes = useMemo(() => timelineNodes(events, !shownData?.aggregated), [events, shownData?.aggregated]);
  const { spans, missing, start, end } = useMemo(() => timelineProjection(nodes, mode, shownData?.projection), [nodes, mode, shownData?.projection]);
  const selected = spans.find(span => span.event.id === selectedId || span.result?.id === selectedId);
  const marks = useMemo(() => timelineVisibleMarks(spans, plotWidth, scroll, width, selectedId), [spans, plotWidth, scroll, width, selectedId]);
  const changeZoom = (value: number, anchor = width / 2) => {
    const next = Math.min(TRACE_MAX_ZOOM, Math.max(1, value));
    if (next === zoom) return;
    pendingScroll.current = timelineZoomScroll(viewport.current?.scrollLeft ?? scroll, width, plotWidth, width * next, anchor);
    setHover(undefined); setZoom(next);
  };
  const fit = () => { pendingScroll.current = 0; setHover(undefined); setZoom(1); if (viewport.current) viewport.current.scrollLeft = 0; setScroll(0); };
  const locate = () => {
    if (!selected || !viewport.current) return;
    viewport.current.scrollLeft = timelineCenteredScroll(selected.x, plotWidth, width);
    setScroll(viewport.current.scrollLeft); setHover(undefined);
  };
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    const observer = new ResizeObserver(() => {
      const next = node.clientWidth, previous = geometry.current;
      if (!next || next === previous.width) return;
      const center = timelineFraction(node.scrollLeft + previous.width / 2, previous.width * previous.zoom);
      pendingScroll.current = timelineCenteredScroll(center, next * previous.zoom, next);
      setWidth(next); setHover(undefined);
    });
    observer.observe(node); return () => observer.disconnect();
  }, [error]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    node.scrollLeft = pendingScroll.current ?? scroll;
    pendingScroll.current = undefined; setScroll(node.scrollLeft);
  }, [plotWidth, error]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node || !selected) return;
    const position = timelinePosition(selected.x, plotWidth);
    if (position < node.scrollLeft + 5 || position > node.scrollLeft + width - 5) {
      node.scrollLeft = timelineCenteredScroll(selected.x, plotWidth, width); setScroll(node.scrollLeft); setHover(undefined);
    }
  }, [selected?.event.id, mode, error]);
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = Math.min(width, Math.max(0, event.clientX - node.getBoundingClientRect().left));
      changeZoom(zoom * Math.exp(-event.deltaY * 0.01), anchor);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [width, zoom, error]);
  const hovered = hover ? nodes[hover.index] : undefined;
  const label = (event: SessionTimelineEvent) => `#${formatNumber(getLanguage(), event.ordinal)} · ${event.usage ? t("sessions.timeline.usage") : event.tool ?? t(kindLabels[event.kind])} · ${turnTitle(event.turnId, 1)}`;
  const nearest = (x: number, lane: number) => spans.filter(span => span.lane === lane).reduce<typeof spans[number] | undefined>((best, span) => !best || Math.abs(span.x - x) < Math.abs(best.x - x) ? span : best, undefined);
  const time = (value: number) => formatTime(getLanguage(), value);
  return <section className="trace-timeline" data-version={shownData?.version} aria-label={t("sessions.timeline.title")}>
    <div className="trace-timeline-head"><div role="group" aria-label={t("sessions.timeline.arrangement")}>{Object.entries(projections).map(([key, name]) => <button key={key} className="text-button" aria-pressed={mode === key} onClick={() => { setMode(key as TraceProjection); setHover(undefined); }}>{t(name)}</button>)}</div>
      <div className="trace-timeline-actions"><span>{loading || detailLoading ? t("sessions.timeline.loading") : shownData?.aggregated ? t("sessions.timeline.aggregatedCount", { count: shownData.total ?? events.length }) : t("sessions.timeline.nodeCount", { count: nodes.length })}</span>
        <div className="map-zoom-controls trace-timeline-zoom" role="group" aria-label={t("sessions.timeline.zoomControls")}>
          <Hint label={t("sessions.timeline.zoomOut")}><button className="icon-button" aria-label={t("sessions.timeline.zoomOut")} disabled={zoom <= 1 || !spans.length} onClick={() => changeZoom(zoom / 2)}><Minus size={14} aria-hidden="true" /></button></Hint>
          <output aria-label={t("sessions.timeline.zoomLevel")}>{formatPercent(getLanguage(), zoom, { maximumFractionDigits: 0 })}</output>
          <Hint label={t("sessions.timeline.zoomIn")}><button className="icon-button" aria-label={t("sessions.timeline.zoomIn")} disabled={zoom >= TRACE_MAX_ZOOM || !spans.length} onClick={() => changeZoom(zoom * 2)}><Plus size={14} aria-hidden="true" /></button></Hint>
          <Hint label={t("sessions.timeline.fit")}><button className="icon-button" aria-label={t("sessions.timeline.fit")} disabled={!spans.length} onClick={fit}><Resize size={14} aria-hidden="true" /></button></Hint>
          <Hint label={t("sessions.timeline.locate")}><button className="icon-button" aria-label={t("sessions.timeline.locate")} disabled={!selected} onClick={locate}><Crosshair size={14} aria-hidden="true" /></button></Hint>
        </div></div></div>
    {error || detailError ? <p className="trace-timeline-error" role="alert"><SessionError error={(error ?? detailError)!} /> <button className="text-button" onClick={() => { setDetailRetry(value => value + 1); onRetry(); }}>{t("sessions.timeline.retry")}</button></p> : <>
      <div className="trace-timeline-plot"><div className="trace-lane-labels" aria-hidden="true"><span>{t("sessions.usage.input")}</span><span>{t("sessions.timeline.model")}</span><span>{t("sessions.message.tool")}</span></div>
        <div ref={viewport} className="trace-timeline-viewport" onScroll={event => { setScroll(event.currentTarget.scrollLeft); setHover(undefined); }}>
        <svg viewBox={`0 0 ${plotWidth} 66`} style={{ width: plotWidth }} role="group" tabIndex={0} aria-label={t("sessions.timeline.keyboard")} onKeyDown={event => {
          if (["+", "=", "-", "0"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "0") fit(); else changeZoom(zoom * (event.key === "-" ? 0.5 : 2));
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key) || !spans.length) return;
          event.preventDefault();
          const current = selected ? spans.indexOf(selected) : -1;
          const index = event.key === "Home" ? 0 : event.key === "End" ? spans.length - 1 : event.key === "ArrowLeft" ? Math.max(0, current - 1) : event.key === "ArrowRight" ? Math.min(spans.length - 1, current + 1) : Math.max(0, current);
          onSelect(spans[index]!.event);
        }} onPointerMove={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left, y = (event.clientY - rect.top) / rect.height;
          const span = nearest(timelineFraction(x, plotWidth), Math.min(2, Math.max(0, Math.floor(y * 3))));
          setHover(span ? { index: span.index, x: x - (viewport.current?.scrollLeft ?? 0), y: y * 66 } : undefined);
        }} onPointerLeave={() => setHover(undefined)} onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left, y = (event.clientY - rect.top) / rect.height;
          const span = nearest(timelineFraction(x, plotWidth), Math.min(2, Math.max(0, Math.floor(y * 3))));
          if (span) onSelect(span.event);
        }}>
          {[22, 44].map(y => <line key={y} x1={0} x2={plotWidth} y1={y} y2={y} className="trace-lane-divider" />)}
          {marks.map(span => <rect key={`${span.lane}:${span.x}`} x={timelinePosition(span.x, plotWidth) - 2} y={span.lane * 22 + 7} width={5} height={9} rx={1} className={`trace-mark kind-${span.event.usage ? "usage" : span.event.kind}${span.event.status === "failure" ? " is-failure" : ""}`} />)}
          {selected && <rect x={timelinePosition(selected.x, plotWidth) - 4} y={selected.lane * 22 + 5} width={9} height={13} rx={2} className="trace-mark-selection" />}
        </svg></div>
        {hovered && hover && <div className="trace-timeline-tooltip" role="tooltip" style={{ ...(hover.x < width / 2 ? { left: 44 + hover.x } : { right: 10 + width - hover.x }), top: hover.y + 18 }}>
          <strong>{label(hovered.event)}</strong>{hovered.event.occurredAt && <span>{formatDateTime(getLanguage(), hovered.event.occurredAt)}</span>}
          {hovered.event.model && <span>{hovered.event.model}</span>}{hovered.event.durationMs !== undefined && <span>{t("sessions.timeline.duration", { value: formatNumber(getLanguage(), hovered.event.durationMs) })}</span>}
        </div>}
      </div>
      <div className="trace-timeline-foot"><div className="trace-timeline-legend"><span><i className="key-user" />{t("sessions.kind.user")}</span><span><i className="key-context" />{t("sessions.kind.context")}</span><span><i className="key-model" />{t("sessions.timeline.model")}</span><span><i className="key-tool" />{t("sessions.message.tool")}</span></div>
        {mode === "time" && <span>{spans.length ? `${time(start)} → ${time(end)}` : t("sessions.timeline.noTime")}</span>}{missing > 0 && <span>{t("sessions.timeline.missingTime", { count: missing })}</span>}</div>
    </>}
  </section>;
}
