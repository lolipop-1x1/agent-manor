import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ReplayResult, ReplayStep, ReplayTrack } from "../../../src/replay-contracts";
import { clientLabel, useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { replayLaneHit, replayOriginalTime, type PositionedStep, type ReplayIndex } from "./replay-model";

const emptyLane: PositionedStep[] = [];
const pathsOf = (steps: ReplayStep[]) => [...new Set(steps.flatMap(step => step.activities.flatMap(activity => activity.paths)))];
const kindKey = (kind: string) => `replay.${kind === "search" ? "searchKind" : kind}`;
export const playbackDuration = (milliseconds: number, language: string) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const number = new Intl.NumberFormat(language, { minimumIntegerDigits: 2, useGrouping: false });
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].slice(seconds >= 3600 ? 0 : 1).map(value => number.format(value)).join(":");
};

interface Preview { entries: PositionedStep[]; track: ReplayTrack; number: number; x: number; y: number }

export function ReplayTimeline({ data, index, position, zoom, height, clock, select, seek, disabled, container }: {
  data: ReplayResult; index: ReplayIndex; position: number; zoom: number; height: number; clock: (time: number) => string;
  select: (step: ReplayStep) => void; seek: (value: number) => void; disabled: boolean; container?: HTMLElement | null;
}) {
  const { t, language } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [viewportHeight, setViewportHeight] = useState(height);
  const [scrollTop, setScrollTop] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect?.width || !rect.height) return;
      setWidth(Math.max(160, rect.width - 176)); setViewportHeight(rect.height);
    });
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setPreview(null), [index, disabled, zoom]);
  const timelineWidth = width * zoom;
  const lanes = useMemo(() => {
    const result = new Map<string, PositionedStep[]>();
    for (const entry of index.timed) { const lane = result.get(entry.step.trackId) ?? []; lane.push(entry); result.set(entry.step.trackId, lane); }
    return result;
  }, [index]);
  const duration = Math.max(1, index.duration);
  const overlayTop = Math.min(scrollTop, Math.max(0, data.tracks.length * 42 + 28 - viewportHeight));
  const previewLane = useCallback((entries: PositionedStep[], track: ReplayTrack, number: number, x: number, y: number) => {
    setPreview(entries.length ? { entries, track, number, x, y } : null);
  }, []);
  // 轨道静态层不随播放头重建；同一浮层同时覆盖普通和密集 SVG 轨道。
  const trackRows = useMemo(() => data.tracks.map((track, number) => <div className="replay-track-row" data-track-id={track.id} key={track.id}>
    <div className="replay-track-label" title={track.title} style={{ paddingLeft: Math.min(track.depth, 4) * 8 + 8 }}><span className={`replay-track-number replay-track-${number % 6}`}>{number + 1}</span><span>{track.title}<small>{track.depth ? clientLabel(track.client) : t("replay.mainTrack")}{track.untimedCount ? ` · ${t("replay.untimedCount", { count: track.untimedCount })}` : ""}</small></span></div>
    <TimelineLane entries={lanes.get(track.id) ?? emptyLane} width={timelineWidth} duration={duration} number={number} track={track} disabled={disabled} clock={clock} select={select} preview={previewLane} />
  </div>), [data.tracks, lanes, timelineWidth, duration, language, disabled, select, clock, previewLane]);
  const gapElements = useMemo(() => {
    let previousLabel = -Infinity;
    const bands = [], markers = [];
    for (const [i, segment] of index.segments.filter(segment => segment.collapsed).entries()) {
      const left = segment.from / duration * timelineWidth, gapWidth = Math.max(3, (segment.to - segment.from) / duration * timelineWidth);
      const showLabel = left - previousLabel >= 24;
      if (showLabel) previousLabel = left;
      const label = t("replay.gap", { start: clock(segment.start), end: clock(segment.end) });
      bands.push(<div key={i} className="replay-gap" style={{ left, width: gapWidth }} />);
      if (showLabel) markers.push(<HelpPopover key={i} container={container} label={label}
        trigger={<button className="replay-gap-help" style={{ left: left + gapWidth / 2 }} aria-label={label} onClick={event => event.stopPropagation()}>//</button>}><p>{label}</p><p>{t("replay.gapDuration", { duration: playbackDuration(segment.end - segment.start, language) })}</p><p>{t("replay.gapDescription")}</p></HelpPopover>);
    }
    return { bands, markers };
  }, [index, timelineWidth, duration, clock, language, container]);
  const rulerLabels = useMemo(() => (timelineWidth >= 650 ? [0, .25, .5, .75, 1] : [0, .5, 1]).map(fraction => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{index.timed.length ? clock(replayOriginalTime(index, fraction * duration)) : "—"}</span>), [timelineWidth, index, duration, clock]);
  return <>
    <div className="replay-timeline-scroll" ref={scroller} style={{ height }} role="group" aria-label={t("replay.timeline")} data-disabled={disabled} onScroll={event => { setScrollTop(event.currentTarget.scrollTop); setPreview(null); }}>
      <div className="replay-timeline-content" style={{ width: timelineWidth + 176 }}>
        <div className="replay-ruler"><div className="replay-track-label">{t("replay.timeline")}</div><div className="replay-ruler-times" style={{ width: timelineWidth }} onClick={event => { if (!disabled) seek(Math.max(0, Math.min(duration, (event.clientX - event.currentTarget.getBoundingClientRect().left) / timelineWidth * duration))); }}>{rulerLabels}{gapElements.markers}</div></div>
        {trackRows}
        <div className="replay-timeline-overlay" style={{ left: 176, top: overlayTop, width: timelineWidth, height: viewportHeight }}>{gapElements.bands}<div className="replay-playhead" style={{ transform: `translateX(${position / duration * timelineWidth}px)` }} aria-hidden="true" /></div>
      </div>
    </div>
    {preview && !disabled && createPortal(<TimelinePreview value={preview} clock={clock} />, container ?? document.body)}
  </>;
}

function TimelinePreview({ value, clock }: { value: Preview; clock(time: number): string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 340, height: 220 });
  useEffect(() => { const rect = ref.current?.getBoundingClientRect(); if (rect) setSize({ width: rect.width, height: rect.height }); }, [value.entries]);
  const steps = value.entries.map(entry => entry.step), paths = pathsOf(steps);
  const style: CSSProperties = { left: Math.max(12, Math.min(window.innerWidth - size.width - 12, value.x + 12)), top: value.y - size.height - 12 >= 12 ? value.y - size.height - 12 : Math.max(12, Math.min(window.innerHeight - size.height - 12, value.y + 20)) };
  return <div className={`replay-timeline-preview replay-track-${value.number % 6}`} ref={ref} style={style} role="tooltip" aria-label={t("replay.timelinePreview")}>
    <strong><span className={`replay-track-number replay-track-${value.number % 6}`}>{value.number + 1}</span>{value.track.title}</strong>
    <time>{steps[0]?.time === undefined ? t("replay.noTime") : clock(steps[0].time)}</time>
    {steps.length > 1 && <p>{t("replay.overlappingCalls", { count: steps.length })}</p>}
    <div className="replay-preview-operations">{[...new Set(steps.flatMap(step => step.activities.map(activity => `${activity.kind}:${activity.status}`)))].map(key => {
      const [kind, status] = key.split(":");
      return <span key={key}><i className={`replay-symbol ${kind}`} />{t(kindKey(kind!))} · {t(`codeMap.status.${status}`)}</span>;
    })}</div>
    {paths.slice(0, 6).map(path => <code key={path}>{path}</code>)}{paths.length > 6 && <p>{t("replay.previewMoreFiles", { count: paths.length - 6 })}</p>}
  </div>;
}

