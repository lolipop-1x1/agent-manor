import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { X } from "@phosphor-icons/react";
import { CLIENTS } from "../../../src/clients";
import type { UsageReport, UsageSpeedGroup } from "../../../src/usage-contracts";
import { clientLabel, formatList, useI18n } from "../../shared/i18n";
import { useChartWidth } from "../../shared/charts/useChartWidth";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { speedComparisonModel } from "./speed-model";
import { useUsageTimeInteraction } from "./useUsageTimeInteraction";

export function UsageSpeedTrend({ report, interactive, onGroups }: {
  report: UsageReport; interactive: boolean; onGroups: (keys: string[]) => void;
}) {
  const { t, number, date, dateTime } = useI18n();
  const speed = report.speed;
  const model = speedComparisonModel(speed);
  const { dates, series } = model;
  const hasPoints = model.lastEligibleIndex >= 0;
  const plot = useRef<HTMLDivElement>(null);
  const groupControls = useRef<HTMLDivElement>(null);
  const restoreGroupFocus = useRef(false);
  useEffect(() => {
    if (!interactive || !restoreGroupFocus.current) return;
    restoreGroupFocus.current = false;
    // 更新期间 inert 会阻断弹层的焦点恢复；仅在用户尚未转移焦点时补回。
    if (document.activeElement === document.body) groupControls.current?.querySelector<HTMLButtonElement>(".filter-trigger")?.focus({ preventScroll: true });
  }, [interactive, report]);
  const applyGroups = (keys: string[]) => {
    restoreGroupFocus.current = JSON.stringify(keys) !== JSON.stringify(speed?.selectedGroups ?? []);
    onGroups(keys);
  };
  const width = useChartWidth(plot, hasPoints);
  const [selected, setSelected] = useState("");
  const interaction = useUsageTimeInteraction<string>(report, interactive);
  const { detail } = interaction;
  const height = 320, left = 76, right = 18, top = 18;
  const hourly = report.query.interval === "hour", bottom = hourly ? 62 : 44;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  const x = (index: number) => left + (index + .5) * plotWidth / Math.max(1, dates.length);
  const y = (value: number) => top + plotHeight * (1 - value / model.maximum);
  const selectedIndex = dates.indexOf(selected);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : model.lastEligibleIndex;
  const active = dates[activeIndex];
  const speedValue = (value: number | null | undefined, group: UsageSpeedGroup) => value == null ? "—" : t("usage.speed.value", { approx: group.basis === "estimated" ? "≈ " : "", value: number(value, { maximumFractionDigits: 1 }) });
  const bucketDate = (key: string) => date(hourly ? key : `${key}T00:00:00`, { ...(hourly ? { timeZone: report.timezone } : {}), year: "numeric", month: "short", day: "numeric" });
  const bucketLabel = (key: string) => hourly ? dateTime(key, { timeZone: report.timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : bucketDate(key);
  const groupLabel = (item: UsageSpeedGroup) => {
    const client = CLIENTS.find(client => client.id === item.client);
    return t("usage.speed.groupLabel", { model: item.model, client: client ? clientLabel(client.id) : item.client, window: t(`usage.speed.window.${item.window}`), basis: t(`usage.speed.basis.${item.basis}`) });
  };
  const tickCount = Math.min(dates.length, Math.max(2, Math.floor(plotWidth / 170)));
  const tickX = (index: number) => tickCount > 1 && index === 0 ? left : tickCount > 1 && index === dates.length - 1 ? width - right : x(index);
  const ticks = Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (dates.length - 1) / (tickCount - 1)));
  const selectBucket = (index: number) => { const key = dates[index]!; setSelected(key); return key; };
  const marker = (item: typeof series[number]) => <svg className="usage-speed-marker" viewBox="0 0 26 10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke={item.color} strokeWidth="2.5" strokeDasharray={item.dash} /></svg>;
  const seriesTitle = (group: UsageSpeedGroup) => `${groupLabel(group)} · ${t(`sessions.speed.method.${group.method}`)}`;
  const selectedValues = active ? formatList(series.map(item => t("usage.speed.seriesValue", { group: groupLabel(item.group), value: speedValue(item.buckets.get(active)?.tokensPerSecond, item.group) }))) : "";
  return <section className="usage-chart-section usage-time-analysis usage-speed-analysis" aria-labelledby="usage-time-title">
    <div className="usage-section-title"><h2 id="usage-time-title">{t("usage.chart.timeAnalysis")}</h2><div className="usage-speed-actions" ref={groupControls}>
      <ProjectPicker multiple label={t("usage.speed.compare")} placeholder={t("usage.speed.search")} value={speed?.selectedGroups ?? []} options={(speed?.groups ?? []).map(item => ({ value: item.key, label: groupLabel(item), description: t(`sessions.speed.method.${item.method}`) }))} onChange={applyGroups} />
      <HelpPopover label={t("usage.speed.help")} iconOnly><p>{t("usage.speed.formula")}</p><p>{t("usage.speed.eligibility")}</p><p>{t("usage.speed.comparability")}</p>
        {series.map(({ group }) => <div key={group.key}><p><strong>{groupLabel(group)}</strong></p><p>{t(`sessions.speed.method.${group.method}`)}</p><p>{t(group.window === "generation" ? "sessions.speed.windowGeneration" : "sessions.speed.windowResponse")}</p><p>{t("usage.speed.groupCoverage", { eligible: group.eligibleRequests, total: group.requests })}</p></div>)}
        {speed && <><p>{t("usage.speed.coverage", { eligible: speed.eligibleRequests, total: speed.requests })}</p><p>{t("usage.speed.undated", { count: speed.missingTimeRequests })}</p></>}
        <p>{t("usage.chart.timeHelpText")}</p>
      </HelpPopover>
    </div></div>
    {!!series.length && <div className="usage-speed-legend" aria-label={t("usage.chart.legend")}>{series.map(item => <span key={item.group.key} className="usage-speed-legend-item" data-group={item.group.key} title={seriesTitle(item.group)}>{marker(item)}<span>{groupLabel(item.group)}</span></span>)}</div>}
    {hasPoints ? <><div className="usage-speed-header"><span className="usage-chart-unit">tok/s</span></div>
      <div className="usage-trend-scroll"><div className="usage-trend-plot" ref={plot}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("usage.speed.trend")}>
          {[0, 1, 2, 3, 4].map(index => <g key={index}><line x1={left} x2={width - right} y1={y(model.maximum * index / 4)} y2={y(model.maximum * index / 4)} className="usage-gridline" /><text x={left - 10} y={y(model.maximum * index / 4) + 4} textAnchor="end">{number(model.maximum * index / 4, { maximumFractionDigits: 1 })}</text></g>)}
          {series.map(item => <g className="usage-speed-series" data-group={item.group.key} key={item.group.key}>
            {item.model.segments.map((segment, index) => <path key={index} className="usage-speed-line" d={segment.map((point, index) => `${index ? "L" : "M"}${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke={item.color} strokeDasharray={item.dash} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
            {item.model.points.map(point => <circle className="usage-speed-point" key={dates[point.index]!} cx={x(point.index)} cy={y(point.value)} r={item.model.points.length > 100 ? 2 : 3.5} fill={item.color} />)}
          </g>)}
          {active && <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={height - bottom} className="usage-chart-reference" />}
          {ticks.map(index => <text key={dates[index]!} x={tickX(index)} y={height - (hourly ? 30 : 12)} textAnchor={ticks.length === 1 ? "middle" : index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle"}>{bucketDate(dates[index]!)}{hourly && <tspan x={tickX(index)} dy="17">{dateTime(dates[index]!, { timeZone: report.timezone, hour: "numeric", minute: "2-digit" })}</tspan>}</text>)}
        </svg>
        {active && <div className="usage-bucket-selector usage-speed-selector" role="slider" tabIndex={0} aria-label={t("usage.speed.selectInterval")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={dates.length} aria-valuenow={activeIndex + 1} aria-valuetext={t("usage.speed.selected", { time: bucketLabel(active), value: selectedValues })}
          style={{ left: `${left / width * 100}%`, right: `${right / width * 100}%`, bottom: `${bottom / height * 100}%`, top: `${top / height * 100}%` }}
          {...interaction.sliderProps(dates.length, activeIndex, selectBucket)} />}
      </div></div>
    </> : <div className="usage-empty">{t(speed?.groups.length && speed.selectedGroups.length === 0 ? "usage.speed.emptySelection" : "usage.speed.noData")}</div>}
    <Popover.Root {...interaction.rootProps}>
      <Popover.Anchor virtualRef={interaction.anchor} />
      <Popover.Portal><Popover.Content className="usage-time-popover usage-speed-popover" side="top" align="center" sideOffset={14} collisionPadding={12} aria-label={t("usage.speed.intervalDetails")} {...interaction.contentProps}>
        {detail && <><header><strong>{bucketLabel(detail)}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.speed.intervalDetails") })}><X size={16} /></Popover.Close></header>
          {series.map(item => { const bucket = item.buckets.get(detail); return <section className="usage-speed-detail-group" data-group={item.group.key} key={item.group.key}>
            <h3 title={seriesTitle(item.group)}>{marker(item)}<span>{groupLabel(item.group)}</span></h3>
            <div className="usage-time-total">{speedValue(bucket?.tokensPerSecond, item.group)}</div><dl>
              <div><dt>{t("usage.speed.eligible")}</dt><dd>{bucket ? `${number(bucket.eligibleRequests)} / ${number(bucket.requests)}` : "—"}</dd></div>
              <div><dt>{t("usage.speed.output")}</dt><dd>{bucket?.outputTokens == null ? "—" : number(bucket.outputTokens)}</dd></div>
              <div><dt>{t("usage.speed.duration")}</dt><dd>{bucket?.durationMs == null ? "—" : t("sessions.speed.seconds", { value: number(bucket.durationMs / 1000, { maximumFractionDigits: 3 }) })}</dd></div>
            </dl>
          </section>; })}
        </>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </section>;
}
