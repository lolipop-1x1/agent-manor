import { basename, dirname, isAbsolute, join } from "node:path";
import { readBoundedText } from "../../bounded-file.js";
import type { Gap } from "../../contracts.js";
import type { SourceLocation } from "../types.js";
import { changedFragments, number, object, physicalLines, returnedText, shellEvidence, string, toolEvidence, unifiedFragments } from "../extraction.js";
import { defaultToolEvidence, normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl } from "./normalized.js";
import type { NormalizedEvent, NormalizedSessionMetadata, RawHistoryRecord } from "./normalized.js";

const FORMAT = "grok-updates";
const gap = (gaps: Gap[], kind: Gap["kind"], message: string, key: string) => gaps.push({ kind, message, messageDescriptor: { key: `diagnostics.history.adapters.grok.${key}` } });
const date = (value: unknown, seconds = false): string | undefined => {
  const time = typeof value === "number" ? value * (seconds ? 1000 : 1) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
};
async function sidecar(path: string, gaps: Gap[]): Promise<{ record: Record<string, unknown>; raw: string }> {
  try {
    const raw = await readBoundedText(path, 128 * 1024 * 1024);
    try { return { record: object(JSON.parse(raw)), raw }; }
    catch { gap(gaps, "parse_error", "Grok 旁路文件尚未形成有效 JSON", "m002"); return { record: {}, raw }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EFBIG") gap(gaps, "budget_exceeded", "Grok 旁路文件超过有界读取上限", "m001");
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { record: {}, raw: "" };
  }
}
function content(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join("\n");
  const item = object(value);
  if (item.type === "content") return content(item.content);
  return string(item.text) ?? (item.content === undefined ? "" : content(item.content));
}
function responseUsage(value: unknown): NormalizedEvent["usage"] {
  const usage = object(value);
  if (!Object.keys(usage).length) return undefined;
  const input = number(usage.input_tokens);
  const cached = number(usage.cache_read_input_tokens);
  const write = number(usage.cache_creation_input_tokens);
  return { inputTokens: input === undefined ? undefined : input + (cached ?? 0) + (write ?? 0), outputTokens: number(usage.output_tokens),
    cachedInputTokens: cached, cacheWriteTokens: write, reasoningOutputTokens: number(usage.reasoning_tokens) };
}
/** ACP 结果的 diff/read 范围优先于工具标题；标题仅作为原生名称保留。 */
function extract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const input = object(inputValue); const result = object(resultValue);
  const path = string(input.path) ?? string(input.file_path) ?? string(input.target_file);
  const blocks = Array.isArray(result.content) ? result.content.map(object) : [];
  const diffs = blocks.filter(block => block.type === "diff");
  if (diffs.length) return diffs.map(diff => ({ kind: "edit", path: string(diff.path) ?? path,
    fragments: typeof diff.oldText === "string" && typeof diff.newText === "string"
      ? changedFragments(diff.oldText, diff.newText, string(diff.path) ?? path).map(fragment => ({ ...fragment, historicalStart: undefined })) : unifiedFragments(string(diff.diff) ?? "", string(diff.path) ?? path),
    reason: "range_unknown: Grok diff 未保存行号，仅保留实际变化内容", reasonDescriptor: { key: "diagnostics.history.adapters.grok.m003" } }));
  const lower = tool.toLowerCase();
  if (["bash", "shell", "shell_command", "run_shell_command", "run_terminal_command", "run_terminal_cmd"].includes(lower)) return shellEvidence(string(input.command) ?? string(input.cmd) ?? "", visible);
  if (["read", "read_file"].includes(lower) && path) {
    const file = object(object(result.rawOutput).FileContent);
    if (typeof file.raw_output === "string" && number(file.offset) !== undefined && number(file.offset)! > 0) return [{ kind: "read", path: string(file.absolute_path) ?? path,
      fragments: file.raw_output ? [{ kind: "read", content: file.raw_output, historicalStart: number(file.offset), completeLines: true }] : [] }];
    const output = returnedText(visible); const start = number(input.offset) ?? number(input.start_line) ?? 1;
    const lines = physicalLines(output.content);
    const numbered = lines.every(line => /^\s*\d+[:\t|] ?/.test(line));
    const parsed = numbered ? lines.map(line => /^(\s*)(\d+)[:\t|] ?(.*)$/.exec(line)!) : [];
    if (numbered && parsed.length && parsed.every((line, index) => Number(line[2]) === Number(parsed[0]![2]) + index)) {
      return [{ kind: "read", path, fragments: [{ kind: "read", content: parsed.map(line => line[3]).join("\n"), historicalStart: Number(parsed[0]![2]), completeLines: true }] }];
    }
    const first = /^(\d+)→(.*)$/.exec(lines[0] ?? "");
    if (first && !output.truncated) {
      const begin = Number(first[1]); let valid = true;
      const source = lines.map((line, index) => { const anchor = /^(\d+)→(.*)$/.exec(line); if (anchor && Number(anchor[1]) !== begin + index) valid = false; return anchor ? anchor[2]! : line; });
      if (valid && begin === Math.max(1, start)) return [{ kind: "read", path, fragments: [{ kind: "read", content: source.join("\n"), historicalStart: begin, completeLines: true }] }];
    }
  }
  return defaultToolEvidence(tool, typeof inputValue === "string" ? inputValue : { ...input, file_path: path }, result.rawOutput ?? resultValue, visible);
}

