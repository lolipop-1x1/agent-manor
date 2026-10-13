import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { X } from "@phosphor-icons/react";
import { CLIENTS } from "../../../src/clients";
import type { UsageReport, UsageSpeedGroup } from "../../../src/usage-contracts";
import { clientLabel, useI18n } from "../../shared/i18n";
import { useChartWidth } from "../../shared/charts/useChartWidth";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { speedLineModel } from "./speed-model";

export function UsageSpeedTrend({ report, interactive, onGroup }: {
  report: UsageReport; interactive: boolean; onGroup: (key: string) => void;
}) {
  const { t, number, date, dateTime } = useI18n();
  const speed = report.speed;
  const group = speed?.groups.find(item => item.key === speed.selectedGroup);
  const buckets = speed?.buckets ?? [];
  const model = speedLineModel(buckets);
  const plot = useRef<HTMLDivElement>(null);
  const selector = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const width = useChartWidth(plot, model.points.length > 0);
  const [selected, setSelected] = useState("");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const pinned = useRef(false);
  const restoreFocus = useRef(false);
  const suppressFocus = useRef(false);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  useEffect(() => { pinned.current = false; restoreFocus.current = false; setDetailKey(null); }, [report, interactive]);
  const height = 320, left = 76, right = 18, top = 18;
  const hourly = report.query.interval === "hour", bottom = hourly ? 62 : 44;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  const x = (index: number) => left + (index + .5) * plotWidth / Math.max(1, buckets.length);
  const y = (value: number) => top + plotHeight * (1 - value / model.maximum);
  const selectedIndex = buckets.findIndex(bucket => bucket.key === selected);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : model.lastEligibleIndex;
  const active = buckets[activeIndex];
  const detail = buckets.find(bucket => bucket.key === detailKey);
  const approximate = group?.basis === "estimated";
  const speedValue = (value: number | null) => value === null ? "—" : t("usage.speed.value", { approx: approximate ? "≈ " : "", value: number(value, { maximumFractionDigits: 1 }) });
  const bucketDate = (key: string) => date(hourly ? key : `${key}T00:00:00`, { ...(hourly ? { timeZone: report.timezone } : {}), year: "numeric", month: "short", day: "numeric" });
  const bucketLabel = (key: string) => hourly ? dateTime(key, { timeZone: report.timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : bucketDate(key);
  const groupLabel = (item: UsageSpeedGroup) => {
    const client = CLIENTS.find(client => client.id === item.client);
    return t("usage.speed.groupLabel", { model: item.model, client: client ? clientLabel(client.id) : item.client, window: t(`usage.speed.window.${item.window}`), basis: t(`usage.speed.basis.${item.basis}`) });
  };
  const tickCount = Math.min(buckets.length, Math.max(2, Math.floor(plotWidth / 170)));
  const tickX = (index: number) => tickCount > 1 && index === 0 ? left : tickCount > 1 && index === buckets.length - 1 ? width - right : x(index);
  const ticks = Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (buckets.length - 1) / (tickCount - 1)));
  const showDetail = (index: number, rect: DOMRect) => {
    if (!interactive || !buckets[index]) return;
    setSelected(buckets[index].key); anchor.current = { getBoundingClientRect: () => rect }; setDetailKey(buckets[index].key);
  };
  const closeDetail = () => {
    restoreFocus.current = pinned.current || document.activeElement === selector.current || !!popover.current?.contains(document.activeElement);
    pinned.current = false; setDetailKey(null);
  };
  const indexAt = (clientX: number, target: HTMLDivElement) => {
    const bounds = target.getBoundingClientRect();
    return Math.max(0, Math.min(buckets.length - 1, Math.floor((clientX - bounds.left) / bounds.width * buckets.length)));
  };
  return <section className="usage-chart-section usage-time-analysis usage-speed-analysis" aria-labelledby="usage-time-title">
    <div className="usage-section-title"><h2 id="usage-time-title">{t("usage.chart.timeAnalysis")}</h2><div className="usage-speed-actions">
      {!!speed?.groups.length && <ProjectPicker label={t("usage.speed.group")} placeholder={t("usage.speed.search")} value={speed.selectedGroup ?? ""} options={speed.groups.map(item => ({ value: item.key, label: groupLabel(item), description: t(`sessions.speed.method.${item.method}`) }))} onChange={onGroup} />}
      <HelpPopover label={t("usage.speed.help")} iconOnly><p>{t("usage.speed.formula")}</p><p>{t("usage.speed.eligibility")}</p><p>{t("usage.speed.comparability")}</p>
        {group && <><p><strong>{groupLabel(group)}</strong></p><p>{t(`sessions.speed.method.${group.method}`)}</p><p>{t(group.window === "generation" ? "sessions.speed.windowGeneration" : "sessions.speed.windowResponse")}</p><p>{t("usage.speed.groupCoverage", { eligible: group.eligibleRequests, total: group.requests })}</p></>}
        {speed && <><p>{t("usage.speed.coverage", { eligible: speed.eligibleRequests, total: speed.requests })}</p><p>{t("usage.speed.undated", { count: speed.missingTimeRequests })}</p></>}
        <p>{t("usage.chart.timeHelpText")}</p>
      </HelpPopover>
    </div></div>
    {model.points.length ? <><div className="usage-speed-header"><span className="usage-chart-unit">{approximate ? "≈ tok/s" : "tok/s"}</span></div>
      <div className="usage-trend-scroll"><div className="usage-trend-plot" ref={plot}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("usage.speed.trend")}>
          {[0, 1, 2, 3, 4].map(index => <g key={index}><line x1={left} x2={width - right} y1={y(model.maximum * index / 4)} y2={y(model.maximum * index / 4)} className="usage-gridline" /><text x={left - 10} y={y(model.maximum * index / 4) + 4} textAnchor="end">{number(model.maximum * index / 4, { maximumFractionDigits: 1 })}</text></g>)}
          {model.segments.map((segment, index) => <path key={index} className="usage-speed-line" d={segment.map((point, index) => `${index ? "L" : "M"}${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          {model.points.map(point => <circle className="usage-speed-point" key={buckets[point.index]!.key} cx={x(point.index)} cy={y(point.value)} r={model.points.length > 100 ? 2 : 3.5} fill="var(--accent)" />)}
          {active && <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={height - bottom} className="usage-chart-reference" />}
          {ticks.map(index => <text key={buckets[index]!.key} x={tickX(index)} y={height - (hourly ? 30 : 12)} textAnchor={ticks.length === 1 ? "middle" : index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}>{bucketDate(buckets[index]!.key)}{hourly && <tspan x={tickX(index)} dy="17">{dateTime(buckets[index]!.key, { timeZone: report.timezone, hour: "numeric", minute: "2-digit" })}</tspan>}</text>)}
        </svg>
        {active && <div ref={selector} className="usage-bucket-selector usage-speed-selector" role="slider" tabIndex={0} aria-label={t("usage.speed.selectInterval")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={buckets.length} aria-valuenow={activeIndex + 1} aria-valuetext={t("usage.speed.selected", { time: bucketLabel(active.key), value: speedValue(active.tokensPerSecond) })}
          style={{ left: `${left / width * 100}%`, right: `${right / width * 100}%`, bottom: `${bottom / height * 100}%`, top: `${top / height * 100}%` }}
          onPointerMove={event => { if (!pinned.current && (event.pointerType === "mouse" || event.buttons)) showDetail(indexAt(event.clientX, event.currentTarget), new DOMRect(event.clientX, event.clientY, 0, 0)); }}
          onPointerLeave={event => { if (!pinned.current && !(event.relatedTarget instanceof Node && popover.current?.contains(event.relatedTarget))) setDetailKey(null); }}
          onFocus={event => { if (suppressFocus.current) { suppressFocus.current = false; return; } showDetail(activeIndex, event.currentTarget.getBoundingClientRect()); }}
          onPointerDown={event => { event.currentTarget.focus({ preventScroll: true }); pinned.current = true; showDetail(indexAt(event.clientX, event.currentTarget), new DOMRect(event.clientX, event.clientY, 0, 0)); }}
          onKeyDown={event => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
              const index = event.key === "Home" ? 0 : event.key === "End" ? buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, activeIndex + direction));
              showDetail(index, event.currentTarget.getBoundingClientRect());
            } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); pinned.current = true; showDetail(activeIndex, event.currentTarget.getBoundingClientRect()); }
          }} />}
      </div></div>
    </> : <div className="usage-empty">{t("usage.speed.noData")}</div>}
    <Popover.Root open={interactive && detail !== undefined} onOpenChange={open => { if (!open) closeDetail(); }}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal><Popover.Content ref={popover} className="usage-time-popover usage-speed-popover" side="top" align="center" sideOffset={14} collisionPadding={12} aria-label={t("usage.speed.intervalDetails")}
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); if (restoreFocus.current && selector.current?.isConnected && document.activeElement !== selector.current) { suppressFocus.current = true; selector.current.focus({ preventScroll: true }); } }}
        onInteractOutside={event => { if ((event.target as HTMLElement).closest(".usage-speed-selector")) event.preventDefault(); }}
        onPointerLeave={() => { if (!pinned.current && !popover.current?.contains(document.activeElement)) setDetailKey(null); }}>
        {detail && <><header><strong>{bucketLabel(detail.key)}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.speed.intervalDetails") })}><X size={16} /></Popover.Close></header>
          <div className="usage-time-total">{speedValue(detail.tokensPerSecond)}</div><dl>
            <div><dt>{t("usage.speed.eligible")}</dt><dd>{number(detail.eligibleRequests)} / {number(detail.requests)}</dd></div>
            <div><dt>{t("usage.speed.output")}</dt><dd>{detail.outputTokens === null ? "—" : number(detail.outputTokens)}</dd></div>
            <div><dt>{t("usage.speed.duration")}</dt><dd>{detail.durationMs === null ? "—" : t("sessions.speed.seconds", { value: number(detail.durationMs / 1000, { maximumFractionDigits: 3 }) })}</dd></div>
          </dl>
        </>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </section>;
}
