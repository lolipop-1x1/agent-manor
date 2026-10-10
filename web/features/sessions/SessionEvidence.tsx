import * as Popover from "@radix-ui/react-popover";
import { CaretRight, X } from "@phosphor-icons/react";
import { useEffect, useState, type ReactElement } from "react";
import type { SessionProfile, SessionTimelineEvent, SessionTimelineResult } from "../../../src/session-contracts";
import { formatDateTime } from "../../../src/i18n";
import { isAborted, request } from "../../shared/api";
import { Notice, SessionError } from "./SessionControls";
import { kindLabels } from "./SessionMessage";
import { sessionParams } from "./session-model";
import { getLanguage, t, useI18n } from "../../shared/i18n";
import "../../shared/ui/filter-controls.css";

export function SessionEvidence({ kind, profile, children, onSelect }: {
  kind: "failure" | "compression"; profile: SessionProfile; children: ReactElement; onSelect: (event: SessionTimelineEvent) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SessionTimelineEvent[]>();
  const [error, setError] = useState<Error>();
  const [retry, setRetry] = useState(0);
  const label = t(kind === "failure" ? "sessions.evidence.failure" : "sessions.evidence.compression");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setEvents(undefined); setError(undefined);
    void Promise.all(profile.sessionIds.map(id => request<SessionTimelineResult>(`/sessions/${encodeURIComponent(id)}/timeline${sessionParams({ version: profile.version })}`, { signal: controller.signal })))
      .then(timelines => {
        if (!controller.signal.aborted) setEvents(timelines.flatMap(item => item.events).filter(event => !event.copied
          && (kind === "compression" ? event.kind === "compression" : event.kind === "tool_call" && event.status === "failure")));
      })
      .catch(failure => { if (!controller.signal.aborted && !isAborted(failure)) setError(failure instanceof Error ? failure : new Error(String(failure))); });
    return () => controller.abort();
  }, [open, kind, profile.version, profile.sessionIds, retry]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>{children}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu session-evidence-popover" align="end" sideOffset={8} collisionPadding={12} aria-label={label}
      onEscapeKeyDown={event => event.stopPropagation()}>
      <header><strong>{label}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label })}><X size={15} aria-hidden="true" /></Popover.Close></header>
      <div className="session-evidence-list">
        {error ? <Notice danger action={<button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={error} /></Notice>
          : events ? <>
            {events.map(event => <button className="filter-option session-evidence-row" key={`${event.sessionId}-${event.id}`} onClick={() => { setOpen(false); onSelect(event); }}>
              <span className="session-evidence-copy"><span>{event.tool ?? t(kindLabels[event.kind])}</span>
                {event.occurredAt && <time dateTime={event.occurredAt}>{formatDateTime(getLanguage(), event.occurredAt)}</time>}</span>
              <CaretRight size={14} aria-hidden="true" />
            </button>)}
            {!events.length && <p>{t("sessions.search.empty")}</p>}
          </> : <p role="status">{t("common.loading")}</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
