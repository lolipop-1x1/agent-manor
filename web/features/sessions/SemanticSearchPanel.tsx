import { Loading } from "../../shared/ui/Loading";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GearSix, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { SemanticScope, SemanticSearchResult, SemanticSettings, SemanticStatus } from "../../../src/semantic-contracts";
import type { SessionSearchGroup, SessionSearchHit } from "../../../src/session-contracts";
import { errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { sessionDisplayTitle } from "./session-model";
import { searchScopeInvalid, semanticStatusKey, semanticProgress } from "./semantic-ui-model";
import { SessionScopeFields } from "./SessionScopeFields";
import { SemanticSearchSettings, type SemanticFacets, type SemanticSettingsTab } from "./SemanticSearchSettings";
import { semanticRequest } from "./semantic-api";
import "./semantic-search.css";

function SemanticResultGroup({ group, selected, onSelect }: { group: SessionSearchGroup; selected: boolean; onSelect: (hit: SessionSearchHit) => void }) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <article className={`session-search-group semantic-result-group${selected ? " is-selected" : ""}`}>
    <button className="session-group-title" aria-current={selected ? "true" : undefined} onClick={() => onSelect({ session: group.session, kind: "title", snippet: "" })}><strong>{sessionDisplayTitle(group.session)}</strong></button>
    {(expanded ? group.hits : group.hits.slice(0, 1)).map((hit, index) => <button className="session-hit" key={`${hit.messageId}-${index}`} onClick={() => onSelect(hit)}><span className="session-hit-snippet">{hit.snippet}</span></button>)}
    <div className="semantic-result-source" title={group.session.project}>{clientLabel(group.session.client)}{group.session.project && <> · {group.session.project.split(/[\\/]/).filter(Boolean).at(-1)}</>}{group.session.updatedAt && <> · {new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(new Date(group.session.updatedAt))}</>}</div>
    {group.hits.length > 1 && <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? "sessions.search.collapse" : "sessions.semantic.search.moreSnippets", { count: group.hits.length - 1 })}</button>}
  </article>;
}

