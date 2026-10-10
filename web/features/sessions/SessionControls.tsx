import { getLanguage, isMessageDescriptorKnown, messageText, t, useI18n } from "../../shared/i18n";
import { formatNumber } from "../../../src/i18n";
import type { ReactNode } from "react";
import type { Gap } from "../../../src/contracts";
import { ApiError, errorMessage } from "../../shared/api";
import { CaretDoubleLeft, CaretDoubleRight, CaretLeft, CaretRight, WarningCircle } from "@phosphor-icons/react";

export function Notice({ children, danger = false, action }: { children: ReactNode; danger?: boolean; action?: ReactNode }) {
  useI18n();
  return <div className={`session-notice${danger ? " is-danger" : ""}`} role={danger ? "alert" : "status"}>
    <WarningCircle size={16} aria-hidden="true" /><div>{children}</div>{action}
  </div>;
}

export function SessionError({ error }: { error: Error | string }) {
  useI18n();
  return <>{!(error instanceof ApiError && isMessageDescriptorKnown(error.messageDescriptor)) && <strong>{t("common.originalDetails")}: </strong>}{errorMessage(error)}</>;
}

export function SessionDiagnostic({ gap }: { gap: Gap }) {
  useI18n();
  return <div><p>{!isMessageDescriptorKnown(gap.messageDescriptor) && <strong>{t("common.originalDetails")}: </strong>}{messageText(gap.messageDescriptor, gap.message)}</p>
    {gap.details?.map((detail, index) => <p key={`${detail.key}-${index}`}>{!isMessageDescriptorKnown(detail) && <strong>{t("common.originalDetails")}: </strong>}{messageText(detail, gap.message)}</p>)}
  </div>;
}

export function Pager({ page, pageSize, total, onChange, label, showEnds = false }: { page: number; pageSize: number; total: number; onChange: (page: number) => void; label: string; showEnds?: boolean }) {
  useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="session-pager" aria-label={label}>
    {showEnds && <button className="icon-button" aria-label={t("common.pagination.first", { label })} disabled={page <= 1} onClick={() => onChange(1)}><CaretDoubleLeft size={15} /></button>}
    <button className="icon-button" aria-label={t("common.pagination.previous", { label })} disabled={page <= 1} onClick={() => onChange(page - 1)}><CaretLeft size={15} /></button>
    <span>{t("sessions.pagination.summary", { page: formatNumber(getLanguage(), page), pages: formatNumber(getLanguage(), pages), count: total })}</span>
    <button className="icon-button" aria-label={t("common.pagination.next", { label })} disabled={page >= pages} onClick={() => onChange(page + 1)}><CaretRight size={15} /></button>
    {showEnds && <button className="icon-button" aria-label={t("common.pagination.last", { label })} disabled={page >= pages} onClick={() => onChange(pages)}><CaretDoubleRight size={15} /></button>}
  </nav>;
}
