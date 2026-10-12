import { isAbsolute } from "node:path";
import type { Gap, HistoryEvent } from "../../contracts.js";
import { object, string, toolEvidence } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import type { HistoryAdapter } from "./types.js";
import { createNormalizedAdapter, normalizedRecord, normalizedSnapshot } from "./normalized.js";
import type { NormalizedEvent, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { addGap, eventTime, nativeSourceId, normalizeUsage, readJsonlHeader, readJsonlRows, sessionIds, sourceFor, textOf } from "./native-jsonl.js";

export const QODER_FORMAT = "qoder-jsonl";

function directoriesOf(rows: readonly RawHistoryRecord[]): string[] {
  return [...new Set(rows.flatMap(row => row.record.type === "workspace-directories" && Array.isArray(row.record.directories)
    ? row.record.directories.filter((value): value is string => typeof value === "string" && isAbsolute(value)) : []))];
}

async function discoverQoderFile(location: SourceLocation): Promise<SourceLocation[]> {
  if (!location.path.endsWith(".jsonl")) return [];
  const rows = await readJsonlHeader(location.path);
  const ids = sessionIds(rows);
  const cwdValues = [...new Set(rows.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const directories = directoriesOf(rows);
  const cwd = directories.length === 1 ? directories[0] : cwdValues.length === 1 ? cwdValues[0] : undefined;
  const source = sourceFor(location, "qoder", QODER_FORMAT, ids.length === 1 ? ids[0] : undefined, cwd);
  source.selector = source.sessionId;
  return [source];
}

function messageModel(record: Record<string, unknown>, fallback: string | undefined): string | undefined {
  return string(object(record.message).model) ?? fallback;
}

function resultStatus(block: Record<string, unknown>, result: Record<string, unknown>): HistoryEvent["status"] {
  if (block.is_error === true || result.isHardFailure === true) return "failure";
  if (result.timedOut === true || result.interrupted === true || result.backgroundReason || result.kind === "background") return "unknown";
  if (typeof result.exitCode === "number") return result.exitCode === 0 ? "success" : "failure";
  if (block.is_error === false) return "success";
  return "unknown";
}

function normalizeQoderRows(rows: readonly RawHistoryRecord[], gaps: Gap[]): { rows: ReturnType<typeof normalizedRecord>[]; title?: string; cwd?: string; fingerprint: unknown } {
  const ids = sessionIds(rows);
  const directories = directoriesOf(rows);
  const cwdValues = [...new Set(rows.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const cwd = directories.length === 1 ? directories[0] : directories.length === 0 && cwdValues.length === 1 ? cwdValues[0] : undefined;
  if (directories.length > 1) addGap(gaps, "ambiguous", "Qoder workspace-directories 存在多个目录，未选择单一项目", { key: "diagnostics.history.adapters.qoder.m001" });
  if (directories.length === 1 && cwdValues.some(value => value !== directories[0])) addGap(gaps, "ambiguous", "Qoder 消息 cwd 与 workspace-directories 不一致，优先采用 workspace 元数据", { key: "diagnostics.history.adapters.qoder.m002" });
  if (directories.length === 0 && cwdValues.length > 1) addGap(gaps, "ambiguous", "Qoder 消息记录了多个 cwd，无法确认单一项目目录", { key: "diagnostics.history.adapters.qoder.m003" });
  const title = rows.find(row => row.record.type === "ai-title" && typeof row.record.aiTitle === "string")?.record.aiTitle as string | undefined;
  let activeModel: string | undefined;
  let activeReasoningEffort: string | undefined;
  const normalized: ReturnType<typeof normalizedRecord>[] = [];
  const snapshots = new Map<string, Set<string>>();
  const requestUsages = new Map<string, { event: NormalizedEvent; fingerprint: string }>();
  const requestEfforts = new Map<string, string | undefined>();
  for (const row of rows) {
    const record = row.record;
    const type = string(record.type) ?? "<缺少类型>";
    if (type === "runtime-config") {
      activeModel = string(record.model) ?? activeModel;
      activeReasoningEffort = string(record.reasoningEffort);
      const config = { model: string(record.model), contextWindow: record.contextWindow, reasoningEffort: string(record.reasoningEffort) };
      normalized.push(normalizedRecord({ key: `runtime-config:${row.line}`, kind: "context", text: JSON.stringify(config),
        model: string(record.model), reasoningEffort: activeReasoningEffort, occurredAt: eventTime(record.timestamp) }, row.raw, row.line));
      continue;
    }
    if (["workspace-directories", "ai-title", "last-prompt", "file-history-snapshot"].includes(type)) continue;
    if (type === "attachment") {
      addGap(gaps, "unsupported_format", "Qoder 附件元数据存在，但附件正文未适配", { key: "diagnostics.history.adapters.qoder.m004" });
      continue;
    }
    if (type === "system") {
      normalized.push(normalizedRecord({ key: string(record.uuid) ?? `system:${row.line}`, kind: "system",
        text: textOf(record.content), occurredAt: eventTime(record.timestamp), model: activeModel }, row.raw, row.line));
      continue;
    }
    if (type !== "user" && type !== "assistant") {
      addGap(gaps, "unsupported_format", `Qoder 记录类型 ${type} 尚未适配`, { key: "diagnostics.history.adapters.qoder.m005", params: { p0: String(type) } });
      normalized.push(normalizedRecord({ key: `unknown:${row.line}`, kind: "context", text: `未适配记录类型 ${type}` }, row.raw, row.line));
      continue;
    }
    const message = object(record.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const nativeRequest = type === "assistant" ? string(message.id) : undefined;
    if (nativeRequest) {
      const fingerprint = JSON.stringify([message, record.status, record.interrupted, record.error]);
      const seen = snapshots.get(nativeRequest) ?? new Set<string>();
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint); snapshots.set(nativeRequest, seen);
    }
    const recordId = nativeRequest ?? string(record.uuid) ?? `${type}:${row.line}`;
    const occurredAt = eventTime(record.timestamp);
    const model = messageModel(record, activeModel);
    const blocks = content.map(value => object(value));
    const textBlocks = blocks.filter(block => block.type === "text").map(block => string(block.text) ?? "").filter(Boolean);
    const resultBlocks = blocks.filter(block => block.type === "tool_result");
    const hasMetaUser = type === "user" && (record.isMeta === true || record.userType === "meta" || record.userType === "internal"
      || object(record.origin).kind === "task-notification");
    const hasUsage = type === "assistant" ? object(message.usage) : {};
    const usage = normalizeUsage([hasUsage], gap => addGap(gaps, gap.kind, gap.message, gap.messageDescriptor, gap.details));
    const usageKey = string(message.id) ?? recordId;
    const requestKey = type === "assistant" ? nativeRequest ?? `record:${recordId}` : undefined;
    if (requestKey && !requestEfforts.has(requestKey)) requestEfforts.set(requestKey, activeReasoningEffort);
    const reasoningEffort = requestKey ? requestEfforts.get(requestKey) : undefined;
    let usageAttached = false;
    const attachUsage = (event: NormalizedEvent) => {
      if (!usage || usageAttached) return;
      const fingerprint = JSON.stringify(usage);
      const previous = requestUsages.get(usageKey);
      if (previous && previous.fingerprint !== fingerprint) {
        previous.event.usage = { ...previous.event.usage, outputTokens: undefined };
        event.usage = { ...usage, outputTokens: undefined };
      } else if (!previous) event.usage = usage;
      event.usageKey = usageKey;
      if (!previous) requestUsages.set(usageKey, { event, fingerprint });
      usageAttached = true;
    };
    if (type === "user" && textBlocks.length) {
      const event: NormalizedEvent = { key: `${recordId}:user`, kind: hasMetaUser ? "context" : "user",
        text: textBlocks.join("\n"), occurredAt, model, requestKey };
      normalized.push(normalizedRecord(event, row.raw, row.line));
    }
    if (type === "assistant" && !content.length) {
      const event: NormalizedEvent = { key: `${recordId}:assistant`, kind: "assistant", text: "", occurredAt, model, reasoningEffort, requestKey, allowInferredFinal: false };
      if (message.stop_reason === "end_turn") event.final = "explicit";
      attachUsage(event);
      normalized.push(normalizedRecord(event, row.raw, row.line));
    }
    blocks.forEach((block, index) => {
      const key = `${recordId}:${index}`;
      if (type === "assistant" && block.type === "text") {
        const event: NormalizedEvent = { key, kind: "assistant", text: string(block.text) ?? "", occurredAt, model, reasoningEffort, requestKey,
          final: message.stop_reason === "end_turn" ? "explicit" : undefined, allowInferredFinal: false };
        attachUsage(event);
        normalized.push(normalizedRecord(event, row.raw, row.line));
      } else if (type === "assistant" && block.type === "thinking") {
        normalized.push(normalizedRecord({ key, kind: "thinking", text: string(block.thinking) ?? "", occurredAt, model, reasoningEffort, requestKey }, row.raw, row.line));
      } else if (type === "assistant" && block.type === "redacted_thinking") {
        normalized.push(normalizedRecord({ key, kind: "thinking", text: "[原生记录标记为 redacted thinking]", occurredAt, model, reasoningEffort, requestKey }, row.raw, row.line));
      } else if (type === "assistant" && block.type === "tool_use") {
        const callId = string(block.id);
        const event: NormalizedEvent = { key, kind: "tool_call", callId, tool: string(block.name) ?? "unknown",
          input: block.input, occurredAt, model, reasoningEffort, requestKey };
        attachUsage(event);
        normalized.push(normalizedRecord(event, row.raw, row.line));
        if (!callId) addGap(gaps, "unpaired_call", "Qoder tool_use 缺少原生调用 id，无法配对结果", { key: "diagnostics.history.adapters.qoder.m006" });
      } else if (type === "user" && block.type === "tool_result") {
        const callId = string(block.tool_use_id);
        const result = object(record.toolUseResult);
        const visible = textOf(block.content);
        const event: NormalizedEvent = { key, kind: "tool_result", callId,
          result: { ...result, output: string(result.stdout) ?? visible, exit_code: result.exitCode },
          text: visible, status: resultStatus(block, result), occurredAt, model, requestKey };
        normalized.push(normalizedRecord(event, row.raw, row.line));
        if (!callId) addGap(gaps, "unpaired_call", "Qoder tool_result 缺少 tool_use_id，无法配对请求", { key: "diagnostics.history.adapters.qoder.m007" });
      } else if (block.type === "tool_result" && type === "assistant") {
        addGap(gaps, "ambiguous", "Qoder assistant 记录包含 tool_result，未据角色将其当作用户消息", { key: "diagnostics.history.adapters.qoder.m008" });
      }
    });
    if (type === "user" && !textBlocks.length && !resultBlocks.length) {
      const event: NormalizedEvent = { key: `${recordId}:user`, kind: hasMetaUser ? "context" : "user",
        text: textOf(message.content), occurredAt, model, requestKey };
      normalized.push(normalizedRecord(event, row.raw, row.line));
    }
    if (record.agentId && !record.parentSessionId) {
      addGap(gaps, "ambiguous", "Qoder agentId 或 parentUuid 未证明跨会话父关系，未标记为委派子会话", { key: "diagnostics.history.adapters.qoder.m009" });
    }
    if (type === "assistant" && usage && !usageAttached) {
      const event: NormalizedEvent = { key: `${recordId}:usage`, kind: "context", text: "原生助手记录包含用量字段",
        occurredAt, model, reasoningEffort, requestKey };
      attachUsage(event);
      normalized.push(normalizedRecord(event, row.raw, row.line));
    }
  }
  attachRequestTiming(rows, normalized);
  return { rows: normalized, title, cwd, fingerprint: [ids, directories, cwdValues] };
}

function attachRequestTiming(rows: readonly RawHistoryRecord[], records: ReturnType<typeof normalizedRecord>[]): void {
  type Timing = NonNullable<NormalizedEvent["requestTiming"]>;
  type Group = { events: NormalizedEvent[]; timing: Timing; calls: Set<string>; identified: boolean };
  const byLine = new Map(rows.map(row => [row.line, row.record]));
  const groups = new Map<string, Group>();
  const calls = new Map<string, Group | undefined>();
  let boundary: Timing["start"];
  for (const row of records) {
    const event = row.record.normalizedEvent as NormalizedEvent;
    const raw = byLine.get(row.line) ?? {};
    const point = { recordLine: row.line, occurredAt: event.occurredAt };
    if (event.kind === "user") { boundary = point; continue; }
    if (event.kind === "tool_result") {
      const group = event.callId ? calls.get(event.callId) : undefined;
      if (group && group.calls.delete(event.callId!)) {
        if (!group.calls.size && group.identified && group.timing.completion === "unknown") {
          group.timing.completion = "inferred"; group.timing.completionEvidence = "tool_result";
        }
        boundary = point;
      }
      continue;
    }
    if (!event.requestKey) continue;
    let group = groups.get(event.requestKey);
    if (!group) {
      group = { events: [], calls: new Set(), identified: Boolean(string(object(raw.message).id)),
        timing: { basis: "estimated", window: "response", method: "qoder_message_boundary", completion: "unknown", start: boundary } };
      groups.set(event.requestKey, group); boundary = undefined;
    }
    group.events.push(event);
    group.timing.end = point;
    const message = object(raw.message);
    const status = string(raw.status) ?? string(message.status);
    const partial = raw.interrupted === true || raw.error !== undefined && raw.error !== null
      || ["incomplete", "cancelled", "canceled", "interrupted", "error", "failed"].includes(status ?? "");
    if (partial) {
      group.timing.completion = "partial"; group.timing.completionEvidence = "request_interrupted";
    } else if (group.identified && group.timing.completion !== "partial"
      && ["end_turn", "stop_sequence", "tool_use", "max_tokens", "pause_turn", "refusal"].includes(string(message.stop_reason) ?? "")) {
      group.timing.completion = "explicit"; group.timing.completionEvidence = "stop_reason";
    }
    if (event.kind === "tool_call" && event.callId) {
      group.calls.add(event.callId);
      if (!calls.has(event.callId)) calls.set(event.callId, group);
      else if (calls.get(event.callId) !== group) calls.set(event.callId, undefined);
    }
  }
  for (const group of groups.values()) {
    const start = group.timing.start?.occurredAt; const end = group.timing.end?.occurredAt;
    if (start && end) group.timing.durationMs = Date.parse(end) - Date.parse(start);
    group.timing.outputTokens = group.events.find(event => event.usage)?.usage?.outputTokens;
    for (const event of group.events) event.requestTiming = group.timing;
  }
}

async function readQoderSnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = [];
  const rawRows = await readJsonlRows(location.path, gaps);
  const ids = sessionIds(rawRows);
  const sessionId = ids.length > 1 ? undefined : location.sessionId ?? location.selector ?? (ids.length === 1 ? ids[0] : undefined);
  if (ids.length > 1) addGap(gaps, "ambiguous", "单个 Qoder 文件包含多个 sessionId，未合并跨会话正文", { key: "diagnostics.history.adapters.qoder.m010" });
  if (sessionId && ids.some(id => id !== sessionId)) addGap(gaps, "ambiguous", "Qoder 正文身份与发现身份不一致，仅保留匹配记录", { key: "diagnostics.history.adapters.qoder.m011" });
  if (!sessionId) addGap(gaps, "unassociated", "Qoder 正文缺少可确认的原生 sessionId", { key: "diagnostics.history.adapters.qoder.m012" });
  const selected = ids.length > 1 ? [] : sessionId
    ? rawRows.filter(row => !string(row.record.sessionId) || row.record.sessionId === sessionId) : rawRows;
  const normalized = normalizeQoderRows(selected, gaps);
  const source = sourceFor(location, "qoder", QODER_FORMAT, sessionId, normalized.cwd);
  source.selector = sessionId;
  return normalizedSnapshot(source, normalized.rows, { title: normalized.title, titleOrigin: normalized.title ? "recorded" : undefined, gaps },
    JSON.stringify([normalized.fingerprint, sessionId]));
}

export const qoderAdapter: HistoryAdapter = createNormalizedAdapter({
  id: QODER_FORMAT,
  quickCheck: { version: "2", dependencies: () => [] },
  discoverFile: discoverQoderFile,
  readSnapshot: readQoderSnapshot,
  extract(tool, inputValue, resultValue, visible) {
    const input = object(inputValue);
    const result = object(resultValue);
    const mapped = tool.toLowerCase() === "bash" ? "Bash" : tool;
    const mappedInput = mapped === "Bash" ? { ...input, cmd: string(input.command) ?? string(input.cmd) } : input;
    const mappedResult = mapped === "Bash" ? { ...result, exit_code: result.exit_code ?? result.exitCode,
      output: string(result.output) ?? string(result.stdout) ?? visible } : result;
    return toolEvidence(mapped, mappedInput, mappedResult, visible || string(result.output) || string(result.stdout) || "");
  },
});

export function qoderSourceIdentity(sessionId: string): string {
  return nativeSourceId("qoder", sessionId);
}
