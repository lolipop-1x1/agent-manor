import type { SessionRequestBoundary, SessionUsage } from "../src/session-contracts";
import { requestSpeed, speedOutputTokens, type RequestSpeedSummary } from "../src/session-speed";
import { formatDateTime, formatNumber } from "../src/i18n";
import { getLanguage, t, useI18n } from "./i18n";
import { formatRequestSpeed } from "./session-speed-model";
import { HelpPopover } from "./HelpPopover";
import * as Popover from "@radix-ui/react-popover";
import "./session-speed.css";

export function speedValue(value: number): string {
  return formatRequestSpeed(value, getLanguage());
}

export function RequestSpeedBadge({ usage, compact = false, interactive = true, onLocate }: { usage: SessionUsage; compact?: boolean; interactive?: boolean; onLocate?: (messageId: string) => void }) {
  useI18n();
  const speed = requestSpeed(usage);
  const generation = usage.timing?.window === "generation";
  const recorded = usage.timing?.basis === "recorded";
  const label = generation ? compact ? "generationValue" : "generationRequest"
    : recorded ? compact ? "valueRecorded" : "requestRecorded" : compact ? "value" : "request";
  const value = speed.tokensPerSecond === undefined ? compact ? "—" : t("sessions.speed.requestMissing") : t(`sessions.speed.${label}`, { value: speedValue(speed.tokensPerSecond), approx: recorded ? "" : "≈ " });
  const className = `session-speed-badge${speed.tokensPerSecond === undefined ? " is-missing" : ""}`;
  if (!interactive) return <span className={className}>{value}</span>;
  return <HelpPopover label={t("sessions.speed.details")} trigger={<button type="button" className={className} aria-label={t("sessions.speed.inspect", { value })} onClick={event => event.stopPropagation()}>{value}</button>}>
    <RequestSpeedDetails usage={usage} onLocate={onLocate} />
    <details className="session-speed-algorithm"><summary>{t("sessions.speed.help")}</summary><SpeedAlgorithmHelp /></details>
  </HelpPopover>;
}

export function AverageSpeedBadge({ summary }: { summary?: RequestSpeedSummary }) {
  useI18n();
  if (!summary?.requests) return null;
  if (summary.byWindow) return <span className="session-speed-summary">
    {Object.entries(summary.byWindow).filter(([, value]) => value.eligibleRequests > 0).map(([window, value]) =>
      <AverageSpeedBadge key={window} summary={{ ...value, requests: value.eligibleRequests }} />)}
    {!summary.eligibleRequests && <AverageSpeedBadge summary={{ ...summary, byWindow: undefined }} />}
    {summary.eligibleRequests > 0 && summary.eligibleRequests < summary.requests && <small className="session-speed-coverage">{t("sessions.speed.coverage", { count: summary.eligibleRequests, total: summary.requests })}</small>}
  </span>;
  const label = summary.window === "generation" ? "generationAverage" : summary.basis === "recorded" ? "averageRecorded" : "average";
  const value = summary.tokensPerSecond === null ? t("sessions.speed.insufficient") : t(`sessions.speed.${label}`, { value: speedValue(summary.tokensPerSecond), approx: summary.basis === "recorded" ? "" : "≈ " });
  return <span className="session-speed-summary"><HelpPopover label={t("sessions.speed.help")} trigger={<button type="button" className={`session-speed-badge${summary.tokensPerSecond === null ? " is-missing" : ""}`} aria-label={t("sessions.speed.inspectAverage", { value })} onClick={event => event.stopPropagation()}>{value}</button>}><SpeedAlgorithmHelp /></HelpPopover>
    {summary.eligibleRequests < summary.requests && <small className="session-speed-coverage">{t("sessions.speed.coverage", { count: summary.eligibleRequests, total: summary.requests })}</small>}</span>;
}

export function AverageSpeedMetric({ summary }: { summary?: RequestSpeedSummary }) {
  useI18n();
  if (!summary?.requests) return null;
  if (summary.byWindow) return <>{Object.entries(summary.byWindow).map(([window, value]) => <AverageSpeedMetric key={window} summary={value} />)}</>;
  const label = t(summary.window === "generation" ? "sessions.speed.averageGenerationLabel" : "sessions.speed.averageResponseLabel");
  const value = summary.tokensPerSecond === null ? "—" : t(summary.basis === "recorded" ? "sessions.speed.valueRecorded" : "sessions.speed.value", { value: speedValue(summary.tokensPerSecond) });
  return <div className="session-speed-metric"><strong><HelpPopover label={t("sessions.speed.help")} trigger={<button type="button" className="session-stat-link" aria-label={t("sessions.speed.inspectAverage", { value: label })}>{value}</button>}><SpeedAlgorithmHelp /></HelpPopover></strong>
    <span>{label}</span>{summary.tokensPerSecond === null && <small className="session-speed-coverage">{t("sessions.speed.insufficient")}</small>}
    {summary.eligibleRequests < summary.requests && <small className="session-speed-coverage">{t("sessions.speed.coverage", { count: summary.eligibleRequests, total: summary.requests })}</small>}
  </div>;
}

export function SpeedColumnHeader() {
  useI18n();
  return <span className="session-speed-column-heading">{t("sessions.speed.label")}<HelpPopover iconOnly label={t("sessions.speed.help")}><SpeedAlgorithmHelp /></HelpPopover></span>;
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
    {value.messageId && onLocate && value.source !== "mirror" ? <Popover.Close asChild><button className="text-button" onClick={() => onLocate(value.messageId!)}>{t("sessions.speed.record", { number: value.recordLine })}</button></Popover.Close> : t(value.source === "mirror" ? "sessions.speed.mirrorRecord" : "sessions.speed.record", { number: value.recordLine })}
  </dd></div>;
  return <div className="session-speed-details">
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
  </div>;
}