async function snapshot(location: SourceLocation) {
  const gaps: Gap[] = [];
  const dir = dirname(location.path);
  const summary = await sidecar(join(dir, "summary.json"), gaps);
  const usageFile = await sidecar(join(dir, "usage.json"), gaps);
  const info = object(summary.record.info);
  const rows = await readBoundedJsonl(location.path, gaps);
  const sessionId = string(info.id) ?? string(object(rows[0]?.record.params).sessionId) ?? location.sessionId ?? basename(dir);
  let cwd = normalizeHistoryPath(string(info.cwd));
  let marker = "";
  if (!cwd) try { marker = await readBoundedText(join(dirname(dir), ".cwd"), 64 * 1024); cwd = normalizeHistoryPath(marker.trim()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EFBIG") gap(gaps, "budget_exceeded", "Grok 项目标记超过有界读取上限", "m011");
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") gap(gaps, "source_unavailable", "Grok 项目标记不是可读取的普通文件", "m012"); }
  const parent = string(summary.record.parent_session_id);
  const relationship = string(summary.record.session_kind)?.startsWith("subagent") ? "child" : "fork";
  const inherited = new Set<string>(); let parentFingerprint = "";
  if (parent && parent !== sessionId && !parent.includes("/") && !parent.includes("\\")) {
    try {
      const parentRows = await readBoundedJsonl(join(dirname(dir), parent, "updates.jsonl"), []);
      parentFingerprint = parentRows.map(row => row.raw).join("\n");
      for (const row of parentRows) { const id = string(object(object(row.record.params)._meta).eventId); if (id) inherited.add(id); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; gap(gaps, "source_missing", "Grok 父会话来源缺失，无法核验继承记录", "m004"); }
  }
  const meta: NormalizedSessionMetadata = { gaps, title: string(summary.record.generated_title) ?? string(summary.record.session_summary),
    ...(parent ? { parentSessionId: parent, relationship, relationships: [{ kind: relationship === "child" ? "subagent" : "fork", parentSessionId: parent,
      copiedRecordIdentityHashes: [...inherited].map(normalizedHash) }] } : {}) };
  const records: RawHistoryRecord[] = [];
  const seen = new Map<string, string>(); const tools = new Map<string, { request?: RawHistoryRecord; fields: Record<string, unknown>; result?: RawHistoryRecord }>();
  const promptTurns: string[] = []; const removed = new Set<string>();
  const responses = new Map<string, { start: RawHistoryRecord; input: Record<string, unknown>; event?: NormalizedEvent }>();
  let prompt = ""; let model = string(summary.record.current_model_id); let activeResponse: string | undefined;
  let segment: { kind: NormalizedEvent["kind"]; turn: string; response?: string; event: NormalizedEvent } | undefined;
  const emit = (event: NormalizedEvent, row: RawHistoryRecord) => {
    const normalized = normalizedRecord(event, row.raw, row.line); records.push(normalized); return normalized.record.normalizedEvent as NormalizedEvent;
  };
  for (const row of rows) {
    const envelope = row.record; const params = object(envelope.params ?? envelope); const update = object(params.update); const native = object(params._meta);
    const type = string(update.sessionUpdate); const identity = string(native.eventId);
    if (identity && seen.has(identity)) {
      if (seen.get(identity) !== row.raw) gap(gaps, "ambiguous", "Grok 事件身份对应冲突内容，保留首次记录", "m005");
      continue;
    }
    if (identity) seen.set(identity, row.raw);
    const copied = identity ? inherited.has(identity) : false;
    const occurredAt = date(native.agentTimestampMs) ?? date(envelope.timestamp, true);
    const key = identity ?? `line:${row.line}`;
    const explicitPrompt = string(native.promptId) ?? string(update.prompt_id);
    if (explicitPrompt) prompt = explicitPrompt;
    const base = { occurredAt, turnKey: prompt || undefined, model, copied, nativeIdentityHash: identity ? normalizedHash(identity) : undefined };
    if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(type ?? "")) {
      const kind = type === "user_message_chunk" ? "user" : type === "agent_message_chunk" ? "assistant" : "thinking";
      if (kind === "user") {
        if (!explicitPrompt && segment?.kind !== "user") prompt = `prompt:${key}`;
        if (!promptTurns.includes(prompt)) promptTurns.push(prompt);
      }
      const turnKey = prompt || undefined; const text = content(update.content);
      if (segment?.kind === kind && segment.turn === prompt && segment.response === activeResponse) segment.event.text = (segment.event.text ?? "") + text;
      else {
        const event = emit({ ...base, key: `grok:${key}`, kind, text, turnKey, allowInferredFinal: false,
          requestKey: kind !== "user" && activeResponse ? `grok:response:${activeResponse}` : undefined }, row);
        segment = { kind, turn: prompt, response: activeResponse, event };
        if (activeResponse && kind === "assistant") responses.get(activeResponse)!.event = event;
      }
      continue;
    }
    segment = undefined;
    if (type === "response_started") {
      const id = string(update.message_id);
      if (id) { activeResponse = id; responses.set(id, { start: row, input: update }); }
      else { activeResponse = undefined; gap(gaps, "ambiguous", "Grok 响应缺少原生请求身份，未构造请求分母", "m006"); }
      continue;
    }
    if (type === "response_completed") {
      const id = string(update.message_id) ?? activeResponse; const response = id ? responses.get(id) : undefined;
      const usage = responseUsage(update.usage ?? response?.input); const stop = string(update.stop_reason);
      const event = response?.event;
      emit({ ...base, key: `grok:${key}`, kind: "context", text: stop ?? type, requestKey: id ? `grok:response:${id}` : undefined,
        usageKey: id ? `grok:response:${id}` : undefined, usageMessageKey: event?.key, usage,
        interrupted: stop && !["end_turn", "tool_use", "stop_sequence"].includes(stop) ? true : undefined }, row);
      activeResponse = undefined; continue;
    }
    if (type === "tool_call" || type === "tool_call_update") {
      const callId = string(update.toolCallId);
      if (!callId) { gap(gaps, "unpaired_call", "Grok 工具记录缺少原生调用身份", "m007"); continue; }
      const value = tools.get(callId) ?? { fields: {} }; value.fields = { ...value.fields, ...update };
      if (type === "tool_call" && !value.request) {
        const tool = string(object(object(update._meta)["x.ai/tool"]).name) ?? string(update.title) ?? "unknown";
        const event = emit({ ...base, key: `grok:call:${callId}`, kind: "tool_call", callId, tool, input: update.rawInput,
          filePaths: Array.isArray(update.locations) ? update.locations.map(item => string(object(item).path)).filter((path): path is string => Boolean(path)) : undefined }, row);
        value.request = { ...row, record: { normalizedEvent: event } };
      }
      const request = value.request?.record.normalizedEvent as NormalizedEvent | undefined;
      if (request) { request.input = value.fields.rawInput; request.tool = string(object(object(value.fields._meta)["x.ai/tool"]).name) ?? request.tool; }
      if (["completed", "failed", "cancelled"].includes(string(value.fields.status) ?? "")) {
        const event: NormalizedEvent = { ...base, key: `grok:result:${callId}`, kind: "tool_result", callId, tool: request?.tool,
          result: value.fields, text: content(value.fields.content) || content(value.fields.rawOutput),
          status: value.fields.status === "completed" ? "success" : value.fields.status === "failed" ? "failure" : "unknown" };
        if (value.result) { value.result.record = normalizedRecord(event, row.raw, row.line).record; value.result.raw = row.raw; value.result.line = row.line; }
        else { value.result = normalizedRecord(event, row.raw, row.line); records.push(value.result); }
      }
      tools.set(callId, value); continue;
    }
    if (type === "turn_completed") {
      const stopped = string(update.stop_reason); const complete = ["end_turn", "stop", "stop_sequence"].includes(stopped ?? "");
      const candidate = [...records].reverse().map(record => record.record.normalizedEvent as NormalizedEvent).find(event => event.kind === "assistant" && event.turnKey === prompt && !event.copied);
      if (complete && candidate) { candidate.final = "explicit"; candidate.finalEvidence = "normal_stop"; candidate.finalAt = occurredAt; }
      emit({ ...base, key: `grok:${key}`, kind: "context", text: stopped ?? type, interrupted: !complete || undefined }, row);
      if (update.usage) {
        const usage = object(update.usage); const totals = object(usage.totals);
        meta.usageReports = [...(meta.usageReports ?? []), { scope: "turn", nativeId: prompt, turnKey: prompt, model,
          inputTokens: number(totals.input_tokens), outputTokens: number(totals.output_tokens), cachedInputTokens: number(totals.cached_read_tokens),
          cacheWriteTokens: number(totals.cache_creation_tokens), reasoningOutputTokens: number(totals.reasoning_tokens), nativeModelCalls: number(totals.model_calls),
          reportedCostUsd: number(totals.cost_usd_ticks) === undefined ? undefined : number(totals.cost_usd_ticks)! / 1e10, occurredAt }];
      }
      continue;
    }
    if (type === "rewind_marker") {
      const target = number(update.target_prompt_index);
      if (Number.isSafeInteger(target) && target! >= 0 && target! <= promptTurns.length) {
        for (const turn of promptTurns.splice(target!)) removed.add(turn);
        prompt = promptTurns.at(-1) ?? ""; activeResponse = undefined;
      } else gap(gaps, "ambiguous", "Grok 回退下标超出当前时间线，未猜测范围", "m013");
      emit({ ...base, key: `grok:${key}`, kind: "context", text: type }, row); continue;
    }
    if (type?.startsWith("auto_compact")) {
      emit({ ...base, key: `grok:${key}`, kind: "compression", text: string(update.summary_preview) ?? string(update.reason) ?? string(update.error) ?? type,
        status: type === "auto_compact_failed" ? "failure" : type === "auto_compact_completed" ? "success" : "unknown" }, row); continue;
    }
    if (type === "subagent_spawned") {
      const child = string(update.subagent_id); if (child) meta.childSessionIds = [...new Set([...(meta.childSessionIds ?? []), child])];
    }
    if (type === "model_changed") model = string(update.model_id) ?? model;
    emit({ ...base, key: `grok:${key}`, kind: "context", text: type ?? "unknown", interrupted: type === "retry_state" && update.state === "failed" ? true : undefined }, row);
    if (!type) gap(gaps, "unsupported_format", "Grok 更新日志含无法识别的事件", "m009");
  }
  if (removed.size) {
    meta.branches = [{ id: "current", label: "当前分支", current: true, labelDescriptor: { key: "sessions.branch.current" } },
      { id: "rewound", label: "分支 2", current: false, labelDescriptor: { key: "sessions.branch.number", params: { number: 2 } } }];
    for (const row of records) { const event = row.record.normalizedEvent as NormalizedEvent; event.currentBranch = !removed.has(event.turnKey ?? ""); event.branchIds = [event.currentBranch ? "current" : "rewound"]; }
  }
  if (Object.keys(usageFile.record).length) {
    emit({ key: "grok:usage-summary", kind: "context", text: "会话累计用量", textDescriptor: { key: "diagnostics.history.adapters.grok.m010" } }, { record: usageFile.record, raw: usageFile.raw, line: rows.length + 1 });
    const total = object(usageFile.record.session);
    meta.usageReports = [...(meta.usageReports ?? []), { scope: "session", nativeId: sessionId, model: string(total.primaryModelId), occurredAt: date(usageFile.record.updatedAt),
      inputTokens: number(total.inputTokens), outputTokens: number(total.outputTokens), cachedInputTokens: number(total.cachedReadTokens),
      cacheWriteTokens: number(total.cacheCreationTokens), reasoningOutputTokens: number(total.reasoningTokens), nativeModelCalls: number(total.modelCalls),
      reportedCostUsd: number(total.costUsdTicks) === undefined ? undefined : number(total.costUsdTicks)! / 1e10 }];
  }
  return normalizedSnapshot({ ...location, format: FORMAT, sessionId, cwd, parentSessionId: parent }, records, meta, [summary.raw, usageFile.raw, marker, parentFingerprint].join("\u0000"));
}

export function grokHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const override = environment.GROK_HOME?.trim(); const root = override?.startsWith("~/") ? join(home, override.slice(2)) : override ?? join(home, ".grok");
  return isAbsolute(root) ? [join(root, "sessions")] : [];
}
export const grokAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract });
