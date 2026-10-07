import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import type { Client, Gap, HistoryEvent } from "../../contracts.js";
import { number, object, physicalLines, string, textContent, toolEvidence } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import type { HistoryAdapter } from "./types.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot } from "./normalized.js";
import type { NormalizedEvent, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { addGap, eventTime, fileSessionId, nativeSourceId, normalizeUsage, readJsonlHeader, readJsonlRows, sessionIds, siblingDatabase, sourceFor, textOf } from "./native-jsonl.js";

export const WORKBUDDY_FORMAT = "workbuddy-jsonl";

interface WorkbuddyMetadata {
  found: boolean;
  cwd?: string;
  title?: string;
  customTitle?: string;
}

function openDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

async function readMetadata(path: string, id: string | undefined): Promise<WorkbuddyMetadata> {
  if (!id) return { found: false };
  const databasePath = await siblingDatabase(path, "workbuddy.db");
  if (!databasePath) return { found: false };
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (!table) return { found: false };
    const columns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(column => column.name));
    if (!columns.has("id")) return { found: false };
    const selected = ["id", "cwd", "title", "custom_title"].filter(column => columns.has(column));
    const row = db.prepare(`SELECT ${selected.join(", ")} FROM sessions WHERE id=? LIMIT 1`).get(id);
    if (!row) return { found: false };
    const record = object(row);
    return {
      found: true,
      cwd: string(record.cwd),
      title: string(record.title),
      customTitle: string(record.custom_title),
    };
  } finally {
    db?.close();
  }
}

function usageFrom(record: Record<string, unknown>, gap: (gap: Gap) => void): { usage?: NormalizedEvent["usage"]; key?: string } {
  const provider = object(record.providerData);
  const message = object(record.message);
  const raws = [provider.usage, message.usage, provider.rawUsage, record.usage, record.rawUsage];
  const projections = raws.map(value => normalizeUsage([value], () => undefined)).filter(Boolean);
  if (new Set(projections.map(value => JSON.stringify(value))).size > 1) {
    gap({ kind: "ambiguous", message: "WorkBuddy message/provider/raw 用量投影不同，按 providerData.usage 优先并保留原始行", messageDescriptor: { key: "diagnostics.history.adapters.workbuddy.m001" } });
  }
  const usage = normalizeUsage(raws, gap);
  const key = string(provider.messageId) ?? string(record.id);
  if (!usage && raws.some(value => Object.keys(object(value)).length > 0)) {
    gap({ kind: "unsupported_format", message: "WorkBuddy 原生用量记录只含未归一化字段，保留原行并标记采集缺口", messageDescriptor: { key: "diagnostics.history.adapters.workbuddy.m002" } });
  }
  return { usage, key };
}

function modelOf(record: Record<string, unknown>): string | undefined {
  const provider = object(record.providerData);
  const message = object(record.message);
  return string(provider.model) ?? string(provider.requestModelName) ?? string(message.model);
}

function parseArguments(value: unknown, gaps: Gap[]): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch {
    addGap(gaps, "parse_error", "WorkBuddy 工具参数不是有效 JSON 字符串", { key: "diagnostics.history.adapters.workbuddy.m003" });
    return value;
  }
}

function canInferAssistantFinal(record: Record<string, unknown>): boolean {
  const status = (string(record.status) ?? "").toLowerCase().replaceAll("-", "_");
  const finish = (string(record.finishReason) ?? string(record.finish_reason) ?? string(record.stopReason) ?? "")
    .toLowerCase().replaceAll("-", "_");
  const failureStates = ["error", "failed", "failure", "interrupted", "cancelled", "canceled", "max_tokens", "length"];
  const failed = record.error !== undefined && record.error !== null || record.interrupted === true
    || failureStates.includes(status) || failureStates.includes(finish);
  const completed = ["completed", "complete", "success", "succeeded"].includes(status)
    || ["stop", "end_turn", "completed", "complete"].includes(finish);
  return completed && !failed;
}

