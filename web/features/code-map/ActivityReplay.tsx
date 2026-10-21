import { Loading } from "../../shared/ui/Loading";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowClockwise, ArrowSquareOut, FastForward, Minus, Pause, Play, Plus, SkipBack, SkipForward, X } from "@phosphor-icons/react";
import type { EvidenceResponse, FileCoverage } from "../../../src/contracts";
import type { ReplayActivity, ReplayResult, ReplaySessionsResult, ReplayStep, ReplayTrack } from "../../../src/replay-contracts";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, isMessageDescriptorKnown, messageText, useI18n } from "../../shared/i18n";
import { dateLabel, fmt } from "../../shared/format";
import type { Theme } from "../../shared/theme";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ReplayMap } from "./ReplayMap";
import { ReplaySpeed } from "./ReplaySpeed";
import { ReplayTimeline, playbackDuration } from "./ReplayTimeline";
import { repositoryPath } from "./api";
import { buildReplayIndex, replayCurrentRange, replayEndIndex, replayNext, replayNextEdit, replayOriginalTime, replayPathSteps, replayPrevious, replayRecentRange, replaySimultaneousSteps, ReplayAccumulator, validReplaySpeed } from "./replay-model";
import "./activity-replay.css";

const kindKey = (kind: string) => `replay.${kind === "search" ? "searchKind" : kind}`;
const distinctPaths = (step: ReplayStep) => [...new Set(step.activities.flatMap(activity => activity.paths))];
const ReplaySessionPicker = memo(ProjectPicker);
interface SavedReplay { version: string; sessionVersion: string; position: number; speed: number; zoom: number }
const playbackKey = (repositoryId: string, sessionId: string) => `agent-manor-replay:${repositoryId}:${sessionId}`;
const readPlayback = (repositoryId: string, sessionId: string): SavedReplay | null => {
  try { return JSON.parse(sessionStorage.getItem(playbackKey(repositoryId, sessionId)) ?? "null") as SavedReplay | null; } catch { return null; }
};

interface ActivityReplayProps {
  repositoryId: string; active: boolean; theme: Theme; targetSessionId?: string;
  onSession(target: { sessionId: string; messageId?: string; version?: string }): void;
  onTargetChange?(sessionId: string): void;
}

