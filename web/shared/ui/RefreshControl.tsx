import type { ReactNode } from "react";
import { ArrowClockwise, CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";
import { HelpPopover } from "./HelpPopover";
import { useI18n } from "../i18n";
import "./refresh-controls.css";

export function RefreshControl({ label, busy = false, disabled = false, onRefresh, completedAt, error, details, menu, statusLabel, showStatus = true }: {
  label: string; busy?: boolean; disabled?: boolean; onRefresh: () => void; completedAt?: string;
  error?: boolean; details?: ReactNode; menu?: ReactNode; statusLabel?: string; showStatus?: boolean;
}) {
  const { t, dateTime } = useI18n();
  const stateLabel = busy ? t("common.refresh.running") : error ? t("common.refresh.failed")
    : completedAt ? t("common.refresh.completed", { time: dateTime(completedAt) }) : t("common.refresh.notChecked");
  return <div className="refresh-control">
    <button className="button refresh-button" aria-label={label} aria-busy={busy} title={stateLabel}
      disabled={disabled || busy} onClick={onRefresh}>
      {error && !busy ? <WarningCircle size={16} className="refresh-error-icon" aria-hidden="true" /> : <ArrowClockwise size={16} className={busy ? "is-spinning" : undefined} aria-hidden="true" />}<span className="refresh-label">{label}</span>
    </button>
    {menu}
    {showStatus && <HelpPopover label={statusLabel ?? t("common.refresh.status", { action: label })}
      trigger={<button className={`icon-button refresh-state${error ? " failed" : ""}`} aria-label={statusLabel ?? t("common.refresh.status", { action: label })} title={stateLabel}>
        {error ? <WarningCircle size={16} aria-hidden="true" /> : completedAt ? <CheckCircle size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
      </button>}>
      <p role="status">{stateLabel}</p>{details}
    </HelpPopover>}
  </div>;
}
