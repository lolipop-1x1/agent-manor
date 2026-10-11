import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { UsageGroup, UsageMetric, UsageReport, UsageSeries, UsageTimeBucket } from "../../../src/usage-contracts";
import { clientLabel, useI18n } from "../../shared/i18n";
import { CLIENTS } from "../../../src/clients";
import { usageDimensionValue } from "../../../src/usage/dimensions";
import { composition, compositionIsPartial, metricValue } from "./model";

export function groupLabel(value: string, group: UsageGroup, unknown: string): string {
  const original = usageDimensionValue(value);
  if (original === undefined) return unknown;
  if (group === "client") { const client = CLIENTS.find(client => client.id === value); if (client) return clientLabel(client.id); }
  return original;
}
export function UsageCharts({ report, metric, group, chart, onBucket, onGroup }: {
  report: UsageReport; metric: UsageMetric; group: UsageGroup; chart: "bar" | "line";
  onBucket: (bucket: UsageTimeBucket, day?: boolean) => void; onGroup: (key: string) => void;
}) {
  const { t, number, date, dateTime, percent } = useI18n();
  const plot = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(1000);
  const hasBuckets = report.buckets.length > 0;
  useEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setCanvasWidth(width); });
    observer.observe(plot.current); return () => observer.disconnect();
  }, [hasBuckets]);
  const formatValue = (value: number | null) => value === null ? "—" : number(value, metric === "cost" ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  const compactValue = (value: number) => number(value, { notation: "compact", ...(metric === "cost" ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 1 }) });
  const label = (key: string) => groupLabel(key, group, t("usage.unknown"));
  const hourly = report.query.interval === "hour";
  const bucketDate = (bucket: UsageTimeBucket) => date(hourly ? bucket.key : `${bucket.key}T00:00:00`, { year: "numeric", month: "short", day: "numeric", ...(hourly ? { timeZone: report.timezone } : {}) });
  const bucketLabel = (bucket: UsageTimeBucket) => hourly ? dateTime(bucket.key, { timeZone: report.timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : bucketDate(bucket);
  const [selected, setSelected] = useState<string>(""); const [hidden, setHidden] = useState<string[]>([]);
  const allGroups = [...report.groups].sort((left, right) => (metricValue(right.totals, metric) ?? -1) - (metricValue(left.totals, metric) ?? -1));
  const series = allGroups.slice(0, 5); const rest = allGroups.slice(5);
  const displaySeries = [...series.map(item => ({ key: item.key, label: label(item.key) })), ...(rest.length ? [{ key: "__other", label: t("usage.chart.other") }] : [])];
  const visibleSeries = displaySeries.filter(item => !hidden.includes(item.key));
  const values = report.buckets.map(bucket => visibleSeries.map(item => {
    if (item.key !== "__other") { const matching = bucket.groups.find(value => value.key === item.key); return matching ? metricValue(matching.totals, metric) : 0; }
    const items = bucket.groups.filter(item => rest.some(value => value.key === item.key)).map(item => metricValue(item.totals, metric));
    return !items.length ? 0 : items.some(value => value !== null) ? items.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  }));
  const max = Math.max(1, ...values.map(row => chart === "bar" ? row.reduce<number>((sum, value) => sum + (value ?? 0), 0) : Math.max(0, ...row.map(value => value ?? 0))));
  const width = canvasWidth; const height = 240; const left = 62; const right = 18; const top = 16; const bottom = hourly ? 50 : 34; const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (index: number) => left + (index + .5) * plotWidth / Math.max(1, values.length);
  const y = (value: number) => top + plotHeight * (1 - value / max);
  const tickCount = Math.min(report.buckets.length, Math.max(2, Math.floor(plotWidth / 140)));
  const ticks = Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (report.buckets.length - 1) / (tickCount - 1)));
  const active = report.buckets.find(bucket => bucket.key === selected) ?? report.buckets.at(-1);
  const ranked = allGroups.slice(0, 8); const remainder = allGroups.slice(8);
  const totalsValue = metricValue(report.totals, metric);
  const remainingValue = remainder.reduce<number | null>((sum, item) => { const value = metricValue(item.totals, metric); return value === null ? sum : (sum ?? 0) + value; }, null);
  const compositionItems = composition(report.totals); const compositionTotal = compositionItems.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const maximumDay = Math.max(1, ...report.days.map(item => metricValue(item.totals, metric) ?? 0));
  const [daySelected, setDaySelected] = useState("");
  const day = report.days.find(item => item.key === daySelected);
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
  const renderRanking = (item: Pick<UsageSeries, "key"> & { value: number | null; text: string; partial?: boolean }, index: number) => <button key={item.key} className="usage-rank-row" onClick={() => { if (item.key !== "__other") onGroup(item.key); }} disabled={item.key === "__other"} style={{ "--usage-series": `var(--usage-series-${index % 6})` } as CSSProperties}>
    <span className="usage-rank-label" title={item.text}>{item.text}{item.partial && <em className="usage-warning">{t("usage.partial")}</em>}</span><span className="usage-rank-track"><span style={{ width: `${item.value === null ? 0 : Math.max(0, item.value / Math.max(1, metricValue(allGroups[0]?.totals ?? report.totals, metric) ?? 1) * 100)}%` }} /></span><span className="usage-number">{formatValue(item.value)}</span><small>{item.value !== null && totalsValue ? percent(item.value / totalsValue, { maximumFractionDigits: 1 }) : "—"}</small>
  </button>;
  return <>
    <section className="usage-chart-section" aria-labelledby="usage-trend-title"><div className="usage-section-title"><h2 id="usage-trend-title">{t("usage.chart.trend")}</h2><span>{t(`usage.unit.${metric}`)}</span></div>
      {report.buckets.length ? <><div className="usage-chart-legend" role="group" aria-label={t("usage.chart.legend")}>{displaySeries.map((item, index) => <button key={item.key} aria-pressed={!hidden.includes(item.key)} onClick={() => setHidden(values => values.includes(item.key) ? values.filter(value => value !== item.key) : [...values, item.key])}><i style={{ background: `var(--usage-series-${index % 6})` }} />{item.label}</button>)}</div>
      <div className="usage-trend-scroll"><div ref={plot} className="usage-trend-plot">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("usage.chart.trend")}>
          {[0, 1, 2, 3, 4].map(index => <g key={index}><line x1={left} x2={width - right} y1={y(max * index / 4)} y2={y(max * index / 4)} className="usage-gridline" /><text x={left - 10} y={y(max * index / 4) + 4} textAnchor="end">{compactValue(max * index / 4)}</text></g>)}
          {chart === "bar" ? values.map((row, index) => { let offset = 0; return <g key={report.buckets[index]!.key}>{row.map((value, seriesIndex) => { const previous = offset; offset += value ?? 0; return value === null ? null : <rect key={visibleSeries[seriesIndex]!.key} x={x(index) - Math.max(.6, Math.min(15, plotWidth / Math.max(1, values.length) * .7)) / 2} y={y(offset)} width={Math.max(.6, Math.min(15, plotWidth / Math.max(1, values.length) * .7))} height={Math.max(0, y(previous) - y(offset))} fill={`var(--usage-series-${displaySeries.findIndex(item => item.key === visibleSeries[seriesIndex]!.key) % 6})`} />; })}</g>; }) : visibleSeries.map((item, index) => <path key={item.key} d={values.map((row, bucketIndex) => row[index] === null ? "" : `${bucketIndex === 0 || values[bucketIndex - 1]?.[index] === null ? "M" : "L"}${x(bucketIndex)},${y(row[index]!)}`).join(" ")} fill="none" stroke={`var(--usage-series-${displaySeries.findIndex(value => value.key === item.key) % 6})`} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          {ticks.map(index => { const bucket = report.buckets[index]!; return <text key={bucket.key} x={x(index)} y={height - (hourly ? 25 : 9)} textAnchor={ticks.length === 1 ? "middle" : index === 0 ? "start" : index === report.buckets.length - 1 ? "end" : "middle"}>{bucketDate(bucket)}{hourly && <tspan x={x(index)} dy="14">{dateTime(bucket.key, { timeZone: report.timezone, hour: "numeric", minute: "2-digit" })}</tspan>}</text>; })}
        </svg>
        <div className="usage-bucket-targets" style={{ left: `${left / width * 100}%`, right: `${right / width * 100}%`, bottom: `${bottom / height * 100}%`, top: `${top / height * 100}%` }}>{report.buckets.map(bucket => <button key={bucket.key} aria-label={t("usage.chart.selected", { time: bucketLabel(bucket), value: formatValue(metricValue(bucket.totals, metric)), unit: t(`usage.unit.${metric}`) })} aria-pressed={active?.key === bucket.key} onMouseEnter={() => setSelected(bucket.key)} onFocus={() => setSelected(bucket.key)} onClick={() => setSelected(bucket.key)} />)}</div>
      </div></div>
      {active && <div className="usage-chart-detail" aria-live="polite"><strong>{bucketLabel(active)}</strong><span className="usage-number">{formatValue(metricValue(active.totals, metric))} {t(`usage.unit.${metric}`)}</span>{active.groups.map(item => <span key={item.key}>{label(item.key)} <b>{formatValue(metricValue(item.totals, metric))}</b></span>)}{metric === "cost" && (active.totals.unpricedRequests + active.totals.partiallyPricedRequests > 0) && <span className="usage-warning">{t("usage.coverage.cost", { complete: active.totals.pricedRequests, partial: active.totals.partiallyPricedRequests, missing: active.totals.unpricedRequests })}</span>}{metric === "tokens" && (active.totals.partialTokenRequests + active.totals.missingTokenRequests > 0) && <span className="usage-warning">{t("usage.coverage.tokens", { complete: active.totals.completeTokenRequests, partial: active.totals.partialTokenRequests, missing: active.totals.missingTokenRequests })}</span>}<button className="text-button" onClick={() => onBucket(active)}>{t("usage.chart.filterBucket")}</button></div>}
      </> : <div className="usage-empty">{t("usage.chart.noData")}</div>}
    </section>
    <div className="usage-analysis-row"><section className="usage-chart-section" aria-labelledby="usage-composition-title"><div className="usage-section-title"><h2 id="usage-composition-title">{t("usage.chart.composition")}</h2><span>{t("usage.unit.tokens")}</span></div>
      <div className="usage-composition-strip" aria-hidden="true">{compositionItems.map((item, index) => <span key={item.key} style={{ width: `${compositionTotal ? (item.value ?? 0) / compositionTotal * 100 : 0}%`, background: `var(--usage-series-${index})` }} />)}</div>
      <dl className="usage-composition-values">{compositionItems.map((item, index) => <div key={item.key}><dt><i style={{ background: `var(--usage-series-${index})` }} />{t(`usage.composition.${item.key}`)}</dt><dd>{item.value === null ? "—" : number(item.value)}</dd></div>)}</dl>
      {partialComposition && <div className="usage-warning">{t("usage.composition.partial")}</div>}
    </section><section className="usage-chart-section" aria-labelledby="usage-ranking-title"><div className="usage-section-title"><h2 id="usage-ranking-title">{t("usage.chart.ranking")}</h2><span>{t(`usage.group.${group}`)} · {t(`usage.unit.${metric}`)}</span></div><div className="usage-ranking">{ranked.map((item, index) => renderRanking({ key: item.key, value: metricValue(item.totals, metric), text: label(item.key), partial: metric === "cost" ? item.totals.partiallyPricedRequests + item.totals.unpricedRequests > 0 : metric === "tokens" && item.totals.partialTokenRequests + item.totals.missingTokenRequests > 0 }, index))}{remainder.length > 0 && renderRanking({ key: "__other", value: remainingValue, text: t("usage.chart.other"), partial: remainder.some(item => metric === "cost" ? item.totals.partiallyPricedRequests + item.totals.unpricedRequests > 0 : metric === "tokens" && item.totals.partialTokenRequests + item.totals.missingTokenRequests > 0) }, 4)}{!ranked.length && <div className="usage-empty">{t("usage.chart.noData")}</div>}</div></section></div>
    <section className="usage-chart-section" aria-labelledby="usage-heatmap-title"><div className="usage-section-title"><h2 id="usage-heatmap-title">{t("usage.chart.heatmap")}</h2><div className="usage-heatmap-scale"><span>{t("usage.chart.low")}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-level-${level}`} />)}<span>{t("usage.chart.high")}</span><span>{formatValue(0)} – {formatValue(maximumDay)} {t(`usage.unit.${metric}`)}</span></div></div>
      <div className="usage-heatmap-scroll"><div className="usage-calendar"><div className="usage-calendar-weekdays" aria-hidden="true">{[0, 2, 4, 6].map(offset => <span key={offset} style={{ gridRow: offset + 1 }}>{date(new Date(2026, 0, 5 + offset), { weekday: "short" })}</span>)}</div><div><div className="usage-heatmap-months" style={{ width: `${Math.ceil(calendar.length / 7) * 18}px` }}>{monthLabels.map(item => <span key={item.key} style={{ left: `${item.column * 18}px` }}>{date(`${item.key}T00:00:00`, { year: "numeric", month: "short" })}</span>)}</div><div className="usage-heatmap">{calendar.map(item => { if (!item.bucket) return <i key={item.key} />; const value = metricValue(item.bucket.totals, metric); const level = value === null ? "missing" : value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / maximumDay * 4))); return <button key={item.key} className={`usage-level-${level}`} aria-label={t("usage.chart.selected", { time: date(`${item.key}T00:00:00`), value: formatValue(value), unit: t(`usage.unit.${metric}`) })} aria-pressed={daySelected === item.key} onFocus={() => setDaySelected(item.key)} onMouseEnter={() => setDaySelected(item.key)} onClick={() => { setDaySelected(item.key); onBucket(item.bucket!, true); }} />; })}</div></div></div></div>
      {day && <div className="usage-chart-detail" aria-live="polite"><strong>{date(`${day.key}T00:00:00`)}</strong><span>{formatValue(metricValue(day.totals, metric))} {t(`usage.unit.${metric}`)}</span>{metric === "cost" && day.totals.partiallyPricedRequests + day.totals.unpricedRequests > 0 && <span className="usage-warning">{t("usage.coverage.cost", { complete: day.totals.pricedRequests, partial: day.totals.partiallyPricedRequests, missing: day.totals.unpricedRequests })}</span>}{metric === "tokens" && day.totals.partialTokenRequests + day.totals.missingTokenRequests > 0 && <span className="usage-warning">{t("usage.coverage.tokens", { complete: day.totals.completeTokenRequests, partial: day.totals.partialTokenRequests, missing: day.totals.missingTokenRequests })}</span>}</div>}{!calendar.length && <div className="usage-empty">{t("usage.chart.noData")}</div>}
    </section>
  </>;
}
