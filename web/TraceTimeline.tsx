import { getLanguage, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber, formatTime } from "../src/i18n";
import { useMemo, useState } from "react";
import type { SessionTimelineEvent } from "../src/session-contracts";
import { SessionError } from "./SessionControls";
import { kindLabels } from "./SessionMessage";
import { turnTitle } from "./session-model";
import { timelineNodes, timelineProjection, type TraceProjection } from "./session-trace-model";

const projections = { sequence: "sessions.timeline.sequence", turn: "sessions.timeline.turn", time: "sessions.timeline.time" } as const;
export function TraceTimeline({ events, selectedId, loading, error, onSelect, onRetry }: {
  events: SessionTimelineEvent[]; selectedId?: string; loading: boolean; error?: Error;
  onSelect: (event: SessionTimelineEvent) => void; onRetry: () => void;
}) {
  useI18n();
  const [mode, setMode] = useState<TraceProjection>("sequence");
  const [hover, setHover] = useState<{ index: number; x: number; y: number }>();
  const nodes = useMemo(() => timelineNodes(events), [events]);
  const { spans, missing, start, end } = useMemo(() => timelineProjection(nodes, mode), [nodes, mode]);
  const selected = spans.find(span => span.event.id === selectedId || span.result?.id === selectedId);
  // 同一像素区间的节点共用绘制标记，长会话不会为每条消息新增 DOM。
  const marks = useMemo(() => {
    const bins = new Map<string, typeof spans[number]>();
    for (const span of spans) {
      const key = `${span.lane}:${Math.round(span.x * 990)}`;
      if (!bins.has(key) || span === selected) bins.set(key, span);
    }
    return [...bins.values()];
  }, [spans, selected]);
  const hovered = hover ? nodes[hover.index] : undefined;
  const label = (event: SessionTimelineEvent) => `#${formatNumber(getLanguage(), event.ordinal)} · ${event.usage ? t("sessions.timeline.usage") : event.tool ?? t(kindLabels[event.kind])} · ${turnTitle(event.turnId, 1)}`;
  const nearest = (x: number, lane: number) => spans.filter(span => span.lane === lane).reduce<typeof spans[number] | undefined>((best, span) => !best || Math.abs(span.x - x) < Math.abs(best.x - x) ? span : best, undefined);
  const time = (value: number) => formatTime(getLanguage(), value);
  return <section className="trace-timeline" aria-label={t("sessions.timeline.title")}>
    <div className="trace-timeline-head"><div role="group" aria-label={t("sessions.timeline.arrangement")}>{Object.entries(projections).map(([key, name]) => <button key={key} className="text-button" aria-pressed={mode === key} onClick={() => { setMode(key as TraceProjection); setHover(undefined); }}>{t(name)}</button>)}</div>
      <span>{loading ? t("sessions.timeline.loading") : t("sessions.timeline.nodeCount", { count: nodes.length })}</span></div>
    {error ? <p className="trace-timeline-error" role="alert"><SessionError error={error} /> <button className="text-button" onClick={onRetry}>{t("sessions.timeline.retry")}</button></p> : <>
      <div className="trace-timeline-plot"><div className="trace-lane-labels" aria-hidden="true"><span>{t("sessions.usage.input")}</span><span>{t("sessions.timeline.model")}</span><span>{t("sessions.message.tool")}</span></div>
        <svg viewBox="0 0 1000 66" preserveAspectRatio="none" role="group" tabIndex={0} aria-label={t("sessions.timeline.keyboard")} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key) || !spans.length) return;
          event.preventDefault();
          const current = selected ? spans.indexOf(selected) : -1;
          const index = event.key === "Home" ? 0 : event.key === "End" ? spans.length - 1 : event.key === "ArrowLeft" ? Math.max(0, current - 1) : event.key === "ArrowRight" ? Math.min(spans.length - 1, current + 1) : Math.max(0, current);
          onSelect(spans[index]!.event);
        }} onPointerMove={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
          const span = nearest(Math.min(1, Math.max(0, (x * 1000 - 5) / 990)), Math.min(2, Math.max(0, Math.floor(y * 3))));
          setHover(span ? { index: span.index, x: Math.min(80, x * 100), y: y * 66 } : undefined);
        }} onPointerLeave={() => setHover(undefined)} onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
          const span = nearest(Math.min(1, Math.max(0, (x * 1000 - 5) / 990)), Math.min(2, Math.max(0, Math.floor(y * 3))));
          if (span) onSelect(span.event);
        }}>
          {[22, 44].map(y => <line key={y} x1={0} x2={1000} y1={y} y2={y} className="trace-lane-divider" />)}
          {marks.map(span => <rect key={`${span.lane}:${span.x}`} x={5 + span.x * 990 - 2} y={span.lane * 22 + 7} width={5} height={9} rx={1} className={`trace-mark kind-${span.event.usage ? "usage" : span.event.kind}${span.event.status === "failure" ? " is-failure" : ""}`} />)}
          {selected && <rect x={5 + selected.x * 990 - 4} y={selected.lane * 22 + 5} width={9} height={13} rx={2} className="trace-mark-selection" />}
        </svg>
        {hovered && hover && <div className="trace-timeline-tooltip" role="tooltip" style={{ left: `calc(44px + (100% - 44px) * ${hover.x / 100})`, top: hover.y + 18 }}>
          <strong>{label(hovered.event)}</strong><span>{hovered.event.occurredAt ? formatDateTime(getLanguage(), hovered.event.occurredAt) : t("sessions.message.timeMissing")}</span>
          {hovered.event.model && <span>{hovered.event.model}</span>}{hovered.event.durationMs !== undefined && <span>{t("sessions.timeline.duration", { value: formatNumber(getLanguage(), hovered.event.durationMs) })}</span>}
        </div>}
      </div>
      <div className="trace-timeline-foot"><div className="trace-timeline-legend"><span><i className="key-user" />{t("sessions.kind.user")}</span><span><i className="key-context" />{t("sessions.kind.context")}</span><span><i className="key-model" />{t("sessions.timeline.model")}</span><span><i className="key-tool" />{t("sessions.message.tool")}</span></div>
        {mode === "time" && <span>{spans.length ? `${time(start)} → ${time(end)}` : t("sessions.timeline.noTime")}</span>}{missing > 0 && <span>{t("sessions.timeline.missingTime", { count: missing })}</span>}</div>
    </>}
  </section>;
}
