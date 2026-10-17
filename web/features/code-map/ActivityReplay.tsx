import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowClockwise, ArrowSquareOut, CircleNotch, Minus, Pause, Play, Plus, SkipBack, SkipForward, X } from "@phosphor-icons/react";
import type { EvidenceResponse, FileCoverage } from "../../../src/contracts";
import type { ReplayActivity, ReplayResult, ReplaySessionsResult, ReplayStep, ReplayTrack } from "../../../src/replay-contracts";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, isMessageDescriptorKnown, messageText, useI18n } from "../../shared/i18n";
import { dateLabel, fmt } from "../../shared/format";
import type { Theme } from "../../shared/theme";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { CodeMap } from "./CodeMap";
import { repositoryPath } from "./api";
import { buildReplayIndex, replayCurrentRange, replayEndIndex, replayNext, replayOriginalTime, replayPathSteps, replayPrevious, replaySimultaneousSteps, ReplayAccumulator, upperBound, type PositionedStep, type ReplayIndex } from "./replay-model";
import "./activity-replay.css";

const kindKey = (kind: string) => `replay.${kind === "search" ? "searchKind" : kind}`;
const speeds = [.25, .5, 1, 2, 4, 8];
const distinctPaths = (step: ReplayStep) => [...new Set(step.activities.flatMap(activity => activity.paths))];
const noBrowse = () => {};
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
        setSpeed(sameVersion && speeds.includes(saved.speed) ? saved.speed : 1);
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
  const index = useMemo(() => buildReplayIndex(data?.steps ?? []), [data]);
  const accumulator = useMemo(() => new ReplayAccumulator(index), [index]);
  const endIndex = replayEndIndex(index, position);
  const [currentStart, currentEnd] = replayCurrentRange(index, position);
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
    if (!playing && position >= index.duration) seek(0);
    setPlaying(value => !value);
  };
  const stepTo = (direction: number) => { setPlaying(false); seek(direction < 0 ? replayPrevious(index, position) : replayNext(index, position)); };
  const rememberFocus = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const openSteps = useCallback((steps: ReplayStep[], activity = steps[0]?.activities[0]) => {
    if (loading || error) return;
    rememberFocus(); setPlaying(false); setSelection({ steps, activity }); setEvidence(null); setEvidenceError(null); setDetailLimit(50);
  }, [loading, error]);
  const pickStep = useCallback((step: ReplayStep) => {
    const item = index.timed.find(item => item.step === step);
    if (item) seek(item.position);
    const simultaneous = replaySimultaneousSteps(index, step);
    setSelectedPath(distinctPaths(step)[0] ?? null); openSteps(simultaneous, step.activities[0]);
  }, [index, seek, openSteps]);
  const selectFile = useCallback((path: string) => { setSelectedPath(path); openSteps(replayPathSteps(index, path, endIndex)); }, [index, endIndex, openSteps]);
  const closeDetails = () => { setSelection(null); setEvidence(null); returnFocus.current?.focus(); };
  useEffect(() => { if (selection) detailRef.current?.focus({ preventScroll: true }); }, [!!selection]);
  const selectedStep = selection?.steps.find(step => step.activities.some(activity => activity.id === selection.activity?.id)) ?? selection?.steps[0];
  const selectedTrack = displayData?.tracks.find(track => track.id === selectedStep?.trackId);
  useEffect(() => {
    const activity = selection?.activity;
    if (!activity || !data) return;
    const controller = new AbortController();
    setEvidence(null); setEvidenceError(null); setEvidenceLoading(true);
    // 原始证据只在显式选中活动后读取；不可用主轨筛选限制子轨证据。
    const query = new URLSearchParams({ version: data.version, sessionVersion: data.sessionVersion, sessionId: data.sessionId });
    void request<EvidenceResponse>(`${repositoryPath(repositoryId)}/replay/evidence/${encodeURIComponent(activity.id)}?${query}`, { signal: controller.signal })
      .then(result => { if (result.version !== data.version) throw new ApiError("VERSION_MISMATCH", t("replay.versionError"), { key: "replay.versionError" }); if (!controller.signal.aborted) setEvidence(result); })
      .catch(failure => { if (!isAborted(failure)) { setEvidenceError(failure); setPlaying(false); } })
      .finally(() => { if (!controller.signal.aborted) setEvidenceLoading(false); });
    return () => controller.abort();
  }, [selection?.activity?.id, data, repositoryId, evidenceRetry]);
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
  const currentSteps = index.timed.slice(currentStart, currentEnd).map(entry => entry.step);
  const legend = useMemo(() => <div className="replay-legend"><span><i className="replay-symbol read" />{t("replay.read")}</span><span><i className="replay-symbol edit" />{t("replay.edit")}</span><span><i className="replay-symbol search" />{t("replay.searchKind")}</span><span className="replay-legend-trace">{t("replay.visited")}</span></div>, [language]);
  const update = () => { setPlaying(false); setListRetry(value => value + 1); };
  return <section ref={root} className="activity-replay" style={{ "--replay-track-height": `${trackHeight}px` } as CSSProperties} data-theme={theme} data-playing={playing} data-position={position} data-replay-version={data?.version} tabIndex={0} onKeyDown={keyboard} aria-label={t("replay.map")} aria-busy={loading}>
    <div className="replay-session-toolbar">
      <ReplaySessionPicker value={sessionId} onChange={chooseSession} label={t("replay.session")} placeholder={t("replay.search")} options={options} />
      {(loading || listLoading) && <CircleNotch className="spinning replay-loading-icon" size={16} aria-label={t("replay.loading")} />}
      <button className="button subtle replay-view-session" disabled={!sessionId || loading} onClick={() => onSession({ sessionId, version: data?.sessionVersion })}><ArrowSquareOut size={15} />{t("replay.viewSession")}</button>
      <HelpPopover label={t("replay.help")}><p>{t("replay.helpClock")}</p><p>{t("replay.helpMap")}</p><p>{t("replay.helpKeyboard")}</p>{data && <p>{t("replay.version", { version: data.version, sessionVersion: data.sessionVersion })}</p>}{data?.missingChildren ? <p>{t("replay.missingChildren", { count: data.missingChildren })}</p> : null}{data?.stale && <p>{t("replay.stale")}</p>}</HelpPopover>
      {data && <button className="icon-button" aria-label={t("replay.update")} disabled={loading} onClick={update}><ArrowClockwise size={16} /></button>}
    </div>
    {!!listError && <div className="replay-error" role="alert">{errorMessage(listError)}<button className="button subtle" onClick={() => setListRetry(value => value + 1)}>{t("common.retry")}</button></div>}
    {!!error && <div className="replay-error" role="alert">{errorMessage(error)}<button className="button subtle" onClick={update}>{t("replay.update")}</button></div>}
    {!data && !loading && !error && <div className="replay-empty"><Play size={30} /><p>{!listLoading && !sessions?.sessions.length ? t("replay.emptySessions") : t("replay.select")}</p></div>}
    {!data && loading && <div className="replay-empty" role="status"><CircleNotch className="spinning" size={24} /><p>{t("replay.loading")}</p></div>}
    {data && <>
      <div className={`replay-viewer${selection ? " has-details" : ""}`} data-blocked={loading || !!error}>
        <div className="replay-map-area">
          <CodeMap files={files} directory="" metric="activity" selected={selectedPath} browse={noBrowse} select={selectFile} scopeKey={`${repositoryId}:${data.version}:${data.sessionId}`} playback={playback} heading={null} legend={legend} />
        </div>
        {selection && <aside className="replay-evidence" aria-label={t("replay.details")} ref={detailRef} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDetails(); } }}>
          <div className="replay-evidence-heading"><strong>{t("replay.details")}</strong><button className="icon-button" aria-label={t("replay.closeDetails")} onClick={closeDetails}><X size={16} /></button></div>
          {selectedPath && <code className="replay-path">{selectedPath}</code>}
          {!selection.steps.length && <p className="muted">{t("replay.noPastActivity")}</p>}
          {selection.steps.length > 0 && <div className="replay-activity-list">{selection.steps.slice(0, detailLimit).flatMap(step => step.activities.map(activity => <button key={activity.id} className={selection.activity?.id === activity.id ? "selected" : ""} onClick={() => { setSelectedPath(current => current && activity.paths.includes(current) ? current : activity.paths[0] ?? null); setSelection({ ...selection, activity }); }}><i className={`replay-symbol ${activity.kind}`} /><span>{activity.tool}<small>{t(kindKey(activity.kind))} · {t(`codeMap.status.${activity.status}`)} · {step.time === undefined ? t("replay.noTime") : clock(step.time)}</small></span></button>))}{selection.steps.length > detailLimit && <button onClick={() => setDetailLimit(value => value + 100)}>{t("replay.loadMore")}</button>}</div>}
          {selectedStep && <div className="replay-evidence-meta"><strong>{selectedTrack?.title}</strong><span>{selectedStep.time === undefined ? t("replay.noTime") : clock(selectedStep.time)}</span><span>{t(`codeMap.status.${selection.activity?.status ?? "unknown"}`)}</span>{selectedStep.orderKnown === false && <span>{t("replay.orderUnknown")}</span>}</div>}
          {selection.activity?.paths.map(path => <button key={path} className="replay-path-link" onClick={() => setSelectedPath(path)}>{path}</button>)}
          {selection.activity?.paths.some(path => !drawablePaths.has(path)) && <p className="muted">{t("replay.noMapFile")}</p>}
          {selectedStep && <button className="button subtle" onClick={() => onSession({ sessionId: selectedStep.trackId, messageId: selection.activity?.messageId, version: data.sessionVersion })}><ArrowSquareOut size={14} />{t("replay.viewSession")}</button>}
          {evidenceLoading && <p className="muted" role="status">{t("replay.evidenceLoading")}</p>}
          {!!evidenceError && <div className="replay-error" role="alert">{errorMessage(evidenceError)}<button className="button subtle" onClick={() => setEvidenceRetry(value => value + 1)}>{t("common.retry")}</button><button className="button subtle" onClick={update}>{t("replay.update")}</button></div>}
          {evidence && <ReplayEvidenceBody evidence={evidence} />}
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
        <FilterSelect label={t("replay.speed")} value={String(speed)} options={speeds.map(value => ({ value: String(value), label: `${new Intl.NumberFormat(language).format(value)}×` }))} onChange={value => setSpeed(Number(value))} />
        <output className="replay-clock">{index.duration ? currentTime : "—"}</output>
        <span className="replay-progress-count">{fmt(endIndex)} / {fmt(index.timed.length)}</span>
        <div className="replay-timeline-zoom" role="group" aria-label={t("replay.zoom")}><button className="icon-button" aria-label={t("replay.zoomOut")} disabled={timelineZoom <= 1} onClick={() => setTimelineZoom(value => Math.max(1, value / 2))}><Minus size={15} /></button><span>{timelineZoom}×</span><button className="icon-button" aria-label={t("replay.zoomIn")} disabled={timelineZoom >= 16} onClick={() => setTimelineZoom(value => Math.min(16, value * 2))}><Plus size={15} /></button></div>
      </div>
      <input type="range" className="replay-seek" min="0" max={Math.max(1, index.duration)} step="1" value={position} disabled={disabled} aria-label={t("replay.position")} aria-valuetext={t("replay.positionValue", { time: currentTime, count: endIndex })} onChange={event => { setPlaying(false); seek(Number(event.target.value)); }} />
      {!data.steps.length && <p className="replay-status">{t("replay.noActivity")}</p>}
      {!!data.steps.length && !index.timed.length && <p className="replay-status">{t("replay.noTimed")}</p>}
      <ReplayTimeline data={displayData!} index={index} position={position} zoom={timelineZoom} height={trackHeight} clock={clock} select={pickStep} seek={value => { setPlaying(false); seek(value); }} disabled={loading || !!error} />
      {!!untimedCount && <details className="replay-untimed"><summary>{t("replay.untimedCount", { count: untimedCount })}</summary><p className="muted">{t("replay.untimedDescription")}</p>{untimedRows}</details>}
      <div className="replay-current-summary" aria-live="off">{currentSteps.slice(0, 3).map(step => <button key={step.id} onClick={() => pickStep(step)}><span className={`replay-track-number replay-track-${(trackNumber.get(step.trackId) ?? 0) % 6}`}>{(trackNumber.get(step.trackId) ?? 0) + 1}</span>{step.activities[0]?.tool}<code>{distinctPaths(step).join(", ")}</code></button>)}{currentSteps.length > 3 && <button className="replay-show-current" onClick={() => { setSelectedPath(null); openSteps(currentSteps); }}>{t("replay.allCurrent", { count: currentSteps.length })}</button>}</div>
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