function eventFor(record: Record<string, unknown>, row: RawHistoryRecord, metaGaps: Gap[], usageSeen: Map<string, { event: NormalizedEvent; fingerprint: string }>): NormalizedEvent[] {
  const type = string(record.type) ?? "<缺少类型>";
  const id = string(record.id) ?? `${type}:${row.line}:${normalizedHash(row.raw).slice(0, 16)}`;
  const provider = object(record.providerData);
  const message = object(record.message);
  const occurredAt = eventTime(record.timestamp);
  const model = modelOf(record);
  const events: NormalizedEvent[] = [];
  const make = (key: string, kind: NormalizedEvent["kind"], values: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    key: `${id}:${key}`,
    kind,
    occurredAt,
    model,
    ...values,
  });
  const useUsage = (event: NormalizedEvent) => {
    const normalized = usageFrom(record, gap => addGap(metaGaps, gap.kind, gap.message, gap.messageDescriptor, gap.details));
    if (!normalized.usage || !normalized.key) return;
    const fingerprint = JSON.stringify(normalized.usage);
    const previous = usageSeen.get(normalized.key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        previous.event.usage = undefined;
        event.usage = undefined;
        addGap(metaGaps, "ambiguous", "同一原生请求存在不同用量记录，未选取其中一条", { key: "diagnostics.history.adapters.workbuddy.m004" });
      }
      return;
    }
    event.usage = normalized.usage;
    event.usageKey = normalized.key;
    usageSeen.set(normalized.key, { event, fingerprint });
  };

  if (type === "message") {
    const content = textOf(record.content);
    const compacted = provider.isCompactInternal === true || provider.isCompacted === true || provider.isSummary === true;
    const contextual = provider.isMeta === true || string(record.role) === "user" && provider.startsNewUserRequest === false;
    const kind = compacted ? "compression" : contextual ? "context"
      : record.role === "user" ? "user" : record.role === "assistant" ? "assistant" : "system";
    const event = make("message", kind, { text: content,
      ...(record.role === "assistant" ? { allowInferredFinal: !compacted && canInferAssistantFinal(record) } : {}) });
    useUsage(event);
    events.push(event);
  } else if (type === "reasoning") {
    events.push(make("reasoning", "thinking", { text: textOf(record.content) || textOf(record.rawContent) }));
  } else if (type === "function_call") {
    const callId = string(record.callId);
    const event = make(`call:${callId ?? row.line}`, "tool_call", {
      callId,
      tool: string(record.name) ?? "unknown",
      input: parseArguments(record.arguments, metaGaps),
      turnKey: string(record.logicalParentId) ?? undefined,
    });
    useUsage(event);
    events.push(event);
    if (!callId) addGap(metaGaps, "ambiguous", "WorkBuddy 工具请求缺少原生 callId，无法可靠配对", { key: "diagnostics.history.adapters.workbuddy.m005" });
  } else if (type === "function_call_result") {
    const callId = string(record.callId);
    const providerResult = object(provider.workbuddyToolResult);
    const genericResult = object(provider.toolResult);
    const visible = textOf(record.output) || textOf(providerResult.stdout) || textOf(providerResult.content) || textOf(providerResult.stderr);
    const exitCode = typeof providerResult.exitCode === "number" ? providerResult.exitCode : undefined;
    const success = typeof providerResult.success === "boolean" ? providerResult.success : undefined;
    const readFileResult = object(providerResult.read_file_result);
    const readResultComplete = typeof readFileResult.content === "string" && typeof readFileResult.hasMore === "boolean"
      && typeof readFileResult.totalLineCount === "number";
    const status: HistoryEvent["status"] = string(genericResult.error) ? "failure"
      : exitCode !== undefined ? exitCode === 0 ? "success" : "failure"
      : success === true ? "success" : success === false || Boolean(providerResult.errorMessage) ? "failure"
        : readResultComplete ? "success" : "unknown";
    const result = {
      exit_code: exitCode,
      output: string(providerResult.stdout) ?? visible,
      filePath: string(providerResult.path),
      content: string(providerResult.content),
      read_file_result: providerResult.read_file_result,
      originalFile: providerResult.oldContent === undefined ? undefined : providerResult.oldContent,
      type: providerResult.isNewFile === true ? "create" : string(providerResult.type),
      success,
    };
    events.push(make(`result:${callId ?? row.line}`, "tool_result", {
      callId,
      tool: string(record.name),
      result,
      text: visible,
      status,
    }));
    if (!callId) addGap(metaGaps, "unpaired_call", "WorkBuddy 工具结果缺少原生 callId，无法可靠配对", { key: "diagnostics.history.adapters.workbuddy.m006" });
  } else if (!["ai-title", "custom-title", "file-history-snapshot"].includes(type)) {
    addGap(metaGaps, "unsupported_format", `WorkBuddy 记录类型 ${type} 尚未适配`, { key: "diagnostics.history.adapters.workbuddy.m007", params: { p0: String(type) } });
    events.push(make("unknown", "context", { text: `未适配记录类型 ${type}`, allowInferredFinal: false }));
  }
  return events;
}

