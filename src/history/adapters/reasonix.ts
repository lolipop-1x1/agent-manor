import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readBoundedText, readBoundedTextSync } from "../../bounded-file.js";
import type { Gap } from "../../contracts.js";
import type { SourceLocation } from "../types.js";
import { number, object, physicalLines, returnedText, shellEvidence, string, toolEvidence, unifiedFragments } from "../extraction.js";
import { defaultToolEvidence, normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl } from "./normalized.js";
import type { NormalizedEvent, NormalizedSessionMetadata, RawHistoryRecord } from "./normalized.js";

const FORMAT = "reasonix-events";
const gap = (gaps: Gap[], kind: Gap["kind"], message: string, key: string) => gaps.push({ kind, message, messageDescriptor: { key: `diagnostics.history.adapters.reasonix.${key}` } });
const date = (value: unknown): string | undefined => {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
};
async function optionalJson(path: string, gaps: Gap[]): Promise<{ value: Record<string, unknown>; raw: string }> {
  try {
    const raw = await readBoundedText(path, 128 * 1024 * 1024);
    try { return { value: object(JSON.parse(raw)), raw }; }
    catch { gap(gaps, "parse_error", "Reasonix 旁路文件尚未形成有效 JSON", "m002"); return { value: {}, raw }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EFBIG") gap(gaps, "budget_exceeded", "Reasonix 旁路文件超过有界读取上限", "m001");
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { value: {}, raw: "" };
  }
}
async function optionalRows(path: string, gaps: Gap[]): Promise<RawHistoryRecord[] | undefined> {
  try { return await readBoundedJsonl(path, gaps); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
function argumentsValue(value: unknown, gaps: Gap[]): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { gap(gaps, "incomplete_record", "Reasonix 工具参数不完整，保留原始文本", "m003"); return value; }
}
/** 原生编号箭头与分页提示分别处理，不把提示文本当作文件正文。 */
function extract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const input = object(inputValue); const result = object(resultValue); const path = string(input.path);
  if (tool === "read_file" && path) {
    const output = returnedText(visible); const source = output.content.split(/\n\[more lines below; pass offset=\d+ to continue\]\n?$/)[0]!.trimEnd();
    const lines = physicalLines(source); const parsed = lines.map(line => /^\s*(\d+)→(.*)$/.exec(line));
    const expected = (number(input.offset) ?? 0) + 1;
    if (parsed.length && parsed.every((line, index) => line && Number(line[1]) === expected + index)) return [{ kind: "read", path,
      fragments: [{ kind: "read", content: parsed.map(line => line![2]).join("\n") + "\n", historicalStart: expected, completeLines: true }],
      ...(output.truncated ? { reason: "range_unknown: Reasonix 返回被截断，仅保留完整编号行", reasonDescriptor: { key: "diagnostics.history.adapters.reasonix.m004" } } : {}) }];
    return [{ kind: "read", path, fragments: [], reason: "range_unknown: Reasonix 读取结果缺少可校验编号行", reasonDescriptor: { key: "diagnostics.history.adapters.reasonix.m005" } }];
  }
  if (tool === "bash") return shellEvidence(string(input.command) ?? "", visible);
  if (tool === "edit_file" && string(result.diff)) return [{ kind: "edit", path, fragments: unifiedFragments(string(result.diff)!, path) }];
  return defaultToolEvidence(tool, inputValue, resultValue, visible);
}

/** 事件日志和检查点共用恢复规则，版本比较不能读取过期投影。 */
async function transcript(path: string, gaps: Gap[]) {
  const stem = path.replace(/\.jsonl$/, "");
  const checkpoint = await optionalRows(path, []);
  // 检查点只参与依赖；有可识别的原生日志时，转录由日志恢复。
  const eventGaps: Gap[] = []; const events = await optionalRows(`${stem}.events.jsonl`, eventGaps);
  let damagedLine: number | undefined;
  if (eventGaps.some(value => value.kind === "parse_error")) {
    // 原生解码器在首个坏记录处停止，不能把其后仍可解析的行接到可信前缀上。
    const eventPath = `${stem}.events.jsonl`;
    if ((await stat(eventPath)).size <= 128 * 1024 * 1024) {
      const lines = (await readBoundedText(eventPath, 128 * 1024 * 1024)).split("\n");
      for (const [index, raw] of lines.entries()) {
        if (!raw.trim()) continue;
        try { JSON.parse(raw); } catch { damagedLine = index + 1; break; }
      }
    }
  }
  let messages: { message: Record<string, unknown>; row: RawHistoryRecord; occurredAt?: string }[] = [];
  let revision: number | undefined;
  const native = events?.length && [1, 3].includes(number(events[0]!.record.schema_version) ?? -1);
  if (native) {
    gaps.push(...eventGaps);
    for (const row of events!) {
      if (damagedLine !== undefined && row.line > damagedLine) break;
      const record = row.record;
      if (![1, 3].includes(number(record.schema_version) ?? -1)) { gap(gaps, "unsupported_format", "Reasonix 事件 schema 尚未适配，未使用旧检查点覆盖", "m007"); break; }
      const next = number(record.revision); const base = number(record.base_revision);
      if (record.type === "append" && (number(record.message_index) ?? 0) !== messages.length) { gap(gaps, "incomplete_record", "Reasonix 追加索引不连续，保留最后可信前缀", "m008"); break; }
      if (record.type === "append" && base !== undefined && revision !== undefined && base !== revision) { gap(gaps, "ambiguous", "Reasonix 追加 revision 与已恢复状态不一致", "m009"); break; }
      const values = Array.isArray(record.messages) ? record.messages.map(object) : [];
      if (record.type === "replace") messages = values.map(message => ({ message, row, occurredAt: date(message.createdAt) }));
      else if (record.type === "append") messages.push(...values.map(message => ({ message, row, occurredAt: date(message.createdAt) ?? date(record.created_at) })));
      else { gap(gaps, "unsupported_format", "Reasonix 日志包含未知变更类型，保留最后可信前缀", "m010"); break; }
      revision = next ?? revision;
    }
  } else if (events?.length && events[0]?.record.schema_version !== undefined) {
    gaps.push(...eventGaps); gap(gaps, "unsupported_format", "Reasonix 事件 schema 尚未适配，未使用旧检查点覆盖", "m007");
  } else {
    if (!checkpoint) throw Object.assign(new Error("Reasonix 会话来源已不存在"), { code: "ENOENT" });
    const checkpointGaps: Gap[] = []; const rows = await readBoundedJsonl(path, checkpointGaps); gaps.push(...checkpointGaps);
    messages = rows.map(row => ({ message: row.record, row, occurredAt: date(row.record.createdAt) }));
    if (eventGaps.length) gaps.push(...eventGaps);
  }
  return { messages, checkpoint, events };
}

async function snapshot(location: SourceLocation) {
  const gaps: Gap[] = []; const stem = location.path.replace(/\.jsonl$/, "");
  const metaFile = await optionalJson(`${location.path}.meta`, gaps);
  const subagent = await optionalJson(`${stem}.meta.json`, gaps);
  const contextFile = await optionalJson(`${stem}.context.json`, gaps);
  const wireMeta = await optionalJson(`${stem}.wire.meta.json`, gaps);
  const meta: NormalizedSessionMetadata = { gaps };
  const stateMeta = metaFile.value; const childMeta = subagent.value;
  if (stateMeta.superseded === true) meta.branches = [{ id: "superseded", current: false, label: "已被回退替代",
    labelDescriptor: { key: "diagnostics.history.adapters.reasonix.m015" } }];
  const sessionId = string(stateMeta.id) ?? string(childMeta.ref) ?? location.sessionId ?? basename(stem);
  const cwd = normalizeHistoryPath(string(stateMeta.workspace_root) ?? string(childMeta.workspaceRoot));
  const parent = string(childMeta.parentSession) ?? string(stateMeta.parent_id);
  const relationship = childMeta.parentSession ? "child" : "fork";
  meta.title = string(stateMeta.custom_title) ?? string(stateMeta.name) ?? string(stateMeta.topic_title) ?? string(childMeta.name);
  if (parent) {
    meta.parentSessionId = parent; meta.relationship = relationship;
    meta.relationships = [{ kind: relationship === "child" ? "subagent" : "fork", parentSessionId: parent, agentId: string(childMeta.ref) }];
    const parentPath = childMeta.parentSession ? join(dirname(dirname(location.path)), `${parent}.jsonl`) : join(dirname(location.path), `${parent}.jsonl`);
    if (!parent.includes("/") && !parent.includes("\\")) {
      try { await stat(parentPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; gap(gaps, "source_missing", "Reasonix 父会话来源缺失", "m006"); }
    }
  }
  const { messages, checkpoint, events } = await transcript(location.path, gaps);
  const copiedIndices = new Set<number>(); let parentFingerprint = "";
  // 只有明确 superseded 版本才核验完整消息共同前缀；普通 parent_id 不构成复制证明。
  if (stateMeta.superseded === true && parent && parent !== sessionId && !parent.includes("/") && !parent.includes("\\")) {
    const parentGaps: Gap[] = [];
    try {
      const original = await transcript(join(dirname(location.path), `${parent}.jsonl`), parentGaps);
      parentFingerprint = [...(original.checkpoint ?? []), ...(original.events ?? [])].map(row => row.raw).join("\n");
      if (!parentGaps.length) for (let index = 0; index < Math.min(messages.length, original.messages.length); index++) {
        if (JSON.stringify(messages[index]!.message) !== JSON.stringify(original.messages[index]!.message)) break;
        copiedIndices.add(index);
      }
      else gap(gaps, "ambiguous", "Reasonix 父版本转录不完整，复制边界未核验", "m016");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!gaps.some(value => value.kind === "source_missing")) gap(gaps, "source_missing", "Reasonix 父会话来源缺失", "m006");
    }
    if (meta.relationships?.[0] && copiedIndices.size) {
      meta.relationships[0].copiedRecordIdentityHashes = [...copiedIndices].map(index => normalizedHash(`${index}:${JSON.stringify(messages[index]!.message)}`));
      meta.relationships[0].copiedRecordIdentityProof = "reasonix-superseded-prefix";
    }
  }
  const records: RawHistoryRecord[] = []; const callDiffs = new Map<string, string>();
  const assistantByIndex = new Map<number, NormalizedEvent>(); let turnKey: string | undefined; let lastUserIndex = -1;
  const emit = (event: NormalizedEvent, row: RawHistoryRecord, index?: number) => {
    const normalized = normalizedRecord(event, row.raw, row.line, index); records.push(normalized); return normalized.record.normalizedEvent as NormalizedEvent;
  };
  for (const [index, value] of messages.entries()) {
    const message = value.message; const row = value.row; const role = string(message.role); const key = `reasonix:message:${index}`;
    const occurredAt = value.occurredAt; const model = string(message.modelRef) ?? string(childMeta.model) ?? string(stateMeta.model);
    const text = string(message.raw_content) ?? string(message.content) ?? "";
    const interrupted = message.local_only === true && role === "assistant" || message.interrupted_turn !== undefined;
    const base = { occurredAt, model, turnKey, currentBranch: stateMeta.superseded !== true, branchIds: stateMeta.superseded === true ? ["superseded"] : undefined, copied: copiedIndices.has(index) || undefined, nativeIdentityHash: normalizedHash(`${index}:${JSON.stringify(message)}`) };
    if (role === "user" && message.host_authored !== true) { turnKey = key; lastUserIndex = index; emit({ ...base, key, kind: "user", text, turnKey }, row, index); }
    else if (role === "user" || role === "system") emit({ ...base, key, kind: role === "system" ? "system" : "context", text }, row, index);
    else if (role === "assistant") {
      const event = emit({ ...base, key, kind: "assistant", text, allowInferredFinal: false, interrupted: interrupted || undefined }, row, index);
      assistantByIndex.set(index, event);
      if (string(message.reasoning_content)) emit({ ...base, key: `${key}:thinking`, kind: "thinking", text: string(message.reasoning_content), interrupted: interrupted || undefined }, row, index);
      for (const [callIndex, item] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
        const call = object(item); const callId = string(call.id);
        if (!callId) { gap(gaps, "unpaired_call", "Reasonix 工具请求缺少原生调用身份", "m011"); continue; }
        const tool = string(call.resolved_name) ?? string(call.name) ?? "unknown"; const diff = string(call.diff); if (diff) callDiffs.set(callId, diff);
        emit({ ...base, key: `${key}:call:${callIndex}`, kind: "tool_call", callId, tool, input: argumentsValue(call.arguments, gaps) }, row, index);
      }
    } else if (role === "tool" && message.name !== "__reasonix_local_only__") {
      const callId = string(message.tool_call_id); const execution = object(message.tool_execution);
      const cancelled = ["cancelled", "interrupted", "running"].includes(string(execution.state) ?? "");
      const failure = message.tool_failure !== undefined || number(execution.exitCode) !== undefined && number(execution.exitCode) !== 0;
      const status = cancelled ? "unknown" : failure ? "failure" : "success";
      emit({ ...base, key: `${key}:result`, kind: "tool_result", callId, tool: string(message.name), text,
        result: { ...message, diff: callId ? callDiffs.get(callId) : undefined }, status, durationMs: number(execution.durationMs) }, row, index);
    } else {
      emit({ ...base, key, kind: "context", text, interrupted: interrupted || undefined }, row, index);
      if (!role || !["tool", "user", "system", "assistant"].includes(role)) gap(gaps, "unsupported_format", "Reasonix 转录包含未知角色", "m012");
    }
  }
  const wire = await optionalRows(`${stem}.wire.jsonl`, gaps);
  let wireTurnIndex: number | undefined; let wireTurnKey: string | undefined;
  const reports: NonNullable<NormalizedSessionMetadata["usageReports"]> = [];
  for (const row of wire ?? []) {
    const frame = row.record; if (frame.nonPersistable === true) continue;
    const kind = string(frame.kind); const time = date(frame.timestamp) ?? date(frame.createdAt);
    if (kind === "turn_started") { wireTurnIndex = number(frame.msgIndex); wireTurnKey = wireTurnIndex === undefined ? undefined : `reasonix:message:${wireTurnIndex}`; }
    if (kind === "turn_done") {
      const outcome = string(frame.outcome); const failed = frame.cancelled === true || Boolean(frame.err) || ["failed", "cancelled", "interrupted"].includes(outcome ?? "");
      if (wireTurnIndex !== undefined) {
        const candidate = [...assistantByIndex.entries()].reverse().find(([index]) => index >= wireTurnIndex! && !messages.slice(wireTurnIndex! + 1, index + 1).some(value => value.message.role === "user" && value.message.host_authored !== true));
        if (candidate && !failed && ["completed", "succeeded", "success"].includes(outcome ?? "")) { candidate[1].final = "explicit"; candidate[1].finalEvidence = "normal_stop"; candidate[1].finalAt = time; }
      }
      if (failed) emit({ key: `reasonix:wire:${row.line}`, kind: "context", text: string(frame.err) ?? outcome ?? kind, interrupted: true, turnKey: wireTurnKey, occurredAt: time }, { ...row, line: messages.length + row.line });
    }
    if (kind === "usage") {
      const usage = object(frame.usage); const identity = string(usage.attemptId);
      // wire 的 billable 桶可能合并多次恢复尝试，不将 attemptId 当作单次 HTTP 请求。
      reports.push({ scope: "turn", nativeId: identity ?? `wire:${row.line}`, turnKey: wireTurnKey, model: string(frame.modelRef),
        inputTokens: number(usage.promptTokens), outputTokens: number(usage.completionTokens), cachedInputTokens: number(usage.cacheHitTokens),
        reasoningOutputTokens: number(usage.reasoningTokens), contextTokens: number(usage.contextPromptTokens), occurredAt: time,
        reportedCostUsd: usage.currencyCode === "USD" ? number(usage.cost) : undefined });
      emit({ key: `reasonix:wire-usage:${row.line}`, kind: "context", text: kind, occurredAt: time, turnKey: wireTurnKey }, { ...row, line: messages.length + row.line });
    } else if (["compaction_started", "compaction_done", "context_maintenance"].includes(kind ?? "")) {
      emit({ key: `reasonix:wire:${row.line}`, kind: "compression", text: string(frame.text) ?? string(frame.detail) ?? kind, occurredAt: time,
        turnKey: wireTurnKey, status: kind === "compaction_done" && frame.err ? "failure" : "unknown" }, { ...row, line: messages.length + row.line });
    }
  }
  if (reports.length) meta.usageReports = reports;
  if (wireMeta.value.truncated === true) gap(gaps, "incomplete_record", "Reasonix 轨迹旁路仅保存可信前缀", "m013");
  const inFlight = object(stateMeta.in_flight_turn);
  if (Object.keys(inFlight).length && number(inFlight.start_message_index) !== undefined) {
    const boundary = number(inFlight.start_message_index)!;
    for (const [index, event] of assistantByIndex) if (index >= boundary) { event.interrupted = true; event.final = undefined; }
  }
  const receipt = object(contextFile.value.last_receipt);
  if (Object.keys(receipt).length) emit({ key: "reasonix:compaction-receipt", kind: "compression", text: string(receipt.reason) ?? string(receipt.action),
    occurredAt: date(receipt.created_at), status: receipt.status === "failed" ? "failure" : receipt.status === "applied" ? "success" : "unknown" },
  { record: contextFile.value, raw: contextFile.raw, line: messages.length + (wire?.length ?? 0) + 1 });
  if (stateMeta.archived === true || stateMeta.superseded === true) emit({ key: "reasonix:lifecycle", kind: "context",
    text: stateMeta.archived === true ? "已归档" : "已被回退替代", textDescriptor: { key: stateMeta.archived === true ? "diagnostics.history.adapters.reasonix.m014" : "diagnostics.history.adapters.reasonix.m015" } },
  { record: stateMeta, raw: metaFile.raw, line: messages.length + (wire?.length ?? 0) + 2 });
  if (childMeta.status && childMeta.status !== "completed") emit({ key: "reasonix:subagent-status", kind: "context", text: string(childMeta.status),
    turnKey: lastUserIndex >= 0 ? `reasonix:message:${lastUserIndex}` : undefined, interrupted: ["failed", "cancelled", "interrupted"].includes(string(childMeta.status) ?? "") || undefined },
  { record: childMeta, raw: subagent.raw, line: messages.length + (wire?.length ?? 0) + 3 });
  return normalizedSnapshot({ ...location, format: FORMAT, sessionId, cwd, parentSessionId: parent }, records, meta,
    [metaFile.raw, subagent.raw, contextFile.raw, wireMeta.raw, parentFingerprint, ...(checkpoint ?? []).map(row => row.raw), ...(events ?? []).map(row => row.raw), ...(wire ?? []).map(row => row.raw)].join("\u0000"));
}

export function reasonixHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const expand = (value: string) => value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const root = expand(environment.REASONIX_HOME?.trim() || join(home, ".reasonix"));
  let state = environment.REASONIX_STATE_HOME?.trim();
  if (!state) try { state = string(object(parseToml(readBoundedTextSync(join(root, "config.toml"), 16 * 1024 * 1024)).storage).state); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EFBIG") throw error; /* 原生加载端同样对无效 storage 配置使用默认根。 */ }
  const resolved = state ? expand(state) : root;
  return isAbsolute(resolved) ? [join(resolved, "sessions"), join(resolved, "projects"), join(resolved, "archive")] : [];
}
export const reasonixAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract });
