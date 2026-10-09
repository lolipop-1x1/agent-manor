import type { MessageDescriptor } from "../i18n/types.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Client, Gap, GapKind } from "../contracts.js";
import { historyRelationships, normalizeHistoryPath } from "../history/adapters/common.js";
import { shellResult } from "../history/extraction.js";
import type { SourceLocation } from "../history/types.js";
import type { MessageKind, SessionMessage, SessionSink, SessionSourceMeta } from "../session-contracts.js";
import { object, string, tokens, UsageParser } from "./parser-usage.js";
import { RequestTimingParser } from "./parser-timing.js";
import { projectFromToolPaths } from "./parser-project.js";
import { sessionTitle } from "./title.js";
import { codexContext } from "./codex-context.js";
import { DESKTOP_FORMAT, desktopCalls, desktopIdentity, desktopResult, desktopTimestamp } from "../history/adapters/codeflicker-desktop.js";
import type { DesktopModelRecord } from "./codeflicker-desktop.js";
import { IDE_FORMAT, readIdeSnapshot } from "../history/adapters/codeflicker-ide.js";
import type { IdeSnapshot } from "../history/adapters/codeflicker-ide.js";
import { ideSessionRecords } from "./codeflicker-ide.js";
import { sessionExecutionMode } from "../session-execution.js";
import { historyAdapter, historyClient } from "../history/adapters/index.js";
import { parseNormalizedSession, type NormalizedSnapshot } from "../history/adapters/normalized.js";
import { callResource, successfulSkillRead } from "./resources.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const sessionKey = (client: Client, rawId: string): string => `${client}:${digest(rawId)}`;

/** 分段读取并限制单条记录大小；不完整末行留待下次刷新，不能当作完整消息。 */
async function* records(path: string, gap: (kind: GapKind, message: string, messageDescriptor?: MessageDescriptor) => void, byteLimit?: number) {
  if (byteLimit === 0) return;
  let parts: Buffer[] = [];
  let length = 0;
  let line = 0;
  let oversized = false;
  for await (const value of createReadStream(path, { highWaterMark: 65_536, end: byteLimit === undefined ? undefined : byteLimit - 1 })) {
    const chunk = value as Buffer;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      length += part.length;
      if (!oversized && length <= MAX_RECORD_BYTES) parts.push(part);
      else { oversized = true; parts = []; }
      if (newline < 0) break;
      line += 1;
      if (oversized) gap("budget_exceeded", "单条历史记录超过 16 MiB，正文未索引", { key: "diagnostics.sessions.parser.m001" });
      else if (length) {
        const raw = Buffer.concat(parts, length).toString("utf8");
        try { yield { record: object(JSON.parse(raw)), line }; }
        catch { gap("parse_error", "历史存在无效 JSON 记录，已跳过并保留缺口", { key: "diagnostics.sessions.parser.m002" }); }
      }
      parts = []; length = 0; oversized = false; start = newline + 1;
    }
  }
  if (length || oversized) gap("incomplete_record", "历史末尾尚无完整 JSONL 换行，等待来源追加", { key: "diagnostics.sessions.parser.m003" });
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(item => {
    const block = object(item);
    return string(block.text) ?? string(block.thinking) ?? (block.type === "input_image" || block.type === "image" ? "[图片]" : "");
  }).filter(Boolean).join("\n");
}

function display(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
}

function filePaths(input: unknown): string[] | undefined {
  const value = object(input);
  const paths = [value.file_path, value.filePath, value.path, value.absoluteFilePath].filter((path): path is string => typeof path === "string");
  return paths.length ? [...new Set(paths)] : undefined;
}

interface Pending { message: SessionMessage; bytes: number; input: unknown }

/** 只清理标题候选中的完整注入包，消息正文与轮次保持原样。 */
function userTitle(body: string): string {
  let value = body.trim();
  const request = /(?:^|\n)## My request:\s*\n/.exec(value);
  if (request && /(?:^|\n)<in-app-browser-context\b/.test(value.slice(0, request.index))) value = value.slice(request.index + request[0].length).trim();
  while (value) {
    const tag = value.startsWith("# AGENTS.md") ? "INSTRUCTIONS"
      : /^<(INSTRUCTIONS|environment_context|in-app-browser-context|skill|recommended_plugins|turn_aborted)(?:\s[^>]*)?>/.exec(value)?.[1];
    if (!tag) break;
    const end = value.indexOf(`</${tag}>`);
    if (end < 0) break;
    value = value.slice(end + tag.length + 3).trim();
  }
  return value.replace(/\s+/g, " ").slice(0, 120);
}

