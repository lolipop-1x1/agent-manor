import { createReadStream } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { HistoryEvent } from "../../contracts.js";
import type { SessionRequestTiming } from "../../session-contracts.js";
import { changedFragments, object, number, shellEvidence, string, textContent, toolEvidence } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl } from "./normalized.js";
import type { NormalizedEvent, NormalizedSessionMetadata, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import type { SourceLocation } from "../types.js";

const DSH_FORMAT = "dsh-jsonl";
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;
type NativeRow = RawHistoryRecord & { record: Record<string, unknown> };

function nextZstdFrameEnd(bytes: Buffer, start: number): number | undefined {
  if (bytes.length - start < 4) return undefined;
  if (bytes.readUInt32LE(start) !== ZSTD_MAGIC) throw new Error("invalid Zstandard frame magic");
  let offset = start + 4;
  if (offset === bytes.length) return undefined;
  const descriptor = bytes.readUInt8(offset++);
  if ((descriptor & 0x18) !== 0) throw new Error("reserved Zstandard frame-header bit");
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (bytes.length - offset < remainingHeaderBytes) return undefined;
  offset += remainingHeaderBytes;
  for (;;) {
    if (bytes.length - offset < 3) return undefined;
    const blockHeader = bytes.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 0x03) throw new Error("reserved Zstandard block type");
    const payloadBytes = blockType === 0x01 ? 1 : blockSize;
    if (bytes.length - offset < payloadBytes) return undefined;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (bytes.length - offset < 4) return undefined;
    offset += 4;
  }
  return offset;
}

