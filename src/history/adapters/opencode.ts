import type { SourceReference } from "../../contracts.js";
import type { NormalizedEvent, NormalizedSessionMetadata, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSessionKey, normalizedSnapshot } from "./normalized.js";
import { number, object, physicalLines, string, toolEvidence } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { readOnlySqlite, sqliteJson, sqliteTableExists } from "./sqlite-readonly.js";
import type { SourceLocation } from "../types.js";

export const OPENCODE_FORMAT = "opencode-sqlite";
const missing = () => Object.assign(new Error("OpenCode 会话来源已缺失"), { code: "ENOENT" });
const rowRaw = (row: Record<string, unknown>) => JSON.stringify(row);

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return undefined;
}

function total(values: (number | undefined)[]): number | undefined {
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function modelName(message: Record<string, unknown>): string | undefined {
  const model = object(message.model);
  return string(model.modelID) ?? string(model.model);
}

function usageEvent(key: string, tokensValue: unknown, model: string | undefined, occurredAt: string | undefined,
  text: string, raw: string, line: number, meta: NormalizedSessionMetadata): RawHistoryRecord {
  const tokens = object(tokensValue);
  const cache = object(tokens.cache);
  const input = number(tokens.input);
  const read = number(cache.read);
  const write = number(cache.write);
  const output = number(tokens.output);
  const reasoning = number(tokens.reasoning);
  if (input !== undefined && (read === undefined || write === undefined)) {
    meta.gaps ??= [];
    meta.gaps.push({ kind: "unsupported_format", message: "OpenCode 用量缺少缓存分项，未计算总输入" });
  }
  if (output !== undefined && reasoning === undefined) {
    meta.gaps ??= [];
    meta.gaps.push({ kind: "unsupported_format", message: "OpenCode 用量缺少 reasoning 分项，未计算总输出" });
  }
  const event: NormalizedEvent = {
    key, kind: "assistant", text, model, occurredAt,
    usageKey: key,
    usage: {
      inputTokens: total([input, read, write]),
      outputTokens: total([output, reasoning]),
      cachedInputTokens: read,
      cacheWriteTokens: write,
      reasoningOutputTokens: reasoning,
    },
  };
  return normalizedRecord(event, raw, line);
}

function textParts(parts: { row: Record<string, unknown>; data: Record<string, unknown>; raw: string }[]): string {
  return parts.filter(part => part.data.type === "text").map(part => string(part.data.text) ?? "").filter(Boolean).join("\n");
}

function buildRecords(sessionId: string, messages: Record<string, unknown>[], parts: Record<string, unknown>[], meta: NormalizedSessionMetadata) {
  const byMessage = new Map<string, { row: Record<string, unknown>; data: Record<string, unknown>; raw: string }[]>();
  for (const row of parts) {
    const messageId = string(row.message_id);
    if (!messageId) continue;
    const value = { row, data: sqliteJson(row.data), raw: rowRaw(row) };
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), value]);
  }

  const staged: { event: NormalizedEvent; raw: string; order: number }[] = [];
  const childIds = new Set(meta.childSessionIds ?? []);
  for (const [messageIndex, row] of messages.entries()) {
    const id = string(row.id);
    if (!id) continue;
    const data = sqliteJson(row.data);
    const role = string(data.role);
    const grouped = byMessage.get(id) ?? [];
    const text = textParts(grouped);
    const created = timestamp(object(data.time).created ?? row.time_created);
    const model = modelName(data);
    const parentMessage = string(data.parentID) ?? string(data.parent_id);
    const turnKey = parentMessage ?? id;
    const messageRaw = JSON.stringify({ message: row, parts: grouped.filter(part => part.data.type === "text").map(part => part.row) });

    if (role === "user" || role === "assistant" || role === "system") {
      const event: NormalizedEvent = { key: `message:${id}`, kind: role, text, model, occurredAt: created, turnKey };
      staged.push({ event, raw: messageRaw, order: messageIndex * 1_000 });
    }

    for (const [partIndex, part] of grouped.entries()) {
      const type = string(part.data.type);
      const partId = string(part.data.id) ?? string(part.row.id) ?? `${id}:${partIndex}`;
      const partTime = timestamp(object(part.data.time).start ?? part.row.time_created) ?? created;
      const partRaw = part.raw;
      const partOrder = messageIndex * 1_000 + partIndex + 1;
      if (type === "reasoning") {
        const value = string(part.data.text);
        if (value) staged.push({ event: { key: `reasoning:${partId}`, kind: "thinking", text: value, model, occurredAt: partTime, turnKey }, raw: partRaw, order: partOrder });
      }
      if (type === "step-finish") {
        staged.push({ event: { ...usageEvent(`step:${partId}`, part.data.tokens, model, partTime, text, partRaw, 0, meta).record.normalizedEvent as NormalizedEvent,
          key: `message:${id}`, turnKey }, raw: partRaw, order: partOrder });
      }
      if (type !== "tool") continue;
      const callId = string(part.data.callID) ?? string(object(part.data.state).callID) ?? partId;
      const state = object(part.data.state);
      const tool = string(part.data.tool) ?? "unknown";
      const input = object(state.input);
      const stateMetadata = object(state.metadata);
      const taskMeta = object(stateMetadata);
      if (tool === "task" && string(taskMeta.parentSessionId) === sessionId && string(taskMeta.sessionId)) childIds.add(String(taskMeta.sessionId));
      staged.push({ event: { key: `tool-call:${partId}`, kind: "tool_call", callId, tool, input, model, occurredAt: partTime, turnKey }, raw: partRaw, order: partOrder });
      const status = string(state.status);
      const outputValue = state.output;
      const errorValue = state.error;
      if (outputValue === undefined && errorValue === undefined) continue;
      const bashExit = number(stateMetadata.exit);
      const resultStatus = errorValue !== undefined || status === "error" ? "failure"
        : status === "completed" && tool !== "bash" ? "success"
          : status === "completed" && bashExit !== undefined ? bashExit === 0 ? "success" : "failure" : "unknown";
      if (resultStatus === "unknown") {
        meta.gaps ??= [];
        meta.gaps.push({ kind: "ambiguous", message: `OpenCode 工具 ${tool} 缺少可确认的终态` });
      }
      const result = { output: outputValue, error: errorValue, metadata: stateMetadata, status };
      const textOutput = typeof outputValue === "string" ? outputValue : Array.isArray(outputValue)
        ? outputValue.map(value => string(object(value).text) ?? "").join("\n") : "";
      staged.push({ event: { key: `tool-result:${partId}`, kind: "tool_result", callId, result, text: textOutput,
        status: resultStatus, model, occurredAt: timestamp(object(state.time).end) ?? partTime, turnKey }, raw: partRaw, order: partOrder + 0.5 });
    }

    const hasStepUsage = grouped.some(part => part.data.type === "step-finish");
    if (role === "assistant" && !hasStepUsage && data.tokens !== undefined) {
      const usage = usageEvent(`message:${id}`, data.tokens, model, created, text, rowRaw(row), 0, meta).record.normalizedEvent as NormalizedEvent;
      staged.push({ event: { ...usage, key: `message:${id}`, turnKey }, raw: rowRaw(row), order: messageIndex * 1_000 + 999 });
    }
  }

  const records: RawHistoryRecord[] = [];
  const lineByRaw = new Map<string, number>();
  const partLines = new Map<string, number>();
  for (const item of staged.sort((left, right) => left.order - right.order || left.event.key.localeCompare(right.event.key))) {
    let line = lineByRaw.get(item.raw);
    if (line === undefined) { line = lineByRaw.size + 1; lineByRaw.set(item.raw, line); }
    if (item.event.key.startsWith("tool-call:")) partLines.set(item.event.key.slice("tool-call:".length), line);
    records.push(normalizedRecord(item.event, item.raw, line));
  }
  meta.childSessionIds = [...childIds];
  return { records, partLines };
}

