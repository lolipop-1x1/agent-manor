import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowClockwise, ArrowSquareOut, CaretDown, CaretLeft, CaretRight, CaretUp, Check, CircleNotch, Code, FileCode, Folder, MagnifyingGlass, MapTrifold, Plus, Stack, Trash, WarningCircle, X } from "@phosphor-icons/react";
import type { Client, CoverageQuery, CoverageResult, DeleteRepositoryResponse, EvidenceResponse, FileCategory, FileDetail, FileEvent, Filters, Gap, HistoryEvent, IndexMaintenanceResult, Job, JobResponse, MapSession, MapSessionsResponse, RegisterRepositoryResponse, Repository, SourcesResponse, StatusResponse } from "../../../src/contracts";
import type { SessionIndexSummary, SessionSummary } from "../../../src/session-contracts";
import { CLIENTS } from "../../../src/clients";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { queryString, repositoryPath } from "./api";
import { CodeMap } from "./CodeMap";
import { Hint } from "../../shared/ui/Hint";
import { DirectoryTree } from "./DirectoryTree";
import { ResizableWorkspace } from "../../shared/layout/ResizableWorkspace";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { availableClientOptions } from "../../shared/ui/client-options";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { DatePicker } from "../../shared/ui/DatePicker";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useVisiblePolling } from "../../shared/refresh/useVisiblePolling";
import { clientLabel, isMessageDescriptorKnown, messageText, t, useI18n } from "../../shared/i18n";
import { boundQuery, categoryNames, fileHighlights, filename, gapNames, metricNames, metricValue, rangesLabel, refreshFailureReason, type Metric } from "./model";
import { dateLabel, fmt, percent } from "../../shared/format";
import { timeFilters } from "../../shared/time-filters";
import { type Theme } from "../../shared/theme";
import "./repository-dialog.css";

const kindKeys = { read: "codeMap.kind.read", edit: "codeMap.kind.edit", search: "codeMap.kind.search", other: "codeMap.kind.other" };
const statusKeys = { success: "codeMap.status.success", failure: "codeMap.status.failure", unknown: "codeMap.status.unknown" };
const jobActive = (job: Job | null) => job?.status === "queued" || job?.status === "running";
const mapSessionKey = (session: Pick<MapSession, "client" | "clientSessionId">) => JSON.stringify([session.client, session.clientSessionId]);
const mapSessionTitle = (session: MapSession) => messageText(session.titleDescriptor, session.title ?? session.clientSessionId);
const CodeViewer = lazy(() => import("./CodeViewer").then(module => ({ default: module.CodeViewer })));

function Notice({ children, action, danger = false }: { children: ReactNode; action?: ReactNode; danger?: boolean }) {
  return <div className={`notice${danger ? " danger" : ""}`} role={danger ? "alert" : "status"}><WarningCircle size={17} /><div>{children}</div>{action}</div>;
}

function ErrorDetails({ error }: { error: unknown }) {
  useI18n();
  const original = (error instanceof Error || typeof error === "string") && !(error instanceof ApiError && isMessageDescriptorKnown(error.messageDescriptor));
  return <>{original && <strong>{t("common.originalDetails")}: </strong>}{errorMessage(error)}</>;
}

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><MapTrifold size={32} /><h2>{title}</h2><p>{children}</p>{action}</div>;
}

