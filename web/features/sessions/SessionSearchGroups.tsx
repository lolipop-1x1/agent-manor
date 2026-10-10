import { useEffect, useState, type ReactNode } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { SessionGroupedSearchResult, SessionSearchGroup, SessionSearchHit, SessionSearchResult } from "../../../src/session-contracts";
import { isAborted, request } from "../../shared/api";
import { t, useI18n } from "../../shared/i18n";
import { sessionDisplayTitle } from "./session-model";
import { Pager, SessionError } from "./SessionControls";

export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query.trim()) return text;
  const needle = query.trim().toLocaleLowerCase();
  const lowered = text.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let start = 0, index = lowered.indexOf(needle);
  while (index >= 0) {
    parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length; index = lowered.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return parts;
}
function SearchGroup({ group, query, params, onSelect }: { group: SessionSearchGroup; query: string; params: string; onSelect: (hit: SessionSearchHit) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SessionSearchResult>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const scope = new URLSearchParams(params);
    scope.set("sessionId", group.session.id); scope.set("page", String(page)); scope.set("pageSize", "12");
    setLoading(true); setError(undefined); setData(undefined);
    void request<SessionSearchResult>(`/sessions/search?${scope}`, { signal: controller.signal }).then(setData)
      .catch(failure => { if (!isAborted(failure)) setError(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, page, params, group.session.id]);
  const hits = open ? data?.hits ?? [] : group.hits.filter(hit => hit.kind !== "title");
  return <article className="session-search-group"><button className="session-group-title" onClick={() => onSelect({ session: group.session, kind: "title", snippet: "" })}>
    <strong><Highlight text={sessionDisplayTitle(group.session)} query={query} /></strong></button>
    <small>{t("sessions.search.matchCount", { count: group.matchCount })}</small>
    {hits.map((hit, index) => <button className="session-hit" key={hit.messageId ?? `title-${index}`} onClick={() => onSelect(hit)}><span className="session-hit-snippet"><Highlight text={hit.snippet} query={query} /></span></button>)}
    {error && <div role="alert"><SessionError error={error} /><button className="text-button" onClick={() => { setOpen(false); }}>{t("common.close")}</button></div>}
    {loading && <p role="status">{t("sessions.search.searching")}</p>}
    {group.matchCount > 3 && <button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? "sessions.search.collapse" : "sessions.search.allMatches")}</button>}
    {open && data && data.total > data.pageSize && <Pager page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} label={t("sessions.search.localHits")} />}
  </article>;
}
export function SessionSearchGroups({ data, query, params, onPage, onSelect }: { data: SessionGroupedSearchResult; query: string; params: string; onPage: (page: number) => void; onSelect: (hit: SessionSearchHit) => void }) {
  useI18n();
  return <section aria-label={t("sessions.search.globalHits")}>
    {!!data.groups.length && <p className="session-search-totals">{t("sessions.search.groupTotals", { sessions: data.total, hits: data.hitCount })}</p>}
    {data.groups.map(group => <SearchGroup key={`${data.version}-${group.session.id}-${query}`} group={group} query={query} params={params} onSelect={onSelect} />)}
    {!data.groups.length && <div className="session-empty-list session-search-empty" role="status"><MagnifyingGlass size={22} aria-hidden="true" /><p>{t("sessions.search.empty")}</p></div>}
    {data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={onPage} label={t("sessions.list.pagination")} />}
  </section>;
}
