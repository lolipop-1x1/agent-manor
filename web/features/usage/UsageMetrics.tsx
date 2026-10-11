import type { UsageReport } from "../../../src/usage-contracts";
import { useI18n } from "../../shared/i18n";
import { usageDailyMetrics } from "./model";
import { TokenAmount } from "./TokenAmount";

export function UsageMetrics({ report }: { report: UsageReport }) {
  const { t, number, percent, date } = useI18n();
  const daily = usageDailyMetrics(report.days);
  const money = (value: number | null) => value === null ? "—" : number(value, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const subtotal = report.totals.estimatedCost !== null && report.totals.partiallyPricedRequests + report.totals.unpricedRequests > 0;
  const primary = [
    { key: "tokens", value: <TokenAmount value={report.totals.tokens} /> },
    { key: subtotal ? "costSubtotal" : "cost", value: money(report.totals.estimatedCost) },
    { key: "requests", value: number(report.totals.requests) },
    { key: "sessions", value: number(report.totals.sessions) },
    { key: "cacheRatio", value: report.totals.cacheReadRatio === null ? "—" : percent(report.totals.cacheReadRatio) },
  ];
  const secondary = [
    { key: "input", value: <TokenAmount value={report.totals.inputTokens} /> },
    { key: "output", value: <TokenAmount value={report.totals.outputTokens} /> },
    { key: "dailyCost", value: money(daily.averageCost) },
    { key: "peakCost", value: money(daily.peak?.totals.estimatedCost ?? null), detail: daily.peak ? date(`${daily.peak.key}T00:00:00`) : undefined },
    { key: "projects", value: number(report.projectCount) },
    { key: "models", value: number(report.modelCount) },
    { key: "activeDays", value: number(daily.activeDays) },
  ];
  return <div className="usage-metric-overview">
    <div className="usage-metrics">{primary.map(item => <div key={item.key}><span>{t(`usage.metric.${item.key}`)}</span><strong>{item.value}</strong></div>)}</div>
    <div className="usage-secondary-metrics">{secondary.map(item => <div key={item.key}><span>{t(`usage.metric.${item.key}`)}</span><strong>{item.value}</strong>{item.detail && <time>{item.detail}</time>}</div>)}</div>
  </div>;
}
