import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Gap } from "../../contracts.js";
import type { SessionRequestTiming } from "../../session-contracts.js";
import { changedFragments, number, object, shellEvidence, string, textContent, toolEvidence, unifiedFragments } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl, type NormalizedEvent, type NormalizedSnapshot, type RawHistoryRecord } from "./normalized.js";

const FORMAT = "kimi-wire";
type Row = RawHistoryRecord;
const diagnostic = (id: number) => ({ key: `diagnostics.history.adapters.kimi.m${String(id).padStart(3, "0")}` });
function gap(gaps: Gap[], kind: Gap["kind"], id: number, message: string) { gaps.push({ kind, message, messageDescriptor: diagnostic(id) }); }
function time(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function count(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }
function usage(value: unknown): NormalizedEvent["usage"] {
  const native = object(value); const input = count(native.inputOther); const cached = count(native.inputCacheRead); const write = count(native.inputCacheCreation); const output = count(native.output);
  const result = { ...(input !== undefined && cached !== undefined && write !== undefined ? { inputTokens: input + cached + write } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(write !== undefined ? { cacheWriteTokens: write } : {}) };
  return Object.keys(result).length ? result : undefined;
}
function content(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(part => string(object(part).text) ?? "").join("") : "";
}
function input(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function userOrigin(value: unknown): boolean {
  const origin = object(value);
  return origin.kind === undefined || origin.kind === "user"
    || ["skill_activation", "plugin_command"].includes(string(origin.kind) ?? "") && origin.trigger === "user-slash"
    || origin.kind === "shell_command" && origin.phase === "input";
}
export function kimiHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  return [join(environment.KIMI_CODE_HOME ?? join(home, ".kimi-code"), "sessions")];
}
async function optionalJson(path: string, gaps: Gap[]): Promise<{ value: Record<string, unknown>; raw: string }> {
  try { const raw = await readFile(path, "utf8"); return { value: object(JSON.parse(raw)), raw }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") gap(gaps, "parse_error", 1, "Kimi 会话元信息无法解析");
    return { value: {}, raw: "" };
  }
}

/** 新版 wire 按明确切换边连接日志段；旧兼容 undo 与对应切换边只解释一次。 */
function wireBranches(rows: Row[], gaps: Gap[]) {
  type Segment = { id: string; start: number; end: number; base?: { id: string; line: number } };
  const segments = new Map<string, Segment>(); const paired = new Set<number>();
  let current: Segment = { id: "main", start: 1, end: rows.at(-1)?.line ?? 0 }; segments.set(current.id, current);
  for (const row of rows) {
    if (row.record.type !== "agent.switched") continue;
    const base = object(row.record.base); const id = string(row.record.branch); const baseId = string(base.branch); const line = count(base.line);
    if (!id || !baseId || line === undefined || line >= row.line || !segments.has(baseId) || segments.has(id)) {
      gap(gaps, "ambiguous", 2, "Kimi 分支切换的身份或父边无法核验"); continue;
    }
    current.end = row.line;
    current = { id, start: row.line + 1, end: rows.at(-1)?.line ?? row.line, base: { id: baseId, line } }; segments.set(id, current);
    const undoLine = count(row.record.legacyUndoLine);
    if (undoLine !== undefined && rows.some(item => item.line === undoLine && item.record.type === "context.undo")) paired.add(undoLine);
  }
  const paths = new Map<string, Row[]>();
  for (const segment of segments.values()) {
    const chain: Row[] = []; const visited = new Set<string>();
    const walk = (part: Segment, ceiling = part.end): void => {
      if (visited.has(part.id)) { gap(gaps, "parse_error", 3, "Kimi 分支父边包含循环"); return; }
      visited.add(part.id);
      if (part.base) { const parent = segments.get(part.base.id); if (parent) walk(parent, part.base.line); }
      chain.push(...rows.filter(row => row.line >= part.start && row.line <= ceiling && row.record.type !== "agent.switched" && !paired.has(row.line)));
    };
    walk(segment);
    // 无配对切换边的 undo 仍按用户锚点回退，并禁止跨压缩边界猜测。
    const active: Row[] = [];
    for (const row of chain) {
      if (row.record.type === "context.undo") {
        const amount = count(row.record.count); let remaining = amount ?? 0; let cut = -1;
        for (let index = active.length - 1; index >= 0 && remaining > 0; index--) {
          const candidate = active[index]!.record;
          if (candidate.type === "context.apply_compaction" || candidate.type === "context.clear") break;
          const message = object(candidate.message);
          if (candidate.type === "context.append_message" && message.role === "user" && userOrigin(message.origin)) { remaining--; cut = index; }
        }
        if (amount && remaining === 0 && cut >= 0) {
          paths.set(`${segment.id}:undo:${row.line}`, [...active]);
          active.splice(cut);
        }
        else gap(gaps, "ambiguous", 4, "Kimi undo 缺少足够的用户锚点，未猜测回退范围");
      } else active.push(row);
    }
    paths.set(segment.id, active);
  }
  return { paths, current: current.id };
}

function kimiExtract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const call = object(input(inputValue)); const result = object(resultValue); const path = string(call.path);
  const missing = (kind: "read" | "edit" | "other", id: number, message: string) => [{ kind, path, fragments: [], reason: `range_unknown: ${message}`, reasonDescriptor: diagnostic(id) }];
  if (result.isError === true) return missing(tool === "Read" ? "read" : ["Edit", "Write"].includes(tool) ? "edit" : "other", 5, "Kimi 工具执行失败，未提取代码范围");
  if (tool === "Read") {
    const note = string(result.note) ?? "";
    if (!path || /Lossy UTF-16|Line \d+ fragment:|Mixed or lone carriage-return/.test(note) || number(call.column_offset)) return missing("read", 6, "Kimi Read 返回列片段或有损内容，完整行未确认");
    const text = typeof result.output === "string" ? result.output : visible;
    const lines = text.split(/\r?\n/); const numbered = lines.map(line => /^(\d+)\t(.*)$/.exec(line));
    const declared = /^(?:<system>)?(\d+) lines? read from file starting from line (\d+)\./.exec(note);
    if (!declared || Number(declared[1]) !== numbered.length || numbered.some((line, index) => !line || Number(line[1]) !== Number(declared[2]) + index)) return missing("read", 7, "Kimi Read 实际行号与原生返回范围不能校验");
    return [{ kind: "read", path, fragments: [{ kind: "read", content: numbered.map(line => line![2]).join("\n"), historicalStart: Number(declared[2]), completeLines: true }],
      ...(/Character limit reached/.test(note) ? { reason: "range_unknown: Kimi Read 仅保存返回窗口", reasonDescriptor: diagnostic(8) } : {}) }];
  }
  if (tool === "Write") {
    const text = content(result.output); const written = /^Wrote (\d+) bytes to /.exec(text); const body = string(call.content);
    if (!path || !written || body === undefined || Buffer.byteLength(body) !== Number(written[1]) || call.mode === "append") return missing("edit", 9, "Kimi Write 未确认覆盖内容或追加位置");
    return [{ kind: "edit", path, fragments: body ? [{ kind: "added", content: body, historicalStart: 1, completeLines: true, path }] : [] }];
  }
  if (tool === "Edit") {
    const patch = string(result.patch) ?? string(result.diff);
    if (patch) return [{ kind: "edit", path, fragments: unifiedFragments(patch, path) }];
    const before = string(call.old_string); const after = string(call.new_string);
    if (!/^Replaced \d+ occurrences? in /.test(content(result.output)) || before === undefined || after === undefined) return missing("edit", 10, "Kimi Edit 缺少实际成功结果");
    return [{ kind: "edit", path, fragments: changedFragments(before, after, path).map(fragment => ({ ...fragment, historicalStart: undefined })), reason: "range_unknown: Kimi Edit 未保存实际修改行号", reasonDescriptor: diagnostic(11) }];
  }
  if (tool === "Bash") {
    const output = content(result.output);
    if (result.isError !== false || /task_id:|artifact:\/\/|<system>.*truncat|output.{0,20}truncated/is.test(output + (string(result.note) ?? ""))) return missing("other", 12, "Kimi Bash 未确认完整的成功输出");
    return shellEvidence(string(call.command) ?? "", output);
  }
  return toolEvidence(tool, call, result, visible);
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = []; const rows = await readBoundedJsonl(location.path, gaps, createReadStream(location.path));
  const agentDir = dirname(location.path); const agentId = basename(agentDir); const sessionDir = basename(dirname(agentDir)) === "agents" ? dirname(dirname(agentDir)) : undefined;
  const state = sessionDir ? await optionalJson(join(sessionDir, "state.json"), gaps) : { value: {}, raw: "" };
  const nativeSessionId = string(state.value.id) ?? (sessionDir ? basename(sessionDir) : undefined);
  const id = nativeSessionId ? agentId === "main" ? nativeSessionId : `${nativeSessionId}/agent/${agentId}` : location.sessionId;
  if (!id) gap(gaps, "source_missing", 13, "Kimi wire 缺少可核验会话身份");
  const header = rows[0]?.record; const version = string(header?.protocol_version) ?? "1.4";
  if (header?.type !== "metadata" || !/^1\.[0-5]$/.test(version)) {
    gap(gaps, "unsupported_format", 14, "Kimi wire 缺少新版元信息或协议版本不受支持");
    return normalizedSnapshot({ ...location, format: FORMAT, sessionId: id }, [], { gaps }, state.raw);
  }
  const agentMeta = object(object(state.value.agents)[agentId]); const forkId = string(state.value.forkedFrom); const forkAgentId = string(agentMeta.forkedFrom);
  const parentAgentId = string(agentMeta.parentAgentId); const parentId = parentAgentId && nativeSessionId
    ? parentAgentId === "main" ? nativeSessionId : `${nativeSessionId}/agent/${parentAgentId}`
    : forkAgentId && nativeSessionId ? forkAgentId === "main" ? nativeSessionId : `${nativeSessionId}/agent/${forkAgentId}` : forkId;
  const parentKind = parentAgentId ? "child" as const : forkId || forkAgentId ? "fork" as const : undefined;
  const source = { ...location, format: FORMAT, sessionId: id, cwd: normalizeHistoryPath(string(state.value.cwd)), parentSessionId: parentId };
  const accepted = rows.slice(1).filter(row => row.record.agentId === undefined || row.record.agentId === agentId);
  const tree = wireBranches(accepted, gaps); const membership = new Map<number, string[]>();
  for (const [branch, chain] of tree.paths) for (const row of chain) membership.set(row.line, [...(membership.get(row.line) ?? []), branch]);
  const inherited = new Set<string>(); const inheritedMessages = new Set<string>(); let parentFingerprint = "";
  const safeId = (value: string | undefined) => value && basename(value) === value && value !== "." && value !== "..";
  if ((safeId(forkId) || safeId(forkAgentId)) && sessionDir) {
    const parentPath = forkAgentId ? join(sessionDir, "agents", forkAgentId, "wire.jsonl") : join(dirname(sessionDir), forkId!, "agents", agentId, "wire.jsonl");
    try {
      const parentRows = await readBoundedJsonl(parentPath, [], createReadStream(parentPath));
      parentFingerprint = parentRows.map(row => row.raw).join("\n");
      if (forkAgentId) for (const parentRow of parentRows) {
        const messageId = string(object(parentRow.record.message).id);
        if (parentRow.record.type === "context.append_message" && messageId) inheritedMessages.add(messageId);
      }
      // forkedFrom 是复制依据；只去除完整相同的前缀，不以正文相似度猜测。
      for (let index = 1; index < Math.min(rows.length, parentRows.length); index++) {
        if (rows[index]!.raw !== parentRows[index]!.raw) break;
        inherited.add(normalizedHash(rows[index]!.raw));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      gap(gaps, "source_missing", 15, "Kimi fork 父来源缺失，复制边界未核验");
    }
  }
  const events: { event: NormalizedEvent; row: Row }[] = []; const byKey = new Map<string, { event: NormalizedEvent; row: Row }>();
  let turnKey: string | undefined; let stepKey: string | undefined; let requestKey: string | undefined; let requestStart: Row | undefined;
  let model: string | undefined; let provider: string | undefined; let reasoningEffort: string | undefined;
  const assistantByTurn = new Map<string, { event: NormalizedEvent; row: Row }>(); const callTurns = new Map<string, string | undefined>();
  const turnByNumber = new Map<string, string>(); const promptIds = new Map<string, string>();
  const add = (row: Row, event: NormalizedEvent) => {
    const branches = membership.get(row.line) ?? [];
    const value = { event: { occurredAt: time(row.record.time), turnKey, model, reasoningEffort, branchIds: branches,
      currentBranch: branches.includes(tree.current), copied: inherited.has(normalizedHash(row.raw)) || undefined,
      nativeOrdinal: row.line, nativeIdentityHash: normalizedHash(row.raw), ...event }, row };
    if (row.record.type === "context.append_message" && inheritedMessages.has(string(object(row.record.message).id) ?? "")) value.event.copied = true;
    const previous = byKey.get(event.key);
    if (previous) { gap(gaps, "ambiguous", 16, "Kimi 记录身份重复，保留首次规范化记录"); return previous; }
    byKey.set(event.key, value); events.push(value); return value;
  };
  const assistant = (row: Row, key: string, text: string, extra: Partial<NormalizedEvent> = {}) => {
    const value = add(row, { key, kind: "assistant", text, allowInferredFinal: false, requestKey, ...extra });
    if (value.event.turnKey) assistantByTurn.set(value.event.turnKey, value); return value;
  };
  for (const row of accepted) {
    const record = row.record; const kind = string(record.type) ?? ""; const rowKey = `kimi:${row.line}`;
    if (kind === "turn.prompt" || kind === "turn.steer") {
      const promptId = string(record.promptId) ?? string(record.messageId); const assigned = count(record.turnId);
      if (userOrigin(record.origin)) turnKey = promptId ? `prompt:${promptId}` : `turn:${row.line}`;
      if (assigned !== undefined && turnKey) turnByNumber.set(String(assigned), turnKey);
      if (promptId && turnKey) promptIds.set(promptId, turnKey);
      add(row, { key: rowKey, kind: "context", text: content(record.input) }); continue;
    }
    if (kind === "context.append_message") {
      const message = object(record.message); const origin = object(message.origin); const role = string(message.role);
      const messageId = string(message.id); const key = messageId ? `kimi:message:${messageId}` : rowKey;
      if (role === "user" && userOrigin(origin)) {
        turnKey = messageId && promptIds.get(messageId) || `message:${messageId ?? row.line}`;
        const skillPath = string(origin.skillPath); const skillName = string(origin.skillName);
        add(row, { key, kind: "user", text: content(message.content), turnKey,
          ...(origin.kind === "skill_activation" && skillPath && skillName ? { resource: { kind: "skill_read" as const, path: skillPath, name: skillName }, status: "success" as const } : {}) });
      } else if (role === "assistant") {
        const responseId = string(message.providerMessageId); requestKey = responseId ? `kimi:response:${responseId}` : key;
        assistant(row, key, content(message.content), { usage: usage(message.usage), usageKey: `${requestKey}:usage`, interrupted: message.partial === true });
        for (const [index, callValue] of (Array.isArray(message.toolCalls) ? message.toolCalls : []).entries()) {
          const call = object(callValue); const callId = string(call.id); if (!callId) continue;
          callTurns.set(callId, turnKey); add(row, { key: `${key}:call:${index}`, kind: "tool_call", callId, tool: string(call.name), input: input(call.arguments), requestKey });
        }
      } else if (role === "tool") {
        const callId = string(message.toolCallId); add(row, { key, kind: "tool_result", callId, turnKey: callId ? callTurns.get(callId) : turnKey,
          text: content(message.content), result: { output: message.content, isError: message.isError, note: message.note }, status: message.isError === true ? "failure" : "success" });
      } else add(row, { key, kind: origin.kind === "compaction_summary" ? "compression" : role === "system" ? "system" : "context", text: content(message.content) });
      continue;
    }
    if (kind === "llm.request") {
      model = string(record.model); provider = string(record.provider); reasoningEffort = string(record.thinkingEffort);
      requestKey = `kimi:request:${row.line}`; requestStart = row;
      add(row, { key: rowKey, kind: "context", text: string(record.kind), requestKey }); continue;
    }
    if (kind === "usage.record") {
      // usage.record 是每次完成调用的持久投影，step.end 会重复同一调用的桶；共用请求身份。
      const nativeUsage = usage(record.usage); const request = requestKey ?? `kimi:usage-record:${row.line}`;
      add(row, { key: rowKey, kind: "context", text: string(record.usageScope), model: requestKey ? model : string(record.model),
        requestKey: request, usageKey: `${request}:usage`, usage: nativeUsage ? { ...nativeUsage, provider } : undefined,
        usageMessageKey: turnKey ? assistantByTurn.get(turnKey)?.event.key : undefined });
      continue;
    }
    if (kind === "context.append_loop_event") {
      const event = object(record.event); const eventKind = string(event.type); const eventId = string(event.uuid);
      const numberTurn = string(event.turnId); if (numberTurn && turnByNumber.has(numberTurn)) turnKey = turnByNumber.get(numberTurn);
      if (eventKind === "step.begin") {
        stepKey = eventId; requestKey = undefined; requestStart = undefined;
        add(row, { key: rowKey, kind: "context", text: "step.begin" }); continue;
      }
      if (eventKind === "content.part" || eventKind === "tool.call") {
        if (!stepKey || event.stepUuid !== stepKey) { gap(gaps, "ambiguous", 17, "Kimi loop 事件没有可配对的 step 身份"); continue; }
        requestKey ??= `kimi:step:${stepKey}`;
        const key = eventId ? `kimi:loop:${eventId}` : rowKey;
        if (eventKind === "content.part") {
          const part = object(event.part);
          if (part.type === "text") assistant(row, key, string(part.text) ?? "");
          else if (part.type === "think") add(row, { key, kind: "thinking", text: string(part.think), requestKey });
          else add(row, { key, kind: "context", text: string(part.type) });
        } else {
          const callId = string(event.toolCallId); if (callId) callTurns.set(callId, turnKey);
          add(row, { key, kind: "tool_call", callId, tool: string(event.name), input: event.args, requestKey });
        }
        continue;
      }
      if (eventKind === "tool.result") {
        const result = object(event.result); const callId = string(event.toolCallId);
        add(row, { key: rowKey, kind: "tool_result", callId, text: content(result.output), result,
          turnKey: callId ? callTurns.get(callId) : turnKey, status: result.isError === true ? "failure" : "success", durationMs: number(result.durationMs) }); continue;
      }
      if (eventKind === "step.end") {
        if (!stepKey || eventId !== stepKey) { gap(gaps, "ambiguous", 17, "Kimi loop 事件没有可配对的 step 身份"); continue; }
        requestKey ??= `kimi:step:${stepKey}`;
        const reason = string(event.finishReason); const partial = ["error", "interrupted", "length", "max_tokens", "filtered", "paused"].includes(reason ?? "");
        const completed = ["end_turn", "stop", "tool_calls", "tool_use"].includes(reason ?? "");
        const end = time(record.time); const start = time(requestStart?.record.time);
        const timing: SessionRequestTiming = { basis: "recorded", method: "kimi_wire_request", window: "response", completion: partial ? "partial" : completed ? "explicit" : "unknown",
          ...(completed ? { completionEvidence: "stop_reason" as const } : partial ? { completionEvidence: "request_interrupted" as const } : {}),
          ...(start && requestStart ? { start: { occurredAt: start, recordLine: requestStart.line } } : {}),
          ...(end ? { end: { occurredAt: end, recordLine: row.line } } : {}), ...(start && end && end >= start ? { durationMs: Date.parse(end) - Date.parse(start) } : {}) };
        const last = turnKey ? assistantByTurn.get(turnKey) : undefined;
        const nativeUsage = usage(event.usage);
        add(row, { key: rowKey, kind: "context", text: reason, requestKey, requestTiming: timing, interrupted: partial || undefined,
          usage: nativeUsage ? { ...nativeUsage, provider } : undefined, usageKey: `${requestKey}:usage`, usageMessageKey: last?.event.key });
        stepKey = undefined; continue;
      }
      gap(gaps, "unsupported_format", 18, "Kimi loop 包含尚未适配的事件类型"); add(row, { key: rowKey, kind: "context", text: eventKind }); continue;
    }
    if (kind === "turn.ended" || kind === "turn.cancel") {
      const owner = turnByNumber.get(String(record.turnId)) ?? turnKey; const last = owner ? assistantByTurn.get(owner) : undefined;
      const reason = string(record.reason);
      if (last && kind === "turn.ended" && reason === "completed") {
        last.event.final = "explicit"; last.event.finalEvidence = "response_completed"; last.event.finalAt = time(record.time);
      }
      const interrupted = kind === "turn.cancel" || ["failed", "cancelled", "blocked"].includes(reason ?? "");
      add(row, { key: rowKey, kind: "context", text: reason ?? kind, turnKey: owner, interrupted: interrupted || undefined }); continue;
    }
    if (kind === "context.apply_compaction") {
      const summary = typeof record.summary === "string" ? record.summary : string(record.contextSummary) ?? content(object(record.summary).content);
      add(row, { key: rowKey, kind: "compression", text: summary }); continue;
    }
    if (["context.undo", "context.undone", "context.clear", "agent.switched", "agent.forked", "tools.update_store", "llm.tools_snapshot"].includes(kind)) { add(row, { key: rowKey, kind: "context", text: kind }); continue; }
    add(row, { key: rowKey, kind: "context", text: kind }); gap(gaps, "unsupported_format", 19, "Kimi wire 包含尚未适配的原生事件");
  }
  const childIds = Object.entries(object(state.value.agents)).filter(([child, value]) => child !== agentId && object(value).parentAgentId === agentId).map(([child]) => `${nativeSessionId}/agent/${child}`);
  return normalizedSnapshot(source, events.map(({ event, row }) => normalizedRecord(event, row.raw, row.line)), {
    title: string(state.value.title), titleOrigin: "recorded", parentSessionId: parentId, relationship: parentKind, childSessionIds: childIds,
    relationships: parentId && parentKind ? [{ kind: parentKind === "child" ? "subagent" : "fork", parentSessionId: parentId,
      ...(parentKind === "child" ? { agentId } : inherited.size ? { copiedRecordIdentityHashes: [...inherited] } : {}) }] : [],
    branches: [...tree.paths.keys()].map((branch, index) => ({ id: branch, current: branch === tree.current, label: branch === tree.current ? "当前分支" : `分支 ${index + 1}`,
      labelDescriptor: { key: branch === tree.current ? "sessions.branch.current" : "sessions.branch.number", params: { number: index + 1 } } })), gaps,
  }, `${state.raw}\n${parentFingerprint}`);
}

export const kimiAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract: kimiExtract });
