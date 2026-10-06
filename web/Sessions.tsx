import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, CaretDown, CaretLeft, CaretRight, ChatCircle, MagnifyingGlass, MapTrifold } from "@phosphor-icons/react";
import type { Client } from "../src/clients";
import { CLIENTS, clientName } from "../src/clients";
import type { MessageKind, SessionIndexStatus, SessionJob, SessionListResult, SessionMessage, SessionMessageResult, SessionProfile, SessionSearchHit, SessionSearchResult, SessionSummary, SessionTimelineResult } from "../src/session-contracts";
import { ApiError, errorMessage, isAborted, request } from "./api";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { groupedTurns, localDateBoundary, PAGE_SIZE, TURN_PAGE_SIZE, type EvidenceTarget, searchHitMode, searchKinds, sessionParams, turnTitle, workspaceSessionSemantics } from "./session-model";
import { MessageCard, kindLabels } from "./SessionMessage";
import { SessionTrace } from "./SessionTrace";
import { Notice, Pager } from "./SessionControls";
import { SessionProfilePane } from "./SessionProfile";
import { FilterSelect } from "./FilterSelect";
import { ProjectPicker } from "./ProjectPicker";
import { DatePicker } from "./DatePicker";
import "./session.css";

type Mode = "brief" | "full" | "trace";
type Target = { sessionId: string; messageId?: string; mode?: Mode; page?: number; turnPosition?: number };
type ReadingPosition = { mode: Mode; page: number; focus?: string; position?: number; scroll: number; expanded: string[] };

const modeLabels: Record<Mode, string> = { brief: "简易", full: "完整", trace: "轨迹" };
const activeJob = (job?: SessionJob) => job?.status === "queued" || job?.status === "running";
const formatCount = (value: number) => value.toLocaleString("zh-CN");
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未记录";
const shortProject = (value?: string) => value ? value.split(/[\\/]/).filter(Boolean).at(-1) ?? value : "无项目";
const titleOrigins: Record<SessionSummary["titleOrigin"], string> = { recorded: "记录标题", first_user: "首条有效请求", task: "任务路径名称", agent: "Agent 名称", fallback: "后备编号" };

function SessionRelationship({ session }: { session: SessionSummary }) {
  if (!session.relationship) return null;
  return <small className="session-relationship" title={session.parentTitle ? `父会话：${session.parentTitle}` : "父会话不可用或关系尚未确认"}>
    <span className="session-badge">{session.relationship === "fork" ? "分叉" : "子会话"}</span>
    <span>{session.parentTitle ? `属于 ${session.parentTitle}` : "父关系未确认"}</span>
  </small>;
}

function SearchHitList({ hits, total, page, pageSize, onPage, onSelect, title }: {
  hits: SessionSearchHit[]; total: number; page: number; pageSize: number; onPage: (page: number) => void; onSelect: (hit: SessionSearchHit) => void; title: string;
}) {
  return <section className="session-hits" aria-label={title}>
    <div className="session-section-heading"><h3>{title}</h3><span>{formatCount(total)} 条命中</span></div>
    {hits.map((hit, index) => <button className="session-hit" key={`${hit.session.id}-${hit.messageId ?? hit.kind}-${index}`} onClick={() => onSelect(hit)}>
      <span className="session-hit-kind">{hit.kind === "title" ? "标题" : kindLabels[hit.kind]}</span>
      <strong>{hit.session.title}</strong>
      <SessionRelationship session={hit.session} />
      <small>{clientName(hit.session.client)} · {shortProject(hit.session.project)} · {dateLabel(hit.session.updatedAt)}</small>
      <span className="session-hit-snippet">{hit.snippet}</span>
    </button>)}
    {!hits.length && <p className="muted small">没有找到匹配记录。</p>}
    {total > pageSize && <Pager page={page} pageSize={pageSize} total={total} onChange={onPage} label={`${title}分页`} />}
  </section>;
}