function sessionRows(database: import("better-sqlite3").Database, id: string) {
  const session = database.prepare("SELECT * FROM session WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!session) throw missing();
  const messages = database.prepare("SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC, id ASC").all(id) as Record<string, unknown>[];
  const parts = database.prepare("SELECT * FROM part WHERE session_id=? ORDER BY time_created ASC, id ASC").all(id) as Record<string, unknown>[];
  return { session, messages, parts };
}

function taskChildIds(sessionId: string, parts: Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const row of parts) {
    const part = sqliteJson(row.data);
    if (part.type !== "tool" || part.tool !== "task") continue;
    const state = object(part.state);
    const metadata = object(state.metadata);
    if (string(metadata.parentSessionId) === sessionId && string(metadata.sessionId)) ids.add(String(metadata.sessionId));
  }
  return [...ids];
}

async function discoverFile(location: SourceLocation): Promise<SourceLocation[]> {
  return readOnlySqlite(location.path, database => {
    if (!["session", "message", "part"].every(table => sqliteTableExists(database, table))) return [];
    const rows = database.prepare("SELECT id FROM session ORDER BY id").all() as { id: string }[];
    return rows.filter(row => typeof row.id === "string").map(row => ({ ...location, format: OPENCODE_FORMAT,
      selector: row.id, sessionId: row.id, sourceId: normalizedSessionKey(location.client, row.id) }));
  });
}

