import { useEffect, useState } from "react";
import type { KnowledgeExtractionScope, KnowledgeJob, KnowledgePreview, KnowledgeTaskStatus } from "../../../src/knowledge-contracts";
import type { SessionSearchFacets } from "../../../src/session-contracts";
import type { SemanticScope } from "../../../src/semantic-contracts";
import { isAborted, request } from "../../shared/api";
import { formatList, useI18n } from "../../shared/i18n";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { SessionScopeFields } from "../sessions/SessionScopeFields";
import { semanticCost, semanticQueryScope, searchScopeInvalid } from "../sessions/semantic-ui-model";
import { knowledgeRequest } from "./knowledge-api";
import { KnowledgeBusy, KnowledgeDiagnostic, KnowledgeError, KnowledgeLimitations } from "./KnowledgeCommon";
import "../sessions/semantic-search.css";

export function KnowledgeScopeFields({ value, onChange, facets }: { value: KnowledgeExtractionScope; onChange: (scope: KnowledgeExtractionScope) => void; facets?: SessionSearchFacets }) {
  const { t } = useI18n();
  return <form className="knowledge-scope-fields" onSubmit={event => event.preventDefault()}>
    {value.sessionIds?.length ? <><div className="knowledge-form-heading"><strong>{t("knowledge.selectedSession")}</strong><button className="text-button" type="button" onClick={() => onChange({ ...value, sessionIds: undefined, turnStart: undefined, turnEnd: undefined })}>{t("knowledge.clearSession")}</button></div><div className="knowledge-form-grid">{(["turnStart", "turnEnd"] as const).map(key => <label key={key} className="knowledge-field"><span>{t(`knowledge.${key}`)}</span><input type="number" min={1} value={value[key] ?? ""} onChange={event => onChange({ ...value, [key]: event.target.value ? Number(event.target.value) : undefined })} /></label>)}</div></> : <SessionScopeFields value={{ ...value, branch: value.branch === "all" ? "all" : "current" } as SemanticScope} onChange={scope => onChange({ ...value, ...scope })} {...facets} maintenance />}
    <details className="knowledge-details"><summary>{t("knowledge.more")}</summary><label className="knowledge-check"><input type="checkbox" checked={value.force ?? false} onChange={event => onChange({ ...value, force: event.target.checked })} />{t("knowledge.force")}</label></details>
    {value.turnStart !== undefined && value.turnEnd !== undefined && value.turnStart > value.turnEnd && <p className="knowledge-error" role="alert">{t("knowledge.invalidRange")}</p>}
  </form>;
}

