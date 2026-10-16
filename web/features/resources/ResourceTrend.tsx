import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ResourceKind, ResourceUsageTrend } from "../../../src/resource-contracts";
import { t, useI18n } from "../../shared/i18n";
import { fmt } from "../../shared/format";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ChartTooltip } from "../../shared/charts/ChartTooltip";
import { ResourceEmpty } from "./ResourceEmpty";
import { resourceTrendIndexAt } from "./resource-trend-model";

export function ResourceTrend({ rows, timeZone, kind }: { rows: ResourceUsageTrend[]; timeZone: string; kind: ResourceKind }) {
  const { date } = useI18n();
  const dates = useMemo(() => rows.map(row => Date.parse(row.date)), [rows]);
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const lastFocused = useRef(0);
  const tooltipId = useId();
  useEffect(() => { setHovered(undefined); setFocused(undefined); lastFocused.current = 0; }, [rows]);
  useEffect(() => { if (focused !== undefined) lastFocused.current = focused; }, [focused]);
  const selected = hovered ?? focused;
  const active = selected === undefined ? undefined : rows[selected];
  const current = Math.min(rows.length - 1, selected ?? lastFocused.current);
  const trendDate = (value: string) => date(`${value}T00:00:00`);
  const metricLabel = t(kind === "skill" ? "resources.column.uses" : "resources.column.calls");
  const pointLabel = (row: ResourceUsageTrend) => t("resources.trend.point", { date: trendDate(row.date),
    events: t(kind === "skill" ? "resources.map.useValue" : "resources.map.callValue", { count: row.stats.events }),
    sessions: t("resources.map.sessionValue", { count: row.stats.sessions }) });
  const max = rows.reduce((maximum, row) => Math.max(maximum, row.stats.events), 1);
  const start = dates[0] ?? 0, end = dates.at(-1) ?? start;
  const x = (value: string) => 38 + (end === start ? .5 : (Date.parse(value) - start) / (end - start)) * 238;
  const y = (events: number) => 127 - events / max * 90;
  const pointerIndex = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return resourceTrendIndexAt(dates, (event.clientX - bounds.left) / bounds.width);
  };
  return <section className="resource-detail-section">
    <header><h3>{t("resources.trend.title")}</h3><HelpPopover label={t("resources.trend.help")}><p>{t("resources.trend.helpText", { timeZone })}</p></HelpPopover></header>
    {!rows.length ? <ResourceEmpty>{t("resources.trend.empty")}</ResourceEmpty> : <>
      <div className="resource-trend-chart">
        <svg className="resource-trend" viewBox="0 0 300 163" role="img" aria-label={t("resources.trend.aria")}>
          {[0, max].map(value => <g key={value}><line x1="38" x2="279" y1={y(value)} y2={y(value)} /><text x="31" y={y(value) + 4} textAnchor="end">{fmt(value)}</text></g>)}
          <text x="38" y="18">{t("resources.trend.count")}</text>
          <polyline points={rows.map(row => `${x(row.date)},${y(row.stats.events)}`).join(" ")} />
          {rows.map(row => <circle key={row.date} cx={x(row.date)} cy={y(row.stats.events)} r="2.5" />)}
          {active && <g className="resource-trend-reference"><line x1={x(active.date)} x2={x(active.date)} y1="37" y2="127" /><circle cx={x(active.date)} cy={y(active.stats.events)} r="4" /></g>}
          <text x="38" y="150">{trendDate(rows[0]!.date)}</text><text x="279" y="150" textAnchor="end">{trendDate(rows.at(-1)!.date)}</text>
        </svg>
        <div className="resource-trend-hit" role="slider" tabIndex={0} aria-label={t("resources.trend.select")} aria-orientation="horizontal"
          aria-valuemin={1} aria-valuemax={rows.length} aria-valuenow={current + 1} aria-valuetext={pointLabel(rows[current]!)} aria-describedby={active ? tooltipId : undefined}
          onPointerMove={event => setHovered(pointerIndex(event))} onPointerLeave={() => setHovered(undefined)}
          onPointerDown={event => { const index = pointerIndex(event); setHovered(index); setFocused(index); }}
          onPointerCancel={() => { setHovered(undefined); setFocused(undefined); }}
          onFocus={() => setFocused(value => value ?? hovered ?? current)} onBlur={() => setFocused(undefined)}
          onKeyDown={event => {
            if (event.key === "Escape" && active) { event.preventDefault(); event.stopPropagation(); setHovered(undefined); setFocused(undefined); }
            else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) {
              event.preventDefault(); setHovered(undefined);
              const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
              setFocused(event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + direction)));
            }
          }} />
        {active && <ChartTooltip id={tooltipId} className="resource-trend-tooltip" position={x(active.date) / 300}>
          <strong>{trendDate(active.date)}</strong><dl><div><dt><i />{metricLabel}</dt><dd>{fmt(active.stats.events)}</dd></div><div><dt>{t("resources.column.sessions")}</dt><dd>{fmt(active.stats.sessions)}</dd></div></dl>
        </ChartTooltip>}
      </div>
      <details className="resource-data-details"><summary>{t("resources.trend.data", { count: rows.length })}</summary><div className="resource-table-scroll"><table><thead><tr><th>{t("resources.trend.date")}</th><th>{metricLabel}</th><th>{t("resources.trend.sessions")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><td>{trendDate(row.date)}</td><td>{fmt(row.stats.events)}</td><td>{fmt(row.stats.sessions)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