function Modal({ open, onOpenChange, title, description, children, wide = false, fallbackFocus, busy = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; wide?: boolean; fallbackFocus?: RefObject<HTMLElement | null>;
  busy?: boolean;
}) {
  useI18n();
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`dialog-content${wide ? " wide" : ""}`}
    onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}
    onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => {
      const target = returnFocus.current?.isConnected && returnFocus.current !== document.body ? returnFocus.current : fallbackFocus?.current;
      if (target?.isConnected) { event.preventDefault(); target.focus(); }
    }}>
    <Dialog.Title>{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description>
    <Dialog.Close asChild><button className="icon-button dialog-close" disabled={busy} aria-label={t("codeMap.dialog.close")}><X size={18} /></button></Dialog.Close>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function Gaps({ gaps }: { gaps: Gap[] }) {
  useI18n();
  if (!gaps.length) return <p className="muted">{t("codeMap.gaps.empty")}</p>;
  return <div className="gap-list">{gaps.map((gap, i) => <div key={`${gap.kind}-${gap.sourceId ?? i}`}><strong>{gapNames[gap.kind]}{gap.count !== undefined ? ` · ${fmt(gap.count)}` : ""}</strong><p>{!isMessageDescriptorKnown(gap.messageDescriptor) && <strong>{t("common.originalDetails")}: </strong>}{messageText(gap.messageDescriptor, gap.message)}{gap.details?.map((item, index) => <span key={index}> · {!isMessageDescriptorKnown(item) && <strong>{t("common.originalDetails")}: </strong>}{messageText(item, gap.message)}</span>)}</p>{gap.sourceId && <small>{t("codeMap.sourceId", { id: gap.sourceId })}</small>}</div>)}</div>;
}

function SourcesDialog({ repo, query, gapCount, onJob }: { repo: Repository; query?: CoverageQuery; gapCount: number; onJob: (job: Job) => void }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [associating, setAssociating] = useState<string | null>(null);
  const key = queryString(query ?? {});
  useEffect(() => {
    if (!open || !query?.version) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    void request<SourcesResponse>(`${repositoryPath(repo.id)}/sources${key}`, { signal: controller.signal })
      .then(result => { if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "来源返回的结果版本发生变化，请刷新后重试。", { key: "codeMap.error.versionSources" }); setData(result); })
      .catch(failure => { if (!isAborted(failure)) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, repo.id, key, retry, query?.version]);
  const associate = async (sourceId: string) => {
    setAssociating(sourceId); setError(null);
    try {
      const response = await request<JobResponse>(`${repositoryPath(repo.id)}/associations`, { method: "POST", body: { sourceId } });
      onJob(response.job); setOpen(false);
    } catch (failure) { setError(failure); }
    finally { setAssociating(null); }
  };
  return <>
    <button className="button subtle" aria-label={t("codeMap.sources.trigger")} onClick={() => setOpen(true)}><Stack size={17} /><span className="desktop-text">{t("codeMap.sources.trigger")}</span>{gapCount > 0 && <span className="count-badge">{fmt(gapCount)}</span>}</button>
    <Modal open={open} onOpenChange={setOpen} title={t("codeMap.sources.title")} description={t("codeMap.sources.description")}>
      {!query?.version && <p className="muted">{t("codeMap.sources.notReady")}</p>}
      {loading && <p className="muted" role="status">{t("codeMap.sources.loading")}</p>}
      {!!error && <Notice danger action={<button className="button subtle" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><ErrorDetails error={error} /></Notice>}
      {data && <>
        <div className="source-summary">{CLIENTS.map(client => <div key={client.id}><strong>{fmt(data.sources.filter(source => source.client === client.id).length)}</strong><span>{t("codeMap.sources.clientSources", { client: clientLabel(client.id) })}</span></div>)}<div><strong>{fmt(data.unassociated.length)}</strong><span>{t("codeMap.sources.pending")}</span></div></div>
        <h3>{t("codeMap.sources.associated")}</h3><div className="source-list">{data.sources.map(source => <div className="source-row" key={source.sourceId}><strong>{clientLabel(source.client)}<small>{source.association === "manual" ? t("codeMap.sources.manual") : t("codeMap.sources.auto")} · {t("codeMap.event.count", { count: source.eventCount })}</small></strong><code>{source.path}</code><small>{t("codeMap.sessionId", { id: source.sessionId })}</small></div>)}{!data.sources.length && <p className="muted">{t("codeMap.sources.noAssociated")}</p>}</div>
        <h3>{t("codeMap.sources.unassociated")}</h3>{data.unassociated.length > 0 && <p className="muted small">{t("codeMap.sources.confirm", { repository: repo.name })}</p>}
        <div className="source-list">{data.unassociated.map(source => <div className="source-row" key={source.sourceId}><strong>{clientLabel(source.client)} · {source.sessionId}</strong><code>{source.path}</code><small>{t("codeMap.sources.cwd", { path: source.cwd ?? t("common.unknown") })}</small><button className="button" disabled={associating !== null} onClick={() => void associate(source.sourceId)}>{associating === source.sourceId ? t("codeMap.sources.associating") : t("codeMap.sources.associate")}</button></div>)}{!data.unassociated.length && <p className="muted">{t("codeMap.sources.noUnassociated")}</p>}</div>
        <h3>{t("codeMap.gaps.title")}</h3><Gaps gaps={data.gaps} /><p className="version-note">{t("codeMap.version.result", { version: data.version })}</p>
      </>}
    </Modal>
  </>;
}

function CoverageGaps({ repoId, query, count }: { repoId: string; query: CoverageQuery; count: number }) {
  useI18n();
  const [open, setOpen] = useState(false), [data, setData] = useState<{ version: string; gaps: Gap[] }>();
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(), [retry, setRetry] = useState(0);
  const key = queryString(query);
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => {
    if (!open || loadedKey === key) return;
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void request<{ version: string; gaps: Gap[] }>(`${repositoryPath(repoId)}/coverage/gaps${key}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && result.version === query.version) { setData(result); setLoadedKey(key); } })
      .catch(error => { if (!isAborted(error)) setError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, repoId, key, retry]);
  return <details className="coverage-gaps" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><WarningCircle size={15} />{t("codeMap.gaps.count", { count })}</summary>
    {open && <>{loading && <p role="status">{t("codeMap.sources.loading")}</p>}{!!error && <Notice danger action={<button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><ErrorDetails error={error} /></Notice>}{data && loadedKey === key && <Gaps gaps={data.gaps} />}</>}
  </details>;
}

function EvidenceDialog({ repoId, event, query, open, onOpenChange }: { repoId: string; event: HistoryEvent | null; query: CoverageQuery; open: boolean; onOpenChange: (open: boolean) => void }) {
  useI18n();
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = queryString(query);
  useEffect(() => {
    if (!open || !event) return;
    const controller = new AbortController();
    setData(null); setError(null); setLoading(true);
    void request<EvidenceResponse>(`${repositoryPath(repoId)}/evidence/${encodeURIComponent(event.id)}${key}`, { signal: controller.signal })
      .then(result => { if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "原始证据与当前结果版本不一致，请刷新后重试。", { key: "codeMap.error.versionEvidence" }); setData(result); })
      .catch(failure => { if (!isAborted(failure)) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, event?.id, repoId, key, query.version, retry]);
  return <Modal open={open} onOpenChange={onOpenChange} title={t("codeMap.evidence.title")} description={t("codeMap.evidence.description")} wide>
    {loading && <p role="status" className="muted">{t("codeMap.evidence.loading")}</p>}
    {!!error && <Notice danger action={<button className="button subtle" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button>}><ErrorDetails error={error} /></Notice>}
    {data && <>
      <div className="evidence-meta"><strong>{data.event.tool} · {t(statusKeys[data.event.status])}</strong><span>{dateLabel(data.event.occurredAt)}</span><code>{t("codeMap.eventId", { id: data.event.id })}</code><code>{t("codeMap.sessionId", { id: data.event.sessionId })}</code>{data.event.parentSessionId && <code>{t("codeMap.parentSessionId", { id: data.event.parentSessionId })}</code>}</div>
      {data.unavailable.length > 0 && <Notice>{t("codeMap.evidence.unavailable", { count: data.unavailable.length })}</Notice>}
      {data.records.map((record, i) => <section className="raw-record" key={`${record.source.sourceId}-${record.source.recordLine}-${i}`}><h3>{t("codeMap.evidence.record", { index: fmt(i + 1), line: fmt(record.source.recordLine) })}</h3><code className="record-path">{record.source.path}</code><small>{t("codeMap.evidence.sourceHash", { source: record.source.sourceId, hash: record.source.hash })}{record.source.callId ? t("codeMap.evidence.call", { id: record.source.callId }) : ""}</small><pre tabIndex={0}>{record.raw}</pre></section>)}
      {!data.records.length && !data.unavailable.length && <p className="muted">{t("codeMap.evidence.empty")}</p>}
      {data.unavailable.map((source, i) => <p className="muted record-path" key={i}>{source.path} · L{source.recordLine} · {source.hash}</p>)}
      <p className="version-note">{t("codeMap.version.result", { version: data.version })}</p>
    </>}
  </Modal>;
}

function EventDetails({ event, openEvidence, openCode, openSession, stale, sessionTitle }: { event: FileEvent; sessionTitle?: string; openEvidence: () => void; openCode: (line?: number) => void; openSession: () => void; stale: boolean }) {
  useI18n();
  return <div className="event-detail"><h3>{event.tool}</h3><dl><dt>{t("codeMap.event.result")}</dt><dd className={`event-status ${event.status}`}>{t(statusKeys[event.status])}</dd><dt>{t("codeMap.event.session")}</dt><dd title={event.sessionId}>{sessionTitle ?? event.sessionId}</dd><dt>{t("codeMap.event.time")}</dt><dd>{dateLabel(event.occurredAt)}</dd></dl>
    {event.mapping?.unknownReason && <p className="muted small">{t("codeMap.event.unknownReason", { reason: event.mapping.unknownReasonDescriptors?.map(item => isMessageDescriptorKnown(item) ? messageText(item, event.mapping!.unknownReason) : t("common.originalDetail", { detail: event.mapping!.unknownReason! })).join("; ") ?? t("common.originalDetail", { detail: event.mapping.unknownReason }) })}</p>}
    {event.reason && <p className="muted small">{!isMessageDescriptorKnown(event.reasonDescriptor) && <strong>{t("common.originalDetails")}: </strong>}{messageText(event.reasonDescriptor, event.reason)}</p>}
    {!!event.mapping?.exactRanges.length && <button className="range-link" disabled={stale} onClick={() => openCode(event.mapping!.exactRanges[0]!.start)}>{t("codeMap.event.exactRange", { ranges: rangesLabel(event.mapping.exactRanges) })}</button>}
    {!!event.mapping?.nearRanges.length && <button className="range-link near-label" disabled={stale} onClick={() => openCode(event.mapping!.nearRanges[0]!.start)}>{t("codeMap.event.nearRange", { ranges: rangesLabel(event.mapping.nearRanges) })}</button>}
    <button className="button subtle" onClick={openSession}><ArrowSquareOut size={15} />{t("codeMap.event.openSession")}</button>
    <button className="button evidence-button" onClick={openEvidence}><ArrowSquareOut size={15} />{t("codeMap.event.rawCount", { count: event.sources.length })}</button>
    <details className="event-payload"><summary>{t("codeMap.event.payload")}</summary><h4>{t("codeMap.event.request")}</h4><pre tabIndex={0}>{JSON.stringify(event.input ?? null, null, 2)}</pre><h4>{t("codeMap.event.result")}</h4><pre tabIndex={0}>{JSON.stringify(event.output ?? null, null, 2)}</pre></details>
  </div>;
}

function FilePane({ repoId, detail, loading, error, retry, collapsed, toggle, metric, theme, query, openSession, sessions }: {
  repoId: string; detail: FileDetail | null; loading: boolean; error: unknown; retry: () => void; collapsed: boolean; toggle: () => void;
  metric: Metric; theme: Theme; query?: CoverageQuery; openSession: (event: HistoryEvent) => void; sessions: MapSession[];
}) {
  useI18n();
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [showNear, setShowNear] = useState(true);
  const [jumpLine, setJumpLine] = useState<number | undefined>();
  const [lineInput, setLineInput] = useState("1");
  const [eventLimit, setEventLimit] = useState(30);
  useEffect(() => { setSelectedEvent(null); setCodeOpen(false); setRawOpen(false); setEventLimit(30); setJumpLine(undefined); }, [detail?.file.path, detail?.version]);
  const highlights = useMemo(() => detail ? fileHighlights(detail, metric, showNear) : { exact: [], near: [] }, [detail, metric, showNear]);
  const active = detail?.events.find(event => event.id === selectedEvent) ?? detail?.events[0] ?? null;
  const activeSession = active ? sessions.find(item => item.client === active.client && item.clientSessionId === active.sessionId) : undefined;
  const openCode = (line?: number) => { setJumpLine(line); if (line) setLineInput(String(line)); setCodeOpen(true); };
  return <aside className={`evidence-pane${collapsed ? " panel-collapsed" : ""}`} aria-label={t("codeMap.file.title")}>
    <div className="pane-heading"><span>{t("codeMap.file.title")}</span><Hint label={collapsed ? t("codeMap.file.expand") : t("codeMap.file.collapse")}><button className="icon-button panel-toggle" aria-label={collapsed ? t("codeMap.file.expand") : t("codeMap.file.collapse")} aria-expanded={!collapsed} aria-controls="file-details-content" onClick={toggle}>{collapsed ? <CaretLeft size={17} /> : <CaretRight size={17} />}</button></Hint></div>
    <div id="file-details-content" hidden={collapsed}>
    {loading ? <p className="muted" role="status">{t("codeMap.file.loading")}</p> : error ? <Notice danger action={<button className="button subtle" onClick={retry}>{t("common.retry")}</button>}><ErrorDetails error={error} /></Notice> : !detail ? <div className="no-selection"><FileCode size={30} /><h2>{t("codeMap.file.select")}</h2></div> : <>
      <h2>{filename(detail.file.path)}</h2><p className="file-path">{detail.file.path}</p>
      <div className="file-stats"><div><strong>{percent(detail.file.readExactLines, detail.file.lineCount)}</strong><span>{t("codeMap.metric.read")}</span></div><div><strong>{fmt(detail.file.readNearLines)}</strong><span>{t("codeMap.metric.readNearLines")}</span></div><div><strong>{fmt(detail.file.editExactLines)}</strong><span>{t("codeMap.metric.editExactLines")}</span></div></div>
      <p className="muted small">{t("codeMap.file.summary", { near: fmt(detail.file.editNearLines), lines: fmt(detail.file.lineCount), category: categoryNames[detail.file.category] })}</p>
      <div className="file-counts"><span>{t("codeMap.file.readCount", { count: detail.file.readCount })}</span><span>{t("codeMap.file.editCount", { count: detail.file.editCount })}</span><span>{t("codeMap.file.searchCount", { count: detail.file.searchCount })}</span><span>{t("codeMap.file.failedCount", { count: detail.file.failedCount })}</span><span>{t("codeMap.file.unknownCount", { count: detail.file.unknownCount })}</span></div>
      {detail.contentStale && <Notice>{t("codeMap.file.stale")}</Notice>}
      {detail.content === null ? <p className="muted">{t("codeMap.file.unreadable")}</p> : <button className="button view-code-button" onClick={() => openCode()}><Code size={16} />{t("codeMap.file.openCode")}</button>}
      <div className="section-heading"><h3>{t("codeMap.file.history")}</h3><span>{t("codeMap.activity.count", { count: detail.events.length })}</span></div>
      {!detail.events.length && <p className="muted small">{t("codeMap.file.noActivity")}</p>}
      <div className="event-list">{detail.events.slice(0, eventLimit).map(event => <button className={`event${active?.id === event.id ? " active" : ""}`} aria-pressed={active?.id === event.id} key={event.id} onClick={() => setSelectedEvent(event.id)}>
        <div className="event-head"><span className="client-mark">{CLIENTS.find(client => client.id === event.client)!.abbreviation}</span><strong>{clientLabel(event.client)}</strong><span>{t(kindKeys[event.kind])}</span></div><span className="event-session">{event.tool} · <span className={`event-status ${event.status}`}>{t(statusKeys[event.status])}</span></span>
        <span className={`event-range${!event.mapping?.exactRanges.length ? " is-unknown" : ""}`}>{event.mapping?.exactRanges.length ? rangesLabel(event.mapping.exactRanges) : event.kind === "search" || event.kind === "other" ? t("codeMap.event.excluded") : event.mapping?.nearRanges.length ? t("codeMap.event.noExact") : t("codeMap.event.unknownRange")}{!!event.mapping?.nearRanges.length && <em>{t("codeMap.event.nearRange", { ranges: rangesLabel(event.mapping.nearRanges) })}</em>}</span><small>{dateLabel(event.occurredAt)}</small>
      </button>)}</div>
      {eventLimit < detail.events.length && <button className="button subtle" onClick={() => setEventLimit(value => value + 30)}>{t("codeMap.file.moreActivity")}</button>}
      {active && <EventDetails event={active} sessionTitle={activeSession ? mapSessionTitle(activeSession) : undefined} stale={detail.contentStale || detail.content === null} openCode={openCode} openEvidence={() => setRawOpen(true)} openSession={() => openSession(active)} />}
      {query && <EvidenceDialog repoId={repoId} event={active} query={query} open={rawOpen} onOpenChange={setRawOpen} />}
      <Modal open={codeOpen} onOpenChange={setCodeOpen} title={detail.file.path} description={t("codeMap.code.description", { count: detail.file.lineCount })} wide>
        {detail.contentStale && <Notice>{t("codeMap.code.stale")}</Notice>}
        <div className="code-toolbar"><div className="code-legend"><span><i className="exact-key" />{metric === "edit" ? t("codeMap.metric.editExact") : t("codeMap.metric.read")}</span><label><input type="checkbox" checked={showNear} onChange={event => setShowNear(event.target.checked)} /><i className="near-key" />{t("codeMap.metric.near")}</label></div><form onSubmit={event => { event.preventDefault(); setJumpLine(Number(lineInput)); }}><label>{t("codeMap.code.jumpLine")}<input type="number" min="1" max={Math.max(1, detail.file.lineCount)} value={lineInput} onChange={event => setLineInput(event.target.value)} required /></label><button className="button subtle" type="submit">{t("codeMap.code.go")}</button></form></div>
        {detail.content !== null && <Suspense fallback={<p className="muted" role="status">{t("codeMap.code.loading")}</p>}><CodeViewer path={detail.file.path} content={detail.content} exact={highlights.exact} near={highlights.near} theme={theme} jumpLine={jumpLine} /></Suspense>}
        {!/\.(jsx?|tsx?|mjs|cjs|mts|cts|json[cl]?)$/.test(detail.file.path) && <span className="content-format">{t("codeMap.code.plainText")}</span>}
        <details className="version-note"><summary>{t("codeMap.version.title")}</summary><p>{t("codeMap.version.file", { version: detail.version, hash: detail.file.hash })}{detail.contentHash ? t("codeMap.version.content", { hash: detail.contentHash }) : ""}</p></details>
      </Modal>
    </>}
    </div>
  </aside>;
}

export function useCodeMapPage({ active, theme, onSession }: {
  active: boolean; theme: Theme; onSession: (target: { sessionId: string; messageId?: string }) => void;
}) {
  const { language, refreshIntervals: { map: mapAutoRefreshInterval } } = useI18n();
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia("(max-width: 767px)").matches);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationCollapsed = narrow ? !navigationOpen : sidebarCollapsed;
  useEffect(() => {
    const media = globalThis.matchMedia("(max-width: 767px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [repoId, setRepoId] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState<unknown>(null);
  const [indexMaintenance, setIndexMaintenance] = useState<IndexMaintenanceResult | null>(null);
  const [statusRetry, setStatusRetry] = useState(0);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerPath, setRegisterPath] = useState("");
  const [registerError, setRegisterError] = useState<unknown>(null);
  const [registering, setRegistering] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<unknown>(null);
  const [projectsRetry, setProjectsRetry] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Repository | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const pageEpoch = useRef(0);
  const currentRepoId = useRef(repoId);
  const currentRepositories = useRef(repositories);
  currentRepoId.current = repoId; currentRepositories.current = repositories;
  const renderEpoch = pageEpoch.current;
  const [client, setClient] = useState<Client | "all">("all");
  const [mapSession, setMapSession] = useState<MapSession>();
  const [mapSessionList, setMapSessionList] = useState<MapSessionsResponse>();
  const [mapSessionsLoading, setMapSessionsLoading] = useState(false);
  const [mapSessionsError, setMapSessionsError] = useState<unknown>(null);
  const [mapSessionsRetry, setMapSessionsRetry] = useState(0);
  const [window, setWindow] = useState("all");
  const [timeAnchor, setTimeAnchor] = useState(Date.now);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState<FileCategory | "all">("source");
  const [directory, setDirectory] = useState("");
  const [search, setSearch] = useState("");
  const [metric, setMetric] = useState<Metric>("read");
  const pinnedVersion = useRef<string | undefined>(undefined);
  const [version, setVersion] = useState<string | undefined>();
  const [coverage, setCoverage] = useState<CoverageResult | null>(null);
  const [coverageKey, setCoverageKey] = useState("");
  const loadedCoverage = useRef("");
  const [rootCoverage, setRootCoverage] = useState<CoverageResult | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionPending, setActionPending] = useState(false);
  const recordJob = useCallback((next: Job) => {
    setJobs(current => [...current.filter(item => item.id !== next.id), next]);
    setJob(next);
  }, []);
  const repository = repositories.find(repo => repo.id === repoId);
  const filters = useMemo<Filters>(() => ({ client: client === "all" ? undefined : client,
    sessionClient: mapSession?.client, clientSessionId: mapSession?.clientSessionId,
    ...timeFilters(window, from, to, timeAnchor), categories: category === "all" ? ["source", "config", "docs", "unknown"] : [category], directory: directory || undefined,
  }), [client, mapSession?.client, mapSession?.clientSessionId, window, from, to, timeAnchor, category, directory]);
  const filterKey = queryString(filters);
  const invalidTime = window === "custom" && from && to && from > to;
  const query = coverage ? boundQuery(filters, coverage.version) : undefined;
  const chooseRepo = useCallback((id: string, reset = false) => {
    if (id === currentRepoId.current && !reset) return;
    pageEpoch.current += 1; currentRepoId.current = id;
    pinnedVersion.current = undefined;
    setRepoId(id); setMapSession(undefined); setMapSessionList(undefined); setVersion(undefined); setDirectory(""); setSelected(null); setDetail(null); setCoverage(null); setRootCoverage(null); setActionError(null);
    setJob(null); setCoverageError(null); setDetailError(null); setMapSessionsError(null); setCoverageLoading(false); setDetailLoading(false); setMapSessionsLoading(false);
    loadedCoverage.current = "";
    if (reset) setReload(value => value + 1);
    if (id) localStorage.setItem("agent-manor-repository", id); else localStorage.removeItem("agent-manor-repository");
  }, []);
  const applyStatus = useCallback((result: StatusResponse) => {
    const current = currentRepoId.current;
    const previous = currentRepositories.current.find(repo => repo.id === current);
    const registered = result.repositories.find(repo => repo.id === current);
    currentRepositories.current = result.repositories;
    setRepositories(result.repositories); setJobs(result.jobs);
    const maintenance = result.indexMaintenance;
    setIndexMaintenance(maintenance && (maintenance.status === "failed" || maintenance.reason === "insufficientSpace" || maintenance.reason === "busy") ? maintenance : null);
    const next = result.repositories.some(repo => repo.id === current) ? current
      : (!current ? result.repositories.find(repo => repo.id === localStorage.getItem("agent-manor-repository"))?.id : undefined) ?? result.repositories[0]?.id ?? "";
    if (next !== current) chooseRepo(next);
    else if (previous?.version && registered && !registered.version) chooseRepo(current, true);
  }, [chooseRepo]);
  const recoverMissingRepository = useCallback((failure: unknown) => {
    if (!(failure instanceof ApiError) || !["REPOSITORY_NOT_FOUND", "JOB_NOT_FOUND"].includes(failure.code)) return false;
    setStatusRetry(value => value + 1);
    return true;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = pageEpoch.current;
    setInitialLoading(true); setInitialError(null);
    void request<StatusResponse>("/status?summary=true", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && pageEpoch.current === epoch) applyStatus(result);
    }).catch(failure => { if (!controller.signal.aborted && pageEpoch.current === epoch && !isAborted(failure)) setInitialError(failure); })
      .finally(() => { if (!controller.signal.aborted) setInitialLoading(false); });
    return () => controller.abort();
  }, [statusRetry, applyStatus]);
  useEffect(() => {
    if (!registerOpen) return;
    const controller = new AbortController();
    setProjectsLoading(true); setProjectsError(null); setProjects([]);
    void request<SessionIndexSummary>("/sessions/status?summary=true", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setProjects([...new Set(result.projects.filter(Boolean))]); })
      .catch(failure => { if (!controller.signal.aborted && !isAborted(failure)) setProjectsError(failure); })
      .finally(() => { if (!controller.signal.aborted) setProjectsLoading(false); });
    return () => controller.abort();
  }, [registerOpen, projectsRetry]);
  useVisiblePolling(mapAutoRefreshInterval > 0 && active && !!repoId, mapAutoRefreshInterval, async signal => {
    const epoch = pageEpoch.current;
    try {
      const result = await request<{ job?: Job }>(`${repositoryPath(repoId)}/auto-refresh`, { method: "POST", body: {}, signal });
      if (!signal.aborted && epoch === pageEpoch.current && result.job) recordJob(result.job);
    } catch (failure) { if (!signal.aborted && epoch === pageEpoch.current && !recoverMissingRepository(failure)) setActionError(failure); }
  });
  useVisiblePolling(active && !!repoId, 5000, async signal => {
    const epoch = pageEpoch.current;
    const result = await request<StatusResponse>("/status?summary=true", { signal });
    if (signal.aborted || pageEpoch.current !== epoch) return;
    applyStatus(result);
    const published = result.repositories.find(repo => repo.id === repoId)?.version;
    if (!pinnedVersion.current && published && currentRepoId.current === repoId && coverage?.version !== published) setVersion(published);
  });
  useEffect(() => {
    const latest = [...jobs].reverse().filter(item => item.repositoryId === repoId).sort((a, b) => Number(jobActive(b)) - Number(jobActive(a))
      || (b.finishedAt ?? b.startedAt ?? "").localeCompare(a.finishedAt ?? a.startedAt ?? ""))[0];
    setJob(latest ?? null);
  }, [repoId, jobs]);
  useEffect(() => {
    if (!active || !repoId || invalidTime) return;
    const requestKey = `${repoId}:${filterKey}:${reload}`;
    if (coverage?.version === version && loadedCoverage.current === requestKey) return;
    const controller = new AbortController();
    const epoch = pageEpoch.current;
    setCoverageLoading(true); setCoverageError(null);
    void (async () => {
      const rootQuery = { ...filters, directory: undefined, version, summary: true };
      const root = await request<CoverageResult>(`${repositoryPath(repoId)}/coverage${queryString(rootQuery)}`, { signal: controller.signal });
      if (version && root.version !== version) throw new ApiError("VERSION_MISMATCH", "统计结果版本已变化，请刷新后重试。", { key: "codeMap.error.versionCoverage" });
      const scoped = directory ? await request<CoverageResult>(`${repositoryPath(repoId)}/coverage${queryString(boundQuery(filters, root.version), { summary: "true" })}`, { signal: controller.signal }) : root;
      if (scoped.version !== root.version) throw new ApiError("VERSION_MISMATCH", "目录统计与仓库结果版本不一致，请刷新后重试。", { key: "codeMap.error.versionDirectory" });
      if (controller.signal.aborted || epoch !== pageEpoch.current) return;
      loadedCoverage.current = requestKey;
      setCoverageKey(filterKey); setRootCoverage(root); setCoverage(scoped); setVersion(root.version);
      setSelected(current => scoped.files.some(file => file.path === current) ? current : null);
      setRepositories(current => current.map(repo => repo.id === repoId ? scoped.repository : repo));
    })().catch(failure => { if (!controller.signal.aborted && epoch === pageEpoch.current && !isAborted(failure) && !recoverMissingRepository(failure)) { setCoverageError(failure); setCoverage(current => current?.repository.id === repoId && coverageKey === filterKey ? current : null); } })
      .finally(() => { if (!controller.signal.aborted && epoch === pageEpoch.current) setCoverageLoading(false); });
    return () => controller.abort();
  }, [active, repoId, filterKey, version, reload, invalidTime]);
  useEffect(() => {
    if (!active || !coverage || coverage.repository.id !== repoId) return;
    const controller = new AbortController();
    const epoch = pageEpoch.current;
    setMapSessionsLoading(true); setMapSessionsError(null);
    void request<MapSessionsResponse>(`${repositoryPath(repoId)}/sessions${queryString({ version: coverage.version })}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted || epoch !== pageEpoch.current) return;
        if (result.version !== coverage.version) throw new ApiError("VERSION_MISMATCH", "会话列表与地图结果版本不一致，请刷新后重试。", { key: "codeMap.error.versionSessions" });
        setMapSessionList(result);
      }).catch(failure => { if (!controller.signal.aborted && epoch === pageEpoch.current && !isAborted(failure) && !recoverMissingRepository(failure)) setMapSessionsError(failure); })
      .finally(() => { if (!controller.signal.aborted && epoch === pageEpoch.current) setMapSessionsLoading(false); });
    return () => controller.abort();
  }, [active, repoId, coverage?.version, mapSessionsRetry]);
  useEffect(() => {
    if (active && coverage?.repository.id === repoId && mapSessionList?.version === coverage.version
      && mapSessionList.clients && client !== "all" && !mapSessionList.clients.includes(client)) setClient("all");
  }, [active, repoId, coverage?.version, mapSessionList, client]);
  useEffect(() => {
    if (!active) return;
    if (!repoId || !selected || !coverage || !query || coverageLoading || invalidTime) { setDetail(null); setDetailLoading(false); setDetailError(null); return; }
    const controller = new AbortController();
    const epoch = pageEpoch.current;
    setDetailLoading(true); setDetailError(null); setDetail(null);
    void request<FileDetail>(`${repositoryPath(repoId)}/file${queryString(query, { path: selected })}`, { signal: controller.signal })
      .then(result => { if (controller.signal.aborted || epoch !== pageEpoch.current) return; if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "文件详情与地图结果版本不一致，请刷新后重试。", { key: "codeMap.error.versionFile" }); setDetail(result); })
      .catch(failure => { if (!controller.signal.aborted && epoch === pageEpoch.current && !isAborted(failure) && !recoverMissingRepository(failure)) setDetailError(failure); })
      .finally(() => { if (!controller.signal.aborted && epoch === pageEpoch.current) setDetailLoading(false); });
    return () => controller.abort();
  }, [active, repoId, selected, coverage?.version, filterKey, detailRetry, coverageLoading, invalidTime]);
  useEffect(() => {
    if (!job || !jobActive(job)) return;
    let cancelled = false;
    const controller = new AbortController();
    const epoch = pageEpoch.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request<JobResponse>(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (!cancelled && epoch === pageEpoch.current) { recordJob(response.job); setActionError(null); }
      } catch (failure) {
        if (!cancelled && epoch === pageEpoch.current && !isAborted(failure)) {
          if (recoverMissingRepository(failure)) { setJobs(current => current.filter(item => item.id !== job.id)); setJob(null); return; }
          setActionError(failure);
        }
      }
      if (!cancelled && epoch === pageEpoch.current) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 300);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!pinnedVersion.current && job?.status === "completed" && job.repositoryId === repoId && job.version && job.version !== coverage?.version) { setVersion(job.version); setReload(value => value + 1); }
  }, [job?.id, job?.status, job?.version]);
  const openSession = async (event: HistoryEvent) => {
    try {
      const source = event.sources[0];
      const params = new URLSearchParams({ client: event.client, clientSessionId: event.sessionId });
      if (source?.sourceId) params.set("sourceId", source.sourceId);
      if (source?.callId) params.set("callId", source.callId);
      if (source?.recordLine) params.set("recordLine", String(source.recordLine));
      const result = await request<{ target: { sessionId: string; messageId?: string } | null }>(`/sessions/locate?${params}`);
      if (!result.target) throw new ApiError("SESSION_NOT_INDEXED", "所属会话尚未进入全局索引，请在会话库刷新历史后重试。", { key: "codeMap.error.sessionMissing" });
      onSession(result.target);
    } catch (failure) { setActionError(failure); }
  };
  const openMap = (path?: string, project?: string, session?: SessionSummary, scope?: { repositoryId: string; version?: string; from: string; to: string; clients?: string[] }) => {
    const repo = [...repositories].sort((a, b) => b.path.length - a.path.length).find(candidate =>
      scope?.repositoryId === candidate.id || project === candidate.path || project?.startsWith(`${candidate.path}/`) || path?.startsWith(`${candidate.path}/`));
    if (!repo) { setActionError(new ApiError("REPOSITORY_NOT_REGISTERED", "此会话项目尚未登记代码地图，请先登记本机仓库。", { key: "codeMap.error.repositoryMissing" })); return; }
    if (repo.id !== repoId) chooseRepo(repo.id);
    const local = path?.startsWith(`${repo.path}/`) ? path.slice(repo.path.length + 1) : path?.startsWith("/") ? undefined : path;
    setDirectory(""); setCategory("all"); setClient("all"); setWindow("all"); setSearch("");
    setMapSession(session ? { client: session.client, clientSessionId: session.clientSessionId, title: session.title, eventCount: 0,
      ...(session.titleOrigin === "fallback" ? { titleDescriptor: { key: session.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed", params: { id: session.clientSessionId.slice(-8) } } } : {}),
    } : undefined);
    if (scope) {
      pinnedVersion.current = scope.version; setVersion(scope.version);
      setWindow("custom"); setFrom(scope.from); setTo(scope.to);
      setClient(scope.clients?.length === 1 && CLIENTS.some(item => item.id === scope.clients![0]) ? scope.clients[0] as Client : "all");
    } else pinnedVersion.current = undefined;
    setSelected(local ?? null); setDetailsCollapsed(false);
  };
  const browse = (path: string) => { setDirectory(path); setSelected(null); };
  const selectFile = (path: string) => { setSelected(path); setDetailsCollapsed(false); };
  const clearFilters = () => { setClient("all"); setMapSession(undefined); setWindow("all"); setCategory("source"); setDirectory(""); setSearch(""); setSelected(null); };
  const availableMapSessions = mapSessionList?.version === coverage?.version ? mapSessionList?.sessions ?? [] : [];
  const mapSessionOptions = availableMapSessions.filter(session => client === "all" || session.client === client).map(session => ({
    value: mapSessionKey(session), label: mapSessionTitle(session),
    description: t("codeMap.session.option", { client: clientLabel(session.client), date: dateLabel(session.updatedAt ?? session.startedAt), count: session.eventCount, id: session.clientSessionId }),
  }));
  if (mapSession && !mapSessionOptions.some(option => option.value === mapSessionKey(mapSession))) mapSessionOptions.unshift({
    value: mapSessionKey(mapSession), label: mapSessionTitle(mapSession),
    description: t("codeMap.session.selectedOption", { client: clientLabel(mapSession.client), id: mapSession.clientSessionId }),
  });
  const runRefresh = async () => {
    pinnedVersion.current = undefined;
    if (!repoId) return;
    const epoch = pageEpoch.current;
    setActionPending(true); setActionError(null);
    try { const response = await request<JobResponse>(`${repositoryPath(repoId)}/refresh`, { method: "POST" }); if (epoch === pageEpoch.current) recordJob(response.job); }
    catch (failure) { if (epoch === pageEpoch.current && !recoverMissingRepository(failure)) setActionError(failure); }
    finally { setActionPending(false); }
  };
  const register = async (event: FormEvent) => {
    if (registering) { event.preventDefault(); return; }
    event.preventDefault(); setRegistering(true); setRegisterError(null);
    try {
      const response = await request<RegisterRepositoryResponse>("/repositories", { method: "POST", body: { path: registerPath.trim() } });
      const next = currentRepositories.current.some(repo => repo.id === response.repository.id)
        ? currentRepositories.current.map(repo => repo.id === response.repository.id ? response.repository : repo)
        : [...currentRepositories.current, response.repository];
      currentRepositories.current = next; setRepositories(next);
      chooseRepo(response.repository.id); if (response.job) recordJob(response.job);
      setRegisterOpen(false); setRegisterPath("");
    } catch (failure) { setRegisterError(failure); }
    finally { setRegistering(false); }
  };
  const deleteRepository = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true); setDeleteError(null);
    try {
      await request<DeleteRepositoryResponse>(repositoryPath(target.id), { method: "DELETE" });
      const remaining = currentRepositories.current.filter(repo => repo.id !== target.id);
      currentRepositories.current = remaining; setRepositories(remaining);
      setJobs(current => current.filter(item => item.repositoryId !== target.id));
      if (currentRepoId.current === target.id) chooseRepo(remaining[0]?.id ?? "");
      else { pageEpoch.current += 1; setReload(value => value + 1); }
      setDeleteTarget(null);
    } catch (failure) { setDeleteError(failure); }
    finally { setDeleting(false); }
  };
  const projectOptions = projects.map(path => ({ value: path,
    label: repositories.some(repo => repo.path === path) ? t("codeMap.repository.projectRegistered", { project: filename(path) || path }) : filename(path) || path,
    description: path,
  }));
  const visible = useMemo(() => coverage?.files.filter(file => file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [], [coverage?.files, search]);
  const s = coverage?.summary;
  const retainedCoverageLoading = coverageLoading && coverage?.repository.id === repoId && coverageKey === filterKey;
  const editing = metric === "edit";
  const exact = s ? editing ? s.editExact : s.readExact : null;
  const near = s ? editing ? s.editNear : s.readNear : null;
  const mapHeading = repository ? <div className="map-heading"><div className="breadcrumbs"><button onClick={() => browse("")}><Folder size={16} />{repository.name}</button>{directory.split("/").filter(Boolean).map((part, i, parts) => <span key={i}><CaretRight size={12} /><button onClick={() => browse(parts.slice(0, i + 1).join("/"))}>{part}</button></span>)}<small>{t("codeMap.file.count", { count: visible.length })}</small></div><div className="metric-picker" role="group" aria-label={t("codeMap.colorMetric")}>{(["read", "edit", "activity"] as const).map(value => <button key={value} aria-pressed={metric === value} className={metric === value ? "active" : ""} onClick={() => setMetric(value)}>{metricNames[value]}</button>)}</div></div> : null;
  const mapLegend = <div className="map-legend"><span>{metric === "activity" ? t("codeMap.metric.activity") : t("codeMap.exactCoverage")}</span><span className="legend-scale">{[0, 1, 2, 3, 4].map(tone => <i key={tone} className={`tone-${tone}`} />)}</span><span>{metric === "activity" ? t("codeMap.activity.range", { count: visible.reduce((max, file) => Math.max(max, metricValue(file, metric)), 0) }) : "0 → 100%"}</span><span className="near-key legend-near" /><span>{t("codeMap.near")}</span><small>{t("codeMap.area")}</small></div>;
  return {
    openMap,
    sourceAction: active && repository && <SourcesDialog key={`${repoId}:${renderEpoch}`} repo={repository} query={query} gapCount={coverage?.gapCount ?? coverage?.gaps.length ?? 0} onJob={next => { if (renderEpoch === pageEpoch.current) recordJob(next); }} />,
    refreshAction: <button hidden={!active} className="button primary refresh-button" onClick={() => void runRefresh()} disabled={!repository || actionPending || jobActive(job)} title={coverage ? t("codeMap.analysis.info", { date: dateLabel(coverage.createdAt) }) : undefined} aria-label={jobActive(job) ? t("codeMap.refresh.running") : t("codeMap.refresh.action")}><ArrowClockwise size={16} className={jobActive(job) ? "spinning" : ""} /><span className="refresh-label">{jobActive(job) ? t("codeMap.refresh.running") : t("codeMap.refresh.action")}</span></button>,
    maintenanceNotice: indexMaintenance && <Notice danger={indexMaintenance.status === "failed"} action={<button className="button subtle" onClick={() => setIndexMaintenance(null)}>{t("common.close")}</button>}>
      {messageText(indexMaintenance.messageDescriptor, t("diagnostics.index.maintenance.error"))}
      {indexMaintenance.details && <details><summary>{t("common.originalDetails")}</summary><pre tabIndex={0}>{indexMaintenance.details}</pre></details>}
    </Notice>,
    page: (
    <section className="product-view code-map-page" hidden={!active} aria-label={t("codeMap.view.map")}>
    {!!initialError && <Notice danger action={<button className="button subtle" onClick={() => setStatusRetry(value => value + 1)}>{t("codeMap.refresh.retryConnection")}</button>}><ErrorDetails error={initialError} /></Notice>}
    {!!actionError && <Notice danger action={<button className="button subtle" onClick={() => setActionError(null)}>{t("common.close")}</button>}><ErrorDetails error={actionError} /></Notice>}
    {job && job.status !== "completed" && <div className={`result-status${job.status === "failed" ? " failed" : ""}`} role="status">
      {job.status === "failed" ? <><WarningCircle size={16} /><span>{t("codeMap.refresh.failure", { reason: refreshFailureReason(job), context: t(coverage ? "codeMap.refresh.previous" : "codeMap.refresh.noResults") })}</span><button className="text-button" disabled={actionPending} onClick={() => void runRefresh()}>{t("codeMap.refresh.retry")}</button></>
        : job.status === "cancelled" ? <span>{t("codeMap.refresh.cancelled")}</span>
          : <><ArrowClockwise size={15} className="spinning" /><span>{job.status === "queued" ? t("codeMap.refresh.queued") : isMessageDescriptorKnown(job.phaseDescriptor) ? messageText(job.phaseDescriptor, job.phase) : t("common.originalDetail", { detail: job.phase })}</span><progress max="1" value={Math.max(0, Math.min(1, job.progress))} aria-label={t("codeMap.refresh.progress")} /><small>{new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(job.progress)}{coverage ? t("codeMap.refresh.retained") : ""}</small></>}
    </div>}
    {coverage?.stale && !jobActive(job) && job?.status !== "failed" && <Notice action={<button className="text-button" onClick={() => void runRefresh()}>{t("codeMap.refresh.action")}</button>}>{t("codeMap.refresh.stale", { date: dateLabel(coverage.createdAt) })}</Notice>}
    {initialLoading && !repository ? <Empty title={t("codeMap.empty.connect")}>{t("codeMap.empty.loading")}</Empty> : !repository ? <Empty title={t("codeMap.empty.start")}>{t("codeMap.empty.register")}<br />{t("codeMap.empty.local")}</Empty> : <ResizableWorkspace sidebarCollapsed={navigationCollapsed} detailsCollapsed={detailsCollapsed}>
      <aside className={`sidebar${navigationCollapsed ? " panel-collapsed" : ""}`} aria-label={t("codeMap.repository.navigation")}>
        {narrow ? <button className="repository-navigation-toggle" aria-label={t(navigationCollapsed ? "codeMap.repository.expandScope" : "codeMap.repository.collapseScope", { repository: repository.name, directory: directory || t("codeMap.directory.root") })} aria-expanded={!navigationCollapsed} aria-controls="repository-navigation-content" onClick={() => setNavigationOpen(value => !value)}>
          <Folder size={18} aria-hidden="true" /><span><strong>{repository.name}</strong><small title={directory || repository.path}>{directory || t("codeMap.directory.root")}</small></span>{navigationCollapsed ? <CaretDown size={17} aria-hidden="true" /> : <CaretUp size={17} aria-hidden="true" />}
        </button> : <div className="pane-heading"><span>{t("codeMap.repository.navigation")}</span><Hint label={navigationCollapsed ? t("codeMap.repository.expand") : t("codeMap.repository.collapse")}><button className="icon-button panel-toggle" aria-label={navigationCollapsed ? t("codeMap.repository.expand") : t("codeMap.repository.collapse")} aria-expanded={!navigationCollapsed} aria-controls="repository-navigation-content" onClick={() => setSidebarCollapsed(value => !value)}>{navigationCollapsed ? <CaretRight size={17} /> : <CaretLeft size={17} />}</button></Hint></div>}
        <div id="repository-navigation-content" className="sidebar-content" hidden={navigationCollapsed}><div className="repository-picker"><Dropdown.Root><Dropdown.Trigger ref={repositoryTrigger} className="repository-trigger" aria-label={t("codeMap.repository.choose")}><Folder size={19} weight="duotone" /><strong>{repository.name}</strong><CaretDown size={14} /></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown-content" sideOffset={6}>{repositories.map(repo => <Dropdown.Item key={repo.id} className="dropdown-item" onSelect={() => chooseRepo(repo.id)}>{repo.id === repoId && <Check size={14} />}<span>{repo.name}<small>{repo.path}</small></span></Dropdown.Item>)}<Dropdown.Separator className="dropdown-separator" /><Dropdown.Item className="dropdown-item" onSelect={() => { setRegisterError(null); setRegisterOpen(true); }}><Plus size={15} />{t("codeMap.repository.register")}</Dropdown.Item><Dropdown.Separator className="dropdown-separator" /><Dropdown.Item className="dropdown-item repository-delete-action" onSelect={() => { setDeleteError(null); setDeleteTarget({ ...repository }); }}><Trash size={15} />{t("codeMap.repository.deleteCurrent")}</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root></div>
        <p className="repo-path" title={repository.path}>{repository.path}</p><div className="sidebar-label">{t("codeMap.repository.directories")}</div><DirectoryTree key={repoId} files={rootCoverage?.files ?? []} selected={directory} browse={browse} />
        <div className="sidebar-bottom"><button className="text-button" onClick={() => { setRegisterError(null); setRegisterOpen(true); }}><Plus size={14} />{t("codeMap.repository.other")}</button></div></div>
      </aside>
      <main className="map-main"><div className="page-heading"><h1>{t("codeMap.title")}</h1><div className="map-heading-tools">
        <span className="map-query-progress">{(mapSessionsLoading || retainedCoverageLoading) && <span className="map-query-loading" role="status" aria-label={t(retainedCoverageLoading ? "codeMap.coverage.loading" : "codeMap.session.loading")} title={t(retainedCoverageLoading ? "codeMap.coverage.loading" : "codeMap.session.loading")}><CircleNotch size={17} aria-hidden="true" /></span>}</span>
        <HelpPopover label={t("codeMap.help.title")}><dl>
        <div><dt>{t("codeMap.help.coverageTitle")}</dt><dd>{t("codeMap.help.coverage")}</dd></div>
        <div><dt>{t("codeMap.help.filtersTitle")}</dt><dd>{t("codeMap.help.filters")}</dd></div>
        <div><dt>{t("codeMap.session.helpTitle")}</dt><dd>{t("codeMap.session.help")}</dd></div>
        <div><dt>{t("codeMap.help.baselineTitle")}</dt><dd>{t("codeMap.help.baseline")}</dd></div></dl></HelpPopover></div></div>
        <div className="filters"><div className="select-field"><span>{t("codeMap.filter.client")}</span><FilterSelect label={t("codeMap.filter.clientLabel")} value={client} options={[{ value: "all", label: t("codeMap.filter.allClients") }, ...availableClientOptions(mapSessionList?.clients)]} onChange={value => { setClient(value as Client | "all"); if (value !== "all" && value !== mapSession?.client) setMapSession(undefined); }} /></div>
          <div className="select-field map-session-filter"><span>{t("codeMap.session.label")}</span><ProjectPicker label={t("codeMap.session.filter")} placeholder={t("codeMap.session.search")} value={mapSession ? mapSessionKey(mapSession) : "all"} options={[{ value: "all", label: t("codeMap.session.all") }, ...mapSessionOptions]} onChange={value => setMapSession(value === "all" ? undefined : availableMapSessions.find(session => mapSessionKey(session) === value) ?? mapSession)} />
            {mapSession && <Hint label={t("codeMap.session.clear")}><button className="icon-button" aria-label={t("codeMap.session.clear")} onClick={() => setMapSession(undefined)}><X size={14} /></button></Hint>}
          </div>
          <div className="select-field"><span>{t("codeMap.filter.time")}</span><FilterSelect label={t("codeMap.filter.timeLabel")} value={window} options={[{ value: "all", label: t("codeMap.filter.allHistory") }, { value: "7", label: t("codeMap.filter.week") }, { value: "30", label: t("codeMap.filter.month") }, { value: "custom", label: t("codeMap.filter.custom") }]} onChange={value => { setWindow(value); setTimeAnchor(Date.now()); }} /></div>
          <div className="select-field"><span>{t("codeMap.filter.file")}</span><FilterSelect label={t("codeMap.filter.categoryLabel")} value={category} options={[{ value: "source", label: t("common.category.source") }, { value: "config", label: t("common.category.config") }, { value: "docs", label: t("common.category.docs") }, { value: "unknown", label: t("common.category.unknown") }, { value: "all", label: t("codeMap.filter.allText") }]} onChange={value => { setCategory(value as FileCategory | "all"); setSelected(null); }} /></div>
          <label className="search-box"><MagnifyingGlass size={17} /><input aria-label={t("codeMap.filter.search")} placeholder={t("codeMap.filter.search")} value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label={t("codeMap.filter.clearSearch")} onClick={() => setSearch("")}><X size={14} /></button>}</label>
        </div>
        {!!mapSessionsError && <Notice danger action={<button className="text-button" onClick={() => setMapSessionsRetry(value => value + 1)}>{t("common.retry")}</button>}><ErrorDetails error={mapSessionsError} /></Notice>}
        {window === "custom" && <div className="date-range"><span>{t("codeMap.filter.startDate")}</span><DatePicker label={t("codeMap.filter.startDateLabel")} value={from} onChange={setFrom} /><span>{t("codeMap.filter.to")}</span><DatePicker label={t("codeMap.filter.endDateLabel")} value={to} onChange={setTo} /></div>}
        {invalidTime && <Notice danger>{t("codeMap.filter.invalidTime")}</Notice>}
        {!!coverageError && coverage?.repository.id === repoId && coverageKey === filterKey && <Notice danger action={<button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button>}><ErrorDetails error={coverageError} /></Notice>}
        {coverageLoading && !(coverage?.repository.id === repoId && coverageKey === filterKey) ? <div className="query-loading" role="status">{t("codeMap.coverage.loading")}</div> : coverageError && !(coverage?.repository.id === repoId && coverageKey === filterKey) ? <Empty title={t("codeMap.coverage.unavailable")} action={<div className="empty-actions"><button className="button" onClick={() => { setVersion(undefined); setReload(value => value + 1); }}>{t("codeMap.coverage.latest")}</button><button className="button subtle" onClick={() => void runRefresh()} disabled={jobActive(job)}>{t("codeMap.refresh.action")}</button></div>}><ErrorDetails error={coverageError} /></Empty> : s && exact && near && !invalidTime && <>
          {mapSession && !coverage!.files.some(file => file.activityCount > 0) && <Notice>{t("codeMap.session.noActivity")}</Notice>}
          <div className="metrics"><div className="metric-primary"><span>{editing ? t("codeMap.coverage.editLines") : t("codeMap.coverage.readLines")}</span><strong>{percent(exact.lines, s.lineCount)}</strong><small>{t("codeMap.coverage.lineFraction", { covered: fmt(exact.lines), count: s.lineCount })}</small></div><div><span>{editing ? t("codeMap.coverage.editFiles") : t("codeMap.coverage.readFiles")}</span><strong>{percent(exact.files, s.fileCount)}</strong><small>{t("codeMap.coverage.fileFraction", { covered: fmt(exact.files), count: s.fileCount })}</small></div><div className="metric-context"><span>{t("codeMap.coverage.moreNear")}</span><strong>{t("codeMap.line.count", { count: near.lines })}</strong><small>{t("codeMap.coverage.nearFiles", { count: near.files })}</small></div></div>
          {visible.some(file => file.lineCount > 0) ? <CodeMap files={visible} directory={directory} metric={metric} selected={selected} browse={browse} select={selectFile} heading={mapHeading} legend={mapLegend} scopeKey={`${repoId}:${filterKey}:${search}`} /> : <>{mapHeading}<Empty title={visible.length ? t("codeMap.empty.emptyFiles") : t("codeMap.empty.noFiles")} action={<button className="button subtle" onClick={clearFilters}>{t("codeMap.filter.reset")}</button>}>{visible.length ? t("codeMap.empty.emptyFilesDescription") : t("codeMap.empty.noFilesDescription")}</Empty>{mapLegend}</>}
          {search && <p className="muted small">{t("codeMap.filter.searchScope")}</p>}
          <details className="file-table" open={!!search || visible.some(file => !file.lineCount)}><summary>{t("codeMap.table.title", { count: visible.length })}</summary><div className="file-table-scroll"><table><thead><tr><th>{t("codeMap.filter.file")}</th><th>{t("codeMap.table.lines")}</th><th>{t("codeMap.table.exact")}</th><th>{t("codeMap.table.nearLines")}</th><th>{t("codeMap.table.count")}</th></tr></thead><tbody>{visible.map(file => <tr key={file.path} className={selected === file.path ? "selected" : ""}><td><button onClick={() => selectFile(file.path)}>{file.path}</button></td><td>{fmt(file.lineCount)}</td><td>{percent(metric === "edit" ? file.editExactLines : file.readExactLines, file.lineCount)}</td><td>{fmt(metric === "edit" ? file.editNearLines : file.readNearLines)}</td><td>{fmt(metricValue(file, "activity"))}</td></tr>)}</tbody></table></div></details>
          {(coverage!.gapCount ?? coverage!.gaps.length) > 0 && query && <CoverageGaps repoId={repoId} query={query} count={coverage!.gapCount ?? coverage!.gaps.length} />}
          <details className="baseline-note"><summary>{t("codeMap.analysis.info", { date: dateLabel(coverage!.createdAt) })}</summary><p>{t("codeMap.analysis.version", { version: coverage!.version })}<br />{t("codeMap.analysis.baseline", { hash: coverage!.baselineHash })}{coverage!.previousVersion && <>{t("codeMap.analysis.previous", { version: coverage!.previousVersion })}</>}</p></details>
        </>}
      </main>
      <FilePane repoId={repoId} detail={detail} loading={detailLoading} error={detailError} retry={() => setDetailRetry(value => value + 1)} collapsed={detailsCollapsed} toggle={() => setDetailsCollapsed(value => !value)} metric={metric} theme={theme} query={query} sessions={availableMapSessions} openSession={event => void openSession(event)} />
    </ResizableWorkspace>}
    {!repository && !initialLoading && <div className="first-register"><button ref={repositoryTrigger} className="button primary" onClick={() => { setRegisterError(null); setRegisterOpen(true); }}><Plus size={17} />{t("codeMap.repository.registerLocal")}</button></div>}
    <Modal open={registerOpen} onOpenChange={setRegisterOpen} fallbackFocus={repositoryTrigger} busy={registering} title={t("codeMap.repository.registerTitle")} description={t("codeMap.repository.registerDescription")}>
      <form className="register-form" onSubmit={event => void register(event)}>
        <fieldset className="repository-project-field" disabled={registering}>
          {projectsLoading ? <p className="muted" role="status">{t("codeMap.repository.projectsLoading")}</p>
            : projectsError ? <Notice danger action={<button type="button" className="button subtle" onClick={() => setProjectsRetry(value => value + 1)}>{t("common.retry")}</button>}><strong>{t("codeMap.repository.projectsError")}</strong><br /><ErrorDetails error={projectsError} /></Notice>
              : projects.length ? <ProjectPicker modal label={t("codeMap.repository.project")} placeholder={t("codeMap.repository.projectSearch")} value={registerPath} options={projectOptions} onChange={path => { setRegisterPath(path); setRegisterError(null); }} />
                : <p className="muted" role="status">{t("codeMap.repository.projectsEmpty")}</p>}
        </fieldset>
        <label>{t("codeMap.repository.path")}<input value={registerPath} disabled={registering} onChange={event => { setRegisterPath(event.target.value); setRegisterError(null); }} placeholder="/absolute/path/to/repository" autoComplete="off" required /></label>
        {!!registerError && <Notice danger><ErrorDetails error={registerError} /></Notice>}
        <div className="dialog-end"><button type="button" className="button subtle" disabled={registering} onClick={() => setRegisterOpen(false)}>{t("common.cancel")}</button><button type="submit" className="button primary" disabled={registering || !registerPath.trim()}>{registering ? t("codeMap.repository.registering") : t("codeMap.repository.registerAnalyze")}</button></div>
      </form>
    </Modal>
    <Modal open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }} fallbackFocus={repositoryTrigger} busy={deleting} title={t("codeMap.repository.deleteTitle")} description={t("codeMap.repository.deleteDescription")}>
      {deleteTarget && <>
        <dl className="repository-delete-target"><dt>{t("codeMap.repository.deleteName")}</dt><dd>{deleteTarget.name}</dd><dt>{t("codeMap.repository.path")}</dt><dd><code>{deleteTarget.path}</code></dd></dl>
        <div className="repository-delete-scope"><h3>{t("codeMap.repository.deleteClearsTitle")}</h3><p>{t("codeMap.repository.deleteClears")}</p><h3>{t("codeMap.repository.deleteKeepsTitle")}</h3><p>{t("codeMap.repository.deleteKeeps")}</p></div>
        {!!deleteError && <Notice danger><ErrorDetails error={deleteError} /></Notice>}
        <div className="dialog-end"><button type="button" className="button subtle" disabled={deleting} onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</button><button type="button" className="button repository-delete-button" disabled={deleting} onClick={() => void deleteRepository()}>{deleting ? t("codeMap.repository.deleting") : t("codeMap.repository.deleteConfirm")}</button></div>
      </>}
    </Modal>
    </section>
    ),
  };
}