async function readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  if (!location.selector) throw new Error("OpenCode 来源缺少原生会话选择器");
  const selected = await readOnlySqlite(location.path, database => {
    if (!["session", "message", "part"].every(table => sqliteTableExists(database, table))) throw missing();
    const current = sessionRows(database, location.selector!);
    const parentId = string(current.session.parent_id);
    const parent = parentId ? (database.prepare("SELECT id FROM session WHERE id=?").get(parentId) ? sessionRows(database, parentId) : undefined) : undefined;
    return { current, parent };
  });
  const id = string(selected.current.session.id);
  if (!id || id !== location.selector) throw missing();
  const cwd = normalizeHistoryPath(string(selected.current.session.directory));
  const source: SourceLocation = { ...location, format: OPENCODE_FORMAT, selector: id,
    sessionId: id, sourceId: normalizedSessionKey(location.client, id), cwd };
  const sessionData = selected.current.session;
  const agent = string(sessionData.agent);
  const title = string(sessionData.title);
  const parentId = string(sessionData.parent_id);
  const metadata: NormalizedSessionMetadata = { title };
  if (parentId && selected.parent) {
    const parentMeta: NormalizedSessionMetadata = { childSessionIds: taskChildIds(parentId, selected.parent.parts) };
    const parentRecords = buildRecords(parentId, selected.parent.messages, selected.parent.parts, parentMeta);
    const taskRow = selected.parent.parts.find(row => {
      const part = sqliteJson(row.data);
      const state = object(part.state);
      const partMeta = object(state.metadata);
      return part.type === "tool" && part.tool === "task" && string(partMeta.parentSessionId) === parentId && string(partMeta.sessionId) === id;
    });
    const taskId = taskRow ? string(sqliteJson(taskRow.data).id) ?? string(taskRow.id) : undefined;
    const proofLine = taskId ? parentRecords.partLines.get(taskId) : undefined;
    if (taskRow && proofLine !== undefined) {
      const raw = rowRaw(taskRow);
      const reference: SourceReference = { sourceId: normalizedSessionKey(location.client, parentId), format: OPENCODE_FORMAT,
        path: location.path, selector: parentId, recordLine: proofLine, hash: normalizedHash(raw) };
      metadata.relationship = "child";
      metadata.parentSessionId = parentId;
      metadata.relationships = [{ kind: "subagent", parentSessionId: parentId, agentId: agent, sources: [reference] }];
    }
  }
  if (!metadata.relationship && parentId && agent && title?.endsWith(`(@${agent} subagent)`)) {
    metadata.relationship = "child";
    metadata.parentSessionId = parentId;
    metadata.relationships = [{ kind: "subagent", parentSessionId: parentId, agentId: agent }];
  } else if (!metadata.relationship && parentId) {
    metadata.gaps = [{ kind: "ambiguous", message: "OpenCode parent_id 可由通用 Session.create 输入设置，未找到 Task 子会话证据，父类型未确认" }];
  }
  const records = buildRecords(id, selected.current.messages, selected.current.parts, metadata).records;
  const sessionRaw = rowRaw(selected.current.session);
  const fingerprint = JSON.stringify({ session: sessionRaw, parent: selected.parent ? rowRaw(selected.parent.session) : undefined,
    parentTaskIds: taskChildIds(id, selected.current.parts) });
  return normalizedSnapshot(source, records, metadata, fingerprint);
}

function readToolEvidence(inputValue: unknown, resultValue: unknown, visible: string) {
  const input = object(inputValue);
  const result = object(resultValue);
  const metadata = object(result.metadata);
  const display = object(metadata.display);
  const requestedPath = string(input.filePath) ?? string(input.path);
  if (display.type !== "file" || typeof display.text !== "string" || typeof display.lineStart !== "number"
    || typeof display.lineEnd !== "number" || typeof display.totalLines !== "number") {
    return [{ kind: "read" as const, path: requestedPath, fragments: [], reason: "range_unknown: OpenCode Read 缺少可核验的文件展示元数据" }];
  }
  if (metadata.truncated === true || display.truncated === true) {
    return [{ kind: "read" as const, path: requestedPath, fragments: [], reason: "range_unknown: OpenCode Read 返回已截断" }];
  }
  const path = string(display.path);
  const count = physicalLines(display.text).length;
  if (!path || requestedPath !== path || display.lineEnd - display.lineStart + 1 !== count
    || display.lineStart < 1 || display.lineEnd < display.lineStart - 1) {
    return [{ kind: "read" as const, path: requestedPath, fragments: [], reason: "range_unknown: OpenCode Read 元数据与请求路径或行数不一致" }];
  }
  return toolEvidence("Read", { path, offset: number(input.offset), limit: number(input.limit) },
    { file: { filePath: path, content: display.text, startLine: display.lineStart, numLines: count, totalLines: display.totalLines } }, visible);
}

export const opencodeAdapter = createNormalizedAdapter({
  id: OPENCODE_FORMAT,
  discoverFile,
  readSnapshot,
  extract(tool, input, result, visible) {
    if (tool === "read") return readToolEvidence(input, result, visible);
    if (tool === "edit") {
      const value = object(input);
      return toolEvidence("Edit", { path: value.filePath, old_string: value.oldString, new_string: value.newString }, result, visible);
    }
    if (tool === "bash") {
      const value = object(input);
      const metadata = object(object(result).metadata);
      return toolEvidence("Bash", { command: value.command }, { exit_code: metadata.exit }, visible);
    }
    return toolEvidence(tool, input, result, visible);
  },
});