function TurnTimeline({ turn, position, mode, focusMessageId, project, onMap, expanded, onToggle }: {
  turn: { id: string; messages: SessionMessage[] }; position: number; mode: Mode; focusMessageId?: string; project?: string; onMap: (path?: string, project?: string) => void;
  expanded: boolean; onToggle: (open: boolean) => void;
}) {
  const title = turnTitle(turn.id, position);
  const userMessage = turn.messages.find(message => message.kind === "user");
  const answer = [...turn.messages].reverse().find(message => message.kind === "assistant" && message.final);
  return <details id={`session-turn-${turn.id}`} className="session-turn" open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary><CaretDown size={15} aria-hidden="true" /><span>{title}</span><small>{turn.messages.length} 条记录</small>
      <span className="session-turn-summary">{userMessage?.text ?? answer?.text ?? "展开查看本轮记录"}</span></summary>
    {expanded && <div className="session-turn-events">
      {turn.messages.map(message => <MessageCard key={message.id} message={message} mode={mode} focused={focusMessageId === message.id} project={project} onMap={onMap} />)}
    </div>}
  </details>;
}

export default function Sessions({ active, target, onMap }: { active: boolean; target?: Target; onMap: (path?: string, project?: string) => void }) {
  const [status, setStatus] = useState<SessionIndexStatus | null>(null);
  const [statusReload, setStatusReload] = useState(-1);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sessionJob, setSessionJob] = useState<SessionJob | undefined>();
  const [jobError, setJobError] = useState<string | null>(null);
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
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedSummary, setSelectedSummary] = useState<SessionSummary>();
  const [mode, setMode] = useState<Mode>("brief");
  const [messagePage, setMessagePage] = useState(1);
  const [focusMessageId, setFocusMessageId] = useState<string>();
  const [traceSelection, setTraceSelection] = useState<string>();
  const [traceFocusRequest, setTraceFocusRequest] = useState(0);
  const [timeline, setTimeline] = useState<{ sessionId: string; data: SessionTimelineResult }>();
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string>();
  const [timelineRetry, setTimelineRetry] = useState(0);
  const [messageData, setMessageData] = useState<SessionMessageResult | null>(null);
  const [messageDataKey, setMessageDataKey] = useState("");
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [globalSearchPage, setGlobalSearchPage] = useState(1);
  const [globalSearch, setGlobalSearch] = useState<SessionSearchResult | null>(null);
  const [globalSearchKey, setGlobalSearchKey] = useState("");
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [debouncedLocalQuery, setDebouncedLocalQuery] = useState("");
  const [localSearch, setLocalSearch] = useState<SessionSearchResult | null>(null);
  const [localSearchKey, setLocalSearchKey] = useState("");
  const [localSearchLoading, setLocalSearchLoading] = useState(false);
  const [localSearchError, setLocalSearchError] = useState<string | null>(null);
  const [localSearchPage, setLocalSearchPage] = useState(1);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
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
  useEffect(() => { setListPage(1); setGlobalSearchPage(1); }, [client, project, from, to, debouncedGlobalQuery, includeProcess, includeSubagents]);
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
      .catch(error => { if (!isAborted(error)) { setStatusError(errorMessage(error)); setStatusReload(reload); } })
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
  }), [client, project, from, to, debouncedGlobalQuery, queryKinds, listPage, status?.version, includeSubagents]);

  const searchOnly = !!debouncedGlobalQuery && !!selectedSessionId;
  useEffect(() => {
    if (searchOnly) { setListLoading(false); setListError(null); return; }
    if (!active || !indexReady || invalidDates) return;
    const controller = new AbortController();
    setListLoading(true);
    setListError(null);
    void request<SessionListResult>(`/sessions${listQuery}`, { signal: controller.signal })
      .then(result => setSessionList(result))
      .catch(error => { if (!isAborted(error)) setListError(errorMessage(error)); })
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
  }), [client, project, from, to, debouncedGlobalQuery, includeProcess, globalSearchPage, status?.version]);

  useEffect(() => {
    if (!active || !indexReady || !debouncedGlobalQuery || invalidDates) { setGlobalSearch(null); setGlobalSearchError(null); return; }
    const controller = new AbortController();
    setGlobalSearchLoading(true);
    setGlobalSearchError(null);
    void request<SessionSearchResult>(`/sessions/search${globalSearchQuery}`, { signal: controller.signal })
      .then(result => { setGlobalSearch(result); setGlobalSearchKey(globalSearchQuery); })
      .catch(error => { if (!isAborted(error)) setGlobalSearchError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setGlobalSearchLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, debouncedGlobalQuery, globalSearchQuery, invalidDates, reload]);

  const messageQuery = useMemo(() => sessionParams({
    version: status?.version,
    page: focusMessageId ? undefined : messagePage,
    pageSize: TURN_PAGE_SIZE,
    pageUnit: "turn",
    turnPosition,
    mode,
    messageId: focusMessageId,
  }), [status?.version, focusMessageId, messagePage, mode, turnPosition]);
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
      .catch(error => { if (!isAborted(error)) setMessageError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setMessageLoading(false); });
    return () => controller.abort();
  }, [active, indexReady, selectedSessionId, messageQuery, focusMessageId, reload, messageRetry]);

  useEffect(() => {
    if (!active || !indexReady || !selectedSessionId || mode !== "trace") return;
    const controller = new AbortController();
    setTimelineLoading(true); setTimelineError(undefined);
    void request<SessionTimelineResult>(`/sessions/${encodeURIComponent(selectedSessionId)}/timeline${sessionParams({ version: status?.version })}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTimeline({ sessionId: selectedSessionId, data }); })
      .catch(error => { if (!isAborted(error)) setTimelineError(errorMessage(error)); })
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
      .catch(error => { if (!isAborted(error)) setLocalSearchError(errorMessage(error)); })
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
      .catch(error => { if (!isAborted(error)) setProfileError(errorMessage(error)); })
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
      } catch (error) { if (!isAborted(error) && !controller.signal.aborted) setJobError(errorMessage(error)); }
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

  const captureReading = (): ReadingPosition => ({ mode, page: selectedMessageData?.page ?? messagePage, focus: mode === "trace" ? traceSelection ?? focusMessageId : focusMessageId, position: turnPosition,
    scroll: readingPane.current?.scrollTop ?? 0, expanded: [...expandedTurns] });
  const rememberReading = () => { if (selectedSessionId) readingPositions.current.set(selectedSessionId, captureReading()); };
  const updateAddress = (id: string, state: Partial<ReadingPosition> = {}, replace = false) => {
    const params = new URLSearchParams({ id, mode: state.mode ?? mode });
    if (state.focus) params.set("message", state.focus);
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
    setMode(saved?.mode ?? "brief"); setExpandedTurns(new Set(saved?.expanded));
    restoreScroll.current = saved?.scroll; readyScrollRestore.current = false; pageScroll.current = !saved;
    setLocalQuery(""); searchBookmark.current = undefined; setShowLocalHits(false); setCompactPanel(null);
    updateAddress(id, saved ?? { mode: "brief" });
  };
  const selectHit = (hit: SessionSearchHit) => {
    setTraceFocusRequest(value => value + 1);
    evidenceRequest.current?.abort();
    if (hit.session.id !== selectedSessionId) { rememberReading(); searchBookmark.current = undefined; setLocalQuery(""); }
    setSelectedSessionId(hit.session.id); setSelectedSummary(hit.session); setFocusMessageId(hit.messageId);
    setMessagePage(1); setTurnPosition(undefined); pageScroll.current = true; restoreScroll.current = undefined;
    if (hit.messageId) setExpandedTurns(new Set([hit.turnId || "unknown"]));
    const next = searchHitMode(hit, mode); setMode(next); setShowLocalHits(false); setCompactPanel(null);
    updateAddress(hit.session.id, { mode: next, focus: hit.messageId });
  };
  const focusStep = (step: SessionProfile["steps"][number]) => {
    if (!step.messageId) return;
    setTraceFocusRequest(value => value + 1);
    if (step.sessionId !== selectedSessionId) { rememberReading(); setSelectedSessionId(step.sessionId); setSelectedSummary(undefined); setLocalQuery(""); }
    setFocusMessageId(step.messageId); setMessagePage(1); setTurnPosition(undefined); setMode("trace"); setCompactPanel(null);
    setExpandedTurns(new Set([selectedMessageData?.messages.find(message => message.id === step.messageId)?.turnId || "unknown"]));
    pageScroll.current = true; restoreScroll.current = undefined;
    updateAddress(step.sessionId, { mode: "trace", focus: step.messageId });
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
      setMessageError("当前索引范围中没有可定位的调用证据，请刷新后重试。");
    } catch (error) { if (!isAborted(error)) setMessageError(errorMessage(error)); }
  };
  const inspectTrace = (message: SessionMessage) => {
    setTraceSelection(message.id);
    trackTraceTurn(message.turnId || "unknown");
    updateAddress(message.sessionId, { mode: "trace", focus: message.id });
  };
  const trackTraceTurn = (id: string) => {
    const turn = selectedMessageData?.turns?.find(turn => turn.id === id);
    if (turn) { setCurrentTurn(turn.position); if (document.activeElement?.getAttribute("aria-label") !== "跳转轮次") setTurnInput(String(turn.position)); }
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
    const candidate = current && (next !== "brief" || current.kind === "user" || current.final) ? current
      : selectedMessageData?.messages.find(message => (!activeTurn || (message.turnId || "unknown") === activeTurn) && (next !== "brief" || message.kind === "user" || message.final));
    setMode(next); setFocusMessageId(candidate?.id); setTurnPosition(undefined); setExpandedTurns(new Set()); pageScroll.current = true;
    if (selectedSessionId) updateAddress(selectedSessionId, { mode: next, focus: candidate?.id, page: candidate ? undefined : messagePage });
  };
  const changeLocalQuery = (value: string) => {
    pendingHit.current = undefined;
    if (value && !localQuery) searchBookmark.current = captureReading();
    setLocalQuery(value); setLocalHitIndex(-1); setShowLocalHits(!!value);
    if (!value && searchBookmark.current) {
      const saved = searchBookmark.current; setMode(saved.mode); setMessagePage(saved.page); setTurnPosition(saved.position);
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
  const refresh = async () => {
    setRefreshing(true);
    setJobError(null);
    try {
      const result = await request<{ job: SessionJob }>("/sessions/refresh", { method: "POST" });
      setSessionJob(result.job);
    } catch (error) { setJobError(errorMessage(error)); }
    finally { setRefreshing(false); }
  };
  const submitRefresh = (event: FormEvent) => { event.preventDefault(); void refresh(); };

  useEffect(() => {
    if (active && selectedSessionId && !new URLSearchParams(location.hash.split("?")[1]).get("id")) updateAddress(selectedSessionId, { mode }, true);
  }, [active, selectedSessionId]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setCompactPanel(null); setShowLocalHits(false); } };
    if (active) document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [active]);
  return <div className="sessions-shell" data-compact-panel={compactPanel ?? ""} hidden={!active}>
    {compactPanel && <button className="session-mobile-backdrop" aria-label="返回对话" onClick={() => setCompactPanel(null)} /> }
    <ResizableWorkspace sidebarCollapsed={leftCollapsed} detailsCollapsed={rightCollapsed} semantics={workspaceSessionSemantics()}>
      <aside className={`sidebar session-sidebar${leftCollapsed ? " panel-collapsed" : ""}`} aria-label="会话列表">
        <div className="pane-heading"><span>会话库</span><button className="icon-button panel-toggle" aria-label={leftCollapsed ? "展开会话列表" : "收起会话列表"} aria-expanded={!leftCollapsed} aria-controls="session-list-content" onClick={() => { setLeftCollapsed(value => !value); setCompactPanel(null); }}>{leftCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button></div>
        <div id="session-list-content" className="sidebar-content" hidden={leftCollapsed}>
          <label className="session-search-field"><MagnifyingGlass size={16} aria-hidden="true" /><span className="sr-only">搜索会话标题和消息</span><input value={globalQuery} onChange={event => setGlobalQuery(event.target.value)} placeholder="搜索标题或消息" />{globalQuery && <button type="button" aria-label="清除搜索" onClick={() => setGlobalQuery("")}>×</button>}</label>
          <label className="session-process-toggle"><input type="checkbox" checked={includeProcess} onChange={event => setIncludeProcess(event.target.checked)} /><span>搜索过程记录</span><small>思考、工具、系统与压缩</small></label>
          <label className="session-process-toggle"><input type="checkbox" aria-label="显示子 Agent 会话" checked={includeSubagents} onChange={event => setIncludeSubagents(event.target.checked)} /><span>显示子 Agent 会话</span><small>仅影响列表，搜索始终包含子会话</small></label>
          <div className="session-filters">
            <FilterSelect label="筛选客户端" value={client} options={[{ value: "all", label: "全部客户端" }, ...CLIENTS.map(item => ({ value: item.id, label: item.name }))]} onChange={value => setClient(value as Client | "all")} />
            <ProjectPicker value={project} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" },
              ...(status?.projects.map(path => ({ value: path, label: shortProject(path), description: path })) ?? [])]} onChange={setProject} />
          </div>
          <div className="session-date-filters"><div><span>从</span><DatePicker label="起始日期" value={from} onChange={setFrom} /></div><div><span>到</span><DatePicker label="截止日期" value={to} onChange={setTo} /></div></div>
          {invalidDates && <p className="session-filter-error" role="alert">起始日期不能晚于截止日期。</p>}
          <div className="session-list-meta"><span>{debouncedGlobalQuery ? visibleGlobalSearch ? `${formatCount(visibleGlobalSearch.total)} 条命中` : "搜索历史" : sessionList ? `${formatCount(sessionList.total)} 个会话` : "会话列表"}</span>
            <button className="icon-button" aria-label="刷新会话索引" title="刷新会话索引" disabled={refreshing || activeJob(sessionJob)} onClick={submitRefresh}><ArrowClockwise size={16} className={refreshing || activeJob(sessionJob) ? "is-spinning" : ""} /></button>
          </div>
          {status?.stale && <Notice>当前索引已过期，保留上一版可用结果；刷新完成后切换到新版本。</Notice>}
          {(statusError || jobError) && <Notice danger action={statusError ? <button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button> : undefined}>{statusError ?? jobError}</Notice>}
          {statusLoading && !status && <p className="muted" role="status">正在读取索引状态…</p>}
          {(sessionJob && activeJob(sessionJob)) && <div className="session-job" role="status"><span>{sessionJob.phase || "正在刷新会话"}</span><progress max="1" value={sessionJob.progress} /><small>{Math.round(sessionJob.progress * 100)}%</small></div>}
          {sessionJob?.status === "failed" && <Notice danger>{sessionJob.error ?? "会话刷新失败；上次成功索引仍可查看。"}</Notice>}
          {listLoading && <p className="session-list-loading" role="status">正在读取会话…</p>}
          {listError && <Notice danger action={<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button>}>{listError}</Notice>}
          <div className="session-list" aria-label="会话结果">
            {globalSearchError && <Notice danger>{globalSearchError}</Notice>}
            {globalSearchLoading && debouncedGlobalQuery && <p className="session-search-status" role="status">正在搜索历史…</p>}
            {visibleGlobalSearch && debouncedGlobalQuery && <SearchHitList title="全局搜索命中" hits={visibleGlobalSearch.hits} total={visibleGlobalSearch.total} page={visibleGlobalSearch.page} pageSize={visibleGlobalSearch.pageSize} onPage={setGlobalSearchPage} onSelect={selectHit} />}
            {!debouncedGlobalQuery && sessionList?.sessions.map(session => <button key={session.id} className={`session-list-item${session.id === selectedSessionId ? " is-selected" : ""}`} aria-current={session.id === selectedSessionId ? "true" : undefined} onClick={() => selectSession(session)}>
              <ChatCircle size={17} aria-hidden="true" /><span className="session-list-copy"><strong title={session.title}>{session.title}</strong><SessionRelationship session={session} /><small>{clientName(session.client)} · {shortProject(session.project)} · {dateLabel(session.updatedAt)}</small><small>{formatCount(session.messageCount)} 条消息 · {formatCount(session.turnCount)} 轮{session.models.length ? ` · ${session.models.join("、")}` : ""}</small></span><CaretRight size={15} aria-hidden="true" />
            </button>)}
            {!debouncedGlobalQuery && !listLoading && !listError && sessionList?.sessions.length === 0 && <div className="session-empty-list"><ChatCircle size={26} aria-hidden="true" /><strong>{debouncedGlobalQuery || client !== "all" || project !== "all" || from || to ? "没有匹配的会话" : "还没有会话记录"}</strong>
              <p>{status?.sessionCount ? "调整筛选或搜索条件。" : "刷新本机可发现的会话来源以建立索引。"}</p>{!status?.sessionCount && <button className="button primary" disabled={refreshing || activeJob(sessionJob)} onClick={() => void refresh()}>刷新历史</button>}
            </div>}
          </div>
          {!debouncedGlobalQuery && sessionList && sessionList.total > PAGE_SIZE && <Pager page={sessionList.page} pageSize={sessionList.pageSize} total={sessionList.total} onChange={setListPage} label="会话列表分页" />}
          {status?.gaps?.length ? <details className="session-index-gaps"><summary>索引缺口 · {status.gaps.length}</summary>{status.gaps.map((gap, index) => <p key={`${gap.kind}-${gap.sourceId ?? index}`}>{gap.message}</p>)}</details> : null}
        </div>
      </aside>

      <main className="sessions-main" aria-label="会话消息">
        <div className="session-main-controls">
          <div className="session-compact-actions"><button className="button subtle" aria-expanded={compactPanel === "list"} onClick={() => { setLeftCollapsed(false); setCompactPanel(value => value === "list" ? null : "list"); }}>会话列表</button><button className="button subtle" aria-expanded={compactPanel === "profile"} onClick={() => { setRightCollapsed(false); setCompactPanel(value => value === "profile" ? null : "profile"); }}>会话统计</button></div>
          {selectedSession?.parentSessionId && selectedSession.parentTitle && <button className="text-button session-parent-link" title={selectedSession.parentTitle} onClick={() => selectSession(selectedSession.parentSessionId!)}><CaretLeft size={13} />返回父会话</button>}
          <div className="sessions-main-heading">
            <div><p className="eyebrow" title={selectedSession?.project}>{selectedSession ? <>{clientName(selectedSession.client)} · {shortProject(selectedSession.project)}{selectedSession.projectOrigin === "tool_path" && <span className="session-project-evidence">文件活动关联</span>}{selectedSession.projectOrigin === "client_metadata" && <span className="session-project-evidence">客户端项目元数据</span>}</> : "全部本机历史"}</p>
              <h1 title={selectedSession?.title}>{selectedSession?.title ?? (selectedSessionId ? "正在加载会话…" : "选择会话查看历史")}</h1>
              {selectedSession && <p className="session-main-meta">{dateLabel(selectedSession.startedAt)} · {formatCount(selectedSession.messageCount)} 条消息 · {formatCount(selectedSession.turnCount)} 轮{selectedSession.relationship ? ` · ${selectedSession.relationship === "fork" ? "分叉会话" : "子会话"}` : ""}</p>}
              {selectedSession?.relationship && <p className="session-main-meta">标题来源：{titleOrigins[selectedSession.titleOrigin]} · {selectedSession.parentTitle ? `父会话：${selectedSession.parentTitle}` : "父会话不可用或关系尚未确认"}</p>}
            </div><button className="button subtle session-map-button" onClick={() => onMap(undefined, selectedSession?.project)} disabled={!selectedSession?.project}><MapTrifold size={16} />查看代码地图</button>
          </div>
          <div className="session-view-toolbar">
            <div className="session-mode-tabs" role="tablist" aria-label="消息查看方式">{(["brief", "full", "trace"] as const).map(item => <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? "is-selected" : ""} onClick={() => changeMode(item)}>{modeLabels[item]}</button>)}</div>
            <label className="session-search-field local"><MagnifyingGlass size={15} aria-hidden="true" /><span className="sr-only">在当前会话搜索</span><input value={localQuery} onChange={event => changeLocalQuery(event.target.value)} onFocus={() => localQuery && setShowLocalHits(true)} placeholder="会话内搜索" disabled={!selectedSessionId} />{localQuery && <button aria-label="清除会话内搜索" onClick={() => changeLocalQuery("")}>×</button>}</label>
          </div>
          {localQuery && <div className="session-local-navigation"><span>{localSearchLoading ? "搜索中…" : visibleLocalSearch ? `${localHitIndex < 0 ? 0 : (visibleLocalSearch.page - 1) * visibleLocalSearch.pageSize + localHitIndex + 1} / ${formatCount(visibleLocalSearch.total)} 条命中` : "等待搜索"}</span>
            <button className="icon-button" aria-label="上一个搜索命中" disabled={!visibleLocalSearch?.hits.length || visibleLocalSearch.page === 1 && localHitIndex <= 0} onClick={() => moveLocalHit(-1)}><CaretLeft size={14} /></button>
            <button className="icon-button" aria-label="下一个搜索命中" disabled={!visibleLocalSearch?.hits.length || (localHitIndex + 1 >= visibleLocalSearch.hits.length && visibleLocalSearch.page * visibleLocalSearch.pageSize >= visibleLocalSearch.total)} onClick={() => moveLocalHit(1)}><CaretRight size={14} /></button>
            <button className="text-button" onClick={() => setShowLocalHits(value => !value)}>{showLocalHits ? "收起结果" : "查看结果"}</button>
          </div>}
          {showLocalHits && localQuery && <div className="session-local-results">{localSearchError && <Notice danger>{localSearchError}</Notice>}{visibleLocalSearch && debouncedLocalQuery && <SearchHitList title="当前会话命中" hits={visibleLocalSearch.hits} total={visibleLocalSearch.total} page={visibleLocalSearch.page} pageSize={visibleLocalSearch.pageSize} onPage={setLocalSearchPage} onSelect={hit => { setLocalHitIndex(visibleLocalSearch.hits.indexOf(hit)); selectHit(hit); }} />}</div>}
          {selectedMessageData && <nav className="session-turn-navigation" aria-label="轮次导航">
            <button className="text-button" disabled={!selectedMessageData.totalTurns || currentTurn === 1} onClick={() => jumpTurn(1)}>首轮</button>
            <button className="icon-button" aria-label="上一轮" disabled={currentTurn <= 1} onClick={() => jumpTurn(currentTurn - 1)}><CaretLeft size={14} /></button>
            <form onSubmit={event => { event.preventDefault(); if (turnInput) jumpTurn(Number(turnInput)); }}><label>第<input aria-label="跳转轮次" type="number" min="1" max={selectedMessageData.totalTurns || 1} value={turnInput === "0" ? "" : turnInput} placeholder="上下文" onChange={event => setTurnInput(event.target.value)} /> 轮 / 共 {formatCount(selectedMessageData.totalTurns ?? 0)} 轮</label><button className="text-button" type="submit">跳转</button></form>
            <button className="icon-button" aria-label="下一轮" disabled={currentTurn >= (selectedMessageData.totalTurns ?? 0)} onClick={() => jumpTurn(currentTurn + 1)}><CaretRight size={14} /></button>
            <button className="text-button" disabled={currentTurn >= (selectedMessageData.totalTurns ?? 0)} onClick={() => jumpTurn(selectedMessageData.totalTurns!)}>末轮</button>
            <span className="session-turn-range">{currentTurn === 0 ? "正在查看初始上下文" : `每页 ${TURN_PAGE_SIZE} 轮 · 上下文不计入轮次`}</span>
          </nav>}
        </div>
        <div ref={readingPane} className={`session-message-scroll${mode === "trace" ? " is-trace" : ""}`} aria-label="对话阅读区" onScroll={() => {
          if (mode === "trace") return;
          const pane = readingPane.current; if (!pane || !selectedMessageData?.turns) return;
          const top = pane.getBoundingClientRect().top;
          const visible = [...pane.querySelectorAll<HTMLElement>(".session-turn")].filter(node => node.getBoundingClientRect().top <= top + 30).at(-1);
          const preferred = focusMessageId ? document.getElementById(`session-message-${focusMessageId}`)
            : document.getElementById(`session-turn-${selectedMessageData.turns.find(turn => turn.position === turnPosition)?.id}`);
          const preferredVisible = preferred && preferred.getBoundingClientRect().bottom > top && preferred.getBoundingClientRect().top < pane.getBoundingClientRect().bottom;
          const preferredTurn = focusMessageId ? selectedMessageData.messages.find(message => message.id === focusMessageId)?.turnId || "unknown" : selectedMessageData.turns.find(turn => turn.position === turnPosition)?.id;
          const item = selectedMessageData.turns.find(turn => preferredVisible ? turn.id === preferredTurn : visible?.id === `session-turn-${turn.id}`) ?? selectedMessageData.turns[0];
          if (item) { setCurrentTurn(item.position); if (document.activeElement?.getAttribute("aria-label") !== "跳转轮次") setTurnInput(String(item.position)); }
        }}>
          {status?.stale && <Notice>显示上次成功的索引结果；来源变更尚未完成刷新。</Notice>}
          {selectedSessionId ? <>
            {messageError && <Notice danger action={<button className="text-button" onClick={() => setMessageRetry(value => value + 1)}>重试</button>}>{messageError}</Notice>}
            {messageLoading && <p className="session-message-loading" role="status">正在加载{modeLabels[mode]}消息…</p>}
            {mode === "trace" && profile?.sessionIds[0] === selectedSessionId && profile.children.length > 0 && <details className="session-trace-children">
              <summary>关联子会话 · {profile.children.length}</summary>
              {profile.children.map(child => <button className="session-child" key={child.id} onClick={() => selectSession(child)}><strong>{child.title}</strong><small>查看子任务过程</small></button>)}
            </details>}
            {selectedMessageData && <>
              {!selectedMessageData.messages.length && !messageLoading ? <div className="session-message-empty"><h2>此会话没有可显示的记录</h2><p className="muted">来源可能只保留元数据，或当前模式下没有对应内容。</p></div> : <>
                {mode === "trace" ? <SessionTrace key={selectedMessageData.session.id} messages={selectedMessageData.messages} steps={profile?.steps ?? []} focusMessageId={focusMessageId} focusRequest={traceFocusRequest} focusTurnId={selectedMessageData.turns?.find(turn => turn.position === turnPosition)?.id}
                  timeline={timeline?.sessionId === selectedMessageData.session.id ? timeline.data.events : []} timelineLoading={timelineLoading} timelineError={timelineError} onRetryTimeline={() => setTimelineRetry(value => value + 1)} onTimelineSelect={event => focusStep({ id: event.id, sessionId: event.sessionId, messageId: event.id })}
                  project={selectedMessageData.session.project} onMap={onMap} onInspect={inspectTrace} onViewTurn={trackTraceTurn} /> :
                  <div className="session-turns">{turns.map((turn, index) => <TurnTimeline key={turn.id} turn={turn} position={index + 1} mode={mode} focusMessageId={focusMessageId} project={selectedMessageData.session.project}
                    onMap={onMap} expanded={expandedTurns.has(turn.id)} onToggle={open => toggleTurn(turn.id, open)} />)}</div>}
              </>}
            </>}
            {currentMessage && <span className="sr-only" aria-live="polite">已定位到{kindLabels[currentMessage.kind]}记录。</span>}
          </> : <div className="session-message-empty"><ChatCircle size={30} aria-hidden="true" /><h2>选择一个会话</h2><p className="muted">按客户端、项目、时间或关键词筛选，搜索命中可直接定位记录。</p></div>}
        </div>
        {selectedMessageData && <div className="session-reading-footer"><span>{formatCount(selectedMessageData.messages.length)} 条记录 · 当前页 {selectedMessageData.turns?.filter(turn => turn.position > 0).length ?? 0} 轮</span><Pager page={selectedMessageData.page} pageSize={selectedMessageData.pageSize} total={selectedMessageData.totalTurns ?? 0} onChange={changeMessagePage} label="轮次分页" /></div>}
      </main>

      <SessionProfilePane profile={profile} loading={profileLoading} error={profileError} includeChildren={includeChildren} setIncludeChildren={setIncludeChildren}
        collapsed={rightCollapsed} setCollapsed={value => { setRightCollapsed(value); setCompactPanel(null); }}
        onRetry={() => setProfileRetry(value => value + 1)} onSelectChild={selectSession} onFocusStep={focusStep} onFind={findEvidence} />
    </ResizableWorkspace>
  </div>;
}
