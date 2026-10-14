import type { SessionProfile } from "../../../src/session-contracts";
import { t, useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";

const fields = [
  ["totalTokens", "sessions.nativeUsage.total"], ["inputTokens", "sessions.usage.input"],
  ["outputTokens", "sessions.usage.output"], ["cachedInputTokens", "sessions.usage.cachedInput"],
  ["cacheWriteTokens", "sessions.profile.cacheWriteTokens"], ["reasoningOutputTokens", "sessions.profile.reasoningTokens"],
  ["nativeModelCalls", "sessions.nativeUsage.modelCalls"], ["reportedCostUsd", "sessions.nativeUsage.reportedCost"],
] as const;

/** 累计报告保留原生范围和费用身份，不投影为请求曲线或账单。 */
export function NativeUsageReports({ reports }: { reports: NonNullable<SessionProfile["usageReports"]> }) {
  const { number } = useI18n();
  const visible = fields.filter(([key]) => reports.some(report => report[key] !== undefined));
  return <details className="session-stat-details">
    <summary>{t("sessions.nativeUsage.title")}</summary>
    <div className="session-section-heading"><span>{t("sessions.nativeUsage.scope")}</span><HelpPopover label={t("sessions.nativeUsage.help")}>
      <p>{t("sessions.nativeUsage.helpText")}</p>
    </HelpPopover></div>
    <div className="session-step-table"><table><thead><tr><th>{t("sessions.nativeUsage.scope")}</th>
      {visible.map(([key, label]) => <th key={key}>{t(label)}</th>)}
    </tr></thead><tbody>{reports.map((report, index) => <tr key={`${report.sessionId}:${report.scope}:${report.nativeId ?? index}`}>
      <td>{t(`sessions.nativeUsage.${report.scope}`)}{report.model && <span> · {report.model}</span>}</td>
      {visible.map(([key]) => <td key={key}>{report[key] === undefined ? "—" : number(report[key], key === "reportedCostUsd"
        ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 4 } : {})}</td>)}
    </tr>)}</tbody></table></div>
  </details>;
}
