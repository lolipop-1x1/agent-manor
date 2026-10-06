import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowClockwise, ArrowSquareOut, CaretDown, CaretLeft, CaretRight, Check, Code, FileCode, Folder, MagnifyingGlass, MapTrifold, Moon, Plus, Stack, Sun, WarningCircle, X } from "@phosphor-icons/react";
import type { Client, CoverageQuery, CoverageResult, EvidenceResponse, FileCategory, FileDetail, FileEvent, Filters, Gap, HistoryEvent, Job, JobResponse, RegisterRepositoryResponse, Repository, SourcesResponse, StatusResponse } from "../src/contracts";
import { CLIENTS, clientName } from "../src/clients";
import { ApiError, errorMessage, isAborted, queryString, repositoryPath, request } from "./api";
import { CodeMap, Hint } from "./CodeMap";
import { DirectoryTree } from "./DirectoryTree";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { FilterSelect } from "./FilterSelect";
import { DatePicker } from "./DatePicker";
import { HelpPopover } from "./HelpPopover";
import Sessions from "./Sessions";
import "./session-navigation.css";
import { boundQuery, categoryNames, dateLabel, fileHighlights, filename, fmt, gapNames, metricNames, metricValue, percent, rangesLabel, timeFilters, type Metric, type Theme } from "./model";

const kindNames = { read: "读取", edit: "修改", search: "搜索", other: "其他" };
const statusNames = { success: "成功", failure: "失败", unknown: "结果未知" };
const jobActive = (job: Job | null) => job?.status === "queued" || job?.status === "running";
const CodeViewer = lazy(() => import("./CodeViewer").then(module => ({ default: module.CodeViewer })));

function Notice({ children, action, danger = false }: { children: ReactNode; action?: ReactNode; danger?: boolean }) {
  return <div className={`notice${danger ? " danger" : ""}`} role={danger ? "alert" : "status"}><WarningCircle size={17} /><div>{children}</div>{action}</div>;
}

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><MapTrifold size={32} /><h2>{title}</h2><p>{children}</p>{action}</div>;
}

