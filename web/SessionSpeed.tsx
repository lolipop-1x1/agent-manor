import type { SessionRequestBoundary, SessionUsage } from "../src/session-contracts";
import { requestSpeed, speedOutputTokens, type RequestSpeedSummary } from "../src/session-speed";
import { formatDateTime, formatNumber } from "../src/i18n";
import { getLanguage, t, useI18n } from "./i18n";
import { formatRequestSpeed } from "./session-speed-model";
import "./session-speed.css";

export function speedValue(value: number): string {
  return formatRequestSpeed(value, getLanguage());
}

export function RequestSpeedBadge({ usage, compact = false }: { usage: SessionUsage; compact?: boolean }) {
  useI18n();
  const speed = requestSpeed(usage);
  const generation = usage.timing?.window === "generation";
  const recorded = usage.timing?.basis === "recorded";
  const label = generation ? compact ? "generationValue" : "generationRequest"
    : recorded ? compact ? "valueRecorded" : "requestRecorded" : compact ? "value" : "request";
  return <span className={`session-speed-badge${speed.tokensPerSecond === undefined ? " is-missing" : ""}`}>
    {speed.tokensPerSecond === undefined ? compact ? "—" : t("sessions.speed.requestMissing") : t(`sessions.speed.${label}`, { value: speedValue(speed.tokensPerSecond), approx: recorded ? "" : "≈ " })}
  </span>;
}

export function AverageSpeedBadge({ summary }: { summary?: RequestSpeedSummary }) {
  useI18n();
  if (!summary?.requests) return null;
  if (summary.byWindow) return <span className="session-speed-summary">
    {Object.entries(summary.byWindow).filter(([, value]) => value.eligibleRequests > 0).map(([window, value]) =>
      <AverageSpeedBadge key={window} summary={{ ...value, requests: value.eligibleRequests }} />)}
    {!summary.eligibleRequests && <span className="session-speed-badge is-missing">{t("sessions.speed.insufficient")}</span>}
    {summary.eligibleRequests < summary.requests && <small className="session-speed-coverage">{t("sessions.speed.coverage", { count: summary.eligibleRequests, total: summary.requests })}</small>}
  </span>;
  const label = summary.window === "generation" ? "generationAverage" : summary.basis === "recorded" ? "averageRecorded" : "average";
  return <span className="session-speed-summary"><span className={`session-speed-badge${summary.tokensPerSecond === null ? " is-missing" : ""}`}>
    {summary.tokensPerSecond === null ? t("sessions.speed.insufficient") : t(`sessions.speed.${label}`, { value: speedValue(summary.tokensPerSecond), approx: summary.basis === "recorded" ? "" : "≈ " })}
  </span>{summary.eligibleRequests < summary.requests && <small className="session-speed-coverage">{t("sessions.speed.coverage", { count: summary.eligibleRequests, total: summary.requests })}</small>}</span>;
}

export function SpeedAlgorithmHelp() {
  useI18n();
  return <><strong>{t("sessions.speed.helpTitle")}</strong><p>{t("sessions.speed.formulaHelp")}</p><p>{t("sessions.speed.averageHelp")}</p><p>{t("sessions.speed.coverageHelp")}</p></>;
}

export function RequestSpeedDetails({ usage, onLocate }: { usage: SessionUsage; onLocate?: (messageId: string) => void }) {
  useI18n();
  const speed = requestSpeed(usage);
  const timing = usage.timing;
  const output = speedOutputTokens(usage);
  const boundary = (value: SessionRequestBoundary | undefined, label: string) => value && <div><dt>{t(label)}</dt><dd>
    {value.occurredAt && <time>{formatDateTime(getLanguage(), value.occurredAt)}</time>}{" "}
    {value.messageId && onLocate && value.source !== "mirror" ? <button className="text-button" onClick={() => onLocate(value.messageId!)}>{t("sessions.speed.record", { number: value.recordLine })}</button> : t(value.source === "mirror" ? "sessions.speed.mirrorRecord" : "sessions.speed.record", { number: value.recordLine })}
  </dd></div>;
  return <details className="session-speed-details"><summary>{t("sessions.speed.details")}</summary>
    {speed.tokensPerSecond === undefined ? <p>{t(`sessions.speed.reason.${speed.reason}`)}</p> : <p className="session-speed-formula">{t(timing?.basis === "recorded" ? "sessions.speed.formulaRecorded" : "sessions.speed.formula", {
      output: formatNumber(getLanguage(), output!), seconds: formatNumber(getLanguage(), timing!.durationMs! / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 3 }), speed: speedValue(speed.tokensPerSecond),
    })}</p>}
    <dl>{output !== undefined && <div><dt>{t("sessions.usage.output")}</dt><dd>{formatNumber(getLanguage(), output)}</dd></div>}
      {timing?.durationMs !== undefined && <div><dt>{t("sessions.speed.duration")}</dt><dd>{t("sessions.speed.seconds", { value: formatNumber(getLanguage(), timing.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 3 }) })}</dd></div>}
    </dl>
    {timing && <dl><div><dt>{t("sessions.speed.timing")}</dt><dd>{t(`sessions.speed.method.${timing.method}`)}</dd></div>
      <div><dt>{t("sessions.speed.window")}</dt><dd>{t(timing.window === "generation" ? "sessions.speed.windowGeneration" : "sessions.speed.windowResponse")}</dd></div>
      <div><dt>{t("sessions.speed.estimate")}</dt><dd>{t(timing.basis === "recorded" ? "sessions.speed.recorded" : "sessions.speed.estimated")}</dd></div>
      <div><dt>{t("sessions.speed.completion")}</dt><dd>{t(`sessions.speed.completion.${timing.completion}`)}</dd></div>
      {boundary(timing.start, "sessions.speed.start")}{boundary(timing.end, "sessions.speed.end")}
      {boundary(timing.firstToken, "sessions.speed.firstToken")}
      {timing.completionEvidence && <div><dt>{t("sessions.speed.evidence")}</dt><dd>{t(`sessions.speed.evidence.${timing.completionEvidence}`)}</dd></div>}
    </dl>}
  </details>;
}
