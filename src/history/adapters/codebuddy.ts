import { isAbsolute } from "node:path";
import type { Gap } from "../../contracts.js";
import { object, string } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import type { HistoryAdapter } from "./types.js";
import { createNormalizedAdapter, normalizedRecord, normalizedSnapshot } from "./normalized.js";
import type { NormalizedEvent, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { addGap, eventTime, nativeSourceId, normalizeUsage, readJsonlHeader, readJsonlRows, sessionIds, sourceFor, textOf } from "./native-jsonl.js";

export const CODEBUDDY_FORMAT = "codebuddy-jsonl";

async function discoverCodebuddyFile(location: SourceLocation): Promise<SourceLocation[]> {
  if (!location.path.endsWith(".jsonl")) return [];
  const rows = await readJsonlHeader(location.path);
  const ids = sessionIds(rows);
  const sessionId = ids.length === 1 ? ids[0] : undefined;
  const cwdValues = [...new Set(rows.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const source = sourceFor(location, "codebuddy", CODEBUDDY_FORMAT, sessionId, cwdValues.length === 1 ? cwdValues[0] : undefined);
  source.selector = sessionId;
  return [source];
}

async function readCodebuddySnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = [];
  const rows = await readJsonlRows(location.path, gaps);
  const bodyIds = sessionIds(rows);
  const sessionId = bodyIds.length > 1 ? undefined : location.sessionId ?? location.selector ?? (bodyIds.length === 1 ? bodyIds[0] : undefined);
  if (bodyIds.length > 1) addGap(gaps, "ambiguous", "单个 CodeBuddy 文件包含多个 sessionId，未合并跨会话正文", { key: "diagnostics.history.adapters.codebuddy.m001" });
  if (sessionId && bodyIds.some(id => id !== sessionId)) addGap(gaps, "ambiguous", "CodeBuddy 正文身份与发现身份不一致，仅保留匹配记录", { key: "diagnostics.history.adapters.codebuddy.m002" });
  if (!sessionId) addGap(gaps, "unassociated", "CodeBuddy 正文缺少可确认的原生 sessionId", { key: "diagnostics.history.adapters.codebuddy.m003" });
  const selected = bodyIds.length > 1 ? [] : sessionId
    ? rows.filter(row => !string(row.record.sessionId) || row.record.sessionId === sessionId) : rows;
  const cwdValues = [...new Set(selected.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const cwd = location.cwd && isAbsolute(location.cwd) ? location.cwd : cwdValues.length === 1 ? cwdValues[0] : undefined;
  if (cwdValues.length > 1) addGap(gaps, "ambiguous", "CodeBuddy 正文记录了多个 cwd，无法确认单一项目目录", { key: "diagnostics.history.adapters.codebuddy.m004" });
  if (location.cwd && cwdValues.some(value => value !== location.cwd)) addGap(gaps, "ambiguous", "CodeBuddy 发现阶段 cwd 与正文 cwd 不一致", { key: "diagnostics.history.adapters.codebuddy.m005" });
  const source = sourceFor(location, "codebuddy", CODEBUDDY_FORMAT, sessionId, cwd);
  source.selector = sessionId;
  const records: ReturnType<typeof normalizedRecord>[] = [];
  const requestUsage = new Map<string, { event: NormalizedEvent; fingerprint: string }>();
  const nativeRecords = new Map<NormalizedEvent, RawHistoryRecord>();
  const reasoningRequests = new Map<string, string>();
  const modelChildren = new Map<string, RawHistoryRecord[]>();
  for (const row of selected) {
    const parentId = string(row.record.parentId);
    if (!parentId || !(row.record.type === "function_call" || row.record.type === "message" && row.record.role === "assistant")) continue;
    const children = modelChildren.get(parentId) ?? [];
    children.push(row); modelChildren.set(parentId, children);
  }
  for (const row of selected) {
    if (row.record.type !== "reasoning" || !string(row.record.id)) continue;
    const provider = object(row.record.providerData);
    const traceId = string(provider.traceId);
    if (!traceId) continue;
    const children = (modelChildren.get(string(row.record.id)!) ?? []).filter(child => object(child.record.providerData).traceId === traceId
      && object(child.record.providerData).conversationRequestId === provider.conversationRequestId);
    const keys = new Set(children.map(child => string(object(child.record.providerData).messageId)));
    // 思考片段的临时身份只沿唯一直接模型子记录关联，不按整个回合身份合并。
    if (keys.size === 1 && !keys.has(undefined)) reasoningRequests.set(string(row.record.id)!, [...keys][0]!);
  }
  let round: { events: NormalizedEvent[]; hasTool: boolean; metrics: number; user?: RawHistoryRecord } = { events: [], hasTool: false, metrics: 0 };
  addGap(gaps, "unsupported_format", "CodeBuddy 工具与资源格式尚未完整核验", { key: "diagnostics.history.adapters.codebuddy.resourceCoverage" });
  for (const row of selected) {
    const record = row.record;
    const type = string(record.type);
    const provider = object(record.providerData);
    const message = object(record.message);
    const role = string(record.role);
    const requestKey = reasoningRequests.get(string(record.id) ?? "") ?? string(provider.messageId);
    const key = string(record.id) ?? `${type ?? "unknown"}:${row.line}`;
    const occurredAt = eventTime(record.timestamp);
    const model = string(provider.model) ?? string(provider.requestModelName) ?? string(message.model);
    if (type === "turn-metrics") {
      round.metrics += 1;
      const requests = new Set(round.events.map(event => event.requestKey));
      const assistants = round.events.filter(event => event.kind === "assistant");
      const durationMs = record.durationMs;
      const completed = assistants.length > 0 && assistants.every(event => event.allowInferredFinal === true)
        && round.events.every(event => !event.interrupted);
      const terminal = round.events.find(event => event.usage);
      const terminalRow = terminal && nativeRecords.get(terminal);
      const usageRequests = object(object(terminalRow?.record.providerData).usage).requests;
      if (round.user && requests.size === 1 && !requests.has(undefined) && !round.hasTool && round.metrics === 1
        && completed && string(object(terminalRow?.record.providerData).messageId) !== undefined && usageRequests === 1 && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
        // 客户端内测量不等于两个持久化时间戳之差，不补造起始时间。
        const timing: NonNullable<NormalizedEvent["requestTiming"]> = { basis: "estimated", window: "response",
          method: "codebuddy_single_request_turn", completion: "explicit", completionEvidence: "turn_metrics",
          durationMs, end: { recordLine: row.line, occurredAt }, outputTokens: terminal?.usage?.outputTokens };
        for (const event of round.events) event.requestTiming = timing;
      } else if (round.metrics > 1) {
        for (const event of round.events) if (event.requestTiming?.completionEvidence === "turn_metrics") {
          event.requestTiming = { basis: "estimated", method: "codebuddy_single_request_turn", completion: "unknown" };
        }
      }
      continue;
    }
    if (["ai-title", "custom-title", "file-history-snapshot"].includes(type ?? "")) continue;
    let event: NormalizedEvent;
    if (type === "message" && role === "user") {
      event = { key, kind: provider.startsNewUserRequest === false || provider.isMeta === true ? "context" : "user",
        text: textOf(record.content), occurredAt };
      if (event.kind === "user") round = { events: [], hasTool: false, metrics: 0, user: row };
    } else if (type === "message" && role === "assistant" || type === "reasoning" || type === "function_call") {
      const finish = (string(record.finishReason) ?? string(record.finish_reason) ?? string(record.stopReason) ?? string(message.stop_reason) ?? "")
        .toLowerCase().replaceAll("-", "_");
      const failureStates = ["incomplete", "interrupted", "cancelled", "canceled", "error", "failed", "aborted", "max_tokens", "length"];
      const interrupted = failureStates.includes(string(record.status) ?? "") || failureStates.includes(finish)
        || record.interrupted === true || record.error !== undefined && record.error !== null || Boolean(provider.error);
      const completed = type === "message" && record.status === "completed" && !interrupted
        && !["tool_use", "tool_calls", "tooluse", "pause_turn"].includes(finish);
      event = { key, kind: type === "reasoning" ? "thinking" : type === "function_call" ? "tool_call" : "assistant",
        text: textOf(record.content) || textOf(record.rawContent), occurredAt, model,
        requestKey: requestKey ?? `record:${key}`, interrupted,
        allowInferredFinal: completed,
        finalEvidence: completed ? "response_completed" : undefined,
        finalAt: completed ? occurredAt : undefined,
        requestTiming: { basis: "estimated", method: "codebuddy_single_request_turn", completion: interrupted ? "partial" : "unknown",
          completionEvidence: interrupted ? "request_interrupted" : undefined } };
      if (type === "function_call") {
        event.callId = string(record.callId); event.tool = string(record.name) ?? "unknown";
        try { event.input = typeof record.arguments === "string" ? JSON.parse(record.arguments) : record.arguments; }
        catch { event.input = record.arguments; }
        round.hasTool = true;
      }
      const rawUsage = [message.usage, provider.usage, provider.rawUsage, record.usage];
      const projections = rawUsage.map(value => normalizeUsage([value], () => undefined)).filter(Boolean);
      const outputs = new Set(projections.map(value => value?.outputTokens).filter(value => value !== undefined));
      const usage = normalizeUsage(rawUsage, gap => addGap(gaps, gap.kind, gap.message, gap.messageDescriptor, gap.details));
      if (usage) {
        const usageKey = requestKey ?? `record:${key}`;
        const fingerprint = JSON.stringify(usage);
        const previous = requestUsage.get(usageKey);
        if (outputs.size > 1 || previous && previous.fingerprint !== fingerprint) {
          if (previous) previous.event.usage = { ...previous.event.usage, outputTokens: undefined };
          event.usage = { ...usage, outputTokens: undefined };
        } else if (!previous) event.usage = usage;
        event.usageKey = usageKey;
        if (!previous) requestUsage.set(usageKey, { event, fingerprint });
      }
      round.events.push(event);
      nativeRecords.set(event, row);
    } else if (type === "function_call_result") {
      round.hasTool = true;
      const result = object(provider.toolResult);
      event = { key, kind: "tool_result", occurredAt, model, callId: string(record.callId), tool: string(record.name),
        text: textOf(record.output), result, status: result.error ? "failure" : "unknown" };
    } else {
      addGap(gaps, "unsupported_format", `CodeBuddy 记录类型 ${type ?? "<缺少类型>"} 尚未适配`, type !== undefined
        ? { key: "diagnostics.history.adapters.codebuddy.m006", params: { p0: type } } : { key: "diagnostics.history.adapters.codebuddy.m007" });
      event = { key, kind: "context", text: textOf(record.content) || `未适配记录类型 ${type ?? "<缺少类型>"}`, occurredAt };
    }
    records.push(normalizedRecord(event, row.raw, row.line));
  }
  const groups = new Map<string, NormalizedEvent[]>();
  for (const row of records) {
    const event = row.record.normalizedEvent as NormalizedEvent;
    if (!event.requestKey) continue;
    const values = groups.get(event.requestKey) ?? [];
    values.push(event); groups.set(event.requestKey, values);
  }
  for (const events of groups.values()) {
    const lastInterrupted = events.findLastIndex(event => event.interrupted);
    const lastCompleted = events.findLastIndex(event => event.kind === "assistant" && event.finalEvidence);
    const timing = lastInterrupted >= lastCompleted && lastInterrupted >= 0 ? events[lastInterrupted]?.requestTiming
      : events.find(event => event.requestTiming?.durationMs !== undefined)?.requestTiming ?? events.at(-1)?.requestTiming;
    for (const event of events) event.requestTiming = timing;
  }
  return normalizedSnapshot(source, records, { gaps }, JSON.stringify([bodyIds, cwdValues, selected.filter(row => row.record.type === "turn-metrics").map(row => row.raw)]));
}

export const codebuddyAdapter: HistoryAdapter = createNormalizedAdapter({
  id: CODEBUDDY_FORMAT,
  quickCheck: { version: "2", dependencies: () => [] },
  discoverFile: discoverCodebuddyFile,
  readSnapshot: readCodebuddySnapshot,
});

export function codebuddySourceIdentity(sessionId: string): string {
  return nativeSourceId("codebuddy", sessionId);
}
