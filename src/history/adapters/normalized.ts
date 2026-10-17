import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Gap, HistoryEvent } from "../../contracts.js";
import type { MessageKind, SessionMessage, SessionSink, SessionSourceMeta, SessionUsage } from "../../session-contracts.js";
import type { HistoryRelationship, SourceLocation } from "../types.js";
import { object } from "../extraction.js";
import { callResource, successfulSkillRead } from "../../sessions/resources.js";
import { defaultToolEvidence, registerRequest } from "./common.js";
import type { HistoryAdapter, HistoryRecordSnapshot } from "./types.js";

export const normalizedHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const normalizedSessionKey = (client: SourceLocation["client"], id: string): string => `${client}:${normalizedHash(id).slice(0, 24)}`;

export interface NormalizedEvent {
  key: string;
  kind: MessageKind;
  text?: string;
  textDescriptor?: SessionMessage["textDescriptor"];
  occurredAt?: string;
  model?: string;
  reasoningEffort?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  status?: HistoryEvent["status"];
  final?: "explicit" | "inferred";
  finalEvidence?: SessionMessage["finalEvidence"];
  finalAt?: string;
  finishedAt?: string;
  /** 原生状态不足以确认终答时，禁止共享管道从最后一条 assistant 消息推断 final。 */
  allowInferredFinal?: boolean;
  interrupted?: boolean;
  durationMs?: number;
  /** 用原生请求身份去重；inputTokens 为包含缓存的归一化总输入。 */
  usageKey?: string;
  usageMessageKey?: string;
  usage?: Omit<SessionUsage, "id" | "messageId" | "turnId" | "occurredAt" | "model">;
  /** 模型请求身份独立于消息片段与工具调用身份。 */
  requestKey?: string;
  requestTiming?: SessionUsage["timing"];
  /** null 按原始记录分组保留未关联消息，不推定用户轮次；undefined 保留按顺序继承的默认行为。 */
  turnKey?: string | null;
  branchIds?: string[];
  currentBranch?: boolean;
  copied?: boolean;
  filePaths?: string[];
  resource?: SessionMessage["resource"];
  operation?: SessionMessage["operation"];
  nativeOrdinal?: number;
  nativeIdentityHash?: string;
}

export interface NormalizedSessionMetadata {
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  titleOrigin?: SessionSourceMeta["titleOrigin"];
  relationship?: "child" | "fork";
  parentSessionId?: string;
  childSessionIds?: string[];
  relationships?: HistoryRelationship[];
  branches?: SessionSourceMeta["branches"];
  gaps?: Gap[];
  usageReports?: SessionSourceMeta["usageReports"];
  contextSnapshots?: SessionSourceMeta["contextSnapshots"];
}
export interface NormalizedSnapshot extends HistoryRecordSnapshot { meta: NormalizedSessionMetadata }
export type RawHistoryRecord = { record: Record<string, unknown>; raw: string; line: number };

/** 逐块读取，限制单条及单来源体积，坏行和未完成尾行显式保留缺口。 */
export async function readBoundedJsonl(path: string, gaps: Gap[], stream: AsyncIterable<Uint8Array> = createReadStream(path), limit = 128 * 1024 * 1024): Promise<RawHistoryRecord[]> {
  const rows: RawHistoryRecord[] = [];
  let parts: Buffer[] = []; let length = 0; let total = 0; let line = 0; let oversized = false;
  for await (const value of stream) {
    const bytes = Buffer.from(value); total += bytes.length;
    if (total > limit) { gaps.push({ kind: "budget_exceeded", message: "原生来源超过 128 MiB 有界读取上限", messageDescriptor: { key: "diagnostics.history.adapters.normalized.m001" } }); break; }
    let start = 0;
    while (start < bytes.length) {
      const next = bytes.indexOf(10, start); const end = next < 0 ? bytes.length : next;
      length += end - start;
      if (length <= 16 * 1024 * 1024 && !oversized) parts.push(bytes.subarray(start, end));
      else { oversized = true; parts = []; }
      if (next < 0) break;
      line += 1;
      if (oversized) gaps.push({ kind: "budget_exceeded", message: "原生单条记录超过 16 MiB，未解析正文", messageDescriptor: { key: "diagnostics.history.adapters.normalized.m002" } });
      else if (length) {
        const raw = Buffer.concat(parts, length).toString("utf8");
        try { rows.push({ raw, line, record: object(JSON.parse(raw)) }); }
        catch { gaps.push({ kind: "parse_error", message: "原生来源存在无效 JSON 记录", messageDescriptor: { key: "diagnostics.history.adapters.normalized.m003" } }); }
      }
      parts = []; length = 0; oversized = false; start = next + 1;
    }
  }
  if (length || oversized) gaps.push({ kind: "incomplete_record", message: "原生来源末行尚未完整写入", messageDescriptor: { key: "diagnostics.history.adapters.normalized.m004" } });
  return rows;
}

