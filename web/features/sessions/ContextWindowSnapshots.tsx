import * as React from "react";
import type { SessionProfile } from "../../../src/session-contracts";
import { formatDateTime, formatNumber, formatPercent, translate, type Language } from "../../../src/i18n";

type ContextSnapshot = NonNullable<SessionProfile["contextSnapshots"]>[number];
const parts = [["systemPromptTokens", "sessions.contextWindow.system"], ["messageTokens", "sessions.contextWindow.messages"],
  ["skillTokens", "sessions.contextWindow.skills"], ["toolTokens", "sessions.contextWindow.tools"]] as const;

/** 每个快照独立展示占用与对应容量，不合并成请求用量。 */
export function ContextWindowSnapshots({ snapshots, rootSessionId, language, help }: {
  snapshots: ContextSnapshot[]; rootSessionId: string; language: Language; help: React.ReactNode;
}) {
  if (!snapshots.length) return null;
  const t = (key: string, params?: Parameters<typeof translate>[2]) => translate(language, key, params);
  const count = (value: number) => formatNumber(language, value);
  const ratio = (snapshot: ContextSnapshot) => formatPercent(language, snapshot.usedTokens / snapshot.capacityTokens, { maximumFractionDigits: 1 });
  const time = (snapshot: ContextSnapshot) => snapshot.occurredAt ? Date.parse(snapshot.occurredAt) : NaN;
  const latest = snapshots.reduce((selected, snapshot) => {
    const selectedTime = time(selected), snapshotTime = time(snapshot);
    return Number.isFinite(snapshotTime) ? !Number.isFinite(selectedTime) || snapshotTime >= selectedTime ? snapshot : selected
      : Number.isFinite(selectedTime) ? selected : snapshot;
  });
  const peak = snapshots.reduce((selected, snapshot) => snapshot.usedTokens >= selected.usedTokens ? snapshot : selected);
  const children = [...new Set(snapshots.map(snapshot => snapshot.sessionId))].filter(id => id !== rootSessionId);
  const scope = (snapshot: ContextSnapshot) => snapshot.sessionId === rootSessionId ? t("sessions.profile.self")
    : t("sessions.contextWindow.child", { number: count(children.indexOf(snapshot.sessionId) + 1) });
  return <section className="session-profile-section" aria-label={t("sessions.contextWindow.title")}>
    <div className="session-section-heading"><h3>{t("sessions.contextWindow.title")}</h3>{help}</div>
    <div className="session-usage-grid compact">
      <div><strong>{count(latest.usedTokens)}</strong><span>{t("sessions.contextWindow.latest")}</span></div>
      <div><strong>{count(latest.capacityTokens)}</strong><span>{t("sessions.contextWindow.capacity")}</span></div>
      <div><strong>{ratio(latest)}</strong><span>{t("sessions.contextWindow.ratio")}</span></div>
      <div><strong>{t("sessions.contextWindow.peakValue", { used: count(peak.usedTokens), capacity: count(peak.capacityTokens), ratio: ratio(peak) })}</strong><span>{t("sessions.contextWindow.peak")}</span></div>
      {parts.map(([key, label]) => <div key={key}><strong>{count(latest[key])}</strong><span>{t(label)}</span></div>)}
    </div>
    <details className="session-stat-details"><summary>{t("sessions.contextWindow.snapshots", { count: snapshots.length })}</summary>
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
    </details>
  </section>;
}
