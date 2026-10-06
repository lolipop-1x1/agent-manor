import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretDown, X } from "@phosphor-icons/react";
import type { SessionMessage, SessionProfile, SessionTimelineEvent } from "../src/session-contracts";
import { MessageBody, kindLabels, resourceLabels } from "./SessionMessage";
import { TraceTimeline } from "./TraceTimeline";
import { HelpPopover } from "./HelpPopover";
import { displayRecorded, turnTitle } from "./session-model";
import { TRACE_ROW_HEIGHT, tracePreview, traceTurns, traceWindow, type TraceRecord } from "./session-trace-model";
import "./session-trace.css";

const statuses = { success: "成功", failure: "失败", unknown: "未知" };
const tokenFields = [
  ["inputTokens", "输入"], ["cachedInputTokens", "缓存读取"], ["cacheWriteTokens", "缓存写入"],
  ["outputTokens", "输出"], ["reasoningOutputTokens", "推理输出"], ["contextTokens", "上下文"],
] as const;
const timeLabel = (value?: string) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "时间未记录";
type Entry = { turnId: string; title: string; record?: TraceRecord; count: number };

export function SessionTrace({ messages, steps, focusMessageId, focusRequest, focusTurnId, project, timeline, timelineLoading, timelineError, onRetryTimeline, onTimelineSelect, onMap, onInspect, onViewTurn }: {
  messages: SessionMessage[]; steps: SessionProfile["steps"]; focusMessageId?: string; focusRequest: number; focusTurnId?: string; project?: string;
  onMap: (path?: string, project?: string) => void; onInspect: (message: SessionMessage) => void; onViewTurn: (id: string) => void;
  timeline: SessionTimelineEvent[]; timelineLoading: boolean; timelineError?: string; onRetryTimeline: () => void; onTimelineSelect: (event: SessionTimelineEvent) => void;
}) {
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
  }), [turns, collapsed]);
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

  return <section className="session-trace" aria-label="执行轨迹">
    <TraceTimeline events={timeline} selectedId={selectedId} loading={timelineLoading} error={timelineError} onSelect={onTimelineSelect} onRetry={onRetryTimeline} />
    <div className="trace-toolbar"><span><strong>{records.length.toLocaleString("zh-CN")}</strong> 个执行节点 <small>· 本页 {messages.length.toLocaleString("zh-CN")} 条原始记录</small></span>
      <div><HelpPopover label="轨迹说明"><dl><div><dt>轨迹总览</dt><dd>按事件顺序、轮次或记录时间排列，点击轨道定位节点，← → 切换节点。上下文、模型和工具分别呈现在轨道中。</dd></div>
        <div><dt>执行节点</dt><dd>选择节点查看正文与关联结果，↑ ↓ 切换节点。仅展示已保存的事件，用量仅关联已返回的明细。</dd></div>
        <div><dt>上下文记录</dt><dd>AGENTS.md、环境与客户端上下文注入不计为用户提问；保留识别依据与原始角色供核对。本地 Hook 记录不计为模型工具调用。</dd></div></dl></HelpPopover><button className="text-button" onClick={() => setCollapsed(new Set())}>展开全部</button><button className="text-button" onClick={() => setCollapsed(new Set(turns.map(turn => turn.id)))}>折叠全部</button></div></div>
    <div className="trace-ledger" role="table" aria-label="事件轨迹表" aria-rowcount={entries.length + 1} aria-colcount={6}>
      <div className="trace-columns" role="row"><span role="columnheader">序号</span><span role="columnheader">事件 / 模型</span><span role="columnheader">输入 / 参数</span><span role="columnheader">输出 / 结果</span><span role="columnheader">时间 / 耗时</span><span role="columnheader">Token 输入 / 输出</span></div>
      <div ref={viewport} className="trace-ledger-scroll" role="rowgroup" onScroll={event => {
        const top = event.currentTarget.scrollTop; setScroll(top);
        const entry = entries[Math.floor(top / TRACE_ROW_HEIGHT)]; if (entry) onViewTurn(entry.turnId);
      }}>
        <div aria-hidden="true" style={{ height: window.start * TRACE_ROW_HEIGHT }} />
        {entries.slice(window.start, window.end).map((entry, offset) => {
          const index = window.start + offset, record = entry.record;
          if (!record) return <div id={`session-turn-${entry.turnId}`} key={`turn-${entry.turnId}`} className={`trace-group${entry.turnId === activeTurn ? " is-active" : ""}`} role="row" aria-rowindex={index + 2}>
            <div role="cell" aria-colspan={6}><button aria-expanded={!collapsed.has(entry.turnId)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(entry.turnId)) next.delete(entry.turnId); else next.add(entry.turnId); return next; })}>
              <CaretDown size={13} aria-hidden="true" /><strong>{entry.title}</strong><small>{entry.count} 条记录</small><span>{tracePreview(turns.find(turn => turn.id === entry.turnId)?.messages.find(message => message.kind === "user")?.text ?? "上下文及过程记录")}</span>
            </button></div></div>;
          const { message, result, usage } = record;
          const value = usage.length === 1 ? usage[0] : undefined;
          const isTool = message.kind === "tool_call" || message.kind === "tool_result";
          const input = message.kind === "assistant" || message.kind === "thinking" || message.kind === "tool_result" ? "—" : tracePreview(message.text);
          const output = result ? tracePreview(result.text) : message.kind === "tool_call" ? "结果未记录" : input === "—" ? tracePreview(message.text) : "—";
          const status = result?.status ?? message.status;
          const duration = result?.durationMs ?? message.durationMs;
          const active = record === selected;
          return <div key={message.id} role="row" aria-rowindex={index + 2} aria-selected={active} className={`trace-row kind-${message.kind}${active ? " is-selected" : ""}`} onClick={() => inspect(message)}>
            <span role="cell" className="trace-ordinal">#{message.ordinal}</span>
            <div role="cell" className="trace-event"><button id={`trace-select-${message.id}`} aria-label={`查看记录 ${message.ordinal}：${isTool ? message.tool ?? "工具" : kindLabels[message.kind]}`} onClick={event => { event.stopPropagation(); inspect(message); }} onKeyDown={event => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveSelection(index, event.key); }
            }}><i aria-hidden="true" /><span><strong>{isTool ? message.tool ?? "工具" : usage.length ? "请求用量" : kindLabels[message.kind]}</strong><small>{status ? statuses[status] : message.final ? "最终回答" : message.model ?? ""}</small></span></button></div>
            <span role="cell" className="trace-preview" title={input}>{input}</span>
            <span role="cell" className={`trace-preview${status === "failure" ? " is-failure" : ""}`} title={output}>{output}</span>
            <span role="cell" className="trace-facts" title={message.occurredAt}><span>{timeLabel(message.occurredAt)}</span><small>{duration === undefined ? "耗时未记录" : `${displayRecorded(duration)} ms`}</small></span>
            <span role="cell" className="trace-facts"><span>{value ? `${displayRecorded(value.inputTokens)} / ${displayRecorded(value.outputTokens)}` : usage.length ? `${usage.length} 条用量` : "—"}</span><small>{value?.cachedInputTokens !== undefined ? `缓存 ${displayRecorded(value.cachedInputTokens)}` : ""}</small></span>
          </div>;
        })}
        <div aria-hidden="true" style={{ height: (entries.length - window.end) * TRACE_ROW_HEIGHT }} />
      </div>
    </div>
    {selected && selectedMessage ? <section className="trace-inspector" aria-label="轨迹记录详情">
      <header><strong>#{selectedMessage.ordinal} · {selected.message.tool ?? kindLabels[selected.message.kind]}</strong><div role="tablist" aria-label="轨迹详情内容">
        {detailTabs.map(message => <button key={message.id} role="tab" aria-selected={selectedId === message.id} onClick={() => inspect(message)}>{message.kind === "tool_call" ? "输入参数" : message.kind === "tool_result" ? "返回结果" : "记录正文"}</button>)}
      </div><button className="icon-button" aria-label="收起轨迹详情" onClick={() => setSelectedId(undefined)}><X size={15} /></button></header>
      <div className="trace-inspector-scroll" key={selectedMessage.id}>
        <div className="trace-detail-meta"><span className={`session-kind kind-${selectedMessage.kind}`}>{kindLabels[selectedMessage.kind]}</span>{selectedMessage.model && <span>{selectedMessage.model}</span>}{selectedMessage.final && <span>{selectedMessage.final === "explicit" ? "明确最终回答" : "推断最终回答"}</span>}{selectedMessage.status && <span>{statuses[selectedMessage.status]}</span>}<time>{timeLabel(selectedMessage.occurredAt)}</time>
          <button className="text-button" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? "查看预览" : "原始正文"}</button></div>
        {selectedMessage.contextSource && <p className="trace-context-note">{selectedMessage.contextSource === "hook" ? "本地 Hook" : <>{selectedMessage.contextSource === "agents_md" ? "AGENTS.md 指令注入" : selectedMessage.contextSource === "environment" ? "环境上下文注入" : "客户端上下文注入"} · {selectedMessage.contextEvidence === "client_metadata" ? "明确标记" : "推断"}</>}</p>}
        <details className="trace-source"><summary>记录来源 · 第 {selectedMessage.recordLine} 条</summary><div>消息序号 {selectedMessage.ordinal}{selectedMessage.callId && <> · 调用 {selectedMessage.callId}</>}</div>{selectedMessage.contextSource && <div>原始角色：{selectedMessage.contextSource === "hook" ? "attachment" : "user"}</div>}{selectedMessage.resource && <div>{resourceLabels[selectedMessage.resource.kind]} · {selectedMessage.resource.name}</div>}</details>
        {!!selected.usage.length && <div className="trace-usage">{selected.usage.map(usage => <div key={usage.id}><strong>{usage.model ?? "模型未记录"} · 用量记录</strong>{tokenFields.map(([key, label]) => <span key={key}>{label} <b>{displayRecorded(usage[key])}</b></span>)}</div>)}</div>}
        <article id={`session-message-${selectedMessage.id}`} className={`trace-detail-body kind-${selectedMessage.kind}`} data-message-id={selectedMessage.id}>
          {raw ? <pre className="trace-raw-content">{selectedMessage.text || "（没有正文）"}</pre> : <MessageBody message={selectedMessage} focused flat project={project} onMap={onMap} />}
        </article>
        {!!linkedFiles.length && <details className="session-file-links"><summary>关联调用文件 · {linkedFiles.length}</summary><div>
          {linkedFiles.map(path => <button className="session-file-link" key={path} onClick={() => onMap(path, project)}>{path}</button>)}
        </div></details>}
      </div>
    </section> : <p className="trace-hint">选择一个执行节点</p>}
  </section>;
}
