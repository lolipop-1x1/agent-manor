import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { X } from "@phosphor-icons/react";
import type { OverviewViewReport } from "../../../src/overview-contracts";
import { useChartWidth } from "../../shared/charts/useChartWidth";
import { useI18n } from "../../shared/i18n";
import { formatTokenMillions } from "../usage/format";
import { overviewCalendarDate, type OverviewRoute } from "./model";
import { trendAxis, trendBucketAt, trendBuckets, trendDateTicks, trendDisplay, trendLine } from "./trend";

export function UsageTrend({ report, route, disabled = false, onBucket }: {
  report: Required<Pick<OverviewViewReport, "range" | "usage">>; route: OverviewRoute;
  disabled?: boolean; onBucket: (from: string, to: string) => void;
}) {
  const { t, number, date, language } = useI18n();
  const plot = useRef<HTMLDivElement>(null), selector = useRef<HTMLDivElement>(null);
  const width = useChartWidth(plot), clipId = useId();
  const buckets = useMemo(() => trendBuckets(report.usage.days, route.interval, route.metric), [report.usage.days, route.interval, route.metric]);
  const [selected, setSelected] = useState(0), [detail, setDetail] = useState(false);
  const pinned = useRef(false), touch = useRef(false), suppressFocus = useRef(false), restoreFocus = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  const cancelClose = () => { if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  useEffect(() => { setSelected(0); setDetail(false); pinned.current = false; cancelClose(); return cancelClose; }, [buckets, disabled]);
  const crossYear = buckets[0]?.from.slice(0, 4) !== buckets.at(-1)?.to.slice(0, 4);
  const height = 180, left = 64, right = 12, top = 12, bottom = crossYear ? 44 : 30;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  const axis = trendAxis(Math.max(0, ...buckets.map(bucket => bucket.value ?? 0)), route.metric === "requests");
  const dense = trendDisplay(route.interval, buckets.length, plotWidth) === "line";
  const x = (index: number) => left + (index + .5) * plotWidth / Math.max(1, buckets.length);
  const y = (value: number) => top + plotHeight * (1 - value / axis.max);
  const barWidth = Math.min(18, plotWidth / Math.max(1, buckets.length) * .7);
  const activeIndex = Math.min(selected, buckets.length - 1), active = buckets[activeIndex];
  const amount = (value: number | null) => value == null ? "—" : route.metric === "tokens" ? formatTokenMillions(language, value)
    : number(value, route.metric === "cost" ? { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  const axisAmount = (value: number) => route.metric === "cost" ? number(value, { style: "currency", currency: "USD", minimumFractionDigits: 2,
    maximumFractionDigits: Math.min(6, Math.max(2, Math.ceil(-Math.log10(axis.ticks[1] ?? 1)))) }) : amount(value);
  const label = (bucket: typeof buckets[number]) => bucket.from === bucket.to ? date(overviewCalendarDate(bucket.from))
    : t("overview.range", { from: date(overviewCalendarDate(bucket.from)), to: date(overviewCalendarDate(bucket.to)) });
  const metricLabel = (bucket: typeof buckets[number]) => t(bucket.value !== null && bucket.partial && route.metric !== "requests"
    ? route.metric === "tokens" ? "overview.metric.tokenSubtotal" : "overview.metric.costSubtotal" : `overview.metric.${route.metric}`);
  const dateTicks = trendDateTicks(buckets, plotWidth);
  const tickDay = (index: number) => index > 0 && index === buckets.length - 1 ? buckets[index]!.to : buckets[index]!.from;
  const show = (index: number, rect: DOMRect) => {
    if (disabled) return;
    cancelClose();
    anchor.current = { getBoundingClientRect: () => rect }; setSelected(index); setDetail(true);
  };
  const close = () => { cancelClose(); restoreFocus.current = pinned.current || Boolean(document.activeElement?.closest(".overview-trend-popover")); pinned.current = false; setDetail(false); };
  const leave = () => {
    cancelClose();
    if (!pinned.current && document.activeElement !== selector.current && !document.activeElement?.closest(".overview-trend-popover")) {
      closeTimer.current = setTimeout(() => setDetail(false), 150);
    }
  };
  const openRecords = () => { if (!disabled && active) { close(); restoreFocus.current = false; onBucket(active.from, active.to); } };
  return <Popover.Root open={detail && !disabled} onOpenChange={open => { if (!open) close(); }}>
    <div ref={plot} className="overview-trend" data-chart={dense ? "line" : "bar"}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("overview.usage.title")}>
        <defs><clipPath id={clipId}><rect x={left} y={top - 2} width={plotWidth} height={plotHeight + 4} /></clipPath></defs>
        {axis.ticks.map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="overview-trend-grid" />
          <text x={left - 10} y={y(value) + 4} textAnchor="end">{axisAmount(value)}</text></g>)}
        <g clipPath={`url(#${clipId})`}>
          {dense ? <><path d={trendLine(buckets, x, y)} className="overview-trend-line" vectorEffect="non-scaling-stroke" />
            {buckets.map((bucket, index) => bucket.value !== null && buckets[index - 1]?.value == null && buckets[index + 1]?.value == null
              ? <circle key={bucket.from} cx={x(index)} cy={y(bucket.value)} r={2} className="overview-trend-point" /> : null)}</>
            : buckets.map((bucket, index) => bucket.value === null ? <line key={bucket.from} x1={x(index) - barWidth / 2} x2={x(index) + barWidth / 2}
              y1={y(0)} y2={y(0)} className="overview-trend-missing" /> : <rect key={bucket.from} x={x(index) - barWidth / 2} y={y(bucket.value)}
              width={barWidth} height={y(0) - y(bucket.value)} className="overview-trend-bar" />)}
          {detail && active && <><line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={y(0)} className="overview-trend-reference" />
            {active.value !== null && <circle cx={x(activeIndex)} cy={y(active.value)} r={3} className="overview-trend-point" />}</>}
        </g>
        {dateTicks.map((index, position) => <text key={buckets[index]!.from} x={x(index)} y={height - (crossYear ? 22 : 8)}
          textAnchor={buckets.length === 1 ? "middle" : index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}>
          {date(overviewCalendarDate(tickDay(index)), { month: "short", day: "numeric" })}
          {crossYear && (position === 0 || index === buckets.length - 1 || buckets[index]!.from.slice(0, 4) !== buckets[dateTicks[position - 1]!]!.from.slice(0, 4))
            && <tspan x={x(index)} dy={14}>{date(overviewCalendarDate(tickDay(index)), { year: "numeric" })}</tspan>}</text>)}
      </svg>
      {active && <div ref={selector} className="overview-trend-selector" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
        aria-label={t("overview.usage.selectInterval")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={buckets.length}
        aria-valuenow={activeIndex + 1} aria-valuetext={t("overview.usage.selected", { time: label(active), metric: metricLabel(active), value: amount(active.value) })}
        style={{ left, right, top, bottom }}
        onPointerMove={event => { if (!pinned.current && (event.pointerType === "mouse" || event.buttons)) {
          const rect = event.currentTarget.getBoundingClientRect(); show(trendBucketAt(event.clientX - rect.left, rect.width, buckets.length), new DOMRect(event.clientX, event.clientY, 0, 0));
        } }}
        onPointerLeave={leave}
        onPointerDown={event => {
          touch.current = event.pointerType !== "mouse"; pinned.current = touch.current;
          if (document.activeElement !== event.currentTarget) { suppressFocus.current = true; event.currentTarget.focus({ preventScroll: true }); }
          const rect = event.currentTarget.getBoundingClientRect(); show(trendBucketAt(event.clientX - rect.left, rect.width, buckets.length), new DOMRect(event.clientX, event.clientY, 0, 0));
        }}
        onClick={() => { if (!touch.current) openRecords(); }}
        onFocus={event => { if (suppressFocus.current) { suppressFocus.current = false; return; } show(activeIndex, event.currentTarget.getBoundingClientRect()); }}
        onBlur={event => { if (!(event.relatedTarget as HTMLElement | null)?.closest(".overview-trend-popover")) leave(); }}
        onKeyDown={event => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault(); const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
            const index = event.key === "Home" ? 0 : event.key === "End" ? buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, activeIndex + direction));
            show(index, event.currentTarget.getBoundingClientRect());
          } else if (event.key === "Enter") { event.preventDefault(); openRecords(); }
          else if (event.key === " ") { event.preventDefault(); pinned.current = true; show(activeIndex, event.currentTarget.getBoundingClientRect()); }
          else if (event.key === "Escape") { event.preventDefault(); close(); }
        }} />}
    </div>
    <Popover.Anchor virtualRef={anchor} />
    <Popover.Portal><Popover.Content className="filter-menu overview-day-popover overview-trend-popover" side="top" sideOffset={10} collisionPadding={12}
      aria-label={t("usage.chart.intervalDetails")} onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); if (restoreFocus.current && !disabled && document.activeElement !== selector.current) { suppressFocus.current = true; selector.current?.focus({ preventScroll: true }); } restoreFocus.current = false; }}
      onPointerEnter={cancelClose} onPointerLeave={leave}
      onInteractOutside={event => { if ((event.target as HTMLElement).closest(".overview-trend-selector")) event.preventDefault(); }}>
      {active && <><header><strong>{label(active)}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.chart.intervalDetails") })}><X size={16} /></Popover.Close></header>
        <dl><div><dt>{metricLabel(active)}</dt><dd>{amount(active.value)}</dd></div></dl>
        <button className="text-button" disabled={disabled} onClick={openRecords}>{t("overview.records")}</button></>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
