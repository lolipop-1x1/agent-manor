import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarBlank, ChartLineUp, SquaresFour, ChartBarHorizontal, X } from "@phosphor-icons/react";
import type { UsageGroup, UsageMetric, UsageReport, UsageSeries, UsageTimeBucket, UsageTotals } from "../../../src/usage-contracts";
import { clientLabel, useI18n } from "../../shared/i18n";
import { CLIENTS } from "../../../src/clients";
import { usageDimensionValue } from "../../../src/usage/dimensions";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useChartWidth } from "../../shared/charts/useChartWidth";
import { composition, compositionIsPartial, metricValue } from "./model";
import { formatTokenMillions } from "./format";
import { TokenAmount } from "./TokenAmount";
import { UsageAttribution } from "./UsageAttribution";
import "./usage-charts.css";

export function groupLabel(value: string, group: UsageGroup, unknown: string): string {
  const original = usageDimensionValue(value);
  if (original === undefined) return unknown;
  if (group === "client") { const client = CLIENTS.find(client => client.id === value); if (client) return clientLabel(client.id); }
  return original;
}
export function UsageCharts({ report, metric, group, chart, attribution, onAttribution, onGroup }: {
  report: UsageReport; metric: UsageMetric; group: UsageGroup; chart: "bar" | "line";
  attribution: "treemap" | "bar"; onAttribution: (view: "treemap" | "bar") => void; onGroup: (key: string) => void;
}) {
  const { t, number, date, dateTime, percent, language } = useI18n();
  const plot = useRef<HTMLDivElement>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const [timeView, setTimeView] = useState<"trend" | "calendar">("trend");
  const [selected, setSelected] = useState("");
  const [daySelected, setDaySelected] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ bucket: UsageTimeBucket; day: boolean } | null>(null);
  const pinned = useRef(false);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const restoreDetailFocus = useRef(false);
  const suppressDetailFocus = useRef(false);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  const showDetail = (bucket: UsageTimeBucket, rect: DOMRect, day = false) => {
    detailTrigger.current = day ? dayButtons.current.get(bucket.key) ?? null : plot.current?.querySelector<HTMLElement>(".usage-bucket-selector") ?? null;
    anchor.current = { getBoundingClientRect: () => rect };
    setDetail({ bucket, day });
  };
  const closeDetail = () => { restoreDetailFocus.current = pinned.current || document.activeElement === detailTrigger.current; pinned.current = false; setDetail(null); };
  useEffect(() => { pinned.current = false; restoreDetailFocus.current = false; setDetail(null); }, [report, timeView]);
  const hasBuckets = report.buckets.length > 0;
  const canvasWidth = useChartWidth(plot, hasBuckets && timeView === "trend");
  const formatValue = (value: number | null) => value === null ? "—" : metric === "tokens" ? formatTokenMillions(language, value) : number(value, metric === "cost" ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  const compactValue = (value: number) => metric === "tokens" ? formatTokenMillions(language, value) : number(value, { notation: "compact", ...(metric === "cost" ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 1 }) });
  const unit = metric === "tokens" ? t("usage.unit.millions") : metric === "cost" ? "" : t("usage.unit.requests");
  const fullLabel = (key: string) => groupLabel(key, group, t("usage.unknown"));
  const label = (key: string) => group === "project" ? fullLabel(key).split(/[\\/]/).filter(Boolean).at(-1) ?? fullLabel(key) : fullLabel(key);
  const hourly = report.query.interval === "hour";
  const dayLabel = (key: string) => date(`${key}T00:00:00`, { year: "numeric", month: "short", day: "numeric" });
  const bucketDate = (bucket: UsageTimeBucket) => hourly ? date(bucket.key, { timeZone: report.timezone, year: "numeric", month: "short", day: "numeric" }) : dayLabel(bucket.key);
  const bucketLabel = (bucket: UsageTimeBucket) => hourly ? dateTime(bucket.key, { timeZone: report.timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : bucketDate(bucket);
  const selectedLabel = (bucket: UsageTimeBucket, day = false) => t("usage.chart.selected", { time: day ? dayLabel(bucket.key) : bucketLabel(bucket), value: formatValue(metricValue(bucket.totals, metric)), unit });
  const coverageText = (totals: UsageTotals) => metric === "cost" && totals.partiallyPricedRequests + totals.unpricedRequests > 0
    ? t("usage.coverage.cost", { complete: totals.pricedRequests, partial: totals.partiallyPricedRequests, missing: totals.unpricedRequests })
    : metric === "tokens" && totals.partialTokenRequests + totals.missingTokenRequests > 0
      ? t("usage.coverage.tokens", { complete: totals.completeTokenRequests, partial: totals.partialTokenRequests, missing: totals.missingTokenRequests }) : null;
  const allGroups = [...report.groups].sort((left, right) => (metricValue(right.totals, metric) ?? -1) - (metricValue(left.totals, metric) ?? -1));
  const series = allGroups.slice(0, 5); const rest = allGroups.slice(5);
  const displaySeries = [...series.map(item => ({ key: item.key, label: label(item.key), title: fullLabel(item.key) })), ...(rest.length ? [{ key: "__other", label: t("usage.chart.other"), title: t("usage.chart.other") }] : [])];
  const visibleSeries = displaySeries.filter(item => !hidden.includes(item.key));
  const values = report.buckets.map(bucket => visibleSeries.map(item => {
    if (item.key !== "__other") { const matching = bucket.groups.find(value => value.key === item.key); return matching ? metricValue(matching.totals, metric) : 0; }
    const items = bucket.groups.filter(item => rest.some(value => value.key === item.key)).map(item => metricValue(item.totals, metric));
    return !items.length ? 0 : items.some(value => value !== null) ? items.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  }));
  const max = Math.max(1, ...values.map(row => chart === "bar" ? row.reduce<number>((sum, value) => sum + (value ?? 0), 0) : Math.max(0, ...row.map(value => value ?? 0))));
  const width = canvasWidth; const height = 320; const left = 76; const right = 18; const top = 18; const bottom = hourly ? 62 : 44; const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (index: number) => left + (index + .5) * plotWidth / Math.max(1, values.length);
  const y = (value: number) => top + plotHeight * (1 - value / max);
  const tickCount = Math.min(report.buckets.length, Math.max(2, Math.floor(plotWidth / 170)));
  const ticks = Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (report.buckets.length - 1) / (tickCount - 1)));
  const selectedIndex = report.buckets.findIndex(bucket => bucket.key === selected);
  const activeIndex = selectedIndex < 0 ? report.buckets.length - 1 : selectedIndex;
  const active = report.buckets[activeIndex];
  const bucketAt = (clientX: number, target: HTMLDivElement) => {
    const bounds = target.getBoundingClientRect();
    return Math.max(0, Math.min(report.buckets.length - 1, Math.floor((clientX - bounds.left) / bounds.width * report.buckets.length)));
  };
  const ranked = allGroups.slice(0, 8); const remainder = allGroups.slice(8);
  const totalsValue = metricValue(report.totals, metric);
  const remainingValue = remainder.reduce<number | null>((sum, item) => { const value = metricValue(item.totals, metric); return value === null ? sum : (sum ?? 0) + value; }, null);
  const compositionItems = composition(report.totals); const compositionTotal = compositionItems.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const maximumDay = Math.max(1, ...report.days.map(item => metricValue(item.totals, metric) ?? 0));
  const selectedDayIndex = report.days.findIndex(item => item.key === daySelected);
  const activeDayIndex = selectedDayIndex < 0 ? report.days.length - 1 : selectedDayIndex;
  const day = report.days[activeDayIndex];
  const calendar = useMemo(() => {
    const items: { key: string; bucket?: UsageTimeBucket }[] = [];
    if (!report.days.length) return items;
    const first = new Date(`${report.days[0]!.key}T00:00:00`);
    for (let index = 0; index < (first.getDay() + 6) % 7; index++) items.push({ key: `empty-${index}` });
    items.push(...report.days.map(bucket => ({ key: bucket.key, bucket })));
    return items;
  }, [report.days]);
  const partialComposition = compositionIsPartial(report.totals);
  const monthLabels = calendar.flatMap((item, index) => item.bucket && (index === 0 || !calendar[index - 1]?.bucket || calendar[index - 1]!.key.slice(0, 7) !== item.key.slice(0, 7)) ? [{ key: item.key, column: Math.floor(index / 7) }] : []).filter((item, index, items) => index === 0 || item.column - items[index - 1]!.column >= 4);
  const selectedTime = timeView === "trend" ? active : day;
  const rankingItems = [...ranked.map(item => ({ key: item.key, value: metricValue(item.totals, metric), text: label(item.key), coverage: coverageText(item.totals) })),
    ...(remainder.length ? [{ key: "__other", value: remainingValue, text: t("usage.chart.other"), coverage: null }] : [])];
  const attributionItems = rankingItems.map(item => ({ ...item, title: `${item.key === "__other" ? item.text : fullLabel(item.key)} · ${formatValue(item.value)} · ${item.value !== null && totalsValue ? percent(item.value / totalsValue) : "—"}${metric === "tokens" && item.value !== null ? ` (${t("usage.tokens.exact", { count: item.value })})` : ""}` }));
  const renderRanking = (item: Pick<UsageSeries, "key"> & { value: number | null; text: string; coverage?: string | null }, index: number) => <button key={item.key} className="usage-rank-row" onClick={() => { if (item.key !== "__other") onGroup(item.key); }} disabled={item.key === "__other"} style={{ "--usage-series": `var(--usage-series-${index % 6})` } as CSSProperties}>
    <span className="usage-rank-label"><span className="usage-rank-name" title={item.coverage ? `${item.text} — ${item.coverage}` : item.text}>{item.text}</span></span>
    <span className="usage-rank-track"><span style={{ width: `${item.value === null ? 0 : Math.max(0, item.value / Math.max(1, metricValue(allGroups[0]?.totals ?? report.totals, metric) ?? 1) * 100)}%` }} /></span>
    <span className="usage-number" title={metric === "tokens" && item.value !== null ? t("usage.tokens.exact", { count: item.value }) : undefined}>{formatValue(item.value)}</span><small>{item.value !== null && totalsValue ? percent(item.value / totalsValue, { maximumFractionDigits: 1 }) : "—"}</small>
  </button>;
  return <div className="usage-charts">
    <section className="usage-chart-section usage-time-analysis" aria-labelledby="usage-time-title">
      <div className="usage-section-title"><h2 id="usage-time-title">{t("usage.chart.timeAnalysis")}</h2>
        <div className="usage-time-actions"><div className="usage-segmented usage-time-switch" role="group" aria-label={t("usage.chart.view")}>
          <button type="button" aria-pressed={timeView === "trend"} onClick={() => setTimeView("trend")}><ChartLineUp size={17} aria-hidden="true" />{t("usage.chart.trend")}</button>
          <button type="button" aria-pressed={timeView === "calendar"} onClick={() => setTimeView("calendar")}><CalendarBlank size={17} aria-hidden="true" />{t("usage.chart.calendar")}</button>
        </div><HelpPopover label={t("usage.chart.timeHelp")} iconOnly><p>{t("usage.chart.timeHelpText")}</p>{selectedTime && coverageText(selectedTime.totals) && <p><strong>{timeView === "calendar" ? dayLabel(selectedTime.key) : bucketLabel(selectedTime)}</strong><br />{coverageText(selectedTime.totals)}</p>}</HelpPopover></div>
      </div>
      {timeView === "trend" ? report.buckets.length ? <>
        <div className="usage-trend-header"><span className="usage-chart-unit">{unit}</span><div className="usage-chart-legend" role="group" aria-label={t("usage.chart.legend")}>{displaySeries.map((item, index) => <button key={item.key} title={item.title} aria-pressed={!hidden.includes(item.key)} onClick={() => setHidden(values => values.includes(item.key) ? values.filter(value => value !== item.key) : [...values, item.key])}><i style={{ background: hidden.includes(item.key) ? "var(--surface-alt)" : `var(--usage-series-${index % 6})` }} /><span>{item.label}</span></button>)}</div></div>
        <div className="usage-trend-scroll"><div ref={plot} className="usage-trend-plot">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("usage.chart.trend")}>
            {[0, 1, 2, 3, 4].map(index => <g key={index}><line x1={left} x2={width - right} y1={y(max * index / 4)} y2={y(max * index / 4)} className="usage-gridline" /><text x={left - 10} y={y(max * index / 4) + 4} textAnchor="end">{compactValue(max * index / 4)}</text></g>)}
            {chart === "bar" ? values.map((row, index) => { let offset = 0; return <g key={report.buckets[index]!.key}>{row.map((value, seriesIndex) => { const previous = offset; offset += value ?? 0; return value === null ? null : <rect key={visibleSeries[seriesIndex]!.key} x={x(index) - Math.max(.6, Math.min(15, plotWidth / Math.max(1, values.length) * .7)) / 2} y={y(offset)} width={Math.max(.6, Math.min(15, plotWidth / Math.max(1, values.length) * .7))} height={Math.max(0, y(previous) - y(offset))} fill={`var(--usage-series-${displaySeries.findIndex(item => item.key === visibleSeries[seriesIndex]!.key) % 6})`} />; })}</g>; }) : visibleSeries.map((item, index) => <path key={item.key} d={values.map((row, bucketIndex) => row[index] === null ? "" : `${bucketIndex === 0 || values[bucketIndex - 1]?.[index] === null ? "M" : "L"}${x(bucketIndex)},${y(row[index]!)}`).join(" ")} fill="none" stroke={`var(--usage-series-${displaySeries.findIndex(value => value.key === item.key) % 6})`} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
            {active && <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={height - bottom} className="usage-chart-reference" />}
            {ticks.map(index => { const bucket = report.buckets[index]!; return <text key={bucket.key} x={x(index)} y={height - (hourly ? 30 : 12)} textAnchor={ticks.length === 1 ? "middle" : index === 0 ? "start" : index === report.buckets.length - 1 ? "end" : "middle"}>{bucketDate(bucket)}{hourly && <tspan x={x(index)} dy="17">{dateTime(bucket.key, { timeZone: report.timezone, hour: "numeric", minute: "2-digit" })}</tspan>}</text>; })}
          </svg>
          {active && <div className="usage-bucket-selector" role="slider" tabIndex={0} aria-label={t("usage.chart.selectInterval")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={report.buckets.length} aria-valuenow={activeIndex + 1} aria-valuetext={selectedLabel(active)}
            style={{ left: `${left / width * 100}%`, right: `${right / width * 100}%`, bottom: `${bottom / height * 100}%`, top: `${top / height * 100}%` }}
            onPointerMove={event => { if (event.pointerType === "mouse" || event.buttons) { const bucket = report.buckets[bucketAt(event.clientX, event.currentTarget)]!; setSelected(bucket.key); showDetail(bucket, new DOMRect(event.clientX, event.clientY, 0, 0)); } }}
            onPointerLeave={() => { if (!pinned.current) setDetail(null); }}
            onFocus={event => { if (suppressDetailFocus.current) { suppressDetailFocus.current = false; return; } if (!detail) showDetail(active, event.currentTarget.getBoundingClientRect()); }}
            onPointerDown={event => { event.currentTarget.focus({ preventScroll: true }); const bucket = report.buckets[bucketAt(event.clientX, event.currentTarget)]!; setSelected(bucket.key); pinned.current = true; showDetail(bucket, new DOMRect(event.clientX, event.clientY, 0, 0)); }}
            onKeyDown={event => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
                const index = event.key === "Home" ? 0 : event.key === "End" ? report.buckets.length - 1 : Math.max(0, Math.min(report.buckets.length - 1, activeIndex + direction));
                setSelected(report.buckets[index]!.key); showDetail(report.buckets[index]!, event.currentTarget.getBoundingClientRect());
              } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); pinned.current = true; showDetail(active, event.currentTarget.getBoundingClientRect()); }
            }} />}
        </div></div>
      </> : <div className="usage-empty">{t("usage.chart.noData")}</div> : <>
        <div className="usage-heatmap-scale"><span>{t("usage.chart.low")}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-level-${level}`} />)}<span>{t("usage.chart.high")}</span><span>{formatValue(0)} – {formatValue(maximumDay)} {unit}</span>{report.days.some(item => metricValue(item.totals, metric) === null) && <span className="usage-calendar-missing-key"><i className="usage-level-missing" />{t("usage.chart.missing")}</span>}</div>
        <div className="usage-heatmap-scroll"><div className="usage-calendar"><div className="usage-calendar-weekdays" aria-hidden="true">{[0, 2, 4, 6].map(offset => <span key={offset} style={{ gridRow: offset + 1 }}>{date(new Date(2026, 0, 5 + offset), { weekday: "short" })}</span>)}</div><div>
          <div className="usage-heatmap-months" style={{ width: `${Math.ceil(calendar.length / 7) * 20}px` }}>{monthLabels.map(item => <span key={item.key} style={{ left: `${item.column * 20}px` }}>{date(`${item.key}T00:00:00`, { year: "numeric", month: "short" })}</span>)}</div>
          <div className="usage-heatmap" role="group" aria-label={t("usage.chart.calendar")}>{calendar.map(item => {
            if (!item.bucket) return <i key={item.key} />;
            const bucket = item.bucket; const value = metricValue(bucket.totals, metric); const level = value === null ? "missing" : value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / maximumDay * 4)));
            return <button key={item.key} ref={node => { if (node) dayButtons.current.set(item.key, node); else dayButtons.current.delete(item.key); }} className={`usage-level-${level}`} aria-label={selectedLabel(bucket, true)} aria-pressed={day?.key === item.key} tabIndex={day?.key === item.key ? 0 : -1}
              onFocus={event => { if (suppressDetailFocus.current) { suppressDetailFocus.current = false; return; } setDaySelected(item.key); showDetail(bucket, event.currentTarget.getBoundingClientRect(), true); }} onMouseEnter={event => { setDaySelected(item.key); showDetail(bucket, event.currentTarget.getBoundingClientRect(), true); }} onMouseLeave={() => { if (!pinned.current) setDetail(null); }} onClick={event => { setDaySelected(item.key); pinned.current = true; showDetail(bucket, event.currentTarget.getBoundingClientRect(), true); }}
              onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = report.days.findIndex(day => day.key === item.key);
                const direction = event.key === "ArrowRight" ? 7 : event.key === "ArrowLeft" ? -7 : event.key === "ArrowDown" ? 1 : -1;
                const next = report.days[event.key === "Home" ? 0 : event.key === "End" ? report.days.length - 1 : Math.max(0, Math.min(report.days.length - 1, index + direction))]!;
                setDaySelected(next.key); dayButtons.current.get(next.key)?.focus();
              }} />;
          })}</div>
        </div></div></div>
        {!calendar.length && <div className="usage-empty">{t("usage.chart.noData")}</div>}
      </>}
    </section>
    <div className="usage-analysis-row"><section className="usage-chart-section" aria-labelledby="usage-composition-title"><div className="usage-section-title"><h2 id="usage-composition-title">{t("usage.chart.composition")}</h2><div><HelpPopover label={t("usage.chart.compositionHelp")} iconOnly><p>{t("usage.chart.compositionHelpText")}</p>{partialComposition && <p>{t("usage.composition.partial")}</p>}<p>{t("usage.coverage.tokens", { complete: report.totals.completeTokenRequests, partial: report.totals.partialTokenRequests, missing: report.totals.missingTokenRequests })}</p></HelpPopover></div></div>
      <div className="usage-composition-strip" aria-hidden="true">{compositionItems.map((item, index) => <span key={item.key} style={{ width: `${compositionTotal ? (item.value ?? 0) / compositionTotal * 100 : 0}%`, background: `var(--usage-series-${index})` }} />)}</div>
      <dl className="usage-composition-values">{compositionItems.map((item, index) => <div key={item.key}><dt><i style={{ background: `var(--usage-series-${index})` }} />{t(`usage.composition.${item.key}`)}</dt><dd><TokenAmount value={item.value} /></dd></div>)}</dl>
    </section><section className="usage-chart-section" aria-labelledby="usage-ranking-title"><div className="usage-section-title"><h2 id="usage-ranking-title">{t("usage.chart.ranking")}</h2><div><div className="usage-segmented usage-attribution-switch" role="group" aria-label={t("usage.chart.attributionView")}><button type="button" aria-pressed={attribution === "treemap"} onClick={() => onAttribution("treemap")} aria-label={t("usage.chart.treemap")} title={t("usage.chart.treemap")}><SquaresFour size={17} /></button><button type="button" aria-pressed={attribution === "bar"} onClick={() => onAttribution("bar")} aria-label={t("usage.chart.rankingBar")} title={t("usage.chart.rankingBar")}><ChartBarHorizontal size={17} /></button></div><span className="usage-ranking-unit">{t(`usage.group.${group}`)}{unit && ` · ${unit}`}</span><HelpPopover label={t("usage.chart.rankingHelp")} iconOnly><p>{t("usage.chart.rankingHelpText")}</p><dl className="usage-chart-coverage-list">{allGroups.filter(item => coverageText(item.totals)).map(item => <div key={item.key}><dt>{label(item.key)}</dt><dd>{coverageText(item.totals)}</dd></div>)}</dl></HelpPopover></div></div>
      {attribution === "treemap" ? <UsageAttribution items={attributionItems} total={totalsValue} onGroup={onGroup} formatValue={formatValue} /> : <div className="usage-ranking">{rankingItems.map(renderRanking)}{!ranked.length && <div className="usage-empty">{t("usage.chart.noData")}</div>}</div>}
    </section></div>
    <Popover.Root open={detail !== null} onOpenChange={open => { if (!open) closeDetail(); }}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal><Popover.Content className="usage-time-popover" side="top" align="center" sideOffset={14} collisionPadding={12} aria-label={t("usage.chart.intervalDetails")}
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); if (restoreDetailFocus.current && detailTrigger.current?.isConnected && document.activeElement !== detailTrigger.current) { suppressDetailFocus.current = true; detailTrigger.current.focus({ preventScroll: true }); } }}
        onInteractOutside={event => { if ((event.target as HTMLElement).closest(".usage-bucket-selector, .usage-heatmap")) event.preventDefault(); }}>
        {detail && <><header><strong>{detail.day ? dayLabel(detail.bucket.key) : bucketLabel(detail.bucket)}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.chart.intervalDetails") })}><X size={16} /></Popover.Close></header>
          <div className="usage-time-total" title={metric === "tokens" && detail.bucket.totals.tokens !== null ? t("usage.tokens.exact", { count: detail.bucket.totals.tokens }) : undefined}>{formatValue(metricValue(detail.bucket.totals, metric))}</div>
          <dl>{detail.bucket.groups.map(item => <div key={item.key}><dt title={fullLabel(item.key)}>{label(item.key)}</dt><dd title={metric === "tokens" && item.totals.tokens !== null ? t("usage.tokens.exact", { count: item.totals.tokens }) : undefined}>{formatValue(metricValue(item.totals, metric))}</dd></div>)}</dl>
        </>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}
