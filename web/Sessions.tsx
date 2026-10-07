import { clientLabel, getLanguage, isMessageDescriptorKnown, messageText, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber } from "../src/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretLeft, CaretRight, ChatCircle, MagnifyingGlass, MapTrifold } from "@phosphor-icons/react";
import type { Client } from "../src/clients";
import { CLIENTS } from "../src/clients";
import type { MessageKind, SessionIndexStatus, SessionJob, SessionListResult, SessionMessage, SessionMessageResult, SessionProfile, SessionQuery, SessionRefreshOptions, SessionSearchHit, SessionSearchResult, SessionSummary, SessionTimelineResult } from "../src/session-contracts";
import { ApiError, isAborted, request } from "./api";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { sessionDisplayTitle, sessionParentTitle, sessionMessageText, executionEntryLabel, groupedTurns, localDateBoundary, PAGE_SIZE, TURN_PAGE_SIZE, type EvidenceTarget, searchHitMode, searchKinds, sessionParams, turnTitle, workspaceSessionSemantics } from "./session-model";
import { MessageCard, kindLabels } from "./SessionMessage";
import { SessionTrace } from "./SessionTrace";
import { Notice, Pager, SessionDiagnostic, SessionError } from "./SessionControls";
import { SessionProfilePane } from "./SessionProfile";
import { FilterSelect } from "./FilterSelect";
import { ProjectPicker } from "./ProjectPicker";
import { DatePicker } from "./DatePicker";
import { HelpPopover } from "./HelpPopover";
import { SessionClientChecks, SessionRefreshActions, SessionRefreshStatus } from "./SessionRefresh";
import "./session.css";

type Mode = "brief" | "full" | "trace";
type Target = { sessionId: string; messageId?: string; mode?: Mode; page?: number; turnPosition?: number; branch?: string };
type ReadingPosition = { branch?: string; mode: Mode; page: number; focus?: string; position?: number; scroll: number; expanded: string[] };

const modeLabels: Record<Mode, string> = { brief: "sessions.mode.brief", full: "sessions.mode.full", trace: "sessions.mode.trace" };
const activeJob = (job?: SessionJob) => job?.status === "queued" || job?.status === "running";
const formatCount = (value: number) => formatNumber(getLanguage(), value);
const dateLabel = (value?: string) => value ? formatDateTime(getLanguage(), value) : t("sessions.message.timeMissing");
const shortProject = (value?: string) => value ? value.split(/[\\/]/).filter(Boolean).at(-1) ?? value : t("sessions.noProject");
const titleOrigins: Record<SessionSummary["titleOrigin"], string> = { recorded: "sessions.title.origin.recorded", first_user: "sessions.title.origin.firstUser", task: "sessions.title.origin.task", agent: "sessions.title.origin.agent", fallback: "sessions.title.origin.fallback" };

function SessionRelationship({ session }: { session: SessionSummary }) {
  useI18n();
  if (!session.relationship) return null;
  return <small className="session-relationship" title={session.parentTitle ? t("sessions.relationship.parent", { title: sessionParentTitle(session) }) : t("sessions.relationship.parentMissing")}>
    <span className="session-badge">{session.relationship === "fork" ? t("sessions.relationship.forkShort") : t("sessions.relationship.childAgent")}</span>
    <span>{session.parentTitle ? t("sessions.relationship.belongs", { title: sessionParentTitle(session) }) : t("sessions.relationship.parentMissing")}</span>
  </small>;
}

function QuietTag({ session }: { session: SessionSummary }) {
  useI18n();
  return session.executionMode === "quiet" ? <span className="session-badge session-quiet-tag" title={t("sessions.execution.quietEvidence")}>{t("sessions.execution.quiet")}</span> : null;
}

function SearchHitList({ hits, total, page, pageSize, onPage, onSelect, title }: {
  hits: SessionSearchHit[]; total: number; page: number; pageSize: number; onPage: (page: number) => void; onSelect: (hit: SessionSearchHit) => void; title: string;
}) {
  useI18n();
  return <section className="session-hits" aria-label={title}>
    <div className="session-section-heading"><h3>{title}</h3><span>{t("sessions.search.matchCount", { count: total })}</span></div>
    {hits.map((hit, index) => <button className="session-hit" key={`${hit.session.id}-${hit.messageId ?? hit.kind}-${index}`} onClick={() => onSelect(hit)}>
      <span className="session-hit-kind">{hit.kind === "title" ? t("sessions.search.title") : t(kindLabels[hit.kind])}</span>
      <strong>{sessionDisplayTitle(hit.session)}</strong>
      <SessionRelationship session={hit.session} />
      <QuietTag session={hit.session} />
      <small>{clientLabel(hit.session.client)} · {shortProject(hit.session.project)} · {dateLabel(hit.session.updatedAt)}</small>
      <span className="session-hit-snippet">{hit.snippet}</span>
    </button>)}
    {!hits.length && <p className="muted small">{t("sessions.search.empty")}</p>}
    {total > pageSize && <Pager page={page} pageSize={pageSize} total={total} onChange={onPage} label={t("sessions.search.pagination", { title })} />}
  </section>;
}

function TurnTimeline({ turn, position, mode, focusMessageId, project, onMap, expanded, onToggle }: {
  turn: { id: string; messages: SessionMessage[] }; position: number; mode: Mode; focusMessageId?: string; project?: string; onMap: (path?: string, project?: string) => void;
  expanded: boolean; onToggle: (open: boolean) => void;
}) {
  useI18n();
  const title = turnTitle(turn.id, position);
  const userMessage = turn.messages.find(message => message.kind === "user");
  const answer = [...turn.messages].reverse().find(message => message.kind === "assistant" && message.final);
  return <details id={`session-turn-${turn.id}`} className="session-turn" open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary><CaretDown size={15} aria-hidden="true" /><span>{title}</span><small>{t("sessions.recordCount", { count: turn.messages.length })}</small>
      <span className="session-turn-summary">{userMessage ? sessionMessageText(userMessage) : answer ? sessionMessageText(answer) : t("sessions.turn.expand")}</span></summary>
    {expanded && <div className="session-turn-events">
      {turn.messages.map(message => <MessageCard key={message.id} message={message} mode={mode} focused={focusMessageId === message.id} project={project} onMap={onMap} />)}
    </div>}
  </details>;
}

