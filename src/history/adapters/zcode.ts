import type { MessageDescriptor } from "../../i18n/types.js";
import { DiagnosticError } from "../../i18n/diagnostics.js";
import { dirname, resolve } from "node:path";
import type { NormalizedEvent, NormalizedSessionMetadata, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { createNormalizedAdapter, normalizedRecord, normalizedSessionKey, normalizedSnapshot } from "./normalized.js";
import { number, object, string, textContent, toolEvidence } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { createSqliteReadBudget, readOnlySqlite, readSqliteRows, sqliteJson, sqliteTableExists } from "./sqlite-readonly.js";
import type { SourceLocation } from "../types.js";

export const ZCODE_FORMAT = "zcode-sqlite";
const missing = () => Object.assign(new DiagnosticError("ZCode 会话来源已缺失", { key: "diagnostics.history.adapters.zcode.m001" }), { code: "ENOENT" });
const UNSUPPORTED_SCHEMA = "__unsupported_schema__";
const READ_BUDGET_EXCEEDED = "__read_budget_exceeded__";
const rowRaw = (row: Record<string, unknown>) => JSON.stringify(row);

function diagnosticSnapshot(location: SourceLocation, kind: "unsupported_format" | "budget_exceeded", message: string, messageDescriptor?: MessageDescriptor): NormalizedSnapshot {
  const { adapterGap: _adapterGap, ...source } = location;
  return normalizedSnapshot(source, [], { gaps: [{ kind, message, messageDescriptor }] });
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return undefined;
}

function buildRecords(messages: Record<string, unknown>[], parts: Record<string, unknown>[], modelUsage: Record<string, unknown>[], meta: NormalizedSessionMetadata) {
  const gaps = meta.gaps ?? (meta.gaps = []);
  const byMessage = new Map<string, { row: Record<string, unknown>; data: Record<string, unknown>; raw: string }[]>();
  for (const row of parts) {
    const messageId = string(row.message_id);
    if (!messageId) continue;
    const value = { row, data: sqliteJson(row.data, gaps), raw: rowRaw(row) };
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), value]);
  }
  const messagesById = new Map(messages.map(row => [String(row.id), row]));
  const staged: { event: NormalizedEvent; raw: string; order: number }[] = [];
  const turnByMessage = new Map<string, string>();

  for (const [messageIndex, row] of messages.entries()) {
    const id = string(row.id);
    if (!id) continue;
    const data = sqliteJson(row.data, gaps);
    const role = string(data.role);
    const grouped = byMessage.get(id) ?? [];
    const partTexts = grouped.filter(part => part.data.type === "text").map(part => string(part.data.text) ?? "").filter(Boolean);
    const text = [textContent(data.content), ...partTexts].filter(Boolean).join("\n");
    const created = timestamp(object(data.time).created ?? row.time_created);
    const model = string(object(data.model).modelID) ?? string(object(data.model).model) ?? string(data.model);
    const turnKey = string(data.turnId) ?? id;
    turnByMessage.set(id, turnKey);
    const raw = JSON.stringify({ message: row, textParts: grouped.filter(part => part.data.type === "text").map(part => part.row) });
    const knownRole = role === "user" || role === "assistant" || role === "system";
    if (!knownRole) {
      gaps.push({ kind: "unsupported_format", message: `ZCode message role ${role ?? "<缺少角色>"} 尚未适配`, messageDescriptor: (role) !== undefined ? { key: "diagnostics.history.adapters.zcode.m002", params: { p0: String(role) } } : { key: "diagnostics.history.adapters.zcode.m003" } });
    }
    if (knownRole) {
      const finishReason = (string(data.finish) ?? string(data.stopReason) ?? string(data.finishReason) ?? "")
        .toLowerCase().replaceAll("-", "_");
      const completedAt = timestamp(object(data.time).completed);
      const normalFinish = ["stop", "end_turn", "complete", "completed", "success"].includes(finishReason);
      const failed = data.error !== undefined && data.error !== null || data.interrupted === true
        || ["error", "failed", "failure", "interrupted", "cancelled", "canceled", "max_tokens", "length"].includes(finishReason);
      const hasToolPart = grouped.some(part => part.data.type === "tool");
      const allowInferredFinal = role === "assistant" && !failed && !hasToolPart
        && (normalFinish || Boolean(completedAt) && !finishReason);
      staged.push({ event: { key: `message:${id}`, kind: role, text, occurredAt: created, model, turnKey,
        ...(role === "assistant" ? { allowInferredFinal } : {}) }, raw, order: messageIndex * 1_000 });
    } else {
      staged.push({ event: { key: `message:${id}`, kind: "context", text, occurredAt: created, model, turnKey,
        allowInferredFinal: false }, raw, order: messageIndex * 1_000 });
    }

    for (const [partIndex, part] of grouped.entries()) {
      const type = string(part.data.type);
      const partId = string(part.data.id) ?? string(part.row.id) ?? `${id}:${partIndex}`;
      const partTime = timestamp(object(part.data.time).start ?? object(part.data.time).created ?? part.row.time_created) ?? created;
      const partOrder = messageIndex * 1_000 + partIndex + 1;
      if (type === "text") continue;
      if (type === "reasoning") {
        const value = string(part.data.text);
        if (value) staged.push({ event: { key: `reasoning:${partId}`, kind: "thinking", text: value, occurredAt: partTime, model, turnKey }, raw: part.raw, order: partOrder });
      }
      if (type !== "tool") {
        if (type !== "reasoning") {
          gaps.push({ kind: "unsupported_format", message: `ZCode part 类型 ${type ?? "<缺少类型>"} 尚未适配`, messageDescriptor: (type) !== undefined ? { key: "diagnostics.history.adapters.zcode.m004", params: { p0: String(type) } } : { key: "diagnostics.history.adapters.zcode.m005" } });
          staged.push({ event: { key: `unknown-part:${partId}`, kind: "context",
            text: `未适配 ZCode part 类型 ${type ?? "<缺少类型>"}`, occurredAt: partTime, model, turnKey, allowInferredFinal: false },
            raw: part.raw, order: partOrder });
        }
        continue;
      }
      const state = object(part.data.state);
      const callId = string(part.data.callID) ?? partId;
      const tool = string(part.data.tool) ?? "unknown";
      const input = object(state.input);
      staged.push({ event: { key: `tool-call:${partId}`, kind: "tool_call", callId, tool, input, occurredAt: partTime, model, turnKey }, raw: part.raw, order: partOrder });
      if (state.output === undefined && state.error === undefined) continue;
      const stateName = string(state.status);
      const status = state.error !== undefined || stateName === "error" ? "failure"
        : stateName === "completed" ? "success" : "unknown";
      if (status === "unknown") {
        meta.gaps ??= [];
        meta.gaps.push({ kind: "ambiguous", message: `ZCode 工具 ${tool} 缺少可确认的终态`, messageDescriptor: { key: "diagnostics.history.adapters.zcode.m006", params: { p0: String(tool) } } });
      }
      const result = { input: state.input, output: state.output, error: state.error, metadata: state.metadata, status: stateName };
      const visible = textContent(state.output);
      staged.push({ event: { key: `tool-result:${partId}`, kind: "tool_result", callId, result, text: visible, status,
        occurredAt: timestamp(object(state.time).end) ?? partTime, model, turnKey }, raw: part.raw, order: partOrder + 0.5 });
    }
  }

  for (const [usageIndex, row] of modelUsage.entries()) {
    const id = string(row.id);
    const messageId = string(row.assistant_message_id);
    const parentUser = string(row.parent_user_message_id);
    const message = messageId ? messagesById.get(messageId) : undefined;
    const messageData = sqliteJson(message?.data, gaps);
    const messageKey = messageId && message ? `message:${messageId}` : undefined;
    const rawUsage = sqliteJson(row.raw_usage_json, gaps);
    const providerMetadata = sqliteJson(row.provider_metadata_json, gaps);
    const anthropicUsage = object(object(providerMetadata.anthropic).usage);
    const input = number(row.input_tokens);
    const read = number(row.cache_read_input_tokens);
    const write = number(row.cache_creation_input_tokens);
    const output = number(row.output_tokens);
    const reasoning = number(row.reasoning_tokens);
    const rawInputMatches = input !== undefined && number(rawUsage.inputTokens) === input;
    const cacheBucketsMatch = read !== undefined && write !== undefined
      && number(rawUsage.cacheReadTokens) === read && number(rawUsage.cacheWriteTokens) === write;
    const providerInputMatches = input !== undefined && number(anthropicUsage.input_tokens) === input;
    const knownTotalInput = providerInputMatches && rawInputMatches && cacheBucketsMatch && read !== undefined && write !== undefined
      ? input + read + write : undefined;
    if (input !== undefined && knownTotalInput === undefined) {
      meta.gaps ??= [];
      meta.gaps.push({ kind: "unsupported_format", message: "ZCode model_usage 输入与 provider 原始口径未充分对照，未将 input/cache 归一化为总输入", messageDescriptor: { key: "diagnostics.history.adapters.zcode.m007" } });
    }
    if (reasoning !== undefined && output !== undefined) {
      meta.gaps ??= [];
      meta.gaps.push({ kind: "ambiguous", message: "ZCode reasoning_tokens 与 output_tokens 的包含关系未核验，保留原字段且不相加", messageDescriptor: { key: "diagnostics.history.adapters.zcode.m008" } });
    }
    const usageEvent: NormalizedEvent = {
      key: `model-usage:${id ?? usageIndex}`,
      kind: "context",
      ...(message ? { text: "model usage attempt" } : {}),
      occurredAt: timestamp(row.started_at),
      model: string(row.model_id) ?? string(messageData.model),
      usageMessageKey: messageKey,
      usageKey: `attempt:${id ?? `${string(row.logical_request_id) ?? "request"}:${number(row.attempt_index) ?? usageIndex}`}`,
      turnKey: parentUser ? turnByMessage.get(parentUser) ?? parentUser : string(row.turn_id),
      usage: {
        inputTokens: knownTotalInput,
        outputTokens: output,
        cachedInputTokens: read,
        cacheWriteTokens: write,
        reasoningOutputTokens: reasoning,
      },
    };
    staged.push({ event: usageEvent, raw: rowRaw(row), order: messages.length * 1_000 + usageIndex });
  }

  const records: RawHistoryRecord[] = [];
  const lineByRaw = new Map<string, number>();
  for (const item of staged.sort((left, right) => left.order - right.order || left.event.key.localeCompare(right.event.key))) {
    let line = lineByRaw.get(item.raw);
    if (line === undefined) { line = lineByRaw.size + 1; lineByRaw.set(item.raw, line); }
    records.push(normalizedRecord(item.event, item.raw, line));
  }
  return records;
}

