import { useMemo, useState } from "react";
import type { SessionTimelineEvent } from "../src/session-contracts";
import { kindLabels } from "./SessionMessage";
import { turnTitle } from "./session-model";
import { timelineNodes, timelineProjection, type TraceProjection } from "./session-trace-model";

const projections = { sequence: "事件顺序", turn: "轮次", time: "记录时间" } as const;
export function TraceTimeline({ events, selectedId, loading, error, onSelect, onRetry }: {
  events: SessionTimelineEvent[]; selectedId?: string; loading: boolean; error?: string;
  onSelect: (event: SessionTimelineEvent) => void; onRetry: () => void;
}) {
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
  const label = (event: SessionTimelineEvent) => `#${event.ordinal} · ${event.usage ? "请求用量记录" : event.tool ?? kindLabels[event.kind]} · ${turnTitle(event.turnId, 1)}`;
  const nearest = (x: number, lane: number) => spans.filter(span => span.lane === lane).reduce<typeof spans[number] | undefined>((best, span) => !best || Math.abs(span.x - x) < Math.abs(best.x - x) ? span : best, undefined);
  const time = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  return <section className="trace-timeline" aria-label="会话轨迹总览">
    <div className="trace-timeline-head"><div role="group" aria-label="时间线排列方式">{Object.entries(projections).map(([key, name]) => <button key={key} className="text-button" aria-pressed={mode === key} onClick={() => { setMode(key as TraceProjection); setHover(undefined); }}>{name}</button>)}</div>
      <span>{loading ? "正在读取总览…" : `全会话 · ${nodes.length.toLocaleString("zh-CN")} 个节点`}</span></div>
    {error ? <p className="trace-timeline-error" role="alert">{error} <button className="text-button" onClick={onRetry}>重试总览</button></p> : <>
      <div className="trace-timeline-plot"><div className="trace-lane-labels" aria-hidden="true"><span>输入</span><span>模型</span><span>工具</span></div>
        <svg viewBox="0 0 1000 66" preserveAspectRatio="none" role="group" tabIndex={0} aria-label="轨迹时间线，左右方向键选择节点，回车查看详情" onKeyDown={event => {
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
          <strong>{label(hovered.event)}</strong><span>{hovered.event.occurredAt ? new Date(hovered.event.occurredAt).toLocaleString("zh-CN", { hour12: false }) : "时间未记录"}</span>
          {hovered.event.model && <span>{hovered.event.model}</span>}{hovered.event.durationMs !== undefined && <span>记录耗时 {hovered.event.durationMs.toLocaleString("zh-CN")} ms</span>}
        </div>}
      </div>
      <div className="trace-timeline-foot"><span>{mode === "time" ? spans.length ? `${time(start)} → ${time(end)}` : "没有已记录时间" : "点击任意轨道定位节点 · ← → 切换"}</span><span>{missing ? `${missing} 个节点时间未记录` : "蓝：用户 · 绿：上下文 · 紫：模型 · 金：工具"}</span></div>
    </>}
  </section>;
}
