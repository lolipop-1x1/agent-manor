import { useEffect, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { SessionListResult, SessionSearchFacets, SessionSummary } from "../../../src/session-contracts";
import { isAborted, request } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { sessionParams } from "../sessions/session-model";
import { semanticQueryScope } from "../sessions/semantic-ui-model";
import { KnowledgeBusy, KnowledgeError } from "./KnowledgeCommon";

export function KnowledgeSessionPicker({ active, facets, onSelect }: { active: boolean; facets?: SessionSearchFacets; onSelect: (session: SessionSummary) => void }) {
  const { t, dateTime } = useI18n();
  const [title, setTitle] = useState(""), [project, setProject] = useState("all"), [client, setClient] = useState("all"), [page, setPage] = useState(1);
  const [result, setResult] = useState<SessionListResult>(), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setBusy(true); setError(undefined);
    const timer = setTimeout(() => {
      const scope = { ...semanticQueryScope(), title, projects: project === "all" ? [] : [project], clients: client === "all" ? [] : [client], relationship: "all" as const, executionMode: "all" as const, branch: "all" as const };
      void request<SessionListResult>(`/sessions${sessionParams({ scope: scope as Parameters<typeof sessionParams>[0]["scope"], page, pageSize: 10 })}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(failure => { if (!isAborted(failure)) setError(failure); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, title, project, client, page, reload]);
  return <section className="knowledge-session-picker" aria-label={t("knowledge.chooseSession")}>
    <div className="knowledge-picker-search"><MagnifyingGlass size={17} /><input aria-label={t("knowledge.sessionSearch")} placeholder={t("knowledge.sessionSearch")} value={title} onChange={event => { setTitle(event.target.value); setPage(1); }} /><KnowledgeBusy busy={busy} /></div>
    <div className="knowledge-filter-row"><ProjectPicker label={t("knowledge.project")} value={project} options={[{ value: "all", label: t("knowledge.allProjects") }, ...(facets?.projects ?? []).map(value => ({ value, label: value.split(/[\\/]/).filter(Boolean).at(-1) ?? value, description: value }))]} onChange={value => { setProject(value); setPage(1); }} /><FilterSelect label={t("knowledge.client")} value={client} options={[{ value: "all", label: t("knowledge.allClients") }, ...(facets?.clients ?? []).map(value => ({ value, label: value }))]} onChange={value => { setClient(value); setPage(1); }} /></div>
    <KnowledgeError error={error} retry={() => setReload(value => value + 1)} />
    <div className="knowledge-session-options" aria-busy={busy}>{result?.sessions.map(session => <button type="button" key={session.id} disabled={busy} onClick={() => onSelect(session)}><strong>{session.title}</strong><span>{session.client}<span>{t("knowledge.sourceTurns", { turns: session.turnCount })}</span><time>{session.updatedAt ? dateTime(session.updatedAt) : "—"}</time></span></button>)}{result && !result.sessions.length && <p className="knowledge-empty-inline">{t("knowledge.noSessions")}</p>}</div>
    {result && <ResourcePagination page={result.page} pageSize={result.pageSize} total={result.total} label={t("knowledge.chooseSession")} onChange={setPage} />}
  </section>;
}