export function normalizedRecord(event: NormalizedEvent, raw: string, line: number, nativeOrdinal?: number): RawHistoryRecord {
  return { record: { normalizedEvent: nativeOrdinal === undefined ? event : { ...event, nativeOrdinal } }, raw, line };
}

export function normalizedSnapshot(source: SourceLocation, records: RawHistoryRecord[], meta: NormalizedSessionMetadata = {}, fingerprint?: string): NormalizedSnapshot {
  const digest = createHash("sha256").update(JSON.stringify([fingerprint, source.sessionId, source.cwd, meta]));
  const rawHashes = new Map<string, string>();
  for (const row of records) {
    let rawHash = rawHashes.get(row.raw);
    if (!rawHash) { rawHash = normalizedHash(row.raw); rawHashes.set(row.raw, rawHash); }
    // 未关联消息的分组规则参与指纹，避免复用曾把不同原生回复合并的修订。
    if (object(row.record.normalizedEvent).turnKey === null) digest.update("unassigned-record-v2");
    digest.update(JSON.stringify([row.line, rawHash, row.record]));
  }
  const hash = digest.digest("hex");
  return { source, hash, meta, records: [{ record: { normalizedMeta: meta }, raw: "", line: 0 }, ...records] };
}

export function createNormalizedAdapter(config: {
  id: string;
  quickCheck?: HistoryAdapter["quickCheck"];
  readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot>;
  discoverFile?(location: SourceLocation): Promise<SourceLocation[]>;
  selectSources?(locations: SourceLocation[]): SourceLocation[];
  extract?: HistoryAdapter["extract"];
}): HistoryAdapter {
  return {
    id: config.id, normalized: true,
    quickCheck: config.quickCheck,
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

/** 规范化事件只在这里形成会话消息，所有新适配器共享轮次、工具状态和资源口径。 */
export function parseNormalizedSession(snapshot: NormalizedSnapshot, sink: SessionSink, extract: HistoryAdapter["extract"] = defaultToolEvidence): SessionSourceMeta {
  const source = snapshot.source; const rawId = source.sessionId ?? `unknown:${normalizedHash(source.path).slice(0, 24)}`;
  const id = normalizedSessionKey(source.client, rawId); const native = snapshot.meta;
  const meta: SessionSourceMeta = { id, client: source.client, clientSessionId: rawId, path: source.path,
    sourceId: source.sourceId ?? `${source.client}:${normalizedHash(rawId).slice(0, 24)}`,
    title: native.title ?? "未命名会话", titleOrigin: native.title ? native.titleOrigin ?? "recorded" : "fallback",
    startedAt: native.startedAt, updatedAt: native.updatedAt,
    project: source.cwd && isAbsolute(source.cwd) ? source.cwd : undefined, projectOrigin: source.cwd && isAbsolute(source.cwd) ? "client_metadata" : undefined,
    parentSessionId: native.parentSessionId ? normalizedSessionKey(source.client, native.parentSessionId) : undefined,
    relationship: native.relationship, branches: native.branches, childSessionIds: native.childSessionIds?.map(child => normalizedSessionKey(source.client, child)), usageReports: native.usageReports, contextSnapshots: native.contextSnapshots,
    messageCount: 0, turnCount: 0, models: [], gaps: [...(native.gaps ?? [])] };
  const messages = new Map<string, number>(); const pending = new Map<string, SessionMessage[]>(); const inputs = new Map<string, unknown>();
  const candidates = new Map<string, { message: SessionMessage; allowInferredFinal: boolean; finalEvidence?: SessionMessage["finalEvidence"]; finalAt?: string; requestKey?: string }>();
  const finals = new Map<string, Set<SessionMessage>>(); const interrupted = new Map<string, NormalizedEvent[]>();
  const turns = new Map<string, string>(); const models = new Set<string>(); let currentTurn = `${id}:turn:0`;
  const messageIds = new Map<string, string>();
  const boundaryMessages = new Map<string, string[]>();
  const requestGroups = new Map<string, { first: SessionMessage; messages: Set<string>; timing?: SessionUsage["timing"]; usage?: SessionUsage }>();
  const sameBranch = (left: { branchIds?: string[] }, right: { branchIds?: string[] }) => !left.branchIds?.length || !right.branchIds?.length
    || left.branchIds.some(branch => right.branchIds!.includes(branch));
  const invalidateFinal = (key: string, event: NormalizedEvent) => {
    const candidate = candidates.get(key);
    if (candidate && sameBranch(candidate.message, event)) candidates.delete(key);
    const values = finals.get(key);
    for (const message of values ?? []) if (message.final && sameBranch(message, event)) {
      message.final = undefined; message.finalEvidence = undefined; message.finalAt = undefined; sink.message(message);
      values!.delete(message);
    }
    if (!values?.size) finals.delete(key);
  };
  for (const row of snapshot.records) {
    const event = row.record.normalizedEvent as NormalizedEvent | undefined;
    if (!event) continue;
    if (event.kind === "user" && event.turnKey !== null) {
      const key = event.turnKey ?? event.key;
      if (!turns.has(key)) turns.set(key, `${id}:turn:${++meta.turnCount}`);
      currentTurn = turns.get(key)!;
    } else if (event.turnKey && turns.has(event.turnKey)) currentTurn = turns.get(event.turnKey)!;
    // 独立保留每条未知回复，同时沿用位置 0 的分页规则，不计入实际用户轮次。
    const turn = event.turnKey === null ? `${id}:unassigned:${row.line}:turn:0` : currentTurn;
    const previous = messages.get(event.key);
    const partial = event.interrupted === true || event.requestTiming?.completion === "partial"
      || ["assistant", "thinking"].includes(event.kind) && event.status === "failure";
    const paths = event.filePaths ?? [object(event.input).file_path, object(event.input).filePath, object(event.input).path].filter((item): item is string => typeof item === "string");
    const value: SessionMessage = { id: `${id}:message:${normalizedHash(event.key).slice(0, 24)}`, sessionId: id,
      ordinal: previous ?? ++meta.messageCount, recordLine: row.line, turnId: turn, kind: event.kind,
      text: event.text ?? (event.input === undefined ? "" : JSON.stringify(event.input, null, 2)), textDescriptor: event.textDescriptor, occurredAt: event.occurredAt, model: event.model,
      reasoningEffort: event.reasoningEffort,
      callId: event.callId, tool: event.tool, status: event.status, final: partial ? undefined : event.final,
      finalEvidence: !partial && event.final ? event.finalEvidence : undefined,
      finalAt: !partial && event.final ? event.finalAt : undefined, finishedAt: event.finishedAt, durationMs: event.durationMs,
      interrupted: event.interrupted, copied: event.copied, branchIds: event.branchIds, currentBranch: event.currentBranch,
      operation: event.operation,
      filePaths: paths.length ? paths : undefined, resource: event.kind === "tool_call" ? event.resource ?? callResource(event.tool ?? "", event.input, meta.project ?? source.cwd)
        : event.kind === "user" ? event.resource : undefined };
    if (event.kind === "tool_call" && value.resource?.kind === "skill_read") value.resource = undefined;
    messages.set(event.key, value.ordinal);
    messageIds.set(event.key, value.id);
    const pointKey = JSON.stringify([row.line, event.occurredAt]);
    const pointMessages = boundaryMessages.get(pointKey) ?? [];
    if (!pointMessages.includes(value.id)) pointMessages.push(value.id);
    boundaryMessages.set(pointKey, pointMessages);
    if (event.model) models.add(event.model);
    if (event.occurredAt) { meta.startedAt = !meta.startedAt || event.occurredAt < meta.startedAt ? event.occurredAt : meta.startedAt; meta.updatedAt = !meta.updatedAt || event.occurredAt > meta.updatedAt ? event.occurredAt : meta.updatedAt; }
    if (event.finishedAt && Number.isFinite(Date.parse(event.finishedAt)) && event.occurredAt && Date.parse(event.finishedAt) >= Date.parse(event.occurredAt)) {
      meta.updatedAt = !meta.updatedAt || event.finishedAt > meta.updatedAt ? event.finishedAt : meta.updatedAt;
    }
    if (event.kind === "user" && !event.copied && meta.titleOrigin === "fallback" && event.text?.trim()) { meta.title = event.text.trim().replace(/\s+/g, " ").slice(0, 120); meta.titleOrigin = "first_user"; }
    const candidateOrdinal = candidates.get(turn)?.message.ordinal;
    const relatedOrdinal = event.usageMessageKey ? messages.get(event.usageMessageKey) : undefined;
    // 补发的用量状态只否定其所属响应，不将旧失败投影到更晚终答。
    const supersededUsage = event.kind === "context" && event.usage !== undefined
      && (relatedOrdinal === undefined || candidateOrdinal !== undefined && relatedOrdinal < candidateOrdinal);
    if (partial && !supersededUsage) {
      interrupted.set(turn, [...(interrupted.get(turn) ?? []), event]);
      invalidateFinal(turn, event);
    }
    if (event.kind === "assistant") {
      invalidateFinal(turn, event);
      if (!partial && (event.final || event.finalEvidence)) {
        interrupted.set(turn, (interrupted.get(turn) ?? []).filter(previous => !sameBranch(previous, event)));
      }
      candidates.set(turn, { message: value, allowInferredFinal: event.allowInferredFinal !== false && !partial,
        finalEvidence: !partial ? event.finalEvidence : undefined, finalAt: event.finalAt, requestKey: event.requestKey });
      if (value.final) {
        const values = finals.get(turn) ?? new Set<SessionMessage>(); values.add(value); finals.set(turn, values);
      }
    }
    if (event.kind === "tool_call") {
      invalidateFinal(turn, event);
      const key = event.callId ?? event.key;
      const calls = pending.get(key) ?? [];
      const existing = calls.findIndex(call => call.id === value.id);
      if (existing < 0) calls.push(value); else calls[existing] = value;
      pending.set(key, calls); inputs.set(value.id, event.input);
    }
    if (event.kind === "tool_result") {
      invalidateFinal(turn, event);
      const calls = pending.get(event.callId ?? "") ?? [];
      const call = calls.length === 1 ? calls[0] : undefined;
      value.tool ??= call?.tool;
      if (call) {
        call.status = event.status ?? "unknown"; call.durationMs = event.durationMs ?? call.durationMs;
        if (call.status === "success" && !call.resource) {
          const read = successfulSkillRead(call.tool ?? "", inputs.get(call.id), event.result, event.text ?? "", source.cwd, extract);
          call.resource = read.resource;
          call.resources = read.resources;
          call.filePaths = [...new Set([...(call.filePaths ?? []), ...read.paths])];
        }
        sink.message(call); pending.delete(event.callId ?? ""); inputs.delete(call.id);
      } else meta.gaps.push({ kind: calls.length > 1 ? "ambiguous" : "unpaired_call", message: calls.length > 1 ? "原生调用身份同时对应多个请求，未猜测结果关联" : "原生工具结果缺少可配对请求", messageDescriptor: calls.length > 1 ? { key: "diagnostics.history.adapters.normalized.m005" } : { key: "diagnostics.history.adapters.normalized.m006" }, sourceId: meta.sourceId });
    }
    sink.message(value);
    const usageValue = event.usage && !event.copied ? { ...event.usage, id: `${id}:usage:${normalizedHash(event.usageKey ?? event.key).slice(0, 24)}`,
      messageId: messageIds.get(event.usageMessageKey ?? event.key) ?? value.id,
      turnId: event.turnKey && turns.has(event.turnKey) ? turns.get(event.turnKey) : value.turnId,
      model: event.model, reasoningEffort: event.reasoningEffort ?? event.usage.reasoningEffort, occurredAt: event.occurredAt } : undefined;
    if (usageValue && !event.requestKey) sink.usage(usageValue);
    if (event.requestKey && !event.copied) {
      const group = requestGroups.get(event.requestKey) ?? { first: value, messages: new Set<string>() };
      if (["assistant", "thinking"].includes(value.kind)) group.messages.add(value.id);
      if (event.requestTiming) group.timing = event.requestTiming;
      if (usageValue) group.usage = { ...group.usage, ...usageValue, turnId: group.usage?.turnId ?? usageValue.turnId };
      requestGroups.set(event.requestKey, group);
    }
  }
  for (const [key, group] of requestGroups) {
    const usageValue = group.usage ?? { id: `${id}:usage:${normalizedHash(key).slice(0, 24)}`,
      turnId: group.first.turnId, model: group.first.model, reasoningEffort: group.first.reasoningEffort,
      occurredAt: group.timing?.end?.occurredAt ?? group.first.occurredAt };
    const timing = group.timing ? { ...group.timing, start: group.timing.start ? { ...group.timing.start } : undefined,
      end: group.timing.end ? { ...group.timing.end } : undefined, firstToken: group.timing.firstToken ? { ...group.timing.firstToken } : undefined } : undefined;
    if (timing) {
      for (const point of [timing.start, timing.end, timing.firstToken]) {
        if (!point || point.messageId) continue;
        const matches = boundaryMessages.get(JSON.stringify([point.recordLine, point.occurredAt])) ?? [];
        if (matches.length === 1) point.messageId = matches[0];
      }
    }
    sink.usage({ ...usageValue, timing, requestMessageIds: [...group.messages] });
  }
  const pendingCalls = [...pending.values()].flat();
  const pendingByTurn = new Map<string, SessionMessage[]>();
  for (const call of pendingCalls) pendingByTurn.set(call.turnId, [...(pendingByTurn.get(call.turnId) ?? []), call]);
  const isBlocked = (key: string, message: SessionMessage) => (pendingByTurn.get(key) ?? []).some(call => sameBranch(call, message))
    || (interrupted.get(key) ?? []).some(event => sameBranch(event, message));
  for (const [key, values] of finals) for (const message of values) if (message.final && isBlocked(key, message)) {
    message.final = undefined; message.finalEvidence = undefined; message.finalAt = undefined; sink.message(message);
  }
  for (const [key, candidate] of candidates) if (candidate.allowInferredFinal && !candidate.message.final && !isBlocked(key, candidate.message)) {
    const timing = candidate.requestKey ? requestGroups.get(candidate.requestKey)?.timing : undefined;
    const end = candidate.finalAt ?? (timing?.completion !== "partial" ? timing?.end?.occurredAt : undefined);
    const validEnd = end && Number.isFinite(Date.parse(end))
      && (!candidate.message.occurredAt || Date.parse(end) >= Date.parse(candidate.message.occurredAt));
    sink.message({ ...candidate.message, final: "inferred", finalEvidence: candidate.finalEvidence,
      finalAt: candidate.finalEvidence && validEnd ? end : undefined });
  }
  if (pendingCalls.length) meta.gaps.push({ kind: "unpaired_call", message: "部分原生工具请求尚未记录结果", messageDescriptor: { key: "diagnostics.history.adapters.normalized.m007" }, count: pendingCalls.length, sourceId: meta.sourceId });
  meta.models = [...models];
  return meta;
}
