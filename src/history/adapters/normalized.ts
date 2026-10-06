import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { Gap, HistoryEvent } from "../../contracts.js";
import type { MessageKind, SessionMessage, SessionSink, SessionSourceMeta, SessionUsage } from "../../session-contracts.js";
import type { HistoryRelationship, SourceLocation } from "../types.js";
import { object, string } from "../extraction.js";
import { defaultToolEvidence, registerRequest } from "./common.js";
import type { HistoryAdapter, HistoryRecordSnapshot } from "./types.js";

export const normalizedHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const normalizedSessionKey = (client: SourceLocation["client"], id: string): string => `${client}:${normalizedHash(id).slice(0, 24)}`;

export interface NormalizedEvent {
  key: string;
  kind: MessageKind;
  text?: string;
  occurredAt?: string;
  model?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  status?: HistoryEvent["status"];
  final?: "explicit" | "inferred";
  /** 原生状态不足以确认终答时，禁止共享管道从最后一条 assistant 消息推断 final。 */
  allowInferredFinal?: boolean;
  interrupted?: boolean;
  durationMs?: number;
  /** 用原生请求身份去重；inputTokens 为包含缓存的归一化总输入。 */
  usageKey?: string;
  usageMessageKey?: string;
  usage?: Omit<SessionUsage, "id" | "messageId" | "turnId" | "occurredAt" | "model">;
  turnKey?: string;
  branchIds?: string[];
  currentBranch?: boolean;
  copied?: boolean;
  filePaths?: string[];
  resource?: SessionMessage["resource"];
  nativeOrdinal?: number;
  nativeIdentityHash?: string;
}

export interface NormalizedSessionMetadata {
  title?: string;
  titleOrigin?: SessionSourceMeta["titleOrigin"];
  relationship?: "child" | "fork";
  parentSessionId?: string;
  childSessionIds?: string[];
  relationships?: HistoryRelationship[];
  branches?: SessionSourceMeta["branches"];
  gaps?: Gap[];
}
export interface NormalizedSnapshot extends HistoryRecordSnapshot { meta: NormalizedSessionMetadata }
export type RawHistoryRecord = { record: Record<string, unknown>; raw: string; line: number };

/** 逐块读取，限制单条及单来源体积，坏行和未完成尾行显式保留缺口。 */
export async function readBoundedJsonl(path: string, gaps: Gap[], stream: AsyncIterable<Uint8Array> = createReadStream(path), limit = 128 * 1024 * 1024): Promise<RawHistoryRecord[]> {
  const rows: RawHistoryRecord[] = [];
  let parts: Buffer[] = []; let length = 0; let total = 0; let line = 0; let oversized = false;
  for await (const value of stream) {
    const bytes = Buffer.from(value); total += bytes.length;
    if (total > limit) { gaps.push({ kind: "budget_exceeded", message: "原生来源超过 128 MiB 有界读取上限" }); break; }
    let start = 0;
    while (start < bytes.length) {
      const next = bytes.indexOf(10, start); const end = next < 0 ? bytes.length : next;
      length += end - start;
      if (length <= 16 * 1024 * 1024 && !oversized) parts.push(bytes.subarray(start, end));
      else { oversized = true; parts = []; }
      if (next < 0) break;
      line += 1;
      if (oversized) gaps.push({ kind: "budget_exceeded", message: "原生单条记录超过 16 MiB，未解析正文" });
      else if (length) {
        const raw = Buffer.concat(parts, length).toString("utf8");
        try { rows.push({ raw, line, record: object(JSON.parse(raw)) }); }
        catch { gaps.push({ kind: "parse_error", message: "原生来源存在无效 JSON 记录" }); }
      }
      parts = []; length = 0; oversized = false; start = next + 1;
    }
  }
  if (length || oversized) gaps.push({ kind: "incomplete_record", message: "原生来源末行尚未完整写入" });
  return rows;
}

export function normalizedRecord(event: NormalizedEvent, raw: string, line: number, nativeOrdinal?: number): RawHistoryRecord {
  return { record: { normalizedEvent: nativeOrdinal === undefined ? event : { ...event, nativeOrdinal } }, raw, line };
}

export function normalizedSnapshot(source: SourceLocation, records: RawHistoryRecord[], meta: NormalizedSessionMetadata = {}, fingerprint?: string): NormalizedSnapshot {
  const digest = createHash("sha256").update(JSON.stringify([fingerprint, source.sessionId, source.cwd, meta]));
  for (const row of records) digest.update(JSON.stringify([row.line, row.raw, row.record]));
  const hash = digest.digest("hex");
  return { source, hash, meta, records: [{ record: { normalizedMeta: meta }, raw: "", line: 0 }, ...records] };
}

