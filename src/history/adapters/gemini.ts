import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Gap } from "../../contracts.js";
import { changedFragments, object, physicalLines, shellEvidence, string, toolEvidence, unifiedFragments, type ToolEvidence } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { absoluteDirectory, addGap, eventTime, readJsonlRows, sourceFor, textOf, tokenValue } from "./native-jsonl.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, type NormalizedEvent, type NormalizedSnapshot, type RawHistoryRecord } from "./normalized.js";

const FORMAT = "gemini-jsonl";
type MessageState = { value: Record<string, unknown>; row: RawHistoryRecord; contentRow: RawHistoryRecord; resultRows: Map<string, RawHistoryRecord> };

/** 原生 home 覆盖替代用户目录；同时发现普通与 Seatbelt 留存的历史。 */
export function geminiHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const nativeHome = environment.GEMINI_CLI_HOME || home;
  return [join(nativeHome, ".gemini", "tmp"), join(nativeHome, ".cache", ".gemini", "tmp")];
}

export const acceptsGeminiHistoryFile = (path: string): boolean => path.endsWith(".jsonl") && path.split(/[\\/]/).includes("chats");

function gap(gaps: Gap[], kind: Gap["kind"], message: string, key: string): void {
  addGap(gaps, kind, message, { key: `diagnostics.history.adapters.gemini.${key}` });
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function projectMetadata(path: string, gaps: Gap[]): Promise<{ cwd?: string; parentSessionId?: string; fingerprint: string }> {
  let chats = dirname(path);
  while (basename(chats) !== "chats" && dirname(chats) !== chats) chats = dirname(chats);
  if (basename(chats) !== "chats") return { fingerprint: "" };
  const project = dirname(chats);
  const marker = await optionalText(join(project, ".project_root"));
  const registry = await optionalText(join(dirname(dirname(project)), "projects.json"));
  const root = absoluteDirectory(marker?.trim());
  const registered: string[] = [];
  if (registry !== undefined) {
    try {
      const projects = object(object(JSON.parse(registry)).projects);
      for (const [cwd, id] of Object.entries(projects)) if (id === basename(project) && isAbsolute(cwd)) registered.push(cwd);
    } catch { gap(gaps, "parse_error", "Gemini 项目登记文件不是有效 JSON", "m001"); }
  }
  const candidates = [...new Set([...registered, ...(root ? [root] : [])])];
  if (candidates.length > 1) gap(gaps, "ambiguous", "Gemini 项目登记与目录标记的路径冲突，未猜测项目", "m002");
  return { cwd: candidates.length === 1 ? candidates[0] : undefined,
    parentSessionId: dirname(path) !== chats && dirname(dirname(path)) === chats ? basename(dirname(path)) : undefined,
    fingerprint: JSON.stringify([marker, registry]) };
}

function parts(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).map(item => typeof item === "string" ? { text: item } : object(item));
}

function responseText(value: unknown): string {
  return parts(value).map(part => {
    const response = object(object(part.functionResponse).response);
    return string(response.output) ?? string(response.error) ?? string(part.text) ?? "";
  }).filter(Boolean).join("\n");
}

function usage(value: unknown, gaps: Gap[]): NormalizedEvent["usage"] {
  const tokens = object(value);
  if (!Object.keys(tokens).length) return undefined;
  const input = tokenValue(tokens.input); const output = tokenValue(tokens.output); const thoughts = tokenValue(tokens.thoughts);
  const cached = tokenValue(tokens.cached);
  gap(gaps, "ambiguous", "Gemini 用量是留存响应流汇总；零值可能来自源端缺失兜底，实际请求覆盖未知", "m003");
  return { inputTokens: input, outputTokens: output !== undefined && thoughts !== undefined ? output + thoughts : undefined,
    cachedInputTokens: cached !== undefined && (input === undefined || cached <= input) ? cached : undefined,
    reasoningOutputTokens: thoughts };
}

function resultResponse(call: Record<string, unknown>): Record<string, unknown> {
  const matching = parts(call.result).find(part => object(part.functionResponse).id === call.id);
  return object(object(matching?.functionResponse).response);
}