function Modal({ open, onOpenChange, title, description, children, wide = false, fallbackFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; wide?: boolean; fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`dialog-content${wide ? " wide" : ""}`}
    onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => {
      const target = returnFocus.current?.isConnected && returnFocus.current !== document.body ? returnFocus.current : fallbackFocus?.current;
      if (target?.isConnected) { event.preventDefault(); target.focus(); }
    }}>
    <Dialog.Title>{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description>
    <Dialog.Close asChild><button className="icon-button dialog-close" aria-label="关闭对话框"><X size={18} /></button></Dialog.Close>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function Gaps({ gaps }: { gaps: Gap[] }) {
  if (!gaps.length) return <p className="muted">未记录采集缺口。</p>;
  return <div className="gap-list">{gaps.map((gap, i) => <div key={`${gap.kind}-${gap.sourceId ?? i}`}><strong>{gapNames[gap.kind]}{gap.count !== undefined ? ` · ${fmt(gap.count)}` : ""}</strong><p>{gap.message}</p>{gap.sourceId && <small>来源 {gap.sourceId}</small>}</div>)}</div>;
}

function SourcesDialog({ repo, query, gaps, onJob }: { repo: Repository; query?: CoverageQuery; gaps: Gap[]; onJob: (job: Job) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [associating, setAssociating] = useState<string | null>(null);
  const key = queryString(query ?? {});
  useEffect(() => {
    if (!open || !query?.version) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    void request<SourcesResponse>(`${repositoryPath(repo.id)}/sources${key}`, { signal: controller.signal })
      .then(result => { if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "来源返回的结果版本发生变化，请刷新后重试。"); setData(result); })
      .catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, repo.id, key, retry, query?.version]);
  const associate = async (sourceId: string) => {
    setAssociating(sourceId); setError(null);
    try {
      const response = await request<JobResponse>(`${repositoryPath(repo.id)}/associations`, { method: "POST", body: { sourceId } });
      onJob(response.job); setOpen(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setAssociating(null); }
  };
  return <>
    <button className="button subtle" aria-label="来源与缺口" onClick={() => setOpen(true)}><Stack size={17} /><span className="desktop-text">来源与缺口</span>{gaps.length > 0 && <span className="count-badge">{gaps.length}</span>}</button>
    <Modal open={open} onOpenChange={setOpen} title="采集来源与缺口" description="本版本的来源、待关联会话与采集缺口。">
      {!query?.version && <p className="muted">分析结果尚未就绪。完成刷新后可查看来源与手动关联。</p>}
      {loading && <p className="muted" role="status">正在读取来源…</p>}
      {error && <Notice danger action={<button className="button subtle" onClick={() => setRetry(value => value + 1)}>重试</button>}>{error}</Notice>}
      {data && <>
        <div className="source-summary">{CLIENTS.map(client => <div key={client.id}><strong>{data.sources.filter(source => source.client === client.id).length}</strong><span>{client.name} 来源</span></div>)}<div><strong>{data.unassociated.length}</strong><span>待关联</span></div></div>
        <h3>已关联来源</h3><div className="source-list">{data.sources.map(source => <div className="source-row" key={source.sourceId}><strong>{clientName(source.client)}<small>{source.association === "manual" ? "手动关联" : "自动关联"} · {fmt(source.eventCount)} 个事件</small></strong><code>{source.path}</code><small>会话 {source.sessionId}</small></div>)}{!data.sources.length && <p className="muted">没有已关联来源。</p>}</div>
        <h3>无法自动归属的会话</h3>{data.unassociated.length > 0 && <p className="muted small">确认会话属于 {repo.name} 后再关联；关联后重新分析。</p>}
        <div className="source-list">{data.unassociated.map(source => <div className="source-row" key={source.sourceId}><strong>{clientName(source.client)} · {source.sessionId}</strong><code>{source.path}</code><small>工作目录：{source.cwd ?? "未知"}</small><button className="button" disabled={associating !== null} onClick={() => void associate(source.sourceId)}>{associating === source.sourceId ? "正在关联…" : "关联并重新分析"}</button></div>)}{!data.unassociated.length && <p className="muted">没有待关联的会话。</p>}</div>
        <h3>采集缺口</h3><Gaps gaps={data.gaps} /><p className="version-note">分析结果版本 {data.version}</p>
      </>}
    </Modal>
  </>;
}

function EvidenceDialog({ repoId, event, query, open, onOpenChange }: { repoId: string; event: HistoryEvent | null; query: CoverageQuery; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = queryString(query);
  useEffect(() => {
    if (!open || !event) return;
    const controller = new AbortController();
    setData(null); setError(null); setLoading(true);
    void request<EvidenceResponse>(`${repositoryPath(repoId)}/evidence/${encodeURIComponent(event.id)}${key}`, { signal: controller.signal })
      .then(result => { if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "原始证据与当前结果版本不一致，请刷新后重试。"); setData(result); })
      .catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, event?.id, repoId, key, query.version, retry]);
  return <Modal open={open} onOpenChange={onOpenChange} title="原始证据回查" description="只读原始记录" wide>
    {loading && <p role="status" className="muted">正在核对原始记录…</p>}
    {error && <Notice danger action={<button className="button subtle" onClick={() => setRetry(value => value + 1)}>重试</button>}>{error}</Notice>}
    {data && <>
      <div className="evidence-meta"><strong>{data.event.tool} · {statusNames[data.event.status]}</strong><span>{dateLabel(data.event.occurredAt)}</span><code>事件 {data.event.id}</code><code>会话 {data.event.sessionId}</code>{data.event.parentSessionId && <code>父会话 {data.event.parentSessionId}</code>}</div>
      {data.unavailable.length > 0 && <Notice>{data.unavailable.length} 条原始记录无法回查：来源缺失或已变化，当前显示历史索引。</Notice>}
      {data.records.map((record, i) => <section className="raw-record" key={`${record.source.sourceId}-${record.source.recordLine}-${i}`}><h3>记录 {i + 1} · L{record.source.recordLine}</h3><code className="record-path">{record.source.path}</code><small>来源 {record.source.sourceId} · 哈希 {record.source.hash}{record.source.callId ? ` · 调用 ${record.source.callId}` : ""}</small><pre tabIndex={0}>{record.raw}</pre></section>)}
      {!data.records.length && !data.unavailable.length && <p className="muted">该事件没有可回查的原始记录。</p>}
      {data.unavailable.map((source, i) => <p className="muted record-path" key={i}>{source.path} · L{source.recordLine} · {source.hash}</p>)}
      <p className="version-note">分析结果版本 {data.version}</p>
    </>}
  </Modal>;
}

function EventDetails({ event, openEvidence, openCode, openSession, stale }: { event: FileEvent; openEvidence: () => void; openCode: (line?: number) => void; openSession: () => void; stale: boolean }) {
  return <div className="event-detail"><h3>{event.tool}</h3><dl><dt>结果</dt><dd>{statusNames[event.status]}</dd><dt>会话</dt><dd>{event.sessionId}</dd><dt>发生时间</dt><dd>{dateLabel(event.occurredAt)}</dd></dl>
    {event.mapping?.unknownReason && <p className="muted small">范围未知：{event.mapping.unknownReason}</p>}
    {event.reason && <p className="muted small">{event.reason}</p>}
    {!!event.mapping?.exactRanges.length && <button className="range-link" disabled={stale} onClick={() => openCode(event.mapping!.exactRanges[0]!.start)}>精确 {rangesLabel(event.mapping.exactRanges)}</button>}
    {!!event.mapping?.nearRanges.length && <button className="range-link near-label" disabled={stale} onClick={() => openCode(event.mapping!.nearRanges[0]!.start)}>近似 {rangesLabel(event.mapping.nearRanges)}</button>}
    <button className="button subtle" onClick={openSession}><ArrowSquareOut size={15} />查看所属会话</button>
    <button className="button evidence-button" onClick={openEvidence}><ArrowSquareOut size={15} />回查原始记录 · {event.sources.length}</button>
    <details className="event-payload"><summary>工具参数与结果</summary><h4>请求</h4><pre tabIndex={0}>{JSON.stringify(event.input ?? null, null, 2)}</pre><h4>结果</h4><pre tabIndex={0}>{JSON.stringify(event.output ?? null, null, 2)}</pre></details>
  </div>;
}

function FilePane({ repoId, detail, loading, error, retry, collapsed, toggle, metric, theme, query, openSession }: {
  repoId: string; detail: FileDetail | null; loading: boolean; error: string | null; retry: () => void; collapsed: boolean; toggle: () => void;
  metric: Metric; theme: Theme; query?: CoverageQuery; openSession: (event: HistoryEvent) => void;
}) {
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
  const openCode = (line?: number) => { setJumpLine(line); if (line) setLineInput(String(line)); setCodeOpen(true); };
  return <aside className={`evidence-pane${collapsed ? " panel-collapsed" : ""}`} aria-label="文件详情">
    <div className="pane-heading"><span>文件详情</span><Hint label={collapsed ? "展开文件详情" : "收起文件详情"}><button className="icon-button panel-toggle" aria-label={collapsed ? "展开文件详情" : "收起文件详情"} aria-expanded={!collapsed} aria-controls="file-details-content" onClick={toggle}>{collapsed ? <CaretLeft size={17} /> : <CaretRight size={17} />}</button></Hint></div>
    <div id="file-details-content" hidden={collapsed}>
    {loading ? <p className="muted" role="status">正在查询文件与活动…</p> : error ? <Notice danger action={<button className="button subtle" onClick={retry}>重试</button>}>{error}</Notice> : !detail ? <div className="no-selection"><FileCode size={30} /><h2>选择一个文件</h2></div> : <>
      <h2>{filename(detail.file.path)}</h2><p className="file-path">{detail.file.path}</p>
      <div className="file-stats"><div><strong>{percent(detail.file.readExactLines, detail.file.lineCount)}</strong><span>精确读取</span></div><div><strong>{fmt(detail.file.readNearLines)}</strong><span>近似读取行</span></div><div><strong>{fmt(detail.file.editExactLines)}</strong><span>精确修改行</span></div></div>
      <p className="muted small">修改近似 {fmt(detail.file.editNearLines)} 行 · {fmt(detail.file.lineCount)} 行 · {categoryNames[detail.file.category]}</p>
      <div className="file-counts"><span>读取 {fmt(detail.file.readCount)}</span><span>修改 {fmt(detail.file.editCount)}</span><span>搜索 {fmt(detail.file.searchCount)}</span><span>失败 {fmt(detail.file.failedCount)}</span><span>未知 {fmt(detail.file.unknownCount)}</span></div>
      {detail.contentStale && <Notice>当前文件已变化。旧版范围不会在新内容上高亮，请刷新分析。</Notice>}
      {detail.content === null ? <p className="muted">当前文件内容不可读取。历史活动与证据仍可回查。</p> : <button className="button view-code-button" onClick={() => openCode()}><Code size={16} />查看当前代码与范围</button>}
      <div className="section-heading"><h3>历史活动</h3><span>{fmt(detail.events.length)} 条</span></div>
      {!detail.events.length && <p className="muted small">没有已记录活动。</p>}
      <div className="event-list">{detail.events.slice(0, eventLimit).map(event => <button className={`event${active?.id === event.id ? " active" : ""}`} key={event.id} onClick={() => setSelectedEvent(event.id)}>
        <div className="event-head"><span className="client-mark">{CLIENTS.find(client => client.id === event.client)!.abbreviation}</span><strong>{clientName(event.client)}</strong><span>{kindNames[event.kind]}</span></div><span className="event-session">{event.tool} · {statusNames[event.status]}</span>
        <span className="event-range">{event.mapping?.exactRanges.length ? rangesLabel(event.mapping.exactRanges) : event.kind === "search" || event.kind === "other" ? "不计入行覆盖" : event.mapping?.nearRanges.length ? "无精确对应" : "当前范围未知"}{!!event.mapping?.nearRanges.length && <em>近似 {rangesLabel(event.mapping.nearRanges)}</em>}</span><small>{dateLabel(event.occurredAt)}</small>
      </button>)}</div>
      {eventLimit < detail.events.length && <button className="button subtle" onClick={() => setEventLimit(value => value + 30)}>显示更多活动</button>}
      {active && <EventDetails event={active} stale={detail.contentStale || detail.content === null} openCode={openCode} openEvidence={() => setRawOpen(true)} openSession={() => openSession(active)} />}
      {query && <EvidenceDialog repoId={repoId} event={active} query={query} open={rawOpen} onOpenChange={setRawOpen} />}
      <Modal open={codeOpen} onOpenChange={setCodeOpen} title={detail.file.path} description={`当前工作区代码 · ${fmt(detail.file.lineCount)} 行`} wide>
        {detail.contentStale && <Notice>文件内容已过期，已禁用旧版范围高亮和事件范围跳转。</Notice>}
        <div className="code-toolbar"><div className="code-legend"><span><i className="exact-key" />{metric === "edit" ? "精确修改" : "精确读取"}</span><label><input type="checkbox" checked={showNear} onChange={event => setShowNear(event.target.checked)} /><i className="near-key" />近似对应</label></div><form onSubmit={event => { event.preventDefault(); setJumpLine(Number(lineInput)); }}><label>跳转行<input type="number" min="1" max={Math.max(1, detail.file.lineCount)} value={lineInput} onChange={event => setLineInput(event.target.value)} required /></label><button className="button subtle" type="submit">前往</button></form></div>
        {detail.content !== null && <Suspense fallback={<p className="muted" role="status">正在加载代码查看器…</p>}><CodeViewer path={detail.file.path} content={detail.content} exact={highlights.exact} near={highlights.near} theme={theme} jumpLine={jumpLine} /></Suspense>}
        {!/\.(jsx?|tsx?|mjs|cjs|mts|cts|json[cl]?)$/.test(detail.file.path) && <span className="content-format">纯文本</span>}
        <details className="version-note"><summary>版本信息</summary><p>分析结果版本 {detail.version} · 基线 {detail.file.hash}{detail.contentHash ? ` · 当前内容 ${detail.contentHash}` : ""}</p></details>
      </Modal>
    </>}
    </div>
  </aside>;
}

export function App() {
  const [view, setView] = useState<"map" | "sessions">(() => location.hash.startsWith("#sessions") ? "sessions" : "map");
  const viewScroll = useRef({ map: 0, sessions: 0 });
  const activeView = useRef(view);
  const activateView = useCallback((next: "map" | "sessions") => {
    if (activeView.current !== next) viewScroll.current[activeView.current] = globalThis.scrollY;
    activeView.current = next;
    setView(next);
  }, []);
  useLayoutEffect(() => { globalThis.scrollTo(0, viewScroll.current[view]); }, [view]);
  useEffect(() => { document.title = `AgentManor · ${view === "sessions" ? "会话库" : "代码活动地图"}`; }, [view]);
  const [sessionTarget, setSessionTarget] = useState<{ sessionId: string; messageId?: string; mode?: "brief" | "full" | "trace"; page?: number; turnPosition?: number; branch?: string }>();
  useEffect(() => {
    const navigate = () => {
      activateView(location.hash.startsWith("#sessions") ? "sessions" : "map");
      const params = new URLSearchParams(location.hash.split("?")[1]);
      const sessionId = params.get("id");
      const mode = params.get("mode");
      const positive = (name: string) => { const value = Number(params.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
      if (sessionId) setSessionTarget({ sessionId, messageId: params.get("message") ?? undefined,
        mode: mode === "brief" || mode === "full" || mode === "trace" ? mode : undefined, page: positive("page"), turnPosition: positive("turn"), branch: params.get("branch") ?? undefined });
    };
    navigate();
    globalThis.addEventListener("hashchange", navigate);
    return () => globalThis.removeEventListener("hashchange", navigate);
  }, [activateView]);
  const switchView = (next: "map" | "sessions") => { activateView(next); location.hash = next; };
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("agent-manor-theme");
    return stored === "light" || stored === "dark" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [repoId, setRepoId] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [statusRetry, setStatusRetry] = useState(0);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerPath, setRegisterPath] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [client, setClient] = useState<Client | "all">("all");
  const [window, setWindow] = useState("all");
  const [timeAnchor, setTimeAnchor] = useState(Date.now);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState<FileCategory | "all">("source");
  const [directory, setDirectory] = useState("");
  const [search, setSearch] = useState("");
  const [metric, setMetric] = useState<Metric>("read");
  const [version, setVersion] = useState<string | undefined>();
  const [coverage, setCoverage] = useState<CoverageResult | null>(null);
  const [rootCoverage, setRootCoverage] = useState<CoverageResult | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const recordJob = useCallback((next: Job) => {
    setJobs(current => [...current.filter(item => item.id !== next.id), next]);
    setJob(next);
  }, []);
  const repository = repositories.find(repo => repo.id === repoId);
  const filters = useMemo<Filters>(() => ({ client: client === "all" ? undefined : client,
    ...timeFilters(window, from, to, timeAnchor), categories: category === "all" ? ["source", "config", "docs", "unknown"] : [category], directory: directory || undefined,
  }), [client, window, from, to, timeAnchor, category, directory]);
  const filterKey = queryString(filters);
  const invalidTime = window === "custom" && from && to && from > to;
  const query = coverage ? boundQuery(filters, coverage.version) : undefined;
  const chooseRepo = useCallback((id: string) => {
    setRepoId(id); setVersion(undefined); setDirectory(""); setSelected(null); setDetail(null); setCoverage(null); setRootCoverage(null); setActionError(null);
    localStorage.setItem("agent-manor-repository", id);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("agent-manor-theme", theme); }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    setInitialLoading(true); setInitialError(null);
    void request<StatusResponse>("/status", { signal: controller.signal }).then(result => {
      setRepositories(result.repositories); setJobs(result.jobs);
      setRepoId(current => result.repositories.some(repo => repo.id === current) ? current
        : result.repositories.find(repo => repo.id === localStorage.getItem("agent-manor-repository"))?.id ?? result.repositories[0]?.id ?? "");
    }).catch(failure => { if (!isAborted(failure)) setInitialError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setInitialLoading(false); });
    return () => controller.abort();
  }, [statusRetry]);
  useEffect(() => {
    const latest = [...jobs].reverse().filter(item => item.repositoryId === repoId).sort((a, b) => Number(jobActive(b)) - Number(jobActive(a))
      || (b.finishedAt ?? b.startedAt ?? "").localeCompare(a.finishedAt ?? a.startedAt ?? ""))[0];
    setJob(latest ?? null);
  }, [repoId, jobs]);
  useEffect(() => {
    if (!repoId || invalidTime) return;
    const controller = new AbortController();
    setCoverageLoading(true); setCoverageError(null);
    void (async () => {
      const rootQuery = { ...filters, directory: undefined, version };
      const root = await request<CoverageResult>(`${repositoryPath(repoId)}/coverage${queryString(rootQuery)}`, { signal: controller.signal });
      if (version && root.version !== version) throw new ApiError("VERSION_MISMATCH", "统计结果版本已变化，请刷新后重试。");
      const scoped = directory ? await request<CoverageResult>(`${repositoryPath(repoId)}/coverage${queryString(boundQuery(filters, root.version))}`, { signal: controller.signal }) : root;
      if (scoped.version !== root.version) throw new ApiError("VERSION_MISMATCH", "目录统计与仓库结果版本不一致，请刷新后重试。");
      setRootCoverage(root); setCoverage(scoped); setVersion(root.version);
      setSelected(current => scoped.files.some(file => file.path === current) ? current : null);
      setRepositories(current => current.map(repo => repo.id === repoId ? scoped.repository : repo));
    })().catch(failure => { if (!isAborted(failure)) { setCoverageError(errorMessage(failure)); setCoverage(null); } })
      .finally(() => { if (!controller.signal.aborted) setCoverageLoading(false); });
    return () => controller.abort();
  }, [repoId, filterKey, version, reload, invalidTime]);
  useEffect(() => {
    if (!repoId || !selected || !coverage || !query || coverageLoading || invalidTime) { setDetail(null); setDetailLoading(false); setDetailError(null); return; }
    const controller = new AbortController();
    setDetailLoading(true); setDetailError(null); setDetail(null);
    void request<FileDetail>(`${repositoryPath(repoId)}/file${queryString(query, { path: selected })}`, { signal: controller.signal })
      .then(result => { if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "文件详情与地图结果版本不一致，请刷新后重试。"); setDetail(result); })
      .catch(failure => { if (!isAborted(failure)) setDetailError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [repoId, selected, coverage?.version, filterKey, detailRetry, coverageLoading, invalidTime]);
  useEffect(() => {
    if (!job || !jobActive(job)) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request<JobResponse>(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (!cancelled) { recordJob(response.job); setActionError(null); }
      } catch (failure) { if (!cancelled && !isAborted(failure)) setActionError(errorMessage(failure)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 300);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (job?.status === "completed") { setVersion(job.version); setReload(value => value + 1); }
  }, [job?.id, job?.status, job?.version]);
  const openSession = async (event: HistoryEvent) => {
    try {
      const source = event.sources[0];
      const params = new URLSearchParams({ client: event.client, clientSessionId: event.sessionId });
      if (source?.sourceId) params.set("sourceId", source.sourceId);
      if (source?.callId) params.set("callId", source.callId);
      if (source?.recordLine) params.set("recordLine", String(source.recordLine));
      const result = await request<{ target: { sessionId: string; messageId?: string } | null }>(`/sessions/locate?${params}`);
      if (!result.target) throw new Error("所属会话尚未进入全局索引，请在会话库刷新历史后重试。");
      setSessionTarget(result.target); activateView("sessions");
      const destination = new URLSearchParams({ id: result.target.sessionId });
      if (result.target.messageId) destination.set("message", result.target.messageId);
      location.hash = `sessions?${destination}`;
    } catch (failure) { setActionError(errorMessage(failure)); }
  };
  const openMap = (path?: string, project?: string) => {
    const repo = [...repositories].sort((a, b) => b.path.length - a.path.length).find(candidate =>
      project === candidate.path || project?.startsWith(`${candidate.path}/`) || path?.startsWith(`${candidate.path}/`));
    if (!repo) { setActionError("此会话项目尚未登记代码地图，请先登记本机仓库。"); activateView("map"); location.hash = "map"; return; }
    if (repo.id !== repoId) chooseRepo(repo.id);
    const local = path?.startsWith(`${repo.path}/`) ? path.slice(repo.path.length + 1) : path?.startsWith("/") ? undefined : path;
    setDirectory(""); setCategory("all"); setClient("all"); setWindow("all"); setSearch("");
    setSelected(local ?? null); setDetailsCollapsed(false); activateView("map"); location.hash = "map";
  };
  const browse = (path: string) => { setDirectory(path); setSelected(null); };
  const selectFile = (path: string) => { setSelected(path); setDetailsCollapsed(false); };
  const clearFilters = () => { setClient("all"); setWindow("all"); setCategory("source"); setDirectory(""); setSearch(""); setSelected(null); };
  const runRefresh = async () => {
    if (!repoId) return;
    setActionPending(true); setActionError(null);
    try { const response = await request<JobResponse>(`${repositoryPath(repoId)}/refresh`, { method: "POST" }); recordJob(response.job); }
    catch (failure) { setActionError(errorMessage(failure)); }
    finally { setActionPending(false); }
  };
  const register = async (event: FormEvent) => {
    event.preventDefault(); setRegistering(true); setRegisterError(null);
    try {
      const response = await request<RegisterRepositoryResponse>("/repositories", { method: "POST", body: { path: registerPath.trim() } });
      setRepositories(current => [...current.filter(repo => repo.id !== response.repository.id), response.repository]);
      chooseRepo(response.repository.id); recordJob(response.job); setRegisterOpen(false); setRegisterPath("");
    } catch (failure) { setRegisterError(errorMessage(failure)); }
    finally { setRegistering(false); }
  };
  const visible = useMemo(() => coverage?.files.filter(file => file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [], [coverage?.files, search]);
  const s = coverage?.summary;
  const editing = metric === "edit";
  const exact = s ? editing ? s.editExact : s.readExact : null;
  const near = s ? editing ? s.editNear : s.readNear : null;
  const mapHeading = repository ? <div className="map-heading"><div className="breadcrumbs"><button onClick={() => browse("")}><Folder size={16} />{repository.name}</button>{directory.split("/").filter(Boolean).map((part, i, parts) => <span key={i}><CaretRight size={12} /><button onClick={() => browse(parts.slice(0, i + 1).join("/"))}>{part}</button></span>)}<small>{fmt(visible.length)} 个文件</small></div><div className="metric-picker" role="group" aria-label="地图着色指标">{(["read", "edit", "activity"] as const).map(value => <button key={value} aria-pressed={metric === value} className={metric === value ? "active" : ""} onClick={() => setMetric(value)}>{metricNames[value]}</button>)}</div></div> : null;
  const mapLegend = <div className="map-legend"><span>{metric === "activity" ? "活动次数" : "精确覆盖率"}</span><span className="legend-scale">{[0, 1, 2, 3, 4].map(tone => <i key={tone} className={`tone-${tone}`} />)}</span><span>{metric === "activity" ? `0 → ${fmt(visible.reduce((max, file) => Math.max(max, metricValue(file, metric)), 0))} 次` : "0 → 100%"}</span><span className="near-key legend-near" /><span>近似</span><small>面积＝行数</small></div>;
  return <Tooltip.Provider delayDuration={350}>
    <header className="app-header"><a className="brand" href="/" aria-label="AgentManor 首页"><Stack size={25} weight="duotone" /><span>AgentManor</span></a><span className="header-divider" /><nav className="product-nav" aria-label="功能导航"><button aria-current={view === "map" ? "page" : undefined} onClick={() => switchView("map")}>代码地图</button><button aria-current={view === "sessions" ? "page" : undefined} onClick={() => switchView("sessions")}>会话库</button></nav>
      <div className="header-actions">{view === "map" && repository && <SourcesDialog repo={repository} query={query} gaps={coverage?.gaps ?? []} onJob={recordJob} />}
        <Hint label={theme === "light" ? "切换深色主题" : "切换浅色主题"}><button className="icon-button" aria-label="切换主题" onClick={() => setTheme(current => current === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={19} /> : <Sun size={19} />}</button></Hint>
        <button hidden={view !== "map"} className="button primary refresh-button" onClick={() => void runRefresh()} disabled={!repository || actionPending || jobActive(job)} aria-label={jobActive(job) ? "分析中" : "刷新分析"}><ArrowClockwise size={16} className={jobActive(job) ? "spinning" : ""} /><span className="refresh-label">{jobActive(job) ? "分析中" : "刷新分析"}</span></button>
      </div>
    </header>
    <section className="product-view" hidden={view !== "map"} aria-label="代码地图视图">
    {initialError && <Notice danger action={<button className="button subtle" onClick={() => setStatusRetry(value => value + 1)}>重试连接</button>}>{initialError}</Notice>}
    {actionError && <Notice danger action={<button className="button subtle" onClick={() => setActionError(null)}>关闭</button>}>{actionError}</Notice>}
    {job && <div className={`result-status${job.status === "failed" ? " failed" : ""}`} role="status">
      {job.status === "failed" ? <><WarningCircle size={16} /><span>刷新失败：{job.error ?? job.phase}。{coverage ? "继续显示上一版统计。" : "尚无已完成的统计。"}</span><button className="text-button" disabled={actionPending} onClick={() => void runRefresh()}>重试刷新</button></>
        : jobActive(job) ? <><ArrowClockwise size={15} className="spinning" /><span>{job.status === "queued" ? "等待分析" : job.phase}</span><progress max="1" value={Math.max(0, Math.min(1, job.progress))} aria-label="分析进度" /><small>{Math.round(job.progress * 100)}%{coverage ? " · 分析完成前保持当前结果版本" : ""}</small></>
          : <><Check size={16} /><span>刷新完成</span><small>{dateLabel(job.finishedAt)}</small></>}
    </div>}
    {coverage?.stale && !jobActive(job) && job?.status !== "failed" && <Notice action={<button className="text-button" onClick={() => void runRefresh()}>刷新分析</button>}>当前统计已过期，基于 {dateLabel(coverage.createdAt)} 的仓库基线。</Notice>}
    {initialLoading && !repository ? <Empty title="连接本地分析服务">正在读取已登记仓库与分析任务…</Empty> : !repository ? <Empty title="开始查看代码活动">登记本机 Git 仓库以查看活动。<br />本地分析 · 历史只读</Empty> : <ResizableWorkspace sidebarCollapsed={sidebarCollapsed} detailsCollapsed={detailsCollapsed}>
      <aside className={`sidebar${sidebarCollapsed ? " panel-collapsed" : ""}`} aria-label="仓库导航">
        <div className="pane-heading"><span>仓库导航</span><Hint label={sidebarCollapsed ? "展开仓库导航" : "收起仓库导航"}><button className="icon-button panel-toggle" aria-label={sidebarCollapsed ? "展开仓库导航" : "收起仓库导航"} aria-expanded={!sidebarCollapsed} aria-controls="repository-navigation-content" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <CaretRight size={17} /> : <CaretLeft size={17} />}</button></Hint></div>
        <div id="repository-navigation-content" className="sidebar-content" hidden={sidebarCollapsed}><div className="repository-picker"><Dropdown.Root><Dropdown.Trigger ref={repositoryTrigger} className="repository-trigger"><Folder size={19} weight="duotone" /><strong>{repository.name}</strong><CaretDown size={14} /></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown-content" sideOffset={6}>{repositories.map(repo => <Dropdown.Item key={repo.id} className="dropdown-item" onSelect={() => chooseRepo(repo.id)}>{repo.id === repoId && <Check size={14} />}<span>{repo.name}<small>{repo.path}</small></span></Dropdown.Item>)}<Dropdown.Separator className="dropdown-separator" /><Dropdown.Item className="dropdown-item" onSelect={() => setRegisterOpen(true)}><Plus size={15} />登记仓库</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root></div>
        <p className="repo-path" title={repository.path}>{repository.path}</p><div className="sidebar-label">仓库目录</div><DirectoryTree key={repoId} files={rootCoverage?.files ?? []} selected={directory} browse={browse} />
        <div className="sidebar-bottom"><button className="text-button" onClick={() => setRegisterOpen(true)}><Plus size={14} />登记其他仓库</button></div></div>
      </aside>
      <main className="map-main"><div className="page-heading"><h1>代码活动地图</h1><HelpPopover label="地图统计口径"><dl>
        <div><dt>覆盖统计</dt><dd>基于当前工作区内容，仅统计成功返回且能定位到当前内容的范围。精确与近似分别统计，近似不计入精确覆盖；没有已记录活动不代表从未读取或修改。</dd></div>
        <div><dt>筛选范围</dt><dd>目录、客户端、时间与类别改变统计范围；文件搜索只筛选地图与列表，缩放只改变视野。日期使用本机时区。</dd></div>
        <div><dt>来源与基线</dt><dd>分析在本机完成，原始历史只读。同一仓库的不同 worktree 分别建立内容基线。采集缺口和分析信息可按需展开核对。</dd></div></dl></HelpPopover></div>
        <div className="filters"><div className="select-field"><span>客户端</span><FilterSelect label="地图客户端" value={client} options={[{ value: "all", label: "全部客户端" }, ...CLIENTS.map(client => ({ value: client.id, label: client.name }))]} onChange={value => setClient(value as Client | "all")} /></div>
          <div className="select-field"><span>时间</span><FilterSelect label="地图时间" value={window} options={[{ value: "all", label: "全部历史" }, { value: "7", label: "最近 7 天" }, { value: "30", label: "最近 30 天" }, { value: "custom", label: "自定义" }]} onChange={value => { setWindow(value); setTimeAnchor(Date.now()); }} /></div>
          <div className="select-field"><span>文件</span><FilterSelect label="地图文件类别" value={category} options={[{ value: "source", label: "源码" }, { value: "config", label: "配置" }, { value: "docs", label: "文档" }, { value: "unknown", label: "未知类别" }, { value: "all", label: "全部文本" }]} onChange={value => { setCategory(value as FileCategory | "all"); setSelected(null); }} /></div>
          <label className="search-box"><MagnifyingGlass size={17} /><input aria-label="搜索文件或路径" placeholder="搜索文件或路径" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch("")}><X size={14} /></button>}</label>
        </div>
        {window === "custom" && <div className="date-range"><span>开始日期</span><DatePicker label="地图开始日期" value={from} onChange={setFrom} /><span>至</span><DatePicker label="地图结束日期" value={to} onChange={setTo} /></div>}
        {invalidTime && <Notice danger>开始日期不能晚于结束日期，请调整时间范围。</Notice>}
        {coverageLoading ? <div className="query-loading" role="status">正在查询所选范围…</div> : coverageError ? <Empty title="统计暂不可用" action={<div className="empty-actions"><button className="button" onClick={() => { setVersion(undefined); setReload(value => value + 1); }}>加载最新结果</button><button className="button subtle" onClick={() => void runRefresh()} disabled={jobActive(job)}>刷新分析</button></div>}>{coverageError}</Empty> : s && exact && near && !invalidTime && <>
          <div className="metrics"><div className="metric-primary"><span>{editing ? "精确修改行覆盖率" : "精确读取行覆盖率"}</span><strong>{percent(exact.lines, s.lineCount)}</strong><small><b>{fmt(exact.lines)}</b> / {fmt(s.lineCount)} 行</small></div><div><span>{editing ? "精确修改文件覆盖率" : "精确读取文件覆盖率"}</span><strong>{percent(exact.files, s.fileCount)}</strong><small><b>{fmt(exact.files)}</b> / {fmt(s.fileCount)} 个文件</small></div><div className="metric-context"><span>另有近似对应</span><strong>{fmt(near.lines)}<em>行</em></strong><small>{fmt(near.files)} 个文件 · 不计入精确覆盖</small></div></div>
          {visible.some(file => file.lineCount > 0) ? <CodeMap files={visible} directory={directory} metric={metric} selected={selected} browse={browse} select={selectFile} heading={mapHeading} legend={mapLegend} /> : <>{mapHeading}<Empty title={visible.length ? "当前范围只有空文件" : "没有符合筛选的文件"} action={<button className="button subtle" onClick={clearFilters}>重置筛选</button>}>{visible.length ? "空文件为 0 行，没有地图面积。可从下方文件列表查看活动。" : "尝试切换类别、客户端、时间或目录；文件搜索只影响地图与文件列表。"}</Empty>{mapLegend}</>}
          {search && <p className="muted small">搜索仅筛选文件</p>}
          <details className="file-table" open={!!search || visible.some(file => !file.lineCount)}><summary>文件列表 · {fmt(visible.length)} 个</summary><div className="file-table-scroll"><table><thead><tr><th>文件</th><th>行数</th><th>精确</th><th>近似行</th><th>次数</th></tr></thead><tbody>{visible.map(file => <tr key={file.path} className={selected === file.path ? "selected" : ""}><td><button onClick={() => selectFile(file.path)}>{file.path}</button></td><td>{fmt(file.lineCount)}</td><td>{percent(metric === "edit" ? file.editExactLines : file.readExactLines, file.lineCount)}</td><td>{fmt(metric === "edit" ? file.editNearLines : file.readNearLines)}</td><td>{fmt(metricValue(file, "activity"))}</td></tr>)}</tbody></table></div></details>
          {coverage!.gaps.length > 0 && <details className="coverage-gaps"><summary><WarningCircle size={15} />{coverage!.gaps.length} 项采集缺口与范围限制</summary><Gaps gaps={coverage!.gaps} /></details>}
          <details className="baseline-note"><summary>分析信息 · {dateLabel(coverage!.createdAt)}</summary><p>结果版本 {coverage!.version}<br />基线 {coverage!.baselineHash}{coverage!.previousVersion && <> · 上一版 {coverage!.previousVersion}</>}</p></details>
        </>}
      </main>
      <FilePane repoId={repoId} detail={detail} loading={detailLoading} error={detailError} retry={() => setDetailRetry(value => value + 1)} collapsed={detailsCollapsed} toggle={() => setDetailsCollapsed(value => !value)} metric={metric} theme={theme} query={query} openSession={event => void openSession(event)} />
    </ResizableWorkspace>}
    {!repository && !initialLoading && <div className="first-register"><button className="button primary" onClick={() => setRegisterOpen(true)}><Plus size={17} />登记本机仓库</button></div>}
    <Modal open={registerOpen} onOpenChange={setRegisterOpen} fallbackFocus={repositoryTrigger} title="登记本机 Git 仓库" description="输入当前工作区的绝对路径。登记后自动发现历史并创建分析任务。">
      <form className="register-form" onSubmit={event => void register(event)}><label>仓库绝对路径<input value={registerPath} onChange={event => setRegisterPath(event.target.value)} placeholder="/absolute/path/to/repository" autoComplete="off" required /></label>{registerError && <Notice danger>{registerError}</Notice>}<div className="dialog-end"><button type="button" className="button subtle" onClick={() => setRegisterOpen(false)}>取消</button><button type="submit" className="button primary" disabled={registering || !registerPath.trim()}>{registering ? "正在登记…" : "登记并分析"}</button></div></form>
    </Modal>
    </section>
    <section className="product-view" hidden={view !== "sessions"} aria-label="会话库视图"><Sessions active={view === "sessions"} target={sessionTarget} onMap={openMap} /></section>
  </Tooltip.Provider>;
}