export function createNormalizedAdapter(config: {
  id: string;
  readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot>;
  discoverFile?(location: SourceLocation): Promise<SourceLocation[]>;
  selectSources?(locations: SourceLocation[]): SourceLocation[];
  extract?: HistoryAdapter["extract"];
}): HistoryAdapter {
  return {
    id: config.id, normalized: true,
    discover: () => undefined,
    discoverFile: config.discoverFile ?? (async location => [(await config.readSnapshot(location)).source]),
    selectSources: config.selectSources,
    readRecords: config.readSnapshot,
    extract: config.extract ?? defaultToolEvidence,
    async readEvidence(reference) {
      if (!Number.isSafeInteger(reference.recordLine) || reference.recordLine < 1) return undefined;
      try {
        const canonical = await realpath(reference.path);
        const stat = await lstat(reference.path);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
        const snapshot = await config.readSnapshot({ path: reference.path, client: reference.sourceId.split(":")[0] as SourceLocation["client"], format: config.id, selector: reference.selector });
        const row = snapshot.records.find(row => row.line === reference.recordLine && normalizedHash(row.raw) === reference.hash);
        return row && await realpath(reference.path) === canonical ? { source: reference, raw: row.raw } : undefined;
      } catch { return undefined; }
    },
    processRecord(record, context) {
      if (record.normalizedMeta) {
        const meta = record.normalizedMeta as NormalizedSessionMetadata;
        context.cursor.relationships = meta.relationships ?? (meta.parentSessionId && meta.relationship ? [{ kind: meta.relationship === "child" ? "subagent" : "fork", parentSessionId: meta.parentSessionId }] : []);
        context.source.relationships = context.cursor.relationships;
        context.source.gaps.push(...(meta.gaps ?? []).map(gap => ({ ...gap, sourceId: context.source.sourceId })));
        return;
      }
      const event = record.normalizedEvent as NormalizedEvent | undefined;
      if (!event || event.copied) return;
      context.occurredAt = event.occurredAt;
      context.nativeOrdinal = event.nativeOrdinal;
      context.nativeIdentityHash = event.nativeIdentityHash;
      if (event.kind === "tool_call") {
        registerRequest(context, { key: event.key, callId: event.callId ?? event.key, tool: event.tool ?? "unknown", input: event.input, cwd: context.source.cwd });
      } else if (event.kind === "tool_result") {
        if (context.cursor.seen[event.key]) return;
        const call = context.pair(event.callId ?? "");
        if (!call) return;
        context.finish(call, event.result, event.text ?? "", event.status ?? "unknown", context.row, context.raw);
        context.cursor.seen[event.key] = call.eventId;
      }
    },
  };
}

function resourceOf(tool: string | undefined, input: unknown, paths?: string[]): SessionMessage["resource"] {
  if (!tool) return undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool) ?? /^mcp__([^.]+)\.(.+)$/.exec(tool);
  if (mcp) return { kind: "mcp", name: mcp[2]!, server: mcp[1] };
  if (/^(?:Skill|skill|use_skill)$/.test(tool)) return { kind: "skill_call", name: string(object(input).skill) ?? string(object(input).name) ?? "未记录名称" };
  const skill = paths?.find(path => basename(path) === "SKILL.md");
  return /^(?:Read|read|read_file)$/.test(tool) && skill ? { kind: "skill_read", name: skill.split(/[/\\]/).at(-2) ?? "SKILL.md" } : undefined;
}