function getSession(database: import("better-sqlite3").Database, id: string, gaps: NonNullable<NormalizedSessionMetadata["gaps"]>, budget: ReturnType<typeof createSqliteReadBudget>) {
  const session = database.prepare("SELECT * FROM session WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!session) throw missing();
  const messages = readSqliteRows(database, "SELECT * FROM message WHERE session_id=? ORDER BY rowid", gaps, budget, id);
  const parts = readSqliteRows(database, "SELECT * FROM part WHERE session_id=? ORDER BY rowid", gaps, budget, id);
  const modelUsage = readSqliteRows(database, "SELECT * FROM model_usage WHERE session_id=? ORDER BY started_at, id", gaps, budget, id);
  return { session, messages, parts, modelUsage };
}

function taskIndexPath(databasePath: string): string {
  return resolve(dirname(databasePath), "../../v2/tasks-index.sqlite");
}

async function taskFor(databasePath: string, id: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readOnlySqlite(taskIndexPath(databasePath), database => {
      if (!sqliteTableExists(database, "tasks")) return undefined;
      return database.prepare("SELECT * FROM tasks WHERE task_id=?").get(id) as Record<string, unknown> | undefined;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function discoverFile(location: SourceLocation): Promise<SourceLocation[]> {
  const sessions = await readOnlySqlite(location.path, database => {
    if (!["session", "message", "part", "model_usage"].every(table => sqliteTableExists(database, table))) {
      return { rows: [], gap: { kind: "unsupported_format" as const, message: "ZCode SQLite 表结构尚未适配，保留来源并标记缺口", messageDescriptor: { key: "diagnostics.history.adapters.zcode.m009" } } };
    }
    const gaps: NonNullable<NormalizedSessionMetadata["gaps"]> = [];
    const budget = createSqliteReadBudget();
    const rows = readSqliteRows(database, "SELECT * FROM session ORDER BY id", gaps, budget);
    return { rows, gap: budget.exceeded ? gaps[0] : undefined };
  });
  const result: SourceLocation[] = [];
  for (const row of sessions.rows) {
    const id = string(row.id);
    if (!id) continue;
    const task = await taskFor(location.path, id);
    const cwd = normalizeHistoryPath(string(task?.workspace_path) ?? string(row.directory));
    result.push({ ...location, format: ZCODE_FORMAT, selector: id, sessionId: id,
      sourceId: normalizedSessionKey(location.client, id), cwd });
  }
  if (sessions.gap) result.push({ ...location, format: ZCODE_FORMAT, selector: sessions.gap.kind === "unsupported_format" ? UNSUPPORTED_SCHEMA : READ_BUDGET_EXCEEDED,
    adapterGap: sessions.gap });
  return result;
}

async function readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  if (location.adapterGap) return diagnosticSnapshot(location, location.adapterGap.kind === "budget_exceeded" ? "budget_exceeded" : "unsupported_format", location.adapterGap.message, location.adapterGap.messageDescriptor);
  if (location.selector === UNSUPPORTED_SCHEMA) return diagnosticSnapshot(location, "unsupported_format", "ZCode SQLite 表结构尚未适配，保留来源并标记缺口", { key: "diagnostics.history.adapters.zcode.m009" });
  if (location.selector === READ_BUDGET_EXCEEDED) return diagnosticSnapshot(location, "budget_exceeded", "ZCode 会话目录超过 SQLite 有界读取上限", { key: "diagnostics.history.adapters.zcode.catalogBudget" });
  if (!location.selector) throw new DiagnosticError("ZCode 来源缺少原生会话选择器", { key: "diagnostics.history.adapters.zcode.m010" });
  const gaps: NonNullable<NormalizedSessionMetadata["gaps"]> = [];
  const budget = createSqliteReadBudget();
  const snapshot = await readOnlySqlite(location.path, database => {
    if (!["session", "message", "part", "model_usage"].every(table => sqliteTableExists(database, table))) throw missing();
    return getSession(database, location.selector!, gaps, budget);
  });
  const id = string(snapshot.session.id);
  if (!id || id !== location.selector) throw missing();
  const task = await taskFor(location.path, id);
  const taskPath = normalizeHistoryPath(string(task?.workspace_path));
  const cwd = taskPath ?? normalizeHistoryPath(string(snapshot.session.directory));
  const source: SourceLocation = { ...location, format: ZCODE_FORMAT, selector: id, sessionId: id,
    sourceId: normalizedSessionKey(location.client, id), cwd };
  const meta: NormalizedSessionMetadata = { title: string(task?.title) ?? string(snapshot.session.title), gaps,
    titleOrigin: task?.title ? "task" : snapshot.session.title ? "recorded" : undefined };
  if (string(snapshot.session.parent_id) || string(task?.forked_from_task_id)) {
    gaps.push({ kind: "ambiguous", message: "ZCode parent_id/forked_from_task_id 语义未核验，未判断子 Agent 或分叉关系", messageDescriptor: { key: "diagnostics.history.adapters.zcode.m011" } });
  }
  const records = buildRecords(snapshot.messages, snapshot.parts, snapshot.modelUsage, meta);
  const fingerprint = JSON.stringify({ session: rowRaw(snapshot.session), task: task ? rowRaw(task) : null });
  return normalizedSnapshot(source, records, meta, fingerprint);
}

export const zcodeAdapter = createNormalizedAdapter({
  id: ZCODE_FORMAT,
  discoverFile,
  readSnapshot,
  extract(tool, input, result, visible) {
    return toolEvidence(tool, input, result, visible);
  },
});