async function readWorkbuddySnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = [];
  const rows = await readJsonlRows(location.path, gaps);
  const fileId = fileSessionId(location.path);
  const bodyIds = sessionIds(rows);
  const provisionalId = location.sessionId ?? location.selector ?? (bodyIds.length === 1 ? bodyIds[0] : undefined);
  const metadata = await readMetadata(location.path, bodyIds.length > 1 ? undefined : provisionalId ?? fileId);
  const sessionId = bodyIds.length > 1 ? undefined : provisionalId ?? (metadata.found ? fileId : undefined);
  if (bodyIds.length > 1) addGap(gaps, "ambiguous", "单个 WorkBuddy 文件包含多个 sessionId，未合并跨会话正文", { key: "diagnostics.history.adapters.workbuddy.m008" });
  if (sessionId && bodyIds.some(id => id !== sessionId)) addGap(gaps, "ambiguous", "WorkBuddy 正文身份与文件／元数据身份不一致，仅保留匹配记录", { key: "diagnostics.history.adapters.workbuddy.m009" });
  if (!sessionId) addGap(gaps, "unassociated", "WorkBuddy 正文没有 sessionId，且文件名未能与 sessions 元数据精确关联", { key: "diagnostics.history.adapters.workbuddy.m010" });
  if (fileId && sessionId && fileId !== sessionId) addGap(gaps, "ambiguous", "WorkBuddy 文件名与原生 sessionId 不一致", { key: "diagnostics.history.adapters.workbuddy.m011" });
  const recordRows = bodyIds.length > 1 ? [] : sessionId
    ? rows.filter(row => !string(row.record.sessionId) || row.record.sessionId === sessionId) : rows;
  const cwdValues = [...new Set(recordRows.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const dbCwd = metadata.cwd && isAbsolute(metadata.cwd) ? metadata.cwd : undefined;
  const cwd = dbCwd ?? (cwdValues.length === 1 ? cwdValues[0] : undefined);
  if (dbCwd && cwdValues.some(value => value !== dbCwd)) addGap(gaps, "ambiguous", "WorkBuddy 正文 cwd 与 sessions 元数据不一致，优先采用会话表字段", { key: "diagnostics.history.adapters.workbuddy.m012" });
  if (!dbCwd && cwdValues.length > 1) addGap(gaps, "ambiguous", "WorkBuddy 正文记录了多个 cwd，无法确认单一项目目录", { key: "diagnostics.history.adapters.workbuddy.m013" });
  const transcriptCustomTitle = recordRows.find(row => row.record.type === "custom-title" && typeof row.record.customTitle === "string");
  const transcriptAiTitle = recordRows.find(row => row.record.type === "ai-title" && typeof row.record.aiTitle === "string");
  const title = [metadata.customTitle, string(transcriptCustomTitle?.record.customTitle), metadata.title,
    string(transcriptAiTitle?.record.aiTitle)].map(value => value?.trim()).find(value => value) ?? undefined;
  const titleOrigin = title ? "recorded" : undefined;
  const source = sourceFor(location, "workbuddy", WORKBUDDY_FORMAT, sessionId, cwd);
  source.selector = sessionId;
  const events: { row: RawHistoryRecord; event: NormalizedEvent }[] = [];
  const usageSeen = new Map<string, { event: NormalizedEvent; fingerprint: string }>();
  for (const row of recordRows) {
    for (const event of eventFor(row.record, row, gaps, usageSeen)) events.push({ row, event });
  }
  return normalizedSnapshot(source, events.map(item => normalizedRecord(item.event, item.row.raw, item.row.line)), { title, titleOrigin, gaps },
    JSON.stringify([metadata, cwd, fileId, sessionId]));
}

async function discoverWorkbuddyFile(location: SourceLocation): Promise<SourceLocation[]> {
  if (!location.path.endsWith(".jsonl")) return [];
  const header = await readJsonlHeader(location.path);
  const ids = sessionIds(header);
  const fileId = fileSessionId(location.path);
  const candidate = ids.length === 1 ? ids[0] : ids.length > 1 ? undefined : fileId;
  const metadata = await readMetadata(location.path, candidate);
  const sessionId = ids.length === 1 ? ids[0] : ids.length === 0 && metadata.found ? fileId : undefined;
  const cwd = metadata.cwd && isAbsolute(metadata.cwd) ? metadata.cwd : undefined;
  const source = sourceFor(location, "workbuddy", WORKBUDDY_FORMAT, sessionId, cwd);
  source.selector = sessionId;
  return [source];
}

function visibleResult(resultValue: unknown): string {
  const result = object(resultValue);
  return string(result.output) ?? string(result.stdout) ?? string(result.content) ?? textContent(result.content) ?? "";
}

export const workbuddyAdapter: HistoryAdapter = createNormalizedAdapter({
  id: WORKBUDDY_FORMAT,
  discoverFile: discoverWorkbuddyFile,
  readSnapshot: readWorkbuddySnapshot,
  extract(tool, inputValue, resultValue, visible) {
    const input = object(inputValue);
    const result = object(resultValue);
    const name = tool === "Bash" ? "Bash" : tool;
    const mappedInput: Record<string, unknown> = name === "Bash"
      ? { ...input, cmd: string(input.command) ?? string(input.cmd) }
      : { ...input, file_path: string(input.file_path) ?? string(input.filePath) ?? string(input.path) };
    const mappedResult = name === "Bash"
      ? { ...result, exit_code: typeof result.exit_code === "number" ? result.exit_code : result.exitCode,
        output: string(result.output) ?? string(result.stdout) ?? visibleResult(resultValue) }
      : { ...result, filePath: string(result.filePath) ?? string(result.path),
        originalFile: result.originalFile ?? result.oldContent,
        type: result.isNewFile === true ? "create" : result.type };
    const output = visible || visibleResult(resultValue);
    if (["Read", "read_file"].includes(name)) {
      const readResult = object(result.read_file_result);
      const content = string(readResult.content);
      const totalLines = number(readResult.totalLineCount);
      const offset = number(input.offset);
      const returnedLines = content === undefined ? [] : physicalLines(content);
      const completeFile = readResult.hasMore === false && content !== undefined && totalLines !== undefined
        && returnedLines.length === totalLines && (offset === undefined || offset === 1);
      if (!completeFile) return [{ kind: "read", path: mappedInput.file_path as string | undefined,
        fragments: [], reason: "range_unknown: WorkBuddy Read 缺少完整文件边界或可信起始行", reasonDescriptor: { key: "diagnostics.history.adapters.workbuddy.m014" } }];
      return toolEvidence(name, mappedInput, { file: { filePath: mappedInput.file_path, startLine: 1,
        numLines: returnedLines.length, totalLines, content } }, output);
    }
    return toolEvidence(name, mappedInput, mappedResult, output);
  },
});

export function workbuddySourceIdentity(sessionId: string): string {
  return nativeSourceId("workbuddy", sessionId);
}
