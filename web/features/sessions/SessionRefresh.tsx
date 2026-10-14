import { clientLabel, messageText, t, useI18n } from "../../shared/i18n";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown } from "@phosphor-icons/react";
import type { Client } from "../../../src/clients";
import type { SessionCheckMode, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import "../../shared/ui/filter-controls.css";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { AutoRefreshMenu } from "../../shared/ui/AutoRefreshControl";

const scopeLabel = (client?: Client) => client ? clientLabel(client) : t("sessions.allClients");
const modeLabel = (mode?: SessionCheckMode) => mode === "full" ? t("sessions.refresh.full") : mode === "quick" ? t("sessions.refresh.quick") : t("sessions.refresh.modeMissing");
const phaseLabels: Record<string, string> = { discover: "sessions.refresh.phase.discover", index: "sessions.refresh.phase.index", publish: "sessions.refresh.phase.publish" };

export function HistoryRefreshControl({ client, disabled, onRefresh, job, error }: {
  client?: Client; disabled: boolean; onRefresh: (options: SessionRefreshOptions) => void;
  job?: SessionJob; error?: Error | null;
}) {
  const { dateTime } = useI18n();
  const scope = scopeLabel(client);
  const completedAt = job?.status === "complete" ? job.finishedAt : undefined;
  const failed = !!error || job?.status === "failed";
  const stateLabel = disabled ? t("common.refresh.running") : failed ? t("common.refresh.failed")
    : completedAt ? t("common.refresh.completed", { time: dateTime(completedAt) }) : t("common.refresh.notChecked");
  return <RefreshControl label={t("common.history.update")} busy={disabled} error={!!error || job?.status === "failed"}
    showStatus={false} completedAt={completedAt} onRefresh={() => onRefresh({ mode: "quick" })}
    menu={<DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-button history-refresh-menu-trigger" aria-label={t("common.history.options")}>
        <CaretDown size={12} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="filter-menu history-refresh-menu" align="end" sideOffset={6} collisionPadding={12}>
        <div className={`history-refresh-menu-status${failed ? " failed" : ""}`}><p role="status">{stateLabel}</p>
          {job && <p>{scopeLabel(job.client)} · {modeLabel(job.mode)}{disabled && job.phase ? <> · {messageText(job.phaseDescriptor, phaseLabels[job.phase] ? t(phaseLabels[job.phase]!) : job.phase)}</> : null}</p>}
        </div>
        <DropdownMenu.Separator className="history-refresh-menu-separator" />
        <AutoRefreshMenu scope="sessions" />
        <p className="history-refresh-menu-note">{t("common.autoRefresh.sessionsVisible")}</p>
        <DropdownMenu.Separator className="history-refresh-menu-separator" />
        <DropdownMenu.Label className="history-refresh-menu-label">{t("sessions.refresh.scopeAndMode")}</DropdownMenu.Label>
        {client && <DropdownMenu.Item className="filter-option" disabled={disabled} onSelect={() => onRefresh({ client, mode: "quick" })}>{t("common.history.clientQuick", { client: scope })}</DropdownMenu.Item>}
        {client && <DropdownMenu.Item className="filter-option" disabled={disabled} onSelect={() => onRefresh({ client, mode: "full" })}>{t("sessions.refresh.fullScope", { scope })}</DropdownMenu.Item>}
        {client && <DropdownMenu.Separator className="history-refresh-menu-separator" />}
        <DropdownMenu.Item className="filter-option" disabled={disabled} onSelect={() => onRefresh({ mode: "full" })}>{t("sessions.refresh.allFull")}</DropdownMenu.Item>
        <p className="history-refresh-menu-note">{t("sessions.refresh.fullNote")}</p>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>} />;
}