export function KnowledgeTasks({ active, initialScope, onResults, onBack, onSettings }: { active: boolean; initialScope?: KnowledgeExtractionScope; onResults: (taskId: string) => void; onBack: () => void; onSettings: () => void }) {
  const { t, language, number, dateTime } = useI18n();
  const [scope, setScope] = useState<KnowledgeExtractionScope>(initialScope ?? { ...semanticQueryScope(), timeRange: "recent", recentDays: 7, branch: "current" });
  const [preview, setPreview] = useState<KnowledgePreview>();
  const [status, setStatus] = useState<KnowledgeTaskStatus>();
  const [selectedJob, setSelectedJob] = useState<string>();
  const [facets, setFacets] = useState<SessionSearchFacets>();
  const [busy, setBusy] = useState(false), [polling, setPolling] = useState(false), [error, setError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [targetPage, setTargetPage] = useState(1);
  const [reload, setReload] = useState(0), [scopeLocked, setScopeLocked] = useState(false);
  const [newScope, setNewScope] = useState(Boolean(initialScope));
  useEffect(() => { if (initialScope) { setNewScope(true); setScope(initialScope); setPreview(undefined); setScopeLocked(false); setSelectedJob(undefined); } }, [initialScope]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void request<SessionSearchFacets>("/sessions/facets", { signal: controller.signal }).then(setFacets).catch(failure => { if (!isAborted(failure)) setLoadError(failure); });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      setPolling(true);
      try { const next = await knowledgeRequest<KnowledgeTaskStatus>("/extractions", undefined, undefined, controller.signal); setStatus(next); setLoadError(undefined); if (!newScope && next.jobs.length) { setSelectedJob(current => current ?? next.jobs.find(item => item.status === "running" || item.status === "paused")?.id ?? next.jobs[0]?.id); setScopeLocked(true); } }
      catch (failure) { if (!isAborted(failure)) setLoadError(failure); }
      finally { if (!controller.signal.aborted) { setPolling(false); timer = setTimeout(() => void poll(), document.hidden ? 10_000 : 1800); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [active, reload, newScope]);
  const job = status?.jobs.find(item => item.id === selectedJob) ?? (scopeLocked ? status?.jobs[0] : undefined);
  useEffect(() => {
    if (!active || !scopeLocked || !job || preview?.id === job.previewId) return;
    const controller = new AbortController();
    void knowledgeRequest<KnowledgePreview>(`/extractions/previews/${encodeURIComponent(job.previewId)}`, undefined, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setPreview(value); setScope(value.scope); setTargetPage(1); } })
      .catch(failure => { if (!isAborted(failure)) setLoadError(failure); });
    return () => controller.abort();
  }, [active, scopeLocked, job?.id, job?.previewId, reload]);
  const act = async (action: "preview" | "start" | "pause" | "resume" | "retry") => {
    setBusy(true); setError(undefined);
    try {
      if (action === "preview") { setPreview(await knowledgeRequest<KnowledgePreview>("/extractions/preview", { scope })); setTargetPage(1); setSelectedJob(undefined); }
      else { const next = await knowledgeRequest<KnowledgeJob>(action === "start" ? "/extractions" : `/extractions/${encodeURIComponent(job!.id)}/${action}`, action === "start" ? { previewId: preview!.id, idempotencyKey: crypto.randomUUID() } : {}); setSelectedJob(next.id); setScopeLocked(true); setNewScope(false); setStatus(current => current ? { ...current, jobs: [next, ...current.jobs.filter(item => item.id !== next.id)] } : { jobs: [next], usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: null, date: "" }, automatic: { enabled: false } }); }
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const phases = ["planning", "extracting", "merging", "saving", "complete"];
  const invalid = searchScopeInvalid({ ...scope, branch: scope.branch === "all" ? "all" : "current" }) || scope.turnStart !== undefined && scope.turnEnd !== undefined && scope.turnStart > scope.turnEnd;
  return <section className="knowledge-tasks-page"><header className="knowledge-page-heading"><button className="button subtle" onClick={onBack}>{t("knowledge.back")}</button><h1>{t("knowledge.tasks")}</h1><KnowledgeBusy busy={busy || polling} /><HelpPopover label={t("knowledge.taskHelp")} iconOnly><p>{t("knowledge.taskHelpBody")}</p></HelpPopover><button className="button" onClick={() => { setScopeLocked(false); setNewScope(true); setPreview(undefined); setSelectedJob(undefined); }}>{t("knowledge.newPreview")}</button></header>
    <KnowledgeError error={error ?? loadError} retry={() => setReload(value => value + 1)} />
    {status?.automatic.error && <div className="knowledge-error" role="alert"><KnowledgeDiagnostic descriptor={status.automatic.errorDescriptor} original={status.automatic.error} /></div>}
    <div className="knowledge-task-columns"><section className="knowledge-task-scope"><h2>{t("knowledge.preview")}</h2><fieldset disabled={busy || scopeLocked}>
      {!scopeLocked ? <KnowledgeScopeFields value={scope} facets={facets} onChange={next => { setScope(next); setPreview(undefined); }} /> : <><p className="knowledge-meta">{t("knowledge.locked")}</p>{preview?.id === job?.previewId && <dl className="knowledge-facts"><div><dt>{t("sessions.semantic.scope.time")}</dt><dd>{t(scope.timeRange === "recent" ? "sessions.semantic.scope.summaryRecent" : scope.timeRange === "all" ? "sessions.semantic.scope.allHistory" : "sessions.semantic.scope.chooseTime", { days: scope.recentDays })}</dd></div><div><dt>{t("knowledge.project")}</dt><dd>{scope.projects.length ? formatList(scope.projects) : t("knowledge.allProjects")}</dd></div><div><dt>{t("knowledge.client")}</dt><dd>{scope.clients.length ? formatList(scope.clients) : t("knowledge.allClients")}</dd></div><div><dt>{t("sessions.semantic.scope.branch")}</dt><dd>{scope.branch === "current" || scope.branch === "all" ? t(`sessions.branch.${scope.branch}`) : scope.branch}</dd></div>{scope.turnStart !== undefined && <div><dt>{t("knowledge.turnStart")}</dt><dd>{number(scope.turnStart)}</dd></div>}{scope.turnEnd !== undefined && <div><dt>{t("knowledge.turnEnd")}</dt><dd>{number(scope.turnEnd)}</dd></div>}</dl>}</>}
      {preview && <div className="knowledge-preview"><h3>{t("knowledge.previewCounts", { sessions: preview.sessionCount, turns: preview.turnCount })}</h3><dl className="knowledge-facts"><div><dt>{t("knowledge.estimatedTokens")}</dt><dd>{number(preview.estimatedTokens)}</dd></div><div><dt>{t("knowledge.estimatedCost")}</dt><dd>{semanticCost(preview.estimatedCost, language) ?? t("knowledge.unknown")}</dd></div></dl><details className="knowledge-details"><summary>{t("knowledge.more")}</summary><dl className="knowledge-facts"><div><dt>{t("knowledge.contextTokens")}</dt><dd>{number(preview.contextTokens)}</dd></div><div><dt>{t("knowledge.pendingMessages")}</dt><dd>{number(preview.pendingMessages)}</dd></div><div><dt>{t("knowledge.skippedMessages")}</dt><dd>{number(preview.skippedMessages)}</dd></div></dl></details><ol className="knowledge-targets">{preview.targets.slice((targetPage - 1) * 20, targetPage * 20).map(target => <li key={`${target.sessionId}:${target.branch}`}><strong>{target.title}</strong><span>{t("knowledge.sourceTurns", { turns: target.turnCount })}</span></li>)}</ol>{preview.targets.length > 20 && <ResourcePagination page={targetPage} pageSize={20} total={preview.targets.length} label={t("knowledge.preview")} onChange={setTargetPage} />}{!!preview.limitations.length && <details className="knowledge-details"><summary>{t("knowledge.limitations")}</summary><KnowledgeLimitations originals={preview.limitations} details={preview.limitationDetails} /></details>}</div>}
    </fieldset>{!scopeLocked && <div className="knowledge-task-start"><button className="button" disabled={busy || invalid} onClick={() => void act("preview")}>{t("knowledge.previewAction")}</button>{preview && <button className="button primary" disabled={busy || !preview.sessionCount} onClick={() => void act("start")}>{t("knowledge.start")}</button>}</div>}<button className="text-button" onClick={onSettings}>{t("knowledge.settings")}</button></section>
    <section className="knowledge-task-progress"><h2>{t("knowledge.currentTask")}</h2>{job ? <>
      <div className="knowledge-task-status"><strong>{t(`knowledge.status.${job.status}`)}</strong><span>{t("knowledge.sessionsProgress", { completed: job.completedSessions, total: job.totalSessions })}</span>{job.status === "running" || job.status === "queued" ? <button className="button" disabled={busy} onClick={() => void act("pause")}>{t("knowledge.pause")}</button> : job.status !== "complete" && <button className="button" disabled={busy} onClick={() => void act(job.status === "paused" ? "resume" : "retry")}>{t(job.status === "paused" ? "knowledge.resume" : "knowledge.retry")}</button>}</div>
      {job.totalChunks > 0 && <div className="knowledge-progress"><progress aria-label={t("knowledge.currentTask")} value={job.completedChunks} max={job.totalChunks} /><span>{t("knowledge.chunks", { completed: job.completedChunks, total: job.totalChunks })}</span></div>}
      <ol className="knowledge-phases">{phases.map((phase, index) => <li key={phase} aria-current={phase === job.phase ? "step" : undefined} className={phases.indexOf(job.phase) > index ? "is-complete" : ""}><span>{index + 1}</span><strong>{t(`knowledge.phase.${phase}`)}</strong></li>)}</ol>
      {job.error && <div className="knowledge-error" role="alert"><KnowledgeDiagnostic descriptor={job.errorDescriptor} original={job.error} /></div>}
      {!!job.failedSessions.length && <details open className="knowledge-details"><summary>{t("knowledge.failures")}</summary><ul>{job.failedSessions.map((item, index) => <li key={`${item.sessionId}:${index}`}><strong>{item.title}</strong><div className="knowledge-error"><KnowledgeDiagnostic descriptor={item.errorDescriptor} original={item.error} /></div></li>)}</ul></details>}
      <div className="knowledge-task-results"><strong>{t("knowledge.resultsCount", { count: job.createdEntries, updated: job.updatedEntries })}</strong><button className="button" disabled={!job.results.length} onClick={() => onResults(job.id)}>{t("knowledge.results")}</button></div>
      <dl className="knowledge-facts">{(["duplicates", "noValue", "needsContext"] as const).map(key => <div key={key}><dt>{t(`knowledge.${key}`)}</dt><dd>{number(job[key])}</dd></div>)}</dl>
    </> : <p className="knowledge-empty-inline">{t("knowledge.noTasks")}</p>}
    <details className="knowledge-details" open={!job}><summary>{t("knowledge.taskHistory")}</summary><ol className="knowledge-job-history">{status?.jobs.map(item => <li key={item.id}><button onClick={() => { setSelectedJob(item.id); setScopeLocked(true); setNewScope(false); if (preview?.id !== item.previewId) setPreview(undefined); }}><time>{dateTime(item.createdAt)}</time><span>{t(`knowledge.status.${item.status}`)}</span><span>{t("knowledge.resultsCount", { count: item.createdEntries, updated: item.updatedEntries })}</span></button></li>)}</ol></details>
    </section></div>
  </section>;
}