function unavailable(kind: ToolEvidence["kind"], path: string | undefined): ToolEvidence[] {
  return [{ kind, path, fragments: [], reason: "range_unknown: Gemini 返回缺少可确认完整内容或实际位置", reasonDescriptor: { key: "diagnostics.history.adapters.gemini.m004" } }];
}

function extract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ToolEvidence[] {
  const input = object(inputValue); const result = object(resultValue);
  const path = string(input.file_path); const display = object(result.resultDisplay);
  if (tool === "read_file") {
    if (result.status !== "success" || !path || !visible || /\.\.\. \[truncated\]|^Output too large\.|^Binary content |^Cannot display content|^<untrusted_content>/m.test(visible)) return unavailable("read", path);
    let body = visible; let start = tokenValue(input.start_line) ?? 1;
    const wrapper = /^\n?IMPORTANT: The file content has been truncated\.\nStatus: Showing lines (\d+)-(\d+) of (\d+) total lines\.\nAction:[^\n]*\n\n--- FILE CONTENT \(truncated\) ---\n([\s\S]*)$/.exec(body);
    if (wrapper) {
      start = Number(wrapper[1]); body = wrapper[4]!;
      if (physicalLines(body).length > Number(wrapper[2]) - start + 1) return unavailable("read", path);
    }
    const jit = body.indexOf("\n\n--- Newly Discovered Project Context ---\n");
    if (jit >= 0 && body.endsWith("\n--- End Project Context ---")) body = body.slice(0, jit);
    if (!Number.isSafeInteger(start) || start < 1 || /<system-reminder>|<jit-context>|--- FILE CONTENT/.test(body)) return unavailable("read", path);
    const end = tokenValue(input.end_line);
    if (end !== undefined && physicalLines(body).length > end - start + 1) return unavailable("read", path);
    return [{ kind: "read", path, fragments: body ? [{ kind: "read", content: body, historicalStart: start, completeLines: true }] : [],
      ...(wrapper ? { reason: "range_unknown: Gemini read_file 只保留返回窗口", reasonDescriptor: { key: "diagnostics.history.adapters.gemini.m005" } } : {}) }];
  }
  if (tool === "replace" || tool === "write_file") {
    if (result.status !== "success" || !path || display.truncatedForSession === true) return unavailable("edit", path);
    const patch = string(display.fileDiff);
    if (patch && /^@@ /m.test(patch)) return [{ kind: "edit", path, fragments: unifiedFragments(patch, path) }];
    const before = string(display.originalContent); const after = string(display.newContent);
    if (before !== undefined && after !== undefined) return [{ kind: "edit", path, fragments: changedFragments(before, after, path) }];
    if (display.originalContent === null && after !== undefined) return [{ kind: "edit", path, fragments: after ? [{ kind: "added", content: after, historicalStart: 1, completeLines: true }] : [] }];
    return unavailable("edit", path);
  }
  if (tool === "run_shell_command") {
    let output = visible;
    const wrapped = /^<untrusted_context>\n([\s\S]*)\n<\/untrusted_context>$/.exec(output);
    if (wrapped && !/<\/?untrusted_context>/.test(wrapped[1]!)) output = wrapped[1]!;
    if (result.status !== "success" || /^Output too large\.|\[truncated\]|<untrusted_content>|<\/?untrusted_context>|&lt;\/untrusted_context&gt;/m.test(output)) return unavailable("other", undefined);
    const match = /^Output: ([\s\S]*?)\nExit Code: 0(?:\n(?:Background PIDs|Process Group PGID):[^\n]*)*$/.exec(output);
    return match ? shellEvidence(string(input.command) ?? "", match[1] === "(empty)" ? "" : match[1]!) : unavailable("other", undefined);
  }
  return toolEvidence(tool, input, result, visible);
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = []; const rows = await readJsonlRows(location.path, gaps);
  if (location.adapterGap) gaps.push(location.adapterGap);
  const state = new Map<string, MessageState>(); let metadata: Record<string, unknown> = {};
  const controls: RawHistoryRecord[] = [];
  const setMessage = (value: Record<string, unknown>, row: RawHistoryRecord) => {
    const id = string(value.id);
    if (id) state.set(id, { value: structuredClone(value), row, contentRow: row, resultRows: new Map() });
  };
  const patchMessage = (patch: Record<string, unknown>, row: RawHistoryRecord) => {
    const message = state.get(string(patch.id) ?? "");
    if (!message) { gap(gaps, "source_missing", "Gemini patch 的消息身份没有原始记录", "m006"); return; }
    if (patch.content !== undefined) { message.value.content = patch.content; message.contentRow = row; }
    if (Array.isArray(patch.toolCalls) && Array.isArray(message.value.toolCalls)) for (const update of patch.toolCalls.map(object)) {
      const call = message.value.toolCalls.map(object).find(call => call.id === update.id);
      if (call && "result" in update) { call.result = update.result; message.resultRows.set(string(call.id)!, row); }
    }
  };
  for (const row of rows) {
    const record = row.record;
    if (typeof record.$rewindTo === "string") {
      const ids = [...state.keys()]; const at = ids.indexOf(record.$rewindTo);
      for (const id of at < 0 ? ids : ids.slice(at)) state.delete(id);
      if (at < 0) gap(gaps, "source_missing", "Gemini 回退身份缺失，按原生规则清空消息状态", "m007");
      controls.push(row);
    } else if (record.$patch) {
      const patch = object(record.$patch);
      if (typeof patch.id === "string") patchMessage(patch, row);
      if (Array.isArray(patch.updates)) for (const update of patch.updates) patchMessage(object(update), row);
      if (Array.isArray(patch.removeIds)) for (const id of patch.removeIds) if (typeof id === "string") state.delete(id);
      if (Array.isArray(patch.orderIds)) {
        const ordered = patch.orderIds.filter((id): id is string => typeof id === "string" && state.has(id));
        const values = [...state.entries()].filter(([id]) => !ordered.includes(id));
        for (const id of ordered) values.push([id, state.get(id)!]);
        state.clear(); for (const [id, value] of values) state.set(id, value);
      }
    } else if (typeof record.id === "string") setMessage(record, row);
    else if (record.$set || typeof record.sessionId === "string" && typeof record.projectHash === "string") {
      const update = record.$set ? object(record.$set) : record;
      if (Array.isArray(update.messages)) { state.clear(); for (const message of update.messages) setMessage(object(message), row); }
      const { messages: _messages, ...fields } = update; metadata = { ...metadata, ...fields };
    } else { controls.push(row); gap(gaps, "unsupported_format", "Gemini 来源包含未适配的原生记录，保留原始内容", "m008"); }
  }
  const id = string(metadata.sessionId); const project = await projectMetadata(location.path, gaps);
  const source = sourceFor(location, "gemini", FORMAT, id, project.cwd);
  if (!id) gap(gaps, "unsupported_format", "Gemini 来源缺少原生会话身份", "m009");
  if (!source.cwd) gap(gaps, "source_missing", "Gemini 缺少可核验的项目登记或目录标记", "m010");
  const parent = metadata.kind === "subagent" ? project.parentSessionId : undefined;
  source.parentSessionId = parent;
  if (metadata.kind === "subagent" && !parent) gap(gaps, "source_missing", "Gemini 子会话缺少原生父会话目录", "m011");
  const records: RawHistoryRecord[] = []; let turnKey: string | undefined;
  for (const [messageId, saved] of state) {
    const value = saved.value; const type = string(value.type); const time = eventTime(value.timestamp); const model = string(value.model);
    const add = (event: NormalizedEvent, suffix: string, row = saved.row) => records.push(normalizedRecord({ ...event, key: `${messageId}:${suffix}`, occurredAt: event.occurredAt ?? time, model: event.model ?? model, turnKey, nativeIdentityHash: normalizedHash(messageId) }, row.raw, row.line));
    if (type === "user") { turnKey = messageId; add({ key: "", kind: "user", text: textOf(value.displayContent ?? value.content) }, "user", saved.contentRow); }
    else if (type === "gemini") {
      const normalizedUsage = usage(value.tokens, gaps);
      add({ key: "", kind: "assistant", text: textOf(value.content), allowInferredFinal: false,
        ...(saved.contentRow === saved.row ? { usageKey: normalizedUsage ? `${messageId}:usage` : undefined, usage: normalizedUsage } : {}) }, "assistant", saved.contentRow);
      if (normalizedUsage && saved.contentRow !== saved.row) add({ key: "", kind: "context", text: "", usageKey: `${messageId}:usage`, usageMessageKey: `${messageId}:assistant`, usage: normalizedUsage }, "usage");
      if (Array.isArray(value.thoughts)) for (const [index, thought] of value.thoughts.map(object).entries()) {
        add({ key: "", kind: "thinking", text: [string(thought.subject), string(thought.description)].filter(Boolean).join("\n"), occurredAt: eventTime(thought.timestamp) }, `thought:${index}`);
      }
      if (Array.isArray(value.toolCalls)) for (const call of value.toolCalls.map(object)) {
        const callId = string(call.id); const tool = string(call.name);
        if (!callId || !tool) { gap(gaps, "unpaired_call", "Gemini 工具调用缺少原生身份或名称", "m012"); continue; }
        const cancelled = call.status === "cancelled";
        add({ key: "", kind: "tool_call", callId, tool, input: call.args, occurredAt: eventTime(call.timestamp), interrupted: cancelled }, `call:${callId}`);
        if (call.result !== undefined && call.result !== null || ["success", "error", "cancelled"].includes(string(call.status) ?? "")) {
          const status = call.status === "success" ? "success" : call.status === "error" ? "failure" : "unknown";
          add({ key: "", kind: "tool_result", callId, tool, text: responseText(call.result), result: { ...call, response: resultResponse(call) }, status, interrupted: cancelled }, `result:${callId}`, saved.resultRows.get(callId) ?? saved.row);
        }
      }
    } else {
      add({ key: "", kind: type === "info" ? "system" : "context", text: textOf(value.content), interrupted: type === "error" }, type ?? "unknown", saved.contentRow);
      if (!["info", "warning", "error"].includes(type ?? "")) gap(gaps, "unsupported_format", "Gemini 消息包含未适配类型，保留正文与原始记录", "m008");
    }
  }
  for (const row of controls) records.push(normalizedRecord({ key: `control:${row.line}`, kind: "context", text: row.raw }, row.raw, row.line));
  const evidenceLines = new Set(records.map(row => row.line));
  for (const row of rows) if (!evidenceLines.has(row.line)) records.push({ raw: row.raw, line: row.line, record: {} });
  const result = normalizedSnapshot(source, records, { title: string(metadata.summary), parentSessionId: parent, relationship: parent ? "child" : undefined, gaps },
    JSON.stringify([rows.map(row => row.raw), metadata, project.fingerprint]));
  result.source.sourceCompleteness = { version: Number.isFinite(Date.parse(String(metadata.lastUpdated))) ? Date.parse(String(metadata.lastUpdated)) : rows.length,
    supported: Boolean(id), complete: !gaps.some(gap => ["parse_error", "incomplete_record", "budget_exceeded"].includes(gap.kind)), fingerprint: result.hash };
  return result;
}

export const geminiAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract,
  discoverFile: async location => {
    const result = await snapshot(location);
    return result.source.sessionId ? [result.source] : [];
  },
  selectSources: locations => {
    const others = locations.filter(location => location.client !== "gemini" || location.format !== FORMAT);
    const selected = new Map<string, SourceLocation>();
    for (const location of locations.filter(location => location.client === "gemini" && location.format === FORMAT)) {
      const key = location.sessionId ?? location.path; const previous = selected.get(key);
      if (!previous) { selected.set(key, location); continue; }
      const preferred = (location.sourceCompleteness?.version ?? 0) > (previous.sourceCompleteness?.version ?? 0) ? location : previous;
      if (previous.sourceCompleteness?.fingerprint !== location.sourceCompleteness?.fingerprint) preferred.adapterGap = { kind: "ambiguous", message: "Gemini 同会话来源副本不同，优先最新原生更新时间并保留覆盖缺口", messageDescriptor: { key: "diagnostics.history.adapters.gemini.m013" } };
      selected.set(key, preferred);
    }
    return [...others, ...selected.values()];
  } });
