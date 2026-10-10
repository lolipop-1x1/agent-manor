import { clientLabel, getLanguage, messageText, t, useI18n } from "../../shared/i18n";
import { formatDateTime, formatNumber, formatPercent } from "../../../src/i18n";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowClockwise, CaretDown } from "@phosphor-icons/react";
import { CLIENTS, type Client } from "../../../src/clients";
import type { SessionCheckMode, SessionClientCheck, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import "../../shared/ui/filter-controls.css";

const scopeLabel = (client?: Client) => client ? clientLabel(client) : t("sessions.allClients");
const modeLabel = (mode?: SessionCheckMode) => mode === "full" ? t("sessions.refresh.full") : mode === "quick" ? t("sessions.refresh.quick") : t("sessions.refresh.modeMissing");
const countLabel = (value: number) => formatNumber(getLanguage(), value);
const checkedAtLabel = (value: string) => formatDateTime(getLanguage(), value);
const phaseLabels: Record<string, string> = { discover: "sessions.refresh.phase.discover", index: "sessions.refresh.phase.index", publish: "sessions.refresh.phase.publish" };
const fallbackLabels: Record<string, string> = {
  cache_missing: "sessions.refresh.fallback.cacheMissing", check_record_missing: "sessions.refresh.fallback.checkMissing", unsupported_source: "sessions.refresh.fallback.unsupported",
  metadata_changed: "sessions.refresh.fallback.metadata", source_changed: "sessions.refresh.fallback.source",
};

export function SessionRefreshActions({ client, disabled, onRefresh }: {
  client?: Client; disabled: boolean; onRefresh: (options: SessionRefreshOptions) => void;
}) {
  useI18n();
  const scope = scopeLabel(client);
  return <div className="session-refresh-actions">
    <button className="icon-button" aria-label={t("sessions.refresh.action")} title={t("sessions.refresh.quickTitle", { scope })} disabled={disabled} onClick={() => onRefresh({ client, mode: "quick" })}>
      <ArrowClockwise size={16} className={disabled ? "is-spinning" : ""} aria-hidden="true" />
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-button session-refresh-menu-trigger" aria-label={t("sessions.refresh.options")} title={t("sessions.refresh.choose")} disabled={disabled}>
        <CaretDown size={12} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="filter-menu session-refresh-menu" align="end" sideOffset={6} collisionPadding={12}>
        <DropdownMenu.Label className="session-refresh-menu-label">{t("sessions.refresh.scopeAndMode")}</DropdownMenu.Label>
        <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ mode: "quick" })}>{t("sessions.refresh.allQuick")}</DropdownMenu.Item>
        <DropdownMenu.Separator className="session-refresh-menu-separator" />
        <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ client, mode: "full" })}>{t("sessions.refresh.fullScope", { scope })}</DropdownMenu.Item>
        {client && <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ mode: "full" })}>{t("sessions.refresh.allFull")}</DropdownMenu.Item>}
        <p className="session-refresh-menu-note">{t("sessions.refresh.fullNote")}</p>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}

export function SessionRefreshStatus({ job }: { job?: SessionJob }) {
  useI18n();
  if (!job) return null;
  if (job.status === "complete") return <details className="session-refresh-finished"><summary>{t("sessions.refresh.complete")}</summary><p>{scopeLabel(job.client)} · {modeLabel(job.mode)}</p>{job.finishedAt && <time>{checkedAtLabel(job.finishedAt)}</time>}{job.counts && <p>{t("sessions.refresh.counts", { discovered: countLabel(job.counts.discovered), quick: countLabel(job.counts.quickReused), verified: countLabel(job.counts.verifiedReused), parsed: countLabel(job.counts.parsed), missing: countLabel(job.counts.missing) })}</p>}</details>;
  const running = job.status === "running" || job.status === "queued";
  const counts = job.counts;
  const fallbackCount = counts?.fallbacks.reduce((sum, fallback) => sum + fallback.count, 0) ?? 0;
  return <section className="session-refresh-status" role="status" aria-label={t("sessions.refresh.status")}>
    <div className="session-refresh-status-heading"><strong>{scopeLabel(job.client)}</strong><span>{modeLabel(job.mode)} · {running ? job.status === "queued" ? t("sessions.refresh.queued") : t("sessions.refresh.running") : t("sessions.status.failure")}</span></div>
    {running && <div className="session-job"><span>{messageText(job.phaseDescriptor, phaseLabels[job.phase] ? t(phaseLabels[job.phase]!) : job.phase ? t("common.originalDetail", { detail: job.phase }) : t("sessions.refresh.active"))}</span><progress aria-label={t("sessions.refresh.progress")} max="1" value={job.progress} /><small>{formatPercent(getLanguage(), job.progress, { maximumFractionDigits: 0 })}</small></div>}
    {counts && <p className="session-refresh-counts">{t("sessions.refresh.counts", { discovered: countLabel(counts.discovered), quick: countLabel(counts.quickReused), verified: countLabel(counts.verifiedReused), parsed: countLabel(counts.parsed), missing: countLabel(counts.missing) })}</p>}
    {!!fallbackCount && <details className="session-refresh-fallbacks"><summary>{t("sessions.refresh.fallbackCount", { count: fallbackCount })}</summary>
      <div>{counts?.fallbacks.map(fallback => <p key={fallback.reason}>{fallbackLabels[fallback.reason] ? t(fallbackLabels[fallback.reason]!) : t("common.originalDetail", { detail: fallback.reason })} · {countLabel(fallback.count)}</p>)}</div>
    </details>}
  </section>;
}

export function SessionClientChecks({ client, checks }: { client?: Client; checks?: SessionClientCheck[] }) {
  useI18n();
  const selected = checks?.find(check => check.client === client);
  return <details className="session-client-checks">
    <summary>{t("sessions.refresh.scope", { scope: scopeLabel(client) })}<span>{client ? selected ? t("sessions.refresh.latest", { mode: modeLabel(selected.mode), date: checkedAtLabel(selected.checkedAt) }) : t("sessions.refresh.lastMissing") : t("sessions.refresh.viewChecks")}</span></summary>
    <div className="session-client-check-list">
      <p>{t("sessions.refresh.checkNote")}</p>
      {CLIENTS.map(item => {
        const check = checks?.find(value => value.client === item.id);
        return <div className="session-client-check" key={item.id}><strong>{clientLabel(item.id)}</strong>
          <span>{check ? <>{modeLabel(check.mode)} · <time dateTime={check.checkedAt}>{checkedAtLabel(check.checkedAt)}</time></> : t("common.notRecorded")}</span></div>;
      })}
    </div>
  </details>;
}