function ReplayTimeline({ data, index, position, zoom, height, clock, select, seek, disabled }: {
  data: ReplayResult; index: ReplayIndex; position: number; zoom: number; height: number; clock: (time: number) => string;
  select: (step: ReplayStep) => void; seek: (value: number) => void; disabled: boolean;
}) {
  const { t, language } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [viewportHeight, setViewportHeight] = useState(height);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect?.width || !rect.height) return;
      setWidth(Math.max(260, rect.width - 176)); setViewportHeight(rect.height);
    });
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  const timelineWidth = width * zoom;
  const lanes = useMemo(() => {
    const lanes = new Map<string, PositionedStep[]>();
    for (const entry of index.timed) { const lane = lanes.get(entry.step.trackId) ?? []; lane.push(entry); lanes.set(entry.step.trackId, lane); }
    return lanes;
  }, [index]);
  const duration = Math.max(1, index.duration);
  const x = position / duration * timelineWidth;
  // 动态层只覆盖滚动视口；通高变换层会使数百轨回放产生巨大的合成区域。
  const overlayTop = Math.min(scrollTop, Math.max(0, data.tracks.length * 42 + 28 - viewportHeight));
  const label = (step: ReplayStep, track: ReplayTrack) => t("replay.step", { track: track.title, tool: step.activities.map(activity => `${activity.tool} (${t(`codeMap.status.${activity.status}`)})`).join(", "), time: step.time === undefined ? t("replay.noTime") : clock(step.time), count: distinctPaths(step).length });
  // 播放头独立推进；轨道、断轴和标尺只在数据、缩放或语言改变时重建。
  const trackRows = useMemo(() => data.tracks.map((track, number) => <div className="replay-track-row" data-track-id={track.id} key={track.id}>
    <div className="replay-track-label" title={track.title} style={{ paddingLeft: Math.min(track.depth, 4) * 8 + 8 }}><span className={`replay-track-number replay-track-${number % 6}`}>{number + 1}</span><span>{track.title}<small>{track.depth ? clientLabel(track.client) : t("replay.mainTrack")}{track.untimedCount ? ` · ${t("replay.untimedCount", { count: track.untimedCount })}` : ""}</small></span></div>
    <TimelineLane entries={lanes.get(track.id) ?? emptyLane} width={timelineWidth} duration={duration} number={number} language={language} disabled={disabled} label={step => label(step, track)} select={select} />
  </div>), [data.tracks, lanes, timelineWidth, duration, language, disabled, select, clock]);
  const gapElements = useMemo(() => index.segments.filter(segment => segment.collapsed).map((segment, i) => <div key={i} className="replay-gap" style={{ left: segment.from / duration * timelineWidth, width: Math.max(6, (segment.to - segment.from) / duration * timelineWidth) }}><HelpPopover label={t("replay.gap", { start: clock(segment.start), end: clock(segment.end) })} trigger={<button className="replay-gap-help" aria-label={t("replay.gap", { start: clock(segment.start), end: clock(segment.end) })}>//</button>}><p>{t("replay.gap", { start: clock(segment.start), end: clock(segment.end) })}</p><p>{t("replay.helpClock")}</p></HelpPopover></div>), [index, timelineWidth, duration, clock, language]);
  const rulerLabels = useMemo(() => (timelineWidth >= 650 ? [0, .25, .5, .75, 1] : [0, .5, 1]).map(fraction => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{index.timed.length ? clock(replayOriginalTime(index, fraction * duration)) : "—"}</span>), [timelineWidth, index, duration, clock]);
  return <div className="replay-timeline-scroll" ref={scroller} style={{ height }} role="group" aria-label={t("replay.timeline")} data-disabled={disabled} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <div className="replay-timeline-content" style={{ width: timelineWidth + 176 }}>
      <div className="replay-ruler"><div className="replay-track-label">{t("replay.timeline")}</div><div className="replay-ruler-times" style={{ width: timelineWidth }} onClick={event => { if (!disabled) seek(Math.max(0, Math.min(duration, (event.clientX - event.currentTarget.getBoundingClientRect().left) / timelineWidth * duration))); }}>
        {rulerLabels}
      </div></div>
      {trackRows}
      <div className="replay-timeline-overlay" style={{ left: 176, top: overlayTop, width: timelineWidth, height: viewportHeight }}>
        {gapElements}
        <div className="replay-playhead" style={{ transform: `translateX(${x}px)` }} aria-hidden="true" />
      </div>
    </div>
  </div>;
}

const emptyLane: PositionedStep[] = [];
const TimelineLane = memo(function TimelineLane({ entries, width, duration, number, select, label, disabled }: {
  entries: PositionedStep[]; width: number; duration: number; number: number; language: string; disabled: boolean; select: (step: ReplayStep) => void; label: (step: ReplayStep) => string;
}) {
  const paths = useMemo(() => {
    const kinds = new Map<string, string[]>();
    for (const entry of entries) {
      const x = Math.max(5, Math.min(width - 5, entry.position / duration * width));
      const kind = entry.step.activities.some(activity => activity.kind === "edit") ? "edit" : entry.step.activities[0]?.kind ?? "read";
      const status = entry.step.activities.some(activity => activity.status === "failure") ? "failure" : entry.step.activities.some(activity => activity.status === "unknown") ? "unknown" : "success";
      const list = kinds.get(`${kind} ${status}`) ?? [];
      list.push(kind === "edit" ? `M${x - 3} 17h6v6h-6Z` : kind === "search" ? `M${x} 15l5 5l-5 5l-5 -5Z` : `M${x - 3} 20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0`);
      kinds.set(`${kind} ${status}`, list);
    }
    return [...kinds].map(([kind, parts]) => ({ kind, d: parts.join("") }));
  }, [entries, width, duration]);
  return <div className={`replay-lane replay-track-${number % 6}`} style={{ width }}>
    <svg width={width} height="42" aria-hidden="true" onClick={event => {
      if (!entries.length || disabled) return;
      const position = (event.clientX - event.currentTarget.getBoundingClientRect().left) / width * duration;
      const index = upperBound(entries, position, entry => entry.position);
      const before = entries[Math.max(0, index - 1)]!, after = entries[Math.min(entries.length - 1, index)]!;
      select(Math.abs(before.position - position) <= Math.abs(after.position - position) ? before.step : after.step);
    }}>{paths.map(path => <path key={path.kind} d={path.d} className={`replay-lane-points ${path.kind}`} />)}</svg>
    {entries.length <= 250 && entries.map(entry => <button key={entry.step.id} tabIndex={-1} disabled={disabled} className="replay-step-hit" data-step-id={entry.step.id} title={label(entry.step)} aria-label={label(entry.step)} style={{ left: Math.max(0, Math.min(width - 16, entry.position / duration * width - 8)) }} onClick={() => select(entry.step)} />)}
  </div>;
}, (previous, next) => previous.entries === next.entries && previous.width === next.width && previous.duration === next.duration && previous.number === next.number && previous.language === next.language && previous.disabled === next.disabled && previous.select === next.select);
