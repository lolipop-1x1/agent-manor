import * as Popover from "@radix-ui/react-popover";
import { CaretRight, X } from "@phosphor-icons/react";
import { useEffect, useState, type ReactElement } from "react";
import type { SessionMessage, SessionProfile, SessionTimelineEvent, SessionTimelineResult } from "../../../src/session-contracts";
import { formatDateTime } from "../../../src/i18n";
import { ApiError, isAborted, request } from "../../shared/api";
import { Notice, Pager, SessionError } from "./SessionControls";
import { EVIDENCE_PAGE_SIZE, evidencePreviews, evidenceSummary } from "./session-evidence-model";
import { kindLabels } from "./SessionMessage";
import { sessionParams } from "./session-model";
import { getLanguage, t, useI18n } from "../../shared/i18n";
import "../../shared/ui/filter-controls.css";

export function SessionEvidence({ kind, profile, children, onSelect }: {
  kind: "failure" | "compression"; profile: SessionProfile; children: ReactElement; onSelect: (event: SessionTimelineEvent) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<{ scope: string; events: SessionTimelineEvent[] }>();
  const [error, setError] = useState<Error>();
  const [page, setPage] = useState(1);
  const [previews, setPreviews] = useState<{ key: string; messages: SessionMessage[] }>();
  const [previewError, setPreviewError] = useState<Error>();
  const [retry, setRetry] = useState(0);
  const label = t(kind === "failure" ? "sessions.evidence.failure" : "sessions.evidence.compression");
  const scope = `${profile.version}:${profile.sessionIds.join(",")}:${kind}`;
  const events = evidence?.scope === scope ? evidence.events : undefined;
  const previewKey = `${scope}:${page}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setEvidence(undefined); setError(undefined); setPage(1);
    void Promise.all(profile.sessionIds.map(id => request<SessionTimelineResult>(`/sessions/${encodeURIComponent(id)}/timeline${sessionParams({ version: profile.version })}`, { signal: controller.signal })))
      .then(timelines => {
        if (timelines.some(item => item.version !== profile.version)) throw new ApiError("VERSION_MISMATCH", "结果版本发生变化，请重试。", { key: "sessions.reading.versionChanged" });
        if (!controller.signal.aborted) setEvidence({ scope, events: timelines.flatMap(item => item.events).filter(event => !event.copied
          && (kind === "compression" ? event.kind === "compression" : event.kind === "tool_call" && event.status === "failure")) });
      })
      .catch(failure => { if (!controller.signal.aborted && !isAborted(failure)) setError(failure instanceof Error ? failure : new Error(String(failure))); });
    return () => controller.abort();
  }, [open, scope, retry]);
  useEffect(() => {
    if (!open || !events) return;
    const controller = new AbortController(); setPreviews(undefined); setPreviewError(undefined);
    void evidencePreviews(events.slice((page - 1) * EVIDENCE_PAGE_SIZE, page * EVIDENCE_PAGE_SIZE), profile.version, controller.signal)
      .then(messages => { if (!controller.signal.aborted) setPreviews({ key: previewKey, messages }); })
      .catch(failure => { if (!controller.signal.aborted && !isAborted(failure)) setPreviewError(failure instanceof Error ? failure : new Error(String(failure))); });
    return () => controller.abort();
  }, [open, events, page, previewKey, retry]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>{children}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu session-evidence-popover" align="end" sideOffset={8} collisionPadding={12} aria-label={label}
      onEscapeKeyDown={event => event.stopPropagation()}>
      <header><strong>{label}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label })}><X size={15} aria-hidden="true" /></Popover.Close></header>
      <div className="session-evidence-list">
        {error ? <Notice danger action={<button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={error} /></Notice>
          : events ? <>
            {previewError && <Notice danger action={<button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={previewError} /></Notice>}
            {events.slice((page - 1) * EVIDENCE_PAGE_SIZE, page * EVIDENCE_PAGE_SIZE).map(event => {
              const preview = previews?.key === previewKey ? previews.messages.find(message => message.id === event.id && message.sessionId === event.sessionId) : undefined;
              return <button className="filter-option session-evidence-row" key={`${event.sessionId}-${event.id}`} onClick={() => { setOpen(false); onSelect(event); }}>
              <span className="session-evidence-copy"><span>{event.tool ?? t(kindLabels[event.kind])}</span>
                {preview && <small className="session-evidence-summary">{evidenceSummary(preview)}</small>}
                {event.occurredAt && <time dateTime={event.occurredAt}>{formatDateTime(getLanguage(), event.occurredAt)}</time>}</span>
              <CaretRight size={14} aria-hidden="true" />
            </button>; })}
            {events.length > EVIDENCE_PAGE_SIZE && <Pager page={page} pageSize={EVIDENCE_PAGE_SIZE} total={events.length} onChange={setPage} label={label} />}
            {!events.length && <p>{t("sessions.search.empty")}</p>}
          </> : <p role="status">{t("common.loading")}</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
