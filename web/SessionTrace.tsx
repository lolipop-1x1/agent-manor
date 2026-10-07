import { getLanguage, t, useI18n } from "./i18n";
import { formatNumber, formatTime } from "../src/i18n";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretDown, X } from "@phosphor-icons/react";
import type { SessionMessage, SessionProfile, SessionTimelineEvent } from "../src/session-contracts";
import { MessageBody, kindLabels, resourceLabels } from "./SessionMessage";
import { TraceTimeline } from "./TraceTimeline";
import { HelpPopover } from "./HelpPopover";
import { displayRecorded, sessionResourceName, sessionMessageText, turnTitle } from "./session-model";
import { TRACE_ROW_HEIGHT, tracePreview, traceTurns, traceWindow, type TraceRecord } from "./session-trace-model";
import "./session-trace.css";

const statuses = { success: "sessions.status.success", failure: "sessions.status.failure", unknown: "sessions.status.unknown" };
const tokenFields = [
  ["inputTokens", "sessions.usage.input"], ["cachedInputTokens", "sessions.usage.cachedInput"], ["cacheWriteTokens", "sessions.usage.cacheWrite"],
  ["outputTokens", "sessions.usage.output"], ["reasoningOutputTokens", "sessions.usage.reasoning"], ["contextTokens", "sessions.kind.context"],
] as const;
const timeLabel = (value?: string) => value ? formatTime(getLanguage(), value) : t("sessions.message.timeMissing");
type Entry = { turnId: string; title: string; record?: TraceRecord; count: number };

