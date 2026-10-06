import { dirname, resolve } from "node:path";
import type { NormalizedEvent, NormalizedSessionMetadata, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { createNormalizedAdapter, normalizedRecord, normalizedSessionKey, normalizedSnapshot } from "./normalized.js";
import { number, object, string, textContent, toolEvidence } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { readOnlySqlite, sqliteJson, sqliteTableExists } from "./sqlite-readonly.js";
import type { SourceLocation } from "../types.js";

export const ZCODE_FORMAT = "zcode-sqlite";
const missing = () => Object.assign(new Error("ZCode 会话来源已缺失"), { code: "ENOENT" });
const rowRaw = (row: Record<string, unknown>) => JSON.stringify(row);

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return undefined;
}

function buildRecords(messages: Record<string, unknown>[], parts: Record<string, unknown>[], modelUsage: Record<string, unknown>[], meta: NormalizedSessionMetadata) {
  const byMessage = new Map<string, { row: Record<string, unknown>; data: Record<string, unknown>; raw: string }[]>();
  for (const row of parts) {
    const messageId = string(row.message_id);
    if (!messageId) continue;
    const value = { row, data: sqliteJson(row.data), raw: rowRaw(row) };
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), value]);
  }
  const messagesById = new Map(messages.map(row => [String(row.id), row]));
  const messageTextById = new Map<string, string>();
  const staged: { event: NormalizedEvent; raw: string; order: number }[] = [];
  const turnByMessage = new Map<string, string>();

  for (const [messageIndex, row] of messages.entries()) {
    const id = string(row.id);
    if (!id) continue;
    const data = sqliteJson(row.data);
    const role = string(data.role);
    const grouped = byMessage.get(id) ?? [];
    const partTexts = grouped.filter(part => part.data.type === "text").map(part => string(part.data.text) ?? "").filter(Boolean);
    const text = [textContent(data.content), ...partTexts].filter(Boolean).join("\n");
    messageTextById.set(id, text);
    const created = timestamp(object(data.time).created ?? row.time_created);
    const model = string(object(data.model).modelID) ?? string(object(data.model).model) ?? string(data.model);
    const turnKey = string(data.turnId) ?? id;
    turnByMessage.set(id, turnKey);
    const raw = JSON.stringify({ message: row, textParts: grouped.filter(part => part.data.type === "text").map(part => part.row) });
    if (role === "user" || role === "assistant" || role === "system") {
      staged.push({ event: { key: `message:${id}`, kind: role, text, occurredAt: created, model, turnKey }, raw, order: messageIndex * 1_000 });
    }

    for (const [partIndex, part] of grouped.entries()) {
      const type = string(part.data.type);
      const partId = string(part.data.id) ?? string(part.row.id) ?? `${id}:${partIndex}`;
      const partTime = timestamp(object(part.data.time).start ?? object(part.data.time).created ?? part.row.time_created) ?? created;
      const partOrder = messageIndex * 1_000 + partIndex + 1;
      if (type === "reasoning") {
        const value = string(part.data.text);
        if (value) staged.push({ event: { key: `reasoning:${partId}`, kind: "thinking", text: value, occurredAt: partTime, model, turnKey }, raw: part.raw, order: partOrder });
      }
      if (type !== "tool") continue;
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
        meta.gaps.push({ kind: "ambiguous", message: `ZCode 工具 ${tool} 缺少可确认的终态` });
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
    const messageData = sqliteJson(message?.data);
    const messageKey = messageId && message ? `message:${messageId}` : `model-usage:${id ?? usageIndex}`;
    const rawUsage = sqliteJson(row.raw_usage_json);
    const providerMetadata = sqliteJson(row.provider_metadata_json);
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
      meta.gaps.push({ kind: "unsupported_format", message: "ZCode model_usage 输入与 provider 原始口径未充分对照，未将 input/cache 归一化为总输入" });
    }
    if (reasoning !== undefined && output !== undefined) {
      meta.gaps ??= [];
      meta.gaps.push({ kind: "ambiguous", message: "ZCode reasoning_tokens 与 output_tokens 的包含关系未核验，保留原字段且不相加" });
    }
    const usageEvent: NormalizedEvent = {
      key: messageKey,
      kind: message ? "assistant" : "context",
      text: message ? messageTextById.get(messageId!) ?? "" : "",
      occurredAt: timestamp(row.started_at),
      model: string(row.model_id) ?? string(messageData.model),
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

function getSession(database: import("better-sqlite3").Database, id: string) {
  const session = database.prepare("SELECT * FROM session WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!session) throw missing();
  const messages = database.prepare("SELECT * FROM message WHERE session_id=? ORDER BY rowid").all(id) as Record<string, unknown>[];
  const parts = database.prepare("SELECT * FROM part WHERE session_id=? ORDER BY rowid").all(id) as Record<string, unknown>[];
  const modelUsage = database.prepare("SELECT * FROM model_usage WHERE session_id=? ORDER BY started_at, id").all(id) as Record<string, unknown>[];
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
    if (!["session", "message", "part", "model_usage"].every(table => sqliteTableExists(database, table))) return [];
    return database.prepare("SELECT * FROM session ORDER BY id").all() as Record<string, unknown>[];
  });
  const result: SourceLocation[] = [];
  for (const row of sessions) {
    const id = string(row.id);
    if (!id) continue;
    const task = await taskFor(location.path, id);
    const cwd = normalizeHistoryPath(string(task?.workspace_path) ?? string(row.directory));
    result.push({ ...location, format: ZCODE_FORMAT, selector: id, sessionId: id,
      sourceId: normalizedSessionKey(location.client, id), cwd });
  }
  return result;
}

async function readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  if (!location.selector) throw new Error("ZCode 来源缺少原生会话选择器");
  const snapshot = await readOnlySqlite(location.path, database => {
    if (!["session", "message", "part", "model_usage"].every(table => sqliteTableExists(database, table))) throw missing();
    return getSession(database, location.selector!);
  });
  const id = string(snapshot.session.id);
  if (!id || id !== location.selector) throw missing();
  const task = await taskFor(location.path, id);
  const taskPath = normalizeHistoryPath(string(task?.workspace_path));
  const cwd = taskPath ?? normalizeHistoryPath(string(snapshot.session.directory));
  const source: SourceLocation = { ...location, format: ZCODE_FORMAT, selector: id, sessionId: id,
    sourceId: normalizedSessionKey(location.client, id), cwd };
  const meta: NormalizedSessionMetadata = { title: string(task?.title) ?? string(snapshot.session.title),
    titleOrigin: task?.title ? "task" : snapshot.session.title ? "recorded" : undefined };
  if (string(snapshot.session.parent_id) || string(task?.forked_from_task_id)) {
    meta.gaps = [{ kind: "ambiguous", message: "ZCode parent_id/forked_from_task_id 语义未核验，未判断子 Agent 或分叉关系" }];
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