export function ActivityReplay({ repositoryId, active, theme, targetSessionId, onSession, onTargetChange }: ActivityReplayProps) {
  const { t, language } = useI18n();
  const [sessions, setSessions] = useState<ReplaySessionsResult | null>(null);
  const [sessionId, setSessionId] = useState(targetSessionId ?? "");
  const [data, setData] = useState<ReplayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [listRetry, setListRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [trackHeight, setTrackHeight] = useState(210);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ steps: ReplayStep[]; activity?: ReplayActivity } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [requestedEvidenceId, setRequestedEvidenceId] = useState<string | null>(null);
  const [evidenceRetry, setEvidenceRetry] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<unknown>(null);
  const [untimedLimit, setUntimedLimit] = useState(50);
  const [detailLimit, setDetailLimit] = useState(50);
  const returnFocus = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const positionRef = useRef(0);
  const sessionsRepository = useRef<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const attachRoot = useCallback((element: HTMLElement | null) => { root.current = element; setRootElement(element); }, []);
  const container = fullscreen ? rootElement : undefined;
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const snapshotRef = useRef<{ repositoryId: string; data: ReplayResult; speed: number; zoom: number } | null>(null);
  if (data && data.repository.id === repositoryId) snapshotRef.current = { repositoryId, data, speed, zoom: timelineZoom };
  const savePlayback = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    try { sessionStorage.setItem(playbackKey(snapshot.repositoryId, snapshot.data.sessionId), JSON.stringify({ version: snapshot.data.version,
      sessionVersion: snapshot.data.sessionVersion, position: positionRef.current, speed: snapshot.speed, zoom: snapshot.zoom } satisfies SavedReplay)); } catch { /* 禁用会话存储时仍保留本次页面状态。 */ }
  }, []);
  const seek = useCallback((value: number) => { positionRef.current = value; setPosition(value); }, []);
  const chooseSession = useCallback((value: string) => { setPlaying(false); setSessionId(value); onTargetChange?.(value); }, [onTargetChange]);
  useEffect(() => {
    savePlayback(); snapshotRef.current = null;
    sessionsRepository.current = null;
    setSessions(null); setData(null); setSessionId(targetSessionId ?? ""); setSelection(null); setPlaying(false); setLoading(false); seek(0);
  }, [repositoryId]);
  useEffect(() => { if (targetSessionId) { setSessionId(targetSessionId); setPlaying(false); } }, [targetSessionId]);
  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true); setListError(null);
    void request<ReplaySessionsResult>(`${repositoryPath(repositoryId)}/replay/sessions`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { sessionsRepository.current = repositoryId; setSessions(result); } })
      .catch(failure => { if (!isAborted(failure)) setListError(failure); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [repositoryId, listRetry]);
  useEffect(() => {
    if (!sessionId || !sessions || sessionsRepository.current !== repositoryId) return;
    const controller = new AbortController();
    savePlayback(); setLoading(true); setError(null); setPlaying(false); setSelection(null);
    // 新目标就绪前保留旧图；播放和下钻在此期间停用。
    void request<ReplayResult>(`${repositoryPath(repositoryId)}/replay?${new URLSearchParams({ sessionId, version: sessions.version, sessionVersion: sessions.sessionVersion })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) {
        const saved = readPlayback(repositoryId, result.sessionId);
        const sameVersion = saved?.version === result.version && saved?.sessionVersion === result.sessionVersion;
        setData(result); seek(sameVersion && Number.isFinite(saved.position) ? Math.max(0, Math.min(buildReplayIndex(result.steps).duration, saved.position)) : 0);
        setSpeed(sameVersion && validReplaySpeed(saved.speed) ? saved.speed : 1);
        setTimelineZoom(sameVersion && [1, 2, 4, 8, 16].includes(saved.zoom) ? saved.zoom : 1);
        setSelectedPath(null); setUntimedLimit(50);
      } })
      .catch(failure => { if (!isAborted(failure)) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repositoryId, sessionId, sessions, seek]);
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  useEffect(() => { if (!playing) savePlayback(); }, [playing, position, speed, timelineZoom, savePlayback]);
  useEffect(() => {
    const save = () => savePlayback();
    window.addEventListener("pagehide", save);
    return () => { savePlayback(); window.removeEventListener("pagehide", save); };
  }, [savePlayback]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === root.current); setFullscreenError(false); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => { if (!active && document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {}); }, [active]);
  const toggleFullscreen = () => {
    setFullscreenError(false);
    const operation = document.fullscreenElement === root.current ? document.exitFullscreen() : root.current?.requestFullscreen();
    void operation?.catch(() => setFullscreenError(true));
  };
  const index = useMemo(() => buildReplayIndex(data?.steps ?? []), [data]);
  const accumulator = useMemo(() => new ReplayAccumulator(index), [index]);
  const endIndex = replayEndIndex(index, position);
  const [currentStart, currentEnd] = replayCurrentRange(index, position, Math.max(1200, speed * 100));
  const [recentStart, recentEnd] = replayRecentRange(index, position, Math.max(4000, speed * 100));
  const recentSteps = useMemo(() => index.timed.slice(recentStart, recentEnd).map(entry => entry.step), [index, recentStart, recentEnd]);
  const trackNumber = useMemo(() => new Map(data?.tracks.map((track, i) => [track.id, i]) ?? []), [data]);
  const displayData = useMemo(() => {
    if (!data) return null;
    const children = new Set(sessions?.sessions.filter(session => session.relationship === "child").map(session => session.id));
    return { ...data, tracks: data.tracks.map(track => ({ ...track, title: track.titleOrigin === "fallback"
      ? t(track.depth > 0 || children.has(track.id) ? "sessions.title.childFallback" : "sessions.title.unnamed", { id: track.clientSessionId.slice(-8) }) : track.title })) };
  }, [data, sessions, language]);
  const playback = useMemo(() => {
    const current = new Map<string, { track: number; kind: string; status: string }[]>();
    for (let i = currentStart; i < currentEnd; i += 1) {
      const step = index.timed[i]!.step;
      for (const activity of step.activities) for (const path of activity.paths) {
        const markers = current.get(path) ?? [];
        const marker = { track: trackNumber.get(step.trackId) ?? 0, kind: activity.kind, status: activity.status };
        if (!markers.some(value => value.track === marker.track && value.kind === marker.kind && value.status === marker.status)) markers.push(marker);
        current.set(path, markers);
      }
    }
    return { visited: new Map(accumulator.seek(endIndex)), current };
  }, [index, accumulator, endIndex, currentStart, currentEnd, trackNumber]);
  const files = useMemo<FileCoverage[]>(() => (data?.files ?? []).map(file => ({ ...file, hash: "", readExactLines: 0, readNearLines: 0, editExactLines: 0, editNearLines: 0,
    readCount: 0, editCount: 0, activityCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0, readExactRanges: [], readNearRanges: [], editExactRanges: [], editNearRanges: [] })), [data]);
  const mappedFiles = useMemo(() => new Set(files.filter(file => file.lineCount > 0).map(file => file.path)), [files]);
  const drawablePaths = useMemo(() => {
    const paths = new Set(mappedFiles);
    if (mappedFiles.size) paths.add(".");
    for (const path of mappedFiles) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) paths.add(parts.slice(0, i).join("/"));
    }
    return paths;
  }, [mappedFiles]);
  const clockFormatter = useMemo(() => new Intl.DateTimeFormat(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }), [language]);
  const clock = useCallback((time: number) => clockFormatter.format(time), [clockFormatter]);
  useEffect(() => {
    if (!playing || !active || !index.duration) return;
    let frame = 0, previous = performance.now(), published = previous;
    const tick = (now: number) => {
      positionRef.current = Math.min(index.duration, positionRef.current + (now - previous) * speed);
      previous = now;
      // 绘图最多每秒 20 次，路径累计只在跨过活动边界时更新。
      if (now - published >= 50 || positionRef.current >= index.duration) { setPosition(positionRef.current); published = now; }
      if (positionRef.current >= index.duration) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, active, index, speed]);
  const toggle = () => {
    if (loading || error || !index.duration) return;
    if (!playing) { if (position >= index.duration) seek(0); setSelection(null); setRequestedEvidenceId(null); setEvidence(null); setSelectedPath(null); setDetailsOpen(true); }
    setPlaying(value => !value);
  };
  const stepTo = (direction: number) => { setPlaying(false); setSelection(null); setRequestedEvidenceId(null); seek(direction < 0 ? replayPrevious(index, position) : replayNext(index, position)); };
  const rememberFocus = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const openSteps = useCallback((steps: ReplayStep[], activity = steps[0]?.activities[0]) => {
    if (loading || error) return;
    rememberFocus(); setPlaying(false); setSelection({ steps, activity }); setDetailsOpen(true); setRequestedEvidenceId(null); setEvidence(null); setEvidenceError(null); setDetailLimit(50);
  }, [loading, error]);
  const pickStep = useCallback((step: ReplayStep, activity = step.activities[0]) => {
    const item = index.timed.find(item => item.step === step);
    if (item) seek(item.position);
    const simultaneous = replaySimultaneousSteps(index, step);
    setSelectedPath(activity?.paths[0] ?? distinctPaths(step)[0] ?? null); openSteps(simultaneous, activity);
  }, [index, seek, openSteps]);
  const selectFile = useCallback((path: string) => { setSelectedPath(path); openSteps(replayPathSteps(index, path, endIndex)); }, [index, endIndex, openSteps]);
  const inspectRecent = useCallback((steps: ReplayStep[]) => { setSelectedPath(null); openSteps(steps); }, [openSteps]);
  const closeDetails = () => { setDetailsOpen(false); setSelection(null); setRequestedEvidenceId(null); setEvidence(null); (returnFocus.current?.isConnected ? returnFocus.current : root.current)?.focus({ preventScroll: true }); };
  useEffect(() => { if (selection) detailRef.current?.focus({ preventScroll: true }); }, [!!selection]);
  const selectedStep = selection?.steps.find(step => step.activities.some(activity => activity.id === selection.activity?.id)) ?? selection?.steps[0];
  const selectedTrack = displayData?.tracks.find(track => track.id === selectedStep?.trackId);
  useEffect(() => {
    const activity = selection?.activity;
    if (!activity || !data || requestedEvidenceId !== activity.id) { setEvidenceLoading(false); return; }
    const controller = new AbortController();
    setEvidence(null); setEvidenceError(null); setEvidenceLoading(true);
    // 原始证据只在显式选中活动后读取；不可用主轨筛选限制子轨证据。
    const query = new URLSearchParams({ version: data.version, sessionVersion: data.sessionVersion, sessionId: data.sessionId });
    void request<EvidenceResponse>(`${repositoryPath(repositoryId)}/replay/evidence/${encodeURIComponent(activity.id)}?${query}`, { signal: controller.signal })
      .then(result => { if (result.version !== data.version) throw new ApiError("VERSION_MISMATCH", t("replay.versionError"), { key: "replay.versionError" }); if (!controller.signal.aborted) setEvidence(result); })
      .catch(failure => { if (!isAborted(failure)) { setEvidenceError(failure); setPlaying(false); } })
      .finally(() => { if (!controller.signal.aborted) setEvidenceLoading(false); });
    return () => controller.abort();
  }, [selection?.activity?.id, requestedEvidenceId, data, repositoryId, evidenceRetry]);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === " ") { event.preventDefault(); toggle(); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); stepTo(event.key === "ArrowLeft" ? -1 : 1); }
    else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setPlaying(false); seek(event.key === "Home" ? 0 : index.duration); }
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    setTrackHeight(Math.max(140, Math.min(420, resizeStart.current.height + resizeStart.current.y - event.clientY)));
  };
  const disabled = loading || !!error || !index.duration;
  const options = useMemo(() => (sessions?.sessions ?? []).map(session => ({ value: session.id, label: session.titleOrigin === "fallback" ? t(session.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed", { id: session.clientSessionId.slice(-8) }) : session.title,
    description: t("replay.option", { client: clientLabel(session.client), date: dateLabel(session.updatedAt), activities: t("replay.activityCount", { count: session.eventCount }), tracks: t("replay.trackCount", { count: session.trackCount }), id: session.clientSessionId }) })), [sessions, language]);
  const untimedCount = useMemo(() => [...index.untimed.values()].reduce((sum, steps) => sum + steps.length, 0), [index]);
  const untimedRows = useMemo(() => displayData?.tracks.map((track, number) => {
    const steps = index.untimed.get(track.id) ?? [];
    return steps.length ? <section key={track.id}><h3><span className={`replay-track-number replay-track-${number % 6}`}>{number + 1}</span>{track.title}</h3><div>{steps.slice(0, untimedLimit).map(step => <button key={step.id} className="button subtle" data-step-id={step.id} onClick={() => pickStep(step)}>{step.activities[0]?.tool} · {t("replay.activityCount", { count: step.activities.length })}{step.orderKnown === false ? ` · ${t("replay.orderUnknown")}` : ""}</button>)}{steps.length > untimedLimit && <button className="button subtle" onClick={() => setUntimedLimit(value => value + 100)}>{t("replay.loadMore")}</button>}</div></section> : null;
  }), [displayData, index, untimedLimit, pickStep, language]);
  const currentTime = clock(replayOriginalTime(index, position));
  const nextEdit = replayNextEdit(index, position);
  const legend = useMemo(() => <div className="replay-legend"><span><i className="replay-symbol read" />{t("replay.read")}</span><span><i className="replay-symbol edit" />{t("replay.edit")}</span><span><i className="replay-symbol search" />{t("replay.searchKind")}</span><span><b className="replay-status-symbol failure">!</b>{t("replay.failureMarker")}</span><HelpPopover container={container} label={t("replay.gapLegend")} trigger={<button className="replay-gap-legend"><span aria-hidden="true">//</span>{t("replay.gapLegend")}</button>}><p>{t("replay.gapDescription")}</p><p>{t("replay.trackColors")}</p></HelpPopover><span className="replay-legend-trace">{t("replay.visited")}</span></div>, [language, container]);
  const update = () => { setPlaying(false); setListRetry(value => value + 1); };
  return <section ref={attachRoot} className="activity-replay" style={{ "--replay-track-height": `${trackHeight}px` } as CSSProperties} data-theme={theme} data-playing={playing} data-motion-detail={speed >= 16 ? "reduced" : "full"} data-fullscreen={fullscreen} data-position={position} data-replay-version={data?.version} tabIndex={0} onKeyDown={keyboard} aria-label={t("replay.map")} aria-busy={loading}>
    <div className="replay-session-toolbar">
      <ReplaySessionPicker value={sessionId} onChange={chooseSession} label={t("replay.session")} placeholder={t("replay.search")} options={options} container={container} />
      {(loading || listLoading) && <Loading variant="inline" size={16} label={t("replay.loading")} />}
      <button className="button subtle replay-view-session" disabled={!sessionId || loading} onClick={() => onSession({ sessionId, version: data?.sessionVersion })}><ArrowSquareOut size={15} />{t("replay.viewSession")}</button>
      {!detailsOpen && data && <button className="button subtle" onClick={() => setDetailsOpen(true)}>{t("replay.followDetails")}</button>}
      <HelpPopover container={container} label={t("replay.help")}><p>{t("replay.helpClock")}</p><p>{t("replay.helpMap")}</p><p>{t("replay.helpKeyboard")}</p>{data && <p>{t("replay.version", { version: data.version, sessionVersion: data.sessionVersion })}</p>}{data?.missingChildren ? <p>{t("replay.missingChildren", { count: data.missingChildren })}</p> : null}{data?.stale && <p>{t("replay.stale")}</p>}</HelpPopover>
      {data && <button className="icon-button" aria-label={t("replay.update")} disabled={loading} onClick={update}><ArrowClockwise size={16} /></button>}
    </div>
    {!!listError && <div className="replay-error" role="alert">{errorMessage(listError)}<button className="button subtle" onClick={() => setListRetry(value => value + 1)}>{t("common.retry")}</button></div>}
    {!!error && <div className="replay-error" role="alert">{errorMessage(error)}<button className="button subtle" onClick={update}>{t("replay.update")}</button></div>}
    {fullscreenError && <div className="replay-error" role="alert">{t("replay.fullscreenError")}</div>}
    {!data && !loading && !error && <div className="replay-empty"><Play size={30} /><p>{!listLoading && !sessions?.sessions.length ? t("replay.emptySessions") : t("replay.select")}</p></div>}
    {!data && loading && <div className="replay-empty" role="status"><Loading /><p>{t("replay.loading")}</p></div>}
    {data && <>
      <div className={`replay-viewer${detailsOpen ? " has-details" : ""}`} data-blocked={loading || !!error}>
        <div className="replay-map-area">
          <ReplayMap files={files} steps={data.steps} selected={selectedPath} select={selectFile} scopeKey={`${repositoryId}:${data.version}:${data.sessionVersion}:${data.sessionId}`} playback={playback} legend={legend} fullscreen={fullscreen} onFullscreen={toggleFullscreen} container={container} disabled={loading || !!error} />
        </div>
        {detailsOpen && <aside className="replay-evidence" data-mode={selection ? "inspect" : "follow"} aria-label={t(selection ? "replay.details" : "replay.followDetails")} ref={detailRef} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDetails(); } }}>
          <div className="replay-evidence-heading"><strong>{t(selection ? "replay.details" : "replay.followDetails")}</strong>{selection && <button className="button subtle replay-follow-return" onClick={() => { setSelection(null); setRequestedEvidenceId(null); setSelectedPath(null); setEvidence(null); }}>{t("replay.followPlayback")}</button>}<button className="icon-button" aria-label={t("replay.closeDetails")} onClick={closeDetails}><X size={16} /></button></div>
          {!selection && <ReplayFollowDetails steps={recentSteps} tracks={displayData!.tracks} numbers={trackNumber} clock={clock} inspect={pickStep} inspectAll={inspectRecent} />}
          {selection && <>
          {selectedPath && <code className="replay-path">{selectedPath}</code>}
          {!selection.steps.length && <p className="muted">{t("replay.noPastActivity")}</p>}
          {selection.steps.length > 0 && <div className="replay-activity-list">{selection.steps.slice(0, detailLimit).flatMap(step => step.activities.map(activity => <button key={activity.id} className={selection.activity?.id === activity.id ? "selected" : ""} onClick={() => { setSelectedPath(current => current && activity.paths.includes(current) ? current : activity.paths[0] ?? null); setSelection({ ...selection, activity }); setRequestedEvidenceId(null); setEvidence(null); setEvidenceError(null); }}><i className={`replay-symbol ${activity.kind}`} /><span>{activity.tool}<small>{t(kindKey(activity.kind))} · {t(`codeMap.status.${activity.status}`)} · {step.time === undefined ? t("replay.noTime") : clock(step.time)}</small></span></button>))}{selection.steps.length > detailLimit && <button onClick={() => setDetailLimit(value => value + 100)}>{t("replay.loadMore")}</button>}</div>}
          {selectedStep && <div className="replay-evidence-meta"><strong>{selectedTrack?.title}</strong><span>{selectedStep.time === undefined ? t("replay.noTime") : clock(selectedStep.time)}</span><span>{t(`codeMap.status.${selection.activity?.status ?? "unknown"}`)}</span>{selectedStep.orderKnown === false && <span>{t("replay.orderUnknown")}</span>}</div>}
          {selection.activity?.paths.map(path => <button key={path} className="replay-path-link" onClick={() => setSelectedPath(path)}>{path}</button>)}
          {selection.activity?.paths.some(path => !drawablePaths.has(path)) && <p className="muted">{t("replay.noMapFile")}</p>}
          <div className="replay-evidence-actions">
            {selectedStep && <button className="button subtle" onClick={() => onSession({ sessionId: selectedStep.trackId, messageId: selection.activity?.messageId, version: data.sessionVersion })}><ArrowSquareOut size={14} />{t("replay.viewSession")}</button>}
            {selection.activity && requestedEvidenceId !== selection.activity.id && <button className="button subtle" onClick={() => setRequestedEvidenceId(selection.activity!.id)}>{t("replay.readEvidence")}</button>}
          </div>
          {evidenceLoading && <p className="muted loading-status" role="status"><Loading variant="inline" size={16} />{t("replay.evidenceLoading")}</p>}
          {!!evidenceError && <div className="replay-error" role="alert">{errorMessage(evidenceError)}<button className="button subtle" onClick={() => setEvidenceRetry(value => value + 1)}>{t("common.retry")}</button><button className="button subtle" onClick={update}>{t("replay.update")}</button></div>}
          {evidence && <ReplayEvidenceBody evidence={evidence} />}
          </>}
        </aside>}
      </div>
      <div className="replay-resize" role="separator" aria-label={t("replay.resize")} aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={420} aria-valuenow={trackHeight} tabIndex={0}
        onKeyDown={event => { if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setTrackHeight(height => Math.max(140, Math.min(420, height + (event.key === "ArrowUp" ? 20 : -20)))); } }}
        onPointerDown={event => { resizeStart.current = { y: event.clientY, height: trackHeight }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resize}
        onPointerUp={event => { resizeStart.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resizeStart.current = null; }} />
      <div className="replay-transport" role="group" aria-label={t("replay.position")}>
        <button className="icon-button" aria-label={t("replay.restart")} disabled={disabled} onClick={() => { setPlaying(false); seek(0); }}><ArrowClockwise size={17} /></button>
        <button className="icon-button" aria-label={t("replay.previous")} disabled={disabled || position <= 0} onClick={() => stepTo(-1)}><SkipBack size={17} /></button>
        <button className="button replay-play" aria-label={t(playing ? "replay.pause" : "replay.play")} disabled={disabled} onClick={toggle}>{playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button>
        <button className="icon-button" aria-label={t("replay.next")} disabled={disabled || position >= index.duration} onClick={() => stepTo(1)}><SkipForward size={17} /></button>
        <ReplaySpeed value={speed} onChange={setSpeed} container={container} disabled={disabled} />
        <button className="icon-button" aria-label={t("replay.nextEdit")} disabled={disabled || nextEdit === undefined} onClick={() => { if (nextEdit !== undefined) { setPlaying(false); setSelection(null); setRequestedEvidenceId(null); seek(nextEdit); } }}><FastForward size={17} /></button>
        <output className="replay-clock">{index.duration ? currentTime : "—"}</output>
        <span className="replay-progress-count">{fmt(endIndex)} / {fmt(index.timed.length)}</span>
        <span className="replay-remaining">{t("replay.remaining", { duration: playbackDuration((index.duration - position) / speed, language) })}</span>
        <div className="replay-timeline-zoom" role="group" aria-label={t("replay.zoom")}><button className="icon-button" aria-label={t("replay.zoomOut")} disabled={timelineZoom <= 1} onClick={() => setTimelineZoom(value => Math.max(1, value / 2))}><Minus size={15} /></button><span>{timelineZoom}×</span><button className="icon-button" aria-label={t("replay.zoomIn")} disabled={timelineZoom >= 16} onClick={() => setTimelineZoom(value => Math.min(16, value * 2))}><Plus size={15} /></button></div>
      </div>
      <input type="range" className="replay-seek" min="0" max={Math.max(1, index.duration)} step="1" value={position} disabled={disabled} aria-label={t("replay.position")} aria-valuetext={t("replay.positionValue", { time: currentTime, count: endIndex })} onChange={event => { setPlaying(false); setSelection(null); setRequestedEvidenceId(null); seek(Number(event.target.value)); }} />
      {!data.steps.length && <p className="replay-status">{t("replay.noActivity")}</p>}
      {!!data.steps.length && !index.timed.length && <p className="replay-status">{t("replay.noTimed")}</p>}
      <ReplayTimeline data={displayData!} index={index} position={position} zoom={timelineZoom} height={trackHeight} clock={clock} select={pickStep} seek={value => { setPlaying(false); setSelection(null); setRequestedEvidenceId(null); seek(value); }} disabled={loading || !!error} container={container} />
      {!!untimedCount && <details className="replay-untimed"><summary>{t("replay.untimedCount", { count: untimedCount })}</summary><p className="muted">{t("replay.untimedDescription")}</p>{untimedRows}</details>}
    </>}
  </section>;
}

const ReplayEvidenceBody = memo(function ReplayEvidenceBody({ evidence }: { evidence: EvidenceResponse }) {
  const { t } = useI18n();
  return <>
    {evidence.event.reason && <p className="muted">{!isMessageDescriptorKnown(evidence.event.reasonDescriptor) && <strong>{t("common.originalDetails")}: </strong>}{messageText(evidence.event.reasonDescriptor, evidence.event.reason)}</p>}
    {!!evidence.event.fragments.length && <details open><summary>{t("replay.fragments")}</summary>{evidence.event.fragments.map((fragment, i) => <pre key={i} tabIndex={0}>{fragment.content}</pre>)}</details>}
    <details><summary>{t("replay.input")}</summary><pre tabIndex={0}>{JSON.stringify(evidence.event.input ?? null, null, 2)}</pre></details>
    <details><summary>{t("replay.output")}</summary><pre tabIndex={0}>{JSON.stringify(evidence.event.output ?? null, null, 2)}</pre></details>
    <details><summary>{t("replay.evidence")}</summary>{evidence.records.map((record, i) => <section key={i}><code>{record.source.path}:{record.source.recordLine}</code><pre tabIndex={0}>{record.raw}</pre></section>)}{!evidence.records.length && <p className="muted">{t("replay.noEvidence")}</p>}{!!evidence.unavailable.length && <p className="muted">{t("replay.evidenceUnavailable", { count: evidence.unavailable.length })}</p>}</details>
  </>;
});

const ReplayFollowDetails = memo(function ReplayFollowDetails({ steps, tracks, numbers, clock, inspect, inspectAll }: {
  steps: ReplayStep[]; tracks: ReplayTrack[]; numbers: Map<string, number>; clock(time: number): string; inspect(step: ReplayStep, activity?: ReplayActivity): void; inspectAll(steps: ReplayStep[]): void;
}) {
  const { t } = useI18n();
  const trackMap = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks]);
  const groups = useMemo(() => {
    const result = new Map<string, ReplayStep[]>();
    for (const step of [...steps].reverse()) { const values = result.get(step.trackId) ?? []; values.push(step); result.set(step.trackId, values); }
    return [...result].sort(([a], [b]) => (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0));
  }, [steps, numbers]);
  return <div className="replay-follow-details" aria-live="off">
    {!steps.length && <p className="muted">{t("replay.noPastActivity")}</p>}
    {groups.map(([trackId, values]) => <section key={trackId} className={`replay-follow-track replay-track-${(numbers.get(trackId) ?? 0) % 6}`}>
      <h3><span className={`replay-track-number replay-track-${(numbers.get(trackId) ?? 0) % 6}`}>{(numbers.get(trackId) ?? 0) + 1}</span><span>{trackMap.get(trackId)?.title}</span></h3>
      {values.slice(0, 3).map(step => <div key={step.id} className="replay-follow-step"><time>{step.time === undefined ? t("replay.noTime") : clock(step.time)}</time>
        {step.activities.map(activity => <button key={activity.id} className="replay-follow-activity" data-activity-id={activity.id} onClick={() => inspect(step, activity)}>
          <span className="replay-follow-operation"><i className={`replay-symbol ${activity.kind}`} />{t(kindKey(activity.kind))}<small>{t(`codeMap.status.${activity.status}`)}</small></span>
          {activity.paths.slice(0, 8).map(path => <code key={path}>{path}</code>)}{activity.paths.length > 8 && <small>{t("replay.previewMoreFiles", { count: activity.paths.length - 8 })}</small>}
        </button>)}
      </div>)}
      {values.length > 3 && <button className="button subtle" onClick={() => inspectAll(values)}>{t("replay.recentActivities")}</button>}
    </section>)}
  </div>;
});