export function SessionTrace({ messages, steps, focusMessageId, focusRequest, focusTurnId, project, timeline, timelineLoading, timelineError, onRetryTimeline, onTimelineSelect, onMap, onInspect, onViewTurn }: {
  messages: SessionMessage[]; steps: SessionProfile["steps"]; focusMessageId?: string; focusRequest: number; focusTurnId?: string; project?: string;
  onMap: (path?: string, project?: string) => void; onInspect: (message: SessionMessage) => void; onViewTurn: (id: string) => void;
  timeline: SessionTimelineEvent[]; timelineLoading: boolean; timelineError?: Error; onRetryTimeline: () => void; onTimelineSelect: (event: SessionTimelineEvent) => void;
}) {
  const { language } = useI18n();
  const turns = useMemo(() => traceTurns(messages, steps.filter(step => step.sessionId === messages[0]?.sessionId)), [messages, steps]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState(focusMessageId);
  const [raw, setRaw] = useState(false);
  const [activeTurn, setActiveTurn] = useState(focusTurnId);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | undefined>(focusMessageId);
  const alignScroll = useRef(true);
  const records = useMemo(() => turns.flatMap(turn => turn.records), [turns]);
  const selected = records.find(record => record.message.id === selectedId || record.result?.id === selectedId);
  const selectedMessage = selected?.result?.id === selectedId ? selected?.result : selected?.message;
  const entries = useMemo(() => turns.flatMap((turn, position): Entry[] => {
    const group = { turnId: turn.id, title: turnTitle(turn.id, position + 1), count: turn.messages.length };
    return [group, ...(collapsed.has(turn.id) ? [] : turn.records.map(record => ({ ...group, record })))];
  }), [turns, collapsed, language]);
  const window = traceWindow(entries.length, scroll, height);

  useLayoutEffect(() => {
    setSelectedId(focusMessageId);
    const turn = turns.find(value => focusMessageId ? value.messages.some(message => message.id === focusMessageId) : value.id === focusTurnId);
    if (!turn) return;
    pendingScroll.current = focusMessageId ?? focusTurnId;
    alignScroll.current = true; setActiveTurn(turn.id);
    setCollapsed(current => { const next = new Set(current); next.delete(turn.id); return next; });
  }, [focusMessageId, focusRequest, focusTurnId, messages]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    const observer = new ResizeObserver(() => { setHeight(node.clientHeight); setScroll(node.scrollTop); });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const id = pendingScroll.current, node = viewport.current;
    if (!id || !node) return;
    const pendingTurn = turns.find(turn => turn.id === id || turn.messages.some(message => message.id === id));
    if (pendingTurn && collapsed.has(pendingTurn.id)) return;
    const index = entries.findIndex(entry => entry.record?.message.id === id || entry.record?.result?.id === id || !entry.record && entry.turnId === id);
    if (index < 0) return;
    const top = index * TRACE_ROW_HEIGHT;
    if (alignScroll.current || top < node.scrollTop || top + TRACE_ROW_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTop = top;
    setScroll(node.scrollTop); pendingScroll.current = undefined;
  }, [entries, selectedId, height, focusRequest, collapsed]);

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
  const detailTabs = selected ? [selected.message, ...(selected.result ? [selected.result] : [])] : [];
  const linkedFiles = [...new Set(detailTabs.flatMap(message => message.filePaths ?? []))];

  return <section className="session-trace" aria-label={t("sessions.trace.title")}>
    <TraceTimeline events={timeline} selectedId={selectedId} loading={timelineLoading} error={timelineError} onSelect={onTimelineSelect} onRetry={onRetryTimeline} />
    <div className="trace-toolbar"><span><strong>{t("sessions.trace.nodeCount", { count: records.length })}</strong> <small>· {t("sessions.trace.pageRecords", { count: messages.length })}</small></span>
      <div><HelpPopover label={t("sessions.trace.help")}><dl><div><dt>{t("sessions.trace.overview")}</dt><dd>{t("sessions.trace.overviewHelp")}</dd></div>
        <div><dt>{t("sessions.trace.nodes")}</dt><dd>{t("sessions.trace.nodesHelp")}</dd></div>
        <div><dt>{t("sessions.trace.contextRecords")}</dt><dd>{t("sessions.trace.contextHelp")}</dd></div></dl></HelpPopover><button className="text-button" onClick={() => setCollapsed(new Set())}>{t("sessions.trace.expandAll")}</button><button className="text-button" onClick={() => setCollapsed(new Set(turns.map(turn => turn.id)))}>{t("sessions.trace.collapseAll")}</button></div></div>
    <div className="trace-ledger" role="table" aria-label={t("sessions.trace.table")} aria-rowcount={entries.length + 1} aria-colcount={6}>
      <div className="trace-columns" role="row"><span role="columnheader">{t("sessions.trace.ordinal")}</span><span role="columnheader">{t("sessions.trace.eventModel")}</span><span role="columnheader">{t("sessions.trace.inputParams")}</span><span role="columnheader">{t("sessions.trace.outputResult")}</span><span role="columnheader">{t("sessions.trace.timeDuration")}</span><span role="columnheader">{t("sessions.trace.tokenInOut")}</span></div>
      <div ref={viewport} className="trace-ledger-scroll" role="rowgroup" onScroll={event => {
        const top = event.currentTarget.scrollTop; setScroll(top);
        const entry = entries[Math.floor(top / TRACE_ROW_HEIGHT)]; if (entry) onViewTurn(entry.turnId);
      }}>
        <div aria-hidden="true" style={{ height: window.start * TRACE_ROW_HEIGHT }} />
        {entries.slice(window.start, window.end).map((entry, offset) => {
          const index = window.start + offset, record = entry.record;
          if (!record) {
            const user = turns.find(turn => turn.id === entry.turnId)?.messages.find(message => message.kind === "user");
            return <div id={`session-turn-${entry.turnId}`} key={`turn-${entry.turnId}`} className={`trace-group${entry.turnId === activeTurn ? " is-active" : ""}`} role="row" aria-rowindex={index + 2}>
            <div role="cell" aria-colspan={6}><button aria-expanded={!collapsed.has(entry.turnId)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(entry.turnId)) next.delete(entry.turnId); else next.add(entry.turnId); return next; })}>
              <CaretDown size={13} aria-hidden="true" /><strong>{entry.title}</strong><small>{t("sessions.recordCount", { count: entry.count })}</small><span>{tracePreview(user ? sessionMessageText(user) : t("sessions.trace.contextProcess"))}</span>
            </button></div></div>;
          }
          const { message, result, usage } = record;
          const value = usage.length === 1 ? usage[0] : undefined;
          const isTool = message.kind === "tool_call" || message.kind === "tool_result";
          const input = message.kind === "assistant" || message.kind === "thinking" || message.kind === "tool_result" ? "—" : tracePreview(sessionMessageText(message));
          const output = result ? tracePreview(sessionMessageText(result)) : message.kind === "tool_call" ? t("sessions.trace.resultMissing") : input === "—" ? tracePreview(sessionMessageText(message)) : "—";
          const status = result?.status ?? message.status;
          const duration = result?.durationMs ?? message.durationMs;
          const active = record === selected;
          return <div key={message.id} role="row" aria-rowindex={index + 2} aria-selected={active} className={`trace-row kind-${message.kind}${active ? " is-selected" : ""}`} onClick={() => inspect(message)}>
            <span role="cell" className="trace-ordinal">#{formatNumber(getLanguage(), message.ordinal)}</span>
            <div role="cell" className="trace-event"><button id={`trace-select-${message.id}`} aria-label={t("sessions.trace.viewRecord", { number: formatNumber(getLanguage(), message.ordinal), name: isTool ? message.tool ?? t("sessions.message.tool") : t(kindLabels[message.kind]) })} onClick={event => { event.stopPropagation(); inspect(message); }} onKeyDown={event => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveSelection(index, event.key); }
            }}><i aria-hidden="true" /><span><strong>{isTool ? message.tool ?? t("sessions.message.tool") : usage.length ? t("sessions.trace.usageRequest") : t(kindLabels[message.kind])}</strong><small>{status ? t(statuses[status]) : message.final ? t("sessions.message.final") : message.model ?? ""}</small></span></button></div>
            <span role="cell" className="trace-preview" title={input}>{input}</span>
            <span role="cell" className={`trace-preview${status === "failure" ? " is-failure" : ""}`} title={output}>{output}</span>
            <span role="cell" className="trace-facts" title={message.occurredAt}><span>{timeLabel(message.occurredAt)}</span><small>{duration === undefined ? t("sessions.trace.durationMissing") : `${displayRecorded(duration)} ms`}</small></span>
            <span role="cell" className="trace-facts"><span>{value ? `${displayRecorded(value.inputTokens)} / ${displayRecorded(value.outputTokens)}` : usage.length ? t("sessions.usage.recordCount", { count: usage.length }) : "—"}</span><small>{value?.cachedInputTokens !== undefined ? t("sessions.trace.cache", { value: displayRecorded(value.cachedInputTokens) }) : ""}</small></span>
          </div>;
        })}
        <div aria-hidden="true" style={{ height: (entries.length - window.end) * TRACE_ROW_HEIGHT }} />
      </div>
    </div>
    {selected && selectedMessage ? <section className="trace-inspector" aria-label={t("sessions.trace.detail")}>
      <header><strong>#{formatNumber(getLanguage(), selectedMessage.ordinal)} · {selected.message.tool ?? t(kindLabels[selected.message.kind])}</strong><div role="tablist" aria-label={t("sessions.trace.detailTabs")}>
        {detailTabs.map(message => <button key={message.id} role="tab" aria-selected={selectedId === message.id} onClick={() => inspect(message)}>{message.kind === "tool_call" ? t("sessions.trace.input") : message.kind === "tool_result" ? t("sessions.trace.result") : t("sessions.trace.body")}</button>)}
      </div><button className="icon-button" aria-label={t("sessions.trace.collapseDetails")} onClick={() => setSelectedId(undefined)}><X size={15} /></button></header>
      <div className="trace-inspector-scroll" key={selectedMessage.id}>
        <div className="trace-detail-meta"><span className={`session-kind kind-${selectedMessage.kind}`}>{t(kindLabels[selectedMessage.kind])}</span>{selectedMessage.model && <span>{selectedMessage.model}</span>}{selectedMessage.final && <span>{selectedMessage.final === "explicit" ? t("sessions.message.finalExplicit") : t("sessions.message.finalInferred")}</span>}{selectedMessage.status && <span>{t(statuses[selectedMessage.status])}</span>}<time>{timeLabel(selectedMessage.occurredAt)}</time>
          <button className="text-button" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? t("sessions.trace.preview") : t("sessions.trace.raw")}</button></div>
        {selectedMessage.contextSource && <p className="trace-context-note">{selectedMessage.contextSource === "hook" ? t("sessions.context.hook") : <>{selectedMessage.contextSource === "agents_md" ? t("sessions.context.agentsInstructions") : selectedMessage.contextSource === "environment" ? t("sessions.context.environment") : t("sessions.context.client")} · {selectedMessage.contextEvidence === "client_metadata" ? t("sessions.context.explicit") : t("sessions.context.inferred")}</>}</p>}
        <details className="trace-source"><summary>{t("sessions.trace.sourceRecord", { number: formatNumber(getLanguage(), selectedMessage.recordLine) })}</summary><div>{t("sessions.trace.messageOrdinal", { number: formatNumber(getLanguage(), selectedMessage.ordinal) })}{selectedMessage.callId && <> · {t("sessions.message.callId", { id: selectedMessage.callId })}</>}</div>{selectedMessage.contextSource && <div>{t("sessions.trace.originalRole", { role: selectedMessage.contextSource === "hook" ? "attachment" : "user" })}</div>}{selectedMessage.resource && <div>{t(resourceLabels[selectedMessage.resource.kind])} · {sessionResourceName(selectedMessage.resource)}</div>}</details>
        {!!selected.usage.length && <div className="trace-usage">{selected.usage.map(usage => <div key={usage.id}><strong>{t("sessions.trace.usageModel", { model: usage.model ?? t("sessions.trace.modelMissing") })}</strong>{tokenFields.map(([key, label]) => <span key={key}>{t(label)} <b>{displayRecorded(usage[key])}</b></span>)}</div>)}</div>}
        <article id={`session-message-${selectedMessage.id}`} className={`trace-detail-body kind-${selectedMessage.kind}`} data-message-id={selectedMessage.id}>
          {raw ? <pre className="trace-raw-content">{selectedMessage.text || t("sessions.body.emptyRaw")}</pre> : <MessageBody message={selectedMessage} focused flat project={project} onMap={onMap} />}
        </article>
        {!!linkedFiles.length && <details className="session-file-links"><summary>{t("sessions.trace.linkedFiles", { count: linkedFiles.length })}</summary><div>
          {linkedFiles.map(path => <button className="session-file-link" key={path} onClick={() => onMap(path, project)}>{path}</button>)}
        </div></details>}
      </div>
    </section> : <p className="trace-hint">{t("sessions.trace.select")}</p>}
  </section>;
}