/** 规范化事件只在这里形成会话消息，所有新适配器共享轮次、工具状态和资源口径。 */
export function parseNormalizedSession(snapshot: NormalizedSnapshot, sink: SessionSink): SessionSourceMeta {
  const source = snapshot.source; const rawId = source.sessionId ?? `unknown:${normalizedHash(source.path).slice(0, 24)}`;
  const id = normalizedSessionKey(source.client, rawId); const native = snapshot.meta;
  const meta: SessionSourceMeta = { id, client: source.client, clientSessionId: rawId, path: source.path,
    sourceId: source.sourceId ?? `${source.client}:${normalizedHash(rawId).slice(0, 24)}`,
    title: native.title ?? "未命名会话", titleOrigin: native.title ? native.titleOrigin ?? "recorded" : "fallback",
    project: source.cwd && isAbsolute(source.cwd) ? source.cwd : undefined, projectOrigin: source.cwd && isAbsolute(source.cwd) ? "client_metadata" : undefined,
    parentSessionId: native.parentSessionId ? normalizedSessionKey(source.client, native.parentSessionId) : undefined,
    relationship: native.relationship, branches: native.branches, childSessionIds: native.childSessionIds?.map(child => normalizedSessionKey(source.client, child)),
    messageCount: 0, turnCount: 0, models: [], gaps: [...(native.gaps ?? [])] };
  const messages = new Map<string, number>(); const pending = new Map<string, SessionMessage[]>(); const inputs = new Map<string, unknown>();
  const candidates = new Map<string, { message: SessionMessage; allowInferredFinal: boolean }>(); const interrupted = new Set<string>();
  const turns = new Map<string, string>(); const models = new Set<string>(); let turn = `${id}:turn:0`;
  const messageIds = new Map<string, string>();
  for (const row of snapshot.records) {
    const event = row.record.normalizedEvent as NormalizedEvent | undefined;
    if (!event) continue;
    if (event.kind === "user") {
      const key = event.turnKey ?? event.key;
      if (!turns.has(key)) turns.set(key, `${id}:turn:${++meta.turnCount}`);
      turn = turns.get(key)!;
    } else if (event.turnKey && turns.has(event.turnKey)) turn = turns.get(event.turnKey)!;
    const previous = messages.get(event.key);
    const paths = event.filePaths ?? [object(event.input).file_path, object(event.input).filePath, object(event.input).path].filter((item): item is string => typeof item === "string");
    const value: SessionMessage = { id: `${id}:message:${normalizedHash(event.key).slice(0, 24)}`, sessionId: id,
      ordinal: previous ?? ++meta.messageCount, recordLine: row.line, turnId: turn, kind: event.kind,
      text: event.text ?? (event.input === undefined ? "" : JSON.stringify(event.input, null, 2)), occurredAt: event.occurredAt, model: event.model,
      callId: event.callId, tool: event.tool, status: event.status, final: event.final, durationMs: event.durationMs,
      copied: event.copied, branchIds: event.branchIds, currentBranch: event.currentBranch,
      filePaths: paths.length ? paths : undefined, resource: event.resource ?? resourceOf(event.tool, event.input, paths) };
    if (value.resource?.kind === "skill_read") value.resource = undefined;
    messages.set(event.key, value.ordinal);
    messageIds.set(event.key, value.id);
    if (event.model) models.add(event.model);
    if (event.occurredAt) { meta.startedAt = !meta.startedAt || event.occurredAt < meta.startedAt ? event.occurredAt : meta.startedAt; meta.updatedAt = !meta.updatedAt || event.occurredAt > meta.updatedAt ? event.occurredAt : meta.updatedAt; }
    if (event.kind === "user" && !event.copied && meta.titleOrigin === "fallback" && event.text?.trim()) { meta.title = event.text.trim().replace(/\s+/g, " ").slice(0, 120); meta.titleOrigin = "first_user"; }
    if (event.interrupted) interrupted.add(turn);
    if (event.kind === "assistant") {
      if (!event.interrupted) interrupted.delete(turn);
      candidates.set(turn, { message: value, allowInferredFinal: event.allowInferredFinal !== false });
    }
    if (event.kind === "tool_call") {
      candidates.delete(turn);
      const key = event.callId ?? event.key;
      const calls = pending.get(key) ?? [];
      const existing = calls.findIndex(call => call.id === value.id);
      if (existing < 0) calls.push(value); else calls[existing] = value;
      pending.set(key, calls); inputs.set(value.id, event.input);
    }
    if (event.kind === "tool_result") {
      candidates.delete(turn);
      const calls = pending.get(event.callId ?? "") ?? [];
      const call = calls.length === 1 ? calls[0] : undefined;
      value.tool ??= call?.tool;
      if (call) {
        call.status = event.status ?? "unknown"; call.durationMs = event.durationMs ?? call.durationMs;
        if (call.status === "success") call.resource = event.resource ?? resourceOf(call.tool, inputs.get(call.id), call.filePaths);
        sink.message(call); pending.delete(event.callId ?? ""); inputs.delete(call.id);
      } else meta.gaps.push({ kind: calls.length > 1 ? "ambiguous" : "unpaired_call", message: calls.length > 1 ? "原生调用身份同时对应多个请求，未猜测结果关联" : "原生工具结果缺少可配对请求", sourceId: meta.sourceId });
    }
    sink.message(value);
    if (event.usage) sink.usage({ ...event.usage, id: `${id}:usage:${normalizedHash(event.usageKey ?? event.key).slice(0, 24)}`,
      messageId: messageIds.get(event.usageMessageKey ?? event.key) ?? value.id,
      turnId: event.turnKey && turns.has(event.turnKey) ? turns.get(event.turnKey) : value.turnId,
      model: event.model, occurredAt: event.occurredAt });
  }
  const pendingCalls = [...pending.values()].flat();
  const pendingTurns = new Set(pendingCalls.map(value => value.turnId));
  for (const [key, candidate] of candidates) if (candidate.allowInferredFinal && !candidate.message.final
    && !pendingTurns.has(key) && !interrupted.has(key)) sink.message({ ...candidate.message, final: "inferred" });
  if (pendingCalls.length) meta.gaps.push({ kind: "unpaired_call", message: "部分原生工具请求尚未记录结果", count: pendingCalls.length, sourceId: meta.sourceId });
  meta.models = [...models];
  return meta;
}
