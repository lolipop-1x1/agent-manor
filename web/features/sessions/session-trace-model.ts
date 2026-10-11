import type { SessionMessage, SessionMessageResult, SessionTimelineEvent, SessionTimelineProjection, SessionUsage } from "../../../src/session-contracts";
import { groupedTurns } from "./session-model";
import { t } from "../../shared/i18n";

export interface TraceRecord {
  message: SessionMessage;
  result?: SessionMessage;
  usage: SessionUsage[];
}

function tracePairs<T extends SessionTimelineEvent>(messages: T[]) {
  const calls = new Map<string, T[]>(), results = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.callId || !["tool_call", "tool_result"].includes(message.kind)) continue;
    const key = `${message.sessionId}\0${message.turnId}\0${message.callId}`;
    const map = message.kind === "tool_call" ? calls : results;
    const values = map.get(key) ?? [];
    values.push(message); map.set(key, values);
  }
  const paired = new Map<string, T>(), consumed = new Set<string>();
  for (const [key, requests] of calls) {
    const responses = results.get(key);
    // 身份重复、顺序冲突或工具名称冲突时保留独立事件，不猜测关联。
    if (requests.length !== 1 || responses?.length !== 1) continue;
    const call = requests[0]!, result = responses[0]!;
    if (result.ordinal <= call.ordinal || call.tool && result.tool && call.tool !== result.tool) continue;
    paired.set(call.id, result); consumed.add(result.id);
  }
  return { paired, consumed };
}

export function traceTurns(messages: SessionMessage[], usages: SessionUsage[], toolPairs?: SessionMessageResult["toolPairs"], relatedMessages: SessionMessage[] = []) {
  const usageByMessage = new Map<string, SessionUsage[]>();
  for (const usage of usages) {
    if (!usage.messageId) continue;
    const values = usageByMessage.get(usage.messageId) ?? [];
    values.push(usage); usageByMessage.set(usage.messageId, values);
  }
  return groupedTurns(messages).map(turn => {
    const page = new Map(turn.messages.map(message => [message.id, message]));
    const available = new Map([...turn.messages, ...relatedMessages.filter(message => (message.turnId || "unknown") === turn.id)].map(message => [message.id, message]));
    const { paired, consumed } = toolPairs === undefined ? tracePairs(turn.messages) : { paired: new Map<string, SessionMessage>(), consumed: new Set<string>() };
    if (toolPairs) for (const pair of toolPairs) {
      const call = available.get(pair.callMessageId), result = available.get(pair.resultMessageId);
      if (!call || !result) continue;
      paired.set(call.id, result); consumed.add(result.id);
      // 本页只有结果时仍提供输入和结果两页详情，补充伙伴不扩张正文分页。
      if (page.has(result.id)) page.set(call.id, call);
    }
    const records: TraceRecord[] = [...page.values()].filter(message => !consumed.has(message.id)).sort((a, b) => a.ordinal - b.ordinal).map(message => {
      const result = paired.get(message.id);
      return { message, result, usage: [...(usageByMessage.get(message.id) ?? []), ...(result ? usageByMessage.get(result.id) ?? [] : [])] };
    });
    return { ...turn, records };
  });
}

export type TraceProjection = "sequence" | "turn" | "time";
export function timelineNodes(events: SessionTimelineEvent[], pairTools = true) {
  const ordered = [...events].sort((a, b) => a.ordinal - b.ordinal);
  if (!pairTools) return ordered.map(event => ({ event, result: undefined }));
  const { paired, consumed } = tracePairs(ordered);
  return ordered.filter(event => !consumed.has(event.id)).map(event => ({ event, result: paired.get(event.id) }));
}