function zstdFrameRanges(bytes: Buffer, gaps: NonNullable<NormalizedSessionMetadata["gaps"]>): { start: number; end: number }[] {
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const end = nextZstdFrameEnd(bytes, offset);
      if (end === undefined) {
        gaps.push({ kind: "incomplete_record", message: "DSH Zstandard 末尾帧不完整", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m001" } });
        break;
      }
      frames.push({ start: offset, end });
      offset = end;
    } catch {
      gaps.push({ kind: "parse_error", message: "DSH Zstandard 帧结构无效，后续字节无法安全定位", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m002" } });
      break;
    }
  }
  return frames;
}

function nativeTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function dshUsage(value: unknown): NormalizedEvent["usage"] {
  const usage = object(value);
  const uncached = tokenCount(usage.inputTokens);
  let cacheRead = tokenCount(usage.cacheReadTokens);
  let cacheWrite = tokenCount(usage.cacheWriteTokens);
  const output = tokenCount(usage.outputTokens);
  const reasoning = tokenCount(usage.reasoningTokens);
  // 总量恒等式确认省略桶为零；缺少总量或分项冲突时不补造输入。
  if (uncached !== undefined && output !== undefined
    && (usage.cacheReadTokens === undefined || cacheRead !== undefined) && (usage.cacheWriteTokens === undefined || cacheWrite !== undefined)
    && tokenCount(usage.totalTokens) === uncached + (cacheRead ?? 0) + (cacheWrite ?? 0) + output) {
    cacheRead ??= 0; cacheWrite ??= 0;
  }
  const normalized = {
    ...(uncached !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? { inputTokens: uncached + cacheRead + cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function dshRequest(data: Record<string, unknown>, seq: number, line: number, attempt = false): { requestKey: string; requestTiming: SessionRequestTiming } {
  const message = object(data.message);
  const stream = Array.isArray(data.stream) ? data.stream.map(object) : [];
  const terminal = stream.at(-1);
  const finish = terminal?.type === "chunk" && object(terminal.chunk).type === "finish" ? terminal : undefined;
  const replay = object(object(message.source).replayState);
  const responseId = string(object(replay.response).responseId)
    ?? string(object(object(object(finish?.chunk).replayState).response).responseId);
  const requestKey = !attempt && responseId ? `dsh:response:${responseId}` : `dsh:request:${seq}`;
  const starts = stream.filter(part => ["text-chunks", "reasoning-chunks", "tool-call-chunks"].includes(string(part.type) ?? ""))
    .map(part => number(part.time0)).filter((time): time is number => time !== undefined && Boolean(nativeTime(time)));
  const start = starts.length ? nativeTime(Math.min(...starts)) : undefined;
  const end = nativeTime(finish?.time);
  const partial = attempt || data.interrupted === true;
  const ended = finish && ["stop", "tool-calls"].includes(string(object(object(finish.chunk).reason).kind) ?? "");
  return { requestKey, requestTiming: { basis: "recorded", window: "generation", method: "dsh_stream_window",
    completion: partial ? "partial" : ended ? "explicit" : "unknown",
    ...(partial ? { completionEvidence: "request_interrupted" as const } : ended ? { completionEvidence: "stream_finish" as const } : {}),
    ...(start ? { start: { occurredAt: start, recordLine: line } } : {}),
    ...(end ? { end: { occurredAt: end, recordLine: line } } : {}),
    ...(start && end ? { durationMs: Date.parse(end) - Date.parse(start) } : {}) } };
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function contentText(value: unknown, type = "text"): string {
  if (typeof value === "string") return value;
  return contentBlocks(value).filter(block => block.type === type).map(block => string(block.text) ?? "").filter(Boolean).join("\n");
}

function callInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return undefined; }
}

function headerSource(header: Record<string, unknown>, location: SourceLocation, version?: number): SourceLocation {
  const { sourceCompleteness: _sourceCompleteness, adapterGap: _adapterGap, ...sourceLocation } = location;
  const id = string(header.id) ?? location.sessionId;
  const parentSessionId = string(header.parentSession);
  return {
    ...sourceLocation,
    format: DSH_FORMAT,
    selector: version === undefined ? location.selector : `v${version}`,
    sessionId: id,
    cwd: normalizeHistoryPath(string(header.cwd)),
    parentSessionId,
  };
}

function readToolEvidence(inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const input = object(inputValue);
  const result = object(resultValue);
  const message = object(result.message);
  const meta = object(result.meta);
  const path = string(meta.path) ?? string(input.file_path) ?? string(input.path);
  if (message.isError === true) return [{ kind: "read", path, fragments: [], reason: "range_unknown: DSH read 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m003" } }];
  const lines = Array.isArray(meta.lines) ? meta.lines.map(object) : undefined;
  const offset = number(meta.offset);
  const totalLines = number(meta.totalLines);
  if (!path || offset === undefined || totalLines === undefined || !lines
    || lines.some((line, index) => !Number.isSafeInteger(line.number) || typeof line.text !== "string"
      || Number(line.number) !== offset + index)) {
    return toolEvidence("Read", inputValue, resultValue, visible);
  }
  const content = lines.map(line => String(line.text)).join("\n");
  const structured = { file: { filePath: path, startLine: offset, numLines: lines.length, totalLines, content } };
  return toolEvidence("Read", inputValue, structured, visible);
}

function editToolEvidence(inputValue: unknown, resultValue: unknown): ReturnType<typeof toolEvidence> {
  const input = object(inputValue);
  const result = object(resultValue);
  const message = object(result.message);
  if (message.isError === true) return [{ kind: "edit", path: string(input.file_path), fragments: [], reason: "range_unknown: DSH edit 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m004" } }];
  const meta = object(result.meta);
  const diffs = Array.isArray(meta.diffs) ? meta.diffs.map(object) : [];
  const path = string(input.file_path) ?? string(input.path);
  if (!diffs.length) return toolEvidence("Edit", inputValue, resultValue, contentText(message.content));
  const fragments = diffs.flatMap(diff => {
    const diffPath = string(diff.path) ?? path;
    if ((path && diffPath && path !== diffPath) || typeof diff.newText !== "string") return [];
    const before = typeof diff.oldText === "string" ? diff.oldText : "";
    return changedFragments(before, diff.newText, diffPath).map(fragment => ({ ...fragment, historicalStart: undefined }));
  });
  return [{ kind: "edit", path, fragments, ...fragments.length ? {} : { reason: "range_unknown: DSH edit 元数据没有可核验差异", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m005" } } }];
}

function writeToolEvidence(inputValue: unknown, resultValue: unknown): ReturnType<typeof toolEvidence> {
  const input = object(inputValue);
  const result = object(resultValue);
  const message = object(result.message);
  const meta = object(result.meta);
  const path = string(input.file_path) ?? string(input.path);
  if (message.isError === true) return [{ kind: "edit", path, fragments: [], reason: "range_unknown: DSH write 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m006" } }];
  const diffs = Array.isArray(meta.diffs) ? meta.diffs.map(object) : [];
  if (string(meta.operation) === "create" && typeof input.content === "string") {
    return [{ kind: "edit", path, fragments: input.content ? [{ kind: "added", content: input.content, historicalStart: 1, completeLines: true, path }] : [] }];
  }
  if (!diffs.length) return [{ kind: "edit", path, fragments: [], reason: "range_unknown: DSH write 元数据没有可核验差异", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m007" } }];
  const fragments = diffs.flatMap(diff => {
    const diffPath = string(diff.path) ?? path;
    if ((path && diffPath && path !== diffPath) || typeof diff.newText !== "string") return [];
    const before = typeof diff.oldText === "string" ? diff.oldText : "";
    return changedFragments(before, diff.newText, diffPath).map(fragment => ({ ...fragment, historicalStart: undefined }));
  });
  return [{ kind: "edit", path, fragments, ...fragments.length ? {} : { reason: "range_unknown: DSH write 元数据没有可核验差异", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m007" } } }];
}

function dshExtract(tool: string, input: unknown, result: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const lower = tool.toLowerCase();
  if (lower === "read" || lower.endsWith(".read")) return readToolEvidence(input, result, visible);
  if (lower === "edit" || lower.endsWith(".edit")) return editToolEvidence(input, result);
  if (lower === "write" || lower.endsWith(".write")) return writeToolEvidence(input, result);
  if (lower === "bash" || lower.endsWith(".bash")) {
    const message = object(object(result).message);
    if (message.isError === true || visible === "(no output)" || visible.includes("\n[stderr]\n")
      || /(?:^|\n)\[(?:output truncated;|some output was dropped from memory;|exit code:|timed out after |stopped: |killed by signal: |still running after |sandbox:)/.test(visible)) {
      return [{ kind: "other", fragments: [], reason: "range_unknown: DSH bash 返回包含错误、截断或状态标记，无法确认完整输出", reasonDescriptor: { key: "diagnostics.history.adapters.dsh.m008" } }];
    }
    return shellEvidence(string(object(input).command) ?? string(object(input).cmd) ?? "", visible);
  }
  return toolEvidence(tool, input, result, visible);
}

async function readRows(path: string, gaps: NormalizedSessionMetadata["gaps"]): Promise<NativeRow[]> {
  const issues = gaps ?? [];
  if (!/\.jsonl\.(?:zstd|zst)$/.test(path)) {
    return await readBoundedJsonl(path, issues, createReadStream(path)) as NativeRow[];
  }
  const compressed: Buffer[] = [];
  let compressedBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.from(chunk);
    const remaining = MAX_SOURCE_BYTES - compressedBytes;
    if (value.length > remaining) {
      if (remaining > 0) compressed.push(value.subarray(0, remaining));
      compressedBytes += remaining;
      issues.push({ kind: "budget_exceeded", message: "DSH 压缩来源超过 128 MiB 有界读取上限", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m009" } });
      break;
    }
    compressed.push(value);
    compressedBytes += value.length;
  }
  const bytes = Buffer.concat(compressed, compressedBytes);
  const frames = zstdFrameRanges(bytes, issues);
  const decoded: Buffer[] = [];
  let decodedBytes = 0;
  for (const frame of frames) {
    try {
      const value = zstdDecompressSync(bytes.subarray(frame.start, frame.end), { maxOutputLength: MAX_SOURCE_BYTES });
      if (decodedBytes + value.length > MAX_SOURCE_BYTES) {
        issues.push({ kind: "budget_exceeded", message: "DSH 解压来源超过 128 MiB 有界读取上限", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m010" } });
        break;
      }
      decoded.push(value);
      decodedBytes += value.length;
    } catch {
      issues.push({ kind: "parse_error", message: "DSH Zstandard 帧解压失败", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m011" } });
    }
  }
  async function* chunks(): AsyncGenerator<Buffer> {
    yield* decoded;
  }
  return await readBoundedJsonl(path, issues, chunks()) as NativeRow[];
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: NonNullable<NormalizedSessionMetadata["gaps"]> = [];
  const rows = await readRows(location.path, gaps);
  if (location.adapterGap) gaps.push({ ...location.adapterGap });
  const headerRow = rows[0];
  const header = headerRow?.record.type === "session" ? headerRow.record : undefined;
  if (!header) {
    gaps.push({ kind: "unsupported_format", message: "DSH 来源缺少可识别的会话头记录", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m012" } });
    return normalizedSnapshot(location, [], { gaps });
  }
  const version = tokenCount(header.version);
  const source = headerSource(header, location, version);
  const eventRows = rows.slice(1);
  const inheritedMarker = eventRows.filter(row => row.record.type === "session/end-seed" && object(row.record.data).inherited === true).at(-1);
  const inheritedCut = inheritedMarker ? tokenCount(inheritedMarker.record.seq) : undefined;
  if (header.isSeeded === true && inheritedCut === undefined) {
    gaps.push({ kind: "incomplete_record", message: "DSH seeded 会话缺少可核验的继承边界标记", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m013" } });
  }
  const parentSessionId = string(header.parentSession);
  const relationships = parentSessionId ? [
    ...(header.origin === "subagent" ? [{ kind: "subagent" as const, parentSessionId }] : []),
    { kind: "fork" as const, parentSessionId, ...(inheritedCut !== undefined ? { endOrdinalExclusive: inheritedCut } : {}) },
  ] : [];
  const metadata: NormalizedSessionMetadata = {
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(header.origin === "subagent" ? { relationship: "child" as const } : parentSessionId ? { relationship: "fork" as const } : {}),
    relationships,
    gaps,
  };
  const knownCallIds = new Set(eventRows.filter(row => row.record.type === "tool/call").map(row => string(object(row.record.data).callId)).filter((value): value is string => Boolean(value)));
  const records = [] as ReturnType<typeof normalizedRecord>[];
  const toolNames = new Map<string, string | undefined>();
  const completedTurns = new Set(eventRows.filter(row => row.record.type === "turn/end" && object(object(row.record.data).reason).kind === "completed")
    .map(row => object(row.record.data).turn).filter(value => typeof value === "number").map(String));
  const lastAssistant = new Map<string, { seq: number; interrupted: boolean; hasToolCall: boolean }>();
  const requestByCall = new Map<string, string | undefined>();
  for (const row of eventRows) {
    if (row.record.type !== "assistant/message") continue;
    const data = object(row.record.data);
    const message = object(data.message);
    const turn = data.turn === undefined ? undefined : String(data.turn);
    if (turn === undefined) continue;
    const seq = tokenCount(row.record.seq) ?? row.line;
    const hasToolCall = contentBlocks(message.content).some(block => block.type === "tool-call");
    const request = dshRequest(data, seq, row.line);
    for (const block of contentBlocks(message.content).filter(block => block.type === "tool-call")) {
      const callId = string(block.id);
      if (callId) requestByCall.set(callId, requestByCall.has(callId) && requestByCall.get(callId) !== request.requestKey ? undefined : request.requestKey);
    }
    const previous = lastAssistant.get(turn);
    if (!previous || seq >= previous.seq) lastAssistant.set(turn, { seq, interrupted: data.interrupted === true, hasToolCall });
  }
  for (const row of eventRows) {
    const record = row.record;
    const type = string(record.type) ?? "unknown";
    const data = object(record.data);
    const seq = tokenCount(record.seq) ?? row.line;
    const key = `dsh:event:${seq}`;
    const occurredAt = nativeTime(record.time);
    const turnKey = data.turn === undefined ? undefined : `turn:${String(data.turn)}`;
    const copied = inheritedCut !== undefined && seq < inheritedCut;
    const appendSurface = record.surfaceOp === undefined || record.surfaceOp === "append";
    if (type === "user/message" || type === "system/message" || type === "developer/message") {
      const message = object(data.message ?? data);
      const sourceKind = string(object(message.source).kind);
      const content = message.content;
      const kind = type === "system/message" ? "system" : type === "developer/message" ? "context"
        : sourceKind === "user" && appendSurface ? "user" : "context";
      const text = contentText(content);
      records.push(normalizedRecord({ key, kind, ...(text ? { text } : {}), occurredAt, turnKey, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "assistant/message") {
      const message = object(data.message);
      const content = contentBlocks(message.content);
      const text = content.filter(block => block.type === "text").map(block => string(block.text) ?? "").filter(Boolean).join("\n");
      const reasoning = content.filter(block => block.type === "reasoning").map(block => string(block.text) ?? "").filter(Boolean).join("\n");
      const nativeUsage = dshUsage(data.usage ?? message.usage);
      const usage = nativeUsage ? { ...nativeUsage, provider: string(object(message.source).provider) } : undefined;
      const request = dshRequest(data, seq, row.line);
      const requestTiming = header.isSeeded === true && inheritedCut === undefined ? undefined : request.requestTiming;
      const model = string(object(message.source).model) ?? string(object(data.usage).model);
      const turn = data.turn === undefined ? undefined : String(data.turn);
      const candidate = turn === undefined ? undefined : lastAssistant.get(turn);
      const final = turn && completedTurns.has(turn) && candidate?.seq === seq && !candidate.hasToolCall && !candidate.interrupted ? "inferred" : undefined;
      const interrupted = data.interrupted === true && candidate?.seq === seq;
      records.push(normalizedRecord({ key: `${key}:assistant`, kind: "assistant", ...(text ? { text } : {}), occurredAt, model, turnKey,
        ...request, requestTiming, usageKey: usage ? `${request.requestKey}:usage` : undefined, usage, final, allowInferredFinal: false,
        interrupted: interrupted || undefined, copied }, row.raw, row.line, seq));
      if (reasoning) records.push(normalizedRecord({ key: `${key}:reasoning`, kind: "thinking", text: reasoning, occurredAt, model, turnKey, requestKey: request.requestKey, copied }, row.raw, row.line, seq));
      for (const block of content.filter(block => block.type === "tool-call")) {
        const callId = string(block.id);
        if (!callId || knownCallIds.has(callId)) continue;
        const tool = string(block.name) ?? "unknown";
        records.push(normalizedRecord({ key: `${key}:call:${callId}`, kind: "tool_call", callId, tool,
          input: callInput(block.arguments), occurredAt, turnKey, requestKey: request.requestKey, copied }, row.raw, row.line, seq));
      }
      continue;
    }
    if (type === "assistant/attempt") {
      const stream = Array.isArray(data.stream) ? data.stream.map(object) : [];
      const reasoning = stream.filter(part => part.type === "reasoning").map(part => string(part.text) ?? string(part.delta) ?? "").filter(Boolean).join("");
      const text = stream.filter(part => part.type === "text").map(part => string(part.text) ?? string(part.delta) ?? "").filter(Boolean).join("");
      const value = reasoning || text;
      const usage = dshUsage(data.usage);
      const request = dshRequest(data, seq, row.line, true);
      records.push(normalizedRecord({ key, kind: "thinking", ...(value ? { text: value } : {}), occurredAt, turnKey, status: "unknown",
        ...request, requestTiming: header.isSeeded === true && inheritedCut === undefined ? undefined : request.requestTiming,
        usageKey: usage ? `${key}:usage` : undefined, usage, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "tool/call") {
      const callId = string(data.callId);
      if (!callId) { gaps.push({ kind: "unpaired_call", message: "DSH 工具请求缺少原生 callId", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m014" } }); continue; }
      toolNames.set(callId, toolNames.has(callId) ? undefined : string(data.name));
      records.push(normalizedRecord({ key, kind: "tool_call", callId, tool: string(data.name) ?? "unknown",
        input: callInput(data.arguments), occurredAt, turnKey, requestKey: requestByCall.get(callId), copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "tool/result") {
      const message = object(data.message);
      const content = contentBlocks(message.content);
      const legacy = content.find(block => block.type === "tool-result");
      const callId = string(message.toolCallId) ?? string(legacy?.toolCallId);
      if (!callId) { gaps.push({ kind: "unpaired_call", message: "DSH 工具结果缺少原生 callId", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m015" } }); continue; }
      const resultContent = legacy?.content ?? message.content;
      const error = message.isError === true || legacy?.isError === true;
      const tool = string(message.toolName) ?? string(legacy?.toolName) ?? toolNames.get(callId);
      const text = contentText(resultContent);
      let status: NormalizedEvent["status"] = message.isError === undefined && legacy?.isError === undefined ? "unknown" : error ? "failure" : "success";
      // Harness Bash 的 isError 表示工具异常，非零命令退出另写在末尾标记中。
      if (!error && /(?:^|\.)bash$/i.test(tool ?? "")) {
        const exit = /(?:^|\n)\[exit code: (-?\d+)\]\s*$/.exec(text);
        if (exit && Number(exit[1]) !== 0) status = "failure";
        else if (/(?:^|\n)\[(?:timed out after |stopped: |killed by signal: |still running after |sandbox:)/.test(text)) status = "unknown";
      }
      toolNames.delete(callId);
      records.push(normalizedRecord({ key, kind: "tool_result", callId, tool,
        result: data, text, occurredAt, turnKey, status, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "compaction/summary" || type === "branch_summary") {
      const summary = contentText(data.summary);
      const usage = dshUsage(data.usage);
      records.push(normalizedRecord({ key, kind: "compression", ...(summary ? { text: summary } : {}), occurredAt,
        model: string(data.model), turnKey, usageKey: usage ? `${key}:usage` : undefined, usage, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "turn/start" || type === "step/start" || type === "step/end") {
      const turn = tokenCount(data.turn);
      const step = tokenCount(data.step);
      const detail = [type, ...(turn === undefined ? [] : [`turn=${turn}`]), ...(step === undefined ? [] : [`step=${step}`])].join(" ");
      records.push(normalizedRecord({ key, kind: "context", text: `DSH 过程事件 ${detail}`, textDescriptor: { key: "sessions.body.dshEvent", params: { detail } }, occurredAt, turnKey, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "request/header" || type === "request/context") {
      records.push(normalizedRecord({ key, kind: "context", text: `DSH 过程事件 ${type}`, textDescriptor: { key: "sessions.body.dshEvent", params: { detail: type } }, occurredAt, turnKey, copied }, row.raw, row.line, seq));
      continue;
    }
    if (type === "turn/end" || type === "session/end-seed") {
      const reason = string(object(data.reason).kind);
      records.push(normalizedRecord({ key, kind: "context", ...(reason ? { text: reason } : { text: type }), occurredAt, turnKey, copied }, row.raw, row.line, seq));
      continue;
    }
    records.push(normalizedRecord({ key, kind: "context", text: `未适配事件 ${type}`, textDescriptor: { key: "sessions.body.unsupportedEvent", params: { type } }, occurredAt, turnKey, copied }, row.raw, row.line, seq));
    gaps.push({ kind: "unsupported_format", message: `DSH 事件类型 ${type} 尚未适配`, messageDescriptor: { key: "diagnostics.history.adapters.dsh.m016", params: { p0: String(type) } } });
  }
  if (version !== 3 && version !== 4) gaps.push({ kind: "unsupported_format", message: "DSH 会话头声明了尚未适配的格式代际", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m017" } });
  return normalizedSnapshot(source, records, metadata, JSON.stringify({ version, inheritedCut, relationships }));
}

const dshBaseAdapter = createNormalizedAdapter({
  id: DSH_FORMAT,
  async readSnapshot(location) { return snapshot(location); },
  async discoverFile(location) {
    const value = await snapshot(location);
    if (!value.source.sessionId) return [];
    const version = Number(/^v(\d+)$/.exec(value.source.selector ?? "")?.[1] ?? 0) || undefined;
    const complete = !value.meta.gaps?.some(gap => ["parse_error", "incomplete_record", "budget_exceeded"].includes(gap.kind));
    const fingerprint = normalizedHash(JSON.stringify(value.records.filter(row => row.record.normalizedEvent)
      .map(row => row.record.normalizedEvent)));
    return [{ ...value.source, sourceCompleteness: { version, supported: version === 3 || version === 4, complete, fingerprint } }];
  },
  selectSources(sources) {
    const groups = new Map<string, SourceLocation[]>();
    const passthrough = sources.filter(source => source.client !== "dsh" || source.format !== DSH_FORMAT || !source.sessionId);
    for (const source of sources) {
      if (source.client !== "dsh" || source.format !== DSH_FORMAT || !source.sessionId) continue;
      const key = `${source.client}:${source.sessionId}`;
      groups.set(key, [...(groups.get(key) ?? []), source]);
    }
    const selected: SourceLocation[] = [];
    for (const candidates of groups.values()) {
      const versionOf = (source: SourceLocation) => source.sourceCompleteness?.version
        ?? Number(/^v(\d+)$/.exec(source.selector ?? "")?.[1] ?? /\.v(\d+)\.jsonl(?:\.(?:zstd|zst))?$/.exec(source.path)?.[1] ?? 0);
      const rankOf = (source: SourceLocation) => {
        const supported = source.sourceCompleteness?.supported ?? [3, 4].includes(versionOf(source));
        return supported ? source.sourceCompleteness?.complete ? 3 : 2 : 1;
      };
      const ordered = [...candidates].sort((left, right) => rankOf(right) - rankOf(left)
        || versionOf(right) - versionOf(left)
        || Number(right.path.endsWith(".zstd")) - Number(left.path.endsWith(".zstd")));
      const winner = { ...ordered[0]! };
      if (ordered.length > 1) {
        const complete = ordered.filter(source => source.sourceCompleteness?.complete);
        const fingerprints = new Set(complete.map(source => source.sourceCompleteness?.fingerprint));
        const conflict = fingerprints.size > 1;
        const versions = ordered.map(source => `v${versionOf(source) || "?"}`).join(", ");
        const selectedVersion = versionOf(winner) || "unknown";
        const reason = winner.sourceCompleteness?.supported && winner.sourceCompleteness.complete
          ? "选择完整且已适配的来源"
          : winner.sourceCompleteness?.supported ? "没有完整副本，选择已适配代际"
            : "没有可用的已适配副本，保留最高可识别来源并标记缺口";
        const comparison = conflict ? "完整副本的规范化事件存在冲突"
          : complete.length > 1 ? "完整副本的规范化事件一致" : "未能在多个完整副本之间核对内容";
        const rejectedIncomplete = ordered.some(source => !source.sourceCompleteness?.complete);
        winner.adapterGap = { kind: conflict ? "ambiguous" : rejectedIncomplete ? "incomplete_record" : "ambiguous",
          message: `DSH 同身份副本 ${versions}；${reason} v${selectedVersion}；${comparison}${rejectedIncomplete ? "；不完整副本未用于覆盖完整来源" : ""}`,
          messageDescriptor: typeof selectedVersion === "number" ? { key: "diagnostics.history.adapters.dsh.copies", params: { versions, selectedVersion } } : { key: "diagnostics.history.adapters.dsh.copiesUnknownVersion", params: { versions } },
          details: [
            { key: winner.sourceCompleteness?.supported && winner.sourceCompleteness.complete ? "diagnostics.history.adapters.dsh.selectedComplete" : winner.sourceCompleteness?.supported ? "diagnostics.history.adapters.dsh.selectedSupported" : "diagnostics.history.adapters.dsh.selectedRecognizable" },
            { key: conflict ? "diagnostics.history.adapters.dsh.copiesConflict" : complete.length > 1 ? "diagnostics.history.adapters.dsh.copiesAgree" : "diagnostics.history.adapters.dsh.copiesUnverified" },
            ...(rejectedIncomplete ? [{ key: "diagnostics.history.adapters.dsh.incompleteExcluded" }] : []),
          ] };
      }
      selected.push(winner);
    }
    return [...passthrough, ...selected];
  },
  extract: dshExtract,
});

export const dshAdapter = {
  ...dshBaseAdapter,
  discover(record: Record<string, unknown>, location: SourceLocation) {
    if (record.type !== "session") return undefined;
    const version = tokenCount(record.version);
    return { source: headerSource(record, location, version), complete: true };
  },
};