export default function Sessions({ active, target, onMap }: { active: boolean; target?: Target; onMap: (path?: string, project?: string) => void }) {
  useI18n();
  const [status, setStatus] = useState<SessionIndexStatus | null>(null);
  const [statusReload, setStatusReload] = useState(-1);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<Error | null>(null);
  const [sessionJob, setSessionJob] = useState<SessionJob | undefined>();
  const [jobError, setJobError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  const [client, setClient] = useState<Client | "all">("all");
  const [project, setProject] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [debouncedGlobalQuery, setDebouncedGlobalQuery] = useState("");
  const [includeProcess, setIncludeProcess] = useState(false);
  const [listPage, setListPage] = useState(1);
  const [sessionList, setSessionList] = useState<SessionListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<Error | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedSummary, setSelectedSummary] = useState<SessionSummary>();
  const [mode, setMode] = useState<Mode>("brief");
  const [branch, setBranch] = useState<string>();
  const [messagePage, setMessagePage] = useState(1);
  const [focusMessageId, setFocusMessageId] = useState<string>();
  const [traceSelection, setTraceSelection] = useState<string>();
  const [traceFocusRequest, setTraceFocusRequest] = useState(0);
  const [timeline, setTimeline] = useState<{ sessionId: string; data: SessionTimelineResult }>();
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<Error>();
  const [timelineRetry, setTimelineRetry] = useState(0);
  const [messageData, setMessageData] = useState<SessionMessageResult | null>(null);
  const [messageDataKey, setMessageDataKey] = useState("");
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState<Error | null>(null);
  const [globalSearchPage, setGlobalSearchPage] = useState(1);
  const [globalSearch, setGlobalSearch] = useState<SessionSearchResult | null>(null);
  const [globalSearchKey, setGlobalSearchKey] = useState("");
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<Error | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [debouncedLocalQuery, setDebouncedLocalQuery] = useState("");
  const [localSearch, setLocalSearch] = useState<SessionSearchResult | null>(null);
  const [localSearchKey, setLocalSearchKey] = useState("");
  const [localSearchLoading, setLocalSearchLoading] = useState(false);
  const [localSearchError, setLocalSearchError] = useState<Error | null>(null);
  const [localSearchPage, setLocalSearchPage] = useState(1);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<Error | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [executionMode, setExecutionMode] = useState<NonNullable<SessionQuery["executionMode"]>>("regular");
  const [profileRetry, setProfileRetry] = useState(0);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const [messageRetry, setMessageRetry] = useState(0);
  const [turnPosition, setTurnPosition] = useState<number>();
  const [currentTurn, setCurrentTurn] = useState(1);
  const [turnInput, setTurnInput] = useState("1");
  const [compactPanel, setCompactPanel] = useState<"list" | "profile" | null>(null);
  const [localHitIndex, setLocalHitIndex] = useState(-1);
  const [showLocalHits, setShowLocalHits] = useState(false);
  const readingPane = useRef<HTMLDivElement>(null);
  const readingPositions = useRef(new Map<string, ReadingPosition>());
  const searchBookmark = useRef<ReadingPosition | undefined>(undefined);
  const restoreScroll = useRef<number | undefined>(undefined);
  const readyScrollRestore = useRef(false);
  const pendingHit = useRef<"first" | "last" | undefined>(undefined);
  const pageScroll = useRef(true);
  const evidenceRequest = useRef<AbortController | undefined>(undefined);
  const previousJob = useRef<SessionJob | undefined>(undefined);
  useEffect(() => () => evidenceRequest.current?.abort(), []);
  useEffect(() => { setTraceSelection(focusMessageId); }, [focusMessageId, selectedSessionId, messagePage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedGlobalQuery(globalQuery.trim()), 240);
    return () => clearTimeout(timer);
  }, [globalQuery]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedLocalQuery(localQuery.trim()), 200);
    return () => clearTimeout(timer);
  }, [localQuery]);
  useEffect(() => { setListPage(1); setGlobalSearchPage(1); }, [client, project, from, to, debouncedGlobalQuery, includeProcess, includeSubagents, executionMode]);
  useEffect(() => { setLocalSearchPage(1); }, [selectedSessionId, debouncedLocalQuery, includeProcess]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setStatusLoading(true);
    setStatusError(null);
    void request<SessionIndexStatus>("/sessions/status", { signal: controller.signal })
      .then(result => {
        setStatus(result);
        setStatusReload(reload);
        setSessionJob(current => activeJob(current) ? current : result.job);
      })
      .catch(error => { if (!isAborted(error)) { setStatusError(error instanceof Error ? error : new Error(String(error))); setStatusReload(reload); } })
      .finally(() => { if (!controller.signal.aborted) setStatusLoading(false); });
    return () => controller.abort();
  }, [active, reload]);

  const invalidDates = !!from && !!to && from > to;
  // 先确认本次加载的结果版本，避免无版本请求被随后到达的状态响应取消并重复计算。
  const indexReady = !!status?.version && statusReload === reload;
  const queryKinds = useMemo(() => debouncedGlobalQuery ? searchKinds(includeProcess) : undefined, [debouncedGlobalQuery, includeProcess]);
  const listQuery = useMemo(() => sessionParams({
    client: client === "all" ? undefined : client,
    project: project === "all" ? undefined : project === "none" ? "none" : project,
    from: localDateBoundary(from),
    to: localDateBoundary(to, true),
    q: debouncedGlobalQuery || undefined,
    kinds: queryKinds,
    page: listPage,
    pageSize: PAGE_SIZE,
    version: status?.version,
    includeSubagents,
    executionMode,
  }), [client, project, from, to, debouncedGlobalQuery, queryKinds, listPage, status?.version, includeSubagents, executionMode]);

  const searchOnly = !!debouncedGlobalQuery && !!selectedSessionId;
  useEffect(() => {
    if (searchOnly) { setListLoading(false); setListError(null); return; }
    if (!active || !indexReady || invalidDates) return;
    const controller = new AbortController();
    setListLoading(true);
    setListError(null);
    void request<SessionListResult>(`/sessions${listQuery}`, { signal: controller.signal })
      .then(result => setSessionList(result))
      .catch(error => { if (!isAborted(error)) setListError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, invalidDates, listQuery, reload, searchOnly]);

  const globalSearchQuery = useMemo(() => sessionParams({
    client: client === "all" ? undefined : client,
    project: project === "all" ? undefined : project === "none" ? "none" : project,
    from: localDateBoundary(from),
    to: localDateBoundary(to, true),
    q: debouncedGlobalQuery || undefined,
    kinds: debouncedGlobalQuery ? searchKinds(includeProcess) : undefined,
    page: globalSearchPage,
    pageSize: 12,
    version: status?.version,
    executionMode,
  }), [client, project, from, to, debouncedGlobalQuery, includeProcess, globalSearchPage, status?.version, executionMode]);

  useEffect(() => {
    if (!active || !indexReady || !debouncedGlobalQuery || invalidDates) { setGlobalSearch(null); setGlobalSearchError(null); return; }
    const controller = new AbortController();
    setGlobalSearchLoading(true);
    setGlobalSearchError(null);
    void request<SessionSearchResult>(`/sessions/search${globalSearchQuery}`, { signal: controller.signal })
      .then(result => { setGlobalSearch(result); setGlobalSearchKey(globalSearchQuery); })
      .catch(error => { if (!isAborted(error)) setGlobalSearchError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setGlobalSearchLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, debouncedGlobalQuery, globalSearchQuery, invalidDates, reload]);

  const messageQuery = useMemo(() => sessionParams({
    version: status?.version,
    page: focusMessageId ? undefined : messagePage,
    pageSize: TURN_PAGE_SIZE,
    pageUnit: "turn",
    turnPosition,
    mode, branch,
    messageId: focusMessageId,
  }), [status?.version, focusMessageId, messagePage, mode, turnPosition, branch]);
  useEffect(() => {
    if (!active || !selectedSessionId) { setMessageData(null); setMessageLoading(false); setMessageError(null); return; }
    if (!indexReady) return;
    const controller = new AbortController();
    setMessageLoading(true);
    setMessageError(null);
    void request<SessionMessageResult>(`/sessions/${encodeURIComponent(selectedSessionId)}/messages${messageQuery}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        readyScrollRestore.current = restoreScroll.current !== undefined;
        setMessageData(result);
        setMessageDataKey(`${selectedSessionId}${messageQuery}`);
        setMessagePage(result.page);
        const current = result.turns?.find(turn => turn.position === turnPosition || !!focusMessageId && turn.id === (result.messages.find(message => message.id === focusMessageId)?.turnId || "unknown"));
        setCurrentTurn(current?.position ?? result.turns?.[0]?.position ?? 1);
        setTurnInput(String(current?.position ?? result.turns?.[0]?.position ?? 1));
        if (turnPosition && current) setExpandedTurns(new Set([current.id]));
        if (mode === "brief") setExpandedTurns(new Set(result.messages.map(message => message.turnId || "unknown")));
        setSelectedSummary(result.session);
        if (focusMessageId) {
          const turnId = result.messages.find(message => message.id === focusMessageId)?.turnId;
          setExpandedTurns(current => new Set(current).add(turnId || "unknown"));
        }
      })
      .catch(error => { if (!isAborted(error)) setMessageError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setMessageLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, selectedSessionId, messageQuery, focusMessageId, reload, messageRetry]);

  useEffect(() => {
    if (!active || !indexReady || !selectedSessionId || mode !== "trace") return;
    const controller = new AbortController();
    setTimelineLoading(true); setTimelineError(undefined);
    void request<SessionTimelineResult>(`/sessions/${encodeURIComponent(selectedSessionId)}/timeline${sessionParams({ version: status?.version })}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTimeline({ sessionId: selectedSessionId, data }); })
      .catch(error => { if (!isAborted(error)) setTimelineError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setTimelineLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, selectedSessionId, status?.version, mode, reload, timelineRetry]);

  useLayoutEffect(() => {
    if (!active || !messageData || messageData.session.id !== selectedSessionId || messageDataKey !== `${selectedSessionId}${messageQuery}` || !readingPane.current) return;
    if (restoreScroll.current !== undefined) {
      if (readyScrollRestore.current) { readingPane.current.scrollTop = restoreScroll.current; restoreScroll.current = undefined; readyScrollRestore.current = false; pageScroll.current = false; }
      return;
    }
    if (!pageScroll.current) return;
    if (mode === "trace") { pageScroll.current = false; return; }
    const node = focusMessageId && document.getElementById(`session-message-${focusMessageId}`);
    if (node && expandedTurns.has(messageData.messages.find(message => message.id === focusMessageId)?.turnId || "unknown")) {
      const pane = readingPane.current;
      pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
      pageScroll.current = false;
    } else if (turnPosition && messageData.turns?.some(turn => turn.position === turnPosition)) {
      const turn = messageData.turns.find(turn => turn.position === turnPosition)!;
      const target = document.getElementById(`session-turn-${turn.id}`);
      if (target) readingPane.current.scrollTop += target.getBoundingClientRect().top - readingPane.current.getBoundingClientRect().top - 10;
      pageScroll.current = false;
    } else if (pageScroll.current) { readingPane.current.scrollTop = 0; pageScroll.current = false; }
  }, [active, focusMessageId, messageData, messageDataKey, messageQuery, expandedTurns, selectedSessionId, turnPosition, mode, traceFocusRequest]);

  const localSearchQuery = useMemo(() => sessionParams({ q: debouncedLocalQuery || undefined, kinds: searchKinds(includeProcess),
    sessionId: selectedSessionId, page: localSearchPage, pageSize: 12, version: status?.version }), [debouncedLocalQuery, includeProcess, selectedSessionId, localSearchPage, status?.version]);
  useEffect(() => {
    if (!active || !indexReady || !selectedSessionId || !debouncedLocalQuery) { setLocalSearch(null); setLocalSearchError(null); return; }
    const controller = new AbortController();
    setLocalSearchLoading(true);
    setLocalSearchError(null);
    void request<SessionSearchResult>(`/sessions/search${localSearchQuery}`, { signal: controller.signal })
      .then(result => { setLocalSearch(result); setLocalSearchKey(localSearchQuery); })
      .catch(error => { if (!isAborted(error)) setLocalSearchError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setLocalSearchLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, selectedSessionId, debouncedLocalQuery, localSearchQuery, reload]);

  const profileQuery = useMemo(() => sessionParams({ version: status?.version, includeChildren }), [status?.version, includeChildren]);
  useEffect(() => {
    if (!active || !selectedSessionId) { setProfile(null); setProfileLoading(false); setProfileError(null); return; }
    if (!indexReady) return;
    const controller = new AbortController();
    setProfileLoading(true);
    setProfileError(null);
    setProfile(null);
    void request<SessionProfile>(`/sessions/${encodeURIComponent(selectedSessionId)}/profile${profileQuery}`, { signal: controller.signal })
      .then(result => setProfile(result))
      .catch(error => { if (!isAborted(error)) setProfileError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, selectedSessionId, profileQuery, reload, profileRetry]);

  useEffect(() => {
    const job = sessionJob;
    if (!active || !job || !activeJob(job)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{ job: SessionJob }>(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setSessionJob(result.job); setJobError(null); }
      } catch (error) { if (!isAborted(error) && !controller.signal.aborted) setJobError(error instanceof Error ? error : new Error(String(error))); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1100);
    };
    timer = setTimeout(() => void poll(), 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, sessionJob?.id, sessionJob?.status]);

  useEffect(() => {
    // 已完成的旧任务只是状态，只有本次观察到的刷新完成才重新读取索引。
    if (sessionJob?.status === "complete" && previousJob.current?.id === sessionJob.id && activeJob(previousJob.current)) setReload(value => value + 1);
    previousJob.current = sessionJob;
  }, [sessionJob?.id, sessionJob?.status]);

  useEffect(() => {
    if (!target?.sessionId) return;
    evidenceRequest.current?.abort();
    setSelectedSessionId(target.sessionId);
    setSelectedSummary(undefined);
    setFocusMessageId(target.messageId);
    setMessagePage(target.page ?? 1);
    setTurnPosition(target.turnPosition);
    setBranch(target.branch ?? (target.messageId ? "all" : undefined));
    if (target.mode) setMode(target.mode); else if (target.messageId) setMode("trace");
    pageScroll.current = true;
    setLocalQuery(""); searchBookmark.current = undefined;
  }, [target]);

  useEffect(() => {
    if (!target?.sessionId && !selectedSessionId && sessionList?.sessions[0]) {
      setSelectedSessionId(sessionList.sessions[0].id);
      setSelectedSummary(sessionList.sessions[0]);
    }
  }, [target?.sessionId, selectedSessionId, sessionList]);

  const selectedMessageData = messageData?.session.id === selectedSessionId ? messageData : undefined;
  const selectedSession = selectedMessageData?.session ?? selectedSummary ?? sessionList?.sessions.find(session => session.id === selectedSessionId);
  const turns = useMemo(() => groupedTurns(selectedMessageData?.messages ?? []), [selectedMessageData]);
  const currentMessage = selectedMessageData?.messages.find(message => message.id === (mode === "trace" ? traceSelection ?? focusMessageId : focusMessageId));
  const visibleGlobalSearch = globalQuery.trim() === debouncedGlobalQuery && globalSearchKey === globalSearchQuery ? globalSearch : null;
  const visibleLocalSearch = localQuery.trim() === debouncedLocalQuery && localSearchKey === localSearchQuery ? localSearch : null;

  const captureReading = (): ReadingPosition => ({ mode, branch, page: selectedMessageData?.page ?? messagePage, focus: mode === "trace" ? traceSelection ?? focusMessageId : focusMessageId, position: turnPosition,
    scroll: readingPane.current?.scrollTop ?? 0, expanded: [...expandedTurns] });
  const rememberReading = () => { if (selectedSessionId) readingPositions.current.set(selectedSessionId, captureReading()); };
  const updateAddress = (id: string, state: Partial<ReadingPosition> = {}, replace = false) => {
    const params = new URLSearchParams({ id, mode: state.mode ?? mode });
    if (state.focus) params.set("message", state.focus);
    const readingBranch = "branch" in state ? state.branch : branch;
    if (readingBranch) params.set("branch", readingBranch);
    if (state.page && state.page > 1) params.set("page", String(state.page));
    if (state.position) params.set("turn", String(state.position));
    const hash = `#sessions?${params}`;
    if (location.hash !== hash) history[replace ? "replaceState" : "pushState"](null, "", hash);
  };
  const selectSession = (session: SessionSummary | string) => {
    evidenceRequest.current?.abort(); rememberReading();
    const id = typeof session === "string" ? session : session.id;
    const saved = readingPositions.current.get(id);
    setSelectedSessionId(id); setSelectedSummary(typeof session === "string" ? undefined : session);
    setFocusMessageId(saved?.focus); setMessagePage(saved?.page ?? 1); setTurnPosition(saved?.position);
    setMode(saved?.mode ?? "brief"); setBranch(saved?.branch); setExpandedTurns(new Set(saved?.expanded));
    restoreScroll.current = saved?.scroll; readyScrollRestore.current = false; pageScroll.current = !saved;
    setLocalQuery(""); searchBookmark.current = undefined; setShowLocalHits(false); setCompactPanel(null);
    updateAddress(id, saved ?? { mode: "brief", branch: undefined });
  };
  const selectHit = (hit: SessionSearchHit) => {
    setTraceFocusRequest(value => value + 1);
    evidenceRequest.current?.abort();
    if (hit.session.id !== selectedSessionId) { rememberReading(); searchBookmark.current = undefined; setLocalQuery(""); }
    setBranch("all");
    setSelectedSessionId(hit.session.id); setSelectedSummary(hit.session); setFocusMessageId(hit.messageId);
    setMessagePage(1); setTurnPosition(undefined); pageScroll.current = true; restoreScroll.current = undefined;
    if (hit.messageId) setExpandedTurns(new Set([hit.turnId || "unknown"]));
    const next = searchHitMode(hit, mode); setMode(next); setShowLocalHits(false); setCompactPanel(null);
    updateAddress(hit.session.id, { mode: next, focus: hit.messageId, branch: "all" });
  };
  const focusStep = (step: SessionProfile["steps"][number]) => {
    if (!step.messageId) return;
    setTraceFocusRequest(value => value + 1);
    if (step.sessionId !== selectedSessionId) { rememberReading(); setSelectedSessionId(step.sessionId); setSelectedSummary(undefined); setLocalQuery(""); }
    setBranch("all");
    setFocusMessageId(step.messageId); setMessagePage(1); setTurnPosition(undefined); setMode("trace"); setCompactPanel(null);
    setExpandedTurns(new Set([selectedMessageData?.messages.find(message => message.id === step.messageId)?.turnId || "unknown"]));
    pageScroll.current = true; restoreScroll.current = undefined;
    updateAddress(step.sessionId, { mode: "trace", focus: step.messageId, branch: "all" });
  };
  const findEvidence = async (evidence: EvidenceTarget) => {
    if (!selectedSessionId) return;
    evidenceRequest.current?.abort(); const controller = new AbortController(); evidenceRequest.current = controller;
    try {
      const ids = profile?.scope === "tree" ? profile.sessionIds : [selectedSessionId];
      for (const id of ids) {
        try {
          const result = await request<SessionMessageResult>(`/sessions/${encodeURIComponent(id)}/messages${sessionParams({ ...evidence, mode: "trace", pageUnit: "turn", pageSize: TURN_PAGE_SIZE, version: status?.version })}`, { signal: controller.signal });
          if (result.focusMessageId) focusStep({ id: result.focusMessageId, sessionId: id, messageId: result.focusMessageId });
          return;
        } catch (error) { if (!(error instanceof ApiError && error.code === "SOURCE_NOT_FOUND")) throw error; }
      }
      setMessageError(new ApiError("SOURCE_NOT_FOUND", "当前索引范围中没有可定位的调用证据，请刷新后重试。", { key: "sessions.reading.evidenceMissing" }));
    } catch (error) { if (!isAborted(error)) setMessageError(error instanceof Error ? error : new Error(String(error))); }
  };
  const inspectTrace = (message: SessionMessage) => {
    setTraceSelection(message.id);
    trackTraceTurn(message.turnId || "unknown");
    updateAddress(message.sessionId, { mode: "trace", focus: message.id });
  };
  const trackTraceTurn = (id: string) => {
    const turn = selectedMessageData?.turns?.find(turn => turn.id === id);
    if (turn) { setCurrentTurn(turn.position); if (document.activeElement?.id !== "session-turn-jump") setTurnInput(String(turn.position)); }
  };
  const changeMessagePage = (page: number) => {
    setTraceSelection(undefined);
    setFocusMessageId(undefined); setTurnPosition(undefined); setMessagePage(page); pageScroll.current = true;
    if (selectedSessionId) updateAddress(selectedSessionId, { mode, page });
  };
  const jumpTurn = (position: number) => {
    setTraceFocusRequest(value => value + 1);
    setTraceSelection(undefined);
    const bounded = Math.max(1, Math.min(selectedMessageData?.totalTurns ?? 1, position));
    setTurnInput(String(bounded)); setCurrentTurn(bounded); setTurnPosition(bounded); setFocusMessageId(undefined);
    const resident = selectedMessageData?.turns?.find(turn => turn.position === bounded);
    if (resident) setExpandedTurns(current => new Set(current).add(resident.id));
    pageScroll.current = true; restoreScroll.current = undefined;
    if (selectedSessionId) updateAddress(selectedSessionId, { mode, position: bounded });
  };
  const changeMode = (next: Mode) => {
    const current = selectedMessageData?.messages.find(message => message.id === (mode === "trace" ? traceSelection ?? focusMessageId : focusMessageId));
    const activeTurn = current?.turnId ?? selectedMessageData?.turns?.find(turn => turn.position === currentTurn)?.id;
    const candidate = current && (next !== "brief" || current.currentBranch !== false && (current.kind === "user" || current.final)) ? current
      : selectedMessageData?.messages.find(message => (!activeTurn || (message.turnId || "unknown") === activeTurn) && (next !== "brief" || message.currentBranch !== false && (message.kind === "user" || message.final)));
    setMode(next); setBranch(undefined); setFocusMessageId(candidate?.id); setTurnPosition(undefined); setExpandedTurns(new Set()); pageScroll.current = true;
    if (selectedSessionId) updateAddress(selectedSessionId, { mode: next, branch: undefined, focus: candidate?.id, page: candidate ? undefined : messagePage });
  };
  const changeLocalQuery = (value: string) => {
    pendingHit.current = undefined;
    if (value && !localQuery) searchBookmark.current = captureReading();
    setLocalQuery(value); setLocalHitIndex(-1); setShowLocalHits(!!value);
    if (!value && searchBookmark.current) {
      const saved = searchBookmark.current; setMode(saved.mode); setBranch(saved.branch); setMessagePage(saved.page); setTurnPosition(saved.position);
      setFocusMessageId(saved.focus); setExpandedTurns(new Set(saved.expanded)); restoreScroll.current = saved.scroll;
      readyScrollRestore.current = false;
      setMessageRetry(value => value + 1); searchBookmark.current = undefined;
      if (selectedSessionId) updateAddress(selectedSessionId, saved, true);
    }
  };
  const moveLocalHit = (direction: number) => {
    if (!visibleLocalSearch?.hits.length) return;
    const index = localHitIndex < 0 ? 0 : localHitIndex + direction;
    if (index < 0 && visibleLocalSearch.page > 1) { pendingHit.current = "last"; setLocalSearchPage(value => value - 1); }
    else if (index >= visibleLocalSearch.hits.length && visibleLocalSearch.page * visibleLocalSearch.pageSize < visibleLocalSearch.total) { pendingHit.current = "first"; setLocalSearchPage(value => value + 1); }
    else if (visibleLocalSearch.hits[index]) { setLocalHitIndex(index); selectHit(visibleLocalSearch.hits[index]); }
  };
  useEffect(() => {
    if (!pendingHit.current || !visibleLocalSearch?.hits.length || visibleLocalSearch.page !== localSearchPage) return;
    const index = pendingHit.current === "first" ? 0 : visibleLocalSearch.hits.length - 1;
    pendingHit.current = undefined; setLocalHitIndex(index); selectHit(visibleLocalSearch.hits[index]!);
  }, [visibleLocalSearch, localSearchPage]);
  const toggleTurn = (id: string, open: boolean) => setExpandedTurns(current => {
    if (current.has(id) === open) return current;
    const next = new Set(current); if (open) next.add(id); else next.delete(id); return next;
  });
  const refresh = async (options: SessionRefreshOptions = { client: client === "all" ? undefined : client, mode: "quick" }) => {
    setRefreshing(true);
    setJobError(null);
    try {
      const result = await request<{ job: SessionJob }>("/sessions/refresh", { method: "POST", body: { ...options } });
      setSessionJob(result.job);
    } catch (error) { setJobError(error instanceof Error ? error : new Error(String(error))); }
    finally { setRefreshing(false); }
  };

  useEffect(() => {
    if (active && selectedSessionId && !new URLSearchParams(location.hash.split("?")[1]).get("id")) updateAddress(selectedSessionId, { mode }, true);
  }, [active, selectedSessionId]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setCompactPanel(null); setShowLocalHits(false); } };
    if (active) document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [active]);
  return <div className="sessions-shell" data-compact-panel={compactPanel ?? ""} hidden={!active}>
    {compactPanel && <button className="session-mobile-backdrop" aria-label={t("sessions.reading.return")} onClick={() => setCompactPanel(null)} /> }
    <ResizableWorkspace sidebarCollapsed={leftCollapsed} detailsCollapsed={rightCollapsed} semantics={workspaceSessionSemantics()}>
      <aside className={`sidebar session-sidebar${leftCollapsed ? " panel-collapsed" : ""}`} aria-label={t("sessions.list.title")}>
        <div className="pane-heading"><span>{t("sessions.list.library")}</span><div className="section-actions"><div hidden={leftCollapsed}><HelpPopover label={t("sessions.filter.help")}>
          <dl><div><dt>{t("sessions.filter.type")}</dt><dd>{t("sessions.filter.typeHelp")}</dd></div>
            <div><dt>{t("sessions.filter.searchChildren")}</dt><dd>{t("sessions.filter.searchHelp")}</dd></div>
            <div><dt>{t("sessions.filter.dateRefresh")}</dt><dd>{t("sessions.filter.dateHelp")}</dd></div></dl>
        </HelpPopover></div><button className="icon-button panel-toggle" aria-label={leftCollapsed ? t("sessions.list.expand") : t("sessions.list.collapse")} aria-expanded={!leftCollapsed} aria-controls="session-list-content" onClick={() => { setLeftCollapsed(value => !value); setCompactPanel(null); }}>{leftCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button></div></div>
        <div id="session-list-content" className="sidebar-content" hidden={leftCollapsed}>
          <label className="session-search-field"><MagnifyingGlass size={16} aria-hidden="true" /><span className="sr-only">{t("sessions.search.globalLabel")}</span><input value={globalQuery} onChange={event => setGlobalQuery(event.target.value)} placeholder={t("sessions.search.globalPlaceholder")} />{globalQuery && <button type="button" aria-label={t("sessions.search.clear")} onClick={() => setGlobalQuery("")}>×</button>}</label>
          <label className="session-process-toggle"><input type="checkbox" checked={includeProcess} onChange={event => setIncludeProcess(event.target.checked)} /><span>{t("sessions.search.process")}</span></label>
          <label className="session-process-toggle"><input type="checkbox" aria-label={t("sessions.filter.showChildren")} checked={includeSubagents} onChange={event => setIncludeSubagents(event.target.checked)} /><span>{t("sessions.filter.showChildren")}</span></label>
          <div className="session-filters">
            <FilterSelect label={t("sessions.filter.client")} value={client} options={[{ value: "all", label: t("sessions.allClients") }, ...CLIENTS.map(item => ({ value: item.id, label: item.name }))]} onChange={value => setClient(value as Client | "all")} />
            <ProjectPicker value={project} options={[{ value: "all", label: t("sessions.filter.allProjects") }, { value: "none", label: t("sessions.noProject") },
              ...(status?.projects.map(path => ({ value: path, label: shortProject(path), description: path })) ?? [])]} onChange={setProject} />
          </div>
          <div className="session-date-filters"><div><span>{t("sessions.filter.from")}</span><DatePicker label={t("sessions.filter.startDate")} value={from} onChange={setFrom} /></div><div><span>{t("sessions.filter.to")}</span><DatePicker label={t("sessions.filter.endDate")} value={to} onChange={setTo} /></div></div>
          <div className="session-execution-filter"><FilterSelect label={t("sessions.filter.execution")} value={executionMode} options={[{ value: "regular", label: t("sessions.filter.regular") }, { value: "quiet", label: t("sessions.filter.quiet") }, { value: "all", label: t("sessions.filter.allSessions") }]} onChange={value => setExecutionMode(value as NonNullable<SessionQuery["executionMode"]>)} /></div>
          {invalidDates && <p className="session-filter-error" role="alert">{t("sessions.filter.invalidDates")}</p>}
          <div className="session-list-meta"><span>{debouncedGlobalQuery ? visibleGlobalSearch ? t("sessions.search.matchCount", { count: visibleGlobalSearch.total }) : t("sessions.search.history") : sessionList ? t("sessions.list.count", { count: sessionList.total }) : t("sessions.list.title")}</span>
            <SessionRefreshActions client={client === "all" ? undefined : client} disabled={refreshing || activeJob(sessionJob)} onRefresh={options => void refresh(options)} />
          </div>
          <SessionClientChecks client={client === "all" ? undefined : client} checks={status?.clientChecks} />
          {status?.stale && <Notice>{t("sessions.status.stale")}</Notice>}
          {(statusError || jobError) && <Notice danger action={statusError ? <button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button> : undefined}><SessionError error={statusError ?? jobError!} /></Notice>}
          {statusLoading && !status && <p className="muted" role="status">{t("sessions.status.loading")}</p>}
          <SessionRefreshStatus job={sessionJob} />
          {sessionJob?.status === "failed" && <Notice danger>{isMessageDescriptorKnown(sessionJob.errorDescriptor) ? messageText(sessionJob.errorDescriptor, sessionJob.error) : sessionJob.error ? <SessionError error={sessionJob.error} /> : t("sessions.refresh.failedRetained")}</Notice>}
          {listLoading && <p className="session-list-loading" role="status">{t("sessions.list.loading")}</p>}
          {listError && <Notice danger action={<button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={listError} /></Notice>}
          <div className="session-list" aria-label={t("sessions.list.results")}>
            {globalSearchError && <Notice danger><SessionError error={globalSearchError} /></Notice>}
            {globalSearchLoading && debouncedGlobalQuery && <p className="session-search-status" role="status">{t("sessions.search.loadingHistory")}</p>}
            {visibleGlobalSearch && debouncedGlobalQuery && <SearchHitList title={t("sessions.search.globalHits")} hits={visibleGlobalSearch.hits} total={visibleGlobalSearch.total} page={visibleGlobalSearch.page} pageSize={visibleGlobalSearch.pageSize} onPage={setGlobalSearchPage} onSelect={selectHit} />}
            {!debouncedGlobalQuery && sessionList?.sessions.map(session => <button key={session.id} className={`session-list-item${session.id === selectedSessionId ? " is-selected" : ""}`} aria-current={session.id === selectedSessionId ? "true" : undefined} onClick={() => selectSession(session)}>
              <ChatCircle size={17} aria-hidden="true" /><span className="session-list-copy"><strong title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</strong><SessionRelationship session={session} /><QuietTag session={session} /><small>{clientLabel(session.client)} · {shortProject(session.project)} · {dateLabel(session.updatedAt)}</small><small>{t("sessions.messageCount", { count: session.messageCount })} · {t("sessions.turnCount", { count: session.turnCount })}{session.models.length ? ` · ${new Intl.ListFormat(getLanguage(), { style: "short", type: "unit" }).format(session.models)}` : ""}</small></span><CaretRight size={15} aria-hidden="true" />
            </button>)}
            {!debouncedGlobalQuery && !listLoading && !listError && sessionList?.sessions.length === 0 && <div className="session-empty-list"><ChatCircle size={26} aria-hidden="true" /><strong>{status?.sessionCount || debouncedGlobalQuery || client !== "all" || project !== "all" || from || to ? t("sessions.list.emptyFiltered") : t("sessions.list.empty")}</strong>
              <p>{status?.sessionCount ? t("sessions.list.adjust") : t("sessions.list.indexPrompt")}</p>{!status?.sessionCount && <button className="button primary" disabled={refreshing || activeJob(sessionJob)} onClick={() => void refresh()}>{t("sessions.refresh.history")}</button>}
            </div>}
          </div>
          {!debouncedGlobalQuery && sessionList && sessionList.total > PAGE_SIZE && <Pager page={sessionList.page} pageSize={sessionList.pageSize} total={sessionList.total} onChange={setListPage} label={t("sessions.list.pagination")} />}
          {status?.gaps?.length ? <details className="session-index-gaps"><summary>{t("sessions.status.gapCount", { count: status.gaps.length })}</summary>{status.gaps.map((gap, index) => <SessionDiagnostic key={`${gap.kind}-${gap.sourceId ?? index}`} gap={gap} />)}</details> : null}
        </div>
      </aside>

      <main className="sessions-main" aria-label={t("sessions.reading.messages")}>
        <div className="session-main-controls">
          <div className="session-compact-actions"><button className="button subtle" aria-expanded={compactPanel === "list"} onClick={() => { setLeftCollapsed(false); setCompactPanel(value => value === "list" ? null : "list"); }}>{t("sessions.list.title")}</button><button className="button subtle" aria-expanded={compactPanel === "profile"} onClick={() => { setRightCollapsed(false); setCompactPanel(value => value === "profile" ? null : "profile"); }}>{t("sessions.reading.stats")}</button></div>
          {selectedSession?.parentSessionId && selectedSession.parentTitle && <button className="text-button session-parent-link" title={sessionParentTitle(selectedSession)} onClick={() => selectSession(selectedSession.parentSessionId!)}><CaretLeft size={13} />{t("sessions.reading.parent")}</button>}
          <div className="sessions-main-heading">
            <div><p className="eyebrow" title={selectedSession?.project}>{selectedSession ? <>{clientLabel(selectedSession.client)} · {shortProject(selectedSession.project)}{selectedSession.projectOrigin === "tool_path" && <span className="session-project-evidence">{t("sessions.reading.projectActivity")}</span>}{selectedSession.projectOrigin === "client_metadata" && <span className="session-project-evidence">{t("sessions.reading.projectMetadata")}</span>}</> : t("sessions.reading.allHistory")}</p>
              <h1 title={selectedSession ? sessionDisplayTitle(selectedSession) : undefined}>{selectedSession ? sessionDisplayTitle(selectedSession) : (selectedSessionId ? t("sessions.reading.loadingSession") : t("sessions.reading.selectHistory"))}</h1>
              {selectedSession && <p className="session-main-meta">{dateLabel(selectedSession.startedAt)} · {t("sessions.messageCount", { count: selectedSession.messageCount })} · {t("sessions.turnCount", { count: selectedSession.turnCount })}{selectedSession.relationship ? ` · ${selectedSession.relationship === "fork" ? t("sessions.relationship.fork") : t("sessions.relationship.childAgent")}` : ""}</p>}
              {selectedSession?.executionEntries?.length ? <p className="session-execution-meta" aria-label={t("sessions.reading.executionEntries")}>{t("sessions.reading.executionCount", { count: selectedSession.executionEntries.length })}{selectedSession.executionEntries.map(entry => <span className="session-badge session-quiet-tag" key={`${entry.entrypoint}:${entry.version ?? ""}`} title={t("sessions.execution.evidence", { entrypoint: entry.entrypoint, version: entry.version ?? t("common.notRecorded"), record: formatNumber(getLanguage(), entry.recordLine) })}>{executionEntryLabel(selectedSession.client, entry)}</span>)}</p> : null}
              {selectedSession?.relationship && <p className="session-main-meta">{t("sessions.title.originLabel", { origin: t(titleOrigins[selectedSession.titleOrigin]) })} · {selectedSession.parentTitle ? t("sessions.relationship.parent", { title: sessionParentTitle(selectedSession) }) : t("sessions.relationship.parentMissing")}</p>}
            </div><button className="button subtle session-map-button" onClick={() => onMap(undefined, selectedSession?.project)} disabled={!selectedSession?.project}><MapTrifold size={16} />{t("sessions.reading.map")}</button>
          </div>
          <div className="session-view-toolbar">
            <div className="session-mode-tabs" role="tablist" aria-label={t("sessions.reading.mode")}>{(["brief", "full", "trace"] as const).map(item => <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? "is-selected" : ""} onClick={() => changeMode(item)}>{t(modeLabels[item])}</button>)}</div>
            <HelpPopover label={t("sessions.reading.help")}><dl><div><dt>{t("sessions.reading.views")}</dt><dd>{t("sessions.reading.viewsHelp")}</dd></div>
              <div><dt>{t("sessions.reading.turnsBranches")}</dt><dd>{t("sessions.reading.turnsHelp", { count: TURN_PAGE_SIZE })}</dd></div></dl></HelpPopover>
            <label className="session-search-field local"><MagnifyingGlass size={15} aria-hidden="true" /><span className="sr-only">{t("sessions.search.localLabel")}</span><input value={localQuery} onChange={event => changeLocalQuery(event.target.value)} onFocus={() => localQuery && setShowLocalHits(true)} placeholder={t("sessions.search.localPlaceholder")} disabled={!selectedSessionId} />{localQuery && <button aria-label={t("sessions.search.clearLocal")} onClick={() => changeLocalQuery("")}>×</button>}</label>
          </div>
          {!!selectedSession?.branches?.length && <div className="session-branch-navigation"><FilterSelect label={t("sessions.branch.label")} value={branch ?? (mode === "brief" ? "current" : "all")} options={[{ value: "current", label: t("sessions.branch.current") }, { value: "all", label: t("sessions.branch.all") }, ...selectedSession.branches.map(item => ({ value: item.id, label: item.current ? t("sessions.branch.currentLabel", { label: messageText(item.labelDescriptor, item.label) }) : messageText(item.labelDescriptor, item.label) }))]} onChange={value => {
            setBranch(value); setFocusMessageId(undefined); setTraceSelection(undefined); setTurnPosition(undefined); setMessagePage(1); pageScroll.current = true;
            if (selectedSessionId) updateAddress(selectedSessionId, { mode, branch: value });
          }} /><small>{t("sessions.branch.stats")}</small></div>}
          {localQuery && <div className="session-local-navigation"><span>{localSearchLoading ? t("sessions.search.searching") : visibleLocalSearch ? t("sessions.search.position", { position: formatCount(localHitIndex < 0 ? 0 : (visibleLocalSearch.page - 1) * visibleLocalSearch.pageSize + localHitIndex + 1), count: visibleLocalSearch.total }) : t("sessions.search.waiting")}</span>
            <button className="icon-button" aria-label={t("sessions.search.previous")} disabled={!visibleLocalSearch?.hits.length || visibleLocalSearch.page === 1 && localHitIndex <= 0} onClick={() => moveLocalHit(-1)}><CaretLeft size={14} /></button>
            <button className="icon-button" aria-label={t("sessions.search.next")} disabled={!visibleLocalSearch?.hits.length || (localHitIndex + 1 >= visibleLocalSearch.hits.length && visibleLocalSearch.page * visibleLocalSearch.pageSize >= visibleLocalSearch.total)} onClick={() => moveLocalHit(1)}><CaretRight size={14} /></button>
            <button className="text-button" onClick={() => setShowLocalHits(value => !value)}>{showLocalHits ? t("sessions.search.collapse") : t("sessions.search.show")}</button>
          </div>}
          {showLocalHits && localQuery && <div className="session-local-results">{localSearchError && <Notice danger><SessionError error={localSearchError} /></Notice>}{visibleLocalSearch && debouncedLocalQuery && <SearchHitList title={t("sessions.search.localHits")} hits={visibleLocalSearch.hits} total={visibleLocalSearch.total} page={visibleLocalSearch.page} pageSize={visibleLocalSearch.pageSize} onPage={setLocalSearchPage} onSelect={hit => { setLocalHitIndex(visibleLocalSearch.hits.indexOf(hit)); selectHit(hit); }} />}</div>}
          {selectedMessageData && <nav className="session-turn-navigation" aria-label={t("sessions.turn.navigation")}>
            <button className="text-button" disabled={!selectedMessageData.totalTurns || currentTurn === 1} onClick={() => jumpTurn(1)}>{t("sessions.turn.first")}</button>
            <button className="icon-button" aria-label={t("sessions.turn.previous")} disabled={currentTurn <= 1} onClick={() => jumpTurn(currentTurn - 1)}><CaretLeft size={14} /></button>
            <form onSubmit={event => { event.preventDefault(); if (turnInput) jumpTurn(Number(turnInput)); }}><label><span className="sr-only">{t("sessions.turn.jumpInput")}</span><input id="session-turn-jump" aria-label={t("sessions.turn.jumpInput")} type="number" min="1" max={selectedMessageData.totalTurns || 1} value={turnInput === "0" ? "" : turnInput} placeholder={t("sessions.kind.context")} onChange={event => setTurnInput(event.target.value)} /><span>{t("sessions.turn.ofTotal", { count: selectedMessageData.totalTurns ?? 0 })}</span></label><button className="text-button" type="submit">{t("sessions.turn.jump")}</button></form>
            <button className="icon-button" aria-label={t("sessions.turn.next")} disabled={currentTurn >= (selectedMessageData.totalTurns ?? 0)} onClick={() => jumpTurn(currentTurn + 1)}><CaretRight size={14} /></button>
            <button className="text-button" disabled={currentTurn >= (selectedMessageData.totalTurns ?? 0)} onClick={() => jumpTurn(selectedMessageData.totalTurns!)}>{t("sessions.turn.last")}</button>
            <span className="session-turn-range">{currentTurn === 0 ? t("sessions.turn.initial") : t("sessions.turn.perPage", { count: TURN_PAGE_SIZE })}</span>
          </nav>}
        </div>
        <div ref={readingPane} className={`session-message-scroll${mode === "trace" ? " is-trace" : ""}`} aria-label={t("sessions.reading.area")} onScroll={() => {
          if (mode === "trace") return;
          const pane = readingPane.current; if (!pane || !selectedMessageData?.turns) return;
          const top = pane.getBoundingClientRect().top;
          const visible = [...pane.querySelectorAll<HTMLElement>(".session-turn")].filter(node => node.getBoundingClientRect().top <= top + 30).at(-1);
          const preferred = focusMessageId ? document.getElementById(`session-message-${focusMessageId}`)
            : document.getElementById(`session-turn-${selectedMessageData.turns.find(turn => turn.position === turnPosition)?.id}`);
          const preferredVisible = preferred && preferred.getBoundingClientRect().bottom > top && preferred.getBoundingClientRect().top < pane.getBoundingClientRect().bottom;
          const preferredTurn = focusMessageId ? selectedMessageData.messages.find(message => message.id === focusMessageId)?.turnId || "unknown" : selectedMessageData.turns.find(turn => turn.position === turnPosition)?.id;
          const item = selectedMessageData.turns.find(turn => preferredVisible ? turn.id === preferredTurn : visible?.id === `session-turn-${turn.id}`) ?? selectedMessageData.turns[0];
          if (item) { setCurrentTurn(item.position); if (document.activeElement?.id !== "session-turn-jump") setTurnInput(String(item.position)); }
        }}>
          {status?.stale && <Notice>{t("sessions.status.previous")}</Notice>}
          {selectedSessionId ? <>
            {messageError && <Notice danger action={<button className="text-button" onClick={() => setMessageRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={messageError} /></Notice>}
            {messageLoading && <p className="session-message-loading" role="status">{t("sessions.reading.loadingMessages", { mode: t(modeLabels[mode]) })}</p>}
            {mode === "trace" && profile?.sessionIds[0] === selectedSessionId && profile.children.length > 0 && <details className="session-trace-children">
              <summary>{t("sessions.reading.childrenCount", { count: profile.children.length })}</summary>
              {profile.children.map(child => <button className="session-child" key={child.id} onClick={() => selectSession(child)}><strong>{sessionDisplayTitle(child)}</strong></button>)}
            </details>}
            {selectedMessageData && <>
              {!selectedMessageData.messages.length && !messageLoading ? <div className="session-message-empty">
                <h2>{mode === "brief" && selectedMessageData.session.messageCount > 0 ? t("sessions.reading.emptyBrief") : t("sessions.reading.empty")}</h2>
                <p className="muted">{mode === "brief" && selectedMessageData.session.messageCount > 0
                  ? t("sessions.reading.emptyBriefHelp")
                  : t("sessions.reading.emptyHelp")}</p>
                {mode === "brief" && selectedMessageData.session.messageCount > 0 && <button className="text-button" onClick={() => changeMode("full")}>{t("sessions.reading.viewFull")}</button>}
              </div> : <>
                {mode === "trace" ? <SessionTrace key={selectedMessageData.session.id} messages={selectedMessageData.messages} steps={profile?.steps ?? []} focusMessageId={focusMessageId} focusRequest={traceFocusRequest} focusTurnId={selectedMessageData.turns?.find(turn => turn.position === turnPosition)?.id}
                  timeline={timeline?.sessionId === selectedMessageData.session.id ? timeline.data.events : []} timelineLoading={timelineLoading} timelineError={timelineError} onRetryTimeline={() => setTimelineRetry(value => value + 1)} onTimelineSelect={event => focusStep({ id: event.id, sessionId: event.sessionId, messageId: event.id })}
                  project={selectedMessageData.session.project} onMap={onMap} onInspect={inspectTrace} onViewTurn={trackTraceTurn} /> :
                  <div className="session-turns">{turns.map((turn, index) => <TurnTimeline key={turn.id} turn={turn} position={index + 1} mode={mode} focusMessageId={focusMessageId} project={selectedMessageData.session.project}
                    onMap={onMap} expanded={expandedTurns.has(turn.id)} onToggle={open => toggleTurn(turn.id, open)} />)}</div>}
              </>}
            </>}
            {currentMessage && <span className="sr-only" aria-live="polite">{t("sessions.reading.located", { kind: t(kindLabels[currentMessage.kind]) })}</span>}
          </> : <div className="session-message-empty"><ChatCircle size={30} aria-hidden="true" /><h2>{t("sessions.reading.select")}</h2><p className="muted">{t("sessions.reading.selectHelp")}</p></div>}
        </div>
        {selectedMessageData && <div className="session-reading-footer"><span>{t("sessions.recordCount", { count: selectedMessageData.messages.length })} · {t("sessions.reading.pageTurns", { count: selectedMessageData.turns?.filter(turn => turn.position > 0).length ?? 0 })}</span><Pager page={selectedMessageData.page} pageSize={selectedMessageData.pageSize} total={selectedMessageData.totalTurns ?? 0} onChange={changeMessagePage} label={t("sessions.turn.pagination")} /></div>}
      </main>

      <SessionProfilePane profile={profile} loading={profileLoading} error={profileError} includeChildren={includeChildren} setIncludeChildren={setIncludeChildren}
        collapsed={rightCollapsed} setCollapsed={value => { setRightCollapsed(value); setCompactPanel(null); }}
        onRetry={() => setProfileRetry(value => value + 1)} onSelectChild={selectSession} onFocusStep={focusStep} onFind={findEvidence} />
    </ResizableWorkspace>
  </div>;
}