const TimelineLane = memo(function TimelineLane({ entries, width, duration, number, track, select, disabled, clock, preview }: {
  entries: PositionedStep[]; width: number; duration: number; number: number; track: ReplayTrack; disabled: boolean; clock(time: number): string;
  select(step: ReplayStep): void; preview(entries: PositionedStep[], track: ReplayTrack, number: number, x: number, y: number): void;
}) {
  const { t } = useI18n();
  const [focused, setFocused] = useState(0);
  const paths = useMemo(() => {
    const groups = new Map<string, string[]>(), failures: string[] = [];
    for (const entry of entries) {
      const x = Math.max(5, Math.min(width - 5, entry.position / duration * width));
      const kind = entry.step.activities.some(activity => activity.kind === "edit") ? "edit" : entry.step.activities[0]?.kind ?? "read";
      const list = groups.get(kind) ?? [];
      list.push(kind === "edit" ? `M${x - 3} 17h6v6h-6Z` : kind === "search" ? `M${x} 15l5 5l-5 5l-5 -5Z` : `M${x - 3} 20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0`);
      groups.set(kind, list);
      // 失败单独标记；未知结果在预览和详情中按需查看，避免密集问号遮挡轨迹。
      if (entry.step.activities.some(activity => activity.status === "failure")) failures.push(`M${x + 5} 10v5m0 2v1`);
    }
    return { groups: [...groups].map(([kind, parts]) => ({ kind, d: parts.join("") })), failures: failures.join("") };
  }, [entries, width, duration]);
  const show = (values: PositionedStep[], element: HTMLElement | SVGSVGElement, pointer?: { clientX: number; clientY: number }) => {
    const rect = element.getBoundingClientRect(), entry = values[0];
    preview(values, track, number, pointer?.clientX ?? rect.left + Math.max(5, Math.min(width - 5, (entry?.position ?? 0) / duration * width)), pointer?.clientY ?? rect.top + 14);
  };
  const hit = (element: HTMLElement | SVGSVGElement, clientX: number) => {
    const coordinate = clientX - element.getBoundingClientRect().left;
    const result = replayLaneHit(entries, coordinate / width * duration);
    return result[0] && Math.abs(Math.max(5, Math.min(width - 5, result[0].position / duration * width)) - coordinate) <= 12 ? result : [];
  };
  const focusedEntry = entries[Math.min(focused, Math.max(0, entries.length - 1))];
  const label = (step: ReplayStep) => t("replay.step", { track: track.title, tool: step.activities.map(activity => `${activity.tool} (${t(`codeMap.status.${activity.status}`)})`).join(", "), time: step.time === undefined ? t("replay.noTime") : clock(step.time), count: pathsOf([step]).length });
  return <div className={`replay-lane replay-track-${number % 6}`} style={{ width }} tabIndex={disabled || !entries.length ? -1 : 0} role="slider" aria-label={t("replay.timelineLane", { track: track.title })}
    aria-valuemin={0} aria-valuemax={Math.max(0, entries.length - 1)} aria-valuenow={Math.min(focused, Math.max(0, entries.length - 1))} aria-valuetext={focusedEntry ? label(focusedEntry.step) : t("replay.noActivity")} aria-disabled={disabled || !entries.length}
    onFocus={event => { if (event.target === event.currentTarget && focusedEntry) show(replayLaneHit(entries, focusedEntry.position), event.currentTarget); }} onBlur={() => preview([], track, number, 0, 0)}
    onPointerMove={event => { if (!disabled && event.pointerType !== "touch") show(hit(event.currentTarget, event.clientX), event.currentTarget, event); }} onPointerLeave={() => preview([], track, number, 0, 0)}
    onClick={event => { if (disabled) return; const values = hit(event.currentTarget, event.clientX); if (values[0]) { preview([], track, number, 0, 0); select(values[0].step); } }}
    onKeyDown={event => {
      if (disabled || !entries.length) return;
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, focused + (event.key === "ArrowRight" ? 1 : -1)));
        setFocused(next); show(replayLaneHit(entries, entries[next]!.position), event.currentTarget);
      } else if (["Enter", " "].includes(event.key) && focusedEntry) { event.preventDefault(); preview([], track, number, 0, 0); select(focusedEntry.step); }
      else if (event.key === "Escape") { event.stopPropagation(); preview([], track, number, 0, 0); }
    }}>
    <svg width={width} height="42" aria-hidden="true">{paths.groups.map(path => <path key={path.kind} d={path.d} className={`replay-lane-points ${path.kind}`} />)}
      {paths.failures && <path d={paths.failures} className="replay-lane-status failure" />}</svg>
    {entries.length <= 250 && entries.map(entry => <button key={entry.step.id} tabIndex={-1} disabled={disabled} className="replay-step-hit" data-step-id={entry.step.id} aria-label={label(entry.step)} style={{ left: Math.max(0, Math.min(width - 16, entry.position / duration * width - 8)) }}
      onClick={event => { event.stopPropagation(); preview([], track, number, 0, 0); select(entry.step); }} />)}
  </div>;
});
