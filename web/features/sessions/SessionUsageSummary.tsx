import * as React from "react";
import { Crosshair } from "@phosphor-icons/react";
import type { SessionProfile } from "../../../src/session-contracts";
import { formatDateTime, formatNumber, formatPercent, translate, type Language } from "../../../src/i18n";
import { usageCoverage } from "./session-usage-coverage";

type ContextSnapshot = NonNullable<SessionProfile["contextSnapshots"]>[number];
const metrics = [
  ["inputTokens", "sessions.profile.totalInput"], ["outputTokens", "sessions.profile.outputTokens"],
  ["cachedInputTokens", "sessions.profile.cachedTokens"], ["cacheWriteTokens", "sessions.profile.cacheWriteTokens"],
  ["reasoningOutputTokens", "sessions.profile.reasoningTokens"], ["peakInputTokens", "sessions.profile.maxInput"], ["peakContextTokens", "sessions.profile.peakContext"],
] as const;
const parts = [["systemPromptTokens", "sessions.contextWindow.system"], ["messageTokens", "sessions.contextWindow.messages"],
  ["skillTokens", "sessions.contextWindow.skills"], ["toolTokens", "sessions.contextWindow.tools"]] as const;

export function sessionHasRequestUsage(profile: SessionProfile) {
  return profile.usage.requests > 0 || metrics.some(([key]) => profile.usage[key] !== null);
}

function visibleMetrics(profile: SessionProfile, expanded: boolean) {
  const snapshotPeak = profile.contextSnapshots?.reduce<number | undefined>((peak, snapshot) => peak === undefined ? snapshot.usedTokens : Math.max(peak, snapshot.usedTokens), undefined);
  // 不同范围的峰值分别保留，仅省去与快照峰值相同的兼容指标。
  const repeatedContextPeak = snapshotPeak !== undefined && profile.usage.peakContextTokens === snapshotPeak;
  return metrics.filter(([key]) => (key === "inputTokens" || key === "outputTokens"
    || profile.usage[key] !== null && (key === "peakInputTokens" || expanded))
    && !(key === "peakContextTokens" && repeatedContextPeak));
}

export function sessionUsageCoverage(profile: SessionProfile, expanded: boolean) {
  return usageCoverage(profile.usage, visibleMetrics(profile, expanded).filter(([key]) => profile.usage[key] !== null));
}

