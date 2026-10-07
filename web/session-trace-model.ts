import type { SessionMessage, SessionTimelineEvent, SessionUsage } from "../src/session-contracts";
import { groupedTurns } from "./session-model";
import { t } from "./i18n";

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

export function traceTurns(messages: SessionMessage[], usages: SessionUsage[]) {
  const usageByMessage = new Map<string, SessionUsage[]>();
  for (const usage of usages) {
    if (!usage.messageId) continue;
    const values = usageByMessage.get(usage.messageId) ?? [];
    values.push(usage); usageByMessage.set(usage.messageId, values);
  }
  return groupedTurns(messages).map(turn => {
    const { paired, consumed } = tracePairs(turn.messages);
    const records: TraceRecord[] = turn.messages.filter(message => !consumed.has(message.id)).map(message => {
      const result = paired.get(message.id);
      return { message, result, usage: [...(usageByMessage.get(message.id) ?? []), ...(result ? usageByMessage.get(result.id) ?? [] : [])] };
    });
    return { ...turn, records };
  });
}

export type TraceProjection = "sequence" | "turn" | "time";
export function timelineNodes(events: SessionTimelineEvent[]) {
  const ordered = [...events].sort((a, b) => a.ordinal - b.ordinal);
  const { paired, consumed } = tracePairs(ordered);
  return ordered.filter(event => !consumed.has(event.id)).map(event => ({ event, result: paired.get(event.id) }));
}

export function timelineProjection(nodes: ReturnType<typeof timelineNodes>, mode: TraceProjection) {
  const turns = new Map<string, number>();
  const counts = new Map<string, number>(), offsets = new Map<string, number>();
  for (const { event } of nodes) {
    if (!turns.has(event.turnId)) turns.set(event.turnId, turns.size);
    counts.set(event.turnId, (counts.get(event.turnId) ?? 0) + 1);
  }
  const timestamps = nodes.map(node => node.event.occurredAt ? Date.parse(node.event.occurredAt) : NaN);
  const valid = timestamps.filter(Number.isFinite);
  const start = valid.reduce((minimum, value) => Math.min(minimum, value), valid[0] ?? 0);
  const end = valid.reduce((maximum, value) => Math.max(maximum, value), valid[0] ?? 0);
  const spans = nodes.flatMap((node, index) => {
    const offset = offsets.get(node.event.turnId) ?? 0;
    offsets.set(node.event.turnId, offset + 1);
    if (mode === "time" && !Number.isFinite(timestamps[index])) return [];
    const x = mode === "time" ? (timestamps[index]! - start) / Math.max(1, end - start)
      : mode === "turn" ? (turns.get(node.event.turnId)! + offset / counts.get(node.event.turnId)!) / Math.max(1, turns.size)
      : index / Math.max(1, nodes.length - 1);
    const lane = node.event.kind.startsWith("tool_") ? 2 : node.event.usage || ["assistant", "thinking", "compression"].includes(node.event.kind) ? 1 : 0;
    return [{ ...node, x, lane, index }];
  });
  return { spans, missing: nodes.length - spans.length, start, end };
}

export function tracePreview(text: string): string {
  return text.slice(0, 600).replace(/\s+/g, " ").trim() || t("sessions.body.emptyPreview");
}

export const TRACE_ROW_HEIGHT = 40;
export function traceWindow(total: number, scroll: number, height: number) {
  const start = Math.max(0, Math.floor(scroll / TRACE_ROW_HEIGHT) - 8);
  const end = Math.min(total, Math.ceil((scroll + height) / TRACE_ROW_HEIGHT) + 8);
  return { start: Math.min(start, total), end };
}
