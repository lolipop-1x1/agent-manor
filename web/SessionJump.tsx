import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import type { SessionTurnDirectory } from "../src/session-contracts";
import { isAborted, request } from "./api";
import { sessionParams, turnTitle } from "./session-model";
import { t, useI18n } from "./i18n";
import { Pager, SessionError } from "./SessionControls";

export function SessionJump({ sessionId, version, branch, mode, onJump }: { sessionId: string; version: string; branch?: string; mode: "brief" | "full" | "trace"; onJump: (position: number) => void }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SessionTurnDirectory>();
  const [error, setError] = useState<Error>();
  useEffect(() => { setPage(1); setData(undefined); }, [sessionId, version, branch]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setData(undefined); setError(undefined);
    void request<SessionTurnDirectory>(`/sessions/${encodeURIComponent(sessionId)}/turns${sessionParams({ version, branch, mode, page, pageSize: 50 })}`, { signal: controller.signal })
      .then(setData).catch(failure => { if (!isAborted(failure)) setError(failure); });
    return () => controller.abort();
  }, [open, sessionId, version, branch, mode, page]);
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger className="text-button">{t("sessions.turn.byQuestion")}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu session-question-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={t("sessions.turn.byQuestion")} onEscapeKeyDown={event => event.stopPropagation()}>
      {error ? <div role="alert"><SessionError error={error} /></div> : data ? <>
        {data.turns.map(turn => <button className="filter-option" key={turn.id} onClick={() => { onJump(turn.position); setOpen(false); }}><span>{turnTitle(turn.id, turn.position)}</span><span>{turn.question || t("sessions.turn.noQuestion")}</span></button>)}
        {!data.turns.length && <p>{t("sessions.search.empty")}</p>}
        {data.total > data.pageSize && <Pager page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} label={t("sessions.turn.navigation")} />}
      </> : <p role="status">{t("common.loading")}</p>}
    </Popover.Content></Popover.Portal></Popover.Root>;
}