/** 所有来源共用用量摘要；上下文占用始终独立于逐请求输入、输出。 */
export function SessionUsageSummary({ profile, language, expanded, help, speed, cost, onFocusStep }: {
  profile: SessionProfile; language: Language; expanded: boolean; help?: React.ReactNode; speed?: React.ReactNode; cost?: React.ReactNode;
  onFocusStep: (step: SessionProfile["steps"][number]) => void;
}) {
  const snapshots = profile.contextSnapshots ?? [];
  if (!sessionHasRequestUsage(profile) && !snapshots.length && !profile.usageReports?.length) return null;
  const t = (key: string, params?: Parameters<typeof translate>[2]) => translate(language, key, params);
  const count = (value?: number) => value === undefined ? "—" : formatNumber(language, value);
  const ratio = (snapshot: ContextSnapshot) => snapshot.capacityTokens !== undefined && snapshot.capacityTokens > 0
    ? formatPercent(language, snapshot.usedTokens / snapshot.capacityTokens, { maximumFractionDigits: 1 }) : "—";
  const time = (snapshot: ContextSnapshot) => snapshot.occurredAt ? Date.parse(snapshot.occurredAt) : NaN;
  const latest = snapshots.length ? snapshots.reduce((selected, snapshot) => {
    const selectedTime = time(selected), snapshotTime = time(snapshot);
    return Number.isFinite(snapshotTime) ? !Number.isFinite(selectedTime) || snapshotTime >= selectedTime ? snapshot : selected
      : Number.isFinite(selectedTime) ? selected : snapshot;
  }) : undefined;
  const peakContext = snapshots.length ? snapshots.reduce((selected, snapshot) => snapshot.usedTokens >= selected.usedTokens ? snapshot : selected) : undefined;
  const coverage = sessionUsageCoverage(profile, expanded);
  const peakRequest = profile.peakInputRequest ?? profile.steps.find(step => step.inputTokens === profile.usage.peakInputTokens && !!step.messageId);
  const children = [...new Set(snapshots.map(snapshot => snapshot.sessionId))].filter(id => id !== profile.sessionIds[0]);
  const scope = (snapshot: ContextSnapshot) => snapshot.sessionId === profile.sessionIds[0] ? t("sessions.profile.self")
    : t("sessions.contextWindow.child", { number: formatNumber(language, children.indexOf(snapshot.sessionId) + 1) });
  const metric = ([key, label]: typeof metrics[number]) => {
    const partial = coverage.some(group => group.labels.includes(label));
    const name = !partial ? t(label) : key === "peakInputTokens" ? t("sessions.profile.maxRecordedInput") : t("sessions.profile.recordedSubtotal", { label: t(label) });
    return <div key={key}><strong>{key === "peakInputTokens" && peakRequest ? <button className="session-stat-link session-peak-link" aria-label={t("sessions.evidence.peak", { value: count(profile.usage.peakInputTokens!) })} onClick={() => onFocusStep(peakRequest)}>{count(profile.usage[key]!)}<Crosshair size={13} aria-hidden="true" /></button> : count(profile.usage[key] ?? undefined)}</strong><span>{name}</span></div>;
  };
  const visible = visibleMetrics(profile, expanded);
  return <section className="session-profile-section" aria-label={t("sessions.usage.summary")}>
    <div className="session-section-heading"><h3>{t("sessions.usage.summary")}</h3><div className="section-actions">
      {profile.usage.requests > 0 && <span>{t("sessions.profile.requestCount", { count: profile.usage.requests })}</span>}{help}
    </div></div>
    <div className="session-usage-grid">
      {visible.filter(([key]) => key === "inputTokens" || key === "outputTokens").map(metric)}
      <div><strong>{count(latest?.usedTokens)}</strong><span>{t("sessions.contextWindow.latest")}</span></div>
      <div><strong>{count(latest?.capacityTokens)}</strong><span>{t("sessions.contextWindow.capacity")}</span></div>
      <div><strong>{latest ? ratio(latest) : "—"}</strong><span>{t("sessions.contextWindow.ratio")}</span></div>
      <div title={peakContext ? t("sessions.contextWindow.peakValue", { used: count(peakContext.usedTokens), capacity: count(peakContext.capacityTokens), ratio: ratio(peakContext) }) : undefined}><strong>{count(peakContext?.usedTokens)}</strong><span>{t("sessions.contextWindow.peak")}</span></div>
      {speed}{visible.filter(([key]) => key === "peakInputTokens").map(metric)}
      {visible.filter(([key]) => !["inputTokens", "outputTokens", "peakInputTokens"].includes(key)).map(metric)}
    </div>
    {cost}
    {profile.usage.cacheReadRatio !== null && <div className="session-cache-ratio"><div className="session-cost-heading"><span>{t(profile.usage.inputRecordedRequests === profile.usage.requests && profile.usage.cacheRecordedRequests === profile.usage.requests ? "sessions.profile.cacheRatio" : "sessions.profile.cacheRatioRecorded")}</span><strong>{formatPercent(language, profile.usage.cacheReadRatio, { minimumFractionDigits: 1 })}</strong></div></div>}
    {expanded && latest && <details className="session-stat-details"><summary>{t("sessions.contextWindow.snapshots", { count: snapshots.length })}</summary>
      <div className="session-usage-grid">{parts.map(([key, label]) => <div key={key}><strong>{count(latest[key])}</strong><span>{t(label)}</span></div>)}</div>
      <div className="session-step-table"><table><thead><tr><th>{t("sessions.contextWindow.time")}</th>
        {children.length > 0 && <th>{t("sessions.nativeUsage.scope")}</th>}
        <th>{t("sessions.contextWindow.used")}</th><th>{t("sessions.contextWindow.capacity")}</th><th>{t("sessions.contextWindow.ratio")}</th>
        {parts.map(([key, label]) => <th key={key}>{t(label)}</th>)}
      </tr></thead><tbody>{snapshots.map(snapshot => <tr key={`${snapshot.sessionId}:${snapshot.id}`}>
        <td>{Number.isFinite(time(snapshot)) ? <time dateTime={snapshot.occurredAt}>{formatDateTime(language, snapshot.occurredAt!)}</time> : t("sessions.message.timeMissing")}</td>
        {children.length > 0 && <td>{scope(snapshot)}</td>}
        <td>{count(snapshot.usedTokens)}</td><td>{count(snapshot.capacityTokens)}</td><td>{ratio(snapshot)}</td>
        {parts.map(([key]) => <td key={key}>{count(snapshot[key])}</td>)}
      </tr>)}</tbody></table></div>
    </details>}
  </section>;
}