export function SemanticSearchPanel({ active, historyVersion, mode, onModeChange, query, onQueryChange, selectedSessionId, scope, onScopeChange, includeProcess, onIncludeProcessChange, keywordControls, keywordFallback, children, onSelect }: {
  active: boolean; historyVersion?: string; mode: "keyword" | "semantic"; onModeChange: (mode: "keyword" | "semantic") => void; query: string; onQueryChange: (value: string) => void; selectedSessionId?: string;
  scope: SemanticScope; onScopeChange: (scope: SemanticScope) => void; includeProcess: boolean; onIncludeProcessChange: (value: boolean) => void; keywordControls: ReactNode; keywordFallback?: ReactNode; children: ReactNode; onSelect: (hit: SessionSearchHit) => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SemanticSettings>();
  const [status, setStatus] = useState<SemanticStatus>();
  const [facets, setFacets] = useState<SemanticFacets>({ clients: [], projects: [], models: [] });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SemanticSettingsTab>("connection");
  const [sort, setSort] = useState<"relevance" | "updated">("relevance");
  const [result, setResult] = useState<{ query: string; data: SemanticSearchResult; scope: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const committedQuery = useRef("");
  const openSettings = (next?: SemanticSettingsTab) => { if (next) setTab(next); setOpen(true); };
  const refresh = async () => { const next = await semanticRequest<SemanticStatus>("/status"); setStatus(next); };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoadError(undefined);
    void Promise.all([semanticRequest<SemanticSettings>("/settings", undefined, undefined, controller.signal), semanticRequest<SemanticStatus>("/status", undefined, undefined, controller.signal)])
      .then(([nextSettings, nextStatus]) => { if (!controller.signal.aborted) { setSettings(nextSettings); setStatus(nextStatus); } }).catch(failure => { if (!isAborted(failure)) setLoadError(failure); });
    return () => controller.abort();
  }, [active, retry]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void request<SemanticFacets>("/sessions/facets", { signal: controller.signal }).then(setFacets).catch(failure => { if (!isAborted(failure)) setLoadError(failure); });
    return () => controller.abort();
  }, [active, historyVersion, retry]);
  useEffect(() => {
    if (!active || !settings || !settings.config.connection.model && !open) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void semanticRequest<SemanticStatus>("/status", undefined, undefined, controller.signal).then(setStatus).catch(failure => { if (!isAborted(failure)) setLoadError(failure); }); }, status?.job?.status === "running" || open ? 1500 : 15000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [active, settings?.config.connection.model, status?.job?.status, open]);
  useEffect(() => () => { pending.current?.abort(); pending.current = undefined; }, []);
  useEffect(() => { if (!active) { pending.current?.abort(); pending.current = undefined; setLoading(false); } }, [active]);
  const switchMode = (next: "keyword" | "semantic") => {
    if (next === mode) return;
    if (next === "semantic" && (!status?.enabled || !status.ready)) { openSettings(!settings?.config.connection.model ? "connection" : "build"); return; }
    pending.current?.abort(); setLoading(false);
    onModeChange(next);
    if (next === "semantic" && committedQuery.current) void search(committedQuery.current, scope, sort, 1, true);
  };
  const search = async (text: string, nextScope = scope, nextSort = sort, page = 1, cacheOnly = false) => {
    if (!text.trim() || !status?.enabled || !status.ready) return;
    if (searchScopeInvalid(nextScope)) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setLoading(true); setError(undefined);
    if (!cacheOnly) committedQuery.current = text.trim();
    try {
      const data = await semanticRequest<SemanticSearchResult>("/search", { q: text.trim(), scope: nextScope, sort: nextSort, page, pageSize: 12, cacheOnly }, "POST", controller.signal);
      if (pending.current === controller && !controller.signal.aborted) { setResult({ query: text.trim(), data, scope: JSON.stringify(nextScope) }); void refresh().catch(() => {}); }
    } catch (failure) { if (pending.current === controller && !controller.signal.aborted && !isAborted(failure)) setError(failure); }
    finally { if (pending.current === controller) { pending.current = undefined; setLoading(false); } }
  };
  const progress = semanticProgress(status);
  const label = settings && !settings.config.connection.model ? t("sessions.semantic.status.unconfigured") : status?.job?.status === "running" && progress !== undefined ? t("sessions.semantic.status.percent", { percent: progress }) : t(semanticStatusKey(status));
  return <>
    <div className="semantic-mode-row"><div className="session-mode-tabs semantic-mode-tabs" role="group" aria-label={t("sessions.semantic.search.mode")}><button aria-pressed={mode === "keyword"} className={mode === "keyword" ? "is-selected" : ""} onClick={() => switchMode("keyword")}>{t("sessions.semantic.keyword")}</button><button aria-pressed={mode === "semantic"} className={mode === "semantic" ? "is-selected" : ""} onClick={() => switchMode("semantic")}>{t("sessions.semantic.semantic")}</button></div><div className="semantic-mode-actions"><button className="semantic-status-button" aria-label={t("sessions.semantic.status.open", { status: label })} title={label} onClick={() => openSettings(settings?.config.connection.model ? "build" : "connection")}>{status?.job?.status === "running" && <Loading variant="inline" size={12} />}<span>{label}</span></button><button className="icon-button" aria-label={t("sessions.semantic.settings")} onClick={() => openSettings()}><GearSix size={17} /></button></div></div>
    {loadError && <div className="semantic-inline-error" role="alert"><span>{errorMessage(loadError)}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button></div>}
    {mode === "keyword" ? <><div className="semantic-query-row">{keywordControls}</div><SessionScopeFields value={scope} onChange={onScopeChange} {...facets} includeProcess={includeProcess} onIncludeProcessChange={onIncludeProcessChange} />{children}</> : <>
      <div className="semantic-query-row"><label className="session-search-field"><MagnifyingGlass size={16} aria-hidden="true" /><input ref={input} aria-label={t("sessions.semantic.search.label")} value={query} onChange={event => onQueryChange(event.target.value)} placeholder={t("sessions.semantic.search.placeholder")} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void search(query); } }} />{query && <button aria-label={t("sessions.search.clear")} onClick={() => { onQueryChange(""); input.current?.focus(); }}><X size={14} /></button>}</label><button className="button primary semantic-submit" aria-label={t("sessions.semantic.search.submit")} aria-busy={loading} disabled={!query.trim() || !status?.ready || !status.enabled || loading || searchScopeInvalid(scope)} onClick={() => void search(query)}><span className="semantic-submit-progress">{loading && <Loading variant="inline" size={14} />}</span><span className={loading ? "semantic-submit-label is-loading" : "semantic-submit-label"}>{t("sessions.semantic.search.submit")}</span></button></div>
      <SessionScopeFields value={scope} onChange={next => { onScopeChange(next); if (committedQuery.current) void search(committedQuery.current, next, sort, 1, true); }} {...facets} />
      <div className="semantic-results-toolbar"><span>{result ? t("sessions.semantic.search.results", { count: result.data.total }) : keywordFallback ? t("sessions.semantic.search.previousKeyword") : t("sessions.semantic.search.submitPrompt")}</span><div>{result && <HelpPopover iconOnly label={t("sessions.semantic.search.coverage")}><p>{t("sessions.semantic.search.coverageHelp", { count: result.data.coveredSessions })}</p>{result.data.limited && <p>{t("sessions.semantic.search.limited")}</p>}</HelpPopover>}<FilterSelect label={t("sessions.semantic.search.sort")} value={sort} options={[{ value: "relevance", label: t("sessions.semantic.search.relevance") }, { value: "updated", label: t("sessions.semantic.search.updated") }]} onChange={next => { const value = next as "relevance" | "updated"; setSort(value); if (committedQuery.current) void search(committedQuery.current, scope, value, 1, true); }} /></div></div>
      {error && <div className="semantic-inline-error" role="alert"><span>{errorMessage(error)}</span><button className="text-button" onClick={() => void search(query)}>{t("sessions.semantic.search.again")}</button></div>}
      {(!status?.enabled || !status.ready) && <div className="semantic-inline-error" role="alert"><span>{label}</span><button className="text-button" onClick={() => openSettings("build")}>{t("sessions.semantic.settings")}</button></div>}
      <div className="session-list semantic-results" aria-busy={loading} inert={loading || searchScopeInvalid(scope) || !!result && result.scope !== JSON.stringify(scope) || undefined} aria-label={t("sessions.semantic.search.resultLabel")}>
        {result ? <><div className="semantic-result-query" title={result.query}>{t("sessions.semantic.search.forQuery", { query: result.query })}</div>{result.data.groups.map(group => <SemanticResultGroup key={`${result.data.version}-${result.query}-${group.session.id}`} group={group} selected={group.session.id === selectedSessionId} onSelect={onSelect} />)}{!result.data.groups.length && <div className="session-empty-list session-search-empty" role="status"><MagnifyingGlass size={24} aria-hidden="true" /><p>{t("sessions.semantic.search.empty")}</p><button className="text-button" onClick={() => openSettings("build")}>{t("sessions.semantic.search.viewCoverage")}</button></div>}{result.data.total > result.data.pageSize && <ResourcePagination compact page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} onChange={page => void search(result.query, scope, sort, page, true)} label={t("sessions.list.pagination")} />}</> : keywordFallback ?? <div className="session-empty-list session-search-empty"><MagnifyingGlass size={24} aria-hidden="true" /><p>{t("sessions.semantic.search.submitPrompt")}</p></div>}
      </div>
    </>}
    <SemanticSearchSettings open={open && active} initialTab={tab} onTabChange={setTab} settings={settings} status={status} facets={facets} onClose={() => setOpen(false)} onSaved={next => { setSettings(next); void refresh().catch(setLoadError); }} onStatus={setStatus} onGoSearch={() => { setOpen(false); switchMode("semantic"); requestAnimationFrame(() => input.current?.focus()); }} />
  </>;
}
