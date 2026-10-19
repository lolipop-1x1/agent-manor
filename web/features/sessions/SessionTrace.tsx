import { Loading } from "../../shared/ui/Loading";
import { getLanguage, t, useI18n } from "../../shared/i18n";
import { formatNumber, formatTime } from "../../../src/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowsOut, ArrowLeft, CaretDown, CaretLeft, CaretRight, X } from "@phosphor-icons/react";
import type { SessionMessage, SessionMessageResult, SessionProfile, SessionTimelineEvent, SessionTimelineResult } from "../../../src/session-contracts";
import { MessageBody, kindLabels, resourceLabels } from "./SessionMessage";
import { TraceTimeline } from "./TraceTimeline";
import { CopyButton } from "./SessionCopy";
import { Highlight } from "./SessionSearchGroups";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { displayRecorded, sessionResourceName, sessionMessageText, sessionOperationLabel, turnTitle } from "./session-model";
import { TRACE_ROW_HEIGHT, traceAnchoredScroll, tracePreview, traceRecordPreview, traceTurns, traceWindow, type TraceRecord } from "./session-trace-model";
import "./session-trace.css";
import { AverageSpeedBadge, RequestSpeedBadge, SpeedColumnHeader } from "./SessionSpeed";
import { messageSpeedRequest, type SessionSpeedMap } from "./session-speed-model";
import { completeMessage, completeTurnMarkdown } from "./session-message-content";
import { isAborted, } from "../../shared/api";
import { SessionError } from "./SessionControls";
import type { useContinuousReading } from "./useContinuousReading";

const statuses = { success: "sessions.status.success", failure: "sessions.status.failure", unknown: "sessions.status.unknown" };
const tokenFields = [
  ["inputTokens", "sessions.usage.input"], ["cachedInputTokens", "sessions.usage.cachedInput"], ["cacheWriteTokens", "sessions.usage.cacheWrite"],
  ["outputTokens", "sessions.usage.output"], ["reasoningOutputTokens", "sessions.usage.reasoning"], ["contextTokens", "sessions.kind.context"],
] as const;
const timeLabel = (value?: string) => value ? formatTime(getLanguage(), value) : "";
type Entry = { turnId: string; title: string; record?: TraceRecord; count: number };