export async function parseSessionSource(source: SourceLocation, sink: SessionSink, options: { byteLimit?: number; title?: string; projectMetadata?: { project?: string; ambiguous?: boolean }; desktopModels?: Map<string, DesktopModelRecord>; nativeSnapshot?: IdeSnapshot; normalizedSnapshot?: NormalizedSnapshot } = {}): Promise<SessionSourceMeta> {
  const adapter = historyAdapter(source.format ?? historyClient(source.client).format);
  if (adapter?.normalized) {
    const snapshot = options.normalizedSnapshot ?? await adapter.readRecords!(source) as NormalizedSnapshot;
    return parseNormalizedSession(snapshot, sink, adapter.extract);
  }
  const ideSnapshot = options.nativeSnapshot ?? (source.format === IDE_FORMAT ? await readIdeSnapshot(source) : undefined);
  if (ideSnapshot) { source = ideSnapshot.source; options = { ...options, title: ideSnapshot.title }; }
  const inputRecords = (onGap: (kind: GapKind, message: string, messageDescriptor?: MessageDescriptor) => void) => ideSnapshot ? ideSessionRecords(ideSnapshot) : records(source.path, onGap, options.byteLimit);
  const gaps = new Map<string, Gap>();
  const gap = (kind: GapKind, message: string, messageDescriptor?: MessageDescriptor) => {
    const key = `${kind}:${message}`;
    const previous = gaps.get(key);
    if (previous) previous.count = (previous.count ?? 1) + 1;
    else gaps.set(key, { kind, message, messageDescriptor, sourceId: source.sourceId, count: 1 });
  };
  let rawId = source.sessionId;
  if (!rawId) {
    for await (const { record } of inputRecords(() => {})) {
      const payload = object(record.payload);
      rawId = (record.type === "session_meta" ? string(payload.id) : undefined) ?? string(record.sessionId) ?? string(payload.session_id);
      if (rawId) { if (string(record.agentId)) rawId += `/agent/${record.agentId}`; break; }
    }
  }
  rawId ??= `unknown:${digest(resolve(source.path))}`;
  const id = sessionKey(source.client, rawId);
  const meta: SessionSourceMeta = { id, client: source.client, clientSessionId: rawId, path: source.path,
    sourceId: source.sourceId ?? `${source.client}:unidentified:${digest(resolve(source.path))}`,
    title: "未命名会话", titleOrigin: "fallback", project: source.cwd && isAbsolute(source.cwd) ? source.cwd : undefined,
    projectOrigin: source.cwd && isAbsolute(source.cwd) ? ideSnapshot ? "client_metadata" : "cwd" : undefined,
    parentSessionId: source.parentSessionId ? sessionKey(source.client, source.parentSessionId) : undefined,
    relationship: source.parentSessionId ? "child" : undefined, messageCount: 0, turnCount: 0, models: [], gaps: [] };
  const seen = new Map<string, { ordinal: number; turnId: string }>();
  const pending = new Map<string, Pending>();
  const completed = new Map<string, Pick<SessionMessage, "status" | "durationMs" | "resource" | "filePaths">>();
  const models = new Set<string>();
  const targets = new Map<string, Set<string>>();
  let targetsLimited = false;
  let pendingBytes = 0;
  let turnId = `${id}:turn:0`;
  let currentModel: string | undefined;
  let candidate: SessionMessage | undefined;
  let interrupted = false;
  let desktopTurn: string | undefined;
  let copyBeforeOrdinal: number | undefined;
  let hasResponseTranscript = false;
  let projectedReasoning: { key: string; text: string; turnId: string } | undefined;
  let firstUserTitle: string | undefined;
  // Codex 同时保存响应项与 UI 事件投影；存在响应正文时采用响应项，避免把同一消息计两遍。
  if (source.client === "codex") {
    for await (const { record } of inputRecords(() => {})) {
      const payload = object(record.payload);
      if (record.type === "response_item" && ["message", "agent_message"].includes(string(payload.type) ?? "")) { hasResponseTranscript = true; break; }
    }
  }
  let currentRecordLine = 0;
  const usageMarkers = new Map<string, SessionMessage>();
  const usage = new UsageParser(id, { message: sink.message, usage: value => {
    if (source.client !== "codex" || value.messageId || !usage.hasRecordedUsage(value.id)) { sink.usage(value); return; }
    // 用量定位到实际保存该用量的记录，不猜测它属于哪段助手正文。
    const previous = usageMarkers.get(value.id);
    const body = `请求用量（记录值）\n${display(value)}`;
    const event = previous ? { ...previous, text: body } : message(`usage:${value.id}`, "system", body, currentRecordLine,
      { occurredAt: value.occurredAt, model: value.model, textDescriptor: { key: "sessions.body.usage" } });
    if (previous) sink.message(event);
    usageMarkers.set(value.id, event);
    sink.usage({ ...value, messageId: event.id });
  } }, gap);
  const timing = source.format !== DESKTOP_FORMAT && !ideSnapshot && ["codex", "claude", "codeflicker"].includes(source.client)
    ? new RequestTimingParser(source.client as "codex" | "claude" | "codeflicker", usage) : undefined;
  const childReference = (tool: string | undefined, result: unknown, nativeAgentId?: string) => {
    const output = object(result);
    const agent = source.client === "codex" && /(?:^|\.)spawn_agent$/.test(tool ?? "") ? string(output.agent_id)
      : /^(?:Task|Agent)$/.test(tool ?? "") ? nativeAgentId ?? string(output.agentId) : undefined;
    if (!agent) return;
    const childRaw = source.client === "claude" ? `${rawId}/agent/${agent}` : source.client === "codeflicker" ? `agent-${agent}` : agent;
    meta.childSessionIds = [...new Set([...(meta.childSessionIds ?? []), sessionKey(source.client, childRaw)])];
  };
  const finishTurn = () => {
    if (candidate && !candidate.final && !pending.size && !interrupted) sink.message({ ...candidate, final: "inferred" });
    candidate = undefined;
    interrupted = false;
  };
  const message = (key: string, kind: MessageKind, body: string, row: number, extra: Partial<SessionMessage> = {}, newTurn = false): SessionMessage => {
    let identity = seen.get(key);
    if (!identity) {
      if (newTurn) { finishTurn(); meta.turnCount += 1; turnId = `${id}:turn:${meta.turnCount}`; }
      identity = { ordinal: ++meta.messageCount, turnId };
      seen.set(key, identity);
    }
    const value: SessionMessage = { id: `${id}:message:${digest(key)}`, sessionId: id, ordinal: identity.ordinal,
      recordLine: row, turnId: identity.turnId, kind, text: body, ...extra };
    if (value.model) models.add(value.model);
    if (kind === "user" && !value.copied && !firstUserTitle) {
      firstUserTitle = (source.client === "codex" ? userTitle(body) : body.replace(/\s+/g, " ").trim().slice(0, 120)) || undefined;
      if (firstUserTitle && meta.titleOrigin === "fallback") { meta.title = firstUserTitle; meta.titleOrigin = "first_user"; }
    }
    sink.message(value);
    timing?.message(value);
    if (kind === "compression" && !value.copied) usage.compression();
    if (kind === "assistant") candidate = value;
    if (kind === "tool_call") candidate = undefined;
    return value;
  };
  const toolCall = (key: string, tool: string, input: unknown, callId: string, row: number, extra: Partial<SessionMessage>) => {
    const paths = filePaths(input);
    if (!meta.project) for (const path of paths ?? []) {
      if (!isAbsolute(path)) continue;
      const directory = dirname(path);
      if (!targets.has(directory) && targets.size >= 512) { targetsLimited = true; continue; }
      const samples = targets.get(directory) ?? new Set<string>();
      if (samples.size < 4) samples.add(path);
      targets.set(directory, samples);
    }
    const detectedResource = callResource(tool, input, meta.project ?? source.cwd);
    const value = message(key, "tool_call", display(input), row, { ...extra, callId, tool, filePaths: paths,
      resource: detectedResource, status: "unknown" });
    const previousCompletion = completed.get(value.id);
    if (previousCompletion) { sink.message({ ...value, ...previousCompletion }); return value; }
    const previous = pending.get(callId);
    if (previous?.message.id === value.id) { pendingBytes -= previous.bytes; pending.delete(callId); }
    else if (previous) { gap("ambiguous", "同一调用身份存在多个未完成请求，结果未强行配对", { key: "diagnostics.sessions.parser.m004" }); pendingBytes -= previous.bytes; pending.delete(callId); return value; }
    const bytes = Buffer.byteLength(value.text);
    if (pendingBytes + bytes > MAX_PENDING_BYTES || pending.size >= 1024) { gap("budget_exceeded", "未完成工具请求超过有界配对缓存，调用保持未知状态", { key: "diagnostics.sessions.parser.m005" }); return value; }
    pending.set(callId, { message: value, bytes, input }); pendingBytes += bytes;
    return value;
  };
  const toolResult = (key: string, callId: string, body: string, row: number, status: SessionMessage["status"], extra: Partial<SessionMessage>, nativeResult?: unknown) => {
    const repeated = seen.has(key);
    const call = pending.get(callId);
    const value = message(key, "tool_result", body, row, { ...extra, callId, status, tool: extra.tool ?? call?.message.tool,
      filePaths: extra.filePaths ?? call?.message.filePaths });
    if (call) {
      const read = status === "success" ? successfulSkillRead(call.message.tool ?? "", call.input, nativeResult,
        shellResult(body).output, meta.project ?? source.cwd, adapter?.extract) : undefined;
      const paths = [...new Set([...(call.message.filePaths ?? []), ...(read?.paths ?? [])])];
      const completion = { status, filePaths: paths.length ? paths : undefined,
        resource: call.message.resource ?? read?.resource, durationMs: extra.durationMs ?? call.message.durationMs };
      sink.message({ ...call.message, ...completion });
      completed.set(call.message.id, completion);
      pendingBytes -= call.bytes; pending.delete(callId);
    } else if (!repeated) gap("unpaired_call", "工具结果缺少可唯一配对的请求，已保留原结果", { key: "diagnostics.sessions.parser.m006" });
    return value;
  };
  for await (const { record, line } of inputRecords(gap)) {
    currentRecordLine = line;
    const payload = object(record.payload);
    const entrypoint = source.client === "codeflicker" && record.type === "message" ? string(record.entrypoint) : undefined;
    if (entrypoint) {
      const version = string(record.version);
      meta.executionEntries ??= [];
      if (!meta.executionEntries.some(entry => entry.entrypoint === entrypoint && entry.version === version)) {
        meta.executionEntries.push({ entrypoint, version, recordLine: line });
      }
    }
    const inheritedHeader = source.client === "codex" && record.type === "session_meta"
      && (string(payload.id) ?? string(payload.session_id)) !== rawId;
    const occurredAt = source.format === DESKTOP_FORMAT || ideSnapshot ? desktopTimestamp(record) : string(record.timestamp) ?? string(payload.timestamp);
    if (occurredAt) {
      if (!meta.startedAt || occurredAt < meta.startedAt) meta.startedAt = occurredAt;
      if (!meta.updatedAt || occurredAt > meta.updatedAt) meta.updatedAt = occurredAt;
    }
    const project = normalizeHistoryPath(string(record.cwd) ?? string(payload.cwd));
    if (!inheritedHeader && !meta.project && project && isAbsolute(project)) { meta.project = project; meta.projectOrigin = "cwd"; }
    const relations = inheritedHeader ? [] : historyRelationships(record);
    if (relations[0]) {
      const relationship = relations[0];
      meta.parentSessionId = sessionKey(source.client, relationship.parentSessionId);
      meta.relationship = relationship.kind === "fork" ? "fork" : "child";
      copyBeforeOrdinal = relationship.endOrdinalExclusive ?? tokens(payload.subagent_history_start_ordinal);
    }
    if (string(record.agentId) && string(record.sessionId) && !meta.parentSessionId) {
      meta.parentSessionId = sessionKey(source.client, string(record.sessionId)!); meta.relationship = "child";
    }
    const ordinal = tokens(record.ordinal);
    const copied = copyBeforeOrdinal !== undefined && ordinal !== undefined && ordinal < copyBeforeOrdinal ? true : undefined;
    const extra: Partial<SessionMessage> = { occurredAt, copied,
      ...(ideSnapshot && record.textDescriptor ? { textDescriptor: record.textDescriptor as MessageDescriptor } : {}) };
    if (!copied && source.client !== "codex" && (record.interruptedMessageId || record.isApiErrorMessage === true)) {
      timing?.interrupt(string(record.interruptedMessageId));
    }
    const title = string(record.aiTitle) ?? string(record.title) ?? (record.type === "session_meta" ? string(payload.title) : undefined);
    if (title && !inheritedHeader) { meta.title = title; meta.titleOrigin = "recorded"; }
    if (source.format === DESKTOP_FORMAT || ideSnapshot) {
      const key = `desktop:${desktopIdentity(record.id) ?? line}`;
      const native = options.desktopModels?.get(string(object(object(record.extra)["claude-code"]).lastEntryUuid) ?? "");
      const model = string(record.model) ?? native?.model;
      extra.model = model;
      // duration 是桌面累计运行时长，不能当作单次工具耗时。
      if (record.op === "turn_terminal") {
        const last = desktopIdentity(record.lastMessageId);
        const matches = (!last || candidate?.id === `${id}:message:${digest(`desktop:${last}`)}`)
          && (!desktopTurn || record.turnId === desktopTurn);
        if (record.outcome === "completed" && candidate && !pending.size && matches) {
          candidate = { ...candidate, final: "explicit" };
          sink.message(candidate);
        }
        else interrupted = true;
        if (!matches) gap("ambiguous", "桌面终态引用与当前助手消息不符，未认定最终回答", { key: "diagnostics.sessions.parser.m007" });
        finishTurn();
        continue;
      }
      if (record.kind !== "message" && !record.role) { gap("unsupported_format", "桌面历史存在尚未适配的记录类型", { key: "diagnostics.sessions.parser.m008" }); continue; }
      const role = string(record.role);
      const nativeTurn = string(record.turnId) ?? string(object(record.extra).turnId);
      let emitted: SessionMessage | undefined;
      if (role === "user") {
        const newTurn = nativeTurn === undefined || nativeTurn !== desktopTurn;
        if (newTurn) desktopTurn = nativeTurn;
        emitted = message(key, record.isSilence === true ? "system" : "user", text(record.content), line, extra, newTurn);
      } else if (role === "assistant") {
        if (text(record.content)) emitted = message(key, "assistant", text(record.content), line, extra);
        const calls = desktopCalls(record);
        for (const call of calls) toolCall(`${key}:call:${call.id}`, call.name, call.input, call.id, line, extra);
        const recorded = object(record.usage);
        const normalized = { input_tokens: recorded.inputTokens, output_tokens: recorded.outputTokens,
          cache_read_input_tokens: recorded.cacheReadInputTokens, cache_creation_input_tokens: recorded.cacheCreationInputTokens,
          reasoning_output_tokens: recorded.reasoningOutputTokens ?? recorded.reasoningTokens };
        const backend = string(object(object(record.extra).backend).type);
        if (Object.keys(recorded).length) {
          const nonCached = ["CLAUDE_CODE", "DEEPSEEK_HARNESS"].includes(backend ?? "");
          if (!nonCached && !["MY_FLICKER", "CODEX"].includes(backend ?? "")) {
            normalized.input_tokens = undefined;
            gap("unsupported_format", "桌面用量缺少已确认的执行后端，未计算总输入与缓存比例", { key: "diagnostics.sessions.parser.m009" });
          }
          usage.native(nonCached ? "claude" : "codeflicker", normalized, native?.requestId ?? string(record.messageId) ?? key,
            { messageId: emitted?.id ?? (calls[0] ? `${id}:message:${digest(`${key}:call:${calls[0].id}`)}` : undefined), turnId, model, occurredAt });
        }
      } else if (role === "tool") {
        const result = desktopResult(record);
        const callId = string(record.toolCallId);
        if (callId) toolResult(key, callId, text(record.content), line, result.status, { ...extra, tool: string(object(record.extra).toolName) }, result.result);
        else { gap("unpaired_call", "桌面工具结果缺少调用身份", { key: "diagnostics.sessions.parser.m010" }); message(key, "tool_result", text(record.content), line, extra); }
      } else if (role === "reasoning") message(key, "thinking", text(record.content), line, extra);
      else if (role === "system") message(key, "system", text(record.content), line, extra);
      else if (role === "activity") {
        const compaction = object(object(record.extra).compaction);
        const body = [text(record.content), text(compaction.summary)].filter(Boolean).join("\n\n");
        message(key, Object.keys(compaction).length ? "compression" : "system", body || display(record.extra), line, extra);
      }
      else gap("unsupported_format", "桌面历史存在尚未适配的消息角色", { key: "diagnostics.sessions.parser.m011" });
      continue;
    }
    if (source.client === "codex") {
      const passthrough = object(payload.internal_chat_message_metadata_passthrough);
      if (record.type === "session_meta") {
        const spawn = object(object(object(payload.source).subagent).thread_spawn);
        const agentPath = string(payload.agent_path) ?? string(spawn.agent_path);
        if (!inheritedHeader) {
          meta.taskName = agentPath?.split("/").filter(Boolean).at(-1);
          meta.agentName = string(payload.agent_nickname) ?? string(spawn.agent_nickname);
        }
        const instructions = text(object(payload.base_instructions).text ?? payload.base_instructions);
        if (instructions) message("base-instructions", "system", instructions, line, extra);
        continue;
      }
      if (record.type === "turn_context") {
        currentModel = string(payload.model) ?? currentModel; if (currentModel) models.add(currentModel);
        if (!copied) timing?.context({ occurredAt, recordLine: line });
        continue;
      }
      if (record.type === "token_usage_record") {
        if (!copied) {
          const usageId = usage.codex(payload.usage, payload.thread_token_usage, string(payload.response_id), { turnId, model: currentModel, occurredAt });
          timing?.codexUsage(usageId, { occurredAt, recordLine: line, messageId: usageId ? usageMarkers.get(usageId)?.id : undefined });
        }
        continue;
      }
      if (["compacted", "compaction"].includes(string(record.type) ?? "")) {
        message(`compression:${line}`, "compression", text(payload.message ?? payload.summary), line, extra); continue;
      }
      if (record.type === "event_msg") {
        if (payload.type === "token_count") {
          const info = object(payload.info);
          if (!copied) {
            const usageId = usage.codex({ ...object(info.last_token_usage), context_tokens: object(info.last_token_usage).context_tokens ?? object(info.last_token_usage).total_tokens },
              info.total_token_usage, undefined, { turnId, model: currentModel, occurredAt });
            timing?.codexUsage(usageId, { occurredAt, recordLine: line, messageId: usageId ? usageMarkers.get(usageId)?.id : undefined });
          }
        } else if (payload.type === "agent_reasoning") {
          const key = `event:${string(payload.id) ?? line}`;
          const body = text(payload.message ?? payload.text);
          message(key, "thinking", body, line, { ...extra, model: currentModel });
          projectedReasoning = { key, text: body, turnId };
        } else if (!hasResponseTranscript && ["user_message", "agent_message"].includes(string(payload.type) ?? "")) {
          const body = text(payload.message ?? payload.text);
          const context = payload.type === "user_message" ? codexContext(body, passthrough.content_item_kinds) : undefined;
          const kind = payload.type === "user_message" ? context ? "context" : "user" : "assistant";
          message(`event:${string(payload.id) ?? line}`, kind, body, line, { ...extra, ...context, model: kind === "user" ? undefined : currentModel }, kind === "user");
        } else if (["task_aborted", "turn_aborted", "error"].includes(string(payload.type) ?? "")) {
          if (!copied) timing?.interrupt();
          interrupted = true; message(`event:${line}`, "system", display(payload), line, extra);
        } else if (payload.type === "item_completed") {
          const item = object(payload.item);
          if (["CommandExecution", "FileChange"].includes(string(item.type) ?? "")) {
            const callId = string(item.id) ?? `item:${line}`;
            const command = Array.isArray(item.command) ? item.command.at(-1) : item.command;
            const matching = [...pending.entries()].find(([, call]) => ["exec_command", "shell_command", "functions.exec_command", "functions.shell_command"].includes(call.message.tool ?? "")
              && (object(call.input).cmd ?? object(call.input).command) === command);
            const status = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) ? "failure"
              : item.status === "completed" && (item.type === "FileChange" || item.exit_code === 0) ? "success" : "unknown";
            if (!matching) toolCall(`item:${callId}:call`, string(item.type)!, item.command ?? item.changes, callId, line, { ...extra, model: currentModel });
            const duration = typeof payload.started_at_ms === "number" && typeof payload.completed_at_ms === "number" && payload.completed_at_ms >= payload.started_at_ms ? payload.completed_at_ms - payload.started_at_ms : undefined;
            toolResult(`item:${callId}:result`, matching?.[0] ?? callId, display(item.formatted_output ?? item.changes), line, status, { ...extra, durationMs: duration });
          }
        }
        continue;
      }
      if (record.type !== "response_item") continue;
      const type = string(payload.type);
      const key = string(payload.id) ? `response:${payload.id}` : `response:${line}`;
      extra.model = string(payload.model) ?? currentModel;
      if (type === "message" || type === "agent_message") {
        const role = type === "agent_message" ? "assistant" : string(payload.role);
        const body = text(payload.content);
        const context = role === "user" ? codexContext(body, passthrough.content_item_kinds) : undefined;
        const kind: MessageKind = role === "user" ? context ? "context" : "user" : role === "assistant" ? "assistant" : "system";
        const phase = string(payload.phase) ?? string(payload.channel) ?? string(passthrough.channel);
        message(key, kind, body, line, { ...extra, ...context, final: kind === "assistant" && ["final", "final_answer"].includes(phase ?? "") ? "explicit" : undefined }, kind === "user");
      } else if (type === "reasoning") {
        const body = text(payload.summary) || text(payload.content);
        if (!body && payload.encrypted_content && projectedReasoning?.turnId !== turnId) gap("unsupported_format", "思考正文仅有加密内容，未解密或补造", { key: "diagnostics.sessions.parser.m012" });
        if (body) message(projectedReasoning?.turnId === turnId && projectedReasoning.text === body ? projectedReasoning.key : key, "thinking", body, line, extra);
        else if (projectedReasoning?.turnId !== turnId) message(key, "thinking", "", line, extra);
        projectedReasoning = undefined;
      } else if (type === "function_call" || type === "custom_tool_call") {
        let input: unknown = payload.input;
        if (typeof payload.arguments === "string") { try { input = JSON.parse(payload.arguments); } catch { input = payload.arguments; } }
        const name = string(payload.name) ?? "unknown";
        const namespace = string(payload.namespace);
        toolCall(key, namespace ? `${namespace}.${name}` : name, input, string(payload.call_id) ?? key, line, extra);
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        let output: unknown = payload.output;
        if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* 文本输出按已记录内容展示。 */ } }
        const result = object(output);
        const state = shellResult(output);
        const status = result.is_error === true || result.success === false ? "failure" : result.success === true ? "success" : state.status;
        if (!copied && status !== "failure") childReference(pending.get(string(payload.call_id) ?? key)?.message.tool, output);
        toolResult(key, string(payload.call_id) ?? key, display(payload.output), line, status, { ...extra,
          durationMs: tokens(result.duration_ms) ?? tokens(result.durationMs) ?? (typeof result.wall_time_seconds === "number" ? result.wall_time_seconds * 1000 : undefined) }, output);
      } else if (type === "compaction") {
        message(key, "compression", text(payload.content ?? payload.summary), line, extra);
        if (payload.encrypted_content) gap("unsupported_format", "压缩记录未保存可读正文", { key: "diagnostics.sessions.parser.m013" });
      }
      continue;
    }
    const native = source.client === "claude" ? object(record.message) : record;
    const role = string(native.role) ?? string(record.role) ?? string(record.type);
    const nativeId = string(record.uuid) ?? string(native.id) ?? `row:${line}`;
    const model = string(native.model);
    const recordedModel = model && model !== "<synthetic>" && !(source.client === "codeflicker" && role === "attachment") ? model : undefined;
    if (recordedModel) models.add(recordedModel);
    extra.model = recordedModel;
    if (record.type === "system" || record.type === "summary") {
      const compression = record.subtype === "compact_boundary" || record.type === "summary";
      message(`native:${nativeId}`, compression ? "compression" : "system", text(record.content ?? record.summary ?? native.content), line, extra); continue;
    }
    if (source.client === "codeflicker" && record.type === "message" && record.isCompactSummary === true) {
      message(`native:${nativeId}`, "compression", text(native.content), line, extra); continue;
    }
    if (source.client === "codeflicker" && record.type !== "message") continue;
    const content = native.content;
    if (source.client === "codeflicker" && role === "attachment") {
      const attachment = object(content);
      const type = string(attachment.type) ?? "未记录类型";
      const hook = ["hook_success", "hook_blocking_error", "hook_error_during_execution", "hook_cancelled", "hook_non_blocking_error", "hook_stopped_continuation"].includes(type);
      if (!hook) gap("unsupported_format", "CodeFlicker 附件类型尚未适配，已保留原始过程记录", { key: "diagnostics.sessions.parser.m014" });
      message(`native:${nativeId}:attachment`, "context", `${hook ? "本地 Hook" : "附件过程记录"}\n${display(content ?? record)}`, line,
        { ...extra, contextSource: hook ? "hook" : undefined,
          textDescriptor: { key: hook ? "sessions.body.hook" : "sessions.body.attachment" },
          status: !hook ? undefined : type === "hook_success" ? "success" : ["hook_blocking_error", "hook_error_during_execution", "hook_non_blocking_error"].includes(type) ? "failure" : "unknown",
          durationMs: hook ? tokens(attachment.durationMs) : undefined });
      continue;
    }
    const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
    let firstMessage: SessionMessage | undefined;
    const hasResult = blocks.some(value => ["tool_result", "tool-result"].includes(string(object(value).type) ?? ""));
    const injected = source.client === "codeflicker" && role === "user" && (record.hidden === true || record.isMeta === true);
    const human = role === "user" && !hasResult && record.isMeta !== true && !injected;
    const requestId = source.client === "codeflicker" ? string(object(object(record.metadata).requestTokenBaseline).requestId) ?? nativeId : string(native.id) ?? nativeId;
    const identified = Boolean(recordedModel) && (source.client === "claude" ? Boolean(string(native.id))
      : Boolean(string(object(object(record.metadata).requestTokenBaseline).requestId)));
    if (role === "assistant" && native.model === "<synthetic>") timing?.ignoreNative();
    if (role === "assistant" && !copied && native.model !== "<synthetic>") timing?.nativeRequest(requestId, nativeId, identified);
    for (const [index, value] of blocks.entries()) {
      const block = object(value);
      const key = `native:${nativeId}:${index}`;
      const type = string(block.type);
      let emitted: SessionMessage | undefined;
      if (type === "text") {
        const kind: MessageKind = human ? "user" : injected ? "context" : role === "assistant" ? "assistant" : "system";
        emitted = message(key, kind, text(block.text), line, { ...extra, ...(injected ? { contextSource: "client" as const, contextEvidence: "client_metadata" as const } : {}), final: kind === "assistant" && ["end_turn", "stop_sequence"].includes(string(native.stop_reason) ?? "") ? "explicit" : undefined }, human && !firstMessage);
      } else if (["thinking", "reasoning", "redacted_thinking"].includes(type ?? "")) {
        emitted = message(key, "thinking", text(block.text ?? block.thinking), line, extra);
        if (type === "redacted_thinking") gap("unsupported_format", "思考正文已由客户端隐藏，未补造内容", { key: "diagnostics.sessions.parser.m015" });
      } else if (type === "tool_use" && role === "assistant") {
        const callId = string(block.id) ?? key;
        emitted = toolCall(key, string(block.name) ?? "unknown", block.input, callId, line, extra);
      } else if (type === "tool_result" || type === "tool-result") {
        const result = object(type === "tool-result" ? block.result : blocks.filter(value => object(value).type === "tool_result").length === 1 ? record.toolUseResult : undefined);
        const body = type === "tool-result" ? text(result.llmContent) : text(block.content);
        const error = type === "tool-result" ? result.isError : block.is_error;
        const status = error === true ? "failure" : error === false ? "success" : typeof result.exitCode === "number" ? result.exitCode === 0 ? "success" : "failure"
          : result.file || Array.isArray(result.structuredPatch) || ["create", "update"].includes(string(result.type) ?? "") ? "success"
          : type === "tool-result" && /^(?:File successfully written to |File .+ successfully edited\.)/.test(body) ? "success"
          : type === "tool-result" && object((() => { try { return JSON.parse(body); } catch { return {}; } })()).type === "text" ? "success" : "unknown";
        if (!copied && status !== "failure") childReference(pending.get(string(block.tool_use_id) ?? string(block.toolCallId) ?? key)?.message.tool, result, string(block.agentId));
        emitted = toolResult(key, string(block.tool_use_id) ?? string(block.toolCallId) ?? key, body, line,
          result.interrupted === true || result.backgroundTaskId || result.timedOutAfterMs ? "unknown" : status,
          { ...extra, tool: string(block.toolName), durationMs: tokens(result.durationMs) ?? tokens(object(record.metadata).durationMs) }, result);
      } else if (type === "image" || type === "input_image") emitted = message(key, human ? "user" : "system", "[图片]", line, { ...extra, textDescriptor: { key: "sessions.body.image" } }, human && !firstMessage);
      else if (type) gap("unsupported_format", "历史存在尚未适配的消息内容块，未补造正文", { key: "diagnostics.sessions.parser.m016" });
      firstMessage ??= emitted;
    }
    if (!blocks.length && typeof record.text === "string") firstMessage = message(`native:${nativeId}:text`, role === "assistant" ? "assistant" : human ? "user" : "system", record.text, line, extra, human);
    if (role === "assistant") {
      if (!copied) {
        const partial = record.isApiErrorMessage === true || record.isInterrupted === true || Boolean(record.interruptedMessageId);
        const persisted = source.client === "codeflicker" && record.type === "message" && Boolean(string(record.uuid)) && identified
          && Object.keys(object(native.usage)).length > 0 && !partial;
        const usageId = usage.native(source.client === "claude" ? "claude" : "codeflicker", native.usage, requestId,
          { messageId: firstMessage?.id, turnId, model: recordedModel, occurredAt }, identified);
        timing?.nativeUsage(usageId, string(native.stop_reason), persisted, partial, { occurredAt, recordLine: line, messageId: firstMessage?.id });
      }
    }
    if (record.interruptedMessageId || record.isApiErrorMessage === true) interrupted = true;
  }
  timing?.finish();
  finishTurn();
  if (ideSnapshot) gap("unsupported_format", "IDE 主历史未保存逐请求 Token 用量，累计缓存不能重建请求趋势；未补造记录值", { key: "diagnostics.sessions.parser.m017" });
  if (pending.size) gap("unpaired_call", "历史结束时仍有工具调用未记录完成结果", { key: "diagnostics.sessions.parser.m018" });
  if (meta.relationship === "fork" && copyBeforeOrdinal === undefined) gap("ambiguous", "分叉来源缺少共享历史边界，未猜测或排除复制消息", { key: "diagnostics.sessions.parser.m019" });
  if (source.client === "codeflicker" && basename(source.path).startsWith("agent-") && !meta.parentSessionId) gap("ambiguous", "子会话来源缺少明确父关系，作为独立会话保留", { key: "diagnostics.sessions.parser.m020" });
  if (!meta.project && options.projectMetadata?.project && isAbsolute(options.projectMetadata.project)) {
    meta.project = options.projectMetadata.project;
    meta.projectOrigin = "client_metadata";
  }
  if (!meta.project && options.projectMetadata?.ambiguous) gap("ambiguous", "客户端项目元数据对应多个完整路径，未选择单一项目归属", { key: "diagnostics.sessions.parser.m021" });
  if (!meta.project && !options.projectMetadata?.ambiguous && targets.size && !targetsLimited) {
    const association = await projectFromToolPaths([...targets.values()].flatMap(paths => [...paths]));
    if (association.project) { meta.project = association.project; meta.projectOrigin = "tool_path"; }
    if (association.ambiguous) gap("ambiguous", "工具目标对应多个 Git 项目，未选择单一项目归属", { key: "diagnostics.sessions.parser.m022" });
    if (association.limited) gap("budget_exceeded", "工具目标目录超过项目关联检查上限，未推断项目归属", { key: "diagnostics.sessions.parser.m023" });
  }
  if (!meta.project && targetsLimited) gap("budget_exceeded", "工具目标目录超过项目关联检查上限，未推断项目归属", { key: "diagnostics.sessions.parser.m023" });
  meta.models = [...models];
  meta.executionMode = sessionExecutionMode(meta.client, meta.executionEntries);
  meta.gaps = [...gaps.values()].map(item => ({ ...item, sourceId: meta.sourceId }));
  if (options.title !== undefined) {
    meta.title = options.title || firstUserTitle || "未命名会话";
    meta.titleOrigin = options.title ? "recorded" : firstUserTitle ? "first_user" : "fallback";
  }
  return sessionTitle(meta);
}