export function timelineProjection(nodes: ReturnType<typeof timelineNodes>, mode: TraceProjection, complete?: SessionTimelineProjection) {
  const turns = new Map<string, number>();
  const counts = new Map<string, number>(), offsets = new Map<string, number>();
  for (const { event } of nodes) {
    if (!turns.has(event.turnId)) turns.set(event.turnId, turns.size);
    counts.set(event.turnId, (counts.get(event.turnId) ?? 0) + 1);
  }
  const timestamps = nodes.map(node => node.event.occurredAt ? Date.parse(node.event.occurredAt) : NaN);
  const valid = timestamps.filter(Number.isFinite);
  const start = complete?.timeStart ?? valid.reduce((minimum, value) => Math.min(minimum, value), valid[0] ?? 0);
  const end = complete?.timeEnd ?? valid.reduce((maximum, value) => Math.max(maximum, value), valid[0] ?? 0);
  const spans = nodes.flatMap((node, index) => {
    const offset = offsets.get(node.event.turnId) ?? 0;
    offsets.set(node.event.turnId, offset + 1);
    if (mode === "time" && !Number.isFinite(timestamps[index])) return [];
    const x = mode === "time" ? (timestamps[index]! - start) / Math.max(1, end - start)
      : mode === "turn" ? complete && node.event.turnPosition !== undefined
        ? (node.event.turnPosition + (node.event.turnOffset ?? 0) / Math.max(1, node.event.turnCount ?? 1)) / Math.max(1, complete.totalTurns)
        : (turns.get(node.event.turnId)! + offset / counts.get(node.event.turnId)!) / Math.max(1, turns.size)
      : complete?.firstOrdinal !== undefined && complete.lastOrdinal !== undefined
        ? (node.event.ordinal - complete.firstOrdinal) / Math.max(1, complete.lastOrdinal - complete.firstOrdinal)
        : index / Math.max(1, nodes.length - 1);
    const lane = node.event.kind.startsWith("tool_") ? 2 : node.event.usage || ["assistant", "thinking", "compression"].includes(node.event.kind) ? 1 : 0;
    return [{ ...node, x, lane, index }];
  });
  return { spans, missing: mode === "time" && complete ? complete.missingTime : nodes.length - spans.length, start, end };
}

export const TRACE_MAX_ZOOM = 64;
export function timelinePosition(x: number, width: number) {
  return 5 + x * Math.max(1, width - 10);
}
export function timelineFraction(position: number, width: number) {
  return Math.min(1, Math.max(0, (position - 5) / Math.max(1, width - 10)));
}
export function timelineCenteredScroll(x: number, width: number, viewport: number) {
  return Math.min(Math.max(0, width - viewport), Math.max(0, timelinePosition(x, width) - viewport / 2));
}
export function timelineZoomScroll(scroll: number, viewport: number, width: number, nextWidth: number, anchor = viewport / 2) {
  const x = (scroll + anchor - 5) / Math.max(1, width - 10);
  return Math.min(Math.max(0, nextWidth - viewport), Math.max(0, timelinePosition(x, nextWidth) - anchor));
}
export function timelineVisibleMarks(spans: ReturnType<typeof timelineProjection>["spans"], width: number, scroll: number, viewport: number, selectedId?: string) {
  const bins = new Map<string, typeof spans[number]>();
  for (const span of spans) {
    const position = timelinePosition(span.x, width);
    if (position < scroll - 5 || position > scroll + viewport + 5) continue;
    const key = `${span.lane}:${Math.round(position)}`;
    // 仅在同一像素合并标记，缩放后重新分桶，选中节点优先保留。
    if (!bins.has(key) || span.event.id === selectedId || span.result?.id === selectedId) bins.set(key, span);
  }
  return [...bins.values()];
}

export function tracePreview(text: string): string {
  return text.slice(0, 600).replace(/\s+/g, " ").trim() || t("sessions.body.emptyPreview");
}

export const TRACE_ROW_HEIGHT = 40;
export function traceAnchoredScroll(previous: string[], next: string[], scroll: number, height: number): number {
  const first = Math.floor(scroll / TRACE_ROW_HEIGHT);
  const end = Math.min(previous.length, Math.ceil((scroll + height) / TRACE_ROW_HEIGHT));
  for (const recordsOnly of [true, false]) {
    for (let index = first; index < end; index++) {
      if (recordsOnly && previous[index]!.startsWith("turn:")) continue;
      const target = next.indexOf(previous[index]!);
      if (target >= 0) return Math.max(0, scroll + (target - index) * TRACE_ROW_HEIGHT);
    }
  }
  return scroll;
}
export function traceWindow(total: number, scroll: number, height: number) {
  const start = Math.max(0, Math.floor(scroll / TRACE_ROW_HEIGHT) - 8);
  const end = Math.min(total, Math.ceil((scroll + height) / TRACE_ROW_HEIGHT) + 8);
  return { start: Math.min(start, total), end };
}