export function SessionTrace({ messages, steps, focusMessageId, focusRequest, focusTurnId, project, query = "", timeline, timelineLoading, timelineError, onRetryTimeline, onTimelineSelect, onMap, onInspect, onViewTurn, speed, onFocusStep, version, branch, turnDirectory, toolPairs, relatedMessages, pane: viewport, reading }: {
  pane: RefObject<HTMLDivElement | null>;
  reading: Pick<ReturnType<typeof useContinuousReading>, "loading" | "error" | "errorDirection" | "load" | "onScroll" | "onWheel">;
  speed: SessionSpeedMap; onFocusStep: (step: SessionProfile["steps"][number]) => void;
  messages: SessionMessage[]; steps: SessionProfile["steps"]; focusMessageId?: string; focusRequest: number; focusTurnId?: string; project?: string; query?: string;
  onMap: (path?: string, project?: string) => void; onInspect: (message: SessionMessage) => void; onViewTurn: (id: string, messageId?: string) => void;
  timeline?: SessionTimelineResult; timelineLoading: boolean; timelineError?: Error; onRetryTimeline: () => void; onTimelineSelect: (event: SessionTimelineEvent) => void;
  version: string; branch?: string; turnDirectory?: SessionMessageResult["turns"]; toolPairs?: SessionMessageResult["toolPairs"]; relatedMessages?: SessionMessage[];
}) {
  const { language } = useI18n();
  const turns = useMemo(() => traceTurns(messages, steps.filter(step => step.sessionId === messages[0]?.sessionId), toolPairs, relatedMessages), [messages, steps, toolPairs, relatedMessages]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState(focusMessageId);
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailPercent, setDetailPercent] = useState(() => {
    try {
      const saved = localStorage.getItem("agent-manor:trace-detail-percent");
      const value = saved === null ? 48 : Number(saved);
      return Number.isFinite(value) ? Math.min(75, Math.max(25, value)) : 48;
    } catch { return 48; }
  });
  const split = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const savedScroll = useRef(0);
  const drag = useRef<{ id: number; y: number; percent: number; height: number } | undefined>(undefined);
  useEffect(() => {
    try { localStorage.setItem("agent-manor:trace-detail-percent", String(detailPercent)); }
    catch { /* 存储不可用时保留本次会话中的比例。 */ }
  }, [detailPercent]);
  const [activeTurn, setActiveTurn] = useState(focusTurnId);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const programmaticScroll = useRef(false);
  const pendingScroll = useRef<string | undefined>(focusMessageId);
  const alignScroll = useRef(true);
  const records = useMemo(() => turns.flatMap(turn => turn.records), [turns]);
  const selected = records.find(record => record.message.id === selectedId || record.result?.id === selectedId);
  useEffect(() => { if (!selected) setExpanded(false); }, [selected]);
  const previewMessage = selected?.result?.id === selectedId ? selected?.result : selected?.message;
  const [completeDetail, setCompleteDetail] = useState<{ version: string; message: SessionMessage }>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<Error>();
  const [detailRetry, setDetailRetry] = useState(0);
  useEffect(() => {
    if (!previewMessage?.textTruncated) { setDetailLoading(false); setDetailError(undefined); return; }
    const controller = new AbortController(); setDetailLoading(true); setDetailError(undefined);
    void completeMessage(previewMessage, version, controller.signal).then(message => { if (!controller.signal.aborted) setCompleteDetail({ version, message }); })
      .catch(error => { if (!controller.signal.aborted && !isAborted(error)) setDetailError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [previewMessage, version, detailRetry]);
  const selectedMessage = completeDetail?.version === version && completeDetail.message.id === previewMessage?.id ? completeDetail.message : previewMessage;
  const entries = useMemo(() => turns.flatMap((turn, position): Entry[] => {
    const directory = turnDirectory?.find(item => item.id === turn.id);
    const group = { turnId: turn.id, title: turnTitle(turn.id, directory?.position ?? position + 1), count: directory?.messageCount ?? turn.messages.length };
    return [group, ...(collapsed.has(turn.id) ? [] : turn.records.map(record => ({ ...group, record })))];
  }), [turns, collapsed, language, turnDirectory]);
  const window = traceWindow(entries.length, scroll, height);
  const previousEntries = useRef(entries);
  useLayoutEffect(() => {
    const previous = previousEntries.current;
    previousEntries.current = entries;
    const node = viewport.current;
    if (!node || pendingScroll.current || previous === entries) return;
    const key = (entry: Entry) => entry.record ? `record:${entry.record.message.id}` : `turn:${entry.turnId}`;
    // 虚拟行可能暂时不在 DOM 中，按稳定节点身份恢复行内位置。
    const top = traceAnchoredScroll(previous.map(key), entries.map(key), scroll, node.clientHeight);
    // 保留短页原有的尾部空白，使补入前文后的节点仍能停在原位置。
    node.style.setProperty("--trace-tail-space", `${Math.max(0, top + node.clientHeight - entries.length * TRACE_ROW_HEIGHT)}px`);
    if (top !== node.scrollTop) { programmaticScroll.current = true; node.scrollTop = top; }
    setScroll(node.scrollTop);
  }, [entries]);
  useLayoutEffect(() => {
    const entry = entries[Math.floor(scroll / TRACE_ROW_HEIGHT)];
    if (entry) onViewTurn(entry.turnId, entry.record?.message.id ?? turns.find(turn => turn.id === entry.turnId)?.messages[0]?.id);
  }, [entries, scroll]);

  useLayoutEffect(() => {
    setSelectedId(focusMessageId);
    pendingScroll.current = focusMessageId ?? focusTurnId;
    alignScroll.current = true;
  }, [focusMessageId, focusRequest, focusTurnId]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    const observer = new ResizeObserver(() => { if (node.clientHeight > 0) { setHeight(node.clientHeight); setScroll(node.scrollTop); } });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const id = pendingScroll.current, node = viewport.current;
    if (!id || !node || expanded) return;
    const pendingTurn = turns.find(turn => turn.id === id || turn.records.some(record => record.message.id === id || record.result?.id === id));
    if (pendingTurn) setActiveTurn(pendingTurn.id);
    if (pendingTurn && collapsed.has(pendingTurn.id)) {
      setCollapsed(current => { const next = new Set(current); next.delete(pendingTurn.id); return next; }); return;
    }
    const index = entries.findIndex(entry => entry.record?.message.id === id || entry.record?.result?.id === id || !entry.record && entry.turnId === id);
    if (index < 0) return;
    const top = index * TRACE_ROW_HEIGHT;
    if (alignScroll.current || top < node.scrollTop || top + TRACE_ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      if (node.scrollTop !== top) { programmaticScroll.current = true; node.scrollTop = top; }
    }
    setScroll(node.scrollTop); pendingScroll.current = undefined;
  }, [entries, selectedId, height, focusRequest, collapsed, expanded]);

  const inspect = (message: SessionMessage) => {
    setSelectedId(message.id); setActiveTurn(message.turnId); pendingScroll.current = message.id; alignScroll.current = false; onInspect(message);
  };
  const moveSelection = (index: number, key: string) => {
    const content = entries.map((entry, position) => ({ entry, position })).filter(value => value.entry.record);
    const target = key === "Home" ? content[0] : key === "End" ? content.at(-1)
      : key === "ArrowDown" ? content.find(value => value.position > index) : [...content].reverse().find(value => value.position < index);
    if (target?.entry.record) {
      inspect(target.entry.record.message);
      requestAnimationFrame(() => document.getElementById(`trace-select-${target.entry.record!.message.id}`)?.focus());
    }
  };
  const returnToTrace = () => {
    pendingScroll.current = undefined;
    setExpanded(false);
    requestAnimationFrame(() => {
      if (viewport.current) { programmaticScroll.current = true; viewport.current.scrollTop = savedScroll.current; }
      setScroll(savedScroll.current);
      expandButton.current?.focus({ preventScroll: true });
    });
  };
  const selectedIndex = selected ? records.indexOf(selected) : -1;
  const navigateDetail = (offset: number) => {
    const record = records[selectedIndex + offset];
    if (record) inspect(record.message);
  };
  const hasTiming = records.some(record => record.message.occurredAt || record.message.durationMs !== undefined || record.result?.durationMs !== undefined);
  const hasUsage = records.some(record => record.usage.some(usage => tokenFields.some(([key]) => usage[key] !== undefined)));
  const hasSpeed = speed.summary.requests > 0;
  const selectedRequest = selectedMessage && messageSpeedRequest(selectedMessage, speed);
  const columnCount = 4 + Number(hasSpeed) + Number(hasTiming) + Number(hasUsage);
  const columns = `48px 145px minmax(130px, 1fr) minmax(130px, 1fr)${hasSpeed ? " 100px" : ""}${hasTiming ? " 100px" : ""}${hasUsage ? " 130px" : ""}`;
  const ledgerStyle = { "--trace-columns": columns, "--trace-min-width": `${480 + (hasSpeed ? 100 : 0) + (hasTiming ? 100 : 0) + (hasUsage ? 130 : 0)}px` } as CSSProperties;
  const detailTabs = selected ? [selected.message, ...(selected.result ? [selected.result] : [])] : [];
  const linkedFiles = [...new Set(detailTabs.flatMap(message => message.filePaths ?? []))];

  return <section className={`session-trace${expanded && selected ? " is-detail-expanded" : ""}`} aria-label={t("sessions.trace.title")} onKeyDown={event => {
    if (event.key === "Escape" && expanded && !event.defaultPrevented) { event.preventDefault(); returnToTrace(); }
  }}>
    <div className="trace-timeline-shell" inert={expanded && !!selected}>
    <TraceTimeline data={timeline} sessionId={messages[0]?.sessionId} selectedId={selectedId} loading={timelineLoading} error={timelineError} onSelect={onTimelineSelect} onRetry={onRetryTimeline} />
    </div>
    <div ref={split} className="trace-split" style={{ "--trace-detail-percent": detailPercent } as CSSProperties}>
    <div className="trace-upper" inert={expanded && !!selected}>
    <div className="trace-toolbar"><span><strong>{t("sessions.trace.nodeCount", { count: records.length })}</strong> <small>· {t("sessions.trace.pageRecords", { count: messages.length })}</small></span>
      {reading.loading && <span className="trace-reading-progress" role="status" aria-label={t("common.loading")}><Loading variant="inline" size={14} /></span>}
      <div><HelpPopover iconOnly label={t("sessions.trace.help")}><dl><div><dt>{t("sessions.trace.overview")}</dt><dd>{t("sessions.trace.overviewHelp")}</dd></div>
        <div><dt>{t("sessions.trace.nodes")}</dt><dd>{t("sessions.trace.nodesHelp")}</dd></div>
        <div><dt>{t("sessions.trace.contextRecords")}</dt><dd>{t("sessions.trace.contextHelp")}</dd></div></dl></HelpPopover><button className="text-button" onClick={() => setCollapsed(new Set())}>{t("sessions.trace.expandAll")}</button><button className="text-button" onClick={() => setCollapsed(new Set(turns.map(turn => turn.id)))}>{t("sessions.trace.collapseAll")}</button></div></div>
    <div className="trace-ledger" role="table" aria-label={t("sessions.trace.table")} aria-rowcount={entries.length + 1} aria-colcount={columnCount} style={ledgerStyle}>
      <div className="trace-columns" role="row"><span role="columnheader">{t("sessions.trace.ordinal")}</span><span role="columnheader">{t("sessions.trace.eventModel")}</span><span role="columnheader">{t("sessions.trace.inputParams")}</span><span role="columnheader">{t("sessions.trace.outputResult")}</span>{hasSpeed && <span role="columnheader" aria-label={t("sessions.speed.label")}><SpeedColumnHeader /></span>}{hasTiming && <span role="columnheader">{t("sessions.trace.timeDuration")}</span>}{hasUsage && <span role="columnheader">{t("sessions.trace.tokenInOut")}</span>}</div>
      <div ref={viewport} className="trace-ledger-scroll" role="rowgroup" tabIndex={-1} onWheel={event => {
        if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) reading.onWheel(event.deltaY);
      }} onScroll={event => {
        const top = event.currentTarget.scrollTop; setScroll(top);
        reading.onScroll(programmaticScroll.current); programmaticScroll.current = false;
      }}>
        <div aria-hidden="true" style={{ height: window.start * TRACE_ROW_HEIGHT }} />
        {entries.slice(window.start, window.end).map((entry, offset) => {
          const index = window.start + offset, record = entry.record;
          if (!record) {
            const user = turns.find(turn => turn.id === entry.turnId)?.messages.find(message => message.kind === "user");
            return <div id={`session-turn-${entry.turnId}`} key={`turn-${entry.turnId}`} className={`trace-group${entry.turnId === activeTurn ? " is-active" : ""}`} role="row" aria-rowindex={index + 2}>
            <div role="cell" aria-colspan={columnCount}><button className="trace-turn-toggle" aria-expanded={!collapsed.has(entry.turnId)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(entry.turnId)) next.delete(entry.turnId); else next.add(entry.turnId); return next; })}>
              <CaretDown size={13} aria-hidden="true" /><strong>{entry.title}</strong><small>{t("sessions.recordCount", { count: entry.count })}</small>
            </button><AverageSpeedBadge summary={speed.byTurn.get(entry.turnId)} /><span className="trace-turn-preview">{tracePreview(user ? sessionMessageText(user) : t("sessions.trace.contextProcess"))}</span><CopyButton text="" getText={() => completeTurnMarkdown(messages[0]!.sessionId, entry.turnId,
              turnDirectory?.find(turn => turn.id === entry.turnId)?.position, { version, mode: "full", branch }, language)} label={t("sessions.copy.turn")} /></div></div>;
          }
          const { message, result, usage } = record;
          const value = usage.length === 1 ? usage[0] : undefined;
          const isTool = message.kind === "tool_call" || message.kind === "tool_result";
          const { input, output } = traceRecordPreview(record);
          const name = message.operation ? sessionOperationLabel(message.operation) : isTool ? message.tool ?? t("sessions.message.tool") : usage.length ? t("sessions.trace.usageRequest") : t(kindLabels[message.kind]);
          const status = message.operation ? "unknown" : result?.status ?? message.status;
          const duration = result?.durationMs ?? message.durationMs;
          const active = record === selected;
          const request = messageSpeedRequest(message, speed);
          return <div key={message.id} role="row" aria-rowindex={index + 2} aria-selected={active} className={`trace-row kind-${message.kind}${message.operation ? " is-operation" : ""}${active ? " is-selected" : ""}`} onClick={() => inspect(message)}>
            <span role="cell" className="trace-ordinal">#{formatNumber(getLanguage(), message.ordinal)}</span>
            <div role="cell" className="trace-event"><button id={`trace-select-${message.id}`} aria-label={t("sessions.trace.viewRecord", { number: formatNumber(getLanguage(), message.ordinal), name })} onClick={event => { event.stopPropagation(); inspect(message); }} onKeyDown={event => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveSelection(index, event.key); }
            }}><i aria-hidden="true" /><span><strong>{name}</strong><small>{message.operation ? t("sessions.operation.resultUnknown") : status ? t(statuses[status]) : message.final ? t("sessions.message.final") : message.model ?? ""}</small></span></button></div>
            <span role="cell" className="trace-preview" title={input}>{input}</span>
            <span role="cell" className={`trace-preview${status === "failure" ? " is-failure" : ""}`} title={output}>{output}</span>
            {hasSpeed && <span role="cell">{request ? <RequestSpeedBadge usage={request} compact onLocate={messageId => onFocusStep({ ...request, messageId })} /> : "—"}</span>}
            {hasTiming && <span role="cell" className="trace-facts" title={message.occurredAt}><span>{timeLabel(message.occurredAt)}</span>{duration !== undefined && <small>{displayRecorded(duration)} ms</small>}</span>}
            {hasUsage && <span role="cell" className="trace-facts"><span>{value ? `${value.inputTokens === undefined ? "—" : displayRecorded(value.inputTokens)} / ${value.outputTokens === undefined ? "—" : displayRecorded(value.outputTokens)}` : usage.length ? t("sessions.usage.recordCount", { count: usage.length }) : "—"}</span><small>{value?.cachedInputTokens !== undefined ? t("sessions.trace.cache", { value: displayRecorded(value.cachedInputTokens) }) : ""}</small></span>}
          </div>;
        })}
        <div aria-hidden="true" style={{ height: `calc(${(entries.length - window.end) * TRACE_ROW_HEIGHT}px + var(--trace-tail-space, 0px))` }} />
      </div>
    </div>
    {reading.error && <div className="trace-reading-error" role="alert"><SessionError error={reading.error} /><button className="text-button" onClick={() => void reading.load(reading.errorDirection ?? "later")}>{t("common.retry")}</button></div>}
    </div>
    {selected && selectedMessage ? <>
      <div className="trace-detail-resizer" role="separator" tabIndex={expanded ? -1 : 0} aria-label={t("sessions.trace.resizeDetails")}
        aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(100 - detailPercent)}
        onPointerDown={event => {
          if (event.button !== 0 || !split.current) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, y: event.clientY, percent: detailPercent, height: split.current.clientHeight - 10 };
        }} onPointerMove={event => {
          const start = drag.current;
          if (start?.id === event.pointerId && start.height > 0) setDetailPercent(Math.max(25, Math.min(75, start.percent - (event.clientY - start.y) / start.height * 100)));
        }} onPointerUp={event => {
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
        onKeyDown={event => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setDetailPercent(current => event.key === "Home" ? 75 : event.key === "End" ? 25 : Math.max(25, Math.min(75, current + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 2))));
        }} />
      <div className="trace-detail-slot">
      <section className="trace-inspector" aria-label={t("sessions.trace.detail")}>
      {expanded && <nav className="trace-detail-navigation" aria-label={t("sessions.trace.detail")}>
        <button ref={backButton} className="text-button" onClick={returnToTrace}><ArrowLeft size={14} aria-hidden="true" />{t("sessions.trace.backToTrace")}</button>
        <div><button className="text-button" disabled={selectedIndex <= 0} onClick={() => navigateDetail(-1)}><CaretLeft size={14} aria-hidden="true" />{t("sessions.trace.previousNode")}</button>
        <button className="text-button" disabled={selectedIndex >= records.length - 1} onClick={() => navigateDetail(1)}>{t("sessions.trace.nextNode")}<CaretRight size={14} aria-hidden="true" /></button></div>
      </nav>}
      <header>
        <div className="trace-detail-heading"><strong>#{formatNumber(getLanguage(), selectedMessage.ordinal)} · {selectedMessage.operation ? sessionOperationLabel(selectedMessage.operation) : selected.message.tool ?? t(kindLabels[selected.message.kind])}</strong>
          <div className="trace-detail-meta">{selectedMessage.model && <span>{selectedMessage.model}</span>}{selectedMessage.final && <span>{selectedMessage.final === "explicit" ? t("sessions.message.finalExplicit") : t("sessions.message.finalInferred")}</span>}
            {selectedMessage.operation ? <span>{t("sessions.operation.resultUnknown")}</span> : (selected.result?.status ?? selectedMessage.status) && <span className={(selected.result?.status ?? selectedMessage.status) === "failure" ? "is-failure" : undefined}>{t(statuses[(selected.result?.status ?? selectedMessage.status)!])}</span>}
            {selected.message.kind === "tool_call" && !selected.result && <span>{t("sessions.trace.resultMissing")}</span>}
            {selectedMessage.occurredAt && <time>{timeLabel(selectedMessage.occurredAt)}</time>}
            {(selected.result?.durationMs ?? selectedMessage.durationMs) !== undefined && <span>{displayRecorded(selected.result?.durationMs ?? selectedMessage.durationMs)} ms</span>}
          </div>
        </div>
        {selectedRequest && <RequestSpeedBadge usage={selectedRequest} onLocate={messageId => onFocusStep({ ...selectedRequest, messageId })} />}
        <div className="trace-detail-actions">
          <CopyButton text={selectedMessage.text} getText={() => completeMessage(selectedMessage, version).then(message => message.text)} label={t("sessions.trace.copyBody")} />
          <button className="text-button" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? t("sessions.trace.preview") : t("sessions.trace.raw")}</button>
          {!expanded && <button ref={expandButton} className="icon-button" aria-label={t("sessions.trace.expandDetail")} onClick={() => {
            savedScroll.current = viewport.current?.scrollTop ?? scroll; setExpanded(true);
            requestAnimationFrame(() => backButton.current?.focus());
          }}><ArrowsOut size={15} aria-hidden="true" /></button>}
          <button className="icon-button" aria-label={t("sessions.trace.collapseDetails")} onClick={() => {
            const id = selected.message.id;
            if (expanded) returnToTrace();
            setSelectedId(undefined);
            requestAnimationFrame(() => (document.getElementById(`trace-select-${id}`) ?? viewport.current)?.focus({ preventScroll: true }));
          }}><X size={15} aria-hidden="true" /></button>
        </div>
      </header>
      {(detailTabs.length > 1 || selected.message.kind === "tool_call" || selected.message.kind === "tool_result") && <div className="trace-detail-tabs" role="tablist" aria-label={t("sessions.trace.detailTabs")}>
        {detailTabs.map(message => <button key={message.id} role="tab" aria-selected={selectedId === message.id} onClick={() => inspect(message)}>{message.kind === "tool_call" ? t("sessions.trace.input") : message.kind === "tool_result" ? t("sessions.trace.result") : t("sessions.trace.body")}</button>)}
      </div>}
      <div className="trace-inspector-scroll" key={selectedMessage.id}>
        <details className="trace-source"><summary>{t("sessions.trace.sourceRecord", { number: formatNumber(getLanguage(), selectedMessage.recordLine) })}</summary>
          <div>{t("sessions.trace.messageOrdinal", { number: formatNumber(getLanguage(), selectedMessage.ordinal) })}{selectedMessage.callId && <> · {t("sessions.message.callId", { id: selectedMessage.callId })}</>}</div>
          {selectedMessage.contextSource && <><p className="trace-context-note">{selectedMessage.contextSource === "hook" ? t("sessions.context.hook") : <>{selectedMessage.contextSource === "agents_md" ? t("sessions.context.agentsInstructions") : selectedMessage.contextSource === "environment" ? t("sessions.context.environment") : t("sessions.context.client")} · {selectedMessage.contextEvidence === "client_metadata" ? t("sessions.context.explicit") : t("sessions.context.inferred")}</>}</p>
            <div>{t("sessions.trace.originalRole", { role: selectedMessage.contextSource === "hook" ? "attachment" : "user" })}</div></>}
          {selectedMessage.resource && <div>{t(resourceLabels[selectedMessage.resource.kind])} · {sessionResourceName(selectedMessage.resource)}</div>}
        </details>
        {!!selected.usage.length && <div className="trace-usage">{selected.usage.map(usage => <div key={usage.id}>{usage.model && <strong>{t("sessions.trace.usageModel", { model: usage.model })}</strong>}{tokenFields.filter(([key]) => usage[key] !== undefined).map(([key, label]) => <span key={key}>{t(label)} <b>{displayRecorded(usage[key])}</b></span>)}</div>)}</div>}
        {detailLoading && <p role="status"><Loading variant="inline" size={16} />{t("sessions.body.loading")}</p>}
        {detailError && <p role="alert"><SessionError error={detailError} /> <button className="text-button" onClick={() => setDetailRetry(value => value + 1)}>{t("common.retry")}</button></p>}
        <article id={`session-message-${selectedMessage.id}`} className={`trace-detail-body kind-${selectedMessage.kind}`} data-message-id={selectedMessage.id}>
          {selectedMessage.operation?.label && <p className="session-operation-title">{selectedMessage.operation.label}</p>}
          {raw ? <pre className="trace-raw-content"><Highlight text={selectedMessage.text || t("sessions.body.emptyRaw")} query={query} /></pre> : <MessageBody message={selectedMessage} focused={!selectedMessage.textTruncated} flat query={query} project={project} onMap={onMap} version={version} />}
        </article>
        {!!linkedFiles.length && <details className="session-file-links"><summary>{t("sessions.trace.linkedFiles", { count: linkedFiles.length })}</summary><div>
          {linkedFiles.map(path => <button className="session-file-link" key={path} onClick={() => onMap(path, project)}>{path}</button>)}
        </div></details>}
      </div>
    </section></div></> : <p className="trace-hint">{t("sessions.trace.select")}</p>}
    </div>
  </section>;
}
